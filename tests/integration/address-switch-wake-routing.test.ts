/**
 * Regression (#583, finding #2): wrong-owner WAKE ROUTING on address switch.
 *
 * The wallet-api preset composed ONE shared `WalletApiClient` for the
 * token-storage provider, the delivery provider AND the `walletApi` session,
 * reused across every per-address `PaymentsModule`. `switchToAddress` never
 * quiesced the previous address's module, so its delivery pump's self-healing
 * WAKE SUPERVISOR kept running. After the shared client was re-bound (re-authed)
 * to the NEW owner, the PREVIOUS address's still-live supervisor re-minted a
 * ws-ticket through that shared client and opened a wake socket as the WRONG
 * owner — B's wake stream driving A's module, one leaked socket per address.
 *
 * THE FIX (#583): each HD address binds its OWN identity-bound `WalletApiClient`
 * (delivery + session + token storage) via `createForAddress`. An orphaned
 * previous-address supervisor then re-auths as ITS OWN owner — its socket stays
 * under A, never B. The owner→socket map is exact: one socket per owner.
 *
 * FAILING-FIRST: on the pre-fix shared-client code A's leaked supervisor lands a
 * socket under B (so `socketCount(B) > 1`, or A holds none of its own); with the
 * per-address fix `socketCount(A) === 1 && socketCount(B) === 1`.
 *
 * Real Sphere over the in-process fake wallet-api (real WalletApiClient → real
 * loopback HTTP/WS → fake backend keyed by pubkey + per-owner JWT) — the exact
 * substrate the shared-client staleness leaks through. The wake socket is
 * engine-free (ws-ticket is JWT-authed; no aggregator needed), so the routing
 * defect surfaces without minting. ONE Sphere per file for vitest fork
 * isolation (two wallet-api Spheres in one event loop race on background
 * sign-in/wake — a harness artefact, not the product bug).
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

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-route-test-'));
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
    deviceId: 'wake-route-device',
    // Inject a ws factory with ping/pong hooks so the §9 supervisor opens a
    // real socket against the fake's upgrade handler (node global WebSocket
    // lacks the protocol ping/pong seam the liveness watchdog observes).
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

/** Poll until `pred()` holds or the budget elapses (§9 eventual consistency). */
async function waitUntil(pred: () => boolean, budgetMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (pred()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('address-switch wake routing — per-address client isolation (#583 finding #2)', () => {
  it('after A→B switch, each owner has exactly ONE wake socket — A never opens one as B', { timeout: 30_000 }, async () => {
    const { sphere, fake, dataDir } = await buildSphere();
    cleanups.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    cleanups.push(() => fake.stop());
    cleanups.push(() => sphere.destroy());

    // Address A (index 0) — its delivery pump's wake supervisor opens A's socket.
    await sphere.switchToAddress(0);
    const pubkeyA = sphere.identity!.chainPubkey;
    expect(await waitUntil(() => fake.socketCount(pubkeyA) >= 1)).toBe(true);

    // Switch to address B (index 1). A's module keeps running in the background
    // (per-address architecture: no destroy). Its still-live wake supervisor
    // must NOT re-route onto B's stream.
    await sphere.switchToAddress(1);
    const pubkeyB = sphere.identity!.chainPubkey;
    expect(pubkeyA).not.toBe(pubkeyB);

    // B opens its OWN socket.
    expect(await waitUntil(() => fake.socketCount(pubkeyB) >= 1)).toBe(true);

    // Give any orphaned supervisor ample time to (mis)reconnect; on the pre-fix
    // shared client A's supervisor re-mints a ticket as B and lands a SECOND
    // socket under B. With per-address isolation the owner→socket map stays
    // exact: one each. (Allow a brief overlap window for a reconnect-in-flight,
    // then assert the converged steady state.)
    await new Promise((r) => setTimeout(r, 1_500));

    expect(fake.socketCount(pubkeyB)).toBe(1); // B owns exactly its own socket — no leak from A
    expect(fake.socketCount(pubkeyA)).toBe(1); // A keeps its OWN socket (authed as A), still live in background
  });
});
