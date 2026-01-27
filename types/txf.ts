/**
 * TXF (Token eXchange Format) Type Definitions
 * Based on TXF Format Specification v2.0
 *
 * These types define the serialization format for tokens,
 * independent of any UI or storage implementation.
 */

// =============================================================================
// TXF Token Structure (v2.0)
// =============================================================================

/**
 * Complete token object in TXF format
 */
export interface TxfToken {
  version: '2.0';
  genesis: TxfGenesis;
  state: TxfState;
  transactions: TxfTransaction[];
  nametags?: string[];
  _integrity?: TxfIntegrity;
}

/**
 * Genesis transaction (initial minting)
 */
export interface TxfGenesis {
  data: TxfGenesisData;
  inclusionProof: TxfInclusionProof;
}

/**
 * Genesis data payload
 */
export interface TxfGenesisData {
  tokenId: string;              // 64-char hex
  tokenType: string;            // 64-char hex
  coinData: [string, string][]; // [[coinId, amount], ...]
  tokenData: string;            // Optional metadata
  salt: string;                 // 64-char hex
  recipient: string;            // DIRECT://... address
  recipientDataHash: string | null;
  reason: string | null;
}

/**
 * Current token state
 */
export interface TxfState {
  data: string;
  predicate: string;  // Hex-encoded CBOR predicate
}

/**
 * State transition transaction
 */
export interface TxfTransaction {
  previousStateHash: string;
  newStateHash?: string;
  predicate: string;
  inclusionProof: TxfInclusionProof | null;  // null = uncommitted
  data?: Record<string, unknown>;
}

/**
 * Sparse Merkle Tree inclusion proof
 */
export interface TxfInclusionProof {
  authenticator: TxfAuthenticator;
  merkleTreePath: TxfMerkleTreePath;
  transactionHash: string;
  unicityCertificate: string;  // Hex-encoded CBOR
}

/**
 * Proof authenticator
 */
export interface TxfAuthenticator {
  algorithm: string;
  publicKey: string;
  signature: string;
  stateHash: string;
}

/**
 * Merkle tree path for proof verification
 */
export interface TxfMerkleTreePath {
  root: string;
  steps: TxfMerkleStep[];
}

/**
 * Single step in merkle path
 */
export interface TxfMerkleStep {
  data: string;
  path: string;
}

/**
 * Token integrity metadata
 */
export interface TxfIntegrity {
  genesisDataJSONHash: string;
  currentStateHash?: string;
}

// =============================================================================
// Storage Format (for IPFS/File storage)
// =============================================================================

/**
 * Nametag data (one per identity)
 */
export interface NametagData {
  name: string;
  token: object;
  timestamp: number;
  format: string;
  version: string;
}

/**
 * Tombstone entry for tracking spent token states
 */
export interface TombstoneEntry {
  tokenId: string;
  stateHash: string;
  timestamp: number;
}

/**
 * Invalidated nametag entry
 */
export interface InvalidatedNametagEntry {
  name: string;
  token: object;
  timestamp: number;
  format: string;
  version: string;
  invalidatedAt: number;
  invalidationReason: string;
}

/**
 * Outbox entry for pending transfers
 */
export interface OutboxEntry {
  id: string;
  status: 'pending' | 'submitted' | 'confirmed' | 'delivered' | 'failed';
  sourceTokenId: string;
  salt: string;
  commitmentJson: string;
  recipientPubkey: string;
  recipientNametag?: string;
  amount: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
  retryCount?: number;
}

/**
 * Mint outbox entry for pending mints
 */
export interface MintOutboxEntry {
  id: string;
  status: 'pending' | 'submitted' | 'confirmed' | 'failed';
  type: 'split' | 'faucet' | 'other';
  salt: string;
  requestIdHex: string;
  mintDataJson: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

/**
 * Storage metadata
 */
export interface TxfMeta {
  version: number;
  address: string;
  ipnsName: string;
  formatVersion: '2.0';
  lastCid?: string;
  deviceId?: string;
}

/**
 * Complete storage data structure
 */
export interface TxfStorageData {
  _meta: TxfMeta;
  _nametag?: NametagData;
  _tombstones?: TombstoneEntry[];
  _invalidatedNametags?: InvalidatedNametagEntry[];
  _outbox?: OutboxEntry[];
  _mintOutbox?: MintOutboxEntry[];
  [key: string]: TxfToken | TxfMeta | NametagData | TombstoneEntry[] | InvalidatedNametagEntry[] | OutboxEntry[] | MintOutboxEntry[] | undefined;
}

// =============================================================================
// Token Storage Provider Interface
// =============================================================================

/**
 * Base interface that storage providers must implement
 * to support TXF token storage
 */
export interface TxfStorageDataBase {
  _meta: TxfMeta;
  _nametag?: NametagData;
  _tombstones?: TombstoneEntry[];
  _invalidatedNametags?: InvalidatedNametagEntry[];
  _outbox?: OutboxEntry[];
  _mintOutbox?: MintOutboxEntry[];
  [key: string]: unknown;
}

// =============================================================================
// Validation Types
// =============================================================================

export interface ValidationIssue {
  tokenId: string;
  reason: string;
  recoverable?: boolean;
}

export interface TokenValidationResult {
  isValid: boolean;
  reason?: string;
  action?: 'ACCEPT' | 'RETRY_LATER' | 'DISCARD_FORK';
}

// =============================================================================
// Key Utilities
// =============================================================================

const ARCHIVED_PREFIX = '_archived_';
const FORKED_PREFIX = '_forked_';
const RESERVED_KEYS = ['_meta', '_nametag', '_tombstones', '_invalidatedNametags', '_outbox', '_mintOutbox', '_sent', '_invalid', '_integrity'];

/**
 * Check if a key is an active token key
 */
export function isTokenKey(key: string): boolean {
  return key.startsWith('_') &&
    !key.startsWith(ARCHIVED_PREFIX) &&
    !key.startsWith(FORKED_PREFIX) &&
    !RESERVED_KEYS.includes(key);
}

/**
 * Check if a key is an archived token key
 */
export function isArchivedKey(key: string): boolean {
  return key.startsWith(ARCHIVED_PREFIX);
}

/**
 * Check if a key is a forked token key
 */
export function isForkedKey(key: string): boolean {
  return key.startsWith(FORKED_PREFIX);
}

/**
 * Extract token ID from storage key
 */
export function tokenIdFromKey(key: string): string {
  return key.startsWith('_') ? key.substring(1) : key;
}

/**
 * Create storage key from token ID
 */
export function keyFromTokenId(tokenId: string): string {
  return `_${tokenId}`;
}

/**
 * Extract token ID from archived key
 */
export function tokenIdFromArchivedKey(key: string): string {
  return key.startsWith(ARCHIVED_PREFIX) ? key.substring(ARCHIVED_PREFIX.length) : key;
}

/**
 * Create archived key from token ID
 */
export function archivedKeyFromTokenId(tokenId: string): string {
  return `${ARCHIVED_PREFIX}${tokenId}`;
}

/**
 * Create forked key from token ID and state hash
 */
export function forkedKeyFromTokenIdAndState(tokenId: string, stateHash: string): string {
  return `${FORKED_PREFIX}${tokenId}_${stateHash}`;
}

/**
 * Parse forked key into tokenId and stateHash
 */
export function parseForkedKey(key: string): { tokenId: string; stateHash: string } | null {
  if (!key.startsWith(FORKED_PREFIX)) return null;
  const remainder = key.substring(FORKED_PREFIX.length);
  const underscoreIndex = remainder.indexOf('_');
  if (underscoreIndex === -1 || underscoreIndex < 64) return null;
  return {
    tokenId: remainder.substring(0, underscoreIndex),
    stateHash: remainder.substring(underscoreIndex + 1),
  };
}

/**
 * Validate 64-character hex token ID
 */
export function isValidTokenId(tokenId: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(tokenId);
}
