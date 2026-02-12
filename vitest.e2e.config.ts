import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['tests/e2e/dm-manual.test.ts'],
    testTimeout: 300000, // Wallet lifecycle test needs up to 5min (faucet + transfer + IPNS)
  },
});
