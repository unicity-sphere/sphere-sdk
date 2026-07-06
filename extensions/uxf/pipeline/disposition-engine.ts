/**
 * Disposition engine — UXF Inter-Wallet Transfer recipient (T.3.B.2).
 *
 * The §5.3 decision-matrix walker. Given a single token-root element
 * (the recipient flow walks every claimed/unclaimed root in a verified
 * bundle, one engine call per root) plus all the per-element verifiers
 * landed in T.3.B.1 + the local manifest view, produces a single
 * {@link DispositionRecord} per the [A]-[F]+[B'] decision matrix.
 *
 * **Pure routing logic.** The engine performs NO I/O of its own; every
 * SDK / storage call is wrapped as an injected dependency so the unit
 * tests in `tests/unit/payments/transfer/disposition-engine.test.ts`
 * can exercise every branch without standing up the SDK, an oracle
 * provider, or a live OrbitDB profile.
 *
 * Dependency-injection contract (the seven hooks the engine calls):
 *
 *   - `hydrateChain(root, pool)`        — turn a token-root pool element
 *                                          + its dependencies into a
 *                                          {@link HydratedChain}: the
 *                                          ordered transaction chain
 *                                          (with `sourceState` /
 *                                          `destinationState` strings,
 *                                          per-tx `Authenticator` /
 *                                          `transactionHash` /
 *                                          `inclusionProof` references),
 *                                          the tokenId, and the current-
 *                                          state predicate hydration.
 *   - `evaluatePredicate(predicate, pubkey)` — T.3.B.1 predicate
 *                                          verifier. Returns either
 *                                          `{ok: true, bindsToUs}` or
 *                                          `{ok: false, threw, error}`.
 *   - `verifyAuthenticator(auth, txHash)`    — T.3.B.1 ECDSA verifier.
 *   - `walkContinuity(chain)`                — T.3.B.1 source-state
 *                                          continuity check.
 *   - `verifyProof(proof, trustBase, reqId)` — T.3.B.1 proof verifier.
 *   - `oracleIsSpent(stateHash)`             — `oracle.isSpent(...)`
 *                                          wrapped in try/catch by the
 *                                          caller; the engine treats a
 *                                          throw as STRUCTURAL_INVALID
 *                                          (defensive — the spec does
 *                                          not require it but consistency
 *                                          with the §5.3 [A] paragraph
 *                                          on "verify routines that
 *                                          throw" does).
 *   - `readLocalManifest(tokenId)`           — wallet-local manifest
 *                                          lookup. Returns the existing
 *                                          {@link ManifestEntryDelta}
 *                                          for `tokenId` or `undefined`.
 *
 * Routing order (the §5.3 decision-tree re-cast as a strict sequence —
 * see {@link processDisposition} for the canonical implementation):
 *
 *   0.  Mode soft-rejection — `mode === 'instant'` AND any tx in the
 *       chain has no inclusion proof → throw
 *       `BUNDLE_REJECTED_INSTANT_MODE_NOT_YET_SUPPORTED` per the T.3
 *       deferred-handling note. Conservative-mode bundles, and instant-
 *       mode bundles whose chains are coincidentally fully finalized,
 *       proceed to step 1.
 *
 *   1.  Hydrate the token-root + its chain. Throw → STRUCTURAL_INVALID
 *       per §5.3 [A].
 *
 *   2.  Continuity walk — runs FIRST per T.3.B.2 acceptance "C-continuity
 *       branch (W24-related): the engine routes through the continuity
 *       walker first, before [B]/[B'] checks." If broken → INVALID with
 *       reason `'continuity-broken'`.
 *
 *   3.  Per-tx authenticator verification (W37 / Note N7) — verify ALL
 *       K authenticators in the chain, NOT just the head. Any throw →
 *       STRUCTURAL_INVALID; any `valid: false` → INVALID with reason
 *       `'auth-invalid'`.
 *
 *   4.  Per-tx inclusion-proof verification (§5.3 [C](3)) — for every
 *       transaction WITH a proof, verify it. Throw → INVALID with
 *       reason `'proof-throw'`. PATH_INVALID / NOT_AUTHENTICATED /
 *       PATH_NOT_INCLUDED → INVALID with reason `'proof-invalid'` (the
 *       receive-time mapping spec'd in §5.3 [C](3)). Transactions
 *       without proofs are tracked toward the `unfinalizedCount`
 *       counter that drives the PENDING outcome at step 7.
 *
 *   5.  Predicate evaluation against current state (§5.3 [B] / [B']) —
 *       the current-state predicate is the recipient's ownership gate.
 *       Throw → STRUCTURAL_INVALID. `bindsToUs: false`:
 *         - if the local manifest has NO entry for this tokenId →
 *           AUDIT(`not-our-state`) per §5.3 [B-not-ours] and
 *           Appendix A row "B-not-ours".
 *         - if the local manifest HAS an entry → still
 *           AUDIT(`not-our-state`) per Appendix A; the manifest
 *           presence affects T.3.D's promotion logic (out of scope
 *           here) but the disposition record is the same shape.
 *
 *   6.  Conflict check against the local manifest (§5.3 [D]) — if the
 *       local manifest has an entry for this tokenId AND its rootHash
 *       differs from the new chain's head, surface CONFLICTING with
 *       the new head plus the existing head as `conflictingHeads`. The
 *       T.3.D conflict merger wave does the lex-min tie-break; this
 *       module just emits the CONFLICTING shape so downstream code
 *       sees a stable two-head record.
 *
 *   7.  Spent-check / pending terminal (§5.3 [E]) — if any unfinalized
 *       transaction exists, return PENDING (queued for §5.5 finalization
 *       by the worker pool). If all transactions are finalized, run
 *       `oracleIsSpent` against the current destination state hash.
 *       True → AUDIT(`off-record-spend`); false → VALID; throw →
 *       STRUCTURAL_INVALID.
 *
 * Throw semantics (CRITICAL):
 *
 *   At every branch, ANY thrown SDK error inside an injected hook
 *   surfaces as STRUCTURAL_INVALID with reason `'structural'` (or
 *   `'predicate-eval'` / `'proof-throw'` per the §5.4 reason
 *   distinction). NEVER silent fall-through. The engine wraps every
 *   hook call in try/catch; a hook MUST signal failure via its return
 *   value (e.g., `{ok: false, threw}`), not via thrown exception. The
 *   engine treats unexpected exceptions as defensive STRUCTURAL_INVALID
 *   to honor the spec invariant ("Throw-paths NEVER fall through
 *   silently" — §5.3 paragraph 2).
 *
 * Conflict-merger boundary (T.3.D not-yet-landed):
 *
 *   This wave (T.3.B.2) emits CONFLICTING when the local manifest's
 *   rootHash disagrees with the incoming chain's head. The lex-min
 *   tie-break that §5.3 [D-conflict] mandates lives in T.3.D
 *   (`modules/payments/transfer/conflict-merger.ts`); we do NOT
 *   pre-implement it here. The CONFLICTING `DispositionRecord` carries
 *   both heads in `conflictingHeads` so T.3.D can take over without
 *   reworking the engine.
 *
 * Spec references:
 *   - §5.3      Per-token disposition matrix [A]-[F] + [B']
 *   - §5.4      Storage outcomes (DispositionReason enum + `_invalid`/`_audit`)
 *   - §5.5      Per-token finalization (drives PENDING outcome)
 *   - Appendix A Branch reference table (every row covered by tests)
 *   - §11.1     Unit-test surface (one test per leaf in §5.3)
 *
 * @packageDocumentation
 */

import { SphereError } from '../../../core/errors.js';
import type {
  DispositionRecord,
  ManifestEntryDelta,
} from '../types/disposition.js';
import type { ContentHash, UxfElement } from '../bundle/types.js';

import type { ContinuityResult, TxLike } from './continuity-walker.js';
import type { EvaluatePredicateResult } from './predicate-evaluator.js';
import type { ProofVerifyStatus } from './proof-verifier.js';
import type { VerifyAuthenticatorResult } from './authenticator-verifier.js';

// =============================================================================
// 1. Public types — engine input
// =============================================================================

/**
 * Sender-advertised mode field. ADVISORY per §3.1, but the engine
 * gates instant-mode-with-pending-tx bundles per the T.3 deferred-
 * handling note.
 */
export type BundleMode = 'instant' | 'conservative';

/**
 * The hydrated transaction-chain shape the engine consumes. The
 * caller-supplied `hydrateChain` hook is responsible for lifting the
 * raw pool elements into this form, including:
 *  - parsing the token-root's transaction list (in chain order),
 *  - decoding each transaction's authenticator / transactionHash /
 *    inclusionProof references,
 *  - decoding the current-state predicate.
 *
 * Hydration is the boundary at which CBOR / SDK-shape parsing happens;
 * the engine itself never touches CBOR.
 */
export interface HydratedChain {
  /** Logical token id (lowercase hex per BYTE_FIELDS). */
  readonly tokenId: string;
  /** Pool ContentHash of the token-root element. The engine echoes
   *  this in the disposition record's `observedTokenContentHash`. */
  readonly tokenRootHash: ContentHash;
  /** Ordered chain (oldest first). Empty array is permitted (the
   *  token is at genesis state — §5.3 [B] still applies). */
  readonly chain: ReadonlyArray<HydratedTx>;
  /** The current-state predicate hydration (e.g., a parsed
   *  `IPredicate`). Type kept as `unknown` so the engine doesn't
   *  bind to a specific SDK predicate engine.  */
  readonly currentStatePredicate: unknown;
  /** ContentHash of the current (most-recent) destination state. The
   *  engine threads this to `oracleIsSpent` at step 7. */
  readonly currentDestinationStateHash: string;
}

/**
 * Per-transaction hydration. The engine consumes the four fields
 * below; everything else lives in the caller's adapter.
 *
 * `inclusionProof` is `null` IFF the transaction has no proof yet
 * (instant-mode unfinalized, chain-mode mid-hop). Both `authenticator`
 * and `transactionHash` are present even for unfinalized txs — they
 * exist on the signed transfer regardless of proof presence.
 */
export interface HydratedTx extends TxLike {
  /** Hydrated SDK Authenticator (or any object the injected verifier
   *  understands). Type `unknown` to keep the engine SDK-agnostic. */
  readonly authenticator: unknown;
  /** Hydrated SDK DataHash for the canonical transaction-hash preimage. */
  readonly transactionHash: unknown;
  /** Hydrated SDK InclusionProof, or `null` if not yet anchored. */
  readonly inclusionProof: unknown | null;
  /** RequestId for the proof-verifier hook. May be `null` when the
   *  proof itself is absent (the engine will not call the verifier
   *  in that case). */
  readonly requestId: unknown | null;
}

/**
 * The pure-function signature for hydrating a token-root element +
 * its chain. The caller's adapter supplies CBOR/SDK decoding; the
 * engine wraps every invocation in try/catch and routes throw to
 * STRUCTURAL_INVALID per §5.3 [A].
 */
export type HydrateChainFn = (
  tokenRootHash: ContentHash,
  pool: ReadonlyMap<ContentHash, UxfElement>,
) => Promise<HydratedChain>;

/**
 * The pure-function signature for the local-manifest lookup. Returns
 * the existing manifest entry for `tokenId` or `undefined` if no
 * entry exists. The engine treats throw as STRUCTURAL_INVALID
 * (storage-layer corruption is structural).
 */
export type ReadLocalManifestFn = (
  tokenId: string,
) => Promise<ManifestEntryDelta | undefined>;

/**
 * Verifier hook signatures — exact mirrors of the four T.3.B.1
 * exports. Re-declared as types so unit tests can mock without
 * importing the real verifier modules.
 */
export type EvaluatePredicateFn = (
  predicate: unknown,
  ourPubkey: Uint8Array,
) => Promise<EvaluatePredicateResult>;

export type VerifyAuthenticatorFn = (
  authenticator: unknown,
  transactionHash: unknown,
) => Promise<VerifyAuthenticatorResult>;

export type WalkContinuityFn = (
  chain: ReadonlyArray<TxLike>,
) => ContinuityResult;

export type VerifyProofFn = (
  proof: unknown,
  trustBase: unknown,
  requestId: unknown,
) => Promise<ProofVerifyStatus>;

/**
 * Audit #333 H4 — re-derive RequestId and assert the binding.
 *
 * Pre-fix the engine called `verifyProof(proof, trustBase, requestId)`
 * with the bundle-supplied `requestId` and trusted that the un-audited
 * `hydrateChain` adapter had derived it canonically (i.e.,
 * `RequestId.create(authenticator.publicKey, sourceState)`). If the
 * adapter erred or a malicious sender hand-crafted the bundle with a
 * proof anchored to a DIFFERENT transaction's requestId, the proof
 * would still verify (it IS a genuine on-chain proof) but it would
 * be incorrectly attributed to this transaction — a proof-binding
 * forgery.
 *
 * This hook canonically re-derives the requestId from the (parsed)
 * authenticator and compares it to the bundle-supplied requestId.
 * `{ ok: true }` permits proof verification to proceed; `{ ok: false }`
 * routes to `proof-invalid` (the same §5.3 [C](3) class as a clean
 * PATH_INVALID failure — the proof does not bind to this transaction).
 *
 * Production implementations call `RequestId.create(auth.publicKey,
 * auth.stateHash)` and compare `.toJSON()` (or the SDK's equality
 * operator) against the bundle's `requestId`. Tests can stub this
 * directly to exercise the engine's binding-rejection paths.
 *
 * Optional — when absent the engine logs a one-shot warning on the
 * first proof-verify attempt and proceeds with the pre-fix behaviour.
 * Production wiring SHOULD always provide the hook; the optional shape
 * preserves back-compat with existing tests.
 */
export interface AssertRequestIdBindingResult {
  readonly ok: boolean;
  /** Diagnostic for the cryptoInvalid 'proof-invalid' reason payload. */
  readonly reason?: string;
}
export type AssertRequestIdBindingFn = (
  bundleRequestId: unknown,
  authenticator: unknown,
) => Promise<AssertRequestIdBindingResult>;

export type OracleIsSpentFn = (stateHash: string) => Promise<boolean>;

/**
 * The full input record the engine consumes. Every SDK / storage
 * touchpoint is an injected hook so unit tests can mock them all
 * without standing up the SDK, oracle, or OrbitDB.
 */
export interface DispositionEngineInput {
  // ---- Pool / bundle context ----
  readonly tokenRootHash: ContentHash;
  readonly pool: ReadonlyMap<ContentHash, UxfElement>;
  readonly bundleCid: string;
  readonly senderTransportPubkey: string;
  /** Sender-advertised mode (§3.1). Drives the instant-mode soft-
   *  rejection at step 0. */
  readonly mode: BundleMode;
  // ---- Recipient identity ----
  /** Our chain pubkey bytes (33-byte compressed secp256k1). */
  readonly ourPubkey: Uint8Array;
  // ---- Trust / oracle context ----
  /** Bundled trust base for the proof verifier. */
  readonly trustBase: unknown;
  // ---- Injected hooks (all required) ----
  readonly hydrateChain: HydrateChainFn;
  readonly readLocalManifest: ReadLocalManifestFn;
  readonly evaluatePredicate: EvaluatePredicateFn;
  readonly verifyAuthenticator: VerifyAuthenticatorFn;
  readonly walkContinuity: WalkContinuityFn;
  readonly verifyProof: VerifyProofFn;
  readonly oracleIsSpent: OracleIsSpentFn;
  /**
   * Audit #333 H4 — optional `RequestId` binding asserter. When
   * provided, called BEFORE every `verifyProof` invocation to confirm
   * that the bundle's `requestId` was canonically derived from this
   * tx's `(authenticator.publicKey, sourceState)`. Production wiring
   * SHOULD always provide; the optional shape preserves test back-
   * compat. See {@link AssertRequestIdBindingFn}.
   */
  readonly assertRequestIdBinding?: AssertRequestIdBindingFn;
}

// =============================================================================
// 2. Internal helpers
// =============================================================================

/**
 * Build a STRUCTURAL_INVALID disposition record. Used by every
 * error path in the engine. The `reason` parameter selects the §5.4
 * sub-classification (`structural`, `predicate-eval`, `proof-throw`).
 */
function structuralInvalid(
  input: Pick<DispositionEngineInput, 'bundleCid' | 'senderTransportPubkey'>,
  tokenId: string,
  observedTokenContentHash: ContentHash,
  reason: 'structural' | 'predicate-eval' | 'proof-throw',
): DispositionRecord {
  return {
    disposition: 'INVALID',
    tokenId,
    observedTokenContentHash,
    bundleCid: input.bundleCid,
    senderTransportPubkey: input.senderTransportPubkey,
    reason,
  };
}

/**
 * Build an INVALID disposition record with one of the
 * cryptographic-failure reasons (`auth-invalid`, `continuity-broken`,
 * `proof-invalid`).
 */
function cryptoInvalid(
  input: Pick<DispositionEngineInput, 'bundleCid' | 'senderTransportPubkey'>,
  tokenId: string,
  observedTokenContentHash: ContentHash,
  reason: 'auth-invalid' | 'continuity-broken' | 'proof-invalid',
): DispositionRecord {
  return {
    disposition: 'INVALID',
    tokenId,
    observedTokenContentHash,
    bundleCid: input.bundleCid,
    senderTransportPubkey: input.senderTransportPubkey,
    reason,
  };
}

/**
 * Build an AUDIT disposition record. The `auditStatus` and `reason`
 * pair is constrained by §5.4: `not-our-state` ↔ `audit-not-our-state`,
 * `off-record-spend` ↔ `audit-off-record-spend`.
 */
function audit(
  input: Pick<DispositionEngineInput, 'bundleCid' | 'senderTransportPubkey'>,
  tokenId: string,
  observedTokenContentHash: ContentHash,
  kind: 'not-our-state' | 'off-record-spend',
): DispositionRecord {
  return {
    disposition: 'AUDIT',
    tokenId,
    observedTokenContentHash,
    bundleCid: input.bundleCid,
    senderTransportPubkey: input.senderTransportPubkey,
    auditStatus:
      kind === 'not-our-state'
        ? 'audit-not-our-state'
        : 'audit-off-record-spend',
    reason: kind,
  };
}

/**
 * Build a VALID / PENDING / CONFLICTING manifest disposition. Caller
 * supplies the `manifest` delta (rootHash, status, ...); the engine
 * fills in the routing fields.
 */
function manifestDisposition(
  input: Pick<DispositionEngineInput, 'bundleCid' | 'senderTransportPubkey'>,
  tokenId: string,
  observedTokenContentHash: ContentHash,
  disposition: 'VALID' | 'PENDING',
  manifest: ManifestEntryDelta,
): DispositionRecord {
  return {
    disposition,
    tokenId,
    observedTokenContentHash,
    bundleCid: input.bundleCid,
    senderTransportPubkey: input.senderTransportPubkey,
    manifest,
  };
}

function conflictingDisposition(
  input: Pick<DispositionEngineInput, 'bundleCid' | 'senderTransportPubkey'>,
  tokenId: string,
  observedTokenContentHash: ContentHash,
  manifest: ManifestEntryDelta,
  conflictingHeads: ReadonlyArray<ContentHash>,
): DispositionRecord {
  return {
    disposition: 'CONFLICTING',
    tokenId,
    observedTokenContentHash,
    bundleCid: input.bundleCid,
    senderTransportPubkey: input.senderTransportPubkey,
    manifest,
    conflictingHeads,
  };
}

/**
 * Defensive helper: compute the chain-head ContentHash. The chain-head
 * for an N-tx chain (N > 0) is the `destinationState` of the LAST
 * transaction — the post-state the head transition is anchored to. For
 * a 0-tx chain (genesis-only token) it falls back to `tokenRootHash`,
 * the only stable identifier available at genesis.
 *
 * **Why destinationState, not tokenRootHash, for non-empty chains.**
 * The §5.3 [D] conflict check at the call sites compares this value
 * with the local manifest's `rootHash` to decide CONFLICTING. Returning
 * `tokenRootHash` unconditionally has two failure modes:
 *
 *   1. A re-anchor of the same token-root CID under a new chain bypasses
 *      the conflict check (both sides match `tokenRootHash`) — even
 *      though the chain head genuinely diverged.
 *   2. Legitimately-divergent chains that share a tokenId but were
 *      hydrated from different token-roots ALWAYS trigger CONFLICTING
 *      regardless of whether their actual head states match.
 *
 * The fix: track the head state. Two chains that progressed through
 * different transitions land on different `destinationState`s; two
 * chains that converged on the same head state are NOT in conflict.
 *
 * Wrapped to never throw; defensive against a hydration that produces
 * a chain with a malformed last-element shape (defaults to
 * `tokenRootHash` rather than propagating an undefined access).
 */
function chainHeadHash(chain: HydratedChain): ContentHash {
  if (chain.chain.length === 0) {
    return chain.tokenRootHash;
  }
  const lastTx = chain.chain[chain.chain.length - 1];
  // Defensive: a malformed hydration that drops `destinationState` falls
  // back to `tokenRootHash` rather than crashing the engine. The
  // structural check at hydration time SHOULD have caught this; this
  // branch is defense-in-depth.
  if (typeof lastTx.destinationState !== 'string' || lastTx.destinationState.length === 0) {
    return chain.tokenRootHash;
  }
  return lastTx.destinationState as ContentHash;
}

// =============================================================================
// 3. Public API — processDisposition
// =============================================================================

/**
 * Walk the §5.3 decision matrix for a single token-root element and
 * return its {@link DispositionRecord}. Throws ONLY for the deferred
 * instant-mode soft-rejection (T.3 deferred-handling note); every
 * other failure mode is folded into the returned record per §5.3.
 *
 * @param input  All hooks + bundle/identity context. See
 *               {@link DispositionEngineInput}.
 *
 * @returns A {@link DispositionRecord} per §5.3.
 *
 * @throws {SphereError} `BUNDLE_REJECTED_INSTANT_MODE_NOT_YET_SUPPORTED`
 *         if `mode === 'instant'` AND any tx in the chain lacks a
 *         proof. Per the T.3 deferred-handling note, instant-mode
 *         receive is gated until the T.5.C finalization queue lands.
 */
export async function processDisposition(
  input: DispositionEngineInput,
): Promise<DispositionRecord> {
  // ---- Step 1: hydrate the chain. Try/catch wraps the hook because
  // the spec mandates STRUCTURAL_INVALID on parser throw.
  let chain: HydratedChain;
  try {
    chain = await input.hydrateChain(input.tokenRootHash, input.pool);
  } catch {
    // We do not yet know `tokenId` (hydration failed). Use the empty
    // string as the canonical "unknown tokenId" marker; the
    // observedTokenContentHash IS known (it's the input root hash)
    // and serves as the multi-rep key disambiguator per §5.4.
    return structuralInvalid(input, '', input.tokenRootHash, 'structural');
  }

  // ---- Defensive: hydration MUST produce a tokenId. A null/empty
  // tokenId from a "successful" hydration is structural defect.
  if (typeof chain.tokenId !== 'string' || chain.tokenId.length === 0) {
    return structuralInvalid(input, '', input.tokenRootHash, 'structural');
  }

  // ---- Step 0 (post-hydration): instant-mode soft-rejection.
  //
  // Why post-hydration: we need to know whether the chain has any
  // unfinalized tx, which requires hydrating to the chain shape. The
  // engine throws here; the caller (T.3.E worker pool) catches and
  // drops the bundle without a disposition record per the T.3
  // deferred-handling note.
  const unfinalizedCount = chain.chain.reduce(
    (acc, tx) => acc + (tx.inclusionProof === null ? 1 : 0),
    0,
  );
  if (input.mode === 'instant' && unfinalizedCount > 0) {
    throw new SphereError(
      `processDisposition: bundle has mode='instant' with ${unfinalizedCount} ` +
        `unfinalized tx(s) on tokenId=${chain.tokenId}; instant-mode receive ` +
        `is deferred until T.5.C finalization queue lands`,
      'BUNDLE_REJECTED_INSTANT_MODE_NOT_YET_SUPPORTED',
    );
  }

  // ---- Step 2: Continuity walk. C-continuity FIRST per acceptance
  // criterion ("the engine routes through the continuity walker
  // first, before [B]/[B'] checks"). The walker is total (returns
  // for every input, never throws on well-formed array input); we
  // still wrap defensively in try/catch in case a hostile chain
  // shape sneaks past hydration.
  let continuityResult: ContinuityResult;
  try {
    continuityResult = input.walkContinuity(chain.chain);
  } catch {
    return structuralInvalid(
      input,
      chain.tokenId,
      input.tokenRootHash,
      'structural',
    );
  }
  if (!continuityResult.ok) {
    return cryptoInvalid(
      input,
      chain.tokenId,
      input.tokenRootHash,
      'continuity-broken',
    );
  }

  // ---- Step 3: per-tx authenticator verification (W37 / Note N7).
  //
  // Verify EVERY tx's authenticator, not just the head. Mid-chain
  // forgeries are caught here.
  for (let i = 0; i < chain.chain.length; i++) {
    const tx = chain.chain[i];
    let authResult: VerifyAuthenticatorResult;
    try {
      authResult = await input.verifyAuthenticator(
        tx.authenticator,
        tx.transactionHash,
      );
    } catch {
      // Defensive: the verifier hook itself threw. Per its contract
      // (T.3.B.1), it should NEVER throw — failures surface as
      // `{ok: false, threw: true}`. A throw here means the verifier
      // adapter is buggy; we route to STRUCTURAL_INVALID rather than
      // silently fall through.
      return structuralInvalid(
        input,
        chain.tokenId,
        input.tokenRootHash,
        'structural',
      );
    }
    if (!authResult.ok) {
      // SDK-level throw (e.g., malformed signature bytes raised
      // `RangeError` inside secp256k1) → STRUCTURAL_INVALID.
      return structuralInvalid(
        input,
        chain.tokenId,
        input.tokenRootHash,
        'structural',
      );
    }
    if (!authResult.valid) {
      // Clean ECDSA failure → INVALID(`auth-invalid`) per §5.3 [C](1).
      return cryptoInvalid(
        input,
        chain.tokenId,
        input.tokenRootHash,
        'auth-invalid',
      );
    }
  }

  // ---- Step 4: per-tx inclusion-proof verification (§5.3 [C](3)).
  //
  // For every tx WITH a proof, verify it. Transactions without
  // proofs (instant-mode unfinalized, chain-mode mid-hop) advance
  // the unfinalizedCount we already computed at step 0.
  //
  // **Monotonic-proof invariant (W41 / §5.6 monotonic-graft):** proof
  // finality is monotonic over the chain — if tx[i+1] has a proof,
  // then tx[i] MUST have a proof too. Only the SUFFIX of a chain may
  // be unfinalized (instant-mode head-pending, chain-mode tail-pending).
  // A K-tx chain with valid auth on every tx but `inclusionProof:
  // null` on tx[i] (i < K-1) and a proof on some tx[j] (j > i) is
  // STRUCTURALLY a forgery — a hostile sender stripping a mid-chain
  // proof to lure the recipient into a `PENDING` state for a tx that
  // is in fact already anchored to a competing successor.
  //
  // We precompute the highest-indexed proofed tx; any null-proof tx
  // with a strictly-higher proofed sibling routes to INVALID(
  // `proof-invalid`), the same reason as a clean PATH_INVALID failure
  // — the §5.3 [C](3) family.
  let lastProofedIndex = -1;
  for (let i = chain.chain.length - 1; i >= 0; i--) {
    if (chain.chain[i].inclusionProof !== null) {
      lastProofedIndex = i;
      break;
    }
  }
  for (let i = 0; i < chain.chain.length; i++) {
    const tx = chain.chain[i];
    if (tx.inclusionProof === null) {
      // Mid-chain null-proof rejection: a strictly-later tx is anchored
      // (`lastProofedIndex > i`), so this gap violates the monotonic-
      // proof invariant and must be flagged. The check fires whether
      // or not the bundle is in instant or conservative mode — the
      // forgery is structural, not mode-specific.
      if (lastProofedIndex > i) {
        return cryptoInvalid(
          input,
          chain.tokenId,
          input.tokenRootHash,
          'proof-invalid',
        );
      }
      // Suffix-only unfinalized: this tx has no proof to verify yet.
      // The unfinalizedCount counter computed at step 0 will drive
      // the PENDING outcome at step 7.
      continue;
    }
    if (tx.requestId === null || tx.requestId === undefined) {
      // A proof exists but the requestId hydration failed. The
      // verifier needs a requestId; treat as structural defect.
      return structuralInvalid(
        input,
        chain.tokenId,
        input.tokenRootHash,
        'structural',
      );
    }

    // Audit #333 H4 — re-derive RequestId and assert the binding.
    //
    // BEFORE verifying the inclusion proof, confirm that the bundle-
    // supplied `requestId` was canonically derived from this tx's
    // (authenticator.publicKey, sourceState). Without this gate, a
    // hostile sender could pair a genuine on-chain proof (anchored
    // to some OTHER transaction's requestId) with this tx, and the
    // proof verifier would accept it — a proof-binding forgery.
    //
    // Production wiring SHOULD provide `assertRequestIdBinding`; when
    // absent we fall back to the pre-fix behaviour (a one-shot warning
    // is emitted by the wiring layer, not here, to avoid log spam).
    if (input.assertRequestIdBinding !== undefined) {
      let binding: AssertRequestIdBindingResult;
      try {
        binding = await input.assertRequestIdBinding(
          tx.requestId,
          tx.authenticator,
        );
      } catch {
        // Asserter threw — structural defect at the SDK adapter layer.
        return structuralInvalid(
          input,
          chain.tokenId,
          input.tokenRootHash,
          'proof-throw',
        );
      }
      if (!binding.ok) {
        // The (proof, requestId) pair does not bind to this tx's
        // (publicKey, sourceState). The proof may itself be a genuine
        // anchored proof — but it does not belong to this transaction.
        // §5.3 [C](3) "proof-invalid" — the same class as PATH_INVALID
        // at the verifier — is the correct routing.
        return cryptoInvalid(
          input,
          chain.tokenId,
          input.tokenRootHash,
          'proof-invalid',
        );
      }
    }

    let proofStatus: ProofVerifyStatus;
    try {
      proofStatus = await input.verifyProof(
        tx.inclusionProof,
        input.trustBase,
        tx.requestId,
      );
    } catch {
      // Defensive: the verifier hook itself threw. Mirror step 3's
      // adapter-bug path.
      return structuralInvalid(
        input,
        chain.tokenId,
        input.tokenRootHash,
        'proof-throw',
      );
    }
    if (proofStatus === 'OK') {
      // Continue to next tx.
      continue;
    }
    if (proofStatus === 'THROWN') {
      return structuralInvalid(
        input,
        chain.tokenId,
        input.tokenRootHash,
        'proof-throw',
      );
    }
    // PATH_INVALID, NOT_AUTHENTICATED, PATH_NOT_INCLUDED — ALL map
    // to `proof-invalid` at receive time per §5.3 [C](3). The
    // distinct enum values are preserved in T.3.B.1's verifier
    // output (forensic logging happens at the call site if needed).
    return cryptoInvalid(
      input,
      chain.tokenId,
      input.tokenRootHash,
      'proof-invalid',
    );
  }

  // ---- Step 5: predicate evaluation against current state
  //              (§5.3 [B] / [B']).
  //
  // The current-state predicate gates ownership. Throw routes to
  // STRUCTURAL_INVALID with reason='predicate-eval' (the §5.4
  // sub-classification distinct from generic 'structural'); a clean
  // `bindsToUs: false` routes to AUDIT(`not-our-state`).
  let predicateResult: EvaluatePredicateResult;
  try {
    predicateResult = await input.evaluatePredicate(
      chain.currentStatePredicate,
      input.ourPubkey,
    );
  } catch {
    return structuralInvalid(
      input,
      chain.tokenId,
      input.tokenRootHash,
      'predicate-eval',
    );
  }
  if (!predicateResult.ok) {
    // SDK-level throw inside the predicate engine → 'predicate-eval'.
    return structuralInvalid(
      input,
      chain.tokenId,
      input.tokenRootHash,
      'predicate-eval',
    );
  }
  if (!predicateResult.bindsToUs) {
    // Current state binds to a different identity. Per Appendix A
    // row "B-not-ours": `_audit`, reason=`not-our-state`. Whether the
    // local manifest has an entry for this tokenId is informational
    // (it affects T.3.D's promotion logic, out of scope here) — the
    // disposition record shape is the same.
    return audit(input, chain.tokenId, input.tokenRootHash, 'not-our-state');
  }

  // ---- Step 6: conflict check against the local manifest
  //              (§5.3 [D]).
  //
  // The lex-min tie-break for genuinely-divergent chains (T.3.D)
  // is out of scope for this wave; here we just emit the CONFLICTING
  // record shape with both heads so the downstream conflict-merger
  // can take over.
  let localManifest: ManifestEntryDelta | undefined;
  try {
    localManifest = await input.readLocalManifest(chain.tokenId);
  } catch {
    // Storage corruption — defensive STRUCTURAL_INVALID. The token
    // disposition is unrecoverable until the storage layer is fixed.
    return structuralInvalid(
      input,
      chain.tokenId,
      input.tokenRootHash,
      'structural',
    );
  }

  const newHead = chainHeadHash(chain);
  if (
    localManifest !== undefined &&
    localManifest.rootHash !== newHead &&
    localManifest.status !== 'invalid'
  ) {
    // Two distinct heads for the same tokenId. T.3.D refines this
    // with proof-grafting / lex-min tie-break; here we emit the
    // CONFLICTING shape with both heads. The §5.3 [D-conflict]
    // paragraph specifies `conflictingHeads[]` is the merged set.
    const incomingConflicts = localManifest.conflictingHeads ?? [];
    const conflictingHeads: ContentHash[] = [
      localManifest.rootHash,
      ...incomingConflicts,
    ];

    // (Wave 3 steelman) Pending + conflicting head race.
    //
    // If the local manifest is already in `pending` state, an in-flight
    // T.5.C finalization worker is tracking the queue entries for the
    // existing head (rootHash X). Blindly writing a CONFLICTING entry
    // with the new head (rootHash Y) clobbers the pending state — but
    // the worker continues polling the aggregator for X's requestIds.
    // When proofs land, the worker writes against a manifest that now
    // claims Y is the authoritative head and X is in `conflictingHeads`.
    // The result is a stale write that races the conflict-merger.
    //
    // Defer full conflict-merge by emitting a distinct
    // `'pending-conflicting'` status. Downstream conflict-merger code
    // reads it the same as `'conflicting'` (both heads are surfaced)
    // but worker / manifest-writer paths can recognize the in-flight
    // finalization and either:
    //  - drain the queue first, then transition to plain `conflicting`
    //  - or invalidate the worker's tracked entries on demand
    //
    // The `'pending-conflicting'` status is purely manifest-state —
    // the disposition discriminator stays `CONFLICTING` so the writer
    // routes to the active pool's conflict resolution path.
    const conflictingStatus: 'conflicting' | 'pending-conflicting' =
      localManifest.status === 'pending' ? 'pending-conflicting' : 'conflicting';

    return conflictingDisposition(
      input,
      chain.tokenId,
      input.tokenRootHash,
      {
        rootHash: newHead,
        status: conflictingStatus,
        conflictingHeads,
      },
      conflictingHeads,
    );
  }

  // ---- Step 7: spent-check / pending terminal (§5.3 [E]).
  //
  // The unfinalizedCount we computed at step 0 drives the PENDING
  // outcome. For fully-finalized chains we ask the oracle whether
  // the current destination state has been spent off-record.
  if (unfinalizedCount > 0) {
    return manifestDisposition(
      input,
      chain.tokenId,
      input.tokenRootHash,
      'PENDING',
      {
        rootHash: newHead,
        status: 'pending',
      },
    );
  }

  let isSpent: boolean;
  try {
    isSpent = await input.oracleIsSpent(chain.currentDestinationStateHash);
  } catch {
    // Per §5.3 [A] paragraph 2 ("if cryptographic verification
    // routines throw rather than return a status, the disposition is
    // STRUCTURAL_INVALID"). The spec treats oracle.isSpent() as a
    // boolean answer, not a verification routine, but a throw here
    // means the recipient cannot decide between VALID and AUDIT —
    // the safer default is STRUCTURAL_INVALID with `reason='structural'`.
    // The §5.5 step 9 finalization re-run will retry the oracle call
    // when a later bundle arrives.
    return structuralInvalid(
      input,
      chain.tokenId,
      input.tokenRootHash,
      'structural',
    );
  }
  if (isSpent) {
    // Off-record spend → AUDIT(`off-record-spend`) per §5.3 [E] and
    // Appendix A row "E-unspendable".
    return audit(
      input,
      chain.tokenId,
      input.tokenRootHash,
      'off-record-spend',
    );
  }

  // All checks pass: VALID. The manifest delta carries the new head;
  // the writer (T.3.C) stamps Lamport / bundleCid / senderTransportPubkey
  // on its own per §5.4 metadata-preservation rules.
  return manifestDisposition(
    input,
    chain.tokenId,
    input.tokenRootHash,
    'VALID',
    {
      rootHash: newHead,
      status: 'valid',
    },
  );
}

// =============================================================================
// 4. revaluate — §5.5 step 9 entry point (W5)
// =============================================================================

/**
 * Input for {@link revaluate} — the §5.5 step 9 "queue-drain → status
 * transition" re-evaluator.
 *
 * Distinct from {@link DispositionEngineInput} because the re-evaluation
 * runs against the recipient's MERGED LOCAL state, not against an
 * incoming bundle:
 *  - There is no `bundleCid` / `senderTransportPubkey` for the merged
 *    chain (the merge may have folded multiple bundles together — there
 *    is no canonical "originating" bundle for the merged state). The
 *    caller passes through the `bundleCidForProvenance` that should be
 *    stamped on the resulting manifest delta if VALID/PENDING is
 *    surfaced; production wires this to the most-recent-arrived
 *    bundle's CID.
 *  - The `mode` discriminator does not gate (re-evaluation by definition
 *    runs after every queue entry resolved successfully — there are no
 *    unfinalized txs left). The hook stays for hydration parity.
 *  - The hooks set is the [B] / [D] / [E] subset; the [A] / [C]
 *    cryptographic checks already passed at first ingest and the chain
 *    content has only ACCRUED proofs since (monotonic-graft invariant
 *    per §5.6) — the merger never invalidates a previously-valid
 *    proof.
 */
export interface DispositionRevaluateInput {
  // ---- Pool / token context ----
  readonly tokenRootHash: ContentHash;
  readonly pool: ReadonlyMap<ContentHash, UxfElement>;
  /** Provenance to stamp on the resulting manifest delta (if any).
   *  Production passes the most-recent-arrived bundle's CID. */
  readonly bundleCidForProvenance: string;
  /** Provenance to stamp on the resulting manifest delta (if any). */
  readonly senderTransportPubkeyForProvenance: string;
  // ---- Recipient identity ----
  readonly ourPubkey: Uint8Array;
  // ---- Injected hooks (subset of full DispositionEngineInput) ----
  readonly hydrateChain: HydrateChainFn;
  readonly readLocalManifest: ReadLocalManifestFn;
  readonly evaluatePredicate: EvaluatePredicateFn;
  readonly oracleIsSpent: OracleIsSpentFn;
}

/**
 * Re-evaluate a token's §5.3 disposition after its finalization queue
 * has fully drained — the §5.5 step 9 "queue-drain → status transition"
 * entry point (W5).
 *
 * Distinct from {@link processDisposition}:
 *  - Skips [A] hydration-throw routing → STRUCTURAL_INVALID is still
 *    surfaced on hydration failure but every other [A]/[C] cryptographic
 *    check is OMITTED — the chain has only accrued proofs since first
 *    ingest, and the §5.6 monotonic-graft invariant guarantees any
 *    previously-valid proof remains valid.
 *  - Re-runs [B] (current-state predicate target), [D] (conflict check
 *    against the local manifest), and [E] (oracle.isSpent on the
 *    now-finalized current state). These are exactly the three checks
 *    §5.5 step 9 mandates re-running.
 *  - Returns either:
 *     - `VALID`        — all checks pass.
 *     - `AUDIT('not-our-state')` — [B] surfaces NOT_OUR_CURRENT_STATE.
 *     - `CONFLICTING`  — [D] surfaces a CONFLICTING merge.
 *     - `AUDIT('off-record-spend')` — [E] returns isSpent=true.
 *     - `INVALID('structural')` / `'predicate-eval'` — defensive
 *       routing for hook throws.
 *
 * The re-evaluator NEVER returns `PENDING` — by §5.5 step 9 invariant,
 * the queue is fully drained before invocation. If the caller invokes
 * with un-drained queue entries, the residual unfinalized txs in the
 * chain would surface PENDING in {@link processDisposition} but we
 * route to STRUCTURAL_INVALID here (caller bug — must drain first).
 *
 * **Pure routing** — the function performs NO storage writes; the
 * caller (T.5.C worker) routes the returned `DispositionRecord` to the
 * disposition writer (T.3.C). The returned record's `bundleCid` /
 * `senderTransportPubkey` are taken from the input's provenance fields.
 */
export async function revaluate(
  input: DispositionRevaluateInput,
): Promise<DispositionRecord> {
  // Adapter: most of the §5.3 routing helpers above expect a
  // `bundleCid` + `senderTransportPubkey` shape; the re-evaluator
  // synthesizes one from its provenance fields. (Re-using the same
  // builders keeps the reason-string set canonical.)
  const provenance = {
    bundleCid: input.bundleCidForProvenance,
    senderTransportPubkey: input.senderTransportPubkeyForProvenance,
  } as const;

  // ---- Step 1: hydrate the chain. Hydration throw → STRUCTURAL_INVALID.
  let chain: HydratedChain;
  try {
    chain = await input.hydrateChain(input.tokenRootHash, input.pool);
  } catch {
    return structuralInvalid(provenance, '', input.tokenRootHash, 'structural');
  }

  if (typeof chain.tokenId !== 'string' || chain.tokenId.length === 0) {
    return structuralInvalid(provenance, '', input.tokenRootHash, 'structural');
  }

  // §5.5 step 9 invariant: caller MUST have drained the queue. Defensive
  // check: if any tx still lacks a proof, route to STRUCTURAL_INVALID
  // — the caller is buggy, not the chain.
  const unfinalizedCount = chain.chain.reduce(
    (acc, tx) => acc + (tx.inclusionProof === null ? 1 : 0),
    0,
  );
  if (unfinalizedCount > 0) {
    return structuralInvalid(
      provenance,
      chain.tokenId,
      input.tokenRootHash,
      'structural',
    );
  }

  // ---- Step 5 [B]: predicate evaluation against current state.
  let predicateResult;
  try {
    predicateResult = await input.evaluatePredicate(
      chain.currentStatePredicate,
      input.ourPubkey,
    );
  } catch {
    return structuralInvalid(
      provenance,
      chain.tokenId,
      input.tokenRootHash,
      'predicate-eval',
    );
  }
  if (!predicateResult.ok) {
    return structuralInvalid(
      provenance,
      chain.tokenId,
      input.tokenRootHash,
      'predicate-eval',
    );
  }
  if (!predicateResult.bindsToUs) {
    return audit(
      provenance,
      chain.tokenId,
      input.tokenRootHash,
      'not-our-state',
    );
  }

  // ---- Step 6 [D]: conflict check against the local manifest.
  let localManifest: ManifestEntryDelta | undefined;
  try {
    localManifest = await input.readLocalManifest(chain.tokenId);
  } catch {
    return structuralInvalid(
      provenance,
      chain.tokenId,
      input.tokenRootHash,
      'structural',
    );
  }

  const newHead = chainHeadHash(chain);
  if (
    localManifest !== undefined &&
    localManifest.rootHash !== newHead &&
    localManifest.status !== 'invalid'
  ) {
    const incomingConflicts = localManifest.conflictingHeads ?? [];
    const conflictingHeads: ContentHash[] = [
      localManifest.rootHash,
      ...incomingConflicts,
    ];
    // (Wave 3 steelman) Mirror the `processDisposition` pending-
    // conflicting routing. By spec §5.5 step 9 invariant the queue is
    // drained before revaluate runs — but a caller bug or a CRDT merge
    // arriving mid-revaluate could surface a residual `pending` status,
    // and the same race rationale applies.
    const conflictingStatus: 'conflicting' | 'pending-conflicting' =
      localManifest.status === 'pending' ? 'pending-conflicting' : 'conflicting';
    return conflictingDisposition(
      provenance,
      chain.tokenId,
      input.tokenRootHash,
      {
        rootHash: newHead,
        status: conflictingStatus,
        conflictingHeads,
      },
      conflictingHeads,
    );
  }

  // ---- Step 7 [E]: spent-check on the now-finalized current state.
  let isSpent: boolean;
  try {
    isSpent = await input.oracleIsSpent(chain.currentDestinationStateHash);
  } catch {
    return structuralInvalid(
      provenance,
      chain.tokenId,
      input.tokenRootHash,
      'structural',
    );
  }
  if (isSpent) {
    return audit(
      provenance,
      chain.tokenId,
      input.tokenRootHash,
      'off-record-spend',
    );
  }

  return manifestDisposition(
    provenance,
    chain.tokenId,
    input.tokenRootHash,
    'VALID',
    {
      rootHash: newHead,
      status: 'valid',
    },
  );
}

// =============================================================================
// 5. Re-exports (for caller convenience)
// =============================================================================

export type { ContentHash, UxfElement } from '../bundle/types.js';
export type {
  DispositionRecord,
  ManifestEntryDelta,
} from '../types/disposition.js';
