import { randomBytes } from 'node:crypto';

export const DEFAULT_AFFINE_TEST_URL = 'http://localhost:3010';
export const REMOTE_ALLOW_ENV = 'AFFINE_ALLOW_REMOTE_DESTRUCTIVE_TESTS';
export const REMOTE_CONFIRM_ENV = 'AFFINE_REMOTE_DESTRUCTIVE_TEST_CONFIRM';
export const TEST_RUN_ID_ENV = 'AFFINE_TEST_RUN_ID';

const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{7,95}$/;

/**
 * Normalize the target so the confirmation value has one unambiguous form.
 */
export function normalizeDestructiveTestTarget(rawTarget = DEFAULT_AFFINE_TEST_URL) {
  let target;
  try {
    target = new URL(rawTarget);
  } catch {
    throw new Error(`AFFINE_BASE_URL must be a valid absolute URL, got: ${rawTarget}`);
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`AFFINE_BASE_URL must use http or https, got: ${target.protocol}`);
  }
  if (target.username || target.password) {
    throw new Error('AFFINE_BASE_URL must not contain embedded credentials.');
  }
  if (target.search || target.hash) {
    throw new Error('AFFINE_BASE_URL must not contain a query string or fragment.');
  }

  target.pathname = target.pathname.replace(/\/+$/, '') || '/';
  return target.pathname === '/' ? target.origin : `${target.origin}${target.pathname}`;
}

/**
 * Only actual loopback hosts are safe by default. URL parsing canonicalizes
 * alternative IPv4 spellings such as 127.1 before this check runs.
 */
export function isLoopbackTarget(normalizedTarget) {
  const { hostname } = new URL(normalizedTarget);
  const canonicalHost = hostname
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '')
    .toLowerCase();

  if (canonicalHost === 'localhost' || canonicalHost === '::1' || canonicalHost === '0:0:0:0:0:0:0:1') {
    return true;
  }

  const octets = canonicalHost.split('.');
  return octets.length === 4
    && octets.every(octet => /^\d+$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255)
    && Number(octets[0]) === 127;
}

export function expectedRemoteConfirmation(normalizedTarget) {
  return `DESTROY ${normalizedTarget}`;
}

/**
 * Fail closed unless the target is loopback or both remote opt-ins match
 * exactly. Call this before any setup, authentication, or mutation.
 */
export function assertDestructiveTestTarget({
  env = process.env,
  target = env.AFFINE_BASE_URL || DEFAULT_AFFINE_TEST_URL,
} = {}) {
  const normalizedTarget = normalizeDestructiveTestTarget(target);
  const loopback = isLoopbackTarget(normalizedTarget);
  if (loopback) {
    return { target: normalizedTarget, loopback };
  }

  const expectedConfirmation = expectedRemoteConfirmation(normalizedTarget);
  const remoteAllowed = env[REMOTE_ALLOW_ENV] === '1';
  const targetConfirmed = env[REMOTE_CONFIRM_ENV] === expectedConfirmation;
  if (!remoteAllowed || !targetConfirmed) {
    throw new Error([
      `Refusing destructive tests against non-loopback target: ${normalizedTarget}`,
      'Remote destructive tests can mutate or delete real AFFiNE data.',
      `Set ${REMOTE_ALLOW_ENV}=1 and`,
      `${REMOTE_CONFIRM_ENV}=${JSON.stringify(expectedConfirmation)}`,
      'only after verifying that this exact target is disposable.',
    ].join('\n'));
  }

  return { target: normalizedTarget, loopback };
}

export function announceRemoteDestructiveTestTarget(target, { runId, write = console.error } = {}) {
  if (target.loopback) return;

  write('');
  write('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  write('REMOTE DESTRUCTIVE TESTS EXPLICITLY ENABLED');
  write(`Target: ${target.target}`);
  if (runId) write(`Run ID: ${runId}`);
  write('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  write('');
}

export function createTestRunId({ now = Date.now(), pid = process.pid, random = randomBytes } = {}) {
  const entropy = random(8).toString('hex');
  return `${now.toString(36)}-${pid.toString(36)}-${entropy}`;
}

export function resolveTestRunId(env = process.env) {
  const existing = env[TEST_RUN_ID_ENV];
  if (existing !== undefined && !RUN_ID_PATTERN.test(existing)) {
    throw new Error(
      `${TEST_RUN_ID_ENV} must be 8-96 characters and contain only letters, digits, dots, underscores, or hyphens.`,
    );
  }

  const runId = existing || createTestRunId();
  env[TEST_RUN_ID_ENV] = runId;
  return runId;
}

export function createResourceNamer(env = process.env) {
  const runId = resolveTestRunId(env);
  let sequence = 0;

  return function testResourceName(prefix, maxLength = 120) {
    const safePrefix = String(prefix)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'affine-test';
    sequence += 1;
    const suffix = `${runId}-${sequence.toString(36)}`;
    const prefixBudget = Math.max(1, maxLength - suffix.length - 1);
    return `${safePrefix.slice(0, prefixBudget)}-${suffix}`;
  };
}
