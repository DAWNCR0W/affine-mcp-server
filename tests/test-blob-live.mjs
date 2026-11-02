#!/usr/bin/env node
import { testResourceName, testTempPath } from './require-destructive-test-safety.mjs';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { acquireCredentials } from './acquire-credentials.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = (process.env.AFFINE_BASE_URL || 'http://localhost:3010').replace(/\/+$/, '');
const email = process.env.AFFINE_ADMIN_EMAIL || process.env.AFFINE_EMAIL || 'test@affine.local';
const password = process.env.AFFINE_ADMIN_PASSWORD || process.env.AFFINE_PASSWORD;
if (!password) throw new Error('AFFINE_ADMIN_PASSWORD is required');
const uploadRoot = testTempPath('blob-live-upload');
const filePath = path.join(uploadRoot, 'binary-fixture.bin');
const auth = await acquireCredentials(baseUrl, email, password);
const transport = new StdioClientTransport({
  command: 'node', args: [path.join(projectRoot, 'dist', 'index.js')], cwd: projectRoot,
  env: {
    AFFINE_BASE_URL: baseUrl, AFFINE_COOKIE: auth.cookie,
    XDG_CONFIG_HOME: testTempPath('blob-live-config'),
    AFFINE_BLOB_UPLOAD_FILE_ROOTS: uploadRoot,
  },
  stderr: 'pipe',
});
transport.stderr?.on('data', chunk => process.stderr.write(`[mcp-blob-live] ${chunk}`));
const client = new Client({ name: 'blob-live', version: '1.0.0' });
function parseResult(result) {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return result.structuredContent ?? JSON.parse(result.content?.[0]?.text || 'null');
}
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  return { result, receipt: parseResult(result) };
}
let workspaceId;
const blobKeys = new Set();
const errors = [];
try {
  await client.connect(transport);
  workspaceId = (await call('create_workspace', { name: testResourceName('blob-live') })).receipt.id;
  assert.ok(workspaceId, 'create_workspace returns an isolated workspace id');
  const fixtures = [
    { name: 'text', bytes: Buffer.from('Blob live roundtrip: 한글 ✓\n'), filename: 'fixture.txt', contentType: 'text/plain', type: 'resource' },
    { name: 'image', bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=', 'base64'), filename: 'fixture.png', contentType: 'image/png', type: 'image' },
    { name: 'binary-filePath', bytes: Buffer.from(Array.from({ length: 256 }, (_, index) => index)), filename: 'binary-fixture.bin', contentType: 'application/octet-stream', type: 'resource', file: true },
  ];
  for (const fixture of fixtures) {
    if (fixture.file) await writeFile(filePath, fixture.bytes, { mode: 0o600 });
    const uploadArgs = fixture.file
      ? { workspaceId, filePath }
      : { workspaceId, content: fixture.bytes.toString('base64'), encoding: 'base64', filename: fixture.filename, contentType: fixture.contentType };
    const uploaded = (await call('upload_blob', uploadArgs)).receipt;
    const key = uploaded.key;
    if (key) blobKeys.add(key); // Track before assertions so failed receipts still clean up.
    assert.equal(typeof key, 'string');
    assert.ok(key.length > 0);
    assert.equal(uploaded.source, fixture.file ? 'file' : 'content');
    assert.equal(uploaded.size, fixture.bytes.length);
    assert.equal(uploaded.filename, fixture.filename);
    const { result, receipt } = await call('get_blob', {
      workspaceId, key: fixture.file ? `affine://blob/${encodeURIComponent(key)}` : key,
    });
    assert.equal(receipt.size, fixture.bytes.length);
    assert.equal(receipt.sha256, createHash('sha256').update(fixture.bytes).digest('hex'));
    assert.equal(receipt.contentType, fixture.contentType);
    const payload = result.content.find(item => item.type === fixture.type);
    assert.ok(payload, `${fixture.name} returns MCP ${fixture.type} content`);
    assert.equal(fixture.type === 'image' ? payload.mimeType : payload.resource.mimeType, fixture.contentType);
    assert.deepEqual(Buffer.from(fixture.type === 'image' ? payload.data : payload.resource.blob, 'base64'), fixture.bytes);
    if (fixture.type === 'resource') assert.equal(payload.resource.uri, `affine://blob/${encodeURIComponent(key)}`);
    console.log(`PASS blob live ${fixture.name}: upload/download bytes, MIME, size and SHA-256`);
  }
} catch (error) {
  errors.push(error);
} finally {
  for (const key of blobKeys) {
    try { await call('delete_blob', { workspaceId, key, permanently: true, confirmKey: key }); }
    catch (error) { errors.push(error); }
  }
  if (workspaceId) {
    try { await call('delete_workspace', { id: workspaceId, confirmWorkspaceId: workspaceId }); }
    catch (error) { errors.push(error); }
  }
  try { await rm(filePath, { force: true }); } catch (error) { errors.push(error); }
  try { await transport.close(); } catch (error) { errors.push(error); }
}
if (errors.length) throw new AggregateError(errors, 'Live blob verification or cleanup failed');
console.log('PASS blob live roundtrips and isolated fixture cleanup');
