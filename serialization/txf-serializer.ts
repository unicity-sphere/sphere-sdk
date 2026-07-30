/**
 * TXF storage-data serializer.
 *
 * Builds and parses the `TxfStorageData` DOCUMENT — the `_meta` / `_nametags` /
 * `_tombstones` / `_history` envelope plus the per-token slots. Tokens
 * themselves are opaque v2 CBOR blobs (hex) in `Token.sdkData`; this file never
 * decodes one.
 *
 * A record that is not a v2 blob is logged and skipped on both the read and the
 * write path — never reinterpreted.
 */
import type {
  TxfToken,
  TxfStorageData,
  TxfMeta,
  NametagData,
  TombstoneEntry,
} from '../types/txf';
import type { HistoryRecord } from '../storage';
import {
  isTokenKey,
  tokenIdFromKey,
  keyFromTokenId,
} from '../types/txf';
import type { Token } from '../types';
import { logger } from '../core/logger';

// =============================================================================
// v2 token blob storage (opaque CBOR blob in sdkData, not v1 JSON TXF)
// =============================================================================

/** True when sdkData is an even-length lowercase-hex CBOR blob (a v2 token), not JSON TXF. */
function isV2TokenBlob(sdkData: string | undefined): sdkData is string {
  return (
    typeof sdkData === 'string' &&
    sdkData.length >= 2 &&
    sdkData.length % 2 === 0 &&
    sdkData[0] !== '{' &&
    /^[0-9a-f]+$/i.test(sdkData)
  );
}

/** Genesis token id for a v2 token's storage key (`v2_` is the UI-id prefix convention). */
function v2TokenId(token: Token): string {
  return token.id.startsWith('v2_') ? token.id.slice(3) : token.id;
}

/** A v2 storage entry is the UI token record itself (blob sdkData, no v1 `genesis`). */
function isV2TokenEntry(entry: unknown): entry is Token {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    !('genesis' in entry) &&
    isV2TokenBlob((entry as Token).sdkData)
  );
}

// =============================================================================
// Storage Data Building
// =============================================================================

/**
 * Build TXF storage data from tokens and metadata.
 *
 * Only v2 blob tokens are written. Anything else in `sdkData` has no v2
 * encoding, so it is dropped with a warning rather than written back in a shape
 * the reader cannot interpret.
 */
export async function buildTxfStorageData(
  tokens: Token[],
  meta: Omit<TxfMeta, 'formatVersion'>,
  options?: {
    nametags?: NametagData[];
    tombstones?: TombstoneEntry[];
    historyEntries?: HistoryRecord[];
  }
): Promise<TxfStorageData> {
  const storageData: TxfStorageData = {
    _meta: {
      ...meta,
      formatVersion: '2.0',
    },
  };

  if (options?.nametags && options.nametags.length > 0) {
    storageData._nametags = options.nametags;
  }

  if (options?.tombstones && options.tombstones.length > 0) {
    storageData._tombstones = options.tombstones;
  }

  if (options?.historyEntries && options.historyEntries.length > 0) {
    (storageData as TxfStorageData & { _history: HistoryRecord[] })._history = options.historyEntries;
  }

  // Add active tokens. v2 tokens carry an opaque hex blob in sdkData; the UI
  // token record is stored directly under its genesis token id.
  for (const token of tokens) {
    if (isV2TokenBlob(token.sdkData)) {
      // The v2 entry (a UI token record) lives in the token slot; parse reads it back
      // via isV2TokenEntry. Cast because TxfStorageData's value union predates v2.
      storageData[keyFromTokenId(v2TokenId(token))] = token as unknown as TxfToken;
    } else {
      logger.warn(
        'TXF',
        `Refusing to persist token ${token.id.slice(0, 16)}...: sdkData is not a v2 token blob — entry skipped`
      );
    }
  }



  return storageData;
}

// =============================================================================
// Storage Data Parsing
// =============================================================================

export interface ParsedStorageData {
  tokens: Token[];
  meta: TxfMeta | null;
  nametags: NametagData[];
  tombstones: TombstoneEntry[];
  historyEntries: HistoryRecord[];
  validationErrors: string[];
}

/**
 * Parse TXF storage data
 */
export function parseTxfStorageData(data: unknown): ParsedStorageData {
  const result: ParsedStorageData = {
    tokens: [],
    meta: null,
    nametags: [],
    tombstones: [],
    historyEntries: [],
    validationErrors: [],
  };

  if (!data || typeof data !== 'object') {
    result.validationErrors.push('Storage data is not an object');
    return result;
  }

  const storageData = data as Record<string, unknown>;

  // Extract metadata
  if (storageData._meta && typeof storageData._meta === 'object') {
    result.meta = storageData._meta as TxfMeta;
  }

  // Extract nametags (plural, array — primary source)
  const seenNames = new Set<string>();
  if (Array.isArray(storageData._nametags)) {
    for (const entry of storageData._nametags) {
      if (entry && typeof entry === 'object' && typeof (entry as NametagData).name === 'string') {
        result.nametags.push(entry as NametagData);
        seenNames.add((entry as NametagData).name);
      }
    }
  }

  // Backward compat: read singular _nametag and add if not already present
  if (storageData._nametag && typeof storageData._nametag === 'object') {
    const legacy = storageData._nametag as NametagData;
    if (typeof legacy.name === 'string' && !seenNames.has(legacy.name)) {
      result.nametags.push(legacy);
    }
  }

  // Extract tombstones
  if (storageData._tombstones && Array.isArray(storageData._tombstones)) {
    for (const entry of storageData._tombstones) {
      if (
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as TombstoneEntry).tokenId === 'string' &&
        typeof (entry as TombstoneEntry).stateHash === 'string' &&
        typeof (entry as TombstoneEntry).timestamp === 'number'
      ) {
        result.tombstones.push(entry as TombstoneEntry);
      }
    }
  }

  // Extract history entries
  if (Array.isArray(storageData._history)) {
    for (const entry of storageData._history) {
      if (
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as HistoryRecord).dedupKey === 'string' &&
        typeof (entry as HistoryRecord).type === 'string'
      ) {
        result.historyEntries.push(entry as HistoryRecord);
      }
    }
  }

  // Extract tokens
  for (const key of Object.keys(storageData)) {
    // Active tokens
    if (isTokenKey(key)) {
      const tokenId = tokenIdFromKey(key);
      const entry = storageData[key];
      if (isV2TokenEntry(entry)) {
        // v2 storage entry — the UI token record (opaque blob in sdkData).
        result.tokens.push(entry as Token);
      } else {
        const msg = `Token ${tokenId}: unrecognized storage entry (not a v2 token blob) — entry skipped`;
        logger.warn('TXF', msg);
        result.validationErrors.push(msg);
      }
    }
    // Individual file format tokens (legacy per-file `{ token: TxfToken }` records)
    else if (key.startsWith('token-')) {
      const msg = `Token ${key}: sdkData is not a v2 token blob — entry skipped`;
      logger.warn('TXF', msg);
      result.validationErrors.push(msg);
    }
  }

  return result;
}
