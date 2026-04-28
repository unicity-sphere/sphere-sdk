/**
 * Proof verifier — UXF Inter-Wallet Transfer recipient (T.3.B.1).
 *
 * Pure-function wrapper around the SDK's `InclusionProof.verify(trustBase,
 * requestId)` that the §5.3 [C](3) decision-matrix walker (T.3.B.2)
 * calls per transaction to determine whether the supplied inclusion
 * proof actually witnesses the claimed `(authenticator, transactionHash)`
 * tuple in the aggregator's anchored Sparse Merkle Tree.
 *
 * **GRANULAR STATUS, not boolean**. Unlike the legacy
 * `OracleProvider.verifyInclusionProof` (which collapses every non-OK
 * result into `false` for the Wave G.3 token-join enrichment use), this
 * verifier returns the original `InclusionProofVerificationStatus`
 * unchanged so the decision-matrix walker can route differently:
 *
 *   - `OK`                 — proof verifies; tx is anchored. Walker
 *                            proceeds.
 *   - `PATH_INVALID`       — proof structurally invalid (corrupt SMT
 *                            path or unicity certificate). Walker
 *                            maps to `DispositionReason: 'proof-
 *                            invalid'`.
 *   - `NOT_AUTHENTICATED`  — authenticator does not match the proof's
 *                            internal claim (the proof is for a
 *                            different `(pubkey, stateHash)` tuple).
 *                            Walker maps to `'proof-invalid'`.
 *   - `PATH_NOT_INCLUDED`  — SMT proof of NON-inclusion (the
 *                            aggregator never anchored this tx). At
 *                            §6.1 SUBMIT TIME this is transient (the
 *                            commitment may anchor on a later round);
 *                            at RECEIVE TIME (this module) the proof
 *                            is supposed to attest a finalized tx, so
 *                            shipping a non-inclusion proof IS a
 *                            structural lie. Walker maps to
 *                            `'proof-invalid'` per §5.3 [C](3) — see
 *                            the explicit mapping discussion below.
 *   - `THROWN`             — the SDK call raised. Walker maps to
 *                            `DispositionReason: 'proof-throw'`.
 *
 * **PATH_NOT_INCLUDED at receive vs at submit (§5.3 [C](3) vs §6.1)**:
 *
 *   At SUBMIT time (the sender side, `preflight-finalize.ts`), the
 *   sender polls the aggregator until either anchored (`OK`) or the
 *   polling window expires (`oracle-rejected`). PATH_NOT_INCLUDED is
 *   transient there.
 *
 *   At RECEIVE time (this module), the sender has SHIPPED a proof
 *   along with the bundle, and the recipient verifies it. The sender
 *   should only ship `OK`-able proofs (proofs of anchored txs). If
 *   the recipient gets a `PATH_NOT_INCLUDED` outcome, EITHER the
 *   sender shipped a stale proof from a tx that ended up un-anchored
 *   (after the polling window — a sender bug), OR a malicious sender
 *   shipped a synthetic proof of non-inclusion claiming anchorage.
 *   Either way, the bundle is invalid and the disposition is
 *   `proof-invalid`, NOT `oracle-rejected` (which is a polling-window
 *   timeout signal, not a structural lie).
 *
 *   This mapping is THE CALLER'S RESPONSIBILITY. This module returns
 *   the literal `'PATH_NOT_INCLUDED'` status so the walker can apply
 *   §5.3 [C](3) without ambiguity. Returning a pre-mapped
 *   `'proof-invalid'` here would conflate the two distinct scenarios
 *   (PATH_INVALID vs PATH_NOT_INCLUDED), losing forensic information.
 *
 * Spec references:
 *   - §5.3 [C](3) — proof verify failure → INVALID (`proof-invalid`).
 *                    PATH_NOT_INCLUDED at receive maps to
 *                    `proof-invalid`, NOT `oracle-rejected`.
 *   - §5.3 [A]    — verifier throw → INVALID (`proof-throw`).
 *   - §6.1        — distinct meaning of PATH_NOT_INCLUDED at submit
 *                    (transient → `oracle-rejected`).
 *
 * **What this module does NOT do**: hydrate the InclusionProof from
 * pool-element CBOR/JSON (the walker's job); construct the RequestId
 * from the authenticator (also the walker's job — for non-inclusion
 * proofs lacking an authenticator, the walker passes a derived id);
 * cache results (the per-tx call rate is single-digit per bundle —
 * caching adds complexity without measurable wins at this layer).
 *
 * @packageDocumentation
 */

import type { InclusionProof } from '@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof';
import { InclusionProofVerificationStatus } from '@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof';
import type { RequestId } from '@unicitylabs/state-transition-sdk/lib/api/RequestId';
import type { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase';

// =============================================================================
// 1. Public types
// =============================================================================

/**
 * The five possible outcomes of {@link verifyProof}. Four mirror the
 * SDK's `InclusionProofVerificationStatus` enum, plus `'THROWN'` for
 * "the SDK call raised an exception".
 *
 * Why string-literal union, not the SDK enum:
 *
 *   The SDK's `InclusionProofVerificationStatus` is a TS `enum`. Re-
 *   exporting it is fragile across SDK upgrades (enum values are
 *   numeric in some build modes). This module pins the four canonical
 *   statuses as string literals so the on-wire / forensic record
 *   shape is stable. Plus `'THROWN'` is OUR addition — not part of
 *   the SDK's enum — so a separate union is cleaner than mixing.
 *
 * Mutual exclusion is a tagged-union property; the result of
 * {@link verifyProof} is exactly one of the five.
 */
export type ProofVerifyStatus =
  | 'OK'
  | 'PATH_INVALID'
  | 'NOT_AUTHENTICATED'
  | 'PATH_NOT_INCLUDED'
  | 'THROWN';

// =============================================================================
// 2. Public API — verifyProof
// =============================================================================

/**
 * Verify ONE inclusion proof. The walker calls this once per
 * transaction (mirror of `verifyAuthenticator`'s per-tx contract).
 *
 * **Pure function** (modulo the SDK call): no I/O, no global state,
 * no mutation of the inputs. The SDK's `InclusionProof.verify`
 * implementation is read-only over its trustBase + requestId — but we
 * defensively assume nothing (the wrapper would still be sound if a
 * future SDK build introduced caching or memoization).
 *
 * @param proof       The hydrated SDK `InclusionProof`. The walker
 *                    builds it via `InclusionProof.fromJSON()` from
 *                    the pool's `inclusion-proof` element + its
 *                    `authenticator` and `merkle-tree-path` /
 *                    `unicity-certificate` children, all wired
 *                    together by `assembleInclusionProof()` in
 *                    `uxf/assemble.ts`. This module never decodes
 *                    raw CBOR.
 * @param trustBase   The bundled `RootTrustBase` for the network.
 *                    Comes from `OracleProvider.getRootTrustBase()`
 *                    or equivalent — the same trust base the rest of
 *                    the SDK uses (Pointer-layer H6).
 * @param requestId   The SDK `RequestId` derived from the proof's
 *                    authenticator (or, for non-inclusion proofs
 *                    without an authenticator, derived by the walker
 *                    from external state). The verify call binds the
 *                    proof to this id.
 *
 * @returns A {@link ProofVerifyStatus} string literal.
 *
 * @remarks
 *
 * **Try/catch contract**. The wrapper catches every exception class
 * — including SDK-internal RangeError on malformed CBOR, async
 * rejections from underlying network/crypto primitives, and custom
 * SDK exceptions. All collapse into `'THROWN'` so the walker can
 * route them to `DispositionReason: 'proof-throw'`.
 *
 * **PATH_NOT_INCLUDED is reported as itself**, not pre-mapped to
 * `proof-invalid`. The CALLER (T.3.B.2) is responsible for the
 * receive-time mapping per §5.3 [C](3): PATH_NOT_INCLUDED at receive
 * → `proof-invalid`. We keep them separate at this layer so a future
 * use case (e.g., explicit non-inclusion proofs in a different
 * protocol leg) can branch differently without reworking this
 * module.
 *
 * **Defensive arg validation**. Null/undefined inputs surface as
 * `'THROWN'` with the defensive TypeError eaten by the catch. The
 * walker should never reach those branches with correct hydration.
 *
 * **Status-to-string mapping**. The SDK's enum values are string
 * literals (`"OK"`, `"PATH_INVALID"`, `"NOT_AUTHENTICATED"`,
 * `"PATH_NOT_INCLUDED"`) — we identity-check rather than re-encode.
 * If a future SDK rev adds a new status string, it falls through to
 * a defensive `'THROWN'` (we can't accept an unknown status as
 * structurally valid).
 */
export async function verifyProof(
  proof: InclusionProof,
  trustBase: RootTrustBase,
  requestId: RequestId,
): Promise<ProofVerifyStatus> {
  try {
    if (proof === null || proof === undefined) {
      throw new TypeError('verifyProof: proof is null/undefined');
    }
    if (trustBase === null || trustBase === undefined) {
      throw new TypeError('verifyProof: trustBase is null/undefined');
    }
    if (requestId === null || requestId === undefined) {
      throw new TypeError('verifyProof: requestId is null/undefined');
    }
    if (typeof proof.verify !== 'function') {
      throw new TypeError('verifyProof: proof.verify is not a function');
    }

    const status = await proof.verify(trustBase, requestId);

    // Map the SDK enum to our string-literal union. The four enum
    // values are stable across SDK builds (string-valued enum), so
    // the comparison is exact-string. Any other status (defensive
    // future-proof) falls through to THROWN.
    if (status === InclusionProofVerificationStatus.OK) {
      return 'OK';
    }
    if (status === InclusionProofVerificationStatus.PATH_INVALID) {
      return 'PATH_INVALID';
    }
    if (status === InclusionProofVerificationStatus.NOT_AUTHENTICATED) {
      return 'NOT_AUTHENTICATED';
    }
    if (status === InclusionProofVerificationStatus.PATH_NOT_INCLUDED) {
      return 'PATH_NOT_INCLUDED';
    }
    // Defensive: a future SDK rev introduces a new status. We refuse
    // to accept it as valid — the walker will see this as a structural
    // failure and route to `proof-throw`. Adding a new branch here
    // is a deliberate spec change.
    throw new RangeError(
      `verifyProof: unknown InclusionProofVerificationStatus: ${String(status)}`,
    );
  } catch {
    // We deliberately discard the original error here: the walker's
    // `_invalid` record schema does not carry raw error objects, only
    // a disposition string. Operators can still see the originating
    // exception in console / logger output if a logger is wired in
    // upstream — this module is pure, no logger dependency.
    return 'THROWN';
  }
}
