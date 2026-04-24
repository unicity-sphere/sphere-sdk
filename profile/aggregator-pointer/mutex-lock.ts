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
  /**
   * Steelman remediation (BFCache / tab-discard race): verify the
   * underlying lock is still held by this handle. Browser Web Locks
   * may be lost when the tab is frozen (BFCache) or discarded for
   * memory reclaim; the page may then resume from BFCache and try
   * to continue publishing at a stale version — violating the
   * mutual-exclusion contract other tabs rely on. Callers SHOULD
   * invoke `assertHeld()` before each commit-side network submit
   * so lost-lock resumes fail closed with PUBLISH_BUSY.
   *
   * Throws AggregatorPointerError(PUBLISH_BUSY) if the lock is no
   * longer held. Returns normally otherwise.
   */
  assertHeld(): void;
}

export interface PointerMutex {
  acquire(opts?: MutexAcquireOptions): Promise<MutexHandle>;
}

// ── Runtime detection ──────────────────────────────────────────────────────

function isBrowser(): boolean {
  return (
    typeof globalThis.navigator !== 'undefined' &&
    typeof globalThis.window !== 'undefined' &&
    // Exclude Electron renderer (needs file-based cross-process locking).
    !(typeof process !== 'undefined' && process.versions?.electron)
  );
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
      let timedOut = false;
      let released = false;
      let releaseCallback: (() => void) | null = null;

      const releasePromise = new Promise<void>((res) => {
        releaseCallback = res;
      });

      const timer = setTimeout(() => {
        timedOut = true;
        reject(
          new AggregatorPointerError(
            AggregatorPointerErrorCode.PUBLISH_BUSY,
            `Web Locks mutex "${this.#lockName}" not acquired within ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);

      navigator.locks
        .request(this.#lockName, { mode: 'exclusive' }, async (_lock) => {
          clearTimeout(timer);
          if (timedOut) {
            // Lock granted AFTER caller already timed out — release immediately
            // to prevent the lock from being held forever (zombie lock).
            releaseCallback!();
            return;
          }
          let alreadyReleased = false;
          // Steelman remediation: listen for page-lifecycle events that
          // may release the Web Lock out from under us (BFCache freeze,
          // tab discard for memory reclaim, page unload). Flip a local
          // validity flag; assertHeld() then fails closed.
          let lockStillValid = true;
          const invalidate = (): void => {
            lockStillValid = false;
          };
          const win = typeof globalThis.window !== 'undefined' ? globalThis.window : undefined;
          const hasListeners = typeof win?.addEventListener === 'function' && typeof win?.removeEventListener === 'function';
          if (hasListeners) {
            win!.addEventListener('freeze', invalidate);
            win!.addEventListener('pagehide', invalidate);
          }
          const lockName = this.#lockName;
          resolve({
            release: async () => {
              if (alreadyReleased) return;
              alreadyReleased = true;
              released = true;
              if (hasListeners) {
                win!.removeEventListener('freeze', invalidate);
                win!.removeEventListener('pagehide', invalidate);
              }
              releaseCallback!();
            },
            assertHeld: () => {
              if (!lockStillValid || alreadyReleased) {
                throw new AggregatorPointerError(
                  AggregatorPointerErrorCode.PUBLISH_BUSY,
                  `Web Locks mutex "${lockName}" was lost (BFCache/freeze/discard). ` +
                    `Aborting to avoid submitting at a stale version after lock loss.`,
                );
              }
            },
          });
          // Hold the lock until release() is called.
          await releasePromise;
          void released; // silence unused warning
        })
        .catch((err: unknown) => {
          clearTimeout(timer);
          if (!timedOut) {
            reject(
              new AggregatorPointerError(
                AggregatorPointerErrorCode.UNSUPPORTED_RUNTIME,
                `Web Locks request failed: ${String(err)}`,
                undefined,
                { cause: err },
              ),
            );
          }
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
  #primitivesInitialized = false;

  constructor(lockFilePath: string) {
    this.#lockFilePath = lockFilePath;
  }

  async #getPrimitives(): Promise<NodeLockPrimitives> {
    if (!this.#primitives) {
      this.#primitives = await defaultNodeLockPrimitives(this.#lockFilePath);
      this.#primitivesInitialized = true;
    }
    return this.#primitives;
  }

  /**
   * For testing only: inject spy-instrumented primitives.
   * MUST be called before the first acquire(); throws if called after.
   */
  _injectPrimitives(primitives: NodeLockPrimitives): void {
    if (this.#primitivesInitialized) {
      throw new Error(
        '_injectPrimitives may not be called after the first acquire() — ' +
          'replacing primitives mid-flight would break mutual exclusion.',
      );
    }
    this.#primitives = primitives;
    this.#primitivesInitialized = true;
  }

  async acquire(opts?: MutexAcquireOptions): Promise<MutexHandle> {
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const prim = await this.#getPrimitives();

    // Single deadline for the entire acquire (Step 1 + Step 2 combined).
    // Computing it here prevents deadline doubling where Step 1 consumes
    // nearly all of timeoutMs and Step 2 then gets a fresh budget.
    const deadline = Date.now() + timeoutMs;

    // Step 1: acquire in-process mutex (R-18: always first).
    //
    // Orphan prevention: if the timeout fires before acquireInProcess resolves,
    // we must still release the lock when it eventually resolves — otherwise
    // async-mutex is permanently stuck for this process.
    let timedOut = false;
    let inProcessRelease: (() => void) | null = null;

    const inProcessAcquirePromise = prim.acquireInProcess();

    // Safety handler: release lock on late resolution after timeout.
    void inProcessAcquirePromise.then((release) => {
      if (timedOut) {
        try { release(); } catch { /* noop — async-mutex release on abandoned lock */ }
      }
    });

    const inProcessTimer = setTimeout(() => { timedOut = true; }, timeoutMs);

    // Save the inner timer handle so it can be cleared if the acquire wins
    // the race — prevents an unhandled rejection in --unhandled-rejections=strict.
    let inProcessTimeoutHandle!: ReturnType<typeof setTimeout>;
    const inProcessTimeout = new Promise<never>((_, reject) => {
      inProcessTimeoutHandle = setTimeout(
        () =>
          reject(
            new AggregatorPointerError(
              AggregatorPointerErrorCode.PUBLISH_BUSY,
              `In-process mutex for "${this.#lockFilePath}" not acquired within ${timeoutMs}ms.`,
            ),
          ),
        timeoutMs,
      );
    });
    // Suppress the unhandled rejection if the acquire wins the race.
    void inProcessTimeout.catch(() => {});

    try {
      inProcessRelease = await Promise.race([inProcessAcquirePromise, inProcessTimeout]);
    } catch (err) {
      clearTimeout(inProcessTimer);
      clearTimeout(inProcessTimeoutHandle);
      throw err;
    }
    clearTimeout(inProcessTimer);
    clearTimeout(inProcessTimeoutHandle);

    // Step 2: acquire file lock (cross-process).
    const retryMs = 250;
    let fileLockRelease: (() => Promise<void>) | null = null;

    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        inProcessRelease!();
        throw new AggregatorPointerError(
          AggregatorPointerErrorCode.PUBLISH_BUSY,
          `File lock "${this.#lockFilePath}" held by another process; timed out after ${timeoutMs}ms.`,
        );
      }
      try {
        fileLockRelease = await prim.acquireFileLock(this.#lockFilePath, 8000);
        break;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ELOCKED') {
          await new Promise((res) => setTimeout(res, Math.min(retryMs, deadline - Date.now())));
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

    let alreadyReleased = false;
    return {
      release: async () => {
        // Guard against double-release.
        if (alreadyReleased) return;
        alreadyReleased = true;
        // LIFO: file lock released first, then in-process mutex.
        try {
          await fileLockRelease!();
        } finally {
          if (typeof inProcessRelease === 'function') {
            try { inProcessRelease(); } catch { /* noop */ }
          }
        }
      },
      assertHeld: () => {
        // Node processes do not lose file locks transparently the way
        // browser BFCache can lose Web Locks; a released lock is
        // detectable only via the `alreadyReleased` flag. If the
        // process itself was killed, the handle is gone with it.
        if (alreadyReleased) {
          throw new AggregatorPointerError(
            AggregatorPointerErrorCode.PUBLISH_BUSY,
            'Node mutex handle already released; cannot proceed with submit.',
          );
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
 * - Electron renderer: treated as Node.js (file-based locking)
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
