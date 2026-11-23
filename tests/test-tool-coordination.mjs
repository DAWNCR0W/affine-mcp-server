import './require-destructive-test-safety.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { z } from 'zod/v3';
import * as Y from 'yjs';
import { coordinateTool, staleDocumentRevision } from '../dist/toolCoordination.js';
import { documentRevision, isDocumentRegistered } from '../dist/util/documentRevision.js';
import { withToolErrors } from '../dist/util/mcp.js';
import { loadDoc, pushPageDocUpdate } from '../dist/ws.js';
import { toolOutputSchemaFor } from '../dist/toolOutputSchemas.js';

const context = { endpoint: 'http://localhost:3010/graphql', workspaceId: 'default-workspace', gql: {} };
const shape = { workspaceId: z.string().optional(), docId: z.string() };
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

function revisionSnapshots(docId = 'doc') {
  const workspace = new Y.Doc();
  const pages = new Y.Array();
  workspace.getMap('meta').set('pages', pages);
  pages.push([new Y.Map([['id', docId]])]);
  const document = new Y.Doc();
  document.getText('content').insert(0, 'initial');
  return {
    workspace,
    document,
    workspaceSnapshot: Buffer.from(Y.encodeStateAsUpdate(workspace)).toString('base64'),
    documentSnapshot: Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64'),
    dispose() { workspace.destroy(); document.destroy(); },
  };
}

function revisionSocket(snapshots, { accepted = true } = {}) {
  const pushes = [];
  return {
    pushes,
    emit(event, payload, ack) {
      if (event === 'space:load-doc') {
        ack({ data: { missing: payload.docId === context.workspaceId ? snapshots.workspaceSnapshot : snapshots.documentSnapshot } });
        return;
      }
      if (event === 'space:push-doc-update') {
        pushes.push(payload);
        ack({ data: { accepted, timestamp: 1 } });
        return;
      }
      throw new Error(`Unexpected socket event ${event}`);
    },
  };
}

function trackedRevisionSocket(snapshots, rootErrors = []) {
  const events = [];
  let rootLoads = 0;
  let targetLoads = 0;
  let pushes = 0;
  return {
    events,
    get rootLoads() { return rootLoads; },
    get targetLoads() { return targetLoads; },
    get pushes() { return pushes; },
    emit(event, payload, ack) {
      if (event === 'space:load-doc' && payload.docId === context.workspaceId) {
        rootLoads += 1;
        events.push(`root-${rootLoads}`);
        const error = rootErrors[rootLoads - 1];
        if (error) ack({ error });
        else ack({ data: { missing: snapshots.workspaceSnapshot } });
        return;
      }
      if (event === 'space:load-doc') {
        targetLoads += 1;
        events.push('target');
        ack({ data: { missing: snapshots.documentSnapshot } });
        return;
      }
      if (event === 'space:push-doc-update') {
        pushes += 1;
        events.push('push');
        ack({ data: { accepted: true, timestamp: 1 } });
        return;
      }
      throw new Error(`Unexpected socket event ${event}`);
    },
  };
}

test('revision is stable across snapshot reloads and detects deletion-only changes', () => {
  const doc = new Y.Doc();
  doc.getText('text').insert(0, 'original');
  const original = documentRevision(doc);
  assert.notEqual(documentRevision(doc, false), original, 'unregistering a retained snapshot invalidates the revision');
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  assert.equal(documentRevision(copy), original);
  const beforeDelete = Y.encodeStateVector(copy);
  copy.getText('text').delete(0, 1);
  assert.deepEqual(Y.encodeStateVector(copy), beforeDelete, 'a state vector alone misses deletions');
  assert.notEqual(documentRevision(copy), original);
  const deletedCopy = new Y.Doc();
  Y.applyUpdate(deletedCopy, Y.encodeStateAsUpdate(copy));
  assert.equal(documentRevision(deletedCopy), documentRevision(copy));
  for (const d of [doc, copy, deletedCopy]) d.destroy();
});

test('registration detection follows the workspace page entry through deletion', () => {
  const workspace = new Y.Doc();
  const pages = new Y.Array();
  workspace.getMap('meta').set('pages', pages);
  pages.push([new Y.Map([['id', 'doc']])]);
  assert.equal(isDocumentRegistered(workspace, 'doc'), true);
  assert.equal(isDocumentRegistered(workspace, 'other'), false);
  pages.delete(0, 1);
  assert.equal(isDocumentRegistered(workspace, 'doc'), false);
  workspace.destroy();
});

test('document writes advertise a validated optional revision; reads preserve their schema', () => {
  for (const name of ['update_block', 'update_blocks', 'add_table_rows', 'update_table_cell', 'update_table_column_widths', 'replace_doc_with_markdown', 'move_block', 'reparent_mindmap_node', 'add_surface_elements', 'update_surface_elements']) {
    const { inputSchema } = coordinateTool(name, shape, async () => ({}), context);
    const schema = z.object(inputSchema);
    assert(schema.safeParse({ docId: 'doc' }).success);
    assert(schema.safeParse({ docId: 'doc', expectedRevision: 'a'.repeat(64) }).success);
    assert(!schema.safeParse({ docId: 'doc', expectedRevision: '' }).success);
    assert(!schema.safeParse({ docId: 'doc', expectedRevision: 'A'.repeat(64) }).success);
  }
  assert.equal(coordinateTool('read_doc', shape, async () => ({}), context).inputSchema, shape);
  assert(!Object.hasOwn(coordinateTool('create_workspace', {}, async () => ({}), context).inputSchema, 'expectedRevision'));
  for (const name of ['move_doc', 'create_comment', 'set_doc_property', 'add_tag_to_doc', 'add_doc_to_collection', 'publish_doc']) {
    assert(!Object.hasOwn(coordinateTool(name, shape, async () => ({}), context).inputSchema, 'expectedRevision'), name);
  }
  assert.equal(toolOutputSchemaFor('read_doc').shape.revision.safeParse(null).success, true);
});

test('block mutations own their local revision check and share its stale error contract', async () => {
  for (const name of ['update_block', 'update_blocks']) {
    let invoked = false;
    const tool = coordinateTool(name, shape, async args => {
      invoked = true;
      return args.expectedRevision;
    }, context);
    assert.equal(await tool.handler({ docId: 'doc', expectedRevision: 'a'.repeat(64) }), 'a'.repeat(64));
    assert.equal(invoked, true, `${name} does not load a second pre-write revision snapshot`);
  }
  const conflict = staleDocumentRevision('workspace', 'doc', 'a'.repeat(64), 'b'.repeat(64));
  assert.equal(conflict.isError, true);
  assert.equal(conflict.structuredContent.code, 'STALE_DOCUMENT_REVISION');
  assert.equal(conflict.structuredContent.retryable, false);
  assert.deepEqual(conflict.structuredContent.details, {
    workspaceId: 'workspace', docId: 'doc', expectedRevision: 'a'.repeat(64), currentRevision: 'b'.repeat(64),
  });
});

test('coordinated writes return the captured revision for no-op updates', async () => {
  const snapshots = revisionSnapshots();
  const socket = revisionSocket(snapshots);
  const originalRevision = documentRevision(snapshots.document);
  const empty = new Y.Doc();
  const noOpUpdate = Buffer.from(Y.encodeStateAsUpdate(empty)).toString('base64');
  empty.destroy();
  try {
    const tool = coordinateTool('append_block', shape, async ({ docId }) => {
      await loadDoc(socket, context.workspaceId, docId);
      await pushPageDocUpdate(socket, context.workspaceId, docId, noOpUpdate);
      return { content: [], structuredContent: { ok: true, changed: false } };
    }, context);
    const result = await tool.handler({ docId: 'doc' });
    assert.equal(socket.pushes.length, 1, 'a scoped no-op still requires an explicit ACK');
    assert.equal(result.structuredContent.changed, false);
    assert.equal(result.structuredContent.revision, originalRevision);
  } finally { snapshots.dispose(); }
});

test('tracked workspace registration reads retry transient failures before the target read', async () => {
  const snapshots = revisionSnapshots();
  const socket = trackedRevisionSocket(snapshots, [
    { name: 'Error', code: 'ECONNRESET', message: 'Transient workspace snapshot failure' },
  ]);
  const empty = new Y.Doc();
  const noOpUpdate = Buffer.from(Y.encodeStateAsUpdate(empty)).toString('base64');
  empty.destroy();
  try {
    const tool = coordinateTool('append_block', shape, async ({ docId }) => {
      await loadDoc(socket, context.workspaceId, docId);
      await pushPageDocUpdate(socket, context.workspaceId, docId, noOpUpdate);
      return { content: [], structuredContent: { ok: true } };
    }, context);
    const result = await tool.handler({ docId: 'doc' });
    assert.equal(result.structuredContent.revision, documentRevision(snapshots.document));
    assert.equal(socket.rootLoads, 2);
    assert.equal(socket.targetLoads, 1);
    assert.equal(socket.pushes, 1);
    assert.deepEqual(socket.events, ['root-1', 'root-2', 'target', 'push']);
  } finally { snapshots.dispose(); }
});

test('a stalled registration retry releases the workspace queue within one acknowledgement budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const advance = ms => {
    now += ms;
    t.mock.timers.tick(ms);
  };
  const firstLookup = deferred();
  const retryLookup = deferred();
  let registrationLoads = 0;
  const stalledSocket = {
    emit(event, payload, ack) {
      assert.equal(event, 'space:load-doc');
      assert.equal(payload.docId, context.workspaceId);
      registrationLoads += 1;
      if (registrationLoads === 1) firstLookup.resolve(ack);
      else retryLookup.resolve();
    },
  };
  const snapshots = revisionSnapshots('other-doc');
  t.after(() => snapshots.dispose());
  const healthySocket = revisionSocket(snapshots);
  const append = socket => coordinateTool('append_block', shape, async ({ docId }) => {
    await loadDoc(socket, context.workspaceId, docId);
    await pushPageDocUpdate(socket, context.workspaceId, docId, 'AAA=');
    return { content: [], structuredContent: { ok: true } };
  }, context);

  const stalled = assert.rejects(append(stalledSocket).handler({ docId: 'doc' }), /space:load-doc timeout/);
  const reply = await firstLookup.promise;
  const queued = append(healthySocket).handler({ docId: 'other-doc' });
  advance(1_000);
  reply({ error: { code: 'ECONNRESET', message: 'Transient workspace snapshot failure' } });
  await flush();
  advance(500);
  await retryLookup.promise;

  advance(8_499);
  await flush();
  assert.equal(healthySocket.pushes.length, 0, 'the workspace write queue remains serialized');
  advance(1);
  await flush();
  assert.equal(healthySocket.pushes.length, 1, 'the next write reaches AFFiNE at the original ACK deadline');
  assert.equal((await queued).structuredContent.revision, documentRevision(snapshots.document));
  await stalled;
  assert.equal(registrationLoads, 2);
});

test('permanent registration read errors fail before the target read or mutation', async () => {
  const snapshots = revisionSnapshots();
  const socket = trackedRevisionSocket(snapshots, [
    { name: 'Error', code: 'FORBIDDEN', message: 'Too many concurrent writings' },
  ]);
  try {
    const tool = coordinateTool('append_block', shape, async ({ docId }) => {
      await loadDoc(socket, context.workspaceId, docId);
      await pushPageDocUpdate(socket, context.workspaceId, docId, 'AAA=');
      return { content: [], structuredContent: { ok: true } };
    }, context);
    await assert.rejects(tool.handler({ docId: 'doc' }), { code: 'FORBIDDEN', message: 'Too many concurrent writings' });
    assert.equal(socket.rootLoads, 1);
    assert.equal(socket.targetLoads, 0);
    assert.equal(socket.pushes, 0);
    assert.deepEqual(socket.events, ['root-1']);
  } finally { snapshots.dispose(); }
});

test('empty updates still require an accepted acknowledgement and return no revision when uncertain', async () => {
  const snapshots = revisionSnapshots();
  const socket = revisionSocket(snapshots, { accepted: false });
  const empty = new Y.Doc();
  const noOpUpdate = Buffer.from(Y.encodeStateAsUpdate(empty)).toString('base64');
  empty.destroy();
  try {
    const tool = coordinateTool('append_block', shape, async ({ docId }) => {
      await loadDoc(socket, context.workspaceId, docId);
      await pushPageDocUpdate(socket, context.workspaceId, docId, noOpUpdate);
      return { content: [], structuredContent: { ok: true, changed: false } };
    }, context);
    const result = await withToolErrors(tool.handler, {
      toolName: 'append_block', authMode: 'bearer', readOnly: false,
    })({ docId: 'doc' });
    assert.equal(socket.pushes.length, 1, 'the server receives the empty update but does not accept it');
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, 'write_ack_uncertain');
    assert.equal(Object.hasOwn(result.structuredContent, 'revision'), false);
  } finally { snapshots.dispose(); }
});

test('delete_doc returns null only after verified content absence', async () => {
  const snapshots = revisionSnapshots();
  const socket = revisionSocket(snapshots);
  try {
    for (const [status, contentAbsenceVerified, expectedRevision] of [
      ['partial', false, undefined],
      ['deleted', true, null],
    ]) {
      const tool = coordinateTool('delete_doc', shape, async ({ docId }) => {
        await loadDoc(socket, context.workspaceId, docId);
        return {
          content: [],
          structuredContent: { kind: 'doc.delete', ok: true, status, contentAbsenceVerified },
        };
      }, context);
      const result = await tool.handler({ docId: 'doc' });
      assert.equal(result.structuredContent.status, status);
      assert.equal(Object.hasOwn(result.structuredContent, 'revision'), expectedRevision !== undefined);
      if (expectedRevision !== undefined) assert.equal(result.structuredContent.revision, expectedRevision);
    }
  } finally { snapshots.dispose(); }
});

test('coordinated stale snapshots return the structured conflict without invoking the write', async () => {
  const snapshots = revisionSnapshots();
  const socket = revisionSocket(snapshots);
  let pushed = false;
  try {
    const tool = coordinateTool('append_block', shape, async ({ docId }) => {
      await loadDoc(socket, context.workspaceId, docId);
      pushed = true;
      return { content: [], structuredContent: { ok: true } };
    }, context);
    const result = await tool.handler({ docId: 'doc', expectedRevision: 'a'.repeat(64) });
    assert.equal(pushed, false);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, 'STALE_DOCUMENT_REVISION');
    assert.equal(result.structuredContent.details.currentRevision, documentRevision(snapshots.document));
  } finally { snapshots.dispose(); }
});

test('independent registrations share workspace coordination, including default ids and workspace deletion', async () => {
  const started = deferred(), release = deferred();
  const events = [];
  const first = coordinateTool('append_block', shape, async () => {
    events.push('write-start'); started.resolve(); await release.promise; events.push('write-end');
  }, context);
  const read = coordinateTool('read_doc', shape, async () => events.push('read'), context);
  const revisionRead = coordinateTool('get_doc_revision', shape, async () => events.push('revision'), context);
  const remove = coordinateTool('delete_workspace', { id: z.string() }, async () => events.push('delete'), context);
  const writing = first.handler({ docId: 'doc' });
  await started.promise;
  const reading = read.handler({ workspaceId: context.workspaceId, docId: 'doc' });
  const revisionReading = revisionRead.handler({ workspaceId: context.workspaceId, docId: 'doc' });
  const deleting = remove.handler({ id: context.workspaceId });
  await Promise.resolve();
  assert.deepEqual(events, ['write-start']);
  release.resolve();
  await Promise.all([writing, reading, revisionReading, deleting]);
  assert.deepEqual(events, ['write-start', 'write-end', 'read', 'revision', 'delete']);
});

test('unrelated workspace operations can finish while another workspace is blocked', async () => {
  const started = deferred(), release = deferred();
  const blocked = coordinateTool('append_block', shape, async () => {
    started.resolve(); await release.promise;
  }, context).handler({ workspaceId: 'blocked', docId: 'doc' });
  await started.promise;
  try {
    const result = await coordinateTool('append_block', shape, async () => 'finished', context)
      .handler({ workspaceId: 'independent', docId: 'doc' });
    assert.equal(result, 'finished');
  } finally { release.resolve(); await blocked; }
});
