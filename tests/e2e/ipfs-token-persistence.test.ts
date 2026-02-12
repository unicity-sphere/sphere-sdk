/**
 * E2E Test: IPFS Active Token Persistence
 *
 * Proves that active (spendable) tokens survive IPFS round-trips:
 * persist, recover, merge, and spend.
 *
 * Run with: npm run test:e2e
 */

import { describe, it, expect, afterAll } from 'vitest';
import { Sphere } from '../../core/Sphere';
import { createNodeProviders, type NodeProviders } from '../../impl/nodejs';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// =============================================================================
// Constants
// =============================================================================

const FAUCET_URL = 'https://faucet.unicity.network/api/v1/faucet/request';
const NETWORK = 'testnet' as const;
const TRUSTBASE_URL = 'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/bft-trustbase.testnet.json';
const DEFAULT_API_KEY = 'sk_06365a9c44654841a366068bcfc68986';

const FAUCET_TOPUP_TIMEOUT_MS = 90_000;
const IPNS_PROPAGATION_WAIT_MS = 5_000;
const IPNS_RESOLVE_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;

// =============================================================================
// Types
// =============================================================================

interface BalanceSnapshot {
  confirmed: bigint;
  unconfirmed: bigint;
  total: bigint;
  tokens: number;
}

// =============================================================================
// Helpers
// =============================================================================

const rand = () => Math.random().toString(36).slice(2, 8);

function makeTempDirs(label: string) {
  const base = join(tmpdir(), `sphere-e2e-ipfs-persist-${label}-${Date.now()}-${rand()}`);
  const dataDir = join(base, 'data');
  const tokensDir = join(base, 'tokens');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(tokensDir, { recursive: true });
  return { base, dataDir, tokensDir };
}

async function ensureTrustbase(dataDir: string): Promise<void> {
  const trustbasePath = join(dataDir, 'trustbase.json');
  if (existsSync(trustbasePath)) return;

  const res = await fetch(TRUSTBASE_URL);
  if (!res.ok) {
    throw new Error(`Failed to download trustbase: ${res.status}`);
  }
  const data = await res.text();
  writeFileSync(trustbasePath, data);
}

function makeProviders(dirs: { dataDir: string; tokensDir: string }): NodeProviders {
  return createNodeProviders({
    network: NETWORK,
    dataDir: dirs.dataDir,
    tokensDir: dirs.tokensDir,
    oracle: {
      trustBasePath: join(dirs.dataDir, 'trustbase.json'),
      apiKey: DEFAULT_API_KEY,
    },
    tokenSync: {
      ipfs: { enabled: true },
    },
  });
}

async function requestFaucet(
  nametag: string,
  coin: string,
  amount: number,
): Promise<{ success: boolean; message?: string }> {
  try {
    const response = await fetch(FAUCET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unicityId: nametag, coin, amount }),
    });
    const result = (await response.json()) as { success: boolean; message?: string; error?: string };
    return { success: result.success, message: result.message || result.error };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : 'Request failed' };
  }
}

function getBalance(sphere: Sphere, symbol: string): BalanceSnapshot {
  const balances = sphere.payments.getBalance();
  const bal = balances.find((b) => b.symbol === symbol);
  if (!bal) return { confirmed: 0n, unconfirmed: 0n, total: 0n, tokens: 0 };
  return {
    confirmed: BigInt(bal.confirmedAmount),
    unconfirmed: BigInt(bal.unconfirmedAmount),
    total: BigInt(bal.totalAmount),
    tokens: bal.tokenCount,
  };
}

async function waitForTokens(
  sphere: Sphere,
  symbol: string,
  minTotal: bigint,
  timeoutMs: number,
): Promise<BalanceSnapshot> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    // Explicit fetch from Nostr (one-shot query for pending events)
    try {
      await sphere.payments.receive();
    } catch {
      // receive() may throw if transport doesn't support fetchPendingEvents
    }
    const bal = getBalance(sphere, symbol);
    if (bal.total >= minTotal) return bal;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  const final = getBalance(sphere, symbol);
  if (final.total < minTotal) {
    throw new Error(
      `Timed out waiting for ${symbol} tokens: got ${final.total}, needed >= ${minTotal}`,
    );
  }
  return final;
}

// =============================================================================
// Test Suite
// =============================================================================

describe('IPFS Active Token Persistence E2E', () => {
  // Shared state across ordered tests
  let dirsA: ReturnType<typeof makeTempDirs>;
  let providersA: NodeProviders;
  let sphereA: Sphere;
  let savedMnemonicA: string;
  let savedNametagA: string;
  let originalBalance: BalanceSnapshot;
  let originalTokenIds: Set<string>;
  let originalTokenAmounts: Map<string, string>;

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
  // Test 1: Create wallet, top up, sync to IPFS
  // ---------------------------------------------------------------------------

  it('creates wallet, receives tokens, and syncs to IPFS', async () => {
    savedNametagA = `e2e-ipfs-${rand()}`;
    dirsA = makeTempDirs('wallet-a');
    cleanupDirs.push(dirsA.base);
    await ensureTrustbase(dirsA.dataDir);

    providersA = makeProviders(dirsA);

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

    // Register IPFS provider
    if (providersA.ipfsTokenStorage) {
      await sphereA.addTokenStorageProvider(providersA.ipfsTokenStorage);
      console.log('  IPFS token storage provider added');
    } else {
      throw new Error('IPFS token storage provider not created — check tokenSync.ipfs.enabled');
    }

    // Request faucet
    console.log(`  Requesting faucet: 1000 SOL to @${savedNametagA}...`);
    const faucetResult = await requestFaucet(savedNametagA, 'solana', 1000);
    console.log(`  Faucet response: ${faucetResult.success ? 'OK' : faucetResult.message}`);

    // Wait for tokens
    console.log('  Waiting for SOL tokens...');
    const bal = await waitForTokens(sphereA, 'SOL', 1n, FAUCET_TOPUP_TIMEOUT_MS);
    console.log(`  Received: total=${bal.total}, tokens=${bal.tokens}`);

    // Record original state
    originalBalance = bal;
    const tokens = sphereA.payments.getTokens({ coinId: undefined });
    const solTokens = tokens.filter((t) => t.symbol === 'SOL');
    originalTokenIds = new Set(solTokens.map((t) => t.id));
    originalTokenAmounts = new Map(solTokens.map((t) => [t.id, t.amount]));

    expect(originalTokenIds.size).toBeGreaterThan(0);
    console.log(`  Recorded ${originalTokenIds.size} SOL token(s)`);

    // Sync to IPFS
    console.log('  Syncing to IPFS...');
    const syncResult = await sphereA.payments.sync();
    console.log(`  Sync result: added=${syncResult.added}, removed=${syncResult.removed}`);

    console.log('[Test 1] PASSED: wallet created, tokens received, synced to IPFS');
  }, 180_000);

  // ---------------------------------------------------------------------------
  // Test 2: Recover tokens from IPFS after local wipe
  // ---------------------------------------------------------------------------

  it('recovers tokens from IPFS after local storage wipe', async () => {
    expect(savedMnemonicA).toBeTruthy();
    expect(originalTokenIds.size).toBeGreaterThan(0);

    // Destroy and wipe
    console.log('\n[Test 2] Destroying wallet A and wiping local storage...');
    await sphereA.destroy();
    spheres.splice(spheres.indexOf(sphereA), 1);
    rmSync(dirsA.base, { recursive: true, force: true });
    expect(existsSync(dirsA.tokensDir)).toBe(false);

    // Wait for IPNS propagation
    console.log(`  Waiting ${IPNS_PROPAGATION_WAIT_MS / 1000}s for IPNS propagation...`);
    await new Promise((r) => setTimeout(r, IPNS_PROPAGATION_WAIT_MS));

    // Fresh dirs + providers
    dirsA = makeTempDirs('wallet-a-recovered');
    cleanupDirs.push(dirsA.base);
    await ensureTrustbase(dirsA.dataDir);
    providersA = makeProviders(dirsA);

    // Import from mnemonic (with nametag to re-mint nametag token for PROXY finalization)
    console.log('  Importing wallet A from mnemonic...');
    sphereA = await Sphere.import({
      ...providersA,
      mnemonic: savedMnemonicA,
      nametag: savedNametagA,
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

    // Retry sync until tokens arrive
    console.log(`  Retrying sync up to ${IPNS_RESOLVE_TIMEOUT_MS / 1000}s...`);
    let syncAdded = 0;
    const start = performance.now();
    while (performance.now() - start < IPNS_RESOLVE_TIMEOUT_MS) {
      try {
        const syncResult = await sphereA.payments.sync();
        syncAdded = syncResult.added;
        if (syncAdded > 0) {
          console.log(`  Sync succeeded: added=${syncAdded}`);
          break;
        }
      } catch (err) {
        console.log(`  Sync attempt failed: ${err instanceof Error ? err.message : err}`);
      }
      console.log('  Retrying in 5s...');
      await new Promise((r) => setTimeout(r, 5000));
    }

    expect(syncAdded).toBeGreaterThan(0);

    // Verify balance
    await sphereA.payments.load();
    const recoveredBalance = getBalance(sphereA, 'SOL');
    console.log(`  Recovered balance: total=${recoveredBalance.total}, tokens=${recoveredBalance.tokens}`);

    expect(recoveredBalance.total).toBe(originalBalance.total);
    expect(recoveredBalance.tokens).toBe(originalBalance.tokens);

    // Verify individual tokens
    const recoveredTokens = sphereA.payments.getTokens().filter((t) => t.symbol === 'SOL');
    const recoveredIds = new Set(recoveredTokens.map((t) => t.id));
    const recoveredAmounts = new Map(recoveredTokens.map((t) => [t.id, t.amount]));

    for (const id of originalTokenIds) {
      expect(recoveredIds.has(id)).toBe(true);
      expect(recoveredAmounts.get(id)).toBe(originalTokenAmounts.get(id));
    }

    console.log('[Test 2] PASSED: all tokens recovered from IPFS with correct amounts');
  }, 180_000);

  // ---------------------------------------------------------------------------
  // Test 3: Spend recovered tokens (proves they are truly usable)
  // ---------------------------------------------------------------------------

  it('spends recovered tokens to another wallet', async () => {
    // Create wallet B as a send target
    const nametagB = `e2e-ipfs-b-${rand()}`;
    const dirsB = makeTempDirs('wallet-b');
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

    const senderBefore = getBalance(sphereA, 'SOL');
    console.log(`  Sender A balance before: total=${senderBefore.total}, tokens=${senderBefore.tokens}`);
    expect(senderBefore.total).toBeGreaterThan(0n);

    // Pick the first token's amount to send (avoids split complexity)
    const solTokens = sphereA.payments.getTokens().filter((t) => t.symbol === 'SOL');
    expect(solTokens.length).toBeGreaterThan(0);
    const firstToken = solTokens[0];
    const sendAmount = firstToken.amount;
    const coinId = firstToken.coinId;
    console.log(`  Sending ${sendAmount} (coinId=${coinId}) to @${nametagB}...`);

    // Send — proves the IPFS-recovered token is genuinely spendable
    const sendResult = await sphereA.payments.send({
      recipient: `@${nametagB}`,
      amount: sendAmount,
      coinId,
    });
    console.log(`  Send status: ${sendResult.status}`);
    expect(sendResult.status).toBe('completed');

    // Verify A's balance decreased (token was spent)
    await sphereA.payments.load();
    const senderAfter = getBalance(sphereA, 'SOL');
    console.log(`  Sender A balance after: total=${senderAfter.total}, tokens=${senderAfter.tokens}`);
    expect(senderAfter.total).toBeLessThan(senderBefore.total);

    console.log('[Test 3] PASSED: IPFS-recovered tokens are spendable (send completed)');
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Test 4: Merge local + IPFS tokens
  // ---------------------------------------------------------------------------

  it('merges locally-received tokens with IPFS-recovered tokens', async () => {
    const nametagC = `e2e-ipfs-c-${rand()}`;

    // --- Step 1: Create wallet C, top up batch 1, sync to IPFS ---
    const dirsC1 = makeTempDirs('wallet-c-batch1');
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

    // Add IPFS
    if (providersC1.ipfsTokenStorage) {
      await sphereC1.addTokenStorageProvider(providersC1.ipfsTokenStorage);
    } else {
      throw new Error('IPFS token storage provider not created');
    }

    // Request batch 1
    console.log('  Requesting batch 1: 1000 SOL...');
    await requestFaucet(nametagC, 'solana', 1000);
    const batch1Bal = await waitForTokens(sphereC1, 'SOL', 1n, FAUCET_TOPUP_TIMEOUT_MS);
    const batch1Total = batch1Bal.total;
    console.log(`  Batch 1 received: total=${batch1Total}, tokens=${batch1Bal.tokens}`);

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
    const dirsC2 = makeTempDirs('wallet-c-batch2');
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

    // Request batch 2 (Nostr replay may also re-deliver batch 1)
    console.log('  Requesting batch 2: 1000 SOL...');
    await requestFaucet(nametagC, 'solana', 1000);

    // Wait for batch 2 to arrive (we need at least some tokens)
    // NOTE: Nostr replay may also re-deliver batch 1 tokens, so pre-sync
    // balance could be 1 token (batch 2 only) or 2 tokens (batch 1 via Nostr + batch 2)
    console.log('  Waiting for batch 2 tokens...');
    const preSyncBal = await waitForTokens(sphereC2, 'SOL', 1n, FAUCET_TOPUP_TIMEOUT_MS);
    console.log(`  Pre-sync balance: total=${preSyncBal.total}, tokens=${preSyncBal.tokens}`);

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
    const mergedBalance = getBalance(sphereC2, 'SOL');
    console.log(`  Merged balance: total=${mergedBalance.total}, tokens=${mergedBalance.tokens}`);

    // After merge, BOTH batches must be present:
    // - No tokens lost during merge (merged >= pre-sync)
    // - At least 2 tokens (one from each batch)
    // - Total at least 2x batch1 (each batch is ~1000 SOL)
    // NOTE: We don't use batch2Total in the assertion because Nostr replay
    // may have already delivered batch 1 locally, inflating pre-sync balance
    expect(mergedBalance.total).toBeGreaterThanOrEqual(preSyncBal.total);
    expect(mergedBalance.total).toBeGreaterThanOrEqual(batch1Total * 2n);
    expect(mergedBalance.tokens).toBeGreaterThanOrEqual(2);

    console.log('[Test 4] PASSED: local + IPFS tokens merged correctly');
  }, 300_000);
});
