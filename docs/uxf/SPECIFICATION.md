# UXF: Universal eXchange Format Specification

**Version:** 1.0.0-draft
**Status:** Draft
**Date:** 2026-03-26
**Authors:** Unicity Labs

---

## Table of Contents

1. [Format Overview](#1-format-overview)
2. [Element Type Taxonomy](#2-element-type-taxonomy)
3. [Element Header Format](#3-element-header-format)
4. [Content Hash Computation](#4-content-hash-computation)
5. [Package Envelope](#5-package-envelope)
6. [Serialization Formats](#6-serialization-formats)
7. [Instance Chain Specification](#7-instance-chain-specification)
8. [Deconstruction Rules](#8-deconstruction-rules)
9. [Reassembly Rules](#9-reassembly-rules)
10. [Worked Examples](#10-worked-examples)

---

## 1. Format Overview

### 1.1 Purpose

UXF (Universal eXchange Format) is a content-addressable packaging format for storing and exchanging pools of Unicity tokens across users, devices, and distributed storage systems. It provides:

- **Deep deduplication** of shared cryptographic materials at every level of the token hierarchy (unicity certificates, SMT path segments, nametag tokens, predicates).
- **Efficient extraction** of individual tokens at any historical state.
- **Incremental updates** -- adding, removing, or updating token records without rewriting the entire package.
- **Token integrity preservation** -- any extracted token is self-contained and verifiable without access to the full pool.
- **Content-addressable storage alignment** -- the internal DAG structure maps directly to IPFS/IPLD, enabling cross-user deduplication at the storage layer.

### 1.2 Scope

UXF operates at the **packaging layer** between individual token serialization (ITokenJson / CBOR v2.0) and transport/storage mechanisms. It is:

- **Transport-agnostic** -- UXF packages are opaque byte sequences or JSON documents suitable for any transport (HTTP, NFC, Bluetooth, IPFS, file copy).
- **Encryption-agnostic** -- encryption may be layered on top but is not part of the format.
- **Platform-agnostic** -- the format is defined independently of any runtime (browser, Node.js, mobile).

### 1.3 Design Goals

| Goal | Description |
|------|-------------|
| **Backward compatibility** | Ingest and emit standard ITokenJson / CBOR v2.0 tokens without loss |
| **Self-describing** | Parseable without external schema knowledge (version fields, type markers) |
| **Streaming-friendly** | Begin extracting tokens before the entire package is downloaded |
| **Deterministic serialization** | Identical logical content produces identical byte sequences |
| **Size efficiency** | N tokens with shared materials significantly smaller than N independent serializations |
| **Representation/semantics separation** | Encoding may change freely; semantic meaning is fixed at creation |
| **Mixed-version tolerance** | Tokens may contain elements of heterogeneous semantic versions |
| **Reassembly completeness** | Reassembled tokens are indistinguishable from originals |

### 1.4 Relationship to Existing Formats

UXF builds upon and is interoperable with three existing serialization layers:

**ITokenJson (state-transition-sdk v2.0):** The canonical self-contained token representation. A token in ITokenJson form carries its complete history: genesis data, ordered transactions with inclusion proofs, current state, and embedded nametag tokens. UXF ingests ITokenJson tokens via deconstruction and produces ITokenJson tokens via reassembly. The reassembled output is byte-for-byte semantically identical to the original.

**TXF (sphere-sdk):** The wallet-level storage format. TXF wraps ITokenJson with wallet-specific metadata (`_integrity`, string-only nametag references, `previousStateHash`/`newStateHash` derived fields, outbox entries, tombstones). UXF replaces TXF's flat per-token storage model with a shared content-addressed DAG, but the TXF layer remains the interface between UXF and the wallet application. Wallet metadata (outbox, tombstones, mint entries) is stored in the package envelope, not in the element pool.

**CBOR v2.0 (state-transition-sdk):** The binary wire format for individual token fields. UXF elements use CBOR as their binary encoding, following the same conventions as the existing SDK: CBOR tags for type identification (e.g., tag 1007 for UnicityCertificate), deterministic encoding (RFC 8949 Core Deterministic Encoding), and hex-encoded byte strings in the JSON alternate representation.

### 1.5 Terminology

| Term | Definition |
|------|------------|
| **Element** | A node in the content-addressed DAG. Each element has a type, a header, and typed fields. Some fields are child references (content hashes pointing to other elements). |
| **Element pool** | The flat, content-addressed store of all elements in a UXF package. Keyed by content hash. |
| **Content hash** | SHA-256 hash of an element's canonical CBOR encoding. Serves as the element's unique identifier and address in the pool. |
| **Child reference** | A field in a parent element whose value is the content hash of a child element, rather than inline data. |
| **Token manifest** | A mapping from `tokenId` to the content hash of the token's root element (TokenRoot). |
| **Instance chain** | A singly-linked list of semantically equivalent alternative representations of the same logical element, linked via `predecessor` hashes from newest to oldest. |
| **Deconstruction** | The process of recursively decomposing a self-contained token into elements and ingesting them into the pool. |
| **Reassembly** | The process of recursively resolving child references from a root element to produce a self-contained token. |
| **Representation version** | Encoding format version; may change when the element is re-serialized. |
| **Semantic version** | Protocol version governing validation rules; fixed at element creation and never changed. |

---

## 2. Element Type Taxonomy

### 2.1 Element Type Enumeration

Each element type is assigned a unique unsigned integer identifier used in the element header and CBOR encoding.

```
ElementType = uint

ElementType_TokenRoot               = 0x01
ElementType_GenesisTransaction      = 0x02
ElementType_TransferTransaction     = 0x03
ElementType_MintTransactionData     = 0x04
ElementType_TransferTransactionData = 0x05
ElementType_TokenState              = 0x06
ElementType_Predicate               = 0x07
ElementType_InclusionProof          = 0x08
ElementType_Authenticator           = 0x09
ElementType_UnicityCertificate      = 0x0A
ElementType_SmtPathSegment          = 0x0B
ElementType_TokenCoinData           = 0x0C
ElementType_SmtPath                 = 0x0D
```

Reserved ranges:

| Range | Purpose |
|-------|---------|
| 0x00 | Reserved (invalid) |
| 0x01 -- 0x1F | Core token structure elements |
| 0x20 -- 0x3F | Proof and certificate elements |
| 0x40 -- 0x5F | Extension elements (future) |
| 0xF0 -- 0xFF | Experimental / private use |

### 2.2 Element Type Definitions

Each element definition below specifies:
- **Fields:** name, type, whether required or optional
- **Child references:** fields that contain content hashes of other elements (marked with `@ref`)
- **Leaf data:** fields that contain inline data (not references)
- **Mutability:** whether the element is single-instance (no instance chain) or instance-chain-eligible

#### 2.2.1 TokenRoot (0x01)

The top-level element representing a complete token. Each token in the manifest points to exactly one TokenRoot element.

| Field | Type | Required | Reference | Description |
|-------|------|----------|-----------|-------------|
| `header` | ElementHeader | yes | -- | Element header (see Section 3) |
| `tokenId` | bytes(32) | yes | leaf | Unique 32-byte token identifier |
| `tokenType` | bytes(32) | yes | leaf | 32-byte asset class identifier |
| `genesis` | hash(32) | yes | @ref -> GenesisTransaction | Content hash of the genesis transaction element |
| `transactions` | array\<hash(32)\> | yes | @ref -> TransferTransaction[] | Ordered array of content hashes of transfer transaction elements; empty array if never transferred |
| `state` | hash(32) | yes | @ref -> TokenState | Content hash of the current token state element |
| `nametags` | array\<hash(32)\> | no | @ref -> TokenRoot[] | Content hashes of embedded nametag token root elements (each is itself a complete token DAG) |
| `coinData` | hash(32) | yes | @ref -> TokenCoinData | Content hash of the token's fungible value element |

**Mutability:** Instance-chain-eligible. A TokenRoot may have alternative instances when the entire token history is replaced by a ZK proof (the ZK proof instance references the full-history instance as predecessor).

**Mapping from ITokenJson:**
- `tokenId` -> `genesis.data.tokenId` (extracted to root for manifest indexing)
- `tokenType` -> `genesis.data.tokenType` (extracted to root for type-based indexing)
- `genesis` -> deconstructed GenesisTransaction sub-DAG
- `transactions` -> ordered array of deconstructed TransferTransaction sub-DAGs
- `state` -> deconstructed TokenState
- `nametags` -> each nametag token is recursively deconstructed into its own TokenRoot sub-DAG
- `coinData` -> extracted from `genesis.data.coinData`

#### 2.2.2 GenesisTransaction (0x02)

The mint (genesis) transaction that created the token. Contains the immutable minting parameters, the inclusion proof from the aggregator, and the destination state after minting.

| Field | Type | Required | Reference | Description |
|-------|------|----------|-----------|-------------|
| `header` | ElementHeader | yes | -- | Element header |
| `data` | hash(32) | yes | @ref -> MintTransactionData | Content hash of the mint transaction data element |
| `inclusionProof` | hash(32) | yes | @ref -> InclusionProof | Content hash of the genesis inclusion proof element |
| `destinationState` | hash(32) | yes | @ref -> TokenState | Content hash of the post-genesis token state |

**Mutability:** Single-instance. Genesis transactions are immutable once created. The inclusion proof child may independently have instance chains (e.g., consolidated proofs), but the GenesisTransaction element itself does not.

#### 2.2.3 TransferTransaction (0x03)

A state transition (transfer) applied to the token after genesis.

| Field | Type | Required | Reference | Description |
|-------|------|----------|-----------|-------------|
| `header` | ElementHeader | yes | -- | Element header |
| `sourceState` | hash(32) | yes | @ref -> TokenState | Content hash of the token state before this transition |
| `data` | hash(32) / null | no | @ref -> TransferTransactionData | Content hash of the transfer data element; null for uncommitted transactions |
| `inclusionProof` | hash(32) / null | no | @ref -> InclusionProof | Content hash of the inclusion proof; null for uncommitted transactions |
| `destinationState` | hash(32) | yes | @ref -> TokenState | Content hash of the token state after this transition |

**Mutability:** Single-instance. Transfer transactions are immutable. Their child inclusion proofs may have instance chains.

#### 2.2.4 MintTransactionData (0x04)

The immutable parameters of a mint (genesis) transaction.

| Field | Type | Required | Reference | Description |
|-------|------|----------|-----------|-------------|
| `header` | ElementHeader | yes | -- | Element header |
| `tokenId` | bytes(32) | yes | leaf | 32-byte unique token identifier |
| `tokenType` | bytes(32) | yes | leaf | 32-byte asset class identifier |
| `coinData` | hash(32) | yes | @ref -> TokenCoinData | Content hash of the coin data element |
| `tokenData` | bytes | yes | leaf | Arbitrary metadata (may be empty) |
| `salt` | bytes(32) | yes | leaf | 32-byte random salt |
| `recipient` | text | yes | leaf | Recipient address (DIRECT://...) |
| `recipientDataHash` | bytes(32) / null | no | leaf | Optional hash of recipient-specific data |
| `reason` | text / null | no | leaf | Optional mint reason |

**Mutability:** Single-instance.

#### 2.2.5 TransferTransactionData (0x05)

The parameters of a transfer operation.

| Field | Type | Required | Reference | Description |
|-------|------|----------|-----------|-------------|
| `header` | ElementHeader | yes | -- | Element header |
| `recipient` | text | yes | leaf | Recipient address or identifier |
| `salt` | bytes(32) | yes | leaf | 32-byte random salt |
| `recipientDataHash` | bytes(32) / null | no | leaf | Optional recipient data hash |
| `extraData` | map / null | no | leaf | Optional key-value metadata |

**Mutability:** Single-instance.

#### 2.2.6 TokenState (0x06)

The ownership state of a token at a particular point in its history.

| Field | Type | Required | Reference | Description |
|-------|------|----------|-----------|-------------|
| `header` | ElementHeader | yes | -- | Element header |
| `predicate` | hash(32) | yes | @ref -> Predicate | Content hash of the predicate defining ownership |
| `data` | bytes | no | leaf | Optional state data; empty bytes if absent |

**Mutability:** Single-instance.

**State hash note:** The SDK-level state hash (used in authenticators, `previousStateHash`/`newStateHash`) is computed by the SDK over the predicate and data using the SDK's own algorithm. This is a protocol-level semantic value, distinct from the UXF content hash of the TokenState element.

#### 2.2.7 Predicate (0x07)

An ownership condition controlling who can authorize state transitions.

| Field | Type | Required | Reference | Description |
|-------|------|----------|-----------|-------------|
| `header` | ElementHeader | yes | -- | Element header |
| `type` | text | yes | leaf | `"unmasked"` or `"masked"` |
| `publicKey` | bytes(33) / null | no | leaf | Compressed secp256k1 key (unmasked) |
| `publicKeyHash` | bytes(32) / null | no | leaf | SHA-256 of public key (masked) |
| `signingAlgorithm` | text | yes | leaf | e.g., `"secp256k1"` |
| `hashAlgorithm` | text | yes | leaf | e.g., `"SHA-256"` |
| `nonce` | bytes / null | no | leaf | Optional nonce for replay protection |

**Mutability:** Single-instance.

#### 2.2.8 InclusionProof (0x08)

A Sparse Merkle Tree inclusion proof demonstrating a state transition was committed to the aggregator.

| Field | Type | Required | Reference | Description |
|-------|------|----------|-----------|-------------|
| `header` | ElementHeader | yes | -- | Element header |
| `authenticator` | hash(32) | yes | @ref -> Authenticator | Content hash of authenticator element |
| `merkleTreePath` | hash(32) | yes | @ref -> SmtPath | Content hash of SMT path element |
| `transactionHash` | bytes(32) | yes | leaf | Hash of the proven transaction |
| `unicityCertificate` | hash(32) | yes | @ref -> UnicityCertificate | Content hash of unicity certificate |

**Mutability:** Instance-chain-eligible. Proofs may be consolidated or replaced with ZK proofs.

#### 2.2.9 Authenticator (0x09)

The signing attestation within an inclusion proof.

| Field | Type | Required | Reference | Description |
|-------|------|----------|-----------|-------------|
| `header` | ElementHeader | yes | -- | Element header |
| `algorithm` | text | yes | leaf | e.g., `"secp256k1"` |
| `publicKey` | bytes(33) | yes | leaf | 33-byte compressed secp256k1 key |
| `signature` | bytes | yes | leaf | Signature bytes |
| `stateHash` | bytes(32) | yes | leaf | SHA-256 of token state at commitment time |

**Mutability:** Single-instance.

#### 2.2.10 UnicityCertificate (0x0A)

A BFT-signed aggregator round commitment. The primary deduplication target: all tokens transacted in the same round share the same certificate.

| Field | Type | Required | Reference | Description |
|-------|------|----------|-----------|-------------|
| `header` | ElementHeader | yes | -- | Element header |
| `rawCbor` | bytes | yes | leaf | Original CBOR-encoded certificate (tag 1007), preserved verbatim |

**Design rationale:** Stored as opaque CBOR rather than decomposed into internal fields because: (1) the certificate is produced and signed by the BFT layer -- its internal structure is defined by the aggregator protocol; (2) preserving exact bytes ensures stable content hashes; (3) the certificate is the primary dedup target and byte-level identity is essential.

**Mutability:** Single-instance.

#### 2.2.11 SmtPath (0x0D)

A complete Sparse Merkle Tree path from leaf to root.

| Field | Type | Required | Reference | Description |
|-------|------|----------|-----------|-------------|
| `header` | ElementHeader | yes | -- | Element header |
| `root` | bytes(32) | yes | leaf | SMT root hash |
| `segments` | array\<hash(32)\> | yes | @ref -> SmtPathSegment[] | Ordered segment content hashes, leaf to root |

**Mutability:** Instance-chain-eligible (consolidation).

#### 2.2.12 SmtPathSegment (0x0B)

An individual node in a Sparse Merkle Tree path. Proofs from the same round share upper segments.

| Field | Type | Required | Reference | Description |
|-------|------|----------|-----------|-------------|
| `header` | ElementHeader | yes | -- | Element header |
| `data` | bytes | yes | leaf | Sibling hash at this tree level |
| `path` | bytes | yes | leaf | Path direction indicator |

**Mutability:** Single-instance.

#### 2.2.13 TokenCoinData (0x0C)

The fungible value of a token as an array of (coinId, amount) pairs.

| Field | Type | Required | Reference | Description |
|-------|------|----------|-----------|-------------|
| `header` | ElementHeader | yes | -- | Element header |
| `coins` | array\<[text, text]\> | yes | leaf | Array of [coinId, amount] pairs |

**Mutability:** Single-instance.

### 2.3 Element Type Summary

| Type ID | Name | Child Refs | Instance-Chain-Eligible | Primary Dedup Target |
|---------|------|-----------|------------------------|---------------------|
| 0x01 | TokenRoot | genesis, transactions[], state, nametags[], coinData | yes | -- |
| 0x02 | GenesisTransaction | data, inclusionProof, destinationState | no | -- |
| 0x03 | TransferTransaction | sourceState, data, inclusionProof, destinationState | no | -- |
| 0x04 | MintTransactionData | coinData | no | -- |
| 0x05 | TransferTransactionData | (none) | no | -- |
| 0x06 | TokenState | predicate | no | same-owner states |
| 0x07 | Predicate | (none) | no | same-owner predicates |
| 0x08 | InclusionProof | authenticator, merkleTreePath, unicityCertificate | yes | same-round proofs |
| 0x09 | Authenticator | (none) | no | -- |
| 0x0A | UnicityCertificate | (none) | no | same-round certificates |
| 0x0B | SmtPathSegment | (none) | no | shared upper segments |
| 0x0C | TokenCoinData | (none) | no | same-value tokens |
| 0x0D | SmtPath | segments[] | yes | same-round paths |

---

## 3. Element Header Format

Every element begins with a header encoding its version, lineage, and kind.

### 3.1 Header Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `representation` | uint | yes | Encoding format version. Starts at 1. |
| `semantics` | uint | yes | Protocol semantic version. Fixed at creation. Starts at 1. |
| `kind` | text | yes | Instance kind label for selection during reassembly. |
| `predecessor` | bytes(32) / null | yes | Content hash of previous instance, or null for original. |

### 3.2 Standard Kind Values

| Kind | Applicable Types | Description |
|------|-----------------|-------------|
| `"default"` | all | Standard/original representation |
| `"consolidated-proof"` | InclusionProof, SmtPath | Multiple proofs merged into shared SMT subtree |
| `"zk-proof"` | InclusionProof, TokenRoot | ZK proof replacing full history |
| `"full-history"` | TokenRoot | Explicit tag for complete auditable chain |
| `"re-encoded"` | all | Re-serialized into newer representation |

Unknown kind values must be preserved during round-trips.

### 3.3 CBOR Encoding

```cddl
element-header = [
  representation: uint,
  semantics: uint,
  kind: tstr,
  predecessor: bstr .size 32 / null
]
```

Examples (CBOR diagnostic notation):
```
[1, 1, "default", null]                          ; original instance
[2, 1, "re-encoded", h'a1b2c3...']               ; re-encoded, pointing to predecessor
[1, 1, "consolidated-proof", h'd4e5f6...']        ; consolidated proof instance
```

### 3.4 JSON Encoding

```json
{
  "header": {
    "representation": 1,
    "semantics": 1,
    "kind": "default",
    "predecessor": null
  }
}
```

Non-null predecessors are 64-character lowercase hex strings.

### 3.5 JSON Schema

```json
{
  "$id": "https://unicity.network/uxf/v1/element-header.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "UXF Element Header",
  "type": "object",
  "properties": {
    "representation": { "type": "integer", "minimum": 1 },
    "semantics": { "type": "integer", "minimum": 1 },
    "kind": { "type": "string", "minLength": 1 },
    "predecessor": {
      "oneOf": [
        { "type": "null" },
        { "type": "string", "pattern": "^[0-9a-f]{64}$" }
      ]
    }
  },
  "required": ["representation", "semantics", "kind", "predecessor"],
  "additionalProperties": false
}
```

---

## 4. Content Hash Computation

### 4.1 Hash Algorithm

All content hashes use **SHA-256**, consistent with existing state-transition-sdk conventions.

```
content_hash = SHA-256(canonical_cbor_encoding(element))
```

### 4.2 What Is Hashed

The content hash covers the **complete canonical CBOR encoding** of the element, including:
- The element header
- All leaf data fields
- All child reference fields (as raw 32-byte hash values, NOT resolved content)

The content hash does **not** include:
- The enclosing CBOR tag (identifies type in stream, not part of content)
- Package-level metadata (manifest entries, index entries)

### 4.3 Child References in Hash Computation

Child references are raw 32-byte SHA-256 values. A parent's content hash depends on children's hashes but NOT children's content. Replacing a child with a new instance (different hash) requires creating a new parent instance that references the new child hash.

### 4.4 Deterministic CBOR Encoding Rules

UXF mandates **RFC 8949 Section 4.2.1 Core Deterministic Encoding**:

1. Integers: shortest encoding.
2. Maps: keys sorted by encoded byte comparison.
3. No indefinite-length encoding.
4. Preferred floating-point: shortest preserving value.
5. No duplicate map keys.
6. Byte/text strings: definite-length, shortest prefix.

Additional UXF rules:

7. Array fields: order per element type definition. Header always first.
8. Null encoding: absent optional fields encoded as CBOR null (0xF6), NOT omitted.
9. Empty arrays: encoded as `[]` (0x80), NOT omitted.

### 4.5 CDDL Types

```cddl
content-hash = bstr .size 32
child-ref = content-hash
nullable-child-ref = content-hash / null
```

---

## 5. Package Envelope

### 5.1 Structure Overview

A UXF package consists of:
1. Package header (magic bytes + version)
2. Metadata section
3. Token manifest (tokenId -> root hash)
4. Instance chain index
5. Secondary indexes (optional)
6. Element pool

### 5.2 Magic Bytes

Binary format:
```
Bytes:  0x55 0x58 0x46 0x00 0x01 0x00 0x00 0x00
        U    X    F    \0   version (uint32 LE = 1)
```

JSON format:
```json
{ "uxf": "1.0.0" }
```

### 5.3 Metadata Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | text | yes | Package format version |
| `createdAt` | uint | yes | Unix timestamp (seconds) |
| `updatedAt` | uint | yes | Unix timestamp of last modification |
| `creator` | text | no | Creating software identifier |
| `description` | text | no | Human-readable description |
| `elementCount` | uint | yes | Total elements in pool |
| `tokenCount` | uint | yes | Tokens in manifest |

### 5.4 Token Manifest

```cddl
token-manifest = { * token-id => content-hash }
token-id = bstr .size 32
```

JSON: keys and values are 64-char lowercase hex strings.

### 5.5 Instance Chain Index

Provides O(1) lookup from any element hash to its instance chain head.

```cddl
instance-chain-index = { * content-hash => instance-chain-entry }
instance-chain-entry = {
  head: content-hash,
  kind: tstr,
  length: uint
}
```

**Invariants:**
- Elements that are NOT chain heads have entries pointing to the head.
- Chain heads are NOT in the index (they are discoverable directly).
- The index is an acceleration structure; it can be rebuilt by following predecessor links.

### 5.6 Secondary Indexes

Optional acceleration structures:

**Token Type Index:** Maps token type to token IDs.
```cddl
token-type-index = { * token-type => [+ token-id] }
```

**State Hash Index:** Maps state hashes to token IDs at that state.
```cddl
state-hash-index = { * content-hash => [+ token-id] }
```

### 5.7 CBOR Package Structure

```cddl
uxf-package = {
  magic: bstr .size 8,
  metadata: package-metadata,
  manifest: token-manifest,
  instanceChainIndex: instance-chain-index,
  ? indexes: secondary-indexes,
  elements: element-pool
}

package-metadata = {
  version: tstr,
  createdAt: uint,
  updatedAt: uint,
  ? creator: tstr,
  ? description: tstr,
  elementCount: uint,
  tokenCount: uint
}

element-pool = { * content-hash => tagged-element }
```

### 5.8 JSON Package Structure

```json
{
  "uxf": "1.0.0",
  "metadata": {
    "version": "1.0.0",
    "createdAt": 1711411200,
    "updatedAt": 1711411200,
    "creator": "sphere-sdk/0.6.11",
    "elementCount": 42,
    "tokenCount": 3
  },
  "manifest": {
    "<tokenId_hex>": "<rootHash_hex>"
  },
  "instanceChainIndex": {
    "<elementHash_hex>": {
      "head": "<headHash_hex>",
      "kind": "consolidated-proof",
      "length": 3
    }
  },
  "indexes": {
    "byTokenType": { "<tokenType_hex>": ["<tokenId_hex>"] },
    "byStateHash": { "<stateHash_hex>": ["<tokenId_hex>"] }
  },
  "elements": {
    "<contentHash_hex>": { "type": 1, "header": {...}, ... }
  }
}
```

### 5.9 JSON Schema for Package Envelope

```json
{
  "$id": "https://unicity.network/uxf/v1/package.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "UXF Package",
  "type": "object",
  "properties": {
    "uxf": { "const": "1.0.0" },
    "metadata": {
      "type": "object",
      "properties": {
        "version": { "type": "string" },
        "createdAt": { "type": "integer", "minimum": 0 },
        "updatedAt": { "type": "integer", "minimum": 0 },
        "creator": { "type": "string" },
        "description": { "type": "string" },
        "elementCount": { "type": "integer", "minimum": 0 },
        "tokenCount": { "type": "integer", "minimum": 0 }
      },
      "required": ["version", "createdAt", "updatedAt", "elementCount", "tokenCount"]
    },
    "manifest": {
      "type": "object",
      "patternProperties": {
        "^[0-9a-f]{64}$": { "type": "string", "pattern": "^[0-9a-f]{64}$" }
      },
      "additionalProperties": false
    },
    "instanceChainIndex": {
      "type": "object",
      "patternProperties": {
        "^[0-9a-f]{64}$": {
          "type": "object",
          "properties": {
            "head": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
            "kind": { "type": "string" },
            "length": { "type": "integer", "minimum": 1 }
          },
          "required": ["head", "kind", "length"]
        }
      }
    },
    "elements": {
      "type": "object",
      "patternProperties": {
        "^[0-9a-f]{64}$": { "type": "object" }
      },
      "additionalProperties": false
    }
  },
  "required": ["uxf", "metadata", "manifest", "elements"]
}
```

---

## 6. Serialization Formats

### 6a. CBOR Binary Format

#### 6a.1 CBOR Tag Allocation

| Element Type | CBOR Tag (hex) | CBOR Tag (decimal) |
|-------------|----------------|-------------------|
| TokenRoot | 0xC0001 | 786433 |
| GenesisTransaction | 0xC0002 | 786434 |
| TransferTransaction | 0xC0003 | 786435 |
| MintTransactionData | 0xC0004 | 786436 |
| TransferTransactionData | 0xC0005 | 786437 |
| TokenState | 0xC0006 | 786438 |
| Predicate | 0xC0007 | 786439 |
| InclusionProof | 0xC0008 | 786440 |
| Authenticator | 0xC0009 | 786441 |
| UnicityCertificate | 0xC000A | 786442 |
| SmtPathSegment | 0xC000B | 786443 |
| TokenCoinData | 0xC000C | 786444 |
| SmtPath | 0xC000D | 786445 |

> The state-transition-sdk uses CBOR tag 1007 for UnicityCertificate serialization. UXF tag 0xC000A wraps the UXF element which contains the raw CBOR (with its original tag 1007) as a leaf field. These tags operate at different levels.

#### 6a.2 Element CBOR Encoding (CDDL)

```cddl
element-header = [
  representation: uint,
  semantics: uint,
  kind: tstr,
  predecessor: bstr .size 32 / null
]

content-hash = bstr .size 32
nullable-ref = content-hash / null

token-root = #6.786433([
  header: element-header,
  tokenId: bstr .size 32,
  tokenType: bstr .size 32,
  genesis: content-hash,
  transactions: [* content-hash],
  state: content-hash,
  nametags: [* content-hash] / null,
  coinData: content-hash
])

genesis-transaction = #6.786434([
  header: element-header,
  data: content-hash,
  inclusionProof: content-hash,
  destinationState: content-hash
])

transfer-transaction = #6.786435([
  header: element-header,
  sourceState: content-hash,
  data: nullable-ref,
  inclusionProof: nullable-ref,
  destinationState: content-hash
])

mint-transaction-data = #6.786436([
  header: element-header,
  tokenId: bstr .size 32,
  tokenType: bstr .size 32,
  coinData: content-hash,
  tokenData: bstr,
  salt: bstr .size 32,
  recipient: tstr,
  recipientDataHash: bstr .size 32 / null,
  reason: tstr / null
])

transfer-transaction-data = #6.786437([
  header: element-header,
  recipient: tstr,
  salt: bstr .size 32,
  recipientDataHash: bstr .size 32 / null,
  extraData: { * tstr => any } / null
])

token-state = #6.786438([
  header: element-header,
  predicate: content-hash,
  data: bstr
])

predicate = #6.786439([
  header: element-header,
  type: tstr,
  publicKey: bstr .size 33 / null,
  publicKeyHash: bstr .size 32 / null,
  signingAlgorithm: tstr,
  hashAlgorithm: tstr,
  nonce: bstr / null
])

inclusion-proof = #6.786440([
  header: element-header,
  authenticator: content-hash,
  merkleTreePath: content-hash,
  transactionHash: bstr .size 32,
  unicityCertificate: content-hash
])

authenticator = #6.786441([
  header: element-header,
  algorithm: tstr,
  publicKey: bstr .size 33,
  signature: bstr,
  stateHash: bstr .size 32
])

unicity-certificate = #6.786442([
  header: element-header,
  rawCbor: bstr
])

smt-path-segment = #6.786443([
  header: element-header,
  data: bstr,
  path: bstr
])

token-coin-data = #6.786444([
  header: element-header,
  coins: [* [tstr, tstr]]
])

smt-path = #6.786445([
  header: element-header,
  root: bstr .size 32,
  segments: [* content-hash]
])
```

#### 6a.3 Deterministic Encoding

Per RFC 8949 Section 4.2.1 plus additional UXF constraints (see Section 4.4).

### 6b. JSON Format

#### 6b.1 Conventions

- Binary fields: lowercase hexadecimal strings.
- Content hashes: 64-char lowercase hex.
- Null values: JSON `null`.
- Empty arrays: `[]`.
- Field names: camelCase.

#### 6b.2 Element JSON Encoding

Each element in the JSON pool has a `type` field (integer) plus all fields with human-readable names. See Section 2.2 for the complete field list per type.

> The Predicate element uses `predicateType` (not `type`) for its type discriminator field to avoid collision with the element type identifier.

Sample encodings for all 13 types are provided in the reference implementation test fixtures.

### 6c. CAR File Format (for IPFS Export)

#### 6c.1 CID Construction

Each UXF element maps to an IPLD block:
- **Codec:** `dag-cbor` (0x71)
- **Hash:** `sha2-256` (0x12)
- **CID version:** CIDv1

The CID's multihash digest is identical to the UXF content hash (both SHA-256 over the same canonical CBOR). This ensures UXF hashes and IPFS CIDs refer to the same content.

#### 6c.2 DAG-CBOR Link Encoding

For IPLD, child references use CBOR tag 42 (IPLD link) wrapping the child's CID bytes, rather than raw 32-byte hashes. This transformation is applied during CAR export and reversed during import. Content hash computation (Section 4) always uses native UXF form.

#### 6c.3 Root CIDs

The CAR file's root is the CID of the **package manifest block** (dag-cbor encoded manifest + metadata).

#### 6c.4 Block Layout

Ordered for streaming:
1. Package manifest block (root)
2. TokenRoot blocks (manifest order)
3. Remaining elements in breadth-first traversal
4. Shared elements appear once at first reference position

#### 6c.5 CAR v2 Structure

```
Header:  version=2, roots=[manifest_CID]
Data:    ordered IPLD blocks
Index:   optional CID-to-offset mapping
```

---

## 7. Instance Chain Specification

### 7.1 Chain Structure

A singly-linked list via `predecessor` hashes, newest to oldest:

```
head (newest) --predecessor--> ... --predecessor--> original (predecessor: null)
```

All elements in a chain have the same type and are semantically equivalent.

### 7.2 Creation Rules

1. New instance MUST have same element type as all others in chain.
2. `predecessor` MUST be the current chain head's content hash.
3. `semantics` version MUST be >= predecessor's.
4. `kind` MUST accurately describe the instance.
5. New instance MUST be semantically equivalent to predecessor.
6. Original instance MUST NOT be removed from pool.
7. Instance chain index MUST be updated.

### 7.3 Validation Rules

A chain is valid iff:
1. All elements share the same type ID.
2. Linear sequence, no cycles.
3. Tail has `predecessor: null`.
4. All elements present in pool.
5. Content hashes match actual content.

### 7.4 Selection Strategies

| Strategy | Algorithm |
|----------|-----------|
| `latest` | Chain head (O(1) via index) |
| `original` | Walk to tail (O(n)) |
| `by-representation` | First match from head |
| `by-kind` | First kind match from head |
| `custom` | Caller predicate |

Strategies compose with fallback: e.g., prefer `zk-proof`, fall back to `consolidated-proof`, fall back to `latest`.

---

## 8. Deconstruction Rules

### 8.1 Input

Self-contained token in ITokenJson or TxfToken format.

### 8.2 Field Decomposition Table

| ITokenJson Field | Becomes Element? | UXF Type | Notes |
|-----------------|------------------|----------|-------|
| `genesis` | yes | GenesisTransaction | Sub-DAG root |
| `genesis.data` | yes | MintTransactionData | |
| `genesis.data.tokenId` | no (inline) | -- | Copied to MintTransactionData and TokenRoot |
| `genesis.data.tokenType` | no (inline) | -- | Copied to MintTransactionData and TokenRoot |
| `genesis.data.coinData` | yes | TokenCoinData | Shared element |
| `genesis.data.tokenData` | no (inline) | -- | In MintTransactionData |
| `genesis.data.salt` | no (inline) | -- | In MintTransactionData |
| `genesis.data.recipient` | no (inline) | -- | In MintTransactionData |
| `genesis.data.recipientDataHash` | no (inline) | -- | In MintTransactionData |
| `genesis.data.reason` | no (inline) | -- | In MintTransactionData |
| `genesis.inclusionProof` | yes | InclusionProof | Sub-DAG root |
| `genesis.inclusionProof.authenticator` | yes | Authenticator | |
| `genesis.inclusionProof.merkleTreePath` | yes | SmtPath | Sub-DAG |
| `genesis.inclusionProof.merkleTreePath.root` | no (inline) | -- | In SmtPath |
| `genesis.inclusionProof.merkleTreePath.steps[]` | yes (each) | SmtPathSegment | One per step |
| `genesis.inclusionProof.transactionHash` | no (inline) | -- | In InclusionProof |
| `genesis.inclusionProof.unicityCertificate` | yes | UnicityCertificate | Major dedup target |
| genesis destination state | yes | TokenState | Derived |
| `transactions[]` | yes (each) | TransferTransaction | |
| `transactions[n].inclusionProof` | yes | InclusionProof | null if uncommitted |
| `transactions[n].predicate` | -> TokenState | -- | Part of destination state |
| `transactions[n].data` | yes | TransferTransactionData | If present |
| `state` | yes | TokenState | Current state |
| `state.predicate` | yes | Predicate | Extracted |
| `state.data` | no (inline) | -- | In TokenState |
| `nametags[]` | yes (each) | TokenRoot | Full recursive deconstruction |
| `version` | no | -- | Captured in header semantics |
| `_integrity` | no | -- | TXF-only; not stored |

### 8.3 Decomposition Depth

Fully recursive. Terminates at leaf data. Typical depth:

```
Level 0: TokenRoot
Level 1: GenesisTransaction, TransferTransaction[], TokenState, TokenCoinData, TokenRoot[] (nametags)
Level 2: MintTransactionData, InclusionProof, TokenState, TransferTransactionData, Predicate
Level 3: Authenticator, SmtPath, UnicityCertificate, TokenCoinData, Predicate
Level 4: SmtPathSegment[]
```

### 8.4 Algorithm

```
function deconstruct(token, pool) -> content-hash:
    coinDataHash = deconstructCoinData(token.genesis.data.coinData, pool)
    genesisHash = deconstructGenesis(token.genesis, coinDataHash, pool)
    txHashes = []
    prevState = genesis.destinationState
    for tx in token.transactions:
        txHash = deconstructTransaction(tx, prevState, pool)
        txHashes.push(txHash)
        prevState = tx.destinationState
    currentStateHash = deconstructTokenState(token.state, pool)
    nametagHashes = [deconstruct(nt, pool) for nt in token.nametags]
    root = TokenRoot { header, tokenId, tokenType, genesis: genesisHash,
                       transactions: txHashes, state: currentStateHash,
                       nametags: nametagHashes, coinData: coinDataHash }
    hash = SHA-256(canonicalCbor(root))
    pool.putIfAbsent(hash, root)
    return hash
```

Deduplication: before inserting any element, check if its content hash already exists in the pool. If so, return the existing hash.

---

## 9. Reassembly Rules

### 9.1 Traversal

Depth-first from root, resolving child references through the pool and applying instance selection.

```
function reassemble(pool, rootHash, strategy) -> ITokenJson:
    root = resolve(pool, rootHash, strategy)
    genesis = reassembleGenesis(pool, root.genesis, strategy)
    transactions = [reassembleTx(pool, h, strategy) for h in root.transactions]
    state = reassembleState(pool, root.state, strategy)
    nametags = [reassemble(pool, h, strategy) for h in (root.nametags or [])]
    return { version: "2.0", genesis, transactions, state, nametags }
```

### 9.2 Instance Selection

```
function resolve(pool, hash, strategy) -> Element:
    if pool.instanceChainIndex.has(hash):
        entry = pool.instanceChainIndex[hash]
        return pool[strategy.select(pool, hash, entry)]
    return pool[hash]
```

### 9.3 Historical State Reassembly

To reassemble at state N (N=0 after genesis):
- Include genesis always.
- Include first N transactions.
- State = destination state of transaction N (or genesis destination if N=0).
- Nametags included in full.

### 9.4 Completeness Guarantee

Reassembled tokens MUST:
1. Pass same validation as original ITokenJson.
2. Produce same state hashes at every point.
3. Be importable by existing SDK (`Token.fromJson()`).
4. Contain no UXF-internal structures.

---

## 10. Worked Examples

### 10.1 Simple Fungible Token (1 Genesis + 2 Transfers)

A UCT token minted to Alice, transferred to Bob, then to Carol.

**Element pool after deconstruction (28 elements):**

```
[H_coindata]     TokenCoinData         coins: [["UCT", "1000000"]]
[H_pred_alice]   Predicate             type: "unmasked", publicKey: 02alice...
[H_pred_bob]     Predicate             type: "unmasked", publicKey: 02bob...
[H_pred_carol]   Predicate             type: "unmasked", publicKey: 02carol...
[H_state_0]      TokenState            predicate: H_pred_alice, data: ""
[H_state_1]      TokenState            predicate: H_pred_bob, data: ""
[H_state_2]      TokenState            predicate: H_pred_carol, data: ""
[H_mintdata]     MintTransactionData   tokenId, tokenType, coinData: H_coindata, salt, recipient...
[H_seg_0A]       SmtPathSegment        genesis proof step 0 (unique)
[H_seg_1_shared] SmtPathSegment        step 1 (SHARED by all 3 proofs)
[H_seg_2_shared] SmtPathSegment        step 2 (SHARED by all 3 proofs)
[H_seg_0B]       SmtPathSegment        transfer 1 step 0 (unique)
[H_seg_0C]       SmtPathSegment        transfer 2 step 0 (unique)
[H_smtpath_gen]  SmtPath               segments: [H_seg_0A, H_seg_1_shared, H_seg_2_shared]
[H_smtpath_tx1]  SmtPath               segments: [H_seg_0B, H_seg_1_shared, H_seg_2_shared]
[H_smtpath_tx2]  SmtPath               segments: [H_seg_0C, H_seg_1_shared, H_seg_2_shared]
[H_auth_gen]     Authenticator         algorithm, publicKey: alice, signature, stateHash
[H_auth_tx1]     Authenticator         algorithm, publicKey: alice, signature, stateHash
[H_auth_tx2]     Authenticator         algorithm, publicKey: bob, signature, stateHash
[H_cert_100]     UnicityCertificate    round 100
[H_cert_200]     UnicityCertificate    round 200
[H_cert_300]     UnicityCertificate    round 300
[H_proof_gen]    InclusionProof        auth: H_auth_gen, path: H_smtpath_gen, cert: H_cert_100
[H_proof_tx1]    InclusionProof        auth: H_auth_tx1, path: H_smtpath_tx1, cert: H_cert_200
[H_proof_tx2]    InclusionProof        auth: H_auth_tx2, path: H_smtpath_tx2, cert: H_cert_300
[H_txdata_1]     TransferTransactionData  recipient: bob, salt: ...
[H_txdata_2]     TransferTransactionData  recipient: carol, salt: ...
[H_genesis]      GenesisTransaction    data: H_mintdata, proof: H_proof_gen, dest: H_state_0
[H_tx1]          TransferTransaction   src: H_state_0, data: H_txdata_1, proof: H_proof_tx1, dest: H_state_1
[H_tx2]          TransferTransaction   src: H_state_1, data: H_txdata_2, proof: H_proof_tx2, dest: H_state_2
[H_root]         TokenRoot             genesis: H_genesis, transactions: [H_tx1, H_tx2], state: H_state_2
```

**Deduplication:** `H_seg_1_shared` and `H_seg_2_shared` are stored once, referenced 3x each.

**Manifest:** `{ "aaaa1111...": H_root }`

### 10.2 Two Tokens Sharing a Unicity Certificate

Tokens A and B both transferred in aggregator round 200.

```
H_cert_200 (UnicityCertificate)  -- stored ONCE, referenced by:
  H_proofA_tx1.unicityCertificate = H_cert_200
  H_proofB_tx1.unicityCertificate = H_cert_200

H_seg_shared_1 (SmtPathSegment) -- upper tree level, stored ONCE, referenced by:
  H_smtpathA_tx1.segments[1] = H_seg_shared_1
  H_smtpathB_tx1.segments[1] = H_seg_shared_1

H_seg_shared_2 (SmtPathSegment) -- upper tree level, stored ONCE, referenced by:
  H_smtpathA_tx1.segments[2] = H_seg_shared_2
  H_smtpathB_tx1.segments[2] = H_seg_shared_2
```

Without UXF: 4 certificates, 6 SMT segments. With UXF: 3 certificates, 4 segments.

### 10.3 Instance Chain: Proof Consolidation

Token with 3 individual proofs consolidated into compact form.

**Before:**
```
Pool: H_proof_0 (default), H_proof_1 (default), H_proof_2 (default)
Index: empty
```

**After consolidation:**
```
Pool additions:
  H_consol_0 (kind: "consolidated-proof", predecessor: H_proof_0)
  H_consol_1 (kind: "consolidated-proof", predecessor: H_proof_1)
  H_consol_2 (kind: "consolidated-proof", predecessor: H_proof_2)

Index:
  H_proof_0 -> { head: H_consol_0, kind: "consolidated-proof", length: 2 }
  H_proof_1 -> { head: H_consol_1, kind: "consolidated-proof", length: 2 }
  H_proof_2 -> { head: H_consol_2, kind: "consolidated-proof", length: 2 }
```

**Reassembly with strategy=latest:** Uses consolidated proofs (smaller).
**Reassembly with strategy=original:** Uses individual proofs (full detail).
Both produce valid, semantically equivalent tokens.

---

## Appendix A: Complete CDDL Schema

```cddl
; UXF v1.0.0 Complete Schema (RFC 8610)

content-hash = bstr .size 32
nullable-ref = content-hash / null
token-id = bstr .size 32
token-type = bstr .size 32

element-header = [uint, uint, tstr, content-hash / null]

uxf-package = {
  magic: bstr .size 8,
  metadata: { version: tstr, createdAt: uint, updatedAt: uint,
              ? creator: tstr, ? description: tstr,
              elementCount: uint, tokenCount: uint },
  manifest: { * token-id => content-hash },
  instanceChainIndex: { * content-hash => { head: content-hash, kind: tstr, length: uint } },
  ? indexes: { ? byTokenType: { * token-type => [+ token-id] },
               ? byStateHash: { * content-hash => [+ token-id] } },
  elements: { * content-hash => element }
}

element = #6.786433([element-header, bstr, bstr, content-hash, [*content-hash], content-hash, [*content-hash]/null, content-hash])
        / #6.786434([element-header, content-hash, content-hash, content-hash])
        / #6.786435([element-header, content-hash, nullable-ref, nullable-ref, content-hash])
        / #6.786436([element-header, bstr, bstr, content-hash, bstr, bstr, tstr, bstr/null, tstr/null])
        / #6.786437([element-header, tstr, bstr, bstr/null, {*tstr=>any}/null])
        / #6.786438([element-header, content-hash, bstr])
        / #6.786439([element-header, tstr, bstr/null, bstr/null, tstr, tstr, bstr/null])
        / #6.786440([element-header, content-hash, content-hash, bstr, content-hash])
        / #6.786441([element-header, tstr, bstr, bstr, bstr])
        / #6.786442([element-header, bstr])
        / #6.786443([element-header, bstr, bstr])
        / #6.786444([element-header, [*[tstr,tstr]]])
        / #6.786445([element-header, bstr, [*content-hash]])
```

## Appendix B: Element Type Quick Reference

| ID | Name | Tag | Fields | Child Refs | Mutable |
|----|------|-----|--------|------------|---------|
| 0x01 | TokenRoot | 786433 | 8 | 5 | yes |
| 0x02 | GenesisTransaction | 786434 | 4 | 3 | no |
| 0x03 | TransferTransaction | 786435 | 5 | 4 | no |
| 0x04 | MintTransactionData | 786436 | 9 | 1 | no |
| 0x05 | TransferTransactionData | 786437 | 5 | 0 | no |
| 0x06 | TokenState | 786438 | 3 | 1 | no |
| 0x07 | Predicate | 786439 | 7 | 0 | no |
| 0x08 | InclusionProof | 786440 | 5 | 3 | yes |
| 0x09 | Authenticator | 786441 | 5 | 0 | no |
| 0x0A | UnicityCertificate | 786442 | 2 | 0 | no |
| 0x0B | SmtPathSegment | 786443 | 3 | 0 | no |
| 0x0C | TokenCoinData | 786444 | 2 | 0 | no |
| 0x0D | SmtPath | 786445 | 3 | 1 | yes |

## Appendix C: Glossary

| Term | Definition |
|------|------------|
| **Aggregator** | L3 service building SMTs from state transition commitments |
| **BFT** | Byzantine Fault Tolerance; L2 consensus signing round commitments |
| **CAR** | Content Addressable aRchive; IPFS serialization format |
| **CBOR** | Concise Binary Object Representation (RFC 8949) |
| **CDDL** | Concise Data Definition Language (RFC 8610) |
| **CID** | Content Identifier; IPFS self-describing address |
| **DAG** | Directed Acyclic Graph |
| **IPLD** | InterPlanetary Linked Data |
| **IPNS** | InterPlanetary Name System; mutable pointers to IPFS content |
| **ITokenJson** | Canonical self-contained JSON token format (state-transition-sdk v2.0) |
| **Nametag** | Human-readable alias (e.g., @alice) represented as a token |
| **Predicate** | Cryptographic ownership condition |
| **secp256k1** | Elliptic curve used for all Unicity cryptographic operations |
| **SMT** | Sparse Merkle Tree |
| **TXF** | Token eXchange Format; sphere-sdk wallet storage format |
| **Unicity Certificate** | BFT-signed attestation of an aggregator round commitment |

## Appendix D: Revision History

| Version | Date | Description |
|---------|------|-------------|
| 1.0.0-draft | 2026-03-26 | Initial draft specification |

