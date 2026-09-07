// Build a small overlay on the deployed 3.2.1-trash-v1 distribution. This avoids
// shipping unrelated newer upstream changes during this compatibility rollout.
// Usage: npm run build; node scripts/build-agnt-mindmap-overlay.mjs BASE_DIR OUT_DIR
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [base, out] = process.argv.slice(2);
if (!base || !out || path.resolve(base) === path.resolve(out)) throw new Error('Expected separate BASE_DIR and OUT_DIR');
// Never mix unverified leftovers into Docker's COPY dist/ build context.
const outState = fs.lstatSync(out, { throwIfNoEntry: false });
if (outState && (!outState.isDirectory() || fs.readdirSync(out).length !== 0)) {
  throw new Error('OUT_DIR must be an empty directory or a new path; existing contents are never removed');
}
const expected = {
  'dist/tools/docs.js': '6ade444ec5cecd1af84cb0be71fb1e3fe89e0bc04d6688c893befc69642e64e1',
  'dist/toolSurface.js': 'b0ccb154ac25237c57058f0bff26fd4dec4257cc9489557c5ab6d283b2f1a532',
  'dist/toolOutputSchemas.js': 'c129dc0e246d4030cadac991bec36c9f2d6fd8fdeb8768cb325f37f463c6e507',
  'package.json': 'cc4a2ac0e3ae870f5acf47237821bfde0bf8d4ffa4511b79cfadac8b6f10dcc5',
  'tool-manifest.json': '9641a6ecedb6dbb53c47f05d5798f90958d02fec48d6d38e9fae023875290b73',
};
/** Hashes exact file bytes for base validation and the generated overlay manifest. */
const sha = value => createHash('sha256').update(value).digest('hex');
const files = {};
for (const [name, hash] of Object.entries(expected)) {
  const value = fs.readFileSync(path.join(base, name), 'utf8');
  if (sha(value) !== hash) throw new Error(`Base mismatch: ${name}; inspect the deployed distribution before building`);
  files[name] = value;
}
const names = ['add_mindmap_node', 'create_mindmap', 'get_mindmap', 'reparent_mindmap_node', 'set_mindmap_layout', 'set_mindmap_lock', 'set_mindmap_style', 'update_mindmap_node'];
/** Rejects base code drift instead of applying an ambiguous registration patch. */
const once = (value, needle, replacement) => {
  if (value.split(needle).length !== 2) throw new Error(`Expected exactly one anchor: ${needle}`);
  return value.replace(needle, replacement);
};
files['dist/tools/docs.js'] = 'import { registerMindmapTools } from "./mindmap.js";\n' + once(files['dist/tools/docs.js'],
  'export function registerDocTools(server, gql, defaults) {',
  'export function registerDocTools(server, gql, defaults) {\n    registerMindmapTools(server, gql, defaults, { getSurfaceElementsValueMap, buildSurfaceElementData, writeSurfaceElement, nextSurfaceElementIndex });');
let surface = files['dist/toolSurface.js'];
surface = once(surface, 'export const ALL_TOOLS = [', 'export const ALL_TOOLS = [\n' + names.map(n => `    "${n}",`).join('\n'));
surface = once(surface, 'const TOOL_GROUPS = {', 'const TOOL_GROUPS = {\n' + names.map(n => `    ${n}: ${JSON.stringify(['docs','docs.edgeless','docs.surface', n === 'get_mindmap' ? 'docs.read' : 'docs.write', n === 'get_mindmap' ? 'read' : 'write'])},`).join('\n'));
surface = once(surface, 'const READ_ONLY_TOOLS = new Set([', 'const READ_ONLY_TOOLS = new Set([\n    "get_mindmap",');
files['dist/toolSurface.js'] = surface;
const compiledOutputs = fs.readFileSync(path.join(root, 'dist/toolOutputSchemas.js'), 'utf8');
const outputEntries = names.map(n => compiledOutputs.split('\n').find(line => line.trim().startsWith(n + ':')) ?? (() => { throw new Error(`Missing output schema ${n}`); })());
files['dist/toolOutputSchemas.js'] = once(files['dist/toolOutputSchemas.js'], 'const OUTPUT_SPECS = {', 'const OUTPUT_SPECS = {\n' + outputEntries.join('\n'));
const manifest = JSON.parse(files['tool-manifest.json']);
manifest.tools = [...manifest.tools, ...names].sort();
manifest.version = '3.2.1-agnt-mindmap-v2';
files['tool-manifest.json'] = JSON.stringify(manifest, null, 2) + '\n';
const pkg = JSON.parse(files['package.json']); pkg.version = manifest.version;
files['package.json'] = JSON.stringify(pkg, null, 2) + '\n';
files['dist/tools/mindmap.js'] = fs.readFileSync(path.join(root, 'dist/tools/mindmap.js'), 'utf8');
for (const [name, value] of Object.entries(files)) {
  const target = path.join(out, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value);
}
fs.writeFileSync(path.join(out, 'overlay-manifest.json'), JSON.stringify({
  baseImage: 'sha256:0a5afd2db5f89d1f311d65a9871d816d65cab08e06492cc53a03aad450982ce4',
  baseFiles: expected, outputFiles: Object.fromEntries(Object.entries(files).map(([name,value]) => [name, sha(value)])),
}, null, 2) + '\n');
console.log(JSON.stringify({ overlay: path.resolve(out), files: Object.keys(files), addedTools: names }));
