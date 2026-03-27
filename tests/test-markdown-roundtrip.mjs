#!/usr/bin/env node
import assert from 'node:assert/strict';

import { parseMarkdownToOperations } from '../dist/markdown/parse.js';
import { renderBlocksToMarkdown } from '../dist/markdown/render.js';

function calloutBlocks() {
  return new Map([
    ['callout-1', {
      id: 'callout-1',
      parentId: null,
      flavour: 'affine:callout',
      type: null,
      text: null,
      checked: null,
      language: null,
      childIds: ['paragraph-1'],
      url: null,
      sourceId: null,
      caption: null,
      tableData: null,
    }],
    ['paragraph-1', {
      id: 'paragraph-1',
      parentId: 'callout-1',
      flavour: 'affine:paragraph',
      type: 'text',
      text: 'Callout body',
      checked: null,
      language: null,
      childIds: [],
      url: null,
      sourceId: null,
      caption: null,
      tableData: null,
    }],
  ]);
}

function testRenderCalloutAsAdmonition() {
  const rendered = renderBlocksToMarkdown({
    rootBlockIds: ['callout-1'],
    blocksById: calloutBlocks(),
  });

  assert.equal(
    rendered.markdown,
    '> [!NOTE]\n> Callout body',
    'callout blocks should export as admonition-style blockquotes',
  );
  assert.equal(rendered.lossy, false, 'callout export should no longer be lossy');
  assert.deepEqual(rendered.warnings, [], 'callout export should not emit warnings');
}

function testParseAdmonitionAsCallout() {
  const parsed = parseMarkdownToOperations('> [!NOTE]\n> Callout body');

  assert.deepEqual(parsed.operations, [
    {
      type: 'callout',
      text: 'Callout body',
    },
  ], 'admonition-style blockquotes should import as callout operations');
  assert.equal(parsed.lossy, false, 'callout import should not be lossy');
  assert.deepEqual(parsed.warnings, [], 'callout import should not emit warnings');
}

function testParseListFormattingDeltas() {
  const parsed = parseMarkdownToOperations('- **ADMIN** access');

  assert.deepEqual(parsed.operations, [
    {
      type: 'list',
      text: 'ADMIN access',
      style: 'bulleted',
      deltas: [
        { insert: 'ADMIN', attributes: { bold: true } },
        { insert: ' access' },
      ],
    },
  ], 'list items should preserve inline formatting as text deltas');
}

function testParseNestedListFormattingDeltas() {
  const parsed = parseMarkdownToOperations('- parent\n  - **CHILD** access');

  assert.deepEqual(parsed.operations, [
    {
      type: 'list',
      text: 'parent',
      style: 'bulleted',
      deltas: [{ insert: 'parent' }],
    },
    {
      type: 'list',
      text: 'CHILD access',
      style: 'bulleted',
      deltas: [
        { insert: 'CHILD', attributes: { bold: true } },
        { insert: ' access' },
      ],
    },
  ], 'nested list items should preserve inline formatting when flattened');
}

function testParseTableFormattingDeltas() {
  const parsed = parseMarkdownToOperations(
    '| Column A | Column B |\n' +
    '| --- | --- |\n' +
    '| **ADMIN** | Full access |\n' +
    '| Normal text | **Important** value |',
  );

  assert.deepEqual(parsed.operations, [
    {
      type: 'table',
      rows: 3,
      columns: 2,
      tableData: [
        ['Column A', 'Column B'],
        ['ADMIN', 'Full access'],
        ['Normal text', 'Important value'],
      ],
      tableCellDeltas: [
        [
          [{ insert: 'Column A' }],
          [{ insert: 'Column B' }],
        ],
        [
          [{ insert: 'ADMIN', attributes: { bold: true } }],
          [{ insert: 'Full access' }],
        ],
        [
          [{ insert: 'Normal text' }],
          [
            { insert: 'Important', attributes: { bold: true } },
            { insert: ' value' },
          ],
        ],
      ],
    },
  ], 'table cells should preserve inline formatting as text deltas');
}

testRenderCalloutAsAdmonition();
testParseAdmonitionAsCallout();
testParseListFormattingDeltas();
testParseNestedListFormattingDeltas();
testParseTableFormattingDeltas();
console.log('Markdown round-trip tests passed');
