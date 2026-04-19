# UXF Domain-Specific Implementation Constraints

**Status:** Implementation guide for UXF deconstruction/reassembly
**Date:** 2026-03-26

This document captures every domain-specific constraint and pitfall that a generic TypeScript developer would miss when implementing UXF token decomposition and reassembly. It is derived from direct examination of the SDK type definitions, sphere-sdk serialization code, and the UXF specification.

---

## 1. ITokenJson Field Mapping to UXF Elements

### 1.1 Canonical Input Type: ITokenJson

The canonical input is `ITokenJson` from `@unicitylabs/state-transition-sdk` (see Decision 1 in DESIGN-DECISIONS.md). Its structure is:

```typescript
interface ITokenJson {
  version: string;                        // "2.0"
  state: ITokenStateJson;                 // current ownership state
  genesis: IMintTransactionJson;          // mint transaction
  transactions: ITransferTransactionJson[];  // transfer history
  nametags: ITokenJson[];                 // recursive nametag tokens
}
```

**CRITICAL: ITokenJson vs TxfToken structural divergence.** The sphere-sdk `TxfToken` type describes a **different shape** for transfer transactions. In `ITokenJson` (SDK), transfers have `{ data: ITransferTransactionDataJson, inclusionProof }` where `data` contains `sourceState`, `recipient`, `salt`, etc. In `TxfToken` (sphere-sdk), transfers have `{ previousStateHash, newStateHash, predicate, inclusionProof }`. These are structurally incompatible. The `normalizeSdkTokenToStorage()` function casts between them via duck typing (`structuredClone` + `as any`). The UXF adapter must handle both shapes.

### 1.2 Element-by-Element Field Mapping

#### TokenRoot (0x01)

| UXF Field | Source Path | Type Transformation | Edge Cases |
|-----------|------------|---------------------|------------|
| `tokenId` | `genesis.data.tokenId` | hex string -> `Uint8Array(32)` | Always 64-char hex. Never null. |
| `version` | `version` | string, keep as-is | Always `"2.0"` in production. Must round-trip exactly. |
| `genesis` | `genesis` | Deconstruct to GenesisTransaction element, store content hash | Always present. |
| `transactions` | `transactions` | Array of TransferTransaction content hashes | May be empty `[]`. Never null or undefined. |
| `state` | `state` | Deconstruct to TokenState element, store content hash | Always present. |
| `nametags` | `nametags` | Array of TokenRoot content hashes (recursive) | **May be `[]`, `undefined`, or contain full `ITokenJson` objects.** In TxfToken format, may be `string[]` (nametag names only, not token objects). |

**Nametag pitfall:** When ingesting `TxfToken`, `nametags` is `string[]` (just names like `["alice"]`). When ingesting `ITokenJson`, `nametags` is `ITokenJson[]` (full recursive tokens). The adapter must detect which format it is. String nametags cannot be deconstructed into token sub-DAGs -- they carry no token data. The adapter must either:
- Reject string nametags and require the caller to provide full nametag tokens separately, or
- Accept string nametags but store them as a lightweight metadata annotation (not as TokenRoot elements), with a warning that nametag deduplication is not possible.

#### GenesisTransaction (0x02)

| UXF Field | Source Path | Type Transformation | Edge Cases |
|-----------|------------|---------------------|------------|
| `data` | `genesis.data` | Deconstruct to MintTransactionData, store content hash | Always present. |
| `inclusionProof` | `genesis.inclusionProof` | Deconstruct to InclusionProof, store content hash | Always present for valid tokens. In ITokenJson, the SDK requires it. **However**, tokens with `{ _pendingFinalization }` or `{ _placeholder: true }` in `sdkData` have no valid genesis proof -- these must be rejected by the ingestion layer. |
| `destinationState` | **DERIVED** (see Section 3) | Deconstruct to TokenState, store content hash | Not directly available in ITokenJson. Must be derived. |

#### MintTransactionData (0x04)

| UXF Field | Source Path | Type Transformation | Edge Cases |
|-----------|------------|---------------------|------------|
| `tokenId` | `genesis.data.tokenId` | hex string -> `Uint8Array(32)` | Always 64-char hex. |
| `tokenType` | `genesis.data.tokenType` | hex string -> `Uint8Array(32)` | Always 64-char hex. Nametag tokens use type `f8aa13834268d29355ff12183066f0cb902003629bbc5eb9ef0efbe397867509`. |
| `coinData` | `genesis.data.coinData` | `[string, string][]` -> keep as array of `[text, text]` | In ITokenJson: `TokenCoinDataJson = [string, string][]`. May be `null` in the SDK type (`IMintTransactionDataJson.coinData: TokenCoinDataJson | null`). Nametag tokens have `coinData: []` (empty array) or `null`. For CBOR encoding, `null` should be stored as empty array `[]`. |
| `tokenData` | `genesis.data.tokenData` | `string | null` -> `Uint8Array` (empty if null) | For fungible tokens: usually `""` or `null`. For nametag tokens: contains the nametag string data. Must handle both null and empty string as empty bytes. |
| `salt` | `genesis.data.salt` | hex string -> `Uint8Array(32)` | Always 64-char hex. Never null. |
| `recipient` | `genesis.data.recipient` | string, keep as text | `"DIRECT://..."` format (~80 chars). Never null. |
| `recipientDataHash` | `genesis.data.recipientDataHash` | hex string -> `Uint8Array(32)` or `null` | Usually `null`. When present, 64-char hex. |
| `reason` | `genesis.data.reason` | complex object or `null` | **THIS IS THE SPLIT TOKEN PITFALL.** See Section 5.3. For regular mints: `null`. For split tokens: `ISplitMintReasonJson` -- a complex nested object containing a full `ITokenJson` parent token plus proofs. The spec says `text / null` but this is wrong for split tokens. See detailed analysis below. |

#### TransferTransaction (0x03)

| UXF Field | Source Path (ITokenJson) | Source Path (TxfToken) | Edge Cases |
|-----------|-------------------------|----------------------|------------|
| `sourceState` | `transactions[n].data.sourceState` | **DERIVED** from `previousStateHash` | In ITokenJson: `sourceState: ITokenStateJson` is inline. In TxfToken: only `previousStateHash: string` (a hash, not the actual state). See Section 3.2. |
| `data` | `transactions[n].data` (extract recipient, salt, etc.) | `transactions[n].data` (optional `Record<string, unknown>`) | **In ITokenJson format:** `data` contains `sourceState`, `recipient`, `salt`, `recipientDataHash`, `message`, `nametags`. These must be decomposed. **In TxfToken format:** `data` is an optional opaque record, and the predicate is at top level. |
| `inclusionProof` | `transactions[n].inclusionProof` | `transactions[n].inclusionProof` | `null` for uncommitted/pending transactions. Must store as `null` child reference. |
| `destinationState` | **DERIVED** | **DERIVED** | See Section 3.2. |

**CRITICAL structural divergence for transfers:**

In `ITransferTransactionJson` (SDK canonical):
```typescript
{
  data: {
    sourceState: { predicate: string, data: string | null },
    recipient: string,
    salt: string,
    recipientDataHash: string | null,
    message: string | null,
    nametags: ITokenJson[]
  },
  inclusionProof: IInclusionProofJson
}
```

In `TxfTransaction` (sphere-sdk storage):
```typescript
{
  previousStateHash: string,   // hash of source state
  newStateHash?: string,       // hash of destination state (derived, optional)
  predicate: string,           // hex CBOR predicate of destination state
  inclusionProof: TxfInclusionProof | null,
  data?: Record<string, unknown>  // optional extra data
}
```

**The UXF deconstruction layer MUST detect which format a transfer transaction is in.** Detection strategy:
- If `tx.data?.sourceState` exists -> ITokenJson format
- If `tx.previousStateHash` exists -> TxfToken format
- Both may be present (duck-typed cast)

#### TransferTransactionData (0x05)

| UXF Field | Source Path (ITokenJson) | Type Transformation | Edge Cases |
|-----------|-------------------------|---------------------|------------|
| `recipient` | `transactions[n].data.recipient` | string, keep as text | Always present in ITokenJson format. |
| `salt` | `transactions[n].data.salt` | hex string -> `Uint8Array(32)` | Always present. |
| `recipientDataHash` | `transactions[n].data.recipientDataHash` | hex string -> `Uint8Array(32)` or `null` | Usually null. |
| `extraData` | n/a | `null` | The `message` field from `ITransferTransactionDataJson` could map here, but it's `string | null` in the SDK, not a key-value map. The `nametags` from `ITransferTransactionDataJson` are handled separately (as child TokenRoot refs on the parent token). |

**Nametags in transfer data:** `ITransferTransactionDataJson.nametags` is `ITokenJson[]` -- nametag tokens embedded in transfer data. These are the same nametags that appear in the top-level `ITokenJson.nametags`. UXF deduplicates them as shared TokenRoot elements. During deconstruction, extract nametags from transfer data and deduplicate with the top-level nametags array.

**Message field:** `ITransferTransactionDataJson.message` is `string | null`. This field is not captured by the current UXF `TransferTransactionData` spec which has `extraData: map / null`. Implementation should store message as `{ "message": "<value>" }` in extraData, or the spec should add an explicit `message` field.

#### TokenState (0x06)

| UXF Field | Source Path | Type Transformation | Edge Cases |
|-----------|------------|---------------------|------------|
| `predicate` | `state.predicate` or `transactions[n].data.sourceState.predicate` | hex string -> `Uint8Array` (opaque CBOR bytes) | Always present. Variable length (~340-400 hex chars). Keep as opaque bytes -- do NOT decode the CBOR predicate structure. |
| `data` | `state.data` or `transactions[n].data.sourceState.data` | `string | null` -> `Uint8Array` (empty if null/empty string) | Usually `null` or `""` for fungible tokens. Treat both as empty `Uint8Array(0)`. |

#### InclusionProof (0x08)

| UXF Field | Source Path | Type Transformation | Edge Cases |
|-----------|------------|---------------------|------------|
| `authenticator` | `inclusionProof.authenticator` | Deconstruct to Authenticator element, store content hash | **Can be `null` in `IInclusionProofJson`.** The SDK type says `authenticator: IAuthenticatorJson | null`. When null, store null child reference. |
| `merkleTreePath` | `inclusionProof.merkleTreePath` | Deconstruct to SmtPath element, store content hash | Always present when proof exists. |
| `transactionHash` | `inclusionProof.transactionHash` | hex string -> `Uint8Array(32)` | **Can be `null` in `IInclusionProofJson`.** The SDK type says `transactionHash: string | null`. When authenticator is null, transactionHash is also null (they are coupled). |
| `unicityCertificate` | `inclusionProof.unicityCertificate` | hex string -> `Uint8Array` (opaque CBOR, decoded from hex) | **Primary dedup target.** See Section 2.2. |

#### Authenticator (0x09)

| UXF Field | Source Path | Type Transformation | Edge Cases |
|-----------|------------|---------------------|------------|
| `algorithm` | `authenticator.algorithm` | string, keep as text | Always `"secp256k1"`. |
| `publicKey` | `authenticator.publicKey` | hex string -> `Uint8Array(33)` | 66-char hex (33 bytes compressed secp256k1). |
| `signature` | `authenticator.signature` | hex string -> `Uint8Array` | Variable length (~140-144 hex chars). DER-encoded ECDSA. Length varies (70-72 bytes). |
| `stateHash` | `authenticator.stateHash` | hex string -> `Uint8Array(32)` | 64-char hex. Always present. |

#### UnicityCertificate (0x0A)

| UXF Field | Source Path | Type Transformation | Edge Cases |
|-----------|------------|---------------------|------------|
| `rawCbor` | `inclusionProof.unicityCertificate` | hex string -> `Uint8Array` | See Section 2.2 for detailed treatment. |

#### SmtPath (0x0D)

| UXF Field | Source Path | Type Transformation | Edge Cases |
|-----------|------------|---------------------|------------|
| `root` | `merkleTreePath.root` | hex string -> `Uint8Array(32)` | 64-char hex. Always present. |
| `segments` | `merkleTreePath.steps` | `Array<{data: string, path: string}>` -> `Array<[Uint8Array, Uint8Array]>` | **`data` can be `null`** in `ISparseMerkleTreePathStepJson`. The SDK type says `data: string | null`. Null data represents an empty subtree node. **`path` is a string representation of a bigint** -- a bit string indicating L/R direction. It is NOT hex. See Section 2.3. |

---

## 2. Hex and Binary Conversion Rules

### 2.1 General Rule

The SDK stores all binary data as hex strings. UXF elements encoded in CBOR store binary data as `Uint8Array` (CBOR bstr). The conversion is:

```typescript
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}
```

### 2.2 UnicityCertificate: Hex-Encoded CBOR Treatment

The `unicityCertificate` field in `IInclusionProofJson` is a hex string encoding CBOR bytes. These CBOR bytes contain a tagged structure (tag 1007) with sub-structures (tags 1001, 1008).

**Decision:** Store as **opaque bytes** in UXF. The `UnicityCertificate` element's `rawCbor` field contains the decoded bytes (hex -> Uint8Array). Do NOT attempt to decode/re-encode the internal CBOR structure. Reasons:
1. The certificate is produced and signed by the BFT layer -- its internal structure is immutable.
2. Preserving exact bytes is essential for content hash stability.
3. The certificate is the primary deduplication target: byte-level identity determines dedup.

**Conversion:**
```
Storage:   "a4d907ef..." (hex string in ITokenJson)
UXF CBOR:  bstr(0xa4, 0xd9, 0x07, 0xef, ...) (raw bytes)
Reassembly: convert back to hex string
```

**Round-trip invariant:** `bytesToHex(hexToBytes(original)) === original.toLowerCase()`. Ensure hex is lowercased before storage to guarantee deterministic content hashes.

### 2.3 SmtPath `path` Field: NOT Hex

The `path` field in `ISparseMerkleTreePathStepJson` is a **string representation of a bigint**, NOT a hex string. It represents a bit pattern for the L/R direction in the SMT.

Example values: `"0"`, `"1"`, `"340282366920938463463374607431768211456"`.

In the SDK, `SparseMerkleTreePathStep.path` is a `bigint`. The JSON form is its decimal string representation via `bigint.toString()`.

**For UXF CBOR encoding:** Store as bytes (`Uint8Array`). The `path` value must be converted from its string representation to bytes. Use the string's UTF-8 encoding to preserve the exact value. Alternatively, treat as a CBOR bigint/bignum. The simplest correct approach is to store the `[data, path]` tuple as `[bstr, bstr]` where `path` bytes are the UTF-8 encoding of the decimal string, since the spec says `segments: array<[bytes, bytes]>`.

**PITFALL:** If you interpret `path` as hex and call `hexToBytes()`, you will corrupt the data. The string `"1"` is the number 1, not the byte `0x01`.

**Recommendation:** Store `path` as a CBOR unsigned integer or bignum. If the value exceeds CBOR's native integer range (which it can -- SMT paths can be up to 2^256), use CBOR tag 2 (positive bignum) with the byte representation of the bigint. This is the most space-efficient and semantically correct encoding:

```typescript
// Convert path string to bigint, then to CBOR bignum bytes
const pathBigint = BigInt(pathString);
const pathBytes = bigintToBytes(pathBigint); // big-endian, minimal encoding
```

### 2.4 Fields That Stay as Strings

| Field | Why String | CBOR Type |
|-------|-----------|-----------|
| `version` | Semantic version string | `tstr` |
| `recipient` | Address format (`DIRECT://...`) | `tstr` |
| `algorithm` | Algorithm name (`"secp256k1"`) | `tstr` |
| `coinData[n][0]` | Coin ID (hex string kept as text for portability) | `tstr` |
| `coinData[n][1]` | Amount (decimal string for arbitrary precision) | `tstr` |
| `reason` | Reason string or null | `tstr / null` |
| `kind` | Instance kind label | `tstr` |

### 2.5 Fields That Become Bytes

| Field | Source Format | CBOR Type | Length |
|-------|-------------|-----------|--------|
| `tokenId` | 64-char hex | `bstr .size 32` | Fixed 32 |
| `tokenType` | 64-char hex | `bstr .size 32` | Fixed 32 |
| `salt` | 64-char hex | `bstr .size 32` | Fixed 32 |
| `publicKey` | 66-char hex | `bstr .size 33` | Fixed 33 |
| `signature` | ~140-144 char hex | `bstr` | Variable 70-72 |
| `stateHash` | 64-char hex | `bstr .size 32` | Fixed 32 |
| `transactionHash` | 64-char hex | `bstr .size 32` | Fixed 32 |
| `root` (SmtPath) | 64-char hex | `bstr .size 32` | Fixed 32 |
| `predicate` (TokenState) | variable hex | `bstr` | Variable ~170-200 |
| `data` (TokenState) | hex string or null | `bstr` | Variable, usually 0 |
| `tokenData` | hex string or null | `bstr` | Variable |
| `recipientDataHash` | 64-char hex or null | `bstr .size 32 / null` | Fixed 32 or null |
| `rawCbor` (UnicityCertificate) | hex string | `bstr` | Variable ~500-2000 |
| `segments[n].data` (SmtPath) | 64-char hex or null | `bstr / null` | 32 or null |

### 2.6 Normalization Before Hashing

The SDK's `normalizeToHex()` function handles three input shapes:
1. Hex string -> pass through
2. `{ bytes: Uint8Array | number[] }` -> convert to hex
3. `{ type: "Buffer", data: number[] }` -> convert to hex

When ingesting tokens, call `normalizeSdkTokenToStorage()` first to ensure all byte fields are hex strings, then convert hex to `Uint8Array` for CBOR encoding. This two-step normalization ensures consistent content hashes regardless of input format.

---

## 3. State Derivation

### 3.1 Genesis Destination State

The genesis destination state is the token's state immediately after minting. It is **not an explicit field** in `ITokenJson`. It must be derived.

**Derivation rule for ITokenJson format:**

If the token has zero transfer transactions, the genesis destination state IS the current `state`:
```
genesis.destinationState = token.state
```

If the token has transfer transactions, the genesis destination state is the `sourceState` of the FIRST transfer transaction:
```
genesis.destinationState = token.transactions[0].data.sourceState
```

**Derivation rule for TxfToken format:**

TxfToken does not carry `sourceState` inline -- it only has `previousStateHash`. To derive the actual TokenState for the genesis destination:
- If zero transactions: `genesis.destinationState = token.state`
- If transactions exist: the genesis destination state CANNOT be derived from TxfToken alone (only its hash is available as `transactions[0].previousStateHash`). This is why ITokenJson is the canonical input -- it carries the full sourceState.

**PITFALL:** If the input is TxfToken with transactions, you cannot construct the genesis destinationState TokenState element. The adapter from TxfToken to ITokenJson must either:
1. Re-parse the token through `SdkToken.fromJSON()` which reconstructs the full state chain, or
2. Store a hash-only reference and mark the element as unresolvable.

### 3.2 Transfer Transaction Source and Destination States

For each transfer transaction `transactions[n]`:

**sourceState (where the token was before this transition):**
- `n == 0`: sourceState = genesis destination state (see 3.1)
- `n > 0`: sourceState = destination state of `transactions[n-1]`

In ITokenJson: `transactions[n].data.sourceState` is available inline.
In TxfToken: only `transactions[n].previousStateHash` is available.

**destinationState (where the token is after this transition):**
- Not directly stored in either format.
- If `n < transactions.length - 1`: destinationState = `transactions[n+1].data.sourceState` (in ITokenJson)
- If `n == transactions.length - 1` (last transaction): destinationState = `token.state` (current state)

**Algorithm for ITokenJson:**
```typescript
function deriveTransactionStates(token: ITokenJson) {
  const states: ITokenStateJson[] = [];
  
  // Genesis destination state
  if (token.transactions.length > 0) {
    states.push(token.transactions[0].data.sourceState);
  } else {
    states.push(token.state);
  }
  
  // Transfer destination states
  for (let i = 0; i < token.transactions.length; i++) {
    if (i < token.transactions.length - 1) {
      states.push(token.transactions[i + 1].data.sourceState);
    } else {
      states.push(token.state); // last tx destination = current state
    }
  }
  
  return states; // states[0] = genesis dest, states[n+1] = tx[n] dest
}
```

### 3.3 State Hash vs Content Hash

**Two different hash functions operate on TokenState:**

1. **SDK state hash:** Computed by `TokenState.calculateHash()` in the SDK. Used in authenticator `stateHash`, in `previousStateHash`/`newStateHash` TXF fields, and for `RequestId` derivation. This is a protocol-level hash with SDK-specific serialization.

2. **UXF content hash:** `SHA-256(canonical_cbor(TokenState_element))`. Used for content addressing in the element pool and child references.

These hashes are **completely different values** for the same logical state. Do not confuse them.

The `authenticator.stateHash` stores the SDK state hash, NOT the UXF content hash. During reassembly, the SDK state hash is preserved verbatim in the authenticator element. The UXF content hash is used only for pool addressing.

---

## 4. Nametag Token Handling

### 4.1 ITokenJson Nametag Structure

In `ITokenJson`, `nametags` is `ITokenJson[]` -- each nametag is a complete recursive token:

```json
{
  "version": "2.0",
  "state": { "predicate": "<hex>", "data": null },
  "genesis": {
    "data": {
      "tokenId": "<64 hex>",
      "tokenType": "f8aa13834268d29355ff12183066f0cb902003629bbc5eb9ef0efbe397867509",
      "coinData": [],
      "tokenData": "<nametag string, e.g. hex of 'alice'>",
      "salt": "<64 hex>",
      "recipient": "DIRECT://...",
      "recipientDataHash": null,
      "reason": null
    },
    "inclusionProof": { /* full proof */ }
  },
  "transactions": [],
  "nametags": []
}
```

Key characteristics:
- `tokenType` is always `f8aa1383...7509` (the nametag token type constant)
- `coinData` is always `[]` (empty) or `null`
- `transactions` is always `[]` (nametags are never transferred)
- `nametags` is always `[]` (no recursive nametags-of-nametags)
- `tokenData` contains the nametag name as data

### 4.2 TxfToken Nametag Structure

In `TxfToken`, `nametags` is `string[] | undefined` -- just the names:

```json
{
  "nametags": ["alice", "bob"]
}
```

The actual nametag token data is stored separately in `TxfStorageData._nametag` / `_nametags` as `NametagData`:

```typescript
interface NametagData {
  name: string;           // "alice"
  token: object;          // The full ITokenJson nametag token
  timestamp: number;
  format: string;
  version: string;
}
```

### 4.3 Detection and Adapter Logic

To detect which format nametags are in:

```typescript
function isITokenJsonNametags(nametags: unknown): nametags is ITokenJson[] {
  return Array.isArray(nametags) && 
    nametags.length > 0 && 
    typeof nametags[0] === 'object' && 
    nametags[0] !== null &&
    'genesis' in nametags[0];
}

function isStringNametags(nametags: unknown): nametags is string[] {
  return Array.isArray(nametags) && 
    (nametags.length === 0 || typeof nametags[0] === 'string');
}
```

### 4.4 TxfToken Adapter Requirements

When ingesting from `TxfToken`:
1. Check if `nametags` is `string[]`. If so, resolve full nametag tokens from the `NametagData` storage.
2. The caller must provide the `NametagData[]` alongside the `TxfToken` for full nametag deduplication.
3. If nametag tokens are not available (string nametags only, no NametagData), the UXF package cannot deduplicate nametags. Store the string names as metadata in the TokenRoot element (not as child references).

### 4.5 Nametags in Transfer Transactions

`ITransferTransactionDataJson` also contains `nametags: ITokenJson[]`. These are nametag tokens that were included in the transfer data to prove the sender/recipient identity for PROXY address resolution.

**These are the same nametag tokens** that appear in the top-level `ITokenJson.nametags`. During deconstruction, all nametag tokens (from top-level and from transfer transaction data) should be pooled and deduplicated. The content hash ensures identical nametag tokens are stored only once.

**PITFALL:** When reassembling, the nametags must be placed back in BOTH locations:
- Top-level `ITokenJson.nametags`
- Inside each `ITransferTransactionDataJson.nametags` that originally contained them

The deconstruction must record which transfer transactions referenced which nametags. One approach: during deconstruction, the TransferTransactionData element's `extraData` field stores a `_nametagRefs` array of TokenRoot content hashes.

---

## 5. Edge Cases and Invariants

### 5.1 Pending/Uncommitted Transactions

A token may have the last transaction with `inclusionProof: null`. This means the state transition has been submitted but not yet confirmed by the aggregator.

**Impact on UXF:**
- The TransferTransaction element has `inclusionProof: null` (null child reference).
- No Authenticator, SmtPath, or UnicityCertificate elements are created for this transaction.
- The `data` child reference may also be null if the transfer data hasn't been finalized.
- The `destinationState` is still derivable (it's `token.state` if this is the last transaction).
- **During reassembly**, null inclusionProof must round-trip correctly. The reassembled `ITokenJson` must have `inclusionProof: null` in the corresponding `ITransferTransactionJson` (via null in the authenticator and transactionHash fields, with an empty/default merkleTreePath and unicityCertificate).

**WAIT -- ITransferTransactionJson does NOT support null inclusionProof.** Looking at the SDK types:

```typescript
interface ITransferTransactionJson {
  readonly data: ITransferTransactionDataJson;
  readonly inclusionProof: IInclusionProofJson;  // NOT nullable!
}
```

But `TxfTransaction` does:
```typescript
interface TxfTransaction {
  inclusionProof: TxfInclusionProof | null;  // nullable
}
```

**This means pending transactions exist in TxfToken format but NOT in valid ITokenJson format.** The SDK's `Token.fromJSON()` likely fails on null inclusionProof. Pending tokens should be handled by either:
1. Rejecting tokens with pending transactions at ingestion time (recommended for Phase 1).
2. Storing the pending transaction as a special-case element with all-null proof fields.

**Recommendation:** Phase 1 should reject tokens with `inclusionProof === null` in any transaction with a clear error message. These tokens are in-flight and not yet suitable for archival/exchange.

### 5.2 Placeholder and Pending Finalization Tokens

The sphere-sdk stores sentinel values in `sdkData`:
- `{ _placeholder: true }` -- Token slot reserved, no actual data
- `{ _pendingFinalization: { ... } }` -- Token awaiting V5 finalization

**These must be rejected by UXF ingestion.** They have no valid genesis data and cannot be deconstructed into a DAG.

Detection:
```typescript
function isPlaceholderOrPending(data: unknown): boolean {
  if (!data || typeof data !== 'object') return true;
  const obj = data as Record<string, unknown>;
  return !!obj._placeholder || !!obj._pendingFinalization;
}
```

### 5.3 Split Tokens (Mint with Reason)

When a token is split (for partial transfers), the resulting tokens have `genesis.data.reason` set to an `ISplitMintReasonJson` object:

```typescript
interface ISplitMintReasonJson {
  type: "TOKEN_SPLIT";
  token: ITokenJson;          // Full parent token that was split
  proofs: ISplitMintReasonProofJson[];  // Aggregation + coin tree proofs
}

interface ISplitMintReasonProofJson {
  coinId: string;
  aggregationPath: ISparseMerkleTreePathJson;     // Plain SMT path
  coinTreePath: ISparseMerkleSumTreePathJson;      // Sum SMT path (different type!)
}
```

**CRITICAL:** The `reason` field contains a full recursive `ITokenJson` parent token. This is another deduplication opportunity -- if multiple split tokens share the same parent, the parent token sub-DAG is stored once.

**The UXF spec says `reason: text / null`** which is INCORRECT for split tokens. The implementation must handle:
1. `null` -- regular mint, no reason
2. A string -- future use (the spec's text type)
3. An `ISplitMintReasonJson` object -- split token with embedded parent token and proofs

**For Phase 1:** Store the reason as opaque CBOR-encoded bytes. If it's an object (split reason), serialize it via dag-cbor and store as `bstr`. The parent token within the reason can optionally be recursively deconstructed for deduplication. This is a significant win: if a 100-token split creates 100 child tokens, each child embeds the same parent token in its reason field. Without dedup: 100 copies of parent. With dedup: 1 copy.

**SparseMerkleSumTreePath:** The split reason proofs use a **Sum Merkle Tree path**, not a plain one. This is a different type (`ISparseMerkleSumTreePathJson`) with different step structure. UXF does not define a SumSmtPath element type. For Phase 1, store these proofs as opaque bytes within the reason field.

### 5.4 Tokens with Zero Transactions

Common case: a freshly minted token that has never been transferred.

```
token.transactions = []
```

**Impact:**
- TokenRoot `transactions` field is empty array `[]`.
- Genesis destination state = `token.state` (current state).
- The token has exactly 1 inclusion proof (genesis).
- Element count: ~8-10 elements (TokenRoot, GenesisTransaction, MintTransactionData, InclusionProof, Authenticator, SmtPath, UnicityCertificate, TokenState x1-2).

### 5.5 Empty Nametags Array

Most tokens have `nametags: []`. This is the normal case for tokens transferred via DIRECT address (not PROXY).

**Impact:** TokenRoot `nametags` field is empty array `[]`. No nametag sub-DAGs are created. The CBOR encoding uses `0x80` (empty array), NOT null or omitted.

### 5.6 Maximum Realistic Sizes

| Metric | Typical | Maximum Observed |
|--------|---------|-----------------|
| Transactions per token | 0-5 | ~50 (heavily traded token) |
| Nametags per token | 0-2 | ~5 (multi-nametag user) |
| Elements per token | 8-35 | ~350 (50 txns * 7 elements each) |
| Tokens per wallet | 10-100 | ~1000 |
| Elements per package | 100-3500 | ~50,000 (1000 tokens) |
| Token JSON size | 6-18 KB | ~500 KB (50 txns, split token with reason) |
| Nametag token size | 5-8 KB | ~10 KB |
| Unicity certificate hex | 1-4 KB | ~8 KB (many validators) |
| SMT path steps | 10-40 | ~60 |

### 5.7 Hex String Case Sensitivity

The SDK uses **lowercase hex** throughout. The `normalizeToHex()` function produces lowercase. However, some SDK methods return mixed-case hex (e.g., `DataHash.toJSON()`).

**UXF MUST normalize all hex strings to lowercase before:**
1. Converting to bytes (for content hash stability)
2. Using as map keys (for dedup)
3. Storing in manifest or indexes

Failure to lowercase will cause identical binary content to produce different content hashes, breaking deduplication silently.

### 5.8 TxfToken `_integrity` Field

```typescript
interface TxfIntegrity {
  genesisDataJSONHash: string;
  currentStateHash?: string;
}
```

This is a TXF-only field for wallet-level integrity checking. It is NOT part of ITokenJson and MUST NOT be included in UXF elements. Ignore it during deconstruction. During reassembly back to TxfToken format (for sphere-sdk integration), it can be recomputed.

### 5.9 Authenticator and TransactionHash Coupling

In `IInclusionProofJson`:
- `authenticator: IAuthenticatorJson | null`
- `transactionHash: string | null`

These are **coupled**: both are null or both are non-null. The SDK enforces this in the `InclusionProof` constructor: "Error if authenticator and transactionHash are not both set or both null."

If authenticator is null, it means the proof is a non-inclusion proof (the token ID was NOT found in the SMT for that round). This is used during validation, not during normal token storage. UXF should never encounter a stored token with null authenticator in a committed transaction.

### 5.10 CoinData Format Variations

`IMintTransactionDataJson.coinData` is `TokenCoinDataJson | null` where `TokenCoinDataJson = [string, string][]`.

Observed patterns:
- Normal fungible token: `[["<64-char coinId hex>", "1000000"]]`
- Multi-coin token: `[["<coinId1>", "500"], ["<coinId2>", "300"]]` (rare but supported)
- Nametag token: `[]` or `null`
- Zero-value token: `[["<coinId>", "0"]]` (split remainder)

**For CBOR encoding:** Normalize `null` to `[]`. Store as `array<[tstr, tstr]>`. The coinId is a hex string stored as text (NOT converted to bytes), because the SDK treats it as an opaque identifier string in the JSON form.

---

## Summary of Critical Pitfalls

1. **ITokenJson vs TxfToken transfer transaction shape** -- fundamentally different field layouts. Must detect and handle both.
2. **Nametags: recursive tokens vs string names** -- detect format, require full tokens for dedup.
3. **Genesis destinationState is not in the source data** -- must be derived from transaction chain.
4. **SmtPath `path` is a decimal bigint string, NOT hex** -- do not call hexToBytes on it.
5. **Split token `reason` is a complex object, not text** -- contains a full recursive ITokenJson parent token.
6. **Pending transactions have null inclusionProof** -- reject in Phase 1.
7. **Placeholder/pendingFinalization sentinels in sdkData** -- reject at ingestion.
8. **Hex case sensitivity** -- lowercase normalize before hashing or comparing.
9. **SDK state hash != UXF content hash** -- completely different computations, do not confuse.
10. **Message field in TransferTransactionData** -- exists in ITokenJson but not in UXF TransferTransactionData spec; needs mapping decision.
11. **Nametags appear in both top-level AND transfer transaction data** -- must deduplicate across both locations and restore to both on reassembly.
12. **UnicityCertificate is hex-encoded CBOR** -- decode hex to bytes but do NOT re-encode the inner CBOR.