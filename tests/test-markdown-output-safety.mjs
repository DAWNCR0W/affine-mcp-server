#!/usr/bin/env node
import assert from 'node:assert/strict';

import { parseMarkdownToOperations } from '../dist/markdown/parse.js';
import { renderBlocksToMarkdown } from '../dist/markdown/render.js';
import {
  buildMarkdownFrontmatter,
  escapeMarkdownLinkDestination,
  hasUnsafeMarkdownLinkScheme,
  quoteYamlString,
  renderFencedCodeBlock,
  renderMarkdownLink,
} from '../dist/markdown/safety.js';

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

function testYamlFrontmatterEscaping() {
  const docId = 'doc"\\id\n---';
  const title = 'Title "quoted"\\path\n---\nlossy: false\u0000\u0085\u2028tail';
  const tags = ['plain', 'tag"\\value\n- injected', 'literal\u2029separator'];
  const frontmatter = buildMarkdownFrontmatter({
    docId,
    title,
    tags,
    lossy: true,
    fidelityRisk: 'medium\n---\nhigh',
  });
  const lines = frontmatter.split('\n');

  assert.equal(lines.length, 10, 'frontmatter values must not create additional YAML lines');
  assert.equal(JSON.parse(lines[1].slice('docId: '.length)), docId);
  assert.equal(JSON.parse(lines[2].slice('title: '.length)), title);
  assert.equal(JSON.parse(lines[4].slice('  - '.length)), tags[0]);
  assert.equal(JSON.parse(lines[5].slice('  - '.length)), tags[1]);
  assert.equal(JSON.parse(lines[6].slice('  - '.length)), tags[2]);
  assert.equal(lines[7], 'lossy: true');
  assert.equal(JSON.parse(lines[8].slice('fidelityRisk: '.length)), 'medium\n---\nhigh');
  assert.ok(!frontmatter.includes('\u2028'));
  assert.ok(!frontmatter.includes('\u2029'));
  assert.ok(!frontmatter.includes('\u0085'));
  assert.equal(quoteYamlString('ordinary'), '"ordinary"');

  const emptyTags = buildMarkdownFrontmatter({
    docId: 'doc',
    title: 'Untitled',
    tags: [],
    lossy: false,
  });
  assert.match(emptyTags, /tags: \[\]\nlossy: false/);
}

function testExportedFrontmatterDoesNotBecomeImportedBody() {
  const body = renderSingleBlock(markdownBlock({
    type: 'h2',
    text: 'Safe copied heading',
  })).markdown;
  const frontmatter = buildMarkdownFrontmatter({
    docId: 'doc\n---\n# injected',
    title: 'Title\n---\n- injected',
    tags: ['tag\n# injected'],
    lossy: false,
  });
  const parsed = parseMarkdownToOperations(`${frontmatter}\n\n${body}`);

  assert.equal(parsed.operations.length, 1);
  assert.equal(parsed.operations[0]?.type, 'heading');
  assert.equal(parsed.operations[0]?.level, 2);
  assert.equal(parsed.operations[0]?.text, 'Safe copied heading');
  assert.equal(parsed.lossy, false);

  const ordinaryRule = parseMarkdownToOperations('---\n\nBody without a closing frontmatter delimiter');
  assert.deepEqual(ordinaryRule.operations.map(operation => operation.type), ['divider', 'paragraph']);

  const ordinaryDelimitedBody = parseMarkdownToOperations('---\nFirst section\n---\nSecond section');
  assert.deepEqual(
    ordinaryDelimitedBody.operations.map(operation => operation.type),
    ['divider', 'heading', 'paragraph'],
  );
  assert.equal(ordinaryDelimitedBody.operations[1]?.text, 'First section');
  assert.equal(ordinaryDelimitedBody.operations[2]?.text, 'Second section');
}

function testCodeFenceSelectionAndRoundTrip() {
  assert.deepEqual(renderFencedCodeBlock('const ok = true;', 'ts'), [
    '``` ts',
    'const ok = true;',
    '```',
  ]);

  const collisions = [
    ['before\n```\nafter', 'js'],
    ['before\n```\n~~~\nafter', null],
  ];
  for (const [text, language] of collisions) {
    const rendered = renderSingleBlock(markdownBlock({
      flavour: 'affine:code',
      text,
      language,
    }));
    const parsed = parseMarkdownToOperations(rendered.markdown);
    assert.equal(parsed.operations.length, 1);
    assert.equal(parsed.operations[0]?.type, 'code');
    assert.equal(parsed.operations[0]?.text, text);
  }

  const injectedInfo = renderFencedCodeBlock('body', 'js\n```\n# injected');
  assert.equal(injectedInfo.length, 3);
  const parsed = parseMarkdownToOperations(injectedInfo.join('\n'));
  assert.equal(parsed.operations.length, 1, 'fence info line breaks must not create injected blocks');
  assert.equal(parsed.operations[0]?.type, 'code');
  assert.equal(parsed.operations[0]?.text, 'body');

  const prefixCollisionLanguage = '~~~`lang';
  const prefixCollision = renderFencedCodeBlock('body\n# injected', prefixCollisionLanguage);
  assert.equal(prefixCollision[0], '~~~ ~~~`lang');
  assert.equal(prefixCollision[2], '~~~');
  const prefixCollisionParsed = parseMarkdownToOperations(prefixCollision.join('\n'));
  assert.equal(prefixCollisionParsed.operations.length, 1);
  assert.equal(prefixCollisionParsed.operations[0]?.type, 'code');
  assert.equal(prefixCollisionParsed.operations[0]?.language, prefixCollisionLanguage);
  assert.equal(prefixCollisionParsed.operations[0]?.text, 'body\n# injected');
}

function testLinkEscapingAndUnsafeSchemes() {
  assert.equal(renderMarkdownLink('Example', 'https://example.com/path'), '[Example](https://example.com/path)');
  assert.equal(escapeMarkdownLinkDestination('https://example.com/a b_(c)'), '<https://example.com/a b_(c)>');

  const unsafeDestinations = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\nscript:alert(1)',
    'jav&#x61;script:alert(1)',
    'javascript&colon;alert(1)',
    'java&Tab;script:alert(1)',
    'java&NewLine;script:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
  ];
  for (const destination of unsafeDestinations) {
    assert.equal(hasUnsafeMarkdownLinkScheme(destination), true, destination);
    assert.equal(renderMarkdownLink('Unsafe', destination), null, destination);
  }

  for (const destination of [
    'https://example.com',
    'mailto:test@example.com',
    '#section',
    '/relative',
    'affine://doc/id',
  ]) {
    assert.equal(hasUnsafeMarkdownLinkScheme(destination), false, destination);
  }

  const label = 'Safe](javascript:alert(1))\n# injected\\[tail<script>';
  const safeLink = renderMarkdownLink(label, 'https://example.com/path');
  assert.ok(safeLink);
  assert.ok(!safeLink.includes('\n'));
  assert.ok(!safeLink.includes('<script>'));
  const parsed = parseMarkdownToOperations(safeLink);
  assert.equal(parsed.operations.length, 1);
  assert.equal(parsed.operations[0]?.type, 'bookmark');
  assert.equal(parsed.operations[0]?.caption, label);
  assert.equal(parsed.operations[0]?.url, 'https://example.com/path');

  const destinationPayload = 'https://example.com/path)\n# injected';
  const destinationSafeLink = renderMarkdownLink('Destination', destinationPayload);
  assert.ok(destinationSafeLink);
  assert.ok(!destinationSafeLink.includes('\n'));
  const destinationParsed = parseMarkdownToOperations(destinationSafeLink);
  assert.equal(destinationParsed.operations.length, 1);
  assert.equal(destinationParsed.operations[0]?.type, 'bookmark');
  assert.match(destinationParsed.operations[0]?.url ?? '', /^https:\/\/example\.com\//);
}

function testPlainAndDeltaTextCannotInjectBlocks() {
  const payload = '# heading\n- item\n[owned](javascript:alert(1))\n<script>alert(1)</script>';
  const contexts = [
    [{ flavour: 'affine:paragraph', type: 'text' }, 'paragraph'],
    [{ flavour: 'affine:paragraph', type: 'h2' }, 'heading'],
    [{ flavour: 'affine:paragraph', type: 'quote' }, 'quote'],
    [{ flavour: 'affine:list', type: 'bulleted' }, 'list'],
    [{ flavour: 'affine:callout', type: null }, 'callout'],
  ];

  for (const [context, expectedType] of contexts) {
    for (const textSource of [
      { text: payload },
      { text: payload, textDeltas: [{ insert: payload }] },
    ]) {
      const rendered = renderSingleBlock(markdownBlock({ ...context, ...textSource }));
      const parsed = parseMarkdownToOperations(rendered.markdown);
      assert.equal(parsed.operations.length, 1, `${expectedType}: ${rendered.markdown}`);
      assert.equal(parsed.operations[0]?.type, expectedType, rendered.markdown);
      assert.equal(parsed.operations[0]?.text, payload, rendered.markdown);
      assert.ok(!rendered.markdown.includes('<script>'));
      assert.ok(!rendered.markdown.includes('(javascript:'));
    }
  }
}

function testFormattedRichTextCannotInjectStructure() {
  const payload = '# heading\n- item\n](javascript:alert(1))\n<script>';
  const rendered = renderSingleBlock(markdownBlock({
    text: `before ${payload} after`,
    textDeltas: [
      { insert: 'before ' },
      {
        insert: payload,
        attributes: { bold: true, link: 'https://example.com/path' },
      },
      { insert: ' after' },
    ],
  }));
  const parsed = parseMarkdownToOperations(rendered.markdown);

  assert.equal(rendered.lossy, false);
  assert.equal(parsed.operations.length, 1);
  assert.equal(parsed.operations[0]?.type, 'paragraph');
  assert.equal(parsed.operations[0]?.text, `before ${payload} after`);
  const protectedDelta = parsed.operations[0]?.deltas?.find(delta => delta.insert === payload);
  assert.ok(protectedDelta, rendered.markdown);
  assert.equal(protectedDelta.attributes?.bold, true);
  assert.equal(protectedDelta.attributes?.link, 'https://example.com/path');
}

function testUnsafeRichTextLinkDowngradesWithoutLosingText() {
  for (const destination of ['javascript:alert(1)', 'jav&#x61;script:alert(1)', 'data:text/html,payload']) {
    const rendered = renderSingleBlock(markdownBlock({
      text: 'before linked after',
      textDeltas: [
        { insert: 'before ' },
        { insert: 'linked', attributes: { bold: true, link: destination } },
        { insert: ' after' },
      ],
    }));
    const operation = parseMarkdownToOperations(rendered.markdown).operations[0];

    assert.equal(rendered.lossy, true, destination);
    assert.equal(rendered.stats.unsupportedInlineAttributeCount, 1, destination);
    assert.match(rendered.warnings[0], /unsafe URL scheme/);
    assert.equal(operation?.type, 'paragraph');
    assert.equal(operation?.text, 'before linked after');
    const linkedDelta = operation?.deltas?.find(delta => delta.insert === 'linked');
    assert.equal(linkedDelta?.attributes?.bold, true);
    assert.equal(linkedDelta?.attributes?.link, undefined);
  }
}

function testBookmarkBlockEscapingAndDowngrade() {
  const caption = '# Read me](https://attacker.example)\n---\n<script>';
  const safe = renderSingleBlock(markdownBlock({
    flavour: 'affine:bookmark',
    caption,
    url: 'https://example.com/path',
  }));
  const safeParsed = parseMarkdownToOperations(safe.markdown);
  assert.equal(safeParsed.operations.length, 1);
  assert.equal(safeParsed.operations[0]?.type, 'bookmark');
  assert.equal(safeParsed.operations[0]?.caption, caption);
  assert.equal(safeParsed.operations[0]?.url, 'https://example.com/path');

  const unsafe = renderSingleBlock(markdownBlock({
    flavour: 'affine:bookmark',
    caption,
    url: 'javascript:alert(1)',
  }));
  const unsafeParsed = parseMarkdownToOperations(unsafe.markdown);
  assert.equal(unsafe.lossy, true);
  assert.equal(unsafeParsed.operations.length, 1);
  assert.equal(unsafeParsed.operations[0]?.type, 'paragraph');
  assert.equal(unsafeParsed.operations[0]?.text, caption);
}

function testTableCellInjectionRoundTrip() {
  const payload = 'alpha|beta\n---\n<script>\\tail';
  const tableData = [
    ['Header', 'Value'],
    [payload, 'tail'],
  ];
  const variants = [
    {},
    {
      tableCellDeltas: [
        [[], []],
        [[{ insert: payload, attributes: { bold: true } }], []],
      ],
    },
  ];

  for (const variant of variants) {
    const rendered = renderSingleBlock(markdownBlock({
      flavour: 'affine:table',
      type: null,
      tableData,
      ...variant,
    }));
    const parsed = parseMarkdownToOperations(rendered.markdown);

    assert.equal(rendered.markdown.split('\n').length, 3, 'cell newlines must not create extra table rows');
    assert.equal(parsed.operations.length, 1);
    assert.equal(parsed.operations[0]?.type, 'table');
    assert.deepEqual(parsed.operations[0]?.tableData, tableData);
    if (variant.tableCellDeltas) {
      const payloadDelta = parsed.operations[0]?.tableCellDeltas?.[1]?.[0]
        ?.find(delta => delta.insert === payload);
      assert.equal(payloadDelta?.attributes?.bold, true);
    }
  }
}

function testUnsupportedPlaceholderCannotCloseItsComment() {
  const block = markdownBlock({
    id: 'block-->\n# injected',
    flavour: 'affine:unknown-->\n<script>',
  });
  const rendered = renderSingleBlock(block);

  assert.equal(rendered.markdown.split('\n').length, 1);
  assert.ok(!rendered.markdown.includes('unknown-->'));
  assert.ok(!rendered.markdown.includes('<script>'));
  assert.equal((rendered.markdown.match(/-->/g) ?? []).length, 1);
}

testYamlFrontmatterEscaping();
testExportedFrontmatterDoesNotBecomeImportedBody();
testCodeFenceSelectionAndRoundTrip();
testLinkEscapingAndUnsafeSchemes();
testPlainAndDeltaTextCannotInjectBlocks();
testFormattedRichTextCannotInjectStructure();
testUnsafeRichTextLinkDowngradesWithoutLosingText();
testBookmarkBlockEscapingAndDowngrade();
testTableCellInjectionRoundTrip();
testUnsupportedPlaceholderCannotCloseItsComment();
console.log('Markdown output safety tests passed');
