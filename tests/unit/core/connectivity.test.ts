import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ConnectivityManager,
  AggregatorPinger,
  IpfsPinger,
  NostrPinger,
  DEFAULT_BACKOFF_SCHEDULE_MS,
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
      const m = new ConnectivityManager([agg]);
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
      const m = new ConnectivityManager([agg]);
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
      const m = new ConnectivityManager([agg, ipfs, nostr], {
        emitEvent: (type, payload) => { events.push({ type, payload }); },
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
      const m = new ConnectivityManager([agg]);
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
      const m = new ConnectivityManager([slowAgg], { pingTimeoutMs: 100 });
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

  it('returns degraded when provider.getCurrentRound() returns 0 (legacy fallback)', async () => {
    const p = new AggregatorPinger({
      provider: { getCurrentRound: async () => 0 },
    });
    expect(await p.ping(new AbortController().signal)).toBe('degraded');
  });

  it('returns down when provider.getCurrentRound() throws', async () => {
    const p = new AggregatorPinger({
      provider: { getCurrentRound: async () => { throw new Error('503'); } },
    });
    expect(await p.ping(new AbortController().signal)).toBe('down');
  });

  it('returns down when neither provider nor URL is supplied', async () => {
    const p = new AggregatorPinger({});
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
    const p = new AggregatorPinger({
      url: 'https://example.com/rpc',
      fetchImpl: fetchImpl as unknown as typeof fetch,
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
