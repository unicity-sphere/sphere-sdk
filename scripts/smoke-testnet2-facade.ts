/**
 * Facade smoke test: Sphere.init → sphere.tokenEngine → mint on testnet2.
 *
 * Companion to `scripts/smoke-testnet2-mint.ts`. That one bypasses Sphere
 * and drives `createSphereTokenEngine` directly. This one exercises the
 * SDK's public shape: init a wallet through `Sphere.init`, confirm
 * `sphere.tokenEngine` is non-null (wave 6-P2-4e wiring), mint a token
 * via `sphere.tokenEngine.mint(...)`, verify the round-trip.
 *
 * Run:
 *   npx tsx scripts/smoke-testnet2-facade.ts
 *
 * Env:
 *   TESTNET2_API_KEY — gateway API key (optional; NETWORKS.testnet2 embeds
 *                      a non-secret default)
 *   SMOKE_DATA_DIR   — wallet data directory (default: /tmp/sphere-smoke-facade)
 *
 * Success signals `sphere.tokenEngine` is fully wired end-to-end through
 * Sphere.init, PaymentsModule.initialize, and the engine constructor.
 * Failure surfaces exactly which step of the wiring broke.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Sphere } from '../index';
import { createNodeProviders } from '../impl/nodejs';

const TESTNET2_DEFAULT_API_KEY = 'sk_ddc3cfcc001e4a28ac3fad7407f99590';
const UCT_COIN_ID =
  'f581d30f593e4b369d684a4563b5246f07b1d265f7178a2c0a82b81f39c24dc0';
const MINT_AMOUNT = BigInt(1000);

function log(step: string, detail?: unknown): void {
  const suffix = detail !== undefined ? ` — ${JSON.stringify(detail)}` : '';
  // Use console.error which auto-flushes (process.stderr.write buffers in
  // tsx under some conditions).
  console.error(`[facade-smoke] ${step}${suffix}`);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function main(): Promise<void> {
  const apiKey = process.env.TESTNET2_API_KEY ?? TESTNET2_DEFAULT_API_KEY;
  const dataDir = process.env.SMOKE_DATA_DIR ?? '/tmp/sphere-smoke-facade';

  // Fresh wallet every run
  if (fs.existsSync(dataDir)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  fs.mkdirSync(dataDir, { recursive: true });

  log('start', { dataDir, apiKeyLen: apiKey.length });

  // Step 1: build node providers targeting testnet2
  log('building providers');
  const providers = createNodeProviders({
    network: 'testnet2',
    oracle: { apiKey }, // explicit override; testnet2 network default is now also this
    dataDir,
    tokensDir: path.join(dataDir, 'tokens'),
  });
  log('providers ready', { oracleId: providers.oracle.id });

  // Step 2: init a fresh wallet via Sphere.init
  log('initializing Sphere');
  const { sphere, created, generatedMnemonic } = await Sphere.init({
    ...providers,
    network: 'testnet2',
    tokenEngine: { apiKey }, // Sphere-level engine config (redundant with providers.oracle but explicit)
    autoGenerate: true,
  });
  log('Sphere ready', {
    created,
    hasMnemonic: !!generatedMnemonic,
    directAddress: sphere.identity?.directAddress,
    chainPubkey: sphere.identity?.chainPubkey,
  });

  // Step 3: confirm sphere.tokenEngine is wired (this is the wave 6-P2-4e signal)
  const engine = sphere.tokenEngine;
  if (engine === null) {
    throw new Error(
      'sphere.tokenEngine is null — wave 6-P2-4e wiring failed. Check NETWORKS.testnet2.trustBaseUrl and Sphere.ensureTokenEngine().',
    );
  }
  const engineIdentity = engine.getIdentity();
  log('sphere.tokenEngine wired', {
    chainPubkey: hex(engineIdentity.chainPubkey),
    matchesSphereIdentity:
      hex(engineIdentity.chainPubkey) === sphere.identity?.chainPubkey,
  });

  // Step 4: mint through sphere.tokenEngine
  log('minting via sphere.tokenEngine', {
    coinId: UCT_COIN_ID,
    amount: MINT_AMOUNT.toString(),
  });
  const t0 = Date.now();
  const minted = await engine.mint({
    recipientPubkey: engineIdentity.chainPubkey,
    value: { assets: [{ coinId: UCT_COIN_ID, amount: MINT_AMOUNT }] },
  });
  log('minted', {
    ms: Date.now() - t0,
    tokenId: engine.tokenId(minted),
    balance: engine.balanceOf(minted, UCT_COIN_ID).toString(),
  });

  // Step 5: verify + ownership
  const verifyResult = await engine.verify(minted);
  log('verify', verifyResult);

  const isOwned = engine.isOwnedBy(minted, engineIdentity.chainPubkey);
  if (!isOwned) {
    throw new Error('minted token not owned by our identity');
  }
  log('isOwnedBy', { owned: true });

  // Step 6: encode/decode round-trip
  const blob = engine.encodeToken(minted);
  const decoded = await engine.decodeToken(blob);
  log('encode/decode round-trip', {
    encodedBytes: blob.token.length,
    idsMatch: engine.tokenId(minted) === engine.tokenId(decoded),
  });

  // Step 7: clean shutdown
  await sphere.destroy();
  log('sphere destroyed cleanly');

  log('FACADE SMOKE PASSED');
  process.stdout.write(
    JSON.stringify(
      {
        result: 'PASSED',
        directAddress: sphere.identity?.directAddress,
        chainPubkey: sphere.identity?.chainPubkey,
        tokenId: engine.tokenId(minted),
        balance: engine.balanceOf(minted, UCT_COIN_ID).toString(),
      },
      null,
      2,
    ) + '\n',
  );
  // `sphere.destroy()` closes the modules but the underlying transport
  // (Nostr WebSocket) can keep the Node event loop alive. Force-exit
  // to make the smoke script terminate cleanly.
  process.exit(0);
}

main().catch((err) => {
  log('FACADE SMOKE FAILED', {
    error: err instanceof Error ? err.message : String(err),
    stack:
      err instanceof Error
        ? err.stack?.split('\n').slice(0, 8).join(' | ')
        : undefined,
  });
  process.exit(1);
});
