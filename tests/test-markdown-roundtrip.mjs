#!/usr/bin/env node
import assert from 'node:assert/strict';
import * as Y from 'yjs';

import { parseMarkdownToOperations } from '../dist/markdown/parse.js';
import { renderBlocksToMarkdown } from '../dist/markdown/render.js';
import { richTextValueToDeltas } from '../dist/markdown/richText.js';

function markdownBlock(overrides = {}) {
  return {
    id: 'block-1',
    parentId: null,
    flavour: 'affine:paragraph',
    type: 'text',
    text: null,
    checked: null,
    language: null,
    childIds: [],
    url: null,
    sourceId: null,
    caption: null,
    tableData: null,
    textDeltas: null,
    tableCellDeltas: null,
    ...overrides,
  };
}

function renderSingleBlock(block) {
  return renderBlocksToMarkdown({
    rootBlockIds: [block.id],
    blocksById: new Map([[block.id, block]]),
  });
}

function hasDelta(deltas, insert, attrs) {
  return deltas.some(delta =>
    delta.insert === insert &&
    (attrs === undefined || Object.entries(attrs).every(([key, value]) => delta.attributes?.[key] === value))
  );
}

function calloutBlocks() {
  return new Map([
    ['callout-1', markdownBlock({
      id: 'callout-1',
      flavour: 'affine:callout',
      type: null,
      childIds: ['paragraph-1'],
    })],
    ['paragraph-1', markdownBlock({
      id: 'paragraph-1',
      parentId: 'callout-1',
      text: 'Callout body',
    })],
  ]);
}

function testRenderCalloutAsAdmonition() {
  const rendered = renderBlocksToMarkdown({
    rootBlockIds: ['callout-1'],
    blocksById: calloutBlocks(),
  });

  assert.equal(rendered.markdown, '> [!NOTE]\n> Callout body');
  assert.equal(rendered.lossy, false);
  assert.deepEqual(rendered.warnings, []);
}

function testParseAdmonitionAsCallout() {
  const parsed = parseMarkdownToOperations('> [!NOTE]\n> Callout body');

  assert.deepEqual(parsed.operations, [{
    type: 'callout',
    text: 'Callout body',
    deltas: [{ insert: 'Callout body' }],
  }]);
  assert.equal(parsed.lossy, false);
}

function testParserRetainsInlineDeltas() {
  const examples = [
    ['## A **bold** heading', 'heading', 'A bold heading', 'bold', { bold: true }],
    ['A **bold** paragraph', 'paragraph', 'A bold paragraph', 'bold', { bold: true }],
    ['> A *quoted* value', 'quote', 'A quoted value', 'quoted', { italic: true }],
    ['> [!NOTE]\n> A ~~removed~~ value', 'callout', 'A removed value', 'removed', { strike: true }],
  ];

  for (const [markdown, type, text, insert, attrs] of examples) {
    const parsed = parseMarkdownToOperations(markdown);
    assert.equal(parsed.operations.length, 1, markdown);
    assert.equal(parsed.operations[0]?.type, type, markdown);
    assert.equal(parsed.operations[0]?.text, text, markdown);
    assert.ok(hasDelta(parsed.operations[0]?.deltas ?? [], insert, attrs), markdown);
  }
  assert.equal(parseMarkdownToOperations(examples[0][0]).operations[0]?.level, 2);
  assert.ok(
    !hasDelta(parseMarkdownToOperations(examples[3][0]).operations[0]?.deltas ?? [], '[!NOTE]'),
    'callout marker must not leak into rich-text deltas',
  );
}

function testNestedListParserPreservesHierarchyAndRichText() {
  const parsed = parseMarkdownToOperations([
    '## Plan',
    '',
    '- Parent **A**',
    '  - Child *A1*',
    '    - [x] Grandchild ~~done~~',
    '  - Child A2',
    '- Parent B',
  ].join('\n'));

  assert.equal(parsed.operations.length, 3);
  const [, parent, sibling] = parsed.operations;
  assert.equal(parent.type, 'list');
  assert.equal(parent.text, 'Parent A');
  assert.equal(sibling.text, 'Parent B');
  assert.deepEqual(parent.children.map(child => child.text), ['Child A1', 'Child A2']);
  const grandchild = parent.children[0].children[0];
  assert.equal(grandchild.style, 'todo');
  assert.equal(grandchild.checked, true);
  assert.ok(hasDelta(parent.deltas, 'A', { bold: true }));
  assert.ok(hasDelta(parent.children[0].deltas, 'A1', { italic: true }));
  assert.ok(hasDelta(grandchild.deltas, 'done', { strike: true }));
  assert.equal(parsed.stats.blockCount, 6, 'count every descendant and the heading');
  assert.equal(parsed.stats.unsupportedCount, 0);
  assert.equal(parsed.lossy, false);
  assert.deepEqual(parsed.warnings, []);
}

function testMixedNestedListParserPreservesOrderAndTaskStates() {
  const parsed = parseMarkdownToOperations([
    '1. First',
    '   - [ ] [pending](https://example.com)',
    '     1. `code`',
    '     2. Done',
    '   - [X] complete',
    '2. Second',
  ].join('\n'));

  assert.deepEqual(parsed.operations.map(item => [item.text, item.style]), [
    ['First', 'numbered'],
    ['Second', 'numbered'],
  ]);
  const [pending, complete] = parsed.operations[0].children;
  assert.deepEqual([pending.style, pending.checked], ['todo', false]);
  assert.deepEqual([complete.style, complete.checked], ['todo', true]);
  assert.deepEqual(pending.children.map(item => [item.text, item.style]), [
    ['code', 'numbered'],
    ['Done', 'numbered'],
  ]);
  assert.ok(hasDelta(pending.deltas, 'pending', { link: 'https://example.com' }));
  assert.ok(hasDelta(pending.children[0].deltas, 'code', { code: true }));
  assert.equal(parsed.stats.blockCount, 6);
  assert.equal(parsed.lossy, false);
  assert.deepEqual(parsed.warnings, []);

  const emptyParent = parseMarkdownToOperations('-\n  - Child');
  assert.equal(emptyParent.operations.length, 1);
  assert.equal(emptyParent.operations[0].text, '');
  assert.equal(emptyParent.operations[0].children[0].text, 'Child');
  assert.equal(emptyParent.stats.blockCount, 2);
  assert.equal(emptyParent.lossy, false);
}

function testUnsupportedListContentRetainsTruthfulWarnings() {
  const trailing = parseMarkdownToOperations('- Parent\n  - Child\n\n  Tail **after**\n- Next');
  assert.equal(trailing.operations[0].text, 'Parent\nTail after');
  assert.equal(trailing.operations[0].children[0].text, 'Child');
  assert.equal(trailing.operations[1].text, 'Next');
  assert.ok(hasDelta(trailing.operations[0].deltas, 'after', { bold: true }));
  assert.equal(trailing.stats.blockCount, 3);
  assert.equal(trailing.lossy, true);
  assert.ok(trailing.warnings.some(warning => /text after a nested list.*moved before/.test(warning)));

  const code = parseMarkdownToOperations('- Parent\n\n  ```js\n  ignored()\n  ```\n  - Child');
  assert.equal(code.operations[0].text, 'Parent');
  assert.equal(code.operations[0].children[0].text, 'Child');
  assert.equal(code.lossy, true);
  assert.ok(code.warnings.some(warning => /Code blocks inside.*ignored/.test(warning)));

  const table = parseMarkdownToOperations('- Parent\n\n  | Header | Value |\n  | --- | --- |\n  | A | B |');
  assert.match(table.operations[0].text, /Header\nValue\nA\nB/);
  assert.equal(table.lossy, true);
  assert.ok(table.warnings.some(warning => /Tables inside.*flattened/.test(warning)));
}

function testMarkdownNestingLimitReportsPossibleLoss() {
  const nestedList = depth => Array.from({ length: depth }, (_, index) =>
    `${'  '.repeat(index)}- node${index}`,
  ).join('\n');
  const supported = parseMarkdownToOperations(nestedList(49));
  assert.equal(supported.stats.blockCount, 49);
  assert.equal(supported.lossy, false);
  assert.deepEqual(supported.warnings, []);

  for (const depth of [50, 60]) {
    const limited = parseMarkdownToOperations(nestedList(depth));
    assert.equal(limited.lossy, true);
    assert.ok(limited.warnings.some(warning => /nesting limit.*omitted/.test(warning)));
  }
}

function testPlainTextExportCompatibility() {
  const legacy = renderSingleBlock(markdownBlock({ text: '  Plain text  ' }));
  const deltaBacked = renderSingleBlock(markdownBlock({
    text: '  Plain text  ',
    textDeltas: [{ insert: '  Plain text  ' }],
  }));

  assert.equal(legacy.markdown, 'Plain text');
  assert.equal(deltaBacked.markdown, legacy.markdown);
  assert.equal(deltaBacked.lossy, false);
  assert.equal(deltaBacked.stats.unsupportedInlineAttributeCount, 0);
}

function testSupportedRichTextExport() {
  const rendered = renderSingleBlock(markdownBlock({
    text: 'Plain bold italic strike code link',
    textDeltas: [
      { insert: 'Plain ' },
      { insert: 'bold', attributes: { bold: true } },
      { insert: ' ' },
      { insert: 'italic', attributes: { italic: true } },
      { insert: ' ' },
      { insert: 'strike', attributes: { strike: true } },
      { insert: ' ' },
      { insert: 'code', attributes: { code: true } },
      { insert: ' ' },
      { insert: 'link', attributes: { link: 'https://example.com' } },
    ],
  }));

  assert.equal(
    rendered.markdown,
    'Plain **bold** *italic* ~~strike~~ `code` [link](https://example.com)',
  );
  assert.equal(rendered.lossy, false);
  assert.deepEqual(rendered.warnings, []);
}

function testAllSupportedAttributeCombinationsRoundTrip() {
  const attributeNames = ['bold', 'italic', 'strike', 'code', 'link'];
  for (let mask = 1; mask < (1 << attributeNames.length); mask += 1) {
    const attributes = {};
    for (let index = 0; index < attributeNames.length; index += 1) {
      if ((mask & (1 << index)) === 0) continue;
      const name = attributeNames[index];
      attributes[name] = name === 'link' ? 'https://example.com' : true;
    }

    const rendered = renderSingleBlock(markdownBlock({
      text: 'before value after',
      textDeltas: [
        { insert: 'before ' },
        { insert: 'value', attributes },
        { insert: ' after' },
      ],
    }));
    assert.equal(rendered.lossy, false, JSON.stringify(attributes));

    const operation = parseMarkdownToOperations(rendered.markdown).operations[0];
    assert.equal(operation?.type, 'paragraph', rendered.markdown);
    assert.equal(operation?.text, 'before value after', rendered.markdown);
    const delta = operation?.deltas?.find(entry => entry.insert === 'value');
    assert.ok(delta, `${JSON.stringify(attributes)} did not round-trip from ${rendered.markdown}`);
    for (const name of attributeNames) {
      assert.equal(delta.attributes?.[name], attributes[name], `${name} differed in ${rendered.markdown}`);
    }
  }
}

function testInlineCodeBoundaryCharactersRoundTrip() {
  const rendered = renderSingleBlock(markdownBlock({
    text: 'A  spaced  and `ticks`',
    textDeltas: [
      { insert: 'A ' },
      { insert: ' spaced ', attributes: { code: true } },
      { insert: ' and ' },
      { insert: '`ticks`', attributes: { code: true } },
    ],
  }));

  assert.equal(rendered.markdown, 'A `  spaced  ` and `` `ticks` ``');
  const deltas = parseMarkdownToOperations(rendered.markdown).operations[0]?.deltas ?? [];
  assert.ok(hasDelta(deltas, ' spaced ', { code: true }));
  assert.ok(hasDelta(deltas, '`ticks`', { code: true }));
}

function testFormattedWhitespaceAndEquivalentRunCoalescing() {
  const whitespace = renderSingleBlock(markdownBlock({
    text: 'A  bold  B',
    textDeltas: [
      { insert: 'A ' },
      { insert: ' bold ', attributes: { bold: true } },
      { insert: ' B' },
    ],
  }));
  assert.equal(whitespace.markdown, 'A  **bold**  B');
  assert.equal(parseMarkdownToOperations(whitespace.markdown).operations[0]?.text, 'A  bold  B');

  const coalesced = renderSingleBlock(markdownBlock({
    text: 'bold code',
    textDeltas: [
      { insert: 'bo', attributes: { bold: true, highlight: 'yellow' } },
      { insert: 'ld', attributes: { bold: true } },
      { insert: ' ' },
      { insert: 'co', attributes: { code: true } },
      { insert: 'de', attributes: { code: true } },
    ],
  }));
  assert.equal(coalesced.markdown, '**bold** `code`');
  assert.equal(coalesced.stats.unsupportedInlineAttributeCount, 1);
  assert.equal(coalesced.warnings.length, 1);
}

function testUnsupportedInlineAttributeFidelity() {
  const rendered = renderSingleBlock(markdownBlock({
    text: 'marked again',
    textDeltas: [
      { insert: 'marked', attributes: { bold: true, highlight: 'yellow' } },
      { insert: ' again', attributes: { highlight: 'yellow' } },
    ],
  }));

  assert.equal(rendered.markdown, '**marked** again');
  assert.equal(rendered.lossy, true);
  assert.equal(rendered.stats.unsupportedCount, 1);
  assert.equal(rendered.stats.unsupportedInlineAttributeCount, 1);
  assert.equal(rendered.warnings.length, 1);
  assert.match(rendered.warnings[0], /inline attribute 'highlight'/);
}

function testRichTextAcrossBlockTypes() {
  const blocks = new Map([
    ['heading', markdownBlock({
      id: 'heading',
      type: 'h2',
      text: 'A bold heading',
      textDeltas: [
        { insert: 'A ' },
        { insert: 'bold', attributes: { bold: true } },
        { insert: ' heading' },
      ],
    })],
    ['quote', markdownBlock({
      id: 'quote',
      type: 'quote',
      text: 'A quote',
      textDeltas: [
        { insert: 'A ' },
        { insert: 'quote', attributes: { italic: true } },
      ],
    })],
    ['list', markdownBlock({
      id: 'list',
      flavour: 'affine:list',
      type: 'bulleted',
      text: 'done',
      textDeltas: [{ insert: 'done', attributes: { strike: true } }],
    })],
  ]);

  const rendered = renderBlocksToMarkdown({
    rootBlockIds: ['heading', 'quote', 'list'],
    blocksById: blocks,
  });
  assert.equal(rendered.markdown, '## A **bold** heading\n\n> A *quote*\n\n- ~~done~~');
  assert.equal(rendered.lossy, false);

  const parsed = parseMarkdownToOperations(rendered.markdown);
  assert.deepEqual(parsed.operations.map(operation => operation.type), ['heading', 'quote', 'list']);
  assert.ok(hasDelta(parsed.operations[0].deltas ?? [], 'bold', { bold: true }));
  assert.ok(hasDelta(parsed.operations[1].deltas ?? [], 'quote', { italic: true }));
  assert.ok(hasDelta(parsed.operations[2].deltas ?? [], 'done', { strike: true }));
}

function testTableCellRichTextRoundTrip() {
  const rendered = renderSingleBlock(markdownBlock({
    flavour: 'affine:table',
    type: null,
    tableData: [
      ['Header', 'Value'],
      ['Alpha', 'Important'],
    ],
    tableCellDeltas: [
      [[{ insert: 'Header', attributes: { bold: true } }], []],
      [[], [{ insert: 'Important', attributes: { italic: true } }]],
    ],
  }));

  assert.equal(
    rendered.markdown,
    '| **Header** | Value |\n| --- | --- |\n| Alpha | *Important* |',
  );
  const operation = parseMarkdownToOperations(rendered.markdown).operations[0];
  assert.equal(operation?.type, 'table');
  assert.deepEqual(operation?.tableData, [
    ['Header', 'Value'],
    ['Alpha', 'Important'],
  ]);
  assert.ok(hasDelta(operation?.tableCellDeltas?.[0]?.[0] ?? [], 'Header', { bold: true }));
  assert.ok(hasDelta(operation?.tableCellDeltas?.[1]?.[1] ?? [], 'Important', { italic: true }));
}

function testYTextDeltaCollection() {
  const doc = new Y.Doc();
  const value = doc.getText('rich-text');
  value.insert(0, 'Plain ');
  value.insert(6, 'bold', { bold: true });
  value.insert(10, ' ', {
    reference: { type: 'LinkedPage', pageId: 'doc-2' },
  });

  const deltas = richTextValueToDeltas(value);
  assert.deepEqual(deltas, [
    { insert: 'Plain ' },
    { insert: 'bold', attributes: { bold: true } },
    {
      insert: ' ',
      attributes: { reference: { type: 'LinkedPage', pageId: 'doc-2' } },
    },
  ]);

  const rendered = renderSingleBlock(markdownBlock({
    text: value.toString(),
    textDeltas: deltas,
  }));
  assert.equal(rendered.markdown, 'Plain **bold**[doc-2](LinkedPage:doc-2)');
  assert.equal(rendered.lossy, false);
  assert.equal(rendered.stats.unsupportedInlineAttributeCount, 0);
  assert.deepEqual(rendered.warnings, []);
}

function testLinkedPageReferenceBoundaryExport() {
  const attributes = { reference: { type: 'LinkedPage', pageId: 'doc-2' } };
  const link = '[doc-2](LinkedPage:doc-2)';
  const render = deltas => renderSingleBlock(markdownBlock({
    text: deltas.map(delta => delta.insert).join(''),
    textDeltas: deltas,
  })).markdown;

  assert.equal(render([
    { insert: ' ', attributes },
    { insert: 'after' },
  ]), `${link}after`);
  assert.equal(render([
    { insert: 'before ' },
    { insert: ' ', attributes },
  ]), `before ${link}`);
  assert.equal(render([{ insert: ' ', attributes }]), link);

  const coalesced = render([{ insert: '  ', attributes }]);
  assert.equal(coalesced, `${link}${link}`);
  assert.equal(render([{ insert: '\u200B\u200B', attributes }]), `${link}${link}`);
  assert.equal(render([{ insert: ' \u200B', attributes }]), `${link}${link}`);
  assert.equal(render([{ insert: 'Component register', attributes }]), link);
  const reparsed = parseMarkdownToOperations(coalesced).operations[0];
  assert.equal(
    (reparsed.deltas ?? []).filter(delta => delta.attributes?.reference?.type === 'LinkedPage').length,
    2,
    'coalesced native sentinels should export and re-import as one link per marker',
  );
}

testRenderCalloutAsAdmonition();
testParseAdmonitionAsCallout();
testParserRetainsInlineDeltas();
testNestedListParserPreservesHierarchyAndRichText();
testMixedNestedListParserPreservesOrderAndTaskStates();
testUnsupportedListContentRetainsTruthfulWarnings();
testMarkdownNestingLimitReportsPossibleLoss();
testPlainTextExportCompatibility();
testSupportedRichTextExport();
testAllSupportedAttributeCombinationsRoundTrip();
testInlineCodeBoundaryCharactersRoundTrip();
testFormattedWhitespaceAndEquivalentRunCoalescing();
testUnsupportedInlineAttributeFidelity();
testRichTextAcrossBlockTypes();
testTableCellRichTextRoundTrip();
testYTextDeltaCollection();
testLinkedPageReferenceBoundaryExport();
console.log('Markdown round-trip tests passed');
