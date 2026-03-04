#!/usr/bin/env node
/**
 * E2E regression test: tag visibility data path.
 *
 * Creates workspace + document, then:
 *   create_tag -> add_tag_to_doc -> read_doc -> list_docs_by_tag
 *
 * Writes tests/test-tag-visibility-state.json for Playwright verification.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');
const STATE_OUTPUT_PATH = path.resolve(__dirname, 'test-tag-visibility-state.json');

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

async function main() {
  console.log('=== MCP Tag Visibility Regression Test ===');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Email: ${EMAIL}`);
  console.log();

  const client = new Client({ name: 'affine-mcp-tag-visibility', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, '..'),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: 'sync',
      XDG_CONFIG_HOME: '/tmp/affine-mcp-e2e-tag-visibility-noconfig',
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
    tag: null,
    createTagResult: null,
    addTagResult: null,
    readDocResult: null,
    listDocsByTagResult: null,
  };

  async function call(toolName, args = {}) {
    console.log(`  → ${toolName}(${JSON.stringify(args)})`);
    const result = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: TOOL_TIMEOUT_MS },
    );

    if (result?.isError) {
      const errText = result?.content?.[0]?.text || 'Unknown MCP error';
      throw new Error(`${toolName} MCP error: ${errText}`);
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

  try {
    const timestamp = Date.now();
    state.workspaceName = `mcp-tag-visibility-${timestamp}`;
    state.docTitle = `MCP TAG VISIBILITY ${timestamp}`;
    state.tag = `guide-${timestamp}`;

    const ws = await call('create_workspace', { name: state.workspaceName });
    state.workspaceId = ws?.id;
    if (!state.workspaceId) throw new Error('create_workspace did not return workspace id');

    const doc = await call('create_doc', {
      workspaceId: state.workspaceId,
      title: state.docTitle,
      content: 'Tag visibility regression verification',
    });
    state.docId = doc?.docId;
    if (!state.docId) throw new Error('create_doc did not return docId');

    state.createTagResult = await call('create_tag', {
      workspaceId: state.workspaceId,
      tag: state.tag,
    });

    state.addTagResult = await call('add_tag_to_doc', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      tag: state.tag,
    });

    state.readDocResult = await call('read_doc', {
      workspaceId: state.workspaceId,
      docId: state.docId,
    });

    state.listDocsByTagResult = await call('list_docs_by_tag', {
      workspaceId: state.workspaceId,
      tag: state.tag,
    });

    const readTags = Array.isArray(state.readDocResult?.tags) ? state.readDocResult.tags : [];
    if (!readTags.includes(state.tag)) {
      throw new Error(`read_doc tags did not include expected tag "${state.tag}". got: ${JSON.stringify(readTags)}`);
    }
    const totalDocs = Number(state.listDocsByTagResult?.totalDocs || 0);
    if (totalDocs < 1) {
      throw new Error(`list_docs_by_tag totalDocs expected >= 1, got ${totalDocs}`);
    }

    fs.writeFileSync(STATE_OUTPUT_PATH, JSON.stringify(state, null, 2));
    console.log();
    console.log(`State written to: ${STATE_OUTPUT_PATH}`);
    console.log();
    console.log('=== Tag visibility MCP setup passed ===');
  } catch (err) {
    console.error();
    console.error(`FAILED: ${err.message}`);
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
