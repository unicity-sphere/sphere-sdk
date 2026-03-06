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
| **Memo-referenced balances** | Invoice balances are derived **exclusively** from transaction history entries whose memo references the invoice. Physical token inventory (whether tokens still exist or have been spent further) is irrelevant to invoice accounting. |
| **Read-only dependency on PaymentsModule** | AccountingModule reads from `PaymentsModule` (getHistory, getTokens, events) but never calls `send()` or modifies payment state directly. The one exception is auto-return, where the module invokes `send()` to return tokens for terminated invoices. |
| **Outbound payment blocking for terminated invoices** | Outgoing forward payments (`INV:<id>:F`) referencing a locally terminated (CLOSED or CANCELLED) invoice are **blocked** — the transfer is prevented and an exception is thrown. This is enforced at the `payInvoice()` / memo-construction layer, not in `PaymentsModule.send()`. |
| **Non-blocking inbound observer** | Accounting errors during inbound transfer processing MUST NEVER break the token transfer flow. Inbound transfers are atomic — they either happen fully or not at all. The accounting module is a side-effect observer that processes inbound transfers after the fact. |
| **Idempotent event re-firing** | The same event (with the same or updated `confirmed` flag) may fire multiple times for the same underlying transfer. Event consumers MUST be idempotent — handling a re-fired event must produce the same result as handling it once. This is the fundamental contract. |

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
|  |                 |  mint      |  - getRelatedTransfers()        |  |
|  |                 |            |  - parseInvoiceMemo()            |  |
|  +-----------------+            |  - load() / destroy()           |  |
|                                 +-------------+-------------------+  |
|                                 |  TokenStorage (per-address)     |  |
|                                 |  - Invoice tokens (TXF)         |  |
|                                 |  (genesis.data.tokenData         |  |
|                                 |   contains invoice terms)        |  |
|                                 +---------------------------------+  |
+----------------------------------------------------------------------+
```

## 3. Invoice Data Model

### 3.1 Invoice IS a Token

An invoice is a standard on-chain token. All invoice terms are encoded in the token's **genesis `tokenData` field**. There is no separate metadata store — the token itself is the complete, self-contained invoice.

```
Token (TXF format)
+-- genesis
|   +-- data
|   |   +-- tokenId: string             // = invoice ID (64-char hex, unique via aggregator)
|   |   +-- tokenType: string           // INVOICE_TOKEN_TYPE_HEX
|   |   +-- coinData: []                // empty -- invoice tokens are non-fungible
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

**Anonymous invoices:** The `creator` field is optional. Anyone can create an invoice without identifying themselves. When `creator` is omitted, the invoice is anonymous — any party holding the invoice locally may close or cancel it (since there is no creator to verify against). For non-anonymous invoices, only the creator may close or cancel.

**Anonymous invoice auto-return restriction:** Auto-return is **disabled** for anonymous invoices. The `autoReturn` option in `closeInvoice()` / `cancelInvoice()` is rejected with `INVOICE_ANON_AUTO_RETURN` for anonymous invoices, and `setAutoReturn()` skips anonymous invoices. This prevents a malicious holder from cancelling an anonymous invoice to trigger auto-return of all accumulated payments. Targets of anonymous invoices may still manually return tokens via `returnInvoicePayment()` (`:B` direction).

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

For **non-terminal invoices** (OPEN, PARTIAL, COVERED, EXPIRED), status is a **dynamic property** derived on-demand from the transaction history of active and sent tokens. Every call to `getInvoiceStatus()` recomputes the status from scratch.

For **terminal invoices** (CLOSED, CANCELLED), the balances are **frozen and persisted**. Once an invoice reaches a terminal state, the frozen balance snapshot is stored locally and returned on subsequent queries without recomputation. New transfers referencing a terminated invoice do not change the frozen balances or status — but they may trigger auto-return behavior (see Section 4.5). The `allConfirmed` field in frozen balances is an exception: it is **dynamically derived** from PaymentsModule on each query (checking whether all related tokens now have confirmed proofs), not frozen at the time of termination. This ensures that tokens confirmed after termination are accurately reflected.

### 3.5 Multi-Asset Tokens

A single token in Unicity can carry **multiple coin entries** in its genesis `coinData` field (e.g., `[["UCT", "500"], ["USDU", "1000"]]`). When such a multi-asset token is transferred with an invoice memo, the transfer covers **multiple assets simultaneously** for the target address.

The accounting module must handle this:

1. **Single transfer, multiple asset updates.** When a transfer carries a token with `coinData = [["UCT", "500"], ["USDU", "1000"]]` and memo `INV:abc:F`, both the UCT and USDU balances for the matching target are updated.
2. **Per-asset accounting.** Each coin entry in the token's `coinData` is matched independently against the invoice target's requested assets. One coin may match (relevant) while another may not (irrelevant for that target).
3. **InvoiceTransferRef per coin.** A single transfer involving a multi-asset token produces one `InvoiceTransferRef` per coin entry in the token, each with its own `coinId` and `amount`.

### 3.6 Balance Computation Model

**Invoice balances are derived from transaction history, not token inventory.**

For a given invoice target and asset (e.g., target `DIRECT://alice`, asset `UCT`):

```
netCoveredAmount = sum(forward payments referencing this invoice for this target:asset)
                 - sum(back/return payments referencing this invoice for this target:asset)
```

Key rules:

1. **Only memo-referenced transfers count.** A transfer affects an invoice balance if and only if its memo contains `INV:<invoiceId>` referencing that invoice. The mere presence or absence of tokens in the wallet is irrelevant.

2. **Spending received tokens is independent.** A recipient can freely spend tokens received for a partially covered (or even uncovered) invoice without affecting that invoice's balances. The invoice accounting tracks memo-referenced transfers, not token ownership chains.

3. **Self-payments are excluded.** A forward payment where the sender address matches the target address (sender pays themselves) is **not counted** toward `coveredAmount`. Self-directed forward transfers with invoice memos are classified as `invoice:irrelevant` with reason `'self_payment'`. This prevents a target from fabricating coverage without receiving actual external payments.

4. **Return payments decrease balance.** A return payment (`INV:<id>:B`) decreases the net covered amount for the matching target:asset. This handles overpayments, refunds, and corrections. Auto-return payments (`INV:<id>:RC` or `INV:<id>:RX`) also decrease the balance, just like manual `:B` returns. Note: return payments are matched by **sender** address (returns flow FROM target TO payer), unlike forward payments which are matched by destination address.

5. **Only target parties may send return payments.** Back/return payments (`:B`, `:RC`, `:RX`) can only be sent by a party whose wallet address matches one of the invoice targets. Non-target parties can only make forward payments (`:F`). This is enforced by `returnInvoicePayment()` and the auto-return system.

6. **Net covered amount is floored at zero.** `netCoveredAmount = max(0, coveredAmount - returnedAmount)`. The net balance can never go negative. `returnInvoicePayment()` validates that the return amount does not exceed the current `netCoveredAmount` for the specified target:asset.

7. **Frozen at terminal states.** Once an invoice reaches CLOSED or CANCELLED, its balances are frozen and persisted. Dynamic recomputation no longer occurs. The frozen snapshot is returned for all subsequent queries.

### 3.7 History Scanning

To compute invoice balances, the module scans the **full transaction history** of all active and sent tokens. This includes:

- **Active tokens** — tokens currently in the wallet's inventory
- **Sent (archived) tokens** — tokens that have been transferred away

Both inbound and outbound transfers are considered. The scan examines the memo field of each history entry to find invoice references.

**Dynamic scanning applies only to non-terminal invoices.** For terminal invoices, the persisted frozen balances are returned directly.

## 4. Invoice Lifecycle & State Machine

### 4.1 States

| State | Description |
|-------|-------------|
| `OPEN` | Invoice created, no payments matched yet |
| `PARTIAL` | At least one matching payment received, but not all targets fully covered |
| `COVERED` | All targets fully covered (unconfirmed — at least one related token lacks full proof chain) |
| `CLOSED` | All targets fully covered AND all related tokens fully confirmed. **Terminal.** Also triggered by explicit `closeInvoice()`. |
| `CANCELLED` | Creator explicitly cancelled the invoice. **Terminal.** |
| `EXPIRED` | `dueDate` passed without reaching CLOSED (if dueDate was set). **Not terminal** — can still transition to CLOSED. |

### 4.2 State Transitions

```
                     +----------+
                     |   OPEN   |
                     +----+-----+
                          | payment matched
                          v
                     +----------+
              +------|  PARTIAL |------+
              |      +----+-----+     |
              |           | all       | cancel()
              |           | covered   |
              |           v           v
              |      +----------+ +----------+
              |      | COVERED  | |CANCELLED |
              |      +----+-----+ +----------+
              |           | all confirmed
              |           | OR explicit close()
              |           v
              |      +----------+
              +----->|  CLOSED  |<---+
              |      +----------+    |
              |           ^          |
              |           |          |
              |     close()          |
              |     (explicit)       |
              |                      |
              |      +----------+    |
              |      | EXPIRED  |----+
              |      +----+-----+  all covered
              |           ^        + confirmed
              |           |
              | dueDate passed
         (from OPEN or PARTIAL only)
```

Key transitions:
- **EXPIRED is not terminal.** An expired invoice can still transition to CLOSED if all targets become fully covered and all related tokens are confirmed after the due date. EXPIRED is only reachable from OPEN or PARTIAL — if the invoice is COVERED (all targets met but unconfirmed), it stays COVERED even after the due date passes, and transitions to CLOSED once confirmed.
- **EXPIRED detection is passive.** The `invoice:expired` event fires when `getInvoiceStatus()` is called or when an inbound event triggers recomputation — there is no background timer. If no events arrive and no status queries are made after the due date, the `invoice:expired` event will not fire until the next interaction. Applications requiring prompt expiration notification should poll `getInvoiceStatus()` or set a `setTimeout` based on `dueDate - Date.now()`.
- **Clock skew.** EXPIRED is a local-only state derived from `Date.now() > dueDate`. Different parties may have different system clocks, so they may disagree on whether an invoice is expired. Implementations SHOULD tolerate up to 60 seconds of clock skew in UI presentation (e.g., showing "expiring soon" rather than hard cutoff). The `dueDate` is a signal, not an enforcement mechanism — there is no on-chain expiration.
- **CANCELLED is terminal (locally).** Once cancelled, the invoice remains cancelled on the local party's side regardless of subsequent payments. Balances are frozen and persisted. See Section 4.4 for cancellation semantics.
- **CLOSED is terminal (locally).** Two paths to CLOSED: (1) implicit — all targets covered + all tokens confirmed; (2) explicit — **creator** calls `closeInvoice()` at any time (satisfied with current payments). Balances are frozen and persisted. Target owners cannot close — only the creator (or any party for anonymous invoices).
- **Frozen terminal states.** Once CLOSED or CANCELLED, the frozen balance snapshot is persisted. Dynamic recomputation stops. New transfers referencing the invoice may trigger auto-return but do not change the status.

### 4.3 Close vs Cancel Semantics

**`closeInvoice()`** — Explicit close. The invoice **creator** signals they are **satisfied** with what has been paid so far. No more payments needed. The invoice may be partially covered — the creator accepts the current state as final. Only the creator may close an invoice — target owners cannot. For anonymous invoices (no `creator` field), any party holding the invoice locally may close it.

**`cancelInvoice()`** — Cancellation. The invoice creator (or any holder, for anonymous invoices) abandons the **deal or session** associated with this invoice. The invoice is no longer relevant. Payments already made may need to be returned. Since cancellation is a local-only operation, any party holding the invoice can cancel it locally — but for non-anonymous invoices, only the creator is authorized (to prevent a payer from unilaterally cancelling an invoice they owe).

Both are local-only operations. The distinction matters for:
1. **Auto-return memo direction codes.** Tokens auto-returned for a closed invoice use `:RC` (return-for-closed); for a cancelled invoice, `:RX` (return-for-cancelled). This tells the original sender why their tokens were returned.
2. **Recipient-side auto-termination.** When a sender receives an auto-return with `:RC` or `:RX`, the sender's accounting module may auto-terminate the invoice on their side with the same terminal state (close or cancel respectively).
3. **Semantic intent.** Application UIs can display different messages: "Invoice closed — payment accepted" vs "Invoice cancelled — deal abandoned."

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
- **CLOSED invoice:** Auto-return the **surplus only** — the amount exceeding the requested amount for each target:asset. If there is no surplus, nothing is returned.
- **CANCELLED invoice:** Auto-return **everything** — all forward payments received for this invoice are returned.

Similarly, when enabling auto-return globally (`'*'`), the operation is triggered immediately for all currently terminated invoices.

**Ongoing auto-return behavior (future incoming payments):**
1. An incoming forward payment with memo `INV:<id>:F` arrives for a terminated invoice.
2. If auto-return is enabled for this invoice (or globally), and the local wallet is an invoice target:
   - The incoming transfer is processed normally (recorded in history).
   - The module invokes `PaymentsModule.send()` to return the tokens to the original sender.
   - **CLOSED invoice:** The entire incoming amount is returned (the invoice is already satisfied — any new payment is surplus by definition).
   - **CANCELLED invoice:** The entire incoming amount is returned (the deal is abandoned).
   - The return memo uses `INV:<id>:RC` (if invoice is CLOSED) or `INV:<id>:RX` (if CANCELLED).
3. The auto-return transfer is recorded in history like any other transfer.

**Auto-return deduplication (intent log pattern):** Each auto-return is tracked in a persistent ledger (`auto_return_ledger`) keyed by `(invoiceId, originalTransferId)`. The auto-return operation follows a write-first intent log pattern to prevent duplicate sends on crash recovery:

1. Check ledger for `(invoiceId, originalTransferId)` — if entry exists with `status: 'completed'`, skip (already returned).
2. **Write intent:** Write ledger entry with `status: 'pending'` and persist.
3. **Send:** Call `PaymentsModule.send()` to return tokens.
4. **Complete:** Update ledger entry to `status: 'completed'` with `returnTransferId`.
5. Fire `invoice:auto_returned` event.

On crash recovery (during `load()`), scan the ledger for `pending` entries. For each, check if the return transfer actually landed (via `getHistory()`): if found, update to `completed`; if not found, retry the send. This makes duplicate returns impossible — the intent is recorded before the send, so re-delivery of the original event hits step 1 and skips. All steps execute within the per-invoice serialization gate.

**Auto-return exclusions — return payments are NEVER auto-returned:**
- Transfers with direction `:B`, `:RC`, or `:RX` are **never** auto-returned.
- This prevents infinite loops (return → auto-return → auto-return → ...).

**Only target parties may return tokens:**
- Back/return payments (`:B`, `:RC`, `:RX`) can only be sent by a party whose wallet address matches one of the invoice targets.
- Non-target parties can only make forward payments (`:F`). Attempting to return from a non-target address throws `INVOICE_NOT_TARGET`.

**Manual return is always allowed:**
- An invoice target can always explicitly return tokens received for any invoice, including non-terminated ones, using `INV:<id>:B`.
- Manual return is independent of the auto-return setting.

**Recipient-side auto-termination (opt-in):**
- When a party receives an auto-return transfer with `:RC`, their accounting module MAY auto-close the invoice locally.
- When a party receives an auto-return transfer with `:RX`, their accounting module MAY auto-cancel the invoice locally.
- This is **opt-in** — controlled by `autoTerminateOnReturn` config (default: `false`). It provides implicit cross-party termination signaling without requiring an explicit broadcast mechanism.

### 4.6 Non-Blocking Inbound Guarantee

**Accounting errors MUST NEVER break the inbound token transfer flow.**

Inbound token transfers are atomic — they either happen fully or not at all. The accounting module is a **post-hoc observer** that processes inbound transfers after they complete. Specifically:

- If memo parsing fails, the transfer proceeds normally — accounting just doesn't track it.
- If invoice lookup fails, the transfer proceeds — `invoice:unknown_reference` fires but the transfer is not affected.
- If status computation throws, the transfer is already complete — only the event firing is skipped.
- If auto-return fails, the inbound transfer is still recorded — the auto-return can be retried.
- If storage of accounting data fails, the transfer data is still in `PaymentsModule` history and will be picked up on next recomputation.

The accounting module wraps all its inbound event processing in try/catch guards. No exception from the accounting layer propagates to the payment layer for inbound transfers.

**Outbound forward payments to terminated invoices ARE blocked.** This is the one case where the accounting module prevents a transfer from happening — throwing an exception before `PaymentsModule.send()` is called. This is a deliberate design choice: the caller explicitly attempted to pay a terminated invoice and should be informed via an error.

### 4.7 Concurrency Model

**Per-invoice serialization gate.** All state-mutating operations on a given invoice are serialized through a per-invoice async mutex. This prevents race conditions where concurrent events (e.g., an incoming transfer and an explicit `closeInvoice()` call) could both attempt to freeze balances or trigger auto-returns simultaneously.

**Serialized operations (per invoice):**
- `closeInvoice()`
- `cancelInvoice()`
- Implicit close (all targets covered + confirmed)
- Auto-return execution (both immediate and ongoing)
- `setAutoReturn()` immediate trigger
- Inbound event processing that may trigger auto-return

**Non-serialized (read-only) operations (with one exception):**
- `getInvoiceStatus()` — read-only in the common case. However, when it detects an implicit close condition (all targets covered + all confirmed), it acquires the per-invoice gate to freeze balances and persist. Inside the gate, the condition is re-verified before freezing (another operation may have already terminated the invoice). This prevents a race between concurrent implicit close detection and explicit `closeInvoice()`/`cancelInvoice()` calls.
- `getInvoice()`, `getInvoices()`, `getRelatedTransfers()`
- `payInvoice()` — only reads terminal state to decide whether to block; the actual `send()` call is delegated to PaymentsModule
- `parseInvoiceMemo()`

**Implementation:** A `Map<string, Promise<void>>` keyed by invoice ID. Each mutating operation chains onto the existing promise (or creates a new one). This is a lightweight cooperative lock — no OS-level primitives needed in single-threaded JavaScript. The gate ensures that if two events arrive in rapid succession for the same invoice, the second waits for the first to complete before executing. **Cleanup:** After each operation completes, if no further operations are queued, the gate entry is deleted from the map to prevent unbounded memory growth over thousands of invoices.

**Global operations** (`setAutoReturn('*', true)`) acquire the gate for each affected invoice sequentially, not all at once. This prevents deadlocks and allows interleaving with per-invoice operations on other invoices.

### 4.8 Status Computation

Status is **computed on-demand** for non-terminal invoices. For terminal invoices, persisted frozen balances are returned. The `getInvoiceStatus()` method:

1. Reads the invoice terms from the token's genesis `tokenData`
2. Checks if the invoice is in a terminal state (CLOSED or CANCELLED) — if so, returns the persisted frozen status
3. Scans transaction history of **all active and sent tokens** (`PaymentsModule.getHistory()`) for memo-matched transfers
4. Aggregates forward and back payments per target per asset
5. Computes `coveredBalance = forward - back` for each target:asset
6. Determines which targets are covered, partially covered, or untouched
7. Checks confirmation status of all related tokens
8. Returns the computed `InvoiceStatus` object

Each party independently derives invoice status from their own perspective — sender sees what they've sent, receiver sees what they've received.

## 5. Invoice-as-Token (Minting)

### 5.1 Minting Flow

```
1. Validate CreateInvoiceRequest
2. Serialize InvoiceTerms canonically -> deterministic bytes
3. Generate salt (SHA-256 of signingKey + invoiceBytes)
4. Create MintTransactionData with:
   - tokenId: derived from invoice content hash
   - tokenType: INVOICE_TOKEN_TYPE (new constant)
   - coinData: [] (non-fungible, no denomination)
   - tokenData: serialized InvoiceTerms
   - recipient: creator's DirectAddress
5. Create MintCommitment
6. Submit to aggregator -> wait for inclusion proof
7. Create Token with proof
8. Store invoice token via TokenStorageProvider (same as nametag/currency tokens)
9. Scan existing transaction history for payments referencing this invoice
10. Fire 'invoice:created' event + any retroactive payment/coverage events
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

| Direction | Code | Meaning | Affects balance | Auto-returnable | Who can send |
|-----------|------|---------|-----------------|-----------------|--------------|
| Forward | `:F` (or omitted) | Payment towards covering the invoice | +coveredAmount (increases net) | Yes (if invoice terminated) | Anyone |
| Back | `:B` | Manual return/refund | +returnedAmount (decreases net) | **No** (never auto-returned) | **Target only** |
| Return-for-closed | `:RC` | Auto-return because invoice is closed | +returnedAmount (decreases net) | **No** (never auto-returned) | **Target only** |
| Return-for-cancelled | `:RX` | Auto-return because invoice is cancelled | +returnedAmount (decreases net) | **No** (never auto-returned) | **Target only** |

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
- `direction` — `'forward'` (F or default), `'back'` (B), `'return_closed'` (RC), or `'return_cancelled'` (RX)
- `freeText` — remaining memo content

No changes to `TransferRequest`, `PaymentsModule`, or the transport layer are needed.

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
    identity: this.fullIdentity,
    storage: this.storage,
    emitEvent: (type, data) => this.emit(type, data),
  }
);

// Load persisted invoice tokens + frozen balances + scan history for pre-existing payments
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

Additional per-address storage keys:

| Storage Key | Scope | Content |
|------------|-------|---------|
| `sphere_{addressId}_cancelled_invoices` | Per-address | Set of cancelled invoice IDs (JSON array) |
| `sphere_{addressId}_closed_invoices` | Per-address | Set of explicitly closed invoice IDs (JSON array) |
| `sphere_{addressId}_frozen_balances` | Per-address | Frozen balance snapshots for terminated invoices (JSON map) |
| `sphere_{addressId}_auto_return` | Per-address | Auto-return settings: per-invoice flags and global flag (JSON) |
| `sphere_{addressId}_auto_return_ledger` | Per-address | Auto-return deduplication ledger: tracks which transfers have been returned (JSON) |

Added to `STORAGE_KEYS_ADDRESS` in `constants.ts`:

```typescript
CANCELLED_INVOICES: 'cancelled_invoices',
CLOSED_INVOICES: 'closed_invoices',
FROZEN_BALANCES: 'frozen_balances',
AUTO_RETURN: 'auto_return',
AUTO_RETURN_LEDGER: 'auto_return_ledger',
```

### 7.5 New Events

Added to `SphereEventType` and `SphereEventMap`:

| Event | Payload | When |
|-------|---------|------|
| `invoice:created` | `{ invoiceId, confirmed }` | Invoice token minted |
| `invoice:payment` | `{ invoiceId, transfer, direction, confirmed }` | Payment matched to invoice (forward or back/return) |
| `invoice:asset_covered` | `{ invoiceId, address, coinId, confirmed }` | One asset fully covered for one target |
| `invoice:target_covered` | `{ invoiceId, address, confirmed }` | All assets for one target covered |
| `invoice:covered` | `{ invoiceId, confirmed }` | All targets covered (may be unconfirmed) |
| `invoice:closed` | `{ invoiceId, explicit }` | Invoice closed — `explicit: true` if via `closeInvoice()`, `false` if implicit (all confirmed) |
| `invoice:cancelled` | `{ invoiceId }` | Creator cancelled the invoice |
| `invoice:expired` | `{ invoiceId }` | Due date passed (informational — invoice can still be closed) |
| `invoice:unknown_reference` | `{ invoiceId, transfer }` | Transfer memo references an invoice not in local inventory |
| `invoice:overpayment` | `{ invoiceId, address, coinId, surplus, confirmed }` | Payment exceeds requested amount |
| `invoice:irrelevant` | `{ invoiceId, transfer, reason, confirmed }` | Transfer references this invoice but doesn't match any target address or requested asset |
| `invoice:auto_returned` | `{ invoiceId, originalTransfer, returnTransfer }` | Tokens were auto-returned for a terminated invoice |
| `invoice:auto_return_failed` | `{ invoiceId, transferId, reason }` | Auto-return failed (sender unresolvable or send failed) |
| `invoice:return_received` | `{ invoiceId, transfer, returnReason }` | Received auto-return (`:RC` or `:RX`) — may trigger auto-termination |

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

### 8.2 New Intent Actions

| Action | User sees | Description |
|--------|-----------|-------------|
| `create_invoice` | Invoice creation modal | Create and mint a new invoice |
| `pay_invoice` | Payment modal (pre-filled) | Pay an invoice (sends tokens with memo reference) |
| `close_invoice` | Confirmation modal | Explicitly close an invoice |
| `cancel_invoice` | Confirmation modal | Cancel an invoice |

### 8.3 New Permission Scopes

| Scope | Grants |
|-------|--------|
| `invoices:read` | Read invoice list and status |
| `intent:create_invoice` | Create invoice intent |
| `intent:pay_invoice` | Pay invoice intent |
| `intent:close_invoice` | Close invoice intent |
| `intent:cancel_invoice` | Cancel invoice intent |

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
  - Forward payment to self (`INV:xxx:F`) — increases balance
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
| Cancel by non-creator | Reject — only the creator (or any holder for anonymous invoices) can cancel |
| Forward payment to terminated invoice | **Throw `INVOICE_TERMINATED`** — the transfer is blocked before it happens |
| Return payment from non-target party | **Throw `INVOICE_NOT_TARGET`** — only invoice target parties may send back/return payments |
| Auto-return on anonymous invoice | **Throw `INVOICE_ANON_AUTO_RETURN`** — auto-return is disabled for anonymous invoices to prevent abuse |
| Auto-return failure | Log error — the inbound transfer is already recorded, auto-return can be retried |
| Event processing failure | Log error, continue — transfer is already complete, accounting catches up on next recomputation |
| Status computation failure | Return error to caller — does not affect any transfer in progress |

## 11. Future Extensions

These are **not** in scope for v1 but inform the architecture:

- **NFT line items**: `NFTEntry` placeholder ready for when SDK adds NFT support
- **Recurring invoices**: Repeat an invoice template on a schedule
- **Invoice templates**: Reusable invoice definitions without minting
- **Multi-signature approval**: Require N-of-M signers before invoice is valid
- **L1 payment matching**: Match L1 (ALPHA) transfers to invoice targets via L1 history
- **Cross-chain invoices**: Targets on different chains/networks
- **Invoice negotiation**: Counter-offers modifying invoice terms via transport messages
