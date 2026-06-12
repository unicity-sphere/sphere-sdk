import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // tests/harness/** is the local-only phase-2 cross-repo harness (needs
    // Docker + the sibling wallet-api checkout) — own config: vitest.harness.config.ts.
    exclude: ['tests/e2e/**', 'tests/relay/**', 'tests/harness/**', 'tests/integration/daemon-cli.test.ts'],
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
        'token-engine/**/*.ts',
        'wallet-api/**/*.ts',
      ],
      exclude: ['**/index.ts', '**/*.test.ts'],
    },
    testTimeout: 10000,
  },
});
