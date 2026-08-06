// §5.8 Requests — the incoming mirror over the wallet-api ?since= stream and
// the #441 settling journal. FakeWalletApi is the test server, driven through
// a thin client-shaped adapter; scripted stub clients cover adversarial pages.

import { describe, expect, it, vi } from 'vitest';

import { SphereError, PartialSendConflictError } from '../../../core/errors';
import type { TransferResult } from '../../../types';
import type { SendRequest } from '../../../modules/payments-v2/api';
import { STORE_KEYS, type ScopedKV, type SettlingLink, type StreamCursor } from '../../../modules/payments-v2/stores';
import {
  Requests,
  type RequestsDeps,
  type RequestsPageWire,
  type RequestsWireClient,
  type RequestWire,
} from '../../../modules/payments-v2/requests/Requests';
import { FakeWalletApi, type FakeCaller } from './fakes/FakeWalletApi';
import { memoryKV, stubRequestMemoCodec, type MemoryKV } from './support';

const NET = 'testnet2';
const PAYER = `02${'aa'.repeat(32)}`;
const REQUESTER = `02${'bb'.repeat(32)}`;
const OTHER = `03${'cc'.repeat(32)}`;
const COIN = 'ff'.repeat(32);
const payerCaller: FakeCaller = { chainPubkey: PAYER, network: NET };
const requesterCaller: FakeCaller = { chainPubkey: REQUESTER, network: NET };

const SETTLING_KEY = STORE_KEYS.settlingLinks;
const CURSOR_KEY = STORE_KEYS.streamCursor('payment_requests');

const codec = stubRequestMemoCodec;

function clientOf(api: FakeWalletApi, caller: FakeCaller, log?: { since: (number | undefined)[] }): RequestsWireClient {
  return {
    createPaymentRequest: async (input) => (await api.createRequest(caller, input)) as unknown as RequestWire,
    listPaymentRequests: async (params) => {
      log?.since.push(params.since);
      return (await api.listRequests(caller, params)) as unknown as RequestsPageWire;
    },
    respondPaymentRequest: async (id, response) =>
      (await api.respondRequest(caller, id, response)) as unknown as RequestWire,
  };
}

function transferResult(id: string): TransferResult {
  return { id, status: 'completed', tokens: [], tokenTransfers: [] };
}

function possiblyCommitted(transferId: string): SphereError {
  const err = new SphereError('proof inconclusive', 'CERTIFICATION_UNCONFIRMED');
  err.transferId = transferId;
  return err;
}

interface Harness {
  api: FakeWalletApi;
  kv: MemoryKV;
  events: { event: string; payload: { id?: string; status?: string } }[];
  sendImpl: ReturnType<typeof vi.fn<(req: SendRequest) => Promise<TransferResult>>>;
  abortedIds: string[];
  probe: ReturnType<typeof vi.fn<() => Promise<string[]>>>;
  requests: Requests;
  onEmit?: (event: string, payload: unknown) => void;
}

function makeHarness(over: Partial<RequestsDeps> & { api?: FakeWalletApi; kv?: MemoryKV } = {}): Harness {
  const api = over.api ?? new FakeWalletApi();
  const kv = over.kv ?? memoryKV();
  const events: Harness['events'] = [];
  const sendImpl = vi.fn<(req: SendRequest) => Promise<TransferResult>>(async () => transferResult('tx-default'));
  const abortedIds: string[] = [];
  const probe = vi.fn<() => Promise<string[]>>(async () => abortedIds);
  const h: Partial<Harness> = { api, kv, events, sendImpl, abortedIds, probe };
  const requests = new Requests({
    client: clientOf(api, payerCaller),
    kv,
    ownPubkey: PAYER,
    send: (r) => sendImpl(r),
    resolvePubkey: async (idf) => (idf === '@req' ? REQUESTER : null),
    listAbortedTransferIds: probe,
    emit: (event, payload) => {
      h.onEmit?.(event, payload);
      events.push({ event, payload: payload as { id?: string; status?: string } });
    },
    memo: codec,
    ownNametag: () => 'payer',
    ...over,
  });
  h.requests = requests;
  return h as Harness;
}

async function seedRequest(api: FakeWalletApi, memo?: string, amount = '1000'): Promise<string> {
  const wire = await api.createRequest(requesterCaller, {
    toPubkey: PAYER,
    assets: [{ coinId: COIN, amount }],
    ...(memo !== undefined ? { memo: `x.${JSON.stringify({ memo, senderNametag: 'req' })}` } : {}),
  });
  return wire.id;
}

function settlingRecord(kv: MemoryKV): Record<string, SettlingLink> {
  return (kv.map.get(SETTLING_KEY) ?? {}) as Record<string, SettlingLink>;
}

function stubClient(pages: RequestsPageWire[]): RequestsWireClient & { responded: unknown[] } {
  const responded: unknown[] = [];
  return {
    responded,
    createPaymentRequest: async () => {
      throw new Error('unused');
    },
    listPaymentRequests: async () =>
      pages.shift() ?? { requests: [], more: false, cursor: 0, syncEpoch: 1 },
    respondPaymentRequest: async (id, response) => {
      responded.push({ id, response });
      return openWire('resp', 1, { status: 'paid' });
    },
  };
}

function openWire(id: string, seq: number, over: Partial<RequestWire> = {}): RequestWire {
  return {
    id,
    seq,
    fromPubkey: REQUESTER,
    toPubkey: PAYER,
    assets: [{ coinId: COIN, amount: '1000' }],
    status: 'open',
    transferId: null,
    createdAt: new Date(1767225600000 + seq * 1000).toISOString(),
    ...over,
  };
}

describe('payments-v2 Requests — stream + mirror', () => {
  it('drains incoming, surfaces fresh open requests with events and decrypted memo', async () => {
    const h = makeHarness();
    const id = await seedRequest(h.api, 'coffee');
    await h.requests.drainIncoming();

    const list = h.requests.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id,
      status: 'pending',
      amount: '1000',
      coinId: COIN,
      senderPubkey: REQUESTER,
      message: 'coffee',
      senderNametag: 'req',
    });
    expect(h.events).toEqual([expect.objectContaining({ event: 'payment_request:incoming' })]);

    // Re-drain: id-dedup, no re-notify.
    await h.requests.drainIncoming();
    expect(h.requests.list()).toHaveLength(1);
    expect(h.events).toHaveLength(1);
  });

  it('persists cursor+syncEpoch as ONE StreamCursor record and resumes the delta from it', async () => {
    const api = new FakeWalletApi();
    const log = { since: [] as (number | undefined)[] };
    const h = makeHarness({ api, client: clientOf(api, payerCaller, log) });
    await seedRequest(api);
    await h.requests.drainIncoming();

    const record = h.kv.map.get(CURSOR_KEY) as StreamCursor;
    expect(record).toEqual({ cursor: 1, syncEpoch: '1' });
    const cursorishKeys = [...h.kv.map.keys()].filter((k) => /cursor|epoch/i.test(k));
    expect(cursorishKeys).toEqual([CURSOR_KEY]);

    // Second drain (already hydrated): the delta pull resumes from the persisted seq.
    log.since.length = 0;
    const id2 = await seedRequest(api);
    await h.requests.drainIncoming();
    expect(log.since).toEqual([1]);
    expect(h.requests.list().map((r) => r.id)).toContain(id2);
  });

  it('upsert-by-id restamps: a status change re-surfaces at higher seq and advances the mirror entry', async () => {
    const h = makeHarness();
    const id = await seedRequest(h.api);
    await h.requests.drainIncoming();
    expect(h.requests.list()[0]!.status).toBe('pending');

    // Another session of THIS wallet pays it server-side (seq re-stamped).
    await h.api.respondRequest(payerCaller, id, { action: 'paid', transferId: 'tx-other-session' });
    await h.requests.drainIncoming();

    const list = h.requests.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBe('paid');
    expect(h.events).toContainEqual({ event: 'payment_request:updated', payload: { id, status: 'paid' } });
  });

  it('terminal statuses never downgrade on re-surface', async () => {
    const wire = openWire('req-t', 1);
    const client = stubClient([
      { requests: [wire], more: false, cursor: 1, syncEpoch: 1 },
      { requests: [wire], more: false, cursor: 1, syncEpoch: 1 },
      // Adversarial replay: same id re-surfaces 'open' at a HIGHER seq.
      { requests: [{ ...wire, seq: 9 }], more: false, cursor: 9, syncEpoch: 1 },
      { requests: [], more: false, cursor: 9, syncEpoch: 1 },
    ]);
    const h = makeHarness({ client });
    await h.requests.drainIncoming();
    await h.requests.pay('req-t');
    expect(h.requests.list()[0]!.status).toBe('paid');

    await h.requests.drainIncoming();
    expect(h.requests.list()[0]!.status).toBe('paid');
    const demotions = h.events.filter(
      (e) => e.event === 'payment_request:updated' && e.payload.status === 'pending'
    );
    expect(demotions).toHaveLength(0);
  });

  it('owner guard: a wire not addressed to this wallet is dropped', async () => {
    const foreign = openWire('req-f', 1, { toPubkey: OTHER });
    const client = stubClient([
      { requests: [foreign], more: false, cursor: 1, syncEpoch: 1 },
      { requests: [foreign], more: false, cursor: 1, syncEpoch: 1 },
    ]);
    const h = makeHarness({ client });
    await h.requests.drainIncoming();
    expect(h.requests.list()).toEqual([]);
    expect(h.events).toEqual([]);
  });
});

describe('payments-v2 Requests — pay() and the #441 settling journal', () => {
  it('#441 ordering: the settling link is durable BEFORE the in-memory flip and before the throw surfaces', async () => {
    const h = makeHarness();
    const id = await seedRequest(h.api);
    await h.requests.drainIncoming();
    h.sendImpl.mockRejectedValueOnce(possiblyCommitted('tx-441'));

    // At the instant the 'settling' flip is observable, the journal MUST
    // already hold the link (crash between = reload still shows settling).
    let journalAtFlip: Record<string, SettlingLink> | null = null;
    h.onEmit = (event, payload) => {
      if (event === 'payment_request:updated' && (payload as { status: string }).status === 'settling') {
        journalAtFlip = settlingRecord(h.kv);
      }
    };

    await expect(h.requests.pay(id)).rejects.toMatchObject({ code: 'CERTIFICATION_UNCONFIRMED' });
    expect(journalAtFlip).not.toBeNull();
    expect(journalAtFlip![id]).toMatchObject({ requestId: id, transferId: 'tx-441', committed: false });
    expect(h.requests.list()[0]!.status).toBe('settling');
  });

  it('a reloaded settling request is never payable', async () => {
    const kv = memoryKV();
    const api = new FakeWalletApi();
    const h1 = makeHarness({ api, kv });
    const id = await seedRequest(api);
    await h1.requests.drainIncoming();
    h1.sendImpl.mockRejectedValueOnce(possiblyCommitted('tx-reload'));
    await expect(h1.requests.pay(id)).rejects.toThrow();

    // "Crash" — fresh instance over the same durable stores.
    const h2 = makeHarness({ api, kv });
    await h2.requests.drainIncoming();
    expect(h2.requests.list()[0]!.status).toBe('settling');
    await expect(h2.requests.pay(id)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(h2.sendImpl).not.toHaveBeenCalled();
  });

  it('double-tap pay() coalesces onto ONE send', async () => {
    const h = makeHarness();
    const id = await seedRequest(h.api);
    await h.requests.drainIncoming();

    let release!: (r: TransferResult) => void;
    h.sendImpl.mockImplementationOnce(() => new Promise<TransferResult>((res) => (release = res)));
    const p1 = h.requests.pay(id);
    const p2 = h.requests.pay(id);
    for (let i = 0; i < 25 && h.sendImpl.mock.calls.length === 0; i++) await Promise.resolve();
    release(transferResult('tx-once'));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.id).toBe('tx-once');
    expect(r2).toBe(r1);
    expect(h.sendImpl).toHaveBeenCalledTimes(1);

    const wire = (await h.api.listRequests(payerCaller, { role: 'incoming', since: 0 })).requests[0]!;
    expect(wire.status).toBe('paid');
    expect(wire.transferId).toBe('tx-once');
  });

  it('paid-respond 409 swallows-and-clears (success leg and deferred reconcile leg)', async () => {
    const h = makeHarness();
    const id = await seedRequest(h.api);
    await h.requests.drainIncoming();
    // Another session resolves it server-side first → our respond hits 409.
    await h.api.respondRequest(payerCaller, id, { action: 'declined' });
    h.sendImpl.mockResolvedValueOnce(transferResult('tx-409'));
    await expect(h.requests.pay(id)).resolves.toMatchObject({ id: 'tx-409' });
    expect(h.requests.list()[0]!.status).toBe('paid');

    // Deferred leg: a settling link whose request is already resolved server-side.
    const id2 = await seedRequest(h.api);
    await h.requests.drainIncoming();
    h.sendImpl.mockRejectedValueOnce(possiblyCommitted('tx-d'));
    await expect(h.requests.pay(id2)).rejects.toThrow();
    await h.api.respondRequest(payerCaller, id2, { action: 'declined' });
    await h.requests.reconcile({ resumed: ['tx-d'], conflicted: [], open: [] });
    expect(settlingRecord(h.kv)[id2]).toBeUndefined();
    expect(h.requests.list().find((r) => r.id === id2)!.status).toBe('paid');
  });

  it('send-succeeds-respond-5xx: the link survives committed, settling everywhere (incl. reload), and the next reconcile responds and clears', async () => {
    const kv = memoryKV();
    const api = new FakeWalletApi();
    let failResponds = 1;
    const failingClient: RequestsWireClient = {
      ...clientOf(api, payerCaller),
      respondPaymentRequest: async (id, response) => {
        if (failResponds > 0) {
          failResponds -= 1;
          throw Object.assign(new Error('bad gateway'), { statusCode: 502 });
        }
        return (await api.respondRequest(payerCaller, id, response)) as unknown as RequestWire;
      },
    };
    const h1 = makeHarness({ api, kv, client: failingClient });
    const id = await seedRequest(api);
    await h1.requests.drainIncoming();
    h1.sendImpl.mockResolvedValueOnce(transferResult('tx-5xx'));

    // The SEND succeeded — pay() resolves — but the paid respond hit a 5xx.
    await expect(h1.requests.pay(id)).resolves.toMatchObject({ id: 'tx-5xx' });
    expect(settlingRecord(kv)[id]).toMatchObject({ transferId: 'tx-5xx', committed: true });
    expect(h1.requests.list()[0]!.status).toBe('settling');

    // Reload: the wire still says 'open', the surviving link holds it settling — never payable.
    const h2 = makeHarness({ api, kv, client: failingClient });
    await h2.requests.drainIncoming();
    expect(h2.requests.list()[0]!.status).toBe('settling');
    await expect(h2.requests.pay(id)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(h2.sendImpl).not.toHaveBeenCalled();

    // Next reconcile: the committed-link override retries the respond and clears.
    await h2.requests.reconcile({ resumed: [], conflicted: [], open: [] });
    expect(settlingRecord(kv)[id]).toBeUndefined();
    expect(h2.requests.list()[0]!.status).toBe('paid');
    const wire = (await api.listRequests(payerCaller, { role: 'incoming', since: 0 })).requests[0]!;
    expect(wire).toMatchObject({ status: 'paid', transferId: 'tx-5xx' });
    expect(h2.probe).not.toHaveBeenCalled(); // committed override — no aborted-authority probe
  });

  it('clean pre-commit failure leaves the request payable with NO link', async () => {
    const h = makeHarness();
    const id = await seedRequest(h.api);
    await h.requests.drainIncoming();
    h.sendImpl.mockRejectedValueOnce(new SphereError('no funds', 'SEND_INSUFFICIENT_BALANCE'));
    await expect(h.requests.pay(id)).rejects.toThrow('no funds');
    expect(settlingRecord(h.kv)[id]).toBeUndefined();
    expect(h.requests.list()[0]!.status).toBe('pending');

    h.sendImpl.mockResolvedValueOnce(transferResult('tx-retry'));
    await expect(h.requests.pay(id)).resolves.toMatchObject({ id: 'tx-retry' });
  });

  it('a possibly-committed outcome with no transferId fails closed to paid', async () => {
    const h = makeHarness();
    const id = await seedRequest(h.api);
    await h.requests.drainIncoming();
    h.sendImpl.mockRejectedValueOnce(new SphereError('inconclusive', 'CERTIFICATION_UNCONFIRMED'));
    await expect(h.requests.pay(id)).rejects.toThrow();
    expect(h.requests.list()[0]!.status).toBe('paid');
    await expect(h.requests.pay(id)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('a corrupt settling journal fails open to empty (never wedges)', async () => {
    const kv = memoryKV();
    const brokenKv: ScopedKV = {
      get: async <T,>(key: string): Promise<T | null> => {
        if (key === SETTLING_KEY) throw new SyntaxError('Unexpected token in JSON');
        return kv.get<T>(key);
      },
      set: (k, v) => kv.set(k, v),
      remove: (k) => kv.remove(k),
    };
    const api = new FakeWalletApi();
    const h = makeHarness({ api, kv: Object.assign(brokenKv, { map: kv.map }) as unknown as MemoryKV });
    const id = await seedRequest(api);
    await h.requests.drainIncoming();
    expect(h.requests.list()[0]!.status).toBe('pending');
    h.sendImpl.mockResolvedValueOnce(transferResult('tx-ok'));
    await expect(h.requests.pay(id)).resolves.toMatchObject({ id: 'tx-ok' });
  });
});

describe('payments-v2 Requests — decline / create / dismiss', () => {
  it('decline responds declined server-side, then flips locally', async () => {
    const h = makeHarness();
    const id = await seedRequest(h.api);
    await h.requests.drainIncoming();
    await h.requests.decline(id);
    expect(h.requests.list()[0]!.status).toBe('rejected');
    const wire = (await h.api.listRequests(payerCaller, { role: 'incoming', since: 0 })).requests[0]!;
    expect(wire.status).toBe('declined');
  });

  it('decline 409 PROPAGATES and does not clear local state', async () => {
    const h = makeHarness();
    const id = await seedRequest(h.api);
    await h.requests.drainIncoming();
    // Already resolved server-side → respond is a 409 CONFLICT.
    await h.api.respondRequest(payerCaller, id, { action: 'declined' });
    await expect(h.requests.decline(id)).rejects.toMatchObject({ statusCode: 409 });
    const entry = h.requests.list()[0]!;
    expect(entry.id).toBe(id);
    expect(entry.status).toBe('pending'); // NOT flipped, NOT evicted
  });

  it('create resolves @nametag via the injected resolver and sends the encrypted bundle', async () => {
    const h = makeHarness();
    const created = await h.requests.create('@req', { coinId: COIN, amount: '2500', memo: 'rent' });
    expect(created.success).toBe(true);
    const incoming = await h.api.listRequests({ chainPubkey: REQUESTER, network: NET }, { role: 'incoming', since: 0 });
    expect(incoming.requests[0]).toMatchObject({
      id: created.requestId,
      fromPubkey: PAYER,
      assets: [{ coinId: COIN, amount: '2500' }],
      memo: `x.${JSON.stringify({ memo: 'rent', senderNametag: 'payer' })}`,
    });

    await expect(h.requests.create('@nobody', { coinId: COIN, amount: '1' })).resolves.toMatchObject({
      success: false,
    });
    await expect(h.requests.create('@req', { coinId: COIN, amount: 'abc' })).resolves.toMatchObject({
      success: false,
    });
  });

  it('dismissProcessed evicts paid/rejected/expired but never settling or pending', async () => {
    const h = makeHarness();
    const paidId = await seedRequest(h.api);
    const rejectedId = await seedRequest(h.api);
    const settlingId = await seedRequest(h.api);
    const pendingId = await seedRequest(h.api);
    await h.requests.drainIncoming();

    h.sendImpl.mockResolvedValueOnce(transferResult('tx-p'));
    await h.requests.pay(paidId);
    await h.requests.decline(rejectedId);
    h.sendImpl.mockRejectedValueOnce(possiblyCommitted('tx-s'));
    await expect(h.requests.pay(settlingId)).rejects.toThrow();

    h.requests.dismissProcessed();
    const ids = h.requests.list().map((r) => r.id);
    expect(ids).toContain(settlingId);
    expect(ids).toContain(pendingId);
    expect(ids).not.toContain(paidId);
    expect(ids).not.toContain(rejectedId);
    expect(h.requests.list().find((r) => r.id === settlingId)!.status).toBe('settling');
  });
});

describe('payments-v2 Requests — reconcile (all five arms)', () => {
  async function settleFive(h: Harness): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await seedRequest(h.api));
    await h.requests.drainIncoming();
    for (let i = 0; i < 5; i++) {
      h.sendImpl.mockRejectedValueOnce(possiblyCommitted(`tx-${i}`));
      await expect(h.requests.pay(ids[i]!)).rejects.toThrow();
    }
    return ids;
  }

  it('resumed → deferred paid; conflicted → payable; open → settling; unaccounted → probe / paid-never-re-payable', async () => {
    const h = makeHarness();
    const [a, b, c, d, e] = await settleFive(h);
    h.abortedIds.push('tx-3'); // D: server aborted-authority hit

    await h.requests.reconcile({ resumed: ['tx-0'], conflicted: ['tx-1'], open: ['tx-2'] });

    const status = (id: string) => h.requests.list().find((r) => r.id === id)!.status;
    expect(status(a!)).toBe('paid'); // resumed → deferred paid respond + clear
    expect(status(b!)).toBe('pending'); // conflicted → payable again
    expect(status(c!)).toBe('settling'); // still open → keep the link
    expect(status(d!)).toBe('pending'); // unaccounted, server says aborted → payable
    expect(status(e!)).toBe('paid'); // unaccounted, not aborted → PAID-NEVER-RE-PAYABLE

    const journal = settlingRecord(h.kv);
    expect(Object.keys(journal)).toEqual([c]);
    expect(h.probe).toHaveBeenCalledTimes(1); // lazy, memoized authority

    // The deferred paid respond actually landed server-side, with the transferId.
    const wires = (await h.api.listRequests(payerCaller, { role: 'incoming', since: 0 })).requests;
    expect(wires.find((w) => w.id === a)).toMatchObject({ status: 'paid', transferId: 'tx-0' });
    expect(wires.find((w) => w.id === e)).toMatchObject({ status: 'paid', transferId: 'tx-4' });
    expect(wires.find((w) => w.id === b)).toMatchObject({ status: 'open' });
  });

  it('a committed link (partial conflict) resolves paid even when the resume reports it aborted', async () => {
    const h = makeHarness();
    const id = await seedRequest(h.api);
    await h.requests.drainIncoming();
    h.sendImpl.mockRejectedValueOnce(
      new PartialSendConflictError('partial', 'tx-part', ['t1'], '400')
    );
    await expect(h.requests.pay(id)).rejects.toThrow();
    expect(settlingRecord(h.kv)[id]).toMatchObject({ committed: true });

    await h.requests.reconcile({ resumed: [], conflicted: ['tx-part'], open: [] });
    expect(h.requests.list()[0]!.status).toBe('paid'); // never re-payable — value left the wallet
    expect(settlingRecord(h.kv)[id]).toBeUndefined();
  });

  it('a probe failure defers the unaccounted link to the next session (still settling)', async () => {
    const h = makeHarness();
    const id = await seedRequest(h.api);
    await h.requests.drainIncoming();
    h.sendImpl.mockRejectedValueOnce(possiblyCommitted('tx-x'));
    await expect(h.requests.pay(id)).rejects.toThrow();
    h.probe.mockRejectedValueOnce(new Error('network down'));

    await h.requests.reconcile({ resumed: [], conflicted: [], open: [] });
    expect(h.requests.list()[0]!.status).toBe('settling');
    expect(settlingRecord(h.kv)[id]).toMatchObject({ transferId: 'tx-x' });
  });
});
