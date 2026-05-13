/**
 * Continuity walker — UXF Inter-Wallet Transfer recipient (T.3.B.1).
 *
 * Implements the §5.3 [C](2) source-state continuity check (Note C8).
 * Walks a token's full transaction chain in order and asserts that
 * every transition's `sourceState` matches its predecessor's
 * `destinationState`:
 *
 *   for every i in [1 .. chain.length - 1]:
 *     chain[i].sourceState === chain[i - 1].destinationState
 *
 * If ANY link breaks, the walker returns the first broken index along
 * with the canonical `'continuity-broken'` disposition reason. The
 * decision-matrix walker (T.3.B.2) lifts this into a `DispositionReason
 * .continuity-broken` invalid record per §5.3 [C](2) routing.
 *
 * Why the walker is its own pure function rather than inline at the
 * walker (T.3.B.2):
 *
 *   - **Adversarial isolation**. C8 is a SECURITY check: a hostile
 *     sender can paste an unrelated `transaction` element into the
 *     middle of a chain, shipping a chain whose latest tx looks valid
 *     in isolation (its authenticator + proof verify) but which
 *     continues from a completely different token's mid-history. If
 *     this check is buried inside the decision-matrix walker, a
 *     refactor or off-by-one is easy to miss. As its own module with
 *     its own adversarial test (`broken-continuity.test.ts`), the
 *     check is hardened.
 *
 *   - **Pure data structure walk**. No SDK calls, no async, no I/O.
 *     The walker reads two fields per tx (`sourceState`,
 *     `destinationState`) and compares them as opaque ContentHash
 *     strings. This makes it the simplest of the four T.3.B.1
 *     verifiers and the most easily fuzzable.
 *
 *   - **First-broken-index reporting**. The walker returns the
 *     smallest index where the invariant fails so logs and forensic
 *     records pinpoint the splice point — useful for distinguishing
 *     "head spliced" from "deep middle spliced" attacks.
 *
 * Spec references:
 *   - §5.3 [C](2)  — source-state continuity invariant; on failure,
 *                    the disposition is `'continuity-broken'`.
 *   - Note C8      — full-chain walk is mandatory; head-only check
 *                    (which trivially passes for any single-tx chain)
 *                    is insufficient.
 *
 * **What this module does NOT do**: hydrate transactions from pool
 * elements (the walker passes already-resolved `TxLike` records);
 * verify any cryptographic property of a transaction (continuity is
 * structural, not cryptographic — `authenticator-verifier.ts` and
 * `proof-verifier.ts` cover the crypto layer).
 *
 * @packageDocumentation
 */

// =============================================================================
// 1. Public types
// =============================================================================

/**
 * The minimal shape this walker needs from a transaction. The walker
 * uses ContentHash strings as opaque identifiers — they may be the
 * canonical 64-char hex content hashes from the UXF pool, or any
 * other equality-comparable string the caller chooses to thread
 * through. The contract is purely structural: two transitions
 * "continue" iff `tx[i].sourceState === tx[i - 1].destinationState`
 * under JavaScript `===`.
 *
 * **Why string comparison, not byte comparison**: ContentHash is a
 * branded string type in this codebase (`uxf/types.ts`). The pool's
 * keys are these branded strings; the transaction-element's
 * `sourceState`/`destinationState` children are also these strings.
 * String `===` is the canonical equality check for branded strings
 * and matches `Map<ContentHash, _>` keying semantics. Comparing
 * underlying bytes would require decoding back to bytes only to
 * re-encode, gaining nothing.
 */
export interface TxLike {
  /** ContentHash of the token-state that is the input (pre-state). */
  readonly sourceState: string;
  /** ContentHash of the token-state that is the output (post-state). */
  readonly destinationState: string;
}

/**
 * Two-arm discriminated outcome of {@link walkContinuity}.
 *
 *  - `ok: true`  — the chain is contiguous (or trivially so: empty,
 *                  single-tx).
 *  - `ok: false` — at least one link is broken. `brokenAt` is the
 *                  smallest index where the invariant fails (always
 *                  `≥ 1` because index 0 has no predecessor); `reason`
 *                  is the canonical disposition string the walker
 *                  upstream maps to `_invalid` storage.
 *
 * The `reason` is always the literal `'continuity-broken'` —
 * declaring it as a typed field rather than free string lets the
 * type checker catch typos at the call site (T.3.B.2's matrix), and
 * locks the on-wire form exactly to the value in `DISPOSITION_REASONS`
 * from `types/disposition.ts`.
 */
export type ContinuityResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly brokenAt: number;
      readonly reason: 'continuity-broken';
    };

// =============================================================================
// 2. Public API — walkContinuity
// =============================================================================

/**
 * Walk a transaction chain and assert source-state continuity for
 * every adjacent pair. The walker is total (returns for every input,
 * never throws); pre- and post-conditions:
 *
 *   - **Pre**: `chain` is a finite, indexable, defined collection.
 *              Each entry MUST have `sourceState` and
 *              `destinationState` defined as strings — entries with
 *              `null`/`undefined` references are treated as broken
 *              links (the genesis-style `null` source is the caller's
 *              responsibility to filter; this walker compares them
 *              with `===` and a `null` will fail to equal a string,
 *              tripping the broken-at result correctly).
 *   - **Post**: returns `{ok: true}` IFF every adjacent pair is
 *              equal under `===`, OR the chain has 0 or 1 elements.
 *
 * **Genesis tx is allowed any sourceState**. The first transaction's
 * `sourceState` is the genesis-state ContentHash; we do NOT compare
 * it against anything (no predecessor exists). Index 0 is therefore
 * trivially valid; the loop starts at 1.
 *
 * **Empty chain is `ok: true`**. A token with zero transactions in
 * its chain is valid for the continuity check (it has no transitions
 * that could break). Whether such a token is meaningful for the
 * downstream walker is a separate question (a zero-tx chain means
 * the token is at genesis state — §5.3 [B] still applies).
 *
 * **First-broken-index semantics**. Returns the smallest `i` where
 * `chain[i].sourceState !== chain[i - 1].destinationState`. If
 * multiple breaks exist, only the FIRST is reported — the walker
 * upstream can decide whether to log all breaks (it has the chain
 * available) or just the first.
 *
 * **No SDK call, no async, no exceptions**. This is the simplest
 * verifier in T.3.B.1: pure synchronous string equality. Any throw
 * out of this function indicates a programmer error (e.g., handing
 * it `undefined` for `chain`) — JavaScript's standard "cannot read
 * property of undefined" propagates up.
 *
 * @param chain  The token's transaction list, in chain order
 *               (index 0 = oldest = genesis-adjacent; last index =
 *               newest = head). Empty array is permitted.
 *
 * @returns A discriminated {@link ContinuityResult}. The walker
 *          maps `ok: false` to `DispositionReason: 'continuity-
 *          broken'` per §5.3 [C](2). On `ok: true` the walker
 *          proceeds to per-tx ECDSA + proof verification.
 */
export function walkContinuity(chain: ReadonlyArray<TxLike>): ContinuityResult {
  // Defensive: not a typed throw, but an early structural reject if
  // someone hands us a non-array. JavaScript's `Array.isArray` is the
  // canonical "is this an array-like indexable collection" check.
  // We purposely do NOT silently coerce — if the caller's invariants
  // are violated (handing us `null`, `undefined`, an object, ...) the
  // resulting TypeError surfaces at the call site rather than being
  // masked as a phantom `ok: true`.
  if (!Array.isArray(chain)) {
    throw new TypeError(
      `walkContinuity: chain must be an array (got: ${typeof chain})`,
    );
  }

  const length = chain.length;

  // Trivially valid chains: 0 or 1 transactions have no adjacent
  // pair to violate the invariant.
  if (length <= 1) {
    return { ok: true };
  }

  // Walk the chain starting at i = 1; index 0 has no predecessor and
  // its `sourceState` references the genesis state, which is
  // structurally valid (the genesis is part of the token-root's
  // children, not a previous transaction). We compare each tx's
  // `sourceState` against the previous tx's `destinationState`.
  for (let i = 1; i < length; i++) {
    const prev = chain[i - 1];
    const curr = chain[i];

    // Defensive: a sparse or partial entry surfaces as a broken
    // link (string `===` against undefined is always false). The
    // walker's contract is "compare with ===" so we don't try to
    // be clever about partial entries.
    if (curr.sourceState !== prev.destinationState) {
      return {
        ok: false,
        brokenAt: i,
        reason: 'continuity-broken',
      };
    }
  }

  return { ok: true };
}
