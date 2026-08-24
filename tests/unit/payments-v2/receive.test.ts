import { describe, expect, it, vi } from 'vitest';

import type { RegistryReader } from '../../../modules/payments-v2/inventory/InventoryView';
import type { DeliveryPort, IncomingDelivery } from '../../../modules/payments-v2/ports';
import {
  ACK_BATCH_SIZE,
  REFRESH_INTERVAL_MS,
  Receive,
  receivedDedupKey,
  type ReceiveDeps,
  type ReceiveEngine,
  type ReceiveView,
  type ReceivedRecord,
  type StoredIncoming,
} from '../../../modules/payments-v2/receive/Receive';
import type { AckOutcome, AckRequest } from '../../../modules/payments-v2/ports';
import type { StreamCursor } from '../../../modules/payments-v2/stores';
import type { EngineVerifyResult, SphereToken, TokenBlob } from '../../../token-engine';
import type { IncomingTransfer } from '../../../types';
import { memoryKV, registryStub, type MemoryKV } from './support';

const OWN = `02${'aa'.repeat(32)}`;
const OTHER = `02${'bb'.repeat(32)}`;
const COIN = 'cc'.repeat(32);
const T = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));
const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

interface StubMeta {
  tokenId: string;
  stateHash: string;
  owner: string;
  assets: { coinId: string; amount: string }[];
}

const meta = (tokenId: string, stateHash: string, opts: { owner?: string; amount?: string } = {}): StubMeta => ({
  tokenId,
  stateHash,
  owner: opts.owner ?? OWN,
  assets: [{ coinId: COIN, amount: opts.amount ?? '1000' }],
});

const blobOf = (m: StubMeta): Uint8Array => new TextEncoder().encode(JSON.stringify(m));
const metaOf = (token: SphereToken): StubMeta => token.sdkToken as unknown as StubMeta;
const skey = (m: { tokenId: string; stateHash: string }): string => `${m.tokenId}:${m.stateHash}`;

class StubEngine implements ReceiveEngine {
  badProof = new Set<string>();
  spentStates = new Set<string>();
  verifyOutageOn = new Set<string>();
  isSpentOutage = false;

  getIdentity(): { chainPubkey: Uint8Array } {
    return { chainPubkey: hexToBytes(OWN) };
  }

  async decodeToken(blob: TokenBlob): Promise<SphereToken> {
    const parsed = JSON.parse(new TextDecoder().decode(blob.token)) as StubMeta;
    if (typeof parsed.tokenId !== 'string') throw new Error('not a stub blob');
    return {
      sdkToken: parsed as never,
      blob,
      value: { assets: parsed.assets.map((a) => ({ coinId: a.coinId, amount: BigInt(a.amount) })) },
    };
  }

  async verify(token: SphereToken): Promise<EngineVerifyResult> {
    if (this.verifyOutageOn.has(skey(metaOf(token)))) throw new Error('trust base unavailable');
    return this.badProof.has(skey(metaOf(token))) ? { ok: false, reason: 'bad proof' } : { ok: true };
  }

  isOwnedBy(token: SphereToken, pubkey: Uint8Array): boolean {
    return metaOf(token).owner === bytesToHex(pubkey);
  }

  async isSpent(token: SphereToken): Promise<boolean> {
    if (this.isSpentOutage) throw new Error('gateway unavailable');
    return this.spentStates.has(skey(metaOf(token)));
  }

  tokenId(token: SphereToken): string {
    return metaOf(token).tokenId;
  }

  async deliveryKeys(blobBytes: Uint8Array): Promise<{ tokenId: string; stateHash: string }> {
    const parsed = JSON.parse(new TextDecoder().decode(blobBytes)) as StubMeta;
    return { tokenId: parsed.tokenId, stateHash: parsed.stateHash };
  }
}

class FakeView implements ReceiveView {
  held = new Map<string, string>();
  storeCalls: StoredIncoming[] = [];
  throwOn = new Set<string>();

  heldState(tokenId: string): string | null {
    return this.held.get(tokenId) ?? null;
  }

  async store(entry: StoredIncoming): Promise<void> {
    if (this.throwOn.has(skey(entry))) throw new Error('view store crashed');
    this.storeCalls.push(entry);
    this.held.set(entry.tokenId, entry.stateHash);
  }
}

interface FakeEntry {
  deliveryId: string;
  seq: number;
  blob: Uint8Array;
  senderPubkey?: string;
  senderNametag?: string;
  memo?: string;
  transferId?: string;
  status: 'unacked' | 'claimed' | 'rejected';
  fetchGate?: () => Promise<void>;
}

interface AckLogged {
  deliveryId: string;
  disposition: 'claimed' | 'rejected';
  reason?: string;
  storesAtAck: number;
}

class FakeDelivery implements DeliveryPort {
  entries: FakeEntry[] = [];
  ackLog: AckLogged[] = [];
  sinceLog: (string | undefined)[] = [];
  acksUntilFail = Infinity;
  claimConflicts = new Set<string>();
  /** The epoch the next listed page reports (the S7 incomingEpoch surface). */
  pageEpoch = 'e1';
  private lastEpoch: string | null = null;
  private seq = 0;
  private wakeCbs = new Set<() => void>();

  constructor(private readonly view: FakeView) {}

  add(m: StubMeta, opts: Partial<Omit<FakeEntry, 'deliveryId' | 'seq' | 'blob' | 'status'>> = {}): FakeEntry {
    return this.addRaw(blobOf(m), `d:${m.tokenId}:${m.stateHash}`, opts);
  }

  addRaw(
    blob: Uint8Array,
    deliveryId: string,
    opts: Partial<Omit<FakeEntry, 'deliveryId' | 'seq' | 'blob' | 'status'>> = {}
  ): FakeEntry {
    this.seq += 1;
    const entry: FakeEntry = { deliveryId, seq: this.seq, blob, status: 'unacked', ...opts };
    this.entries.push(entry);
    return entry;
  }

  bindDeliveryKeys(): void {}

  async deliver(): Promise<never> {
    throw new Error('not in this lane');
  }

  async *incoming(sinceCursor?: string): AsyncGenerator<IncomingDelivery> {
    this.sinceLog.push(sinceCursor);
    this.lastEpoch = this.pageEpoch;
    const since = sinceCursor === undefined ? 0 : Number(sinceCursor);
    for (const entry of [...this.entries].sort((a, b) => a.seq - b.seq)) {
      if (entry.seq <= since || entry.status !== 'unacked') continue;
      yield {
        deliveryId: entry.deliveryId,
        cursor: String(entry.seq),
        ...(entry.senderPubkey !== undefined ? { senderPubkey: entry.senderPubkey } : {}),
        ...(entry.senderNametag !== undefined ? { senderNametag: entry.senderNametag } : {}),
        ...(entry.memo !== undefined ? { memo: entry.memo } : {}),
        ...(entry.transferId !== undefined ? { transferId: entry.transferId } : {}),
        fetchBlob: async (): Promise<Uint8Array> => {
          await entry.fetchGate?.();
          return entry.blob;
        },
      };
    }
  }

  incomingEpoch(): string | null {
    return this.lastEpoch;
  }

  async ack(
    deliveryId: string,
    disposition: 'claimed' | 'rejected',
    reason?: 'invalid' | 'not-owned' | 'storage-rejected' | 'other'
  ): Promise<void> {
    if (this.ackLog.length >= this.acksUntilFail) throw new Error('ack flush failed');
    if (disposition === 'claimed' && this.claimConflicts.has(deliveryId)) {
      // Server failed[] bucket shape: the lineage CONFLICT surfaced by the port.
      throw Object.assign(new Error(`mailbox claim failed for ${deliveryId}: CONFLICT`), {
        code: 'MAILBOX_CLAIM_FAILED',
        failureCode: 'CONFLICT',
      });
    }
    this.ackLog.push({
      deliveryId,
      disposition,
      ...(reason !== undefined ? { reason } : {}),
      storesAtAck: this.view.storeCalls.length,
    });
    const entry = this.entries.find((e) => e.deliveryId === deliveryId && e.status === 'unacked');
    if (entry) entry.status = disposition;
  }

  // Optional on the port, so it stays undefined until a test opts in — that is
  // also how the "provider without ackBatch" path gets exercised.
  ackBatch?: (acks: readonly AckRequest[]) => Promise<readonly AckOutcome[]>;
  batchCalls: string[][] = [];
  /** Ids the batch returns NO outcome for — the caller must treat them as unsettled. */
  unsettled = new Set<string>();
  batchFailure: 'none' | 'retryable' | 'hard' = 'none';

  enableBatch(): void {
    this.ackBatch = (acks) => this.doBatch(acks);
  }

  private async doBatch(acks: readonly AckRequest[]): Promise<readonly AckOutcome[]> {
    this.batchCalls.push(acks.map((a) => a.deliveryId));
    if (this.batchFailure === 'retryable') {
      throw Object.assign(new Error('rate limited'), { retryable: true });
    }
    if (this.batchFailure === 'hard') throw new Error('batch endpoint down');
    const out: AckOutcome[] = [];
    for (const a of acks) {
      if (this.unsettled.has(a.deliveryId)) continue;
      if (a.disposition === 'claimed' && this.claimConflicts.has(a.deliveryId)) {
        out.push({ deliveryId: a.deliveryId, status: 'conflict' });
        continue;
      }
      this.ackLog.push({
        deliveryId: a.deliveryId,
        disposition: a.disposition,
        ...(a.reason !== undefined ? { reason: a.reason } : {}),
        storesAtAck: this.view.storeCalls.length,
      });
      const entry = this.entries.find((e) => e.deliveryId === a.deliveryId && e.status === 'unacked');
      if (entry) entry.status = a.disposition;
      out.push({ deliveryId: a.deliveryId, status: 'settled' });
    }
    return out;
  }

  onWake(cb: () => void): () => void {
    this.wakeCbs.add(cb);
    return () => this.wakeCbs.delete(cb);
  }

  fireWake(): void {
    for (const cb of this.wakeCbs) cb();
  }

  claimed(): AckLogged[] {
    return this.ackLog.filter((a) => a.disposition === 'claimed');
  }
}

const registry: RegistryReader = registryStub({
  getSymbol: (coinId) => `SYM${coinId.slice(0, 2)}`,
  getName: (coinId) => `coin-${coinId.slice(0, 2)}`,
  getDecimals: () => 8,
});

interface Harness {
  engine: StubEngine;
  view: FakeView;
  delivery: FakeDelivery;
  kv: MemoryKV;
  events: IncomingTransfer[];
  attentions: { transferId: string; code: string; detail?: string }[];
  historyLog: ReceivedRecord[];
  receive: Receive;
  epoch: string;
  historyFail: boolean;
  /**
   * One entry per mirror refresh asked for DURING the drain, recording how many
   * claimed acks had reached the server by then — a refresh that sees no acks
   * shows the user nothing new (§5.7 progressive balance).
   */
  refreshes: number[];
  /** Clock the drain reads; tests advance it to cross the refresh throttle. */
  clock: number;
}

function makeHarness(
  opts: { epoch?: string; kvSeed?: Record<string, unknown>; advancePerEntryMs?: number } = {}
): Harness {
  const engine = new StubEngine();
  const view = new FakeView();
  const delivery = new FakeDelivery(view);
  const kv = memoryKV({ ...(opts.kvSeed !== undefined ? { seed: opts.kvSeed } : {}) });
  const events: IncomingTransfer[] = [];
  const attentions: Harness['attentions'] = [];
  const historyLog: ReceivedRecord[] = [];
  const harness: Harness = {
    engine,
    view,
    delivery,
    kv,
    events,
    attentions,
    historyLog,
    epoch: opts.epoch ?? 'e1',
    historyFail: false,
    refreshes: [],
    clock: 1_700_000_000_000,
    receive: null as unknown as Receive,
  };
  const deps: ReceiveDeps = {
    delivery,
    engine: () => engine,
    view,
    kv,
    registry,
    recordReceived: async (record) => {
      if (harness.historyFail) throw new Error('history down');
      historyLog.push(record);
    },
    emit: (_event, transfer) => {
      events.push(transfer);
    },
    attention: (transferId, code, detail) => {
      attentions.push({ transferId, code, ...(detail !== undefined ? { detail } : {}) });
    },
    syncEpoch: () => harness.epoch,
    refreshView: () => {
      harness.refreshes.push(delivery.ackLog.filter((a) => a.disposition === 'claimed').length);
    },
    // Each read advances the clock when the test asks for it, so a multi-entry
    // drain crosses the refresh throttle the way a real one does.
    now: () => {
      harness.clock += opts.advancePerEntryMs ?? 0;
      return harness.clock;
    },
  };
  harness.receive = new Receive(deps);
  return harness;
}

const CURSOR_KEY = 'cursor:mailbox';

describe('payments-v2 Receive drain', () => {
  it('verified-before-balance: a bad-proof token never enters the view and is acked rejected(invalid) with no event and no history', async () => {
    const h = makeHarness();
    h.engine.badProof.add(`${T(1)}:S1`);
    h.delivery.add(meta(T(1), 'S1'));

    const transfers = await h.receive.drainOnce();

    expect(transfers).toEqual([]);
    expect(h.view.storeCalls).toEqual([]);
    expect(h.events).toEqual([]);
    expect(h.historyLog).toEqual([]);
    expect(h.delivery.ackLog).toEqual([
      expect.objectContaining({ disposition: 'rejected', reason: 'invalid' }),
    ]);
  });

  it('verified-before-balance: a token not owned by this wallet never enters the view and is acked rejected(not-owned)', async () => {
    const h = makeHarness();
    h.delivery.add(meta(T(1), 'S1', { owner: OTHER }));

    await h.receive.drainOnce();

    expect(h.view.storeCalls).toEqual([]);
    expect(h.events).toEqual([]);
    expect(h.historyLog).toEqual([]);
    expect(h.delivery.ackLog).toEqual([
      expect.objectContaining({ disposition: 'rejected', reason: 'not-owned' }),
    ]);
  });

  it('an undecodable blob is acked rejected(invalid) and never wedges the drain', async () => {
    const h = makeHarness();
    h.delivery.addRaw(new TextEncoder().encode('garbage'), 'd:garbage');
    h.delivery.add(meta(T(2), 'S1'));

    const transfers = await h.receive.drainOnce();

    expect(h.delivery.ackLog[0]).toEqual(expect.objectContaining({ disposition: 'rejected', reason: 'invalid' }));
    expect(h.delivery.ackLog[1]).toEqual(expect.objectContaining({ disposition: 'claimed' }));
    expect(transfers).toHaveLength(1);
  });

  it('duplicate (tokenId,stateHash) re-delivery acks claimed without a second store, event, or history leg (at-least-once absorb)', async () => {
    const h = makeHarness();
    h.delivery.add(meta(T(1), 'S1'));
    h.delivery.acksUntilFail = 0;

    const first = await h.receive.drainOnce();
    expect(first).toHaveLength(1);
    expect(h.delivery.entries[0].status).toBe('unacked');

    h.delivery.acksUntilFail = Infinity;
    const second = await h.receive.drainOnce();

    expect(second).toEqual([]);
    expect(h.delivery.claimed()).toHaveLength(1);
    expect(h.view.storeCalls).toHaveLength(1);
    expect(h.events).toHaveLength(1);
    expect(h.historyLog).toHaveLength(1);
  });

  it('an OLDER already-spent state of a held token is rejected and never displaces the live state (#687 gate)', async () => {
    const h = makeHarness();
    h.view.held.set(T(1), 'S2');
    h.engine.spentStates.add(`${T(1)}:S1`);
    h.delivery.add(meta(T(1), 'S1'));

    await h.receive.drainOnce();

    expect(h.view.storeCalls).toEqual([]);
    expect(h.view.held.get(T(1))).toBe('S2');
    expect(h.events).toEqual([]);
    expect(h.delivery.ackLog).toEqual([
      expect.objectContaining({ disposition: 'rejected', reason: 'invalid' }),
    ]);
  });

  it('an isSpent outage on the #687 gate leaves the entry unacked for retry; a later drain accepts the unspent new state', async () => {
    const h = makeHarness();
    h.view.held.set(T(1), 'S1');
    h.delivery.add(meta(T(1), 'S3'));
    h.engine.isSpentOutage = true;

    const first = await h.receive.drainOnce();
    expect(first).toEqual([]);
    expect(h.delivery.ackLog).toEqual([]);
    expect(h.view.storeCalls).toEqual([]);

    h.engine.isSpentOutage = false;
    const second = await h.receive.drainOnce();

    expect(second).toHaveLength(1);
    expect(h.view.held.get(T(1))).toBe('S3');
    expect(h.delivery.claimed()).toHaveLength(1);
  });

  it('an engine outage mid-drain leaves that entry and its suffix unacked; a later drain processes them (crash-mid-drain absorb)', async () => {
    const h = makeHarness();
    h.delivery.add(meta(T(1), 'S1'));
    h.delivery.add(meta(T(2), 'S1'));
    h.delivery.add(meta(T(3), 'S1'));
    h.engine.verifyOutageOn.add(`${T(2)}:S1`);

    const first = await h.receive.drainOnce();

    expect(first.map((t) => t.id)).toEqual([T(1)]);
    expect(h.delivery.claimed().map((a) => a.deliveryId)).toEqual([`d:${T(1)}:S1`]);
    expect(h.delivery.entries[1].status).toBe('unacked');
    expect(h.delivery.entries[2].status).toBe('unacked');
    expect(h.kv.map.get(CURSOR_KEY)).toEqual({ cursor: '1', syncEpoch: 'e1' });

    h.engine.verifyOutageOn.clear();
    const second = await h.receive.drainOnce();

    expect(h.delivery.sinceLog[1]).toBe('1');
    expect(second.map((t) => t.id)).toEqual([T(2), T(3)]);
    expect(h.delivery.claimed()).toHaveLength(3);
    expect(h.kv.map.get(CURSOR_KEY)).toEqual({ cursor: '3', syncEpoch: 'e1' });
  });

  it('acks batch at 200: the first flush happens only after 200 entries are stored, the remainder flushes at drain end', async () => {
    const h = makeHarness();
    for (let i = 1; i <= 250; i++) h.delivery.add(meta(i.toString(16).padStart(64, '0'), 'S1'));

    const transfers = await h.receive.drainOnce();

    expect(transfers).toHaveLength(250);
    expect(h.delivery.ackLog).toHaveLength(250);
    expect(h.delivery.ackLog[0].storesAtAck).toBe(ACK_BATCH_SIZE);
    expect(h.delivery.ackLog[ACK_BATCH_SIZE].storesAtAck).toBe(250);
    expect(h.kv.sets.map((s) => s.value)).toEqual([
      { cursor: '200', syncEpoch: 'e1' },
      { cursor: '250', syncEpoch: 'e1' },
    ]);
  });

  it('a mid-flush ack failure leaves the remaining entries unacked and persists the cursor only for the acked prefix', async () => {
    const h = makeHarness();
    h.delivery.add(meta(T(1), 'S1'));
    h.delivery.add(meta(T(2), 'S1'));
    h.delivery.add(meta(T(3), 'S1'));
    h.delivery.acksUntilFail = 1;

    const first = await h.receive.drainOnce();

    expect(first).toHaveLength(3);
    expect(h.delivery.claimed().map((a) => a.deliveryId)).toEqual([`d:${T(1)}:S1`]);
    expect(h.kv.map.get(CURSOR_KEY)).toEqual({ cursor: '1', syncEpoch: 'e1' });
    expect(h.delivery.entries[1].status).toBe('unacked');
    expect(h.delivery.entries[2].status).toBe('unacked');

    h.delivery.acksUntilFail = Infinity;
    const second = await h.receive.drainOnce();

    expect(second).toEqual([]);
    expect(h.delivery.claimed()).toHaveLength(3);
    expect(h.view.storeCalls).toHaveLength(3);
    expect(h.events).toHaveLength(3);
  });

  it('a CONFLICT-bucket claim is terminally rejected(other): cursor advances, the next drain does not re-process, attention emitted (§5.7)', async () => {
    const h = makeHarness();
    const entry = h.delivery.add(meta(T(1), 'S1'), { transferId: 'tx-c' });
    h.delivery.add(meta(T(2), 'S1'));
    h.delivery.claimConflicts.add(entry.deliveryId);

    await h.receive.drainOnce();

    // The stale entry went terminal as rejected('other'); the sibling still claimed.
    expect(h.delivery.ackLog).toEqual([
      expect.objectContaining({ deliveryId: entry.deliveryId, disposition: 'rejected', reason: 'other' }),
      expect.objectContaining({ deliveryId: `d:${T(2)}:S1`, disposition: 'claimed' }),
    ]);
    expect(h.delivery.entries[0].status).toBe('rejected');
    expect(h.kv.map.get(CURSOR_KEY)).toEqual({ cursor: '2', syncEpoch: 'e1' });
    expect(h.attentions).toEqual([
      { transferId: 'tx-c', code: 'claim:conflict', detail: entry.deliveryId },
    ]);

    const second = await h.receive.drainOnce();
    expect(second).toEqual([]);
    expect(h.delivery.sinceLog[1]).toBe('2');
    expect(h.delivery.ackLog).toHaveLength(2);
    expect(h.attentions).toHaveLength(1);
  });

  it('a claimed ack is issued only after the view store succeeds: a view crash leaves the entry unacked (crash window)', async () => {
    const h = makeHarness();
    h.delivery.add(meta(T(1), 'S1'));
    h.delivery.add(meta(T(2), 'S1'));
    h.view.throwOn.add(`${T(2)}:S1`);

    const transfers = await h.receive.drainOnce();

    expect(transfers.map((t) => t.id)).toEqual([T(1)]);
    expect(h.delivery.claimed().map((a) => a.deliveryId)).toEqual([`d:${T(1)}:S1`]);
    expect(h.delivery.entries[1].status).toBe('unacked');
    for (const ack of h.delivery.claimed()) {
      const tokenId = ack.deliveryId.split(':')[1];
      expect(h.view.held.has(tokenId)).toBe(true);
    }
  });

  it('the ported #724 outcome: a claimed/acked token is never subsequently absent from the view, under coalesced drains and a crash', async () => {
    const h = makeHarness();
    h.delivery.add(meta(T(1), 'S1'));
    h.delivery.add(meta(T(2), 'S1'));
    h.view.throwOn.add(`${T(2)}:S1`);
    h.delivery.add(meta(T(3), 'S1'));

    const [first, coalesced] = await Promise.all([h.receive.drainOnce(), h.receive.drainOnce()]);
    expect(coalesced).toBe(first);
    h.view.throwOn.clear();
    await h.receive.drainOnce();

    expect(h.delivery.sinceLog).toHaveLength(2);
    expect(h.delivery.claimed().length).toBeGreaterThanOrEqual(3);
    for (const ack of h.delivery.claimed()) {
      const tokenId = ack.deliveryId.split(':')[1];
      expect(h.view.held.has(tokenId)).toBe(true);
    }
  });

  it('A→B→A: a re-acquired token at a NEW state is accepted and history gets a second RECEIVED leg', async () => {
    const h = makeHarness();
    h.delivery.add(meta(T(1), 'S1'));
    await h.receive.drainOnce();
    expect(h.view.held.get(T(1))).toBe('S1');

    h.delivery.add(meta(T(1), 'S3'));
    const second = await h.receive.drainOnce();

    expect(second).toHaveLength(1);
    expect(h.view.storeCalls).toHaveLength(2);
    expect(h.view.held.get(T(1))).toBe('S3');
    expect(h.events).toHaveLength(2);
    expect(h.historyLog.map((r) => r.dedupKey)).toEqual([
      receivedDedupKey(T(1), 'S1'),
      receivedDedupKey(T(1), 'S3'),
    ]);
  });

  it('single-flight: concurrent drainOnce calls coalesce onto the running drain promise; a later call starts a fresh drain', async () => {
    const h = makeHarness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.delivery.add(meta(T(1), 'S1'), { fetchGate: () => gate });

    const p1 = h.receive.drainOnce();
    const p2 = h.receive.drainOnce();
    expect(p2).toBe(p1);

    release();
    const transfers = await p1;
    expect(transfers).toHaveLength(1);
    expect(h.delivery.sinceLog).toHaveLength(1);

    await h.receive.drainOnce();
    expect(h.delivery.sinceLog).toHaveLength(2);
  });

  it('cursor+epoch persist as ONE record under the mailbox stream key', async () => {
    const h = makeHarness();
    h.delivery.add(meta(T(1), 'S1'));
    h.delivery.add(meta(T(2), 'S1'));

    await h.receive.drainOnce();

    expect(h.kv.sets.every((s) => s.key === CURSOR_KEY)).toBe(true);
    expect(h.kv.sets).toHaveLength(1);
    const record = h.kv.map.get(CURSOR_KEY) as StreamCursor;
    expect(record).toEqual({ cursor: '2', syncEpoch: 'e1' });
  });

  it('a stored cursor from a different syncEpoch is discarded and the drain re-lists from the start', async () => {
    const stale = makeHarness({ epoch: 'e1', kvSeed: { [CURSOR_KEY]: { cursor: '5', syncEpoch: 'e0' } } });
    stale.delivery.add(meta(T(1), 'S1'));
    await stale.receive.drainOnce();
    expect(stale.delivery.sinceLog).toEqual([undefined]);

    const fresh = makeHarness({ epoch: 'e1', kvSeed: { [CURSOR_KEY]: { cursor: '1', syncEpoch: 'e1' } } });
    fresh.delivery.add(meta(T(1), 'S1'));
    await fresh.receive.drainOnce();
    expect(fresh.delivery.sinceLog).toEqual(['1']);
    expect(fresh.view.storeCalls).toEqual([]);
  });

  it('§5.7 restore self-detection: a page-epoch mismatch voids the cursor record and re-lists from the start — a post-restore deposit with a LOWER seq than the stale cursor still arrives (missed-wake case: the session latch never moved)', async () => {
    // Latch AND record agree on e1 — the resume looks legitimate — but the
    // server restored to e2 and seqs restarted: the deposit sits at seq 1 < 5.
    const h = makeHarness({ epoch: 'e1', kvSeed: { [CURSOR_KEY]: { cursor: '5', syncEpoch: 'e1' } } });
    h.delivery.pageEpoch = 'e2';
    h.delivery.add(meta(T(1), 'S1', { amount: '700' }));

    const transfers = await h.receive.drainOnce();

    expect(h.delivery.sinceLog).toEqual(['5', undefined]); // resume, void, full re-list
    expect(transfers).toHaveLength(1);
    expect(transfers[0]!.id).toBe(T(1));
    expect(h.delivery.claimed().map((a) => a.deliveryId)).toEqual([`d:${T(1)}:S1`]);
    // The record is re-established under the PAGE epoch (the honest source).
    expect(h.kv.map.get(CURSOR_KEY)).toEqual({ cursor: '1', syncEpoch: 'e2' });
  });

  it('§5.7 restore self-detection with an EMPTY resumed listing: the voided record alone is durable progress (next drain starts from scratch)', async () => {
    const h = makeHarness({ epoch: 'e1', kvSeed: { [CURSOR_KEY]: { cursor: '5', syncEpoch: 'e1' } } });
    h.delivery.pageEpoch = 'e2';

    const transfers = await h.receive.drainOnce();

    expect(transfers).toEqual([]);
    expect(h.delivery.sinceLog).toEqual(['5', undefined]);
    expect(h.kv.map.get(CURSOR_KEY)).toBeUndefined(); // continuity voided, nothing re-written
  });

  it('receive() facade shape: drainOnce resolves with the IncomingTransfer[] it stored, enriched from the registry and the delivery envelope', async () => {
    const h = makeHarness();
    h.delivery.add(meta(T(1), 'S1', { amount: '2500' }), {
      senderPubkey: OTHER,
      senderNametag: 'bob',
      memo: 'thanks',
    });

    const transfers = await h.receive.drainOnce();

    expect(transfers).toHaveLength(1);
    const transfer = transfers[0];
    expect(transfer.id).toBe(T(1));
    expect(transfer.senderPubkey).toBe(OTHER);
    expect(transfer.senderNametag).toBe('bob');
    expect(transfer.memo).toBe('thanks');
    expect(transfer.receivedAt).toBe(1_700_000_000_000);
    expect(transfer.tokens).toEqual([
      expect.objectContaining({
        id: T(1),
        coinId: COIN,
        amount: '2500',
        symbol: 'SYMcc',
        name: 'coin-cc',
        decimals: 8,
        status: 'confirmed',
        lazy: true,
      }),
    ]);
    expect(h.historyLog[0]).toEqual(
      expect.objectContaining({ senderPubkey: OTHER, senderNametag: 'bob', memo: 'thanks' })
    );
  });

  it('a history hook failure never fails the money path: the token stays stored, acked claimed, and the event still emits', async () => {
    const h = makeHarness();
    h.historyFail = true;
    h.delivery.add(meta(T(1), 'S1'));

    const transfers = await h.receive.drainOnce();

    expect(transfers).toHaveLength(1);
    expect(h.view.held.get(T(1))).toBe('S1');
    expect(h.delivery.claimed()).toHaveLength(1);
    expect(h.events).toHaveLength(1);
    expect(h.historyLog).toEqual([]);
  });

  it('wake wiring: onWake triggers a debounce-free immediate drain', async () => {
    const h = makeHarness();
    h.delivery.add(meta(T(1), 'S1'));
    h.receive.start(2_000_000_000);

    h.delivery.fireWake();
    await vi.waitFor(() => {
      expect(h.delivery.sinceLog).toHaveLength(1);
    });
    expect(h.view.held.get(T(1))).toBe('S1');
    h.receive.stop();
  });

  it('the 30s poll backstop drains on the interval and stop() halts it', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.delivery.add(meta(T(1), 'S1'));
      h.receive.start();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.delivery.sinceLog).toHaveLength(1);
      expect(h.view.held.get(T(1))).toBe('S1');

      h.receive.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(h.delivery.sinceLog).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('payments-v2 Receive — the balance moves while the drain runs (#755)', () => {
  it('refreshes the inventory mirror DURING a multi-token drain, not only when it finishes', async () => {
    // The mirror is what assets()/tokens() render. Acks flush every 200 entries
    // and the facade refreshes once the drain returns, so a 54-token receive used
    // to stream transfer:incoming (toasts moved) while the balance sat still.
    const h = makeHarness({ advancePerEntryMs: REFRESH_INTERVAL_MS });
    for (let i = 1; i <= 5; i += 1) h.delivery.add(meta(T(i), 'S1'));

    const transfers = await h.receive.drainOnce();

    expect(transfers).toHaveLength(5);
    // Every refresh here happened inside drainOnce — the facade's own post-drain
    // refresh is a separate call it makes after this resolves.
    expect(h.refreshes.length).toBeGreaterThan(1);
    // The property that actually matters. A `claimed` ack is what puts a token in
    // SERVER inventory, and acks otherwise queue until ACK_BATCH_SIZE (200), so a
    // refresh fired before the flush would read an inventory with none of the
    // accepted tokens in it — progressive in form, frozen balance in fact.
    expect(h.refreshes[0]).toBeGreaterThan(0);
    // ...and each later refresh sees strictly more than the one before it.
    for (let i = 1; i < h.refreshes.length; i += 1) {
      expect(h.refreshes[i]).toBeGreaterThan(h.refreshes[i - 1]);
    }
  });

  it('a drain that finishes inside one interval refreshes nothing mid-flight', async () => {
    // A refresh is a server round trip, and an early flush costs a cursor write.
    // A fast drain is already covered by the facade's single post-drain refresh,
    // so it must keep the old behaviour exactly: batch at 200, refresh at the end.
    const h = makeHarness({ advancePerEntryMs: 0 });
    for (let i = 1; i <= 10; i += 1) h.delivery.add(meta(T(i), 'S1'));

    await h.receive.drainOnce();

    expect(h.refreshes).toEqual([]);
  });

  it('throttles a slow drain to one refresh per interval, not one per token', async () => {
    // 6 tokens arriving a third of an interval apart: 2 intervals, not 6 refreshes.
    const h = makeHarness({ advancePerEntryMs: Math.ceil(REFRESH_INTERVAL_MS / 3) });
    for (let i = 1; i <= 6; i += 1) h.delivery.add(meta(T(i), 'S1'));

    await h.receive.drainOnce();

    expect(h.refreshes.length).toBeGreaterThan(0);
    expect(h.refreshes.length).toBeLessThan(6);
  });

  it('never refreshes for a drain that stored nothing', async () => {
    // An empty poll every 30 s must not pull the inventory each time.
    const h = makeHarness({ advancePerEntryMs: REFRESH_INTERVAL_MS });

    await h.receive.drainOnce();

    expect(h.refreshes).toEqual([]);
  });

  it('a rejected entry alone does not trigger a refresh — nothing entered the balance', async () => {
    const h = makeHarness({ advancePerEntryMs: REFRESH_INTERVAL_MS });
    h.engine.badProof.add(`${T(1)}:S1`);
    h.delivery.add(meta(T(1), 'S1'));

    await h.receive.drainOnce();

    expect(h.refreshes).toEqual([]);
  });

  it('a rejection AFTER an accepted token does not buy itself a refresh', async () => {
    // stored.length > 0 stays true for the rest of the drain, so gating on the
    // running total would let every later rejection pay for a round trip.
    const h = makeHarness({ advancePerEntryMs: REFRESH_INTERVAL_MS });
    h.delivery.add(meta(T(1), 'S1'));
    h.engine.badProof.add(`${T(2)}:S1`);
    h.delivery.add(meta(T(2), 'S1'));
    h.engine.badProof.add(`${T(3)}:S1`);
    h.delivery.add(meta(T(3), 'S1'));

    await h.receive.drainOnce();

    expect(h.refreshes).toHaveLength(1); // the accepted one only
  });
});

describe('payments-v2 Receive — batched acks (#757)', () => {
  it('advances the cursor only to the last CONSECUTIVE settle, not the last one', async () => {
    // The cursor means "everything at or before this is done". Jumping it to the
    // furthest settled id would skip entry 3 permanently — it never re-lists.
    const h = makeHarness();
    h.delivery.enableBatch();
    for (let i = 1; i <= 5; i += 1) h.delivery.add(meta(T(i), 'S1'));
    h.delivery.unsettled.add(`d:${T(3)}:S1`);

    await h.receive.drainOnce();

    const cursor = h.kv.map.get(CURSOR_KEY) as StreamCursor | undefined;
    expect(cursor?.cursor).toBe('2');
  });

  it('re-lists exactly the unsettled entry on the next drain, and nothing already settled', async () => {
    const h = makeHarness();
    h.delivery.enableBatch();
    for (let i = 1; i <= 5; i += 1) h.delivery.add(meta(T(i), 'S1'));
    h.delivery.unsettled.add(`d:${T(3)}:S1`);
    await h.receive.drainOnce();

    h.delivery.unsettled.clear();
    h.delivery.batchCalls.length = 0;
    await h.receive.drainOnce();

    // Entries 4 and 5 settled in the first drain; only 3 may come back.
    const relisted = h.delivery.batchCalls.flat();
    expect(relisted).toEqual([`d:${T(3)}:S1`]);
  });

  it('rejects a conflicting entry mid-batch and still settles the rest', async () => {
    const h = makeHarness();
    h.delivery.enableBatch();
    for (let i = 1; i <= 5; i += 1) h.delivery.add(meta(T(i), 'S1'), { transferId: `tx-${String(i)}` });
    h.delivery.claimConflicts.add(`d:${T(3)}:S1`);

    await h.receive.drainOnce();

    // The stale one is rejected, terminally, rather than wedging the batch...
    expect(h.delivery.ackLog).toContainEqual(
      expect.objectContaining({ deliveryId: `d:${T(3)}:S1`, disposition: 'rejected', reason: 'other' })
    );
    // ...the other four are claimed...
    for (const i of [1, 2, 4, 5]) {
      expect(h.delivery.ackLog).toContainEqual(
        expect.objectContaining({ deliveryId: `d:${T(i)}:S1`, disposition: 'claimed' })
      );
    }
    // ...the cursor clears the whole run, since every entry settled...
    expect((h.kv.map.get(CURSOR_KEY) as StreamCursor | undefined)?.cursor).toBe('5');
    // ...and the conflict is surfaced, after the reject, with its transferId.
    expect(h.attentions).toContainEqual({
      transferId: 'tx-3',
      code: 'claim:conflict',
      detail: `d:${T(3)}:S1`,
    });
  });

  it('holds the cursor when the stale-reject itself fails', async () => {
    const h = makeHarness();
    h.delivery.enableBatch();
    for (let i = 1; i <= 3; i += 1) h.delivery.add(meta(T(i), 'S1'));
    h.delivery.claimConflicts.add(`d:${T(2)}:S1`);
    // The follow-up reject goes through ack(), which is failing.
    h.delivery.acksUntilFail = 0;

    await h.receive.drainOnce();

    // Entry 2 never settled, so the prefix stops at 1 and 2 re-lists.
    expect((h.kv.map.get(CURSOR_KEY) as StreamCursor | undefined)?.cursor).toBe('1');
  });

  it('stores every token before its claimed ack, batched as well (#724)', async () => {
    const h = makeHarness();
    h.delivery.enableBatch();
    for (let i = 1; i <= 4; i += 1) h.delivery.add(meta(T(i), 'S1'));

    await h.receive.drainOnce();

    const claimed = h.delivery.ackLog.filter((a) => a.disposition === 'claimed');
    expect(claimed).toHaveLength(4);
    // A claimed/acked token can never be absent from the view: all four stores
    // precede the batch that acks them.
    for (const a of claimed) expect(a.storesAtAck).toBe(4);
  });

  it('does NOT fall back per entry when the batch failure is retryable', async () => {
    // Falling back would turn one 429 into N of them — the swap-incident shape.
    const h = makeHarness();
    h.delivery.enableBatch();
    for (let i = 1; i <= 4; i += 1) h.delivery.add(meta(T(i), 'S1'));
    h.delivery.batchFailure = 'retryable';

    await h.receive.drainOnce();

    expect(h.delivery.batchCalls).toHaveLength(1);
    expect(h.delivery.ackLog).toEqual([]); // nothing acked one at a time
    expect(h.kv.map.get(CURSOR_KEY)).toBeUndefined(); // cursor holds
  });

  it('falls back to one-at-a-time when the batch fails for any other reason', async () => {
    const h = makeHarness();
    h.delivery.enableBatch();
    for (let i = 1; i <= 4; i += 1) h.delivery.add(meta(T(i), 'S1'));
    h.delivery.batchFailure = 'hard';

    await h.receive.drainOnce();

    // A broken batch endpoint must not strand the receive.
    expect(h.delivery.ackLog).toHaveLength(4);
    expect((h.kv.map.get(CURSOR_KEY) as StreamCursor | undefined)?.cursor).toBe('4');
  });

  it('settles one at a time when the port offers no batch at all', async () => {
    const h = makeHarness(); // ackBatch left undefined
    for (let i = 1; i <= 3; i += 1) h.delivery.add(meta(T(i), 'S1'));

    await h.receive.drainOnce();

    expect(h.delivery.batchCalls).toEqual([]);
    expect(h.delivery.ackLog).toHaveLength(3);
    expect((h.kv.map.get(CURSOR_KEY) as StreamCursor | undefined)?.cursor).toBe('3');
  });

  it('issues ONE batch for a run instead of one call per token', async () => {
    const h = makeHarness();
    h.delivery.enableBatch();
    for (let i = 1; i <= 12; i += 1) h.delivery.add(meta(T(i), 'S1'));

    await h.receive.drainOnce();

    // The whole point: 12 tokens, one settle round trip.
    expect(h.delivery.batchCalls).toHaveLength(1);
    expect(h.delivery.batchCalls[0]).toHaveLength(12);
  });
});
