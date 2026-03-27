import { UxfError } from './errors.js';

// ---------------------------------------------------------------------------
// 2.1 Content Hash
// ---------------------------------------------------------------------------

/**
 * 32-byte SHA-256 content hash, hex-encoded (64 lowercase characters).
 * This is the universal address for any element in the pool.
 */
export type ContentHash = string & { readonly __brand: 'ContentHash' };

/**
 * Create a branded ContentHash from a raw hex string.
 * Validates length (64 chars), lowercase hex, and character set.
 */
export function contentHash(hex: string): ContentHash {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new UxfError('INVALID_HASH', `Invalid content hash: ${hex}`);
  }
  return hex as ContentHash;
}

// ---------------------------------------------------------------------------
// 2.2 Element Header
// ---------------------------------------------------------------------------

/**
 * Well-known instance kinds. Extensible via string for future kinds.
 */
export type UxfInstanceKind =
  | 'default'
  | 'individual-proof'
  | 'consolidated-proof'
  | 'zk-proof'
  | 'full-history'
  | (string & {}); // allow custom kinds while preserving autocomplete

/**
 * Describes the version, lineage, and kind of every DAG element.
 * Serialized as the first field in every element's CBOR encoding.
 */
export interface UxfElementHeader {
  /** Encoding format version (increments when serialization layout changes) */
  readonly representation: number;
  /** Protocol semantic version (fixed at element creation, governs validation rules) */
  readonly semantics: number;
  /** Instance kind identifier for selection during reassembly */
  readonly kind: UxfInstanceKind;
  /** Content hash of the previous instance in the chain, or null for the original */
  readonly predecessor: ContentHash | null;
}

// ---------------------------------------------------------------------------
// 2.3 Element Type Taxonomy
// ---------------------------------------------------------------------------

/**
 * Discriminated union tag for element content types.
 * Each maps 1:1 to a structural node type in the token hierarchy.
 */
export type UxfElementType =
  | 'token-root'
  | 'genesis'
  | 'genesis-data'
  | 'transaction'
  | 'transaction-data'
  | 'inclusion-proof'
  | 'authenticator'
  | 'unicity-certificate'
  | 'predicate'
  | 'token-state'
  | 'token-coin-data'
  | 'smt-path';

/**
 * Maps UxfElementType string tags to unsigned integer type IDs.
 * Values are taken from SPECIFICATION Section 2.1.
 */
export const ELEMENT_TYPE_IDS: Readonly<Record<UxfElementType, number>> = {
  'token-root': 0x01,
  'genesis': 0x02,
  'transaction': 0x03,
  'genesis-data': 0x04,
  'transaction-data': 0x05,
  'token-state': 0x06,
  'predicate': 0x07,
  'inclusion-proof': 0x08,
  'authenticator': 0x09,
  'unicity-certificate': 0x0a,
  'token-coin-data': 0x0c,
  'smt-path': 0x0d,
};

// ---------------------------------------------------------------------------
// 2.4 UxfElement -- Base DAG Node
// ---------------------------------------------------------------------------

/**
 * Content is the inline, non-reference data of an element.
 * Kept as a plain record for flexibility; each element type defines
 * its own content shape (see typed element interfaces below).
 */
export type UxfElementContent = Readonly<Record<string, unknown>>;

/**
 * A single node in the content-addressed DAG.
 * Every element is independently hashable, storable, and addressable.
 */
export interface UxfElement {
  /** Element header (version, kind, predecessor) */
  readonly header: UxfElementHeader;
  /** Discriminated type tag */
  readonly type: UxfElementType;
  /** Type-specific content (inline scalar data -- never child elements) */
  readonly content: UxfElementContent;
  /**
   * Ordered child references by role name.
   * Each value is a single ContentHash, an array of ContentHash, or null
   * (for nullable child references such as uncommitted transaction proofs).
   */
  readonly children: Readonly<Record<string, ContentHash | ContentHash[] | null>>;
}

// ---------------------------------------------------------------------------
// 2.5 Typed Element Definitions
// ---------------------------------------------------------------------------

// ---- Token Root ----

export interface TokenRootContent {
  readonly tokenId: string;   // 64-char hex
  readonly version: string;   // e.g. "2.0"
}

export interface TokenRootChildren {
  readonly genesis: ContentHash;
  readonly transactions: ContentHash[];   // ordered, 0..N
  readonly state: ContentHash;
  readonly nametags: ContentHash[];       // each points to a token-root (recursive)
}

// ---- Genesis ----

/** All data lives in children; no inline content. */
export interface GenesisContent {}

export interface GenesisChildren {
  readonly data: ContentHash;              // -> genesis-data
  readonly inclusionProof: ContentHash;    // -> inclusion-proof
  readonly destinationState: ContentHash;  // -> token-state (post-genesis state)
}

// ---- Genesis Data ----

export interface GenesisDataContent {
  readonly tokenId: string;
  readonly tokenType: string;
  readonly coinData: ReadonlyArray<readonly [string, string]>;
  readonly tokenData: string;
  readonly salt: string;
  readonly recipient: string;
  readonly recipientDataHash: string | null;
  /**
   * Reason for minting. Stored as opaque bytes to handle three cases:
   * - Regular mints: null
   * - Simple text reasons: UTF-8 encoded string bytes
   * - Split tokens: dag-cbor encoded ISplitMintReasonJson
   */
  readonly reason: Uint8Array | null;
}
// No children -- leaf node.

// ---- Transaction ----

/** All data lives in children; no inline content. */
export interface TransactionContent {}

export interface TransactionChildren {
  readonly sourceState: ContentHash;             // -> token-state (state before transition)
  readonly data: ContentHash | null;             // -> transaction-data (null if uncommitted)
  readonly inclusionProof: ContentHash | null;   // -> inclusion-proof (null if uncommitted)
  readonly destinationState: ContentHash;        // -> token-state (state after transition)
}

// ---- Transaction Data ----

export interface TransactionDataContent {
  readonly recipient: string;
  readonly salt: string;
  readonly recipientDataHash: string | null;
  readonly message: string | null;
  readonly nametagRefs: ContentHash[];
}
// No children -- leaf node.

// ---- Inclusion Proof ----

export interface InclusionProofContent {
  readonly transactionHash: string;
}

export interface InclusionProofChildren {
  readonly authenticator: ContentHash;
  readonly merkleTreePath: ContentHash;       // -> smt-path
  readonly unicityCertificate: ContentHash;
}

// ---- Authenticator ----

export interface AuthenticatorContent {
  readonly algorithm: string;
  readonly publicKey: string;
  readonly signature: string;
  readonly stateHash: string;
}
// No children -- leaf node.

// ---- SMT Path ----

export interface SmtPathContent {
  readonly root: string;
  readonly segments: ReadonlyArray<{ readonly data: string; readonly path: string }>;
}
// No children -- segments are inline leaf data, NOT separate elements.

// ---- Unicity Certificate ----

export interface UnicityCertificateContent {
  /** Raw hex-encoded CBOR blob, stored opaquely */
  readonly raw: string;
}
// No children -- leaf node.

// ---- Predicate ----

export interface PredicateContent {
  /** Hex-encoded CBOR predicate */
  readonly raw: string;
}
// No children -- leaf node.

// ---- Token State ----

export interface StateContent {
  readonly data: string;
  readonly predicate: string;
}
// No children -- leaf node.

// ---- Token Coin Data ----
// (Phase 1: coinData is inline in genesis-data; this type exists for future dedup.)
export interface TokenCoinDataContent {
  readonly entries: ReadonlyArray<readonly [string, string]>;
}
// No children -- leaf node.

// ---------------------------------------------------------------------------
// 2.6 UxfManifest
// ---------------------------------------------------------------------------

/**
 * Maps tokenId -> root element hash.
 * The manifest is the entry point for reassembly.
 */
export interface UxfManifest {
  /** tokenId (64-char hex) -> ContentHash of the token-root element */
  readonly tokens: ReadonlyMap<string, ContentHash>;
}

// ---------------------------------------------------------------------------
// 2.7 Instance Chain Index
// ---------------------------------------------------------------------------

/**
 * Per-element instance chain metadata.
 */
export interface InstanceChainEntry {
  /** Content hash of the newest (head) instance */
  readonly head: ContentHash;
  /** Ordered list from head -> original, with kind annotations */
  readonly chain: ReadonlyArray<{
    readonly hash: ContentHash;
    readonly kind: UxfInstanceKind;
  }>;
}

/**
 * The instance chain index.
 * Key: content hash of ANY element in any chain.
 * Value: the chain entry for that element's chain.
 */
export type InstanceChainIndex = ReadonlyMap<ContentHash, InstanceChainEntry>;

// ---------------------------------------------------------------------------
// 2.8 Instance Selection Strategy
// ---------------------------------------------------------------------------

/**
 * Strategy for selecting which instance to use during reassembly.
 */
export type InstanceSelectionStrategy =
  | { readonly type: 'latest' }
  | { readonly type: 'original' }
  | { readonly type: 'by-representation'; readonly version: number }
  | { readonly type: 'by-kind'; readonly kind: UxfInstanceKind; readonly fallback?: InstanceSelectionStrategy }
  | { readonly type: 'custom'; readonly predicate: (element: UxfElement) => boolean; readonly fallback?: InstanceSelectionStrategy };

/** Default strategy: use the head (most recent) instance */
export const STRATEGY_LATEST: InstanceSelectionStrategy = { type: 'latest' };
export const STRATEGY_ORIGINAL: InstanceSelectionStrategy = { type: 'original' };

// ---------------------------------------------------------------------------
// 2.9 UxfEnvelope, UxfIndexes, UxfPackageData
// ---------------------------------------------------------------------------

/**
 * Package envelope metadata.
 */
export interface UxfEnvelope {
  /** UXF format version (e.g., '1.0.0') */
  readonly version: string;
  /** Creation timestamp (Unix seconds since epoch) */
  readonly createdAt: number;
  /** Last modification timestamp (Unix seconds since epoch) */
  readonly updatedAt: number;
  /** Optional human-readable description */
  readonly description?: string;
  /** Optional creator identity (chainPubkey) */
  readonly creator?: string;
}

/**
 * Secondary indexes for O(1) lookups.
 */
export interface UxfIndexes {
  /** tokenType (hex) -> Set<tokenId> */
  readonly byTokenType: ReadonlyMap<string, ReadonlySet<string>>;
  /** coinId -> Set<tokenId> */
  readonly byCoinId: ReadonlyMap<string, ReadonlySet<string>>;
  /** stateHash -> tokenId (current state only) */
  readonly byStateHash: ReadonlyMap<string, string>;
}

/**
 * The complete UXF bundle.
 * This is the top-level data structure for all operations.
 *
 * Note: `pool` is typed as a Map for the type definition layer.
 * The ElementPool class (WU-04) wraps this with mutation methods.
 */
export interface UxfPackageData {
  readonly envelope: UxfEnvelope;
  readonly manifest: UxfManifest;
  readonly pool: ReadonlyMap<ContentHash, UxfElement>;
  readonly instanceChains: InstanceChainIndex;
  readonly indexes: UxfIndexes;
}

// ---------------------------------------------------------------------------
// 7.2 Storage Adapter
// ---------------------------------------------------------------------------

/**
 * Abstract storage adapter for persisting UXF packages.
 * Platform implementations live in impl/browser/ and impl/nodejs/.
 */
export interface UxfStorageAdapter {
  /** Save the full package state. */
  save(pkg: UxfPackageData): Promise<void>;
  /** Load a previously saved package, or null if none exists. */
  load(): Promise<UxfPackageData | null>;
  /** Delete the stored package. */
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 8.4 Verification Result
// ---------------------------------------------------------------------------

/**
 * A single issue found during package verification.
 */
export interface UxfVerificationIssue {
  readonly code: string;
  readonly message: string;
  readonly tokenId?: string;
  readonly elementHash?: ContentHash;
}

/**
 * Result of verifying structural integrity of a UXF package.
 */
export interface UxfVerificationResult {
  readonly valid: boolean;
  readonly errors: ReadonlyArray<UxfVerificationIssue>;
  readonly warnings: ReadonlyArray<UxfVerificationIssue>;
  readonly stats: {
    readonly tokensChecked: number;
    readonly elementsChecked: number;
    readonly orphanedElements: number;
    readonly instanceChainsChecked: number;
  };
}

// ---------------------------------------------------------------------------
// 8.5 Delta Type
// ---------------------------------------------------------------------------

/**
 * Diff result type representing the minimal delta between two packages.
 */
export interface UxfDelta {
  /** Elements present in target but not in source */
  readonly addedElements: ReadonlyMap<ContentHash, UxfElement>;
  /** Element hashes present in source but not in target */
  readonly removedElements: ReadonlySet<ContentHash>;
  /** Manifest entries added or changed */
  readonly addedTokens: ReadonlyMap<string, ContentHash>;
  /** Token IDs removed from manifest */
  readonly removedTokens: ReadonlySet<string>;
  /** Instance chain entries added */
  readonly addedChainEntries: ReadonlyMap<ContentHash, InstanceChainEntry>;
}
