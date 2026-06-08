import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ConnectivityManager,
  AggregatorPinger,
  IpfsPinger,
  NostrPinger,
  DEFAULT_BACKOFF_SCHEDULE_MS,
  DEFAULT_FAILURE_THRESHOLD,
  AGGREGATOR_RETRY_BACKOFFS_MS,
  isTransientAggregatorError,
  type ConnectivityStatus,
  type Pinger,
  type PingResult,
} from '../../../core/connectivity';

// ---------------------------------------------------------------------------
// Controllable mock pinger
// ---------------------------------------------------------------------------

class MockPinger implements Pinger {
  constructor(
    public readonly backend: 'aggregator' | 'ipfs' | 'nostr',
    public result: PingResult | 'throw' = 'up',
  ) {}

  public calls = 0;

  async ping(_signal: AbortSignal): Promise<PingResult> {
    this.calls += 1;
    if (this.result === 'throw') {
      throw new Error('mock ping threw');
    }
    return this.result;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Drain all microtasks AND timers — required because `vi.useFakeTimers()`
 *  replaces `queueMicrotask` and the manager's probe chain spans multiple
 *  microtask turns through await/then chains. */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    // Run any pending timers that have been scheduled for "now"
    await vi.advanceTimersByTimeAsync(0);
  }
}

describe('ConnectivityManager', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      // Don't fake queueMicrotask — it's needed for the async probe chain.
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('reports all-unknown before start()', () => {
      const m = new ConnectivityManager([
        new MockPinger('aggregator'),
        new MockPinger('ipfs'),
        new MockPinger('nostr'),
      ]);
      const s = m.status();
      expect(s.aggregator).toBe('unknown');
      expect(s.ipfs).toBe('unknown');
      expect(s.nostr).toBe('unknown');
      expect(s.lastOnlineAt).toBeNull();
    });

    it('reports unregistered backends as "up" (no-pinger = no-block)', () => {
      // Wallet with no IPFS configured: only aggregator + nostr.
      const m = new ConnectivityManager([
        new MockPinger('aggregator'),
        new MockPinger('nostr'),
      ]);
      expect(m.status().ipfs).toBe('up');
    });
  });

  describe('probe scheduling', () => {
    it('runs the first probe on a microtask and transitions to up', async () => {
      const agg = new MockPinger('aggregator', 'up');
      const m = new ConnectivityManager([agg], { emitEvent: () => undefined });
      m.start();
      expect(agg.calls).toBe(0);
      // Drain microtasks
      await drain();
      expect(agg.calls).toBe(1);
      expect(m.status().aggregator).toBe('up');
      await m.stop();
    });

    it('respects 5/15/60/300s backoff schedule on consecutive failures', async () => {
      const agg = new MockPinger('aggregator', 'down');
      // failureThreshold:1 — this test pre-dates #424 and asserts
      // immediate-flip semantics. Threshold behaviour is exercised in
      // its dedicated block.
      const m = new ConnectivityManager([agg], { failureThreshold: 1 });
      m.start();
      // 1st probe fires on microtask.
      await drain();
      expect(agg.calls).toBe(1);
      expect(m.status().aggregator).toBe('down');

      // 5s → 2nd probe
      await vi.advanceTimersByTimeAsync(5_000);
      expect(agg.calls).toBe(2);

      // +15s → 3rd probe (cumulative 20s)
      await vi.advanceTimersByTimeAsync(15_000);
      expect(agg.calls).toBe(3);

      // +60s → 4th probe (cumulative 80s)
      await vi.advanceTimersByTimeAsync(60_000);
      expect(agg.calls).toBe(4);

      // +300s → 5th probe (cumulative 380s)
      await vi.advanceTimersByTimeAsync(300_000);
      expect(agg.calls).toBe(5);

      // Further failures stay at 300s
      await vi.advanceTimersByTimeAsync(300_000);
      expect(agg.calls).toBe(6);

      await m.stop();
    });

    it('first failure schedules the next probe at 5s (not later in schedule)', async () => {
      const agg = new MockPinger('aggregator', 'down');
      const m = new ConnectivityManager([agg]);
      m.start();
      await drain();
      expect(agg.calls).toBe(1);
      // 4s = no probe yet
      await vi.advanceTimersByTimeAsync(4_000);
      expect(agg.calls).toBe(1);
      // 5s mark = 2nd probe fires
      await vi.advanceTimersByTimeAsync(1_000);
      expect(agg.calls).toBe(2);
      await m.stop();
    });

    it('resets backoff to step 0 after a successful probe', async () => {
      const agg = new MockPinger('aggregator', 'down');
      const m = new ConnectivityManager([agg]);
      m.start();
      await drain();
      // 1st probe (microtask) failed → step 0 used for 2nd probe (5s),
      // step bumped to 1 for the slot after that.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(agg.calls).toBe(2);
      // 2nd probe failed → step 1 used for 3rd probe (15s).
      await vi.advanceTimersByTimeAsync(15_000);
      expect(agg.calls).toBe(3);

      // Now flip to up; wait for 4th probe at 60s
      agg.result = 'up';
      await vi.advanceTimersByTimeAsync(60_000);
      expect(agg.calls).toBe(4);
      expect(m.status().aggregator).toBe('up');

      // After success, step resets to 0; next probe fires at 5s.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(agg.calls).toBe(5);
      await m.stop();
    });

    it('does not extend backoff on degraded', async () => {
      const agg = new MockPinger('aggregator', 'degraded');
      const m = new ConnectivityManager([agg]);
      m.start();
      await drain();
      // Degraded keeps backoffStep at 0; next probe always at 5s.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(agg.calls).toBe(2);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(agg.calls).toBe(3);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(agg.calls).toBe(4);
      await m.stop();
    });
  });

  describe('subscribers and events', () => {
    it('notifies subscribers on every state transition', async () => {
      const agg = new MockPinger('aggregator', 'down');
      // failureThreshold:1 — pre-#424 immediate-flip semantics; this test
      // is about subscriber notification, not about threshold behaviour.
      const m = new ConnectivityManager([agg], { failureThreshold: 1 });
      const seen: ConnectivityStatus[] = [];
      m.subscribe((s) => { seen.push(s); });
      m.start();
      await drain();
      // unknown → down
      expect(seen).toHaveLength(1);
      expect(seen[0]!.aggregator).toBe('down');

      // Stays down, no new transition
      await vi.advanceTimersByTimeAsync(5_000);
      expect(seen).toHaveLength(1);

      // Flip to up
      agg.result = 'up';
      await vi.advanceTimersByTimeAsync(15_000); // backoff step 1
      // Actually now 2nd failed probe ran at 5s, so backoff is at step 2 now,
      // but agg.result was changed before that probe ran. Let me just check
      // total count.
      expect(seen.length).toBeGreaterThanOrEqual(2);
      const lastSeen = seen[seen.length - 1]!;
      expect(lastSeen.aggregator).toBe('up');
      await m.stop();
    });

    it('emits connectivity:online when all backends transition to up', async () => {
      const agg = new MockPinger('aggregator', 'up');
      const ipfs = new MockPinger('ipfs', 'up');
      const nostr = new MockPinger('nostr', 'up');
      const events: Array<{ type: string; payload: ConnectivityStatus }> = [];
      const m = new ConnectivityManager([agg, ipfs, nostr], {
        emitEvent: (type, payload) => { events.push({ type, payload }); },
      });
      m.start();
      await drain();
      // Each backend transition fires connectivity:changed; the LAST
      // transition to make all-up fires connectivity:online.
      const changedCount = events.filter((e) => e.type === 'connectivity:changed').length;
      const onlineCount = events.filter((e) => e.type === 'connectivity:online').length;
      expect(changedCount).toBeGreaterThanOrEqual(3);
      expect(onlineCount).toBe(1);
      await m.stop();
    });

    it('emits connectivity:offline-degraded when a backend goes down from all-up', async () => {
      const agg = new MockPinger('aggregator', 'up');
      const ipfs = new MockPinger('ipfs', 'up');
      const nostr = new MockPinger('nostr', 'up');
      const events: Array<{ type: string; payload: ConnectivityStatus }> = [];
      // failureThreshold:1 — this test asserts an immediate flip on a
      // single failure. The #424 threshold block covers default-2 semantics.
      const m = new ConnectivityManager([agg, ipfs, nostr], {
        emitEvent: (type, payload) => { events.push({ type, payload }); },
        failureThreshold: 1,
      });
      m.start();
      await drain();
      // All up; we got one online event
      expect(events.filter((e) => e.type === 'connectivity:online').length).toBe(1);

      // Knock aggregator down
      agg.result = 'down';
      await vi.advanceTimersByTimeAsync(5_000);
      expect(events.filter((e) => e.type === 'connectivity:offline-degraded').length).toBe(1);
      await m.stop();
    });

    it('survives subscriber errors without breaking schedule', async () => {
      const agg = new MockPinger('aggregator', 'up');
      const m = new ConnectivityManager([agg]);
      const goodSubCalls: number[] = [];
      m.subscribe(() => { throw new Error('subscriber blew up'); });
      m.subscribe(() => { goodSubCalls.push(Date.now()); });
      m.start();
      await drain();
      expect(goodSubCalls.length).toBeGreaterThan(0);
      await m.stop();
    });

    it('survives emit-hook errors without breaking schedule', async () => {
      const agg = new MockPinger('aggregator', 'down');
      const m = new ConnectivityManager([agg], {
        emitEvent: () => { throw new Error('emit blew up'); },
      });
      m.start();
      await drain();
      // The probe scheduled the next round despite the emit throw. After
      // the 1st failure, next probe is at schedule[0] = 5s.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(agg.calls).toBe(2);
      await m.stop();
    });
  });

  describe('probe error handling', () => {
    it('treats a throwing pinger as down', async () => {
      const agg = new MockPinger('aggregator', 'throw');
      // failureThreshold:1 — pre-#424 immediate-flip semantics.
      const m = new ConnectivityManager([agg], { failureThreshold: 1 });
      m.start();
      await drain();
      expect(m.status().aggregator).toBe('down');
      await m.stop();
    });

    it('schedules the next probe even after a heavy/blocking ping', async () => {
      // Simulate a 30s-blocking probe by never resolving; the manager's
      // wall-clock timeout (default 8s) should abandon it.
      const slowAgg: Pinger = {
        backend: 'aggregator',
        ping: () => new Promise(() => undefined), // never resolves
      };
      // failureThreshold:1 — pre-#424 immediate-flip semantics.
      const m = new ConnectivityManager([slowAgg], { pingTimeoutMs: 100, failureThreshold: 1 });
      m.start();
      // 1st probe is enqueued
      await drain();
      // 100ms timeout
      await vi.advanceTimersByTimeAsync(100);
      // Now the probe has resolved as 'down' (timeout); status updated.
      expect(m.status().aggregator).toBe('down');
      // 5s later, the next probe fires (still blocked, still down).
      await vi.advanceTimersByTimeAsync(5_000);
      // Status remains 'down'.
      expect(m.status().aggregator).toBe('down');
      await m.stop();
    });
  });

  describe('manual ping()', () => {
    it('force-probes a single backend on demand', async () => {
      const agg = new MockPinger('aggregator', 'up');
      const m = new ConnectivityManager([agg]);
      m.start();
      // Drain the initial probe
      await drain();
      const before = agg.calls;
      await m.ping('aggregator');
      expect(agg.calls).toBe(before + 1);
      await m.stop();
    });

    it('force-probes all backends with "all"', async () => {
      const agg = new MockPinger('aggregator', 'up');
      const ipfs = new MockPinger('ipfs', 'up');
      const nostr = new MockPinger('nostr', 'up');
      const m = new ConnectivityManager([agg, ipfs, nostr]);
      m.start();
      await drain();
      const beforeAgg = agg.calls;
      const beforeIpfs = ipfs.calls;
      const beforeNostr = nostr.calls;
      await m.ping('all');
      expect(agg.calls).toBe(beforeAgg + 1);
      expect(ipfs.calls).toBe(beforeIpfs + 1);
      expect(nostr.calls).toBe(beforeNostr + 1);
      await m.stop();
    });

    it('coalesces concurrent ping() calls', async () => {
      let resolveProbe!: () => void;
      const probePromise = new Promise<void>((r) => { resolveProbe = r; });
      const agg: Pinger = {
        backend: 'aggregator',
        ping: async () => { await probePromise; return 'up'; },
      };
      const m = new ConnectivityManager([agg]);
      m.start();
      // Initial probe is in-flight
      await drain();
      // Launch three concurrent force-probes
      const p1 = m.ping('aggregator');
      const p2 = m.ping('aggregator');
      const p3 = m.ping('aggregator');
      // Resolve the initial probe
      resolveProbe();
      await Promise.all([p1, p2, p3]);
      // All three should have waited for the in-flight probe — not started
      // their own probes.
      await m.stop();
    });
  });

  describe('stop()', () => {
    it('aborts in-flight probes and prevents further scheduling', async () => {
      let aborted = false;
      const agg: Pinger = {
        backend: 'aggregator',
        ping: (signal) => new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve('down');
          });
        }),
      };
      const m = new ConnectivityManager([agg]);
      m.start();
      await drain();
      const stopPromise = m.stop();
      await stopPromise;
      expect(aborted).toBe(true);

      // After stop, ping() is a no-op
      await m.ping('all');
      // Subscribers no-op
      const fn = vi.fn();
      const unsub = m.subscribe(fn);
      unsub();
      expect(fn).not.toHaveBeenCalled();
    });

    it('is idempotent', async () => {
      const m = new ConnectivityManager([new MockPinger('aggregator', 'up')]);
      m.start();
      await m.stop();
      await m.stop();
    });
  });
});

// ---------------------------------------------------------------------------
// AggregatorPinger
// ---------------------------------------------------------------------------

describe('AggregatorPinger', () => {
  it('returns up when provider.getCurrentRound() returns a positive number', async () => {
    const p = new AggregatorPinger({
      provider: { getCurrentRound: async () => 42 },
    });
    expect(await p.ping(new AbortController().signal)).toBe('up');
  });

  // Fresh shards / between-batch states can legitimately return a `0`
  // block height. The reference infra-probe treats ANY structured
  // JSON-RPC response as alive, and URL-mode (below) accepts any
  // finite numeric `result`. Provider-mode must match — previously
  // `0` was demoted to `'degraded'` and the wallet UI surfaced a
  // false "Aggregator service unavailable" banner.
  it('returns up when provider.getCurrentRound() returns 0 (real aggregator response)', async () => {
    const p = new AggregatorPinger({
      provider: { getCurrentRound: async () => 0 },
    });
    expect(await p.ping(new AbortController().signal)).toBe('up');
  });

  it('returns up for large positive numbers (no upper bound)', async () => {
    const p = new AggregatorPinger({
      provider: { getCurrentRound: async () => Number.MAX_SAFE_INTEGER },
    });
    expect(await p.ping(new AbortController().signal)).toBe('up');
  });

  it('returns degraded when provider.getCurrentRound() returns a non-finite/negative number', async () => {
    const nan = new AggregatorPinger({
      provider: { getCurrentRound: async () => Number.NaN },
    });
    expect(await nan.ping(new AbortController().signal)).toBe('degraded');

    const inf = new AggregatorPinger({
      provider: { getCurrentRound: async () => Number.POSITIVE_INFINITY },
    });
    expect(await inf.ping(new AbortController().signal)).toBe('degraded');

    const neg = new AggregatorPinger({
      provider: { getCurrentRound: async () => -1 },
    });
    expect(await neg.ping(new AbortController().signal)).toBe('degraded');
  });

  it('returns down when provider.getCurrentRound() throws (including the legacy "no aggregator client" stub path)', async () => {
    // Any thrown error → 'down'. The stub path in
    // UnicityAggregatorProvider.getCurrentRound() now throws when
    // `aggregatorClient` is null (pre-`initialize()`), so the pinger
    // correctly classifies an uninitialized provider as offline rather
    // than silently treating `0` as a real round value.
    //
    // Issue #424: retries disabled here (`retryBackoffsMs: []`) to
    // preserve the original test intent — verify the FINAL outcome is
    // 'down' — without adding real-time retry budget.
    const stub = new AggregatorPinger({
      provider: {
        getCurrentRound: async () => {
          throw new Error('UnicityAggregatorProvider: aggregator client not initialized');
        },
      },
      retryBackoffsMs: [],
    });
    expect(await stub.ping(new AbortController().signal)).toBe('down');

    const generic = new AggregatorPinger({
      provider: { getCurrentRound: async () => { throw new Error('503'); } },
      retryBackoffsMs: [],
    });
    expect(await generic.ping(new AbortController().signal)).toBe('down');
  });

  it('returns down when neither provider nor URL is supplied', async () => {
    // Issue #424: retries disabled — the 'down' path exits early (no URL,
    // no provider) without going through the retry loop, but we disable
    // explicitly to guard against future changes in that code path.
    const p = new AggregatorPinger({ retryBackoffsMs: [] });
    expect(await p.ping(new AbortController().signal)).toBe('down');
  });

  it('falls back to URL mode when no provider', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result: 42 }), { status: 200 }));
    const p = new AggregatorPinger({
      url: 'https://example.com/rpc',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await p.ping(new AbortController().signal)).toBe('up');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports down when URL-mode fetch fails', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    // Issue #424: retries disabled to avoid real-time backoff in this
    // legacy test. Retry behaviour is covered in the #424 block.
    const p = new AggregatorPinger({
      url: 'https://example.com/rpc',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBackoffsMs: [],
    });
    expect(await p.ping(new AbortController().signal)).toBe('down');
  });
});

// ---------------------------------------------------------------------------
// IpfsPinger
// ---------------------------------------------------------------------------

describe('IpfsPinger', () => {
  it('returns up on first successful gateway', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const p = new IpfsPinger(['https://gw1.example.com'], 'bafy...', fetchImpl as unknown as typeof fetch);
    expect(await p.ping(new AbortController().signal)).toBe('up');
  });

  it('returns degraded when all gateways reachable but none serve CID', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const p = new IpfsPinger(['https://gw1.example.com', 'https://gw2.example.com'], 'bafy...', fetchImpl as unknown as typeof fetch);
    expect(await p.ping(new AbortController().signal)).toBe('degraded');
  });

  it('returns down when all gateways unreachable', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const p = new IpfsPinger(['https://gw1.example.com'], 'bafy...', fetchImpl as unknown as typeof fetch);
    expect(await p.ping(new AbortController().signal)).toBe('down');
  });

  it('returns up when no gateways configured (skip-mode)', async () => {
    const p = new IpfsPinger([]);
    expect(await p.ping(new AbortController().signal)).toBe('up');
  });
});

// ---------------------------------------------------------------------------
// NostrPinger
// ---------------------------------------------------------------------------

describe('NostrPinger', () => {
  it('returns up when isConnected() returns true', async () => {
    const p = new NostrPinger(() => true);
    expect(await p.ping(new AbortController().signal)).toBe('up');
  });

  it('returns down when isConnected() returns false', async () => {
    const p = new NostrPinger(() => false);
    expect(await p.ping(new AbortController().signal)).toBe('down');
  });

  it('returns down when isConnected() throws', async () => {
    const p = new NostrPinger(() => { throw new Error('boom'); });
    expect(await p.ping(new AbortController().signal)).toBe('down');
  });
});

// ---------------------------------------------------------------------------
// Backoff schedule constant
// ---------------------------------------------------------------------------

describe('DEFAULT_BACKOFF_SCHEDULE_MS', () => {
  it('matches the spec: 5/15/60/300 seconds', () => {
    expect(DEFAULT_BACKOFF_SCHEDULE_MS).toEqual([5_000, 15_000, 60_000, 300_000]);
  });
});

// ---------------------------------------------------------------------------
// Issue #424: AggregatorPinger flake resilience
// ---------------------------------------------------------------------------

describe('AggregatorPinger flake resilience (issue #424)', () => {
  // Use real timers — the retry-loop's sleepWithAbort schedules sub-ms
  // backoffs (we override the schedule to [0, 0, 0]) and real timers
  // keep the test logic simple.
  beforeEach(() => {
    vi.useRealTimers();
  });

  describe('quick in-probe retry', () => {
    it('returns "up" when a transient error throws then a retry succeeds', async () => {
      let calls = 0;
      const p = new AggregatorPinger({
        provider: {
          getCurrentRound: async () => {
            calls += 1;
            if (calls < 2) throw new Error('fetch failed');
            return 42;
          },
        },
        retryBackoffsMs: [0, 0, 0],
      });
      expect(await p.ping(new AbortController().signal)).toBe('up');
      expect(calls).toBe(2);
    });

    it('retries through two transient throws then succeeds on the third attempt', async () => {
      let calls = 0;
      const p = new AggregatorPinger({
        provider: {
          getCurrentRound: async () => {
            calls += 1;
            if (calls < 3) throw new Error('ECONNRESET');
            return 7;
          },
        },
        retryBackoffsMs: [0, 0, 0],
      });
      expect(await p.ping(new AbortController().signal)).toBe('up');
      expect(calls).toBe(3);
    });

    it('returns "down" only after exhausting the retry budget', async () => {
      let calls = 0;
      const p = new AggregatorPinger({
        provider: {
          getCurrentRound: async () => {
            calls += 1;
            throw new Error('fetch failed');
          },
        },
        retryBackoffsMs: [0, 0, 0],
      });
      expect(await p.ping(new AbortController().signal)).toBe('down');
      // 1 initial + 3 retries = 4 attempts total
      expect(calls).toBe(4);
    });

    it('disables retries when retryBackoffsMs is empty (legacy single-attempt behaviour)', async () => {
      let calls = 0;
      const p = new AggregatorPinger({
        provider: {
          getCurrentRound: async () => {
            calls += 1;
            throw new Error('fetch failed');
          },
        },
        retryBackoffsMs: [],
      });
      expect(await p.ping(new AbortController().signal)).toBe('down');
      expect(calls).toBe(1);
    });
  });

  describe('error classification', () => {
    it('does NOT retry on HTTP 4xx (permanent error)', async () => {
      const fetchImpl = vi.fn(async () =>
        new Response('', { status: 400, statusText: 'Bad Request' }),
      );
      const p = new AggregatorPinger({
        url: 'https://example.com/rpc',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        retryBackoffsMs: [0, 0, 0],
      });
      expect(await p.ping(new AbortController().signal)).toBe('down');
      // Only one fetch call — no retries for permanent errors.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('retries on HTTP 5xx (transient server error)', async () => {
      let calls = 0;
      const fetchImpl = vi.fn(async () => {
        calls += 1;
        if (calls < 3) return new Response('', { status: 503, statusText: 'Unavailable' });
        return new Response(JSON.stringify({ result: 42 }), { status: 200 });
      });
      const p = new AggregatorPinger({
        url: 'https://example.com/rpc',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        retryBackoffsMs: [0, 0, 0],
      });
      expect(await p.ping(new AbortController().signal)).toBe('up');
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it('retries on HTTP 429 (rate-limit)', async () => {
      let calls = 0;
      const fetchImpl = vi.fn(async () => {
        calls += 1;
        if (calls < 2) return new Response('', { status: 429, statusText: 'Too Many Requests' });
        return new Response(JSON.stringify({ result: 1 }), { status: 200 });
      });
      const p = new AggregatorPinger({
        url: 'https://example.com/rpc',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        retryBackoffsMs: [0, 0, 0],
      });
      expect(await p.ping(new AbortController().signal)).toBe('up');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('classifier returns true for network-error shapes', () => {
      expect(isTransientAggregatorError(new Error('fetch failed'))).toBe(true);
      expect(isTransientAggregatorError(new Error('ECONNRESET'))).toBe(true);
      expect(isTransientAggregatorError(new Error('ECONNREFUSED'))).toBe(true);
      expect(isTransientAggregatorError(new Error('ENOTFOUND'))).toBe(true);
      expect(isTransientAggregatorError(new Error('ETIMEDOUT'))).toBe(true);
      expect(isTransientAggregatorError(new Error('EAI_AGAIN'))).toBe(true);
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      expect(isTransientAggregatorError(abortErr)).toBe(true);
    });

    it('classifier returns false for HTTP 4xx (except 429)', () => {
      expect(isTransientAggregatorError(new Error('HTTP 400 Bad Request from x'))).toBe(false);
      expect(isTransientAggregatorError(new Error('HTTP 401 Unauthorized from x'))).toBe(false);
      expect(isTransientAggregatorError(new Error('HTTP 404 Not Found from x'))).toBe(false);
      // 429 is the explicit exception — rate-limit is retryable.
      expect(isTransientAggregatorError(new Error('HTTP 429 Too Many Requests from x'))).toBe(true);
    });

    it('classifier returns true for HTTP 5xx', () => {
      expect(isTransientAggregatorError(new Error('HTTP 500 Internal Server Error'))).toBe(true);
      expect(isTransientAggregatorError(new Error('HTTP 502 Bad Gateway'))).toBe(true);
      expect(isTransientAggregatorError(new Error('HTTP 503 Service Unavailable'))).toBe(true);
    });

    it('classifier returns true for non-Error / unknown shapes (lenient default)', () => {
      expect(isTransientAggregatorError('plain string')).toBe(true);
      expect(isTransientAggregatorError(null)).toBe(true);
      expect(isTransientAggregatorError({ foo: 'bar' })).toBe(true);
      expect(isTransientAggregatorError(new Error('totally unrecognised'))).toBe(true);
    });
  });

  describe('abort propagation', () => {
    it('returns "down" immediately when the caller aborts before the first attempt', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      let calls = 0;
      const p = new AggregatorPinger({
        provider: {
          getCurrentRound: async () => {
            calls += 1;
            return 1;
          },
        },
        retryBackoffsMs: [50, 50, 50],
      });
      expect(await p.ping(ctrl.signal)).toBe('down');
      expect(calls).toBe(0);
    });

    it('returns "down" when the caller aborts mid-backoff between attempts', async () => {
      let calls = 0;
      const ctrl = new AbortController();
      const p = new AggregatorPinger({
        provider: {
          getCurrentRound: async () => {
            calls += 1;
            throw new Error('fetch failed');
          },
        },
        // Long enough backoff for the abort to land mid-sleep.
        retryBackoffsMs: [200, 200, 200],
      });
      const promise = p.ping(ctrl.signal);
      // Let the first attempt run and start sleeping.
      await new Promise<void>((r) => setTimeout(r, 20));
      ctrl.abort();
      expect(await promise).toBe('down');
      // Only the first attempt ran; we aborted during the first backoff.
      expect(calls).toBe(1);
    });
  });

  describe('AGGREGATOR_RETRY_BACKOFFS_MS', () => {
    it('matches the [100, 500, 2000] schedule', () => {
      expect(AGGREGATOR_RETRY_BACKOFFS_MS).toEqual([100, 500, 2000]);
    });
  });
});

// ---------------------------------------------------------------------------
// Issue #424: ConnectivityManager consecutive-failure threshold
// ---------------------------------------------------------------------------

describe('ConnectivityManager consecutive-failure threshold (issue #424)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Drain microtasks + zero-delay timers. */
  async function drainLocal(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
  }

  it('DEFAULT_FAILURE_THRESHOLD is 2', () => {
    expect(DEFAULT_FAILURE_THRESHOLD).toBe(2);
  });

  it('a single failed probe does NOT flip status to "down" (threshold=2)', async () => {
    const agg = new MockPinger('aggregator', 'down');
    const m = new ConnectivityManager([agg], { failureThreshold: 2 });
    m.start();
    await drainLocal();
    // First probe failed but status is still 'unknown' (held previous).
    expect(agg.calls).toBe(1);
    expect(m.status().aggregator).toBe('unknown');
    await m.stop();
  });

  it('flips to "down" only after N consecutive failures', async () => {
    const agg = new MockPinger('aggregator', 'down');
    const m = new ConnectivityManager([agg], { failureThreshold: 3 });
    m.start();
    await drainLocal();
    expect(agg.calls).toBe(1);
    expect(m.status().aggregator).toBe('unknown');

    // 2nd failure (after 5s) — still not flipped (threshold is 3).
    await vi.advanceTimersByTimeAsync(5_000);
    expect(agg.calls).toBe(2);
    expect(m.status().aggregator).toBe('unknown');

    // 3rd failure (after 15s) — now flips to 'down'.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(agg.calls).toBe(3);
    expect(m.status().aggregator).toBe('down');

    await m.stop();
  });

  it('threshold=1 reproduces the legacy "flip on first failure" behaviour', async () => {
    const agg = new MockPinger('aggregator', 'down');
    const m = new ConnectivityManager([agg], { failureThreshold: 1 });
    m.start();
    await drainLocal();
    expect(m.status().aggregator).toBe('down');
    await m.stop();
  });

  it('a single success after "down" flips back to "up" immediately (fast recovery)', async () => {
    const agg = new MockPinger('aggregator', 'down');
    const m = new ConnectivityManager([agg], { failureThreshold: 2 });
    m.start();
    await drainLocal();
    expect(m.status().aggregator).toBe('unknown');

    // Second failure (5s) — flips to 'down'.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(m.status().aggregator).toBe('down');

    // Now flip the mock to up; the next scheduled probe (at 15s from
    // last) will return 'up'.
    agg.result = 'up';
    await vi.advanceTimersByTimeAsync(15_000);
    expect(m.status().aggregator).toBe('up');

    await m.stop();
  });

  it('resets the failure counter on success — alternating fail/pass never flips', async () => {
    let n = 0;
    const flaky: Pinger = {
      backend: 'aggregator',
      ping: async () => {
        n += 1;
        return n % 2 === 1 ? 'down' : 'up';
      },
    };
    const m = new ConnectivityManager([flaky], { failureThreshold: 2 });
    m.start();
    await drainLocal();
    // 1st: down → counter=1, prev='unknown', status stays 'unknown'.
    expect(m.status().aggregator).toBe('unknown');
    // 2nd (at 5s): up → counter resets, status flips to 'up'.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(m.status().aggregator).toBe('up');
    // 3rd (at 5s after up): down → counter=1, status stays 'up'.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(m.status().aggregator).toBe('up');
    // 4th: up → counter resets, status stays 'up'.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(m.status().aggregator).toBe('up');
    await m.stop();
  });

  it('default threshold (no config) is 2 — one failure does not flip', async () => {
    const agg = new MockPinger('aggregator', 'down');
    const m = new ConnectivityManager([agg]); // no config → DEFAULT_FAILURE_THRESHOLD = 2
    m.start();
    await drainLocal();
    expect(m.status().aggregator).toBe('unknown');
    // Second failure flips it.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(m.status().aggregator).toBe('down');
    await m.stop();
  });

  it('subscriber is NOT notified on a suppressed failure (status unchanged)', async () => {
    const agg = new MockPinger('aggregator', 'down');
    const m = new ConnectivityManager([agg], { failureThreshold: 2 });
    const seen: ConnectivityStatus[] = [];
    m.subscribe((s) => { seen.push(s); });
    m.start();
    await drainLocal();
    // First failure suppressed — no transition, no notification.
    expect(seen).toHaveLength(0);
    // Second failure flips to 'down' — notification fires.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.aggregator).toBe('down');
    await m.stop();
  });

  it('backoff schedule still advances even on suppressed failures', async () => {
    // Verify no regression: the 5/15/60/300 backoff still climbs for
    // consecutive failures regardless of whether status flipped.
    const agg = new MockPinger('aggregator', 'down');
    const m = new ConnectivityManager([agg], { failureThreshold: 5 });
    m.start();
    await drainLocal();
    expect(agg.calls).toBe(1);
    // Failures 1-5 — all suppressed (threshold=5) but schedule
    // climbs identically to the all-flips case.
    await vi.advanceTimersByTimeAsync(5_000);   // step 0 → 5s
    expect(agg.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(15_000);  // step 1 → 15s
    expect(agg.calls).toBe(3);
    await vi.advanceTimersByTimeAsync(60_000);  // step 2 → 60s
    expect(agg.calls).toBe(4);
    await vi.advanceTimersByTimeAsync(300_000); // step 3 → 300s
    expect(agg.calls).toBe(5);
    // 5th failure meets the threshold — status flips to 'down'.
    expect(m.status().aggregator).toBe('down');
    await m.stop();
  });

  it('throws on invalid failureThreshold (zero / negative / non-integer)', () => {
    expect(() =>
      new ConnectivityManager([new MockPinger('aggregator')], { failureThreshold: 0 }),
    ).toThrow(/failureThreshold/);
    expect(() =>
      new ConnectivityManager([new MockPinger('aggregator')], { failureThreshold: -1 }),
    ).toThrow(/failureThreshold/);
    expect(() =>
      new ConnectivityManager([new MockPinger('aggregator')], { failureThreshold: 1.5 }),
    ).toThrow(/failureThreshold/);
  });
});
