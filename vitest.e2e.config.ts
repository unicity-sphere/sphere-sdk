import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['tests/e2e/dm-manual.test.ts'],
    testTimeout: 300000, // Wallet lifecycle test needs up to 5min (faucet + transfer + IPNS)
    // Network-bound e2e tests (faucet drops, Nostr DM round-trips, IPFS
    // pin/resolve) hit the same testnet endpoints. Running 5+ files in
    // parallel multiplies relay/aggregator/IPFS contention without any
    // CPU benefit (these tests are I/O-bound, not compute-bound). The
    // observed symptom: profile-multi-device-sync ran in 65s isolated
    // against real testnet but timed out at 240s under the default
    // parallel pool because 7 concurrent multi-coin faucet drops on
    // each of N test files starve each other for relay capacity.
    //
    // `fileParallelism: false` runs ONE test file at a time. Tests
    // within a file still run sequentially (vitest default for
    // `it`/`test`), so total order is fully serialized — no shared
    // testnet load. Tradeoff: total wall time increases by
    // ~(num-files - 1) × per-file-time, but each file gets
    // deterministic resource access. For network-bound suites this
    // is the correct trade.
    fileParallelism: false,
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
