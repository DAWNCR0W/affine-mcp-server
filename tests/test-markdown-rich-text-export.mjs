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
// Run all tests
// ---------------------------------------------------------------------------
const tests = [
  ['bold → bold+italic → italic (direction A)', testBoldThenBoldItalicThenItalic],
  ['italic → bold+italic → bold (direction B)', testItalicThenBoldItalicThenBold],
  ['table cell inline formatting via tableCellDeltas', testTableCellRichText],
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
