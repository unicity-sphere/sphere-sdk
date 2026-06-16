/**
 * Regression (#583, finding #4 + the structural root): cross-owner SPEND
 * corruption via a shared wallet-api session on address switch.
 *
 * `startWalletApiSession` fires an un-awaited `resumeOpenIntents()` (E.3) at
 * sign-in. On the shared-client design that resume ran on the ONE shared
 * `walletApi` client. If an address switch re-bound that client to the NEW owner
 * B while A's resume was still in flight, A's `applyDelta` (whose §16 body
 * carries NO owner pubkey — it is authed purely by the bearer JWT) landed under
 * B's JWT: A's spend written into B's inventory — silent cross-owner corruption.
 *
 * THE FIX (#583): each HD address binds its OWN identity-bound `walletApi`
 * session (the SAME client backing its delivery provider). A's resume runs on
 * A's client (A's JWT); it can NEVER write under B's JWT, because A's session is
 * a DIFFERENT client object that authenticates as A. The whole race is removed
 * structurally — there is no shared mutable session to re-bind mid-resume.
 *
 * This test asserts that structural property at the Sphere level (the exact
 * mechanism that disarms finding #4, which cannot be deterministically RACED in
 * the fake harness without a real engine to drive a spend through resume — the
 * Sphere per-address modules build the real engine from the oracle trust base):
 *
 *  1. each per-address module set holds its OWN delivery + walletApi instances
 *     (distinct objects across A and B) — pre-fix they were the ONE shared pair;
 *  2. the Sphere-level active `_walletApi` reference tracks the ACTIVE address
 *     (so `walletApiSessionStatus` is the active owner's session state);
 *  3. each address's session is observably bound to its OWN owner — A's session
 *     opens a wake socket under A and B's under B (the server witnesses the
 *     authenticated pubkey of each client), so a resume on A's session acts as
 *     A and never as B.
 *
 * Real Sphere over the in-process fake wallet-api. ONE Sphere per file (fork
 * isolation). Owner-binding is engine-free (JWT-authed ws-ticket), so it
 * surfaces without minting.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, afterEach, vi } from 'vitest';

import { Sphere } from '../../core/Sphere';
import { FileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import { createWalletApiProviders, type SphereBaseProviders } from '../../impl/shared/wallet-api';
import { FakeWalletApi } from '../support/fake-wallet-api';
import { wsLikeWithPing } from '../support/wallet-api-test-helpers';
import type { TransportProvider, OracleProvider } from '../../index';
import type { ProviderStatus } from '../../types';
import type { TokenStorageProvider, TxfStorageDataBase } from '../../storage';

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

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-iso-test-'));
  const storage = new FileStorageProvider({ dataDir });
  const base: SphereBaseProviders = {
    storage,
    transport: createMockTransport(),
    oracle: createMockOracle(),
    tokenStorage: null as unknown as TokenStorageProvider<TxfStorageDataBase>,
  };
  const providers = createWalletApiProviders(base, {
    baseUrl,
    network: fake.network,
    deviceId: 'session-iso-device',
    webSocketFactory: (url: string) => wsLikeWithPing(url),
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

async function waitUntil(pred: () => boolean, budgetMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (pred()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface ModuleSet {
  delivery: unknown;
  walletApi: unknown;
}

describe('address-switch session isolation — per-address wallet-api client (#583 finding #4 + root)', () => {
  it('each address has its OWN delivery + walletApi session, bound to its OWN owner; the active reference tracks the active address', { timeout: 30_000 }, async () => {
    const { sphere, fake, dataDir } = await buildSphere();
    cleanups.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    cleanups.push(() => fake.stop());
    cleanups.push(() => sphere.destroy());

    await sphere.switchToAddress(0);
    const pubkeyA = sphere.identity!.chainPubkey;
    await sphere.switchToAddress(1);
    const pubkeyB = sphere.identity!.chainPubkey;
    expect(pubkeyA).not.toBe(pubkeyB);

    const modules = (sphere as unknown as { _addressModules: Map<number, ModuleSet> })._addressModules;
    const setA = modules.get(0)!;
    const setB = modules.get(1)!;

    // (1) STRUCTURAL: A and B hold DISTINCT delivery + walletApi instances. On
    // the pre-fix shared-client design both sets pointed at the ONE composed
    // delivery/session pair (identical references) — the shared mutable session
    // a mid-resume switch could re-bind under the wrong owner.
    expect(setA.walletApi).toBeDefined();
    expect(setB.walletApi).toBeDefined();
    expect(setA.walletApi).not.toBe(setB.walletApi);
    expect(setA.delivery).not.toBe(setB.delivery);
    // Each address's session IS the client backing its OWN delivery provider
    // (one identity-bound client per address — not three siblings).
    expect((setA.delivery as { walletApiClient?: unknown }).walletApiClient).toBe(setA.walletApi);
    expect((setB.delivery as { walletApiClient?: unknown }).walletApiClient).toBe(setB.walletApi);

    // (2) The Sphere-level active reference tracks the ACTIVE address (B now).
    const activeWalletApi = (sphere as unknown as { _walletApi: unknown })._walletApi;
    expect(activeWalletApi).toBe(setB.walletApi);
    expect(sphere.walletApiSessionStatus).not.toBeNull(); // a session was attempted for the active owner

    // (3) BEHAVIORAL owner-binding: each session authenticates as its OWN owner.
    // Both modules keep running (per-address architecture), each opening a wake
    // socket through its own client — the server witnesses the authenticated
    // pubkey of each. A resume on A's session therefore acts as A, never B.
    expect(await waitUntil(() => fake.socketCount(pubkeyA) >= 1 && fake.socketCount(pubkeyB) >= 1)).toBe(true);
    // Let any reconnect settle, then assert the exact owner→socket map: one
    // each — A's session never authenticated as B (which #4's cross-owner write
    // required).
    await new Promise((r) => setTimeout(r, 1_000));
    expect(fake.socketCount(pubkeyA)).toBe(1);
    expect(fake.socketCount(pubkeyB)).toBe(1);
  });
});
