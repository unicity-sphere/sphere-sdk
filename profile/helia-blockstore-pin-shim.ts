/**
 * Helia blockstore pin shim — wraps `helia.blockstore.put` so every block
 * written by OrbitDB's OpLog write path is also pinned via `helia.pins.add`.
 *
 * # Why this exists (issue #311)
 *
 * Real-world incident on `sphere-telco-test.dyndns.org`: a Profile-mode
 * wallet successfully migrated, wrote OpLog blocks to the browser's
 * IndexedDB blockstore, survived one session, then was unable to reload
 * because `bafyreihx3oa...` (the OpLog head block) had been evicted. The
 * wallet became permanently unloadable because OrbitDB's level state
 * (which tracks the head CID pointer) IS persisted across reloads, but
 * the underlying block bytes are eligible for Helia GC unless explicitly
 * pinned. Browsers also aggressively evict IndexedDB origin storage
 * under pressure for sites that have not called `navigator.storage.persist()`.
 *
 * # Defense strategy
 *
 * This shim is one of three layered defenses (issue #311):
 *   1. **Pin OpLog blocks at write time** (THIS MODULE) — every block
 *      OrbitDB emits via `blockstore.put(cid, bytes)` is pinned through
 *      `helia.pins.add(cid)`. Pinned blocks are NOT eligible for
 *      Helia GC. The pin set persists for the lifetime of the wallet.
 *   2. **`navigator.storage.persist()`** — requests persistent storage
 *      from the browser so IndexedDB is not silently evicted under
 *      pressure. Handled separately in the browser factory.
 *   3. **Critical-block-evicted alarm** — a `profile:critical-block-evicted`
 *      event fires when a `get` path observes the "Failed to load block"
 *      signature so operators see eviction the moment it happens, not
 *      after the wallet has wedged. Handled in `ProfileStorageProvider`.
 *
 * # Contract
 *
 *   - **Best-effort**. Pin failures NEVER break writes — the original
 *     `put` Promise's outcome is the source of truth; pin errors are
 *     logged at warn level and swallowed. A wallet running on a Helia
 *     version that lacks the `pins` API continues to work (just without
 *     the GC defense).
 *   - **Idempotent**. Helia's pin API treats double-pinning the same CID
 *     as a no-op, so re-pinning a block that was already pinned by a
 *     prior write (or a prior session) is harmless.
 *   - **Fire-and-forget**. The pin call runs in the background after
 *     `put` resolves — we do NOT await `helia.pins.add` inside the
 *     wrapped put because the existing put-flow already awaits the
 *     underlying blockstore write. Blocking on the pin would add
 *     latency to every OrbitDB OpLog append without changing the
 *     durability of the put itself.
 *   - **Pin set unbounded by design**. Profile wallets typically write
 *     hundreds of OpLog blocks across their lifetime; bounded pin
 *     eviction is deferred (see follow-up note in issue #311). The
 *     incident this prevents is FAR more damaging than a few MiB of
 *     extra retained blocks.
 *
 * @module profile/helia-blockstore-pin-shim
 */

import { logger } from '../core/logger';
import { incr, observeMs } from '../core/perf-counters.js';

/**
 * Minimal structural shape of the Helia v6+ pins API.
 *
 * The shim always passes `{ depth: 0 }` so Helia pins each block as a
 * leaf without walking referenced descendants — see issue #419 + the
 * "Why depth: 0" doc-comment on {@link installHeliaBlockstorePinShim}.
 */
export interface HeliaPinsLike {
  /**
   * Pin a CID so the block survives Helia GC.
   *
   * Helia v6 returns an `AsyncIterable<CID>` that yields each pinned
   * descendant (one CID per depth-0 add when called with `{ depth: 0 }`).
   * The shim consumes the iterable so the pin is actually applied —
   * Helia computes the pin set lazily on iteration.
   *
   * `options` is forwarded verbatim; the only field the shim sets is
   * `depth`. Other fields (metadata, AbortSignal) are not used today
   * but the structural shape allows future call sites to pass them.
   */
  add(
    cid: unknown,
    options?: { readonly depth?: number; readonly metadata?: unknown; readonly signal?: unknown },
  ): AsyncIterable<unknown> | Promise<unknown>;
}

/** Minimal structural shape of the Helia v6+ blockstore. */
export interface HeliaBlockstoreLike {
  put?: (cid: unknown, val: unknown, options?: unknown) => unknown;
  /**
   * Helia v6's batch ingest API. Used by Bitswap / NetworkedStorage for
   * replication and by future OrbitDB Sync paths. Source yields
   * `{cid, block}` pairs; the implementation persists each and yields
   * the CID. Review fix (#311 PR #317): we must wrap this in addition
   * to `put`, otherwise batch-ingested blocks (the very ones that
   * arrive via Bitswap replication) bypass the pin defense entirely.
   */
  putMany?: (
    source: AsyncIterable<{ cid: unknown; block: unknown }>,
    options?: unknown,
  ) => AsyncIterable<unknown>;
}

/** Minimal structural shape of the parts of the Helia instance we touch. */
export interface HeliaWithPinsLike {
  pins?: HeliaPinsLike;
  blockstore?: HeliaBlockstoreLike;
}

/**
 * Counters surfaced for observability + tests. All fields read-only.
 *
 * `pinAttempted` increments once per wrapped put (regardless of pin
 * outcome). `pinSucceeded` and `pinFailed` are mutually exclusive — each
 * settled pin Promise increments exactly one of the two. `pinSkipped`
 * counts cases where the shim was unable to attempt the pin at all
 * (missing API, non-CID argument, etc.).
 */
export interface PinShimCounters {
  readonly pinAttempted: number;
  readonly pinSucceeded: number;
  readonly pinFailed: number;
  readonly pinSkipped: number;
}

/** Handle returned by {@link installHeliaBlockstorePinShim}. */
export interface PinShimHandle {
  /** Snapshot of the current counters (test-observable). */
  getCounters(): PinShimCounters;
  /**
   * Currently-tracked pinned CIDs (string form). Bounded by the
   * sequence of `put` calls — does NOT bound itself. Test-observable.
   */
  getPinnedCids(): ReadonlyArray<string>;
}

/**
 * Wrap `helia.blockstore.put` so every put also fires `helia.pins.add(cid)`.
 *
 * Idempotent: a second install on the same helia instance returns the
 * existing handle (we mark the blockstore via a non-enumerable property
 * so subsequent installs no-op).
 *
 * Defensive: if `helia.blockstore.put` is missing OR if `helia.pins.add`
 * is missing, we still return a handle but DO NOT wrap anything — the
 * caller gets a no-op shim. This keeps the call site uniform across
 * Helia versions / test stubs.
 *
 * @param helia  Helia instance returned by `createHelia()` or a test
 *               stub matching the structural shape above.
 * @returns      A handle exposing counters and the pin set (for tests).
 */
export function installHeliaBlockstorePinShim(
  helia: HeliaWithPinsLike,
): PinShimHandle {
  let pinAttempted = 0;
  let pinSucceeded = 0;
  let pinFailed = 0;
  let pinSkipped = 0;
  const pinnedCids = new Set<string>();

  // Issue #419 follow-up — capture a one-shot Helia config snapshot the
  // first time `pins.add` raises a non-"Already pinned" failure. Many
  // pin failures look identical in the warn-log; the snapshot tells an
  // operator at a glance whether they're looking at an HTTP-only Helia
  // (no libp2p), a libp2p-with-bootstraps wallet that can't reach its
  // peers, or an unfamiliar blockstore/pins surface. Captured at install
  // time (cheap, runs once) and emitted lazily on the first failure so
  // a healthy session never logs the snapshot at all.
  const heliaConfigSnapshot = snapshotHeliaConfig(helia);
  let firstFailureSnapshotEmitted = false;

  const handle: PinShimHandle = {
    getCounters: () => ({ pinAttempted, pinSucceeded, pinFailed, pinSkipped }),
    getPinnedCids: () => Array.from(pinnedCids),
  };

  const blockstore = helia.blockstore;
  if (!blockstore || typeof blockstore.put !== 'function') {
    pinSkipped++; // observability: shim could not bind
    return handle;
  }

  const pins = helia.pins;
  if (!pins || typeof pins.add !== 'function') {
    // No pin API — write path remains correct, but we lose the GC
    // defense. Log once so operators can see why pins aren't growing.
    logger.warn(
      'ProfilePinShim',
      'helia.pins.add unavailable — OpLog blocks will not be pinned. ' +
        'Wallet remains functional but is exposed to browser-storage GC.',
    );
    return handle;
  }

  // Mark + early-return on double install. Property is non-enumerable so
  // it doesn't leak through `Object.keys`.
  const sentinel = '__sphereProfilePinShimInstalled__';
  const blockstoreAny = blockstore as unknown as Record<string, unknown>;
  if (blockstoreAny[sentinel] === true) {
    return handle;
  }
  try {
    Object.defineProperty(blockstoreAny, sentinel, {
      value: true,
      writable: false,
      configurable: false,
      enumerable: false,
    });
  } catch {
    // Some test doubles freeze the object; absent the sentinel a
    // second install would simply wrap again, which is harmless given
    // the idempotent pin contract.
  }

  const originalPut = blockstore.put.bind(blockstore);

  blockstore.put = function pinningPut(
    cid: unknown,
    val: unknown,
    options?: unknown,
  ): unknown {
    // Run the underlying put first. We do NOT await here in case it
    // returns a non-Promise — preserve the original surface. The pin
    // call is scheduled off the result.
    const putResult = originalPut(cid, val, options);

    // Schedule the pin fire-and-forget. Pin attempts on non-CID inputs
    // are skipped (logged once) so a misconfigured caller does not
    // wedge the put path.
    schedulePin(cid, pins, putResult)
      .then((outcome) => {
        if (outcome === 'pinned') {
          pinSucceeded++;
        } else if (outcome === 'skipped') {
          pinSkipped++;
        } else {
          pinFailed++;
        }
      })
      .catch(() => {
        // schedulePin already catches its own; this is paranoia in
        // case a future refactor surfaces a throw.
        pinFailed++;
      });

    pinAttempted++;

    return putResult;
  };

  // Review fix (PR #317 finding F1) — wrap `putMany` so batch-ingested
  // blocks (Bitswap replication / NetworkedStorage / future OrbitDB
  // Sync paths) also land in the pin set. Pre-fix the shim only
  // covered single `put` calls; any block that arrives via batch
  // bypassed defense #1 entirely.
  //
  // Helia v6's contract: `putMany(source, options) => AsyncIterable<CID>`
  // — each yielded CID has been persisted by the time it's yielded.
  // We wrap the iterable to pin each yielded CID, then forward the
  // CID downstream so existing callers see the same shape.
  if (typeof blockstore.putMany === 'function') {
    const originalPutMany = blockstore.putMany.bind(blockstore);
    blockstore.putMany = function pinningPutMany(
      source: AsyncIterable<{ cid: unknown; block: unknown }>,
      options?: unknown,
    ): AsyncIterable<unknown> {
      incr('helia.blockstore.putMany.calls');
      const __pmStart = performance.now();
      const upstream = originalPutMany(source, options);
      // Return an async generator that pins each yielded CID before
      // forwarding it. Pin is fire-and-forget per CID so a slow pin
      // doesn't stall the iterator chain.
      return (async function* pinningPutManyGen() {
        let itemCount = 0;
        try {
          for await (const yieldedCid of upstream) {
            itemCount++;
            pinAttempted++;
            // Pin in the background; the put is already complete by
            // the time the iterator yielded the CID.
            schedulePin(yieldedCid, pins, Promise.resolve())
              .then((outcome) => {
                if (outcome === 'pinned') pinSucceeded++;
                else if (outcome === 'skipped') pinSkipped++;
                else pinFailed++;
              })
              .catch(() => {
                pinFailed++;
              });
            yield yieldedCid;
          }
        } finally {
          incr('helia.blockstore.putMany.items', itemCount);
          observeMs('helia.blockstore.putMany.totalMs', performance.now() - __pmStart);
        }
      })();
    };
  }

  return handle;

  // ---- inline helpers ----

  async function schedulePin(
    cid: unknown,
    pinsApi: HeliaPinsLike,
    putResult: unknown,
  ): Promise<'pinned' | 'failed' | 'skipped'> {
    // Wait for the underlying put to settle. If the put rejected we
    // skip the pin — there is nothing to pin yet.
    try {
      if (putResult && typeof (putResult as { then?: unknown }).then === 'function') {
        await putResult;
      }
    } catch {
      return 'skipped';
    }

    // Capture CID as a string for the observability set. We do NOT
    // require a multiformats CID instance — many stubs pass plain
    // strings. Real Helia code paths pass a CID object whose
    // `toString()` returns the canonical multibase form.
    let cidStr: string;
    try {
      cidStr =
        typeof cid === 'string'
          ? cid
          : typeof (cid as { toString?: unknown }).toString === 'function'
            ? String((cid as { toString: () => string }).toString())
            : '';
    } catch {
      return 'skipped';
    }
    if (cidStr.length === 0) {
      return 'skipped';
    }

    // Pre-check: if we've already pinned this CID in this session, skip
    // the round-trip to `pinsApi.add` entirely. Without this, every block
    // touched during an OrbitDB OpLog replay or a re-flush calls
    // `pins.add` for an already-pinned CID, which then rejects with
    // "Already pinned" and triggers the warn-log spam observed in
    // production (hundreds of warnings per second freezing the page in
    // DevTools). The Set is the authoritative in-session tracker
    // populated below on success.
    if (pinnedCids.has(cidStr)) {
      incr('helia.pins.add.cached');
      return 'pinned';
    }

    incr('helia.pins.add.calls');
    const __pStart = performance.now();
    try {
      // Pin as a LEAF: `{ depth: 0 }` tells Helia to pin this block
      // alone without walking the DAG of referenced descendants.
      //
      // Why this matters (issue #419):
      //   `@helia/utils`'s `Pins.add` defaults to `depth: Infinity`,
      //   meaning every pin call decodes the block, follows every CID
      //   link, and recursively pins descendants. Each descendant load
      //   goes through `blockstore.get(cid)`, which (in online mode)
      //   falls through to Bitswap when the block isn't already on
      //   disk — and throws "Failed to load block for <child cid>"
      //   when Bitswap can't satisfy it either.
      //
      //   Every OpLog block this shim pins references its parent
      //   block. Every CAR block pinned via `putBlockToLocalHelia`
      //   (issue #236) references its children. Recursive descent
      //   makes the FIRST pin try to load the WHOLE chain — most of
      //   which isn't local yet (e.g., the genesis OpLog block from a
      //   different session, or a CAR child that hasn't been put yet
      //   because the worker pool ordered the puts arbitrarily).
      //
      //   The shim's contract is "pin individual blocks at write
      //   time". Recursive walks contradict that contract and produce
      //   the floods of `helia.pins.add failed for X: Failed to load
      //   block for Y` warnings observed in issue #419. Switching to
      //   `depth: 0` aligns Helia's behaviour with the contract: each
      //   pin call pins exactly the block whose put just succeeded.
      //   The DAG remains fully pinned across calls because every
      //   block in it is the subject of its own `put` (and therefore
      //   its own pin).
      const result = pinsApi.add(cid, { depth: 0 });
      // Helia v6 returns AsyncIterable<CID>; older / test stubs may
      // return a thenable. Drain both shapes.
      if (
        result &&
        typeof (result as { [Symbol.asyncIterator]?: unknown })[
          Symbol.asyncIterator
        ] === 'function'
      ) {
        for await (const _entry of result as AsyncIterable<unknown>) {
          // Iterate to completion — Helia computes pin descendants
          // lazily; abandoning the iterator before completion leaves
          // the pin set in an inconsistent state. The yielded
          // CID(s) are intentionally not consumed: the side-effect
          // (pinning) IS what we want.
          void _entry;
        }
      } else if (result && typeof (result as { then?: unknown }).then === 'function') {
        await result;
      }
      // Review fix (PR #317 finding F4) — dropped a dead line that
      // attempted `(h.getPinnedCids() as string[]).push?.(cidStr)`.
      // `getPinnedCids()` returns `Array.from(pinnedCids)` — a fresh
      // throwaway array — so the push did nothing. The actual
      // persistence is `pinnedCids.add(cidStr)` below.
      pinnedCids.add(cidStr);
      observeMs('helia.pins.add.successMs', performance.now() - __pStart);
      return 'pinned';
    } catch (err) {
      // "Already pinned" is NOT a failure — Helia rejects re-adds with
      // this message when the pin record already exists in the pin
      // datastore. It means the previous pin is still durable, which is
      // exactly what we want. Stamp the in-memory tracker so the pre-
      // check above short-circuits subsequent puts of the same CID, and
      // return success WITHOUT warning. Without this branch, OpLog
      // replays of pre-pinned blocks produced hundreds of warns per
      // second, freezing the page in DevTools.
      const msg = err instanceof Error ? err.message : String(err);
      if (/already pinned/i.test(msg)) {
        pinnedCids.add(cidStr);
        incr('helia.pins.add.alreadyPinned');
        observeMs('helia.pins.add.alreadyPinnedMs', performance.now() - __pStart);
        return 'pinned';
      }
      // Best-effort: log at warn level and move on. The single most
      // common cause in production is `add` rejecting because the
      // datastore is mid-shutdown — re-pinning on the next session
      // restores the invariant.
      logger.warn(
        'ProfilePinShim',
        `helia.pins.add failed for ${cidStr.slice(0, 16)}…: ${msg}`,
      );
      // Issue #419 — emit the captured Helia config snapshot exactly
      // once across the install lifetime. Tells the operator at a
      // glance which Helia shape is in use (HTTP-only vs libp2p,
      // blockstore type, pins implementation) so a flurry of identical
      // pin-failure warnings doesn't bury the actual diagnostic signal.
      if (!firstFailureSnapshotEmitted) {
        firstFailureSnapshotEmitted = true;
        logger.warn(
          'ProfilePinShim',
          `first pin failure — helia config snapshot: ${heliaConfigSnapshot}`,
        );
      }
      incr('helia.pins.add.failed');
      observeMs('helia.pins.add.failedMs', performance.now() - __pStart);
      return 'failed';
    }
  }
}

/**
 * Capture a compact, one-line description of the Helia instance the
 * shim has been bound to. Emitted lazily by {@link installHeliaBlockstorePinShim}
 * on the first observed pin failure (issue #419).
 *
 * Fields:
 *   - `blockstore`: blockstore class name (e.g., `FsBlockstore`,
 *     `MemoryBlockstore`, `IDBBlockstore`). A failed pin against an
 *     `FsBlockstore` points at on-disk corruption / fd exhaustion; a
 *     failure against `MemoryBlockstore` points at a test stub.
 *   - `pins`: pins implementation class name (real Helia is
 *     `DefaultPins`; tests stub this).
 *   - `libp2p`: `present`, `absent`, or `unknown`. `absent` is the
 *     HTTP-only Helia config introduced in issue #266 — when present
 *     the failure may be a Bitswap walk that couldn't reach a peer.
 *   - `peerCount`: number of libp2p peers known to be connected (or
 *     `unknown` when libp2p is absent). A peer count of 0 with libp2p
 *     present signals isolation — Helia's Bitswap descendant walks
 *     have no chance of succeeding.
 *
 * Defensive: every field falls back to `unknown` on any access error.
 * Never throws — the caller emits this from a warn branch and must
 * not amplify a logging path's cost into a control-flow problem.
 */
function snapshotHeliaConfig(helia: HeliaWithPinsLike): string {
  const safeClassName = (value: unknown): string => {
    if (value === null || value === undefined) return 'absent';
    try {
      const ctor = (value as { constructor?: { name?: unknown } }).constructor;
      const name = ctor?.name;
      return typeof name === 'string' && name.length > 0 ? name : 'unknown';
    } catch {
      return 'unknown';
    }
  };
  let blockstoreName = 'unknown';
  let pinsName = 'unknown';
  let libp2pState: 'present' | 'absent' | 'unknown' = 'absent';
  let peerCount: number | 'unknown' = 'unknown';
  try {
    blockstoreName = safeClassName(helia.blockstore);
  } catch {
    /* ignore */
  }
  try {
    pinsName = safeClassName(helia.pins);
  } catch {
    /* ignore */
  }
  try {
    const libp2p = (helia as unknown as { libp2p?: unknown }).libp2p;
    if (libp2p === null || libp2p === undefined) {
      libp2pState = 'absent';
    } else {
      libp2pState = 'present';
      try {
        const peers = (libp2p as { getPeers?: () => ReadonlyArray<unknown> }).getPeers?.();
        if (Array.isArray(peers)) {
          peerCount = peers.length;
        }
      } catch {
        /* peer-count lookup is best-effort; libp2p shape varies */
      }
    }
  } catch {
    libp2pState = 'unknown';
  }
  return (
    `blockstore=${blockstoreName} pins=${pinsName} ` +
    `libp2p=${libp2pState} peerCount=${peerCount}`
  );
}

/**
 * Request persistent storage from the browser. Returns the result so
 * the caller can surface it via a `profile:storage-persistence` event.
 *
 * Browser-only: outside a browser environment (Node.js / SSR / tests
 * with `navigator` undefined) returns `{ granted: false, supported: false }`
 * synchronously. Inside a browser whose `navigator.storage` lacks the
 * `persist` method (legacy Safari, some embedded WebViews) returns
 * `{ granted: false, supported: false }` as well.
 *
 * The call is idempotent: once persistence has been granted (e.g. via
 * a previous wallet-bound install accepting the permission prompt),
 * subsequent calls resolve quickly without prompting the user.
 *
 * Errors are swallowed — a thrown `persist()` is treated as
 * `{ granted: false, supported: true }` so we still surface that the
 * platform supports the API but the request itself failed (e.g.
 * permissions-policy block).
 */
export async function requestPersistentStorage(): Promise<{
  readonly granted: boolean;
  readonly supported: boolean;
}> {
  // Node / non-browser environments. `typeof navigator !== 'undefined'`
  // narrows below so TS doesn't complain about referencing a possibly-
  // undefined global.
  if (typeof navigator === 'undefined') {
    return { granted: false, supported: false };
  }
  const storage = (navigator as { storage?: { persist?: () => Promise<boolean> } }).storage;
  if (!storage || typeof storage.persist !== 'function') {
    return { granted: false, supported: false };
  }
  try {
    const granted = await storage.persist();
    return { granted: granted === true, supported: true };
  } catch {
    return { granted: false, supported: true };
  }
}
