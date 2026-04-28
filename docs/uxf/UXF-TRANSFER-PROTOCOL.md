# UXF Inter-Wallet Transfer Protocol

> **Status**: SPEC — implementation pending.
> **Cross-references**: PROFILE-ARCHITECTURE.md §10.10 (storage role of UXF), §10.11 (token statuses), §10.12 (outbox); SPECIFICATION.md (UXF DAG); UnicityLabs state-transition-sdk (transaction primitives).

---

## 1. Scope and Goals

This document defines the wire-level protocol by which one Sphere wallet transmits one or more tokens to another wallet, using **UXF bundles as the default inter-wallet wire format**. The legacy per-token TXF wire shape remains available as a permanent explicit opt-in. It specifies:

1. The two **finalization modes** (`'instant'` and `'conservative'`) and how they compose with the two **wire shapes** (UXF bundle and legacy TXF). Finalization mode and wire shape are orthogonal — every combination is supported except instant TXF on legacy peers that lack `txfFinalization` awareness (in that case the sender falls back to conservative TXF automatically).
2. The wire payload variants for UXF — **CAR-embedded** (small bundles, default cap 16 KiB) and **CID-referenced** (large bundles pinned to IPFS), with per-call sender overrides (`force-inline` / `force-cid` / custom byte threshold).
3. The sender-side state machine, including outbox semantics for instant-mode follow-up finalization (which may need to resolve multiple pending transactions per token, not just the latest).
4. The recipient-side **disposition decision matrix** — what happens to each token in the received bundle under every meaningful combination of (chain validity, current-state predicate target, finalization status of every transaction in the history, oracle spent state).
5. The async-finalization workers on both sides, plus convergence guarantees when sender and recipient finalize independently OR when the same token reaches the receiver via two channels with overlapping but partially-finalized histories.
6. **Chain mode** — the operational situation where instant-mode forwarding accumulates multiple unfinalized transactions in a token's history. Not a separate mode; just a property of the chain at receive time. See §2.3.
7. Replay / duplicate handling (idempotent — re-processing the same bundle is wasted compute, not a correctness issue).
8. Permanent acceptance of legacy wire shapes — the recipient indefinitely accepts `{sourceToken, transferTx}`, V6 `COMBINED_TRANSFER`, and `INSTANT_SPLIT` events without deprecation. Received TXF tokens still merge into the UXF-based OrbitDB profile when one is enabled.

### 1.1 Non-goals

- Aggregator-scan-based discovery of inbound transfers (the recipient relies on the Nostr TOKEN_TRANSFER event; if delivery fails permanently, recovery is out of scope here).
- Refund / reversal protocol on instant-mode finalization failure (spec deferred — see §9.4).
- Cross-chain or cross-network transfers.

---

## 2. Transfer Modes

Sphere supports two **finalization modes** (`'instant'` and `'conservative'`) that are orthogonal to two **wire shapes** (UXF bundle and legacy TXF). The default is `'instant'` over UXF (see §2.5). The mode/shape matrix:

| Mode | Wire | When |
|---|---|---|
| `'instant'` | UXF (default) | Default. Zero latency on send; both parties finalize asynchronously. |
| `'conservative'` | UXF | Sender awaits proof for every unfinalized transaction in the bundle before delivering. |
| `'instant'` | TXF (`transferMode: 'txf'`, with `txfFinalization: 'instant'`) | Legacy per-token wire shape, async finalization. |
| `'conservative'` | TXF (`transferMode: 'txf'`, default `txfFinalization: 'conservative'`) | Legacy per-token wire shape, fully finalized before send. |

### 2.1 Instant Mode (default)

The sender submits the commitment to the aggregator but **does not await the proof**. The bundle contains the transaction with `inclusionProof: null` PLUS the **fully signed transfer-tx**. Only the source-state owner can sign; the bundle MUST carry the signed tx so the recipient (and any later forwarder) can re-derive the commitment requestId and poll the aggregator independently.

> **Why the bundle MUST carry the signed tx in instant mode**: the commitment requestId is computed from the signed tx + source state — both sides can compute it. What the recipient cannot do is produce the signed tx for the sender; only the source-state owner can sign. Shipping the signed-but-unproven tx is what makes asynchronous independent finalization possible.

> **Token-hash invariance** (verified against `@unicitylabs/state-transition-sdk`): the token's identity (`token.id`) derives from `genesis.data.tokenId` and is **immutable across proof attachment**. `TransferTransactionData.calculateHash()` (`TransferTransactionData.js:92-93`) feeds only `(sourceState, recipient, salt, recipientDataHash, message, nametags)` — explicitly excluding the inclusion proof. Attaching a proof changes the *CBOR serialization* of the token and therefore its *content-address (CID)*, but neither the token identity nor any per-transaction data hash. This is the property that makes split-then-send-instantly safe: a child token minted from a still-pending parent has stable identity even after the parent is later finalized.

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
  │  (re-)submit + fetch proof ──│ ◀──── (re-)submit + fetch  │
  │  attach proof                │       attach proof         │
  │  status: confirmed           │       status: valid        │
  │                              │                            │
```

**Recipient guarantee:** the bundle is structurally validated, the chain is verified (modulo any still-unfinalized transactions), and the current-state predicate target is checked. The token enters the recipient's pool with status `'pending'` and counts toward "incoming" balance views, but **does not count toward spendable balance** until ALL transactions in the chain are finalized.

**Sender cost:** zero finalization latency. Sender's outbox carries a `pending-finalization` entry until the proof is retrieved.

### 2.2 Conservative Mode

The sender finalizes the **entire transaction history** of every token in the bundle — not just the new transfer transaction. Any pre-existing unfinalized transactions inherited from prior instant-mode hops are also resolved (proof fetched and attached) before the bundle is built. The new transfer commitment is then submitted and its proof awaited. The bundle therefore contains a **fully finalized chain** for every token.

```
Sender                      Aggregator                   Recipient
  │                              │                            │
  │ for each unfinalized tx in   │                            │
  │  source token's history:     │                            │
  │   submit + await proof ─────▶│                            │
  │   ◀── inclusion proof ───────┤                            │
  │                              │                            │
  │ submit new transfer commit ─▶│                            │
  │ ◀── inclusion proof ─────────┤                            │
  │                              │                            │
  │ build UXF bundle             │                            │
  │  (every tx has proof)        │                            │
  │                              │                            │
  │ send TOKEN_TRANSFER ─────────────────────────────────────▶│
  │                              │                            │
  │                              │       merge as 'valid'     │
  │                              │                            │
```

**Recipient guarantee:** every token arriving in conservative mode is fully finalizable by chain replay; no oracle proof round-trips are required to reach the `valid` status (only an `isSpent` check on the destination state).

**Sender cost:** one round-trip per still-unfinalized transaction in the chain, plus one for the new transfer.

### 2.3 Chain Mode (operational framing — not a separate mode)

"Chain mode" is the **situation** that arises when instant mode is composed across multiple hops: a token whose history contains two or more transactions that have not yet been finalized when the bundle is delivered. This is not a fourth `transferMode` value — it's a property of the token's transaction history at the moment of receive.

A receiver may be handed a token with K unfinalized transactions in its history (K ≥ 1) when:

- The original sender used instant mode (1 unfinalized: the latest transfer).
- The original recipient forwarded the token in instant mode before its inherited tx finalized (now 2+ unfinalized).
- This forwarding repeated arbitrarily many times — the chain grows.

Such tokens are useful for **high-frequency / semi-trusted scenarios** where parties accept short-term double-spend exposure in exchange for zero-latency settlement.

**Convergence to `valid`** for a chain-mode token requires either:

1. **Independent finalization** — the local finalization worker walks the entire history, polls (and if necessary re-submits) every unfinalized commitment, and attaches every proof as it arrives. K aggregator round-trips, each idempotent. OR
2. **Merge with a more-finalized copy** — the same token (same `token.id`) arrives via another channel (backup import, second Nostr delivery, peer reconciliation) carrying additional inclusion proofs. The local pool merges the two UXF representations under Wave G.3 enrichment rules: any proof one side has and the other lacks is grafted in. Convergence is monotonic — proofs accumulate, never delete.

The recipient's job is to attempt finalization on **every** unfinalized transaction in the history, not only the latest one. A token with even one unresolved transaction is held at status `'pending'`.

### 2.4 TXF Wire Shape (legacy, explicit opt-in)

The sender ships one Nostr `TOKEN_TRANSFER` event **per token** using the legacy payload shape (`{sourceToken, transferTx}`, V6 `COMBINED_TRANSFER`, or `INSTANT_SPLIT` per existing SDK selection logic). No UXF bundle is constructed. TXF is **permanent**, not deprecated. Senders use it only when the caller explicitly passes `transferMode: 'txf'`.

**TXF is orthogonal to finalization mode** — a TXF transfer can be either instant (`txfFinalization: 'instant'`) or conservative (default `txfFinalization: 'conservative'`). The semantics of each finalization mode (§2.1, §2.2) apply identically; only the wire shape differs.

**Recipient behavior when receiving TXF:** if the recipient has an OrbitDB-based UXF profile enabled, TXF arrivals are still merged into the UXF profile via an internal adapter (one TXF event → one synthetic single-token UXF disposition pass through the §5.3 decision matrix). The recipient need not maintain a parallel TXF-only inventory. Token statuses, dispositions, and storage outcomes are identical to the UXF-bundle path.

**TXF lacks the multi-token bundle benefit** — N tokens means N Nostr events. Use only when the caller has a deliberate reason (peer interop with non-UXF wallets, diagnostic forensics, backward-compatibility regression coverage).

### 2.5 Mode Selection

- **Default**: `transferMode: 'instant'` over UXF — minimizes UX latency, multi-token bundles.
- **Caller override**: `PaymentsModule.send({ transferMode, txfFinalization?, delivery? })`.
  - `transferMode: 'instant'` (default) — UXF bundle, async finalization (§2.1).
  - `transferMode: 'conservative'` — UXF bundle, full-history finalization-before-send (§2.2). Recommended for high-value transfers, escrow, swap deposits.
  - `transferMode: 'txf'` — legacy per-token wire (§2.4). Pair with `txfFinalization: 'instant' | 'conservative'` (default `'conservative'`).
- **Splits MAY be instant**: token-hash invariance under proof attachment (verified above) means split-and-mint flows can issue child tokens with status `'pending'` referencing a still-unfinalized parent. The parent's proof, when later attached, does not invalidate the child's identity. This is a **deliberate change** from the prior assumption that splits required conservative-mode finalization.
- **Forced conservative remains** for cross-protocol bridges (e.g., into a non-UXF chain) where the destination requires finalized state. The implementation surfaces such overrides in the call result.

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

> **The CAR is in fact already pinned by the time we send.** Per PROFILE-ARCHITECTURE.md §10.12, the outbox is part of the sender's UXF profile, which is itself published to IPFS (with IPNS naming). Writing the bundle to the outbox before send already persists it to the local Helia/IPFS node and republishes the profile. The "pin step" referenced here is a no-op when the profile pipeline has already run; it is named explicitly only to give the recipient a guaranteed retrievable CID.

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
   - All tokens MUST be currently owned (current-state predicate binds to sender).
   - Each selected token MUST contain the coin being sent. A token MAY carry multiple distinct coin types (multi-coin tokens are supported by the SDK); in that case the token will need to be split (see step 2) so that only the requested `(coinId, amount)` is delivered to the recipient and the remaining coin balances stay with the sender.
   - Total of the `(coinId, amount)` slices selected across the chosen tokens MUST sum to the requested transfer amount.

2. **Compute splits** (if needed). Two split scenarios:
   - **Single-coin amount split**: a token's balance for the requested coin exceeds the requested amount → split into `{tokenForRecipient, changeToken}` per existing split logic.
   - **Multi-coin token split**: a token carries the requested coin alongside other coin types → split into `{tokenForRecipient, residualToken}`, where `tokenForRecipient` carries only the requested `(coinId, amount)` and `residualToken` carries every other coin balance plus the unsent remainder of the requested coin. The residual token stays with the sender.
   - Splits MAY be issued in instant mode (the parent's still-pending transaction does not invalidate child token identities — see the token-hash invariance note in §2.1).

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

The outbox's primary purpose is to guarantee **eventual delivery** despite intermittent network connectivity, app crashes, and infrastructure failures. Every transfer attempt is journaled before the Nostr publish; the journal is the source of truth for retry, finalization, and recovery.

In **conservative mode**, the outbox entry's lifecycle is short: created at step 6, marked `delivered` at step 8, optionally garbage-collected immediately or retained for a configurable window for delivery acknowledgments.

In **instant mode**, the outbox entry persists until finalization completes for **every** transaction the sender contributed to the chain (typically 1, but K if the sender forwarded a chain-mode token). It carries the list of `commitmentRequestIds` so the async finalizer knows which proofs to fetch and re-submit if the aggregator returns `PATH_NOT_INCLUDED` transiently.

In **TXF mode**, the outbox entry is per-token and short-lived (same lifecycle as conservative-UXF, but with `deliveryMethod: 'txf-legacy'` and `bundleCid: 'txf-' + tokenId`). Instant-TXF entries follow the instant-UXF lifecycle but at per-token granularity.

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

**Replay handling**: re-processing the same `bundleCid` is **idempotent**, not a correctness issue. A token is identified by its immutable `token.id`; the local pool can only ever hold one canonical copy per id, updated monotonically with the longest valid chain of finalized transactions. Re-processing wastes compute but cannot introduce duplicates, conflicts, or inconsistencies. The recipient maintains a bounded LRU set of recently-processed `bundleCid` values (default 256) **only as an optimization** to skip the redundant work; eviction from the LRU is harmless.

### 5.2 Bundle verification

Before per-token disposition, the recipient performs **bundle-level checks**:

1. **`pkg.verify()`** — UXF DAG integrity (Wave F's verify.ts, depth/pool caps, cycle detection).
2. **CAR root CID match** — `bundleCid === extractCarRootCid(carBytes)`. Sender lying about which CID their CAR represents → reject the entire bundle.
3. **Token ID claim consistency** — `payload.tokenIds` MUST be a subset of `[...pkg.manifest.tokens.keys()]`. Sender claiming tokens not actually in the bundle → reject. The bundle MAY contain MORE tokens than `tokenIds` declares (sub-DAG dependencies), but every claimed ID must be present.

If any bundle-level check fails, the entire bundle is rejected with a typed `BUNDLE_REJECTED` error; nothing is imported. This is logged and surfaced as a `transfer:rejected` event.

### 5.3 Per-token disposition — THE DECISION MATRIX

For each `tokenId` in `payload.tokenIds`, the recipient walks the following decision tree. Each branch leads to a specific `disposition` outcome with a specific storage action.

The matrix gates on **current-state ownership**, not genesis ownership: a token we receive via transfer was, by definition, originally minted to someone else, and that's perfectly normal. What matters is whether the token's *current* state binds to us.

```
For each tokenId in bundle:
│
├─[A]─ Structural validation
│        Resolve manifest entry → root token-root element exists in pool?
│        Walk DAG: type tags valid, hashes match, predecessor links consistent.
│        ├─ FAIL → disposition: STRUCTURAL_INVALID
│        └─ PASS → continue
│
├─[B]─ Last-state predicate target
│        After applying all transactions in the chain (proofs where present,
│        structural-only where absent), what is the current state?
│        Does its predicate bind to the recipient identity?
│        ├─ FAIL (current state binds to a different identity — token was
│        │   once ours and transferred away, OR was never ours) →
│        │   disposition: NOT_OUR_CURRENT_STATE
│        │   (preserved for audit/diagnostic; not active inventory)
│        └─ PASS → continue
│
├─[C]─ Per-transaction finalization sweep
│        Walk every transaction in the chain (genesis through latest):
│          - If inclusionProof present → verify against trustBase.
│              ├─ verify OK → mark this tx FINALIZED
│              └─ verify FAILS (PATH_INVALID / NOT_AUTHENTICATED) →
│                  disposition: PROOF_INVALID (whole token; one bad proof
│                  poisons the chain) and stop.
│          - If inclusionProof === null → mark this tx UNFINALIZED;
│            verify the authenticator-presence (signed-by-previous-owner)
│            and the source-state continuity (this tx's source state IS
│            the prior tx's destination state).
│              └─ continuity broken → disposition: PROOF_INVALID and stop.
│        After the sweep we have:
│          unfinalizedCount = number of txs with no proof
│          allFinalized = (unfinalizedCount === 0)
│        ├─ unfinalizedCount > 0 → continue to [D] (chain mode path)
│        └─ allFinalized → continue to [E] (oracle-spent check)
│
├─[D]─ Chain-mode token (one or more pending transactions)
│        Source-state authority for every tx is intact (verified in [C]).
│        Decision: disposition: PENDING.
│        Every unfinalized tx in the chain is queued for finalization (§5.5)
│        — not just the latest. Finalization may also happen by merge with
│        a more-finalized copy of the same token (§2.3).
│
├─[E]─ Oracle spent-check (allFinalized only)
│        oracle.isSpent(currentDestinationStateHash)?
│        ├─ FALSE → continue to [F] (token is current and spendable)
│        └─ TRUE → token's current state has been consumed by some
│            transaction NOT in the history we received.
│            Sub-classify:
│              ├─ Recipient previously held this token, transferred it
│              │  away, and the off-record tx is OUR own transfer →
│              │  disposition: NO_LONGER_MINE
│              └─ Otherwise (the off-record tx was someone else's, or
│                 the chain end was already spent by a third party) →
│                 disposition: UNSPENDABLE_BY_US
│            Both sub-cases preserve the token for audit but do not
│            count it toward balance. Distinguish from PROOF_INVALID:
│            structurally valid token whose chain we just don't fully
│            see, vs. cryptographically broken token.
│
├─[F]─ Conflict check
│        Does our local pool already have a token with this tokenId?
│        ├─ YES, identical chain → no-op (idempotent receive)
│        ├─ YES, different chain — invoke resolveTokenRoot (Rule 3/4 JOIN
│        │   with verifiedProofs from the new bundle). This includes the
│        │   chain-mode merge case where one side has more finalized
│        │   transactions than the other → graft proofs in monotonically.
│        │   ├─ Resolved (one chain is a strict prefix or extension) →
│        │   │   disposition: VALID (or PENDING if any tx still unfinalized)
│        │   └─ Genuinely divergent (both chains contain different
│        │       transactions from the same source state) →
│        │       disposition: CONFLICTING
│        └─ NO → disposition: VALID (or PENDING — see [D])
│
└─[G]─ Final disposition recorded; storage action per §5.4.
```

**Disposition note — chain mode and §5.5 interaction**: a token may transition from `PENDING` to `VALID` either via the per-tx finalization sweep (§5.5 worker resolves every unfinalized tx) or via the §2.3 merge path (a later UXF copy of the same token brings in the missing proofs). Both paths converge to the same canonical state — see §6.3.

### 5.4 Storage outcomes

The matrix distinguishes **cryptographically broken** tokens (`PROOF_INVALID`, `STRUCTURAL_INVALID` — preserved for forensics) from **structurally valid but unspendable-by-us** tokens (`NOT_OUR_CURRENT_STATE`, `UNSPENDABLE_BY_US`, `NO_LONGER_MINE` — preserved for audit, possibly recoverable later).

| Disposition | Active inventory? | Counts in balance? | Storage location | Surfaces in UI |
|---|---|---|---|---|
| `VALID` | Yes | Spendable | active token pool, `manifest.status='valid'` | Wallet inventory |
| `PENDING` | Yes | Incoming (not spendable) | active token pool, `manifest.status='pending'`, every unfinalized tx queued | Wallet inventory with "pending" badge |
| `CONFLICTING` | Yes (winner) | Spendable iff resolved | active pool, `manifest.status='conflicting'` + `conflictingHeads[]` | Conflict-resolution view |
| `PROOF_INVALID` | No | No | `_invalid` collection (per-entry-key `${addr}.invalid.${tokenId}`), reason='proof-invalid' | Investigation view |
| `STRUCTURAL_INVALID` | No | No | `_invalid` collection, reason='structural' | Investigation view |
| `NOT_OUR_CURRENT_STATE` | No | No | `_audit` collection (`${addr}.audit.${tokenId}`), reason='not-our-state' | Audit view (off by default) |
| `UNSPENDABLE_BY_US` | No | No | `_audit` collection, reason='off-record-spend' | Audit view |
| `NO_LONGER_MINE` | No | No | `_audit` collection, reason='we-already-spent' | Audit view |

**Distinguishing forensics from audit**:
- `_invalid` — cryptographically broken tokens. The chain is bad; investigation typically points to a forged proof, a corrupted bundle, or a malicious sender.
- `_audit` — structurally valid tokens we just can't spend. The token might be recoverable: e.g., a `NOT_OUR_CURRENT_STATE` arrival might transition to `VALID` if a later transfer to us arrives and the current state then binds to us. The audit collection MUST NOT be wiped during routine cleanup.

**Retention**:
- `_invalid`: indefinite by default; user can manually `cleanupInventory()` to clear.
- `_audit`: indefinite by default. A periodic re-scan (out of scope here) MAY promote `_audit` entries to active inventory if a later transfer makes them ours.

### 5.5 Per-token finalization (chain-mode landing path)

When a `PENDING` token enters the pool, **one entry per unfinalized transaction in the chain** is added to a per-address **finalization queue**. A token with K unfinalized transactions yields K queue entries; the token transitions from `pending → valid` only when all K are resolved.

```typescript
interface FinalizationQueueEntry {
  tokenId: string;
  bundleCid: string;             // for cross-reference
  txIndex: number;               // position in token.transactions[]; 0 = genesis-adjacent oldest unfinalized
  commitmentRequestId: string;   // computed locally from (signedTx, sourceState)
  signedTransferTxBytes?: Uint8Array; // present iff this hop's tx came from the incoming bundle;
                                      // absent if recovered from a partial-merge case where only
                                      // the proof was missing (the signed tx is already in the pool)
  submittedAt: number;           // for backoff scheduling
  retryCount: number;
  source: 'sent' | 'received';   // sender's outbox vs recipient's queue
}
```

The finalization worker (see §6) processes each entry in order. For each pending tx:

1. Compute / re-compute `commitmentRequestId` locally from the signed tx + source state. This MUST match what the sender computed; if not, mark the token `PROOF_INVALID`.
2. If the worker has not yet seen evidence the commitment was submitted: submit it to the aggregator. The aggregator's submit endpoint is idempotent — submitting an already-known commitment returns immediately. (Re-submission covers the case where the original sender died before the aggregator received the first submission attempt.)
3. Poll `aggregator.getInclusionProof(commitmentRequestId)` until a proof is returned or a hard error (`PATH_NOT_INCLUDED`, `PATH_INVALID`) is observed.
4. **On proof retrieval**:
   - The proof is content-hashed and added to the pool as an `inclusion-proof` element.
   - The pending transaction's `inclusionProof` child is updated from `null` to the new proof's ContentHash.
   - **Token identity does NOT change.** Per the audit in §2.1, `token.id` derives from `genesis.data.tokenId` and is immutable; `TransferTransactionData.calculateHash()` excludes the inclusion proof from the data hash. What DOES change is the *CBOR serialization* of the token (the proof bytes are now present), and therefore its *content-address (CID)* in IPFS / the UXF profile. Wave H canonicalization applies to **CIDs** (the OrbitDB profile manifest entry for this `tokenId` is updated to point at the new CID), not to `token.id` itself.
   - The previous (proof-less) CID is tombstoned in the manifest so older copies are not served.
   - This entry is removed from the finalization queue.
5. **On hard error (`PATH_NOT_INCLUDED` / `PATH_INVALID`)**: the token's chain is invalid. Mark the whole token `manifest.status = 'invalid'` (reason='oracle-rejected'); move to `_invalid`. Remove all queue entries for this `tokenId`.
6. **On transient error**: increment retry count, back off, retry.
7. **When the queue is drained for this `tokenId`** (no remaining unfinalized txs, no error stops): transition `manifest.status: pending → valid`. Re-emit `transfer:incoming` with `confirmed: true`.

**Merge-path finalization (§2.3)**: when another UXF copy of the same token arrives carrying additional proofs, those proofs are grafted into the local pool via the Wave G.3 enrichment rules. Each grafted proof eliminates the corresponding queue entry without an aggregator round-trip. This is how chain-mode tokens converge fastest in practice — peer-to-peer proof gossip beats aggregator polling.

### 5.6 Replay / duplicate / merge handling

All of the following are **idempotent and convergent**; nothing requires special-casing beyond the §5.3 decision matrix:

- **Same `bundleCid` arrives twice**: re-process is wasted compute (suppressed by the LRU optimization in §5.1) but cannot diverge from the first processing.
- **Same `bundleCid`, different `payload.mode` claimed**: protocol violation — log warning. Processing semantics depend only on the bundle contents (which proofs are present), not the `mode` field; the field is informational. Process per the bundle.
- **Same `tokenId` arrives in two bundles from different senders**: handled by the `[F]` conflict check; `resolveTokenRoot` decides.
- **Same `tokenId` arrives carrying additional proofs while a `PENDING` entry exists** (the chain-mode merge case): the new proofs are grafted into the existing entry via Wave G.3 enrichment. Queue entries for now-finalized txs are removed. If all unfinalized txs become finalized, status `pending → valid`. The token stays put — no rebuild — only its CID may change.
- **Two unfinalized copies of the same token arrive from different channels**: if their chains agree (one is a prefix or extension of the other), merge yields a single entry with the union of proofs (in practice: 0 proofs union 0 proofs = 0 proofs, but if either side has any partial proof set, the other gets it for free). If they truly diverge, `CONFLICTING`.

---

## 6. Asynchronous Finalization

Both the **sender** (for instant-mode-sent tokens) and the **recipient** (for any pending tokens) run finalization workers. The two workers are independent — they do not coordinate — and the protocol is designed so they converge to the same valid local state without exchanging messages.

A worker may need to resolve **multiple unfinalized transactions per token** (chain-mode tokens, §2.3). Both workers walk the entire transaction history, not just the latest tx.

### 6.1 Sender-side finalization worker

Trigger: outbox entry with `status: 'delivered-instant'` and one or more outstanding `commitmentRequestIds`. The list MAY contain entries for transactions the sender did not author (chain-mode forwards inherit a list of unfinalized inbound txs that the sender now also has an interest in resolving, since the token won't transition to `valid` locally until they're done).

Loop (default poll: 30s with exponential backoff up to 5 min):

```
For each pending requestId in outbox.commitmentRequestIds:
   if signedTx is present and not previously submitted:
     submit commitment to aggregator (idempotent)
   try fetchInclusionProof(requestId):
     proof.verify(trustBase, requestId):
       OK → attach proof to the matching transaction in the token's
            local copy (token.id unchanged; only CID changes).
            Remove requestId from outbox.
       NOT_AUTHENTICATED / PATH_INVALID →
            mark token 'invalid' (reason='oracle-rejected' or
            'forged-proof'); alert operator; clear ALL requestIds for
            this tokenId from outbox.
       PATH_NOT_INCLUDED →
            commitment was rejected by aggregator (e.g. source already
            spent). Token is invalid. Mark and alert.
     no response (transient) →
            increment retryCount; reschedule with backoff.
   if all requestIds for tokenId are resolved:
     transition outbox entry to 'finalized'.
```

Outbox terminal states: `finalized` (every proof attached), `failed-permanent` (any oracle hard-rejection), `failed-transient` (max retries exhausted — operator intervention required).

### 6.2 Recipient-side finalization worker

Same logic as 6.1 but driven from the per-address finalization queue (§5.5) rather than the outbox. Each `tokenId` in the queue may have K entries (one per unfinalized tx); the token transitions `pending → valid` only when all K resolve to `OK`.

The merge path (§5.5 last paragraph) provides an alternative: if a more-finalized UXF copy of the same token arrives via Nostr / IPFS / backup-import, its proofs are grafted into the local pool, eliminating the corresponding queue entries without an aggregator round-trip.

### 6.3 Convergence guarantees

**Claim**: an instant-mode transfer that succeeds at the aggregator will eventually transition to `valid` on BOTH sender and recipient, regardless of whether the chain has 1 or K unfinalized transactions and regardless of the order in which proofs become available.

**Two distinct kinds of equality** matter for convergence:

1. **Token identity (`token.id`) equality** — by design, immutable: derived from `genesis.data.tokenId`, never changes across proof attachment. Both sides agree on `token.id` from the moment the bundle is opened.
2. **Token CID equality** — the IPFS content-address of the serialized token. This DOES change when proofs are attached (the CBOR encoding gains the proof bytes). Both sides converge to the SAME final CID *only when they have attached the same set of proofs*.

**Proof sketch**:
1. For each unfinalized tx, the aggregator publishes its proof at most once (idempotency of `getInclusionProof`). All callers of the same `requestId` retrieve byte-identical proof content.
2. Both finalizers fetch each pending proof independently. Both attach byte-identical `inclusion-proof` elements to byte-identical transaction objects.
3. The transaction's data hash (`TransferTransactionData.calculateHash()`) is unchanged — proofs are not in its preimage. So the per-tx CID changes (the encoded form is different) but the `transactionHash` referenced *by* the inclusion proof remains the same.
4. The token's `id` is unchanged throughout. The token's CID — the content-address of its CBOR encoding — converges once both sides have the same proof set attached.
5. Both manifests update `tokenId → newCid` and set `status='valid'` once all unfinalized txs in the chain are resolved.
6. Subsequent `pkg.merge` between the two pools dedupes via Wave G.3 (identical content → identical CID); the merge is a no-op.

**Failure mode (aggregator hard-rejects a commitment)**: both finalizers see `PATH_NOT_INCLUDED` for that requestId. Both mark the token `invalid`. Convergent on the invalid disposition. The token stays in `_invalid` on both sides.

**Asymmetric-knowledge mode (one side has more proofs than the other, no network)**: as long as the more-knowledgeable copy reaches the lagging side via any channel (a second Nostr delivery, a backup import, an IPFS pull) the merge is monotonic — proofs accumulate. Convergence does not require both sides to ever reach the aggregator.

**Crash recovery**: outbox + finalization queue are persisted to OrbitDB; both survive process restart. After restart, the worker resumes polling. Idempotency ensures no double-attach.

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
| PENDING | `pending` | one or more txs in chain unfinalized; queued (§5.5) |
| CONFLICTING | `conflicting` | `conflictingHeads[]` populated |
| PROOF_INVALID | `invalid` | reason='proof-invalid'; in `_invalid` |
| STRUCTURAL_INVALID | `invalid` | reason='structural'; in `_invalid` |
| NOT_OUR_CURRENT_STATE | (not in manifest) | `_audit` collection, reason='not-our-state' |
| UNSPENDABLE_BY_US | (not in manifest) | `_audit` collection, reason='off-record-spend' |
| NO_LONGER_MINE | (not in manifest) | `_audit` collection, reason='we-already-spent' |

The on-chain spent state is checked via `oracle.isSpent(stateHash)` — a single round-trip per finalized arriving token (cached per Wave L's bounded LRU). For chain-mode tokens, the spent check is deferred until all unfinalized txs are resolved (running it earlier would be meaningless — `isSpent` of an unproven destination state is undefined).

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

The commitment was rejected — the source state was already spent (double-send) or didn't exist. Both sender and recipient mark the **failed transfer transaction** invalid (reason='oracle-rejected'). The **source token itself is unaffected** — the failed transition is treated as if it never happened, the token remains in its prior valid state in the original owner's pool.

**No refund / reversal protocol is needed**: nothing was actually transferred (per §12.1). The receiver's `_invalid` entry exists only to record the failed delivery attempt; the receiver never had a real claim on the value. The sender retains full ownership.

For the chain-mode case, only the specific failing tx is invalidated; finalization for other unfinalized txs in the same token's chain continues independently.

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

Each is processed in arrival order. The second's tokens go through the per-token decision matrix. Conflict-check `[F]` (§5.3) may return `CONFLICTING` for any tokenId now present in two distinct chains, OR may return `VALID/PENDING` after a monotonic merge if one chain is a strict prefix/extension of the other. The chain-mode merge path (§5.6) is the mainline case for partially-overlapping arrivals.

---

## 10. Backward Compatibility

The TXF wire shapes are **permanent**, not deprecated. There is no migration window and no `WIRE_FORMAT_DEPRECATED` error path. UXF is the default; TXF is the explicit opt-in alternative for cases that require it.

### 10.1 Sender side

`PaymentsModule.send(...)` accepts:
- `transferMode: 'instant' | 'conservative' | 'txf'` — default `'instant'`.
- `txfFinalization: 'instant' | 'conservative'` — only applies when `transferMode === 'txf'`; default `'conservative'`.
- `delivery: DeliveryStrategy` (UXF modes only; see §3.3.1) — default `{ kind: 'auto', inlineCapBytes: 16384 }`.

Callers that don't specify any of these get the UXF bundle behavior in instant mode with the 16 KiB auto cutoff. Callers that explicitly want TXF wire shape pass `transferMode: 'txf'` and optionally pair with `txfFinalization` to choose the finalization semantics.

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

This means: a TXF-mode sender and a UXF-aware recipient still produce the same set of disposition outcomes (VALID / PENDING / PROOF_INVALID / STRUCTURAL_INVALID / NOT_OUR_CURRENT_STATE / UNSPENDABLE_BY_US / NO_LONGER_MINE / CONFLICTING) — just one per event instead of N per bundle.

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
- End-to-end TXF-mode (conservative): 1 token, 5 tokens (one event per token); verify inbound adapter produces correct dispositions and merges into the OrbitDB profile when one is enabled.
- End-to-end TXF-mode (instant): same; verify both sides finalize asynchronously despite the per-token wire shape.
- **Chain mode**:
  - 3-hop instant-mode forward: A→B→C→D before any aggregator round-trip. D receives a token with 3 unfinalized txs. D's worker resolves all 3; status transitions `pending → valid` only after the third proof attaches.
  - Same chain, but D imports a more-finalized backup of the same `tokenId` mid-resolution. The backup's proofs short-circuit the queue.
  - Multi-coin token transferred mid-chain — verify the recipient correctly re-derives the requestId for the multi-coin parent's pending split tx.
- **Multi-coin tokens**:
  - A token containing `{UCT: 100, USDU: 50}` is sent for `(UCT, 30)` only. Verify residual stays at sender with `{UCT: 70, USDU: 50}`; recipient receives a child token with `(UCT, 30)`.
  - Same, but residual is sent in a follow-up transfer to a third party.
- Token-hash invariance: take the same token in two states (proof attached vs. proof null), verify `token.id` is identical, verify CIDs differ.
- CAR-embed delivery for small bundles (< 16 KiB); CID delivery for large bundles (> 16 KiB).
- `delivery: { kind: 'force-inline' }` with an oversized bundle → expect `INLINE_CAR_TOO_LARGE` error.
- `delivery: { kind: 'force-cid' }` with a 1-token tiny bundle → IPFS pin happens (or no-op since the outbox already pinned), recipient fetches via gateway.
- `delivery: { kind: 'auto', inlineCapBytes: 32768 }` — 24 KiB bundle goes inline despite default cap being 16 KiB.
- Instant-mode sender restarts before finalization; resumes from outbox. Outbox carries entries for all unfinalized txs.
- Recipient restarts with chain-mode tokens (multiple txs pending) in queue; resumes and resolves all.
- Conflict scenario: same tokenId arrives in two different bundles; JOIN converges. Same tokenId arrives in two bundles with overlapping-but-not-identical proof sets; merge accumulates monotonically.
- Hostile-bundle scenarios: STRUCTURAL_INVALID, PROOF_INVALID, NOT_OUR_CURRENT_STATE, UNSPENDABLE_BY_US, NO_LONGER_MINE. Each surfaces correctly.

### 11.3 Compatibility tests

- TXF-mode sender → UXF-aware recipient: legacy adapter produces correct dispositions for all 4 legacy shapes; tokens land in the OrbitDB profile.
- UXF-mode sender → TXF-only recipient (simulated): send fails with typed error; caller's explicit retry with `transferMode: 'txf'` succeeds.
- Outbox migration: legacy per-token entries become bundle-grained correctly; TXF entries stay per-token with `deliveryMethod: 'txf-legacy'`.
- Capability hint: identity binding declares `wireProtocols: ['txf']` only — sender UI warns; SDK does NOT auto-switch.

### 11.4 Adversarial tests (steelman seeds)

- Sender claims `mode: 'conservative'` but bundle has unfinalized transactions → recipient processes per bundle contents (mode field is informational); token enters `pending`.
- Sender claims `mode: 'instant'` but bundle has all proofs → recipient processes per §5.3; token enters `valid` after oracle isSpent check.
- Bundle CID hash collision (sender forges a DIFFERENT CAR with the same root CID — only possible via SHA-256 collision, theoretical) → defended at the per-block hash-verify stage of `UxfPackage.fromCar`.
- CAR with multiple roots (smuggling attempt) → rejected at `fromCar` step (Wave G.5 `roots[0] !== expectedCid`).
- Replay: identical bundleCid sent 100 times → 1 processed, 99 short-circuited via LRU; if LRU evicts, re-processing is benign (idempotent).
- Instant-mode + concurrent split: 5 split outputs all unfinalized → 5 separate finalizations → all converge. Parent's still-pending tx is also finalized in parallel.
- Recipient's local clock skewed by 30 days → finalization worker still runs (no clock-dependent guards).
- Chain-mode forwarder dies mid-chain: the token's queue carries entries for the predecessor's pending tx; finalization still completes via the local worker (predecessor's signedTx is in the bundle the forwarder received).
- Forged authenticator on an unfinalized tx (tx claims to be signed by previous owner but isn't) → `[C]` continuity check rejects → `PROOF_INVALID`.

---

## 12. Resolved and Deferred Questions

### 12.1 Resolved

- **Refund / reversal protocol on aggregator rejection**: NOT needed. If the aggregator rejects a commitment submission (`PATH_NOT_INCLUDED`), the transaction is treated as if it never happened — the source token is still in its prior valid state. Both sender and recipient mark the *attempted* transition as invalid, but the underlying token is unchanged. No reversal flow required. (Per-history-tx invalidations propagate up to the whole-token level; see §5.5 step 5 + §6.3 failure mode.)
- **Aggregator-driven inbound discovery**: NOT possible. The aggregator never holds the full transaction — only its commitment. A recipient who never received the Nostr/UXF delivery cannot reconstruct the token from the aggregator alone. Existing payment-request + reconciliation flows are the recovery path.

### 12.2 Deferred

- **Bundle compression**: CARs can be sizeable for many-token bundles (especially chain-mode tokens with deep history). zstd / brotli on the inline-CAR path? Out of scope for v1.0.
- **Multi-recipient bundles**: a single UXF bundle delivered to a Nostr group / multicast — nice to have, deferred. Would amortize CID-pin cost across N recipients and allow group-level atomic broadcasts. Open design points: per-recipient encryption envelope vs. shared symmetric key, group-membership consent.
- **Audit-collection promotion**: a periodic re-scan that promotes `_audit` entries to active inventory if a later transfer makes them ours. Out of scope here; tracked separately.

---

## 13. Implementation Plan (deferred to UXF-TRANSFER-IMPL-PLAN.md)

The implementation will land in waves:

- **Wave T.1** — Wire-format types. `UxfTransferPayload` discriminated union, `DeliveryStrategy`, `transferMode: 'instant' | 'conservative' | 'txf'`, `txfFinalization: 'instant' | 'conservative'`, payload encode/decode helpers, unit tests. No call-site changes yet.
- **Wave T.2** — Sender bundle construction for **conservative mode** (UXF wire) + CAR-embed delivery with the 16 KiB default cap + `force-inline` / `force-cid` / custom `inlineCapBytes` per-call overrides. Conservative ships first because the chain has no unfinalized tail when it goes out. Sender also walks the source token's history and finalizes any inherited pending txs before bundle build.
- **Wave T.3** — Recipient bundle ingest + decision matrix + storage outcomes (`VALID`, `STRUCTURAL_INVALID`, `PROOF_INVALID`, `NOT_OUR_CURRENT_STATE`, `UNSPENDABLE_BY_US`, `NO_LONGER_MINE`, `CONFLICTING`). Handles UXF-bundle inbound from T.2 senders. No instant-mode handling yet (recipient rejects bundles whose `mode === 'instant'` with a typed soft-error so T.2-only deployments don't drop tokens silently).
- **Wave T.4** — CID-pin delivery for large bundles (sender uses the already-pinned outbox CID; recipient fetches via verified-CAR pipeline). Closes the size loop opened in T.2. Adds `delivery: 'force-cid'` regression tests.
- **Wave T.5** — Instant mode + finalization workers. Critical scope:
  - Bundle carries the signed unfinalized transfer-tx; both sides poll the aggregator independently.
  - Workers walk the **entire transaction history** of every pending token, not just the latest tx — chain-mode tokens with K unfinalized txs spawn K queue entries.
  - Token-id invariance is asserted; CID changes on proof attachment are recorded in the OrbitDB profile manifest.
  - Merge-path enrichment: arriving a more-finalized copy of an existing pending token grafts proofs in (Wave G.3 rule 4 extension).
- **Wave T.6** — Outbox refactor. Bundle-grained `UxfTransferOutboxEntry` for UXF modes, per-token entries for TXF mode. `commitmentRequestIds` is a list (not single) to support chain-mode forwards. Migration from the legacy per-token `OutboxEntry`. Crash-recovery tests covering mid-chain restart.
- **Wave T.7** — TXF mode as explicit opt-in: `transferMode: 'txf'` routes to the per-token Nostr event pipeline; pair with `txfFinalization` to choose finalization semantics. Sender outbox uses the new schema with `deliveryMethod: 'txf-legacy'`. Receiver-side adapter routes legacy shapes through the §5.3 decision matrix one-token-at-a-time and merges into the OrbitDB profile when one is enabled. No deprecation warnings, no automatic fallback.
- **Wave T.8** — Capability hint surfacing (informational `wireProtocols` field in identity binding) + UI warnings + the `INLINE_CAR_TOO_LARGE` error path. Integration / compatibility / adversarial tests covering all three modes including chain mode and multi-coin tokens.

Each wave goes through the standard recursive steelman review before merge.

---

## Appendix A: Disposition Reference Table

Branches reference the §5.3 decision matrix.

| Branch | Trigger | Storage | manifest.status | Counts in balance? |
|---|---|---|---|---|
| A | DAG type-check or hash-match fails | `_invalid`, reason=structural | invalid | no |
| B | Current-state predicate doesn't bind to us | `_audit`, reason=not-our-state | (not in manifest) | no |
| C-fail-proof | Any tx in chain has a proof that fails verification | `_invalid`, reason=proof-invalid | invalid | no |
| C-fail-continuity | Source-state continuity broken on any unfinalized tx | `_invalid`, reason=proof-invalid | invalid | no |
| D | One or more txs unfinalized; chain integrity intact | active pool, queue entries for each pending tx | pending | incoming-only |
| E-not-spent | All txs finalized, oracle confirms current state unspent | active pool | (continues to F) | (continues) |
| E-spent-our-tx | All txs finalized, oracle says spent, off-record tx is ours | `_audit`, reason=we-already-spent | (not in manifest) | no |
| E-spent-other | All txs finalized, oracle says spent, off-record tx is someone else's | `_audit`, reason=off-record-spend | (not in manifest) | no |
| F-conflict | Same `tokenId` with divergent chain in our pool | active pool | conflicting | spendable iff resolved |
| F-merge | Same `tokenId`, one chain extends the other (proof grafting) | active pool | valid or pending (depending on residual unfinalized) | per status |
| F-valid | All checks pass, no conflict | active pool | valid | spendable |
