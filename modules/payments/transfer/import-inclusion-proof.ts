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

import type {
  DispositionReason,
} from '../../../types/disposition';
import type {
  InvalidEntry,
} from '../../../types/disposition';
import type {
  SphereEventMap,
  SphereEventType,
} from '../../../types';
import type { TokenManifestEntry } from '../../../profile/token-manifest';
import type { ManifestStore } from '../../../profile/manifest-store';
import {
  type DispositionPerEntryStorage,
} from '../../../profile/disposition-writer';
import {
  PerTokenMutex,
  type PerTokenMutexStrategy,
} from '../../../profile/per-token-mutex';
import type { ProofVerifyStatus } from './proof-verifier';
import { safeErrorMessage } from '../../../core/error-sanitize';

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
        | 'requestid-ambiguous'
        // (Wave 4 steelman, regression #2) Queue entry's `authenticator`
        // field is empty/missing, so the §6.3 binding compare cannot be
        // performed. This is FORENSIC — production queue entries always
        // carry the canonical authenticator hex/JSON. Empty fields are
        // observed when a writer bug or a pre-fix data path creates an
        // entry with `authenticator: ''`. The importer refuses rather
        // than degrading binding compare to "always pass" or "always
        // fail" under length-mismatch (which would silently re-classify
        // every legitimate proof as `proof-binding-mismatch`). The
        // operator is alerted via `console.warn` and routed to manual
        // triage. Fix the upstream writer; do not paper over here.
        | 'queue-entry-incomplete';
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
   *
   * Round 7 (FIX 3) — `PaymentsModule` now constructs ONE
   * {@link PerTokenMutex} per `initialize()` call (`_sharedPerTokenMutex`)
   * and plumbs it into the auto-installed sender + recipient
   * finalization workers AND this importer via the default builders'
   * `perTokenMutex` knob. Bootstrap layers that override the importer
   * via `installInclusionProofImporter()` SHOULD pass the same shared
   * mutex (read it back via private getter or accept it as a constructor
   * arg) so all three paths converge on the same per-tokenId
   * read-decide-write window.
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
 * (BYTE_FIELDS) all wallet code paths produce.
 *
 * **Case-canonicality** (steelman crit #16). The importer keys its
 * per-tokenId mutex on the tokenId; if two operator calls arrive with
 * different cases (e.g. `'AB...'` vs `'ab...'`) but the regex is
 * case-insensitive, they would acquire SEPARATE mutex slots and race
 * past the read-decide-write serialization promise. Two solutions are
 * applied together (defense-in-depth):
 *   1. The shape regex requires LOWERCASE hex — uppercase tokenIds are
 *      rejected at the entry point with `'invalid-tokenid'`. Wallet code
 *      lowercases SDK tokenIds before passing them to the importer
 *      (see PaymentsModule wiring); operator scripts that paste raw
 *      input get a clear shape error.
 *   2. The importer ALSO lowercase-normalizes the tokenId before every
 *      Map / mutex / storage operation as a defense-in-depth layer
 *      (see `_importInclusionProofUnderMutex`).
 *
 * Used at the importer entry point to reject malformed operator input
 * (steelman finding, Wave 3 + #16).
 */
const CANONICAL_TOKEN_ID_RE = /^[0-9a-f]{64}$/;

/**
 * Round 3 — wall-clock skew tolerance applied when validating
 * `observedAt` timestamps in `_findInvalidEntry`.
 *
 * A record's `observedAt` is stamped by the writer using the local
 * `Date.now()`. Replicas may legitimately disagree on the wall clock
 * by a small margin (NTP-tolerated drift, virtualization clock skew,
 * etc.). We accept records up to {@link CLOCK_SKEW_TOLERANCE_MS} in
 * the future relative to our local clock; records beyond that are
 * rejected as forgeries (a compromised local writer planting
 * `Number.MAX_VALUE` to dominate the freshest-record selection).
 *
 * 5 minutes covers realistic clock skew between cooperating wallets
 * while still rejecting `Number.MAX_VALUE` (≈ 2.85e305 days into the
 * future) and any near-bound forgery.
 */
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Round 3 — cap on the number of `_invalid` keys enumerated by
 * {@link InclusionProofImporter._findInvalidEntry} per call.
 *
 * Without a cap, a hostile peer planting millions of crafted prefix
 * matches forces the importer into N sequential `readRecord`
 * round-trips. The cap bounds the worst-case latency and read budget;
 * reaching the cap surfaces an operator alert so the operator can
 * investigate (real workloads NEVER produce thousands of entries for
 * a single tokenId).
 *
 * 1024 is comfortably above the realistic ceiling (a few dozen
 * forensic re-arrivals per tokenId) and tight enough that an
 * unbounded scan is cut off before it materially impacts a single
 * import call.
 */
const FIND_INVALID_ENTRY_MAX_RESULTS = 1024;

/**
 * Round 3 — guard against forged `observedAt` fields when ranking
 * `_invalid` records by recency.
 *
 * The legacy `rec.observedAt > best.observedAt` comparison silently
 * produced `false` when `rec.observedAt` was `NaN`, leaving an
 * earlier record as `best`. That meant a corrupt entry with NaN read
 * FIRST became `best` and dominated subsequent comparisons — every
 * legitimate record returned `false` against a NaN baseline. Worse,
 * a compromised local writer planting `Number.MAX_VALUE` always won
 * the comparison and dominated the freshest-record selection.
 *
 * This validator clamps `observedAt` to `[0, now + CLOCK_SKEW_TOLERANCE_MS]`
 * and rejects every other shape (NaN, Infinity, negative, post-tolerance
 * future, non-number). Rejected records are skipped entirely; the
 * importer behaves as if they did not exist.
 */
function isValidObservedAt(value: unknown, now: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= now + CLOCK_SKEW_TOLERANCE_MS
  );
}

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
    // (Steelman crit #16) Lowercase-normalize the tokenId BEFORE every
    // Map / mutex / storage operation. Defense-in-depth even though
    // CANONICAL_TOKEN_ID_RE is now strict-lowercase: if a future caller
    // path sneaks an uppercase tokenId past the regex (regression), the
    // normalization here keeps the per-tokenId mutex slot consistent.
    // Two concurrent calls "AB...EF" + "ab...ef" would otherwise acquire
    // SEPARATE mutex slots and race past the read-decide-write
    // serialization promise.
    const normalizedTokenId = tokenId.toLowerCase();
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
      normalizedTokenId,
      () =>
        this._importInclusionProofUnderMutex(
          addr,
          normalizedTokenId,
          proof,
          callOptions,
        ),
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

    // (Steelman warning) Empty / missing `transactionHash` on EITHER
    // side gates the §155 binding compare. Without this guard, two
    // dead branches collapse the binding decision into a security hole:
    //   1. `target.transactionHash === ''` AND `proof.transactionHash`
    //      non-empty → `hexEqualsIgnoreCase` length-mismatches and
    //      returns false → routed to `'proof-binding-mismatch'` —
    //      misleading because the queue entry is structurally
    //      incomplete (writer bug), not a binding mismatch.
    //   2. BOTH `target.transactionHash === ''` AND
    //      `proof.transactionHash === ''` → `hexEqualsIgnoreCase('','')`
    //      trivially passes the length and content checks, the
    //      binding compare succeeds with no actual transaction-hash
    //      bound, and the importer grafts on the requestId-only —
    //      exactly the §6.3 attack the binding compare exists to
    //      defeat. Surfacing `'queue-entry-incomplete'` routes the
    //      operator to manual triage and unblocks the dead enum
    //      branch declared in the result type.
    if (
      typeof target.transactionHash !== 'string' ||
      target.transactionHash.length === 0 ||
      typeof proof.transactionHash !== 'string' ||
      proof.transactionHash.length === 0
    ) {
      return { ok: false, reason: 'queue-entry-incomplete' };
    }

    // (#155) Bind the proof to the queue entry's full triple
    // (transactionHash + authenticator), not just the requestId. The
    // §6.3 most-recent-proof / single-spend forbidden-case checks
    // require this — see `ImportableInclusionProof.transactionHash` /
    // `.authenticator` JSDoc. An attacker who knows the victim's
    // tokenId + an outstanding requestId could otherwise paste any
    // aggregator-anchored proof sharing that requestId and graft a
    // different transaction onto the live queue entry.
    //
    // (Wave 4 regression #2) The §155 byte-equal `hexEqualsIgnoreCase`
    // for `authenticator` was wrong — `authenticator` is a JSON-encoded
    // object on most paths (sender's commitJson, aggregator response,
    // recipient's Transaction.toJSON()) and JSON object key order is
    // NOT canonical. Two semantically-identical authenticator objects
    // emitted by different serializers (sender vs aggregator vs
    // recipient) can produce different byte strings → spurious
    // `proof-binding-mismatch`. Use `canonicalAuthenticatorEquals`
    // which parses both sides as `IAuthenticatorJson` and compares
    // canonical fields when both sides are JSON, and falls back to
    // case-insensitive byte-equal compare when both sides are plain
    // hex. `transactionHash` IS plain hex on every path so it keeps
    // `hexEqualsIgnoreCase`.
    if (!hexEqualsIgnoreCase(proof.transactionHash, target.transactionHash)) {
      return { ok: false, reason: 'proof-binding-mismatch' };
    }
    const authnCmp = canonicalAuthenticatorEquals(
      proof.authenticator,
      target.authenticator,
    );
    if (authnCmp === 'mismatch') {
      return { ok: false, reason: 'proof-binding-mismatch' };
    }
    // authnCmp === 'match' — fall through to the lifecycle decision.
    // Wave 6: when the queue entry's authenticator is empty (the
    // production case post-IPLD-round-trip), `canonicalAuthenticator
    // Equals` returns `'match'` and the binding decision is carried
    // by `transactionHash` byte equality alone — the load-bearing
    // check.

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

    // (Steelman warning) Same dead-branch guard as the pending path —
    // see `_handlePendingPath`. Empty `transactionHash` on either side
    // collapses the binding compare into a trivial pass (both empty
    // → `hexEqualsIgnoreCase('','')` returns true) which is the §6.3
    // attack the binding compare exists to defeat. Surface
    // `'queue-entry-incomplete'` for either side missing.
    if (
      typeof resolvingEntry.transactionHash !== 'string' ||
      resolvingEntry.transactionHash.length === 0 ||
      typeof proof.transactionHash !== 'string' ||
      proof.transactionHash.length === 0
    ) {
      return { ok: false, reason: 'queue-entry-incomplete' };
    }

    // (#155) Bind the proof to the queue entry's full triple
    // (transactionHash + authenticator), not just the requestId. Per
    // §6.3 the most-recent-proof / single-spend forbidden-case checks
    // require the proof's full triple to match the queue entry
    // verbatim. Without this, an attacker who knows the victim's
    // tokenId + a hard-failed requestId could paste any aggregator-
    // anchored proof sharing that requestId and flip
    // `_invalid → valid` (case 5) or trigger a K-1 re-queue (case 6)
    // bound to a different transaction.
    //
    // (Wave 4 regression #2) See the pending path's longer note.
    // `transactionHash` is plain hex; `authenticator` may be JSON.
    if (!hexEqualsIgnoreCase(proof.transactionHash, resolvingEntry.transactionHash)) {
      return { ok: false, reason: 'proof-binding-mismatch' };
    }
    const authnCmpInvalid = canonicalAuthenticatorEquals(
      proof.authenticator,
      resolvingEntry.authenticator,
    );
    if (authnCmpInvalid === 'mismatch') {
      return { ok: false, reason: 'proof-binding-mismatch' };
    }
    // authnCmpInvalid === 'match' — proceed with case-5/6 decision.
    // Wave 6: empty queue-entry `authenticator` (the production
    // post-IPLD-round-trip state) returns `'match'`; the binding
    // decision is carried by `transactionHash` byte equality alone.

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
    //
    // (Steelman warning) Wrap emit in try/catch — the override IS
    // committed (applyOverride wrote `overrideAppliedBy` /
    // `overrideAppliedAt` to the manifest), `previousInvalidEntry` is
    // on-disk; the event emission is best-effort telemetry, NOT a
    // commit barrier. A misbehaving handler that throws here would
    // otherwise propagate the throw back to the operator caller —
    // and the caller, seeing the throw, would assume the override
    // was NOT applied. The next retry on a non-idempotent override
    // path could then double-apply or skew the audit pair. Logging
    // the emit failure preserves observability without coupling the
    // commit to handler reliability.
    try {
      this.opts.emit('transfer:override-applied', {
        tokenId,
        overrideAppliedAt: args.now,
        overrideAppliedBy: args.operatorPubkey,
        previousReason: invalidEntry.reason,
        transition,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      try {
        // Round 5 fix: pass redacted error string instead of raw err object.
        console.warn(
          '[import-inclusion-proof] transfer:override-applied emit failed',
          { tokenId, transition, error: safeErrorMessage(err) },
        );
      } catch {
        // ignore logging failures
      }
    }

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
   * tokenId may have multiple records; we use the storage's prefix
   * scanner to enumerate every record under
   * `${addr}.invalid.${tokenId}.` and return the most recent (max
   * `observedAt`) so the override applies against the freshest
   * forensic record.
   *
   * Why prefix scan (steelman crit #15). The legacy implementation
   * relied on the manifest entry's `rootHash` as the disambiguator,
   * falling back to a sentinel content hash when no manifest entry
   * was available. But the disposition writer routes hard-failed
   * tokens to `_invalid` AND removes their manifest entries — so the
   * importer's case 1 path enters here with `manifestEntry ===
   * undefined`. The fallback hash (`contentHash(tokenId.toLowerCase())`)
   * is a different SHA-256 than the disposition writer's element-hash
   * key suffix, so the probe always missed. Case 1 collapsed
   * "token-bound-to-_invalid" into "no-such-token" — the operator
   * lost the override path entirely.
   *
   * The prefix scanner is the structural fix: enumerate every
   * `_invalid` record under the canonical prefix and pick the
   * authoritative one regardless of the observed-content-hash the
   * importer arrived with.
   *
   * Returns `null` when no record exists.
   */
  private async _findInvalidEntry(
    addr: string,
    tokenId: string,
  ): Promise<InvalidEntry | null> {
    const prefix = `${addr}.invalid.${tokenId}.`;
    const keys = await this.opts.dispositionStorage.listKeysWithPrefix(
      prefix,
      { maxResults: FIND_INVALID_ENTRY_MAX_RESULTS },
    );
    if (keys.length === 0) return null;
    // Round 3 — cap surfacing. If the storage returned exactly the cap,
    // a hostile peer (or upstream defect) may be saturating the prefix
    // namespace. Surface to operators so they can investigate; we still
    // proceed with the best record we can find within the cap so the
    // override path remains usable.
    if (keys.length >= FIND_INVALID_ENTRY_MAX_RESULTS) {
      try {
        // eslint-disable-next-line no-console
        console.warn(
          '[import-inclusion-proof] _findInvalidEntry: prefix-scan cap hit — ' +
            'storage returned at least the maxResults cap. Investigate possible ' +
            'forensic-storage saturation or an upstream writer bug.',
          {
            prefix,
            cap: FIND_INVALID_ENTRY_MAX_RESULTS,
          },
        );
      } catch {
        /* logging best-effort */
      }
      try {
        this.opts.emit('transfer:operator-alert', {
          code: 'oracle-rejected', // closest existing reason for "needs operator triage"
          tokenId,
          message:
            `_findInvalidEntry: prefix-scan cap of ${FIND_INVALID_ENTRY_MAX_RESULTS} hit ` +
            `for prefix "${prefix}". Storage may be saturated by a hostile peer or an ` +
            `upstream writer bug — investigate.`,
        });
      } catch {
        /* emit best-effort */
      }
    }
    // Round 3 — validate `observedAt` per-read. Records with
    // NaN/Infinity/MAX_VALUE/negative/post-tolerance-future timestamps
    // are skipped entirely. If ALL records have invalid observedAt, the
    // importer treats the prefix as having no record (returns null).
    const now = this.defaultNow();
    let best: InvalidEntry | null = null;
    let bestObserved: number = -1;
    for (const k of keys) {
      const rec = await this.opts.dispositionStorage.readRecord<InvalidEntry>(k);
      if (rec === undefined) continue;
      if (!isValidObservedAt(rec.observedAt, now)) {
        // Record's observedAt is corrupt or attacker-shaped. Skip it
        // entirely so a NaN baseline cannot dominate ranking and a
        // MAX_VALUE forgery cannot win the freshest selection.
        try {
          // eslint-disable-next-line no-console
          console.warn(
            '[import-inclusion-proof] _findInvalidEntry: skipping record with invalid observedAt',
            {
              key: k,
              observedAt: rec.observedAt,
              now,
              tolerance: CLOCK_SKEW_TOLERANCE_MS,
            },
          );
        } catch {
          /* logging best-effort */
        }
        continue;
      }
      if (best === null || rec.observedAt > bestObserved) {
        best = rec;
        bestObserved = rec.observedAt;
      }
    }
    return best;
  }

  /**
   * @internal
   *
   * Quick check whether ANY `_audit` record exists for `(addr, tokenId)`.
   * Used by case 1 to disambiguate "token unknown" from "token in audit
   * (structurally valid, unspendable by us)" — both collapse to
   * `'no-such-token'` per §6.3 case 1, but the disambiguation lives
   * here so future spec changes can route differently.
   *
   * Uses the prefix scanner so a token whose manifest entry was deleted
   * on routing to `_audit` is correctly recovered. The legacy fallback
   * hash always missed (steelman crit #15) — same root cause as
   * `_findInvalidEntry`.
   */
  private async _hasAuditEntry(
    addr: string,
    tokenId: string,
  ): Promise<boolean> {
    const prefix = `${addr}.audit.${tokenId}.`;
    // Round 3 — cap at 1 since the consumer only needs existence. The
    // adapter can short-circuit once a single live record is found,
    // avoiding any prefix-saturation amplification.
    const keys = await this.opts.dispositionStorage.listKeysWithPrefix(
      prefix,
      { maxResults: 1 },
    );
    return keys.length > 0;
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
      // G2 — schema discriminator preserves this record across legacy
      // PaymentsModule.save() flushes (provider-side `applyPerEntryDiff`
      // checks `_schemaVersion === 'uxf-1'` to skip foreign-schema entries).
      _schemaVersion: 'uxf-1',
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

/**
 * @internal
 *
 * Canonical four-key shape of the SDK's `IAuthenticatorJson` (mirrors
 * `@unicitylabs/state-transition-sdk/lib/api/Authenticator.d.ts`).
 *
 * The interface is duplicated here rather than imported from the SDK
 * to avoid a runtime dependency on the SDK's `Authenticator` class for
 * what is effectively a JSON shape check. Keeping the structural
 * declaration co-located also makes the canonicalization rule visible
 * at the call site.
 */
interface CanonicalAuthenticatorJson {
  readonly publicKey: string;
  readonly algorithm: string;
  readonly signature: string;
  readonly stateHash: string;
}

/**
 * @internal
 *
 * Discriminated outcome of {@link canonicalAuthenticatorEquals}.
 *
 *  - `'match'`           — either both sides represent the same
 *                          authenticator (canonical form when JSON,
 *                          byte-equal when plain hex), OR the queue
 *                          entry's authenticator is empty/null. The
 *                          empty-queue case is the EXPECTED state in
 *                          production: the IPLD wire format
 *                          (deconstructTransferData →
 *                          assembleTransactionData) does NOT preserve
 *                          any `data.authenticator` field, so the
 *                          recipient extraction path stores `''`
 *                          deliberately (see
 *                          PaymentsModule.ts ~line 1771). We degrade
 *                          to transactionHash-only binding (the load-
 *                          bearing check) rather than refuse every
 *                          legitimate proof.
 *  - `'mismatch'`        — both sides parsed but represent different
 *                          authenticators.
 */
type CanonicalAuthenticatorCmp = 'match' | 'mismatch';

/**
 * @internal
 *
 * Parse an authenticator string. Returns the parsed canonical-shape
 * JSON object if the input is a JSON-encoded `IAuthenticatorJson`;
 * returns `null` otherwise (the caller falls back to byte-equal hex
 * compare for non-JSON inputs).
 *
 * The parser is conservative — it ONLY recognizes the canonical
 * four-key shape (`publicKey`, `algorithm`, `signature`, `stateHash`,
 * all strings). Unknown shapes return `null` so the caller treats
 * them as opaque hex strings.
 */
function tryParseCanonicalAuthenticator(
  raw: string,
): CanonicalAuthenticatorJson | null {
  // Fast-path: JSON-encoded objects always start with `{` after any
  // leading whitespace. Anything else is opaque hex/text.
  const trimmed = raw.trimStart();
  if (trimmed.length === 0 || trimmed[0] !== '{') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.publicKey !== 'string' ||
    typeof obj.algorithm !== 'string' ||
    typeof obj.signature !== 'string' ||
    typeof obj.stateHash !== 'string'
  ) {
    return null;
  }
  return {
    publicKey: obj.publicKey,
    algorithm: obj.algorithm,
    signature: obj.signature,
    stateHash: obj.stateHash,
  };
}

/**
 * @internal
 *
 * Canonical authenticator equality. The §6.3 binding compare for the
 * queue entry vs an operator-supplied proof MUST be INSENSITIVE to JSON
 * object key order — `Authenticator.toJSON()` emits `{algorithm,
 * publicKey, signature, stateHash}` while the SDK's `IAuthenticatorJson`
 * interface declares `{publicKey, algorithm, signature, stateHash}`.
 * Two semantically-identical authenticators serialized by different
 * code paths (sender's commitJson, aggregator's response, recipient's
 * `Transaction.toJSON()`) produce DIFFERENT byte strings — naive
 * `hexEqualsIgnoreCase` reports mismatch and the importer would reject
 * every legitimate proof.
 *
 * **Load-bearing vs metadata.** The §6.3 most-recent-proof / single-
 * spend forbidden-case check actually compares the ATTACHED proof's
 * authenticator vs the OBSERVED poll's authenticator — both come from
 * the AGGREGATOR. The QUEUE-ENTRY's authenticator is metadata-only;
 * the load-bearing binding is `transactionHash` (which the call site
 * compares via {@link hexEqualsIgnoreCase} — see
 * `_handlePendingPath` and `_handleInvalidPath`).
 *
 * **Empty queue-entry is the EXPECTED state.** The IPLD wire format
 * (`deconstructTransferData` → `assembleTransactionData` in
 * `uxf/deconstruct.ts` and `uxf/assemble.ts`) does NOT preserve any
 * `authenticator` field on `transferTransactionData` round-trip
 * through `pkg.toCar() → UxfPackage.fromCar() → pkg.assemble()`. The
 * recipient's `_recipientRequestContextMap` queue entry therefore
 * stores `authenticator: ''` deliberately (see
 * `PaymentsModule.ts` ~line 1771). Returning a distinct
 * `'queue-entry-empty'` outcome and refusing the import would make
 * EVERY round-tripped bundle hit `proof-binding-mismatch` — exactly
 * the dead-code regression Wave 6 closes. Empty queue-entry therefore
 * degrades to `'match'`: the importer relies on `transactionHash`
 * byte equality (the load-bearing check) for the binding decision.
 *
 * Resolution rules (in order):
 *  1. Empty/null/whitespace queue-entry side → `'match'` (degrade to
 *     transactionHash-only binding; see paragraph above).
 *  2. Empty/null/whitespace proof side (with non-empty queue side) →
 *     `'mismatch'` (operator supplied no authenticator; cannot bind).
 *  3. Both sides parse as canonical JSON → field-wise compare:
 *     `publicKey`, `signature`, `stateHash` are case-insensitive hex
 *     (their on-the-wire form is hex regardless of upper/lower);
 *     `algorithm` is a string identifier compared case-sensitively
 *     (the SDK emits canonical lower-case but never relies on this).
 *  4. Exactly one side parses as JSON, the other does not → `'mismatch'`
 *     (operator passed an authenticator in a different form than the
 *     queue carries; we cannot canonicalize across shapes safely).
 *  5. Neither parses as JSON → fall back to {@link hexEqualsIgnoreCase}.
 *
 * NOTE: `transactionHash` (the other half of the §155 bind triple) IS
 * always plain hex on every path — it stays on `hexEqualsIgnoreCase`
 * at the call site, and that compare IS load-bearing (it must match
 * for the import to succeed).
 */
function canonicalAuthenticatorEquals(
  proofAuthn: string | null | undefined,
  queueAuthn: string | null | undefined,
): CanonicalAuthenticatorCmp {
  // Empty queue-entry — the EXPECTED state in production (the IPLD
  // wire format does not preserve `data.authenticator`). Degrade to
  // transactionHash-only binding; the call site already enforces
  // `transactionHash` byte equality (load-bearing).
  const queueEmpty =
    typeof queueAuthn !== 'string' || queueAuthn.trim().length === 0;
  if (queueEmpty) return 'match';
  const proofEmpty =
    typeof proofAuthn !== 'string' || proofAuthn.trim().length === 0;
  if (proofEmpty) return 'mismatch';
  const proofParsed = tryParseCanonicalAuthenticator(proofAuthn);
  const queueParsed = tryParseCanonicalAuthenticator(queueAuthn);
  if (proofParsed !== null && queueParsed !== null) {
    // Field-wise canonical compare. publicKey / signature / stateHash
    // are hex; algorithm is a short identifier string.
    if (proofParsed.algorithm !== queueParsed.algorithm) return 'mismatch';
    if (!hexEqualsIgnoreCase(proofParsed.publicKey, queueParsed.publicKey)) {
      return 'mismatch';
    }
    if (!hexEqualsIgnoreCase(proofParsed.signature, queueParsed.signature)) {
      return 'mismatch';
    }
    if (!hexEqualsIgnoreCase(proofParsed.stateHash, queueParsed.stateHash)) {
      return 'mismatch';
    }
    return 'match';
  }
  if (proofParsed === null && queueParsed === null) {
    // Both opaque — fall back to legacy byte-equal hex compare. This
    // covers tests / pre-canonical paths where authenticator is a
    // plain hex blob.
    return hexEqualsIgnoreCase(proofAuthn, queueAuthn) ? 'match' : 'mismatch';
  }
  // Exactly one side is JSON, the other is opaque — we cannot bridge
  // the shapes without re-encoding, and re-encoding would silently
  // accept attacker-shaped opaque bytes that "look like" the canonical
  // JSON. Refuse with `'mismatch'`.
  return 'mismatch';
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
