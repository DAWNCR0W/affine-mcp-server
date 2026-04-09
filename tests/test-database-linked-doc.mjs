#!/usr/bin/env node
/**
 * Integration test for database row linked-doc support.
 *
 * Covers:
 * - `add_database_row` with `linkedDocId` creates a linked-doc reference
 * - `add_database_row` without `linkedDocId` leaves linkedDocId null (backward compat)
 * - `read_database_cells` returns linkedDocId for linked rows
 * - `update_database_cell` can set linkedDocId on an existing row
 * - `update_database_row` can set linkedDocId on an existing row
 * - Overwriting the title with plain text clears the linked-doc reference
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
  try { return JSON.parse(text); } catch { return text; }
}

function assertResult(toolName, result) {
  if (result?.isError) {
    throw new Error(`${toolName} MCP error: ${result?.content?.[0]?.text || 'unknown'}`);
  }
  const parsed = parseContent(result);
  if (parsed && typeof parsed === 'object' && parsed.error) {
    throw new Error(`${toolName} failed: ${parsed.error}`);
  }
  return parsed;
}

function expectEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function main() {
  console.log('=== Database Linked-Doc Integration Test ===');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Server: ${MCP_SERVER_PATH}`);
  console.log();

  const client = new Client({ name: 'affine-mcp-linked-doc-test', version: '1.0.0' });
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

  const settle = (ms = 800) => new Promise(resolve => setTimeout(resolve, ms));

  async function call(toolName, args = {}) {
    console.log(`  -> ${toolName}(${JSON.stringify(args).slice(0, 200)})`);
    const result = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: TOOL_TIMEOUT_MS },
    );
    const parsed = assertResult(toolName, result);
    console.log('     OK');
    return parsed;
  }

  let workspaceId;
  let hostDocId;
  let dbBlockId;
  let targetDocId;

  try {
    await client.connect(transport);
    console.log('MCP client connected.\n');

    // --- Setup: get workspace ---
    console.log('[Setup] Finding workspace...');
    const workspaces = await call('list_workspaces');
    workspaceId = workspaces[0]?.id;
    if (!workspaceId) {
      const workspace = await call('create_workspace', { name: `linked-doc-test-${Date.now()}` });
      workspaceId = workspace?.id;
    }
    if (!workspaceId) throw new Error('No workspace available');
    console.log(`  Workspace: ${workspaceId}\n`);

    // --- Setup: create host doc with a database ---
    console.log('[Setup] Creating host doc with database...');
    const hostDoc = await call('create_doc', { workspaceId, title: 'LinkedDoc Test Host' });
    hostDocId = hostDoc.docId;
    await settle();

    const dbBlock = await call('append_block', {
      workspaceId,
      docId: hostDocId,
      type: 'database',
      text: 'Test DB',
      viewMode: 'table',
    });
    dbBlockId = dbBlock.blockId;

    await call('add_database_column', {
      workspaceId, docId: hostDocId, databaseBlockId: dbBlockId,
      name: 'Status', type: 'select', options: ['Active', 'Archived'],
    });
    await settle();

    // --- Setup: create a target doc to link ---
    console.log('[Setup] Creating target doc...');
    const targetDoc = await call('create_doc', {
      workspaceId,
      title: 'Target Tool Doc',
      content: 'This doc should be linked to a database row.',
    });
    targetDocId = targetDoc.docId;
    await settle();
    console.log(`  Target doc: ${targetDocId}\n`);

    // ====================================================================
    // TEST 1: add_database_row WITH linkedDocId
    // ====================================================================
    console.log('[Test 1] add_database_row with linkedDocId...');
    const row1 = await call('add_database_row', {
      workspaceId, docId: hostDocId, databaseBlockId: dbBlockId,
      cells: { Status: 'Active' },
      linkedDocId: targetDocId,
    });
    expectEqual(row1.added, true, 'Row should be added');
    expectEqual(row1.linkedDocId, targetDocId, 'Response should contain linkedDocId');
    await settle();

    // Verify via read_database_cells
    const cells1 = await call('read_database_cells', {
      workspaceId, docId: hostDocId, databaseBlockId: dbBlockId,
    });
    const linkedRow = cells1.rows.find(r => r.rowBlockId === row1.rowBlockId);
    if (!linkedRow) throw new Error('Linked row not found in read_database_cells');
    expectEqual(linkedRow.linkedDocId, targetDocId, 'read_database_cells should return linkedDocId');
    console.log('  PASS: linked row has correct linkedDocId\n');

    // ====================================================================
    // TEST 2: add_database_row WITHOUT linkedDocId (backward compat)
    // ====================================================================
    console.log('[Test 2] add_database_row without linkedDocId (backward compat)...');
    const row2 = await call('add_database_row', {
      workspaceId, docId: hostDocId, databaseBlockId: dbBlockId,
      cells: { title: 'Plain Row', Status: 'Archived' },
    });
    expectEqual(row2.added, true, 'Plain row should be added');
    expectEqual(row2.linkedDocId, null, 'Response should have null linkedDocId');
    await settle();

    const cells2 = await call('read_database_cells', {
      workspaceId, docId: hostDocId, databaseBlockId: dbBlockId,
    });
    const plainRow = cells2.rows.find(r => r.rowBlockId === row2.rowBlockId);
    if (!plainRow) throw new Error('Plain row not found');
    expectEqual(plainRow.linkedDocId, null, 'Plain row should have null linkedDocId');
    expectEqual(plainRow.title, 'Plain Row', 'Plain row title should be preserved');
    console.log('  PASS: plain row has null linkedDocId, title preserved\n');

    // ====================================================================
    // TEST 3: update_database_cell to SET linkedDocId on a plain row
    // ====================================================================
    console.log('[Test 3] update_database_cell setting linkedDocId...');
    await call('update_database_cell', {
      workspaceId, docId: hostDocId, databaseBlockId: dbBlockId,
      rowBlockId: row2.rowBlockId,
      column: 'Status',
      value: 'Active',
      linkedDocId: targetDocId,
    });
    await settle();

    const cells3 = await call('read_database_cells', {
      workspaceId, docId: hostDocId, databaseBlockId: dbBlockId,
    });
    const updatedRow = cells3.rows.find(r => r.rowBlockId === row2.rowBlockId);
    expectEqual(updatedRow.linkedDocId, targetDocId, 'Row should now have linkedDocId after update_database_cell');
    console.log('  PASS: update_database_cell set linkedDocId\n');

    // ====================================================================
    // TEST 4: update_database_row with linkedDocId
    // ====================================================================
    console.log('[Test 4] update_database_row with linkedDocId...');
    // First create another plain row
    const row3 = await call('add_database_row', {
      workspaceId, docId: hostDocId, databaseBlockId: dbBlockId,
      cells: { title: 'Another Row', Status: 'Archived' },
    });
    await settle();

    await call('update_database_row', {
      workspaceId, docId: hostDocId, databaseBlockId: dbBlockId,
      rowBlockId: row3.rowBlockId,
      cells: { Status: 'Active' },
      linkedDocId: targetDocId,
    });
    await settle();

    const cells4 = await call('read_database_cells', {
      workspaceId, docId: hostDocId, databaseBlockId: dbBlockId,
    });
    const batchUpdated = cells4.rows.find(r => r.rowBlockId === row3.rowBlockId);
    expectEqual(batchUpdated.linkedDocId, targetDocId, 'Row should have linkedDocId after update_database_row');
    console.log('  PASS: update_database_row set linkedDocId\n');

    // ====================================================================
    // TEST 5: Overwriting title with plain text clears linkedDocId
    // ====================================================================
    console.log('[Test 5] Clearing linkedDocId by setting plain title...');
    await call('update_database_cell', {
      workspaceId, docId: hostDocId, databaseBlockId: dbBlockId,
      rowBlockId: row3.rowBlockId,
      column: 'title',
      value: 'Now Plain',
    });
    await settle();

    const cells5 = await call('read_database_cells', {
      workspaceId, docId: hostDocId, databaseBlockId: dbBlockId,
    });
    const clearedRow = cells5.rows.find(r => r.rowBlockId === row3.rowBlockId);
    expectEqual(clearedRow.linkedDocId, null, 'linkedDocId should be null after plain title update');
    expectEqual(clearedRow.title, 'Now Plain', 'Title should be the new plain text');
    console.log('  PASS: plain title update cleared linkedDocId\n');

    // ====================================================================
    console.log('=== ALL TESTS PASSED ===');
  } catch (err) {
    console.error('\n=== TEST FAILED ===');
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    // Cleanup
    try {
      if (hostDocId) await call('delete_doc', { workspaceId, docId: hostDocId }).catch(() => {});
      if (targetDocId) await call('delete_doc', { workspaceId, docId: targetDocId }).catch(() => {});
    } catch { /* best effort */ }
    await client.close();
  }
}

main();
