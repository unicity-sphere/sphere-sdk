import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  selectCoins,
  DEFAULT_WORK_BUDGET,
  type PoolEntry,
  type SelectorStats,
} from '../../../modules/payments-v2/select/selector';
import { ReservationLedger } from '../../../modules/payments-v2/select/ledger';
import {
  SpendQueue,
  QUEUE_TIMEOUT_MS,
  QUEUE_MAX_SIZE,
  type PlanOutcome,
  type PlannedSpend,
} from '../../../modules/payments-v2/select/queue';
import { SphereError } from '../../../core/errors';

function pool(...entries: Array<[string, bigint]>): PoolEntry[] {
  return entries.map(([tokenId, amount]) => ({ tokenId, amount }));
}

function directAmounts(plan: { direct: readonly string[] }, entries: readonly PoolEntry[]): bigint[] {
  const byId = new Map(entries.map((e) => [e.tokenId, e.amount]));
  return plan.direct.map((id) => byId.get(id)!);
}

function sum(values: readonly bigint[]): bigint {
  return values.reduce((acc, v) => acc + v, 0n);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('selectCoins (pure selector)', () => {
  it('returns null for an empty pool', () => {
    expect(selectCoins([], 100n)).toBeNull();
  });

  it('returns null for a non-positive target', () => {
    expect(selectCoins(pool(['t1', 500n]), 0n)).toBeNull();
    expect(selectCoins(pool(['t1', 500n]), -5n)).toBeNull();
  });

  it('returns null when target exceeds total — caller distinguishes queue vs fail', () => {
    expect(selectCoins(pool(['t1', 300n], ['t2', 200n]), 600n)).toBeNull();
  });

  it('ignores non-positive pool amounts', () => {
    const p: PoolEntry[] = [
      { tokenId: 'zero', amount: 0n },
      { tokenId: 'neg', amount: -5n },
      { tokenId: 't1', amount: 500n },
    ];
    const plan = selectCoins(p, 500n);
    expect(plan).toEqual({ direct: ['t1'] });
  });

  it('finds an exact single token', () => {
    const p = pool(['t1', 500n], ['t2', 1000n]);
    const plan = selectCoins(p, 1000n);
    expect(plan).toEqual({ direct: ['t2'] });
  });

  it('prefers an exact single over an exact combination', () => {
    const p = pool(['a', 500n], ['b', 500n], ['c', 1000n]);
    const plan = selectCoins(p, 1000n);
    expect(plan).toEqual({ direct: ['c'] });
  });

  it('finds an exact two-token combination with no split', () => {
    const p = pool(['t1', 300n], ['t2', 700n]);
    const plan = selectCoins(p, 1000n)!;
    expect(plan.split).toBeUndefined();
    expect(new Set(plan.direct)).toEqual(new Set(['t1', 't2']));
  });

  it('finds an exact three-token combination among decoys', () => {
    const p = pool(['t1', 100n], ['t2', 200n], ['t3', 300n], ['t4', 900n]);
    const plan = selectCoins(p, 600n)!;
    expect(plan.split).toBeUndefined();
    expect(sum(directAmounts(plan, p))).toBe(600n);
  });

  it('prefers an exact combination over a split', () => {
    const p = pool(['t1', 300n], ['t2', 700n], ['t3', 600n]);
    const plan = selectCoins(p, 1000n)!;
    expect(plan.split).toBeUndefined();
    expect(new Set(plan.direct)).toEqual(new Set(['t1', 't2']));
  });

  it('strategy order: exact single beats combination beats split across shrinking pools', () => {
    const single = selectCoins(pool(['a', 400n], ['b', 250n], ['c', 150n]), 400n)!;
    expect(single).toEqual({ direct: ['a'] });
    const combo = selectCoins(pool(['b', 250n], ['c', 150n], ['d', 300n]), 400n)!;
    expect(combo.split).toBeUndefined();
    expect(new Set(combo.direct)).toEqual(new Set(['b', 'c']));
    const split = selectCoins(pool(['e', 300n], ['f', 260n]), 400n)!;
    expect(split.direct).toEqual(['f']);
    expect(split.split).toEqual({ tokenId: 'e', splitAmount: 140n, remainderAmount: 160n });
  });

  it('greedy uses smallest-first and splits the overshooting token', () => {
    const p = pool(['t1', 300n], ['t2', 500n]);
    const plan = selectCoins(p, 400n)!;
    expect(plan.direct).toEqual(['t1']);
    expect(plan.split).toEqual({ tokenId: 't2', splitAmount: 100n, remainderAmount: 400n });
  });

  it('splits a single token when target is below the smallest amount', () => {
    const plan = selectCoins(pool(['t1', 1000n]), 100n)!;
    expect(plan.direct).toEqual([]);
    expect(plan.split).toEqual({ tokenId: 't1', splitAmount: 100n, remainderAmount: 900n });
  });

  it('sorts descending input internally: greedy picks the small token first', () => {
    const plan = selectCoins(pool(['big', 900n], ['small', 100n]), 150n)!;
    expect(plan.direct).toEqual(['small']);
    expect(plan.split).toEqual({ tokenId: 'big', splitAmount: 50n, remainderAmount: 850n });
  });

  it('greedy accumulates several tokens before splitting the remainder', () => {
    const p = pool(['t1', 100n], ['t2', 200n], ['t3', 500n]);
    const plan = selectCoins(p, 450n)!;
    expect(new Set(plan.direct)).toEqual(new Set(['t1', 't2']));
    expect(plan.split).toEqual({ tokenId: 't3', splitAmount: 150n, remainderAmount: 350n });
  });

  it('target equal to total selects everything direct with no split', () => {
    const p = pool(['t1', 300n], ['t2', 700n]);
    const plan = selectCoins(p, 1000n)!;
    expect(plan.split).toBeUndefined();
    expect(sum(directAmounts(plan, p))).toBe(1000n);
  });

  it('greedy exact-sum of six tokens returns all-direct even though combination caps at five', () => {
    const p = pool(['t1', 100n], ['t2', 100n], ['t3', 100n], ['t4', 100n], ['t5', 100n], ['t6', 100n]);
    const plan = selectCoins(p, 600n)!;
    expect(plan.split).toBeUndefined();
    expect(plan.direct).toHaveLength(6);
  });

  it('a fragmented 40-token wallet with an exact pair still finds it (old 20-candidate cliff)', () => {
    const entries: Array<[string, bigint]> = [['big', 983n], ['small', 17n]];
    for (let i = 0; i < 38; i++) entries.push([`dust-${i}`, 3n]);
    const p = pool(...entries);
    const plan = selectCoins(p, 1000n)!;
    expect(plan.split).toBeUndefined();
    expect(new Set(plan.direct)).toEqual(new Set(['big', 'small']));
  });

  it('respects the work budget: an exhausted search falls back to greedy split', () => {
    const entries: Array<[string, bigint]> = [['one', 1n], ['big', 999n]];
    for (let i = 0; i < 20; i++) entries.push([`mid-${i}`, 499n]);
    const p = pool(...entries);
    const stats: SelectorStats = { combinationsExamined: 0 };
    const plan = selectCoins(p, 1000n, { workBudget: 50, stats })!;
    expect(stats.combinationsExamined).toBe(50);
    expect(plan.split).toBeDefined();
    expect(sum(directAmounts(plan, p)) + plan.split!.splitAmount).toBe(1000n);
  });

  it('finds the same exact pair under the default budget that the tight budget misses', () => {
    const entries: Array<[string, bigint]> = [['one', 1n], ['big', 999n]];
    for (let i = 0; i < 20; i++) entries.push([`mid-${i}`, 499n]);
    const stats: SelectorStats = { combinationsExamined: 0 };
    const plan = selectCoins(pool(...entries), 1000n, { stats })!;
    expect(plan.split).toBeUndefined();
    expect(new Set(plan.direct)).toEqual(new Set(['one', 'big']));
    expect(stats.combinationsExamined).toBeLessThanOrEqual(DEFAULT_WORK_BUDGET);
  });

  it('counts every examined combination: 10 candidates with no exact subset yield C(10,2..5) = 627', () => {
    const entries: Array<[string, bigint]> = [];
    for (let i = 0; i < 10; i++) entries.push([`t${i}`, 7n]);
    const stats: SelectorStats = { combinationsExamined: 0 };
    const plan = selectCoins(pool(...entries), 69n, { stats })!;
    expect(stats.combinationsExamined).toBe(627);
    expect(plan.split).toEqual({ tokenId: plan.split!.tokenId, splitAmount: 6n, remainderAmount: 1n });
  });

  it('property: never over- or under-selects; split conserves the source amount (300 seeded cases)', () => {
    const rand = mulberry32(0xc01d5eed);
    for (let iter = 0; iter < 300; iter++) {
      const n = 1 + Math.floor(rand() * 30);
      const p: PoolEntry[] = Array.from({ length: n }, (_, i) => ({
        tokenId: `t${i}`,
        amount: BigInt(1 + Math.floor(rand() * 1000)),
      }));
      const total = sum(p.map((e) => e.amount));
      const target = BigInt(1 + Math.floor(rand() * Number(total + 100n)));
      const plan = selectCoins(p, target);
      if (target > total) {
        expect(plan).toBeNull();
        continue;
      }
      expect(plan).not.toBeNull();
      const byId = new Map(p.map((e) => [e.tokenId, e.amount]));
      const ids = new Set(plan!.direct);
      expect(ids.size).toBe(plan!.direct.length);
      let selected = 0n;
      for (const id of plan!.direct) {
        expect(byId.has(id)).toBe(true);
        selected += byId.get(id)!;
      }
      if (plan!.split) {
        const { tokenId, splitAmount, remainderAmount } = plan!.split;
        expect(ids.has(tokenId)).toBe(false);
        expect(splitAmount > 0n).toBe(true);
        expect(remainderAmount > 0n).toBe(true);
        expect(splitAmount + remainderAmount).toBe(byId.get(tokenId));
        selected += splitAmount;
      }
      expect(selected).toBe(target);
    }
  });
});

describe('ReservationLedger (whole-token set semantics)', () => {
  it('reserve() holds the whole token: getFreeAmount() reports 0 while held, the full amount when free', () => {
    const ledger = new ReservationLedger();
    ledger.reserve('r1', [{ tokenId: 't1' }]);
    expect(ledger.getFreeAmount('t1', 1000n)).toBe(0n);
  });

  it('reserve() spans multiple tokens in one reservation', () => {
    const ledger = new ReservationLedger();
    ledger.reserve('r1', [{ tokenId: 't1' }, { tokenId: 't2' }]);
    expect(ledger.getFreeAmount('t1', 300n)).toBe(0n);
    expect(ledger.getFreeAmount('t2', 400n)).toBe(0n);
  });

  it('duplicate tokenIds within one reserve() call collapse to one whole-token hold', () => {
    const ledger = new ReservationLedger();
    ledger.reserve('r1', [{ tokenId: 't1' }, { tokenId: 't1' }]);
    expect(ledger.getFreeAmount('t1', 1000n)).toBe(0n);
    ledger.cancel('r1');
    expect(ledger.getFreeAmount('t1', 1000n)).toBe(1000n);
  });

  it('commit() frees the tokens and is idempotent', () => {
    const ledger = new ReservationLedger();
    ledger.reserve('r1', [{ tokenId: 't1' }]);
    ledger.commit('r1');
    ledger.commit('r1');
    expect(ledger.getFreeAmount('t1', 500n)).toBe(500n);
  });

  it('cancel() frees the tokens, is idempotent, and allows re-reserving the same tokens', () => {
    const ledger = new ReservationLedger();
    ledger.reserve('r1', [{ tokenId: 't1' }]);
    ledger.cancel('r1');
    ledger.cancel('r1');
    expect(ledger.getFreeAmount('t1', 500n)).toBe(500n);
    ledger.reserve('r1', [{ tokenId: 't1' }]);
    expect(ledger.getFreeAmount('t1', 500n)).toBe(0n);
  });

  it('commit()/cancel() for unknown ids are no-ops', () => {
    const ledger = new ReservationLedger();
    ledger.commit('nope');
    ledger.cancel('nope');
    expect(ledger.getFreeAmount('t1', 100n)).toBe(100n);
  });

  it('reserve() with empty entries throws EMPTY_RESERVATION', () => {
    const ledger = new ReservationLedger();
    expect(() => ledger.reserve('r1', [])).toThrow('EMPTY_RESERVATION');
  });

  it('reserve() with a duplicate reservationId throws DUPLICATE_RESERVATION_ID', () => {
    const ledger = new ReservationLedger();
    ledger.reserve('r1', [{ tokenId: 't1' }]);
    expect(() => ledger.reserve('r1', [{ tokenId: 't2' }])).toThrow('DUPLICATE_RESERVATION_ID');
  });

  it('reserve() of an already-held token throws INSUFFICIENT_FREE_AMOUNT', () => {
    const ledger = new ReservationLedger();
    ledger.reserve('r1', [{ tokenId: 't1' }]);
    expect(() => ledger.reserve('r2', [{ tokenId: 't1' }])).toThrow('INSUFFICIENT_FREE_AMOUNT');
  });

  it('reserve() is all-or-nothing: a failing entry leaves earlier entries unreserved', () => {
    const ledger = new ReservationLedger();
    ledger.reserve('holder', [{ tokenId: 'bad' }]);
    expect(() => ledger.reserve('r1', [{ tokenId: 'ok' }, { tokenId: 'bad' }])).toThrow(
      'INSUFFICIENT_FREE_AMOUNT'
    );
    expect(ledger.getFreeAmount('ok', 100n)).toBe(100n);
    ledger.reserve('r2', [{ tokenId: 'ok' }]);
  });

  it('getFreeAmount() returns the full amount for an untracked token', () => {
    const ledger = new ReservationLedger();
    expect(ledger.getFreeAmount('unknown', 500n)).toBe(500n);
  });

  it('cancelForToken() cancels the holding reservation and returns its id', () => {
    const ledger = new ReservationLedger();
    ledger.reserve('r1', [{ tokenId: 't1' }]);
    ledger.reserve('r3', [{ tokenId: 'other' }]);
    expect(ledger.cancelForToken('t1')).toEqual(['r1']);
    expect(ledger.getFreeAmount('t1', 1000n)).toBe(1000n);
    expect(ledger.getFreeAmount('other', 100n)).toBe(0n);
  });

  it('cancelForToken() preserves the excluded reservation', () => {
    const ledger = new ReservationLedger();
    ledger.reserve('mine', [{ tokenId: 't1' }]);
    expect(ledger.cancelForToken('t1', 'mine')).toEqual([]);
    expect(ledger.getFreeAmount('t1', 1000n)).toBe(0n);
  });

  it('cancelForToken() on an untracked token returns an empty array', () => {
    const ledger = new ReservationLedger();
    expect(ledger.cancelForToken('nope')).toEqual([]);
  });

  it('cancelForToken() on a multi-token reservation frees all its tokens', () => {
    const ledger = new ReservationLedger();
    ledger.reserve('r1', [{ tokenId: 't1' }, { tokenId: 't2' }]);
    ledger.cancelForToken('t1');
    expect(ledger.getFreeAmount('t2', 200n)).toBe(200n);
  });

  it('clear() removes all reservations', () => {
    const ledger = new ReservationLedger();
    ledger.reserve('r1', [{ tokenId: 't1' }]);
    ledger.clear();
    expect(ledger.getFreeAmount('t1', 100n)).toBe(100n);
  });
});

const COIN = 'coin-a';

interface Harness {
  readonly ledger: ReservationLedger;
  readonly queue: SpendQueue;
  addToken(tokenId: string, amount: bigint): void;
}

function makeHarness(initial: Array<[string, bigint]> = []): Harness {
  const pools = new Map<string, PoolEntry[]>();
  pools.set(COIN, initial.map(([tokenId, amount]) => ({ tokenId, amount })));
  const ledger = new ReservationLedger();
  // #738: a fresh ledger's held-set is unproven and refuses every plan. These
  // cases exercise selection on a ledger IntentPins has already reconstructed.
  ledger.setAuthoritative(true);
  const queue = new SpendQueue({ ledger, getPool: (coinId) => pools.get(coinId) ?? [] });
  return {
    ledger,
    queue,
    addToken(tokenId, amount) {
      pools.get(COIN)!.push({ tokenId, amount });
    },
  };
}

function asQueued(outcome: PlanOutcome): Promise<PlannedSpend> {
  expect(outcome.kind).toBe('queued');
  if (outcome.kind !== 'queued') throw new Error('unreachable');
  return outcome.settled;
}

function asPlanned(outcome: PlanOutcome): PlannedSpend {
  expect(outcome.kind).toBe('planned');
  if (outcome.kind !== 'planned') throw new Error('unreachable');
  return outcome.spend;
}

describe('SpendQueue', () => {
  const harnesses: Harness[] = [];
  const track = (h: Harness): Harness => {
    harnesses.push(h);
    return h;
  };

  afterEach(() => {
    for (const h of harnesses.splice(0)) h.queue.destroy();
    vi.useRealTimers();
  });

  it('plans immediately and reserves whole tokens when free tokens cover the amount', () => {
    const h = track(makeHarness([['t1', 1000n]]));
    const spend = asPlanned(h.queue.plan('r1', { coinId: COIN, amount: '400' }));
    expect(spend.reservationId).toBe('r1');
    expect(spend.plan.split).toEqual({ tokenId: 't1', splitAmount: 400n, remainderAmount: 600n });
    expect(h.ledger.getFreeAmount('t1', 1000n)).toBe(0n);
  });

  it('an exact-amount token plans as a single direct transfer', () => {
    const h = track(makeHarness([['t1', 400n]]));
    const spend = asPlanned(h.queue.plan('r1', { coinId: COIN, amount: '400' }));
    expect(spend.plan).toEqual({ direct: ['t1'] });
    expect(h.ledger.getFreeAmount('t1', 400n)).toBe(0n);
  });

  it('rejects malformed, negative, and zero amounts with VALIDATION_ERROR', () => {
    const h = track(makeHarness([['t1', 1000n]]));
    for (const bad of ['abc', '-5', '0', '', '1.5']) {
      try {
        h.queue.plan(`r-${bad}`, { coinId: COIN, amount: bad });
        expect.fail(`should have thrown for ${JSON.stringify(bad)}`);
      } catch (e) {
        expect((e as SphereError).code).toBe('VALIDATION_ERROR');
      }
    }
  });

  it('fails fast with SEND_INSUFFICIENT_BALANCE when in-flight sources declared no expected change', () => {
    const h = track(makeHarness([['t1', 600n]]));
    h.ledger.reserve('inflight', [{ tokenId: 't1' }]);
    try {
      h.queue.plan('r1', { coinId: COIN, amount: '500' });
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as SphereError).code).toBe('SEND_INSUFFICIENT_BALANCE');
    }
  });

  it('counts declared expected change, not in-flight full amounts: shortfall fails fast instead of 30s queue death', () => {
    const h = track(makeHarness([['t1', 1000n]]));
    h.ledger.reserve('inflight', [{ tokenId: 't1' }]);
    h.queue.declareExpectedChange('inflight', COIN, 100n);
    try {
      h.queue.plan('r1', { coinId: COIN, amount: '500' });
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as SphereError).code).toBe('SEND_INSUFFICIENT_BALANCE');
    }
  });

  it('queues when declared expected change covers the shortfall, then plans when the change arrives', async () => {
    const h = track(makeHarness([['t1', 1000n]]));
    h.ledger.reserve('inflight', [{ tokenId: 't1' }]);
    h.queue.declareExpectedChange('inflight', COIN, 400n);
    const settled = asQueued(h.queue.plan('r1', { coinId: COIN, amount: '300' }));
    h.addToken('t-change', 400n);
    h.queue.clearExpectedChange('inflight');
    h.queue.notifyChange(COIN);
    const spend = await settled;
    expect(spend.reservationId).toBe('r1');
    expect(spend.plan.split).toEqual({ tokenId: 't-change', splitAmount: 300n, remainderAmount: 100n });
    expect(h.ledger.getFreeAmount('t-change', 400n)).toBe(0n);
  });

  it('#738: a queued entry is NOT served while the gate is closed, and IS served once it reopens', async () => {
    const h = makeHarness([]);
    h.queue.declareExpectedChange('f1', COIN, 100n);
    const settled = asQueued(h.queue.plan('r1', { coinId: COIN, amount: '100' }));
    let served = false;
    settled.then(() => (served = true)).catch(() => (served = true));

    // The change arrives, but a later pins.sync() could not reconstruct the
    // open-intent holds, so the held-set went unproven while this entry waited.
    h.addToken('t1', 100n);
    h.ledger.setAuthoritative(false);
    h.queue.notifyChange(COIN);
    await Promise.resolve();
    await Promise.resolve();
    // Paused, not served — serving here would spend through a closed gate.
    expect(served).toBe(false);

    // The next sync reconstructs the holds; the paused entry now goes through.
    h.ledger.setAuthoritative(true);
    h.queue.notifyChange(COIN);
    const spend = await settled;
    expect(spend.plan.direct).toEqual(['t1']);
  });

  it('skip-ahead: a small entry passes a blocked head without unblocking it', async () => {
    const h = track(makeHarness([['t1', 1000n]]));
    h.ledger.reserve('inflight', [{ tokenId: 't1' }]);
    h.queue.declareExpectedChange('inflight', COIN, 1000n);
    const headSettled = asQueued(h.queue.plan('head', { coinId: COIN, amount: '800' }));
    const smallSettled = asQueued(h.queue.plan('small', { coinId: COIN, amount: '200' }));
    let headDone = false;
    headSettled.then(() => (headDone = true)).catch(() => (headDone = true));
    h.addToken('t2', 300n);
    h.queue.notifyChange(COIN);
    const spend = await smallSettled;
    expect(spend.reservationId).toBe('small');
    expect(spend.plan.split).toEqual({ tokenId: 't2', splitAmount: 200n, remainderAmount: 100n });
    await Promise.resolve();
    expect(headDone).toBe(false);
  });

  it('serves same-size queued entries in FIFO order', async () => {
    const h = track(makeHarness([['t1', 1000n]]));
    h.ledger.reserve('inflight', [{ tokenId: 't1' }]);
    h.queue.declareExpectedChange('inflight', COIN, 1000n);
    const first = asQueued(h.queue.plan('first', { coinId: COIN, amount: '100' }));
    const second = asQueued(h.queue.plan('second', { coinId: COIN, amount: '100' }));
    h.addToken('c1', 100n);
    h.queue.notifyChange(COIN);
    expect((await first).plan).toEqual({ direct: ['c1'] });
    let secondDone = false;
    second.then(() => (secondDone = true)).catch(() => (secondDone = true));
    await Promise.resolve();
    expect(secondDone).toBe(false);
    h.addToken('c2', 100n);
    h.queue.notifyChange(COIN);
    expect((await second).plan).toEqual({ direct: ['c2'] });
  });

  it('timeout expires the head entry with SEND_QUEUE_TIMEOUT after 30s', async () => {
    vi.useFakeTimers();
    const h = track(makeHarness([['t1', 1000n]]));
    h.ledger.reserve('inflight', [{ tokenId: 't1' }]);
    h.queue.declareExpectedChange('inflight', COIN, 1000n);
    const settled = asQueued(h.queue.plan('r1', { coinId: COIN, amount: '500' }));
    vi.advanceTimersByTime(QUEUE_TIMEOUT_MS + 1);
    await expect(settled).rejects.toMatchObject({ code: 'SEND_QUEUE_TIMEOUT' });
  });

  it('coverage collapse after clearExpectedChange rejects queued entries at the next wake, not at 30s', async () => {
    const h = track(makeHarness([['t1', 1000n]]));
    h.ledger.reserve('inflight', [{ tokenId: 't1' }]);
    h.queue.declareExpectedChange('inflight', COIN, 500n);
    const settled = asQueued(h.queue.plan('r1', { coinId: COIN, amount: '300' }));
    h.queue.clearExpectedChange('inflight');
    h.queue.notifyChange(COIN);
    await expect(settled).rejects.toMatchObject({ code: 'SEND_INSUFFICIENT_BALANCE' });
  });

  it('enforces the global 100-entry cap with SEND_QUEUE_FULL', async () => {
    const h = track(makeHarness());
    h.queue.declareExpectedChange('inflight', COIN, 1_000_000n);
    const settledAll: Promise<PlannedSpend>[] = [];
    for (let i = 0; i < QUEUE_MAX_SIZE; i++) {
      settledAll.push(asQueued(h.queue.plan(`r-${i}`, { coinId: COIN, amount: '1' })));
    }
    try {
      h.queue.plan('overflow', { coinId: COIN, amount: '1' });
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as SphereError).code).toBe('SEND_QUEUE_FULL');
    }
    h.queue.destroy();
    for (const settled of settledAll) {
      await expect(settled).rejects.toMatchObject({ code: 'MODULE_DESTROYED' });
    }
  });

  it('destroy() rejects queued entries and further plan() calls with MODULE_DESTROYED', async () => {
    const h = makeHarness();
    h.queue.declareExpectedChange('inflight', COIN, 1000n);
    const settled = asQueued(h.queue.plan('r1', { coinId: COIN, amount: '500' }));
    h.queue.destroy();
    await expect(settled).rejects.toMatchObject({ code: 'MODULE_DESTROYED' });
    try {
      h.queue.plan('r2', { coinId: COIN, amount: '1' });
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as SphereError).code).toBe('MODULE_DESTROYED');
    }
  });

  it('notifyChange for one coin does not serve entries queued for another coin', async () => {
    const pools = new Map<string, PoolEntry[]>([
      [COIN, []],
      ['coin-b', []],
    ]);
    const ledger = new ReservationLedger();
    ledger.setAuthoritative(true); // #738: reconstructed ledger; see makeHarness
    const queue = new SpendQueue({ ledger, getPool: (coinId) => pools.get(coinId) ?? [] });
    queue.declareExpectedChange('fa', COIN, 100n);
    queue.declareExpectedChange('fb', 'coin-b', 100n);
    const settled = asQueued(queue.plan('r1', { coinId: COIN, amount: '100' }));
    pools.get(COIN)!.push({ tokenId: 'ta', amount: 100n });
    queue.notifyChange('coin-b');
    let done = false;
    settled.then(() => (done = true)).catch(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    queue.notifyChange(COIN);
    expect((await settled).plan).toEqual({ direct: ['ta'] });
    queue.destroy();
  });

  it('a reservation failure during wake rejects that entry and keeps serving the rest', async () => {
    const h = track(makeHarness([['t1', 1000n]]));
    h.ledger.reserve('inflight', [{ tokenId: 't1' }]);
    h.queue.declareExpectedChange('inflight', COIN, 1000n);
    const clashing = asQueued(h.queue.plan('taken-id', { coinId: COIN, amount: '100' }));
    const healthy = asQueued(h.queue.plan('fresh-id', { coinId: COIN, amount: '100' }));
    h.addToken('c1', 100n);
    h.addToken('c2', 100n);
    h.ledger.reserve('taken-id', [{ tokenId: 'unrelated' }]);
    h.queue.notifyChange(COIN);
    await expect(clashing).rejects.toThrow('DUPLICATE_RESERVATION_ID');
    expect((await healthy).plan).toEqual({ direct: ['c1'] });
  });
});
