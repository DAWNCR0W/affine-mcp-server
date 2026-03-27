#!/usr/bin/env node
import assert from 'node:assert/strict';

import { parseMarkdownToOperations } from '../dist/markdown/parse.js';

function filterDeltas(deltas) {
  return (deltas ?? []).filter(d => d.insert.length > 0);
}

function testHardBreakDelta() {
  // Two trailing spaces before \n is the Markdown hard break syntax
  const deltas = filterDeltas(parseMarkdownToOperations('first  \nsecond').operations[0]?.deltas);
  assert.deepEqual(deltas, [
    { insert: 'first' },
    { insert: '  \n' },
    { insert: 'second' },
  ], 'hard break should produce { insert: "  \\n" } to distinguish it from a soft break');
}

function testSoftBreakDelta() {
  // No trailing spaces — soft break
  const deltas = filterDeltas(parseMarkdownToOperations('first\nsecond').operations[0]?.deltas);
  assert.deepEqual(deltas, [
    { insert: 'first' },
    { insert: '\n' },
    { insert: 'second' },
  ], 'soft break should produce { insert: "\\n" }');
}

function testMultipleHardBreaks() {
  // Two hard breaks in one paragraph
  const deltas = filterDeltas(parseMarkdownToOperations('a  \nb  \nc').operations[0]?.deltas);
  assert.deepEqual(deltas, [
    { insert: 'a' },
    { insert: '  \n' },
    { insert: 'b' },
    { insert: '  \n' },
    { insert: 'c' },
  ], 'multiple hard breaks should each produce { insert: "  \\n" }');
}

function testHardBreakInsideBold() {
  // Hard break in the middle of a bold span
  const deltas = filterDeltas(parseMarkdownToOperations('**bold  \ncontinued**').operations[0]?.deltas);
  assert.deepEqual(deltas, [
    { insert: 'bold', attributes: { bold: true } },
    { insert: '  \n', attributes: { bold: true } },
    { insert: 'continued', attributes: { bold: true } },
  ], 'hard break inside bold should carry bold attribute and use "  \\n"');
}

function testHardBreakPreservedInText() {
  // The `text` field is what the renderer uses — it must contain "  \n" not "\n"
  const op = parseMarkdownToOperations('first  \nsecond').operations[0];
  assert.ok(
    op.text.includes('  \n'),
    `op.text should contain "  \\n" for round-trip to work, got: ${JSON.stringify(op.text)}`,
  );
}

testHardBreakDelta();
testSoftBreakDelta();
testMultipleHardBreaks();
testHardBreakInsideBold();
testHardBreakPreservedInText();

console.log('Hard break tests passed');
