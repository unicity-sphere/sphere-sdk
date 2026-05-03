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
// 1. Process-global registry
// =============================================================================

/**
 * Module-level registry. Keyed by the CANONICALIZED `aggregatorId` —
 * production wiring uses the aggregator endpoint URL (or the
 * `'default'` sentinel for single-aggregator deployments). Lazily
 * populated on first {@link getAggregatorSemaphore} call per id.
 *
 * @internal
 */
const aggregatorSemaphores = new Map<string, Semaphore>();

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
 * Return the process-global {@link Semaphore} for `aggregatorId`,
 * creating it on first access with the §6.1 / W14 default budget
 * ({@link MAX_CONCURRENT_POLLS_PER_AGGREGATOR}).
 *
 * Subsequent calls with the SAME `aggregatorId` (after
 * {@link canonicalizeAggregatorId}) return the SAME semaphore
 * instance — this is the load-bearing invariant that makes the cap
 * process-global.
 *
 * @param aggregatorId Aggregator endpoint identifier. Use the URL for
 *                     multi-aggregator deployments; default `'default'`
 *                     for single-aggregator wiring.
 * @returns A {@link Semaphore} with `MAX_CONCURRENT_POLLS_PER_AGGREGATOR`
 *          permits.
 */
export function getAggregatorSemaphore(aggregatorId: string): Semaphore {
  const key = canonicalizeAggregatorId(aggregatorId);
  let sem = aggregatorSemaphores.get(key);
  if (sem === undefined) {
    sem = new CountingSemaphore(MAX_CONCURRENT_POLLS_PER_AGGREGATOR);
    aggregatorSemaphores.set(key, sem);
  }
  return sem;
}

/**
 * Test-only — clear the registry. Production code MUST NOT call this.
 *
 * Without this hook, parallel test files would observe state bleeding
 * across cases (semaphore permits exhausted by a prior test). Tests
 * that exercise the production fallback (no caller-injected semaphore)
 * MUST call this in `beforeEach` to restore a fresh budget per case.
 *
 * @internal
 */
export function __resetAggregatorSemaphoresForTesting(): void {
  aggregatorSemaphores.clear();
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
