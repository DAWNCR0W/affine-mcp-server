import { defineConfig } from '@playwright/test';

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
      },
    },
  ],
  outputDir: './test-results/',
  reporter: [
    ['list'],
    ['json', { outputFile: './playwright-report.json' }],
  ],
});
