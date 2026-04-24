import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ThemeState {
  baseUrl: string;
  email: string;
  workspaceId: string;
  docId: string;
  docUrl: string;
  expectations: {
    shape: { id: string; fillColor: string; strokeColor: string; color: string };
    connector: { id: string; stroke: string; labelColor: string };
    canvasText: { id: string; color: string };
    noteBackgrounds: {
      adaptiveToken: { blockId: string; background: string };
      lightDarkObj:  { blockId: string; background: { light: string; dark: string } };
      paletteShape:  { blockId: string; background: string };
      rawHex:        { blockId: string; background: string };
    };
  };
}

const STATE_PATH = path.resolve(__dirname, '..', 'test-theme-defaults-state.json');

let state: ThemeState;

test.beforeAll(() => {
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error(
      `State file not found: ${STATE_PATH}\n` +
      'Run "node tests/test-theme-defaults-setup.mjs" first.',
    );
  }
  state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
});

const password = process.env.AFFINE_ADMIN_PASSWORD!;
if (!password) throw new Error('AFFINE_ADMIN_PASSWORD env var required');

// Canvas elements aren't DOM-addressable — verify the theme tokens shift between modes,
// and backstop the CRDT-level conventions via the state file.
const ADAPTIVE_TOKENS = [
  '--affine-text-primary-color',
  '--affine-background-primary-color',
];
const FIXED_TOKENS = [
  '--affine-palette-shape-blue',
  '--affine-palette-shape-white',
  '--affine-palette-line-black',
];

async function readTokens(page, names: string[]): Promise<Record<string, string>> {
  return await page.evaluate((toks: string[]) => {
    const style = getComputedStyle(document.documentElement);
    const out: Record<string, string> = {};
    for (const t of toks) out[t] = style.getPropertyValue(t).trim();
    return out;
  }, names);
}

test.describe.serial('AFFiNE theme-adaptation invariants', () => {
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

    const storageStatePath = path.resolve(__dirname, '..', 'playwright-auth-state.json');
    await context.storageState({ path: storageStatePath });
  });

  test('adaptive tokens shift between light and dark; fixed tokens do not', async ({ browser }) => {
    const storageStatePath = path.resolve(__dirname, '..', 'playwright-auth-state.json');

    const lightCtx = await browser.newContext({ storageState: storageStatePath, colorScheme: 'light' });
    const lightPage = await lightCtx.newPage();
    await lightPage.goto(state.docUrl);
    await lightPage.waitForLoadState('domcontentloaded');
    await lightPage.waitForTimeout(2_000);
    await lightPage.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await lightPage.waitForTimeout(500);
    const lightTokens = await readTokens(lightPage, [...ADAPTIVE_TOKENS, ...FIXED_TOKENS]);
    await lightCtx.close();

    const darkCtx = await browser.newContext({ storageState: storageStatePath, colorScheme: 'dark' });
    const darkPage = await darkCtx.newPage();
    await darkPage.goto(state.docUrl);
    await darkPage.waitForLoadState('domcontentloaded');
    await darkPage.waitForTimeout(2_000);
    await darkPage.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await darkPage.waitForTimeout(500);
    const darkTokens = await readTokens(darkPage, [...ADAPTIVE_TOKENS, ...FIXED_TOKENS]);
    await darkCtx.close();

    for (const tok of ADAPTIVE_TOKENS) {
      expect(lightTokens[tok], `${tok} should resolve in light mode`).toBeTruthy();
      expect(darkTokens[tok], `${tok} should resolve in dark mode`).toBeTruthy();
      expect(lightTokens[tok], `${tok}: expected different values in light vs dark`)
        .not.toEqual(darkTokens[tok]);
    }
    for (const tok of FIXED_TOKENS) {
      expect(lightTokens[tok]).toBeTruthy();
      expect(darkTokens[tok]).toBeTruthy();
      expect(lightTokens[tok], `${tok}: expected same value in both themes (palette tokens are fixed user colors)`)
        .toEqual(darkTokens[tok]);
    }
  });

  test('shape defaults are fixed (palette tokens + literal #000000 label)', async () => {
    const { shape } = state.expectations;
    expect(shape.fillColor).toMatch(/^--affine-palette-shape-/);
    expect(shape.strokeColor).toMatch(/^--affine-palette-line-/);
    expect(shape.color).toBe('#000000');
  });

  test('connector + canvas-text defaults are theme-adaptive (--affine-text-*)', async () => {
    const { connector, canvasText } = state.expectations;
    expect(connector.stroke).toMatch(/^--affine-text-/);
    expect(connector.labelColor).toMatch(/^--affine-text-/);
    expect(canvasText.color).toMatch(/^--affine-text-/);
    // None of these should be raw hex — that would defeat theme adaptation.
    const rawHex = /^#[0-9a-f]{3,8}$/i;
    expect(connector.stroke).not.toMatch(rawHex);
    expect(connector.labelColor).not.toMatch(rawHex);
    expect(canvasText.color).not.toMatch(rawHex);
  });

  test('note background forms pass through as-is', async () => {
    const { noteBackgrounds } = state.expectations;

    // 1) Adaptive token — AFFiNE's own note-background family
    expect(noteBackgrounds.adaptiveToken.background).toBe('--affine-note-background-blue');

    // 2) {light, dark} object — stored with both keys
    expect(noteBackgrounds.lightDarkObj.background.light).toBe('#ffffff');
    expect(noteBackgrounds.lightDarkObj.background.dark).toBe('#252525');
    expect(noteBackgrounds.lightDarkObj.background.light).not.toEqual(
      noteBackgrounds.lightDarkObj.background.dark,
    );

    // 3) Fixed palette-shape token — passed through (not translated)
    expect(noteBackgrounds.paletteShape.background).toBe('--affine-palette-shape-yellow');

    // 4) Raw hex — literal, no theme adaptation
    expect(noteBackgrounds.rawHex.background).toBe('#fab6b6');
  });
});
