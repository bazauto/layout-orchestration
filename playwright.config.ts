import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },

  /**
   * Deliberately 0, and stated explicitly rather than left to the default.
   *
   * Retrying would report a test that passes on the second attempt as
   * flaky-but-green. This suite covers the operator UI of a system that moves
   * physical hardware, so a test that only passes sometimes is a finding, not
   * a nuisance to be papered over — CI should go red and the trace below is
   * what explains why.
   *
   * This is also why `trace` is `'on'` rather than `'on-first-retry'`: with no
   * retries, a retry-triggered capture never fires, so that setting captured
   * nothing at all.
   */
  retries: 0,

  // `github` annotates the failing line inline on the PR; `html` is the
  // browsable report that CI uploads as an artifact.
  reporter: process.env.CI ? [['html'], ['github']] : [['list']],

  use: {
    baseURL: 'http://127.0.0.1:4173',
    /**
     * Evidence is captured for passing runs as well as failing ones, so a
     * green build leaves a visual record of what the operator UI actually
     * rendered rather than only proving that nothing threw.
     *
     * If artifact storage becomes a problem, drop these to
     * `'retain-on-failure'` / `'only-on-failure'`. Take `video` first: a
     * trace already carries a DOM snapshot and screenshot for every action,
     * so video on a passing test is the most expensive and least additive of
     * the three.
     */
    trace: 'on',
    screenshot: 'on',
    video: 'on',
    viewport: { width: 1366, height: 768 },
  },
  webServer: {
    command: 'npm run dev --workspace=packages/frontend -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
