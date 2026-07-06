/**
 * OrbitDB write fairness queue (T.5.B.0.5).
 *
 * Bounds concurrent in-flight OrbitDB writes to a configurable cap so the
 * sender (T.5.B) and recipient (T.5.C) finalization-worker pools cannot
 * saturate OrbitDB's write path and starve replication merges. Internally
 * this is a plain async semaphore with FIFO waiter ordering — round-robin
 * across pending writers. Released slots are handed to the oldest queued
 * waiter, so no writer is starved by a steady stream of fresh acquires.
 *
 * **Per-instance scoping**: the queue holds NO module-level state. Each
 * `Sphere` instance constructs its own `OrbitDbWriteFairness`, so destroy-
 * recreate cycles do not bleed slot accounting across wallet incarnations,
 * and unit tests can compose multiple independent instances without
 * cross-contamination.
 *
 * **Spec / ADR**: `docs/uxf/ADR-005-orbitdb-write-fairness.md`.
 *
 * @packageDocumentation
 */

import { MAX_CONCURRENT_ORBITDB_WRITES } from '../pipeline/limits';

/**
 * Snapshot of fairness-queue activity for telemetry / load-test gates.
 *
 * Consumers (e.g. T.8.E.1's load test) sample this periodically; if
 * `waitQueueDepth / maxConcurrent > 0.5` is sustained, ADR-005's revisit
 * criteria fires.
 */
export interface OrbitDbWriteFairnessMetrics {
  /** Number of writers currently holding a slot. `0..maxConcurrent`. */
  readonly inflightCount: number;
  /** Number of writers parked in the FIFO wait queue. */
  readonly waitQueueDepth: number;
}

/**
 * Bounded-concurrency fairness primitive for OrbitDB writes.
 *
 * Two-call API (`acquire`/`release`) for callers that need explicit
 * lifetime control, plus a `run` convenience that releases on both
 * resolve and reject paths via try/finally.
 */
export class OrbitDbWriteFairness {
  private readonly maxConcurrent: number;
  private inflightCount = 0;
  private readonly waitQueue: Array<() => void> = [];

  /**
   * @param maxConcurrent Maximum concurrent in-flight writes. Defaults
   *   to {@link MAX_CONCURRENT_ORBITDB_WRITES}. Must be `>= 1`.
   */
  constructor(maxConcurrent: number = MAX_CONCURRENT_ORBITDB_WRITES) {
    if (!Number.isFinite(maxConcurrent) || maxConcurrent < 1) {
      throw new Error(
        `OrbitDbWriteFairness: maxConcurrent must be >= 1, got ${maxConcurrent}`,
      );
    }
    this.maxConcurrent = Math.floor(maxConcurrent);
  }

  /**
   * Acquire a write slot. Resolves immediately if `inflightCount <
   * maxConcurrent`; otherwise parks the caller in FIFO order until a
   * `release()` frees a slot.
   *
   * Callers MUST pair every successful `acquire()` with exactly one
   * `release()` (use `run` to do this automatically).
   */
  async acquire(): Promise<void> {
    if (this.inflightCount < this.maxConcurrent) {
      this.inflightCount += 1;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  /**
   * Release a previously-acquired write slot. If any writers are parked
   * in the wait queue, the oldest is woken (FIFO / round-robin) and
   * inherits the slot directly — `inflightCount` does not transiently
   * dip, so a flood of concurrent acquires cannot starve queued waiters.
   *
   * Calling `release()` without a matching `acquire()` is a programmer
   * error; we do not guard against it (the cost of tracking owner
   * identity is not justified for an internal primitive).
   */
  release(): void {
    const next = this.waitQueue.shift();
    if (next !== undefined) {
      // Hand the slot directly to the next waiter — keep inflightCount
      // stable so a fresh acquire() racing with this release cannot
      // jump the queue.
      next();
      return;
    }
    this.inflightCount -= 1;
  }

  /**
   * Convenience wrapper: acquire, run `fn`, release on both success and
   * failure paths via try/finally.
   *
   * @param fn The async work to execute under a fairness slot.
   * @returns The value resolved by `fn`.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Read current activity for telemetry. Snapshot is consistent within
   * a single synchronous tick; concurrent acquires/releases between
   * sampling and reaction are inherent to a non-locked observer.
   */
  getMetrics(): OrbitDbWriteFairnessMetrics {
    return {
      inflightCount: this.inflightCount,
      waitQueueDepth: this.waitQueue.length,
    };
  }
}
