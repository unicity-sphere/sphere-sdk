# UXF Profile Aggregator Pointer — Technical Specification

**Status:** Draft — revision 3 (applies steelman review fixes F1–F11 on top of revision 2; SDK-native; secp256k1-only)
**Companion document:** [`PROFILE-AGGREGATOR-POINTER-ARCHITECTURE.md`](./PROFILE-AGGREGATOR-POINTER-ARCHITECTURE.md) (the "why")
**This document:** the "exactly how" — byte layouts, formulas, algorithms. Narrative rationale lives in the architecture doc and is not repeated here.

---

## 1. Scope and Non-Goals

### 1.1 In scope

This spec defines the **Profile Pointer Layer**: a mechanism to publish and recover the *latest OrbitDB OpLog CID* of a user's UXF Profile by writing ordinary Unicity state-transition commitments to the aggregator's Sparse Merkle Tree.

Specifically, it covers:

- Deterministic derivation of per-version, per-side `requestId`, `stateHash`, `xorKey`, and signing key from the wallet's secp256k1 master private key, using HKDF-SHA256 with subkey separation.
- Splitting a single CID (≤ 63 payload bytes + 1 length byte = 64 bytes) across two 32-byte commitment payloads (sides A, B).
- XOR-based payload obfuscation so aggregator observers cannot tell the commitment carries a CID.
- A version-numbered publish algorithm with a crash-safe pending-version marker.
- A recovery algorithm (exponential probe + binary search, both sides per probe) with **mandatory trustless proof verification** via `RootTrustBase`.
- A conflict-handling algorithm when a submission races a concurrent publisher.
- Error codes, failure modes, and security considerations.

### 1.2 Out of scope

- **CAR pinning, fetching, and content transfer.** See `profile/ipfs-client.ts`.
- **OrbitDB OpLog storage, replication, and CRDT merge.** See `profile/profile-token-storage-provider.ts` and the UXF multi-bundle JOIN rules in `PROFILE-ARCHITECTURE.md §10.4`.
- **Aggregator transport** (HTTP/JSON-RPC). Assumed via `@unicitylabs/state-transition-sdk`'s `AggregatorClient`.
- **Profile snapshot content** (what goes into the OpLog). This spec only cares that some CID needs to be advertised and later recovered.

### 1.3 Design invariant — two-leaf plain commitments

The pointer layer uses **two plain aggregator commitments per version** (leaves A and B). A tokenized (token-state-chain) alternative was rejected because a tokenized chain cannot be re-entered from the mnemonic alone, defeating cold-start recovery. All algorithms below assume the two-leaf model.

---

## 2. Notation

### 2.1 Primitive operations

| Symbol | Meaning |
|---|---|
| `a \|\| b` | Byte concatenation of `a` and `b`. |
| `H(x)` | SHA-256 of `x`. Output is 32 bytes. |
| `HKDF-Extract(salt, ikm)` | RFC 5869 §2.2, SHA-256. `salt = ∅` means zero-length byte string. Output `PRK` is 32 bytes. |
| `HKDF-Expand(prk, info, L)` | RFC 5869 §2.3, SHA-256. Output is `L` bytes. |
| `HKDF(ikm, salt, info, L)` | Shorthand for `HKDF-Expand(HKDF-Extract(salt, ikm), info, L)`. |
| `xor(a, b)` | Byte-wise XOR. `\|a\| = \|b\|`. Output length equals the operand length. |
| `be32(n)` | Big-endian 4-byte encoding of unsigned 32-bit integer `n`. `be32(1) = 0x00 00 00 01`. |
| `bytes_of(s)` | UTF-8 encoding of ASCII string `s`. No terminator. |
| `[b]` | Single-byte literal. `[0x00]` is one zero byte. |

All multi-byte integers and hashes are **big-endian** unless stated otherwise. SHA-256 output is emitted in the standard FIPS 180-4 order.

### 2.2 SDK-native types (authoritative)

The following class names refer to the versions exported by `@unicitylabs/state-transition-sdk`:

| SDK symbol | Role in this spec |
|---|---|
| `HashAlgorithm.SHA256` (numeric value `0`) | Algorithm tag in every `DataHash` used below. |
| `DataHash(algorithm, digest)` | 32-byte digest wrapper. Exposes `.data` (raw 32 B digest) and `.imprint` (2 B algo tag big-endian + digest). For SHA-256 the imprint is `[0x00, 0x00] \|\| digest`, total 34 bytes. |
| `DataHasher(HashAlgorithm.SHA256)` | Streaming SHA-256 hasher. `.update(bytes).digest()` returns a `DataHash`. |
| `SigningService` | secp256k1 keypair + ECDSA-recoverable signer. Construction: `new SigningService(privateKeyBytes32)` or `await SigningService.createFromSecret(secret, nonce?)` (which SHA-256-hashes the secret to 32 bytes). Public key is the 33-byte compressed form. Property `.algorithm === 'secp256k1'`. `.sign(transactionHash)` returns a `Signature` whose preimage is `transactionHash.data` (the 32-byte digest — NOT the imprint, NOT any serialization). |
| `Signature` | Compact secp256k1 signature: 64 bytes `r \|\| s` + 1 byte recovery id. Wire-encoded as 65 bytes. |
| `RequestId.createFromImprint(publicKey, imprint)` | Returns the canonical SMT address. Equivalent to `H(publicKey \|\| imprint)` wrapped in a `RequestId` (which extends `DataHash`). |
| `RequestId.create(publicKey, stateHash)` | Convenience wrapper that delegates to `createFromImprint(publicKey, stateHash.imprint)`. |
| `Authenticator.create(signingService, transactionHash, stateHash)` | Builds an authenticator. Internally calls `signingService.sign(transactionHash)` — the **signature preimage is `transactionHash.data`**. `stateHash` is carried alongside but is NOT part of the signed preimage. |
| `SubmitCommitmentRequest(requestId, transactionHash, authenticator, receipt)` | Wire form for aggregator `submit_commitment` RPC. |
| `SubmitCommitmentResponse.status` | Enum: `SUCCESS`, `AUTHENTICATOR_VERIFICATION_FAILED`, `REQUEST_ID_MISMATCH`, `REQUEST_ID_EXISTS`. |
| `AggregatorClient` | JSON-RPC client. `.submitCommitment(requestId, transactionHash, authenticator, receipt)` → `SubmitCommitmentResponse`. `.getInclusionProof(requestId)` → `InclusionProofResponse`. |
| `InclusionProof.verify(trustBase, requestId)` | Returns `InclusionProofVerificationStatus` ∈ { `OK`, `PATH_NOT_INCLUDED`, `PATH_INVALID`, `NOT_AUTHENTICATED` }. |
| `RootTrustBase` | Trust root required by `InclusionProof.verify`. Loaded by the wallet from a configured trusted source. |

This spec MUST be implemented by calling these SDK classes directly. The only non-SDK primitives permitted are:

1. **HKDF-SHA256** via `@noble/hashes/hkdf` (same pattern as `impl/shared/ipfs/ipns-key-derivation.ts`).
2. **Bytewise XOR.**
3. **Deterministic padding** from an HKDF subkey (no CSPRNG).

---

## 3. Constants

| Name | Value | Units | Notes |
|---|---|---|---|
| `PROFILE_POINTER_HKDF_INFO` | `bytes_of("uxf-profile-aggregator-pointer-v1")` | 32 bytes | Domain-separation label for the pointer-layer PRK. Versioned (`v1`). |
| `SIGNING_SEED_INFO` | `bytes_of("uxf-profile-pointer-sig-v1")` | 26 bytes | Info string used to derive the subkey for `SigningService`. |
| `XOR_SEED_INFO` | `bytes_of("uxf-profile-pointer-xor-v1")` | 26 bytes | Info string used to derive the subkey for per-version `xorKey` and `stateHash` material. |
| `PAD_SEED_INFO` | `bytes_of("uxf-profile-pointer-pad-v1")` | 26 bytes | Info string used to derive the subkey for deterministic padding. |
| `SIDE_A` | `0x00` | 1 byte | Side marker for the first 32-byte half. |
| `SIDE_B` | `0x01` | 1 byte | Side marker for the second 32-byte half. |
| `PAYLOAD_LEN_BYTES` | `32` | — | Size of each 32-byte SMT leaf payload. |
| `CID_MAX_BYTES` | `63` | — | `2 × PAYLOAD_LEN_BYTES − 1`. Upper bound for the CID, leaving 1 byte for the length prefix. |
| `VERSION_MIN` | `1` | — | First valid version number. `V = 0` means "no pointer published". |
| `VERSION_MAX` | `2^31 − 1` | — | Hard upper bound. Prevents `be32(v)` overflow; caps the search range. |
| `DISCOVERY_INITIAL_VERSION` | `1024` | — | Initial `hi` for exponential search on a cold start with no local hint. |
| `DISCOVERY_HARD_CEILING` | `2^22 = 4_194_304` | — | Safety cap on exponential expansion (≤ 22 doublings above `DISCOVERY_INITIAL_VERSION`). |
| `DISCOVERY_PARALLELISM` | `1` | — | Binary-search phase is serial. A+B per-probe parallelism (see §8) is separate and is the only in-probe parallelism. |
| `PUBLISH_RETRY_BUDGET` | `5` | attempts | Maximum consecutive conflict-retries in the publish loop before surfacing `AGGREGATOR_POINTER_RETRY_EXHAUSTED`. |
| `PUBLISH_BACKOFF_BASE_MS` | `250` | ms | Base delay for exponential backoff between retries. |
| `PUBLISH_BACKOFF_MAX_MS` | `4000` | ms | Cap on per-retry delay. |
| `PUBLISH_BACKOFF_JITTER_LO` | `0.5` | multiplier | Lower bound of the uniform jitter multiplier applied to exponential backoff. |
| `PUBLISH_BACKOFF_JITTER_HI` | `1.5` | multiplier | Upper bound of the uniform jitter multiplier applied to exponential backoff. |
| `AGGREGATOR_ALG_TAG_SHA256` | `[0x00, 0x00]` | 2 bytes | Big-endian algorithm tag for `HashAlgorithm.SHA256` (value `0`). Used as the 2-byte prefix of every `DataHash.imprint` in this spec. |
| `MUTEX_KEY` | `"profile.pointer.publish.lock"` | string | Per-wallet exclusive publish mutex identifier (§7.1.1). |
| `PENDING_VERSION_KEY` | `"profile.pointer.pending_version." + hex(signingPubKey)` | string (templated) | Per-wallet crash-safety marker key (§7.1.2). |
| `BLOCKED_FLAG_KEY` | `"profile.pointer.blocked." + hex(signingPubKey)` | string (templated) | Per-wallet persistent BLOCKED-state flag key (§10.2). Boolean; absent ≡ `false`. |

All constants are locked. Any change is a spec bump and requires the `v1` → `v2` rename of `PROFILE_POINTER_HKDF_INFO`.

---

## 4. Key Derivation

All derivations are deterministic pure functions of the wallet's 32-byte secp256k1 private key `walletPrivateKey` and the target version `v` (and side, where applicable). No other inputs, no clock, no nonce, no RNG.

> **Pseudocode async convention (applies throughout §4, §6.4, §7.2, §8.1, §8.5).** All `DataHasher.digest()` calls in this specification are asynchronous and return `Promise<DataHash>`. Similarly, `Authenticator.create(...)` is asynchronous. Implementations MUST await these calls. Pseudocode below omits explicit `await` at every `.digest()` site for layout readability, but implementers are expected to insert them. Example: `(await DataHasher(SHA256).update(x).digest()).data` rather than the literal `DataHasher(SHA256).update(x).digest().data` chain that appears in tables.

### 4.1 Pointer-layer master secret

```
pointerSecret = HKDF(
  ikm   = walletPrivateKey_bytes_32,
  salt  = ∅,
  info  = PROFILE_POINTER_HKDF_INFO,
  L     = 32
)
```

Where `walletPrivateKey` is the same 32-byte secp256k1 private key the wallet uses for L3 token operations (the HKDF pattern matches `impl/shared/ipfs/ipns-key-derivation.ts`). HKDF is one-way; disclosure of `pointerSecret` does not compromise `walletPrivateKey`.

`pointerSecret` MUST NOT leave the wallet process.

### 4.2 Subkey separation

From `pointerSecret` we derive three 32-byte subkeys with distinct info strings. Compromise of any one subkey does not propagate to the others under HKDF's security argument.

```
signingSeed = HKDF-Expand(prk = pointerSecret, info = SIGNING_SEED_INFO, L = 32)
xorSeed     = HKDF-Expand(prk = pointerSecret, info = XOR_SEED_INFO,     L = 32)
padSeed     = HKDF-Expand(prk = pointerSecret, info = PAD_SEED_INFO,     L = 32)
```

### 4.3 Signing identity (secp256k1 only)

```
signingService = await SigningService.createFromSecret(signingSeed)   // SDK static; SHA-256-hashes input
signingPubKey  = signingService.publicKey                             // 33-byte compressed secp256k1
```

**Algorithm: secp256k1, not Ed25519.** The state-transition-sdk `SigningService` is secp256k1-only (`@noble/curves/secp256k1`). There is no Ed25519 path, and this spec does not introduce one. Any prior text suggesting Ed25519 is superseded.

**Construction form: `createFromSecret`, not the raw constructor.** The static `SigningService.createFromSecret(secret)` SHA-256-hashes its input before using it as the secp256k1 private-key scalar, which provides free rejection-sampling-equivalent uniformity across the curve's group order. The raw constructor `new SigningService(privKey)` treats the input as the scalar directly. These produce DIFFERENT `signingPubKey` values for the same seed and are non-interoperable — implementations MUST use `createFromSecret` in this scheme.

Byte layout of `signingPubKey`: 1 byte prefix (`0x02` or `0x03`) + 32 bytes X-coordinate = 33 bytes total, in SEC1 compressed form.

**Privacy property.** `signingPubKey` is a function of `pointerSecret` (a secret). An observer holding only the wallet's chain public key cannot derive `signingPubKey` and therefore cannot enumerate this wallet's request IDs. `signingPubKey` IS however a stable per-wallet pseudonym across all versions (A and B included); see §11.

### 4.4 Per-version, per-side state hash

For `v ∈ [VERSION_MIN, VERSION_MAX]` and `side ∈ {SIDE_A, SIDE_B}`:

```
stateHashDigest_{side, v} =
  DataHasher(HashAlgorithm.SHA256)
    .update(xorSeed)               // 32 bytes
    .update([side])                // 1 byte
    .update(be32(v))               // 4 bytes
    .update(bytes_of("state"))     // 5 bytes
    .digest()
    .data                          // 32 bytes
```

Preimage byte layout:

| Offset | Length | Field |
|---|---|---|
| 0 | 32 | `xorSeed` |
| 32 | 1 | `side` (`0x00` or `0x01`) |
| 33 | 4 | `be32(v)` |
| 37 | 5 | `bytes_of("state")` (`0x73 0x74 0x61 0x74 0x65`) |

Total preimage length: **42 bytes**. Output: 32 bytes.

The `DataHash` wrapper (the object the SDK consumes) is:

```
stateHash_{side, v} = new DataHash(HashAlgorithm.SHA256, stateHashDigest_{side, v})
```

Its `.imprint` is `[0x00, 0x00] \|\| stateHashDigest_{side, v}` (34 bytes).

### 4.5 Per-version, per-side XOR key

```
xorKey_{side, v} =
  DataHasher(HashAlgorithm.SHA256)
    .update(xorSeed)               // 32 bytes
    .update([side])                // 1 byte
    .update(be32(v))               // 4 bytes
    .update(bytes_of("xor"))       // 3 bytes
    .digest()
    .data                          // 32 bytes
```

Preimage byte layout:

| Offset | Length | Field |
|---|---|---|
| 0 | 32 | `xorSeed` |
| 32 | 1 | `side` |
| 33 | 4 | `be32(v)` |
| 37 | 3 | `bytes_of("xor")` (`0x78 0x6f 0x72`) |

Total preimage length: **40 bytes**. Output: 32 bytes.

Domain separation from §4.4: identical 37-byte prefix (`xorSeed \|\| side \|\| be32(v)`), distinct suffix (`"state"` vs `"xor"`). Under the random-oracle model for SHA-256, the two outputs are computationally independent.

### 4.6 Per-version padding (deterministic; replaces CSPRNG)

Padding is derived from `padSeed`. This is a **load-bearing change** vs. earlier drafts that used `randomBytes()`: determinism makes a crash-retry with the same `(v, cidBytes)` produce byte-identical leaves, and the aggregator's write-once semantics (keyed by `requestId`) then give idempotence for free.

The padding is computed **once per version**, shared across both sides:

```
cidLen    = len(cidBytes)                     // 1 ≤ cidLen ≤ CID_MAX_BYTES
padLength = 64 - 1 - cidLen                   // 0 ≤ padLength ≤ 62

paddingBytes_v = HKDF-Expand(
  prk  = padSeed,
  info = be32(v) || bytes_of("pad"),          // 4 + 3 = 7 bytes
  L    = padLength
)
```

If `padLength == 0`, `paddingBytes_v` is the empty byte string.

Padding info-string byte layout:

| Offset | Length | Field |
|---|---|---|
| 0 | 4 | `be32(v)` |
| 4 | 3 | `bytes_of("pad")` (`0x70 0x61 0x64`) |

**Crash-retry discipline.** See §7.1 — the pending-version marker guarantees `(v, cidBytes)` uniqueness so that `paddingBytes_v` is never re-derived for the same `v` with a different `cidBytes` (which would produce different plaintext under the same `xorKey_{side, v}` and break one-time-pad discipline).

### 4.7 Per-version, per-side request ID (SDK-native formula)

The SDK's canonical formula is:

```
requestId_{side, v} = RequestId.createFromImprint(signingPubKey, stateHash_{side, v}.imprint)
```

Equivalently, expanded:

```
requestId_{side, v} =
  DataHasher(HashAlgorithm.SHA256)
    .update(signingPubKey)                    // 33 bytes (compressed secp256k1)
    .update(AGGREGATOR_ALG_TAG_SHA256)        // 2 bytes [0x00, 0x00]
    .update(stateHashDigest_{side, v})        // 32 bytes
    .digest()
    .data                                     // 32 bytes
```

Preimage byte layout (authoritative):

| Offset | Length | Field |
|---|---|---|
| 0 | 33 | `signingPubKey` (compressed secp256k1) |
| 33 | 2 | `AGGREGATOR_ALG_TAG_SHA256` = `[0x00, 0x00]` |
| 35 | 32 | `stateHashDigest_{side, v}` |

Total preimage length: **67 bytes**. Output: 32 bytes, wrapped as a `RequestId` (which extends `DataHash` with `HashAlgorithm.SHA256`).

> **Fix vs. revision 1.** The previous draft omitted the 2-byte algorithm tag between the public key and the state digest. The SDK's `RequestId.createFromImprint` hashes the *imprint* (tag + digest), not the raw digest. Implementations MUST include the `[0x00, 0x00]` tag.

---

## 5. Payload Encoding

### 5.1 Input

The OpLog CID as binary-encoded bytes (not base32 / base58 text). Supported:

- **CIDv0** — fixed 34 bytes: `0x12 0x20 <32-byte SHA-256 digest>`.
- **CIDv1** — `<varint:version> <varint:codec> <multihash>`. Typical total ≤ 40 bytes for sha256 multihashes.

Length check:

```
if len(cidBytes) < 1 or len(cidBytes) > CID_MAX_BYTES:
    raise AGGREGATOR_POINTER_CID_TOO_LARGE
```

### 5.2 Length-prefix encoding (Option a — chosen)

A single 1-byte length prefix encodes `cidLen`. This removes any dependency on a CID self-delimiting parser during decode and bounds the parser's read strictly inside the 64-byte buffer.

### 5.3 Plaintext buffer `full` (64 bytes, shared across sides)

```
full[0]                     = cidLen                                // 1 byte, uint8
full[1 .. 1+cidLen)         = cidBytes                              // cidLen bytes
full[1+cidLen .. 64)        = paddingBytes_v                        // (63 − cidLen) bytes, from §4.6
```

Byte layout of `full`:

| Offset | Length | Field |
|---|---|---|
| 0 | 1 | `cidLen` (uint8) |
| 1 | `cidLen` | `cidBytes` |
| `1 + cidLen` | `63 − cidLen` | `paddingBytes_v` (deterministic, §4.6) |

Total: 64 bytes.

### 5.4 Halves

```
partA = full[0  .. 32)      // 32 bytes — carries length prefix + CID head (+ possibly padding if CID is short)
partB = full[32 .. 64)      // 32 bytes — carries CID tail (if any) + padding
```

Both halves MAY contain a mix of CID bytes and padding bytes depending on `cidLen`:

- `cidLen ≤ 31`: `partA` holds the length byte + the whole CID + padding prefix; `partB` is entirely padding.
- `cidLen = 31`: `partA` holds length + CID; `partB` is entirely padding.
- `cidLen ∈ [32, 63]`: `partA` holds length + first 31 CID bytes; `partB` holds the remaining `cidLen − 31` CID bytes + padding.

---

## 6. Commitment Payload

### 6.1 Pre-XOR halves

From §5.4: `partA` and `partB`, each exactly 32 bytes.

### 6.2 XOR masking

```
ctA = xor(partA, xorKey_{SIDE_A, v})        // 32 bytes
ctB = xor(partB, xorKey_{SIDE_B, v})        // 32 bytes
```

`ctA` and `ctB` are each 32 bytes. By the one-time-pad argument, their byte distribution is uniform to any observer lacking `xorSeed`.

### 6.3 `transactionHash` construction

The SDK's `transactionHash` field is a `DataHash`. We fill it with the ciphertext as the digest, keeping `HashAlgorithm.SHA256` as the algorithm tag:

```
transactionHash_{SIDE_A, v} = new DataHash(HashAlgorithm.SHA256, ctA)
transactionHash_{SIDE_B, v} = new DataHash(HashAlgorithm.SHA256, ctB)
```

**Why keep the `sha256` tag.** Every ordinary L4 state-transition commitment also uses `HashAlgorithm.SHA256`. Using the same tag here makes the pointer commitment visually indistinguishable from a regular token commit in the SMT.

**Why the aggregator accepts this.** The aggregator validates the imprint *shape* (2-byte big-endian algo tag + 32-byte digest = 34 bytes total) but treats the digest bytes as opaque — it does not cross-check that `digest == SHA-256(anything)`. Placing XOR ciphertext in the digest slot is therefore a valid, if unusual, use of the `DataHash` schema.

### 6.4 Authenticator (SDK-native)

```
authenticator_{side, v} = await Authenticator.create(
  signingService,                   // from §4.3
  transactionHash_{side, v},        // from §6.3 — DataHash wrapping ctSide
  stateHash_{side, v}               // from §4.4 — DataHash wrapping stateHashDigest
)
```

Per the SDK, `Authenticator.create` internally calls `signingService.sign(transactionHash)`, which signs **`transactionHash.data`** — the raw 32-byte digest, NOT the imprint, NOT any multi-field serialization.

Therefore the authoritative signature preimage is:

```
signaturePreimage_{side, v} = ctSide              // 32 bytes
```

The `stateHash` is stored inside the `Authenticator` struct (and is the binding to the `requestId` via §4.7), but is NOT folded into the signature preimage. This is a property of the SDK's `Authenticator.create` implementation — documented here so independent reimplementations match byte-for-byte.

The returned `Authenticator` fields:

| Field | Value | Notes |
|---|---|---|
| `.algorithm` | `"secp256k1"` | From `signingService.algorithm`. |
| `.publicKey` | `signingPubKey` | 33 bytes compressed. |
| `.signature` | secp256k1 ECDSA | 64 bytes `r \|\| s` + 1 byte recovery id (`Signature` SDK class). |
| `.stateHash` | `stateHash_{side, v}` | `DataHash(SHA256, stateHashDigest)` — 34-byte imprint. |

### 6.5 Submission request

```
commitment_{side, v} = new SubmitCommitmentRequest(
  /* requestId       */ requestId_{side, v},
  /* transactionHash */ transactionHash_{side, v},
  /* authenticator   */ authenticator_{side, v},
  /* receipt         */ false
)

response = await aggregatorClient.submitCommitment(
  requestId_{side, v},
  transactionHash_{side, v},
  authenticator_{side, v},
  /* receipt */ false
)
```

The RPC method name and JSON body layout are owned by the SDK (see `AggregatorClient.submitCommitment` and `SubmitCommitmentRequest.toJSON`). This spec does not re-specify them.

`response.status` takes one of:

| `SubmitCommitmentStatus` | Meaning in this spec |
|---|---|
| `SUCCESS` | Commitment accepted. |
| `REQUEST_ID_EXISTS` | A commitment at this `requestId` already exists. Either we raced a concurrent publisher, or this is an idempotent replay of our own prior submission (§10.1). |
| `AUTHENTICATOR_VERIFICATION_FAILED` | Signature invalid. Non-retryable. `AGGREGATOR_POINTER_REJECTED`. |
| `REQUEST_ID_MISMATCH` | `requestId` does not derive from `(publicKey, stateHash)`. Non-retryable. `AGGREGATOR_POINTER_REJECTED`. |

Transport-level failures (network, timeout, malformed response) surface as thrown errors from the SDK client and map to `AGGREGATOR_POINTER_NETWORK_ERROR`.

---

## 7. Publish Algorithm

### 7.1 Pre-publish crash-safety invariant (MANDATORY)

Before any per-version derivation (`paddingBytes_v`, `partA`, `partB`, `ctA`, `ctB`, authenticators), the publisher MUST reserve `v` against the CID in local storage, under the discipline below.

**7.1.1 Exclusive publish mutex.** The sequence "read `pending_version` → compute XOR payload → submit both sides → update `pending_version`" MUST hold an exclusive per-wallet mutex. Implementations MUST reject concurrent entries — either by returning a "busy" status or by serializing via a promise queue. Without this, two concurrent publish pipelines (e.g., debounced flush timer + manual sync) can produce OTP-reuse by both deriving payloads under the same `(v, side, xorKey)` with different plaintexts. Mutex key:

```
MUTEX_KEY = "profile.pointer.publish.lock"                 // per-wallet
```

**7.1.2 Per-wallet scoping of the marker.** The pending-version slot MUST be namespaced by the pointer layer's signing pubkey so that multi-wallet devices never share a single slot:

```
PENDING_VERSION_KEY = "profile.pointer.pending_version." + hex(signingPubKey)
```

See §3 for the constant registration.

**7.1.3 Durability.** The `pending_version` write MUST be durable (fsync / flush-completed) BEFORE any downstream derivation runs. For IndexedDB this means awaiting `transaction.oncomplete`; for file-based storage, explicit `fsync`. Storage backends that cannot guarantee durability MUST refuse to initialize the pointer layer.

**7.1.4 Rollback-safe version selection.** The marker read + v-bump logic is:

```
cidHash = SHA-256(cidBytes)

previousEntry = storage.read(PENDING_VERSION_KEY)
if previousEntry is not null:
    if previousEntry.v >= v:
        // Never reuse or regress below a historically reserved v.
        // Handles: stale marker left by a crashed attempt, AND
        // adversarial rollback of localVersion (tamper / corruption).
        v := max(v, previousEntry.v) + 1
    if previousEntry.v < currentLocalVersion:
        // Stale marker; harmless to drop.
        clear previousEntry

storage.write(PENDING_VERSION_KEY, { v, cidHash })           // durable per 7.1.3
```

This closes the "localVersion rolled back by tamper/corruption" path where the previous `v == v && cidHash != cidHash` check fell through silently.

**7.1.5 cidHash integrity.** Implementations MUST NOT truncate the `cidHash`. A marker with `|cidHash| != 32` MUST be treated as corrupt and the publish refused with `AGGREGATOR_POINTER_MARKER_CORRUPT`.

**7.1.6 Marker clear atomicity.** When a successful publish persists `localVersion = v` and clears the marker, BOTH writes SHOULD occur in a single atomic transaction if the storage backend supports it. If they cannot be atomic, the persistence order is:

1. Write `localVersion = v`.
2. Clear `PENDING_VERSION_KEY`.

A crash between (1) and (2) leaves a stale marker at the just-completed `v`, which §7.1.4 will correctly compact on next publish (the `previousEntry.v < currentLocalVersion` branch).

**Threat defended.** Partial execution + process restart with a different CID. Without this marker, a crashed publisher could re-enter with a new CID at the same `v`, reusing `xorKey_{side, v}` against a different plaintext — a trivial OTP break if both plaintexts ever hit the SMT.

The `pending_version` slot is cleared only after a successful publish (§7.3, per 7.1.6) or after the publisher definitively abandons the version (e.g., `REQUEST_ID_MISMATCH` — non-retryable).

### 7.2 Payload build

```
cidLen          = len(cidBytes)
paddingBytes_v  = HKDF-Expand(padSeed, be32(v) || bytes_of("pad"), 63 - cidLen)

full  = [cidLen] || cidBytes || paddingBytes_v                          // 64 bytes
partA = full[0 .. 32)
partB = full[32 .. 64)

for side in [SIDE_A, SIDE_B]:
    part             := (side == SIDE_A) ? partA : partB
    stateDigest      := H(xorSeed || [side] || be32(v) || "state")      // §4.4
    stateHash        := new DataHash(SHA256, stateDigest)
    xorKey           := H(xorSeed || [side] || be32(v) || "xor")         // §4.5
    ct               := xor(part, xorKey)
    transactionHash  := new DataHash(SHA256, ct)
    requestId        := RequestId.createFromImprint(signingPubKey, stateHash.imprint)
    authenticator    := await Authenticator.create(signingService, transactionHash, stateHash)
    commitments.push({ side, requestId, transactionHash, authenticator })
```

### 7.3 Submit both sides in parallel

```
(resultA, resultB) = await Promise.all([
  aggregatorClient.submitCommitment(
    commitments[SIDE_A].requestId,
    commitments[SIDE_A].transactionHash,
    commitments[SIDE_A].authenticator,
    false
  ),
  aggregatorClient.submitCommitment(
    commitments[SIDE_B].requestId,
    commitments[SIDE_B].transactionHash,
    commitments[SIDE_B].authenticator,
    false
  )
])
```

Outcome matrix:

| resultA.status | resultB.status | Action |
|---|---|---|
| `SUCCESS` | `SUCCESS` | Persist `localVersion = v`. Clear `pending_version`. Return `Ok({ version: v })`. |
| `SUCCESS` | `REQUEST_ID_EXISTS` | Treat B as idempotent-replay success (§10.1). Persist `localVersion = v`. Clear `pending_version`. Return `Ok`. |
| `REQUEST_ID_EXISTS` | `SUCCESS` | Symmetric to above. Persist `localVersion = v`. Return `Ok`. |
| `REQUEST_ID_EXISTS` | `REQUEST_ID_EXISTS` with `pending_version.v == v` AND `pending_version.cidHash == SHA-256(cidBytes)` | **Idempotent replay** (see §9.1 marker-match rule): both sides were committed by our own prior attempt that crashed before persisting `localVersion`. Persist `localVersion = v`. Clear `pending_version`. Emit `pointer:publish_completed`. Return `Ok({ version: v })`. Do NOT invoke §9 reconciliation. |
| `REQUEST_ID_EXISTS` | `REQUEST_ID_EXISTS` with `pending_version` absent OR `pending_version.cidHash != SHA-256(cidBytes)` | **Genuine conflict**: another device committed `v` first. Invoke §9 reconciliation; caller runs reconciliation and retries at `V_true + 1`. Do NOT clear `pending_version` until the retry resolves. |
| `SUCCESS` | network error | Retry B at same `(v, SIDE_B)` with same deterministic payload (§10.1). |
| network error | `SUCCESS` | Retry A at same `(v, SIDE_A)` with same deterministic payload. |
| network error | network error | Retry the whole `(v)` publish (both sides) with the same payload. |
| `AUTHENTICATOR_VERIFICATION_FAILED` or `REQUEST_ID_MISMATCH` (either side) | (any) | Non-retryable. Clear `pending_version`. Raise `AGGREGATOR_POINTER_REJECTED`. |

### 7.4 Retry with jittered exponential backoff

```
backoff(n) = min(PUBLISH_BACKOFF_MAX_MS, PUBLISH_BACKOFF_BASE_MS × 2^n)
             × uniform(PUBLISH_BACKOFF_JITTER_LO, PUBLISH_BACKOFF_JITTER_HI)
```

Where `n ∈ {0, 1, 2, ...}` is the retry index. Jitter is applied per attempt to desynchronize concurrent multi-device retries. The `uniform(a, b)` draw is from a real-valued uniform distribution on `[a, b)`; implementations MAY use a non-cryptographic PRNG here (this value does not feed into any cryptographic derivation).

### 7.5 Version selection

The caller is responsible for `v`. The happy path is `v := localVersion + 1`, where `localVersion` is the most recent value persisted after a successful publish, `0` for a fresh profile. Startup reconciliation (§8) adjusts `localVersion` to match the aggregator before the first publish.

---

## 8. Recovery / Discovery Algorithm

### 8.1 Probe (both sides per step — MANDATORY)

Every probe at version `v` fetches and *trustlessly verifies* the inclusion status of BOTH `SIDE_A` and `SIDE_B`:

```
async fun probe(v) -> boolean:
    (respA, respB) = await Promise.all([
        aggregatorClient.getInclusionProof(requestId_{SIDE_A, v}),
        aggregatorClient.getInclusionProof(requestId_{SIDE_B, v}),
    ])

    (statusA, statusB) = await Promise.all([
        respA.inclusionProof.verify(trustBase, requestId_{SIDE_A, v}),
        respB.inclusionProof.verify(trustBase, requestId_{SIDE_B, v}),
    ])

    aIncluded = (statusA == OK)
    bIncluded = (statusB == OK)

    if statusA == PATH_INVALID or statusB == PATH_INVALID or
       statusA == NOT_AUTHENTICATED or statusB == NOT_AUTHENTICATED:
        raise AGGREGATOR_POINTER_UNTRUSTED_PROOF

    return aIncluded and bIncluded
```

Probing both sides per step defends against partial-publish ambiguity: a single-side probe could be misled by a half-published `v` (A committed, B missing) into treating `v` as "published" when the decoded payload would be unusable.

### 8.2 Phase 1 — exponential expansion (serial)

Phase 1 uses the locally persisted `localVersion` as a lower-bound hint when available; otherwise starts from 0.

```
lo = max(0, localVersion)
hi = max(DISCOVERY_INITIAL_VERSION, lo + 1)

while await probe(hi):
    lo = hi
    hi = hi * 2
    if hi > DISCOVERY_HARD_CEILING:
        if await probe(DISCOVERY_HARD_CEILING):
            raise AGGREGATOR_POINTER_DISCOVERY_OVERFLOW
        hi = DISCOVERY_HARD_CEILING
        break
```

Invariant after Phase 1: `probe(lo) == true` (or `lo == 0`) AND `probe(hi) == false`.

### 8.3 Phase 2 — binary search (serial)

```
while hi - lo > 1:
    mid = (lo + hi) / 2                 // integer division, rounded down
    if await probe(mid):
        lo = mid
    else:
        hi = mid

return lo                                // 0 means "no pointer ever published"
```

Probe count bounds:

- Phase 1: at most `log2(DISCOVERY_HARD_CEILING / max(1, lo)) + 1` doublings.
- Phase 2: at most `log2(hi − lo) ≤ 22` iterations.
- Each probe = 2 parallel aggregator round trips + 2 parallel local verifications.

### 8.4 Trustless proof verification (MANDATORY)

Every `InclusionProofResponse` returned by `AggregatorClient.getInclusionProof` MUST be verified via:

```
status = await proof.verify(trustBase, requestId)       // InclusionProofVerificationStatus
```

Where `trustBase` is a `RootTrustBase` loaded by the wallet from a trusted source configured out-of-band. The wallet MUST NOT accept inclusion or exclusion claims based on unverified responses.

**TOFU degradation (accepted for v1).** On a fresh-device first boot with no pre-installed trust base, the wallet falls back to trust-on-first-use — it accepts the first `RootTrustBase` served by the configured aggregator and pins it locally. This is explicitly acknowledged as a known-weak posture for v1. v2 mitigations (anchor to L1 alpha chain) are tracked as future work in `PROFILE-AGGREGATOR-POINTER-ARCHITECTURE.md §12`.

**Multi-mirror TOFU cross-check (RECOMMENDED for v1).** Even in the TOFU posture, implementations SHOULD query at least TWO aggregator mirror URLs (even if the mirror list is statically bundled into the SDK) on first-boot recovery and require the returned trust bases to match byte-for-byte. A single mirror disagreeing with the others MUST abort recovery with `AGGREGATOR_POINTER_TRUST_BASE_DIVERGENCE`. This degrades the Wi-Fi-level MITM attack from "silent" to "detected + user-actionable", at zero ongoing cost (mirror list is static in the SDK). The SDK-side mirror list is tracked under O-6 (§15.1). Future work: pin a `RootTrustBase` fingerprint to the alpha L1 chain for out-of-band verification.

### 8.5 CID reconstruction

Once Phase 2 returns `V > 0`:

```
(respA, respB) = await Promise.all([
    aggregatorClient.getInclusionProof(requestId_{SIDE_A, V}),
    aggregatorClient.getInclusionProof(requestId_{SIDE_B, V}),
])

assert respA.inclusionProof.verify(trustBase, requestId_{SIDE_A, V}) == OK
assert respB.inclusionProof.verify(trustBase, requestId_{SIDE_B, V}) == OK

ctA = respA.inclusionProof.transactionHash.data                  // raw 32-byte digest
ctB = respB.inclusionProof.transactionHash.data

xorKeyA = H(xorSeed || [SIDE_A] || be32(V) || "xor")
xorKeyB = H(xorSeed || [SIDE_B] || be32(V) || "xor")

partA = xor(ctA, xorKeyA)
partB = xor(ctB, xorKeyB)

full  = partA || partB                                  // 64 bytes

cidLen = full[0]
if cidLen < 1 or cidLen > CID_MAX_BYTES:
    raise AGGREGATOR_POINTER_CORRUPT

cidBytes = full[1 .. 1 + cidLen)

// Validate as a well-formed CID (multibase/multihash/codec).
if not isValidCid(cidBytes):
    raise AGGREGATOR_POINTER_CORRUPT

return { cid: cidBytes, version: V }
```

The CID parser used by `isValidCid` MUST bound all reads to the provided `cidBytes` slice, reject malformed varints, and accept only the codecs supported by the upstream `profile/ipfs-client.ts verifyCidMatchesBytes` (in practice: sha2-256 multihashes; expand as the upstream expands).

---

## 9. Conflict Handling

### 9.1 Trigger

Conflict is signaled by `SubmitCommitmentStatus.REQUEST_ID_EXISTS` on either side during §7.3, after ruling out the idempotent-replay case (where our own prior submission at this `requestId` already succeeded — detected by cross-referencing `pending_version.v == current v` AND `pending_version.cidHash == SHA-256(cidBytes)`).

A genuine conflict means another device raced us and published version `v` first.

### 9.2 Reconciliation procedure

```
async fun publishWithConflictHandling(cidProducer, attempts = 0):
    if attempts >= PUBLISH_RETRY_BUDGET:
        raise AGGREGATOR_POINTER_RETRY_EXHAUSTED

    cid    = cidProducer()                          // recompute against current local state
    localV = storage.read("profile.pointer.version") ?? 0
    result = await publish(cid, localV + 1)

    if result.ok:
        return result

    if result.err == AGGREGATOR_POINTER_CONFLICT:
        V_true    = await discoverLatestVersion()                   // §8
        remote    = await recoverLatest()                            // §8.5 (CID at V_true)
        // Outer Profile layer fetches CAR via DEFAULT_IPFS_GATEWAYS and
        // merges the bundle into local OrbitDB per PROFILE-ARCHITECTURE §10.4.
        await profileLayer.fetchAndJoin(remote.cid)
        storage.write("profile.pointer.version", V_true)

        sleep(backoff(attempts))                                     // §7.4
        return publishWithConflictHandling(cidProducer, attempts + 1)

    // Any non-conflict error bubbles up unchanged.
    return result
```

### 9.3 CAR fetch / OpLog merge

Out of scope for this spec. Delegated to the Profile layer (see `PROFILE-ARCHITECTURE.md §10.4` and `profile/ipfs-client.ts`). The pointer layer surfaces the CID and sets `localVersion`; it MUST NOT merge OpLogs itself.

### 9.4 Retry bound

`PUBLISH_RETRY_BUDGET = 5`. With jittered exponential backoff (§7.4), five attempts give roughly `250 + 500 + 1000 + 2000 + 4000 = 7.75 s` mean wall-clock backoff before `AGGREGATOR_POINTER_RETRY_EXHAUSTED`. Beyond that, pathological multi-device contention is assumed and requires operator or UX intervention.

---

## 10. Failure Modes

### 10.1 Partial publish (one side accepted, one side failed)

All retryable sub-cases (see §7.3 outcome matrix) re-submit the **same `(v, side)` commitment** — same `requestId`, same `transactionHash`, same `authenticator` bytes. This is safe because:

- `requestId_{side, v}` is a deterministic function of `(signingPubKey, stateHashDigest_{side, v})` — both fixed for a given `(v, side)`.
- `transactionHash_{side, v}` is `ctSide = xor(partSide, xorKey_{side, v})` — fixed once `(cidBytes, v)` are fixed, thanks to deterministic padding (§4.6).
- The aggregator is write-once keyed by `requestId`, so retry either succeeds (first delivery lost in flight) or returns `REQUEST_ID_EXISTS` (first delivery landed) — both are idempotent-success outcomes.

Bounded by `PUBLISH_RETRY_BUDGET` with backoff per §7.4.

> **MUST NOT:** under any retryable outcome, abandon `v` and skip to `v + 1`. Skipping is permitted ONLY for non-retryable protocol errors (`AUTHENTICATOR_VERIFICATION_FAILED`, `REQUEST_ID_MISMATCH`) that conclusively invalidate the submission. Skipping otherwise leaks orphan leaves and wastes version slots.

### 10.2 Aggregator unreachable during recovery (MANDATORY)

**Scenario.** `initialize()` could not reach the aggregator. Recovery returned no information — neither "no pointer at v=1" (exclusion) nor a discovered `V_true`. Subsequently, the local OpLog accumulates user-originated writes.

**Behavior.** The wallet MUST BLOCK the next publish until one of the reachability outcomes listed under "CLEAR on" below is achieved. Proceeding to publish without reconciliation risks silently forking the OpLog across devices.

**10.2.1 Persistent state.** BLOCKED is a per-wallet persistent boolean, so it survives process restarts and survives across machines sharing the wallet:

```
BLOCKED_FLAG_KEY = "profile.pointer.blocked." + hex(signingPubKey)     // see §3
```

Value: boolean. An absent key is equivalent to `false`.

Implementations MUST expose this state via the `AGGREGATOR_POINTER_UNREACHABLE_RECOVERY_BLOCKED` error code (§12) on any publish attempt while BLOCKED, AND via the `isPublishBlocked()` query (§13).

**10.2.2 SET on (entry conditions).** SET BLOCKED when ALL of the following hold:

1. `initialize()` — or any subsequent reconciliation pass — attempts to reach the aggregator for recovery;
2. the transport error is **categorical**: network timeout, connection refused, DNS failure, TLS error (or equivalent). A non-categorical error (e.g., 5xx that may retry-succeed) MUST NOT set BLOCKED on first occurrence;
3. the local OpLog contains **at least one user-originated write** (see 10.2.3);
4. at least one retry with exponential backoff has already been attempted (to avoid flapping on single transient failures).

Additionally, re-SET BLOCKED (reentry) when a publish attempt fails with `AGGREGATOR_POINTER_NETWORK_ERROR` whose error category matches the transport-categorical list in (2).

**10.2.3 User-originated write definition.** An OpLog entry is *user-originated* iff it was authored by the current device's signing identity — specifically, its signature was produced by the wallet's chain-key `SigningService` on this device. Entries authored by remote peers (replicated via OrbitDB gossipsub, Nostr DM ingest, or any other inbound replication path) are NOT user-originated, even when they mutate the local OpLog. The check is:

```
entry.signedBy == localSigningPubKey
```

This distinction is load-bearing: replicated entries from other devices do not themselves justify blocking, because their author's device is responsible for publishing its own pointer advance.

**10.2.4 CLEAR on (exit conditions).** CLEAR BLOCKED only after EITHER:

(a) A trustlessly-verified **exclusion** proof for `requestId_{A, 1}` AND `requestId_{B, 1}` — i.e., `PATH_NOT_INCLUDED` under `InclusionProof.verify(trustBase, ...)`. Applies ONLY when `localVersion == 0` (wallets that have never successfully published). OR

(b) A successful `recoverLatest()` that yields `V_true > 0`, fetches the CID from IPFS, AND merges the remote bundle into the local OpLog (per §9.2 / Profile layer).

Clearing on any OTHER condition — reachability-only probes, user preference changes, UI "dismiss" actions — MUST NOT happen unless the explicit operator override (10.2.5) is invoked.

**10.2.5 User override protocol (optional).** For wallets in permanent-aggregator-outage scenarios (regional outage, deprecated testnet, air-gapped forensic recovery), implementations MAY expose a user-confirmed override. The override MUST:

- Be opt-in **per-call** (not a persistent setting; each bypass is an explicit user action).
- Present a clear warning along the lines of: "Publishing without aggregator verification risks overwriting legitimate remote history from other devices."
- Emit telemetry `pointer:publish_override_used { version, reason }` (PII-free).
- Be gated behind a capability check — for instance, only available when a `allowUnverifiedOverride` flag is set at Sphere-init time, so naive consumers cannot stumble into it.

v1 implementations MAY omit the override entirely and accept permanent read-only mode until the aggregator is reachable again. The override is explicitly NOT required for v1 sign-off.

### 10.3 Malformed recovered payload

Occurs when §8.5 decodes a length-prefix + CID that fails `isValidCid` or `cidLen` bounds. Raise `AGGREGATOR_POINTER_CORRUPT`. Do NOT attempt repair. Log the failing version, the `pointerSecret`-derived `signingPubKey`, and the raw ciphertext halves for triage.

Possible root causes:

- Key derivation drift between publisher and recoverer (library version skew in HKDF or SigningService).
- Wrong mnemonic imported (pointer decryption produces garbage; length prefix happens to be "valid-looking" but CID parse fails).
- Publisher violated §7.1 and reused `(v)` across two different CIDs — in which case both ciphertexts are now mutually recoverable by an observer (see §11).

### 10.4 CID too large

`cidLen > CID_MAX_BYTES` → reject at publish with `AGGREGATOR_POINTER_CID_TOO_LARGE`. A three-commitment extension is future work (`ARCHITECTURE §12`).

### 10.5 Version overflow

`v > VERSION_MAX` → reject at publish with `AGGREGATOR_POINTER_VERSION_OUT_OF_RANGE`. At `2^31 − 1`, even at one publish per second, this is ~68 years per wallet.

### 10.6 Aggregator-signed false exclusion

A malicious aggregator could return an exclusion proof for a `requestId` it previously accepted. Defense: `InclusionProof.verify(trustBase, ...)` roots the answer in the `RootTrustBase`. A forged exclusion requires forging the trust base, which is out of scope for this layer (assumed defended by BFT anchoring at L2/L1).

For deployments wanting stronger guarantees, cross-check against multiple aggregator mirrors (future work, §12 of arch doc).

---

## 11. Security Considerations

1. **Subkey separation.** `signingSeed`, `xorSeed`, `padSeed` are independent HKDF outputs from `pointerSecret` with distinct info strings (§4.2). Compromise of any single subkey does not compromise the others.

2. **One-time-pad discipline.** Each `xorKey_{side, v}` is used on exactly one 32-byte plaintext half. Reuse would allow `xor(ct1, ct2) = xor(pt1, pt2)`, trivially recovering plaintext. The scheme enforces uniqueness by binding `xorKey` to `be32(v)`. The `pending_version` marker (§7.1) additionally prevents a crashed publisher from reusing `v` with a *different* plaintext after restart.

3. **Deterministic padding.** `paddingBytes_v` is an HKDF-Expand output from `padSeed` — an internal secret. To an observer without `padSeed`, the padding is computationally indistinguishable from uniform random. Determinism is strictly a benefit for idempotent crash-retry: it removes the need to persist a CSPRNG seed across restarts.

4. **Pubkey pseudonymity, not anonymity.** `signingPubKey` is stable across all versions and both sides for a given wallet. The aggregator can cluster "all commitments signed by this key are from the same entity." It cannot link `signingPubKey` to `walletPrivateKey` or to the wallet's chain pubkey (secret-derived via HKDF). G2 (from the arch doc) is therefore pseudonymous-per-wallet, not fully unlinkable across a wallet's own commits. Full anonymity (throwaway `signingPubKey` per version) is deferred future work.

5. **Trustless proof verification (mandatory).** Every inclusion / exclusion claim the wallet acts on MUST be verified via `InclusionProof.verify(trustBase, requestId)` before being trusted. TOFU trust-base bootstrap on first boot is an explicit v1 weakness (§8.4).

6. **Algorithm tag visible.** The `HashAlgorithm.SHA256` tag (`[0x00, 0x00]`) is visible in both `stateHash.imprint` and `transactionHash.imprint` published to the SMT. Because every ordinary L4 commitment uses the same tag, this does not distinguish pointer commitments.

7. **CID parser hardening.** The decoder MUST bound reads to the 64-byte plaintext buffer, reject malformed varints, and accept only sha2-256 multihashes (aligned with `profile/ipfs-client.ts verifyCidMatchesBytes`). A permissive parser is a denial-of-service vector.

8. **No replay surface.** The aggregator rejects duplicate `requestId`s. A replay of our own commitment returns `REQUEST_ID_EXISTS`, treated as idempotent-success (§7.3, §10.1).

9. **No revocation.** Once `v` is committed, it is permanent. Recovery returns the latest version; prior versions are ignored. OrbitDB CRDT on the OpLog side handles content-level conflict resolution.

10. **Timing side channels.** The aggregator observes publish and probe cadence. "This wallet has approximately `V` versions" is inferable from probe patterns; "this wallet is active now" is inferable from commit arrivals. Not mitigated at this layer. See `ARCHITECTURE §12`.

11. **Retry-rejected ciphertexts are sensitive.** A ciphertext computed for `(v, side)` that the wallet submits and the aggregator rejects with `REQUEST_ID_EXISTS` (because another device's commit landed first) shares `xorKey_{side, v}` with the committed ciphertext. An attacker who captures BOTH the rejected ciphertext (from local retry buffer, HTTP retry log, process memory, or crash dump) AND the committed ciphertext (from the aggregator) can XOR them to reveal the plaintext differential `partSide_ours XOR partSide_theirs`. Since CID bytes have low entropy in their prefix (varint version, multihash code) and `partA` additionally begins with a 1-byte `cidLen` prefix, this can leak most of both CIDs.

    Implementations MUST:

    a. Zeroize rejected ciphertexts **immediately** upon observing `REQUEST_ID_EXISTS` on either side. "Zeroize" means overwriting the backing buffer with zeros before releasing it; it MUST NOT be a no-op on any GC-backed runtime.
    b. NEVER log the raw ciphertext bytes at any verbosity level — including at debug/trace levels used in CI or development builds. Ciphertext-containing structures MUST be excluded from any serializer used for log emission.
    c. Treat the following intermediate values as SECRET. They MUST NOT appear in logs, error struct fields, persistent storage outside of the signing identity module, telemetry events, stack traces, or any crash-report capture surface:
       - `pointerSecret`
       - `signingSeed`
       - `xorSeed`
       - `padSeed`
       - `signingService.privateKey`
    d. RECOMMENDED: wrap the signing identity's private material in a `SecretKey` type that rejects `toString()` / `JSON.stringify()` / the default Node.js `util.inspect` hook / equivalent browser introspection paths.

---

## 12. Error Codes

| Code | Semantics | Raised by |
|---|---|---|
| `AGGREGATOR_POINTER_CONFLICT` | Both sides at `v` returned `REQUEST_ID_EXISTS` — genuine conflict. | §7.3, §9 |
| `AGGREGATOR_POINTER_STALE` | Discovered `V_true > localVersion` during reconciliation. Internal signal, not surfaced to callers. | §9.2 |
| `AGGREGATOR_POINTER_CORRUPT` | Decoded payload fails length-prefix bounds or CID validation. | §8.5, §10.3 |
| `AGGREGATOR_POINTER_NOT_FOUND` | Trustlessly verified exclusion proof returned for a probed `requestId`. | §8.1 |
| `AGGREGATOR_POINTER_PARTIAL` | One side accepted, the other failed with a non-retryable error. | §7.3, §10.1 |
| `AGGREGATOR_POINTER_REJECTED` | `AUTHENTICATOR_VERIFICATION_FAILED` or `REQUEST_ID_MISMATCH` from the aggregator. Non-retryable. | §7.3 |
| `AGGREGATOR_POINTER_RETRY_EXHAUSTED` | `PUBLISH_RETRY_BUDGET` consumed during conflict-retry loop. | §9 |
| `AGGREGATOR_POINTER_CID_TOO_LARGE` | `len(cidBytes) > CID_MAX_BYTES` (63). | §5.1 |
| `AGGREGATOR_POINTER_VERSION_OUT_OF_RANGE` | `v < VERSION_MIN` or `v > VERSION_MAX`. | §7 |
| `AGGREGATOR_POINTER_DISCOVERY_OVERFLOW` | Exponential probe reached `DISCOVERY_HARD_CEILING` and both sides at the ceiling were still included. | §8.2 |
| `AGGREGATOR_POINTER_NETWORK_ERROR` | Aggregator RPC unreachable / timed out (wraps SDK transport error). | §7, §8 |
| `AGGREGATOR_POINTER_UNTRUSTED_PROOF` | `InclusionProof.verify` returned `PATH_INVALID` or `NOT_AUTHENTICATED`. Non-retryable without operator review. | §8.1 |
| `AGGREGATOR_POINTER_UNREACHABLE_RECOVERY_BLOCKED` | Initialize couldn't reach aggregator; subsequent local writes accumulated; next publish blocked until (a) or (b) of §10.2.4. | §10.2 |
| `AGGREGATOR_POINTER_TRUST_BASE_DIVERGENCE` | Multi-mirror TOFU cross-check observed at least two mirrors returning non-byte-identical `RootTrustBase` values. Non-retryable without operator review. | §8.4 |
| `AGGREGATOR_POINTER_MARKER_CORRUPT` | `pending_version` marker failed integrity checks (e.g., `|cidHash| != 32`). | §7.1.5 |

---

## 13. API Surface for Consumers

```
interface ProfilePointerLayer {
  /**
   * Publish `cid` as the new latest pointer at version `nextVersion`.
   * Preconditions:
   *   - VERSION_MIN ≤ nextVersion ≤ VERSION_MAX
   *   - 1 ≤ len(cid) ≤ CID_MAX_BYTES
   * On Ok: both requestId_{A, nextVersion} and requestId_{B, nextVersion}
   *        committed to the aggregator; localVersion advanced; pending_version cleared.
   * Errors: AGGREGATOR_POINTER_CONFLICT, _PARTIAL, _REJECTED, _CID_TOO_LARGE,
   *         _VERSION_OUT_OF_RANGE, _NETWORK_ERROR, _UNREACHABLE_RECOVERY_BLOCKED.
   */
  publish(cid: Uint8Array, nextVersion: number): Promise<Result<{ version: number }>>

  /**
   * Discover and recover the latest CID pointer for this wallet.
   * Returns null-equivalent when no pointer has ever been published.
   * Errors: AGGREGATOR_POINTER_CORRUPT, _DISCOVERY_OVERFLOW, _NETWORK_ERROR,
   *         _UNTRUSTED_PROOF.
   */
  recoverLatest(): Promise<Result<{ cid: Uint8Array; version: number } | null>>

  /**
   * Run only the discovery phase (no payload fetch, no XOR-decode, no CID parse).
   * Errors: AGGREGATOR_POINTER_DISCOVERY_OVERFLOW, _NETWORK_ERROR, _UNTRUSTED_PROOF.
   */
  discoverLatestVersion(): Promise<Result<number>>

  /**
   * Cheap probe to learn whether the aggregator is reachable right now.
   * Used by the §10.2 blocking check.
   */
  isReachable(): Promise<boolean>

  /**
   * Query the persistent BLOCKED state (§10.2).
   * Preconditions: none.
   * Postconditions: returns true iff the wallet is in the publish-blocked
   *                 state per §10.2 (i.e., `BLOCKED_FLAG_KEY` is set, or
   *                 equivalently, the next `publish(...)` call would fail
   *                 with AGGREGATOR_POINTER_UNREACHABLE_RECOVERY_BLOCKED
   *                 ignoring any other failure modes).
   * Synchronous with respect to in-memory state; implementations MAY
   * cache the flag after initialize().
   */
  isPublishBlocked(): boolean
}
```

---

## 14. Test Vectors

**Status: templated.** The first implementation PR MUST compute exact bytes for every row in the table below and commit them to `docs/uxf/profile-aggregator-pointer.test-vectors.json` together with a `.sha256` checksum file for tamper detection. Reviewers from an independent implementation (Go, Rust) MUST be able to reproduce every row byte-for-byte from this spec alone.

**Owner of first-vector computation:** SDK team. **Blocking status:** NOT blocking on spec sign-off; blocking on implementation-PR merge.

### 14.1 Canonical vector #1 — inputs

| Input | Value |
|---|---|
| `walletPrivateKey` | `0x01` repeated 32 times (`0101...01`). Explicitly a test-only secret; private scalar is valid for secp256k1 (demonstrably `1 ≤ k < n`, since `k ≈ 7.2 × 10^74` — far below the curve order `n ≈ 1.158 × 10^77`). |
| `v` | `1` |
| `cidBytes` | CIDv1-raw of `"hello world"`. Computation: `sha256("hello world")` → 32-byte digest `0xb94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9`; then CIDv1 encoding: `0x01` (cid version) `\|\|` `0x55` (codec = raw) `\|\|` `0x12` (multihash algo = sha2-256) `\|\|` `0x20` (multihash length = 32) `\|\|` `<32-byte digest>` = **36 bytes total**. Implementers MUST publish the exact 36-byte string in the test vector file. |

> **Note on O-1.** To be computed and checksum-committed by the implementation PR. The inputs above are the canonical inputs; any implementation whose derivation produces different outputs for these inputs MUST be considered non-conformant. This is acceptable because O-1 is documented as "blocker on implementation-PR merge, NOT on spec sign-off" (§15.1).

### 14.2 Canonical vector #1 — derived values (to be filled with exact hex)

| Name | Shape | Expected value |
|---|---|---|
| `pointerSecret` | 32 B | `0x…` (to be computed) |
| `signingSeed` | 32 B | `0x…` |
| `xorSeed` | 32 B | `0x…` |
| `padSeed` | 32 B | `0x…` |
| `signingService` construction | — | `SigningService.createFromSecret(signingSeed)` — the SDK SHA-256-hashes the secret input; this is load-bearing for domain validity and MUST be used in preference to `new SigningService(...)` over raw seed bytes. |
| `signingPubKey` | 33 B (compressed secp256k1) | `0x02…` or `0x03…` |
| `stateHashDigest_A_1` | 32 B | `0x…` |
| `stateHash_A_1.imprint` | 34 B | `0x0000 \|\| stateHashDigest_A_1` |
| `stateHashDigest_B_1` | 32 B | `0x…` |
| `xorKey_A_1` | 32 B (SHA-256 of 40-byte preimage; bare digest, NOT HKDF-Expand) | `0x…` |
| `xorKey_B_1` | 32 B | `0x…` |
| `paddingBytes_1` | `63 − cidLen` = 27 B (HKDF-Expand of `padSeed` with info=`be32(1) \|\| "pad"`) | `0x…` |
| `full` | 64 B | `0x24 \|\| cidBytes \|\| paddingBytes_1` (where `0x24 = 36 = cidLen`) |
| `partA` | 32 B | `full[0..32)` |
| `partB` | 32 B | `full[32..64)` |
| `ctA` | 32 B | `xor(partA, xorKey_A_1)` |
| `ctB` | 32 B | `xor(partB, xorKey_B_1)` |
| `requestId_A_1` | 32 B (SHA-256 of 67-byte preimage: `signingPubKey \|\| [0x00,0x00] \|\| stateHashDigest_A_1`) | `0x…` |
| `requestId_B_1` | 32 B | `0x…` |
| `authenticator_A_1.signature` | 65 B (`r \|\| s \|\| recoveryId`) | `0x…` |
| `authenticator_B_1.signature` | 65 B | `0x…` |

### 14.4 Canonical vector #2 — inputs

Second canonical vector with a distinct non-trivial key, to verify that derivations are not accidentally hard-coded to the all-0x01 key.

| Input | Value |
|---|---|
| `walletPrivateKey` | `SHA-256(bytes_of("uxf-profile-pointer-test-2"))` (32 bytes). Computed as the SHA-256 digest of the ASCII string `uxf-profile-pointer-test-2` with no null terminator. Implementations MUST verify that the computed scalar satisfies `1 ≤ k < n` (overwhelmingly likely for a random SHA-256 output); reject and report a test-setup error otherwise. |
| `v` | `1` |
| `cidBytes` | Same 36-byte CIDv1-raw-sha256 of `"hello world"` as §14.1. |

### 14.5 Canonical vector #2 — derived values (to be filled with exact hex)

Every row from §14.2 repeats with the vector-2 inputs. Format and conformance expectation identical. To be computed and checksum-committed by the implementation PR.

### 14.3 Format requirements

- File: `docs/uxf/profile-aggregator-pointer.test-vectors.json`.
- Encoding: JSON with hex strings (no `0x` prefix) for byte fields.
- Integrity: sibling file `profile-aggregator-pointer.test-vectors.json.sha256` containing a single SHA-256 of the JSON file in lowercase hex.
- CI MUST verify the checksum on every build touching the test-vectors file.

---

## 15. Open Items (after revision 3)

Most revision-1 questions are resolved:

| Prior # | Resolution |
|---|---|
| Q-1 Signing algorithm | **Resolved:** secp256k1 only, via `SigningService` (Ed25519 removed). |
| Q-2 Signing seed path | **Resolved:** dedicated `signingSeed` subkey (§4.2), not shared with `xorSeed` or `padSeed`. |
| Q-3 RequestId formula | **Resolved:** `RequestId.createFromImprint(signingPubKey, stateHash.imprint)` — 67-byte preimage including the 2-byte `[0x00, 0x00]` algorithm tag. |
| Q-4 Length-hint strategy | **Resolved:** Option (a), 1-byte length prefix inside XOR-masked plaintext. |
| Q-5 `sha256` tag on `transactionHash` | **Resolved:** keep the tag; aggregator treats digest as opaque. |
| Q-6 Discovery probe scope | **Resolved:** both sides per probe, with mandatory trustless verification. |
| Q-7 Partial-publish policy | **Resolved:** retry same `(v, side)` with identical deterministic bytes; never skip `v` on retryable errors. |
| Q-8 Trust base requirement | **Resolved:** mandatory `InclusionProof.verify(trustBase, requestId)`; TOFU accepted for v1 first-boot only. |

### 15.1 Remaining open items

| # | Item | Owner | Blocking? |
|---|---|---|---|
| O-1 | Compute exact bytes for every row in §14.2 and §14.5 (both canonical vectors), commit `test-vectors.json` + `.sha256`. Inputs are frozen in §14.1 and §14.4; outputs to be computed and checksum-committed by the implementation PR. | SDK team | **Blocking on implementation-PR merge. NOT blocking spec sign-off.** |
| O-2 | Select / specify the `RootTrustBase` source (static bundled, remote-fetched, hybrid). | Aggregator team | Yes (must be resolved before first release). |
| O-3 | Tune `DISCOVERY_INITIAL_VERSION` against real wallet publish-rate data after 4 weeks of field use. | SDK team | No (ship-time default is acceptable). |
| O-4 | Decide whether `isValidCid` accepts codecs beyond sha2-256 multihashes (track upstream `profile/ipfs-client.ts`). | SDK team | No. |
| O-5 | BLOCKED state override protocol — confirm whether v1 ships with the opt-in override (§10.2.5) or omits it entirely. | Product / SDK team | **Not blocking.** |
| O-6 | Mirror URL list for multi-mirror TOFU cross-check — finalize the static mirror list and embed in the Sphere SDK config (referenced from §8.4). | Infra team | **Blocking on implementation-PR merge.** |

### 15.2 Reviewer sign-off checklist

Revision 3 is **Stable** only after the following checkboxes are explicitly ticked. Comments MUST be attached to any unchecked item.

- [ ] **Security auditor** — subkey separation (§4.2), one-time-pad discipline + crash-retry marker (§7.1, §11.2), deterministic padding rationale (§4.6, §11.3), TOFU acceptance (§8.4, §11.5) reviewed and approved.
- [ ] **Aggregator team** — `SubmitCommitmentRequest` / `SubmitCommitmentResponse` usage (§6.5), `REQUEST_ID_EXISTS` idempotent-replay handling (§7.3, §10.1), `RootTrustBase` source (O-2) reviewed and approved.
- [ ] **Unicity architect** — alignment with `state-transition-sdk` surface (`SigningService`, `DataHash`, `DataHasher`, `RequestId`, `Authenticator`, `InclusionProof`, `AggregatorClient`, `RootTrustBase`) reviewed; no drift from SDK semantics.
- [ ] **SDK team** — test vectors computed (§14, O-1), checksum committed, CI verifies.
- [ ] **Spec editor** — constants in §3 locked; error codes in §12 complete; cross-references to companion architecture doc match section-for-section.

---

## 16. Change Log

| Revision | Summary |
|---|---|
| 1 (initial draft) | Initial design: HKDF subkey separation, two-leaf plain commitments, XOR masking, version-numbered publish with crash-safety marker, probe-both-sides discovery. |
| 2 | Reviewer findings applied; locked on secp256k1 (Ed25519 removed); `RequestId.createFromImprint` formula pinned with explicit 67-byte preimage including the 2-byte algorithm tag; deterministic padding; trustless proof verification mandatory with TOFU accepted for v1 first-boot only. |
| 3 | **Steelman review fixes F1–F11 per commit b9545ab.** F1: `.proof.` → `.inclusionProof.` throughout probe/recovery pseudocode. F2: split `(EXISTS, EXISTS)` outcome row into idempotent-replay vs genuine-conflict branches based on `pending_version` marker match. F3: hardened §7.1 pending-version discipline (exclusive mutex, per-wallet scoping, durability, rollback-safe `v` bump, integrity-checked `cidHash`, marker-clear atomicity). F4: formalized §10.2 BLOCKED state (persistent flag, categorical-error SET conditions, strict CLEAR conditions, user-originated-write definition, optional per-call operator override). F5: async-`digest()` convention footnote added to §4 header. F7: multi-mirror TOFU cross-check added to §8.4; `AGGREGATOR_POINTER_TRUST_BASE_DIVERGENCE` registered in §12. F8: retry-rejected-ciphertext secrecy requirements added to §11.11 (zeroize, no-log, `SecretKey` wrapper). F9: canonical test-vector inputs inlined for vectors #1 (all-0x01 key, CIDv1-raw of "hello world") and #2 (`SHA-256("uxf-profile-pointer-test-2")`). F10: O-1 demoted to "blocking on impl-PR merge only"; O-5 (BLOCKED override), O-6 (mirror list) added. F11: `isPublishBlocked(): boolean` added to §13 API surface. Additional constant registrations in §3: `MUTEX_KEY`, `PENDING_VERSION_KEY`, `BLOCKED_FLAG_KEY`. Additional error code: `AGGREGATOR_POINTER_MARKER_CORRUPT`. Section numbering preserved where possible; §14 added subsections §14.4 / §14.5 without renumbering the existing §14.3. |
