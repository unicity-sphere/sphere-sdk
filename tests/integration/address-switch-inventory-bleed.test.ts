/**
 * Regression: address-switch inventory bleed (sphere-sdk#580).
 *
 * One HD wallet, two addresses: index 0 HAS assets in its wallet-api inventory,
 * index 1 is EMPTY. The owner reported (reproduced multiple times in the app):
 *
 *   1. select index 1 -> refresh -> EMPTY (correct)
 *   2. switch to index 0 -> EMPTY (WRONG: it has assets)
 *   3. switch back to index 1 -> shows index 0 ASSETS (WRONG: it is empty)
 *
 * The inventory view is "one address behind" — each address renders the
 * PREVIOUSLY-selected address's inventory. Assets bleed across addresses
 * (a balance/correctness hazard).
 *
 * Root cause: the wallet-api `WalletApiClient` is a SINGLE shared instance
 * (composition.ts) wired into the token-storage provider, the delivery provider
 * AND the `walletApi` session. It holds ONE mutable identity+jwt, so inventory
 * reads return whatever owner it is currently authenticated as. On a re-visit
 * `switchToAddress` whose nametag is unchanged (both addresses here have none),
 * `Sphere` swaps the active module pointer WITHOUT re-running
 * `PaymentsModule.initialize` — so `delivery.setIdentity()` (the only thing that
 * calls `client.setIdentity()`) never fires, and the shared client keeps the
 * last address's identity. `load()` then queries the wrong owner.
 *
 * This is a REAL Sphere driven against the in-process fake wallet-api over
 * loopback HTTP (real WalletApiClient -> real HTTP -> fake backend keyed by
 * pubkey + per-owner JWT) — the exact substrate the shared-client staleness
 * leaks through. No aggregator/Docker: the lazy inventory VIEW renders balances
 * with zero blob downloads, so the bleed shows up without minting.
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

// A fixed 12-word mnemonic so address indices 0/1 derive deterministically.
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

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bleed-test-'));
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
    deviceId: 'bleed-test-device',
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

describe('address-switch inventory bleed (#580)', () => {
  // Real loopback HTTP + per-switch auth round-trips: give the whole sequence
  // headroom over the 10s default so heavy parallel suite load can't time it out
  // (it runs in ~5s alone; the budget is slack, not a hot path).
  it('each address renders ITS OWN wallet-api inventory across re-visit switches', { timeout: 30_000 }, async () => {
    const { sphere, fake, dataDir } = await buildSphere();
    cleanups.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    cleanups.push(() => fake.stop());
    cleanups.push(() => sphere.destroy());

    // Capture the chain pubkeys of index 0 (has assets) and index 1 (empty).
    await sphere.switchToAddress(0);
    const pubkey0 = sphere.identity!.chainPubkey;
    await sphere.switchToAddress(1);
    const pubkey1 = sphere.identity!.chainPubkey;
    expect(pubkey0).not.toBe(pubkey1);

    // Seed index 0's server inventory with assets; index 1 stays empty.
    const token = makeTestToken({ amount: 5000n });
    fake.seedInventory(pubkey0, [
      { tokenId: token.tokenId, assets: [{ coinId: token.coinId, amount: token.amount }], blob: token.bytes },
    ]);
    const COIN = token.coinId;

    // The owner's exact sequence:
    // 1. select index 1 -> refresh -> EMPTY (correct)
    await sphere.switchToAddress(1);
    await refresh(sphere);
    expect(balanceTotal(sphere, COIN)).toBe(0n);

    // 2. switch to index 0 -> refresh -> MUST show index 0's assets
    await sphere.switchToAddress(0);
    await refresh(sphere);
    expect(balanceTotal(sphere, COIN)).toBe(5000n);

    // 3. switch back to index 1 -> refresh -> MUST be empty (no bleed)
    await sphere.switchToAddress(1);
    await refresh(sphere);
    expect(balanceTotal(sphere, COIN)).toBe(0n);
  });
});
