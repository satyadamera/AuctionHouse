import { defineConfig } from 'vitest/config';

// Unit tests: pure logic, no MySQL or Redis required.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'mysql://unused:unused@127.0.0.1:1/unused',
      REDIS_URL: 'redis://127.0.0.1:1',
      JWT_ACCESS_SECRET: 'unit-test-secret-unit-test-secret-0123456789',
    },
  },
});
