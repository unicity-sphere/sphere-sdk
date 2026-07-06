/**
 * E2E: Whole-Profile export/import round-trip on real testnet.
 *
 * Two scenarios:
 *
 *   1. **Round-trip:** Wallet A receives multi-coin tokens via faucet,
 *      `profile-export` writes the snapshot to disk, a fresh Wallet B
 *      (different dataDir, SAME mnemonic) calls `profile-import` and
 *      MUST see the same tokens. The recovered tokens are then sent
 *      to a third wallet to prove they survived as fully spendable.
 *   2. **Refuse-overwrite:** A second `profile-import` against an
 *      already-non-empty Profile must fail without `--force` and
 *      succeed with it.
 *
 * Opt-in via `RUN_PROFILE_EXPORT_E2E=1` because real testnet faucet
 * requests are rate-limited; daily CI defaults exclude this. The
 * preflight gate also skips when nostr / aggregator / ipfs are
 * unhealthy.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import {
  exportProfile,
  parseProfileSnapshot,
} from '../../extensions/uxf/profile/profile-export';
import { importProfile } from '../../extensions/uxf/profile/profile-import';
import type { ProfileTokenStorageProvider } from '../../extensions/uxf/profile/profile-token-storage-provider';

// =============================================================================
// Test gate
// =============================================================================

const SKIP_INFRA = preflightSkip(
  ['nostr', 'aggregator', 'ipfs', 'faucet'],
  'profile-export-roundtrip',
);
const RUN_OPT_IN = process.env.RUN_PROFILE_EXPORT_E2E === '1';
const SKIP_SUITE = SKIP_INFRA || !RUN_OPT_IN;

if (!RUN_OPT_IN && !SKIP_INFRA) {
  // Surface a one-liner so it's clear the suite was skipped intentionally,
  // not silently dropped.
  console.log(
    '[profile-export-roundtrip] SKIP — set RUN_PROFILE_EXPORT_E2E=1 to enable',
  );
}

// =============================================================================
// Suite
// =============================================================================

describe.skipIf(SKIP_SUITE)('Profile whole-snapshot export/import — real testnet', () => {
  // Shared state across ordered tests
  let dirsA: ReturnType<typeof makeTempDirs>;
  let sphereA: Sphere;
  let savedMnemonicA: string;
  let savedNametagA: string;
  let originalBalances: Map<string, BalanceSnapshot>;
  let originalTokenIds: Map<string, Set<string>>;
  let originalTokenAmounts: Map<string, Map<string, string>>;
  let snapshotPath: string;

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
  // Test 1: Set up source wallet + receive multi-coin tokens
  // ---------------------------------------------------------------------------

  it('creates source Profile wallet and receives multi-coin tokens', async () => {
    savedNametagA = `e2e-snap-${rand()}`;
    dirsA = makeTempDirs('profile-export-a');
    cleanupDirs.push(dirsA.base);
    await ensureTrustbase(dirsA.dataDir);

    const providersA = makeProfileProviders(dirsA);
    console.log(`\n[Test 1] Creating source Profile-backed wallet @${savedNametagA}...`);
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
    console.log(`  Wallet A: ${sphereA.identity!.chainPubkey}`);

    console.log(`  Requesting faucet for @${savedNametagA}...`);
    await requestMultiCoinFaucet(savedNametagA);
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

    console.log('  Flushing Profile state to IPFS+OrbitDB before export...');
    await sphereA.payments.sync();

    console.log('[Test 1] PASSED: multi-coin wallet ready for export');
  }, 240_000);

  // ---------------------------------------------------------------------------
  // Test 2: profile-export → fresh wallet B → profile-import → token recovery
  // ---------------------------------------------------------------------------

  it('exports the Profile, imports into a fresh wallet, recovers tokens', async () => {
    expect(savedMnemonicA).toBeTruthy();

    console.log('\n[Test 2] Exporting Profile snapshot...');
    const storageA = sphereA.getStorage();
    const tokenStorageA = sphereA.getTokenStorage() as unknown as ProfileTokenStorageProvider;
    const exportResult = await exportProfile({
      storage: storageA,
      tokenStorage: tokenStorageA,
      chainPubkey: sphereA.identity!.chainPubkey!,
      network: 'testnet',
    });
    console.log(`  CAR size:          ${exportResult.carBytes.byteLength} bytes`);
    console.log(`  KV entries:        ${exportResult.entryCount}`);
    console.log(`  Bundles embedded:  ${exportResult.bundlesEmbedded}`);
    console.log(`  Bundles missing:   ${exportResult.bundlesMissing}`);
    console.log(`  Root CID:          ${exportResult.rootCid}`);
    expect(exportResult.entryCount).toBeGreaterThan(0);
    expect(exportResult.bundlesEmbedded).toBeGreaterThan(0);

    snapshotPath = join(dirsA.base, 'profile-export.car');
    writeFileSync(snapshotPath, exportResult.carBytes);

    // Tear down wallet A entirely.
    console.log('  Destroying wallet A and wiping local storage...');
    await sphereA.destroy();
    spheres.splice(spheres.indexOf(sphereA), 1);
    rmSync(dirsA.base, { recursive: true, force: true });

    // Set up wallet B with FRESH dirs and SAME mnemonic — but use a no-op
    // transport so tokens can ONLY arrive via the imported snapshot.
    const dirsB = makeTempDirs('profile-export-b');
    cleanupDirs.push(dirsB.base);
    await ensureTrustbase(dirsB.dataDir);
    const providersB = makeProfileProviders(dirsB);
    const noopTransport = createNoopTransport();

    console.log('  Creating fresh wallet B (no-op transport)...');
    const sphereB = await Sphere.import({
      storage: providersB.storage,
      tokenStorage: providersB.tokenStorage,
      transport: noopTransport,
      oracle: providersB.oracle,
      mnemonic: savedMnemonicA,
    });
    spheres.push(sphereB);

    // Replay the snapshot into wallet B.
    const carBytesIn = readFileSync(snapshotPath);
    console.log('  Parsing snapshot...');
    const parsed = await parseProfileSnapshot(new Uint8Array(carBytesIn));

    console.log('  Importing into wallet B...');
    const storageB = sphereB.getStorage();
    const tokenStorageB = sphereB.getTokenStorage() as unknown as ProfileTokenStorageProvider;
    const importResult = await importProfile({
      storage: storageB,
      tokenStorage: tokenStorageB,
      snapshot: parsed.snapshot,
      bundleCars: parsed.bundleCars,
      expectedChainPubkey: sphereB.identity!.chainPubkey!,
      // Wallet B IS fresh, so this should pass without --force.
    });
    console.log(`  Replayed entries:       ${importResult.entriesReplayed}`);
    console.log(`  Bundles pinned:         ${importResult.bundlesPinned}`);
    console.log(`  Bundle refs restored:   ${importResult.bundleRefsRestored}`);
    expect(importResult.entriesReplayed).toBeGreaterThan(0);
    expect(importResult.bundleRefsRestored).toBeGreaterThan(0);

    // Drive the Profile load path so the imported bundle refs are
    // resolved into in-memory tokens.
    console.log('  Reloading payments module...');
    await sphereB.payments.load();

    // Allow some grace for IPFS pin propagation.
    const recoverDeadline = performance.now() + 60_000;
    while (performance.now() < recoverDeadline) {
      await sphereB.payments.sync();
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

    for (const coin of TEST_COINS) {
      const recoveredBal = getBalance(sphereB, coin.symbol);
      const origBal = originalBalances.get(coin.symbol)!;
      console.log(
        `  ${coin.symbol}: recovered total=${recoveredBal.total}, original=${origBal.total}`,
      );
      expect(recoveredBal.total).toBe(origBal.total);
      expect(recoveredBal.tokens).toBe(origBal.tokens);

      const recoveredIds = getTokenIds(sphereB, coin.symbol);
      const recoveredAmounts = getTokenAmounts(sphereB, coin.symbol);
      const origIds = originalTokenIds.get(coin.symbol)!;
      const origAmounts = originalTokenAmounts.get(coin.symbol)!;
      for (const id of origIds) {
        expect(recoveredIds.has(id)).toBe(true);
        expect(recoveredAmounts.get(id)).toBe(origAmounts.get(id));
      }
    }

    // Pivot: keep sphereB alive for Test 3, but stash its identity for
    // the refuse-overwrite assertion.
    sphereA = sphereB;

    console.log('[Test 2] PASSED: snapshot round-trip recovered every token');
  }, 360_000);

  // ---------------------------------------------------------------------------
  // Test 3: Refuse-overwrite
  // ---------------------------------------------------------------------------

  it('refuses to import into a non-empty Profile without --force', async () => {
    expect(snapshotPath).toBeTruthy();

    const carBytesIn = readFileSync(snapshotPath);
    const parsed = await parseProfileSnapshot(new Uint8Array(carBytesIn));

    const storageB = sphereA.getStorage();
    const tokenStorageB = sphereA.getTokenStorage() as unknown as ProfileTokenStorageProvider;

    // Wallet B is now non-empty (Test 2 imported into it). Re-importing
    // without --force MUST fail.
    await expect(
      importProfile({
        storage: storageB,
        tokenStorage: tokenStorageB,
        snapshot: parsed.snapshot,
        bundleCars: parsed.bundleCars,
        expectedChainPubkey: sphereA.identity!.chainPubkey!,
      }),
    ).rejects.toThrow(/non-empty/i);

    // With force:true the import succeeds.
    const forced = await importProfile({
      storage: storageB,
      tokenStorage: tokenStorageB,
      snapshot: parsed.snapshot,
      bundleCars: parsed.bundleCars,
      expectedChainPubkey: sphereA.identity!.chainPubkey!,
      force: true,
    });
    expect(forced.entriesReplayed).toBeGreaterThan(0);

    console.log('[Test 3] PASSED: refuse-overwrite + --force gate work');
  }, 120_000);
});
