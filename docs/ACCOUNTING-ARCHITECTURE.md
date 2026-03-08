# Accounting Module Architecture

> **Status:** Draft specification — no code yet
> **Module path:** `modules/accounting/AccountingModule.ts`
> **Barrel:** `modules/accounting/index.ts`

## 1. Overview

The Accounting Module extends Sphere SDK with invoice creation, tracking, and settlement capabilities. It follows the SDK's existing module pattern (like `PaymentsModule`, `MarketModule`) and integrates with the existing token and transfer infrastructure without modifying it.

### Design Principles

| Principle | Rationale |
|-----------|-----------|
| **Invoice IS a token** | An invoice is a minted on-chain token — the invoice terms live in the token's genesis `tokenData` field. There are no external metadata fields outside the token itself. The token ID (guaranteed unique by the aggregator) is the invoice ID. |
| **Local-first accounting** | Each party computes invoice status from its own token inventory — no shared on-chain state, no consensus needed. Status is **never** stored for non-terminal invoices; it is always derived on-demand. Terminal invoices have frozen balances persisted locally. |
| **On-chain referenced balances** | Invoice balances are derived **exclusively** from token transfers whose on-chain `TransferTransactionData.message` field references the invoice. The reference is embedded in the cryptographic proof chain (aggregator SMT), not in the Nostr transport layer. A persistent invoice-transfer index captures expanded per-coin entries by scanning token transaction histories — queried in-memory, no rescan at query time. Physical token inventory is irrelevant to invoice accounting. |
| **Read-only dependency on PaymentsModule** | AccountingModule reads from `PaymentsModule` (getTokens, events) and scans token transaction histories for on-chain invoice references. It never calls `send()` directly except for auto-return, where it invokes `send()` to return tokens for terminated invoices. |
| **Outbound payment blocking for terminated invoices** | Outgoing forward payments (`INV:<id>:F`) referencing a locally terminated (CLOSED or CANCELLED) invoice are **blocked** — the transfer is prevented and an exception is thrown. This is enforced at the `payInvoice()` / memo-construction layer, not in `PaymentsModule.send()`. |
| **Non-blocking inbound observer** | Accounting errors during inbound transfer processing MUST NEVER break the token transfer flow. Inbound transfers are atomic — they either happen fully or not at all. The accounting module is a side-effect observer that processes inbound transfers after the fact. |
| **Idempotent event re-firing** | The same event (with the same or updated `confirmed` flag) may fire multiple times for the same underlying transfer. Event consumers MUST be idempotent — handling a re-fired event must produce the same result as handling it once. This is the fundamental contract. |
| **Receipt DMs are opt-in and best-effort** | Receipt DMs are sent explicitly by the target via `sendInvoiceReceipts()`, never automatically on close/cancel. Delivery is best-effort — failures for individual senders are collected but do not block others or affect invoice state. Receipts use `CommunicationsModule.sendDM()` (NIP-17 encrypted DMs) with an `invoice_receipt:` prefix for content sniffing. |
| **Cancellation notice DMs are opt-in and best-effort** | Cancellation notices are sent explicitly by the target via `sendCancellationNotices()` after cancelling an invoice. Same delivery model as receipts — best-effort, failures collected in `failedNotices`. Uses `invoice_cancellation:` prefix for content sniffing. Only applicable to CANCELLED invoices (not CLOSED). |

## 2. Architecture Diagram

```
+-----------------------------------------------------------------+
|                         Sphere                                   |
|                                                                  |
|  +----------------+   reads    +--------------------------------+  |
|  |  Payments      |<-----------|    AccountingModule             |  |
|  |  Module        |            |                                 |  |
|  |                |  events    |  - createInvoice()              |  |
|  |  getHistory()  |----------->|  - importInvoice()              |  |
|  |  getTokens()   |            |  - getInvoice()                 |  |
|  |  on(transfer)  |            |  - getInvoices()                |  |
|  |                |  send()    |  - getInvoiceStatus()           |  |
|  |  send()       |<-----------|  - closeInvoice()               |  |
|  +-------+--------+  (auto-   |  - cancelInvoice()              |  |
|          |          return)    |  - payInvoice()                 |  |
|  +-------v--------+            |  - returnInvoicePayment()       |  |
|  |  Oracle         |            |  - setAutoReturn()              |  |
|  |  (Aggregator)   |<-----------|  - getAutoReturnSettings()      |  |
|  |                 |  mint      |  - sendInvoiceReceipts()        |  |
|  |                 |            |  - sendCancellationNotices()    |  |
|  +-----------------+            |  - getRelatedTransfers()        |  |
|                                 |  - parseInvoiceMemo()            |  |
|                                 |  - load() / destroy()           |  |
|  +------------------+  sendDM  |                                 |  |
|  | Communications   |<---------|  (receipt/cancellation DMs)      |  |
|  | Module           |  onDM    |                                 |  |
|  | (optional)       |--------->|  (payer-side DM detection)       |  |
|  +------------------+          +-------+-------+-------+---------+  |
|                                 |  TokenStorage  | StorageProvider |  |
|                                 |  (per-address) | (per-address)   |  |
|                                 |  Invoice tokens| Invoice-Transfer|  |
|                                 |  (TXF format)  | Index:          |  |
|                                 |                | inv_ledger:*    |  |
|                                 |                | inv_ledger_index|  |
|                                 |                | token_scan_state|  |
|                                 +----------------+-----------------+  |
+-----------------------------------------------------------------+
```

## 3. Invoice Data Model

### 3.1 Invoice IS a Token

An invoice is a standard on-chain token. All invoice terms are encoded in the token's **genesis `tokenData` field**. There is no separate metadata store — the token itself is the complete, self-contained invoice.

```
Token (TXF format)
+-- genesis
|   +-- data
|   |   +-- tokenId: string             // = invoice ID (64-char hex, unique via SHA-256 collision resistance;
|   |   //                                   aggregator prevents duplicate minting of same ID)
|   |   +-- tokenType: string           // INVOICE_TOKEN_TYPE_HEX
|   |   +-- coinData: null              // null -- invoice tokens are non-fungible
|   |   +-- tokenData: string           // <-- serialized InvoiceTerms (see below)
|   |   +-- salt: string                // deterministic from signingKey + invoiceBytes
|   |   +-- recipient: string           // creator's DIRECT:// address (or any address)
|   |   +-- ...
|   +-- inclusionProof: ...
+-- state: ...
+-- transactions: ...
```

The `tokenData` field contains a canonical JSON serialization of `InvoiceTerms`:

```
InvoiceTerms (serialized into genesis.data.tokenData)
+-- creator?: string                    // chain pubkey of the invoice creator (OPTIONAL -- anonymous allowed)
+-- createdAt: number                   // ms timestamp (local clock at mint time, NOT aggregator time)
+-- dueDate?: number                    // optional deadline (ms timestamp)
+-- memo?: string                       // free-text or URL
+-- deliveryMethods?: string[]          // ordered list of delivery URLs (highest priority first) -- PLACEHOLDER
+-- targets: InvoiceTarget[]            // what needs to be paid, to whom
    +-- address: string                 // DIRECT:// address of recipient
    +-- assets: InvoiceRequestedAsset[] // requested assets for this address
        +-- coin?: CoinEntry            // fungible token request (same type as genesis coinData entry)
        +-- nft?: NFTEntry              // NFT request (placeholder)
```

**Anonymous invoices:** The `creator` field is optional. Anyone can create an invoice without identifying themselves. When `creator` is omitted, the invoice is anonymous. The authorization model is the same for anonymous and non-anonymous invoices: only **target** parties may explicitly close or cancel. The `creator` field is informational — it does not gate any authorization.

**Creator identity trust model:** The `creator` field is **self-asserted** — the minter can set it to any pubkey. The aggregator does not verify that `creator` matches the minting key. Applications requiring verified creator identity should use out-of-band verification (e.g., receiving the invoice token directly from the claimed creator via authenticated transport). The `creator` field is **informational only** — it identifies who created the invoice but does not gate any authorization. All explicit close/cancel authorization is target-based.

**Privacy limitation of anonymous invoices:** Even when `creator` is omitted, the minting process embeds the minter's signing key in the salt derivation and sets the minter's DirectAddress as the `recipient` in genesis data. The minter's on-chain identity is therefore still discoverable. Additionally, the deterministic salt (`SHA-256(signingKey || invoiceBytes)`) enables cross-invoice linkability — an observer can determine if two invoices were created by the same wallet. "Anonymous" means the `creator` field is absent from InvoiceTerms (affecting close/cancel authorization), not that the minter's identity is hidden on-chain.

**Anonymous invoices and auto-return:** Auto-return works the same for anonymous and non-anonymous invoices. Only target parties can terminate an invoice (close or cancel), and only target parties can configure auto-return. The authorization model is consistent: if you can terminate the invoice, you can configure its auto-return behavior.

**Delivery methods:** The `deliveryMethods` field is an optional ordered list of URLs specifying how payments should be delivered, in priority order (first URL = highest priority). This is a **placeholder** for future use — the current SDK uses the Nostr-based delivery network exclusively. When delivery method support is implemented, a payer should attempt delivery to the first URL, falling back to subsequent URLs on failure.

### 3.2 Shared Asset Types: CoinEntry and NFTEntry

Invoice targets reuse the **same types** used elsewhere in the SDK for token genesis and asset representation. This ensures consistency and avoids parallel type hierarchies.

**CoinEntry** — the same `[coinId, amount]` tuple used in `TxfGenesisData.coinData`:

```
CoinEntry = [string, string]            // [coinId, amount] -- e.g., ["UCT", "1000000"]
```

This is the existing format from `TxfGenesisData.coinData: [string, string][]`. Invoice targets reference coins using the exact same tuple, so the same parsing/validation code works for both genesis coin definitions and invoice asset requests.

**NFTEntry** — placeholder for future NFT support (not yet implemented in Sphere SDK):

```
NFTEntry
+-- tokenId: string                     // unique NFT token ID (64-char hex)
+-- tokenType?: string                  // NFT type identifier (64-char hex)
```

**InvoiceRequestedAsset** — a union wrapper that holds either a CoinEntry or an NFTEntry:

```
InvoiceRequestedAsset
+-- coin?: CoinEntry                    // [coinId, amount] -- fungible token request
+-- nft?: NFTEntry                      // NFT request (placeholder)
```

Exactly one of `coin` or `nft` must be set per asset entry.

### 3.3 Multi-Address, Multi-Asset

A single invoice can request payments to **multiple** destination addresses, each with **multiple** asset types. This supports exchange/swap scenarios:

```
Invoice #abc123 (encoded in tokenData):
  Target 1: DIRECT://alice...
    - coin: ["USDU", "500000000"]
    - coin: ["UCT", "1000000"]
  Target 2: DIRECT://bob...
    - coin: ["ALPHA", "200000"]
```

The invoice is **fully covered** only when every target address has received every requested asset in full.

### 3.4 Status: Computed for Active, Frozen for Terminated

For **non-terminal invoices** (OPEN, PARTIAL, COVERED, EXPIRED), status is a **dynamic property** derived on-demand from the persistent invoice-transfer index (§3.7). The index captures expanded per-coin transfer entries at processing time. `getInvoiceStatus()` reads from the in-memory index and balance cache — no history scan at query time.

For **terminal invoices** (CLOSED, CANCELLED), the balances are **frozen and persisted**. Once an invoice reaches a terminal state, the frozen balance snapshot is stored locally and returned on subsequent queries without recomputation. New transfers referencing a terminated invoice do not change the frozen balances or status — but they may trigger auto-return behavior (see Section 4.5). The `allConfirmed` field in frozen balances is an exception: it is **dynamically derived** from PaymentsModule on each query (checking whether all related tokens now have confirmed proofs), not frozen at the time of termination. This ensures that tokens confirmed after termination are accurately reflected.

### 3.5 Multi-Asset Tokens

A single token in Unicity can carry **multiple coin entries** in its genesis `coinData` field (e.g., `[["UCT", "500"], ["USDU", "1000"]]`). When such a multi-asset token is transferred with an invoice memo, the transfer covers **multiple assets simultaneously** for the target address.

The accounting module must handle this:

1. **Single transfer, multiple asset updates.** When a transfer carries a token with `coinData = [["UCT", "500"], ["USDU", "1000"]]` and memo `INV:abc:F`, both the UCT and USDU balances for the matching target are updated.
2. **Per-asset accounting.** Each coin entry in the token's `coinData` is matched independently against the invoice target's requested assets. One coin may match (relevant) while another may not (irrelevant for that target).
3. **InvoiceTransferRef per coin.** A single transfer involving a multi-asset token produces one `InvoiceTransferRef` per coin entry in the token, each with its own `coinId` and `amount`.
4. **Per-sender balances apply per coin.** Per-sender balances are maintained independently for each coin entry. A multi-asset token from sender S1 with `coinData = [["UCT", "500"], ["USDU", "1000"]]` contributes 500 to S1's UCT balance and 1000 to S1's USDU balance at the target address.

### 3.6 Balance Computation Model

**Invoice balances are derived from transaction history, not token inventory.**

For a given invoice target and asset (e.g., target `DIRECT://alice`, asset `UCT`):

```
coveredAmount    = sum(forward payments referencing this invoice for this target:asset)
returnedAmount   = sum(back/return payments referencing this invoice for this target:asset)
netCoveredAmount = max(0, coveredAmount - returnedAmount)   // validation ensures non-negative; max(0,...) is defensive only
```

Key rules:

1. **Only invoice-referenced transfers count.** A transfer affects an invoice balance if and only if its on-chain `TransferMessagePayload.inv.id` (or, for legacy transfers, its transport memo `INV:<invoiceId>`) references that invoice. The mere presence or absence of tokens in the wallet is irrelevant.

2. **Spending received tokens is independent.** A recipient can freely spend tokens received for a partially covered (or even uncovered) invoice without affecting that invoice's balances. The invoice accounting tracks memo-referenced transfers, not token ownership chains.

3. **Self-payments are excluded.** A forward payment where the sender address matches the target address (sender pays themselves) is **not counted** toward `coveredAmount`. Self-directed forward transfers with invoice memos are classified as `invoice:irrelevant` with reason `'self_payment'`. This prevents a target from fabricating coverage without receiving actual external payments.

4. **Return payments decrease balance.** A return payment (`INV:<id>:B`) decreases the net covered amount for the matching target:asset. This handles overpayments, refunds, and corrections. Auto-return payments (`INV:<id>:RC` or `INV:<id>:RX`) also decrease the balance, just like manual `:B` returns. Note: return payments are matched by **sender** address (returns flow FROM target TO payer), unlike forward payments which are matched by destination address. Each return is matched to a specific sender — the return amount cannot exceed what that sender has forwarded to the target for that coinId.

5. **Only target parties may send return payments.** Back/return payments (`:B`, `:RC`, `:RX`) can only be sent by a party whose wallet address matches one of the invoice targets. Non-target parties can only make forward payments (`:F`). This is enforced by `returnInvoicePayment()` and the auto-return system.

6. **Returns SHOULD NOT exceed covered amount.** `returnInvoicePayment()` enforces that the return amount does not exceed the per-sender net balance for the specified (target, sender, coinId) tuple — throws `INVOICE_RETURN_EXCEEDS_BALANCE` before the transfer happens. A target cannot return to sender S more than S has effective balance **via the convenience API**. This is a convenience-layer check, NOT a protocol-level invariant — direct use of `PaymentsModule.send()` with an `INV:<id>:B` memo can bypass it. The `max(0, ...)` floor in the `netCoveredAmount` formula is therefore a **necessary** defensive safeguard, not dead code. This applies in all invoice states; what differs between terminal and non-terminal invoices is the *baseline* (closure resets per-sender balances and assigns surplus — see rules 8–9 below — but the cap still applies against the effective post-reset balance).

7. **Frozen at terminal states.** Once an invoice reaches CLOSED or CANCELLED, its balances are frozen and persisted. The frozen snapshot determines the baseline for subsequent queries. Post-termination transfers (incoming forwards, manual returns, auto-returns) continue to be tracked per-sender on top of the frozen baseline.

8. **CLOSED resets per-sender balances (payments accepted).** Closing an invoice means the target party accepts the payments received so far as final. At freeze time, all pre-closure per-sender balances are reset to zero — pre-closure payments are non-returnable. The surplus (if any) is assigned **per (target, coinId)** to the **latest sender** for that tuple (by processing order — the sender whose forward payment for that specific target:coinId was being processed inside the per-invoice gate when the close condition was met). In multi-target invoices, different targets may have different latest senders. Post-closure per-sender tracking starts from: surplus balance for the latest sender of each target:coinId, zero for all others. Any new forward payments arriving after closure are tracked per-sender normally and are fully returnable.

   **Race condition awareness:** Because payments are processed one-at-a-time through the per-invoice serialization gate, a payment from another sender may arrive while the triggering payment's close sequence is executing. That concurrent payment is a *post-closure* payment — its per-sender balance must NOT be reset to zero and must NOT be assigned surplus. Only the sender whose payment is inside the gate when the close triggers is the "latest sender."

9. **CANCELLED preserves per-sender balances (deal abandoned).** Cancelling preserves all per-sender balances as-is — everything is returnable. Post-cancellation forwards are tracked per-sender normally (added on top of existing balances).

**Per-sender balance tracking (return cap and auto-return distribution):**

For each target address, the module maintains a per-sender breakdown of forward balances. This enables:
1. **Return cap enforcement:** `returnInvoicePayment()` to sender S is capped at what S has sent to the target (net of previous returns to S).
2. **Auto-return distribution:** On close/cancel, auto-return iterates each sender individually, returning to each at most what they sent.

For a given (target, sender, coinId) tuple:
```
senderNetBalance = max(0, sum(sender's forwards to target for coinId) - sum(returns to sender for coinId))
```

The **aggregate** `netCoveredAmount` (across all senders) is still used for coverage determination (`isCovered`). The **per-sender** `senderNetBalance` is used for return validation and auto-return distribution.

### 3.7 On-Chain Invoice References & Persistent Index

#### 3.7.1 On-Chain References (Not Nostr)

Invoice references are recorded **on-chain** in the `TransferTransactionData.message` field of each token transfer's proof chain. This is embedded in the aggregator's Sparse Merkle Tree and is cryptographically verifiable. The Nostr transport memo (`INV:` format) is a secondary, display-only channel.

The on-chain `message` carries a structured `TransferMessagePayload`:
```
{ inv: { id: "<64-hex invoiceId>", dir: "F"|"B"|"RC"|"RX", ra?: "<DIRECT://...>", ct?: { a: "<DIRECT://...>", u?: "<URL>" } }, txt?: "..." }
```

The optional `ra` (refund address) field provides an explicit return destination for the payer. When the sender uses a masked predicate, the sender address becomes unresolvable, making `ra` essential. For unmasked predicates, `ra` overrides the sender address as the return destination and per-sender balance key. It is set by the payer via `payInvoice({ refundAddress })` and is NOT included in the transport memo (privacy: transport memos are human-readable). Auto-return destination priority: `ra` → sender address → fail.

The optional `ct` (contact) field provides payer contact info for future communication between the invoice target and the payer (receipts after close, cancellation notices, payment reminders). `ct.a` is a required DIRECT:// address; `ct.u` is an optional non-Nostr transport URL (https:// or wss://, max 2048 chars). Set by the payer via `payInvoice({ contact })`. When `contact` is not explicitly provided, `payInvoice()` auto-populates it from `identity.directAddress`. Like `ra`, contact is NOT included in the transport memo. Contact is purely informational — it does not affect auto-return routing or balance computation. Per-sender `contacts` (on `InvoiceSenderBalance`) accumulates all unique contact entries from that sender's transfers. Applications SHOULD use the contact resolution priority: `contacts[0].address → refundAddress → senderAddress → null` when needing to reach a payer. **Security:** `contact.address` is self-asserted by the payer — applications MUST NOT trust it as identity verification (see ACCOUNTING-SPEC.md §4.9).

**PaymentsModule.send() change required:** Currently, `TransferCommitment.create()` always receives `null` for the `message` parameter. This must be changed to encode the memo into the on-chain message field **for invoice-related transfers only**. For invoice-related memos (`INV:` prefix), the on-chain message carries the structured `TransferMessagePayload` JSON (not the raw memo text). Non-invoice memos are NOT encoded on-chain — they remain transport-only (Nostr) to avoid permanently recording private user text on-chain. See ACCOUNTING-SPEC.md §4.7 for the `parseInvoiceMemoForOnChain()` helper. This change affects all transfer paths (direct send, split-and-send, V5 instant split).

#### 3.7.2 Persistent Invoice-Transfer Index

The module scans **token transaction histories** (`TxfToken.transactions[]`) for on-chain invoice references and maintains a persistent index.

**Why not getHistory()?** `HistoryRecord` exposes a single `coinId`/`amount` and the Nostr memo — it cannot provide multi-asset data or the on-chain message. The authoritative source is the token's proof chain.

**Index architecture:**

1. **Per-invoice transfer ledger** — partitioned storage, one key per invoice. Each entry is an `InvoiceTransferRef` with composite dedup key `${transferId}::${coinId}`. Multi-asset transfers produce one entry per coin.

2. **Token scan watermark** — tracks how many `TxfToken.transactions[]` entries have been processed per token. On restart, only the unprocessed tail is scanned.

3. **Core processing function** `processTokenTransactions()` — scans a token's transaction array, decodes `TransferMessagePayload` from each transaction's on-chain message, expands multi-asset coins into individual index entries, and applies idempotent dedup.

4. **Population paths:**
   - **Cold start:** Load persisted index, then scan unprocessed transaction tails.
   - **Incremental:** `transfer:incoming` and `transfer:confirmed` events call `processTokenTransactions()`.
   - **Retroactive:** On `createInvoice()` / `importInvoice()`, scan all tokens for pre-existing payments.

5. **Query:** `getInvoiceStatus()` reads directly from the in-memory index and a lazy `balanceCache` — no token scans at query time.

**Dynamic computation applies only to non-terminal invoices.** For terminal invoices, the persisted frozen balances are returned directly. The index still records post-termination transfers for `getRelatedTransfers()`.

See ACCOUNTING-SPEC.md §4.1 for the on-chain format and §5.4 for the complete index specification.

## 4. Invoice Lifecycle & State Machine

### 4.1 States

| State | Description |
|-------|-------------|
| `OPEN` | Invoice created, no payments matched yet |
| `PARTIAL` | At least one matching payment received, but not all targets fully covered |
| `COVERED` | All targets fully covered (unconfirmed — at least one related token lacks full proof chain) |
| `CLOSED` | All targets fully covered AND all related tokens fully confirmed. **Terminal.** Also triggered by explicit `closeInvoice()`. |
| `CANCELLED` | Target party explicitly cancelled the invoice. **Terminal.** |
| `EXPIRED` | `dueDate` passed without reaching CLOSED (if dueDate was set). **Not terminal** — can still transition to CLOSED. |

### 4.2 State Transitions

```
                     +----------+
                     |   OPEN   |---cancel()--+
                     +----+-----+             |
                          | payment matched   |
                          v                   |
                     +----------+             |
              +------|  PARTIAL |---cancel()--+
              |      +----+-----+             |
              |           | all               |
              |           | covered           |
              |           v                   v
              |      +----------+        +----------+
              |      | COVERED  |-cancel->|CANCELLED |
              |      +----+-----+        +----------+
              |           | all confirmed     ^
              |           | OR explicit close()  |
              |           v                   |
              |      +----------+             |
              +----->|  CLOSED  |<---+        |
              |      +----------+    |        |
              |           ^          |        |
              |           |          |        |
              |     close()          |        |
              |     (explicit,       |        |
              |      from any        |        |
              |      non-terminal)   |        |
              |                      |        |
              |      +----------+    |        |
              |      | EXPIRED  |----+ cancel()
              |      +----+-----+  all covered
              |           ^        + confirmed
              |           |
              | dueDate passed
         (from OPEN or PARTIAL only)
```

**Note:** The diagram above is simplified. In practice, `closeInvoice()` and `cancelInvoice()` can be called from ANY non-terminal state (OPEN, PARTIAL, COVERED, EXPIRED), not just the states shown with arrows. Forward transitions not shown: EXPIRED → COVERED (if all targets become covered after dueDate but before all confirmed) → CLOSED (once all confirmed). Additionally, return payments can reduce coverage, causing reverse transitions (e.g., EXPIRED → OPEN if all coverage is returned, PARTIAL → OPEN if all payments are returned, COVERED → PARTIAL if returns drop below full coverage).

Key transitions:
- **EXPIRED is not terminal.** An expired invoice can still transition to COVERED/CLOSED if all targets become fully covered (and confirmed) after the due date. EXPIRED is only reachable when not all targets are covered — if the invoice is COVERED (all targets met but unconfirmed), it stays COVERED even after the due date passes, and transitions to CLOSED once confirmed. Note: EXPIRED takes priority over PARTIAL in the status algorithm — a partially covered invoice past its due date shows EXPIRED, not PARTIAL.
- **EXPIRED detection is passive.** The `invoice:expired` event fires when `getInvoiceStatus()` is called or when an inbound event triggers recomputation — there is no background timer. If no events arrive and no status queries are made after the due date, the `invoice:expired` event will not fire until the next interaction. Applications requiring prompt expiration notification should poll `getInvoiceStatus()` or set a `setTimeout` based on `dueDate - Date.now()`.
- **Clock skew.** EXPIRED is a local-only state derived from `Date.now() > dueDate`. Different parties may have different system clocks, so they may disagree on whether an invoice is expired. Implementations SHOULD tolerate up to 60 seconds of clock skew in UI presentation (e.g., showing "expiring soon" rather than hard cutoff). The `dueDate` is a signal, not an enforcement mechanism — there is no on-chain expiration.
- **CANCELLED is terminal (locally).** Once cancelled, the invoice remains cancelled on the local party's side regardless of subsequent payments. Balances are frozen and persisted. See Section 4.4 for cancellation semantics.
- **CLOSED is terminal (locally).** Two paths to CLOSED: (1) implicit — all targets covered + all tokens confirmed; (2) explicit — a **target** party calls `closeInvoice()` at any time (satisfied with current payments). Balances are frozen and persisted. Only target parties may explicitly close. A third path exists on the sender side: implicit close via `autoTerminateOnReturn` when receiving an `:RC` auto-return (see §4.5). After implicit close, if auto-return is enabled and the wallet is a target, surplus auto-return is triggered immediately.
- **Frozen terminal states.** Once CLOSED or CANCELLED, the frozen balance snapshot is persisted. Dynamic recomputation stops. New transfers referencing the invoice may trigger auto-return but do not change the status.

### 4.3 Close vs Cancel Semantics

**`closeInvoice()`** — Explicit close. A **target** party signals they are **satisfied** with what has been paid so far. No more payments needed. The invoice may be partially covered — the target accepts the current state as final. Only target parties may close an invoice — closing affects the target's receivable balances, making it a target-side decision.

**`cancelInvoice()`** — Cancellation. A **target** party abandons the **deal or session** associated with this invoice. The invoice is no longer relevant. Payments already made may need to be returned. Only target parties may cancel — this prevents a payer from unilaterally cancelling an invoice they owe.

Both are local-only operations. The distinction matters for:
1. **Per-sender balance reset.** Closing resets all per-sender balances to zero (pre-closure payments are accepted as final, non-returnable) with only the surplus assigned to the latest sender (by processing order — the sender whose payment triggered closure). Cancellation preserves all per-sender balances as-is (everything returnable). Both are target-only operations. See §3.6 rules 8–9.
2. **Auto-return memo direction codes.** Tokens auto-returned for a closed invoice use `:RC` (return-for-closed); for a cancelled invoice, `:RX` (return-for-cancelled). This tells the original sender why their tokens were returned.
3. **Recipient-side auto-termination.** When a sender receives an auto-return with `:RC` or `:RX`, the sender's accounting module may auto-terminate the invoice on their side with the same terminal state (close or cancel respectively).
4. **Semantic intent.** Application UIs can display different messages: "Invoice closed — payment accepted" vs "Invoice cancelled — deal abandoned."

### 4.4 Cancellation and Closure Semantics (Local-Only)

**Cancellation and closure are strictly local operations.** No other party learns about them directly. However, auto-return payments carry direction codes (`:RC`, `:RX`) that implicitly communicate the termination reason.

Key implications:

1. **No broadcast.** There is no explicit notification mechanism. The invoice token remains valid on-chain; only the local state changes. Auto-return transfers serve as implicit notifications.

2. **Outbound forward payment blocking.** When a local party has terminated an invoice (CLOSED or CANCELLED), outgoing forward payments (`INV:<id>:F`) referencing that invoice are **blocked**. The `payInvoice()` method (or memo construction layer) throws an exception — the token transfer does NOT happen. This prevents the payer from sending tokens to a locally terminated invoice.

3. **Auto-return on terminated invoices.** When enabled, incoming forward payments referencing a terminated invoice are immediately auto-returned. The auto-return transfer uses `INV:<id>:RC` (for closed) or `INV:<id>:RX` (for cancelled) as the memo direction code. See Section 4.5.

4. **Perspective divergence.** Your CLOSED does not mean others' CLOSED. Sender and recipient may have different views:
   - Sender sees CLOSED (all their payments confirmed) while recipient sees PARTIAL (hasn't received all payments yet due to network delay)
   - Recipient sees CANCELLED locally, but payer doesn't know and keeps sending payments (until they receive an auto-return)

### 4.5 Auto-Return System

Auto-return is a mechanism where the accounting module automatically returns tokens for **terminated** invoices. This is managed by the accounting module, not application code. Only invoice target parties (whose wallet address matches an invoice target) can return tokens.

**Enabling auto-return:**
- **Per-invoice:** `setAutoReturn(invoiceId, true)` — enable auto-return for a specific terminated invoice.
- **Global:** `setAutoReturn('*', true)` — enable auto-return for all terminated invoices.
- Auto-return can be enabled/disabled at any time, even after termination.
- Auto-return is **always allowed** for terminated invoices — calling `setAutoReturn()` on a non-terminated invoice stores the preference but has no effect until it terminates.
- **Precedence rule:** Per-invoice settings take priority over global. Effective auto-return for an invoice is `perInvoice[id] ?? global`. Setting `setAutoReturn(invoiceId, false)` disables auto-return for that specific invoice even when global is enabled.

**Immediate trigger on enable:** When auto-return is enabled for an already-terminated invoice, the auto-return operation is triggered **immediately** for that invoice (not just for future incoming payments):
- **CLOSED invoice:** Auto-return the **surplus only** to the **latest sender per (target, coinId)** (by processing order — the sender whose forward payment for that target:coinId triggered closure; see §3.6 rule 8). Since closure resets all per-sender balances to zero except the surplus assigned to the latest sender of each target:coinId, the auto-return is one transfer per target:coinId with surplus. If there is no surplus for a given target:coinId, nothing is returned for that pair.
- **CANCELLED invoice:** Auto-return **each sender's full net balance**. For each target:coinId, iterate all senders and return `senderNetBalance` to each.

Similarly, when enabling auto-return globally (`'*'`), the operation is triggered immediately for all currently terminated invoices.

**Ongoing auto-return behavior (future incoming payments):**
1. An incoming forward payment with memo `INV:<id>:F` arrives for a terminated invoice.
2. If auto-return is enabled for this invoice (or globally), and the local wallet is an invoice target:
   - The incoming transfer is processed normally (recorded in history).
   - **Return destination resolution:** `ref.refundAddress ?? ref.senderAddress`. If both are null (masked predicate with no refund address), the auto-return fires `invoice:auto_return_failed` with reason `'sender_unresolvable'` and is skipped. **Note:** The `contact` field is NOT used for auto-return routing — it is purely for application-level communication (receipts, notices). Auto-return always uses `refundAddress → senderAddress → fail`.
   - The module invokes `PaymentsModule.send()` to return the tokens to the resolved destination address (not aggregated across senders).
   - **CLOSED invoice:** The entire incoming amount is returned to that sender (the invoice is already satisfied — any new payment is surplus by definition).
   - **CANCELLED invoice:** The entire incoming amount is returned to that sender (the deal is abandoned).
   - The return memo uses `INV:<id>:RC` (if invoice is CLOSED) or `INV:<id>:RX` (if CANCELLED).
3. The auto-return transfer is recorded in history like any other transfer.

**Auto-return deduplication (intent log pattern):** Each auto-return is tracked in a persistent ledger (`auto_return_ledger`) keyed by `(invoiceId, originalTransferId)`. The auto-return operation follows a write-first intent log pattern to prevent duplicate sends on crash recovery:

1. Check ledger for `(invoiceId, originalTransferId)` — if entry exists with `status: 'completed'` or `'failed'`, skip. (`failed` entries are terminal until re-enabled via `setAutoReturn()`).
2. **Write intent:** Write ledger entry with `status: 'pending'` and persist.
3. **Send:** Call `PaymentsModule.send()` to return tokens.
4. **Complete:** Update ledger entry to `status: 'completed'` with `returnTransferId`.
5. Fire `invoice:auto_returned` event.

On crash recovery (during `load()`), scan the ledger for `pending` entries. For each, check if the return transfer actually landed (via `getHistory()`): if found, update to `completed`; if not found and `retryCount < 5`, increment retryCount and retry using the persisted `recipient`, `amount`, `coinId`, and `memo` fields from the ledger entry; if `retryCount >= 5`, transition to `failed` status and fire `invoice:auto_return_failed` with reason `'max_retries_exceeded'`. If sender address resolution fails, fire `invoice:auto_return_failed` with reason `'sender_unresolvable'` — the dedup ledger is NOT written, so the return will be retried on the next trigger. If `PaymentsModule.send()` throws, fire `invoice:auto_return_failed` with reason `'send_failed'` and increment retryCount. Failed entries are terminal until re-enabled via `setAutoReturn(invoiceId, true)` which resets retryCount and status to `pending`. These fields are written at intent time (step 2) specifically to enable retry without re-deriving from the original transfer. This makes duplicate returns impossible — the intent is recorded before the send, so re-delivery of the original event hits step 1 and skips. All steps execute within the per-invoice serialization gate.

**Secondary dedup (defense-in-depth):** Before executing any auto-return send, check `getHistory()` for an existing outbound `:RC`/`:RX` transfer matching `(invoiceId, originalTransferId)` — the `originalTransferId` is stored in the auto-return memo's freeText field and extracted via `parseInvoiceMemo()`. This per-transfer match prevents false-positive dedup when the same sender makes multiple forward payments for the same coinId. Catches duplicates when ledger entries have been pruned (completed entries are pruned after 30 days on `load()`).

**Auto-return exclusions — return payments are NEVER auto-returned:**
- Transfers with direction `:B`, `:RC`, or `:RX` are **never** auto-returned.
- This prevents infinite loops (return → auto-return → auto-return → ...).

**Only target parties may return tokens:**
- Back/return payments (`:B`, `:RC`, `:RX`) can only be sent by a party whose wallet address matches one of the invoice targets.
- Non-target parties can only make forward payments (`:F`). Attempting to return from a non-target address throws `INVOICE_NOT_TARGET`.

**Manual return is always allowed:**
- An invoice target can always explicitly return tokens received for any invoice, including non-terminated ones, using `INV:<id>:B`.
- Manual return is independent of the auto-return setting.

**Sender-side implicit termination (opt-in):**
- When a sender receives an auto-return transfer with `:RC`, their accounting module MAY auto-close the invoice locally — even if the invoice was not fully covered from the sender's perspective (the target decided to close).
- When a sender receives an auto-return transfer with `:RX`, their accounting module MAY auto-cancel the invoice locally.
- This is **opt-in** — controlled by `autoTerminateOnReturn` config (default: `false`). It provides implicit cross-party termination signaling without requiring an explicit broadcast mechanism.
- **Implementation note:** Auto-termination uses an internal `_terminateInvoice()` method that performs the freeze-and-persist directly, bypassing the public `closeInvoice()`/`cancelInvoice()` gate acquisition. This prevents deadlock when the event handler is already inside the per-invoice gate. **PREREQUISITE:** `_terminateInvoice()` MUST only be called from code paths that already hold the per-invoice gate. The §6.2 step 3 event handler acquires the gate after indexing (processTokenTransactions) but before `_terminateInvoice()` invocation, satisfying this requirement. See SPEC §6.2 step 3.
- **Over-refund warning:** If the total amount returned to a sender exceeds the total amount that sender has forwarded (for a given coinId), the module fires `invoice:over_refund_warning`. This can happen if a target manually returns more than the sender paid. The warning is informational — the transfer is not blocked.
- **Trust note:** A target can send `:RC`/`:RX` even if the invoice is not actually terminated on their side. The payer's `autoTerminateOnReturn` trusts the direction code at face value. This is acceptable because the target already holds the tokens and could simply not return them — spoofing a direction code gains nothing.

### 4.6 Termination Write Order

When an invoice transitions to a terminal state (CLOSED or CANCELLED), multiple storage writes occur. The write order is critical for crash recovery:

1. **Terminal set FIRST:** Add invoiceId to `closed_invoices` or `cancelled_invoices` set and persist.
2. **Frozen balances SECOND:** Compute balance snapshot and persist to `frozen_balances`.

**Rationale:** If the process crashes between steps 1 and 2, recovery (during `load()`) detects the orphaned terminal set entry (no corresponding frozen balance) and recomputes the frozen balance from the live index. The inverse crash (frozen balance written but not in terminal set) is handled by forward reconciliation: orphaned frozen balances are matched to their terminal set. See SPEC §7.6 for full crash recovery semantics.

### 4.7 Non-Blocking Inbound Guarantee

**Accounting errors MUST NEVER break the inbound token transfer flow.**

Inbound token transfers are atomic — they either happen fully or not at all. The accounting module is a **post-hoc observer** that processes inbound transfers after they complete. Specifically:

- If memo parsing fails, the transfer proceeds normally — accounting just doesn't track it.
- If invoice lookup fails, the transfer proceeds — `invoice:unknown_reference` fires but the transfer is not affected.
- If status computation throws, the transfer is already complete — only the event firing is skipped.
- If auto-return fails, the inbound transfer is still recorded — the auto-return can be retried.
- If storage of accounting data fails, the transfer data is still in `PaymentsModule` history and will be picked up on next recomputation.

The accounting module wraps all its inbound event processing in try/catch guards. No exception from the accounting layer propagates to the payment layer for inbound transfers.

**Outbound forward payments to terminated invoices ARE blocked.** This is the one case where the accounting module prevents a transfer from happening — throwing an exception before `PaymentsModule.send()` is called. This is a deliberate design choice: the caller explicitly attempted to pay a terminated invoice and should be informed via an error.

### 4.8 Concurrency Model

**Per-invoice serialization gate.** All state-mutating operations on a given invoice are serialized through a per-invoice async mutex. This prevents race conditions where concurrent events (e.g., an incoming transfer and an explicit `closeInvoice()` call) could both attempt to freeze balances or trigger auto-returns simultaneously.

**Serialized operations (per invoice):**
- `closeInvoice()`
- `cancelInvoice()`
- `returnInvoicePayment()` — holds gate through validation+send to prevent concurrent double-return on terminal invoices (over-return is fund loss, unlike over-payment which is benign). After successful send(), synchronously updates the in-memory invoice-transfer index before releasing the gate (ensures next serialized operation sees the return). Implementations MUST apply a 60-second timeout to the send() call within the gate to prevent starvation of other serialized operations on the same invoice.
- Implicit close (all targets covered + confirmed)
- Auto-return execution (both immediate and ongoing)
- `setAutoReturn()` immediate trigger
- Inbound event processing that may trigger auto-return

**Non-serialized (read-only) operations (with one exception):**
- `getInvoiceStatus()` — read-only in the common case. However, when it detects an implicit close condition (all targets covered + all confirmed), it acquires the per-invoice gate to freeze balances and persist. Inside the gate, **re-verification is a full recomputation from history** — checking both terminal sets (closedSet/cancelledSet, which may have been modified by a concurrent operation) AND recomputing balances from scratch (which may differ if new transfers arrived). Only if the recomputed state still meets the implicit close condition is the freeze performed. This prevents a race between concurrent implicit close detection and explicit `closeInvoice()`/`cancelInvoice()` calls.
- `getInvoice()`, `getInvoices()`, `getRelatedTransfers()`
- `payInvoice()` — acquires the gate for the terminal-state check only (released before `send()`). A narrow TOCTOU window exists where a concurrent implicit close can terminate the invoice between gate release and send completion. This is an accepted race — see SPEC §5.9 for full rationale and mitigation via auto-return.
- `parseInvoiceMemo()`

**Shutdown:** `destroy()` sets the `destroyed` flag first (before unsubscribing from events), then unsubscribes, then awaits all active gate tails. The destroyed check appears at the entry point of every public method AND inside every gate fn body. See SPEC §2.1 for the full sequence.

**Implementation:** A `Map<string, Promise<void>>` keyed by invoice ID. Each mutating operation chains onto the existing promise (or creates a new one). This is a lightweight cooperative lock — no OS-level primitives needed in single-threaded JavaScript. The gate ensures that if two events arrive in rapid succession for the same invoice, the second waits for the first to complete before executing. **Cleanup:** After each operation completes, if no further operations are queued, the gate entry is deleted from the map to prevent unbounded memory growth over thousands of invoices.

**Global operations** (`setAutoReturn('*', true)`) acquire the gate for each affected invoice sequentially, not all at once. This prevents deadlocks and allows interleaving with per-invoice operations on other invoices. To prevent unbounded execution time, at most 100 invoices are processed per call, with a MUST 5-second cooldown between `setAutoReturn('*')` calls (rejected with `RATE_LIMITED`). When enabling auto-return, `setAutoReturn()` first resets any 'failed' dedup ledger entries to 'pending' (retryCount=0), then triggers the auto-return sweep (see SPEC §7.6).

**Target validation** uses `getActiveAddresses()` (from `Sphere` dependency) to check whether the wallet is a target for close/cancel/return operations. All HD addresses (not just the current one) are checked, ensuring multi-address wallets can operate on invoices targeting any of their addresses.

### 4.9 Status Computation

Status is **computed on-demand** for non-terminal invoices. For terminal invoices, persisted frozen balances are returned. The `getInvoiceStatus()` method:

1. Reads the invoice terms from the token's genesis `tokenData`
2. Checks if the invoice is in a terminal state (CLOSED or CANCELLED) — if so, returns the persisted frozen status (but `allConfirmed` is still dynamically derived)
3. Reads from the **in-memory invoice-transfer index** (`invoiceLedger`) — NOT from `PaymentsModule.getHistory()`. The index is populated at load time and kept current by `transfer:incoming` / `transfer:confirmed` event handlers (see SPEC §5.4.5)
4. Aggregates forward and back/return payments per target per asset from the index entries
5. Computes `netCoveredAmount = max(0, coveredAmount - returnedAmount)` for each target:asset
6. Determines which targets are covered, partially covered, or untouched
7. If all targets are COVERED and all related transfers are confirmed, enters the per-invoice gate to re-verify and perform implicit close (freeze balances, persist terminal state, fire `invoice:closed` then any `invoice:auto_returned` events)
8. Checks `dueDate` — if past and state would be OPEN/PARTIAL, returns EXPIRED
9. Returns the computed `InvoiceStatus` object

Each party independently derives invoice status from their own perspective — sender sees what they've sent, receiver sees what they've received.

## 5. Invoice-as-Token (Minting)

### 5.1 Minting Flow

```
1.  Validate CreateInvoiceRequest
2.  Build InvoiceTerms (add createdAt, optionally add creator pubkey)
3.  Serialize InvoiceTerms canonically -> deterministic bytes (invoiceBytes)
4.  Generate salt: SHA-256(signingKey || invoiceBytes)
5.  Derive tokenId: DataHasher(SHA-256).update(invoiceBytes).digest()
    -> new TokenId(hash.imprint)
    (mirrors NametagMinter's TokenId.fromNameTag() pattern;
     see SPEC §3.1 for the DataHasher usage)
6.  Create MintTransactionData with:
    - tokenId from step 5
    - tokenType: INVOICE_TOKEN_TYPE_HEX
    - coinData: null (non-fungible — null, not empty array)
    - tokenData: invoiceBytes
    - recipient: creator's DirectAddress
7.  Create MintCommitment, submit to aggregator
8.  waitInclusionProof() -> commitment.toTransaction()
9.  UnmaskedPredicate.create() -> Token.mint() or Token.fromJSON()
10. Store invoice token via TokenStorageProvider
11. Scan existing token transaction histories for payments referencing this invoice
12. Fire 'invoice:created' event + any retroactive payment/coverage events
```

### 5.2 Why Mint?

| Benefit | Explanation |
|---------|-------------|
| **Unique ID** | Aggregator guarantees no duplicate token IDs — no UUID collisions |
| **Proof of creation** | On-chain timestamp proves when invoice was created |
| **Self-contained** | The token IS the invoice — all terms in `tokenData`, portable without external metadata |
| **Transferable** | Invoice token can be sent to other parties (e.g., payer receives invoice token) |
| **Auditable** | Anyone with the token can verify it was legitimately minted |

### 5.3 Invoice Token Type

A new token type constant (similar to `UNICITY_TOKEN_TYPE_HEX` for nametags):

```
INVOICE_TOKEN_TYPE_HEX = SHA-256("unicity.invoice.v1")
```

This distinguishes invoice tokens from currency tokens, nametags, and future NFTs.

## 6. Memo-Referenced Payments

### 6.1 Memo Format

Transfers reference invoices via a structured prefix in the existing `TransferRequest.memo` field:

```
INV:<invoiceId>[:<direction>] [optional free text]
```

| Component | Required | Description |
|-----------|----------|-------------|
| `INV:` | Yes | Prefix identifying an invoice-linked transfer |
| `<invoiceId>` | Yes | The invoice token ID (64-char hex) |
| `:F` | No | Forward payment — towards closing the invoice (default if omitted) |
| `:B` | No | Back/return payment — manual refund of surplus or unwanted payment |
| `:RC` | No | Return-for-closed — auto-return of tokens because invoice was closed |
| `:RX` | No | Return-for-cancelled — auto-return of tokens because invoice was cancelled |
| free text | No | Optional human-readable note after a space |

### 6.2 Direction Semantics

| Direction | On-chain `dir` | Transport memo | Meaning | Affects balance | Auto-returnable | Who can send |
|-----------|---------------|----------------|---------|-----------------|-----------------|--------------|
| Forward | `F` (or omitted) | `:F` | Payment towards covering the invoice | +coveredAmount (increases net) | Yes (if invoice terminated) | Anyone |
| Back | `B` | `:B` | Manual return/refund | +returnedAmount (decreases net) | **No** (never auto-returned) | **Target only** |
| Return-for-closed | `RC` | `:RC` | Auto-return because invoice is closed | +returnedAmount (decreases net) | **No** (never auto-returned) | **Target only** |
| Return-for-cancelled | `RX` | `:RX` | Auto-return because invoice is cancelled | +returnedAmount (decreases net) | **No** (never auto-returned) | **Target only** |

All return directions (`:B`, `:RC`, `:RX`) have the same effect on balance computation — they increase `returnedAmount`, which decreases the net covered balance. The distinction between `:B`, `:RC`, and `:RX` is semantic: it communicates _why_ the tokens were returned.

**Sender restriction (outbound AND inbound):** Only a party whose wallet address matches one of the invoice targets may send return payments. Non-target parties can only make forward payments. This restriction is enforced in two places: (1) **outbound:** `returnInvoicePayment()` checks the caller's address; (2) **inbound:** the event handler validates the sender of incoming `:B`/`:RC`/`:RX` transfers against the invoice targets before accepting them as return payments or triggering auto-termination. An inbound return from a non-target sender is classified as `invoice:irrelevant` (reason: `unauthorized_return`).

### 6.3 Examples

```
INV:a1b2c3...ef00:F Payment for order #1234
INV:a1b2c3...ef00:B Refund - overpayment
INV:a1b2c3...ef00:RC Invoice closed by recipient
INV:a1b2c3...ef00:RX Invoice cancelled by recipient
INV:a1b2c3...ef00 Coffee beans (implied forward)
```

### 6.4 Parsing

The AccountingModule registers a memo parser that extracts:
- `invoiceId` — the referenced invoice
- `paymentDirection` — `'forward'` (F or default), `'back'` (B), `'return_closed'` (RC), or `'return_cancelled'` (RX)
- `freeText` — remaining memo content

No changes to `TransferRequest` or the transport layer are needed. However, `PaymentsModule.send()` **must be modified** to encode `TransferRequest.memo` into the on-chain `TransferTransactionData.message` field (see SPEC §4.7).

**Memo injection defense:** The `INV:` memo field is user-controlled — any sender can write any memo. The canonical parser (`parseInvoiceMemo()`) is the sole authority for extracting invoice references. The parser validates the invoice ID format (64-char hex `[0-9a-fA-F]{64}` — guaranteed colon-free and space-free by the SHA-256 derivation), rejects malformed prefixes, and normalizes direction codes. Invalid or unrecognized formats are ignored (treated as non-invoice transfers). Direction codes from untrusted senders are validated against sender identity (see §6.2 sender restriction) before being accepted. Applications MUST NOT parse invoice memos manually — always use `parseInvoiceMemo()`.

## 7. Integration with Existing SDK

### 7.1 Module Lifecycle

Following the established pattern (`PaymentsModule`, `MarketModule`):

```typescript
// In Sphere.ts -- module creation
this.accounting = createAccountingModule(
  { /* AccountingModuleConfig */
    autoTerminateOnReturn: false,  // opt-in
  },
  { /* AccountingModuleDependencies */
    payments: this.payments,
    tokenStorage: this.tokenStorage,
    oracle: this.oracle,
    trustBase: this.trustBase,  // required by InvoiceMinter for waitInclusionProof + Token.mint
    identity: this.fullIdentity,
    storage: this.storage,
    getActiveAddresses: () => this.getActiveAddresses(),
    emitEvent: (type, data) => this.emit(type, data),
  }
);

// Load persisted invoice tokens + frozen balances + scan history for pre-existing payments
// Also performs storage reconciliation:
//   - Forward: orphaned frozen balances (written but not in terminal set) -> add to terminal set
//   - Inverse: orphaned terminal set entries (in set but no frozen balances) -> recompute and freeze
// And crash recovery (pending auto-return ledger entries -> retry or mark completed)
// And ledger pruning (remove completed entries older than 30 days)
await this.accounting.load();

// Cleanup
await this.accounting.destroy();
```

### 7.2 Event Subscription

AccountingModule subscribes to PaymentsModule events to detect invoice-related transfers:

```
PaymentsModule                    AccountingModule
     |                                  |
     |  transfer:incoming               |
     +--------------------------------->| parse memo -> match invoice
     |                                  | -> fire invoice:* events
     |                                  | -> auto-return if terminated + enabled
     |  transfer:confirmed              |
     +--------------------------------->| re-check confirmation
     |                                  | -> re-fire with confirmed:true
     |  history:updated                 |
     +--------------------------------->| recompute affected invoices
```

### 7.3 Payments Arriving Before Invoice (P2P Async)

In a P2P asynchronous environment, a payment referencing an invoice may arrive **before** the invoice token itself is created or imported. The module handles this:

1. **On `transfer:incoming` with unknown invoice ID:** Fire `invoice:unknown_reference` event. The transfer is recorded in history regardless.

2. **On `createInvoice()` or `importInvoice()`:** After storing the invoice token, perform a **full history rescan** — scan all active and sent token transaction history for any transfers whose memo references the newly created/imported invoice. Fire all applicable events (payment, asset_covered, target_covered, covered, closed) as if the payments just arrived. This ensures no payments are missed regardless of arrival order.

This retroactive evaluation is safe because all events are idempotent — re-firing events for already-known transfers produces correct results.

### 7.4 Storage Layout

Invoice tokens are stored via `TokenStorageProvider` — the **same** storage used for nametag tokens and currency tokens. Since all invoice terms live in the token's genesis `tokenData`, no separate metadata storage is needed.

Additional per-address storage keys (the `StorageProvider` handles key scoping — the module passes only the constant suffix, e.g., `storage.set(STORAGE_KEYS_ADDRESS.CANCELLED_INVOICES, ...)`. The `sphere_{addressId}_` prefix shown below is the **IndexedDB** provider's convention; `FileStorageProvider` uses `{addressId}_` without the `sphere_` prefix):

| Storage Key (logical) | Scope | Content |
|------------|-------|---------|
| `cancelled_invoices` | Per-address | Set of cancelled invoice IDs (JSON array) |
| `closed_invoices` | Per-address | Set of closed invoice IDs — explicit `closeInvoice()`, implicit all-covered+confirmed (triggered by `getInvoiceStatus()` or inbound event processing), and sender-side `autoTerminateOnReturn` (JSON array) |
| `frozen_balances` | Per-address | Frozen balance snapshots for terminated invoices (JSON map) |
| `auto_return` | Per-address | Auto-return settings: per-invoice flags and global flag (JSON) |
| `auto_return_ledger` | Per-address | Auto-return deduplication ledger: tracks which transfers have been returned (JSON) |
| `inv_ledger_index` | Per-address | Invoice ledger directory: `Record<invoiceId, { terminated: boolean, frozenAt?: number }>` |
| `inv_ledger:{invoiceId}` | Per-address, per-invoice | Partitioned invoice-transfer index: `InvoiceTransferRef[]` for one invoice |
| `token_scan_state` | Per-address | Token transaction scan watermark: `Record<tokenId, txCount>` — number of transactions already processed per token (JSON object) |

Added to `STORAGE_KEYS_ADDRESS` in `constants.ts`:

```typescript
CANCELLED_INVOICES: 'cancelled_invoices',
CLOSED_INVOICES: 'closed_invoices',
FROZEN_BALANCES: 'frozen_balances',
AUTO_RETURN: 'auto_return',
AUTO_RETURN_LEDGER: 'auto_return_ledger',
// INV_LEDGER prefix: 'inv_ledger:',  // per-invoice partitioned key
INV_LEDGER_INDEX: 'inv_ledger_index',
TOKEN_SCAN_STATE: 'token_scan_state',
```

### 7.5 New Events

Added to `SphereEventType` and `SphereEventMap`:

| Event | Payload | When |
|-------|---------|------|
| `invoice:created` | `{ invoiceId, confirmed }` | Invoice token minted |
| `invoice:payment` | `{ invoiceId, transfer, paymentDirection, confirmed }` | Payment matched to invoice (forward or back/return) |
| `invoice:asset_covered` | `{ invoiceId, address, coinId, confirmed }` | One asset fully covered for one target |
| `invoice:target_covered` | `{ invoiceId, address, confirmed }` | All assets for one target covered |
| `invoice:covered` | `{ invoiceId, confirmed }` | All targets covered (may be unconfirmed) |
| `invoice:closed` | `{ invoiceId, explicit }` | Invoice closed — `explicit: true` if via `closeInvoice()`, `false` if implicit (all confirmed) |
| `invoice:cancelled` | `{ invoiceId }` | Target party cancelled the invoice |
| `invoice:expired` | `{ invoiceId }` | Due date passed (informational — invoice can still be closed) |
| `invoice:unknown_reference` | `{ invoiceId, transfer }` | Transfer memo references an invoice not in local inventory |
| `invoice:overpayment` | `{ invoiceId, address, coinId, surplus, confirmed }` | Payment exceeds requested amount |
| `invoice:irrelevant` | `{ invoiceId, transfer, reason, confirmed }` | Transfer references this invoice but doesn't match any target address or requested asset |
| `invoice:auto_returned` | `{ invoiceId, originalTransfer, returnTransfer }` | Tokens were auto-returned for a terminated invoice |
| `invoice:auto_return_failed` | `{ invoiceId, transferId, reason, refundAddress?, contactAddresses? }` | Auto-return failed — `reason`: `'sender_unresolvable'` \| `'send_failed'` \| `'max_retries_exceeded'` |
| `invoice:return_received` | `{ invoiceId, transfer, returnReason }` | Received auto-return — `returnReason`: `'closed'` (from `:RC`) \| `'cancelled'` (from `:RX`). May trigger sender-side implicit termination |
| `invoice:over_refund_warning` | `{ invoiceId, senderAddress, coinId, forwardedAmount, returnedAmount }` | Total returned to sender exceeds total forwarded — informational warning, transfer not blocked |
| `invoice:receipt_sent` | `{ invoiceId, sent, failed }` | Receipt DMs sent after `sendInvoiceReceipts()` completes |
| `invoice:receipt_received` | `{ invoiceId, receipt: IncomingInvoiceReceipt }` | Receipt DM received from a target (payer-side, detected via `invoice_receipt:` prefix) |
| `invoice:cancellation_sent` | `{ invoiceId, sent, failed }` | Cancellation notice DMs sent after `sendCancellationNotices()` completes |
| `invoice:cancellation_received` | `{ invoiceId, notice: IncomingCancellationNotice }` | Cancellation notice DM received from a target (payer-side, detected via `invoice_cancellation:` prefix) |

**Event ordering guarantee:** `invoice:closed` fires BEFORE any `invoice:auto_returned` events, for both explicit close (via `closeInvoice()`) and implicit close (all targets covered + all confirmed). This ensures listeners can react to the close before seeing the auto-return consequences.

### 7.6 Idempotent Event Re-Firing

All events with a `confirmed` field follow this contract:

- Events **may fire multiple times** for the same underlying transfer — with `confirmed: false`, then again with `confirmed: true`, and potentially again if the same transfer event is re-delivered, or on retroactive history rescan after invoice creation/import.
- **Event consumers MUST be idempotent.** Processing the same event twice must produce the same result as processing it once. This is the fundamental design principle.
- This aligns naturally with the SDK's existing pattern where Nostr may re-deliver events and where `transfer:incoming` precedes `transfer:confirmed`.
- The AccountingModule itself does not track "already fired" state — it simply recomputes and re-fires on every relevant trigger.

## 8. Connect Protocol Extensions

### 8.1 New RPC Methods

| Method | Description |
|--------|-------------|
| `sphere_getInvoices` | List invoices (with optional filters) |
| `sphere_getInvoiceStatus` | Get computed status of a specific invoice |

**Rate-limiting requirement for `sphere_getInvoiceStatus`:** This query has an implicit close side effect — when it detects all targets covered + all confirmed, it acquires the per-invoice gate and triggers freeze + auto-return. Wallet hosts MUST rate-limit calls from dApps: max 1 call/second per invoiceId and max 10 calls/second aggregate per session. Without rate limiting, a malicious dApp with `invoice:read` permission can trigger fund-moving operations (auto-return sends) purely through rapid query polling. See SPEC §9.1 for full rationale.

### 8.2 New Intent Actions

| Action | User sees | Description |
|--------|-----------|-------------|
| `create_invoice` | Invoice creation modal | Create and mint a new invoice |
| `pay_invoice` | Payment modal (pre-filled) | Pay an invoice (sends tokens with memo reference) |
| `close_invoice` | Confirmation modal | Explicitly close an invoice |
| `cancel_invoice` | Confirmation modal | Cancel an invoice |
| `return_invoice_payment` | Return modal | Return tokens for an invoice |
| `set_auto_return` | Confirmation modal | Enable/disable auto-return |
| `send_invoice_receipts` | Confirmation modal | Send receipt DMs to payers of a terminated invoice |
| `send_cancellation_notices` | Confirmation modal | Send cancellation notice DMs to payers of a cancelled invoice |

### 8.3 New Permission Scopes

| Scope | Grants |
|-------|--------|
| `invoice:read` | Read invoice list and status |
| `intent:create_invoice` | Create invoice intent |
| `intent:pay_invoice` | Pay invoice intent |
| `intent:close_invoice` | Close invoice intent |
| `intent:cancel_invoice` | Cancel invoice intent |
| `intent:return_invoice_payment` | Return invoice payment intent |
| `intent:set_auto_return` | Set auto-return intent |
| `intent:send_invoice_receipts` | Send invoice receipts intent |
| `intent:send_cancellation_notices` | Send cancellation notices intent |

## 9. Multi-Party Perspective

### 9.1 Creator/Recipient View

The recipient holds the invoice token and monitors incoming transfers:

```
Invoice OPEN
  <- receive 500 USDU to target[0] (memo: INV:xxx:F) -> PARTIAL
  <- receive 1000 UCT to target[0] (memo: INV:xxx:F) -> target[0] COVERED
  -- recipient spends the 500 USDU token on something else (no invoice ref) --
  -- ^^^ this does NOT affect the invoice balance (no INV: memo) --
  <- receive 200 ALPHA to target[1] (memo: INV:xxx:F) -> COVERED (all targets met)
  ... all tokens confirmed -> CLOSED (implicit)
```

### 9.2 Token Independence

**Spending tokens does not affect invoice balances.** After receiving tokens for an invoice:

- The recipient can spend those tokens freely (for other invoices, purchases, etc.) without affecting the current invoice's covered balance.
- The invoice balance is based on the **memo-referenced transfer history**, not on whether the tokens are still in the wallet.
- The recipient CAN affect the invoice balance by making new transfers that reference the same invoice:
  - Forward payment to self (`INV:xxx:F`) — excluded (self-payments are not counted, see SPEC §5.2)
  - Return payment (`INV:xxx:B`) — decreases balance

### 9.3 Payer/Sender View

The payer receives or imports the invoice token and tracks outgoing transfers:

```
Invoice OPEN (imported/received)
  -> send 500 USDU with memo INV:xxx:F -> PARTIAL (from sender's view)
  -> send 1000 UCT with memo INV:xxx:F -> still PARTIAL
  ...
```

The sender's status reflects what they have sent, which may differ from the recipient's view (network delays, multiple payers).

### 9.4 Multi-Target Partial Visibility

For multi-target invoices, each party has an **inherently partial view**:

- A target party sees inbound payments for their own address but may not see payments to other targets.
- A payer sees their outbound payments but not payments from other payers.
- Only a party routing all payments (e.g., an exchange in a swap) can see the full picture.

Close and cancel operations are **per-wallet, per-perspective**. A target closing their view of the invoice does not close it for other targets. This is a fundamental consequence of local-first accounting. Applications requiring synchronized multi-party termination should use explicit out-of-band coordination (e.g., transport messages).

**Target resolution:** Invoice targets are identified by `DIRECT://` address, which is derived from the chain pubkey. Target matching compares the transfer's destination address (for forward payments) or sender address (for returns) against the `target.address` field stored in the invoice terms at creation time. The addresses are deterministic — there is no ambiguity from nametag resolution or address format differences.

### 9.5 Same Invoice on Multiple HD Addresses

A single wallet may hold the same invoice token on multiple HD addresses (e.g., address 0 and address 1 both import the invoice). Terminal state (CLOSED, CANCELLED) is **per-address** — closing the invoice on address 0 does not close it on address 1. Each address maintains its own frozen balances, auto-return settings, and terminal state. This matches the existing SDK pattern where each address is an independent accounting unit with its own token storage and history.

### 9.6 Third-Party / Exchange View

An exchange creating invoices for two-way swaps can track both sides:

```
Invoice for swap:
  Target 1: Exchange address <- buyer sends USDU
  Target 2: Buyer address   <- exchange sends tokens

Both parties independently verify their side is covered.
```

### 9.7 Async P2P: Payment Before Invoice

```
Time 1: Payer sends 500 USDU with memo INV:abc:F
        -> Recipient receives transfer
        -> AccountingModule fires invoice:unknown_reference (invoice abc not yet known)

Time 2: Recipient imports invoice token abc
        -> AccountingModule scans full history
        -> Finds the earlier 500 USDU transfer with INV:abc:F
        -> Fires invoice:payment, and possibly invoice:asset_covered etc.
```

### 9.8 Termination and Auto-Return Flow

```
--- Close with auto-return (surplus only) ---

Invoice abc requests 1000 UCT from DIRECT://alice.
Alice has received 1200 UCT via INV:abc:F (200 surplus).

Recipient (alice) closes invoice:
  -> closeInvoice('abc', { autoReturn: true })
  -> Balances frozen: covered=1200, net=1200, surplus=200
  -> Auto-return enabled -> IMMEDIATELY returns 200 UCT surplus
     with memo INV:abc:RC
  -> Fires invoice:closed { explicit: true }
  -> Fires invoice:auto_returned (for the 200 surplus return)

Later, sender sends 500 UCT with memo INV:abc:F (unaware of closure):
  -> Token transfer succeeds (inbound transfers are never blocked)
  -> Auto-return enabled -> entire 500 UCT returned with INV:abc:RC
     (any new payment is surplus by definition for a closed invoice)
  -> Fires invoice:auto_returned

--- Cancel with auto-return (everything) ---

Invoice abc requests 1000 UCT from DIRECT://alice.
Alice has received 600 UCT via INV:abc:F.

Recipient (alice) cancels invoice:
  -> cancelInvoice('abc', { autoReturn: true })
  -> Balances frozen: covered=600, net=600
  -> Auto-return enabled -> IMMEDIATELY returns ALL 600 UCT
     with memo INV:abc:RX
  -> Fires invoice:cancelled
  -> Fires invoice:auto_returned (for the 600 return)

Sender receives the auto-return (INV:abc:RX):
  -> Fires invoice:return_received { returnReason: 'cancelled' }
  -> Sender's module MAY auto-cancel invoice abc locally

--- Optional: Send receipts after close ---

Recipient (alice) sends receipts after closing:
  -> sendInvoiceReceipts('abc', { memo: 'Thank you for your payment' })
  -> For each sender with non-zero frozen balance:
     - Resolve DM recipient: contacts[0].address ?? senderAddress (only if not refund address) ?? skip
     - Build InvoiceReceiptPayload with per-asset breakdown
     - Send via CommunicationsModule.sendDM() (NIP-17 encrypted)
  -> Fires invoice:receipt_sent { invoiceId: 'abc', sent: 2, failed: 0 }

Sender receives the receipt DM:
  -> CommunicationsModule delivers DM with 'invoice_receipt:' prefix
  -> AccountingModule detects prefix, parses payload, validates
  -> Fires invoice:receipt_received { invoiceId: 'abc', receipt: ... }
  -> UI renders structured receipt (amount breakdown, memo, terminal state)

--- Optional: Send cancellation notices after cancel ---

Recipient (alice) sends cancellation notices after cancelling:
  -> sendCancellationNotices('abc', {
       reason: 'Deal fell through',
       dealDescription: 'Widget purchase order #1234'
     })
  -> For each sender with non-zero frozen balance:
     - Resolve DM recipient: contacts[0].address ?? senderAddress (only if not refund address) ?? skip
     - Build InvoiceCancellationPayload with per-asset breakdown
     - Send via CommunicationsModule.sendDM() (NIP-17 encrypted)
  -> Fires invoice:cancellation_sent { invoiceId: 'abc', sent: 2, failed: 0 }

Sender receives the cancellation notice DM:
  -> CommunicationsModule delivers DM with 'invoice_cancellation:' prefix
  -> AccountingModule detects prefix, parses payload, validates
  -> Fires invoice:cancellation_received { invoiceId: 'abc', notice: ... }
  -> UI renders structured notice (reason, deal description, contribution breakdown)
```

## 10. Error Handling

**Fundamental rule: accounting errors MUST NOT interrupt inbound token transfers.** All inbound accounting processing is wrapped in try/catch guards. The inbound transfer layer is never blocked or rolled back by accounting failures.

**Outbound forward payments to terminated invoices ARE blocked** — this is intentional and throws an exception.

| Error | Handling |
|-------|---------|
| Mint failure | Return `{ success: false, error }` — same pattern as `NametagMinter`. No transfer is involved. |
| Unknown invoice in memo | Fire `invoice:unknown_reference` event — inbound transfer proceeds normally |
| Irrelevant payment | Fire `invoice:irrelevant` event — inbound transfer proceeds normally |
| Malformed memo | Ignore — treat as a regular transfer with no invoice association |
| Duplicate invoice | Aggregator rejects with `REQUEST_ID_EXISTS` — use deterministic salt for idempotent re-mint |
| Token data parsing failure | Log warning, skip — corrupted tokenData does not crash the module |
| Close by non-target | Reject — only target parties can close |
| Cancel by non-target | Reject — only target parties can cancel |
| Forward payment to terminated invoice | **Throw `INVOICE_TERMINATED`** — the transfer is blocked before it happens |
| Return payment from non-target party | **Throw `INVOICE_NOT_TARGET`** — only invoice target parties may send back/return payments |
| Auto-return failure | Log error — the inbound transfer is already recorded, auto-return can be retried later |
| Event processing failure | Log error, continue — transfer is already complete, accounting catches up on next recomputation |
| Status computation failure | Return error to caller — does not affect any transfer in progress |
| Receipt send to non-terminal invoice | **Throw `INVOICE_NOT_TERMINATED`** — receipts require CLOSED or CANCELLED state |
| Receipt send without CommunicationsModule | **Throw `COMMUNICATIONS_UNAVAILABLE`** — CommunicationsModule is required |
| Receipt DM delivery failure (per-sender) | Collect in `failedReceipts` — does not throw, does not block other receipts |
| Incoming receipt DM parse failure | Ignore silently — treat as regular DM, no error event |
| Cancellation notice send to non-CANCELLED invoice | **Throw `INVOICE_NOT_CANCELLED`** — cancellation notices require CANCELLED state only |
| Cancellation notice send without CommunicationsModule | **Throw `COMMUNICATIONS_UNAVAILABLE`** — CommunicationsModule is required |
| Cancellation notice reason or deal description too long | **Throw `INVOICE_MEMO_TOO_LONG`** — max 4096 characters per field |
| Cancellation notice DM delivery failure (per-sender) | Collect in `failedNotices` — does not throw, does not block other notices |
| Incoming cancellation notice DM parse failure | Ignore silently — treat as regular DM, no error event |

## 11. Future Extensions

These are **not** in scope for v1 but inform the architecture:

- **NFT line items**: `NFTEntry` placeholder ready for when SDK adds NFT support
- **Recurring invoices**: Repeat an invoice template on a schedule
- **Invoice templates**: Reusable invoice definitions without minting
- **Multi-signature approval**: Require N-of-M signers before invoice is valid
- **L1 payment matching**: Match L1 (ALPHA) transfers to invoice targets via L1 history
- **Cross-chain invoices**: Targets on different chains/networks
- **Invoice negotiation**: Counter-offers modifying invoice terms via transport messages
- **CLI commands**: Specified in [ACCOUNTING-SPEC.md §11](./ACCOUNTING-SPEC.md#11-cli-commands) — 14 commands covering the full AccountingModule API, following existing CLI patterns (`invoice-` prefix, `getSphere()`/`closeSphere()` lifecycle) and introducing `--json` as a new convention for machine-readable output
- **Payment reminders**: Use the `contacts` array (from `InvoiceSenderBalance`, accumulated from `inv.ct` on-chain payloads) to send structured reminder messages to payers when payment is overdue. Contact resolution priority: `contacts[0].address → senderAddress → null`. The `contact.url` field enables delivery via non-Nostr transports (HTTPS webhooks, WebSocket endpoints). (Note: **Receipts** and **cancellation notices** are now fully specified — see `sendInvoiceReceipts()` and `sendCancellationNotices()` in ACCOUNTING-SPEC.md §2.1, §4.10, and §4.11.)
