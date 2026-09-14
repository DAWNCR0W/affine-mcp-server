import './require-destructive-test-safety.mjs';

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { GraphQLClient } from '../dist/graphqlClient.js';
import { ToolFailure, text, toolError, withToolErrors } from '../dist/util/mcp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(path.join(tmpdir(), 'affine-tool-errors-'));
let status = 200;
let errors;
let requests = 0;
const backend = createServer(async (request, response) => {
  for await (const _chunk of request) { /* consume the bounded test request */ }
  requests += 1;
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ errors: errors || [{ message: 'Mock backend failure' }] }));
});
backend.listen(0, '127.0.0.1');
await once(backend, 'listening');
const baseUrl = `http://127.0.0.1:${backend.address().port}`;
const client = new Client({ name: 'tool-error-regression', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'dist/index.js')],
  env: {
    PATH: process.env.PATH || '',
    XDG_CONFIG_HOME: temporary,
    AFFINE_BASE_URL: baseUrl,
    AFFINE_GRAPHQL_PATH: '/api/gql',
    AFFINE_API_TOKEN: 'local-mock-token',
    MCP_TRANSPORT: 'stdio',
  },
  stderr: 'pipe',
});
let diagnostics = '';
transport.stderr.on('data', chunk => { diagnostics += chunk.toString(); });

function checkFailure(result, code) {
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.code, code);
  assert.ok(result.structuredContent.recoveryGuidance.length > 20);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result.structuredContent;
}

try {
  await client.connect(transport);
  const before = requests;
  const missing = checkFailure(await client.callTool({ name: 'list_comments', arguments: { docId: 'document' } }), 'workspace_required');
  assert.match(missing.recoveryGuidance, /list_workspaces/);
  assert.equal(requests, before, 'missing workspace must fail before a backend request');

  for (const [httpStatus, code, retryable] of [
    [401, 'auth_required', false], [403, 'access_denied', false],
    [429, 'rate_limited', true], [503, 'upstream_unavailable', true],
  ]) {
    status = httpStatus;
    const result = checkFailure(await client.callTool({ name: 'current_user', arguments: {} }), code);
    assert.equal(result.retryable, retryable);
  }
  for (const [httpStatus, causeCode] of [[429, 'rate_limited'], [503, 'upstream_unavailable']]) {
    status = httpStatus;
    const result = checkFailure(
      await client.callTool({ name: 'list_workspaces', arguments: {} }),
      'workspace_list_failed',
    );
    assert.equal(result.causeCode, causeCode);
    assert.equal(result.retryable, true, 'read-only pre-normalized transient failures should be retryable');
    assert.equal(typeof result.retryable, 'boolean');
  }
  status = 200;
  errors = [{ message: 'Session ended', extensions: { code: 'UNAUTHENTICATED' } }];
  checkFailure(await client.callTool({ name: 'list_comments', arguments: { workspaceId: 'workspace', docId: 'document' } }), 'auth_required');
  errors = [{ message: 'Unauthorized' }];
  checkFailure(await client.callTool({ name: 'current_user', arguments: {} }), 'auth_required');

  const writeContext = { toolName: 'create_comment', authMode: 'bearer', readOnly: false };
  const uncertain = await withToolErrors(async () => { throw new Error('fetch failed'); }, writeContext)();
  assert.equal(checkFailure(uncertain, 'upstream_unavailable').retryable, false);
  assert.match(uncertain.structuredContent.recoveryGuidance, /read the target before retrying/);

  const opaqueDomain = toolError(new ToolFailure('opaque backend failure', 'upstream_unavailable'), {
    code: 'workspace_list_failed',
  });
  const normalizedOpaqueDomain = await withToolErrors(async () => opaqueDomain, {
    toolName: 'list_workspaces', authMode: 'bearer', readOnly: true,
  })();
  assert.equal(checkFailure(normalizedOpaqueDomain, 'workspace_list_failed').retryable, true);
  assert.equal(normalizedOpaqueDomain.structuredContent.causeCode, 'upstream_unavailable');

  const opaqueCause = toolError(new ToolFailure('opaque backend failure', 'upstream_unavailable'));
  const normalizedOpaqueCause = await withToolErrors(async () => opaqueCause, {
    toolName: 'list_workspaces', authMode: 'bearer', readOnly: true,
  })();
  assert.equal(checkFailure(normalizedOpaqueCause, 'upstream_unavailable').retryable, true);
  assert.equal(normalizedOpaqueCause.structuredContent.causeCode, undefined);

  const omittedWrite = toolError(new Error('HTTP 503: write outcome unknown'), {
    code: 'workspace_create_failed',
  });
  const normalizedOmittedWrite = await withToolErrors(async () => omittedWrite, writeContext)();
  assert.equal(checkFailure(normalizedOmittedWrite, 'workspace_create_failed').retryable, false);

  const explicitFalse = toolError(new Error('HTTP 503: retry later'), {
    code: 'workspace_list_failed',
    retryable: false,
  });
  const preservedFalse = await withToolErrors(async () => explicitFalse, {
    toolName: 'list_workspaces', authMode: 'bearer', readOnly: true,
  })();
  assert.equal(checkFailure(preservedFalse, 'workspace_list_failed').retryable, false);
  assert.equal(preservedFalse.structuredContent.causeCode, 'upstream_unavailable');

  const explicitTrue = toolError(new Error('HTTP 503: retry later'), {
    code: 'workspace_list_failed',
    retryable: true,
  });
  const preservedTrue = await withToolErrors(async () => explicitTrue, {
    toolName: 'create_workspace', authMode: 'bearer', readOnly: false,
  })();
  assert.equal(checkFailure(preservedTrue, 'workspace_list_failed').retryable, true);

  const manualFalsePayload = {
    ok: false,
    error: 'HTTP 503: manually returned failure',
    code: 'workspace_list_failed',
    causeCode: 'upstream_unavailable',
    retryable: false,
  };
  const manualFalse = await withToolErrors(async () => ({
    ...text(manualFalsePayload),
    isError: true,
  }), {
    toolName: 'list_workspaces', authMode: 'bearer', readOnly: true,
  })();
  assert.equal(checkFailure(manualFalse, 'workspace_list_failed').retryable, false);

  const partial = toolError('Placement failed', { code: 'placement_failed', data: { docId: 'existing-doc', contentPersisted: true }, recoveryGuidance: 'Keep existing-doc; repair its placement without creating it again.' });
  const preserved = await withToolErrors(async () => partial, writeContext)();
  assert.equal(preserved.structuredContent.docId, 'existing-doc');
  assert.equal(preserved.structuredContent.contentPersisted, true);
  assert.equal(preserved.structuredContent.recoveryGuidance, partial.structuredContent.recoveryGuidance);
  assert.equal(preserved.structuredContent.retryable, false, 'partial write receipts must remain conservative');
  const embeddedGuidance = toolError('Write timed out', {
    code: 'document_create_failed',
    data: { recoveryGuidance: 'Do not retry document creation; inspect the existing document ID first.' },
  });
  assert.match(embeddedGuidance.structuredContent.recoveryGuidance, /Do not retry document creation/);

  const oauth = await withToolErrors(async () => { throw new ToolFailure('Expired service session', 'auth_required'); }, { ...writeContext, authMode: 'oauth' })();
  assert.match(checkFailure(oauth, 'auth_required').recoveryGuidance, /server operator/);
  assert.doesNotMatch(oauth.structuredContent.recoveryGuidance, /Run affine-mcp login/);
  assert.equal(toolError('Document 401 not found').structuredContent.code, 'tool_error', 'numeric identifiers must not be mistaken for HTTP statuses');
  for (const [message, causeCode] of [['GraphQL HTTP 401: expired', 'auth_required'], ['GraphQL HTTP 403: denied', 'access_denied'], ['GraphQL HTTP 503: down', 'upstream_unavailable']]) {
    const domainError = toolError(new Error(message), { code: 'workspace_delete_failed' }).structuredContent;
    assert.equal(domainError.code, 'workspace_delete_failed', 'explicit domain error codes are backward compatible');
    assert.equal(domainError.causeCode, causeCode);
  }

  const gql = new GraphQLClient({ endpoint: `${baseUrl}/api/gql`, baseUrl: `${baseUrl}/affine/` });
  assert.equal(gql.baseUrl, `${baseUrl}/affine`);
  assert.equal(new GraphQLClient({ endpoint: `${baseUrl}/api/gql` }).baseUrl, baseUrl);
  assert.doesNotMatch(diagnostics, /localStorage|ExperimentalWarning/, 'normal startup must not emit the unused Web Storage warning');
  console.log('Tool recovery contracts: passed (stdio, auth, permissions, network, partial writes, OAuth, UI base URL).');
} finally {
  await transport.close();
  backend.closeAllConnections();
  await new Promise(resolve => backend.close(resolve));
  rmSync(temporary, { recursive: true, force: true });
}
