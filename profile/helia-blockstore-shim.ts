/**
 * Helia blockstore shim — wraps `helia.blockstore.get` with three
 * compensating layers: (1) Helia-v6-to-OrbitDB-v3 drain shim,
 * (2) bounded LRU read cache, (3) in-flight Promise dedup.
 *
 * Why this exists (issue history):
 *
 * - **#234** — Helia v6's `BlockStorage.get` is an `async *get(cid, options)`
 *   generator yielding `Uint8Array` chunks. OrbitDB v3's `IPFSBlockStorage.get`
 *   was authored for the Helia v5 API where `await blockstore.get(cid)`
 *   resolved to a `Uint8Array`. Under v6 the same `await` resolves to the
 *   AsyncGenerator object — cborg downstream throws
 *   `data to decode must be a Uint8Array`. The drain shim re-establishes
 *   the v5 contract by draining the generator into a single Uint8Array.
 *
 * - **#266** — `NetworkedStorage.get` throws `InvalidConfigurationError`
 *   when the wallet is in HTTP-only mode (`blockBrokers: []`) AND the
 *   block is not in the local on-disk store. OrbitDB expects `undefined`
 *   on miss (the `if (block)` check at `@orbitdb/core/src/storage/ipfs-block.js:65`)
 *   — surfacing the exception would abort the whole read with a non-fatal
 *   miss. The shim swallows it (alongside the canonical `NotFoundError`)
 *   so OrbitDB sees a clean missing entry; upstream callers run the
 *   HTTP-gateway recovery path separately.
 *
 * - **#278** — `sphere wallet use <name>` wedged for 58 min at 330% CPU
 *   with 900+ open file descriptors all pointing at TWO OrbitDB block
 *   files (the OpLog HEAD entry block + the most-recent snapshot block).
 *   Pattern: a tight read loop hitting the same CIDs hundreds of times
 *   in rapid succession. Each `helia.blockstore.get(cid)` walked
 *   `BlockStorage → NetworkedStorage → IdentityBlockstore → FsBlockstore`
 *   and opened the file. Even though `FsBlockstore.get` is correct in
 *   the steady state (stream EOF auto-closes the FD), the FD close is
 *   event-loop scheduled — under a synchronous storm of `get(cid)` the
 *   close handlers run AFTER the next batch of opens, FDs accumulate
 *   well past safe limits, and the process spins.
 *
 *   The LRU + in-flight dedup eliminate the storm at its source: 100 %
 *   of cached-CID `get` calls return synchronously with the bytes
 *   (zero `fs.open` calls), and concurrent first-reads share one
 *   Promise (one open per CID, not N).
 *
 * Design constraints:
 *   - **Defaults are conservative.** 64 entries × 1 MiB per-entry cap =
 *     64 MiB worst case; typical OrbitDB blocks are sub-KiB so the
 *     real footprint is well under 1 MiB. The cap covers the OpLog
 *     head + recent snapshot + handful of bundle CIDs working set.
 *   - **Negative caching is OFF.** A `get(cid)` that returns `undefined`
 *     (cache miss) is NOT cached — upstream callers may then fetch the
 *     block via HTTP brokers and re-populate the local blockstore; a
 *     cached `undefined` would defeat that recovery. The shim ONLY
 *     caches non-empty `Uint8Array` results.
 *   - **`put` evicts.** Content-addressed CIDs mean same-CID writes
 *     have identical bytes (so a stale cache entry would be semantically
 *     correct), but evict-on-write is the safer default: any future
 *     writer surface that diverges from content addressing is caught.
 *   - **CID identity is the LRU key.** We rely on the canonical
 *     `cid.toString()` (multiformats `base32` for v1, `base58btc` for
 *     v0). Both are stable, CID-unique, and round-trip with
 *     `CID.parse`.
 *
 * @module profile/helia-blockstore-shim
 */

/**
 * Default maximum LRU entries. 64 entries comfortably covers the
 * OpLog head + recent snapshot + tens of bundle CIDs the load path
 * touches.
 */
export const BLOCKSTORE_GET_LRU_MAX_DEFAULT = 64;

/**
 * Default per-entry byte cap. Blocks larger than this are returned to
 * the caller but NOT cached — avoids pathological multi-megabyte
 * blocks pinning the cache.
 */
export const BLOCKSTORE_GET_LRU_PER_ENTRY_MAX_DEFAULT = 1 * 1024 * 1024; // 1 MiB

/**
 * Surface area we touch on a Helia v6+ blockstore. Typed `unknown`-permissive
 * because `@helia/utils` is not a hard dependency of the SDK (loaded
 * dynamically via `import('helia')`).
 */
export interface HeliaBlockstoreLike {
  get: (cid: unknown, options?: unknown) => unknown;
  put?: (cid: unknown, val: unknown, options?: unknown) => unknown;
  delete?: (cid: unknown, options?: unknown) => unknown;
}

/**
 * Tuning knobs for the shim. Both default to the constants above; the
 * test suite uses tighter values to exercise eviction paths in finite
 * time.
 */
export interface HeliaBlockstoreShimOptions {
  readonly lruMax?: number;
  readonly perEntryMax?: number;
}

/**
 * Install the drain shim + LRU read cache + in-flight dedup over
 * `blockstore.get` (mutates the blockstore in-place). Returns a
 * disposer that restores the original methods AND surfaces the
 * read-cache stats for assertions.
 *
 * Call ONCE per blockstore instance. Re-installing over an already-
 * wrapped get would treat the inner `Promise<Uint8Array | undefined>`
 * as the new `AsyncIterable<Uint8Array>` and crash the drain — the
 * production wiring satisfies this by construction (`connectInner`
 * runs once per `connect()`), and tests should use a fresh Helia
 * instance for each scenario.
 */
export interface HeliaBlockstoreShimHandle {
  /** Number of LRU entries currently cached. */
  readonly cacheSize: () => number;
  /** Number of in-flight reads currently pending. */
  readonly inflightSize: () => number;
  /**
   * Number of times the shim observed a cache hit. Includes both LRU
   * hits AND in-flight Promise reuse. (Both correspond to "no new
   * `fs.open` call".)
   */
  readonly hits: () => number;
  /** Number of times the shim observed a cache miss + drain. */
  readonly misses: () => number;
  /** Restore the original blockstore methods. */
  readonly uninstall: () => void;
}

/**
 * Drain an async iterable of `Uint8Array` chunks into a single
 * `Uint8Array`. Mirrors `it-to-buffer` but inlined to avoid a
 * dependency footprint for one call site.
 *
 * Returns `undefined` when the iterable yields zero chunks (Helia
 * surface treats this as a miss).
 */
async function drainGenerator(
  source: AsyncIterable<Uint8Array>,
): Promise<Uint8Array | undefined> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    total += chunk.length;
  }
  if (chunks.length === 0) return undefined;
  if (chunks.length === 1) return chunks[0];
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    combined.set(c, offset);
    offset += c.length;
  }
  return combined;
}

/**
 * True when the thrown value is a "block not present" signal that
 * upstream callers expect to surface as `undefined` (NOT as an
 * exception). Covers both the canonical interface-store
 * `NotFoundError` (`name === 'NotFoundError'`, `code === 'ERR_NOT_FOUND'`)
 * AND the Helia `InvalidConfigurationError` thrown when
 * `blockBrokers: []` and the block isn't local.
 */
function isMissError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { name?: unknown; code?: unknown };
  return (
    e.name === 'NotFoundError' ||
    e.code === 'ERR_NOT_FOUND' ||
    e.name === 'InvalidConfigurationError' ||
    e.code === 'ERR_NO_BLOCK_BROKERS'
  );
}

/**
 * Compute the LRU key for a CID. Prefers `cid.toString()` (canonical
 * multiformats), falls back to `String(cid)` for shapes that don't
 * expose it. Returns `null` for unusable inputs so the wrapped get
 * skips the cache (defensive: cache miss is still a correct result).
 */
function cidKey(cid: unknown): string | null {
  if (cid == null) return null;
  try {
    const s = (cid as { toString?: () => string }).toString?.();
    if (typeof s === 'string' && s.length > 0) return s;
    const fallback = String(cid);
    return fallback.length > 0 ? fallback : null;
  } catch {
    return null;
  }
}

/**
 * Install the shim on `blockstore` in place. See module doc for
 * background; this is the single entry point for `OrbitDbAdapter`
 * (production wiring) and the unit test (mock wiring).
 */
export function installHeliaBlockstoreGetShim(
  blockstore: HeliaBlockstoreLike,
  options?: HeliaBlockstoreShimOptions,
): HeliaBlockstoreShimHandle {
  const lruMax = options?.lruMax ?? BLOCKSTORE_GET_LRU_MAX_DEFAULT;
  const perEntryMax = options?.perEntryMax ?? BLOCKSTORE_GET_LRU_PER_ENTRY_MAX_DEFAULT;

  const originalGet = blockstore.get.bind(blockstore) as (
    cid: unknown,
    options?: unknown,
  ) => unknown;
  const originalPut =
    typeof blockstore.put === 'function'
      ? (blockstore.put.bind(blockstore) as (
          cid: unknown,
          val: unknown,
          options?: unknown,
        ) => unknown)
      : null;
  const originalDelete =
    typeof blockstore.delete === 'function'
      ? (blockstore.delete.bind(blockstore) as (
          cid: unknown,
          options?: unknown,
        ) => unknown)
      : null;

  const lru = new Map<string, Uint8Array>();
  const inflight = new Map<string, Promise<Uint8Array | undefined>>();
  let hits = 0;
  let misses = 0;

  const touch = (key: string, value: Uint8Array): void => {
    if (value.byteLength === 0 || value.byteLength > perEntryMax) return;
    lru.set(key, value);
    while (lru.size > lruMax) {
      const oldest = lru.keys().next().value;
      if (oldest === undefined) break;
      lru.delete(oldest);
    }
  };

  const wrappedGet = async (
    cid: unknown,
    opts?: unknown,
  ): Promise<Uint8Array | undefined> => {
    const key = cidKey(cid);

    if (key !== null) {
      const cached = lru.get(key);
      if (cached !== undefined) {
        // Refresh recency — re-insert at the end of the map's
        // insertion order. (Map iteration order = insertion order;
        // deleting + re-setting moves to the tail.)
        lru.delete(key);
        lru.set(key, cached);
        hits++;
        return cached;
      }
      const pending = inflight.get(key);
      if (pending !== undefined) {
        hits++;
        return pending;
      }
    }

    misses++;
    const work = (async (): Promise<Uint8Array | undefined> => {
      try {
        const source = originalGet(cid, opts) as AsyncIterable<Uint8Array>;
        return await drainGenerator(source);
      } catch (err) {
        if (isMissError(err)) return undefined;
        throw err;
      } finally {
        if (key !== null) inflight.delete(key);
      }
    })();

    if (key !== null) inflight.set(key, work);

    const result = await work;
    if (key !== null && result instanceof Uint8Array) {
      touch(key, result);
    }
    return result;
  };

  blockstore.get = wrappedGet as unknown as HeliaBlockstoreLike['get'];

  let wrappedPut: ((cid: unknown, val: unknown, opts?: unknown) => unknown) | null = null;
  if (originalPut !== null) {
    wrappedPut = (cid: unknown, val: unknown, opts?: unknown): unknown => {
      const key = cidKey(cid);
      if (key !== null) {
        lru.delete(key);
        inflight.delete(key);
      }
      return originalPut(cid, val, opts);
    };
    blockstore.put = wrappedPut as HeliaBlockstoreLike['put'];
  }

  // Wrap `delete` so a GC sweep or explicit removal evicts the LRU
  // entry — otherwise a subsequent `get` would return stale bytes
  // for a block the on-disk store no longer holds. Wallet code paths
  // do not call `delete` today (Profile is append-only), but a future
  // `helia.gc()` invocation or a sibling library that holds the
  // helia handle could.
  let wrappedDelete: ((cid: unknown, opts?: unknown) => unknown) | null = null;
  if (originalDelete !== null) {
    wrappedDelete = (cid: unknown, opts?: unknown): unknown => {
      const key = cidKey(cid);
      if (key !== null) {
        lru.delete(key);
        inflight.delete(key);
      }
      return originalDelete(cid, opts);
    };
    blockstore.delete = wrappedDelete as HeliaBlockstoreLike['delete'];
  }

  return {
    cacheSize: () => lru.size,
    inflightSize: () => inflight.size,
    hits: () => hits,
    misses: () => misses,
    uninstall: (): void => {
      blockstore.get = originalGet as unknown as HeliaBlockstoreLike['get'];
      if (originalPut !== null) {
        blockstore.put = originalPut as HeliaBlockstoreLike['put'];
      }
      if (originalDelete !== null) {
        blockstore.delete = originalDelete as HeliaBlockstoreLike['delete'];
      }
      lru.clear();
      inflight.clear();
    },
  };
}
