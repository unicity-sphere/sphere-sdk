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
 *
 * `token` shape by `format`:
 * - `'v2-cbor'`: hex-encoded v2 UnicityIdToken CBOR (string) — the self-issued
 *   on-chain claim minted at registration (stored, unused at runtime).
 * - legacy `'txf'`: the v1 nametag token JSON (object) — inert since the v1
 *   cutover, still round-tripped through storage untouched.
 */
export interface NametagData {
  name: string;
  token: object | string;
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
  _nametags?: NametagData[];
  _tombstones?: TombstoneEntry[];
  [key: string]: TxfToken | TxfMeta | NametagData | NametagData[] | TombstoneEntry[] | undefined;
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
  _nametags?: NametagData[];
  _tombstones?: TombstoneEntry[];
  _history?: unknown[];
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
}

// =============================================================================
// Key Utilities
// =============================================================================

/**
 * Underscore keys that are NEVER a token slot.
 *
 * `_invalidatedNametags`, `_outbox`, `_mintOutbox`, `_sent` and `_invalid` are
 * v1 relics that nothing writes any more — but an old stored document can still
 * carry them, and dropping them from this list would make `isTokenKey()` claim
 * those arrays as token entries. They stay as an inert guard, not as a format.
 */
const RESERVED_KEYS = ['_meta', '_nametag', '_nametags', '_tombstones', '_invalidatedNametags', '_outbox', '_mintOutbox', '_sent', '_invalid', '_integrity', '_history'];

/**
 * Check if a key is an active token key
 */
export function isTokenKey(key: string): boolean {
  return key.startsWith('_') && !RESERVED_KEYS.includes(key);
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
 * Validate 64-character hex token ID
 */
export function isValidTokenId(tokenId: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(tokenId);
}
