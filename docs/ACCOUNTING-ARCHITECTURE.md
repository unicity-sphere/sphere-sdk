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
|  +----------------+   reads    +----------------------------+    |
|  |  Payments      |<-----------|    AccountingModule         |    |
|  |  Module        |            |                             |    |
|  |                |  events    |  - createInvoice()          |    |
|  |  getHistory()  |----------->|  - getInvoiceStatus()       |    |
|  |  getTokens()   |            |  - getInvoices()            |    |
|  |  on(transfer)  |            |  - closeInvoice()           |    |
|  |                |  send()    |  - cancelInvoice()          |    |
|  |  send()       |<-----------|  - setAutoReturn()           |    |
|  +-------+--------+  (auto-   |  - payInvoice()             |    |
|          |          return)    |  - getRelatedTransfers()    |    |
|  +-------v--------+            +-------------+---------------+    |
|  |  Oracle         |            |  TokenStorage (per-address)  |    |
|  |  (Aggregator)   |<-----------|  - Invoice tokens (TXF)      |    |
|  |                 |  mint      |  (genesis.data.tokenData      |    |
|  |                 |            |   contains invoice terms)     |    |
|  +-----------------+            +------------------------------+    |
+-----------------------------------------------------------------+
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
+-- createdAt: number                   // ms timestamp
+-- dueDate?: number                    // optional deadline (ms timestamp)
+-- memo?: string                       // free-text or URL
+-- deliveryMethods?: string[]          // ordered list of delivery URLs (highest priority first) -- PLACEHOLDER
+-- targets: InvoiceTarget[]            // what needs to be paid, to whom
    +-- address: string                 // DIRECT:// address of recipient
    +-- assets: InvoiceRequestedAsset[] // requested assets for this address
        +-- coin?: CoinEntry            // fungible token request (same type as genesis coinData entry)
        +-- nft?: NFTEntry              // NFT request (placeholder)
```

**Anonymous invoices:** The `creator` field is optional. Anyone can create an invoice without identifying themselves. When `creator` is omitted, the invoice is anonymous — it cannot be cancelled (cancellation requires creator identity verification), but it can still be paid and closed normally.

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

For **terminal invoices** (CLOSED, CANCELLED), the balances are **frozen and persisted**. Once an invoice reaches a terminal state, the frozen balance snapshot is stored locally and returned on subsequent queries without recomputation. New transfers referencing a terminated invoice do not change the frozen balances or status — but they may trigger auto-return behavior (see Section 4.5).

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
coveredBalance = sum(forward payments referencing this invoice for this target:asset)
               - sum(back payments referencing this invoice for this target:asset)
```

Key rules:

1. **Only memo-referenced transfers count.** A transfer affects an invoice balance if and only if its memo contains `INV:<invoiceId>` referencing that invoice. The mere presence or absence of tokens in the wallet is irrelevant.

2. **Spending received tokens is independent.** A recipient can freely spend tokens received for a partially covered (or even uncovered) invoice without affecting that invoice's balances. The invoice accounting tracks memo-referenced transfers, not token ownership chains.

3. **Self-payments are valid.** A recipient may pay themselves with tokens referencing the given invoice, which increases the respective asset balance. This is a legitimate operation (e.g., consolidating tokens).

4. **Return payments decrease balance.** A return payment (`INV:<id>:B`) decreases the covered balance for the matching target:asset. This handles overpayments, refunds, and corrections. Auto-return payments (`INV:<id>:RC` or `INV:<id>:RX`) also decrease the balance, just like manual `:B` returns.

5. **Frozen at terminal states.** Once an invoice reaches CLOSED or CANCELLED, its balances are frozen and persisted. Dynamic recomputation no longer occurs. The frozen snapshot is returned for all subsequent queries.

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
         (from OPEN, PARTIAL, or COVERED)
```

Key transitions:
- **EXPIRED is not terminal.** An expired invoice can still transition to CLOSED if all targets become fully covered and all related tokens are confirmed after the due date.
- **CANCELLED is terminal (locally).** Once cancelled, the invoice remains cancelled on the local party's side regardless of subsequent payments. Balances are frozen and persisted. See Section 4.4 for cancellation semantics.
- **CLOSED is terminal (locally).** Two paths to CLOSED: (1) implicit — all targets covered + all tokens confirmed; (2) explicit — creator calls `closeInvoice()` at any time (satisfied with current payments). Balances are frozen and persisted.
- **Frozen terminal states.** Once CLOSED or CANCELLED, the frozen balance snapshot is persisted. Dynamic recomputation stops. New transfers referencing the invoice may trigger auto-return but do not change the status.

### 4.3 Close vs Cancel Semantics

**`closeInvoice()`** — Explicit close. The invoice creator (or target owner) signals they are **satisfied** with what has been paid so far. No more payments needed. The invoice may be partially covered — the creator accepts the current state as final.

**`cancelInvoice()`** — Cancellation. The invoice creator abandons the **deal or session** associated with this invoice. The invoice is no longer relevant. Payments already made may need to be returned.

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

Auto-return is a mechanism where incoming forward payments referencing a **terminated** invoice are automatically returned to the sender. This is managed by the accounting module, not application code.

**Enabling auto-return:**
- **Per-invoice:** `setAutoReturn(invoiceId, true)` — enable auto-return for a specific terminated invoice.
- **Global:** `setAutoReturn('*', true)` — enable auto-return for all terminated invoices.
- Auto-return can be enabled/disabled at any time, even after termination.
- Auto-return is **always allowed** for terminated invoices — calling `setAutoReturn()` on a non-terminated invoice has no effect until it terminates.

**Auto-return behavior:**
1. An incoming forward payment with memo `INV:<id>:F` arrives for a terminated invoice.
2. If auto-return is enabled for this invoice (or globally):
   - The incoming transfer is processed normally (recorded in history).
   - The module invokes `PaymentsModule.send()` to return the tokens to the original sender.
   - The return memo uses `INV:<id>:RC` (if invoice is CLOSED) or `INV:<id>:RX` (if CANCELLED).
3. The auto-return transfer is recorded in history like any other transfer.

**Auto-return exclusions — return payments are NEVER auto-returned:**
- Transfers with direction `:B`, `:RC`, or `:RX` are **never** auto-returned.
- This prevents infinite loops (return → auto-return → auto-return → ...).

**Manual return is always allowed:**
- An invoice target can always explicitly return tokens received for any invoice, including non-terminated ones, using `INV:<id>:B`.
- Manual return is independent of the auto-return setting.

**Recipient-side auto-termination:**
- When a party receives an auto-return transfer with `:RC`, their accounting module MAY auto-close the invoice locally.
- When a party receives an auto-return transfer with `:RX`, their accounting module MAY auto-cancel the invoice locally.
- This propagation is best-effort and configurable. It provides implicit cross-party termination signaling without requiring an explicit broadcast mechanism.

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

### 4.7 Status Computation

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

| Direction | Code | Meaning | Affects balance | Auto-returnable |
|-----------|------|---------|-----------------|-----------------|
| Forward | `:F` (or omitted) | Payment towards covering the invoice | +coveredAmount | Yes (if invoice terminated) |
| Back | `:B` | Manual return/refund | +returnedAmount (decreases net) | **No** (never auto-returned) |
| Return-for-closed | `:RC` | Auto-return because invoice is closed | +returnedAmount (decreases net) | **No** (never auto-returned) |
| Return-for-cancelled | `:RX` | Auto-return because invoice is cancelled | +returnedAmount (decreases net) | **No** (never auto-returned) |

All return directions (`:B`, `:RC`, `:RX`) have the same effect on balance computation — they increase `returnedAmount`, which decreases the net covered balance. The distinction between `:B`, `:RC`, and `:RX` is semantic: it communicates _why_ the tokens were returned.

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

## 7. Integration with Existing SDK

### 7.1 Module Lifecycle

Following the established pattern (`PaymentsModule`, `MarketModule`):

```typescript
// In Sphere.ts -- module creation
this.accounting = createAccountingModule({
  payments: this.payments,
  tokenStorage: this.tokenStorage,
  oracle: this.oracle,
  identity: this.fullIdentity,
  emitEvent: (type, data) => this.emit(type, data),
});

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
| `{addressId}_cancelled_invoices` | Per-address | Set of cancelled invoice IDs (JSON array) |
| `{addressId}_closed_invoices` | Per-address | Set of explicitly closed invoice IDs (JSON array) |
| `{addressId}_frozen_balances` | Per-address | Frozen balance snapshots for terminated invoices (JSON map) |
| `{addressId}_auto_return` | Per-address | Auto-return settings: per-invoice flags and global flag (JSON) |

Added to `STORAGE_KEYS_ADDRESS` in `constants.ts`:

```typescript
CANCELLED_INVOICES: 'cancelled_invoices',
CLOSED_INVOICES: 'closed_invoices',
FROZEN_BALANCES: 'frozen_balances',
AUTO_RETURN: 'auto_return',
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

### 9.4 Third-Party / Exchange View

An exchange creating invoices for two-way swaps can track both sides:

```
Invoice for swap:
  Target 1: Exchange address <- buyer sends USDU
  Target 2: Buyer address   <- exchange sends tokens

Both parties independently verify their side is covered.
```

### 9.5 Async P2P: Payment Before Invoice

```
Time 1: Payer sends 500 USDU with memo INV:abc:F
        -> Recipient receives transfer
        -> AccountingModule fires invoice:unknown_reference (invoice abc not yet known)

Time 2: Recipient imports invoice token abc
        -> AccountingModule scans full history
        -> Finds the earlier 500 USDU transfer with INV:abc:F
        -> Fires invoice:payment, and possibly invoice:asset_covered etc.
```

### 9.6 Termination and Auto-Return Flow

```
Recipient closes invoice abc (satisfied with partial payment):
  -> closeInvoice('abc')
  -> Balances frozen and persisted
  -> setAutoReturn('abc', true)  // optional: enable auto-return
  -> Fires invoice:closed { explicit: true }

Sender sends 500 UCT with memo INV:abc:F (unaware of closure):
  -> Token transfer succeeds (inbound transfers are never blocked)
  -> Recipient's AccountingModule sees the transfer
  -> Invoice is CLOSED locally -> frozen balances unchanged
  -> Auto-return enabled -> module auto-sends 500 UCT back
     with memo INV:abc:RC (return-for-closed)
  -> Fires invoice:auto_returned

Sender receives the auto-return:
  -> Sees INV:abc:RC in memo
  -> Fires invoice:return_received { returnReason: 'closed' }
  -> Sender's module MAY auto-close invoice abc locally
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
| Cancel of anonymous invoice | Reject — anonymous invoices (no `creator` field) cannot be cancelled |
| Forward payment to terminated invoice | **Throw `INVOICE_TERMINATED`** — the transfer is blocked before it happens |
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
