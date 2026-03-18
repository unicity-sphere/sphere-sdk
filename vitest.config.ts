import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'tests/relay/**', 'tests/integration/daemon-cli.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json'],
      include: [
        'core/**/*.ts',
        'l1/**/*.ts',
        'modules/**/*.ts',
        'serialization/**/*.ts',
        'validation/**/*.ts',
        'storage/**/*.ts',
        'transport/**/*.ts',
        'oracle/**/*.ts',
      ],
      exclude: ['**/index.ts', '**/*.test.ts'],
    },
    testTimeout: 10000,
  },
});
