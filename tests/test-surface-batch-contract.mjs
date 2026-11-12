#!/usr/bin/env node
import "./require-destructive-test-safety.mjs";

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { registerDocTools } from '../dist/tools/docs.js';
import { addBatch, compactSurfaceElement } from '../dist/tools/surfaceBatch.js';

function recorder() {
  const seen = [];
  return { seen, addOne: item => { seen.push(item); return { elementId: `id_${seen.length}`, type: item.type }; } };
}

test('addBatch resolves local keys in connectors and keeps input order', () => {
  const { seen, addOne } = recorder();
  const results = addBatch([
    { key: 'a', type: 'shape' }, { key: 'b', type: 'shape' },
    { type: 'connector', sourceId: 'a', targetId: 'b' },
  ], addOne);
  assert.deepEqual(results.map(r => r.elementId), ['id_1', 'id_2', 'id_3']);
  assert.equal(results[0].key, 'a');
  assert.equal(seen[2].sourceId, 'id_1');
  assert.equal(seen[2].targetId, 'id_2');
});

test('addBatch passes unknown ids through as existing elements and does not leak keys', () => {
  const { seen, addOne } = recorder();
  addBatch([{ key: 'a', type: 'shape' }, { type: 'connector', sourceId: 'a', targetId: 'existing-shape' }], addOne);
  assert.equal(seen[1].targetId, 'existing-shape');
  assert.equal('key' in seen[0], false);
});

test('addBatch rejects forward references, duplicate and blank keys before adding anything', () => {
  for (const [items, message] of [
    [[{ type: 'connector', sourceId: 'later', targetId: 'later' }, { key: 'later', type: 'shape' }], /earlier/],
    [[{ key: 'a', type: 'shape' }, { key: 'a', type: 'shape' }], /duplicate/],
    [[{ key: ' ', type: 'shape' }], /blank/],
  ]) {
    const { seen, addOne } = recorder();
    assert.throws(() => addBatch(items, addOne), message);
    assert.equal(seen.length, 0);
  }
});

test('compactSurfaceElement keeps identity, geometry, text and links but drops style data', () => {
  const bounds = { x: 0, y: 0, width: 10, height: 10 };
  assert.deepEqual(
    compactSurfaceElement({ id: 'a', type: 'shape', index: 'a0', xywh: '[0,0,10,10]', bounds, text: 'T', fillColor: '#fff', fontFamily: 'x', shadow: { blur: 1 }, seed: 1 }),
    { id: 'a', type: 'shape', index: 'a0', xywh: '[0,0,10,10]', bounds, text: 'T' },
  );
  const connector = { id: 'c', type: 'connector', source: { id: 'a' }, target: { id: 'b' }, stroke: '#000', labelStyle: {} };
  assert.deepEqual(compactSurfaceElement(connector), { id: 'c', type: 'connector', source: { id: 'a' }, target: { id: 'b' } });
});

const tools = new Map();
registerDocTools({ registerTool: (name, definition) => tools.set(name, definition) }, {}, {});
const accepts = (name, value) => z.object(tools.get(name)?.inputSchema ?? { missing: z.never() }).safeParse(value).success;

test('batch surface tools accept real batches and reject empty or malformed ones', () => {
  assert.equal(accepts('add_surface_elements', { docId: 'd', elements: [{ key: 'a', type: 'shape', text: 'A' }, { type: 'connector', sourceId: 'a', targetId: 'x' }] }), true);
  for (const value of [{ docId: 'd', elements: [] }, { docId: 'd', elements: [{ type: 'blob' }] }, { elements: [{ type: 'shape' }] }]) {
    assert.equal(accepts('add_surface_elements', value), false, JSON.stringify(value));
  }
  assert.equal(accepts('update_surface_elements', { docId: 'd', updates: [{ elementId: 'e', x: 1, text: 'T' }] }), true);
  for (const value of [{ docId: 'd', updates: [] }, { docId: 'd', updates: [{ x: 1 }] }]) {
    assert.equal(accepts('update_surface_elements', value), false, JSON.stringify(value));
  }
});

test('canvas read tools accept compact', () => {
  assert.equal(accepts('list_surface_elements', { docId: 'd', compact: true }), true);
  assert.equal(accepts('get_edgeless_canvas', { docId: 'd', compact: true }), true);
  assert.equal(accepts('get_edgeless_canvas', { docId: 'd', compact: 'yes' }), false);
});
