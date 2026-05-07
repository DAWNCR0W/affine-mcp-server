import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface EdgelessState {
  baseUrl: string;
  email: string;
  workspaceId: string;
  docId: string;
  docUrl: string;
  expectations: {
    defaultNoteXywh: string;
    userNote: { blockId: string; heading: string; bullets: string[] };
    frame: { blockId: string; title: string; childElementIds: string[] };
    connector: { elementId: string; label: string; labelXYWH: number[] };
    shapeA: { id: string; text: string };
    shapeB: { id: string; text: string };
  };
}

const STATE_PATH = path.resolve(__dirname, '..', 'test-edgeless-state.json');

let state: EdgelessState;

test.beforeAll(() => {
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error(
      `State file not found: ${STATE_PATH}\n` +
      'Run "npm run test:edgeless-seed" first to create the MCP-seeded doc.',
    );
  }
  state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  if (!state.workspaceId || !state.docId) {
    throw new Error('State file missing workspaceId or docId');
  }
});

const password = process.env.AFFINE_ADMIN_PASSWORD!;
if (!password) throw new Error('AFFINE_ADMIN_PASSWORD env var required');

async function openDocInEdgelessMode(page: Page) {
  await page.goto(state.docUrl);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2_000);

  // Dismiss "Open in app" prompt if present — can shift layout + block clicks.
  const dismissAppPrompt = page.locator('button:has-text("Dismiss"), button:has-text("Remember choice")').first();
  if (await dismissAppPrompt.isVisible().catch(() => false)) {
    await dismissAppPrompt.click({ timeout: 2_000 }).catch(() => {});
  }

  // Edgeless-mode toggle — selectors have drifted across AFFiNE versions.
  const edgelessToggle = page.locator(
    [
      '[data-testid="switch-edgeless-mode-button"]',
      '[data-testid="switch-edgeless"]',
      'button[aria-label*="Edgeless" i]',
      'button[aria-label*="edgeless" i]',
      'edgeless-mode-button',
    ].join(', '),
  );
  const toggle = edgelessToggle.first();
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click({ timeout: 5_000 }).catch(() => {});
  } else {
    const headerButtons = page.locator('header button, [class*="header"] button');
    const count = await headerButtons.count();
    for (let i = 0; i < Math.min(count, 8); i++) {
      const label = (await headerButtons.nth(i).getAttribute('aria-label')) || '';
      if (/edgeless/i.test(label)) {
        await headerButtons.nth(i).click().catch(() => {});
        break;
      }
    }
  }
  await page.waitForTimeout(3_000);
}

test.describe.serial('AFFiNE Edgeless Canvas Verification', () => {
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

    expect(page.url()).not.toContain('/sign-in');

    const storageStatePath = path.resolve(__dirname, '..', 'playwright-auth-state.json');
    await context.storageState({ path: storageStatePath });
  });

  test('edgeless mode paints a canvas with nonzero dimensions', async ({ browser }) => {
    const storageStatePath = path.resolve(__dirname, '..', 'playwright-auth-state.json');
    const context = await browser.newContext({ storageState: storageStatePath });
    const page = await context.newPage();
    try {
      await openDocInEdgelessMode(page);
      const canvas = page.locator('canvas').first();
      await expect(canvas, 'edgeless mode should paint at least one <canvas>').toBeVisible({ timeout: 15_000 });
      const box = await canvas.boundingBox();
      expect(box?.width ?? 0, 'canvas width should be > 0').toBeGreaterThan(0);
      expect(box?.height ?? 0, 'canvas height should be > 0').toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });

  test('user note renders markdown children as real DOM', async ({ browser }) => {
    const storageStatePath = path.resolve(__dirname, '..', 'playwright-auth-state.json');
    const context = await browser.newContext({ storageState: storageStatePath });
    const page = await context.newPage();
    try {
      await openDocInEdgelessMode(page);
      // Markdown-seeded children (heading + bullet fragments) are real DOM;
      // shapes/connector text live on <canvas> and are checked via CRDT only.
      const { heading, bullets } = state.expectations.userNote;
      await expect(
        page.getByText(heading, { exact: false }).first(),
        `user-note heading "${heading}" visible on edgeless canvas`,
      ).toBeVisible({ timeout: 15_000 });
      for (const fragment of bullets) {
        await expect(
          page.getByText(fragment, { exact: false }).first(),
          `user-note bullet fragment "${fragment}" visible`,
        ).toBeVisible({ timeout: 5_000 });
      }
    } finally {
      await context.close();
    }
  });

  // CRDT-level invariants (default-note xywh, connector labelXYWH, frame
  // childElementIds, user-note stacked below default) are asserted by the
  // seeder against get_edgeless_canvas before this Playwright run.
});
