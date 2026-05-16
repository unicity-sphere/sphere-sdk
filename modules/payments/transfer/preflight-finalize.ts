/**
 * UXF Inter-Wallet Transfer — source-token preflight finalize (T.2.A).
 *
 * Conservative-mode (§2.2) and chain-mode (§2.3) sends require that EVERY
 * predecessor transaction of every selected source token already carries an
 * inclusion proof BEFORE the UXF bundle is built. This module is the
 * single-purpose utility that walks each source token's history, identifies
 * txs that lack a proof, submits + polls them in topological order, and
 * returns the finalized token list.
 *
 * Reused by:
 *  - `conservative-sender.ts` (T.2.D.1) — runs preflight on every selected
 *    source before constructing the bundle.
 *  - Future TXF-conservative arm (T.7.A) — same source-finalization
 *    semantics, different wire shape.
 *
 * Spec references:
 *  - `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §2.2 (conservative full-history
 *    finalization-before-send).
 *  - `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §2.3 (chain-mode framing — what
 *    "K unfinalized predecessors" means).
 *  - `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §6.1 (canonical aggregator-error →
 *    {@link DispositionReason} mapping; the same mapping is used both by
 *    the post-publish finalization worker AND this pre-publish preflight).
 *  - `docs/uxf/UXF-TRANSFER-IMPL-PLAN.md` §T.2.A (this task).
 *
 * Design notes:
 *  - **Pure async function, no module-level state.** Every dependency
 *    (aggregator, persistence, emitter, abort signal, retry budget) is
 *    passed in as an option. T.2.D.1 wires production defaults; tests
 *    inject inline mocks.
 *  - **Idempotent.** Each pending tx is first probed via
 *    {@link OracleProvider.getProof}; only un-anchored commitments
 *    advance to {@link OracleProvider.submitCommitment}. Re-running the
 *    function on a partially-finalized source picks up where it left off.
 *  - **No PaymentsModule coupling.** The function does not assume a
 *    surrounding wallet — it consumes a `requestIdResolver` callback so
 *    the caller can derive `(requestId, transactionHash, commitment)` per
 *    pending tx however suits its data model. Production wiring derives
 *    these from the local pending-commitment ledger; tests stub them
 *    directly.
 *  - **Bounded retries with exponential backoff.** The transient-vs-hard
 *    distinction is the same one §6.1 makes for the post-publish worker.
 *    Mapping at {@link mapAggregatorRejection}.
 *
 * @module modules/payments/transfer/preflight-finalize
 * @internal
 */

import { SphereError } from '../../../core/errors';
import { sanitizeReasonString, safeErrorMessage } from '../../../core/error-sanitize';
import type {
  InclusionProof,
  OracleProvider,
  SubmitResult,
} from '../../../oracle/oracle-provider';
import type { Token } from '../../../types';
import type { DispositionReason } from '../../../types/disposition';

// =============================================================================
// 1. Public types — events, options, results, hard-fail cause
// =============================================================================

/**
 * Per-tx progress event emitted by {@link preflightFinalize} as it works
 * through a chain. T.2.D.1 forwards these into the SDK event bus as
 * `transfer:preflight-progress`; standalone callers may also subscribe via
 * the {@link PreflightFinalizeOptions.emit} hook.
 */
export interface PreflightProgressEvent {
  /** Canonical token id of the source whose chain is being walked. */
  readonly tokenId: string;
  /**
   * Total pending-tx depth observed for this token at the start of the
   * walk (i.e. how many txs lacked a proof when preflight began). Stable
   * across the whole walk for this token; emitted on every step so a UI
   * can render `currentStep / chainDepth`.
   */
  readonly chainDepth: number;
  /** 1-based index of the tx the worker just finalized. */
  readonly currentStep: number;
  /** Aggregator-side request identifier for this tx. */
  readonly requestId: string;
}

/**
 * Caller-supplied descriptor for a pending transaction. Production wiring
 * derives `requestId` via SDK `RequestId.create(publicKey, stateHash)`
 * (see `@unicitylabs/state-transition-sdk/lib/api/RequestId.js`); test
 * code returns precomputed deterministic ids.
 *
 * Fields are intentionally minimal — the preflight worker does not parse
 * the wallet's local pending-commitment ledger; the caller's resolver does.
 */
export interface PendingTxDescriptor {
  /** Aggregator request id (`SHA-256(publicKey || stateHash.imprint)`). */
  readonly requestId: string;
  /**
   * Local-belief transaction hash hex (DataHash imprint, typically 68
   * chars for sha2-256). Used for the §6.1 race-lost detection: when
   * the polled proof's `transactionHash` mismatches this value, we lost
   * the submit-race and the cascade does NOT fire.
   */
  readonly transactionHash: string;
  /**
   * Optional opaque commitment object the caller wishes the preflight to
   * forward to {@link OracleProvider.submitCommitment} when the aggregator
   * has not yet seen this requestId. May be omitted by callers that only
   * want to ATTACH already-anchored proofs (idempotent re-runs).
   */
  readonly commitment?: unknown;
}

/**
 * Resolver that maps `(token, pendingTx, indexWithinChain)` to a
 * {@link PendingTxDescriptor}. Throwing from this resolver is treated as
 * a `'client-error'` hard-fail (the local data model is inconsistent).
 *
 * `pendingTx` is the raw entry the caller exposed when iterating the
 * source token's chain — the preflight does not interpret it (no on-disk
 * format coupling).
 */
export type RequestIdResolver = (
  token: Token,
  pendingTx: unknown,
  index: number,
) => Promise<PendingTxDescriptor> | PendingTxDescriptor;

/**
 * Iterator over a single source token's pending (proofless) transactions
 * in TOPOLOGICAL order — oldest predecessor first, latest tx last.
 *
 * The caller controls extraction so the preflight stays decoupled from
 * the on-disk token model (TXF, SDK Token, future shapes). The default
 * iterator that production wiring uses lives in T.2.D.1.
 *
 * Returning an empty array means "this source is fully finalized" — the
 * preflight does nothing for that token (no-op acceptance criterion).
 */
export type PendingChainExtractor = (token: Token) =>
  | Iterable<unknown>
  | AsyncIterable<unknown>
  | ReadonlyArray<unknown>;

/**
 * Optional persistence callback fired after a single pending tx of a
 * source has had its inclusion proof attached (and after the resolver
 * has had a chance to update internal state). The preflight does not
 * mutate {@link Token} itself — production wiring writes through the
 * wallet's token-storage on each progress step. Tests typically pass an
 * inline recorder and assert the call sequence.
 */
export type PersistProofCallback = (params: {
  readonly token: Token;
  readonly descriptor: PendingTxDescriptor;
  readonly proof: InclusionProof;
}) => Promise<void> | void;

/**
 * All knobs the preflight exposes. Defaults are tuned for production
 * conservative-mode sends; tests override liberally.
 */
export interface PreflightFinalizeOptions {
  /** Aggregator client (`OracleProvider`). REQUIRED. */
  readonly aggregator: OracleProvider;
  /** Maps each pending tx to a {@link PendingTxDescriptor}. REQUIRED. */
  readonly resolveRequestId: RequestIdResolver;
  /**
   * Walks a source token's chain in topological order (oldest first),
   * yielding every tx that lacks an inclusion proof. REQUIRED.
   */
  readonly extractPendingChain: PendingChainExtractor;
  /**
   * Optional progress sink. Fires AFTER each tx's proof has been
   * attached (+ persisted, if `persistProof` is set). Errors thrown by
   * the emitter are NOT caught — callers MUST not throw from here in
   * production.
   */
  readonly emit?: (event: PreflightProgressEvent) => void;
  /**
   * Optional per-tx persistence hook (see {@link PersistProofCallback}).
   * Tests typically use this to assert idempotent-resume behavior.
   */
  readonly persistProof?: PersistProofCallback;
  /**
   * Cooperative cancellation. Checked at the top of every per-tx
   * iteration; if the signal is aborted the function throws
   * `signal.reason ?? new DOMException('Aborted', 'AbortError')`
   * via the standard `AbortSignal.throwIfAborted()` semantic. Already-
   * persisted proofs ahead of the abort point are kept (idempotent
   * resume on re-run).
   */
  readonly signal?: AbortSignal;
  /**
   * Bounded retry budget for transient aggregator errors. Default 3.
   * Exhaustion is treated as a hard-fail with reason='oracle-rejected'.
   *
   * Rationale: §6.1's post-publish worker uses a generous polling window
   * (30 min default) because it runs out-of-band. Preflight runs in the
   * caller's `send()` await — a wall-clock budget would be hostile UX.
   * 3 retries with exponential backoff (default ~500ms, ~1s, ~2s ≈ 3.5s
   * worst case) catches typical transient blips without making the user
   * wait minutes for a permanent failure.
   */
  readonly transientRetryCount?: number;
  /**
   * Initial backoff between retries, in milliseconds. Exponential growth
   * (×2 per attempt) up to {@link transientRetryCount}. Default 500ms.
   * Tests pass `0` to make retry semantics exercisable without timers.
   */
  readonly transientRetryDelayMs?: number;
  /**
   * Optional sleep helper. Production wires `setTimeout`; tests inject a
   * vitest-fake-timer-friendly stub. When omitted, real `setTimeout` is
   * used. The function is invoked as `await sleep(ms, signal)` so the
   * sleep itself respects abort.
   */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Successful return value from {@link preflightFinalize}. The
 * `finalizedSources` array preserves input order; tokens that needed no
 * work pass through unchanged (referential equality preserved). Tokens
 * whose chain advanced are returned as the SAME identity object — the
 * preflight does NOT mutate the {@link Token} structurally; the proof
 * persistence is owned by `persistProof`.
 */
export interface PreflightFinalizeResult {
  readonly finalizedSources: ReadonlyArray<Token>;
  /**
   * Total number of pending txs that the preflight resolved across all
   * sources. Useful for telemetry — `0` means every source was already
   * finalized on entry.
   */
  readonly totalAdvanced: number;
}

/**
 * Structured cause attached to {@link SphereError} when preflight throws
 * `SOURCE_CHAIN_HARD_FAIL`. Surfaced via `err.cause` so consumers can
 * distinguish race-lost (cascade does NOT fire) from oracle-rejected
 * (cascade DOES fire) without re-parsing message strings.
 */
export interface SourceChainHardFailCause {
  readonly tokenId: string;
  readonly requestId: string;
  readonly reason: DispositionReason;
  /**
   * Step within the chain (1-based) at which the hard-fail occurred.
   * `chainDepth` is the total length observed at the start of the walk.
   * Together they support deep-chain forensics (which tx in the
   * source's history actually broke).
   */
  readonly currentStep: number;
  readonly chainDepth: number;
  /**
   * Original aggregator error string, if any. Best-effort.
   *
   * **W40 redaction (Round 5).** This field name is in `REDACTED_FIELDS`,
   * so the value visible in `err.cause.aggregatorError` after the
   * `SphereError` constructor walks the cause is `[REDACTED:
   * aggregatorError(...)]`. The originally-supplied (pre-redaction)
   * string is sanitized at the throw site (`raiseHardFail`) and ALSO
   * surfaced under the W40-survive name `aggregatorErrorSummary` for
   * operators who need readable forensics.
   */
  readonly aggregatorError?: string;
  /**
   * Sanitized rendering of {@link aggregatorError} that survives W40
   * redaction (the field name is NOT in `REDACTED_FIELDS`). The throw
   * site (`raiseHardFail`) splices `sanitizeReasonString(aggregatorError)`
   * here so operators retain readable diagnostic text without the W40
   * raw-bytes-leak risk. See `core/errors.ts` REDACTED_FIELDS docs.
   */
  readonly aggregatorErrorSummary?: string;
}

// =============================================================================
// 2. Aggregator-error → DispositionReason mapping (§6.1)
// =============================================================================

/**
 * Canonical mapping table per `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §6.1.
 * Keys are the SDK's `SubmitCommitmentStatus` and proof-verify status
 * strings as they are surfaced to the {@link OracleProvider} adapter; the
 * value is the {@link DispositionReason} the protocol mandates we record
 * when this rejection becomes terminal.
 *
 * | Aggregator code                       | DispositionReason     | Notes |
 * |---------------------------------------|-----------------------|-------|
 * | `AUTHENTICATOR_VERIFICATION_FAILED`   | `belief-divergence`   | local crypto passed, aggregator's didn't |
 * | `REQUEST_ID_MISMATCH`                 | `client-error`        | client sent inconsistent tuple — CLIENT BUG |
 * | sustained `PATH_NOT_INCLUDED`         | `oracle-rejected`     | commitment never anchored within window |
 * | `PATH_INVALID` (after retries)        | `proof-invalid`       | proof structurally malformed |
 * | `NOT_AUTHENTICATED` (after retries)   | `proof-invalid`       | likely stale local trustBase, treat as proof-invalid |
 * | proof-tx-hash mismatch under `OK`     | `race-lost`           | race-winner anchored a different tx — cascade does NOT fire |
 * | resolver throw / non-mapped           | `client-error`        | local data model inconsistent — fail closed |
 *
 * Transient categories (network / 5xx, fresh `PATH_NOT_INCLUDED` within
 * the polling window) are NOT in the table — they trigger bounded
 * retries and only surface as `oracle-rejected` if exhausted. The
 * `REQUEST_ID_EXISTS` submit response is treated as success (idempotent
 * resubmit OR race-winner submit; the post-poll tx-hash compare is the
 * disambiguator, per §6.1).
 */
const HARD_REJECTION_CODES: ReadonlyMap<string, DispositionReason> = new Map<
  string,
  DispositionReason
>([
  ['AUTHENTICATOR_VERIFICATION_FAILED', 'belief-divergence'],
  ['REQUEST_ID_MISMATCH', 'client-error'],
  ['PATH_INVALID', 'proof-invalid'],
  ['NOT_AUTHENTICATED', 'proof-invalid'],
]);

/**
 * Heuristic — given an aggregator error message string, decide whether
 * it's a HARD rejection (and which {@link DispositionReason} it maps to)
 * or a transient blip we should retry. Production aggregator
 * implementations forward the SDK's `SubmitCommitmentStatus` literal in
 * the error.message; we substring-match against the canonical set.
 *
 * Defensive: substring matching is the LEAST-strict form, but the
 * SubmitCommitmentStatus literals (`AUTHENTICATOR_VERIFICATION_FAILED`,
 * `REQUEST_ID_MISMATCH`) are sufficiently distinctive that false-positive
 * matches against arbitrary network-error strings are vanishingly
 * unlikely. If the aggregator surfaces a different shape in the future,
 * extend the table here.
 *
 * Returns `null` for transient (retry) errors.
 */
export function mapAggregatorRejection(
  errorMessage: string | undefined,
): DispositionReason | null {
  if (!errorMessage) return null;
  // Uppercase for case-insensitive substring scan; the canonical SDK
  // codes are already uppercase, but defensive against custom adapters.
  const upper = errorMessage.toUpperCase();
  for (const [code, reason] of HARD_REJECTION_CODES) {
    if (upper.includes(code)) return reason;
  }
  return null;
}

// =============================================================================
// 3. Internal helpers
// =============================================================================

/**
 * Default sleep — `setTimeout`-based, abort-aware. Tests inject a stub.
 */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    signal?.throwIfAborted?.();
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    if (signal?.aborted) {
      clearTimeout(t);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * Construct + throw a `SOURCE_CHAIN_HARD_FAIL` SphereError with structured
 * cause. Caller (T.2.D.1) catches and re-throws as `INSUFFICIENT_BALANCE`
 * with reason='source-cascade-failed'; preflight stays purely descriptive.
 *
 * **Round 5 fix.** Sanitize `aggregatorError` at the SINGLE throw site so
 * a hostile aggregator-supplied error string (control chars, HTML, multi-MB
 * body) cannot ride through `err.cause.aggregatorError` unchanged. The
 * existing `redactCause` in `core/errors.ts` walks the cause for sensitive
 * field names, but does NOT sanitize string content; sanitization is the
 * complementary defense per §6.1 / steelman closure round 1. Mirrors the
 * pattern already in place in `finalization-worker-base.ts` (commit 87bc99e).
 */
function raiseHardFail(cause: SourceChainHardFailCause): never {
  // Sanitize untrusted fields ONCE at the throw site so every downstream
  // observer (logger, Sentry, operator dashboard, JSON.stringify) sees a
  // safe form. Leave structured fields (tokenId, requestId, reason,
  // currentStep, chainDepth) alone — they are caller-shaped and not
  // aggregator-attacker-shaped.
  //
  // The W40 redaction layer in core/errors.ts now lists `aggregatorError`
  // among the REDACTED_FIELDS (defense-in-depth — Round 5), so the raw
  // value visible in `err.cause.aggregatorError` is the redaction marker.
  // We surface the sanitized text under a different field name
  // (`aggregatorErrorSummary`) that survives W40, so operator forensics
  // retain a readable, sanitized diagnostic.
  const safeAggregatorError =
    cause.aggregatorError !== undefined
      ? sanitizeReasonString(cause.aggregatorError)
      : undefined;
  const sanitizedCause: SourceChainHardFailCause = {
    ...cause,
    // The raw key is still attached so existing call sites that look it
    // up by name find SOMETHING — but the W40 layer will replace its
    // value with `[REDACTED: aggregatorError(...)]` once the SphereError
    // constructor walks the cause. The sanitized summary below is the
    // operator-friendly, W40-safe alternative.
    aggregatorError: safeAggregatorError,
    aggregatorErrorSummary: safeAggregatorError,
  };
  const msg =
    `Preflight finalize hard-fail at step ${cause.currentStep}/${cause.chainDepth} ` +
    `for token ${cause.tokenId} (requestId=${cause.requestId}, reason=${cause.reason})`;
  throw new SphereError(msg, 'SOURCE_CHAIN_HARD_FAIL', sanitizedCause);
}

/**
 * Try to fetch an existing inclusion proof for this requestId. Returns
 * the proof (idempotent re-run path) or `null` if the aggregator has
 * never seen this commitment.
 *
 * Wraps the OracleProvider's nullable `getProof` so the caller's
 * happy-path code can treat "no proof yet" and "transient error during
 * proof fetch" identically — both surface as `null` here, the latter
 * triggers the retry-or-submit flow upstream.
 *
 * Distinct from the post-submit poll loop: that path waits for a fresh
 * proof to materialize; this is a single-shot pre-submit probe.
 */
async function probeExistingProof(
  aggregator: OracleProvider,
  requestId: string,
): Promise<InclusionProof | null> {
  try {
    return await aggregator.getProof(requestId);
  } catch {
    // Treat any throw as "not found yet" — we'll fall through to submit
    // and the submit/poll path applies its own bounded retry budget.
    return null;
  }
}

/**
 * Submit a commitment with bounded transient-retry, then poll for proof.
 * Hard rejections short-circuit immediately; transient blips consume
 * retry budget. Throws `SOURCE_CHAIN_HARD_FAIL` on any terminal failure.
 */
async function submitAndAwaitProof(args: {
  readonly aggregator: OracleProvider;
  readonly token: Token;
  readonly descriptor: PendingTxDescriptor;
  readonly currentStep: number;
  readonly chainDepth: number;
  readonly transientRetryCount: number;
  readonly transientRetryDelayMs: number;
  readonly signal: AbortSignal | undefined;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<InclusionProof> {
  const {
    aggregator,
    token,
    descriptor,
    currentStep,
    chainDepth,
    transientRetryCount,
    transientRetryDelayMs,
    signal,
    sleep,
  } = args;

  // === Submit phase: bounded transient retry, immediate hard-fail on
  // === structured rejections (§6.1 submit-side mapping). ===
  let submitResult: SubmitResult | null = null;
  let submitError: string | undefined;
  for (let attempt = 0; attempt <= transientRetryCount; attempt++) {
    signal?.throwIfAborted?.();
    if (descriptor.commitment === undefined) {
      // Caller has no commitment to submit (idempotent attach-only flow);
      // fall through to the poll phase. If the aggregator has never seen
      // this requestId we'll exhaust retries → 'oracle-rejected'.
      submitResult = { success: true, requestId: descriptor.requestId, timestamp: Date.now() };
      break;
    }
    try {
      const result = await aggregator.submitCommitment(
        descriptor.commitment as never,
      );
      if (result.success) {
        submitResult = result;
        break;
      }
      // Submit returned non-success — distinguish hard vs transient.
      submitError = result.error;
      const hardReason = mapAggregatorRejection(result.error);
      if (hardReason !== null) {
        raiseHardFail({
          tokenId: token.id,
          requestId: descriptor.requestId,
          reason: hardReason,
          currentStep,
          chainDepth,
          aggregatorError: result.error,
        });
      }
      // Transient — retry with exponential backoff if budget remains.
      if (attempt < transientRetryCount) {
        await sleep(transientRetryDelayMs * Math.pow(2, attempt), signal);
        continue;
      }
      // Budget exhausted; treat as oracle-rejected.
      raiseHardFail({
        tokenId: token.id,
        requestId: descriptor.requestId,
        reason: 'oracle-rejected',
        currentStep,
        chainDepth,
        aggregatorError: result.error,
      });
    } catch (err) {
      if (err instanceof SphereError && err.code === 'SOURCE_CHAIN_HARD_FAIL') {
        // raiseHardFail() above. Re-throw verbatim.
        throw err;
      }
      // Native throw — treat as transient (could be network / 5xx wrapped
      // by the adapter). Apply same retry budget as a non-success result.
      submitError = safeErrorMessage(err);
      const hardReason = mapAggregatorRejection(submitError);
      if (hardReason !== null) {
        raiseHardFail({
          tokenId: token.id,
          requestId: descriptor.requestId,
          reason: hardReason,
          currentStep,
          chainDepth,
          aggregatorError: submitError,
        });
      }
      if (attempt < transientRetryCount) {
        await sleep(transientRetryDelayMs * Math.pow(2, attempt), signal);
        continue;
      }
      raiseHardFail({
        tokenId: token.id,
        requestId: descriptor.requestId,
        reason: 'oracle-rejected',
        currentStep,
        chainDepth,
        aggregatorError: submitError,
      });
    }
  }

  // The loop above either set submitResult or threw via raiseHardFail.
  /* c8 ignore next */
  if (submitResult === null) {
    raiseHardFail({
      tokenId: token.id,
      requestId: descriptor.requestId,
      reason: 'oracle-rejected',
      currentStep,
      chainDepth,
      aggregatorError: submitError,
    });
  }

  // === Poll phase: bounded transient retry on null/throw. ===
  let pollError: string | undefined;
  for (let attempt = 0; attempt <= transientRetryCount; attempt++) {
    signal?.throwIfAborted?.();
    let proof: InclusionProof | null;
    try {
      proof = await aggregator.getProof(descriptor.requestId);
    } catch (err) {
      pollError = safeErrorMessage(err);
      const hardReason = mapAggregatorRejection(pollError);
      if (hardReason !== null) {
        raiseHardFail({
          tokenId: token.id,
          requestId: descriptor.requestId,
          reason: hardReason,
          currentStep,
          chainDepth,
          aggregatorError: pollError,
        });
      }
      if (attempt < transientRetryCount) {
        await sleep(transientRetryDelayMs * Math.pow(2, attempt), signal);
        continue;
      }
      raiseHardFail({
        tokenId: token.id,
        requestId: descriptor.requestId,
        reason: 'oracle-rejected',
        currentStep,
        chainDepth,
        aggregatorError: pollError,
      });
    }
    if (proof !== null) {
      // §6.1 race-lost detection: compare proof's transactionHash against
      // the local-belief transactionHash. Mismatch = race-winner anchored
      // a different transition over the same source state.
      const proofTxHash = extractProofTransactionHash(proof);
      if (
        proofTxHash !== null &&
        proofTxHash.toLowerCase() !== descriptor.transactionHash.toLowerCase()
      ) {
        raiseHardFail({
          tokenId: token.id,
          requestId: descriptor.requestId,
          reason: 'race-lost',
          currentStep,
          chainDepth,
          aggregatorError: `proof.transactionHash=${proofTxHash} mismatches local=${descriptor.transactionHash}`,
        });
      }
      return proof;
    }
    // null proof — aggregator has not yet anchored this commitment. Retry.
    if (attempt < transientRetryCount) {
      await sleep(transientRetryDelayMs * Math.pow(2, attempt), signal);
      continue;
    }
    raiseHardFail({
      tokenId: token.id,
      requestId: descriptor.requestId,
      reason: 'oracle-rejected',
      currentStep,
      chainDepth,
      aggregatorError: 'sustained PATH_NOT_INCLUDED past preflight retry budget',
    });
  }
  /* c8 ignore next 9 */
  raiseHardFail({
    tokenId: token.id,
    requestId: descriptor.requestId,
    reason: 'oracle-rejected',
    currentStep,
    chainDepth,
    aggregatorError: pollError,
  });
}

/**
 * Best-effort extraction of `proof.transactionHash` from the opaque
 * {@link InclusionProof} shape. The provider interface declares `proof:
 * unknown` (the SDK shape), so we structurally probe rather than depending
 * on the SDK's `InclusionProof` class. Returns `null` when the proof is a
 * non-inclusion proof (no authenticator → no tx hash, see SDK
 * `InclusionProof.fromJSON` semantics) or when the field is absent.
 *
 * Defensive vs. malformed responses: anything that doesn't surface as a
 * non-empty string falls through to `null`, which suppresses the
 * race-lost check (we cannot prove a mismatch) — matches the §6.1
 * "match unverifiable" treatment.
 */
function extractProofTransactionHash(proof: InclusionProof): string | null {
  // The SDK currently ships `transactionHash` as a string-imprint hex on
  // both the inner SDK `InclusionProof` and the JSON-serialized form.
  // The aggregator adapter returns `proof: unknown`, so probe both.
  const rec = proof as { readonly transactionHash?: unknown; readonly proof?: unknown };
  const fromTop = pickHashString(rec.transactionHash);
  if (fromTop !== null) return fromTop;
  if (rec.proof !== null && typeof rec.proof === 'object') {
    const inner = (rec.proof as { readonly transactionHash?: unknown }).transactionHash;
    return pickHashString(inner);
  }
  return null;
}

function pickHashString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value !== null && typeof value === 'object') {
    // SDK DataHash exposes `.imprint: Uint8Array` and `toJSON(): string`.
    const v = value as {
      readonly toJSON?: () => unknown;
      readonly imprint?: unknown;
    };
    if (typeof v.toJSON === 'function') {
      const json = v.toJSON();
      if (typeof json === 'string' && json.length > 0) return json;
    }
    if (v.imprint instanceof Uint8Array) {
      return Array.from(v.imprint)
        .map((b: number) => b.toString(16).padStart(2, '0'))
        .join('');
    }
  }
  return null;
}

// =============================================================================
// 4. Main entry point
// =============================================================================

/**
 * Walk every selected source token's pending-transaction history and
 * finalize each pending tx in topological order (oldest-first). Returns
 * once every source is fully finalized, OR throws
 * `SOURCE_CHAIN_HARD_FAIL` on the FIRST irrecoverable rejection (subsequent
 * sources are NOT touched — preflight is best-effort fail-fast).
 *
 * Idempotent: re-running with the same inputs after a partial success
 * picks up where the previous run left off because every pending tx is
 * first probed via {@link OracleProvider.getProof}.
 *
 * Aborts cleanly: caller-supplied {@link AbortSignal} is checked at the
 * start of every per-tx iteration AND inside the per-attempt sleep. The
 * thrown reason is `signal.reason` (web standard) or
 * `new DOMException('Aborted', 'AbortError')` if the runtime omits it.
 *
 * @example
 * ```ts
 * const result = await preflightFinalize(selectedSources, {
 *   aggregator,
 *   resolveRequestId: async (token, tx) => ({
 *     requestId: await deriveRequestId(token, tx),
 *     transactionHash: tx.transactionHash,
 *     commitment: tx.commitment,
 *   }),
 *   extractPendingChain: (token) => parsePendingTxs(token.sdkData),
 *   emit: (event) => sphere.emit('transfer:preflight-progress', event),
 *   signal: ac.signal,
 * });
 * ```
 */
export async function preflightFinalize(
  selectedSources: ReadonlyArray<Token>,
  options: PreflightFinalizeOptions,
): Promise<PreflightFinalizeResult> {
  const {
    aggregator,
    resolveRequestId,
    extractPendingChain,
    emit,
    persistProof,
    signal,
    transientRetryCount = 3,
    transientRetryDelayMs = 500,
    sleep = defaultSleep,
  } = options;

  if (transientRetryCount < 0 || !Number.isFinite(transientRetryCount)) {
    throw new SphereError(
      `transientRetryCount must be a finite non-negative integer (got ${transientRetryCount})`,
      'INVALID_CONFIG',
    );
  }
  if (transientRetryDelayMs < 0 || !Number.isFinite(transientRetryDelayMs)) {
    throw new SphereError(
      `transientRetryDelayMs must be a finite non-negative number (got ${transientRetryDelayMs})`,
      'INVALID_CONFIG',
    );
  }

  let totalAdvanced = 0;

  for (const token of selectedSources) {
    signal?.throwIfAborted?.();

    // === Materialize the pending chain. ===
    // The extractor may return a sync or async iterable, or a plain
    // array. Normalize to an array to know the chainDepth up front.
    const rawChain = extractPendingChain(token);
    const pendingTxs: unknown[] = [];
    if (Array.isArray(rawChain)) {
      pendingTxs.push(...rawChain);
    } else if (rawChain && typeof (rawChain as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
      for await (const item of rawChain as AsyncIterable<unknown>) {
        pendingTxs.push(item);
      }
    } else if (rawChain && typeof (rawChain as Iterable<unknown>)[Symbol.iterator] === 'function') {
      for (const item of rawChain as Iterable<unknown>) {
        pendingTxs.push(item);
      }
    }
    const chainDepth = pendingTxs.length;
    if (chainDepth === 0) {
      // Acceptance: "For a finalized source token, the function is a no-op."
      continue;
    }

    // === Walk the chain in topological order (oldest first). ===
    for (let i = 0; i < chainDepth; i++) {
      signal?.throwIfAborted?.();
      const currentStep = i + 1;

      // Resolve the descriptor. A throw here = inconsistent local data
      // model = client-error hard-fail (never retried; never silenced).
      let descriptor: PendingTxDescriptor;
      try {
        descriptor = await resolveRequestId(token, pendingTxs[i], i);
      } catch (err) {
        const aggregatorError = safeErrorMessage(err);
        raiseHardFail({
          tokenId: token.id,
          requestId: '',
          reason: 'client-error',
          currentStep,
          chainDepth,
          aggregatorError,
        });
      }

      // === Idempotent probe — does the aggregator already have this proof? ===
      const existing = await probeExistingProof(aggregator, descriptor.requestId);
      let finalProof: InclusionProof;
      if (existing !== null) {
        // Already-anchored — race-lost check still applies.
        const proofTxHash = extractProofTransactionHash(existing);
        if (
          proofTxHash !== null &&
          proofTxHash.toLowerCase() !== descriptor.transactionHash.toLowerCase()
        ) {
          raiseHardFail({
            tokenId: token.id,
            requestId: descriptor.requestId,
            reason: 'race-lost',
            currentStep,
            chainDepth,
            aggregatorError: `proof.transactionHash=${proofTxHash} mismatches local=${descriptor.transactionHash}`,
          });
        }
        finalProof = existing;
      } else {
        // Not anchored — submit + poll with bounded transient retries.
        finalProof = await submitAndAwaitProof({
          aggregator,
          token,
          descriptor,
          currentStep,
          chainDepth,
          transientRetryCount,
          transientRetryDelayMs,
          signal,
          sleep,
        });
      }

      // === Persist + emit. ===
      if (persistProof) {
        await persistProof({ token, descriptor, proof: finalProof });
      }
      emit?.({
        tokenId: token.id,
        chainDepth,
        currentStep,
        requestId: descriptor.requestId,
      });
      totalAdvanced++;
    }
  }

  return { finalizedSources: selectedSources, totalAdvanced };
}
