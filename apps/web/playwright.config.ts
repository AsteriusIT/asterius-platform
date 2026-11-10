import { defineConfig } from '@playwright/test';
import { API_PORT, API_URL, BASE_URL, CONFIG_DIR, DATA_DIR, SEED_FILE } from './e2e/support/env';

/**
 * End-to-end tests against a real server (fresh SQLite database) and the built web app (see e2e/README.md).
 *
 *   npm run e2e -w apps/web           functional tests (e2e/portal.spec.ts)
 *   npm run e2e:visual -w apps/web    screenshots of the main screens (e2e/visual), compared with the baselines
 *   npm run e2e:update -w apps/web    regenerate the baselines after an intended visual change
 *
 * Run `npx playwright install chromium` once. The stack uses its own ports (18080 / 15173, E2E_API_PORT / E2E_WEB_PORT).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  workers: 4,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  globalSetup: './e2e/support/global-setup.ts',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  expect: {
    toHaveScreenshot: {
      // Same machine, same browser build, frozen data: captures are pixel-identical from run to run. The budget only
      // absorbs sub-pixel text anti-aliasing noise: 0.1 % of a 1440×900 capture is ~1300 pixels, less than a 40×40
      // icon or one short line of text, so a moved, missing or recoloured element still fails.
      maxDiffPixelRatio: 0.001,
      // Per-pixel colour distance (YIQ, 0–1) under which two pixels are "the same": tighter than the default 0.2 so a
      // subtle surface change in the dark elevation scale is caught.
      threshold: 0.1,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  projects: [
    // One file, in order, in one worker: the tests share the catalog they write.
    { name: 'functional', testMatch: 'portal.spec.ts', fullyParallel: false },
    {
      name: 'visual',
      testMatch: 'visual/**/*.spec.ts',
      // Read-only (writes are answered by the harness): safe in parallel.
      fullyParallel: true,
      // One folder of baselines per platform (fonts are rasterised differently on macOS and Linux).
      snapshotPathTemplate: '{testDir}/visual/screenshots/{platform}/{arg}{ext}',
      use: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' },
    },
  ],
  webServer: [
    {
      // The API and its workers, without `tsx watch` and without the developer's .env: only what is set here.
      command: `rm -rf "${DATA_DIR}" "${SEED_FILE}" && mkdir -p "${CONFIG_DIR}" && npx tsx src/index.ts`,
      cwd: '../server',
      url: `${API_URL}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        PORT: String(API_PORT),
        DATABASE_URL: '',
        DATA_DIR,
        CONFIG_DIR,
        PUBLIC_URL: BASE_URL,
        LOG_LEVEL: 'warn',
        AUTH_PROVIDERS: 'local',
        ALLOW_REGISTRATION: 'true',
      },
    },
    {
      command: 'npx vite build --config e2e/vite.config.ts && npx vite preview --config e2e/vite.config.ts',
      url: `${BASE_URL}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: { VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' },
    },
  ],
});
