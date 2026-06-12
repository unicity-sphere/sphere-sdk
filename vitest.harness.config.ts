import { defineConfig } from 'vitest/config';

/**
 * Phase-2 cross-repo harness (tests/harness/ — development-workflow.md):
 * two real SDK wallets against the REAL wallet-api backend over real HTTP.
 *
 * Local-only by design (needs Docker + the sibling wallet-api checkout —
 * the global setup boots that repo's docker-compose.dev.yml and tears it
 * down): excluded from the default `test:run` glob, run via
 * `npm run test:harness`. One stack, sequential files; tests isolate by
 * fresh per-test owner identities.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/harness/**/*.test.ts'],
    globalSetup: ['tests/harness/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
