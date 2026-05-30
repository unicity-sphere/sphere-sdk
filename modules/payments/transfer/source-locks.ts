/**
 * Per-source in-memory lock registry — shared by both senders.
 *
 * The original implementation was a module-local in `instant-sender.ts`
 * (Wave 4 #171 / Wave 5–7 hardening). Audit #333 H1 surfaced that
 * `conservative-sender.ts` had no equivalent — two concurrent sends
 * sharing a source token could both pass selection, both publish, and
 * only the aggregator caught the duplicate-spend. Extracted here so
 * BOTH senders (and any future sender variant) serialize through the
 * SAME process-global map.
 *
 * The semantics are preserved verbatim from the original Wave 4 fix.
 * Existing tests import `__resetSourceLocksForTesting` from
 * `instant-sender.ts` for backwards compatibility — that file re-exports
 * the symbol from here.
 *
 * @module modules/payments/transfer/source-locks
 * @internal
 */

/**
 * Per-source in-memory lock registry — Wave 4 steelman fix #171 issue 1.
 *
 * **The race we close.** Wave 3's fix (#170) deferred `markSourcePending`
 * until AFTER `transport.sendTokenTransfer` succeeds. That eliminates the
 * "transport-fails-leaving-stuck-pending" failure mode, but introduces a
 * *same-process* double-spend window: two parallel `sendInstantUxf` /
 * `sendConservativeUxf` calls in the SAME Sphere instance may both
 * observe sources as `confirmed`/non-pending, both pass selection, both
 * publish via transport, and only THEN race to call `markSourcePending`.
 * The recipient receives BOTH bundles; the aggregator rejects the second
 * commitment as duplicate-spend; the sender's outbox holds one
 * `delivered-instant` and one entry that must transition to
 * `failed-permanent`.
 *
 * **The fix.** Acquire a per-tokenId mutex on every selected source
 * BEFORE source selection completes, hold it across the entire
 * selection→commit→transport→mark sequence, and release in `finally`.
 * Concurrent sends sharing any source token serialize through the lock;
 * sends with disjoint sources proceed concurrently as before.
 *
 * **Deadlock prevention.** Locks are acquired in lex-sorted order of
 * tokenId so two concurrent sends sharing tokens always agree on
 * acquisition order. Without the sort, send A (tokens [X, Y]) and send B
 * (tokens [Y, X]) could each hold one lock and wait forever for the
 * other.
 *
 * **Liveness floor.** A 60-second max-hold timeout fires if a lock is
 * held longer (e.g. transport hangs forever); the lock is force-released
 * with a `console.warn` so a stuck send cannot wedge unrelated future
 * sends. The original send still throws/recovers per its own error path.
 *
 * **Same-token-set re-entry.** A user genuinely sending the same source
 * twice in parallel (split mode for huge balances) is serialized by the
 * lock — by design. Document this if surfaced to API consumers.
 *
 * **Process-global state — Wave 5 steelman fix #171.** The `sourceLocks`
 * map is a MODULE-LEVEL singleton. Two `Sphere` instances running in the
 * same process share this map. In production this is benign: each wallet's
 * source tokenIds are HD-derived from a unique master key, so cross-wallet
 * collision is cryptographically improbable (the chance of a collision is
 * the chance of a public-key collision in the BIP-32 derivation tree).
 * Tests that drive multiple Sphere instances against fixed string tokenIds
 * MUST call {@link __resetSourceLocksForTesting} between cases to prevent
 * state bleed across tests; production callers MUST NOT invoke it.
 *
 * Spec refs: §6.1 sender-side semantics; §7.1 CRDT invariants (no
 * commitment may be observed by two outbox entries with overlapping
 * source-token sets).
 *
 * @internal
 */
const sourceLocks = new Map<string, Promise<void>>();

/**
 * Test-only escape hatch — clear the process-global {@link sourceLocks}
 * map. Wave 5 steelman fix #171: tests that exercise the lock behavior
 * (or otherwise touch {@link acquireSourceLocks}) MUST invoke this in
 * `beforeEach` so a hung/leaked lock from a prior test cannot wedge a
 * subsequent one. Production code MUST NOT call this — clearing locks
 * mid-flight would re-open the same-process double-spend window the
 * lock exists to close.
 *
 * Pending acquirers that are awaiting a cleared lock-promise will loop
 * once and observe the empty slot on the next microtask, then proceed
 * normally — they do not get rejected. Lock-promises themselves are
 * forgotten (the holder's release is a no-op against the absent slot).
 *
 * Wave 6 steelman fix: runtime guard. The export was previously
 * advisory-only ("MUST NOT" in JSDoc) — a production consumer doing
 * `import * as instantSender` could still invoke it and clear locks
 * mid-flight, re-opening the double-spend window.
 *
 * Wave 7 steelman fix: FAIL-CLOSED. The Wave 6 guard fired only when
 * `NODE_ENV === 'production'`. In browser bundles where `process` is
 * stripped, `typeof process === 'undefined'` evaluated false-y for the
 * outer condition and the reset proceeded — the exact attack the
 * function exists to prevent. The guard is now allow-list: reset is
 * forbidden by default everywhere, and only succeeds when the runtime
 * is provably a test environment (NODE_ENV explicitly === 'test', or
 * `SPHERE_ALLOW_TEST_RESET=1` for deliberate test harnesses).
 *
 * @internal
 */
export function __resetSourceLocksForTesting(): void {
  // Fail-closed: production / browser / unknown environments all reject.
  // Test environments must opt in. Browser bundles strip `process`, so
  // absence-of-process means "not in a test runner" — denying reset is
  // safer than the alternative.
  const isTestEnv =
    typeof process !== 'undefined' &&
    (process.env?.NODE_ENV === 'test' ||
      process.env?.SPHERE_ALLOW_TEST_RESET === '1');
  if (!isTestEnv) {
    throw new Error(
      '__resetSourceLocksForTesting is only available in test environments. ' +
        'Clearing locks mid-flight re-opens the same-process double-spend ' +
        'window the lock exists to close. Set NODE_ENV=test or ' +
        'SPHERE_ALLOW_TEST_RESET=1 to enable (testing only).',
    );
  }
  sourceLocks.clear();
}

/** Default max-hold for any single source lock. Configurable via the
 *  `maxHoldMs` parameter on {@link acquireSourceLocks} for testability. */
export const DEFAULT_LOCK_MAX_HOLD_MS = 60_000;

/**
 * Acquire locks on every supplied tokenId in lex-sorted order. Returns
 * a `release()` function that callers MUST invoke in `finally`.
 *
 * Each lock entry is a `Promise<void>` that resolves when the holder
 * releases. Subsequent acquirers loop until the slot is empty,
 * re-attempting after each prior holder's release. The
 * `Map.has`+`await`+`Map.set` sequence is safe because every
 * micro-tick between awaits checks the slot afresh — and ALL set
 * operations occur on the SAME microtask the await resumes on.
 *
 * @param tokenIds - sources to lock. Duplicates are deduped via Set.
 * @param maxHoldMs - liveness timeout. Defaults to {@link DEFAULT_LOCK_MAX_HOLD_MS}.
 * @param callerLabel - logging label used in the force-release warning
 *   (e.g. 'sendInstantUxf' or 'sendConservativeUxf'). Helps operators
 *   tell which sender wedged a lock when triaging force-release events.
 *
 * @internal
 */
export async function acquireSourceLocks(
  tokenIds: ReadonlyArray<string>,
  maxHoldMs: number = DEFAULT_LOCK_MAX_HOLD_MS,
  callerLabel: string = 'sender',
): Promise<() => void> {
  const sortedIds = [...new Set(tokenIds)].sort();
  const releases: Array<() => void> = [];
  for (const tokenId of sortedIds) {
    // Wait until the slot is empty. Each iteration awaits the prior
    // holder, then re-checks; if a third caller raced in we loop again.
    while (sourceLocks.has(tokenId)) {
      try {
        await sourceLocks.get(tokenId);
      } catch {
        // Prior holder rejected its lock-promise (it shouldn't, but
        // defense-in-depth). Loop and re-check.
      }
    }
    let releaseFn!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });
    sourceLocks.set(tokenId, lockPromise);

    // Per-lock liveness timer. If `release()` hasn't fired within
    // `maxHoldMs`, force-release with a warning so unrelated future
    // sends can proceed.
    let released = false;
    const timer = setTimeout(() => {
      if (!released && sourceLocks.get(tokenId) === lockPromise) {
        // eslint-disable-next-line no-console
        console.warn(
          `${callerLabel}: source lock for tokenId=${tokenId} held >${maxHoldMs}ms; ` +
            'force-releasing. The originating send may still complete its own error path, ' +
            'but unrelated future sends can now proceed.',
        );
        sourceLocks.delete(tokenId);
        releaseFn();
      }
    }, maxHoldMs);
    // The timer must NOT keep the Node.js event loop alive — pure
    // best-effort liveness, never a blocker for graceful shutdown.
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }

    releases.push(() => {
      released = true;
      clearTimeout(timer);
      // Only delete if the slot still references our lock-promise — a
      // force-release timer may have already evicted us.
      if (sourceLocks.get(tokenId) === lockPromise) {
        sourceLocks.delete(tokenId);
      }
      releaseFn();
    });
  }
  return () => {
    for (const release of releases) {
      release();
    }
  };
}
