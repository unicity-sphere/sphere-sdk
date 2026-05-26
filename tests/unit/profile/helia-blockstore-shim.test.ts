/**
 * Tests for `profile/helia-blockstore-shim.ts` — the Helia v6 → OrbitDB v3
 * shim with LRU read cache + in-flight Promise dedup (issues #234, #266, #278).
 *
 * The mock blockstore counts every `originalGet` invocation so a test
 * can assert "N callers but only K underlying reads" — the FD-bound
 * invariant that drove #278.
 */

import { describe, it, expect } from 'vitest';
import {
  installHeliaBlockstoreGetShim,
  BLOCKSTORE_GET_LRU_MAX_DEFAULT,
} from '../../../profile/helia-blockstore-shim';

// ---------------------------------------------------------------------------
// Mock blockstore — captures every get call so tests can assert dedup.
// ---------------------------------------------------------------------------

interface MockBlockstoreOptions {
  /** Bytes returned per CID. `undefined` triggers NotFoundError. */
  readonly data: ReadonlyMap<string, Uint8Array | 'notfound' | 'invalidconfig' | 'throw'>;
  /** Optional artificial latency per get call (ms). */
  readonly latencyMs?: number;
}

interface MockBlockstore {
  get: (cid: unknown, options?: unknown) => AsyncGenerator<Uint8Array>;
  put: (cid: unknown, val: unknown, options?: unknown) => Promise<unknown>;
  /** Number of times `get` was invoked (one increment per call, regardless of iteration). */
  getCallCount: () => number;
  /** Number of times the inner generator yielded (proxy for "fs.open ran"). */
  innerYieldCount: () => number;
  putCallCount: () => number;
  resetCounters: () => void;
}

function makeBlockstore(opts: MockBlockstoreOptions): MockBlockstore {
  let getCalls = 0;
  let innerYields = 0;
  let putCalls = 0;
  return {
    get(cid, _options): AsyncGenerator<Uint8Array> {
      getCalls++;
      const key = String(cid);
      const data = opts.data.get(key);
      // Return an async generator immediately (mimics Helia's
      // `async *get`). The body runs lazily on .next().
      return (async function* () {
        if (opts.latencyMs && opts.latencyMs > 0) {
          await new Promise((r) => setTimeout(r, opts.latencyMs));
        }
        if (data === undefined || data === 'notfound') {
          const err = new Error('block not found') as Error & { name: string; code: string };
          err.name = 'NotFoundError';
          err.code = 'ERR_NOT_FOUND';
          throw err;
        }
        if (data === 'invalidconfig') {
          const err = new Error('no block brokers configured') as Error & {
            name: string;
            code: string;
          };
          err.name = 'InvalidConfigurationError';
          err.code = 'ERR_NO_BLOCK_BROKERS';
          throw err;
        }
        if (data === 'throw') {
          throw new Error('boom — not a miss, must propagate');
        }
        innerYields++;
        yield data;
      })();
    },
    async put(_cid, _val, _opts): Promise<unknown> {
      putCalls++;
      return undefined;
    },
    getCallCount: () => getCalls,
    innerYieldCount: () => innerYields,
    putCallCount: () => putCalls,
    resetCounters: () => {
      getCalls = 0;
      innerYields = 0;
      putCalls = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const CID_A = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const CID_B = 'bafkreif25z2afbxjjffztzu37vurkzh6t6fhdeesm7zybg5kihrwj4mb6q';
const CID_C = 'bafkreidv6yrybxqp2vnv3euugmcvmtnoo5x53lwhpc2lpmpqhnceuosgmu';

const BYTES_A = new TextEncoder().encode('block-a-payload');
const BYTES_B = new TextEncoder().encode('block-b-different-payload');
const BYTES_C = new TextEncoder().encode('block-c-yet-another');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('helia-blockstore-shim — drain semantics (#234)', () => {
  it('returns a Uint8Array (not an AsyncGenerator) for a single-chunk block', async () => {
    const bs = makeBlockstore({ data: new Map([[CID_A, BYTES_A]]) });
    const handle = installHeliaBlockstoreGetShim(bs);

    const result = await bs.get(CID_A);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result).toEqual(BYTES_A);
    expect(handle.misses()).toBe(1);
  });

  it('combines multi-chunk yields into a single Uint8Array', async () => {
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]),
      new Uint8Array([6, 7, 8, 9]),
    ];
    const bs: MockBlockstore = makeBlockstore({ data: new Map() });
    bs.get = (_cid, _opts) => {
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    };
    installHeliaBlockstoreGetShim(bs as never);

    const result = await bs.get(CID_A);
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  });
});

describe('helia-blockstore-shim — miss-error swallowing (#266)', () => {
  it('returns undefined on NotFoundError (matches OrbitDB v5 contract)', async () => {
    const bs = makeBlockstore({ data: new Map([[CID_A, 'notfound' as const]]) });
    installHeliaBlockstoreGetShim(bs);

    const result = await bs.get(CID_A);
    expect(result).toBeUndefined();
  });

  it('returns undefined on InvalidConfigurationError (HTTP-only mode miss)', async () => {
    const bs = makeBlockstore({ data: new Map([[CID_A, 'invalidconfig' as const]]) });
    installHeliaBlockstoreGetShim(bs);

    const result = await bs.get(CID_A);
    expect(result).toBeUndefined();
  });

  it('propagates non-miss exceptions to the caller', async () => {
    const bs = makeBlockstore({ data: new Map([[CID_A, 'throw' as const]]) });
    installHeliaBlockstoreGetShim(bs);

    await expect(bs.get(CID_A)).rejects.toThrow(/boom/);
  });

  it('does NOT cache misses — a subsequent successful read goes through', async () => {
    let returnHit = false;
    const bs: MockBlockstore = makeBlockstore({ data: new Map() });
    bs.get = (_cid, _opts) => {
      return (async function* () {
        if (!returnHit) {
          const err = new Error('miss') as Error & { name: string; code: string };
          err.name = 'NotFoundError';
          err.code = 'ERR_NOT_FOUND';
          throw err;
        }
        yield BYTES_A;
      })();
    };
    installHeliaBlockstoreGetShim(bs as never);

    expect(await bs.get(CID_A)).toBeUndefined();
    returnHit = true;
    expect(await bs.get(CID_A)).toEqual(BYTES_A);
  });
});

describe('helia-blockstore-shim — LRU read cache (#278)', () => {
  it('serves repeated reads of the same CID from cache (one inner get for N calls)', async () => {
    const bs = makeBlockstore({ data: new Map([[CID_A, BYTES_A]]) });
    const handle = installHeliaBlockstoreGetShim(bs);

    // First read populates the cache.
    expect(await bs.get(CID_A)).toEqual(BYTES_A);
    expect(bs.getCallCount()).toBe(1);
    expect(bs.innerYieldCount()).toBe(1);

    // 1000 subsequent reads should be 100 % cache hits — ZERO new
    // `originalGet` calls, ZERO new generator iterations. This is the
    // invariant that closes the #278 FD-exhaustion wedge: the same
    // CID can be requested arbitrarily many times without opening a
    // new file descriptor each round.
    for (let i = 0; i < 1000; i++) {
      const r = await bs.get(CID_A);
      expect(r).toEqual(BYTES_A);
    }
    expect(bs.getCallCount()).toBe(1);
    expect(bs.innerYieldCount()).toBe(1);
    expect(handle.hits()).toBe(1000);
    expect(handle.misses()).toBe(1);
  });

  it('LRU evicts oldest entry when the cap is exceeded', async () => {
    const data = new Map<string, Uint8Array>();
    for (let i = 0; i < 10; i++) {
      data.set(`cid-${i}`, new Uint8Array([i]));
    }
    const bs = makeBlockstore({ data });
    const handle = installHeliaBlockstoreGetShim(bs, { lruMax: 3 });

    // Populate 3 entries.
    await bs.get('cid-0');
    await bs.get('cid-1');
    await bs.get('cid-2');
    expect(handle.cacheSize()).toBe(3);

    // 4th entry → evict cid-0.
    await bs.get('cid-3');
    expect(handle.cacheSize()).toBe(3);

    // cid-0 is now a miss; cid-1, cid-2, cid-3 are hits.
    const beforeMisses = handle.misses();
    await bs.get('cid-0');
    expect(handle.misses()).toBe(beforeMisses + 1);

    // After the miss, cid-0 is now the newest. cid-1 should be the
    // oldest and the next eviction candidate.
    await bs.get('cid-4');
    const beforeMisses2 = handle.misses();
    await bs.get('cid-1');
    expect(handle.misses()).toBe(beforeMisses2 + 1);
  });

  it('refreshes recency on hit (LRU touch)', async () => {
    const data = new Map<string, Uint8Array>([
      ['cid-x', new Uint8Array([1])],
      ['cid-y', new Uint8Array([2])],
      ['cid-z', new Uint8Array([3])],
    ]);
    const bs = makeBlockstore({ data });
    const handle = installHeliaBlockstoreGetShim(bs, { lruMax: 2 });

    await bs.get('cid-x'); // x in cache (size=1)
    await bs.get('cid-y'); // x, y in cache (size=2)
    // Touch x — should move x to newest, y becomes oldest.
    await bs.get('cid-x');
    // Insert z — should evict y, not x.
    await bs.get('cid-z');

    expect(handle.cacheSize()).toBe(2);
    // x should still be a hit; y should be a miss.
    const missesBefore = handle.misses();
    await bs.get('cid-x');
    expect(handle.misses()).toBe(missesBefore);
    await bs.get('cid-y');
    expect(handle.misses()).toBe(missesBefore + 1);
  });

  it('skips caching for blocks larger than the per-entry cap', async () => {
    const big = new Uint8Array(8 * 1024); // 8 KiB
    const bs = makeBlockstore({ data: new Map([[CID_A, big]]) });
    const handle = installHeliaBlockstoreGetShim(bs, { perEntryMax: 1024 });

    expect(await bs.get(CID_A)).toEqual(big);
    expect(handle.cacheSize()).toBe(0); // not cached — exceeds cap

    // Subsequent calls miss again, must traverse the original get.
    expect(await bs.get(CID_A)).toEqual(big);
    expect(bs.getCallCount()).toBe(2);
  });

  it('uses default LRU cap when no options supplied', async () => {
    const data = new Map<string, Uint8Array>();
    const handles: string[] = [];
    for (let i = 0; i < BLOCKSTORE_GET_LRU_MAX_DEFAULT + 10; i++) {
      const key = `cid-default-${i}`;
      data.set(key, new Uint8Array([i & 0xff]));
      handles.push(key);
    }
    const bs = makeBlockstore({ data });
    const handle = installHeliaBlockstoreGetShim(bs);

    for (const k of handles) await bs.get(k);
    expect(handle.cacheSize()).toBe(BLOCKSTORE_GET_LRU_MAX_DEFAULT);
  });
});

describe('helia-blockstore-shim — in-flight dedup (#278)', () => {
  it('coalesces concurrent reads of the same CID into a single inner get', async () => {
    const bs = makeBlockstore({
      data: new Map([[CID_A, BYTES_A]]),
      latencyMs: 30,
    });
    const handle = installHeliaBlockstoreGetShim(bs);

    // 50 concurrent reads — exactly the storm pattern that drives
    // #278's 900-FD pileup. With dedup: ONE inner get, 50 callers
    // share the Promise.
    const results = await Promise.all(
      Array.from({ length: 50 }, () => bs.get(CID_A)),
    );

    for (const r of results) expect(r).toEqual(BYTES_A);
    expect(bs.getCallCount()).toBe(1);
    expect(bs.innerYieldCount()).toBe(1);
    // 50 callers, 1 became the leader (miss), 49 deduped (hit).
    expect(handle.hits()).toBe(49);
    expect(handle.misses()).toBe(1);
  });

  it('does NOT coalesce reads of different CIDs', async () => {
    const bs = makeBlockstore({
      data: new Map<string, Uint8Array>([
        [CID_A, BYTES_A],
        [CID_B, BYTES_B],
        [CID_C, BYTES_C],
      ]),
      latencyMs: 5,
    });
    installHeliaBlockstoreGetShim(bs);

    const [a, b, c] = await Promise.all([bs.get(CID_A), bs.get(CID_B), bs.get(CID_C)]);
    expect(a).toEqual(BYTES_A);
    expect(b).toEqual(BYTES_B);
    expect(c).toEqual(BYTES_C);
    expect(bs.getCallCount()).toBe(3);
  });

  it('clears the in-flight entry after the read resolves', async () => {
    const bs = makeBlockstore({ data: new Map([[CID_A, BYTES_A]]) });
    const handle = installHeliaBlockstoreGetShim(bs);

    await bs.get(CID_A);
    // After resolution, in-flight should be empty.
    expect(handle.inflightSize()).toBe(0);
  });

  it('clears the in-flight entry on a failed read so the next call can retry', async () => {
    const bs = makeBlockstore({ data: new Map([[CID_A, 'throw' as const]]) });
    const handle = installHeliaBlockstoreGetShim(bs);

    await expect(bs.get(CID_A)).rejects.toThrow();
    expect(handle.inflightSize()).toBe(0);

    // A second call retries the underlying get (cache was NOT
    // populated by the error).
    await expect(bs.get(CID_A)).rejects.toThrow();
    expect(bs.getCallCount()).toBe(2);
  });
});

describe('helia-blockstore-shim — put invalidates the cache', () => {
  it('evicts the LRU entry on put(cid, ...) so the next get re-reads', async () => {
    const bs = makeBlockstore({ data: new Map([[CID_A, BYTES_A]]) });
    installHeliaBlockstoreGetShim(bs);

    // Populate cache.
    expect(await bs.get(CID_A)).toEqual(BYTES_A);
    expect(bs.getCallCount()).toBe(1);

    // Put invalidates.
    await bs.put(CID_A, BYTES_A);
    expect(bs.putCallCount()).toBe(1);

    // Next get bypasses the cache.
    expect(await bs.get(CID_A)).toEqual(BYTES_A);
    expect(bs.getCallCount()).toBe(2);
  });

  it('keeps the cache intact when put is not exposed', async () => {
    const bs = makeBlockstore({ data: new Map([[CID_A, BYTES_A]]) });
    // Remove put before installing — simulates a Helia version that
    // doesn't expose put on the blockstore. The shim should not
    // throw on install, and the cache should still work for get.
    const bsNoPut: { get: typeof bs.get } = { get: bs.get };
    installHeliaBlockstoreGetShim(bsNoPut as never);

    expect(await bsNoPut.get(CID_A)).toEqual(BYTES_A);
    expect(await bsNoPut.get(CID_A)).toEqual(BYTES_A);
    expect(bs.getCallCount()).toBe(1);
  });
});

describe('helia-blockstore-shim — delete invalidates the cache', () => {
  it('evicts the LRU entry on delete(cid) so a subsequent get re-reads', async () => {
    let returnHit = true;
    const bs: { get: (cid: unknown) => AsyncGenerator<Uint8Array>; delete: (cid: unknown) => Promise<void>; calls: number } = {
      calls: 0,
      get(_cid): AsyncGenerator<Uint8Array> {
        const wasHit = returnHit;
        const self = this;
        return (async function* () {
          self.calls++;
          if (!wasHit) {
            const err = new Error('miss') as Error & { name: string; code: string };
            err.name = 'NotFoundError';
            err.code = 'ERR_NOT_FOUND';
            throw err;
          }
          yield BYTES_A;
        })();
      },
      async delete(_cid) {
        returnHit = false;
      },
    };
    installHeliaBlockstoreGetShim(bs as never);

    expect(await (bs.get as unknown as (cid: unknown) => Promise<Uint8Array | undefined>)(CID_A)).toEqual(BYTES_A);
    expect(bs.calls).toBe(1);

    // Second get from cache.
    expect(await (bs.get as unknown as (cid: unknown) => Promise<Uint8Array | undefined>)(CID_A)).toEqual(BYTES_A);
    expect(bs.calls).toBe(1);

    // Delete invalidates cache; subsequent get reads through to the
    // (now empty) underlying store → undefined.
    await bs.delete(CID_A);
    expect(await (bs.get as unknown as (cid: unknown) => Promise<Uint8Array | undefined>)(CID_A)).toBeUndefined();
    expect(bs.calls).toBe(2);
  });
});

describe('helia-blockstore-shim — degenerate inputs', () => {
  it('skips the cache when cid yields the default Object.prototype.toString (collision guard)', async () => {
    const bs = makeBlockstore({ data: new Map() });
    // Override the inner `get` so it doesn't depend on the data Map
    // (which is keyed by string). Always yield BYTES_A so we can assert
    // the wrapper returns it without caching.
    bs.get = (_cid, _opts): AsyncGenerator<Uint8Array> => {
      return (async function* () {
        yield BYTES_A;
      })();
    };
    const handle = installHeliaBlockstoreGetShim(bs as never);

    // Plain object: toString() === '[object Object]'. Two distinct
    // objects would collide on this key, so the cidKey helper must
    // reject it.
    const fakeCid1 = { foo: 'a' };
    const fakeCid2 = { foo: 'b' };
    expect(await bs.get(fakeCid1)).toEqual(BYTES_A);
    expect(await bs.get(fakeCid2)).toEqual(BYTES_A);
    // Both reads bypassed the cache; the shim observed 2 misses.
    expect(handle.cacheSize()).toBe(0);
    expect(handle.misses()).toBe(2);
  });

  it('disables the cache when lruMax <= 0 (no set-then-evict thrashing)', async () => {
    const bs = makeBlockstore({ data: new Map([[CID_A, BYTES_A]]) });
    const handle = installHeliaBlockstoreGetShim(bs, { lruMax: 0 });

    // Every read goes through to the underlying get; the cache never
    // accumulates entries.
    await bs.get(CID_A);
    await bs.get(CID_A);
    await bs.get(CID_A);
    expect(handle.cacheSize()).toBe(0);
    expect(bs.getCallCount()).toBe(3);
  });
});

describe('helia-blockstore-shim — uninstall restores originals', () => {
  it('uninstall() restores the original get/put and drops the cache', async () => {
    const bs = makeBlockstore({ data: new Map([[CID_A, BYTES_A]]) });
    const handle = installHeliaBlockstoreGetShim(bs);
    const wrappedGet = bs.get;

    await bs.get(CID_A);
    expect(handle.cacheSize()).toBe(1);

    handle.uninstall();
    expect(bs.get).not.toBe(wrappedGet);
    expect(handle.cacheSize()).toBe(0);

    // Original get is async-generator-returning, NOT Uint8Array-returning.
    // Calling it should yield a generator.
    const gen = bs.get(CID_A);
    expect(typeof (gen as AsyncGenerator)[Symbol.asyncIterator]).toBe('function');
  });
});
