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
      deltas: [{ insert: 'Callout body' }],
    },
  ], 'admonition-style blockquotes should import as callout operations');
  assert.equal(parsed.lossy, false, 'callout import should not be lossy');
  assert.deepEqual(parsed.warnings, [], 'callout import should not emit warnings');
}

// ---------------------------------------------------------------------------
// Delta preservation tests for heading / paragraph / quote / callout
// ---------------------------------------------------------------------------

function hasDelta(deltas, insert, attrs) {
  return deltas.some(d =>
    d.insert === insert &&
    (attrs === undefined || Object.entries(attrs).every(([k, v]) => d.attributes?.[k] === v))
  );
}

function testHeadingDeltas() {
  const parsed = parseMarkdownToOperations('## A **bold** heading');
  assert.equal(parsed.operations.length, 1);
  const op = parsed.operations[0];
  assert.equal(op.type, 'heading');
  assert.equal(op.level, 2);
  assert.equal(op.text, 'A bold heading');
  assert.ok(op.deltas, 'heading should have deltas');
  assert.ok(hasDelta(op.deltas, 'bold', { bold: true }), 'heading deltas should contain bold run');
  assert.ok(hasDelta(op.deltas, 'A '), 'heading deltas should contain plain prefix');
  assert.ok(hasDelta(op.deltas, ' heading'), 'heading deltas should contain plain suffix');
}

function testParagraphDeltas() {
  const parsed = parseMarkdownToOperations('A **bold** paragraph with *italic* text');
  assert.equal(parsed.operations.length, 1);
  const op = parsed.operations[0];
  assert.equal(op.type, 'paragraph');
  assert.equal(op.text, 'A bold paragraph with italic text');
  assert.ok(op.deltas, 'paragraph should have deltas');
  assert.ok(hasDelta(op.deltas, 'bold', { bold: true }), 'paragraph deltas should contain bold run');
  assert.ok(hasDelta(op.deltas, 'italic', { italic: true }), 'paragraph deltas should contain italic run');
}

function testQuoteDeltas() {
  const parsed = parseMarkdownToOperations('> A **bold** blockquote');
  assert.equal(parsed.operations.length, 1);
  const op = parsed.operations[0];
  assert.equal(op.type, 'quote');
  assert.equal(op.text, 'A bold blockquote');
  assert.ok(op.deltas, 'quote should have deltas');
  assert.ok(hasDelta(op.deltas, 'bold', { bold: true }), 'quote deltas should contain bold run');
}

function testCalloutDeltas() {
  const parsed = parseMarkdownToOperations('> [!NOTE]\n> A **bold** callout');
  assert.equal(parsed.operations.length, 1);
  const op = parsed.operations[0];
  assert.equal(op.type, 'callout');
  assert.equal(op.text, 'A bold callout');
  assert.ok(op.deltas, 'callout should have deltas');
  assert.ok(hasDelta(op.deltas, 'bold', { bold: true }), 'callout deltas should contain bold run');
  // Marker line ([!NOTE]) should be stripped from deltas
  assert.ok(!hasDelta(op.deltas, '[!NOTE]'), 'callout deltas should not contain marker line');
}

testRenderCalloutAsAdmonition();
testParseAdmonitionAsCallout();
testHeadingDeltas();
testParagraphDeltas();
testQuoteDeltas();
testCalloutDeltas();
console.log('Markdown round-trip tests passed');
