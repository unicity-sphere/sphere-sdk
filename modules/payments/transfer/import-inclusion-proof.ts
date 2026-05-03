/**
 * UXF Transfer — `importInclusionProof()` operator escape-hatch (T.5.D).
 *
 * Implements §6.3 verbatim — 10 sub-cases per
 * `docs/uxf/UXF-TRANSFER-PROTOCOL.md` "stuck-PENDING escape hatch":
 *
 *  1. tokenId not in pool / `_invalid` / `_audit` → `'no-such-token'`.
 *  2. tokenId is already `valid` → `'pending-still'` (idempotent).
 *  3. tokenId is `pending`, proof matches an outstanding queue entry's
 *     requestId → graft proof; transition `pending → valid` when the
 *     last outstanding requestId resolves (or `pending → unspendable`
 *     if isSpent re-check returns true — out-of-scope here, surfaces
 *     via the caller's downstream re-evaluation).
 *  4a. tokenId is `pending`, proof matches a `completedRequestIds`
 *      entry → `'pending-still'` (already attached previously).
 *  4b. tokenId is `pending`, proof matches no outstanding OR completed
 *      requestId → `'requestid-mismatch'`.
 *  5. tokenId in `_invalid` AND `allowInvalidOverride === true` AND
 *     EXACTLY ONE hard-failed queue entry matches → MOVE to active pool
 *     with `manifest.status='valid'`. Operator-explicit reversal of the
 *     §5.6 monotonicity invariant.
 *  6. tokenId in `_invalid` AND `allowInvalidOverride === true` AND
 *     MULTIPLE hard-failed queue entries (chain-mode case) → MOVE to
 *     active pool with `manifest.status='pending'` and re-queue the
 *     K-1 remaining entries with `submittedAt = now`.
 *  7. tokenId in `_invalid` AND no override flag → `'tokenId-in-invalid'`.
 *  8. proof verify returns `PATH_NOT_INCLUDED` → `'proof-not-anchored'`.
 *  9. proof verify returns `PATH_INVALID` / `NOT_AUTHENTICATED` →
 *     `'proof-trustbase-failed'`.
 *
 * **Operator override audit trail (W30 / W31 / N4)**. Cases 5 and 6
 * are the only paths that breach the §5.6 monotonicity invariant; on
 * success, they:
 *   - stamp `overrideApplied: true`, `overrideAppliedAt: now`,
 *     `overrideAppliedBy: operatorPubkey?` on the manifest entry — the
 *     pair survives every future CRDT merge (set-OR boolean,
 *     max-merge timestamp, lex-min pubkey on divergence), so a wallet
 *     that has performed the override cannot be silently reverted by
 *     a stale replica's higher Lamport.
 *   - emit `transfer:override-applied` exactly once per success with
 *     `transition: 'invalid→valid' | 'invalid→pending'`, the previous
 *     {@link DispositionReason}, and the audit pair.
 *
 * The cascade walker (T.5.B.5) is NOT invoked here — `revalidate-cascaded.ts`
 * (T.5.D) is the consumer of the cascade walker and is invoked SEPARATELY
 * by the operator after this function returns. Per spec §6.1.1 the
 * SDK does not auto-cascade-reverse on parent override; the operator
 * decides whether to revalidate cascaded children.
 *
 * **Pure-ish API**. Every external dependency is injected; the module
 * holds NO module-level state. Production wires the module to the live
 * manifest store / disposition storage / finalization queue / oracle
 * verify path; tests inject in-memory fakes.
 *
 * Spec references:
 *  - §5.5      Per-token finalization (queue ↔ proof attach)
 *  - §5.6      Monotonicity invariant (active state cannot regress to
 *              `_invalid`; the override is the only legal breach)
 *  - §6.1.1    Cascade rule (the cascade walker re-validation is
 *              SEPARATE — see `revalidate-cascaded.ts`)
 *  - §6.3      Stuck-PENDING escape hatch (the 10 sub-cases above)
 *  - W30 / W31 / N4   Operator override audit trail
 *
 * @packageDocumentation
 */

import type { ContentHash } from '../../../uxf/types';
import { contentHash } from '../../../uxf/types';
import type {
  DispositionReason,
} from '../../../types/disposition';
import type {
  AuditEntry,
  InvalidEntry,
} from '../../../types/disposition';
import type {
  SphereEventMap,
  SphereEventType,
} from '../../../types';
import type { TokenManifestEntry } from '../../../profile/token-manifest';
import type { ManifestStore } from '../../../profile/manifest-store';
import {
  auditKeyFor,
  invalidKeyFor,
  type DispositionPerEntryStorage,
} from '../../../profile/disposition-writer';
import {
  PerTokenMutex,
  type PerTokenMutexStrategy,
} from '../../../profile/per-token-mutex';
import type { ProofVerifyStatus } from './proof-verifier';

// =============================================================================
// 1. Public types — proof shape + queue-entry abstractions
// =============================================================================

/**
 * Operator-supplied proof descriptor. The module verifies this against
 * the local trust base via the injected {@link ProofVerifier} before
 * applying it to local state.
 *
 * The shape is intentionally narrow — the module does NOT decode CBOR.
 * Callers (the wallet's import-proof entry point) decode the operator's
 * out-of-band proof bytes upstream and project to this struct.
 */
export interface ImportableInclusionProof {
  /**
   * The aggregator commitment requestId this proof anchors. Hex-encoded
   * (matches the canonical §5.5 / §6.1 request-id encoding). The module
   * uses this as the routing key against the finalization queue +
   * outbox `outstandingRequestIds` / `completedRequestIds` sets.
   */
  readonly requestId: string;
  /**
   * Proof's transactionHash imprint hex (68 chars). Used together with
   * `authenticator` for the §6.3 most-recent-proof / single-spend
   * forbidden-case checks (those checks live in T.5.B/T.5.C; this
   * module's responsibility is only to expose them via the projected
   * triple).
   */
  readonly transactionHash: string;
  /**
   * Proof authenticator hex. Used for §6.3 same-value-vs-different-value
   * resolution. The full proof bytes for trust-base verification flow
   * through `verifyProof`.
   */
  readonly authenticator: string;
  /**
   * The opaque proof descriptor handed to the trust-base verifier. The
   * module never inspects this field — it is forwarded to the
   * {@link ProofVerifier} unchanged.
   */
  readonly proof: unknown;
}

/**
 * Trust-base verifier contract. Returns the granular proof status (per
 * `proof-verifier.ts`'s {@link ProofVerifyStatus}). The wrapper does NOT
 * map `PATH_NOT_INCLUDED` to a hard-failure here — the import-proof
 * routing distinguishes the two via cases 8 and 9.
 */
export type ProofVerifier = (
  proof: ImportableInclusionProof,
) => Promise<ProofVerifyStatus>;

/**
 * Minimal projection of a queue entry that this module needs.
 *
 * Production wires this to {@link FinalizationQueue.list}'s output;
 * tests inject in-memory entries directly.
 */
export interface ImportProofQueueEntry {
  readonly entryId: string;
  readonly tokenId: string;
  readonly commitmentRequestId: string;
  readonly transactionHash: string;
  readonly authenticator: string;
  readonly txIndex: number;
  /**
   * `'hard-fail'` for entries that landed in `_invalid` after a hard
   * failure; `'pending'` / `'submitting'` / `'polling'` for pending
   * entries; `'attached'` for entries waiting on the §5.5 step 4
   * removal.
   */
  readonly status:
    | 'pending'
    | 'submitting'
    | 'polling'
    | 'attached'
    | 'hard-fail';
}

/**
 * Minimal scanner used to enumerate queue entries for a tokenId. The
 * importer needs ALL relevant entries — both pending and hard-failed —
 * to disambiguate cases 3 / 4a / 4b vs 5 / 6.
 */
export interface ImportProofQueueScanner {
  /**
   * Return every queue entry (live OR hard-fail-tombstoned) that
   * references `tokenId` under `addr`. Implementations MAY reuse the
   * recipient `FinalizationQueue.lookupByTokenId` for live entries and
   * a parallel scan over hard-fail tombstones for the rest. Order is
   * implementation-defined; the importer sorts by `txIndex` when it
   * needs determinism (case 6 K-1 re-queue).
   */
  lookupByTokenId(
    addr: string,
    tokenId: string,
  ): Promise<ReadonlyArray<ImportProofQueueEntry>>;
}

/**
 * Minimal "drive the proof through the §5.5 step 5 4-step write
 * sequence" callback. Used by case 3 (pending graft path).
 *
 * Production wires this to `manifest-cid-rewrite.ts`'s
 * `performManifestCidRewrite`; tests inject a simple `() => Promise<void>`
 * that records the call.
 *
 * The graft is the responsibility of the caller's broader integration
 * (it requires pool-write, tombstone, queue-removal adapters that
 * outlive this module). The importer only KICKS it OFF — once the
 * graft completes, the §5.5 step 9 re-evaluator picks up and decides
 * whether the token transitions to `valid`. The importer's RESULT
 * therefore reports `'pending-still'` if more outstanding requestIds
 * remain, or `'pending→valid'` if this was the last one (the caller's
 * graft callback has already done the pool/manifest writes).
 */
export interface ImportProofGraftCallback {
  /**
   * Attach the supplied proof to the active pool for `tokenId` /
   * `requestId`. Called from case 3 only.
   *
   * The callback MUST verify the proof against trustBase BEFORE
   * persisting (this module already verified upstream — the duplicate
   * check is defense-in-depth) and MUST NOT touch entries in
   * `_invalid`. It should return after the §5.5 step 5 4-step write
   * sequence (pool write, manifest CID rewrite, tombstone, queue
   * removal) has completed.
   */
  graft(
    addr: string,
    tokenId: string,
    proof: ImportableInclusionProof,
    queueEntry: ImportProofQueueEntry,
  ): Promise<void>;
}

/**
 * Minimal "promote `_invalid` record back to active pool + re-queue
 * remaining entries" callback. Used by case 5 (single-entry override)
 * and case 6 (K-1 re-queue).
 *
 * Production wires this to a thin coordinator that knows how to:
 *   1. Read the `_invalid` record for `(tokenId, observedTokenContentHash)`.
 *   2. Stamp `overrideApplied`/`overrideAppliedAt`/`overrideAppliedBy`
 *      via the manifest store + the audit fields.
 *   3. For case 6: re-create K-1 finalization queue entries with fresh
 *      `submittedAt`.
 *
 * Tests inject an in-memory recorder.
 */
export interface ImportProofOverrideCallback {
  /**
   * Apply the operator override — flip the `_invalid` record's
   * pointer + write a fresh manifest entry that brings the token back
   * into the active pool.
   *
   * @param transition `'invalid→valid'` for case 5; `'invalid→pending'`
   *                   for case 6.
   * @param requeueEntries For case 6, the K-1 entries the worker should
   *                       re-queue with fresh `submittedAt`. Empty for
   *                       case 5.
   */
  applyOverride(args: {
    readonly addr: string;
    readonly tokenId: string;
    readonly transition: 'invalid→valid' | 'invalid→pending';
    readonly previousReason: DispositionReason;
    readonly previousInvalidEntry: InvalidEntry;
    readonly proof: ImportableInclusionProof;
    readonly resolvingQueueEntry: ImportProofQueueEntry;
    readonly requeueEntries: ReadonlyArray<ImportProofQueueEntry>;
    readonly now: number;
    readonly operatorPubkey?: string;
  }): Promise<void>;
}

/**
 * Lightweight event-emit shim — narrow to the exactly-one event this
 * module emits (`transfer:override-applied`). The Sphere event bus
 * implements the broader surface; tests inject a recorder.
 */
export type ImportProofEventEmitter = <T extends SphereEventType>(
  type: T,
  data: SphereEventMap[T],
) => void;

// =============================================================================
// 2. Result types — discriminated outcome
// =============================================================================

/**
 * Discriminated outcome of a single `importInclusionProof` invocation.
 *
 * The `ok: true` branch carries a `transition` that mirrors the spec's
 * §6.3 case-language so the operator UI can surface the right copy.
 *
 * The `ok: false` branch carries one of the six failure reasons from
 * §6.3 — the operator UI maps each to a distinct help message.
 */
export type ImportProofResult =
  | {
      readonly ok: true;
      readonly transition:
        | 'pending-still'
        | 'pending→valid'
        | 'pending→unspendable'
        | 'invalid→valid'
        | 'invalid→pending';
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'no-such-token'
        | 'tokenId-already-valid'
        | 'tokenId-in-invalid'
        | 'proof-trustbase-failed'
        | 'proof-not-anchored'
        | 'requestid-mismatch'
        // (#155) Operator-supplied proof matched the queue entry by
        // requestId but its `transactionHash` and/or `authenticator`
        // disagree with the queue entry's bound triple. An attacker
        // who knows the victim's tokenId + a hard-failed requestId
        // could otherwise paste any aggregator-anchored proof sharing
        // that requestId and flip `_invalid → valid`. The §6.3
        // most-recent-proof / single-spend forbidden-case checks
        // require the proof's full triple to match the queue entry
        // verbatim — see {@link ImportableInclusionProof}.
        | 'proof-binding-mismatch'
        // (#165) `manifest.status === 'invalid'` but no corresponding
        // `_invalid` record exists. The disposition writer's normal
        // routing always pairs the manifest entry with an `_invalid`
        // record; a missing record is structurally inconsistent and
        // would force the importer to synthesize provenance fields
        // (bundleCid, senderTransportPubkey) as empty strings — the
        // audit trail loses forensic value. Operators that explicitly
        // accept the synthesized provenance pass
        // `allowSyntheticInvalidEntry: true` to override.
        | 'invalid-record-missing'
        // (Wave 3 steelman) Operator supplied a tokenId that is not the
        // canonical 64-char-hex form. Combined with `_findInvalidEntry`'s
        // sentinel-fallback content hash for non-hex tokenIds, an
        // attacker shaping a tokenId like `"../"` could probe `_invalid`
        // storage at deterministic keys and collide with future records
        // on backends that don't validate key shape. The importer
        // refuses non-canonical tokenIds at entry — well-formed wallet
        // calls always pass 64-hex.
        | 'invalid-tokenid'
        // (Wave 3 steelman) Operator's queue scan returned more than one
        // entry with the same `commitmentRequestId` for this tokenId.
        // Production code paths cannot produce duplicates under
        // normal operation; either a writer bug or a CRDT
        // concurrent-add has produced an ambiguous state. Surfacing a
        // distinct reason routes the operator to manual triage rather
        // than silently picking `matching[0]` (which would risk
        // applying the proof against the wrong queue entry).
        | 'requestid-ambiguous';
    };

// =============================================================================
// 3. Construction options — Importer
// =============================================================================

/**
 * Construction options for {@link InclusionProofImporter}.
 */
export interface ImportInclusionProofOptions {
  /** Active-pool manifest store reader. */
  readonly manifestStore: Pick<ManifestStore, 'readEntry'>;
  /** Per-entry-key storage for `_invalid` / `_audit` records. */
  readonly dispositionStorage: DispositionPerEntryStorage;
  /** Finalization queue scanner. */
  readonly queueScanner: ImportProofQueueScanner;
  /** Trust-base verifier. */
  readonly verifyProof: ProofVerifier;
  /** Pending-graft callback (case 3). */
  readonly graftCallback: ImportProofGraftCallback;
  /** Operator-override callback (cases 5 / 6). */
  readonly overrideCallback: ImportProofOverrideCallback;
  /** Event emitter — only `transfer:override-applied` is emitted. */
  readonly emit: ImportProofEventEmitter;
  /** Wall-clock supplier. Default `Date.now`. Tests inject a deterministic clock. */
  readonly now?: () => number;
  /**
   * Per-tokenId mutex used to serialize concurrent
   * `importInclusionProof()` invocations targeting the same `tokenId`.
   * Without this, two operator overrides on the same tokenId race —
   * both read state, both pass the case-5/6 split, both call
   * `applyOverride`, corrupting the manifest's audit trail OR
   * re-queuing duplicate entries.
   *
   * Defaults to a per-instance {@link PerTokenMutex} if omitted —
   * production callers SHOULD share a single instance with the
   * recipient/sender finalization workers so all paths that touch a
   * tokenId serialize against the same mutex (matches the T.5.B / T.5.C
   * wiring).
   */
  readonly perTokenMutex?: PerTokenMutex;
  /**
   * Strategy passed to `perTokenMutex.acquire`. Default
   * `'rpc-release'` (#153 steelman fix). The CAS strategy is the
   * no-serialization pass-through — concurrent
   * `importInclusionProof` calls on the same `tokenId` race against
   * each other in the read-decide phase, and ManifestCas inside the
   * override callback only protects the write-phase. Two operators
   * who simultaneously hit the override path would both pass case-5/6
   * split, both invoke `applyOverride`, and corrupt the audit trail
   * OR re-queue duplicate K-1 entries. The default is therefore
   * `'rpc-release'` which serializes the entire read-decide-write
   * sequence per `tokenId`. Callers that explicitly opt out (e.g.
   * because they coordinate exclusion at a higher layer) can pass
   * `'cas'` or `'bounded-hold'`.
   */
  readonly perTokenMutexStrategy?: PerTokenMutexStrategy;
}

/**
 * Optional per-call options.
 */
export interface ImportInclusionProofCallOptions {
  /**
   * Required `true` to flip a token from `_invalid` back to the active
   * pool. Defaults to `false` — silent default would breach §5.6
   * monotonicity invariantly. The operator UI MUST surface the choice.
   */
  readonly allowInvalidOverride?: boolean;
  /**
   * (#165) When `manifest.status === 'invalid'` but no `_invalid`
   * record is found, the importer would otherwise synthesize a minimal
   * {@link InvalidEntry} from the manifest fields — this coerces
   * `bundleCid` and `senderTransportPubkey` to empty strings and the
   * audit trail loses forensic value. Default `false` returns
   * `'invalid-record-missing'` instead so the operator can investigate
   * the disposition writer's routing. Set `true` only when the
   * operator has out-of-band reason to accept the synthesized
   * provenance fields (e.g. a corrupted disposition KV recovered from
   * backup).
   */
  readonly allowSyntheticInvalidEntry?: boolean;
  /**
   * Operator pubkey (hex) at the call site. Stamped into the audit
   * trail (`overrideAppliedBy`). Optional — callers that don't have a
   * pubkey leave the field absent; the audit row records the override
   * timestamp without an attribution.
   */
  readonly operatorPubkey?: string;
  /**
   * Wall-clock override. Tests inject a deterministic timestamp; in
   * production the constructor's `now` is used. When BOTH are supplied,
   * the per-call value wins.
   */
  readonly currentTime?: number;
}

// =============================================================================
// 3.5 Constants
// =============================================================================

/**
 * Canonical lowercase 64-char-hex regex for a tokenId — the spec form
 * (BYTE_FIELDS) all wallet code paths produce. Used at the importer entry
 * point to reject malformed operator input (steelman finding, Wave 3).
 *
 * Why both cases match: the importer also accepts upper-case hex (case-
 * insensitive comparison everywhere downstream — see `hexEqualsIgnoreCase`),
 * so the entry-point check is permissive on case but strict on shape.
 */
const CANONICAL_TOKEN_ID_RE = /^[0-9a-f]{64}$/i;

// =============================================================================
// 4. InclusionProofImporter
// =============================================================================

/**
 * Routes a single operator `importInclusionProof` invocation through the
 * 10 §6.3 sub-cases. Holds NO module-level state — every external
 * dependency is injected via {@link ImportInclusionProofOptions}.
 */
export class InclusionProofImporter {
  private readonly opts: ImportInclusionProofOptions;
  private readonly defaultNow: () => number;
  private readonly perTokenMutex: PerTokenMutex;
  private readonly perTokenMutexStrategy: PerTokenMutexStrategy;

  constructor(options: ImportInclusionProofOptions) {
    this.opts = options;
    this.defaultNow = options.now ?? (() => Date.now());
    // Default to a fresh per-instance mutex so callers that don't
    // share one with the finalization workers still get serialization
    // for concurrent imports against the same instance. Production
    // wiring SHOULD inject the same `PerTokenMutex` used by T.5.B /
    // T.5.C so all paths touching a tokenId serialize together.
    this.perTokenMutex = options.perTokenMutex ?? new PerTokenMutex();
    // (#153) Default strategy is 'rpc-release' so callers who don't
    // explicitly choose get real per-tokenId serialization. The
    // previous 'cas' default was a no-serialization pass-through and
    // T.5.D's "serialize concurrent imports" promise didn't deliver
    // — see the concurrency test that proves it.
    this.perTokenMutexStrategy = options.perTokenMutexStrategy ?? 'rpc-release';
  }

  /**
   * Run the §6.3 case-walker for one `(addr, tokenId, proof)` triple.
   *
   * The function NEVER throws on routing decisions — every case
   * resolves to a typed result. Underlying I/O failures (disposition
   * storage read errors, etc.) DO propagate so the operator console
   * can surface them.
   */
  async importInclusionProof(
    addr: string,
    tokenId: string,
    proof: ImportableInclusionProof,
    callOptions: ImportInclusionProofCallOptions = {},
  ): Promise<ImportProofResult> {
    // (Wave 3 steelman) Reject non-canonical tokenIds at the very entry
    // point — BEFORE any storage probe (manifest read, _invalid read,
    // _audit read). Why this matters:
    //
    //   `_findInvalidEntry` falls back to a sentinel content hash (32
    //   bytes of zero hex) when the manifest does not surface an
    //   observed hash. For canonical tokenIds (64-hex), this is benign
    //   because the keys are well-formed and the sentinel produces a
    //   deterministic miss. But for an attacker-shaped tokenId like
    //   `"../"`, the composed key
    //   `${addr}.invalid.../.${'00'.repeat(32)}` becomes attacker-
    //   controlled and may collide with other records on a storage
    //   backend that doesn't enforce key shape — yielding a fetched
    //   record that the importer would then mis-apply via override.
    //
    // Canonical wallet code never produces non-hex tokenIds; the guard
    // is engineering-defense against operator scripts forwarding
    // unsanitized input.
    if (typeof tokenId !== 'string' || !CANONICAL_TOKEN_ID_RE.test(tokenId)) {
      return { ok: false, reason: 'invalid-tokenid' };
    }
    // T.5.D steelman post-cutover (#153): serialize the entire
    // read-decide-write sequence under the per-tokenId mutex. Without
    // this, two concurrent operator overrides on the same tokenId
    // race — both read state, both pass case-5/6 split, both call
    // `applyOverride`, corrupting the manifest's audit trail OR
    // re-queuing duplicate entries. The default strategy is
    // `'rpc-release'` which provides per-tokenId serialization; CAS
    // is opt-in for callers who coordinate exclusion at a higher
    // layer.
    return this.perTokenMutex.acquire(
      tokenId,
      () => this._importInclusionProofUnderMutex(addr, tokenId, proof, callOptions),
      { strategy: this.perTokenMutexStrategy },
    );
  }

  /**
   * @internal
   *
   * The full §6.3 case-walker, executed under the per-tokenId mutex
   * (see {@link importInclusionProof}). All sub-cases (1, 2, 3, 4a, 4b,
   * 5, 6, 7, 8, 9) read-decide-write inside this body so that two
   * concurrent invocations on the same `tokenId` cannot interleave
   * their decisions.
   */
  private async _importInclusionProofUnderMutex(
    addr: string,
    tokenId: string,
    proof: ImportableInclusionProof,
    callOptions: ImportInclusionProofCallOptions,
  ): Promise<ImportProofResult> {
    const allowInvalidOverride = callOptions.allowInvalidOverride === true;
    const now = callOptions.currentTime ?? this.defaultNow();

    // -----------------------------------------------------------------------
    // CASE 1: token unknown — not in manifest, not in `_invalid`, not in
    // `_audit`. We probe each location; the FIRST hit decides the routing
    // (active pool first → invalid → audit → not-found).
    // -----------------------------------------------------------------------
    const manifestEntry = await this.opts.manifestStore.readEntry(addr, tokenId);
    if (manifestEntry === undefined) {
      const invalidHit = await this._findInvalidEntry(addr, tokenId);
      if (invalidHit === null) {
        const auditHit = await this._hasAuditEntry(addr, tokenId);
        if (!auditHit) {
          return { ok: false, reason: 'no-such-token' };
        }
        // _audit record exists but no manifest / no invalid — there's
        // nothing actionable here (audit is "structurally valid but
        // unspendable by us"). Per §6.3 case 1 this collapses to
        // `'no-such-token'` because the proof has no destination.
        return { ok: false, reason: 'no-such-token' };
      }

      // Token is in `_invalid`. Cases 5/6/7/8/9 apply.
      return this._handleInvalidPath({
        addr,
        tokenId,
        proof,
        invalidEntry: invalidHit,
        allowInvalidOverride,
        now,
        operatorPubkey: callOptions.operatorPubkey,
      });
    }

    // -----------------------------------------------------------------------
    // CASE 2: token already valid — idempotent no-op.
    // -----------------------------------------------------------------------
    if (manifestEntry.status === 'valid') {
      return { ok: true, transition: 'pending-still' };
    }

    // Manifest entry exists but is not `valid`. Per §6.3 cases 3/4a/4b
    // apply for `pending`. For `conflicting` and `invalid` (the latter
    // reachable when the disposition writer chose to keep the entry in
    // the active pool with `status='invalid'` rather than route to
    // `_invalid` — round-trip safety): we treat them like the `_invalid`
    // bucket because the operator semantics are identical (the §5.6
    // monotonicity invariant has been broken).
    if (manifestEntry.status === 'invalid') {
      // The manifest carries `status='invalid'` but the entry is in the
      // active pool. Mirror the `_invalid`-bucket routing — the operator
      // can flip back via override.
      const invalidEntry = await this._findInvalidEntry(addr, tokenId);
      if (invalidEntry === null) {
        // (#165) `manifest.status === 'invalid'` without a paired
        // `_invalid` record is structurally inconsistent — the
        // disposition writer's normal routing always pairs the two.
        // Synthesizing here would coerce the bundleCid /
        // senderTransportPubkey provenance fields to empty strings,
        // gutting the audit trail. An attacker who can corrupt a
        // single manifest entry to `status='invalid'` (without a
        // corresponding `_invalid` record) and submit a stale proof
        // could otherwise launder the override.
        //
        // Refuse by default; require the operator to explicitly opt in
        // via `allowSyntheticInvalidEntry: true` if they have
        // out-of-band reason to accept the synthesized provenance.
        if (callOptions.allowSyntheticInvalidEntry !== true) {
          return { ok: false, reason: 'invalid-record-missing' };
        }
        const synthEntry = this._synthesizeInvalidFromManifest(
          tokenId,
          manifestEntry,
        );
        return this._handleInvalidPath({
          addr,
          tokenId,
          proof,
          invalidEntry: synthEntry,
          allowInvalidOverride,
          now,
          operatorPubkey: callOptions.operatorPubkey,
        });
      }
      return this._handleInvalidPath({
        addr,
        tokenId,
        proof,
        invalidEntry,
        allowInvalidOverride,
        now,
        operatorPubkey: callOptions.operatorPubkey,
      });
    }

    // Pending / conflicting → cases 3 / 4a / 4b / 8 / 9.
    return this._handlePendingPath({ addr, tokenId, proof });
  }

  // ===========================================================================
  // Pending path — cases 3, 4a, 4b, 8, 9.
  // ===========================================================================

  /**
   * @internal
   *
   * Walk the active-pool finalization queue + completed set looking
   * for a match against `proof.requestId`. Apply cases 3 (graft), 4a
   * (idempotent already-attached), or 4b (no match). Cases 8 and 9
   * fire if the proof itself fails to verify against trustBase.
   */
  private async _handlePendingPath(args: {
    readonly addr: string;
    readonly tokenId: string;
    readonly proof: ImportableInclusionProof;
  }): Promise<ImportProofResult> {
    const { addr, tokenId, proof } = args;

    // Verify the proof up front. Cases 8 / 9 short-circuit before
    // touching local state. Per §6.3 the verify is BEFORE state
    // mutation — a bad proof leaves the wallet untouched.
    const verifyStatus = await this.opts.verifyProof(proof);
    if (verifyStatus === 'PATH_NOT_INCLUDED') {
      return { ok: false, reason: 'proof-not-anchored' }; // case 8
    }
    if (
      verifyStatus === 'PATH_INVALID' ||
      verifyStatus === 'NOT_AUTHENTICATED' ||
      verifyStatus === 'THROWN'
    ) {
      return { ok: false, reason: 'proof-trustbase-failed' }; // case 9
    }
    // Status is 'OK'.

    // Look up live + completed queue entries for this tokenId.
    const allEntries = await this.opts.queueScanner.lookupByTokenId(addr, tokenId);
    const matching = allEntries.filter(
      (e) => e.commitmentRequestId === proof.requestId,
    );
    if (matching.length === 0) {
      return { ok: false, reason: 'requestid-mismatch' }; // case 4b
    }

    // (Wave 3 steelman) Defensive ambiguity check. Production code paths
    // never produce two queue entries with the same
    // `(tokenId, commitmentRequestId)` — the finalization queue
    // de-duplicates on enqueue. But a writer bug or a CRDT
    // concurrent-add could surface duplicates; if so, picking
    // `matching[0]` arbitrarily would risk applying the proof to the
    // wrong entry (different transactionHash bound triple, different
    // status). Surfacing a distinct reason routes the operator to
    // manual triage rather than silently committing.
    if (matching.length > 1) {
      return { ok: false, reason: 'requestid-ambiguous' };
    }

    // Hit. Decide between case 4a (already attached — completed entry
    // present, OR `attached` lifecycle status — both indicate the proof
    // was already grafted) and case 3 (live outstanding entry — graft
    // the proof). The §5.5 lifecycle uses `'attached'` to mark the brief
    // window between step 1–3 completion and step 4 removal. Treat that
    // status as already-attached so a replay-after-crash doesn't
    // double-graft.
    const target = matching[0]!;

    // (#155) Bind the proof to the queue entry's full triple
    // (transactionHash + authenticator), not just the requestId. The
    // §6.3 most-recent-proof / single-spend forbidden-case checks
    // require this — see `ImportableInclusionProof.transactionHash` /
    // `.authenticator` JSDoc. An attacker who knows the victim's
    // tokenId + an outstanding requestId could otherwise paste any
    // aggregator-anchored proof sharing that requestId and graft a
    // different transaction onto the live queue entry.
    if (
      !hexEqualsIgnoreCase(proof.transactionHash, target.transactionHash) ||
      !hexEqualsIgnoreCase(proof.authenticator, target.authenticator)
    ) {
      return { ok: false, reason: 'proof-binding-mismatch' };
    }

    if (target.status === 'attached') {
      return { ok: true, transition: 'pending-still' }; // case 4a
    }
    if (target.status === 'hard-fail') {
      // Live queue contains a hard-fail entry for this tokenId. This
      // shouldn't be reachable in normal flow (hard-fail entries route
      // to `_invalid` via the disposition writer) but defensively we
      // treat it as a `requestid-mismatch` since the active-pool path
      // cannot recover from a hard-fail without the override flag.
      return { ok: false, reason: 'requestid-mismatch' };
    }

    // Case 3: drive the graft. The §5.5 step-5 4-step sequence is
    // owned by `manifest-cid-rewrite.ts` (T.5.B.0); we delegate via
    // the injected callback. After graft completes, decide whether
    // there are more outstanding requestIds — if so we report
    // `'pending-still'`; otherwise `'pending→valid'`. The graft
    // callback itself does NOT alter the manifest status; the §5.5
    // step 9 re-evaluator (T.5.C) is the authoritative path that
    // promotes `pending → valid` after every requestId resolves. So
    // even on the "last requestId" case we report optimistically;
    // the operator's UI re-reads the manifest to confirm.
    await this.opts.graftCallback.graft(addr, tokenId, proof, target);
    const remaining = allEntries.filter((e) => {
      if (e.commitmentRequestId === proof.requestId) return false;
      // Only count truly-outstanding entries — `attached` entries are
      // mid-flight rewrites that will resolve on the next worker pass.
      return e.status !== 'hard-fail';
    });
    if (remaining.length === 0) {
      return { ok: true, transition: 'pending→valid' };
    }
    return { ok: true, transition: 'pending-still' };
  }

  // ===========================================================================
  // Invalid path — cases 5, 6, 7, 8, 9.
  // ===========================================================================

  /**
   * @internal
   *
   * Drive cases 5 / 6 / 7 / 8 / 9 when the token is in `_invalid`
   * (or carries `manifest.status='invalid'` in the active pool).
   * Verification cases 8 / 9 short-circuit before touching state.
   * Case 7 short-circuits when the override flag is missing. Cases 5
   * and 6 mutate state via the injected override callback and emit
   * `transfer:override-applied`.
   */
  private async _handleInvalidPath(args: {
    readonly addr: string;
    readonly tokenId: string;
    readonly proof: ImportableInclusionProof;
    readonly invalidEntry: InvalidEntry;
    readonly allowInvalidOverride: boolean;
    readonly now: number;
    readonly operatorPubkey?: string;
  }): Promise<ImportProofResult> {
    const { addr, tokenId, proof, invalidEntry, allowInvalidOverride } = args;

    // Verify the proof up front. Cases 8 / 9 short-circuit before
    // touching local state — even when allowInvalidOverride is true,
    // a bad proof MUST NOT flip the entry back. (The aggregator's
    // anchored truth is the only path out of `_invalid`.)
    const verifyStatus = await this.opts.verifyProof(proof);
    if (verifyStatus === 'PATH_NOT_INCLUDED') {
      return { ok: false, reason: 'proof-not-anchored' }; // case 8
    }
    if (
      verifyStatus === 'PATH_INVALID' ||
      verifyStatus === 'NOT_AUTHENTICATED' ||
      verifyStatus === 'THROWN'
    ) {
      return { ok: false, reason: 'proof-trustbase-failed' }; // case 9
    }
    // Status is 'OK'.

    if (!allowInvalidOverride) {
      return { ok: false, reason: 'tokenId-in-invalid' }; // case 7
    }

    // Find every (hard-failed) queue entry that originally invalidated
    // this tokenId. Case 5 fires iff EXACTLY ONE matches the proof's
    // requestId; case 6 fires iff there are MULTIPLE (chain-mode) AND
    // the proof matches one of them.
    const allEntries = await this.opts.queueScanner.lookupByTokenId(addr, tokenId);
    const hardFailed = allEntries.filter((e) => e.status === 'hard-fail');
    const matching = hardFailed.filter(
      (e) => e.commitmentRequestId === proof.requestId,
    );
    if (matching.length === 0) {
      // The proof targets a different requestId than any of the
      // hard-failed entries. Per §6.3 we cannot apply the override
      // because we do not know what to flip.
      return { ok: false, reason: 'requestid-mismatch' };
    }

    // (Wave 3 steelman) Mirror the pending path's ambiguity guard. Two
    // hard-failed queue entries sharing
    // `(tokenId, commitmentRequestId)` would force an arbitrary
    // `matching[0]!` pick — and on the override path that risks
    // committing the case-3-K-1-re-queue or the `invalid→valid` flip
    // against the wrong entry. Refuse and let the operator triage.
    if (matching.length > 1) {
      return { ok: false, reason: 'requestid-ambiguous' };
    }

    const resolvingEntry = matching[0]!;

    // (#155) Bind the proof to the queue entry's full triple
    // (transactionHash + authenticator), not just the requestId. Per
    // §6.3 the most-recent-proof / single-spend forbidden-case checks
    // require the proof's full triple to match the queue entry
    // verbatim. Without this, an attacker who knows the victim's
    // tokenId + a hard-failed requestId could paste any aggregator-
    // anchored proof sharing that requestId and flip
    // `_invalid → valid` (case 5) or trigger a K-1 re-queue (case 6)
    // bound to a different transaction.
    if (
      !hexEqualsIgnoreCase(proof.transactionHash, resolvingEntry.transactionHash) ||
      !hexEqualsIgnoreCase(proof.authenticator, resolvingEntry.authenticator)
    ) {
      return { ok: false, reason: 'proof-binding-mismatch' };
    }

    // Case 5 vs case 6 split: count OTHER hard-failed entries that
    // still need a proof. If zero → case 5; if ≥ 1 → case 6 (chain
    // mode K-1 re-queue).
    const requeueEntries = hardFailed.filter(
      (e) => e.commitmentRequestId !== proof.requestId,
    );
    const transition: 'invalid→valid' | 'invalid→pending' =
      requeueEntries.length === 0 ? 'invalid→valid' : 'invalid→pending';

    await this.opts.overrideCallback.applyOverride({
      addr,
      tokenId,
      transition,
      previousReason: invalidEntry.reason,
      previousInvalidEntry: invalidEntry,
      proof,
      resolvingQueueEntry: resolvingEntry,
      requeueEntries,
      now: args.now,
      operatorPubkey: args.operatorPubkey,
    });

    // Emit the audit event AFTER applyOverride so a callback failure
    // does NOT generate a misleading event.
    this.opts.emit('transfer:override-applied', {
      tokenId,
      overrideAppliedAt: args.now,
      overrideAppliedBy: args.operatorPubkey,
      previousReason: invalidEntry.reason,
      transition,
    });

    return { ok: true, transition };
  }

  // ===========================================================================
  // Helpers — disposition lookups.
  // ===========================================================================

  /**
   * @internal
   *
   * Find the `_invalid` record for `(addr, tokenId)`. The per-entry
   * key includes the `observedTokenContentHash` disambiguator, so a
   * tokenId may have multiple records; we scan via prefix and return
   * the FIRST hit (the operator's `importInclusionProof` is keyed on
   * tokenId alone — multiple `_invalid` records for the same tokenId
   * are forensic evidence, but the override applies to the canonical
   * tokenId, not to a specific observed-content-hash).
   *
   * Returns `null` when no record exists.
   */
  private async _findInvalidEntry(
    addr: string,
    tokenId: string,
  ): Promise<InvalidEntry | null> {
    // Probe the canonical key first using the manifest entry's
    // `rootHash` if available — most cases will have exactly one
    // observed-content-hash. If that misses, fall back to a scan over
    // the prefix `${addr}.invalid.${tokenId}.`.
    //
    // The `DispositionPerEntryStorage` contract is read/write keyed —
    // it does NOT expose a prefix scanner. So the importer can only
    // reliably recover the record via the canonical key. The
    // production wiring of `DispositionPerEntryStorage` over the
    // OrbitDB key-value store carries the same opacity — the writer
    // never indexes records by `(tokenId)` alone, so an importer that
    // arrives without the observed-content-hash needs the manifest
    // store as the cross-reference.
    const manifestEntry = await this.opts.manifestStore.readEntry(addr, tokenId);
    const observedHash =
      manifestEntry?.rootHash ?? this._fallbackContentHash(tokenId);
    const key = invalidKeyFor(addr, tokenId, observedHash);
    const record = await this.opts.dispositionStorage.readRecord<InvalidEntry>(key);
    return record ?? null;
  }

  /**
   * @internal
   *
   * Quick check whether ANY `_audit` record exists for `(addr, tokenId)`.
   * Used by case 1 to disambiguate "token unknown" from "token in audit
   * (structurally valid, unspendable by us)" — both collapse to
   * `'no-such-token'` per §6.3 case 1, but the disambiguation lives
   * here so future spec changes can route differently.
   */
  private async _hasAuditEntry(
    addr: string,
    tokenId: string,
  ): Promise<boolean> {
    const fallbackHash = this._fallbackContentHash(tokenId);
    const key = auditKeyFor(addr, tokenId, fallbackHash);
    const record = await this.opts.dispositionStorage.readRecord<AuditEntry>(key);
    return record !== undefined;
  }

  /**
   * @internal
   *
   * Synthesize a minimal {@link InvalidEntry} from a manifest entry whose
   * `status === 'invalid'`. Used when the active-pool entry carries the
   * invalid status (per the disposition writer's routing exception)
   * but no separate `_invalid` record exists.
   */
  private _synthesizeInvalidFromManifest(
    tokenId: string,
    manifestEntry: TokenManifestEntry,
  ): InvalidEntry {
    const reason: DispositionReason =
      this._coerceDispositionReason(manifestEntry.invalidReason) ??
      'oracle-rejected';
    return {
      tokenId,
      observedTokenContentHash: manifestEntry.rootHash,
      reason,
      observedAt: this.defaultNow(),
      bundleCid: manifestEntry.bundleCid ?? '',
      senderTransportPubkey: manifestEntry.senderTransportPubkey ?? '',
    };
  }

  /**
   * @internal
   *
   * Defensive narrowing of `manifestEntry.invalidReason` (typed as
   * `string` per the canonical token-manifest module to avoid a
   * circular dep) to a {@link DispositionReason}. Returns `null` if
   * the field is missing or doesn't match the canonical enum.
   */
  private _coerceDispositionReason(
    raw: string | undefined,
  ): DispositionReason | null {
    if (raw === undefined) return null;
    const known: ReadonlyArray<DispositionReason> = [
      'structural',
      'predicate-eval',
      'auth-invalid',
      'continuity-broken',
      'proof-invalid',
      'proof-throw',
      'oracle-rejected',
      'belief-divergence',
      'client-error',
      'parent-rejected',
      'race-lost',
      'not-our-state',
      'off-record-spend',
      'gateway-fetch-failed',
    ];
    return (known as ReadonlyArray<string>).includes(raw)
      ? (raw as DispositionReason)
      : null;
  }

  /**
   * @internal
   *
   * Build a deterministic placeholder {@link ContentHash} from a
   * tokenId — the importer probes `_invalid` / `_audit` via the
   * `(tokenId, observedHash)` composite key, so when the manifest
   * does not surface an observed hash we fall back to a stable
   * derivation. Hex form so the `contentHash()` brand validates.
   */
  private _fallbackContentHash(tokenId: string): ContentHash {
    // Use the tokenId itself when it's a 64-char hex (the canonical
    // form per the spec); otherwise fall back to a sentinel that will
    // miss every key (so the lookup correctly returns `undefined` and
    // we fall through to `case 1`). 32 bytes of zero hex is the
    // sentinel.
    if (/^[0-9a-fA-F]{64}$/.test(tokenId)) {
      return contentHash(tokenId.toLowerCase());
    }
    return contentHash('00'.repeat(32));
  }
}

/**
 * @internal
 *
 * Case-insensitive byte-equal compare for hex strings. Used to bind a
 * proof's `transactionHash` / `authenticator` to a queue entry's bound
 * triple (#155). Two hex strings are byte-equal when they have the
 * same length and every position has the same nibble value regardless
 * of letter case. Non-hex characters are NOT normalized — callers are
 * responsible for ensuring both inputs are hex.
 *
 * Returns `false` if either input is `null`/`undefined` or if their
 * lengths differ, so a missing field on either side fails closed.
 */
function hexEqualsIgnoreCase(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  // Localeless lower-case compare. `toLowerCase` on a-z range is
  // locale-invariant; the canonical hex alphabet [0-9a-fA-F] doesn't
  // contain any locale-sensitive code points.
  return a.toLowerCase() === b.toLowerCase();
}

// =============================================================================
// 5. Convenience function — single-shot import without constructing the class
// =============================================================================

/**
 * Convenience wrapper: build a one-off {@link InclusionProofImporter}
 * and dispatch a single import. Useful for tests and for ad-hoc
 * operator scripts.
 *
 * Production code should construct the importer once per Sphere
 * instance — building it per call wastes nothing materially but the
 * call-site ergonomics are cleaner with a long-lived instance.
 */
export async function importInclusionProof(
  options: ImportInclusionProofOptions,
  addr: string,
  tokenId: string,
  proof: ImportableInclusionProof,
  callOptions?: ImportInclusionProofCallOptions,
): Promise<ImportProofResult> {
  const importer = new InclusionProofImporter(options);
  return importer.importInclusionProof(addr, tokenId, proof, callOptions);
}
