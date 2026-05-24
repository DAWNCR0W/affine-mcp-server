#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');
const BASE_URL = process.env.AFFINE_BASE_URL || 'http://localhost:3010';
const EMAIL = process.env.AFFINE_ADMIN_EMAIL || process.env.AFFINE_EMAIL || 'test@affine.local';
const PASSWORD = process.env.AFFINE_ADMIN_PASSWORD || process.env.AFFINE_PASSWORD;
const API_TOKEN = process.env.AFFINE_API_TOKEN;
if (!PASSWORD && !API_TOKEN) {
  throw new Error('AFFINE_API_TOKEN or AFFINE_ADMIN_PASSWORD/AFFINE_PASSWORD env var required');
}
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

function assertResult(toolName, result) {
  if (result?.isError) throw new Error(`${toolName} MCP error: ${result?.content?.[0]?.text || 'unknown'}`);
  const parsed = parseContent(result);
  if (parsed && typeof parsed === 'object' && parsed.error) throw new Error(`${toolName} failed: ${parsed.error}`);
  return parsed;
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const client = new Client({ name: 'affine-mcp-read-doc-blob-metadata-test', version: '1.0.0' });
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
      XDG_CONFIG_HOME: '/tmp/affine-mcp-read-doc-blob-metadata',
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', chunk => process.stderr.write(`[mcp-server] ${chunk}`));
  const settle = (ms = 800) => new Promise(resolve => setTimeout(resolve, ms));

  async function call(toolName, args = {}) {
    const result = await client.callTool({ name: toolName, arguments: args }, undefined, { timeout: TOOL_TIMEOUT_MS });
    return assertResult(toolName, result);
  }

  let workspaceId;
  let docId;
  try {
    await client.connect(transport);
    const workspaces = await call('list_workspaces');
    workspaceId = workspaces[0]?.id;
    if (!workspaceId) throw new Error('No workspace available');

    const created = await call('create_doc', {
      workspaceId,
      title: `[read-doc-blob-metadata] ${Date.now()}`,
    });
    docId = created.docId;
    await settle();

    const imageSourceId = `image-${Date.now()}`;
    const attachmentSourceId = `attachment-${Date.now()}`;

    const imageBlock = await call('append_block', {
      workspaceId,
      docId,
      type: 'image',
      sourceId: imageSourceId,
      size: 1234,
    });
    const attachmentBlock = await call('append_block', {
      workspaceId,
      docId,
      type: 'attachment',
      sourceId: attachmentSourceId,
      name: 'artifact.pdf',
      mimeType: 'application/pdf',
      size: 5678,
    });
    await settle();

    const doc = await call('read_doc', { workspaceId, docId });
    const image = doc.blocks.find(block => block.id === imageBlock.blockId);
    const attachment = doc.blocks.find(block => block.id === attachmentBlock.blockId);

    expect(image, 'image block missing from read_doc');
    expect(image.sourceId === imageSourceId, `image sourceId mismatch: ${image?.sourceId}`);
    expect(image.blobUri === `affine://blob/${imageSourceId}`, `image blobUri mismatch: ${image?.blobUri}`);
    expect(image.size === 1234, `image size mismatch: ${image?.size}`);

    expect(attachment, 'attachment block missing from read_doc');
    expect(attachment.sourceId === attachmentSourceId, `attachment sourceId mismatch: ${attachment?.sourceId}`);
    expect(attachment.blobUri === `affine://blob/${attachmentSourceId}`, `attachment blobUri mismatch: ${attachment?.blobUri}`);
    expect(attachment.name === 'artifact.pdf', `attachment name mismatch: ${attachment?.name}`);
    expect(attachment.mimeType === 'application/pdf', `attachment mimeType mismatch: ${attachment?.mimeType}`);
    expect(attachment.size === 5678, `attachment size mismatch: ${attachment?.size}`);

    console.log(JSON.stringify({ ok: true }, null, 2));
  } finally {
    try {
      if (docId && workspaceId) await call('delete_doc', { workspaceId, docId });
    } catch {}
    await client.close().catch(() => {});
  }
}

main().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});