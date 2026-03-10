import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TestState {
  baseUrl: string;
  email: string;
  workspaceId: string;
  docId: string;
  dataViewBlockId: string;
  groupLabels: string[];
  rowTitles: string[];
  error?: string;
}

const STATE_PATH = path.resolve(__dirname, '..', 'test-data-view-state.json');

let state: TestState;

test.beforeAll(() => {
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error(
      `State file not found: ${STATE_PATH}\n` +
      'Run "npm run test:data-view" first to create MCP test data.',
    );
  }
  state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  if (state.error) {
    throw new Error(`State file contains error from data view test: ${state.error}`);
  }
  if (!state.workspaceId || !state.docId || !state.dataViewBlockId) {
    throw new Error('State file missing workspaceId, docId, or dataViewBlockId');
  }
});

const password = process.env.AFFINE_ADMIN_PASSWORD!;
if (!password) throw new Error('AFFINE_ADMIN_PASSWORD env var required');

test.describe.serial('AFFiNE Data View Verification', () => {
  test('login to AFFiNE', async ({ page, context }) => {
    await page.goto(`${state.baseUrl}/sign-in`);
    await page.waitForLoadState('domcontentloaded');

    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email"]');
    await emailInput.waitFor({ timeout: 30_000 });
    await emailInput.fill(state.email);

    const continueBtn = page.locator(
      'button:has-text("Continue with email"), button:has-text("Continue"), button[type="submit"]',
    );
    await continueBtn.first().click();

    const passwordInput = page.locator('input[type="password"], input[name="password"]');
    await passwordInput.waitFor({ timeout: 15_000 });
    await passwordInput.fill(password);

    const signInBtn = page.locator(
      'button:has-text("Sign in"), button:has-text("Log in"), button[type="submit"]',
    );
    await signInBtn.first().click();

    await page.waitForURL(url => !url.toString().includes('/sign-in'), { timeout: 30_000 });

    for (let i = 0; i < 5; i++) {
      await page.waitForTimeout(1_000);
      const dismissBtn = page.locator(
        'button:has-text("Skip"), button:has-text("Got it"), button:has-text("Close"), ' +
        'button:has-text("Dismiss"), button:has-text("OK"), button:has-text("Later"), ' +
        '[data-testid="modal-close"], .modal-close, button[aria-label="Close"]',
      );
      if (await dismissBtn.count() > 0) {
        await dismissBtn.first().click({ timeout: 2_000 }).catch(() => {});
      } else {
        break;
      }
    }

    const storageStatePath = path.resolve(__dirname, '..', 'playwright-auth-state.json');
    await context.storageState({ path: storageStatePath });
  });

  test('verify kanban data view content in document', async ({ browser }) => {
    const storageStatePath = path.resolve(__dirname, '..', 'playwright-auth-state.json');
    const context = await browser.newContext({
      storageState: storageStatePath,
    });
    const page = await context.newPage();

    try {
      const docUrl = `${state.baseUrl}/workspace/${state.workspaceId}/${state.docId}`;
      await page.goto(docUrl);
      await page.waitForLoadState('domcontentloaded');

      if (page.url().includes('/sign-in')) {
        throw new Error('Redirected to sign-in — login test did not persist auth state');
      }

      for (let i = 0; i < 3; i++) {
        await page.waitForTimeout(1_000);
        const dismissBtn = page.locator(
          'button:has-text("Skip"), button:has-text("Got it"), button:has-text("Close"), ' +
          'button:has-text("Dismiss"), button:has-text("OK"), button:has-text("Later"), ' +
          '[data-testid="modal-close"], .modal-close, button[aria-label="Close"]',
        );
        if (await dismissBtn.count() > 0) {
          await dismissBtn.first().click({ timeout: 2_000 }).catch(() => {});
        } else {
          break;
        }
      }

      await page.waitForTimeout(5_000);

      const kanbanGroup = page.locator('affine-data-view-kanban-group');
      await expect(kanbanGroup.first()).toBeVisible({ timeout: 30_000 });

      const kanbanCard = page.locator('affine-data-view-kanban-card');
      await expect(kanbanCard.first()).toBeVisible({ timeout: 10_000 });
      await expect(kanbanCard).toHaveCount(2, { timeout: 10_000 });

      for (const label of state.groupLabels) {
        await expect(page.getByText(label, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
      }

      for (const title of state.rowTitles) {
        await expect(page.getByText(title, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
      }
    } finally {
      await context.close();
    }
  });
});
