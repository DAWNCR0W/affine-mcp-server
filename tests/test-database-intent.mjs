#!/usr/bin/env node
import { testResourceName, testTempPath } from './require-destructive-test-safety.mjs';

/**
 * Focused integration test for intent-driven database composition.
 *
 * Verifies that compose_database_from_intent can build useful task board and
 * issue tracker presets and custom tables, preserves native number defaults,
 * adds atomic row batches, and leaves backend content unchanged on invalid input.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as Y from 'yjs';
import { acquireCredentials, ensureAdminUser, waitForHealthy } from './acquire-credentials.mjs';
import { connectWorkspaceSocket, joinWorkspace, loadDoc, wsUrlFromGraphQLEndpoint } from '../dist/ws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');

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

function expectEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expectTruthy(value, message) {
  if (!value) {
    throw new Error(`${message}: expected truthy value, got ${JSON.stringify(value)}`);
  }
}

function expectArray(value, message) {
  if (!Array.isArray(value)) {
    throw new Error(`${message}: expected array, got ${JSON.stringify(value)}`);
  }
}

function expectIncludes(values, expected, message) {
  if (!values.includes(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)} in ${JSON.stringify(values)}`);
  }
}

async function main() {
  console.log('=== Intent-Driven Database Builder Test ===');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Server: ${MCP_SERVER_PATH}`);
  console.log();

  console.log('Preparing AFFiNE credentials...');
  await waitForHealthy(BASE_URL, 60, 5000, 3000);
  await ensureAdminUser(BASE_URL, EMAIL, PASSWORD);
  const auth = await acquireCredentials(BASE_URL, EMAIL, PASSWORD);
  console.log('Credentials acquired.');
  console.log();

  const client = new Client({ name: 'affine-mcp-database-intent-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, '..'),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_COOKIE: auth.cookie,
      XDG_CONFIG_HOME: testTempPath('database-intent-config'),
    },
    stderr: 'pipe',
  });

  transport.stderr?.on('data', chunk => {
    process.stderr.write(`[mcp-server] ${chunk}`);
  });

  const settle = (ms = 1000) => new Promise(resolve => setTimeout(resolve, ms));

  async function call(toolName, args = {}) {
    console.log(`  → ${toolName}(${JSON.stringify(args)})`);
    const result = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: TOOL_TIMEOUT_MS },
    );
    if (result?.isError) {
      throw new Error(`${toolName} MCP error: ${result?.content?.[0]?.text || 'unknown'}`);
    }
    const parsed = parseContent(result);
    if (parsed && typeof parsed === 'object' && parsed.error) {
      throw new Error(`${toolName} failed: ${parsed.error}`);
    }
    console.log('    ✓ OK');
    return parsed;
  }

  async function inspectDocument(workspaceId, docId, inspect) {
    const socket = await connectWorkspaceSocket(wsUrlFromGraphQLEndpoint(`${BASE_URL}/graphql`), auth.cookie);
    const doc = new Y.Doc();
    try {
      await joinWorkspace(socket, workspaceId);
      const snapshot = await loadDoc(socket, workspaceId, docId);
      assert.ok(snapshot.missing, 'backend document snapshot must exist');
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, 'base64'));
      return inspect(doc.getMap('blocks'));
    } finally {
      doc.destroy();
      socket.disconnect();
    }
  }

  async function backendBlockCounts(workspaceId, docId) {
    return inspectDocument(workspaceId, docId, blocks => ({
      blocks: blocks.size,
      databases: [...blocks.values()].filter(block => block.get('sys:flavour') === 'affine:database').length,
    }));
  }

  async function rejectWithoutBackendBlocks(toolName, args, pattern) {
    const before = await backendBlockCounts(args.workspaceId, args.docId);
    await assert.rejects(call(toolName, args), pattern);
    assert.deepEqual(await backendBlockCounts(args.workspaceId, args.docId), before,
      `${toolName}: invalid input must not persist database or row blocks`);
  }

  async function validateCustomTable(workspaceId) {
    const doc = await call('create_doc', { workspaceId, title: 'Custom Table Intent Doc', content: '' });
    const args = { workspaceId, docId: doc.docId, intent: 'table' };
    const columns = [{ name: 'Status', type: 'select', options: ['Todo'] }, { name: 'Estimate', type: 'number' }];
    await rejectWithoutBackendBlocks('compose_database_from_intent', {
      ...args, columns: [{ name: 'Title', type: 'rich-text' }], seedRows: [],
    }, /Column 'Title' already exists/);
    await rejectWithoutBackendBlocks('compose_database_from_intent', {
      ...args, columns,
      seedRows: [{ title: 'Must roll back', Status: 'Discarded option', Estimate: 1 }, { title: 'Invalid', Estimate: 'not-a-number' }],
    }, /expected a number/);

    const table = await call('compose_database_from_intent', {
      ...args, title: 'Custom Tasks', columns, seedRows: [{ title: 'First task', Status: 'Todo', Estimate: 42 }],
    });
    assert.equal(table.views[0].mode, 'table');
    assert.equal(table.stats.seededRowCount, 1);
    assert.deepEqual(table.columns.map(column => column.name), ['Title', 'Status', 'Estimate']);
    const databaseArgs = { workspaceId, docId: doc.docId, databaseBlockId: table.databaseBlockId };
    async function assertNumberDefaults() {
      const data = await inspectDocument(workspaceId, doc.docId, blocks => {
        const database = [...blocks.values()].find(block => block.get('sys:id') === table.databaseBlockId);
        assert.ok(database instanceof Y.Map, 'custom database must exist in the backend snapshot');
        const estimate = database.get('prop:columns').toArray().find(column => column.get('name') === 'Estimate');
        assert.ok(estimate instanceof Y.Map, 'number column must exist in the backend snapshot');
        const propertyData = estimate.get('data');
        return propertyData instanceof Y.Map ? propertyData.toJSON() : propertyData;
      });
      assert.deepEqual(data, { decimal: 0, format: 'number' }, 'custom number columns must retain native property defaults');
    }
    await assertNumberDefaults();
    const revision = (await call('read_doc', { workspaceId, docId: doc.docId })).revision;
    const batch = await call('add_database_rows', {
      ...databaseArgs, expectedRevision: revision,
      rows: [{ cells: { title: 'Second task', Status: 'Done', Estimate: 7 } }, { cells: { title: 'Third task', Status: 'Done', Estimate: 0 } }],
    });
    assert.equal(batch.added, 2);
    const rows = (await call('read_database_cells', databaseArgs)).rows;
    assert.deepEqual(rows.map(row => row.rowBlockId), [...table.rowBlockIds, ...batch.rowBlockIds]);
    assert.deepEqual(rows.map(row => [row.title, row.cells.Estimate.value, row.cells.Status.value]), [
      ['First task', 42, 'Todo'], ['Second task', 7, 'Done'], ['Third task', 0, 'Done'],
    ]);
    await assertNumberDefaults();
    const statusOptions = async () => (await call('read_database_columns', databaseArgs)).columns
      .find(column => column.name === 'Status').options.map(option => option.value).sort();
    assert.deepEqual(await statusOptions(), ['Done', 'Todo'], 'batch rows must reuse newly created select options');
    await rejectWithoutBackendBlocks('add_database_rows', {
      ...databaseArgs,
      rows: [{ cells: { title: 'Must roll back', Status: 'Rollback option', Estimate: 1 } }, { cells: { Estimate: 'invalid' } }],
    }, /expected a number/);
    assert.deepEqual(await statusOptions(), ['Done', 'Todo'], 'failed batches must not persist select options');
    await rejectWithoutBackendBlocks('add_database_rows', {
      ...databaseArgs, expectedRevision: revision, rows: [{ cells: { title: 'Stale request' } }],
    }, /STALE_DOCUMENT_REVISION/);
  }

  async function validateIntentBoard({
    workspaceId,
    docId,
    intent,
    title,
    expectedViewName,
    expectedStatusOptions,
    expectedRowTitles,
    expectedExtraColumns,
  }) {
    const receipt = await call('compose_database_from_intent', {
      workspaceId,
      docId,
      intent,
      title,
    });

    expectEqual(receipt?.intent, intent, `${intent} receipt intent`);
    expectTruthy(receipt?.databaseBlockId, `${intent} receipt databaseBlockId`);
    expectTruthy(receipt?.primaryViewId, `${intent} receipt primaryViewId`);
    expectArray(receipt?.columnIds, `${intent} receipt columnIds`);
    expectArray(receipt?.viewIds, `${intent} receipt viewIds`);
    expectArray(receipt?.rowBlockIds, `${intent} receipt rowBlockIds`);
    expectArray(receipt?.columns, `${intent} receipt columns`);
    expectArray(receipt?.views, `${intent} receipt views`);
    expectArray(receipt?.warnings, `${intent} receipt warnings`);
    expectEqual(receipt?.lossy, false, `${intent} receipt lossy`);

    await settle();

    const schema = await call('read_database_columns', {
      workspaceId,
      docId,
      databaseBlockId: receipt.databaseBlockId,
    });

    expectEqual(schema?.databaseBlockId, receipt.databaseBlockId, `${intent} schema databaseBlockId`);
    expectEqual(schema?.rowCount, 3, `${intent} schema rowCount`);
    expectEqual(schema?.columnCount, 6, `${intent} schema columnCount`);
    expectEqual(schema?.views?.length, 1, `${intent} schema view count`);

    const view = schema.views[0];
    expectEqual(view.mode, 'kanban', `${intent} schema view mode`);
    expectEqual(view.name, expectedViewName, `${intent} schema view name`);

    const statusColumn = schema.columns.find(column => column.name === 'Status');
    expectTruthy(statusColumn, `${intent} status column`);
    expectEqual(statusColumn.type, 'select', `${intent} status column type`);
    expectEqual(statusColumn.options.length, expectedStatusOptions.length, `${intent} status option count`);
    expectedStatusOptions.forEach(option => {
      expectIncludes(statusColumn.options.map(entry => entry.value), option, `${intent} status option`);
    });

    expectedExtraColumns.forEach(({ name, type }) => {
      const column = schema.columns.find(entry => entry.name === name);
      expectTruthy(column, `${intent} ${name} column`);
      expectEqual(column.type, type, `${intent} ${name} type`);
    });

    const rows = await call('read_database_cells', {
      workspaceId,
      docId,
      databaseBlockId: receipt.databaseBlockId,
    });
    expectEqual(rows?.rows?.length, 3, `${intent} row count`);
    expectedRowTitles.forEach(rowTitle => {
      if (!rows.rows.some(row => row.title === rowTitle)) {
        throw new Error(`${intent} expected row title not found: ${rowTitle}`);
      }
    });

    const firstRow = rows.rows.find(row => row.title === expectedRowTitles[0]);
    expectTruthy(firstRow, `${intent} first row`);
    expectTruthy(firstRow.cells?.Status, `${intent} first row status cell`);
    expectEqual(firstRow.cells.Status.value, expectedStatusOptions[0], `${intent} first row status value`);

    return receipt;
  }

  await client.connect(transport);

  try {
    const workspace = await call('create_workspace', { name: testResourceName('database-intent-test') });
    const workspaceId = workspace?.id;
    expectTruthy(workspaceId, 'create_workspace id');

    const taskBoardDoc = await call('create_doc', {
      workspaceId,
      title: 'Task Board Intent Doc',
      content: '',
    });
    expectTruthy(taskBoardDoc?.docId, 'task board docId');

    const taskBoardReceipt = await validateIntentBoard({
      workspaceId,
      docId: taskBoardDoc.docId,
      intent: 'task_board',
      title: 'Engineering Task Board',
      expectedViewName: 'Task Board',
      expectedStatusOptions: ['Todo', 'In Progress', 'Blocked', 'Done'],
      expectedRowTitles: ['Define the scope', 'Build the first pass', 'Review and ship'],
      expectedExtraColumns: [
        { name: 'Type', type: 'select' },
        { name: 'Priority', type: 'select' },
        { name: 'Owner', type: 'rich-text' },
        { name: 'Due Date', type: 'date' },
      ],
    });
    expectIncludes(taskBoardReceipt.views.map(view => view.name), 'Task Board', 'task board receipt view name');

    const issueTrackerDoc = await call('create_doc', {
      workspaceId,
      title: 'Issue Tracker Intent Doc',
      content: '',
    });
    expectTruthy(issueTrackerDoc?.docId, 'issue tracker docId');

    await validateIntentBoard({
      workspaceId,
      docId: issueTrackerDoc.docId,
      intent: 'issue_tracker',
      title: 'Engineering Issue Tracker',
      expectedViewName: 'Issue Tracker',
      expectedStatusOptions: ['Open', 'In Progress', 'In Review', 'Blocked', 'Resolved', 'Closed'],
      expectedRowTitles: ['Document reproduction steps', 'Fix the regression', 'Verify the release candidate'],
      expectedExtraColumns: [
        { name: 'Type', type: 'select' },
        { name: 'Priority', type: 'select' },
        { name: 'Assignee', type: 'rich-text' },
        { name: 'Due Date', type: 'date' },
      ],
    });

    await validateCustomTable(workspaceId);

    console.log();
    console.log('=== Intent-driven database builder test passed ===');
  } catch (err) {
    console.error();
    console.error(`FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await transport.close();
  }
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
