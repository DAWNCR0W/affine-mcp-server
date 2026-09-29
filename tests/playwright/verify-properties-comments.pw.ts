import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as Y from 'yjs';
import { signInToAffine } from './sign-in.js';
import { testResourceName, testTempPath } from '../require-destructive-test-safety.mjs';
import { acquireCredentials } from '../acquire-credentials.mjs';
import { connectWorkspaceSocket, joinWorkspace, loadDoc, wsUrlFromGraphQLEndpoint } from '../../dist/ws.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baseUrl = process.env.AFFINE_BASE_URL || 'http://localhost:3010';
const email = process.env.AFFINE_ADMIN_EMAIL || process.env.AFFINE_EMAIL || 'test@affine.local';
const password = process.env.AFFINE_ADMIN_PASSWORD!;
let client: Client;
let transport: StdioClientTransport;
let workspaceId: string;
let docId: string;

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return result.structuredContent as any;
}

async function openDoc(page: Page, commentId?: string) {
  await signInToAffine(page, { baseUrl, email, password });
  const focus = commentId ? `?commentId=${encodeURIComponent(commentId)}` : "";
  await page.goto(`${baseUrl}/workspace/${workspaceId}/${docId}${focus}`);
  await expect(page.getByTestId('page-info-collapse')).toBeVisible();
}

test.describe('Native property and comment contracts', () => {
  test.beforeAll(async () => {
    client = new Client({ name: 'native-contract-browser-test', version: '1.0.0' });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, 'dist/index.js')],
      cwd: root,
      env: {
        AFFINE_BASE_URL: baseUrl, AFFINE_EMAIL: email, AFFINE_PASSWORD: password,
        AFFINE_LOGIN_AT_START: 'sync', XDG_CONFIG_HOME: testTempPath('native-contract-browser'),
      },
      stderr: 'pipe',
    });
    await client.connect(transport);
    workspaceId = (await call('create_workspace', { name: testResourceName('native-contracts') })).id;
    docId = (await call('create_doc', { workspaceId, title: 'Native contract checks', content: 'Comment target text.' })).docId;
  });

  test.afterAll(async () => {
    try {
      if (workspaceId) await call('delete_workspace', { id: workspaceId, confirmWorkspaceId: workspaceId });
    } finally {
      await transport?.close();
    }
  });

  test('custom properties use native wire documents and support UI edits', async ({ page }) => {
    const definitions = [];
    for (const [type, value] of [['text', 'Visible custom text'], ['number', 7], ['checkbox', true], ['date', '2026-06-14']] as const) {
      const definition = await call('create_custom_property', { workspaceId, name: `Audit ${type}`, type });
      await call('set_doc_property', { workspaceId, docId, property: definition.propertyId, value });
      definitions.push({ ...definition, value });
    }
    // Inspect literal native wire IDs before the UI can migrate or rewrite data.
    const { cookie } = await acquireCredentials(baseUrl, email, password);
    const socket = await connectWorkspaceSocket(wsUrlFromGraphQLEndpoint(`${baseUrl}/graphql`), cookie);
    try {
      await joinWorkspace(socket, workspaceId);
      for (const table of ['docCustomPropertyInfo', 'docProperties']) {
        const snapshot = await loadDoc(socket, workspaceId, `db$${workspaceId}$${table}`);
        expect(typeof snapshot.missing).toBe('string');
        const doc = new Y.Doc();
        try {
          Y.applyUpdate(doc, Buffer.from(snapshot.missing!, 'base64'));
          for (const definition of definitions) {
            if (table === 'docCustomPropertyInfo') {
              expect(doc.getMap(definition.propertyId).get('name')).toBe(definition.name);
            } else {
              expect(doc.getMap(docId).get(`custom:${definition.propertyId}`)).toBe(String(definition.value));
              expect(doc.getMap(docId).get('createdBy')).toBeTruthy();
            }
          }
        } finally { doc.destroy(); }
      }
    } finally { socket.disconnect(); }

    await openDoc(page);
    await page.getByTestId('page-info-collapse').click();
    const rows = definitions.map(definition => page.locator(`[data-testid="doc-property-row"][data-info-id="${definition.propertyId}"]`));
    if (!await rows[0].isVisible()) await page.getByText(/^\d+ more propert/i).click();
    for (let i = 0; i < rows.length; i++) {
      await expect(rows[i]).toBeVisible();
      await expect(rows[i]).toContainText(definitions[i].name);
    }
    await expect(rows[0].locator('textarea')).toHaveValue('Visible custom text');
    await expect(rows[1].locator('input')).toHaveValue('7');
    await expect(rows[2].getByTestId('affine-checkbox')).toBeChecked();
    await expect(rows[3]).toContainText('2026');
    await rows[0].locator('textarea').fill('Edited in AFFiNE');
    await rows[1].click();
    await expect.poll(async () => {
      const listed = await call('list_doc_properties', { workspaceId, docId });
      return listed.properties.find((entry: any) => entry.propertyId === definitions[0].propertyId)?.value;
    }).toBe('Edited in AFFiNE');
    await call('clear_doc_property', { workspaceId, docId, property: definitions[0].propertyId });
    await expect(rows[0].locator('textarea')).toHaveValue('');
    await call('delete_custom_property', { workspaceId, property: definitions[1].propertyId });
    await expect(rows[1]).toHaveCount(0);
  });

  test('plain and updated comments render their actual text', async ({ page }) => {
    const comment = await call('create_comment', { workspaceId, docId, content: 'Visible MCP comment' });
    // The native comment deep link opens the sidebar without creating another comment.
    await openDoc(page, comment.id);
    const row = page.locator(`[data-comment-id="${comment.id}"]`);
    await expect(row).toBeVisible();
    await expect(row.locator('.comment-editor-viewport[data-readonly="true"]')).toContainText('Visible MCP comment');
    await call('update_comment', { id: comment.id, content: { text: 'Visible updated comment' } });
    await expect(row.locator('.comment-editor-viewport[data-readonly="true"]')).toContainText('Visible updated comment');
    await call('delete_comment', { id: comment.id });
    await expect(row).toHaveCount(0);
  });
});
