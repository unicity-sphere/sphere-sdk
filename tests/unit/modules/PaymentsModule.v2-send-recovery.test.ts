/**
 * send() failure recovery + crash recovery (v2 engine path), driven over a REAL
 * shipped composition — the OWN-STORAGE wallet-api preset
 * (`createOwnStorageWalletApiProviders`, impl/shared/wallet-api/composition.ts):
 * local custody (the app's own token-storage provider) + the REAL
 * `WalletApiMailboxProvider` delivery rail + the REAL `WalletApiClient`, all
 * pointed at the in-process `FakeWalletApi` backend. Delivery and `walletApi`
 * are composed TOGETHER, exactly as every shipped preset returns them; nothing
 * here stands in for the delivery rail.
 *
 * Money-safety invariants:
 *  - once a transfer/split is certified on-chain, the source is NEVER restored
 *    as 'confirmed' (it is terminal 'spent');
 *  - the FINISHED output blob is journaled (PENDING_V2_DELIVERIES) before the
 *    delivery attempt and replayed on load(), so a rail failure or crash
 *    cannot lose the recipient's token;
 *  - a pre-certification failure restores the source as 'confirmed' AND persists
 *    the restore (no stuck-'transferring' on reload);
 *  - tokens stuck in 'transferring' after a crash are reconciled on load()
 *    against the network (spent → 'spent', unspent → 'confirmed');
 *  - a tombstoned re-delivery emits NO transfer:incoming and NO history entry.
 *
 * Rail failures are injected by wrapping the REAL provider's `deliver` (the
 * same seam the wallet-api delivery suite uses); every "was it delivered?"
 * assertion is anchored in the backend's own mailbox state, not in a double.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPaymentsModule, type PaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { FullIdentity } from '../../../types';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase, HistoryRecord } from '../../../storage';
import { STORAGE_KEYS_ADDRESS } from '../../../constants';
import { FakeTokenEngine, decodeFakeTokenAssets, decodeFakeTokenId } from '../token-engine/FakeTokenEngine';
import { decodeTokenBlob, encodeTokenBlob } from '../../../token-engine/token-blob';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import type { V2TransferPayload } from '../../../types/v2-transfer';
import { FakeWalletApi } from '../../support/fake-wallet-api';
import { MemoryKeyValueStore, testIdentity } from '../../support/wallet-api-test-helpers';
import { WalletApiClient } from '../../../wallet-api';
import { WalletApiMailboxProvider } from '../../../impl/shared/wallet-api';
import type { DeliverOptions, DeliveryReceipt } from '../../../transport/delivery-provider';

const UCT = '11'.repeat(32);
/** Real keypairs: the wallet-api signs an auth challenge with the private key. */
const SENDER = testIdentity(31);
const RECIPIENT = testIdentity(32); // '@bob'
const SENDER_TRANSPORT_PUBKEY = 'cc'.repeat(32);

function fullIdentity(id: { privateKey: string; chainPubkey: string }): FullIdentity {
  return {
    chainPubkey: id.chainPubkey,
    privateKey: id.privateKey,
    directAddress: `DIRECT://${id.chainPubkey.slice(0, 12)}`,
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

/** The own-storage preset's local custody provider (stands in for IndexedDB/File). */
function mockTokenStorage(): TokenStorageProvider<TxfStorageDataBase> & { savedData: () => TxfStorageDataBase | null } {
  let lastSaved: TxfStorageDataBase | null = null;
  const provider = {
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
    savedData: () => lastSaved,
  };
  return provider as unknown as TokenStorageProvider<TxfStorageDataBase> & { savedData: () => TxfStorageDataBase | null };
}

function mockTransport(): TransportProvider {
  return {
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue({
      chainPubkey: RECIPIENT.chainPubkey,
      transportPubkey: 'bob-transport-pubkey',
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

// =============================================================================
// Harness: the in-process backend + the real own-storage preset wiring
// =============================================================================

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  vi.restoreAllMocks();
});

async function startFake(): Promise<{ fake: FakeWalletApi; baseUrl: string }> {
  const fake = new FakeWalletApi({ decodeAssets: decodeFakeTokenAssets, decodeTokenId: decodeFakeTokenId });
  const baseUrl = await fake.start();
  cleanups.push(() => fake.stop());
  return { fake, baseUrl };
}

/**
 * Observation + fault injection on the REAL delivery provider: records the
 * blobs that actually reached the rail, and lets a test fail the next attempt
 * (a rail outage after certification). Deliveries are recorded only once the
 * real provider accepted them, so `lastBlobHex()` is genuinely "what the rail
 * carried".
 */
interface RailProbe {
  readonly delivered: { recipientPubkey: string; blobHex: string }[];
  failNext(error?: Error): void;
  lastBlobHex(): string | undefined;
}

function instrumentRail(delivery: WalletApiMailboxProvider): RailProbe {
  const real = delivery.deliver.bind(delivery);
  const delivered: { recipientPubkey: string; blobHex: string }[] = [];
  const failures: Error[] = [];
  vi.spyOn(delivery, 'deliver').mockImplementation(
    async (recipientPubkey: string, blob: Uint8Array, options: DeliverOptions): Promise<DeliveryReceipt> => {
      const failure = failures.shift();
      if (failure) throw failure;
      const receipt = await real(recipientPubkey, blob, options);
      delivered.push({ recipientPubkey, blobHex: bytesToHex(blob) });
      return receipt;
    }
  );
  return {
    delivered,
    failNext: (error: Error = new Error('delivery rail down')) => { failures.push(error); },
    lastBlobHex: () => delivered.at(-1)?.blobHex,
  };
}

interface Wallet {
  module: PaymentsModule;
  engine: FakeTokenEngine;
  client: WalletApiClient;
  delivery: WalletApiMailboxProvider;
  rail: RailProbe;
  emitEvent: ReturnType<typeof vi.fn>;
  transport: TransportProvider;
  storage: { provider: StorageProvider; map: Map<string, string> };
  tokenStorage: ReturnType<typeof mockTokenStorage>;
  deps: PaymentsModuleDependencies;
}

interface SharedState {
  storage?: { provider: StorageProvider; map: Map<string, string> };
  tokenStorage?: ReturnType<typeof mockTokenStorage>;
  engine?: FakeTokenEngine;
  kv?: MemoryKeyValueStore;
}

let deviceSeq = 0;

/**
 * The OWN-STORAGE wallet-api preset (S7): local custody + mailbox delivery with
 * composition-time custody 'external' + the client that preset always returns.
 * `PaymentsModule.initialize` binds the identity into the delivery provider,
 * which binds it into the client — the same path production takes.
 */
function makeOwnStorageWallet(
  baseUrl: string,
  network: string,
  who: { privateKey: string; chainPubkey: string },
  shared: SharedState = {}
): Wallet {
  const identity = fullIdentity(who);
  const kv = shared.kv ?? new MemoryKeyValueStore();
  const client = new WalletApiClient({ baseUrl, network, deviceId: `d-${++deviceSeq}`, storage: kv });
  const delivery = new WalletApiMailboxProvider({ client, custody: 'external', stateStore: kv });
  const rail = instrumentRail(delivery);
  // Trap 3: the engine's pubkey MUST be the wallet's own — incoming-transfer
  // ownership checks (engine.isOwnedBy) run against it.
  const engine = shared.engine ?? new FakeTokenEngine({ chainPubkey: hexToBytes(who.chainPubkey) });
  const storage = shared.storage ?? mockStorage();
  const tokenStorage = shared.tokenStorage ?? mockTokenStorage();
  const emitEvent = vi.fn();
  const transport = mockTransport();
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
  const module = createPaymentsModule({ debug: false });
  module.initialize(deps);
  cleanups.push(() => module.destroy());
  return { module, engine, client, delivery, rail, emitEvent, transport, storage, tokenStorage, deps };
}

async function setup(): Promise<Wallet & { fake: FakeWalletApi }> {
  const { fake, baseUrl } = await startFake();
  return { ...makeOwnStorageWallet(baseUrl, fake.network, SENDER), fake };
}

/** A fresh module over the SAME composition — a process restart. */
function restart(deps: PaymentsModuleDependencies): PaymentsModule {
  const module = createPaymentsModule({ debug: false });
  module.initialize({ ...deps });
  cleanups.push(() => module.destroy());
  return module;
}

/**
 * load() kicks its incoming-delivery / payment-request pulls fire-and-forget.
 * Await them (both coalesce onto the in-flight pass) so a test never ends with
 * a request still in flight against a backend that is about to be torn down.
 * Purely a teardown concern — it asserts nothing.
 */
async function settlePumps(module: PaymentsModule): Promise<void> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  await (module as any).pumpIncomingDeliveries();
  await (module as any).requests.pumpPaymentRequests();
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

async function v2Payload(engine: FakeTokenEngine, amount: bigint): Promise<V2TransferPayload> {
  const st = await engine.mint({
    recipientPubkey: engine.getIdentity().chainPubkey,
    value: { assets: [{ coinId: UCT, amount }] },
  });
  return { type: 'V2_TRANSFER', version: '2.0', tokenBlob: bytesToHex(encodeTokenBlob(engine.encodeToken(st))) };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function deliver(module: PaymentsModule, payload: V2TransferPayload) {
  return (module as any).deliveries.handleV2Transfer(payload, SENDER_TRANSPORT_PUBKEY);
}

function journal(storage: { map: Map<string, string> }): Array<{ transferId: string; tokenBlob: string; recipientPubkey: string }> {
  const raw = storage.map.get(STORAGE_KEYS_ADDRESS.PENDING_V2_DELIVERIES);
  return raw ? JSON.parse(raw) : [];
}

describe('send() — failure recovery (v2)', () => {
  it('transport failure AFTER engine.transfer (§3.1 #621): send resolves delivery-pending, source consumed, blob journaled', async () => {
    const { module, engine, rail, storage, fake } = await setup();
    await deliver(module, await v2Payload(engine, 100n));
    rail.failNext(new Error('relay down'));

    // Covenant: a post-certification delivery failure must NOT fail the sender.
    const result = await module.send({ recipient: '@bob', amount: '100', coinId: UCT });
    expect(result.status).not.toBe('failed');
    expect(result.deliveryPending).toBe(true);

    // Source was certified on-chain — consumed, never left spendable.
    expect(module.getTokens().some((t) => t.status === 'confirmed')).toBe(false);

    // The finished blob is journaled for replay. Since S3 the journal records
    // the recipient's CHAIN pubkey — the delivery port's canonical addressing.
    const entries = journal(storage);
    expect(entries).toHaveLength(1);
    expect(entries[0].recipientPubkey).toBe(RECIPIENT.chainPubkey);
    // …and the rail genuinely carried nothing: the backend mailbox is empty.
    expect(fake.listMailboxEntries(RECIPIENT.chainPubkey)).toHaveLength(0);
  });

  it('replayPendingV2Deliveries delivers the journaled blob and clears the journal', async () => {
    const { module, engine, rail, storage, fake } = await setup();
    await deliver(module, await v2Payload(engine, 100n));
    rail.failNext(new Error('relay down'));
    const result = await module.send({ recipient: '@bob', amount: '100', coinId: UCT });
    expect(result.deliveryPending).toBe(true);
    expect(journal(storage)).toHaveLength(1);
    const journaledBlob = journal(storage)[0].tokenBlob;

    await (module as any).deliveries.replayPendingV2Deliveries();

    expect(journal(storage)).toHaveLength(0);
    // Exactly the journaled bytes went onto the rail…
    expect(rail.lastBlobHex()).toBe(journaledBlob);
    // …and the backend really holds that token as an unclaimed entry for @bob.
    const entries = fake.listMailboxEntries(RECIPIENT.chainPubkey);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: 'unclaimed',
      tokenId: decodeTokenBlob(hexToBytes(journaledBlob)).tokenId,
      senderPubkey: SENDER.chainPubkey,
    });
  });

  it('split: change token is stored and the recipient blob journaled even when delivery fails', async () => {
    const { module, engine, rail, storage, fake } = await setup();
    await deliver(module, await v2Payload(engine, 1000n));
    rail.failNext(new Error('relay down'));

    // Covenant §3.1 (#621): delivery failure must not fail the sender.
    const result = await module.send({ recipient: '@bob', amount: '300', coinId: UCT });
    expect(result.deliveryPending).toBe(true);

    const tokens = module.getTokens();
    // Change token (700) survived as confirmed; the split source was consumed on-chain.
    const change = tokens.find((t) => t.amount === '700');
    expect(change?.status).toBe('confirmed');
    expect(tokens.some((t) => t.amount === '1000' && t.status === 'confirmed')).toBe(false);
    // Recipient's 300 blob is journaled for replay; nothing reached the mailbox.
    expect(journal(storage)).toHaveLength(1);
    expect(fake.listMailboxEntries(RECIPIENT.chainPubkey)).toHaveLength(0);
  });

  it('pre-certification failure (engine.transfer throws): source restored confirmed, restore persisted, journal empty', async () => {
    const { module, engine, tokenStorage, storage, fake } = await setup();
    await deliver(module, await v2Payload(engine, 100n));
    vi.spyOn(engine, 'transfer').mockRejectedValueOnce(new Error('aggregator 500'));
    const savesBefore = (tokenStorage.save as any).mock.calls.length;

    await expect(module.send({ recipient: '@bob', amount: '100', coinId: UCT })).rejects.toThrow('aggregator 500');

    const tokens = module.getTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].status).toBe('confirmed');
    expect(journal(storage)).toHaveLength(0);
    expect((tokenStorage.save as any).mock.calls.length).toBeGreaterThan(savesBefore);
    // Nothing certified → nothing delivered.
    expect(fake.listMailboxEntries(RECIPIENT.chainPubkey)).toHaveLength(0);
  });
});

describe('load() — crash recovery of stuck-transferring tokens (v2)', () => {
  it("reconciles a persisted 'transferring' token: unspent → confirmed", async () => {
    const first = await setup();
    await deliver(first.module, await v2Payload(first.engine, 100n));
    // Simulate a crash mid-send: persist with status 'transferring'.
    const t = first.module.getTokens()[0];
    t.status = 'transferring';
    await (first.module as any).save();

    // "Restart": fresh module over the same composition (storage + engine + rail).
    const second = restart(first.deps);
    await second.load();
    await settlePumps(second);

    const tokens = second.getTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].status).toBe('confirmed');
  });

  it("reconciles a persisted 'transferring' token: spent on-chain → terminal 'spent'", async () => {
    const first = await setup();
    await deliver(first.module, await v2Payload(first.engine, 100n));
    const t = first.module.getTokens()[0];
    t.status = 'transferring';
    await (first.module as any).save();
    vi.spyOn(first.engine, 'isSpent').mockResolvedValue(true);

    const second = restart(first.deps);
    await second.load();
    await settlePumps(second);

    expect(second.getTokens()[0].status).toBe('spent');
  });
});

describe('journaled deliveries survive a wallet composed without a delivery rail', () => {
  it('does not burn the poison budget across repeated loads, and delivers once a rail appears', async () => {
    // A wallet can legitimately run with no delivery provider (the base bundle
    // composition — non-payment use: DMs, group chat, market). Replaying a
    // journaled blob against a missing rail must NOT count as a delivery
    // attempt — 6 such loads would mark the entry `undeliverable`, and
    // already-certified funds would never auto-deliver again.
    const { fake, baseUrl } = await startFake();
    const engine = new FakeTokenEngine({ chainPubkey: hexToBytes(SENDER.chainPubkey) });
    const tokenStorage = mockTokenStorage();
    const storage = mockStorage();
    const railless = createPaymentsModule({ debug: false });
    railless.initialize({
      identity: fullIdentity(SENDER), storage: storage.provider,
      tokenStorageProviders: new Map([[tokenStorage.id, tokenStorage]]),
      transport: mockTransport(), oracle: mockOracle(), emitEvent: vi.fn(), tokenEngine: engine,
    } as PaymentsModuleDependencies);
    cleanups.push(() => railless.destroy());

    (railless as any).deliveries.replayBackoffBaseMs = 0; // no real sleeps between retries
    // A REAL certified blob (the rail that appears later actually deposits it).
    const stranded = await engine.mint({
      recipientPubkey: hexToBytes(RECIPIENT.chainPubkey),
      value: { assets: [{ coinId: UCT, amount: 100n }] },
    });
    const strandedBlobHex = bytesToHex(encodeTokenBlob(engine.encodeToken(stranded)));
    await (railless as any).deliveries.savePendingV2Delivery({
      transferId: 'tx-stranded',
      recipientPubkey: RECIPIENT.chainPubkey,
      tokenBlob: strandedBlobHex,
      createdAt: Date.now(),
    });

    // Drive the replay DIRECTLY, more times than MAX_DELIVERY_REPLAY_ATTEMPTS (6).
    // load() fires it as `void …catch()`, so awaiting load() would not await the
    // replay and the test would pass without exercising anything.
    await railless.load();
    for (let i = 0; i < 8; i++) await (railless as any).deliveries.replayPendingV2Deliveries();

    const entries = journal(storage);
    expect(entries).toHaveLength(1);
    // RED without the guard: attempts climbs to 6 and undeliverable flips true.
    expect((entries[0] as any).undeliverable).toBeFalsy();
    expect((entries[0] as any).attempts ?? 0).toBe(0);

    // Composing the real rail later (the own-storage preset over the SAME local
    // storage) still delivers the certified blob.
    const withRail = makeOwnStorageWallet(baseUrl, fake.network, SENDER, { storage, tokenStorage, engine });
    await withRail.module.load();
    await (withRail.module as any).deliveries.replayPendingV2Deliveries();

    // Delivered ONCE, and the backend holds it (load()'s fire-and-forget replay
    // may win the race with the explicit pass — the in-flight guard makes that
    // exactly one delivery either way).
    await vi.waitFor(() => {
      expect(withRail.rail.delivered).toHaveLength(1);
      expect(journal(storage)).toHaveLength(0);
    });
    expect(withRail.rail.lastBlobHex()).toBe(strandedBlobHex);
    const mailbox = fake.listMailboxEntries(RECIPIENT.chainPubkey);
    expect(mailbox).toHaveLength(1);
    expect(mailbox[0]).toMatchObject({
      status: 'unclaimed',
      transferId: 'tx-stranded',
      tokenId: decodeTokenBlob(hexToBytes(strandedBlobHex)).tokenId,
    });
    await settlePumps(withRail.module);
  });
});

describe('handleV2Transfer — storage rejection gates events (v2)', () => {
  it('a tombstoned re-delivery emits NO transfer:incoming and writes NO history', async () => {
    const { module, engine, emitEvent, fake } = await setup();
    const payload = await v2Payload(engine, 100n);
    await deliver(module, payload);
    // Spend it: the send tombstones the exact received state.
    await module.send({ recipient: '@bob', amount: '100', coinId: UCT });
    expect(module.getTokens()).toHaveLength(0);
    // The real rail carried the send (the tombstone is the delivered state).
    const deliveredEntries = fake.listMailboxEntries(RECIPIENT.chainPubkey);
    expect(deliveredEntries.length).toBeGreaterThan(0);
    emitEvent.mockClear();

    // Relay re-delivers the original transfer after the state was spent.
    await deliver(module, payload);

    expect(module.getTokens()).toHaveLength(0);
    expect(emitEvent.mock.calls.find((c: any[]) => c[0] === 'transfer:incoming')).toBeUndefined();
    expect(module.getHistory().filter((h) => h.type === 'RECEIVED' && h.tokenId?.startsWith('v2_'))).toHaveLength(1); // only the original
    // The re-delivery created no new mailbox traffic either.
    expect(fake.listMailboxEntries(RECIPIENT.chainPubkey)).toHaveLength(deliveredEntries.length);
  });
});

/* eslint-enable @typescript-eslint/no-explicit-any */
