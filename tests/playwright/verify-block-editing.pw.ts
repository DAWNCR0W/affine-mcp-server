import { test, expect, type Locator } from '@playwright/test';
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
  documentTitle: string;
  updatedDate: number;
  creatorId: string;
  creatorName: string;
  taskBlockId: string;
  tableBlockId: string;
  taskText: string;
  oldTaskText: string;
  inboxHeadingText: string;
  coloredSegment: string;
  highlightedSegment: string;
  doneHeadingText: string;
  deletedText: string;
  tableHeaderText: string;
  tableCellText: string;
  tableLinkUrl: string;
  tableSiblingHeaderText: string;
  tableSiblingDataText: string;
  referenceBlockId: string;
  referenceTableBlockId: string;
  referenceTargetTitle: string;
  error?: string;
}

let state: TestState;
const password = process.env.AFFINE_ADMIN_PASSWORD!;
if (!password) throw new Error('AFFINE_ADMIN_PASSWORD env var required');

async function segmentStyles(block: Locator, segment: string) {
  return block.evaluate((root, target) => {
    const walker = root.ownerDocument.createTreeWalker(root, 4);
    let textNode = walker.nextNode();
    while (textNode && !textNode.textContent?.includes(target)) {
      textNode = walker.nextNode();
    }
    if (!textNode) return null;

    const rootColor = getComputedStyle(root).color;
    let color = rootColor;
    let backgroundColor = 'rgba(0, 0, 0, 0)';
    const inlineStyles: string[] = [];
    let element = textNode.parentElement;
    while (element && element !== root) {
      const computed = getComputedStyle(element);
      const inlineStyle = element.getAttribute('style');
      if (inlineStyle) inlineStyles.push(inlineStyle);
      if (computed.color !== rootColor) color = computed.color;
      if (computed.backgroundColor !== 'rgba(0, 0, 0, 0)' && computed.backgroundColor !== 'transparent') {
        backgroundColor = computed.backgroundColor;
      }
      element = element.parentElement;
    }
    return { rootColor, color, backgroundColor, inlineStyles };
  }, segment);
}

test.beforeAll(() => {
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error(`State file not found: ${STATE_PATH}\nRun "npm run test:block-editing" first.`);
  }
  state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  if (state.error) throw new Error(`State file contains an integration-test error: ${state.error}`);
  if (!state.workspaceId || !state.docId || !state.taskBlockId || !state.tableBlockId) {
    throw new Error('State file is missing workspaceId, docId, taskBlockId, or tableBlockId');
  }
  if (!state.creatorId || !state.creatorName) {
    throw new Error('State file is missing the authenticated creator identity');
  }
  if (!Number.isFinite(state.updatedDate) || state.updatedDate <= 0) {
    throw new Error('State file is missing a valid root meta.pages[].updatedDate');
  }
});

test.describe.serial('AFFiNE block editing verification', () => {
  test('login to AFFiNE', async ({ page, context }) => {
    test.setTimeout(180_000);
    await signInToAffine(page, { baseUrl: state.baseUrl, email: state.email, password });
    await context.storageState({ path: AUTH_STATE_PATH });
  });

  test('group the MCP-written document under its updated date before opening it', async ({ browser }) => {
    const context = await browser.newContext({ storageState: AUTH_STATE_PATH });
    const page = await context.newPage();
    try {
      // All Docs defaults to Updated grouping. Visit it before the editor can
      // write metadata itself and hide a missing MCP updatedDate.
      await page.goto(`${state.baseUrl}/workspace/${state.workspaceId}/all`);
      const dateKey = await page.evaluate((updatedDate) => {
        const date = new Date(updatedDate);
        return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
      }, state.updatedDate);
      const row = page.locator(`[data-masonry-item-id="${dateKey}:${state.docId}"] [data-testid="doc-list-item"][data-doc-id="${state.docId}"]`);
      await expect(row).toBeVisible();
      await expect(row).toContainText(state.documentTitle);
      await expect(page.locator(`[data-masonry-item-id="${state.docId}"]`)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('show the authenticated creator in the native page properties', async ({ browser }) => {
    const context = await browser.newContext({ storageState: AUTH_STATE_PATH });
    const page = await context.newPage();
    try {
      await page.goto(`${state.baseUrl}/workspace/${state.workspaceId}/${state.docId}`);
      // The integration test has already checked the stored record before the
      // browser can run any migration. Only expand the native properties UI.
      await page.getByTestId('page-info-collapse').click();
      const creator = page.locator('[data-testid="doc-property-row"][data-info-id="createdBy"]');
      await expect(creator).toBeAttached();
      if (!await creator.isVisible()) {
        await page.getByText(/^\d+ more propert/i).click();
      }
      await expect(creator).toBeVisible();
      await expect(creator).toContainText(state.creatorName);
      await expect(creator).not.toContainText('No Record');
    } finally {
      await context.close();
    }
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

      const inboxHeading = page.locator('affine-paragraph').filter({ hasText: state.inboxHeadingText }).first();
      await expect(inboxHeading).toBeVisible({ timeout: 30_000 });
      const coloredStyles = await segmentStyles(inboxHeading, state.coloredSegment);
      expect(coloredStyles, 'colored text segment was not rendered').not.toBeNull();
      expect(coloredStyles?.color).not.toBe(coloredStyles?.rootColor);

      const highlightedStyles = await segmentStyles(taskBlock, state.highlightedSegment);
      expect(highlightedStyles, 'highlighted text segment was not rendered').not.toBeNull();
      expect(highlightedStyles?.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(highlightedStyles?.backgroundColor).not.toBe('transparent');

      const renderedText = await page.locator('affine-paragraph, affine-list').allTextContents();
      const doneIndex = renderedText.findIndex(value => value.includes(state.doneHeadingText));
      const taskIndex = renderedText.findIndex(value => value.includes(state.taskText));
      expect(doneIndex).toBeGreaterThanOrEqual(0);
      expect(taskIndex).toBe(doneIndex + 1);

      let tableBlock: Locator = page
        .locator('affine-table, [data-block-flavour="affine:table"]')
        .filter({ hasText: state.tableHeaderText })
        .first();
      if (await tableBlock.count() === 0) {
        tableBlock = page.locator(`[data-block-id="${state.tableBlockId}"]`).filter({ hasText: state.tableHeaderText }).first();
      }
      await expect(tableBlock).toBeVisible({ timeout: 30_000 });
      const tableHeader = tableBlock.getByText(state.tableHeaderText, { exact: true });
      await expect(tableHeader).toHaveCount(1);
      await expect(tableBlock.getByText(state.tableSiblingHeaderText, { exact: true })).toHaveCount(1);
      await expect(tableBlock.getByText(state.tableCellText, { exact: true })).toHaveCount(1);
      await expect(tableBlock.getByText(state.tableSiblingDataText, { exact: true })).toHaveCount(1);

      const headerFontWeight = Number.parseInt(
        await tableHeader.evaluate(element => getComputedStyle(element).fontWeight),
        10,
      );
      expect(headerFontWeight).toBeGreaterThanOrEqual(600);

      const tableLink = tableBlock.locator(`a[href="${state.tableLinkUrl}"]`).filter({ hasText: 'GitLab' }).first();
      await expect(tableLink).toHaveAttribute('href', state.tableLinkUrl);
      await expect(tableLink).toHaveText('GitLab');

      const inlineCode = tableBlock.locator('code').filter({ hasText: 'team.AI' }).first();
      await expect(inlineCode).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('render one native page reference in a paragraph and a table cell', async ({ browser }) => {
    expect(state.referenceBlockId).toBeTruthy();
    expect(state.referenceTableBlockId).toBeTruthy();
    expect(state.referenceTargetTitle).toBeTruthy();
    const context = await browser.newContext({ storageState: AUTH_STATE_PATH });
    const page = await context.newPage();
    const referenceErrors: string[] = [];
    page.on('console', message => {
      if (message.type() === 'error' && message.text().includes('Reference node must be initialized')) {
        referenceErrors.push(message.text());
      }
    });
    try {
      await page.goto(`${state.baseUrl}/workspace/${state.workspaceId}/${state.docId}`);
      for (const blockId of [state.referenceBlockId, state.referenceTableBlockId]) {
        const block = page.locator(`[data-block-id="${blockId}"]`).first();
        await expect(block).toBeVisible();
        await expect(block.locator('.affine-reference')).toHaveCount(1);
        await expect(block.locator('.affine-reference-title')).toHaveText(state.referenceTargetTitle);
      }
      expect(referenceErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
