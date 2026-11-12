#!/usr/bin/env node
import { testTempPath } from './require-destructive-test-safety.mjs';

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let backendRequests = 0;
const backend = createServer((_request, response) => {
  backendRequests++;
  response.writeHead(500).end('The input-limit test must not access AFFiNE.');
});
backend.on('upgrade', (_request, socket) => { backendRequests++; socket.destroy(); });
await new Promise((resolve, reject) => {
  backend.once('error', reject);
  backend.listen(0, '127.0.0.1', resolve);
});
const client = new Client({ name: 'production-input-limit-test', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectDir, 'dist', 'index.js')],
  cwd: projectDir,
  env: {
    ...process.env,
    MCP_TRANSPORT: 'stdio',
    AFFINE_BASE_URL: `http://127.0.0.1:${backend.address().port}`,
    AFFINE_API_TOKEN: 'input-limit-test-token',
    AFFINE_COOKIE: '',
    AFFINE_EMAIL: '',
    AFFINE_PASSWORD: '',
    AFFINE_LOGIN_AT_START: '',
    AFFINE_WORKSPACE_ID: '',
    AFFINE_TOOL_PROFILE: 'full',
    AFFINE_DISABLED_GROUPS: '',
    AFFINE_DISABLED_TOOLS: '',
    AFFINE_MCP_AUTH_MODE: 'bearer',
    AFFINE_HEADERS_JSON: '',
    XDG_CONFIG_HOME: testTempPath('production-tool-input-limits'),
  },
  stderr: 'pipe',
});
let diagnostics = '';
transport.stderr?.on('data', chunk => { diagnostics += chunk; });
const textOf = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
const call = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 });
const ceilingMessage = /maximum of 20000 elements/;

try {
  // Launch the actual production entrypoint/buildServer. A separate dummy
  // McpServer would miss an omitted option in the shipped server factory.
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.ok(tools.some(tool => tool.name === 'create_mindmap'));
  assert.ok(tools.some(tool => tool.name === 'add_database_rows'));

  // Two object members plus 19,998 array entries make exactly 20,000.
  // get_capabilities has an empty schema: this unknown field would otherwise
  // be stripped before the local handler, so it tests raw-input accounting.
  const boundary = await call('get_capabilities', { unused: { nested: Array(19_998).fill(null) } });
  assert.ok(!boundary.isError, textOf(boundary));
  const oversized = await call('get_capabilities', { unused: { nested: Array(19_999).fill(null) } });
  assert.equal(oversized.isError, true, 'oversized unknown nested input must reject before the local handler');
  assert.match(textOf(oversized), ceilingMessage, 'oversized unknown nested fields must not disappear during schema parsing');

  // The same invalid known field normally reaches its text refinement. Adding
  // unknown oversized input must reject earlier, before that validation path.
  const invalid = await call('create_mindmap', { docId: 'doc', text: ' ' });
  assert.equal(invalid.isError, true);
  assert.match(textOf(invalid), /text must not be blank/);
  const costlyInvalid = await call('create_mindmap', {
    docId: 'doc', text: ' ', unused: { nested: Array(20_001).fill({ extra: true }) },
  });
  assert.equal(costlyInvalid.isError, true);
  assert.match(textOf(costlyInvalid), ceilingMessage);
  assert.doesNotMatch(textOf(costlyInvalid), /text must not be blank/);

  // These representative maximum-size payloads must pass the cost guard AND
  // their real tool schemas. Missing workspace is a deliberate handler-level
  // stop before authentication/socket work; it keeps this a no-AFFiNE test.
  const representativeCalls = [
    ['add_surface_elements', {
      docId: 'doc',
      elements: Array.from({ length: 200 }, (_, index) => ({
        type: 'shape', x: index * 100, y: 0, width: 100, height: 60,
        shapeType: 'rect', text: `Shape ${index}`, filled: true, strokeWidth: 2,
      })),
    }],
    ['add_database_rows', {
      docId: 'doc', databaseBlockId: 'database',
      rows: Array.from({ length: 200 }, (_, row) => ({
        cells: Object.fromEntries(Array.from({ length: 50 }, (_, column) => [`Column ${column}`, `Row ${row}`])),
      })),
    }],
    ['append_block', {
      docId: 'doc', type: 'table', rows: 20, columns: 20,
      tableCellDeltas: Array.from({ length: 20 }, () => Array.from({ length: 20 }, () =>
        Array.from({ length: 10 }, () => ({ insert: 'rich text', attributes: { bold: true } })))),
    }],
    ['create_mindmap', {
      docId: 'doc', text: 'Root', children: Array.from({ length: 499 }, (_, index) => ({ text: `Node ${index}` })),
    }],
  ];
  for (const [name, args] of representativeCalls) {
    const result = await call(name, args);
    assert.equal(result.isError, true, `${name} must stop at the missing-workspace handler guard`);
    assert.match(textOf(result), /workspaceId is required/, `${name}: ${textOf(result)}`);
    assert.doesNotMatch(textOf(result), ceilingMessage, `${name}: ordinary large requests must remain usable`);
  }

  const recovered = await call('get_capabilities');
  assert.ok(!recovered.isError, 'the same production client must remain usable after rejected calls');
  await client.ping();
  assert.equal(backendRequests, 0, 'input checks must never query or open a socket to the AFFiNE backend');
  console.log('PASS: production MCP input ceiling before validation/handlers, inclusive boundary, large payload compatibility and client recovery');
} catch (error) {
  error.message += `\nProduction server diagnostics:\n${diagnostics}`;
  throw error;
} finally {
  await client.close();
  await transport.close();
  await new Promise(resolve => backend.close(resolve));
}
