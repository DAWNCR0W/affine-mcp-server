#!/usr/bin/env node
import "./require-destructive-test-safety.mjs";

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { generateKeyBetween } from 'fractional-indexing';
import { z } from 'zod';
import { compactMindmap, mutateNativeMindmap, readNativeMindmap, registerMindmapTools } from '../dist/tools/mindmap.js';

function fixture() {
  const doc = new Y.Doc(), values = doc.getMap('elements');
  let seq = 0;
  const helpers = {
    buildSurfaceElementData: (type, index, { text }) => {
      const elementId = `shape_${++seq}`;
      return { elementId, data: { type, index, id: elementId, xywh: '[0,0,100,30]', text: new Y.Text(text) } };
    },
    writeSurfaceElement: (map, id, data) => map.set(id, new Y.Map(Object.entries(data))),
    nextSurfaceElementIndex: map => generateKeyBetween([...map.values()].map(v => v.get('index')).sort().at(-1) ?? null, null),
  };
  const mutate = (op, p) => mutateNativeMindmap(values, op, p, helpers);
  const map = mutate('create', { text: 'Projects', x: 200, y: 100 });
  const add = (parentId, text, beforeId) => mutate('add', { mindmapId: map.mindmapId, parentId, text, beforeId }).nodeId;
  return { doc, values, mutate, map, add, read: () => readNativeMindmap(values, map.mindmapId) };
}

test('create builds a nested outline in one mutation and keeps document order', () => {
  const f = fixture();
  const map = f.mutate('create', { text: 'Plan', children: [{ text: 'A', children: [{ text: 'A1' }, { text: 'A2' }] }, { text: 'B' }] });
  assert.equal(map.nodeCount, 5);
  const byText = text => map.nodes.find(n => n.text === text);
  assert.equal(byText('A').parentId, map.rootId);
  assert.equal(byText('A2').parentId, byText('A').nodeId);
  assert.deepEqual(map.nodes.find(n => n.nodeId === map.rootId).children, [byText('A').nodeId, byText('B').nodeId]);
  assert.deepEqual(byText('A').children, [byText('A1').nodeId, byText('A2').nodeId]);
});

test('invalid or oversized outlines are rejected before any element is written', () => {
  const f = fixture(), before = f.values.toJSON();
  const wide = Array.from({ length: 500 }, (_, i) => ({ text: `n${i}` }));
  for (const children of [[{ text: 'ok', children: [{ text: ' ' }] }], wide, [{ text: 'x', children: 'nope' }]]) {
    assert.throws(() => f.mutate('create', { text: 'Root', children }));
    assert.deepEqual(f.values.toJSON(), before);
  }
});

test('compact responses keep counts and ids but drop the node list', () => {
  const f = fixture(), added = f.mutate('add', { mindmapId: f.map.mindmapId, parentId: f.map.rootId, text: 'A' });
  const compact = compactMindmap(added);
  assert.deepEqual(compact.nodes, []);
  assert.equal(compact.compact, true);
  assert.equal(compact.nodeCount, 2);
  assert.equal(compact.nodeId, added.nodeId);
});

test('create_mindmap schema accepts a bounded outline and every mutating tool accepts compact', () => {
  const registered = new Map();
  registerMindmapTools({ registerTool: (name, options) => registered.set(name, options) }, {}, {}, {});
  const create = z.object(registered.get('create_mindmap').inputSchema);
  assert.equal(create.safeParse({ docId: 'doc', text: 'Root', children: [{ text: 'A', children: [{ text: 'A1' }] }] }).success, true);
  for (const children of [[{ text: ' ' }], [{ text: 'A', children: 'x' }], Array.from({ length: 500 }, (_, i) => ({ text: `n${i}` }))]) {
    assert.equal(create.safeParse({ docId: 'doc', text: 'Root', children }).success, false);
  }
  for (const name of ['create_mindmap', 'add_mindmap_node', 'update_mindmap_node', 'reparent_mindmap_node', 'set_mindmap_style', 'set_mindmap_layout']) {
    assert.ok(registered.get(name).inputSchema.compact, `${name} should accept compact`);
  }
  assert.equal(registered.get('get_mindmap').inputSchema.compact, undefined);
});
