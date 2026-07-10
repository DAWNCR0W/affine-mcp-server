import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  announceRemoteDestructiveTestTarget,
  assertDestructiveTestTarget,
  createResourceNamer,
  resolveTestRunId,
} from './live-test-safety.mjs';

export const destructiveTestTarget = assertDestructiveTestTarget();
export const testRunId = resolveTestRunId();
export const testResourceName = createResourceNamer();

const inheritedTempRoot = process.env.AFFINE_TEST_TMP_DIR;
export const testTempRoot = inheritedTempRoot
  ? path.resolve(inheritedTempRoot)
  : mkdtempSync(path.join(tmpdir(), 'affine-mcp-live-test-'));
process.env.AFFINE_TEST_TMP_DIR = testTempRoot;
mkdirSync(testTempRoot, { recursive: true, mode: 0o700 });

if (!inheritedTempRoot) {
  chmodSync(testTempRoot, 0o700);
  process.once('exit', () => {
    rmSync(testTempRoot, { recursive: true, force: true });
  });
}

export function testTempPath(label) {
  const safeLabel = String(label)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'runtime';
  const directory = path.join(testTempRoot, safeLabel);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return directory;
}

announceRemoteDestructiveTestTarget(destructiveTestTarget, { runId: testRunId });
