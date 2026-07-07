/**
 * Read-model — Balance / asset aggregation submodule.
 *
 * Extracted from PaymentsModule.ts during Phase 5 per docs/uxf/uxfv2-phase-5-
 * payments-disposition.md. Behavior-preserving pure functions + host-shim
 * accessors. The facade `PaymentsModule` retains public method signatures
 * (`getBalance`, `getAssets`, `getFiatBalance`) as one-line delegations
 * to the free functions here.
 *
 * Fiat pricing goes through the {@link PriceProvider} seam owned by the
 * facade — the host shim exposes it read-only so the read-model stays
 * decoupled from PriceProvider construction / disable-guard logic (both
 * remain on the facade per the ledger).
 */

import type { Asset, Token } from '../../../types';
import type { PriceProvider } from '../../../price';
import { TokenRegistry } from '../../../registry';
import { INVOICE_TOKEN_TYPE_HEX } from '../../../constants';
import { logger } from '../../../core/logger';

/**
 * Host shim for the read-model asset functions. The facade wires its
 * mutable fields and helpers into this interface at each call site.
 */
export interface AssetsHost {
  /** In-memory token map (facade-owned). */
  readonly tokens: ReadonlyMap<string, Token>;
  /** Price provider seam; `null` when unconfigured. */
  readonly priceProvider: PriceProvider | null;
  /**
   * Predicate: is this token's canonical (or fallback) id in the
   * V6-RECOVER permanent-verdict ledger?
   * See {@link PaymentsModule.isV6RecoverPermanentToken} for the canonical
   * implementation.
   */
  isV6RecoverPermanentToken(token: Token, id?: string): boolean;
  /**
   * Whether the price provider is disabled by config. Owned by the
   * facade so the read-model does not need to know about the
   * `PaymentsModuleConfig` shape.
   */
  isPriceDisabled(): boolean;
}

/**
 * Aggregate tokens by `coinId` with confirmed / unconfirmed breakdown.
 *
 * Excludes:
 *   - tokens with status `'spent'` or `'invalid'`;
 *   - invoice tokens (`coinId === INVOICE_TOKEN_TYPE_HEX`) — they carry
 *     no monetary value and only exist as ledger anchors; surfacing them
 *     produced the phantom `: 0 (1 token)` entry in #282 on the
 *     IPFS-recovery side, where `txfToToken` had no invoice branch and
 *     left coinId/symbol empty;
 *   - defensive: any residual token with empty `coinId` (catch-all for
 *     future shapes that slip past `txfToToken`'s typed branches).
 *
 * Tokens with status `'transferring'` are counted as unconfirmed
 * (visible in UI as "Sending").
 *
 * The returned array is sorted deterministically by symbol (ASCII
 * case-insensitive) with coinId as the tie-breaker. Without this sort,
 * multi-device wallets render the same asset set in different orders
 * because the underlying `tokens` Map iterates in insertion order
 * — which depends on snapshot replay sequence (#282 Residual #1).
 */
export function aggregateTokens(host: AssetsHost, coinId?: string): Asset[] {
  const assetsMap = new Map<string, {
    coinId: string;
    symbol: string;
    name: string;
    decimals: number;
    iconUrl?: string;
    confirmedAmount: bigint;
    unconfirmedAmount: bigint;
    confirmedTokenCount: number;
    unconfirmedTokenCount: number;
    transferringTokenCount: number;
  }>();

  for (const token of host.tokens.values()) {
    // Skip spent and invalid tokens; transferring tokens remain visible
    if (token.status === 'spent' || token.status === 'invalid') continue;
    // Issue #387 — defense in depth: any token whose tokenId carries
    // a permanent V6-RECOVER verdict is unspendable by this wallet
    // (HD-index recovery exhausted / structural failure). Even if a
    // TXF round-trip stripped its `'invalid'` status, the persistent
    // ledger is the authoritative verdict source and must be honored
    // here so balance NEVER includes unspendable tokens. The
    // `applyV6RecoverPermanentInvalidStatus` patch from
    // `loadFromStorageData` makes this filter normally redundant —
    // belt-and-braces against any future caller mutating status
    // independently or any code path that bypasses load (e.g. a
    // direct `tokens.set()` in tests).
    if (host.isV6RecoverPermanentToken(token)) continue;
    // Issue #282 Residual #3 — skip invoice tokens and any residual
    // empty-coinId entries. Invoices carry zero amount and have no
    // place in a balance summary; an empty coinId is a defensive
    // catch-all for token shapes that fall through `txfToToken`'s
    // typed branches.
    if (token.coinId === INVOICE_TOKEN_TYPE_HEX) continue;
    if (token.coinId === '') continue;
    if (coinId && token.coinId !== coinId) continue;

    const key = token.coinId;
    const amount = BigInt(token.amount);
    const isConfirmed = token.status === 'confirmed';
    const isTransferring = token.status === 'transferring';
    const existing = assetsMap.get(key);

    if (existing) {
      if (isConfirmed) {
        existing.confirmedAmount += amount;
        existing.confirmedTokenCount++;
      } else {
        existing.unconfirmedAmount += amount;
        existing.unconfirmedTokenCount++;
      }
      if (isTransferring) existing.transferringTokenCount++;
    } else {
      assetsMap.set(key, {
        coinId: token.coinId,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        iconUrl: token.iconUrl,
        confirmedAmount: isConfirmed ? amount : 0n,
        unconfirmedAmount: isConfirmed ? 0n : amount,
        confirmedTokenCount: isConfirmed ? 1 : 0,
        unconfirmedTokenCount: isConfirmed ? 0 : 1,
        transferringTokenCount: isTransferring ? 1 : 0,
      });
    }
  }

  const assets = Array.from(assetsMap.values()).map((raw) => {
    const totalAmount = (raw.confirmedAmount + raw.unconfirmedAmount).toString();
    return {
      coinId: raw.coinId,
      symbol: raw.symbol,
      name: raw.name,
      decimals: raw.decimals,
      iconUrl: raw.iconUrl,
      totalAmount,
      tokenCount: raw.confirmedTokenCount + raw.unconfirmedTokenCount,
      confirmedAmount: raw.confirmedAmount.toString(),
      unconfirmedAmount: raw.unconfirmedAmount.toString(),
      confirmedTokenCount: raw.confirmedTokenCount,
      unconfirmedTokenCount: raw.unconfirmedTokenCount,
      transferringTokenCount: raw.transferringTokenCount,
      priceUsd: null as number | null,
      priceEur: null as number | null,
      change24h: null as number | null,
      fiatValueUsd: null as number | null,
      fiatValueEur: null as number | null,
    };
  });

  // Issue #282 Residual #1 — deterministic asset order. Identical
  // wallets on two devices MUST render the same `sphere balance` output
  // regardless of token-insertion sequence.
  assets.sort((a, b) => {
    const sa = (a.symbol ?? '').toLocaleLowerCase('en-US');
    const sb = (b.symbol ?? '').toLocaleLowerCase('en-US');
    if (sa < sb) return -1;
    if (sa > sb) return 1;
    // Tie-break on coinId for cases where two assets share the same
    // symbol (rare — registry-aliased coins, malformed metadata, etc.).
    const ca = a.coinId ?? '';
    const cb = b.coinId ?? '';
    if (ca < cb) return -1;
    if (ca > cb) return 1;
    return 0;
  });

  return assets;
}

/**
 * Get token balances grouped by coin type.
 *
 * Returns an array of {@link Asset} objects, one per coin type held.
 * Each entry includes confirmed and unconfirmed breakdowns. Tokens with
 * status `'spent'`, `'invalid'`, or `'transferring'` are excluded.
 *
 * This is synchronous — no price data is included. Use {@link getAssets}
 * for the async version with fiat pricing.
 */
export function getBalance(host: AssetsHost, coinId?: string): Asset[] {
  return aggregateTokens(host, coinId);
}

/**
 * Get aggregated assets (tokens grouped by coinId) with price data.
 * Includes both confirmed and unconfirmed tokens with breakdown.
 */
export async function getAssets(host: AssetsHost, coinId?: string): Promise<Asset[]> {
  const rawAssets = aggregateTokens(host, coinId);

  // Fetch prices if provider is available
  if (!host.priceProvider || host.isPriceDisabled() || rawAssets.length === 0) {
    return rawAssets;
  }

  try {
    const registry = TokenRegistry.getInstance();
    const nameToCoins = new Map<string, string[]>(); // tokenName -> coinIds[]

    for (const asset of rawAssets) {
      const def = registry.getDefinition(asset.coinId);
      if (def?.name) {
        const existing = nameToCoins.get(def.name);
        if (existing) {
          existing.push(asset.coinId);
        } else {
          nameToCoins.set(def.name, [asset.coinId]);
        }
      }
    }

    if (nameToCoins.size > 0) {
      const tokenNames = Array.from(nameToCoins.keys());
      const prices = await host.priceProvider.getPrices(tokenNames);

      return rawAssets.map((raw) => {
        const def = registry.getDefinition(raw.coinId);
        const price = def?.name ? prices.get(def.name) : undefined;
        let fiatValueUsd: number | null = null;
        let fiatValueEur: number | null = null;

        if (price) {
          const humanAmount = Number(raw.totalAmount) / Math.pow(10, raw.decimals);
          fiatValueUsd = humanAmount * price.priceUsd;
          if (price.priceEur != null) {
            fiatValueEur = humanAmount * price.priceEur;
          }
        }

        return {
          ...raw,
          priceUsd: price?.priceUsd ?? null,
          priceEur: price?.priceEur ?? null,
          change24h: price?.change24h ?? null,
          fiatValueUsd,
          fiatValueEur,
        };
      });
    }
  } catch (error) {
    logger.warn('Payments', 'Failed to fetch prices, returning assets without price data:', error);
  }

  return rawAssets;
}

/**
 * Get total portfolio value in USD.
 * Returns null if PriceProvider is not configured.
 */
export async function getFiatBalance(host: AssetsHost): Promise<number | null> {
  const assets = await getAssets(host);

  if (!host.priceProvider || host.isPriceDisabled()) {
    return null;
  }

  let total = 0;
  let hasAnyPrice = false;

  for (const asset of assets) {
    if (asset.fiatValueUsd != null) {
      total += asset.fiatValueUsd;
      hasAnyPrice = true;
    }
  }

  return hasAnyPrice ? total : null;
}
