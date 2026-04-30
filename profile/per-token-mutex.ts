/**
 * Per-tokenId mutex — UXF Transfer Protocol §5.5 step 9.
 *
 * Serializes finalization / ingest paths against the same `tokenId` across
 * the worker pool. The protocol allows three strategies for the
 * lock-vs-RPC tension; this module implements all three so T.5.C can
 * select via config (W34):
 *
 * 1. **`'cas'` (preferred)** — no global lock is held. Each transition
 *    is a compare-and-swap on the manifest entry's content hash (see
 *    `profile/manifest-cas.ts`). Worker calls into `acquire` here only
 *    for inflight tracking / telemetry; `fn` runs immediately.
 *    Conflicts surface inside `fn` as CAS failure → `fn` retries from
 *    the latest state.
 *
 * 2. **`'rpc-release'`** — the worker acquires the per-tokenId lock,
 *    snapshots state, releases the lock before issuing slow RPCs (e.g.
 *    `oracle.isSpent()`), then re-acquires the lock and verifies the
 *    manifest content hash is unchanged before applying the post-RPC
 *    transition. This module enforces the **per-tokenId serialization**
 *    around `fn` end-to-end; the RPC-release dance is the responsibility
 *    of `fn` itself (it can call back into a CAS or into a separate
 *    `acquire` for the post-RPC transition).
 *
 * 3. **`'bounded-hold'`** — strict in-process mutex with a hard
 *    `MAX_LOCK_HOLD_MS` (default 5000) timeout. If `fn` runs longer
 *    than the bound, the acquire rejects with `LOCK_BOUNDED_HOLD_FIRED`
 *    AND the lock is released so the next caller may proceed. This is
 *    the fallback for implementations that cannot use CAS or
 *    rpc-release.
 *
 * **Per-instance scoping**: holds an instance-scoped `Map<tokenId, Promise>`
 * for inflight tracking. Destroying the `PerTokenMutex` instance drops
 * the map entirely — no module-level state.
 *
 * **Worker-pool safety**: in single-threaded JS the `Map` reads/writes
 * are inherently serialized by the event loop, so no additional
 * synchronization is required across "concurrent" callers.
 */

import { SphereError } from '../core/errors';

/**
 * Default upper bound on lock-hold time for the `'bounded-hold'` strategy.
 * Per §5.5 step 9: 5000 ms. The `MAX_LOCK_HOLD_MS` default must not race
 * with realistic aggregator latencies under load — make it configurable
 * (via `acquire`'s `timeoutMs`) and document the trade-off.
 */
export const MAX_LOCK_HOLD_MS = 5000;

/** Mutex strategy selector. */
export type PerTokenMutexStrategy = 'cas' | 'rpc-release' | 'bounded-hold';

export interface PerTokenMutexOptions {
  /** Which §5.5 step 9 strategy to use for this acquire. */
  readonly strategy: PerTokenMutexStrategy;
  /** Override for `'bounded-hold'` strategy only. Ignored otherwise.
   *  Defaults to `MAX_LOCK_HOLD_MS`. */
  readonly timeoutMs?: number;
}

/**
 * In-process per-tokenId mutex. One instance per `Sphere` (or per
 * subsystem within a `Sphere` — multiple instances are independent).
 */
export class PerTokenMutex {
  /** Per-tokenId chain of in-flight promises. Whenever an `'rpc-release'`
   *  or `'bounded-hold'` acquire begins, the new fn's bookkeeping promise
   *  replaces the entry; the next acquire awaits the previous one. */
  private readonly inflight = new Map<string, Promise<unknown>>();

  /**
   * Acquire the per-tokenId mutex for `tokenId`, run `fn`, release.
   *
   * Behaviour by strategy:
   * - `'cas'`: pure pass-through. `fn` is invoked immediately; inflight
   *   bookkeeping is updated for telemetry but does NOT serialize. The
   *   actual exclusion comes from `ManifestCas` inside `fn`.
   * - `'rpc-release'` and `'bounded-hold'`: serialize per-tokenId. If a
   *   prior acquire on the same `tokenId` is still running, this one
   *   awaits it (regardless of whether the prior settled with success or
   *   error — errors do not block successors). Different `tokenId`s
   *   never block each other.
   * - `'bounded-hold'` additionally races `fn`'s completion against a
   *   timeout; on timeout, the lock is released immediately and
   *   `LOCK_BOUNDED_HOLD_FIRED` is thrown.
   *
   * **`'bounded-hold'` cancellation contract**: when the timeout fires,
   * the original `fn()` continues running in the background and the
   * NEXT caller acquires the lock. `fn` MUST therefore be cancellation-
   * aware (e.g. honour an injected `AbortSignal`) OR idempotent under
   * overlap, otherwise two concurrent `fn` bodies may execute against
   * the same `tokenId`. The CAS-based path (default for §5.5 step 9)
   * sidesteps this concern entirely.
   *
   * @returns `fn`'s resolved value, OR rejects with whatever `fn`
   *   rejected with (or `LOCK_BOUNDED_HOLD_FIRED` for the bounded-hold
   *   timeout case).
   */
  async acquire<T>(
    tokenId: string,
    fn: () => Promise<T>,
    options: PerTokenMutexOptions,
  ): Promise<T> {
    if (options.strategy === 'cas') {
      // CAS strategy: pure pass-through. No serialization — concurrent
      // CAS acquires for the same tokenId run in parallel; mutual
      // exclusion comes from `ManifestCas` inside `fn`. We deliberately
      // skip inflight bookkeeping here so that a concurrent rpc-release
      // chain on the same tokenId is not corrupted.
      return fn();
    }

    // Serialized strategies: rpc-release and bounded-hold both require
    // per-tokenId exclusion. Chain after any in-flight acquire for the
    // same tokenId.
    const prior = this.inflight.get(tokenId);

    // Resolver-based promise so we can install it BEFORE awaiting prior.
    let releaseLock!: () => void;
    const ourSlot = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.inflight.set(tokenId, ourSlot);

    try {
      if (prior !== undefined) {
        // Wait for prior acquire to settle. Suppress its errors — they
        // do not propagate to successors; each acquire's caller sees
        // only its own fn's outcome.
        await prior.catch(() => undefined);
      }

      if (options.strategy === 'rpc-release') {
        return await fn();
      }

      // 'bounded-hold': race fn against a timeout. On timeout we throw
      // LOCK_BOUNDED_HOLD_FIRED; the lock is released in the finally
      // below either way.
      const timeoutMs = options.timeoutMs ?? MAX_LOCK_HOLD_MS;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new SphereError(
          `PerTokenMutex 'bounded-hold' timeoutMs must be a positive finite number; got ${String(timeoutMs)}`,
          'VALIDATION_ERROR',
        );
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new SphereError(
                `PerTokenMutex 'bounded-hold' fired: tokenId=${tokenId} exceeded ${timeoutMs}ms (W35)`,
                'LOCK_BOUNDED_HOLD_FIRED',
              ),
            );
          }, timeoutMs);
        });
        // Race fn vs timeout. Whichever settles first wins.
        return await Promise.race([fn(), timeoutPromise]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } finally {
      // Release: clear the inflight slot if it's still ours, then resolve
      // the lock so successors may proceed. Order matters — successors
      // awaiting `prior` must see the slot already cleared (so they don't
      // chase a stale promise).
      if (this.inflight.get(tokenId) === ourSlot) {
        this.inflight.delete(tokenId);
      }
      releaseLock();
    }
  }

  /**
   * Diagnostic / test-only: returns true if any acquire is currently
   * in-flight for `tokenId`. Not a synchronization primitive — do not
   * use for control flow.
   */
  isLocked(tokenId: string): boolean {
    return this.inflight.has(tokenId);
  }

  /**
   * Diagnostic / test-only: count of active locks. Useful in tests to
   * confirm cleanup after errors.
   */
  size(): number {
    return this.inflight.size;
  }
}
