/**
 * UXF Transfer — trustBase staleness detection + refresh (T.5.F / W41).
 *
 * Implements `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §9.4.1's two-strike
 * escalation for `NOT_AUTHENTICATED` poll outcomes:
 *
 *   - **First strike** — observed by either {@link FinalizationWorkerSender}
 *     or {@link FinalizationWorkerRecipient} on poll. The worker emits
 *     `transfer:trustbase-warning`, asks the controller to
 *     {@link TrustBaseStaleness.refreshTrustBase} the local trustBase,
 *     and retries the poll within the same window.
 *
 *   - **Second strike (after refresh)** — if a fresh poll AGAIN returns
 *     `NOT_AUTHENTICATED` after the controller has confirmed a refresh
 *     for the same aggregator, the local belief is genuinely diverged
 *     from the aggregator's. The worker emits `transfer:security-alert`
 *     and hard-fails the request with `reason: 'proof-invalid'` —
 *     terminal.
 *
 * **Debounce strategy** — refreshes are debounced PER AGGREGATOR by an
 * in-flight promise map. Callers that hit `NOT_AUTHENTICATED` on the
 * same aggregator concurrently share the SAME refresh promise. The
 * promise resolves to a {@link RefreshOutcome} carrying a tag so the
 * caller can detect "refresh applied since my last attempt" without
 * tracking timestamps. A controller-supplied `Refresher.refresh()` is
 * invoked at most once per outstanding-flight; ALL waiters receive the
 * same outcome. After the in-flight resolves, a fresh refresh requires
 * a new `recordNotAuthenticated()` strike — the dedupe window is the
 * refresh-flight, NOT a wall-clock.
 *
 * **Per-aggregator state** — every recorded NOT_AUTHENTICATED, refresh,
 * and OK is keyed by the `aggregatorId` string the workers carry
 * through. The default key `'default'` matches the workers' default
 * `aggregatorId`. Multi-aggregator deployments isolate state by
 * passing different keys.
 *
 * **Side-effect freedom** — importing this module does NOT touch
 * network / storage / globals. The class is purely in-memory; the
 * actual refresh side-effects live behind the injected
 * {@link TrustBaseRefresher} interface.
 *
 * @packageDocumentation
 */

import { SphereError } from '../../../core/errors';

// =============================================================================
// 1. Refresh adapter — caller-supplied trustBase fetcher
// =============================================================================

/**
 * Outcome of a trustBase refresh attempt. The `applied` discriminator
 * lets callers tell "refresh succeeded; next NOT_AUTHENTICATED really
 * means proof-invalid" from "refresh failed; treat as transient".
 *
 *  - `'applied'` — controller fetched a new trustBase and installed it
 *    locally. Subsequent polls will verify against the new trustBase.
 *  - `'no-change'` — controller checked the source of truth and found
 *    no newer trustBase than the local one. Treated by the worker as
 *    "applied" for two-strike accounting (the local trustBase is
 *    confirmed-current; another NOT_AUTHENTICATED is genuine
 *    divergence).
 *  - `'failed'` — refresh attempt failed (network, oracle down). The
 *    worker DOES NOT escalate to security-alert; it logs the warning
 *    and retries the poll loop. The next NOT_AUTHENTICATED will trip
 *    another refresh attempt.
 */
export type RefreshOutcome =
  | { readonly kind: 'applied'; readonly tag: number }
  | { readonly kind: 'no-change'; readonly tag: number }
  | { readonly kind: 'failed'; readonly error: string };

/**
 * Adapter the controller wires for the actual trustBase refresh.
 * Production wires this to the oracle-provider's trustBase endpoint;
 * tests inject a deterministic recorder.
 *
 * The contract is intentionally narrow — the worker doesn't introspect
 * the trustBase contents; it only cares whether a refresh succeeded.
 */
export interface TrustBaseRefresher {
  /**
   * Fetch the latest trustBase for `aggregatorId`. Implementations
   * SHOULD honor `signal.aborted` and bail with a `'failed'` outcome
   * (the worker treats abort as transient).
   */
  refresh(input: {
    readonly aggregatorId: string;
    readonly signal?: AbortSignal;
  }): Promise<RefreshOutcome>;
}

// =============================================================================
// 2. Per-aggregator state record
// =============================================================================

/**
 * Per-aggregator staleness ledger row. The class holds one row per
 * aggregatorId observed.
 *
 * @internal
 */
interface AggregatorState {
  /** Number of NOT_AUTHENTICATED observations since the last
   *  authenticated-OK. Reset to 0 on `recordAuthenticatedOk`. */
  notAuthenticatedCount: number;
  /** Wall-clock of the most recent NOT_AUTHENTICATED observation, or
   *  `null` if never observed (or reset). Forensic; not load-bearing
   *  for the two-strike rule. */
  lastNotAuthenticatedAt: number | null;
  /** Wall-clock of the most recent successful (or no-change) refresh.
   *  `null` until the first refresh resolves. */
  lastRefreshAt: number | null;
  /** Monotonic generation counter — incremented every successful
   *  refresh. Workers compare a captured `tag` against the current
   *  one to detect "did a refresh happen since I last asked". */
  refreshTag: number;
  /** In-flight refresh promise, if any. Sharing this between waiters
   *  is the debounce primitive. */
  inFlight: Promise<RefreshOutcome> | null;
}

// =============================================================================
// 3. TrustBaseStaleness construction options
// =============================================================================

/**
 * Construction options for {@link TrustBaseStaleness}. Every external
 * dependency is injected so unit tests can drive the class against
 * deterministic fakes.
 */
export interface TrustBaseStalenessOptions {
  /**
   * Adapter that performs the actual trustBase refresh. Production
   * wires this to the oracle-provider's trustBase endpoint; tests
   * inject a deterministic recorder.
   */
  readonly refresher: TrustBaseRefresher;
  /**
   * Wall-clock provider — injected so tests can advance time
   * deterministically. Defaults to `Date.now`.
   */
  readonly now?: () => number;
  /**
   * Threshold of NOT_AUTHENTICATED observations on the SAME aggregator
   * before the staleness ledger flags it as stale. Default: 1
   * (matches §9.4.1's "first strike refreshes; second strike escalates"
   * rule). Operators may raise this if their network is flaky and
   * they want to absorb more retries before refreshing.
   */
  readonly notAuthenticatedStaleThreshold?: number;
}

// =============================================================================
// 4. NOT_AUTHENTICATED observation result
// =============================================================================

/**
 * Result of {@link TrustBaseStaleness.recordNotAuthenticated}. The
 * caller (worker) uses this to decide whether to refresh + retry, or
 * to escalate to security-alert.
 *
 *  - `kind: 'first-strike'` — the first NOT_AUTHENTICATED on this
 *    aggregator since the last refresh / OK. Worker SHOULD call
 *    {@link TrustBaseStaleness.refreshTrustBase} and retry the poll.
 *    `priorRefreshTag` is the tag observed BEFORE this strike — the
 *    worker passes it back in to the next `recordNotAuthenticated`
 *    call so the class can detect "did a refresh happen since".
 *
 *  - `kind: 'post-refresh'` — a NOT_AUTHENTICATED after a successful
 *    refresh has been applied. Worker MUST escalate to
 *    `transfer:security-alert` and hard-fail with `proof-invalid`.
 *    `priorRefreshTag` is the captured pre-strike tag (forensic).
 */
export type NotAuthenticatedRecord =
  | {
      readonly kind: 'first-strike';
      readonly aggregatorId: string;
      readonly priorRefreshTag: number;
      readonly observationCount: number;
    }
  | {
      readonly kind: 'post-refresh';
      readonly aggregatorId: string;
      readonly priorRefreshTag: number;
      readonly currentRefreshTag: number;
      readonly observationCount: number;
    };

// =============================================================================
// 5. TrustBaseStaleness — the central per-process ledger
// =============================================================================

/**
 * Per-process trustBase staleness ledger. ONE instance is shared by
 * both finalization workers (sender + recipient) so refresh debouncing
 * is process-global per aggregator. Multi-process deployments do NOT
 * share state — each Sphere instance has its own ledger.
 *
 * Methods are lock-free and safe to call from any async context. The
 * debounce primitive is the in-flight refresh promise stored on the
 * per-aggregator state row.
 */
export class TrustBaseStaleness {
  private readonly refresher: TrustBaseRefresher;
  private readonly now: () => number;
  private readonly threshold: number;
  private readonly states: Map<string, AggregatorState> = new Map();

  constructor(options: TrustBaseStalenessOptions) {
    if (options.refresher === undefined || options.refresher === null) {
      throw new SphereError(
        'TrustBaseStaleness: options.refresher is required',
        'VALIDATION_ERROR',
      );
    }
    if (
      options.notAuthenticatedStaleThreshold !== undefined &&
      (!Number.isFinite(options.notAuthenticatedStaleThreshold) ||
        options.notAuthenticatedStaleThreshold < 1)
    ) {
      throw new SphereError(
        `TrustBaseStaleness: notAuthenticatedStaleThreshold must be >= 1; got ${options.notAuthenticatedStaleThreshold}`,
        'VALIDATION_ERROR',
      );
    }
    this.refresher = options.refresher;
    this.now = options.now ?? (() => Date.now());
    this.threshold = options.notAuthenticatedStaleThreshold ?? 1;
  }

  /**
   * Read-only check: is the local trustBase considered stale for
   * `aggregatorId`? Stale = at least `threshold` NOT_AUTHENTICATED
   * observations have accumulated since the last
   * `recordAuthenticatedOk` / successful refresh.
   *
   * The check is pure; it does NOT trigger a refresh.
   *
   * @param aggregatorId — defaults to `'default'` to match the workers'
   *                       default aggregator key.
   */
  isTrustBaseStale(aggregatorId: string = 'default'): boolean {
    const state = this.states.get(aggregatorId);
    if (state === undefined) return false;
    return state.notAuthenticatedCount >= this.threshold;
  }

  /**
   * Record a NOT_AUTHENTICATED observation for `aggregatorId`. The
   * worker calls this BEFORE deciding whether to refresh + retry or
   * escalate.
   *
   * **Two-strike accounting**:
   *  - If the worker has NEVER captured a refreshTag for this
   *    aggregator (priorRefreshTag undefined / passed `null`), the
   *    record is `'first-strike'` — worker SHOULD refresh and retry.
   *  - If the worker passes a `priorRefreshTag` AND a refresh has
   *    happened since (`currentRefreshTag > priorRefreshTag`), the
   *    record is `'post-refresh'` — worker MUST escalate.
   *
   * The class does NOT auto-trigger the refresh; the worker decides
   * the policy. This separation lets the worker emit
   * `transfer:trustbase-warning` BEFORE the refresh kicks off.
   *
   * @param aggregatorId — defaults to `'default'`.
   * @param priorRefreshTag — the `currentRefreshTag` the worker observed
   *                          on its previous call, or `null` if first
   *                          observation in this poll loop.
   */
  recordNotAuthenticated(
    aggregatorId: string = 'default',
    priorRefreshTag: number | null = null,
  ): NotAuthenticatedRecord {
    const state = this.getOrCreate(aggregatorId);
    state.notAuthenticatedCount += 1;
    state.lastNotAuthenticatedAt = this.now();

    const tag = state.refreshTag;
    if (priorRefreshTag !== null && tag > priorRefreshTag) {
      // A refresh happened between the worker's prior strike and now.
      // The aggregator STILL rejects — escalate.
      return {
        kind: 'post-refresh',
        aggregatorId,
        priorRefreshTag,
        currentRefreshTag: tag,
        observationCount: state.notAuthenticatedCount,
      };
    }
    return {
      kind: 'first-strike',
      aggregatorId,
      priorRefreshTag: tag,
      observationCount: state.notAuthenticatedCount,
    };
  }

  /**
   * Record a successful (authenticated) poll for `aggregatorId`. Resets
   * the NOT_AUTHENTICATED counter so the next first strike triggers a
   * fresh refresh cycle.
   *
   * Idempotent — calling on a never-observed aggregator is a no-op.
   *
   * @param aggregatorId — defaults to `'default'`.
   */
  recordAuthenticatedOk(aggregatorId: string = 'default'): void {
    const state = this.states.get(aggregatorId);
    if (state === undefined) return;
    state.notAuthenticatedCount = 0;
  }

  /**
   * Read the current refresh-tag for `aggregatorId`. Workers capture
   * this at the start of their poll loop and pass it back in to
   * {@link recordNotAuthenticated} on subsequent strikes.
   *
   * Returns 0 for never-observed aggregators.
   *
   * @param aggregatorId — defaults to `'default'`.
   */
  getRefreshTag(aggregatorId: string = 'default'): number {
    return this.states.get(aggregatorId)?.refreshTag ?? 0;
  }

  /**
   * Trigger a trustBase refresh for `aggregatorId`. Debounced per
   * aggregator: concurrent callers share the SAME in-flight promise.
   *
   * On `'applied'` / `'no-change'`: the per-aggregator `refreshTag` is
   * incremented BEFORE the promise resolves — so any waiter that calls
   * `recordNotAuthenticated` immediately after the await sees the bump.
   * The NOT_AUTHENTICATED counter is reset on `'applied'` /
   * `'no-change'` so the worker that retries with the new trustBase
   * starts fresh.
   *
   * On `'failed'`: the tag is NOT bumped and the counter is NOT reset.
   * The worker treats failure as transient — the next strike will
   * trigger another refresh.
   *
   * If no in-flight refresh exists, this method invokes
   * {@link TrustBaseRefresher.refresh} via the injected adapter; if the
   * refresher throws, the throw is mapped to
   * `{ kind: 'failed', error: ... }`.
   *
   * @param aggregatorId — defaults to `'default'`.
   * @param signal — optional AbortSignal forwarded to the refresher.
   */
  async refreshTrustBase(
    aggregatorId: string = 'default',
    signal?: AbortSignal,
  ): Promise<RefreshOutcome> {
    const state = this.getOrCreate(aggregatorId);
    if (state.inFlight !== null) {
      return state.inFlight;
    }
    const flight = this.runRefresh(aggregatorId, state, signal);
    state.inFlight = flight;
    try {
      return await flight;
    } finally {
      // Clear the in-flight slot whether we resolved or rejected — the
      // map is only correct for the LIFETIME of this refresh attempt.
      state.inFlight = null;
    }
  }

  /**
   * Diagnostic — number of distinct aggregators the ledger currently
   * tracks. Useful in tests + for operator dashboards.
   */
  knownAggregatorCount(): number {
    return this.states.size;
  }

  /**
   * Diagnostic — the last NOT_AUTHENTICATED timestamp for
   * `aggregatorId`, or `null` if never observed (or reset).
   *
   * @param aggregatorId — defaults to `'default'`.
   */
  lastNotAuthenticatedAt(
    aggregatorId: string = 'default',
  ): number | null {
    return this.states.get(aggregatorId)?.lastNotAuthenticatedAt ?? null;
  }

  /**
   * Diagnostic — the last successful-refresh timestamp for
   * `aggregatorId`, or `null` if no refresh has succeeded.
   *
   * @param aggregatorId — defaults to `'default'`.
   */
  lastRefreshAt(aggregatorId: string = 'default'): number | null {
    return this.states.get(aggregatorId)?.lastRefreshAt ?? null;
  }

  // ===========================================================================
  // Internal helpers
  // ===========================================================================

  /**
   * Lazily allocate the per-aggregator state row.
   *
   * @internal
   */
  private getOrCreate(aggregatorId: string): AggregatorState {
    let state = this.states.get(aggregatorId);
    if (state === undefined) {
      state = {
        notAuthenticatedCount: 0,
        lastNotAuthenticatedAt: null,
        lastRefreshAt: null,
        refreshTag: 0,
        inFlight: null,
      };
      this.states.set(aggregatorId, state);
    }
    return state;
  }

  /**
   * Inner refresh runner — invokes the adapter, normalizes throws,
   * bumps the refreshTag + resets the counter on success, and resolves
   * the shared in-flight promise.
   *
   * @internal
   */
  private async runRefresh(
    aggregatorId: string,
    state: AggregatorState,
    signal?: AbortSignal,
  ): Promise<RefreshOutcome> {
    let outcome: RefreshOutcome;
    try {
      outcome = await this.refresher.refresh({ aggregatorId, signal });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcome = { kind: 'failed', error: `refresher threw: ${message}` };
    }

    if (outcome.kind === 'applied' || outcome.kind === 'no-change') {
      // Bump tag + reset counter — the worker's next strike will see
      // a higher tag and escalate if NOT_AUTHENTICATED persists.
      state.refreshTag += 1;
      state.notAuthenticatedCount = 0;
      state.lastRefreshAt = this.now();
      // Re-stamp the outcome with the bumped tag so callers reading
      // `outcome.tag` see the post-bump value.
      outcome = { ...outcome, tag: state.refreshTag };
    }
    return outcome;
  }
}

// =============================================================================
// 6. Test-only helper — `noopRefresher` for unit tests that don't drive
//    the refresh path
// =============================================================================

/**
 * Minimal {@link TrustBaseRefresher} that always reports `'no-change'`.
 * Useful in unit tests that drive the staleness ledger directly without
 * exercising the refresh adapter.
 */
export function noopRefresher(): TrustBaseRefresher {
  return {
    async refresh() {
      return { kind: 'no-change', tag: 0 };
    },
  };
}
