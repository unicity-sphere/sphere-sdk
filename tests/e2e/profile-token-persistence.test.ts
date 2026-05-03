/**
 * E2E Test: Profile (OrbitDB) Active Token Persistence
 *
 * Mirrors `ipfs-token-persistence.test.ts` but with the Profile storage
 * stack replacing IPNS-based sync:
 *   - `ProfileStorageProvider` (OrbitDB OpLog + Helia IPFS)
 *   - `ProfileTokenStorageProvider` (CAR pin/fetch via live IPFS)
 *
 * Full Sphere.init() flow against real infrastructure:
 *   - Nostr testnet relay (token delivery)
 *   - Aggregator testnet (oracle)
 *   - Unicity IPFS gateways (CAR pin/fetch)
 *   - libp2p/gossipsub bootstrapped against DEFAULT_IPFS_BOOTSTRAP_PEERS
 *     (OrbitDB OpLog replication)
 *
 * Proves that wallet state (mnemonic, tokens, nametag) survives a full
 * destroy+recreate cycle using ONLY the Profile layer — no IPNS, no
 * legacy file storage, no Nostr replay.
 *
 * Run with: `npm run test:e2e`.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { Sphere } from '../../core/Sphere';
import {
  TEST_COINS,
  FAUCET_TOPUP_TIMEOUT_MS,
  rand,
  makeTempDirs,
  ensureTrustbase,
  createNoopTransport,
  requestMultiCoinFaucet,
  getBalance,
  getTokenIds,
  getTokenAmounts,
  waitForAllCoins,
  type BalanceSnapshot,
} from './helpers';
import { makeProfileProviders } from './profile-helpers';
import { preflightSkip } from './lib/preflight';

// =============================================================================
// Test Suite
// =============================================================================

const SKIP_INFRA = preflightSkip(["nostr","aggregator","ipfs"], 'profile-token-persistence');

describe.skipIf(SKIP_INFRA)('Profile (OrbitDB) Active Token Persistence E2E', () => {
  // Shared state across ordered tests
  let dirsA: ReturnType<typeof makeTempDirs>;
  let sphereA: Sphere;
  let savedMnemonicA: string;
  let savedNametagA: string;
  let originalBalances: Map<string, BalanceSnapshot>;
  let originalTokenIds: Map<string, Set<string>>;
  let originalTokenAmounts: Map<string, Map<string, string>>;

  const cleanupDirs: string[] = [];
  const spheres: Sphere[] = [];

  afterAll(async () => {
    for (const s of spheres) {
      try { await s.destroy(); } catch { /* cleanup */ }
    }
    spheres.length = 0;
    for (const d of cleanupDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
    cleanupDirs.length = 0;
  });

  // ---------------------------------------------------------------------------
  // Test 1: Create wallet, receive all coins via Nostr, verify Profile stores
  // ---------------------------------------------------------------------------

  it('creates wallet with Profile storage, receives multi-coin tokens via Nostr', async () => {
    savedNametagA = `e2e-prof-${rand()}`;
    dirsA = makeTempDirs('profile-persist-a');
    cleanupDirs.push(dirsA.base);
    await ensureTrustbase(dirsA.dataDir);

    const providersA = makeProfileProviders(dirsA);

    console.log(`\n[Test 1] Creating Profile-backed wallet @${savedNametagA}...`);
    const { sphere, created, generatedMnemonic } = await Sphere.init({
      ...providersA,
      autoGenerate: true,
      nametag: savedNametagA,
    });
    sphereA = sphere;
    spheres.push(sphereA);

    expect(created).toBe(true);
    expect(generatedMnemonic).toBeTruthy();
    savedMnemonicA = generatedMnemonic!;
    console.log(`  Wallet A: ${sphereA.identity!.l1Address}`);

    // Faucet: request every test coin
    console.log(`  Requesting faucet for @${savedNametagA}...`);
    await requestMultiCoinFaucet(savedNametagA);

    // Wait for all coins to arrive via Nostr
    console.log(`  Waiting for all ${TEST_COINS.length} coins...`);
    originalBalances = await waitForAllCoins(sphereA, FAUCET_TOPUP_TIMEOUT_MS);

    originalTokenIds = new Map<string, Set<string>>();
    originalTokenAmounts = new Map<string, Map<string, string>>();
    for (const coin of TEST_COINS) {
      const bal = originalBalances.get(coin.symbol)!;
      console.log(`  ${coin.symbol}: total=${bal.total}, tokens=${bal.tokens}`);
      expect(bal.total).toBeGreaterThan(0n);
      originalTokenIds.set(coin.symbol, getTokenIds(sphereA, coin.symbol));
      originalTokenAmounts.set(coin.symbol, getTokenAmounts(sphereA, coin.symbol));
    }

    // Explicit sync flush — forces Profile's write-behind buffer to
    // pin the latest CAR bundle to the live IPFS gateway.
    console.log('  Flushing Profile state to IPFS+OrbitDB...');
    await sphereA.payments.sync();

    console.log('[Test 1] PASSED: multi-coin wallet + Profile state published');
  }, 240_000);

  // ---------------------------------------------------------------------------
  // Test 2: Recover from Profile ONLY (no Nostr) after local wipe
  // ---------------------------------------------------------------------------

  it('recovers multi-coin tokens from Profile (OrbitDB + IPFS) — no Nostr', async () => {
    expect(savedMnemonicA).toBeTruthy();
    for (const coin of TEST_COINS) {
      expect(originalTokenIds.get(coin.symbol)!.size).toBeGreaterThan(0);
    }

    // Destroy + wipe ALL local data (including the OrbitDB directory,
    // the file cache, and the local OpLog head).
    console.log('\n[Test 2] Destroying wallet A and wiping local storage...');
    await sphereA.destroy();
    spheres.splice(spheres.indexOf(sphereA), 1);
    rmSync(dirsA.base, { recursive: true, force: true });

    // Fresh temp dirs — simulates a brand-new device with the same
    // wallet identity (derived from the mnemonic).
    dirsA = makeTempDirs('profile-persist-a-recovered');
    cleanupDirs.push(dirsA.base);
    await ensureTrustbase(dirsA.dataDir);
    const providersA = makeProfileProviders(dirsA);

    // CRITICAL: use no-op transport so tokens can ONLY come from the
    // Profile layer (OrbitDB replication + CAR fetch), not Nostr.
    const noopTransport = createNoopTransport();

    console.log('  Importing wallet A from mnemonic with NO-OP transport (no Nostr)...');
    sphereA = await Sphere.import({
      storage: providersA.storage,
      tokenStorage: providersA.tokenStorage,
      transport: noopTransport,
      oracle: providersA.oracle,
      mnemonic: savedMnemonicA,
    });
    spheres.push(sphereA);
    console.log(`  Wallet A imported: ${sphereA.identity!.l1Address}`);

    // Before sync: local storage is empty → zero tokens for every coin.
    // This proves Nostr did NOT deliver anything (no-op transport).
    for (const coin of TEST_COINS) {
      const preSync = getBalance(sphereA, coin.symbol);
      console.log(`  Pre-sync ${coin.symbol}: total=${preSync.total}`);
      expect(preSync.total).toBe(0n);
      expect(preSync.tokens).toBe(0);
    }

    // Sync from the Profile layer — the ONLY token source now.
    // Retry up to ~90s to allow libp2p peer discovery + OpLog tail
    // sync + CAR fetch to complete.
    console.log('  Syncing from Profile layer (OrbitDB + IPFS)...');
    const syncDeadline = performance.now() + 120_000;
    let lastSyncAdded = 0;
    while (performance.now() < syncDeadline) {
      try {
        const result = await sphereA.payments.sync();
        lastSyncAdded += result.added;
      } catch (err) {
        console.log(`  sync() attempt failed: ${err instanceof Error ? err.message : err}`);
      }
      let allReady = true;
      for (const coin of TEST_COINS) {
        const bal = getBalance(sphereA, coin.symbol);
        if (bal.total < 1n) {
          allReady = false;
          break;
        }
      }
      if (allReady) break;
      await new Promise((r) => setTimeout(r, 5000));
    }

    // syncAdded > 0 proves the Profile layer actually delivered tokens.
    expect(lastSyncAdded).toBeGreaterThan(0);

    // Verify per-coin balance and tokens match original exactly
    for (const coin of TEST_COINS) {
      const recoveredBal = getBalance(sphereA, coin.symbol);
      const origBal = originalBalances.get(coin.symbol)!;
      console.log(
        `  Post-sync ${coin.symbol}: total=${recoveredBal.total}, tokens=${recoveredBal.tokens}`,
      );
      expect(recoveredBal.total).toBe(origBal.total);
      expect(recoveredBal.tokens).toBe(origBal.tokens);

      const recoveredIds = getTokenIds(sphereA, coin.symbol);
      const recoveredAmounts = getTokenAmounts(sphereA, coin.symbol);
      const origIds = originalTokenIds.get(coin.symbol)!;
      const origAmounts = originalTokenAmounts.get(coin.symbol)!;
      for (const id of origIds) {
        expect(recoveredIds.has(id)).toBe(true);
        expect(recoveredAmounts.get(id)).toBe(origAmounts.get(id));
      }
    }

    console.log('[Test 2] PASSED: all tokens recovered from Profile layer (no Nostr)');
  }, 240_000);

  // ---------------------------------------------------------------------------
  // Test 3: Spend recovered tokens — proves they survived as fully usable
  // ---------------------------------------------------------------------------

  it('recovered tokens are spendable to another wallet', async () => {
    const nametagB = `e2e-prof-b-${rand()}`;
    const dirsB = makeTempDirs('profile-persist-b');
    cleanupDirs.push(dirsB.base);
    await ensureTrustbase(dirsB.dataDir);

    // Receiver wallet uses Profile too — we're exercising Profile↔Profile
    // inter-wallet transfer end to end.
    const providersB = makeProfileProviders(dirsB);

    console.log(`\n[Test 3] Creating wallet B @${nametagB}...`);
    const { sphere: sphereB } = await Sphere.init({
      ...providersB,
      autoGenerate: true,
      nametag: nametagB,
    });
    spheres.push(sphereB);
    console.log(`  Wallet B: ${sphereB.identity!.l1Address}`);

    // Re-import wallet A with REAL transport so it can actually send
    // messages over Nostr (Test 2 used a noop transport).
    console.log('  Re-importing A with real transport...');
    await sphereA.destroy();
    spheres.splice(spheres.indexOf(sphereA), 1);

    dirsA = makeTempDirs('profile-persist-a-send');
    cleanupDirs.push(dirsA.base);
    await ensureTrustbase(dirsA.dataDir);
    const providersA = makeProfileProviders(dirsA);
    sphereA = await Sphere.import({
      ...providersA,
      mnemonic: savedMnemonicA,
      nametag: savedNametagA,
    });
    spheres.push(sphereA);

    // Resync to pull recovered tokens
    console.log('  Syncing recovered tokens into fresh sphere A...');
    const syncDeadline = performance.now() + 90_000;
    while (performance.now() < syncDeadline) {
      await sphereA.payments.sync();
      let allOk = true;
      for (const coin of TEST_COINS) {
        if (getBalance(sphereA, coin.symbol).total < 1n) {
          allOk = false;
          break;
        }
      }
      if (allOk) break;
      await new Promise((r) => setTimeout(r, 5000));
    }

    // Finalize any unconfirmed tokens so they can actually be spent
    await sphereA.payments.receive({ finalize: true, timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 3000));
    await sphereA.payments.load();

    // Send one token per coin to wallet B
    for (const coin of TEST_COINS) {
      const senderBefore = getBalance(sphereA, coin.symbol);
      if (senderBefore.total === 0n) {
        console.log(`  Skipping ${coin.symbol} — balance is 0 after recovery`);
        continue;
      }
      const tokens = sphereA.payments.getTokens().filter((t) => t.symbol === coin.symbol);
      if (tokens.length === 0) continue;

      const first = tokens[0];
      console.log(`  Sending ${first.amount} ${coin.symbol} to @${nametagB}...`);
      const sendResult = await sphereA.payments.send({
        recipient: `@${nametagB}`,
        amount: first.amount,
        coinId: first.coinId,
      });
      console.log(`  ${coin.symbol} send status: ${sendResult.status}`);
      expect(sendResult.status).toBe('completed');

      await sphereA.payments.load();
      const senderAfter = getBalance(sphereA, coin.symbol);
      expect(senderAfter.total).toBeLessThan(senderBefore.total);
    }

    console.log('[Test 3] PASSED: Profile-recovered tokens are spendable');
  }, 180_000);
});
