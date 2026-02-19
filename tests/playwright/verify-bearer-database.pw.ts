import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface BearerTestState {
  baseUrl: string;
  email: string;
  authMode: string;
  tokenId: string | null;
  workspaceId: string;
  workspaceName: string;
  docId: string;
  docTitle: string;
  databaseBlockId: string;
  columns: Array<{ name: string; type: string; columnId: string | null }>;
  rows: Array<{ cells: Record<string, unknown>; rowId: string | null }>;
  error?: string;
}

const STATE_PATH = path.resolve(__dirname, '..', 'test-bearer-state.json');

let state: BearerTestState;

test.beforeAll(() => {
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error(
      `State file not found: ${STATE_PATH}\n` +
      'Run "npm run test:bearer" first to create bearer auth test data.',
    );
  }
  state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  if (state.error) {
    throw new Error(`State file contains error from bearer test: ${state.error}`);
  }
  if (!state.workspaceId || !state.docId) {
    throw new Error('State file missing workspaceId or docId');
  }
  if (state.authMode !== 'bearer') {
    throw new Error(`Expected authMode "bearer", got "${state.authMode}"`);
  }
});

const password = process.env.AFFINE_ADMIN_PASSWORD!;
if (!password) throw new Error('AFFINE_ADMIN_PASSWORD env var required');

test.describe.serial('Bearer Auth Database Verification', () => {
  test('login to AFFiNE', async ({ page, context }) => {
    const baseUrl = state.baseUrl;

    await page.goto(`${baseUrl}/sign-in`);
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

    // Dismiss any onboarding modals
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

    expect(page.url()).not.toContain('/sign-in');

    const storageStatePath = path.resolve(__dirname, '..', 'playwright-auth-state.json');
    await context.storageState({ path: storageStatePath });
  });

  test('verify bearer-auth database content in document', async ({ browser }) => {
    const storageStatePath = path.resolve(__dirname, '..', 'playwright-auth-state.json');
    const context = await browser.newContext({
      storageState: storageStatePath,
    });
    const page = await context.newPage();

    try {
      const baseUrl = state.baseUrl;
      const docUrl = `${baseUrl}/workspace/${state.workspaceId}/${state.docId}`;

      await page.goto(docUrl);
      await page.waitForLoadState('domcontentloaded');

      if (page.url().includes('/sign-in')) {
        throw new Error('Redirected to sign-in — login test did not persist auth state');
      }

      // Dismiss any onboarding/update modals
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

      // Wait for content to render
      await page.waitForTimeout(5_000);

      // Verify database block is visible
      const databaseBlock = page.locator(
        'affine-database, [data-block-flavour="affine:database"], ' +
        '.affine-database-block-container, [class*="database"]',
      );
      await expect(databaseBlock.first()).toBeVisible({ timeout: 30_000 });

      // Verify column headers (Task, Owner, Score)
      const columnNames = ['Task', 'Owner', 'Score'];
      for (const colName of columnNames) {
        const colHeader = page.getByText(colName, { exact: true });
        await expect(colHeader.first()).toBeVisible({ timeout: 10_000 });
      }

      // Verify row content
      const rowNames = ['Design API', 'Write docs'];
      for (const name of rowNames) {
        const rowCell = page.getByText(name, { exact: true });
        await expect(rowCell.first()).toBeVisible({ timeout: 10_000 });
      }

      // Verify a select value is present
      const selectValue = page.getByText('Alice', { exact: true });
      await expect(selectValue.first()).toBeVisible({ timeout: 10_000 });
    } finally {
      await context.close();
    }
  });
});
