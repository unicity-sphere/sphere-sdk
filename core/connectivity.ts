/**
 * Connectivity Manager (Issue #312)
 *
 * A unified `sphere.connectivity` surface that tells the UI whether each
 * backend is reachable, gates the send-path when the user is offline, and
 * re-pings on backoff so the wallet transitions to online as soon as all
 * backends recover.
 *
 * Backends in scope: `aggregator`, `ipfs`, `nostr`. Fulcrum / L1 is
 * explicitly out of scope per the project owner.
 *
 * Each backend has a dedicated {@link Pinger} that runs a cheap probe on a
 * backoff schedule: 5 s → 15 s → 60 s → 5 m, reset to 5 s on success. The
 * manager aggregates per-pinger status into a {@link ConnectivityStatus}
 * snapshot and notifies subscribers + emits events on the Sphere bus on
 * every transition.
 *
 * Construction does NOT block — initial status is `'unknown'` until the
 * first probe lands, and `start()` schedules the first probe asynchronously.
 */

import { logger } from './logger';
import { SphereError } from './errors';

// =============================================================================
// Public types
// =============================================================================

export type ConnectivityBackend = 'aggregator' | 'ipfs' | 'nostr';
export type ConnectivityBackendStatus = 'up' | 'down' | 'degraded' | 'unknown';

/**
 * Snapshot of per-backend reachability state.
 *
 * `lastOnlineAt` is the ms-epoch of the most recent moment where all three
 * backends were simultaneously `'up'`. Null until that has ever happened in
 * this Sphere lifetime.
 *
 * `lastChangedAt` is the ms-epoch of the most recent backend transition
 * (any backend, any direction).
 */
export interface ConnectivityStatus {
  readonly aggregator: ConnectivityBackendStatus;
  readonly ipfs: ConnectivityBackendStatus;
  readonly nostr: ConnectivityBackendStatus;
  readonly lastOnlineAt: number | null;
  readonly lastChangedAt: number;
}

/** A no-arg subscriber that receives the new status on every transition. */
export type ConnectivitySubscriber = (status: ConnectivityStatus) => void;

/**
 * Result of a single ping probe.
 *
 * - `'up'`     — probe succeeded fully.
 * - `'degraded'`— probe succeeded but signalled partial trouble (e.g. an
 *                 HTTP 200 with a stale block height, or a gateway slower
 *                 than the soft timeout). The backend is still considered
 *                 usable; the send-path does NOT gate on degraded.
 * - `'down'`   — probe failed (network error, timeout, non-success HTTP).
 */
export type PingResult = 'up' | 'down' | 'degraded';

/**
 * A backend-specific reachability probe.
 *
 * Implementations MUST be safe to call concurrently and MUST resolve within
 * a reasonable bound — the manager runs probes with a wall-clock timeout
 * but a probe that holds a syscall open past that timeout will simply have
 * its result discarded (the manager continues; the next scheduled probe
 * fires per the backoff).
 */
export interface Pinger {
  readonly backend: ConnectivityBackend;
  ping(signal: AbortSignal): Promise<PingResult>;
}

// =============================================================================
// Manager configuration
// =============================================================================

/**
 * Default backoff schedule in ms: 5 s → 15 s → 60 s → 5 m. After the last
 * step the manager continues polling at the final interval (5 minutes)
 * until a success resets the schedule back to step 0.
 *
 * On every successful probe (`'up'` or `'degraded'`) the per-backend
 * schedule resets to step 0. `'degraded'` is treated as "reachable but
 * slow" — it does NOT extend the backoff.
 */
export const DEFAULT_BACKOFF_SCHEDULE_MS: ReadonlyArray<number> = [
  5_000,
  15_000,
  60_000,
  300_000,
] as const;

/** Default per-probe wall-clock timeout. Probes that exceed this resolve as
 *  `'down'`. */
export const DEFAULT_PING_TIMEOUT_MS = 8_000;

/**
 * Default number of consecutive `'down'` probe results required before the
 * manager flips a backend's status to `'down'` (Issue #424).
 *
 * The intent is to absorb single transient blips — a TCP RST, a DNS hiccup,
 * a one-off undici `fetch failed` — without flipping the public status. A
 * sustained outage will still flip after this many consecutive failures.
 *
 * Recovery is asymmetric: a single successful probe (`'up'` or `'degraded'`)
 * resets the counter AND flips the status immediately. Failure is patient;
 * recovery is fast.
 */
export const DEFAULT_FAILURE_THRESHOLD = 2;

export interface ConnectivityManagerConfig {
  /** Probe schedule. Defaults to {@link DEFAULT_BACKOFF_SCHEDULE_MS}. */
  readonly backoffScheduleMs?: ReadonlyArray<number>;
  /** Per-probe wall-clock timeout. Defaults to {@link DEFAULT_PING_TIMEOUT_MS}. */
  readonly pingTimeoutMs?: number;
  /**
   * Number of consecutive `'down'` probe results required before the manager
   * flips a backend's status to `'down'`. Defaults to
   * {@link DEFAULT_FAILURE_THRESHOLD}. Must be >= 1; a value of 1 means
   * "flip on the first failure" (the legacy pre-#424 behaviour).
   *
   * Applies to ALL backends uniformly. The counter is reset to 0 on every
   * successful (`'up'` or `'degraded'`) result, so a flaky alternate-success
   * stream never accumulates enough consecutive failures to flip.
   */
  readonly failureThreshold?: number;
  /**
   * Event-emit hook. The manager calls this with three event types:
   *
   *   - `'connectivity:changed'` on every backend transition (snapshot payload).
   *   - `'connectivity:online'` when all three backends transition to `'up'`.
   *   - `'connectivity:offline-degraded'` when at least one backend becomes `'down'`.
   *
   * Errors thrown by the emit hook are caught and logged — they MUST NOT
   * disrupt the connectivity manager's scheduling.
   */
  readonly emitEvent?: (
    type: 'connectivity:changed' | 'connectivity:online' | 'connectivity:offline-degraded',
    payload: ConnectivityStatus,
  ) => void;
}

// =============================================================================
// Public manager API
// =============================================================================

export interface ConnectivityManagerHandle {
  /** Current snapshot. Sync, never throws. */
  status(): ConnectivityStatus;
  /** Subscribe to per-transition snapshots. Returns an unsubscribe fn. */
  subscribe(fn: ConnectivitySubscriber): () => void;
  /**
   * Force an immediate probe of one or all backends. The returned promise
   * resolves when the probe(s) have settled. Force-probes do not bypass
   * the backoff schedule — they simply piggy-back on the next-fire slot
   * and reset the backoff on success.
   */
  ping(which: ConnectivityBackend | 'all'): Promise<void>;
}

// =============================================================================
// Implementation
// =============================================================================

interface PerBackendState {
  status: ConnectivityBackendStatus;
  backoffStep: number;
  /** Timer handle for the next scheduled probe. Null while a probe is
   *  in-flight or after stop(). */
  timer: ReturnType<typeof setTimeout> | null;
  /** Promise that resolves when the currently-running probe settles. */
  inFlight: Promise<void> | null;
  /** AbortController for the in-flight probe (used to cancel on stop()). */
  abort: AbortController | null;
  /**
   * Issue #424: consecutive `'down'` probe results since the last `'up'` or
   * `'degraded'`. Saturates at `failureThreshold` to avoid unbounded growth
   * on a long-running offline wallet; we only ever care whether the counter
   * has met the threshold. Reset to 0 on any successful result.
   */
  consecutiveFailures: number;
}

export class ConnectivityManager implements ConnectivityManagerHandle {
  private readonly pingers: Map<ConnectivityBackend, Pinger>;
  private readonly states: Map<ConnectivityBackend, PerBackendState>;
  private readonly subscribers: Set<ConnectivitySubscriber> = new Set();
  private readonly schedule: ReadonlyArray<number>;
  private readonly pingTimeoutMs: number;
  private readonly failureThreshold: number;
  private readonly emitEvent: ConnectivityManagerConfig['emitEvent'];

  private lastOnlineAt: number | null = null;
  private lastChangedAt: number = Date.now();
  private wasOnline: boolean = false;
  /** Stable null-snapshot returned by `.status()` while no pingers exist. */
  private cachedSnapshot: ConnectivityStatus;
  private destroyed: boolean = false;
  private started: boolean = false;

  constructor(pingers: ReadonlyArray<Pinger>, config?: ConnectivityManagerConfig) {
    this.pingers = new Map();
    this.states = new Map();
    for (const p of pingers) {
      // Last-wins on duplicate backends — a caller error, but we don't
      // throw here because the manager is wired during init and a throw
      // would brick Sphere.init().
      this.pingers.set(p.backend, p);
      this.states.set(p.backend, {
        status: 'unknown',
        backoffStep: 0,
        timer: null,
        inFlight: null,
        abort: null,
        consecutiveFailures: 0,
      });
    }
    this.schedule = config?.backoffScheduleMs ?? DEFAULT_BACKOFF_SCHEDULE_MS;
    if (this.schedule.length === 0) {
      throw new SphereError(
        'ConnectivityManager: backoffScheduleMs must have at least one step',
        'INVALID_CONFIG',
      );
    }
    this.pingTimeoutMs = config?.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
    const ft = config?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    if (!Number.isFinite(ft) || ft < 1 || !Number.isInteger(ft)) {
      throw new SphereError(
        'ConnectivityManager: failureThreshold must be a positive integer (>= 1)',
        'INVALID_CONFIG',
      );
    }
    this.failureThreshold = ft;
    this.emitEvent = config?.emitEvent;
    this.cachedSnapshot = this.buildSnapshot();
  }

  /**
   * Start the periodic probe schedule. Each backend's first probe fires
   * immediately on a microtask (not a setTimeout) so callers can observe
   * the initial transition out of `'unknown'` quickly, but the call itself
   * is sync — it does NOT block on the probe.
   *
   * Safe to call more than once; only the first call has effect.
   */
  start(): void {
    if (this.started || this.destroyed) return;
    this.started = true;
    for (const backend of this.pingers.keys()) {
      // Fire the first probe immediately. Wrapped in a microtask so the
      // caller sees `.status()` return `'unknown'` for all backends right
      // after init() returns (the design constraint).
      queueMicrotask(() => {
        if (!this.destroyed) {
          void this.runProbe(backend);
        }
      });
    }
  }

  /**
   * Tear down all schedules and abort any in-flight probes. After stop()
   * the manager is inert: `.status()` continues to return the last snapshot,
   * `.subscribe()` returns a no-op unsubscribe, `.ping()` resolves
   * immediately without scheduling work.
   */
  async stop(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    const inFlights: Promise<void>[] = [];
    for (const state of this.states.values()) {
      if (state.timer !== null) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      if (state.abort) {
        try { state.abort.abort(); } catch { /* ignore */ }
      }
      if (state.inFlight) {
        inFlights.push(state.inFlight.catch(() => undefined));
      }
    }

    await Promise.all(inFlights);
    this.subscribers.clear();
  }

  status(): ConnectivityStatus {
    return this.cachedSnapshot;
  }

  subscribe(fn: ConnectivitySubscriber): () => void {
    if (this.destroyed) return () => undefined;
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  async ping(which: ConnectivityBackend | 'all'): Promise<void> {
    if (this.destroyed) return;
    const targets: ConnectivityBackend[] =
      which === 'all'
        ? Array.from(this.pingers.keys())
        : this.pingers.has(which)
          ? [which]
          : [];
    const ps: Promise<void>[] = [];
    for (const backend of targets) {
      ps.push(this.runProbe(backend));
    }
    await Promise.all(ps);
  }

  // ===========================================================================
  // Internal: probe scheduling
  // ===========================================================================

  private async runProbe(backend: ConnectivityBackend): Promise<void> {
    if (this.destroyed) return;
    const state = this.states.get(backend);
    const pinger = this.pingers.get(backend);
    if (!state || !pinger) return;
    // Coalesce concurrent probes — if one is already in flight, wait for
    // it instead of stacking. This is what makes `ping('all')` safe under
    // a stream of subscriber-triggered force-probes.
    if (state.inFlight) {
      await state.inFlight;
      return;
    }
    // Clear any pending timer — the probe that lands now satisfies the
    // schedule slot.
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    const abort = new AbortController();
    state.abort = abort;

    const probeRun = this.runProbeInner(backend, pinger, abort.signal)
      .finally(() => {
        state.inFlight = null;
        state.abort = null;
        if (!this.destroyed) {
          this.scheduleNext(backend);
        }
      });

    state.inFlight = probeRun;
    await probeRun;
  }

  private async runProbeInner(
    backend: ConnectivityBackend,
    pinger: Pinger,
    signal: AbortSignal,
  ): Promise<void> {
    let result: PingResult = 'down';
    try {
      result = await this.withTimeout(pinger.ping(signal), this.pingTimeoutMs, signal);
    } catch (err) {
      // Steelman: a Pinger that throws synchronously is treated as 'down'.
      // We do not let a throwing probe break the schedule.
      logger.debug('Connectivity', `[${backend}] probe threw: ${safeErr(err)}`);
      result = 'down';
    }
    if (this.destroyed) return;
    this.applyResult(backend, result);
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<T> {
    // Pre-aborted signal — short-circuit immediately so we don't schedule
    // a no-op timer.
    if (signal.aborted) {
      return await Promise.reject(new Error('aborted'));
    }
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('aborted'));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(new Error(`ping timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (v) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  private scheduleNext(backend: ConnectivityBackend): void {
    const state = this.states.get(backend);
    if (!state || this.destroyed) return;
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const step = Math.min(state.backoffStep, this.schedule.length - 1);
    const delay = this.schedule[step]!;
    // Bump for the slot AFTER the upcoming one. We do this here (post-
    // schedule-read) so that `applyResult` only had to handle the
    // reset-on-success case. On a steady-state failure stream:
    //   probe 1 fails → applyResult does NOT touch backoffStep
    //                 → scheduleNext reads step 0 (5s), bumps to step 1
    //   probe 2 fails → applyResult does NOT touch backoffStep
    //                 → scheduleNext reads step 1 (15s), bumps to step 2
    //   etc.
    // On a success after several failures, applyResult sets step=0;
    // scheduleNext reads step 0 (5s), bumps to step 1. The NEXT probe
    // uses 5 s (good — the "reset to 5s on success" spec). If THAT
    // probe fails, applyResult leaves step at 1; scheduleNext reads
    // step 1 (15s), bumps to step 2. So the climb after a recovery-
    // then-failure resumes from 15 s on the SECOND failure — there is
    // no "double 5 s" before climbing. Behavior matches the spec; the
    // comment is the source of truth here (corrected in review of #312).
    state.backoffStep = Math.min(step + 1, this.schedule.length - 1);
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.runProbe(backend);
    }, delay);
    // Allow Node.js to exit even if the connectivity manager is still
    // scheduled. The Sphere lifecycle's destroy() will clear the timer
    // explicitly, so unref'ing is purely a Node-CLI ergonomic.
    const t = state.timer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') {
      try { t.unref(); } catch { /* ignore */ }
    }
  }

  private applyResult(backend: ConnectivityBackend, result: PingResult): void {
    const state = this.states.get(backend);
    if (!state) return;

    const prev = state.status;

    // Schedule semantics: `backoffStep` is the index of `schedule` to USE
    // for the NEXT probe. The first failure → use schedule[0] = 5 s for
    // the next slot, and bump to step 1 for the slot after that.
    // Subsequent failures keep bumping through 15 s, 60 s, 300 s. A
    // success (`'up'` or `'degraded'`) resets the step to 0.
    //
    // The bump-after-scheduling pattern: `scheduleNext` reads the current
    // step (delay = schedule[step]), then we bump here AFTER scheduleNext
    // has run. Since `applyResult` is called BEFORE `scheduleNext` (via
    // the finally hook), we bump here — but the bump applies to the
    // slot AFTER the upcoming one. Implementation: track an
    // "increment-after-schedule" flag.
    if (result === 'up' || result === 'degraded') {
      state.backoffStep = 0;
    }
    // For failures, we do NOT increment here. The bump happens inside
    // `scheduleNext` itself, AFTER it reads schedule[backoffStep], so
    // the very NEXT scheduled probe uses the CURRENT step value, then
    // step advances for the slot after that. This makes the first
    // failure use schedule[0] (= 5s) for the next probe — matching the
    // spec.

    // Issue #424: consecutive-failure threshold for `'down'` flips.
    //
    // - A successful result (`'up'` or `'degraded'`) resets the counter
    //   and the visible status is whatever the probe reported. Recovery
    //   is immediate — one good probe is enough.
    // - A failed result (`'down'`) bumps the counter (saturating at the
    //   threshold so a long-running offline wallet never grows the
    //   number unboundedly). The visible status only flips to `'down'`
    //   when the counter reaches the threshold.
    //
    // Until the threshold is reached we hold the previous status. This
    // means an `'unknown'` start → 1 `'down'` keeps `'unknown'` visible,
    // and an `'up'` → 1 `'down'` keeps `'up'` visible. Operators get
    // false-negative suppression at the cost of slightly delayed real-
    // outage detection (one extra probe interval).
    let next: ConnectivityBackendStatus;
    if (result === 'down') {
      // Saturating increment — see steelman note: a 32-bit counter would
      // be fine in practice, but capping at the threshold keeps the
      // semantics tight: "have we hit threshold yet?" is the only
      // question we ask.
      if (state.consecutiveFailures < this.failureThreshold) {
        state.consecutiveFailures += 1;
      }
      next = state.consecutiveFailures >= this.failureThreshold ? 'down' : prev;
    } else {
      state.consecutiveFailures = 0;
      next = result;
    }

    if (prev === next) {
      // No transition — still refresh cached snapshot's `lastOnlineAt`
      // when applicable.
      if (this.allUp()) {
        this.lastOnlineAt = Date.now();
        // Rebuild snapshot so subscribers reading `.status()` see
        // monotonic `lastOnlineAt` even without an event fire.
        this.cachedSnapshot = this.buildSnapshot();
      }
      return;
    }

    state.status = next;
    this.lastChangedAt = Date.now();
    if (this.allUp()) {
      this.lastOnlineAt = this.lastChangedAt;
    }
    this.cachedSnapshot = this.buildSnapshot();

    // Notify subscribers. Subscriber errors MUST NOT break the manager —
    // catch each invocation individually.
    const snapshot = this.cachedSnapshot;
    for (const fn of this.subscribers) {
      try {
        fn(snapshot);
      } catch (err) {
        logger.warn('Connectivity', `subscriber threw on changed: ${safeErr(err)}`);
      }
    }

    // Emit Sphere-bus events. The emit hook is a thin wrapper — failures
    // are isolated so one broken handler can't break others.
    this.safeEmit('connectivity:changed', snapshot);
    const nowOnline = this.allUp();
    if (nowOnline && !this.wasOnline) {
      this.wasOnline = true;
      this.safeEmit('connectivity:online', snapshot);
    } else if (!nowOnline && this.wasOnline) {
      this.wasOnline = false;
      this.safeEmit('connectivity:offline-degraded', snapshot);
    }
    // Otherwise: we were already offline and a different backend dropped /
    // recovered partially. `connectivity:changed` already covered it;
    // no second `offline-degraded` is emitted (the event semantics are
    // "edge transitions only").
  }

  private safeEmit(
    type: 'connectivity:changed' | 'connectivity:online' | 'connectivity:offline-degraded',
    snapshot: ConnectivityStatus,
  ): void {
    if (!this.emitEvent) return;
    try {
      this.emitEvent(type, snapshot);
    } catch (err) {
      logger.warn('Connectivity', `emitEvent(${type}) threw: ${safeErr(err)}`);
    }
  }

  private allUp(): boolean {
    // Backends that have no registered pinger are treated as 'up' so an
    // explicitly-disabled backend (e.g. no IPFS configured) does not lock
    // the wallet into permanent offline-degraded.
    for (const which of (['aggregator', 'ipfs', 'nostr'] as const)) {
      if (!this.pingers.has(which)) continue;
      const s = this.states.get(which)?.status;
      if (s !== 'up') return false;
    }
    return true;
  }

  private buildSnapshot(): ConnectivityStatus {
    const get = (which: ConnectivityBackend): ConnectivityBackendStatus => {
      // When a pinger is not registered, the backend is reported as 'up'
      // (see `allUp` rationale). This keeps `sphere.connectivity.status()`
      // useful in tests / minimal configurations.
      if (!this.pingers.has(which)) return 'up';
      return this.states.get(which)?.status ?? 'unknown';
    };
    return {
      aggregator: get('aggregator'),
      ipfs: get('ipfs'),
      nostr: get('nostr'),
      lastOnlineAt: this.lastOnlineAt,
      lastChangedAt: this.lastChangedAt,
    };
  }
}

// =============================================================================
// Built-in pingers
// =============================================================================

/**
 * Aggregator pinger — calls `getCurrentRound()` on a {@link OracleProvider}-
 * like surface as the cheapest available probe. The OracleProvider already
 * uses this method as its "is the aggregator alive" check internally
 * (`get_block_height` JSON-RPC).
 *
 * Two probe modes:
 *
 *   - **Provider mode** (preferred) — pass an object with `getCurrentRound`.
 *     Used in production where Sphere already owns an
 *     {@link OracleProvider} instance.
 *
 *   - **URL mode** (fallback) — pass a bare aggregator URL + fetch impl.
 *     Used when no provider instance is available (e.g. pre-init health
 *     checks, tests). Sends a `get_block_height` JSON-RPC POST.
 *
 * Issue #424: each `ping()` call internally retries transient failures with a
 * `[100, 500, 2000]` ms backoff before surfacing `'down'` to the manager.
 * This absorbs the dominant TCP retransmit-window blip and DNS hiccup without
 * stacking up against the manager's consecutive-failure threshold. The manager
 * still has the final say on status transitions (see `failureThreshold`).
 *
 * Treats (after retries exhausted):
 *   - successful call (numeric round / `result` field) ⇒ `'up'`
 *   - 200 OK with `error` body / unrecognizable result ⇒ `'degraded'`
 *   - any throw / 4xx / 5xx / abort / timeout          ⇒ `'down'`
 */
export interface AggregatorPingerProvider {
  getCurrentRound(): Promise<number>;
}

/**
 * Issue #424: backoff schedule (ms) for {@link AggregatorPinger}'s
 * in-probe retries on transient failures. Matches the IPFS layer's
 * `withPinRetry` schedule — 100 / 500 / 2000 ms.
 *
 * Total budget: ~2.6 s of accumulated backoff between attempts; the
 * manager's `pingTimeoutMs` (default 8 s) caps the overall wall-clock
 * cost. Each retry runs a fresh inner ping attempt, so a slow-but-
 * eventually-failing call could be aborted mid-retry by the manager's
 * outer timeout.
 */
export const AGGREGATOR_RETRY_BACKOFFS_MS: ReadonlyArray<number> = [100, 500, 2000] as const;

/**
 * Issue #424: classify whether an aggregator-probe failure is worth a
 * quick in-probe retry.
 *
 * Transient (retry):
 *   - `AbortError` / `TimeoutError` from the per-attempt timeout.
 *   - Network errors (`ECONNRESET`, `ECONNREFUSED`, `ENOTFOUND`,
 *     `ETIMEDOUT`, `EAI_AGAIN`, undici `fetch failed`).
 *   - HTTP 5xx — server-side transient (overload, bad backend).
 *   - HTTP 429 — rate-limit signal; backoff is the right response.
 *   - Anything we can't classify — the bounded 2.6 s budget caps the
 *     cost of guessing wrong.
 *
 * Permanent (do NOT retry — return `'down'` without consuming more budget):
 *   - HTTP 4xx (except 429) — deterministic client error; retry wastes
 *     budget and is semantically wrong.
 *
 * The classifier matches the shape of errors thrown by both provider-mode
 * (the underlying transport rethrows) and URL-mode (we throw synthetic
 * `"HTTP <status>"` errors for non-OK responses so this classifier can
 * route by status code).
 */
export function isTransientAggregatorError(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  const msg = err.message;

  // HTTP-derived: explicit status code in the message.
  const httpMatch = /\bHTTP (\d{3})\b/.exec(msg);
  if (httpMatch !== null) {
    const status = Number.parseInt(httpMatch[1], 10);
    if (status === 429) return true;               // rate-limit → retry
    if (status >= 500 && status < 600) return true; // 5xx → retry
    if (status >= 400 && status < 500) return false; // 4xx → permanent
  }

  // Network / abort signals from `fetch` and friends.
  if (
    msg.toLowerCase().includes('fetch failed') ||
    msg.toLowerCase().includes('network') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('EAI_AGAIN') ||
    err.name === 'AbortError' ||
    err.name === 'TimeoutError'
  ) {
    return true;
  }

  // Unknown shape — lenient default, capped by the bounded retry budget.
  return true;
}

export class AggregatorPinger implements Pinger {
  readonly backend: ConnectivityBackend = 'aggregator';

  private readonly provider: AggregatorPingerProvider | null;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retryBackoffsMs: ReadonlyArray<number>;
  private readonly isTransient: (err: unknown) => boolean;

  constructor(opts: {
    provider?: AggregatorPingerProvider;
    url?: string;
    fetchImpl?: typeof fetch;
    /**
     * Issue #424 (test-seam): override the retry backoff schedule.
     * Defaults to {@link AGGREGATOR_RETRY_BACKOFFS_MS}. Pass an empty
     * array to disable retries entirely (single-attempt, legacy behaviour).
     */
    retryBackoffsMs?: ReadonlyArray<number>;
    /**
     * Issue #424 (test-seam): override the transient-error classifier.
     * Defaults to {@link isTransientAggregatorError}.
     */
    isTransientError?: (err: unknown) => boolean;
  }) {
    this.provider = opts.provider ?? null;
    this.url = opts.url ?? '';
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.retryBackoffsMs = opts.retryBackoffsMs ?? AGGREGATOR_RETRY_BACKOFFS_MS;
    this.isTransient = opts.isTransientError ?? isTransientAggregatorError;
  }

  async ping(signal: AbortSignal): Promise<PingResult> {
    if (signal.aborted) return 'down';
    // Issue #424: in-probe retry loop. A single transient blip (TCP RST,
    // DNS hiccup, undici `fetch failed`) should not surface as `'down'`
    // to the manager. We attempt up to `1 + retryBackoffsMs.length`
    // times; each attempt runs the underlying probe (provider or URL).
    // On a permanent error (e.g. HTTP 4xx) we short-circuit immediately.
    // On caller abort, we return `'down'` without further retries.
    const totalAttempts = 1 + this.retryBackoffsMs.length;
    let lastResult: PingResult = 'down';
    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      if (signal.aborted) return 'down';
      let attemptError: unknown = null;
      try {
        lastResult = await this.runSingleAttempt(signal);
        // 'up' and 'degraded' are conclusive — return immediately.
        if (lastResult !== 'down') return lastResult;
      } catch (err) {
        attemptError = err;
        lastResult = 'down';
      }

      // We either got a thrown error or a 'down' result. Decide whether
      // to retry.
      const isLast = attempt === totalAttempts - 1;
      if (isLast) break;
      if (attemptError !== null && !this.isTransient(attemptError)) {
        // Permanent error — surface 'down' without burning more budget.
        return 'down';
      }
      // Sleep for the backoff between attempts. Honours caller abort
      // mid-sleep so a stop() during the retry loop short-circuits.
      const delay = this.retryBackoffsMs[attempt]!;
      const aborted = await sleepWithAbort(delay, signal);
      if (aborted) return 'down';
    }
    return lastResult;
  }

  /**
   * Run a single underlying probe attempt — provider mode if a provider
   * is configured, URL-mode otherwise. Throws on network / HTTP errors
   * (so the retry loop can classify and retry). Returns `'up'`,
   * `'degraded'`, or `'down'` on a successful structured response.
   *
   * Provider-mode preserves the legacy semantics: any finite non-negative
   * numeric round counts as `'up'`; a non-finite or negative result is
   * `'degraded'`; a thrown error propagates out (the retry loop catches
   * and decides).
   *
   * URL-mode throws a synthetic `"HTTP <status>"` error on non-OK
   * responses so {@link isTransientAggregatorError} can classify by
   * status code.
   */
  private async runSingleAttempt(signal: AbortSignal): Promise<PingResult> {
    if (this.provider) {
      // Any finite numeric round (including 0) is a structured response
      // from the aggregator and counts as alive — matches the reference
      // infra-probe semantics (any JSON-RPC `result` ⇒ alive) and the
      // URL-mode fallback below. Fresh shards / between-batch states
      // can legitimately surface a `0` block height; demoting those to
      // `'degraded'` would surface a false "Aggregator unavailable" in
      // the wallet UI. The legacy "no aggregator client" stub path
      // (UnicityAggregatorProvider before `initialize()`) now throws
      // instead of returning `0`, so the catch in the retry loop routes
      // it to `'down'` as intended.
      const round = await this.provider.getCurrentRound();
      if (typeof round === 'number' && Number.isFinite(round) && round >= 0) {
        return 'up';
      }
      return 'degraded';
    }
    if (!this.url) return 'down';
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'get_block_height',
        params: {},
      }),
      signal,
    });
    if (!response.ok) {
      // Throw a synthetic "HTTP <status>" error so the classifier can
      // decide retry-vs-permanent by status code. The retry loop catches
      // and routes; a 4xx surfaces as 'down' immediately (no further
      // budget consumed).
      throw new Error(`HTTP ${response.status} ${response.statusText} from ${this.url}`);
    }
    try {
      const body = (await response.json()) as { result?: unknown; error?: unknown };
      if (body && typeof body === 'object' && body.error) {
        // A genuine JSON-RPC error envelope means the aggregator IS up
        // but rejected our specific payload. Surface as 'degraded' —
        // the backend is reachable, not retried, not counted as 'down'.
        return 'degraded';
      }
      const result = body && typeof body === 'object' ? body.result : null;
      if (
        typeof result === 'number' ||
        typeof result === 'bigint' ||
        (typeof result === 'string' && result.length > 0) ||
        (result !== null && typeof result === 'object')
      ) {
        return 'up';
      }
      return 'degraded';
    } catch {
      // JSON parse failure on a 200 response — backend reachable but
      // body is junk. Treat as degraded (backend IS reachable).
      return 'degraded';
    }
  }
}

/**
 * Sleep for `ms` milliseconds, honouring `signal`. Returns `true` if the
 * sleep was cut short by an abort (caller should stop retrying); returns
 * `false` on a clean timeout.
 *
 * Used by {@link AggregatorPinger}'s retry loop so a `stop()` landing
 * during a backoff sleep short-circuits the loop instead of pinning the
 * probe in a no-op wait.
 */
async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return true;
  return await new Promise<boolean>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * IPFS pinger — HEAD-probes a known small CID on the configured gateway.
 *
 * The probe targets `/ipfs/<cid>` where `<cid>` is a well-known small block
 * (the empty unixfs directory by default — every public IPFS gateway has it
 * pinned by default). Tries each gateway in order; first success wins.
 *
 * Treats:
 *   - HEAD 200 / 204 from any gateway ⇒ `'up'`
 *   - HEAD 4xx/5xx from EVERY gateway ⇒ `'degraded'` (gateway reachable
 *     but CID not served)
 *   - all timeouts / network errors    ⇒ `'down'`
 */
export class IpfsPinger implements Pinger {
  readonly backend: ConnectivityBackend = 'ipfs';

  /** Empty unixfs directory — universally pinned, ~10 bytes. */
  static readonly DEFAULT_PROBE_CID = 'bafyaabakaieac';

  constructor(
    private readonly gateways: ReadonlyArray<string>,
    private readonly probeCid: string = IpfsPinger.DEFAULT_PROBE_CID,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async ping(signal: AbortSignal): Promise<PingResult> {
    if (this.gateways.length === 0) {
      // No gateways configured — report 'up' so the manager doesn't lock
      // a no-IPFS wallet into permanent offline-degraded. The
      // ConnectivityManager only includes this pinger when IPFS is wired
      // by the caller, so the caller is responsible for choosing.
      return 'up';
    }
    let anyReached = false;
    for (const gw of this.gateways) {
      if (signal.aborted) break;
      try {
        const url = `${gw.replace(/\/$/, '')}/ipfs/${this.probeCid}`;
        const response = await this.fetchImpl(url, { method: 'HEAD', signal });
        if (response.ok) return 'up';
        // 4xx/5xx — gateway reachable but the CID isn't being served.
        // Mark as 'reached' so we can downgrade to 'degraded' if no
        // gateway returns 200.
        anyReached = true;
      } catch {
        // network / abort — try next gateway
      }
    }
    return anyReached ? 'degraded' : 'down';
  }
}

/**
 * Nostr pinger — connection-state probe.
 *
 * The transport's NIP-29 client owns its WebSocket lifecycle (auto-reconnect
 * with built-in backoff). The ConnectivityManager does NOT open a parallel
 * subscription — that would compete with the transport for relay slots and
 * cause race conditions during DM delivery. Instead we read the transport's
 * `isConnected()` flag.
 *
 * Treats:
 *   - `isConnected() === true`  ⇒ `'up'`
 *   - `isConnected() === false` ⇒ `'down'`
 *   - throws on read             ⇒ `'down'`
 *
 * Note: this means the Nostr "down" surface is a lag indicator — it
 * reflects the transport's own reconnect-attempts count rather than a
 * direct probe. A relay that closes the socket and then accepts a fresh
 * connection within the transport's reconnect backoff window will register
 * as `'up'` here even though there was a brief "down" window. That is
 * acceptable for the offline-mode UX surface (the transport's reconnect
 * already handles the recovery).
 */
export class NostrPinger implements Pinger {
  readonly backend: ConnectivityBackend = 'nostr';

  constructor(
    private readonly isConnected: () => boolean,
  ) {}

  async ping(_signal: AbortSignal): Promise<PingResult> {
    try {
      return this.isConnected() ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}

// =============================================================================
// Helpers
// =============================================================================

function safeErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  try { return String(err); } catch { return '<unstringifiable>'; }
}
