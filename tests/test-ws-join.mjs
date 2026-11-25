#!/usr/bin/env node
import "./require-destructive-test-safety.mjs";
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test as nodeTest } from 'node:test';
import { WebSocketServer } from 'ws';

// A broken implementation or fixture must exit even if it leaves handles open.
const watchdog = setTimeout(() => { console.error('WebSocket regression suite exceeded 30s'); process.exit(1); }, 30000);
watchdog.unref();
let testContext;
const test = (name, run) => nodeTest(name, { timeout: 4000 }, async context => { testContext = context; await run(); });
process.env.AFFINE_WS_CONNECT_TIMEOUT_MS = '500';
process.env.AFFINE_WS_ACK_TIMEOUT_MS = '150';
for (const name of ['AFFINE_WS_JOIN_MODE', 'AFFINE_WS_PROTOCOL_VERSION', 'AFFINE_WS_CLIENT_VERSION', 'AFFINE_CLIENT_VERSION']) delete process.env[name];
const { connectWorkspaceSocket, joinWorkspace, ensureDocJoined, loadDoc, pushDocUpdate, pushPageDocUpdate, deleteDoc } = await import('../dist/ws.js');

async function fixture(version, run, options = {}) {
  const events = [];
  const infoHeaders = [], handshakeHeaders = [];
  const sockets = [];
  let cleanupPromise;
  const cleanup = () => cleanupPromise ??= (async () => {
    for (const socket of sockets) socket.disconnect();
    for (const peer of wss.clients) peer.terminate();
    server.closeAllConnections();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  })();
  testContext.after(cleanup);
  let infoRequests = 0;
  const server = createServer((req, res) => {
    if (req.url === '/info') {
      infoRequests++;
      infoHeaders.push(req.headers);
      if (options.stallInfo) return;
      if (options.failInfo) return res.writeHead(503).end();
      if (options.redirectInfo) return res.writeHead(302, { Location: options.redirectInfo }).end();
      if (options.cookie && req.headers.cookie !== options.cookie) return res.writeHead(401).end();
      if (options.bearer && req.headers.authorization !== `Bearer ${options.bearer}`) return res.writeHead(401).end();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify((options.version || version) ? { compatibility: options.version || version } : {}));
    } else { res.writeHead(404).end(); }
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (peer, req) => {
    handshakeHeaders.push(req.headers);
    if (options.stallSocket) return;
    const joined = new Set();
    peer.send('0{"sid":"join-fixture","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
    peer.on('message', data => {
      const packet = data.toString();
      if (packet === '40') return peer.send('40{"sid":"join-socket"}');
      const match = /^42(\d+)(\[.*)$/s.exec(packet);
      if (!match) return;
      let event, payload;
      try { [event, payload] = JSON.parse(match[2]); } catch { peer.close(1002, 'Invalid packet JSON'); return; }
      events.push({ event, payload });
      const ack = value => peer.send(`43${match[1]}${JSON.stringify([value])}`);
      if (options.disconnect === event) return peer.send('41');
      if (event === 'space:join' || event === 'space:join-batch') {
        if (event === 'space:join-batch' && options.legacyOnly) return;
        if (event === 'space:join-batch' && (!Array.isArray(payload?.spaces) || !payload.spaces.length || payload.spaces.some(s => !s || typeof s.spaceId !== 'string' || typeof s.docId !== 'string'))) return ack({ error: { message: 'Invalid batch shape' } });
        if (event === 'space:join' && options.batchOnly) return; // Original bug: no handler, no ack.
        if (options.stallJoin) return;
        if (options.joinAck !== undefined) return ack(options.joinAck);
        if (event === 'space:join-batch') {
          for (const space of payload.spaces) joined.add(`${space.spaceId}:${space.docId}`);
        }
        const joinAck = () => ack({ data: { success: true, ...(event === 'space:join-batch' ? { protocolVersion: payload.protocolVersion } : {}) } });
        if (options.joinDelayMs) return void setTimeout(joinAck, options.joinDelayMs);
        return joinAck();
      }
      if (event === 'space:load-doc') {
        if (options.stallLoad) return;
        const key = `${payload.spaceId}:${payload.docId}`;
        if (options.revokeOnce) { joined.delete(key); options.revokeOnce = false; }
        if (options.batchOnly && !joined.has(key)) return ack({ error: { name: 'NOT_IN_SPACE', code: 'NOT_IN_SPACE', message: 'Document is not subscribed' } });
        return ack({ data: { missing: 'AAA=', timestamp: 1 } });
      }
      if (event === 'space:push-doc-update') {
        if (options.batchOnly && payload.intent !== 'create') return ack({ error: { message: 'Missing legacy upsert intent' } });
        return ack({ data: { accepted: true, timestamp: 123 } });
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${server.address().port}`;
  const connect = async (cookie, bearer) => { const socket = await connectWorkspaceSocket(url, cookie, bearer); sockets.push(socket); return socket; };
  try { await run({ connect, events, infoHeaders, handshakeHeaders, infoRequests: () => infoRequests, url: url.replace(/^ws/, 'http') + '/info' }); }
  finally { await cleanup(); }
}

for (const version of ['0.27.4', '2026.8.17-canary.914', undefined, 'invalid']) {
  test(`legacy selection for ${version ?? 'unadvertised server'}`, () => fixture(version, async ({ connect, events, infoRequests }) => {
    const socket = await connect();
    await joinWorkspace(socket, 'workspace');
    await loadDoc(socket, 'workspace', 'doc');
    await pushDocUpdate(socket, 'workspace', 'doc', 'AAA=');
    assert.deepEqual(events[0], { event: 'space:join', payload: { spaceType: 'workspace', spaceId: 'workspace', clientVersion: '0.26.0' } });
    assert.equal(events[2].payload.intent, undefined);
    assert.equal(infoRequests(), 1);
  }, { legacyOnly: true }));
}
for (const version of ['0.27.5-beta.3', '0.27.5', '0.28.0', '1.0.0', '2026.11.25-canary.905']) {
  test(`batch selection and document subscriptions for ${version}`, () => fixture(version, async ({ connect, events, infoRequests }) => {
    const socket = await connect();
    await joinWorkspace(socket, 'workspace');
    assert.deepEqual(events[0], { event: 'space:join-batch', payload: { spaces: [{ spaceType: 'workspace', spaceId: 'workspace', docId: 'workspace' }], clientVersion: '0.27.5', protocolVersion: 1 } });
    await loadDoc(socket, 'workspace', 'workspace');
    await loadDoc(socket, 'workspace', 'other-doc');
    await loadDoc(socket, 'workspace', 'other-doc');
    await loadDoc(socket, 'second-workspace', 'other-doc');
    assert.equal(events.filter(e => e.event === 'space:join-batch').length, 3);
    for (const docId of ['new-doc', 'other-doc']) assert.equal(await pushDocUpdate(socket, 'workspace', docId, 'AAA='), 123);
    assert(events.filter(e => e.event === 'space:push-doc-update').every(e => e.payload.intent === 'create'));
    assert.equal(infoRequests(), 1);
  }, { batchOnly: true }));
}

test('concurrent document joins deduplicate and split at 100', () => fixture('0.27.5-beta.3', async ({ connect, events }) => {
  const socket = await connect();
  await Promise.all(Array.from({ length: 205 }, (_, i) => ensureDocJoined(socket, 'workspace', `doc-${i % 201}`)));
  assert.deepEqual(events.map(e => e.payload.spaces.length), [100, 100, 1]);
  await loadDoc(socket, 'workspace', 'doc-200');
}, { batchOnly: true }));

test('legacy override reproduces ignored event and gives compatibility diagnostics', async () => {
  process.env.AFFINE_WS_JOIN_MODE = 'legacy';
  try {
    await fixture('0.27.5-beta.3', async ({ connect, infoRequests }) => {
      const socket = await connect();
      await assert.rejects(joinWorkspace(socket, 'workspace'), /space:join timeout after 150ms.*clientVersion 0.26.0, protocol legacy.*AFFINE_WS_JOIN_MODE/);
      assert.equal(infoRequests(), 0);
    }, { batchOnly: true });
  } finally { delete process.env.AFFINE_WS_JOIN_MODE; }
});

for (const [label, joinAck, code, message] of [
  ['version rejection', { data: { success: false, protocolVersion: 1 } }, 'sync_version_rejected', /clientVersion.*AFFINE_WS_CLIENT_VERSION/],
  ['missing success', { data: { protocolVersion: 1 } }, 'sync_version_rejected', /rejected/],
  ['missing protocol echo', { data: { success: true } }, 'sync_protocol_mismatch', /echoed sync protocol undefined instead of 1/],
  ['protocol mismatch', { data: { success: true, protocolVersion: 2 } }, 'sync_protocol_mismatch', /echoed sync protocol 2 instead of 1/],
  ['error ack', { error: { name: 'FORBIDDEN', code: 'FORBIDDEN', message: 'Permission denied' } }, 'FORBIDDEN', /Permission denied/],
  ['lifecycle mismatch', { error: { name: 'WORKSPACE_SYNC_UNAVAILABLE', code: 'WORKSPACE_SYNC_UNAVAILABLE', message: 'Sync unavailable' } }, 'WORKSPACE_SYNC_UNAVAILABLE', /Protocol 1.*lifecycle state/],
]) {
  test(`reject ${label}`, () => fixture('0.27.5-beta.3', async ({ connect }) => {
    const socket = await connect();
    await assert.rejects(joinWorkspace(socket, 'workspace'), error => error.code === code && message.test(error.message));
    assert.equal(socket.listeners('disconnect').length, 1, 'settled ack listeners are removed');
  }, { joinAck }));
}

test('NOT_IN_SPACE invalidates cached subscriptions', () => fixture('0.27.5-beta.3', async ({ connect, events }) => {
  const socket = await connect();
  await assert.rejects(loadDoc(socket, 'workspace', 'doc'), error => error.code === 'NOT_IN_SPACE');
  await loadDoc(socket, 'workspace', 'doc');
  assert.equal(events.filter(e => e.event === 'space:join-batch').length, 2);
}, { batchOnly: true, revokeOnce: true }));

test('disconnect rejects a pending ack promptly and reconnect resets subscriptions', () => fixture('0.27.5-beta.3', async ({ connect, events }) => {
  const socket = await connect();
  await joinWorkspace(socket, 'workspace');
  const started = performance.now();
  await assert.rejects(loadDoc(socket, 'workspace', 'workspace'), /space:load-doc failed because the socket disconnected: io server disconnect/);
  assert(performance.now() - started < 140);
  const connected = once(socket, 'connect');
  socket.connect();
  await connected;
  await joinWorkspace(socket, 'workspace');
  assert.equal(events.filter(e => e.event === 'space:join-batch').length, 2);
}, { batchOnly: true, disconnect: 'space:load-doc' }));

test('disconnect during join reports the join event and reason', () => fixture('0.27.5-beta.3', async ({ connect }) => {
  await assert.rejects(joinWorkspace(await connect(), 'workspace'), /space:join-batch failed because the socket disconnected: io server disconnect/);
}, { batchOnly: true, disconnect: 'space:join-batch' }));

test('mode, protocol and client version overrides are explicit', async () => {
  process.env.AFFINE_WS_JOIN_MODE = 'batch';
  process.env.AFFINE_WS_PROTOCOL_VERSION = '2';
  process.env.AFFINE_CLIENT_VERSION = '0.27.5-beta.3';
  try {
    await fixture(undefined, async ({ connect, events, infoRequests }) => {
      const socket = await connect();
      await joinWorkspace(socket, 'workspace');
      assert.equal(events[0].payload.protocolVersion, 2);
      assert.equal(events[0].payload.clientVersion, '0.27.5-beta.3');
      assert.equal(infoRequests(), 0);
      await assert.rejects(pushDocUpdate(socket, 'workspace', 'doc', 'AAA='), error => error.code === 'sync_protocol_unsupported');
      process.env.AFFINE_WS_CLIENT_VERSION = '0.27.5';
      await joinWorkspace(await connect(), 'workspace');
      assert.equal(events[1].payload.clientVersion, '0.27.5');
    });
  } finally {
    for (const name of ['AFFINE_WS_JOIN_MODE', 'AFFINE_WS_PROTOCOL_VERSION', 'AFFINE_CLIENT_VERSION', 'AFFINE_WS_CLIENT_VERSION']) delete process.env[name];
  }
});

test('server selection stays independent across concurrent live connections', () => fixture('0.27.4', async legacy => {
  await fixture('0.27.5-beta.3', async batch => {
    const oldSocket = await legacy.connect();
    const newSocket = await batch.connect();
    await Promise.all([joinWorkspace(oldSocket, 'workspace'), joinWorkspace(newSocket, 'workspace')]);
    await Promise.all([loadDoc(oldSocket, 'workspace', 'doc'), loadDoc(newSocket, 'workspace', 'doc')]);
    assert.equal(legacy.events[0].event, 'space:join');
    assert.equal(batch.events[0].event, 'space:join-batch');
  }, { batchOnly: true });
}));

for (const [name, value] of [['AFFINE_WS_JOIN_MODE', 'unknown'], ['AFFINE_WS_PROTOCOL_VERSION', '3']]) {
  test(`invalid ${name} fails explicitly`, async () => {
    process.env[name] = value;
    try {
      await fixture('0.27.5-beta.3', async ({ connect }) => {
        await assert.rejects(connect(), error => error.code === 'invalid_config' && error.message.includes(name));
      });
    } finally { delete process.env[name]; }
  });
}


test('connected batch join timeout names its version and protocol', () => fixture('0.27.5-beta.3', async ({ connect }) => {
  const socket = await connect();
  await assert.rejects(joinWorkspace(socket, 'workspace'), /space:join-batch timeout after 150ms.*clientVersion 0.27.5, protocol 1.*server compatibility/);
  assert.equal(socket.connected, true);
  assert.equal(socket.listeners('disconnect').length, 1);
}, { batchOnly: true, stallJoin: true }));

test('subscription wait counts against the read budget', () => fixture('0.27.5-beta.3', async ({ connect, events }) => {
  const socket = await connect();
  const started = performance.now();
  await assert.rejects(loadDoc(socket, 'workspace', 'slow-doc'), /space:load-doc timeout after \d+ms/);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 220, `read took ${Math.round(elapsed)}ms, expected one 150ms budget`);
  assert.equal(events.filter(e => e.event === 'space:load-doc').length, 1);
}, { batchOnly: true, joinDelayMs: 120, stallLoad: true }));

test('a read whose budget ends during the join is not sent and leaves the shared join running', () => fixture('0.27.5-beta.3', async ({ connect, events }) => {
  const socket = await connect();
  const read = loadDoc(socket, 'workspace', 'stalled-doc');
  const sharedJoin = ensureDocJoined(socket, 'workspace', 'stalled-doc');
  await assert.rejects(read, /space:load-doc timeout after 150ms/);
  await assert.rejects(sharedJoin, /space:join-batch timeout after 150ms/);
  assert.equal(events.filter(e => e.event === 'space:join-batch').length, 1);
  assert.equal(events.filter(e => e.event === 'space:load-doc').length, 0);
}, { batchOnly: true, stallJoin: true }));


test('disconnect during a confirmed page write retains uncertain-write recovery', () => fixture('0.27.5-beta.3', async ({ connect }) => {
  const socket = await connect();
  await joinWorkspace(socket, 'workspace');
  await assert.rejects(
    pushPageDocUpdate(socket, 'workspace', 'doc', 'AAA=', { requireAcknowledgement: true }),
    error => error.code === 'write_ack_uncertain' && /space:push-doc-update.*io server disconnect/.test(error.message),
  );
}, { batchOnly: true, disconnect: 'space:push-doc-update' }));

for (const version of ['0.27.5-0', '0.27.5-beta.2']) {
  test(`pre-protocol batch ${version} fails explicitly before opening a socket`, () => fixture(version, async ({ connect, events, handshakeHeaders }) => {
    await assert.rejects(connect(), error => error.code === 'sync_version_unsupported' && /pre-beta.3/.test(error.message));
    assert.equal(handshakeHeaders.length, 0);
    assert.deepEqual(events, []);
  }));
}

test('uncertain transition canary retains legacy with an explicit diagnostic', () => fixture('2026.11.16-canary.1', async ({ connect }) => {
  const socket = await connect();
  await assert.rejects(joinWorkspace(socket, 'workspace'), /discovery was inconclusive.*AFFINE_WS_JOIN_MODE/);
}, { stallJoin: true }));

for (const failure of ['stallInfo', 'failInfo']) {
  test(`${failure} is bounded, concurrent probes deduplicate, and failures expire`, () => {
    const options = { [failure]: true };
    return fixture('0.27.4', async ({ connect, events, infoRequests }) => {
      const started = performance.now();
      const sockets = await Promise.all([connect(), connect(), connect()]);
      await Promise.all(sockets.map(socket => joinWorkspace(socket, 'workspace')));
      assert(performance.now() - started < 900, 'optional discovery must not add a full connect timeout');
      assert.equal(infoRequests(), 1);
      await joinWorkspace(await connect(), 'workspace');
      assert.equal(infoRequests(), 1, 'sequential connections reuse the failed probe decision');
      options[failure] = false;
      options.version = '0.27.5-beta.3';
      const realNow = Date.now;
      Date.now = () => realNow() + 6000;
      try { await joinWorkspace(await connect(), 'workspace'); } finally { Date.now = realNow; }
      assert.equal(infoRequests(), 2, 'failed decisions expire and discover upgrades');
      assert.equal(events.at(-1).event, 'space:join-batch');
    }, options);
  });
}

test('successful discovery expires and discovers server upgrades', () => {
  const options = {};
  return fixture('0.27.4', async ({ connect, infoRequests, events }) => {
    await joinWorkspace(await connect(), 'workspace');
    await joinWorkspace(await connect(), 'workspace');
    assert.equal(infoRequests(), 1);
    options.version = '0.27.5-beta.3';
    const realNow = Date.now;
    Date.now = () => realNow() + 61000;
    try { await joinWorkspace(await connect(), 'workspace'); } finally { Date.now = realNow; }
    assert.equal(infoRequests(), 2);
    assert.equal(events.at(-1).event, 'space:join-batch');
  }, options);
});

test('stalled discovery plus stalled socket has separate bounded budgets', () => fixture('0.27.4', async ({ connect }) => {
  const started = performance.now();
  await assert.rejects(connect(), /socket connect timeout after 500ms/);
  assert(performance.now() - started < 1100, 'total latency stays near 250ms discovery + 500ms connection');
}, { stallInfo: true, stallSocket: true }));

for (const kind of ['cookie', 'bearer']) {
  test(`${kind} authenticated discovery reuses only resolved upstream socket credentials`, () => {
    const credential = kind === 'cookie' ? 'session=synthetic-upstream' : 'synthetic-upstream-token';
    return fixture('0.27.5-beta.3', async ({ connect, infoHeaders, handshakeHeaders }) => {
      // A failed anonymous probe must not poison the authenticated cache entry.
      (await connect()).disconnect();
      const socket = await connect(kind === 'cookie' ? credential : undefined, kind === 'bearer' ? credential : undefined);
      await joinWorkspace(socket, 'workspace');
      const header = kind === 'cookie' ? 'cookie' : 'authorization';
      const expected = kind === 'cookie' ? credential : `Bearer ${credential}`;
      assert.equal(infoHeaders[0][header], undefined);
      assert.equal(infoHeaders[1][header], expected);
      assert.equal(handshakeHeaders[1][header], expected);
      assert.equal(infoHeaders[1][kind === 'cookie' ? 'authorization' : 'cookie'], undefined);
    }, { batchOnly: true, [kind]: credential });
  });
}

test('authenticated discovery never follows redirects', () => fixture('0.27.5-beta.3', async target => {
  await fixture('0.27.4', async ({ connect, infoRequests }) => {
    const socket = await connect('session=synthetic-upstream', 'synthetic-upstream-token');
    await joinWorkspace(socket, 'workspace');
    assert.equal(infoRequests(), 1);
    assert.equal(target.infoRequests(), 0);
  }, { redirectInfo: target.url });
}));

test('protocol 2 rejects pushes, raw deletes and tool mutations before side effects', async () => {
  process.env.AFFINE_WS_PROTOCOL_VERSION = '2';
  try {
    const { coordinateTool } = await import('../dist/toolCoordination.js');
    const { deleteDocFromWorkspace } = await import('../dist/tools/docs.js');
    await fixture('0.27.5-beta.3', async ({ connect, events }) => {
      const socket = await connect();
      await joinWorkspace(socket, 'workspace');
      const before = events.length;
      for (const operation of [
        () => pushDocUpdate(socket, 'workspace', 'doc', 'AAA='),
        () => pushPageDocUpdate(socket, 'workspace', 'doc', 'AAA='),
        () => deleteDoc(socket, 'workspace', 'doc'),
        () => deleteDocFromWorkspace(socket, 'workspace', 'doc'),
      ]) await assert.rejects(operation(), error => error.code === 'sync_protocol_unsupported');
      assert.equal(events.length, before, 'no mutation or preparatory read reaches the socket');
      for (const name of ['append_markdown', 'delete_doc', 'create_doc', 'delete_workspace']) {
        let called = false;
        const { handler } = coordinateTool(name, {}, async () => { called = true; }, { endpoint: 'http://127.0.0.1/graphql' });
        await assert.rejects(handler({ workspaceId: 'workspace' }, {}), error => error.code === 'sync_protocol_unsupported');
        assert.equal(called, false, `${name} is rejected before its handler mutates local or remote state`);
      }
    });
  } finally { delete process.env.AFFINE_WS_PROTOCOL_VERSION; }
});

test('malformed batch packets return an error acknowledgement', () => fixture('0.27.5-beta.3', async ({ connect }) => {
  const socket = await connect();
  const ack = await new Promise(resolve => socket.emit('space:join-batch', { spaceType: 'workspace', spaceId: 'workspace' }, resolve));
  assert.equal(ack.error.message, 'Invalid batch shape');
}));
