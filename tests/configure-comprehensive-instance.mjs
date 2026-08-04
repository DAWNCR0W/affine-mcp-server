#!/usr/bin/env node

import { acquireCredentials } from './acquire-credentials.mjs';

const baseUrl = process.env.AFFINE_BASE_URL;
const email = process.env.AFFINE_ADMIN_EMAIL;
const password = process.env.AFFINE_ADMIN_PASSWORD;

if (!baseUrl || !email || !password) {
  throw new Error(
    'AFFINE_BASE_URL, AFFINE_ADMIN_EMAIL, and AFFINE_ADMIN_PASSWORD are required'
  );
}

const { cookie } = await acquireCredentials(baseUrl, email, password);
const response = await fetch(`${baseUrl.replace(/\/$/, '')}/graphql`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Cookie: cookie,
  },
  body: JSON.stringify({
    query: `
      mutation ConfigureComprehensiveInstance {
        updateAppConfig(
          updates: [
            {
              module: "auth"
              key: "newAccountShareActionDelay"
              value: 0
            }
          ]
        )
      }
    `,
  }),
});

const body = await response.json().catch(() => null);
if (!response.ok || body?.errors?.length) {
  const message = body?.errors?.map(error => error.message).join('; ')
    || `${response.status} ${response.statusText}`;
  throw new Error(`Failed to configure the comprehensive test instance: ${message}`);
}

if (body?.data?.updateAppConfig?.auth?.newAccountShareActionDelay !== 0) {
  throw new Error('AFFiNE did not confirm the comprehensive test configuration');
}

console.log('[comprehensive] New-account share delay disabled for the isolated test instance');
