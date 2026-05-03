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
  canonicalizeAggregatorId,
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

// =============================================================================
// Steelman finding #159 — URL canonicalization
// =============================================================================
//
// `'https://agg/'` and `'https://agg'` previously created TWO separate
// semaphores (each with the full 16-permit budget). Same for case
// differences in the host, default-port redundancy, and trailing
// fragments. With canonicalization in place, all these forms collapse
// to the same registry slot and the W14/W26 cap holds.

describe('canonicalizeAggregatorId — URL form collapsing', () => {
  it('strips trailing slash from path', () => {
    expect(canonicalizeAggregatorId('https://agg/')).toBe(
      canonicalizeAggregatorId('https://agg'),
    );
  });

  it('strips multiple trailing slashes', () => {
    expect(canonicalizeAggregatorId('https://agg///')).toBe(
      canonicalizeAggregatorId('https://agg'),
    );
  });

  it('lowercases the host', () => {
    expect(canonicalizeAggregatorId('https://Agg.Example')).toBe(
      canonicalizeAggregatorId('https://agg.example'),
    );
  });

  it('drops default https port (:443)', () => {
    expect(canonicalizeAggregatorId('https://agg:443/')).toBe(
      canonicalizeAggregatorId('https://agg'),
    );
  });

  it('drops default http port (:80)', () => {
    expect(canonicalizeAggregatorId('http://agg:80')).toBe(
      canonicalizeAggregatorId('http://agg'),
    );
  });

  it('drops query string and fragment', () => {
    expect(canonicalizeAggregatorId('https://agg?foo=bar#frag')).toBe(
      canonicalizeAggregatorId('https://agg'),
    );
  });

  it('preserves non-default port', () => {
    // Different port is a different endpoint — keep it.
    expect(canonicalizeAggregatorId('https://agg:9000')).not.toBe(
      canonicalizeAggregatorId('https://agg'),
    );
  });

  it('preserves non-trivial path', () => {
    // A real subpath is still significant; strip only trailing slashes.
    expect(canonicalizeAggregatorId('https://agg/v2/rpc/')).toBe(
      canonicalizeAggregatorId('https://agg/v2/rpc'),
    );
    expect(canonicalizeAggregatorId('https://agg/v2/rpc')).not.toBe(
      canonicalizeAggregatorId('https://agg'),
    );
  });

  it('passes through non-URL sentinels (default, fixture names) verbatim', () => {
    expect(canonicalizeAggregatorId('default')).toBe('default');
    expect(canonicalizeAggregatorId('shared-aggregator')).toBe('shared-aggregator');
  });

  it('returns trimmed verbatim on parse failure (no throw)', () => {
    // Whitespace handling: leading/trailing trim then verbatim.
    expect(canonicalizeAggregatorId('   shared-aggregator   ')).toBe('shared-aggregator');
  });
});

describe('aggregator-semaphores — URL canonicalization (#159)', () => {
  beforeEach(() => {
    __resetAggregatorSemaphoresForTesting();
  });

  it("'https://agg/' and 'https://agg' map to the SAME semaphore", () => {
    const a = getAggregatorSemaphore('https://agg/');
    const b = getAggregatorSemaphore('https://agg');
    expect(a).toBe(b);
    expect(__aggregatorSemaphoreRegistrySizeForTesting()).toBe(1);
  });

  it("case-only differences in host map to the SAME semaphore", () => {
    const a = getAggregatorSemaphore('https://Agg.Example/');
    const b = getAggregatorSemaphore('https://agg.example');
    expect(a).toBe(b);
    expect(__aggregatorSemaphoreRegistrySizeForTesting()).toBe(1);
  });

  it("default-port URL maps to bare-host URL", () => {
    const a = getAggregatorSemaphore('https://agg:443/');
    const b = getAggregatorSemaphore('https://agg');
    expect(a).toBe(b);
    expect(__aggregatorSemaphoreRegistrySizeForTesting()).toBe(1);
  });

  it("query/fragment differences collapse to the same key", () => {
    const a = getAggregatorSemaphore('https://agg?foo=bar');
    const b = getAggregatorSemaphore('https://agg#frag');
    const c = getAggregatorSemaphore('https://agg');
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(__aggregatorSemaphoreRegistrySizeForTesting()).toBe(1);
  });

  it("permit drain is observable across superficially-distinct URL forms", async () => {
    // The whole point of the fix: a multi-Sphere-instance client that
    // happens to spell its aggregator URL slightly differently across
    // instances MUST still be subject to the shared cap.
    const consumerA = getAggregatorSemaphore('https://agg/');
    const consumerB = getAggregatorSemaphore('https://agg');

    expect(consumerA.available).toBe(MAX_CONCURRENT_POLLS_PER_AGGREGATOR);
    expect(consumerB.available).toBe(MAX_CONCURRENT_POLLS_PER_AGGREGATOR);

    const releases: Array<() => void> = [];
    for (let i = 0; i < MAX_CONCURRENT_POLLS_PER_AGGREGATOR; i++) {
      releases.push(await consumerA.acquire());
    }
    expect(consumerB.available).toBe(0);
    for (const r of releases) r();
  });

  it("different real endpoints stay distinct", () => {
    // Sanity check the canonicalizer didn't over-collapse.
    const a = getAggregatorSemaphore('https://agg-a.example/');
    const b = getAggregatorSemaphore('https://agg-b.example/');
    expect(a).not.toBe(b);
    expect(__aggregatorSemaphoreRegistrySizeForTesting()).toBe(2);
  });
});
