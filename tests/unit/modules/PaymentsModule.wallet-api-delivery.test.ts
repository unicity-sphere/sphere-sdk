/**
 * PaymentsModule × wallet-api delivery (sdk-changes S2 consumer update + S3 +
 * S4 presets), end-to-end against the in-process fake backend:
 *
 * - SEND (full preset, custody 'inventory'): coin-selection from the lazy
 *   inventory view → awaited putIntent (E.3) → getToken only for selected
 *   sources → engine → deliver via the mailbox port → ONE applyDelta carrying
 *   the send's transferId → completeIntent → dedupKey'd history POST (§10);
 * - INCOMING: mailbox pull feeds the transport-agnostic handleV2Transfer;
 *   verified tokens are claimed (§6 handoff), locally-unverifiable ones are
 *   rejected + surfaced as `transfer:invalid`, and discovery continues;
 * - interrupted-deposit REPLAY on next load (S3 AC): idempotent by the
 *   content-derived entry_id — succeeds even after the recipient claimed;
 * - OWN-STORAGE preset (S7 AC): custody stays in app storage; the sender's
 *   send closes via intents/complete alone; the recipient performs ZERO
 *   inventory writes;
 * - E.3 RESUME: an open intent re-runs deterministically and completes.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPaymentsModule, type PaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { FullIdentity } from '../../../types';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase, HistoryRecord } from '../../../storage';
import { FakeTokenEngine, decodeFakeTokenAssets, decodeFakeTokenId } from '../token-engine/FakeTokenEngine';
import { TransferConflictError, ProofUnconfirmedError, SplitCheckpointLostError } from '../../../token-engine';
import { PartialSendConflictError } from '../../../core/errors';
import { FakeWalletApi } from '../../support/fake-wallet-api';
import { MemoryKeyValueStore, testIdentity } from '../../support/wallet-api-test-helpers';
import { WalletApiClient, WalletApiError } from '../../../wallet-api';
import { WalletApiMailboxProvider, WalletApiTokenStorageProvider } from '../../../impl/shared/wallet-api';
import { encodeTokenBlob } from '../../../token-engine/token-blob';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { deriveFieldEncryptionKey, decryptField, encryptField, FIELD_ENVELOPE_PREFIX } from '../../../core/field-encryption';

const UCT = '11'.repeat(32);
const SENDER = testIdentity(11);
const RECIPIENT = testIdentity(12);
const STRANGER = testIdentity(13);

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

/** Local whole-blob provider mock (the own-storage composition). */
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

function mockTransport(): TransportProvider {
  return {
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue({
      chainPubkey: RECIPIENT.chainPubkey,
      transportPubkey: RECIPIENT.chainPubkey.slice(2),
      directAddress: 'DIRECT://bob',
      nametag: 'bob',
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
  delivery: WalletApiMailboxProvider;
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

/** Build a wallet over the FULL wallet-api preset (storage + delivery, custody 'inventory').
 * Pass `kv` to share the persisted client/provider state across instances — a
 * reloaded tab keeps its localStorage (cursor, session), not its process state. */
function makeFullPresetWallet(
  baseUrl: string,
  network: string,
  who: { privateKey: string; chainPubkey: string },
  deviceId: string,
  kv: MemoryKeyValueStore = new MemoryKeyValueStore()
): Wallet {
  const identity = fullIdentity(who);
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
  return { module, engine, client, delivery, emitEvent, storage, deps };
}

/** Build a wallet over the OWN-STORAGE preset (local custody + mailbox delivery 'external'). */
function makeOwnStorageWallet(
  baseUrl: string,
  network: string,
  who: { privateKey: string; chainPubkey: string },
  deviceId: string
): Wallet {
  const identity = fullIdentity(who);
  const kv = new MemoryKeyValueStore();
  const client = new WalletApiClient({ baseUrl, network, deviceId, storage: kv });
  const delivery = new WalletApiMailboxProvider({ client, custody: 'external', stateStore: kv });
  const engine = new FakeTokenEngine({ chainPubkey: hexToBytes(who.chainPubkey) });
  const storage = mockStorage();
  const emitEvent = vi.fn();
  const deps: PaymentsModuleDependencies = {
    identity,
    storage: storage.provider,
    tokenStorageProviders: new Map([['local', mockLocalTokenStorage()]]),
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
  return { module, engine, client, delivery, emitEvent, storage, deps };
}

/** Mint a token on the wallet's engine and seed it into its SERVER inventory. */
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

describe('send — full wallet-api preset (S2 consumer + S3 + §7 pipeline)', () => {
  it('plans from the lazy view, then putIntent → deliver → applyDelta → completeIntent → history', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-send-1');
    const sourceTokenId = await seedServerToken(fake, sender, SENDER, 1000n);

    await sender.module.load();

    // S2: balances render from the inventory VIEW — a lazy record, no blob.
    const lazy = sender.module.getTokens();
    expect(lazy).toHaveLength(1);
    expect(lazy[0]).toMatchObject({ id: `v2_${sourceTokenId}`, amount: '1000', status: 'confirmed', lazy: true });
    expect(lazy[0].sdkData).toBeUndefined();

    const result = await sender.module.send({ recipient: '@bob', amount: '1000', coinId: UCT, memo: 'lunch' });
    expect(result.status).toBe('completed');

    // Mailbox deposit carries the send's transferId (entries group by it — §7).
    const entries = fake.listMailboxEntries(RECIPIENT.chainPubkey);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: 'unclaimed', transferId: result.id, tokenId: sourceTokenId });

    // §5.3: the source removal is EVIDENCED by the deposit of the same transferId.
    expect(fake.getRow(SENDER.chainPubkey, sourceTokenId)).toMatchObject({
      status: 'removed',
      removal: 'evidenced',
    });

    // E.3: the intent is completed (apply completed it server-side; the
    // uniform close is an idempotent no-op on top).
    expect(fake.getIntent(SENDER.chainPubkey, result.id)).toMatchObject({ status: 'completed' });

    // §10: the dedupKey'd SENT record was POSTed with an ENCRYPTED memo.
    const history = fake.getHistoryRecords(SENDER.chainPubkey);
    const sent = history.find((r) => r.dedupKey === `SENT_transfer_${result.id}`);
    expect(sent).toBeDefined();
    expect(sent).toMatchObject({ type: 'SENT', assets: [{ coinId: UCT, amount: '1000' }] });
    expect((sent!.memo as string).startsWith(FIELD_ENVELOPE_PREFIX)).toBe(true);
    expect(sent!.memo).not.toContain('lunch');
  });

  it('a post-commit apply failure surfaces as SEND_SYNC_PENDING, not a hard failure (#665)', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-665');
    await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();

    // The on-chain spend certifies first; then fail the post-commit wallet-api
    // apply (persistently — outlasting the #664 retry). The money already
    // moved on-chain, only the server-mirror sync failed.
    const cause = new WalletApiError('inventory/apply failed', 'NETWORK');
    sender.client.applyInventoryDelta = async () => {
      throw cause;
    };

    const err = await sender.module
      .send({ recipient: '@bob', amount: '1000', coinId: UCT })
      .then(() => { throw new Error('expected send to reject'); }, (e: unknown) => e);
    expect(err).toMatchObject({ code: 'SEND_SYNC_PENDING', cause });

    // #441 stamp: the possibly-committed error carries the committing attempt's
    // transferId, and it names a real OPEN intent on the server (the id resume
    // will complete). A payment-request consumer journals this link.
    const stampedId = (err as { transferId?: string }).transferId;
    expect(typeof stampedId).toBe('string');
    expect(fake.getIntent(SENDER.chainPubkey, stampedId!)).toMatchObject({ status: 'open' });

    // Not a lost payment: transfer:failed must NOT be emitted for a sync-pending.
    const failed = sender.emitEvent.mock.calls.filter((c) => c[0] === 'transfer:failed');
    expect(failed).toHaveLength(0);
  });

  it('a PRE-commit failure is still a hard failure (transfer:failed), not sync-pending', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-665b');
    await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();

    // putIntent runs FIRST, before any on-chain submit — a failure here is a
    // genuine pre-commit send failure and must NOT be re-tagged sync-pending.
    sender.client.putIntent = async () => {
      throw new WalletApiError('putIntent failed', 'NETWORK');
    };

    await expect(
      sender.module.send({ recipient: '@bob', amount: '1000', coinId: UCT }),
    ).rejects.not.toMatchObject({ code: 'SEND_SYNC_PENDING' });
    const failed = sender.emitEvent.mock.calls.filter((c) => c[0] === 'transfer:failed');
    expect(failed.length).toBeGreaterThan(0);
  });

  it('an OWN-STORAGE post-commit failure stays a hard failure, NOT SEND_SYNC_PENDING (#665 scope, Copilot #669)', async () => {
    // No wallet-api inventory mirror in own-storage custody, so a post-commit
    // LOCAL persistence failure must NOT be re-tagged sync-pending (there is no
    // server mirror to "catch up") — it stays a normal failure.
    const { fake, baseUrl } = await startFake();
    const sender = makeOwnStorageWallet(baseUrl, fake.network, SENDER, 'd-665c');
    await sender.module.load();
    await sender.module.mintFungibleToken(UCT, 1000n); // token exists BEFORE we break save

    const local = sender.deps.tokenStorageProviders.get('local')!;
    local.save = vi.fn(async () => ({ success: false, error: 'local save failed', timestamp: 0 }));

    await expect(
      sender.module.send({ recipient: '@bob', amount: '1000', coinId: UCT }),
    ).rejects.not.toMatchObject({ code: 'SEND_SYNC_PENDING' });
    const failed = sender.emitEvent.mock.calls.filter((c) => c[0] === 'transfer:failed');
    expect(failed.length).toBeGreaterThan(0);
  });

  it('a split send uploads the change output and applies it in the SAME delta (700 stays)', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-send-2');
    const sourceTokenId = await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();

    const result = await sender.module.send({ recipient: '@bob', amount: '300', coinId: UCT });
    expect(result.status).toBe('completed');

    // Server-side: source tombstoned (evidenced via the change in `added`),
    // change row active — the balance is exactly the 700 remainder.
    expect(fake.getRow(SENDER.chainPubkey, sourceTokenId)).toMatchObject({ status: 'removed', removal: 'evidenced' });
    const balances = await sender.client.getBalances();
    expect(balances).toEqual([{ coinId: UCT, total: 700n, tokenCount: 1 }]);

    // Recipient got exactly one 300 deposit under this transferId.
    const entries = fake.listMailboxEntries(RECIPIENT.chainPubkey);
    expect(entries).toHaveLength(1);
    expect(entries[0].transferId).toBe(result.id);

    // Locally the change token is a full (non-lazy) confirmed record.
    const change = sender.module.getTokens().find((t) => t.amount === '700');
    expect(change?.status).toBe('confirmed');
    expect(change?.sdkData).toBeDefined();
  });

  it('putIntent is awaited BEFORE the engine: an intent-endpoint outage fails the send with nothing spent', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-send-3');
    const sourceTokenId = await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();
    const transferSpy = vi.spyOn(sender.engine, 'transfer');

    fake.setIntentFailure(true);
    await expect(sender.module.send({ recipient: '@bob', amount: '1000', coinId: UCT })).rejects.toThrow();
    fake.setIntentFailure(false);

    // E.3: the engine MUST NOT run before the server acks the intent.
    expect(transferSpy).not.toHaveBeenCalled();
    expect(fake.getRow(SENDER.chainPubkey, sourceTokenId)).toMatchObject({ status: 'active' });
    expect(fake.listMailboxEntries(RECIPIENT.chainPubkey)).toHaveLength(0);
    // The source is restored locally and spendable again.
    expect(sender.module.getTokens()[0].status).toBe('confirmed');
  });
});

describe('incoming — claim/reject batched per page (#623)', () => {
  it('receive() of N entries issues ONE claimMailbox call carrying all ids, not N', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-batch-1');
    const N = 5;
    for (let i = 0; i < N; i += 1) await seedServerToken(fake, sender, SENDER, 100n);
    await sender.module.load();
    for (let i = 0; i < N; i += 1) await sender.module.send({ recipient: '@bob', amount: '100', coinId: UCT });
    expect(fake.listMailboxEntries(RECIPIENT.chainPubkey)).toHaveLength(N);

    const recipient = makeFullPresetWallet(baseUrl, fake.network, RECIPIENT, 'd-batch-2');
    await recipient.module.load();
    const claimSpy = vi.spyOn(recipient.client, 'claimMailbox');

    const { transfers } = await recipient.module.receive();
    expect(transfers).toHaveLength(N);

    // The whole page is claimed in ONE request carrying all N ids (was N requests of 1 before #623).
    expect(claimSpy).toHaveBeenCalledTimes(1);
    expect(claimSpy.mock.calls[0][0]).toHaveLength(N);
    expect(fake.listMailboxEntries(RECIPIENT.chainPubkey).every((e) => e.status === 'claimed')).toBe(true);
  });

  it('a mixed page batches valid claims and invalid rejects into one request each', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-mix-1');
    await seedServerToken(fake, sender, SENDER, 100n);
    await seedServerToken(fake, sender, SENDER, 100n);
    await sender.module.load();
    await sender.module.send({ recipient: '@bob', amount: '100', coinId: UCT });
    await sender.module.send({ recipient: '@bob', amount: '100', coinId: UCT });
    // A stranger deposits a token locked to ITSELF → the recipient can't verify ownership → rejected.
    const stranger = makeFullPresetWallet(baseUrl, fake.network, STRANGER, 'd-mix-str');
    const strangerToken = await stranger.engine.mint({
      recipientPubkey: stranger.engine.getIdentity().chainPubkey,
      value: { assets: [{ coinId: UCT, amount: 100n }] },
    });
    const badBytes = encodeTokenBlob(stranger.engine.encodeToken(strangerToken));
    stranger.delivery.setIdentity(STRANGER);
    await stranger.delivery.deliver(RECIPIENT.chainPubkey, badBytes, { transferId: crypto.randomUUID() });
    expect(fake.listMailboxEntries(RECIPIENT.chainPubkey)).toHaveLength(3);

    const recipient = makeFullPresetWallet(baseUrl, fake.network, RECIPIENT, 'd-mix-2');
    await recipient.module.load();
    const claimSpy = vi.spyOn(recipient.client, 'claimMailbox');
    const rejectSpy = vi.spyOn(recipient.client, 'rejectMailbox');

    await recipient.module.receive();

    expect(claimSpy).toHaveBeenCalledTimes(1);
    expect(claimSpy.mock.calls[0][0]).toHaveLength(2); // two valid
    expect(rejectSpy).toHaveBeenCalledTimes(1);
    expect(rejectSpy.mock.calls[0][0]).toHaveLength(1); // one invalid
    expect(recipient.emitEvent.mock.calls.some((c) => c[0] === 'transfer:invalid')).toBe(true);
  });
});

describe('incoming — mailbox pull feeds handleV2Transfer (S3)', () => {
  it('receive(): fetch → local verify → store → ack claimed (handoff) → RECEIVED history POST carrying the sender nametag + memo', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-in-1');
    const sourceTokenId = await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();
    // The sender has a nametag — it must reach the recipient as the RECEIVED
    // record's counterparty identity (fixes "Someone"); the memo must arrive
    // decrypted (fixes the dropped memo). Set AFTER load so it survives to send.
    await sender.module.setNametag({
      name: 'api-1', token: {}, timestamp: Date.now(), format: 'txf', version: '2.0',
    });
    const result = await sender.module.send({ recipient: '@bob', amount: '1000', coinId: UCT, memo: 'hi' });

    const recipient = makeFullPresetWallet(baseUrl, fake.network, RECIPIENT, 'd-in-2');
    await recipient.module.load();
    const { transfers } = await recipient.module.receive();

    expect(transfers).toHaveLength(1);
    expect(transfers[0].tokens[0]).toMatchObject({ amount: '1000', coinId: UCT, status: 'confirmed' });

    // §6 handoff: entry claimed into inventory; the recipient owns the row.
    const entry = fake.listMailboxEntries(RECIPIENT.chainPubkey)[0];
    expect(fake.getMailboxEntry(RECIPIENT.chainPubkey, entry.entryId)).toMatchObject({
      status: 'claimed',
      intoInventory: true,
    });
    expect(fake.getRow(RECIPIENT.chainPubkey, sourceTokenId)).toMatchObject({ status: 'active' });

    // transfer:incoming fired carrying the sender's nametag + memo (bug A + B).
    const incomingEvent = recipient.emitEvent.mock.calls.find((c) => c[0] === 'transfer:incoming');
    expect(incomingEvent).toBeDefined();
    expect(incomingEvent![1]).toMatchObject({ senderNametag: 'api-1', memo: 'hi' });

    // §10: the RECEIVED record was POSTed; its counterparty nametag + memo are
    // S6 envelopes (operator-blind), decryptable by the recipient (self-scoped
    // at rest). The nametag came from the delivery envelope, NOT the broken
    // Nostr chain-pubkey lookup.
    const received = fake
      .getHistoryRecords(RECIPIENT.chainPubkey)
      .find((r) => (r.dedupKey as string).startsWith('RECEIVED_'));
    expect(received).toBeDefined();
    expect((received!.counterpartyNametag as string).startsWith(FIELD_ENVELOPE_PREFIX)).toBe(true);
    expect((received!.memo as string).startsWith(FIELD_ENVELOPE_PREFIX)).toBe(true);
    const recipientFieldKey = deriveFieldEncryptionKey(RECIPIENT.privateKey);
    expect(decryptField(recipientFieldKey, received!.counterpartyNametag as string)).toBe('api-1');
    expect(decryptField(recipientFieldKey, received!.memo as string)).toBe('hi');
    expect(result.id).toBeDefined();
  });

  it('a locally-unverifiable delivery is REJECTED, surfaced as transfer:invalid, and discovery continues', async () => {
    const { fake, baseUrl } = await startFake();

    // A token locked to a STRANGER, deposited into the recipient's mailbox —
    // the fake backend accepts it (its §8.2 step-5 ownership check is an
    // APPROXIMATION gap), exactly the server/client validation skew the
    // reject flow exists for.
    const strangerWallet = makeFullPresetWallet(baseUrl, fake.network, STRANGER, 'd-in-3');
    const strangerToken = await strangerWallet.engine.mint({
      recipientPubkey: strangerWallet.engine.getIdentity().chainPubkey,
      value: { assets: [{ coinId: UCT, amount: 5n }] },
    });
    const badBytes = encodeTokenBlob(strangerWallet.engine.encodeToken(strangerToken));
    strangerWallet.delivery.setIdentity(STRANGER);
    const { deliveryId: badId } = await strangerWallet.delivery.deliver(RECIPIENT.chainPubkey, badBytes, {
      transferId: 'tf-bad',
    });

    // A legitimate delivery arrives AFTER the bad one.
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-in-4');
    await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();
    await sender.module.send({ recipient: '@bob', amount: '1000', coinId: UCT });

    const recipient = makeFullPresetWallet(baseUrl, fake.network, RECIPIENT, 'd-in-5');
    await recipient.module.load();
    const { transfers } = await recipient.module.receive();

    // The bad entry is rejected — terminal for discovery only (§6) — and
    // surfaced as an invalid incoming payment…
    expect(fake.getMailboxEntry(RECIPIENT.chainPubkey, badId)).toMatchObject({ status: 'rejected' });
    const invalid = recipient.emitEvent.mock.calls.find((c) => c[0] === 'transfer:invalid');
    expect(invalid).toBeDefined();
    expect(invalid![1]).toMatchObject({ deliveryId: badId, reason: 'not-owned' });

    // …while the good delivery right behind it was processed (no wedged pointer).
    expect(transfers).toHaveLength(1);
    expect(transfers[0].tokens[0].amount).toBe('1000');
  });
});

describe('interrupted deposit — journal replay on next load (S3 AC)', () => {
  it('a deposit that failed after certification replays on load and lands in the mailbox', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-rp-1');
    await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();

    // Deliver fails once (mailbox outage) AFTER the engine certified. Covenant §3.1 (#621):
    // a post-certification delivery failure must NOT fail the sender — the send resolves
    // delivery-pending and the journaled blob lands on the next load's replay.
    const realDeliver = sender.delivery.deliver.bind(sender.delivery);
    let failures = 1;
    vi.spyOn(sender.delivery, 'deliver').mockImplementation((a, b, c) =>
      failures-- > 0 ? Promise.reject(new Error('mailbox down')) : realDeliver(a, b, c)
    );

    const result = await sender.module.send({ recipient: '@bob', amount: '1000', coinId: UCT });
    expect(result.status).not.toBe('failed');
    expect(result.deliveryPending).toBe(true);

    // The finished blob is journaled; nothing reached the mailbox yet; the
    // source is terminal 'spent' locally (certified on-chain).
    const journalRaw = sender.storage.map.get('pending_v2_deliveries');
    expect(JSON.parse(journalRaw!)).toHaveLength(1);
    expect(fake.listMailboxEntries(RECIPIENT.chainPubkey)).toHaveLength(0);

    // "Restart": a fresh module over the SAME storage + providers replays the
    // journal from load() — the deposit lands.
    const second = createPaymentsModule({ l1: null });
    second.initialize({ ...sender.deps });
    cleanups.push(() => second.destroy());
    await second.load();
    await vi.waitFor(() => {
      expect(fake.listMailboxEntries(RECIPIENT.chainPubkey)).toHaveLength(1);
    });
    const journalAfter = sender.storage.map.get('pending_v2_deliveries');
    expect(JSON.parse(journalAfter ?? '[]')).toHaveLength(0);
  });

  it('replay is idempotent by entry_id and succeeds even AFTER the recipient claimed', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-rp-2');
    await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();

    // Capture the delivered blob so the test can re-journal it (simulating a
    // crash between the deposit and the journal removal).
    let deliveredBlob: Uint8Array | null = null;
    const realDeliver = sender.delivery.deliver.bind(sender.delivery);
    vi.spyOn(sender.delivery, 'deliver').mockImplementation((a, b, c) => {
      deliveredBlob = b;
      return realDeliver(a, b, c);
    });
    const result = await sender.module.send({ recipient: '@bob', amount: '1000', coinId: UCT });
    expect(deliveredBlob).not.toBeNull();

    // Recipient claims.
    const recipient = makeFullPresetWallet(baseUrl, fake.network, RECIPIENT, 'd-rp-3');
    await recipient.module.load();
    await recipient.module.receive();
    const entry = fake.listMailboxEntries(RECIPIENT.chainPubkey)[0];
    expect(entry.status).toBe('claimed');

    // Crash-simulated journal entry for the SAME blob; replay must succeed
    // (200 with the same entry_id — §6), not error, and clear the journal.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    await (sender.module as any).savePendingV2Delivery({
      transferId: result.id,
      recipientPubkey: RECIPIENT.chainPubkey,
      tokenBlob: bytesToHex(deliveredBlob!),
      createdAt: Date.now(),
    });
    await (sender.module as any).replayPendingV2Deliveries();
    /* eslint-enable @typescript-eslint/no-explicit-any */

    expect(JSON.parse(sender.storage.map.get('pending_v2_deliveries') ?? '[]')).toHaveLength(0);
    expect(fake.listMailboxEntries(RECIPIENT.chainPubkey)).toHaveLength(1);
    expect(fake.getMailboxEntry(RECIPIENT.chainPubkey, entry.entryId)).toMatchObject({ status: 'claimed' });
  });
});

describe('recipient-side 429 must NOT fail the sender (covenant §3.1 — issue #621)', () => {
  it('a recipient unclaimed-cap 429 after certification RESOLVES the send (deliveryPending), source spent, blob journaled', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-quota-1');
    await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();

    // The recipient's mailbox is FULL (§5.5 unclaimed cap). The deposit 429s AFTER the
    // engine certified — exactly the recipient-side condition that must never fail the sender.
    vi.spyOn(sender.delivery, 'deliver').mockRejectedValue(
      new WalletApiError('per-recipient unclaimed+rejected entries exceed (§5.5)', 'RATE_LIMITED', 429),
    );

    // Covenant: the sender certified, the token is the recipient's on-chain — the send RESOLVES.
    const result = await sender.module.send({ recipient: '@bob', amount: '1000', coinId: UCT });
    expect(result.status).not.toBe('failed');
    expect(result.deliveryPending).toBe(true);

    // Source is terminally spent (never re-spendable); the finished blob stays journaled for re-delivery;
    // nothing reached the recipient's mailbox yet.
    const lazy = sender.module.getTokens();
    expect(lazy.some((t) => t.status === 'confirmed')).toBe(false);
    expect(JSON.parse(sender.storage.map.get('pending_v2_deliveries') ?? '[]')).toHaveLength(1);
    expect(fake.listMailboxEntries(RECIPIENT.chainPubkey)).toHaveLength(0);
  });

  it('after the recipient drains, a journal replay deposits the blob and clears the journal', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-quota-2');
    await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();

    const realDeliver = sender.delivery.deliver.bind(sender.delivery);
    let quotaFull = true;
    vi.spyOn(sender.delivery, 'deliver').mockImplementation((a, b, c) =>
      quotaFull
        ? Promise.reject(new WalletApiError('quota (§5.5)', 'RATE_LIMITED', 429))
        : realDeliver(a, b, c),
    );

    const result = await sender.module.send({ recipient: '@bob', amount: '1000', coinId: UCT });
    expect(result.deliveryPending).toBe(true);
    expect(fake.listMailboxEntries(RECIPIENT.chainPubkey)).toHaveLength(0);

    // Recipient drains → the deferred blob lands on the next replay; journal clears.
    quotaFull = false;
    /* eslint-disable @typescript-eslint/no-explicit-any */
    await (sender.module as any).replayPendingV2Deliveries();
    /* eslint-enable @typescript-eslint/no-explicit-any */
    expect(fake.listMailboxEntries(RECIPIENT.chainPubkey)).toHaveLength(1);
    expect(JSON.parse(sender.storage.map.get('pending_v2_deliveries') ?? '[]')).toHaveLength(0);
  });
});

describe('journaled-delivery replay: bounded backoff + poison surfacing (#517 item 1)', () => {
  it('a persistently-undeliverable blob is SURFACED as poison after the bounded budget, then no longer auto-retried', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-poison-1');
    await sender.module.load();

    // Drive the backoff loop without waiting real time.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (sender.module as any).replayBackoffBaseMs = 0;

    // A journaled finished blob whose delivery ALWAYS fails (a wrong/rotated
    // recipient key, a permanently-rejecting rail — the "poison" class).
    const deliverSpy = vi.spyOn(sender.delivery, 'deliver').mockRejectedValue(new Error('rail rejects: bad recipient'));
    await (sender.module as any).savePendingV2Delivery({
      transferId: 'poison-tx',
      recipientPubkey: RECIPIENT.chainPubkey,
      tokenBlob: 'aa'.repeat(40),
      createdAt: Date.now(),
    });

    // Each replay pass bumps the cumulative attempt count by 1; the entry stays
    // journaled (un-poisoned) and NOT surfaced until the budget is crossed.
    const budget = 6; // MAX_DELIVERY_REPLAY_ATTEMPTS
    for (let i = 0; i < budget - 1; i++) {
      await (sender.module as any).replayPendingV2Deliveries();
      const journal = JSON.parse(sender.storage.map.get('pending_v2_deliveries')!);
      expect(journal).toHaveLength(1);
      expect(journal[0].undeliverable).toBeUndefined();
      expect(journal[0].attempts).toBe(i + 1);
    }
    expect(sender.emitEvent.mock.calls.filter((c) => c[0] === 'delivery:undeliverable')).toHaveLength(0);

    // The pass that crosses the budget surfaces it as poison — ONE event,
    // entry kept journaled but flagged so it does not sit undelivered invisibly.
    await (sender.module as any).replayPendingV2Deliveries();
    const poisonCalls = sender.emitEvent.mock.calls.filter((c) => c[0] === 'delivery:undeliverable');
    expect(poisonCalls).toHaveLength(1);
    expect(poisonCalls[0][1]).toMatchObject({ transferId: 'poison-tx', recipientPubkey: RECIPIENT.chainPubkey, attempts: budget });
    expect(poisonCalls[0][1].error).toContain('rail rejects');
    const poisoned = JSON.parse(sender.storage.map.get('pending_v2_deliveries')!);
    expect(poisoned).toHaveLength(1);
    expect(poisoned[0]).toMatchObject({ undeliverable: true, attempts: budget });

    // Poison is terminal for auto-replay: a further pass touches the rail no more
    // and emits no duplicate surfacing.
    const deliverCallsBefore = deliverSpy.mock.calls.length;
    await (sender.module as any).replayPendingV2Deliveries();
    expect(deliverSpy.mock.calls.length).toBe(deliverCallsBefore);
    expect(sender.emitEvent.mock.calls.filter((c) => c[0] === 'delivery:undeliverable')).toHaveLength(1);
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });

  it('two overlapping replay passes deliver each journaled entry ONCE — the in-flight guard serializes them', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-concurrent-1');
    await sender.module.load();

    /* eslint-disable @typescript-eslint/no-explicit-any */
    // One journaled finished blob; delivery resolves so a pass delivers + clears it.
    const deliverSpy = vi
      .spyOn(sender.delivery, 'deliver')
      .mockResolvedValue({ deliveryId: 'concurrent-d1' } as any);
    await (sender.module as any).savePendingV2Delivery({
      transferId: 'concurrent-tx',
      recipientPubkey: RECIPIENT.chainPubkey,
      tokenBlob: 'bb'.repeat(40),
      createdAt: Date.now(),
    });

    // Kick TWO passes WITHOUT awaiting between them — mirrors load()'s fire-and-
    // forget replay racing a receive()→load(). The guard (set synchronously before
    // the first await) must drop the second pass.
    const p1 = (sender.module as any).replayPendingV2Deliveries();
    const p2 = (sender.module as any).replayPendingV2Deliveries();
    await Promise.all([p1, p2]);
    /* eslint-enable @typescript-eslint/no-explicit-any */

    // Delivered exactly once. RED without the guard: 2 — both passes read the same
    // journal snapshot and re-deliver (and race the per-entry attempts RMW).
    expect(deliverSpy.mock.calls).toHaveLength(1);
    expect(JSON.parse(sender.storage.map.get('pending_v2_deliveries') ?? '[]')).toHaveLength(0);
  });

  it('concurrent journal mutations do NOT clobber each other — the journal lock serializes RMW', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-journal-lock-1');
    await sender.module.load();

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const m = sender.module as any;
    // Two journal writes kicked WITHOUT awaiting between them — mirrors a send()
    // journaling a finished blob while a fire-and-forget replay mutates the journal.
    // Without the lock both read the same snapshot, mutate, and the last write wins.
    await Promise.all([
      m.savePendingV2Delivery({ transferId: 'tx-A', recipientPubkey: RECIPIENT.chainPubkey, tokenBlob: 'aa'.repeat(40), createdAt: Date.now() }),
      m.savePendingV2Delivery({ transferId: 'tx-B', recipientPubkey: RECIPIENT.chainPubkey, tokenBlob: 'bb'.repeat(40), createdAt: Date.now() }),
    ]);
    /* eslint-enable @typescript-eslint/no-explicit-any */

    // BOTH entries survive. RED without the lock: 1 — the second save reads the
    // pre-first snapshot and clobbers the first entry (the crash-safety blob is lost).
    const journal = JSON.parse(sender.storage.map.get('pending_v2_deliveries') ?? '[]');
    expect(journal).toHaveLength(2);
    expect(journal.map((e: { transferId: string }) => e.transferId).sort()).toEqual(['tx-A', 'tx-B']);
  });

  it('a blob that recovers within the budget is delivered and the journal is cleared — no poison event', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-poison-2');
    await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();

    /* eslint-disable @typescript-eslint/no-explicit-any */
    (sender.module as any).replayBackoffBaseMs = 0;

    // Capture a REAL deliverable blob by sending once, then re-journal it and
    // make delivery fail twice (transient outage) before recovering.
    let captured: Uint8Array | null = null;
    const realDeliver = sender.delivery.deliver.bind(sender.delivery);
    let failures = 2;
    vi.spyOn(sender.delivery, 'deliver').mockImplementation((a, b, c) => {
      captured = b;
      return failures-- > 0 ? Promise.reject(new Error('mailbox flapping')) : realDeliver(a, b, c);
    });
    const result = await sender.module.send({ recipient: '@bob', amount: '1000', coinId: UCT })
      .catch(() => null);
    // The send itself failed mid-deliver, journaling the finished blob.
    expect(captured).not.toBeNull();
    const journalAfterSend = JSON.parse(sender.storage.map.get('pending_v2_deliveries') ?? '[]');
    expect(journalAfterSend).toHaveLength(1);
    void result;

    // failures is now 1 → the next replay pass retries within-pass (backoff) and
    // recovers; the blob lands and the journal clears with NO poison event.
    await (sender.module as any).replayPendingV2Deliveries();
    /* eslint-enable @typescript-eslint/no-explicit-any */

    expect(JSON.parse(sender.storage.map.get('pending_v2_deliveries') ?? '[]')).toHaveLength(0);
    expect(fake.listMailboxEntries(RECIPIENT.chainPubkey)).toHaveLength(1);
    expect(sender.emitEvent.mock.calls.filter((c) => c[0] === 'delivery:undeliverable')).toHaveLength(0);
  });
});

describe('own-storage + wallet-api delivery (S7 AC: delivery-only composition)', () => {
  it('sender: deposits without EVER calling apply; the send closes via intents/complete alone', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeOwnStorageWallet(baseUrl, fake.network, SENDER, 'd-os-1');
    await sender.module.load();
    const mint = await sender.module.mintFungibleToken(UCT, 1000n);
    expect(mint.success).toBe(true);

    const result = await sender.module.send({ recipient: '@bob', amount: '1000', coinId: UCT });
    expect(result.status).toBe('completed');

    // Delivered via the mailbox…
    const entries = fake.listMailboxEntries(RECIPIENT.chainPubkey);
    expect(entries).toHaveLength(1);
    expect(entries[0].transferId).toBe(result.id);
    // …with ZERO sender-side inventory writes (storage-opt-out sender, §6)…
    expect(fake.getRow(SENDER.chainPubkey, entries[0].tokenId)).toBeNull();
    // …and the intent closed by the uniform completeIntent (E.3) — without it
    // this send would re-resume at every sign-in forever.
    expect(fake.getIntent(SENDER.chainPubkey, result.id)).toMatchObject({ status: 'completed' });
  });

  it("recipient: custody 'external' claims perform ZERO inventory writes; the token lives in app storage", async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeOwnStorageWallet(baseUrl, fake.network, SENDER, 'd-os-2');
    await sender.module.load();
    await sender.module.mintFungibleToken(UCT, 1000n);
    await sender.module.send({ recipient: '@bob', amount: '1000', coinId: UCT });

    const recipient = makeOwnStorageWallet(baseUrl, fake.network, RECIPIENT, 'd-os-3');
    await recipient.module.load();
    const { transfers } = await recipient.module.receive();

    expect(transfers).toHaveLength(1);
    expect(recipient.module.getTokens()[0]).toMatchObject({ amount: '1000', status: 'confirmed' });

    const entry = fake.listMailboxEntries(RECIPIENT.chainPubkey)[0];
    expect(fake.getMailboxEntry(RECIPIENT.chainPubkey, entry.entryId)).toMatchObject({
      status: 'claimed',
      intoInventory: false, // delivery-only claim (§6) — baked in at composition
    });
    expect(fake.getRow(RECIPIENT.chainPubkey, entry.tokenId)).toBeNull(); // zero inventory writes
  });
});

describe('E.3 resume — open intents re-run deterministically at sign-in', () => {
  it('an intent persisted before a crash resumes: deliver → apply → complete → history', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-rs-1');
    const sourceTokenId = await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();

    // Simulate the crash window: the intent was PUT (awaited — E.3) but the
    // process died before the engine ran. Resume must complete the transfer.
    const transferId = crypto.randomUUID();
    const payload = {
      v: 1,
      recipient: RECIPIENT.chainPubkey,
      coinId: UCT,
      amount: '1000',
      direct: [sourceTokenId],
    };
    sender.client.setIdentity(SENDER);
    await sender.client.putIntent(
      transferId,
      encryptField(deriveFieldEncryptionKey(SENDER.privateKey), JSON.stringify(payload))
    );
    expect(fake.getIntent(SENDER.chainPubkey, transferId)).toMatchObject({ status: 'open' });

    const outcome = await sender.module.resumeOpenIntents();
    expect(outcome.resumed).toEqual([transferId]);
    expect(outcome.conflicted).toEqual([]);

    // The transfer completed end-to-end under the ORIGINAL transferId.
    const entries = fake.listMailboxEntries(RECIPIENT.chainPubkey);
    expect(entries).toHaveLength(1);
    expect(entries[0].transferId).toBe(transferId);
    expect(fake.getRow(SENDER.chainPubkey, sourceTokenId)).toMatchObject({ status: 'removed', removal: 'evidenced' });
    expect(fake.getIntent(SENDER.chainPubkey, transferId)).toMatchObject({ status: 'completed' });
    const sent = fake.getHistoryRecords(SENDER.chainPubkey).find((r) => r.dedupKey === `SENT_transfer_${transferId}`);
    expect(sent).toBeDefined();
  });

  it('#676: a locally-aborted intent whose server abort never landed is NOT re-executed on resume (double-pay guard)', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-676');
    const sourceTokenId = await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();

    // Reproduce the #516 unlanded-abort state a clean pre-cert send failure leaves behind against a
    // dead backend: PUT the intent (server 'open' + local 'open'), then abort while the intent
    // endpoint is down — abortIntent flips the LOCAL copy to aborted+abortPending and re-throws, but
    // the SERVER row stays 'open'.
    const transferId = crypto.randomUUID();
    const payload = { v: 1, recipient: RECIPIENT.chainPubkey, coinId: UCT, amount: '1000', direct: [sourceTokenId] };
    sender.client.setIdentity(SENDER);
    await sender.client.putIntent(
      transferId,
      encryptField(deriveFieldEncryptionKey(SENDER.privateKey), JSON.stringify(payload)),
    );
    fake.setIntentFailure(true);
    await expect(sender.client.abortIntent(transferId)).rejects.toThrow();
    fake.setIntentFailure(false);

    // Precondition: the server row is STILL 'open' (the double-pay hazard) while the local copy is
    // aborted+abortPending — exactly the divergence resume must not re-execute.
    expect(fake.getIntent(SENDER.chainPubkey, transferId)).toMatchObject({ status: 'open' });
    expect(await sender.client.getLocalIntent(transferId)).toMatchObject({ status: 'aborted', abortPending: true });

    const transferSpy = vi.spyOn(sender.engine, 'transfer');
    const outcome = await sender.module.resumeOpenIntents();

    // THE FIX: not resumed — the engine never re-ran, nothing was delivered, the source was never
    // re-spent, and the server converges to 'aborted' instead of re-executing the failed send.
    expect(outcome.resumed).not.toContain(transferId);
    expect(outcome.conflicted).toContain(transferId);
    expect(transferSpy).not.toHaveBeenCalled();
    expect(fake.listMailboxEntries(RECIPIENT.chainPubkey)).toHaveLength(0);
    expect(fake.getRow(SENDER.chainPubkey, sourceTokenId)).toMatchObject({ status: 'active' });
    expect(fake.getIntent(SENDER.chainPubkey, transferId)).toMatchObject({ status: 'aborted' });
  });

  it('#676: a server-open intent with NO local copy (fresh device) still resumes — the server copy stays authoritative', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-676-fresh');
    const sourceTokenId = await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();

    const transferId = crypto.randomUUID();
    const payload = { v: 1, recipient: RECIPIENT.chainPubkey, coinId: UCT, amount: '1000', direct: [sourceTokenId] };
    sender.client.setIdentity(SENDER);
    await sender.client.putIntent(
      transferId,
      encryptField(deriveFieldEncryptionKey(SENDER.privateKey), JSON.stringify(payload)),
    );
    // Drop only the LOCAL backstop copy (server row stays 'open') — the fresh-device state where the
    // server intent is the sole seed and the #516 local record is absent.
    await sender.client.removeLocalIntent(transferId);
    expect(await sender.client.getLocalIntent(transferId)).toBeNull();

    const outcome = await sender.module.resumeOpenIntents();

    // Resume proceeds unchanged: with no local record, the server copy is authoritative.
    expect(outcome.resumed).toEqual([transferId]);
    expect(fake.getIntent(SENDER.chainPubkey, transferId)).toMatchObject({ status: 'completed' });
    expect(fake.listMailboxEntries(RECIPIENT.chainPubkey)).toHaveLength(1);
  });

  it('#676 (PR #681 review): the local intent dispositions are read ONCE for all open intents (batched), not once per intent', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-676-batch');
    const src1 = await seedServerToken(fake, sender, SENDER, 1000n);
    const src2 = await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();

    // Two independent server-`open` intents (each with a local copy from putIntent).
    sender.client.setIdentity(SENDER);
    const putIntent = async (src: string): Promise<string> => {
      const tid = crypto.randomUUID();
      const payload = { v: 1, recipient: RECIPIENT.chainPubkey, coinId: UCT, amount: '1000', direct: [src] };
      await sender.client.putIntent(tid, encryptField(deriveFieldEncryptionKey(SENDER.privateKey), JSON.stringify(payload)));
      return tid;
    };
    const t1 = await putIntent(src1);
    const t2 = await putIntent(src2);

    const mapSpy = vi.spyOn(sender.client, 'getLocalIntentsMap');
    const outcome = await sender.module.resumeOpenIntents();

    // ONE batched read regardless of the open-intent count (was one full parse per intent before the
    // PR #681 review fix). Both intents still resume (their local copies are 'open').
    expect(mapSpy).toHaveBeenCalledTimes(1);
    expect(outcome.resumed).toEqual(expect.arrayContaining([t1, t2]));
  });

  it('#676 (PR #681 review): a FAILING local-intent read does not abort resume and does NOT resume any intent — money-safe defer (no double-pay)', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-676-throw');
    const src = await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();

    const transferId = crypto.randomUUID();
    const payload = { v: 1, recipient: RECIPIENT.chainPubkey, coinId: UCT, amount: '1000', direct: [src] };
    sender.client.setIdentity(SENDER);
    await sender.client.putIntent(
      transferId,
      encryptField(deriveFieldEncryptionKey(SENDER.privateKey), JSON.stringify(payload)),
    );

    // The local-disposition read throws (storage error). A server-`open` intent could be locally
    // aborted (the #676 divergence), so re-executing it would double-pay. Resume must NOT crash AND
    // must NOT resume — it DEFERS the intent (retry next sign-in), erring toward not double-paying.
    vi.spyOn(sender.client, 'getLocalIntentsMap').mockRejectedValue(new Error('storage unavailable'));
    const transferSpy = vi.spyOn(sender.engine, 'transfer');

    const outcome = await sender.module.resumeOpenIntents(); // resolves — the loop is not aborted

    expect(outcome.resumed).not.toContain(transferId);
    expect(outcome.failed).toContain(transferId);                              // deferred
    expect(transferSpy).not.toHaveBeenCalled();                               // never re-executed
    expect(fake.listMailboxEntries(RECIPIENT.chainPubkey)).toHaveLength(0);   // nothing delivered → no double-pay
    expect(fake.getRow(SENDER.chainPubkey, src)).toMatchObject({ status: 'active' }); // source not re-spent
  });

  it('audit#4: resume of a single source lost to a FOREIGN transfer ABORTS (conflicted) — never falsely completes (§8.1/§7; reverses #621)', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-rs-621');
    const sourceTokenId = await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();

    const transferId = crypto.randomUUID();
    const payload = { v: 1, recipient: RECIPIENT.chainPubkey, coinId: UCT, amount: '1000', direct: [sourceTokenId] };
    sender.client.setIdentity(SENDER);
    await sender.client.putIntent(
      transferId,
      encryptField(deriveFieldEncryptionKey(SENDER.privateKey), JSON.stringify(payload)),
    );

    // §8.1: engine.transfer returns the existing proof for OUR OWN resume (a hash-MATCH, no throw);
    // a TransferConflictError means a DIFFERENT (foreign) transaction consumed the source — this leg
    // delivered NOTHING. With nothing delivered, resume must ABORT and re-plan the FULL amount (§7),
    // NOT record the spend + complete (the #621 false-paid this reverses).
    vi.spyOn(sender.engine, 'transfer').mockRejectedValue(
      new TransferConflictError('TRANSACTION_HASH_MISMATCH: source already spent'),
    );

    const outcome = await sender.module.resumeOpenIntents();
    expect(outcome.conflicted).toContain(transferId);
    expect(outcome.resumed).not.toContain(transferId);
    expect(fake.getIntent(SENDER.chainPubkey, transferId)).toMatchObject({ status: 'aborted' });
    expect(fake.getRow(SENDER.chainPubkey, sourceTokenId)).toMatchObject({ status: 'active' }); // not falsely removed
    expect(fake.listMailboxEntries(RECIPIENT.chainPubkey)).toHaveLength(0);
  });

  it('#631: a proof-fetch failure AFTER certification keeps the intent OPEN (resume seed survives; no double-spend)', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-631-open');
    const sourceTokenId = await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();

    // The #631 window: the aggregator certifies (the source is consumed on-chain) but the
    // inclusion-proof fetch THEN throws — modeled by running the REAL op (which marks the source
    // spent → engine.isSpent(source) === true) and then throwing ProofUnconfirmedError.
    const realTransfer = sender.engine.transfer.bind(sender.engine);
    let transferId: string | undefined;
    vi.spyOn(sender.engine, 'transfer').mockImplementationOnce(async (p, o) => {
      transferId = o?.transferId;
      const finished = await realTransfer(p, o); // consumes the source (certifies)
      void finished;
      throw new ProofUnconfirmedError('inclusion-proof fetch failed after certification');
    });

    await expect(
      sender.module.send({ recipient: '@bob', amount: '1000', coinId: UCT, memo: 'lunch' }),
    ).rejects.toBeInstanceOf(ProofUnconfirmedError);

    // THE FIX: the intent is kept OPEN (was 'aborted' before #631) — the resume seed survives so
    // resumeOpenIntents can replay the same transferId to recover the proof + delivery. (Resume
    // convergence of an open intent is covered by the §3.1/#621 resume tests above.)
    expect(fake.getIntent(SENDER.chainPubkey, transferId!)).toMatchObject({ status: 'open' });

    // Money-safe: the source is terminal 'spent' locally (never restored to 'confirmed' — no
    // phantom balance), via the restore loop's on-chain isSpent probe.
    expect(sender.module.getTokens()[0].status).toBe('spent');

    // Nothing committed server-side, nothing delivered: the throw beat applyDelta AND the
    // blob-journal, so the source row is not removed and the recipient mailbox is empty. Only the
    // resume SEED was ever at risk — and it now survives instead of being aborted.
    expect(fake.getRow(SENDER.chainPubkey, sourceTokenId)?.status).not.toBe('removed');
    expect(fake.listMailboxEntries(RECIPIENT.chainPubkey)).toHaveLength(0);
  });

  it('#631 regression: a clean pre-certification failure (plain error, source untouched) still aborts + restores', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-631-clean');
    await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();

    // A plain Error (NOT ProofUnconfirmedError) with NOTHING consumed — a proven clean
    // pre-certification failure. The fix must leave this on the abort + restore path.
    let transferId: string | undefined;
    vi.spyOn(sender.engine, 'transfer').mockImplementationOnce((_p, o) => {
      transferId = o?.transferId;
      return Promise.reject(new Error('aggregator rejected — clean, nothing certified'));
    });

    await expect(sender.module.send({ recipient: '@bob', amount: '1000', coinId: UCT })).rejects.toThrow();

    // Unchanged: the untouched source is restored to 'confirmed' and the intent is aborted.
    expect(sender.module.getTokens()[0].status).toBe('confirmed');
    expect(fake.getIntent(SENDER.chainPubkey, transferId!)).toMatchObject({ status: 'aborted' });
  });

  it('audit#4: resume of a split-only source lost to a FOREIGN transfer ABORTS (conflicted) — never falsely completes (§8.1/§7; reverses #622)', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-rs-split-621');
    const sourceTokenId = await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();

    const transferId = crypto.randomUUID();
    const payload = {
      v: 1,
      recipient: RECIPIENT.chainPubkey,
      coinId: UCT,
      amount: '300',
      direct: [],
      split: { tokenId: sourceTokenId, splitAmount: '300', remainderAmount: '700' },
    };
    sender.client.setIdentity(SENDER);
    await sender.client.putIntent(
      transferId,
      encryptField(deriveFieldEncryptionKey(SENDER.privateKey), JSON.stringify(payload)),
    );

    // A TransferConflictError from engine.split = the split SOURCE was consumed by a DIFFERENT
    // (foreign) transaction (§8.1). With no direct legs, NOTHING was delivered → resume must ABORT
    // and re-plan the full amount (§7), never record the spend + complete (the #622 false-paid).
    vi.spyOn(sender.engine, 'split').mockRejectedValue(
      new TransferConflictError('TRANSACTION_HASH_MISMATCH: split source already spent'),
    );

    const outcome = await sender.module.resumeOpenIntents();
    expect(outcome.conflicted).toContain(transferId);
    expect(outcome.resumed).not.toContain(transferId);
    expect(fake.getIntent(SENDER.chainPubkey, transferId)).toMatchObject({ status: 'aborted' });
    expect(fake.getRow(SENDER.chainPubkey, sourceTokenId)).toMatchObject({ status: 'active' }); // not falsely removed
    expect(fake.listMailboxEntries(RECIPIENT.chainPubkey)).toHaveLength(0);
  });

  it('audit#4 (Codex P1): MULTI-SOURCE partial — the delivered leg is retained (never double-paid); only the remainder is surfaced', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-rs-partial');
    const g0 = await seedServerToken(fake, sender, SENDER, 600n); // leg 0 — delivers
    const g1 = await seedServerToken(fake, sender, SENDER, 400n); // leg 1 — lost to a foreign tx
    await sender.module.load();

    const transferId = crypto.randomUUID();
    const payload = { v: 1, recipient: RECIPIENT.chainPubkey, coinId: UCT, amount: '1000', direct: [g0, g1] };
    sender.client.setIdentity(SENDER);
    await sender.client.putIntent(
      transferId,
      encryptField(deriveFieldEncryptionKey(SENDER.privateKey), JSON.stringify(payload)),
    );

    // Resume: leg 0 (opIndex 0) transfers for real (delivers 600); leg 1 (opIndex 1) was consumed by
    // a FOREIGN tx → engine.transfer conflicts (§8.1). This is exactly the case a bare abort would
    // DOUBLE-PAY: aborting the whole intent makes a linked request payable and re-pays the delivered
    // leg 0. The fix forward-completes leg 0 and surfaces ONLY the remainder.
    const realTransfer = sender.engine.transfer.bind(sender.engine);
    vi.spyOn(sender.engine, 'transfer').mockImplementation(async (p, o) => {
      if (o?.opIndex === 1) throw new TransferConflictError('TRANSACTION_HASH_MISMATCH: leg 1 source lost');
      return realTransfer(p, o);
    });
    const applySpy = vi.spyOn(sender.client, 'applyInventoryDelta');

    const outcome = await sender.module.resumeOpenIntents();

    // §7 forward-completion: the delivered leg is FINAL. The intent is RESUMED (completed), NEVER
    // conflicted — so a linked settling request resolves 'paid' and is NEVER reverted to payable
    // (no double-pay of leg 0). Only leg 0 (g0) is recorded spent — never the conflicted leg 1 (g1).
    expect(outcome.resumed).toContain(transferId);
    expect(outcome.conflicted).not.toContain(transferId);
    const applyForT = applySpy.mock.calls.find((c) => (c[0] as { transferId?: string })?.transferId === transferId);
    expect((applyForT?.[0] as { spent: string[] }).spent).toEqual([g0]); // delivered leg only — EXCLUDES the conflicted g1
    expect(fake.getIntent(SENDER.chainPubkey, transferId)).toMatchObject({ status: 'completed' });
    // The undelivered remainder (1000 − 600 = 400) is SURFACED for a re-plan under a new transferId —
    // never re-sent from here, never rolled into a full-amount re-pay.
    const evt = sender.emitEvent.mock.calls.find((c) => c[0] === 'send:partial-remainder');
    expect(evt?.[1]).toMatchObject({ transferId, remainingAmount: '400', recipientPubkey: RECIPIENT.chainPubkey });
  });

  it('legacy (v:1, no store): a resume that hits SplitCheckpointLostError records the spend, never wedges', async () => {
    // The engine now maps a split-mint-leg mismatch to the keep-open SplitCheckpointLostError. A v:1
    // intent has NO checkpoint store, so there is nothing to recover from — resume must fall back to
    // the legacy residual (record the spend + surface a resync), NOT rethrow and wedge the intent.
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-legacy-lost');
    const sourceTokenId = await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();

    const transferId = crypto.randomUUID();
    const payload = {
      v: 1,
      recipient: RECIPIENT.chainPubkey,
      coinId: UCT,
      amount: '300',
      direct: [],
      split: { tokenId: sourceTokenId, splitAmount: '300', remainderAmount: '700' },
    };
    sender.client.setIdentity(SENDER);
    await sender.client.putIntent(
      transferId,
      encryptField(deriveFieldEncryptionKey(SENDER.privateKey), JSON.stringify(payload))
    );
    vi.spyOn(sender.engine, 'split').mockRejectedValue(
      new SplitCheckpointLostError('a split mint leg no longer matches its certified leaf')
    );

    const outcome = await sender.module.resumeOpenIntents();
    expect(outcome.resumed).toEqual([transferId]); // completed, not wedged
    expect(outcome.failed).toEqual([]);
    expect(fake.getRow(SENDER.chainPubkey, sourceTokenId)).toMatchObject({ status: 'removed' });
    expect(fake.getIntent(SENDER.chainPubkey, transferId)).toMatchObject({ status: 'completed' });
    expect(sender.emitEvent.mock.calls.some((c) => c[0] === 'inventory:conflict')).toBe(true);
  });

  it('#634: resume of a v:2 split re-runs the split THROUGH the checkpoint and recovers the change output', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-634-recover');
    const sourceTokenId = await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();

    // A checkpoint-bearing (requiresSeedClose) v:2 split intent whose original send crashed after
    // the split certified but before the change was applied server-side (the #634 window).
    const transferId = crypto.randomUUID();
    const payload = {
      v: 2,
      recipient: RECIPIENT.chainPubkey,
      coinId: UCT,
      amount: '300',
      direct: [],
      split: { tokenId: sourceTokenId, splitAmount: '300', remainderAmount: '700' },
    };
    sender.client.setIdentity(SENDER);
    await sender.client.putIntent(
      transferId,
      encryptField(deriveFieldEncryptionKey(SENDER.privateKey), JSON.stringify(payload)),
      { requiresSeedClose: true }
    );
    // CRUCIAL for #634: the original send JOURNALED the split's recipient blob (opIndex 0) before
    // crashing. This is the exact state the old change-blind shortcut fired on — it re-delivered
    // this blob and skipped re-deriving the change. The fix must re-run split() ANYWAY (via the
    // checkpoint) so the change is recovered; without the fix the change row would be absent.
    const splitOpIndex = 0; // direct.length
    await (sender.module as unknown as {
      savePendingV2Delivery(e: {
        transferId: string;
        recipientPubkey: string;
        tokenBlob: string;
        opIndex: number;
        createdAt: number;
      }): Promise<void>;
    }).savePendingV2Delivery({
      transferId,
      recipientPubkey: RECIPIENT.chainPubkey,
      tokenBlob: 'ab'.repeat(40),
      opIndex: splitOpIndex,
      createdAt: Date.now(),
    });

    // The engine recovers BOTH outputs from the stored checkpoint on resume (proven end-to-end by
    // the engine's AC-E2). Here the FakeTokenEngine produces the outputs; we capture the options to
    // assert the checkpoint store was threaded (the #634 fix re-runs split, not the change-blind
    // shortcut) and the change output that resume must apply.
    const realSplit = sender.engine.split.bind(sender.engine);
    let splitOpts: Parameters<typeof sender.engine.split>[1];
    let change: Awaited<ReturnType<typeof sender.engine.split>>['outputs'][1] | undefined;
    vi.spyOn(sender.engine, 'split').mockImplementation(async (p, o) => {
      splitOpts = o;
      const result = await realSplit(p, o);
      change = result.outputs[1];
      return result;
    });

    const outcome = await sender.module.resumeOpenIntents();

    expect(outcome.resumed).toEqual([transferId]);
    expect(outcome.conflicted).toEqual([]);
    // The #634 fix: engine.split WAS re-run WITH the checkpoint store (vs the old change-blind
    // shortcut that never re-derived the change), and the source spend was applied.
    expect(splitOpts?.checkpointStore).toBeDefined();
    expect(fake.getRow(SENDER.chainPubkey, sourceTokenId)).toMatchObject({ status: 'removed' });
    expect(fake.getIntent(SENDER.chainPubkey, transferId)).toMatchObject({ status: 'completed' });
    // The change token (700) is now in the server inventory — RECOVERED, not lost, no resync prompt.
    const changeId = sender.engine.tokenId(change!);
    expect(fake.getRow(SENDER.chainPubkey, changeId)).toMatchObject({ status: 'active' });
    expect(sender.emitEvent.mock.calls.some((c) => c[0] === 'inventory:conflict')).toBe(false);
  });
});

describe('replay classifies recipient-quota (429) as deferred, never poison (§3.1 #621)', () => {
  it('a recipient-full 429 blob is deferred (kept journaled, never poison) and lands once the recipient drains', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-defer-621');
    await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (sender.module as any).deliveryDeferralMs = 0; // re-eligible immediately — no real wait
    (sender.module as any).replayBackoffBaseMs = 0;
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const realDeliver = sender.delivery.deliver.bind(sender.delivery);
    let recipientFull = true;
    vi.spyOn(sender.delivery, 'deliver').mockImplementation((a, b, c) =>
      recipientFull ? Promise.reject(new WalletApiError('quota (§5.5)', 'RATE_LIMITED', 429)) : realDeliver(a, b, c),
    );

    const result = await sender.module.send({ recipient: '@bob', amount: '1000', coinId: UCT });
    expect(result.deliveryPending).toBe(true);

    // Drive far past the case-A poison budget (6) while the recipient stays full — never poison.
    for (let i = 0; i < 8; i++) await (sender.module as any).replayPendingV2Deliveries();
    const journaled = JSON.parse(sender.storage.map.get('pending_v2_deliveries') ?? '[]');
    expect(journaled).toHaveLength(1);
    expect(journaled[0].undeliverable).toBeUndefined();
    expect(journaled[0].deferredReason).toBe('recipient-quota');
    expect(sender.emitEvent.mock.calls.some((c) => c[0] === 'delivery:deferred')).toBe(true);
    expect(sender.emitEvent.mock.calls.some((c) => c[0] === 'delivery:undeliverable')).toBe(false);

    // Recipient drains → next replay lands and clears the journal.
    recipientFull = false;
    await (sender.module as any).replayPendingV2Deliveries();
    expect(fake.listMailboxEntries(RECIPIENT.chainPubkey)).toHaveLength(1);
    expect(JSON.parse(sender.storage.map.get('pending_v2_deliveries') ?? '[]')).toHaveLength(0);
  });
});

describe('stale-inventory conflict self-heals (#625) + is SURFACED (#517 item 2)', () => {
  it('the ONLY source being stale: demote it, re-plan, and surface a CLEAN SEND_INSUFFICIENT_BALANCE (not a raw conflict)', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-conf-1');
    const sourceTokenId = await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();

    // Another device already spent the only source: the engine's match-verify raises
    // TransferConflictError on every certification attempt (Part E.2).
    vi.spyOn(sender.engine, 'transfer').mockRejectedValue(
      new TransferConflictError('TRANSACTION_HASH_MISMATCH: source already spent')
    );

    // #625: the send demotes the stale source and re-plans; with no live candidate left it exhausts to
    // a CLEAN SEND_INSUFFICIENT_BALANCE — never an endless loop or a raw conflict to the caller.
    await expect(sender.module.send({ recipient: '@bob', amount: '1000', coinId: UCT }))
      .rejects.toThrow(/insufficient balance/i);

    // The conflict is still surfaced (telemetry/UI awareness) — exactly once: the re-plan fails at
    // SELECTION (the source is now excluded), not at certification, so no second conflict.
    const conflictCalls = sender.emitEvent.mock.calls.filter((c) => c[0] === 'inventory:conflict');
    expect(conflictCalls).toHaveLength(1);
    expect(conflictCalls[0][1].error).toContain('TRANSACTION_HASH_MISMATCH');

    // The stale source is DEMOTED (suspectedSpent) but KEPT in inventory — never auto-removed.
    const demoted = sender.module.getTokens().find((t) => t.id === `v2_${sourceTokenId}`);
    expect(demoted?.suspectedSpent).toBe(true);
  });

  it('a stale source among live ones self-heals: demote the conflicted token, complete with the next candidate', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-heal-1');
    await seedServerToken(fake, sender, SENDER, 1000n);
    await seedServerToken(fake, sender, SENDER, 1000n); // two interchangeable sources
    await sender.module.load();

    // The first-selected source is already spent: the engine conflicts ONCE, then certifies normally.
    vi.spyOn(sender.engine, 'transfer').mockRejectedValueOnce(
      new TransferConflictError('TRANSACTION_HASH_MISMATCH: source already spent')
    );

    const result = await sender.module.send({ recipient: '@bob', amount: '1000', coinId: UCT });
    expect(result.status).toBe('completed');

    // Exactly one source demoted (the conflicted one); the delivery landed via the live source.
    expect(sender.module.getTokens().filter((t) => t.suspectedSpent)).toHaveLength(1);
    expect(fake.listMailboxEntries(RECIPIENT.chainPubkey)).toHaveLength(1);
  });

  it('a conflict AFTER an earlier op certified re-plans ONLY the remainder (not the full amount) — delivers X, never over-requests (#677)', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-partial-1');
    await seedServerToken(fake, sender, SENDER, 1000n);
    await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();

    // amount 2000 needs BOTH sources (two direct ops). The first certifies; the second conflicts —
    // so value has already left the wallet and a FULL-amount re-plan would over-request (send 3000).
    const orig = sender.engine.transfer.bind(sender.engine);
    let calls = 0;
    vi.spyOn(sender.engine, 'transfer').mockImplementation((...args: Parameters<typeof orig>) => {
      calls += 1;
      return calls === 2
        ? Promise.reject(new TransferConflictError('TRANSACTION_HASH_MISMATCH: source already spent'))
        : orig(...args);
    });

    // #677: send() re-plans ONLY the remaining 1000 (the conflict freed the second source, which was
    // not actually spent), so the recipient receives the full 2000 across exactly TWO legs — never a
    // third over-request leg. Nothing is demoted: the certified-then-reused source completed cleanly.
    const result = await sender.module.send({ recipient: '@bob', amount: '2000', coinId: UCT });
    expect(result.status).toBe('completed');
    expect(fake.listMailboxEntries(RECIPIENT.chainPubkey)).toHaveLength(2); // full amount, NOT 3 legs
    expect(sender.module.getTokens().filter((t) => t.suspectedSpent)).toHaveLength(0);
  });

  it('a plain (non-conflict) send failure does NOT emit inventory:conflict', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-conf-2');
    await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();

    vi.spyOn(sender.engine, 'transfer').mockRejectedValue(new Error('engine boom'));

    await expect(sender.module.send({ recipient: '@bob', amount: '1000', coinId: UCT }))
      .rejects.toThrow('engine boom');

    expect(sender.emitEvent.mock.calls.filter((c) => c[0] === 'inventory:conflict')).toHaveLength(0);
  });
});

describe('#677: a mid-send conflict re-plans the remainder inside send() and still delivers the full amount', () => {
  it('a mid-SPLIT conflict after a certified leg re-plans the remainder — the recipient receives the FULL amount X across a NEW transferId', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-677-split');
    await seedServerToken(fake, sender, SENDER, 1500n);
    await seedServerToken(fake, sender, SENDER, 1500n);
    await sender.module.load();

    // amount 2000 from two 1500s → a direct leg (1500) + a SPLIT leg (500 to recipient, 1000 change).
    // The direct leg certifies + delivers; the split leg loses its source to a concurrent transfer the
    // FIRST time (AFTER 1500 has irreversibly left the wallet), then succeeds on the remainder re-plan.
    const origSplit = sender.engine.split.bind(sender.engine);
    let splitCalls = 0;
    vi.spyOn(sender.engine, 'split').mockImplementation((...args: Parameters<typeof origSplit>) => {
      splitCalls += 1;
      return splitCalls === 1
        ? Promise.reject(new TransferConflictError('TRANSACTION_HASH_MISMATCH: source already spent'))
        : origSplit(...args);
    });

    // THE FIX: send() re-plans ONLY the still-owed 500 under a NEW transferId and RESOLVES successfully
    // — a send for 2000 delivers 2000, never re-sending the certified 1500 leg.
    const result = await sender.module.send({ recipient: '@bob', amount: '2000', coinId: UCT });
    expect(result.status).toBe('completed');

    // The recipient receives the full 2000 (1500 direct + 500 split) across the two legs.
    const recipient = makeFullPresetWallet(baseUrl, fake.network, RECIPIENT, 'd-677-recv');
    await recipient.module.load();
    const { transfers } = await recipient.module.receive();
    const received = transfers.flatMap((t) => t.tokens).reduce((sum, tok) => sum + BigInt(tok.amount), 0n);
    expect(received).toBe(2000n);
  });

  it('op1 certifies+delivers, op2 conflicts and the remainder CANNOT be covered → PartialSendConflictError carrying the delivered leg + the shortfall (never a re-sendable failure)', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-677');
    await seedServerToken(fake, sender, SENDER, 1000n);
    await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();

    // amount 2000 → two direct legs. Leg 1 certifies + delivers; every subsequent op conflicts, so the
    // second source is exhausted (demoted after its own clean conflict) and the remainder cannot be
    // covered — the insufficient-remainder fallback.
    const orig = sender.engine.transfer.bind(sender.engine);
    let calls = 0;
    vi.spyOn(sender.engine, 'transfer').mockImplementation((...args: Parameters<typeof orig>) => {
      calls += 1;
      return calls === 1
        ? orig(...args)
        : Promise.reject(new TransferConflictError('TRANSACTION_HASH_MISMATCH: source already spent'));
    });

    const thrown = await sender.module
      .send({ recipient: '@bob', amount: '2000', coinId: UCT })
      .then(() => { throw new Error('expected the partial send to reject'); }, (e) => e);

    // THE FALLBACK: a DISTINCT partial outcome — NOT a bare TransferConflictError the caller re-sends in
    // full (which would pay the delivered leg twice).
    expect(thrown).toBeInstanceOf(PartialSendConflictError);
    expect(thrown).not.toBeInstanceOf(TransferConflictError);
    const partial = thrown as PartialSendConflictError;
    expect(partial.code).toBe('SEND_PARTIALLY_COMPLETED');
    // It carries exactly the one already-committed leg + the still-owed shortfall (1000) so the caller
    // re-plans ONLY the remainder, never the whole amount.
    expect(partial.committedTokenIds).toHaveLength(1);
    expect(partial.remainingAmount).toBe('1000');
    expect(partial.transferId).toBeTruthy();

    // Leg 1 delivered (exactly one mailbox entry — the delivered leg is never re-sent) and its source
    // is terminal 'spent' locally, never restored.
    const entries = fake.listMailboxEntries(RECIPIENT.chainPubkey);
    expect(entries).toHaveLength(1);
    const committedId = partial.committedTokenIds[0];
    expect(sender.module.getTokens().find((t) => t.id === committedId)?.status).toBe('spent');
    expect(`v2_${entries[0].tokenId}`).toBe(committedId);

    // Existing behavior preserved: the conflicted intent was soft-aborted (the delivered leg is not
    // lost — mirrors the SEND_SYNC_PENDING contract).
    expect(fake.getIntent(SENDER.chainPubkey, partial.transferId)).toMatchObject({ status: 'aborted' });
  });
});

describe('reload (tab refresh) — durable cursor, rebuilt view (#521)', () => {
  it('a reloaded provider+module instance full-pulls its FIRST sync and renders the full wallet; deltas resume within the session; a third reload is idempotent', async () => {
    const { fake, baseUrl } = await startFake();
    const kv = new MemoryKeyValueStore(); // the SHARED persisted stateStore — survives the "refresh"
    const cursorKey = `wallet-api-storage:cursor:${fake.network}:${SENDER.chainPubkey}`;

    // Session 1 — the full mint-and-send flow that warms the DURABLE cursor:
    // mint 1000, send 300 → the server holds exactly the 700 change row.
    const tab1 = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-tab', kv);
    await seedServerToken(fake, tab1, SENDER, 1000n);
    await tab1.module.load();
    const sent = await tab1.module.send({ recipient: '@bob', amount: '300', coinId: UCT });
    expect(sent.status).toBe('completed');
    expect(await tab1.client.getBalances()).toEqual([{ coinId: UCT, total: 700n, tokenCount: 1 }]);

    // Session 2 — a NEW provider+module instance over the SAME persisted
    // stateStore: the simulated tab refresh that used to delta-sync from the
    // warm cursor into an empty process-lifetime view and render {items:[]}.
    fake.inventoryGetLog.length = 0;
    const tab2 = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-tab', kv);
    await tab2.module.load();

    const tokens = tab2.module.getTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ id: expect.stringMatching(/^v2_/), amount: '700', coinId: UCT, status: 'confirmed', lazy: true });

    // The doubled load() GETs (provider.load() + mergeLazyInventory): the
    // FIRST sync of the session is a FULL pull (since-less page + the §5.1
    // closing delta from the warm cursor); the second sync rides the
    // now-warm session as a plain delta — never a second full pull.
    const cursor = await kv.get(cursorKey);
    expect(cursor).toMatch(/^[0-9]+$/);
    expect(fake.inventoryGetLog).toEqual([null, cursor, cursor]);

    // WITHIN the session the delta path keeps operating: a further load()
    // issues delta GETs only, and the view stays converged (no duplicates).
    fake.inventoryGetLog.length = 0;
    await tab2.module.load();
    expect(fake.inventoryGetLog).toEqual([cursor, cursor]);
    expect(tab2.module.getTokens()).toHaveLength(1);

    // Session 3 — a THIRD instance over the same stateStore still renders
    // everything (the first-sync full pull is idempotent across reloads).
    fake.inventoryGetLog.length = 0;
    const tab3 = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-tab', kv);
    await tab3.module.load();
    expect(tab3.module.getTokens()).toHaveLength(1);
    expect(tab3.module.getTokens()[0]).toMatchObject({ amount: '700', lazy: true });
    expect(fake.inventoryGetLog).toEqual([null, cursor, cursor]);
  });
});

describe('suspected-spent demotion is DURABLE across a reload (SPHERE-4 phantom balance, #679)', () => {
  const overlayKey = (network: string) =>
    `wallet-api-storage:suspectedSpent:${network}:${SENDER.chainPubkey}`;

  it('a #625 demotion survives a tab refresh — the phantom is NOT re-served as spendable confirmed balance', async () => {
    const { fake, baseUrl } = await startFake();
    const kv = new MemoryKeyValueStore(); // the SHARED persisted stateStore — survives the "refresh"

    // Session 1 — the only source is already spent on-chain: every certification
    // attempt raises TransferConflictError, so #625 demotes it and the send
    // exhausts to a clean SEND_INSUFFICIENT_BALANCE.
    const tab1 = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-679', kv);
    const sourceTokenId = await seedServerToken(fake, tab1, SENDER, 1000n);
    await tab1.module.load();
    expect(tab1.module.getBalance(UCT)).toEqual([
      expect.objectContaining({ coinId: UCT, confirmedAmount: '1000' }),
    ]);

    vi.spyOn(tab1.engine, 'transfer').mockRejectedValue(
      new TransferConflictError('TRANSACTION_HASH_MISMATCH: source already spent'),
    );
    await expect(tab1.module.send({ recipient: '@bob', amount: '1000', coinId: UCT })).rejects.toThrow(
      /insufficient balance/i,
    );

    // In-session: demoted, kept in inventory, excluded from spendable balance…
    expect(tab1.module.getTokens().find((t) => t.id === `v2_${sourceTokenId}`)?.suspectedSpent).toBe(true);
    expect(tab1.module.getBalance(UCT)).toEqual([]);
    // …and the demotion is now on the DURABLE overlay (client-local, never the server).
    expect(await kv.get(overlayKey(fake.network))).toBe(JSON.stringify([sourceTokenId]));
    // The server row is still ACTIVE — the demotion was never pushed (no wire change).
    expect(fake.getRow(SENDER.chainPubkey, sourceTokenId)?.status).toBe('active');

    // Session 2 — a NEW provider+module instance over the SAME persisted store
    // (the tab refresh). Before #679 mergeLazyInventory re-stamped the still-active
    // server row as spendable `confirmed` and the phantom returned every session.
    const tab2 = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-679', kv);
    await tab2.module.load();

    // The token is kept (visible/recoverable) but DEMOTED — not phantom-confirmed.
    const reloaded = tab2.module.getTokens().find((t) => t.id === `v2_${sourceTokenId}`);
    expect(reloaded).toBeDefined();
    expect(reloaded?.suspectedSpent).toBe(true);
    // NOT presented as spendable confirmed balance.
    expect(tab2.module.getBalance(UCT)).toEqual([]);
    // NOT selectable by coin-selection — the fresh engine has NO conflict spy, so a
    // broken overlay would let this real send proceed; the demotion blocks it at
    // selection instead.
    await expect(tab2.module.send({ recipient: '@bob', amount: '1000', coinId: UCT })).rejects.toThrow(
      /insufficient balance/i,
    );
  });

  it('the overlay is selective: a non-demoted active token stays spendable after reload', async () => {
    const { fake, baseUrl } = await startFake();
    const kv = new MemoryKeyValueStore();

    // Two sources: a 1000 (which a 1000-send selects, then finds conflicted) and a
    // 500 that is too small to cover the send, so it is never touched.
    const tab1 = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-679-sel', kv);
    const bigId = await seedServerToken(fake, tab1, SENDER, 1000n);
    await seedServerToken(fake, tab1, SENDER, 500n);
    await tab1.module.load();

    vi.spyOn(tab1.engine, 'transfer').mockRejectedValue(
      new TransferConflictError('TRANSACTION_HASH_MISMATCH: source already spent'),
    );
    await expect(tab1.module.send({ recipient: '@bob', amount: '1000', coinId: UCT })).rejects.toThrow(
      /insufficient balance/i,
    );
    expect(await kv.get(overlayKey(fake.network))).toBe(JSON.stringify([bigId]));

    // Reload: only the demoted 1000 is excluded; the untouched 500 is still spendable.
    const tab2 = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-679-sel', kv);
    await tab2.module.load();
    expect(tab2.module.getTokens().find((t) => t.id === `v2_${bigId}`)?.suspectedSpent).toBe(true);
    expect(tab2.module.getBalance(UCT)).toEqual([
      expect.objectContaining({ coinId: UCT, confirmedAmount: '500', confirmedTokenCount: 1 }),
    ]);
  });

  it('a legitimately-tombstoned token clears from the overlay (bounded, never shadows a re-add)', async () => {
    const { fake, baseUrl } = await startFake();
    const kv = new MemoryKeyValueStore();

    // Demote the only source (as above) → it lands on the durable overlay.
    const tab1 = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-679-tomb', kv);
    const sourceTokenId = await seedServerToken(fake, tab1, SENDER, 1000n);
    await tab1.module.load();
    vi.spyOn(tab1.engine, 'transfer').mockRejectedValue(
      new TransferConflictError('TRANSACTION_HASH_MISMATCH: source already spent'),
    );
    await expect(tab1.module.send({ recipient: '@bob', amount: '1000', coinId: UCT })).rejects.toThrow(
      /insufficient balance/i,
    );
    expect(await kv.get(overlayKey(fake.network))).toBe(JSON.stringify([sourceTokenId]));

    // The token is now LEGITIMATELY spent on-chain (the owner's other device):
    // the server row becomes a real tombstone. On the next converge the overlay
    // must drop it — it left the active view, so it can neither grow unbounded
    // nor shadow a legitimately re-added token later.
    const other = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-679-other');
    await other.client.applyInventoryDelta({
      transferId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      spent: [sourceTokenId],
      added: [],
    });
    expect(fake.getRow(SENDER.chainPubkey, sourceTokenId)?.status).toBe('removed');

    const tab2 = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-679-tomb', kv);
    await tab2.module.load();

    // The demoted token is gone (spent), and the overlay is pruned empty.
    expect(tab2.module.getTokens().find((t) => t.id === `v2_${sourceTokenId}`)).toBeUndefined();
    expect(await kv.get(overlayKey(fake.network))).toBeNull();
  });

  it('concurrent demotions do not clobber the overlay (serialized read-modify-write, #679)', async () => {
    const { fake, baseUrl } = await startFake();
    const kv = new MemoryKeyValueStore();
    const client = new WalletApiClient({ baseUrl, network: fake.network, deviceId: 'd-679-race', storage: kv });
    const provider = new WalletApiTokenStorageProvider({ client, stateStore: kv });
    provider.setIdentity(fullIdentity(SENDER));

    // Fire many demotions at once. Each markSuspectedSpent read-modify-writes the
    // persisted overlay; WITHOUT serialization concurrent calls read the same
    // stale set and the last write clobbers the rest, dropping suspectedSpent ids
    // (the phantom returns after reload). The mutex must retain ALL of them.
    const ids = Array.from({ length: 20 }, (_, i) => `race-tok-${i.toString().padStart(2, '0')}`);
    await Promise.all(ids.map((id) => provider.markSuspectedSpent(id)));

    const persisted = new Set(JSON.parse((await kv.get(overlayKey(fake.network)))!) as string[]);
    expect(persisted.size).toBe(ids.length);
    for (const id of ids) expect(persisted.has(id)).toBe(true);
  });
});

describe('history reload (tab refresh) — rebuilt from the server log (J4/J5, #549)', () => {
  it('J4: send → reload → the SENT record is hydrated from the server with its memo decrypted (no loss, no dupes)', async () => {
    const { fake, baseUrl } = await startFake();
    const kv = new MemoryKeyValueStore(); // the SHARED persisted stateStore — survives the "refresh"

    // Session 1 — send; the SENT history record is POSTed to the server (§10),
    // its memo an S6 envelope keyed by the SENDER's own field key (§8.3).
    const tab1 = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-h4', kv);
    await seedServerToken(fake, tab1, SENDER, 1000n);
    await tab1.module.load();
    const sent = await tab1.module.send({ recipient: '@bob', amount: '1000', coinId: UCT, memo: 'lunch' });
    expect(sent.status).toBe('completed');

    const inSession = tab1.module.getHistory();
    const sentDedup = `SENT_transfer_${sent.id}`;
    expect(inSession.filter((e) => e.dedupKey === sentDedup)).toHaveLength(1);
    expect(inSession.find((e) => e.dedupKey === sentDedup)).toMatchObject({
      type: 'SENT', amount: '1000', coinId: UCT, transferId: sent.id, memo: 'lunch',
    });

    // Session 2 — a NEW module instance over the SAME persisted stateStore (the
    // tab refresh). The thin provider keeps NO history, so before #549 this
    // rendered an empty history; now it rehydrates from walletApi.listHistory().
    const tab2 = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-h4', kv);
    await tab2.module.load();

    const reloaded = tab2.module.getHistory();
    const reloadedSent = reloaded.filter((e) => e.dedupKey === sentDedup);
    expect(reloadedSent).toHaveLength(1); // present + de-duplicated
    expect(reloadedSent[0]).toMatchObject({
      id: expect.any(String),
      type: 'SENT',
      amount: '1000',
      coinId: UCT,
      transferId: sent.id,
      memo: 'lunch', // S6 envelope decrypted with the owner's own field key
    });
    // The post-reload set matches the in-session set exactly (by dedupKey).
    expect(new Set(reloaded.map((e) => e.dedupKey))).toEqual(new Set(inSession.map((e) => e.dedupKey)));
  });

  it('J5: receive → reload → the RECEIVED record is hydrated with the sender nametag + memo decrypted', async () => {
    const { fake, baseUrl } = await startFake();
    const recipientKv = new MemoryKeyValueStore(); // the recipient's persisted store — survives the refresh

    // The sender (separate store) sends with a nametag + memo; both ride the
    // recipient-addressed S6 delivery envelope (dev.10 recipient-ECDH).
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-h5-s');
    await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();
    await sender.module.setNametag({
      name: 'api-1', token: {}, timestamp: Date.now(), format: 'txf', version: '2.0',
    });
    await sender.module.send({ recipient: '@bob', amount: '1000', coinId: UCT, memo: 'hi' });

    // Recipient receives in session 1 — the RECEIVED record is POSTed to the
    // recipient's server history with nametag + memo encrypted under the
    // RECIPIENT's own field key.
    const rcpt1 = makeFullPresetWallet(baseUrl, fake.network, RECIPIENT, 'd-h5-r', recipientKv);
    await rcpt1.module.load();
    const { transfers } = await rcpt1.module.receive();
    expect(transfers).toHaveLength(1);

    const inSession = rcpt1.module.getHistory().filter((e) => e.type === 'RECEIVED');
    expect(inSession).toHaveLength(1);
    expect(inSession[0]).toMatchObject({ amount: '1000', coinId: UCT, senderNametag: 'api-1', memo: 'hi' });
    const receivedDedup = inSession[0].dedupKey;

    // Session 2 — a NEW recipient module instance over the SAME persisted store
    // (reload). History rebuilds from the server; the RECEIVED record returns
    // with its sender nametag + memo decrypted (self-scoped at rest, §8.3).
    const rcpt2 = makeFullPresetWallet(baseUrl, fake.network, RECIPIENT, 'd-h5-r', recipientKv);
    await rcpt2.module.load();

    const reloaded = rcpt2.module.getHistory().filter((e) => e.type === 'RECEIVED');
    expect(reloaded).toHaveLength(1); // present + de-duplicated
    expect(reloaded[0]).toMatchObject({
      type: 'RECEIVED',
      amount: '1000',
      coinId: UCT,
      senderNametag: 'api-1', // decrypted counterparty identity
      memo: 'hi', // decrypted memo
    });
    expect(reloaded[0].dedupKey).toBe(receivedDedup); // same record, no dupes
  });
});
