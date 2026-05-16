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
    // 30s global budget — unit tests finish in <1s; integration tests that
    // spawn `npx tsx cli/index.ts` subprocesses need headroom for on-the-fly
    // transpile + SDK cold-load under full-suite CPU contention. A hung test
    // still fails fast enough for CI; ROI on a tighter default is negligible.
    testTimeout: 30000,
  },
});
