import './require-destructive-test-safety.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { captureDocUpdate } from '../dist/util/docUpdate.js';
import { pushPageDocUpdate } from '../dist/ws.js';
import { ensureDocumentCreator, docPropertiesDocId } from '../dist/util/docCreator.js';
import { setExplorerIcon, explorerIconDocId } from '../dist/util/explorerIcon.js';
import { setDocTrashState } from '../dist/tools/docs.js';
import { addOrganizeLinkToFolder } from '../dist/tools/organize.js';

function copy(doc) {
  const result = new Y.Doc();
  Y.applyUpdate(result, Y.encodeStateAsUpdate(doc));
  return result;
}
function equivalent(actual, expected) {
  assert.deepEqual(Y.encodeStateVector(actual), Y.encodeStateVector(expected));
  assert.deepEqual(Y.encodeStateAsUpdate(actual), Y.encodeStateAsUpdate(expected));
}
function withHistory(count = 1200) {
  const doc = new Y.Doc();
  const pages = new Y.Array();
  pages.push([new Y.Map([['id', 'page'], ['updatedDate', 1]])]);
  doc.getMap('meta').set('pages', pages);
  doc.getMap('data').set('deleteMe', 'original');
  doc.getText('text').insert(0, 'original');
  // Simulate one new client per short-lived writer without repeatedly encoding
  // the growing base snapshot while building the fixture.
  for (let i = 1; i <= count; i++) {
    doc.clientID = i;
    doc.getMap('history').set('value', i);
  }
  return doc;
}

const historical = withHistory();

test('historical delete sets are not replayed for no-op or tiny local writes', () => {
  const doc = copy(historical);
  const empty = captureDocUpdate(doc);
  assert.deepEqual(empty.finish(), Uint8Array.of(0, 0));
  const baseline = Y.encodeStateVector(doc);
  const pending = captureDocUpdate(doc);
  doc.getMap('data').set('small', 1);
  const update = pending.finish();
  const oldUpdate = Y.encodeStateAsUpdate(doc, baseline);
  assert(oldUpdate.length > 5000, `fixture must reproduce historical payload: ${oldUpdate.length}`);
  assert(update.length < 100, `local edit must remain tiny: ${update.length}`);
  const remote = copy(historical);
  Y.applyUpdate(remote, update);
  equivalent(remote, doc);
  console.log(`historical-delta comparison: ${oldUpdate.length} bytes -> ${update.length} bytes`);
  doc.destroy(); remote.destroy();
});

test('deletion-only updates retain real deletions and preserve historical state', () => {
  const doc = copy(historical), remote = copy(historical);
  const before = Y.encodeStateVector(doc);
  const pending = captureDocUpdate(doc);
  doc.getMap('data').delete('deleteMe');
  doc.getText('text').delete(1, 3);
  assert.deepEqual(Y.encodeStateVector(doc), before, 'deletions do not advance the state vector');
  const update = pending.finish();
  const decoded = Y.decodeUpdate(update);
  assert.equal(decoded.structs.length, 0);
  assert(decoded.ds.clients.size > 0);
  assert(update.length < 100);
  Y.applyUpdate(remote, update);
  equivalent(remote, doc);
  assert.equal(remote.getMap('data').has('deleteMe'), false);
  assert.equal(remote.getText('text').toString(), 'oinal');
  doc.destroy(); remote.destroy();
});

test('multiple asynchronous transactions and nested edits retain their ordering', async () => {
  const doc = copy(historical), remote = copy(historical);
  const pending = captureDocUpdate(doc);
  doc.getText('text').insert(0, 'first');
  await Promise.resolve();
  doc.transact(() => {
    doc.getText('text').delete(0, 2);
    doc.getMap('data').set('nested', new Y.Map([['value', 1]]));
    doc.transact(() => doc.getMap('data').get('nested').set('value', 2));
  });
  await Promise.resolve();
  doc.getMap('data').delete('deleteMe');
  const update = pending.finish();
  assert.equal(pending.finish(), update, 'retrying the same captured bytes is idempotent');
  Y.applyUpdate(remote, update);
  Y.applyUpdate(remote, update);
  equivalent(remote, doc);
  doc.destroy(); remote.destroy();
});

test('remote events are not echoed, but subsequent local mutations are captured', () => {
  const doc = copy(historical), remote = copy(historical);
  const incoming = captureDocUpdate(remote);
  remote.getMap('data').set('incoming', new Y.Map([['value', 1]]));
  const remoteUpdate = incoming.finish();
  const pending = captureDocUpdate(doc);
  Y.applyUpdate(doc, remoteUpdate);
  doc.getMap('data').get('incoming').set('value', 2);
  const localUpdate = pending.finish();
  assert(Y.decodeUpdate(localUpdate).structs.every(s => s.id.client === doc.clientID));
  Y.applyUpdate(remote, localUpdate);
  equivalent(remote, doc);
  doc.destroy(); remote.destroy();
});

test('concurrent edits converge in either order without dropping deletions', () => {
  const left = copy(historical), right = copy(historical);
  const first = captureDocUpdate(left), second = captureDocUpdate(right);
  left.getText('text').delete(0, 4);
  left.getMap('data').set('left', true);
  right.getText('text').insert(2, 'concurrent');
  right.getMap('data').delete('deleteMe');
  const a = first.finish(), b = second.finish();
  const ab = copy(historical), ba = copy(historical);
  Y.applyUpdate(ab, a); Y.applyUpdate(ab, b);
  Y.applyUpdate(ba, b); Y.applyUpdate(ba, a);
  equivalent(ab, ba);
  assert.equal(ab.getMap('data').has('deleteMe'), false);
  assert.equal(ab.getMap('data').get('left'), true);
  for (const d of [left, right, ab, ba]) d.destroy();
});

test('finish, disposal and document destruction remove capture listeners', () => {
  const doc = copy(historical);
  const count = () => doc._observers.get('update')?.size ?? 0;
  const initial = count();
  const finished = captureDocUpdate(doc);
  assert.equal(count(), initial + 1);
  finished.finish();
  assert.equal(count(), initial);
  const failed = captureDocUpdate(doc);
  try {
    doc.getMap('data').set('uncommitted', true);
    throw new Error('operation failed before push');
  } catch {
    failed.dispose();
  }
  assert.equal(count(), initial);
  assert.throws(() => failed.finish(), /disposed/);
  const pending = captureDocUpdate(doc);
  doc.destroy();
  assert.equal(count(), 0);
  assert.throws(() => pending.finish(), /disposed/);
});

function socketFor(root, { failFirst = false } = {}) {
  const updates = [];
  let timestamp = 10000, failed = false;
  return {
    updates,
    socket: {
      emit(event, payload, ack) {
        if (event === 'space:load-doc') {
          ack({ data: { missing: Buffer.from(Y.encodeStateAsUpdate(root)).toString('base64') } });
          return;
        }
        assert.equal(event, 'space:push-doc-update');
        if (payload.docId !== 'workspace') { ack({ data: { timestamp: ++timestamp } }); return; }
        const update = Buffer.from(payload.update, 'base64');
        updates.push(update);
        if (failFirst && !failed) {
          failed = true;
          // Another writer can change the base before the retry reloads it.
          root.getMap('data').set('concurrent', 'preserved');
          ack({ error: { message: 'Too many concurrent writings' } });
          return;
        }
        Y.applyUpdate(root, update);
        ack({ data: { timestamp } });
      },
    },
  };
}
const pageDoc = new Y.Doc();
pageDoc.getText('content').insert(0, 'changed');
const pageUpdate = Buffer.from(Y.encodeStateAsUpdate(pageDoc)).toString('base64');
pageDoc.destroy();

test('production page timestamp writes stay bounded across a large deletion history', async () => {
  const root = copy(historical);
  const { socket, updates } = socketFor(root);
  const snapshotSize = Y.encodeStateAsUpdate(root).length;
  for (let i = 0; i < 40; i++) await pushPageDocUpdate(socket, 'workspace', 'page', pageUpdate);
  assert.equal(updates.length, 40);
  assert(updates.every(update => update.length < 100), `root deltas: ${updates.map(u => u.length)}`);
  assert.equal(root.getMap('meta').get('pages').get(0).get('updatedDate'), 10040);
  assert.equal(root.getMap('data').get('deleteMe'), 'original');
  assert.equal(root.getMap('history').get('value'), 1200);
  assert(Y.encodeStateAsUpdate(root).length >= snapshotSize, 'we avoid replay; we do not compact server history');
  root.destroy();
});

test('production timestamp retry reloads state and sends only its successful local transaction', async () => {
  const root = copy(historical);
  const { socket, updates } = socketFor(root, { failFirst: true });
  await pushPageDocUpdate(socket, 'workspace', 'page', pageUpdate);
  assert.equal(updates.length, 2);
  assert(updates.every(update => update.length < 100));
  assert.equal(root.getMap('data').get('concurrent'), 'preserved');
  assert.equal(root.getMap('meta').get('pages').get(0).get('updatedDate'), 10001);
  root.destroy();
});

process.on('exit', () => historical.destroy());

function singleDocSocket(doc, docId) {
  const updates = [];
  return {
    updates,
    socket: {
      emit(event, payload, ack) {
        assert.equal(payload.docId, docId);
        if (event === 'space:load-doc') {
          ack({ data: { missing: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') } });
          return;
        }
        assert.equal(event, 'space:push-doc-update');
        const update = Buffer.from(payload.update, 'base64');
        updates.push(update);
        Y.applyUpdate(doc, update);
        ack({ data: { timestamp: 10000 } });
      },
    },
  };
}

test('production creator and icon subdocument writes omit unrelated historical deletions', async () => {
  const properties = copy(historical), icons = copy(historical);
  const propsConnection = singleDocSocket(properties, docPropertiesDocId('workspace'));
  await ensureDocumentCreator(propsConnection.socket, 'workspace', 'page', 'user-id');
  assert.equal(properties.getMap('page').get('createdBy'), 'user-id');
  assert.equal(properties.getMap('page').get('id'), 'page');
  assert(propsConnection.updates.every(u => u.length < 200));
  const iconConnection = singleDocSocket(icons, explorerIconDocId('workspace'));
  await setExplorerIcon(iconConnection.socket, 'workspace', 'doc:page', { type: 'emoji', unicode: '★' });
  await setExplorerIcon(iconConnection.socket, 'workspace', 'doc:page', null);
  assert.equal(icons.getMap('doc:page').has('icon'), false);
  assert.equal(icons.getMap('doc:page').get('id'), 'doc:page');
  assert(iconConnection.updates.every(u => u.length < 200));
  assert.equal(Y.decodeUpdate(iconConnection.updates[1]).structs.length, 0, 'clearing an icon is deletion-only');
  properties.destroy(); icons.destroy();
});

test('production trash and restore retain canonical metadata without resending root history', async () => {
  const root = copy(historical);
  const { socket, updates } = singleDocSocket(root, 'workspace');
  await setDocTrashState(socket, 'workspace', 'page', true);
  await setDocTrashState(socket, 'workspace', 'page', false);
  const page = root.getMap('meta').get('pages').get(0);
  assert.equal(page.get('trash'), false);
  assert.equal(page.has('trashDate'), false);
  assert.equal(updates.length, 2);
  assert(updates.every(u => u.length < 200));
  assert.equal(root.getMap('history').get('value'), 1200);
  root.destroy();
});

test('production organize link writes use deltas rather than full folder snapshots', async () => {
  const folders = copy(historical);
  const parent = folders.getMap('folder');
  for (const [key, value] of Object.entries({ id: 'folder', type: 'folder', data: 'Folder', parentId: null, index: 'a0' })) parent.set(key, value);
  const { socket, updates } = singleDocSocket(folders, 'db$workspace$folders');
  const result = await addOrganizeLinkToFolder(socket, 'workspace', { folderId: 'folder', type: 'doc', targetId: 'page' });
  assert.equal(folders.getMap(result.id).get('data'), 'page');
  assert.equal(updates.length, 1);
  assert(updates[0].length < 500);
  assert.equal(folders.getMap('history').get('value'), 1200);
  folders.destroy();
});
