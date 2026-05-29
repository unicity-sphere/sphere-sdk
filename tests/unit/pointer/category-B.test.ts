/**
 * Category-B conformance tests — crash-safety marker + mutex discipline.
 *
 * Scope (SPEC §7.1): these tests complement tests/unit/profile/pointer/
 * marker.test.ts and mutex.test.ts by focusing on the specific crash / atomicity
 * / cross-identity scenarios B1–B11 that are NOT covered in the baseline:
 *
 *   B1  — re-open after crash: writeMarker, drop the in-memory FlagStore, build
 *         a fresh store over the persisted KV bytes → readMarker still succeeds.
 *   B2  — writeMarker is idempotent under crash + retry with the same (v, CID).
 *   B3  — writeMarker then simulated crash before first use → later CID upgrade
 *         overwrites the previous marker record (no stale residue).
 *   B4  — clearMarker after a previously durable marker eliminates it across
 *         the crash boundary (fresh store sees null).
 *   B5  — clearMarker is idempotent: calling it when no marker is present is
 *         a no-op and does not corrupt siblings.
 *   B6  — MARKER_MAX_JUMP clamp: a marker proposing v = currentLocal + 1025
 *         raises MARKER_CORRUPT (§7.1.4 C1).
 *   B7  — §7.1.5 integrity: a marker whose cidHash is NOT 32 bytes
 *         (64 hex chars) raises MARKER_CORRUPT on read; ALL tamper vectors
 *         (uppercase hex, non-hex chars, wrong length, wrong type, v-type
 *         violation) are rejected.
 *   B8  — §7.1.6 atomicity: a partial marker record (missing cidHash /
 *         truncated JSON) raises MARKER_CORRUPT rather than parsing to an
 *         invalid object; no "half-written" value ever survives a read.
 *   B9  — Browser Web Locks mutex: acquire + release is strictly serialized
 *         across three contending waiters — no interleaving of critical
 *         sections, and a trailing acquire after all releases succeeds
 *         without hitting the late-resolve zombie-lock guard.
 *   B10 — Node mutex: spy-instrumented primitives demonstrate in-process
 *         async-mutex acquired BEFORE file lock and released AFTER — a
 *         crash between the two acquires releases everything previously held
 *         (tested by throwing from the file-lock acquire and asserting
 *         in-process was released).
 *   B11 — Identity switch (W5): distinct signingPubKey values produce distinct
 *         mutex keys AND distinct FlagStore prefixes, so a fresh mutex built
 *         for the new identity does not queue against the old one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  readMarker,
  writeMarker,
  clearMarker,
  resolvePublishVersion,
  FlagStore,
  DURABLE_STORAGE,
  AggregatorPointerErrorCode,
  MARKER_MAX_JUMP,
  createPointerMutex,
  type NodeLockPrimitives,
} from '../../../profile/aggregator-pointer/index.js';
import { mutexKey } from '../../../profile/aggregator-pointer/constants.js';

// ── Durable storage harness with crash simulation ─────────────────────────
//
// `makeKv()` returns a plain Map backing the durable store; passing the SAME
// map to `buildStore(kv)` twice simulates the durability boundary: the first
// store writes; we then drop that store (crash), build a new store over the
// same persisted bytes, and verify the data still reads back.

type DurableStore = {
  get(k: string): Promise<string | null>;
  set(k: string, v: string): Promise<void>;
  remove(k: string): Promise<void>;
  has(k: string): Promise<boolean>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
  setIdentity(): void;
  saveTrackedAddresses(): Promise<void>;
  loadTrackedAddresses(): Promise<unknown[]>;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  name: string;
  [DURABLE_STORAGE]: true;
};

function makeKv(): Map<string, string> {
  return new Map<string, string>();
}

function buildStore(kv: Map<string, string>): DurableStore {
  return {
    get: async (k) => kv.get(k) ?? null,
    set: async (k, v) => {
      kv.set(k, v);
    },
    remove: async (k) => {
      kv.delete(k);
    },
    has: async (k) => kv.has(k),
    keys: async () => [...kv.keys()],
    clear: async () => kv.clear(),
    setIdentity: () => {},
    saveTrackedAddresses: async () => {},
    loadTrackedAddresses: async () => [],
    initialize: async () => {},
    shutdown: async () => {},
    name: 'test-durable',
    [DURABLE_STORAGE]: true as const,
  };
}

const PUBKEY_A = '02' + 'aa'.repeat(32); // 33-byte compressed
const PUBKEY_B = '03' + 'bb'.repeat(32);

function openFlagStore(kv: Map<string, string>, pk = PUBKEY_A): FlagStore {
  return FlagStore.create(buildStore(kv) as never, pk);
}

const CID_ONE = new Uint8Array(32).fill(0x11);
const CID_TWO = new Uint8Array(32).fill(0x22);
const CID_THREE = new Uint8Array(32).fill(0x33);

// ── B1–B5: crash-scenario marker behavior ─────────────────────────────────

describe('Category B — marker crash-safety (B1–B5)', () => {
  it('B1: writeMarker persists across crash — fresh FlagStore on same KV reads it back', async () => {
    const kv = makeKv();
    // "Boot 1": write the marker through one FlagStore instance.
    const fs1 = openFlagStore(kv);
    await writeMarker(fs1, 7, CID_ONE);

    // Simulate a crash: drop fs1, its underlying store, and the whole process
    // state EXCEPT the persisted KV bytes. Rebuild over the same KV.
    const fs2 = openFlagStore(kv);
    const marker = await readMarker(fs2);

    expect(marker).not.toBeNull();
    expect(marker!.v).toBe(7);
    expect(marker!.cidHash.length).toBe(32);

    // resolvePublishVersion against the re-opened store must hit the H13
    // idempotent-retry branch (same v, same cidHash).
    const res = await resolvePublishVersion(fs2, 6, CID_ONE);
    expect(res.isIdempotentRetry).toBe(true);
    expect(res.v).toBe(7);
  });

  it('B2: writeMarker is idempotent — same (v, CID) written twice yields the same record', async () => {
    const kv = makeKv();
    const fs1 = openFlagStore(kv);
    await writeMarker(fs1, 10, CID_ONE);
    const first = kv.get('profile.pointer.' + PUBKEY_A + '.pending_version');

    // Simulate crash + retry with same parameters.
    const fs2 = openFlagStore(kv);
    await writeMarker(fs2, 10, CID_ONE);
    const second = kv.get('profile.pointer.' + PUBKEY_A + '.pending_version');

    // Byte-for-byte identical record — no subtle drift on retry.
    expect(second).toBe(first);
    expect(second).not.toBeUndefined();

    // A third boot still reads the same (v, cidHash).
    const fs3 = openFlagStore(kv);
    const marker = await readMarker(fs3);
    expect(marker!.v).toBe(10);
  });

  it('B3: writeMarker overwrites prior record when caller upgrades CID for same v', async () => {
    const kv = makeKv();
    const fs1 = openFlagStore(kv);
    await writeMarker(fs1, 5, CID_ONE);

    // Simulate crash before anything used the marker. New attempt upgrades CID.
    const fs2 = openFlagStore(kv);
    await writeMarker(fs2, 5, CID_TWO);

    // Re-open and verify the marker reflects CID_TWO, not stale CID_ONE.
    const fs3 = openFlagStore(kv);
    const marker = await readMarker(fs3);
    expect(marker!.v).toBe(5);

    // Idempotent retry must NOT match CID_ONE anymore (proves overwrite).
    const resOne = await resolvePublishVersion(fs3, 4, CID_ONE);
    expect(resOne.isIdempotentRetry).toBe(false);

    // But it SHOULD match CID_TWO.
    const fs4 = openFlagStore(kv);
    // Re-write because the previous resolvePublishVersion did OTP-bump
    // and would not have touched the marker here (marker.v === target).
    await writeMarker(fs4, 5, CID_TWO);
    const fs5 = openFlagStore(kv);
    const resTwo = await resolvePublishVersion(fs5, 4, CID_TWO);
    expect(resTwo.isIdempotentRetry).toBe(true);
  });

  it('B4: clearMarker persists — a cleared marker stays cleared across crash', async () => {
    const kv = makeKv();
    const fs1 = openFlagStore(kv);
    await writeMarker(fs1, 3, CID_ONE);
    await clearMarker(fs1);

    // Underlying KV should have no key with `pending_version` suffix.
    const keys = [...kv.keys()].filter((k) => k.endsWith('.pending_version'));
    expect(keys).toHaveLength(0);

    // Crash + reopen: still null.
    const fs2 = openFlagStore(kv);
    expect(await readMarker(fs2)).toBeNull();
  });

  it('B5: clearMarker is idempotent — calling it with no marker does not throw and does not affect other keys', async () => {
    const kv = makeKv();
    // Prime a sibling key (different localKey) to ensure clearMarker is
    // narrowly scoped.
    const sibling = 'profile.pointer.' + PUBKEY_A + '.blocked';
    kv.set(sibling, JSON.stringify({ blocked: false }));

    const fs1 = openFlagStore(kv);
    await expect(clearMarker(fs1)).resolves.toBeUndefined();
    await expect(clearMarker(fs1)).resolves.toBeUndefined();

    expect(kv.get(sibling)).toBe(JSON.stringify({ blocked: false }));
    expect(await readMarker(fs1)).toBeNull();
  });
});

// ── B6: MARKER_MAX_JUMP clamp ─────────────────────────────────────────────

describe('Category B — MARKER_MAX_JUMP clamp (B6, SPEC §7.1.4 C1)', () => {
  it('B6: marker proposing version jump > MARKER_MAX_JUMP raises MARKER_CORRUPT', async () => {
    const kv = makeKv();
    const fs = openFlagStore(kv);

    const currentLocal = 10;
    // Jump = MARKER_MAX_JUMP + 1 — one past the clamp.
    const badV = currentLocal + MARKER_MAX_JUMP + 1;
    await writeMarker(fs, badV, CID_ONE);

    await expect(resolvePublishVersion(fs, currentLocal, CID_TWO)).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.MARKER_CORRUPT,
    });

    // Boundary sibling assertion: jump = MARKER_MAX_JUMP exactly is NOT
    // corrupt — this keeps B6 paired with the boundary behavior (no false
    // positives) so a regression that tightens the inequality is caught.
    const kvOk = makeKv();
    const fsOk = openFlagStore(kvOk);
    const boundaryV = currentLocal + MARKER_MAX_JUMP;
    await writeMarker(fsOk, boundaryV, CID_ONE);
    const resOk = await resolvePublishVersion(fsOk, currentLocal, CID_TWO);
    // boundaryV >> target → max(target, marker.v) + 1
    expect(resOk.v).toBe(boundaryV + 1);
  });
});

// ── B7: §7.1.5 integrity check — tamper vectors ──────────────────────────

describe('Category B — marker integrity (B7, SPEC §7.1.5)', () => {
  const KEY = 'profile.pointer.' + PUBKEY_A + '.pending_version';

  // Each vector below MUST be rejected with MARKER_CORRUPT. They cover every
  // plausible byte-level tamper attack on the stored record.
  const vectors: Array<[string, unknown]> = [
    ['uppercase hex in cidHash', { v: 1, cidHash: 'A'.repeat(64) }],
    ['non-hex char in cidHash', { v: 1, cidHash: 'z'.repeat(64) }],
    ['cidHash with odd length', { v: 1, cidHash: '0'.repeat(63) }],
    ['cidHash with extra char', { v: 1, cidHash: '0'.repeat(65) }],
    ['cidHash as byte-array (not string)', { v: 1, cidHash: [0, 0, 0] }],
    ['cidHash is null', { v: 1, cidHash: null }],
    ['v is a float', { v: 1.5, cidHash: '0'.repeat(64) }],
    ['v is a string', { v: '1', cidHash: '0'.repeat(64) }],
    ['v = 0 (below VERSION_MIN)', { v: 0, cidHash: '0'.repeat(64) }],
    ['v < 0', { v: -5, cidHash: '0'.repeat(64) }],
    ['empty object', {}],
    ['array instead of object', [1, 2, 3]],
  ];

  for (const [label, rec] of vectors) {
    it(`B7: rejects corrupt marker — ${label}`, async () => {
      const kv = makeKv();
      kv.set(KEY, JSON.stringify(rec));
      const flagStore = openFlagStore(kv);
      await expect(readMarker(flagStore)).rejects.toMatchObject({
        code: AggregatorPointerErrorCode.MARKER_CORRUPT,
      });
    });
  }
});

// ── B8: §7.1.6 atomicity — partial-write rejection ───────────────────────

describe('Category B — marker atomicity (B8, SPEC §7.1.6)', () => {
  const KEY = 'profile.pointer.' + PUBKEY_A + '.pending_version';

  it('B8a: truncated JSON (simulated mid-fsync crash) raises MARKER_CORRUPT', async () => {
    const kv = makeKv();
    const fs1 = openFlagStore(kv);
    await writeMarker(fs1, 42, CID_ONE);
    const full = kv.get(KEY)!;
    // Simulate "half-written" bytes: keep only the first ~2/3.
    const truncated = full.slice(0, Math.floor(full.length * 0.6));
    kv.set(KEY, truncated);

    const fs2 = openFlagStore(kv);
    await expect(readMarker(fs2)).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.MARKER_CORRUPT,
    });
  });

  it('B8b: single-flipped-byte in hex cidHash raises MARKER_CORRUPT', async () => {
    // Replace one hex digit with a non-hex char — this is the minimum possible
    // corruption but must still be caught by the integrity check.
    const kv = makeKv();
    const fs1 = openFlagStore(kv);
    await writeMarker(fs1, 8, CID_TWO);
    const full = kv.get(KEY)!;
    // Replace the first char of cidHash with 'g' (non-hex).
    const tampered = full.replace(/"cidHash":"./, '"cidHash":"g');
    expect(tampered).not.toBe(full);
    kv.set(KEY, tampered);

    const fs2 = openFlagStore(kv);
    await expect(readMarker(fs2)).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.MARKER_CORRUPT,
    });
  });

  it('B8c: absent marker after partial-write rejection does NOT wedge publish — clearMarker succeeds', async () => {
    // Operator recovery flow: clear the corrupt marker and move on. This
    // proves clearMarker is tolerant of a malformed value (it removes rather
    // than trying to parse).
    const kv = makeKv();
    kv.set(KEY, '{"v":1,"cidHash":"not-hex"}');
    const fs1 = openFlagStore(kv);
    await expect(clearMarker(fs1)).resolves.toBeUndefined();
    expect(await readMarker(fs1)).toBeNull();
  });
});

// ── B9: Browser Web Locks mutex — LIFO + mutual exclusion under contention ─

describe('Category B — browser Web Locks mutex (B9)', () => {
  const origNavigator = globalThis.navigator;
  const origWindow = globalThis.window;

  class BrowserLocksStub {
    private _queue: Array<() => void> = [];
    private _held = false;
    async request(
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
          try {
            await callback({});
          } finally {
            this._held = false;
            const next = this._queue.shift();
            if (next) next();
            resolve();
          }
        };
        void attempt();
      });
    }
  }

  beforeEach(() => {
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

  it('B9: three contending acquires are strictly serialized (no interleaving of enter/exit events)', async () => {
    const mutex = createPointerMutex('category-B-lock');
    const events: string[] = [];

    const worker = async (id: string, hold: number) => {
      const handle = await mutex.acquire({ timeoutMs: 5000 });
      events.push(`${id}:enter`);
      await new Promise((r) => setTimeout(r, hold));
      events.push(`${id}:exit`);
      await handle.release();
    };

    // Kick off three concurrent workers with overlapping lifetimes. Any
    // interleaving would manifest as e.g. "A:enter B:enter" rather than
    // strict pairs "A:enter A:exit".
    await Promise.all([worker('A', 15), worker('B', 15), worker('C', 15)]);

    expect(events.length).toBe(6);
    for (let i = 0; i < events.length; i += 2) {
      const id = events[i].split(':')[0];
      expect(events[i]).toBe(`${id}:enter`);
      expect(events[i + 1]).toBe(`${id}:exit`);
    }

    // After all releases, a fresh acquire must succeed with a fresh grant —
    // ensures we did NOT leak a "zombie lock" via the late-resolve guard
    // inside BrowserMutex.acquire.
    const finalHandle = await mutex.acquire({ timeoutMs: 5000 });
    await finalHandle.release();
  });

  it('B9b: early release makes the lock available to the next waiter without requiring the caller to clear a timer', async () => {
    const mutex = createPointerMutex('category-B-lock');
    const h1 = await mutex.acquire({ timeoutMs: 5000 });

    // Queue a second waiter. It must block until h1 releases.
    let gotLock = false;
    const p2 = (async () => {
      const h2 = await mutex.acquire({ timeoutMs: 5000 });
      gotLock = true;
      await h2.release();
    })();

    // Give the second waiter a chance to be queued.
    await new Promise((r) => setTimeout(r, 20));
    expect(gotLock).toBe(false);

    await h1.release();
    await p2;
    expect(gotLock).toBe(true);
  });
});

// ── B10: Node mutex — file-lock + in-process stack with crash unwinding ───

describe('Category B — Node mutex layering (B10)', () => {
  let tmpDir: string;
  let lockFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'category-b-'));
    lockFile = path.join(tmpDir, 'publish.lock');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('B10: if file-lock acquisition throws, the in-process mutex is released (no permanent wedge)', async () => {
    // The Node primitives expose an invariant: if Step 2 (file lock) fails
    // with a non-ELOCKED error, Step 1 (in-process mutex) MUST be released
    // before the error propagates. Otherwise subsequent acquires queue
    // forever against a dead holder.
    const { Mutex } = await import('async-mutex');
    const inProcess = new Mutex();

    let inProcessReleases = 0;
    const spy: NodeLockPrimitives = {
      acquireInProcess: async () => {
        const release = await inProcess.acquire();
        return () => {
          inProcessReleases += 1;
          release();
        };
      },
      acquireFileLock: async () => {
        // Simulate a non-recoverable filesystem failure (e.g. ENOSPC).
        const err = new Error('simulated EIO') as NodeJS.ErrnoException;
        err.code = 'EIO';
        throw err;
      },
    };

    const mutex = createPointerMutex('crash-test', { lockFilePath: lockFile });
    (mutex as unknown as { _injectPrimitives(p: NodeLockPrimitives): void })._injectPrimitives(spy);

    await expect(mutex.acquire({ timeoutMs: 2000 })).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.UNSUPPORTED_RUNTIME,
    });

    // Critical: in-process mutex was released — a fresh acquire against the
    // same async-mutex must NOT hang.
    expect(inProcessReleases).toBe(1);
    const release2 = await inProcess.acquire();
    release2();
  });

  it('B10b: normal acquire + release strictly pairs the layered locks in LIFO order', async () => {
    const acquisitionOrder: string[] = [];
    const { Mutex } = await import('async-mutex');
    const inProcess = new Mutex();

    const spy: NodeLockPrimitives = {
      acquireInProcess: async () => {
        const release = await inProcess.acquire();
        acquisitionOrder.push('inproc-acquired');
        return () => {
          acquisitionOrder.push('inproc-released');
          release();
        };
      },
      acquireFileLock: async () => {
        acquisitionOrder.push('file-acquired');
        return async () => {
          acquisitionOrder.push('file-released');
        };
      },
    };

    const mutex = createPointerMutex('lifo-test', { lockFilePath: lockFile });
    (mutex as unknown as { _injectPrimitives(p: NodeLockPrimitives): void })._injectPrimitives(spy);

    const handle = await mutex.acquire({ timeoutMs: 5000 });
    await handle.release();

    // Strict LIFO: inproc-acquired < file-acquired < file-released < inproc-released
    expect(acquisitionOrder).toEqual([
      'inproc-acquired',
      'file-acquired',
      'file-released',
      'inproc-released',
    ]);
  });

  it('B10c: double-release is idempotent — second release() is a no-op', async () => {
    // A common defensive pattern is `try { ... } finally { await handle.release() }`
    // and callers may release early-on-throw AND again in finally. Verify the
    // handle swallows the second release rather than double-releasing the
    // underlying locks.
    const { Mutex } = await import('async-mutex');
    const inProcess = new Mutex();
    let fileReleaseCount = 0;
    let inProcessReleaseCount = 0;

    const spy: NodeLockPrimitives = {
      acquireInProcess: async () => {
        const release = await inProcess.acquire();
        return () => {
          inProcessReleaseCount += 1;
          release();
        };
      },
      acquireFileLock: async () => {
        return async () => {
          fileReleaseCount += 1;
        };
      },
    };
    const mutex = createPointerMutex('double-rel', { lockFilePath: lockFile });
    (mutex as unknown as { _injectPrimitives(p: NodeLockPrimitives): void })._injectPrimitives(spy);

    const handle = await mutex.acquire({ timeoutMs: 5000 });
    await handle.release();
    await handle.release(); // must be a no-op

    expect(fileReleaseCount).toBe(1);
    expect(inProcessReleaseCount).toBe(1);
  });
});

// ── B11: Identity switch (W5) ─────────────────────────────────────────────

describe('Category B — identity switch mid-session (B11, W5)', () => {
  it('B11a: distinct signingPubKeys produce distinct mutexKey() strings', () => {
    const k1 = mutexKey(PUBKEY_A);
    const k2 = mutexKey(PUBKEY_B);
    expect(k1).not.toBe(k2);
    // Strict template: every key includes the full pubkey hex. A regression
    // that accidentally truncates (e.g. first 8 chars) would be caught here.
    expect(k1).toContain(PUBKEY_A);
    expect(k2).toContain(PUBKEY_B);
  });

  it('B11b: FlagStore scopes markers per-identity — identity switch never reads the old identity\'s marker', async () => {
    const kv = makeKv();

    // Session 1: identity A writes a marker.
    const fsA = openFlagStore(kv, PUBKEY_A);
    await writeMarker(fsA, 100, CID_ONE);

    // Session 2 in the SAME process, after identity switch to B. The new
    // FlagStore must be built with PUBKEY_B — per SPEC §3 and per-wallet
    // key templating, it sees NO marker.
    const fsB = openFlagStore(kv, PUBKEY_B);
    expect(await readMarker(fsB)).toBeNull();

    // And A's marker is still intact (no cross-contamination).
    const fsA2 = openFlagStore(kv, PUBKEY_A);
    const markerA = await readMarker(fsA2);
    expect(markerA!.v).toBe(100);

    // B can write its OWN marker independently — verifies the two identities
    // live side-by-side in the same durable KV without collision.
    await writeMarker(fsB, 1, CID_THREE);
    const markerB = await readMarker(fsB);
    expect(markerB!.v).toBe(1);
    expect(markerA!.v).toBe(100); // A's marker snapshot still matches
  });

  it('B11c: a new mutex built for the new identity does not serialize against the old identity\'s mutex', async () => {
    // W5 claim: after identity switch, the caller builds a FRESH mutex for
    // the new signingPubKey. That mutex has its own lock key and does not
    // block on the old one. We verify this by creating two Browser mutexes
    // with distinct keys and showing they can both be held simultaneously.
    const origNavigator = globalThis.navigator;
    const origWindow = globalThis.window;

    // Per-lock-name stub: each lock name has its own held-flag + queue.
    const held = new Map<string, boolean>();
    const queues = new Map<string, Array<() => void>>();

    Object.defineProperty(globalThis, 'navigator', {
      value: {
        locks: {
          async request(
            name: string,
            _options: { mode: string },
            callback: (lock: unknown) => Promise<void>,
          ): Promise<void> {
            return new Promise((resolve) => {
              const attempt = async () => {
                if (held.get(name)) {
                  const q = queues.get(name) ?? [];
                  q.push(attempt);
                  queues.set(name, q);
                  return;
                }
                held.set(name, true);
                try {
                  await callback({});
                } finally {
                  held.set(name, false);
                  const next = (queues.get(name) ?? []).shift();
                  if (next) next();
                  resolve();
                }
              };
              void attempt();
            });
          },
        },
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      value: {},
      writable: true,
      configurable: true,
    });

    try {
      const mutexA = createPointerMutex(mutexKey(PUBKEY_A));
      const mutexB = createPointerMutex(mutexKey(PUBKEY_B));

      const handleA = await mutexA.acquire({ timeoutMs: 2000 });
      // CRITICAL: B must not queue behind A — different lock names.
      const handleB = await mutexB.acquire({ timeoutMs: 2000 });

      // Both held simultaneously — proof that identity switch got a fresh
      // independent mutex, not a shared one.
      expect(held.get(mutexKey(PUBKEY_A))).toBe(true);
      expect(held.get(mutexKey(PUBKEY_B))).toBe(true);

      await handleA.release();
      await handleB.release();
    } finally {
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
    }
  });
});
