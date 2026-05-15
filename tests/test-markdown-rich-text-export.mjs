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
import { parseMarkdownToOperations } from '../dist/markdown/parse.js';

// Normalise a delta to only the truthy attributes so deepEqual comparisons
// aren't sensitive to {bold: false} vs missing key.
function normalizeDelta(d) {
  const attrs = {};
  if (d.attributes?.bold === true) attrs.bold = true;
  if (d.attributes?.italic === true) attrs.italic = true;
  if (d.attributes?.strike === true) attrs.strike = true;
  if (d.attributes?.code === true) attrs.code = true;
  if (d.attributes?.link) attrs.link = d.attributes.link;
  return Object.keys(attrs).length > 0 ? { insert: d.insert, attributes: attrs } : { insert: d.insert };
}

// Parse the markdown string and return the deltas from the first operation.
// Empty-insert deltas (which markdown-it emits between adjacent emphasis
// spans) are dropped — they carry no content and aren't part of the original.
function parsedDeltas(markdown) {
  const result = parseMarkdownToOperations(markdown);
  return (result.operations[0]?.deltas ?? [])
    .filter(d => d.insert !== '')
    .map(normalizeDelta);
}

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

  // Standard per-run delimiters: **A** + ***B*** + _C_.  The concatenated
  // `**A*****B***_C_` parses unambiguously through markdown-it.
  assert.equal(result, '**A*****B***_C_',
    'bold → bold+italic → italic: standard markdown delimiters expected');

  // Round-trip: markdown-it must parse back to the original delta structure.
  assert.deepEqual(parsedDeltas(result), deltas.map(normalizeDelta),
    'bold → bold+italic → italic: round-trip must preserve mark structure');
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

  // Standard per-run delimiters: _A_ + ***B*** + **C**.  The concatenated
  // `_A_***B*****C**` parses unambiguously through markdown-it.
  assert.equal(result, '_A_***B*****C**',
    'italic → bold+italic → bold: standard markdown delimiters expected');

  // Round-trip: markdown-it must parse back to the original delta structure.
  assert.deepEqual(parsedDeltas(result), deltas.map(normalizeDelta),
    'italic → bold+italic → bold: round-trip must preserve mark structure');
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
  // bold wraps the run text first, then link wraps the bold span.
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
// 11. Corner cases — empty inputs, escape edges, mark combinations
// ---------------------------------------------------------------------------
function testEmptyDeltas() {
  assert.equal(deltasToMarkdown([]), '', 'empty deltas array should produce empty markdown');
}

function testEmptyInsertSkipped() {
  // An empty-insert run with marks would emit floating delimiters; it should
  // be dropped, and surrounding runs coalesce naturally.
  const deltas = [
    { insert: 'A', attributes: { bold: true } },
    { insert: '', attributes: { bold: true, italic: true } },
    { insert: 'B', attributes: { italic: true } },
  ];
  const result = deltasToMarkdown(deltas);
  assert.equal(result, '**A**_B_', 'empty insert should be skipped');
  assert.deepEqual(parsedDeltas(result), [
    { insert: 'A', attributes: { bold: true } },
    { insert: 'B', attributes: { italic: true } },
  ], 'empty-insert skip should round-trip cleanly');
}

function testAdjacentSameAttribute() {
  // Adjacent runs sharing attributes coalesce so the output doesn't have
  // back-to-back delimiter pairs that CommonMark would parse as literal.
  const deltas = [
    { insert: 'A', attributes: { bold: true } },
    { insert: 'B', attributes: { bold: true } },
  ];
  assert.equal(deltasToMarkdown(deltas), '**AB**',
    'adjacent same-attribute runs should coalesce');
}

function testUrlWithWhitespace() {
  const result = deltasToMarkdown([{ insert: 'click', attributes: { link: 'https://example.com/with space' } }]);
  assert.equal(result, '[click](<https://example.com/with space>)',
    'URLs with whitespace should use angle-bracket form');
}

function testUrlWithAngles() {
  const result = deltasToMarkdown([{ insert: 'click', attributes: { link: 'https://example.com/<x>' } }]);
  assert.equal(result, '[click](<https://example.com/%3Cx%3E>)',
    'URLs with < or > should use angle-bracket form with inner brackets percent-encoded');
}

function testLinkLabelWithBracket() {
  const result = deltasToMarkdown([{ insert: 'foo]bar', attributes: { link: 'https://example.com' } }]);
  assert.equal(result, '[foo\\]bar](https://example.com)',
    'closing brackets in link label should be backslash-escaped');
}

function testNewlinePreserved() {
  assert.equal(deltasToMarkdown([{ insert: 'foo\nbar' }]), 'foo\nbar',
    'newlines inside insert should pass through');
}

function testCodeWithBacktick() {
  // Content with a single backtick needs a double-backtick fence.
  assert.equal(deltasToMarkdown([{ insert: 'a`b', attributes: { code: true } }]), '``a`b``',
    'code containing a backtick should use a longer fence');
}

function testCodeLeadingBacktick() {
  // Content starting/ending with backtick needs a space pad so the fence is
  // distinguishable from the content (CommonMark strips one space if both ends have one).
  assert.equal(deltasToMarkdown([{ insert: '`x', attributes: { code: true } }]), '`` `x ``',
    'code starting with backtick should be space-padded inside fence');
}

function testStrikeCode() {
  assert.equal(deltasToMarkdown([{ insert: 'x', attributes: { code: true, strike: true } }]), '~~`x`~~',
    'strike should wrap a code span when both are set');
}

function testLinkCode() {
  assert.equal(deltasToMarkdown([{ insert: 'x', attributes: { code: true, link: 'https://example.com' } }]),
    '[`x`](https://example.com)',
    'link should wrap a code span when both are set');
}

function testBoldWithLinkMid() {
  // Round-trip a bold span containing a link mid-stream — the per-run
  // **A**[**B**](url)**C** layout must survive parsing back into the same shape.
  const deltas = [
    { insert: 'A', attributes: { bold: true } },
    { insert: 'B', attributes: { bold: true, link: 'https://example.com' } },
    { insert: 'C', attributes: { bold: true } },
  ];
  const result = deltasToMarkdown(deltas);
  assert.equal(result, '**A**[**B**](https://example.com)**C**',
    'bold span with link mid-run should emit cleanly');
  assert.deepEqual(parsedDeltas(result), deltas.map(normalizeDelta),
    'bold + link + bold should round-trip preserving each run');
}

function testAllMarksCombined() {
  // Order of wrapping: emphasis innermost, then link, then strike outermost.
  assert.equal(
    deltasToMarkdown([{ insert: 'x', attributes: { bold: true, italic: true, strike: true, link: 'https://example.com' } }]),
    '~~[***x***](https://example.com)~~',
    'all marks: strike wraps link wraps bold+italic');
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
  ['empty deltas array', testEmptyDeltas],
  ['empty insert is skipped', testEmptyInsertSkipped],
  ['adjacent same-attribute runs coalesce', testAdjacentSameAttribute],
  ['URL with whitespace uses angle-bracket form', testUrlWithWhitespace],
  ['URL with angle brackets percent-encoded inside <…>', testUrlWithAngles],
  ['closing bracket in link label is escaped', testLinkLabelWithBracket],
  ['newline inside insert is preserved', testNewlinePreserved],
  ['code containing a backtick uses a longer fence', testCodeWithBacktick],
  ['code starting with backtick is space-padded', testCodeLeadingBacktick],
  ['strike + code combine', testStrikeCode],
  ['link + code combine', testLinkCode],
  ['bold span with link mid-run round-trips', testBoldWithLinkMid],
  ['all marks combined (strike+link+bold+italic)', testAllMarksCombined],
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
