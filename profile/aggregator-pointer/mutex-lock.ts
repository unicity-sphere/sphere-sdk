/**
 * Cross-context publish mutex (T-B3, T-B4, T-B4b).
 *
 * Provides exclusive mutual exclusion for the pointer-publish critical section
 * across concurrent contexts:
 *
 *   Browser:  Web Locks API (cross-tab)
 *   Node.js:  proper-lockfile (cross-process) stacked with async-mutex (in-process / worker_threads)
 *
 * Acquisition order (R-18, LIFO release):
 *   1. async-mutex Mutex  — in-process/worker_threads (Node only)
 *   2. proper-lockfile    — cross-process (Node only)
 *
 * Release order is LIFO: file lock released first, then in-process Mutex.
 *
 * SPEC §7.1.1, R-17, R-18.
 */

import { AggregatorPointerError, AggregatorPointerErrorCode } from './errors.js';

export interface MutexAcquireOptions {
  /** Max ms to wait for lock before raising PUBLISH_BUSY. Default: 30000. */
  timeoutMs?: number;
}

export interface MutexHandle {
  release(): Promise<void>;
}

export interface PointerMutex {
  acquire(opts?: MutexAcquireOptions): Promise<MutexHandle>;
}

// ── Runtime detection ──────────────────────────────────────────────────────

function isBrowser(): boolean {
  return typeof globalThis.navigator !== 'undefined' && typeof globalThis.window !== 'undefined';
}

function isNode(): boolean {
  return typeof process !== 'undefined' && process.versions?.node != null;
}

// ── Browser: Web Locks API ─────────────────────────────────────────────────

class BrowserMutex implements PointerMutex {
  readonly #lockName: string;

  constructor(lockName: string) {
    if (typeof navigator?.locks?.request !== 'function') {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.UNSUPPORTED_RUNTIME,
        'Web Locks API unavailable — cross-tab mutual exclusion for pointer publish is not supported in this browser.',
      );
    }
    this.#lockName = lockName;
  }

  async acquire(opts?: MutexAcquireOptions): Promise<MutexHandle> {
    const timeoutMs = opts?.timeoutMs ?? 30_000;

    return new Promise<MutexHandle>((resolve, reject) => {
      let released = false;
      let releaseCallback: (() => void) | null = null;

      const releasePromise = new Promise<void>((res) => {
        releaseCallback = res;
      });

      const timer = setTimeout(() => {
        if (!released) {
          reject(
            new AggregatorPointerError(
              AggregatorPointerErrorCode.PUBLISH_BUSY,
              `Web Locks mutex "${this.#lockName}" not acquired within ${timeoutMs}ms.`,
            ),
          );
        }
      }, timeoutMs);

      navigator.locks
        .request(this.#lockName, { mode: 'exclusive' }, async (_lock) => {
          clearTimeout(timer);
          if (released) return; // timed-out caller already rejected
          resolve({
            release: async () => {
              released = true;
              releaseCallback!();
            },
          });
          // Keep the lock held until release() is called.
          await releasePromise;
        })
        .catch((err: unknown) => {
          clearTimeout(timer);
          reject(
            new AggregatorPointerError(
              AggregatorPointerErrorCode.UNSUPPORTED_RUNTIME,
              `Web Locks request failed: ${String(err)}`,
              undefined,
              { cause: err },
            ),
          );
        });
    });
  }
}

// ── Node.js: proper-lockfile + async-mutex ─────────────────────────────────

/** Injectable lock primitives — used in tests to spy on acquisition order (R-18). */
export interface NodeLockPrimitives {
  acquireInProcess(): Promise<() => void>;
  acquireFileLock(path: string, staleMs: number): Promise<() => Promise<void>>;
}

async function defaultNodeLockPrimitives(lockFilePath: string): Promise<NodeLockPrimitives> {
  const { Mutex } = await import('async-mutex');
  const mutex = new Mutex();
  return {
    acquireInProcess: () => mutex.acquire(),
    acquireFileLock: async (p: string, staleMs: number) => {
      const lockfile = await import('proper-lockfile');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(p, '', { flag: 'a' });
      return lockfile.lock(p, { stale: staleMs, realpath: false, retries: { retries: 0 } });
    },
  };
}

class NodeMutex implements PointerMutex {
  readonly #lockFilePath: string;
  #primitives: NodeLockPrimitives | null = null;

  constructor(lockFilePath: string) {
    this.#lockFilePath = lockFilePath;
  }

  async #getPrimitives(): Promise<NodeLockPrimitives> {
    if (!this.#primitives) {
      this.#primitives = await defaultNodeLockPrimitives(this.#lockFilePath);
    }
    return this.#primitives;
  }

  /** For testing only: inject spy-instrumented primitives. */
  _injectPrimitives(primitives: NodeLockPrimitives): void {
    this.#primitives = primitives;
  }

  async acquire(opts?: MutexAcquireOptions): Promise<MutexHandle> {
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const prim = await this.#getPrimitives();

    // Step 1: acquire in-process mutex (R-18: always first).
    let inProcessRelease: (() => void) | null = null;
    const inProcessTimeout = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new AggregatorPointerError(
              AggregatorPointerErrorCode.PUBLISH_BUSY,
              `In-process mutex for "${this.#lockFilePath}" not acquired within ${timeoutMs}ms.`,
            ),
          ),
        timeoutMs,
      ),
    );

    inProcessRelease = await Promise.race([prim.acquireInProcess(), inProcessTimeout]);

    // Step 2: acquire file lock (cross-process).
    const deadline = Date.now() + timeoutMs;
    const retryMs = 250;
    let fileLockRelease: (() => Promise<void>) | null = null;

    while (true) {
      try {
        fileLockRelease = await prim.acquireFileLock(this.#lockFilePath, 8000);
        break;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ELOCKED') {
          if (Date.now() + retryMs > deadline) {
            inProcessRelease!();
            throw new AggregatorPointerError(
              AggregatorPointerErrorCode.PUBLISH_BUSY,
              `File lock "${this.#lockFilePath}" held by another process; timed out after ${timeoutMs}ms.`,
            );
          }
          await new Promise((res) => setTimeout(res, retryMs));
          continue;
        }
        inProcessRelease!();
        throw new AggregatorPointerError(
          AggregatorPointerErrorCode.UNSUPPORTED_RUNTIME,
          `Failed to acquire file lock "${this.#lockFilePath}": ${String(err)}`,
          undefined,
          { cause: err },
        );
      }
    }

    return {
      release: async () => {
        // LIFO: file lock first, then in-process mutex.
        try {
          await fileLockRelease!();
        } finally {
          inProcessRelease!();
        }
      },
    };
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

export interface MutexFactoryOptions {
  /**
   * Node.js only: absolute path to the lock file.
   * Required when running in Node.js; ignored in browser.
   */
  lockFilePath?: string;
}

/**
 * Create a platform-appropriate publish mutex.
 *
 * - Browser: Web Locks API (key = lockName)
 * - Node.js:  async-mutex + proper-lockfile (path = lockFilePath)
 *
 * Throws AGGREGATOR_POINTER_UNSUPPORTED_RUNTIME when:
 *   - Browser but Web Locks API is unavailable
 *   - Node.js but lockFilePath not supplied
 */
export function createPointerMutex(
  lockName: string,
  opts?: MutexFactoryOptions,
): PointerMutex {
  if (isBrowser()) {
    return new BrowserMutex(lockName);
  }
  if (isNode()) {
    const lockFilePath = opts?.lockFilePath;
    if (!lockFilePath) {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.UNSUPPORTED_RUNTIME,
        'Node.js pointer mutex requires lockFilePath (e.g. <dataDir>/profile/<pubkey>/publish.lock).',
      );
    }
    return new NodeMutex(lockFilePath);
  }
  throw new AggregatorPointerError(
    AggregatorPointerErrorCode.UNSUPPORTED_RUNTIME,
    'Unknown runtime — cannot create pointer publish mutex.',
  );
}
