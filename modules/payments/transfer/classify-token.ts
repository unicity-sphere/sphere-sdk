/**
 * Token classification — UXF Inter-Wallet Transfer (T.2.B).
 *
 * **Single source of truth** (C11) for the canonical asset-class predicate
 * defined in §4.1 of `docs/uxf/UXF-TRANSFER-PROTOCOL.md`:
 *
 *     isNft(token) = token.coins === null
 *                 || token.coins === undefined
 *                 || token.coins.length === 0
 *
 * A token is an **NFT** iff it has empty / null `coinData` (no fungible
 * coin entries). A token is a **coin** iff it has at least one fungible
 * coin entry. Coin and NFT tokens are class-disjoint per the canonical
 * model — no token carries both.
 *
 * # ⚠ INVARIANT — NORMALIZE-BEFORE-CLASSIFY (Wave 3 steelman fix #170 issue 8)
 *
 * `classifyToken` is **PURE on its projection input**. Its correctness
 * depends on the caller having already pruned zero-amount coin entries
 * from `coins[]`. The classifier itself does NOT prune (the comment on
 * `classifyToken` notes this; the file-level comment now elevates it to
 * a load-bearing invariant for cascade-walker / disposition-engine
 * consumers):
 *
 *   - **A token with `coinData = [["UCT", "0"]]` (single zero-amount
 *     entry) is semantically an NFT** — the zero-amount entry contributes
 *     no fungible balance. But if the projection is constructed without
 *     pruning (e.g. `Array.isArray(coinData) && coinData.length > 0` check
 *     used at instant-sender.ts:391, conservative-sender.ts:391, txf-sender.ts:375),
 *     the resulting `TokenLike.coins` may carry the `[{coinId: "UCT",
 *     amount: 0n}]` entry — `coins.length > 0`, so `classifyToken` returns
 *     `'coin'`. The SDK class-based view (which drops zero entries at
 *     ingest time per §4.1) would consider it an NFT — class disjointness
 *     is now violated downstream.
 *
 *   - **Mitigation**: every cascade walker / disposition path MUST run
 *     `normalizeCoinData()` BEFORE calling `classifyToken`. The
 *     target-validator partition already does this defensively (see
 *     `partitionSources` line 173). Cascade-walker, disposition-engine,
 *     and disposition writer paths inherit the invariant via projections
 *     that filter `c.amount > 0n` (instant-sender / conservative-sender /
 *     txf-sender's `defaultTokenLike` already do this; legacy-shape-
 *     adapter projections route through normalizeCoinData transitively
 *     via the validator).
 *
 *   - **Auditing rule**: search for callers of `classifyToken(...)` and
 *     verify each call-site's input has either:
 *       (a) flowed through `normalizeCoinData()` directly, OR
 *       (b) been built via a projection that filters zero-amount entries.
 *     A `classifyToken(t)` on a raw `TokenLike` whose projection rule is
 *     unknown is a CORRECTNESS BUG, not a hot-path optimization.
 *
 * @remarks
 * Every consumer of the canonical predicate routes through this module:
 *  - `target-validator.ts`     — §4.1 step 1 source-class enforcement.
 *  - cascade walker (T.5.B.5)  — coin path uses `splitParent`; NFT path
 *                                uses outbox-driven notification.
 *  - `importInclusionProof()`  — T.5.D revalidates cascaded children.
 *
 * If you find yourself writing `!token.coins?.length` outside this file,
 * STOP and import {@link classifyToken} instead. C11 was applied
 * specifically to make subtle class violations impossible.
 *
 * Spec references:
 * - §4.1 "Class predicate (normative)" paragraph.
 * - §4.1 "Implementations MUST prune zero-amount entries" paragraph (the
 *   normalization rule {@link normalizeCoinData} enforces).
 * - §11.2 multi-asset cases (the validation tests that bind these helpers
 *   to the rejection cases).
 *
 * Purity: every function here is pure. No I/O. No mutation. Returns new
 * values; never mutates the input.
 */

// =============================================================================
// 1. Structural projection — TokenLike
// =============================================================================

/**
 * Structural projection used by the multi-asset target validator.
 *
 * Both the SDK's class-based `Token` and synthetic test fixtures satisfy
 * this shape. Callers project to {@link TokenLike} once at the validator
 * boundary so the validator itself stays decoupled from SDK internals
 * (and remains pure / trivially testable).
 *
 * @remarks
 * - {@link coins} is the post-prune list of fungible coin entries. The
 *   projection MUST drop zero-amount entries (per §4.1 ingest-time
 *   pruning rule); {@link normalizeCoinData} performs this defensively
 *   at validation entry.
 * - {@link pending} is `true` iff the token's history contains an
 *   unfinalized predecessor transaction (no `inclusionProof`). Used by
 *   the §4.1 step 2 NFT cascade asymmetry warning.
 * - {@link ownedBySender} is the result of evaluating the current-state
 *   predicate against the sender's identity. The validator treats
 *   `false` and `undefined` differently: `undefined` means "not
 *   evaluated; trust the caller's pool filter"; `false` means
 *   "explicitly does not bind to sender → reject".
 */
export interface TokenLike {
  /** Canonical token identifier (hex). For NFTs, this is the NFT's
   *  identity-bearing tokenId. For coins, this is the per-token unique
   *  id assigned at mint / split time. */
  readonly id: string;
  /** Post-prune list of coin entries. `null` or empty array → NFT.
   *  Each entry's `amount` MUST be a positive bigint (zero-amount
   *  entries are pruned by {@link normalizeCoinData}). */
  readonly coins: ReadonlyArray<TokenLikeCoin> | null;
  /** `true` iff the token has at least one unfinalized predecessor
   *  transaction in its history (status `pending`). Optional; absent =
   *  treated as "not pending". */
  readonly pending?: boolean;
  /** Result of evaluating the current-state predicate against the
   *  sender. Optional; absent = treated as "owned" (caller-pool filter
   *  precondition). `false` = explicitly not owned → reject the source
   *  for any target. */
  readonly ownedBySender?: boolean;
}

/**
 * Single fungible coin entry on a {@link TokenLike}. The structural
 * representation chosen here (string `coinId` + bigint `amount`) keeps
 * the validator decoupled from SDK class instances (`CoinId`,
 * `TokenCoinData`) while preserving the spec's bigint semantics for
 * positive-amount checks.
 */
export interface TokenLikeCoin {
  /** Canonical coin id (hex). The validator uses string comparison for
   *  the §4.1 "all coinIds distinct" rule. */
  readonly coinId: string;
  /** Coin balance in smallest unit. Always > 0n in a normalized
   *  {@link TokenLike} — zero-amount entries are pruned at projection
   *  time. */
  readonly amount: bigint;
}

// =============================================================================
// 2. Classification — single source of truth
// =============================================================================

/**
 * Discriminator returned by {@link classifyToken}. Mirrors the
 * `AssetTarget.kind` discriminator one-for-one (a `'coin'` token can
 * satisfy a `'coin'` target; an `'nft'` token can satisfy an `'nft'`
 * target — the §4.1 source-class enforcement rule).
 */
export type TokenClass = 'coin' | 'nft';

/**
 * Classify a token as `'coin'` or `'nft'` per the §4.1 normative
 * class predicate.
 *
 * **This is the single source of truth (C11).** Do NOT inline the
 * `isNft = !token.coins?.length` predicate elsewhere — call this
 * function. Every cascade decision, every target-source matching
 * decision, every disposition record routes through this helper so a
 * single bug fix lands in one place.
 *
 * @param t — a structural token projection. SDK `Token` instances and
 *            synthetic test fixtures both satisfy {@link TokenLike}.
 * @returns `'nft'` iff `t.coins` is `null`, `undefined`, or empty
 *          (after zero-amount pruning); else `'coin'`.
 *
 * @remarks
 * Pure. Side-effect free. Returns the same value for the same input
 * every call.
 *
 * The function itself does NOT prune zero-amount entries — it assumes
 * the projection has already done so (via {@link normalizeCoinData} at
 * the validator entry, or at SDK ingest time per §4.1). If a caller
 * passes a {@link TokenLike} with zero-amount entries still present,
 * `classifyToken` may return `'coin'` for what is semantically an NFT;
 * always run {@link normalizeCoinData} first if upstream pruning is
 * uncertain.
 */
export function classifyToken(t: TokenLike): TokenClass {
  // §4.1 "Class predicate (normative)":
  //   isNft = token.coins === null
  //        || token.coins === undefined
  //        || token.coins.length === 0
  if (t.coins === null || t.coins === undefined || t.coins.length === 0) {
    return 'nft';
  }
  return 'coin';
}

// =============================================================================
// 3. Normalization — prune zero-amount entries
// =============================================================================

/**
 * Return a new {@link TokenLike} with zero-amount coin entries
 * removed.
 *
 * Pure: returns a new object; the input is never mutated.
 *
 * @remarks
 * Per §4.1 paragraph "Implementations MUST prune zero-amount entries
 * (`amount === '0'`) from `coinData` at ingest time". This avoids the
 * ambiguous case where `[{coinId, amount: '0'}]` could be classified
 * inconsistently across implementations (some readers would call it a
 * coin token, others an NFT). The validator runs this defensively at
 * its entry point even when the upstream projection should have
 * already pruned, so {@link classifyToken} sees a stable shape.
 *
 * - If `t.coins` is `null` or `undefined`, the input is returned as-is
 *   (no allocation; preserves the NFT classification).
 * - If `t.coins` has zero-amount entries, returns a fresh object with
 *   `coins` filtered. Other fields are preserved by reference.
 * - If all entries are positive, returns the input as-is (no
 *   allocation).
 *
 * @param t — the token to normalize.
 * @returns a {@link TokenLike} with `coins` containing only
 *          positive-amount entries (or `null` if no positive entries
 *          remain).
 */
export function normalizeCoinData(t: TokenLike): TokenLike {
  if (t.coins === null || t.coins === undefined) {
    return t;
  }
  // Identify zero-amount entries without allocating if the array is
  // already clean.
  const hasZero = t.coins.some((c) => c.amount === 0n);
  if (!hasZero) {
    return t;
  }
  const pruned = t.coins.filter((c) => c.amount !== 0n);
  // After pruning, an empty array becomes `null` to keep the canonical
  // "NFT == empty/null coinData" invariant unambiguous (§4.1).
  return {
    ...t,
    coins: pruned.length === 0 ? null : pruned,
  };
}
