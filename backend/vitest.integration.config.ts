import { defineConfig } from 'vitest/config';

/**
 * Integration + concurrency tests run against REAL MySQL and Redis (TEST_DATABASE_URL /
 * TEST_REDIS_URL from backend/.env). The global setup drops and re-migrates the test database.
 * Files run one at a time because they share that database.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['tests/helpers/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DB_POOL_SIZE: '40',
      RATE_LIMIT_AUTH_MAX: '100000',
      RATE_LIMIT_BID_MAX: '100000',
      ENABLE_DEV_ROUTES: 'true',
      DISABLE_WORKERS: 'true',
      ANTI_SNIPE_WINDOW_SECONDS: '0',
    },
  },
});
