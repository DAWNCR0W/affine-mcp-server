#!/usr/bin/env node
/**
 * Integration test for native template instantiation.
 *
 * Verifies:
 * - inspect_template_structure reports native support
 * - instantiate_template_native preserves native blocks and tags
 * - variable substitution applies during native cloning
 * - optional parent linking works
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
  console.log('=== Native Template Instantiation Test ===');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Server: ${MCP_SERVER_PATH}`);
  console.log();

  const client = new Client({ name: 'affine-mcp-native-template-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, '..'),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: 'sync',
      XDG_CONFIG_HOME: '/tmp/affine-mcp-native-template-noconfig',
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
    const workspace = await call('create_workspace', { name: `native-template-${Date.now()}` });
    const workspaceId = workspace?.id;
    expectTruthy(workspaceId, 'create_workspace id');

    await call('create_tag', { workspaceId, tag: 'template-native' });

    const template = await call('create_doc', {
      workspaceId,
      title: 'Native Template Source',
      content: 'Hello {{person}}',
    });
    const templateDocId = template?.docId;
    expectTruthy(templateDocId, 'template docId');

    await call('add_tag_to_doc', {
      workspaceId,
      docId: templateDocId,
      tag: 'template-native',
    });

    const linkedDoc = await call('create_doc', {
      workspaceId,
      title: 'Native Linked Doc',
      content: 'linked body',
    });
    const linkedDocId = linkedDoc?.docId;
    expectTruthy(linkedDocId, 'linked docId');

    const attachment = await call('append_block', {
      workspaceId,
      docId: templateDocId,
      type: 'attachment',
      sourceId: 'template-attachment-source',
      name: 'artifact.txt',
      mimeType: 'text/plain',
      size: 32,
    });
    expectTruthy(attachment?.blockId, 'attachment blockId');

    const frame = await call('append_block', {
      workspaceId,
      docId: templateDocId,
      type: 'frame',
      text: 'Frame Template',
      width: 480,
      height: 240,
      background: 'var(--affine-tag-green)',
    });
    expectTruthy(frame?.blockId, 'frame blockId');

    const linkedEmbed = await call('append_block', {
      workspaceId,
      docId: templateDocId,
      type: 'embed_linked_doc',
      pageId: linkedDocId,
    });
    expectTruthy(linkedEmbed?.blockId, 'linked embed blockId');

    const inspected = await call('inspect_template_structure', {
      workspaceId,
      templateDocId,
    });
    expectEqual(inspected?.nativeCloneSupported, true, 'inspect_template_structure nativeCloneSupported');
    expectArray(inspected?.blocks, 'inspect_template_structure blocks');
    if (!inspected.blocks.some(block => block?.flavour === 'affine:attachment')) {
      throw new Error('template inspection should include the attachment block');
    }
    if (!inspected.blocks.some(block => block?.flavour === 'affine:frame')) {
      throw new Error('template inspection should include the frame block');
    }

    const parentDoc = await call('create_doc', {
      workspaceId,
      title: 'Template Parent',
      content: '',
    });
    const parentDocId = parentDoc?.docId;
    expectTruthy(parentDocId, 'parent docId');

    const instantiated = await call('instantiate_template_native', {
      workspaceId,
      templateDocId,
      title: 'Native Template Instance',
      variables: { person: 'World' },
      parentDocId,
    });
    expectEqual(instantiated?.mode, 'native', 'instantiate_template_native mode');
    expectEqual(instantiated?.nativeCloneSupported, true, 'instantiate_template_native nativeCloneSupported');
    expectEqual(instantiated?.linkedToParent, true, 'instantiate_template_native linkedToParent');
    expectTruthy(instantiated?.docId, 'instantiated docId');
    expectArray(instantiated?.preservedTags, 'preservedTags');
    if (!instantiated.preservedTags.includes('template-native')) {
      throw new Error('instantiated doc should preserve template tags');
    }

    const instantiatedDoc = await call('read_doc', {
      workspaceId,
      docId: instantiated.docId,
    });
    expectEqual(instantiatedDoc?.title, 'Native Template Instance', 'instantiated read_doc title');
    expectArray(instantiatedDoc?.blocks, 'instantiated read_doc blocks');
    if (!instantiatedDoc.blocks.some(block => block?.flavour === 'affine:attachment')) {
      throw new Error('native clone should preserve attachment blocks');
    }
    if (!instantiatedDoc.blocks.some(block => block?.flavour === 'affine:frame')) {
      throw new Error('native clone should preserve frame blocks');
    }
    if (!instantiatedDoc.plainText.includes('Hello World')) {
      throw new Error('variable substitution should apply during native cloning');
    }

    const children = await call('list_children', {
      workspaceId,
      docId: parentDocId,
    });
    expectArray(children?.children, 'list_children children');
    if (!children.children.some(entry => entry?.docId === instantiated.docId)) {
      throw new Error('instantiated doc should be linked under the parent doc');
    }

    const taggedDocs = await call('list_docs_by_tag', {
      workspaceId,
      tag: 'template-native',
    });
    expectArray(taggedDocs?.docs, 'list_docs_by_tag docs');
    if (!taggedDocs.docs.some(entry => entry?.id === instantiated.docId)) {
      throw new Error('instantiated doc should inherit template-native tag');
    }

    console.log();
    console.log('=== Native template instantiation test passed ===');
  } finally {
    await transport.close();
  }
}

main().catch(error => {
  console.error();
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
});
