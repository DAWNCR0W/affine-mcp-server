import './require-destructive-test-safety.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import * as Y from 'yjs';
import { coordinateTool } from '../dist/toolCoordination.js';
import { documentRevision, isDocumentRegistered } from '../dist/util/documentRevision.js';
import { toolOutputSchemaFor } from '../dist/toolOutputSchemas.js';

const context = { endpoint: 'http://localhost:3010/graphql', workspaceId: 'default-workspace', gql: {} };
const shape = { workspaceId: z.string().optional(), docId: z.string() };
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

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
  for (const name of ['update_block', 'update_table_cell', 'replace_doc_with_markdown', 'move_block', 'reparent_mindmap_node']) {
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

test('independent registrations share workspace coordination, including default ids and workspace deletion', async () => {
  const started = deferred(), release = deferred();
  const events = [];
  const first = coordinateTool('append_block', shape, async () => {
    events.push('write-start'); started.resolve(); await release.promise; events.push('write-end');
  }, context);
  const read = coordinateTool('read_doc', shape, async () => events.push('read'), context);
  const remove = coordinateTool('delete_workspace', { id: z.string() }, async () => events.push('delete'), context);
  const writing = first.handler({ docId: 'doc' });
  await started.promise;
  const reading = read.handler({ workspaceId: context.workspaceId, docId: 'doc' });
  const deleting = remove.handler({ id: context.workspaceId });
  await Promise.resolve();
  assert.deepEqual(events, ['write-start']);
  release.resolve();
  await Promise.all([writing, reading, deleting]);
  assert.deepEqual(events, ['write-start', 'write-end', 'read', 'delete']);
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
