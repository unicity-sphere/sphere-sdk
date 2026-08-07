// §5.2 presentation half (split out per PR #727 review): pure registry/fiat
// display mapping over mirror snapshots. No mirror mutation, no concurrency —
// InventoryView owns the money mirror; this file only formats it.

import type { Asset, Token } from '../../../types';
import type { InventoryAsset } from '../ports';

export interface RegistryReader {
  getSymbol(coinId: string): string;
  getName(coinId: string): string;
  getDecimals(coinId: string): number;
  getIconUrl(coinId: string): string | null;
}

export interface PriceQuote {
  readonly priceUsd: number;
  readonly priceEur?: number;
  readonly change24h?: number;
}

export interface PriceReader {
  getPrices(tokenNames: string[]): Promise<Map<string, PriceQuote>>;
}

export interface TokenSnapshot {
  readonly assets: readonly InventoryAsset[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TokenFlags {
  readonly transferring: boolean;
  readonly suspectedSpent: boolean;
}

export function toToken(
  tokenId: string,
  snapshot: TokenSnapshot,
  asset: InventoryAsset,
  registry: RegistryReader,
  flags: TokenFlags
): Token {
  const iconUrl = registry.getIconUrl(asset.coinId);
  return {
    id: tokenId,
    coinId: asset.coinId,
    symbol: registry.getSymbol(asset.coinId),
    name: registry.getName(asset.coinId),
    decimals: registry.getDecimals(asset.coinId),
    ...(iconUrl !== null ? { iconUrl } : {}),
    amount: asset.amount,
    status: flags.transferring ? 'transferring' : 'confirmed',
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    lazy: true,
    ...(flags.suspectedSpent ? { suspectedSpent: true } : {}),
  };
}

interface CoinTotals {
  total: bigint;
  count: number;
  transferring: bigint;
  transferringCount: number;
}

export function aggregateAssets(
  entries: Iterable<[string, TokenSnapshot]>,
  isTransferring: (tokenId: string) => boolean,
  registry: RegistryReader
): Asset[] {
  const groups = new Map<string, CoinTotals>();
  for (const [tokenId, entry] of entries) {
    const moving = isTransferring(tokenId);
    for (const asset of entry.assets) {
      let group = groups.get(asset.coinId);
      if (!group) {
        group = { total: 0n, count: 0, transferring: 0n, transferringCount: 0 };
        groups.set(asset.coinId, group);
      }
      if (moving) {
        group.transferring += BigInt(asset.amount);
        group.transferringCount += 1;
      } else {
        group.total += BigInt(asset.amount);
        group.count += 1;
      }
    }
  }
  return [...groups].map(([coinId, totals]) => toAsset(coinId, totals, registry));
}

function toAsset(coinId: string, totals: CoinTotals, registry: RegistryReader): Asset {
  const iconUrl = registry.getIconUrl(coinId);
  return {
    coinId,
    symbol: registry.getSymbol(coinId),
    name: registry.getName(coinId),
    decimals: registry.getDecimals(coinId),
    ...(iconUrl !== null ? { iconUrl } : {}),
    totalAmount: totals.total.toString(),
    tokenCount: totals.count,
    confirmedAmount: totals.total.toString(),
    unconfirmedAmount: '0',
    confirmedTokenCount: totals.count,
    unconfirmedTokenCount: 0,
    transferringTokenCount: totals.transferringCount,
    transferringAmount: totals.transferring.toString(),
    priceUsd: null,
    priceEur: null,
    change24h: null,
    fiatValueUsd: null,
    fiatValueEur: null,
  };
}

export async function withPrices(
  raw: Asset[],
  registry: RegistryReader,
  price: PriceReader
): Promise<Asset[]> {
  try {
    const names = [...new Set(raw.map((a) => registry.getName(a.coinId)))];
    const quotes = await price.getPrices(names);
    return raw.map((a) => priceOne(a, quotes.get(registry.getName(a.coinId))));
  } catch {
    return raw;
  }
}

// Fiat display conversion is the one sanctioned Number use (display only).
function priceOne(asset: Asset, quote: PriceQuote | undefined): Asset {
  if (!quote) return asset;
  const human = Number(asset.totalAmount) / Math.pow(10, asset.decimals);
  return {
    ...asset,
    priceUsd: quote.priceUsd,
    priceEur: quote.priceEur ?? null,
    change24h: quote.change24h ?? null,
    fiatValueUsd: human * quote.priceUsd,
    fiatValueEur: quote.priceEur != null ? human * quote.priceEur : null,
  };
}
