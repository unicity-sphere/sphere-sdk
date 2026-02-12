/**
 * E2E Test: IPFS Multi-Device Sync
 *
 * Proves that token inventory can be preserved and recovered across devices
 * using IPFS/IPNS as the sync mechanism — NOT via Nostr relay replay.
 *
 * CRITICAL: To prove IPFS works independently of Nostr, recovery tests
 * use a no-op transport that does NOT connect to any relay. This ensures
 * tokens can ONLY arrive via IPFS sync, eliminating false positives where
 * Nostr re-delivers tokens to the same identity.
 *
 * Multi-coin: tests use ALL faucet-supported coins (SOL, ETH, BTC, UCT,
 * USDT, USDC, USDU) simultaneously to verify that wallets with multiple
 * coin types (decimals: 6/8/9/18) survive IPFS round-trips.
 *
 * Test flow (user's requested scenario):
 *   1. Create wallet, receive all coin tokens via Nostr, sync to IPFS
 *   2. ERASE ALL LOCAL DATA, recreate from mnemonic WITHOUT Nostr,
 *      verify tokens recovered exclusively from IPFS
 *   3. Full recovery: erase + recreate with Nostr, verify IPFS + Nostr merge
 *
 * Run with: npm run test:e2e
 */

import { describe, it, expect, afterAll } from 'vitest';
import { Sphere } from '../../core/Sphere';
import { rmSync } from 'node:fs';
import {
  TEST_COINS,
  FAUCET_TOPUP_TIMEOUT_MS,
  IPNS_PROPAGATION_WAIT_MS,
  IPNS_RESOLVE_TIMEOUT_MS,
  rand,
  makeTempDirs,
  ensureTrustbase,
  makeProviders,
  createNoopTransport,
  requestMultiCoinFaucet,
  getBalance,
  getTokenIds,
  getTokenAmounts,
  waitForAllCoins,
  syncUntilAllCoins,
  type BalanceSnapshot,
} from './helpers';

// =============================================================================
// Test Suite
// =============================================================================

describe('IPFS Multi-Device Sync E2E', () => {
  // Shared state across ordered tests
  let savedMnemonic: string;
  let savedNametag: string;
  let originalBalances: Map<string, BalanceSnapshot>;
  let originalTokenIds: Map<string, Set<string>>;
  let originalTokenAmounts: Map<string, Map<string, string>>;

  const cleanupDirs: string[] = [];
  const spheres: Sphere[] = [];

  afterAll(async () => {
    for (const s of spheres) {
      try {
        await s.destroy();
      } catch {
        /* cleanup */
      }
    }
    spheres.length = 0;
    for (const d of cleanupDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* cleanup */
      }
    }
    cleanupDirs.length = 0;
  });

  // ---------------------------------------------------------------------------
  // Test 1: Create wallet, top up with all coins, sync to IPFS
  // ---------------------------------------------------------------------------

  it(
    'creates wallet, receives multi-coin tokens, and syncs to IPFS',
    async () => {
      savedNametag = `e2e-msync-${rand()}`;
      const dirsA = makeTempDirs('multidev-a');
      cleanupDirs.push(dirsA.base);
      await ensureTrustbase(dirsA.dataDir);

      const providersA = makeProviders(dirsA);

      console.log(
        `\n[Test 1] Creating wallet with nametag @${savedNametag}...`,
      );
      const { sphere, created, generatedMnemonic } = await Sphere.init({
        ...providersA,
        autoGenerate: true,
        nametag: savedNametag,
      });
      spheres.push(sphere);

      expect(created).toBe(true);
      expect(generatedMnemonic).toBeTruthy();
      savedMnemonic = generatedMnemonic!;

      // Request faucet for all coins
      console.log(`  Requesting multi-coin faucet for @${savedNametag}...`);
      await requestMultiCoinFaucet(savedNametag);

      // Wait for ALL coins to arrive via Nostr
      console.log(`  Waiting for all ${TEST_COINS.length} coins...`);
      originalBalances = await waitForAllCoins(
        sphere,
        FAUCET_TOPUP_TIMEOUT_MS,
      );

      for (const coin of TEST_COINS) {
        const bal = originalBalances.get(coin.symbol)!;
        console.log(
          `  ${coin.symbol}: total=${bal.total}, tokens=${bal.tokens}`,
        );
        expect(bal.total).toBeGreaterThan(0n);
      }

      // Record original inventory per coin
      originalTokenIds = new Map<string, Set<string>>();
      originalTokenAmounts = new Map<string, Map<string, string>>();
      for (const coin of TEST_COINS) {
        const ids = getTokenIds(sphere, coin.symbol);
        const amounts = getTokenAmounts(sphere, coin.symbol);
        originalTokenIds.set(coin.symbol, ids);
        originalTokenAmounts.set(coin.symbol, amounts);
        expect(ids.size).toBeGreaterThan(0);
        console.log(`  Recorded ${ids.size} ${coin.symbol} token(s)`);
      }

      // Register IPFS provider AFTER all tokens arrived — prevents the
      // background write-behind buffer from flushing a partial token set
      // to IPNS before the explicit sync() below.
      expect(providersA.ipfsTokenStorage).toBeTruthy();
      await sphere.addTokenStorageProvider(providersA.ipfsTokenStorage!);
      console.log('  IPFS token storage provider added (after all tokens received)');

      // Sync to IPFS
      console.log('  Syncing to IPFS...');
      const syncResult = await sphere.payments.sync();
      console.log(
        `  Sync: added=${syncResult.added}, removed=${syncResult.removed}`,
      );

      // Verify tokens survived the sync round-trip (per coin)
      for (const coin of TEST_COINS) {
        const postSync = getBalance(sphere, coin.symbol);
        const orig = originalBalances.get(coin.symbol)!;
        expect(postSync.total).toBe(orig.total);
        expect(postSync.tokens).toBe(orig.tokens);
      }

      // Destroy the sphere — we're done with this instance
      await sphere.destroy();
      spheres.splice(spheres.indexOf(sphere), 1);

      console.log('[Test 1] PASSED: multi-coin tokens received and synced to IPFS');
    },
    240_000,
  );

  // ---------------------------------------------------------------------------
  // Test 2: ERASE all local data -> recreate from mnemonic -> recover from IPFS
  //         Uses NO-OP TRANSPORT to prove IPFS is the sole source of tokens
  // ---------------------------------------------------------------------------

  it(
    'erases local data, recreates from mnemonic, recovers multi-coin tokens ONLY from IPFS',
    async () => {
      expect(savedMnemonic).toBeTruthy();
      for (const coin of TEST_COINS) {
        expect(originalTokenIds.get(coin.symbol)!.size).toBeGreaterThan(0);
      }

      // Wait for IPNS propagation before recovery attempt
      console.log(
        `\n[Test 2] Waiting ${IPNS_PROPAGATION_WAIT_MS / 1000}s for IPNS propagation...`,
      );
      await new Promise((r) => setTimeout(r, IPNS_PROPAGATION_WAIT_MS));

      // Create fresh directories (simulating a new device or wiped phone)
      const dirsRecovery = makeTempDirs('recovery-ipfs-only');
      cleanupDirs.push(dirsRecovery.base);
      await ensureTrustbase(dirsRecovery.dataDir);

      // Create providers with IPFS but use NO-OP transport (no Nostr!)
      const providersRecovery = makeProviders(dirsRecovery);
      const noopTransport = createNoopTransport();

      console.log(
        '  Importing wallet from mnemonic with NO-OP transport (no Nostr)...',
      );
      const sphereRecovery = await Sphere.import({
        storage: providersRecovery.storage,
        tokenStorage: providersRecovery.tokenStorage,
        transport: noopTransport,
        oracle: providersRecovery.oracle,
        mnemonic: savedMnemonic,
      });
      spheres.push(sphereRecovery);
      console.log(
        `  Wallet imported: ${sphereRecovery.identity!.l1Address}`,
      );

      // Add IPFS provider
      expect(providersRecovery.ipfsTokenStorage).toBeTruthy();
      await sphereRecovery.addTokenStorageProvider(
        providersRecovery.ipfsTokenStorage!,
      );
      console.log('  IPFS token storage provider added');

      // CRITICAL ASSERTION: before sync, wallet must have ZERO tokens for ALL coins
      for (const coin of TEST_COINS) {
        const preSyncBal = getBalance(sphereRecovery, coin.symbol);
        console.log(
          `  Pre-sync ${coin.symbol}: total=${preSyncBal.total}, tokens=${preSyncBal.tokens}`,
        );
        expect(preSyncBal.total).toBe(0n);
        expect(preSyncBal.tokens).toBe(0);
      }

      // Sync from IPFS — this is the ONLY way to get tokens
      console.log('  Syncing from IPFS (this is the only token source)...');
      const { syncAdded, balances: postSyncBalances } = await syncUntilAllCoins(
        sphereRecovery,
        1n,
        IPNS_RESOLVE_TIMEOUT_MS,
      );

      for (const coin of TEST_COINS) {
        const bal = postSyncBalances.get(coin.symbol)!;
        console.log(
          `  Post-sync ${coin.symbol}: total=${bal.total}, tokens=${bal.tokens}`,
        );
      }
      console.log(`  syncAdded=${syncAdded}`);

      // CRITICAL ASSERTION: sync must have actually added tokens
      expect(syncAdded).toBeGreaterThan(0);

      // Verify per-coin: balance, token IDs, and amounts match original
      for (const coin of TEST_COINS) {
        const postBal = postSyncBalances.get(coin.symbol)!;
        const origBal = originalBalances.get(coin.symbol)!;
        expect(postBal.total).toBe(origBal.total);
        expect(postBal.tokens).toBe(origBal.tokens);

        const recoveredIds = getTokenIds(sphereRecovery, coin.symbol);
        const recoveredAmounts = getTokenAmounts(sphereRecovery, coin.symbol);
        const origIds = originalTokenIds.get(coin.symbol)!;
        const origAmounts = originalTokenAmounts.get(coin.symbol)!;

        expect(recoveredIds.size).toBe(origIds.size);
        for (const id of origIds) {
          expect(recoveredIds.has(id)).toBe(true);
          expect(recoveredAmounts.get(id)).toBe(origAmounts.get(id));
        }
      }

      // Cleanup this sphere
      await sphereRecovery.destroy();
      spheres.splice(spheres.indexOf(sphereRecovery), 1);

      console.log(
        `[Test 2] PASSED: recovered multi-coin tokens exclusively from IPFS (no Nostr)`,
      );
    },
    240_000,
  );

  // ---------------------------------------------------------------------------
  // Test 3: Full recovery with Nostr — erase, reimport, verify IPFS + Nostr
  //         Proves the real-world recovery flow works end-to-end
  // ---------------------------------------------------------------------------

  it(
    'full recovery: erase local data, reimport with Nostr, sync multi-coin from IPFS',
    async () => {
      expect(savedMnemonic).toBeTruthy();
      for (const coin of TEST_COINS) {
        expect(originalTokenIds.get(coin.symbol)!.size).toBeGreaterThan(0);
      }

      // Create fresh dirs (simulating new device)
      const dirsFull = makeTempDirs('recovery-full');
      cleanupDirs.push(dirsFull.base);
      await ensureTrustbase(dirsFull.dataDir);

      const providersFull = makeProviders(dirsFull);

      console.log(
        `\n[Test 3] Full recovery: importing wallet with Nostr + IPFS...`,
      );
      const sphereFull = await Sphere.import({
        ...providersFull,
        mnemonic: savedMnemonic,
        nametag: savedNametag,
      });
      spheres.push(sphereFull);

      // Add IPFS provider
      expect(providersFull.ipfsTokenStorage).toBeTruthy();
      await sphereFull.addTokenStorageProvider(
        providersFull.ipfsTokenStorage!,
      );

      // Sync from IPFS for all coins
      console.log('  Syncing from IPFS...');
      const { syncAdded, balances: syncedBalances } = await syncUntilAllCoins(
        sphereFull,
        1n,
        IPNS_RESOLVE_TIMEOUT_MS,
      );
      for (const coin of TEST_COINS) {
        const bal = syncedBalances.get(coin.symbol)!;
        console.log(
          `  Synced ${coin.symbol}: total=${bal.total}, tokens=${bal.tokens}`,
        );
      }
      console.log(`  syncAdded=${syncAdded}`);

      // Also try Nostr receive for any additional tokens
      try {
        await sphereFull.payments.receive();
      } catch {
        // May throw if no pending events
      }

      // Verify per-coin: balance >= original, all original token IDs present
      for (const coin of TEST_COINS) {
        const finalBal = getBalance(sphereFull, coin.symbol);
        const origBal = originalBalances.get(coin.symbol)!;
        console.log(
          `  Final ${coin.symbol}: total=${finalBal.total}, tokens=${finalBal.tokens}`,
        );

        expect(finalBal.total).toBeGreaterThanOrEqual(origBal.total);

        const recoveredIds = getTokenIds(sphereFull, coin.symbol);
        const origIds = originalTokenIds.get(coin.symbol)!;
        for (const id of origIds) {
          expect(recoveredIds.has(id)).toBe(true);
        }
      }

      console.log(
        `[Test 3] PASSED: full multi-coin recovery with IPFS + Nostr`,
      );
    },
    240_000,
  );
});
