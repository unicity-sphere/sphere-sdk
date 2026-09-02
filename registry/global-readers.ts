/**
 * Readers bound to the PROCESS-GLOBAL registry: with two Spheres alive they answer for
 * whichever network configured it last. Prefer a Sphere-owned registry when it matters.
 */

import { TokenRegistry } from './TokenRegistry';
import type { TokenDefinition } from './TokenRegistry';

export function getTokenDefinition(coinId: string): TokenDefinition | undefined {
  return TokenRegistry.getInstance().getDefinition(coinId);
}

export function getTokenSymbol(coinId: string): string {
  return TokenRegistry.getInstance().getSymbol(coinId);
}

export function getTokenName(coinId: string): string {
  return TokenRegistry.getInstance().getName(coinId);
}

export function getTokenDecimals(coinId: string): number {
  return TokenRegistry.getInstance().getDecimals(coinId);
}

export function getTokenIconUrl(coinId: string, preferPng = true): string | null {
  return TokenRegistry.getInstance().getIconUrl(coinId, preferPng);
}

export function isKnownToken(coinId: string): boolean {
  return TokenRegistry.getInstance().isKnown(coinId);
}

export function getCoinIdBySymbol(symbol: string): string | undefined {
  return TokenRegistry.getInstance().getCoinIdBySymbol(symbol);
}

export function getCoinIdByName(name: string): string | undefined {
  return TokenRegistry.getInstance().getCoinIdByName(name);
}

export function normalizeCoinId(coinId: string): string {
  // Short alphanumeric strings are likely symbolic names (BTC, ETH, USDU, etc.)
  if (coinId.length <= 20 && /^[A-Za-z0-9]+$/.test(coinId)) {
    const resolved = getCoinIdBySymbol(coinId);
    if (resolved) return resolved;
  }
  return coinId;
}

export function coinIdsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  return normalizeCoinId(a) === normalizeCoinId(b);
}
