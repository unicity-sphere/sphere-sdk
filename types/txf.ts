/**
 * TXF (Token eXchange Format) Type Definitions — v2 persistence layer.
 *
 * Wave 6-P2-17: the profile persistence layer stores v2 SphereToken
 * blobs wrapped in a small JSON envelope — the same shape the v2
 * wire path (`PaymentsModule.deliverTokens`) uses over Nostr. The v1
 * chain shape (`TxfToken` with `genesis` / `state` / `transactions` /
 * `_integrity`) is gone; there is NO backward compatibility with v1
 * persistence, per the phase-6 migration mandate.
 *
 * Wave 6-P2-18: the deprecated v1 chain-shape name aliases
 * (`TxfToken`, `TxfGenesis`, `TxfGenesisData`, `TxfState`,
 * `TxfTransaction`, `TxfIntegrity`, `TxfInclusionProof`,
 * `TxfAuthenticator`, `TxfMerkleTreePath`, `TxfMerkleStep`) that were
 * kept for one wave of source compat are now DELETED. Non-legacy
 * runtime code that still consumes the underlying state-transition-sdk
 * v1-shape JSON uses `unknown` at the type boundary or a local minimal
 * interface — the v1 alias no longer exists anywhere in the type
 * system. Consumers that want "the shape a token takes when stored in
 * Profile" use `SphereTokenPersistenceEntry`.
 */

// =============================================================================
// v2 Persistence Entry (Wave 6-P2-17)
// =============================================================================

/**
 * A v2 SphereToken envelope, stored under `_${tokenId}` in the
 * Profile-shaped `TxfStorageDataBase`.
 *
 * The envelope wraps the raw v2 SphereToken CBOR blob (base64-encoded)
 * along with the blob's `v` / `network` / `tokenId` metadata so consumers
 * can select the right `ITokenEngine.decodeToken` implementation without
 * decoding the payload first.
 *
 * Byte-for-byte compatible with the `SphereTokenEnvelope` produced by
 * `encodeSdkDataEnvelope` in `modules/payments/PaymentsModule.ts` and
 * consumed by the send/receive wire path — so persisted tokens and
 * in-flight tokens share a single canonical serialization.
 */
export interface SphereTokenPersistenceEntry {
  /** Envelope schema tag. `'v2'` for wave 6-P2-17. */
  _sdkVersion: string;
  /** Envelope format identifier. `'sphere-token-blob'` for wave 6-P2-17. */
  _format: string;
  /** v2 SphereToken blob version (`TokenBlob.v`). */
  v: number;
  /** Network ID (`TokenBlob.network`; 1=mainnet, 2=testnet2/dev). */
  network: number;
  /** 64-char hex token identifier. */
  tokenId: string;
  /** Base64-encoded raw v2 SphereToken CBOR bytes. */
  token: string;
}

// =============================================================================
// v1 chain-shape aliases — DELETED (Wave 6-P2-18)
// =============================================================================
//
// The `TxfToken` / `TxfGenesis` / `TxfGenesisData` / `TxfState` /
// `TxfTransaction` / `TxfIntegrity` / `TxfInclusionProof` /
// `TxfAuthenticator` / `TxfMerkleTreePath` / `TxfMerkleStep` type
// aliases that Wave 6-P2-17 kept as one-wave-of-source-compat
// deprecated `any` aliases are DELETED here.
//
// Any non-legacy consumer that used to import one of those names
// migrates to either:
//   - `SphereTokenPersistenceEntry` (this file) — for the v2 envelope
//     stored in Profile / TXF storage;
//   - `unknown` at the type boundary + a local minimal interface for
//     the fields it actually reads — for the state-transition-sdk
//     v1-shape JSON that survives until the STSDK v2 swap lands.
//
// There is NO v1 backward compatibility on any hot persistence / wire
// path. Files under `**/legacy-v1/**` still speak the v1 shape but
// are excluded from the main test surface.

// =============================================================================
// Storage Format (for IPFS/File storage)
// =============================================================================

/**
 * Nametag data (one per identity).
 */
export interface NametagData {
  name: string;
  token: object;
  timestamp: number;
  format: string;
  version: string;
}

/**
 * Tombstone entry for tracking spent token states.
 */
export interface TombstoneEntry {
  tokenId: string;
  stateHash: string;
  timestamp: number;
  deletedAt?: number;
}

/**
 * Invalidated nametag entry.
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
 * Outbox entry for pending transfers.
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
 * Mint outbox entry for pending mints.
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
 * Storage metadata.
 *
 * Wave 6-P2-17: `updatedAt` is optional (some pre-existing writers
 * populate it, some do not). `address` is kept for compat with the
 * pre-#652 (chainPubkey-rekey) reader path; new writers may leave it
 * empty and use only `chainPubkey`.
 */
export interface TxfMeta {
  version: number;
  address: string;
  ipnsName?: string;
  formatVersion: string;
  lastCid?: string;
  deviceId?: string;
  updatedAt?: number;
}

/**
 * Complete storage data structure.
 *
 * Wave 6-P2-17: token entries under `_${tokenId}` keys carry
 * `SphereTokenPersistenceEntry` values — the v2 envelope shape.
 */
export interface TxfStorageData {
  _meta: TxfMeta;
  _nametag?: NametagData;
  _nametags?: NametagData[];
  _tombstones?: TombstoneEntry[];
  _invalidatedNametags?: InvalidatedNametagEntry[];
  _outbox?: OutboxEntry[];
  _mintOutbox?: MintOutboxEntry[];
  // Wave 6-P2-18: token entries under `_${tokenId}` are held as
  // `unknown` at the storage type surface. The v2 Profile persistence
  // layer stores `SphereTokenPersistenceEntry`; other adapters (the
  // legacy FileTokenStorage that still speaks the state-transition-sdk
  // v1 JSON) put v1-shape entries here. Consumers narrow via
  // `isSphereTokenPersistenceEntry` at read time.
  [key: string]: unknown;
}

// =============================================================================
// Token Storage Provider Interface
// =============================================================================

/**
 * Base interface that storage providers must implement to support v2
 * token persistence.
 *
 * The index signature is `unknown` so the file/indexedDB/IPFS layers
 * that shuttle this object around do not need to know the token shape.
 * Consumers (PaymentsModule, ProfileTokenStorageProvider) resolve the
 * shape at read time via `SphereTokenPersistenceEntry`.
 */
export interface TxfStorageDataBase {
  _meta: TxfMeta;
  _nametag?: NametagData;
  _nametags?: NametagData[];
  _tombstones?: TombstoneEntry[];
  _invalidatedNametags?: InvalidatedNametagEntry[];
  _outbox?: OutboxEntry[];
  _mintOutbox?: MintOutboxEntry[];
  _history?: unknown[];
  _sent?: unknown[];
  _invalid?: unknown[];
  _audit?: unknown[];
  _finalizationQueue?: unknown[];
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

const ARCHIVED_PREFIX = 'archived-';
const FORKED_PREFIX = '_forked_';
const RESERVED_KEYS = [
  '_meta',
  '_nametag',
  '_nametags',
  '_tombstones',
  '_invalidatedNametags',
  '_outbox',
  '_mintOutbox',
  '_sent',
  '_invalid',
  '_integrity',
  '_history',
  '_audit',
  '_finalizationQueue',
];

/**
 * Check if a key is an active token key.
 */
export function isTokenKey(key: string): boolean {
  return (
    key.startsWith('_') &&
    !key.startsWith(ARCHIVED_PREFIX) &&
    !key.startsWith(FORKED_PREFIX) &&
    !RESERVED_KEYS.includes(key)
  );
}

/**
 * Check if a key is an archived token key.
 */
export function isArchivedKey(key: string): boolean {
  return key.startsWith(ARCHIVED_PREFIX);
}

/**
 * Check if a key is a forked token key.
 */
export function isForkedKey(key: string): boolean {
  return key.startsWith(FORKED_PREFIX);
}

/**
 * Extract token ID from storage key.
 */
export function tokenIdFromKey(key: string): string {
  return key.startsWith('_') ? key.substring(1) : key;
}

/**
 * Create storage key from token ID.
 */
export function keyFromTokenId(tokenId: string): string {
  return `_${tokenId}`;
}

/**
 * Extract token ID from archived key.
 */
export function tokenIdFromArchivedKey(key: string): string {
  return key.startsWith(ARCHIVED_PREFIX) ? key.substring(ARCHIVED_PREFIX.length) : key;
}

/**
 * Create archived key from token ID.
 */
export function archivedKeyFromTokenId(tokenId: string): string {
  return `${ARCHIVED_PREFIX}${tokenId}`;
}

/**
 * Create forked key from token ID and state hash.
 */
export function forkedKeyFromTokenIdAndState(tokenId: string, stateHash: string): string {
  return `${FORKED_PREFIX}${tokenId}_${stateHash}`;
}

/**
 * Parse forked key into tokenId and stateHash.
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
 * Validate 64-character hex token ID.
 *
 * The canonical lowercase `[0-9a-f]{64}` form so this validator
 * agrees with the importer's `CANONICAL_TOKEN_ID_RE` shape contract
 * (`modules/payments/transfer/import-inclusion-proof.ts`). Callers
 * that legitimately receive uppercase hex from the SDK MUST
 * lowercase-normalize at the call site before invoking this validator.
 */
export function isValidTokenId(tokenId: string): boolean {
  return /^[0-9a-f]{64}$/.test(tokenId);
}

/**
 * Structural predicate for a v2 `SphereTokenPersistenceEntry`.
 *
 * Wave 6-P2-17: recognizes the envelope by its shape signature —
 * `tokenId` string, `token` string (base64 blob bytes), and `network`
 * number. `_format` is checked when present (defensive) but is not
 * required.
 */
export function isSphereTokenPersistenceEntry(
  value: unknown,
): value is SphereTokenPersistenceEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Partial<SphereTokenPersistenceEntry>;
  if (typeof v.tokenId !== 'string') return false;
  if (typeof v.token !== 'string') return false;
  if (typeof v.network !== 'number') return false;
  if (v._format !== undefined && v._format !== 'sphere-token-blob') return false;
  return true;
}
