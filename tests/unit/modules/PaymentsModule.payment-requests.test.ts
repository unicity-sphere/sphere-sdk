/**
 * PaymentsModule × wallet-api payment requests (sdk-changes S4 — §10/§16),
 * end-to-end against the in-process fake backend:
 *
 * - the S4 AC: a payment request round-trips create → notify (the polled
 *   gap-free ?since=<seq> stream) → respond through the module surface, with
 *   the Nostr payment-request channel NOT installed;
 * - paying a request links the fulfilling send's transferId via
 *   respond(action:'paid'); declining maps to action:'declined' (server-
 *   confirmed BEFORE the local flip — a 409 propagates);
 * - the incoming cursor is persisted per network+identity (mirroring the
 *   mailbox cursor) and a restarted module recovers still-open requests via
 *   the status=open bootstrap without re-surfacing resolved ones;
 * - compositions WITHOUT wallet-api keep the Nostr transport path untouched
 *   (port selection, covenant §3.1-6).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPaymentsModule, type PaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { FullIdentity, IncomingPaymentRequest, PaymentRequestResponse } from '../../../types';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase, HistoryRecord } from '../../../storage';
import { FakeTokenEngine, decodeFakeTokenAssets } from '../token-engine/FakeTokenEngine';
import { FakeWalletApi } from '../../support/fake-wallet-api';
import { MemoryKeyValueStore, testIdentity } from '../../support/wallet-api-test-helpers';
import { WalletApiClient } from '../../../wallet-api';
import { WalletApiMailboxProvider, WalletApiTokenStorageProvider } from '../../../impl/shared/wallet-api';
import { encodeTokenBlob } from '../../../token-engine/token-blob';
import { hexToBytes } from '../../../core/crypto';
import { FIELD_ENVELOPE_PREFIX } from '../../../core/field-encryption';

const UCT = '11'.repeat(32);
const REQUESTER = testIdentity(21);
const PAYER = testIdentity(22);

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

function mockHistoryStore() {
  const entries = new Map<string, HistoryRecord>();
  return {
    addHistoryEntry: vi.fn(async (e: HistoryRecord) => { entries.set(e.dedupKey, e); }),
    getHistoryEntries: vi.fn(async () => [...entries.values()]),
    hasHistoryEntry: vi.fn(async (k: string) => entries.has(k)),
    clearHistory: vi.fn(async () => entries.clear()),
    importHistoryEntries: vi.fn(async () => 0),
  };
}

function mockLocalTokenStorage(): TokenStorageProvider<TxfStorageDataBase> {
  let lastSaved: TxfStorageDataBase | null = null;
  return {
    id: 'local', name: 'local', type: 'local',
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: () => true, getStatus: () => 'connected', setIdentity: vi.fn(),
    initialize: vi.fn().mockResolvedValue(true), shutdown: vi.fn().mockResolvedValue(undefined),
    save: vi.fn(async (data: TxfStorageDataBase) => { lastSaved = data; return { success: true, timestamp: 0 }; }),
    load: vi.fn(async () => (lastSaved
      ? { success: true, source: 'local', timestamp: 0, data: lastSaved }
      : { success: false, source: 'local', timestamp: 0 })),
    sync: vi.fn().mockResolvedValue({ success: true, added: 0, removed: 0, conflicts: 0 }),
    ...mockHistoryStore(),
  } as unknown as TokenStorageProvider<TxfStorageDataBase>;
}

/** Resolves '@bob' → the payer; a raw chain pubkey → itself (canonical identity). */
function mockTransport(): TransportProvider {
  return {
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    sendPaymentRequest: vi.fn().mockResolvedValue('nostr-event-1'),
    sendPaymentRequestResponse: vi.fn().mockResolvedValue('nostr-event-2'),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn(async (recipient: string) => {
      const pk = recipient === '@bob'
        ? PAYER.chainPubkey
        : /^0[23][0-9a-f]{64}$/i.test(recipient) ? recipient.toLowerCase() : null;
      return pk
        ? { chainPubkey: pk, transportPubkey: pk.slice(2), directAddress: `DIRECT://${pk.slice(0, 12)}` }
        : null;
    }),
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
  transport: TransportProvider;
  emitEvent: ReturnType<typeof vi.fn>;
  storage: { provider: StorageProvider; map: Map<string, string> };
  deps: PaymentsModuleDependencies;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startFake(): Promise<{ fake: FakeWalletApi; baseUrl: string }> {
  const fake = new FakeWalletApi({ decodeAssets: decodeFakeTokenAssets });
  const baseUrl = await fake.start();
  cleanups.push(() => fake.stop());
  return { fake, baseUrl };
}

/** A wallet over the FULL wallet-api preset (the S4 composition). */
function makeWalletApiWallet(
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
  const transport = mockTransport();
  const emitEvent = vi.fn();
  const deps: PaymentsModuleDependencies = {
    identity,
    storage: storage.provider,
    tokenStorageProviders: new Map([[tokenStorage.id, tokenStorage]]),
    transport,
    oracle: mockOracle(),
    emitEvent,
    tokenEngine: engine,
    delivery,
    walletApi: client,
  };
  const module = createPaymentsModule({ l1: null });
  module.initialize(deps);
  cleanups.push(() => module.destroy());
  return { module, engine, client, transport, emitEvent, storage, deps };
}

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

describe('payment requests ride wallet-api (S4 AC: create → notify → respond, Nostr removed)', () => {
  it('create → poll surfaces it through the handler surface → decline round-trips; Nostr unused', async () => {
    const { fake, baseUrl } = await startFake();
    const requester = makeWalletApiWallet(baseUrl, fake.network, REQUESTER, 'pr-1');
    const payer = makeWalletApiWallet(baseUrl, fake.network, PAYER, 'pr-2');

    // The Nostr payment-request channel is NOT installed in this composition.
    expect(requester.transport.onPaymentRequest).not.toHaveBeenCalled();
    expect(requester.transport.onPaymentRequestResponse).not.toHaveBeenCalled();

    const result = await requester.module.sendPaymentRequest('@bob', {
      amount: '25',
      coinId: UCT,
      message: 'lunch?',
    });
    expect(result.success).toBe(true);
    expect(result.requestId).toBeDefined();
    expect(requester.transport.sendPaymentRequest).not.toHaveBeenCalled();

    // Server-side: open, addressed payer, memo S6-ENCRYPTED — never plaintext (§8.3).
    const row = fake.getPaymentRequest(result.requestId!);
    expect(row).toMatchObject({
      status: 'open',
      fromPubkey: REQUESTER.chainPubkey,
      toPubkey: PAYER.chainPubkey,
      transferId: null,
    });
    expect(row!.memo!.startsWith(FIELD_ENVELOPE_PREFIX)).toBe(true);
    expect(row!.memo).not.toContain('lunch');

    // Notify: the payer's polled ?since= stream surfaces it (handler + event).
    const surfaced: IncomingPaymentRequest[] = [];
    payer.module.onPaymentRequest((request) => surfaced.push(request));
    await payer.module.load();
    await payer.module.syncPaymentRequests();

    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]).toMatchObject({
      id: result.requestId,
      senderPubkey: REQUESTER.chainPubkey,
      amount: '25',
      coinId: UCT,
      status: 'pending',
    });
    // S6: the requester-encrypted memo is opaque to the payer — absent, not garbage.
    expect(surfaced[0].message).toBeUndefined();
    expect(payer.emitEvent.mock.calls.some((c) => c[0] === 'payment_request:incoming')).toBe(true);
    expect(payer.module.getPendingPaymentRequestsCount()).toBe(1);

    // The §16 seq cursor is persisted per network+identity (the mailbox-cursor pattern).
    const cursorRaw = payer.storage.map.get(`wallet-api-pr:cursor:${fake.network}:${PAYER.chainPubkey}`);
    expect(JSON.parse(cursorRaw!)).toEqual({ cursor: '1', syncEpoch: '1' });

    // A re-pump never re-surfaces (id-dedup is the replay guard).
    await payer.module.syncPaymentRequests();
    expect(surfaced).toHaveLength(1);

    // Respond: decline maps to action:'declined' (§16) and is server-confirmed.
    const wait = requester.module.waitForPaymentResponse(result.requestId!, 5000);
    await payer.module.rejectPaymentRequest(result.requestId!);
    expect(fake.getPaymentRequest(result.requestId!)).toMatchObject({ status: 'declined', transferId: null });
    expect(payer.module.getPaymentRequests({ status: 'rejected' })).toHaveLength(1);

    // The requester's outgoing refresh folds the response in and resolves the waiter.
    await requester.module.syncPaymentRequests();
    const response: PaymentRequestResponse = await wait;
    expect(response.responseType).toBe('rejected');
    expect(response.requestId).toBe(result.requestId);
    expect(requester.module.getOutgoingPaymentRequests()[0].status).toBe('rejected');
    expect(requester.emitEvent.mock.calls.some((c) => c[0] === 'payment_request:response')).toBe(true);

    // Respond is open-only server-side: a second decline propagates the 409.
    await expect(payer.module.rejectPaymentRequest(result.requestId!)).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
    });
  });

  it("paying a request links the fulfilling send's transferId via respond(action:'paid')", async () => {
    const { fake, baseUrl } = await startFake();
    const requester = makeWalletApiWallet(baseUrl, fake.network, REQUESTER, 'pr-3');
    const payer = makeWalletApiWallet(baseUrl, fake.network, PAYER, 'pr-4');
    await seedServerToken(fake, payer, PAYER, 1000n);
    await requester.module.load();
    await payer.module.load();

    const created = await requester.module.sendPaymentRequest(PAYER.chainPubkey, {
      amount: '1000',
      coinId: UCT,
    });
    expect(created.success).toBe(true);

    await payer.module.syncPaymentRequests();
    const incoming = payer.module.getPaymentRequests({ status: 'pending' });
    expect(incoming).toHaveLength(1);

    // Pay: an ordinary send to the requester, then respond paid with ITS transferId.
    const transfer = await payer.module.payPaymentRequest(created.requestId!);
    expect(transfer.status).toBe('completed');
    expect(fake.getPaymentRequest(created.requestId!)).toMatchObject({
      status: 'paid',
      transferId: transfer.id,
    });
    expect(payer.module.getPaymentRequests({ status: 'paid' })).toHaveLength(1);

    // The requester observes the paid response (with the linking transferId)…
    await requester.module.syncPaymentRequests();
    const outgoing = requester.module.getOutgoingPaymentRequests()[0];
    expect(outgoing.status).toBe('paid');
    expect(outgoing.response?.responseType).toBe('paid');
    expect(outgoing.response?.transferId).toBe(transfer.id);

    // …and the fulfilling transfer itself arrives via the mailbox (full loop).
    // The deposit's §9 wake may already have pumped it in the background —
    // receive() coalesces with that pump, so assert on the token map rather
    // than the new-transfer diff.
    await requester.module.receive();
    await vi.waitFor(() => {
      expect(requester.module.getTokens()).toContainEqual(
        expect.objectContaining({ amount: '1000', coinId: UCT, status: 'confirmed' })
      );
    });
  });

  it('a restarted module bootstraps still-open requests below the persisted cursor; resolved ones stay resolved', async () => {
    const { fake, baseUrl } = await startFake();
    const requester = makeWalletApiWallet(baseUrl, fake.network, REQUESTER, 'pr-5');
    const payer = makeWalletApiWallet(baseUrl, fake.network, PAYER, 'pr-6');

    const first = await requester.module.sendPaymentRequest(PAYER.chainPubkey, { amount: '1', coinId: UCT });
    const second = await requester.module.sendPaymentRequest(PAYER.chainPubkey, { amount: '2', coinId: UCT });

    await payer.module.load();
    await payer.module.syncPaymentRequests();
    expect(payer.module.getPaymentRequests()).toHaveLength(2);
    await payer.module.rejectPaymentRequest(first.requestId!);

    // "Restart": a fresh module over the SAME storage/providers. The cursor
    // (now past both seqs) is persisted, but the surfaced list is in-memory —
    // the status=open bootstrap recovers exactly the still-open request.
    const restarted = createPaymentsModule({ l1: null });
    restarted.initialize({ ...payer.deps });
    cleanups.push(() => restarted.destroy());
    await restarted.load();
    await restarted.syncPaymentRequests();

    const recovered = restarted.getPaymentRequests();
    expect(recovered.map((r) => r.id)).toEqual([second.requestId]);
    expect(recovered[0].status).toBe('pending');

    // The tail still works from the persisted cursor: a NEW request arrives.
    const third = await requester.module.sendPaymentRequest(PAYER.chainPubkey, { amount: '3', coinId: UCT });
    await restarted.syncPaymentRequests();
    expect(restarted.getPaymentRequests().map((r) => r.id).sort()).toEqual(
      [second.requestId, third.requestId].sort()
    );
  });

  it('a failed bootstrap scan is retried on the next pump (the flag is burned only on success)', async () => {
    const { fake, baseUrl } = await startFake();
    const requester = makeWalletApiWallet(baseUrl, fake.network, REQUESTER, 'pr-8');
    const payer = makeWalletApiWallet(baseUrl, fake.network, PAYER, 'pr-9');
    const created = await requester.module.sendPaymentRequest(PAYER.chainPubkey, { amount: '7', coinId: UCT });

    // First session advances the persisted cursor past the open request.
    await payer.module.load();
    await payer.module.syncPaymentRequests();
    expect(payer.module.getPaymentRequests()).toHaveLength(1);

    // Restarted session: the bootstrap scan (the FIRST list call, since the
    // persisted cursor > 0) hits a transient outage.
    vi.spyOn(payer.client, 'listPaymentRequests').mockImplementationOnce(() =>
      Promise.reject(new Error('simulated outage'))
    );
    const restarted = createPaymentsModule({ l1: null });
    restarted.initialize({ ...payer.deps });
    cleanups.push(() => restarted.destroy());

    await expect(restarted.syncPaymentRequests()).rejects.toThrow('simulated outage');
    expect(restarted.getPaymentRequests()).toEqual([]);

    // The next pump RETRIES the bootstrap — the still-open request is recovered.
    await restarted.syncPaymentRequests();
    expect(restarted.getPaymentRequests().map((r) => r.id)).toEqual([created.requestId]);
  });

  it('the §5.5 per-payer cap surfaces as a failed result, never a throw (cap → 429 QUOTA_EXCEEDED)', async () => {
    const fake = new FakeWalletApi({ decodeAssets: decodeFakeTokenAssets, maxPayerOpenRequests: 1 });
    const baseUrl = await fake.start();
    cleanups.push(() => fake.stop());
    const requester = makeWalletApiWallet(baseUrl, fake.network, REQUESTER, 'pr-7');

    expect((await requester.module.sendPaymentRequest(PAYER.chainPubkey, { amount: '1', coinId: UCT })).success).toBe(true);
    const capped = await requester.module.sendPaymentRequest(PAYER.chainPubkey, { amount: '2', coinId: UCT });
    expect(capped.success).toBe(false);
    expect(capped.error).toContain('QUOTA_EXCEEDED');
  });
});

describe('compositions WITHOUT wallet-api keep the Nostr payment-request path (covenant §3.1-6)', () => {
  it('installs the transport subscriptions and sends via the transport payload', async () => {
    const identity = fullIdentity(REQUESTER);
    const transport = mockTransport();
    const deps: PaymentsModuleDependencies = {
      identity,
      storage: mockStorage().provider,
      tokenStorageProviders: new Map([['local', mockLocalTokenStorage()]]),
      transport,
      oracle: mockOracle(),
      emitEvent: vi.fn(),
    };
    const module = createPaymentsModule({ l1: null });
    module.initialize(deps);
    cleanups.push(() => module.destroy());

    // The push subscriptions ARE installed on this path.
    expect(transport.onPaymentRequest).toHaveBeenCalledTimes(1);
    expect(transport.onPaymentRequestResponse).toHaveBeenCalledTimes(1);

    const result = await module.sendPaymentRequest('@bob', { amount: '25', coinId: UCT, message: 'hi' });
    expect(result.success).toBe(true);
    expect(result.eventId).toBe('nostr-event-1');
    expect(transport.sendPaymentRequest).toHaveBeenCalledTimes(1);

    // And the wallet-api pump surface is a no-op without the capability.
    await expect(module.syncPaymentRequests()).resolves.toBeUndefined();
  });
});
