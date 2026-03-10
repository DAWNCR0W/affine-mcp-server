#!/usr/bin/env node
/**
 * Focused integration test for tool groups that previously relied mostly on the
 * comprehensive runner:
 * - workspace CRUD
 * - comments CRUD / resolve
 * - histories
 * - blob storage
 * - notifications
 * - profile/settings
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
  console.log('=== Supporting Tools Integration Test ===');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Server: ${MCP_SERVER_PATH}`);
  console.log();

  const client = new Client({ name: 'affine-mcp-supporting-tools-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, '..'),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: 'sync',
      XDG_CONFIG_HOME: '/tmp/affine-mcp-e2e-supporting-tools-noconfig',
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
      { timeout: TOOL_TIMEOUT_MS },
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

  let workspaceId = null;
  let docId = null;
  let commentId = null;
  let blobKey = null;
  let originalName = null;

  try {
    const currentUser = await call('current_user');
    originalName = currentUser?.name || null;
    expectTruthy(currentUser?.email, 'current_user email');

    const timestamp = Date.now();
    const workspaceName = `supporting-tools-${timestamp}`;

    const listedWorkspacesBefore = await call('list_workspaces');
    expectArray(listedWorkspacesBefore, 'list_workspaces before create');

    const workspace = await call('create_workspace', { name: workspaceName });
    workspaceId = workspace?.id;
    expectTruthy(workspaceId, 'create_workspace id');
    expectTruthy(workspace?.firstDocId, 'create_workspace firstDocId');
    expectTruthy(workspace?.url, 'create_workspace url');

    const listedWorkspacesAfter = await call('list_workspaces');
    expectArray(listedWorkspacesAfter, 'list_workspaces after create');
    if (!listedWorkspacesAfter.some(entry => entry?.id === workspaceId)) {
      throw new Error('list_workspaces did not include created workspace');
    }

    const fetchedWorkspace = await call('get_workspace', { id: workspaceId });
    expectEqual(fetchedWorkspace?.id, workspaceId, 'get_workspace id');

    const updatedWorkspace = await call('update_workspace', {
      id: workspaceId,
      public: true,
      enableAi: false,
    });
    expectEqual(updatedWorkspace?.id, workspaceId, 'update_workspace id');
    expectEqual(updatedWorkspace?.public, true, 'update_workspace public');
    expectEqual(updatedWorkspace?.enableAi, false, 'update_workspace enableAi');

    const doc = await call('create_doc', {
      workspaceId,
      title: 'Supporting Tools Doc',
      content: 'supporting tools regression',
    });
    docId = doc?.docId;
    expectTruthy(docId, 'create_doc docId');

    const histories = await call('list_histories', {
      workspaceId,
      guid: docId,
      take: 20,
    });
    expectArray(histories, 'list_histories result');

    const emptyComments = await call('list_comments', {
      workspaceId,
      docId,
      first: 20,
    });
    expectEqual(emptyComments?.totalCount, 0, 'list_comments totalCount before create');

    const createdComment = await call('create_comment', {
      workspaceId,
      docId,
      docTitle: 'Supporting Tools Doc',
      docMode: 'page',
      content: { text: 'supporting comment' },
    });
    commentId = createdComment?.id;
    expectTruthy(commentId, 'create_comment id');

    const commentsAfterCreate = await call('list_comments', {
      workspaceId,
      docId,
      first: 20,
    });
    expectArray(commentsAfterCreate?.edges, 'list_comments edges after create');
    if (!commentsAfterCreate.edges.some(edge => edge?.node?.id === commentId)) {
      throw new Error('list_comments did not include created comment');
    }

    const updatedComment = await call('update_comment', {
      id: commentId,
      content: { text: 'supporting comment updated' },
    });
    expectEqual(updatedComment?.success, true, 'update_comment success');

    const resolvedComment = await call('resolve_comment', {
      id: commentId,
      resolved: true,
    });
    expectEqual(resolvedComment?.success, true, 'resolve_comment success');

    const deletedComment = await call('delete_comment', { id: commentId });
    expectEqual(deletedComment?.success, true, 'delete_comment success');

    const commentsAfterDelete = await call('list_comments', {
      workspaceId,
      docId,
      first: 20,
    });
    if (commentsAfterDelete.edges.some(edge => edge?.node?.id === commentId)) {
      throw new Error('deleted comment still appeared in list_comments');
    }

    const uploadedBlob = await call('upload_blob', {
      workspaceId,
      filename: 'supporting-tools.txt',
      contentType: 'text/plain',
      content: 'supporting tools blob payload',
    });
    blobKey = uploadedBlob?.key;
    expectTruthy(blobKey, 'upload_blob key');

    const deletedBlob = await call('delete_blob', {
      workspaceId,
      key: blobKey,
      permanently: true,
    });
    expectEqual(deletedBlob?.success, true, 'delete_blob success');

    const cleanupBlobs = await call('cleanup_blobs', { workspaceId });
    expectEqual(cleanupBlobs?.success, true, 'cleanup_blobs success');

    const notifications = await call('list_notifications', { first: 20 });
    expectArray(notifications, 'list_notifications result');

    const readAllNotifications = await call('read_all_notifications');
    expectEqual(readAllNotifications?.success, true, 'read_all_notifications success');

    const profileName = `Supporting Tools ${timestamp}`;
    const updatedProfile = await call('update_profile', { name: profileName });
    expectEqual(updatedProfile?.name, profileName, 'update_profile name');

    const updatedSettings = await call('update_settings', {
      settings: { receiveCommentEmail: true },
    });
    expectEqual(updatedSettings?.success, true, 'update_settings success');

    if (originalName && originalName !== profileName) {
      const restoredProfile = await call('update_profile', { name: originalName });
      expectEqual(restoredProfile?.name, originalName, 'restore original profile name');
    }

    const deletedWorkspace = await call('delete_workspace', { id: workspaceId });
    expectEqual(deletedWorkspace?.success, true, 'delete_workspace success');
    workspaceId = null;

    const listedWorkspacesAfterDelete = await call('list_workspaces');
    if (listedWorkspacesAfterDelete.some(entry => entry?.id === fetchedWorkspace?.id)) {
      throw new Error('deleted workspace still appeared in list_workspaces');
    }

    console.log();
    console.log('=== Supporting tools integration test passed ===');
  } finally {
    if (commentId) {
      await call('delete_comment', { id: commentId }).catch(() => {});
    }
    if (blobKey && workspaceId) {
      await call('delete_blob', { workspaceId, key: blobKey, permanently: true }).catch(() => {});
      await call('cleanup_blobs', { workspaceId }).catch(() => {});
    }
    if (workspaceId) {
      await call('delete_workspace', { id: workspaceId }).catch(() => {});
    }
    await transport.close();
  }
}

main().catch(err => {
  console.error();
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
