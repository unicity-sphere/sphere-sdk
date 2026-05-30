/**
 * Tests for Audit #333 H1: same-process source lock — shared module.
 *
 * Background
 * ----------
 * Before the H1 fix, the per-source lock registry was module-local to
 * `instant-sender.ts`. `conservative-sender.ts` had zero locking
 * primitives — two concurrent conservative sends (or an instant + a
 * conservative concurrent send) sharing a source token could both
 * pass selection, both commit on-chain, and only the aggregator
 * caught the duplicate-spend after a source was already burned.
 *
 * The lock registry has been extracted to `./source-locks.ts` and
 * both senders now share the SAME process-global map. This file
 * verifies the shared-module contract:
 *   - Direct unit tests on `acquireSourceLocks` from the shared module
 *   - The lock map is GENUINELY shared (calls via different sender
 *     entry points serialize against each other)
 *   - `__resetSourceLocksForTesting` works through both re-export
 *     paths (back-compat for existing instant-sender test imports)
 *
 * Integration tests proving conservative-sender's pipeline acquires
 * and releases the lock live in a separate test file
 * (conservative-sender-h1-source-lock.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireSourceLocks,
  __resetSourceLocksForTesting,
} from '../../../../modules/payments/transfer/source-locks';
import {
  __resetSourceLocksForTesting as __resetFromInstantSender,
} from '../../../../modules/payments/transfer/instant-sender';

describe('Audit #333 H1 — shared source-lock module', () => {
  beforeEach(() => __resetSourceLocksForTesting());
  afterEach(() => __resetSourceLocksForTesting());

  describe('acquireSourceLocks contract', () => {
    it('two concurrent acquires on the SAME tokenId serialize', async () => {
      const order: string[] = [];

      const releaseA = await acquireSourceLocks(['tok-shared'], 60_000, 'A');
      order.push('A-acquired');

      // B starts but cannot acquire — it will await until A releases.
      const bPromise = (async () => {
        const release = await acquireSourceLocks(['tok-shared'], 60_000, 'B');
        order.push('B-acquired');
        release();
      })();

      // Give the microtask queue a chance to advance — B should NOT
      // have acquired yet because A still holds the lock.
      await new Promise((r) => setTimeout(r, 10));
      expect(order).toEqual(['A-acquired']);

      // Release A. Now B can acquire.
      releaseA();
      await bPromise;

      expect(order).toEqual(['A-acquired', 'B-acquired']);
    });

    it('disjoint tokenIds proceed concurrently', async () => {
      const start = Date.now();
      const [releaseA, releaseB] = await Promise.all([
        acquireSourceLocks(['tok-disjoint-1'], 60_000, 'A'),
        acquireSourceLocks(['tok-disjoint-2'], 60_000, 'B'),
      ]);
      const elapsed = Date.now() - start;

      // Both completed concurrently — no waiting.
      expect(elapsed).toBeLessThan(100);
      releaseA();
      releaseB();
    });

    it('lex-sorted acquisition prevents deadlock on overlapping sets', async () => {
      // Send A locks [X, Y]; Send B locks [Y, X]. Without lex-sort,
      // each holds one and waits for the other. The sort ensures both
      // try X first, then Y.
      const releaseA = await acquireSourceLocks(['tok-Y', 'tok-X'], 60_000, 'A');
      // B starts and blocks on X (A holds it).
      let bDone = false;
      const bPromise = (async () => {
        const release = await acquireSourceLocks(['tok-X', 'tok-Y'], 60_000, 'B');
        bDone = true;
        release();
      })();

      await new Promise((r) => setTimeout(r, 10));
      expect(bDone).toBe(false);

      releaseA();
      await bPromise;
      expect(bDone).toBe(true);
    });

    it('deduplicates tokenIds within a single acquire call', async () => {
      // Acquiring the same id twice in one call should not deadlock
      // itself (the Set dedup eliminates the duplicate).
      const release = await acquireSourceLocks(
        ['tok-dup', 'tok-dup', 'tok-dup'],
        60_000,
        'A',
      );
      release();
    });
  });

  describe('cross-sender lock sharing (the H1 invariant)', () => {
    it('lock acquired via "instant" path is honored by an "conservative" caller and vice versa', async () => {
      // Audit #333 H1 specifically calls out the instant-vs-conservative
      // cross-pair race. The shared module guarantees both senders
      // serialize on the SAME map regardless of caller label.
      const order: string[] = [];

      const releaseInstant = await acquireSourceLocks(
        ['tok-cross'],
        60_000,
        'sendInstantUxf',
      );
      order.push('instant-acquired');

      const conservativePromise = (async () => {
        const release = await acquireSourceLocks(
          ['tok-cross'],
          60_000,
          'sendConservativeUxf',
        );
        order.push('conservative-acquired');
        release();
      })();

      await new Promise((r) => setTimeout(r, 10));
      // Conservative MUST be blocked by the instant lock.
      expect(order).toEqual(['instant-acquired']);

      releaseInstant();
      await conservativePromise;
      expect(order).toEqual(['instant-acquired', 'conservative-acquired']);
    });
  });

  describe('__resetSourceLocksForTesting back-compat re-export', () => {
    it('the symbol exported from instant-sender is the SAME function as the shared module', () => {
      // Tests existing before this refactor import the reset hook from
      // instant-sender. Keep that path working with a re-export.
      expect(__resetFromInstantSender).toBe(__resetSourceLocksForTesting);
    });

    it('clears in-flight locks regardless of which entry-point path called acquireSourceLocks', async () => {
      // Acquire a never-released lock via the shared module.
      await acquireSourceLocks(['tok-reset-test'], 60_000, 'A');
      // Re-export reset clears it.
      __resetFromInstantSender();
      // A second acquire on the same id proceeds immediately.
      const start = Date.now();
      const release = await acquireSourceLocks(['tok-reset-test'], 60_000, 'B');
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(100);
      release();
    });

    it('refuses to clear locks outside test environments (fail-closed guard preserved)', () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalAllowReset = process.env.SPHERE_ALLOW_TEST_RESET;
      try {
        process.env.NODE_ENV = 'production';
        process.env.SPHERE_ALLOW_TEST_RESET = undefined as unknown as string;
        delete process.env.SPHERE_ALLOW_TEST_RESET;
        expect(() => __resetSourceLocksForTesting()).toThrow(
          /only available in test environments/,
        );
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        if (originalAllowReset !== undefined) {
          process.env.SPHERE_ALLOW_TEST_RESET = originalAllowReset;
        }
      }
    });
  });

  describe('force-release liveness floor', () => {
    it('a lock held longer than maxHoldMs is force-released so future acquirers can proceed', async () => {
      // Acquire with a tiny max-hold to exercise the timer.
      await acquireSourceLocks(['tok-liveness'], 30, 'A');
      // Wait longer than the timeout so the force-release fires.
      await new Promise((r) => setTimeout(r, 80));

      // B should acquire immediately — the force-release evicted A's lock.
      const start = Date.now();
      const release = await acquireSourceLocks(['tok-liveness'], 60_000, 'B');
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(50);
      release();
    });
  });
});
