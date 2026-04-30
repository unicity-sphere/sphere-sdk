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

import { MAX_CONCURRENT_POLLS_PER_AGGREGATOR } from './limits';
import {
  CountingSemaphore,
  type Semaphore,
} from './finalization-worker-sender';

// =============================================================================
// 1. Process-global registry
// =============================================================================

/**
 * Module-level registry. Keyed by `aggregatorId` — production wiring
 * uses the aggregator endpoint URL (or the `'default'` sentinel for
 * single-aggregator deployments). Lazily populated on first
 * {@link getAggregatorSemaphore} call per id.
 *
 * @internal
 */
const aggregatorSemaphores = new Map<string, Semaphore>();

/**
 * Return the process-global {@link Semaphore} for `aggregatorId`,
 * creating it on first access with the §6.1 / W14 default budget
 * ({@link MAX_CONCURRENT_POLLS_PER_AGGREGATOR}).
 *
 * Subsequent calls with the SAME `aggregatorId` return the SAME
 * semaphore instance — this is the load-bearing invariant that makes
 * the cap process-global.
 *
 * @param aggregatorId Aggregator endpoint identifier. Use the URL for
 *                     multi-aggregator deployments; default `'default'`
 *                     for single-aggregator wiring.
 * @returns A {@link Semaphore} with `MAX_CONCURRENT_POLLS_PER_AGGREGATOR`
 *          permits.
 */
export function getAggregatorSemaphore(aggregatorId: string): Semaphore {
  let sem = aggregatorSemaphores.get(aggregatorId);
  if (sem === undefined) {
    sem = new CountingSemaphore(MAX_CONCURRENT_POLLS_PER_AGGREGATOR);
    aggregatorSemaphores.set(aggregatorId, sem);
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
