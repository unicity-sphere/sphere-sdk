/**
 * Regression: address-switch inventory bleed on the FIRST-VISIT path
 * (sphere-sdk#580 review follow-up).
 *
 * Companion to `address-switch-inventory-bleed.test.ts`, which covers the
 * RE-VISIT path (switching back to an already-created address module). This
 * file covers the OTHER half the #580 fix missed: the FIRST-EVER switch to an
 * index, which CREATES that index's per-address module.
 *
 * In `Sphere.switchToAddress`, first-visit creates each per-address token-
 * storage provider through a `createForAddress` loop. `WalletApiTokenStorage-
 * Provider` has `requiresWalletApi = true` and does NOT implement
 * `createForAddress`, so it hits the fallback that REUSES the single shared
 * instance. That instance is still bound to the PREVIOUSLY-active address: its
 * inventory VIEW (read via the shared `WalletApiClient`'s identity+JWT) and the
 * `_meta.address` its `load()` stamps both belong to the previous address.
 *
 * Without re-binding it (`provider.setIdentity(newIdentity)` in the fallback),
 * a first-time switch to a new index serves the previous address's owner:
 * `PaymentsModule.load()`'s address guard sees `_meta.address != current` and
 * REJECTS the whole provider, so the new address renders EMPTY even though it
 * has its OWN assets — the inventory bleed, surfaced on first visit.
 * `PaymentsModule.initialize` re-binds only the DELIVERY provider, never the
 * token-storage providers, so nothing else covers this.
 *
 * A SEPARATE FILE on purpose: vitest's default `forks` pool runs each file in
 * its own process, so the single Sphere here cannot contend with the re-visit
 * file's Sphere (two wallet-api Spheres sharing one event loop race on
 * background sign-in/wake activity — a harness artefact, not the product bug).
 * One Sphere per process keeps the assertion deterministic.
 *
 * Real Sphere over the in-process fake wallet-api (real WalletApiClient -> real
 * loopback HTTP -> fake backend keyed by pubkey + per-owner JWT) — the exact
 * substrate the shared-client staleness leaks through. The lazy inventory VIEW
 * renders balances with zero blob downloads, so the bleed shows without minting.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, afterEach, vi } from 'vitest';

import { Sphere } from '../../core/Sphere';
import { FileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import { createWalletApiProviders, type SphereBaseProviders } from '../../impl/shared/wallet-api';
import { FakeWalletApi } from '../support/fake-wallet-api';
import { makeTestToken } from '../support/wallet-api-test-helpers';
import type { TransportProvider, OracleProvider } from '../../index';
import type { ProviderStatus } from '../../types';
import type { TokenStorageProvider, TxfStorageDataBase } from '../../storage';

// A fixed 12-word mnemonic so address indices derive deterministically.
const MNEMONIC = 'test test test test test test test test test test test junk';

function createMockTransport(): TransportProvider {
  return {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
    description: 'Mock transport',
    setIdentity: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    sendMessage: vi.fn().mockResolvedValue('event-id'),
    onMessage: vi.fn().mockReturnValue(() => {}),
    sendTokenTransfer: vi.fn().mockResolvedValue('transfer-id'),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    sendPaymentRequest: vi.fn().mockResolvedValue('request-id'),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    sendPaymentRequestResponse: vi.fn().mockResolvedValue('response-id'),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    subscribeToBroadcast: vi.fn().mockReturnValue(() => {}),
    publishBroadcast: vi.fn().mockResolvedValue('broadcast-id'),
    onEvent: vi.fn().mockReturnValue(() => {}),
    resolveNametag: vi.fn().mockResolvedValue(null),
    publishIdentityBinding: vi.fn().mockResolvedValue(true),
    recoverNametag: vi.fn().mockResolvedValue(null),
  } as unknown as TransportProvider;
}

/** Mock oracle WITHOUT a trust base/url — Sphere falls back to the legacy
 *  (no-engine) path; the lazy inventory view never needs the engine. */
function createMockOracle(): OracleProvider {
  return {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'aggregator' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    initialize: vi.fn().mockResolvedValue(undefined),
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
  } as unknown as OracleProvider;
}

interface Built {
  sphere: Sphere;
  fake: FakeWalletApi;
  dataDir: string;
}

async function buildSphere(): Promise<Built> {
  const fake = new FakeWalletApi();
  const baseUrl = await fake.start();

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bleed-fv-test-'));
  const storage = new FileStorageProvider({ dataDir });
  const base: SphereBaseProviders = {
    storage,
    transport: createMockTransport(),
    oracle: createMockOracle(),
    // unused: the wallet-api preset overrides tokenStorage with its own.
    tokenStorage: null as unknown as TokenStorageProvider<TxfStorageDataBase>,
  };
  const providers = createWalletApiProviders(base, {
    baseUrl,
    network: fake.network,
    deviceId: 'bleed-fv-test-device',
  });

  const { sphere } = await Sphere.init({
    storage,
    transport: providers.transport,
    oracle: providers.oracle,
    tokenStorage: providers.tokenStorage,
    delivery: providers.delivery,
    walletApi: providers.walletApi,
    network: 'testnet2',
    mnemonic: MNEMONIC,
  });

  return { sphere, fake, dataDir };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  (Sphere as unknown as { instance: null }).instance = null;
});

/** The app's "refresh": converge the active address's inventory from the server. */
async function refresh(sphere: Sphere): Promise<void> {
  await sphere.payments.load();
}

function balanceTotal(sphere: Sphere, coinId: string): bigint {
  return sphere.payments
    .getTokens()
    .filter((t) => t.coinId === coinId)
    .reduce((sum, t) => sum + BigInt(t.amount), 0n);
}

/**
 * Refresh until the active address's balance for `coinId` converges to
 * `expected`, or fail after the budget. The wallet-api inventory is an
 * EVENTUALLY-consistent server view (ARCHITECTURE §9: the poll is the
 * correctness path), so the wallet's contract is convergence — not a single
 * snapshot. The first `load()` right after a switch can race the still-settling
 * sign-in; one or two more converge it. The bug is NOT a slow-converge: a
 * mis-bound provider converges to the WRONG owner (the address guard rejects
 * the stale data forever), so this poll never reaches `expected` and times out
 * — exactly the failing-first signal. A correct rebind converges promptly.
 */
async function refreshUntilBalance(
  sphere: Sphere,
  coinId: string,
  expected: bigint,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  let last = -1n;
  for (;;) {
    await refresh(sphere);
    last = balanceTotal(sphere, coinId);
    if (last === expected) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `balance for ${coinId.slice(0, 8)}… did not converge to ${expected} (last=${last})`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('address-switch inventory bleed — first-visit path (#580)', () => {
  // Real loopback HTTP + per-switch auth round-trips: headroom over the 10s
  // default so heavy parallel suite load can't time it out.
  it('a FIRST-VISIT switch to a new index renders ITS OWN inventory, not the previous address\'s', { timeout: 30_000 }, async () => {
    const { sphere, fake, dataDir } = await buildSphere();
    cleanups.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    cleanups.push(() => fake.stop());
    cleanups.push(() => sphere.destroy());

    // Index 5 is deliberately far from any index boot/this test has touched, so
    // its switch is a genuine first-visit. Derive pubkeys WITHOUT visiting it
    // (deriveAddress activates no module), keeping index 5 first-visited.
    const FRESH = 5;
    const pubkey0 = sphere.deriveAddress(0).publicKey;
    const pubkeyFresh = sphere.deriveAddress(FRESH).publicKey;
    expect(pubkey0).not.toBe(pubkeyFresh);

    // Distinct coins per address so a bleed is unambiguous: index 0 holds COIN0
    // (5000), the fresh index holds COINF (its own, smaller balance of 7).
    const t0 = makeTestToken({ amount: 5000n, coinId: 'a0'.repeat(32) });
    const tFresh = makeTestToken({ amount: 7n, coinId: 'b0'.repeat(32) });
    expect(t0.coinId).not.toBe(tFresh.coinId);
    fake.seedInventory(pubkey0, [
      { tokenId: t0.tokenId, assets: [{ coinId: t0.coinId, amount: t0.amount }], blob: t0.bytes },
    ]);
    fake.seedInventory(pubkeyFresh, [
      { tokenId: tFresh.tokenId, assets: [{ coinId: tFresh.coinId, amount: tFresh.amount }], blob: tFresh.bytes },
    ]);

    // Make index 0 the active address holding its assets — the owner the shared
    // provider's view+identity are bound to right before the first-visit switch.
    await sphere.switchToAddress(0);
    await refreshUntilBalance(sphere, t0.coinId, 5000n);

    // Precondition: the fresh index's per-address module must NOT exist yet, so
    // its switch genuinely takes the first-visit `!_addressModules.has(index)`
    // branch (the createForAddress fallback) — NOT the re-visit branch.
    const addressModules = (sphere as unknown as { _addressModules: Map<number, unknown> })._addressModules;
    expect(addressModules.has(FRESH)).toBe(false);

    // FIRST-EVER switch to the fresh index -> the createForAddress fallback
    // reuses the shared, still-index-0-bound provider.
    await sphere.switchToAddress(FRESH);
    expect(addressModules.has(FRESH)).toBe(true); // the switch did create the module

    // It MUST render the fresh index's OWN balance (7). Without the fallback
    // rebind the stale provider serves index 0, the address guard rejects it,
    // and the fresh balance never converges off 0 — this call then times out
    // (the failing-first signal). With the rebind it converges to 7.
    await refreshUntilBalance(sphere, tFresh.coinId, 7n);

    // And NONE of index 0's coin may bleed into the fresh address.
    expect(balanceTotal(sphere, t0.coinId)).toBe(0n);
  });
});
