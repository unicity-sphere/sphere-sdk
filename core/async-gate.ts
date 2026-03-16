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
    // Early check before registering the gate — prevents registering new gates
    // after destroy() has already snapshot the gate map for draining.
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
      result = await fn();
    };

    try {
      // Use .then(run, run) so fn executes even if prior gate op rejected
      await current.then(run, run);
      return result;
    } finally {
      resolve();
      // Clean up gate if it's still the last one (prevent memory leak).
      // Multi-waiter invariant: if A, B, C are queued, C's promise is the tail.
      // When A completes, A sees get(key) === C_next (set by C), so A skips deletion.
      // B also skips. Only C (the tail) deletes. This is correct.
      if (this.gates.get(key) === next) {
        this.gates.delete(key);
      }
    }
  }

  /**
   * Wait for all in-flight gate operations to complete.
   * Called during module destroy to drain pending work.
   */
  async drainAll(): Promise<void> {
    while (this.gates.size > 0) {
      await Promise.allSettled(Array.from(this.gates.values()));
    }
  }

  /** Number of active gates (for testing/monitoring). */
  get size(): number {
    return this.gates.size;
  }
}
