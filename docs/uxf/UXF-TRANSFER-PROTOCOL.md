# UXF Inter-Wallet Transfer Protocol

> **Status**: SPEC — implementation pending.
> **Cross-references**: PROFILE-ARCHITECTURE.md §10.10 (storage role of UXF), §10.11 (token statuses), §10.12 (outbox); SPECIFICATION.md (UXF DAG); UnicityLabs state-transition-sdk (transaction primitives).

---

## 1. Scope and Goals

This document defines the wire-level protocol by which one Sphere wallet transmits one or more tokens to another wallet, using **UXF bundles as the default inter-wallet wire format**. The legacy per-token TXF JSON over Nostr remains available as a permanent explicit opt-in mode (sender chooses per call). It specifies:

1. The three transfer modes — **Conservative** (sender awaits oracle finalization before send), **Instant** (default — sender ships an unfinalized commitment; both parties finalize asynchronously), and **TXF** (legacy per-token JSON; explicit opt-in only).
2. The wire payload variants for UXF modes — **CAR-embedded** (small bundles, default cap 16 KiB) and **CID-referenced** (large bundles pinned to IPFS), with per-call sender overrides.
3. The sender-side state machine, including outbox semantics for the instant-mode follow-up finalization.
4. The recipient-side **disposition decision matrix** — what happens to each token in the received bundle under every meaningful combination of (chain validity, predicate target, finalization status, oracle spent state).
5. The async-finalization workers on both sides, plus convergence guarantees when sender and recipient finalize independently.
6. Replay / duplicate handling.
7. Permanent acceptance of legacy wire shapes — the recipient indefinitely accepts `{sourceToken, transferTx}`, V6 `COMBINED_TRANSFER`, and INSTANT_SPLIT bundles without deprecation; the sender uses these only when explicitly requested via `transferMode: 'txf'`.

### 1.1 Non-goals

- Aggregator-scan-based discovery of inbound transfers (the recipient relies on the Nostr TOKEN_TRANSFER event; if delivery fails permanently, recovery is out of scope here).
- Refund / reversal protocol on instant-mode finalization failure (spec deferred — see §9.4).
- Cross-chain or cross-network transfers.

---

## 2. Transfer Modes

Sphere supports three delivery modes; the choice is per-`send()` call. The default is `'instant'` (see §2.4).

### 2.1 Instant Mode (default)

The sender submits the commitment to the aggregator but **does not await the proof**. The bundle contains the transaction with `inclusionProof: null` PLUS the **fully signed transfer-tx** (the recipient cannot construct the signed transaction itself — only the source-state owner can sign — so the bundle MUST carry it). Both sender and recipient run independent async finalization workers that retrieve the proof later, attach it locally, and converge on the finalized state.

> **Why the bundle MUST carry the signed tx in instant mode**: the recipient is fully capable of polling the aggregator for the inclusion proof on its own (the commitment requestId is derived from the signed tx + source state — the recipient computes it locally). What the recipient **cannot** do is produce the signed tx for the sender; only the source-state owner can sign. So shipping the signed-but-unproven tx in the bundle is what makes asynchronous independent finalization possible.

```
Sender                      Aggregator                   Recipient
  │                              │                            │
  │ submit commitment            │                            │
  ├─────────────────────────────▶│                            │
  │ ◀── 200 OK (no proof yet) ───┤                            │
  │                              │                            │
  │ build UXF bundle with        │                            │
  │  signed transfer-tx,         │                            │
  │  inclusionProof: null        │                            │
  │                              │                            │
  │ send TOKEN_TRANSFER ─────────────────────────────────────▶│
  │                              │                            │
  │                              │      merge as 'pending'    │
  │                              │                            │
  │ async finalize worker        │      async finalize worker │
  │  fetch proof ◀──────────────▶│ ◀───── fetch proof         │
  │  attach proof                │       attach proof         │
  │  status: confirmed           │       status: valid        │
  │                              │                            │
```

**Recipient guarantee:** the bundle is structurally validated, the chain is verified (modulo the unproven last transaction), and the predicate target is checked. The token enters the recipient's pool with status `'pending'` and counts toward "incoming" balance views, but **does not count toward spendable balance** until finalization completes.

**Sender cost:** zero finalization latency. Sender's outbox carries a `pending-finalization` entry until the proof is retrieved.

### 2.2 Conservative Mode

The sender submits the transfer commitment to the aggregator and **awaits the inclusion proof** before constructing the UXF bundle. The bundle therefore contains a **fully finalized** transaction (with `inclusionProof` element + valid `unicityCertificate`).

```
Sender                      Aggregator                   Recipient
  │                              │                            │
  │ submit commitment            │                            │
  ├─────────────────────────────▶│                            │
  │                              │                            │
  │ ◀── inclusion proof ─────────┤                            │
  │                              │                            │
  │ build UXF bundle (with proof)│                            │
  │                              │                            │
  │ send TOKEN_TRANSFER ─────────────────────────────────────▶│
  │                              │                            │
  │                              │       merge as 'valid'     │
  │                              │                            │
```

**Recipient guarantee:** every token arriving in conservative mode is already finalizable by chain replay; no oracle round-trip is required to reach the `valid` status (only an `isSpent` check on the destination state).

**Sender cost:** one round-trip latency to the aggregator before send (typically 1–3 seconds).

### 2.3 TXF Mode (legacy, explicit opt-in)

The sender ships one Nostr `TOKEN_TRANSFER` event **per token** using the legacy `{sourceToken, transferTx}` payload (or the V6 `COMBINED_TRANSFER` shape if the SDK selects it). No UXF bundle is constructed. This mode exists for:

- Peers that have not yet upgraded to UXF-aware code paths.
- Diagnostic / forensic transfers where the operator wants to bypass the bundle layer.
- Backward-compatibility regression coverage.

**TXF is permanent**, not deprecated. Recipients indefinitely accept the legacy shapes. Senders use TXF only when the caller explicitly passes `transferMode: 'txf'` — there is no automatic fallback (capability detection is informational, never coercive).

**TXF lacks the multi-token bundle benefit** — N tokens means N events. Use only when the caller has a deliberate reason.

### 2.4 Mode Selection

- **Default**: `'instant'` mode for most transfers — minimizes UX latency.
- **Caller override**: `PaymentsModule.send({transferMode: 'instant' | 'conservative' | 'txf'})`.
  - `'instant'` (default): UXF bundle, async finalization (§2.1).
  - `'conservative'`: UXF bundle, finalization-before-send (§2.2). Recommended for high-value transfers, escrow, swap deposits.
  - `'txf'`: legacy per-token JSON (§2.3). Explicit opt-in only.
- **Forced conservative**: certain compound flows (split-then-send a finalized output to a third party, cross-protocol bridging) MUST use conservative mode regardless of caller preference; the implementation enforces this at the call site by overriding `'instant'` → `'conservative'` and surfacing the override in the call result.
- **No automatic instant→txf fallback**: capability hints from the recipient's identity binding event are informational. If a UXF-mode send fails because the recipient cannot decode UXF, the call fails with a typed error; the caller must explicitly retry with `transferMode: 'txf'`.

---

## 3. Wire Format

Every inter-wallet transfer uses Nostr `TOKEN_TRANSFER` events (existing event kind). The encrypted content is a JSON document conforming to the **discriminated `UxfTransferPayload`** type below.

### 3.1 `UxfTransferPayload` discriminated union

```typescript
type UxfTransferPayload =
  | UxfTransferPayloadCar
  | UxfTransferPayloadCid
  | LegacyTokenTransferPayload;     // §3.4 backward compat

interface UxfTransferPayloadBase {
  /** Discriminator — every UXF payload carries 'uxf' as kind prefix. */
  readonly kind: 'uxf-car' | 'uxf-cid';
  /** Protocol version of THIS payload schema. Increment on breaking changes. */
  readonly version: '1.0';
  /** Transfer mode used by the sender. */
  readonly mode: 'conservative' | 'instant';
  /** Bundle CID (always present — even for CAR delivery, used for dedup). */
  readonly bundleCid: string;
  /** Token IDs the sender claims are in this bundle. The recipient verifies. */
  readonly tokenIds: readonly string[];
  /** Optional sender-supplied memo. */
  readonly memo?: string;
  /** Sender identity (optional — for UI display + nametag resolution). */
  readonly sender?: {
    readonly transportPubkey: string;
    readonly nametag?: string;
  };
}

interface UxfTransferPayloadCar extends UxfTransferPayloadBase {
  readonly kind: 'uxf-car';
  /** Base64-encoded CAR bytes. SIZE-CAPPED at MAX_INLINE_CAR_BYTES (default 16 KiB; per-call override allowed). */
  readonly carBase64: string;
}

interface UxfTransferPayloadCid extends UxfTransferPayloadBase {
  readonly kind: 'uxf-cid';
  /** No inline bytes — recipient fetches from IPFS via gateway list. */
  /** Optional gateway hint set the sender used (informational). */
  readonly senderGateways?: readonly string[];
}
```

### 3.2 `kind: 'uxf-car'` — small bundles

Used when the assembled CAR fits under `MAX_INLINE_CAR_BYTES` (default **16 KiB**, per-call override allowed — see §3.3). The CAR bytes are base64-encoded into the Nostr event content. No IPFS round-trip required.

**Recipient action**: base64-decode → `UxfPackage.fromCar(bytes)`. CAR root CID MUST equal `payload.bundleCid` (sender lied → reject).

### 3.3 `kind: 'uxf-cid'` — large bundles, plus per-call delivery overrides

Used when the CAR exceeds the inline cap. Sender pins the CAR to IPFS, then sends ONLY the CID over Nostr.

**Recipient action**: `fetchCarFromGateway(payload.bundleCid)` via the same verified-CAR pipeline already established for IPNS-reader migration (Wave G.5 / I.b). The verified CAR is then loaded via `UxfPackage.fromCar(bytes)`.

**Gateway resilience**: the recipient walks its own configured gateway list; `senderGateways` is informational only (a hostile sender could lie). The Wave G.5 verifier ensures gateway-served bytes hash correctly against the requested CID.

#### 3.3.1 Per-call sender overrides

By default the sender selects `'uxf-car'` if `carBytes.length <= 16 KiB` else `'uxf-cid'`. The caller MAY override this on a per-`send()` basis:

```typescript
type DeliveryStrategy =
  | { kind: 'auto'; inlineCapBytes?: number }   // default; cap defaults to 16 KiB
  | { kind: 'force-inline' }                    // always uxf-car (errors if too large for the relay's max event size)
  | { kind: 'force-cid' };                      // always uxf-cid even for tiny bundles
```

`PaymentsModule.send({transferMode: 'instant', delivery: {...}})`:
- `delivery: { kind: 'auto' }` (default if omitted) — 16 KiB cutoff.
- `delivery: { kind: 'auto', inlineCapBytes: 32_768 }` — auto with custom cutoff.
- `delivery: { kind: 'force-inline' }` — sender insists on inline regardless of size; if the resulting Nostr event exceeds the relay's max payload, the send fails with `INLINE_CAR_TOO_LARGE`.
- `delivery: { kind: 'force-cid' }` — sender insists on pinning even for tiny bundles (e.g., when the receiver is known to be storage-constrained or when the operator wants every bundle indexed by CID for audit).

**Hard upper bound**: regardless of `inlineCapBytes`, the implementation enforces a relay-safe ceiling (currently 96 KiB; configurable per-transport). Above the ceiling, `force-inline` is rejected up-front before the bundle is even built.

### 3.4 TXF (legacy) wire shape

`'txf'` mode does NOT use `UxfTransferPayload`. The sender emits one Nostr `TOKEN_TRANSFER` event per token with the existing legacy payload shapes:

- `{sourceToken, transferTx, memo?, sender?}` — Sphere TXF (current default in the codebase pre-this-spec).
- `{type: 'COMBINED_TRANSFER', version: '6.0', ...}` — V6 multi-token combined.
- `{type: 'INSTANT_SPLIT', version: '4.0' | '5.0', ...}` — split-output transfers.
- `{token, proof}` — SDK legacy shape.

Recipients indefinitely accept all of the above (see §10). Senders only emit them when `transferMode: 'txf'` is explicitly set.

---

## 4. Sender Flow

### 4.1 Bundle construction (common to both modes)

Inputs: `tokens: Token[]` (selected for transfer), `recipient: PeerInfo`, `transferMode: 'conservative' | 'instant'`.

1. **Validate inputs**:
   - All tokens MUST be currently owned (current state predicate binds to sender).
   - Tokens MUST belong to the same coinId iff this is a fungible transfer (multi-coin bundles allowed but treated as separate units).
   - Total amount sums match the requested transfer amount.

2. **Compute splits** (if needed): if a single token's amount exceeds the transfer amount, split into `{tokenForRecipient, changeToken}` per existing split logic.

3. **For each token destined to the recipient**, build a `TransferTransaction` (SDK primitive):
   - `sourceState`: token's current state.
   - `recipient`: recipient's destination address.
   - `salt`: fresh random.
   - `recipientDataHash`: optional, per request.
   - **Submit commitment** to the aggregator:
     - **Conservative mode**: `await waitInclusionProof(...)` → attach proof to transaction.
     - **Instant mode**: submit and **do not await proof** — transaction's `inclusionProof` stays `null`.

4. **Construct UXF bundle**: `UxfPackage.create()` then `pkg.ingestAll(transferredTokens)`. The package's element pool will contain the dependency DAGs (genesis, all prior transactions with proofs, predicates, certs, nametag refs) plus the new transaction. In **conservative mode**, the new transaction's `inclusionProof` child resolves to a real `inclusion-proof` element with valid `authenticator` + `merkleTreePath` + `unicityCertificate`. In **instant mode**, the transaction's `inclusionProof` child is `null`.

5. **Serialize**: `const carBytes = await pkg.toCar();`.

6. **Choose delivery** (per §3.3.1):
   - `delivery: { kind: 'auto', inlineCapBytes? }` (default; `inlineCapBytes` defaults to **16 KiB**) — if `carBytes.length <= inlineCapBytes` → `kind: 'uxf-car'`; else pin to IPFS via `IpfsHttpClient.pin(carBytes)` → CID → `kind: 'uxf-cid'`.
   - `delivery: { kind: 'force-inline' }` — always `kind: 'uxf-car'`. If `carBytes.length` exceeds the relay-safe ceiling, abort with `INLINE_CAR_TOO_LARGE` before publishing.
   - `delivery: { kind: 'force-cid' }` — always pin and use `kind: 'uxf-cid'`, regardless of size.

7. **Compute `bundleCid`**: extract the CAR root CID via `extractCarRootCid(carBytes)`. This is the canonical bundle identity.

8. **Build payload**:
```typescript
const payload: UxfTransferPayload = {
  kind: deliveryKind,
  version: '1.0',
  mode: transferMode,
  bundleCid,
  tokenIds: transferredTokens.map(t => t.genesisTokenId),
  memo,
  sender: { transportPubkey, nametag },
  ...(deliveryKind === 'uxf-car' ? { carBase64: base64(carBytes) } : {}),
};
```

9. **Persist outbox entry** (BEFORE send, see §7).

10. **Send**: `await transport.sendTokenTransfer(recipientPubkey, payload)`. On success, mark outbox `delivered`. On failure, mark `failed` and schedule retry.

11. **Apply local state update**:
    - **Conservative mode**: the sender's source token is updated to its new state (sender no longer owns it). Token status: `archived`.
    - **Instant mode**: the sender's source token has the unproven transaction appended; status: `pending` until the async finalizer attaches the proof.

### 4.2 Conservative mode — full sequence diagram

```
1.  caller → PaymentsModule.send({recipient, amount, mode: 'conservative'})
2.  PaymentsModule:  build commitment(s), submit to aggregator
3.  PaymentsModule:  await inclusionProof(s)
4.  PaymentsModule:  build UxfPackage with finalized transaction(s)
5.  PaymentsModule:  serialize CAR; choose CAR-embed or CID-pin
6.  PaymentsModule:  persist outbox entry (status: 'sending')
7.  Transport:       send Nostr TOKEN_TRANSFER event with payload
8.  PaymentsModule:  mark outbox 'delivered'
9.  PaymentsModule:  archive sender's source tokens (now spent)
10. PaymentsModule:  emit transfer:confirmed event
```

### 4.3 Instant mode — full sequence diagram

```
1.  caller → PaymentsModule.send({recipient, amount, mode: 'instant'})
2.  PaymentsModule:  build commitment(s), submit to aggregator (no await)
3.  PaymentsModule:  build UxfPackage with UNPROVEN transaction(s)
4.  PaymentsModule:  serialize CAR; choose CAR-embed or CID-pin
5.  PaymentsModule:  persist outbox entry (status: 'sending-instant',
                       includes commitmentRequestIds for later finalization)
6.  Transport:       send Nostr TOKEN_TRANSFER event with payload
7.  PaymentsModule:  mark outbox 'delivered-instant'
8.  PaymentsModule:  apply unproven transaction to sender's local copy;
                     mark sender's tokens 'pending'
9.  PaymentsModule:  emit transfer:submitted event
                     (NOT 'confirmed' — pending finalization)
10. (async) FinalizationWorker:
                     periodically poll aggregator for outstanding requestIds;
                     on proof retrieval: attach to local pool; mark
                     sender's tokens 'archived'; mark outbox 'finalized';
                     emit transfer:confirmed event
```

### 4.4 TXF mode — sequence (legacy opt-in)

```
1.  caller → PaymentsModule.send({recipient, amount, transferMode: 'txf'})
2.  PaymentsModule:  for each token, build {sourceToken, transferTx} (or
                     COMBINED_TRANSFER / INSTANT_SPLIT shape per existing
                     SDK selection logic) — finalization same as conservative
                     UXF (await proof). Instant variant of TXF is NOT supported.
3.  PaymentsModule:  persist outbox entry per-token (mode: 'txf',
                     deliveryMethod: 'txf-legacy', bundleCid: synthetic
                     'txf-' + tokenId)
4.  Transport:       send one Nostr TOKEN_TRANSFER event PER TOKEN
5.  PaymentsModule:  mark each outbox entry 'delivered'
6.  PaymentsModule:  archive sender's source tokens
7.  PaymentsModule:  emit transfer:confirmed event(s)
```

TXF mode does NOT support instant-style async finalization. The signed transferTx is published over Nostr only after the inclusion proof is in hand. (This preserves the legacy flow's behavior.)

### 4.5 Outbox tracking (see §7 for schema)

The outbox is **bundle-grained** for UXF modes (one entry per UXF bundle, covering N tokens) — not per-token as in the legacy code. This matches PROFILE-ARCHITECTURE.md §10.12. For TXF mode the outbox falls back to one entry per token.

In **conservative mode**, the outbox entry is short-lived: created at step 6, marked `delivered` at step 8, optionally garbage-collected immediately or retained for a configurable window for delivery acknowledgments.

In **instant mode**, the outbox entry persists until finalization completes. It carries the list of `commitmentRequestIds` so the async finalizer knows which proofs to fetch.

In **TXF mode**, the outbox entry is per-token and short-lived (same lifecycle as conservative but with `deliveryMethod: 'txf-legacy'` and `bundleCid: 'txf-' + tokenId`).

---

## 5. Recipient Flow

### 5.1 Bundle acquisition

Trigger: Nostr TOKEN_TRANSFER event arrives at `transport.handleTokenTransfer(...)`. Decrypted content parses to a `UxfTransferPayload`.

```
Recipient                                         IPFS (if CID delivery)
   │                                                       │
   │ Nostr event arrives                                   │
   │                                                       │
   │ decrypt → payload                                     │
   │                                                       │
   │ if kind === 'uxf-cid':                                │
   │   fetch CAR via verified gateway pipeline ───────────▶│
   │   ◀─ CAR bytes (verified hash) ───────────────────────┤
   │ else (kind === 'uxf-car'):                            │
   │   carBytes = base64Decode(payload.carBase64)          │
   │                                                       │
   │ verify CAR root CID === payload.bundleCid             │
   │                                                       │
   │ pkg = UxfPackage.fromCar(carBytes)                    │
   │                                                       │
```

**Replay defense**: the recipient maintains a bounded LRU set of recently-processed `bundleCid` values (default 256). A duplicate bundleCid is acknowledged but not re-processed.

### 5.2 Bundle verification

Before per-token disposition, the recipient performs **bundle-level checks**:

1. **`pkg.verify()`** — UXF DAG integrity (Wave F's verify.ts, depth/pool caps, cycle detection).
2. **CAR root CID match** — `bundleCid === extractCarRootCid(carBytes)`. Sender lying about which CID their CAR represents → reject the entire bundle.
3. **Token ID claim consistency** — `payload.tokenIds` MUST be a subset of `[...pkg.manifest.tokens.keys()]`. Sender claiming tokens not actually in the bundle → reject. The bundle MAY contain MORE tokens than `tokenIds` declares (sub-DAG dependencies), but every claimed ID must be present.

If any bundle-level check fails, the entire bundle is rejected with a typed `BUNDLE_REJECTED` error; nothing is imported. This is logged and surfaced as a `transfer:rejected` event.

### 5.3 Per-token disposition — THE DECISION MATRIX

For each `tokenId` in `payload.tokenIds`, the recipient walks the following decision tree. Each branch leads to a specific `disposition` outcome with a specific storage action.

```
For each tokenId in bundle:
│
├─[A]─ Structural validation
│        Resolve manifest entry → root token-root element exists in pool?
│        Walk DAG: type tags valid, hashes match, predecessor links consistent.
│        ├─ FAIL → disposition: STRUCTURAL_INVALID
│        └─ PASS → continue
│
├─[B]─ Genesis predicate target
│        Decode genesis.data.recipient (for nametag) OR
│        check genesis predicate binds to recipient identity.
│        ├─ FAIL (genesis was minted to someone else, never targeted us) →
│        │   disposition: NEVER_MINE   (quarantine, not active inventory)
│        └─ PASS → continue
│
├─[C]─ Last-state predicate target
│        After applying all transactions in the chain (with proofs where
│        present, structural-only where absent), what's the current state?
│        Does its predicate bind to recipient?
│        ├─ FAIL (token was once mine but transferred to someone else) →
│        │   disposition: NO_LONGER_MINE   (quarantine)
│        ├─ FAIL (never targeted us at any point — sender misdirected) →
│        │   disposition: NEVER_MINE   (quarantine)
│        └─ PASS → continue
│
├─[D]─ Last-transaction finalization status
│        Inspect the last transaction in the chain.
│        ├─ Has inclusionProof element AND proof verifies against trustBase →
│        │   FINALIZED → continue to [E]
│        ├─ Has inclusionProof element BUT proof verification fails
│        │   (PATH_INVALID, NOT_AUTHENTICATED) →
│        │   disposition: PROOF_INVALID   (preserved, marked invalid)
│        └─ inclusionProof === null →
│            UNFINALIZED → continue to [F] (skip [E])
│
├─[E]─ Spent-check (oracle) — only for FINALIZED tokens
│        oracle.isSpent(currentDestinationStateHash)?
│        ├─ TRUE → token already spent (double-send / stale) →
│        │   disposition: SPENT   (preserved, marked invalid)
│        └─ FALSE → continue to [G]
│
├─[F]─ UNFINALIZED token (Instant-mode arrival, sender hasn't proved yet)
│        Sender mode: payload.mode === 'instant' EXPECTED.
│        Sender mode: payload.mode === 'conservative' UNEXPECTED (protocol violation —
│        log warning, treat as instant-mode).
│        Verify: source state IS the genesis or an earlier-recipient-or-sender
│                state (chain integrity holds even if last TX unproven).
│        Verify: last transaction is signed by the previous state's owner
│                (authenticator-presence check; full crypto verify deferred).
│        ├─ Source state authority intact → disposition: PENDING
│        └─ Source state authority broken → disposition: PROOF_INVALID
│
├─[G]─ Conflict check
│        Does our local pool already have a token with this tokenId?
│        ├─ YES, identical chain → no-op (idempotent receive)
│        ├─ YES, different chain — invoke resolveTokenRoot (Rule 3/4 JOIN
│        │   with verifiedProofs from the new bundle) →
│        │   disposition: CONFLICTING   (per-tokenId divergent)
│        └─ NO → disposition: VALID
│
└─[H]─ Final disposition recorded; storage action per §5.4.
```

### 5.4 Storage outcomes

| Disposition | Active inventory? | Counts in balance? | Storage location | Surfaces in UI |
|---|---|---|---|---|
| `VALID` | Yes | Spendable | active token pool, `manifest.status='valid'` | Wallet inventory |
| `PENDING` | Yes | Incoming (not spendable) | active token pool, `manifest.status='pending'`, finalization queued | Wallet inventory with "pending" badge |
| `PROOF_INVALID` | No | No | `_invalid` collection (per-entry-key `${addr}.invalid.${tokenId}`), reason='proof-invalid' | Investigation view |
| `STRUCTURAL_INVALID` | No | No | `_invalid` collection, reason='structural' | Investigation view |
| `SPENT` | No | No | `_invalid` collection, reason='spent', captured for forensics | Investigation view |
| `CONFLICTING` | Yes (winner) | Spendable iff resolved | active pool, `manifest.status='conflicting'` + `conflictingHeads[]` | Conflict-resolution view |
| `NEVER_MINE` | No | No | quarantine collection (`${addr}.received-not-mine.${bundleCid}`), reason='never-targeted' | Debug view (off by default) |
| `NO_LONGER_MINE` | No | No | quarantine collection, reason='archived-elsewhere' | Debug view |

**Quarantine retention**: 30 days, then GC. The quarantine is intentionally inspectable so an operator investigating a misrouted transfer or a suspected attack can see what arrived.

**`_invalid` retention**: indefinite by default; user can manually `cleanupInventory()` to clear.

### 5.5 Per-token finalization (Instant mode landing path)

When a `PENDING` token enters the pool, an entry is added to a per-address **finalization queue**:

```typescript
interface FinalizationQueueEntry {
  tokenId: string;
  bundleCid: string;            // for cross-reference
  commitmentRequestId: string;  // what to ask the aggregator for
  submittedAt: number;          // for backoff scheduling
  retryCount: number;
  source: 'sent' | 'received';  // sender vs recipient finalization
}
```

The recipient's finalization worker (see §6) polls the aggregator for each pending requestId. On proof retrieval:

1. The proof is content-hashed and added to the pool as an `inclusion-proof` element.
2. The pending transaction's `inclusionProof` child is updated from `null` to the new proof's ContentHash. (This re-hashes the transaction → re-hashes the token-root.)
3. Per Wave H canonicalization, the re-hashed root is the canonical hash; the previous "pending" root hash is removed from the manifest (with tombstone).
4. `manifest[tokenId].status` transitions `pending → valid` (or `pending → invalid` if the proof verifies as PATH_INVALID).
5. `transfer:incoming` is re-emitted with the `confirmed` flag set.

### 5.6 Replay / duplicate handling

- Same `bundleCid` arrives twice: second is acknowledged silently (idempotent).
- Same `bundleCid`, different `payload.mode` claimed: protocol violation — log warning, process per the FIRST-seen mode.
- Same `tokenId` arrives in TWO bundles from different senders: handled by the `[G]` conflict check; resolveTokenRoot decides.
- Same `tokenId` arrives in a fresh bundle while a `PENDING` entry from an earlier delivery is still queued: if the new bundle has a finalized version, we promote (proof attached); if both are unfinalized, the bundles are equivalent (or one extends the other; longest-valid wins).

---

## 6. Asynchronous Finalization

Both the **sender** (for instant-mode-sent tokens) and the **recipient** (for any pending tokens) run finalization workers. The two workers are independent — they do not coordinate — and the protocol is designed so they converge to the same valid local state without exchanging messages.

### 6.1 Sender-side finalization worker

Trigger: outbox entry with `status: 'delivered-instant'` and one or more outstanding `commitmentRequestIds`.

Loop (default poll: 30s with exponential backoff up to 5 min):

```
For each pending requestId in outbox.commitmentRequestIds:
   try fetchInclusionProof(requestId):
     proof.verify(trustBase, requestId):
       OK → attach proof to local source token (now archived);
            remove requestId from outbox; update outbox status
       NOT_AUTHENTICATED / PATH_INVALID →
            mark token 'invalid'; alert operator (oracle rejection or
            forged proof — needs investigation); clear from outbox
       PATH_NOT_INCLUDED →
            commitment was rejected by aggregator (e.g. source already
            spent). Token is invalid. Mark and alert.
     no response (transient) →
            increment retryCount; reschedule with backoff
```

Outbox terminal states: `finalized` (proof attached, all done), `failed-permanent` (oracle rejection), `failed-transient` (max retries exhausted — operator intervention required).

### 6.2 Recipient-side finalization worker

Same logic as 6.1 but driven from the per-address finalization queue (§5.5) rather than the outbox.

For each pending tokenId in the recipient's finalization queue:
- Fetch proof for the relevant requestId.
- On success: update local pool per §5.5 step 1-4; remove from queue.
- On rejection: mark token `PROOF_INVALID` per §5.4; remove from queue.
- On transient: backoff and retry.

### 6.3 Convergence guarantees

**Claim**: a instant-mode transfer that succeeds at the aggregator will eventually transition to `valid` on BOTH sender and recipient, with both pools containing the same finalized token-root hash.

**Proof sketch**:
1. The aggregator publishes the proof for `requestId R` exactly once. (Idempotency of `getInclusionProof`.)
2. Both finalizers fetch `R` independently. Both attach the SAME `inclusion-proof` element (content-hashed identically).
3. Both re-hash the transaction with the new proof — IDENTICAL content → IDENTICAL hash.
4. Both re-hash the token-root with the updated transaction children — IDENTICAL hash.
5. Both manifests update `tokenId → newRootHash` with `status='valid'`.
6. Subsequent `pkg.merge` between the two would dedupe (Wave G.3 rule 4 sees identical content) — convergent.

**Failure mode**: aggregator rejects the commitment (source already spent). Both finalizers see `PATH_NOT_INCLUDED`. Both mark the token `invalid` with reason='spent'. Convergent on the invalid disposition.

**Crash recovery**: outbox + finalization queue are persisted to OrbitDB; both survive process restart. After restart, the worker resumes polling.

---

## 7. Outbox Schema

This replaces the current `OutboxEntry` (`types/txf.ts:150`). The new entry is **bundle-grained** to match PROFILE-ARCHITECTURE.md §10.12.

```typescript
interface UxfTransferOutboxEntry {
  /** UUID for this transfer attempt. */
  readonly id: string;
  /** Which UXF bundle (CAR root CID). */
  readonly bundleCid: string;
  /** Tokens shipped in this bundle (genesisTokenIds). */
  readonly tokenIds: readonly string[];
  /** How the bundle was sent. */
  readonly deliveryMethod: 'car-over-nostr' | 'cid-over-nostr' | 'txf-legacy';
  /** Recipient identifier (@nametag, DIRECT://..., chain pubkey, alpha1...). */
  readonly recipient: string;
  /** Recipient's resolved transport pubkey (used by transport.sendTokenTransfer). */
  readonly recipientTransportPubkey: string;
  /** Transfer mode. */
  readonly mode: 'conservative' | 'instant' | 'txf';
  /** Lifecycle status. */
  readonly status:
    | 'packaging'                    // building UXF bundle (UXF modes only)
    | 'pinned'                       // CAR pinned to IPFS (CID-mode only)
    | 'sending'                      // Nostr publish in progress
    | 'delivered'                    // Nostr publish acknowledged (conservative + txf terminal)
    | 'delivered-instant'            // Nostr publish ack'd; instant mode awaits finalization
    | 'finalizing'                   // finalization worker running
    | 'finalized'                    // proof attached locally; instant mode terminal
    | 'failed-transient'             // delivery or finalization failed; retry pending
    | 'failed-permanent';            // unrecoverable (oracle rejection, etc.)
  /** Instant-mode commitment requestIds to finalize (by sender's worker). */
  readonly commitmentRequestIds?: readonly string[];
  /** Memo. */
  readonly memo?: string;
  /** Timestamps. */
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Error info if failed. */
  readonly error?: string;
  /** Retry count. */
  readonly retryCount: number;
  /** Soft deadline for transient retry abandonment. */
  readonly retryDeadline?: number;
}
```

The outbox is stored in **OrbitDB** under per-entry keys (`${addr}.outbox.${id}`) per Wave G.7's per-entry-key layout, so cross-device visibility + multi-process safety are preserved.

### 7.1 Migration from legacy outbox

Existing `OutboxEntry` records (per-token) are migrated on first read:
1. Group by `(recipientPubkey, createdAt-window)` — entries created within 60s for the same recipient become a single bundle.
2. Construct a synthetic `UxfTransferOutboxEntry` per group with `mode: 'txf'` (legacy was always TXF wire shape with conservative-style finalization), `bundleCid: 'txf-' + tokenId` for single-token entries or `'legacy-' + recipientPubkey + '-' + createdAt` for combined ones, `deliveryMethod: 'txf-legacy'`.
3. Mark `status: 'finalized'` if the legacy entry is `delivered` or `confirmed`.

Migration is one-way; once migrated, the legacy collection is cleared.

---

## 8. Token Statuses (Extended)

PROFILE-ARCHITECTURE.md §10.11 defines statuses `valid | invalid | conflicting | pending`. The receive flow uses the same enum with the following per-disposition mapping:

| Recipient disposition | manifest.status | Notes |
|---|---|---|
| VALID | `valid` | spendable |
| PENDING | `pending` | awaiting finalization |
| PROOF_INVALID | `invalid` | reason recorded; in `_invalid` |
| STRUCTURAL_INVALID | `invalid` | reason recorded; in `_invalid` |
| SPENT | `invalid` | reason='spent' |
| CONFLICTING | `conflicting` | conflictingHeads[] populated |
| NEVER_MINE | (not in manifest) | quarantine collection |
| NO_LONGER_MINE | (not in manifest) | quarantine collection |

The on-chain spent state is checked via `oracle.isSpent(stateHash)` — a single round-trip per arriving token (cached per Wave L's bounded LRU).

---

## 9. Error Handling and Edge Cases

### 9.1 Bundle delivery fails (Nostr publish error)

- Retry via outbox `failed-transient` state with exponential backoff up to a hard cap (default 24 hours).
- After cap: `failed-permanent`. Sender's local source tokens REVERT from `pending` (instant mode) or `archived` (conservative mode) back to `confirmed` — they were never actually transferred.
- For **conservative mode**, this means the on-chain commitment HAS been submitted (token is technically spent according to oracle) but the recipient never learned. The sender retains the proof and can:
  - Re-send the same UXF bundle (same CID — idempotent).
  - Treat the funds as effectively burned and emit a `transfer:lost` event.
- For **instant mode**, the sender's finalizer has not yet run. If finalization succeeds AFTER permanent delivery failure, the sender knows the on-chain transfer happened; recipient is permanently unaware. Same recovery options.

### 9.2 Recipient gateway can't fetch CID

- Recipient walks all configured gateways (default + user-overridden).
- All fail → emit `transfer:fetch-failed` event; do NOT acknowledge to sender.
- Sender's outbox times out at retry deadline; treats as transient and retries the SAME Nostr event.
- After cap: `failed-transient`. Sender SHOULD attempt CAR-embed re-delivery if the bundle is small enough.

### 9.3 Recipient receives a UXF bundle from an unknown sender

- The Nostr event is signed (pubkey verified by relay). Sender identity is trusted at the wire layer.
- The UXF bundle is content-addressed and verified independently.
- If the recipient has no prior relationship with the sender pubkey:
  - Optional friend-list / spam-filter consultation (out of scope here; existing transport-level mechanism).
  - If accepted: process per §5.
  - If rejected: drop the bundle silently (no acknowledgment leaks "I exist" to attackers).

### 9.4 Instant-mode finalization fails on aggregator (PATH_NOT_INCLUDED)

The commitment was rejected — the source state was already spent (double-send) or didn't exist. Both sender and recipient mark the token `invalid` reason='oracle-rejected'.

**Refund** is out of scope. The token's value is lost from the recipient's perspective (nothing was actually transferred). Out-of-band recovery via support / nametag-based contact is the user's responsibility. A future protocol revision MAY add a reversal flow.

### 9.5 Sender restarts mid-finalization

Outbox is persisted in OrbitDB. On restart, `FinalizationWorker` resumes from where it left off. No data loss because:
- The commitment requestIds are recorded in the outbox before send.
- The aggregator's `getInclusionProof(requestId)` is idempotent.
- The local pool's pending transaction can be patched in-place once the proof is fetched.

### 9.6 Recipient restarts mid-finalization

Per-address finalization queue is persisted in OrbitDB (per-entry-key per Wave G.7). On restart, the queue is rehydrated and the worker resumes. Same idempotency as 9.5.

### 9.7 Bundle contains a token whose chain has a Rule-4-eligible alternative in our pool

Per Wave G.3, this triggers `resolveTokenRoot` with the bundle's verified proofs. The synthetic enriched root is computed and stored; manifest's primary root is the JOIN winner; both originals become losers. Status: `valid` if the JOIN converges; `conflicting` if divergent.

### 9.8 Two bundles arrive in close succession with overlapping tokens

Each is processed in arrival order. The second's tokens go through the per-token decision matrix. Conflict-check `[G]` may return `CONFLICTING` for any tokenId now present in two distinct chains. JOIN resolves.

---

## 10. Backward Compatibility

The TXF wire shapes are **permanent**, not deprecated. There is no migration window and no `WIRE_FORMAT_DEPRECATED` error path. UXF is the default; TXF is the explicit opt-in alternative for cases that require it.

### 10.1 Sender side

`PaymentsModule.send(...)` accepts:
- `transferMode: 'instant' | 'conservative' | 'txf'` — default `'instant'`.
- `delivery: DeliveryStrategy` (UXF modes only; see §3.3.1) — default `{ kind: 'auto', inlineCapBytes: 16384 }`.

Callers that don't specify either get the UXF bundle behavior in instant mode with the 16 KiB auto cutoff. Callers that explicitly want TXF wire shape pass `transferMode: 'txf'`.

There is **no automatic capability-based fallback** from UXF to TXF. The capability hint in the recipient's identity binding (informational) MAY surface a UI warning, but the SDK never silently switches modes. If a peer is known to be TXF-only, the caller selects `'txf'` explicitly.

### 10.2 Recipient side

`handleIncomingTransfer(...)` recognizes payloads and routes per shape:
- `kind: 'uxf-car' | 'uxf-cid'` → UXF flow (§5).
- Legacy shapes (indefinitely accepted, no deprecation):
  - `{sourceToken, transferTx}` (Sphere TXF)
  - `{token, proof}` (SDK legacy)
  - `{type: 'COMBINED_TRANSFER', version: '6.0', ...}`
  - `{type: 'INSTANT_SPLIT', version: '4.0' | '5.0', ...}`

For each legacy shape, the recipient runs an internal **adapter** that converts the inbound payload into a single-token UXF-equivalent disposition pass: the same decision matrix (§5.3) applies, but the bundle-level checks (§5.2) are skipped (no CAR, no bundleCid). Each legacy event becomes one disposition record.

This means: a TXF-mode sender and a UXF-aware recipient still produce the same set of disposition outcomes (VALID / PENDING / PROOF_INVALID / SPENT / etc.) — just one per event instead of N per bundle.

### 10.3 Outbox migration

Per §7.1: existing per-token outbox entries are migrated to bundle-grained on first read.

### 10.4 Capability detection (informational only)

The identity binding event (NIP-related) MAY include a `wireProtocols` array describing which wire shapes the peer's wallet supports — e.g., `['uxf-car', 'uxf-cid', 'txf']`. The sender's UI MAY warn when a UXF-only-aware recipient receives a `'txf'` send, or when a TXF-only recipient is targeted with a UXF send. The SDK NEVER auto-coerces the mode based on this hint — the caller's `transferMode` choice is authoritative.

---

## 11. Test Specification (high-level)

The implementation MUST include:

### 11.1 Unit tests (per layer)

- `UxfPackage.fromCar` round-trip on a known finalized bundle.
- `UxfPackage.fromCar` round-trip on a known unfinalized (instant-mode) bundle.
- Bundle CID mismatch rejection (sender lies about CID).
- Token IDs claim mismatch rejection.
- Each disposition branch in §5.3 — at least one test per leaf.
- Outbox state transitions (each `status` enum transition).
- Finalization worker: success, oracle rejection, transient failure, permanent failure.
- Replay: same bundleCid arrives twice, second is acknowledged not re-processed.

### 11.2 Integration tests

- End-to-end conservative-mode send/receive: 1 token, 5 tokens, 100 tokens.
- End-to-end instant-mode send/receive: same sizes; verify both sides converge to `valid` after finalization workers run.
- End-to-end TXF-mode send/receive: 1 token, 5 tokens (one event per token); verify inbound adapter produces correct dispositions.
- CAR-embed delivery for small bundles (< 16 KiB); CID delivery for large bundles (> 16 KiB).
- `delivery: { kind: 'force-inline' }` with an oversized bundle → expect `INLINE_CAR_TOO_LARGE` error.
- `delivery: { kind: 'force-cid' }` with a 1-token tiny bundle → IPFS pin happens, recipient fetches via gateway.
- `delivery: { kind: 'auto', inlineCapBytes: 32768 }` — 24 KiB bundle goes inline despite default cap being 16 KiB.
- Instant-mode sender restarts before finalization; resumes from outbox.
- Recipient restarts with pending tokens in queue; resumes finalization.
- Conflict scenario: same tokenId arrives in two different bundles; JOIN converges.
- Hostile-bundle scenarios: structural-invalid, proof-invalid, never-mine, no-longer-mine, spent. Each surfaces correctly.

### 11.3 Compatibility tests

- TXF-mode sender → UXF-aware recipient: legacy adapter produces correct dispositions for all 4 legacy shapes.
- UXF-mode sender → TXF-only recipient (simulated): send fails with typed error; caller's explicit retry with `transferMode: 'txf'` succeeds.
- Outbox migration: legacy per-token entries become bundle-grained correctly.
- Capability hint: identity binding declares `wireProtocols: ['txf']` only — sender UI warns; SDK does NOT auto-switch.

### 11.4 Adversarial tests (steelman seeds)

- Sender claims `mode: 'conservative'` but bundle has unfinalized transactions → recipient detects, treats as instant-mode with warning.
- Sender claims `mode: 'instant'` but bundle has finalized transactions → recipient processes per §5.3 (proofs verified normally; mode field is informational for backoff scheduling only).
- Bundle CID hash collision (sender forges a DIFFERENT CAR with the same root CID — only possible via SHA-256 collision, theoretical) → defended at the per-block hash-verify stage of UxfPackage.fromCar.
- CAR with multiple roots (smuggling attempt) → rejected at fromCar step (Wave G.5 `roots[0] !== expectedCid`).
- Replay: identical bundleCid sent 100 times → 1 processed, 99 dropped silently.
- Instant-mode + concurrent split: 5 split outputs all unfinalized → 5 separate finalizations → all converge.
- Recipient's local clock skewed by 30 days → finalization worker still runs (no clock-dependent guards).

---

## 12. Open Questions Deferred

- **Refund / reversal protocol** (§9.4): if instant-mode finalization fails on the aggregator, neither party has a way to recover the (logically nonexistent) value. A future revision MAY add a reversal flow with sender-attested cancellation.
- **Bundle compression**: CARs can be sizeable for many-token bundles. zstd / brotli on the inline-CAR path? Out of scope for v1.0.
- **Aggregator-driven inbound discovery**: if Nostr delivery fails permanently, can the recipient discover the transfer by scanning aggregator state? Out of scope; existing payment-request + reconciliation flows cover most cases.
- **Multi-recipient bundles**: a single UXF bundle delivered to a Nostr group / multicast? Out of scope; v1.0 is point-to-point.

---

## 13. Implementation Plan (deferred to UXF-TRANSFER-IMPL-PLAN.md)

The implementation will land in waves:

- **Wave T.1**: wire-format types — `UxfTransferPayload` discriminated union, `DeliveryStrategy`, `transferMode` enum extended to `'instant' | 'conservative' | 'txf'`, payload encode/decode helpers, unit tests. No call-site changes yet.
- **Wave T.2**: sender bundle construction for **conservative mode only** + CAR-embed delivery with the 16 KiB default cap + `force-inline` / `force-cid` / custom `inlineCapBytes` per-call overrides. Conservative is shipped first because it has no async-finalization tail to worry about.
- **Wave T.3**: recipient bundle ingest + decision matrix + storage outcomes. Handles UXF-bundle inbound from T.2 senders. No instant-mode handling yet (recipient rejects bundles whose `mode === 'instant'` with a transient error so senders don't drop tokens prematurely).
- **Wave T.4**: CID-pin delivery for large bundles (sender pins to IPFS; recipient fetches via verified-CAR pipeline). Closes the size loop opened in T.2.
- **Wave T.5**: instant mode + finalization workers (sender + recipient). The bundle now carries the signed unfinalized transfer-tx; both sides poll the aggregator independently. Convergence tested.
- **Wave T.6**: outbox refactor — bundle-grained `UxfTransferOutboxEntry` for UXF modes, per-token entries for TXF mode. Migration from the legacy per-token `OutboxEntry`. Crash-recovery tests.
- **Wave T.7**: TXF mode preserved as explicit opt-in: `transferMode: 'txf'` routes to the existing per-token Nostr event pipeline. Sender outbox uses the new schema with `deliveryMethod: 'txf-legacy'`. Receiver-side adapter routes legacy shapes through the §5.3 decision matrix one-token-at-a-time. No deprecation warnings, no automatic fallback.
- **Wave T.8**: capability hint surfacing (informational `wireProtocols` field in identity binding) + UI warnings + the `INLINE_CAR_TOO_LARGE` error path. Integration / compatibility / adversarial tests covering all three modes.

Each wave goes through the standard recursive steelman review before merge.

---

## Appendix A: Disposition Reference Table

| Branch | Trigger | Storage | Status | Balance |
|---|---|---|---|---|
| A | DAG type-check or hash-match fails | `_invalid` | invalid (structural) | no |
| B | Genesis predicate not for us | quarantine | (no manifest entry) | no |
| C | Last-state predicate not for us | quarantine | (no manifest entry) | no |
| D-fail-proof | Proof present but verifies as PATH_INVALID | `_invalid` | invalid (proof-invalid) | no |
| D-pending | Proof absent (instant mode) | active pool | pending | incoming-only |
| E | Oracle says destination state is spent | `_invalid` | invalid (spent) | no |
| F | Source state authority broken (chain integrity issue) | `_invalid` | invalid (proof-invalid) | no |
| G-conflict | Same tokenId, divergent chain | active pool | conflicting | spendable iff resolved |
| G-valid | All checks pass, no conflict | active pool | valid | spendable |
