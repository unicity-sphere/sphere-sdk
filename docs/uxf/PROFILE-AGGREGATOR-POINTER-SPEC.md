# UXF Profile Aggregator Pointer — Technical Specification

**Status:** Draft — revision 3.4 (embedded `RootTrustBase` deployment model on top of revision 3.3; multi-mirror TOFU + mirror-list infrastructure deferred to v2; SDK-native; secp256k1-only)
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

> **Note (v3.4).** The pointer layer uses the embedded `RootTrustBase` from `assets/trustbase/<network>.ts` (same as L4 / `PaymentsModule` per §8.4.2). Multi-mirror TOFU constants (`MIN_MIRROR_COUNT`, `MIRROR_LIST_SHA256`, `MIRROR_CERT_PINS`) were deleted in v3.4 — see the §8.4 amendment. Runtime-fetched trust-base integrity (mirror-list hash, TLS cert pinning, CA/IP diversity) and the associated multi-mirror TOFU cross-check apply only to the v2 roadmap item described in `PROFILE-AGGREGATOR-POINTER-ARCHITECTURE.md §12` (L1-alpha-anchored trust fingerprint).

| Name | Value | Units | Notes |
|---|---|---|---|
| `PROFILE_POINTER_HKDF_INFO` | `bytes_of("uxf-profile-aggregator-pointer-v1")` | 33 bytes | Domain-separation label for the pointer-layer PRK. Versioned (`v1`). |
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
| `MUTEX_KEY` | `"profile.pointer.publish.lock." + hex(signingPubKey)` | string (templated) | Per-wallet exclusive publish mutex identifier (§7.1.1). |
| `PENDING_VERSION_KEY` | `"profile.pointer.pending_version." + hex(signingPubKey)` | string (templated) | Per-wallet crash-safety marker key (§7.1.2). |
| `BLOCKED_FLAG_KEY` | `"profile.pointer.blocked." + hex(signingPubKey)` | string (templated) | Per-wallet persistent BLOCKED-state flag key (§10.2). Boolean; absent ≡ `false`. |
| `MARKER_MAX_JUMP` | `1024` | versions | Maximum allowed gap between `previousEntry.v` and `currentLocalVersion` before the marker is treated as corrupt (§7.1.4). |
| `MAX_CT_RESIDENT_MS` | `500` | ms | Maximum in-memory retention of a rejected retry ciphertext before it MUST be zeroized and re-derived (§11.11(a′)). |
| `MAX_CAR_BYTES` | `100 * 1024 * 1024` | bytes (100 MiB) | Maximum CAR byte size the IPFS client MUST enforce on fetch (§8.5). |
| `MAX_CAR_FETCH_INITIAL_RESPONSE_MS` | `10000` | ms | Maximum time from request to first response headers (§8.5). |
| `MAX_CAR_FETCH_STALL_MS` | `30000` | ms | Maximum interval between received bytes (§8.5). |
| `MAX_CAR_FETCH_TOTAL_MS` | `300000` | ms (5 min) | Absolute cap on a single CAR fetch including retries (§8.5). Replaces the former `MAX_CAR_FETCH_MS = 60000` progress-unaware timeout; see H10 in §16. |
| `MAX_CAR_FETCH_RETRY` | `3` | attempts | Per-gateway retry budget for CAR fetch on transient failure (§8.5, §8.2 Phase 3). |
| `MAX_CAR_FETCH_RETRY_BACKOFF_BASE_MS` | `500` | ms | Base delay for exponential backoff between CAR fetch retries. |
| `CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS` | `12` | attempts | Hourly retries across the full gateway set over `CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS` before `acceptCarLoss()` may be invoked (§10.7). |
| `CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS` | `86400000` | ms (24 h) | Minimum wall-clock duration of persistent-retry window before `acceptCarLoss()` may be invoked (§10.7). Persisted across restarts. |
| `POINTER_PEER_DISCOVERY_MS` | `600000` | ms (10 min) | Peer availability poll window on OrbitDB gossipsub / Nostr before `acceptCarLoss()` may advance (§10.7). |
| `DISCOVERY_CORRUPT_WALKBACK` | `64` | versions | Maximum number of consecutive corrupt (undecodable / non-CID / non-fetchable) versions to skip during §8.2 Phase 3 walk-back before bailing with `AGGREGATOR_POINTER_CORRUPT_STREAK` (§10.8). A distinct error from ordinary `AGGREGATOR_POINTER_CORRUPT`, intended to distinguish a pathological OpLog (long tail of consecutive prior-client bugs or adversarial grinding) from ordinary one-off corruption. Implementations MAY tune this higher under explicit operator consent via `acceptCorruptStreak()` (§13). |
| `PUBLISH_REQUEST_TIMEOUT_MS` | `30000` | ms | Per-request timeout for `submitCommitment` RPC (W4). |
| `PROBE_REQUEST_TIMEOUT_MS` | `10000` | ms | Per-request timeout for `getInclusionProof` during probes (W4). |
| `IPNS_RESOLVE_TIMEOUT_MS` | `20000` | ms | Per-resolution timeout for IPNS lookups (W4). |

All constants are locked. Any change is a spec bump and requires the `v1` → `v2` rename of `PROFILE_POINTER_HKDF_INFO`.

---

## 4. Key Derivation

All derivations are deterministic pure functions of the wallet's 32-byte secp256k1 private key `walletPrivateKey` and the target version `v` (and side, where applicable). No other inputs, no clock, no nonce, no RNG.

> **Pseudocode async convention (applies throughout §4, §6.4, §7.2, §8.1, §8.5).** All asynchronous SDK calls in this specification — including `DataHasher.digest()`, `SigningService.createFromSecret`, `RequestId.createFromImprint`, `RequestId.create`, `Authenticator.create`, and `aggregatorClient.submitCommitment` / `getInclusionProof` — return `Promise<T>` and MUST be awaited by implementations. Pseudocode below omits explicit `await` keywords for readability; treat every SDK call as implicitly awaited. Example: `(await DataHasher(SHA256).update(x).digest()).data` rather than the literal `DataHasher(SHA256).update(x).digest().data` chain that appears in tables.
>
> **`DataHasher(X)` constructor convention.** Throughout this spec, the pseudocode `DataHasher(X)` denotes `new DataHasher(X)`; the `new` keyword is omitted for readability.

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

**W1 — BIP32 key position (normative).** `walletPrivateKey` MUST be the 32-byte BIP32 master private key derived from the wallet's mnemonic (not a child key, not an address-level leaf key). This matches `PROFILE-ARCHITECTURE.md §2.1`'s global-keys model, where `identity.masterKey` is wallet-scoped and shared across HD addresses. Implementations that derive `pointerSecret` from any other key position (e.g., `m/44'/coin'/0'` or an address leaf) produce a different pointer chain and break interoperability across Sphere releases.

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
response = await aggregatorClient.submitCommitment(
  /* requestId       */ requestId_{side, v},
  /* transactionHash */ transactionHash_{side, v},
  /* authenticator   */ authenticator_{side, v},
  /* receipt         */ false
)
```

The RPC method name, positional argument order, and JSON body layout are owned by the SDK (see `AggregatorClient.submitCommitment` and `SubmitCommitmentRequest.toJSON`). This spec does not re-specify them. Note: `AggregatorClient.submitCommitment` accepts the four fields positionally; do NOT construct a standalone `SubmitCommitmentRequest` instance to pass — the client's method signature takes `(requestId, transactionHash, authenticator, receipt)` directly.

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

**7.1.1 Cross-context mutual exclusion (tightened in H3).** The sequence "read `pending_version` → compute XOR payload → submit both sides → update `pending_version`" MUST hold an exclusive per-wallet mutex across ALL execution contexts that share the wallet's storage (browser tabs, Node processes, service workers). Without this, two concurrent publish pipelines (e.g., debounced flush timer + manual sync, or two open tabs against the same IndexedDB) can produce OTP-reuse by both deriving payloads under the same `(v, side, xorKey)` with different plaintexts.

Mutex key:

```
MUTEX_KEY = "profile.pointer.publish.lock." + hex(signingPubKey)
```

**Browser runtime.** Implementations MUST use the Web Locks API:

```
navigator.locks.request(MUTEX_KEY, { mode: 'exclusive' }, asyncCallback)
```

If the Web Locks API is unavailable (pre-Chrome-69 / pre-Safari-15.4 browsers), implementations MUST refuse to initialize the pointer layer with `AGGREGATOR_POINTER_UNSUPPORTED_RUNTIME`.

**Node.js runtime.** Implementations MUST acquire an exclusive file lock (e.g., `proper-lockfile`) at the path `<dataDir>/profile/<hex(signingPubKey)>/publish.lock`, held for the duration of the publish critical section. The lock file MUST be created with `O_EXCL` semantics. Stale locks (process died without releasing) are detected via the standard `proper-lockfile` stale-lock timeout and are force-breakable only after `PUBLISH_BACKOFF_MAX_MS * 2 = 8000 ms`.

**Cross-process contention.** If the lock is held by another process or tab, implementations MUST back off with jittered retry up to `PUBLISH_RETRY_BUDGET` attempts before surfacing `AGGREGATOR_POINTER_PUBLISH_BUSY`.

**Critical-section boundary.** The lock MUST be acquired BEFORE reading `pending_version` and released ONLY AFTER both `localVersion` persist AND marker clear have completed (per §7.1.6 ordering). An identity change (`setIdentity()`) or `disconnect()` during the critical section MUST wait on the lock; the mutex being keyed on `hex(signingPubKey)` ensures a different identity acquires a different lock and does not block the outgoing publish.

**7.1.2 Per-wallet scoping of the marker.** The pending-version slot MUST be namespaced by the pointer layer's signing pubkey so that multi-wallet devices never share a single slot:

```
PENDING_VERSION_KEY = "profile.pointer.pending_version." + hex(signingPubKey)
```

See §3 for the constant registration.

**7.1.3 Durability.** The `pending_version` write MUST be durable (fsync / flush-completed) BEFORE any downstream derivation runs. For IndexedDB this means awaiting `transaction.oncomplete`; for file-based storage, explicit `fsync`. Storage backends that cannot guarantee durability MUST refuse to initialize the pointer layer.

**7.1.4 Rollback-safe version selection (tightened in H13).** The marker read + v-bump logic is:

```
cidHash := SHA-256(cidBytes)
previousEntry := storage.read(PENDING_VERSION_KEY)
if previousEntry is not null:
    // Idempotent-replay case (H13, matches arch §7.2): same v AND same cid →
    // this is our own crashed publish resuming. KEEP v, re-derive the
    // deterministic payload from (§4.6), and re-submit. The aggregator's
    // write-once keying on requestId yields idempotence for free.
    if previousEntry.v == v AND previousEntry.cidHash == cidHash:
        /* no bump; proceed with idempotent retry */

    // Stale-localVersion case: marker is behind current state (e.g., crash
    // after localVersion persist but before marker clear per §7.1.6).
    elif previousEntry.v < currentLocalVersion:
        clear previousEntry
        /* marker discarded as stale; use v unchanged */

    // Rollback-safe bump: legitimate marker ahead of current v OR different
    // cid at the same v (the OTP-reuse danger case). Clamped by
    // MARKER_MAX_JUMP (C1) below; additionally post-clamped by H4 against
    // latest_included_V (§8.2) in the caller.
    else:
        v := max(v, previousEntry.v) + 1

    // Tamper check (C1): gap exceeds clamp → marker corrupt. Runs AFTER
    // the cases above so that a legitimate idempotent retry whose marker
    // was written before a localVersion rollback is not mis-classified.
    if previousEntry.v > currentLocalVersion + MARKER_MAX_JUMP:
        clear previousEntry
        raise AGGREGATOR_POINTER_MARKER_CORRUPT

// Record marker for crash safety (durable per 7.1.3).
storage.write(PENDING_VERSION_KEY, { v, cidHash })
```

This closes the "localVersion rolled back by tamper/corruption" path where the previous `v == v && cidHash != cidHash` check fell through silently, while preserving the idempotent-retry case described in `PROFILE-AGGREGATOR-POINTER-ARCHITECTURE.md §7.2` (a crashed publisher resuming with the same CID MUST keep its v so that re-derivation produces byte-identical ciphertext and the aggregator returns `REQUEST_ID_EXISTS` harmlessly).

**Rationale for the clamp (C1, tightened in D4).** Without this check a single malicious or corrupted marker write (e.g., `previousEntry.v = 2^31 − 2`) would propagate into `v := previousEntry.v + 1 = 2^31 − 1`, and the next legitimate publish would require `v = 2^31`, which exceeds `VERSION_MAX` and surfaces as `AGGREGATOR_POINTER_VERSION_OUT_OF_RANGE` — permanently bricking the wallet from a single bad write. A legitimate marker gap is bounded by:

- `PUBLISH_RETRY_BUDGET = 5` — per-attempt bumps during a conflict-retry arc (§9).
- Small cohort contention allowances — multi-device races typically chain ≤ 32 bumps (§9.2 reconciliation at `V_true + 1` across a 32-way active cohort).
- Headroom for unusual-but-legitimate scenarios: manual backup/restore from another device, OrbitDB manifest reorgs, test-vector switches, and operator-initiated network migrations.

`MARKER_MAX_JUMP = 1024` is sized generously (approximately 32× the typical ≤ 32 ceiling) to avoid false-positives on these legitimate-but-unusual flows, at the cost of NOT catching subtle same-window tampering within `[prev.v, prev.v + 1024]`. Tighter thresholds (e.g., 32) are suitable for deployments that can afford to surface `AGGREGATOR_POINTER_MARKER_CORRUPT` on legitimate manual backup-restore flows; operators who lower `MARKER_MAX_JUMP` below 1024 MUST also add explicit UX surfacing of the `clearPendingMarker()` API (§13) for backup-restore scenarios, otherwise a legitimate user restoring state across devices will face an opaque error with no recovery path. See §11.13 item 3 for the documented residual risk.

Recovery from `AGGREGATOR_POINTER_MARKER_CORRUPT` (regardless of threshold) is via the operator-facing `clearPendingMarker()` API (§13).

**7.1.5 cidHash integrity.** Implementations MUST NOT truncate the `cidHash`. A marker with `|cidHash| != 32` MUST be treated as corrupt and the publish refused with `AGGREGATOR_POINTER_MARKER_CORRUPT`.

**7.1.6 Marker clear atomicity.** When a successful publish persists `localVersion = v` and clears the marker, BOTH writes SHOULD occur in a single atomic transaction if the storage backend supports it. If they cannot be atomic, the persistence order is:

1. Write `localVersion = v`.
2. Clear `PENDING_VERSION_KEY`.

A crash between (1) and (2) leaves a stale marker at the just-completed `v`, which §7.1.4 will correctly compact on next publish (the `previousEntry.v < currentLocalVersion` branch).

**Threat defended.** Partial execution + process restart with a different CID. Without this marker, a crashed publisher could re-enter with a new CID at the same `v`, reusing `xorKey_{side, v}` against a different plaintext — a trivial OTP break if both plaintexts ever hit the SMT.

The `pending_version` slot is cleared only after a successful publish (§7.3, per 7.1.6) or after the publisher definitively abandons the version (e.g., `REQUEST_ID_MISMATCH` — non-retryable).

**7.1.7 Identity discipline during the critical section (W5).** At publish critical-section entry, the implementation MUST capture `signingPubKey`, `walletPrivateKey`, and all keyed derivations (`pointerSecret`, `signingSeed`, `xorSeed`, `padSeed`, `signingService`) into local constants. These MUST NOT be re-read from a shared identity source during the critical section. Calls to `Sphere.setIdentity()` / `switchToAddress()` while the publish lock is held MUST be queued — they MUST NOT change the publisher's captured key mid-flight. The `MUTEX_KEY` keyed on `hex(signingPubKey)` (§7.1.1) ensures this ordering across async boundaries: a concurrent identity switch that takes the lock for a different signing pubkey does not block the in-flight publish, but a switch targeting the SAME pubkey waits on the lock.

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
| `AUTHENTICATOR_VERIFICATION_FAILED` or `REQUEST_ID_MISMATCH` (either side) | (any) | **Non-retryable and v-burning (H8).** Persist `localVersion = v` (BURN this `v` — it is permanently consumed even though the commit failed); clear `pending_version`. Raise `AGGREGATOR_POINTER_REJECTED { v, failedSide, reason }`. **Rationale:** the OTHER side may have already been accepted by the aggregator at `(v, other_side)` — the aggregator's write-once `requestId` semantics mean that ciphertext is permanently in the SMT. A retry at the same `v` with different `cidBytes` would reuse `xorKey_{side,v}` with a different plaintext, producing an OTP-reuse vulnerability. Burning `v` forces the next publish to use `v+1` with fresh keys. |
| HTTP 429 / 503 with `Retry-After` header (either side) | (any) | Honor `Retry-After` (cap 600 s). Do NOT consume a retry-budget slot. Do NOT SET BLOCKED. Retry same `(v, side)` with identical payload. |
| HTTP 5xx without `Retry-After` (either side) | (any) | Retry with jittered exponential backoff (§7.4) up to `PUBLISH_RETRY_BUDGET`. Counts as a retry-budget slot. |
| HTTP 4xx other than 429 (either side) | (any) | Permanent failure. Raise `AGGREGATOR_POINTER_AGGREGATOR_REJECTED`. Do NOT retry. (W3) |
| JSON-RPC error code `-32006 ConcurrencyLimit` (either side) | (any) | Treat as synthetic HTTP 503 with `Retry-After: 1s` (aggregator overloaded; brief back-off). |
| JSON parse failure / missing required fields | (any) | Raise `AGGREGATOR_POINTER_PROTOCOL_ERROR`. Do NOT advance `localVersion`. Retry after longer backoff (30 s). |
| Unknown `SubmitCommitmentStatus` enum value (forward-compat hazard) | (any) | Raise `AGGREGATOR_POINTER_PROTOCOL_ERROR`. Fail closed. |

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

    return aIncluded OR bIncluded                    // H2 — OR-monotonic predicate
```

**H2 — OR-monotonic predicate.** The probe returns `aIncluded OR bIncluded`, matching invariant I-1 ("at every `V' ≤ V_true`, at least one side is included"), which is monotonic under partial-publish residue. The earlier `AND` predicate was non-monotonic: a partial-residue version (one side committed, the other absent) could cause the Phase-2 binary search to converge to a stale `V_true`, orphaning bundles. Phase 3 (§8.2) already enforces the stricter validity check (BOTH sides + XOR-decodable + IPFS-fetchable + CAR-deserializable) via `classifyVersion(v)`, so partial-residue versions are correctly walked past there.

Probing both sides per step still defends against partial-publish ambiguity at recovery: a single-side probe could be misled by a half-published `v` into ambiguous interpretation. With BOTH proofs fetched and verified per probe, Phase 3 has all the material it needs to classify the version definitively.

### 8.2 Discovery algorithm — valid-version continuity (D1)

Discovery returns the **latest VALID version**, not simply the latest-included version.

**Definition — "valid version".** A version `v` is valid iff ALL of the following hold:

1. Both `requestId_{A, v}` and `requestId_{B, v}` have verified inclusion proofs from the aggregator (i.e., `probe(v) == true` per §8.1).
2. After XOR-decoding both halves (§8.5), the resulting 64-byte `full` buffer has a length prefix `cidLen ∈ [1, CID_MAX_BYTES]`.
3. `full[1 .. 1 + cidLen)` parses as a valid CID (sha2-256 multihash, within-buffer bounds, well-formed varints per §8.5).
4. The decoded CID is fetchable from IPFS via `fetchFromIpfs(cid)` with both `MAX_CAR_BYTES` and `MAX_CAR_FETCH_MS` caps satisfied.
5. The fetched CAR bundle deserializes successfully as a UXF package.

A version that is included (condition 1) but fails ANY of (2)–(5) is **invalid / corrupt**. Corrupt versions are permanent SMT residue; they are semantically IGNORED by discovery — the pointer layer considers the latest VALID version to be authoritative.

Phase 1 uses the locally persisted `localVersion` as a lower-bound hint when available; otherwise starts from 0. Phases 1 and 2 use inclusion-only (`probe(v)`) to bracket the latest-included version. Phase 3 walks backwards through any corrupt trailing versions to find the latest valid one.

```
findLatestValidVersion():                           # H4 — returns { validV, includedV }
    # Phase 1 — exponential expansion: find an upper bound using OR-monotonic probe
    lo = max(0, localVersion)
    hi = max(DISCOVERY_INITIAL_VERSION, lo + 1)

    while await probe(hi):                          # H2 — probe = aIncluded OR bIncluded
        lo = hi
        hi = hi * 2
        if hi > DISCOVERY_HARD_CEILING:
            if await probe(DISCOVERY_HARD_CEILING):
                raise AGGREGATOR_POINTER_DISCOVERY_OVERFLOW
            hi = DISCOVERY_HARD_CEILING
            break

    # Invariant after Phase 1: probe(lo) == true (or lo == 0) AND probe(hi) == false

    # Phase 2 — binary search for latest INCLUDED version
    while hi - lo > 1:
        mid = (lo + hi) / 2                        # integer division, rounded down
        if await probe(mid):
            lo = mid
        else:
            hi = mid
    includedV = lo                                  # latest INCLUDED version (may be corrupt)
    candidate = includedV

    # Phase 3 — walk back through SEMANTICALLY-INVALID versions only (H1).
    # Transient-unavailable versions propagate up as AGGREGATOR_POINTER_CAR_UNAVAILABLE
    # so we do NOT skip past them — tokens at those versions may still exist.
    walked = 0
    while candidate > 0 and walked < DISCOVERY_CORRUPT_WALKBACK:
        status = await classifyVersion(candidate)   # see helper below
        if status == VALID:
            return { validV: candidate, includedV: includedV }
        elif status == SEMANTICALLY_INVALID:
            emit pointer:discover_corrupt_skipped { version: candidate, reason: "invalid" }
            candidate = candidate - 1
            walked = walked + 1
        else:                                       # TRANSIENT_UNAVAILABLE
            # Tokens at this version may still exist; do NOT walk back.
            # Surface up so the caller can retry later or enter §10.7 handling.
            raise AGGREGATOR_POINTER_CAR_UNAVAILABLE { version: candidate }

    if candidate == 0:
        return { validV: 0, includedV: includedV }  # no valid version exists

    # Too many consecutively SEMANTICALLY_INVALID versions — bail out.
    raise AGGREGATOR_POINTER_CORRUPT_STREAK         # see §10.8

# H1 — three-way classification helper (replaces the old isVersionValid binary check).
classifyVersion(v) -> { VALID, SEMANTICALLY_INVALID, TRANSIENT_UNAVAILABLE }:
    # (1) Inclusion proofs: fetch from the configured aggregator and verify via
    #     InclusionProof.verify(trustBase, requestId). MUST be OK on both sides.
    (statusA, statusB) = verify both inclusion proofs (§8.1)
    if either side missing / invalid inclusion proof:
        # Partial-residue or truly absent at this v — treated as semantically invalid
        # for Phase 3 purposes (the XOR decode below cannot produce a valid CID).
        return SEMANTICALLY_INVALID

    # (2) XOR-decode; length-prefix or CID parse failure → SEMANTICALLY_INVALID.
    try:
        cidBytes = reconstruct-cid (§8.5)
    except AGGREGATOR_POINTER_CORRUPT:
        return SEMANTICALLY_INVALID

    # (3) Fetch CAR from IPFS with MAX_CAR_FETCH_RETRY per gateway and
    #     exponential backoff (MAX_CAR_FETCH_RETRY_BACKOFF_BASE_MS).
    carResult = fetchFromIpfs(cidBytes) with per-gateway retries (§8.5)

    if carResult == all_gateways_network_error_or_timeout_or_5xx:
        return TRANSIENT_UNAVAILABLE
    if carResult == content_address_mismatch (CID hash ≠ bytes digest):
        return SEMANTICALLY_INVALID                 # content-address verification failed
    if carResult == car_deserialization_failed:
        return SEMANTICALLY_INVALID

    return VALID
```

**Return shape (H4).** `findLatestValidVersion()` returns `{ validV, includedV }`:
- `validV` — the latest version that passes full validation (Phases 1+2+3). `0` if no valid version exists.
- `includedV` — the latest version with inclusion proofs on at least one side (Phase 2 result, before walk-back).

Invariant after a successful return: either `validV == 0` (no pointer ever published) OR `classifyVersion(validV) == VALID` AND every version in `(validV, includedV]` was `SEMANTICALLY_INVALID` and skipped (Phase 3 never walks past a `TRANSIENT_UNAVAILABLE` version).

**Why three-way classification (H1).** The prior two-way `isVersionValid` walked back on ANY CAR-fetch failure including transient (gateway outage, 5xx, network timeout). This could ORPHAN TOKENS during a temporary IPFS gateway outage — the legitimate latest version would be skipped, and a subsequent publish at walked-back-V+1 would strand the skipped version's inventory. The three-way classification:
- **VALID** — fully reconstructible; return this version.
- **SEMANTICALLY_INVALID** — permanent residue (unparseable CID, content-address mismatch, failed CAR deserialization). Skip and continue walk-back.
- **TRANSIENT_UNAVAILABLE** — all configured IPFS gateways returned network errors, timeouts, or 5xx after `MAX_CAR_FETCH_RETRY = 3` attempts per gateway with exponential backoff. Surface as `AGGREGATOR_POINTER_CAR_UNAVAILABLE` so §10.7 handles it correctly; DO NOT walk back.

**H4 — publisher uses `max(validV, includedV) + 1`.** The caller of §9 reconciliation MUST target `max(validV, includedV) + 1` as the next publish version. If the SMT has corrupt-included residue at `validV + 1` from a prior buggy client, publishing at `validV + 1` would get `REQUEST_ID_EXISTS`, re-trigger §9 reconciliation, re-discover the same `validV`, and retry at the same v — an infinite loop that exhausts `PUBLISH_RETRY_BUDGET` with `AGGREGATOR_POINTER_RETRY_EXHAUSTED`. Skipping past corrupt-included residue by using `includedV + 1` breaks this deadlock cleanly.

### 8.3 Probe count bounds and walk-back cost

The §8.2 algorithm has three phases; the first two use inclusion-only `probe(v)`, the third uses the more expensive `isVersionValid(v)` (includes XOR decode + CID parse + IPFS fetch + CAR deserialization).

- Phase 1 (exponential): at most `log2(DISCOVERY_HARD_CEILING / max(1, lo)) + 1` doublings. Each doubling = one inclusion `probe`.
- Phase 2 (binary search): at most `log2(hi − lo) ≤ 22` iterations. Each iteration = one inclusion `probe`.
- Phase 3 (walk-back): at most `DISCOVERY_CORRUPT_WALKBACK` iterations, each calling `classifyVersion(v)` (H1). In the common case (no corruption), Phase 3 completes in a single iteration and the returned `validV` matches the Phase 2 `includedV`.
- Each `probe` = 2 parallel aggregator round trips + 2 parallel local verifications.
- Each `classifyVersion` = 1 `probe` + 1 IPFS fetch with up to `MAX_CAR_FETCH_RETRY` per gateway (bounded by `MAX_CAR_BYTES` / `MAX_CAR_FETCH_TOTAL_MS`) + 1 CAR deserialization.

A version that is included but classified `SEMANTICALLY_INVALID` is called "corrupt" throughout the remainder of this spec (see §10.3 and §10.8). A version classified `TRANSIENT_UNAVAILABLE` is NOT corrupt — the walk halts and `AGGREGATOR_POINTER_CAR_UNAVAILABLE` propagates up so §10.7 handles it.

### 8.4 Trustless proof verification (MANDATORY)

Every `InclusionProofResponse` returned by `AggregatorClient.getInclusionProof` MUST be verified via:

```
resp    = await aggregatorClient.getInclusionProof(requestId)
status  = await resp.inclusionProof.verify(trustBase, requestId)   // InclusionProofVerificationStatus
```

Where `trustBase` is a `RootTrustBase` obtained as described in the **embedded trust-base anchor** rule below. The wallet MUST NOT accept inclusion or exclusion claims based on unverified responses. (Editorial note C12: the variable is `resp.inclusionProof` — matching §8.1 — not a locally-named `proof`; this avoids ambiguity with the r2 `.proof.` field-access bug fixed by F1/r3.)

**Embedded trust-base anchor (v3.4 — replaces multi-mirror TOFU).** The SDK ships a statically bundled `RootTrustBase` in `assets/trustbase/<network>.ts` (loaded via `impl/shared/trustbase-loader.ts`). This same bundled trust base is the one L4 / `PaymentsModule` already consumes through `OracleProvider` in the current Sphere deployment. The pointer layer behavior is:

1. **First boot.** Load `RootTrustBase` from the SDK-bundled asset. **No network fetch** occurs to obtain it.
2. **Pinning / subsequent boots.** The pinned value MAY be cached in local storage to survive across sessions, but its *initial* source of truth is the SDK bundle itself. Replacing the pinned value with a runtime-fetched one is NOT performed in v1.
3. **Rotation.** Rotation is detected via the `epoch` field embedded in returned proofs (see §8.4.1). Because the trust base is bundled, the remediation path is to ship a new SDK release whose bundled `RootTrustBase` carries the new epoch. A runtime-refresh flow fetching a fresh trust base from a canonical source is a future hardening (tied to the v2 L1-alpha-anchored trust-fingerprint work; see `PROFILE-AGGREGATOR-POINTER-ARCHITECTURE.md §12`).

Implementations MUST NOT invent a parallel trust-base provider for the pointer layer. The bundled instance, already consumed by L4, is authoritative (§8.4.2).

**Note — multi-mirror TOFU and runtime-fetched trust-base integrity deferred to v2.** Multi-mirror TOFU cross-check (byte-identical trust base across ≥ 2 independently-addressed aggregator mirrors) and the associated integrity defenses (cert pinning, CA/IP diversity, mirror-list SHA-256) apply *only* when the trust base is fetched at runtime. In v1 Sphere bundles it, so those defenses have no surface to defend. They become meaningful once the v2 runtime-fetched-trust-base + L1-alpha-anchored trust-fingerprint roadmap item (see `PROFILE-AGGREGATOR-POINTER-ARCHITECTURE.md §12`) ships. Until then, the supply-chain attack surface is the SDK bundle itself; L1-alpha anchoring is the planned defense.

**§8.4.1 Trust base rotation handling (H5, simplified v3.4).**

When `InclusionProof.verify` returns `NOT_AUTHENTICATED`, implementations MUST:

1. **Distinguish rotation from forgery.** If the bundled (or pinned) trust base's `epoch` field differs from the certificate's referenced epoch in the returned proof, rotation is suspected. Rotation is a legitimate operational event (BFT validator set churn); forgery is adversarial.
2. **On suspected rotation.** Raise `AGGREGATOR_POINTER_TRUST_BASE_STALE` (distinct from `AGGREGATOR_POINTER_UNTRUSTED_PROOF`). The trust base is bundled in the SDK (§8.4 embedded trust-base anchor), so the remediation is an SDK update whose bundled `RootTrustBase` carries the new epoch — not a runtime refresh.
3. **On forgery (non-rotation `NOT_AUTHENTICATED`).** Raise `AGGREGATOR_POINTER_UNTRUSTED_PROOF`. Adversarial proof forgery handling is unchanged from r3.3.

Implementations MUST NOT silently accept a trust base with `epoch` equal to or less than the bundled one — that indicates replay or forgery. Runtime refetch of the trust base is v2 future work (see `PROFILE-AGGREGATOR-POINTER-ARCHITECTURE.md §12`) and is NOT required to resolve rotation in v1; rotation always takes the "ship a new SDK build" path. Without this discipline, a pinned `RootTrustBase` can go stale when BFT validators rotate faster than the SDK release cadence; wallets affected by that gap MUST surface `AGGREGATOR_POINTER_TRUST_BASE_STALE` so operators can drive a release update.

**§8.4.2 Shared trust base with L4 (H6 — canonical rule as of v3.4).**

The pointer layer MUST consume `RootTrustBase` via `OracleProvider.getRootTrustBase()` (or the equivalent SDK hook). It MUST NOT bundle its own trust base, load a second copy, or instantiate an independent `TrustBase` provider. L4 (`PaymentsModule`) and the pointer layer share the same embedded `RootTrustBase` instance, loaded once by the SDK from `assets/trustbase/<network>.ts` (§8.4).

Implementations MUST NOT instantiate a separate `TrustBase` provider for the pointer layer; doing so creates asymmetric trust guarantees. An attacker who cannot forge the pointer-layer trust base but CAN forge the L4 trust base still steals tokens via the L4 path — and vice versa. Shared trust collapses both attack surfaces into one.

This is an integration-shape requirement, not a byte-level change. It makes the pointer layer compatible with the current Sphere deployment out of the box: L4 is already the source of truth for embedded trust.

**§8.4.3 TLS discipline (v3.4 — simplified).**

All aggregator communication MUST use HTTPS with TLS ≥ 1.3.

Aggregator HTTPS connections use standard WebPKI certificate validation. Because the `RootTrustBase` is embedded in the SDK bundle (§8.4) rather than fetched at runtime, an on-path TLS MITM cannot forge `InclusionProof.verify` outcomes — the embedded trust base is the cryptographic anchor, independent of TLS. The supply-chain attack surface is therefore the SDK bundle itself, not the TLS session.

Runtime cert pinning, CA diversity, IP diversity, and bundled-mirror-list integrity (the defenses removed in v3.4) apply only to the v2 runtime-fetched-trust-base model. They are planned alongside L1-alpha-anchored trust-fingerprinting (see `PROFILE-AGGREGATOR-POINTER-ARCHITECTURE.md §12`), which closes the bundle-supply-chain gap at the same time.

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

**W2 — HTTPS-only gateway pool.** IPFS gateway URLs in the SDK's shipped configuration MUST use the HTTPS scheme. HTTP gateways MUST NOT be included in the multi-gateway fetch pool. Implementations MAY allow a user-configurable override for local/test deployments, gated behind an explicit capability flag `allowInsecureGateways: true` with a prominent startup warning.

**Post-decode invariant (C4 / H10 — CAR fetch caps).** The resolved CID MUST be fetched via an IPFS client that enforces `MAX_CAR_BYTES` (100 MiB) and progress-rate timeouts (see H10 below). If caps are exceeded, the client MUST raise `AGGREGATOR_POINTER_CAR_TOO_LARGE` or `AGGREGATOR_POINTER_CAR_FETCH_TIMEOUT` respectively. The pointer layer treats these as recovery failures; the caller MAY choose to abort recovery or to fetch from a different gateway, but MUST NOT silently advance `localVersion` past an unfetchable bundle. See §10.7 for the related "CAR unavailable" persistent state.

**H10 — Progress-rate CAR fetch timeout.** The earlier single-shot `MAX_CAR_FETCH_MS = 60s` timeout aborted legitimate slow-network fetches. r3.3 replaces it with progress-rate semantics. A CAR fetch aborts if ANY of the following hold:

1. Initial response headers not received within `MAX_CAR_FETCH_INITIAL_RESPONSE_MS` (10 s).
2. No bytes received for `MAX_CAR_FETCH_STALL_MS` (30 s) after any previous byte.
3. Total elapsed time exceeds `MAX_CAR_FETCH_TOTAL_MS` (5 min) including all retries.
4. Total bytes received exceed `MAX_CAR_BYTES` (100 MiB).

Implementations MUST support HTTP Range (`bytes=N-`) requests: on stall or transient failure, retry from the last successfully-received byte offset rather than starting over. The retry budget for resume attempts is `MAX_CAR_FETCH_RETRY = 3` per gateway with exponential backoff based on `MAX_CAR_FETCH_RETRY_BACKOFF_BASE_MS`.

Implementations MUST NOT rely on `Content-Length` header for size verification. All size enforcement is streaming byte-count.

`Content-Encoding: gzip | deflate | br` MUST be rejected on CAR responses (CAR format is already efficiently binary-encoded; compression adds only attack surface). A gateway returning `Content-Encoding` triggers `AGGREGATOR_POINTER_CAR_UNEXPECTED_ENCODING`.

**Streaming byte-count enforcement (D6 — MANDATORY).** Implementers MUST enforce `MAX_CAR_BYTES` via a **streaming byte-count on the response body**, independently of any `Content-Length` header supplied by the gateway. The byte count MUST abort the underlying socket / reader within one additional chunk of exceeding `MAX_CAR_BYTES` — i.e., the implementation MUST NOT buffer an entire oversized response before checking the cap.

Implementations MUST NOT rely solely on `Content-Length` headers for size verification. A malicious gateway can set a small `Content-Length` and stream arbitrary amounts of data beyond it; clients that trust the header are vulnerable to memory-exhaustion DoS. Correct implementations therefore:

1. Initialize a running byte counter to zero before beginning the response read loop.
2. Increment the counter by `chunk.length` after each chunk read.
3. If `counter > MAX_CAR_BYTES`, abort the socket (close reader, release resources) and raise `AGGREGATOR_POINTER_CAR_TOO_LARGE` within one additional chunk of the overflow.
4. Enforce the progress-rate timers from H10 independently of any server-supplied hint.

The `Content-Length` header MAY be used as an early-reject optimization (if `Content-Length > MAX_CAR_BYTES`, abort immediately before reading any body) but MUST NOT be used as the sole cap enforcement.

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

    cid = cidProducer()                                              // recompute against current local state

    // H4 — target next publish at max(validV, includedV) + 1 to skip
    // past corrupt-included residue. Without this, a corrupt leaf at
    // validV+1 causes REQUEST_ID_EXISTS → re-discover same validV →
    // retry at same v → infinite loop until RETRY_EXHAUSTED.
    { validV, includedV } = await findLatestValidVersion()           // §8.2 (H4 return shape)
    nextV = max(validV, includedV) + 1
    result = await publish(cid, nextV)

    if result.ok:
        return result

    if result.err == AGGREGATOR_POINTER_CONFLICT:
        // Another device raced and published BEYOND includedV. Re-discover and retry.
        { validV, includedV } = await findLatestValidVersion()
        remote = await recoverLatest()                                // §8.5 (CID at validV)
        // Outer Profile layer fetches CAR via DEFAULT_IPFS_GATEWAYS and
        // merges the bundle into local OrbitDB per PROFILE-ARCHITECTURE §10.4.
        await profileLayer.fetchAndJoin(remote.cid)
        storage.write("profile.pointer.version", validV)

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
4. at least one retry with exponential backoff has already been attempted AND failed (to avoid flapping on single transient failures).

Additionally, re-SET BLOCKED (reentry) when a publish attempt fails with `AGGREGATOR_POINTER_NETWORK_ERROR` whose error category matches the transport-categorical list in (2).

**10.2.3 User-originated write definition.** An OpLog entry is *user-originated* iff its `originated` metadata tag equals `'user'`. OpLog writers MUST stamp each entry they author with one of:

- `'user'` — the entry reflects a deliberate user action (token send, token receive, nametag register, DM send, invoice mint, invoice pay, swap propose/accept/deposit, etc.). These entries COUNT for the §10.2.2 condition (3).
- `'system'` — the entry is an SDK-internal bookkeeping write (session receipt, last-opened timestamp, cache index refresh, etc.). These do NOT count.
- `'replicated'` — the entry arrived via OrbitDB gossipsub or Nostr ingest from a remote peer. These do NOT count.

The `originated` tag MUST be stamped at write time by the module authoring the entry; recipients of replicated entries MUST NOT mutate it. A missing or malformed `originated` tag on a locally-signed entry MUST be treated conservatively as `'user'` to fail closed (i.e., so a forgotten stamp cannot silently disable BLOCKED).

> **Note on the prior `signedBy` rule (r3).** The earlier "`entry.signedBy == localSigningPubKey`" heuristic was ambiguous in two directions: (i) a session-receipt write signed by the chain key counts as user-originated under that rule and spuriously SETs BLOCKED; (ii) a "touch" write that isn't signed at all slips past and BLOCKED never SETs even though the user authored a visible action. The `originated` tag is orthogonal to `signedBy` — system-authored entries MAY still be signed by `localSigningPubKey`. Implementations migrating from r3 MUST stamp all emitted entries before C6 ships.

This distinction is load-bearing: replicated entries from other devices do not themselves justify blocking, because their author's device is responsible for publishing its own pointer advance.

**Semantic re-validation (D5).** The stamped `originated` tag is caller-asserted and therefore potentially forgeable by a malicious writer who stamps `'system'` on a token-send entry to silently disarm BLOCKED. To close this bypass, recipients MUST re-validate the stamped `originated` tag against the entry's OpLog type:

- Entries whose type is in the **known user-action set** — `token_send`, `token_receive`, `nametag_register`, `dm_send`, `invoice_mint`, `invoice_pay`, `swap_propose`, `swap_accept`, `swap_deposit`, and any future member of this set that modules add — MUST have `originated = 'user'` regardless of the stamped value. Any other tag on a user-action entry MUST be rejected as `SECURITY_ORIGIN_MISMATCH` and MUST NOT be replicated further.
- Entries whose type is in the **known system set** — `session_receipt`, `cache_index`, `last_opened_ts` — MUST have `originated = 'system'` regardless of the stamped value.
- Entries of an **unknown type** are handled per the fail-closed rule above: missing / malformed / unknown ⇒ treated conservatively as `'user'`.

This re-validation runs at two points: (i) on every locally-authored write, before durable persistence; (ii) on every replicated write, before the replica is accepted into the local OpLog. The check is byte-cheap (string-equality on the entry type) and closes the tag-forgery bypass.

**§10.2.3.1 Migration — stamping existing OpLog writers (W11).**

Every module that writes OpLog entries MUST stamp the `originated` tag. The following modules are affected in the current Sphere SDK:

- `modules/payments/PaymentsModule.ts`: `token_send`, `token_receive`, `nametag_register`, transfer events → `'user'`.
- `modules/accounting/AccountingModule.ts`: `invoice_mint`, `invoice_pay`, `invoice_close` → `'user'`.
- `modules/swap/SwapModule.ts`: `swap_propose`, `swap_accept`, `swap_deposit`, payout → `'user'`.
- `modules/communications/CommunicationsModule.ts`: `dm_send` → `'user'`; `dm_receive` → `'replicated'` (receiver stamps as replicated regardless of the sender's stamp).
- `profile-token-storage-provider.ts flushToIpfs`: batch bundle events → `'system'`.
- Any session / cache / index writes → `'system'`.

The implementation PR MUST update all listed modules atomically with the pointer layer. Deploying the pointer layer without the writer updates leaves BLOCKED state semantically inert: untagged entries default to `'user'` per the fail-closed rule above, causing spurious BLOCKED on every system write.

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

**10.2.6 Deleted in r3.2.** The r3.1 rule "SET BLOCKED on fresh-install corrupt-payload at cold start" is superseded by the valid-version-continuity rule (§10.3). Corrupt versions are SKIPPED during discovery (§8.2 Phase 3) rather than treated as MITM signals. Any remaining references to §10.2.6 elsewhere in this spec should be read as references to §10.3.

### 10.3 Malformed recovered payload — valid-version continuity (D1, H1-refined)

A XOR-decoded payload that fails length-prefix bounds, `isValidCid`, or CAR deserialization — or whose fetched CAR bytes fail content-address verification (CID hash ≠ bytes digest) — is `SEMANTICALLY_INVALID` in the H1 classification and is NOT treated as a MITM signal. Such versions are permanent SMT residue that the pointer layer **semantically ignores**.

**Reconciliation with §10.7 (H1).** A version whose CAR cannot be fetched due to transient IPFS gateway outage is DIFFERENT: it is classified `TRANSIENT_UNAVAILABLE`, NOT `SEMANTICALLY_INVALID`, and Phase 3 DOES NOT walk past it. `TRANSIENT_UNAVAILABLE` propagates up as `AGGREGATOR_POINTER_CAR_UNAVAILABLE` so §10.7 handles it correctly: the wallet waits for gateways to recover, or follows the `acceptCarLoss()` protocol in §10.7.1.

**Discovery rule.** `SEMANTICALLY_INVALID` versions are SKIPPED during discovery (§8.2 Phase 3 walk-back). The pointer layer considers the latest VALID version authoritative. `TRANSIENT_UNAVAILABLE` versions are NOT skipped; they surface up.

**Publish rule.** Publishing a NEW valid version at `latest_valid_V + 1` is legitimate and does NOT require resolving the intermediate corrupt versions. The next legitimate publisher simply bumps `localVersion` from the latest valid version and proceeds. Each client performs valid-version continuity independently; **no inter-client coordination is needed**.

**Error rule.** `AGGREGATOR_POINTER_CORRUPT` is raised only by the caller of `recoverLatest()` when the caller explicitly asked for the decoded payload at a specific corrupt version (e.g., a forensic diagnostic path). Ordinary discovery silently skips corrupt versions; it does NOT surface `AGGREGATOR_POINTER_CORRUPT` per-skip. Each skip MAY emit `pointer:discover_corrupt_skipped { version }` for telemetry visibility.

**Implementation note.** This design accepts that corrupt versions MAY exist in the aggregator SMT — whether from buggy prior clients, aborted mid-migration publishes, transient gateway-level CAR corruption that later becomes valid as other gateways heal, or adversarial grinding by a publisher who has access to the wallet's `pointerSecret` (infeasible for an external attacker). They are permanent SMT residue but semantically ignored. The bounded walk-back (`DISCOVERY_CORRUPT_WALKBACK`) protects against pathological streaks via §10.8.

Possible root causes for an observed corrupt version:

- Key derivation drift between publisher and recoverer (library version skew in HKDF or SigningService).
- Wrong mnemonic imported (pointer decryption produces garbage; length prefix happens to be "valid-looking" but CID parse fails).
- Publisher violated §7.1 and reused `(v)` across two different CIDs — in which case both ciphertexts are now mutually recoverable by an observer (see §11).
- A prior client crashed mid-publish in a way that bypassed the §7.1 marker discipline (e.g., on a storage backend that silently violated the durability contract).
- Transient CAR gateway-level data corruption at fetch time (may self-heal; re-running discovery later MAY return a now-valid version).

### 10.4 CID too large

`cidLen > CID_MAX_BYTES` → reject at publish with `AGGREGATOR_POINTER_CID_TOO_LARGE`. A three-commitment extension is future work (`ARCHITECTURE §12`).

### 10.5 Version overflow

`v > VERSION_MAX` → reject at publish with `AGGREGATOR_POINTER_VERSION_OUT_OF_RANGE`. At `2^31 − 1`, even at one publish per second, this is ~68 years per wallet.

### 10.6 Aggregator-signed false exclusion

A malicious aggregator could return an exclusion proof for a `requestId` it previously accepted. Defense: `InclusionProof.verify(trustBase, ...)` roots the answer in the `RootTrustBase`. A forged exclusion requires forging the trust base, which is out of scope for this layer (assumed defended by BFT anchoring at L2/L1).

For deployments wanting stronger guarantees, cross-check against multiple aggregator mirrors (future work, §12 of arch doc).

### 10.7 CAR unavailable after successful recovery

**Scenario.** After Phase 2 discovery returns a `V_true > 0` AND the CID decoded in §8.5 passes `isValidCid` AND `InclusionProof.verify(trustBase, ...)` returned `OK` for both sides, the caller invokes `fetchFromIpfs(cid)`. All configured IPFS gateways return 404 / unreachable / 5xx / time out under the H10 progress-rate budget. The CID is provably pinned at `V_true` by a trustlessly-verified inclusion proof, but the bundle bytes are not retrievable right now.

**Behavior.** The pointer layer MUST:

1. Raise `AGGREGATOR_POINTER_CAR_UNAVAILABLE` to the caller.
2. NOT advance `localVersion`. Treat `V_true` as known-but-uningested.
3. Refuse all subsequent `publish()` calls until EITHER the CAR becomes fetchable on retry, OR the caller invokes the `acceptCarLoss(version)` protocol in §10.7.1 with full operator consent.
4. Emit a `pointer:recover_car_unavailable { version, cid }` event for UI surfacing.

**Why this is distinct from §10.2 BLOCKED.** §10.2 BLOCKED covers "aggregator unreachable → can't discover `V_true`". §10.7 CAR-unavailable covers "aggregator reachable, `V_true` discovered and verified, but the IPFS bundle itself can't be fetched". Advancing `localVersion` past an unfetchable bundle would silently replace legitimate remote history the moment fetch becomes possible again — a data-loss path. The caller opts into that loss only through the §10.7.1 protocol below.

### 10.7.1 `acceptCarLoss` discipline (H7)

`acceptCarLoss(version)` MUST NOT silently advance `localVersion`. The earlier v3.2 semantics ("advance localVersion past unfetchable bundle") could lose tokens that existed ONLY in the lost bundle. The H7 protocol closes this gap:

1. **Capability gate.** Requires `Sphere.init({ allowOperatorOverrides: true })`. Naïve consumers cannot stumble into data loss.
2. **Prior persistent-retry exhaustion (wall-clock enforced).** At least `CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS` (= 12) attempts across ALL configured gateways at 1-hour intervals over `CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS` (= 24 h) must have elapsed. Implementations MUST enforce the wall-clock duration by persisting attempt timestamps to local storage so the duration is preserved across restarts.
3. **Peer-availability check.** Before advancing, emit `pointer:car_loss_pending { version, retriesRemaining, peerDiscoveryActive }` and poll OrbitDB gossipsub / Nostr for responders advertising this wallet's bundle for `POINTER_PEER_DISCOVERY_MS` (= 10 min). If ANY peer responds with a matching bundle, the CAR is NOT definitively lost; ABORT `acceptCarLoss` with `pointer:car_loss_aborted_peer_found { version, peer }` and resume fetch attempts.
4. **MANDATORY republish BEFORE advance.** On confirmed total unavailability, the wallet MUST IMMEDIATELY republish its current local OpLog state as a fresh bundle at `max(localVersion, version) + 1`, BEFORE advancing past `version`. This closes the "tokens only in the lost bundle" gap: if any local OpLog entries exist that weren't in the lost bundle, they are anchored in the new publish. If no new OpLog entries exist, an empty republish still establishes a recovery point.
5. **Advance only after republish.** Only AFTER the republish succeeds does `localVersion` advance to the republished version.
6. **Telemetry.** Emit `pointer:car_loss_accepted { version, republishedCID, republishedAt }`.

**UI requirement.** The override MUST be presented to the user with the warning: *"Tokens added on other devices that only exist in the lost bundle will be permanently unrecoverable from this device. Consider waiting for network recovery or checking if other devices have this data."*

### 10.8 Recovery bail on corrupt streak (D1)

If §8.2 Phase 3 walk-back encounters `DISCOVERY_CORRUPT_WALKBACK` consecutive corrupt versions without finding a valid one, the client raises `AGGREGATOR_POINTER_CORRUPT_STREAK`.

This is a **distinct** error from `AGGREGATOR_POINTER_CORRUPT`. It indicates either:

(a) a pathological sequence of consecutive prior-client bugs (e.g., an old SDK release shipped with a broken encoder and every publish from that release is corrupt); OR

(b) an adversary grinding garbage at the wallet's `requestId` space — possible only if the adversary has `pointerSecret`, which is computationally infeasible for any external attacker under the HKDF-SHA256 security argument (§11.1).

**Recovery path.** The user MAY invoke the `acceptCorruptStreak(walkbackLimit?)` API (§13) which raises the walkback ceiling for a single recovery attempt, capped at an implementation-defined safety ceiling (e.g., 4096). Each use is audited via `pointer:corrupt_streak_override_used { walkbackLimit }` telemetry.

**Why not SET BLOCKED on corrupt streak.** Unlike §10.2 (aggregator-unreachable) and the deleted r3.1 §10.2.6 rule, a long corrupt streak is not a MITM signal — MITM defenses now live entirely in §8.4 (multi-mirror TOFU) and §8.1 (trustless `InclusionProof.verify`). A legitimate mnemonic holder who has NOT been MITM'd but who is staring at a corrupt-heavy OpLog can progress past it by either accepting the streak and continuing discovery, or by publishing a new valid version (valid-version continuity, §10.3) and letting future recovery anchor on that new valid version instead.

**Interaction with publish.** `AGGREGATOR_POINTER_CORRUPT_STREAK` does NOT SET BLOCKED. A caller who chose to accept the streak and recover successfully can publish normally from `latest_valid_V + 1`. A caller who declines to accept the streak remains in a read-only state but MAY still publish — the next legitimate publish at `localVersion + 1` will itself become the new latest-valid version and will anchor future recoveries by other devices.

---

## 11. Security Considerations

1. **Subkey separation.** `signingSeed`, `xorSeed`, `padSeed` are independent HKDF outputs from `pointerSecret` with distinct info strings (§4.2). Compromise of any single subkey does not compromise the others.

2. **One-time-pad discipline.** Each `xorKey_{side, v}` is used on exactly one 32-byte plaintext half. Reuse would allow `xor(ct1, ct2) = xor(pt1, pt2)`, trivially recovering plaintext. The scheme enforces uniqueness by binding `xorKey` to `be32(v)`. The `pending_version` marker (§7.1) additionally prevents a crashed publisher from reusing `v` with a *different* plaintext after restart.

3. **Deterministic padding.** `paddingBytes_v` is an HKDF-Expand output from `padSeed` — an internal secret. To an observer without `padSeed`, the padding is computationally indistinguishable from uniform random. Determinism is strictly a benefit for idempotent crash-retry: it removes the need to persist a CSPRNG seed across restarts.

4. **Pubkey pseudonymity, not anonymity.** `signingPubKey` is stable across all versions and both sides for a given wallet. The aggregator can cluster "all commitments signed by this key are from the same entity." It cannot link `signingPubKey` to `walletPrivateKey` or to the wallet's chain pubkey (secret-derived via HKDF). G2 (from the arch doc) is therefore pseudonymous-per-wallet, not fully unlinkable across a wallet's own commits. Full anonymity (throwaway `signingPubKey` per version) is deferred future work.

5. **Trustless proof verification (mandatory).** Every inclusion / exclusion claim the wallet acts on MUST be verified via `InclusionProof.verify(trustBase, requestId)` before being trusted. `trustBase` is the SDK-bundled `RootTrustBase` shared with L4 (§8.4, §8.4.2). The trust root is therefore the SDK bundle itself; supply-chain compromise of the bundle is the residual risk, planned to be closed by L1-alpha-anchored trust fingerprinting (v2 — see `PROFILE-AGGREGATOR-POINTER-ARCHITECTURE.md §12`).

6. **Algorithm tag visible.** The `HashAlgorithm.SHA256` tag (`[0x00, 0x00]`) is visible in both `stateHash.imprint` and `transactionHash.imprint` published to the SMT. Because every ordinary L4 commitment uses the same tag, this does not distinguish pointer commitments.

7. **CID parser hardening.** The decoder MUST bound reads to the 64-byte plaintext buffer, reject malformed varints, and accept only sha2-256 multihashes (aligned with `profile/ipfs-client.ts verifyCidMatchesBytes`). A permissive parser is a denial-of-service vector.

8. **No replay surface.** The aggregator rejects duplicate `requestId`s. A replay of our own commitment returns `REQUEST_ID_EXISTS`, treated as idempotent-success (§7.3, §10.1).

9. **No revocation.** Once `v` is committed, it is permanent. Recovery returns the latest version; prior versions are ignored. OrbitDB CRDT on the OpLog side handles content-level conflict resolution.

10. **Timing side channels.** The aggregator observes publish and probe cadence. "This wallet has approximately `V` versions" is inferable from probe patterns; "this wallet is active now" is inferable from commit arrivals. Not mitigated at this layer. See `ARCHITECTURE §12`.

    Additionally, **discovery probe-sequence fingerprint (C7).** The sequence of `(v, side)` request-IDs probed during recovery (§8.2 Phase 1 exponential + Phase 2 binary-search + Phase 3 walk-back) is a deterministic function of `(V_true, localVersion, {corrupt-version set})`. An aggregator operator or on-path observer who logs probe IDs across sessions can correlate two sessions from the same wallet as "same probe signature" even when the wallet uses different IP addresses, Tor exit nodes, or mirror rotations. This is a stronger clustering signal than `signingPubKey` alone (which already leaks across A/B at the same `v`; see bullet 4 above) because it ties together sessions separated in time. Mitigations (deferred to v2): (a) randomize the Phase 1 exponential base — e.g., start `hi = DISCOVERY_INITIAL_VERSION + random_jitter()` where `random_jitter` is a uniform draw with variance comparable to the expected bin-search depth; (b) insert decoy probes at random versions during discovery; (c) probe via a small anonymity set of pointer-layer identities rotated per session. None of these are required for v1 ship; document as a known limitation that the §13 `getProbeFingerprint()` API may surface to UIs.

11. **Retry-rejected ciphertexts are sensitive (H14 — achievable target).** A ciphertext computed for `(v, side)` that the wallet submits and the aggregator rejects with `REQUEST_ID_EXISTS` (because another device's commit landed first) shares `xorKey_{side, v}` with the committed ciphertext. An attacker who captures BOTH the rejected ciphertext AND the committed ciphertext can XOR them to reveal the plaintext differential.

    Implementations SHOULD minimize in-memory residence of secret material derived from the mnemonic. JavaScript / TypeScript runtimes offer no guaranteed memory zeroization (GC-managed memory, move-on-minor-GC, immutable strings), so the requirements below are scoped to what is actually achievable at the SDK layer:

    (a) **Re-derivation discipline — primary defense (normative).** The ciphertext for each retry MUST be freshly derived from the deterministic key material (`xorKey_{side, v}`, `paddingBytes_v`) rather than retained across retries. Deterministic padding (§4.6) guarantees byte-identity across re-derivations, so the aggregator's write-once `requestId` semantics still yield idempotence. Re-derivation is computationally cheap (two HKDF-Expand + one XOR per side) and closes the OTP-reuse window deterministically.

    (b) **Caller-owned buffer zeroization — best effort.** Implementations SHOULD zero-fill `Uint8Array` buffers the CALLER owns (e.g., intermediate ciphertext buffers before they're handed to the SDK) immediately after use. SDK-internal copies (`DataHash._data`, `Authenticator.signature`, `Signature.bytes`, JSON-RPC transport hex strings) are OUT OF SCOPE for this spec — they are not reachable from the caller and are not reliably zeroizable in JS.

    (c) **Runtime-provided protections — recommended where available.** Node.js implementations MAY use `Buffer.allocUnsafeSlow` + `sodium_memzero` for seed-material storage when running in a native-extension-enabled environment. Browsers have no equivalent; accept this limitation.

    (d) **Secret-value denylist (normative).** The following values MUST NOT appear in any log, telemetry event, error message, stack trace, or persistent storage outside the encryption module boundary:
       - `pointerSecret`
       - `signingSeed`, `xorSeed`, `padSeed`
       - `signingService.privateKey`
       - `walletPrivateKey` (the master key itself)
       - retry-rejected ciphertext bytes (may leak `xorKey` via differential analysis per the opening paragraph)
    Ciphertext-containing structures MUST be excluded from any serializer used for log emission. This rule applies at ALL verbosity levels including debug/trace in CI or development builds.

    (e) **Wrapper type (recommended).** Implementations MAY wrap secret-material in a `SecretKey` type whose `toString` / `toJSON` / `util.inspect` hooks return a redaction marker rather than the underlying bytes.

    **Rationale.** The r3.1 "zeroize backing buffer immediately" language was not achievable given SDK-internal copies and immutable hex strings in JS. The H14 rewrite makes (a) the primary defense (re-derivation per retry, cryptographically sound) and treats (b)-(c) as defense-in-depth best effort. The full hardening target — guaranteed memory zeroization requiring native-memory primitives — is deferred to future work.

12. **Denylisted keys (C8).** Implementations SHOULD maintain a denylist of well-known test keys and refuse to bind the pointer layer to any such key in non-test networks. The denylist MUST include at minimum the §14.1 canonical vector (`walletPrivateKey = 0x01 × 32`, checked via `SHA-256(walletPrivateKey) == SHA-256(0x01 × 32)` to avoid storing the raw scalar in the denylist itself). The check occurs at `Profile.init()` time, before any pointer-layer derivation runs, and fires only when `config.network != 'test-vectors'`. Implementations MAY extend the denylist with other well-known public test keys (Bitcoin "1 × 32" vectors, secp256k1 test-suite vectors, etc.) as they become aware of them. A positive denylist hit MUST abort init with a distinct, non-ignorable error; falling back to a warning is explicitly NOT permitted.

    **Note on defense-in-depth (W9).** The client-side runtime check is a policy boundary, not a cryptographic one. An attacker who compiles without the check (or disables it via debugger) can still use the denylisted key. Aggregator-side enforcement — rejecting submissions signed by known test-key pubkeys on non-test networks — is the only cryptographically binding defense and is tracked in §11.13 item (iv). The aggregator team has NOT yet committed to this check; until then, client-side enforcement is defense-in-depth only.

13. **Residual risks documented as trade-offs (v2 work) (D10).** Revision 3.2 fixes all objective bugs surfaced by the r3.1 steelman reviews, but the following trade-offs remain. They are NOT bugs; they are consequences of the scheme's design choices that would require deeper changes (L1 anchoring, governance, protocol redesign) to resolve and are deferred to v2.

    (i) **Bundled trust base = centralized trust root.** v1 Sphere ships with `RootTrustBase` embedded in `assets/trustbase/<network>.ts` (§8.4). This same bundle is consumed by L4. Supply-chain compromise of an SDK release therefore lets an attacker forge proofs that verify against their own trust base on every downstream wallet simultaneously. **v2 work:** anchor `RootTrustBase` fingerprints to the ALPHA (L1) chain (e.g., committed in a coinbase OP_RETURN or governance-signed record) so wallets can verify the bundled trust base matches an out-of-band L1 attestation at init time. This also unblocks runtime-fetched trust-base refresh, at which point a multi-mirror TOFU cross-check (≥ 2 independently-addressed aggregator mirrors returning byte-identical trust bases) becomes a meaningful additional defense and is re-introduced alongside it. See `PROFILE-AGGREGATOR-POINTER-ARCHITECTURE.md §12`.

    (ii) **Multi-mirror TOFU + runtime-fetched trust-base integrity deferred to v2.** v1 has no runtime trust-base fetch to defend, so multi-mirror cross-check, cert pinning, CA/IP diversity, and mirror-list integrity (all removed in v3.4) are not applicable. They become meaningful in v2 once the L1-anchored + runtime-refreshed trust-base model from (i) ships; at that point the availability trade-offs noted previously (DDoS-resistance of the mirror set, operator capability gates for single-mirror fallback) re-emerge and MUST be revisited.

    (iii) **Manual backup/restore across devices triggers `MARKER_CORRUPT`.** A legitimate user flow — copying `.profile/` state from device A (at `v = 2000`) to device B (at `v = 0`) — produces a marker on device B whose version gap exceeds `MARKER_MAX_JUMP = 1024`, triggering `AGGREGATOR_POINTER_MARKER_CORRUPT` (§7.1.4). Recovery IS available via `clearPendingMarker()` (§13) but implementations MUST surface UX guidance for backup-restore scenarios; a user without the guidance faces an opaque error. **v2 work:** on first-boot when the only persistent state is a mismatched marker (no `localVersion`, no OpLog entries, no other signals of a legitimate prior session), auto-call `clearPendingMarker()` and emit `pointer:marker_cleared { reason: 'auto_compacted' }`.

    (iv) **Denylist governance (C8 extension).** §11.12 requires runtime rejection of known test keys. v1 ships with a single hard-coded entry (the §14.1 canonical vector). There is no formal governance for adding entries as new public test keys become known. **v2 work:** define where the canonical denylist lives (in-SDK, IPNS-published, L1-anchored), how it versions (monotonic seq + signed root), how new entries propagate to shipped wallets (lazy check against a remote manifest at init time), and whether the list is signed by a release key, a multisig, or both.

    (v) **Corrupt streak as a legitimate-use DoS vector.** §10.8 bails with `AGGREGATOR_POINTER_CORRUPT_STREAK` after `DISCOVERY_CORRUPT_WALKBACK = 64` consecutive corrupt versions. A publisher who crashes-mid-publish at a high rate (≥ 64 consecutive times) produces a legitimate-use corrupt streak that legitimate recoverers then see. The user can `acceptCorruptStreak()` but this is a UX papercut. **v2 work:** distinguish crash-mid-publish residue from adversarial grinding via a fingerprint on the XOR-decoded plaintext (e.g., a short marker byte that publishers always include, so unmarked corrupt versions can be skipped at higher rates without raising the bail threshold).

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
| `AGGREGATOR_POINTER_MARKER_CORRUPT` | `pending_version` marker failed integrity checks (e.g., `|cidHash| != 32`, or version-jump clamp per C1 / §7.1.4). Recover via `clearPendingMarker()` in §13. | §7.1.4, §7.1.5 |
| `AGGREGATOR_POINTER_CAR_TOO_LARGE` | IPFS client returned a CAR exceeding `MAX_CAR_BYTES` during recovery fetch. | §8.5 |
| `AGGREGATOR_POINTER_CAR_FETCH_TIMEOUT` | IPFS client exceeded `MAX_CAR_FETCH_MS` during recovery fetch. | §8.5 |
| `AGGREGATOR_POINTER_CAR_UNAVAILABLE` | All configured IPFS gateways returned 404 / unreachable despite a trustlessly-verified inclusion proof at `V_true`. Blocks further publishes until retry succeeds or `acceptCarLoss()` is invoked. | §10.7 |
| `AGGREGATOR_POINTER_CORRUPT_STREAK` | §8.2 Phase 3 walk-back encountered `DISCOVERY_CORRUPT_WALKBACK` consecutive `SEMANTICALLY_INVALID` versions without finding a valid one. Distinct from `AGGREGATOR_POINTER_CORRUPT`. Recover via `acceptCorruptStreak()` (§13). | §8.2, §10.8 |
| `SECURITY_ORIGIN_MISMATCH` | OpLog entry rejected because its stamped `originated` tag semantically mismatches its entry type (user-action entry tagged `'system'` or vice versa). Non-retryable; the entry MUST NOT be replicated further. | §10.2.3 |
| `AGGREGATOR_POINTER_UNSUPPORTED_RUNTIME` | Runtime lacks required mutex primitive (Web Locks API in browser) and cannot provide cross-context mutual exclusion for the publish critical section (H3). | §7.1.1 |
| `AGGREGATOR_POINTER_PUBLISH_BUSY` | Cross-process / cross-tab mutex contention: lock held by another process or tab across `PUBLISH_RETRY_BUDGET` backoff attempts (H3). | §7.1.1 |
| `AGGREGATOR_POINTER_TRUST_BASE_STALE` | `InclusionProof.verify` returned `NOT_AUTHENTICATED` and the bundled trust base's `epoch` does not match the epoch referenced by the returned proof. Remediation: ship an SDK update whose bundled `RootTrustBase` carries the new epoch (§8.4.1). Distinct from `_UNTRUSTED_PROOF`, which is the adversarial-forgery signal. | §8.4.1 |
| `AGGREGATOR_POINTER_CAR_UNEXPECTED_ENCODING` | CAR fetch response included a `Content-Encoding` header (gzip / deflate / br). CAR format is binary-encoded; compression is rejected as attack surface (H10). | §8.5 |
| `AGGREGATOR_POINTER_AGGREGATOR_REJECTED` | HTTP 4xx other than 429 (permanent aggregator rejection; distinct from `_REJECTED` which covers the in-band SDK-level `AUTHENTICATOR_VERIFICATION_FAILED` / `REQUEST_ID_MISMATCH` statuses) (W3). | §7.3 |
| `AGGREGATOR_POINTER_PROTOCOL_ERROR` | JSON parse failure, missing required fields, unknown `SubmitCommitmentStatus` enum value. Fail closed (W3). | §7.3 |
| `AGGREGATOR_POINTER_WALKBACK_FLOOR` | `acceptCorruptStreak(walkbackLimit)` invocation would cause the effective walk-back floor to cross below `localVersion` (W7). | §13 |
| `AGGREGATOR_POINTER_CAPABILITY_DENIED` | Operator-override API invoked without the required `Sphere.init({ allowOperatorOverrides: true })` capability flag (W6, H7). | §13 |

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
   * Returns both the latest valid version AND the latest included version
   * (H4 — caller uses max(validV, includedV) + 1 to skip past corrupt-included
   * residue when publishing).
   * Errors: AGGREGATOR_POINTER_DISCOVERY_OVERFLOW, _NETWORK_ERROR, _UNTRUSTED_PROOF,
   *         _CAR_UNAVAILABLE (on TRANSIENT_UNAVAILABLE classification, H1).
   */
  discoverLatestVersion(): Promise<Result<{ validV: number; includedV: number }>>

  /**
   * Probe aggregator reachability via a trustlessly-verified exclusion proof.
   * Implementation (W12): POST getInclusionProof(requestId=HEALTH_CHECK_REQUEST_ID)
   * where HEALTH_CHECK_REQUEST_ID = SHA-256(bytes_of("profile-pointer-health-check")
   *                                         || signingPubKey).
   * Verify the returned exclusion proof via InclusionProof.verify(trustBase, ...).
   * Returns true iff verify status is PATH_NOT_INCLUDED with isPathValid=true.
   * Returns false on any network error, verify failure, or timeout
   * (PROBE_REQUEST_TIMEOUT_MS, W4).
   * MUST NOT cache results; every call is a live probe. MUST NOT short-circuit
   * on HTTP response headers alone — full verify is required to defeat
   * captive-portal / DNS-hijack false positives.
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
  isPublishBlocked(): Promise<boolean>

  /**
   * Operator override for §10.7 CAR-unavailable state (H7 — republish-before-advance).
   * Accepts the loss of the unfetchable bundle at `version` ONLY AFTER:
   *   (1) Capability flag `Sphere.init({ allowOperatorOverrides: true })` is set.
   *   (2) Persistent-retry window of CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS (24h)
   *       has elapsed with CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS (12) attempts
   *       across ALL configured gateways (wall-clock enforced via persisted
   *       attempt timestamps).
   *   (3) Peer-availability poll on OrbitDB gossipsub / Nostr for
   *       POINTER_PEER_DISCOVERY_MS (10 min) returned no peer advertising
   *       the bundle (otherwise ABORT with pointer:car_loss_aborted_peer_found).
   *   (4) A fresh bundle is republished at max(localVersion, version) + 1
   *       BEFORE localVersion advances — closes the "tokens only in the
   *       lost bundle" gap.
   * Only AFTER the republish succeeds does localVersion advance.
   * Emits `pointer:car_loss_accepted { version, republishedCID, republishedAt }`.
   * Errors:
   *   - AGGREGATOR_POINTER_CAPABILITY_DENIED if allowOperatorOverrides not set.
   * UI requirement: present the warning "Tokens added on other devices that
   *   only exist in the lost bundle will be permanently unrecoverable from
   *   this device. Consider waiting for network recovery or checking if
   *   other devices have this data."
   */
  acceptCarLoss(version: number): Promise<Result<void>>

  /**
   * Operator-facing recovery for §7.1.4 / C1 version-jump-clamp failure (W6 — gated).
   * Clears a corrupt `PENDING_VERSION_KEY` marker so publish() can resume.
   * Emits `pointer:marker_cleared { previousMarker: { v, cidHash }, reason: 'user_requested' | 'auto_compacted' }` telemetry.
   * `previousMarker` captures the cleared marker's `v` and `cidHash` (exactly
   * the fields stored under `PENDING_VERSION_KEY` per §7.1.4); `reason` is
   * `'user_requested'` when invoked via this API and `'auto_compacted'` when
   * the SDK clears a stale marker automatically (e.g., the §7.1.4
   * `previousEntry.v < currentLocalVersion` stale-drop branch).
   *
   * Preconditions (W6 — tightened):
   *   - `Sphere.init({ allowOperatorOverrides: true })` capability flag set —
   *     prevents programmatic invocation by Connect dApps, bugs, or malicious
   *     code from clearing a legitimate marker mid-publish and triggering
   *     OTP-reuse.
   *   - Human-in-loop confirmation via UX layer (synchronous acknowledgment).
   *   - `AGGREGATOR_POINTER_MARKER_CORRUPT` was observed on the most recent
   *     publish attempt.
   * Side effects:
   *   - Removes PENDING_VERSION_KEY.
   *   - SETs BLOCKED (requires subsequent verified recovery to CLEAR) — this
   *     forces the next pass through §10.2.4 CLEAR conditions, closing the
   *     bypass where clearing a marker alone would resume publish without
   *     re-verification.
   * Errors:
   *   - AGGREGATOR_POINTER_CAPABILITY_DENIED if `allowOperatorOverrides` not set.
   * This API is a manual recovery path — implementations SHOULD surface
   * it to UIs only when a corrupt marker is actually detected, not as a
   * routine option.
   */
  clearPendingMarker(): Promise<Result<void>>

  /**
   * Optional telemetry — returns a short stable hash of the last
   * discovery probe sequence (§8.2 three-phase + §8.3 bounds). Intended for UIs that want
   * to surface "same-wallet clustering" signal to users (per §11 bullet
   * 10 C7). Returns empty string if no probe has been run since init.
   * The returned hash is NOT secret and MAY be logged.
   */
  getProbeFingerprint(): string

  /**
   * Operator override for §10.8 corrupt-streak bail (D1 / D11).
   * Raises the `DISCOVERY_CORRUPT_WALKBACK` ceiling for a single
   * subsequent recovery attempt, up to an implementation-defined safety
   * ceiling (e.g., 4096).
   *
   * Preconditions:
   *   - The most recent recovery attempt returned
   *     AGGREGATOR_POINTER_CORRUPT_STREAK (§10.8).
   *   - Sphere.init({ allowOperatorOverrides: true }) capability flag set.
   *   - W7 floor check: `walkbackLimit` (if provided) MUST NOT cause the
   *     effective walk-back floor to cross below `localVersion`. That is,
   *     walk-back from DISCOVERY_INITIAL_VERSION goes down to
   *     max(0, localVersion). Crossing below `localVersion` is rejected
   *     with AGGREGATOR_POINTER_WALKBACK_FLOOR — it would walk past
   *     versions this wallet has already confirmed as its own.
   *
   * Postconditions:
   *   - The next `recoverLatest()` / `discoverLatestVersion()` call runs
   *     Phase 3 walk-back with the raised limit. On completion (success
   *     or a second bail), the ceiling reverts to the default
   *     DISCOVERY_CORRUPT_WALKBACK for all subsequent recoveries; the
   *     override is one-shot.
   *   - Returns the walkback limit actually used (the request may be
   *     clamped to the implementation's safety ceiling).
   *
   * Emits `pointer:corrupt_streak_override_used { walkbackLimit }`
   * telemetry for auditability.
   *
   * Cap: implementation-defined safety ceiling (recommend 4096 for the
   * walkbackLimit parameter).
   *
   * @param walkbackLimit — desired ceiling for this recovery. Omit to
   *   use the implementation's safety ceiling directly.
   */
  acceptCorruptStreak(walkbackLimit?: number): Promise<Result<{ walkbackUsed: number }>>
}
```

---

## 14. Test Vectors

**Status: templated.** The first implementation PR MUST compute exact bytes for every row in the table below and commit them to `docs/uxf/profile-aggregator-pointer.test-vectors.json` together with a `.sha256` checksum file for tamper detection. Reviewers from an independent implementation (Go, Rust) MUST be able to reproduce every row byte-for-byte from this spec alone.

**Owner of first-vector computation:** SDK team. **Blocking status:** NOT blocking on spec sign-off; blocking on implementation-PR merge.

### 14.1 Canonical vector #1 — inputs

> **WARNING — PUBLIC TEST KEY.** `walletPrivateKey = 0x01` repeated 32 times is a publicly-known test key. Production implementations MUST include a runtime check at `Profile.init()` time that refuses to initialize the pointer layer when `SHA-256(walletPrivateKey) == SHA-256(0x01 × 32)` AND `config.network != 'test-vectors'`. CI suites that run against live testnet MUST use a random key per run, not this canonical vector. Use of this key in shipping builds is a critical security bug because the derived `signingPubKey` is the same across every deployment and leaks the wallet's entire pointer-layer history to any observer who knows the canonical vector. See §11.12 for the general denylist policy.

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
| O-2 | ~~Select / specify the `RootTrustBase` source (static bundled, remote-fetched, hybrid).~~ **RESOLVED in v3.4:** `RootTrustBase` is the SDK-bundled asset at `assets/trustbase/<network>.ts`, shared with L4 / `PaymentsModule` per §8.4.2. | Aggregator team | Resolved. |
| O-3 | Tune `DISCOVERY_INITIAL_VERSION` against real wallet publish-rate data after 4 weeks of field use. | SDK team | No (ship-time default is acceptable). |
| O-4 | Decide whether `isValidCid` accepts codecs beyond sha2-256 multihashes (track upstream `profile/ipfs-client.ts`). | SDK team | No. |
| O-5 | BLOCKED state override protocol — confirm whether v1 ships with the opt-in override (§10.2.5) or omits it entirely. | Product / SDK team | **Not blocking.** |
| O-6 | ~~Mirror URL list for multi-mirror TOFU cross-check — finalize the static mirror list and embed in the Sphere SDK config (referenced from §8.4).~~ **DEFERRED TO v2 in v3.4:** v1 uses an embedded `RootTrustBase` (§8.4); no runtime mirror list is required. Re-opens in v2 alongside runtime-fetched trust-base + L1-anchored fingerprint (§11.13 item (i)). | Infra team | Deferred to v2. |
| O-7 | ~~Bundle `MIRROR_LIST_SHA256` and `MIRROR_CERT_PINS` (§3) artifacts in the SDK release pipeline.~~ **DEFERRED TO v2 in v3.4:** the constants were removed in v3.4 (§3, §8.4.3). Re-opens in v2 when runtime TLS integrity defenses become applicable. | Infra team | Deferred to v2. |
| O-8 | **SDK compatibility assertion (W8).** The pointer spec depends byte-precisely on `state-transition-sdk` primitives (§4.3, §4.7, §6.4, §8.3). Implementation PR MUST: (1) pin the SDK version range in `package.json` (e.g., `^1.6.1 <2.0.0`); (2) add a CI canary that computes canonical test vector #1 against the pinned SDK version and fails the build if output bytes change; (3) document the SDK-upgrade protocol: a major-version bump requires re-running the full test-vector suite plus cross-implementation verification. | SDK team | **BLOCKING impl-PR merge.** |

### 15.2 Reviewer sign-off checklist

Revision 3.2 is **Stable** only after the following checkboxes are explicitly ticked. Comments MUST be attached to any unchecked item.

- [ ] **Security auditor** — subkey separation (§4.2), one-time-pad discipline + crash-retry marker (§7.1, §11.2), deterministic padding rationale (§4.6, §11.3), embedded-trust-base model (§8.4, §11.5) reviewed and approved.
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
| 3.1 | (2026-04-21) **Hardening pass applying steelman findings on v3.** C1: marker version-jump clamp (`MARKER_MAX_JUMP = 1024`) added to §7.1.4 to block single-write brick attacks; C2: retry-window ciphertext zeroization requirement added to §11.11(a′) with `MAX_CT_RESIDENT_MS = 500`; C3: multi-mirror TOFU cross-check promoted from RECOMMENDED to **MANDATORY** in §8.4 with `MIN_MIRROR_COUNT = 2`, and fresh-install corrupt-payload BLOCKED rule added as §10.2.6; C4: CAR fetch caps `MAX_CAR_BYTES = 100 MiB` and `MAX_CAR_FETCH_MS = 60 s` added to §3 and §8.5; C5: CAR-unavailable persistent state formalized as §10.7 with `acceptCarLoss()` override API; C6: `originated` metadata tag replaces the `signedBy` heuristic for §10.2.3 user-originated-write definition; C7: probe-sequence fingerprint disclosure documented in §11 bullet 10 with v2 mitigation sketches; C8: public-test-key WARNING block added to §14.1 and denylisted-keys policy registered as §11.12; C9: §13 API surface extended with `acceptCarLoss()`, `clearPendingMarker()`, `getProbeFingerprint()`; `isPublishBlocked()` signature made `Promise<boolean>`; C10: arch-doc name alignment tracked separately (spec unchanged; see arch-doc change log); C11: async-await footnote in §4 expanded to cover `SigningService.createFromSecret`, `RequestId.createFromImprint/create`, `Authenticator.create`, `AggregatorClient` methods; C12: §8.4 proof-variable identifier ambiguity resolved via §8.1 `resp.inclusionProof.verify(...)` convention; C13: `DataHasher(X) ≡ new DataHasher(X)` convention note added to §4; C15: new constants `MARKER_MAX_JUMP`, `MAX_CT_RESIDENT_MS`, `MIN_MIRROR_COUNT`, `MAX_CAR_BYTES`, `MAX_CAR_FETCH_MS` registered in §3; new error codes `AGGREGATOR_POINTER_CAR_TOO_LARGE`, `AGGREGATOR_POINTER_CAR_FETCH_TIMEOUT`, `AGGREGATOR_POINTER_CAR_UNAVAILABLE` registered in §12; C16: O-6 promoted to BLOCKING spec sign-off. No byte-level formulas or pre-existing constants changed. |
| 3.2 | (2026-04-21) **Apply steelman findings on r3.1.** **D1 valid-version-continuity** — corrupt versions are SKIPPED during discovery (§8.2 Phase 3 walk-back) rather than treated as MITM signals; REPLACES r3.1 §10.2.6 BLOCKED-on-corrupt rule entirely (§10.2.6 deleted, §10.3 rewritten, new §10.8 recovery-bail); new constant `DISCOVERY_CORRUPT_WALKBACK = 64` and new error `AGGREGATOR_POINTER_CORRUPT_STREAK`; publishing a NEW valid version at `latest_valid_V + 1` after a corrupt one is legitimate and needs no inter-client coordination. **D2** §10.2.2(4) verb aligned with arch §6.7 ("already been attempted AND failed"). **D3** §8.4 single-mirror-TOFU paragraph rewritten to describe multi-mirror degraded mode only; contradiction with adjacent MANDATORY rule resolved. **D4** §7.1.4 `MARKER_MAX_JUMP = 1024` rationale tightened with three-factor breakdown (PUBLISH_RETRY_BUDGET, cohort contention, operational headroom) and documented trade-off of NOT catching subtle same-window tampering. **D5** §10.2.3 semantic `originated`-tag re-validation added to close the tag-forgery bypass (user-action entry types MUST be `'user'`, system entry types MUST be `'system'`, mismatches rejected); new error `SECURITY_ORIGIN_MISMATCH`. **D6** §8.5 streaming byte-count enforcement mandated; `Content-Length` header cannot be sole cap enforcement. **D7** `pointer:marker_cleared` telemetry payload canonicalized: `{ previousMarker: { v, cidHash }, reason: 'user_requested' \| 'auto_compacted' }`. **D8** version heading bumped to 3.2. **D9** this row. **D10** new §11.13 residual-risk block documenting five trade-offs as v2 work: bundled mirror list as centralized trust root; MANDATORY multi-mirror as availability risk; backup/restore triggering MARKER_CORRUPT; denylist governance; corrupt streak as legitimate-use DoS vector. **D11** new API `acceptCorruptStreak(walkbackLimit?)` for §10.8 recovery bail. No byte-level formulas or pre-existing constants changed. |
| 3.3 | (2026-04-20) **Final hardening pass — closes 14 critical + 12 warning findings from 6-agent multi-domain review** (security, code, concurrency, network, unicity-architect, aggregator, SDK-integration). **H1** §8.2 Phase 3 walk-back now distinguishes `SEMANTICALLY_INVALID` (skip) from `TRANSIENT_UNAVAILABLE` (halt + `AGGREGATOR_POINTER_CAR_UNAVAILABLE`) via new `classifyVersion(v)` helper; closes the transient-IPFS-outage orphaning path. **H2** §8.1 probe predicate changed from `aIncluded AND bIncluded` (non-monotonic) to `aIncluded OR bIncluded` (monotonic, matches invariant I-1); Phase 3 still enforces the stricter both-sides check. **H3** §7.1.1 mutex primitives named (Web Locks API in browser, `proper-lockfile` in Node); `MUTEX_KEY` now keyed on `hex(signingPubKey)` for cross-tab / cross-process coverage; new errors `AGGREGATOR_POINTER_UNSUPPORTED_RUNTIME` and `AGGREGATOR_POINTER_PUBLISH_BUSY`. **H4** §8.2 `findLatestValidVersion()` return shape becomes `{ validV, includedV }`; §9.2 reconciliation targets `max(validV, includedV) + 1` to skip past corrupt-included residue and break the RETRY_EXHAUSTED deadlock. **H5** §8.4.1 trust-base rotation handling added (distinguish rotation from forgery via epoch comparison, multi-mirror refresh, monotone epoch enforcement); new error `AGGREGATOR_POINTER_TRUST_BASE_STALE`. **H6** §8.4.2 mandates SHARED `RootTrustBase` with L4 `PaymentsModule` / OracleProvider; closes asymmetric-trust MITM path. **H7** §10.7.1 `acceptCarLoss` discipline rewritten to REQUIRE persistent-retry (`CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS` / `_TOTAL_DURATION_MS` with wall-clock enforcement across restarts), peer-availability poll (`POINTER_PEER_DISCOVERY_MS`), AND mandatory republish BEFORE advance — closes "tokens only in the lost bundle" gap. **H8** §7.3 REJECTED outcome now BURNS `v` (persist `localVersion = v`) to prevent OTP-reuse on retry at same v with different ciphertext. **H9** §8.4.3 TLS discipline added (TLS ≥ 1.3, cert pinning via `MIRROR_CERT_PINS`, CA diversity, IP diversity, mirror-list integrity via `MIRROR_LIST_SHA256`); new errors `AGGREGATOR_POINTER_CERT_PIN_MISMATCH`, `AGGREGATOR_POINTER_MIRROR_LIST_TAMPERED`. **H10** §3 + §8.5 CAR fetch timeout rewritten as progress-rate: `MAX_CAR_FETCH_INITIAL_RESPONSE_MS = 10s`, `MAX_CAR_FETCH_STALL_MS = 30s`, `MAX_CAR_FETCH_TOTAL_MS = 300s`, `MAX_CAR_FETCH_RETRY = 3` per gateway with HTTP Range resume, `Content-Encoding` rejected; former `MAX_CAR_FETCH_MS = 60s` superseded; new error `AGGREGATOR_POINTER_CAR_UNEXPECTED_ENCODING`. **H12** §3 `PROFILE_POINTER_HKDF_INFO` byte count corrected from 32 to 33 (actual ASCII length of `"uxf-profile-aggregator-pointer-v1"`). **H13** §7.1.4 rewritten to PRESERVE the idempotent-retry case (same v AND same cidHash → keep v and re-derive deterministic payload) alongside the rollback-safe bump; reconciles with arch §7.2. **H14** §11.11 zeroization relaxed to achievable JS target: (a) re-derivation discipline as PRIMARY defense (normative), (b) caller-owned zeroization as best-effort, (c) runtime-specific hardening where available, (d) secret-value denylist normative, (e) `SecretKey` wrapper recommended. Warning fixes: **W1** §4.1 walletPrivateKey pinned to BIP32 master. **W2** §8.5 HTTPS-only gateway pool mandated. **W3** §7.3 HTTP status-code outcome rows added (429/503 Retry-After, 5xx backoff, 4xx permanent, JSON-RPC ConcurrencyLimit, protocol-error fail-closed); new error `AGGREGATOR_POINTER_AGGREGATOR_REJECTED`, `AGGREGATOR_POINTER_PROTOCOL_ERROR`. **W4** §3 request timeouts `PUBLISH_REQUEST_TIMEOUT_MS`, `PROBE_REQUEST_TIMEOUT_MS`, `IPNS_RESOLVE_TIMEOUT_MS`. **W5** §7.1.7 identity-capture discipline during critical section. **W6** §13 `clearPendingMarker()` gated on `allowOperatorOverrides` and now SETs BLOCKED. **W7** §13 `acceptCorruptStreak` walk-back floor enforced (never below `localVersion`); new error `AGGREGATOR_POINTER_WALKBACK_FLOOR`. **W8** §15 O-8 SDK version pinning + CI canary. **W9** §11.12 note: client-side denylist is defense-in-depth only; aggregator-side enforcement is the cryptographic boundary. **W11** §10.2.3.1 originated-tag migration inventory (PaymentsModule, AccountingModule, SwapModule, CommunicationsModule, profile-token-storage-provider). **W12** §13 `isReachable()` specified via verified exclusion proof on `HEALTH_CHECK_REQUEST_ID` (no header short-circuit). Also: new error `AGGREGATOR_POINTER_CAPABILITY_DENIED` for operator-override APIs; §14 canonical test vectors unchanged; byte-level formulas (§4 derivations, §5 payload, §6 commitment, §7.1 marker structure) UNCHANGED. Spec is canonical; arch narrates. |
| 3.4 | (2026-04-21) **Amended §3, §8.4, §8.4.1, §8.4.3, §11 bullet 5, §11.13 items (i)/(ii), §12, §15.1 O-2/O-6/O-7, §15.2 sign-off checklist to reflect embedded `RootTrustBase` deployment model.** Multi-mirror TOFU + mirror-list infrastructure deferred to v2 per user infrastructure decision (single aggregator + single IPFS node; see `PROFILE-AGGREGATOR-POINTER-ARCHITECTURE.md §10.6` / §12 cross-ref). 3 constants removed from §3: `MIN_MIRROR_COUNT`, `MIRROR_LIST_SHA256`, `MIRROR_CERT_PINS`. 3 error codes removed from §12: `AGGREGATOR_POINTER_CERT_PIN_MISMATCH`, `AGGREGATOR_POINTER_MIRROR_LIST_TAMPERED`, `AGGREGATOR_POINTER_TRUST_BASE_DIVERGENCE` (error-code count: 30 → 27). §8.4 rewritten as "embedded trust-base anchor" rule (bundled at `assets/trustbase/<network>.ts`, loaded via `impl/shared/trustbase-loader.ts`; pinned across sessions; rotation via SDK update, not runtime refetch). §8.4.1 rotation handling simplified: `NOT_AUTHENTICATED` + epoch mismatch → `AGGREGATOR_POINTER_TRUST_BASE_STALE` (the error code is retained) requiring SDK update; the former multi-mirror refresh flow deleted. §8.4.2 sharpened: "pointer layer MUST consume `RootTrustBase` via `OracleProvider.getRootTrustBase()`; MUST NOT bundle its own; L4 and pointer layer share the same embedded instance." §8.4.3 TLS retains TLS ≥ 1.3 requirement; cert pinning / CA diversity / IP diversity / mirror-list integrity deleted (inapplicable without runtime fetch). §11 bullet 5 TOFU weakness rephrased as "bundle supply-chain is the residual risk; v2 L1-alpha anchoring closes it." §11.13 items (i) / (ii) rewritten to describe the bundled-trust-base supply-chain risk and to mark multi-mirror TOFU as v2 future work. §15.1 O-2 marked RESOLVED (bundled); O-6, O-7 marked DEFERRED TO v2. No change to §4 (key derivation), §6–§7 (submit/probe), §10 (recovery state machine), or §14 (test vectors — O-1 now unblocked on spec-sign-off side). |
