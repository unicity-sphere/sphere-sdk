/**
 * Cross-context publish mutex (T-B3, T-B4, T-B4b, T-B8).
 *
 * Tests:
 *   - Browser: Web Locks API stub (cross-tab simulation)
 *   - Node.js: proper-lockfile (cross-process sim via sequential acquires)
 *   - in-process: async-mutex layer (worker_threads contention sim)
 *   - Lock-order spy: in-process Mutex acquired BEFORE file lock (R-18)
 *   - LIFO release: file lock released first, then in-process Mutex (R-18)
 *   - PUBLISH_BUSY raised correctly on timeout
 *   - UNSUPPORTED_RUNTIME when lockFilePath not supplied in Node
 *
 * SPEC §7.1.1, R-17, R-18.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createPointerMutex, AggregatorPointerErrorCode } from '../../../../extensions/uxf/profile/aggregator-pointer/index.js';
import type { NodeLockPrimitives } from '../../../../extensions/uxf/profile/aggregator-pointer/index.js';

// ── Node.js mutex tests ────────────────────────────────────────────────────

describe('createPointerMutex — Node.js (T-B4, T-B4b)', () => {
  let tmpDir: string;
  let lockFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pointer-mutex-test-'));
    lockFile = path.join(tmpDir, 'publish.lock');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates a mutex without throwing', () => {
    expect(() => createPointerMutex('test-key', { lockFilePath: lockFile })).not.toThrow();
  });

  it('throws UNSUPPORTED_RUNTIME when lockFilePath is omitted in Node', () => {
    expect(() => createPointerMutex('test-key')).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.UNSUPPORTED_RUNTIME }),
    );
  });

  it('acquire + release completes without error', async () => {
    const mutex = createPointerMutex('test-key', { lockFilePath: lockFile });
    const handle = await mutex.acquire({ timeoutMs: 5000 });
    await handle.release();
  });

  it('sequential acquires do not deadlock', async () => {
    const mutex = createPointerMutex('test-key', { lockFilePath: lockFile });
    const h1 = await mutex.acquire({ timeoutMs: 5000 });
    await h1.release();
    const h2 = await mutex.acquire({ timeoutMs: 5000 });
    await h2.release();
  });

  it('concurrent acquires: only one succeeds at a time (mutual exclusion)', async () => {
    const mutex = createPointerMutex('test-key', { lockFilePath: lockFile });
    const events: string[] = [];

    const task = async (id: string) => {
      const handle = await mutex.acquire({ timeoutMs: 10_000 });
      events.push(`${id}:enter`);
      // Simulate some work under the lock.
      await new Promise((r) => setTimeout(r, 20));
      events.push(`${id}:exit`);
      await handle.release();
    };

    await Promise.all([task('A'), task('B'), task('C')]);

    // Verify no interleaving: each enter is immediately followed by its exit.
    for (let i = 0; i < events.length; i += 2) {
      const id = events[i].split(':')[0];
      expect(events[i]).toBe(`${id}:enter`);
      expect(events[i + 1]).toBe(`${id}:exit`);
    }
    expect(events.length).toBe(6);
  });

  it('PUBLISH_BUSY on timeout when lock is held', async () => {
    const mutex = createPointerMutex('test-key', { lockFilePath: lockFile });

    const h1 = await mutex.acquire({ timeoutMs: 5000 });

    // Second acquire with very short timeout should fail with PUBLISH_BUSY.
    await expect(mutex.acquire({ timeoutMs: 100 })).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.PUBLISH_BUSY,
    });

    await h1.release();
  }, 10_000);

  it('lock-order spy: in-process Mutex acquired BEFORE file lock (R-18)', async () => {
    const acquisitionOrder: string[] = [];

    // Build injectable spy primitives (avoids non-writable module exports).
    const { Mutex } = await import('async-mutex');
    const realMutex = new Mutex();

    const spyPrimitives: NodeLockPrimitives = {
      acquireInProcess: async () => {
        acquisitionOrder.push('in-process-start');
        const release = await realMutex.acquire();
        acquisitionOrder.push('in-process-acquired');
        return () => {
          acquisitionOrder.push('in-process-released');
          release();
        };
      },
      acquireFileLock: async (_path: string, _staleMs: number) => {
        acquisitionOrder.push('file-lock-start');
        acquisitionOrder.push('file-lock-acquired');
        return async () => {
          acquisitionOrder.push('file-lock-released');
        };
      },
    };

    const mutex = createPointerMutex('order-test', { lockFilePath: lockFile });
    // Access the internal NodeMutex instance to inject spy primitives.
    (mutex as unknown as { _injectPrimitives(p: NodeLockPrimitives): void })._injectPrimitives(
      spyPrimitives,
    );

    const handle = await mutex.acquire({ timeoutMs: 5000 });
    await handle.release();

    // Verify R-18 ordering.
    const inProcessStart = acquisitionOrder.indexOf('in-process-start');
    const fileLockStart = acquisitionOrder.indexOf('file-lock-start');
    const fileLockReleased = acquisitionOrder.indexOf('file-lock-released');
    const inProcessReleased = acquisitionOrder.indexOf('in-process-released');

    // in-process MUST be started (and acquired) before file lock starts.
    expect(inProcessStart).toBeLessThan(fileLockStart);
    expect(acquisitionOrder.indexOf('in-process-acquired')).toBeLessThan(fileLockStart);

    // LIFO: file lock released BEFORE in-process mutex.
    expect(fileLockReleased).toBeLessThan(inProcessReleased);
  }, 10_000);
});

// ── Browser mutex tests ────────────────────────────────────────────────────

describe('createPointerMutex — browser stub (T-B3)', () => {
  const origNavigator = globalThis.navigator;
  const origWindow = globalThis.window;

  beforeEach(() => {
    // Install minimal browser globals.
    const locks = new BrowserLocksStub();
    Object.defineProperty(globalThis, 'navigator', {
      value: { locks },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      value: {},
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: origNavigator,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      value: origWindow,
      writable: true,
      configurable: true,
    });
  });

  it('acquire + release completes in browser stub', async () => {
    const mutex = createPointerMutex('browser-key');
    const handle = await mutex.acquire({ timeoutMs: 2000 });
    await handle.release();
  });

  it('sequential browser acquires do not deadlock', async () => {
    const mutex = createPointerMutex('browser-key');
    const h1 = await mutex.acquire({ timeoutMs: 2000 });
    await h1.release();
    const h2 = await mutex.acquire({ timeoutMs: 2000 });
    await h2.release();
  });

  it('concurrent browser acquires: mutual exclusion enforced', async () => {
    const mutex = createPointerMutex('browser-key');
    const events: string[] = [];

    const task = async (id: string) => {
      const handle = await mutex.acquire({ timeoutMs: 10_000 });
      events.push(`${id}:enter`);
      await new Promise((r) => setTimeout(r, 10));
      events.push(`${id}:exit`);
      await handle.release();
    };

    await Promise.all([task('X'), task('Y')]);

    for (let i = 0; i < events.length; i += 2) {
      const id = events[i].split(':')[0];
      expect(events[i]).toBe(`${id}:enter`);
      expect(events[i + 1]).toBe(`${id}:exit`);
    }
  });
});

// ── Minimal Web Locks API stub ─────────────────────────────────────────────

class BrowserLocksStub {
  private _queue: Array<() => void> = [];
  private _held = false;

  request(
    _name: string,
    _options: { mode: string },
    callback: (lock: unknown) => Promise<void>,
  ): Promise<void> {
    return new Promise((resolve) => {
      const attempt = async () => {
        if (this._held) {
          this._queue.push(attempt);
          return;
        }
        this._held = true;
        await callback({});
        this._held = false;
        const next = this._queue.shift();
        if (next) next();
        resolve();
      };
      void attempt();
    });
  }
}
