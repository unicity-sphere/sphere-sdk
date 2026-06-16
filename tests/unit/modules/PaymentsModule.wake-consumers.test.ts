/**
 * PaymentsModule × wallet-api wake streams (§9), end-to-end against the
 * in-process fake backend — the cross-session-sync fix:
 *
 * The wallet-api wake socket multiplexes THREE owner streams (`mailbox` |
 * `inventory` | `payment_requests`) and the backend fans every owner-scoped
 * change to ALL of that owner's sessions. Two sessions of the SAME custodial
 * wallet model two browser windows. When window A mutates server state, window
 * B's session must converge from the wake alone — WITHOUT waiting for the
 * low-frequency poll backstop:
 *
 * - an `inventory` wake → a debounced inventory resync (a top-up / a claim on
 *   another device shows up in window B);
 * - a `payment_requests` wake → a PR pump (a request created elsewhere surfaces
 *   in window B);
 * - the `mailbox` wake still drives the incoming-delivery pump (unchanged).
 *
 * Before the fix only `mailbox` was consumed: inventory and payment-request
 * wakes were parsed then dropped, and there was no inventory poll at all, so a
 * second window had no realtime path for those streams.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPaymentsModule, type PaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { FullIdentity, IncomingPaymentRequest } from '../../../types';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { StorageProvider } from '../../../storage';
import { FakeTokenEngine, decodeFakeTokenAssets, decodeFakeTokenId } from '../token-engine/FakeTokenEngine';
import { FakeWalletApi } from '../../support/fake-wallet-api';
import { MemoryKeyValueStore, testIdentity } from '../../support/wallet-api-test-helpers';
import { WalletApiClient } from '../../../wallet-api';
import { WalletApiMailboxProvider, WalletApiTokenStorageProvider } from '../../../impl/shared/wallet-api';
import { encodeTokenBlob } from '../../../token-engine/token-blob';
import { hexToBytes } from '../../../core/crypto';

const UCT = '11'.repeat(32);
const OWNER = testIdentity(31);
const REQUESTER = testIdentity(32);

function fullIdentity(id: { privateKey: string; chainPubkey: string }): FullIdentity {
  return {
    chainPubkey: id.chainPubkey,
    privateKey: id.privateKey,
    l1Address: `alpha1${id.chainPubkey.slice(0, 8)}`,
    directAddress: `DIRECT://${id.chainPubkey.slice(0, 12)}`,
    transportPubkey: id.chainPubkey.slice(2),
  };
}

function mockStorage(): { provider: StorageProvider; map: Map<string, string> } {
  const s = new Map<string, string>();
  const provider = {
    id: 's', name: 's', type: 'local', connect: vi.fn(), disconnect: vi.fn(),
    isConnected: () => true, getStatus: () => 'connected', setIdentity: vi.fn(),
    get: vi.fn(async (k: string) => s.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { s.set(k, v); }),
    remove: vi.fn(async (k: string) => { s.delete(k); }),
    has: vi.fn(async (k: string) => s.has(k)),
    keys: vi.fn(async () => [...s.keys()]),
    clear: vi.fn(async () => { s.clear(); }),
  } as unknown as StorageProvider;
  return { provider, map: s };
}

function mockTransport(): TransportProvider {
  return {
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    sendPaymentRequest: vi.fn().mockResolvedValue('nostr-event'),
    sendPaymentRequestResponse: vi.fn().mockResolvedValue('nostr-event'),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn(async (recipient: string) =>
      /^0[23][0-9a-f]{64}$/i.test(recipient)
        ? { chainPubkey: recipient.toLowerCase(), transportPubkey: recipient.slice(2), directAddress: `DIRECT://${recipient.slice(0, 12)}` }
        : null
    ),
    resolveTransportPubkeyInfo: vi.fn().mockResolvedValue(null),
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(), isConnected: () => true,
  } as unknown as TransportProvider;
}

function mockOracle(): OracleProvider {
  return {
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    isDevMode: () => false,
  } as unknown as OracleProvider;
}

interface Wallet {
  module: PaymentsModule;
  engine: FakeTokenEngine;
  client: WalletApiClient;
  emitEvent: ReturnType<typeof vi.fn>;
  storage: { provider: StorageProvider; map: Map<string, string> };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startFake(): Promise<{ fake: FakeWalletApi; baseUrl: string }> {
  const fake = new FakeWalletApi({ decodeAssets: decodeFakeTokenAssets, decodeTokenId: decodeFakeTokenId });
  const baseUrl = await fake.start();
  cleanups.push(() => fake.stop());
  return { fake, baseUrl };
}

/** A wallet over the FULL wallet-api preset (storage + delivery + PRs). */
function makeWallet(
  baseUrl: string,
  network: string,
  who: { privateKey: string; chainPubkey: string },
  deviceId: string
): Wallet {
  const identity = fullIdentity(who);
  const kv = new MemoryKeyValueStore();
  const client = new WalletApiClient({ baseUrl, network, deviceId, storage: kv });
  const tokenStorage = new WalletApiTokenStorageProvider({ client, stateStore: kv });
  tokenStorage.setIdentity(identity);
  const delivery = new WalletApiMailboxProvider({ client, custody: 'inventory', stateStore: kv });
  const engine = new FakeTokenEngine({ chainPubkey: hexToBytes(who.chainPubkey) });
  const storage = mockStorage();
  const emitEvent = vi.fn();
  const deps: PaymentsModuleDependencies = {
    identity,
    storage: storage.provider,
    tokenStorageProviders: new Map([[tokenStorage.id, tokenStorage]]),
    transport: mockTransport(),
    oracle: mockOracle(),
    emitEvent,
    tokenEngine: engine,
    delivery,
    walletApi: client,
  };
  const module = createPaymentsModule({ l1: null });
  module.initialize(deps);
  cleanups.push(() => module.destroy());
  return { module, engine, client, emitEvent, storage };
}

/** Mint a token on the wallet's engine and seed it into the SERVER inventory. */
async function seedServerToken(fake: FakeWalletApi, wallet: Wallet, who: { chainPubkey: string }, amount: bigint): Promise<string> {
  const minted = await wallet.engine.mint({
    recipientPubkey: wallet.engine.getIdentity().chainPubkey,
    value: { assets: [{ coinId: UCT, amount }] },
  });
  const bytes = encodeTokenBlob(wallet.engine.encodeToken(minted));
  const tokenId = wallet.engine.tokenId(minted);
  fake.seedInventory(who.chainPubkey, [{ tokenId, assets: [{ coinId: UCT, amount }], blob: bytes }]);
  return tokenId;
}

/** Poll a predicate up to `timeoutMs` (well under the 30s poll backstop). */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: predicate never became true');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('wallet-api wake streams converge a second session (§9 cross-session sync)', () => {
  it('an `inventory` wake triggers a resync — window B sees a top-up WITHOUT the 30s poll', async () => {
    const { fake, baseUrl } = await startFake();
    // Two sessions of the SAME owner = two browser windows.
    const windowB = makeWallet(baseUrl, fake.network, OWNER, 'win-b');
    await windowB.module.load();
    expect(windowB.module.getTokens()).toHaveLength(0);

    // Window B's wake socket must be live before the backend can nudge it.
    await waitFor(() => fake.socketCount(OWNER.chainPubkey) >= 1);

    // Window A tops up: a new row lands in the OWNER's server inventory. The
    // backend fans an `inventory` wake to every session of the owner.
    await seedServerToken(fake, windowB, OWNER, 1000n);
    fake.wakeOwner(OWNER.chainPubkey, 'inventory');

    // Window B converges from the wake alone (debounced resync ≪ 30s poll).
    await waitFor(() => windowB.module.getTokens().length === 1);
    expect(windowB.module.getTokens()[0]).toMatchObject({ amount: '1000', coinId: UCT, status: 'confirmed' });

    // The existing realtime event lights up for the frontend (`useSphereEvents`):
    // the `sync:remote-update` path is DEAD in custodial mode without the wake.
    await waitFor(() => windowB.emitEvent.mock.calls.some((c) => c[0] === 'sync:remote-update'));
    const evt = windowB.emitEvent.mock.calls.find((c) => c[0] === 'sync:remote-update')![1];
    expect(evt).toMatchObject({ providerId: 'wallet-api', name: 'inventory', added: 1 });

    // Sanity: convergence was wake-driven, not a slow poll — no fake timers used.
    expect(fake.socketCount(OWNER.chainPubkey)).toBeGreaterThanOrEqual(1);
  });

  it('a burst of `inventory` wakes coalesces into ONE resync (debounce)', async () => {
    const { fake, baseUrl } = await startFake();
    const windowB = makeWallet(baseUrl, fake.network, OWNER, 'win-b2');
    await windowB.module.load();
    await waitFor(() => fake.socketCount(OWNER.chainPubkey) >= 1);

    const loadSpy = vi.spyOn(windowB.module, 'load');
    await seedServerToken(fake, windowB, OWNER, 500n);
    // A rapid burst — they MUST collapse to a single trailing resync.
    fake.wakeOwner(OWNER.chainPubkey, 'inventory');
    fake.wakeOwner(OWNER.chainPubkey, 'inventory');
    fake.wakeOwner(OWNER.chainPubkey, 'inventory');

    await waitFor(() => windowB.module.getTokens().length === 1);
    // One trailing debounced resync (a single burst → a single inventory pull).
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it('a `payment_requests` wake triggers a PR pump — window B surfaces a request created elsewhere', async () => {
    const { fake, baseUrl } = await startFake();
    const payer = makeWallet(baseUrl, fake.network, OWNER, 'pay-b');
    const requester = makeWallet(baseUrl, fake.network, REQUESTER, 'req-a');
    await payer.module.load();
    await waitFor(() => fake.socketCount(OWNER.chainPubkey) >= 1);

    const surfaced: IncomingPaymentRequest[] = [];
    payer.module.onPaymentRequest((r) => surfaced.push(r));

    // The requester creates a request addressed to the payer (OWNER). The
    // backend wakes the payer's sessions on the `payment_requests` stream.
    const created = await requester.module.sendPaymentRequest(OWNER.chainPubkey, { amount: '25', coinId: UCT });
    expect(created.success).toBe(true);

    // The payer converges on the wake alone — no explicit syncPaymentRequests().
    await waitFor(() => surfaced.length === 1);
    expect(surfaced[0]).toMatchObject({ id: created.requestId, amount: '25', coinId: UCT, status: 'pending' });
    expect(payer.module.getPendingPaymentRequestsCount()).toBe(1);
  });
});
