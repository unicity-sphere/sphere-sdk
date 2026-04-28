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
  /** Transfer mode used by the sender. ADVISORY — recipient processes per
   *  bundle contents, not per this field. */
  readonly mode: 'conservative' | 'instant';
  /** Bundle CID — CIDv1, base32-encoded (multibase prefix 'b'). Always present. */
  readonly bundleCid: string;
  /** Token IDs the sender claims are in this bundle. ADVISORY ONLY —
   *  the recipient processes EVERY token-root element in the pool, filtered
   *  by current-state ownership at §5.3 [B]. Sender-asserted IDs are used
   *  for UI display + audit, not for security gating. Lowercase-hex,
   *  matches the BYTE_FIELDS canonical form for `tokenId`. */
  readonly tokenIds: readonly string[];
  /** Optional sender-supplied memo. UNAUTHENTICATED — outer envelope is
   *  not covered by `bundleCid`. */
  readonly memo?: string;
  /** Sender identity. UNAUTHENTICATED — `nametag` MUST be re-resolved
   *  against the Nostr signing pubkey via the identity-binding event
   *  before being displayed in UI. */
  readonly sender?: {
    /** 64-hex (32-byte secp256k1 x-coordinate, NIP-19 nsec-derived). */
    readonly transportPubkey: string;
    /** Plaintext nametag claim — display only after re-resolution. */
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

**Hard upper bound**: regardless of `inlineCapBytes`, the implementation enforces a relay-safe ceiling. The ceiling is determined at send-time by:

1. Probing the recipient's primary relay's NIP-11 `limitations.max_message_length` field. If the relay advertises one, that's the ceiling minus envelope overhead (~256 bytes).
2. If NIP-11 is unavailable or doesn't advertise the limit: a conservative default of **96 KiB**.

Above the ceiling, `force-inline` is rejected up-front with `INLINE_CAR_TOO_LARGE` before the bundle is built. If a `force-inline` send IS attempted within the local ceiling but the relay still rejects on publish (NIP-11 absent or stale), the publish failure is treated as `failed-transient` and the worker MAY auto-fall-back to CID delivery on retry — only if the caller's `delivery` strategy was `auto`. `force-inline` callers see the failure surfaced.

**Fetched-CAR size cap (recipient-side)**: when fetching via `kind: 'uxf-cid'`, the recipient enforces a maximum fetched-CAR size of **32 MiB** by default (configurable). Fetches whose Content-Length or running byte count exceeds the cap are aborted with `FETCHED_CAR_TOO_LARGE`. This is a DoS defense against malicious senders pinning huge CARs.

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
   - **v1.0 supports a single `(coinId, amount)` per `send()` call.** Sending multiple coin types from a multi-coin token in one transfer requires either multiple sequential `send()` calls or the future `sendMulti()` API (deferred — §12.2).
   - Each selected token MUST contain the requested `coinId`. A token MAY carry multiple distinct coin types (multi-coin tokens are supported by the SDK); in that case the token will be split (step 2) so only the requested `(coinId, amount)` is delivered.
   - Total of the requested coin's slices selected across the chosen tokens MUST sum to the requested transfer amount.

2. **Compute splits** (if needed). Three split scenarios:
   - **Single-coin amount split**: a single-coin token's balance exceeds the requested amount → split into `{tokenForRecipient, changeToken}` per existing split logic.
   - **Multi-coin token split (transfer carries only requested coin)**: a token carries the requested coin alongside other coin types → split into `{tokenForRecipient, residualToken}`, where `tokenForRecipient` carries ONLY the requested `(coinId, amount)` and `residualToken` carries every other non-zero coin balance plus the unsent remainder (if any) of the requested coin. The residual token stays with the sender.
   - **Zero-balance pruning**: when constructing the residual, coins with zero balance MUST be pruned from the new token's `coinData`. Carrying explicit zero entries inflates the token CBOR for no benefit.
   - Splits MAY be issued in instant mode (the parent's still-pending transaction does not invalidate child token identities — see the token-hash invariance note in §2.1). The `splitParent: tokenId` reference is recorded on each child for §6.1.1 cascade purposes.

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

### 4.4 TXF mode — sequence (legacy opt-in, both finalization variants)

TXF wire shape supports both finalization modes via `txfFinalization: 'instant' | 'conservative'` (default `'conservative'`).

#### 4.4.1 Conservative TXF (default)

```
1.  caller → PaymentsModule.send({recipient, amount, transferMode: 'txf',
                                  txfFinalization: 'conservative'})
2.  PaymentsModule:  for each token, build {sourceToken, transferTx} (or
                     COMBINED_TRANSFER / INSTANT_SPLIT shape per existing
                     SDK selection logic), submit commitment, await proof,
                     attach proof to transferTx.
3.  PaymentsModule:  persist outbox entry per-token (mode: 'txf',
                     deliveryMethod: 'txf-legacy', bundleCid: synthetic
                     'txf-' + tokenId)
4.  Transport:       send one Nostr TOKEN_TRANSFER event PER TOKEN
5.  PaymentsModule:  mark each outbox entry 'delivered'
6.  PaymentsModule:  archive sender's source tokens
7.  PaymentsModule:  emit transfer:confirmed event(s)
```

#### 4.4.2 Instant TXF

```
1.  caller → PaymentsModule.send({recipient, amount, transferMode: 'txf',
                                  txfFinalization: 'instant'})
2.  PaymentsModule:  for each token, build {sourceToken, transferTx} with
                     inclusionProof: null. Submit commitment to aggregator
                     (no await).
3.  PaymentsModule:  persist outbox entry per-token (mode: 'txf',
                     deliveryMethod: 'txf-legacy', status: 'delivered-instant',
                     commitmentRequestIds: [<the one for this tx>])
4.  Transport:       send one Nostr TOKEN_TRANSFER event PER TOKEN
5.  PaymentsModule:  apply unproven transaction locally; mark sender's
                     source tokens 'pending'
6.  PaymentsModule:  emit transfer:submitted event(s)
7.  (async) FinalizationWorker:
                     per-token finalization, per §6.1.
```

> **Recipient handling of instant-TXF**: an inbound legacy event with `inclusionProof: null` (or whose embedded transaction lacks a proof) is recognized as instant-TXF and routed through the same chain-mode finalization queue as instant-UXF arrivals. From §5.3 onward the disposition flow is identical (only §5.2 bundle-level checks are skipped, since there is no CAR / no bundleCid).

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

Before per-token disposition, the recipient performs **bundle-level checks**. Cryptographic verification of individual transactions and proofs is at §5.3 [C], NOT here — bundle-level checks are structural only.

1. **`pkg.verify()`** — UXF DAG integrity. The package verifier at `uxf/verify.ts` (WU-09) covers:
   - Per-block multihash (every block in the CAR has its declared CID).
   - Single-root CAR — `roots.length === 1` (multi-root CARs MUST be rejected per Wave G.5).
   - Root CID match — `roots[0] === payload.bundleCid` (sender lying about which CID their CAR represents → reject the entire bundle).
   - Type tag validity (every element has a known type).
   - Hash-match on all element references.
   - Cycle-free DAG (no element references itself transitively).
   - Depth cap (default 4096) and pool size cap (default 1M elements) — DoS bounds.
   Crypto checks (signatures, proofs) are NOT performed at this stage.
2. **Token ID claim consistency** — `payload.tokenIds` is advisory. The recipient MUST process every token-root element in the pool (subset, equal, or superset of `tokenIds`). Token-roots not in `tokenIds` are still subject to §5.3 ownership filtering at [B] — they are not "smuggled in" because [B] rejects anything whose current state doesn't bind to us.
3. **Chain-depth cap** — for every token-root in the pool, count unfinalized transactions. If any exceeds `MAX_CHAIN_DEPTH` (default 64), reject the entire bundle with `BUNDLE_REJECTED:chain-depth-exceeded`. (DoS defense — prevents 1000-tx-deep histories.)

If any bundle-level check fails, the entire bundle is rejected with a typed `BUNDLE_REJECTED` error; nothing is imported. This is logged and surfaced as a `transfer:rejected` event.

### 5.3 Per-token disposition — THE DECISION MATRIX

For each `tokenId` in `payload.tokenIds` AND for every other token-root element actually present in the bundle's pool (see §3.1 — `tokenIds` is *advisory*; the recipient processes every token-root element and filters by ownership at [B]), the recipient walks the following decision tree. Each branch leads to a specific `disposition` outcome with a specific storage action.

The matrix gates on **current-state ownership**, not genesis ownership: a token we receive via transfer was, by definition, originally minted to someone else, and that's perfectly normal. What matters is whether the token's *current* state binds to us.

**Throw / missing-element handling**: at any branch, if predicate evaluation throws (unknown predicate type, malformed bytes), if a referenced element is missing from the pool (orphan reference), or if cryptographic verification routines throw rather than return a status, the disposition is `STRUCTURAL_INVALID` (reason recorded). Throw-paths NEVER fall through silently.

```
For each token-root element in pool:
│
├─[A]─ Structural validation
│        Resolve manifest entry → root token-root element resolvable?
│        Every referenced element (predicates, prior states, txs, proofs,
│        certs) MUST be present in the pool. Walk DAG: type tags valid,
│        hashes match, predecessor links consistent.
│        ├─ FAIL (orphan ref, type-tag mismatch, hash mismatch, throw) →
│        │   disposition: STRUCTURAL_INVALID
│        └─ PASS → continue
│
├─[B]─ Last-state predicate target
│        After applying all transactions in the chain (proofs where present,
│        structural-only where absent), what is the current state?
│        Does its predicate bind to the recipient identity?
│        ├─ THROW (predicate evaluation fails — unknown type, malformed) →
│        │   disposition: STRUCTURAL_INVALID
│        ├─ FAIL (current state binds to a different identity — token was
│        │   once ours and transferred away, OR was never ours) →
│        │   disposition: NOT_OUR_CURRENT_STATE
│        │   (preserved for audit/diagnostic; not active inventory)
│        └─ PASS → continue
│
├─[C]─ Per-transaction cryptographic verification sweep
│        Walk every transaction in the chain (genesis through latest):
│          (1) ALWAYS verify the authenticator: ECDSA-verify
│              `authenticator.signature` over the canonical transaction
│              preimage against `sourceState.predicate.publicKey`.
│              This is mandatory regardless of finalization status —
│              forged authenticators MUST be detected at receive,
│              not deferred to aggregator-poll time.
│              ├─ verify FAILS → disposition: PROOF_INVALID and stop.
│              └─ verify THROWS (malformed signature/preimage) →
│                  disposition: STRUCTURAL_INVALID and stop.
│          (2) Verify source-state continuity: this tx's `sourceState`
│              MUST equal the previous tx's destination state (or the
│              genesis state for the first tx).
│              └─ FAIL → disposition: PROOF_INVALID and stop.
│          (3) If inclusionProof present → verify against trustBase
│              (full crypto: leaf hash, merkle path, validator signatures
│              on the unicityCertificate).
│              ├─ verify OK → mark this tx FINALIZED.
│              ├─ verify FAILS (PATH_INVALID / NOT_AUTHENTICATED) →
│              │   disposition: PROOF_INVALID and stop.
│              └─ verify THROWS / proof element references missing
│                  dependency → disposition: STRUCTURAL_INVALID and stop.
│          (4) If inclusionProof === null → mark this tx UNFINALIZED.
│        After the sweep:
│          unfinalizedCount = number of txs with no proof
│          allFinalized = (unfinalizedCount === 0)
│        Continue to [D] always (the conflict-merge step runs for every
│        token, finalized or not).
│
├─[D]─ Conflict / merge check (runs for ALL tokens, finalized OR pending)
│        Does our local pool already have a token with this tokenId?
│        ├─ YES, identical chain → no-op (idempotent receive); skip to
│        │   [E] for the existing entry.
│        ├─ YES, different chain — invoke resolveTokenRoot (Rule 3/4 JOIN
│        │   with verifiedProofs from the new bundle). This covers the
│        │   chain-mode merge case where one side has more finalized
│        │   transactions than the other (proof grafting is monotonic).
│        │   ├─ Resolved (one chain is a strict prefix or extension of
│        │   │   the other) → continue to [E] with the union token.
│        │   │   (recompute unfinalizedCount on the union)
│        │   └─ Genuinely divergent (both chains contain different
│        │       transactions from the same source state — should be
│        │       impossible with a non-faulty aggregator, but we plan
│        │       for it):
│        │       Tie-break: lex-min `bundleCid` wins primary; loser
│        │       stored as a `conflictingHeads[]` entry on the manifest.
│        │       disposition: CONFLICTING (terminal until operator or
│        │       aggregator response evicts the loser).
│        └─ NO → continue to [E] with the new token.
│
├─[E]─ Spent-check + finalization terminal
│        If unfinalizedCount > 0:
│          disposition: PENDING.
│          Every unfinalized tx is enqueued for finalization (§5.5).
│          isSpent check is DEFERRED until allFinalized — running it
│          now would be undefined (the destination state hasn't
│          stabilized).
│        Else (allFinalized):
│          oracle.isSpent(currentDestinationStateHash)?
│          ├─ FALSE → disposition: VALID
│          └─ TRUE  → disposition: UNSPENDABLE_BY_US
│              (the token's current state has been consumed by some
│              transaction not in the chain we hold. We do not attempt
│              to identify whether that off-record tx was ours or
│              someone else's — irrelevant for spendability.)
│
└─[F]─ Final disposition recorded; storage action per §5.4. PENDING
       tokens transition to VALID/UNSPENDABLE_BY_US automatically when
       finalization completes (§5.5 step 7), at which point the [E]
       spent-check runs and the [D] merge-check is re-run against any
       new arrivals.
```

**Disposition note — chain mode and §5.5 interaction**: a token may transition from `PENDING` to `VALID` (or `UNSPENDABLE_BY_US`, if a concurrent off-record spend has happened) either via the per-tx finalization sweep (§5.5 worker resolves every unfinalized tx) or via the §2.3 merge path (a later UXF copy of the same token brings in the missing proofs). Both paths converge to the same canonical state — see §6.3.

### 5.4 Storage outcomes

The matrix distinguishes **cryptographically broken** tokens (`PROOF_INVALID`, `STRUCTURAL_INVALID` — preserved for forensics) from **structurally valid but unspendable-by-us** tokens (`NOT_OUR_CURRENT_STATE`, `UNSPENDABLE_BY_US` — preserved for audit, possibly recoverable later).

| Disposition | Active inventory? | Counts in balance? | Storage location | Surfaces in UI |
|---|---|---|---|---|
| `VALID` | Yes | Spendable | active token pool, `manifest.status='valid'` | Wallet inventory |
| `PENDING` | Yes | Incoming (not spendable) | active token pool, `manifest.status='pending'`, every unfinalized tx queued | Wallet inventory with "pending" badge |
| `CONFLICTING` | Yes (winner) | Spendable iff resolved | active pool, `manifest.status='conflicting'` + `conflictingHeads[]` | Conflict-resolution view |
| `PROOF_INVALID` | No | No | `_invalid` collection (per-entry-key `${addr}.invalid.${tokenId}`), reason='proof-invalid' | Investigation view |
| `STRUCTURAL_INVALID` | No | No | `_invalid` collection, reason='structural' | Investigation view |
| `NOT_OUR_CURRENT_STATE` | No | No | `_audit` collection (`${addr}.audit.${tokenId}`), reason='not-our-state' | Audit view (off by default) |
| `UNSPENDABLE_BY_US` | No | No | `_audit` collection, reason='off-record-spend' | Audit view |

**Reason enum** (canonical, used in all `_invalid` and `_audit` records and in worker logs):

```typescript
type DispositionReason =
  | 'structural'         // [A] orphan ref / type-tag / hash mismatch / throw
  | 'predicate-eval'     // [B] predicate evaluation threw
  | 'auth-invalid'       // [C](1) ECDSA verify failed
  | 'continuity-broken'  // [C](2) source-state continuity broken
  | 'proof-invalid'      // [C](3) inclusionProof verify failed
  | 'proof-throw'        // [C](3) proof verify threw / orphan dep
  | 'oracle-rejected'    // §5.5 step 5 / §6.1 PATH_NOT_INCLUDED hard-error
  | 'not-our-state'      // [B] current-state predicate doesn't bind to us
  | 'off-record-spend';  // [E] oracle.isSpent=true on finalized chain
```

**Distinguishing forensics from audit**:
- `_invalid` — cryptographically broken tokens. The chain is bad; investigation typically points to a forged proof, a corrupted bundle, or a malicious sender.
- `_audit` — structurally valid tokens we just can't spend. The token might be recoverable: e.g., a `NOT_OUR_CURRENT_STATE` arrival might transition to `VALID` if a later transfer to us arrives and the current state then binds to us. The audit collection MUST NOT be wiped during routine cleanup.

**`_audit` is a NEW collection** introduced by this protocol. It does not exist in the codebase prior to Wave T.3 and MUST be added to `PROFILE_KEY_MAPPING` alongside the existing `invalidTokens` key.

**`_audit` state transitions**:

```typescript
type AuditStatus =
  | 'audit-not-our-state'     // disposition: NOT_OUR_CURRENT_STATE
  | 'audit-off-record-spend'  // disposition: UNSPENDABLE_BY_US
  | 'audit-promoted';         // a later transfer made the token ours;
                              // the audit entry is retained as cross-reference,
                              // a fresh manifest entry is created in the
                              // active pool with status='valid'
```

A periodic re-scan (out of scope here, deferred per §12.2) MAY transition `audit-not-our-state` entries to `audit-promoted` if a later transfer's chain makes the same `tokenId` bind to us at current state. Promotion MUST NOT delete the audit entry — it cross-references the new active-pool manifest entry for forensic traceability.

**Retention**:
- `_invalid`: indefinite by default; user can manually `cleanupInventory()` to clear.
- `_audit`: indefinite by default. Even after promotion, the original audit record is retained.

### 5.5 Per-token finalization (chain-mode landing path)

When a `PENDING` token enters the pool, **one entry per unfinalized transaction in the chain** is added to a per-address **finalization queue**. A token with K unfinalized transactions yields K queue entries; the token transitions from `pending → valid` only when all K are resolved (or it transitions to `invalid` if any one hard-fails — see step 5).

**Chain depth bound (DoS defense)**: the recipient MUST reject bundles whose tokens have more than `MAX_CHAIN_DEPTH` unfinalized transactions in any single token's history (default **64**, configurable). Bundles exceeding the limit raise `BUNDLE_REJECTED:chain-depth-exceeded` at §5.2 — before any finalization queue is populated.

```typescript
interface FinalizationQueueEntry {
  tokenId: string;
  bundleCid: string;             // for cross-reference
  txIndex: number;               // position in token.transactions[]; 0 = genesis-adjacent oldest unfinalized
  commitmentRequestId: string;   // computed locally from (signedTx, sourceState)
  signedTransferTxBytes?: Uint8Array; // present iff this hop's tx came from the incoming bundle;
                                      // resolution falls back to the in-pool token by
                                      // (tokenId, txIndex) if absent
  submittedAt: number;           // for backoff scheduling
  retryCount: number;
  source: 'sent' | 'received';   // sender's outbox vs recipient's queue
}
```

The finalization worker (see §6) processes each entry. For each pending tx:

1. Resolve `signedTransferTxBytes`: prefer the queue-entry field, fall back to the in-pool token at `(tokenId, txIndex)`. If neither has it, mark the queue entry `STRUCTURAL_INVALID` (reason='structural') and remove. The token transitions to `invalid`.
2. Compute `commitmentRequestId` locally from `(signedTx, sourceState)`. This MUST match the queue entry's stored value (defensive consistency check).
3. If the worker has not yet seen evidence the commitment was submitted: submit it to the aggregator. The aggregator's submit endpoint is idempotent — submitting an already-known commitment returns immediately. (Re-submission also covers the faulty-aggregator case where the aggregator dropped the first submission; see §6.1 retry-on-belief rule.)
4. Poll `aggregator.getInclusionProof(commitmentRequestId)` until a proof is returned or a hard error (`PATH_NOT_INCLUDED`, `PATH_INVALID`) is observed.
5. **On proof retrieval (atomic transaction in OrbitDB)**:
   - The proof element is content-hashed and added to the pool.
   - The pending transaction's `inclusionProof` child is updated from `null` to the new proof's ContentHash.
   - **Token identity does NOT change.** Per the audit in §2.1, `token.id` derives from `genesis.data.tokenId` and is immutable; `TransferTransactionData.calculateHash()` excludes the inclusion proof from the data hash. What DOES change is the *CBOR serialization* of the token (the proof bytes are now present), and therefore its *content-address (CID)*.
   - **Manifest CID rewrite** (introduced in this protocol, Wave T.5 — NOT Wave H, which is unrelated null-hash canonicalization): the OrbitDB profile manifest entry for this `tokenId` is updated to point at the new CID. The previous (proof-less) CID is **tombstoned** in the manifest so older copies are not re-served from peer caches.
   - Queue entry removed.
   - All four updates (pool write, manifest CID rewrite, tombstone insert, queue removal) happen in a single OrbitDB transaction — partial application across crashes is impossible.
6. **On hard error (`PATH_NOT_INCLUDED` / `PATH_INVALID`)**: the spec's threat model treats the aggregator as **faulty, never hostile** — but a faulty aggregator can still return wrong errors. Hard-rejection is a **strong hint, not authoritative**:
   - Increment a `hardErrorCount` on the queue entry.
   - If `hardErrorCount < MAX_HARD_ERROR_RETRIES` (default 3): re-submit the commitment + re-poll. (Retry-on-belief: per §6.1, the worker keeps retrying as long as the local cryptographic checks pass — the sender / forwarder believes the commitment is valid.)
   - If `hardErrorCount >= MAX_HARD_ERROR_RETRIES`: mark the entry hard-failed, transition the token to `manifest.status='invalid'` (reason='oracle-rejected'), move to `_invalid`. Already-attached proofs from K-1 successful queue entries are kept on the now-invalid token (forensic value); only the manifest's *primary* CID is tombstoned. Queue is fully cleared for this `tokenId`.
7. **On transient error**: increment retry count, back off, retry.
8. **Queue-drain → status transition (atomic)**: when the worker finishes processing a queue entry, it MUST atomically check (within the same OrbitDB transaction): "are there any remaining queue entries for this `tokenId` that are NOT in a terminal-success state?"
   - If NO remaining + no hard-failed entries: transition `manifest.status: pending → ?`. Re-run [E] (oracle.isSpent on the now-finalized current state) to choose between `'valid'` and `'unspendable'`. Re-run [D] merge-check against any new pool arrivals that landed during finalization. Re-emit `transfer:incoming` with `confirmed: true` if `valid`.
   - If hard-failed entries exist: terminal `invalid` per step 6.

**Tombstone retention**: tombstoned manifest CIDs are retained for `TOMBSTONE_RETENTION_DAYS` (default 30) after the canonical CID has been stable. After that, the tombstone is GC'd to prevent unbounded manifest growth in long-lived wallets.

**Merge-path finalization (§2.3)**: when another UXF copy of the same token arrives carrying additional proofs, those proofs are grafted into the local pool via the Wave G.3 enrichment rules. Each grafted proof eliminates the corresponding queue entry without an aggregator round-trip — same atomic update pattern as step 5.

### 5.6 Replay / duplicate / merge handling

All of the following are **idempotent and convergent**; nothing requires special-casing beyond the §5.3 decision matrix:

- **Same `bundleCid` arrives twice**: re-process is wasted compute (suppressed by the LRU optimization in §5.1) but cannot diverge from the first processing.
- **Same `bundleCid`, different outer-envelope fields claimed** (`mode`, `tokenIds`, `sender.nametag`): the outer envelope is NOT covered by `bundleCid`. Processing semantics depend ONLY on the bundle contents (proofs present, predicates resolvable, etc.); outer fields are advisory. `tokenIds` is treated as advisory — the recipient processes every token-root element in the pool, filtered by ownership at [B]. Do NOT trust `sender.nametag` for UI display unless re-resolved against the Nostr signing pubkey.
- **Same `tokenId` arrives in two bundles from different senders**: handled by `[D]` conflict check; `resolveTokenRoot` decides. Tie-break for genuinely-divergent chains: lex-min `bundleCid` wins primary.
- **Same `tokenId` arrives carrying additional proofs while a `PENDING` entry exists** (the chain-mode merge case): the new proofs are grafted into the existing entry via Wave G.3 enrichment. Queue entries for now-finalized txs are removed. If all unfinalized txs become finalized, the [E] re-run determines `valid`/`unspendable`. The token stays put — no rebuild — only its CID may change.
- **Two copies of the same `tokenId` arrive with different transaction sets**: if one chain's transaction set is a strict prefix of the other (i.e., one was forwarded again before some hops finalized, the other is the longer history), `resolveTokenRoot` selects the longer chain and grafts in any proofs the shorter chain carries. Proof grafting is monotonic — proofs accumulate, never delete.

**Idempotency invariant (MUST)**: the disposition of a token MUST never regress. Specifically:
- A `valid`/`archived` token MUST NEVER transition back to `pending` on receive — replay of an older copy is a no-op for status.
- A `pending` token's queue entries can only be REMOVED (proof attached, hard-failed) — never re-added for the same tx index unless §5.5 step 8's re-run found a new merge that added the tx.
- An `invalid` token MUST NEVER transition out of `_invalid` — a later valid copy of the same `tokenId` is treated as `CONFLICTING` (and stored with the conflicting-heads list) but the existing invalid disposition is preserved for forensics.

---

## 6. Asynchronous Finalization

Both the **sender** (for instant-mode-sent tokens) and the **recipient** (for any pending tokens) run finalization workers. The two workers are independent — they do not coordinate — and the protocol is designed so they converge to the same valid local state without exchanging messages.

A worker may need to resolve **multiple unfinalized transactions per token** (chain-mode tokens, §2.3). Both workers walk the entire transaction history, not just the latest tx.

### 6.1 Sender-side finalization worker

Trigger: outbox entry with `status: 'delivered-instant'` and one or more outstanding `commitmentRequestIds`. The list MAY contain entries for transactions the sender did not author (chain-mode forwards inherit a list of unfinalized inbound txs that the sender now also has an interest in resolving, since the token won't transition to `valid` locally until they're done).

**Threat model**: the aggregator is **faulty, never hostile**. It may drop submissions, return transient errors, or even briefly return wrong hard-errors — but it will not collude to poison the token pool. The worker's strategy is therefore: trust the local cryptographic checks, persist the belief that "if our checks pass, the commitment IS valid," and re-submit until the aggregator agrees or the retry budget is exhausted.

Loop (default poll: 30s with exponential backoff up to 5 min):

```
For each pending requestId in outbox.commitmentRequestIds:
   resolve signedTx (queue entry first, fall back to in-pool token).
   re-verify locally: ECDSA authenticator + source-state continuity +
     commitmentRequestId derivation. If any fails → terminal
     STRUCTURAL_INVALID for the queue entry.
   submit commitment to aggregator (idempotent — re-submission of an
     already-known commitment is a no-op).
   try fetchInclusionProof(requestId):
     proof.verify(trustBase, requestId):
       OK → attach proof atomically per §5.5 step 5 (token.id unchanged;
            only CID changes). Remove requestId from outbox.
       PATH_INVALID / NOT_AUTHENTICATED →
            log a security note (the proof itself is well-formed but
            doesn't verify against trustBase — possible forged proof OR
            faulty aggregator). Increment hardErrorCount. If <
            MAX_HARD_ERROR_RETRIES (default 3): retry. If >=: mark
            queue entry hard-failed.
       PATH_NOT_INCLUDED →
            aggregator says the commitment isn't in the SMT. Increment
            hardErrorCount. If < MAX_HARD_ERROR_RETRIES: re-submit the
            commitment (the aggregator may have dropped it) and re-poll.
            If >=: mark queue entry hard-failed.
     no response (transient) →
            increment retryCount; reschedule with backoff.
   if all requestIds for tokenId are resolved AND no hard-failed entries:
     transition outbox entry to 'finalized'.
   if any requestId is hard-failed (retries exhausted):
     transition outbox entry to 'failed-permanent', cascade per §6.1.1.
```

#### 6.1.1 Cascade on hard-rejection

When a queue entry hard-fails (retries exhausted), the token is marked invalid. **Locally derived child tokens** of this token (splits / forwards the sender minted in instant mode while this token was still pending) are now also invalid — their parent's chain is dead. The worker MUST:

1. Identify all locally-stored tokens whose chain references this `tokenId` as a parent split (look up `splitParent` field on the manifest).
2. Cascade `manifest.status = 'invalid'` (reason='parent-rejected') to each child.
3. Move each cascaded child to `_invalid` with reason='parent-rejected', `parentTokenId: <this token's id>`.
4. Emit `transfer:cascade-failed` for any outgoing bundles in the outbox that reference the cascaded children — best-effort notification to downstream recipients (delivery is informational; the recipient will independently arrive at the same `'invalid'` disposition via their own §5.3 [C](3) check when their workers poll the aggregator for the failed tx).

Cascade is **monotonic** — a cascaded `invalid` disposition cannot be reversed even if the aggregator later somehow returns a valid proof for the parent's tx (which it shouldn't, given the threat model — but if it does, the operator must explicitly re-import the bundle).

#### 6.1.2 Outbox terminal states

- `finalized` — every proof attached cleanly.
- `failed-permanent` — any oracle hard-rejection after `MAX_HARD_ERROR_RETRIES`. Operator may inspect via `_invalid` records and decide whether to escalate.
- `failed-transient` — transient errors exhausted the retry budget. Worker stops; operator MAY trigger manual retry via `payments.retryFinalize(outboxEntryId)`.

### 6.2 Recipient-side finalization worker

Same logic as 6.1 but driven from the per-address finalization queue (§5.5) rather than the outbox. Each `tokenId` in the queue may have K entries (one per unfinalized tx); the token transitions `pending → valid` only when all K resolve to `OK`.

The merge path (§5.5 last paragraph) provides an alternative: if a more-finalized UXF copy of the same token arrives via Nostr / IPFS / backup-import, its proofs are grafted into the local pool, eliminating the corresponding queue entries without an aggregator round-trip.

### 6.3 Convergence guarantees

**Claim**: an instant-mode transfer that succeeds at the aggregator will eventually transition to `valid` on BOTH sender and recipient, regardless of whether the chain has 1 or K unfinalized transactions and regardless of the order in which proofs become available.

**Two distinct kinds of equality** matter for convergence:

1. **Token identity (`token.id`) equality** — by design, immutable: derived from `genesis.data.tokenId`, never changes across proof attachment. Both sides agree on `token.id` from the moment the bundle is opened.
2. **Token CID equality** — the IPFS content-address of the serialized token. This DOES change when proofs are attached (the CBOR encoding gains the proof bytes). Both sides converge to the SAME final CID *only when they have attached the same set of proofs*.

**Proof sketch**:
1. For each unfinalized tx, the aggregator publishes its proof at most once **assuming the aggregator is not faulty** (idempotency of `getInclusionProof`). This is documented behavior of `aggregator-go`'s JSON-RPC `get_inclusion_proof` method; not yet asserted by an SDK-level regression test, but implementations SHOULD add one. If a faulty aggregator returns two structurally-different-but-both-valid proofs for the same requestId (different witness paths through the same SMT), the protocol canonicalizes by selecting the proof with the lexicographically-minimum CID — this is the byte-identical proof both finalizers will keep after merge.
2. Both finalizers fetch each pending proof independently. Both attach byte-identical `inclusion-proof` elements to byte-identical transaction objects.
3. The transaction's data hash (`TransferTransactionData.calculateHash()`) is unchanged — proofs are not in its preimage. So the per-tx CID changes (the encoded form is different) but the `transactionHash` referenced *by* the inclusion proof remains the same.
4. The token's `id` is unchanged throughout. The token's CID — the content-address of its CBOR encoding — converges once both sides have the same proof set attached.
5. Both manifests update `tokenId → newCid` and set `status='valid'` once all unfinalized txs in the chain are resolved AND the [E] re-run confirms `oracle.isSpent === false`.
6. Subsequent `pkg.merge` between the two pools dedupes via Wave G.3 (identical content → identical CID); the merge is a no-op.

**Failure mode (aggregator hard-rejects a commitment)**: both finalizers retry up to `MAX_HARD_ERROR_RETRIES`, then mark the token `invalid` per §6.1. Convergent on the invalid disposition. The token stays in `_invalid` on both sides.

**Asymmetric-knowledge mode (one side has more proofs than the other, no network)**: as long as the more-knowledgeable copy reaches the lagging side via any channel (a second Nostr delivery, a backup import, an IPFS pull) the merge is monotonic — proofs accumulate. Convergence does not require both sides to ever reach the aggregator.

**Stuck-PENDING escape hatch**: if neither side reaches the aggregator AND they don't reach each other, the token is `PENDING` indefinitely. The SDK exposes `payments.importInclusionProof(tokenId, proofBytes)` which validates the proof against the trustBase; if it matches an outstanding queue entry's requestId, it is grafted in (same atomic update as §5.5 step 5). UI surfaces stuck-pending tokens after a configurable timeout (default 7 days) so the operator can paste in a proof obtained out-of-band.

**Crash recovery**: outbox + finalization queue are persisted to OrbitDB; both survive process restart. After restart, the worker resumes polling. The atomic-update rule in §5.5 step 5 ensures no double-attach. Pre-publish persistence ordering: the OrbitDB write that sets `status: 'sending'` (or `'delivered-instant'`) MUST be committed before the Nostr publish is dispatched; if the crash lands between OrbitDB commit and Nostr publish, the worker re-publishes on restart (idempotent for the recipient — bundleCid is content-addressed; same input → same bundle).

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

The outbox is stored in **OrbitDB**. PROFILE-ARCHITECTURE.md §10.12 declares the static key as `{addr}.outbox`; at runtime, the Wave G.7 per-entry-key writer expands this to per-entry keys of the form `${addr}.outbox.${id}` for cross-device visibility and multi-process safety. Implementations MUST follow PROFILE-ARCHITECTURE.md §10.12 — this spec does not redefine the key shape.

### 7.0 Status transition table

Outbox entries follow this state machine. Transitions outside the table are forbidden (in particular: `finalized → sending` MUST never happen on a CRDT merge — see §7.2 OrbitDB invariants).

```
Initial: packaging

  packaging  ──pin/encode complete──► [pinned]  (UXF cid-mode only; UXF car-mode skips this)
  packaging  ──serialize complete───► sending   (UXF car-mode + TXF)
  pinned     ──ipfs pin acknowledged─► sending

  sending    ──Nostr publish ack ────► delivered          (conservative UXF, conservative TXF)
  sending    ──Nostr publish ack ────► delivered-instant  (instant UXF, instant TXF)
  sending    ──publish error ────────► failed-transient

  delivered  ──garbage-collected────► (terminal: removed)
  delivered-instant ──worker starts──► finalizing
  finalizing ──all proofs attached──► finalized
  finalizing ──hard-error budget ────► failed-permanent
  finalizing ──transient budget ─────► failed-transient

  failed-transient ──manual retry────► sending
  failed-transient ──cap ────────────► failed-permanent

  finalized       ──garbage-collected► (terminal: removed)
  failed-permanent (terminal — operator inspection only)
```

### 7.1 OrbitDB CRDT invariants

The outbox is persisted in OrbitDB. OrbitDB has eventual-consistency (CRDT) semantics across replicas (e.g., desktop wallet + browser wallet for the same identity). To prevent state-machine corruption under replica merge:

- `status` updates use a **monotonic state machine** as the LWW resolution rule. The transition graph above defines the partial order; on replica merge, the *more advanced* state wins. (E.g., `delivered-instant` > `sending`; `finalized` > `delivered-instant`.)
- `commitmentRequestIds` is naturally idempotent (set semantics) — replica merge unions the sets.
- `retryCount` and `hardErrorCount` use max-merge across replicas (CRDT G-counter shape).
- `error` field is overwritten by the most recent status-advancing replica.
- Spend protection comes from the aggregator (which enforces single-spend at the SMT level), not from the outbox. A replica rollback that re-creates an outbox entry for an already-transferred source state will fail at the next aggregator submission with `PATH_NOT_INCLUDED`, and the worker's `MAX_HARD_ERROR_RETRIES` budget will then surface the failure. The outbox is bookkeeping, NOT a spend lock.

### 7.2 Migration from legacy outbox

Source schema (`types/txf.ts:150` — `OutboxEntry`): per-token records with fields `id, status, sourceTokenId, salt, commitmentJson, recipientPubkey, recipientNametag?, amount, createdAt, updatedAt, error?, retryCount?`.

Migration on first read:
1. Group by `(recipientPubkey, createdAt-window)` — entries created within 60s for the same recipient become a single bundle.
2. Construct a synthetic `UxfTransferOutboxEntry` per group:
   - `mode: 'txf'` — legacy was always TXF wire shape with conservative-style finalization.
   - `bundleCid: 'txf-' + tokenId` for single-token entries; `'legacy-' + recipientPubkey + '-' + createdAt` for combined ones.
   - `deliveryMethod: 'txf-legacy'`.
   - `recipient`: prefer `'@' + recipientNametag` if present, else `recipientPubkey` (preserves UI display continuity).
   - `recipientTransportPubkey`: copied from `recipientPubkey`.
3. Mark `status: 'finalized'` if the legacy entry is `delivered` or `confirmed`; otherwise map to the closest UxfTransferOutboxEntry status (e.g., legacy `pending → 'sending'`, legacy `failed → 'failed-permanent'`).
4. The migration MUST preserve `recipientNametag` even when the new outbox entry's primary `recipient` field is the pubkey form — store it in the synthetic entry as part of the `error` field's metadata if no first-class slot exists, or extend the schema if needed.

Migration is one-way; once migrated, the legacy collection is cleared.

---

## 8. Token Statuses (Extended)

PROFILE-ARCHITECTURE.md §10.11 defines statuses `valid | invalid | conflicting | pending`. The receive flow uses the same enum with the following per-disposition mapping:

| Recipient disposition | manifest.status | Notes |
|---|---|---|
| VALID | `valid` | spendable |
| PENDING | `pending` | one or more txs in chain unfinalized; queued (§5.5) |
| CONFLICTING | `conflicting` | `conflictingHeads[]` populated; lex-min `bundleCid` is primary |
| PROOF_INVALID | `invalid` | reason ∈ {`auth-invalid`, `continuity-broken`, `proof-invalid`}; in `_invalid` |
| STRUCTURAL_INVALID | `invalid` | reason ∈ {`structural`, `predicate-eval`, `proof-throw`}; in `_invalid` |
| NOT_OUR_CURRENT_STATE | (audit only) | `_audit` collection (NEW — Wave T.3), reason='not-our-state' |
| UNSPENDABLE_BY_US | (audit only) | `_audit` collection, reason='off-record-spend' |

The on-chain spent state is checked via `oracle.isSpent(stateHash)` — a single round-trip per finalized arriving token (cached per Wave L's bounded LRU at `oracle/UnicityAggregatorProvider.ts:158-172,608-634`). For chain-mode tokens, the spent check is **deferred** until all unfinalized txs are resolved (running it earlier would be meaningless — `isSpent` of an unproven destination state is undefined). When finalization completes (§5.5 step 8), the worker re-runs [E] before transitioning the token from `pending` to terminal.

---

## 9. Error Handling and Edge Cases

### 9.1 Bundle delivery fails (Nostr publish error)

- Retry via outbox `failed-transient` state with exponential backoff up to a hard cap (default 24 hours).
- After cap: `failed-permanent`. Local bookkeeping is updated to reflect that the bundle did not reach the recipient.

**Why double-spend is impossible at the protocol level**: the aggregator enforces single-spend at the SMT level. Once a commitment for source state S has been accepted, the aggregator will reject any subsequent commitment from S with `PATH_NOT_INCLUDED`. The local outbox status is bookkeeping; it does NOT gate spend protection. If the sender's `failed-permanent` recovery path attempts a fresh `send()` from the same source token (e.g., to a different recipient because the original delivery failed), one of two things happens:
1. The original commitment WAS accepted by the aggregator → the new send will fail at submission time with `PATH_NOT_INCLUDED`. The sender's worker treats this per §6.1 (retries up to budget, then `failed-permanent`). The token is genuinely already-transferred.
2. The original commitment was NEVER accepted → the new send succeeds normally. The first transfer never happened on-chain.

In neither case is double-spend possible. The aggregator's single-spend invariant is the trust anchor; outbox state cannot violate it.

For **conservative mode** with delivery failure post-acceptance: the on-chain commitment exists (token is spent according to the aggregator), but the recipient never learned. Recovery options:
- Re-send the same UXF bundle (same CID — idempotent at the recipient).
- If re-send is also impossible (recipient's relays unreachable indefinitely), emit `transfer:lost` — funds are effectively burned from the recipient's perspective. Out-of-band coordination (operator support) is the recovery path.

For **instant mode** with delivery failure: same recovery — the sender's local finalizer continues polling the aggregator; if finalization succeeds, the sender knows the on-chain transfer happened; the recipient is permanently unaware. Re-send retains idempotency (same bundleCid).

### 9.2 Recipient gateway can't fetch CID

- Recipient walks all configured gateways (default + user-overridden).
- All fail → emit `transfer:fetch-failed` event; do NOT acknowledge to sender.
- Sender's outbox times out at retry deadline; treats as transient and retries the SAME Nostr event.
- After cap: `failed-transient`. Sender SHOULD attempt CAR-embed re-delivery if the bundle is small enough.

### 9.3 Recipient receives a UXF bundle from an unknown sender

- The Nostr event is signed (pubkey verified by relay). Sender identity at the WIRE layer is trusted, but `payload.sender.nametag` is plaintext-attacker-controllable and MUST NOT be displayed in UI without re-resolving against the Nostr signing pubkey via the identity-binding event.
- The UXF bundle is content-addressed and verified independently per §5.2 + §5.3.
- If the recipient has no prior relationship with the sender pubkey:
  - Optional friend-list / spam-filter consultation (out of scope here; existing transport-level mechanism).
  - If accepted: process per §5.
  - If rejected by spam policy: drop the bundle without further processing.

**Threat-model note**: encrypted Nostr DMs already disclose the recipient's pubkey to anyone who wants to attempt delivery, so silent-drop is NOT motivated by hiding online presence. The reason for not surfacing rejection acknowledgments is to avoid amplifying spam — an attacker probing for live recipients via crafted bundles. Legitimate senders whose payload is rejected for content reasons (e.g., capability mismatch, force-cid bundle that fails to fetch) DO surface a typed error to the application layer; only spam-policy rejections are silent.

### 9.4 Aggregator hard-rejection (PATH_NOT_INCLUDED / PATH_INVALID)

The aggregator rejected a commitment. Per §6.1 retry-on-belief, the worker retries up to `MAX_HARD_ERROR_RETRIES` (default 3) before treating the rejection as terminal. After the budget is exhausted:

- The specific failing transaction is marked invalid (reason='oracle-rejected').
- Per §6.1.1 cascade rule, locally-derived child tokens of this token are also marked `'invalid'` with reason='parent-rejected'.
- The **source token (parent)** is untouched — the failed transition is treated as if it never happened. The aggregator's single-spend invariant means the token remains in its prior valid state in the original owner's pool.

**No refund / reversal protocol is needed** (per §12.1).

**Mode-specific severity**:
- **Instant mode**: this is a routine outcome — the sender shipped before knowing the aggregator's verdict. The sender / recipient simply mark the attempted transfer invalid and move on. No security implications.
- **Conservative mode**: the sender retrieved the proof BEFORE shipping the bundle. A `PATH_NOT_INCLUDED` at the recipient side after a conservative-mode delivery means EITHER (a) the proof was forged (sender malicious or buggy), OR (b) the aggregator's state has changed since the proof was issued (validator dispute / BFT fork — extremely unusual). This is a `transfer:security-alert` event, NOT a routine no-op. The recipient surfaces it for operator review.

For the chain-mode case, only the specific failing tx is invalidated and the cascade rule fires for downstream children. Finalization for other unfinalized txs in the same token's chain continues independently — but the moment any tx hard-fails, the WHOLE token is invalid (the chain has a broken link), so the other queue entries are cleared per §5.5 step 6.

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

Callers that don't specify any of these get the UXF bundle behavior in instant mode with the 16 KiB auto cutoff.

> **Breaking-widening note**: extending `TransferMode` from `'instant' | 'conservative'` (existing) to `'instant' | 'conservative' | 'txf'` is non-breaking for runtime code paths, but breaking for any TypeScript exhaustiveness check (`switch(mode) { case 'instant': … case 'conservative': … }` without a default arm). Affected call sites must add the `'txf'` arm explicitly. Audit will be performed in Wave T.7.

There is **no automatic capability-based fallback** from UXF to TXF. The capability hint in the recipient's identity binding (informational) MAY surface a UI warning, but the SDK never silently switches modes. If a peer is known to be TXF-only, the caller selects `'txf'` explicitly.

### 10.2 Recipient side

`handleIncomingTransfer(...)` recognizes payloads and routes per shape:
- `kind: 'uxf-car' | 'uxf-cid'` → UXF flow (§5).
- Legacy shapes (indefinitely accepted, no deprecation), as actually implemented in `modules/payments/PaymentsModule.ts:5897-5985`:
  - `{sourceToken, transferTx, memo?, sender?}` (Sphere TXF)
  - `{type: 'COMBINED_TRANSFER', version: '6.0', tokens: [...]}` (V6 combined; carries N child tokens)
  - `{type: 'INSTANT_SPLIT', version: '4.0' | '5.0', ...}` (split-output; carries N child tokens)

For each legacy shape, the recipient runs an internal **adapter** that converts the inbound payload into UXF-equivalent disposition passes through §5.3. Bundle-level checks (§5.2) are skipped — there is no CAR and no bundleCid. **Each legacy event becomes ONE OR MORE disposition records**, one per token in the event payload:
- `{sourceToken, transferTx}` → 1 record
- `COMBINED_TRANSFER` with N tokens → N records
- `INSTANT_SPLIT` with N split outputs → N records

A TXF-mode sender and a UXF-aware recipient produce the same set of disposition outcomes (VALID / PENDING / PROOF_INVALID / STRUCTURAL_INVALID / NOT_OUR_CURRENT_STATE / UNSPENDABLE_BY_US / CONFLICTING) — just one *per token*, regardless of how the wire layer packaged it.

**Instant-TXF inbound recognition**: a legacy event whose embedded transaction has `inclusionProof: null` is recognized as instant-TXF and routed through the chain-mode finalization queue (§5.5). The recipient does not need a special wire-level field to detect this — the absence of the proof is the signal.

### 10.3 Outbox migration

Per §7.2: existing per-token outbox entries are migrated to bundle-grained on first read; `recipientNametag` is preserved.

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
- Hostile-bundle scenarios: STRUCTURAL_INVALID, PROOF_INVALID, NOT_OUR_CURRENT_STATE, UNSPENDABLE_BY_US, CONFLICTING. Each surfaces correctly.

### 11.3 Compatibility tests

- TXF-mode sender → UXF-aware recipient: legacy adapter produces correct dispositions for all 4 legacy shapes; tokens land in the OrbitDB profile.
- UXF-mode sender → TXF-only recipient (simulated): send fails with typed error; caller's explicit retry with `transferMode: 'txf'` succeeds.
- Outbox migration: legacy per-token entries become bundle-grained correctly; TXF entries stay per-token with `deliveryMethod: 'txf-legacy'`.
- Capability hint: identity binding declares `wireProtocols: ['txf']` only — sender UI warns; SDK does NOT auto-switch.

### 11.4 Adversarial tests (steelman seeds)

- Sender claims `mode: 'conservative'` but bundle has unfinalized transactions → recipient processes per bundle contents (mode field is advisory); token enters `pending`.
- Sender claims `mode: 'instant'` but bundle has all proofs → recipient processes per §5.3; token enters `valid` after oracle isSpent check.
- Bundle CID hash collision (sender forges a DIFFERENT CAR with the same root CID — only possible via SHA-256 collision, theoretical) → defended at the per-block hash-verify stage of `UxfPackage.fromCar`.
- CAR with multiple roots (smuggling attempt) → rejected at `pkg.verify()` step (§5.2 #1 — multi-root MUST fail, normative).
- Bundle DAG contains token-roots NOT in `payload.tokenIds` (smuggling attempt) → recipient processes them anyway, [B] ownership filter rejects ones that don't bind to us → `NOT_OUR_CURRENT_STATE` in `_audit`.
- Forged `payload.sender.nametag` (attacker claims `@victim`) → recipient discards plaintext nametag, re-resolves against Nostr signing pubkey via identity binding → mismatch surfaced.
- Replay: identical bundleCid sent 100 times → 1 processed, 99 short-circuited via LRU; if LRU evicts, re-processing is benign (idempotent per §5.6 invariant).
- Instant-mode + concurrent split: 5 split outputs all unfinalized → 5 separate finalizations → all converge. Parent's still-pending tx is also finalized in parallel.
- Recipient's local clock skewed by 30 days → finalization worker still runs (no clock-dependent guards).
- Chain-mode forwarder dies mid-chain: the token's queue carries entries for the predecessor's pending tx; finalization still completes via the local worker (predecessor's signedTx is in the bundle the forwarder received).
- Forged authenticator on an unfinalized tx (tx claims to be signed by previous owner but isn't) → §5.3 [C](1) ECDSA verify fails → `PROOF_INVALID`. **Critical**: this MUST be detected at receive, not deferred to aggregator-poll time.
- **Bandwidth-burning peer**: malicious sender forwards a 10-deep chain where tx #3's commitment was rejected at the aggregator. Recipient's worker hits `PATH_NOT_INCLUDED` after 3 retries on tx #3, marks token invalid. Test verifies (a) the bundle is processed correctly, (b) the recipient applies a peer-reputation penalty (configurable cooldown, e.g., 1-hour silent-drop window for further bundles from that pubkey), (c) chain-depth cap fires for bundles with >64 unfinalized txs.
- **Faulty-aggregator path**: aggregator returns `PATH_NOT_INCLUDED` for a commit the sender's local crypto verifies as valid → worker re-submits up to `MAX_HARD_ERROR_RETRIES`; if the aggregator eventually accepts (intermittent fault) → token finalizes correctly; if all retries exhausted → token marked invalid with reason='oracle-rejected'.
- **Conservative-mode post-send PATH_NOT_INCLUDED** (security event): test that the recipient emits `transfer:security-alert` rather than treating it as a routine no-op.
- **OrbitDB CRDT replica merge**: simulate two replicas writing different `status` updates for the same outbox entry concurrently — verify monotonic-state-machine LWW resolution (more-advanced state wins), no `finalized → sending` regressions.
- **Stuck-PENDING escape**: token is `pending` for >7 days; operator pastes in a proof via `payments.importInclusionProof()` → proof grafts in, token transitions to `valid`.

---

## 12. Resolved and Deferred Questions

### 12.1 Resolved

- **Refund / reversal protocol on aggregator rejection**: NOT needed. If the aggregator rejects a commitment submission (`PATH_NOT_INCLUDED`), the transaction is treated as if it never happened — the source token is still in its prior valid state. Both sender and recipient mark the *attempted* transition as invalid, but the underlying token is unchanged. No reversal flow required. (Per-history-tx invalidations propagate up to the whole-token level; see §5.5 step 5 + §6.3 failure mode.)
- **Aggregator-driven inbound discovery**: NOT possible. The aggregator never holds the full transaction — only its commitment. A recipient who never received the Nostr/UXF delivery cannot reconstruct the token from the aggregator alone. Existing payment-request + reconciliation flows are the recovery path.

### 12.2 Deferred

- **Bundle compression**: CARs can be sizeable for many-token bundles (especially chain-mode tokens with deep history). zstd / brotli on the inline-CAR path? Out of scope for v1.0.
- **Multi-recipient bundles**: a single UXF bundle delivered to a Nostr group / multicast — nice to have, deferred. Would amortize CID-pin cost across N recipients and allow group-level atomic broadcasts. Open design points: per-recipient encryption envelope vs. shared symmetric key, group-membership consent.
- **Audit-collection promotion scanner**: a periodic re-scan that promotes `_audit` entries (`audit-not-our-state`) to `audit-promoted` if a later transfer makes them ours. State machine defined in §5.4 but the scanner itself is deferred.
- **Multi-coin send in a single call**: v1.0 `PaymentsModule.send()` accepts a single `(coinId, amount)`. Sending multiple coin types from a multi-coin token in one transfer requires either multiple calls or a future `sendMulti()` API.
- **Conflict-resolution UI/API**: `CONFLICTING` tokens (genuinely-divergent chains) need an explicit `resolveConflict(tokenId, chosenHead)` API and UI surface. Lex-min `bundleCid` provides an automatic primary, but operator override is a planned future addition.
- **Peer-reputation framework**: §11.4 mentions a 1-hour cooldown on bandwidth-burning peers. The reputation interface itself is out of scope here.

---

## 13. Implementation Plan (deferred to UXF-TRANSFER-IMPL-PLAN.md)

The implementation will land in waves:

- **Wave T.1** — Wire-format types. `UxfTransferPayload` discriminated union, `DeliveryStrategy`, `transferMode: 'instant' | 'conservative' | 'txf'`, `txfFinalization: 'instant' | 'conservative'`, payload encode/decode helpers, unit tests. Audit and update existing `TransferMode` exhaustiveness checks (breaking-widening per §10.1). Add `_audit` collection key to `PROFILE_KEY_MAPPING`. Define `DispositionReason` and `AuditStatus` enums.
- **Wave T.2** — Sender bundle construction for **conservative mode** (UXF wire) + CAR-embed delivery with the 16 KiB default cap + `force-inline` / `force-cid` / custom `inlineCapBytes` per-call overrides. NIP-11 relay-discovery for the inline ceiling. Conservative ships first because the chain has no unfinalized tail when it goes out. Sender also walks the source token's history and finalizes any inherited pending txs before bundle build.
- **Wave T.3** — Recipient bundle ingest + decision matrix + storage outcomes. Implements §5.3 [A]–[F] including:
  - Throw-path → STRUCTURAL_INVALID escapes at every branch.
  - Mandatory ECDSA authenticator verification at [C](1) — full crypto, not deferred.
  - Single-root + multi-root rejection as a normative MUST.
  - Chain-depth cap (default 64) as a hard reject at §5.2.
  - Fetched-CAR size cap (default 32 MiB) as a hard reject during gateway pull.
  - `_audit` collection (NEW) at `${addr}.audit.${tokenId}` with promotion semantics.
  - `tokenIds` is advisory; recipient processes every token-root in the pool and filters at [B].
  - No instant-mode handling yet (recipient rejects bundles whose `mode === 'instant'` with a typed soft-error so T.2-only deployments don't drop tokens silently).
- **Wave T.4** — CID-pin delivery for large bundles (sender uses the already-pinned outbox CID; recipient fetches via verified-CAR pipeline with the 32 MiB cap). Adds `delivery: 'force-cid'` regression tests.
- **Wave T.5** — Instant mode + finalization workers. Critical scope:
  - Bundle carries the signed unfinalized transfer-tx; both sides poll the aggregator independently.
  - Workers walk the **entire transaction history** of every pending token (multi-tx queue entries per token).
  - Atomic OrbitDB updates per §5.5 step 5: pool-write + manifest-CID-rewrite + tombstone + queue-removal in one transaction.
  - Manifest-CID-rewrite is **NEW** in this wave (NOT Wave H — Wave H is unrelated null-hash canonicalization).
  - Tombstone retention (default 30 days post-canonical-stable).
  - Merge-path enrichment: arriving a more-finalized copy of an existing pending token grafts proofs in (Wave G.3 rule 4 extension).
  - Retry-on-belief loop in §6.1: hard-rejections retried up to `MAX_HARD_ERROR_RETRIES` because the aggregator may be faulty (not hostile).
  - Cascade-on-hard-rejection per §6.1.1.
  - `payments.importInclusionProof()` API for the stuck-PENDING escape hatch.
  - `transfer:security-alert` event for conservative-mode post-send PATH_NOT_INCLUDED.
- **Wave T.6** — Outbox refactor. Bundle-grained `UxfTransferOutboxEntry` for UXF modes, per-token entries for TXF mode. Status transition table per §7.0. OrbitDB CRDT invariants per §7.1 (monotonic LWW). Migration from the legacy per-token `OutboxEntry` preserving `recipientNametag`. Crash-recovery tests covering mid-chain restart with pre-publish persistence ordering.
- **Wave T.7** — TXF mode as explicit opt-in: `transferMode: 'txf'` + `txfFinalization` routes to the per-token Nostr event pipeline (both conservative and instant variants). Sender outbox uses the new schema with `deliveryMethod: 'txf-legacy'`. Receiver-side adapter routes the three legacy shapes (`{sourceToken, transferTx}`, `COMBINED_TRANSFER`, `INSTANT_SPLIT`) through the §5.3 decision matrix per-token (one event → ONE OR MORE disposition records); merges into OrbitDB profile when enabled. Inbound shape with `inclusionProof: null` is recognized as instant-TXF.
- **Wave T.8** — Capability hint surfacing (informational `wireProtocols` field in identity binding) + UI warnings + the `INLINE_CAR_TOO_LARGE` / `FETCHED_CAR_TOO_LARGE` error paths. Peer-reputation cooldown (deferred — design only). Integration / compatibility / adversarial tests covering chain mode, multi-coin tokens, faulty-aggregator paths, OrbitDB CRDT merge, stuck-PENDING escape, security-alert events.

Each wave goes through the standard recursive steelman review before merge.

---

## Appendix A: Disposition Reference Table

Branches reference the §5.3 decision matrix (A through F, plus the [D]/[E] subdivisions).

| Branch | Trigger | Storage | manifest.status | Counts in balance? |
|---|---|---|---|---|
| A | DAG type-check / hash-match / orphan-ref / throw at structural validation | `_invalid`, reason=`structural` | invalid | no |
| B-throw | Predicate evaluation throws (unknown type, malformed) | `_invalid`, reason=`predicate-eval` | invalid | no |
| B-not-ours | Current-state predicate evaluates cleanly but doesn't bind to us | `_audit`, reason=`not-our-state` | (audit only) | no |
| C-auth | ECDSA authenticator verification fails on any tx | `_invalid`, reason=`auth-invalid` | invalid | no |
| C-continuity | Source-state continuity broken on any tx | `_invalid`, reason=`continuity-broken` | invalid | no |
| C-proof | Inclusion-proof present and verifies as PATH_INVALID / NOT_AUTHENTICATED | `_invalid`, reason=`proof-invalid` | invalid | no |
| C-throw | Crypto verify throws or proof element references missing dependency | `_invalid`, reason=`proof-throw` (also recorded as `structural`) | invalid | no |
| D-conflict | Same `tokenId` with divergent chain in our pool, lex-min wins primary | active pool, `conflictingHeads[]` populated | conflicting | spendable iff resolved |
| D-merge | Same `tokenId`, one chain extends the other → monotonic proof graft | active pool | valid OR pending (depending on residual unfinalized) | per status |
| D-fresh | No conflict, new entry to pool | (continues to E) | — | — |
| E-pending | One or more txs unfinalized; queue per-tx entries | active pool, `manifest.status='pending'` | pending | incoming-only |
| E-valid | All txs finalized, `oracle.isSpent === false` | active pool | valid | spendable |
| E-unspendable | All txs finalized, `oracle.isSpent === true` (off-record spend) | `_audit`, reason=`off-record-spend` | (audit only) | no |
