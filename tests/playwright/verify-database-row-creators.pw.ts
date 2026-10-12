import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';

import { testRunId, testTempPath } from '../require-destructive-test-safety.mjs';
import { assertDestructiveTestTarget } from '../live-test-safety.mjs';
import { acquireCredentials } from '../acquire-credentials.mjs';
import { connectWorkspaceSocket, joinWorkspace, loadDoc, wsUrlFromGraphQLEndpoint } from '../../dist/ws.js';
import { signInToAffine } from './sign-in.js';

type PersistedRow = { rowBlockId: string; createdBy: string; createdAt: number; title: string };
type CreatorState = {
  runId: string;
  baseUrl: string;
  workspaceId: string;
  author: { id: string; name: string };
  editor: { id: string; name: string };
  editorEmail: string;
  pages: Array<{
    docId: string;
    databaseBlockId: string;
    titleColumnId: string;
    creatorColumnId: string;
    rows: PersistedRow[];
  }>;
  bRow: PersistedRow;
};

const statePath = path.join(testTempPath('test-artifacts'), 'database-row-creators-state.json');
const password = process.env.AFFINE_ADMIN_PASSWORD || process.env.AFFINE_PASSWORD;
if (!password) throw new Error('AFFINE_ADMIN_PASSWORD is required');

async function persistedRow(state: CreatorState, cookie: string, docId: string, rowId: string) {
  const socket = await connectWorkspaceSocket(wsUrlFromGraphQLEndpoint(`${state.baseUrl}/graphql`), cookie);
  const doc = new Y.Doc();
  try {
    await joinWorkspace(socket, state.workspaceId);
    const snapshot = await loadDoc(socket, state.workspaceId, docId);
    if (!snapshot.missing) throw new Error(`Page ${docId} has no persisted snapshot`);
    Y.applyUpdate(doc, Buffer.from(snapshot.missing, 'base64'));
    const row = doc.getMap('blocks').get(rowId) as Y.Map<unknown>;
    return {
      title: row.get('prop:text')?.toString(),
      createdBy: row.get('prop:meta:createdBy'),
      createdAt: row.get('prop:meta:createdAt'),
    };
  } finally {
    doc.destroy();
    socket.disconnect();
  }
}

test('row creation metadata survives actual AFFiNE edits by a different account', async ({ browser }) => {
  test.setTimeout(240_000);
  if (!fs.existsSync(statePath)) throw new Error('Run test-database-row-creators.mjs in the same AFFINE_TEST_TMP_DIR first');
  const state: CreatorState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  expect(state.runId).toBe(testRunId);
  assertDestructiveTestTarget({ target: state.baseUrl });
  expect(state.editor.id).not.toBe(state.author.id);
  const { cookie } = await acquireCredentials(state.baseUrl, state.editorEmail, password);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await signInToAffine(page, { baseUrl: state.baseUrl, email: state.editorEmail, password });
    const browserUserId = await page.evaluate(async () => {
      const response = await fetch('/graphql', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'query RowEditorIdentity { currentUser { id } }' }),
      });
      return (await response.json()).data?.currentUser?.id;
    });
    expect(browserUserId).toBe(state.editor.id);

    for (const document of state.pages) {
      await page.goto(`${state.baseUrl}/workspace/${state.workspaceId}/${document.docId}`, { waitUntil: 'domcontentloaded' });
      const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true });
      if (await dismiss.count()) await dismiss.first().click();
      for (const row of document.rows) {
        const titleCell = page.locator(`dv-table-view-cell-container[data-row-id="${row.rowBlockId}"][data-column-id="${document.titleColumnId}"]`);
        const creatorCell = page.locator(`dv-table-view-cell-container[data-row-id="${row.rowBlockId}"][data-column-id="${document.creatorColumnId}"]`);
        await expect(titleCell).toContainText(row.title);
        await expect(creatorCell).toContainText(state.author.name);
        const titleText = titleCell.locator('data-view-header-area-text rich-text').first();
        await titleText.click();
        await page.keyboard.press('Enter');
        await expect(titleCell).toHaveAttribute('data-editing', 'true');
        // Native editing entry places the caret asynchronously; wait for this row to own it.
        await expect.poll(() => titleText.evaluate(element => {
          const selection = element.ownerDocument.getSelection();
          if (!selection?.isCollapsed || !selection.anchorNode || !selection.focusNode) return false;
          return element.contains(selection.anchorNode) && element.contains(selection.focusNode);
        }), { message: 'the native title editor owns the collapsed text selection' }).toBe(true);
        const suffix = ' (edited in AFFiNE by B)';
        const editedTitle = `${row.title}${suffix}`;
        await page.keyboard.insertText(suffix);
        await expect(titleCell).toContainText(editedTitle);
        await page.keyboard.press('Escape');
        await expect.poll(() => persistedRow(state, cookie, document.docId, row.rowBlockId), {
          timeout: 30_000,
          message: 'the UI title edit updates the actual row block while preserving A and its original creation timestamp',
        }).toEqual({ title: editedTitle, createdBy: state.author.id, createdAt: row.createdAt });
        await expect(creatorCell).toContainText(state.author.name);
      }
      await page.reload({ waitUntil: 'domcontentloaded' });
      for (const row of document.rows) {
        const titleCell = page.locator(`dv-table-view-cell-container[data-row-id="${row.rowBlockId}"][data-column-id="${document.titleColumnId}"]`);
        const creatorCell = page.locator(`dv-table-view-cell-container[data-row-id="${row.rowBlockId}"][data-column-id="${document.creatorColumnId}"]`);
        await expect(titleCell).toContainText(`${row.title} (edited in AFFiNE by B)`);
        await expect(creatorCell).toContainText(state.author.name);
      }
      if (document.docId === state.pages[0].docId) {
        const bCreatorCell = page.locator(`dv-table-view-cell-container[data-row-id="${state.bRow.rowBlockId}"][data-column-id="${document.creatorColumnId}"]`);
        await expect(bCreatorCell).toContainText(state.editor.name);
        expect(await persistedRow(state, cookie, document.docId, state.bRow.rowBlockId)).toEqual({
          title: state.bRow.title, createdBy: state.editor.id, createdAt: state.bRow.createdAt,
        });
      }
    }
  } finally { await context.close(); }
});
