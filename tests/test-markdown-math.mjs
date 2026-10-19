#!/usr/bin/env node
// Unit test for LaTeX math in the Markdown import/export pipeline.
// Runs against dist/ and needs no AFFiNE server.
import assert from 'node:assert/strict';

import { parseMarkdownToOperations } from '../dist/markdown/parse.js';
import { renderBlocksToMarkdown } from '../dist/markdown/render.js';

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

function latexDelta(latex, attributes = {}) {
  return { insert: ' ', attributes: { ...attributes, latex } };
}

function latexValues(deltas) {
  return (deltas ?? [])
    .filter(delta => typeof delta.attributes?.latex === 'string')
    .map(delta => delta.attributes.latex);
}

function onlyOperation(markdown) {
  const parsed = parseMarkdownToOperations(markdown);
  assert.equal(parsed.operations.length, 1, `expected one operation for ${JSON.stringify(markdown)}`);
  return parsed.operations[0];
}

// markdown-it leaves empty text tokens around emphasis; AFFiNE writes skip them.
function parsedDeltas(markdown) {
  return (onlyOperation(markdown).deltas ?? []).filter(delta => delta.insert !== '');
}

function renderDeltas(deltas) {
  return renderSingleBlock(markdownBlock({
    text: deltas.map(delta => delta.insert).join(''),
    textDeltas: deltas,
  }));
}

function testDisplayMathBecomesLatexBlock() {
  const multiLine = parseMarkdownToOperations('$$\n\\int_0^1 x \\, dx = \\frac{1}{2}\n$$');
  assert.deepEqual(multiLine.operations, [{ type: 'latex', latex: '\\int_0^1 x \\, dx = \\frac{1}{2}' }]);
  assert.equal(multiLine.lossy, false);
  assert.deepEqual(multiLine.warnings, []);

  assert.deepEqual(onlyOperation('$$E = mc^2$$'), { type: 'latex', latex: 'E = mc^2' });
  assert.deepEqual(onlyOperation('  $$ a^2 + b^2 $$  '), { type: 'latex', latex: 'a^2 + b^2' });
  assert.deepEqual(
    onlyOperation('$$\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}$$'),
    { type: 'latex', latex: '\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}' },
  );
  assert.deepEqual(
    onlyOperation('$$\na\n\nb\n$$'),
    { type: 'latex', latex: 'a\n\nb' },
    'blank lines inside a display block stay in the block',
  );
}

function testDisplayMathInterruptsParagraphs() {
  const parsed = parseMarkdownToOperations('Before\n$$\nx^2\n$$\nAfter');
  assert.deepEqual(parsed.operations.map(operation => operation.type), ['paragraph', 'latex', 'paragraph']);
  assert.equal(parsed.operations[0].text, 'Before');
  assert.equal(parsed.operations[1].latex, 'x^2');
  assert.equal(parsed.operations[2].text, 'After');
}

function testDisplayMathLookalikesStayText() {
  const unclosed = parseMarkdownToOperations('$$\nx\n\nNext paragraph');
  assert.deepEqual(unclosed.operations.map(operation => operation.type), ['paragraph', 'paragraph']);
  assert.equal(unclosed.operations[0].text, '$$\nx');
  assert.equal(unclosed.operations[1].text, 'Next paragraph');

  const indented = onlyOperation('    $$x$$');
  assert.equal(indented.type, 'code', 'four-space indentation is still an indented code block');

  const fenced = onlyOperation('```\n$$\nx\n$$\n```');
  assert.deepEqual(fenced, { type: 'code', text: '$$\nx\n$$', language: undefined });

  const trailingText = onlyOperation('$$x$$ is display-style math used inline');
  assert.equal(trailingText.type, 'paragraph');
  assert.deepEqual(latexValues(trailingText.deltas), ['x']);
}

function testEmptyDisplayMathIsReported() {
  const parsed = parseMarkdownToOperations('$$\n$$');
  assert.deepEqual(parsed.operations, []);
  assert.equal(parsed.lossy, true);
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0], /empty display math/i);
}

function testInlineMathBecomesLatexDelta() {
  const operation = onlyOperation('Euler: $e^{i\\pi} + 1 = 0$ holds.');
  assert.equal(operation.type, 'paragraph');
  assert.deepEqual(operation.deltas, [
    { insert: 'Euler: ' },
    latexDelta('e^{i\\pi} + 1 = 0'),
    { insert: ' holds.' },
  ]);

  assert.deepEqual(
    latexValues(onlyOperation('Spacing $a \\, b \\; c$ and \\$5').deltas),
    ['a \\, b \\; c'],
    'backslash escapes inside math must reach AFFiNE untouched',
  );
  assert.deepEqual(latexValues(onlyOperation('Inline $$x^2$$ here').deltas), ['x^2']);
  assert.deepEqual(latexValues(onlyOperation('Price $\\$5$ in math').deltas), ['\\$5']);
  assert.deepEqual(latexValues(onlyOperation('Two $a$$b$ adjacent').deltas), ['a', 'b']);
  assert.deepEqual(
    latexValues(onlyOperation('**$x$** and [$y$](https://example.com)').deltas),
    ['x', 'y'],
  );
  assert.deepEqual(parsedDeltas('**$x$**'), [latexDelta('x', { bold: true })]);
}

function testDollarTextIsNotMath() {
  const samples = [
    'It costs $5 and $10.',
    'Between $20,000 and $30,000 per year',
    'Range $5-$10 today',
    'A lone $ sign',
    'Spaced $ x $ is not math',
    'Escaped \\$x\\$ stays literal',
    'Code `$x$` stays code',
    'Line $x\ny$ break',
    'Empty $$ pair',
  ];
  for (const markdown of samples) {
    const operation = onlyOperation(markdown);
    assert.equal(operation.type, 'paragraph', markdown);
    assert.deepEqual(latexValues(operation.deltas), [], `${markdown} must not produce math`);
  }
  assert.equal(onlyOperation('Escaped \\$x\\$ stays literal').text, 'Escaped $x$ stays literal');
  assert.equal(onlyOperation('It costs $5 and $10.').text, 'It costs $5 and $10.');
}

function testMathOnlyInlineBlocksSurvive() {
  const paragraph = onlyOperation('$x$');
  assert.equal(paragraph.type, 'paragraph', 'a paragraph holding only inline math must not be dropped');
  assert.deepEqual(paragraph.deltas, [latexDelta('x')]);

  const cases = [
    { markdown: '# $x$', type: 'heading' },
    { markdown: '- $x$', type: 'list', style: 'bulleted' },
    { markdown: '1. $x$', type: 'list', style: 'numbered' },
    { markdown: '- [ ] $x$', type: 'list', style: 'todo', checked: false },
    { markdown: '- [x] Solve $x$', type: 'list', style: 'todo', checked: true },
    { markdown: '> $x$', type: 'quote' },
    { markdown: '> [!NOTE]\n> $x$', type: 'callout' },
  ];
  for (const testCase of cases) {
    const operation = onlyOperation(testCase.markdown);
    assert.equal(operation.type, testCase.type, testCase.markdown);
    if (testCase.style) assert.equal(operation.style, testCase.style, testCase.markdown);
    if (testCase.checked !== undefined) assert.equal(operation.checked, testCase.checked, testCase.markdown);
    assert.deepEqual(latexValues(operation.deltas), ['x'], `${testCase.markdown} must keep its math`);
    assert.ok(
      !(operation.deltas ?? []).some(delta => delta.insert.startsWith('[')),
      `${testCase.markdown} must not keep a task marker`,
    );
  }
}

function testTableCellMath() {
  const table = onlyOperation('| Norm | Value |\n| --- | --- |\n| $\\lVert x \\rVert$ | $a\\|b$ |');
  assert.equal(table.type, 'table');
  assert.deepEqual(latexValues(table.tableCellDeltas[1][0]), ['\\lVert x \\rVert']);
  assert.deepEqual(latexValues(table.tableCellDeltas[1][1]), ['a|b'], 'escaped pipes stay inside the formula');
}

function testDisplayMathInsideContainersBecomesInlineMath() {
  const quote = parseMarkdownToOperations('> Note:\n> $$\n> x^2\n> $$');
  assert.equal(quote.operations.length, 1);
  assert.equal(quote.operations[0].type, 'quote');
  assert.deepEqual(latexValues(quote.operations[0].deltas), ['x^2']);
  assert.equal(quote.lossy, true);
  assert.ok(quote.warnings.some(warning => /display math/i.test(warning)), quote.warnings.join('\n'));

  const list = parseMarkdownToOperations('- Step one\n  $$\n  y = 1\n  $$\n- Step two');
  assert.deepEqual(list.operations.map(operation => operation.type), ['list', 'list']);
  assert.equal(list.operations[0].text.startsWith('Step one'), true);
  assert.deepEqual(latexValues(list.operations[0].deltas), ['y = 1']);
  assert.equal(list.operations[1].text, 'Step two');
  assert.equal(list.lossy, true);
}

function testListTextAfterDisplayMathIsPreserved() {
  const cases = [
    { markdown: '- Before\n  $$x$$\n  After', text: 'Before\n \nAfter' },
    { markdown: '- $$x$$\n  After', text: ' \nAfter' },
    { markdown: '- $$x$$\n\n  After', text: ' \nAfter' },
    { markdown: '- Before\n  $$\n  x\n  $$\n  After', text: 'Before\n \nAfter' },
    { markdown: '- [x] Before\n  $$x$$\n  After', text: 'Before\n \nAfter', checked: true },
    { markdown: '- [ ]\n  $$x$$\n  After', text: ' \nAfter', checked: false },
  ];
  for (const { markdown, text, checked } of cases) {
    const parsed = parseMarkdownToOperations(markdown);
    assert.equal(parsed.operations.length, 1, markdown);
    const operation = parsed.operations[0];
    assert.equal(operation.type, 'list', markdown);
    assert.equal(operation.text, text, markdown);
    assert.equal(operation.deltas.map(delta => delta.insert).join(''), text, markdown);
    assert.deepEqual(latexValues(operation.deltas), ['x'], markdown);
    assert.equal(operation.style, checked === undefined ? 'bulleted' : 'todo', markdown);
    if (checked !== undefined) assert.equal(operation.checked, checked, markdown);
    assert.equal(parsed.lossy, true, 'display-to-inline conversion is still reported');
  }

  const nested = parseMarkdownToOperations('- Before\n  $$x$$\n  After\n  - Child $y$');
  assert.deepEqual(nested.operations.map(operation => operation.text), ['Before\n \nAfter', 'Child  ']);
  assert.deepEqual(nested.operations.map(operation => latexValues(operation.deltas)), [['x'], ['y']]);
}

function testLatexBlockExport() {
  const block = markdownBlock({
    flavour: 'affine:latex',
    type: null,
    latex: '\\int_0^1 x \\, dx',
  });
  const rendered = renderSingleBlock(block);
  assert.equal(rendered.markdown, '$$\n\\int_0^1 x \\, dx\n$$');
  assert.equal(rendered.lossy, false);
  assert.deepEqual(rendered.warnings, []);
  assert.deepEqual(parseMarkdownToOperations(rendered.markdown).operations, [
    { type: 'latex', latex: '\\int_0^1 x \\, dx' },
  ]);

  const multiLine = '\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}';
  const multiLineRendered = renderSingleBlock(markdownBlock({ flavour: 'affine:latex', type: null, latex: multiLine }));
  assert.equal(multiLineRendered.markdown, `$$\n${multiLine}\n$$`);
  assert.deepEqual(parseMarkdownToOperations(multiLineRendered.markdown).operations, [{ type: 'latex', latex: multiLine }]);
}

function testLatexBlockExportEdgeCases() {
  const empty = renderSingleBlock(markdownBlock({ flavour: 'affine:latex', type: null, latex: '  ' }));
  assert.equal(empty.markdown, '');
  assert.equal(empty.lossy, true);
  assert.match(empty.warnings.join('\n'), /LaTeX block 'block-1'.*empty/);

  const missing = renderSingleBlock(markdownBlock({ flavour: 'affine:latex', type: null }));
  assert.equal(missing.markdown, '');
  assert.equal(missing.lossy, true);

  const unsafe = renderSingleBlock(markdownBlock({ flavour: 'affine:latex', type: null, latex: 'a $$\nb' }));
  assert.equal(unsafe.lossy, true);
  assert.match(unsafe.warnings.join('\n'), /LaTeX block 'block-1'/);
  const reparsed = parseMarkdownToOperations(unsafe.markdown).operations;
  assert.deepEqual(reparsed, [{ type: 'code', text: 'a $$\nb', language: 'latex' }]);
}

function testInlineLatexExport() {
  const deltas = [
    { insert: 'Euler: ' },
    latexDelta('e^{i\\pi} + 1 = 0'),
    { insert: ' holds.' },
  ];
  const rendered = renderDeltas(deltas);
  assert.equal(rendered.markdown, 'Euler: $e^{i\\pi} + 1 = 0$ holds.');
  assert.equal(rendered.lossy, false);
  assert.deepEqual(rendered.warnings, []);
  assert.deepEqual(parsedDeltas(rendered.markdown), deltas);

  assert.equal(renderDeltas([latexDelta('x')]).markdown, '$x$', 'math-only paragraphs must not be trimmed away');
  assert.equal(renderDeltas([latexDelta('x', { bold: true })]).markdown, '**$x$**');
  assert.equal(renderDeltas([{ insert: '  ', attributes: { latex: 'x' } }]).markdown, '$x$$x$');
  assert.equal(renderDeltas([latexDelta(' x ')]).markdown, '$x$');
}

function testInlineLatexExportRoundTrips() {
  const samples = [
    [latexDelta('a \\, b'), { insert: ' and ' }, latexDelta('c')],
    [latexDelta('x'), { insert: '5 apples' }],
    // Nested dollars need $$ delimiters; a line holding only $$...$$ would be display math.
    [{ insert: 'see ' }, latexDelta('\\text{$y$}')],
    [latexDelta('\\$5')],
    [{ insert: 'cost $' }, latexDelta('x')],
    [{ insert: 'back\\' }, latexDelta('x')],
    // A paragraph holding only a link imports as a bookmark, so keep text around it.
    [{ insert: 'see ' }, latexDelta('x', { link: 'https://example.com' })],
    [latexDelta('x', { italic: true }), { insert: ' ' }, latexDelta('y', { strike: true })],
    [{ insert: 'A ' }, { insert: 'bold', attributes: { bold: true } }, { insert: ' ' }, latexDelta('z'), { insert: '.' }],
  ];
  for (const deltas of samples) {
    const rendered = renderDeltas(deltas);
    assert.equal(rendered.lossy, false, rendered.markdown);
    assert.equal(onlyOperation(rendered.markdown).type, 'paragraph', rendered.markdown);
    assert.deepEqual(parsedDeltas(rendered.markdown), deltas, rendered.markdown);
  }
}

function testStandaloneDoubleDollarInlineMathReportsBlockConversion() {
  const latex = '\\text{$y$}';
  const cases = [
    [latexDelta(latex)],
    [{ insert: '  ' }, latexDelta(latex), { insert: '  ' }],
    [latexDelta(latex), { insert: '', attributes: { bold: true } }],
  ];
  for (const deltas of cases) {
    const rendered = renderDeltas(deltas);
    assert.equal(rendered.markdown, `$$${latex}$$`);
    assert.deepEqual(parseMarkdownToOperations(rendered.markdown).operations, [{ type: 'latex', latex }]);
    assert.equal(rendered.lossy, true);
    assert.equal(rendered.stats.unsupportedCount, 1);
    assert.equal(rendered.stats.unsupportedInlineAttributeCount, 0, 'the formula itself is preserved');
    assert.match(rendered.warnings.join('\n'), /inline math.*display math block/);
  }

  const contextual = [
    [{ insert: 'See ' }, latexDelta(latex)],
    [latexDelta(latex), { insert: ' after' }],
    [latexDelta(latex, { bold: true })],
    [latexDelta(latex), latexDelta('\\text{$z$}')],
    [{ insert: '  ', attributes: { latex } }],
    [latexDelta(latex), latexDelta(latex)],
  ];
  for (const deltas of contextual) {
    const rendered = renderDeltas(deltas);
    assert.equal(rendered.lossy, false, rendered.markdown);
    const operation = onlyOperation(rendered.markdown);
    assert.equal(operation.type, 'paragraph', rendered.markdown);
    const expected = deltas.flatMap(delta => typeof delta.attributes?.latex === 'string'
      ? Array(delta.insert.length).fill(delta.attributes.latex)
      : []);
    assert.deepEqual(latexValues(operation.deltas), expected, rendered.markdown);
  }

  for (const overrides of [
    { type: 'h2' },
    { flavour: 'affine:list', type: 'bulleted' },
    { type: 'quote' },
    { flavour: 'affine:callout', type: null },
  ]) {
    const rendered = renderSingleBlock(markdownBlock({ ...overrides, textDeltas: [latexDelta(latex)] }));
    assert.equal(rendered.lossy, false, rendered.markdown);
    assert.deepEqual(latexValues(onlyOperation(rendered.markdown).deltas), [latex], rendered.markdown);
  }

  const callout = markdownBlock({ id: 'callout', flavour: 'affine:callout', type: null, childIds: ['body'] });
  const body = markdownBlock({ id: 'body', parentId: 'callout', textDeltas: [latexDelta(latex)] });
  const renderedCallout = renderBlocksToMarkdown({
    rootBlockIds: [callout.id],
    blocksById: new Map([[callout.id, callout], [body.id, body]]),
  });
  assert.equal(renderedCallout.lossy, false, 'native callout child paragraphs stay inline after quoting');
  assert.deepEqual(renderedCallout.warnings, []);
  assert.deepEqual(latexValues(onlyOperation(renderedCallout.markdown).deltas), [latex]);
}

function testUnrepresentableInlineLatexIsReported() {
  for (const latex of ['a\nb', 'x\\', '']) {
    const rendered = renderDeltas([{ insert: 'f ' }, latexDelta(latex)]);
    assert.equal(rendered.lossy, true, JSON.stringify(latex));
    assert.equal(rendered.stats.unsupportedInlineAttributeCount, 1, JSON.stringify(latex));
    assert.match(rendered.warnings.join('\n'), /'latex'/);
  }
}

function testTableCellLatexExport() {
  const rendered = renderSingleBlock(markdownBlock({
    flavour: 'affine:table',
    type: null,
    tableData: [['Norm'], [' ']],
    tableCellDeltas: [[[{ insert: 'Norm' }]], [[latexDelta('a|b'), { insert: ' and ' }, latexDelta('\\|v\\|')]]],
  }));
  assert.equal(rendered.markdown, '| Norm |\n| --- |\n| $a\\|b$ and $\\\\|v\\\\|$ |');
  const table = onlyOperation(rendered.markdown);
  assert.deepEqual(latexValues(table.tableCellDeltas[1][0]), ['a|b', '\\|v\\|']);
}

function testExportedMathCannotInjectMarkup() {
  // Renderers without math support read math as Markdown; keep it inert there.
  const payload = '# heading\n- item\n[owned](javascript:alert(1))\n[ref]: javascript:alert(1)\n<script>alert(1)</script>';
  const display = renderSingleBlock(markdownBlock({ flavour: 'affine:latex', type: null, latex: payload }));
  const inline = renderDeltas([{ insert: 'f ' }, latexDelta(payload.replaceAll('\n', ' '))]);
  for (const rendered of [display, inline]) {
    assert.ok(!rendered.markdown.includes('<script>'), rendered.markdown);
    assert.ok(!rendered.markdown.includes('</script>'), rendered.markdown);
    assert.ok(!rendered.markdown.includes('](javascript:'), rendered.markdown);
    assert.ok(!rendered.markdown.includes(']: javascript:'), rendered.markdown);
    assert.equal(rendered.lossy, true, 'added spaces change the stored LaTeX and must be reported');
    assert.equal(rendered.warnings.length, 1, rendered.warnings.join('\n'));
    assert.match(rendered.warnings[0], /followed with a space/);
  }
  assert.match(display.warnings[0], /^LaTeX block 'block-1'/);
  assert.match(inline.warnings[0], /^Block 'block-1'/);
  assert.deepEqual(parseMarkdownToOperations(display.markdown).operations, [{
    type: 'latex',
    latex: '# heading\n- item\n[owned] (javascript:alert(1))\n[ref] : javascript:alert(1)\n< script>alert(1)< /script>',
  }]);

  // A `<` opens HTML only before a later `>` or at the start of a line.
  for (const latex of ['0<x<1', 'a<b', 'a < b, [0,1]', 'x>y<z']) {
    const rendered = renderDeltas([latexDelta(latex)]);
    assert.equal(rendered.markdown, `$${latex}$`, latex);
    assert.equal(rendered.lossy, false, latex);
    assert.deepEqual(rendered.warnings, [], latex);
  }
  assert.equal(renderDeltas([latexDelta('a<b>c')]).markdown, '$a< b>c$');
  const lineStart = renderSingleBlock(markdownBlock({ flavour: 'affine:latex', type: null, latex: 'x\n  <div\ny' }));
  assert.equal(lineStart.markdown, '$$\nx\n  < div\ny\n$$');
  assert.equal(lineStart.lossy, true);
}

function testDollarTextRoundTripsAsText() {
  const samples = [
    'Cancel the card; try to get the $95 annual fee waived',
    'It costs $5 and $10.',
    'a $b$ c',
    '$$x$$',
    'Range $5-$10',
    '$',
  ];
  for (const text of samples) {
    for (const textSource of [{ text }, { text, textDeltas: [{ insert: text }] }]) {
      const rendered = renderSingleBlock(markdownBlock(textSource));
      const operation = onlyOperation(rendered.markdown);
      assert.equal(operation.type, 'paragraph', rendered.markdown);
      assert.equal(operation.text, text, rendered.markdown);
      assert.deepEqual(latexValues(operation.deltas), [], rendered.markdown);
    }
  }
  assert.equal(
    renderSingleBlock(markdownBlock({ text: 'Cancel the card; try to get the $95 annual fee waived' })).markdown,
    'Cancel the card; try to get the $95 annual fee waived',
    'a single dollar sign cannot delimit math and stays unescaped',
  );

  const splitAcrossRuns = [
    { insert: 'cost $5 ' },
    { insert: 'or', attributes: { bold: true } },
    { insert: ' 6$ total' },
  ];
  const rendered = renderDeltas(splitAcrossRuns);
  assert.deepEqual(parsedDeltas(rendered.markdown), splitAcrossRuns, rendered.markdown);

  const nextToMath = [{ insert: 'Pay $5 for ' }, latexDelta('x')];
  assert.deepEqual(parsedDeltas(renderDeltas(nextToMath).markdown), nextToMath);

  const tableText = renderSingleBlock(markdownBlock({
    flavour: 'affine:table',
    type: null,
    tableData: [['Price'], ['$5 or $6']],
  }));
  assert.equal(onlyOperation(tableText.markdown).tableData[1][0], '$5 or $6');
}

function testCodeFallbackDollarTextRoundTripsAsText() {
  const table = renderSingleBlock(markdownBlock({
    flavour: 'affine:table',
    type: null,
    tableData: [['Value'], ['a|b$c$']],
    tableCellDeltas: [[[{ insert: 'Value' }]], [[
      { insert: 'a|b$', attributes: { code: true } },
      { insert: 'c$' },
    ]]],
  }));
  assert.equal(table.markdown, '| Value |\n| --- |\n| a\\|b\\$c\\$ |');
  const operation = onlyOperation(table.markdown);
  assert.equal(operation.tableData[1][0], 'a|b$c$');
  assert.deepEqual(latexValues(operation.tableCellDeltas[1][0]), []);
  assert.equal(table.lossy, true);
  assert.equal(table.stats.unsupportedCount, 1);
  assert.equal(table.stats.unsupportedInlineAttributeCount, 1);
  assert.equal(table.warnings.length, 1);
  assert.match(table.warnings[0], /'code'/);

  for (const [lineBreak, escaped] of [
    ['\n', '&#10;'],
    ['\r', '&#13;'],
    ['\r\n', '&#13;&#10;'],
    ['\u2028', '&#8232;'],
    ['\u2029', '&#8233;'],
  ]) {
    const rendered = renderDeltas([
      { insert: `a${lineBreak}b$`, attributes: { code: true } },
      { insert: 'c$' },
    ]);
    assert.equal(rendered.markdown, `a${escaped}b\\$c\\$`);
    const paragraph = onlyOperation(rendered.markdown);
    assert.equal(paragraph.text, `a${lineBreak}b$c$`);
    assert.deepEqual(latexValues(paragraph.deltas), []);
    assert.equal(rendered.stats.unsupportedCount, 1);
    assert.equal(rendered.stats.unsupportedInlineAttributeCount, 1);
    assert.equal(rendered.warnings.length, 1);
    assert.match(rendered.warnings[0], /'code'/);
  }

  const safeCode = [{ insert: 'a$b', attributes: { code: true } }, { insert: 'c$' }];
  const safe = renderDeltas(safeCode);
  assert.equal(safe.markdown, '`a$b`c$');
  assert.equal(safe.lossy, false);
  assert.deepEqual(parsedDeltas(safe.markdown), safeCode);
}

testDisplayMathBecomesLatexBlock();
testDisplayMathInterruptsParagraphs();
testDisplayMathLookalikesStayText();
testEmptyDisplayMathIsReported();
testInlineMathBecomesLatexDelta();
testDollarTextIsNotMath();
testMathOnlyInlineBlocksSurvive();
testTableCellMath();
testDisplayMathInsideContainersBecomesInlineMath();
testListTextAfterDisplayMathIsPreserved();
testLatexBlockExport();
testLatexBlockExportEdgeCases();
testInlineLatexExport();
testInlineLatexExportRoundTrips();
testStandaloneDoubleDollarInlineMathReportsBlockConversion();
testUnrepresentableInlineLatexIsReported();
testTableCellLatexExport();
testExportedMathCannotInjectMarkup();
testDollarTextRoundTripsAsText();
testCodeFallbackDollarTextRoundTripsAsText();
console.log('Markdown math tests passed');
