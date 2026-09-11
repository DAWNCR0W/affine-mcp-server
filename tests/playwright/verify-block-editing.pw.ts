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
});
