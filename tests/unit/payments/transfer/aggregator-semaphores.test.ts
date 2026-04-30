/**
 * Process-global per-aggregator semaphore registry — invariant pins.
 *
 * Steelman post-cutover (W14): the semaphore enforcing
 * `MAX_CONCURRENT_POLLS_PER_AGGREGATOR` MUST be process-global per
 * aggregator URL, not per-Sphere-instance. Otherwise a client spinning
 * up multiple Sphere objects against the same aggregator trivially
 * bypasses the cap.
 *
 * The pinned invariants:
 *   1. Same aggregatorId → same Semaphore instance.
 *   2. Different aggregatorId → distinct Semaphore instances.
 *   3. Default cap matches `MAX_CONCURRENT_POLLS_PER_AGGREGATOR` (16).
 *   4. Permits depleted by one consumer are observable to another
 *      (proves shared state).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  __aggregatorSemaphoreRegistrySizeForTesting,
  __resetAggregatorSemaphoresForTesting,
  getAggregatorSemaphore,
} from '../../../../modules/payments/transfer/aggregator-semaphores';
import { MAX_CONCURRENT_POLLS_PER_AGGREGATOR } from '../../../../modules/payments/transfer/limits';

describe('aggregator-semaphores — process-global registry (W14)', () => {
  beforeEach(() => {
    __resetAggregatorSemaphoresForTesting();
  });

  it('same aggregatorId → same Semaphore instance (singleton)', () => {
    const a = getAggregatorSemaphore('https://aggregator.example');
    const b = getAggregatorSemaphore('https://aggregator.example');
    expect(a).toBe(b);
  });

  it('different aggregatorIds → distinct Semaphore instances', () => {
    const a = getAggregatorSemaphore('https://aggregator-a.example');
    const b = getAggregatorSemaphore('https://aggregator-b.example');
    expect(a).not.toBe(b);
    expect(__aggregatorSemaphoreRegistrySizeForTesting()).toBe(2);
  });

  it('default cap is MAX_CONCURRENT_POLLS_PER_AGGREGATOR', () => {
    const sem = getAggregatorSemaphore('default');
    expect(sem.available).toBe(MAX_CONCURRENT_POLLS_PER_AGGREGATOR);
  });

  it('permits depleted by one consumer are observable to another (shared state)', async () => {
    // Two callers reach for the same aggregatorId — they MUST observe
    // the same permit pool. This is the load-bearing invariant: a
    // multi-Sphere-instance client cannot bypass the cap by holding
    // separate semaphores.
    const consumerA = getAggregatorSemaphore('shared-aggregator');
    const consumerB = getAggregatorSemaphore('shared-aggregator');

    expect(consumerA.available).toBe(MAX_CONCURRENT_POLLS_PER_AGGREGATOR);
    expect(consumerB.available).toBe(MAX_CONCURRENT_POLLS_PER_AGGREGATOR);

    // Drain via consumer A.
    const releases: Array<() => void> = [];
    for (let i = 0; i < MAX_CONCURRENT_POLLS_PER_AGGREGATOR; i++) {
      releases.push(await consumerA.acquire());
    }

    // Consumer B sees zero available — the budget is shared.
    expect(consumerB.available).toBe(0);

    // Cleanup.
    for (const r of releases) r();
  });

  it('reset clears the registry (test-only escape hatch)', () => {
    getAggregatorSemaphore('a');
    getAggregatorSemaphore('b');
    expect(__aggregatorSemaphoreRegistrySizeForTesting()).toBe(2);
    __resetAggregatorSemaphoresForTesting();
    expect(__aggregatorSemaphoreRegistrySizeForTesting()).toBe(0);
  });
});
