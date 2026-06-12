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
import { FakeWalletApi } from '../../support/fake-wallet-api';
import { MemoryKeyValueStore, testIdentity } from '../../support/wallet-api-test-helpers';
import { WalletApiClient } from '../../../wallet-api';
import { WalletApiMailboxProvider, WalletApiTokenStorageProvider } from '../../../impl/shared/wallet-api';
import { encodeTokenBlob } from '../../../token-engine/token-blob';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { deriveFieldEncryptionKey, encryptField, FIELD_ENVELOPE_PREFIX } from '../../../core/field-encryption';

const UCT = '11'.repeat(32);
const SENDER = testIdentity(11);
const RECIPIENT = testIdentity(12);
const STRANGER = testIdentity(13);

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

/** Build a wallet over the FULL wallet-api preset (storage + delivery, custody 'inventory'). */
function makeFullPresetWallet(
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

describe('incoming — mailbox pull feeds handleV2Transfer (S3)', () => {
  it('receive(): fetch → local verify → store → ack claimed (handoff) → RECEIVED history POST', async () => {
    const { fake, baseUrl } = await startFake();
    const sender = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'd-in-1');
    const sourceTokenId = await seedServerToken(fake, sender, SENDER, 1000n);
    await sender.module.load();
    const result = await sender.module.send({ recipient: '@bob', amount: '1000', coinId: UCT });

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

    // transfer:incoming fired; the claim's RECEIVED record was POSTed (§10).
    expect(recipient.emitEvent.mock.calls.some((c) => c[0] === 'transfer:incoming')).toBe(true);
    const received = fake
      .getHistoryRecords(RECIPIENT.chainPubkey)
      .find((r) => (r.dedupKey as string).startsWith('RECEIVED_'));
    expect(received).toBeDefined();
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

    // Deliver fails once (mailbox outage) AFTER the engine certified.
    const realDeliver = sender.delivery.deliver.bind(sender.delivery);
    let failures = 1;
    vi.spyOn(sender.delivery, 'deliver').mockImplementation((a, b, c) =>
      failures-- > 0 ? Promise.reject(new Error('mailbox down')) : realDeliver(a, b, c)
    );

    await expect(sender.module.send({ recipient: '@bob', amount: '1000', coinId: UCT })).rejects.toThrow('mailbox down');

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
});
