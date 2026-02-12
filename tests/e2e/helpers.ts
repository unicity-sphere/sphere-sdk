/**
 * Shared helpers for E2E tests.
 *
 * Extracted from ipfs-multi-device-sync.test.ts and ipfs-token-persistence.test.ts
 * to avoid duplicating multi-coin logic across test files.
 */

import { Sphere } from '../../core/Sphere';
import { createNodeProviders, type NodeProviders } from '../../impl/nodejs';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TransportProvider } from '../../transport/transport-provider';
import type { ProviderStatus } from '../../types';

// =============================================================================
// Constants
// =============================================================================

export const FAUCET_URL = 'https://faucet.unicity.network/api/v1/faucet/request';
export const NETWORK = 'testnet' as const;
export const TRUSTBASE_URL =
  'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/bft-trustbase.testnet.json';
export const DEFAULT_API_KEY = 'sk_06365a9c44654841a366068bcfc68986';

export const FAUCET_TOPUP_TIMEOUT_MS = 90_000;
export const IPNS_PROPAGATION_WAIT_MS = 10_000;
export const IPNS_RESOLVE_TIMEOUT_MS = 90_000;
export const POLL_INTERVAL_MS = 1_000;

/**
 * Coins to faucet in multi-coin tests.
 * SOL (decimals: 9) + ETH (decimals: 18) — different decimals maximizes coverage.
 */
export const TEST_COINS = [
  { faucetName: 'solana', symbol: 'SOL', amount: 1000 },
  { faucetName: 'ethereum', symbol: 'ETH', amount: 42 },
] as const;

// =============================================================================
// Types
// =============================================================================

export interface BalanceSnapshot {
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
export function createNoopTransport(): TransportProvider {
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

export const rand = () => Math.random().toString(36).slice(2, 8);

export function makeTempDirs(label: string) {
  const base = join(
    tmpdir(),
    `sphere-e2e-${label}-${Date.now()}-${rand()}`,
  );
  const dataDir = join(base, 'data');
  const tokensDir = join(base, 'tokens');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(tokensDir, { recursive: true });
  return { base, dataDir, tokensDir };
}

export async function ensureTrustbase(dataDir: string): Promise<void> {
  const trustbasePath = join(dataDir, 'trustbase.json');
  if (existsSync(trustbasePath)) return;

  const res = await fetch(TRUSTBASE_URL);
  if (!res.ok) {
    throw new Error(`Failed to download trustbase: ${res.status}`);
  }
  const data = await res.text();
  writeFileSync(trustbasePath, data);
}

export function makeProviders(dirs: {
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

// =============================================================================
// Faucet
// =============================================================================

export async function requestFaucet(
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

/**
 * Request faucet for all TEST_COINS with 500ms stagger between requests.
 */
export async function requestMultiCoinFaucet(nametag: string): Promise<void> {
  for (const coin of TEST_COINS) {
    const result = await requestFaucet(nametag, coin.faucetName, coin.amount);
    console.log(`  Faucet ${coin.symbol}: ${result.success ? 'OK' : result.message}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

// =============================================================================
// Balance
// =============================================================================

export function getBalance(sphere: Sphere, symbol: string): BalanceSnapshot {
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

export function getTokenIds(sphere: Sphere, symbol: string): Set<string> {
  const tokens = sphere.payments.getTokens().filter((t) => t.symbol === symbol);
  return new Set(tokens.map((t) => t.id));
}

export function getTokenAmounts(sphere: Sphere, symbol: string): Map<string, string> {
  const tokens = sphere.payments.getTokens().filter((t) => t.symbol === symbol);
  return new Map(tokens.map((t) => [t.id, t.amount]));
}

// =============================================================================
// Polling
// =============================================================================

/**
 * Poll receive() until a single coin's balance reaches minTotal.
 */
export async function waitForTokens(
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
 * Poll receive() until ALL TEST_COINS have non-zero balance.
 * Returns a Map<symbol, BalanceSnapshot>.
 */
export async function waitForAllCoins(
  sphere: Sphere,
  timeoutMs: number,
): Promise<Map<string, BalanceSnapshot>> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    try {
      await sphere.payments.receive();
    } catch {
      // receive() may throw if transport doesn't support fetchPendingEvents
    }

    const balances = new Map<string, BalanceSnapshot>();
    let allReady = true;
    for (const coin of TEST_COINS) {
      const bal = getBalance(sphere, coin.symbol);
      balances.set(coin.symbol, bal);
      if (bal.total <= 0n) allReady = false;
    }
    if (allReady) return balances;

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Final check
  const balances = new Map<string, BalanceSnapshot>();
  const missing: string[] = [];
  for (const coin of TEST_COINS) {
    const bal = getBalance(sphere, coin.symbol);
    balances.set(coin.symbol, bal);
    if (bal.total <= 0n) missing.push(coin.symbol);
  }
  if (missing.length > 0) {
    throw new Error(
      `Timed out waiting for coins: ${missing.join(', ')} still at 0`,
    );
  }
  return balances;
}

// =============================================================================
// Sync
// =============================================================================

/**
 * Retry sync() until tokens appear from IPFS for a single coin.
 * Returns syncAdded count so callers can ASSERT that IPFS actually delivered tokens.
 */
export async function syncUntilTokens(
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

  const finalBal = getBalance(sphere, symbol);
  return { syncAdded: totalAdded, balance: finalBal };
}

/**
 * Retry sync() until ALL TEST_COINS have balance >= minTotal.
 * Returns syncAdded count and per-coin balances.
 */
export async function syncUntilAllCoins(
  sphere: Sphere,
  minTotal: bigint,
  timeoutMs: number,
): Promise<{ syncAdded: number; balances: Map<string, BalanceSnapshot> }> {
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

    const balances = new Map<string, BalanceSnapshot>();
    let allReady = true;
    for (const coin of TEST_COINS) {
      const bal = getBalance(sphere, coin.symbol);
      balances.set(coin.symbol, bal);
      if (bal.total < minTotal) allReady = false;
    }
    if (allReady) {
      return { syncAdded: totalAdded, balances };
    }

    console.log('  Retrying sync in 5s...');
    await new Promise((r) => setTimeout(r, 5000));
  }

  // Final snapshot
  const balances = new Map<string, BalanceSnapshot>();
  for (const coin of TEST_COINS) {
    balances.set(coin.symbol, getBalance(sphere, coin.symbol));
  }
  return { syncAdded: totalAdded, balances };
}
