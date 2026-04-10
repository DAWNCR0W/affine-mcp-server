#!/usr/bin/env node
/**
 * Focused integration test for capability negotiation and fidelity reporting.
 *
 * Verifies:
 * - get_capabilities exposes expected high-level flags
 * - analyze_doc_fidelity reports unsupported native AFFiNE blocks
 * - export_with_fidelity_report returns markdown plus structured fidelity data
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

function expectTruthy(value, message) {
  if (!value) {
    throw new Error(`${message}: expected truthy value, got ${JSON.stringify(value)}`);
  }
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

async function main() {
  console.log('=== Capabilities & Fidelity Integration Test ===');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Server: ${MCP_SERVER_PATH}`);
  console.log();

  const client = new Client({ name: 'affine-mcp-capabilities-fidelity-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, '..'),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: 'sync',
      XDG_CONFIG_HOME: '/tmp/affine-mcp-capabilities-fidelity-noconfig',
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
    console.log('    ✓ OK');
    return parsed;
  }

  await client.connect(transport);

  try {
    const capabilities = await call('get_capabilities');
    expectEqual(capabilities?.server?.name, 'affine-mcp', 'capabilities server name');
    expectArray(capabilities?.docs?.canonicalBlockTypes, 'canonical block types');
    expectTruthy(capabilities.docs.canonicalBlockTypes.includes('attachment'), 'attachment block advertised');
    expectEqual(capabilities?.docs?.highLevelAuthoring?.semanticPageComposer, false, 'semantic page composer flag');
    expectEqual(capabilities?.database?.intentDrivenComposition, false, 'intentDrivenComposition flag');
    expectEqual(capabilities?.collaboration?.replyCreation, false, 'replyCreation flag');

    const workspace = await call('create_workspace', { name: `cap-fidelity-${Date.now()}` });
    const workspaceId = workspace?.id;
    expectTruthy(workspaceId, 'create_workspace id');

    const doc = await call('create_doc', {
      workspaceId,
      title: 'Capabilities Fidelity Doc',
      content: 'Baseline paragraph',
    });
    const docId = doc?.docId;
    expectTruthy(docId, 'create_doc docId');

    const frame = await call('append_block', {
      workspaceId,
      docId,
      type: 'frame',
      text: 'Diagram Frame',
      width: 640,
      height: 320,
      background: 'var(--affine-tag-blue)',
    });
    expectTruthy(frame?.blockId, 'append_block frame blockId');

    const attachment = await call('append_block', {
      workspaceId,
      docId,
      type: 'attachment',
      sourceId: 'fake-source-id',
      name: 'artifact.txt',
      mimeType: 'text/plain',
      size: 12,
    });
    expectTruthy(attachment?.blockId, 'append_block attachment blockId');

    const fidelity = await call('analyze_doc_fidelity', { workspaceId, docId });
    expectEqual(fidelity?.exists, true, 'analyze_doc_fidelity exists');
    expectTruthy(['medium', 'high'].includes(fidelity?.overallRisk), 'overallRisk should indicate loss risk');
    expectArray(fidelity?.unsupportedBlocks, 'unsupportedBlocks');
    if (!fidelity.unsupportedBlocks.some(block => block?.flavour === 'affine:attachment')) {
      throw new Error('unsupportedBlocks should include affine:attachment');
    }
    if (!fidelity.unsupportedBlocks.some(block => block?.flavour === 'affine:frame')) {
      throw new Error('unsupportedBlocks should include affine:frame');
    }

    const exported = await call('export_with_fidelity_report', {
      workspaceId,
      docId,
      includeFrontmatter: true,
    });
    expectEqual(exported?.exists, true, 'export_with_fidelity_report exists');
    expectTruthy(typeof exported?.markdown === 'string' && exported.markdown.includes('fidelityRisk'), 'frontmatter should include fidelityRisk');
    expectEqual(exported?.fidelity?.recommendedPath, 'prefer_native_read_or_clone', 'recommendedPath');
    expectArray(exported?.fidelity?.unsupportedBlocks, 'exported fidelity unsupportedBlocks');

    console.log();
    console.log('=== Capabilities & fidelity integration test passed ===');
  } finally {
    await transport.close();
  }
}

main().catch(err => {
  console.error();
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
