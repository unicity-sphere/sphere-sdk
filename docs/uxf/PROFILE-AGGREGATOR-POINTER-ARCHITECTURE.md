# UXF Profile — Aggregator-Anchored OpLog Pointer

**Status:** Draft v3 — arch↔spec byte-level reconciliation
**Date:** 2026-04-20
**Supersedes:** `profile/profile-ipns.ts` (IPNS snapshot stopgap)
**Companion spec:** [`docs/uxf/PROFILE-AGGREGATOR-POINTER-SPEC.md`](./PROFILE-AGGREGATOR-POINTER-SPEC.md) — v3, canonical owner of byte-level formulas, algorithms, and error codes. The spec is authoritative; this document narrates.
**Related:**
- [`docs/uxf/PROFILE-ARCHITECTURE.md`](./PROFILE-ARCHITECTURE.md) §2.3 (multi-bundle model), §7.6 (migration), §2.1 (global-keys model)
- [`state-transition-sdk`](https://github.com/unicitylabs/state-transition-sdk) — all cryptographic primitives are consumed from this SDK wherever possible (§4.6)

---

## Table of Contents

1. [Motivation & Goals](#1-motivation--goals)
2. [Design Overview](#2-design-overview)
3. [Component Topology](#3-component-topology)
4. [Data & Key Derivation Overview](#4-data--key-derivation-overview)
5. [Versioning Semantics](#5-versioning-semantics)
6. [Recovery Flow](#6-recovery-flow)
7. [Publish Flow & Per-Publish Crash Safety](#7-publish-flow--per-publish-crash-safety)
8. [Conflict Resolution & Concurrency](#8-conflict-resolution--concurrency)
9. [Privacy Model](#9-privacy-model)
10. [Logarithmic Version Discovery](#10-logarithmic-version-discovery)
11. [Consistency Model](#11-consistency-model)
12. [Failure Modes & Degraded Operation](#12-failure-modes--degraded-operation)
13. [Observability](#13-observability)
14. [Alternatives Considered](#14-alternatives-considered)
15. [Migration From the IPNS Stopgap](#15-migration-from-the-ipns-stopgap)
16. [Open Questions](#16-open-questions)
17. [Approvals Needed](#17-approvals-needed)

---

## 1. Motivation & Goals

### 1.1 Why the IPNS stopgap is insufficient

The current Profile cold-start recovery mechanism (`profile/profile-ipns.ts`) publishes a JSON snapshot of active bundle CIDs to IPNS, keyed by a wallet-derived Ed25519 identity (`deriveProfileIpnsIdentity`, HKDF info `"uxf-profile-ed25519-v1"`). It has four structural weaknesses we are no longer willing to ship past the "stopgap" label:

1. **Eventual consistency.** IPNS records propagate via DHT/PubSub and public gateways. There is no synchronous confirmation that a published record is visible elsewhere. A device that wipes state minutes after a publish may resolve an older record, or none.
2. **No single source of truth for "latest version."** Two devices racing produce two signed records with different `sequence` numbers. IPNS record selection is per-resolver ("highest sequence I happened to see"); neither writer learns it lost.
3. **Routing vs. signing surface area.** IPNS pulls in libp2p key generation, record marshalling, gateway-specific resolve semantics, UnixFS vs. raw-CID mismatches, and a monotonic sequence we must persist. Each is a surface we would rather not own.
4. **Public-key correlation.** The IPNS name is a deterministic function of the wallet private key, and the snapshot body embeds `walletPubkey` verbatim. A passive observer who knows a wallet address can derive a candidate IPNS name and watch its history.

### 1.2 What the aggregator gives us

The Unicity aggregator is a Sparse Merkle Tree (SMT) that the ecosystem already runs and already trusts as SSOT for L4 state transitions. It answers `(requestId) → (inclusion | exclusion)` proofs synchronously, and every proof is verifiable against a public root.

| Property | IPNS stopgap | Aggregator pointer |
|---|---|---|
| SSOT | No (per-gateway resolution) | Yes (SMT root, BFT-ordered) |
| Write confirmation | Best-effort; returns before propagation | Synchronous; aggregator accept ≡ commit |
| Latest-version determination | Highest seq observed by local resolver | Verified exclusion proof at `V+1` ⇒ proof of "no V+1 exists" |
| Conflict detection | None (silent overwrites possible) | Inherent: aggregator rejects duplicate request IDs |
| External identity footprint | Ed25519 peer ID visible; snapshot includes wallet pubkey | Request IDs unlinkable without master key; values XOR-blinded |
| Auditability | Limited (IPNS record history) | Full (verifiable SMT proof chain) |
| Operational cost | libp2p + gateway ops + monotonic seq persistence | Two aggregator commits per publish |
| Dependency graph | libp2p/crypto, libp2p/peer-id, ipns, UnixFS gateway | `state-transition-sdk` (already present in the SDK) |

Collapsing the recovery mechanism onto infrastructure we already operate strengthens privacy, gains synchronous conflict detection, and removes the libp2p/UnixFS/gateway surface — all in a single move.

### 1.3 Goals

- **G1. Synchronous, deterministic "latest version" discovery.** Given only a mnemonic, any device can determine the globally current published pointer without waiting on propagation.
- **G2. Pseudonymity per wallet (not per commit).** A passive aggregator observer cannot link commits to the wallet's *chain pubkey* or *L1 address*, but CAN cluster commits by the stable `signingPubKey` used for pointer authenticators. See §9.2 — this is a conscious downgrade from "unlinkable across commits," documented as known residual risk.
- **G3. Universal CID support.** The scheme accommodates any CID the Profile can produce — CIDv0 (34 bytes), CIDv1+sha256 (~36 bytes), CIDv1+sha512 (~68 bytes), future multihash codecs — up to a 63-byte budget per publish (64-byte envelope minus the 1-byte length prefix; see §4.4).
- **G4. Race-safe multi-device publish.** Two devices publishing concurrently MUST NOT silently overwrite each other. Exactly one wins at any given version; the loser learns synchronously and re-merges.
- **G5. Bounded cold-start cost.** Recovery is `O(log V_true)` aggregator round-trips, not `O(V_true)`.
- **G6. No data loss on partial failures.** The CAR bundle is pinned to IPFS before the pointer is committed. A crashed publish leaves the bundle pinned and recoverable on the next attempt, and retries are **deterministic and idempotent** (§7.2).
- **G7. Mnemonic-only recovery.** The entire recovery path must be re-runnable from a mnemonic alone, with zero prior local state and no prior interaction with any other on-chain object (no token state chain to re-enter, no key rotation path to follow).

### 1.4 Non-goals

See §16 for the full list. Explicitly:

- This design does not attempt to hide aggregator-submission **timing** patterns.
- It does not GC old SMT commitments (append-only by construction).
- It does not add a new key-signing surface beyond what `state-transition-sdk` already provides (§4.6).
- **It does not touch L1 (ALPHA blockchain) at any point.** Pointer commits are entirely an L3 concern.
- **Nostr-delivered events (DMs, NIP-17) are NOT pointer-anchored.** They remain ephemeral transport events outside the Profile-pointer scope.

---

## 2. Design Overview

This section walks through one publish and one recovery at the narrative level. Formulas are only sketched; the [companion spec](./PROFILE-AGGREGATOR-POINTER-SPEC.md) owns the bit-level details.

### 2.1 Core idea in one paragraph

Every time the Profile's OpLog head advances, we assign the new head a monotonically-increasing **version number** `V ∈ ℕ⁺`. We split the new head CID across **two SMT leaves** `A` and `B` at deterministically-derived request IDs `r_A(V)` and `r_B(V)`. Each leaf value is the CID half XOR-blinded with a per-version, per-side key. The aggregator, holding both leaves, does not know they are halves of a CID, nor whose, nor that they are related. The wallet, holding the master key, can (a) compute `(r_A(V), r_B(V))` for any `V`, (b) ask the aggregator for inclusion or exclusion proofs at those request IDs, and (c) decrypt the values once retrieved.

### 2.2 Why two plain leaves, and not a tokenized pointer?

An attractive alternative is to represent the pointer as a **tokenized L3 token** whose state transitions point to successive OpLog CIDs. This was explicitly considered and **rejected**. See §14 for the full comparison; the load-bearing reason is G7 (mnemonic-only recovery):

> A tokenized token's state data cannot serve as a pointer recoverable from *mnemonic alone, with no prior setup*. To re-enter a token state chain, the wallet must already know the token's current state hash (or some anchor that locates the chain). On a fresh device with only a mnemonic, that anchor does not exist. The two-leaf plain-commitment design re-derives `r_A(V)`, `r_B(V)` purely from the master key and a version integer — no prior anchor needed.

### 2.3 Why two leaves? The CID length problem

Aggregator leaves hold 32-byte values. CIDs are variable-length:

| CID shape | Typical length |
|---|---|
| CIDv0 (bare sha256 multihash) | 34 bytes |
| CIDv1 + dag-cbor + sha256 | ~36 bytes |
| CIDv1 + dag-pb + sha256 | ~36 bytes |
| CIDv1 + raw + sha256 | ~36 bytes |
| CIDv1 + dag-cbor + sha512 | ~68 bytes (forward-compat; too large — see §4.4) |

Splitting across two leaves gives us **64 bytes of envelope**, which covers every CID shape we reasonably expect today. The spec fixes a 1-byte length prefix inside the envelope (§4.4), leaving **63 bytes of usable CID**. CIDs longer than 63 bytes are rejected at publish time (`AGGREGATOR_POINTER_CID_TOO_LARGE`); a three-leaf extension is documented as future work in the spec.

### 2.4 Why XOR-blind the values?

The aggregator operator (and any passive observer with database access) sees leaf values in the clear. Writing CID halves directly would let operators:

- detect pairs of leaves whose concatenation parses as a valid CID prefix,
- fingerprint "this request ID family" as belonging to the Profile-pointer product,
- test which gateway serves which CAR bundle and cross-correlate with wallet activity.

XOR-blinding with `xorKey_{side, V} = SHA-256(xorSeed || [side] || be32(V) || bytes_of("xor"))` (bare SHA-256 via DataHasher; see §4.3) gives each leaf the distribution of uniformly-random 32-byte strings. Without `xorSeed`, an observer cannot distinguish a blinded leaf from any other 32-byte random payload the aggregator holds.

### 2.5 Why exclusion proofs as the "end" signal?

The aggregator supports both **inclusion proofs** ("the leaf at `r` has value `v`, here's a Merkle path") and **exclusion proofs** ("no leaf at `r`, here's a Merkle path proving absence"). Both are first-class cryptographic objects, verifiable via the SDK's `InclusionProof.verify(trustBase, requestId)`.

The "latest published version is `V`" claim is therefore expressible as a conjunction of four verifiable proofs:

```
  inclusion(r_A(V)) ∧ inclusion(r_B(V)) ∧ exclusion(r_A(V+1)) ∧ exclusion(r_B(V+1))
```

Any party holding `pointerSecret` can compute the four request IDs, fetch the four proofs, and verify them locally against the aggregator's published root. This is stronger than IPNS's "highest sequence I happened to see" — it is a cryptographically verifiable statement about the entire published history.

### 2.6 One-sentence publish flow

> *Compute next version `V`; persist `(V, H(cidBytes))` to local crash-safety storage (§7.2); pin the bundle CAR to IPFS; derive `r_A(V)`, `r_B(V)` via the SDK's `RequestId.createFromImprint` formula (§4.3) and derive `xorKey_{A,V}`, `xorKey_{B,V}` as bare SHA-256 over `xorSeed || [side] || be32(V) || "xor"`; XOR-blind the CID halves (with deterministic padding — §4.5); sign two aggregator commitments via the SDK's `Authenticator.create(signingService, transactionHash, stateHash)`; submit both in parallel via the aggregator client; confirm both succeeded via `InclusionProof.verify(trustBase, requestId)`.*

### 2.7 One-sentence recovery flow

> *From the mnemonic, derive `pointerSecret` via HKDF; run exponential-probe + binary-search against `r_A(V)` and `r_B(V)` at every probed version (§10); upon convergence, fetch inclusion proofs at `(r_A(V), r_B(V))` and exclusion proofs at `(r_A(V+1), r_B(V+1))`, verify all four via `InclusionProof.verify`, XOR-decode the blinded halves to recover the CID; fetch the CAR from IPFS; seed OrbitDB; resume normal load.*

---

## 3. Component Topology

This scheme slots into the existing Profile stack as a **new publish/resolve channel** inside `ProfileTokenStorageProvider`, replacing the IPNS helpers. No other component's contract changes. OrbitDB remains authoritative for live multi-device operation; IPFS remains the CAR blob store. The aggregator is consulted only on (a) publish after flush, and (b) cold-start recovery when OrbitDB has no bundles locally.

### 3.1 High-level component diagram

```
                 ┌─────────────────────────────────────────────┐
                 │ Sphere SDK Wallet (L5)                      │
                 │                                             │
                 │  ProfileTokenStorageProvider                │
                 │  ┌───────────────────────────────────────┐  │
                 │  │ flushToIpfs()                         │  │
                 │  │   1. pin CAR to IPFS ─────────────────┼──┼─► IPFS (gateways)
                 │  │   2. db.put(tokens.bundle.CID,...)    │  │
                 │  │   3. persist (V_next, H(cidBytes))    │  │
                 │  │   4. publishPointer(V_next, CID) ─────┼──┼─► Unicity Aggregator (L3)
                 │  │      via state-transition-sdk         │  │         │
                 │  └───────────────────────────────────────┘  │         │
                 │  ┌───────────────────────────────────────┐  │         │
                 │  │ initialize() (cold-start)             │  │         │
                 │  │   1. recoverLatestPointer() ──────────┼──┼─────────┘ (probe + verify)
                 │  │   2. fetch CAR from IPFS ◄────────────┼──┼─◄  IPFS
                 │  │   3. db.put(tokens.bundle.CID,...)    │  │
                 │  │   4. normal load continues            │  │
                 │  └───────────────────────────────────────┘  │
                 │                                             │
                 │  OrbitDB (source of truth during live ops)  │
                 │  IPFS client (CAR pin/fetch, unchanged)     │
                 └─────────────────────────────────────────────┘
```

### 3.2 Publish integration (`flushToIpfs`)

`profile/profile-token-storage-provider.ts::flushToIpfs` currently:

1. Serializes the token set to a UXF CAR file.
2. Pins the CAR to IPFS (`pinToIpfs`).
3. Writes `tokens.bundle.{CID}` into OrbitDB.
4. Calls `publishIpnsSnapshotBestEffort()`.

Step 4 is replaced by `publishAggregatorPointerBestEffort()` with the following contract:

| Aspect | Contract |
|---|---|
| Inputs | `identity.privateKey`, new bundle CID bytes, current local version counter, reference to local crash-safety store |
| Reads | Local version counter (same storage scope previously used for the IPNS sequence) |
| Writes | Crash-safety tuple `(V, H(cidBytes))` BEFORE submitting; local version counter (bumped on success); aggregator commits `r_A(V)` and `r_B(V)` |
| Success | Both commits return INCLUDED (verified via `InclusionProof.verify(trustBase, requestId)`) |
| Conflict | At least one commit rejected as "request ID already taken" — triggers reconciliation (§8) |
| Transient failure | Deterministic idempotent retries (§7.2); ultimate failure is logged, not thrown — CAR is already in IPFS; next flush retries |
| Parallelism | The two commits are independent and SHOULD be submitted concurrently |

Flush success does not depend on pointer publish success. The Profile correctness boundary remains (IPFS pin + OrbitDB write); the pointer is a recovery assist.

### 3.3 Recovery integration (`initialize`)

`ProfileTokenStorageProvider::initialize` currently contains (around line 278–280):

```
if (this.knownBundleCids.size === 0) {
  await this.recoverFromIpnsSnapshot();
}
```

The body of `recoverFromIpnsSnapshot` is replaced by `recoverFromAggregatorPointer()`. The trigger condition is unchanged.

| Aspect | Contract |
|---|---|
| Inputs | `identity.privateKey`, aggregator client, `RootTrustBase` (§6.5) |
| Side effects | Zero or more `db.put('tokens.bundle.' + cid, ref)` writes |
| No-pointer-yet case | Silent no-op, verified via an aggregator-provided exclusion proof at `V=1` |
| Aggregator unreachable | **Logged warning; proceed; BUT the next user-originated publish is blocked until reachability is confirmed (§6.7, C-5).** This prevents a transient outage from silently overwriting a legitimate remote history. |
| Partial publish detected | Handled per §12.3 (retry side B idempotently at the same `V`) |
| Proof verification | Every inclusion or exclusion proof is verified via `InclusionProof.verify(trustBase, requestId)`. Unverifiable proofs abort recovery with `AGGREGATOR_POINTER_PROOF_INVALID`. |

### 3.4 Interactions with existing layers

| Layer | Change | Reason |
|---|---|---|
| OrbitDB adapter | None | Pointer is orthogonal; OpLog replication unchanged |
| IPFS client (`pinToIpfs`, `fetchFromIpfs`) | None | CAR bundles are still content-addressed and pinned identically |
| `deriveProfileIpnsIdentity` | **Deleted** | IPNS path retired |
| HKDF key-derivation pattern (`impl/shared/ipfs/ipns-key-derivation.ts`) | **Reused (pattern), new info strings** | §4.1 — four distinct info strings under one shared HKDF helper |
| `state-transition-sdk` | Expanded consumer | First Profile-layer use of aggregator commitments that are NOT token-bound; uses `SigningService`, `DataHasher`, `RequestId.createFromImprint`, `Authenticator.create`, submission client, `InclusionProof.verify`, `RootTrustBase` |

### 3.5 Failure-surface minimization

The scheme intentionally shares key-derivation **style** with `impl/shared/ipfs/ipns-key-derivation.ts` (HKDF-SHA256 from the wallet private key, distinct info strings per purpose). Reviewers examining the Profile security story should find one HKDF pattern invoked four times with four info strings — not four different derivation schemes. See §4.1.

---

## 4. Data & Key Derivation Overview

This section names the derived quantities and their purposes. Exact byte layouts, domain-separation tags, and encoding rules live in [the companion spec](./PROFILE-AGGREGATOR-POINTER-SPEC.md).

### 4.1 Key derivation chain

Let `mk` denote the wallet's 32-byte secp256k1 private key — **the same key used for L1 and L3 operations today**. Reusing it at the HKDF-input level is acceptable because the random-oracle model guarantees that HKDF outputs with distinct `info` strings are computationally independent.

```
     mk  (wallet secp256k1 private key, 32 bytes)
      │
      ▼
  HKDF-SHA256-Extract + Expand(info = "uxf-profile-aggregator-pointer-v1")
      │
      ▼
  pointerSecret  (32 bytes — master secret for the pointer layer)
      │
      ├── HKDF-Expand(info = "uxf-profile-pointer-sig-v1",  L=32)  →  signingSeed
      │                                                              │
      │                                                              ▼
      │                                       SigningService.createFromSecret(signingSeed)
      │                                                              │
      │                                                              ▼
      │                                              signingPubKey (33-byte compressed secp256k1)
      │
      ├── HKDF-Expand(info = "uxf-profile-pointer-xor-v1",  L=32)  →  xorSeed
      │                                                              │
      │                                                              ▼
      │                                       xorKey_{side, V} = SHA-256(xorSeed ||
      │                                                                  [side] ||
      │                                                                  be32(V) ||
      │                                                                  bytes_of("xor"))
      │                                       (bare SHA-256 via DataHasher; 40-byte preimage, 32-byte output)
      │
      └── HKDF-Expand(info = "uxf-profile-pointer-pad-v1",  L=32)  →  padSeed
                                                                     │
                                                                     ▼
                                             padBytes_V = HKDF-Expand(padSeed,
                                                                      info = be32(V) || bytes_of("pad"),
                                                                      L = 63 − cidLen)
                                             (shared across both sides)
```

The four info strings are:

| Name | Info string | Purpose |
|---|---|---|
| `pointerSecret` | `"uxf-profile-aggregator-pointer-v1"` | Master secret for the pointer layer |
| `signingSeed` | `"uxf-profile-pointer-sig-v1"` | Seed for the secp256k1 signing key (§4.6) |
| `xorSeed` | `"uxf-profile-pointer-xor-v1"` | Root for per-version XOR keys |
| `padSeed` | `"uxf-profile-pointer-pad-v1"` | Root for per-version deterministic padding (§4.5, W-5) |

Under the random-oracle model, knowledge of any one subkey does not reveal any other.

### 4.2 Why HKDF from the private key — not the public key

A public-key-based derivation would be catastrophic: anyone who knows the wallet's chain pubkey (published on Nostr, embedded in DIRECT://, announced in nametag records) could derive the same request IDs and grind the SMT to correlate commits with that wallet. **The private key is the only acceptable input.** This is a hard invariant; any future variant needing public-key-derivable request IDs must be a separate scheme with its own info strings and threat-model analysis.

### 4.3 Per-version, per-side request IDs and state hashes

These use **`state-transition-sdk` primitives exclusively** — this design does not redefine them.

| Name | Derivation |
|---|---|
| `stateHashDigest(side, V)` | `DataHasher(SHA256).update(xorSeed).update([side]).update(be32(V)).update(bytes_of("state")).digest()` → `DataHash` (42-byte preimage) |
| `stateHash(side, V).imprint` | 2-byte algorithm tag (`[0x00, 0x00]` for SHA-256) ‖ 32-byte digest — provided by `DataHash.imprint` |
| `requestId(side, V)` | `RequestId.createFromImprint(signingPubKey, stateHash(side, V).imprint)` — **this is the canonical SDK formula**; equivalent to `sha256(signingPubKey \|\| imprint)` |

**C-2 reviewer-finding compliance.** The request-ID formula operates on `stateHash.imprint`, NOT the raw 32-byte digest. The imprint is `[algo_hi, algo_lo] ‖ digest` (34 bytes for SHA-256 with `algo = [0x00, 0x00]`). Any reader tempted to short-circuit this as `H(pubkey ‖ digest)` is wrong — **use `RequestId.createFromImprint` and do not re-implement the hash by hand.**

### 4.4 Value encoding and length hint

**Decision (reviewer C-3):** the length hint is encoded as a **1-byte length prefix at offset 0 of the first leaf's plaintext**. This is Option (a) from the prior draft.

```
   Plaintext layout (before XOR):
   bytes [0 .. 63]
   ┌────┬──────────────────────────────────────────────────────────────┐
   │ L  │ cid[0 .. L-1]        │ padding[L+1 .. 63]                    │
   └────┴──────────────────────────────────────────────────────────────┘
     ▲
     └─ 1-byte length prefix (unsigned, 1..63)

   │<─── leaf A plaintext (32 bytes) ───>│<─── leaf B plaintext (32 bytes) ───>│

   Then each leaf is separately XOR-blinded:
     cipherA = XOR(plainA, xorKey(A, V))
     cipherB = XOR(plainB, xorKey(B, V))
```

**Rationale (why Option a, not self-delimiting CID parsing):**

- Deterministic recovery of `L` without probing. The decoder reads byte 0, knows the CID length, and trims.
- The L byte is XOR-blinded by the one-time pad and therefore invisible to external observers.
- Avoids dependency on a CID-parser-that-tolerates-trailing-random-bytes (an error-prone feature).
- Maximum usable CID length is `64 − 1 = 63` bytes.

CIDs longer than 63 bytes are rejected at publish time with `AGGREGATOR_POINTER_CID_TOO_LARGE` (spec §12). A three-leaf extension is future work.

### 4.5 Deterministic padding (reviewer W-5)

Padding bytes are NOT generated from a CSPRNG. They are derived deterministically, **once per version and shared across both sides** (not per-side):

```
cidLen       = len(cidBytes)           (1 ≤ cidLen ≤ 63)
padLength    = 63 − cidLen             (always ≥ 0)
padBytes_V   = HKDF-Expand(padSeed, info = be32(V) || bytes_of("pad"), L = padLength)
```

The single `padBytes_V` buffer occupies plaintext offsets `[1 + cidLen .. 64)` of the 64-byte envelope (spanning side A and side B, see §4.4 layout); there is no per-side padding.

Benefits:

- **Crash-retry is byte-identical** → idempotent aggregator re-submission (W-5, C-4).
- **No CSPRNG dependency** at publish time.
- Privacy-neutral: `padSeed` is secret-derived; the ciphertext is still uniformly-random-looking to any observer without `pointerSecret`.

Under the random-oracle model, `padBytes_V` is independent of `xorKey_{side, V}` and `stateHashDigest_{side, V}` because padding derives from `padSeed` under a `"pad"` suffix, while the `xorKey` and `stateHashDigest` are bare SHA-256 over `xorSeed`-prefixed preimages under `"xor"` and `"state"` suffixes respectively (see §4.3). Domain separation via distinct seeds and distinct suffixes makes the three outputs computationally independent.

### 4.6 SDK primitives used (reviewer N-4)

Every cryptographic or aggregator-facing operation in this scheme maps onto an existing `state-transition-sdk` primitive. Implementors MUST use the SDK calls below rather than re-implementing the formulas:

| Operation | SDK call |
|---|---|
| HKDF-SHA256 from wallet secret | `@noble/hashes/hkdf` — already used in `impl/shared/ipfs/ipns-key-derivation.ts`. Non-SDK dependency, permitted. |
| SHA-256 digest | `new DataHasher(HashAlgorithm.SHA256).update(bytes).digest()` — returns a `DataHash` |
| Derive signing keypair from seed | `SigningService.createFromSecret(signingSeed)` — returns a service whose `publicKey` is the 33-byte compressed secp256k1 pubkey. **Rationale (load-bearing): the `createFromSecret` form SHA-256-hashes its input before using it as the secp256k1 private-key scalar. This provides free rejection-sampling-equivalent uniformity across the curve's group order and is required for interoperability between implementations. The raw constructor `new SigningService(seed)` would produce a DIFFERENT `signingPubKey` for the same seed and MUST NOT be used.** |
| Compute request ID | `RequestId.createFromImprint(signingPubKey, stateHash.imprint)` |
| Build authenticator | `Authenticator.create(signingService, transactionHash, stateHash)` |
| Build submission | `SubmitCommitmentRequest` (fields: `requestId`, `transactionHash`, `authenticator`) |
| Submit to aggregator | `aggregatorClient.submitCommitment(request)` |
| Verify inclusion/exclusion proof | `InclusionProof.verify(trustBase, requestId)` |
| Trust-base anchor | `RootTrustBase` (see §6.5 for TOFU / cross-check strategy) |

**Non-SDK primitives allowed:** HKDF-SHA256 (`@noble/hashes/hkdf`) and bytewise XOR. **No CSPRNG is used** — padding is deterministic (§4.5).

**Banned primitives:**

- **Ed25519 is banned.** The aggregator accepts secp256k1 authenticators only. The signing key is secp256k1, derived via HKDF-Expand from `signingSeed` (§4.1) and handed to the SDK's secp256k1 SigningService. Any reference to Ed25519 in the current codebase (`deriveProfileIpnsIdentity` in `profile/profile-ipns.ts`) is deleted as part of this migration.
- Custom hash constructions, custom signature schemes, custom SMT proof verifiers.

---

## 5. Versioning Semantics

### 5.1 What counts as a "new version"

A new version is minted every time the Profile's OpLog head advances to a new CID that the wallet wants to anchor. In the current Profile model, that corresponds to every `flushToIpfs()` that produces a new bundle CID. Triggering events:

- Token arrivals / spends.
- DM arrivals.
- Nametag registrations.
- Profile schema changes.
- Consolidation rewrites (PROFILE-ARCHITECTURE §2.3).

### 5.2 The version counter

- **Scope: per wallet, not per address or per device** (reviewer N-10). All HD addresses under one mnemonic share one OpLog and therefore one pointer chain. Matches PROFILE-ARCHITECTURE §2.1 global-keys model.
- Domain: `ℕ⁺` (1, 2, 3, ...). `V = 0` means "no version has ever been published" and manifests as a verified exclusion proof at `r_A(1)`.
- Local storage: cached at `profile.pointer.version`. The local value is an optimization; authoritative latest-version is rediscovered from the aggregator on conflict or cold start.
- **Multi-network scoping (reviewer N-9):** testnet vs mainnet pointer chains are disjoint because each aggregator runs its own SMT. Key derivations are identical across networks; only the aggregator URL differs.

### 5.3 The monotonicity invariant

> **Invariant I-1.** If `V` is the highest version the aggregator has ever committed for this wallet, then for every `V' ≤ V`, at least one of `r_A(V')`, `r_B(V')` is included. Simultaneous exclusion of both sides at any `V' ≤ V` is impossible. The "include/exclude boundary" on either side is therefore well-defined for binary search.

### 5.4 Retry on conflict (preview)

If the wallet attempts to publish at `V_next = V_local + 1` and the aggregator rejects one or both submissions as "request ID already taken," the wallet discovers the true `V_true`, merges the winner's CID, and retries at `V_true + 1`. See §8 for details.

### 5.5 Aggregator reset (reviewer N-8)

If the aggregator SMT is reset (e.g., testnet wipe), the wallet's `localVersion` is stale. On first publish post-reset, submission at `localVersion + 1` may succeed because the fresh aggregator has no entry — but the wallet's view of "latest CID" from IPFS may still be valid, and the merge path still works. An explicit `Profile.resetPointerVersion()` hook is provided for manual migration.

---

## 6. Recovery Flow

### 6.1 When it runs

Recovery is triggered in `ProfileTokenStorageProvider::initialize` when the local OrbitDB has zero bundle keys. Classic "fresh device after mnemonic re-import." It also runs as part of conflict handling when a publish is rejected (§8).

### 6.2 End-to-end sequence (ASCII)

```
   Wallet                         Aggregator                    IPFS
   ──────                         ──────────                    ────
     │ (boot from mnemonic)           │                           │
     │                                │                           │
     │ derive mk, pointerSecret,      │                           │
     │   signingSeed, xorSeed,        │                           │
     │   padSeed (§4.1)               │                           │
     │                                │                           │
     │ obtain RootTrustBase           │                           │
     │   (TOFU or pinned, §6.5)       │                           │
     │                                │                           │
     │ ─── probe r_A(V_init) ───────►                             │
     │ ─── probe r_B(V_init) ───────►  (parallel, same V)         │
     │ ◄── inclusion/exclusion ───────                             │
     │ ◄── inclusion/exclusion ───────                             │
     │   (exponential phase, §10)     │                           │
     │                                │                           │
     │   ...binary search...          │                           │
     │                                │                           │
     │ (converged: V_true = 833)      │                           │
     │                                │                           │
     │ ─── getProof r_A(833) ──────►                              │
     │ ─── getProof r_B(833) ──────►  (parallel)                  │
     │ ─── getProof r_A(834) ──────►                              │
     │ ─── getProof r_B(834) ──────►                              │
     │ ◄── inclusion(ctA) ────────────                             │
     │ ◄── inclusion(ctB) ────────────                             │
     │ ◄── exclusion ────────────────                              │
     │ ◄── exclusion ────────────────                              │
     │                                │                           │
     │ InclusionProof.verify(trustBase, requestId) × 4            │
     │ (reject recovery if ANY fails)                             │
     │                                │                           │
     │ XOR-decrypt → plainA || plainB                             │
     │ L = plainA[0]                                              │
     │ cid = plainA[1..L+1] || plainB[...] (trim padding)         │
     │ validate CID decode                                        │
     │                                │                           │
     │ ──── fetch CAR(cid) ─────────────────────────────────────►│
     │ ◄─────────────────────────────────────── CAR bytes ────────│
     │                                │                           │
     │ db.put('tokens.bundle.' + cid, { status: 'active', ... })  │
     │ emit pointer:recovered { version, bundleCount }            │
     │                                │                           │
     │ (normal PaymentsModule load resumes; OrbitDB replication   │
     │  catches up in the background with any newer bundles)     │
```

### 6.3 Step-by-step narrative

1. **Bootstrap secrets.** From the mnemonic, derive `mk`; derive `pointerSecret`, `signingSeed`, `xorSeed`, `padSeed` via HKDF (§4.1).
2. **Obtain the trust base.** Load `RootTrustBase` per §6.5. If unavailable, abort recovery with a diagnostic — we will not accept unverified aggregator claims.
3. **Probe reachability.** A single probe at `V = 1` tells us whether the aggregator is reachable AND whether any pointer exists. If the aggregator is unreachable, enter the blocked state (§6.7).
4. **Discover `V_true`.** Run exponential + binary search (§10). **Probe both `r_A(V)` and `r_B(V)` at every probed version** (reviewer C-3). Seed the search with `max(localVersion, 0)` if a stale local counter is available (reviewer W-7).
5. **Fetch and verify.** Request inclusion proofs at `(r_A(V), r_B(V))` and exclusion proofs at `(r_A(V+1), r_B(V+1))`. Verify each via `InclusionProof.verify(trustBase, requestId)`. If any verification fails, abort with `AGGREGATOR_POINTER_PROOF_INVALID`.
6. **Decrypt.** Compute `xorKey(A, V)` and `xorKey(B, V)`. XOR each leaf's ciphertext digest to recover the plaintext halves.
7. **Reconstruct the CID.** Read `L = plainA[0]`, assemble `cid = (plainA[1..32] ‖ plainB[0..])[0..L]`, attempt CID decode (codec, multihash check). On failure, emit `AGGREGATOR_POINTER_CORRUPT` and abort — see §12.4.
8. **Fetch the CAR.** Via existing `fetchFromIpfs(cid)`. If unavailable on all gateways, log and proceed with empty state (same fallback as IPNS today).
9. **Seed OrbitDB.** Insert `tokens.bundle.{cid}` with `status: 'active'`. Idempotent under OrbitDB LWW KV.
10. **Hand off.** `PaymentsModule.load()` runs its normal multi-bundle merge.

### 6.4 Pseudocode (minimal)

```
fn recover(mk, trustBase):
    pointerSecret, signingSeed, xorSeed, padSeed := deriveKeys(mk)
    signingService := SigningService.createFromSecret(signingSeed)
    signingPubKey := signingService.publicKey

    V := findLatestVersion(pointerSecret, signingPubKey, trustBase)
    if V == 0:
        return EmptyProfile

    (proofA, proofB) := parallel(
        aggregator.getProof(requestId(SIDE_A, V, pointerSecret, signingPubKey)),
        aggregator.getProof(requestId(SIDE_B, V, pointerSecret, signingPubKey))
    )
    (excA, excB) := parallel(
        aggregator.getProof(requestId(SIDE_A, V+1, pointerSecret, signingPubKey)),
        aggregator.getProof(requestId(SIDE_B, V+1, pointerSecret, signingPubKey))
    )
    require proofA.isInclusion and proofB.isInclusion
    require excA.isExclusion and excB.isExclusion
    require all(InclusionProof.verify(trustBase, req) in {proofA, proofB, excA, excB})

    plainA := xor(proofA.value, xorKey(SIDE_A, V, xorSeed))
    plainB := xor(proofB.value, xorKey(SIDE_B, V, xorSeed))
    L := plainA[0]
    cid := (plainA[1..32] || plainB)[0..L]
    validateCidOrThrow(cid)

    car := fetchCar(cid)
    seedOrbitDb(cid, car)
    emit(pointer:recovered { version: V, bundleCount: 1 })
```

### 6.5 Trust base and the TOFU problem (reviewer C-6)

Every proof returned by the aggregator is verified locally via `InclusionProof.verify(trustBase, requestId)` against a `RootTrustBase` the wallet obtained through a trusted channel.

**Problem on a fresh device with only a mnemonic.** No prior trust-base fingerprint is stored locally.

**Layered mitigation strategy:**

1. **Initial TOFU (Trust-On-First-Use).** On the very first aggregator contact from a fresh device, the wallet accepts the advertised trust-base root as correct. This is the minimum bootstrap level for v1.
2. **Multi-mirror cross-check (v1.5).** Query 2+ independent aggregator mirrors and require matching roots. Any mismatch → abort with operator alert. Cheap; recommended as a fast-follow.
3. **L1-anchored pinning (v2).** The aggregator root is periodically anchored to an ALPHA (L1) coinbase height. The wallet pins the most recent L1-anchored root and rejects aggregator roots that do not chain to it. Strongest guarantee; requires the L1 anchoring mechanism, which is outside this PR.

The architecture document does NOT mandate (2) or (3) for the initial implementation — they are documented as the roadmap. What IS mandated is that (1) the TOFU path is explicit, logged, and user-visible, and (2) verification is never skipped.

### 6.6 Fresh-wallet / no-pointer-yet case

A wallet that has never published (new mnemonic, freshly imported, no activity) will receive a verified exclusion proof at `r_A(1)` and `r_B(1)` from the aggregator. Recovery reports `V = 0`, no CAR is fetched, OrbitDB remains empty, and the wallet is ready to publish its first version.

### 6.7 Aggregator-unreachable recovery path (reviewer C-5)

**Previous behavior (rejected):** log a warning and proceed with empty state, letting the next publish act as if `V = 1` were the first version. This is unsafe — if the aggregator was merely unreachable, the next publish overwrites a legitimate remote history at `V = 1`.

**Mandated behavior (narrative; spec §10.2 owns the byte-level state machine):**

The wallet maintains a per-wallet **persistent** BLOCKED flag — the canonical storage key is `BLOCKED_FLAG_KEY = "profile.pointer.blocked." + hex(signingPubKey)` (spec §10.2.1). The flag survives process restarts. An absent key is equivalent to `false`. When BLOCKED is set, `publishAggregatorPointerBestEffort` refuses to run and the publish attempt surfaces `AGGREGATOR_POINTER_UNREACHABLE_RECOVERY_BLOCKED`. The state flips as follows:

- **SET BLOCKED** when ALL of these hold (spec §10.2.2): (i) recovery (`initialize()` or a subsequent reconciliation) hit a **categorical** transport error (timeout, connection refused, DNS failure, TLS error — NOT a transient 5xx); (ii) the local OpLog contains at least one **user-originated** write; (iii) at least one retry with exponential backoff has already failed. Re-SET on the same category of error during a subsequent publish.
- **User-originated write** is defined as an OpLog entry authored by THIS device's signing identity — `entry.signedBy == localSigningPubKey` (spec §10.2.3). Replicated entries from other devices (OrbitDB gossipsub, Nostr DM ingest, any inbound replication) are NOT user-originated and do NOT justify blocking.
- **CLEAR BLOCKED** only after EITHER (spec §10.2.4):
  - (a) a trustlessly-verified **exclusion** proof at `requestId_{A,1}` AND `requestId_{B,1}` (applies only when `localVersion == 0`), OR
  - (b) a successful `recoverLatest()` yielding `V_true > 0` AND the CAR is fetched from IPFS AND the remote bundle is merged into the local OpLog.
  Reachability-only probes, UI "dismiss" actions, and user-preference toggles MUST NOT clear BLOCKED.
- **User override protocol** (optional; spec §10.2.5). For permanent-outage scenarios (regional outage, deprecated testnet, air-gapped recovery), implementations MAY expose an opt-in, per-call, capability-gated override that bypasses BLOCKED. Each use emits `pointer:publish_override_used { version, reason }` telemetry. v1 implementations MAY omit the override entirely.

This preserves user-visible write semantics (the wallet appears to function, local OpLog fills) while guaranteeing that the next on-aggregator commit cannot silently overwrite a remote history.

---

## 7. Publish Flow & Per-Publish Crash Safety

### 7.1 Publish sequence (ASCII)

```
   Wallet                               Aggregator
   ──────                               ──────────
     │ flush requested (new CID)              │
     │                                        │
     │ require publish-blocked flag == OFF    │
     │   (else: reachability probe first)     │
     │                                        │
     │ V_next := localVersion + 1             │
     │ persist (V_next, H(cidBytes)) ────┐    │   ← crash-safety
     │                                   │    │     (C-4, §7.2)
     │ emit pointer:publish_started     ◄┘    │
     │                                        │
     │ derive plainA, plainB (§4.4)           │
     │ (deterministic — padding from padSeed) │
     │                                        │
     │ compute cipherA = XOR(plainA, xorKey(A, V_next))
     │ compute cipherB = XOR(plainB, xorKey(B, V_next))
     │                                        │
     │ build request_A via state-transition-sdk
     │ build request_B via state-transition-sdk
     │                                        │
     │ ─── submitCommitment(request_A) ──────►
     │ ─── submitCommitment(request_B) ──────►   (parallel)
     │ ◄── ack/reject ────────────────────────
     │ ◄── ack/reject ────────────────────────
     │                                        │
     │ if both OK AND both proofs verify →    │
     │     localVersion := V_next             │
     │     emit pointer:publish_completed     │
     │                                        │
     │ if any CONFLICT → reconcile (§8)       │
     │ if any PARTIAL → retry at same V_next  │
     │   (W-3 jitter, §7.3) — deterministic   │
     │                                        │
     │ if retries exhausted →                 │
     │     emit pointer:publish_failed        │
     │     localVersion NOT bumped            │
     │     (CAR is already pinned; safe)      │
```

### 7.2 Crash safety — preventing one-time-pad reuse (reviewer C-4)

**The vulnerability.** The OTP is `xorKey(side, V)`. If two different CIDs `cid1` and `cid2` are XOR-encoded under the same `(V, side)` key, an observer who sees both ciphertexts can compute `cipher1 ⊕ cipher2 = plain1 ⊕ plain2`, which leaks both plaintexts under standard XOR cryptanalysis.

**How the vulnerability arises.** A crash between "compute payload for CID₁" and "submit" followed by a restart where the wallet has advanced OpLog state (now reflecting CID₂) and re-uses `V` would produce a second submission at the same `(V, side)` with a different plaintext. The aggregator rejects the second request (duplicate requestId) — but if the first submission had partially leaked (e.g., side A landed, side B didn't, and the first run's side B was never submitted), a passive observer could be in possession of partial ciphertexts for both plaintexts.

**Mitigation — the `pending_version` marker (narrative; spec §7.1 owns the byte-level discipline).** Before computing payloads for a given `V`, the publisher MUST persist a `(v, cidHash)` record — spec §7.1 calls this the `pending_version` marker — keyed under `PENDING_VERSION_KEY = "profile.pointer.pending_version." + hex(signingPubKey)` (per-wallet scoping). The critical section (read marker → write marker → submit → clear marker) runs under the per-wallet exclusive mutex `MUTEX_KEY = "profile.pointer.publish.lock"` (spec §7.1.1). The marker write MUST be **durable** before any downstream derivation runs — IndexedDB backends await `transaction.oncomplete`; file-based backends issue an explicit `fsync`; storage backends that cannot guarantee durability MUST refuse to initialize the pointer layer (spec §7.1.3). `cidHash` is a full-length `SHA-256(cidBytes)` (32 bytes) — not truncated. On restart:

- If no marker exists, proceed normally.
- If a marker `(v, cidHash_prev)` exists AND the current `SHA-256(cidBytes)` matches `cidHash_prev`, this is a legitimate retry of the *same* CID at the *same* `v` — retry with byte-identical payloads (safe; `requestId`s are deterministic, aggregator treats duplicate as idempotent-accept).
- If a marker exists AND the hashes differ (a crashed publisher is re-entering with a DIFFERENT CID), the publisher MUST NOT reuse `v`. The rollback-safe rule (spec §7.1): treat any `previousEntry.v >= v` as a signal to advance, setting `v = max(v, previousEntry.v) + 1`, persisting a fresh marker at the new `v`, and submitting there. The stale marker is cleared only after the new submission resolves.

The marker is cleared only after a successful publish (both sides committed, `localVersion` persisted) or after the publisher definitively abandons the version (e.g., a non-retryable `REQUEST_ID_MISMATCH`). See spec §7.1.5 and §7.1.6 for exhaustive transition rules.

### 7.3 Retry backoff with jitter (reviewer W-3)

Deterministic payloads allow idempotent retry. Backoff must include jitter to prevent synchronous retry storms across multiple devices:

```
backoff(n) = BASE_MS × 2^n × uniform(0.5, 1.5)
```

Without jitter, multi-device contention degenerates to synchronous retries at `T`, `2T`, `4T`, `...`, re-colliding at every step. The ×0.5..×1.5 jitter range de-synchronizes retries while keeping the base exponential growth. Concrete values live in the spec (`PUBLISH_BACKOFF_BASE_MS`, `PUBLISH_BACKOFF_MAX_MS`, `PUBLISH_RETRY_BUDGET`).

### 7.4 Events emitted (reviewer W-9)

To match existing SDK patterns (`transfer:confirmed`, `nametag:registered`):

| Event | Payload |
|---|---|
| `pointer:publish_started` | `{ version }` |
| `pointer:publish_completed` | `{ version }` |
| `pointer:publish_failed` | `{ version, code }` |
| `pointer:recovered` | `{ version, bundleCount }` |
| `pointer:publish_blocked` | `{ reason }` (aggregator unreachable; write staged) |
| `pointer:publish_override_used` | `{ version, reason }` (emitted only if the user-override path §6.7 / spec §10.2.5 is invoked) |

---

## 8. Conflict Resolution & Concurrency

### 8.1 Scenario: two devices publishing concurrently

Alice has the same wallet on her phone and her laptop. Both are up-to-date at `V = 41`:

- **Laptop flushes first.** Computes `V_next = 42`. Submits `r_A(42)`, `r_B(42)`. Aggregator accepts both. Laptop's local `profile.pointer.version = 42`.
- **Phone flushes, unaware of 42.** Computes `V_next = 42`. Submits `r_A(42)`. Aggregator rejects.

### 8.2 Phone's conflict-handling path

1. Catch the aggregator rejection on `r_A(42)` or `r_B(42)`.
2. Do NOT resubmit at `V = 42` — that request ID is burned forever (append-only SMT).
3. Run the recovery flow (§6). Discovery returns `V_true = 42` (both sides included, verified).
4. Verify the discovered CID is the laptop's bundle CID. The phone may already have it locally via OrbitDB gossipsub; if not, fetch CAR and seed OrbitDB.
5. Merge into the phone's in-memory inventory (standard multi-bundle merge). This produces a new combined CID `C_merged`.
6. Bump to `V_next = 43`. Persist `(43, H(C_merged))`. Submit `r_A(43)`, `r_B(43)`.
7. If 43 is also contested, the loop repeats. Termination is guaranteed under any finite number of concurrent writers, because each loss strictly increases the version floor.

### 8.3 Why this is stronger than last-write-wins

IPNS: both devices can publish `seq=N+1`; resolvers may return either; no synchronous loser signal; silent divergence for hours.

Aggregator: both devices see the same SMT root; the loser's submission is **synchronously rejected** with a verifiable error; the loser **must** reconcile before progressing; there is no silent-divergence window.

### 8.4 Single-device sequential publish

Counter increments locally and every submission succeeds on first try. No extra round trips.

### 8.5 Many-device burst publish

If `k` devices race at `V`, exactly one wins `V+1`; the other `k−1` discover it and race at `V+2`. Worst case: `O(k)` publish attempts for the cohort; each device's discovery cost is `O(log V)` (§10).

---

## 9. Privacy Model

### 9.1 Threat model

Adversaries we protect against:

- **P-obs-ext.** Passive external observer watching aggregator traffic.
- **P-obs-agg.** Aggregator operator with full read access to the SMT and submission log.
- **P-active.** Active attacker who knows the wallet's chain pubkey (from Nostr nametag records, DIRECT:// address, etc.) and wants to locate the Profile pointer.

Out of scope:

- Adversary with the master key (total compromise).
- Submission-timing side channels.
- Network-level deanonymization (Tor/VPN is out of scope).

### 9.2 Pseudonymity per wallet, NOT per commit (reviewer W-2)

**This is a deliberate downgrade from the v1 draft's "unlinkability across versions" claim.** The signing public key `signingPubKey` is stable per wallet — every commit signed with it is linkable to every other commit by the same wallet.

**What the adversary CANNOT do:**

- Derive `signingPubKey` from the wallet's chain pubkey (because the signing key is derived via HKDF from the secret, not the public key).
- Correlate `signingPubKey` with any other identity already known for the wallet — no nametag binding, no DIRECT:// exposure, no L1 address tie.
- Decrypt leaf values without `pointerSecret`.
- Forge a request ID for a specific version without `pointerSecret`.

**What the adversary CAN do (residual risk, documented):**

- **Cluster all pointer commits** by the same `signingPubKey`. Over time, an aggregator operator sees N commits from the same signer and can count them, infer cadence, and correlate with timing windows of other wallet activity (IP correlation, concurrent L3 submissions).
- **Infer version count** by observing probe patterns during discovery.
- **Infer activity cadence** from publish frequency.

**Known leakage, no mitigation in this PR (reviewer N-6).** Aggregator operators, passive network observers, and IP-correlation attackers can cluster all commits by the same `signingPubKey`. This is the cost of keeping one stable signing identity per wallet for this iteration. Documented as `Q-7` in §16.

**Future mitigation (deferred, per user direction):** per-version throwaway signing keys. Each commit uses a freshly-derived secp256k1 signing key, unlinkable across commits. Cost: more derivations, larger authenticator payload, and the aggregator must accept an unbounded set of signing keys per wallet. Deferred to a future revision.

### 9.3 Forward secrecy across versions

Each version uses a fresh `xorKey_{side, V} = SHA-256(xorSeed || [side] || be32(V) || bytes_of("xor"))` (bare SHA-256 via DataHasher; NOT HKDF-Expand). Knowing the plaintext CID at version `V` does not reveal `xorKey(A, V)` or `xorKey(B, V)` without `xorSeed`. Therefore:

- Compromise of one version's plaintext (e.g., via a leaked IPFS CAR) does NOT compromise any other version's ciphertext.
- Compromise of the blinded leaf values does NOT compromise the plaintext without `xorSeed`.

### 9.4 Content concealment

Leaf ciphertexts are XOR of a 32-byte plaintext with a uniformly-random 32-byte one-time pad. Without the pad, each ciphertext byte is uniformly random. The aggregator sees values informationally indistinguishable from fresh random bytes.

### 9.5 Length concealment

The 1-byte length prefix is XOR-blinded by the same pad as the rest of the leaf. External observers cannot read `L`. The 64-byte envelope is constant per publish.

### 9.6 Privacy summary table

| Threat | Mitigated by | Residual risk |
|---|---|---|
| Aggregator reads CID | XOR blinding with `xorKey(side, V)` | None (cryptographic) |
| Aggregator clusters wallet's commits across versions | — | **All pointer commits linkable via stable `signingPubKey`** (W-2) |
| External observer correlates chain pubkey → commits | `pointerSecret` derived from `mk` via HKDF (not from chain pubkey) | None (cryptographic) |
| Observer infers CID length | 64-byte fixed envelope; L-byte XOR-blinded | None |
| Observer infers version count | — | Observable via probe patterns (acknowledged) |
| Observer infers activity cadence | — | Observable (acknowledged) |
| IP / timing correlation of a signing-key-clustered commit stream | — | Observable; linkability deanonymizes the stream (documented, deferred mitigation) |

---

## 10. Logarithmic Version Discovery

### 10.1 Problem

Given the master key, find the largest `V` such that `(r_A(V), r_B(V))` are both included, with nothing at `V+1`. The total published history `V_true` could be anywhere from 0 to millions.

### 10.2 Strategy: exponential probe, then binary search

**Phase 1 — Exponential probe (upper bound).** Starting from `V_init` (seeded from `localVersion` if available — reviewer W-7), probe at doubling intervals until we find a `V_hi` where BOTH sides are excluded. If `V_init` is already excluded, we know `V_true < V_init`.

**Phase 2 — Binary search (exact value).** Bisect over `[V_lo, V_hi]`. Each step probes both sides at `mid` and halves the interval.

**Probe scope — both sides at every probe (reviewer C-3).** The v1 draft's optimization of probing only side A was rejected because it has a correctness gap under partial publish: during a partial-publish window, only one side is included, and a one-side probe can mis-classify. Probing both sides in parallel at each step keeps the round-trip count the same (two parallel calls per step) while closing the gap.

### 10.3 Parallelism = 1 for the binary-search phase (reviewer W-6)

The binary-search phase is serial by construction — each step depends on the result of the previous. Within each step, the two side-A and side-B probes at the same `V` are issued in parallel, but step `k+1` cannot begin until step `k` returns.

**Phase 1 exponential-expansion speculative probing is future work.** The v1 draft's `DISCOVERY_PARALLELISM = 4` constant is removed. A future optimization may speculatively probe `V = V_init, 2·V_init, 4·V_init, ...` in one burst and take the first-excluded result; this is explicitly a v2 optimization and is NOT part of this design.

### 10.4 Complexity

- Phase 1: `O(log V_true)` probes.
- Phase 2: `O(log V_true)` probes.
- Overall: `O(log V_true)` round-trip latencies; each probe ≈ 2 parallel RPCs.

At ~100 ms per RPC and `V_true = 10^6`, ~20 probes ≈ 2 seconds. Seeding from `localVersion` when available reduces the cost under conflict scenarios from `O(log V_true)` to `O(log Δ)` where `Δ = V_true − localVersion`.

### 10.5 Pseudocode

```
fn findLatestVersion(pointerSecret, signingPubKey, trustBase, localVersion):
    // W-7: localVersion was persisted after a successful publish at that V,
    // so bothSidesIncluded(localVersion) is an invariant; binary-searching
    // below it would waste probes. Seed lo from localVersion.
    lo := max(0, localVersion)
    hi := max(DISCOVERY_INITIAL_VERSION, lo + 1)

    // Phase 1: exponential expansion
    while probe(hi):
        lo := hi
        hi := hi * 2

    // Invariant: probe(lo) == true (or lo == 0); probe(hi) == false

    // Phase 2: binary search on (lo, hi)
    while hi - lo > 1:
        mid := (lo + hi) / 2
        if probe(mid):
            lo := mid
        else:
            hi := mid
    return lo   // 0 means "no pointer ever published"
```

Where `probe(V)` (a.k.a. `bothSidesIncluded(V)`) fetches AND verifies inclusion/exclusion proofs for `r_A(V)` and `r_B(V)` in parallel; unverifiable proofs abort. `DISCOVERY_HARD_CEILING` handling is described in spec §8.2.

---

## 11. Consistency Model

A new section reviewers specifically asked for (W-4, N-1), because the system combines two very different models under one recovery contract.

### 11.1 The pointer layer is per-wallet linearizable

- The aggregator SMT is BFT-ordered. Every commit is either before or after every other commit — there is a global total order.
- Every pointer commit for this wallet is written at a requestId derivable only from `pointerSecret`. Two concurrent writers against the same wallet compete for the same requestIds and exactly one wins per version.
- **The pointer layer is therefore the single linearization point for the wallet.** "Latest" is well-defined globally.

### 11.2 Everything downstream stays eventually-consistent

- **CAR bundles** are content-addressed and merged using the existing UXF multi-bundle JOIN rules (PROFILE-ARCHITECTURE §10.4). The merge is commutative and idempotent: any permutation of bundle CIDs produces the same final inventory.
- **OrbitDB OpLog** uses LWW KV semantics under the hood. Replication is gossipsub-driven and eventually consistent across live peers.
- **DMs** and other Nostr-delivered events remain ephemeral and are NOT pointer-anchored.

### 11.3 How these interact

The pointer layer's purpose is to anchor "which CAR bundles should a cold-starting device fetch first." Once the device has fetched them, the downstream CRDT machinery takes over and reconciles any additional state delivered via gossipsub, Nostr, or subsequent pointer versions.

**The pointer is NOT a global ordering over all Profile operations** — it orders only the *anchoring events* (`flushToIpfs` boundaries). Between two flushes, the in-memory Profile can see operations in any order; the next flush linearizes the latest consistent snapshot.

### 11.4 One-line summary

> Per-wallet linearizable under the aggregator's BFT-ordered SMT. CAR contents merged from OpLog remain CRDT (commutative, order-independent). The pointer layer is the **only** linearization point; everything downstream stays eventually-consistent.

---

## 12. Failure Modes & Degraded Operation

### 12.1 Aggregator unreachable during publish

**Preserved invariants.** CAR is pinned; `tokens.bundle.{cid}` is in OrbitDB; other peers can still replicate via gossipsub. Pointer retry is safe (payloads are deterministic — §4.5).

**Handling.** Log failure, emit `pointer:publish_failed`, do not throw from `flushToIpfs`. Next flush recomputes `V_next`. If the failure was "first submission OK, second submission timed out," §7.2 pending-tuple logic ensures the retry uses byte-identical payloads.

### 12.2 Aggregator unreachable during recovery — blocked-publish regime (C-5)

See §6.7. The wallet operates read-only, emits `pointer:publish_blocked`, and refuses to publish until aggregator reachability + verified probe complete. **No silent history erasure.**

### 12.3 Partial publish (A committed, B not)

**Detection.** Probing both sides (§10.2) catches this: `r_A(V)` includes, `r_B(V)` excludes.

**Handling (reviewer C-3 — retry side B at same V):**

1. Re-submit side B at the same `(V, side=B)` with the byte-identical payload from `padSeed`-derived padding (§4.5). The requestId is deterministic in `(pointerSecret, V, side)`.
2. If the aggregator returns REQUEST_ID_EXISTS, treat as idempotent success — the previous submission had landed and the ack was lost.
3. Else, proceed with the retry; bounded attempts with jittered backoff (§7.3).
4. **Do NOT skip to V+1** (rejected optimization).

**Why this is safe:** deterministic payload means re-submission cannot encrypt a different plaintext under the same OTP. §7.2 crash-safety logic further guarantees this is the case even across wallet restarts.

### 12.4 Corrupted CID bytes after decrypt

Causes: derivation drift between publisher/recoverer (e.g., library version skew on HKDF), storage corruption at the aggregator (extremely unlikely), or I-1 violation.

Handling: abort recovery, log diagnostic (partial bytes, expected length, multihash header, codec), fall back to §12.2 empty-state path. Live peer replication will still deliver the OpLog. This is a hard error, not a soft retry — same inputs produce same corruption.

### 12.5 Local version counter lost but pointer exists

Counter is an optimization. First publish after loss computes `V_next = 1`, submission rejected, recovery triggers, counter restored. One extra round trip; no data loss.

### 12.6 Multiple wallets on one device

Each wallet has a distinct `mk`, therefore a distinct `pointerSecret`, therefore distinct request IDs. Local pending tuples and version counter are scoped by wallet (keyed by `signingPubKey` or chain pubkey).

### 12.7 Aggregator signs a false exclusion

Exclusion proofs are verifiable against the SMT root. A lying aggregator must fork the root, which is detectable. Our v1 defense is `InclusionProof.verify` against the TOFU'd trust base (§6.5); v1.5 cross-mirror check and v2 L1 anchoring strengthen this.

### 12.8 Aggregator reset

See §5.5. Explicit `Profile.resetPointerVersion()` migration hook.

---

## 13. Observability

The SDK MUST emit structured telemetry events (reviewer W-8) to allow operators to diagnose pointer-layer behavior. Reference the existing logger pattern in `core/logger.ts`; no specific sink is required.

| Event | Fields | When |
|---|---|---|
| `pointer.publish.attempt` | `{ version, side, attemptLatencyMs, outcome }` | Every aggregator submission |
| `pointer.publish.failed` | `{ version, side, code }` | On rejection or timeout |
| `pointer.discover.probe` | `{ version, included, latencyMs }` | Every probe in the logarithmic search |
| `pointer.recover.outcome` | `{ foundVersion, cidDecodeOk, carFetchMs, outcome }` | End of recovery flow |
| `pointer.conflict.detected` | `{ atVersion, retryAttempt }` | Every conflict-triggered reconciliation |

These complement the UI-facing events in §7.4 (`pointer:publish_started`, etc.). Telemetry events are for operators; UI events are for application integrators.

---

## 14. Alternatives Considered

Expanded per reviewer W-10. Each row's rejection reason is load-bearing; none of these options was deferred — all were eliminated.

| Alternative | Rejection reason |
|---|---|
| **IPNS (current stopgap)** | Eventual consistency, no SSOT, silent divergence on race, public-key correlation. Full analysis §1.1. This is the thing being replaced. |
| **OrbitDB live-peer-only replication (no anchor)** | Requires a live peer at recovery time. Violates G7 (mnemonic-only recovery) whenever no peer is online. |
| **Nametag / token-state-chain as pointer** | A tokenized token's state chain cannot be re-entered from a mnemonic alone — it requires knowing the token's current state hash (or an equivalent anchor) first. Violates G7. This was the user's explicit reason for choosing the two-leaf plain-commitment design. |
| **Centralized pinning service / central index** | Re-introduces the central trust dependency the Profile architecture was built to remove. |
| **Hash CID into one 32-byte leaf** | Recovery impossible — aggregator tells us a hash exists, not the preimage CID. |
| **Truncate CIDv1 to 32 bytes** | Fragile; codec assumptions drift; future CIDs break silently. |
| **Aggregator-extension longer leaves** | Requires an aggregator protocol change. Out of scope and high-cost. |
| **Three-leaf design (96-byte envelope)** | Over-engineered for today's CID shapes (all ≤ 68 bytes). Documented as future work for `>63 byte` CIDs in the spec. |

---

## 15. Migration From the IPNS Stopgap

### 15.1 Files to delete / modify (reviewer N-7)

| File / construct | Action |
|---|---|
| `profile/profile-ipns.ts` | **Deleted.** All exports removed: `publishProfileSnapshot`, `resolveProfileSnapshot`, `deriveProfileIpnsIdentity`, `serializeSnapshot`, `deserializeSnapshot`, `readSequence`, `writeSequence`, `PROFILE_IPNS_HKDF_INFO`. |
| `profile/profile-token-storage-provider.ts` → `publishIpnsSnapshotBestEffort` | **Removed; replaced** by `publishAggregatorPointerBestEffort`. |
| `profile/profile-token-storage-provider.ts` → `recoverFromIpnsSnapshot` | **Removed; replaced** by `recoverFromAggregatorPointer`. |
| `profile/types.ts` → `ipnsSnapshot` config flag | **Renamed** to `pointerAnchor` (same opt-out semantics). |
| Local-storage key `profile.ipns.sequence` | **Renamed** to `profile.pointer.version`. No data migration — the legacy key is orphaned in local storage; wiped on any subsequent `StorageProvider.clear()`. |
| New local-storage keys `profile.pointer.pending_version.{hex(signingPubKey)}`, `profile.pointer.blocked.{hex(signingPubKey)}`, and mutex id `profile.pointer.publish.lock` | **Added** for crash-safety marker, BLOCKED flag, and publish mutex (§7.2, §6.7; spec §7.1, §10.2). |
| `impl/shared/ipfs/ipns-key-derivation.ts` | **Unchanged.** Still used by the legacy non-Profile IPFS IPNS path. Profile switches to four new HKDF info strings (§4.1). |
| `tests/unit/profile/profile-token-storage-provider.test.ts` | **Updated.** Tests referencing `publishIpnsSnapshotBestEffort` / `recoverFromIpnsSnapshot` migrate to the new helpers. |
| `tests/e2e/profile-sync.test.ts` and siblings exercising IPNS isolated-publish | **Updated or removed.** Replace IPNS-publish paths with aggregator-pointer equivalents; drop tests that exercise IPNS-specific semantics no longer reachable. |
| Comments in `profile/factory.ts`, `profile/browser.ts`, `profile/node.ts` referencing legacy IPFS IPNS | **Left in place.** They describe a different historical state (the non-Profile IPFS IPNS path), which remains accurate. |

### 15.2 What stays unchanged

- CAR bundle pin/fetch via IPFS (`pinToIpfs`, `fetchFromIpfs`, gateway config, content-address verification).
- OrbitDB adapter and replication hooks.
- Multi-bundle model and lazy consolidation (`PROFILE-ARCHITECTURE.md` §2.3).
- Token-manifest derivation.
- All `TokenStorageProvider` contract semantics visible to `PaymentsModule`.

### 15.3 Grace period

No external consumers read the Profile IPNS records directly — the only reader is `recoverFromIpnsSnapshot`, replaced in the same PR. **No grace period required.** Wallets that had published an IPNS snapshot before the cutover find their IPNS record orphaned post-upgrade and fall through to "proceed with empty state" until their first post-upgrade flush writes a proper aggregator pointer. Live-peer OpLog replication still delivers data in the interim.

### 15.4 Migration PR scope

1. New module: `profile/profile-aggregator-pointer.ts` — key derivations, XOR encode/decode, publish, recover per this design and the spec.
2. Modifications to `profile/profile-token-storage-provider.ts` per §15.1.
3. Deletion of `profile/profile-ipns.ts` and its unit tests.
4. New unit tests: key-derivation determinism, XOR round-trip, deterministic padding, version discovery (mocked aggregator), conflict handling, partial-publish detection, crash-safety pending-tuple logic.
5. New integration test: two-device conflict race against a real (or testcontainer) aggregator.
6. Updates to `docs/uxf/PROFILE-ARCHITECTURE.md` §7.6 to reference this document.

---

## 16. Open Questions

The canonical open-items list lives in the companion spec at [`PROFILE-AGGREGATOR-POINTER-SPEC.md` §15.1](./PROFILE-AGGREGATOR-POINTER-SPEC.md#151-remaining-open-items). The spec tracks the items as `O-1 .. O-N` with owner and blocker status. This architecture document does not maintain a parallel list — all questions route through spec §15.1 as the single source of truth. Reviewer sign-off gates referenced elsewhere in this doc (§17) are satisfied by resolving the spec's open items.

---

## 17. Approvals Needed

Before the follow-up implementation PR is merged, sign-off is required from:

- **Security auditor.** Verify the threat model (§9), key-derivation argument (§4.1–§4.2), crash-safety reasoning (§7.2), deterministic padding claim (§4.5, W-5), and partial-publish reasoning (§12.3). Specifically resolve Q-1, Q-7, Q-11.
- **Aggregator expert / Unicity architect.** Confirm:
  - `RequestId.createFromImprint` formula matches §4.3 (Q-2).
  - `Authenticator.create(signingService, transactionHash, stateHash)` produces a secp256k1 authenticator accepted by the aggregator (C-1).
  - No reserved request-ID space collision with L4 token request IDs.
  - Feasibility of Q-9 atomic batched submission.
- **SDK maintainer (Profile module owner).** Sign off on `ProfileTokenStorageProvider` integration shape, config-flag rename, `profile/profile-ipns.ts` deletion, crash-safety pending-tuple storage semantics, and the observability event taxonomy (§13).
- **Cross-platform reviewer.** Confirm all required primitives (HKDF-SHA256 via `@noble/hashes`, `state-transition-sdk`'s `SigningService` / `DataHasher` / `RequestId` / `Authenticator` / `InclusionProof.verify` / `RootTrustBase`, XOR) are identical across browser and Node.js bundle outputs. No platform-specific divergence allowed.
- **UX reviewer.** Sign off on the `pointer:*` event surface (§7.4), the blocked-publish regime (§6.7), and the `pointer:publish_blocked` user-visible state.

Once all five approvals are recorded and the spec's Reviewer Sign-Off Checklist is ticked, implementation begins.

---

## Revision History

| Version | Date | Summary |
|---|---|---|
| v1 | (initial draft) | First architecture writeup paired with a co-drafted spec v1. |
| v2 | 2026-04-20 | Reviewer consolidation: unified Q-list, reviewer findings (C-1..C-6, W-1..W-10, N-1..N-10) incorporated. |
| v3 | 2026-04-20 | Byte-for-byte alignment with spec across stateHash preimage (`xorSeed`, not `pointerSecret`), xorKey (bare SHA-256 via DataHasher, not HKDF-Expand), padding (shared across both sides, `"pad"` suffix in info), constant naming (`PUBLISH_BACKOFF_BASE_MS`/`PUBLISH_BACKOFF_MAX_MS` — no `RETRY_` infix on timings), discovery init seeded from `localVersion`, BLOCKED state machine hardened (persistent flag, user-originated-write criterion, override protocol), `pending_version` marker discipline cross-referenced to spec §7.1, observability override event added. Spec is canonical; arch narrates. Open Questions routed to spec §15.1 as single source of truth. |
