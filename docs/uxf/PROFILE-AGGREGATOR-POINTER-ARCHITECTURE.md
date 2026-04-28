# UXF Profile — Aggregator-Anchored OpLog Pointer

**Status:** Draft v3.4 — embedded `RootTrustBase` deployment model (multi-mirror TOFU + mirror-list infrastructure deferred to v2; trust base shared with L4 / `PaymentsModule`; single-aggregator + single-IPFS topology)
**Date:** 2026-04-21
**Supersedes:** `profile/profile-ipns.ts` (IPNS snapshot stopgap)
**Companion spec:** [`docs/uxf/PROFILE-AGGREGATOR-POINTER-SPEC.md`](./PROFILE-AGGREGATOR-POINTER-SPEC.md) — v3.4, canonical owner of byte-level formulas, algorithms, and error codes. The spec is authoritative; this document narrates.
**Related:**
- [`docs/uxf/PROFILE-ARCHITECTURE.md`](./PROFILE-ARCHITECTURE.md) §2.3 (multi-bundle model), §7.6 (migration), §2.1 (global-keys model)
- [`docs/uxf/UXF-TRANSFER-PROTOCOL.md`](./UXF-TRANSFER-PROTOCOL.md) — the inter-wallet transfer protocol that consumes the pointer mechanism via §12.3.1 **profile-pointer rescan** (default 30s; queries the aggregator for the next pointer position to detect sibling-instance updates) and §12.3.2 **per-token spent-state rescan** (default 5 min/token, concurrency 4; detects off-record spends). The pointer architecture here is the LAYER consumed; UXF-TRANSFER-PROTOCOL is the consumer.
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
| Proof verification | Every inclusion or exclusion proof is verified via `InclusionProof.verify(trustBase, requestId)`. Unverifiable proofs abort recovery with `AGGREGATOR_POINTER_UNTRUSTED_PROOF`. |

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
                                             paddingBytes_v = HKDF-Expand(padSeed,
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
paddingBytes_v   = HKDF-Expand(padSeed, info = be32(V) || bytes_of("pad"), L = padLength)
```

The single `paddingBytes_v` buffer occupies plaintext offsets `[1 + cidLen .. 64)` of the 64-byte envelope (spanning side A and side B, see §4.4 layout); there is no per-side padding.

Benefits:

- **Crash-retry is byte-identical** → idempotent aggregator re-submission (W-5, C-4).
- **No CSPRNG dependency** at publish time.
- Privacy-neutral: `padSeed` is secret-derived; the ciphertext is still uniformly-random-looking to any observer without `pointerSecret`.

Under the random-oracle model, `paddingBytes_v` is independent of `xorKey_{side, V}` and `stateHashDigest_{side, V}` because padding derives from `padSeed` under a `"pad"` suffix, while the `xorKey` and `stateHashDigest` are bare SHA-256 over `xorSeed`-prefixed preimages under `"xor"` and `"state"` suffixes respectively (see §4.3). Domain separation via distinct seeds and distinct suffixes makes the three outputs computationally independent.

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
5. **Fetch and verify.** Request inclusion proofs at `(r_A(V), r_B(V))` and exclusion proofs at `(r_A(V+1), r_B(V+1))`. Verify each via `InclusionProof.verify(trustBase, requestId)`. If any verification fails, abort with `AGGREGATOR_POINTER_UNTRUSTED_PROOF`.
6. **Decrypt.** Compute `xorKey(A, V)` and `xorKey(B, V)`. XOR each leaf's ciphertext digest to recover the plaintext halves.
7. **Reconstruct the CID.** Read `L = plainA[0]`, assemble `cid = (plainA[1..32] ‖ plainB[0..])[0..L]`, attempt CID decode (codec, multihash check). On failure, emit `AGGREGATOR_POINTER_CORRUPT` and abort — see §12.4.
8. **Fetch the CAR.** Via existing `fetchFromIpfs(cid)`. If unavailable on all gateways, log and proceed with empty state (same fallback as IPNS today).
9. **Seed OrbitDB.** Insert `tokens.bundle.{cid}` with `status: 'active'`. Idempotent under OrbitDB LWW KV.
10. **Hand off.** `PaymentsModule.load()` runs its normal multi-bundle merge.

### 6.4 Pseudocode (minimal)

The narrative below mirrors the three-phase discovery algorithm in spec §8.2. It deliberately does NOT require a verified exclusion at `V+1` — that v3.2 invariant was superseded by valid-version continuity (§9.8 / spec §10.3), which accepts corrupt-included residue above the latest valid version rather than aborting on it.

```
fn recover(mk, trustBase):
    pointerSecret, signingSeed, xorSeed, padSeed := deriveKeys(mk)
    signingService := SigningService.createFromSecret(signingSeed)
    signingPubKey  := signingService.publicKey

    // 1. Seed lo from localVersion (§10.5 / spec §8.2).
    lo := max(0, localVersion)
    hi := max(DISCOVERY_INITIAL_VERSION, lo + 1)

    // 2. Phase 1 — exponential expansion using inclusion-only probe().
    //    probe(v) returns true iff BOTH SIDE_A AND SIDE_B have verified
    //    inclusion proofs at v (spec §8.1 — probe-predicate is AND over
    //    sides; the OR variant discussed in spec §8.1 covers a narrow
    //    partial-publish window and is not used for the global
    //    exponential step). Doubling continues until probe(hi) is false
    //    or DISCOVERY_HARD_CEILING is reached.
    while probe(hi):
        lo := hi
        hi := hi * 2

    // 3. Phase 2 — binary search on (lo, hi) to converge on V_included:
    //    the latest version with verified inclusion on both sides.
    V_included := binarySearch(lo, hi, probe)
    if V_included == 0:
        return EmptyProfile

    // 4. Phase 3 — walk-back through SEMANTICALLY_INVALID versions.
    //    A version is SEMANTICALLY_INVALID if its XOR-decoded payload is
    //    malformed, its CID does not parse, or its CAR fails to
    //    deserialize — i.e., it is corrupt in a deterministic,
    //    locally-verifiable way (spec §10.3). Walk at most
    //    DISCOVERY_CORRUPT_WALKBACK steps backward.
    //
    //    TRANSIENT_UNAVAILABLE versions (all gateways returning errors
    //    after the per-fetch retry budget is exhausted) do NOT trigger
    //    walk-back: they escalate to AGGREGATOR_POINTER_CAR_UNAVAILABLE
    //    (spec §8.2 Phase 3 split + §10.7) and the caller must either
    //    wait for gateway recovery or invoke acceptCarLoss() (§15.2.1).
    V_valid := walkBack(V_included, DISCOVERY_CORRUPT_WALKBACK)

    // 5. Recover payload at V_valid, verify four proofs, decrypt, fetch
    //    CAR (with MAX_CAR_BYTES and progress-rate enforcement — spec
    //    §8.5), seed OrbitDB, emit pointer:recovered { version: V_valid }.
    return recoverAt(V_valid, pointerSecret, signingPubKey, xorSeed, trustBase)
```

The difference from the v3.2 text: the old §6.4 required verified *exclusion* at `V+1` as a termination condition. That requirement is removed. Discovery now returns the latest VALID version; the aggregator may hold corrupt-but-included entries at higher version numbers and discovery skips them. See §9.8 for the narrative of why and spec §10.3 / §8.2 Phase 3 for the canonical rule.

### 6.5 Trust base — embedded anchor model (v3.4)

Every proof returned by the aggregator is verified locally via `InclusionProof.verify(trustBase, requestId)` against a `RootTrustBase`. In v1 Sphere, that trust base is shipped inside the SDK bundle and shared with L4.

**Embedded `RootTrustBase` (v3.4 — the authoritative rule).** The SDK ships `RootTrustBase` statically under `assets/trustbase/<network>.ts` and loads it via `impl/shared/trustbase-loader.ts`. This is the SAME instance L4 / `PaymentsModule` already consumes through `OracleProvider` in the current Sphere deployment. The pointer layer MUST consume that same instance (spec §8.4, §8.4.2). Fresh devices with only a mnemonic load the bundled trust base at init time — there is no runtime fetch of trust-base bytes, therefore no "fresh boot" TOFU dilemma.

- **Single canonical source of truth.** L4 already decided it — the pointer layer adopts the same decision. Asymmetric trust surfaces (pointer layer trusting a different `RootTrustBase` from L4) are explicitly prohibited.
- **Rotation.** `RootTrustBase` rotation is driven by SDK releases: when BFT validators rotate epochs, Sphere ships a new build whose bundled trust base carries the new epoch. Runtime detection is via `NOT_AUTHENTICATED` + epoch mismatch surfacing as `AGGREGATOR_POINTER_TRUST_BASE_STALE` (spec §8.4.1); the wallet does NOT attempt a runtime refetch.
- **Residual risk = bundle supply chain.** The attacker's only path to a forged trust base is compromising the SDK release itself. This is a known v1 trade-off, closed in v2 by L1-alpha-anchored trust-base fingerprinting (§12).

**Multi-mirror TOFU deferred to v2 (retained as narrative for reviewers).** Earlier revisions required a mandatory multi-mirror TOFU cross-check (≥ 2 independently-addressed aggregator mirrors returning byte-identical trust bases) on first-boot recovery. v3.4 deletes that rule because the deployed Sphere topology is a single aggregator (`aggregator.unicity.network` or `goggregator-test.unicity.network`) and a single IPFS node (`ipfs.unicity.network`), and the trust base is already bundled rather than runtime-fetched. Multi-mirror TOFU re-emerges as a meaningful defense only alongside v2 runtime-fetched trust-base infrastructure — see §12 and spec §11.13 item (i). The v2 plan pairs runtime fetch with L1-alpha anchoring and re-introduces multi-mirror cross-check on top of that foundation.

### 6.6 Fresh-wallet / no-pointer-yet case

A wallet that has never published (new mnemonic, freshly imported, no activity) will receive a verified exclusion proof at `r_A(1)` and `r_B(1)` from the aggregator. Recovery reports `V = 0`, no CAR is fetched, OrbitDB remains empty, and the wallet is ready to publish its first version.

### 6.7 Aggregator-unreachable recovery path (reviewer C-5)

**Previous behavior (rejected):** log a warning and proceed with empty state, letting the next publish act as if `V = 1` were the first version. This is unsafe — if the aggregator was merely unreachable, the next publish overwrites a legitimate remote history at `V = 1`.

**Mandated behavior (narrative; spec §10.2 owns the byte-level state machine):**

The wallet maintains a per-wallet **persistent** BLOCKED flag — the canonical storage key is `BLOCKED_FLAG_KEY = "profile.pointer.blocked." + hex(signingPubKey)` (spec §10.2.1). The flag survives process restarts. An absent key is equivalent to `false`. When BLOCKED is set, `publishAggregatorPointerBestEffort` refuses to run and the publish attempt surfaces `AGGREGATOR_POINTER_UNREACHABLE_RECOVERY_BLOCKED`. The state flips as follows:

- **SET BLOCKED** when ALL of these hold (spec §10.2.2 enumerates four explicit conditions; arch presents them in the same order — see spec for the normative list):
  - (i) `initialize()` — or any subsequent reconciliation pass — has actually attempted to reach the aggregator for recovery (the precondition that a probe was even issued);
  - (ii) that attempt hit a **categorical** transport error: a true network timeout, DNS failure, TLS handshake failure, or socket-refused. **Note (v3.3 clarification):** `NOT_AUTHENTICATED` from `InclusionProof.verify` is NOT categorical — it is a trust-base-stale signal that triggers trust-base refresh (spec §8.4.1) followed by a single retry; only if the retry remains categorical does it count toward condition (ii). Similarly, transient 5xx responses MUST NOT count on first occurrence.
  - (iii) the local OpLog contains at least one **user-originated** write (see next bullet, and spec §10.2.3 for the full `originated` tag definition and migration notes for PaymentsModule, AccountingModule, SwapModule, CommunicationsModule, and profile-token-storage-provider);
  - (iv) at least one retry with exponential backoff has already been attempted AND failed (to avoid flapping on single transient failures).

  Re-SET on the same category of error during a subsequent publish. The v3.2-added fresh-install cold-start rule is preserved:
  - (v) Fresh-install cold-start recovery produced a `SEMANTICALLY_INVALID` payload at the latest-included version that cannot be walked back because `localVersion == 0` (spec §10.2.6 — retained as a safety net, now narrow in scope because discovery walks back past such residue when any lower-version valid version exists).
- **User-originated write.** An OpLog entry is *user-originated* iff its `originated` metadata tag equals `'user'` (spec §10.2.3). Writers MUST stamp each entry with one of:
  - `'user'` — deliberate user action (token send/receive, nametag register, DM send, invoice, swap)
  - `'system'` — SDK-internal bookkeeping (session receipt, last-opened timestamp)
  - `'replicated'` — arrived via OrbitDB gossipsub or Nostr ingest

  Only `'user'` entries satisfy SET condition (iii) of §6.7. Recipients semantically re-validate the tag — entries of known-user-action types MUST have `'user'` regardless of the stamped value (spec §10.2.3 closes the tag-forgery bypass via `SECURITY_ORIGIN_MISMATCH`). This replaces the r3 `signedBy == localSigningPubKey` heuristic, which was ambiguous in both directions (a signed session-receipt spuriously satisfied it; an unsigned "touch" write slipped past).
- **CLEAR BLOCKED** only after EITHER (spec §10.2.4):
  - (a) a trustlessly-verified **exclusion** proof at `requestId_{A,1}` AND `requestId_{B,1}` (applies only when `localVersion == 0`), OR
  - (b) a successful `recoverLatest()` yielding `V_true > 0` AND the CAR is fetched from IPFS AND the remote bundle is merged into the local OpLog.
  Reachability-only probes, UI "dismiss" actions, and user-preference toggles MUST NOT clear BLOCKED.
- **User override protocol** (optional; spec §10.2.5). For permanent-outage scenarios (regional outage, deprecated testnet, air-gapped recovery), implementations MAY expose an opt-in, per-call, capability-gated override that bypasses BLOCKED. Each use emits `pointer:publish_override_used { version, reason }` telemetry. v1 implementations MAY omit the override entirely.

This preserves user-visible write semantics (the wallet appears to function, local OpLog fills) while guaranteeing that the next on-aggregator commit cannot silently overwrite a remote history.

**Fresh-install corrupt-payload at cold start (v3.2).** The r3.1 "BLOCKED on corrupt-payload when `localVersion == 0`" rule is **removed**. Corrupt versions are now treated as semantically ignored residue in the aggregator SMT; discovery walks back past them to the latest valid version rather than blocking publish. The MITM concern r3.1 cited is absorbed into the broader valid-version-continuity model (§9.8) together with the shared embedded `RootTrustBase` (§6.5), and the corrupt-streak bail-out (spec §10.8). See §9.8 and spec §10.3 for the v3.2 rule.

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

### 7.3 Publish outcome matrix and retry (reviewer W-3; v3.3 expansion)

#### 7.3.1 Outcome matrix (narrative)

Spec §7.3 owns the normative outcome matrix — one row per observable combination of side-A and side-B submission results. The v3.3 pass expanded the rows to cover HTTP status codes, JSON-RPC protocol errors, malformed responses, and the `REJECTED` burn-version rule. At the architectural level, every publish attempt resolves into one of these categories:

- **SUCCESS / SUCCESS.** Both sides committed cleanly. Persist `localVersion = V_next`, clear the `pending_version` marker, emit `pointer:publish_completed`. Happy path.
- **REQUEST_ID_EXISTS on both sides, marker matches.** Our own prior attempt crashed between aggregator-accept and `localVersion` persistence. Treated as **idempotent replay success**: persist `localVersion = V_next`, clear the marker, emit `pointer:publish_completed`. §9 reconciliation is NOT invoked.
- **REQUEST_ID_EXISTS on both sides, marker missing or `cidHash` mismatch.** Genuine conflict — another device published `V_next` first. Invoke §9 reconciliation; retry at `max(V_valid, V_included) + 1` (see §9.2 below).
- **AUTHENTICATOR_VERIFICATION_FAILED or REQUEST_ID_MISMATCH on either side (v3.3 change).** The authenticator the aggregator received was malformed relative to the request ID — the submission is unambiguously our own doing but is unrecoverable at `V_next`. Arch-level rule: **burn `V_next` by persisting `localVersion = V_next`** before clearing the marker, then raise `AGGREGATOR_POINTER_REJECTED`. This prevents any subsequent attempt from re-deriving the same `(xorKey, V, side)` OTP against a different plaintext (see spec §7.3 row + §11 bullet 2 on OTP discipline). v3.2 cleared the marker without advancing `localVersion`, which permitted OTP reuse on retry — a token-loss path.
- **Transient HTTP errors (5xx, 429, JSON-RPC `-32006`, 503 with `Retry-After`).** Retry with backoff. If `Retry-After` is present, honor the indicated delay (and do NOT charge it to `PUBLISH_RETRY_BUDGET`). Otherwise apply jittered exponential backoff up to `PUBLISH_RETRY_BUDGET`.
- **Permanent HTTP errors (4xx other than 429).** Non-retryable. Raise `AGGREGATOR_POINTER_AGGREGATOR_REJECTED`; do not retry; surface to the caller. Malformed JSON and unknown enum values land in this bucket (spec W3).
- **Network errors (true transport failure — timeout, DNS, TLS).** Categorical per §10.2.2 condition (ii). A single transient failure retries; sustained categorical failure across the retry budget is the signal that promotes the wallet into BLOCKED (see §6.7).

#### 7.3.2 Retry backoff with jitter

Deterministic payloads allow idempotent retry. Backoff must include jitter to prevent synchronous retry storms across multiple devices:

```
backoff(n) = BASE_MS × 2^n × uniform(0.5, 1.5)
```

Without jitter, multi-device contention degenerates to synchronous retries at `T`, `2T`, `4T`, `...`, re-colliding at every step. The ×0.5..×1.5 jitter range de-synchronizes retries while keeping the base exponential growth. Concrete values live in the spec (`PUBLISH_BACKOFF_BASE_MS`, `PUBLISH_BACKOFF_MAX_MS`, `PUBLISH_RETRY_BUDGET`). `Retry-After`-honored waits do NOT consume retry budget.

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
3. Run the recovery flow (§6). Discovery returns BOTH `V_valid` (latest valid version usable for payload recovery) AND `V_included` (latest-included version, which MAY be corrupt residue above `V_valid`). See spec §8.2 and §9.2.
4. Verify the discovered CID at `V_valid` is the laptop's bundle CID. The phone may already have it locally via OrbitDB gossipsub; if not, fetch CAR and seed OrbitDB.
5. Merge into the phone's in-memory inventory (standard multi-bundle merge). This produces a new combined CID `C_merged`.
6. Bump to `V_next = max(V_valid, V_included) + 1` (v3.3 — spec §9.2). Persist `(V_next, H(C_merged))`. Submit `r_A(V_next)`, `r_B(V_next)`. **Why `max` instead of just `V_valid + 1`:** corrupt-but-included residue between `V_valid` and `V_included` burns those request IDs; targeting `V_valid + 1` would immediately collide with them and deadlock the publisher forever. The v3.2 text said "bump to `V_true + 1`" assuming `V_true = V_included = V_valid`; v3.3 disambiguates for the case where corrupt residue exists.
7. If `V_next` is also contested, the loop repeats. Termination is guaranteed under any finite number of concurrent writers, because each loss strictly increases the version floor.

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
| Probe-sequence fingerprint across sessions (§9.7) | — | Observable per-session; cross-session clustering even when IP rotates (documented, v2 mitigations deferred) |

### 9.7 Probe-sequence fingerprint (v3.1 disclosure)

The discovery algorithm's probe sequence (Phase 1 exponential expansion, Phase 2 binary search — §10) is **deterministic in `(V_true, localVersion)`**. An aggregator operator who logs per-session probe sequences across many sessions can correlate sessions originating from the same wallet by recognizing the characteristic `(lo, hi, mid_1, mid_2, ...)` pattern that falls out of the seeded binary search, **even when the wallet rotates IPs between sessions**. This is a strictly stronger clustering signal than `signingPubKey` alone: `signingPubKey` is sent in every authenticator at publish time, but probe-GET traffic during pure recovery need not include it — yet the probe pattern itself still betrays the wallet.

Mitigations considered but deferred to v2 future work:

- **Randomized Phase 1 exponential base** (e.g., each session draws a fresh factor in `[1.5, 2.5]` from a session-local PRNG so the doubling schedule varies).
- **Decoy probes** — each real probe is accompanied by `k` fake probes at unrelated request IDs drawn from the same `pointerSecret`-derived family, making the operator's job `O(C(real+fake, real))` harder.
- **Batching across sessions to reuse cached `V_true`** — avoid repeating the search when `localVersion` is already known.

None of these are part of v1; all are explicitly called out as probe-sequence hardening to ship later. See spec §11.10.

### 9.8 Valid-version continuity (v3.2)

The pointer layer treats discovery as a search for the latest VALID version, not simply the latest-included version. A "valid" version has: verified inclusion proofs for both sides, a well-formed XOR-decoded payload, a parseable sha2-256 CID, a fetchable CAR within `MAX_CAR_BYTES` / `MAX_CAR_FETCH_MS`, and a deserializable UXF package. Any version failing these checks is "corrupt" — it may exist in the aggregator SMT (from prior buggy clients, aborted publishes, or gateway-level CAR corruption), but it is SEMANTICALLY IGNORED.

Discovery finds the latest INCLUDED version via exponential+binary search (§10.2), then walks backward skipping up to `DISCOVERY_CORRUPT_WALKBACK` corrupt versions (spec §8.2 Phase 3). The first valid version found is returned. New valid publishes at `latest_valid_V + 1` are legitimate — a publisher does NOT need to resolve or clean up intermediate corrupt versions; they are permanent SMT residue that everyone skips.

Critically, each Sphere client implements this independently; no coordination is needed. Two clients looking at the same wallet pointer stream with corrupt versions at `v = 7` and `v = 8` will both skip to `v = 9` (or earlier) as the latest valid and continue from there. There is no consensus step — the rule is a pure client-side skip policy.

If Phase 3 walk-back exhausts `DISCOVERY_CORRUPT_WALKBACK` consecutive corrupt versions (default `64`), recovery bails with `AGGREGATOR_POINTER_CORRUPT_STREAK`. The operator-facing `acceptCorruptStreak(walkbackLimit)` API (§15.2.1) extends the walkback for a single attempt. See spec §10.8 for the normative rule.

This rule REPLACES the r3.1 §10.2.6 "fresh-install corrupt-payload → BLOCKED" behavior, which was both narrower (it only fired when `localVersion == 0`) and harder to recover from (each corrupt residue version required a distinct operator override). Valid-version-continuity generalizes to any position in the version stream and restores self-healing publish semantics.

### 9.9 v3.3 security-and-privacy additions

Revision 3.3 closes four surface-area issues in the privacy/security argument without changing the underlying cryptographic primitives. These are NEW concerns to the narrative; each is fully specified in the companion spec.

**Probe predicate changed to OR (narrow usage).** The inclusion predicate used inside discovery remains AND-over-sides for the global Phase 1 / Phase 2 search (§10.5). Spec §8.1 also defines an OR-over-sides predicate used by a narrow partial-publish retry window, so a single-side landed commit does not non-monotonically "disappear" from later probe traces. From the arch-level privacy angle: this does not change the §9.7 fingerprint disclosure, because the probe sequence is still deterministic in `(V_true, localVersion, corrupt-version set)`. No new observability surface is introduced.

**Trust base rotation (spec §8.4.1, simplified v3.4).** The bundled `RootTrustBase` ages out. When the aggregator rotates its BFT validator set, the SDK-bundled trust base no longer verifies fresh proofs (`NOT_AUTHENTICATED`). The arch-level rule: treat `NOT_AUTHENTICATED` plus an epoch mismatch as a rotation signal (not as BLOCKED-trigger material); surface `AGGREGATOR_POINTER_TRUST_BASE_STALE` and require an SDK update whose bundled trust base carries the new epoch. There is no runtime-refresh flow in v1 — rotation remediation is release-shipped. This closes a "trust-base age-out bricks otherwise-live wallets" failure mode, traded for SDK-release cadence as the rotation bottleneck.

**Shared trust base vs L4 (spec §8.4.2 — canonical rule as of v3.4).** The `RootTrustBase` the pointer layer consumes MUST be the same instance the outer SDK uses for L4 token verification — specifically, consumed via `OracleProvider.getRootTrustBase()` (or the equivalent SDK hook). Implementations MUST NOT instantiate a separate trust base for the pointer layer. Asymmetric trust bases create an attacker path where one surface is forgeable and the other is not, which is enough to compromise wallet state regardless of which layer is "stronger." Shared trust collapses both attack surfaces into one — and is trivially satisfied in v3.4 because the bundled trust base already flows through L4's `OracleProvider` today.

**TLS simplified to standard WebPKI (spec §8.4.3).** Aggregator HTTPS uses TLS ≥ 1.3 with standard WebPKI validation. Because `RootTrustBase` is embedded in the SDK bundle (not fetched over the network), an on-path TLS MITM cannot forge `InclusionProof.verify` outcomes — the cryptographic anchor lives in the SDK, independent of the TLS session. Runtime cert pinning, CA diversity, IP diversity, and bundled mirror-list integrity — all retired in v3.4 — applied only when the trust base was fetched over the wire, and will re-emerge in v2 alongside runtime-fetched trust-base + L1-alpha-anchored fingerprinting (§12).

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

### 10.6 Known trade-offs deferred to v2

Known trade-offs deferred to v2 — see spec §11.13 for the canonical list. These are decided-and-deferred (not open questions):

- **Bundled trust base as centralized trust root (v3.4).** v1 ships `RootTrustBase` inside the SDK bundle (§6.5). Supply-chain compromise of an SDK release beats every downstream wallet at once — L4 and the pointer layer are both anchored to the same bundle.
- **Runtime-fetched trust base with L1-alpha-anchored fingerprint (v2 work).** Replace the SDK-bundled trust base with a runtime-fetched one whose fingerprint is committed to the ALPHA (L1) chain (e.g., a coinbase OP_RETURN or governance-signed record). Wallets then verify at init time that the trust base delivered by the aggregator matches the latest L1 attestation. This closes the supply-chain gap of the bundled-trust-base model AND unblocks multi-mirror TOFU (≥ 2 independently-addressed aggregator mirrors returning byte-identical trust bases) as a meaningful defense — together with cert pinning, CA diversity, and mirror-list integrity. All of these become applicable only once runtime fetch is in scope, and are consequently paired in the v2 roadmap. See spec §11.13 item (i).
- **Backup/restore `MARKER_CORRUPT` UX.** A `pending_version` marker restored from a backup taken mid-publish surfaces as `AGGREGATOR_POINTER_MARKER_CORRUPT`, which today requires the operator escape hatch (`clearPendingMarker()`) — not ideal for end-user recovery flows.
- **Denylist governance.** The well-known-test-key denylist (spec §11.12) is client-bundled; updates require a client release cycle, and there is no signed revocation channel.

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

### 12.9 CAR unavailable after successful recovery (v3.1, tightened v3.3)

When discovery yields a verified pointer at `V > 0` and the inclusion proofs at `(r_A(V), r_B(V))` pass `InclusionProof.verify`, but `fetchFromIpfs(cid)` returns 404 / unreachable / times out on *every* configured gateway, the wallet enters an `AGGREGATOR_POINTER_CAR_UNAVAILABLE` state. This is distinct from §12.2 BLOCKED: here the aggregator IS reachable and `V_true` is trustlessly known; only the CAR bytes are missing.

Behavior (narrative; spec §10.7 owns the normative rule):

- Raise `AGGREGATOR_POINTER_CAR_UNAVAILABLE` to the caller.
- Do NOT advance `localVersion` past `V_true`.
- Refuse subsequent `publish()` calls until EITHER the CAR becomes fetchable on retry OR the caller invokes the explicit operator override `acceptCarLoss(version)` under the v3.3 hardened preconditions.
- Emit `pointer:recover_car_unavailable { version, cid }` for UI surfacing; emit `pointer:car_loss_pending { version, retriesRemaining }` while persistent-retry is still active; emit `pointer:car_loss_aborted_peer_found { version }` when peer discovery aborts the override path; emit `pointer:car_loss_accepted { version }` when the override is finally invoked.

**Phase 3 split (v3.3 — spec §8.2).** The §8.2 walk-back distinguishes two failure categories:

- `SEMANTICALLY_INVALID` — the payload is structurally bad (XOR-decode fails, CID does not parse, CAR fails to deserialize). **Walk back past it** — this is ordinary residue from prior buggy clients and cannot be fixed by waiting.
- `TRANSIENT_UNAVAILABLE` — all gateways returned errors after the per-fetch retry budget (`MAX_CAR_FETCH_RETRY`) was exhausted. **Do NOT walk back.** Raise `AGGREGATOR_POINTER_CAR_UNAVAILABLE` and enter the §12.9 state. Walking back would silently discard a valid bundle whose gateways happened to be down at fetch time — a token-loss path.

**acceptCarLoss hardening (v3.3 — spec §10.7.1).** The v3.1 single-call override is replaced with a multi-check procedure:

1. Capability gate: `allowOperatorOverrides` must be set at SDK init time.
2. Persistent multi-gateway retry: the wallet must have performed `CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS` retries distributed over `CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS` (24 h) across the full gateway set. The persistence clock survives restarts.
3. Peer availability check: before the override proceeds, the wallet polls OrbitDB gossipsub / Nostr for `POINTER_PEER_DISCOVERY_MS` (10 min) looking for a peer that holds the unfetchable bundle. A positive discovery aborts the override (`pointer:car_loss_aborted_peer_found`) — the peer's replication will heal the missing CAR without data loss.
4. Republish-before-advance: the wallet MUST republish the current valid local state (a freshly-flushed CAR) as a new pointer version BEFORE the override advances `localVersion` past the lost one. This prevents the case where `acceptCarLoss` succeeds, the local state diverges from aggregator state, and the next crash loses the divergence.

The arch-level narrative is: `acceptCarLoss` is not a simple setter. See spec §10.7.1 for the full precondition list.

Also subject to v3.1 CAR size/fetch caps and associated error codes (spec §3 / §10.7): excessively large CARs or fetches exceeding the progress-rate or wall-clock timeouts abort locally rather than blocking progress indefinitely. v3.3 tightens these caps to progress-rate (`MAX_CAR_FETCH_STALL_MS`) and total-duration (`MAX_CAR_FETCH_TOTAL_MS`) variants, replacing the single `MAX_CAR_FETCH_MS` (see spec §8.5 / §3 `MAX_CAR_FETCH_*` constants).

### 12.10 Async-await convention in arch pseudocode (v3.1)

All SDK calls shown in arch pseudocode (`.digest()`, `SigningService.createFromSecret`, `RequestId.createFromImprint`, `Authenticator.create`, `aggregatorClient.submitCommitment`, `InclusionProof.verify`) are asynchronous; the `await` keyword is elided for readability. See spec §4 footnote for the normative convention.

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

v3.1 hardening adds the following UI-facing events (normative taxonomy in spec §13):

| Event | Fields | When |
|---|---|---|
| `pointer:recover_car_unavailable` | `{ version, cid }` | Discovery succeeded with a trustlessly-verified pointer at `V > 0`, but every IPFS gateway failed to return the CAR (§12.9; spec §10.7) |
| `pointer:car_loss_accepted` | `{ version }` | The caller invoked `acceptCarLoss(version)` to opt into data loss and unblock publish (§12.9; spec §13 API surface) |
| `pointer:marker_cleared` | `{ previousMarker: { v, cidHash }, reason: 'user_requested' \| 'auto_compacted' }` | An explicit `clearPendingMarker()` removed a stuck `pending_version` marker — operator escape hatch for corrupt or orphan markers (spec §7.1 / §13 API surface) |
| `pointer:discover_corrupt_skipped` | `{ version }` | Emitted per skipped corrupt version during §9.8 / spec §8.2 Phase 3 walk-back (v3.2) |
| `pointer:corrupt_streak_override_used` | `{ walkbackLimit }` | Emitted when the operator-gated `acceptCorruptStreak()` override (§15.2.1, spec §13) is invoked to extend the walk-back beyond `DISCOVERY_CORRUPT_WALKBACK` (v3.2) |

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

### 15.2.1 New SDK surface (v3.1/v3.2/v3.3 hardening)

Implementations of the pointer layer gain new API methods on the pointer module, driven by v3.1 failure-mode handling (§12.9, §6.7), v3.2 valid-version-continuity (§9.8), v3.3 CAR-loss hardening (§12.9), and operator escape hatches. Spec §13 is the normative owner of all signatures; the arch document reproduces them verbatim:

- `acceptCarLoss(version: number): Promise<Result<void>>` — caller opt-in that unblocks publish after §12.9 `AGGREGATOR_POINTER_CAR_UNAVAILABLE`; emits `pointer:car_loss_accepted` telemetry. **v3.3: this is NOT a simple setter.** The method has complex preconditions: capability gate (`allowOperatorOverrides`), persistent multi-gateway retry over `CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS` (24 h), peer-availability check via OrbitDB/Nostr for `POINTER_PEER_DISCOVERY_MS` (10 min), and republish of the current local state BEFORE advancing `localVersion` past the lost version. See spec §10.7.1 for the full precondition list.
- `clearPendingMarker(): Promise<Result<void>>` — operator escape hatch that removes a stuck `pending_version` marker (e.g., corrupted, orphan after a non-recoverable crash); emits `pointer:marker_cleared` telemetry. **v3.3: gated on `allowOperatorOverrides` capability AND human confirmation, and SETs BLOCKED after clearing the marker** — the wallet must re-reconcile against the aggregator before it can trust that its version counter is accurate.
- `getProbeFingerprint(): string` — optional diagnostic returning a short stable hash of the last discovery probe sequence, intended for operator analysis of the §9.7 fingerprint disclosure. Returns empty string if no probe has run since init. Not secret; MAY be logged.
- `acceptCorruptStreak(walkbackLimit?: number): Promise<Result<{ walkbackUsed: number }>>` — v3.2 operator escape hatch that extends the §9.8 corrupt-version walk-back beyond `DISCOVERY_CORRUPT_WALKBACK` for a single attempt, used when a pathological OpLog of consecutive corrupt residue (long tail of prior-client bugs or adversarial grinding) has exhausted the default cap with `AGGREGATOR_POINTER_CORRUPT_STREAK`. **v3.3: walk-back is bounded below by `localVersion`** — it will never walk past a previously-confirmed valid version of our own making, and raises `AGGREGATOR_POINTER_WALKBACK_FLOOR` if that floor is hit.
- `isReachable(): Promise<boolean>` — v3.3 clarifies this is a **live probe that performs `InclusionProof.verify`** on a test request ID; it is NOT an HTTP-level ping. A successful return implies the aggregator responded AND the trust base verified the response, which is the actual precondition for clearing BLOCKED (spec §10.2.4).

No new API methods are introduced in v3.3 beyond the precondition tightening noted above. All additions go in spec §13.

### 15.3 Grace period

No external consumers read the Profile IPNS records directly — the only reader is `recoverFromIpnsSnapshot`, replaced in the same PR. **No grace period required.** Wallets that had published an IPNS snapshot before the cutover find their IPNS record orphaned post-upgrade and fall through to "proceed with empty state" until their first post-upgrade flush writes a proper aggregator pointer. Live-peer OpLog replication still delivers data in the interim.

### 15.4 Migration PR scope

1. New module: `profile/profile-aggregator-pointer.ts` — key derivations, XOR encode/decode, publish, recover per this design and the spec.
2. Modifications to `profile/profile-token-storage-provider.ts` per §15.1.
3. Deletion of `profile/profile-ipns.ts` and its unit tests.
4. New unit tests: key-derivation determinism, XOR round-trip, deterministic padding, version discovery (mocked aggregator), conflict handling, partial-publish detection, crash-safety pending-tuple logic.
5. New integration test: two-device conflict race against a real (or testcontainer) aggregator.
6. Updates to `docs/uxf/PROFILE-ARCHITECTURE.md` §7.6 to reference this document.

### 15.5 v3.3 migration delta (on top of §15.1–§15.4)

Revision 3.3 adds constants, error codes, and events that the implementation PR must register alongside the v3.1/v3.2 items. Canonical definitions live in spec §3 (constants) and §12 (error codes); the arch list is a cross-reference.

**New constants (spec §3):**

- `MARKER_MAX_JUMP` — carried over from v3.1 (`1024` versions).
- `MAX_CT_RESIDENT_MS` — carried over from v3.1 (`500` ms).
- ~~`MIN_MIRROR_COUNT` — carried over from v3.1 (`2` mirrors).~~ **Removed in v3.4** (multi-mirror TOFU deferred to v2; see §6.5).
- `MAX_CAR_BYTES` — `100 MiB` (replaces and renames the v3.1 constant; same value).
- `MAX_CAR_FETCH_INITIAL_RESPONSE_MS` — `10 s` (v3.3 new).
- `MAX_CAR_FETCH_STALL_MS` — `30 s` (v3.3 new — progress-rate enforcement between chunks).
- `MAX_CAR_FETCH_TOTAL_MS` — `300 s` / 5 min (v3.3 new; replaces `MAX_CAR_FETCH_MS = 60 s` with a progress-aware cap).
- `MAX_CAR_FETCH_RETRY` — `3` per-gateway attempts (v3.3 new).
- ~~`MIRROR_LIST_SHA256` — computed at release time (v3.3 new — integrity hash of bundled mirror list).~~ **Removed in v3.4.**
- ~~`MIRROR_CERT_PINS` — per-mirror pinned leaf/intermediate SHA-256 cert fingerprints (v3.3 new).~~ **Removed in v3.4.**
- `CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS` — `12` (v3.3 new — persistent hourly retries before `acceptCarLoss`).
- `CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS` — `24 h` (v3.3 new — wall-clock minimum before `acceptCarLoss`).
- `POINTER_PEER_DISCOVERY_MS` — `10 min` (v3.3 new — peer-availability poll window).
- `PUBLISH_REQUEST_TIMEOUT_MS` — `30 s` (v3.3 new — per-request timeout for `submitCommitment`).
- `PROBE_REQUEST_TIMEOUT_MS` — `10 s` (v3.3 new — per-request timeout for `getInclusionProof` during probes).

**New error codes (spec §12):**

- `AGGREGATOR_POINTER_TRUST_BASE_STALE` — trust base aged out; rotation remediation is SDK release in v3.4 (see §6.5, spec §8.4.1).
- ~~`AGGREGATOR_POINTER_CERT_PIN_MISMATCH` — TLS cert fingerprint does not match pinned value.~~ **Removed in v3.4** (cert pinning deferred to v2).
- ~~`AGGREGATOR_POINTER_MIRROR_LIST_TAMPERED` — bundled mirror list integrity check failed.~~ **Removed in v3.4** (mirror-list infrastructure deferred to v2).
- `AGGREGATOR_POINTER_PUBLISH_BUSY` — mutex contention exhausted retry budget.
- `AGGREGATOR_POINTER_UNSUPPORTED_RUNTIME` — platform lacks required primitives (e.g., Web Locks API).
- `AGGREGATOR_POINTER_CAR_UNEXPECTED_ENCODING` — CAR payload has unexpected encoding/codec.
- `AGGREGATOR_POINTER_PROTOCOL_ERROR` — malformed JSON / unknown enum from aggregator.
- `AGGREGATOR_POINTER_AGGREGATOR_REJECTED` — permanent HTTP 4xx (non-retryable).
- `AGGREGATOR_POINTER_CAPABILITY_DENIED` — operator-override capability gate missing.
- `AGGREGATOR_POINTER_WALKBACK_FLOOR` — walkback hit `localVersion` floor without finding a valid version.

**New events (§13 arch-level observability taxonomy):**

- `pointer:car_loss_pending { version, retriesRemaining }` — emitted during persistent-retry window before `acceptCarLoss` eligibility.
- `pointer:car_loss_aborted_peer_found { version }` — peer-discovery aborted the override; wait for replication to heal.
- `pointer:car_loss_accepted { version }` — payload updated from `{ version }` to include the final confirmation state (consumers treat it the same).

**Originated-tag migration (atomic PR).** The `originated` tag introduced in v3.1 / v3.2 (spec §10.2.3) must be stamped by ALL OpLog writers. The implementation PR MUST update PaymentsModule, AccountingModule, SwapModule, CommunicationsModule, and profile-token-storage-provider atomically — a partial migration lets un-stamped entries disable BLOCKED incorrectly (§6.7 condition (iii)). Recipients apply the semantic re-validation from spec §10.2.3 (entry-type vs tag); mismatches raise `SECURITY_ORIGIN_MISMATCH` and are not replicated further.

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
| v3.1 | 2026-04-20 | Hardening pass applied from steelman findings on v3: marker version-jump clamp, retry-window ciphertext zeroization, mandatory multi-mirror TOFU with fresh-install corrupt-payload BLOCKED, CAR size caps and unavailable-state handling, `originated` tag for user-originated OpLog writes, probe-sequence fingerprint disclosure, test-vector runtime rejection, new API methods (`acceptCarLoss`, `clearPendingMarker`, `getProbeFingerprint`). Error-code name aligned (`AGGREGATOR_POINTER_UNTRUSTED_PROOF`). BLOCKED SET conditions aligned (four conditions, "attempted AND failed" phrasing). Symbol naming aligned (`paddingBytes_v`). `findLatestVersion` call-site arity corrected. `localSigningPubKey` disambiguated as wallet chain-key pubkey (`localChainKeyPublicKey`) throughout. Async-await convention footnote added. Note: spec change log F-numbering skips F6 (reserved, not used in v3); arch does not enumerate F-items, so no renumbering is required on the arch side. Spec is canonical; arch narrates. |
| v3.2 | 2026-04-21 | Apply r3.1 steelman findings: API signatures aligned with spec (`Promise<Result<void>>`); §6.7 user-originated rewritten to reference `originated` tag rule (spec §10.2.3); valid-version-continuity narrative added (§9.8) replacing the v3.1 fresh-install BLOCKED-on-corrupt rule; event payloads harmonized; cross-references to spec §10.7 (was §10.4) fixed; spec §3 (was §3.1) fixed; residual trade-offs documented in spec §11.13. |
| v3.3 | 2026-04-21 | Final hardening pass closing 14 critical + 12 warning findings from 6-agent final review. Token-loss paths closed: transient CAR skip (spec §8.2 Phase 3 + §8.5), probe predicate non-monotonicity (§8.1 OR), mutex cross-context scope (§7.1.1 Web Locks / file lock), publish deadlock on corrupt residue (§9 max(validV, includedV)+1), trust base rotation bricking (§8.4.1), asymmetric trust base vs L4 (§8.4.2), acceptCarLoss token loss (§10.7.1 republish-before-advance), REJECTED OTP reuse (§7.3 burn v), TLS MITM on TOFU (§8.4.3 cert pinning + CA diversity + mirror-list integrity), CAR fetch wall-clock timeout on slow networks (§8.5 progress-rate + HTTP Range resume), §7.1.4 idempotent-retry case preserved (§7.1.4), §11.11 zeroization relaxed to achievable target. Editorial: HKDF info byte count typo corrected (33 bytes), walletPrivateKey pinned to BIP32 master, HTTPS mandated for IPFS gateways, HTTP status-code outcome matrix expanded, network timeouts added, identity-swap-during-publish rules, capability gates on operator overrides, SDK version pinning open item added, isReachable() specified as live probe. Originated-tag writer enumeration added for migration PR. Arch narrates; spec is canonical. |
| v3.4 | 2026-04-21 | **Embedded `RootTrustBase` deployment model.** §6.5 rewritten to describe the SDK-bundled trust base at `assets/trustbase/<network>.ts` (shared with L4 / `PaymentsModule` via `OracleProvider`); multi-mirror TOFU narrative deleted and marked as v2 future work. §6.7 cross-ref to §6.5 updated (shared embedded trust base replaces multi-mirror cross-check). §9.9 v3.3 security-and-privacy additions rewritten: trust-base rotation becomes "`TRUST_BASE_STALE` + ship SDK update" (no runtime refresh); shared-trust-base-vs-L4 rule promoted to canonical v3.4 rule; TLS section simplified to standard WebPKI. §10.6 trade-offs updated: "bundled trust base as centralized trust root" replaces the former "bundled mirror list" entry; new "runtime-fetched trust base with L1-alpha-anchored fingerprint" v2 work item added (unblocks multi-mirror TOFU as a meaningful defense when runtime fetch ships). §15.5 v3.3 migration delta annotated: `MIN_MIRROR_COUNT`, `MIRROR_LIST_SHA256`, `MIRROR_CERT_PINS`, `AGGREGATOR_POINTER_CERT_PIN_MISMATCH`, `AGGREGATOR_POINTER_MIRROR_LIST_TAMPERED` marked "Removed in v3.4". Header bumped to v3.4. Rationale: v1 Sphere deployment is single aggregator + single IPFS node with embedded trust base already consumed by L4 (confirmed by user); multi-mirror TOFU is neither deployable nor meaningful against that topology without the v2 runtime-fetch + L1-anchor prerequisite shipping first. Spec §3 / §8.4 / §8.4.1 / §8.4.3 / §11.13 / §12 hold the byte-level corollaries. |
