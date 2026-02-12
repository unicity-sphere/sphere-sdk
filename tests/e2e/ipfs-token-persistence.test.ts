/**
 * E2E Test: IPFS Active Token Persistence
 *
 * Proves that active (spendable) tokens survive IPFS round-trips:
 * persist, recover, merge, and spend.
 *
 * Multi-coin: tests use ALL faucet-supported coins (SOL, ETH, BTC, UCT,
 * USDT, USDC, USDU) simultaneously to verify that wallets with multiple
 * coin types (decimals: 6/8/9/18) survive IPFS round-trips, recovery,
 * spend, and merge flows.
 *
 * Run with: npm run test:e2e
 */

import { describe, it, expect, afterAll } from 'vitest';
import { Sphere } from '../../core/Sphere';
import { createNodeProviders } from '../../impl/nodejs';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  TEST_COINS,
  FAUCET_TOPUP_TIMEOUT_MS,
  IPNS_PROPAGATION_WAIT_MS,
  IPNS_RESOLVE_TIMEOUT_MS,
  DEFAULT_API_KEY,
  NETWORK,
  rand,
  makeTempDirs,
  ensureTrustbase,
  makeProviders,
  createNoopTransport,
  requestFaucet,
  requestMultiCoinFaucet,
  getBalance,
  getTokenIds,
  getTokenAmounts,
  waitForAllCoins,
  waitForTokens,
  syncUntilAllCoins,
  type BalanceSnapshot,
} from './helpers';

// =============================================================================
// Test Suite
// =============================================================================

describe('IPFS Active Token Persistence E2E', () => {
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

  it('creates wallet, receives multi-coin tokens, and syncs to IPFS', async () => {
    savedNametagA = `e2e-ipfs-${rand()}`;
    dirsA = makeTempDirs('persist-a');
    cleanupDirs.push(dirsA.base);
    await ensureTrustbase(dirsA.dataDir);

    const providersA = makeProviders(dirsA);

    console.log(`\n[Test 1] Creating wallet A with nametag @${savedNametagA}...`);
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
    console.log(`  Wallet A created: ${sphereA.identity!.l1Address}`);

    // Request faucet for all coins
    console.log(`  Requesting multi-coin faucet for @${savedNametagA}...`);
    await requestMultiCoinFaucet(savedNametagA);

    // Wait for ALL coins to arrive
    console.log(`  Waiting for all ${TEST_COINS.length} coins...`);
    originalBalances = await waitForAllCoins(sphereA, FAUCET_TOPUP_TIMEOUT_MS);

    // Record original state per coin
    originalTokenIds = new Map<string, Set<string>>();
    originalTokenAmounts = new Map<string, Map<string, string>>();
    for (const coin of TEST_COINS) {
      const bal = originalBalances.get(coin.symbol)!;
      console.log(`  ${coin.symbol}: total=${bal.total}, tokens=${bal.tokens}`);
      expect(bal.total).toBeGreaterThan(0n);

      const ids = getTokenIds(sphereA, coin.symbol);
      const amounts = getTokenAmounts(sphereA, coin.symbol);
      originalTokenIds.set(coin.symbol, ids);
      originalTokenAmounts.set(coin.symbol, amounts);
      expect(ids.size).toBeGreaterThan(0);
      console.log(`  Recorded ${ids.size} ${coin.symbol} token(s)`);
    }

    // Register IPFS provider AFTER all tokens arrived — prevents the
    // background write-behind buffer from flushing a partial token set
    // to IPNS before the explicit sync() below.
    if (providersA.ipfsTokenStorage) {
      await sphereA.addTokenStorageProvider(providersA.ipfsTokenStorage);
      console.log('  IPFS token storage provider added (after all tokens received)');
    } else {
      throw new Error('IPFS token storage provider not created — check tokenSync.ipfs.enabled');
    }

    // Sync to IPFS
    console.log('  Syncing to IPFS...');
    const syncResult = await sphereA.payments.sync();
    console.log(`  Sync result: added=${syncResult.added}, removed=${syncResult.removed}`);

    console.log('[Test 1] PASSED: multi-coin wallet created, tokens received, synced to IPFS');
  }, 240_000);

  // ---------------------------------------------------------------------------
  // Test 2: Recover multi-coin tokens from IPFS after local wipe
  // ---------------------------------------------------------------------------

  it('recovers multi-coin tokens ONLY from IPFS after local storage wipe (no Nostr)', async () => {
    expect(savedMnemonicA).toBeTruthy();
    for (const coin of TEST_COINS) {
      expect(originalTokenIds.get(coin.symbol)!.size).toBeGreaterThan(0);
    }

    // Destroy and wipe ALL local data
    console.log('\n[Test 2] Destroying wallet A and wiping local storage...');
    await sphereA.destroy();
    spheres.splice(spheres.indexOf(sphereA), 1);
    rmSync(dirsA.base, { recursive: true, force: true });
    expect(existsSync(dirsA.tokensDir)).toBe(false);

    // Wait for IPNS propagation
    console.log(`  Waiting ${IPNS_PROPAGATION_WAIT_MS / 1000}s for IPNS propagation...`);
    await new Promise((r) => setTimeout(r, IPNS_PROPAGATION_WAIT_MS));

    // Fresh dirs + providers
    dirsA = makeTempDirs('persist-a-recovered');
    cleanupDirs.push(dirsA.base);
    await ensureTrustbase(dirsA.dataDir);
    const providersA = makeProviders(dirsA);

    // CRITICAL: Use NO-OP transport to prove tokens come ONLY from IPFS, not Nostr
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

    // Add IPFS provider
    if (providersA.ipfsTokenStorage) {
      await sphereA.addTokenStorageProvider(providersA.ipfsTokenStorage);
      console.log('  IPFS token storage provider added');
    } else {
      throw new Error('IPFS token storage provider not created');
    }

    // CRITICAL ASSERTION: before sync, wallet must have ZERO tokens for ALL coins
    // This proves Nostr did NOT deliver anything (no-op transport)
    for (const coin of TEST_COINS) {
      const preSyncBal = getBalance(sphereA, coin.symbol);
      console.log(`  Pre-sync ${coin.symbol}: total=${preSyncBal.total}, tokens=${preSyncBal.tokens}`);
      expect(preSyncBal.total).toBe(0n);
      expect(preSyncBal.tokens).toBe(0);
    }

    // Sync from IPFS — this is the ONLY way to get tokens (Nostr is disabled)
    console.log('  Syncing from IPFS (this is the only token source)...');
    const { syncAdded, balances: postSyncBalances } = await syncUntilAllCoins(
      sphereA,
      1n,
      IPNS_RESOLVE_TIMEOUT_MS,
    );

    for (const coin of TEST_COINS) {
      const bal = postSyncBalances.get(coin.symbol)!;
      console.log(`  Post-sync ${coin.symbol}: total=${bal.total}, tokens=${bal.tokens}`);
    }
    console.log(`  syncAdded=${syncAdded}`);

    // CRITICAL: sync must have actually added tokens (proves IPFS delivered them)
    expect(syncAdded).toBeGreaterThan(0);

    // Verify per-coin balance and tokens match original exactly
    for (const coin of TEST_COINS) {
      const recoveredBal = postSyncBalances.get(coin.symbol)!;
      const origBal = originalBalances.get(coin.symbol)!;

      expect(recoveredBal.total).toBe(origBal.total);
      expect(recoveredBal.tokens).toBe(origBal.tokens);

      // Verify individual token IDs and amounts
      const recoveredIds = getTokenIds(sphereA, coin.symbol);
      const recoveredAmounts = getTokenAmounts(sphereA, coin.symbol);
      const origIds = originalTokenIds.get(coin.symbol)!;
      const origAmounts = originalTokenAmounts.get(coin.symbol)!;

      for (const id of origIds) {
        expect(recoveredIds.has(id)).toBe(true);
        expect(recoveredAmounts.get(id)).toBe(origAmounts.get(id));
      }
    }

    // Now re-import with real Nostr transport so Test 3 (spend) can send tokens
    console.log('  Re-importing with real transport for subsequent tests...');
    await sphereA.destroy();
    spheres.splice(spheres.indexOf(sphereA), 1);

    sphereA = await Sphere.import({
      ...providersA,
      mnemonic: savedMnemonicA,
      nametag: savedNametagA,
    });
    spheres.push(sphereA);

    // Add IPFS provider to the real-transport sphere
    if (providersA.ipfsTokenStorage) {
      await sphereA.addTokenStorageProvider(providersA.ipfsTokenStorage);
    }

    // Sync to reload IPFS tokens into the real-transport sphere
    await sphereA.payments.sync();
    await sphereA.payments.load();

    console.log('[Test 2] PASSED: all multi-coin tokens recovered exclusively from IPFS (no Nostr)');
  }, 240_000);

  // ---------------------------------------------------------------------------
  // Test 3: Spend recovered tokens (proves they are truly usable) — per coin
  // ---------------------------------------------------------------------------

  it('spends recovered multi-coin tokens to another wallet', async () => {
    // Create wallet B as a send target
    const nametagB = `e2e-ipfs-b-${rand()}`;
    const dirsB = makeTempDirs('persist-b');
    cleanupDirs.push(dirsB.base);
    await ensureTrustbase(dirsB.dataDir);

    const providersB = createNodeProviders({
      network: NETWORK,
      dataDir: dirsB.dataDir,
      tokensDir: dirsB.tokensDir,
      oracle: {
        trustBasePath: join(dirsB.dataDir, 'trustbase.json'),
        apiKey: DEFAULT_API_KEY,
      },
    });

    console.log(`\n[Test 3] Creating wallet B with nametag @${nametagB}...`);
    const { sphere: sphereB } = await Sphere.init({
      ...providersB,
      autoGenerate: true,
      nametag: nametagB,
    });
    spheres.push(sphereB);
    console.log(`  Wallet B created: ${sphereB.identity!.l1Address}`);

    // Finalize recovered tokens so they are spendable
    console.log('  Resolving unconfirmed tokens on wallet A...');
    await sphereA.payments.receive({ finalize: true, timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 3000));
    await sphereA.payments.load();

    // Send one token per coin to wallet B
    for (const coin of TEST_COINS) {
      const senderBefore = getBalance(sphereA, coin.symbol);
      console.log(`  Sender A ${coin.symbol} before: total=${senderBefore.total}, tokens=${senderBefore.tokens}`);
      expect(senderBefore.total).toBeGreaterThan(0n);

      const tokens = sphereA.payments.getTokens().filter((t) => t.symbol === coin.symbol);
      expect(tokens.length).toBeGreaterThan(0);
      const firstToken = tokens[0];
      const sendAmount = firstToken.amount;
      const coinId = firstToken.coinId;
      console.log(`  Sending ${sendAmount} ${coin.symbol} (coinId=${coinId}) to @${nametagB}...`);

      const sendResult = await sphereA.payments.send({
        recipient: `@${nametagB}`,
        amount: sendAmount,
        coinId,
      });
      console.log(`  Send ${coin.symbol} status: ${sendResult.status}`);
      expect(sendResult.status).toBe('completed');

      // Verify A's balance decreased
      await sphereA.payments.load();
      const senderAfter = getBalance(sphereA, coin.symbol);
      console.log(`  Sender A ${coin.symbol} after: total=${senderAfter.total}, tokens=${senderAfter.tokens}`);
      expect(senderAfter.total).toBeLessThan(senderBefore.total);
    }

    console.log('[Test 3] PASSED: IPFS-recovered multi-coin tokens are spendable');
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Test 4: Merge local + IPFS tokens — multi-coin
  // ---------------------------------------------------------------------------

  it('merges locally-received multi-coin tokens with IPFS-recovered tokens', async () => {
    const nametagC = `e2e-ipfs-c-${rand()}`;

    // --- Step 1: Create wallet C, top up batch 1 (all coins), sync to IPFS ---
    const dirsC1 = makeTempDirs('persist-c-batch1');
    cleanupDirs.push(dirsC1.base);
    await ensureTrustbase(dirsC1.dataDir);
    const providersC1 = makeProviders(dirsC1);

    console.log(`\n[Test 4] Creating wallet C with nametag @${nametagC}...`);
    const { sphere: sphereC1, generatedMnemonic: mnemonicC } = await Sphere.init({
      ...providersC1,
      autoGenerate: true,
      nametag: nametagC,
    });
    spheres.push(sphereC1);
    expect(mnemonicC).toBeTruthy();
    console.log(`  Wallet C created: ${sphereC1.identity!.l1Address}`);

    // Request batch 1 (all coins)
    console.log('  Requesting batch 1 (all coins)...');
    await requestMultiCoinFaucet(nametagC);

    const batch1Balances = await waitForAllCoins(sphereC1, FAUCET_TOPUP_TIMEOUT_MS);
    for (const coin of TEST_COINS) {
      const bal = batch1Balances.get(coin.symbol)!;
      console.log(`  Batch 1 ${coin.symbol}: total=${bal.total}, tokens=${bal.tokens}`);
    }

    // Add IPFS AFTER all batch 1 tokens arrived — prevents write-behind
    // buffer from flushing partial data to IPNS before explicit sync.
    if (providersC1.ipfsTokenStorage) {
      await sphereC1.addTokenStorageProvider(providersC1.ipfsTokenStorage);
    } else {
      throw new Error('IPFS token storage provider not created');
    }

    // Sync batch 1 to IPFS
    console.log('  Syncing batch 1 to IPFS...');
    await sphereC1.payments.sync();

    // --- Step 2: Destroy + wipe local ---
    console.log('  Destroying wallet C and wiping local...');
    await sphereC1.destroy();
    spheres.splice(spheres.indexOf(sphereC1), 1);
    rmSync(dirsC1.base, { recursive: true, force: true });

    console.log(`  Waiting ${IPNS_PROPAGATION_WAIT_MS / 1000}s for IPNS propagation...`);
    await new Promise((r) => setTimeout(r, IPNS_PROPAGATION_WAIT_MS));

    // --- Step 3: Import fresh (no IPFS yet), request batch 2 ---
    const dirsC2 = makeTempDirs('persist-c-batch2');
    cleanupDirs.push(dirsC2.base);
    await ensureTrustbase(dirsC2.dataDir);
    const providersC2 = makeProviders(dirsC2);

    console.log('  Importing wallet C from mnemonic (with nametag, no IPFS yet)...');
    const sphereC2 = await Sphere.import({
      ...providersC2,
      mnemonic: mnemonicC!,
      nametag: nametagC,
    });
    spheres.push(sphereC2);

    // Request batch 2 (all coins)
    console.log('  Requesting batch 2 (all coins)...');
    await requestMultiCoinFaucet(nametagC);

    // Wait for batch 2 to arrive (at least one coin non-zero)
    console.log('  Waiting for batch 2 tokens...');
    // Use waitForTokens on the first coin as a minimum — Nostr replay may also deliver batch 1
    const preSyncBal = await waitForTokens(sphereC2, TEST_COINS[0].symbol, 1n, FAUCET_TOPUP_TIMEOUT_MS);
    console.log(`  Pre-sync ${TEST_COINS[0].symbol}: total=${preSyncBal.total}, tokens=${preSyncBal.tokens}`);

    // --- Step 4: Add IPFS provider and sync to merge ---
    if (providersC2.ipfsTokenStorage) {
      await sphereC2.addTokenStorageProvider(providersC2.ipfsTokenStorage);
    } else {
      throw new Error('IPFS token storage provider not created');
    }

    console.log(`  Retrying sync up to ${IPNS_RESOLVE_TIMEOUT_MS / 1000}s to merge IPFS tokens...`);
    const start = performance.now();
    let syncAdded = 0;
    while (performance.now() - start < IPNS_RESOLVE_TIMEOUT_MS) {
      try {
        const syncResult = await sphereC2.payments.sync();
        syncAdded = syncResult.added;
        if (syncAdded > 0) {
          console.log(`  Sync merged: added=${syncAdded}`);
          break;
        }
      } catch (err) {
        console.log(`  Sync attempt failed: ${err instanceof Error ? err.message : err}`);
      }
      console.log('  Retrying in 5s...');
      await new Promise((r) => setTimeout(r, 5000));
    }

    await sphereC2.payments.load();

    // Verify per-coin: merged balance >= 2x batch1 (batch1 from IPFS + batch2 from Nostr)
    for (const coin of TEST_COINS) {
      const mergedBal = getBalance(sphereC2, coin.symbol);
      const batch1Bal = batch1Balances.get(coin.symbol)!;
      console.log(`  Merged ${coin.symbol}: total=${mergedBal.total}, tokens=${mergedBal.tokens}`);

      expect(mergedBal.total).toBeGreaterThanOrEqual(batch1Bal.total * 2n);
      expect(mergedBal.tokens).toBeGreaterThanOrEqual(2);
    }

    console.log('[Test 4] PASSED: local + IPFS multi-coin tokens merged correctly');
  }, 360_000);
});
