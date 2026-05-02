import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    viewport: { width: 1366, height: 768 },
  },
  webServer: {
    command: 'npm run dev --workspace=packages/frontend -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
