import { NETWORKS } from '../constants';
import type { TokenDefinition, TokenIcon } from './TokenRegistry';

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

function normalizedTokenType(issuance: unknown): string | null {
  const raw = (issuance as { tokenType?: unknown } | null)?.tokenType;
  if (typeof raw !== 'string') return null;
  const hex = raw.toLowerCase().replace(/^0x/, '');
  return TOKEN_TYPE_HEX.test(hex) ? hex : null;
}

/** The issuing token type a fungible entry names, or null; a claim on a native coin or a malformed one is dropped. */
function issuerNamedBy(def: TokenDefinition, warn: WarnOnce): string | null {
  if (def.issuance === undefined) return null;
  const tokenType = def.assetKind === 'fungible' ? normalizedTokenType(def.issuance) : null;
  if (tokenType !== null && !NATIVE_COIN_IDS.has(def.id.toLowerCase())) return tokenType;
  const what = tokenType !== null ? 'an issuance on a native coin' : 'a malformed issuance';
  warn(`issuance ${def.id} ${JSON.stringify(def.issuance)}`, `Ignoring ${what} on registry entry ${def.id}`);
  return null;
}

function hasUrl(icon: unknown): icon is TokenIcon {
  return typeof (icon as { url?: unknown } | null)?.url === 'string';
}

function iconsWellFormed(icons: unknown): boolean {
  return icons === undefined || (Array.isArray(icons) && icons.every(hasUrl));
}

/** The entry with each malformed display field dropped (null reads as absent) and its issuance normalized. */
function presentable(def: TokenDefinition, issuer: string | null, warn: WarnOnce): TokenDefinition {
  const icons: unknown = def.icons;
  const symbolOk = def.symbol === undefined || typeof def.symbol === 'string';
  const iconsOk = iconsWellFormed(icons);
  const issuanceOk = issuer === null ? def.issuance === undefined : def.issuance?.tokenType === issuer;
  if (symbolOk && iconsOk && issuanceOk) return def;
  if (!symbolOk && def.symbol !== null) warn(`symbol ${def.id} ${JSON.stringify(def.symbol)}`, `Ignoring a malformed symbol on registry entry ${def.id}`);
  if (!iconsOk && icons !== null) warn(`icons ${def.id} ${JSON.stringify(icons)}`, `Ignoring malformed icons on registry entry ${def.id}`);
  const { symbol, icons: _icons, issuance: _issuance, ...rest } = def;
  return {
    ...rest,
    ...(typeof symbol === 'string' ? { symbol } : {}),
    ...(Array.isArray(icons) ? { icons: icons.filter(hasUrl) } : {}),
    ...(issuer !== null ? { issuance: { tokenType: issuer } } : {}),
  };
}

/**
 * Lookup maps over one registry file, built whole so a caller swaps them in at once. A claim needs
 * only a fungible entry's string id; a definition also needs a name. `byType` holds only token types.
 */
export function indexDefinitions(served: readonly TokenDefinition[], warn: WarnOnce): DefinitionIndex {
  const map = (): Map<string, TokenDefinition> => new Map();
  const index = { byId: map(), byType: map(), bySymbol: map(), byName: map(), issuers: new Map<string, string>() };
  for (const entry of served) {
    if (typeof entry.id !== 'string') {
      warn(`entry ${JSON.stringify(entry)}`, 'Skipping a registry entry whose id is not a string');
      continue;
    }
    const id = entry.id.toLowerCase();
    const issuer = issuerNamedBy(entry, warn);
    if (issuer !== null) index.issuers.set(id, issuer);
    if (typeof entry.name !== 'string') {
      warn(`entry ${JSON.stringify(entry)}`, `Skipping the definition of registry entry ${entry.id}: it has no name`);
      continue;
    }
    const def = presentable(entry, issuer, warn);
    index.byId.set(id, def);
    if (def.assetKind === 'non-fungible') index.byType.set(id, def);
    if (def.symbol) index.bySymbol.set(def.symbol.toUpperCase(), def);
    index.byName.set(def.name.toLowerCase(), def);
  }
  return index;
}
