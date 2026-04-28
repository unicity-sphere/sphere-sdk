/**
 * Multi-asset target validator — UXF Inter-Wallet Transfer (T.2.B).
 *
 * Implements §4.1 step 1 verbatim: builds the canonical `targetList`
 * from a `TransferRequest`'s `(primary, additionalAssets)` and enforces
 * the structural and source-class invariants the spec lists. Also
 * applies §4.1 step 2's NFT cascade asymmetry guard (W11).
 *
 * **Pure function**: no I/O, no mutation. The validator takes the
 * caller's request + an immutable projection of available source
 * tokens, and returns a structured {@link ValidatedTargets} on success
 * or throws a typed {@link SphereError} on failure.
 *
 * Spec references:
 * - §4.1 step 1 (target list construction + validation rules).
 * - §4.1 step 2 (NFT cascade asymmetry, `confirmNftPending`).
 * - §11.2 (validation rejection cases — every code path covered by a
 *   passing test).
 * - §10.4 (forward-compat reject for unknown asset kinds).
 *
 * @remarks
 * Integration with `PaymentsModule.send()` is owned by T.2.D.1 — this
 * file produces the helper; downstream consumes it.
 */

import { SphereError } from '../../../core/errors';
import type {
  AdditionalAsset,
  AssetTarget,
  TransferRequest,
} from '../../../types';
import {
  classifyToken,
  normalizeCoinData,
  type TokenLike,
} from './classify-token';

// =============================================================================
// 1. Public surface
// =============================================================================

/**
 * Validated target list — the spec's `targetList` after §4.1 step 1
 * construction. Includes a separation of coin vs NFT targets for
 * convenience of downstream coverage / matching algorithms.
 */
export interface ValidatedTargets {
  /** All targets in declaration order (primary first if present, then
   *  `additionalAssets` verbatim). The spec calls this `targetList`. */
  readonly targetList: ReadonlyArray<AssetTarget>;
  /** Subset of {@link targetList} restricted to `kind: 'coin'` entries.
   *  Order preserved. */
  readonly coinTargets: ReadonlyArray<Extract<AssetTarget, { kind: 'coin' }>>;
  /** Subset of {@link targetList} restricted to `kind: 'nft'` entries.
   *  Order preserved. */
  readonly nftTargets: ReadonlyArray<Extract<AssetTarget, { kind: 'nft' }>>;
}

// =============================================================================
// 2. Internal helpers — primary-slot extraction + amount parsing
// =============================================================================

/**
 * Extract the primary `(coinId, amount)` slot from a {@link
 * TransferRequest}, or `null` if the slot is absent.
 *
 * Per §4.1 step 1: the primary slot is OPTIONAL. If both `coinId` and
 * `amount` are present, prepend `{kind: 'coin', coinId, amount}` to
 * the target list. If both are absent, no primary entry. If exactly
 * one is present (partial slot), that's a structural request error
 * (`INVALID_REQUEST`) — the caller must either provide both or
 * neither.
 *
 * @throws {SphereError} `INVALID_REQUEST` if exactly one of `coinId` /
 *         `amount` is set without the other.
 */
function extractPrimaryTarget(
  request: TransferRequest,
): { kind: 'coin'; coinId: string; amount: string } | null {
  const hasCoinId =
    request.coinId !== undefined &&
    request.coinId !== null &&
    request.coinId !== '';
  const hasAmount =
    request.amount !== undefined &&
    request.amount !== null &&
    request.amount !== '';

  if (!hasCoinId && !hasAmount) {
    return null;
  }
  if (hasCoinId !== hasAmount) {
    throw new SphereError(
      `Primary coin slot is partial: provide both coinId and amount, or neither (got coinId=${
        hasCoinId ? 'set' : 'unset'
      }, amount=${hasAmount ? 'set' : 'unset'})`,
      'INVALID_REQUEST',
    );
  }
  return {
    kind: 'coin',
    coinId: request.coinId as string,
    amount: request.amount as string,
  };
}

/**
 * Parse a coin-amount string as a positive bigint, or throw
 * `INVALID_AMOUNT`. The spec mandates `amount > 0` for every coin
 * entry — no zero, no negative, no fractional, no non-numeric.
 *
 * @throws {SphereError} `INVALID_AMOUNT` for any non-positive-integer
 *         string.
 */
function parsePositiveAmount(coinId: string, raw: string): bigint {
  // BigInt rejects fractional / non-numeric / scientific-notation
  // strings. We additionally reject leading-`+`, leading-zero-padded,
  // and explicit-`-` to avoid ambiguity. Empty string is also rejected.
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new SphereError(
      `Coin target ${coinId} has invalid amount: must be a non-empty string`,
      'INVALID_AMOUNT',
    );
  }
  // Strict positive-integer regex: digits only, no leading zero unless
  // the value is exactly "0" (which we then reject for being non-positive).
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new SphereError(
      `Coin target ${coinId} has invalid amount: ${JSON.stringify(raw)} is not a non-negative integer string`,
      'INVALID_AMOUNT',
    );
  }
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    /* istanbul ignore next — regex above already filters */
    throw new SphereError(
      `Coin target ${coinId} has invalid amount: ${JSON.stringify(raw)} cannot be parsed as bigint`,
      'INVALID_AMOUNT',
    );
  }
  if (value <= 0n) {
    throw new SphereError(
      `Coin target ${coinId} has non-positive amount: ${raw}; coin amounts MUST be > 0 per §4.1 step 1`,
      'INVALID_AMOUNT',
    );
  }
  return value;
}

// =============================================================================
// 3. Coverage helpers
// =============================================================================

/**
 * Return the (sender-owned, normalized) source tokens partitioned by
 * class. Tokens explicitly flagged `ownedBySender: false` are dropped;
 * tokens with `ownedBySender: undefined` are trusted as owned (caller
 * pool filter precondition).
 *
 * Each token is run through {@link normalizeCoinData} defensively so
 * downstream classification is stable even if the projection
 * forgot to prune zero-amount entries (per §4.1 ingest rule).
 */
function partitionSources(
  sources: ReadonlyArray<TokenLike>,
): { coinSources: ReadonlyArray<TokenLike>; nftSources: ReadonlyArray<TokenLike> } {
  const coinSources: TokenLike[] = [];
  const nftSources: TokenLike[] = [];
  for (const raw of sources) {
    if (raw.ownedBySender === false) continue;
    const t = normalizeCoinData(raw);
    if (classifyToken(t) === 'nft') {
      nftSources.push(t);
    } else {
      coinSources.push(t);
    }
  }
  return { coinSources, nftSources };
}

/**
 * Sum the available balance of `coinId` across all coin sources.
 */
function totalCoinBalance(
  coinId: string,
  coinSources: ReadonlyArray<TokenLike>,
): bigint {
  let total = 0n;
  for (const src of coinSources) {
    if (src.coins === null) continue;
    for (const entry of src.coins) {
      if (entry.coinId === coinId) {
        total += entry.amount;
      }
    }
  }
  return total;
}

/**
 * Find the source token for an NFT target, applying §4.1 step 1
 * source-class enforcement.
 *
 * Returns the matching NFT source on success. Throws `INSUFFICIENT_BALANCE`
 * (with `cause.reason = 'nft-not-owned'`) if:
 *  - No source token has the requested tokenId,
 *  - A source has the tokenId but is a coin token (non-empty
 *    coinData) — class disjointness violation,
 *  - The NFT source exists but is not bound to the sender
 *    (`ownedBySender: false`).
 */
function findNftSource(
  tokenId: string,
  allSources: ReadonlyArray<TokenLike>,
): TokenLike {
  // 1. Look for ANY source with this tokenId — we want to disambiguate
  //    the rejection (not-owned vs class-mismatch).
  const candidates = allSources.filter((s) => s.id === tokenId);
  if (candidates.length === 0) {
    throw new SphereError(
      `NFT target ${tokenId}: not in sender's pool`,
      'INSUFFICIENT_BALANCE',
      { reason: 'nft-not-owned', tokenId, cause: 'not-found' },
    );
  }

  // 2. If any candidate is explicitly not owned by sender → reject.
  //    (Caller-pool filter normally drops these but the validator
  //    treats explicit `false` as a final guard.)
  const ownedCandidates = candidates.filter((c) => c.ownedBySender !== false);
  if (ownedCandidates.length === 0) {
    throw new SphereError(
      `NFT target ${tokenId}: token exists but current state does not bind to sender`,
      'INSUFFICIENT_BALANCE',
      { reason: 'nft-not-owned', tokenId, cause: 'not-bound' },
    );
  }

  // 3. Among owned candidates, prefer NFT-class. If the only owned
  //    candidate is a coin token, that's a class violation: coin
  //    tokens cannot satisfy NFT targets even with matching tokenId.
  for (const c of ownedCandidates) {
    const norm = normalizeCoinData(c);
    if (classifyToken(norm) === 'nft') {
      return norm;
    }
  }

  throw new SphereError(
    `NFT target ${tokenId}: source has non-empty coinData (coin class); coin tokens cannot satisfy NFT targets per §4.1 class disjointness`,
    'INSUFFICIENT_BALANCE',
    { reason: 'nft-not-owned', tokenId, cause: 'class-mismatch' },
  );
}

// =============================================================================
// 4. Validator entry point
// =============================================================================

/**
 * Validate a `TransferRequest` against the available source pool and
 * return the canonical `targetList` per §4.1 step 1.
 *
 * **Pure function** — no I/O, no mutation. Throws a typed
 * {@link SphereError} on every rejection path.
 *
 * Validation order (mirrors §4.1 step 1 prose):
 *  1. Build target list (primary slot if present + `additionalAssets`).
 *  2. Reject empty target list (W22) → `EMPTY_TRANSFER`.
 *  3. Reject unknown `kind` discriminators (forward-compat) →
 *     `UNKNOWN_ASSET_KIND`.
 *  4. Reject duplicate `coinId` across coin targets (incl. primary) →
 *     `INVALID_REQUEST`.
 *  5. Reject duplicate `tokenId` across NFT targets → `INVALID_REQUEST`.
 *  6. Reject non-positive coin amounts → `INVALID_AMOUNT`.
 *  7. For each coin target: verify aggregate sender balance ≥ amount →
 *     `INSUFFICIENT_BALANCE` if uncoverable.
 *  8. For each NFT target: verify a sender-owned NFT-class source
 *     exists with that tokenId → `INSUFFICIENT_BALANCE`
 *     `reason='nft-not-owned'` otherwise.
 *  9. §4.1 step 2: if any NFT target's source is `pending` AND the
 *     request's `confirmNftPending` is not `true` →
 *     `NFT_PENDING_REQUIRES_CONFIRMATION` (W11).
 *
 * @param request — the caller's transfer request (post-shim).
 * @param availableSources — projection of the sender's owned token pool
 *        (already filtered to current-state-binds-to-sender; the
 *        validator treats `ownedBySender: false` as an extra guard for
 *        explicit failure).
 * @returns the validated, canonical {@link ValidatedTargets}.
 * @throws {SphereError} with one of: `EMPTY_TRANSFER`, `INVALID_REQUEST`,
 *         `INVALID_AMOUNT`, `UNKNOWN_ASSET_KIND`,
 *         `INSUFFICIENT_BALANCE`, `NFT_PENDING_REQUIRES_CONFIRMATION`.
 */
export function validateTargets(
  request: TransferRequest,
  availableSources: ReadonlyArray<TokenLike>,
): ValidatedTargets {
  // ---------------------------------------------------------------------
  // Step 1: build the raw target list from primary + additionalAssets.
  // ---------------------------------------------------------------------
  const targetList: AssetTarget[] = [];

  const primary = extractPrimaryTarget(request);
  if (primary !== null) {
    targetList.push(primary);
  }

  const additional: ReadonlyArray<AdditionalAsset> = request.additionalAssets ?? [];
  for (let i = 0; i < additional.length; i++) {
    const entry = additional[i];
    // Forward-compat reject (§4.1 / §10.4): any kind not in {'coin', 'nft'}.
    // We check explicitly so we get a typed error rather than a `never`
    // fallthrough at compile time.
    if (entry.kind === 'coin') {
      targetList.push({
        kind: 'coin',
        coinId: entry.coinId,
        amount: entry.amount,
      });
    } else if (entry.kind === 'nft') {
      targetList.push({ kind: 'nft', tokenId: entry.tokenId });
    } else {
      // Synthetic / future kind. Reject per §4.1 step 1
      // "Discriminator forward-compat".
      const unknownKind = (entry as { kind?: unknown }).kind;
      throw new SphereError(
        `additionalAssets[${i}].kind=${JSON.stringify(unknownKind)} is not recognized; receivers MUST reject unknown kinds (forward-compat per §4.1 / §10.4)`,
        'UNKNOWN_ASSET_KIND',
      );
    }
  }

  // ---------------------------------------------------------------------
  // Step 2: empty transfer rejection (W22).
  // ---------------------------------------------------------------------
  if (targetList.length === 0) {
    throw new SphereError(
      'Transfer request has no targets: provide a primary (coinId, amount) and/or non-empty additionalAssets',
      'EMPTY_TRANSFER',
    );
  }

  // ---------------------------------------------------------------------
  // Step 3: distinct-coinId / distinct-NFT-tokenId enforcement.
  // ---------------------------------------------------------------------
  const seenCoinIds = new Set<string>();
  const seenNftIds = new Set<string>();
  for (const t of targetList) {
    if (t.kind === 'coin') {
      if (seenCoinIds.has(t.coinId)) {
        throw new SphereError(
          `Duplicate coin target: coinId=${t.coinId} appears more than once across primary + additionalAssets; sum into one entry`,
          'INVALID_REQUEST',
        );
      }
      seenCoinIds.add(t.coinId);
    } else {
      if (seenNftIds.has(t.tokenId)) {
        throw new SphereError(
          `Duplicate NFT target: tokenId=${t.tokenId} appears more than once; cannot transfer the same NFT twice`,
          'INVALID_REQUEST',
        );
      }
      seenNftIds.add(t.tokenId);
    }
  }

  // ---------------------------------------------------------------------
  // Step 4: positive-amount check on every coin target.
  // ---------------------------------------------------------------------
  const coinTargets = targetList.filter(
    (t): t is Extract<AssetTarget, { kind: 'coin' }> => t.kind === 'coin',
  );
  const nftTargets = targetList.filter(
    (t): t is Extract<AssetTarget, { kind: 'nft' }> => t.kind === 'nft',
  );
  const coinAmounts = new Map<string, bigint>();
  for (const ct of coinTargets) {
    const parsed = parsePositiveAmount(ct.coinId, ct.amount);
    coinAmounts.set(ct.coinId, parsed);
  }

  // ---------------------------------------------------------------------
  // Step 5: source coverage. Partition the pool by class first.
  // ---------------------------------------------------------------------
  const { coinSources, nftSources } = partitionSources(availableSources);

  // 5a. Coin coverage — each target's union balance ≥ amount.
  for (const ct of coinTargets) {
    const required = coinAmounts.get(ct.coinId) as bigint;
    const available = totalCoinBalance(ct.coinId, coinSources);
    if (available < required) {
      throw new SphereError(
        `Insufficient balance for coin ${ct.coinId}: required=${required.toString()}, available=${available.toString()}`,
        'INSUFFICIENT_BALANCE',
        {
          coinId: ct.coinId,
          required: required.toString(),
          available: available.toString(),
        },
      );
    }
  }

  // 5b. NFT coverage — exact tokenId match in NFT-class sources, with
  //     class disjointness guard. `findNftSource` looks at ALL sources
  //     (coin or NFT) so it can disambiguate the rejection cause
  //     (not-found vs class-mismatch vs not-bound).
  const matchedNftSources = new Map<string, TokenLike>();
  for (const nt of nftTargets) {
    const src = findNftSource(nt.tokenId, [...coinSources, ...nftSources]);
    matchedNftSources.set(nt.tokenId, src);
  }

  // ---------------------------------------------------------------------
  // Step 6: §4.1 step 2 — NFT cascade asymmetry guard (W11).
  //   If any matched NFT source is `pending` AND
  //   confirmNftPending !== true, reject. This is the
  //   "irrecoverable identity" warning made enforceable.
  // ---------------------------------------------------------------------
  if (request.confirmNftPending !== true) {
    for (const [tokenId, src] of matchedNftSources) {
      if (src.pending === true) {
        throw new SphereError(
          `NFT target ${tokenId}: source token is pending (unfinalized predecessor tx) and confirmNftPending !== true. NFT cascades cost non-fungible identity (irrecoverable); set confirmNftPending: true to acknowledge per §4.1 step 2`,
          'NFT_PENDING_REQUIRES_CONFIRMATION',
          { tokenId },
        );
      }
    }
  }

  // ---------------------------------------------------------------------
  // Validation passed — return frozen view of the canonical target list.
  // ---------------------------------------------------------------------
  return Object.freeze({
    targetList: Object.freeze([...targetList]),
    coinTargets: Object.freeze([...coinTargets]),
    nftTargets: Object.freeze([...nftTargets]),
  });
}
