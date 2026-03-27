#!/usr/bin/env node
/**
 * Integration test for sidebar-oriented tooling:
 * - collection CRUD / allow-list updates
 * - experimental organize folder/link CRUD
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

function expectArray(value, message) {
  if (!Array.isArray(value)) {
    throw new Error(`${message}: expected array, got ${JSON.stringify(value)}`);
  }
}

async function main() {
  console.log('=== Organize Tools Integration Test ===');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Server: ${MCP_SERVER_PATH}`);
  console.log();

  const client = new Client({ name: 'affine-mcp-organize-tools-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, '..'),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: 'sync',
      XDG_CONFIG_HOME: '/tmp/affine-mcp-e2e-organize-tools-noconfig',
    },
    stderr: 'pipe',
  });

  transport.stderr?.on('data', chunk => {
    process.stderr.write(`[mcp-server] ${chunk}`);
  });

  async function call(toolName, args = {}) {
    console.log(`  → ${toolName}(${JSON.stringify(args)})`);
    const result = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: TOOL_TIMEOUT_MS }
    );
    if (result?.isError) {
      throw new Error(`${toolName} MCP error: ${result?.content?.[0]?.text || 'unknown'}`);
    }
    const parsed = parseContent(result);
    if (parsed && typeof parsed === 'object' && parsed.error) {
      throw new Error(`${toolName} failed: ${parsed.error}`);
    }
    if (typeof parsed === 'string' && /^(GraphQL error:|Error:|MCP error)/i.test(parsed)) {
      throw new Error(`${toolName} failed: ${parsed}`);
    }
    console.log('    ✓ OK');
    return parsed;
  }

  await client.connect(transport);

  try {
    const timestamp = Date.now();
    const workspace = await call('create_workspace', { name: `organize-tools-${timestamp}` });
    const workspaceId = workspace?.id;
    expectTruthy(workspaceId, 'create_workspace id');

    const parentDoc = await call('create_doc', {
      workspaceId,
      title: 'Organize Parent Doc',
      content: 'organize parent body',
    });
    const parentDocId = parentDoc?.docId;
    expectTruthy(parentDocId, 'create_doc parent docId');

    const childDoc = await call('create_doc', {
      workspaceId,
      title: 'Organize Child Doc',
      content: 'organize child body',
    });
    const childDocId = childDoc?.docId;
    expectTruthy(childDocId, 'create_doc child docId');

    const collection = await call('create_collection', {
      workspaceId,
      name: 'Sidebar Collection',
    });
    const collectionId = collection?.id;
    expectTruthy(collectionId, 'create_collection id');
    expectEqual(collection?.name, 'Sidebar Collection', 'create_collection name');

    const collectionsAfterCreate = await call('list_collections', { workspaceId });
    expectArray(collectionsAfterCreate, 'list_collections');
    if (!collectionsAfterCreate.some(entry => entry?.id === collectionId)) {
      throw new Error('list_collections did not include created collection');
    }

    const gotCollection = await call('get_collection', { workspaceId, collectionId });
    expectEqual(gotCollection?.id, collectionId, 'get_collection id');
    expectEqual(gotCollection?.name, 'Sidebar Collection', 'get_collection name');

    const updatedCollection = await call('update_collection', {
      workspaceId,
      collectionId,
      name: 'Sidebar Collection Renamed',
    });
    expectEqual(updatedCollection?.name, 'Sidebar Collection Renamed', 'update_collection name');

    const withParentDoc = await call('add_doc_to_collection', {
      workspaceId,
      collectionId,
      docId: parentDocId,
    });
    expectArray(withParentDoc?.allowList, 'add_doc_to_collection allowList');
    if (!withParentDoc.allowList.includes(parentDocId)) {
      throw new Error('add_doc_to_collection did not include parent doc');
    }

    const withBothDocs = await call('add_doc_to_collection', {
      workspaceId,
      collectionId,
      docId: childDocId,
    });
    if (!withBothDocs.allowList.includes(childDocId)) {
      throw new Error('add_doc_to_collection did not include child doc');
    }

    const removedChildDoc = await call('remove_doc_from_collection', {
      workspaceId,
      collectionId,
      docId: childDocId,
    });
    if (removedChildDoc.allowList.includes(childDocId)) {
      throw new Error('remove_doc_from_collection did not remove child doc');
    }

    const rootFolder = await call('create_folder', {
      workspaceId,
      name: 'Root Folder',
    });
    const rootFolderId = rootFolder?.id;
    expectTruthy(rootFolderId, 'create_folder root id');

    const childFolder = await call('create_folder', {
      workspaceId,
      name: 'Child Folder',
      parentId: rootFolderId,
    });
    const childFolderId = childFolder?.id;
    expectTruthy(childFolderId, 'create_folder child id');
    expectEqual(childFolder?.parentId, rootFolderId, 'create_folder child parentId');

    const organizeLink = await call('add_organize_link', {
      workspaceId,
      folderId: rootFolderId,
      type: 'doc',
      targetId: parentDocId,
    });
    const organizeLinkId = organizeLink?.id;
    expectTruthy(organizeLinkId, 'add_organize_link id');
    expectEqual(organizeLink?.data, parentDocId, 'add_organize_link target');

    const organizeNodes = await call('list_organize_nodes', { workspaceId });
    expectArray(organizeNodes?.nodes, 'list_organize_nodes nodes');
    if (!organizeNodes.nodes.some(node => node?.id === rootFolderId && node?.type === 'folder')) {
      throw new Error('list_organize_nodes did not include root folder');
    }
    if (!organizeNodes.nodes.some(node => node?.id === organizeLinkId && node?.type === 'doc')) {
      throw new Error('list_organize_nodes did not include doc link');
    }

    const renamedFolder = await call('rename_folder', {
      workspaceId,
      folderId: rootFolderId,
      name: 'Root Folder Renamed',
    });
    expectEqual(renamedFolder?.name, 'Root Folder Renamed', 'rename_folder name');

    const movedLink = await call('move_organize_node', {
      workspaceId,
      nodeId: organizeLinkId,
      parentId: childFolderId,
    });
    expectEqual(movedLink?.parentId, childFolderId, 'move_organize_node parentId');

    const deletedLink = await call('delete_organize_link', {
      workspaceId,
      nodeId: organizeLinkId,
    });
    expectEqual(deletedLink?.success, true, 'delete_organize_link success');

    const deletedFolder = await call('delete_folder', {
      workspaceId,
      folderId: rootFolderId,
    });
    expectEqual(deletedFolder?.success, true, 'delete_folder success');
    if (!Array.isArray(deletedFolder?.deletedIds) || !deletedFolder.deletedIds.includes(rootFolderId)) {
      throw new Error('delete_folder did not report deleted root folder');
    }
    if (!deletedFolder.deletedIds.includes(childFolderId)) {
      throw new Error('delete_folder did not cascade into child folder');
    }

    const organizeNodesAfterDelete = await call('list_organize_nodes', { workspaceId });
    if (organizeNodesAfterDelete.nodes.some(node => node?.id === rootFolderId || node?.id === childFolderId)) {
      throw new Error('delete_folder left folder nodes behind');
    }

    const deletedCollection = await call('delete_collection', {
      workspaceId,
      collectionId,
    });
    expectEqual(deletedCollection?.success, true, 'delete_collection success');

    const collectionsAfterDelete = await call('list_collections', { workspaceId });
    if (collectionsAfterDelete.some(entry => entry?.id === collectionId)) {
      throw new Error('delete_collection left the collection behind');
    }

    console.log();
    console.log('=== Organize tools integration test passed ===');
  } finally {
    await transport.close();
  }
}

main().catch(error => {
  console.error();
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
});
