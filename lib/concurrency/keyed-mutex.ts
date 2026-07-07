/**
 * lib/concurrency/keyed-mutex — per-key serialization primitive.
 *
 * Generalizes the profile per-token-mutex pattern (extensions/uxf/profile/
 * per-token-mutex.ts) into a reusable primitive keyed on any string. Used
 * across payments (SpendQueue-per-token), accounting (withInvoiceGate),
 * swap (withSwapGate).
 */

export class KeyedMutex {
  private readonly locks = new Map<string, Promise<unknown>>();

  /**
   * Run `fn` serialized against other calls with the same `key`. Callers with
   * different keys run concurrently.
   */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, prior.then(() => next));
    try {
      await prior;
      const result = await fn();
      return result;
    } finally {
      release();
      // Clean up if we're still the tail — avoids the map growing without bound.
      queueMicrotask(() => {
        if (this.locks.get(key) === next) {
          this.locks.delete(key);
        }
      });
    }
  }

  /** Return true if `key` currently has a pending lock. */
  isLocked(key: string): boolean {
    return this.locks.has(key);
  }

  /** Best-effort drain — for tests / shutdown. */
  async drain(): Promise<void> {
    const pending = Array.from(this.locks.values());
    await Promise.allSettled(pending);
  }
}
