import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/aggregator/**/*.test.ts'],
    // Real rounds: a certification waits for the service to seal one.
    testTimeout: 180000,
    hookTimeout: 60000,
  },
});
