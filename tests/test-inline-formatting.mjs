#!/usr/bin/env node
import assert from 'node:assert/strict';

import { parseMarkdownToOperations } from '../dist/markdown/parse.js';

function firstDeltas(markdown) {
  const parsed = parseMarkdownToOperations(markdown);
  const deltas = parsed.operations[0]?.deltas ?? [];
  // Filter empty inserts — they are no-ops and not meaningful
  return deltas.filter(d => d.insert.length > 0);
}

function testBold() {
  const deltas = firstDeltas('**bold text**');
  assert.deepEqual(deltas, [
    { insert: 'bold text', attributes: { bold: true } },
  ], 'bold should produce a delta with bold:true');
}

function testItalic() {
  const deltas = firstDeltas('*italic text*');
  assert.deepEqual(deltas, [
    { insert: 'italic text', attributes: { italic: true } },
  ], 'italic should produce a delta with italic:true');
}

function testStrikethrough() {
  const deltas = firstDeltas('~~struck~~');
  assert.deepEqual(deltas, [
    { insert: 'struck', attributes: { strike: true } },
  ], 'strikethrough should produce a delta with strike:true');
}

function testInlineCode() {
  const deltas = firstDeltas('`code`');
  assert.deepEqual(deltas, [
    { insert: 'code', attributes: { code: true } },
  ], 'inline code should produce a delta with code:true');
}

function testLink() {
  // A standalone link becomes a bookmark; inline links within a sentence produce deltas
  const deltas = firstDeltas('See [click here](https://example.com) for details');
  assert.deepEqual(deltas, [
    { insert: 'See ' },
    { insert: 'click here', attributes: { link: 'https://example.com' } },
    { insert: ' for details' },
  ], 'inline link should produce a delta with link attribute');
}

function testMixed() {
  const deltas = firstDeltas('**bold** and plain');
  assert.deepEqual(deltas, [
    { insert: 'bold', attributes: { bold: true } },
    { insert: ' and plain' },
  ], 'mixed content should produce separate deltas per run');
}

function testNestedBoldItalic() {
  const deltas = firstDeltas('***bold italic***');
  assert.deepEqual(deltas, [
    { insert: 'bold italic', attributes: { bold: true, italic: true } },
  ], 'bold+italic nesting should merge attributes into one delta');
}

function testPlainText() {
  const deltas = firstDeltas('just plain text');
  assert.deepEqual(deltas, [
    { insert: 'just plain text' },
  ], 'plain text should produce a single delta with no attributes');
}

function testHeadingDeltas() {
  const parsed = parseMarkdownToOperations('# **Bold Heading**');
  const op = parsed.operations[0];
  assert.equal(op.type, 'heading', 'should parse as heading');
  const deltas = (op.deltas ?? []).filter(d => d.insert.length > 0);
  assert.deepEqual(deltas, [
    { insert: 'Bold Heading', attributes: { bold: true } },
  ], 'heading deltas should carry bold attribute');
}

function testListItemDeltas() {
  const parsed = parseMarkdownToOperations('- **item**');
  const op = parsed.operations[0];
  assert.equal(op.type, 'list', 'should parse as list');
  const deltas = (op.deltas ?? []).filter(d => d.insert.length > 0);
  assert.deepEqual(deltas, [
    { insert: 'item', attributes: { bold: true } },
  ], 'list item deltas should carry bold attribute');
}

testBold();
testItalic();
testStrikethrough();
testInlineCode();
testLink();
testMixed();
testNestedBoldItalic();
testPlainText();
testHeadingDeltas();
testListItemDeltas();

console.log('Inline formatting tests passed');
