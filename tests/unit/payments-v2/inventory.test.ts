import { describe, it, expect, vi } from 'vitest';

import {
  InventoryView,
  type RegistryReader,
  type ReAddResult,
} from '../../../modules/payments-v2/inventory/InventoryView';
import type { InventoryItem, InventoryPage, StoragePort } from '../../../modules/payments-v2/ports';
import type { ScopedKV } from '../../../modules/payments-v2/stores';

const COIN = 'aa'.repeat(32);

type PageSource = InventoryPage | (() => Promise<InventoryPage>);

interface ItemOpts {
  seq: number;
  state?: string;
  status?: 'active' | 'removed';
  amount?: string;
  noAssets?: boolean;
}

function item(tokenId: string, opts: ItemOpts): InventoryItem {
  return {
    tokenId,
    seq: opts.seq,
    stateHash: opts.state ?? 'S1',
    status: opts.status ?? 'active',
    ...(opts.noAssets ? {} : { assets: [{ coinId: COIN, amount: opts.amount ?? '100' }] }),
  };
}

function page(items: InventoryItem[], cursor: number, more = false): InventoryPage {
  return { cursor, syncEpoch: 'e1', more, items };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeKV(seed?: Record<string, unknown>): ScopedKV & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>(Object.entries(seed ?? {}));
  return {
    data,
    async get<T>(key: string): Promise<T | null> {
      return data.has(key) ? (data.get(key) as T) : null;
    },
    async set<T>(key: string, value: T): Promise<void> {
      data.set(key, JSON.parse(JSON.stringify(value)));
    },
    async remove(key: string): Promise<void> {
      data.delete(key);
    },
  };
}

function makePort(script: PageSource[]): {
  port: StoragePort;
  calls: (number | undefined)[];
  queue: PageSource[];
} {
  const calls: (number | undefined)[] = [];
  const queue = [...script];
  const reject = async (): Promise<never> => {
    throw new Error('not part of this lane');
  };
  const port: StoragePort = {
    listInventory: async (since?: number) => {
      calls.push(since);
      const next = queue.shift();
      if (!next) throw new Error(`unscripted listInventory(since=${String(since)})`);
      return typeof next === 'function' ? next() : next;
    },
    getBlobs: reject,
    uploadBlobs: reject,
    applyDelta: reject,
  };
  return { port, calls, queue };
}

const registry: RegistryReader = {
  getSymbol: (coinId) => (coinId === COIN ? 'UCT' : '???'),
  getName: (coinId) => (coinId === COIN ? 'unicity' : 'unknown'),
  getDecimals: () => 6,
  getIconUrl: (coinId) => (coinId === COIN ? 'https://icons/uct.png' : null),
};

function makeView(
  script: PageSource[],
  kvSeed?: Record<string, unknown>
): {
  view: InventoryView;
  kv: ScopedKV & { data: Map<string, unknown> };
  calls: (number | undefined)[];
  queue: PageSource[];
  events: string[];
} {
  const kv = makeKV(kvSeed);
  const { port, calls, queue } = makePort(script);
  const events: string[] = [];
  const view = new InventoryView({ port, kv, emit: (e) => events.push(e) });
  return { view, kv, calls, queue, events };
}

const noRecoverCalls = {
  getBlobs: vi.fn(async () => new Map<string, Uint8Array>()),
  isSpent: vi.fn(async () => false),
  reAdd: vi.fn(async (): Promise<ReAddResult> => 'added'),
};

const blob = (n: number): Uint8Array => new Uint8Array([n]);

describe('InventoryView pull protocol', () => {
  it('paginated pull + closing delta: a token flipping between pages ends removed — the since-delta tombstone wins', async () => {
    const { view, calls } = makeView([
      page([item('A', { seq: 1 })], 10, true),
      page([item('B', { seq: 2, amount: '50' })], 20, false),
      page([item('A', { seq: 25, status: 'removed' })], 30, false),
    ]);
    await view.fullPull();
    expect(calls).toEqual([undefined, 10, 10]);
    expect(view.pool(COIN).map((p) => p.tokenId)).toEqual(['B']);
    expect(view.tokens(registry).map((t) => t.id)).toEqual(['B']);
  });

  it('delta() drops a spent token per-key via its tombstone and emits inventory:updated', async () => {
    const { view, queue, events } = makeView([
      page([item('A', { seq: 1 }), item('B', { seq: 2, amount: '50' })], 5),
      page([], 5),
    ]);
    await view.fullPull();
    const before = events.length;
    queue.push(page([item('A', { seq: 9, status: 'removed' })], 9));
    await view.delta();
    expect(view.pool(COIN).map((p) => p.tokenId)).toEqual(['B']);
    const assets = await view.assets(registry);
    expect(assets[0].totalAmount).toBe('50');
    expect(assets[0].tokenCount).toBe(1);
    expect(events.length).toBe(before + 1);
  });

  it('single-flight: concurrent fullPull calls coalesce into one pull pass', async () => {
    const gate = deferred<InventoryPage>();
    const { view, calls } = makeView([() => gate.promise, page([], 5)]);
    const p1 = view.fullPull();
    const p2 = view.fullPull();
    expect(p2).toBe(p1);
    gate.resolve(page([item('A', { seq: 1 })], 5));
    await Promise.all([p1, p2]);
    expect(calls.filter((c) => c === undefined)).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(view.pool(COIN).map((p) => p.tokenId)).toEqual(['A']);
  });

  it('delta() resumes from the persisted §6 cursor record: since=<prior cursor>, then the ADVANCED cursor', async () => {
    const { view, kv, queue, calls } = makeView([page([item('A', { seq: 1 })], 5), page([], 5)]);
    await view.fullPull();
    expect(kv.data.get('cursor:inventory')).toEqual({ cursor: 5, syncEpoch: 'e1' });

    queue.push(page([item('A', { seq: 8, state: 'S2' })], 8));
    await view.delta();
    expect(calls).toEqual([undefined, 5, 5]);
    expect(kv.data.get('cursor:inventory')).toEqual({ cursor: 8, syncEpoch: 'e1' });

    queue.push(page([], 8));
    await view.delta();
    expect(calls).toEqual([undefined, 5, 5, 8]);
  });

  it('a stale-epoch cursor record voids continuity: delta() falls back to a full re-pull that reconciles absent rows', async () => {
    const { view, kv, queue, calls } = makeView([page([item('A', { seq: 1 })], 5), page([], 5)]);
    await view.fullPull();

    const e2 = (items: InventoryItem[], cursor: number): InventoryPage => ({
      cursor,
      syncEpoch: 'e2',
      more: false,
      items,
    });
    queue.push(e2([], 5)); // the since=<cursor> probe reveals the epoch bump
    queue.push(e2([item('B', { seq: 1, amount: '70' })], 9));
    queue.push(e2([], 9));
    await view.delta();

    expect(calls).toEqual([undefined, 5, 5, undefined, 9]);
    expect(view.tokens(registry).map((t) => t.id)).toEqual(['B']);
    expect(kv.data.get('cursor:inventory')).toEqual({ cursor: 9, syncEpoch: 'e2' });
  });

  it('emits inventory:updated only on net change — an identical re-delivered delta stays silent', async () => {
    const { view, queue, events } = makeView([page([item('A', { seq: 1 })], 5), page([], 5)]);
    await view.fullPull();
    expect(events).toEqual(['inventory:updated']);
    queue.push(page([item('A', { seq: 1 })], 5));
    await view.delta();
    expect(events).toHaveLength(1);
    queue.push(page([item('A', { seq: 4, state: 'S2' })], 6));
    await view.delta();
    expect(events).toHaveLength(2);
  });
});

describe('InventoryView suspectedSpent overlay (F7)', () => {
  it('F7: a demote landing mid-fullPull survives the pull overlay prune — durably and in the pool', async () => {
    const { view, kv, queue } = makeView([
      page([item('T', { seq: 1 }), item('U', { seq: 2, amount: '50' })], 5),
      page([], 5),
    ]);
    await view.fullPull();
    const gate = deferred<InventoryPage>();
    queue.push(() => gate.promise, page([], 6));
    const pull = view.fullPull();
    await view.demote('T', 'S1');
    expect(kv.data.get('suspected-spent')).toEqual(['T:S1']);
    gate.resolve(page([item('T', { seq: 1 }), item('U', { seq: 2, amount: '50' })], 6));
    await pull;
    expect(view.pool(COIN).map((p) => p.tokenId)).toEqual(['U']);
    expect(kv.data.get('suspected-spent')).toEqual(['T:S1']);
    const tokens = view.tokens(registry);
    expect(tokens.find((t) => t.id === 'T')?.suspectedSpent).toBe(true);
    expect(tokens.find((t) => t.id === 'U')?.suspectedSpent).toBeUndefined();
  });

  it('a reload-persisted demotion survives a paginated pull whose token arrives on a later page', async () => {
    const { view, kv } = makeView(
      [
        page([item('U', { seq: 1, amount: '50' })], 10, true),
        page([item('T', { seq: 2 })], 20, false),
        page([], 20),
      ],
      { 'suspected-spent': ['T:S1'] }
    );
    await view.fullPull();
    expect(view.pool(COIN).map((p) => p.tokenId)).toEqual(['U']);
    expect(kv.data.get('suspected-spent')).toEqual(['T:S1']);
  });

  it('a state advance is positive evidence: the stale demotion prunes and the token returns to the pool', async () => {
    const { view, kv, queue } = makeView([page([item('T', { seq: 1 })], 5), page([], 5)]);
    await view.fullPull();
    await view.demote('T', 'S1');
    expect(view.pool(COIN)).toEqual([]);
    queue.push(page([item('T', { seq: 7, state: 'S2' })], 7));
    await view.delta();
    expect(view.pool(COIN)).toEqual([{ tokenId: 'T', amount: 100n }]);
    await vi.waitFor(() => {
      expect(kv.data.get('suspected-spent')).toEqual([]);
    });
  });

  it('demote refuses a bare-token demotion — stateHash is required', async () => {
    const { view } = makeView([]);
    await expect(view.demote('T', '')).rejects.toThrow('stateHash');
    await expect(view.demote('', 'S1')).rejects.toThrow('tokenId');
  });
});

describe('InventoryView recoverRemoved (F6)', () => {
  it('F6: a 409 knownSpend at an OLD state never blocks recovery of the token re-acquired at a NEW state', async () => {
    const { view, kv, queue } = makeView([
      page([item('T', { seq: 5, status: 'removed' })], 5),
      page([], 5),
    ]);
    await view.fullPull();

    const getBlobs1 = vi.fn(async () => new Map([['T', blob(1)]]));
    const r1 = await view.recoverRemoved(
      getBlobs1,
      async () => false,
      async (): Promise<ReAddResult> => 'evidenced-tombstone'
    );
    expect(r1.confirmedSpent).toEqual([{ tokenId: 'T', stateHash: 'S1' }]);
    expect(r1.recovered).toEqual([]);
    expect(kv.data.get('known-spends')).toEqual(['T:S1']);
    expect(view.pool(COIN)).toEqual([]);

    const r1b = await view.recoverRemoved(noRecoverCalls.getBlobs, noRecoverCalls.isSpent, noRecoverCalls.reAdd);
    expect(r1b).toEqual({ recovered: [], confirmedSpent: [] });
    expect(noRecoverCalls.getBlobs).not.toHaveBeenCalled();

    queue.push(page([item('T', { seq: 9, state: 'S2', status: 'removed', noAssets: true })], 9));
    await view.delta();
    const reAdd2 = vi.fn(async (): Promise<ReAddResult> => 'added');
    const r2 = await view.recoverRemoved(async () => new Map([['T', blob(2)]]), async () => false, reAdd2);
    expect(r2.recovered).toEqual(['T']);
    expect(reAdd2).toHaveBeenCalledWith('T', blob(2));
    expect(view.pool(COIN)).toEqual([{ tokenId: 'T', amount: 100n }]);
  });

  it('an on-chain-spent tombstone records a state-scoped knownSpend, is never re-added, and never re-probed', async () => {
    const { view, kv } = makeView([page([item('T', { seq: 5, status: 'removed' })], 5), page([], 5)]);
    await view.fullPull();
    const reAdd = vi.fn(async (): Promise<ReAddResult> => 'added');
    const getBlobs = vi.fn(async () => new Map([['T', blob(1)]]));
    const r = await view.recoverRemoved(getBlobs, async () => true, reAdd);
    expect(r.confirmedSpent).toEqual([{ tokenId: 'T', stateHash: 'S1' }]);
    expect(reAdd).not.toHaveBeenCalled();
    expect(kv.data.get('known-spends')).toEqual(['T:S1']);
    expect(view.tokens(registry)).toEqual([]);
    await view.recoverRemoved(getBlobs, async () => true, reAdd);
    expect(getBlobs).toHaveBeenCalledTimes(1);
  });

  it('empty-import protection: a tombstone applied by a FAILED pull is untouchable until a pull succeeds', async () => {
    const { view, kv, queue } = makeView([
      page([item('T', { seq: 5, status: 'removed' })], 10, true),
      () => Promise.reject(new Error('server down')),
      page([item('T', { seq: 5, status: 'removed' })], 5),
      page([], 5),
    ]);
    const getBlobs = vi.fn(async () => new Map([['T', blob(1)]]));
    const isSpent = vi.fn(async () => true);
    const reAdd = vi.fn(async (): Promise<ReAddResult> => 'added');

    expect(await view.recoverRemoved(getBlobs, isSpent, reAdd)).toEqual({
      recovered: [],
      confirmedSpent: [],
    });
    await expect(view.fullPull()).rejects.toThrow('server down');
    expect(await view.recoverRemoved(getBlobs, isSpent, reAdd)).toEqual({
      recovered: [],
      confirmedSpent: [],
    });
    expect(getBlobs).not.toHaveBeenCalled();
    expect(kv.data.has('known-spends')).toBe(false);

    await view.fullPull();
    await view.recoverRemoved(getBlobs, isSpent, reAdd);
    expect(getBlobs).toHaveBeenCalledTimes(1);
    expect(kv.data.get('known-spends')).toEqual(['T:S1']);
    expect(queue).toHaveLength(0);
  });

  it('a recorded knownSpend survives a reload: a fresh view over the same KV never re-probes that state', async () => {
    const kv = makeKV();
    const script = (): PageSource[] => [page([item('T', { seq: 5, status: 'removed' })], 5), page([], 5)];
    const first = makePort(script());
    const view1 = new InventoryView({ port: first.port, kv, emit: () => undefined });
    await view1.fullPull();
    await view1.recoverRemoved(
      async () => new Map([['T', blob(1)]]),
      async () => true,
      async (): Promise<ReAddResult> => 'added'
    );
    expect(kv.data.get('known-spends')).toEqual(['T:S1']);

    const second = makePort(script());
    const view2 = new InventoryView({ port: second.port, kv, emit: () => undefined });
    await view2.fullPull();
    const getBlobs = vi.fn(async () => new Map([['T', blob(1)]]));
    const r = await view2.recoverRemoved(getBlobs, async () => true, async (): Promise<ReAddResult> => 'added');
    expect(r).toEqual({ recovered: [], confirmedSpent: [] });
    expect(getBlobs).not.toHaveBeenCalled();
  });
});

describe('InventoryView in-flight registry', () => {
  const BIG = '123456789012345678901234567890';

  it('markInFlight excludes a token from pool() and reports it under transferring totals, never totalAmount', async () => {
    const { view, events } = makeView([
      page([item('A', { seq: 1, amount: BIG }), item('B', { seq: 2, amount: '50' })], 5),
      page([], 5),
    ]);
    await view.fullPull();
    view.markInFlight('A');
    expect(view.pool(COIN)).toEqual([{ tokenId: 'B', amount: 50n }]);
    let [asset] = await view.assets(registry);
    expect(asset.totalAmount).toBe('50');
    expect(asset.tokenCount).toBe(1);
    expect(asset.transferringAmount).toBe(BIG);
    expect(asset.transferringTokenCount).toBe(1);
    const byId = new Map(view.tokens(registry).map((t) => [t.id, t.status]));
    expect(byId.get('A')).toBe('transferring');
    expect(byId.get('B')).toBe('confirmed');

    const emitted = events.length;
    view.markInFlight('A');
    expect(events).toHaveLength(emitted);
    view.release('A');
    expect(events).toHaveLength(emitted + 1);
    [asset] = await view.assets(registry);
    expect(asset.totalAmount).toBe('123456789012345678901234567940');
    expect(asset.transferringAmount).toBe('0');
    expect(view.pool(COIN)).toHaveLength(2);
  });

  it('tokens() and assets() enrich from the registry (symbol, name, decimals, iconUrl)', async () => {
    const { view } = makeView([page([item('A', { seq: 1 })], 5), page([], 5)]);
    await view.fullPull();
    const [token] = view.tokens(registry);
    expect(token).toMatchObject({
      symbol: 'UCT',
      name: 'unicity',
      decimals: 6,
      iconUrl: 'https://icons/uct.png',
      status: 'confirmed',
      amount: '100',
    });
    const [asset] = await view.assets(registry, {
      getPrices: async () => new Map([['unicity', { priceUsd: 2, priceEur: 1.5, change24h: -3 }]]),
    });
    expect(asset).toMatchObject({
      symbol: 'UCT',
      priceUsd: 2,
      priceEur: 1.5,
      change24h: -3,
      fiatValueUsd: (100 / 1e6) * 2,
    });
  });
});

describe('InventoryView epoch reset', () => {
  it('onEpochReset re-pulls per-key — stale entries drop only AFTER the new snapshot applies (no empty-view window)', async () => {
    const { view, queue } = makeView([
      page([item('A', { seq: 1 }), item('B', { seq: 2, amount: '50' })], 5),
      page([], 5),
    ]);
    await view.fullPull();
    const gate = deferred<InventoryPage>();
    queue.push(() => gate.promise, page([], 7));
    const reset = view.onEpochReset();
    await new Promise((r) => setTimeout(r, 0));
    expect(view.tokens(registry)).toHaveLength(2);
    gate.resolve(page([item('A', { seq: 1 })], 7));
    await reset;
    expect(view.tokens(registry).map((t) => t.id)).toEqual(['A']);
    expect(view.pool(COIN).map((p) => p.tokenId)).toEqual(['A']);
  });
});
