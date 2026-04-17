/**
 * Per-key async mutex. Serializes concurrent operations on the same key
 * while allowing operations on different keys to proceed in parallel.
 *
 * Used by both AccountingModule (per-invoice gates) and SwapModule (per-swap gates).
 *
 * Implementation: promise chain pattern. Each new operation for a key appends
 * to that key's chain. The chain entry is cleaned up after execution if it's
 * still the tail (prevents unbounded memory growth).
 */

import type { SphereErrorCode } from './errors.js';
import { SphereError } from './errors.js';

export class AsyncGateMap {
  private gates: Map<string, Promise<void>> = new Map();
  private executing: Set<string> = new Set();

  /**
   * Execute `fn` exclusively for the given key.
   * Operations on the same key are serialized (FIFO).
   * Operations on different keys run in parallel.
   *
   * @param key - The serialization key (e.g., invoiceId, swapId)
   * @param fn - The async function to execute
   * @param isDestroyed - Optional guard; if returns true, throws before executing
   * @param destroyedErrorCode - Error code to use when destroyed (default: 'MODULE_DESTROYED')
   */
  async withGate<T>(
    key: string,
    fn: () => Promise<T>,
    isDestroyed?: () => boolean,
    destroyedErrorCode: SphereErrorCode = 'MODULE_DESTROYED',
  ): Promise<T> {
    if (isDestroyed?.()) {
      throw new SphereError('Module has been destroyed.', destroyedErrorCode);
    }

    const current = this.gates.get(key) ?? Promise.resolve();
    let resolve!: () => void;
    const next = new Promise<void>((r) => {
      resolve = r;
    });
    this.gates.set(key, next);

    let result!: T;
    const run = async () => {
      if (isDestroyed?.()) {
        throw new SphereError('Module has been destroyed.', destroyedErrorCode);
      }
      if (this.executing.has(key)) {
        throw new SphereError(
          `Re-entrant gate access on key "${key}". This would deadlock.`,
          'REENTRANT_GATE',
        );
      }
      this.executing.add(key);
      try {
        result = await fn();
      } finally {
        this.executing.delete(key);
      }
    };

    try {
      await current.then(run, run);
      return result;
    } finally {
      resolve();
      if (this.gates.get(key) === next) {
        this.gates.delete(key);
      }
    }
  }

  /**
   * Wait for all in-flight gate operations to complete.
   * Called during module destroy to drain pending work.
   * @returns true if all gates drained, false if iteration limit was reached.
   */
  async drainAll(maxIterations = 100): Promise<boolean> {
    let iterations = 0;
    while (this.gates.size > 0 && iterations < maxIterations) {
      await Promise.allSettled(Array.from(this.gates.values()));
      iterations++;
    }
    return this.gates.size === 0;
  }

  /** Number of active gates (for testing/monitoring). */
  get size(): number {
    return this.gates.size;
  }
}
