#!/usr/bin/env node
/**
 * E2E regression test: tag deletion data path.
 *
 * Creates workspace + document, tags it, then deletes the tag:
 *   create_tag -> add_tag_to_doc -> list_docs_by_tag -> delete_tag
 *   -> read_doc -> list_tags -> list_docs_by_tag
 *
 * Verifies that delete_tag removes the workspace tag option AND detaches it
 * from every document that referenced it, and that a missing tag is rejected.
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

/** Extract and JSON-parse an MCP tool result's first text content block. */
function parseContent(result) {
  const text = result?.content?.[0]?.text;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

/** Drive the full create→tag→delete→verify regression flow over a stdio MCP client. */
async function main() {
  console.log('=== MCP Tag Deletion Regression Test ===');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Email: ${EMAIL}`);
  console.log();

  const client = new Client({ name: 'affine-mcp-tag-deletion', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, '..'),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: 'sync',
      XDG_CONFIG_HOME: `/tmp/affine-mcp-e2e-tag-deletion-noconfig-${process.pid}-${Date.now()}`,
    },
    stderr: 'pipe',
  });

  transport.stderr?.on('data', chunk => {
    process.stderr.write(`[mcp-server] ${chunk}`);
  });

  await client.connect(transport);
  console.log('Connected to MCP server');

  /** Call an MCP tool, fail on MCP/error responses, and return the parsed payload. */
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

  /** Assert a tool call is rejected and its error matches `matcher` (missing-tag case). */
  async function expectError(toolName, args, matcher) {
    console.log(`  → (expect error) ${toolName}(${JSON.stringify(args)})`);
    let parsed;
    try {
      const result = await client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { timeout: TOOL_TIMEOUT_MS },
      );
      if (result?.isError) {
        const errText = result?.content?.[0]?.text || 'Unknown MCP error';
        if (!matcher.test(errText)) throw new Error(`unexpected error text: ${errText}`);
        console.log('    ✓ rejected as expected');
        return;
      }
      parsed = parseContent(result);
    } catch (err) {
      if (!matcher.test(err.message)) throw new Error(`unexpected error: ${err.message}`);
      console.log('    ✓ rejected as expected');
      return;
    }
    throw new Error(`${toolName} should have failed but returned: ${JSON.stringify(parsed)}`);
  }

  try {
    const timestamp = Date.now();
    const workspaceName = `mcp-tag-deletion-${timestamp}`;
    const docTitle = `MCP TAG DELETION ${timestamp}`;
    const tag = `disposable-${timestamp}`;

    const ws = await call('create_workspace', { name: workspaceName });
    const workspaceId = ws?.id;
    if (!workspaceId) throw new Error('create_workspace did not return workspace id');

    const doc = await call('create_doc', {
      workspaceId,
      title: docTitle,
      content: 'Tag deletion regression verification',
    });
    const docId = doc?.docId;
    if (!docId) throw new Error('create_doc did not return docId');

    await call('create_tag', { workspaceId, tag });
    await call('add_tag_to_doc', { workspaceId, docId, tag });

    const beforeList = await call('list_docs_by_tag', { workspaceId, tag });
    if (Number(beforeList?.totalDocs || 0) < 1) {
      throw new Error(`expected the doc to carry the tag before deletion, got totalDocs=${beforeList?.totalDocs}`);
    }

    const deleteResult = await call('delete_tag', { workspaceId, tag });
    if (!deleteResult?.deleted) {
      throw new Error(`delete_tag did not report deleted=true: ${JSON.stringify(deleteResult)}`);
    }
    if (Number(deleteResult?.affectedDocs || 0) < 1) {
      throw new Error(`delete_tag expected affectedDocs >= 1, got ${deleteResult?.affectedDocs}`);
    }

    // The document must no longer carry the tag.
    const readAfter = await call('read_doc', { workspaceId, docId });
    const readTags = Array.isArray(readAfter?.tags) ? readAfter.tags : [];
    if (readTags.includes(tag)) {
      throw new Error(`read_doc still lists deleted tag "${tag}": ${JSON.stringify(readTags)}`);
    }

    // The tag option must be gone from the workspace registry.
    const tagsAfter = await call('list_tags', { workspaceId });
    const names = Array.isArray(tagsAfter?.tags) ? tagsAfter.tags.map(t => t.name) : [];
    if (names.includes(tag)) {
      throw new Error(`list_tags still includes deleted tag "${tag}": ${JSON.stringify(names)}`);
    }

    // And nothing should resolve under that tag anymore.
    const afterList = await call('list_docs_by_tag', { workspaceId, tag });
    if (Number(afterList?.totalDocs || 0) !== 0) {
      throw new Error(`list_docs_by_tag expected totalDocs=0 after deletion, got ${afterList?.totalDocs}`);
    }

    // Deleting an unknown tag must be rejected, not silently succeed.
    await expectError('delete_tag', { workspaceId, tag: `does-not-exist-${timestamp}` }, /was not found/i);

    console.log();
    console.log('=== Tag deletion MCP test passed ===');
  } catch (err) {
    console.error();
    console.error(`FAILED: ${err.message}`);
    process.exit(1);
  } finally {
    await transport.close();
  }
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
