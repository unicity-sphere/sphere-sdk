# IPLD, CAR Files, and Content-Addressable Packaging: State of the Art (2024-2025)

## 1. IPLD Data Model and Codecs

### Core Data Model

IPLD (InterPlanetary Linked Data) represents data as a DAG (Directed Acyclic Graph) of **blocks**. Each block is a tuple of `(CID, bytes)` where the CID is derived from the block's content. The IPLD Data Model defines these kinds: Null, Boolean, Integer, Float, String, Bytes, List, Map, and **Link** (a CID reference to another block).

Links are the key primitive: a CID embedded in one block's data that references another block, forming edges in the DAG.

### Available Codecs

| Codec | Code | Format | Full Data Model | Best For |
|-------|------|--------|----------------|----------|
| **dag-cbor** | `0x71` | Binary (CBOR) | Yes | Structured data with links, binary payloads |
| **dag-json** | `0x0129` | JSON text | Yes | Human-readable debugging, APIs |
| **dag-pb** | `0x70` | Protobuf | Partial | UnixFS file chunking (legacy IPFS) |
| **raw** | `0x55` | Raw bytes | N/A | Opaque blobs, leaf data |

### Recommendation for UXF

**dag-cbor** is the clear choice for the UXF use case. Reasons:

1. **Full Data Model support** -- supports all IPLD kinds including native CID links (encoded as CBOR Tag 42).
2. **Deterministic serialization** -- DAG-CBOR mandates canonical encoding (sorted map keys, no indefinite-length items, smallest integer encoding), which is essential for content-addressability.
3. **Efficient binary encoding** -- unlike dag-json, bytes are encoded natively (not base64-inflated). Token proofs, signatures, and hashes are predominantly binary data.
4. **Widely supported** -- it is the codec used by Filecoin for its entire chain state, by Ceramic Network for document streams, and by NFT.Storage for metadata bundles.

dag-json is useful as a secondary codec for debugging and human inspection but should not be the primary storage format due to ~33% inflation on binary data from base64 encoding.

### CID Versions

**CIDv1** is recommended for all new projects. Structure:

```
<multibase><version=1><multicodec><multihash>
```

- **CIDv0**: Legacy, fixed to `dag-pb` + `sha2-256`, base58btc encoding. 34 bytes binary. Cannot represent dag-cbor content.
- **CIDv1**: Self-describing. Supports any codec + any hash. For dag-cbor + sha2-256, binary size is approximately 36 bytes (1 byte version + 1-2 bytes codec varint + 2 bytes multihash header + 32 bytes sha256 digest).

**Multihash choice**: `sha2-256` is the standard default and recommended unless there is a specific reason to use alternatives like `blake2b-256` (slightly faster but less universal tooling support).

### Deterministic Serialization in dag-cbor

DAG-CBOR enforces strict canonical encoding per the spec:

- **Map keys**: Must be strings only. Sorted by byte-wise comparison of their CBOR encoding (length-first, then lexicographic).
- **Integer encoding**: Smallest possible encoding. Positive integers use major type 0, negative use major type 1.
- **Float encoding**: IEEE 754 NaN, Infinity, -Infinity are forbidden. Floats that can be represented as integers must be encoded as integers.
- **No indefinite-length**: All strings, bytes, lists, and maps must use definite-length encoding.
- **Links**: CIDs are encoded as CBOR byte strings with Tag 42, using the raw-binary CID form with a `0x00` multibase prefix byte.

**JavaScript pitfalls**:
- All JS `Number` values are 64-bit IEEE 754 floats internally. Integers outside the safe range (`Number.MAX_SAFE_INTEGER` = 2^53-1) lose precision. The `@ipld/dag-cbor` library handles this by using `BigInt` for integers outside the safe range on decode and accepting `BigInt` on encode.
- `Uint8Array` is the canonical bytes type. TypedArrays round-trip as `Uint8Array` (type information is lost).
- JavaScript `Map` key ordering is insertion-order, but dag-cbor sorts keys by CBOR byte order regardless of insertion order, so determinism is preserved.

## 2. IPLD Schema and Advanced Data Structures

### IPLD Schema Language

IPLD Schemas define typed data structures over the IPLD Data Model. They provide:

- **Structural types**: `struct`, `union`, `enum`, `list`, `map`, `link`
- **Representations**: How types map to the Data Model (e.g., `struct` can be represented as a `map` or `tuple`)
- **Typed links**: `&TargetType` syntax to indicate a CID link that should resolve to a specific type
- **Nullable and optional fields**

Example schema for a UXF-like structure:

```ipldsch
type Token struct {
  genesis &Genesis
  transactions [&Transaction]
  state &TokenState
  nametags [&Token]
} representation map

type Genesis struct {
  transactionData &MintTransactionData
  inclusionProof &InclusionProof
  destinationState &TokenState
} representation map
```

### Schema Validation in JavaScript

- **`@ipld/schema`** (actively maintained) -- parser, validator, code generator for IPLD schemas.
- **`ipld-schema-validator`** -- builds runtime validator functions from IPLD schema definitions. Example:

```javascript
import { parse as parseSchema } from 'ipld-schema'
import { create as createValidator } from 'ipld-schema-validator'

const schema = parseSchema(schemaText)
const validate = createValidator(schema, 'Token')
validate(decodedBlock) // returns boolean
```

Note: The `ipld-schema-validator` library has been archived with functionality rolled into `@ipld/schema`.

### Advanced Data Layouts (ADLs)

ADLs are "lenses" that make sharded or transformed data appear as a single logical node:

- **HAMT** (Hash Array Mapped Trie): Provides a map interface over sharded blocks. Deterministic (no hysteresis -- same content always produces same structure regardless of insertion order). Useful for very large element pools.
- **Prolly Trees**: Probabilistic B-trees for ordered indexes. Deterministic chunking based on content hashing. Used by Fireproof database. O(log_k(n)) read/write. Good for sorted indexes (e.g., token manifest sorted by tokenId).

For UXF's element pool, if the pool grows very large (thousands of elements), a HAMT or Prolly Tree could shard the pool across multiple blocks while maintaining a single logical root CID. For moderate sizes (hundreds of elements), a single dag-cbor map block is simpler and sufficient.

## 3. JavaScript/TypeScript Libraries

### Core Libraries

| Package | Version | Purpose |
|---------|---------|---------|
| `multiformats` | **13.4.2** | CID creation, multihash, multicodec, multibase |
| `@ipld/dag-cbor` | **9.2.5** | dag-cbor encode/decode with CID link support |
| `@ipld/dag-json` | **10.2.5** | dag-json encode/decode (human-readable) |
| `@ipld/car` | **5.4.2** | CAR file reading/writing (CARv1 focused) |
| `@ipld/schema` | latest | IPLD schema parsing and validation |
| `helia` | **6.0.14** | Modern IPFS node (ESM + TypeScript, successor to js-ipfs) |
| `cborg` | (dep of dag-cbor) | Low-level CBOR encoder/decoder with strictness |

All packages are ESM-only and TypeScript-native.

### API Examples

**Creating a content-addressed block:**

```typescript
import { encode, decode } from '@ipld/dag-cbor'
import { CID } from 'multiformats'
import { sha256 } from 'multiformats/hashes/sha2'

// Encode a leaf node
const leafData = { type: 'authenticator', pubkey: new Uint8Array([...]), signature: new Uint8Array([...]) }
const leafBytes = encode(leafData)
const leafHash = await sha256.digest(leafBytes)
const leafCid = CID.createV1(0x71, leafHash) // 0x71 = dag-cbor codec

// Encode a parent node with a CID link to the leaf
const parentData = {
  type: 'inclusionProof',
  authenticator: leafCid,  // CID instances are encoded as IPLD links (Tag 42)
  merkleTreePath: [new Uint8Array([...])],
}
const parentBytes = encode(parentData)
const parentHash = await sha256.digest(parentBytes)
const parentCid = CID.createV1(0x71, parentHash)

// Decode
const decoded = decode(parentBytes)
CID.asCID(decoded.authenticator) // returns CID instance
```

**Encoding options for size calculation:**

```typescript
import { encodeOptions } from '@ipld/dag-cbor'
import { encodedLength } from 'cborg/length'
const byteLength = encodedLength(data, encodeOptions)
```

### Helia (Modern IPFS)

Helia is the official successor to js-ipfs, designed as composable and modular:

```typescript
import { createHelia } from 'helia'
import { dagCbor } from '@helia/dag-cbor'

const helia = await createHelia()
const d = dagCbor(helia)
const cid = await d.add({ hello: 'world' })
const obj = await d.get(cid)
```

For UXF, Helia is relevant if the package needs to interact with the live IPFS network (pinning, retrieval). For offline packaging (creating CAR files for later upload), the lower-level `@ipld/dag-cbor` + `@ipld/car` combination is sufficient and has zero network dependencies.

## 4. CAR Files (Content Addressable aRchive)

### Overview

CAR is the transport/archive format for IPLD blocks. A CAR file is essentially exactly what UXF needs: **a bundle of content-addressed blocks with a root pointer**. The mapping is direct:

| UXF Concept | CAR Equivalent |
|-------------|---------------|
| Element Pool | Collection of IPLD blocks in the CAR body |
| Token Manifest root | CAR root CID(s) |
| Element hash | Block CID |
| Child references | CID links within dag-cbor encoded blocks |

### CARv1 Format

Structure:

```
[header: dag-cbor encoded {version: 1, roots: [CID...]}]
[block: varint(len) + CID + bytes]
[block: varint(len) + CID + bytes]
...
```

- **Header**: dag-cbor encoded map with `version: 1` and `roots: [CID]` array listing root block CIDs.
- **Body**: Sequence of length-prefixed blocks, each containing the block's CID followed by its raw bytes.
- **Streaming**: Blocks can be written and read sequentially -- no random access required. This satisfies UXF's streaming-friendly constraint.
- **Multiple roots**: A CAR can have multiple roots (e.g., one per token, or a single manifest root).

### CARv2 Format

CARv2 wraps a CARv1 payload with additional metadata:

```
[CARv2 pragma: 11 bytes identifying CARv2]
[CARv2 header: 40 bytes fixed]
  - Characteristics: 128-bit bitfield
  - Data offset: uint64 (byte offset to inner CARv1)
  - Data size: uint64 (byte length of inner CARv1)
  - Index offset: uint64 (byte offset to index)
[CARv1 payload]
[Index: CID -> offset mapping]
```

Key CARv2 features:
- **Index for random access**: Maps CID to byte offset within the CARv1 payload, enabling O(1) block lookup without sequential scanning.
- **Characteristics bitfield**: Extensible flags describing the archive.
- **Backward compatible**: The inner payload is a valid CARv1.

### JavaScript CAR API

```typescript
import { CarWriter } from '@ipld/car/writer'
import { CarReader } from '@ipld/car'

// Writing
const { writer, out } = CarWriter.create([rootCid])

// Pipe output to file or buffer
const chunks: Uint8Array[] = []
const collectPromise = (async () => {
  for await (const chunk of out) chunks.push(chunk)
})()

// Add blocks
await writer.put({ cid: leafCid, bytes: leafBytes })
await writer.put({ cid: parentCid, bytes: parentBytes })
await writer.put({ cid: rootCid, bytes: rootBytes })
await writer.close()
await collectPromise

const carBytes = concat(chunks) // single Uint8Array

// Reading
const reader = await CarReader.fromBytes(carBytes)
const roots = await reader.getRoots()
const block = await reader.get(someCid) // { cid, bytes }

// Iterate all blocks
for await (const { cid, bytes } of reader.blocks()) {
  // process each block
}
```

**`CarIndexedReader`** provides random-access reading from a file descriptor using an index, useful for large archives.

### CAR as UXF Transport Format

The alignment between CAR and UXF is remarkably tight:

1. **UXF Bundle = CAR file**. The element pool maps to the collection of blocks. The manifest is a dag-cbor block whose CID is listed as a CAR root.
2. **Deduplication**: Each block appears once in the CAR by CID. Shared sub-DAGs (unicity certificates, nametag tokens) are stored as single blocks referenced by multiple parents.
3. **Streaming creation**: `CarWriter` supports streaming -- blocks can be added as they are deconstructed from tokens, without buffering the entire pool in memory.
4. **Streaming consumption**: `CarReader` supports iteration -- tokens can begin reassembly as blocks arrive.
5. **IPFS upload**: CAR files can be uploaded directly to Storacha (web3.storage successor), Filecoin, or any IPFS pinning service that accepts CAR uploads.
6. **Indexes**: For the UXF token manifest and secondary indexes (by tokenType, by state hash), these are simply additional dag-cbor blocks in the CAR with their CIDs tracked as roots or linked from the manifest.

## 5. Packaging Patterns for Complex Hierarchical Data

### Pattern: NFT.Storage dag-cbor Bundle

NFT.Storage creates a dag-cbor "bundle" that includes structured metadata with native IPLD links to all referenced files. This is the closest existing pattern to what UXF needs:

- A root dag-cbor block contains the metadata structure
- Binary assets are stored as raw blocks
- CID links connect them into a DAG
- The entire bundle is packaged as a CAR file

### Pattern: Filecoin Chain State

Filecoin is "probably the most sophisticated example of DAG-CBOR IPLD blocks used to represent a very large and scalable graph of structured data." The entire Filecoin chain state is an IPLD DAG using dag-cbor blocks with HAMT sharding for large collections.

### Pattern: Ceramic Network Document Streams

Ceramic uses IPLD for hash-linked event logs (document streams):

- Each event is an IPLD block (dag-cbor or dag-jose for signed/encrypted)
- Events link to predecessors via CID
- Streams have an immutable `streamId` derived from the genesis event's CID
- ComposeDB adds a GraphQL layer on top

This is relevant to UXF's instance chains (newer instances linking to predecessors via content hash).

### Pattern: WNFS (Web Native File System)

WNFS by Fission builds a complete filesystem on IPLD:

- Public and private branches
- Versioned with CRDT semantics for concurrent writes
- Serializes/deserializes from IPLD graphs
- Uses "virtual nodes": Raw IPLD nodes, File nodes (data + metadata), Directory nodes (index + metadata)
- Rust implementation (`rs-wnfs`) with WASM bindings

### Pattern: Fireproof Database

Fireproof uses IPLD prolly trees for a content-addressable database:

- Documents stored in prolly-tree indexes (deterministic B-tree variant)
- Updates logged to a Merkle clock (causal event log)
- All data packaged as CAR files
- Same data always produces same physical layout and Merkle root

### Pattern: Storacha/w3up

The successor to web3.storage uses a CAR-centric upload pipeline:

- Client-side: files are chunked and hashed to calculate root CID locally
- Packaged as CAR files
- Uploaded with UCAN authorization
- Index created for retrieval

### UnixFS vs Raw IPLD DAGs

For UXF, **raw IPLD DAGs with dag-cbor** are the correct choice, not UnixFS:

- UnixFS is designed for file/directory hierarchies with chunked byte streams
- UXF's data is structured (maps, lists, typed fields, CID links) -- not files
- dag-cbor supports the full IPLD Data Model; dag-pb (used by UnixFS) does not
- Filecoin's entire chain state validates this approach at massive scale

### IPNS for Mutable Package Roots

IPNS provides stable names for mutable content:

- Each IPNS name is derived from a keypair
- Resolves to a CID that can be updated by the key holder
- IPNS records contain: content path, expiration, version/sequence number, cryptographic signature

For UXF, IPNS is relevant for the "latest version of my token pool" use case: as tokens are added/removed, the manifest root CID changes, but the IPNS name remains stable. The existing sphere-sdk already uses IPNS for wallet state publishing (`impl/shared/ipfs/`).

## 6. Deterministic Serialization Deep Dive

### dag-cbor Guarantees

dag-cbor provides the strongest determinism guarantees of any IPLD codec:

1. **Map key ordering**: Keys sorted by CBOR-encoded byte comparison (length-prefix first, then lexicographic). This is NOT JavaScript string comparison -- it is comparison of the raw CBOR-encoded key bytes.
2. **Integer minimality**: Must use smallest possible CBOR encoding.
3. **No duplicate map keys**: Strictly forbidden.
4. **No indefinite-length**: All containers must be definite-length.
5. **Float canonicalization**: Must use smallest IEEE 754 encoding (half, single, double) that preserves the value. NaN/Infinity forbidden.
6. **Tag 42 only**: No CBOR tags except 42 (CID links). All other tags are rejected.

### Ensuring Identical CIDs

To guarantee identical content produces identical CIDs:

1. **Always use `@ipld/dag-cbor` encode/decode** -- it enforces all canonicalization rules. Never hand-craft CBOR.
2. **Normalize data before encoding**: Ensure no `undefined` values (not representable in CBOR), no `NaN`/`Infinity`, no non-string map keys.
3. **Use `Uint8Array` for all binary data** -- not `Buffer` or other typed arrays.
4. **CID links must be `CID` instances** -- the encoder recognizes them via `CID.asCID()` and applies Tag 42.
5. **Avoid JavaScript `Number` for large integers** -- use `BigInt` for values outside safe integer range.

### Known Pitfalls

- **Object property order in JavaScript**: `@ipld/dag-cbor` sorts keys during encoding, so JS object property insertion order does not affect the output. This is safe.
- **`undefined` vs `null`**: `undefined` is not representable in CBOR. Omit fields rather than setting them to `undefined`.
- **`Buffer` vs `Uint8Array`**: Node.js `Buffer` extends `Uint8Array` and will encode correctly, but round-trips as `Uint8Array`.
- **Floating point precision**: `0.1 + 0.2` !== `0.3` in JavaScript. Avoid floats for values that must be deterministic. Use integers or string representations for amounts.

## 7. Performance and Size Considerations

### Block Size

- **IPFS recommended max**: 1 MiB per block (for network compatibility).
- **Practical optimum**: 1-5 MB for transfer performance, but most structured data blocks are far smaller.
- **For UXF**: Individual token elements (transactions, proofs, certificates) are typically 200 bytes to 5 KB each. These are well within limits and should be stored as individual blocks for maximum deduplication.

### CID Overhead

- **CIDv1 (dag-cbor + sha256)**: ~36 bytes binary per CID
  - 1 byte: CID version (0x01)
  - 1-2 bytes: codec multicodec varint (0x71 for dag-cbor)
  - 2 bytes: multihash header (0x12 = sha256, 0x20 = 32 bytes)
  - 32 bytes: sha256 digest
- **In CAR framing**: Each block has `varint(len) + CID + bytes`, adding ~40 bytes overhead per block.

### Trade-offs: Granularity vs Overhead

For UXF's hierarchical token structure, the key trade-off is:

| Approach | Deduplication | Overhead | Complexity |
|----------|--------------|----------|------------|
| **One block per leaf element** (authenticator, predicate, etc.) | Maximum | ~36 bytes CID per reference, many small blocks | High -- deep DAG traversal |
| **One block per mid-level element** (inclusion proof = authenticator + paths + certificate bundled) | Good -- certificates still shared across proofs | Moderate | Moderate |
| **One block per top-level element** (entire transaction as one block) | Limited -- only full transaction dedup | Minimal | Simple |

**Recommendation for UXF**: A mid-level granularity strategy:

- **Shared elements** (unicity certificates, nametag tokens, SMT path segments) should be their own blocks to enable cross-token deduplication.
- **Non-shared leaf data** (individual transaction data, per-state predicates) can be inlined into their parent block since they are unique to one token and deduplication would not save space.
- **The manifest and indexes** should be separate blocks so they can be updated independently.

This balances deduplication benefit against per-block overhead. With ~500-2000 byte certificates shared across many tokens, the 36-byte CID reference cost is easily recouped.

### Size Estimates

For a pool of 100 tokens with 5 transactions each, all from the same 10 aggregator rounds:

- **Naive**: 100 x 5 x ~2KB (certificate) = ~1MB in certificates alone
- **With deduplication**: 10 x ~2KB = ~20KB in certificates + 500 x 36 bytes in CID references = ~38KB total
- **Savings**: ~96% on certificate storage alone

## 8. Notable Projects Using IPLD for Structured Data

### Ceramic Network / ComposeDB
- **Architecture**: Hash-linked event log streams on IPLD
- **Codec**: dag-cbor (with dag-jose for signed/encrypted events)
- **Pattern**: Each document is a stream of IPLD commits; each commit has header + body as separate IPLD blocks
- **Relevance to UXF**: Instance chains (newer events linking to predecessors) mirror Ceramic's append-only stream model
- **Status**: Active, ComposeDB in production (2024-2025)

### Filecoin
- **Architecture**: Entire chain state as IPLD DAG
- **Codec**: dag-cbor exclusively
- **Pattern**: HAMT sharding for large state trees, tipsets as DAG roots
- **Relevance to UXF**: Validates dag-cbor + HAMT at extreme scale (billions of blocks)
- **Status**: Production mainnet

### WNFS (Web Native File System)
- **Architecture**: Encrypted filesystem on IPLD with CRDT conflict resolution
- **Codec**: dag-cbor
- **Pattern**: Public/private branches, versioned directories, cryptree encryption
- **Relevance to UXF**: Demonstrates versioned, updatable content-addressed structures with privacy
- **Status**: Active development, Rust implementation (`rs-wnfs`) with WASM bindings

### Fireproof
- **Architecture**: Cloudless database using IPLD prolly trees
- **Codec**: dag-cbor, packaged as CAR files
- **Pattern**: Deterministic Merkle tree indexes, causal event log (Merkle clock)
- **Relevance to UXF**: CAR-based packaging of structured data with deterministic indexes
- **Status**: Active, production-ready (2024-2025)

### DASL (Data-Addressed Structures & Links)
- **Architecture**: Simplified IPLD primitives for broader web adoption
- **Status**: Specifications published December 2024, expanding through 2025. CBOR/c-42 spec submitted to IETF as Internet Draft (May 2025).
- **Relevance**: Represents the ecosystem's direction toward standardizing content-addressed primitives beyond the IPFS-specific stack.

---

## Summary of Concrete Recommendations for UXF

1. **Codec**: Use `dag-cbor` (`@ipld/dag-cbor` v9.2.5) as the primary encoding. Use `dag-json` only for debugging/inspection tools.

2. **CIDs**: Use CIDv1 with `sha2-256` via `multiformats` v13.4.2. Binary CIDs are ~36 bytes.

3. **Archive format**: Use **CAR files** (`@ipld/car` v5.4.2) as the UXF bundle container. A UXF bundle IS a CAR file -- the element pool maps to blocks, the manifest root is the CAR root. CARv1 is sufficient for most use cases; CARv2 adds indexing for large archives.

4. **Block granularity**: Decompose at the level where deduplication provides measurable benefit -- shared sub-elements (certificates, nametag tokens, SMT segments) as separate blocks; unique leaf data inlined into parent blocks.

5. **Schema validation**: Use `@ipld/schema` for defining and validating element types.

6. **Determinism**: Rely on `@ipld/dag-cbor`'s canonical encoding. Avoid floats for deterministic values. Use `BigInt` for large integers. Always use `Uint8Array` for binary data.

7. **Streaming**: `CarWriter`/`CarReader` support streaming creation and consumption, satisfying the streaming-friendly constraint.

8. **IPFS integration**: CAR files can be uploaded directly to Storacha/web3.storage, IPFS pinning services, or used with Helia for peer-to-peer distribution. The existing sphere-sdk IPNS infrastructure can point to the latest CAR root.

9. **Large pools**: If the element pool exceeds ~10K elements, consider HAMT sharding (as Filecoin does) to avoid single massive manifest blocks.

10. **Instance chains**: Model after Ceramic's event stream pattern -- each new instance is a dag-cbor block with a `predecessor` CID link to the previous instance.

---

Sources:
- [IPLD DAG-CBOR Specification](https://ipld.io/specs/codecs/dag-cbor/spec/)
- [IPLD DAG-JSON Specification](https://ipld.io/specs/codecs/dag-json/spec/)
- [IPLD Codec Docs: DAG-CBOR](https://ipld.io/docs/codecs/known/dag-cbor/)
- [IPLD Codec Docs: DAG-JSON](https://ipld.io/docs/codecs/known/dag-json/)
- [IPLD Specs Repository](https://github.com/ipld/specs)
- [@ipld/dag-cbor on npm](https://www.npmjs.com/package/@ipld/dag-cbor)
- [@ipld/dag-json on npm](https://www.npmjs.com/package/@ipld/dag-json)
- [@ipld/car on npm](https://www.npmjs.com/package/@ipld/car)
- [multiformats on npm](https://www.npmjs.com/package/multiformats)
- [@ipld/schema on npm](https://www.npmjs.com/package/@ipld/schema)
- [js-dag-cbor GitHub](https://github.com/ipld/js-dag-cbor)
- [js-car GitHub](https://github.com/ipld/js-car)
- [CARv1 Specification](https://ipld.io/specs/transport/car/carv1/)
- [CARv2 Specification](https://ipld.io/specs/transport/car/carv2/)
- [IPLD Advanced Data Layouts](https://ipld.io/docs/advanced-data-layouts/)
- [IPLD HAMT Specification](https://ipld.io/specs/advanced-data-layouts/hamt/spec/)
- [IPLD Prolly Tree Proposal](https://github.com/ipld/ipld/pull/254)
- [Prolly Tree Analysis](https://blog.mauve.moe/posts/prolly-tree-analysis)
- [Content Identifiers (CIDs) - IPFS Docs](https://docs.ipfs.tech/concepts/content-addressing/)
- [Multiformats CID Spec](https://github.com/multiformats/cid)
- [Helia - Modern IPFS in TypeScript](https://github.com/ipfs/helia)
- [Helia on npm](https://www.npmjs.com/package/helia)
- [ipld-schema-validator on npm](https://www.npmjs.com/package/ipld-schema-validator)
- [Ceramic Network - How it Works](https://ceramic.network/how-it-works)
- [Ceramic Event Log Specification](https://developers.ceramic.network/protocol/streams/event-log/)
- [WNFS - Fission](https://fission.codes/ecosystem/wnfs/)
- [rs-wnfs GitHub](https://github.com/wnfs-wg/rs-wnfs)
- [Fireproof Architecture](https://use-fireproof.com/docs/architecture/)
- [Fireproof Database Engine](https://fireproof.storage/documentation/how-the-database-engine-works/)
- [Storacha CAR Documentation](https://docs.storacha.network/concepts/car/)
- [DASL - Data-Addressed Structures & Links](https://dasl.ing/)
- [DASL CAR Specification](https://dasl.ing/car.html)
- [IPFS IPLD Block Size Discussion](https://discuss.ipfs.tech/t/supporting-large-ipld-blocks/15093)
- [NFT.Storage CAR Files](https://dev.nft.storage/docs/concepts/car-files/)
- [Storacha/w3up Protocol](https://github.com/storacha/w3up)
- [IPNS Documentation](https://docs.ipfs.tech/concepts/ipns/)
- [cborg - CBOR Library](https://github.com/rvagg/cborg)