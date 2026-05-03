/**
 * UXF Transfer — shared finalization-worker driver (Phase 8 refactor).
 *
 * This module owns the §6.1 submit/poll/attach cycle that both the
 * sender ({@link FinalizationWorkerSender}) and recipient
 * ({@link FinalizationWorkerRecipient}) workers run per-requestId. It
 * was extracted from the two ~1500 LOC worker files which had ~95% body
 * duplication of the cycle code. Per the Phase 8 plan, the workers now
 * become thin clients owning only the per-side iteration / state-
 * management glue (sender: outbox iteration + sender-side cascade;
 * recipient: queue iteration + step-9 revaluate + recipient-side
 * cascade).
 *
 * Public surface:
 *
 *  - **Adapter types** — the cycle's external dependencies. Both
 *    workers re-export these so existing test imports keep working.
 *      - {@link AnchoredProofDescriptor}
 *      - {@link FinalizationAggregatorClient}
 *      - {@link PoolReadAdapter}
 *      - {@link PollOutcome}
 *      - {@link RequestContext}
 *      - {@link RequestContextResolver}
 *      - {@link Semaphore}
 *      - {@link SubmitOutcome}
 *
 *  - **`runFinalizationCycle(ctx)`** — the cycle driver. Encapsulates
 *    submit + poll + race-loser detection + §6.3 most-recent-proof /
 *    security-alert + attach via the §5.5 step 5 4-step write order
 *    under the per-tokenId mutex. The caller injects an `attachProof`
 *    closure that performs the manifest-CID-rewrite with the side-
 *    specific `queueEntryRequestId` and queue adapter. The caller also
 *    injects `subjectPhrase` / `subjectEqPhrase` to keep error messages
 *    byte-identical across the two sides.
 *
 *  - **`CountingSemaphore`** — shared counting semaphore used by both
 *    workers and by the aggregator-semaphores registry.
 *
 * **Concurrency caps preserved verbatim** (W14 / W26 etc):
 *   - Per-aggregator + per-token semaphores acquired around the FULL
 *     poll loop (Phase 6 review note — workers MUST NOT release across
 *     sleep).
 *   - W26 cross-restart deadline anchor — the caller passes the
 *     persisted `pollStartedAt`; the cycle does NOT call `now()` to
 *     synthesize one.
 *   - W41 / T.5.F two-strike trustBase staleness — preserved verbatim
 *     including local strike accounting (sibling-worker race protection).
 *
 * Spec references: §5.5 step 1-9, §6.1, §6.1.1, §6.3, §9.4.1.
 *
 * @packageDocumentation
 */

import {
  POLLING_WINDOW_MS,
} from './limits';
import {
  isPollingTimedOut,
  getBackoffMs,
} from './polling-policy';
import {
  performManifestCidRewrite,
  type FinalizationQueueAdapter,
  type ManifestCidRewriteContext,
  type PoolWriteAdapter,
  type TombstoneWriteAdapter,
} from './manifest-cid-rewrite';
import { ManifestCas } from '../../../profile/manifest-cas';
import type { PerTokenMutex } from '../../../profile/per-token-mutex';
import type { ContentHash } from '../../../uxf/types';
import type { DispositionReason } from '../../../types/disposition';
import type {
  SphereEventMap,
  SphereEventType,
} from '../../../types';
import { SphereError } from '../../../core/errors';
import type { TrustBaseStaleness } from './trustbase-staleness';

// =============================================================================
// 1. Aggregator response shapes — narrow, framework-neutral
// =============================================================================

/**
 * Submit-side response classification, per §6.1's
 * `SubmitCommitmentStatus` enum from the underlying state-transition
 * SDK. The worker's caller adapts the SDK's enum (or any other source
 * of truth) to one of these discriminator strings.
 *
 *  - `'SUCCESS'`                           — commitment accepted; will
 *                                            be anchored shortly.
 *  - `'REQUEST_ID_EXISTS'`                 — a commitment for this
 *                                            requestId already exists.
 *                                            Could be (a) our retry
 *                                            (idempotent) OR (b) a
 *                                            race-winner's submit. The
 *                                            ambiguity is resolved at
 *                                            poll-side via tx-hash
 *                                            compare.
 *  - `'AUTHENTICATOR_VERIFICATION_FAILED'` — aggregator's crypto check
 *                                            failed → belief-divergence.
 *  - `'REQUEST_ID_MISMATCH'`               — client sent inconsistent
 *                                            (requestId, sourceState,
 *                                            transactionHash) tuple →
 *                                            client-error (operator
 *                                            alert).
 *  - `'TRANSIENT'`                         — network / 5xx; retry.
 */
export type SubmitOutcomeKind =
  | 'SUCCESS'
  | 'REQUEST_ID_EXISTS'
  | 'AUTHENTICATOR_VERIFICATION_FAILED'
  | 'REQUEST_ID_MISMATCH'
  | 'TRANSIENT';

/**
 * Submit-side response carried back from the injected aggregator
 * adapter. `error` is forensic — surfaced into the outbox `error`
 * field so operators can triage.
 */
export interface SubmitOutcome {
  readonly kind: SubmitOutcomeKind;
  readonly error?: string;
}

/**
 * Poll-side proof verification status, per §6.1's
 * `InclusionProofVerificationStatus` enum. The verifier collapses the
 * SDK enum into this narrow union.
 *
 *  - `'OK'`                — proof is anchored; caller compares
 *                            tx-hash to our local one to resolve
 *                            race-loser ambiguity.
 *  - `'PATH_NOT_INCLUDED'` — proof of NON-existence at this snapshot
 *                            (verifiable). Continue polling.
 *  - `'PATH_INVALID'`      — proof is structurally malformed.
 *  - `'NOT_AUTHENTICATED'` — proof's validator sigs don't verify
 *                            against local trustBase (likely stale).
 *  - `'TRANSIENT'`         — network / 5xx; retry.
 */
export type PollOutcomeKind =
  | 'OK'
  | 'PATH_NOT_INCLUDED'
  | 'PATH_INVALID'
  | 'NOT_AUTHENTICATED'
  | 'TRANSIENT';

/**
 * Anchored-proof descriptor returned by a successful poll. The narrow
 * shape is chosen so the worker can reason about §6.1 race-detection
 * (transactionHash compare) and §6.3 most-recent-proof / security-alert
 * (transactionHash + authenticator compare) without coupling to the
 * SDK's `InclusionProof` class.
 *
 * The `proof` field is opaque — the worker passes it through to the
 * 4-step write orchestrator which forwards it to the pool adapter. No
 * part of the worker introspects it.
 */
export interface AnchoredProofDescriptor {
  /**
   * SDK-encoded transactionHash imprint hex (matches what the
   * `OracleProvider.verifyInclusionProof` adapter accepts and what
   * `inclusion-proof.content.transactionHash` carries in the UXF
   * pool). 68 hex chars (2-byte algorithm prefix + 32-byte digest).
   */
  readonly transactionHash: string;
  /** Authenticator hex — used for §6.3 same-value-vs-different-value
   *  resolution alongside transactionHash. */
  readonly authenticator: string;
  /** BFT round number / equivalent recency signal. Higher = more
   *  recent. Optional: when absent, the worker falls back to first-
   *  observed timestamp ordering. Per §6.3. */
  readonly roundNumber?: number;
  /** Opaque proof descriptor forwarded to the pool adapter. */
  readonly proof: unknown;
}

/**
 * Result of a poll attempt. Discriminated on `kind`. `OK` carries the
 * anchored proof descriptor + the proof's CID as it would land in the
 * pool — the worker uses this to compute the manifest's new rootHash.
 *
 * The worker treats only `kind ∈ {OK, PATH_NOT_INCLUDED, PATH_INVALID,
 * NOT_AUTHENTICATED}` as advancing the §5.5 step 6 attempt counter;
 * `TRANSIENT` does NOT advance it (per the spec).
 */
export type PollOutcome =
  | {
      readonly kind: 'OK';
      readonly proof: AnchoredProofDescriptor;
      /**
       * The new content hash the token will resolve to once `proof`
       * is attached. Caller computes this upstream — it is the §5.5
       * step 5 "manifest CID rewrite" target.
       */
      readonly newCid: ContentHash;
    }
  | {
      readonly kind:
        | 'PATH_NOT_INCLUDED'
        | 'PATH_INVALID'
        | 'NOT_AUTHENTICATED'
        | 'TRANSIENT';
      readonly error?: string;
    };

// =============================================================================
// 2. Injected adapters — keep the worker decoupled from the SDK
// =============================================================================

/**
 * Resolves a queue entry's `signedTx` for re-verification + submit.
 *
 * Per §6.1 (and §5.5 step 1) the worker first attempts to read the
 * signed-tx bytes from the outbox entry's queue-entry storage; failing
 * that, it falls back to looking up the in-pool token by
 * `(tokenId, txIndex)`. Production wires this to the per-address
 * pool / queue stores; tests inject inline recorders.
 */
export interface RequestContextResolver {
  /**
   * Look up the local context for one outstanding requestId.
   *
   * Returns `null` if the worker should treat the requestId as
   * unresolvable — the worker hard-fails the outbox entry with
   * reason='structural' (no signedTx → no submit possible).
   */
  resolve(input: {
    readonly addressId: string;
    readonly outboxId: string;
    readonly tokenId: string;
    readonly requestId: string;
  }): Promise<RequestContext | null>;
}

/**
 * Per-requestId context the worker needs to (a) re-verify, (b) submit,
 * (c) compare transactionHash on poll, and (d) compute the manifest
 * CID rewrite target.
 */
export interface RequestContext {
  /** Local transactionHash imprint (68-char hex). The poll-side
   *  race-loser detection compares this against the proof's. */
  readonly transactionHash: string;
  /** Local authenticator (hex). Used for §6.3 same-value vs
   *  different-value resolution. */
  readonly authenticator: string;
  /**
   * Pre-existing manifest content hash for this token (the proof-less
   * version). Becomes the §5.5 step 5 CAS precondition AND the
   * tombstone subject. May be `undefined` for the genesis case (no
   * prior manifest entry).
   */
  readonly previousCid?: ContentHash;
  /**
   * Tombstone-aware CAS-extras that the worker carries forward into
   * the new manifest entry on attach. The 4-step write orchestrator
   * combines `newCid` with this object to form the next entry.
   */
  readonly nextEntryRest: Pick<
    NonNullable<ManifestCidRewriteContext['nextEntryRest']>,
    'status' | 'conflictingHeads' | 'invalidReason'
  >;
}

/**
 * Aggregator surface the worker calls into. The narrow shape lets us
 * test the worker without instantiating `UnicityAggregatorProvider`.
 *
 * The `aggregatorId` parameter is the per-aggregator semaphore key —
 * different aggregator endpoints share the budget under the same key
 * only if explicitly configured. Defaults to `'default'`.
 */
export interface FinalizationAggregatorClient {
  /**
   * Submit the commitment for `requestId`. Returns one of the canonical
   * `SubmitOutcomeKind` discriminators per §6.1's submit-side table.
   *
   * The worker honors `signal.aborted` between submit and poll; throws
   * are caught and treated as `TRANSIENT`.
   */
  submit(input: {
    readonly addressId: string;
    readonly tokenId: string;
    readonly requestId: string;
    readonly aggregatorId?: string;
    readonly signal?: AbortSignal;
  }): Promise<SubmitOutcome>;

  /**
   * Poll the aggregator for an inclusion proof. Returns one of the
   * canonical `PollOutcomeKind` discriminators per §6.1's poll-side
   * table; on `'OK'` carries the anchored proof descriptor.
   */
  poll(input: {
    readonly addressId: string;
    readonly tokenId: string;
    readonly requestId: string;
    readonly aggregatorId?: string;
    readonly signal?: AbortSignal;
  }): Promise<PollOutcome>;
}

/**
 * Concurrency-cap primitive the worker uses for both per-aggregator
 * (W14, default 16) and per-token (default 4) caps. The caller injects
 * a real semaphore (live wallet) or a counting fake (tests).
 */
export interface Semaphore {
  /** Acquire a permit; returns a release function. */
  acquire(): Promise<() => void>;
  /** Defensively expose current available permits. Optional;
   *  test-only fakes use this for assertions. */
  readonly available?: number;
}

/**
 * Pool adapter extension — over the §5.5 step 5 base contract — that
 * exposes (a) the currently-attached proof descriptor for a requestId
 * and (b) a same-value vs different-value comparator. Used by the
 * §6.3 most-recent-proof / security-alert paths (W16, C10).
 *
 * The base {@link PoolWriteAdapter} contract is `attachProof` /
 * `isProofAttached`; this extension adds `getAttachedProof` so the
 * worker can detect "fresher proof for already-attached requestId"
 * without re-decoding pool elements.
 */
export interface PoolReadAdapter {
  /**
   * Retrieve the currently-attached anchored proof descriptor for
   * `(tokenId, requestId)`, if any. Returns `null` if no proof is
   * attached at this requestId.
   *
   * Implementations MAY back this with the same store as
   * {@link PoolWriteAdapter}; the read surface is split out so tests
   * can mock attachment + retrieval independently.
   */
  getAttachedProof(
    tokenId: string,
    requestId: string,
  ): Promise<AnchoredProofDescriptor | null>;
}

// =============================================================================
// 3. Internal helpers (shared cycle helpers)
// =============================================================================

/**
 * `transactionHash` and `authenticator` equality are byte-exact; we
 * lower-case both sides defensively in case the producer used a
 * different case-mode. (Hex is canonically lowercase but the spec is
 * not normative on that point — defensive equality avoids spurious
 * security-alerts on case-mismatch.)
 *
 * @internal
 */
export function sameProofValue(
  a: { readonly transactionHash: string; readonly authenticator: string },
  b: { readonly transactionHash: string; readonly authenticator: string },
): boolean {
  return (
    a.transactionHash.toLowerCase() === b.transactionHash.toLowerCase() &&
    a.authenticator.toLowerCase() === b.authenticator.toLowerCase()
  );
}

/**
 * `transactionHash` equality only (byte-exact, lowercase). Used by
 * the §6.1 race-loser detection. Authenticator differences do NOT
 * imply race-lost — only different transactionHash matters at the
 * race step.
 *
 * @internal
 */
export function sameTransactionHash(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// =============================================================================
// 4. Hard-fail outcome shape (shared by sender + recipient internals)
// =============================================================================

/**
 * Per-cycle hard-fail outcome carrying the disposition reason and a
 * flag for the cascade walker (T.5.B.5). `'race-lost'` skips the
 * cascade per §6.1.1; every other terminal reason fires it.
 */
export interface HardFailOutcome {
  readonly kind: 'hard-fail';
  readonly reason: DispositionReason;
  /** Per §6.1.1 race-lost special case — TRUE when the cascade walker
   *  should NOT be triggered. */
  readonly skipCascade: boolean;
  /** Forensic message persisted on the outbox entry's `error` field
   *  (sender) or the disposition record (recipient). */
  readonly message: string;
}

/** Per-cycle success outcome — proof attached, manifest CID rewritten. */
export interface SuccessOutcome {
  readonly kind: 'success';
  readonly newCid: ContentHash;
}

/** Result of one full finalization cycle. */
export type CycleResult = HardFailOutcome | SuccessOutcome;

// =============================================================================
// 5. FinalizationCycleContext — driver inputs
// =============================================================================

/**
 * Input bundle for {@link runFinalizationCycle}. The driver is purely
 * functional — every dependency is injected. Both the sender and the
 * recipient build one of these per cycle (per requestId / queue
 * entry).
 *
 * **Why pre-formatted `subjectPhrase` / `subjectEqPhrase`?** The two
 * workers historically formatted error messages slightly differently:
 * sender used `requestId X` / `requestId=X` while recipient used
 * `queue entry Y` (no `=` form). To avoid regressing test-string
 * assertions, the caller pre-formats both phrases and the driver only
 * concatenates.
 */
export interface FinalizationCycleContext {
  // ---------------------------------------------------------------------------
  // Identity / addressing
  // ---------------------------------------------------------------------------
  readonly addressId: string;
  readonly tokenId: string;
  readonly requestId: string;
  /**
   * Sender outbox id / recipient queue entry id. Surfaced into emitted
   * events when present (sender supplies; recipient omits).
   */
  readonly outboxId?: string;
  /** Bundle CID — used in `transfer:trustbase-warning` payloads. */
  readonly bundleCid?: string;
  /**
   * Pre-formatted `${noun} ${value}` phrase (e.g. `"requestId req-1"`
   * for sender or `"queue entry q1"` for recipient). The driver
   * composes message strings as `"...for ${subjectPhrase}"`.
   */
  readonly subjectPhrase: string;
  /**
   * Pre-formatted `${noun}${separator}${value}` phrase used in
   * `PATH_INVALID` / `NOT_AUTHENTICATED` retry-failure messages.
   * Sender: `"requestId=req-1"`. Recipient: `"queue entry q1"` (no
   * separator change — recipient always uses spaces).
   */
  readonly subjectEqPhrase: string;
  /**
   * Pre-formatted `STRUCTURAL_INVALID` message used when the resolver
   * returns `null`. Sender: `"...for requestId X (outbox=Y)"`.
   * Recipient: `"...for queue entry X (tokenId=Y)"`.
   */
  readonly structuralInvalidMessage: string;

  // ---------------------------------------------------------------------------
  // Adapters
  // ---------------------------------------------------------------------------
  readonly resolver: RequestContextResolver;
  readonly aggregator: FinalizationAggregatorClient;
  readonly poolRead: PoolReadAdapter;

  // ---------------------------------------------------------------------------
  // Concurrency primitives
  // ---------------------------------------------------------------------------
  readonly perAggregatorSemaphore: Semaphore;
  readonly perTokenSemaphore: Semaphore;

  // ---------------------------------------------------------------------------
  // Deadline anchor (W26 cross-restart fix)
  // ---------------------------------------------------------------------------
  /**
   * Persisted poll-loop deadline anchor. Sender stamps this on the
   * outbox entry's first poll-loop entry; recipient reads from the
   * queue entry's `submittedAt`. Either way the value MUST survive
   * crash/restart so the §5.5 step 6 hard safety net is a SURVIVING
   * wall-clock deadline, not a fresh-from-`now()` one.
   */
  readonly pollStartedAt: number;

  // ---------------------------------------------------------------------------
  // Event + clock + abort
  // ---------------------------------------------------------------------------
  readonly emit: <T extends SphereEventType>(
    type: T,
    data: SphereEventMap[T],
  ) => void;
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
  /**
   * The owning worker's `stopRequested` flag, exposed as a callback so
   * the driver respects cooperative shutdown the same way the worker's
   * scan loop does.
   */
  readonly isStopped: () => boolean;

  // ---------------------------------------------------------------------------
  // Limits
  // ---------------------------------------------------------------------------
  readonly maxSubmitRetries: number;
  readonly maxProofErrorRetries: number;

  // ---------------------------------------------------------------------------
  // Aggregator + trustBase
  // ---------------------------------------------------------------------------
  readonly aggregatorId: string;
  readonly trustBaseStaleness?: TrustBaseStaleness;

  // ---------------------------------------------------------------------------
  // Side-specific attach hook
  // ---------------------------------------------------------------------------
  /**
   * Side-specific proof-attach closure. The sender passes the
   * `requestId` itself as `queueEntryRequestId` and uses the outbox-
   * provided queue adapter; the recipient passes the queue entry's id
   * and uses the recipient queue's adapter. The closure is wrapped by
   * the caller in the per-tokenId mutex.
   *
   * The driver invokes this AFTER the §6.3 conflict check and BEFORE
   * emitting `transfer:proof-superseded`. The `superseded` flag tells
   * the closure whether the §5.5 step 5 step 3 tombstone path applies.
   */
  readonly attachProof: (args: {
    readonly proof: AnchoredProofDescriptor;
    readonly newCid: ContentHash;
    readonly previousCid?: ContentHash;
    readonly nextEntryRest: RequestContext['nextEntryRest'];
    readonly superseded: boolean;
  }) => Promise<void>;
}

// =============================================================================
// 6. Cycle driver
// =============================================================================

/**
 * Run one finalization cycle for a single requestId / queue entry.
 *
 * Steps (mirroring §6.1 verbatim):
 *  1. Resolve `signedTx` + context via {@link RequestContextResolver}.
 *     Null → hard-fail `'structural'`.
 *  2. Submit phase — bounded by `maxSubmitRetries` on `TRANSIENT`.
 *     Maps each {@link SubmitOutcomeKind} per §6.1 table.
 *  3. Poll phase — bounded by polling-window + `2x` safety net (W26).
 *     Per-aggregator + per-token semaphores held for the FULL poll
 *     loop. `TRANSIENT` does NOT advance attempt counter.
 *     - `OK + matching txHash` → §6.3 conflict check, then `attachProof`,
 *       then return success.
 *     - `OK + mismatching txHash` → race-lost (skip cascade per §6.1.1).
 *     - `PATH_INVALID` after `maxProofErrorRetries` → proof-invalid.
 *     - `NOT_AUTHENTICATED` → trustbase-warning + (T.5.F two-strike if
 *       wired, else budgeted retry).
 *     - timeout → oracle-rejected.
 *
 * Returns a typed {@link CycleResult}; the caller persists the side-
 * specific terminal state.
 */
export async function runFinalizationCycle(
  ctx: FinalizationCycleContext,
): Promise<CycleResult> {
  const ctxResolved = await ctx.resolver.resolve({
    addressId: ctx.addressId,
    outboxId: ctx.outboxId ?? '',
    tokenId: ctx.tokenId,
    requestId: ctx.requestId,
  });
  if (ctxResolved === null) {
    return {
      kind: 'hard-fail',
      reason: 'structural',
      skipCascade: false,
      message: ctx.structuralInvalidMessage,
    };
  }

  const submitResult = await runSubmitPhase(ctx);
  if (submitResult.kind === 'hard-fail') return submitResult;

  return await runPollPhase(ctx, ctxResolved);
}

// =============================================================================
// 7. Submit phase
// =============================================================================

/**
 * §6.1 submit table. Returns either `{kind:'submitted'}` to indicate
 * "proceed to poll" or a hard-fail outcome.
 *
 * @internal
 */
export async function runSubmitPhase(
  ctx: FinalizationCycleContext,
): Promise<{ kind: 'submitted' } | HardFailOutcome> {
  let attempts = 0;
  let lastError: string | undefined;
  while (attempts <= ctx.maxSubmitRetries) {
    if (ctx.signal?.aborted === true || ctx.isStopped()) {
      return {
        kind: 'hard-fail',
        reason: 'structural',
        skipCascade: false,
        message: `worker aborted before submit for ${ctx.subjectPhrase}`,
      };
    }
    let outcome: SubmitOutcome;
    try {
      outcome = await ctx.aggregator.submit({
        addressId: ctx.addressId,
        tokenId: ctx.tokenId,
        requestId: ctx.requestId,
        aggregatorId: ctx.aggregatorId,
        signal: ctx.signal,
      });
    } catch (err) {
      outcome = {
        kind: 'TRANSIENT',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (outcome.kind === 'SUCCESS' || outcome.kind === 'REQUEST_ID_EXISTS') {
      // SUCCESS / EXISTS both proceed to poll. EXISTS could be our
      // retry OR a race-winner's submit — disambiguated at poll-side.
      return { kind: 'submitted' };
    }
    if (outcome.kind === 'AUTHENTICATOR_VERIFICATION_FAILED') {
      return {
        kind: 'hard-fail',
        reason: 'belief-divergence',
        skipCascade: false,
        message: `belief-divergence: aggregator rejected authenticator for ${ctx.subjectPhrase}${outcome.error ? ` (${outcome.error})` : ''}`,
      };
    }
    if (outcome.kind === 'REQUEST_ID_MISMATCH') {
      // C12 / C13 — CLIENT BUG. Hard-fail with reason='client-error'.
      // Operator alert via `transfer:operator-alert`. NO cascade per
      // §6.1.1 (client-error is not in the §6.1.1 cascade set).
      ctx.emit('transfer:operator-alert', {
        code: 'client-error',
        tokenId: ctx.tokenId,
        message: `REQUEST_ID_MISMATCH on submit: client computed an inconsistent (requestId, sourceState, transactionHash) tuple for ${ctx.subjectPhrase}${outcome.error ? ` (${outcome.error})` : ''}`,
      });
      return {
        kind: 'hard-fail',
        reason: 'client-error',
        skipCascade: true,
        message: `client-error: REQUEST_ID_MISMATCH on submit for ${ctx.subjectPhrase}${outcome.error ? ` (${outcome.error})` : ''}`,
      };
    }
    // TRANSIENT
    lastError = outcome.error;
    attempts++;
    if (attempts > ctx.maxSubmitRetries) break;
    // Reuse the polling-policy's backoff schedule for submit retries —
    // matches §6.1's "back off; retry. Bounded by MAX_SUBMIT_RETRIES"
    // wording.
    await ctx.sleep(getBackoffMs(attempts - 1), ctx.signal);
  }
  return {
    kind: 'hard-fail',
    reason: 'oracle-rejected',
    skipCascade: false,
    message: `submit transient retries exhausted (max=${ctx.maxSubmitRetries}) for ${ctx.subjectPhrase}${lastError ? ` last error: ${lastError}` : ''}`,
  };
}

// =============================================================================
// 8. Poll phase
// =============================================================================

/**
 * §6.1 poll table. Backoff + window per shared polling-policy.
 *
 * On `OK + transactionHash matches`: invokes the §5.5 step 5 attach
 * sequence under the per-tokenId mutex (via the caller-supplied
 * `attachProof` closure).
 *
 * On `OK + transactionHash mismatches`: race-lost (§6.1 step 4 /
 * §6.1.1 race-lost EXCEPTION) — hard-fail with skipCascade=true.
 *
 * @internal
 */
export async function runPollPhase(
  ctx: FinalizationCycleContext,
  ctxResolved: RequestContext,
): Promise<CycleResult> {
  const startedAt = ctx.pollStartedAt;
  let attempts = 0;
  let proofErrorRetries = 0;
  // T.5.F two-strike accounting — counts NOT_AUTHENTICATED
  // observations made in THIS poll loop. The first strike triggers a
  // (debounced) refresh and a retry. The second strike escalates to
  // security-alert. Local accounting protects against races where a
  // sibling worker's refresh bumps the global tag before THIS worker
  // has had a chance to retry with the refreshed trustBase.
  let localNotAuthStrikes = 0;
  let localRefreshAppliedSinceFirstStrike = false;

  // Acquire per-aggregator + per-token permits for the full poll loop
  // for this requestId. Production wiring uses these as DoS-defense
  // budgets; keeping them for the full poll loop matches the spec's
  // "MAX_CONCURRENT_POLLS_PER_TOKEN" framing (concurrent requestIds
  // of the SAME token).
  const releaseAgg = await ctx.perAggregatorSemaphore.acquire();
  let releaseTok: (() => void) | null = null;
  try {
    releaseTok = await ctx.perTokenSemaphore.acquire();

    for (;;) {
      if (ctx.signal?.aborted === true || ctx.isStopped()) {
        return {
          kind: 'hard-fail',
          reason: 'structural',
          skipCascade: false,
          message: `worker aborted while polling ${ctx.subjectPhrase}`,
        };
      }

      const timeout = isPollingTimedOut(startedAt, ctx.now(), attempts);
      if (timeout.timedOut) {
        return {
          kind: 'hard-fail',
          reason: 'oracle-rejected',
          skipCascade: false,
          message: `oracle-rejected (${timeout.reason}): ${ctx.subjectPhrase} not anchored within ${timeout.reason === 'safety-net-fired' ? '2× ' : ''}polling window (attempts=${attempts})`,
        };
      }

      // Backoff BEFORE poll — the schedule starts with 30s, so the
      // first poll is delayed by `getBackoffMs(0)`. The deterministic
      // sleep primitive is a no-op in tests with a fake clock.
      await ctx.sleep(getBackoffMs(attempts), ctx.signal);

      let pollOutcome: PollOutcome;
      try {
        pollOutcome = await ctx.aggregator.poll({
          addressId: ctx.addressId,
          tokenId: ctx.tokenId,
          requestId: ctx.requestId,
          aggregatorId: ctx.aggregatorId,
          signal: ctx.signal,
        });
      } catch (err) {
        // Treat as TRANSIENT — does NOT advance attempt counter.
        // Loop continues; safety net + max-iter caps eventually
        // converge.
        const message = err instanceof Error ? err.message : String(err);
        pollOutcome = {
          kind: 'TRANSIENT',
          error: `poll threw: ${message}`,
        };
      }

      if (pollOutcome.kind === 'TRANSIENT') {
        // Spec rule: TRANSIENT does not count toward MIN_POLL_ATTEMPTS.
        continue;
      }

      // Verifiable proof-status — advances attempts.
      attempts++;

      if (pollOutcome.kind === 'OK') {
        // §6.1 race-loser detection.
        if (
          !sameTransactionHash(
            pollOutcome.proof.transactionHash,
            ctxResolved.transactionHash,
          )
        ) {
          return {
            kind: 'hard-fail',
            reason: 'race-lost',
            skipCascade: true,
            message: `OUTBOX_RACE_LOST: ${ctx.subjectPhrase} anchored with mismatching transactionHash (local=${ctxResolved.transactionHash} aggregator=${pollOutcome.proof.transactionHash})`,
          };
        }

        // §6.3 most-recent-proof / security-alert.
        const securityAlert = await checkProofConflict(ctx, ctxResolved, pollOutcome.proof);
        if (securityAlert.kind === 'security-alert') {
          return {
            kind: 'hard-fail',
            reason: 'belief-divergence',
            skipCascade: false,
            message: securityAlert.message,
          };
        }

        // SUCCESS — attach proof via the §5.5 step 5 4-step write
        // order (under the per-tokenId mutex; the closure handles the
        // mutex acquisition).
        await ctx.attachProof({
          proof: pollOutcome.proof,
          newCid: pollOutcome.newCid,
          previousCid: ctxResolved.previousCid,
          nextEntryRest: ctxResolved.nextEntryRest,
          superseded: securityAlert.kind === 'superseded',
        });

        if (securityAlert.kind === 'superseded') {
          // The §6.3 superseded path: the manifest CID rewrite
          // already tombstoned the prior CID via step 3 of the
          // 4-step write order. Emit `transfer:proof-superseded`
          // with the prior CID (= ctxResolved.previousCid, which is
          // the manifest's pre-rewrite root for this requestId
          // under the resolver's current view).
          ctx.emit('transfer:proof-superseded', {
            tokenId: ctx.tokenId,
            requestId: ctx.requestId,
            ...(ctx.outboxId !== undefined ? { outboxId: ctx.outboxId } : {}),
            previousCid: ctxResolved.previousCid ?? '',
            newCid: pollOutcome.newCid,
          });
        }

        // T.5.F: an authenticated proof landed — reset the staleness
        // counter so the next first-strike refreshes again.
        if (ctx.trustBaseStaleness !== undefined) {
          ctx.trustBaseStaleness.recordAuthenticatedOk(ctx.aggregatorId);
        }
        return { kind: 'success', newCid: pollOutcome.newCid };
      }

      if (pollOutcome.kind === 'PATH_NOT_INCLUDED') {
        // Continue polling within window.
        continue;
      }

      if (pollOutcome.kind === 'PATH_INVALID') {
        proofErrorRetries++;
        if (proofErrorRetries >= ctx.maxProofErrorRetries) {
          return {
            kind: 'hard-fail',
            reason: 'proof-invalid',
            skipCascade: false,
            message: `PATH_INVALID after ${proofErrorRetries} retries: ${ctx.subjectEqPhrase}${pollOutcome.error ? ` (${pollOutcome.error})` : ''}`,
          };
        }
        continue;
      }

      if (pollOutcome.kind === 'NOT_AUTHENTICATED') {
        // Emit trustbase-warning on every observation. Operators see
        // the trail in the order it happens; T.5.F's escalation logic
        // runs AFTER the warning so the security-alert always
        // carries a corresponding warning.
        ctx.emit('transfer:trustbase-warning', {
          tokenId: ctx.tokenId,
          requestId: ctx.requestId,
          ...(ctx.outboxId !== undefined ? { outboxId: ctx.outboxId } : {}),
          ...(ctx.bundleCid !== undefined ? { bundleCid: ctx.bundleCid } : {}),
          attempt: attempts,
          message:
            pollOutcome.error ??
            'NOT_AUTHENTICATED — proof verifier rejected validator signatures (likely stale local trustBase per §9.4.1)',
        });

        // T.5.F: two-strike escalation when the staleness ledger is
        // wired. First strike → emit warning, refresh, retry. Second
        // strike (only if a refresh has been applied since strike 1)
        // → emit security-alert + hard-fail.
        if (ctx.trustBaseStaleness !== undefined) {
          localNotAuthStrikes++;
          // Inform the ledger so its `isTrustBaseStale` /
          // `lastNotAuthenticatedAt` diagnostics stay accurate
          // (operators may query it independently).
          ctx.trustBaseStaleness.recordNotAuthenticated(ctx.aggregatorId);

          if (
            localNotAuthStrikes >= 2 &&
            localRefreshAppliedSinceFirstStrike
          ) {
            const message = `NOT_AUTHENTICATED persisted after trustBase refresh (strike ${localNotAuthStrikes}): ${ctx.subjectEqPhrase} — escalating to security-alert per §9.4.1`;
            ctx.emit('transfer:security-alert', {
              tokenId: ctx.tokenId,
              requestId: ctx.requestId,
              ...(ctx.outboxId !== undefined ? { outboxId: ctx.outboxId } : {}),
              attachedTransactionHash: '',
              observedTransactionHash: ctxResolved.transactionHash,
              attachedAuthenticator: '',
              observedAuthenticator: ctxResolved.authenticator,
              message,
            });
            return {
              kind: 'hard-fail',
              reason: 'proof-invalid',
              skipCascade: false,
              message,
            };
          }

          // First strike (or retry after a failed refresh) — kick
          // the refresh (debounced per aggregator) and retry. The
          // refresh is awaited so the next poll uses the new
          // trustBase. A failed refresh outcome is treated as
          // transient: do NOT mark "applied since strike 1"; the
          // next strike will trigger another refresh attempt.
          const refresh = await ctx.trustBaseStaleness.refreshTrustBase(
            ctx.aggregatorId,
            ctx.signal,
          );
          if (
            refresh.kind === 'applied' ||
            refresh.kind === 'no-change'
          ) {
            localRefreshAppliedSinceFirstStrike = true;
          }
          // Do NOT advance proofErrorRetries on the staleness path.
          // The polling-window safety net + signal abort keep the
          // loop bounded.
          continue;
        }

        // No staleness ledger wired — preserve the original budgeted
        // retry behavior.
        proofErrorRetries++;
        if (proofErrorRetries >= ctx.maxProofErrorRetries) {
          return {
            kind: 'hard-fail',
            reason: 'proof-invalid',
            skipCascade: false,
            message: `NOT_AUTHENTICATED after ${proofErrorRetries} retries: ${ctx.subjectEqPhrase} (likely stale trustBase per §9.4.1)`,
          };
        }
        continue;
      }
    }
  } finally {
    if (releaseTok !== null) releaseTok();
    releaseAgg();
  }
}

// =============================================================================
// 9. §6.3 most-recent-proof / security-alert
// =============================================================================

/**
 * Resolve the §6.3 fresh / superseded / attached-newer / security-
 * alert decision when a poll returns `OK`.
 *
 * Returns:
 *  - `'fresh'`         — no prior proof attached at this requestId; the
 *                         worker proceeds straight to attach.
 *  - `'superseded'`    — a prior proof IS attached, with the SAME
 *                         `(transactionHash, authenticator)` and an
 *                         OLDER round number. The worker replaces +
 *                         tombstones the previous CID per §6.3.
 *  - `'attached-newer'` — a prior proof IS attached and is at least
 *                         as new as this one. The worker treats this
 *                         as a no-op replacement (idempotent).
 *  - `'security-alert'` — a prior proof IS attached, with a DIFFERENT
 *                         `(transactionHash, authenticator)` — the
 *                         §6.3 forbidden case. Worker emits
 *                         `transfer:security-alert` and refuses to
 *                         merge.
 *
 * @internal
 */
export async function checkProofConflict(
  ctx: FinalizationCycleContext,
  ctxResolved: RequestContext,
  anchored: AnchoredProofDescriptor,
): Promise<
  | { kind: 'fresh' }
  | { kind: 'superseded' }
  | { kind: 'attached-newer' }
  | { kind: 'security-alert'; message: string }
> {
  let attached: AnchoredProofDescriptor | null;
  try {
    attached = await ctx.poolRead.getAttachedProof(ctx.tokenId, ctx.requestId);
  } catch {
    // Treat read failure as fresh — the attach orchestrator's
    // step 1 idempotency is the safety net.
    return { kind: 'fresh' };
  }
  if (attached === null) return { kind: 'fresh' };

  if (!sameProofValue(attached, anchored)) {
    // §6.3 forbidden — emit security-alert and refuse merge.
    const message = `transfer:security-alert: two proofs for the same requestId disagree on (transactionHash, authenticator) — single-spend invariant violated at aggregator. tokenId=${ctx.tokenId} requestId=${ctx.requestId}`;
    ctx.emit('transfer:security-alert', {
      tokenId: ctx.tokenId,
      requestId: ctx.requestId,
      ...(ctx.outboxId !== undefined ? { outboxId: ctx.outboxId } : {}),
      attachedTransactionHash: attached.transactionHash,
      observedTransactionHash: anchored.transactionHash,
      attachedAuthenticator: attached.authenticator,
      observedAuthenticator: anchored.authenticator,
      message,
    });
    void ctxResolved; // ctxResolved unused here; kept for symmetry / future use
    return { kind: 'security-alert', message };
  }

  // Same-value — choose the more recent.
  const attachedRound = attached.roundNumber ?? 0;
  const anchoredRound = anchored.roundNumber ?? 0;
  if (anchoredRound > attachedRound) return { kind: 'superseded' };
  return { kind: 'attached-newer' };
}

// =============================================================================
// 10. Attach helper — wraps performManifestCidRewrite in the per-token mutex
// =============================================================================

/**
 * Side-agnostic helper that wraps {@link performManifestCidRewrite}
 * with the §5.5 step 9 per-tokenId mutex. The caller supplies the
 * side-specific `queueEntryRequestId` (sender: the requestId; recipient:
 * the queue entry id) and the appropriate queue adapter.
 *
 * Both workers compose this into their `attachProof` closure passed
 * into {@link runFinalizationCycle}. Kept in the base module so the
 * mutex acquisition + manifest-CID-rewrite call shape is identical
 * across the two sides.
 */
export async function attachProofUnderMutex(args: {
  readonly addressId: string;
  readonly tokenId: string;
  readonly requestId: string;
  readonly proof: AnchoredProofDescriptor;
  readonly newCid: ContentHash;
  readonly previousCid?: ContentHash;
  readonly nextEntryRest: RequestContext['nextEntryRest'];
  readonly queueEntryRequestId: string;
  readonly pool: PoolWriteAdapter;
  readonly manifestCas: ManifestCas;
  readonly tombstones: TombstoneWriteAdapter;
  readonly queue: FinalizationQueueAdapter;
  readonly perTokenMutex: PerTokenMutex;
  readonly perTokenMutexStrategy: 'cas' | 'rpc-release' | 'bounded-hold';
  readonly now: () => number;
}): Promise<void> {
  await args.perTokenMutex.acquire(
    args.tokenId,
    async () => {
      const ctx: ManifestCidRewriteContext = {
        addr: args.addressId,
        tokenId: args.tokenId,
        proofToAttach: {
          requestId: args.requestId,
          roundNumber: args.proof.roundNumber ?? 0,
          proof: args.proof.proof,
          timestamp: args.now(),
        },
        newCid: args.newCid,
        previousCid: args.previousCid,
        nextEntryRest: args.nextEntryRest,
        queueEntryRequestId: args.queueEntryRequestId,
        pool: args.pool,
        manifestCas: args.manifestCas,
        tombstones: args.tombstones,
        queue: args.queue,
      };
      await performManifestCidRewrite(ctx);
    },
    { strategy: args.perTokenMutexStrategy },
  );
}

// =============================================================================
// 11. CountingSemaphore — shared default Semaphore implementation
// =============================================================================

/**
 * Simple in-memory counting semaphore conforming to the
 * {@link Semaphore} contract. Useful as a default for both production
 * (single-process) and tests.
 *
 * Permits are acquired in FIFO order. Released permits are immediately
 * available to the next waiter.
 */
export class CountingSemaphore implements Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(maxConcurrent: number) {
    if (!Number.isFinite(maxConcurrent) || maxConcurrent <= 0) {
      throw new SphereError(
        `CountingSemaphore: maxConcurrent must be > 0; got ${maxConcurrent}`,
        'VALIDATION_ERROR',
      );
    }
    this.permits = maxConcurrent;
  }

  get available(): number {
    return this.permits;
  }

  async acquire(): Promise<() => void> {
    // Steelman finding #158: the release closure MUST be idempotent.
    // Worker error paths frequently call `release()` from a finally
    // block AND from an inline-cleanup branch — without a `released`
    // guard, a double-release silently inflates `permits` past
    // `maxConcurrent` and the W14/W26 process-global cap is meaningless
    // after a few error iterations. Wrapping with a one-shot flag
    // makes accidental double-release a no-op.
    if (this.permits > 0) {
      this.permits--;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.release();
      };
    }
    // Wait for a permit.
    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        this.permits--;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.release();
        });
      });
    });
  }

  private release(): void {
    this.permits++;
    const next = this.waiters.shift();
    if (next !== undefined) {
      // Re-enter immediately; permit is consumed by `next` synchronously.
      next();
    }
  }
}

// Re-export POLLING_WINDOW_MS so consumers reading this header don't need
// a separate import for the same constant the cycle driver enforces.
export { POLLING_WINDOW_MS };
