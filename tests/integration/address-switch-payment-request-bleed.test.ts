/**
 * Regression (#583, finding #3): payment-request BLEED on address switch.
 *
 * The wallet-api preset composed ONE shared `WalletApiClient` reused across
 * every per-address `PaymentsModule`. `switchToAddress` never quiesced the
 * previous address's module, so its payment-request poll pump kept running.
 * After the shared client was re-bound (re-authed) to the NEW owner B, the
 * PREVIOUS address A's still-live PR pump pulled B's incoming `?since=` stream
 * through that shared client — surfacing the NEW owner's incoming payment
 * requests into the OLD module's view (no `toPubkey` owner guard) AND advancing
 * A's persisted PR cursor over B's entries (poisoning it).
 *
 * THE FIX (#583): each HD address binds its OWN identity-bound client; an
 * orphaned previous-address PR pump runs against ITS OWN owner's stream (sees
 * nothing of B's). A defense-in-depth `toPubkey !== owner` guard in
 * `surfaceIncomingPaymentRequest` backstops any residual shared state.
 *
 * FAILING-FIRST: a requester creates a PR addressed to B. With the per-address
 * fix it surfaces in B's module ONLY; on the pre-fix shared-client code the
 * orphaned A-module's pump surfaces it too (A's `getPaymentRequests()` is
 * non-empty — the bleed).
 *
 * Real Sphere over the in-process fake wallet-api. The PR pump is engine-free
 * (it maps the §16 wire — no aggregator), so the bleed surfaces without minting.
 * ONE Sphere per file for vitest fork isolation.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, afterEach, vi } from 'vitest';

import { Sphere } from '../../core/Sphere';
import { FileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import { createWalletApiProviders, type SphereBaseProviders } from '../../impl/shared/wallet-api';
import { WalletApiClient } from '../../wallet-api';
import { FakeWalletApi } from '../support/fake-wallet-api';
import { MemoryKeyValueStore } from '../support/wallet-api-test-helpers';
import { getPublicKey } from '../../core/crypto';
import type { PaymentsModule } from '../../modules/payments/PaymentsModule';
import type { TransportProvider, OracleProvider } from '../../index';
import type { ProviderStatus } from '../../types';
import type { TokenStorageProvider, TxfStorageDataBase } from '../../storage';

const MNEMONIC = 'test test test test test test test test test test test junk';
const UCT = 'c0'.repeat(32);

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
  baseUrl: string;
  dataDir: string;
}

async function buildSphere(): Promise<Built> {
  const fake = new FakeWalletApi();
  const baseUrl = await fake.start();

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-bleed-test-'));
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
    deviceId: 'pr-bleed-device',
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

  return { sphere, fake, baseUrl, dataDir };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  (Sphere as unknown as { instance: null }).instance = null;
});

/** A standalone "requester" wallet that creates a payment request addressed to a payer. */
async function createPaymentRequestTo(
  baseUrl: string,
  network: string,
  payerPubkey: string,
): Promise<string> {
  const requesterPriv = 'd1'.repeat(32);
  const requesterPub = getPublicKey(requesterPriv);
  const client = new WalletApiClient({
    baseUrl,
    network,
    deviceId: 'requester-device',
    storage: new MemoryKeyValueStore(),
  });
  client.setIdentity({ privateKey: requesterPriv, chainPubkey: requesterPub });
  const record = await client.createPaymentRequest({
    toPubkey: payerPubkey,
    assets: [{ coinId: UCT, amount: 42n }],
  });
  return record.id;
}

describe('address-switch payment-request bleed — per-address client isolation (#583 finding #3)', () => {
  it('a PR addressed to B surfaces in B only — A\'s orphaned module never bleeds it in', { timeout: 30_000 }, async () => {
    const { sphere, fake, baseUrl, dataDir } = await buildSphere();
    cleanups.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    cleanups.push(() => fake.stop());
    cleanups.push(() => sphere.destroy());

    // Activate A (index 0) and B (index 1).
    await sphere.switchToAddress(0);
    const pubkeyA = sphere.identity!.chainPubkey;
    await sphere.switchToAddress(1);
    const pubkeyB = sphere.identity!.chainPubkey;
    expect(pubkeyA).not.toBe(pubkeyB);

    // A requester creates a payment request addressed to B (the now-active owner).
    const prId = await createPaymentRequestTo(baseUrl, fake.network, pubkeyB);

    // The orphaned previous-address module (A) and the active module (B).
    const modules = (sphere as unknown as {
      _addressModules: Map<number, { payments: PaymentsModule }>;
    })._addressModules;
    const aPayments = modules.get(0)!.payments;
    const bPayments = modules.get(1)!.payments;

    // Force BOTH modules to pump their payment-request streams now (what the 30s
    // poll / a wake nudge would otherwise do in the background). On the pre-fix
    // shared client A's pump pulls B's incoming stream through the rebound
    // client and surfaces the PR; with per-address isolation A pulls its OWN
    // (empty) stream.
    await bPayments.syncPaymentRequests();
    await aPayments.syncPaymentRequests();

    // B sees its incoming request…
    const bRequests = bPayments.getPaymentRequests();
    expect(bRequests.map((r) => r.id)).toContain(prId);

    // …and A must NOT — no cross-owner bleed.
    const aRequests = aPayments.getPaymentRequests();
    expect(aRequests.map((r) => r.id)).not.toContain(prId);
    expect(aRequests).toHaveLength(0);
  });
});
