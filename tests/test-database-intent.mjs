#!/usr/bin/env node
/**
 * Focused integration test for intent-driven database composition.
 *
 * Verifies that compose_database_from_intent can build useful task board and
 * issue tracker presets, returns essential handles, and persists schema + rows.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { acquireCredentials, ensureAdminUser, waitForHealthy } from './acquire-credentials.mjs';

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
      XDG_CONFIG_HOME: '/tmp/affine-mcp-e2e-database-intent-noconfig',
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
    const workspace = await call('create_workspace', { name: `database-intent-test-${Date.now()}` });
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
