// Run after npm run build. Never reads credentials or contacts an AFFiNE instance.
import { createResponseFixture, databaseDocId, databaseBlockId } from '../tests/support/response-fixture.mjs';

const fixture = await createResponseFixture();
const database = { docId: databaseDocId, databaseBlockId };
const measurements = [
  ['read_doc', 'full', {}],
  ['read_doc', 'compact', { view: 'compact' }],
  ['read_doc', 'outline', { view: 'outline' }],
  ['read_doc', 'tail 5', { tail: 5, view: 'compact' }],
  ['export_doc_markdown', 'full', {}],
  ['export_doc_markdown', 'tailSections 3', { tailSections: 3 }],
  ['update_block', 'full', { blockId: 'b01', text: 'Synthetic replacement entry with a short acknowledgement.' }],
  ['update_block', 'minimal', { blockId: 'b01', text: 'Synthetic replacement entry with a short acknowledgement.', return: 'minimal' }],
  ['read_database_cells', 'full', database],
  ['read_database_cells', 'compact', { ...database, compact: true }],
  ['read_database_cells', 'filtered', { ...database, compact: true, where: [
    { column: 'Status', op: 'eq', value: 'open' }, { column: 'Due', op: 'lte', value: '2026-11-20' },
  ] }],
];
try {
  const baselines = new Map();
  console.log('| Tool | Mode | UTF-8 JSON bytes | Reduction vs full |');
  console.log('| --- | --- | ---: | ---: |');
  for (const [name, mode, args] of measurements) {
    fixture.reset();
    const result = await fixture.raw(name, args);
    const bytes = Buffer.byteLength(result.content[0].text, 'utf8');
    if (mode === 'full') baselines.set(name, bytes);
    const reduction = mode === 'full' ? '—' : `${(100 * (1 - bytes / baselines.get(name))).toFixed(1)}%`;
    console.log(`| ${name} | ${mode} | ${bytes.toLocaleString('en-US')} | ${reduction} |`);
  }
} finally { await fixture.close(); }
