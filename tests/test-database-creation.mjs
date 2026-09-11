#!/usr/bin/env node
import { testResourceName, testTempPath } from './require-destructive-test-safety.mjs';

/**
 * E2E test: EMAIL/PASSWORD auth mode.
 *
 * Authenticates via AFFINE_EMAIL + AFFINE_PASSWORD (sync login at startup),
 * then creates workspace → doc → database → columns → rows.
 *
 * Outputs tests/test-database-state.json with all IDs and content for Playwright.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as Y from 'yjs';

import { acquireCredentials } from './acquire-credentials.mjs';
import { connectWorkspaceSocket, joinWorkspace, loadDoc, pushDocUpdate, wsUrlFromGraphQLEndpoint } from '../dist/ws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');
const STATE_OUTPUT_PATH = path.resolve(__dirname, 'test-database-state.json');

const BASE_URL = process.env.AFFINE_BASE_URL || 'http://localhost:3010';
const EMAIL = process.env.AFFINE_ADMIN_EMAIL || process.env.AFFINE_EMAIL || 'test@affine.local';
const PASSWORD = process.env.AFFINE_ADMIN_PASSWORD || process.env.AFFINE_PASSWORD;
if (!PASSWORD) throw new Error('AFFINE_ADMIN_PASSWORD env var required — run: . tests/generate-test-env.sh');
const TOOL_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT_MS || '60000');

function parseContent(result) {
  const text = result?.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function mutateDatabaseViews(workspaceId, docId, databaseBlockId, mutate) {
  const { cookie } = await acquireCredentials(BASE_URL, EMAIL, PASSWORD);
  const socket = await connectWorkspaceSocket(wsUrlFromGraphQLEndpoint(`${BASE_URL}/graphql`), cookie, undefined);
  try {
    await joinWorkspace(socket, workspaceId);
    const snapshot = await loadDoc(socket, workspaceId, docId);
    if (!snapshot.missing) throw new Error(`Document ${docId} not found`);

    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(snapshot.missing, 'base64'));
    const previousState = Y.encodeStateVector(doc);
    const blocks = doc.getMap('blocks');
    let databaseBlock = blocks.get(databaseBlockId);
    if (!(databaseBlock instanceof Y.Map)) {
      for (const block of blocks.values()) {
        if (block instanceof Y.Map && block.get('sys:id') === databaseBlockId) {
          databaseBlock = block;
          break;
        }
      }
    }
    if (!(databaseBlock instanceof Y.Map)) {
      throw new Error(`Database block ${databaseBlockId} not found`);
    }

    const views = databaseBlock.get('prop:views');
    if (!(views instanceof Y.Array)) throw new Error('Database views are not a Y.Array');
    const changed = mutate(views);
    if (changed === 0) throw new Error('Expected database views to change');

    const delta = Y.encodeStateAsUpdate(doc, previousState);
    await pushDocUpdate(socket, workspaceId, docId, Buffer.from(delta).toString('base64'));
  } finally {
    socket.disconnect();
  }
}

async function seedDatabaseViewRepresentations(workspaceId, docId, databaseBlockId) {
  await mutateDatabaseViews(workspaceId, docId, databaseBlockId, views => {
    const yMapHeader = new Y.Map();
    yMapHeader.set('titleColumn', null);
    yMapHeader.set('iconColumn', null);

    const yMapView = new Y.Map();
    yMapView.set('id', `y-map-plain-columns-${databaseBlockId}`);
    yMapView.set('name', 'Y.Map Plain Columns');
    yMapView.set('mode', 'table');
    yMapView.set('columns', []);
    yMapView.set('filter', { type: 'group', op: 'and', conditions: [] });
    yMapView.set('groupBy', null);
    yMapView.set('sort', null);
    yMapView.set('header', yMapHeader);

    const plainView = {
      id: `plain-view-${databaseBlockId}`,
      name: 'Plain Object View',
      mode: 'table',
      columns: [],
      filter: { type: 'group', op: 'and', conditions: [] },
      groupBy: null,
      sort: null,
      header: { titleColumn: null, iconColumn: null },
    };
    views.push([yMapView, plainView]);
    return 2;
  });
}

async function convertDatabaseHeadersToYMaps(workspaceId, docId, databaseBlockId) {
  await mutateDatabaseViews(workspaceId, docId, databaseBlockId, views => {
    let converted = 0;
    views.forEach(view => {
      if (!(view instanceof Y.Map)) return;
      const header = view.get('header');
      if (header instanceof Y.Map) return;
      const yHeader = new Y.Map();
      if (header && typeof header === 'object') {
        for (const [key, value] of Object.entries(header)) {
          yHeader.set(key, value);
        }
      }
      view.set('header', yHeader);
      converted += 1;
    });
    return converted;
  });
}

async function main() {
  console.log('=== MCP Database Creation Test ===');
  console.log(`Auth mode: email/password (sync login at startup)`);
  console.log(`Server: ${MCP_SERVER_PATH}`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Email: ${EMAIL}`);
  console.log();

  const client = new Client({ name: 'affine-mcp-db-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, '..'),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: 'sync',
      // Isolate from local config file (~/.config/affine-mcp/config) which may
      // contain an API token — we want pure email/password auth for this test.
      XDG_CONFIG_HOME: testTempPath('database-creation-config'),
    },
    stderr: 'pipe',
  });

  transport.stderr?.on('data', chunk => {
    process.stderr.write(`[mcp-server] ${chunk}`);
  });

  await client.connect(transport);
  console.log('Connected to MCP server');

  const state = {
    baseUrl: BASE_URL,
    email: EMAIL,
    workspaceId: null,
    workspaceName: null,
    docId: null,
    docTitle: null,
    databaseBlockId: null,
    columns: [],
    rows: [],
  };

  // Small delay to let the server commit Yjs updates between sequential operations
  const settle = (ms = 500) => new Promise(r => setTimeout(r, ms));

  async function call(toolName, args = {}) {
    console.log(`  → ${toolName}(${JSON.stringify(args)})`);
    const result = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: TOOL_TIMEOUT_MS },
    );

    // Check for MCP-level errors (isError flag on the result)
    if (result?.isError) {
      const errText = result?.content?.[0]?.text || 'Unknown MCP error';
      throw new Error(`${toolName} MCP error: ${errText}`);
    }

    const parsed = parseContent(result);

    // Check for application-level errors
    if (parsed && typeof parsed === 'object' && parsed.error) {
      throw new Error(`${toolName} failed: ${parsed.error}`);
    }
    if (typeof parsed === 'string' && /^(GraphQL error:|Error:|MCP error)/i.test(parsed)) {
      throw new Error(`${toolName} failed: ${parsed}`);
    }

    console.log(`    ✓ OK`);
    return parsed;
  }

  function assertDerivedParentIds(readDocPayload, context) {
    const blocks = Array.isArray(readDocPayload?.blocks) ? readDocPayload.blocks : [];
    const expectedParents = new Map();
    for (const parent of blocks) {
      for (const childId of parent?.childIds || []) {
        expectedParents.set(childId, parent.id);
      }
    }
    for (const block of blocks) {
      const expectedParentId = expectedParents.get(block.id) ?? null;
      if (block.parentId !== expectedParentId) {
        throw new Error(
          `${context}: expected parentId=${JSON.stringify(expectedParentId)} for ${block.flavour} block ${block.id}, got ${JSON.stringify(block.parentId)}`
        );
      }
    }
  }

  try {
    // Authentication already happened at startup via AFFINE_LOGIN_AT_START=sync.
    // No explicit sign_in call needed — this test verifies the email/password
    // auto-login path, not the sign_in MCP tool.

    // 1. Create workspace
    const timestamp = testResourceName('run');
    state.workspaceName = `mcp-db-test-${timestamp}`;
    const ws = await call('create_workspace', { name: state.workspaceName });
    state.workspaceId = ws?.id;
    if (!state.workspaceId) throw new Error('create_workspace did not return workspace id');
    console.log(`  Workspace ID: ${state.workspaceId}`);

    // 2. Create doc
    state.docTitle = 'MCP Database Test Doc';
    const doc = await call('create_doc', {
      workspaceId: state.workspaceId,
      title: state.docTitle,
      content: '',
    });
    state.docId = doc?.docId;
    if (!state.docId) throw new Error('create_doc did not return docId');
    console.log(`  Doc ID: ${state.docId}`);

    // read_doc should expose the hierarchy represented by each block's childIds.
    const readAfterCreate = await call('read_doc', {
      workspaceId: state.workspaceId,
      docId: state.docId,
    });
    assertDerivedParentIds(readAfterCreate, 'after create_doc');

    const appendedParagraph = await call('append_block', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      type: 'paragraph',
      text: 'ParentId null structure check',
    });
    if (!appendedParagraph?.blockId) throw new Error('append_block did not return blockId');

    const readAfterAppendParagraph = await call('read_doc', {
      workspaceId: state.workspaceId,
      docId: state.docId,
    });
    assertDerivedParentIds(readAfterAppendParagraph, 'after append_block paragraph');

    const punctuationMarkdown = [
      '- [ ] second item (appended)',
      '- [ ] Call the bank about a refund. notes are elsewhere',
      '- [ ] Cancel the card; try to get the $95 annual fee waived',
      '- [ ] Unlock the spare phone, then check email',
    ].join('\n');
    const markdownDoc = await call('create_doc_from_markdown', {
      workspaceId: state.workspaceId,
      title: 'ParentId Markdown Structure Check',
      markdown: `# Heading from markdown\n\n${punctuationMarkdown}`,
    });
    if (!markdownDoc?.docId) throw new Error('create_doc_from_markdown did not return docId');

    const readMarkdownDoc = await call('read_doc', {
      workspaceId: state.workspaceId,
      docId: markdownDoc.docId,
      includeMarkdown: true,
    });
    assertDerivedParentIds(readMarkdownDoc, 'after create_doc_from_markdown');
    if (!readMarkdownDoc?.markdown?.includes(punctuationMarkdown)) {
      throw new Error(`read_doc over-escaped sentence punctuation: ${JSON.stringify(readMarkdownDoc?.markdown)}`);
    }

    // 3. Create database block
    const dbBlock = await call('append_block', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      type: 'database',
    });
    state.databaseBlockId = dbBlock?.blockId;
    if (!state.databaseBlockId) throw new Error('append_block(database) did not return blockId');
    console.log(`  Database Block ID: ${state.databaseBlockId}`);
    await settle();
    await seedDatabaseViewRepresentations(state.workspaceId, state.docId, state.databaseBlockId);
    await settle();

    // 4. Add columns
    const columnDefs = [
      { name: 'Title', type: 'title' },
      { name: 'Status', type: 'select', options: ['Active', 'Inactive', 'Pending'] },
    ];

    for (const colDef of columnDefs) {
      const colArgs = {
        workspaceId: state.workspaceId,
        docId: state.docId,
        databaseBlockId: state.databaseBlockId,
        name: colDef.name,
        type: colDef.type,
      };
      if (colDef.options) {
        colArgs.options = colDef.options;
      }
      const colResult = await call('add_database_column', colArgs);
      state.columns.push({
        name: colDef.name,
        type: colDef.type,
        columnId: colResult?.columnId || null,
      });
      await settle();
    }

    let duplicateTitleRejected = false;
    try {
      await call('add_database_column', {
        workspaceId: state.workspaceId,
        docId: state.docId,
        databaseBlockId: state.databaseBlockId,
        name: 'Another Title',
        type: 'title',
      });
    } catch (err) {
      if (!String(err?.message || err).includes('already has a title column')) {
        throw err;
      }
      duplicateTitleRejected = true;
    }
    if (!duplicateTitleRejected) {
      throw new Error('add_database_column accepted a second title column');
    }

    await convertDatabaseHeadersToYMaps(state.workspaceId, state.docId, state.databaseBlockId);
    await settle();

    const schema = await call('read_database_columns', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      databaseBlockId: state.databaseBlockId,
    });
    const titleColumn = schema?.columns?.find(column => column.type === 'title');
    const statusColumn = schema?.columns?.find(column => column.name === 'Status');
    if (!titleColumn?.id) throw new Error('read_database_columns did not return a title column');
    if (statusColumn?.type !== 'select') {
      throw new Error('read_database_columns did not return a select Status column');
    }
    if (schema.titleColumnId !== titleColumn.id) {
      throw new Error(`titleColumnId mismatch: expected ${titleColumn.id}, got ${schema.titleColumnId}`);
    }
    if (schema.columnCount !== 2) {
      throw new Error(`expected a minimal two-column database, got ${schema.columnCount} columns`);
    }
    if (!Array.isArray(schema.views) || schema.views.length !== 3) {
      throw new Error(`expected all three database view representations, got ${JSON.stringify(schema.views)}`);
    }
    for (const view of schema.views) {
      if (view.header?.titleColumn !== titleColumn.id) {
        throw new Error(`view ${view.id} is not bound to title column ${titleColumn.id}`);
      }
      if (!view.columnIds?.includes(titleColumn.id) || !view.columnIds?.includes(statusColumn.id)) {
        throw new Error(`view ${view.id} does not expose both minimal database columns`);
      }
    }

    // 5. Add rows
    const rowDefs = [
      { Title: 'Build feature', Status: 'Active' },
      { Title: 'Write tests', Status: 'Pending' },
      { Title: 'Deploy release', Status: 'Inactive' },
    ];

    for (const rowDef of rowDefs) {
      const rowResult = await call('add_database_row', {
        workspaceId: state.workspaceId,
        docId: state.docId,
        databaseBlockId: state.databaseBlockId,
        cells: rowDef,
      });
      state.rows.push({
        cells: rowDef,
        rowId: rowResult?.rowBlockId || null,
      });
      await settle();
    }

    // Write state file
    fs.writeFileSync(STATE_OUTPUT_PATH, JSON.stringify(state, null, 2));
    console.log();
    console.log(`State written to: ${STATE_OUTPUT_PATH}`);
    console.log();
    console.log('=== All database creation steps passed ===');
  } catch (err) {
    console.error();
    console.error(`FAILED: ${err.message}`);
    // Write partial state on failure for debugging
    fs.writeFileSync(STATE_OUTPUT_PATH, JSON.stringify({ ...state, error: err.message }, null, 2));
    process.exit(1);
  } finally {
    await transport.close();
  }
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
