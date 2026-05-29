/**
 * Per-token spent-state rescan worker (Issue #174; UXF-TRANSFER-PROTOCOL §12.3.2).
 *
 * Proactive companion to the reactive
 * `'transfer:double-spend-detected'` surface that fires at next
 * `send()` attempt (Item #14 Phase 1). This worker periodically asks
 * the L3 aggregator whether each token in the local active pool has
 * had its current destination state spent off-record — typically by
 * another instance of the SAME wallet (desktop + mobile sharing keys;
 * primary device + recovered backup). Without this proactive surface,
 * the local UI shows the token as spendable until the user attempts a
 * send, at which point `submitTransferCommitment` fails and
 * `'transfer:double-spend-detected'` finally fires.
 *
 * **What this worker does:**
 *   1. Periodically sweeps `tokensProvider()` (the in-memory active
 *      pool) for tokens at `status === 'confirmed'` with parseable
 *      `sdkData` whose current destination state hash hasn't been
 *      probed in the last `perTokenIntervalMs` (default 5 min).
 *      Concurrent in-flight probes are capped at `maxConcurrent`
 *      (default 4).
 *   2. For each eligible token, derives the current destination
 *      state hash via the injected
 *      `extractCurrentStateHash(token)` closure (typically wraps
 *      `extractStateHashFromSdkData`) and calls
 *      `oracle.isSpent(stateHash)`.
 *   3. On `true` → computes the `suspectedSiblingInstance` flag by
 *      asking the local OUTBOX + SENT ledgers whether THIS device
 *      has any record of spending the token (`true` if neither has,
 *      so the spender is most likely another wallet instance
 *      sharing our keys). Then:
 *        a. Emits the canonical `transfer:off-record-spent` event
 *           with the token's tokenId / coinId / amount / detection
 *           timestamp and the heuristic flag.
 *        b. If `transitionToAudit` is wired, invokes it so the
 *           token transitions out of the active pool to `_audit`
 *           per §5.3 [E]. The actual disposition writer call lives
 *           in the closure — the worker never touches storage
 *           directly.
 *   4. On `false` → records the probe timestamp and moves on.
 *   5. On `throw` → bumps the per-token consecutive-throw counter
 *      and, after `CONSECUTIVE_THROW_BACKOFF_THRESHOLD` throws,
 *      applies a per-token back-off for `THROW_BACKOFF_MS` to avoid
 *      hammering the aggregator on a stuck token. A successful
 *      probe (true OR false) clears the counter.
 *
 * **What this worker deliberately does NOT do:**
 *   - Does not write to `_audit` (or any other storage) directly.
 *     The `transitionToAudit` closure is the boundary; PaymentsModule
 *     wires it to the disposition writer.
 *   - Does not re-implement the disposition engine. The engine
 *     already classifies `oracle.isSpent === true` as UNSPENDABLE_BY_US
 *     per §5.3 [E]. This worker is a NEW caller of that decision,
 *     not a new classifier.
 *   - Does not probe tokens with `status === 'transferring'`. The
 *     orphan-spending sweeper (Issue #166 P2 #1) handles that case
 *     (mid-flight sends where local OUTBOX may or may not reflect
 *     the spend).
 *   - Does not probe tokens with a live OUTBOX entry referencing
 *     them. An active send on the token would race the probe; the
 *     send-pipeline state-machine (`'transferring'` → `'sending'`
 *     → `'delivered'`) handles that flow without our intervention.
 *   - Does not bypass the oracle's LRU cache. The per-token
 *     `perTokenIntervalMs` is intentionally set to mirror the
 *     default `oracle.isSpent` cache TTL window so the worker does
 *     not produce extra aggregator load (when the cache is hot, the
 *     oracle returns instantly; when it's stale, the oracle
 *     refreshes once and re-caches).
 *
 * **Idempotency:** repeated invocations on the same in-memory state
 * produce identical decisions for a given oracle response. The
 * per-token state map (last-checked, consecutive-throws,
 * back-off-until) is process-local; a restart re-arms all probes,
 * which is the correct behavior (the operator wants to know about
 * off-record spends detected after a restart).
 *
 * **Concurrency:** safe to invoke concurrently with sends. The worker
 * READS oracle / OUTBOX / SENT and INVOKES the externally-supplied
 * `transitionToAudit` (which is the only mutation surface). The
 * caller is responsible for making that closure thread-safe with
 * concurrent send paths (in practice the disposition writer is).
 *
 * @module modules/payments/transfer/spent-state-rescan-worker
 *
 * @see modules/payments/transfer/nostr-persistence-verifier.ts (structural twin)
 * @see modules/payments/transfer/disposition-engine.ts:~810 (§5.3 [E] hook)
 * @see profile/disposition-writer.ts (the storage-routing surface)
 */

import type { SphereEventMap, SphereEventType, Token } from '../../../types';
import type { OutboxWriter } from '../../../profile/outbox-writer';
import type { SentLedgerWriter } from '../../../profile/sent-ledger-writer';
import { redactCause } from '../../../core/errors';

// =============================================================================
// 1. Public types — dependency surface + options
// =============================================================================

/**
 * Oracle surface the worker calls. Narrow on purpose — we only need
 * `isSpent`. Threaded as a provider closure (mirrors the verifier's
 * pattern) so the worker observes hot-swaps and uninstalls without
 * holding a dangling reference past `Sphere.destroy()`.
 *
 * Issue #245 #1 — the callback receives the full `Token` so the
 * wrapper at the PaymentsModule boundary can derive the predicate's
 * actual publicKey from `token.sdkData` (the canonical aggregator
 * indexes commitments by `RequestId.create(predicatePublicKey, hash)`).
 * Wrapping the wallet's `chainPubkey` for every token misses spent
 * states whose predicate was constructed under a different key.
 */
export type SpentStateOracleProvider = () => {
  readonly isSpent: (token: Token, stateHash: string) => Promise<boolean>;
} | null;

/**
 * Provider of the currently-installed {@link SentLedgerWriter}.
 * Optional — when null/undefined we conservatively treat
 * "no local spend record" (`suspectedSiblingInstance: true`).
 */
export type SentLookupProvider = () => Pick<
  SentLedgerWriter,
  'contains'
> | null;

/**
 * Provider of the currently-installed {@link OutboxWriter}. Optional —
 * when null/undefined the OUTBOX side of the
 * `suspectedSiblingInstance` lookup is skipped.
 */
export type OutboxLookupProvider = () => Pick<
  OutboxWriter,
  'readAll'
> | null;

/**
 * Source of tokens to scan — typically a closure that returns
 * `paymentsModule.tokens.values()`. The worker filters the result
 * itself; the closure may return ALL tokens, the filter excludes
 * non-`'confirmed'` and OUTBOX-active candidates.
 */
export type TokenIterableProvider = () => Iterable<Token>;

/**
 * Closure that pulls the canonical current destination state hash
 * from a token's `sdkData`. PaymentsModule wires this to the
 * existing `extractStateHashFromSdkData` helper. The worker keeps it
 * injected so unit tests can supply deterministic state hashes
 * without standing up the TXF serializer.
 *
 * Returns the empty string when the state hash cannot be derived
 * (legacy edge case — non-TXF token; pre-genesis); the worker skips
 * those tokens.
 */
export type ExtractCurrentStateHashFn = (token: Token) => string;

/**
 * Closure invoked when the worker detects an off-record spend
 * (`oracle.isSpent === true`). The default wiring routes through
 * `dispositionWriter.write()` with a synthesized AUDIT record
 * (reason `'off-record-spend'`); tests may inject a stub that just
 * records the call.
 *
 * The closure MUST NOT throw at the worker's call boundary — if it
 * does, the worker logs and continues (the event has already fired,
 * so operator visibility is preserved even when persistence fails).
 */
export type TransitionToAuditFn = (params: {
  readonly token: Token;
  readonly currentStateHash: string;
  readonly suspectedSiblingInstance: boolean;
  readonly detectedAt: number;
}) => Promise<void>;

/**
 * Logger surface — narrow on purpose so any caller-supplied logger
 * plugs in cleanly. Mirrors the other workers' Logger types.
 */
export interface SpentStateRescanWorkerLogger {
  readonly warn: (message: string, context?: Record<string, unknown>) => void;
  readonly info?: (message: string, context?: Record<string, unknown>) => void;
}

/**
 * Construction-time dependencies for {@link SpentStateRescanWorker}.
 */
export interface SpentStateRescanWorkerDeps {
  /** Token iterable provider — see {@link TokenIterableProvider}. */
  readonly tokensProvider: TokenIterableProvider;
  /** Oracle provider — see {@link SpentStateOracleProvider}. */
  readonly oracleProvider: SpentStateOracleProvider;
  /** Extract current destination state hash from a token. */
  readonly extractCurrentStateHash: ExtractCurrentStateHashFn;
  /**
   * SENT-ledger lookup provider for `suspectedSiblingInstance`
   * heuristic. Optional; absence means we cannot prove this device
   * spent it, so the flag conservatively reports `true`.
   */
  readonly sentProvider?: SentLookupProvider;
  /**
   * OUTBOX lookup provider for `suspectedSiblingInstance`. Optional
   * (same rationale as `sentProvider`).
   */
  readonly outboxProvider?: OutboxLookupProvider;
  /**
   * Disposition-route hook. Optional; when absent the worker only
   * emits the event (no `_audit` transition). The default
   * PaymentsModule wiring SHOULD always supply this — the optional
   * shape lets tests exercise the detect-only path.
   */
  readonly transitionToAudit?: TransitionToAuditFn;
  /**
   * Sphere event emitter. Forward-compatible with async emitters:
   * `void | Promise<void>` return.
   */
  readonly emit: <T extends SphereEventType>(
    type: T,
    data: SphereEventMap[T],
  ) => void | Promise<void>;
  /** Logger. */
  readonly logger?: SpentStateRescanWorkerLogger;
  /** Wall-clock provider. Default `Date.now`. Tests inject a fixed clock. */
  readonly now?: () => number;
}

/**
 * Tunable knobs. All have defaults; tests override.
 *
 *  - `intervalMs` (default 5 min): how often the scan loop fires.
 *    Matches the per-token interval so a steady-state wallet pays
 *    one probe per token per 5 min.
 *  - `perTokenIntervalMs` (default 5 min): minimum time between
 *    probes for the SAME token. Aligns with the default
 *    `oracle.isSpent` LRU cache TTL so the worker piggybacks on the
 *    cache instead of bypassing it.
 *  - `maxConcurrent` (default 4): cap on concurrent oracle probes
 *    per cycle. Throttles aggregator load on wallets with large
 *    active pools.
 *  - `consecutiveThrowBackoffThreshold` (default 3): after N
 *    consecutive throws on the SAME token, apply per-token back-off.
 *  - `throwBackoffMs` (default 30 min): per-token back-off duration
 *    after the throw threshold is reached. A subsequent successful
 *    probe (true OR false) clears the throw counter.
 */
export interface SpentStateRescanWorkerOptions {
  readonly intervalMs?: number;
  readonly perTokenIntervalMs?: number;
  readonly maxConcurrent?: number;
  readonly consecutiveThrowBackoffThreshold?: number;
  readonly throwBackoffMs?: number;
}

/** Default sweep cycle interval — 5 min. */
export const DEFAULT_SPENT_RESCAN_INTERVAL_MS = 5 * 60 * 1000;
/** Default per-token re-probe interval — 5 min. Spec name:
 *  `TOKEN_SPENT_RESCAN_INTERVAL`. */
export const TOKEN_SPENT_RESCAN_INTERVAL = 5 * 60 * 1000;
/** Default concurrent-probe cap. Spec name:
 *  `MAX_CONCURRENT_SPENT_RESCANS`. */
export const MAX_CONCURRENT_SPENT_RESCANS = 4;
/** Default consecutive-throw back-off threshold. */
export const DEFAULT_CONSECUTIVE_THROW_BACKOFF_THRESHOLD = 3;
/** Default per-token back-off after threshold reached — 30 min. */
export const DEFAULT_THROW_BACKOFF_MS = 30 * 60 * 1000;

// =============================================================================
// 2. SpentStateRescanWorker
// =============================================================================

interface TokenProbeState {
  /** Wall-clock ms of the last successful (true OR false) probe. 0 = never. */
  lastCheckedAt: number;
  /** Consecutive throws since the last successful probe. */
  consecutiveThrows: number;
  /** Wall-clock ms until which this token is in throw-back-off. */
  backoffUntil: number;
}

/**
 * Periodic worker for per-token spent-state rescan. See module doc
 * for full semantics.
 */
export class SpentStateRescanWorker {
  private readonly deps: SpentStateRescanWorkerDeps;
  private readonly intervalMs: number;
  private readonly perTokenIntervalMs: number;
  private readonly maxConcurrent: number;
  private readonly throwBackoffThreshold: number;
  private readonly throwBackoffMs: number;
  private readonly now: () => number;

  /** Per-token probe state. In-memory only; restart re-arms. */
  private readonly probeState: Map<string, TokenProbeState> = new Map();

  /** `true` between `start()` and the first `stop()`. */
  private running = false;
  /** Pending timer handle for the next scheduled cycle. */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** In-flight scan promise; awaited by `stop()` so callers see
   *  graceful drain. */
  private scanInFlight: Promise<void> | null = null;

  constructor(
    deps: SpentStateRescanWorkerDeps,
    options?: SpentStateRescanWorkerOptions,
  ) {
    this.deps = deps;
    this.intervalMs = options?.intervalMs ?? DEFAULT_SPENT_RESCAN_INTERVAL_MS;
    this.perTokenIntervalMs =
      options?.perTokenIntervalMs ?? TOKEN_SPENT_RESCAN_INTERVAL;
    this.maxConcurrent = options?.maxConcurrent ?? MAX_CONCURRENT_SPENT_RESCANS;
    this.throwBackoffThreshold =
      options?.consecutiveThrowBackoffThreshold ??
      DEFAULT_CONSECUTIVE_THROW_BACKOFF_THRESHOLD;
    this.throwBackoffMs = options?.throwBackoffMs ?? DEFAULT_THROW_BACKOFF_MS;
    this.now = deps.now ?? ((): number => Date.now());
  }

  /**
   * Start the periodic scan. Idempotent. The first scan fires after
   * one `intervalMs` delay so the worker doesn't race with whatever
   * just instantiated it.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  /**
   * Stop the periodic scan and await any in-flight cycle. Idempotent.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.scanInFlight !== null) {
      await this.scanInFlight.catch(() => undefined);
      this.scanInFlight = null;
    }
  }

  /** Diagnostic. */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * One scan pass. Public so tests can trigger a cycle deterministically
   * without waiting for the timer.
   */
  async runScanCycle(): Promise<SpentRescanCycleResult> {
    const oracle = this.deps.oracleProvider();
    if (oracle === null) {
      return emptyResult({ skipped: true });
    }

    const nowMs = this.now();

    // Build the OUTBOX-active set ONCE per cycle so we don't pay
    // `readAll` per token. An empty / null OUTBOX is treated as
    // "no active sends" (the worker still operates).
    const outboxActiveTokenIds = await this.computeOutboxActiveTokenIds();

    // Filter for eligibility. We materialize the candidate list
    // up-front so we can apply the concurrency cap without
    // re-walking the iterable.
    const candidates: Array<{ token: Token; stateHash: string }> = [];
    for (const token of this.deps.tokensProvider()) {
      if (token.status !== 'confirmed') continue;
      if (typeof token.sdkData !== 'string' || token.sdkData.length === 0) {
        continue;
      }
      const state = this.probeState.get(token.id);
      if (state !== undefined) {
        // Per-token back-off due to consecutive throws.
        if (state.backoffUntil > nowMs) continue;
        // Per-token interval gate (a recent successful probe
        // covers the cache window).
        if (
          state.lastCheckedAt > 0 &&
          nowMs - state.lastCheckedAt < this.perTokenIntervalMs
        ) {
          continue;
        }
      }
      // Exclude tokens with an active OUTBOX entry — the send-
      // pipeline owns those.
      if (outboxActiveTokenIds.has(token.id)) continue;
      const stateHash = this.deps.extractCurrentStateHash(token);
      if (stateHash === '') continue;
      candidates.push({ token, stateHash });
    }

    if (candidates.length === 0) {
      return emptyResult({ skipped: false });
    }

    let probed = 0;
    let spent = 0;
    let unspent = 0;
    let threw = 0;

    // Concurrency-capped batch processing. We slice the candidate
    // list into batches of `maxConcurrent` and `await Promise.all`
    // each batch — simple, deterministic, and matches the
    // `maxScanPerCycle` accounting style used by the verifier.
    for (let i = 0; i < candidates.length; i += this.maxConcurrent) {
      const batch = candidates.slice(i, i + this.maxConcurrent);
      const outcomes = await Promise.all(
        batch.map((c) => this.probeOne(oracle, c.token, c.stateHash)),
      );
      for (const outcome of outcomes) {
        probed += 1;
        if (outcome === 'spent') spent += 1;
        else if (outcome === 'unspent') unspent += 1;
        else threw += 1;
      }
    }

    return {
      probed,
      eligibleTotal: candidates.length,
      spent,
      unspent,
      threw,
      skipped: false,
    };
  }

  // ===========================================================================
  // Private helpers
  // ===========================================================================

  /**
   * Walk OUTBOX once per cycle and build a set of tokenIds with
   * live (non-tombstone) entries. Cheap if OUTBOX is small; an
   * error during read is treated as empty (we degrade to scanning
   * all candidates rather than blocking).
   */
  private async computeOutboxActiveTokenIds(): Promise<Set<string>> {
    const out = new Set<string>();
    const provider = this.deps.outboxProvider;
    if (provider === undefined) return out;
    const writer = provider();
    if (writer === null) return out;
    let entries: ReadonlyArray<{ entry: { tokenIds: ReadonlyArray<string> } }>;
    try {
      entries = (await writer.readAll()) as ReadonlyArray<{
        entry: { tokenIds: ReadonlyArray<string> };
      }>;
    } catch (err) {
      this.warn('OUTBOX readAll failed; scanning without OUTBOX exclusion', {
        err: errMessage(err),
      });
      return out;
    }
    for (const classified of entries) {
      // ClassifiedOutboxEntry shape: both `uxf-1` and `legacy`
      // variants carry `entry.tokenIds`. Defense-in-depth: ignore
      // entries without an array tokenIds field.
      const tokenIds = classified?.entry?.tokenIds;
      if (!Array.isArray(tokenIds)) continue;
      for (const id of tokenIds) {
        if (typeof id === 'string' && id.length > 0) out.add(id);
      }
    }
    return out;
  }

  /**
   * Probe one token and apply outcome side-effects. Returns the
   * outcome classification for cycle counters.
   */
  private async probeOne(
    oracle: NonNullable<ReturnType<SpentStateOracleProvider>>,
    token: Token,
    stateHash: string,
  ): Promise<'spent' | 'unspent' | 'threw'> {
    let isSpent: boolean;
    try {
      // Issue #245 #1 — pass the token so the wrapper can derive the
      // current state's predicate publicKey (canonical aggregator
      // requestId basis). See SpentStateOracleProvider for rationale.
      isSpent = await oracle.isSpent(token, stateHash);
    } catch (err) {
      this.recordThrow(token.id);
      this.warn('oracle.isSpent threw; bumping per-token throw counter', {
        tokenId: token.id,
        err: errMessage(err),
      });
      return 'threw';
    }
    // Successful probe — record timestamp + reset throw counter.
    this.recordSuccess(token.id);

    if (!isSpent) return 'unspent';

    // Off-record spend detected. Compute the heuristic
    // `suspectedSiblingInstance` flag, emit the event, route to
    // disposition writer if wired.
    const detectedAt = this.now();
    const suspectedSiblingInstance = await this.computeSuspectedSiblingInstance(
      token.id,
    );

    try {
      await this.deps.emit('transfer:off-record-spent', {
        tokenId: token.id,
        detectedAt,
        suspectedSiblingInstance,
        coinId: token.coinId,
        amount: token.amount,
      });
    } catch (emitErr) {
      this.warn('emit transfer:off-record-spent failed', {
        tokenId: token.id,
        err: errMessage(emitErr),
      });
    }

    if (this.deps.transitionToAudit !== undefined) {
      try {
        await this.deps.transitionToAudit({
          token,
          currentStateHash: stateHash,
          suspectedSiblingInstance,
          detectedAt,
        });
      } catch (auditErr) {
        // Event has already fired; transitionToAudit failure is
        // logged but not rethrown — the operator still sees the
        // detection and can re-run after fixing the underlying
        // storage issue.
        this.warn('transitionToAudit failed (event already emitted)', {
          tokenId: token.id,
          err: errMessage(auditErr),
        });
      }
    }
    return 'spent';
  }

  /**
   * Compute `suspectedSiblingInstance` heuristic: `true` when neither
   * the local SENT ledger NOR the local OUTBOX has any entry
   * referencing this `tokenId`. When either is missing wiring, we
   * conservatively report `true` for that side (presence is required
   * to PROVE the local instance is the spender; absence is the
   * default).
   *
   * Best-effort: an error on either lookup is treated as "no
   * record" and logged. The heuristic is informational; operators
   * confirm via sibling-device inspection.
   */
  private async computeSuspectedSiblingInstance(
    tokenId: string,
  ): Promise<boolean> {
    // SENT side.
    const sentLookup = this.deps.sentProvider?.();
    if (sentLookup !== undefined && sentLookup !== null) {
      try {
        const hit = await sentLookup.contains(tokenId);
        if (hit) return false;
      } catch (err) {
        this.warn('sent.contains threw; treating as no record', {
          tokenId,
          err: errMessage(err),
        });
      }
    }
    // OUTBOX side. We reuse the cycle's pre-built set via the
    // separate readAll path here — for the post-detection path
    // we re-read OUTBOX directly so the answer reflects state at
    // the moment of detection (not at cycle start). Cheap; only
    // runs on the rare isSpent=true branch.
    const outboxProvider = this.deps.outboxProvider;
    if (outboxProvider !== undefined) {
      const writer = outboxProvider();
      if (writer !== null) {
        try {
          const entries = (await writer.readAll()) as ReadonlyArray<{
            entry: { tokenIds: ReadonlyArray<string> };
          }>;
          for (const classified of entries) {
            const tokenIds = classified?.entry?.tokenIds;
            if (!Array.isArray(tokenIds)) continue;
            if (tokenIds.includes(tokenId)) return false;
          }
        } catch (err) {
          this.warn('outbox.readAll threw; treating as no record', {
            tokenId,
            err: errMessage(err),
          });
        }
      }
    }
    return true;
  }

  private recordThrow(tokenId: string): void {
    const prev = this.probeState.get(tokenId);
    const nowMs = this.now();
    const consecutiveThrows = (prev?.consecutiveThrows ?? 0) + 1;
    const backoffUntil =
      consecutiveThrows >= this.throwBackoffThreshold
        ? nowMs + this.throwBackoffMs
        : prev?.backoffUntil ?? 0;
    this.probeState.set(tokenId, {
      // Don't bump lastCheckedAt on a throw — only success counts
      // toward the per-token interval gate.
      lastCheckedAt: prev?.lastCheckedAt ?? 0,
      consecutiveThrows,
      backoffUntil,
    });
  }

  private recordSuccess(tokenId: string): void {
    this.probeState.set(tokenId, {
      lastCheckedAt: this.now(),
      consecutiveThrows: 0,
      backoffUntil: 0,
    });
  }

  /**
   * Schedule the next scan via recursive setTimeout. IIFE pattern
   * mirrors the verifier's: assign `this.scanInFlight` synchronously
   * so `stop()` cannot observe `null` while a cycle is mid-flight.
   */
  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scanInFlight = (async (): Promise<void> => {
        try {
          await this.runScanCycle();
        } catch (err) {
          this.warn('unexpected scan-cycle throw', { err: errMessage(err) });
        }
      })();
      void this.scanInFlight.finally(() => {
        this.scanInFlight = null;
        this.scheduleNext();
      });
    }, this.intervalMs);
  }

  private warn(message: string, context?: Record<string, unknown>): void {
    this.deps.logger?.warn(`SpentStateRescanWorker: ${message}`, context);
  }
}

// =============================================================================
// 3. Result types + helpers
// =============================================================================

/**
 * One scan cycle's outcome. `skipped: true` means the cycle did not
 * run a meaningful sweep (no oracle wired) — counters in that case
 * are all zero.
 */
export interface SpentRescanCycleResult {
  /** Number of tokens probed this cycle. */
  readonly probed: number;
  /** Total eligible tokens identified by the filter. Equals `probed`
   *  in the current implementation; kept distinct for forward-compat
   *  with a per-cycle cap. */
  readonly eligibleTotal: number;
  /** Tokens verified spent this cycle (event emitted). */
  readonly spent: number;
  /** Tokens verified unspent this cycle (no event). */
  readonly unspent: number;
  /** Tokens whose probe threw (treated as transient; no event). */
  readonly threw: number;
  /** `true` when the cycle was a no-op (oracle missing). */
  readonly skipped: boolean;
}

function emptyResult(
  partial: Partial<SpentRescanCycleResult> = {},
): SpentRescanCycleResult {
  return {
    probed: 0,
    eligibleTotal: 0,
    spent: 0,
    unspent: 0,
    threw: 0,
    skipped: false,
    ...partial,
  };
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(redactCause(err));
  } catch {
    return String(err);
  }
}
