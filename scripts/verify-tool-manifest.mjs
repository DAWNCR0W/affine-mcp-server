#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TOOLS_DIR = path.join(ROOT, 'src', 'tools');
const MANIFEST_PATH = path.join(ROOT, 'tool-manifest.json');

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(TOOLS_DIR)) fail(`tools directory not found: ${TOOLS_DIR}`);
if (!fs.existsSync(MANIFEST_PATH)) fail(`manifest not found: ${MANIFEST_PATH}`);

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
if (!Array.isArray(manifest.tools)) fail('tool-manifest.json must contain a "tools" array');

const manifestTools = manifest.tools.map(String);
const uniqueManifestTools = new Set(manifestTools);
if (uniqueManifestTools.size !== manifestTools.length) {
  fail('tool-manifest.json contains duplicate tool names');
}

const sortedManifestTools = [...manifestTools].sort();
if (JSON.stringify(manifestTools) !== JSON.stringify(sortedManifestTools)) {
  fail('tool-manifest.json tools must be sorted alphabetically');
}

const files = fs
  .readdirSync(TOOLS_DIR)
  .filter(name => name.endsWith('.ts'))
  .sort();

const registeredTools = [];
const toolPattern = /registerTool\(\s*["']([a-z_]+)["']/g;

for (const name of files) {
  const fullPath = path.join(TOOLS_DIR, name);
  const source = fs.readFileSync(fullPath, 'utf8');
  let match;
  while ((match = toolPattern.exec(source)) !== null) {
    registeredTools.push(match[1]);
  }
}

const duplicateRegistered = registeredTools.filter((name, idx) => registeredTools.indexOf(name) !== idx);
if (duplicateRegistered.length) {
  fail(`duplicate registerTool names found: ${[...new Set(duplicateRegistered)].join(', ')}`);
}

const registeredSet = new Set(registeredTools);
const missingFromManifest = [...registeredSet].filter(name => !uniqueManifestTools.has(name)).sort();
const extraInManifest = manifestTools.filter(name => !registeredSet.has(name)).sort();

if (missingFromManifest.length || extraInManifest.length) {
  fail(
    `tool-manifest mismatch; missingFromManifest=${JSON.stringify(missingFromManifest)} extraInManifest=${JSON.stringify(extraInManifest)}`
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      count: manifestTools.length,
      version: manifest.version || null,
      tools: manifestTools,
    },
    null,
    2
  )
);
