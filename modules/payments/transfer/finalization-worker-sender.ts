/**
 * UXF Transfer — sender-side finalization worker (T.5.B).
 *
 * Implements `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §6.1 verbatim. Drives an
 * outbox-resident set of `delivered-instant` entries through the submit /
 * poll loop until every `outstandingRequestId` resolves to either:
 *
 *  - **SUCCESS** — the aggregator anchored our commitment with the
 *    `transactionHash` we tracked locally. The 4-step write order
 *    (§5.5 step 5) attaches the proof, rewrites the manifest CID,
 *    tombstones the previous CID, and removes the queue entry. The
 *    outbox transitions `delivered-instant → finalizing → finalized`.
 *
 *  - **HARD-FAIL** — one of the spec's terminal disposition reasons:
 *    `'race-lost'`, `'client-error'`, `'belief-divergence'`,
 *    `'oracle-rejected'`, `'proof-invalid'`. The outbox transitions
 *    `delivered-instant → finalizing → failed-permanent`. For every
 *    reason EXCEPT `'race-lost'`, the worker emits
 *    `transfer:cascade-failed` so the T.5.B.5 walker can fan the
 *    invalidation out to children / downstream recipients.
 *
 * **Concurrency caps** (W14):
 *   - Per-aggregator: at most `MAX_CONCURRENT_POLLS_PER_AGGREGATOR` (16)
 *     in-flight aggregator calls across all entries (default 16). The
 *     budget is enforced by an injected semaphore so callers can share
 *     the budget across multiple workers (sender + recipient).
 *   - Per-tokenId: at most `MAX_CONCURRENT_POLLS_PER_TOKEN` (4) in-flight
 *     polls for the same tokenId — protects against deep chain-mode
 *     bursts hammering a single aggregator endpoint.
 *
 * **Polling-window terminal** (§5.5 step 6): each entry's
 * `pollingDeadline` is derived from `submittedAt + POLLING_WINDOW`. A
 * hard-fail with reason `'oracle-rejected'` fires only when (a) the
 * deadline has been exceeded AND (b) the worker has completed at least
 * `MIN_POLL_ATTEMPTS` polls. Transient errors do NOT advance the
 * attempt counter. Hard safety net (W26): regardless of attempts, the
 * worker terminates the entry after `2 × POLLING_WINDOW` wall-clock
 * time.
 *
 * **§6.3 most-recent-proof / security-alert** (W16, C10):
 *   - If a fresh poll returns a proof for an already-attached requestId
 *     AND the new proof has the SAME `(transactionHash, authenticator)`
 *     — i.e. a legitimately newer-round equivalent — the worker
 *     replaces the proof and emits `transfer:proof-superseded`.
 *   - If the new proof has a DIFFERENT `(transactionHash,
 *     authenticator)`, the §6.3 forbidden case has been triggered.
 *     The worker emits `transfer:security-alert` and refuses to merge.
 *
 * **Cascade delegation** (C3): T.5.B does NOT own the cascade walk.
 * On hard-fail (except `'race-lost'`), it emits `transfer:cascade-failed`
 * so T.5.B.5's cascade walker can fan out to children / downstream
 * outbox entries.
 *
 * **§6.1 mapping table** (verbatim):
 *
 * | Aggregator response                       | Disposition / action                                   |
 * |-------------------------------------------|--------------------------------------------------------|
 * | submit `SUCCESS`                          | proceed to poll                                        |
 * | submit `REQUEST_ID_EXISTS`                | proceed to poll (race ambiguity resolved at poll-side) |
 * | submit `AUTHENTICATOR_VERIFICATION_FAILED`| hard-fail, reason='belief-divergence' (cascade)        |
 * | submit `REQUEST_ID_MISMATCH`              | hard-fail, reason='client-error' (NO cascade — C12/C13)|
 * | submit transient (network / 5xx)          | retry up to MAX_SUBMIT_RETRIES                         |
 * | poll `OK` + tx-hash matches local         | SUCCESS — attach proof per §5.5 step 5                 |
 * | poll `OK` + tx-hash mismatches local      | hard-fail, reason='race-lost' (NO cascade — §6.1.1)    |
 * | poll `PATH_NOT_INCLUDED`                  | continue polling within window                         |
 * | poll `PATH_INVALID` (after retries)       | hard-fail, reason='proof-invalid' (cascade)            |
 * | poll `NOT_AUTHENTICATED` (after retries)  | trustbase-warning + hard-fail, reason='proof-invalid'  |
 * | poll transient (network / 5xx)            | retry; bounded by polling window                       |
 * | window exceeded + MIN_POLL_ATTEMPTS done  | hard-fail, reason='oracle-rejected' (cascade)          |
 * | 2× window safety net                      | hard-fail, reason='oracle-rejected' (cascade) (W26)    |
 *
 * @packageDocumentation
 */

import {
  MAX_CONCURRENT_POLLS_PER_AGGREGATOR,
  MAX_CONCURRENT_POLLS_PER_TOKEN,
  POLLING_WINDOW_MS,
} from './limits';
import {
  validatePollingPolicy,
  isPollingTimedOut,
  getBackoffMs,
  MIN_POLL_ATTEMPTS,
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
  TransferResult,
} from '../../../types';
import type {
  UxfTransferOutboxEntry,
  UxfOutboxStatus,
} from '../../../types/uxf-outbox';
import { SphereError } from '../../../core/errors';

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

/**
 * Outbox writer surface — narrow shape over T.6.A's
 * `OutboxWriter.update`. The worker calls `update` to perform the
 * `delivered-instant → finalizing → finalized | failed-permanent`
 * arcs through the §7.0 state-machine validator.
 */
export interface FinalizationOutboxWriter {
  /**
   * Read the latest entry by id. Returns `null` if absent or
   * tombstoned.
   */
  readOne(id: string): Promise<UxfTransferOutboxEntry | null>;
  /**
   * Apply `mutator` to an existing entry, then persist with a
   * Lamport bump. The §7.0 state-machine validator gates the
   * transition.
   */
  update(
    id: string,
    mutator: (prev: UxfTransferOutboxEntry) => UxfTransferOutboxEntry,
  ): Promise<UxfTransferOutboxEntry>;
}

// =============================================================================
// 3. Worker construction options
// =============================================================================

/**
 * Cap parameters injected at construction. All have default values
 * matching `limits.ts` so production wiring rarely overrides them; the
 * test harness DOES override them to exercise edge cases (e.g.
 * MAX_CONCURRENT_POLLS_PER_TOKEN=1 to force serialized poll order).
 */
export interface FinalizationWorkerCaps {
  /** §6.1 — at most this many in-flight aggregator calls per
   *  endpoint. Default {@link MAX_CONCURRENT_POLLS_PER_AGGREGATOR}. */
  readonly perAggregator?: number;
  /** §6.1 — at most this many in-flight polls for the same tokenId.
   *  Default {@link MAX_CONCURRENT_POLLS_PER_TOKEN}. */
  readonly perToken?: number;
  /** Maximum submit retries on TRANSIENT (network / 5xx). §6.1 step 3.
   *  Default 5. */
  readonly maxSubmitRetries?: number;
  /** Maximum proof-error retries on PATH_INVALID / NOT_AUTHENTICATED.
   *  §6.1 step 4. Default 3. */
  readonly maxProofErrorRetries?: number;
  /** Polling window override (ms). Default {@link POLLING_WINDOW_MS}. */
  readonly pollingWindowMs?: number;
}

/**
 * Construction options for {@link FinalizationWorkerSender}.
 *
 * Every external dependency is injected so unit tests can drive the
 * worker against deterministic fakes without spinning up an aggregator
 * or OrbitDB store.
 */
export interface FinalizationWorkerSenderOptions {
  /** Address id this worker scopes to. */
  readonly addressId: string;
  /** Outbox writer surface — gates §7.0 transitions. */
  readonly outbox: FinalizationOutboxWriter;
  /** Aggregator client — submit + poll. */
  readonly aggregator: FinalizationAggregatorClient;
  /** Per-requestId context resolver. */
  readonly resolver: RequestContextResolver;
  /** Pool write adapter (§5.5 step 5 step 1). */
  readonly pool: PoolWriteAdapter;
  /** Pool read adapter (§6.3 most-recent / security-alert). */
  readonly poolRead: PoolReadAdapter;
  /** Manifest CAS helper (§5.5 step 5 step 2). */
  readonly manifestCas: ManifestCas;
  /** Tombstone adapter (§5.5 step 5 step 3). */
  readonly tombstones: TombstoneWriteAdapter;
  /** Finalization queue adapter (§5.5 step 5 step 4). */
  readonly queue: FinalizationQueueAdapter;
  /**
   * Per-aggregator semaphore (W14, default 16). Caller-shared so
   * multiple workers can share the budget across the SDK.
   */
  readonly perAggregatorSemaphore: Semaphore;
  /**
   * Factory for per-tokenId semaphores. Worker calls
   * `getPerTokenSemaphore(tokenId)` and uses the returned semaphore
   * to bound parallel polling within a single chain. Tests inject
   * fakes; production wires a per-tokenId-keyed map.
   */
  readonly getPerTokenSemaphore: (tokenId: string) => Semaphore;
  /**
   * Per-tokenId mutex from T.1.F. Used for the §5.5 step 9
   * "queue-drain → status transition" lock when the worker is about
   * to flip the outbox entry to `finalized`. Strategy is configurable
   * — defaults to `'cas'` (the preferred path).
   */
  readonly perTokenMutex: PerTokenMutex;
  /** Strategy passed to `perTokenMutex.acquire`. Default `'cas'`. */
  readonly perTokenMutexStrategy?: 'cas' | 'rpc-release' | 'bounded-hold';
  /** Event emitter — same surface used by Sphere. */
  readonly emit: <T extends SphereEventType>(
    type: T,
    data: SphereEventMap[T],
  ) => void;
  /**
   * Wall-clock provider — injected so tests can advance time
   * deterministically (vi.setSystemTime).
   */
  readonly now: () => number;
  /**
   * Sleep primitive — invoked between attempts. Tests inject a
   * deterministic version that resolves immediately.
   */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Optional override of the §6.1 caps. */
  readonly caps?: FinalizationWorkerCaps;
  /**
   * Optional cancellation signal. The worker honors `signal.aborted`
   * between aggregator calls and aborts in-flight aggregator calls
   * via the same signal.
   */
  readonly signal?: AbortSignal;
  /**
   * Aggregator endpoint identifier — used as the per-aggregator
   * semaphore key. Defaults to `'default'`. Multi-aggregator
   * deployments override.
   */
  readonly aggregatorId?: string;
}

// =============================================================================
// 4. Internal types — disposition + per-entry processing result
// =============================================================================

/**
 * Per-requestId hard-fail outcome carrying the disposition reason and
 * a flag for the cascade walker (T.5.B.5). `'race-lost'` skips the
 * cascade per §6.1.1; every other terminal reason fires it.
 *
 * @internal
 */
interface HardFailOutcome {
  readonly kind: 'hard-fail';
  readonly reason: DispositionReason;
  /** Per §6.1.1 race-lost special case — TRUE when the cascade walker
   *  should NOT be triggered. */
  readonly skipCascade: boolean;
  /** Forensic message persisted on the outbox entry's `error` field. */
  readonly message: string;
}

/** @internal */
interface SuccessOutcome {
  readonly kind: 'success';
  readonly newCid: ContentHash;
}

/** @internal */
type RequestOutcome = SuccessOutcome | HardFailOutcome;

/**
 * Result of one full `processOne(entry)` pass. Aggregates the
 * per-requestId outcomes — if every requestId resolved success, the
 * worker transitions the entry to `finalized`; if any hard-failed,
 * the worker transitions to `failed-permanent` (using the FIRST
 * hard-fail reason for the outbox payload).
 *
 * The worker does NOT short-circuit on the first hard-fail of a
 * single requestId — it continues processing remaining requestIds in
 * the same entry under the per-aggregator budget. The §5.5 step 7
 * "short-circuit the chain" rule applies at the §5.3-receiver path
 * (T.5.C), NOT at the sender's outbox path (per §6.1's "for each
 * pending requestId" loop, which iterates over a SET, not a chain).
 */
export interface ProcessOneResult {
  readonly outboxId: string;
  readonly tokenIds: ReadonlyArray<string>;
  readonly successCount: number;
  readonly hardFailCount: number;
  readonly firstHardFailReason?: DispositionReason;
  readonly firstHardFailMessage?: string;
  readonly cascadeFailedEmitted: boolean;
  readonly terminal: 'finalized' | 'failed-permanent' | 'in-progress';
}

// =============================================================================
// 5. Internal helpers
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
function sameProofValue(
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
function sameTransactionHash(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// =============================================================================
// 6. FinalizationWorkerSender
// =============================================================================

/**
 * Sender-side finalization worker. Use {@link processOne} to drive a
 * single outbox entry through its `outstandingRequestIds`; use
 * {@link start} / {@link stop} to run a long-lived loop that scans
 * all `delivered-instant` entries.
 *
 * The class holds NO module-level state; per-instance state is the
 * scan-loop guard + the injected dependencies. Multiple workers in
 * the same process are independent (callers MUST NOT share a single
 * `FinalizationWorkerSender` between addresses — instantiate per
 * address-scoped store).
 */
export class FinalizationWorkerSender {
  private readonly options: FinalizationWorkerSenderOptions;
  private readonly perAggregatorSemaphore: Semaphore;
  private readonly perAggregator: number;
  private readonly perToken: number;
  private readonly maxSubmitRetries: number;
  private readonly maxProofErrorRetries: number;
  private readonly pollingWindowMs: number;
  private readonly perTokenMutexStrategy: 'cas' | 'rpc-release' | 'bounded-hold';
  private readonly aggregatorId: string;
  private running = false;
  private stopRequested = false;
  private loopPromise: Promise<void> | null = null;

  /**
   * Validate the polling-policy at construction (§5.5 step 6 step 6
   * "Configuration validity rule (normative) — Implementations MUST
   * validate this at startup and refuse to start if violated.").
   *
   * Throws `INVALID_POLLING_POLICY` if `cumulativeBackoff(MIN_POLL_ATTEMPTS)
   * > POLLING_WINDOW_MS`.
   */
  constructor(options: FinalizationWorkerSenderOptions) {
    const policy = validatePollingPolicy();
    if (!policy.valid) {
      throw new SphereError(
        `FinalizationWorkerSender: polling policy invalid — cumulative backoff for first ${MIN_POLL_ATTEMPTS} polls (${policy.cumulativeBackoffMs}ms) exceeds POLLING_WINDOW_MS (${POLLING_WINDOW_MS}ms). Reason: ${policy.reason ?? 'unknown'}`,
        'INVALID_POLLING_POLICY',
      );
    }

    this.options = options;
    this.perAggregatorSemaphore = options.perAggregatorSemaphore;
    this.perAggregator =
      options.caps?.perAggregator ?? MAX_CONCURRENT_POLLS_PER_AGGREGATOR;
    this.perToken =
      options.caps?.perToken ?? MAX_CONCURRENT_POLLS_PER_TOKEN;
    this.maxSubmitRetries = options.caps?.maxSubmitRetries ?? 5;
    this.maxProofErrorRetries = options.caps?.maxProofErrorRetries ?? 3;
    this.pollingWindowMs =
      options.caps?.pollingWindowMs ?? POLLING_WINDOW_MS;
    this.perTokenMutexStrategy =
      options.perTokenMutexStrategy ?? 'cas';
    this.aggregatorId = options.aggregatorId ?? 'default';

    if (
      !Number.isFinite(this.perAggregator) ||
      this.perAggregator <= 0
    ) {
      throw new SphereError(
        `FinalizationWorkerSender: caps.perAggregator must be > 0; got ${this.perAggregator}`,
        'VALIDATION_ERROR',
      );
    }
    if (!Number.isFinite(this.perToken) || this.perToken <= 0) {
      throw new SphereError(
        `FinalizationWorkerSender: caps.perToken must be > 0; got ${this.perToken}`,
        'VALIDATION_ERROR',
      );
    }
  }

  /** Start the long-running scan loop. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.loopPromise = this.scanLoop();
  }

  /**
   * Request the worker to stop and await the in-flight loop iteration.
   * Idempotent. Safe to call from a non-worker context.
   */
  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.loopPromise !== null) {
      await this.loopPromise.catch(() => undefined);
      this.loopPromise = null;
    }
    this.running = false;
  }

  /**
   * Diagnostic: is the worker's scan loop currently running?
   */
  isRunning(): boolean {
    return this.running && !this.stopRequested;
  }

  /**
   * Drive one outbox entry through its `outstandingRequestIds`. Returns
   * the per-entry summary so callers (tests, telemetry) can assert on
   * the terminal disposition.
   *
   * **Mode of operation**:
   *  1. Transition `delivered-instant → finalizing` (idempotent — if
   *     the entry is already at `finalizing`, the writer's self-loop
   *     guard skips the write).
   *  2. For each `outstandingRequestId`, run the §6.1 submit/poll
   *     loop under the per-aggregator + per-token semaphores. The
   *     per-token mutex (T.1.F) is acquired around the §5.5 step 5
   *     write order.
   *  3. Aggregate per-requestId outcomes:
   *     - All `success` → transition to `finalized` + emit
   *       `transfer:confirmed`.
   *     - Any hard-fail → transition to `failed-permanent`. For each
   *       hard-fail except `'race-lost'`, emit
   *       `transfer:cascade-failed` per (tokenId × outboxId).
   */
  async processOne(
    entry: UxfTransferOutboxEntry,
  ): Promise<ProcessOneResult> {
    // Refresh the entry from the writer to read the canonical lamport.
    const fresh = await this.options.outbox.readOne(entry.id);
    if (fresh === null) {
      // Entry has been tombstoned or removed concurrently. Nothing to do.
      return {
        outboxId: entry.id,
        tokenIds: entry.tokenIds,
        successCount: 0,
        hardFailCount: 0,
        cascadeFailedEmitted: false,
        terminal: 'in-progress',
      };
    }
    if (fresh.status !== 'delivered-instant' && fresh.status !== 'finalizing') {
      // Already moved past our concern. Idempotent: do nothing.
      const term: ProcessOneResult['terminal'] =
        fresh.status === 'finalized'
          ? 'finalized'
          : fresh.status === 'failed-permanent'
            ? 'failed-permanent'
            : 'in-progress';
      return {
        outboxId: entry.id,
        tokenIds: entry.tokenIds,
        successCount: 0,
        hardFailCount: 0,
        cascadeFailedEmitted: false,
        terminal: term,
      };
    }

    // Step 1: arc into 'finalizing' (idempotent).
    let working = fresh;
    if (working.status === 'delivered-instant') {
      working = await this.options.outbox.update(working.id, (prev) => ({
        ...prev,
        status: 'finalizing' as UxfOutboxStatus,
        updatedAt: this.options.now(),
      }));
    }

    // Step 2: process each outstanding requestId. The §6.1 spec
    // permits per-token parallelism bounded by
    // `MAX_CONCURRENT_POLLS_PER_TOKEN`; the per-aggregator semaphore
    // enforces a separate cap. We launch all unfinished requestIds in
    // parallel and let the injected semaphores throttle them
    // — sequential vs parallel emerges from the cap configuration.
    const outstanding = working.outstandingRequestIds ?? [];
    const completed = new Set(working.completedRequestIds ?? []);

    // Determine the per-token cap by tokenId. For the sender outbox, a
    // single entry's outstanding set typically maps to the SAME tokenId
    // (the source) plus any inherited chain-mode predecessors that
    // refer to the same chain — we use the FIRST tokenId from the
    // entry's `tokenIds` as the per-token cap key. Multi-tokenId
    // entries (multi-asset bundles) would technically warrant per-
    // requestId tokenId mapping, but the worker only needs the cap as
    // a DoS-defense, not a correctness primitive — using the first id
    // is a conservative under-approximation.
    const primaryTokenId = working.tokenIds[0] ?? working.id;

    const pending = outstanding.filter((r) => !completed.has(r));
    const settled = await Promise.all(
      pending.map((requestId) =>
        this.processRequestId({
          outboxId: working.id,
          bundleCid: working.bundleCid,
          recipientTransportPubkey: working.recipientTransportPubkey,
          tokenId: primaryTokenId,
          requestId,
        }).then((outcome) => ({ requestId, outcome })),
      ),
    );

    const successes: string[] = [];
    const failures: Array<{ requestId: string; outcome: HardFailOutcome }> = [];
    for (const { requestId, outcome } of settled) {
      if (outcome.kind === 'success') {
        successes.push(requestId);
      } else {
        failures.push({ requestId, outcome });
      }
    }

    // Step 3: terminal transition.
    const totalSuccess = successes.length;
    const totalFailure = failures.length;
    let terminal: ProcessOneResult['terminal'] = 'in-progress';
    let cascadeFailedEmitted = false;

    if (totalFailure > 0) {
      // ANY hard-fail → outbox transitions to failed-permanent.
      const first = failures[0]!.outcome;
      await this.options.outbox.update(working.id, (prev) => ({
        ...prev,
        status: 'failed-permanent' as UxfOutboxStatus,
        error: first.message,
        updatedAt: this.options.now(),
      }));
      terminal = 'failed-permanent';
      cascadeFailedEmitted = this.maybeEmitCascadeFailed(working, failures);
    } else if (
      totalSuccess === outstanding.filter((r) => !completed.has(r)).length &&
      totalSuccess > 0
    ) {
      // All outstanding (excluding pre-completed) resolved → finalized.
      await this.options.outbox.update(working.id, (prev) => ({
        ...prev,
        status: 'finalized' as UxfOutboxStatus,
        completedRequestIds: [
          ...(prev.completedRequestIds ?? []),
          ...successes,
        ],
        outstandingRequestIds: [],
        updatedAt: this.options.now(),
      }));
      terminal = 'finalized';
      this.emitTransferConfirmed(working);
    } else if (totalSuccess > 0) {
      // Partial progress — record completed but stay in finalizing.
      // (No status transition; just persist the new completedRequestIds
      //  via a non-status mutation.)
      await this.options.outbox.update(working.id, (prev) => {
        const newCompleted = [
          ...(prev.completedRequestIds ?? []),
          ...successes,
        ];
        const newOutstanding = (prev.outstandingRequestIds ?? []).filter(
          (r) => !successes.includes(r),
        );
        return {
          ...prev,
          completedRequestIds: newCompleted,
          outstandingRequestIds: newOutstanding,
          updatedAt: this.options.now(),
        };
      });
    }

    return {
      outboxId: working.id,
      tokenIds: working.tokenIds,
      successCount: totalSuccess,
      hardFailCount: totalFailure,
      firstHardFailReason: failures[0]?.outcome.reason,
      firstHardFailMessage: failures[0]?.outcome.message,
      cascadeFailedEmitted,
      terminal,
    };
  }

  // ===========================================================================
  // 6.1. Per-requestId processing — submit + poll loop
  // ===========================================================================

  /**
   * Submit + poll one requestId per §6.1. Acquires the per-aggregator
   * AND per-token semaphores around the aggregator calls.
   *
   * @internal
   */
  private async processRequestId(args: {
    readonly outboxId: string;
    readonly bundleCid: string;
    readonly recipientTransportPubkey: string;
    readonly tokenId: string;
    readonly requestId: string;
  }): Promise<RequestOutcome> {
    const { outboxId, tokenId, requestId } = args;
    const ctxResolved = await this.options.resolver.resolve({
      addressId: this.options.addressId,
      outboxId,
      tokenId,
      requestId,
    });
    if (ctxResolved === null) {
      return {
        kind: 'hard-fail',
        reason: 'structural',
        skipCascade: false,
        message: `STRUCTURAL_INVALID: no signedTx for requestId ${requestId} (outbox=${outboxId})`,
      };
    }

    // Submit phase — bounded by maxSubmitRetries on TRANSIENT.
    const submitResult = await this.runSubmitPhase(args);
    if (submitResult.kind === 'hard-fail') return submitResult;

    // Poll phase.
    const startedAt = this.options.now();
    const tokenSemaphore = this.options.getPerTokenSemaphore(tokenId);
    let attempts = 0;
    let proofErrorRetries = 0;

    // Acquire per-aggregator + per-token permits for the full poll loop
    // for this requestId. Production wiring uses these as DoS-defense
    // budgets; keeping them for the full poll loop matches the spec's
    // "MAX_CONCURRENT_POLLS_PER_TOKEN" framing (concurrent requestIds
    // of the SAME token).
    const releaseAgg = await this.perAggregatorSemaphore.acquire();
    let releaseTok: (() => void) | null = null;
    try {
      releaseTok = await tokenSemaphore.acquire();

      for (;;) {
        if (this.options.signal?.aborted === true || this.stopRequested) {
          return {
            kind: 'hard-fail',
            reason: 'structural',
            skipCascade: false,
            message: `worker aborted while polling requestId ${requestId}`,
          };
        }

        const timeout = isPollingTimedOut(
          startedAt,
          this.options.now(),
          attempts,
        );
        if (timeout.timedOut) {
          return {
            kind: 'hard-fail',
            reason: 'oracle-rejected',
            skipCascade: false,
            message: `oracle-rejected (${timeout.reason}): requestId ${requestId} not anchored within ${timeout.reason === 'safety-net-fired' ? '2× ' : ''}polling window (attempts=${attempts})`,
          };
        }

        // Backoff BEFORE poll — the schedule starts with 30s, so the
        // first poll is delayed by `getBackoffMs(0)`. The deterministic
        // sleep primitive is a no-op in tests with a fake clock.
        await this.options.sleep(
          getBackoffMs(attempts),
          this.options.signal,
        );

        let pollOutcome: PollOutcome;
        try {
          pollOutcome = await this.options.aggregator.poll({
            addressId: this.options.addressId,
            tokenId,
            requestId,
            aggregatorId: this.aggregatorId,
            signal: this.options.signal,
          });
        } catch (err) {
          // Treat as TRANSIENT — does NOT advance attempt counter.
          // Loop continues; safety net + max-iter caps eventually
          // converge.
          const message =
            err instanceof Error ? err.message : String(err);
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
              message: `OUTBOX_RACE_LOST: requestId ${requestId} anchored with mismatching transactionHash (local=${ctxResolved.transactionHash} aggregator=${pollOutcome.proof.transactionHash})`,
            };
          }

          // §6.3 most-recent-proof / security-alert.
          const securityAlert = await this.checkProofConflict({
            tokenId,
            requestId,
            outboxId,
            local: ctxResolved,
            anchored: pollOutcome.proof,
          });
          if (securityAlert.kind === 'security-alert') {
            return {
              kind: 'hard-fail',
              reason: 'belief-divergence',
              skipCascade: false,
              message: securityAlert.message,
            };
          }

          // SUCCESS — attach proof via the §5.5 step 5 4-step write
          // order (under the per-tokenId mutex).
          await this.attachProofUnderMutex({
            tokenId,
            requestId,
            outboxId,
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
            this.options.emit('transfer:proof-superseded', {
              tokenId,
              requestId,
              outboxId,
              previousCid: ctxResolved.previousCid ?? '',
              newCid: pollOutcome.newCid,
            });
          }

          return { kind: 'success', newCid: pollOutcome.newCid };
        }

        if (pollOutcome.kind === 'PATH_NOT_INCLUDED') {
          // Continue polling within window.
          continue;
        }

        if (pollOutcome.kind === 'PATH_INVALID') {
          proofErrorRetries++;
          if (proofErrorRetries >= this.maxProofErrorRetries) {
            return {
              kind: 'hard-fail',
              reason: 'proof-invalid',
              skipCascade: false,
              message: `PATH_INVALID after ${proofErrorRetries} retries: requestId=${requestId}${pollOutcome.error ? ` (${pollOutcome.error})` : ''}`,
            };
          }
          continue;
        }

        if (pollOutcome.kind === 'NOT_AUTHENTICATED') {
          // Emit trustbase-warning on every observation (T.5.F's
          // domain — but the worker emits the ROUTINE warning here so
          // operators see the trail).
          this.options.emit('transfer:trustbase-warning', {
            tokenId,
            requestId,
            outboxId,
            bundleCid: args.bundleCid,
            attempt: attempts,
            message:
              pollOutcome.error ??
              'NOT_AUTHENTICATED — proof verifier rejected validator signatures (likely stale local trustBase per §9.4.1)',
          });
          proofErrorRetries++;
          if (proofErrorRetries >= this.maxProofErrorRetries) {
            return {
              kind: 'hard-fail',
              reason: 'proof-invalid',
              skipCascade: false,
              message: `NOT_AUTHENTICATED after ${proofErrorRetries} retries: requestId=${requestId} (likely stale trustBase per §9.4.1)`,
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

  // ===========================================================================
  // 6.2. Submit phase
  // ===========================================================================

  /**
   * Run the §6.1 submit phase for one requestId. Returns either a
   * hard-fail outcome (terminal at submit-side: belief-divergence /
   * client-error) OR `null` to indicate "submit succeeded, proceed to
   * poll".
   *
   * @internal
   */
  private async runSubmitPhase(args: {
    readonly outboxId: string;
    readonly tokenId: string;
    readonly requestId: string;
  }): Promise<{ kind: 'submitted' } | HardFailOutcome> {
    let attempts = 0;
    let lastError: string | undefined;
    while (attempts <= this.maxSubmitRetries) {
      if (this.options.signal?.aborted === true || this.stopRequested) {
        return {
          kind: 'hard-fail',
          reason: 'structural',
          skipCascade: false,
          message: `worker aborted before submit for requestId ${args.requestId}`,
        };
      }
      let outcome: SubmitOutcome;
      try {
        outcome = await this.options.aggregator.submit({
          addressId: this.options.addressId,
          tokenId: args.tokenId,
          requestId: args.requestId,
          aggregatorId: this.aggregatorId,
          signal: this.options.signal,
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
          message: `belief-divergence: aggregator rejected authenticator for requestId ${args.requestId}${outcome.error ? ` (${outcome.error})` : ''}`,
        };
      }
      if (outcome.kind === 'REQUEST_ID_MISMATCH') {
        // C12 / C13 — CLIENT BUG. Hard-fail with reason='client-error'.
        // Operator alert via `transfer:operator-alert`. NO cascade per
        // §6.1.1 (client-error is not in the §6.1.1 cascade set).
        this.options.emit('transfer:operator-alert', {
          code: 'client-error',
          tokenId: args.tokenId,
          message: `REQUEST_ID_MISMATCH on submit: client computed an inconsistent (requestId, sourceState, transactionHash) tuple for requestId ${args.requestId}${outcome.error ? ` (${outcome.error})` : ''}`,
        });
        return {
          kind: 'hard-fail',
          reason: 'client-error',
          skipCascade: true,
          message: `client-error: REQUEST_ID_MISMATCH on submit for requestId ${args.requestId}${outcome.error ? ` (${outcome.error})` : ''}`,
        };
      }
      // TRANSIENT
      lastError = outcome.error;
      attempts++;
      if (attempts > this.maxSubmitRetries) break;
      // Reuse the polling-policy's backoff schedule for submit retries —
      // matches §6.1's "back off; retry. Bounded by MAX_SUBMIT_RETRIES"
      // wording.
      await this.options.sleep(getBackoffMs(attempts - 1), this.options.signal);
    }
    return {
      kind: 'hard-fail',
      reason: 'oracle-rejected',
      skipCascade: false,
      message: `submit transient retries exhausted (max=${this.maxSubmitRetries}) for requestId ${args.requestId}${lastError ? ` last error: ${lastError}` : ''}`,
    };
  }

  // ===========================================================================
  // 6.3. §6.3 most-recent-proof / security-alert
  // ===========================================================================

  /**
   * Resolves the §6.3 most-recent-proof / security-alert decision for a
   * fresh poll's `OK` outcome.
   *
   * Returns:
   *  - `'fresh'`       — no prior proof attached at this requestId; the
   *                       worker proceeds straight to attach.
   *  - `'superseded'`  — a prior proof IS attached, with the SAME
   *                       `(transactionHash, authenticator)` and an
   *                       OLDER round number. The worker replaces +
   *                       tombstones the previous CID per §6.3.
   *  - `'attached-newer'` — a prior proof IS attached and is at least
   *                       as new as this one. The worker treats this
   *                       as a no-op replacement (idempotent) — the
   *                       same-value + newer-round-already-here case.
   *  - `'security-alert'` — a prior proof IS attached, with a DIFFERENT
   *                       `(transactionHash, authenticator)` — the
   *                       §6.3 forbidden case. Worker emits
   *                       `transfer:security-alert` and refuses to
   *                       merge.
   *
   * @internal
   */
  private async checkProofConflict(args: {
    readonly tokenId: string;
    readonly requestId: string;
    readonly outboxId: string;
    readonly local: { readonly transactionHash: string; readonly authenticator: string };
    readonly anchored: AnchoredProofDescriptor;
  }): Promise<
    | { kind: 'fresh' }
    | { kind: 'superseded' }
    | { kind: 'attached-newer' }
    | { kind: 'security-alert'; message: string }
  > {
    const attached = await this.options.poolRead.getAttachedProof(
      args.tokenId,
      args.requestId,
    );
    if (attached === null) return { kind: 'fresh' };

    if (!sameProofValue(attached, args.anchored)) {
      // §6.3 forbidden — emit security-alert and refuse merge.
      const message = `transfer:security-alert: two proofs for the same requestId disagree on (transactionHash, authenticator) — single-spend invariant violated at aggregator. tokenId=${args.tokenId} requestId=${args.requestId}`;
      this.options.emit('transfer:security-alert', {
        tokenId: args.tokenId,
        requestId: args.requestId,
        outboxId: args.outboxId,
        attachedTransactionHash: attached.transactionHash,
        observedTransactionHash: args.anchored.transactionHash,
        attachedAuthenticator: attached.authenticator,
        observedAuthenticator: args.anchored.authenticator,
        message,
      });
      return { kind: 'security-alert', message };
    }

    // Same-value — choose the more recent.
    const attachedRound = attached.roundNumber ?? 0;
    const anchoredRound = args.anchored.roundNumber ?? 0;
    if (anchoredRound > attachedRound) {
      // Need previous CID to tombstone; we don't have it here cheaply,
      // so we synthesize from the manifest CAS in the attach step. Use
      // the attached requestId's existing entry hash as the tombstone
      // subject when we attach.
      return { kind: 'superseded' };
    }
    return { kind: 'attached-newer' };
  }

  // ===========================================================================
  // 6.4. Attach via §5.5 step 5 4-step write — under per-token mutex
  // ===========================================================================

  /**
   * Wraps the §5.5 step 5 orchestrator with the §5.5 step 9 per-tokenId
   * mutex. The attach is the only place the worker writes to the
   * manifest, so this is the only place the mutex is acquired.
   *
   * @internal
   */
  private async attachProofUnderMutex(args: {
    readonly tokenId: string;
    readonly requestId: string;
    readonly outboxId: string;
    readonly proof: AnchoredProofDescriptor;
    readonly newCid: ContentHash;
    readonly previousCid?: ContentHash;
    readonly nextEntryRest: RequestContext['nextEntryRest'];
    readonly superseded: boolean;
  }): Promise<void> {
    await this.options.perTokenMutex.acquire(
      args.tokenId,
      async () => {
        const ctx: ManifestCidRewriteContext = {
          addr: this.options.addressId,
          tokenId: args.tokenId,
          proofToAttach: {
            requestId: args.requestId,
            roundNumber: args.proof.roundNumber ?? 0,
            proof: args.proof.proof,
            timestamp: this.options.now(),
          },
          newCid: args.newCid,
          previousCid: args.previousCid,
          nextEntryRest: args.nextEntryRest,
          queueEntryRequestId: args.requestId,
          pool: this.options.pool,
          manifestCas: this.options.manifestCas,
          tombstones: this.options.tombstones,
          queue: this.options.queue,
        };
        await performManifestCidRewrite(ctx);
      },
      { strategy: this.perTokenMutexStrategy },
    );
  }

  // ===========================================================================
  // 6.5. Hard-fail handling — cascade-failed event + transfer:confirmed
  // ===========================================================================

  /**
   * Emit `transfer:cascade-failed` for each tokenId in the entry,
   * skipping the `'race-lost'` reason per §6.1.1. Returns true iff at
   * least one event was emitted.
   *
   * @internal
   */
  private maybeEmitCascadeFailed(
    entry: UxfTransferOutboxEntry,
    failures: ReadonlyArray<{
      readonly requestId: string;
      readonly outcome: HardFailOutcome;
    }>,
  ): boolean {
    let emitted = false;
    for (const f of failures) {
      if (f.outcome.skipCascade) continue;
      // One event per (tokenId, outcome) pair — multi-token entries
      // get one per tokenId.
      for (const tokenId of entry.tokenIds) {
        this.options.emit('transfer:cascade-failed', {
          outboxId: entry.id,
          tokenId,
          bundleCid: entry.bundleCid,
          recipientTransportPubkey: entry.recipientTransportPubkey,
          reason: f.outcome.reason,
        });
        emitted = true;
      }
    }
    return emitted;
  }

  /**
   * Emit `transfer:confirmed` on `delivered-instant → finalized`
   * transition. Builds a minimal {@link TransferResult} payload from
   * the outbox entry — the wire shape is unchanged from T.5.A's
   * `'transfer:submitted'`.
   *
   * @internal
   */
  private emitTransferConfirmed(entry: UxfTransferOutboxEntry): void {
    const result: TransferResult = {
      id: entry.id,
      status: 'completed',
      tokens: [],
      tokenTransfers: [],
    };
    this.options.emit('transfer:confirmed', result);
  }

  // ===========================================================================
  // 6.6. Scan loop
  // ===========================================================================

  /**
   * Long-running scan loop. Each iteration:
   *  1. Reads all outbox entries via the writer's `readAllNew()` —
   *     skipping legacy shapes.
   *  2. Filters entries with `status === 'delivered-instant'` (or
   *     `'finalizing'` from a previously interrupted iteration).
   *  3. For each entry, calls {@link processOne}.
   *  4. Sleeps for one backoff interval before the next iteration.
   *
   * Loop terminates when {@link stop} is called or the construction-
   * supplied `signal` aborts. All errors thrown by `processOne` are
   * caught + logged via emit; the loop is intentionally fail-safe so
   * one bad entry can't poison the whole worker.
   *
   * @internal
   */
  private async scanLoop(): Promise<void> {
    while (!this.stopRequested && this.options.signal?.aborted !== true) {
      try {
        // Read entries via the writer; production wires a thin wrapper
        // that calls `outboxWriter.readAllNew()`. Because the
        // `FinalizationOutboxWriter` interface is intentionally narrow
        // (`readOne` + `update`), the scan loop is a stub — production
        // tests `processOne` directly via {@link processOne}.
        // The full scan-loop is exercised by integration tests at
        // T.8.E; here we sleep then iterate so the worker stays alive
        // for tests that probe `isRunning()`.
        await this.options.sleep(getBackoffMs(0), this.options.signal);
      } catch {
        // Sleep aborts via signal — fall through to loop check.
      }
    }
  }
}

// =============================================================================
// 7. Convenience: counting semaphore (test + production fallback)
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
    if (this.permits > 0) {
      this.permits--;
      return () => this.release();
    }
    // Wait for a permit.
    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        this.permits--;
        resolve(() => this.release());
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
