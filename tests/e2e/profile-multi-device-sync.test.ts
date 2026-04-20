/**
 * E2E Test: Profile Multi-Device Sync
 *
 * Mirrors `ipfs-multi-device-sync.test.ts` but with the Profile stack
 * (OrbitDB + IPFS CAR) replacing IPNS-based sync.
 *
 * Proves that a wallet's token inventory can be recovered on a
 * DIFFERENT DEVICE (fresh temp dir, same mnemonic) through the Profile
 * layer alone — the Nostr path is explicitly disabled with a no-op
 * transport in the critical test so we verify IPFS+OrbitDB is the
 * sole replication channel.
 *
 * Real infrastructure:
 *   - Nostr testnet relay (initial token reception on Device A only)
 *   - Unicity IPFS gateways (CAR pin/fetch)
 *   - DEFAULT_IPFS_BOOTSTRAP_PEERS (libp2p gossipsub for OrbitDB)
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

// =============================================================================
// Test Suite
// =============================================================================

describe('Profile Multi-Device Sync E2E', () => {
  let savedMnemonic: string;
  let savedNametag: string;
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
  // Test 1: Device A creates wallet, receives all coins, publishes to Profile
  // ---------------------------------------------------------------------------

  it(
    'Device A creates Profile-backed wallet, receives multi-coin tokens, publishes state',
    async () => {
      savedNametag = `e2e-pms-${rand()}`;
      const dirsA = makeTempDirs('profile-multidev-a');
      cleanupDirs.push(dirsA.base);
      await ensureTrustbase(dirsA.dataDir);

      const providersA = makeProfileProviders(dirsA);

      console.log(`\n[Test 1] Device A creating Profile wallet @${savedNametag}...`);
      const { sphere, created, generatedMnemonic } = await Sphere.init({
        ...providersA,
        autoGenerate: true,
        nametag: savedNametag,
      });
      spheres.push(sphere);

      expect(created).toBe(true);
      expect(generatedMnemonic).toBeTruthy();
      savedMnemonic = generatedMnemonic!;

      console.log(`  Requesting faucet for @${savedNametag}...`);
      await requestMultiCoinFaucet(savedNametag);

      console.log(`  Waiting for all ${TEST_COINS.length} coins...`);
      originalBalances = await waitForAllCoins(sphere, FAUCET_TOPUP_TIMEOUT_MS);

      originalTokenIds = new Map<string, Set<string>>();
      originalTokenAmounts = new Map<string, Map<string, string>>();
      for (const coin of TEST_COINS) {
        const bal = originalBalances.get(coin.symbol)!;
        console.log(`  ${coin.symbol}: total=${bal.total}, tokens=${bal.tokens}`);
        expect(bal.total).toBeGreaterThan(0n);
        originalTokenIds.set(coin.symbol, getTokenIds(sphere, coin.symbol));
        originalTokenAmounts.set(coin.symbol, getTokenAmounts(sphere, coin.symbol));
      }

      // Explicit sync flush — pushes CAR bundle to IPFS, updates
      // OrbitDB OpLog with the latest bundle CID.
      console.log('  Publishing state to Profile (IPFS CAR + OrbitDB)...');
      const syncResult = await sphere.payments.sync();
      console.log(`  Sync: added=${syncResult.added}, removed=${syncResult.removed}`);

      await sphere.destroy();
      spheres.splice(spheres.indexOf(sphere), 1);

      console.log('[Test 1] PASSED: Device A state published');
    },
    240_000,
  );

  // ---------------------------------------------------------------------------
  // Test 2: Device B (fresh dir, no-op transport) recovers ONLY via Profile
  // ---------------------------------------------------------------------------

  it(
    'Device B recovers multi-coin tokens ONLY from Profile layer (no Nostr)',
    async () => {
      expect(savedMnemonic).toBeTruthy();
      for (const coin of TEST_COINS) {
        expect(originalTokenIds.get(coin.symbol)!.size).toBeGreaterThan(0);
      }

      // Wait for libp2p/IPFS propagation between devices.
      console.log('\n[Test 2] Waiting for IPFS + OrbitDB propagation...');
      await new Promise((r) => setTimeout(r, 10_000));

      const dirsB = makeTempDirs('profile-multidev-b-noopnostr');
      cleanupDirs.push(dirsB.base);
      await ensureTrustbase(dirsB.dataDir);

      const providersB = makeProfileProviders(dirsB);
      const noopTransport = createNoopTransport();

      console.log('  Importing wallet on Device B with NO-OP transport...');
      const sphereB = await Sphere.import({
        storage: providersB.storage,
        tokenStorage: providersB.tokenStorage,
        transport: noopTransport,
        oracle: providersB.oracle,
        mnemonic: savedMnemonic,
      });
      spheres.push(sphereB);
      console.log(`  Device B imported: ${sphereB.identity!.l1Address}`);

      // Before sync: Device B has ZERO tokens (no Nostr, empty local cache).
      for (const coin of TEST_COINS) {
        const pre = getBalance(sphereB, coin.symbol);
        console.log(`  Pre-sync ${coin.symbol}: total=${pre.total}`);
        expect(pre.total).toBe(0n);
        expect(pre.tokens).toBe(0);
      }

      // Sync is the ONLY token source. Retry while libp2p discovers
      // peers and the OrbitDB OpLog tail arrives.
      console.log('  Syncing from Profile layer...');
      const deadline = performance.now() + 150_000;
      let syncAdded = 0;
      while (performance.now() < deadline) {
        try {
          const r = await sphereB.payments.sync();
          syncAdded += r.added;
        } catch (err) {
          console.log(`  sync() attempt failed: ${err instanceof Error ? err.message : err}`);
        }
        let allReady = true;
        for (const coin of TEST_COINS) {
          if (getBalance(sphereB, coin.symbol).total < 1n) {
            allReady = false;
            break;
          }
        }
        if (allReady) break;
        await new Promise((r) => setTimeout(r, 5000));
      }

      // Profile actually delivered tokens — not a noop.
      expect(syncAdded).toBeGreaterThan(0);

      // Full inventory match
      for (const coin of TEST_COINS) {
        const post = getBalance(sphereB, coin.symbol);
        const orig = originalBalances.get(coin.symbol)!;
        console.log(`  Post-sync ${coin.symbol}: total=${post.total} (orig ${orig.total})`);
        expect(post.total).toBe(orig.total);
        expect(post.tokens).toBe(orig.tokens);

        const recIds = getTokenIds(sphereB, coin.symbol);
        const recAmounts = getTokenAmounts(sphereB, coin.symbol);
        const origIds = originalTokenIds.get(coin.symbol)!;
        const origAmounts = originalTokenAmounts.get(coin.symbol)!;
        expect(recIds.size).toBe(origIds.size);
        for (const id of origIds) {
          expect(recIds.has(id)).toBe(true);
          expect(recAmounts.get(id)).toBe(origAmounts.get(id));
        }
      }

      await sphereB.destroy();
      spheres.splice(spheres.indexOf(sphereB), 1);

      console.log('[Test 2] PASSED: Device B recovered exclusively via Profile (no Nostr)');
    },
    300_000,
  );

  // ---------------------------------------------------------------------------
  // Test 3: Full recovery with real Nostr — merge path works end-to-end
  // ---------------------------------------------------------------------------

  it(
    'Device C full recovery: Profile + Nostr merge delivers the same inventory',
    async () => {
      expect(savedMnemonic).toBeTruthy();
      for (const coin of TEST_COINS) {
        expect(originalTokenIds.get(coin.symbol)!.size).toBeGreaterThan(0);
      }

      const dirsC = makeTempDirs('profile-multidev-c-full');
      cleanupDirs.push(dirsC.base);
      await ensureTrustbase(dirsC.dataDir);

      const providersC = makeProfileProviders(dirsC);

      console.log('\n[Test 3] Device C full recovery (Profile + Nostr)...');
      const sphereC = await Sphere.import({
        ...providersC,
        mnemonic: savedMnemonic,
        nametag: savedNametag,
      });
      spheres.push(sphereC);

      // Sync — both paths (Profile and Nostr) should converge to the
      // same inventory.
      console.log('  Syncing...');
      const deadline = performance.now() + 150_000;
      while (performance.now() < deadline) {
        await sphereC.payments.sync();
        let allReady = true;
        for (const coin of TEST_COINS) {
          if (getBalance(sphereC, coin.symbol).total < 1n) {
            allReady = false;
            break;
          }
        }
        if (allReady) break;
        await new Promise((r) => setTimeout(r, 5000));
      }

      // Inventory match
      for (const coin of TEST_COINS) {
        const post = getBalance(sphereC, coin.symbol);
        const orig = originalBalances.get(coin.symbol)!;
        expect(post.total).toBe(orig.total);
        expect(post.tokens).toBe(orig.tokens);
      }

      await sphereC.destroy();
      spheres.splice(spheres.indexOf(sphereC), 1);

      console.log('[Test 3] PASSED: Profile + Nostr full recovery');
    },
    300_000,
  );
});
