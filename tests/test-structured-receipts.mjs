#!/usr/bin/env node
/**
 * Focused integration test for structured MCP receipts.
 *
 * Verifies that high-value mutation tools expose structuredContent alongside
 * the legacy JSON text payload so downstream agents can read stable fields
 * without reparsing opaque text only.
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

function assertReceipt(result, kind, expected = {}) {
  const structured = result?.structuredContent;
  if (!structured || typeof structured !== 'object') {
    throw new Error(`${kind}: missing structuredContent`);
  }

  expectEqual(structured.kind, kind, `${kind} kind`);
  expectEqual(structured.ok, true, `${kind} ok`);

  const textPayload = parseContent(result);
  if (!textPayload || typeof textPayload !== 'object') {
    throw new Error(`${kind}: missing JSON text payload`);
  }
  expectEqual(textPayload.kind, kind, `${kind} text kind`);
  expectEqual(textPayload.ok, true, `${kind} text ok`);

  for (const [key, value] of Object.entries(expected)) {
    if (value === undefined) {
      continue;
    }
    expectEqual(structured[key], value, `${kind}.${key}`);
    expectEqual(textPayload[key], value, `${kind}.text.${key}`);
  }

  return { structured, textPayload };
}

async function main() {
  console.log('=== Structured MCP Receipts Test ===');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Server: ${MCP_SERVER_PATH}`);
  console.log();

  const client = new Client({ name: 'affine-mcp-structured-receipts-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, '..'),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: 'sync',
      XDG_CONFIG_HOME: '/tmp/affine-mcp-e2e-structured-receipts-noconfig',
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
    return result;
  }

  await client.connect(transport);

  let workspaceId = null;
  let docId = null;
  let commentId = null;

  try {
    const workspace = await call('create_workspace', { name: `structured-receipts-${Date.now()}` });
    const workspaceReceipt = assertReceipt(workspace, 'workspace.create', {
    });
    workspaceId = workspaceReceipt.structured.workspaceId || workspaceReceipt.structured.id;
    expectTruthy(workspaceId, 'workspace.create workspaceId');
    expectTruthy(workspaceReceipt.structured.firstDocId, 'workspace.create firstDocId');
    expectTruthy(workspaceReceipt.structured.url, 'workspace.create url');
    if (!['success', 'partial'].includes(workspaceReceipt.structured.status)) {
      throw new Error(`workspace.create status: expected success or partial, got ${JSON.stringify(workspaceReceipt.structured.status)}`);
    }

    const doc = await call('create_doc', {
      workspaceId,
      title: 'Structured Receipts Doc',
      content: 'structured receipts baseline',
    });
    const docReceipt = assertReceipt(doc, 'doc.create', {
      workspaceId,
      title: 'Structured Receipts Doc',
    });
    docId = docReceipt.structured.docId;
    expectTruthy(docId, 'doc.create docId');

    const appendBlock = await call('append_block', {
      workspaceId,
      docId,
      type: 'paragraph',
      text: 'structured paragraph receipt',
    });
    const appendReceipt = assertReceipt(appendBlock, 'doc.append_block', {
      workspaceId,
      docId,
      appended: true,
      normalizedType: 'paragraph',
      blockType: 'text',
    });
    expectTruthy(appendReceipt.structured.blockId, 'append_block blockId');

    const comment = await call('create_comment', {
      workspaceId,
      docId,
      docTitle: 'Structured Receipts Doc',
      docMode: 'page',
      content: { text: 'structured comment receipt' },
    });
    const commentReceipt = assertReceipt(comment, 'comment.create', {
      workspaceId,
      docId,
    });
    commentId = commentReceipt.structured.commentId;
    expectTruthy(commentId, 'comment.create commentId');

    const resolveComment = await call('resolve_comment', {
      id: commentId,
      resolved: true,
    });
    assertReceipt(resolveComment, 'comment.resolve', {
      commentId,
      resolved: true,
      success: true,
    });

    const updateWorkspace = await call('update_workspace', {
      id: workspaceId,
      public: true,
      enableAi: false,
    });
    assertReceipt(updateWorkspace, 'workspace.update', {
      workspaceId,
      public: true,
      enableAi: false,
    });
  } finally {
    if (workspaceId) {
      try {
        const deletedWorkspace = await call('delete_workspace', { id: workspaceId });
        assertReceipt(deletedWorkspace, 'workspace.delete', {
          workspaceId,
          deleted: true,
          success: true,
        });
      } catch (err) {
        console.error(`[cleanup] Failed to delete workspace ${workspaceId}: ${err.message}`);
      }
    }
    await client.close();
    await transport.close?.();
  }
}

main().catch(err => {
  console.error(`[structured-receipts] ERROR: ${err.message}`);
  process.exit(1);
});
