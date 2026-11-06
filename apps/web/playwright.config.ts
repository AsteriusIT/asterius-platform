import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests against a real server (fresh SQLite in /tmp/asterius-e2e-data) and the Vite dev UI.
 * Run: `npx playwright install chromium` once, then `npm run e2e -w apps/web`.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5173', trace: 'retain-on-failure' },
  webServer: {
    command: 'rm -rf /tmp/asterius-e2e-data && npm run dev',
    cwd: '../..',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { DATA_DIR: '/tmp/asterius-e2e-data', CONFIG_DIR: '/tmp/asterius-e2e-data/config' },
  },
});
