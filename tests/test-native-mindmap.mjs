import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { generateKeyBetween } from 'fractional-indexing';
import { z } from 'zod';
import { mutateNativeMindmap, readNativeMindmap, registerMindmapTools } from '../dist/tools/mindmap.js';
import { toolOutputSchemaFor } from '../dist/toolOutputSchemas.js';
import { createToolFilter } from '../dist/toolSurface.js';

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

test('native hierarchy survives Yjs serialization and keeps ordered children and local-only connectors', () => {
  const f = fixture();
  const a = f.add(f.map.rootId, 'Project A'), b = f.add(f.map.rootId, 'Project B');
  const task = f.add(a, 'Task 1');
  const first = f.add(a, 'Task 0', task);
  const copy = new Y.Doc(); Y.applyUpdate(copy, Y.encodeStateAsUpdate(f.doc));
  const result = readNativeMindmap(copy.getMap('elements'), f.map.mindmapId);
  assert.equal(result.nodeCount, 5);
  assert.deepEqual(result.nodes.find(n => n.nodeId === a).children, [first, task]);
  assert.equal(result.nodes.find(n => n.nodeId === b).parentId, f.map.rootId);
  assert.equal([...copy.getMap('elements').values()].filter(e => e.get('type') === 'mindmap').length, 1);
  assert.equal([...copy.getMap('elements').values()].filter(e => e.get('type') === 'connector').length, 0);
});

test('reparent preserves descendants, root anchor, node IDs, and collapsed state', () => {
  const f = fixture(), a = f.add(f.map.rootId, 'A'), b = f.add(f.map.rootId, 'B'), c = f.add(a, 'C'), d = f.add(c, 'D');
  f.mutate('update', { mindmapId: f.map.mindmapId, nodeId: c, text: 'Renamed\nЗадача', collapsed: true });
  const rootBefore = f.values.get(f.map.rootId).get('xywh');
  f.mutate('reparent', { mindmapId: f.map.mindmapId, nodeId: c, parentId: b });
  const result = f.read();
  assert.equal(result.nodes.find(n => n.nodeId === c).parentId, b);
  assert.equal(result.nodes.find(n => n.nodeId === d).parentId, c);
  assert.equal(result.nodes.find(n => n.nodeId === c).collapsed, true);
  assert.equal(result.nodes.find(n => n.nodeId === c).text, 'Renamed\nЗадача');
  assert.equal(f.values.get(f.map.rootId).get('xywh'), rootBefore);
});

test('reject missing/foreign IDs, root moves, cycles, bad beforeId and unsupported direction before topology changes', () => {
  const f = fixture(), a = f.add(f.map.rootId, 'A'), b = f.add(a, 'B');
  const other = f.mutate('create', { text: 'Other map' });
  const cases = [
    ['add', { parentId: 'absent', text: 'X' }],
    ['add', { parentId: other.rootId, text: 'X' }],
    ['add', { parentId: a, text: 'X', beforeId: f.map.rootId }],
    ['update', { nodeId: other.rootId, text: 'X' }],
    ['update', { nodeId: a }],
    ['reparent', { nodeId: f.map.rootId, parentId: a }],
    ['reparent', { nodeId: a, parentId: a }],
    ['reparent', { nodeId: a, parentId: b }],
    ['reparent', { nodeId: a, parentId: other.rootId }],
    ['reparent', { nodeId: b, parentId: a, beforeId: b }],
    ['layout', { layout: 'down' }],
  ];
  for (const [op, args] of cases) {
    const before = f.values.toJSON();
    assert.throws(() => f.mutate(op, { mindmapId: f.map.mindmapId, ...args }), `${op} ${JSON.stringify(args)}`);
    assert.deepEqual(f.values.toJSON(), before);
  }
  assert.throws(() => readNativeMindmap(f.values, a), /native mindmap/);
  assert.throws(() => f.mutate('add', { mindmapId: f.map.mindmapId, parentId: 'bad id', text: 'X' }));
});

test('layout persists right/left/balance coordinates without overlap and preserves collapsed flags', () => {
  const f = fixture(), ids = ['A', 'B', 'C', 'D'].map(s => f.add(f.map.rootId, s));
  f.add(ids[0], 'Long label '.repeat(30));
  f.mutate('update', { mindmapId: f.map.mindmapId, nodeId: ids[3], collapsed: true });
  for (const [layout, rightCount] of [['right', 4], ['left', 0], ['balance', 2]]) {
    f.mutate('layout', { mindmapId: f.map.mindmapId, layout });
    const result = f.read(), root = JSON.parse(f.values.get(f.map.rootId).get('xywh'));
    assert.equal(result.layout, layout);
    assert.equal(ids.filter(id => JSON.parse(f.values.get(id).get('xywh'))[0] > root[0]).length, rightCount);
    assert.equal(result.nodes.find(n => n.nodeId === ids[3]).collapsed, true);
    const boxes = ids.map(id => JSON.parse(f.values.get(id).get('xywh')));
    for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
      const [x,y,w,h] = boxes[a], [xx,yy,ww,hh] = boxes[b];
      assert.ok(x + w <= xx || xx + ww <= x || y + h <= yy || yy + hh <= y);
    }
  }
});

test('malformed graph and shared ownership are rejected', () => {
  const f = fixture(), a = f.add(f.map.rootId, 'A');
  const details = f.values.get(f.map.mindmapId).get('children');
  details.set(f.map.rootId, { index: 'a0', parent: a });
  assert.throws(f.read, /root/);
  details.set(f.map.rootId, { index: 'a0' });
  details.set(a, { index: 'a0', parent: 'absent' });
  assert.throws(f.read, /parent/);
  details.set(a, { index: 'a0', parent: f.map.rootId });
  f.values.set('group', new Y.Map([['type','group'], ['children',new Y.Map([[a,true]])]]));
  assert.throws(f.read, /owned/);
});

test('schemas expose only supported layouts and catalog honors read-only filtering', () => {
  const registered = new Map();
  registerMindmapTools({ registerTool: (name, options, handler) => registered.set(name, { ...options, handler }) }, {}, {}, {});
  assert.equal(registered.size, 8);
  const create = z.object(registered.get('create_mindmap').inputSchema);
  assert.equal(create.safeParse({ docId: 'doc', text: 'Root', layout: 'down' }).success, false);
  assert.equal(create.safeParse({ docId: 'doc', text: ' ', layout: 'right' }).success, false);
  assert.equal(create.safeParse({ docId: 'doc', text: 'Root', x: Infinity }).success, false);
  const full = createToolFilter({ AFFINE_TOOL_PROFILE: 'full' });
  const readonly = createToolFilter({ AFFINE_TOOL_PROFILE: 'read_only' });
  for (const name of registered.keys()) {
    assert.ok(full.isEnabled(name));
    assert.equal(readonly.isEnabled(name), name === 'get_mindmap');
    assert.ok(toolOutputSchemaFor(name));
  }
});

test('all four native styles persist node presets, branch/depth colors and preserve topology', () => {
  const f = fixture(), a = f.add(f.map.rootId, 'A'), b = f.add(f.map.rootId, 'B'), c = f.add(a, 'C'), d = f.add(c, 'D');
  const target = { mindmapId: f.map.mindmapId };
  f.mutate('update', { ...target, nodeId: c, collapsed: true });
  const topology = () => f.read().nodes.map(({nodeId,parentId,index,text,collapsed,children}) => ({nodeId,parentId,index,text,collapsed,children}));
  const before = topology(), anchor = JSON.parse(f.values.get(f.map.rootId).get('xywh')).slice(0,2);
  for (const style of [2, 3, 4, 1]) {
    f.mutate('style', { ...target, style });
    assert.equal(f.read().style, style);
    assert.deepEqual(topology(), before);
    assert.deepEqual(JSON.parse(f.values.get(f.map.rootId).get('xywh')).slice(0,2), anchor);
    const root = f.values.get(f.map.rootId), child = f.values.get(a);
    if (style === 1) {
      assert.equal(root.get('strokeColor'), '#53b2ef');
      assert.equal(child.get('strokeColor'), '#6e52df');
      assert.equal(f.values.get(b).get('strokeColor'), '#e96cab');
      assert.equal(f.values.get(d).get('strokeColor'), '#6e52df');
    } else if (style === 2) {
      assert.deepEqual(root.get('strokeColor'), {light:'#000000',dark:'#ffffff'});
      assert.equal(child.get('fillColor'), '#84cfff');
      assert.equal(f.values.get(c).get('fillColor'), '#7ae2d5');
      assert.equal(f.values.get(d).get('fillColor'), '#fcd34d');
    } else if (style === 3) {
      assert.equal(root.get('strokeWidth'), 0);
      assert.equal(child.get('strokeColor'), '#fcd34d');
      assert.equal(f.values.get(c).get('strokeColor'), '#3cbc36');
    } else {
      assert.equal(root.get('fontFamily'), 'blocksuite:surface:Kalam');
      assert.equal(child.get('fillColor'), 'transparent');
      assert.equal(child.has('shadow'), false);
    }
  }
  f.mutate('reparent', {...target, nodeId:c, parentId:b});
  assert.equal(f.values.get(c).get('strokeColor'), '#e96cab');
  f.mutate('style', {...target, style:4});
  const added = f.add(b, 'Added in FOUR');
  assert.equal(f.values.get(added).get('fontFamily'), 'blocksuite:surface:Kalam');
  const snapshot = f.values.toJSON();
  for (const style of [0,5,1.5,'2']) assert.throws(() => f.mutate('style', {...target,style}));
  assert.deepEqual(f.values.toJSON(), snapshot);
  const other = f.mutate('create', {text:'Style TWO',style:2});
  assert.equal(other.style,2);
  assert.equal(f.values.get(other.rootId).get('fillColor'),'#fcd34d');
});

test('native lock survives Yjs, blocks all editing operations and unlock preserves child locks', () => {
  const f = fixture(), a = f.add(f.map.rootId, 'A'), target = {mindmapId:f.map.mindmapId};
  const shapeBefore = f.values.get(a).toJSON();
  assert.equal(f.mutate('lock', {...target,locked:true}).locked,true);
  const copy = new Y.Doc(); Y.applyUpdate(copy, Y.encodeStateAsUpdate(f.doc));
  const persisted = readNativeMindmap(copy.getMap('elements'),f.map.mindmapId);
  assert.equal(persisted.lockedBySelf,true);
  assert.ok(persisted.nodes.every(n=>n.locked && !n.lockedBySelf));
  const snapshot=f.values.toJSON();
  for (const [op,args] of [['add',{parentId:a,text:'X'}],['update',{nodeId:a,text:'X'}],['reparent',{nodeId:a,parentId:f.map.rootId}],['layout',{layout:'left'}],['style',{style:2}]]) {
    assert.throws(()=>f.mutate(op,{...target,...args}),/locked/);
    assert.deepEqual(f.values.toJSON(),snapshot);
  }
  assert.deepEqual(f.values.get(a).toJSON(),shapeBefore);
  assert.throws(()=>f.mutate('lock',{...target,locked:'false'}));
  f.values.get(a).set('lockedBySelf',true);
  assert.equal(f.mutate('lock',{...target,locked:false}).locked,false);
  assert.equal(f.read().nodes.find(n=>n.nodeId===a).locked,true);
  assert.throws(()=>f.mutate('update',{...target,nodeId:a,text:'X'}),/locked/);
  f.values.get(a).set('lockedBySelf',false);
  f.mutate('update',{...target,nodeId:a,text:'Editable again'});
  assert.equal(f.read().nodes.find(n=>n.nodeId===a).text,'Editable again');
});

test('unlock cannot clear a containing group lock or move its geometry', () => {
  const f=fixture(), target={mindmapId:f.map.mindmapId};
  f.values.set('outer',new Y.Map([['type','group'],['lockedBySelf',true],['children',new Y.Map([[f.map.mindmapId,true]])]]));
  const geometry=f.values.get(f.map.rootId).get('xywh');
  const result=f.mutate('lock',{...target,locked:false});
  assert.equal(result.lockedBySelf,false);
  assert.equal(result.lockedByAncestor,true);
  assert.equal(result.locked,true);
  assert.ok(result.nodes.every(n=>n.locked));
  assert.equal(f.values.get('outer').get('lockedBySelf'),true);
  assert.equal(f.values.get(f.map.rootId).get('xywh'),geometry);
  assert.throws(()=>f.mutate('layout',{...target,layout:'left'}),/locked/);
});
