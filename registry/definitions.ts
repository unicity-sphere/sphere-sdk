import { NETWORKS } from '../constants';
import type { TokenDefinition } from './TokenRegistry';

/** The only token type whose tokens may carry a fungible coin; a token of it counts once its issuance policy passes. */
export interface TokenIssuance {
  /** 64 lowercase hex. */
  tokenType: string;
}

export type WarnOnce = (key: string, message: string) => void;

export interface DefinitionIndex {
  readonly byId: Map<string, TokenDefinition>;
  readonly byType: Map<string, TokenDefinition>;
  readonly bySymbol: Map<string, TokenDefinition>;
  readonly byName: Map<string, TokenDefinition>;
  readonly issuers: ReadonlyMap<string, string>;
}

const TOKEN_TYPE_HEX = /^[0-9a-f]{64}$/;
const NATIVE_COIN_IDS: ReadonlySet<string> = new Set(Object.values(NETWORKS).flatMap((network) => network.nativeCoinIds));

function isWellFormed(def: TokenDefinition): boolean {
  const icons: unknown = def.icons;
  const iconsOk = icons === undefined || (Array.isArray(icons) && icons.every((icon) => typeof (icon as { url?: unknown } | null)?.url === 'string'));
  return typeof def.id === 'string' && typeof def.name === 'string' && (def.symbol === undefined || typeof def.symbol === 'string') && iconsOk;
}

/** The definition as served, minus an `issuance` that is malformed, not on a fungible entry, or on a native coin. */
function withValidIssuance(def: TokenDefinition, warn: WarnOnce): TokenDefinition {
  if (def.issuance === undefined) return def;
  const tokenType: unknown = (def.issuance as { tokenType?: unknown } | null)?.tokenType;
  const wellFormed = def.assetKind === 'fungible' && typeof tokenType === 'string' && TOKEN_TYPE_HEX.test(tokenType);
  if (wellFormed && !NATIVE_COIN_IDS.has(def.id.toLowerCase())) return def;
  const what = wellFormed ? 'an issuance on a native coin' : 'a malformed issuance';
  warn(`issuance ${def.id} ${JSON.stringify(def.issuance)}`, `Ignoring ${what} on registry entry ${def.id}`);
  const { issuance: _dropped, ...rest } = def;
  return rest;
}

/**
 * Lookup maps over one registry file, built whole so a caller swaps them in at once; an entry that
 * would break a lookup is skipped. `byId` holds coin ids and token types alike, `byType` only the latter.
 */
export function indexDefinitions(served: readonly TokenDefinition[], warn: WarnOnce): DefinitionIndex {
  const map = (): Map<string, TokenDefinition> => new Map();
  const index = { byId: map(), byType: map(), bySymbol: map(), byName: map(), issuers: new Map<string, string>() };
  for (const entry of served) {
    if (!isWellFormed(entry)) {
      warn(`entry ${JSON.stringify(entry)}`, `Skipping a malformed registry entry ${String(entry.id)}`);
      continue;
    }
    const def = withValidIssuance(entry, warn);
    const id = def.id.toLowerCase();
    index.byId.set(id, def);
    if (def.assetKind === 'non-fungible') index.byType.set(id, def);
    if (def.symbol) index.bySymbol.set(def.symbol.toUpperCase(), def);
    index.byName.set(def.name.toLowerCase(), def);
    if (def.issuance !== undefined) index.issuers.set(id, def.issuance.tokenType);
  }
  return index;
}
