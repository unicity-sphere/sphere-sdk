/**
 * NFT Module Type Definitions
 *
 * All types for the NFTModule: collections, metadata, minting results,
 * query options, verification, storage schemas, and module configuration.
 *
 * @see docs/NFT-ARCHITECTURE.md
 * @see docs/NFT-SPEC.md
 */

import type { FullIdentity, Token, TokenStatus, SphereEventType, SphereEventMap } from '../../types';
import type { StorageProvider, TokenStorageProvider } from '../../storage/storage-provider';
import type { OracleProvider } from '../../oracle/oracle-provider';
import type { PaymentsModule } from '../payments/PaymentsModule';
import type { CommunicationsModule } from '../communications/CommunicationsModule';

// =============================================================================
// §1 Constants
// =============================================================================

/** Maximum length for an NFT name */
export const NFT_MAX_NAME_LENGTH = 256;

/** Maximum length for an NFT description */
export const NFT_MAX_DESCRIPTION_LENGTH = 4096;

/** Maximum number of trait attributes per NFT */
export const NFT_MAX_ATTRIBUTES = 100;

/** Maximum length for an image or animation URI */
export const NFT_MAX_IMAGE_URI_LENGTH = 2048;

/** Maximum number of NFTs in a single batch mint */
export const NFT_MAX_BATCH_SIZE = 50;

/** Maximum length for a collection name */
export const NFT_MAX_COLLECTION_NAME_LENGTH = 128;

/** Upper bound for collection maxSupply */
export const COLLECTION_MAX_SUPPLY_LIMIT = 1_000_000;

// =============================================================================
// §2 Collection Types
// =============================================================================

/**
 * Royalty configuration (informational, not enforced on-chain).
 * Follows ERC-2981 semantics adapted for Unicity.
 */
export interface RoyaltyConfig {
  /** Recipient address (DIRECT://... or chain pubkey) */
  readonly recipient: string;
  /** Royalty percentage in basis points (e.g., 500 = 5%) */
  readonly basisPoints: number;
}

/**
 * Defines an NFT collection. Serialized deterministically to derive collectionId.
 * Immutable once the first NFT is minted — the collectionId is a hash of this.
 */
export interface CollectionDefinition {
  /** Human-readable collection name */
  readonly name: string;
  /** Collection description (markdown-enabled) */
  readonly description: string;
  /** Creator's chain pubkey (33-byte compressed secp256k1, hex) */
  readonly creator: string;
  /** Creation timestamp (ms, creator's local clock) */
  readonly createdAt: number;
  /** Maximum supply (null = unlimited) */
  readonly maxSupply: number | null;
  /** Collection-level image URI (IPFS, HTTPS, or data:) */
  readonly image?: string;
  /** Collection-level external URL */
  readonly externalUrl?: string;
  /** Royalty configuration (optional, informational only) */
  readonly royalty?: RoyaltyConfig;
  /** Whether tokens in this collection are transferable (default: true) */
  readonly transferable?: boolean;
  /**
   * Whether minting uses deterministic salt derivation (default: false).
   *
   * When true, salt = HMAC-SHA256(privateKey, collectionId || editionCounter).
   * This ensures only the emitter (holder of the private key matching `creator`)
   * can compute valid tokenIds for this collection. Third parties cannot
   * pre-mint or front-run editions.
   *
   * When false, salt is random (crypto.getRandomValues). TokenIds are
   * unpredictable to everyone including the emitter.
   */
  readonly deterministicMinting?: boolean;
}

/**
 * Request payload for creating a new collection.
 * Passed to `nft.createCollection()`.
 */
export interface CreateCollectionRequest {
  /** Human-readable collection name (1-128 chars) */
  readonly name: string;
  /** Collection description (1-4096 chars, markdown-enabled) */
  readonly description: string;
  /** Maximum supply (null/undefined = unlimited). If set: integer, 1 ≤ n ≤ 1,000,000 */
  readonly maxSupply?: number | null;
  /** Collection-level image URI (IPFS, HTTPS, or data:) */
  readonly image?: string;
  /** Collection-level external URL */
  readonly externalUrl?: string;
  /** Royalty configuration (optional, informational only) */
  readonly royalty?: RoyaltyConfig;
  /** Whether tokens in this collection are transferable (default: true) */
  readonly transferable?: boolean;
  /** Whether minting uses deterministic salt derivation (default: false) */
  readonly deterministicMinting?: boolean;
}

/**
 * Result of creating a new collection.
 * Returned by `nft.createCollection()`.
 */
export interface CreateCollectionResult {
  /** Deterministic collection ID (SHA-256 of canonical serialization, 64-char hex) */
  readonly collectionId: string;
  /** The stored collection definition */
  readonly definition: CollectionDefinition;
}

// =============================================================================
// §3 NFT Data Types (stored in genesis.data.tokenData)
// =============================================================================

/**
 * Complete NFT data payload, serialized into genesis.data.tokenData.
 * This is immutable once the token is minted.
 */
export interface NFTTokenData {
  /** Collection ID (64-char hex) — links this NFT to its collection. Null for standalone NFTs. */
  readonly collectionId: string | null;
  /** NFT metadata (ERC-721-compatible JSON schema) */
  readonly metadata: NFTMetadata;
  /** Edition number (1-based for collection NFTs, 0 for standalone) */
  readonly edition: number;
  /** Total editions planned (0 for standalone, informational for collections) */
  readonly totalEditions: number;
  /** Minter's chain pubkey (may differ from collection creator for delegated minting) */
  readonly minter?: string;
  /** Mint timestamp (ms) */
  readonly mintedAt: number;
}

/**
 * NFT metadata — follows ERC-721 JSON schema for cross-ecosystem compatibility.
 */
export interface NFTMetadata {
  /** Human-readable token name */
  readonly name: string;
  /** Token description (markdown-enabled) */
  readonly description?: string;
  /** Primary image URI (IPFS recommended: ipfs://Qm...) */
  readonly image: string;
  /** Animation/multimedia URI (video, audio, 3D model, HTML) */
  readonly animationUrl?: string;
  /** External link to creator's page for this token */
  readonly externalUrl?: string;
  /** Background color for display (hex, no # prefix) */
  readonly backgroundColor?: string;
  /** Trait attributes (ERC-721 attributes array format) */
  readonly attributes?: NFTAttribute[];
  /** Arbitrary structured properties */
  readonly properties?: Record<string, unknown>;
  /** Content URIs for different resolutions/formats */
  readonly content?: NFTContent;
}

/**
 * A single trait attribute (ERC-721 attributes format).
 */
export interface NFTAttribute {
  /** Trait category name */
  readonly trait_type: string;
  /** Trait value (string, number, or boolean) */
  readonly value: string | number | boolean;
  /** Display type hint: "number", "boost_number", "boost_percentage", "date" */
  readonly display_type?: string;
  /** Maximum value (for numeric display types) */
  readonly max_value?: number;
}

/**
 * Multi-resolution content references.
 */
export interface NFTContent {
  /** Thumbnail image URI (small, for lists) */
  readonly thumbnail?: string;
  /** Preview image URI (medium, for cards) */
  readonly preview?: string;
  /** Full-resolution image URI */
  readonly full?: string;
  /** Original source file URI */
  readonly original?: string;
}

// =============================================================================
// §4 Reference Types (lightweight in-memory)
// =============================================================================

/**
 * Lightweight NFT reference for listing/filtering.
 * Constructed from token data on load(), held in memory.
 */
export interface NFTRef {
  /** Token ID (= NFT ID, 64-char hex) */
  readonly tokenId: string;
  /** Collection ID (64-char hex), or null for standalone NFTs */
  readonly collectionId: string | null;
  /** NFT name (from metadata) */
  readonly name: string;
  /** Primary image URI */
  readonly image: string;
  /** Edition number (0 for standalone NFTs) */
  readonly edition: number;
  /** Whether this NFT is confirmed (has inclusion proof) */
  readonly confirmed: boolean;
  /** Token status */
  readonly status: TokenStatus;
  /** Mint timestamp */
  readonly mintedAt: number;
}

/**
 * Full NFT detail — extends NFTRef with complete metadata, collection, and token data.
 * Returned by `nft.getNFT()`.
 */
export interface NFTDetail extends NFTRef {
  /** Full NFT metadata */
  readonly metadata: NFTMetadata;
  /** Full collection definition (if available locally) */
  readonly collection?: CollectionDefinition;
  /** Total editions */
  readonly totalEditions?: number;
  /** Minter pubkey */
  readonly minter?: string;
  /** Full token data */
  readonly token: Token;
}

/**
 * Collection reference for listing/filtering.
 * Derived from tokens + stored collection definitions.
 */
export interface CollectionRef {
  /** Collection ID (64-char hex) */
  readonly collectionId: string;
  /** Collection name */
  readonly name: string;
  /** Collection image URI */
  readonly image?: string;
  /** Creator's chain pubkey */
  readonly creator: string;
  /** Number of NFTs from this collection in the wallet */
  readonly tokenCount: number;
  /** Maximum supply (null = unlimited) */
  readonly maxSupply: number | null;
  /** Whether the current wallet is the creator */
  readonly isCreator: boolean;
  /** Royalty config (if set) */
  readonly royalty?: RoyaltyConfig;
  /** Whether tokens are transferable */
  readonly transferable: boolean;
}

/**
 * NFT ownership/transfer history entry.
 * Derived from the token's transaction chain.
 */
export interface NFTHistoryEntry {
  /** Event type */
  readonly type: 'mint' | 'transfer_in' | 'transfer_out';
  /** Counterparty pubkey */
  readonly counterparty?: string;
  /** Counterparty nametag */
  readonly counterpartyNametag?: string;
  /** Timestamp (from inclusion proof) */
  readonly timestamp: number;
  /** Transaction hash */
  readonly txHash?: string;
  /** Whether this event is confirmed */
  readonly confirmed: boolean;
}

/**
 * Result of verifying an NFT against the aggregator.
 */
export interface NFTVerificationResult {
  /** Whether the token is valid */
  readonly valid: boolean;
  /** Whether the token has been spent (transferred away) */
  readonly spent: boolean;
  /** Current state hash from aggregator */
  readonly stateHash?: string;
  /** Verification errors (if any) */
  readonly errors?: string[];
}

// =============================================================================
// §5 Result Types
// =============================================================================

/**
 * Result of minting a single NFT.
 * Returned by `nft.mintNFT()`.
 */
export interface MintNFTResult {
  /** Token ID of the minted NFT (64-char hex) */
  readonly tokenId: string;
  /** Collection ID (null for standalone NFTs) */
  readonly collectionId: string | null;
  /** Whether the mint is confirmed (has inclusion proof) */
  readonly confirmed: boolean;
  /** The NFTRef for the newly minted token */
  readonly nft: NFTRef;
}

/**
 * Result of a batch mint operation.
 * Returned by `nft.batchMintNFT()`.
 */
export interface BatchMintNFTResult {
  /** Individual mint results (successful mints) */
  readonly results: MintNFTResult[];
  /** Number of successfully minted NFTs */
  readonly successCount: number;
  /** Number of failed mints */
  readonly failureCount: number;
  /** Detailed errors for failed mints (if any) */
  readonly errors?: ReadonlyArray<{ readonly index: number; readonly error: string }>;
}

// =============================================================================
// §6 Options Types
// =============================================================================

/**
 * Options for filtering and paginating NFT queries.
 * Passed to `nft.getNFTs()`.
 */
export interface GetNFTsOptions {
  /** Filter by collection ID */
  readonly collectionId?: string;
  /** Filter by token status */
  readonly status?: TokenStatus | TokenStatus[];
  /** Sort field */
  readonly sortBy?: 'name' | 'mintedAt' | 'collectionId';
  /** Sort direction */
  readonly sortOrder?: 'asc' | 'desc';
  /** Pagination: offset */
  readonly offset?: number;
  /** Pagination: limit */
  readonly limit?: number;
}

/**
 * Options for filtering and sorting collection queries.
 * Passed to `nft.getCollections()`.
 */
export interface GetCollectionsOptions {
  /** Only collections created by this wallet */
  readonly createdByMe?: boolean;
  /** Sort field */
  readonly sortBy?: 'name' | 'tokenCount' | 'creator';
  /** Sort direction */
  readonly sortOrder?: 'asc' | 'desc';
}

// =============================================================================
// §7 Configuration
// =============================================================================

/**
 * Configuration for NFTModule.
 * Follows the same dependency-injection pattern as AccountingModuleDependencies.
 */
export interface NFTModuleConfig {
  /** PaymentsModule instance (token queries, send() for transfers) */
  readonly payments: PaymentsModule;
  /** General storage provider (collection registry, mint counters) */
  readonly storage: StorageProvider;
  /** Token storage provider (NFT token persistence) */
  readonly tokenStorage: TokenStorageProvider;
  /** Oracle provider (aggregator, for minting and verification) */
  readonly oracle: OracleProvider;
  /** Current wallet identity */
  readonly identity: FullIdentity;
  /** Current address ID (DIRECT address identifier, e.g., "DIRECT_abc123_xyz789") */
  readonly addressId: string;
  /** Current HD address index */
  readonly addressIndex: number;
  /** Optional CommunicationsModule instance (for NFT-related DMs) */
  readonly communications?: CommunicationsModule;
  /** Event emitter (from Sphere) */
  readonly emitEvent: <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => void;
  /** Optional logger for debug output */
  readonly logger?: (...args: unknown[]) => void;
}

// =============================================================================
// §8 Storage Types
// =============================================================================

/**
 * Persisted collection registry format.
 * Stored in StorageProvider under the NFT_COLLECTIONS key.
 */
export interface NFTCollectionsStorage {
  /** Schema version */
  readonly version: 1;
  /** Collection definitions keyed by collectionId (64-char hex) */
  readonly collections: Record<string, CollectionDefinition>;
}
