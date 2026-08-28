import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'tests/relay/**', 'tests/aggregator/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json'],
      include: [
        'core/**/*.ts',
        'connect/**/*.ts',
        'modules/**/*.ts',
        'serialization/**/*.ts',
        'storage/**/*.ts',
        'transport/**/*.ts',
        'oracle/**/*.ts',
        'token-engine/**/*.ts',
      ],
      exclude: ['**/index.ts', '**/*.test.ts'],
    },
    testTimeout: 10000,
  },
});
