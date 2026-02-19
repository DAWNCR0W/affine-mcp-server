#!/usr/bin/env node
/**
 * E2E test: bearer-token authentication mode.
 *
 * Phase 1 — Generate a bearer token via an email/password MCP session.
 * Phase 2 — Start a SECOND MCP server with ONLY AFFINE_API_TOKEN (no email/password).
 *           Exercise workspace → doc → database → columns → rows through bearer auth.
 *
 * Outputs tests/test-bearer-state.json for Playwright verification.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');
const STATE_OUTPUT_PATH = path.resolve(__dirname, 'test-bearer-state.json');

const BASE_URL = process.env.AFFINE_BASE_URL || 'http://localhost:3010';
const EMAIL = process.env.AFFINE_ADMIN_EMAIL || process.env.AFFINE_EMAIL || 'test@affine.local';
const PASSWORD = process.env.AFFINE_ADMIN_PASSWORD || process.env.AFFINE_PASSWORD || 'TestPass123';
const TOOL_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT_MS || '60000');

function parseContent(result) {
  const text = result?.content?.[0]?.text;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function assertOk(toolName, result) {
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
  return parsed;
}

/** Launch an MCP client connected to our server with the given env vars. */
async function launchMCP(env, label) {
  const client = new Client({ name: `affine-mcp-bearer-${label}`, version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, '..'),
    env,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', chunk => {
    process.stderr.write(`[${label}] ${chunk}`);
  });
  await client.connect(transport);
  return { client, transport };
}

const settle = (ms = 500) => new Promise(r => setTimeout(r, ms));

async function call(client, toolName, args = {}) {
  console.log(`  → ${toolName}(${JSON.stringify(args)})`);
  const result = await client.callTool(
    { name: toolName, arguments: args },
    undefined,
    { timeout: TOOL_TIMEOUT_MS },
  );
  const parsed = assertOk(toolName, result);
  console.log(`    ✓ OK`);
  return parsed;
}

async function main() {
  console.log('=== Bearer Token Auth Test ===');
  console.log(`Base URL: ${BASE_URL}`);
  console.log();

  // ─── Phase 1: Generate a bearer token via email/password session ───
  console.log('--- Phase 1: Generate bearer token ---');
  const { client: pwClient, transport: pwTransport } = await launchMCP({
    AFFINE_BASE_URL: BASE_URL,
    AFFINE_EMAIL: EMAIL,
    AFFINE_PASSWORD: PASSWORD,
    AFFINE_LOGIN_AT_START: 'sync',
  }, 'pw-session');

  let bearerToken;
  let tokenId;
  try {
    await call(pwClient, 'sign_in', { email: EMAIL, password: PASSWORD });

    const tokenResult = await call(pwClient, 'generate_access_token', {
      name: `e2e-bearer-test-${Date.now()}`,
    });
    bearerToken = tokenResult?.token;
    tokenId = tokenResult?.id;
    if (!bearerToken) throw new Error('generate_access_token did not return a token');
    console.log(`  Token ID: ${tokenId}`);
    console.log(`  Token prefix: ${bearerToken.slice(0, 12)}...`);
  } finally {
    await pwTransport.close();
  }

  // ─── Phase 2: Use ONLY the bearer token — no email/password ───
  console.log();
  console.log('--- Phase 2: Bearer-token-only MCP session ---');
  const { client: bearerClient, transport: bearerTransport } = await launchMCP({
    AFFINE_BASE_URL: BASE_URL,
    AFFINE_API_TOKEN: bearerToken,
    // Intentionally NO AFFINE_EMAIL, NO AFFINE_PASSWORD, NO AFFINE_LOGIN_AT_START
  }, 'bearer-session');

  const state = {
    baseUrl: BASE_URL,
    email: EMAIL,
    authMode: 'bearer',
    tokenId,
    workspaceId: null,
    workspaceName: null,
    docId: null,
    docTitle: null,
    databaseBlockId: null,
    columns: [],
    rows: [],
  };

  try {
    // Verify current_user works through bearer auth (no sign_in call!)
    const user = await call(bearerClient, 'current_user');
    if (!user || !user.email) throw new Error('current_user via bearer did not return user');
    console.log(`  Authenticated as: ${user.email}`);

    // Create workspace
    const timestamp = Date.now();
    state.workspaceName = `bearer-db-test-${timestamp}`;
    const ws = await call(bearerClient, 'create_workspace', { name: state.workspaceName });
    state.workspaceId = ws?.id;
    if (!state.workspaceId) throw new Error('create_workspace did not return workspace id');
    console.log(`  Workspace ID: ${state.workspaceId}`);

    // Create doc
    state.docTitle = 'Bearer Auth Database Test';
    const doc = await call(bearerClient, 'create_doc', {
      workspaceId: state.workspaceId,
      title: state.docTitle,
      content: '',
    });
    state.docId = doc?.docId;
    if (!state.docId) throw new Error('create_doc did not return docId');
    console.log(`  Doc ID: ${state.docId}`);

    // Create database block
    const dbBlock = await call(bearerClient, 'append_block', {
      workspaceId: state.workspaceId,
      docId: state.docId,
      type: 'database',
    });
    state.databaseBlockId = dbBlock?.blockId;
    if (!state.databaseBlockId) throw new Error('append_block(database) did not return blockId');
    console.log(`  Database Block ID: ${state.databaseBlockId}`);
    await settle();

    // Add columns
    const columnDefs = [
      { name: 'Task', type: 'rich-text' },
      { name: 'Owner', type: 'select', options: ['Alice', 'Bob', 'Charlie'] },
      { name: 'Score', type: 'number' },
    ];
    for (const colDef of columnDefs) {
      const colArgs = {
        workspaceId: state.workspaceId,
        docId: state.docId,
        databaseBlockId: state.databaseBlockId,
        name: colDef.name,
        type: colDef.type,
      };
      if (colDef.options) colArgs.options = colDef.options;
      const colResult = await call(bearerClient, 'add_database_column', colArgs);
      state.columns.push({ name: colDef.name, type: colDef.type, columnId: colResult?.columnId || null });
      await settle();
    }

    // Add rows
    const rowDefs = [
      { Task: 'Design API', Owner: 'Alice', Score: 95 },
      { Task: 'Write docs', Owner: 'Bob', Score: 88 },
    ];
    for (const rowDef of rowDefs) {
      const rowResult = await call(bearerClient, 'add_database_row', {
        workspaceId: state.workspaceId,
        docId: state.docId,
        databaseBlockId: state.databaseBlockId,
        cells: rowDef,
      });
      state.rows.push({ cells: rowDef, rowId: rowResult?.rowBlockId || null });
      await settle();
    }

    // Write state file
    fs.writeFileSync(STATE_OUTPUT_PATH, JSON.stringify(state, null, 2));
    console.log();
    console.log(`State written to: ${STATE_OUTPUT_PATH}`);
    console.log();
    console.log('=== Bearer token auth test passed ===');
  } catch (err) {
    console.error();
    console.error(`FAILED: ${err.message}`);
    fs.writeFileSync(STATE_OUTPUT_PATH, JSON.stringify({ ...state, error: err.message }, null, 2));
    process.exit(1);
  } finally {
    await bearerTransport.close();
  }
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
