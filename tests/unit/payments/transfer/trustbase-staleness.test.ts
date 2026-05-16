/**
 * Unit tests for `modules/payments/transfer/trustbase-staleness.ts`
 * (T.5.F / W41).
 *
 * These tests exercise the in-memory ledger directly — the workers'
 * integration of the ledger is covered by
 * `trustbase-refresh-on-not-authenticated.test.ts` (integration).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  TrustBaseStaleness,
  noopRefresher,
  type RefreshOutcome,
  type TrustBaseRefresher,
} from '../../../../modules/payments/transfer/trustbase-staleness';

// =============================================================================
// 1. Test refresher fakes
// =============================================================================

interface RecordingRefresher extends TrustBaseRefresher {
  readonly calls: ReadonlyArray<{ aggregatorId: string }>;
}

function makeRecordingRefresher(
  outcomes: ReadonlyArray<RefreshOutcome> | (() => RefreshOutcome) = [
    { kind: 'applied', tag: 0 },
  ],
): RecordingRefresher {
  const calls: Array<{ aggregatorId: string }> = [];
  let i = 0;
  const fn = (): RefreshOutcome => {
    if (typeof outcomes === 'function') return outcomes();
    return outcomes[i++] ?? outcomes[outcomes.length - 1] ?? { kind: 'applied', tag: 0 };
  };
  return {
    calls,
    async refresh({ aggregatorId }) {
      calls.push({ aggregatorId });
      return fn();
    },
  };
}

function makeBlockingRefresher(): {
  readonly refresher: TrustBaseRefresher;
  /** Resolve all currently-pending refreshes with `outcome`. */
  readonly resolveAll: (outcome: RefreshOutcome) => void;
  /** Resolve the OLDEST pending refresh with `outcome`. */
  readonly resolveNext: (outcome: RefreshOutcome) => void;
  readonly callCount: () => number;
} {
  const pending: Array<(value: RefreshOutcome) => void> = [];
  let calls = 0;
  return {
    callCount: () => calls,
    resolveAll(outcome) {
      const ps = pending.splice(0, pending.length);
      for (const p of ps) p(outcome);
    },
    resolveNext(outcome) {
      const p = pending.shift();
      if (p !== undefined) p(outcome);
    },
    refresher: {
      refresh() {
        calls++;
        return new Promise((resolve) => {
          pending.push(resolve);
        });
      },
    },
  };
}

// =============================================================================
// 2. Construction
// =============================================================================

describe('TrustBaseStaleness — construction', () => {
  it('accepts a valid refresher', () => {
    const s = new TrustBaseStaleness({ refresher: noopRefresher() });
    expect(s.knownAggregatorCount()).toBe(0);
  });

  it('rejects null/undefined refresher', () => {
    expect(
      () =>
        new TrustBaseStaleness({
          refresher: null as unknown as TrustBaseRefresher,
        }),
    ).toThrow(/refresher is required/i);
  });

  it('rejects threshold < 1', () => {
    expect(
      () =>
        new TrustBaseStaleness({
          refresher: noopRefresher(),
          notAuthenticatedStaleThreshold: 0,
        }),
    ).toThrow(/threshold/i);
  });

  it('accepts custom threshold', () => {
    const s = new TrustBaseStaleness({
      refresher: noopRefresher(),
      notAuthenticatedStaleThreshold: 3,
    });
    s.recordNotAuthenticated();
    expect(s.isTrustBaseStale()).toBe(false);
    s.recordNotAuthenticated();
    expect(s.isTrustBaseStale()).toBe(false);
    s.recordNotAuthenticated();
    expect(s.isTrustBaseStale()).toBe(true);
  });
});

// =============================================================================
// 3. isTrustBaseStale + observation accounting
// =============================================================================

describe('TrustBaseStaleness — isTrustBaseStale', () => {
  it('returns false for never-observed aggregator', () => {
    const s = new TrustBaseStaleness({ refresher: noopRefresher() });
    expect(s.isTrustBaseStale()).toBe(false);
    expect(s.isTrustBaseStale('agg-2')).toBe(false);
  });

  it('flips to true after threshold (default 1) NOT_AUTHENTICATED', () => {
    const s = new TrustBaseStaleness({ refresher: noopRefresher() });
    s.recordNotAuthenticated();
    expect(s.isTrustBaseStale()).toBe(true);
  });

  it('isolates per-aggregator state', () => {
    const s = new TrustBaseStaleness({ refresher: noopRefresher() });
    s.recordNotAuthenticated('agg-A');
    expect(s.isTrustBaseStale('agg-A')).toBe(true);
    expect(s.isTrustBaseStale('agg-B')).toBe(false);
  });

  it('recordAuthenticatedOk resets the counter', async () => {
    const s = new TrustBaseStaleness({ refresher: noopRefresher() });
    s.recordNotAuthenticated();
    expect(s.isTrustBaseStale()).toBe(true);
    s.recordAuthenticatedOk();
    expect(s.isTrustBaseStale()).toBe(false);
  });

  it('recordAuthenticatedOk on never-observed aggregator is a no-op', () => {
    const s = new TrustBaseStaleness({ refresher: noopRefresher() });
    expect(() => s.recordAuthenticatedOk('agg-never')).not.toThrow();
    expect(s.knownAggregatorCount()).toBe(0);
  });
});

// =============================================================================
// 4. recordNotAuthenticated — first-strike vs post-refresh
// =============================================================================

describe('TrustBaseStaleness — recordNotAuthenticated kind', () => {
  it('first call returns first-strike with priorRefreshTag = 0', () => {
    const s = new TrustBaseStaleness({ refresher: noopRefresher() });
    const r = s.recordNotAuthenticated();
    expect(r.kind).toBe('first-strike');
    if (r.kind !== 'first-strike') return;
    expect(r.priorRefreshTag).toBe(0);
    expect(r.observationCount).toBe(1);
  });

  it('passing the SAME priorRefreshTag returns first-strike (no refresh happened)', () => {
    const s = new TrustBaseStaleness({ refresher: noopRefresher() });
    s.recordNotAuthenticated();
    const r2 = s.recordNotAuthenticated('default', 0);
    expect(r2.kind).toBe('first-strike');
  });

  it('post-refresh strike returns post-refresh with bumped tag', async () => {
    const refresher = makeRecordingRefresher([{ kind: 'applied', tag: 0 }]);
    const s = new TrustBaseStaleness({ refresher });
    const first = s.recordNotAuthenticated();
    expect(first.kind).toBe('first-strike');
    if (first.kind !== 'first-strike') return;

    // Refresh succeeds — tag bumps from 0 → 1.
    const outcome = await s.refreshTrustBase();
    expect(outcome.kind).toBe('applied');
    if (outcome.kind === 'applied') expect(outcome.tag).toBe(1);

    // Worker captures priorRefreshTag = 0 from the FIRST strike. The
    // second strike now records: current tag (1) > prior tag (0) →
    // post-refresh.
    const second = s.recordNotAuthenticated('default', first.priorRefreshTag);
    expect(second.kind).toBe('post-refresh');
    if (second.kind !== 'post-refresh') return;
    expect(second.currentRefreshTag).toBe(1);
    expect(second.priorRefreshTag).toBe(0);
  });

  it('refresh "no-change" still counts as a refresh (post-refresh on next strike)', async () => {
    const refresher = makeRecordingRefresher([{ kind: 'no-change', tag: 0 }]);
    const s = new TrustBaseStaleness({ refresher });
    const first = s.recordNotAuthenticated();
    if (first.kind !== 'first-strike') throw new Error('first-strike expected');
    await s.refreshTrustBase();
    const second = s.recordNotAuthenticated('default', first.priorRefreshTag);
    expect(second.kind).toBe('post-refresh');
  });

  it('refresh "failed" does NOT bump tag — next strike is still first-strike', async () => {
    const refresher = makeRecordingRefresher([
      { kind: 'failed', error: 'network' },
    ]);
    const s = new TrustBaseStaleness({ refresher });
    const first = s.recordNotAuthenticated();
    if (first.kind !== 'first-strike') throw new Error('first-strike expected');
    const outcome = await s.refreshTrustBase();
    expect(outcome.kind).toBe('failed');
    const second = s.recordNotAuthenticated('default', first.priorRefreshTag);
    expect(second.kind).toBe('first-strike');
  });
});

// =============================================================================
// 5. refreshTrustBase — debouncing
// =============================================================================

describe('TrustBaseStaleness — refresh debouncing', () => {
  it('concurrent refreshTrustBase calls share ONE in-flight refresh', async () => {
    const blocking = makeBlockingRefresher();
    const s = new TrustBaseStaleness({ refresher: blocking.refresher });

    const p1 = s.refreshTrustBase();
    const p2 = s.refreshTrustBase();
    const p3 = s.refreshTrustBase();

    // ALL three callers share the same promise; refresher invoked once.
    expect(blocking.callCount()).toBe(1);

    blocking.resolveAll({ kind: 'applied', tag: 0 });
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    // All three resolve to the same outcome.
    expect(r1.kind).toBe('applied');
    expect(r2.kind).toBe('applied');
    expect(r3.kind).toBe('applied');
    if (r1.kind === 'applied' && r2.kind === 'applied' && r3.kind === 'applied') {
      expect(r1.tag).toBe(1);
      expect(r2.tag).toBe(1);
      expect(r3.tag).toBe(1);
    }
  });

  it('after in-flight resolves, next call triggers a NEW refresh', async () => {
    const refresher = makeRecordingRefresher([
      { kind: 'applied', tag: 0 },
      { kind: 'applied', tag: 0 },
    ]);
    const s = new TrustBaseStaleness({ refresher });
    await s.refreshTrustBase();
    expect(refresher.calls.length).toBe(1);
    await s.refreshTrustBase();
    expect(refresher.calls.length).toBe(2);
  });

  it('debounces per aggregatorId — different keys do NOT share', async () => {
    const blocking = makeBlockingRefresher();
    const s = new TrustBaseStaleness({ refresher: blocking.refresher });

    const p1 = s.refreshTrustBase('agg-A');
    const p2 = s.refreshTrustBase('agg-B');
    expect(blocking.callCount()).toBe(2);

    // Both aggregators have an in-flight refresh — resolve both.
    blocking.resolveAll({ kind: 'applied', tag: 0 });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.kind).toBe('applied');
    expect(r2.kind).toBe('applied');
    // Each aggregator gets its own bumped tag — no cross-contamination.
    expect(s.getRefreshTag('agg-A')).toBe(1);
    expect(s.getRefreshTag('agg-B')).toBe(1);
    expect(s.getRefreshTag('agg-C')).toBe(0);
  });

  it('refresher throw is mapped to {kind: "failed"}', async () => {
    const s = new TrustBaseStaleness({
      refresher: {
        refresh() {
          throw new Error('boom');
        },
      },
    });
    const r = await s.refreshTrustBase();
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.error).toMatch(/boom/);
  });

  it('refresher rejecting promise is mapped to {kind: "failed"}', async () => {
    const s = new TrustBaseStaleness({
      refresher: {
        async refresh() {
          throw new Error('async-boom');
        },
      },
    });
    const r = await s.refreshTrustBase();
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.error).toMatch(/async-boom/);
  });
});

// =============================================================================
// 6. refresh side-effects: counter reset + tag bump
// =============================================================================

describe('TrustBaseStaleness — refresh side-effects', () => {
  it('"applied" bumps refreshTag', async () => {
    const refresher = makeRecordingRefresher([{ kind: 'applied', tag: 0 }]);
    const s = new TrustBaseStaleness({ refresher });
    expect(s.getRefreshTag()).toBe(0);
    await s.refreshTrustBase();
    expect(s.getRefreshTag()).toBe(1);
    await s.refreshTrustBase();
    expect(s.getRefreshTag()).toBe(2);
  });

  it('"applied" resets the NOT_AUTHENTICATED counter', async () => {
    const refresher = makeRecordingRefresher([{ kind: 'applied', tag: 0 }]);
    const s = new TrustBaseStaleness({ refresher });
    s.recordNotAuthenticated();
    expect(s.isTrustBaseStale()).toBe(true);
    await s.refreshTrustBase();
    expect(s.isTrustBaseStale()).toBe(false);
  });

  it('"failed" does NOT bump tag and does NOT reset counter', async () => {
    const refresher = makeRecordingRefresher([
      { kind: 'failed', error: 'network down' },
    ]);
    const s = new TrustBaseStaleness({ refresher });
    s.recordNotAuthenticated();
    await s.refreshTrustBase();
    expect(s.getRefreshTag()).toBe(0);
    expect(s.isTrustBaseStale()).toBe(true);
  });

  it('lastRefreshAt updates on success, not on failure', async () => {
    let now = 1700000000000;
    const refresher = makeRecordingRefresher([
      { kind: 'failed', error: 'x' },
      { kind: 'applied', tag: 0 },
    ]);
    const s = new TrustBaseStaleness({ refresher, now: () => now });
    await s.refreshTrustBase();
    expect(s.lastRefreshAt()).toBeNull();
    now += 10_000;
    await s.refreshTrustBase();
    expect(s.lastRefreshAt()).toBe(now);
  });

  it('lastNotAuthenticatedAt is recorded on each strike', () => {
    let now = 1700000000000;
    const s = new TrustBaseStaleness({
      refresher: noopRefresher(),
      now: () => now,
    });
    s.recordNotAuthenticated();
    expect(s.lastNotAuthenticatedAt()).toBe(now);
    now += 5_000;
    s.recordNotAuthenticated();
    expect(s.lastNotAuthenticatedAt()).toBe(now);
  });
});

// =============================================================================
// 7. Diagnostics
// =============================================================================

describe('TrustBaseStaleness — diagnostics', () => {
  it('knownAggregatorCount tracks lazily-created rows', () => {
    const s = new TrustBaseStaleness({ refresher: noopRefresher() });
    expect(s.knownAggregatorCount()).toBe(0);
    s.recordNotAuthenticated('agg-A');
    expect(s.knownAggregatorCount()).toBe(1);
    s.recordNotAuthenticated('agg-B');
    expect(s.knownAggregatorCount()).toBe(2);
    // Re-strike on agg-A — no new row.
    s.recordNotAuthenticated('agg-A');
    expect(s.knownAggregatorCount()).toBe(2);
  });

  it('getRefreshTag returns 0 for unknown aggregator', () => {
    const s = new TrustBaseStaleness({ refresher: noopRefresher() });
    expect(s.getRefreshTag('unknown')).toBe(0);
  });
});

// =============================================================================
// 8. AbortSignal forwarding
// =============================================================================

describe('TrustBaseStaleness — abort signal forwarding', () => {
  it('signal is forwarded to refresher', async () => {
    const captured: AbortSignal[] = [];
    const refresher: TrustBaseRefresher = {
      async refresh({ signal }) {
        if (signal !== undefined) captured.push(signal);
        return { kind: 'applied', tag: 0 };
      },
    };
    const s = new TrustBaseStaleness({ refresher });
    const ac = new AbortController();
    await s.refreshTrustBase('default', ac.signal);
    expect(captured.length).toBe(1);
    expect(captured[0]).toBe(ac.signal);
  });
});

// =============================================================================
// 9. now() injection
// =============================================================================

describe('TrustBaseStaleness — clock injection', () => {
  it('uses Date.now by default', () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(1234567890);
    try {
      const s = new TrustBaseStaleness({ refresher: noopRefresher() });
      s.recordNotAuthenticated();
      expect(s.lastNotAuthenticatedAt()).toBe(1234567890);
    } finally {
      spy.mockRestore();
    }
  });
});

// =============================================================================
// 10. Wave 3 / steelman: advisory-only contract for isTrustBaseStale
// =============================================================================

describe('TrustBaseStaleness — isTrustBaseStale is ADVISORY-ONLY (Wave 3)', () => {
  // The steelman finding: `isTrustBaseStale()` is passive. No path
  // refuses to accept an OK once the flag flips to true. The protocol
  // §9.4.1 contract is INTENTIONAL (Option A): the worker's two-strike
  // OK/NOT_AUTHENTICATED branch — NOT this advisory flag — owns
  // escalation. These tests pin that contract behaviorally so a future
  // refactor cannot accidentally promote the flag into a verification
  // gate without the spec-revision discussion the docstring requires.

  it('flips to true after threshold strikes — diagnostic only', () => {
    const s = new TrustBaseStaleness({
      refresher: noopRefresher(),
      notAuthenticatedStaleThreshold: 1,
    });
    expect(s.isTrustBaseStale()).toBe(false);
    s.recordNotAuthenticated();
    expect(s.isTrustBaseStale()).toBe(true);
  });

  it('does NOT cause `recordNotAuthenticated` to throw or block', () => {
    const s = new TrustBaseStaleness({
      refresher: noopRefresher(),
      notAuthenticatedStaleThreshold: 1,
    });
    s.recordNotAuthenticated();
    // Stale flag is up. The class still records subsequent strikes
    // and answers them — it's purely a counter + diagnostic, not a
    // gate.
    expect(() => s.recordNotAuthenticated()).not.toThrow();
    expect(s.isTrustBaseStale()).toBe(true);
  });

  it('does NOT prevent recordAuthenticatedOk from clearing the counter', () => {
    // The advisory contract: isTrustBaseStale() is forensic. An
    // authenticated OK clears the flag — a refresh that hasn't yet
    // applied does NOT block the OK from being accepted.
    const s = new TrustBaseStaleness({
      refresher: noopRefresher(),
      notAuthenticatedStaleThreshold: 1,
    });
    s.recordNotAuthenticated();
    expect(s.isTrustBaseStale()).toBe(true);
    s.recordAuthenticatedOk();
    expect(s.isTrustBaseStale()).toBe(false);
  });

  it('source carries the advisory-only docstring (anchored to spec §9.4.1)', async () => {
    // Anchor test for the docstring rationale. If a future refactor
    // changes the advisory semantics, this test fails and forces a
    // protocol-revision review.
    //
    // We read the source file directly because we want to assert on
    // the comment block, not on runtime behavior.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(
        __dirname,
        '../../../../modules/payments/transfer/trustbase-staleness.ts',
      ),
      'utf8',
    );
    expect(src).toMatch(/ADVISORY-ONLY \(Wave 3 \/ steelman\)/);
    expect(src).toMatch(/§9\.4\.1/);
  });
});
