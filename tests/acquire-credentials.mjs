#!/usr/bin/env node
/**
 * Credential acquisition for E2E tests.
 *
 * Exports:
 *   waitForHealthy(baseUrl, maxRetries, intervalMs) — polls GET / until 200
 *   acquireCredentials(baseUrl, email, password)     — signs in, returns {cookie, baseUrl, email}
 *
 * CLI mode: reads AFFINE_BASE_URL, AFFINE_ADMIN_EMAIL, AFFINE_ADMIN_PASSWORD
 * from env and outputs credentials JSON to stdout.
 */

/**
 * Poll the AFFiNE base URL until it returns HTTP 200.
 */
export async function waitForHealthy(baseUrl, maxRetries = 60, intervalMs = 5000) {
  const url = baseUrl.replace(/\/$/, '');
  for (let i = 1; i <= maxRetries; i++) {
    try {
      const res = await fetch(`${url}/`);
      if (res.ok) {
        console.error(`[health] AFFiNE healthy after ${i} attempt(s)`);
        return;
      }
      console.error(`[health] Attempt ${i}/${maxRetries}: status ${res.status}`);
    } catch (err) {
      console.error(`[health] Attempt ${i}/${maxRetries}: ${err.message}`);
    }
    if (i < maxRetries) {
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }
  throw new Error(`AFFiNE not healthy after ${maxRetries} attempts at ${url}`);
}

/**
 * Sign in to AFFiNE and return session cookie.
 * Pattern matches src/auth.ts (getSetCookie / fallback).
 */
export async function acquireCredentials(baseUrl, email, password) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/auth/sign-in`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    const sanitized = raw.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    const truncated = sanitized.length > 200 ? sanitized.slice(0, 200) + '...' : sanitized;
    throw new Error(`Sign-in failed: ${res.status} ${truncated}`);
  }

  // Extract Set-Cookie (same logic as src/auth.ts)
  let setCookies = [];
  if (typeof res.headers.getSetCookie === 'function') {
    setCookies = res.headers.getSetCookie();
  } else {
    const sc = res.headers.get('set-cookie');
    if (sc) setCookies = [sc];
  }

  if (!setCookies.length) {
    throw new Error('Sign-in succeeded but no Set-Cookie received');
  }

  const cookie = setCookies
    .map(sc => sc.split(';')[0].trim())
    .join('; ');

  return { cookie, baseUrl: baseUrl.replace(/\/$/, ''), email };
}

// --- CLI mode ---
const isCLI = process.argv[1] &&
  (process.argv[1].endsWith('acquire-credentials.mjs') ||
   process.argv[1].endsWith('acquire-credentials'));

if (isCLI) {
  const baseUrl = process.env.AFFINE_BASE_URL || 'http://localhost:3010';
  const email = process.env.AFFINE_ADMIN_EMAIL || 'test@affine.local';
  const password = process.env.AFFINE_ADMIN_PASSWORD || 'TestPass1!@#';

  try {
    console.error('[credentials] Waiting for AFFiNE to become healthy...');
    await waitForHealthy(baseUrl);

    console.error('[credentials] Signing in...');
    const creds = await acquireCredentials(baseUrl, email, password);

    // Output JSON to stdout (logs go to stderr)
    console.log(JSON.stringify(creds, null, 2));
  } catch (err) {
    console.error(`[credentials] ERROR: ${err.message}`);
    process.exit(1);
  }
}
