#!/usr/bin/env node
import assert from 'node:assert/strict';

import { parseMarkdownToOperations } from '../dist/markdown/parse.js';

function filterDeltas(deltas) {
  return (deltas ?? []).filter(d => d.insert.length > 0);
}

function testBlockquoteBold() {
  const parsed = parseMarkdownToOperations('> **bold** quote');
  const op = parsed.operations[0];
  assert.equal(op.type, 'quote', 'should parse as quote');
  const deltas = filterDeltas(op.deltas);
  assert.deepEqual(deltas, [
    { insert: 'bold', attributes: { bold: true } },
    { insert: ' quote' },
  ], 'bold inside blockquote should be preserved as a delta');
}

function testBlockquotePlain() {
  const parsed = parseMarkdownToOperations('> plain quote');
  const op = parsed.operations[0];
  assert.equal(op.type, 'quote', 'should parse as quote');
  const deltas = filterDeltas(op.deltas);
  assert.deepEqual(deltas, [
    { insert: 'plain quote' },
  ], 'plain blockquote should produce a single plain delta');
}

function testCalloutBold() {
  const parsed = parseMarkdownToOperations('> [!NOTE]\n> before **bold** after');
  const op = parsed.operations[0];
  assert.equal(op.type, 'callout', 'should parse as callout');
  const deltas = filterDeltas(op.deltas);
  assert.deepEqual(deltas, [
    { insert: 'before ' },
    { insert: 'bold', attributes: { bold: true } },
    { insert: ' after' },
  ], 'bold inside callout should be preserved as a delta');
}

function testCalloutPlain() {
  const parsed = parseMarkdownToOperations('> [!NOTE]\n> plain note');
  const op = parsed.operations[0];
  assert.equal(op.type, 'callout', 'should parse as callout');
  const deltas = filterDeltas(op.deltas);
  assert.deepEqual(deltas, [
    { insert: 'plain note' },
  ], 'plain callout should produce a single plain delta');
}

testBlockquoteBold();
testBlockquotePlain();
testCalloutBold();
testCalloutPlain();

console.log('Quote and callout formatting tests passed');
