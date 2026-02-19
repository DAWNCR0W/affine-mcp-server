#!/usr/bin/env node
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');
const STATE_OUTPUT_PATH = path.resolve(__dirname, 'test-database-state.json');

const BASE_URL = process.env.AFFINE_BASE_URL || 'http://localhost:3010';
const EMAIL = process.env.AFFINE_ADMIN_EMAIL || process.env.AFFINE_EMAIL || 'test@affine.local';
const PASSWORD = process.env.AFFINE_ADMIN_PASSWORD || process.env.AFFINE_PASSWORD || 'TestPass123';
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
      XDG_CONFIG_HOME: '/tmp/affine-mcp-e2e-noconfig',
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

  try {
    // Authentication already happened at startup via AFFINE_LOGIN_AT_START=sync.
    // No explicit sign_in call needed — this test verifies the email/password
    // auto-login path, not the sign_in MCP tool.

    // 1. Create workspace
    const timestamp = Date.now();
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

    // 4. Add columns
    const columnDefs = [
      { name: 'Name', type: 'rich-text' },
      { name: 'Status', type: 'select', options: ['Active', 'Inactive', 'Pending'] },
      { name: 'Priority', type: 'number' },
      { name: 'Done', type: 'checkbox' },
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

    // 5. Add rows
    const rowDefs = [
      { Name: 'Build feature', Status: 'Active', Priority: 1, Done: true },
      { Name: 'Write tests', Status: 'Pending', Priority: 2, Done: false },
      { Name: 'Deploy release', Status: 'Inactive', Priority: 3, Done: false },
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
