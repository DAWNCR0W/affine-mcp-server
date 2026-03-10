#!/usr/bin/env node
/**
 * Focused integration test for database schema discovery on empty databases.
 *
 * Verifies that `read_database_columns` returns column metadata before any row
 * exists, so agents can discover schema without relying on cell data.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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

async function main() {
  console.log('=== Database Schema Integration Test ===');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Server: ${MCP_SERVER_PATH}`);
  console.log();

  const client = new Client({ name: 'affine-mcp-db-schema-test', version: '1.0.0' });
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

  try {
    const tools = await client.listTools();
    if (!tools.tools.some(tool => tool.name === 'read_database_columns')) {
      throw new Error('Expected tool "read_database_columns" to be registered');
    }

    const workspace = await call('create_workspace', { name: `db-schema-test-${Date.now()}` });
    const workspaceId = workspace?.id;
    if (!workspaceId) throw new Error('create_workspace did not return workspace id');

    const doc = await call('create_doc', {
      workspaceId,
      title: 'Database Schema Test',
      content: '',
    });
    const docId = doc?.docId;
    if (!docId) throw new Error('create_doc did not return docId');

    const dbBlock = await call('append_block', {
      workspaceId,
      docId,
      type: 'database',
    });
    const databaseBlockId = dbBlock?.blockId;
    if (!databaseBlockId) throw new Error('append_block(database) did not return blockId');
    await settle();

    const columnDefinitions = [
      { name: 'Name', type: 'rich-text' },
      { name: 'Status', type: 'select', options: ['Todo', 'Doing', 'Done'] },
      { name: 'Estimate', type: 'number' },
    ];

    const expectedColumnIds = new Map();
    for (const column of columnDefinitions) {
      const result = await call('add_database_column', {
        workspaceId,
        docId,
        databaseBlockId,
        name: column.name,
        type: column.type,
        ...(column.options ? { options: column.options } : {}),
      });
      expectTruthy(result?.columnId, `${column.name} columnId`);
      expectedColumnIds.set(column.name, result.columnId);
      await settle();
    }

    const schema = await call('read_database_columns', {
      workspaceId,
      docId,
      databaseBlockId,
    });
    expectEqual(schema?.databaseBlockId, databaseBlockId, 'schema databaseBlockId');
    expectEqual(schema?.rowCount, 0, 'schema rowCount');
    expectEqual(schema?.columnCount, 3, 'schema columnCount');
    expectEqual(schema?.titleColumnId, null, 'schema titleColumnId');
    expectTruthy(Array.isArray(schema?.columns), 'schema columns array');
    expectTruthy(Array.isArray(schema?.views), 'schema views array');
    expectTruthy(schema.views.length >= 1, 'schema view count');

    const schemaByName = new Map(schema.columns.map(column => [column.name, column]));
    for (const column of columnDefinitions) {
      const schemaColumn = schemaByName.get(column.name);
      if (!schemaColumn) {
        throw new Error(`Schema missing column ${column.name}`);
      }
      expectEqual(schemaColumn.id, expectedColumnIds.get(column.name), `${column.name} schema columnId`);
      expectEqual(schemaColumn.type, column.type, `${column.name} schema type`);
      if (column.type === 'select') {
        expectEqual(schemaColumn.options.length, column.options.length, `${column.name} options length`);
        expectEqual(schemaColumn.options[0].value, column.options[0], `${column.name} first option`);
      } else {
        expectEqual(schemaColumn.options.length, 0, `${column.name} options length`);
      }
    }

    const tableView = schema.views.find(view => view.mode === 'table');
    if (!tableView) {
      throw new Error('Schema missing table view');
    }
    expectEqual(tableView.columnIds.length, 3, 'table view column count');
    for (const column of columnDefinitions) {
      if (!tableView.columnIds.includes(expectedColumnIds.get(column.name))) {
        throw new Error(`Table view missing column ${column.name}`);
      }
    }

    const cells = await call('read_database_cells', {
      workspaceId,
      docId,
      databaseBlockId,
    });
    expectEqual(cells?.rows?.length, 0, 'read_database_cells empty row count');

    console.log();
    console.log('=== Database schema integration test passed ===');
  } finally {
    await transport.close();
  }
}

main().catch(err => {
  console.error();
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
