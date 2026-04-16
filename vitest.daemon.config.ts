import { defineConfig } from 'vitest/config';

/**
 * Separate vitest config for daemon-cli integration tests.
 *
 * These tests spawn real OS processes (npx tsx + wallet init + daemon subprocess)
 * and fail under resource contention when run in the main test pool alongside
 * 100+ other test files. Running them in isolation with a single fork ensures
 * reliable sequential execution without CPU/memory pressure from other workers.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/daemon-cli.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 90000,
  },
});
