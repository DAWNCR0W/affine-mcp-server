import './require-destructive-test-safety.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z as outputZ } from 'zod/v4';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { selectMarkdown, TRUNCATION_MARKER, writeResponse } from '../dist/util/responseViews.js';
import { toolOutputSchemaFor } from '../dist/toolOutputSchemas.js';
import { text, toolError } from '../dist/util/mcp.js';
import { createResponseFixture, legacyCases, normalizeLegacyResponse, databaseDocId, databaseBlockId } from './support/response-fixture.mjs';

const fixture = await createResponseFixture();
const db = { docId: databaseDocId, databaseBlockId };
const defaultSnapshots = JSON.parse(readFileSync(new URL('./fixtures/response-defaults.json', import.meta.url), 'utf8'));
try {
  // Golden bytes were captured from unmodified upstream c597a4a. Only generated
  // IDs and revisions are normalized. The approved totalBlockCount addition is
  // the sole intentional legacy wire change.
  for (const snapshot of defaultSnapshots.snapshots) {
    fixture.reset();
    const result = await fixture.raw(snapshot.name, snapshot.args);
    if (snapshot.name === 'read_doc') {
      assert.equal(result.structuredContent.totalBlockCount, 62);
      delete result.structuredContent.totalBlockCount;
      result.content[0].text = JSON.stringify(result.structuredContent);
    }
    assert.equal(normalizeLegacyResponse(result), snapshot.text, `${snapshot.name} legacy response bytes`);
  }
  console.log('PASS: upstream default response snapshots (approved totalBlockCount addition only)');

  fixture.reset();
  const full = await fixture.call('read_doc');
  assert.deepEqual(await fixture.call('read_doc', { view: 'full', includePlainText: true }), full);
  const compact = await fixture.call('read_doc', { view: 'compact' });
  assert.equal(compact.revision, full.revision);
  assert.equal(compact.totalBlockCount, 62);
  assert(!Object.hasOwn(compact, 'plainText'));
  assert.deepEqual(compact.blocks.find(b => b.id === 'b02'), {
    id: 'b02', flavour: 'affine:paragraph', type: 'text', parentId: 'note', text: full.blocks.find(b => b.id === 'b02').text,
  });
  assert.deepEqual(compact.blocks.find(b => b.id === 'b01').deltas, full.blocks.find(b => b.id === 'b01').deltas);
  assert.equal((await fixture.call('read_doc', { view: 'compact', includePlainText: true })).plainText, full.plainText);
  assert(!Object.hasOwn(await fixture.call('read_doc', { includePlainText: false }), 'plainText'));
  const outline = await fixture.call('read_doc', { view: 'outline' });
  assert.equal(outline.blocks.find(b => b.id === 'b02').text.length, 80);
  assert.equal(outline.blocks.find(b => b.id === 'b00').text, full.blocks.find(b => b.id === 'b00').text);
  assert(outline.blocks.every(b => !Object.hasOwn(b, 'deltas')));
  const rich = full.blocks.find(b => b.id === 'b01');
  await fixture.call('update_block', { blockId: rich.id, text: [...rich.deltas, { insert: ' synthetic edit' }], expectedRevision: compact.revision, return: 'minimal' });
  const edited = (await fixture.call('read_doc')).blocks.find(b => b.id === rich.id);
  assert.deepEqual(edited.deltas, [...rich.deltas, { insert: ' synthetic edit' }]);
  assert(edited.linkedDocIds.includes('synthetic-reference'));
  const pageBlocks = fixture.docs.get('synthetic-log').getMap('blocks');
  pageBlocks.get('b02').set('prop:checked', true);
  pageBlocks.get('b02').get('prop:text').format(0, 10, { bold: true });
  const formatted = (await fixture.call('read_doc', { view: 'compact' })).blocks.find(b => b.id === 'b02');
  assert.equal(formatted.checked, true);
  assert(formatted.deltas.some(d => d.attributes?.bold));
  pageBlocks.get('b00').get('prop:text').insert(0, 'Long heading '.repeat(20));
  assert((await fixture.call('read_doc', { view: 'outline' })).blocks.find(b => b.id === 'b00').text.length > 80);
  console.log('PASS: compact/outline shapes and reference-preserving full-delta edit after compact read');

  fixture.reset();
  const tail = await fixture.call('read_doc', { tail: 5, view: 'compact' });
  assert.deepEqual(tail.blocks.map(b => b.id), ['b55', 'b56', 'b57', 'b58', 'b59']);
  assert.equal(tail.totalBlockCount, 62);
  assert.equal(tail.blockCount, 5);
  const section = await fixture.call('read_doc', { section: 'b06' });
  assert.deepEqual(section.blocks.map(b => b.id), ['b06', 'b07', 'b08', 'b09', 'b10', 'b11']);
  assert.deepEqual((await fixture.call('read_doc', { afterBlockId: 'b06', limit: 2 })).blocks.map(b => b.id), ['b07', 'b08']);
  assert.deepEqual((await fixture.call('read_doc', { limit: 2 })).blocks.map(b => b.id), ['b00', 'b01']);
  const selected = await fixture.call('read_doc', { blockIds: ['b03', 'b01', 'missing'], view: 'compact' });
  assert.deepEqual(selected.blocks.map(b => b.id), ['b01', 'b03']);
  assert.deepEqual(selected.missingBlockIds, ['missing']);
  const absent = await fixture.call('read_doc', { docId: 'absent', view: 'compact' });
  assert.equal(absent.revision, null); assert.equal(absent.totalBlockCount, 0); assert(!('plainText' in absent));
  for (const args of [{ tail: 1, blockIds: ['b01'] }, { section: 'b00', limit: 3 }, { afterBlockId: 'missing' }, { section: 'b01' }, { tail: 1, includeMarkdown: true }]) {
    await assert.rejects(fixture.call('read_doc', args));
  }
  // A top-level block's descendants travel with tail; section ends on a higher heading.
  const blocks = fixture.docs.get('synthetic-log').getMap('blocks');
  blocks.get('b58').get('sys:children').push(['b59']);
  blocks.get('note').get('sys:children').delete(59, 1);
  assert.deepEqual((await fixture.call('read_doc', { tail: 1 })).blocks.map(b => b.id), ['b58', 'b59']);
  blocks.get('b09').set('prop:type', 'h2');
  assert.deepEqual((await fixture.call('read_doc', { section: 'b06' })).blocks.map(b => b.id), ['b06', 'b07', 'b08']);
  console.log('PASS: block IDs, sections, tail with descendants, pagination, missing IDs and selector validation');

  fixture.reset();
  const md = await fixture.call('export_doc_markdown');
  const mdTail = await fixture.call('export_doc_markdown', { tailSections: 3 });
  assert.equal((mdTail.markdown.match(/^### 2026-/gm) ?? []).length, 3);
  assert(mdTail.markdown.startsWith('### 2026-11-08'));
  assert(mdTail.markdown.endsWith(md.markdown.slice(-50)));
  assert.equal((await fixture.call('export_doc_markdown', { fromHeading: '2026-11-08 — Synthetic sender' })).markdown, mdTail.markdown);
  const truncated = await fixture.call('export_doc_markdown', { maxChars: 80 });
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.markdown, md.markdown.slice(0, 80 - TRUNCATION_MARKER.length) + TRUNCATION_MARKER);
  assert.equal((await fixture.call('export_doc_markdown', { maxChars: 100000 })).truncated, false);
  assert((await fixture.call('export_doc_markdown', { includeFrontmatter: true, tailSections: 3, maxChars: 80 })).markdown.startsWith('---'));
  await assert.rejects(fixture.call('export_doc_markdown', { fromHeading: 'absent' }), /not found/);
  await assert.rejects(fixture.call('export_doc_markdown', { tailSections: 1, fromHeading: 'x' }), /only one/);
  assert.equal(selectMarkdown('### first\n\n```md\n# fake\n```\n\n### last\nend', { tailSections: 1 }).markdown, '### last\nend');
  assert.equal(selectMarkdown('First\n=====\nintro\n\nLast\n====\nend', { tailSections: 1 }).markdown, 'Last\n====\nend');
  assert.equal(selectMarkdown('no headings', { tailSections: 3 }).markdown, 'no headings');
  assert.equal(selectMarkdown('😀😀', { maxChars: 1 }).markdown, '…');
  assert.equal(Array.from(selectMarkdown('😀'.repeat(100), { maxChars: 30 }).markdown).length, 30);
  console.log('PASS: last 3 of 10 dated sections, heading lookup, fenced/Setext headings and explicit truncation');

  for (const [name, args] of legacyCases.filter(([name]) => !['read_doc', 'export_doc_markdown', 'read_database_cells'].includes(name))) {
    fixture.reset();
    const fullResult = await fixture.raw(name, args);
    fixture.reset();
    const explicitFull = await fixture.raw(name, { ...args, return: 'full' });
    assert.equal(normalizeLegacyResponse(explicitFull), normalizeLegacyResponse(fullResult));
    fixture.reset();
    const minimal = await fixture.call(name, { ...args, return: 'minimal' });
    const idField = name === 'delete_block' ? 'deletedIds' : name === 'append_markdown' ? 'blockIds' : 'blockId';
    assert.deepEqual(Object.keys(minimal).sort(), ['ok', idField, 'revision'].sort());
    assert.equal(minimal.ok, true); assert.match(minimal.revision, /^[a-f0-9]{64}$/);
    fixture.reset();
    const after = await fixture.call(name, { ...args, return: 'after' });
    for (const field of ['previous', 'deletedBlock', 'deletedBlocks', 'fromParentId', 'fromIndex']) assert(!(field in after));
    const schema = toolOutputSchemaFor(name);
    const validate = new AjvJsonSchemaValidator().getValidator(outputZ.toJSONSchema(schema));
    assert(validate(minimal).valid, `${name} advertised minimal schema`);
    assert(validate(after).valid, `${name} advertised after schema`);
    const missingRevision = { ...minimal }; delete missingRevision.revision;
    assert(!schema.safeParse(missingRevision).success); assert(!validate(missingRevision).valid);
    assert(!schema.safeParse({ ...minimal, unexpected: 'synthetic' }).success);
    assert(!validate({ ...minimal, unexpected: 'synthetic' }).valid);
  }
  fixture.reset();
  const revision = (await fixture.call('read_doc')).revision;
  await fixture.call('update_block', { blockId: 'b01', text: 'new text', return: 'minimal' });
  const writes = fixture.pushes;
  const stale = await fixture.raw('update_block', { blockId: 'b02', text: 'stale edit', expectedRevision: revision, return: 'minimal' });
  assert.equal(stale.isError, true); assert.equal(stale.structuredContent.code, 'STALE_DOCUMENT_REVISION'); assert.equal(fixture.pushes, writes);
  const error = toolError('synthetic failure', { code: 'synthetic' });
  assert.equal(writeResponse('update_block', 'minimal', error), error);
  const partial = text({ ok: true, status: 'partial', warning: 'inspect saved content' });
  assert.equal(writeResponse('append_block', 'minimal', partial), partial);
  fixture.reset(); fixture.accepted = false;
  await assert.rejects(fixture.call('append_block', { type: 'paragraph', text: 'uncertain', return: 'minimal' }), { code: 'write_ack_uncertain' });
  console.log('PASS: all 6 write tools, all modes, runtime/advertised schemas, stale edits and uncertain acknowledgements');

  fixture.reset();
  assert.deepEqual(await fixture.call('read_database_cells', { ...db, compact: false, where: [], sort: [] }),
    await fixture.call('read_database_cells', db));
  const compactDb = await fixture.call('read_database_cells', { ...db, compact: true });
  assert.equal(compactDb.rows.length, 40);
  assert.deepEqual(Object.keys(compactDb.rows[1]), ['rowBlockId', 'title', 'cells']);
  assert.equal(compactDb.rows[1].cells.Status, 'closed');
  assert.equal(compactDb.rows[1].cells.Due, '2026-11-02T12:00:00.000Z');
  assert.equal(compactDb.rows[1].cells.Estimate, 1);
  assert.deepEqual(compactDb.rows[1].cells.Tags, ['closed']);
  assert.equal(typeof compactDb.rows[1].cells.Notes, 'string');
  assert(compactDb.rows[0].cells.Notes.deltas.some(d => d.attributes?.reference));
  assert(compactDb.rows[0].titleDeltas.some(d => d.attributes?.reference));
  const where = [{ column: 'Status', op: 'eq', value: 'open' }, { column: 'Due', op: 'lte', value: '2026-11-20' }];
  const filtered = await fixture.call('read_database_cells', { ...db, compact: true, where });
  assert.equal(filtered.rows.length, 10);
  assert(filtered.rows.every(row => row.cells.Status === 'open' && row.cells.Due.slice(0, 10) <= '2026-11-20'));
  const filteredFull = await fixture.call('read_database_cells', { ...db, where, columns: ['Notes'], sort: [{ column: 'due', dir: 'desc' }], limit: 3 });
  assert.deepEqual(filteredFull.rows.map(row => row.rowBlockId), ['row18', 'row16', 'row14']);
  assert(filteredFull.rows.every(row => Object.keys(row.cells).join() === 'Notes'));
  const query = async (column, op, value) => (await fixture.call('read_database_cells', { ...db, compact: true, where: [{ column, op, ...(value !== undefined ? { value } : {}) }] })).rows;
  assert.equal((await query('Notes', 'contains', 'urgent')).length, 14);
  assert.equal((await query('Status', 'ne', 'open')).length, 20);
  assert.equal((await query('Status', 'in', ['open', 'closed'])).length, 40);
  assert.equal((await query('Tags', 'contains', 'open')).length, 20);
  assert.equal((await query('Estimate', 'lt', 3)).length, 3);
  assert.equal((await query('Estimate', 'gte', 38)).length, 2);
  assert.equal((await query('Estimate', 'gt', 38)).length, 1);
  assert.equal((await query('Due', 'eq', '2026-11-01')).length, 1);
  assert.equal((await query('Due', 'eq', '2026-11-01T13:00:00+01:00')).length, 1);
  assert.equal((await query('Title', 'contains', 'task 39')).length, 1);
  const cells = fixture.docs.get(databaseDocId).getMap('blocks').get(databaseBlockId).get('prop:cells');
  cells.get('row00').delete('due');
  for (const dir of ['asc', 'desc']) {
    assert.equal((await fixture.call('read_database_cells', { ...db, sort: [{ column: 'Due', dir }] })).rows.at(-1).rowBlockId, 'row00');
  }
  assert.deepEqual((await fixture.call('read_database_cells', { ...db, sort: [{ column: 'Status', dir: 'asc' }], limit: 3 })).rows.map(row => row.rowBlockId), ['row01', 'row03', 'row05']);
  assert.deepEqual((await fixture.call('read_database_cells', { ...db, sort: [{ column: 'Status', dir: 'asc' }, { column: 'Estimate', dir: 'desc' }], limit: 3 })).rows.map(row => row.rowBlockId), ['row39', 'row37', 'row35']);
  cells.get('row01').get('notes').get('value').format(0, 5, { bold: true });
  assert.equal(typeof (await fixture.call('read_database_cells', { ...db, compact: true })).rows[1].cells.Notes, 'string');
  assert.equal((await query('Due', 'empty')).length, 1);
  assert.equal((await query('Due', 'eq', null)).length, 1);
  assert.equal((await query('Due', 'in', [])).length, 0);
  for (const bad of [
    { where: [{ column: 'missing', op: 'eq', value: 'open' }] },
    { where: [{ column: 'Due', op: 'lte', value: '2026-02-30' }] },
    { where: [{ column: 'Due', op: 'eq', value: '2026-11-20T12:00' }] },
    { sort: [{ column: 'missing', dir: 'asc' }] },
    { where: [{ column: 'Due', op: 'in', value: '2026-11-20' }] },
    { where: [{ column: 'Due', op: 'empty', value: false }] },
    { where: [{ column: 'Status', op: 'eq' }] }, { limit: 0 },
  ]) await assert.rejects(fixture.call('read_database_cells', { ...db, ...bad }));
  const caps = await fixture.call('get_capabilities');
  assert.equal(caps.responses.minimal, true); assert(caps.readDoc.views.includes('compact')); assert(caps.database.filter); assert(caps.database.compactRead); assert(caps.export.tailSections);
  console.log('PASS: database compact values, references, select/date/text filters, every operator, projection, sorting, limits and capability discovery');
} finally { await fixture.close(); }
