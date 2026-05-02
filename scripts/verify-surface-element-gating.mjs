#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DOCS_PATH = path.join(ROOT, 'src', 'tools', 'docs.ts');

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(DOCS_PATH)) fail(`docs.ts not found: ${DOCS_PATH}`);
const source = fs.readFileSync(DOCS_PATH, 'utf8');

// Fields that bypass FIELD_APPLICABILITY because they have bespoke inline
// handlers in updateSurfaceElementHandler (Y.Text, xywh merge, connector
// source/target, group children, fractional index). A field belongs in
// exactly one of: FIELD_APPLICABILITY, this set.
const KNOWN_NON_GATED_FIELDS = new Set([
  'x', 'y', 'width', 'height',
  'text', 'label', 'title',
  'sourceId', 'targetId', 'sourcePosition', 'targetPosition',
  'mode', 'frontEndpointStyle', 'rearEndpointStyle', 'stroke',
  'children',
  'index',
]);

function extractTopLevelKeys(src, declarationPattern, label) {
  const match = src.match(declarationPattern);
  if (!match) fail(`could not locate ${label} in src/tools/docs.ts`);
  const start = match.index + match[0].length;
  let depth = 1;
  let end = start;
  while (end < src.length && depth > 0) {
    const ch = src[end];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    if (depth === 0) break;
    end += 1;
  }
  if (depth !== 0) fail(`unbalanced braces while parsing ${label}`);
  const body = src.slice(start, end);

  // Walk the body picking out keys at the OUTERMOST nesting level only.
  // A key is `<ident>:` preceded only by indentation on its line, when our
  // current bracket depth (relative to body start) is zero. This skips
  // identifiers nested inside z.enum([...]), z.object({...}), describe(...).
  const keys = [];
  let nest = 0;
  let lineStart = true;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '\n') { lineStart = true; continue; }
    if (ch === ' ' || ch === '\t') continue;
    if (ch === '(' || ch === '[' || ch === '{') { nest += 1; lineStart = false; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { nest -= 1; lineStart = false; continue; }
    if (lineStart && nest === 0 && /[a-zA-Z_]/.test(ch)) {
      const rest = body.slice(i);
      const m = rest.match(/^([a-zA-Z_][\w]*)\s*:/);
      if (m) {
        keys.push(m[1]);
        i += m[0].length - 1;
        lineStart = false;
        continue;
      }
    }
    lineStart = false;
  }
  return keys;
}

const registryKeys = extractTopLevelKeys(
  source,
  /const FIELD_APPLICABILITY[^{]*=\s*\{/,
  'FIELD_APPLICABILITY'
);
const schemaKeys = extractTopLevelKeys(
  source,
  /const surfaceElementFieldSchemas\s*=\s*\{/,
  'surfaceElementFieldSchemas'
);

if (registryKeys.length === 0) fail('FIELD_APPLICABILITY parsed as empty');
if (schemaKeys.length === 0) fail('surfaceElementFieldSchemas parsed as empty');

const registry = new Set(registryKeys);
const schema = new Set(schemaKeys);

const overlap = registryKeys.filter(k => KNOWN_NON_GATED_FIELDS.has(k));
if (overlap.length) {
  fail(
    `field(s) listed in BOTH FIELD_APPLICABILITY and KNOWN_NON_GATED_FIELDS: ${overlap.join(', ')}. ` +
    `A field is either gated by the registry or handled by a bespoke inline branch — pick one.`
  );
}

const unclassified = [...schema].filter(k => !registry.has(k) && !KNOWN_NON_GATED_FIELDS.has(k)).sort();
if (unclassified.length) {
  fail(
    `update_surface_element schema field(s) not classified: ${unclassified.join(', ')}. ` +
    `Add to FIELD_APPLICABILITY in src/tools/docs.ts with the element types they apply to, ` +
    `or add to KNOWN_NON_GATED_FIELDS in scripts/verify-surface-element-gating.mjs if they ` +
    `bypass the gating loop with bespoke inline handling.`
  );
}

const deadRegistry = registryKeys.filter(k => !schema.has(k)).sort();
if (deadRegistry.length) {
  fail(
    `FIELD_APPLICABILITY entries with no matching schema field: ${deadRegistry.join(', ')}. ` +
    `Either remove from the registry or add to surfaceElementFieldSchemas.`
  );
}

const deadAllowlist = [...KNOWN_NON_GATED_FIELDS].filter(k => !schema.has(k)).sort();
if (deadAllowlist.length) {
  fail(
    `KNOWN_NON_GATED_FIELDS entries with no matching schema field: ${deadAllowlist.join(', ')}. ` +
    `Remove from the allowlist in scripts/verify-surface-element-gating.mjs.`
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      gated: registryKeys.length,
      nonGated: KNOWN_NON_GATED_FIELDS.size,
      schemaTotal: schemaKeys.length,
    },
    null,
    2
  )
);
