/**
 * Legacy-shape adapter — UXF Inter-Wallet Transfer recipient (T.7.B).
 *
 * Bridges the **four legacy `LegacyTokenTransferPayload` wire shapes**
 * (§3.4 — Sphere TXF, V6 `COMBINED_TRANSFER`, V5/V4 `INSTANT_SPLIT`,
 * SDK legacy `{token, proof}`) into the **unified §5.3 disposition
 * pipeline**. Senders that opt into `transferMode: 'txf'` (or that ship
 * pre-UXF code) emit one of these four shapes per Nostr event; the
 * recipient must produce **the same per-token disposition outcomes** as
 * the equivalent UXF bundle would (acceptance criterion: VALID / PENDING
 * / PROOF_INVALID / STRUCTURAL_INVALID / NOT_OUR_CURRENT_STATE /
 * UNSPENDABLE_BY_US / CONFLICTING).
 *
 * **Why an adapter rather than a parallel pipeline** (per §2.4 + §10.2):
 * legacy and UXF arrivals MUST converge at the disposition writer
 * (T.3.C) so the OrbitDB profile is the single source of truth. A
 * parallel TXF-only ingest path would diverge token statuses,
 * `_invalid` / `_audit` records, and finalization-queue semantics from
 * the UXF flow. The adapter:
 *
 *   1. **Decomposes** the legacy event into N synthetic single-token
 *      entries (one entry → exactly one tokenId + one transfer chain).
 *      Per-shape decomposition rules:
 *        - Sphere TXF (single):     1 entry  (the {sourceToken, transferTx} pair)
 *        - V6 COMBINED_TRANSFER:    N entries — `directTokens.length` plus
 *                                   1 per recipient mint produced by the
 *                                   embedded V5 `splitBundle` (typically
 *                                   1, if `splitBundle != null`).
 *        - V5/V4 INSTANT_SPLIT:     1 entry  (the recipient mint output;
 *                                   V5/V4 splits always emit a single
 *                                   recipient token per bundle).
 *        - SDK legacy `{token,proof}`: 1 entry (whole-token).
 *      The "N tokens → N dispositions" guarantee means the adapter's
 *      caller MAY observe MULTIPLE `DispositionRecord` entries from a
 *      single legacy Nostr event. The downstream writer (T.3.C) routes
 *      each independently per §5.4.
 *
 *   2. **Skips §5.2 bundle-level checks**. Legacy shapes carry no CAR
 *      and no `bundleCid` — the §5.2 chain-depth / unclaimed-roots /
 *      multi-root caps are structurally inapplicable. The adapter
 *      synthesizes a deterministic `bundleCid` per entry (derived from
 *      `tokenId` + the observed token-content-hash so multiple legacy
 *      events for the same token converge on the same forensic
 *      provenance) and routes each entry directly into §5.3 via the
 *      `processDisposition` engine (T.3.B.2).
 *
 *   3. **Routes instant-TXF arrivals through the finalization queue**.
 *      §4.4.2 / §2.4 mandate: an inbound legacy event carrying a
 *      transaction with `inclusionProof: null` is **instant-TXF**, and
 *      MUST be enqueued on the per-address {@link FinalizationQueue}
 *      (T.5.C) for the same chain-mode finalization semantics as
 *      instant-UXF arrivals. The adapter detects instant-TXF via the
 *      caller-supplied `extractTxLegacyChain` hook (returns the per-tx
 *      list of `{transactionHash, requestId, hasInclusionProof,
 *      authenticator, ...}` records); each tx with `hasInclusionProof
 *      === false` produces one queue entry. The disposition for that
 *      tokenId is `PENDING` (per §5.3 [E]) until the worker drains the
 *      queue and re-runs §5.5 step 9.
 *
 *   4. **Reuses the disposition engine** verbatim. The adapter does
 *      NOT re-implement §5.3; it injects a `hydrateChain` hook that
 *      lifts a legacy `{sourceToken, transferTx}` JSON pair (or the
 *      equivalent SDK shape, V5 mint+transfer pair, V6 direct-entry,
 *      V4 commitment) into a `HydratedChain`, and `processDisposition`
 *      walks [A]–[F] as for any UXF bundle. The injected hooks
 *      (predicate evaluator, authenticator verifier, proof verifier,
 *      oracle.isSpent, manifest reader) come from the same T.3.B.1
 *      modules used by the UXF path — there is **no parallel
 *      verifier**.
 *
 * **Single-pipeline guarantee** (acceptance + §10.2): the adapter's
 * output (`DispositionRecord[]`) flows through the SAME T.3.C
 * `DispositionWriter` the UXF pipeline uses. The two flows differ only
 * at the bundle-acquisition layer; from §5.3 onward they are
 * indistinguishable. A wallet that receives a Sphere TXF event on
 * Monday and a UXF bundle for the same token on Tuesday produces ONE
 * canonical manifest entry (idempotent re-write per §5.6).
 *
 * **Provenance fields on synthetic dispositions**:
 *   - `bundleCid`: synthetic, deterministic — `legacy-${shape}-${tokenId}`
 *     (or a per-entry variant when N > 1). Stable across re-arrivals so
 *     the per-entry-key disambiguator (`observedTokenContentHash`) is
 *     the multi-rep discriminator, not the synthetic CID.
 *   - `senderTransportPubkey`: the AUTHENTICATED Nostr signing pubkey
 *     of the event author (passed in by the caller — same as the UXF
 *     path's `senderTransportPubkey` argument).
 *
 * **Adapter contract — what the caller injects**:
 *   - `extractTxLegacyChain`: shape-aware decomposition. Given a legacy
 *     payload, returns an array of `LegacyTokenEntry` records (one per
 *     token the event delivers). Each entry carries:
 *       - The `tokenId` (lowercase hex; 64 chars).
 *       - The chain of transactions (list of `{authenticator,
 *         transactionHash, inclusionProof | null, requestId, sourceState,
 *         destinationState}`) — the same shape `HydratedTx` consumes.
 *       - The current-state predicate hydration (parsed
 *         `IPredicate`).
 *       - The current destination state hash.
 *       - The observed token-content-hash (the §5.4 multi-rep
 *         disambiguator — derived by the caller from a stable byte
 *         representation of the source token JSON; the adapter
 *         echoes it on every disposition record).
 *
 *     The injection layer is the boundary at which SDK / CBOR parsing
 *     happens; the adapter itself never touches SDK token JSON.
 *
 *   - `evaluatePredicate`, `verifyAuthenticator`, `verifyProof`,
 *     `walkContinuity`, `oracleIsSpent`, `readLocalManifest`: identical
 *     hooks the UXF disposition engine consumes. Wired from
 *     `PaymentsModule` to the same per-element verifier modules
 *     (T.3.B.1) the UXF flow uses.
 *
 *   - `enqueueFinalization` (REQUIRED for instant-TXF chains): a
 *     `FinalizationQueue.add` thunk used to enqueue instant-TXF
 *     entries. When `null` / `undefined`, the adapter REFUSES to write
 *     a PENDING disposition for any chain with unfinalized txs and
 *     throws `MISSING_FINALIZATION_QUEUE` instead — without a wired
 *     enqueuer the manifest entry would stay `pending` forever with
 *     no worker tracking, leaving the recipient permanently stuck.
 *     For chains that are fully finalized (no `inclusionProof: null`
 *     entries), the enqueuer is genuinely optional and MAY be omitted.
 *     Pre-T.5.C deployments that cannot accept instant-TXF arrivals
 *     must configure senders for conservative TXF
 *     (`txfFinalization: 'conservative'`) — which guarantees the
 *     adapter only sees fully-finalized chains.
 *
 *   - `now`: wall-clock provider; default `Date.now()`. Tests inject a
 *     deterministic clock so timestamps stay reproducible.
 *
 * **Forward-compat note**: when a future protocol revision (§10.4)
 * adds a fifth legacy shape, this module's `extractTxLegacyChain`
 * contract is the only injection point that needs updating — the §5.3
 * routing is shape-agnostic.
 *
 * Spec references:
 *   - §3.4   TXF (legacy) wire shape — the four shapes recognized.
 *   - §4.4.2 Instant TXF — `inclusionProof: null` arrival path.
 *   - §5.3   Per-token disposition (the matrix the adapter routes through).
 *   - §5.4   Storage outcomes (the multi-rep `observedTokenContentHash`
 *            disambiguator).
 *   - §5.5   Per-token finalization (where instant-TXF queue entries
 *            land for chain-mode finalization).
 *   - §10.2  Single-pipeline convergence guarantee.
 *
 * @packageDocumentation
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { SphereError } from '../../../core/errors';
import {
  isLegacyTokenTransferPayload,
  type LegacyTokenTransferPayload,
} from '../../../types/uxf-transfer';
import type { DispositionRecord } from '../../../types/disposition';
import type { ContentHash, UxfElement } from '../../../extensions/uxf/bundle/types';
import {
  processDisposition,
  type AssertRequestIdBindingFn,
  type DispositionEngineInput,
  type EvaluatePredicateFn,
  type HydratedChain,
  type HydratedTx,
  type OracleIsSpentFn,
  type ReadLocalManifestFn,
  type VerifyAuthenticatorFn,
  type VerifyProofFn,
  type WalkContinuityFn,
} from './disposition-engine';
import type { FinalizationQueueEntry } from './finalization-queue';
import { entryIdFor } from './finalization-queue';

// =============================================================================
// 1. Public types — legacy shape recognition
// =============================================================================

/**
 * Discriminated tag enumerating the four §3.4 legacy wire shapes the
 * adapter recognizes.
 *
 * - `'sphere-txf'`        — `{sourceToken, transferTx, memo?, sender?}`.
 * - `'combined-v6'`       — `{type:'COMBINED_TRANSFER', version:'6.0', ...}`.
 * - `'instant-split-v5'`  — `{type:'INSTANT_SPLIT', version:'5.0', ...}`.
 * - `'instant-split-v4'`  — `{type:'INSTANT_SPLIT', version:'4.0', ...}`.
 * - `'sdk-legacy'`        — `{token, proof}`.
 *
 * The adapter MAY classify the same wire bytes as more than one shape
 * during detection; the precedence order is defined in
 * {@link classifyLegacyShape} and matches `isLegacyTokenTransferPayload`
 * (V6 → V5 → V4 → Sphere TXF → SDK legacy).
 */
export type LegacyShape =
  | 'sphere-txf'
  | 'combined-v6'
  | 'instant-split-v5'
  | 'instant-split-v4'
  | 'sdk-legacy';

/**
 * Per-tx hydration produced by the caller's `extractTxLegacyChain`
 * hook. Mirrors {@link HydratedTx} structurally but is reproduced here
 * to keep the adapter's contract leaf-level (no transitive coupling to
 * the disposition engine for callers that only build the hook adapter).
 */
export interface LegacyHydratedTx {
  /** Source-state ContentHash (string-equality compared to the
   *  predecessor's destinationState by the continuity walker). */
  readonly sourceState: string;
  /** Destination-state ContentHash. */
  readonly destinationState: string;
  /** Hydrated SDK Authenticator (or any object the injected verifier
   *  understands). Type `unknown` to keep the adapter SDK-agnostic. */
  readonly authenticator: unknown;
  /** Hydrated SDK DataHash for the canonical transaction-hash preimage. */
  readonly transactionHash: unknown;
  /** Hydrated SDK InclusionProof, or `null` if not yet anchored. The
   *  `null` discriminator is what triggers the instant-TXF →
   *  finalization-queue routing (§4.4.2). */
  readonly inclusionProof: unknown | null;
  /** RequestId for the proof-verifier hook AND the
   *  `commitmentRequestId` the finalization-queue entry persists. May
   *  be `null` when the proof itself is absent — but if absent AND we
   *  need to enqueue, the adapter requires the caller to supply
   *  {@link txWireBytes} so the worker can re-derive `requestId` later
   *  via the SDK's `RequestId` helper. */
  readonly requestId: unknown | null;
  /**
   * Imprint hex of the canonical transaction hash (68 hex chars,
   * matching the §6.1 race-loser detector). Used by the
   * finalization-queue path; the disposition engine does NOT consume
   * this field directly. Callers MAY supply the same value as
   * `transactionHash` if their hydrator already produces hex; otherwise
   * the adapter falls back to the empty string and the queue entry
   * carries an unverified imprint (acceptable for instant-TXF — the
   * worker re-derives on first poll).
   */
  readonly transactionHashHex?: string;
  /**
   * Authenticator hex for §6.3 most-recent-proof correlation. Same
   * fallback as {@link transactionHashHex}.
   */
  readonly authenticatorHex?: string;
  /**
   * Optional inline signed-tx bytes. When present, the worker fast-
   * paths submit/poll without re-resolving from a pool (the legacy
   * adapter has no pool). When absent, the worker tolerates absence
   * and falls back to its `RequestContextResolver` adapter.
   */
  readonly signedTxWireBytes?: Uint8Array;
}

/**
 * One synthetic single-token entry decomposed from a legacy payload.
 *
 * Each entry corresponds to **exactly one tokenId** and carries
 * everything the adapter needs to invoke `processDisposition`. The
 * caller's `extractTxLegacyChain` hook is responsible for producing
 * one entry per token the event delivers (see per-shape rules in the
 * file header).
 */
export interface LegacyTokenEntry {
  /** Canonical tokenId (lowercase hex, 64 chars per BYTE_FIELDS). */
  readonly tokenId: string;
  /** The §5.4 multi-rep disambiguator — a stable hex digest of the
   *  source token JSON as observed in this event. The adapter echoes
   *  this on every disposition record produced for this entry. */
  readonly observedTokenContentHash: ContentHash;
  /** Ordered transaction chain (oldest first). Empty array means the
   *  token is at genesis state — §5.3 [B] still applies. */
  readonly chain: ReadonlyArray<LegacyHydratedTx>;
  /** Hydrated current-state predicate (parsed `IPredicate`). */
  readonly currentStatePredicate: unknown;
  /** ContentHash of the current (most-recent) destination state. */
  readonly currentDestinationStateHash: string;
}

/**
 * The hook signature for the caller-supplied legacy decomposer.
 *
 * Given a legacy payload (one of the four §3.4 shapes), returns the
 * list of `LegacyTokenEntry` records this event delivers. The hook is
 * responsible for:
 *  - **Shape recognition**: dispatching on the structural discriminators
 *    (`type` field for V4/V5/V6; `sourceToken && transferTx` for Sphere
 *    TXF; `token && proof` for SDK legacy).
 *  - **Per-token decomposition**: V6 with K direct entries + 1 split
 *    bundle yields K + (1 if splitBundle else 0) entries; V5/V4 yield 1.
 *  - **SDK / CBOR parsing**: lifting JSON-strings into hydrated
 *    Authenticator / DataHash / IPredicate / InclusionProof references
 *    so the adapter can pass them through the disposition engine
 *    verbatim.
 *  - **Failure isolation**: a parse-throw on ONE entry MUST NOT
 *    invalidate the others. The hook MAY return a partial list and
 *    surface a `STRUCTURAL_INVALID` synthetic entry for the failing
 *    one (with `chain: []` and a deterministic
 *    `observedTokenContentHash`). The adapter is paranoid against
 *    hook throws — see {@link adaptLegacyShape} for the catch-all
 *    contract.
 *
 * **Why injected**: SDK / CBOR parsing pulls in `@unicitylabs/state-
 * transition-sdk`. Keeping it out of this module keeps the adapter
 * free of a heavy SDK transitive dependency at the test boundary —
 * tests inject a stub that returns canned `LegacyTokenEntry` records
 * without standing up the SDK.
 */
export type ExtractLegacyChainFn = (
  payload: LegacyTokenTransferPayload,
  shape: LegacyShape,
) => Promise<ReadonlyArray<LegacyTokenEntry>>;

// =============================================================================
// 2. Public types — adapter input
// =============================================================================

/**
 * Construction record for one `adaptLegacyShape` invocation. Every
 * SDK / oracle / storage hook is injected so unit tests can drive the
 * adapter without standing up a real SDK or OrbitDB.
 */
export interface LegacyShapeAdapterInput {
  // ---- Per-event context ----
  /** The decoded legacy payload (one of four §3.4 shapes). */
  readonly payload: LegacyTokenTransferPayload;
  /**
   * The AUTHENTICATED Nostr signing pubkey (64-hex). MUST be the
   * verified event author, NOT the unauthenticated
   * `payload.sender.transportPubkey` claim — the latter could be
   * forged (§9.3).
   */
  readonly senderTransportPubkey: string;
  /**
   * Per-address profile prefix the finalization-queue entries are
   * stored under (`${addr}.finalizationQueue.${entryId}`). Only
   * required when {@link enqueueFinalization} is supplied. The
   * adapter never reads this field outside the queue-add path.
   */
  readonly addr?: string;

  // ---- Recipient identity ----
  /** Our chain pubkey bytes (33-byte compressed secp256k1). */
  readonly ourPubkey: Uint8Array;
  /** Bundled trust base for the proof verifier. */
  readonly trustBase: unknown;

  // ---- Injected hooks ----
  /** Decompose the legacy payload into N synthetic entries. See
   *  {@link ExtractLegacyChainFn}. */
  readonly extractTxLegacyChain: ExtractLegacyChainFn;
  /** Disposition-engine hook (T.3.B.1 predicate evaluator). */
  readonly evaluatePredicate: EvaluatePredicateFn;
  /** Disposition-engine hook (T.3.B.1 authenticator verifier). */
  readonly verifyAuthenticator: VerifyAuthenticatorFn;
  /** Disposition-engine hook (T.3.B.1 continuity walker). */
  readonly walkContinuity: WalkContinuityFn;
  /** Disposition-engine hook (T.3.B.1 proof verifier). */
  readonly verifyProof: VerifyProofFn;
  /**
   * Audit #333 H4 — re-derive RequestId and assert binding. Optional;
   * when omitted the engine falls back to the pre-fix behaviour of
   * trusting the hydrateChain-supplied `requestId` unchecked. See
   * `DispositionEngineInput.assertRequestIdBinding`.
   */
  readonly assertRequestIdBinding?: AssertRequestIdBindingFn;
  /** Disposition-engine hook — `oracle.isSpent`. */
  readonly oracleIsSpent: OracleIsSpentFn;
  /** Disposition-engine hook — local manifest reader. */
  readonly readLocalManifest: ReadLocalManifestFn;
  /**
   * Finalization-queue enqueuer. REQUIRED whenever an instant-TXF
   * chain (any tx with `inclusionProof: null`) might arrive — the
   * adapter throws `MISSING_FINALIZATION_QUEUE` if it sees an
   * unfinalized chain without an enqueuer (and matching `addr`)
   * because writing a PENDING disposition WITHOUT worker tracking
   * leaves the recipient permanently stuck. May be omitted only when
   * the caller can guarantee every arriving chain is fully finalized
   * (e.g., the sender side is pinned to `txfFinalization:
   * 'conservative'`).
   */
  readonly enqueueFinalization?: FinalizationQueueEnqueuer;
  /** Wall-clock supplier; default `Date.now`. */
  readonly now?: () => number;
}

/**
 * Minimal contract for the finalization-queue enqueue side-effect.
 *
 * Production wires this to {@link FinalizationQueue.add}. The
 * `addr` slot is the per-address profile prefix; the `entry` is the
 * canonical {@link FinalizationQueueEntry} the recipient worker
 * consumes (T.5.C).
 */
export type FinalizationQueueEnqueuer = (
  addr: string,
  entry: FinalizationQueueEntry,
) => Promise<void>;

// =============================================================================
// 3. Public API — adaptLegacyShape
// =============================================================================

/**
 * Adapt one inbound legacy `TOKEN_TRANSFER` event into N synthetic
 * disposition records, routing instant-TXF arrivals through the
 * finalization queue.
 *
 * **Returns** a list of {@link DispositionRecord}s, one per token the
 * legacy event delivers. The caller (PaymentsModule) routes each
 * record through the T.3.C {@link DispositionWriter} — same downstream
 * sink as the UXF pipeline.
 *
 * **Failure modes**:
 *  - If the payload is NOT a recognized legacy shape (caller mis-
 *    routed a UXF v1.0 envelope here), throws `VALIDATION_ERROR`. The
 *    adapter is the wrong layer to handle UXF v1.0 shapes; route them
 *    to {@link acquireBundle} instead.
 *  - If `extractTxLegacyChain` throws, surfaces as a SINGLE
 *    `STRUCTURAL_INVALID` disposition with `tokenId === ''` and a
 *    deterministic `observedTokenContentHash`. The recipient retains
 *    the failure for forensics; subsequent re-arrivals of the same
 *    event idempotently re-write the same `_invalid` record.
 *  - If `extractTxLegacyChain` returns an empty list, the adapter
 *    surfaces a single `STRUCTURAL_INVALID` so the event is not
 *    silently dropped (per §5.3 paragraph 2: throw-paths NEVER fall
 *    through silently).
 *  - Per-entry hook throws inside `processDisposition` are routed by
 *    the engine itself (per its own contract — every throw becomes a
 *    structured `INVALID` record). The adapter does not double-wrap.
 *
 * **Idempotency**: re-running the adapter with the same `(payload,
 * senderTransportPubkey)` produces the same `DispositionRecord[]`
 * (modulo the wall-clock provider). The downstream writer handles
 * idempotent re-writes per §5.6.
 */
export async function adaptLegacyShape(
  input: LegacyShapeAdapterInput,
): Promise<ReadonlyArray<DispositionRecord>> {
  validateInput(input);

  const shape = classifyLegacyShape(input.payload);
  if (shape === null) {
    throw new SphereError(
      'adaptLegacyShape: payload is not a recognized legacy shape; ' +
        'route UXF v1.0 envelopes through acquireBundle instead',
      'VALIDATION_ERROR',
    );
  }

  // Decompose the event into per-token entries. Hook throws or empty
  // returns surface as a single STRUCTURAL_INVALID synthetic record so
  // we never silently drop the event.
  let entries: ReadonlyArray<LegacyTokenEntry>;
  try {
    entries = await input.extractTxLegacyChain(input.payload, shape);
  } catch {
    return [
      buildStructuralInvalid(
        '',
        syntheticObservedHash('extract-throw', shape),
        syntheticBundleCidFor(shape, '', null),
        input.senderTransportPubkey,
      ),
    ];
  }

  if (entries.length === 0) {
    return [
      buildStructuralInvalid(
        '',
        syntheticObservedHash('extract-empty', shape),
        syntheticBundleCidFor(shape, '', null),
        input.senderTransportPubkey,
      ),
    ];
  }

  // Iterate the entries SEQUENTIALLY. Within one legacy event the
  // tokens MUST be processed in order (mirrors §5.0's
  // bundle-internal sequential rule for §5.6 idempotency invariants).
  const out: DispositionRecord[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!isValidEntry(entry)) {
      // Defensive: a mis-shapen entry from the hook never reaches the
      // engine. Surface as STRUCTURAL_INVALID with whatever fields
      // we can salvage. We re-widen the type via `unknown` because TS
      // narrows `entry` to `never` here — the runtime value can still
      // carry a partial shape we want to read defensively.
      const partial = entry as unknown as Record<string, unknown> | null | undefined;
      const salvagedTokenId =
        partial !== null &&
        partial !== undefined &&
        typeof partial.tokenId === 'string'
          ? partial.tokenId
          : '';
      const salvagedObservedHash =
        partial !== null &&
        partial !== undefined &&
        isContentHash(partial.observedTokenContentHash)
          ? partial.observedTokenContentHash
          : syntheticObservedHash(`bad-entry-${i}`, shape);
      out.push(
        buildStructuralInvalid(
          salvagedTokenId,
          salvagedObservedHash,
          syntheticBundleCidFor(shape, salvagedTokenId, i),
          input.senderTransportPubkey,
        ),
      );
      continue;
    }

    const synthBundleCid = syntheticBundleCidFor(
      shape,
      entry.tokenId,
      entries.length === 1 ? null : i,
    );

    // Detect instant-TXF: any tx with `inclusionProof: null`. Per
    // §4.4.2, route these through the chain-mode finalization queue.
    // We compute the unfinalized count BEFORE invoking the engine so
    // the queue side-effect lands deterministically; the engine itself
    // surfaces PENDING in this case.
    const unfinalizedCount = countUnfinalized(entry.chain);

    if (unfinalizedCount > 0) {
      // CRITICAL (#163): if we'd write a PENDING disposition without a
      // finalization-queue enqueuer wired, the recipient would never
      // drain the unfinalized txs — the manifest entry would stay
      // `pending` forever with no worker tracking. Refuse the write
      // at the adapter boundary instead. The only safe way to
      // gracefully degrade is for the caller to ensure no instant-TXF
      // chains can arrive (configure senders for conservative TXF).
      if (
        input.enqueueFinalization === undefined ||
        typeof input.addr !== 'string' ||
        input.addr.length === 0
      ) {
        throw new SphereError(
          'adaptLegacyShape: chain has unfinalized txs (inclusionProof:null) ' +
            'but no enqueueFinalization callback / addr was provided; ' +
            'recipient cannot resolve PENDING state. Per §4.4.2 / §5.5, ' +
            'instant-TXF arrivals MUST be routed through the per-address ' +
            'chain-mode finalization queue. Wire FinalizationQueue.add as ' +
            '`enqueueFinalization` and pass the per-address profile prefix ' +
            'as `addr`. Pre-T.5.C deployments that cannot accept instant-TXF ' +
            'arrivals must configure senders for conservative TXF instead.',
          'MISSING_FINALIZATION_QUEUE',
        );
      }
      // Enqueue ONE finalization-queue entry per unfinalized tx. The
      // worker consumes them per §5.5; on full drain, §5.5 step 9
      // re-runs [B]/[D]/[E] via `revaluate`.
      await enqueueInstantTxfChain(
        input.addr,
        entry,
        synthBundleCid,
        input.enqueueFinalization,
        input.now ?? defaultNow,
      );
    }

    // Route through the disposition engine. The engine surfaces
    // PENDING for `unfinalizedCount > 0` (matches §5.3 [E]); VALID /
    // AUDIT / INVALID / CONFLICTING for fully-finalized chains.
    //
    // Mode is HARD-CODED to 'conservative' for legacy adaptation. The
    // T.3.B.2 step-0 instant-mode-soft-rejection check would otherwise
    // throw `BUNDLE_REJECTED_INSTANT_MODE_NOT_YET_SUPPORTED` for any
    // chain with unfinalized txs — but legacy instant-TXF is FIRST-
    // CLASS supported here (we just enqueued for finalization above).
    // Forcing `conservative` makes the engine treat unfinalized txs as
    // "pending" rather than rejected.
    const engineInput = buildEngineInput(input, entry, synthBundleCid);

    let record: DispositionRecord;
    try {
      record = await processDisposition(engineInput);
    } catch (cause) {
      // The engine throws ONLY for instant-mode soft-rejection. Since
      // we hard-code mode='conservative', this branch is defensive —
      // an unexpected throw routes to STRUCTURAL_INVALID rather than
      // bubbling out of the adapter.
      record = buildStructuralInvalid(
        entry.tokenId,
        entry.observedTokenContentHash,
        synthBundleCid,
        input.senderTransportPubkey,
      );
      // We swallow `cause` here — the engine logs internally per its
      // own contract; the adapter's job is to never silently drop.
      void cause;
    }
    out.push(record);
  }

  return out;
}

// =============================================================================
// 4. Public API — classifyLegacyShape
// =============================================================================

/**
 * Identify which of the four §3.4 legacy shapes a payload is. Returns
 * `null` if the payload is not recognized.
 *
 * **Precedence** (matches `isLegacyTokenTransferPayload`):
 *   1. V6 `COMBINED_TRANSFER` — `type === 'COMBINED_TRANSFER' && version === '6.0'`.
 *   2. V5 `INSTANT_SPLIT`     — `type === 'INSTANT_SPLIT'      && version === '5.0'`.
 *   3. V4 `INSTANT_SPLIT`     — `type === 'INSTANT_SPLIT'      && version === '4.0'`.
 *   4. Sphere TXF             — `sourceToken && transferTx`.
 *   5. SDK legacy             — `token && proof`.
 *
 * V6 is checked BEFORE V5 because a V6 bundle MAY embed a V5
 * `splitBundle`; the OUTER discriminator unambiguously picks V6.
 */
export function classifyLegacyShape(value: unknown): LegacyShape | null {
  if (!isLegacyTokenTransferPayload(value)) return null;
  // After the type guard, narrowing to `Record<string, unknown>` is
  // safe — the guard already established `isPlainObject`.
  const obj = value as unknown as Record<string, unknown>;

  // Precedence 1: V6 COMBINED_TRANSFER
  if (obj.type === 'COMBINED_TRANSFER' && obj.version === '6.0') {
    return 'combined-v6';
  }
  // Precedence 2 / 3: V5 / V4 INSTANT_SPLIT
  if (obj.type === 'INSTANT_SPLIT') {
    if (obj.version === '5.0') return 'instant-split-v5';
    if (obj.version === '4.0') return 'instant-split-v4';
  }
  // Precedence 4: Sphere TXF single-token
  if (obj.sourceToken !== undefined && obj.transferTx !== undefined) {
    return 'sphere-txf';
  }
  // Precedence 5: SDK legacy `{token, proof}`
  if (obj.token !== undefined && obj.proof !== undefined) {
    return 'sdk-legacy';
  }
  return null;
}

// =============================================================================
// 5. Internal helpers — synthetic provenance
// =============================================================================

/**
 * Build the synthetic `bundleCid` for a legacy event. The output is
 * stable across re-arrivals so the multi-rep disambiguator remains the
 * `observedTokenContentHash`, NOT the synthetic CID. Length is bounded
 * (no risk of unbounded growth from variable-length tokenIds).
 *
 * The literal `legacy-` prefix is normative — downstream forensic
 * tooling pattern-matches on it to distinguish legacy-shape arrivals
 * from UXF arrivals at the `_invalid` / `_audit` collection level.
 *
 * Steelman fix (#170 issue 6): tokenId is now hashed (SHA-256, hex)
 * BEFORE inclusion. The prior implementation used `tokenId` verbatim.
 * A malicious legacy-shape sender could craft a tokenId byte-equal to
 * a CID prefix (e.g. starting `bafyrei...`), producing a synthetic
 * CID like `legacy-sphere-txf-bafyrei...` that masquerades as a real
 * bundle CID in forensic logs. Hashing makes the synthetic CID
 * provenance unambiguous: `legacy-${shape}-` always precedes a
 * 64-char SHA-256 hex digest of the tokenId, never the tokenId
 * itself.
 *
 * @internal
 */
export function syntheticBundleCidFor(
  shape: LegacyShape,
  tokenId: string,
  index: number | null,
): string {
  // Hash the tokenId portion to a fixed 64-char SHA-256 hex digest.
  // This bounds length regardless of attacker-supplied tokenId AND
  // prevents masquerade attacks where a crafted tokenId mimics a real
  // CID prefix in forensic output.
  const tidForHash = tokenId.length > 0 ? tokenId : 'no-token';
  const hashedTid = bytesToHex(sha256(new TextEncoder().encode(tidForHash)));
  if (index === null) {
    return `legacy-${shape}-${hashedTid}`;
  }
  return `legacy-${shape}-${hashedTid}-${index}`;
}

/**
 * Build the synthetic `observedTokenContentHash` placeholder for
 * structural-invalid records that lack a real source token (hook
 * throw, empty extraction, etc.). Stable across re-arrivals so the
 * `_invalid` write is idempotent at the storage layer.
 *
 * The 64-char width matches the canonical SHA-256 hex form of the
 * real `observedTokenContentHash` field.
 *
 * Steelman fix (#170 issue 5): the prior implementation padded the
 * seed string to 64 chars with `'0'`s and truncated longer seeds via
 * `.slice(0, 64)`. Two distinct seeds whose first 64 chars matched
 * would collide. Today's seed list is closed (`'extract-throw'`,
 * `'extract-empty'`, `bad-entry-${i}`) so the literal-set is
 * collision-resistant in practice — but a future refactor that lets
 * `tag` flow from a payload field would let an attacker craft a tag
 * whose first 64 chars match an honest synthetic hash, allowing
 * `_invalid` records to collide. Hashing the seed via SHA-256
 * eliminates the truncation surface entirely; collision-resistance
 * is now equivalent to the underlying hash function.
 *
 * @internal
 */
function syntheticObservedHash(tag: string, shape: LegacyShape): ContentHash {
  const seed = `legacy-${shape}-${tag}`;
  const digest = bytesToHex(sha256(new TextEncoder().encode(seed)));
  return digest as ContentHash;
}

// =============================================================================
// 6. Internal helpers — engine wiring
// =============================================================================

/**
 * Build a {@link DispositionEngineInput} from a `LegacyTokenEntry`.
 *
 * The `hydrateChain` hook is closed over the entry and returns the
 * pre-decomposed chain verbatim — no SDK calls inside the adapter.
 * The pool is a singleton empty Map (legacy events have no pool); the
 * engine only uses the pool to thread it to `hydrateChain` (which
 * ignores it here).
 *
 * @internal
 */
function buildEngineInput(
  input: LegacyShapeAdapterInput,
  entry: LegacyTokenEntry,
  synthBundleCid: string,
): DispositionEngineInput {
  return {
    tokenRootHash: entry.observedTokenContentHash,
    pool: EMPTY_POOL,
    bundleCid: synthBundleCid,
    senderTransportPubkey: input.senderTransportPubkey,
    // HARD-CODED conservative: see the comment at the call site for
    // why instant-mode-soft-rejection is bypassed for legacy shapes.
    mode: 'conservative',
    ourPubkey: input.ourPubkey,
    trustBase: input.trustBase,
    hydrateChain: async () => buildHydratedChain(entry),
    readLocalManifest: input.readLocalManifest,
    evaluatePredicate: input.evaluatePredicate,
    verifyAuthenticator: input.verifyAuthenticator,
    walkContinuity: input.walkContinuity,
    verifyProof: input.verifyProof,
    oracleIsSpent: input.oracleIsSpent,
    // Audit #333 H4 — re-derive requestId and assert binding.
    // Forwarded only when the caller supplies the hook; tests that
    // do not exercise the binding gate can omit it.
    ...(input.assertRequestIdBinding !== undefined
      ? { assertRequestIdBinding: input.assertRequestIdBinding }
      : {}),
  };
}

/**
 * Project a `LegacyTokenEntry` onto the `HydratedChain` shape the
 * disposition engine consumes. The transformation is shallow — the
 * caller-supplied entry already carries hydrated SDK objects.
 *
 * @internal
 */
function buildHydratedChain(entry: LegacyTokenEntry): HydratedChain {
  const chain: HydratedTx[] = entry.chain.map((tx) => ({
    sourceState: tx.sourceState,
    destinationState: tx.destinationState,
    authenticator: tx.authenticator,
    transactionHash: tx.transactionHash,
    inclusionProof: tx.inclusionProof,
    requestId: tx.requestId,
  }));
  return {
    tokenId: entry.tokenId,
    tokenRootHash: entry.observedTokenContentHash,
    chain,
    currentStatePredicate: entry.currentStatePredicate,
    currentDestinationStateHash: entry.currentDestinationStateHash,
  };
}

/**
 * Empty pool singleton. Legacy events have no pool; the engine's
 * pool reference is opaque (only `hydrateChain` consumes it) and can
 * safely be the same empty `Map` for every invocation.
 *
 * @internal
 */
const EMPTY_POOL: ReadonlyMap<ContentHash, UxfElement> = new Map();

// =============================================================================
// 7. Internal helpers — instant-TXF queue routing
// =============================================================================

/**
 * Enqueue one {@link FinalizationQueueEntry} per unfinalized tx in a
 * legacy chain. The chain's `txIndex` is the position in
 * `entry.chain[]` (0 = oldest). Entries with `inclusionProof !== null`
 * are SKIPPED (they're already finalized).
 *
 * The entries' `commitmentRequestId`, `transactionHash`, and
 * `authenticator` fields are derived from the corresponding hex
 * imprints in `LegacyHydratedTx` (`transactionHashHex` /
 * `authenticatorHex`). When a hex field is absent, we substitute the
 * empty string and rely on the worker's `RequestContextResolver` to
 * re-derive on the first poll. The `commitmentRequestId` MUST be
 * non-empty per `entryIdFor`'s contract (`tokenId:txIndex`); we
 * synthesize one from the same composite when the hook hasn't supplied
 * an explicit hex requestId — matching the recipient worker's fallback
 * path.
 *
 * Best-effort per entry: a per-entry write failure is logged via the
 * `enqueue` rejection but does NOT abort the loop — partial enqueueing
 * is recoverable on subsequent re-arrival of the same event.
 *
 * @internal
 */
async function enqueueInstantTxfChain(
  addr: string,
  entry: LegacyTokenEntry,
  synthBundleCid: string,
  enqueue: FinalizationQueueEnqueuer,
  now: () => number,
): Promise<void> {
  for (let txIndex = 0; txIndex < entry.chain.length; txIndex++) {
    const tx = entry.chain[txIndex];
    if (tx.inclusionProof !== null) continue;

    const ts = now();
    const transactionHashHex =
      typeof tx.transactionHashHex === 'string' && tx.transactionHashHex.length > 0
        ? tx.transactionHashHex
        : '';
    const authenticatorHex =
      typeof tx.authenticatorHex === 'string' && tx.authenticatorHex.length > 0
        ? tx.authenticatorHex
        : '';
    // commitmentRequestId MUST be non-empty per FinalizationQueue
    // validation. We synthesize one from the chain coordinates when
    // the hook hasn't provided an explicit requestId imprint. The
    // worker re-derives the canonical SDK RequestId on first submit.
    const commitmentRequestId =
      typeof tx.requestId === 'string' && tx.requestId.length > 0
        ? tx.requestId
        : `legacy:${entry.tokenId}:${txIndex}`;

    const queueEntry: FinalizationQueueEntry = {
      entryId: entryIdFor(entry.tokenId, txIndex),
      tokenId: entry.tokenId,
      bundleCid: synthBundleCid,
      txIndex,
      commitmentRequestId,
      transactionHash: transactionHashHex,
      authenticator: authenticatorHex,
      submittedAt: ts,
      createdAt: ts,
      submitRetryCount: 0,
      proofErrorCount: 0,
      status: 'pending',
      source: 'received',
      ...(tx.signedTxWireBytes !== undefined
        ? { signedTransferTxBytes: tx.signedTxWireBytes }
        : {}),
    };

    try {
      await enqueue(addr, queueEntry);
    } catch {
      // Best-effort. A persistence failure surfaces on the next
      // re-arrival of the same event (the worker is idempotent on
      // entryId). Swallow here so a single failed enqueue doesn't
      // abort the dispositions for the rest of the chain.
    }
  }
}

// =============================================================================
// 8. Internal helpers — defensive shape validation
// =============================================================================

/**
 * Validate adapter inputs at the boundary. Throws `VALIDATION_ERROR`
 * on programmer error (missing required hooks, malformed pubkey, etc.)
 * — the adapter is allowed to throw for caller mis-use; per-payload
 * runtime failures route through the disposition pipeline instead.
 *
 * @internal
 */
function validateInput(input: LegacyShapeAdapterInput): void {
  if (input === null || typeof input !== 'object') {
    throw new SphereError(
      'adaptLegacyShape: input must be an object',
      'VALIDATION_ERROR',
    );
  }
  if (
    typeof input.senderTransportPubkey !== 'string' ||
    input.senderTransportPubkey.length === 0
  ) {
    throw new SphereError(
      'adaptLegacyShape: senderTransportPubkey must be a non-empty string',
      'VALIDATION_ERROR',
    );
  }
  if (
    !(input.ourPubkey instanceof Uint8Array) ||
    input.ourPubkey.length === 0
  ) {
    throw new SphereError(
      'adaptLegacyShape: ourPubkey must be a non-empty Uint8Array',
      'VALIDATION_ERROR',
    );
  }
  if (typeof input.extractTxLegacyChain !== 'function') {
    throw new SphereError(
      'adaptLegacyShape: extractTxLegacyChain hook is required',
      'VALIDATION_ERROR',
    );
  }
  if (typeof input.evaluatePredicate !== 'function') {
    throw new SphereError(
      'adaptLegacyShape: evaluatePredicate hook is required',
      'VALIDATION_ERROR',
    );
  }
  if (typeof input.verifyAuthenticator !== 'function') {
    throw new SphereError(
      'adaptLegacyShape: verifyAuthenticator hook is required',
      'VALIDATION_ERROR',
    );
  }
  if (typeof input.walkContinuity !== 'function') {
    throw new SphereError(
      'adaptLegacyShape: walkContinuity hook is required',
      'VALIDATION_ERROR',
    );
  }
  if (typeof input.verifyProof !== 'function') {
    throw new SphereError(
      'adaptLegacyShape: verifyProof hook is required',
      'VALIDATION_ERROR',
    );
  }
  if (typeof input.oracleIsSpent !== 'function') {
    throw new SphereError(
      'adaptLegacyShape: oracleIsSpent hook is required',
      'VALIDATION_ERROR',
    );
  }
  if (typeof input.readLocalManifest !== 'function') {
    throw new SphereError(
      'adaptLegacyShape: readLocalManifest hook is required',
      'VALIDATION_ERROR',
    );
  }
}

/**
 * Validate a single `LegacyTokenEntry` produced by the hook. Returns
 * `true` iff every required field is well-formed.
 *
 * @internal
 */
function isValidEntry(entry: unknown): entry is LegacyTokenEntry {
  if (entry === null || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  if (typeof e.tokenId !== 'string' || e.tokenId.length === 0) return false;
  if (!isContentHash(e.observedTokenContentHash)) return false;
  if (!Array.isArray(e.chain)) return false;
  // Each tx MUST have sourceState + destinationState as strings; the
  // engine's continuity walker compares them with `===`, so a missing
  // field would mis-classify (which is acceptable — STRUCTURAL_INVALID
  // is the right outcome — but we still need them to be strings).
  for (const tx of e.chain) {
    if (tx === null || typeof tx !== 'object') return false;
    const t = tx as Record<string, unknown>;
    if (typeof t.sourceState !== 'string') return false;
    if (typeof t.destinationState !== 'string') return false;
    // `inclusionProof` may legitimately be `null` (instant-TXF); only
    // require the field to be PRESENT.
    if (!('inclusionProof' in t)) return false;
  }
  if (typeof e.currentDestinationStateHash !== 'string') return false;
  if (e.currentStatePredicate === undefined) return false;
  return true;
}

/**
 * Narrow check for ContentHash placeholders. The branded type is just
 * a string at runtime; we only verify shape.
 *
 * @internal
 */
function isContentHash(value: unknown): value is ContentHash {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Count unfinalized transactions in a chain. A tx is "unfinalized"
 * IFF its `inclusionProof === null`. The chain's order is irrelevant
 * — every unfinalized tx contributes one queue entry.
 *
 * @internal
 */
function countUnfinalized(chain: ReadonlyArray<LegacyHydratedTx>): number {
  let n = 0;
  for (const tx of chain) {
    if (tx.inclusionProof === null) n++;
  }
  return n;
}

/**
 * Build the canonical STRUCTURAL_INVALID DispositionRecord shape used
 * by the adapter's defensive paths.
 *
 * @internal
 */
function buildStructuralInvalid(
  tokenId: string,
  observedTokenContentHash: ContentHash,
  bundleCid: string,
  senderTransportPubkey: string,
): DispositionRecord {
  return {
    disposition: 'INVALID',
    tokenId,
    observedTokenContentHash,
    bundleCid,
    senderTransportPubkey,
    reason: 'structural',
  };
}

/**
 * Default wall-clock provider. Lifted out so tests can verify the
 * adapter's `now` injection seam without monkey-patching globals.
 *
 * @internal
 */
function defaultNow(): number {
  return Date.now();
}

// =============================================================================
// 9. Re-exports — convenience for callers
// =============================================================================

export type { DispositionRecord } from '../../../types/disposition';
export type {
  LegacyTokenTransferPayload,
} from '../../../types/uxf-transfer';
export type { FinalizationQueueEntry } from './finalization-queue';
