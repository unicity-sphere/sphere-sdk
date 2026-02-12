import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/relay/**/*.test.ts'],
    testTimeout: 120000,
    hookTimeout: 60000,
  },
});
