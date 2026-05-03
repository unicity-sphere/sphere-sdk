/**
 * UXF Transfer — process-global per-aggregator semaphore registry (W14).
 *
 * The §6.1 / W14 normative cap is `MAX_CONCURRENT_POLLS_PER_AGGREGATOR`
 * (default 16) in-flight aggregator calls per endpoint. Steelman
 * post-cutover note: the cap is meaningful ONLY when the semaphore
 * scope is process-global per aggregator URL, not per-Sphere-instance.
 * A single client spinning up multiple Sphere objects with per-instance
 * semaphores trivially bypasses the cap and can DoS the aggregator
 * under wide chain-mode bursts.
 *
 * This module owns a module-level `Map<aggregatorId, Semaphore>`
 * registry. Both finalization workers (sender + recipient) consume from
 * this shared registry by default. Tests retain the option to inject a
 * caller-owned semaphore for deterministic isolation.
 *
 * **Invariants**:
 *   - Same `aggregatorId` → same `Semaphore` instance for the lifetime
 *     of the JS module's bundle.
 *   - Different `aggregatorId` → independent semaphores (each gets its
 *     own 16-permit budget).
 *   - Permit scope is the FULL poll loop per Phase 6 review note —
 *     workers MUST NOT release across sleep. This module is unaware of
 *     poll-loop semantics; it only mints semaphores.
 *
 * **tsup bundle duplication note**: tsup compiles multiple entry points
 * into separate bundles, each inlining its own copy of this module's
 * `Map`. Two bundles importing this file will have two independent
 * registries; production wiring is single-bundle so this is irrelevant
 * in practice, but tests that span bundles (rare) should explicitly
 * inject the same semaphore into both worker constructors.
 *
 * @packageDocumentation
 */

import { logger } from '../../../core/logger';
import { MAX_CONCURRENT_POLLS_PER_AGGREGATOR } from './limits';
import {
  CountingSemaphore,
  type Semaphore,
} from './finalization-worker-base';

// =============================================================================
// 0. Wave 3 steelman fix — bounded registry + rejectable wrapper
// =============================================================================

/**
 * Process-global registry size cap. The Map MUST NOT grow unbounded —
 * a caller synthesizing distinct `aggregatorId` strings (e.g., random
 * fixture endpoints from a test that forgets to call the reset hook,
 * or a misconfigured production deployment generating a new ID per
 * request) would otherwise leak Semaphore instances forever.
 *
 * **Sizing rationale**: 32 is comfortably above any realistic
 * deployment (a wallet typically talks to one aggregator per network;
 * even a multi-network client running mainnet + testnet + dev rarely
 * exceeds 3-4 distinct endpoints). Beyond 32, the registry begins
 * recycling least-recently-used slots — the W14/W26 cap still holds
 * for the 32 hottest endpoints, and cold endpoints fall back to a
 * fresh semaphore on next access (which is functionally identical to
 * the cold-start case).
 *
 * Tests can observe the cap via
 * {@link __aggregatorSemaphoreRegistrySizeForTesting}; the LRU
 * eviction order is deterministic (`Map` preserves insertion order;
 * touching an existing key requires explicit re-insertion to mark it
 * most-recently-used — see {@link touchLruKey}).
 */
const REGISTRY_MAX_ENTRIES = 32;

/**
 * Stable error signature used by {@link __resetAggregatorSemaphoresForTesting}
 * to abort pending `acquire()` waiters. Tests crashing mid-acquire
 * (e.g. a `it.fails()` assertion fires while a worker awaits a permit)
 * would otherwise leave the awaiting promise dangling forever — the
 * closure pins the test's outer scope, blocking GC and preventing
 * vitest from cleanly tearing down the worker.
 */
const SEMAPHORE_RESET_ERROR_MESSAGE = 'semaphore reset for testing';

/**
 * Wrapper around {@link CountingSemaphore} that adds two capabilities
 * required by the Wave 3 steelman fix:
 *
 *   1. **Pending-waiter tracking**: every `acquire()` call registers a
 *      reject function in a `Set` for the duration of the wait. The
 *      `__resetAggregatorSemaphoresForTesting` hook walks the set and
 *      rejects each pending promise with a known error so the awaiting
 *      caller surfaces the shutdown rather than hanging forever. Once
 *      `acquire()` resolves (permit obtained) the rejector is
 *      automatically deregistered — there is no rejection window
 *      after acquire returns.
 *   2. **`available` passthrough**: forwards to the inner counting
 *      semaphore so existing tests that observe permit counts continue
 *      to work unchanged.
 *
 * The inner permit accounting and FIFO-fairness guarantees of
 * {@link CountingSemaphore} are preserved verbatim — this wrapper only
 * augments the wait-cancellation surface.
 */
class RejectableSemaphore implements Semaphore {
  private readonly inner: CountingSemaphore;
  private readonly pendingRejecters: Set<(err: Error) => void> = new Set();

  constructor(maxConcurrent: number) {
    this.inner = new CountingSemaphore(maxConcurrent);
  }

  /**
   * Forwarded `available` permit count from the inner counting
   * semaphore. Tests assert against this to prove drain semantics.
   */
  get available(): number {
    return this.inner.available;
  }

  /**
   * Acquire a permit, race-able against a `rejectAllPending()` call.
   *
   * If `rejectAllPending` fires while this acquire is still waiting,
   * the returned promise rejects with the supplied error — the caller
   * surfaces the shutdown signal cleanly. If the inner semaphore wins
   * the race (permit obtained first), the rejector is removed from
   * the pending set and the release closure is returned as normal.
   *
   * **Note on inner-waiter orphaning**: when `rejectAllPending` wins,
   * the inner CountingSemaphore's waiter list still holds a callback
   * tied to OUR resolution. This is acceptable in the test-reset path
   * because the registry is cleared simultaneously — the inner
   * semaphore becomes unreachable and is GC'd along with its dangling
   * waiter. In production, `rejectAllPending` is never called.
   */
  async acquire(): Promise<() => void> {
    let rejectFn!: (err: Error) => void;
    const rejector = new Promise<never>((_, rej) => {
      rejectFn = rej;
    });
    this.pendingRejecters.add(rejectFn);
    try {
      // Race the real acquire against the external rejector. Whichever
      // settles first wins; the loser's settlement is silently dropped.
      const release = await Promise.race<() => void>([
        this.inner.acquire(),
        rejector,
      ]);
      return release;
    } finally {
      // Always deregister the rejector — whether we obtained the
      // permit or were rejected. A still-registered rejector after
      // `acquire()` settles would be a leak.
      this.pendingRejecters.delete(rejectFn);
    }
  }

  /**
   * Reject every currently-pending `acquire()` waiter with the supplied
   * error. Used exclusively by the test-only reset hook to flush
   * dangling promises when the registry is cleared.
   *
   * @internal
   */
  rejectAllPending(err: Error): void {
    // Snapshot the set into an array first; rejecting may mutate the
    // set as `acquire()`'s `finally` block fires (depending on
    // scheduler ordering), but we want a consistent reject pass.
    const snapshot = Array.from(this.pendingRejecters);
    this.pendingRejecters.clear();
    for (const rejectFn of snapshot) {
      rejectFn(err);
    }
  }
}

// =============================================================================
// 1. Process-global registry
// =============================================================================

/**
 * Module-level registry. Keyed by the CANONICALIZED `aggregatorId` —
 * production wiring uses the aggregator endpoint URL (or the
 * `'default'` sentinel for single-aggregator deployments). Lazily
 * populated on first {@link getAggregatorSemaphore} call per id.
 *
 * **Bounded by {@link REGISTRY_MAX_ENTRIES}** — see Wave 3 steelman
 * fix at the top of this module. LRU eviction policy: each access
 * via {@link getAggregatorSemaphore} touches the entry to the MRU
 * end; a new insertion past the cap evicts the oldest (LRU) entry.
 *
 * The stored value is the wrapper {@link RejectableSemaphore} (NOT
 * the raw `CountingSemaphore`) so the test-only reset hook can flush
 * pending waiters cleanly.
 *
 * @internal
 */
const aggregatorSemaphores = new Map<string, RejectableSemaphore>();

/**
 * Steelman finding #159: canonicalize the aggregator ID so
 * superficially-distinct strings that point at the same endpoint
 * collapse to the same registry slot.
 *
 * Without canonicalization, `'https://agg/'` and `'https://agg'`
 * (or `'HTTPS://Agg.Example/'` vs `'https://agg.example'`, or
 * `'https://agg:443'` vs `'https://agg'`) each create their OWN
 * Semaphore with the full 16-permit budget — bypassing the W14/W26
 * cap exactly the way the per-instance bug bypassed it before.
 *
 * Rules applied:
 *   - Lowercase the host.
 *   - Strip trailing slashes from the path (but keep a single `/` for
 *     a bare-root URL — `https://agg/` becomes `https://agg`).
 *   - Drop the default port (`:80` for `http`, `:443` for `https`).
 *   - Drop the query string and fragment.
 *
 * Non-URL strings (the `'default'` sentinel, test fixtures like
 * `'shared-aggregator'`) and URLs that fail to parse are returned
 * trimmed-verbatim with a warn-level log — this is shared infra and
 * MUST NOT crash the SDK on a malformed config.
 *
 * @param id Raw aggregator identifier as supplied by the caller.
 * @returns Canonical form suitable for use as a registry key.
 */
export function canonicalizeAggregatorId(id: string): string {
  // Coerce non-string inputs to a string so a fast-fail on bad config
  // upstream doesn't poison the registry. Then trim — leading/trailing
  // whitespace is never significant.
  const trimmed = (typeof id === 'string' ? id : String(id)).trim();
  if (trimmed.length === 0) return trimmed;
  // Sentinel form (`'default'`, test fixtures) — pass through. URL
  // parsing of a bare word would throw or yield surprising results
  // depending on the platform; bail early.
  if (!/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(trimmed)) {
    return trimmed;
  }
  try {
    const u = new URL(trimmed);
    const protocol = u.protocol.toLowerCase();
    const host = u.hostname.toLowerCase();
    let port = u.port;
    // Strip default ports.
    if (
      (protocol === 'http:' && port === '80') ||
      (protocol === 'https:' && port === '443') ||
      (protocol === 'ws:' && port === '80') ||
      (protocol === 'wss:' && port === '443')
    ) {
      port = '';
    }
    // Strip trailing slashes from the path. A bare path of `/`
    // canonicalizes to empty so `https://agg` and `https://agg/`
    // hash the same.
    let path = u.pathname.replace(/\/+$/, '');
    if (path === '') path = '';
    const hostport = port ? `${host}:${port}` : host;
    // Username/password (rare in aggregator URLs) preserved
    // verbatim — they can carry an API token in some deployments.
    let userinfo = '';
    if (u.username || u.password) {
      userinfo = u.password ? `${u.username}:${u.password}@` : `${u.username}@`;
    }
    return `${protocol}//${userinfo}${hostport}${path}`;
  } catch (err) {
    logger.warn(
      'AggregatorSemaphore',
      `canonicalizeAggregatorId: failed to parse '${trimmed}', using verbatim`,
      err,
    );
    return trimmed;
  }
}

/**
 * Touch a key to mark it most-recently-used (LRU policy). `Map`
 * preserves insertion order, so deleting then re-inserting moves the
 * entry to the end of the iteration order. Subsequent eviction
 * picks the first (oldest / least-recently-used) entry to remove.
 *
 * @internal
 */
function touchLruKey(
  key: string,
  sem: RejectableSemaphore,
): void {
  aggregatorSemaphores.delete(key);
  aggregatorSemaphores.set(key, sem);
}

/**
 * Evict the least-recently-used entry if the registry has exceeded
 * its size cap. The first key in `Map`'s iteration order is the
 * oldest insertion that hasn't been touched since.
 *
 * @internal
 */
function evictLruIfFull(): void {
  while (aggregatorSemaphores.size >= REGISTRY_MAX_ENTRIES) {
    const oldestKey = aggregatorSemaphores.keys().next().value;
    if (oldestKey === undefined) break;
    const evicted = aggregatorSemaphores.get(oldestKey);
    aggregatorSemaphores.delete(oldestKey);
    // If the evicted semaphore had pending waiters, they are now
    // orphaned (registry no longer holds the wrapper). Reject them
    // so the awaiting callers don't dangle forever — same rationale
    // as the test-only reset hook, but for the production LRU path.
    if (evicted !== undefined) {
      evicted.rejectAllPending(
        new Error(
          'aggregator-semaphore evicted from registry (LRU); ' +
            'caller should re-acquire',
        ),
      );
    }
  }
}

/**
 * Return the process-global {@link Semaphore} for `aggregatorId`,
 * creating it on first access with the §6.1 / W14 default budget
 * ({@link MAX_CONCURRENT_POLLS_PER_AGGREGATOR}).
 *
 * Subsequent calls with the SAME `aggregatorId` (after
 * {@link canonicalizeAggregatorId}) return the SAME semaphore
 * instance — this is the load-bearing invariant that makes the cap
 * process-global.
 *
 * **LRU touch**: every call (whether for an existing key or a new
 * insertion) touches the entry to the MRU end of the registry, so
 * frequently-accessed endpoints stay resident even as cold endpoints
 * age out under the {@link REGISTRY_MAX_ENTRIES} cap.
 *
 * @param aggregatorId Aggregator endpoint identifier. Use the URL for
 *                     multi-aggregator deployments; default `'default'`
 *                     for single-aggregator wiring.
 * @returns A {@link Semaphore} with `MAX_CONCURRENT_POLLS_PER_AGGREGATOR`
 *          permits.
 */
export function getAggregatorSemaphore(aggregatorId: string): Semaphore {
  const key = canonicalizeAggregatorId(aggregatorId);
  const existing = aggregatorSemaphores.get(key);
  if (existing !== undefined) {
    // Touch to MRU — keeps hot endpoints resident under LRU pressure.
    touchLruKey(key, existing);
    return existing;
  }
  // Evict if we're at capacity BEFORE inserting the new entry; the
  // cap is a hard upper bound on registry size.
  evictLruIfFull();
  const sem = new RejectableSemaphore(MAX_CONCURRENT_POLLS_PER_AGGREGATOR);
  aggregatorSemaphores.set(key, sem);
  return sem;
}

/**
 * Test-only — clear the registry AND reject every pending waiter.
 * Production code MUST NOT call this.
 *
 * Without this hook, parallel test files would observe state bleeding
 * across cases (semaphore permits exhausted by a prior test). Tests
 * that exercise the production fallback (no caller-injected semaphore)
 * MUST call this in `beforeEach` to restore a fresh budget per case.
 *
 * **Wave 3 steelman fix**: prior implementations called `Map.clear()`
 * but did NOT release pending waiters. A test that crashed mid-
 * acquire (assertion failure inside an `acquire().then(...)` chain,
 * or `it.fails()` short-circuit) would leave the rejected promise
 * holding closures pinning the test's outer scope, blocking GC and
 * preventing vitest from cleanly tearing down the worker. We now
 * walk every cleared semaphore's pending waiters and reject them
 * with a sentinel error before discarding the wrapper.
 *
 * @internal
 */
export function __resetAggregatorSemaphoresForTesting(): void {
  // Snapshot the wrappers before clearing so iteration is stable.
  const wrappers = Array.from(aggregatorSemaphores.values());
  aggregatorSemaphores.clear();
  // Reject every pending waiter on every wrapper. Each wrapper
  // self-clears its pending set; a subsequent crashed test cannot
  // observe stale rejecters.
  const err = new Error(SEMAPHORE_RESET_ERROR_MESSAGE);
  for (const wrapper of wrappers) {
    wrapper.rejectAllPending(err);
  }
}

/**
 * Test-only — observe the registry's current size. Used by the unit
 * test that pins the singleton invariant (same id → same instance,
 * different ids → distinct instances).
 *
 * @internal
 */
export function __aggregatorSemaphoreRegistrySizeForTesting(): number {
  return aggregatorSemaphores.size;
}
