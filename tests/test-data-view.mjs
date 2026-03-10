#!/usr/bin/env node
/**
 * Focused integration test for preset-backed data_view creation.
 *
 * Verifies that append_block(type="data_view") creates an AFFiNE database block
 * configured as a kanban view with title + status columns and that row writes
 * work through the existing database tools.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');
const STATE_OUTPUT_PATH = path.resolve(__dirname, 'test-data-view-state.json');

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

async function main() {
  console.log('=== Data View Integration Test ===');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Server: ${MCP_SERVER_PATH}`);
  console.log();

  const client = new Client({ name: 'affine-mcp-data-view-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, '..'),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: 'sync',
      XDG_CONFIG_HOME: '/tmp/affine-mcp-e2e-noconfig',
    },
    stderr: 'pipe',
  });

  transport.stderr?.on('data', chunk => {
    process.stderr.write(`[mcp-server] ${chunk}`);
  });

  const settle = (ms = 800) => new Promise(resolve => setTimeout(resolve, ms));

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

  await client.connect(transport);

  const state = {
    baseUrl: BASE_URL,
    email: EMAIL,
    workspaceId: null,
    docId: null,
    dataViewBlockId: null,
    groupLabels: ['Todo', 'In Progress'],
    rowTitles: ['Card Alpha', 'Card Beta'],
  };

  try {
    const workspace = await call('create_workspace', { name: `data-view-test-${Date.now()}` });
    state.workspaceId = workspace?.id;
    if (!state.workspaceId) throw new Error('create_workspace did not return workspace id');

    const doc = await call('create_doc', {
      workspaceId: state.workspaceId,
      title: 'Data View Test',
      content: '',
    });
    state.docId = doc?.docId;
    if (!state.docId) throw new Error('create_doc did not return docId');

    const dataView = await call('append_block', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      type: 'data_view',
      text: 'Kanban Data View',
    });
    state.dataViewBlockId = dataView?.blockId;
    if (!state.dataViewBlockId) throw new Error('append_block(data_view) did not return blockId');
    expectEqual(dataView?.flavour, 'affine:database', 'data_view flavour');
    expectEqual(dataView?.type, 'data_view_kanban', 'data_view returned type');
    expectEqual(dataView?.normalizedType, 'data_view', 'data_view normalizedType');
    await settle();

    const schema = await call('read_database_columns', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      databaseBlockId: state.dataViewBlockId,
    });

    expectEqual(schema?.columnCount, 2, 'data_view column count');
    expectEqual(schema?.rowCount, 0, 'data_view initial row count');
    expectTruthy(Array.isArray(schema?.columns), 'data_view columns array');
    expectTruthy(Array.isArray(schema?.views), 'data_view views array');
    expectEqual(schema.views.length, 1, 'data_view view count');

    const titleColumn = schema.columns.find(column => column.type === 'title');
    const statusColumn = schema.columns.find(column => column.name === 'Status');
    expectTruthy(titleColumn, 'data_view title column');
    expectTruthy(statusColumn, 'data_view status column');
    expectEqual(statusColumn.type, 'select', 'data_view status column type');
    expectEqual(statusColumn.options.length, 3, 'data_view status option count');
    expectEqual(statusColumn.options[0].value, 'Todo', 'data_view first status option');

    const kanbanView = schema.views[0];
    expectEqual(kanbanView.mode, 'kanban', 'data_view initial view mode');
    expectEqual(kanbanView.name, 'Kanban View', 'data_view initial view name');
    expectEqual(kanbanView.header.titleColumn, titleColumn.id, 'data_view title column header binding');
    expectEqual(kanbanView.header.iconColumn, 'type', 'data_view icon column header binding');
    expectEqual(kanbanView.groupBy?.columnId, statusColumn.id, 'data_view groupBy column');
    expectEqual(kanbanView.groupBy?.name, 'select', 'data_view groupBy property type');

    await call('add_database_row', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      databaseBlockId: state.dataViewBlockId,
      cells: {
        Title: 'Card Alpha',
        Status: 'Todo',
      },
    });
    await settle(1200);

    await call('add_database_row', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      databaseBlockId: state.dataViewBlockId,
      cells: {
        Title: 'Card Beta',
        Status: 'In Progress',
      },
    });
    await settle(1200);

    const rows = await call('read_database_cells', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      databaseBlockId: state.dataViewBlockId,
    });
    expectEqual(rows?.rows?.length, 2, 'data_view row count after inserts');
    expectTruthy(rows.rows.some(row => row.title === 'Card Alpha'), 'data_view row title Card Alpha');
    expectTruthy(rows.rows.some(row => row.title === 'Card Beta'), 'data_view row title Card Beta');

    fs.writeFileSync(STATE_OUTPUT_PATH, JSON.stringify(state, null, 2));
    console.log();
    console.log(`State written to: ${STATE_OUTPUT_PATH}`);
    console.log('=== Data view integration test passed ===');
  } catch (err) {
    fs.writeFileSync(STATE_OUTPUT_PATH, JSON.stringify({ ...state, error: err.message }, null, 2));
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
