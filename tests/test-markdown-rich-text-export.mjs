#!/usr/bin/env node
/**
 * Regression tests for rich-text export fidelity (PR #176 review feedback).
 *
 * Two cases are covered:
 *   1. Bold/italic partial overlap — the streaming marker state machine emitted
 *      interleaved delimiters (e.g. **A*B**C*) that markdown parsers mis-read.
 *      Self-contained per-run wrappers with `_` for italic fix both directions.
 *   2. Table cell inline formatting — tableCellDeltas must be wired through the
 *      renderer so bold/italic inside table cells survives export.
 */
import assert from 'node:assert/strict';
import { deltasToMarkdown, renderBlocksToMarkdown } from '../dist/markdown/render.js';

// ---------------------------------------------------------------------------
// 1. Bold / italic partial overlap — direction A: bold → bold+italic → italic
// ---------------------------------------------------------------------------
function testBoldThenBoldItalicThenItalic() {
  const deltas = [
    { insert: 'A', attributes: { bold: true } },
    { insert: 'B', attributes: { bold: true, italic: true } },
    { insert: 'C', attributes: { italic: true } },
  ];

  const result = deltasToMarkdown(deltas);

  // Each run is wrapped with self-contained markers; `_` is used for italic so
  // that `**` (bold) and `_` (italic) delimiters never form ambiguous sequences.
  assert.equal(result, '**A****_B_**_C_',
    'bold → bold+italic → italic: self-contained per-run markers expected');

  // Structural checks: bold marker wraps A and B, italic marker wraps B and C.
  assert.ok(result.includes('**A**'), 'A should be wrapped in bold markers');
  assert.ok(result.includes('**_B_**'), 'B should be wrapped in bold+italic markers');
  assert.ok(result.includes('_C_'), 'C should be wrapped in italic markers');
}

// ---------------------------------------------------------------------------
// 2. Bold / italic partial overlap — direction B: italic → bold+italic → bold
// ---------------------------------------------------------------------------
function testItalicThenBoldItalicThenBold() {
  const deltas = [
    { insert: 'A', attributes: { italic: true } },
    { insert: 'B', attributes: { bold: true, italic: true } },
    { insert: 'C', attributes: { bold: true } },
  ];

  const result = deltasToMarkdown(deltas);

  assert.equal(result, '_A_**_B_****C**',
    'italic → bold+italic → bold: self-contained per-run markers expected');

  assert.ok(result.includes('_A_'), 'A should be wrapped in italic markers');
  assert.ok(result.includes('**_B_**'), 'B should be wrapped in bold+italic markers');
  assert.ok(result.includes('**C**'), 'C should be wrapped in bold markers');
}

// ---------------------------------------------------------------------------
// 3. Table cells: inline formatting preserved via tableCellDeltas
// ---------------------------------------------------------------------------
function testTableCellRichText() {
  const blocksById = new Map([
    ['table-1', {
      id: 'table-1',
      parentId: null,
      flavour: 'affine:table',
      type: null,
      text: null,
      checked: null,
      language: null,
      childIds: [],
      url: null,
      sourceId: null,
      caption: null,
      // tableData provides the plain-text fallback
      tableData: [
        ['Name', 'Value'],
        ['hello world', 'plain'],
      ],
      // tableCellDeltas carries inline formatting for each cell
      tableCellDeltas: [
        // Row 0 (header): "Name" bold, "Value" italic
        [
          [{ insert: 'Name', attributes: { bold: true } }],
          [{ insert: 'Value', attributes: { italic: true } }],
        ],
        // Row 1: "hello " plain + "world" bold, "plain" unstyled
        [
          [{ insert: 'hello ' }, { insert: 'world', attributes: { bold: true } }],
          [{ insert: 'plain' }],
        ],
      ],
    }],
  ]);

  const result = renderBlocksToMarkdown({
    rootBlockIds: ['table-1'],
    blocksById,
  });

  const md = result.markdown;

  // Header row must carry bold and italic markers
  assert.ok(md.includes('**Name**'), 'header cell "Name" should be bold');
  assert.ok(md.includes('_Value_'), 'header cell "Value" should be italic');

  // Data row must have partially-bold cell text
  assert.ok(md.includes('hello **world**'), 'data cell should have "world" in bold');

  // Plain cell should pass through unchanged
  assert.ok(md.includes('plain'), 'plain cell should appear unchanged');

  // Separator row must be present
  assert.ok(md.includes('| --- |'), 'table separator row must be present');
}

// ---------------------------------------------------------------------------
// 4. Individual mark types — strike, link, code
// ---------------------------------------------------------------------------
function testStrike() {
  const result = deltasToMarkdown([{ insert: 'text', attributes: { strike: true } }]);
  assert.equal(result, '~~text~~', 'strike should wrap with ~~');
}

function testLink() {
  const result = deltasToMarkdown([{ insert: 'click here', attributes: { link: 'https://example.com' } }]);
  assert.equal(result, '[click here](https://example.com)', 'link should produce markdown link syntax');
}

function testCode() {
  const result = deltasToMarkdown([{ insert: 'foo()', attributes: { code: true } }]);
  assert.equal(result, '`foo()`', 'code should wrap with backticks');
}

// ---------------------------------------------------------------------------
// 5. link + bold combination — bold applied first, then wrapped in link
// ---------------------------------------------------------------------------
function testLinkBold() {
  const result = deltasToMarkdown([{ insert: 'text', attributes: { bold: true, link: 'https://example.com' } }]);
  // bold wraps inner first, then link wraps the whole thing
  assert.equal(result, '[**text**](https://example.com)', 'bold+link should produce [**text**](url)');
}

// ---------------------------------------------------------------------------
// 6. code priority — bold/italic are silently dropped when code is set
//    because the code branch does an early `continue`
// ---------------------------------------------------------------------------
function testCodeDropsOtherMarks() {
  const result = deltasToMarkdown([{ insert: 'x', attributes: { code: true, bold: true, italic: true } }]);
  assert.equal(result, '`x`', 'code takes priority; bold and italic are dropped when code is set');
}

// ---------------------------------------------------------------------------
// 7. Paragraph block with deltas via renderBlocksToMarkdown
//    Verifies the deltas wiring in renderBlock() for non-table flavours
// ---------------------------------------------------------------------------
function testParagraphBlockWithDeltas() {
  const blocksById = new Map([
    ['para-1', {
      id: 'para-1',
      parentId: null,
      flavour: 'affine:paragraph',
      type: 'text',
      text: 'fallback plain text',
      checked: null,
      language: null,
      childIds: [],
      url: null,
      sourceId: null,
      caption: null,
      tableData: null,
      deltas: [
        { insert: 'Hello ' },
        { insert: 'world', attributes: { bold: true } },
      ],
    }],
  ]);

  const result = renderBlocksToMarkdown({ rootBlockIds: ['para-1'], blocksById });
  // deltas must win over the plain text field
  assert.equal(result.markdown, 'Hello **world**',
    'paragraph with deltas should render deltas, not the plain text fallback');
}

// ---------------------------------------------------------------------------
// 8. Table without tableCellDeltas — plain tableData is used as fallback
// ---------------------------------------------------------------------------
function testTableFallbackWithoutDeltas() {
  const blocksById = new Map([
    ['table-2', {
      id: 'table-2',
      parentId: null,
      flavour: 'affine:table',
      type: null,
      text: null,
      checked: null,
      language: null,
      childIds: [],
      url: null,
      sourceId: null,
      caption: null,
      tableData: [
        ['Name', 'Value'],
        ['Alice', '42'],
      ],
      // no tableCellDeltas — must fall back to tableData strings
    }],
  ]);

  const result = renderBlocksToMarkdown({ rootBlockIds: ['table-2'], blocksById });
  const md = result.markdown;

  assert.ok(md.includes('| Name | Value |'), 'header row should come from tableData fallback');
  assert.ok(md.includes('| Alice | 42 |'), 'data row should come from tableData fallback');
  assert.ok(md.includes('| --- |'), 'separator row must be present');
}

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------
const tests = [
  ['bold → bold+italic → italic (direction A)', testBoldThenBoldItalicThenItalic],
  ['italic → bold+italic → bold (direction B)', testItalicThenBoldItalicThenBold],
  ['table cell inline formatting via tableCellDeltas', testTableCellRichText],
  ['strike mark', testStrike],
  ['link mark', testLink],
  ['code mark', testCode],
  ['link + bold combination', testLinkBold],
  ['code takes priority over bold/italic', testCodeDropsOtherMarks],
  ['paragraph block with deltas via renderBlocksToMarkdown', testParagraphBlockWithDeltas],
  ['table without tableCellDeltas uses plain tableData fallback', testTableFallbackWithoutDeltas],
];

let passed = 0;
let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
