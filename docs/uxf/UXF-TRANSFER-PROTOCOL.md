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

**Source-side opt-in** (`allowPendingTokens`): the sender's `payments.send()` call accepts an `allowPendingTokens?: boolean` option (default `false`). When `false` (default), the source-token selector considers ONLY tokens with `manifest.status === 'valid'` (fully finalized) — chain mode never arises from local sends. When `true`, the selector MAY pick `pending` tokens to satisfy the requested amount. Selection priority is strict:

1. **First, satisfy the requested amount from `valid` (finalized) tokens.** Only if the finalized inventory cannot cover the requested `(coinId, amount)` does the selector spill over to step 2.
2. **Then, top up the shortfall from `pending` tokens** in arrival order (oldest pending first), each contributing whatever balance it has of the requested coin.

The result: an `allowPendingTokens: true` send produces chain-mode transfers only when finalized funds are insufficient — never to "use pending preferentially." If after both steps the requested amount is still uncovered, `send()` rejects with `INSUFFICIENT_BALANCE` (the SDK does NOT attempt to send a partial amount).

A receiver may be handed a token with K unfinalized transactions in its history (K ≥ 1) when:

- The original sender used instant mode WITH `allowPendingTokens: true` and the source token was itself pending (1 or more unfinalized inherited from a chain-mode ancestor).
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

- **Default**: `transferMode: 'instant'` over UXF, `allowPendingTokens: false` — instant UXF non-chained. Minimizes UX latency; uses only finalized source tokens.
- **Caller override**: `PaymentsModule.send({ transferMode, txfFinalization?, delivery?, allowPendingTokens? })`.
  - `transferMode: 'instant'` (default) — UXF bundle, async finalization (§2.1).
  - `transferMode: 'conservative'` — UXF bundle, full-history finalization-before-send (§2.2). Recommended for high-value transfers, escrow, swap deposits.
  - `transferMode: 'txf'` — legacy per-token wire (§2.4). Pair with `txfFinalization: 'instant' | 'conservative'` (default `'conservative'`).
  - `allowPendingTokens: false` (default) — source-token selector considers only `valid` tokens; `INSUFFICIENT_BALANCE` if finalized funds don't cover.
  - `allowPendingTokens: true` — selector may spill over to `pending` tokens after exhausting `valid` ones. Enables chain mode (§2.3). Selection priority is strict: finalized-first, then pending-by-age.
- **Splits MAY be instant**: token-hash invariance under proof attachment (verified above) means split-and-mint flows can issue child tokens with status `'pending'` referencing a still-unfinalized parent. The parent's proof, when later attached, does not invalidate the child's identity. This is a **deliberate change** from the prior assumption that splits required conservative-mode finalization.
- **Forced conservative remains** for cross-protocol bridges (e.g., into a non-UXF chain) where the destination requires finalized state. The implementation surfaces such overrides in the call result. `allowPendingTokens` is silently coerced to `false` in forced-conservative paths since pending tokens cannot be conservatively-shipped (their predecessor txs aren't finalized).

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

**Hard upper bound**: regardless of `inlineCapBytes`, the implementation enforces a fixed conservative ceiling of **96 KiB** for inline CAR bytes. This is the safe default for typical Nostr relay deployments. If the caller provides `delivery: { kind: 'auto', inlineCapBytes: N }` with `N > 96 KiB`, the SDK MUST silently clamp `inlineCapBytes` to 96 KiB — auto mode never publishes inline above the relay-safe ceiling regardless of user override. Implementations MAY instead reject such a configuration with `INVALID_INLINE_CAP` at startup; the choice is implementation-defined but the clamp/reject behavior MUST be deterministic.

> **NIP-11 relay-discovery is NOT in scope for v1.0.** A future revision MAY probe the publishing relay's NIP-11 `limitations.max_message_length` to dynamically size the ceiling, but the current `transport/NostrTransportProvider.ts` does not implement NIP-11. Implementations MUST use the fixed 96 KiB cap until the discovery extension lands (deferred — §12.2).

Publish-time rejection handling: if a `force-inline` send is attempted within the 96 KiB cap but the chosen relay still rejects on publish (relay-specific limit lower than the default, or temporary capacity issue), the publish failure is treated as `failed-transient` (§7.0). For `delivery: 'auto'` senders, the worker auto-falls-back to `uxf-cid` on retry. For `delivery: 'force-inline'` senders, the failure surfaces — the caller chose force-inline explicitly and must handle the relay-rejection branch.

**Fetched-CAR size cap (recipient-side)**: when fetching via `kind: 'uxf-cid'`, the recipient enforces a maximum fetched-CAR size of **32 MiB** by default (configurable). Fetches whose Content-Length or running byte count exceeds the cap are aborted with `FETCHED_CAR_TOO_LARGE`. This is a DoS defense against malicious senders pinning huge CARs.

#### 3.3.2 Delivery-completion semantics (normative)

The sender's outbox can only mark a transfer "complete" (status `delivered` or `delivered-instant`, eligible for GC) once specific conditions are met. The recipient's "delivered" state is reached at a different point. These semantics differ between inline and CID delivery:

**Inline delivery (`kind: 'uxf-car'`)**:
- **Sender** considers the bundle delivered as soon as the Nostr publish is acknowledged by at least one configured relay (the relay durably persisted the encrypted event). The CAR bytes traveled inside the Nostr event itself; no separate IPFS persistence is required. Outbox transitions `sending → delivered` (or `delivered-instant`).
- **Recipient** considers the bundle delivered when the Nostr event arrives, decryption succeeds, and `UxfPackage.fromCar(base64Decode(payload.carBase64))` returns successfully (i.e., the CAR parses and the root CID matches `payload.bundleCid`). No external network fetch is required.

**CID delivery (`kind: 'uxf-cid'`)**:
- **Sender** considers the bundle delivered ONLY AFTER both of the following are confirmed:
  1. The CAR has been persisted to IPFS — the local Helia node OR an external pinning service has acknowledged the pin AND the CID is retrievable via at least one verifiable route.
  2. The Nostr event carrying the CID reference has been acknowledged by at least one relay.
  Both confirmations are required because either alone is insufficient: a Nostr event referencing an unpinned CID is undeliverable; a pinned CID with no Nostr notification leaves the recipient unaware. The sender's outbox MUST NOT transition `sending → delivered` (or `delivered-instant`) until both confirmations land. Implementations MAY use an intermediate `pinning` sub-state during the IPFS-persist phase (already in §7.0 transition table).
- **Recipient** considers the bundle delivered ONLY when **physically syncing the bundle from IPFS by the CID received via Nostr**. Receiving the Nostr event alone does NOT constitute delivery — the recipient must successfully fetch the CAR from IPFS (with the §3.3.1 32 MiB cap and verified-CAR pipeline) before any state transitions occur. If the IPFS fetch fails for all configured gateways within retry budget, the bundle is NOT delivered; the recipient emits `transfer:fetch-failed` and does not acknowledge the sender. This semantics applies BOTH for instant and conservative modes.

**Outbox cleanup**: a "completed" UXF bundle transfer (status `delivered` for conservative/TXF, or `finalized` for instant) MAY be safely removed from the outbox per the retention window (§7.0 `delivered → expired` transition). For CID delivery, "completed" requires BOTH the IPFS pin AND Nostr publish acknowledged — never one alone.

Test cases for these semantics are enumerated in §11.2 (integration tests).

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

**Canonical asset model** (per the underlying Unicity state-transition SDK; verified against `@unicitylabs/state-transition-sdk` `lib/transaction/split/TokenSplitBuilder.js`, `lib/transaction/TransferTransactionData.d.ts`, `lib/token/Token.d.ts`):

- A **coin token** is a token with non-empty `coinData` carrying one or more `(coinId, amount)` entries. Coin tokens MAY be split: the SDK's `TokenSplitBuilder` consumes the source via burn-then-mint and produces N new outputs, each with a fresh `tokenId`. The builder enforces (a) every output has non-empty `coinData`, (b) the union of output coin types equals the parent's coin types exactly (no dropping a coin type), (c) per-coin amounts are conserved across outputs.
- An **NFT token** is a token with empty / null `coinData`, distinguished solely by its unique `tokenId`. NFT tokens CANNOT be split (the split builder rejects empty-coinData inputs). NFT tokens are transferred WHOLE via `TransferTransaction` — the source `tokenId`, `tokenType`, and identity data are preserved verbatim; only the current-state predicate changes.

**Class predicate (normative)** — implementations MUST use exactly this rule to classify a token at runtime:

```
isNft(token: Token): boolean =
  token.coins === null || token.coins === undefined || token.coins.length === 0
```

where `token.coins` is the post-prune list of fungible coin entries. Implementations MUST prune zero-amount entries (`amount === '0'`) from `coinData` at ingest time (deserialization from CAR or storage) so that the class predicate is stable. A token with `coinData: [{coinId, amount: '0'}]` MUST be normalized to `coinData: []` before the class check fires. This avoids the ambiguous case where `[{amount: '0'}]` could be classified inconsistently across implementations.

> **Note on common NFT patterns**: this protocol's NFT model is "empty coinData" — distinct from the Ethereum-NFT-as-balance-of-1 pattern (where `coinData: [{coinId: <NFT-id>, amount: '1'}]` represents the NFT). Tokens following the Ethereum pattern are CLASSIFIED AS COINS by this protocol's predicate (non-empty coinData) and transferred via split, not whole-token. If a future revision adds explicit support for the Ethereum-style pattern, it would require a new asset kind discriminator (e.g., `kind: 'erc1155-balance'`) extending the union per §10.4.
- **No mixed-asset tokens**: this protocol does NOT permit a single token to carry both a non-empty `coinData` AND a separable "NFT identity." Every token's `tokenId` is unique by construction, but the protocol treats a token as one OR the other, not both. A future protocol revision MAY introduce a primitive that preserves `tokenId` while modifying `coinData`; until then, attempts to model mixed-asset tokens are out of scope.

This canonical model has direct consequences for §4.1 below: NFT transfers are always whole-token (no split, no change); coin transfers may split but never produce empty-coinData outputs; the two operations cannot be combined on a single source token.

1. **Validate inputs** — the request carries one or more **asset targets**, each of which is either a fungible coin slice or a whole-token (NFT) reference.

   ```typescript
   type AssetTarget =
     | { kind: 'coin'; coinId: string; amount: string }     // fungible
     | { kind: 'nft';  tokenId: string };                   // whole-token / NFT
   ```

   The target list is constructed from the `TransferRequest`:
   - Primary slot (`coinId` + `amount`): both fields are OPTIONAL. If both are present, prepend `{ kind: 'coin', coinId, amount }` to the target list. If both are absent, the request has no primary entry. (Note: the `coinId` and `amount` fields remain *required by the type* in the SDK's TransferRequest declaration for backward compatibility with v1.0 callers; semantically they are optional from the protocol's perspective, and the implementation wave will extend the type to optional fields explicitly.)
   - `additionalAssets`: each entry's `kind` discriminator selects between coin and NFT shapes; appended to the target list verbatim.
   - Resulting `targetList = [primaryIfPresent, ...additionalAssets]`.

   Validation:
   - If `targetList.length === 0` → `EMPTY_TRANSFER` rejection.
   - `additionalAssets === undefined` and `additionalAssets === []` are semantically identical (both reduce the target list to `[primaryIfPresent]`).
   - **Discriminator forward-compat**: receivers MUST reject any `additionalAssets` entry whose `kind` is not in the union recognized by the implementation (`UNKNOWN_ASSET_KIND`). Silent skip would change transfer semantics. Senders MUST NOT include unrecognized kinds when targeting a recipient who advertises an older protocol version.
   - All `kind: 'coin'` entries' `coinId` values MUST be distinct, INCLUDING the primary slot's `coinId` if present. Duplicates → `INVALID_REQUEST` (the caller should sum into one entry — typically the primary).
   - All `kind: 'nft'` entries' `tokenId` values MUST be distinct. Duplicates → `INVALID_REQUEST` (cannot transfer the same NFT twice in one call).
   - Each `kind: 'coin'` entry's `amount` MUST be > 0 (no exceptions; no placeholder convention).
   - All source tokens MUST be currently owned (current-state predicate binds to sender).
   - **Coin-target coverage**: for each `kind: 'coin'` target `(coinIdᵢ, amountᵢ)`: the union of coin source tokens MUST collectively contain at least `amountᵢ` of `coinIdᵢ`. A single coin source token MAY contribute to multiple coin targets if it carries multiple of the requested coin types.
   - **NFT-target coverage**: for each `kind: 'nft'` target `{tokenId}`: the sender's pool MUST contain an NFT token (empty/null coinData) with that exact `tokenId` whose current state binds to the sender. If a token with the requested `tokenId` exists but has non-empty coinData (i.e., it's a coin token, not an NFT), reject with `INSUFFICIENT_BALANCE` reason='nft-not-owned' — coin tokens cannot satisfy NFT targets.
   - **Asset-class disjointness**: NFT and coin source tokens are disjoint sets — a single source token contributes to either coin targets OR an NFT target, never both.
   - If any target is uncoverable, `send()` rejects with `INSUFFICIENT_BALANCE`. Partial shipment is never attempted.

2. **Compute splits / build transfer transactions**. The protocol has TWO independent operations, applied per source token:

   **NFT source (empty-coinData token, satisfies one `kind: 'nft'` target)**: build a `TransferTransaction` that state-transitions the source whole to the recipient. The recipient receives a token with the SAME `tokenId`, `tokenType`, and identity data as the source — only the current-state predicate changes. No split. No change token.

   **Coin source (non-empty-coinData token, contributes slices to one or more `kind: 'coin'` targets)**: apply the SDK's `TokenSplitBuilder`:
   - **`tokenForRecipient`**: contains EXACTLY the slices this source token contributes to the target list. If the source contributes to multiple coin targets (it carries multiple requested coin types), `tokenForRecipient` carries multiple coin entries. The recipient token has a FRESH `tokenId` (split mints a new token).
   - **`changeToken`**: contains everything left in the source AFTER subtracting all contributed slices: (a) the unrequested portion of any contributed coin, (b) all non-requested coin types in the source. The change token has a FRESH `tokenId` and is minted to the sender's identity.
   - **Builder invariants enforced** (per `TokenSplitBuilder.js`):
     - Every output MUST have non-empty `coinData`. The protocol satisfies this by construction: `tokenForRecipient` carries at least one slice (it satisfies a coin target); `changeToken` carries the remainder (non-empty unless the source's contributed slices exactly equal its total, in which case there is no change token at all — a `TokenSplitBuilder` operation with a single output equivalent to the source's amounts ).
     - Output coin types ⊆ parent coin types; per-coin sums conserved.
   - **Whole-source-amount special case**: if a coin source's total balance for a coin equals the requested slice, AND the source carries no other coin types (i.e., the slice consumes the source entirely), the SDK MAY use a single state-transition (no split, no change) instead of a split-with-change. Implementation-defined optimization.

   **Source-class enforcement**: the implementation MUST verify each source token's class (NFT vs coin) BEFORE building transactions. Citing an NFT source for a coin target (or vice versa) is a programming error and SHOULD be caught at validation (§4.1 step 1) — but the per-source operation here is a final guard.

   **Worked examples**:
   - **Single-coin transfer** (source `{UCT:100}`, target `(coin, UCT, 30)`) → split: recipient `{UCT:30}` (fresh tokenId), change `{UCT:70}` (fresh tokenId).
   - **Single-coin transfer from multi-coin source** (source `{UCT:100, USDU:50}`, target `(coin, UCT, 30)`) → split: recipient `{UCT:30}`, change `{UCT:70, USDU:50}`. Non-requested USDU carried entirely into change.
   - **Multi-coin transfer covered by ONE source** (source `{UCT:100, USDU:50, ALPHA:1000}`, targets `(coin, UCT, 30) + (coin, USDU, 20)`) → split: recipient `{UCT:30, USDU:20}`, change `{UCT:70, USDU:30, ALPHA:1000}`.
   - **Multi-coin transfer covered by MULTIPLE sources** (source A `{UCT:100}`, source B `{USDU:50}`, targets `(coin, UCT, 30) + (coin, USDU, 20)`) → split A: recipient-A `{UCT:30}` + change-A `{UCT:70}`; split B: recipient-B `{USDU:20}` + change-B `{USDU:30}`. Recipient gets TWO child tokens; bundle carries both.
   - **NFT-only transfer** (source NFT-token `Tᴺ` with empty coinData, target `(nft, tokenId=Tᴺ.id)`) → whole-token state-transition: recipient gets `Tᴺ'` with `tokenId=Tᴺ.id` preserved, coinData still empty, current state binds to recipient. No split, no change token.
   - **Mixed coin + NFT bundle (separate sources)** (source A `{UCT:100}`, NFT source B with empty coinData; targets `(coin, UCT, 30) + (nft, tokenId=B.id)`) → split A: recipient-A `{UCT:30}` + change-A `{UCT:70}`; whole-transfer B: recipient-B `B'` (preserved id). Recipient gets two child tokens; bundle carries both. Change is one token `{UCT:70}`.

   **NOT supported** (do not appear in the worked examples; would require a future protocol primitive):
   - Extracting an NFT identity from a coin-bearing source while leaving coins behind. The current SDK split mints fresh `tokenId`s, breaking identity preservation; whole-token transfer of such a source ships the coins along with the NFT.
   - Combining a coin slice and an NFT identity into a single recipient token. Each source's transaction is independent; coin slices and NFT identities arrive as separate tokens.

   - Splits MAY be issued in instant mode (the parent's still-pending transaction does not invalidate child token identities — see the token-hash invariance note in §2.1). The `splitParent: tokenId` reference is recorded on each child for §6.1.1 cascade purposes.

   **NFT cascade asymmetry warning** (operational, not a protocol error): when `allowPendingTokens: true` is combined with NFT targets, a pending NFT source CAN be transferred in chain mode. If the source's predecessor tx hard-fails, §6.1.1 cascade marks the recipient's NFT invalid. **Coin cascades cost fungible value (replaceable from elsewhere); NFT cascades cost non-fungible identity (irrecoverable — no other peer can produce the same `tokenId`)**. Implementations SHOULD warn the caller when an NFT target is satisfied by a pending source — the caller MAY pass `confirmNftPending: true` to acknowledge the risk explicitly. (Defaults: `confirmNftPending: false`; sending pending NFTs without explicit acknowledgement → `NFT_PENDING_REQUIRES_CONFIRMATION` rejection.)

> **Multi-asset send status (current)**: `PaymentsModule.send()` supports single-coin (legacy), multi-coin, NFT-only, and mixed coin+NFT transfers via the optional `additionalAssets: AdditionalAsset[]` field on `TransferRequest`, where `AdditionalAsset` is a discriminated union `{kind:'coin', coinId, amount} | {kind:'nft', tokenId}`. The protocol enforces NFT/coin disjointness — every source token belongs to exactly one class. NFT transfers are always whole-token (no split, no change); coin transfers may split. See `docs/API.md` for the type signature and `docs/INTEGRATION.md` for usage examples. The protocol is asset-kind agnostic at the discriminator level; future asset kinds extend the union (subject to forward-compat reject rule above).

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

In **instant mode**, the outbox entry persists until finalization completes for **every** transaction the sender contributed to the chain (typically 1, but K if the sender forwarded a chain-mode token). It carries `outstandingRequestIds` and `completedRequestIds` so the async finalizer knows which proofs to fetch (per §6.1 error model). Sustained `PATH_NOT_INCLUDED` across the polling window is treated as terminal hard-fail; transient `PATH_NOT_INCLUDED` (a single snapshot before anchor) just means "keep polling."

In **TXF mode**, the outbox entry is per-token and short-lived (same lifecycle as conservative-UXF, but with `deliveryMethod: 'txf-legacy'` and `bundleCid: 'txf-' + tokenId`). Instant-TXF entries follow the instant-UXF lifecycle but at per-token granularity.

---

## 5. Recipient Flow

### 5.0 Concurrency model — N parallel bundle workers

Incoming bundles are processed by a **pool of parallel workers** (default `MAX_INGEST_WORKERS = 16`, configurable). When a Nostr `TOKEN_TRANSFER` event arrives, it is enqueued on a bounded ingest queue (default 256 entries) and dispatched to the next free worker.

**Why parallelism is required**: a single rogue incoming bundle (e.g., one with a chain-mode token requiring K=64 unfinalized-tx finalization queue, or a `uxf-cid` bundle whose IPFS fetch is slow) would otherwise serialize behind every other legitimate bundle. With N workers, slow bundles consume a single worker each; the other N-1 continue serving fresh arrivals. This is a **DoS defense** against an attacker who deliberately crafts long-running bundles.

**Worker isolation**:
- Each worker runs §5.1–§5.3 for its assigned bundle independently. Per-tokenId mutexes (§5.5 step 9) coordinate workers when two bundles target the same `tokenId`; otherwise workers proceed in parallel.
- Bundle-level errors (CAR parse failures, gateway timeouts) terminate the worker's processing of that bundle without affecting others. The worker returns to the dispatcher to pick up the next queued bundle.
- The ingest queue itself is bounded: if all `MAX_INGEST_QUEUE_SIZE` (default 256) slots are occupied, new arrivals are dropped with `INGEST_QUEUE_FULL` and the sender's outbox eventually times out (`failed-transient`). This is a hard back-pressure signal — the recipient cannot keep up — and a configurable monitoring metric.

**Per-worker resource caps** (each worker enforces independently):
- §3.3.1 32 MiB fetched-CAR cap.
- §5.2 #3 chain-depth cap.
- §5.2 #4 unclaimed-roots cap.
- §5.5 finalization queue depth (capped per-tokenId, not per-worker).

**Bundle-internal token parallelism**: within one bundle, all token-roots are processed by the SAME worker sequentially (no inner parallelism). This keeps per-bundle ordering consistent for §5.6 idempotency invariants. Cross-bundle parallelism is the protection against rogue inputs.

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
3. **Chain-depth cap (per-token, with smuggling defense)** — apply `MAX_CHAIN_DEPTH` (default 64 unfinalized txs) per-token, with the following two-tier rule to prevent griefing-via-smuggled-roots:
   - For every token-root in `payload.tokenIds` (the sender's claim): if depth > MAX_CHAIN_DEPTH, **reject the entire bundle** with `BUNDLE_REJECTED:chain-depth-exceeded`. The sender claimed it; the sender is responsible.
   - For every token-root in the pool but NOT in `payload.tokenIds` (smuggled): if depth > MAX_CHAIN_DEPTH, **silently drop that token-root** from processing. The legitimate claimed tokens are still processed normally. This prevents an attacker from griefing a legitimate transfer by attaching a deep unclaimed root.

   Post-merge depth: if a `[D-merge]` operation produces a union token whose unfinalized-tx count exceeds MAX_CHAIN_DEPTH (because the local pool extended the chain beyond the cap), the merge proceeds but the resulting token's `manifest.status` is `pending` and a warning is logged — we trust our own pool's prior state. Only INCOMING bundles' fresh chains are capped.

4. **Smuggled-roots count cap (`_audit` DoS defense)** — count only DAG elements with type-tag `token-root` (or any future root-equivalent type-tag — see fail-closed rule below) that are NOT in `payload.tokenIds`. Sub-DAG dependencies (predicates, prior-state references, transactions, inclusion proofs, certificates) are NOT counted — they have different type-tags. Precise formula:
   ```
   const ROOT_EQUIVALENT_TYPES = new Set(['token-root']);  // extend in lockstep with schema evolution
   unclaimedRoots = pool.elements.filter(e =>
     ROOT_EQUIVALENT_TYPES.has(e.type) && !payload.tokenIds.includes(e.tokenId)
   ).length;
   ```
   If `unclaimedRoots > MAX_UNCLAIMED_ROOTS` (default 16), reject the entire bundle with `BUNDLE_REJECTED:too-many-unclaimed-roots`. The honest case has zero or a few unclaimed roots (sub-DAG dependencies are NOT token-roots — they're sub-elements). Without this cap, an attacker shipping 10K depth-1 unowned roots fills the recipient's `_audit` collection unboundedly via NOT_OUR_CURRENT_STATE dispositions.

   **Forward-compat (fail-closed)**: if the recipient encounters a top-level DAG element with a type-tag NOT recognized by its current implementation, it MUST log a warning AND count that element toward `MAX_UNCLAIMED_ROOTS` (treat as a potentially-smuggled root by default). Spec extensions adding new root-equivalent type-tags MUST update `ROOT_EQUIVALENT_TYPES` in lockstep across implementations to avoid breaking honest senders.

If any other bundle-level check fails, the entire bundle is rejected with a typed `BUNDLE_REJECTED` error; nothing is imported. This is logged and surfaced as a `transfer:rejected` event.

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
│              on the unicityCertificate). Outcomes per
│              InclusionProofVerificationStatus:
│              ├─ OK → mark this tx FINALIZED.
│              ├─ PATH_INVALID → disposition: PROOF_INVALID
│              │   (reason='proof-invalid') and stop. (Proof structure
│              │   malformed.)
│              ├─ NOT_AUTHENTICATED → disposition: PROOF_INVALID
│              │   (reason='proof-invalid') and stop. (Validator
│              │   signatures don't verify against trustBase. Note:
│              │   this is also a transfer:trustbase-warning event —
│              │   most likely our trustBase is stale; active forgery
│              │   is out of scope per §9.4.1.)
│              ├─ PATH_NOT_INCLUDED → disposition: PROOF_INVALID
│              │   (reason='proof-invalid') and stop. (Sender claimed
│              │   the proof anchors the tx, but the proof is in fact
│              │   a verifiable proof of NON-existence. The sender
│              │   lied or the proof is stale.)
│              └─ verify THROWS / proof element references missing
│                  dependency → disposition: STRUCTURAL_INVALID
│                  (reason='proof-throw') and stop.
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
│        │   │   the other) → continue to [B'] (re-run ownership check
│        │   │   on the union token — the merged chain may have changed
│        │   │   who owns the current state).
│        │   └─ Genuinely divergent (both chains contain different
│        │       transactions from the same source state — should be
│        │       impossible with a non-faulty aggregator, but we plan
│        │       for it):
│        │       Tie-break: lex-min `bundleCid` (compared as raw
│        │       CIDv1 binary form, NOT base32 string) wins primary;
│        │       loser stored as a `conflictingHeads[]` entry on the
│        │       manifest. disposition: CONFLICTING (terminal until
│        │       operator or aggregator response evicts the loser).
│        └─ NO → continue to [E] with the new token.
│
├─[B']─ Re-run ownership check on merged token (after [D-merge] only)
│        After resolveTokenRoot produced a union token, the union may
│        contain transactions our pool's prior copy didn't include —
│        possibly including a transfer-out we authored. Re-evaluate the
│        current-state predicate on the union's terminal state.
│        ├─ FAIL (current state of merged chain doesn't bind to us;
│        │   e.g., the merge surfaced a transfer-out we already did) →
│        │   disposition: NOT_OUR_CURRENT_STATE
│        │   (move to _audit; the pre-merge entry, if any, is also
│        │   superseded — the merge represents a more-canonical view)
│        └─ PASS → continue to [E].
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
       finalization completes (§5.5 step 9), at which point the [E]
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
| `PROOF_INVALID` | No | No | `_invalid` collection (key form below), reason='proof-invalid' | Investigation view |
| `STRUCTURAL_INVALID` | No | No | `_invalid` collection, reason='structural' | Investigation view |
| `NOT_OUR_CURRENT_STATE` | No | No | `_audit` collection (key form below), reason='not-our-state' | Audit view (off by default) |
| `UNSPENDABLE_BY_US` | No | No | `_audit` collection, reason='off-record-spend' | Audit view |

**Key shapes for `_invalid` and `_audit` (multi-representation aware)**:

The active pool is keyed by `tokenId` because there is at most ONE canonical disposition per token (conflicts surface via `conflictingHeads[]` on the single entry). However, the `_invalid` and `_audit` collections MUST allow MULTIPLE records per `tokenId` because:
- The same token may be observed in multiple UXF bundles concurrently (different senders, different chains, different times) — some may be valid, some may surface as invalid for different reasons.
- A token can be marked invalid by one bundle (e.g., bad proof) and later observed in a different bundle as `NOT_OUR_CURRENT_STATE` — both records are forensically distinct.
- An attacker may ship multiple invalid representations of the same `tokenId` across separate bundles; each record is preserved independently.

The keying scheme:
```
_invalid:  ${addr}.invalid.${tokenId}.${observedTokenContentHash}
_audit:    ${addr}.audit.${tokenId}.${observedTokenContentHash}
```

Where `observedTokenContentHash` is the CID of the token-root element AS OBSERVED in the originating bundle (not a synthetic value — the actual content hash of the as-seen DAG fragment). Two distinct bundle copies of the same `tokenId` produce two distinct keys; identical bundle copies produce the same key (idempotent re-write).

Each record carries enough context to reconstruct the dispositioning event:
```typescript
interface InvalidEntry {
  readonly tokenId: string;
  readonly observedTokenContentHash: ContentHash;  // disambiguator
  readonly reason: DispositionReason;
  readonly observedAt: number;
  readonly bundleCid: string;       // which bundle delivered this
  readonly senderTransportPubkey: string;  // for forensic peer attribution
}

interface AuditEntry {
  readonly tokenId: string;
  readonly observedTokenContentHash: ContentHash;
  readonly auditStatus: AuditStatus;
  readonly reason: DispositionReason;
  readonly recordedAt: number;
  readonly bundleCidsObserved: readonly string[];  // can accumulate across re-arrivals of same observedTokenContentHash
  readonly promotedToManifestRef?: ContentHash;
  readonly audit_promoted_from?: readonly string[];  // see §5.4 array-merge rule
}
```

**Aggregation queries**: UI-level "show all bad records for tokenId X" uses a prefix scan (`${addr}.invalid.${tokenId}.*`). Per-record retention rules are unchanged from the original §5.4 retention paragraph.

**Reason enum** (canonical, used in all `_invalid` and `_audit` records and in worker logs):

```typescript
type DispositionReason =
  // Structural / cryptographic failures (→ _invalid)
  | 'structural'           // [A] orphan ref / type-tag / hash mismatch / throw
  | 'predicate-eval'       // [B] predicate evaluation threw
  | 'auth-invalid'         // [C](1) ECDSA verify failed
  | 'continuity-broken'    // [C](2) source-state continuity broken
  | 'proof-invalid'        // [C](3) inclusionProof verify failed (PATH_INVALID, NOT_AUTHENTICATED, or PATH_NOT_INCLUDED at receive)
  | 'proof-throw'          // [C](3) proof verify threw / orphan dep
  // Aggregator-driven failures (→ _invalid)
  | 'oracle-rejected'      // §6.1 sustained PATH_NOT_INCLUDED past polling window (commitment never anchored)
  | 'belief-divergence'    // §6.1 AUTHENTICATOR_VERIFICATION_FAILED at submit (local crypto passed, aggregator's didn't)
  | 'client-error'         // §6.1 REQUEST_ID_MISMATCH at submit (client computed requestId incorrectly)
  | 'parent-rejected'      // §6.1.1 cascade — parent split-token was hard-failed (coin splits only; NFTs don't have splitParent)
  | 'race-lost'            // §6.1 / §7.1 race-loser detected via REQUEST_ID_EXISTS on submit + transactionHash mismatch on poll
  // Audit-only (→ _audit, not invalid)
  | 'not-our-state'        // [B] / [B'] current-state predicate doesn't bind to us
  | 'off-record-spend'     // [E] oracle.isSpent=true on finalized chain
  // Transport / IPFS failures (recoverable; usually transient)
  | 'gateway-fetch-failed';// §9.2 all gateways failed to serve the bundle CAR
```

**Reason → storage location mapping**:
- `structural | predicate-eval | auth-invalid | continuity-broken | proof-invalid | proof-throw | oracle-rejected | belief-divergence | client-error | parent-rejected | race-lost` → `_invalid`
- `not-our-state | off-record-spend` → `_audit`
- `gateway-fetch-failed` → no storage (transient; retried by gateway-walking logic)

**Distinguishing forensics from audit**:
- `_invalid` — cryptographically broken tokens. The chain is bad; investigation typically points to a forged proof, a corrupted bundle, or a malicious sender.
- `_audit` — structurally valid tokens we just can't spend. The token might be recoverable: e.g., a `NOT_OUR_CURRENT_STATE` arrival might transition to `VALID` if a later transfer to us arrives and the current state then binds to us. The audit collection MUST NOT be wiped during routine cleanup.

**`_audit` is a NEW collection** introduced by this protocol. It does not exist in the codebase prior to Wave T.3 and MUST be added to `PROFILE_KEY_MAPPING` alongside the existing `invalidTokens` key.

**`_audit` record schema and state transitions**:

```typescript
interface AuditEntry {
  readonly tokenId: string;
  readonly auditStatus: AuditStatus;
  readonly reason: DispositionReason;
  readonly recordedAt: number;
  readonly bundleCidsObserved: readonly string[];  // for forensic traceability
  /** Set on promotion — explicit pointer to the new active-pool manifest entry. */
  readonly promotedToManifestRef?: ContentHash;
}

type AuditStatus =
  | 'audit-not-our-state'     // disposition: NOT_OUR_CURRENT_STATE
  | 'audit-off-record-spend'  // disposition: UNSPENDABLE_BY_US
  | 'audit-promoted';         // a later transfer made the token ours;
                              // promotedToManifestRef points to the new
                              // active-pool manifest entry. The audit
                              // record is retained for forensic traceability.
```

A periodic re-scan (out of scope here, deferred per §12.2) MAY transition `audit-not-our-state` entries to `audit-promoted` if a later transfer's chain makes the same `tokenId` bind to us at current state.

**Promotion semantics**:
- Promotion sets `promotedToManifestRef` on the audit entry to the new manifest entry's `ContentHash` and MUST NOT delete the audit entry.
- The corresponding active-pool manifest entry MUST set `audit_promoted_from: { auditKey: ${addr}.audit.${tokenId} }` for back-reference. This is mandatory for forensic traceability — it is set on the manifest entry whether the entry is being created fresh OR an existing entry is being updated by promotion.

**Manifest metadata preservation across §5.3 [D] merges (normative)**: when §5.3 [D] resolves a conflict between two manifest entries for the same `tokenId` (whether via union-merge or CONFLICTING tie-break), the following metadata fields are preserved on the post-merge entry by **set-OR / max-merge** semantics regardless of which side "wins" the chain merge:
- `audit_promoted_from` — type widened to `auditKey[] | undefined` (an array of audit keys, or unset). On merge, take the union of both sides' arrays (deduplicated and lex-sorted) — divergent values reflect legitimate cross-replica audit history (e.g., the same `tokenId` was promoted from different audit entries on different devices); both records are preserved for forensic traceability. Implementations writing this field for the first time MUST use the array form (single-element array if only one promotion).
- `splitParent` — preserved if either side has it set; if both have it set with different values, that's a defect (a token cannot have two different parents); log warning and use the lexicographically-smaller value.
- `conflictingHeads[]` — union of both sides' lists, deduplicated.
- `lamport` — max of both sides (per §7.1 invariants).

Other manifest fields (chain content, current state, status) follow the normal [D] resolution rules. Future spec extensions adding new metadata fields MUST classify each new field as either "preserved" (set-OR / max-merge) or "chain-content" (resolved per [D]).

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
  submittedAt: number;           // wall-clock time of first successful submit;
                                 // initialized to createdAt at queue-creation;
                                 // updated to the actual submit time on the
                                 // first SUCCESS / REQUEST_ID_EXISTS response.
                                 // pollingDeadline (§5.5 step 6) MUST NOT fire
                                 // for entries with submittedAt === createdAt
                                 // (no submit yet).
  retryCount: number;
  source: 'sent' | 'received';   // sender's outbox vs recipient's queue
}
```

The finalization worker (see §6) processes each entry. For each pending tx:

1. Resolve `signedTransferTxBytes`: prefer the queue-entry field, fall back to the in-pool token at `(tokenId, txIndex)`. If neither has it, mark the queue entry `STRUCTURAL_INVALID` (reason='structural') and remove. The token transitions to `invalid`.
2. Compute `commitmentRequestId` locally from `(signedTx, sourceState)`. This MUST match the queue entry's stored value (defensive consistency check).
3. **Submit the commitment** to the aggregator (if not previously submitted by this worker). The submit endpoint returns one of (per `SubmitCommitmentResponse.js`):
   - `SUCCESS` — commitment accepted; will be anchored in a forthcoming SMT snapshot. Proceed to step 4.
   - `REQUEST_ID_EXISTS` — a commitment for this `requestId` already exists at the aggregator. Note that `requestId = SHA-256(publicKey ‖ stateHash.imprint)` per `RequestId.js` — it does NOT include `transactionHash`, so two different transitions over the same source state share the same `requestId`. `REQUEST_ID_EXISTS` therefore could mean EITHER (a) our own previous submit (idempotent retry, common case) OR (b) someone else's race-winning submit (race-loser case). Proceed to step 4 to resolve the ambiguity by polling — the proof retrieved there carries the canonical `transactionHash`, which we compare to ours to determine which case it is.
   - `AUTHENTICATOR_VERIFICATION_FAILED` — the aggregator's crypto check rejected the authenticator. Local crypto passed, aggregator's didn't — `'belief-divergence'`. Mark the queue entry hard-failed.
   - `REQUEST_ID_MISMATCH` — per the SDK docstring this means "Request identifier did not match the payload" — i.e., the client sent an inconsistent `(requestId, sourceState, transactionHash)` tuple. This is a CLIENT BUG, not a double-spend signal. Mark the queue entry hard-failed (reason='client-error') and emit an operator alert; the client computed the requestId incorrectly.
   - Transient (network, 5xx): increment `submitRetryCount`; back off; retry. Bounded by `MAX_SUBMIT_RETRIES` (default 5).
4. **Poll `aggregator.getInclusionProof(commitmentRequestId)`** until a terminal status is observed:
   - `verify() === OK` — proof is anchored. **Now compare the returned proof's `transactionHash` to our local `transactionHash`** (the one we just submitted or are tracking):
     - **Match**: the anchored commitment is ours. Idempotent success. Proceed to step 5.
     - **Mismatch**: the anchored commitment is someone else's — a race-winner submitted a different transition over the same source state before us. We are the race-loser. Mark the queue entry hard-failed (reason='race-lost'). The source token is genuinely valid (the race-winner's tx is on-chain); cascade does NOT fire (per §6.1.1 — race-lost is a special case where no children are invalidated). The local outbox entry transitions to `failed-permanent` with error code `OUTBOX_RACE_LOST`.
   - `verify() === PATH_NOT_INCLUDED` — this is **a verifiable proof of non-existence at the polled snapshot** (the aggregator's BFT-signed merkle proof that no commitment is registered at this requestId in the current SMT root). This is **not a hard error**; it means "not yet anchored." Continue polling. Treat as terminal-rejected only after sustained PATH_NOT_INCLUDED across the polling window (see step 6).
   - `verify() === PATH_INVALID` — the proof structure is malformed (truncated, mis-shaped). Likely faulty aggregator OR transport corruption. Increment `proofErrorCount`; retry up to `MAX_PROOF_ERROR_RETRIES` (default 3); then mark hard-failed (reason='proof-invalid').
   - `verify() === NOT_AUTHENTICATED` — the proof's validator signatures don't verify against the local trustBase. Emit `transfer:trustbase-warning` (most likely stale trustBase per §9.4.1; active forgery is out of scope). The SDK SHOULD attempt a trustBase refresh before retrying. Increment `proofErrorCount`; retry up to MAX_PROOF_ERROR_RETRIES; then mark hard-failed (reason='proof-invalid').
   - Transient (network, 5xx): back off; retry. Bounded by polling window.
5. **On proof retrieval** (`verify() === OK`):
   - The proof element is content-hashed and added to the pool.
   - The pending transaction's `inclusionProof` child is updated from `null` to the new proof's ContentHash.
   - **Token identity does NOT change.** Per the audit in §2.1, `token.id` derives from `genesis.data.tokenId` and is immutable; `TransferTransactionData.calculateHash()` excludes the inclusion proof from the data hash. What DOES change is the *CBOR serialization* of the token (the proof bytes are now present), and therefore its *content-address (CID)*.
   - **Manifest CID rewrite** (introduced in this protocol, Wave T.5 — NOT Wave H, which is unrelated null-hash canonicalization): the OrbitDB profile manifest entry for this `tokenId` is updated to point at the new CID. The previous (proof-less) CID is **tombstoned** in the manifest so older copies are not re-served from peer caches.
   - Queue entry removed.

   **Crash-safe write order (NOT a single OrbitDB transaction — OrbitDB's keyvalue store has no multi-key atomicity primitive):** the four writes happen in a fixed order with each step idempotent on replay:
   ```
   (1) pool write proof element        ← content-addressed; re-write is no-op
   (2) manifest CID rewrite            ← idempotent; same input → same output
   (3) tombstone insert                ← additive; duplicate insert is no-op
   (4) queue-entry removal LAST        ← presence/absence is the durability anchor
   ```
   If a crash interrupts between (1) and (4), the queue entry is still present on restart; the worker re-runs steps (1)-(4); each step is idempotent so the result converges. Implementation MUST follow the order; reordering breaks crash safety.

6. **Polling-window terminal**: each queue entry has a `pollingDeadline = submittedAt + POLLING_WINDOW` (default 30 minutes), where `submittedAt` is the wall-clock time of the most recent successful submit (NOT the queue-entry `createdAt` — using `createdAt` would cause restart-resume of an already-old entry to hit the deadline after a single poll). The deadline is honored only if the worker has completed at least `MIN_POLL_ATTEMPTS` polls (default 5) within the window — this prevents a fast-clock-skew or aggressive-backoff path from declaring a hard-fail prematurely. If both conditions are met (deadline exceeded AND minimum polls done) AND every poll returned `PATH_NOT_INCLUDED` with no OK ever observed, the worker concludes the commitment was rejected (the aggregator never anchored it; no point in continuing). Mark the queue entry hard-failed (reason='oracle-rejected').

   **Why a window, not a count**: PATH_NOT_INCLUDED is a *fresh proof of non-existence at a snapshot* — perfectly valid, just not the result we wanted. The aggregator's SLA guarantees commitments are anchored within bounded time (typically <1 BFT round = ~1s). A 30-minute sustained absence with at least 5 poll attempts is overwhelming evidence the commitment was dropped or rejected.

   **Backoff schedule**: poll at 30s, 60s, 120s, 240s, then every 5 min until deadline. With `POLLING_WINDOW = 30 min`, this gives roughly 8 poll attempts within the window — comfortably above `MIN_POLL_ATTEMPTS`.

   **Configuration validity rule (normative)**: the **cumulative** backoff schedule for the first MIN_POLL_ATTEMPTS polls MUST fit within POLLING_WINDOW:
   ```
   cumulativeBackoff = sum(backoffIntervals[0..MIN_POLL_ATTEMPTS-1])
   REQUIRE cumulativeBackoff ≤ POLLING_WINDOW
   ```
   For the default schedule (30s, 60s, 120s, 240s, 300s, 300s, …) and `MIN_POLL_ATTEMPTS=5`, cumulativeBackoff = 30+60+120+240+300 = **750s = 12.5 min**. So `POLLING_WINDOW` MUST be ≥ 12.5 min. The 30-min default leaves comfortable headroom.

   Implementations MUST validate this at startup and refuse to start if violated. As a hard safety net regardless of configuration, the worker SHALL also stop after `2 × POLLING_WINDOW` wall-clock time, declaring `oracle-rejected` even if MIN_POLL_ATTEMPTS was not reached — termination is guaranteed.

   **Transient errors do NOT count toward MIN_POLL_ATTEMPTS**: only polls that return a verifiable proof-status (OK, PATH_NOT_INCLUDED, PATH_INVALID, NOT_AUTHENTICATED) advance the attempt counter. Network errors / 5xx responses are retried but not counted — otherwise an aggressive transient-error condition could prematurely satisfy MIN_POLL_ATTEMPTS without actually observing aggregator state.

7. **On hard-fail of any queue entry** (steps 3, 4, 6 terminal hard-fail paths):
   - Mark the queue entry hard-failed with the canonical `DispositionReason`.
   - **Short-circuit the chain**: per §6.1.1, ANY tx hard-fail invalidates the WHOLE token (the chain has a broken link). Immediately:
     - Cancel polling for ALL other queue entries of this `tokenId` (no point continuing).
     - Mark `manifest.status='invalid'` with the failing entry's reason.
     - Move the token to `_invalid` collection.
     - Cascade per §6.1.1 to locally-derived child tokens.
   - Already-attached proofs from earlier-resolved queue entries are kept on the now-invalid token's CBOR (forensic value); the manifest's *primary* CID is tombstoned.
   - Queue fully cleared for this `tokenId`.

8. **On transient error (network, 5xx, etc.)**: increment retry count, back off, retry. Bounded by polling window for poll-side; bounded by `MAX_SUBMIT_RETRIES` for submit-side.

9. **Queue-drain → status transition (per-tokenId locked)**: when a queue entry completes successfully (step 5), the worker MUST acquire a per-tokenId lock and within that lock check: "are there any remaining queue entries for this `tokenId` that are NOT in terminal-success?"
   - If NO remaining + no hard-failed entries: re-run **[B]** (current-state predicate target — the merged chain may have changed who owns the token), then re-run **[D]** merge-check against any new pool arrivals that landed during finalization, then re-run **[E]** (oracle.isSpent on the now-finalized current state) to choose between `'valid'` and `'unspendable'`. The transition path:
     - [B] fails (token's current state no longer binds to us) → move manifest entry to `_audit` (reason='not-our-state'). Underlying pool elements (the grafted proofs added by [D-merge]) are content-addressed and harmless if retained — leave them in pool; only the manifest entry is moved.
     - [D] surfaces a CONFLICTING merge → `manifest.status='conflicting'` with `conflictingHeads[]`.
     - [E] returns isSpent=true → move manifest entry to `_audit` (reason='off-record-spend'). Pool elements retained as above.
     - All pass → `manifest.status='valid'`. Re-emit `transfer:incoming` with `confirmed: true`.
   - This re-running is necessary because the token's chain may have grown via merge during finalization, AND the current-state predicate may have changed if the merge added a transfer-out we authored locally.

   **Per-tokenId lock requirement**: §5.3 ingest paths and §5.5 step 9 finalization paths share a per-tokenId mutex. This prevents a race where a queue-drain is finalizing a token to `valid` while a concurrent §5.3 ingest of a divergent bundle would have produced `CONFLICTING` — without the lock, two workers could both observe an intermediate state and reach contradictory final dispositions. Implementations MAY use OrbitDB-level optimistic concurrency (compare-and-swap on the manifest entry's content hash) or an in-process lock; the choice is implementation-defined but the exclusion property is normative.

   **Lock-vs-network-I/O hold rule**: re-running [E] involves `oracle.isSpent()` — a network round-trip that may take seconds under aggregator load. Holding the per-tokenId mutex during this RPC would serialize the entire per-token finalization queue behind one slow call. Implementations MUST follow ONE of:
   - **CAS-based** (preferred): no lock is held; each transition is a compare-and-swap on the manifest entry's content hash. Conflicts surface as CAS failure → retry from the latest state. Works correctly across slow RPCs because no global lock is held.
   - **Lock-with-RPC-release**: the worker acquires the lock, snapshots the relevant state, **releases the lock** before issuing `oracle.isSpent()`, then re-acquires the lock and verifies the manifest content hash is still what it snapshotted before applying the post-RPC state transition. If the hash changed (concurrent write), restart from the read step.
   - **Lock-with-bounded-hold**: as a fallback, implementations using a strict in-process mutex MUST set `MAX_LOCK_HOLD_MS` (default 5s) and abort + retry if exceeded. Forbids unbounded lock-during-RPC.

   **Lock ordering for cascade (deadlock prevention + parent-flip protection)**: §6.1.1 cascade walks parent → children. To prevent AB-BA deadlocks with worker threads holding child locks while needing parent locks, the cascade rule is:
   - The cascading worker acquires the **parent's** lock first, identifies the children, **releases the parent's lock**, then acquires each child's lock individually (in lexicographic order of `tokenId`) to apply the cascaded `parent-rejected` marker via compare-and-swap.
   - **Parent-flip protection (mandatory)**: under each child's lock — and inside the CAS payload computation for CAS-based implementations — the cascade worker MUST re-read the parent's manifest entry and verify the parent is still in `_invalid` with `status='invalid'`. If the parent has flipped to `valid` (e.g., a concurrent `importInclusionProof()` override resolved the parent), the cascade for that child is aborted (no-op). This prevents a stale cascade from invalidating children whose parent is no longer rejected.
   - Implementations using compare-and-swap on manifest content hashes (rather than explicit locks) avoid the deadlock concern entirely — each child write is atomic on its own manifest entry; conflicts surface as CAS failures and retry. The parent-flip protection still applies (re-read parent inside the CAS payload computation).

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
- A `pending` token's queue entries can only be REMOVED (proof attached, hard-failed) — never re-added for the same tx index unless §5.5 step 9's re-run found a new merge that added the tx.
- An `invalid` token MUST NEVER transition out of `_invalid` — a later valid copy of the same `tokenId` is treated as `CONFLICTING` (and stored with the conflicting-heads list) but the existing invalid disposition is preserved for forensics.

---

## 6. Asynchronous Finalization

Both the **sender** (for instant-mode-sent tokens) and the **recipient** (for any pending tokens) run finalization workers. The two workers are independent — they do not coordinate — and the protocol is designed so they converge to the same valid local state without exchanging messages.

A worker may need to resolve **multiple unfinalized transactions per token** (chain-mode tokens, §2.3). Both workers walk the entire transaction history, not just the latest tx.

### 6.1 Sender-side finalization worker

Trigger: outbox entry with `status: 'delivered-instant'` and one or more outstanding `commitmentRequestIds`. The list MAY contain entries for transactions the sender did not author (chain-mode forwards inherit a list of unfinalized inbound txs that the sender now also has an interest in resolving, since the token won't transition to `valid` locally until they're done).

**Threat model**: the aggregator is **faulty, never hostile** (see §9.4 for the explicit threat-boundary). The worker's strategy is therefore: trust the local cryptographic checks, persist the belief that "if our checks pass, the commitment IS valid," and re-submit / re-poll until the aggregator agrees or a bounded budget is exhausted.

**Error model** (canonical, per `@unicitylabs/state-transition-sdk`):

Submit-side responses (`SubmitCommitmentStatus`). **Critical**: `requestId = SHA-256(publicKey ‖ stateHash.imprint)` per `RequestId.js` — does NOT include `transactionHash`. Two different transitions over the same source state have IDENTICAL `requestId`; race-lost detection therefore cannot use submit-side codes alone — it requires polling for the anchored proof and comparing `transactionHash`.

| Response | Meaning | Worker action |
|---|---|---|
| `SUCCESS` | Commitment accepted; will be anchored shortly | Proceed to poll |
| `REQUEST_ID_EXISTS` | A commitment for this `requestId` already exists. Could be (a) our own retry (idempotent) OR (b) race-winner's submit | Proceed to poll; the proof returned in step 4 carries the canonical `transactionHash`, which we compare to ours to disambiguate |
| `AUTHENTICATOR_VERIFICATION_FAILED` | Aggregator's crypto check failed | **Hard-fail**; reason='belief-divergence' |
| `REQUEST_ID_MISMATCH` | Per SDK docstring "Request identifier did not match the payload" — client sent inconsistent `(requestId, sourceState, transactionHash)` tuple | **Hard-fail**; reason='client-error'. Operator alert (client computed requestId incorrectly) |
| 5xx / network error | Transient | Retry with backoff up to `MAX_SUBMIT_RETRIES` |

Poll-side proof-verify outcomes (`InclusionProofVerificationStatus`):
| Status | Meaning | Worker action |
|---|---|---|
| `OK` AND proof's `transactionHash` matches local | Our commitment is anchored. Idempotent success | Attach proof per §5.5 step 5 |
| `OK` AND proof's `transactionHash` mismatches local | **Race-loser case**: a different transition over our source state was anchored | **Hard-fail**; reason='race-lost'. Cascade does NOT fire (source token is genuinely valid; the race-winner's tx is on-chain and the recipient never got our bundle) |
| `PATH_NOT_INCLUDED` | Verifiable proof of non-existence at this snapshot | **Continue polling** within window |
| `PATH_INVALID` | Proof structurally malformed | Retry up to `MAX_PROOF_ERROR_RETRIES`, then hard-fail; reason='proof-invalid' |
| `NOT_AUTHENTICATED` | Validator sigs don't verify against local trustBase | Emit `transfer:trustbase-warning` (likely stale local trustBase per the §9.4.1 threat model — active forgery is out of scope); retry after refreshing trustBase; if still failing, hard-fail with reason='proof-invalid' |
| 5xx / network error | Transient | Retry with backoff |

Loop (default poll interval: 30s with exponential backoff up to 5 min; polling window: 30 min default):

```
For each pending requestId in outbox.commitmentRequestIds:
   resolve signedTx (queue entry first, fall back to in-pool token).
   re-verify locally: ECDSA authenticator + source-state continuity +
     commitmentRequestId derivation. If any fails → terminal
     STRUCTURAL_INVALID for the queue entry.

   submit commitment to aggregator:
     SUCCESS / REQUEST_ID_EXISTS → continue to poll. (Both cases require
                                  the post-poll transactionHash compare;
                                  EXISTS could be our retry OR a race-
                                  winner's submit.)
     AUTHENTICATOR_VERIFICATION_FAILED →
                                  hard-fail, reason='belief-divergence'.
     REQUEST_ID_MISMATCH        → hard-fail, reason='client-error'.
                                  (CLIENT BUG: we sent an inconsistent
                                  (requestId, sourceState, transactionHash)
                                  tuple. Operator alert.)
     transient                  → retry up to MAX_SUBMIT_RETRIES.

   poll loop (until pollingDeadline = entry.submittedAt + POLLING_WINDOW;
               minimum MIN_POLL_ATTEMPTS polls before deadline can fire):
     fetchInclusionProof(requestId).verify(trustBase, requestId):
       OK                       → compare proof.transactionHash to local:
                                  match    → attach proof per §5.5 step 5;
                                             remove queue entry; done.
                                  mismatch → race-lost. Hard-fail,
                                             reason='race-lost'. Cascade
                                             does NOT fire (source token
                                             is genuinely valid; we just
                                             lost the submit-race).
       PATH_NOT_INCLUDED        → keep polling (this is a fresh proof
                                  that the commitment is NOT YET in the
                                  SMT — bounded transient).
       PATH_INVALID             → emit security note; retry up to
                                  MAX_PROOF_ERROR_RETRIES. If exhausted:
                                  hard-fail, reason='proof-invalid'.
       NOT_AUTHENTICATED        → emit transfer:trustbase-warning;
                                  attempt trustBase refresh; retry up to
                                  MAX_PROOF_ERROR_RETRIES. If exhausted:
                                  hard-fail, reason='proof-invalid'.
       transient                → backoff; retry.

   if poll loop exits because pollingDeadline reached AND only ever saw
     PATH_NOT_INCLUDED:
       hard-fail, reason='oracle-rejected'.
       (Sustained PATH_NOT_INCLUDED across the window = aggregator
       never anchored this commitment.)

   on hard-fail of ANY queue entry for this tokenId:
     short-circuit: cancel polling for all other queue entries of
       this tokenId (chain is dead);
     mark token 'invalid' with the failing reason;
     move to _invalid;
     cascade to locally-derived children per §6.1.1.

   if all requestIds for tokenId resolved OK:
     re-run [B], [D], [E] per §5.5 step 9;
     transition outbox entry to 'finalized'.
```

**Per-token parallelism**: the worker MAY poll multiple `commitmentRequestIds` of the same token concurrently, bounded by `MAX_CONCURRENT_POLLS_PER_TOKEN` (default 4). Concurrent polling reduces wall-clock latency for chain-mode tokens but should not flood a single aggregator endpoint.

**Per-aggregator concurrency**: the worker MAY enforce a global cap on in-flight polls per aggregator endpoint (default 16) to prevent the worker itself from DoS-ing the aggregator under a wide chain-mode burst.

#### 6.1.1 Cascade on hard-rejection

When a queue entry hard-fails (retries exhausted), the failing token is marked invalid. **Cascade behavior depends on the token's class** (per §4.1 canonical asset model — class-disjoint coin vs NFT):

**Coin-token splits** — split-cascade via `splitParent` reference:

When a coin token was previously split via `TokenSplitBuilder` (which mints fresh `tokenId`s for the recipient + change outputs), the children carry a `splitParent: tokenId` reference on their manifest. If the split-parent's chain hard-fails, the children are derived from a non-existent parent state and are also invalid. The worker MUST:

1. Identify all locally-stored tokens whose manifest has `splitParent === <this failing tokenId>`.
2. Cascade `manifest.status = 'invalid'` (reason='parent-rejected') to each child.
3. Move each cascaded child to `_invalid` with reason='parent-rejected', `parentTokenId: <this failing tokenId>`.
4. Emit `transfer:cascade-failed` for any outgoing bundles in the outbox that reference the cascaded children — best-effort notification to downstream recipients (delivery is informational; recipients will independently arrive at the same disposition via their own §5.3 [C](3) check when workers poll the aggregator for the failed tx).

**NFT tokens** — NO splitParent cascade (NFTs are not splittable):

NFT tokens (empty/null `coinData`) cannot be split — `TokenSplitBuilder` rejects empty-coinData inputs. NFT transfers are whole-token state-transitions: the recipient gets the SAME `tokenId` with new current state. There are no "child tokens" to cascade to. The cascade rule for NFTs is therefore:

1. The failing NFT itself is marked `invalid` and moved to `_invalid` (reason='oracle-rejected' or 'race-lost' or whichever applies).
2. **Outbox-driven downstream notification**: every outbox entry that shipped this NFT to a recipient (in instant mode, before finalization) is examined. For each, emit `transfer:cascade-failed` with the recipient's pubkey and the NFT's tokenId. This is best-effort — downstream recipients independently arrive at the same `invalid` disposition via their own §5.3 [C](3) check when their workers resolve the failing predecessor tx.
3. **NO splitParent walk** — NFTs do not have `splitParent` set; the field is ignored for NFT-class tokens.

**Race-lost special case** (per §6.1 step 4):

When a token's queue entry hard-fails with reason=`'race-lost'` (race-winner's transaction is anchored, ours isn't), the cascade does NOT fire — the source token is genuinely valid (the race-winner's tx is on-chain), and the recipient never received our bundle. Only the outbox entry transitions to `failed-permanent`; the source token's local state is untouched. This is unique to race-lost; all other hard-fail reasons trigger the cascade per the rules above.

Cascade is **monotonic** by default. A cascaded `invalid` disposition cannot be reversed automatically. **Operator-explicit reversal path** for the case where the aggregator later returns a valid proof for the parent's tx (which it shouldn't, given the threat model — but operationally this can happen if the aggregator was transiently faulty and the cascade fired prematurely):

```typescript
// Reverse the parent's invalidation first via §6.3 importInclusionProof
// with allowInvalidOverride=true. THEN call:
function revalidateCascadedChildren(parentTokenId: string): RevalidationResult;

interface RevalidationResult {
  readonly checked: number;       // children inspected
  readonly revalidated: number;   // moved from _invalid back to active pool
  readonly stillInvalid: number;  // still invalid for reasons OTHER than parent-rejected
}
```

`revalidateCascadedChildren()` scans `_invalid` for entries with reason='parent-rejected' AND `parentTokenId` matching the supplied id. For each such child:
- If the parent is now in active pool with `status='valid'`: re-run §5.3 [B]/[C]/[D]/[E] on the child. If it passes, move the child back to active pool with the appropriate disposition.
- If the parent is still invalid: leave the child in `_invalid`.
- If the child fails [B]/[C]/[E] for reasons unrelated to parent: leave it in `_invalid` with reason updated to the new disposition (e.g., 'off-record-spend' if isSpent=true now).

**Transitive cascade reversal**: cascades can be transitive (A → B → C → D, with A's failure invalidating B, B's invalidation cascading to C, etc.). `revalidateCascadedChildren()` is **transitive by default**: when it successfully revalidates a child, it recursively calls itself on the revalidated child's `tokenId` to revalidate any grandchildren. Operators call the function once on the original parent; the SDK walks the dependency tree.

**Cycle defense (defensive)**: token chains are append-only DAGs (parents are predecessors, children are successors), so cycles cannot arise from honest chain construction. However, `splitParent` is a manifest-side annotation that could in principle be corrupted. The implementation MUST maintain a visited set during transitive recursion and bound depth at `MAX_CHAIN_DEPTH` (default 64, matching §5.5 chain-depth bound). On detected cycle or depth-overrun, the recursion stops and returns the partial revalidation result with a `cycle-detected` warning.

This is an explicit operator action; the SDK does not auto-cascade-reverse on parent override.

**Cascade-risk warning to caller**: an instant-mode split issued from a still-pending parent inherits the parent's cascade risk. The SDK MUST surface this to the caller in two ways:
1. The `send()` result includes `splitParent: { tokenId, status: 'pending' | 'valid' }` whenever the result includes a freshly-minted child token. Callers can inspect `splitParent.status === 'pending'` and decide whether to gate their UX on parent finalization.
2. The SDK emits `transfer:cascade-risk-warning` events when a downstream send is composed from a still-pending parent: `{ childTokenId, parentTokenId, parentStatus }`.

Optional gate: callers MAY pass `requireParentFinalized: true` to `send()`; the SDK will reject with `PARENT_NOT_FINALIZED` if any source token has unfinalized chain history. Default: `false` (instant splits are allowed).

#### 6.1.2 Outbox terminal states

- `finalized` — every proof attached cleanly.
- `failed-permanent` — any of: submit-side `AUTHENTICATOR_VERIFICATION_FAILED` (belief-divergence) or `REQUEST_ID_MISMATCH` (client-error), sustained `PATH_NOT_INCLUDED` past polling window (oracle-rejected), retry-exhausted `PATH_INVALID` / `NOT_AUTHENTICATED` (proof-invalid), or poll-side `OK` with mismatching transactionHash (race-lost via `OUTBOX_RACE_LOST`). Operator may inspect via `_invalid` records and decide whether to escalate.
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

**Crucial invariant about unicity proofs (per the underlying state-transition protocol)**:
- For a given `requestId`, the aggregator NEVER signs proofs for two DIFFERENT values (different `transactionHash` + `authenticator`). Single-spend at the SMT level guarantees this — if a different value were committed, it would be the canonical one and the original would be unanchored.
- For a given `requestId` AND value (transactionHash + authenticator), MULTIPLE proofs may legitimately exist over time. The SMT grows with every BFT round; an old proof's merkle path is valid against the OLDER root, but a fresher proof against the NEWER root has identical leaf data and identical (transactionHash, authenticator) — only the witness path and the unicity certificate differ.
- This means: same-value proofs at successive aggregator snapshots are NORMAL and EXPECTED. Implementations MUST handle "the proof I already have" being superseded by a more-recent equivalent.

**Canonicalization rule (most-recent proof wins)**: when two proofs exist locally for the same `requestId` with the same (transactionHash, authenticator), the protocol prefers the **most recent** — i.e., the proof whose `unicityCertificate` was issued in the latest BFT round. Recency is determined by:
1. The `unicityCertificate` carries a BFT round number (or equivalently, a timestamp/sequence). Higher round = more recent.
2. If round numbers are unavailable in the certificate format, use the proof's CID with a "first-observed-locally" timestamp recorded in the manifest's `lastProofRefreshAt` field.

If the local manifest already has a proof for a queue entry's requestId, and a fresh poll returns a NEWER proof for the same value, the worker:
- Verifies the new proof against trustBase.
- Replaces the old proof element in the pool with the new one.
- Updates the manifest CID rewrite (per §5.5 step 5) — the token's CBOR encoding now embeds the newer proof, so its CID changes; tombstone the previous CID.
- Does NOT alter the queue entry's status (the entry was already in `completedRequestIds`); this is purely a maintenance operation.

**Forbidden** (would indicate aggregator failure): observing two proofs for the same requestId with DIFFERENT values (different transactionHash). If this ever happens, emit `transfer:security-alert` immediately — the single-spend invariant has been violated at the aggregator. The protocol does NOT auto-recover; an operator must investigate. (This is the only path that emits `transfer:security-alert` in the routine flow; per §9.4.1, all other suspect events emit `transfer:trustbase-warning` first.)

**Convergence sketch**:
1. For each requestId, both finalizers eventually retrieve some valid proof. The proofs are over IDENTICAL values (transactionHash, authenticator) — by aggregator invariant.
2. If both finalizers retrieve at the same BFT round, the proofs are byte-identical; trivially convergent.
3. If the finalizers retrieve at different rounds, the proofs differ in witness path + certificate but agree on value. After both run §12.3.1 profile-pointer rescan and exchange manifests, the most-recent-proof rule selects the same canonical proof on both sides; manifests converge to the same CID for the token.
2. Both finalizers fetch each pending proof independently. Both attach byte-identical `inclusion-proof` elements to byte-identical transaction objects.
3. The transaction's data hash (`TransferTransactionData.calculateHash()`) is unchanged — proofs are not in its preimage. So the per-tx CID changes (the encoded form is different) but the `transactionHash` referenced *by* the inclusion proof remains the same.
4. The token's `id` is unchanged throughout. The token's CID — the content-address of its CBOR encoding — converges once both sides have the same proof set attached.
5. Both manifests update `tokenId → newCid` and set `status='valid'` once all unfinalized txs in the chain are resolved AND the [E] re-run confirms `oracle.isSpent === false`.
6. Subsequent `pkg.merge` between the two pools dedupes via Wave G.3 (identical content → identical CID); the merge is a no-op.

**Failure mode (commitment never anchored)**: both finalizers see the same eventual signal (per §6.1 error model — sustained `PATH_NOT_INCLUDED` over the polling window resolves to reason='oracle-rejected'; or post-poll `OK`-with-mismatching-transactionHash resolves to reason='race-lost'). Both mark the token's queue entry `failed-permanent` per §6.1. The dispositions converge across replicas — both reach the same outcome (oracle-rejected, race-lost, or invalid via §6.1.1 cascade) given the same canonical aggregator state.

**Asymmetric-knowledge mode (one side has more proofs than the other, no network)**: as long as the more-knowledgeable copy reaches the lagging side via any channel (a second Nostr delivery, a backup import, an IPFS pull) the merge is monotonic — proofs accumulate. Convergence does not require both sides to ever reach the aggregator.

**Stuck-PENDING escape hatch**: if neither side reaches the aggregator AND they don't reach each other, the token is `PENDING` indefinitely. The SDK exposes:

```typescript
function importInclusionProof(
  tokenId: string,
  proofBytes: Uint8Array,
  options?: { allowInvalidOverride?: boolean }
): ImportProofResult;

type ImportProofResult =
  | { ok: true; transition: 'pending-still' | 'pending→valid' | 'pending→unspendable' }
  | { ok: false; reason:
      | 'no-such-token'           // tokenId not in our pool, _invalid, or _audit
      | 'tokenId-already-valid'   // token is already manifest.status='valid'; idempotent no-op
      | 'tokenId-in-invalid'      // token is in _invalid; requires allowInvalidOverride
      | 'proof-trustbase-failed'  // proof.verify(trustBase) returned not-OK
      | 'proof-not-anchored'      // verify returned PATH_NOT_INCLUDED — proof shows non-existence
      | 'requestid-mismatch'      // proof's requestId doesn't match any outstanding queue entry
    };
```

**Default values**: `allowInvalidOverride` defaults to `false` if omitted. The override is an explicit operator action that breaches the §5.6 monotonicity invariant ("invalid → ?" is normally forbidden); callers MUST set it to `true` deliberately. Silently defaulting to `true` would allow accidental invariant violations.

Behavior cases:
1. **tokenId not in pool / _invalid / _audit**: `{ ok: false, reason: 'no-such-token' }`. The SDK has no context for the proof.
2. **tokenId is `valid`**: `{ ok: true, transition: 'pending-still' }` — idempotent no-op. The proof was already attached.
3. **tokenId is `pending`, proof matches an outstanding queue entry's requestId**: validates against trustBase; if `verify() === OK`, grafts in per §5.5 step 5. May trigger queue drain → `pending → valid` (or `pending → unspendable` if isSpent re-check returns true).
4a. **tokenId is `pending`, proof matches a `completedRequestIds` entry** (already resolved): `{ ok: true, transition: 'pending-still' }` — idempotent no-op. The proof was already attached previously.
4b. **tokenId is `pending`, proof doesn't match any outstanding OR completed requestId**: `{ ok: false, reason: 'requestid-mismatch' }`. The proof is for a different transition.
5. **tokenId is in `_invalid` AND `allowInvalidOverride === true` AND the token had EXACTLY ONE hard-failed queue entry, matching the proof**: validates the proof; if OK, MOVES the token from `_invalid` back to active pool with `manifest.status='valid'` (the prior invalidation was wrong — the original aggregator response was faulty, the proof now demonstrates the correct anchored state). This is the explicit operator override of the §5.6 monotonicity invariant.
6. **tokenId is in `_invalid` AND `allowInvalidOverride === true` AND the token had MULTIPLE hard-failed queue entries** (chain-mode case): validates the proof; if OK, MOVES the token from `_invalid` back to active pool with `manifest.status='pending'` and re-queues the K-1 remaining entries as fresh queue entries (each with `submittedAt = now`, fresh `pollingDeadline`). The token returns to the normal finalization path. The operator must then either wait for those K-1 entries to resolve OR import each of their proofs separately.

   > **Important — re-queue is usually futile without the additional proofs**: the K-1 entries previously hard-failed because the aggregator never anchored their commitments (sustained PATH_NOT_INCLUDED) or because they lost a race (poll-side OK with mismatching transactionHash). Nothing about re-queueing causes the aggregator to behave differently — those entries will hard-fail again after one polling window, re-cascading the token to `_invalid`. Operators SHOULD provide proofs for ALL K-1 remaining entries via repeated `importInclusionProof()` calls (one per requestId) BEFORE expecting the token to converge to `valid`. A future `bulkImportInclusionProofs(tokenId, proofs[])` API MAY consolidate this (deferred — §12.2).
7. **tokenId is in `_invalid` AND no override flag**: `{ ok: false, reason: 'tokenId-in-invalid' }`.
8. **Proof verify returns `PATH_NOT_INCLUDED`**: `{ ok: false, reason: 'proof-not-anchored' }`. The proof is a valid proof of NON-existence; it doesn't help unstick.
9. **Proof verify returns `PATH_INVALID` / `NOT_AUTHENTICATED`**: `{ ok: false, reason: 'proof-trustbase-failed' }`.

UI surfaces stuck-pending tokens after a configurable timeout (default 7 days) so the operator can paste in a proof obtained out-of-band. The 7-day timer DOES reset on any successful state transition (e.g., partial graft of K-1 of K queue entries restarts the clock for the remaining one).

**Time-horizon reference table** (clarifies the multiple timers in this spec):

| Timer | Default | Scope | Purpose |
|---|---|---|---|
| `MAX_SUBMIT_RETRIES` | 5 | Per-requestId submit-side | Bounded transient retries on submit |
| `MAX_PROOF_ERROR_RETRIES` | 3 | Per-requestId poll-side | Bounded retries on PATH_INVALID / NOT_AUTHENTICATED |
| `POLLING_WINDOW` | 30 min | Per-requestId poll-side | Sustained PATH_NOT_INCLUDED → terminal |
| `MIN_POLL_ATTEMPTS` | 5 | Per-requestId poll-side | Floor before deadline can fire |
| Outbox `retryDeadline` | 24 hours | Per-outbox-entry | Total transient-retry budget for delivery |
| UI stuck-pending surface | 7 days | Per-token | Surface to operator for manual proof import — applies ONLY to tokens still in `pending` status, NOT to tokens already in `_invalid` (those are protocol-declared terminal failures, not stuck) |
| Cascade-stuck surface | n/a (manual) | Per-token | A child token cascaded to `_invalid` with reason='parent-rejected' is NOT surfaced by the stuck-pending timer. The operator must invoke `revalidateCascadedChildren(parentTokenId)` after using `importInclusionProof` to override the parent. The SDK SHOULD provide a UI affordance "X cascaded children — revalidate?" whenever a parent is overridden. |

A token can transition to `_invalid` via §6.1 within ~30 min of submit (if the aggregator's response is decisive), well before the 7-day stuck-pending UI fires. The two timers serve different semantic states: protocol-defined failure (terminal) vs. UI-surfaced limbo (still finalizable in principle).

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
  /** Instant-mode commitment requestIds, partitioned into outstanding
   *  (still being polled / submitted) and completed (proof attached or
   *  hard-failed). Two-set form is required for CRDT merge semantics
   *  per §7.1 — set-union on the merged single list would re-add
   *  finalized requestIds to the outstanding pool and trigger
   *  re-submission. */
  readonly outstandingRequestIds?: readonly string[];
  readonly completedRequestIds?: readonly string[];
  /** Memo. */
  readonly memo?: string;
  /** Timestamps. */
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Lamport logical clock for CRDT tie-breaking. MUST use the standard
   *  Lamport-clock rule on every local mutation:
   *    on local write: lamport = max(localLamport, observedRemoteLamports) + 1
   *    on merge:       lamport = max(replicaA.lamport, replicaB.lamport)
   *  Without this rule, per-replica counters are not comparable and the
   *  CRDT tie-breaks in §7.1 are non-deterministic across replicas. */
  readonly lamport: number;
  /** Error info if failed. */
  readonly error?: string;
  /** Retry counters. */
  readonly submitRetryCount: number;
  readonly proofErrorCount: number;
  /** Soft deadline for transient retry abandonment. */
  readonly retryDeadline?: number;
  /** Polling deadline for instant-mode finalization. After this time,
   *  sustained PATH_NOT_INCLUDED transitions the entry to failed-permanent
   *  with reason='oracle-rejected'. */
  readonly pollingDeadline?: number;
}
```

The outbox is stored in **OrbitDB**. PROFILE-ARCHITECTURE.md §10.12 declares the static key as `{addr}.outbox`; at runtime, the Wave G.7 per-entry-key writer expands this to per-entry keys of the form `${addr}.outbox.${id}` for cross-device visibility and multi-process safety. Implementations MUST follow PROFILE-ARCHITECTURE.md §10.12 — this spec does not redefine the key shape.

### 7.0 Status transition table

Outbox entries follow this state machine. Transitions outside the table are forbidden.

```
Initial: packaging

  packaging  ──pin/encode complete──► [pinned]  (UXF cid-mode only; UXF car-mode skips this)
  packaging  ──serialize complete───► sending   (UXF car-mode + TXF)
  pinned     ──ipfs pin acknowledged─► sending
  pinned     ──publish-dispatch fails─► failed-transient   (post-pin transport failure)
  pinned     ──permanent pin failure─► failed-permanent   (T.4.A; pin permanently rejected — Nostr publish never fires)

  sending    ──Nostr publish ack ────► delivered          (conservative UXF, conservative TXF)
  sending    ──Nostr publish ack ────► delivered-instant  (instant UXF, instant TXF)
  sending    ──publish error ────────► failed-transient

  delivered  ──retention window expires─► expired (terminal: removed)
  delivered-instant ──worker starts──► finalizing
  finalizing ──all proofs attached──► finalized
  finalizing ──any tx hard-fail ─────► failed-permanent  (per §6.1.1 short-circuit)
  finalizing ──transient budget ─────► failed-transient

  failed-transient ──manual retry────► sending
  failed-transient ──cap ────────────► failed-permanent
  failed-permanent ──importInclusionProof ack► finalizing  (operator escape-hatch override)

  finalized       ──retention window expires► expired (terminal: removed)
  expired (terminal: garbage-collected)
  failed-permanent (terminal except via the import-proof override)
```

State partition (used by §7.1 CRDT merge rule):
- **Active** (worker is making progress; should win against soft-terminal on merge): `packaging`, `pinned`, `sending`, `delivered`, `delivered-instant`, `finalizing`.
- **Soft-terminal** (no progress, but could resume): `failed-transient`. Loses to active states on merge — if any replica is still progressing, that progress should not be overwritten by a transient failure on a different replica.
- **Hard-terminal** (no further worker progress without operator action): `expired`, `finalized`, `failed-permanent`. Wins against both active and soft-terminal.

The `finalized` over `failed-permanent` ordering rule still applies among hard-terminals — but see §7.1 for the override interaction.

### 7.1 OrbitDB CRDT invariants

The outbox is persisted in OrbitDB. OrbitDB has eventual-consistency (CRDT) semantics across replicas (e.g., desktop wallet + browser wallet for the same identity). The keyvalue store has only per-key `put`/`get`/`del` primitives; cross-key atomicity is NOT provided by the adapter (`profile/orbitdb-adapter.ts:331-378`).

**Lamport clock invariants (normative)**:
- `lamport: number` is a Lamport logical clock per `UxfTransferOutboxEntry`. It is NOT a wall-clock timestamp and NOT a per-replica monotonic counter — those are not comparable across replicas.
- On every local write to an entry, the writer reads the current `lamport` value AND the maximum `lamport` of any concurrently-observed remote replica's view of the same entry, then writes `lamport := max(local, observedRemotes) + 1`.
- On merge, `lamport := max(replicaA.lamport, replicaB.lamport)` (this is the natural CRDT max-merge consistent with the writer rule).
- Implementations that fail to follow this rule will see non-deterministic merge outcomes — the override path in §7.0 in particular depends on the override's Lamport being strictly greater than the pre-override `failed-permanent`'s Lamport.

**Override stickiness**: when `payments.importInclusionProof()` (§6.3) transitions `failed-permanent → finalizing`, the writer also sets a sticky boolean flag `overrideApplied: true` on the entry. This flag survives all subsequent merges (set-OR semantics: any replica having `overrideApplied === true` causes the merged entry to have it). When `overrideApplied === true`, the active-state's `finalizing` wins against any replica's `failed-permanent` regardless of Lamport — this prevents the override being undone by a stale replica with a higher Lamport for unrelated reasons.

**`everFinalizing` sticky flag (steelman crit #12)**: a second sticky CRDT-stable boolean — `everFinalizing: true` — is set whenever any replica has at one point passed through `status === 'finalizing'`. The writer stamps it on every write whose status is `finalizing`; the merger carries it forward (set-OR) on every fold. Required for CRDT associativity of the override arc: without it, the multiset `{finalizing-no-flag, failed-permanent-no-flag, failed-permanent-overrideApplied}` was non-associative in 3-way merges (an intermediate hard-terminal fold could erase the `finalizing` status before the override-flag bearing replica was folded in, suppressing the revival arc). With the flag, the override arc fires whenever the merged multiset has historically contained `finalizing` AND any side carries `overrideApplied: true` — even when neither current replica has `status === 'finalizing'`. This restores `merge(merge(a, b), c) == merge(a, merge(b, c))` for every reachable multiset. The flag's set-OR semantics matches the gossip-fold model: every replica that ever observes the flag re-emits it forever, so the override revival arc is independent of fold order.

**Dual-override case** (informational): if both replicas independently apply `importInclusionProof()` with possibly different proofs, both end up in `finalizing` with `overrideApplied = true`. The status partition rule "both active" applies → lattice + Lamport tie-break. The merged `outstandingRequestIds` and `completedRequestIds` sets reflect both override paths' updates per the set-merge rules. If the imported proofs are valid for the same requestId, they are byte-identical (per §6.3 idempotency canonicalization) and the merge is harmless. If they disagree (different requestIds, e.g., different unfinalized txs in the chain), the §5.5 finalization queue handles the divergence by resolving each requestId against aggregator-anchored truth — the protocol converges naturally.

**Conflict resolution rules under replica merge:**

1. **Status field — three-way partition with override-aware tie-break:**
   - If both replicas are **hard-terminal**: prefer `finalized` over any other; among `failed-permanent | expired`, prefer `failed-permanent`. Tie-break by Lamport timestamp (higher wins — the more-recent decision sticks). EXCEPTION (override case): if one replica is in `finalizing` (active) with `overrideApplied === true`, that replica wins regardless of Lamport against the other replica's `failed-permanent`. The override flag is sticky and survives merge (set-OR), so a wallet that has performed `importInclusionProof()` keeps the override even if a remote replica's Lamport runs ahead for unrelated reasons.
   - If both are **active**: prefer the more-advanced state per the lattice `packaging < pinned < sending < {delivered, delivered-instant} < finalizing`. Among `delivered` and `delivered-instant` (siblings — different finalization modes for the same send), tie-break by Lamport timestamp; the higher Lamport wins because the more-recently-decided mode reflects the actual outcome.
   - If one is **active** and the other is **soft-terminal** (`failed-transient`): active wins. A replica still progressing should not be overwritten by another replica's transient failure.
   - If one is **active** and the other is **hard-terminal**: hard-terminal wins (subject to the override exception above).
   - If one is **soft-terminal** and the other is **hard-terminal**: hard-terminal wins.
   - If both are **soft-terminal** (`failed-transient`): higher Lamport wins (more-recent retry attempt).
2. **`outstandingRequestIds` set:** merge as `union(replica_A_outstanding, replica_B_outstanding) - union(replica_A_completed, replica_B_completed)`. This prevents finalized requestIds from being re-added by a stale replica. Set-union alone would re-trigger submissions.
3. **`completedRequestIds` set:** merge as straight `union(replica_A_completed, replica_B_completed)` — completed never un-completes.
4. **`submitRetryCount`, `proofErrorCount`:** max-merge (CRDT G-counter shape).
5. **`error` field:** strictly-associative CRDT join in the lattice `undefined < string`:
   - Both `undefined` → `undefined`.
   - Exactly one defined → the defined string (error stickiness).
   - Both defined → **lex-min of the error string** (deterministic tie-break).

   **Rationale.** Earlier drafts of this rule used "more-advanced status wins; equal-status → earlier Lamport wins." That formulation is not associative under 3-way merges: pairwise-merged Lamports become `max(a, b)`, which obliterates the original "earlier" timestamp and produces different `merge(merge(a,b),c)` vs `merge(a,merge(b,c))` outcomes for the surviving error string. The status-takes-error variant has the same problem when intermediate winners differ across merge groupings. The lex-min rule is purely a function of the multiset `{a.error, b.error}` and is therefore commutative AND associative by construction. It honors the spec's INTENT ("first-decided error is preserved" — usually only one replica records an error per cascade) with one narrow trade-off: when two replicas independently set distinct error strings, the lex-min string survives instead of the temporally-earlier one. This is the standard CRDT lattice resolution.

   Empty string `""` is treated as "present" (a defined value), not coalesced to `undefined` — writers MUST never persist `""` if they mean "no error".
6. **`lamport` timestamp:** max-merge.

**Spend protection** comes from the aggregator's `requestId` invariant. A replica rollback that re-creates an outbox entry for an already-transferred source state will hit `REQUEST_ID_EXISTS` at the next aggregator submission; the worker then polls and discovers the race-loser case (proof's `transactionHash` ≠ local) and marks the entry `failed-permanent` with reason='race-lost'. The outbox correctly records the failed re-attempt; the source token's on-chain state is untouched.

**Two-replica race on `send()` from same source state**: replicas A and B simultaneously fire `send()` from the same source token. Each generates a fresh-random salt → different `transactionHash` but **identical `requestId`** (since `requestId = SHA-256(publicKey ‖ stateHash.imprint)` excludes `transactionHash`). Both submit to the aggregator. First-arriving wins `SUCCESS`; the second's submit returns `REQUEST_ID_EXISTS` (NOT `_MISMATCH`). The second's worker then polls `getInclusionProof(requestId)` and compares the returned proof's `transactionHash` to its local one — they differ, identifying the race-loser. The loser's outbox entry transitions to `failed-permanent` with error code `OUTBOX_RACE_LOST` (reason=`'race-lost'`). The cascade rule (§6.1.1) does NOT fire for `race-lost` — the source token is genuinely valid (the race-winner's tx is on-chain); the loser's `send()` simply lost the race and the recipient never got a bundle.

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

The on-chain spent state is checked via `oracle.isSpent(stateHash)` — a single round-trip per finalized arriving token (cached per Wave L's bounded LRU at `oracle/UnicityAggregatorProvider.ts:158-172,608-634`). For chain-mode tokens, the spent check is **deferred** until all unfinalized txs are resolved (running it earlier would be meaningless — `isSpent` of an unproven destination state is undefined). When finalization completes (§5.5 step 9), the worker re-runs [E] before transitioning the token from `pending` to terminal.

---

## 9. Error Handling and Edge Cases

### 9.1 Bundle delivery fails (Nostr publish error)

- Retry via outbox `failed-transient` state with exponential backoff up to a hard cap (default 24 hours).
- After cap: `failed-permanent`. Local bookkeeping is updated to reflect that the bundle did not reach the recipient.

**Why double-spend is impossible at the protocol level**: the aggregator enforces single-spend at the SMT level via the `requestId` invariant. Per `RequestId.js`, the requestId is `SHA-256(publicKey ‖ sourceStateHash.imprint)` — deterministic given (sender pubkey, source state) and **excluding `transactionHash`**. Two different signed transitions from the same source state therefore produce DIFFERENT `transactionHash` values but the SAME `requestId`. The aggregator anchors at most ONE transition per requestId; subsequent submits for the same requestId return `REQUEST_ID_EXISTS` (NOT `_MISMATCH` — `_MISMATCH` is reserved for malformed-payload errors). The sender's worker resolves the double-spend at the polling step:

- If the sender's original commitment was the one anchored, polling returns the proof with our `transactionHash`; idempotent success.
- If a competing commitment was anchored first (race-loser case OR the sender's local state diverged from canonical chain — "belief divergence"), polling returns the proof with a DIFFERENT `transactionHash`. The sender's worker compares and detects the mismatch, marking the queue entry `failed-permanent` with reason='race-lost'.
- If the original commitment was never accepted (aggregator dropped the submission), polling returns `PATH_NOT_INCLUDED` until the polling window expires; worker eventually marks the entry hard-failed with reason='oracle-rejected'.
- If the sender's retry uses the EXACT same `(salt, transactionHash)`, polling returns the proof with matching `transactionHash` — idempotent.

In no case can the sender create two valid commitments for the same source state. Local outbox state is bookkeeping and cannot violate this invariant. The aggregator's single-spend invariant is the trust anchor.

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

### 9.4 Aggregator rejection — terminal hard-fail

A queue entry transitions to terminal hard-fail through one of these paths (per §6.1):

| Path | Trigger | Reason |
|---|---|---|
| Submit-side `REQUEST_ID_MISMATCH` | Client bug — sent inconsistent `(requestId, sourceState, transactionHash)` tuple | `client-error` (operator alert) |
| Submit-side `AUTHENTICATOR_VERIFICATION_FAILED` | Aggregator rejected our crypto | `belief-divergence` |
| Poll-side `OK` with mismatching transactionHash | Race-winner's transition was anchored; we are the race-loser | `race-lost` (cascade does NOT fire — source token is genuinely valid) |
| Poll-side sustained `PATH_NOT_INCLUDED` over POLLING_WINDOW | Commitment was never anchored | `oracle-rejected` |
| Poll-side `PATH_INVALID` after retries | Proof structurally malformed | `proof-invalid` |
| Poll-side `NOT_AUTHENTICATED` after retries | Stale local trustBase (per §9.4.1; active forgery out of scope) | `proof-invalid` (also: `transfer:trustbase-warning`) |

After hard-fail:
- The specific failing transaction is marked invalid with the canonical reason.
- Per §6.1.1 cascade rule, locally-derived child tokens of this token are also marked `'invalid'` with reason=`'parent-rejected'`.
- The **source token (parent)** is untouched — the failed transition is treated as if it never happened. The aggregator's single-spend invariant means the token remains in its prior valid state in the original owner's pool.

**No refund / reversal protocol is needed** (per §12.1).

**Mode-specific severity**:
- **Instant mode**: a hard-fail is a routine outcome of optimistic shipping — the sender went before knowing the aggregator's verdict. No security implications unless reason ∈ {`belief-divergence`, `proof-invalid`}.
- **Conservative mode**: the sender retrieved a proof BEFORE shipping the bundle. The recipient may observe either (a) `NOT_AUTHENTICATED` — most likely a stale local trustBase per §9.4.1 (active forgery is out of scope) → `transfer:trustbase-warning`; OR (b) `PATH_INVALID` — proof structurally malformed → `proof-invalid` hard-fail with retry. In conservative mode specifically, a sustained NOT_AUTHENTICATED after trustBase refresh is operationally suspicious because the sender claimed the proof was already verified; the SDK MAY emit `transfer:security-alert` after the trustBase-refresh path is exhausted, signaling that the trust boundary may have been violated.

#### 9.4.1 Threat boundary (faulty vs hostile)

The protocol assumes the aggregator is **faulty, never hostile**. Faulty means:
- May drop submissions (transient → retry).
- May return transient errors (5xx, network hiccups → retry).
- May briefly return inconsistent state (e.g., `PATH_NOT_INCLUDED` on a poll for a commitment another peer just got `OK` for, due to not-yet-replicated state across aggregator nodes → keep polling within the window).

In-scope failure modes the protocol defends against:
- Aggregator drops or delays a submission. Worker retries; eventually anchored or POLLING_WINDOW expires.
- Aggregator briefly returns wrong errors (one node out of date). Worker retries; consistent answer eventually.
- Aggregator is unavailable. Worker keeps retrying within transient budget; UI surfaces stuck-PENDING after 7 days; operator can paste in a proof out-of-band via `payments.importInclusionProof`.

Out-of-scope failure modes (the protocol does NOT defend against; if these occur, the trust assumption is violated):
- Aggregator signs valid proofs for transitions not in its SMT (active forgery). Detected by recipient's local trustBase verify, but only if the trustBase is up-to-date.
- Aggregator collusion across BFT validators to rewrite history. Detection at the BFT layer is out-of-scope here; if it happens, the recipient may store a `valid` token whose chain is later contradicted by a corrected aggregator — manual operator escalation required.
- Aggregator deliberately returns inconsistent answers to different callers (split-brain). The most-recent-proof canonicalization in §6.3 handles benign multi-round divergence (proofs at different snapshots for the same value); deliberate split-brain on different SMT roots OR different values for the same requestId is a hostile-aggregator scenario and out of scope (the latter triggers `transfer:security-alert` per §6.3).

**Event taxonomy**:
- `transfer:trustbase-warning` — `NOT_AUTHENTICATED` on a proof. Most likely cause: stale local trustBase. The SDK SHOULD attempt a trustBase refresh before retrying. The protocol does NOT defend against active forgery (out of scope), so this event is treated as an operational issue rather than a security incident.
- `transfer:security-alert` — reserved for the explicit out-of-scope cases that the protocol detects but cannot defend against (e.g., two structurally-different valid proofs for the same requestId, retrieved by separate workers and observed via `pkg.merge`). This event is informational and signals "the trust boundary may have been violated" — operator investigation required.

For the chain-mode case, only the specific failing tx is the trigger, but the cascade rule (§6.1.1) and the §5.5 step 7 short-circuit ensure the WHOLE token is invalidated immediately upon any chain link's hard-fail.

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
- `coinId: string`, `amount: string` — primary coin slot. Required by the type for v1.0 backward compatibility; the implementation wave widens the type to `coinId?: string; amount?: string;`. Post-widening, NFT-only sends omit both fields. Until the widening releases, NFT-only sends are not expressible against the v1.0 type signature (per §4.1 — there is no valid placeholder).
- `additionalAssets?: ReadonlyArray<AdditionalAsset>` — multi-asset extension where `AdditionalAsset = {kind:'coin', coinId, amount} | {kind:'nft', tokenId}`. When present, target list construction follows §4.1 step 1 (primary coin slot prepended if both `coinId` and `amount` are present; additionalAssets appended verbatim). Distinct-coin and distinct-NFT-tokenId rules apply. Receivers reject unrecognized `kind` values with `UNKNOWN_ASSET_KIND` (forward-compat). Omitting this field preserves single-coin behavior identically to prior SDK versions.
- `confirmNftPending?: boolean` — default `false`. Required = `true` to send NFT-class targets backed by pending source tokens (per §4.1 step 2 cascade asymmetry warning). The flag exists to ensure callers explicitly acknowledge that a cascaded NFT is irrecoverable — there is no fungible replacement for an NFT identity.
- `transferMode: 'instant' | 'conservative' | 'txf'` — default `'instant'`.
- `txfFinalization: 'instant' | 'conservative'` — only applies when `transferMode === 'txf'`; default `'conservative'`.
- `delivery: DeliveryStrategy` (UXF modes only; see §3.3.1) — default `{ kind: 'auto', inlineCapBytes: 16384 }`.
- `allowPendingTokens?: boolean` — default `false`. Per §2.5 chain-mode opt-in.

Callers that don't specify any of these get the UXF bundle behavior in instant mode with the 16 KiB auto cutoff and finalized-tokens-only selection.

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

The identity binding event (NIP-related) MAY include capability hints describing which wire shapes and asset kinds the peer's wallet supports:

- `wireProtocols: string[]` — supported wire shapes, e.g., `['uxf-car', 'uxf-cid', 'txf']`.
- `assetKinds: string[]` — supported `additionalAssets` discriminator values, e.g., `['coin']` (v1.0), `['coin', 'nft']` (current), or `['coin', 'nft', 'voucher']` (future). v1.0 wallets that pre-date this hint omit it entirely; receivers reading an absent `assetKinds` SHOULD assume `['coin']` for safety.

The sender's UI MAY warn when a UXF-only-aware recipient receives a `'txf'` send, or when a recipient's `assetKinds` set doesn't include kinds the sender is about to ship. The SDK NEVER auto-coerces the mode or strips entries based on this hint — the caller's `transferMode` and `additionalAssets` choices are authoritative.

**Forward-compat reject (recipient-side, normative)**: regardless of any capability hint, receivers MUST reject `additionalAssets` entries with unrecognized `kind` values via `UNKNOWN_ASSET_KIND`. The reject rule is the actual interop guarantee; the capability hint is an informational early-warning. Senders targeting an older protocol version SHOULD consult the recipient's `assetKinds` to pre-empt likely rejections, but a reject from the receiver remains authoritative if the hint was missing or stale.

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
- **Multi-coin tokens (single-coin send from multi-coin source)**:
  - A token containing `{UCT: 100, USDU: 50}` is sent for `(UCT, 30)` only. Verify change stays at sender with `{UCT: 70, USDU: 50}`; recipient receives a child token with `(UCT, 30)`.
  - Same, but change is sent in a follow-up transfer to a third party.
- **Multi-coin send (additionalAssets, all coin entries)**:
  - Single multi-coin source `{UCT: 100, USDU: 50, ALPHA: 1000}` sent with `coinId='UCT', amount='30', additionalAssets=[{kind:'coin', coinId:'USDU', amount:'20'}]`. Recipient receives one child token with `{UCT: 30, USDU: 20}`; change has `{UCT: 70, USDU: 30, ALPHA: 1000}`.
  - Multiple sources (A `{UCT: 100}`, B `{USDU: 50}`) covering `coinId='UCT', amount='30', additionalAssets=[{kind:'coin', coinId:'USDU', amount:'20'}]`. Recipient receives TWO child tokens (one per source); change has two tokens (`{UCT: 70}` from A, `{USDU: 30}` from B).
- **NFT-only send** (NFT = token with empty/null coinData):
  - Source: NFT-token `T` (tokenId=`0xabc`, empty coinData), owned by sender. Request omits primary `coinId`/`amount`; `additionalAssets: [{kind: 'nft', tokenId: '0xabc'}]`. Recipient receives `T'` with the SAME tokenId; coinData still empty; current state binds to recipient. No split, no change token (whole-token state-transition).
  - Multiple NFTs: request omits primary; `additionalAssets: [{kind:'nft', tokenId:T1}, {kind:'nft', tokenId:T2}]`. Bundle carries two whole-token transfer transactions; recipient gets both NFTs with original tokenIds preserved.
- **Mixed coin + NFT send** (separate sources only):
  - Source A `{UCT:100}` (coin token) + source B (NFT-token, empty coinData). Request: `coinId:'UCT', amount:'30', additionalAssets:[{kind:'nft', tokenId:B.id}]`. Split A: recipient-A `{UCT:30}` (fresh tokenId) + change-A `{UCT:70}` (fresh tokenId). Whole-transfer B: recipient-B `B'` with preserved tokenId. Bundle carries both; recipient receives two child tokens.
- **Validation rejections**:
  - `additionalAssets` containing duplicate `coinId` (e.g., `{kind:'coin', coinId:'UCT', amount:'10'}` when primary is also UCT) → `INVALID_REQUEST`.
  - `additionalAssets` containing duplicate NFT `tokenId` → `INVALID_REQUEST` (cannot transfer same NFT twice).
  - `additionalAssets` coin entry with `amount: '0'` → `INVALID_AMOUNT`.
  - `additionalAssets` entry with unrecognized `kind` (e.g., a future `'voucher'` shipped to a v1 receiver) → `UNKNOWN_ASSET_KIND` (forward-compat reject rule).
  - Insufficient coin balance for any coin target → `INSUFFICIENT_BALANCE`; no partial shipment.
  - NFT not in sender's pool → `INSUFFICIENT_BALANCE` reason='nft-not-owned'.
  - NFT in pool but current-state predicate doesn't bind to sender → `INSUFFICIENT_BALANCE` reason='nft-not-owned'.
  - **NFT target's source is a coin token (non-empty coinData)** rather than an NFT token → `INSUFFICIENT_BALANCE` reason='nft-not-owned'. Coin tokens cannot satisfy NFT targets even if `tokenId` matches; the protocol enforces class disjointness (per §4.1 canonical asset model).
  - Empty transfer (no primary AND empty/missing additionalAssets) → `EMPTY_TRANSFER`.
  - **Pending NFT without confirmation**: `allowPendingTokens: true` + NFT target whose source has unfinalized predecessor txs + `confirmNftPending: false` (default) → `NFT_PENDING_REQUIRES_CONFIRMATION`. With `confirmNftPending: true`, the send proceeds; cascade asymmetry warning applies.
- **Backward compat**: single-coin call `{coinId: 'UCT', amount: '30'}` (no `additionalAssets`) produces byte-identical bundle to a v1.0-spec call → regression test against a captured fixture. **Implementation note**: the fixture MUST be generated from a tagged commit (specify the tag in the test) with deterministic salt, deterministic timestamp, and a recorded mnemonic; committed under `tests/fixtures/uxf-v1-single-coin/`. The byte-identical assertion is gated on the fixture's existence.
- Token-hash invariance: take the same token in two states (proof attached vs. proof null), verify `token.id` is identical, verify CIDs differ.
- CAR-embed delivery for small bundles (< 16 KiB); CID delivery for large bundles (> 16 KiB).
- **Inline delivery completion semantics (§3.3.2)**:
  - Sender ships an inline bundle, Nostr relay acks → outbox transitions to `delivered` (or `delivered-instant`).
  - Sender ships an inline bundle, all configured relays reject → outbox stays at `sending`, retries; eventually `failed-transient`.
  - Recipient receives Nostr event, decrypts, parses CAR successfully → bundle delivered, §5.3 disposition pass runs.
  - Recipient receives Nostr event, CAR fails to parse (corrupted base64 or root-CID mismatch) → bundle rejected, no delivery acknowledgment.
- **CID delivery completion semantics (§3.3.2)**:
  - Sender pins CAR to IPFS successfully + Nostr relay acks → outbox transitions to `delivered`.
  - Sender's IPFS pin succeeds but Nostr publish fails → outbox stays at `pinned`; on retry, only the Nostr publish is re-attempted (CID is already pinned).
  - Sender's Nostr publish succeeds but IPFS pin fails (out of disk, gateway timeout) → outbox stays at `pinned`; pin is retried; on permanent pin failure, outbox transitions to `failed-permanent` even though the Nostr event was published (the CID won't resolve for the recipient).
  - Recipient receives Nostr event with CID, all gateways fail to fetch within retry budget → `transfer:fetch-failed` emitted; bundle is NOT delivered; sender's outbox times out.
  - Recipient receives Nostr event with CID, one gateway succeeds → CAR verified against bundleCid, bundle delivered, §5.3 runs.
  - **Cross-mode test**: sender ships in instant mode via CID; recipient's IPFS fetch succeeds 5 minutes after Nostr event arrival → recipient's instant-mode finalization queue starts at the IPFS-fetch time, not at the Nostr-event time (per §3.3.2 "physically syncing" rule).
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
- **Bandwidth-burning peer**: malicious sender forwards a 10-deep chain where tx #3's commitment never anchored (sustained PATH_NOT_INCLUDED at recipient's worker). Recipient's worker hits the hard-fail at tx #3 after the polling window; per §6.1 short-circuit, the WHOLE token is marked invalid immediately and other queue entries are cancelled. Test verifies (a) the bundle is processed correctly, (b) the chain-depth cap fires for bundles with >64 unfinalized txs in the *claimed* tokenIds (smuggled deep roots are silently dropped per §5.2 #3 — separately tested).
- **Peer-reputation cooldown (deferred)**: assertion that the recipient applies a 1-hour silent-drop window for further bundles from a peer that recently shipped a hard-failing chain — DEFERRED per §12.2 (peer-reputation framework not in T.1-T.8). Add this test only when the framework lands.
- **Faulty-aggregator path (intermittent PATH_NOT_INCLUDED)**: aggregator returns PATH_NOT_INCLUDED transiently (e.g., across an aggregator-node-restart). Worker keeps polling; eventually one poll returns OK and the token finalizes correctly. Verify that the worker DOES NOT terminate on first PATH_NOT_INCLUDED (it's the not-yet status, not a hard-fail).
- **Race-lost detection (poll-side)**: two replicas submit different transitions over the same source state. Both get `SUCCESS` or `REQUEST_ID_EXISTS` at submit. The race-loser's poll returns `OK` with a `transactionHash` that doesn't match its local one. Worker hard-fails with reason='race-lost'; cascade does NOT fire (the source token is genuinely valid).
- **Client-error at submit (REQUEST_ID_MISMATCH)**: simulate a buggy client that computes requestId incorrectly. Aggregator returns REQUEST_ID_MISMATCH. Worker hard-fails with reason='client-error'; emits operator alert; cascade does NOT fire (the source token is unaffected — no transition was registered).
- **Sustained PATH_NOT_INCLUDED past polling window**: simulate aggregator that persistently returns PATH_NOT_INCLUDED for the entire 30-min window. Worker hard-fails with reason='oracle-rejected' after the deadline.
- **Conservative-mode post-send PATH_INVALID**: hard-fail with reason='proof-invalid' after retries.
- **Conservative-mode post-send NOT_AUTHENTICATED**: emit `transfer:trustbase-warning`; attempt trustBase refresh; if still failing, hard-fail and emit `transfer:security-alert` (sustained-after-refresh case only).
- **OrbitDB CRDT replica merge**: simulate two replicas writing different `status` updates for the same outbox entry concurrently — verify monotonic-state-machine LWW resolution (more-advanced state wins), no `finalized → sending` regressions.
- **Stuck-PENDING escape**: token is `pending` for >7 days; operator pastes in a proof via `payments.importInclusionProof()` → proof grafts in, token transitions to `valid`.

---

## 12. Resolved and Deferred Questions

### 12.1 Resolved

- **Refund / reversal protocol on aggregator rejection**: NOT needed. The hard-rejection signals are sustained `PATH_NOT_INCLUDED` over the polling window (oracle-rejected — commitment never anchored) or poll-side `OK` with mismatching transactionHash (race-lost — a different transition won the submit-race). See §6.1 error model. In both cases, the transaction OUR worker tried to anchor never made it on-chain — the source token's actual state is whatever the canonical aggregator chain shows (either unchanged for oracle-rejected, or transitioned by the race-winner for race-lost). Both sender and recipient mark the *attempted* transition as invalid; the underlying token's true on-chain state is unchanged from the wallet's perspective. No reversal flow required. (Per-history-tx invalidations propagate up to the whole-token level; see §6.1.1 cascade rule + §6.3 failure mode.)
- **Aggregator-driven inbound discovery**: NOT possible. The aggregator never holds the full transaction — only its commitment. A recipient who never received the Nostr/UXF delivery cannot reconstruct the token from the aggregator alone. Existing payment-request + reconciliation flows are the recovery path.

### 12.2 Deferred

- **Bundle compression**: CARs can be sizeable for many-token bundles (especially chain-mode tokens with deep history). zstd / brotli on the inline-CAR path? Out of scope for v1.0.
- **Multi-recipient bundles**: a single UXF bundle delivered to a Nostr group / multicast — nice to have, deferred. Would amortize CID-pin cost across N recipients and allow group-level atomic broadcasts. Open design points: per-recipient encryption envelope vs. shared symmetric key, group-membership consent.
- ~~**Multi-coin / multi-asset send in a single call**~~ — implemented (in spec). `PaymentsModule.send()` accepts the optional `additionalAssets: AdditionalAsset[]` field on `TransferRequest` where `AdditionalAsset = {kind:'coin', coinId, amount} | {kind:'nft', tokenId}`. The primary `coinId`/`amount` slot is OPTIONAL (semantically; the type retains them for backward compatibility, with the implementation wave widening them to optional fields). NFT and coin source tokens are class-disjoint per §4.1 canonical asset model — no mixed-asset tokens. NFT transfers are whole-token; coin transfers may split. See `docs/API.md` and `docs/INTEGRATION.md`.
- **Mixed-asset tokens (single token carrying coins + NFT identity simultaneously)**: NOT supported in v1. Would require a new SDK primitive (e.g., a "split-with-id-carry" operation that preserves `tokenId` while modifying `coinData`). Reserve for a future protocol revision if a real use case emerges.
- **Conflict-resolution UI/API**: `CONFLICTING` tokens (genuinely-divergent chains) need an explicit `resolveConflict(tokenId, chosenHead)` API and UI surface. Lex-min `bundleCid` provides an automatic primary, but operator override is a planned future addition.
- **Peer-reputation framework**: §11.4 mentions a 1-hour cooldown on bandwidth-burning peers. The reputation interface itself is out of scope here. Note: peer-reputation rises in operational importance once NFTs are in scope — a peer who delivers a forged or cascade-prone NFT chain can corrupt the recipient's collection in a way coin damage cannot (NFTs are non-fungible / non-replaceable). Reserve a future protocol revision for per-peer trust scores or signed NFT-receipt acknowledgements.

### 12.3 Periodic rescans (two orthogonal scanner types — split status)

> **Status update (2026-05-19)**: the original §12.3 framed BOTH rescans as deferred at the time T.1–T.8 were planned. That framing is now out of date:
>
>   - **§12.3.1 (profile-pointer rescan) is SHIPPED** — landed as the core of the **aggregator-pointer wave** (`PROFILE-AGGREGATOR-POINTER-IMPL-PLAN.md` Phases A–E, 75 tasks) and consolidated by **Item #15** (Full Profile State Snapshot Sync; merged via PR #173). The implementation is in `profile/profile-token-storage/lifecycle-manager.ts` (`schedulePointerPoll` / `runPointerPollOnce`).
>   - **§12.3.2 (per-token spent-state rescan) is STILL OPEN** — tracked as **Issue #174**.
>
> The "two rescans deferred as a unit" language in `UXF-TRANSFER-IMPL-PLAN.md`'s "Out-of-scope for T.1–T.8 (deferred)" section is similarly stale (kept for historical accuracy of what shipped in T.1–T.8 specifically; the aggregator-pointer wave landed §12.3.1 outside that wave bucket).

The protocol relies on two periodic rescan loops to maintain consistency between local state and the canonical aggregator/profile views. Both are operator-configurable and run independently:

#### 12.3.1 Profile-pointer rescan — **SHIPPED**

**Purpose**: detect updates to the wallet's UXF profile that landed via another instance of the same wallet (different device, recovered backup, etc.). The profile pointer is registered with the aggregator; periodically, the local instance queries the latest pointer position to discover whether a remote update has bumped it.

**Mechanism (as implemented in `profile/profile-token-storage/lifecycle-manager.ts`)**:
- **Schedule**: randomized in **[30s, 90s)** (`POINTER_POLL_MIN_MS = 30_000`; `POINTER_POLL_RANGE_MS = 60_000`). Jitter avoids synchronized polling across devices booting simultaneously, which would otherwise create thundering-herd load on the aggregator. (The original spec wording "every 30s" is preserved in this section as the design intent; the as-implemented jitter is a refinement of that intent, not a departure.)
- **Query**: `pointer.recoverLatest()` — returns the latest pointer version anchored to the wallet's chain pubkey, content-verified end-to-end (inclusion proof + trust base + CAR content-address verify). Internally implemented via `aggregatorClient.submitCommitment(healthCheckRid)` discovery probes scanning the version range.
- **On new CID detected**: fetches the CAR via IPFS gateways (with content-address verify), parses as a `LeanProfileSnapshot` per Item #15, dispatches via the host-wired `applySnapshotIfWired(cid)` for per-writer JOIN (OUTBOX / SENT / disposition / finalization-queue / recipient-context / bundle-refs). Disposition matrix runs implicitly through the disposition writer's existing path for any newly-arrived bundle refs.
- **Hint channel**: `OrbitDbAdapter.onReplication` calls `triggerPointerPollNow()` so a pubsub event collapses worst-case cross-device sync latency from ~90s to ~1-2s on healthy infra. Pubsub is explicitly DEMOTED to a hint channel per Item #15; the aggregator pointer is the authoritative source.
- **Backoff on transient errors**: standard interval continues. Permanent classifier (e.g. `AGGREGATOR_POINTER_TRUST_BASE_STALE`) triggers a **5× back-off** ([150s, 450s)) AND emits `storage:error` for operator visibility.
- **Cold-start path** (`recoverFromAggregatorPointerBestEffort`): the same pointer/applier path runs once at `initialize()` BEFORE the periodic poll arms, so a fresh wallet re-imported from mnemonic on a new device bootstraps from the aggregator-anchored snapshot rather than waiting for the first 30s tick.

This rescan is the primary mechanism by which the audit-collection promotion scanner (formerly listed in §12.2 as deferred) actually fires — when a remote update brings in a new transfer that makes a previously `audit-not-our-state` token ours, the rescan-driven §5.3 pass detects the new ownership and promotes per §5.4.

**Operator override**: omitting the `getPointerLayer` accessor / not wiring an oracle disables the polling entirely (the lifecycle manager silently skips when no pointer closure is wired). There is no `{ disableProfilePointerRescan: true }` SDK init flag — the wiring presence IS the on-switch. Disabling leaves the wallet dependent on OrbitDB pubsub alone (unreliable across NAT/firewalls) plus event-driven incoming-bundle paths.

#### 12.3.2 Per-token spent-state rescan — **OPEN** (Issue #174)

> **Status**: tracked as [Issue #174](https://github.com/unicity-sphere/sphere-sdk/issues/174). The reactive surface — surfacing the off-record-spend at next `send()` attempt — is in place (Item #14 Phase 1 / commit `9b4fae7`: `STATE_ALREADY_SPENT_BY_OTHER` typed throw + `transfer:double-spend-detected` event). The proactive surface (background sweep) remains to be implemented per the spec below.

**Purpose**: detect off-record spends. If another instance of the same wallet (sharing the private keys but not yet synced to us) has spent one of our tokens, the aggregator's SMT will show that token's current state as having a committed transition — but our local manifest still believes the token is `valid`. **Without rescan, we'd attempt to spend an already-spent token and learn the truth only at next `send()`** (which today surfaces as the typed `STATE_ALREADY_SPENT_BY_OTHER` throw + `transfer:double-spend-detected` event — the reactive surface). The proactive surface catches it earlier so the local UI doesn't continue showing the token as spendable until the user tries to spend it.

**Mechanism**:
- Schedule: for each token in active pool with `manifest.status === 'valid'`, query `oracle.isSpent(currentDestinationStateHash)` periodically. Default interval `TOKEN_SPENT_RESCAN_INTERVAL = 5 min` per token; cap concurrent in-flight queries at `MAX_CONCURRENT_SPENT_RESCANS` (default 4).
- On `isSpent === true`: transition the token from active pool to `_audit` with reason='off-record-spend' (UNSPENDABLE_BY_US disposition per §5.3 [E]). Emit `transfer:off-record-spent` event with `{tokenId, detectedAt, suspectedSiblingInstance: boolean}` — `suspectedSiblingInstance` is set if local outbox (OUTBOX + SENT) has no record of having spent this state, suggesting another instance with the same keys is the spender. (Spec wording was `token:off-record-spent`; renamed to `transfer:*` for consistency with the existing `transfer:*` event family.)
- On transient errors (aggregator unavailable): backoff; retry.
- Cache: §8 already references the Wave L LRU cache for `isSpent`. The rescan respects the cache TTL — a recently-cached `isSpent === false` doesn't force a fresh query.
- Feature flag: `features.spentStateRescan` (default-OFF during soak; flip to default-ON after 7-day testnet observation).

**Relationship to other surfaces**:
- **Complementary to §12.3.1**: the profile-pointer rescan catches the spend IF the spending device publishes a snapshot to the aggregator before our local poll fires. §12.3.2 catches it independently of whether the spender device's snapshot has propagated.
- **Complementary to Item #14 Phase 1**: Phase 1's `transfer:double-spend-detected` is REACTIVE (fires at our next `send()` attempt). §12.3.2 is PROACTIVE (fires from the background sweep before any send attempt).
- **Distinct from orphan-spending sweeper** (Item #166 P2 #1): that sweeper looks at tokens stuck `'transferring'` with no matching OUTBOX/SENT entry. §12.3.2 looks at tokens at `'confirmed'` AND in the active manifest.

**Operator override**: when Issue #174 lands, an `{ features: { spentStateRescan: false } }` SDK init flag will disable the worker. Disabling leaves the wallet dependent on the reactive surface (Item #14 Phase 1) for off-record-spend detection.

---

## 13. Implementation Plan (deferred to UXF-TRANSFER-IMPL-PLAN.md)

The implementation will land in waves:

- **Wave T.1** — Wire-format types. `UxfTransferPayload` discriminated union, `DeliveryStrategy`, `transferMode: 'instant' | 'conservative' | 'txf'`, `txfFinalization: 'instant' | 'conservative'`, payload encode/decode helpers, unit tests. Audit and update existing `TransferMode` exhaustiveness checks (breaking-widening per §10.1). Add `_audit` collection key to `PROFILE_KEY_MAPPING`. Define `DispositionReason` and `AuditStatus` enums.
- **Wave T.2** — Sender bundle construction for **conservative mode** (UXF wire) + CAR-embed delivery with the 16 KiB default cap + `force-inline` / `force-cid` / custom `inlineCapBytes` per-call overrides. Fixed conservative 96 KiB hard ceiling; NIP-11 relay-discovery is deferred per §12.2. Publish-time relay-rejection auto-falls-back to CID for `delivery: 'auto'`. Conservative ships first because the chain has no unfinalized tail when it goes out. Sender also walks the source token's history and finalizes any inherited pending txs before bundle build.
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
  - Retry-on-belief loop in §6.1: submit-side transient errors retried up to `MAX_SUBMIT_RETRIES`; poll-side `PATH_NOT_INCLUDED` polled until `POLLING_WINDOW` (default 30 min); poll-side `PATH_INVALID` / `NOT_AUTHENTICATED` retried up to `MAX_PROOF_ERROR_RETRIES`.
  - Cascade-on-hard-rejection per §6.1.1.
  - `payments.importInclusionProof()` API for the stuck-PENDING escape hatch.
  - `transfer:trustbase-warning` on poll-side `NOT_AUTHENTICATED` (likely stale trustBase); `transfer:security-alert` only on sustained NOT_AUTHENTICATED after trustBase refresh in conservative mode (out-of-scope failure surfaced).
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
