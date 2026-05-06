import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['tests/e2e/dm-manual.test.ts'],
    testTimeout: 300000, // Wallet lifecycle test needs up to 5min (faucet + transfer + IPNS)
    // Two globalSetups run in array order:
    //   1. local-infra/global-setup — when E2E_LOCAL_INFRA=1, boots a
    //      local Nostr relay + faucet via Docker and exports
    //      SPHERE_NOSTR_RELAYS / E2E_LOCAL_FAUCET_PUBKEY env vars.
    //      No-op when the env var is unset.
    //   2. preflight.global-setup — runs @unicitylabs/infra-probe
    //      ONCE against whichever services are now configured (the
    //      probe reads the same env overrides). Each test file
    //      decides individually whether to skip based on the
    //      services it depends on (see tests/e2e/lib/preflight.ts).
    //      Set E2E_SKIP_PREFLIGHT=1 to bypass entirely.
    globalSetup: [
      './tests/e2e/local-infra/global-setup.ts',
      './tests/e2e/preflight.global-setup.ts',
    ],
  },
});
