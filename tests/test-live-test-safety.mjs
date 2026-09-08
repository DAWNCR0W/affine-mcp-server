#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  announceRemoteDestructiveTestTarget,
  assertDestructiveTestTarget,
  createResourceNamer,
  createTestRunId,
  expectedRemoteConfirmation,
  isLoopbackTarget,
  normalizeDestructiveTestTarget,
  resolveTestRunId,
} from './live-test-safety.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, '..');

const remoteTarget = 'https://affine.example.test/sandbox';
const confirmation = expectedRemoteConfirmation(remoteTarget);

assert.equal(normalizeDestructiveTestTarget('http://LOCALHOST:3010/'), 'http://localhost:3010');
assert.equal(normalizeDestructiveTestTarget('https://affine.example.test/sandbox/'), remoteTarget);
assert.equal(isLoopbackTarget('http://localhost:3010'), true);
assert.equal(isLoopbackTarget('http://127.1:3010'), true);
assert.equal(isLoopbackTarget('http://[::1]:3010'), true);
assert.equal(isLoopbackTarget('https://localhost.example.test'), false);

assert.deepEqual(
  assertDestructiveTestTarget({ env: {}, target: 'http://127.0.0.9:3010' }),
  { target: 'http://127.0.0.9:3010', loopback: true },
);

assert.throws(
  () => assertDestructiveTestTarget({ env: {}, target: remoteTarget }),
  /Refusing destructive tests against non-loopback target/,
);
assert.throws(
  () => assertDestructiveTestTarget({
    env: { AFFINE_ALLOW_REMOTE_DESTRUCTIVE_TESTS: 'true' },
    target: remoteTarget,
  }),
  /AFFINE_ALLOW_REMOTE_DESTRUCTIVE_TESTS=1/,
);
assert.throws(
  () => assertDestructiveTestTarget({
    env: {
      AFFINE_ALLOW_REMOTE_DESTRUCTIVE_TESTS: '1',
      AFFINE_REMOTE_DESTRUCTIVE_TEST_CONFIRM: 'DESTROY https://another.example.test',
    },
    target: remoteTarget,
  }),
  /AFFINE_REMOTE_DESTRUCTIVE_TEST_CONFIRM/,
);
assert.deepEqual(
  assertDestructiveTestTarget({
    env: {
      AFFINE_ALLOW_REMOTE_DESTRUCTIVE_TESTS: '1',
      AFFINE_REMOTE_DESTRUCTIVE_TEST_CONFIRM: confirmation,
    },
    target: remoteTarget,
  }),
  { target: remoteTarget, loopback: false },
);

const warningLines = [];
announceRemoteDestructiveTestTarget(
  { target: remoteTarget, loopback: false },
  { runId: 'ci-run-12345678', write: line => warningLines.push(line) },
);
assert.match(warningLines.join('\n'), /REMOTE DESTRUCTIVE TESTS EXPLICITLY ENABLED/);
assert.match(warningLines.join('\n'), /Target: https:\/\/affine\.example\.test\/sandbox/);

assert.throws(() => normalizeDestructiveTestTarget('file:///tmp/affine'), /http or https/);
assert.throws(() => normalizeDestructiveTestTarget('https://user:secret@example.test'), /embedded credentials/);
assert.throws(() => normalizeDestructiveTestTarget('https://example.test/?target=prod'), /query string or fragment/);

const deterministicRunId = createTestRunId({
  now: 1_700_000_000_000,
  pid: 42,
  random: size => Buffer.alloc(size, 0xab),
});
assert.equal(deterministicRunId, 'loyw3v28-16-abababababababab');

const env = { AFFINE_TEST_RUN_ID: 'ci-run-12345678' };
assert.equal(resolveTestRunId(env), 'ci-run-12345678');
const resourceName = createResourceNamer(env);
const firstName = resourceName('Workspace Safety');
const secondName = resourceName('Workspace Safety');
assert.match(firstName, /^workspace-safety-ci-run-12345678-1$/);
assert.match(secondName, /^workspace-safety-ci-run-12345678-2$/);
assert.notEqual(firstName, secondName);
assert.throws(
  () => resolveTestRunId({ AFFINE_TEST_RUN_ID: '../../unsafe' }),
  /AFFINE_TEST_RUN_ID must be 8-96 characters/,
);

const mutationPattern = /\b(create_workspace|delete_workspace|create_doc|delete_doc|append_block|update_profile|ensureAdminUser)\b/;
const staticOnlyFiles = new Set(['test-tool-filtering.mjs', 'test-oauth-service-policy.mjs']);
const liveTestFiles = fs.readdirSync(testDirectory)
  .filter(name => name.endsWith('.mjs'))
  .filter(name => !staticOnlyFiles.has(name))
  .map(name => path.join(testDirectory, name));
liveTestFiles.push(
  path.join(repositoryRoot, 'test-comprehensive.mjs'),
  path.join(repositoryRoot, 'scripts', 'test-append-block-expansion.mjs'),
);

for (const filePath of liveTestFiles) {
  const source = fs.readFileSync(filePath, 'utf8');
  const mutationPosition = source.search(mutationPattern);
  if (mutationPosition < 0) continue;
  const guardPosition = source.search(/(?:require-destructive-test-safety|assertDestructiveTestTarget)/);
  const relativePath = path.relative(repositoryRoot, filePath);
  assert.ok(guardPosition >= 0, `${relativePath} must load the destructive-test safety guard`);
  assert.ok(guardPosition < mutationPosition, `${relativePath} must load the guard before mutation code`);
}

for (const runner of ['run-e2e.sh', 'run-comprehensive.sh']) {
  const source = fs.readFileSync(path.join(testDirectory, runner), 'utf8');
  const guardPosition = source.indexOf('assert-destructive-test-target.mjs');
  const credentialPosition = source.indexOf('. "$SCRIPT_DIR/generate-test-env.sh"');
  const composePosition = source.indexOf('compose down');
  assert.ok(guardPosition >= 0, `${runner} must invoke the safety guard`);
  assert.ok(credentialPosition > guardPosition, `${runner} must guard before generating credentials`);
  assert.ok(composePosition > guardPosition, `${runner} must guard before Docker cleanup`);
}

const generatedEnv = spawnSync(
  'bash',
  ['-c', '. tests/generate-test-env.sh >/dev/null; printf "%s" "$AFFINE_TEST_ENV_FILE"'],
  {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      AFFINE_TEST_ENV_FILE: '',
      AFFINE_ADMIN_PASSWORD: 'p"ass\\word\nline$VALUE${OTHER}$$end',
      DB_PASSWORD: 'db"pass\\word$VALUE${OTHER}$$end',
    },
  },
);
assert.equal(generatedEnv.status, 0, generatedEnv.stderr);
const generatedEnvPath = generatedEnv.stdout;
try {
  const mode = fs.statSync(generatedEnvPath).mode & 0o777;
  assert.equal(mode, 0o600, 'generated credential env file must be mode 0600');
  const contents = fs.readFileSync(generatedEnvPath, 'utf8');
  assert.match(contents, /AFFINE_ADMIN_PASSWORD="p\\"ass\\\\word\\nline\$\$VALUE\$\$\{OTHER\}\$\$\$\$end"/);
  assert.match(contents, /DB_PASSWORD="db\\"pass\\\\word\$\$VALUE\$\$\{OTHER\}\$\$\$\$end"/);
} finally {
  fs.rmSync(generatedEnvPath, { force: true });
}

// Exercise the actual shell retry function without Docker or a live AFFiNE target.
const e2eRunner = fs.readFileSync(path.join(testDirectory, 'run-e2e.sh'), 'utf8');
const retryStart = e2eRunner.indexOf('acquire_credentials_with_retry() {');
assert.ok(retryStart >= 0, 'credential retry function must exist');
const retryEnd = e2eRunner.indexOf('\n}', retryStart);
assert.ok(retryEnd > retryStart, 'credential retry function must be complete');
const retryFunction = e2eRunner.slice(retryStart, retryEnd + 2);
for (const recover of [false, true]) {
  const result = spawnSync('bash', ['-c', `
set -euo pipefail
AFFINE_CREDENTIAL_ACQUIRE_RETRIES=2
AFFINE_CREDENTIAL_RETRY_DELAY_SECONDS=0
SCRIPT_DIR=unused
attempt_count=0
node() {
  attempt_count=$((attempt_count + 1))
  if [[ ${recover ? '1' : '0'} == 1 && "$attempt_count" == 2 ]]; then return 0; fi
  return 42
}
docker_diagnostics() { :; }
sleep() { :; }
${retryFunction}
acquire_credentials_with_retry
`], { encoding: 'utf8' });
  assert.equal(result.status, recover ? 0 : 42, result.stderr || result.stdout);
}

console.log('Live destructive-test safety checks passed');
