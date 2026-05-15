#!/usr/bin/env node
/**
 * Integration test for create_doc folder placement.
 *
 * Steps:
 *   1. Create workspace
 *   2. Create folder "bar"
 *   3. Create doc "baz" placed in "bar" with folderId
 *   4. Create doc with a missing folderId and verify the failure contract
 *   5. Create folder "foo"
 *   6. Move "bar" into "foo"
 *   7. Verify final tree
 *   8. Clean up workspace
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
if (!PASSWORD) throw new Error('AFFINE_ADMIN_PASSWORD env var required - run: . tests/generate-test-env.sh');
const TOOL_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT_MS || '60000');
const NO_CLEANUP = process.env.NO_CLEANUP === '1' || process.argv.includes('--no-cleanup');

function parseContent(result) {
  const text = result?.content?.[0]?.text;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function expectTruthy(value, message) {
  if (!value) throw new Error(`${message}: expected truthy, got ${JSON.stringify(value)}`);
}

function expectEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expectArray(value, message) {
  if (!Array.isArray(value)) {
    throw new Error(`${message}: expected array, got ${JSON.stringify(value)}`);
  }
}

function expectWarningIncludes(warnings, expected, message) {
  expectArray(warnings, `${message} warnings`);
  if (!warnings.some(warning => typeof warning === 'string' && warning.includes(expected))) {
    throw new Error(`${message}: expected warning containing ${JSON.stringify(expected)}, got ${JSON.stringify(warnings)}`);
  }
}

async function main() {
  console.log('=== Create Doc Folder Placement Test ===');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Server:   ${MCP_SERVER_PATH}`);
  console.log();

  const client = new Client({ name: 'affine-mcp-create-doc-folder-placement', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, '..'),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: 'sync',
      XDG_CONFIG_HOME: '/tmp/affine-mcp-e2e-create-doc-folder-placement-noconfig',
    },
    stderr: 'pipe',
  });

  transport.stderr?.on('data', chunk => process.stderr.write(`[mcp-server] ${chunk}`));

  async function call(toolName, args = {}) {
    console.log(`  -> ${toolName}(${JSON.stringify(args)})`);
    const result = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: TOOL_TIMEOUT_MS },
    );
    if (result?.isError) throw new Error(`${toolName} MCP error: ${result?.content?.[0]?.text || 'unknown'}`);
    const parsed = parseContent(result);
    if (parsed && typeof parsed === 'object' && parsed.error) throw new Error(`${toolName} failed: ${parsed.error}`);
    if (typeof parsed === 'string' && /^(GraphQL error:|Error:|MCP error)/i.test(parsed)) throw new Error(`${toolName} failed: ${parsed}`);
    console.log('    OK');
    return parsed;
  }

  await client.connect(transport);

  let workspaceId;
  try {
    console.log('\n[1] Create workspace');
    const workspace = await call('create_workspace', { name: `folder-placement-${Date.now()}` });
    workspaceId = workspace?.id;
    expectTruthy(workspaceId, 'workspace id');

    console.log('\n[2] Create folder "bar"');
    const bar = await call('create_folder', { workspaceId, name: 'bar' });
    const barFolderId = bar?.id;
    expectTruthy(barFolderId, 'bar folder id');
    expectEqual(bar?.data, 'bar', 'bar folder name');

    console.log('\n[3] Create doc "baz" in folder "bar"');
    const baz = await call('create_doc', { workspaceId, title: 'baz', folderId: barFolderId });
    const bazDocId = baz?.docId;
    expectTruthy(bazDocId, 'baz docId');
    expectEqual(baz?.folderId, barFolderId, 'create_doc folderId');
    expectEqual(baz?.folderLinked, true, 'create_doc folderLinked');
    expectTruthy(baz?.folderNodeId, 'create_doc folderNodeId');
    expectArray(baz?.warnings, 'create_doc warnings');
    expectEqual(baz.warnings.length, 0, 'create_doc warning count');

    console.log('\n[4] Create doc with missing folderId');
    const missingFolderId = `missing-folder-${Date.now()}`;
    const unplaced = await call('create_doc', {
      workspaceId,
      title: 'not placed',
      folderId: missingFolderId,
    });
    const unplacedDocId = unplaced?.docId;
    expectTruthy(unplacedDocId, 'unplaced docId');
    expectEqual(unplaced?.folderId, null, 'unplaced folderId');
    expectEqual(unplaced?.folderLinked, false, 'unplaced folderLinked');
    expectEqual(unplaced?.folderNodeId, null, 'unplaced folderNodeId');
    expectWarningIncludes(
      unplaced?.warnings,
      `Doc created but could not be placed in folder "${missingFolderId}"`,
      'unplaced warning message'
    );
    expectWarningIncludes(
      unplaced?.warnings,
      `Folder '${missingFolderId}' was not found.`,
      'unplaced missing folder warning'
    );

    console.log('\n[5] Create folder "foo"');
    const foo = await call('create_folder', { workspaceId, name: 'foo' });
    const fooFolderId = foo?.id;
    expectTruthy(fooFolderId, 'foo folder id');
    expectEqual(foo?.data, 'foo', 'foo folder name');

    console.log('\n[6] Move "bar" into "foo"');
    const movedBar = await call('move_organize_node', {
      workspaceId,
      nodeId: barFolderId,
      parentId: fooFolderId,
    });
    expectEqual(movedBar?.id, barFolderId, 'moved bar id');
    expectEqual(movedBar?.parentId, fooFolderId, 'bar is now inside foo');

    console.log('\n[7] Verify organize tree');
    const { nodes = [] } = await call('list_organize_nodes', { workspaceId });

    const fooNode = nodes.find(n => n?.id === fooFolderId);
    expectTruthy(fooNode, 'foo node present');
    if (fooNode?.parentId) throw new Error(`foo should be a root folder, got parentId=${fooNode.parentId}`);

    const barNode = nodes.find(n => n?.id === barFolderId);
    expectTruthy(barNode, 'bar node present');
    expectEqual(barNode?.parentId, fooFolderId, 'bar is inside foo');

    const bazNode = nodes.find(n => n?.type === 'doc' && n?.data === bazDocId);
    expectTruthy(bazNode, 'baz doc node present in organize tree');
    expectEqual(bazNode?.parentId, barFolderId, 'baz is inside bar');
    if (nodes.some(n => n?.type === 'doc' && n?.data === unplacedDocId)) {
      throw new Error('unplaced doc should not have an organize link');
    }

    console.log('\nTree confirmed: foo -> bar -> baz');

    console.log('\n[8] Move "baz" to under "foo"');
    const movedBaz = await call('move_organize_node', {
      workspaceId,
      nodeId: bazNode.id,
      parentId: fooFolderId,
    });
    expectEqual(movedBaz?.id, bazNode.id, 'moved baz id');
    expectEqual(movedBaz?.parentId, fooFolderId, 'baz is now inside foo');

    console.log('\n[9] Verify final tree');
    const { nodes: finalNodes = [] } = await call('list_organize_nodes', { workspaceId });

    const finalBarNode = finalNodes.find(n => n?.id === barFolderId);
    expectTruthy(finalBarNode, 'bar still present');
    expectEqual(finalBarNode?.parentId, fooFolderId, 'bar still inside foo');

    const finalBazNode = finalNodes.find(n => n?.id === bazNode.id);
    expectTruthy(finalBazNode, 'baz still present');
    expectEqual(finalBazNode?.parentId, fooFolderId, 'baz is now directly under foo');

    const barChildren = finalNodes.filter(n => n?.parentId === barFolderId);
    if (barChildren.length !== 0) {
      throw new Error(`bar should be empty after moving baz, found ${barChildren.length} child(ren)`);
    }

    console.log('\nTree confirmed: foo -> bar (empty), foo -> baz');

  } finally {
    if (workspaceId && !NO_CLEANUP) {
      console.log('\n[cleanup] Delete workspace');
      await call('delete_workspace', { id: workspaceId }).catch(e => console.warn('  cleanup failed:', e.message));
    } else if (NO_CLEANUP && workspaceId) {
      console.log(`\n[cleanup skipped] workspace ${workspaceId} left intact`);
    }
    await client.close();
  }

  console.log('\n=== All checks passed ===');
}

main().catch(err => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
