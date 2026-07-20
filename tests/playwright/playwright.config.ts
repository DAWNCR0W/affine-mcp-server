import { defineConfig } from '@playwright/test';

const browserChannel = process.env.PLAYWRIGHT_BROWSER_CHANNEL;

export default defineConfig({
  testMatch: '**/*.pw.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: {
    timeout: 30_000,
  },
  use: {
    baseURL: process.env.AFFINE_BASE_URL || 'http://localhost:3010',
    trace: 'on-first-retry',
    video: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        ...(browserChannel ? { channel: browserChannel } : {}),
      },
    },
  ],
  outputDir: './test-results/',
  reporter: [
    ['list'],
    ['json', { outputFile: './playwright-report.json' }],
  ],
});
