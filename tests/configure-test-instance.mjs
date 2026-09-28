#!/usr/bin/env node

import './require-destructive-test-safety.mjs';
import { acquireCredentials } from './acquire-credentials.mjs';

const baseUrl = process.env.AFFINE_BASE_URL;
const email = process.env.AFFINE_ADMIN_EMAIL;
const password = process.env.AFFINE_ADMIN_PASSWORD;

if (!baseUrl || !email || !password) {
  throw new Error(
    'AFFINE_BASE_URL, AFFINE_ADMIN_EMAIL, and AFFINE_ADMIN_PASSWORD are required'
  );
}

const { cookie } = await acquireCredentials(baseUrl, email, password, {
  signal: AbortSignal.timeout(30_000),
});
const response = await fetch(`${baseUrl.replace(/\/$/, '')}/graphql`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Cookie: cookie,
  },
  body: JSON.stringify({
    query: `
      mutation ConfigureTestInstance {
        updateAppConfig(
          updates: [
            {
              module: "auth"
              key: "newAccountShareActionDelay"
              value: 0
            }
            {
              module: "throttle"
              key: "enabled"
              value: false
            }
          ]
        )
      }
    `,
  }),
  signal: AbortSignal.timeout(30_000),
});

const body = await response.json().catch(() => null);
if (!response.ok || body?.errors?.length) {
  const message = body?.errors?.map(error => error.message).join('; ')
    || `${response.status} ${response.statusText}`;
  throw new Error(`Failed to configure the isolated test instance: ${message}`);
}

const updated = body?.data?.updateAppConfig;
if (updated?.auth?.newAccountShareActionDelay !== 0 || updated?.throttle?.enabled !== false) {
  throw new Error('AFFiNE did not confirm the isolated test configuration');
}

console.log('[test-instance] Share delay and rate limiting disabled for the isolated test instance');
