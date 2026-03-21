#!/usr/bin/env node
/**
 * Regression test for bug 02: nested formatting inside links is lost.
 *
 * When a link contains formatted text (e.g. bold), the current implementation
 * calls deltaToString() on the inner content before applying the link attribute,
 * stripping all inner formatting.
 *
 * Run: node tests/test-link-nested-formatting.mjs
 */
import assert from 'node:assert/strict';
import { parseMarkdownToOperations } from '../dist/markdown/parse.js';

function nonEmpty(deltas) {
  return (deltas ?? []).filter(d => d.insert.length > 0);
}

function testBoldInsideLink() {
  // [**bold** link](https://example.com)
  // Expected: two deltas, both with link attr, first also bold
  const parsed = parseMarkdownToOperations('[**bold** link](https://example.com)');

  // A standalone link becomes a bookmark — wrap it in a sentence to force inline
  const parsed2 = parseMarkdownToOperations('See [**bold** link](https://example.com) here');
  const deltas = nonEmpty(parsed2.operations[0]?.deltas);

  console.log('Deltas for "See [**bold** link](https://example.com) here":');
  for (const d of deltas) console.log(' ', JSON.stringify(d));
  console.log();

  const boldLinkRun = deltas.find(d => d.attributes?.bold === true && d.attributes?.link);
  const plainLinkRun = deltas.find(d => d.insert === ' link' && d.attributes?.link);

  if (!boldLinkRun) {
    assert.fail('BUG: nested bold inside link was lost — no delta with both bold:true and link attribute found');
  }

  assert.equal(boldLinkRun.insert, 'bold', 'bold run inside link should have insert="bold"');
  assert.equal(boldLinkRun.attributes.bold, true, 'bold run should have bold:true');
  assert.equal(boldLinkRun.attributes.link, 'https://example.com', 'bold run should have link attribute');

  assert.ok(plainLinkRun, 'plain " link" run should exist with link attribute');
  assert.equal(plainLinkRun.attributes.link, 'https://example.com', '" link" run should have link attribute');
  assert.equal(plainLinkRun.attributes.bold, undefined, '" link" run should not be bold');

  console.log('Bold inside link test passed.');
}

function testItalicInsideLink() {
  const parsed = parseMarkdownToOperations('See [*italic* link](https://example.com) here');
  const deltas = nonEmpty(parsed.operations[0]?.deltas);

  console.log('Deltas for "See [*italic* link](https://example.com) here":');
  for (const d of deltas) console.log(' ', JSON.stringify(d));
  console.log();

  const italicLinkRun = deltas.find(d => d.attributes?.italic === true && d.attributes?.link);

  if (!italicLinkRun) {
    assert.fail('BUG: nested italic inside link was lost — no delta with both italic:true and link attribute found');
  }

  assert.equal(italicLinkRun.attributes.link, 'https://example.com');
  console.log('Italic inside link test passed.');
}

function testPlainLink() {
  // Plain links (no nested formatting) should still work
  const parsed = parseMarkdownToOperations('See [plain link](https://example.com) here');
  const deltas = nonEmpty(parsed.operations[0]?.deltas);

  const linkRun = deltas.find(d => d.attributes?.link === 'https://example.com');
  assert.ok(linkRun, 'plain link should produce a delta with link attribute');
  assert.equal(linkRun.insert, 'plain link');
  assert.equal(linkRun.attributes.bold, undefined, 'plain link should not be bold');
  console.log('Plain link test passed.');
}

testBoldInsideLink();
testItalicInsideLink();
testPlainLink();
