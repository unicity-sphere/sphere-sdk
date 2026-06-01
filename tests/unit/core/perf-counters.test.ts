import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __setPerfEnabledForTest,
  __stopAutoDumpForTest,
  dumpAndReset,
  incr,
  isPerfEnabled,
  observeMs,
  snapshot,
  time,
  timeSync,
} from '../../../core/perf-counters.js';

// =============================================================================
// Test fixtures
// =============================================================================

beforeEach(() => {
  // Start from a clean slate: stop any auto-dump, clear counters, enable.
  __stopAutoDumpForTest();
  __setPerfEnabledForTest(false);
  // Re-enable for the test body. The clean order is: disable to drop
  // any prior state via dumpAndReset under-the-hood guarantees, then
  // enable so test calls actually record.
  __setPerfEnabledForTest(true);
});

afterEach(() => {
  __setPerfEnabledForTest(false);
  __stopAutoDumpForTest();
});

// =============================================================================
// Tests
// =============================================================================

describe('perf-counters — opt-in measurement', () => {
  describe('when disabled (default)', () => {
    it('isPerfEnabled returns false', () => {
      __setPerfEnabledForTest(false);
      expect(isPerfEnabled()).toBe(false);
    });

    it('incr() is a no-op', () => {
      __setPerfEnabledForTest(false);
      incr('x');
      incr('y', 5);
      // Re-enable to inspect: snapshot must still be empty because the
      // calls above happened with PERF disabled.
      __setPerfEnabledForTest(true);
      expect(snapshot()).toEqual({});
    });

    it('observeMs() is a no-op', () => {
      __setPerfEnabledForTest(false);
      observeMs('latency', 42);
      __setPerfEnabledForTest(true);
      expect(snapshot()).toEqual({});
    });

    it('time() still runs the function and returns its value', async () => {
      __setPerfEnabledForTest(false);
      const result = await time('op', async () => 7);
      expect(result).toBe(7);
      __setPerfEnabledForTest(true);
      expect(snapshot()).toEqual({});
    });

    it('timeSync() still runs the function and returns its value', () => {
      __setPerfEnabledForTest(false);
      const result = timeSync('op', () => 'hello');
      expect(result).toBe('hello');
      __setPerfEnabledForTest(true);
      expect(snapshot()).toEqual({});
    });
  });

  describe('when enabled', () => {
    it('incr() accumulates counts', () => {
      incr('hits');
      incr('hits', 3);
      incr('misses');
      const snap = snapshot();
      expect(snap.hits.count).toBe(4);
      expect(snap.misses.count).toBe(1);
    });

    it('observeMs() records count + total + max', () => {
      observeMs('latency', 10);
      observeMs('latency', 20);
      observeMs('latency', 5);
      const snap = snapshot();
      expect(snap.latency.count).toBe(3);
      expect(snap.latency.totalMs).toBe(35);
      expect(snap.latency.maxMs).toBe(20);
      expect(snap.latency.avgMs).toBeCloseTo(11.667, 2);
    });

    it('observeMs() clamps negative and non-finite values to 0', () => {
      observeMs('bad', -100);
      observeMs('bad', Infinity);
      observeMs('bad', NaN);
      const snap = snapshot();
      expect(snap.bad.count).toBe(3);
      expect(snap.bad.totalMs).toBe(0);
      expect(snap.bad.maxMs).toBe(0);
    });

    it('time() wraps async function and records its wall-clock', async () => {
      const result = await time('op', async () => {
        await new Promise((r) => setTimeout(r, 5));
        return 42;
      });
      expect(result).toBe(42);
      const snap = snapshot();
      expect(snap.op.count).toBe(1);
      expect(snap.op.totalMs).toBeGreaterThan(0);
    });

    it('time() records the timing even when the function throws', async () => {
      await expect(
        time('badop', async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      const snap = snapshot();
      expect(snap.badop.count).toBe(1);
    });

    it('timeSync() wraps sync function and records its wall-clock', () => {
      const result = timeSync('syncop', () => 99);
      expect(result).toBe(99);
      const snap = snapshot();
      expect(snap.syncop.count).toBe(1);
    });

    it('snapshot() returns a stable view and does not clear', () => {
      incr('x');
      const a = snapshot();
      const b = snapshot();
      expect(a).toEqual(b);
      expect(snapshot().x.count).toBe(1);
    });

    it('dumpAndReset() clears counters', () => {
      incr('a');
      observeMs('b', 10);
      dumpAndReset();
      expect(snapshot()).toEqual({});
    });

    it('dumpAndReset() is a no-op when there are no counters', () => {
      // Should not throw, should not allocate.
      expect(() => dumpAndReset()).not.toThrow();
      expect(snapshot()).toEqual({});
    });
  });

  describe('isPerfEnabled', () => {
    it('reflects __setPerfEnabledForTest', () => {
      __setPerfEnabledForTest(true);
      expect(isPerfEnabled()).toBe(true);
      __setPerfEnabledForTest(false);
      expect(isPerfEnabled()).toBe(false);
    });
  });
});
