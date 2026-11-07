import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    env: {
      AUTH_PROVIDERS: 'local',
      ENTRA_TENANT_ID: 'tenant-1',
      ENTRA_CLIENT_ID: 'client-1',
      ENTRA_CLIENT_SECRET: 'secret',
      PUBLIC_URL: 'http://platform.test',
      ALLOW_REGISTRATION: 'true',
      ADMIN_EMAILS: 'admin@example.com',
      AUTO_JOIN_DEFAULT_ORG: 'true', // most suites work in the default organization; organizations.test.ts turns it off
      RUN_POLL_SECONDS: '2',
      WORKER_IDLE_MAX_MS: '500',
      LOG_LEVEL: 'silent',
      HTTP_RETRY_BASE_MS: '5',
      HTTP_CIRCUIT_COOLDOWN_SECONDS: '1',
    },
    pool: 'forks',
    testTimeout: 20_000,
    // On Postgres every file boots and migrates its own schema in parallel against one server.
    hookTimeout: process.env.TEST_DATABASE_URL ? 60_000 : 10_000,
  },
});
