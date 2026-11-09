#!/usr/bin/env node
import './require-destructive-test-safety.mjs';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { registerDocTools } from '../dist/tools/docs.js';

// Exercise the real handlers and WebSocket/Yjs round trips without live AFFiNE.
const workspaceId = 'order-workspace', docId = 'order-document';
const root = new Y.Doc(), page = new Y.Doc();
const pages = new Y.Array(), metadata = new Y.Map();
metadata.set('id', docId);
metadata.set('createDate', 1);
metadata.set('updatedDate', 1);
pages.push([metadata]);
root.getMap('meta').set('pages', pages);
const blocks = page.getMap('blocks');
function seedBlock(id, flavour, children = []) {
  const block = new Y.Map(), childArray = new Y.Array();
  block.set('sys:id', id);
  block.set('sys:flavour', flavour);
  block.set('sys:version', 1);
  block.set('sys:parent', null);
  childArray.push(children);
  block.set('sys:children', childArray);
  blocks.set(id, block);
  return block;
}
seedBlock('page', 'affine:page', ['surface', 'note']);
const surface = seedBlock('surface', 'affine:surface');
const values = new Y.Map(), wrapper = new Y.Map();
wrapper.set('type', '$blocksuite:internal:native$');
wrapper.set('value', values);
surface.set('prop:elements', wrapper);
seedBlock('note', 'affine:note').set('prop:index', 'a0');
for (const [id, index, presentationIndex] of [
  ['earlier-slide', 'Zz', 'a9'], ['later-map-entry', 'Zy', 'a1'],
]) {
  const block = seedBlock(id, 'affine:frame');
  block.set('prop:index', index);
  block.set('prop:presentationIndex', presentationIndex);
  block.set('prop:xywh', '[0,0,100,100]');
  surface.get('sys:children').push([id]);
}
values.set('existing-shape', new Y.Map([['id', 'existing-shape'], ['type', 'shape'], ['index', 'a8']]));
const originalFrames = ['earlier-slide', 'later-map-entry'].map(id => blocks.get(id).toJSON());
const docs = new Map([[workspaceId, root], [docId, page]]);
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
let timestamp = 1;
wss.on('connection', socket => {
  socket.send(`0${JSON.stringify({ sid: 'order-engine', upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1000000 })}`);
  socket.on('message', message => {
    const packet = String(message);
    if (packet === '2') { socket.send('3'); return; }
    if (packet.startsWith('40')) { socket.send('40{"sid":"order-socket"}'); return; }
    if (!packet.startsWith('42')) return;
    const start = packet.indexOf('['), ackId = packet.slice(2, start);
    const [event, payload = {}] = JSON.parse(packet.slice(start));
    let ack;
    if (event === 'space:join') ack = undefined;
    else if (event === 'space:load-doc') {
      const document = docs.get(payload.docId);
      ack = { data: document ? { missing: Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64') } : {} };
    } else if (event === 'space:push-doc-update') {
      Y.applyUpdate(docs.get(payload.docId), Buffer.from(payload.update, 'base64'));
      ack = { data: { timestamp: ++timestamp } };
    } else throw new Error(`Unexpected event ${event}`);
    socket.send(`43${ackId}${JSON.stringify(ack === undefined ? [] : [ack])}`);
  });
});
await new Promise((resolve, reject) => { wss.once('listening', resolve); wss.once('error', reject); });
const tools = new Map();
registerDocTools({ registerTool(name, definition, handler) { tools.set(name, { definition, handler }); } }, {
  async getConnectionAuth() { return { endpoint: `http://127.0.0.1:${wss.address().port}/graphql` }; },
}, { workspaceId });
async function call(name, args = {}) {
  const { definition, handler } = tools.get(name);
  const result = await handler(z.object(definition.inputSchema).parse({ workspaceId, docId, ...args }));
  assert.ok(!result.isError);
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
try {
  const created = [];
  let previousPresentation = 'a9', previousLayer = 'Zy';
  for (let i = 0; i < 10; i++) {
    const { blockId } = await call('append_block', { type: 'frame', text: `Slide ${i + 1}`, y: i * 1200 });
    const frame = blocks.get(blockId);
    assert.ok(frame.get('prop:presentationIndex') > previousPresentation, 'each slide must follow the greatest existing presentation key');
    assert.ok(frame.get('prop:index') < previousLayer, 'native frame layers stay behind existing content');
    previousPresentation = frame.get('prop:presentationIndex');
    previousLayer = frame.get('prop:index');
    created.push(blockId);
  }
  const canvas = await call('get_edgeless_canvas');
  const slides = canvas.edgelessBlocks.filter(b => created.includes(b.id));
  // Deliberately scramble input: presentation order must not depend on Y.Map or layer order.
  assert.deepEqual(slides.reverse().sort((a, b) => compare(a.presentationIndex, b.presentationIndex)).map(b => b.id), created);
  assert.equal(new Set(slides.map(b => b.index)).size, 10);
  assert.equal(new Set(slides.map(b => b.presentationIndex)).size, 10);
  assert.deepEqual(['earlier-slide', 'later-map-entry'].map(id => blocks.get(id).toJSON()), originalFrames, 'appending must not renumber existing frames');

  // Notes, images, canvas text and native elements share the front layer boundary.
  let last = 'a8';
  for (const args of [
    { type: 'note', text: 'First note' },
    { type: 'edgeless_text', text: 'Canvas text' },
    { type: 'image', sourceId: 'fixture.png', x: 10 },
    { type: 'image', sourceId: 'fixture.png', placement: { parentId: 'surface' } },
  ]) {
    const { blockId } = await call('append_block', args);
    const index = blocks.get(blockId).get('prop:index');
    assert.ok(index > last, 'new canvas blocks must follow every existing block and surface element');
    last = index;
  }
  const shape = await call('add_surface_element', { type: 'shape', text: 'On top' });
  assert.ok(values.get(shape.elementId).get('index') > last, 'surface elements must also account for block layers');
  last = values.get(shape.elementId).get('index');
  const note = await call('append_block', { type: 'note' });
  assert.ok(blocks.get(note.blockId).get('prop:index') > last);
  const pageImage = await call('append_block', { type: 'image', sourceId: 'page.png' });
  assert.equal(blocks.get(pageImage.blockId).get('prop:index'), 'a0', 'page images keep their legacy properties');

  // A native surface can have block children before it has an elements wrapper.
  surface.delete('prop:elements');
  const a = await call('append_block', { type: 'frame' });
  const b = await call('append_block', { type: 'frame' });
  assert.ok(blocks.get(b.blockId).get('prop:index') < blocks.get(a.blockId).get('prop:index'));

  // When a default note is first needed, existing canvas layers still count.
  blocks.delete('note');
  for (const [id, block] of [...blocks]) {
    if (block instanceof Y.Map && block.get('sys:flavour') === 'affine:note') blocks.delete(id);
  }
  const highest = seedBlock('high-layer', 'affine:edgeless-text');
  highest.set('prop:index', 'b00');
  surface.get('sys:children').push(['high-layer']);
  await call('append_block', { type: 'paragraph', text: 'Creates a default note' });
  const defaultNote = [...blocks.values()].find(block => block.get('sys:flavour') === 'affine:note');
  assert.ok(defaultNote.get('prop:index') > 'b00');
  console.log('PASS: ten-frame presentation order, native background layers, mixed canvas indexing, unchanged existing keys, page images and default-note allocation');
} finally {
  for (const socket of wss.clients) socket.terminate();
  await new Promise(resolve => wss.close(resolve));
  for (const document of docs.values()) document.destroy();
}
