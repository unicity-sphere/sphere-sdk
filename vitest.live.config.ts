import { defineConfig } from 'vitest/config';

/**
 * S5 live e2e (tests/harness/live/ — sdk-changes S5): the phase-2 harness
 * wallets against the REAL testnet2 aggregator gateway, with the wallet-api
 * stack booted under the REAL pinned testnet2 roots (docker-compose.live.yml).
 *
 * LOCAL-ONLY by design (needs Docker, the sibling wallet-api checkout — whose
 * gitignored `.env` carries AGGREGATOR_KEY — and network egress): excluded
 * from `test:run` AND from `test:harness`; run via `npm run test:e2e:live`.
 * ARCHITECTURE §18 triage rule applies: infra failures block/retry, never
 * license code changes or test weakening.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/harness/live/**/*.test.ts'],
    globalSetup: ['tests/harness/live/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 300_000, // real certifications (~5 s/proof) + §18 headroom
    hookTimeout: 600_000, // compose build + real-roots boot
  },
});
