/**
 * Asset Target / Additional Asset types — UXF Inter-Wallet Transfer (T.1.B.1)
 *
 * Public discriminated unions used by `TransferRequest` to describe coin
 * vs whole-token (NFT) targets. Spec references:
 * - §4.1 step 1 — `AssetTarget` is the shape the validator builds from a
 *   `TransferRequest`'s primary slot + `additionalAssets` list.
 * - §10.1   — sender-side widening: `additionalAssets?: ReadonlyArray<AdditionalAsset>`.
 * - API.md  — `send()` widening per the v1.0 → multi-asset transition.
 *
 * Canonical asset model (from §4.1):
 *   - Coin token: non-empty `coinData`; may be split via burn-then-mint
 *     (each output gets a fresh `tokenId`).
 *   - NFT  token: empty/null `coinData`; transferred whole-token only
 *     (preserves `tokenId`, `tokenType`, identity data).
 *   - Coin and NFT tokens are class-disjoint — no token carries both.
 *
 * @remarks
 * `AdditionalAsset` is the **request-side** input shape callers pass into
 * `TransferRequest.additionalAssets`. `AssetTarget` is the **validator-side**
 * shape after the primary `(coinId, amount)` slot has been folded into the
 * unified target list. They are structurally identical at the union level
 * but kept as distinct names so consumers reading code (and a future
 * §4.1-step-1 validator in T.2.B) can tell which side of the boundary they
 * are on. T.2.B owns the `(TransferRequest) → AssetTarget[]` mapping.
 */

// =============================================================================
// 1. AdditionalAsset — request-side discriminated union
// =============================================================================

/**
 * A single additional asset entry on a `TransferRequest`. Either a fungible
 * coin slice or a whole-token (NFT) reference.
 *
 * - `kind: 'coin'` — caller specifies the coin id and amount. The validator
 *   prepends the request's primary `(coinId, amount)` slot if present, then
 *   appends each `additionalAssets` entry verbatim. Distinct-coinId rule
 *   applies across the whole list (primary + additional).
 * - `kind: 'nft'` — caller references an NFT by its `tokenId`. Whole-token
 *   transfer (no split, no change). The receiver gets a token with the same
 *   `tokenId`, `tokenType`, and identity data as the source — only the
 *   current-state predicate changes. Distinct-tokenId rule applies.
 *
 * Receivers reject unrecognized `kind` values with `UNKNOWN_ASSET_KIND`
 * (forward-compat per §4.1 / §10.4).
 */
export type AdditionalAsset =
  | { readonly kind: 'coin'; readonly coinId: string; readonly amount: string }
  | { readonly kind: 'nft'; readonly tokenId: string };

// =============================================================================
// 2. AssetTarget — validator-side discriminated union (§4.1 step 1)
// =============================================================================

/**
 * A single entry in the canonical `targetList` built by the §4.1 step 1
 * validator from a `TransferRequest`. Structurally identical to
 * {@link AdditionalAsset} — the distinct name documents the boundary
 * between caller input (`AdditionalAsset[]`) and validated target list
 * (`AssetTarget[]`).
 *
 * Each entry describes one recipient binding:
 *   - `{ kind: 'coin', coinId, amount }` — fungible slice; covered by the
 *     union of coin source tokens for `coinId`, possibly across multiple
 *     sources. May be satisfied by a split.
 *   - `{ kind: 'nft', tokenId }` — whole-token reference; covered by an
 *     NFT source token with matching `tokenId` whose current state binds
 *     to the sender. Always whole-token transfer, never split.
 */
export type AssetTarget =
  | { readonly kind: 'coin'; readonly coinId: string; readonly amount: string }
  | { readonly kind: 'nft'; readonly tokenId: string };

// =============================================================================
// 3. Type guards
// =============================================================================

/**
 * Type guard — `true` iff the asset is a coin entry. Narrows the union for
 * the consumer.
 */
export function isCoinAsset<T extends AdditionalAsset | AssetTarget>(
  asset: T,
): asset is Extract<T, { kind: 'coin' }> {
  return asset.kind === 'coin';
}

/**
 * Type guard — `true` iff the asset is an NFT entry. Narrows the union for
 * the consumer.
 */
export function isNftAsset<T extends AdditionalAsset | AssetTarget>(
  asset: T,
): asset is Extract<T, { kind: 'nft' }> {
  return asset.kind === 'nft';
}
