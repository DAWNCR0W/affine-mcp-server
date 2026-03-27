#!/usr/bin/env node
/**
 * Regression test for bug 01: bold marks bleed into following plain text runs.
 *
 * Replicates the makeText() delta-write logic from src/tools/docs.ts and reads
 * the stored Y.Text delta back via yText.toDelta() to verify attribute isolation.
 *
 * Run: node tests/test-maketext-mark-bleeding.mjs
 */
import assert from 'node:assert/strict';
import * as Y from 'yjs';

/**
 * Replicates the current makeText() implementation from src/tools/docs.ts.
 * If the bug is present, attrs from one run bleed into the next.
 */
function makeText(deltas) {
  // Y.Text must be attached to a Y.Doc before toDelta() can be called
  const doc = new Y.Doc();
  const yText = doc.getText('test');
  let offset = 0;
  for (const delta of deltas) {
    if (delta.insert.length > 0) {
      const attrs = delta.attributes ? { ...delta.attributes } : {};
      yText.insert(offset, delta.insert, attrs);
      offset += delta.insert.length;
    }
  }
  return yText;
}

/**
 * "Hello **bold** and plain"
 * Expected deltas after parse:
 *   { insert: "Hello " }
 *   { insert: "bold", attributes: { bold: true } }
 *   { insert: " and plain" }
 */
const inputDeltas = [
  { insert: 'Hello ' },
  { insert: 'bold', attributes: { bold: true } },
  { insert: ' and plain' },
];

const yText = makeText(inputDeltas);
const stored = yText.toDelta();

// Filter out empty inserts for clarity
const runs = stored.filter(d => d.insert && d.insert.length > 0);

console.log('Stored Y.Text delta runs:');
for (const run of runs) {
  console.log(' ', JSON.stringify(run));
}
console.log();

// The plain run may have been merged into the bold run by Y.js (the bug),
// or exist separately with no attributes (correct behaviour).
const plainRun = runs.find(d => d.insert === ' and plain');
const mergedRun = runs.find(d => d.insert === 'bold and plain');

if (mergedRun) {
  console.log('BUG CONFIRMED: Y.js merged "bold" and " and plain" into one bold run.');
  assert.fail('Mark bleeding: "bold and plain" is a single bold run — " and plain" should be plain text');
} else if (plainRun?.attributes?.bold === true) {
  console.log('BUG CONFIRMED: " and plain" has bold:true — marks are bleeding.');
  assert.fail('Mark bleeding: " and plain" should have no attributes but has bold:true');
} else {
  assert.ok(plainRun, 'Expected a separate plain run for " and plain"');
  assert.equal(plainRun.attributes?.bold, undefined, '" and plain" must not have bold attribute');
  console.log('No bleeding detected — plain run is correctly isolated.');
  console.log('Mark bleeding test passed.');
}
