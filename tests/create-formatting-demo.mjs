#!/usr/bin/env node
/**
 * Creates a demo document in AFFiNE that exercises all inline formatting
 * so you can visually verify the bold/italic/etc. fix in the UI.
 *
 * Usage:
 *   AFFINE_BASE_URL=https://affine.example.com \
 *   AFFINE_EMAIL=you@example.com \
 *   AFFINE_PASSWORD=secret \
 *   node tests/create-formatting-demo.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');

const BASE_URL  = process.env.AFFINE_BASE_URL  || 'https://affine.fairleadsoftware.com';
const EMAIL     = process.env.AFFINE_EMAIL     || 'sail.madeline@gmail.com';
const PASSWORD  = process.env.AFFINE_PASSWORD;
if (!PASSWORD) {
  console.error('AFFINE_PASSWORD env var required');
  process.exit(1);
}

const MARKDOWN = `\
# Inline Formatting Demo

## Bold

This paragraph has **bold text** in the middle.

**Fully bold paragraph.**

## Italic

This paragraph has *italic text* in the middle.

## Strikethrough

This paragraph has ~~struck-through text~~ in the middle.

## Inline Code

This paragraph has \`inline code\` in the middle.

## Links

This paragraph has a [clickable link](https://affine.so) inline.

## Combined Formatting

This sentence has **bold**, *italic*, ~~strikethrough~~, and \`code\` all together.

**Bold and *nested italic* inside bold.**

## Headings with Formatting

### **Bold H3**

### *Italic H3*

## Lists with Formatting

- Plain item
- **Bold item**
- *Italic item*
- ~~Struck item~~
- Item with **bold** and *italic* mixed

1. First **bold** numbered item
2. Second *italic* numbered item

- [ ] Todo with **bold** task
- [x] Done with *italic* task
`;

function parseContent(result) {
  const text = result?.content?.[0]?.text;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

async function main() {
  const client = new Client({ name: 'formatting-demo', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: 'sync',
      XDG_CONFIG_HOME: '/tmp/affine-mcp-formatting-demo',
    },
    stderr: 'pipe',
  });

  transport.stderr?.on('data', chunk => process.stderr.write(`[server] ${chunk}`));

  async function call(toolName, args = {}) {
    const result = await client.callTool({ name: toolName, arguments: args }, undefined, { timeout: 60000 });
    if (result?.isError) throw new Error(`${toolName} error: ${result?.content?.[0]?.text}`);
    return parseContent(result);
  }

  await client.connect(transport);

  try {
    const workspaces = await call('list_workspaces');
    if (!workspaces?.length) throw new Error('No workspaces found');

    const workspace = workspaces[0];
    console.log(`Using workspace: "${workspace.name}" (${workspace.id})`);

    const doc = await call('create_doc_from_markdown', {
      workspaceId: workspace.id,
      title: 'Inline Formatting Demo',
      markdown: MARKDOWN,
    });

    console.log(`\nDocument created!`);
    console.log(`  Doc ID : ${doc.docId}`);
    console.log(`  URL    : ${BASE_URL}/workspace/${workspace.id}/${doc.docId}`);
  } finally {
    await client.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
