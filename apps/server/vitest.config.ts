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
      RUN_POLL_SECONDS: '2',
      LOG_LEVEL: 'silent',
    },
    pool: 'forks',
    testTimeout: 20_000,
  },
});
