import { defineConfig } from 'vitest/config';

// Load .env (gitignored) so e2e runs can pick up secrets (e.g. TESTNET2_API_KEY)
// without exporting them by hand. No-op when .env is absent (CI relies on shell env).
try {
  process.loadEnvFile();
} catch {
  /* no .env file — rely on the ambient shell environment */
}

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['tests/e2e/dm-manual.test.ts'],
    testTimeout: 300000, // Wallet lifecycle test needs up to 5min (faucet + transfer + IPNS)
  },
});
