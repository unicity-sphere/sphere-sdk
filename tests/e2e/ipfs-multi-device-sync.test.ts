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
 * Test flow (user's requested scenario):
 *   1. Create wallet, receive tokens via Nostr, sync to IPFS
 *   2. ERASE ALL LOCAL DATA, recreate from mnemonic WITHOUT Nostr,
 *      verify tokens recovered exclusively from IPFS
 *   3. Full recovery: erase + recreate with Nostr, verify IPFS + Nostr merge
 *
 * Run with: npm run test:e2e
 */

import { describe, it, expect, afterAll } from 'vitest';
import { Sphere } from '../../core/Sphere';
import { createNodeProviders, type NodeProviders } from '../../impl/nodejs';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TransportProvider } from '../../transport/transport-provider';
import type { ProviderStatus } from '../../types';

// =============================================================================
// Constants
// =============================================================================

const FAUCET_URL = 'https://faucet.unicity.network/api/v1/faucet/request';
const NETWORK = 'testnet' as const;
const TRUSTBASE_URL =
  'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/bft-trustbase.testnet.json';
const DEFAULT_API_KEY = 'sk_06365a9c44654841a366068bcfc68986';

const FAUCET_TOPUP_TIMEOUT_MS = 90_000;
const IPNS_PROPAGATION_WAIT_MS = 10_000;
const IPNS_RESOLVE_TIMEOUT_MS = 90_000;
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
// No-Op Transport (prevents Nostr from bypassing IPFS)
// =============================================================================

/**
 * A transport that does nothing. Used to prove IPFS recovery works
 * independently of Nostr relay replay.
 */
function createNoopTransport(): TransportProvider {
  return {
    id: 'noop-transport',
    name: 'No-Op Transport',
    type: 'p2p' as const,
    description: 'No-op transport for IPFS-only testing',
    setIdentity: () => {},
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => false,
    getStatus: () => 'disconnected' as ProviderStatus,
    sendMessage: async () => '',
    onMessage: () => () => {},
    sendTokenTransfer: async () => '',
    onTokenTransfer: () => () => {},
  };
}

// =============================================================================
// Helpers
// =============================================================================

const rand = () => Math.random().toString(36).slice(2, 8);

function makeTempDirs(label: string) {
  const base = join(
    tmpdir(),
    `sphere-e2e-ipfs-multidev-${label}-${Date.now()}-${rand()}`,
  );
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

function makeProviders(dirs: {
  dataDir: string;
  tokensDir: string;
}): NodeProviders {
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
    const result = (await response.json()) as {
      success: boolean;
      message?: string;
      error?: string;
    };
    return { success: result.success, message: result.message || result.error };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Request failed',
    };
  }
}

function getBalance(sphere: Sphere, symbol: string): BalanceSnapshot {
  const balances = sphere.payments.getBalance();
  const bal = balances.find((b) => b.symbol === symbol);
  if (!bal)
    return { confirmed: 0n, unconfirmed: 0n, total: 0n, tokens: 0 };
  return {
    confirmed: BigInt(bal.confirmedAmount),
    unconfirmed: BigInt(bal.unconfirmedAmount),
    total: BigInt(bal.totalAmount),
    tokens: bal.tokenCount,
  };
}

function getTokenIds(sphere: Sphere, symbol: string): Set<string> {
  const tokens = sphere.payments.getTokens().filter((t) => t.symbol === symbol);
  return new Set(tokens.map((t) => t.id));
}

function getTokenAmounts(sphere: Sphere, symbol: string): Map<string, string> {
  const tokens = sphere.payments.getTokens().filter((t) => t.symbol === symbol);
  return new Map(tokens.map((t) => [t.id, t.amount]));
}

async function waitForTokens(
  sphere: Sphere,
  symbol: string,
  minTotal: bigint,
  timeoutMs: number,
): Promise<BalanceSnapshot> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
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
      `Timed out waiting for ${symbol}: got ${final.total}, needed >= ${minTotal}`,
    );
  }
  return final;
}

/**
 * Retry sync() until tokens appear from IPFS.
 * Returns syncAdded count so callers can ASSERT that IPFS actually delivered tokens.
 */
async function syncUntilTokens(
  sphere: Sphere,
  symbol: string,
  minTotal: bigint,
  timeoutMs: number,
): Promise<{ syncAdded: number; balance: BalanceSnapshot }> {
  const start = performance.now();
  let totalAdded = 0;

  while (performance.now() - start < timeoutMs) {
    try {
      const syncResult = await sphere.payments.sync();
      totalAdded += syncResult.added;
    } catch (err) {
      console.log(
        `  Sync attempt failed: ${err instanceof Error ? err.message : err}`,
      );
    }

    const bal = getBalance(sphere, symbol);
    if (bal.total >= minTotal) {
      return { syncAdded: totalAdded, balance: bal };
    }

    console.log('  Retrying sync in 5s...');
    await new Promise((r) => setTimeout(r, 5000));
  }

  // Final check — if timeout expired with 0 tokens, return what we have
  const finalBal = getBalance(sphere, symbol);
  return { syncAdded: totalAdded, balance: finalBal };
}

// =============================================================================
// Test Suite
// =============================================================================

describe('IPFS Multi-Device Sync E2E', () => {
  // Shared state across ordered tests
  let savedMnemonic: string;
  let savedNametag: string;
  let originalTokenIds: Set<string>;
  let originalTokenAmounts: Map<string, string>;
  let originalBalance: BalanceSnapshot;

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

  it(
    'creates wallet, receives tokens, and syncs to IPFS',
    async () => {
      savedNametag = `e2e-msync-${rand()}`;
      const dirsA = makeTempDirs('device-a');
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

      // Register IPFS provider
      expect(providersA.ipfsTokenStorage).toBeTruthy();
      await sphere.addTokenStorageProvider(providersA.ipfsTokenStorage!);
      console.log('  IPFS token storage provider added');

      // Request faucet
      console.log(`  Requesting faucet: 100 UCT to @${savedNametag}...`);
      const faucetResult = await requestFaucet(savedNametag, 'unicity', 100);
      console.log(
        `  Faucet: ${faucetResult.success ? 'OK' : faucetResult.message}`,
      );

      // Wait for tokens via Nostr
      console.log('  Waiting for UCT tokens...');
      originalBalance = await waitForTokens(
        sphere,
        'UCT',
        1n,
        FAUCET_TOPUP_TIMEOUT_MS,
      );
      console.log(
        `  Received: total=${originalBalance.total}, tokens=${originalBalance.tokens}`,
      );
      expect(originalBalance.total).toBeGreaterThan(0n);

      // Record original inventory
      originalTokenIds = getTokenIds(sphere, 'UCT');
      originalTokenAmounts = getTokenAmounts(sphere, 'UCT');
      expect(originalTokenIds.size).toBeGreaterThan(0);
      console.log(`  Recorded ${originalTokenIds.size} UCT token(s)`);

      // Sync to IPFS
      console.log('  Syncing to IPFS...');
      const syncResult = await sphere.payments.sync();
      console.log(
        `  Sync: added=${syncResult.added}, removed=${syncResult.removed}`,
      );

      // Verify tokens survived the sync round-trip
      const postSync = getBalance(sphere, 'UCT');
      expect(postSync.total).toBe(originalBalance.total);
      expect(postSync.tokens).toBe(originalBalance.tokens);

      // Destroy the sphere — we're done with this instance
      await sphere.destroy();
      spheres.splice(spheres.indexOf(sphere), 1);

      console.log('[Test 1] PASSED: tokens received and synced to IPFS');
    },
    180_000,
  );

  // ---------------------------------------------------------------------------
  // Test 2: ERASE all local data → recreate from mnemonic → recover from IPFS
  //         Uses NO-OP TRANSPORT to prove IPFS is the sole source of tokens
  // ---------------------------------------------------------------------------

  it(
    'erases local data, recreates from mnemonic, recovers tokens ONLY from IPFS',
    async () => {
      expect(savedMnemonic).toBeTruthy();
      expect(originalTokenIds.size).toBeGreaterThan(0);

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
      // This is the key: tokens can ONLY come from IPFS sync, not Nostr replay
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

      // CRITICAL ASSERTION: before sync, wallet must have ZERO tokens
      // This proves Nostr didn't deliver anything (no-op transport)
      const preSyncBal = getBalance(sphereRecovery, 'UCT');
      console.log(
        `  Pre-sync balance: total=${preSyncBal.total}, tokens=${preSyncBal.tokens}`,
      );
      expect(preSyncBal.total).toBe(0n);
      expect(preSyncBal.tokens).toBe(0);

      // Sync from IPFS — this is the ONLY way to get tokens
      console.log('  Syncing from IPFS (this is the only token source)...');
      const { syncAdded, balance: postSyncBal } = await syncUntilTokens(
        sphereRecovery,
        'UCT',
        1n,
        IPNS_RESOLVE_TIMEOUT_MS,
      );

      console.log(
        `  Post-sync: total=${postSyncBal.total}, tokens=${postSyncBal.tokens}, syncAdded=${syncAdded}`,
      );

      // CRITICAL ASSERTION: sync must have actually added tokens
      expect(syncAdded).toBeGreaterThan(0);

      // Verify balance matches original
      expect(postSyncBal.total).toBe(originalBalance.total);
      expect(postSyncBal.tokens).toBe(originalBalance.tokens);

      // Verify exact token IDs and amounts match
      const recoveredIds = getTokenIds(sphereRecovery, 'UCT');
      const recoveredAmounts = getTokenAmounts(sphereRecovery, 'UCT');

      expect(recoveredIds.size).toBe(originalTokenIds.size);
      for (const id of originalTokenIds) {
        expect(recoveredIds.has(id)).toBe(true);
        expect(recoveredAmounts.get(id)).toBe(originalTokenAmounts.get(id));
      }

      // Cleanup this sphere
      await sphereRecovery.destroy();
      spheres.splice(spheres.indexOf(sphereRecovery), 1);

      console.log(
        `[Test 2] PASSED: recovered ${recoveredIds.size} tokens exclusively from IPFS (no Nostr)`,
      );
    },
    180_000,
  );

  // ---------------------------------------------------------------------------
  // Test 3: Full recovery with Nostr — erase, reimport, verify IPFS + Nostr
  //         Proves the real-world recovery flow works end-to-end
  // ---------------------------------------------------------------------------

  it(
    'full recovery: erase local data, reimport with Nostr, sync from IPFS',
    async () => {
      expect(savedMnemonic).toBeTruthy();
      expect(originalTokenIds.size).toBeGreaterThan(0);

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

      // Sync from IPFS
      console.log('  Syncing from IPFS...');
      const { syncAdded, balance: syncedBal } = await syncUntilTokens(
        sphereFull,
        'UCT',
        1n,
        IPNS_RESOLVE_TIMEOUT_MS,
      );
      console.log(
        `  Synced: total=${syncedBal.total}, tokens=${syncedBal.tokens}, syncAdded=${syncAdded}`,
      );

      // Also try Nostr receive for any additional tokens
      try {
        await sphereFull.payments.receive();
      } catch {
        // May throw if no pending events
      }

      const finalBal = getBalance(sphereFull, 'UCT');
      console.log(
        `  Final balance: total=${finalBal.total}, tokens=${finalBal.tokens}`,
      );

      // Balance must be at least what we had originally
      // (could be more if Nostr replayed additional tokens)
      expect(finalBal.total).toBeGreaterThanOrEqual(originalBalance.total);

      // Verify all original token IDs are present
      const recoveredIds = getTokenIds(sphereFull, 'UCT');
      for (const id of originalTokenIds) {
        expect(recoveredIds.has(id)).toBe(true);
      }

      console.log(
        `[Test 3] PASSED: full recovery with ${recoveredIds.size} tokens (IPFS + Nostr)`,
      );
    },
    180_000,
  );
});
