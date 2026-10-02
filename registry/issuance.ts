import { logger } from '../core/logger';
import type { TokenDefinition } from './TokenRegistry';

/** The only token type whose tokens may carry a fungible coin; a token of it counts once its issuance policy passes. */
export interface TokenIssuance {
  /** 64 lowercase hex. */
  tokenType: string;
}

const TOKEN_TYPE_HEX = /^[0-9a-f]{64}$/;

/** The definition as served, minus an `issuance` that is malformed or not on a fungible entry. */
export function withValidIssuance(def: TokenDefinition): TokenDefinition {
  if (def.issuance === undefined) return def;
  const tokenType: unknown = (def.issuance as { tokenType?: unknown } | null)?.tokenType;
  if (def.assetKind === 'fungible' && typeof tokenType === 'string' && TOKEN_TYPE_HEX.test(tokenType)) return def;
  logger.warn('TokenRegistry', `Ignoring a malformed issuance on registry entry ${String(def.id)}`);
  const { issuance: _dropped, ...rest } = def;
  return rest;
}

export function issuersOf(validated: readonly TokenDefinition[]): Map<string, string> {
  const issuers = new Map<string, string>();
  for (const def of validated) {
    if (def.issuance !== undefined) issuers.set(def.id.toLowerCase(), def.issuance.tokenType);
  }
  return issuers;
}
