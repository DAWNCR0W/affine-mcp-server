import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

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

const password = process.env.AFFINE_ADMIN_PASSWORD || 'TestPass1!@#';

test.describe('AFFiNE Database Verification', () => {
  test('login to AFFiNE', async ({ page }) => {
    const baseUrl = state.baseUrl;

    // Navigate to AFFiNE
    await page.goto(baseUrl);

    // Wait for the page to load — AFFiNE may redirect to sign-in
    await page.waitForLoadState('networkidle', { timeout: 30_000 });

    // If already logged in, skip login flow
    const url = page.url();
    if (!url.includes('sign-in') && !url.includes('signin') && !url.includes('login')) {
      // Check if there's a sign-in link/button on the page
      const signInLink = page.locator('a[href*="sign-in"], button:has-text("Sign in"), a:has-text("Sign in")');
      if (await signInLink.count() > 0) {
        await signInLink.first().click();
        await page.waitForLoadState('networkidle');
      } else {
        // Already logged in
        return;
      }
    }

    // Fill email
    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="mail"]');
    await emailInput.waitFor({ timeout: 15_000 });
    await emailInput.fill(state.email);

    // Click continue/next
    const continueBtn = page.locator(
      'button:has-text("Continue"), button:has-text("Next"), button[type="submit"]',
    );
    await continueBtn.first().click();

    // Fill password
    const passwordInput = page.locator('input[type="password"], input[name="password"]');
    await passwordInput.waitFor({ timeout: 15_000 });
    await passwordInput.fill(password);

    // Click sign in
    const signInBtn = page.locator(
      'button:has-text("Sign in"), button:has-text("Log in"), button[type="submit"]',
    );
    await signInBtn.first().click();

    // Wait for navigation to complete
    await page.waitForLoadState('networkidle', { timeout: 30_000 });

    // Dismiss any onboarding modals/dialogs that may appear
    for (let i = 0; i < 5; i++) {
      const dismissBtn = page.locator(
        'button:has-text("Skip"), button:has-text("Got it"), button:has-text("Close"), ' +
        'button:has-text("Dismiss"), button:has-text("OK"), button:has-text("Later"), ' +
        '[data-testid="modal-close"], .modal-close, button[aria-label="Close"]',
      );
      if (await dismissBtn.count() > 0) {
        await dismissBtn.first().click();
        await page.waitForTimeout(500);
      } else {
        break;
      }
    }

    // Verify we're logged in — URL should not contain sign-in anymore
    await expect(page).not.toHaveURL(/sign-in|signin|login/, { timeout: 15_000 });
  });

  test('verify database content in document', async ({ page }) => {
    const baseUrl = state.baseUrl;
    const docUrl = `${baseUrl}/workspace/${state.workspaceId}/${state.docId}`;

    // Navigate directly to the document
    await page.goto(docUrl);
    await page.waitForLoadState('networkidle', { timeout: 30_000 });

    // Dismiss any onboarding/update modals
    for (let i = 0; i < 3; i++) {
      const dismissBtn = page.locator(
        'button:has-text("Skip"), button:has-text("Got it"), button:has-text("Close"), ' +
        'button:has-text("Dismiss"), button:has-text("OK"), button:has-text("Later"), ' +
        '[data-testid="modal-close"], .modal-close, button[aria-label="Close"]',
      );
      if (await dismissBtn.count() > 0) {
        await dismissBtn.first().click();
        await page.waitForTimeout(500);
      } else {
        break;
      }
    }

    // Wait for document title to appear
    const docTitle = page.locator(
      '[data-block-flavour="affine:page"] [data-block-is-title="true"], ' +
      '.doc-title, .affine-doc-page-block-title, ' +
      '[class*="title"]',
    );
    await docTitle.first().waitFor({ timeout: 30_000 });

    // Verify database block is visible
    const databaseBlock = page.locator(
      'affine-database, [data-block-flavour="affine:database"], ' +
      '.affine-database-block-container, [class*="database"]',
    );
    await expect(databaseBlock.first()).toBeVisible({ timeout: 30_000 });

    // Verify column headers
    const columnNames = ['Name', 'Status', 'Priority', 'Done'];
    for (const colName of columnNames) {
      const colHeader = page.locator(`text="${colName}"`);
      await expect(colHeader.first()).toBeVisible({ timeout: 10_000 });
    }

    // Verify row content — check that each row's Name value appears
    const rowNames = ['Build feature', 'Write tests', 'Deploy release'];
    for (const name of rowNames) {
      const rowCell = page.locator(`text="${name}"`);
      await expect(rowCell.first()).toBeVisible({ timeout: 10_000 });
    }

    // Verify a select value is present
    const selectValue = page.locator('text="Active"');
    await expect(selectValue.first()).toBeVisible({ timeout: 10_000 });
  });
});
