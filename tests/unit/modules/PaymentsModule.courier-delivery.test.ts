/**
 * PaymentsModule consumes a TokenDeliveryTransport (the courier seam) — concerns 3/4/5.
 *
 * MONEY-PATH invariants asserted here (the courier is ADDITIVE, flag-gated, reversible):
 *  - DEFAULT OFF: with NO deliveryTransport, send/receive/load are byte-identical to
 *    today — delivery goes over Nostr `sendTokenTransfer`, the courier is never touched.
 *  - COEXIST (courier-primary): when a deliveryTransport is present, send DEPOSITS the
 *    envelope over the courier (recipientChainPubkey = the resolved peerInfo.chainPubkey),
 *    and does NOT also send over Nostr.
 *  - NOSTR FALLBACK: a courier `deposit()` FAILURE falls back to Nostr (no lost delivery).
 *  - JOURNAL-FIRST GC GATE: PENDING_V2_DELIVERIES is written BEFORE delivery and removed
 *    ONLY on a valid-ackSig `onDelivered(entryId)` for the courier path — NOT on bare
 *    deposit success. The Nostr-fallback path keeps the existing remove-after-send.
 *  - entryId↔blob mapping: the journal entry carries the courier entryId + transport tag
 *    so onDelivered(entryId) resolves the blob to GC (idempotent).
 *  - load() starts the courier receive/poll/replay loops alongside the Nostr replay.
 *  - REPLAY ROUTING: a courier-tagged journal entry replays over the COURIER (re-deposit),
 *    a Nostr-tagged / untagged entry replays over Nostr.
 *  - DEDUP: a token delivered over BOTH courier and Nostr is stored once (handleV2Transfer
 *    dedups by genesis id) — no double-spend.
 */
import { describe, it, expect, vi } from 'vitest';
import { createPaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { FullIdentity } from '../../../types';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase, HistoryRecord } from '../../../storage';
import type {
  TokenDeliveryTransport,
  TokenEnvelope,
  DeliveryHandle,
} from '../../../transport/courier/types';
import { STORAGE_KEYS_ADDRESS } from '../../../constants';
import { FakeTokenEngine } from '../token-engine/FakeTokenEngine';
import { encodeTokenBlob } from '../../../token-engine/token-blob';
import { bytesToHex } from '../../../core/crypto';
import type { V2TransferPayload } from '../../../types/v2-transfer';

const FAKE_PRIVATE_KEY = 'a'.repeat(64);
const FAKE_PUBKEY = '02' + 'b'.repeat(64);
const SENDER_TRANSPORT_PUBKEY = 'cc'.repeat(32);
const UCT = '11'.repeat(32);
const BOB_CHAIN_PUBKEY = '02' + 'ee'.repeat(64);
const BOB_TRANSPORT_PUBKEY = 'bob-transport-pubkey';

function mockIdentity(): FullIdentity {
  return {
    chainPubkey: FAKE_PUBKEY, l1Address: 'alpha1x', directAddress: 'DIRECT://x',
    privateKey: FAKE_PRIVATE_KEY, transportPubkey: 'dd'.repeat(32),
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

function mockTokenStorage(): TokenStorageProvider<TxfStorageDataBase> {
  let lastSaved: TxfStorageDataBase | null = null;
  const provider = {
    id: 'ts', name: 'ts', type: 'local',
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: () => true, getStatus: () => 'connected', setIdentity: vi.fn(),
    initialize: vi.fn().mockResolvedValue(true), shutdown: vi.fn().mockResolvedValue(undefined),
    save: vi.fn(async (data: TxfStorageDataBase) => { lastSaved = data; return { success: true, timestamp: 0 }; }),
    load: vi.fn(async () => (lastSaved
      ? { success: true, source: 'local', timestamp: 0, data: lastSaved }
      : { success: false, source: 'local', timestamp: 0 })),
    sync: vi.fn().mockResolvedValue({ success: true, added: 0, removed: 0, conflicts: 0 }),
    ...mockHistoryStore(),
  };
  return provider as unknown as TokenStorageProvider<TxfStorageDataBase>;
}

function mockTransport(): TransportProvider {
  return {
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue({
      chainPubkey: BOB_CHAIN_PUBKEY,
      transportPubkey: BOB_TRANSPORT_PUBKEY,
      directAddress: 'DIRECT://bob',
      nametag: 'bob',
    }),
    resolveTransportPubkeyInfo: vi.fn().mockResolvedValue(null),
    fetchPendingEvents: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(), isConnected: () => true,
  } as unknown as TransportProvider;
}

function mockOracle(): OracleProvider {
  return { validateToken: vi.fn().mockResolvedValue({ valid: true }), isDevMode: () => false } as unknown as OracleProvider;
}

/** A fake courier delivery transport that records deposits + exposes its bound sinks. */
class FakeDeliveryTransport implements TokenDeliveryTransport {
  readonly capabilities = { async: true, ack: true, addressing: 'pubkey' as const };
  readonly deposits: TokenEnvelope[] = [];
  receiveCalls = 0;
  /** When set, deposit() rejects (drives the Nostr fallback). */
  failDeposit = false;
  private nextEntry = 1;
  /** Captured from the module via setSinks — the GC sink keyed on the courier entryId. */
  onDelivered?: (entryId: string) => Promise<void>;
  /** Captured incoming-transfer sink (the module's handleV2Transfer). */
  onV2Transfer?: (payload: V2TransferPayload, senderPubkey: string) => Promise<void>;

  setSinks(sinks: {
    onV2Transfer?: (payload: V2TransferPayload, senderPubkey: string) => Promise<void>;
    onDelivered?: (entryId: string) => Promise<void>;
  }): void {
    if (sinks.onV2Transfer) this.onV2Transfer = sinks.onV2Transfer;
    if (sinks.onDelivered) this.onDelivered = sinks.onDelivered;
  }

  async deposit(envelope: TokenEnvelope): Promise<DeliveryHandle> {
    if (this.failDeposit) throw new Error('courier down');
    this.deposits.push(envelope);
    return {
      entryId: `entry-${this.nextEntry++}`,
      transferId: envelope.transferId,
      recipientChainPubkey: envelope.recipientChainPubkey,
      sentSeq: this.nextEntry,
    };
  }

  async receive(): Promise<void> {
    this.receiveCalls += 1;
  }

  /** Optional extra loop hooks the module calls when present (poll + ack replay). */
  pollSent = vi.fn(async () => {});
  replayAckPending = vi.fn(async () => {});
}

function setup(opts: { delivery?: TokenDeliveryTransport } = {}) {
  const engine = new FakeTokenEngine();
  const tsp = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();
  tsp.set('local', mockTokenStorage());
  const emitEvent = vi.fn();
  const transport = mockTransport();
  const storage = mockStorage();
  const deps: PaymentsModuleDependencies = {
    identity: mockIdentity(), storage: storage.provider, tokenStorageProviders: tsp,
    transport, oracle: mockOracle(), emitEvent, tokenEngine: engine,
    deliveryTransport: opts.delivery,
  };
  const module = createPaymentsModule({ debug: false });
  module.initialize(deps);
  return { module, engine, emitEvent, transport, storage, deps };
}

async function v2Payload(engine: FakeTokenEngine, amount: bigint): Promise<V2TransferPayload> {
  const st = await engine.mint({
    recipientPubkey: engine.getIdentity().chainPubkey,
    value: { assets: [{ coinId: UCT, amount }] },
  });
  return { type: 'V2_TRANSFER', version: '2.0', tokenBlob: bytesToHex(encodeTokenBlob(engine.encodeToken(st))) };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function deliver(module: ReturnType<typeof setup>['module'], payload: V2TransferPayload, id = 't1') {
  return (module as any).handleIncomingTransfer({
    id, senderTransportPubkey: SENDER_TRANSPORT_PUBKEY, payload, timestamp: 0,
  });
}

function journal(storage: { map: Map<string, string> }): Array<{
  transferId: string; tokenBlob: string; recipientPubkey: string; entryId?: string; transport?: string;
}> {
  const raw = storage.map.get(STORAGE_KEYS_ADDRESS.PENDING_V2_DELIVERIES);
  return raw ? JSON.parse(raw) : [];
}

describe('send() delivery — default OFF (no deliveryTransport) is byte-identical to Nostr-only', () => {
  it('delivers over Nostr and removes the journal entry; no courier involved', async () => {
    const { module, engine, transport, storage } = setup();
    await deliver(module, await v2Payload(engine, 100n));

    const res = await module.send({ recipient: '@bob', amount: '100', coinId: UCT });
    expect(res.status).toBe('completed');

    // Delivered over Nostr to the TRANSPORT pubkey (today's behavior), journal GC'd.
    expect(transport.sendTokenTransfer).toHaveBeenCalledTimes(1);
    expect((transport.sendTokenTransfer as any).mock.calls[0][0]).toBe(BOB_TRANSPORT_PUBKEY);
    expect(journal(storage)).toHaveLength(0);
  });
});

describe('send() delivery — courier present (coexist, courier-primary)', () => {
  it('deposits over the courier (recipientChainPubkey) and does NOT send over Nostr', async () => {
    const delivery = new FakeDeliveryTransport();
    const { module, engine, transport, storage } = setup({ delivery });
    await deliver(module, await v2Payload(engine, 100n));

    await module.send({ recipient: '@bob', amount: '100', coinId: UCT });

    expect(delivery.deposits).toHaveLength(1);
    expect(delivery.deposits[0].recipientChainPubkey).toBe(BOB_CHAIN_PUBKEY);
    expect(delivery.deposits[0].senderChainPubkey).toBe(FAKE_PUBKEY);
    // Courier-primary: Nostr is NOT also used for the happy path.
    expect(transport.sendTokenTransfer).not.toHaveBeenCalled();
    // Journal carries the entryId + transport tag (entryId↔blob mapping for GC).
    const entries = journal(storage);
    expect(entries).toHaveLength(1);
    expect(entries[0].transport).toBe('courier');
    expect(entries[0].entryId).toBe('entry-1');
  });

  it('does NOT GC PENDING_V2_DELIVERIES on bare deposit success — only on a valid-ackSig onDelivered', async () => {
    const delivery = new FakeDeliveryTransport();
    const { module, engine, storage } = setup({ delivery });
    await deliver(module, await v2Payload(engine, 100n));

    await module.send({ recipient: '@bob', amount: '100', coinId: UCT });
    // The token was deposited but not yet confirmed — the journal entry STAYS.
    expect(journal(storage)).toHaveLength(1);
    const entryId = journal(storage)[0].entryId!;

    // The courier fires onDelivered after verifying the recipient ackSig → GC now.
    await delivery.onDelivered!(entryId);
    expect(journal(storage)).toHaveLength(0);
  });

  it('onDelivered for an unknown/already-GC’d entryId is idempotent (no throw, no corruption)', async () => {
    const delivery = new FakeDeliveryTransport();
    const { module, engine, storage } = setup({ delivery });
    await deliver(module, await v2Payload(engine, 100n));
    await module.send({ recipient: '@bob', amount: '100', coinId: UCT });
    const entryId = journal(storage)[0].entryId!;

    await delivery.onDelivered!(entryId);
    await delivery.onDelivered!(entryId);     // double-fire
    await delivery.onDelivered!('never-seen'); // unknown
    expect(journal(storage)).toHaveLength(0);
  });
});

describe('send() delivery — courier outage falls back to Nostr (no lost delivery)', () => {
  it('a courier deposit() failure delivers over Nostr and GCs the journal', async () => {
    const delivery = new FakeDeliveryTransport();
    delivery.failDeposit = true;
    const { module, engine, transport, storage } = setup({ delivery });
    await deliver(module, await v2Payload(engine, 100n));

    const res = await module.send({ recipient: '@bob', amount: '100', coinId: UCT });
    expect(res.status).toBe('completed');

    // Deposit was attempted (and failed) → Nostr fallback delivered it.
    expect(transport.sendTokenTransfer).toHaveBeenCalledTimes(1);
    expect((transport.sendTokenTransfer as any).mock.calls[0][0]).toBe(BOB_TRANSPORT_PUBKEY);
    // The Nostr-fallback path removed the journal entry (today's behavior).
    expect(journal(storage)).toHaveLength(0);
  });
});

describe('load() — starts the courier loops alongside the Nostr replay', () => {
  it('calls receive() / pollSent() / replayAckPending() on the courier when present', async () => {
    const delivery = new FakeDeliveryTransport();
    const { module } = setup({ delivery });
    await module.load();
    // Loops are kicked fire-and-forget; allow microtasks to flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(delivery.receiveCalls).toBeGreaterThanOrEqual(1);
    expect(delivery.pollSent).toHaveBeenCalled();
    expect(delivery.replayAckPending).toHaveBeenCalled();
  });
});

describe('replay routing — a courier-tagged entry replays over the courier', () => {
  it('re-deposits a courier journal entry and does NOT push it over Nostr', async () => {
    const delivery = new FakeDeliveryTransport();
    const { module, engine, transport, storage } = setup({ delivery });
    await deliver(module, await v2Payload(engine, 100n));
    await module.send({ recipient: '@bob', amount: '100', coinId: UCT });
    expect(delivery.deposits).toHaveLength(1); // the original deposit
    expect(journal(storage)).toHaveLength(1);  // not yet confirmed

    await (module as any).replayPendingV2Deliveries();

    // Courier-tagged → re-deposited over the courier, never sent over Nostr.
    expect(delivery.deposits).toHaveLength(2);
    expect(transport.sendTokenTransfer).not.toHaveBeenCalled();
    // Still journaled (no onDelivered yet) — replay does not GC a courier entry.
    expect(journal(storage)).toHaveLength(1);
  });

  it('an untagged (legacy) journal entry replays over Nostr', async () => {
    const delivery = new FakeDeliveryTransport();
    const { module, transport, storage } = setup({ delivery });
    // Seed a legacy entry with no transport tag (as an older build journaled it).
    storage.map.set(STORAGE_KEYS_ADDRESS.PENDING_V2_DELIVERIES, JSON.stringify([
      { transferId: 'legacy', recipientPubkey: BOB_TRANSPORT_PUBKEY, tokenBlob: 'deadbeef', createdAt: 0 },
    ]));

    await (module as any).replayPendingV2Deliveries();

    expect(transport.sendTokenTransfer).toHaveBeenCalledTimes(1);
    expect(delivery.deposits).toHaveLength(0);
    expect(journal(storage)).toHaveLength(0); // Nostr path GCs after send
  });
});

describe('dedup — a token delivered over BOTH courier and Nostr is stored once', () => {
  it('the second delivery (any channel) is deduped by genesis id — no double-spend', async () => {
    const delivery = new FakeDeliveryTransport();
    const { module, engine, emitEvent } = setup({ delivery });
    const payload = await v2Payload(engine, 100n);
    // The recipient's own engine owns the minted token, so handleV2Transfer accepts it.
    // First delivery (e.g. courier path feeding the sink) stores it.
    await deliver(module, payload, 'first');
    const afterFirst = module.getTokens().length;
    emitEvent.mockClear();

    // Second delivery of the SAME token (e.g. the Nostr copy) — deduped.
    await deliver(module, payload, 'second');

    expect(module.getTokens()).toHaveLength(afterFirst); // stored once
    expect(emitEvent.mock.calls.find((c: any[]) => c[0] === 'transfer:incoming')).toBeUndefined();
  });
});
