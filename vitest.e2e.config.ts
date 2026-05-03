import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['tests/e2e/dm-manual.test.ts'],
    testTimeout: 300000, // Wallet lifecycle test needs up to 5min (faucet + transfer + IPNS)
    // Run @unicitylabs/infra-probe ONCE before any e2e test. Each test
    // file decides individually whether to skip based on the services
    // it actually depends on (see tests/e2e/lib/preflight.ts). Set
    // E2E_SKIP_PREFLIGHT=1 to bypass entirely.
    globalSetup: ['./tests/e2e/preflight.global-setup.ts'],
  },
});
