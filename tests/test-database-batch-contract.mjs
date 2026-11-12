#!/usr/bin/env node
import "./require-destructive-test-safety.mjs";

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { registerDocTools } from '../dist/tools/docs.js';

const tools = new Map();
registerDocTools({ registerTool: (name, definition) => tools.set(name, definition) }, {}, {});
const accepts = (name, value) => z.object(tools.get(name)?.inputSchema ?? { missing: z.never() }).safeParse(value).success;

test('add_database_rows accepts real batches and rejects empty or malformed ones', () => {
  assert.equal(accepts('add_database_rows', { docId: 'd', databaseBlockId: 'b', rows: [{ cells: { Name: 'x' } }, { cells: {}, linkedDocId: 'l' }] }), true);
  for (const value of [
    { docId: 'd', databaseBlockId: 'b', rows: [] },
    { docId: 'd', rows: [{ cells: {} }] },
    { docId: 'd', databaseBlockId: 'b', rows: [{}] },
    { docId: 'd', databaseBlockId: 'b', rows: Array.from({ length: 201 }, () => ({ cells: {} })) },
  ]) {
    assert.equal(accepts('add_database_rows', value), false, JSON.stringify(value).slice(0, 80));
  }
});

test('compose_database_from_intent accepts a custom table schema and keeps the presets valid', () => {
  assert.equal(accepts('compose_database_from_intent', { docId: 'd', intent: 'task_board' }), true);
  assert.equal(accepts('compose_database_from_intent', { docId: 'd', intent: 'table', columns: [{ name: 'Status', type: 'select', options: ['A', 'B'] }, { name: 'Due', type: 'date' }] }), true);
  for (const columns of [[{ name: 'T', type: 'title' }], [{ name: ' ', type: 'date' }]]) {
    assert.equal(accepts('compose_database_from_intent', { docId: 'd', intent: 'table', columns }), false, JSON.stringify(columns));
  }
});
