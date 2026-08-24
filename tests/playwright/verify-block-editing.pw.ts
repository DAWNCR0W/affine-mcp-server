import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signInToAffine } from './sign-in.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_PATH = path.resolve(__dirname, '..', 'test-block-editing-state.json');
const AUTH_STATE_PATH = path.resolve(__dirname, '..', 'playwright-auth-state.json');

interface TestState {
  baseUrl: string;
  email: string;
  workspaceId: string;
  docId: string;
  taskBlockId: string;
  taskText: string;
  oldTaskText: string;
  doneHeadingText: string;
  deletedText: string;
  error?: string;
}

let state: TestState;
const password = process.env.AFFINE_ADMIN_PASSWORD!;
if (!password) throw new Error('AFFINE_ADMIN_PASSWORD env var required');

test.beforeAll(() => {
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error(`State file not found: ${STATE_PATH}\nRun "npm run test:block-editing" first.`);
  }
  state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  if (state.error) throw new Error(`State file contains an integration-test error: ${state.error}`);
  if (!state.workspaceId || !state.docId || !state.taskBlockId) {
    throw new Error('State file is missing workspaceId, docId, or taskBlockId');
  }
});

test.describe.serial('AFFiNE block editing verification', () => {
  test('login to AFFiNE', async ({ page, context }) => {
    test.setTimeout(180_000);
    await signInToAffine(page, { baseUrl: state.baseUrl, email: state.email, password });
    await context.storageState({ path: AUTH_STATE_PATH });
  });

  test('render the updated, checked, and moved block', async ({ browser }) => {
    const context = await browser.newContext({ storageState: AUTH_STATE_PATH });
    const page = await context.newPage();
    try {
      await page.goto(`${state.baseUrl}/workspace/${state.workspaceId}/${state.docId}`);
      await page.waitForLoadState('domcontentloaded');
      if (page.url().includes('/sign-in')) {
        throw new Error('Redirected to sign-in — login state was not persisted');
      }

      const taskBlock = page.locator('affine-list').filter({ hasText: state.taskText }).first();
      await expect(taskBlock).toBeVisible({ timeout: 30_000 });
      await expect(taskBlock.locator('.affine-list--checked')).toHaveCount(1);
      await expect(page.getByText(state.oldTaskText, { exact: true })).toHaveCount(0);
      await expect(page.getByText(state.deletedText, { exact: true })).toHaveCount(0);

      const renderedText = await page.locator('affine-paragraph, affine-list').allTextContents();
      const doneIndex = renderedText.findIndex(value => value.includes(state.doneHeadingText));
      const taskIndex = renderedText.findIndex(value => value.includes(state.taskText));
      expect(doneIndex).toBeGreaterThanOrEqual(0);
      expect(taskIndex).toBe(doneIndex + 1);
    } finally {
      await context.close();
    }
  });
});
