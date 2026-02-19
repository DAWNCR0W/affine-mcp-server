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
  workspaceName: string;
  docId: string;
  docTitle: string;
  databaseBlockId: string;
  columns: Array<{ name: string; type: string; columnId: string | null }>;
  rows: Array<{ cells: Record<string, unknown>; rowId: string | null }>;
  error?: string;
}

const STATE_PATH = path.resolve(__dirname, '..', 'test-database-state.json');

let state: TestState;

test.beforeAll(() => {
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error(
      `State file not found: ${STATE_PATH}\n` +
      'Run "npm run test:db-create" first to create MCP test data.',
    );
  }
  state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  if (state.error) {
    throw new Error(`State file contains error from MCP test: ${state.error}`);
  }
  if (!state.workspaceId || !state.docId) {
    throw new Error('State file missing workspaceId or docId');
  }
});

const password = process.env.AFFINE_ADMIN_PASSWORD || 'TestPass123';

test.describe.serial('AFFiNE Database Verification', () => {
  test('login to AFFiNE', async ({ page, context }) => {
    const baseUrl = state.baseUrl;

    // Navigate directly to the sign-in page
    await page.goto(`${baseUrl}/sign-in`);
    await page.waitForLoadState('domcontentloaded');

    // Fill email — the placeholder is "Enter your email address"
    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email"]');
    await emailInput.waitFor({ timeout: 30_000 });
    await emailInput.fill(state.email);

    // Click "Continue with email"
    const continueBtn = page.locator(
      'button:has-text("Continue with email"), button:has-text("Continue"), button[type="submit"]',
    );
    await continueBtn.first().click();

    // Fill password
    const passwordInput = page.locator('input[type="password"], input[name="password"]');
    await passwordInput.waitFor({ timeout: 15_000 });
    await passwordInput.fill(password);

    // Click sign in / submit
    const signInBtn = page.locator(
      'button:has-text("Sign in"), button:has-text("Log in"), button[type="submit"]',
    );
    await signInBtn.first().click();

    // Wait for redirect away from sign-in page
    await page.waitForURL(url => !url.toString().includes('/sign-in'), { timeout: 30_000 });

    // Dismiss any onboarding modals/dialogs that may appear
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

    // Verify we're logged in — URL should not contain sign-in
    expect(page.url()).not.toContain('/sign-in');

    // Save auth state for subsequent tests
    const storageStatePath = path.resolve(__dirname, '..', 'playwright-auth-state.json');
    await context.storageState({ path: storageStatePath });
  });

  test('verify database content in document', async ({ browser }) => {
    // Use saved auth state
    const storageStatePath = path.resolve(__dirname, '..', 'playwright-auth-state.json');
    const context = await browser.newContext({
      storageState: storageStatePath,
    });
    const page = await context.newPage();

    try {
      const baseUrl = state.baseUrl;
      const docUrl = `${baseUrl}/workspace/${state.workspaceId}/${state.docId}`;

      // Navigate directly to the document
      await page.goto(docUrl);
      await page.waitForLoadState('domcontentloaded');

      // If redirected to sign-in, fail early with useful message
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

      // Wait for the page content to render (AFFiNE SPA needs time)
      await page.waitForTimeout(5_000);

      // Verify database block is visible
      const databaseBlock = page.locator(
        'affine-database, [data-block-flavour="affine:database"], ' +
        '.affine-database-block-container, [class*="database"]',
      );
      await expect(databaseBlock.first()).toBeVisible({ timeout: 30_000 });

      // Verify column headers
      const columnNames = ['Name', 'Status', 'Priority', 'Done'];
      for (const colName of columnNames) {
        const colHeader = page.getByText(colName, { exact: true });
        await expect(colHeader.first()).toBeVisible({ timeout: 10_000 });
      }

      // Verify row content — check that each row's Name value appears
      const rowNames = ['Build feature', 'Write tests', 'Deploy release'];
      for (const name of rowNames) {
        const rowCell = page.getByText(name, { exact: true });
        await expect(rowCell.first()).toBeVisible({ timeout: 10_000 });
      }

      // Verify a select value is present
      const selectValue = page.getByText('Active', { exact: true });
      await expect(selectValue.first()).toBeVisible({ timeout: 10_000 });
    } finally {
      await context.close();
    }
  });
});
