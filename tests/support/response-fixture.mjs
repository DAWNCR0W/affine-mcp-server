// Entirely synthetic Yjs snapshots behind a loopback Socket.IO protocol fixture.
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { WebSocketServer } from 'ws';
import { z } from 'zod/v3';
import { registerDocTools } from '../../dist/tools/docs.js';
import { coordinateTool } from '../../dist/toolCoordination.js';
import { toolOutputSchemaFor } from '../../dist/toolOutputSchemas.js';

export const workspaceId = 'synthetic-workspace';
export const docId = 'synthetic-log';
export const databaseDocId = 'synthetic-database';
export const databaseBlockId = 'database';
export const reference = { insert: ' ', attributes: { reference: { type: 'LinkedPage', pageId: 'synthetic-reference' } } };

export function seedDocuments() {
  const root = new Y.Doc(); root.clientID = 100;
  root.getMap('meta').set('pages', new Y.Array());
  for (const id of [docId, databaseDocId]) root.getMap('meta').get('pages').push([
    new Y.Map([['id', id], ['title', 'Synthetic fixture'], ['createDate', 1], ['updatedDate', 1]]),
  ]);
  const page = new Y.Doc(); page.clientID = 200;
  const database = new Y.Doc(); database.clientID = 300;
  function block(doc, id, flavour, children = []) {
    const row = new Y.Map();
    row.set('sys:id', id); row.set('sys:flavour', flavour); row.set('sys:version', 1);
    row.set('sys:children', new Y.Array());
    doc.getMap('blocks').set(id, row);
    row.get('sys:children').push(children);
    return row;
  }
  function rich(deltas) { const value = new Y.Text(); value.applyDelta(deltas); return value; }
  block(page, 'page', 'affine:page', ['note']).set('prop:title', new Y.Text('Synthetic correspondence'));
  const ids = Array.from({ length: 60 }, (_, i) => `b${String(i).padStart(2, '0')}`);
  block(page, 'note', 'affine:note', ids);
  for (let i = 0; i < 60; i++) {
    const row = block(page, ids[i], 'affine:paragraph');
    row.set('prop:type', i % 6 === 0 ? 'h3' : 'text');
    const section = Math.floor(i / 6) + 1;
    row.set('prop:text', i % 6 === 0 ? new Y.Text(`2026-11-${String(section).padStart(2, '0')} — Synthetic sender`)
      : rich([
        { insert: `Synthetic entry ${i}: ${'This invented correspondence contains no personal data. '.repeat(4)}` },
        ...(i % 6 === 1 ? [reference, { insert: ' reference suffix', attributes: { bold: true } }] : []),
      ]));
  }
  block(database, 'db-page', 'affine:page', ['db-note']).set('prop:title', new Y.Text('Synthetic tasks'));
  block(database, 'db-note', 'affine:note', [databaseBlockId]);
  const rowIds = Array.from({ length: 40 }, (_, i) => `row${String(i).padStart(2, '0')}`);
  const db = block(database, databaseBlockId, 'affine:database', rowIds);
  db.set('prop:title', new Y.Text('Synthetic tasks'));
  db.set('prop:columns', new Y.Array());
  const options = [{ id: 'open-id', value: 'open', color: 'blue' }, { id: 'closed-id', value: 'closed', color: 'green' }];
  db.get('prop:columns').push([
    { id: 'title', name: 'Title', type: 'title' },
    { id: 'status', name: 'Status', type: 'select', data: { options } },
    { id: 'due', name: 'Due', type: 'date' },
    { id: 'notes', name: 'Notes', type: 'rich-text' },
    { id: 'estimate', name: 'Estimate', type: 'number' },
    { id: 'tags', name: 'Tags', type: 'multi-select', data: { options } },
  ]);
  db.set('prop:cells', new Y.Map());
  for (let i = 0; i < 40; i++) {
    const row = block(database, rowIds[i], 'affine:paragraph');
    row.set('sys:parent', databaseBlockId); row.set('prop:type', 'text');
    row.set('prop:text', rich(i % 10 === 0 ? [{ insert: `Synthetic task ${i} ` }, reference] : [{ insert: `Synthetic task ${i}` }]));
    const cells = new Y.Map(); db.get('prop:cells').set(rowIds[i], cells);
    for (const [columnId, value] of Object.entries({
      status: i % 2 ? 'closed-id' : 'open-id',
      due: Date.UTC(2026, 10, 1 + i, 12),
      notes: rich([{ insert: `${i % 3 === 0 ? 'urgent' : 'routine'} synthetic task notes ${i}` }, ...(i % 10 === 0 ? [reference] : [])]),
      estimate: i,
      tags: new Y.Array(),
    })) {
      cells.set(columnId, new Y.Map([['columnId', columnId], ['value', value]]));
      if (columnId === 'tags') value.push([i % 2 ? 'closed-id' : 'open-id']);
    }
  }
  return new Map([[workspaceId, root], [docId, page], [databaseDocId, database]]);
}

export async function createResponseFixture({ register = registerDocTools, coordinate = coordinateTool, validateOutput = true } = {}) {
  let docs = seedDocuments();
  const snapshots = new Map([...docs].map(([id, doc]) => [id, Y.encodeStateAsUpdate(doc)]));
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let pushes = 0, accepted = true;
  wss.on('connection', socket => {
    socket.send(`0${JSON.stringify({ sid: 'synthetic-engine', upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 10000000 })}`);
    socket.on('message', message => {
      const packet = String(message);
      if (packet === '2') { socket.send('3'); return; }
      if (packet.startsWith('40')) { socket.send('40{"sid":"synthetic-socket"}'); return; }
      if (!packet.startsWith('42')) return;
      const index = packet.indexOf('['), ackId = packet.slice(2, index);
      const [event, payload = {}] = JSON.parse(packet.slice(index));
      let ack;
      if (event === 'space:join') ack = undefined;
      else if (event === 'space:load-doc') {
        const doc = docs.get(payload.docId);
        ack = { data: doc ? { missing: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') } : {} };
      } else if (event === 'space:push-doc-update') {
        pushes++;
        if (accepted) Y.applyUpdate(docs.get(payload.docId), Buffer.from(payload.update, 'base64'));
        ack = { data: { accepted, timestamp: 1 } };
      } else throw new Error(`Unexpected fixture event ${event}`);
      socket.send(`43${ackId}${JSON.stringify(ack === undefined ? [] : [ack])}`);
    });
  });
  await new Promise((resolve, reject) => { wss.once('listening', resolve); wss.once('error', reject); });
  const endpoint = `http://127.0.0.1:${wss.address().port}/graphql`;
  const gql = {
    async getConnectionAuth() { return { endpoint }; },
    async request(query) {
      if (query.includes('currentUser')) return { currentUser: { id: 'synthetic-user' } };
      throw new Error(`Unexpected synthetic GraphQL query ${query}`);
    },
  };
  const tools = new Map();
  register({ registerTool(name, definition, handler) {
    const coordinated = coordinate(name, definition.inputSchema, handler, { gql, endpoint, workspaceId });
    tools.set(name, { definition: { ...definition, inputSchema: coordinated.inputSchema }, handler: coordinated.handler });
  } }, gql, { workspaceId });
  return {
    tools,
    get docs() { return docs; },
    get pushes() { return pushes; },
    set accepted(value) { accepted = value; },
    reset() {
      for (const doc of docs.values()) doc.destroy();
      docs = new Map([...snapshots].map(([id, snapshot]) => {
        const doc = new Y.Doc(); Y.applyUpdate(doc, snapshot); return [id, doc];
      }));
      pushes = 0; accepted = true;
    },
    async raw(name, args = {}) {
      const { definition, handler } = tools.get(name);
      const result = await handler(z.object(definition.inputSchema).parse({ workspaceId, docId, ...args }));
      if (validateOutput) {
        const parsed = toolOutputSchemaFor(name).safeParse(result.structuredContent);
        assert(parsed.success, `${name} output invalid: ${parsed.error?.message}`);
      }
      assert.equal(result.content[0].text, JSON.stringify(result.structuredContent));
      return result;
    },
    async call(name, args = {}) { return (await this.raw(name, args)).structuredContent; },
    async close() {
      for (const socket of wss.clients) socket.terminate();
      await new Promise(resolve => wss.close(resolve));
      for (const doc of docs.values()) doc.destroy();
    },
  };
}

// Normalize only unavoidable runtime-generated IDs/revisions, preserving every
// other field and property order for byte-for-byte legacy response snapshots.
export function normalizeLegacyResponse(result) {
  let serialized = result.content[0].text.replace(/"revision":"[a-f0-9]{64}"/g, '"revision":"<revision>"');
  const payload = result.structuredContent;
  const ids = payload.blockIds ?? (payload.appended ? [payload.blockId] : []);
  for (const [i, id] of ids.entries()) serialized = serialized.replaceAll(id, `<generated-${i}>`);
  return serialized;
}

export const legacyCases = [
  ['read_doc', {}], ['read_doc', { blockIds: ['b01', 'missing'] }],
  ['export_doc_markdown', {}], ['export_doc_markdown', { includeFrontmatter: true }],
  ['read_database_cells', { docId: databaseDocId, databaseBlockId }],
  ['update_block', { blockId: 'b01', text: 'Synthetic replacement' }],
  ['delete_block', { blockId: 'b01' }], ['delete_block', { blockId: 'missing' }],
  ['append_block', { type: 'paragraph', text: 'Synthetic appended text' }],
  ['append_markdown', { markdown: 'Synthetic appended Markdown' }],
  ['move_block', { blockId: 'b01', placement: { afterBlockId: 'b02' } }],
  ['update_database_row', { docId: databaseDocId, databaseBlockId, rowBlockId: 'row01', cells: { Status: 'open' } }],
];
