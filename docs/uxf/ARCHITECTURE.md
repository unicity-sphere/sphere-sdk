# UXF Architecture Document

## Sphere SDK -- Universal eXchange Format Module

---

## 1. Module Structure

### 1.1 Directory Layout

UXF lives as a top-level module within sphere-sdk, following the same structural pattern as `modules/payments`, `modules/communications`, and `modules/groupchat`. However, because UXF is a packaging/serialization concern rather than a wallet-lifecycle module, it has its own top-level directory (like `serialization/`, `validation/`, `registry/`) rather than nesting under `modules/`.

```
sphere-sdk/
├── uxf/                              # UXF module (new)
│   ├── index.ts                      # Barrel exports
│   ├── types.ts                      # All UXF type definitions
│   ├── UxfPackage.ts                 # Package class (element pool + manifest + indexes)
│   ├── deconstruct.ts                # Token -> DAG element decomposition
│   ├── assemble.ts                   # DAG elements -> Token reassembly
│   ├── element-pool.ts              # ElementPool class (content-addressed store)
│   ├── instance-chain.ts             # Instance chain management and selection
│   ├── hash.ts                       # Content hashing (deterministic CBOR -> SHA-256)
│   ├── cbor.ts                       # Deterministic CBOR encode/decode (dag-cbor subset)
│   ├── diff.ts                       # Package diff/delta computation
│   ├── verify.ts                     # Package and token integrity verification
│   ├── ipld.ts                       # IPLD block export / CID computation
│   └── errors.ts                     # UXF-specific error types
│
├── types/
│   ├── txf.ts                        # (existing, unchanged)
│   └── index.ts                      # (add re-export of uxf types)
│
├── index.ts                          # (add UXF exports)
├── tsup.config.ts                    # (add UXF entry point)
└── package.json                      # (add exports entry for ./uxf)
```

### 1.2 Build Entry Point

A new tsup entry bundles UXF as a standalone importable subpath:

```typescript
// tsup.config.ts addition
{
  entry: { 'uxf/index': 'uxf/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: false,
  splitting: false,
  sourcemap: true,
  platform: 'neutral',   // UXF is platform-agnostic
  target: 'es2022',
  external: [
    /^@unicitylabs\//,
  ],
}
```

```jsonc
// package.json exports addition
"./uxf": {
  "import": { "types": "./dist/uxf/index.d.ts", "default": "./dist/uxf/index.js" },
  "require": { "types": "./dist/uxf/index.d.cts", "default": "./dist/uxf/index.cjs" }
}
```

Consumer import:
```typescript
import { UxfPackage, ingest, assemble } from '@unicitylabs/sphere-sdk/uxf';
```

UXF types are also re-exported from the main barrel (`index.ts`) for convenience.

### 1.3 Integration with Existing Modules

UXF does **not** depend on `PaymentsModule`, `Sphere`, or any wallet-lifecycle class. It depends only on:

- `types/txf.ts` -- for `TxfToken`, `TxfGenesis`, `TxfTransaction`, `TxfInclusionProof`, etc.
- `serialization/txf-serializer.ts` -- for `normalizeSdkTokenToStorage` (bytes-to-hex normalization)
- `@noble/hashes` -- for SHA-256 (already bundled via `noExternal`)

`PaymentsModule` can optionally consume UXF for persistence (replacing its flat `TxfStorageData` with a `UxfPackage`), but this is a separate integration step -- UXF stands alone first.

The relationship is:

```
PaymentsModule ──uses──> TxfStorageData (today)
PaymentsModule ──uses──> UxfPackage     (future, optional wrapper)
                              │
                              ▼
                         UxfPackage ──reads──> TxfToken (deconstructed into elements)
```

---

## 2. Core Data Model (TypeScript Types)

All types live in `/home/vrogojin/uxf/uxf/types.ts`.

### 2.1 Content Hash

```typescript
/**
 * 32-byte SHA-256 content hash, hex-encoded (64 characters).
 * This is the universal address for any element in the pool.
 */
export type ContentHash = string & { readonly __brand: 'ContentHash' };

/**
 * Create a branded ContentHash from a raw hex string.
 * Validates length and hex format.
 */
export function contentHash(hex: string): ContentHash {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new UxfError('INVALID_HASH', `Invalid content hash: ${hex}`);
  }
  return hex as ContentHash;
}
```

### 2.2 Element Header

```typescript
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

/**
 * Well-known instance kinds. Extensible via string for future kinds.
 */
export type UxfInstanceKind =
  | 'default'
  | 'individual-proof'
  | 'consolidated-proof'
  | 'zk-proof'
  | 'full-history'
  | (string & {});  // allow custom kinds while preserving autocomplete
```

### 2.3 Element Type Taxonomy

```typescript
/**
 * Discriminated union tag for element content types.
 * Each maps 1:1 to a structural node type in the token hierarchy.
 */
export type UxfElementType =
  | 'token-root'           // Root of a token DAG (references genesis, transactions[], state, nametags[])
  | 'genesis'              // Genesis record (references genesis-data, inclusion-proof, destination-state)
  | 'genesis-data'         // Immutable mint parameters (tokenId, tokenType, coinData, salt, recipient)
  | 'transaction'          // State transition (references predicate, inclusion-proof, tx-data)
  | 'transaction-data'     // Per-transfer parameters (memo, extra fields)
  | 'inclusion-proof'      // SMT proof bundle (references authenticator, merkle-tree-path, unicity-certificate)
  | 'authenticator'        // PubKey + signature + stateHash
  | 'merkle-tree-path'     // SMT root + steps array
  | 'merkle-step'          // Single SMT step (data + path)
  | 'unicity-certificate'  // BFT-signed round commitment (hex-encoded CBOR blob)
  | 'predicate'            // Ownership predicate (hex-encoded CBOR)
  | 'token-state'          // Current state (predicate + data)
  | 'destination-state'    // Post-genesis/post-tx state (predicate + data)
  | 'nametag-ref';         // Reference to a nametag token (which is itself a full token-root DAG)
```

### 2.4 UxfElement -- Base DAG Node

```typescript
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
   * Each value is either a single ContentHash or an array of ContentHash.
   * Children are never embedded inline -- they exist as separate pool entries.
   */
  readonly children: Readonly<Record<string, ContentHash | ContentHash[]>>;
}

/**
 * Content is the inline, non-reference data of an element.
 * Kept as a plain record for flexibility; each element type defines
 * its own content shape (see typed element interfaces below).
 */
export type UxfElementContent = Readonly<Record<string, unknown>>;
```

### 2.5 Typed Element Definitions

Each element type has a specific content and children shape. These are compile-time helpers, not distinct runtime types -- the pool stores generic `UxfElement` values.

```typescript
// ---- Token Root ----
export interface TokenRootContent {
  readonly tokenId: string;    // 64-char hex
  readonly version: string;    // e.g. "2.0"
}
export interface TokenRootChildren {
  readonly genesis: ContentHash;
  readonly transactions: ContentHash[];  // ordered, 0..N
  readonly state: ContentHash;
  readonly nametags: ContentHash[];      // each points to a token-root (recursive)
}

// ---- Genesis ----
export interface GenesisContent {}  // all data is in children
export interface GenesisChildren {
  readonly data: ContentHash;             // -> genesis-data
  readonly inclusionProof: ContentHash;   // -> inclusion-proof
  readonly destinationState: ContentHash; // -> destination-state
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
  readonly reason: string | null;
}
// No children -- leaf node.

// ---- Transaction ----
export interface TransactionContent {
  readonly previousStateHash: string;
  readonly newStateHash?: string;
}
export interface TransactionChildren {
  readonly predicate: ContentHash;          // -> predicate
  readonly inclusionProof: ContentHash | null;  // null = uncommitted
  readonly data?: ContentHash;              // -> transaction-data (optional)
}

// ---- Transaction Data ----
export interface TransactionDataContent {
  readonly fields: Readonly<Record<string, unknown>>;
}
// No children -- leaf node.

// ---- Inclusion Proof ----
export interface InclusionProofContent {
  readonly transactionHash: string;
}
export interface InclusionProofChildren {
  readonly authenticator: ContentHash;
  readonly merkleTreePath: ContentHash;
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

// ---- Merkle Tree Path ----
export interface MerkleTreePathContent {
  readonly root: string;
}
export interface MerkleTreePathChildren {
  readonly steps: ContentHash[];  // ordered
}

// ---- Merkle Step ----
export interface MerkleStepContent {
  readonly data: string;
  readonly path: string;
}
// No children -- leaf node.

// ---- Unicity Certificate ----
export interface UnicityCertificateContent {
  /** Raw hex-encoded CBOR blob, stored opaquely */
  readonly raw: string;
}
// No children -- leaf node. The certificate is treated as an
// opaque blob for deduplication purposes. Two certificates with
// identical raw bytes produce identical content hashes.

// ---- Predicate ----
export interface PredicateContent {
  /** Hex-encoded CBOR predicate */
  readonly raw: string;
}
// No children -- leaf node.

// ---- Token State / Destination State ----
export interface StateContent {
  readonly data: string;
  readonly predicate: string;
}
// No children -- leaf node.

// ---- Nametag Ref ----
export interface NametagRefContent {
  readonly name: string;
}
export interface NametagRefChildren {
  readonly tokenRoot: ContentHash;  // points to a full token-root DAG
}
```

### 2.6 UxfManifest

```typescript
/**
 * Maps tokenId -> root element hash.
 * The manifest is the entry point for reassembly.
 */
export interface UxfManifest {
  /** tokenId (64-char hex) -> ContentHash of the token-root element */
  readonly tokens: ReadonlyMap<string, ContentHash>;
}
```

### 2.7 Instance Chain Index

```typescript
/**
 * Per-element instance chain metadata.
 * Maps an element's content hash to the head of its instance chain
 * and records the kind of each instance for efficient selection.
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
 *
 * Every hash in a chain maps to the SAME InstanceChainEntry,
 * enabling O(1) lookup of the head from any point in the chain.
 */
export type InstanceChainIndex = ReadonlyMap<ContentHash, InstanceChainEntry>;
```

### 2.8 Instance Selection Strategy

```typescript
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
```

### 2.9 UxfPackage

```typescript
/**
 * Package envelope metadata.
 */
export interface UxfEnvelope {
  /** UXF format version (e.g., 1) */
  readonly version: number;
  /** Creation timestamp (ms since epoch) */
  readonly createdAt: number;
  /** Last modification timestamp */
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
 */
export interface UxfPackageData {
  readonly envelope: UxfEnvelope;
  readonly manifest: UxfManifest;
  readonly pool: ElementPool;
  readonly instanceChains: InstanceChainIndex;
  readonly indexes: UxfIndexes;
}
```

---

## 3. Element Pool Design

The element pool is the core data structure. It lives in `/home/vrogojin/uxf/uxf/element-pool.ts`.

### 3.1 In-Memory Representation

```typescript
/**
 * Content-addressed element store.
 * All elements across all tokens share a single pool.
 */
export class ElementPool {
  /** hash -> element. The canonical store. */
  private readonly elements: Map<ContentHash, UxfElement> = new Map();

  /** Number of elements in the pool */
  get size(): number { return this.elements.size; }

  /** Check if an element exists */
  has(hash: ContentHash): boolean { return this.elements.has(hash); }

  /** Get element by hash, or undefined */
  get(hash: ContentHash): UxfElement | undefined { return this.elements.get(hash); }

  /**
   * Insert an element. Returns its content hash.
   * If the element already exists (same hash), this is a no-op.
   */
  put(element: UxfElement): ContentHash {
    const hash = computeElementHash(element);
    if (!this.elements.has(hash)) {
      this.elements.set(hash, element);
    }
    return hash;
  }

  /**
   * Remove an element by hash.
   * Returns true if removed, false if not found.
   */
  delete(hash: ContentHash): boolean {
    return this.elements.delete(hash);
  }

  /** Iterate all elements */
  entries(): IterableIterator<[ContentHash, UxfElement]> {
    return this.elements.entries();
  }

  /** All hashes in the pool */
  hashes(): IterableIterator<ContentHash> {
    return this.elements.keys();
  }
}
```

### 3.2 Content Hashing Strategy

Content hashing uses SHA-256 over deterministic CBOR encoding (dag-cbor conventions). The hash is computed over the element's **canonical form** -- header + type + content + children -- never over child element bodies. This ensures structural sharing: identical logical elements produce identical hashes regardless of when they were created.

```typescript
// uxf/hash.ts
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '../core/crypto';
import { encodeDeterministicCbor } from './cbor';

/**
 * Compute the content hash of a UxfElement.
 * 
 * The hash covers:
 *   SHA-256( dag-cbor( [header, type, content, children] ) )
 * 
 * - header: [representation, semantics, kind, predecessor]
 * - type: string tag
 * - content: type-specific inline data
 * - children: { role -> hash | hash[] }
 * 
 * Children are referenced by hash, not by value.
 * This makes the hash a Merkle hash -- changing any descendant
 * changes all ancestors up to the root.
 */
export function computeElementHash(element: UxfElement): ContentHash {
  const canonical = [
    [
      element.header.representation,
      element.header.semantics,
      element.header.kind,
      element.header.predecessor,
    ],
    element.type,
    element.content,
    element.children,
  ];
  const encoded = encodeDeterministicCbor(canonical);
  const digest = sha256(encoded);
  return contentHash(bytesToHex(digest));
}
```

The deterministic CBOR encoder in `uxf/cbor.ts` follows dag-cbor conventions:
- Map keys sorted lexicographically (byte order)
- No indefinite-length encodings
- Canonical integer encoding (shortest form)
- Strings as UTF-8
- `null` encoded as CBOR null (0xf6)
- No CBOR tags (to keep elements interoperable)

The implementation uses a minimal hand-written CBOR encoder (approximately 200 lines) rather than pulling in a full CBOR library. The SDK already avoids large optional dependencies, and the subset needed (maps, arrays, strings, integers, bytes, null) is straightforward.

### 3.3 Reference Resolution

During reassembly, child references are resolved lazily through the pool:

```typescript
/**
 * Resolve a content hash to its element, applying instance selection.
 * Throws UxfError if the element is missing from the pool.
 */
function resolveElement(
  pool: ElementPool,
  hash: ContentHash,
  instanceChains: InstanceChainIndex,
  strategy: InstanceSelectionStrategy,
): UxfElement {
  // 1. Check if this hash participates in an instance chain
  const chainEntry = instanceChains.get(hash);
  if (chainEntry) {
    // 2. Select the appropriate instance per strategy
    const selectedHash = selectInstance(chainEntry, strategy, pool);
    const element = pool.get(selectedHash);
    if (!element) throw new UxfError('MISSING_ELEMENT', `Element ${selectedHash} not in pool`);
    return element;
  }
  // 3. No chain -- resolve directly
  const element = pool.get(hash);
  if (!element) throw new UxfError('MISSING_ELEMENT', `Element ${hash} not in pool`);
  return element;
}
```

### 3.4 Garbage Collection

When a token is removed from the manifest, its elements may become unreferenced (orphaned). Garbage collection is explicit, not automatic, to avoid surprising side effects during incremental operations.

```typescript
/**
 * Remove all elements that are not reachable from any token root in the manifest.
 * Returns the set of removed hashes.
 */
export function collectGarbage(pkg: UxfPackageData): Set<ContentHash> {
  // 1. Build reachable set by walking from every manifest root
  const reachable = new Set<ContentHash>();
  for (const rootHash of pkg.manifest.tokens.values()) {
    walkReachable(pkg.pool, rootHash, pkg.instanceChains, reachable);
  }
  // 2. Delete unreachable elements
  const removed = new Set<ContentHash>();
  for (const hash of pkg.pool.hashes()) {
    if (!reachable.has(hash)) {
      pkg.pool.delete(hash);
      removed.add(hash);
    }
  }
  // 3. Prune instance chain index entries for removed hashes
  pruneInstanceChains(pkg.instanceChains, removed);
  return removed;
}
```

The `walkReachable` function traverses the DAG depth-first, following both direct children and all instance chain entries for each encountered element.

---

## 4. Deconstruction Algorithm

Deconstruction converts a self-contained `TxfToken` into DAG elements and ingests them into the pool. It lives in `/home/vrogojin/uxf/uxf/deconstruct.ts`.

### 4.1 Decomposition Tree

The mapping from TxfToken fields to UxfElement types:

```
TxfToken
├── tokenId, version                      -> token-root (content)
│
├── genesis                               -> genesis
│   ├── genesis.data                      -> genesis-data (leaf)
│   ├── genesis.inclusionProof            -> inclusion-proof
│   │   ├── .authenticator                -> authenticator (leaf)
│   │   ├── .merkleTreePath               -> merkle-tree-path
│   │   │   └── .steps[]                  -> merkle-step[] (each a leaf)
│   │   ├── .unicityCertificate           -> unicity-certificate (leaf, opaque blob)
│   │   └── .transactionHash              -> inline in inclusion-proof content
│   └── (destination state inferred)      -> destination-state (leaf)
│
├── transactions[]                        -> transaction[]
│   ├── .previousStateHash, .newStateHash -> inline in transaction content
│   ├── .predicate                        -> predicate (leaf)
│   ├── .inclusionProof                   -> inclusion-proof (same subtree as genesis)
│   └── .data                             -> transaction-data (leaf, if present)
│
├── state                                 -> token-state (leaf)
│
└── nametags[]                            -> nametag-ref[] (each wraps a recursive token-root)
```

### 4.2 Granularity Rationale

The decomposition granularity is chosen to maximize deduplication at the points where sharing actually occurs in practice:

| Element | Why separate | Dedup opportunity |
|---------|-------------|-------------------|
| `unicity-certificate` | Largest single element (~500-2000 bytes). All tokens in the same aggregator round share it. | Very high: N tokens/round share 1 certificate. |
| `authenticator` | Same signer signs multiple tokens per round. | Moderate: shared across tokens with same signing key in same state. |
| `merkle-step` | Upper SMT path segments are shared across tokens in the same round. | High: SMT structure means upper steps are identical. |
| `predicate` | Tokens owned by the same user share predicate structure. | Moderate. |
| `genesis-data` | Immutable, unique per token. | Low (unique per token), but referential integrity matters. |
| `token-state` | Small, often unique. | Low, but needed as a separate addressable unit. |

Elements that stay **inline** (not separated): scalar fields like `previousStateHash`, `newStateHash`, `transactionHash`, `algorithm`. These are small strings with no meaningful dedup opportunity across tokens.

### 4.3 Deconstruction Implementation

```typescript
/**
 * Deconstruct a TxfToken into elements and ingest into the package.
 * Returns the content hash of the token-root element.
 * 
 * Deduplication is automatic: if an element with the same content hash
 * already exists in the pool, it is not re-added.
 */
export function deconstructToken(
  pool: ElementPool,
  token: TxfToken,
): ContentHash {
  const tokenId = token.genesis.data.tokenId;

  // 1. Deconstruct genesis
  const genesisHash = deconstructGenesis(pool, token.genesis);

  // 2. Deconstruct transactions (ordered)
  const txHashes: ContentHash[] = [];
  for (const tx of token.transactions) {
    txHashes.push(deconstructTransaction(pool, tx));
  }

  // 3. Deconstruct current state
  const stateHash = deconstructState(pool, token.state, 'token-state');

  // 4. Deconstruct nametags (recursive -- each is a full token)
  const nametagHashes: ContentHash[] = [];
  if (token.nametags) {
    for (const nametagName of token.nametags) {
      // Nametag tokens in TxfToken are stored as string names, not full tokens.
      // Full nametag token DAGs are ingested separately via ingestNametagToken().
      // Here we create a nametag-ref placeholder pointing to a name.
      // If the nametag token's root hash is known, it's linked during a separate pass.
      nametagHashes.push(deconstructNametagRef(pool, nametagName));
    }
  }

  // 5. Build token-root element
  const root: UxfElement = {
    header: makeHeader(),
    type: 'token-root',
    content: { tokenId, version: token.version || '2.0' },
    children: {
      genesis: genesisHash,
      transactions: txHashes,
      state: stateHash,
      nametags: nametagHashes,
    },
  };

  return pool.put(root);
}

function deconstructGenesis(pool: ElementPool, genesis: TxfGenesis): ContentHash {
  const dataHash = pool.put({
    header: makeHeader(),
    type: 'genesis-data',
    content: {
      tokenId: genesis.data.tokenId,
      tokenType: genesis.data.tokenType,
      coinData: genesis.data.coinData,
      tokenData: genesis.data.tokenData,
      salt: genesis.data.salt,
      recipient: genesis.data.recipient,
      recipientDataHash: genesis.data.recipientDataHash,
      reason: genesis.data.reason,
    },
    children: {},
  });

  const proofHash = deconstructInclusionProof(pool, genesis.inclusionProof);

  // Destination state is derived from genesis context (the genesis proof's
  // authenticator stateHash defines the post-genesis state).
  // We store it as a destination-state element if the genesis has relevant data.
  const destStateHash = pool.put({
    header: makeHeader(),
    type: 'destination-state',
    content: {
      data: '',
      predicate: '',
    },
    children: {},
  });

  return pool.put({
    header: makeHeader(),
    type: 'genesis',
    content: {},
    children: {
      data: dataHash,
      inclusionProof: proofHash,
      destinationState: destStateHash,
    },
  });
}

function deconstructInclusionProof(
  pool: ElementPool,
  proof: TxfInclusionProof,
): ContentHash {
  // Authenticator -- leaf
  const authHash = pool.put({
    header: makeHeader(),
    type: 'authenticator',
    content: {
      algorithm: proof.authenticator.algorithm,
      publicKey: proof.authenticator.publicKey,
      signature: proof.authenticator.signature,
      stateHash: proof.authenticator.stateHash,
    },
    children: {},
  });

  // Merkle steps -- each is a leaf
  const stepHashes: ContentHash[] = proof.merkleTreePath.steps.map(step =>
    pool.put({
      header: makeHeader(),
      type: 'merkle-step',
      content: { data: step.data, path: step.path },
      children: {},
    })
  );

  // Merkle tree path -- references steps
  const pathHash = pool.put({
    header: makeHeader(),
    type: 'merkle-tree-path',
    content: { root: proof.merkleTreePath.root },
    children: { steps: stepHashes },
  });

  // Unicity certificate -- opaque blob, leaf
  const certHash = pool.put({
    header: makeHeader(),
    type: 'unicity-certificate',
    content: { raw: proof.unicityCertificate },
    children: {},
  });

  return pool.put({
    header: makeHeader(),
    type: 'inclusion-proof',
    content: { transactionHash: proof.transactionHash },
    children: {
      authenticator: authHash,
      merkleTreePath: pathHash,
      unicityCertificate: certHash,
    },
  });
}

function deconstructTransaction(pool: ElementPool, tx: TxfTransaction): ContentHash {
  const predicateHash = pool.put({
    header: makeHeader(),
    type: 'predicate',
    content: { raw: tx.predicate },
    children: {},
  });

  let proofHash: ContentHash | null = null;
  if (tx.inclusionProof) {
    proofHash = deconstructInclusionProof(pool, tx.inclusionProof);
  }

  let dataHash: ContentHash | undefined;
  if (tx.data && Object.keys(tx.data).length > 0) {
    dataHash = pool.put({
      header: makeHeader(),
      type: 'transaction-data',
      content: { fields: tx.data },
      children: {},
    });
  }

  const children: Record<string, ContentHash | ContentHash[] | null> = {
    predicate: predicateHash,
    inclusionProof: proofHash,
  };
  if (dataHash) children.data = dataHash;

  return pool.put({
    header: makeHeader(),
    type: 'transaction',
    content: {
      previousStateHash: tx.previousStateHash,
      newStateHash: tx.newStateHash,
    },
    children: children as Record<string, ContentHash | ContentHash[]>,
  });
}

function deconstructState(
  pool: ElementPool,
  state: TxfState,
  type: 'token-state' | 'destination-state',
): ContentHash {
  return pool.put({
    header: makeHeader(),
    type,
    content: { data: state.data, predicate: state.predicate },
    children: {},
  });
}

function deconstructNametagRef(pool: ElementPool, name: string): ContentHash {
  return pool.put({
    header: makeHeader(),
    type: 'nametag-ref',
    content: { name },
    children: {},  // tokenRoot linked separately when nametag token is ingested
  });
}

function makeHeader(overrides?: Partial<UxfElementHeader>): UxfElementHeader {
  return {
    representation: 1,
    semantics: 1,
    kind: 'default',
    predecessor: null,
    ...overrides,
  };
}
```

### 4.4 Deduplication During Ingestion

Deduplication is automatic because `ElementPool.put()` computes the content hash before insertion and skips the write if the hash already exists. This means:

1. Ingesting the same token twice adds zero new elements.
2. Ingesting two tokens that share a unicity certificate adds the certificate once.
3. Ingesting two tokens with the same nametag creates one nametag-ref element and (if the full nametag token is ingested) one shared nametag token sub-DAG.

---

## 5. Reassembly Algorithm

Reassembly converts DAG elements back into a self-contained `TxfToken`. It lives in `/home/vrogojin/uxf/uxf/assemble.ts`.

### 5.1 Latest State Reassembly

```typescript
/**
 * Reassemble a token at its latest state from the element pool.
 * 
 * @param pool - The element pool
 * @param manifest - Token manifest
 * @param tokenId - Token to reassemble
 * @param instanceChains - Instance chain index
 * @param strategy - Instance selection strategy (default: latest)
 * @returns Complete TxfToken, indistinguishable from the original
 */
export function assembleToken(
  pool: ElementPool,
  manifest: UxfManifest,
  tokenId: string,
  instanceChains: InstanceChainIndex,
  strategy: InstanceSelectionStrategy = STRATEGY_LATEST,
): TxfToken {
  const rootHash = manifest.tokens.get(tokenId);
  if (!rootHash) throw new UxfError('TOKEN_NOT_FOUND', `Token ${tokenId} not in manifest`);

  const root = resolveElement(pool, rootHash, instanceChains, strategy);
  assertType(root, 'token-root');

  const genesisElement = resolveElement(pool, root.children.genesis as ContentHash, instanceChains, strategy);
  const genesis = assembleGenesis(pool, genesisElement, instanceChains, strategy);

  const txHashes = root.children.transactions as ContentHash[];
  const transactions: TxfTransaction[] = txHashes.map(hash => {
    const txElement = resolveElement(pool, hash, instanceChains, strategy);
    return assembleTransaction(pool, txElement, instanceChains, strategy);
  });

  const stateElement = resolveElement(pool, root.children.state as ContentHash, instanceChains, strategy);
  const state: TxfState = {
    data: stateElement.content.data as string,
    predicate: stateElement.content.predicate as string,
  };

  const nametagHashes = root.children.nametags as ContentHash[] || [];
  const nametags: string[] = nametagHashes.map(hash => {
    const ref = resolveElement(pool, hash, instanceChains, strategy);
    return ref.content.name as string;
  });

  return {
    version: (root.content.version as string) || '2.0',
    genesis,
    state,
    transactions,
    nametags: nametags.length > 0 ? nametags : undefined,
  };
}
```

### 5.2 Historical State Assembly

```typescript
/**
 * Reassemble a token at a specific historical state.
 * stateIndex = 0 means genesis only (no transactions).
 * stateIndex = N means genesis + first N transactions.
 */
export function assembleTokenAtState(
  pool: ElementPool,
  manifest: UxfManifest,
  tokenId: string,
  stateIndex: number,
  instanceChains: InstanceChainIndex,
  strategy: InstanceSelectionStrategy = STRATEGY_LATEST,
): TxfToken {
  const rootHash = manifest.tokens.get(tokenId);
  if (!rootHash) throw new UxfError('TOKEN_NOT_FOUND', `Token ${tokenId} not in manifest`);

  const root = resolveElement(pool, rootHash, instanceChains, strategy);
  assertType(root, 'token-root');

  const genesis = assembleGenesis(
    pool,
    resolveElement(pool, root.children.genesis as ContentHash, instanceChains, strategy),
    instanceChains,
    strategy,
  );

  const allTxHashes = root.children.transactions as ContentHash[];
  if (stateIndex > allTxHashes.length) {
    throw new UxfError('STATE_INDEX_OUT_OF_RANGE',
      `Token ${tokenId} has ${allTxHashes.length} transactions, requested state ${stateIndex}`);
  }

  const truncatedHashes = allTxHashes.slice(0, stateIndex);
  const transactions = truncatedHashes.map(hash =>
    assembleTransaction(pool, resolveElement(pool, hash, instanceChains, strategy), instanceChains, strategy)
  );

  // State at stateIndex: if stateIndex == 0, use genesis destination state.
  // Otherwise, use the Nth transaction's destination state (derived from authenticator stateHash).
  let state: TxfState;
  if (stateIndex === 0) {
    const destState = resolveElement(
      pool,
      (resolveElement(pool, root.children.genesis as ContentHash, instanceChains, strategy)
        .children.destinationState) as ContentHash,
      instanceChains, strategy,
    );
    state = { data: destState.content.data as string, predicate: destState.content.predicate as string };
  } else {
    const lastTx = transactions[transactions.length - 1];
    state = {
      data: '',
      predicate: lastTx.predicate,
    };
  }

  return {
    version: (root.content.version as string) || '2.0',
    genesis,
    state,
    transactions,
    nametags: [],
  };
}
```

### 5.3 Validation During Reassembly

Reassembly performs structural validation:

1. Every referenced hash must exist in the pool (or an `MISSING_ELEMENT` error is thrown).
2. Element types must match expected positions (genesis child must be a `genesis` element, etc.).
3. Transaction ordering is preserved (array index in `token-root.children.transactions`).
4. No cryptographic validation during reassembly -- that is the responsibility of `verify()`.

---

## 6. Serialization Layer

### 6.1 Deterministic CBOR Encoding

```typescript
// uxf/cbor.ts

/**
 * Encode a JavaScript value to deterministic CBOR bytes.
 * Follows dag-cbor conventions:
 * - Map keys sorted by byte order
 * - Shortest integer encoding
 * - No indefinite-length
 * - No tags
 * - UTF-8 strings
 * - null -> CBOR null (0xf6)
 * - undefined values omitted from maps
 */
export function encodeDeterministicCbor(value: unknown): Uint8Array { ... }

/**
 * Decode CBOR bytes to a JavaScript value.
 */
export function decodeCbor(bytes: Uint8Array): unknown { ... }
```

The encoder handles: `null`, `boolean`, `number` (integer only -- no floats in element data), `string`, `Uint8Array` (as CBOR bytes), `Array`, and `object` (as CBOR map with sorted keys).

### 6.2 JSON Encoding

For debugging and human-readable interchange, every UXF structure has a JSON representation:

```typescript
// uxf/index.ts (public API)

/**
 * Serialize a UxfPackage to JSON.
 * Element pool is serialized as a map of hash -> JSON element.
 * Manifest, indexes, and instance chains are included.
 */
export function packageToJson(pkg: UxfPackageData): string { ... }

/**
 * Deserialize a UxfPackage from JSON.
 */
export function packageFromJson(json: string): UxfPackageData { ... }
```

JSON format for a single element:

```json
{
  "header": { "representation": 1, "semantics": 1, "kind": "default", "predecessor": null },
  "type": "unicity-certificate",
  "content": { "raw": "a36269640001..." },
  "children": {}
}
```

JSON format for the package:

```json
{
  "envelope": { "version": 1, "createdAt": 1711929600000, "updatedAt": 1711929600000 },
  "manifest": { "tokens": { "<tokenId>": "<rootHash>", ... } },
  "pool": { "<hash>": { "header": ..., "type": ..., "content": ..., "children": ... }, ... },
  "instanceChains": { "<hash>": { "head": "<hash>", "chain": [...] }, ... },
  "indexes": { "byTokenType": {}, "byCoinId": {}, "byStateHash": {} }
}
```

### 6.3 CAR File Export

CAR (Content ARchive) files are the standard IPFS bundle format. Each element maps to one IPLD block.

```typescript
// uxf/ipld.ts

import { sha256 } from '@noble/hashes/sha256';

/**
 * CID version 1, dag-cbor codec (0x71), sha2-256 hash (0x12).
 */
export interface CidV1 {
  readonly version: 1;
  readonly codec: 0x71;     // dag-cbor
  readonly hash: Uint8Array; // multihash: [0x12, 0x20, ...32 bytes...]
  readonly bytes: Uint8Array; // full CID bytes
}

/**
 * Compute the CIDv1 for an element.
 */
export function computeCid(element: UxfElement): CidV1 { ... }

/**
 * Map a UXF element to an IPLD block.
 * The block data is the dag-cbor encoding of:
 *   { header, type, content, children }
 * where children contain CID links (not raw hex hashes).
 */
export function elementToIpldBlock(element: UxfElement): { cid: CidV1; data: Uint8Array } { ... }

/**
 * Export the entire package as a CARv1 byte stream.
 * Roots: the manifest root CIDs (one per token).
 * Blocks: all elements in the pool.
 */
export function exportToCar(pkg: UxfPackageData): Uint8Array { ... }

/**
 * Import elements from a CARv1 byte stream into a package.
 */
export function importFromCar(car: Uint8Array, pkg: UxfPackageData): void { ... }
```

### 6.4 IPLD Mapping

Each `UxfElement` maps to one IPLD block:

| UXF concept | IPLD representation |
|------------|-------------------|
| `ContentHash` | CIDv1 (dag-cbor, sha2-256) |
| `UxfElement` | IPLD block, data = dag-cbor encoded `{ header, type, content, children }` |
| `children` hash references | CID links in the CBOR map |
| `UxfManifest` | IPLD block: `{ tokens: { tokenId: CID, ... } }` |
| `UxfEnvelope` | IPLD block: `{ version, createdAt, updatedAt, manifest: CID }` |

The envelope CID is the package root, suitable for IPNS publishing. When the manifest changes (tokens added/removed), the envelope CID changes, but shared element blocks retain their CIDs.

---

## 7. Storage Abstraction

### 7.1 Design Decision: UXF Wraps, Does Not Replace, TXF Storage

UXF is a **packaging layer** on top of the existing token storage. It does not replace `TokenStorageProvider` or `TxfStorageData`. Instead:

- `UxfPackage` can be populated from `TxfStorageData` by iterating its tokens and calling `ingest()` for each.
- `UxfPackage` can export back to `TxfStorageData` by calling `assemble()` for each token in the manifest.
- For direct UXF persistence, a new `UxfStorageAdapter` interface is provided.

This keeps UXF decoupled from wallet lifecycle and allows incremental adoption.

### 7.2 UXF Storage Adapter Interface

```typescript
// uxf/types.ts

/**
 * Abstract storage adapter for persisting UXF packages.
 * Platform implementations live in impl/browser/ and impl/nodejs/.
 */
export interface UxfStorageAdapter {
  /**
   * Save the full package state.
   * The implementation may serialize as JSON, CBOR, or any internal format.
   */
  save(pkg: UxfPackageData): Promise<void>;

  /**
   * Load a previously saved package, or null if none exists.
   */
  load(): Promise<UxfPackageData | null>;

  /**
   * Delete the stored package.
   */
  clear(): Promise<void>;
}
```

### 7.3 Platform Implementations

**In-memory (testing/ephemeral):**
```typescript
export class InMemoryUxfStorage implements UxfStorageAdapter {
  private data: UxfPackageData | null = null;
  async save(pkg: UxfPackageData) { this.data = pkg; }
  async load() { return this.data; }
  async clear() { this.data = null; }
}
```

**Browser (IndexedDB):**
A new IndexedDB database `sphere-uxf-storage` with a single object store `package`. Elements are stored as individual records keyed by content hash for efficient incremental updates. The manifest and envelope are stored under reserved keys.

**Node.js (File-based):**
A directory containing:
- `envelope.json` -- package envelope
- `manifest.json` -- token manifest
- `elements/` -- one file per element, named `{hash}.cbor`
- `instance-chains.json` -- instance chain index

### 7.4 Integration with Existing StorageProvider

The `UxfStorageAdapter` can optionally delegate to the existing `StorageProvider` KV interface by serializing the package to JSON and storing it under a well-known key. This avoids creating new platform-specific storage implementations for simple use cases:

```typescript
/**
 * Adapter that stores UXF package data via the existing StorageProvider KV interface.
 */
export class KvUxfStorageAdapter implements UxfStorageAdapter {
  constructor(
    private readonly storage: StorageProvider,
    private readonly key: string = 'uxf_package',
  ) {}

  async save(pkg: UxfPackageData): Promise<void> {
    await this.storage.set(this.key, packageToJson(pkg));
  }

  async load(): Promise<UxfPackageData | null> {
    const json = await this.storage.get(this.key);
    return json ? packageFromJson(json) : null;
  }

  async clear(): Promise<void> {
    await this.storage.remove(this.key);
  }
}
```

---

## 8. Public API Surface

All public APIs are exported from `/home/vrogojin/uxf/uxf/index.ts`.

### 8.1 UxfPackage Class

```typescript
/**
 * The primary public interface for UXF operations.
 * Wraps UxfPackageData with a fluent, mutation-friendly API.
 */
export class UxfPackage {
  private data: UxfPackageData;

  /** Create a new empty package */
  static create(options?: { description?: string; creator?: string }): UxfPackage;

  /** Load from storage adapter */
  static async open(storage: UxfStorageAdapter): Promise<UxfPackage>;

  /** Deserialize from JSON */
  static fromJson(json: string): UxfPackage;

  /** Deserialize from CAR bytes */
  static fromCar(car: Uint8Array): UxfPackage;

  // ---------- Ingestion ----------

  /**
   * Deconstruct a TxfToken and add to the package.
   * If the token already exists, its manifest entry is updated to the new root.
   */
  ingest(token: TxfToken): void;

  /**
   * Batch ingest multiple tokens.
   */
  ingestAll(tokens: TxfToken[]): void;

  /**
   * Ingest a full nametag token (as TxfToken) and link it to existing nametag-ref elements.
   */
  ingestNametagToken(name: string, token: TxfToken): void;

  // ---------- Reassembly ----------

  /**
   * Reassemble a token at its latest state.
   * @returns Self-contained TxfToken identical to the original.
   */
  assemble(tokenId: string, strategy?: InstanceSelectionStrategy): TxfToken;

  /**
   * Reassemble at a specific historical state.
   * stateIndex=0 -> genesis only. stateIndex=N -> genesis + first N transactions.
   */
  assembleAtState(tokenId: string, stateIndex: number, strategy?: InstanceSelectionStrategy): TxfToken;

  /**
   * Assemble all tokens in the manifest.
   */
  assembleAll(strategy?: InstanceSelectionStrategy): Map<string, TxfToken>;

  // ---------- Token Management ----------

  /**
   * Remove a token from the manifest.
   * Elements are NOT garbage-collected automatically -- call gc() explicitly.
   */
  removeToken(tokenId: string): this;

  /**
   * List all token IDs in the manifest.
   */
  tokenIds(): string[];

  /**
   * Check if a token exists in the manifest.
   */
  hasToken(tokenId: string): boolean;

  /**
   * Get the number of transactions for a token.
   */
  transactionCount(tokenId: string): number;

  // ---------- Instance Chains ----------

  /**
   * Append a new instance to an element's instance chain.
   * The new instance's header.predecessor must equal the current head's hash.
   */
  addInstance(originalHash: ContentHash, newInstance: UxfElement): void;

  /**
   * Consolidate a range of inclusion proofs for a token into a single
   * consolidated SMT subtree instance.
   * txRange is [startInclusive, endExclusive] indexing into the token's transactions array.
   */
  consolidateProofs(tokenId: string, txRange: [number, number]): void;

  // ---------- Package Operations ----------

  /**
   * Merge another package into this one.
   * Elements are deduplicated by content hash.
   * Manifest entries from the other package are added (or overwritten if tokenId collides).
   */
  merge(other: UxfPackage): this;

  /**
   * Compute the minimal delta between this package and another.
   */
  diff(other: UxfPackage): UxfDelta;

  /**
   * Apply a delta to this package.
   */
  applyDelta(delta: UxfDelta): this;

  /**
   * Garbage-collect unreachable elements.
   * Returns the number of elements removed.
   */
  gc(): number;

  // ---------- Verification ----------

  /**
   * Verify structural integrity of the package.
   * Checks: all manifest roots exist, all child references resolve,
   * content hashes match, instance chains are valid.
   */
  verify(): UxfVerificationResult;

  // ---------- Queries ----------

  /**
   * Filter tokens by predicate.
   */
  filterTokens(predicate: (tokenId: string, rootElement: UxfElement) => boolean): string[];

  /**
   * Get tokens by coin ID (uses index).
   */
  tokensByCoinId(coinId: string): string[];

  /**
   * Get tokens by token type (uses index).
   */
  tokensByTokenType(tokenType: string): string[];

  // ---------- Serialization ----------

  /** Serialize to JSON string */
  toJson(): string;

  /** Export as CARv1 bytes */
  toCar(): Uint8Array;

  /** Save to storage adapter */
  async save(storage: UxfStorageAdapter): Promise<void>;

  // ---------- Statistics ----------

  /** Number of tokens in manifest */
  get tokenCount(): number;

  /** Number of elements in pool */
  get elementCount(): number;

  /** Estimated byte size (sum of all element CBOR encodings) */
  get estimatedSize(): number;

  /** Get the underlying data (read-only) */
  get packageData(): Readonly<UxfPackageData>;
}
```

### 8.2 Free Functions (Functional API)

For consumers who prefer a functional style or need to operate on raw `UxfPackageData`:

```typescript
// All functions are pure (take data, return data) except where noted.

export function ingest(pkg: UxfPackageData, token: TxfToken): void;
export function ingestAll(pkg: UxfPackageData, tokens: TxfToken[]): void;
export function assemble(pkg: UxfPackageData, tokenId: string, strategy?: InstanceSelectionStrategy): TxfToken;
export function assembleAtState(pkg: UxfPackageData, tokenId: string, stateIndex: number, strategy?: InstanceSelectionStrategy): TxfToken;
export function removeToken(pkg: UxfPackageData, tokenId: string): void;
export function merge(target: UxfPackageData, source: UxfPackageData): void;
export function diff(a: UxfPackageData, b: UxfPackageData): UxfDelta;
export function applyDelta(pkg: UxfPackageData, delta: UxfDelta): void;
export function verify(pkg: UxfPackageData): UxfVerificationResult;
export function addInstance(pkg: UxfPackageData, originalHash: ContentHash, newInstance: UxfElement): void;
export function consolidateProofs(pkg: UxfPackageData, tokenId: string, txRange: [number, number]): void;
export function collectGarbage(pkg: UxfPackageData): number;
```

### 8.3 Error Types

```typescript
// uxf/errors.ts

export type UxfErrorCode =
  | 'INVALID_HASH'
  | 'MISSING_ELEMENT'
  | 'TOKEN_NOT_FOUND'
  | 'STATE_INDEX_OUT_OF_RANGE'
  | 'TYPE_MISMATCH'
  | 'INVALID_INSTANCE_CHAIN'
  | 'DUPLICATE_TOKEN'
  | 'SERIALIZATION_ERROR'
  | 'VERIFICATION_FAILED'
  | 'INVALID_PACKAGE';

export class UxfError extends Error {
  constructor(
    readonly code: UxfErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(`[UXF:${code}] ${message}`);
    this.name = 'UxfError';
  }
}
```

### 8.4 Verification Result

```typescript
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

export interface UxfVerificationIssue {
  readonly code: string;
  readonly message: string;
  readonly tokenId?: string;
  readonly elementHash?: ContentHash;
}
```

### 8.5 Delta Type

```typescript
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
```

### 8.6 Barrel Exports

```typescript
// uxf/index.ts

// Types
export type {
  ContentHash,
  UxfElementHeader,
  UxfElementType,
  UxfInstanceKind,
  UxfElement,
  UxfElementContent,
  UxfManifest,
  UxfEnvelope,
  UxfIndexes,
  UxfPackageData,
  InstanceChainEntry,
  InstanceChainIndex,
  InstanceSelectionStrategy,
  UxfStorageAdapter,
  UxfVerificationResult,
  UxfVerificationIssue,
  UxfDelta,
  UxfErrorCode,
  // Typed content interfaces (for consumers who need specific element shapes)
  TokenRootContent,
  GenesisDataContent,
  AuthenticatorContent,
  UnicityCertificateContent,
  MerkleStepContent,
  PredicateContent,
  StateContent,
} from './types';

// Constants
export { STRATEGY_LATEST, STRATEGY_ORIGINAL, contentHash } from './types';

// Classes
export { UxfPackage } from './UxfPackage';
export { ElementPool } from './element-pool';
export { UxfError } from './errors';

// Functions (functional API)
export {
  ingest,
  ingestAll,
  assemble,
  assembleAtState,
  removeToken,
  merge,
  diff,
  applyDelta,
  verify,
  addInstance,
  consolidateProofs,
  collectGarbage,
} from './UxfPackage';  // re-exported from the module that implements them

// Serialization
export { packageToJson, packageFromJson } from './UxfPackage';
export { exportToCar, importFromCar, computeCid, elementToIpldBlock } from './ipld';
export { encodeDeterministicCbor, decodeCbor } from './cbor';
export { computeElementHash } from './hash';

// Storage adapters
export { InMemoryUxfStorage } from './storage-adapters';
export { KvUxfStorageAdapter } from './storage-adapters';

// Deconstruction (for advanced use)
export { deconstructToken } from './deconstruct';
export { assembleToken, assembleTokenAtState } from './assemble';
```

### 8.7 Main SDK Re-Exports

Addition to `/home/vrogojin/uxf/index.ts`:

```typescript
// =============================================================================
// UXF (Universal eXchange Format)
// =============================================================================

export {
  UxfPackage,
  ElementPool,
  UxfError,
  STRATEGY_LATEST,
  STRATEGY_ORIGINAL,
  contentHash,
  computeElementHash,
  encodeDeterministicCbor,
  decodeCbor,
  packageToJson,
  packageFromJson,
  exportToCar,
  importFromCar,
  InMemoryUxfStorage,
  KvUxfStorageAdapter,
} from './uxf';

export type {
  ContentHash,
  UxfElementHeader,
  UxfElementType,
  UxfInstanceKind,
  UxfElement,
  UxfManifest,
  UxfEnvelope,
  UxfPackageData,
  InstanceSelectionStrategy,
  UxfStorageAdapter,
  UxfVerificationResult,
  UxfDelta,
  UxfErrorCode,
} from './uxf';
```

---

## Summary of Key Architectural Decisions

1. **Separate top-level directory** (`uxf/`) rather than under `modules/` -- UXF is a data format/packaging concern, not a wallet-lifecycle module. It has zero runtime dependencies on `Sphere`, `PaymentsModule`, or transport.

2. **Platform-neutral** -- the core UXF module has no platform-specific code. Storage adapters are injected. The CBOR encoder is hand-written (minimal subset) to avoid new dependencies.

3. **Content hash = SHA-256 over deterministic CBOR** -- this aligns with IPLD's dag-cbor codec and produces CIDv1-compatible addresses. The same hash serves as both the pool key and the IPLD CID digest.

4. **Elements reference children by hash, never inline** -- this is the fundamental property that enables structural sharing. A unicity certificate buried inside token A's inclusion proof is the same pool entry referenced by token B's inclusion proof.

5. **Instance chains as singly-linked lists** -- new instances prepend to the chain and reference the previous head as predecessor. The instance chain index provides O(1) lookup from any hash to the chain head. All instances are retained (append-only pool).

6. **Explicit garbage collection** -- removing a token from the manifest does not automatically delete its elements (they may be shared). The consumer calls `gc()` when ready. This avoids reference counting overhead and surprise data loss.

7. **Wraps TXF, does not replace it** -- UXF ingests `TxfToken` objects and reassembles them back. The existing `TxfStorageData` format remains the wallet's primary persistence format. UXF is an opt-in layer for deduplication, IPFS export, and multi-token packaging.

8. **No new npm dependencies** -- the CBOR encoder is hand-written. SHA-256 comes from `@noble/hashes` (already bundled). CAR file encoding is implemented inline (the format is straightforward: varint-length-prefixed blocks). This keeps the dependency tree unchanged.