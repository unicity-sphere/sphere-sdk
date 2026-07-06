/**
 * UXF Transfer — manifest-CID-rewrite (§5.5 step 5, T.5.B.0).
 *
 * Implements the protocol's atomic-ish 4-step write order for attaching
 * an inclusion proof to a token. The OrbitDB key-value store has no
 * multi-key atomicity primitive, so atomicity is **emulated by
 * ordering** + per-step idempotency. Each step is a no-op on replay; a
 * crash anywhere between (1) and (4) leaves the next worker pass with
 * enough information (queue entry still present) to resume from the
 * right step and converge.
 *
 * Spec reference: §5.5 step 5 (verbatim quote, normative):
 *
 *   (1) pool write proof element        ← content-addressed; re-write is no-op
 *   (2) manifest CID rewrite            ← idempotent; same input → same output
 *   (3) tombstone insert                ← additive; duplicate insert is no-op
 *   (4) queue-entry removal LAST        ← presence/absence is the durability anchor
 *
 * The "queue-entry removal LAST" rule is the durability anchor: as long
 * as the queue entry is present, the worker treats the operation as
 * incomplete and re-runs all steps. Each step is idempotent, so re-runs
 * never corrupt state.
 *
 * Both the sender finalization worker (T.5.B) and the recipient
 * finalization worker (T.5.C) share this orchestrator; the protocol
 * mandates IDENTICAL write semantics for both.
 *
 * @packageDocumentation
 */

import type { ContentHash } from '../../../extensions/uxf/bundle/types';
import type { ManifestCas } from '../../../profile/manifest-cas';
import { PerTokenMutex } from '../../../profile/per-token-mutex';
import type { TokenManifestEntry } from '../../../profile/token-manifest';
import type { InclusionProof } from '../../../oracle/oracle-provider';

// =============================================================================
// 1. Storage abstractions — minimal contracts injected by callers
// =============================================================================

/**
 * Minimal pool-storage contract for {@link step1Pool}.
 *
 * The pool is content-addressed: writing the same proof element twice
 * is a true no-op at the storage layer. We expose two methods so the
 * orchestrator can detect "already applied" without re-encoding the
 * proof.
 *
 * Implementations are typically a thin wrapper around the
 * `ProfileTokenStorageProvider` pool key-space.
 */
export interface PoolWriteAdapter {
  /**
   * Has the inclusion proof already been attached to the token's pool
   * entry under the queue-entry's request? Used by the orchestrator to
   * skip step 1 cleanly on replay.
   *
   * Implementations MAY use any local invariant they prefer (e.g.
   * checking the pool element's `inclusionProof` child is non-null);
   * the contract is purely "has step 1 already been applied for this
   * (tokenId, queueEntryRequestId) pair".
   */
  isProofAttached(
    tokenId: string,
    queueEntryRequestId: string,
  ): Promise<boolean>;

  /**
   * Attach the inclusion proof to the token's pool entry.
   *
   * MUST be idempotent: a second call with identical arguments after a
   * successful first call MUST NOT throw and MUST NOT corrupt state.
   * Implementations achieve this by content-addressing the proof
   * element (re-write of the same bytes lands on the same pool key).
   */
  attachProof(
    tokenId: string,
    queueEntryRequestId: string,
    proof: InclusionProof,
  ): Promise<void>;
}

/**
 * Minimal tombstone-storage contract for {@link step3Tombstone}.
 *
 * Tombstones are an additive set: inserting the same `(tokenId, cid)`
 * pair twice is a no-op. Implementations MAY back this with the
 * existing `_tombstones` collection or a dedicated key-space; the
 * orchestrator does not care.
 */
export interface TombstoneWriteAdapter {
  /**
   * Has a tombstone for `(tokenId, cid)` already been recorded? Used
   * by the orchestrator to skip step 3 cleanly on replay.
   */
  hasTombstone(tokenId: string, cid: ContentHash): Promise<boolean>;

  /**
   * Record a tombstone for the supersession of `cid`. Idempotent.
   * The set semantics ensure duplicate inserts are silent no-ops.
   */
  insertTombstone(tokenId: string, cid: ContentHash): Promise<void>;
}

/**
 * Minimal finalization-queue contract for {@link step4RemoveQueueEntry}.
 *
 * The queue entry is the durability anchor: as long as it is present,
 * the worker treats the rewrite as incomplete. Removal MUST be the
 * last write in the sequence.
 */
export interface FinalizationQueueAdapter {
  /**
   * Is a queue entry with `requestId` currently present under `addr`?
   * Used by the orchestrator to skip step 4 cleanly on replay.
   */
  hasEntry(addr: string, requestId: string): Promise<boolean>;

  /**
   * Remove the finalization-queue entry. Idempotent: removing a
   * non-existent entry MUST NOT throw — implementations either
   * detect-and-skip or rely on the underlying CRDT's tombstone
   * semantics for unknown keys.
   */
  removeEntry(addr: string, requestId: string): Promise<void>;
}

// =============================================================================
// 2. Orchestrator types
// =============================================================================

/**
 * Bundle of inputs and adapters for one rewrite operation.
 *
 * Per the §5.5 step 5 contract, every rewrite is scoped to a single
 * `(addr, tokenId, queueEntryRequestId)` triple. The proof and the new
 * CID are caller-supplied (the worker computes them upstream). All
 * storage is provided via injected adapters so the orchestrator stays
 * pure-logic and can be exercised with deterministic-clock fault
 * injection.
 */
export interface ManifestCidRewriteContext {
  /** Wallet address whose manifest is being updated. */
  readonly addr: string;
  /** TokenId whose manifest entry + pool is being updated. */
  readonly tokenId: string;
  /**
   * Inclusion proof to attach in step 1. Caller is responsible for
   * cryptographic verification (`verify() === OK`) BEFORE invoking.
   */
  readonly proofToAttach: InclusionProof;
  /**
   * The token's NEW content hash after the proof bytes are present in
   * its CBOR encoding. Caller computes this upstream.
   */
  readonly newCid: ContentHash;
  /**
   * The PREVIOUS content hash being superseded. Used as the CAS
   * precondition for step 2 and as the tombstone subject for step 3.
   * Omit (`undefined`) ONLY for the genesis case where no prior entry
   * exists; the orchestrator translates `undefined` into a `prev: null`
   * CAS argument so step 2 inserts the first entry.
   */
  readonly previousCid?: ContentHash;
  /**
   * Other fields of the new manifest entry (status, conflictingHeads,
   * invalidReason). The orchestrator combines this with `newCid` to
   * form the `next` argument for `manifestCas.update`.
   */
  readonly nextEntryRest: Omit<TokenManifestEntry, 'rootHash'>;
  /**
   * Finalization queue entry id whose presence is the durability
   * anchor. Removed in step 4.
   */
  readonly queueEntryRequestId: string;
  /** Pool-write adapter for step 1. */
  readonly pool: PoolWriteAdapter;
  /** ManifestCas helper from T.1.F for step 2. */
  readonly manifestCas: ManifestCas;
  /** Tombstone-write adapter for step 3. */
  readonly tombstones: TombstoneWriteAdapter;
  /** Finalization-queue adapter for step 4. */
  readonly queue: FinalizationQueueAdapter;
}

/**
 * Discriminated outcome of a rewrite invocation.
 *
 *  - `'ok'` — orchestrator started at step 1 (no idempotency skip
 *    detected). Every step ran a real write; the operation
 *    represented either a fresh attach or a replay where every step
 *    happened to have already been applied (re-runs are no-ops at
 *    the storage layer).
 *  - `'partial-step1-resumed'` — replay detected at step 2 entry
 *    (step 1 was already applied). Steps 2–4 ran.
 *  - `'partial-step2-resumed'` — replay detected at step 3 entry
 *    (steps 1–2 already applied). Steps 3–4 ran.
 *  - `'partial-step3-resumed'` — replay detected at step 4 entry
 *    (steps 1–3 already applied). Step 4 ran.
 *  - `'noop'` — every step was already applied (queue entry already
 *    removed). Caller's worker pass picked up a finalization that
 *    finished on a previous pass; no work to do.
 *  - `'lost-concurrent-race'` — TWO concurrent worker passes both
 *    crossed the `step1Pool.isProofAttached === false` boundary
 *    before the mutex was added. After the mutex was added (steelman
 *    Wave 3) the canonical outcome of a lost concurrent race is the
 *    second caller observing `step1Pool` as already-applied (returns
 *    `partial-step1-resumed`); this discriminator is reserved for the
 *    rare case where the race is detected at a deeper layer and we
 *    want to surface "the other worker beat us" without false-alarming
 *    the operator dashboards as a real CAS conflict.
 *
 * The discriminator exposes which boundary the previous crash landed
 * at — useful for telemetry, fault-injection assertions, and for the
 * W25 atomicity test that pins crash-between-3-and-4 specifically.
 */
export type ManifestCidRewriteResult = {
  readonly result:
    | 'ok'
    | 'partial-step1-resumed'
    | 'partial-step2-resumed'
    | 'partial-step3-resumed'
    | 'noop'
    | 'lost-concurrent-race';
};

// =============================================================================
// 3. Per-step functions — exported for fault injection
// =============================================================================

/**
 * Step 1 — pool write proof.
 *
 * The pool is content-addressed: writing the same `(tokenId, requestId,
 * proof)` triple twice resolves to the same element bytes, so the
 * second write is a true no-op at the storage layer. We additionally
 * short-circuit via `isProofAttached` so the orchestrator can return a
 * `partial-stepN-resumed` discriminator.
 *
 * @returns `true` iff a real write was issued (i.e. the proof was NOT
 *   already attached). `false` indicates an idempotency skip.
 */
export async function step1Pool(
  ctx: ManifestCidRewriteContext,
): Promise<boolean> {
  const { tokenId, queueEntryRequestId, proofToAttach, pool } = ctx;
  if (await pool.isProofAttached(tokenId, queueEntryRequestId)) {
    return false;
  }
  await pool.attachProof(tokenId, queueEntryRequestId, proofToAttach);
  return true;
}

/**
 * Step 2 — manifest CID rewrite.
 *
 * Compare-and-swap from `previousCid` to `newCid`. The CAS is the
 * idempotency primitive: a second invocation after a successful first
 * sees `observed.contentHash === newCid` and returns `cas-mismatch`,
 * which we translate to "already applied".
 *
 * @returns `true` iff a real write was issued (CAS succeeded on this
 *   call). `false` indicates an idempotency skip (CAS observed
 *   `newCid` already in place).
 * @throws  `Error` on real CAS failures (concurrent-modification,
 *   not-found-when-expected, or cas-mismatch where observed is
 *   neither `previousCid` nor `newCid` — the chain has been concurrently
 *   advanced by an unrelated writer).
 */
export async function step2ManifestCidRewrite(
  ctx: ManifestCidRewriteContext,
): Promise<boolean> {
  const { addr, tokenId, newCid, previousCid, nextEntryRest, manifestCas } = ctx;
  const next: TokenManifestEntry = {
    rootHash: newCid,
    status: nextEntryRest.status,
    ...(nextEntryRest.conflictingHeads !== undefined
      ? { conflictingHeads: nextEntryRest.conflictingHeads }
      : {}),
    ...(nextEntryRest.invalidReason !== undefined
      ? { invalidReason: nextEntryRest.invalidReason }
      : {}),
  };
  const prev =
    previousCid === undefined ? null : { contentHash: previousCid };
  const result = await manifestCas.update(addr, tokenId, prev, next);
  if (result.ok) return true;

  // CAS failed. Check whether the failure represents an idempotency
  // skip (observed.contentHash === newCid → step 2 has already been
  // applied on a prior worker pass). Any other failure is a real
  // error and must propagate to the caller.
  if (
    result.reason === 'cas-mismatch' &&
    result.observed?.contentHash === newCid
  ) {
    return false;
  }
  // Genuine CAS failure: bubble up. The caller's worker loop is
  // responsible for re-reading state and retrying.
  throw new ManifestCidRewriteCasError(result.reason, result.observed?.contentHash);
}

/**
 * Step 3 — tombstone insert.
 *
 * Records that `previousCid` has been superseded by `newCid` so older
 * peer caches are not re-served. Additive set: a duplicate insert is a
 * no-op. We short-circuit via `hasTombstone` so the orchestrator can
 * return a `partial-stepN-resumed` discriminator.
 *
 * If `previousCid` is `undefined` (genesis case), there is nothing to
 * tombstone — step 3 is a clean no-op.
 *
 * @returns `true` iff a real write was issued. `false` indicates an
 *   idempotency skip OR the genesis no-op.
 */
export async function step3Tombstone(
  ctx: ManifestCidRewriteContext,
): Promise<boolean> {
  const { tokenId, previousCid, tombstones } = ctx;
  if (previousCid === undefined) return false;
  if (await tombstones.hasTombstone(tokenId, previousCid)) return false;
  await tombstones.insertTombstone(tokenId, previousCid);
  return true;
}

/**
 * Step 4 — queue-entry removal (LAST).
 *
 * The queue entry is the durability anchor: as long as it is present,
 * the worker treats the rewrite as incomplete and re-runs all steps.
 * Removal MUST be the LAST write in the sequence — this is what the
 * §5.5 step 5 "queue-entry removal LAST" rule encodes.
 *
 * @returns `true` iff a real removal was issued. `false` indicates
 *   the entry was already absent (idempotency skip).
 */
export async function step4RemoveQueueEntry(
  ctx: ManifestCidRewriteContext,
): Promise<boolean> {
  const { addr, queueEntryRequestId, queue } = ctx;
  if (!(await queue.hasEntry(addr, queueEntryRequestId))) return false;
  await queue.removeEntry(addr, queueEntryRequestId);
  return true;
}

// =============================================================================
// 4. Orchestrator
// =============================================================================

/**
 * Distinguished error thrown by step 2 when the CAS failure is NOT an
 * idempotency skip. Caller's worker loop is expected to catch this,
 * re-read manifest state, and retry from the read.
 *
 * Surfacing as a typed error (rather than a result discriminator) is
 * deliberate: `performManifestCidRewrite` returns a result only on
 * happy / partial-resume paths. An unrecoverable CAS conflict is a
 * fault that must short-circuit the orchestrator and bubble to the
 * worker's outer retry loop.
 */
export class ManifestCidRewriteCasError extends Error {
  readonly __manifestCidRewriteCasError = true as const;
  /**
   * The raw `reason` propagated up from `ManifestCas.update`.
   * `'cas-mismatch'` here always refers to the "observed CID is
   * neither prev nor new" case; the idempotency skip is intercepted
   * inside step 2 and never throws.
   */
  readonly casReason:
    | 'cas-mismatch'
    | 'not-found'
    | 'concurrent-modification'
    /** Audit #333 H7 — surfaced when ManifestCas's wired verifier
     *  detected the entry's `rootHash` label does not match its
     *  recomputed content. The worker treats this the same as a hard
     *  CAS failure (bubble to outer retry); the new code preserves the
     *  structured reason for triage. */
    | 'integrity-failed';
  /**
   * The actually-observed `contentHash` when `casReason ===
   * 'cas-mismatch'`. Useful for the worker's retry path.
   */
  readonly observedCid?: ContentHash;

  constructor(
    casReason:
      | 'cas-mismatch'
      | 'not-found'
      | 'concurrent-modification'
      | 'integrity-failed',
    observedCid?: ContentHash,
  ) {
    super(`manifest CID rewrite CAS failure: ${casReason}`);
    this.name = 'ManifestCidRewriteCasError';
    this.casReason = casReason;
    this.observedCid = observedCid;
  }
}

/**
 * Module-scoped per-`(addr, tokenId)` mutex used by
 * {@link performManifestCidRewrite}.
 *
 * **Steelman fix (Wave 3) — concurrent-pass serialization.** Without an
 * outer mutex, two worker passes for the SAME finalization-queue entry
 * can BOTH pass the `step1Pool.isProofAttached === false` probe before
 * either has called `attachProof`. They then race into
 * `step2ManifestCidRewrite` where exactly one CAS succeeds; the loser
 * surfaces a `ManifestCidRewriteCasError` UP TO the worker's outer
 * retry loop. Operator dashboards then see what looks like a real
 * concurrent-modification conflict, when in fact it's two passes of the
 * SAME wallet's worker chasing the same queue entry — false-alarm noise.
 *
 * The mutex is keyed by `(addr, tokenId)` (not just `tokenId`) because
 * the same `tokenId` MAY appear under different wallet addresses in the
 * finalization queue (the worker pool is wallet-scoped per address).
 * `bounded-hold` strategy with a generous timeout (60 s) is correct
 * here — finalization writes are bounded by storage IO; if any single
 * step exceeds the bound, releasing the lock and surfacing the timeout
 * is preferable to an indefinite hang.
 *
 * **Per-process scope is correct.** Multiple Sphere instances in the
 * same process each import their own copy of this module bundle (no
 * shared state); two processes opening the same OrbitDB store rely on
 * OrbitDB's CAS for cross-process serialization (which is exactly what
 * step 2's CAS already provides). The in-process mutex addresses the
 * common case: two worker passes inside the same Sphere instance.
 *
 * @internal
 */
const moduleMutex = new PerTokenMutex();

/**
 * Composite key the {@link moduleMutex} is keyed under. The mutex
 * accepts a single string; we synthesise one from `(addr, tokenId)` so
 * concurrent rewrites of the same `tokenId` under different wallet
 * addresses (the worker pool runs per-address) don't serialize
 * unnecessarily.
 *
 * Uses a delimiter that cannot appear in either component (newline) so
 * the key is unambiguous: a `tokenId` may contain a colon but never a
 * literal newline.
 *
 * @internal
 */
function makeMutexKey(addr: string, tokenId: string): string {
  return `${addr}\n${tokenId}`;
}

/**
 * Bounded-hold timeout for the per-`(addr, tokenId)` mutex around
 * {@link performManifestCidRewrite}. 60 s is generous for a 4-step
 * storage IO sequence; if any single step exceeds it, releasing the
 * lock so the next worker can retry is preferable to letting the
 * worker pool block indefinitely on a stuck step.
 *
 * @internal
 */
const REWRITE_MUTEX_TIMEOUT_MS = 60_000;

/**
 * Run the §5.5 step 5 4-step write sequence in order, serialized per
 * `(addr, tokenId)` via {@link moduleMutex}. Each step is separately
 * exported (above) so fault-injection tests can interpose at any
 * boundary; this function is the production entry point.
 *
 * **Crash recovery semantics** (W25): if a crash interrupts between
 * any two steps, the queue entry is still present on restart, the
 * caller's outer worker loop calls this function again, and each step
 * detects "already applied" via the corresponding `is*` adapter
 * method — converging to the same final state without duplicate
 * writes.
 *
 * **Concurrent-pass serialization** (steelman Wave 3): two concurrent
 * worker passes for the same `(addr, tokenId)` are now serialized by
 * the module-scoped mutex. The first pass executes the 4-step
 * sequence; the second pass blocks until the first releases the lock,
 * then re-runs each step's idempotency probe — which detects "already
 * applied" and returns the appropriate `partial-stepN-resumed` /
 * `noop` discriminator WITHOUT producing a `ManifestCidRewriteCasError`
 * or the `lost-concurrent-race` outcome.
 *
 * If a CAS conflict still surfaces under the mutex (e.g. an external
 * writer ran between the two passes), the orchestrator translates it
 * into the `lost-concurrent-race` discriminator IFF the observed CID
 * matches the in-flight `newCid` — otherwise the conflict is a real
 * external-modification fault and bubbles as
 * `ManifestCidRewriteCasError`. This keeps operator-dashboard alerts
 * focused on TRUE conflicts.
 *
 * **Step ordering is normative** — reordering breaks crash safety.
 *
 * @throws {@link ManifestCidRewriteCasError} on unrecoverable step-2
 *   CAS failure (observed CID is neither `previousCid` nor `newCid`,
 *   AND the conflict was NOT a same-pass concurrent-race coalescable
 *   into the `lost-concurrent-race` outcome). Caller is expected to
 *   re-read state and retry.
 */
export async function performManifestCidRewrite(
  ctx: ManifestCidRewriteContext,
): Promise<ManifestCidRewriteResult> {
  const key = makeMutexKey(ctx.addr, ctx.tokenId);
  return moduleMutex.acquire(
    key,
    () => runManifestCidRewriteSteps(ctx),
    {
      strategy: 'bounded-hold',
      timeoutMs: REWRITE_MUTEX_TIMEOUT_MS,
    },
  );
}

/**
 * Inner step runner — invoked under the module mutex by
 * {@link performManifestCidRewrite}. Exposed as a separate function so
 * the mutex acquire / release boundary stays a single line and the
 * step orchestration logic remains a flat sequence (easier to reason
 * about under crash injection).
 *
 * @internal
 */
async function runManifestCidRewriteSteps(
  ctx: ManifestCidRewriteContext,
): Promise<ManifestCidRewriteResult> {
  const wroteStep1 = await step1Pool(ctx);
  let wroteStep2: boolean;
  try {
    wroteStep2 = await step2ManifestCidRewrite(ctx);
  } catch (cause) {
    // **Lost-race vs real CAS conflict (steelman Wave 3).** Inside the
    // same process, the module mutex prevents concurrent passes from
    // racing, so a CAS error here MUST come from an external writer
    // (different process / different Sphere instance) OR from a
    // custom `ManifestCas` that doesn't perform the in-process
    // idempotency skip on `observed === newCid`.
    //
    // Sub-cases:
    //
    //   1. Observed CID matches the in-flight `newCid` AND step 1
    //      reported skip → another writer already applied steps 1 and
    //      2. Surface as `lost-concurrent-race` so the worker
    //      dashboard treats this as benign rather than a real
    //      conflict alert. Note: the canonical `ManifestCas`
    //      already collapses this case to a `false` return inside
    //      `step2ManifestCidRewrite`, so this branch fires only
    //      when an alternative CAS implementation throws on
    //      `observed === newCid`.
    //   2. Anything else → real conflict, re-throw the
    //      `ManifestCidRewriteCasError` for the worker's retry loop.
    if (
      !wroteStep1 &&
      cause instanceof ManifestCidRewriteCasError &&
      cause.casReason === 'cas-mismatch' &&
      cause.observedCid === ctx.newCid
    ) {
      return { result: 'lost-concurrent-race' };
    }
    throw cause;
  }
  const wroteStep3 = await step3Tombstone(ctx);
  const wroteStep4 = await step4RemoveQueueEntry(ctx);

  // Discriminate the resume boundary from the per-step "wrote real
  // bytes" booleans. A step that returned `false` because of an
  // idempotency skip implies a prior worker pass already applied it.
  // The transition point is the FIRST step that issued a real write.
  if (wroteStep1) {
    return { result: 'ok' };
  }
  if (wroteStep2) {
    return { result: 'partial-step1-resumed' };
  }
  if (wroteStep3) {
    return { result: 'partial-step2-resumed' };
  }
  if (wroteStep4) {
    return { result: 'partial-step3-resumed' };
  }
  // No step wrote — every step was already applied. The previous
  // worker pass finished cleanly; this pass is a pure replay.
  return { result: 'noop' };
}

/**
 * Test-only utility — returns the module-scoped mutex so concurrent-
 * race tests can probe `isLocked(key)` between mutex steps. Production
 * code must NEVER call this; the mutex is intentionally module-private.
 *
 * @internal
 */
export function __getMutexForTests(): PerTokenMutex {
  return moduleMutex;
}
