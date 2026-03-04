import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TagVisibilityState {
  baseUrl: string;
  email: string;
  workspaceId: string;
  workspaceName: string;
  docId: string;
  docTitle: string;
  tag: string;
  error?: string;
}

const STATE_PATH = path.resolve(__dirname, '..', 'test-tag-visibility-state.json');
const AUTH_STATE_PATH = path.resolve(__dirname, '..', 'playwright-auth-state.json');

let state: TagVisibilityState;

test.beforeAll(() => {
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error(
      `State file not found: ${STATE_PATH}\n` +
      'Run "node tests/test-tag-visibility.mjs" first to create tag visibility test data.',
    );
  }
  state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  if (state.error) {
    throw new Error(`State file contains error from MCP test: ${state.error}`);
  }
  if (!state.workspaceId || !state.docId || !state.tag) {
    throw new Error('State file missing workspaceId, docId, or tag');
  }
});

const password = process.env.AFFINE_ADMIN_PASSWORD!;
if (!password) throw new Error('AFFINE_ADMIN_PASSWORD env var required');

async function dismissModals(page: any, rounds: number) {
  for (let i = 0; i < rounds; i++) {
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
}

test.describe.serial('Tag Visibility Verification', () => {
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
    await dismissModals(page, 5);

    expect(page.url()).not.toContain('/sign-in');
    await context.storageState({ path: AUTH_STATE_PATH });
  });

  test('verify tag is visible in document UI', async ({ browser }) => {
    const context = await browser.newContext({
      storageState: AUTH_STATE_PATH,
    });
    const page = await context.newPage();

    try {
      const docUrl = `${state.baseUrl}/workspace/${state.workspaceId}/${state.docId}`;
      await page.goto(docUrl);
      await page.waitForLoadState('domcontentloaded');

      if (page.url().includes('/sign-in')) {
        throw new Error('Redirected to sign-in — login test did not persist auth state');
      }

      await dismissModals(page, 4);
      await page.waitForTimeout(5_000);

      const tagValue = page.locator('[data-testid="property-tags-value"]').filter({ hasText: state.tag }).first();

      // If properties are collapsed, expand Info first.
      if (await tagValue.count() === 0) {
        const infoHeaderButton = page.getByRole('button', { name: 'Info' }).first();
        if (await infoHeaderButton.count()) {
          await infoHeaderButton.click({ timeout: 2_000 }).catch(() => {});
          await page.waitForTimeout(1_000);
        }
      }

      // If Workspace properties are collapsed, expand the section.
      if (await tagValue.count() === 0) {
        const workspaceTrigger = page.locator('[data-testid="property-collapsible-section-trigger"]').first();
        if (await workspaceTrigger.count()) {
          await workspaceTrigger.click({ timeout: 2_000 }).catch(() => {});
          await page.waitForTimeout(1_000);
        }
      }

      await expect(tagValue).toBeVisible({ timeout: 20_000 });
    } finally {
      await context.close();
    }
  });
});
