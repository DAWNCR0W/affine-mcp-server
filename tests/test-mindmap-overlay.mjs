import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('../scripts/build-agnt-mindmap-overlay.mjs', import.meta.url));

/** Runs the CLI against disposable paths without requiring a deployed base image. */
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-overlay-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = path.join(dir, 'base'), out = path.join(dir, 'out');
  fs.mkdirSync(base);
  return { base, out, run: () => spawnSync(process.execPath, [script, base, out], { encoding: 'utf8' }) };
}

test('rejects reused overlay output before reading inputs and preserves its files', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.out, 'dist'), { recursive: true });
  const stale = path.join(f.out, 'dist', 'stale.js');
  fs.writeFileSync(stale, 'must not ship or be deleted');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OUT_DIR must be an empty directory/);
  assert.equal(fs.readFileSync(stale, 'utf8'), 'must not ship or be deleted');
  assert.deepEqual(fs.readdirSync(f.out), ['dist']);
  assert.deepEqual(fs.readdirSync(f.base), []);
});

test('rejects file and symlink output paths without changing their targets', t => {
  const f = fixture(t);
  fs.writeFileSync(f.out, 'keep');
  assert.match(f.run().stderr, /OUT_DIR must be an empty directory/);
  assert.equal(fs.readFileSync(f.out, 'utf8'), 'keep');
  fs.unlinkSync(f.out);
  fs.symlinkSync(f.base, f.out, 'dir');
  assert.match(f.run().stderr, /OUT_DIR must be an empty directory/);
  assert.equal(fs.lstatSync(f.out).isSymbolicLink(), true);
  assert.deepEqual(fs.readdirSync(f.base), []);
});

test('accepts absent or empty output but writes nothing when base validation fails', t => {
  const f = fixture(t);
  const absent = f.run();
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /ENOENT/);
  assert.equal(fs.existsSync(f.out), false);
  fs.mkdirSync(f.out);
  const empty = f.run();
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /ENOENT/);
  assert.deepEqual(fs.readdirSync(f.out), []);
});
