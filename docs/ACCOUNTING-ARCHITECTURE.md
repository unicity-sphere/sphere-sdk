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
| **Local-first accounting** | Each party computes invoice status from its own token inventory — no shared on-chain state, no consensus needed. Status is **never** stored; it is always derived on-demand. |
| **Memo-referenced balances** | Invoice balances are derived **exclusively** from transaction history entries whose memo references the invoice. Physical token inventory (whether tokens still exist or have been spent further) is irrelevant to invoice accounting. |
| **Read-only dependency on PaymentsModule** | AccountingModule reads from `PaymentsModule` (getHistory, getTokens, events) but never calls `send()` or modifies payment state directly |
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
|  |  on(transfer)  |            |  - cancelInvoice()          |    |
|  +-------+--------+            |  - getRelatedTransfers()    |    |
|          |                     +-------------+---------------+    |
|          |                                   |                    |
|  +-------v--------+            +-------------v---------------+    |
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
+-- targets: InvoiceTarget[]            // what needs to be paid, to whom
    +-- address: string                 // DIRECT:// address of recipient
    +-- assets: InvoiceRequestedAsset[] // requested assets for this address
        +-- coin?: CoinEntry            // fungible token request (same type as genesis coinData entry)
        +-- nft?: NFTEntry              // NFT request (placeholder)
```

**Anonymous invoices:** The `creator` field is optional. Anyone can create an invoice without identifying themselves. When `creator` is omitted, the invoice is anonymous — it cannot be cancelled (cancellation requires creator identity verification), but it can still be paid and closed normally.

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

### 3.4 Status Is Always Computed, Never Stored

Invoice status (OPEN, PARTIAL, COVERED, CLOSED, etc.) is a **dynamic property** derived from the transaction history of active and sent tokens. It is NEVER stored in the token, in storage, or anywhere else. Every call to `getInvoiceStatus()` recomputes the status from scratch.

This is a fundamental design principle — there is no state to get out of sync.

### 3.5 Balance Computation Model

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

4. **Return payments decrease balance.** A return payment (`INV:<id>:B`) decreases the covered balance for the matching target:asset. This handles overpayments, refunds, and corrections.

5. **Frozen at terminal states.** Once an invoice reaches CLOSED or CANCELLED, its balances are frozen — no further computation is performed. New transfers referencing a terminated invoice are still recorded but do not affect the terminal status.

### 3.6 History Scanning

To compute invoice balances, the module scans the **full transaction history** of all active and sent tokens. This includes:

- **Active tokens** — tokens currently in the wallet's inventory
- **Sent (archived) tokens** — tokens that have been transferred away

Both inbound and outbound transfers are considered. The scan examines the memo field of each history entry to find invoice references.

## 4. Invoice Lifecycle & State Machine

### 4.1 States

| State | Description |
|-------|-------------|
| `OPEN` | Invoice created, no payments matched yet |
| `PARTIAL` | At least one matching payment received, but not all targets fully covered |
| `COVERED` | All targets fully covered (unconfirmed — at least one related token lacks full proof chain) |
| `CLOSED` | All targets fully covered AND all related tokens fully confirmed. **Terminal.** |
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
              |           v
              |      +----------+
              +----->|  CLOSED  |<---+
                     +----------+    |
                                     |
                     +----------+    |
                     | EXPIRED  |----+
                     +----+-----+  all covered
                          ^        + confirmed
                          |
              dueDate passed
         (from OPEN, PARTIAL, or COVERED)
```

Key transitions:
- **EXPIRED is not terminal.** An expired invoice can still transition to CLOSED if all targets become fully covered and all related tokens are confirmed after the due date.
- **CANCELLED is terminal.** Once cancelled, the invoice remains cancelled regardless of subsequent payments. Balances are frozen.
- **CLOSED is terminal.** All targets covered + all tokens confirmed. Balances are frozen.
- **Frozen terminal states.** Once CLOSED or CANCELLED, no further balance computation occurs. Subsequent transfers referencing the invoice are recorded but do not change the status.

### 4.3 Status Computation

Status is **computed on-demand** from local data, never stored. The `getInvoiceStatus()` method:

1. Reads the invoice terms from the token's genesis `tokenData`
2. Checks if the invoice is in a terminal state (CLOSED or CANCELLED) — if so, returns the frozen status
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
INV:<invoiceId>[:F|:B] [optional free text]
```

| Component | Required | Description |
|-----------|----------|-------------|
| `INV:` | Yes | Prefix identifying an invoice-linked transfer |
| `<invoiceId>` | Yes | The invoice token ID (64-char hex) |
| `:F` | No | Forward payment — towards closing the invoice (default if omitted) |
| `:B` | No | Back/return payment — refund of surplus or irrelevant payment |
| free text | No | Optional human-readable note after a space |

### 6.2 Examples

```
INV:a1b2c3...ef00:F Payment for order #1234
INV:a1b2c3...ef00:B Refund - overpayment
INV:a1b2c3...ef00 Coffee beans (implied forward)
```

### 6.3 Parsing

The AccountingModule registers a memo parser that extracts:
- `invoiceId` — the referenced invoice
- `direction` — `'forward'` (F or default) or `'back'` (B)
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

// Load persisted invoice tokens + scan history for pre-existing payments
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

The only additional per-address storage key is for tracking cancelled invoices (since cancellation is a local-only action not encoded in the token):

| Storage Key | Scope | Content |
|------------|-------|---------|
| `{addressId}_cancelled_invoices` | Per-address | Set of cancelled invoice IDs (JSON array) |

Added to `STORAGE_KEYS_ADDRESS` in `constants.ts`:

```typescript
CANCELLED_INVOICES: 'cancelled_invoices',
```

### 7.5 New Events

Added to `SphereEventType` and `SphereEventMap`:

| Event | Payload | When |
|-------|---------|------|
| `invoice:created` | `{ invoiceId, confirmed }` | Invoice token minted |
| `invoice:payment` | `{ invoiceId, transfer, direction, confirmed }` | Payment matched to invoice (forward or back) |
| `invoice:asset_covered` | `{ invoiceId, address, coinId, confirmed }` | One asset fully covered for one target |
| `invoice:target_covered` | `{ invoiceId, address, confirmed }` | All assets for one target covered |
| `invoice:covered` | `{ invoiceId, confirmed }` | All targets covered (may be unconfirmed) |
| `invoice:closed` | `{ invoiceId }` | All targets covered AND all tokens confirmed |
| `invoice:cancelled` | `{ invoiceId }` | Creator cancelled the invoice |
| `invoice:expired` | `{ invoiceId }` | Due date passed (informational — invoice can still be closed) |
| `invoice:unknown_reference` | `{ invoiceId, transfer }` | Transfer memo references an invoice not in local inventory |
| `invoice:overpayment` | `{ invoiceId, address, coinId, surplus, confirmed }` | Payment exceeds requested amount |
| `invoice:irrelevant` | `{ invoiceId, transfer, reason, confirmed }` | Transfer references this invoice but doesn't match any target address or requested asset |

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

### 8.3 New Permission Scopes

| Scope | Grants |
|-------|--------|
| `invoices:read` | Read invoice list and status |
| `intent:create_invoice` | Create invoice intent |
| `intent:pay_invoice` | Pay invoice intent |

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
  ... all tokens confirmed -> CLOSED
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

## 10. Error Handling

| Error | Handling |
|-------|---------|
| Mint failure | Return `{ success: false, error }` — same pattern as `NametagMinter` |
| Unknown invoice in memo | Fire `invoice:unknown_reference` event — do not block the transfer |
| Irrelevant payment | Fire `invoice:irrelevant` event — transfer references invoice but doesn't match any target |
| Malformed memo | Ignore — treat as a regular transfer with no invoice association |
| Duplicate invoice | Aggregator rejects with `REQUEST_ID_EXISTS` — use deterministic salt for idempotent re-mint |
| Token data parsing failure | Log warning, skip — corrupted tokenData does not crash the module |
| Cancel of anonymous invoice | Reject — anonymous invoices (no `creator` field) cannot be cancelled |

## 11. Future Extensions

These are **not** in scope for v1 but inform the architecture:

- **NFT line items**: `NFTEntry` placeholder ready for when SDK adds NFT support
- **Recurring invoices**: Repeat an invoice template on a schedule
- **Invoice templates**: Reusable invoice definitions without minting
- **Multi-signature approval**: Require N-of-M signers before invoice is valid
- **L1 payment matching**: Match L1 (ALPHA) transfers to invoice targets via L1 history
- **Cross-chain invoices**: Targets on different chains/networks
- **Invoice negotiation**: Counter-offers modifying invoice terms via transport messages
