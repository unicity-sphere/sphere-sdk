/**
 * Shared test helper: deterministically wait for the
 * `ProfileTokenStorageProvider` debounced flush pipeline to settle.
 *
 * Why this exists
 * ----------------
 * `provider.save(data)` and the various `scheduleFlush*` paths arm a
 * `setTimeout(flushDebounceMs)` and only later kick off the IPFS pin +
 * OrbitDB write body in `flush-scheduler.ts`. Tests that assert anything
 * dependent on that body completing (the bundle write, the pin call,
 * the operational state at `${addr}.tombstones` / `.invalidatedNametags`,
 * the pointer publish, etc.) MUST wait for the in-flight flush to fully
 * settle — not just for the debounce to elapse.
 *
 * The naive `await new Promise(r => setTimeout(r, flushDebounceMs + 100))`
 * is racy under full-suite worker contention: the debounce timer may not
 * have fired yet at wake-up, and the flush body's awaits (mocked `fetch`,
 * dynamic `import('UxfPackage.js')`) take real time. Originally surfaced
 * by issue #215 (`pointer-monotonicity.test.ts`) and again by #219
 * (`no-token-loss-tombstones.test.ts`).
 *
 * Strategy
 * --------
 * Poll the host's private `flushPromise` / `flushTimer` fields:
 *   - If a flush is in flight (`flushPromise != null`), `await` it.
 *   - If the timer is armed (`flushTimer != null`), wait briefly and re-check.
 *   - If both are null AND remain null across a short stability window,
 *     return — no scheduled work is pending.
 *
 * A timeout returns silently so callers can still proceed to assert
 * "nothing happened" without throwing. If the flush actually rejects
 * (`POINTER_MONOTONICITY_VIOLATION`, etc.), the rejection is swallowed
 * here — that's a normal completion path for some tests.
 *
 * Generic over the provider type so unit tests using mocked OrbitDB
 * implementations don't need to expose the full provider class.
 */

interface FlushPipelineHost {
  flushPromise: Promise<void> | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

export async function waitForFlushSettled(
  provider: unknown,
  deadlineMs = 2000,
): Promise<void> {
  const host = provider as FlushPipelineHost;
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (host.flushPromise) {
      try {
        await host.flushPromise;
      } catch {
        // Flush body may reject (POINTER_MONOTONICITY_VIOLATION etc.);
        // that's a normal completion path for some tests.
      }
      if (!host.flushTimer && !host.flushPromise) return;
      continue;
    }
    if (!host.flushTimer) {
      // Stability window — give a late-arming timer a moment to land.
      await new Promise((r) => setTimeout(r, 5));
      if (!host.flushTimer && !host.flushPromise) return;
      continue;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
