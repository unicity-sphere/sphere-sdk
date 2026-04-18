# SwapModule Protocol v2 — Specification

> **Status:** Implemented — `feat/swap-module-spec` branch
> **Affects:** `modules/swap/`, `escrow-service/src/core/`, `core/crypto.ts`
> **Branch:** `feat/swap-module-spec`

---

## Table of Contents

1. [Motivation](#1-motivation)
2. [Protocol Flow](#2-protocol-flow)
3. [Signature Scheme](#3-signature-scheme)
4. [Updated Type Definitions](#4-updated-type-definitions)
5. [Updated DM Protocol](#5-updated-dm-protocol)
6. [Nametag Token Binding](#6-nametag-token-binding)
7. [SDK Implementation](#7-sdk-implementation)
8. [Escrow Implementation](#8-escrow-implementation)
9. [Backward Compatibility](#9-backward-compatibility)
10. [Security Analysis](#10-security-analysis)

---

## 1. Motivation

Protocol v1 has three architectural weaknesses:

**1a. Alice must be online for escrow announcement.** In v1, after Bob accepts, Alice receives the acceptance DM, then Alice announces to the escrow. If Alice is offline after sending the proposal, the swap stalls. Bob cannot proceed until Alice comes back online, reads the acceptance, and forwards the manifest to the escrow. This creates unnecessary latency and a single point of fragility.

**1b. No cryptographic consent proof.** The escrow accepts a manifest from any party without verifying that both parties actually consented to the deal. A malicious party could announce a fabricated manifest to the escrow (though the escrow cannot steal funds since deposits require the actual party to send tokens, this creates unnecessary swap records and deposit invoices).

**1c. No nametag-to-address binding verification.** When a deal uses `@nametag` addresses that resolve to `DIRECT://` addresses, the escrow has no way to verify that the nametag holder authorized the resolved address. A Nostr relay compromise or nametag hijack could cause the manifest to bind to a wrong address.

---

## 2. Protocol Flow

### 2.1 V1 Flow (Legacy)

```
Alice                           Bob                         Escrow
  |                              |                            |
  |-- proposal(manifest,escrow)->|                            |
  |                              |                            |
  |<--- acceptance(swap_id) -----|                            |
  |                              |                            |
  |-- announce(manifest) --------|--------------------------->|
  |                              |                            |
  |<----------- announce_result + invoice_delivery -----------|
  |              (to both)                                    |
```

### 2.2 V2 Flow (Implemented)

```
Alice                           Bob                         Escrow
  |                              |                            |
  |-- proposal_v2(manifest,      |                            |
  |    escrow, sig_a) ---------> |                            |
  |                              |                            |
  |                              |-- announce_v2(manifest,    |
  |<-- acceptance_v2(swap_id, ---|    sig_a, sig_b) --------> |
  |     sig_b) [informational]   |                            |
  |                              |                            |
  |<----------- announce_result + invoice_delivery -----------|
  |              (to both)                                    |
```

### 2.3 Detailed Sequence -- Alice's Perspective (Proposer)

1. Alice constructs `SwapDeal`, resolves addresses, builds `SwapManifest`.
2. Alice signs `"swap_consent:" + swap_id + ":" + escrow_address` with her chain private key, producing `sig_a`.
3. Alice sends `swap_proposal_v2` DM to Bob containing `{manifest, escrow, sig_a, message?}`.
4. Alice persists `SwapRef` with `progress='proposed'`.
5. Alice starts proposal timeout timer.
6. **Wait:** Alice receives one of:
   - `swap_acceptance_v2` DM from Bob (containing `sig_b`) -- informational only, Alice transitions to `accepted`.
   - `swap_rejection` DM from Bob -- Alice transitions to `cancelled`.
   - Proposal timeout expires -- Alice transitions to `failed`.
   - `announce_result` from escrow -- Alice transitions directly to `announced` (this arrives even without the acceptance DM, since Bob announced directly).
7. After receiving `announce_result` (either via acceptance path or directly from escrow), Alice imports the deposit invoice and proceeds with the deposit flow as in v1.

### 2.4 Detailed Sequence -- Bob's Perspective (Acceptor)

1. Bob receives `swap_proposal_v2` DM from Alice.
2. Bob verifies manifest integrity (`swap_id == SHA-256(JCS(fields))`).
3. Bob verifies `sig_a` against the chain pubkey derived from `party_a_address`.
4. Bob presents the deal to the user for approval.
5. On acceptance, Bob signs `"swap_consent:" + swap_id + ":" + escrow_address` with his chain private key, producing `sig_b`.
6. **Bob sends TWO messages in parallel (fire-and-forget for acceptance DM):**
   - `announce_v2` DM to escrow containing `{manifest, signatures: {party_a: sig_a, party_b: sig_b}, auxiliary?}`.
   - `swap_acceptance_v2` DM to Alice containing `{swap_id, sig_b}` -- informational only.
7. Bob persists `SwapRef` with `progress='accepted'`.
8. Bob receives `announce_result` from escrow, transitions to `announced`.
9. Deposit flow continues as in v1.

### 2.5 Key Invariant

Alice does NOT need to be online between steps 3 and 7 of her flow. Bob announces directly to the escrow. Alice will receive the `announce_result` from the escrow whenever she comes online. The acceptance DM from Bob is purely informational -- Alice's state machine can transition to `announced` directly from `proposed` if the `announce_result` arrives first.

### 2.6 State Machine Changes

New valid transitions for the proposer:

```
proposed -> announced    (NEW: announce_result arrives before acceptance DM)
proposed -> accepted     (existing: acceptance DM arrives first)
accepted -> announced    (existing: announce_result arrives after acceptance)
```

Both `proposed -> announced` and `accepted -> announced` are valid for the proposer in v2. The `VALID_PROGRESS_TRANSITIONS` map in `state-machine.ts` is updated accordingly.

For the acceptor, no change: `proposed -> accepted -> announced` remains the only path (Bob transitions to `accepted` locally before sending the announce).

---

## 3. Signature Scheme

### 3.1 What Is Signed

The signed message is a domain-prefixed string: `"swap_consent:" + swap_id + ":" + escrow_address`.

Example: `swap_consent:a1b2c3d4...64hex...:DIRECT://abc_def`

**Rationale:** The domain prefix `"swap_consent:"` provides domain separation -- signatures produced for the swap protocol cannot be replayed in other contexts that use `signMessage`/`verifySignedMessage` (e.g., Connect protocol's `sign_message` intent). Including the `escrow_address` in the signed message binds the signature to a specific escrow, preventing redirect attacks where an attacker substitutes a different escrow address. Since the `swap_id` already commits to all deal terms including the escrow address (see section 4.1), the escrow binding in the signature is a defense-in-depth measure -- even if the `swap_id` computation were somehow bypassed, the signature would still fail verification against a different escrow.

### 3.2 Signing Function

Implemented in `modules/swap/manifest.ts`:

```typescript
import { signMessage } from '../../core/crypto.js';

export function signSwapManifest(privateKey: string, swapId: string, escrowAddress: string): string {
  const message = `swap_consent:${swapId}:${escrowAddress}`;
  return signMessage(privateKey, message);
}
```

The output is a 130-character hex string: `v (2 chars) + r (64 chars) + s (64 chars)`, where v encodes the recovery parameter as `31 + recoveryParam`.

### 3.3 Verification Function

```typescript
import { verifySignedMessage } from '../../core/crypto.js';

export function verifySwapSignature(swapId: string, escrowAddress: string, signature: string, chainPubkey: string): boolean {
  const message = `swap_consent:${swapId}:${escrowAddress}`;
  return verifySignedMessage(message, signature, chainPubkey);
}
```

The `chainPubkey` is the 66-character compressed secp256k1 public key extracted from the party's `DIRECT://` address.

### 3.4 Extracting Chain Pubkey from DIRECT Address

The `DIRECT://` address format is `DIRECT://{hash1}_{hash2}`. The chain pubkey is NOT directly recoverable from the DIRECT address (it contains hashes, not the pubkey itself). Instead:

- **At proposal time (Alice):** Alice knows her own `identity.chainPubkey`.
- **At acceptance time (Bob):** Bob knows his own `identity.chainPubkey`. Bob verifies Alice's signature by resolving `party_a_address` via `resolve()` to get Alice's `chainPubkey` from `PeerInfo`.
- **At announce time (Escrow):** The escrow resolves both party addresses via `AddressResolver` to obtain chain pubkeys. Alternatively, the announce message includes the chain pubkeys explicitly (see section 5.3).

### 3.5 Chain Pubkey Inclusion in Announce

Since the escrow must verify signatures against chain pubkeys, and `DIRECT://` addresses do not embed the pubkey, the `announce_v2` message includes both chain pubkeys. The escrow verifies that:

1. Each chain pubkey resolves to (or is consistent with) the corresponding `DIRECT://` address in the manifest.
2. Each signature is valid against the corresponding chain pubkey.

The escrow can verify address-to-pubkey consistency by:
- Resolving the `DIRECT://` address via its `AddressResolver` and comparing the returned `chainPubkey`.
- OR computing the `DIRECT://` address from the chain pubkey using the same derivation function and comparing.

The second approach is preferred as it is deterministic and does not require a network call.

### 3.6 Why Not Sign the Full JCS Manifest

Signing the full JCS-canonical manifest string would work equivalently but adds complexity:
- The manifest JSON must be canonicalized identically on all parties (already done for `swap_id` computation).
- The `signMessage` function uses Bitcoin-style double-SHA256 with a prefix, so the signed value is `SHA256(SHA256(prefix + len + message))` where message is the domain-prefixed string. Signing a longer JSON string would change the hash but provide no additional security since the `swap_id` is already a binding commitment to all fields (including the escrow address and protocol version).
- Signing the domain-prefixed `swap_id` keeps signatures compact, avoids re-serialization ambiguity, and provides explicit domain separation from other signing contexts in the SDK.

---

## 4. Updated Type Definitions

### 4.1 Manifest Types

`ManifestFields` includes the following fields. The `salt`, `escrow_address`, and `protocol_version` fields are all part of the JCS hash input for `swap_id` computation:

- **`salt`:** A 32-character lowercase hex string (`randomHex(16)`) generated at manifest construction time. Ensures each proposal produces a unique `swap_id` even when two proposals have identical deal terms (same parties, currencies, amounts, timeout). Without the salt, re-proposing an identical deal would collide on `swap_id`, breaking idempotency checks and escrow deduplication.
- **`escrow_address`:** Binds the escrow into the deal terms. Changing the escrow changes the `swap_id`. Combined with domain-prefixed signatures (section 3), the signature is double-bound to the escrow.
- **`protocol_version`:** Prevents downgrade attacks. A v2 manifest hashes to a different `swap_id` than a v1 manifest with otherwise identical fields, so a v2 manifest can never be announced as v1.

```typescript
interface ManifestFields {
  readonly party_a_address: string;
  readonly party_b_address: string;
  readonly party_a_currency_to_change: string;
  readonly party_a_value_to_change: string;
  readonly party_b_currency_to_change: string;
  readonly party_b_value_to_change: string;
  readonly timeout: number;
  /** Random salt ensuring unique swap_id even for identical deal terms (32 hex chars).
   *  Validation: /^[0-9a-f]{32}$/ */
  readonly salt: string;
  /** Escrow DIRECT:// address (v2, required when protocol_version === 2) */
  readonly escrow_address?: string;
  /** Protocol version: 2 for signed manifests (v2 only, required when present) */
  readonly protocol_version?: number;
}
```

> **Validation note:** When `protocol_version === 2`, `escrow_address` is REQUIRED. When `protocol_version` is absent (v1), `escrow_address` is also absent. JCS canonicalization omits `undefined` properties, so v1 manifests hash identically with or without the new fields declared on the TypeScript interface.

> **Hash construction note:** Both `validateManifest` and `verifyManifestIntegrity` use strict `!== undefined` checks (NOT truthiness) to determine whether `escrow_address` and `protocol_version` should be included in the hash input. This is critical because falsy values (such as `0`, `""`, or `false`) must still be included in the JCS hash if they are present on the manifest. Using a truthiness check (`?` or `||`) would silently drop a `protocol_version: 0` or empty-string `escrow_address`, causing hash divergence between producer and verifier.

The `swap_id` computation remains `SHA-256(JCS(fields))` and includes all fields present on `ManifestFields` (the 7 original fields plus `salt`, and conditionally `escrow_address` and `protocol_version`).

Signatures are NOT part of the manifest -- they are transported alongside it.

### 4.2 SwapManifest

The `SwapManifest` type mirrors `ManifestFields` but includes the computed `swap_id`:

```typescript
interface SwapManifest {
  readonly swap_id: string;           // SHA-256(JCS(ManifestFields))
  readonly party_a_address: string;
  readonly party_b_address: string;
  readonly party_a_currency_to_change: string;
  readonly party_a_value_to_change: string;
  readonly party_b_currency_to_change: string;
  readonly party_b_value_to_change: string;
  readonly timeout: number;
  readonly salt: string;              // 32 lowercase hex chars
  readonly escrow_address?: string;   // v2: DIRECT:// address
  readonly protocol_version?: number; // v2: 2
}
```

### 4.3 ManifestSignatures

```typescript
/**
 * Cryptographic signatures from both parties over the domain-prefixed message
 * "swap_consent:{swap_id}:{escrow_address}". Each signature is a 130-char hex
 * string (v + r + s) produced by signMessage(privateKey, message) from core/crypto.ts.
 *
 * party_a is always present in proposal DMs (Alice signs when proposing).
 * party_b is always present in announce DMs (Bob signs when accepting).
 * Both are present in the announce DM sent to the escrow.
 */
export interface ManifestSignatures {
  /** Alice's signature of "swap_consent:{swap_id}:{escrow_address}", using her chain private key. 130 hex chars. */
  readonly party_a?: string;
  /** Bob's signature of "swap_consent:{swap_id}:{escrow_address}", using his chain private key. 130 hex chars. */
  readonly party_b?: string;
}
```

### 4.4 ManifestAuxiliary (Nametag Binding)

```typescript
/**
 * Auxiliary data carried alongside the manifest but NOT included
 * in swap_id computation. Contains nametag-to-address binding proofs
 * when the original deal used @nametag or PROXY:// addresses.
 *
 * Purpose: allows the escrow to verify that the nametag holder
 * authorized the DIRECT:// address in the manifest, preventing
 * nametag hijack attacks.
 */
export interface ManifestAuxiliary {
  /** Nametag binding proof for party A (present if partyA was @nametag) */
  readonly party_a_binding?: NametagBindingProof;
  /** Nametag binding proof for party B (present if partyB was @nametag) */
  readonly party_b_binding?: NametagBindingProof;
}

/**
 * Proof that a nametag resolves to a specific DIRECT:// address.
 * The proof is a signature of the binding message by the nametag owner's
 * chain private key.
 *
 * Binding message format: "nametag_bind:{nametag}:{direct_address}:{swap_id}"
 * This binds the nametag to a specific address FOR this specific swap,
 * preventing replay of binding proofs across different swaps.
 */
export interface NametagBindingProof {
  /** The @nametag (without @ prefix) as used in the original deal */
  readonly nametag: string;
  /** The resolved DIRECT:// address */
  readonly direct_address: string;
  /** The chain pubkey (33-byte compressed, 66 hex chars) of the nametag owner */
  readonly chain_pubkey: string;
  /**
   * Signature of the binding message by the nametag owner's chain key.
   * Binding message: "nametag_bind:{nametag}:{direct_address}:{swap_id}"
   * 130-char hex string (v + r + s).
   */
  readonly signature: string;
}
```

### 4.5 SwapProposalMessage (v2)

```typescript
/**
 * Swap proposal DM v2 -- sent from proposer to counterparty.
 * Includes the proposer's signature over the swap_id and
 * optional nametag binding proofs.
 *
 * Wire format: `swap_proposal:` prefix + JSON.stringify(SwapProposalMessage)
 * (same prefix as v1 -- version field discriminates)
 */
export interface SwapProposalMessage {
  readonly type: 'swap_proposal';
  /** Protocol version: 1 (legacy) or 2 (signed) */
  readonly version: 1 | 2;
  readonly manifest: SwapManifest;
  readonly escrow: string;
  /** Proposer's signature of "swap_consent:{swap_id}:{escrow_address}" (130 hex chars, v2 only) */
  readonly proposer_signature?: string;
  /** Proposer's chain pubkey (66 hex chars, compressed secp256k1, v2 only) */
  readonly proposer_chain_pubkey?: string;
  /** Optional nametag binding proofs (v2 only) */
  readonly auxiliary?: ManifestAuxiliary;
  readonly message?: string;
}
```

### 4.6 SwapAcceptanceMessage (v2)

```typescript
/**
 * Swap acceptance DM v2 -- sent from acceptor to proposer.
 * Includes the acceptor's signature over the swap_id.
 * This message is INFORMATIONAL in v2 -- the acceptor also
 * announces directly to the escrow. The proposer does not need
 * to act on this message for the swap to proceed.
 *
 * Wire format: `swap_acceptance:` prefix + JSON.stringify(SwapAcceptanceMessage)
 */
export interface SwapAcceptanceMessage {
  readonly type: 'swap_acceptance';
  /** Protocol version: 1 (legacy) or 2 (signed) */
  readonly version: 1 | 2;
  readonly swap_id: string;
  /** Acceptor's signature of "swap_consent:{swap_id}:{escrow_address}" (130 hex chars, v2 only) */
  readonly acceptor_signature?: string;
  /** Acceptor's chain pubkey (66 hex chars, compressed secp256k1, v2 only) */
  readonly acceptor_chain_pubkey?: string;
}
```

### 4.7 Updated: SwapRef

New fields added to `SwapRef` for v2 support:

```typescript
interface SwapRef {
  // ... existing fields unchanged ...

  /** Proposer's chain pubkey (from v2 proposal DM's proposer_chain_pubkey field).
   * Stored by the acceptor for use in the announce_v2 chain_pubkeys map. */
  readonly proposerChainPubkey?: string;
  /** Proposer's signature over "swap_consent:{swap_id}:{escrow_address}" (set at proposal time) */
  readonly proposerSignature?: string;
  /** Acceptor's signature over "swap_consent:{swap_id}:{escrow_address}" (set and stored after acceptance verification) */
  readonly acceptorSignature?: string;
  /** Nametag binding proofs (set at proposal time if nametags used) */
  readonly auxiliary?: ManifestAuxiliary;
  /** Protocol version (2 for v2, undefined for v1) */
  readonly protocolVersion?: number;
}
```

> **Note on acceptorSignature storage:** After the proposer receives and verifies Bob's acceptance DM (v2), the verified `acceptorSignature` is stored on the `SwapRef` and persisted. This allows the signature to survive crashes and be available for crash recovery / re-announce scenarios.

---

## 5. Updated DM Protocol

### 5.1 Proposal DM (Alice -> Bob)

**Builder** (implemented in `dm-protocol.ts`):

```typescript
function buildProposalDM_v2(
  manifest: SwapManifest,
  escrow: string,
  proposerSignature: string,
  proposerChainPubkey: string,
  auxiliary?: ManifestAuxiliary,
  message?: string,
): string {
  return SWAP_PROPOSAL_PREFIX + JSON.stringify({
    type: 'swap_proposal',
    version: 2,
    manifest,
    escrow,
    proposer_signature: proposerSignature,
    proposer_chain_pubkey: proposerChainPubkey,
    ...(auxiliary !== undefined ? { auxiliary } : {}),
    ...(message !== undefined && message !== '' ? { message } : {}),
  });
}
```

**Parser:** The `parseProposal` function handles both `version: 1` (legacy) and `version: 2` (signed). For v2:
- Validates `proposer_signature` is a 130-char hex string (regex: `/^[0-9a-f]{130}$/`).
- Validates `proposer_chain_pubkey` is a 66-char hex string starting with `02` or `03` (regex: `/^(02|03)[0-9a-f]{64}$/`).
- Validates `auxiliary` structure if present.
- Returns with `version: 2` in the payload.

### 5.2 Acceptance DM (Bob -> Alice, Informational)

**Builder:**

```typescript
function buildAcceptanceDM_v2(
  swapId: string,
  acceptorSignature: string,
  acceptorChainPubkey: string,
): string {
  return SWAP_ACCEPTANCE_PREFIX + JSON.stringify({
    type: 'swap_acceptance',
    version: 2,
    swap_id: swapId,
    acceptor_signature: acceptorSignature,
    acceptor_chain_pubkey: acceptorChainPubkey,
  });
}
```

### 5.3 Announce DM (Bob -> Escrow)

**Builder:**

```typescript
/**
 * Build an announce_v2 DM to submit a signed manifest to the escrow.
 * Includes both party signatures so the escrow can verify consent.
 */
function buildAnnounceDM_v2(
  manifest: SwapManifest,
  signatures: ManifestSignatures,
  chainPubkeys: { party_a: string; party_b: string },
  auxiliary?: ManifestAuxiliary,
): string {
  return JSON.stringify({
    type: 'announce',
    version: 2,
    manifest,
    signatures,
    chain_pubkeys: chainPubkeys,
    ...(auxiliary !== undefined ? { auxiliary } : {}),
  });
}
```

**Wire format:**

```json
{
  "type": "announce",
  "version": 2,
  "manifest": {
    "swap_id": "a1b2c3...",
    "party_a_address": "DIRECT://...",
    "party_b_address": "DIRECT://...",
    "party_a_currency_to_change": "UCT",
    "party_a_value_to_change": "1000000",
    "party_b_currency_to_change": "USDU",
    "party_b_value_to_change": "500000",
    "timeout": 3600,
    "salt": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    "escrow_address": "DIRECT://escrow_hash1_hash2",
    "protocol_version": 2
  },
  "signatures": {
    "party_a": "1f<64-char-r><64-char-s>",
    "party_b": "1f<64-char-r><64-char-s>"
  },
  "chain_pubkeys": {
    "party_a": "02abc123...",
    "party_b": "03def456..."
  },
  "auxiliary": {
    "party_a_binding": {
      "nametag": "alice",
      "direct_address": "DIRECT://...",
      "chain_pubkey": "02abc123...",
      "signature": "1f..."
    }
  }
}
```

### 5.4 Escrow Response Messages (Unchanged)

All escrow-to-wallet messages (`announce_result`, `invoice_delivery`, `status_result`, etc.) remain unchanged. The escrow sends `announce_result` to BOTH parties after a successful `announce_v2`, exactly as in v1.

---

## 6. Nametag Token Binding

### 6.1 Problem Statement

When Alice proposes a swap with `partyA: '@alice'`, the SDK resolves this to `DIRECT://hash1_hash2` via the Nostr identity binding event. If the relay is compromised or the nametag is hijacked, the resolved address could belong to an attacker. The manifest would then name the attacker's address as party A, and the escrow would route the payout there.

### 6.2 Binding Message Format

```
nametag_bind:{nametag}:{direct_address}:{swap_id}
```

Example:
```
nametag_bind:alice:DIRECT://a1b2c3_d4e5f6:7890abcdef...
```

The inclusion of `swap_id` in the binding message prevents replay attacks -- a binding proof from one swap cannot be used in another.

### 6.3 Binding Proof Construction

Implemented in `modules/swap/manifest.ts`:

```typescript
export function createNametagBinding(
  privateKey: string,
  nametag: string,
  directAddress: string,
  swapId: string,
  chainPubkey: string,
): NametagBindingProof {
  const message = `nametag_bind:${nametag}:${directAddress}:${swapId}`;
  const signature = signMessage(privateKey, message);
  return { nametag, direct_address: directAddress, chain_pubkey: chainPubkey, signature };
}
```

> **Implementation note:** The chain pubkey is passed explicitly as a parameter (not derived from the private key inside the function). This matches the actual implementation in `manifest.ts`.

### 6.4 Binding Proof Verification

```typescript
export function verifyNametagBinding(
  proof: NametagBindingProof,
  swapId: string,
): boolean {
  const message = `nametag_bind:${proof.nametag}:${proof.direct_address}:${swapId}`;
  return verifySignedMessage(message, proof.signature, proof.chain_pubkey);
}
```

> **Implementation note:** The actual `verifyNametagBinding` function takes only `proof` and `swapId` as parameters (the `direct_address` and `chain_pubkey` are read from the proof object itself). Address-to-pubkey consistency checks are performed separately by the caller.

### 6.5 When Bindings Are Created

- **Proposer:** If the deal's `partyA` or `partyB` is an `@nametag` or `PROXY://` address, AND the proposer IS that party, the proposer creates a binding proof for themselves.
- **Proposer for counterparty:** The proposer CANNOT create a binding proof for the counterparty (does not have their private key). The counterparty's binding proof is added by the acceptor.
- **Acceptor:** If the acceptor's party used a `@nametag` address, the acceptor creates their own binding proof and adds it to the `auxiliary` before announcing to the escrow.

The `ManifestAuxiliary` is built incrementally:
1. Alice creates `auxiliary` with `party_a_binding` if she used a nametag. She sends this in the proposal.
2. Bob receives the proposal with `auxiliary`. Bob adds `party_b_binding` if he used a nametag. Bob sends the combined `auxiliary` to the escrow in the announce.

### 6.6 Escrow Verification

The escrow performs nametag binding verification ONLY if `auxiliary` is present and contains binding proofs. If the manifest uses `DIRECT://` addresses directly (no nametags in the original deal), no binding proofs are required.

For each binding proof present:
1. Verify `direct_address` matches the corresponding party address in the manifest.
2. Verify `chain_pubkey` derives to `direct_address`.
3. Verify the signature against `chain_pubkey` and the binding message.

If any verification fails, the escrow rejects the announce with an `error` DM.

### 6.7 Auxiliary Data and swap_id

**The auxiliary data is NOT included in the swap_id hash.** The swap_id binds only to the core deal terms (addresses, currencies, amounts, timeout, salt). The auxiliary data provides supplementary proof of authorization. This means:
- The same swap_id can be announced with or without auxiliary data.
- Adding or modifying auxiliary data does not change the swap_id.
- The escrow treats binding verification as an additional validation step, not a manifest identity change.

### 6.8 Nametag Transfers After Proposal

Nametag transfers after proposal do not affect the swap. The manifest binds to resolved addresses at proposal time. Deposits and payouts use the locked-in `DIRECT://` addresses, not re-resolved addresses.

---

## 7. SDK Implementation

All changes described in this section are implemented in the `feat/swap-module-spec` branch.

### 7.1 `modules/swap/manifest.ts`

**Exports:**

```typescript
/** Compute swap_id as SHA-256(JCS(ManifestFields)). */
export function computeSwapId(fields: ManifestFields): string;

/** Build a complete SwapManifest with deterministic swap_id.
 *  Generates salt via randomHex(16). When escrowAddress is provided,
 *  includes escrow_address and protocol_version=2 in the manifest. */
export function buildManifest(
  resolvedPartyA: string, resolvedPartyB: string,
  deal: SwapDeal, timeout: number, escrowAddress?: string,
): SwapManifest;

/** Validate a SwapManifest against all field rules + swap_id integrity. */
export function validateManifest(manifest: SwapManifest): { valid: boolean; errors: string[] };

/** Lightweight integrity check: recompute swap_id and compare. */
export function verifyManifestIntegrity(manifest: SwapManifest): boolean;

/** Sign a swap consent message. Returns 130-char hex signature. */
export function signSwapManifest(privateKey: string, swapId: string, escrowAddress: string): string;

/** Verify a swap consent signature against a chain pubkey. */
export function verifySwapSignature(swapId: string, escrowAddress: string, signature: string, chainPubkey: string): boolean;

/** Create a nametag binding proof. */
export function createNametagBinding(
  privateKey: string, nametag: string, directAddress: string,
  swapId: string, chainPubkey: string,
): NametagBindingProof;

/** Verify a nametag binding proof. */
export function verifyNametagBinding(proof: NametagBindingProof, swapId: string): boolean;
```

**Salt generation:** `buildManifest()` generates a `salt` field via `randomHex(16)` (producing 32 hex chars) on every invocation. The salt is included in the `ManifestFields` object and thus participates in the JCS hash for `swap_id`. Validation enforces the regex `/^[0-9a-f]{32}$/`.

**Hash construction:** Both `validateManifest` and `verifyManifestIntegrity` reconstruct the `ManifestFields` for hashing using `!== undefined` checks:

```typescript
const hashFields: ManifestFields = {
  party_a_address: manifest.party_a_address,
  // ... other fields ...
  salt: manifest.salt,
  ...(manifest.escrow_address !== undefined ? { escrow_address: manifest.escrow_address } : {}),
  ...(manifest.protocol_version !== undefined ? { protocol_version: manifest.protocol_version } : {}),
};
```

### 7.2 `modules/swap/dm-protocol.ts`

**V2 builder functions (added alongside existing v1 builders):**

- `buildProposalDM_v2(manifest, escrow, proposerSignature, proposerChainPubkey, auxiliary?, message?)` -- v2 proposal with signature and chain pubkey.
- `buildAcceptanceDM_v2(swapId, acceptorSignature, acceptorChainPubkey)` -- v2 acceptance with signature.
- `buildAnnounceDM_v2(manifest, signatures, chainPubkeys, auxiliary?)` -- v2 announce with both signatures.

**Parser updates:**

- `parseProposal()` handles both `version: 1` (legacy) and `version: 2` (signed). For v2, validates `proposer_signature` (130 hex) and `proposer_chain_pubkey` (66 hex, `02`/`03` prefix).
- `parseAcceptance()` handles both versions. For v2, validates `acceptor_signature` and `acceptor_chain_pubkey`.
- `parseEscrowMessage()` for `announce_result` is unchanged (escrow response format does not change).

**Discriminated union:**

```typescript
export type ParsedSwapDM =
  | { readonly kind: 'proposal'; readonly payload: SwapProposalMessage }        // v1 or v2
  | { readonly kind: 'acceptance'; readonly payload: SwapAcceptanceMessage }     // v1 or v2
  | { readonly kind: 'rejection'; readonly payload: SwapRejectionMessage }       // unchanged
  | { readonly kind: 'escrow'; readonly payload: EscrowMessage };               // unchanged
```

Version is discriminated via the `version` field in the payload, not the `kind`. Consumers check `payload.version` to determine which fields are available.

### 7.3 `modules/swap/SwapModule.ts` -- `proposeSwap()`

The `proposeSwap()` method builds a v2 manifest with the escrow address, signs it, creates nametag bindings if applicable, and sends a v2 proposal DM:

1. Resolves the escrow address via `resolveEscrowAddress()`.
2. Calls `buildManifest(resolvedPartyA, resolvedPartyB, deal, deal.timeout, escrowPeer.directAddress)` -- this produces a manifest with `escrow_address`, `protocol_version: 2`, and a fresh `salt`.
3. Signs with `signSwapManifest(identity.privateKey, swapId, escrowPeer.directAddress)`.
4. Creates nametag binding if the proposer's original address was `@nametag`.
5. Persists `SwapRef` with `proposerSignature`, `proposerChainPubkey`, `auxiliary`, and `protocolVersion: 2`.
6. Sends via `buildProposalDM_v2()`.

### 7.4 `modules/swap/SwapModule.ts` -- `acceptSwap()`

The `acceptSwap()` method handles both v1 and v2 acceptance:

1. Transitions to `accepted`.
2. **V2 only:** Signs with `signSwapManifest()` using `manifest.escrow_address` (locked at proposal time, NOT re-resolved).
3. **V2 only:** Creates nametag binding if the acceptor's party used `@nametag`.
4. Stores `acceptorSignature` on `SwapRef` and persists.
5. Sends acceptance DM to proposer (fire-and-forget, non-fatal if it fails).
6. **V2 only:** Resolves escrow, builds `announce_v2` with both signatures and chain pubkeys, sends via `sendAnnounce_v2()`.
7. **V1 fallback:** The proposer announces to escrow after receiving the acceptance DM (existing v1 behavior).

### 7.5 `modules/swap/SwapModule.ts` -- Incoming Proposal Handler

The incoming proposal handler (DM processing):

1. Validates version (accepts 1 and 2).
2. Verifies manifest integrity (`swap_id` matches `SHA-256(JCS(fields))`).
3. **V2 only:** Verifies proposer's signature via `verifySwapSignature()`.
4. **V2 only:** Resolves proposer's `DIRECT://` address to get chain pubkey, verifies match.
5. **V2 only:** Verifies nametag bindings if `auxiliary` is present.
6. Stores `proposerSignature`, `proposerChainPubkey`, `auxiliary`, and `protocolVersion` on `SwapRef`.

### 7.6 `modules/swap/SwapModule.ts` -- Incoming Acceptance Handler (Proposer)

The acceptance handler for the proposer implements hardened validation for v2:

1. **Downgrade attack prevention:** For v2 swaps, the handler explicitly rejects v1-format acceptances (`acceptMsg.version !== 2`). A v1 acceptance on a v2 swap returns early WITHOUT clearing the proposal timer, preventing a malicious peer from sending a downgraded acceptance to strand the swap.
2. **Timer-before-check safety:** The proposal timer is cleared ONLY after all validation passes (version check, signature verification). This ensures a malformed acceptance DM cannot disarm the proposal watchdog.
3. **Signature verification:** The acceptor's signature is verified via `verifySwapSignature()` using the escrow address from `manifest.escrow_address` or `swap.escrowDirectAddress`.
4. **In-memory rollback on storage failure:** If `transitionProgress` throws during the `proposed -> accepted` transition (storage failure), the in-memory `swap.progress` and `swap.updatedAt` are restored to their previous values, `startProposalTimer` is re-armed, and a best-effort `persistSwap` of the rolled-back state is fired to heal any partial writes.
5. **Acceptor signature storage:** After successful transition, the verified `acceptorSignature` is stored on the `SwapRef` and persisted, making it available for crash recovery.
6. **V2 proposer does NOT announce:** In v2, the proposer just waits for `announce_result` from the escrow (Bob already announced).
7. **V1 fallback:** If `swap.protocolVersion` is undefined or < 2, the existing v1 path runs (proposer announces to escrow with `sendAnnounce`).

### 7.7 State Machine Update

In `modules/swap/state-machine.ts`, the transition map includes:

```typescript
const VALID_PROGRESS_TRANSITIONS: Record<SwapProgress, SwapProgress[]> = {
  proposed: ['accepted', 'announced', 'cancelled', 'failed'],  // proposed -> announced (v2)
  accepted: ['announced', 'cancelled', 'failed'],
  announced: ['depositing', 'cancelled', 'failed'],
  // ... rest unchanged
};
```

### 7.8 Crash Recovery

The crash recovery logic in `SwapModule.load()` is v2-aware:

- **`accepted` state (proposer, v2):** Does NOT re-announce. In v2, only the acceptor announces. The proposer sends a status query to check if the escrow already processed the announce.
- **`accepted` state (acceptor, v2):** Re-announces with both signatures via `sendAnnounce_v2()` (same as initial announce but safe due to escrow deduplication by `swap_id`).
- **`accepted` state (any, v1):** Existing behavior (re-announce from proposer side using `sendAnnounce()`).

### 7.9 `modules/swap/escrow-client.ts`

**`sendAnnounce_v2()`** is the v2 counterpart to `sendAnnounce()`. It wraps `buildAnnounceDM_v2()` with 5-retry exponential backoff (same as `sendAnnounce`):

```typescript
export async function sendAnnounce_v2(
  communications: SwapModuleDependencies['communications'],
  escrowPubkey: string,
  manifest: SwapManifest,
  signatures: ManifestSignatures,
  chainPubkeys: { party_a: string; party_b: string },
  auxiliary?: ManifestAuxiliary,
): Promise<void>;
```

Both `sendAnnounce` (v1) and `sendAnnounce_v2` coexist. The SwapModule selects the appropriate one based on `swap.protocolVersion`.

---

## 8. Escrow Implementation

### 8.1 Updated `announce()` Method

The `SwapOrchestrator.announce()` method (in `escrow-service/src/core/swap-orchestrator.ts`):

1. **Accepts the new announce format.** Parses `version`, `signatures`, `chain_pubkeys`, and `auxiliary` from the incoming DM.
2. **Verifies signatures (v2 only).** If `version === 2`:
   a. Verifies `signatures.party_a` against `chain_pubkeys.party_a`, `manifest.swap_id`, and the escrow's own `DIRECT://` address (domain-prefixed message: `"swap_consent:{swap_id}:{escrow_address}"`).
   b. Verifies `signatures.party_b` against `chain_pubkeys.party_b`, `manifest.swap_id`, and the escrow's own `DIRECT://` address.
   c. Verifies `chain_pubkeys.party_a` derives to `manifest.party_a_address`.
   d. Verifies `chain_pubkeys.party_b` derives to `manifest.party_b_address`.
   e. If any check fails, returns `error` DM with details.
3. **Verifies nametag bindings (if auxiliary present).** For each `NametagBindingProof`:
   a. Verifies the binding signature.
   b. Verifies `chain_pubkey` derives to `direct_address`.
   c. Verifies `direct_address` matches the corresponding party address in the manifest.
4. **Proceeds with existing logic** (create swap record, create deposit invoice, etc.).

### 8.2 Escrow Dependency: Signature Verification

The escrow service needs access to secp256k1 signature verification. Options:

- **Option A (Recommended):** Import `verifySignedMessage` and `hashSignMessage` from `@unicitylabs/sphere-sdk/core/crypto`. The escrow already depends on `sphere-sdk` transitively.
- **Option B:** Implement minimal signature verification using `@noble/curves/secp256k1` directly. This avoids the sphere-sdk dependency but duplicates logic.

### 8.3 Escrow Dependency: Address Derivation

The escrow must verify that a chain pubkey derives to a `DIRECT://` address. This requires the same address derivation function used by the SDK (`core/address.ts` or equivalent). The escrow should import or reimplement `computeDirectAddress(chainPubkey) -> string`.

### 8.4 Escrow SwapRecord Extension

```typescript
interface SwapRecord {
  // ... existing fields ...

  /** Chain pubkeys of both parties (set on v2 announce) */
  party_a_chain_pubkey?: string;
  party_b_chain_pubkey?: string;
  /** Protocol version used for this swap */
  protocol_version: number;
}
```

### 8.5 DM Handler Changes

The escrow's DM handler:

1. Parses the announce DM as either v1 (no `version` field or `version: 1`) or v2.
2. For v2, extracts `signatures`, `chain_pubkeys`, and `auxiliary` before calling `orchestrator.announce()`.
3. Passes the additional fields to the orchestrator.

Updated method signature:

```typescript
async announce(
  manifest: SwapManifest,
  options?: {
    announcerNpub?: string;
    signatures?: ManifestSignatures;
    chainPubkeys?: { party_a: string; party_b: string };
    auxiliary?: ManifestAuxiliary;
  },
): Promise<AnnounceResult>;
```

---

## 9. Backward Compatibility

### 9.1 Version Negotiation Strategy

There is no negotiation. Both v1 and v2 are supported simultaneously:

- **v1 proposal + v1 acceptance + v1 announce:** Fully supported. The escrow accepts unsigned announces indefinitely (or until a configured cutoff date). V1 proposals use `sendAnnounce` (proposer announces to escrow after receiving acceptance).
- **v2 proposal + v2 acceptance + v2 announce:** Fully supported with signature verification. Only swaps with `protocolVersion === 2` use the Bob-announces path via `sendAnnounce_v2`.
- **v2 proposal -> v1 acceptor:** The v1 acceptor sees `version: 2` in the proposal. Since `version > 1` was previously rejected by the parser, a v1 acceptor ignores v2 proposals. This is acceptable -- both sides must be on v2 for v2 to work.
- **v1 proposal -> v2 acceptor:** The v2 acceptor can handle v1 proposals (version 1 parsing still works). The v2 acceptor falls back to v1 behavior (announces without signatures via `sendAnnounce`).

### 9.2 Parser Backward Compatibility

The `parseProposal` function accepts both versions:

```typescript
function parseProposal(json: string): ParsedSwapDM | null {
  // ... parse JSON ...
  // Reject unknown versions (accept 1, 2, or undefined which defaults to 1)
  const rawVersion = obj.version;
  if (rawVersion !== 1 && rawVersion !== 2 && rawVersion !== undefined) return null;
  const version = (rawVersion === 2 ? 2 : 1) as 1 | 2;

  // V2-specific fields
  if (version === 2) {
    if (typeof obj.proposer_signature !== 'string' || !SIG_RE.test(obj.proposer_signature)) return null;
    if (typeof obj.proposer_chain_pubkey !== 'string' || !PUBKEY_RE.test(obj.proposer_chain_pubkey)) return null;
  }
  // ...
}
```

### 9.3 Storage Backward Compatibility

New fields on `SwapRef` (`proposerSignature`, `acceptorSignature`, `auxiliary`, `protocolVersion`, `proposerChainPubkey`) are all optional. Existing persisted swap records load correctly -- missing fields default to `undefined`. The `protocolVersion` defaults to `1` for records without it.

### 9.4 Escrow Backward Compatibility

The escrow accepts v1 announces (no signatures) during the transition period. The `version` field in the announce DM determines the validation path:

- No `version` field or `version: 1`: v1 path (no signature checks).
- `version: 2`: v2 path (full signature verification).

### 9.5 Migration Timeline

1. **Phase 1:** Deploy escrow with v2 support (accepts both v1 and v2).
2. **Phase 2:** Release SDK with v2 as default for new proposals.
3. **Phase 3 (optional):** Escrow deprecates v1 announces (returns error for unsigned announces).

---

## 10. Security Analysis

### 10.1 Attacks Prevented by Manifest Signatures

**Attack: Unauthorized manifest announcement.**
An attacker intercepts Alice's proposal DM to Bob and announces the manifest to the escrow before Bob accepts. In v1, the escrow creates a deposit invoice. In v2, the escrow rejects the announce because it lacks valid signatures from both parties.

**Attack: Manifest forgery by relay operator.**
A malicious Nostr relay operator modifies the manifest in transit. In v1, the swap_id integrity check catches field modifications, but the escrow has no way to verify that the parties actually consented. In v2, forged signatures will not verify.

**Attack: Deposit invoice spam.**
An attacker sends thousands of announce DMs with fabricated manifests to exhaust escrow resources. In v2, the escrow rejects unsigned announces, making this attack infeasible without access to both parties' private keys.

### 10.2 Attacks Prevented by Direct Escrow Announce

**Attack: Proposal-drop denial of service.**
In v1, if an attacker controls the Nostr relay, they can drop Alice's acceptance DM, preventing the announce. In v2, Bob announces directly to the escrow after accepting, so Alice being offline or messages being dropped does not prevent the swap from proceeding.

**Attack: Alice-offline stall.**
In v1, if Alice goes offline after proposing, the swap stalls until she returns. In v2, Bob proceeds independently.

### 10.3 Attacks Prevented by Nametag Binding

**Attack: Nametag hijack.**
An attacker compromises the Nostr relay and publishes a new identity binding event for `@alice` pointing to the attacker's address. In v1, the manifest would resolve `@alice` to the attacker's address. In v2, the binding proof in the auxiliary data verifies that the original `@alice` holder signed the binding to a specific DIRECT address for this specific swap.

**Attack: Binding proof replay.**
An attacker captures a nametag binding proof from a previous swap and replays it. The binding message includes the `swap_id`, which is unique per swap (guaranteed by the random salt), so replay fails.

### 10.4 Remaining Attack Surfaces

**Signature key compromise.** If Alice's private key is compromised, an attacker can sign manifests on her behalf. This is inherent to any signature scheme and is mitigated by standard key management practices.

**DM confidentiality.** The proposal DM (containing Alice's signature) is encrypted via NIP-17. A compromised relay cannot read the signature. However, if the DM is decrypted by an attacker (key compromise), they obtain Alice's signature for that specific swap_id. This is not useful without Bob's signature.

**Escrow collusion.** The escrow sees both signatures and could potentially forge future swaps. However, signatures are over specific swap_ids (unique per salt) and bound to a specific escrow address, so a captured signature cannot be reused for a different swap or redirected to a different escrow.

**Race condition: dual announce.** If both Alice and Bob somehow send announce_v2 to the escrow (e.g., Alice runs a modified client), the escrow deduplicates by swap_id and returns the existing swap. No harm done.

### 10.5 Attacks Prevented by Domain-Prefixed Signatures

**Attack: Cross-protocol signature replay.**
An attacker obtains a signature produced by Alice for a swap and replays it in a different protocol context (e.g., Connect protocol's `sign_message` intent). The `"swap_consent:"` domain prefix ensures that swap signatures are syntactically distinct from any other signed message in the SDK. No other signing context produces messages with this prefix, so replay across protocols is impossible.

**Attack: Escrow redirect.**
An attacker intercepts a proposal DM and substitutes a different escrow address, hoping to route deposits to a malicious escrow. The signature includes the escrow address (`"swap_consent:{swap_id}:{escrow_address}"`), so the legitimate escrow's verification fails if the escrow address was changed. Additionally, the `escrow_address` is part of `ManifestFields` and thus included in the `swap_id` hash (section 4.1), so changing the escrow also changes the `swap_id`, invalidating the signature from a second angle.

### 10.6 Attacks Prevented by Mandatory Peer Resolution

**Attack: MITM pubkey substitution.**
An attacker relays a legitimate proposal but substitutes their own `proposer_chain_pubkey` in the DM, signing the manifest with their own key. In v1, the acceptor might accept a proposal without verifying the proposer's identity. In v2, the acceptor MUST resolve the proposer's `DIRECT://` address via `deps.resolve()` and verify that the returned `chainPubkey` matches the one in the proposal. If resolution fails (returns `null`), the proposal is rejected -- there is no fallback to trusting the self-declared pubkey. This ensures that an attacker cannot impersonate a proposer unless they also compromise the identity binding on the Nostr relay.

### 10.7 Protocol Downgrade Mitigation

**Attack: Version downgrade via manifest.**
An attacker strips the v2 fields from a proposal or announce and presents it as v1 to bypass signature verification. The `protocol_version` field is included in `ManifestFields` (section 4.1) and thus part of the `swap_id` hash. A v2 manifest produces a different `swap_id` than a v1 manifest with otherwise identical deal terms. If an attacker presents a v2 manifest as v1, the `swap_id` will not match the manifest fields (since the escrow recomputes it), causing validation failure. This makes manifest-level downgrade attacks structurally impossible.

**Attack: Acceptance DM downgrade.**
An attacker sends a v1-format acceptance (`version: 1`, no signature) for a v2 swap, hoping to bypass the signature verification step. The proposer's acceptance handler explicitly checks: if `swap.protocolVersion === 2`, it requires `acceptMsg.version === 2` with a valid `acceptor_signature` and `acceptor_chain_pubkey`. A v1 acceptance on a v2 swap is silently rejected. Critically, this rejection happens WITHOUT clearing the proposal timer -- if an attacker sends a downgraded acceptance, the proposal timeout still fires, eventually transitioning the swap to `failed`. This prevents a denial-of-service where a bad actor sends a v1 acceptance to disarm the timer and strand the swap indefinitely in `proposed` state.

### 10.8 Salt and Manifest Replay Prevention

**Attack: Identical manifest replay across proposals.**
Without a salt, if Alice proposes the exact same deal twice (same parties, amounts, currencies, timeout), both proposals would produce the same `swap_id`. An attacker who captured signatures from the first swap could replay them for the second. The `salt` field -- 32 hex chars generated by `randomHex(16)` at manifest construction time -- ensures every proposal produces a unique `swap_id` regardless of deal terms. This makes signature replay across proposals impossible.

### 10.9 Timer and State Transition Safety

**Invariant: timer cleared only after all validation passes.**

The proposal watchdog timer is a critical safety mechanism -- it ensures that a `proposed` swap eventually transitions to `failed` if no valid acceptance arrives. The acceptance handler is structured so that `clearLocalTimer(swapId)` is called ONLY after:

1. Version check passes (v2 swap requires v2 acceptance).
2. Signature verification passes (valid `acceptor_signature` against correct chain pubkey and escrow address).

If any check fails, the handler returns early without touching the timer. This prevents a class of attacks where a malformed or partially-valid acceptance DM could disarm the watchdog without actually completing a valid acceptance.

### 10.10 Partial-Write Recovery

**Invariant: in-memory state is consistent with storage even on storage failure.**

The `transitionProgress` method mutates `swap.progress` in memory BEFORE calling `persistSwap`. If `persistSwap` throws (e.g., IndexedDB quota exceeded, file write failure), the in-memory state would diverge from the persisted state. The acceptance handler addresses this with rollback:

```
1. Save prevProgress = swap.progress, prevUpdatedAt = swap.updatedAt
2. Try: transitionProgress(swap, 'accepted')
3. Catch:
   a. swap.progress = prevProgress       // roll back in-memory
   b. swap.updatedAt = prevUpdatedAt
   c. startProposalTimer(swapId)          // re-arm watchdog
   d. persistSwap(swap).catch(...)        // best-effort: heal partial write
   e. Re-throw the error
```

This ensures the swap remains visibly `proposed` in memory, the proposal timer can still fire, and any partial storage write (e.g., record written but index update failed) is healed on a best-effort basis.

### 10.11 Signature Scheme Security Properties

| Property | Status |
|---|---|
| Existential unforgeability | Provided by secp256k1 ECDSA |
| Non-repudiation | Party cannot deny signing swap consent message |
| Binding commitment | swap_id commits to all deal terms (incl. escrow address, protocol version, salt) via SHA-256 |
| Domain separation | `"swap_consent:"` prefix prevents cross-protocol replay |
| Escrow binding | Signature includes escrow address; escrow address also in swap_id hash (double-bound) |
| Replay prevention | Salt in manifest ensures unique swap_id; binding messages include swap_id |
| Downgrade prevention (manifest) | `protocol_version` in ManifestFields ensures v2 swap_id differs from v1 |
| Downgrade prevention (acceptance) | v1 acceptance explicitly rejected on v2 swap; timer NOT cleared |
| Forward secrecy | Not applicable (signatures are non-secret attestations) |

---

## Appendix A: Function Signature Summary

### Functions in `modules/swap/manifest.ts`

```typescript
export function computeSwapId(fields: ManifestFields): string;
export function buildManifest(resolvedPartyA: string, resolvedPartyB: string, deal: SwapDeal, timeout: number, escrowAddress?: string): SwapManifest;
export function validateManifest(manifest: SwapManifest): { valid: boolean; errors: string[] };
export function verifyManifestIntegrity(manifest: SwapManifest): boolean;
export function signSwapManifest(privateKey: string, swapId: string, escrowAddress: string): string;
export function verifySwapSignature(swapId: string, escrowAddress: string, signature: string, chainPubkey: string): boolean;
export function createNametagBinding(privateKey: string, nametag: string, directAddress: string, swapId: string, chainPubkey: string): NametagBindingProof;
export function verifyNametagBinding(proof: NametagBindingProof, swapId: string): boolean;
```

### V2 functions in `modules/swap/dm-protocol.ts`

```typescript
export function buildProposalDM_v2(manifest: SwapManifest, escrow: string, proposerSignature: string, proposerChainPubkey: string, auxiliary?: ManifestAuxiliary, message?: string): string;
export function buildAcceptanceDM_v2(swapId: string, acceptorSignature: string, acceptorChainPubkey: string): string;
export function buildAnnounceDM_v2(manifest: SwapManifest, signatures: ManifestSignatures, chainPubkeys: { party_a: string; party_b: string }, auxiliary?: ManifestAuxiliary): string;
```

### V2 function in `modules/swap/escrow-client.ts`

```typescript
export async function sendAnnounce_v2(
  communications: SwapModuleDependencies['communications'],
  escrowPubkey: string,
  manifest: SwapManifest,
  signatures: ManifestSignatures,
  chainPubkeys: { party_a: string; party_b: string },
  auxiliary?: ManifestAuxiliary,
): Promise<void>;
```

### Types in `modules/swap/types.ts`

```typescript
export interface ManifestFields { ... }         // includes salt, escrow_address?, protocol_version?
export interface SwapManifest { ... }           // ManifestFields + swap_id
export interface ManifestSignatures { ... }
export interface ManifestAuxiliary { ... }
export interface NametagBindingProof { ... }
export interface SwapProposalMessage { ... }    // version: 1 | 2
export interface SwapAcceptanceMessage { ... }  // version: 1 | 2
```

---

## Appendix B: Escrow announce() Updated Flow

```
1. Parse DM -> extract version, manifest, signatures?, chain_pubkeys?, auxiliary?
2. Validate manifest (existing validateManifest)
3. If version === 2:
   a. Require signatures.party_a AND signatures.party_b
   b. Require chain_pubkeys.party_a AND chain_pubkeys.party_b
   c. Verify chain_pubkeys.party_a -> derives to manifest.party_a_address
   d. Verify chain_pubkeys.party_b -> derives to manifest.party_b_address
   e. Verify signatures.party_a via verifySwapSignature(swap_id, escrow_own_address, sig, chain_pubkeys.party_a)
   f. Verify signatures.party_b via verifySwapSignature(swap_id, escrow_own_address, sig, chain_pubkeys.party_b)
   g. If auxiliary.party_a_binding: verify nametag binding
   h. If auxiliary.party_b_binding: verify nametag binding
   i. Any failure -> return { type: 'error', error: '...', swap_id }
4. Check for existing swap (deduplicate by swap_id)
5. Resolve party addresses (existing)
6. Create swap record with protocol_version, chain pubkeys
7. Create deposit invoice (existing)
8. Return announce_result (existing format)
```

---

## Appendix C: Validation Rules Summary

| Field | Rule |
|---|---|
| `swap_id` | 64 lowercase hex chars (`/^[0-9a-f]{64}$/`) |
| `party_a_address` | Valid Unicity address (DIRECT://, PROXY://, or @nametag) |
| `party_b_address` | Valid address, differs from `party_a_address` |
| `party_a_currency_to_change` | 1-20 alphanumeric chars (`/^[A-Za-z0-9]{1,20}$/`) |
| `party_b_currency_to_change` | 1-20 alphanumeric chars, differs from `party_a_currency_to_change` |
| `party_a_value_to_change` | Positive integer string, no leading zeros (`/^[1-9][0-9]*$/`) |
| `party_b_value_to_change` | Positive integer string, no leading zeros |
| `timeout` | Integer in [60, 86400] |
| `salt` | 32 lowercase hex chars (`/^[0-9a-f]{32}$/`) |
| `escrow_address` | Valid DIRECT:// address (required when `protocol_version === 2`) |
| `protocol_version` | Must be `2` when present |
| `proposer_signature` (DM) | 130 lowercase hex chars (`/^[0-9a-f]{130}$/`) |
| `proposer_chain_pubkey` (DM) | 66 hex chars, `02` or `03` prefix (`/^(02\|03)[0-9a-f]{64}$/`) |
