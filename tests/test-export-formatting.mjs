#!/usr/bin/env node
import assert from 'node:assert/strict';

import { renderBlocksToMarkdown } from '../dist/markdown/render.js';

// Build a minimal paragraph block with both plain text (current) and deltas (the fix).
// After the fix, the renderer should use deltas to emit formatted markdown.
function paraBlock(id, text, deltas) {
  return {
    id,
    parentId: null,
    flavour: 'affine:paragraph',
    type: 'text',
    text,
    deltas,
    checked: null,
    language: null,
    childIds: [],
    url: null,
    sourceId: null,
    caption: null,
    tableData: null,
  };
}

function render(block) {
  return renderBlocksToMarkdown({
    rootBlockIds: [block.id],
    blocksById: new Map([[block.id, block]]),
  }).markdown;
}

function testBoldExport() {
  const md = render(paraBlock('b1', 'bold text', [
    { insert: 'bold text', attributes: { bold: true } },
  ]));
  assert.equal(md, '**bold text**', 'bold delta should export as **text**');
}

function testItalicExport() {
  const md = render(paraBlock('b1', 'italic text', [
    { insert: 'italic text', attributes: { italic: true } },
  ]));
  assert.equal(md, '*italic text*', 'italic delta should export as *text*');
}

function testStrikethroughExport() {
  const md = render(paraBlock('b1', 'struck text', [
    { insert: 'struck text', attributes: { strike: true } },
  ]));
  assert.equal(md, '~~struck text~~', 'strike delta should export as ~~text~~');
}

function testInlineCodeExport() {
  const md = render(paraBlock('b1', 'some code', [
    { insert: 'some code', attributes: { code: true } },
  ]));
  assert.equal(md, '`some code`', 'code delta should export as `text`');
}

function testLinkExport() {
  const md = render(paraBlock('b1', 'click here', [
    { insert: 'click here', attributes: { link: 'https://example.com' } },
  ]));
  assert.equal(md, '[click here](https://example.com)', 'link delta should export as [text](url)');
}

function testMixedExport() {
  const md = render(paraBlock('b1', 'hello bold world', [
    { insert: 'hello ' },
    { insert: 'bold', attributes: { bold: true } },
    { insert: ' world' },
  ]));
  assert.equal(md, 'hello **bold** world', 'mixed deltas should emit formatting only around the formatted run');
}

function testBoldItalicExport() {
  const md = render(paraBlock('b1', 'both', [
    { insert: 'both', attributes: { bold: true, italic: true } },
  ]));
  assert.equal(md, '***both***', 'bold+italic delta should export as ***text***');
}

function testHeadingBoldExport() {
  const block = {
    ...paraBlock('b1', 'Bold Heading', [
      { insert: 'Bold Heading', attributes: { bold: true } },
    ]),
    type: 'h1',
  };
  const md = render(block);
  assert.equal(md, '# **Bold Heading**', 'bold inside heading should export with ** inside #');
}

function testListItemBoldExport() {
  const block = {
    id: 'l1',
    parentId: null,
    flavour: 'affine:list',
    type: 'bulleted',
    text: 'bold item',
    deltas: [{ insert: 'bold item', attributes: { bold: true } }],
    checked: null,
    language: null,
    childIds: [],
    url: null,
    sourceId: null,
    caption: null,
    tableData: null,
  };
  const md = renderBlocksToMarkdown({
    rootBlockIds: ['l1'],
    blocksById: new Map([['l1', block]]),
  }).markdown;
  assert.equal(md, '- **bold item**', 'bold delta in list item should export as - **text**');
}

function testBlockquoteBoldExport() {
  const block = {
    ...paraBlock('b1', 'bold quote', [
      { insert: 'bold quote', attributes: { bold: true } },
    ]),
    type: 'quote',
  };
  const md = render(block);
  assert.equal(md, '> **bold quote**', 'bold delta in blockquote paragraph should export as > **text**');
}

function testItalicLinkExport() {
  const md = render(paraBlock('b1', 'click here', [
    { insert: 'click here', attributes: { italic: true, link: 'https://example.com' } },
  ]));
  assert.equal(md, '[*click here*](https://example.com)', 'italic link delta should export as [*text*](url)');
}

function testTripleComboExport() {
  const md = render(paraBlock('b1', 'text', [
    { insert: 'text', attributes: { bold: true, italic: true, strike: true } },
  ]));
  assert.equal(md, '~~***text***~~', 'bold+italic+strike delta should export as ~~***text***~~');
}

function testMultipleLinksExport() {
  const md = render(paraBlock('b1', 'first and second', [
    { insert: 'first', attributes: { link: 'https://one.com' } },
    { insert: ' and ' },
    { insert: 'second', attributes: { link: 'https://two.com' } },
  ]));
  assert.equal(md, '[first](https://one.com) and [second](https://two.com)', 'multiple link deltas should each export as [text](url)');
}

function testPlainExport() {
  const md = render(paraBlock('b1', 'plain text', [
    { insert: 'plain text' },
  ]));
  assert.equal(md, 'plain text', 'plain delta should export with no markers');
}

function testBoldStrikeExport() {
  const md = render(paraBlock('b1', 'text', [
    { insert: 'text', attributes: { bold: true, strike: true } },
  ]));
  assert.equal(md, '~~**text**~~', 'bold+strike delta should export as ~~**text**~~');
}

function testItalicStrikeExport() {
  const md = render(paraBlock('b1', 'text', [
    { insert: 'text', attributes: { italic: true, strike: true } },
  ]));
  assert.equal(md, '~~*text*~~', 'italic+strike delta should export as ~~*text*~~');
}

function testBoldLinkExport() {
  const md = render(paraBlock('b1', 'click here', [
    { insert: 'click here', attributes: { bold: true, link: 'https://example.com' } },
  ]));
  assert.equal(md, '[**click here**](https://example.com)', 'bold link delta should export as [**text**](url)');
}

function testAllFormatsInOneparagraph() {
  const md = render(paraBlock('b1', 'bold italic strike code', [
    { insert: 'bold', attributes: { bold: true } },
    { insert: ' ' },
    { insert: 'italic', attributes: { italic: true } },
    { insert: ' ' },
    { insert: 'strike', attributes: { strike: true } },
    { insert: ' ' },
    { insert: 'code', attributes: { code: true } },
  ]));
  assert.equal(md, '**bold** *italic* ~~strike~~ `code`', 'all formatting types in one paragraph should each emit correct syntax');
}

function testHardBreakExport() {
  const md = render(paraBlock('b1', 'first  \nsecond', [
    { insert: 'first' },
    { insert: '  \n' },
    { insert: 'second' },
  ]));
  assert.equal(md, 'first  \nsecond', 'hard break delta should export as two trailing spaces + newline');
}

testPlainExport();
testBoldExport();
testItalicExport();
testStrikethroughExport();
testInlineCodeExport();
testLinkExport();
testMixedExport();
testBoldItalicExport();
testBoldStrikeExport();
testItalicStrikeExport();
testBoldLinkExport();
testAllFormatsInOneparagraph();
testHardBreakExport();
testHeadingBoldExport();
testListItemBoldExport();
testBlockquoteBoldExport();
testItalicLinkExport();
testTripleComboExport();
testMultipleLinksExport();

console.log('Export formatting tests passed');
