/**
 * TXF Serializer for SDK2
 * Converts between SDK Token format and TXF storage format
 *
 * Platform-independent implementation that works with SDK types directly.
 */

import type {
  TxfToken,
  TxfTransaction,
  TxfStorageData,
  TxfMeta,
  NametagData,
  TombstoneEntry,
  OutboxEntry,
  MintOutboxEntry,
  InvalidatedNametagEntry,
} from '../types/txf';
import {
  isTokenKey,
  isArchivedKey,
  isForkedKey,
  tokenIdFromKey,
  tokenIdFromArchivedKey,
  parseForkedKey,
  keyFromTokenId,
  archivedKeyFromTokenId,
  forkedKeyFromTokenIdAndState,
} from '../types/txf';
import type { Token, TokenStatus } from '../types';

// =============================================================================
// SDK Token Normalization
// =============================================================================

/**
 * Convert bytes array/object to hex string
 */
function bytesToHex(bytes: number[] | Uint8Array): string {
  const arr = Array.isArray(bytes) ? bytes : Array.from(bytes);
  return arr.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Normalize a value that may be a hex string, bytes object, or Buffer to hex string
 */
function normalizeToHex(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // SDK format: { bytes: [...] }
    if ('bytes' in obj && (Array.isArray(obj.bytes) || obj.bytes instanceof Uint8Array)) {
      return bytesToHex(obj.bytes as number[] | Uint8Array);
    }
    // Buffer.toJSON() format: { type: "Buffer", data: [...] }
    if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
      return bytesToHex(obj.data as number[]);
    }
  }
  return String(value);
}

/**
 * Normalize SDK token JSON to canonical TXF storage format.
 * Converts all bytes objects to hex strings before storage.
 */
export function normalizeSdkTokenToStorage(sdkTokenJson: unknown): TxfToken {
  const txf = JSON.parse(JSON.stringify(sdkTokenJson));

  // Normalize genesis.data fields
  if (txf.genesis?.data) {
    const data = txf.genesis.data;
    if (data.tokenId !== undefined) {
      data.tokenId = normalizeToHex(data.tokenId);
    }
    if (data.tokenType !== undefined) {
      data.tokenType = normalizeToHex(data.tokenType);
    }
    if (data.salt !== undefined) {
      data.salt = normalizeToHex(data.salt);
    }
  }

  // Normalize authenticator fields in genesis inclusion proof
  if (txf.genesis?.inclusionProof?.authenticator) {
    const auth = txf.genesis.inclusionProof.authenticator;
    if (auth.publicKey !== undefined) {
      auth.publicKey = normalizeToHex(auth.publicKey);
    }
    if (auth.signature !== undefined) {
      auth.signature = normalizeToHex(auth.signature);
    }
  }

  // Normalize transaction authenticators
  if (Array.isArray(txf.transactions)) {
    for (const tx of txf.transactions) {
      if (tx.inclusionProof?.authenticator) {
        const auth = tx.inclusionProof.authenticator;
        if (auth.publicKey !== undefined) {
          auth.publicKey = normalizeToHex(auth.publicKey);
        }
        if (auth.signature !== undefined) {
          auth.signature = normalizeToHex(auth.signature);
        }
      }
    }
  }

  return txf as TxfToken;
}

// =============================================================================
// Token → TXF Conversion
// =============================================================================

/**
 * Extract TXF token structure from Token.sdkData (jsonData)
 */
export function tokenToTxf(token: Token): TxfToken | null {
  const jsonData = token.sdkData;
  if (!jsonData) {
    return null;
  }

  try {
    const txfData = normalizeSdkTokenToStorage(JSON.parse(jsonData));

    if (!txfData.genesis || !txfData.state) {
      return null;
    }

    // Ensure required fields
    if (!txfData.version) {
      txfData.version = '2.0';
    }
    if (!txfData.transactions) {
      txfData.transactions = [];
    }
    if (!txfData.nametags) {
      txfData.nametags = [];
    }
    if (!txfData._integrity) {
      txfData._integrity = {
        genesisDataJSONHash: '0000' + '0'.repeat(60),
      };
    }

    return txfData;
  } catch {
    return null;
  }
}

/**
 * Convert token interface to simplified Token for parsing
 */
interface TokenLike {
  id: string;
  sdkData?: string;
}

/**
 * Extract TXF from any object with id and sdkData
 */
export function objectToTxf(obj: TokenLike): TxfToken | null {
  if (!obj.sdkData) return null;
  try {
    const txfData = normalizeSdkTokenToStorage(JSON.parse(obj.sdkData));
    if (!txfData.genesis || !txfData.state) return null;
    return txfData;
  } catch {
    return null;
  }
}

// =============================================================================
// TXF → Token Conversion
// =============================================================================

/**
 * Determine token status from TXF data
 */
function determineTokenStatus(txf: TxfToken): TokenStatus {
  if (txf.transactions.length > 0) {
    const lastTx = txf.transactions[txf.transactions.length - 1];
    if (lastTx.inclusionProof === null) {
      return 'pending';
    }
  }
  return 'confirmed';
}

/**
 * Convert TXF token to Token interface
 */
export function txfToToken(tokenId: string, txf: TxfToken): Token {
  const coinData = txf.genesis.data.coinData;
  const totalAmount = coinData.reduce((sum, [, amt]) => {
    return sum + BigInt(amt || '0');
  }, BigInt(0));

  // Get coin ID (use first non-zero coin, or first coin)
  let coinId = coinData[0]?.[0] || '';
  for (const [cid, amt] of coinData) {
    if (BigInt(amt || '0') > 0) {
      coinId = cid;
      break;
    }
  }

  const tokenType = txf.genesis.data.tokenType;
  const isNft = tokenType === '455ad8720656b08e8dbd5bac1f3c73eeea5431565f6c1c3af742b1aa12d41d89';

  const now = Date.now();

  return {
    id: tokenId,
    coinId,
    symbol: isNft ? 'NFT' : 'UCT',
    name: isNft ? 'NFT' : 'Token',
    decimals: isNft ? 0 : 8,
    amount: totalAmount.toString(),
    status: determineTokenStatus(txf),
    createdAt: now,
    updatedAt: now,
    sdkData: JSON.stringify(txf),
  };
}

// =============================================================================
// Storage Data Building
// =============================================================================

/**
 * Build TXF storage data from tokens and metadata
 */
export async function buildTxfStorageData(
  tokens: Token[],
  meta: Omit<TxfMeta, 'formatVersion'>,
  options?: {
    nametag?: NametagData;
    tombstones?: TombstoneEntry[];
    archivedTokens?: Map<string, TxfToken>;
    forkedTokens?: Map<string, TxfToken>;
    outboxEntries?: OutboxEntry[];
    mintOutboxEntries?: MintOutboxEntry[];
    invalidatedNametags?: InvalidatedNametagEntry[];
  }
): Promise<TxfStorageData> {
  const storageData: TxfStorageData = {
    _meta: {
      ...meta,
      formatVersion: '2.0',
    },
  };

  // Note: nametag is no longer saved here to avoid duplication.
  // Nametag is saved separately via saveNametagToFileStorage() as nametag-{name}.json
  // The options.nametag parameter is kept for backwards compatibility but ignored.

  if (options?.tombstones && options.tombstones.length > 0) {
    storageData._tombstones = options.tombstones;
  }

  if (options?.outboxEntries && options.outboxEntries.length > 0) {
    storageData._outbox = options.outboxEntries;
  }

  if (options?.mintOutboxEntries && options.mintOutboxEntries.length > 0) {
    storageData._mintOutbox = options.mintOutboxEntries;
  }

  if (options?.invalidatedNametags && options.invalidatedNametags.length > 0) {
    storageData._invalidatedNametags = options.invalidatedNametags;
  }

  // Add active tokens
  for (const token of tokens) {
    const txf = tokenToTxf(token);
    if (txf) {
      const actualTokenId = txf.genesis.data.tokenId;
      storageData[keyFromTokenId(actualTokenId)] = txf;
    }
  }

  // Add archived tokens
  if (options?.archivedTokens && options.archivedTokens.size > 0) {
    for (const [tokenId, txf] of options.archivedTokens) {
      storageData[archivedKeyFromTokenId(tokenId)] = txf;
    }
  }

  // Add forked tokens
  if (options?.forkedTokens && options.forkedTokens.size > 0) {
    for (const [key, txf] of options.forkedTokens) {
      const [tokenId, stateHash] = key.split('_');
      if (tokenId && stateHash) {
        storageData[forkedKeyFromTokenIdAndState(tokenId, stateHash)] = txf;
      }
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
  nametag: NametagData | null;
  tombstones: TombstoneEntry[];
  archivedTokens: Map<string, TxfToken>;
  forkedTokens: Map<string, TxfToken>;
  outboxEntries: OutboxEntry[];
  mintOutboxEntries: MintOutboxEntry[];
  invalidatedNametags: InvalidatedNametagEntry[];
  validationErrors: string[];
}

/**
 * Parse TXF storage data
 */
export function parseTxfStorageData(data: unknown): ParsedStorageData {
  const result: ParsedStorageData = {
    tokens: [],
    meta: null,
    nametag: null,
    tombstones: [],
    archivedTokens: new Map(),
    forkedTokens: new Map(),
    outboxEntries: [],
    mintOutboxEntries: [],
    invalidatedNametags: [],
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

  // Extract nametag
  if (storageData._nametag && typeof storageData._nametag === 'object') {
    result.nametag = storageData._nametag as NametagData;
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

  // Extract outbox entries
  if (storageData._outbox && Array.isArray(storageData._outbox)) {
    for (const entry of storageData._outbox) {
      if (
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as OutboxEntry).id === 'string' &&
        typeof (entry as OutboxEntry).status === 'string'
      ) {
        result.outboxEntries.push(entry as OutboxEntry);
      }
    }
  }

  // Extract mint outbox entries
  if (storageData._mintOutbox && Array.isArray(storageData._mintOutbox)) {
    for (const entry of storageData._mintOutbox) {
      if (
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as MintOutboxEntry).id === 'string' &&
        typeof (entry as MintOutboxEntry).status === 'string'
      ) {
        result.mintOutboxEntries.push(entry as MintOutboxEntry);
      }
    }
  }

  // Extract invalidated nametags
  if (storageData._invalidatedNametags && Array.isArray(storageData._invalidatedNametags)) {
    for (const entry of storageData._invalidatedNametags) {
      if (
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as InvalidatedNametagEntry).name === 'string'
      ) {
        result.invalidatedNametags.push(entry as InvalidatedNametagEntry);
      }
    }
  }

  // Extract tokens
  for (const key of Object.keys(storageData)) {
    // Active tokens
    if (isTokenKey(key)) {
      const tokenId = tokenIdFromKey(key);
      try {
        const txfToken = storageData[key] as TxfToken;
        if (txfToken?.genesis?.data?.tokenId) {
          const token = txfToToken(tokenId, txfToken);
          result.tokens.push(token);
        }
      } catch (err) {
        result.validationErrors.push(`Token ${tokenId}: ${err}`);
      }
    }
    // Archived tokens
    else if (isArchivedKey(key)) {
      const tokenId = tokenIdFromArchivedKey(key);
      try {
        const txfToken = storageData[key] as TxfToken;
        if (txfToken?.genesis?.data?.tokenId) {
          result.archivedTokens.set(tokenId, txfToken);
        }
      } catch {
        result.validationErrors.push(`Archived token ${tokenId}: invalid structure`);
      }
    }
    // Forked tokens
    else if (isForkedKey(key)) {
      const parsed = parseForkedKey(key);
      if (parsed) {
        try {
          const txfToken = storageData[key] as TxfToken;
          if (txfToken?.genesis?.data?.tokenId) {
            const mapKey = `${parsed.tokenId}_${parsed.stateHash}`;
            result.forkedTokens.set(mapKey, txfToken);
          }
        } catch {
          result.validationErrors.push(`Forked token ${parsed.tokenId}: invalid structure`);
        }
      }
    }
  }

  return result;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get token ID from Token object (prefers genesis.data.tokenId)
 */
export function getTokenId(token: Token): string {
  if (token.sdkData) {
    try {
      const txf = JSON.parse(token.sdkData);
      if (txf.genesis?.data?.tokenId) {
        return txf.genesis.data.tokenId;
      }
    } catch {
      // Fall through
    }
  }
  return token.id;
}

/**
 * Get the current state hash from a TXF token
 * Checks multiple sources in order of preference:
 * 1. Last transaction's newStateHash
 * 2. _integrity.currentStateHash
 * 3. Last transaction's inclusionProof authenticator stateHash
 * 4. Genesis inclusionProof authenticator stateHash (for never-transferred tokens)
 */
export function getCurrentStateHash(txf: TxfToken): string | undefined {
  // Check last transaction's explicit newStateHash
  if (txf.transactions && txf.transactions.length > 0) {
    const lastTx = txf.transactions[txf.transactions.length - 1];
    if (lastTx?.newStateHash) {
      return lastTx.newStateHash;
    }
    // Check authenticator stateHash from last transaction's proof
    if (lastTx?.inclusionProof?.authenticator?.stateHash) {
      return lastTx.inclusionProof.authenticator.stateHash;
    }
  }

  // Check integrity metadata
  if (txf._integrity?.currentStateHash) {
    return txf._integrity.currentStateHash;
  }

  // For tokens with no transactions, use genesis proof's stateHash
  if (txf.genesis?.inclusionProof?.authenticator?.stateHash) {
    return txf.genesis.inclusionProof.authenticator.stateHash;
  }

  return undefined;
}

/**
 * Check if token has valid TXF data
 */
export function hasValidTxfData(token: Token): boolean {
  if (!token.sdkData) return false;

  try {
    const txf = JSON.parse(token.sdkData);
    return !!(
      txf.genesis &&
      txf.genesis.data &&
      txf.genesis.data.tokenId &&
      txf.state &&
      txf.genesis.inclusionProof
    );
  } catch {
    return false;
  }
}

/**
 * Check if token has uncommitted transactions
 */
export function hasUncommittedTransactions(token: Token): boolean {
  if (!token.sdkData) return false;

  try {
    const txf = JSON.parse(token.sdkData);
    if (!txf.transactions || txf.transactions.length === 0) return false;

    return txf.transactions.some(
      (tx: TxfTransaction) => tx.inclusionProof === null
    );
  } catch {
    return false;
  }
}

/**
 * Check if a TXF token has missing newStateHash on any transaction
 */
export function hasMissingNewStateHash(txf: TxfToken): boolean {
  if (!txf.transactions || txf.transactions.length === 0) {
    return false;
  }
  return txf.transactions.some(tx => !tx.newStateHash);
}

/**
 * Count committed transactions in a token
 */
export function countCommittedTransactions(token: Token): number {
  if (!token.sdkData) return 0;

  try {
    const txf = JSON.parse(token.sdkData);
    if (!txf.transactions) return 0;

    return txf.transactions.filter(
      (tx: TxfTransaction) => tx.inclusionProof !== null
    ).length;
  } catch {
    return 0;
  }
}
