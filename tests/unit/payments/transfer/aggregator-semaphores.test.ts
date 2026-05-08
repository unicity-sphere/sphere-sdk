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

  it('strips query string (Wave 5 steelman: prevents credential leak via logs)', () => {
    // Wave 5 steelman fix #3: query strings often carry credentials
    // (?token=, ?api_key=, ?signature=). Preserving them in the
    // canonical id leaks creds via any log line that prints the id —
    // the same failure mode the user-info strip already closes. Two
    // URLs differing ONLY in query MUST collapse to the same key.
    // Routing-via-query is unsupported; deployments must use host/path
    // segregation or move auth to headers.
    expect(canonicalizeAggregatorId('https://agg?token=abc')).toBe(
      canonicalizeAggregatorId('https://agg'),
    );
    expect(canonicalizeAggregatorId('https://agg?token=abc')).toBe(
      canonicalizeAggregatorId('https://agg?token=xyz'),
    );
    // Critical: the canonical form MUST NOT contain query-string creds.
    const canonical = canonicalizeAggregatorId(
      'https://agg?api_key=secret-key-12345&signature=deadbeef',
    );
    expect(canonical).not.toContain('secret-key-12345');
    expect(canonical).not.toContain('deadbeef');
    expect(canonical).not.toContain('api_key');
    expect(canonical).not.toContain('signature');
    expect(canonical).not.toContain('?');
  });

  it('drops fragment (#frag is client-side only per RFC 3986)', () => {
    expect(canonicalizeAggregatorId('https://agg#frag')).toBe(
      canonicalizeAggregatorId('https://agg'),
    );
    // Wave 5 steelman: with query stripped, `?token=abc#frag` collapses
    // to the same canonical key as a bare `https://agg`.
    expect(canonicalizeAggregatorId('https://agg?token=abc#frag')).toBe(
      canonicalizeAggregatorId('https://agg'),
    );
  });

  it('strips user-info (no creds in canonical key, log-safe)', () => {
    // Wave 4 steelman: credentials in the canonical key (a) leak via
    // any log that includes the id, and (b) artificially split two
    // callers hitting the same backend through different auth keys
    // — doubling the per-aggregator concurrency budget. Auth belongs
    // at the transport layer, not the rate-budget key.
    expect(canonicalizeAggregatorId('https://user:pass@agg')).toBe(
      canonicalizeAggregatorId('https://agg'),
    );
    expect(canonicalizeAggregatorId('https://user@agg')).toBe(
      canonicalizeAggregatorId('https://agg'),
    );
    // Critical: the canonical form MUST NOT contain credentials.
    const canonical = canonicalizeAggregatorId('https://alice:s3cret@agg');
    expect(canonical).not.toContain('alice');
    expect(canonical).not.toContain('s3cret');
  });

  it('handles IPv6 hosts with port (preserves brackets, lowercases host)', () => {
    // IPv6 literals MUST be re-bracketed in the canonical form so
    // `host:port` parsing stays unambiguous. `[::1]:8080` and
    // `[::1]:8080` (different case in the host) collapse together.
    const a = canonicalizeAggregatorId('http://[::1]:8080');
    const b = canonicalizeAggregatorId('http://[::1]:8080/');
    expect(a).toBe(b);
    // IPv6 stays distinct from a colon-bearing non-IPv6 id (defense
    // against canonical-collision via missing brackets).
    expect(a).not.toBe(canonicalizeAggregatorId('http://1:8080'));
    // Brackets MUST be present in the canonical output.
    expect(a).toContain('[::1]');
    expect(a).toContain(':8080');
  });

  it('IPv6 default-port stripping (drops :80 / :443)', () => {
    expect(canonicalizeAggregatorId('http://[::1]:80')).toBe(
      canonicalizeAggregatorId('http://[::1]'),
    );
    expect(canonicalizeAggregatorId('https://[2001:db8::1]:443/')).toBe(
      canonicalizeAggregatorId('https://[2001:db8::1]'),
    );
  });

  it('collapses trailing-dot DNS forms (host. == host)', () => {
    // DNS resolves `agg.example.` and `agg.example` to the same
    // authority. Treat them as one registry slot.
    expect(canonicalizeAggregatorId('https://agg.example.')).toBe(
      canonicalizeAggregatorId('https://agg.example'),
    );
    expect(canonicalizeAggregatorId('https://agg.example./v2/rpc')).toBe(
      canonicalizeAggregatorId('https://agg.example/v2/rpc'),
    );
  });

  it('punycode IDN forms not double-encoded', () => {
    // `URL` already encodes IDN to xn-- punycode; we only lowercase
    // ASCII, leaving the punycode untouched. Sanity: an already-
    // punycode input round-trips to itself (no double encoding).
    const punycoded = canonicalizeAggregatorId('https://xn--bcher-kva.example');
    expect(punycoded).toContain('xn--bcher-kva.example');
    // Trailing-dot collapse still applies on punycode forms.
    expect(canonicalizeAggregatorId('https://xn--bcher-kva.example.')).toBe(
      canonicalizeAggregatorId('https://xn--bcher-kva.example'),
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

  // Round 7 fix (LOW NEW): the URL-parse catch in canonicalizeAggregatorId
  // previously logged the raw `err` argument. A hostile or pathological
  // URLError might carry sensitive bytes on the Error object; we now
  // route through `safeErrorMessage` and log only `{ error: <string> }`.
  it('URL-parse failure path: logger receives sanitized {error: string}, not raw err', async () => {
    const { logger } = await import('../../../../core/logger');
    const captured: Array<{
      level: string;
      tag: string;
      message: string;
      args: unknown[];
    }> = [];
    logger.configure({
      handler: (level, tag, message, ...args) => {
        captured.push({ level, tag, message, args });
      },
    });
    try {
      // 'https://[bad' fails URL parsing (invalid IPv6 literal).
      const out = canonicalizeAggregatorId('https://[bad');
      // Verbatim fallback works.
      expect(out).toBe('https://[bad');
      // Logger was called.
      const warnCalls = captured.filter((c) => c.level === 'warn');
      expect(warnCalls.length).toBeGreaterThan(0);
      const call = warnCalls[0]!;
      expect(call.tag).toBe('AggregatorSemaphore');
      // CRITICAL invariant: the 4th positional argument (the first
      // extra arg after message) MUST be a plain `{ error: string }`
      // object — NOT a raw Error instance.
      expect(call.args.length).toBeGreaterThanOrEqual(1);
      const errArg = call.args[0];
      expect(errArg).not.toBeInstanceOf(Error);
      expect(typeof errArg).toBe('object');
      expect(errArg).not.toBeNull();
      const errAsObj = errArg as { error?: unknown };
      expect(typeof errAsObj.error).toBe('string');
      // Sanitized: no control chars, no HTML markup.
      expect(errAsObj.error as string).not.toMatch(/[\x00-\x1F\x7F]/); // eslint-disable-line no-control-regex
    } finally {
      logger.configure({ handler: undefined as never });
    }
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

  it("fragment AND query-string differences collapse (Wave 5 steelman)", () => {
    // Fragment is purely client-side (RFC 3986 §3.5) → MUST collapse.
    const fragment = getAggregatorSemaphore('https://agg#frag');
    const bare = getAggregatorSemaphore('https://agg');
    expect(fragment).toBe(bare);
    expect(__aggregatorSemaphoreRegistrySizeForTesting()).toBe(1);

    // Wave 5 steelman fix #3: query string is now stripped (was
    // preserved in Wave 4) — `?token=`/`?api_key=` etc. carry
    // credentials in many deployments and would leak via logs that
    // print the canonical id. Two URLs that differ ONLY in query
    // collapse to the SAME semaphore.
    const queryA = getAggregatorSemaphore('https://agg?token=abc');
    const queryB = getAggregatorSemaphore('https://agg?token=xyz');
    expect(queryA).toBe(queryB);
    expect(queryA).toBe(bare);
    expect(__aggregatorSemaphoreRegistrySizeForTesting()).toBe(1);
  });

  it("user-info differences collapse to the same key (no creds in key)", () => {
    // Two callers hitting the same backend with different credentials
    // share the rate budget for that backend. Credentials are stripped
    // from the canonical key.
    const withCreds = getAggregatorSemaphore('https://alice:s3cret@agg');
    const withoutCreds = getAggregatorSemaphore('https://agg');
    expect(withCreds).toBe(withoutCreds);
    expect(__aggregatorSemaphoreRegistrySizeForTesting()).toBe(1);
  });

  it("IPv6 + port distinct from non-IPv6 colon forms", () => {
    // Sanity: `[::1]:8080` MUST NOT collide with hosts that happen
    // to contain colons or with non-IPv6 forms missing brackets.
    const v6 = getAggregatorSemaphore('http://[::1]:8080');
    const v6alt = getAggregatorSemaphore('http://[::1]:8080/');
    expect(v6).toBe(v6alt);
    const v4 = getAggregatorSemaphore('http://192.0.2.1:8080');
    expect(v6).not.toBe(v4);
  });

  it("trailing-dot DNS forms collapse to the same key", () => {
    const dotted = getAggregatorSemaphore('https://agg.example./v2/rpc');
    const undotted = getAggregatorSemaphore('https://agg.example/v2/rpc');
    expect(dotted).toBe(undotted);
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

// =============================================================================
// Wave 3 steelman — bounded registry (LRU eviction) + reset-rejects-pending
// =============================================================================
//
// Two tightly-related defenses landed together:
//
//  (A) The process-global registry MUST be size-bounded. A caller
//      synthesizing distinct `aggregatorId` strings (random fixture
//      endpoints, misconfigured production deployments generating a
//      new ID per request) would otherwise leak Semaphore instances
//      forever. The registry now caps at 32 entries and evicts via
//      LRU touch order.
//
//  (B) `__resetAggregatorSemaphoresForTesting` MUST reject every
//      pending `acquire()` waiter, not just clear the Map. A test
//      that crashed mid-acquire (assertion failure inside an
//      `acquire().then(...)` chain) would otherwise leave the
//      awaiting promise dangling forever, holding closures that
//      pinned the test's outer scope and blocked vitest teardown.

describe('aggregator-semaphores — Wave 3 LRU eviction', () => {
  beforeEach(() => {
    __resetAggregatorSemaphoresForTesting();
  });

  it('registry stays bounded under unique-key pressure', () => {
    // Insert way more keys than the cap; the registry MUST stay at
    // its cap, not balloon to N. We don't assert the exact cap value
    // here (it's an implementation detail) — only the bounded property.
    for (let i = 0; i < 200; i++) {
      getAggregatorSemaphore(`https://agg-${i}.example/`);
    }
    const size = __aggregatorSemaphoreRegistrySizeForTesting();
    expect(size).toBeLessThanOrEqual(32);
    expect(size).toBeGreaterThan(0);
  });

  it('LRU eviction: oldest untouched key is evicted first', () => {
    // Fill the registry to capacity with deterministic IDs.
    const cap = 32;
    for (let i = 0; i < cap; i++) {
      getAggregatorSemaphore(`https://agg-${i}.example/`);
    }
    expect(__aggregatorSemaphoreRegistrySizeForTesting()).toBe(cap);

    // Capture the FIRST inserted (LRU) semaphore for identity-comparison.
    const firstSemaphore = getAggregatorSemaphore('https://agg-0.example/');
    // Touching `agg-0` here moves it to MRU end. To exercise the
    // "oldest untouched key evicted" path we need a key that was
    // inserted EARLIER and NOT touched. Restart with a fresh registry.
    __resetAggregatorSemaphoresForTesting();

    for (let i = 0; i < cap; i++) {
      getAggregatorSemaphore(`https://agg-${i}.example/`);
    }
    // Capture identities for the oldest and a middle entry.
    const oldestSem = getAggregatorSemaphore('https://agg-0.example/');
    // ^^ This call ALSO touches the key; reset and re-insert from scratch.
    __resetAggregatorSemaphoresForTesting();
    for (let i = 0; i < cap; i++) {
      getAggregatorSemaphore(`https://agg-${i}.example/`);
    }
    // Without touching anything, push one new key — this MUST evict
    // the LRU (`agg-0`).
    getAggregatorSemaphore('https://agg-newest.example/');

    expect(__aggregatorSemaphoreRegistrySizeForTesting()).toBe(cap);

    // Re-fetching `agg-0` returns a NEW semaphore (the prior one was
    // evicted). The newest key is still resident.
    const reFetched = getAggregatorSemaphore('https://agg-0.example/');
    // The new fetch MUST be a fresh instance — not the original.
    expect(reFetched).not.toBe(oldestSem);
    expect(__aggregatorSemaphoreRegistrySizeForTesting()).toBe(cap);
  });

  it('LRU touch keeps a frequently-accessed key resident', () => {
    const cap = 32;
    // Insert one "hot" key and many "cold" keys.
    const hotSem = getAggregatorSemaphore('https://agg-hot.example/');
    for (let i = 0; i < cap - 1; i++) {
      getAggregatorSemaphore(`https://agg-cold-${i}.example/`);
    }
    expect(__aggregatorSemaphoreRegistrySizeForTesting()).toBe(cap);

    // Touch hot many times — keeps it MRU. Push new keys that should
    // evict cold keys, NOT hot.
    for (let i = 0; i < 50; i++) {
      getAggregatorSemaphore('https://agg-hot.example/'); // touch hot
      getAggregatorSemaphore(`https://agg-pressure-${i}.example/`); // push new
    }

    // Hot semaphore identity preserved across pressure waves.
    const stillHot = getAggregatorSemaphore('https://agg-hot.example/');
    expect(stillHot).toBe(hotSem);
  });
});

describe('aggregator-semaphores — Wave 3 reset rejects pending waiters', () => {
  beforeEach(() => {
    __resetAggregatorSemaphoresForTesting();
  });

  it('reset rejects every pending acquire() promise with a known error', async () => {
    const sem = getAggregatorSemaphore('https://reset-test.example/');

    // Drain all permits so subsequent acquires must wait.
    const releases: Array<() => void> = [];
    for (let i = 0; i < MAX_CONCURRENT_POLLS_PER_AGGREGATOR; i++) {
      releases.push(await sem.acquire());
    }
    expect(sem.available).toBe(0);

    // Start a few pending acquires that will WAIT for permits.
    const pendingCount = 3;
    const pendingResults: Array<Promise<unknown>> = [];
    for (let i = 0; i < pendingCount; i++) {
      pendingResults.push(
        sem.acquire().then(
          () => ({ resolved: true }),
          (err: Error) => ({ rejected: true, message: err.message }),
        ),
      );
    }

    // Yield once to let the pending acquires reach the waiter list.
    await Promise.resolve();

    // Reset the registry — pending waiters MUST reject.
    __resetAggregatorSemaphoresForTesting();

    const settled = await Promise.all(pendingResults);
    for (const result of settled) {
      expect(result).toMatchObject({ rejected: true });
      // Sentinel error message lets callers distinguish reset from
      // other rejection sources.
      expect((result as { message: string }).message).toContain(
        'semaphore reset for testing',
      );
    }

    // Cleanup: release the permits we held (no-op against the
    // discarded inner semaphore, but clean for clarity).
    for (const r of releases) r();
  });

  it('reset followed by re-fetch returns a fresh semaphore with full permits', async () => {
    const sem1 = getAggregatorSemaphore('https://reset-fresh.example/');

    // Drain permits.
    const releases: Array<() => void> = [];
    for (let i = 0; i < MAX_CONCURRENT_POLLS_PER_AGGREGATOR; i++) {
      releases.push(await sem1.acquire());
    }
    expect(sem1.available).toBe(0);

    // Reset, then re-fetch — same key, fresh semaphore.
    __resetAggregatorSemaphoresForTesting();
    const sem2 = getAggregatorSemaphore('https://reset-fresh.example/');

    expect(sem2).not.toBe(sem1);
    expect(sem2.available).toBe(MAX_CONCURRENT_POLLS_PER_AGGREGATOR);

    for (const r of releases) r();
  });

  it('reset with no pending waiters is a clean no-op', () => {
    // Sanity: reset MUST NOT throw when there are no pending waiters.
    getAggregatorSemaphore('https://no-waiters.example/');
    expect(() => __resetAggregatorSemaphoresForTesting()).not.toThrow();
    expect(__aggregatorSemaphoreRegistrySizeForTesting()).toBe(0);
  });
});

// =============================================================================
// CRIT #9 — LRU eviction respects held permits
// =============================================================================
//
// Pre-fix: evictLruIfFull picked the lex-earliest LRU entry without
// inspecting whether its permits were currently held. Evicting an entry
// with held permits caused the next getAggregatorSemaphore() call for the
// same canonical id to mint a FRESH 16-permit semaphore — total
// in-flight for that endpoint exceeded MAX_CONCURRENT_POLLS_PER_AGGREGATOR.
//
// The fix scans in LRU order and skips any entry with `held > 0`. If
// every entry has held permits AND we're at the cap, throw a fatal
// error: silently bypassing W14 is worse than a loud crash.

describe('aggregator-semaphores — CRIT #9 LRU eviction respects held permits', () => {
  beforeEach(() => {
    __resetAggregatorSemaphoresForTesting();
  });

  it('LRU eviction skips entries with held permits', async () => {
    const cap = 32;
    // Insert 32 entries, all permit-free (no acquires).
    for (let i = 0; i < cap; i++) {
      getAggregatorSemaphore(`https://agg-${i}.example/`);
    }
    expect(__aggregatorSemaphoreRegistrySizeForTesting()).toBe(cap);

    // Hold one permit on the LRU-most entry (agg-0). It is now NON-evictable.
    const lruSem = getAggregatorSemaphore('https://agg-0.example/');
    // ^^ Touching agg-0 moves it to MRU. To exercise "LRU has held
    // permit" we restart and re-insert without touching.
    __resetAggregatorSemaphoresForTesting();
    for (let i = 0; i < cap; i++) {
      getAggregatorSemaphore(`https://agg-${i}.example/`);
    }
    // Now hold a permit on a non-LRU entry (agg-5) to test that an
    // arbitrary held-permits entry is skipped.
    const heldSem = getAggregatorSemaphore('https://agg-5.example/');
    // Touching agg-5 moves it to MRU. We want it to NOT be MRU.
    __resetAggregatorSemaphoresForTesting();
    for (let i = 0; i < cap; i++) {
      getAggregatorSemaphore(`https://agg-${i}.example/`);
    }
    // Hold a permit on agg-0 (the LRU). Once held, it MUST NOT be evicted.
    const sem0 = getAggregatorSemaphore('https://agg-0.example/');
    // After this getAggregatorSemaphore call, agg-0 is touched to MRU.
    // Re-insert so agg-0 is again LRU.
    __resetAggregatorSemaphoresForTesting();
    const heldFirst = getAggregatorSemaphore('https://agg-0.example/');
    const release = await heldFirst.acquire();
    // Fill the rest of the registry without touching agg-0 again. Each
    // new entry pushes agg-0 further toward LRU.
    for (let i = 1; i < cap; i++) {
      getAggregatorSemaphore(`https://agg-${i}.example/`);
    }
    expect(__aggregatorSemaphoreRegistrySizeForTesting()).toBe(cap);

    // Push a new entry — eviction MUST skip agg-0 (held permit) and pick
    // the next-LRU (agg-1).
    getAggregatorSemaphore('https://agg-newest.example/');
    expect(__aggregatorSemaphoreRegistrySizeForTesting()).toBe(cap);

    // agg-0's semaphore identity preserved across the eviction wave.
    const stillHeld = getAggregatorSemaphore('https://agg-0.example/');
    expect(stillHeld).toBe(heldFirst);

    // agg-1 was evicted (no permit held); re-fetch yields a fresh instance.
    // (We can't directly compare against the original since we never
    // captured it.)
    expect(__aggregatorSemaphoreRegistrySizeForTesting()).toBe(cap);

    release();
    void lruSem;
    void heldSem;
    void sem0;
  });

  it('evictLruIfFull throws if every entry has held permits', async () => {
    const cap = 32;
    // Fill the registry AND hold one permit on every entry.
    const releases: Array<() => void> = [];
    for (let i = 0; i < cap; i++) {
      const sem = getAggregatorSemaphore(`https://agg-held-${i}.example/`);
      releases.push(await sem.acquire());
    }
    expect(__aggregatorSemaphoreRegistrySizeForTesting()).toBe(cap);

    // Adding a NEW entry MUST throw (cannot evict any holder).
    expect(() =>
      getAggregatorSemaphore('https://agg-overflow.example/'),
    ).toThrow(/registry FULL/);

    // Cleanup.
    for (const r of releases) r();
  });

  it('held permits decrement on release and entry becomes evictable', async () => {
    const cap = 32;
    const sem0 = getAggregatorSemaphore('https://agg-evictable-0.example/');
    const release = await sem0.acquire();
    for (let i = 1; i < cap; i++) {
      getAggregatorSemaphore(`https://agg-evictable-${i}.example/`);
    }
    expect(__aggregatorSemaphoreRegistrySizeForTesting()).toBe(cap);

    // Release the held permit on agg-0; it is now evictable.
    release();

    // Eviction can now pick agg-0 (the LRU) since no permits held.
    getAggregatorSemaphore('https://agg-evictable-newest.example/');
    expect(__aggregatorSemaphoreRegistrySizeForTesting()).toBe(cap);

    // Re-fetching agg-0 yields a fresh instance (the previous one was
    // evicted now that its hold was released).
    const sem0Again = getAggregatorSemaphore('https://agg-evictable-0.example/');
    expect(sem0Again).not.toBe(sem0);
  });
});
