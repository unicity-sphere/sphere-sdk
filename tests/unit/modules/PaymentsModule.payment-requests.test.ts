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
 *   mailbox cursor) and a restarted module rebuilds the CURRENT state of ALL
 *   incoming requests — open AND resolved — via a full `since=0` hydration
 *   (#556, the SDK-level J12: a request resolved in a prior session is still
 *   present with its resolved status on reopen; resolved ones never re-fire
 *   the new-incoming handlers/events);
 * - compositions WITHOUT wallet-api keep the Nostr transport path untouched
 *   (port selection, covenant §3.1-6).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPaymentsModule, type PaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { FullIdentity, IncomingPaymentRequest, PaymentRequestResponse } from '../../../types';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase, HistoryRecord } from '../../../storage';
import { FakeTokenEngine, decodeFakeTokenAssets, decodeFakeTokenId } from '../token-engine/FakeTokenEngine';
import { FakeWalletApi } from '../../support/fake-wallet-api';
import { MemoryKeyValueStore, testIdentity } from '../../support/wallet-api-test-helpers';
import { WalletApiClient, WalletApiError } from '../../../wallet-api';
import { WalletApiMailboxProvider, WalletApiTokenStorageProvider } from '../../../impl/shared/wallet-api';
import { encodeTokenBlob } from '../../../token-engine/token-blob';
import { hexToBytes } from '../../../core/crypto';
import { SphereError, PartialSendConflictError } from '../../../core/errors';
import { FIELD_ENVELOPE_PREFIX, deriveFieldEncryptionKey, encryptField } from '../../../core/field-encryption';
import { deriveDeliveryEncryptionKey, decryptDeliveryBundle } from '../../../core/delivery-envelope';

const UCT = '11'.repeat(32);
const REQUESTER = testIdentity(21);
const PAYER = testIdentity(22);

function fullIdentity(id: { privateKey: string; chainPubkey: string }): FullIdentity {
  return {
    chainPubkey: id.chainPubkey,
    privateKey: id.privateKey,
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
  const fake = new FakeWalletApi({ decodeAssets: decodeFakeTokenAssets, decodeTokenId: decodeFakeTokenId });
  const baseUrl = await fake.start();
  cleanups.push(() => fake.stop());
  return { fake, baseUrl };
}

/** A wallet over the FULL wallet-api preset (the S4 composition).
 *
 * `getCurrentNametag` mirrors the Sphere wiring of the canonical (Nostr-backed)
 * display nametag store — the one the real app reliably loads on every startup.
 * When supplied, outgoing memos read it WITHOUT the local minted-token
 * `setNametag()` path ever being populated (the real-app state the #553 fix
 * regressed on). */
function makeWalletApiWallet(
  baseUrl: string,
  network: string,
  who: { privateKey: string; chainPubkey: string },
  deviceId: string,
  getCurrentNametag?: () => string | undefined
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
    ...(getCurrentNametag !== undefined ? { getCurrentNametag } : {}),
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

    // The requester has a nametag — it must reach the PAYER as the surfaced
    // request's counterparty identity (the PR twin of #546/#547's "Someone"
    // fix). Set after load so it survives to send time.
    await requester.module.setNametag({
      name: 'api-1', token: {}, timestamp: Date.now(), format: 'txf', version: '2.0',
    });

    const result = await requester.module.sendPaymentRequest('@bob', {
      amount: '25',
      coinId: UCT,
      message: 'lunch?',
    });
    expect(result.success).toBe(true);
    expect(result.requestId).toBeDefined();
    expect(requester.transport.sendPaymentRequest).not.toHaveBeenCalled();

    // Server-side: open, addressed payer, memo is a recipient-addressed `enc1.`
    // envelope (S6) — never plaintext, neither the message nor the nametag.
    const row = fake.getPaymentRequest(result.requestId!);
    expect(row).toMatchObject({
      status: 'open',
      fromPubkey: REQUESTER.chainPubkey,
      toPubkey: PAYER.chainPubkey,
      transferId: null,
    });
    expect(row!.memo!.startsWith(FIELD_ENVELOPE_PREFIX)).toBe(true);
    expect(row!.memo).not.toContain('lunch');
    expect(row!.memo).not.toContain('api-1');

    // S6 (the fix): the memo is addressed to the PAYER via ECDH — only the
    // payer's own key opens it; a THIRD wallet cannot. Asserted at the crypto
    // boundary against the verbatim wire bytes.
    const stranger = testIdentity(99);
    expect(() =>
      decryptDeliveryBundle(
        deriveDeliveryEncryptionKey(stranger.privateKey, REQUESTER.chainPubkey),
        row!.memo!
      )
    ).toThrow();
    // …and the requester re-derives the SAME shared secret (ECDH symmetry), so
    // it can still read its own sent message + nametag from the wire.
    expect(
      decryptDeliveryBundle(
        deriveDeliveryEncryptionKey(REQUESTER.privateKey, PAYER.chainPubkey),
        row!.memo!
      )
    ).toEqual({ senderNametag: 'api-1', memo: 'lunch?' });

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
    // S6 (the fix): the payer DECRYPTS the requester-addressed envelope — both
    // the message AND the requester's nametag surface (was undefined / raw
    // pubkey before #553).
    expect(surfaced[0].message).toBe('lunch?');
    expect(surfaced[0].senderNametag).toBe('api-1');
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
    const outgoing = requester.module.getOutgoingPaymentRequests()[0];
    expect(outgoing.status).toBe('rejected');
    // The requester's outgoing view still reads its OWN message (held in-memory
    // at create time; the ECDH key change never breaks the requester's read).
    expect(outgoing.message).toBe('lunch?');
    expect(requester.emitEvent.mock.calls.some((c) => c[0] === 'payment_request:response')).toBe(true);

    // Respond is open-only server-side: a second decline propagates the 409.
    await expect(payer.module.rejectPaymentRequest(result.requestId!)).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
    });
  });

  it('real-app scenario: the requester nametag rides the memo from the CANONICAL store even when the minted-token nametags[] is empty (6bd3058 regression)', async () => {
    // The #553 fix read the requester nametag from `this.nametags` — populated
    // ONLY by the best-effort, oracle-gated minted-token path. In the real app
    // that array is EMPTY at send time; the nametag the UI shows lives in the
    // Sphere-level Nostr-backed store (getNametagForAddress). So the memo
    // dropped the nametag and the payer rendered the raw pubkey. Here the
    // requester has the canonical nametag (`getCurrentNametag`) but NEVER calls
    // setNametag() — exactly that real-app state. Cross-check: the existing
    // setNametag('api-1') test above still passes via the nametags[] fallback.
    const { fake, baseUrl } = await startFake();
    const requester = makeWalletApiWallet(baseUrl, fake.network, REQUESTER, 'pr-canon-1', () => 'api-1');
    const payer = makeWalletApiWallet(baseUrl, fake.network, PAYER, 'pr-canon-2');

    // No setNametag() — the minted-token store stays empty (the regression's
    // precondition). The memo must still carry the canonical nametag.
    expect(requester.module.hasNametag()).toBe(false);

    const result = await requester.module.sendPaymentRequest('@bob', {
      amount: '25',
      coinId: UCT,
      message: 'hi',
    });
    expect(result.success).toBe(true);

    // At the crypto boundary: the requester-addressed envelope carries BOTH the
    // canonical nametag AND the message (pre-fix the plaintext was `{"t":"hi"}`
    // — no `senderNametag` field at all).
    const row = fake.getPaymentRequest(result.requestId!);
    expect(
      decryptDeliveryBundle(
        deriveDeliveryEncryptionKey(REQUESTER.privateKey, PAYER.chainPubkey),
        row!.memo!
      )
    ).toEqual({ senderNametag: 'api-1', memo: 'hi' });

    // …and through the payer surface: the "From" field renders "@api-1", not the
    // raw pubkey.
    const surfaced: IncomingPaymentRequest[] = [];
    payer.module.onPaymentRequest((request) => surfaced.push(request));
    await payer.module.load();
    await payer.module.syncPaymentRequests();

    expect(surfaced).toHaveLength(1);
    expect(surfaced[0].senderNametag).toBe('api-1');
    expect(surfaced[0].message).toBe('hi');
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

  describe('#441 deferred-paid: a possibly-committed pay HOLDS the request settling until the transfer resolves (no double-pay on reload)', () => {
    const SETTLING_KEY = (net: string) => `wallet-api-pr:settling:${net}:${PAYER.chainPubkey}`;

    interface Ctx {
      fake: FakeWalletApi;
      baseUrl: string;
      requester: Wallet;
      payer: Wallet;
      reqId: string;
      sourceTokenId: string;
    }

    async function seedPendingRequest(deviceSuffix: string): Promise<Ctx> {
      const { fake, baseUrl } = await startFake();
      const requester = makeWalletApiWallet(baseUrl, fake.network, REQUESTER, `pr-441-r-${deviceSuffix}`);
      const payer = makeWalletApiWallet(baseUrl, fake.network, PAYER, `pr-441-p-${deviceSuffix}`);
      const sourceTokenId = await seedServerToken(fake, payer, PAYER, 1000n);
      await requester.module.load();
      await payer.module.load();
      await requester.module.sendPaymentRequest(PAYER.chainPubkey, { amount: '1000', coinId: UCT });
      await payer.module.syncPaymentRequests();
      const pending = payer.module.getPaymentRequests({ status: 'pending' });
      expect(pending).toHaveLength(1);
      return { fake, baseUrl, requester, payer, reqId: pending[0].id, sourceTokenId };
    }

    /** Put a REAL open intent on the server (the id resume will complete/abort), matching this pay. */
    async function putOpenIntent(payer: Wallet, transferId: string, sourceTokenId: string): Promise<void> {
      payer.client.setIdentity(PAYER);
      const payload = { v: 1, recipient: REQUESTER.chainPubkey, coinId: UCT, amount: '1000', direct: [sourceTokenId] };
      await payer.client.putIntent(
        transferId,
        encryptField(deriveFieldEncryptionKey(PAYER.privateKey), JSON.stringify(payload)),
      );
    }

    /** Drive payPaymentRequest into 'settling' by mocking send to throw a stamped possibly-committed error. */
    async function paySettling(payer: Wallet, reqId: string, transferId: string, code = 'SEND_SYNC_PENDING'): Promise<void> {
      const err = new SphereError('sent — wallet catching up', code as never);
      err.transferId = transferId;
      vi.spyOn(payer.module, 'send').mockRejectedValueOnce(err);
      await expect(payer.module.payPaymentRequest(reqId)).rejects.toMatchObject({ code });
    }

    it('(write site) a possibly-committed pay → status settling, journal links request→transfer, server NOT told paid, error re-thrown', async () => {
      const { fake, payer, reqId, sourceTokenId } = await seedPendingRequest('write');
      const transferId = crypto.randomUUID();
      await putOpenIntent(payer, transferId, sourceTokenId);

      const respondSpy = vi.spyOn(payer.client, 'respondPaymentRequest');
      await paySettling(payer, reqId, transferId);

      // Held NON-payable: 'settling', not 'paid', not 'pending'.
      expect(payer.module.getPaymentRequests().find((r) => r.id === reqId)?.status).toBe('settling');
      expect(payer.module.getPaymentRequests({ status: 'pending' })).toHaveLength(0);
      // Durable journal links request→transfer.
      const journal = JSON.parse(payer.storage.map.get(SETTLING_KEY(fake.network))!);
      expect(journal[reqId]).toMatchObject({ transferId });
      // Server was NOT told 'paid' (the whole point — resume may still abort).
      expect(respondSpy).not.toHaveBeenCalled();
      expect(fake.getPaymentRequest(reqId)).toMatchObject({ status: 'open', transferId: null });
    });

    it('(write site) a PartialSendConflictError links its NATIVE primary transferId → settling', async () => {
      const { fake, payer, reqId } = await seedPendingRequest('partial');
      // PartialSendConflictError.transferId is set natively (not via the sendOnce stamp).
      vi.spyOn(payer.module, 'send').mockRejectedValueOnce(
        new PartialSendConflictError('part sent', 'tid-primary', ['v2_committed'], '500'),
      );
      await expect(payer.module.payPaymentRequest(reqId)).rejects.toBeInstanceOf(PartialSendConflictError);
      expect(payer.module.getPaymentRequests().find((r) => r.id === reqId)?.status).toBe('settling');
      const journal = JSON.parse(payer.storage.map.get(SETTLING_KEY(fake.network))!);
      expect(journal[reqId]).toMatchObject({ transferId: 'tid-primary' });
    });

    it('(pay guard) a settling request is auto NON-payable — a tapped re-pay throws VALIDATION_ERROR', async () => {
      const { payer, reqId, sourceTokenId } = await seedPendingRequest('guard');
      const transferId = crypto.randomUUID();
      await putOpenIntent(payer, transferId, sourceTokenId);
      await paySettling(payer, reqId, transferId);
      await expect(payer.module.payPaymentRequest(reqId)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(payer.module.payPaymentRequest(reqId)).rejects.toThrow(/not pending or accepted/i);
    });

    it('(RELOAD, load-bearing) a settling request is NOT re-surfaced as payable — a fresh module over the SAME storage+server holds it settling, no re-notify', async () => {
      const { fake, payer, reqId, sourceTokenId } = await seedPendingRequest('reload');
      const transferId = crypto.randomUUID();
      await putOpenIntent(payer, transferId, sourceTokenId);
      await paySettling(payer, reqId, transferId);

      // The server PR is STILL open (never told paid). Pre-fix, a reload re-hydrated
      // it OPEN → payable → the exact double-pay. A fresh module must re-apply the
      // durable journal and hold it settling instead.
      expect(fake.getPaymentRequest(reqId)).toMatchObject({ status: 'open' });

      const reopened = createPaymentsModule({ l1: null });
      reopened.initialize({ ...payer.deps });
      cleanups.push(() => reopened.destroy());
      const reNotified: IncomingPaymentRequest[] = [];
      reopened.onPaymentRequest((r) => reNotified.push(r));
      await reopened.load();
      await reopened.syncPaymentRequests();

      const req = reopened.getPaymentRequests().find((r) => r.id === reqId);
      expect(req?.status).toBe('settling');
      expect(reopened.getPaymentRequests({ status: 'pending' })).toHaveLength(0);
      // Never re-fires the actionable 'new incoming' notify for a settling request.
      expect(reNotified.map((r) => r.id)).not.toContain(reqId);
      expect(payer.emitEvent.mock.calls.some((c) => c[0] === 'payment_request:incoming' && (c[1] as IncomingPaymentRequest).id === reqId)).toBe(true); // only the ORIGINAL surface notified
    });

    it('(resolution, load-bearing) when the linked transfer COMPLETES via resume → paid response sent to the server exactly once, request resolves paid, journal cleared', async () => {
      const { fake, payer, reqId, sourceTokenId } = await seedPendingRequest('resolve');
      const transferId = crypto.randomUUID();
      await putOpenIntent(payer, transferId, sourceTokenId);
      await paySettling(payer, reqId, transferId);
      vi.restoreAllMocks(); // drop the send mock — resume uses the real engine
      const respondSpy = vi.spyOn(payer.client, 'respondPaymentRequest');

      const outcome = await payer.module.resumeOpenIntents();
      expect(outcome.resumed).toContain(transferId);

      // Deferred 'paid' now told to the server EXACTLY once, with the linking transferId.
      const paidCalls = respondSpy.mock.calls.filter((c) => (c[1] as { action: string }).action === 'paid');
      expect(paidCalls).toHaveLength(1);
      expect(paidCalls[0]).toEqual([reqId, { action: 'paid', transferId }]);
      expect(fake.getPaymentRequest(reqId)).toMatchObject({ status: 'paid', transferId });
      expect(payer.module.getPaymentRequests().find((r) => r.id === reqId)?.status).toBe('paid');
      // Journal cleared.
      expect(payer.storage.map.get(SETTLING_KEY(fake.network))).toBe('{}');

      // Idempotent: a second resume does not re-respond (journal already empty).
      respondSpy.mockClear();
      await payer.module.resumeOpenIntents();
      expect(respondSpy).not.toHaveBeenCalled();
    });

    it('(abort, load-bearing) when the linked transfer ABORTS via resume → journal clears, server never told paid, request returns to payable', async () => {
      const { fake, payer, reqId, sourceTokenId } = await seedPendingRequest('abort');
      const transferId = crypto.randomUUID();
      await putOpenIntent(payer, transferId, sourceTokenId);
      await paySettling(payer, reqId, transferId);
      vi.restoreAllMocks();

      // Reproduce the #676 locally-aborted-but-server-open divergence: resume must
      // NOT re-execute it and classifies it conflicted (aborted, nothing delivered).
      fake.setIntentFailure(true);
      await expect(payer.client.abortIntent(transferId)).rejects.toThrow();
      fake.setIntentFailure(false);
      expect(await payer.client.getLocalIntent(transferId)).toMatchObject({ status: 'aborted', abortPending: true });

      const respondSpy = vi.spyOn(payer.client, 'respondPaymentRequest');
      const outcome = await payer.module.resumeOpenIntents();
      expect(outcome.conflicted).toContain(transferId);
      expect(outcome.resumed).not.toContain(transferId);

      // Nothing was paid: server never told 'paid', journal cleared, request re-payable.
      expect(respondSpy.mock.calls.filter((c) => (c[1] as { action: string }).action === 'paid')).toHaveLength(0);
      expect(fake.getPaymentRequest(reqId)).toMatchObject({ status: 'open' });
      expect(payer.storage.map.get(SETTLING_KEY(fake.network))).toBe('{}');
      expect(payer.module.getPaymentRequests().find((r) => r.id === reqId)?.status).toBe('pending');
      // And a re-pay is admitted again (the request was NOT fulfilled).
      expect(payer.module.getPaymentRequests({ status: 'pending' }).map((r) => r.id)).toContain(reqId);
    });

    it('(partial commit, load-bearing) a PartialSendConflictError whose anchor intent ABORTS stays PAID — never reverts to payable (Codex P1)', async () => {
      const { fake, payer, reqId, sourceTokenId } = await seedPendingRequest('partial-abort');
      const transferId = crypto.randomUUID();
      await putOpenIntent(payer, transferId, sourceTokenId);

      // Pay ends in a PartialSendConflictError: ≥1 leg already certified + delivered,
      // the anchor intent (transferId) soft-aborted. Value LEFT the wallet.
      const partial = new PartialSendConflictError('part sent', transferId, ['v2_committed'], '500');
      vi.spyOn(payer.module, 'send').mockRejectedValueOnce(partial);
      await expect(payer.module.payPaymentRequest(reqId)).rejects.toBeInstanceOf(PartialSendConflictError);
      expect(payer.module.getPaymentRequests().find((r) => r.id === reqId)?.status).toBe('settling');
      // Journaled as committed — the discriminator that stops the revert.
      expect(JSON.parse(payer.storage.map.get(SETTLING_KEY(fake.network))!)[reqId]).toMatchObject({
        transferId, committed: true,
      });
      vi.restoreAllMocks();

      // The anchor intent aborts on resume (exactly the #676 divergence). WITHOUT the
      // committed flag the reconcile would read "aborted → nothing paid → revert to
      // pending" and a re-pay would double-pay the delivered leg. It must resolve PAID.
      fake.setIntentFailure(true);
      await expect(payer.client.abortIntent(transferId)).rejects.toThrow();
      fake.setIntentFailure(false);

      const respondSpy = vi.spyOn(payer.client, 'respondPaymentRequest');
      const outcome = await payer.module.resumeOpenIntents();
      expect(outcome.conflicted).toContain(transferId); // the anchor DID abort…

      // …yet the request is resolved PAID and NON-payable, journal cleared.
      expect(respondSpy.mock.calls.filter((c) => (c[1] as { action: string }).action === 'paid')).toHaveLength(1);
      expect(payer.storage.map.get(SETTLING_KEY(fake.network))).toBe('{}');
      expect(payer.module.getPaymentRequests().find((r) => r.id === reqId)?.status).toBe('paid');
      // A re-pay is REFUSED (delivered value must not be paid twice).
      await expect(payer.module.payPaymentRequest(reqId)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('(corrupt journal) an unreadable settling blob loads as empty and does NOT wedge the pump (Copilot)', async () => {
      const { fake, payer, reqId, sourceTokenId } = await seedPendingRequest('corrupt');
      const transferId = crypto.randomUUID();
      await putOpenIntent(payer, transferId, sourceTokenId);
      await paySettling(payer, reqId, transferId); // writes a valid journal
      // Corrupt the persisted blob (partial write / manual clear / older format).
      payer.storage.map.set(SETTLING_KEY(fake.network), '{ not valid json');

      // A fresh module over the same storage must LOAD + PUMP without throwing.
      // Without the JSON.parse guard, ensureSettlingJournalLoaded throws and wedges
      // the whole payment-request pump / resume path.
      const reopened = createPaymentsModule({ l1: null });
      reopened.initialize({ ...payer.deps });
      cleanups.push(() => reopened.destroy());
      await reopened.load();
      await reopened.syncPaymentRequests(); // would REJECT here without the fix

      // Fail-open: journal treated as empty → the request re-surfaces per server
      // state (open → pending) rather than the pump being wedged.
      expect(reopened.getPaymentRequests().find((r) => r.id === reqId)?.status).toBe('pending');
    });

    it('(identity switch, load-bearing) a journal mutation queued under identity A does NOT pollute identity B (Copilot)', async () => {
      const { fake, payer } = await seedPendingRequest('idswitch');

      // Enqueue a journal mutation under identity A but do NOT await it…
      const pA = (
        payer.module as unknown as { journalSettling(r: string, t: string, c?: boolean): Promise<void> }
      ).journalSettling('reqA', 'tidA');

      // …then synchronously switch to identity B (a distinct chainPubkey). The
      // queued mutation's .then runs AFTER the switch; the enqueue-time key guard
      // must drop it so it can't reload + rewrite identity B's journal.
      const B = testIdentity(4242);
      payer.module.initialize({ ...payer.deps, identity: B });

      await pA.catch(() => {});

      // reqA must NOT have leaked into identity B's IN-MEMORY journal. Without the
      // key guard the queued mutation reloads B's (empty) journal, injects reqA,
      // and persists — polluting B's session state with a prior identity's link.
      const bJournal = (payer.module as unknown as { settlingJournal: Map<string, unknown> | null })
        .settlingJournal;
      expect(bJournal?.has('reqA') ?? false).toBe(false);
    });

    it('(idempotent respond) a 409 CONFLICT on the deferred paid response is swallowed → journal cleared, status paid; a NETWORK error retains the journal', async () => {
      const { fake, payer, reqId, sourceTokenId } = await seedPendingRequest('idem');
      const transferId = crypto.randomUUID();
      await putOpenIntent(payer, transferId, sourceTokenId);
      await paySettling(payer, reqId, transferId);
      vi.restoreAllMocks();

      // First resume: the respond hits a transient NETWORK error → journal RETAINED, still settling.
      const respondSpy = vi.spyOn(payer.client, 'respondPaymentRequest')
        .mockRejectedValueOnce(new WalletApiError('flaky', 'NETWORK'));
      await payer.module.resumeOpenIntents();
      expect(payer.storage.map.get(SETTLING_KEY(fake.network))).toContain(reqId);
      expect(payer.module.getPaymentRequests().find((r) => r.id === reqId)?.status).toBe('settling');

      // Next resume: the respond returns 409 CONFLICT (already resolved server-side) → swallowed,
      // journal cleared, status paid.
      respondSpy.mockRejectedValueOnce(new WalletApiError('non-open', 'CONFLICT', 409));
      await payer.module.resumeOpenIntents();
      expect(payer.storage.map.get(SETTLING_KEY(fake.network))).toBe('{}');
      expect(payer.module.getPaymentRequests().find((r) => r.id === reqId)?.status).toBe('paid');
    });

    it('(clean pre-commit failure) nothing left the wallet → reverts to pending, journal untouched, re-payable', async () => {
      const { fake, payer, reqId } = await seedPendingRequest('clean');
      vi.spyOn(payer.module, 'send').mockRejectedValueOnce(new SphereError('not enough funds', 'SEND_INSUFFICIENT_BALANCE'));

      await expect(payer.module.payPaymentRequest(reqId)).rejects.toMatchObject({ code: 'SEND_INSUFFICIENT_BALANCE' });

      expect(payer.module.getPaymentRequests({ status: 'pending' }).map((r) => r.id)).toContain(reqId);
      expect(payer.module.getPaymentRequests().find((r) => r.id === reqId)?.status).toBe('pending');
      expect(payer.storage.map.get(SETTLING_KEY(fake.network)) ?? '{}').toBe('{}');
    });

    it('(concurrency RMW) two journalSettling for distinct requests racing from cold both survive (no dropped entry = no re-payable double-pay)', async () => {
      const { fake, payer } = await seedPendingRequest('rmw');
      const mod = payer.module as unknown as {
        journalSettling(requestId: string, transferId: string): Promise<void>;
      };
      // Race both writes from the null-loaded state — the serialized RMW + single-flight load must
      // keep BOTH (a lost entry would re-surface that request payable = double-pay, the #679/#680 lesson).
      await Promise.all([mod.journalSettling('req-A', 'tid-A'), mod.journalSettling('req-B', 'tid-B')]);
      const journal = JSON.parse(payer.storage.map.get(SETTLING_KEY(fake.network))!);
      expect(journal['req-A']).toMatchObject({ transferId: 'tid-A' });
      expect(journal['req-B']).toMatchObject({ transferId: 'tid-B' });
    });

    it('(clearProcessedPaymentRequests) keeps settling (and pending), evicts paid/rejected/expired', async () => {
      const { payer, reqId, sourceTokenId } = await seedPendingRequest('clearproc');
      const transferId = crypto.randomUUID();
      await putOpenIntent(payer, transferId, sourceTokenId);
      await paySettling(payer, reqId, transferId);
      expect(payer.module.getPaymentRequests().find((r) => r.id === reqId)?.status).toBe('settling');
      payer.module.clearProcessedPaymentRequests();
      // The settling request is UNRESOLVED — it must survive the eviction.
      expect(payer.module.getPaymentRequests().find((r) => r.id === reqId)?.status).toBe('settling');
    });
  });

  it('#556 (SDK-level J12): a restarted module rebuilds ALL incoming requests — resolved ones present with status, opens still actionable, no re-notify', async () => {
    const { fake, baseUrl } = await startFake();
    const requester = makeWalletApiWallet(baseUrl, fake.network, REQUESTER, 'pr-5');
    const payer = makeWalletApiWallet(baseUrl, fake.network, PAYER, 'pr-6');
    await seedServerToken(fake, payer, PAYER, 1000n);

    const paidReq = await requester.module.sendPaymentRequest(PAYER.chainPubkey, { amount: '1', coinId: UCT, message: 'invoice 1' });
    const declinedReq = await requester.module.sendPaymentRequest(PAYER.chainPubkey, { amount: '2', coinId: UCT });
    const openReq = await requester.module.sendPaymentRequest(PAYER.chainPubkey, { amount: '3', coinId: UCT });

    // Session 1: surface all three, then RESOLVE two (pay one, decline one).
    await payer.module.load();
    await payer.module.syncPaymentRequests();
    expect(payer.module.getPaymentRequests()).toHaveLength(3);
    await payer.module.payPaymentRequest(paidReq.requestId!);
    await payer.module.rejectPaymentRequest(declinedReq.requestId!);
    expect(fake.getPaymentRequest(paidReq.requestId!)).toMatchObject({ status: 'paid' });
    expect(fake.getPaymentRequest(declinedReq.requestId!)).toMatchObject({ status: 'declined' });

    // Reopen: a fresh module over the SAME persisted stateStore/providers. The
    // cursor (now past all seqs) is persisted, but the surfaced list is
    // in-memory — pre-#556 only the still-open `openReq` survived, and the
    // resolved paid/declined requests VANISHED. The #556 full `since=0`
    // hydration must rebuild the CURRENT state of ALL incoming requests.
    const reopened = createPaymentsModule({ l1: null });
    reopened.initialize({ ...payer.deps });
    cleanups.push(() => reopened.destroy());
    const reNotified: IncomingPaymentRequest[] = [];
    reopened.onPaymentRequest((r) => reNotified.push(r));
    await reopened.load();
    await reopened.syncPaymentRequests();

    // J12: the resolved requests are PRESENT with their resolved status…
    const byId = new Map(reopened.getPaymentRequests().map((r) => [r.id, r]));
    expect(byId.size).toBe(3);
    expect(byId.get(paidReq.requestId!)?.status).toBe('paid');
    expect(byId.get(declinedReq.requestId!)?.status).toBe('rejected');
    // …and the still-open one re-hydrates as actionable (pending).
    expect(byId.get(openReq.requestId!)?.status).toBe('pending');
    // The resolved request's decrypted memo survives the reload (#554/dev.12).
    expect(byId.get(paidReq.requestId!)?.message).toBe('invoice 1');

    // Re-notification guard: the reopened module's new-incoming handler fires
    // ONLY for the still-open request — never for the paid/declined ones (the
    // hydration folds resolved requests into the list silently, #556). The
    // handler is registered on the reopened module alone, so it observes only
    // this session's notifications.
    expect(reNotified.map((r) => r.id)).toEqual([openReq.requestId]);

    // The tail still works from the persisted cursor: a NEW request arrives,
    // notifies, and does not disturb the hydrated resolved rows.
    const fresh = await requester.module.sendPaymentRequest(PAYER.chainPubkey, { amount: '4', coinId: UCT });
    await reopened.syncPaymentRequests();
    expect(reopened.getPaymentRequests().map((r) => r.id).sort()).toEqual(
      [paidReq.requestId, declinedReq.requestId, openReq.requestId, fresh.requestId].sort()
    );
    expect(reNotified.map((r) => r.id).sort()).toEqual([openReq.requestId, fresh.requestId].sort());
  });

  it('cross-session: a request resolved in one window re-surfaces resolved in another via the ?since= delta + fires the resolution event (§16 upsert)', async () => {
    const { fake, baseUrl } = await startFake();
    const requester = makeWalletApiWallet(baseUrl, fake.network, REQUESTER, 'pr-x1');
    const windowA = makeWalletApiWallet(baseUrl, fake.network, PAYER, 'pr-xa');
    const windowB = makeWalletApiWallet(baseUrl, fake.network, PAYER, 'pr-xb'); // SAME wallet, 2nd window

    // The requester has a nametag — it rides INSIDE the S6 memo envelope, so the
    // payer renders "@requester" in the request's "From" field rather than a raw
    // pubkey. It must SURVIVE the cross-session upsert (the staging report: the
    // request flipped to paid in both windows but the "From" field regressed to
    // the raw pubkey on the resolved row).
    await requester.module.setNametag({
      name: 'api-1', token: {}, timestamp: Date.now(), format: 'txf', version: '2.0',
    });

    const created = await requester.module.sendPaymentRequest(PAYER.chainPubkey, { amount: '5', coinId: UCT, message: 'cross-session' });
    expect(created.success).toBe(true);

    // Both windows surface it as actionable (pending), each from its own since=0 bootstrap.
    await windowA.module.load();
    await windowA.module.syncPaymentRequests();
    await windowB.module.load();
    await windowB.module.syncPaymentRequests();
    expect(windowA.module.getPaymentRequests({ status: 'pending' })).toHaveLength(1);
    expect(windowB.module.getPaymentRequests({ status: 'pending' })).toHaveLength(1);
    // Both windows decrypt the requester's nametag from the memo envelope while pending.
    expect(windowA.module.getPaymentRequests({ status: 'pending' })[0].senderNametag).toBe('api-1');
    expect(windowB.module.getPaymentRequests({ status: 'pending' })[0].senderNametag).toBe('api-1');

    // Window A declines it — the server respond re-stamps the payer's seq (PR-A).
    await windowA.module.rejectPaymentRequest(created.requestId!);
    expect(fake.getPaymentRequest(created.requestId!)).toMatchObject({ status: 'declined' });

    // Window B's NEXT poll is a DELTA from its own cursor; the resolved row re-surfaces at a
    // higher seq. B upserts it in place (pending → rejected) and FIRES the resolution event, so
    // its UI drops the dead request. Pre-fix B early-returned on the dup id and stayed pending.
    windowB.emitEvent.mockClear();
    await windowB.module.syncPaymentRequests();

    const onB = windowB.module.getPaymentRequests();
    expect(onB).toHaveLength(1);
    expect(onB[0].status).toBe('rejected'); // upserted, not frozen at first-seen 'pending'
    // The status-only upsert must NOT clear the nametag/message the request was
    // first surfaced with — the "From" field stays "@api-1" on the resolved row
    // (the staging regression: "shows pubkey" == senderNametag lost on resolve).
    expect(onB[0].senderNametag).toBe('api-1');
    expect(onB[0].message).toBe('cross-session');
    expect(windowB.module.getPaymentRequests({ status: 'pending' })).toHaveLength(0);
    expect(windowB.module.getPendingPaymentRequestsCount()).toBe(0);
    expect(windowB.emitEvent.mock.calls.some((c) => c[0] === 'payment_request:rejected')).toBe(true);
    // …and it must NOT re-fire 'incoming' for an already-surfaced request.
    expect(windowB.emitEvent.mock.calls.some((c) => c[0] === 'payment_request:incoming')).toBe(false);

    // The resolution event payload itself carries the nametag (the UI re-renders
    // the action card from it), proving the upsert mutated status in place
    // without dropping the counterparty identity.
    const rejectedEvent = windowB.emitEvent.mock.calls.find((c) => c[0] === 'payment_request:rejected');
    expect((rejectedEvent?.[1] as IncomingPaymentRequest | undefined)?.senderNametag).toBe('api-1');
  });

  it('a request first SEEN already-resolved (existing===undefined, status≠open) still decrypts the requester nametag/memo (#553 twin on the resolved path)', async () => {
    const { fake, baseUrl } = await startFake();
    const requester = makeWalletApiWallet(baseUrl, fake.network, REQUESTER, 'pr-r1');
    const payer = makeWalletApiWallet(baseUrl, fake.network, PAYER, 'pr-r2');
    await requester.module.setNametag({
      name: 'api-1', token: {}, timestamp: Date.now(), format: 'txf', version: '2.0',
    });

    // The request is created AND declined before this payer session ever surfaces
    // it — so its FIRST sight of the row is already-resolved (the cross-session
    // case where a window opens after the other already paid/declined). This
    // takes the `existing===undefined` branch of surfaceIncomingPaymentRequest
    // with a terminal status, which DOES decrypt the memo envelope.
    const created = await requester.module.sendPaymentRequest(PAYER.chainPubkey, { amount: '9', coinId: UCT, message: 'already done' });
    expect(created.success).toBe(true);
    await payer.module.load();
    await payer.module.syncPaymentRequests();
    await payer.module.rejectPaymentRequest(created.requestId!);
    expect(fake.getPaymentRequest(created.requestId!)).toMatchObject({ status: 'declined' });

    // A brand-new session of the SAME payer (a freshly-opened third window) sees
    // the resolved row for the first time via its own since=0 bootstrap.
    const fresh = makeWalletApiWallet(baseUrl, fake.network, PAYER, 'pr-r3');
    await fresh.module.load();
    await fresh.module.syncPaymentRequests();

    const surfaced = fresh.module.getPaymentRequests();
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0].status).toBe('rejected');
    // The "From" field renders "@api-1" even though the row was first seen
    // already-resolved — the memo envelope is decrypted on the resolved path too.
    expect(surfaced[0].senderNametag).toBe('api-1');
    expect(surfaced[0].message).toBe('already done');
  });

  it('a failed hydration is retried on the next pump (the flag is burned only on success)', async () => {
    const { fake, baseUrl } = await startFake();
    const requester = makeWalletApiWallet(baseUrl, fake.network, REQUESTER, 'pr-8');
    const payer = makeWalletApiWallet(baseUrl, fake.network, PAYER, 'pr-9');
    const created = await requester.module.sendPaymentRequest(PAYER.chainPubkey, { amount: '7', coinId: UCT });

    // First session advances the persisted cursor past the open request.
    await payer.module.load();
    await payer.module.syncPaymentRequests();
    expect(payer.module.getPaymentRequests()).toHaveLength(1);

    // Restarted session: the #556 full `since=0` hydration (the FIRST list
    // call of the session) hits a transient outage.
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
    const fake = new FakeWalletApi({ decodeAssets: decodeFakeTokenAssets, decodeTokenId: decodeFakeTokenId, maxPayerOpenRequests: 1 });
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
