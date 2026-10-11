#!/usr/bin/env node
import { testResourceName, testRunId, testTempPath } from './require-destructive-test-safety.mjs';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as Y from 'yjs';

import { acquireCredentials } from './acquire-credentials.mjs';
import { connectWorkspaceSocket, joinWorkspace, loadDoc, pushDocUpdate, wsUrlFromGraphQLEndpoint } from '../dist/ws.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = (process.env.AFFINE_BASE_URL || 'http://localhost:3010').replace(/\/+$/, '');
const email = process.env.AFFINE_ADMIN_EMAIL || process.env.AFFINE_EMAIL || 'test@affine.local';
const password = process.env.AFFINE_ADMIN_PASSWORD || process.env.AFFINE_PASSWORD;
if (!password) throw new Error('AFFINE_ADMIN_PASSWORD is required');
const statePath = path.join(testTempPath('test-artifacts'), 'database-row-creators-state.json');

function parseResult(result) {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return result.structuredContent ?? JSON.parse(result.content?.[0]?.text || 'null');
}

async function graphql(cookie, query, variables = {}) {
  const response = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  assert.equal(response.ok, true, `GraphQL HTTP status ${response.status}`);
  assert.equal(body.errors, undefined, body.errors?.map(error => error.message).join('; '));
  return body.data;
}

async function createEditorAndShare(authorCookie, workspaceId, editorEmail) {
  const created = await graphql(authorCookie, `
    mutation CreateRowEditor($input: CreateUserInput!) {
      createUser(input: $input) { id }
    }
  `, { input: { email: editorEmail, name: 'Row Editor B', password } });
  assert.ok(created.createUser?.id, 'the isolated editor account is created');
  const invited = await graphql(authorCookie, `
    mutation InviteRowEditor($workspaceId: String!, $emails: [String!]!) {
      inviteMembers(workspaceId: $workspaceId, emails: $emails) { email inviteId error }
    }
  `, { workspaceId, emails: [editorEmail] });
  const invitation = invited.inviteMembers?.find(member => member.email === editorEmail);
  assert.ok(invitation?.inviteId, invitation?.error || 'email invitation is missing');
  const editorAuth = await acquireCredentials(baseUrl, editorEmail, password);
  const accepted = await graphql(editorAuth.cookie, `
    mutation AcceptRowInvitation($inviteId: String!) {
      acceptInviteById(inviteId: $inviteId)
    }
  `, { inviteId: invitation.inviteId });
  assert.equal(accepted.acceptInviteById, true, 'B accepts the collaborator invitation');
  return editorAuth;
}

async function connectClient(cookie, label) {
  const transport = new StdioClientTransport({
    command: 'node', args: [path.join(projectRoot, 'dist', 'index.js')], cwd: projectRoot,
    env: { AFFINE_BASE_URL: baseUrl, AFFINE_COOKIE: cookie, XDG_CONFIG_HOME: testTempPath(`row-creator-${label}`) },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', chunk => process.stderr.write(`[mcp-${label}] ${chunk}`));
  const client = new Client({ name: `database-row-creators-${label}`, version: '1.0.0' });
  await client.connect(transport);
  return { transport, call: async (name, args = {}) => parseResult(await client.callTool(
    { name, arguments: args }, undefined, { timeout: 60_000 },
  )) };
}

async function withPage(cookie, workspaceId, docId, callback) {
  const socket = await connectWorkspaceSocket(wsUrlFromGraphQLEndpoint(`${baseUrl}/graphql`), cookie);
  const doc = new Y.Doc();
  try {
    await joinWorkspace(socket, workspaceId);
    const snapshot = await loadDoc(socket, workspaceId, docId);
    assert.equal(typeof snapshot.missing, 'string', 'the persisted page snapshot exists');
    Y.applyUpdate(doc, Buffer.from(snapshot.missing, 'base64'));
    return await callback(doc, socket);
  } finally {
    doc.destroy();
    socket.disconnect();
  }
}

async function addNativeCreatorColumn(cookie, workspaceId, docId, databaseBlockId) {
  return withPage(cookie, workspaceId, docId, async (doc, socket) => {
    const before = Y.encodeStateVector(doc);
    const database = doc.getMap('blocks').get(databaseBlockId);
    const columns = database.get('prop:columns');
    const title = columns.toArray().find(column => column.get('type') === 'title');
    assert.ok(title, 'database has a native title column');
    const creatorColumnId = `creator-${databaseBlockId}`;
    const creator = new Y.Map();
    for (const [key, value] of Object.entries({ id: creatorColumnId, type: 'created-by', name: 'Created by', data: {}, width: 240 })) creator.set(key, value);
    columns.push([creator]);
    const view = database.get('prop:views').get(0);
    view.set('mode', 'table');
    view.set('groupBy', null);
    const visible = new Y.Array();
    for (const id of [title.get('id'), creatorColumnId]) {
      const column = new Y.Map();
      column.set('id', id);
      column.set('hide', false);
      column.set('width', id === creatorColumnId ? 240 : 320);
      visible.push([column]);
    }
    view.set('columns', visible);
    await pushDocUpdate(socket, workspaceId, docId, Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString('base64'));
    return { titleColumnId: title.get('id'), creatorColumnId };
  });
}

async function persistedRows(cookie, workspaceId, docId, rowIds) {
  // Read before a browser opens the page: app-side migration must not create the tested metadata.
  return withPage(cookie, workspaceId, docId, doc => rowIds.map(rowBlockId => {
    const block = doc.getMap('blocks').get(rowBlockId);
    assert.ok(block instanceof Y.Map, `row ${rowBlockId} is persisted`);
    return { rowBlockId, createdBy: block.get('prop:meta:createdBy'), createdAt: block.get('prop:meta:createdAt'), title: block.get('prop:text')?.toString() };
  }));
}

async function main() {
  fs.rmSync(statePath, { force: true });
  const authorAuth = await acquireCredentials(baseUrl, email, password);
  const author = await connectClient(authorAuth.cookie, 'author');
  let editor;
  try {
    const authorUser = await author.call('current_user');
    assert.ok(authorUser.id && authorUser.name, 'author has an identity and a display name');
    const workspace = await author.call('create_workspace', { name: testResourceName('row-creators') });
    const workspaceId = workspace.id;
    const directDoc = await author.call('create_doc', { workspaceId, title: 'Row creation metadata', content: '' });
    const directDatabase = await author.call('append_block', { workspaceId, docId: directDoc.docId, type: 'database', text: 'Direct and generic rows' });
    const directArgs = { workspaceId, docId: directDoc.docId, databaseBlockId: directDatabase.blockId };
    await author.call('add_database_column', { ...directArgs, name: 'Title', type: 'title', width: 320 });
    const earliest = Date.now();
    const direct = await author.call('add_database_row', { ...directArgs, cells: { title: 'Direct row by A' } });
    const appended = await author.call('append_block', { workspaceId, docId: directDoc.docId, type: 'paragraph', text: 'Generic row by A', placement: { parentId: directDatabase.blockId } });
    const markdown = await author.call('append_markdown', { workspaceId, docId: directDoc.docId, markdown: 'Markdown row by A', strict: true, placement: { parentId: directDatabase.blockId } });
    assert.equal(markdown.blockIds.length, 1);
    const composedDoc = await author.call('create_doc', { workspaceId, title: 'Composed row metadata', content: '' });
    const composed = await author.call('compose_database_from_intent', { workspaceId, docId: composedDoc.docId, intent: 'task_board', seedRows: [{ title: 'Composed row by A' }] });
    assert.equal(composed.rowBlockIds.length, 1);
    const pages = [
      { docId: directDoc.docId, databaseBlockId: directDatabase.blockId, rowIds: [direct.rowBlockId, appended.blockId, ...markdown.blockIds] },
      { docId: composedDoc.docId, databaseBlockId: composed.databaseBlockId, rowIds: composed.rowBlockIds },
    ];
    for (const page of pages) {
      page.rows = await persistedRows(authorAuth.cookie, workspaceId, page.docId, page.rowIds);
      for (const row of page.rows) {
        assert.equal(row.createdBy, authorUser.id, `${row.title} creator exists before the UI loads`);
        assert.equal(typeof row.createdAt, 'number');
        assert.ok(row.createdAt >= earliest && row.createdAt <= Date.now(), `${row.title} has the original operation timestamp`);
      }
      Object.assign(page, await addNativeCreatorColumn(authorAuth.cookie, workspaceId, page.docId, page.databaseBlockId));
    }

    const editorEmail = `${testResourceName('row-editor-b')}@affine.local`;
    // The disposable AFFiNE instance supplies signup and email-invitation APIs.
    const editorAuth = await createEditorAndShare(authorAuth.cookie, workspaceId, editorEmail);
    editor = await connectClient(editorAuth.cookie, 'editor');
    const editorUser = await editor.call('current_user');
    assert.notEqual(editorUser.id, authorUser.id, 'editor B is a distinct authenticated account');
    for (const page of pages) {
      await graphql(authorAuth.cookie, `
        mutation GrantRowEditor($input: GrantDocUserRolesInput!) {
          grantDocUserRoles(input: $input)
        }
      `, { input: { workspaceId, docId: page.docId, role: 'Editor', userIds: [editorUser.id] } });
      const permissions = await graphql(editorAuth.cookie, `
        query RowEditorPermissions($workspaceId: String!, $docId: String!) {
          workspace(id: $workspaceId) { doc(docId: $docId) { permissions { Doc_Update } } }
        }
      `, { workspaceId, docId: page.docId });
      assert.equal(permissions.workspace?.doc?.permissions?.Doc_Update, true, 'B can edit the shared page');
    }
    await editor.call('update_database_row', { ...directArgs, rowBlockId: direct.rowBlockId, cells: { title: 'Direct row edited through MCP by B' } });
    const afterMcpEdit = (await persistedRows(editorAuth.cookie, workspaceId, directDoc.docId, [direct.rowBlockId]))[0];
    assert.deepEqual({ createdBy: afterMcpEdit.createdBy, createdAt: afterMcpEdit.createdAt },
      { createdBy: pages[0].rows[0].createdBy, createdAt: pages[0].rows[0].createdAt }, 'MCP row edits by B preserve A and original creation time');
    pages[0].rows[0].title = afterMcpEdit.title;
    const bCreationStarted = Date.now();
    const rowByB = await editor.call('add_database_row', { ...directArgs, cells: { title: 'Fresh row by B' } });
    const bRow = (await persistedRows(editorAuth.cookie, workspaceId, directDoc.docId, [rowByB.rowBlockId]))[0];
    assert.equal(bRow.createdBy, editorUser.id, 'a new MCP session creates rows as B');
    assert.ok(bRow.createdAt >= bCreationStarted && bRow.createdAt <= Date.now());

    fs.writeFileSync(statePath, JSON.stringify({
      runId: testRunId, baseUrl, workspaceId,
      author: { id: authorUser.id, name: authorUser.name },
      editor: { id: editorUser.id, name: editorUser.name },
      editorEmail, pages, bRow,
    }, null, 2), { mode: 0o600 });
    console.log('Database row creator wire checks passed; two-account UI fixture is ready');
  } finally {
    if (editor) await editor.transport.close();
    await author.transport.close();
  }
}

await main();
