#!/usr/bin/env node
/**
 * Live regression test for UI-created database rows.
 *
 * Covers:
 * - creating a database via MCP
 * - creating a row from the AFFiNE UI
 * - reading, updating, and deleting that row via MCP
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
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

function assertResult(toolName, result) {
  if (result?.isError) {
    throw new Error(`${toolName} MCP error: ${result?.content?.[0]?.text || 'unknown'}`);
  }
  const parsed = parseContent(result);
  if (parsed && typeof parsed === 'object' && parsed.error) {
    throw new Error(`${toolName} failed: ${parsed.error}`);
  }
  return parsed;
}

function expectEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expectTruthy(value, message) {
  if (!value) {
    throw new Error(`${message}: expected truthy value, got ${JSON.stringify(value)}`);
  }
}

async function main() {
  console.log('=== Database UI Row Regression Test ===');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Server: ${MCP_SERVER_PATH}`);
  console.log();

  const client = new Client({ name: 'affine-mcp-db-ui-row-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, '..'),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: 'sync',
      XDG_CONFIG_HOME: '/tmp/affine-mcp-e2e-noconfig',
    },
    stderr: 'pipe',
  });

  transport.stderr?.on('data', chunk => {
    process.stderr.write(`[mcp-server] ${chunk}`);
  });

  const settle = (ms = 1000) => new Promise(resolve => setTimeout(resolve, ms));

  async function call(toolName, args = {}) {
    console.log(`  -> ${toolName}(${JSON.stringify(args).slice(0, 200)})`);
    const result = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: TOOL_TIMEOUT_MS },
    );
    const parsed = assertResult(toolName, result);
    console.log('     OK');
    return parsed;
  }

  let browser;
  try {
    await client.connect(transport);
    console.log('MCP client connected.\n');

    const workspace = await call('create_workspace', { name: `db-ui-rows-${Date.now()}` });
    const workspaceId = workspace?.id;
    expectTruthy(workspaceId, 'create_workspace did not return workspace id');

    const doc = await call('create_doc', {
      workspaceId,
      title: 'Database UI Row Regression',
      content: '',
    });
    const docId = doc?.docId;
    expectTruthy(docId, 'create_doc did not return docId');

    const database = await call('append_block', {
      workspaceId,
      docId,
      type: 'database',
    });
    const databaseBlockId = database?.blockId;
    expectTruthy(databaseBlockId, 'append_block(database) did not return blockId');
    await settle();

    await call('add_database_column', {
      workspaceId,
      docId,
      databaseBlockId,
      name: 'Title',
      type: 'rich-text',
    });
    await settle(1500);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto(`${BASE_URL}/sign-in`);
    await page.waitForLoadState('domcontentloaded');
    await page.locator('input[type="email"], input[name="email"], input[placeholder*="email"]').first().fill(EMAIL);
    await page.locator('button:has-text("Continue with email"), button:has-text("Continue"), button[type="submit"]').first().click();
    await page.locator('input[type="password"], input[name="password"]').first().fill(PASSWORD);
    await page.locator('button:has-text("Sign in"), button:has-text("Log in"), button[type="submit"]').first().click();
    await page.waitForURL(url => !url.toString().includes('/sign-in'), { timeout: 30_000 });

    await page.goto(`${BASE_URL}/workspace/${workspaceId}/${docId}`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(5000);

    const dismiss = page.getByRole('button', { name: 'Dismiss' });
    if (await dismiss.count()) {
      await dismiss.first().click();
      await page.waitForTimeout(500);
    }

    await page.getByRole('button', { name: 'New Record' }).click();
    await page.waitForTimeout(1000);
    await page.keyboard.type('UI row');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(2000);
    await browser.close();
    browser = null;

    const readDoc = await call('read_doc', { workspaceId, docId });
    const databaseBlock = readDoc?.blocks?.find(block => block.id === databaseBlockId);
    const rowBlockId = databaseBlock?.childIds?.[0];
    expectTruthy(rowBlockId, 'UI-created rowBlockId not found in database childIds');

    const initialRead = await call('read_database_cells', {
      workspaceId,
      docId,
      databaseBlockId,
      rowBlockIds: [rowBlockId],
    });
    expectEqual(initialRead.rows.length, 1, 'read_database_cells UI row count');
    expectEqual(initialRead.rows[0].title, 'UI row', 'UI-created row title');

    const update = await call('update_database_cell', {
      workspaceId,
      docId,
      databaseBlockId,
      rowBlockId,
      column: 'title',
      value: 'UI row updated',
    });
    expectEqual(update.updated, true, 'update_database_cell updated flag');

    const updatedRead = await call('read_database_cells', {
      workspaceId,
      docId,
      databaseBlockId,
      rowBlockIds: [rowBlockId],
    });
    expectEqual(updatedRead.rows[0].title, 'UI row updated', 'updated UI-created row title');

    const deletion = await call('delete_database_row', {
      workspaceId,
      docId,
      databaseBlockId,
      rowBlockId,
    });
    expectEqual(deletion.deleted, true, 'delete_database_row deleted flag');

    const afterDelete = await call('read_database_cells', {
      workspaceId,
      docId,
      databaseBlockId,
    });
    expectEqual(afterDelete.rows.length, 0, 'row count after deleting UI-created row');

    console.log('\n=== Database UI Row Regression Test Passed ===');
  } finally {
    if (browser) {
      await browser.close();
    }
    await transport.close();
  }
}

main().catch(error => {
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
});
