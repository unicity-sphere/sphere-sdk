# Accounting Module Architecture

> **Status:** Draft specification — no code yet
> **Module path:** `modules/accounting/AccountingModule.ts`
> **Barrel:** `modules/accounting/index.ts`

## 1. Overview

The Accounting Module extends Sphere SDK with invoice creation, tracking, and settlement capabilities. It follows the SDK's existing module pattern (like `PaymentsModule`, `MarketModule`) and integrates with the existing token and transfer infrastructure without modifying it.

### Design Principles

| Principle | Rationale |
|-----------|-----------|
| **Invoice-as-token** | Invoices are minted on-chain (same flow as nametags), giving each invoice a globally unique ID guaranteed by the aggregator |
| **Local-first accounting** | Each party computes invoice status from its own token inventory — no shared on-chain state, no consensus needed |
| **Memo-referenced payments** | Transfers reference invoices via structured prefix in the existing `memo` field — no transport protocol changes |
| **Read-only dependency on PaymentsModule** | AccountingModule reads from `PaymentsModule` (getHistory, getTokens, events) but never calls `send()` or modifies payment state directly |
| **Confirmation re-fire** | Events fire with `confirmed: false` on initial receipt, then re-fire with `confirmed: true` once all proofs are validated |

## 2. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                         Sphere                              │
│                                                             │
│  ┌──────────────┐   reads    ┌──────────────────────────┐   │
│  │  Payments     │◄──────────│    AccountingModule       │   │
│  │  Module       │           │                           │   │
│  │              │  events    │  - createInvoice()        │   │
│  │  getHistory() ├──────────►│  - getInvoiceStatus()     │   │
│  │  getTokens()  │           │  - getInvoices()          │   │
│  │  on(transfer) │           │  - cancelInvoice()        │   │
│  └──────┬───────┘           │  - getRelatedTransfers()  │   │
│         │                    └──────────┬───────────────┘   │
│         │                               │                   │
│  ┌──────▼───────┐           ┌──────────▼───────────────┐   │
│  │  Oracle       │           │  Storage (per-address)    │   │
│  │  (Aggregator) │◄──────────│  - Invoice tokens (TXF)   │   │
│  │              │  mint      │  - Invoice metadata        │   │
│  └──────────────┘           └──────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## 3. Invoice Data Model

### 3.1 Invoice Structure

An invoice is a compound object: an **on-chain token** (for ID uniqueness) plus **metadata** (the payment terms).

```
Invoice
├── id: string                          // = token ID (hex, from aggregator)
├── token: TxfToken                     // on-chain minted token (TXF format)
├── creator: string                     // chain pubkey of creator
├── createdAt: number                   // ms timestamp
├── dueDate?: number                    // optional deadline (ms timestamp)
├── memo?: string                       // free-text or URL
├── targets: InvoiceTarget[]            // what needs to be paid, to whom
│   ├── address: string                 // DIRECT:// address of recipient
│   └── assets: InvoiceAsset[]          // requested assets for this address
│       ├── coinId: string              // e.g. 'UCT', 'USDU'
│       ├── amount: string              // smallest units
│       └── nft?: InvoiceNFT            // placeholder for future NFT support
└── status: InvoiceStatus               // computed, not stored
```

### 3.2 Multi-Address, Multi-Asset

A single invoice can request payments to **multiple** destination addresses, each with **multiple** asset types. This supports exchange/swap scenarios:

```
Invoice #abc123:
  Target 1: DIRECT://alice...
    - 500 USDU
    - 1000 UCT
  Target 2: DIRECT://bob...
    - 200 ALPHA (L3-wrapped)
```

The invoice is **fully covered** only when every target address has received every requested asset in full.

### 3.3 NFT Placeholder

The `InvoiceNFT` type is a placeholder for future NFT support (not yet implemented in Sphere SDK):

```
InvoiceNFT
├── tokenId: string      // unique NFT token ID
├── tokenType?: string   // NFT type identifier
└── metadata?: object    // arbitrary NFT metadata
```

## 4. Invoice Lifecycle & State Machine

### 4.1 States

| State | Description |
|-------|-------------|
| `OPEN` | Invoice created, no payments matched yet |
| `PARTIAL` | At least one matching payment received, but not all targets fully covered |
| `COVERED` | All targets fully covered (unconfirmed — at least one token lacks full proof chain) |
| `CLOSED` | All targets fully covered AND all related tokens fully confirmed |
| `CANCELLED` | Creator explicitly cancelled the invoice |
| `EXPIRED` | `dueDate` passed without reaching CLOSED (if dueDate was set) |

### 4.2 State Transitions

```
                     ┌──────────┐
                     │   OPEN   │
                     └────┬─────┘
                          │ payment matched
                          ▼
                     ┌──────────┐
              ┌──────│ PARTIAL  │──────┐
              │      └────┬─────┘      │
              │           │ all        │ cancel()
              │           │ covered    │
              │           ▼            ▼
              │      ┌──────────┐ ┌──────────┐
              │      │ COVERED  │ │CANCELLED │
              │      └────┬─────┘ └──────────┘
              │           │ all confirmed
              │           ▼
              │      ┌──────────┐
              │      │  CLOSED  │
              │      └──────────┘
              │
              │ dueDate passed (any non-terminal state)
              ▼
         ┌──────────┐
         │ EXPIRED  │
         └──────────┘
```

### 4.3 Status Computation

Status is **computed on-demand** from local data, not stored. The `getInvoiceStatus()` method:

1. Loads the invoice metadata (targets, assets)
2. Scans transaction history (`PaymentsModule.getHistory()`) for memo-matched transfers
3. Aggregates received/sent amounts per target per asset
4. Determines which targets are covered, partially covered, or untouched
5. Checks confirmation status of all related tokens
6. Returns the computed `InvoiceStatus` object

This means each party independently derives invoice status from their own perspective — sender sees what they've sent, receiver sees what they've received.

## 5. Invoice-as-Token (Minting)

Invoices are minted on-chain using the same pattern as nametags (`NametagMinter`):

### 5.1 Minting Flow

```
1. Serialize invoice metadata → deterministic bytes
2. Generate salt (SHA-256 of signingKey + invoiceData)
3. Create MintTransactionData with:
   - tokenId: derived from invoice content hash
   - tokenType: INVOICE_TOKEN_TYPE (new constant)
   - coinData: [] (non-fungible, no denomination)
   - tokenData: serialized invoice metadata
   - recipient: creator's DirectAddress
4. Create MintCommitment
5. Submit to aggregator → wait for inclusion proof
6. Create Token with proof
7. Store invoice token + metadata locally
```

### 5.2 Why Mint?

| Benefit | Explanation |
|---------|-------------|
| **Unique ID** | Aggregator guarantees no duplicate token IDs — no UUID collisions |
| **Proof of creation** | On-chain timestamp proves when invoice was created |
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
INV:a1b2c3...ef00:B Refund — overpayment
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
// In Sphere.ts — module creation
this.accounting = createAccountingModule({
  payments: this.payments,
  storage: this.storage,
  tokenStorage: this.tokenStorage,
  oracle: this.oracle,
  identity: this.fullIdentity,
  emitEvent: (type, data) => this.emit(type, data),
});

// Load persisted invoices
await this.accounting.load();

// Cleanup
await this.accounting.destroy();
```

### 7.2 Event Subscription

AccountingModule subscribes to PaymentsModule events to detect invoice-related transfers:

```
PaymentsModule                    AccountingModule
     │                                  │
     │  transfer:incoming               │
     ├─────────────────────────────────►│ parse memo → match invoice
     │                                  │ → fire invoice:* events
     │  transfer:confirmed              │
     ├─────────────────────────────────►│ re-check confirmation
     │                                  │ → re-fire with confirmed:true
     │  history:updated                 │
     ├─────────────────────────────────►│ recompute affected invoices
```

### 7.3 Storage Layout

Invoice data is stored per-address, following existing conventions:

| Storage Key | Scope | Content |
|------------|-------|---------|
| `{addressId}_invoices` | Per-address | Invoice metadata map (JSON) |
| `{addressId}_invoice_index` | Per-address | Index: invoiceId → status cache |

Invoice **tokens** are stored via `TokenStorageProvider` (same as nametag tokens, currency tokens).

### 7.4 New Storage Keys

Added to `STORAGE_KEYS_ADDRESS` in `constants.ts`:

```typescript
INVOICES: 'invoices',
INVOICE_INDEX: 'invoice_index',
```

### 7.5 New Events

Added to `SphereEventType` and `SphereEventMap`:

| Event | Payload | When |
|-------|---------|------|
| `invoice:created` | `{ invoice, confirmed }` | Invoice token minted |
| `invoice:payment` | `{ invoiceId, transfer, direction, confirmed }` | Payment matched to invoice |
| `invoice:target_covered` | `{ invoiceId, address, confirmed }` | All assets for one target covered |
| `invoice:asset_covered` | `{ invoiceId, address, coinId, confirmed }` | One asset fully covered for one target |
| `invoice:covered` | `{ invoiceId, confirmed }` | All targets covered (may be unconfirmed) |
| `invoice:closed` | `{ invoiceId }` | All targets covered AND all tokens confirmed |
| `invoice:cancelled` | `{ invoiceId }` | Creator cancelled the invoice |
| `invoice:expired` | `{ invoiceId }` | Due date passed |
| `invoice:unknown_reference` | `{ invoiceId, transfer }` | Transfer references unknown invoice |
| `invoice:overpayment` | `{ invoiceId, address, coinId, surplus, confirmed }` | Payment exceeds requested amount |

### 7.6 Confirmation Re-Fire

All events with a `confirmed` field follow the two-phase pattern:

1. **Phase 1:** Event fires with `confirmed: false` when the transfer is first detected (token may have unconfirmed transactions)
2. **Phase 2:** Same event re-fires with `confirmed: true` when all related tokens in the transfer have full proof chains

This matches the SDK's existing pattern where `transfer:incoming` precedes `transfer:confirmed`.

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
  ← receive 500 USDU to target[0] → PARTIAL
  ← receive 1000 UCT to target[0] → target[0] COVERED
  ← receive 200 ALPHA to target[1] → COVERED (all targets met)
  ... all tokens confirmed → CLOSED
```

### 9.2 Payer/Sender View

The payer receives or imports the invoice token and tracks outgoing transfers:

```
Invoice OPEN (imported/received)
  → send 500 USDU with memo INV:xxx:F → PARTIAL (from sender's view)
  → send 1000 UCT with memo INV:xxx:F → still PARTIAL
  ...
```

The sender's status reflects what they have sent, which may differ from the recipient's view (network delays, multiple payers).

### 9.3 Third-Party / Exchange View

An exchange creating invoices for two-way swaps can track both sides:

```
Invoice for swap:
  Target 1: Exchange address ← buyer sends USDU
  Target 2: Buyer address   ← exchange sends tokens

Both parties independently verify their side is covered.
```

## 10. Error Handling

| Error | Handling |
|-------|---------|
| Mint failure | Return `{ success: false, error }` — same pattern as `NametagMinter` |
| Unknown invoice in memo | Fire `invoice:unknown_reference` event — do not block the transfer |
| Malformed memo | Ignore — treat as a regular transfer with no invoice association |
| Duplicate invoice | Aggregator rejects with `REQUEST_ID_EXISTS` — use deterministic salt for idempotent re-mint |
| Storage corruption | Graceful degradation — recompute status from history if index is lost |

## 11. Future Extensions

These are **not** in scope for v1 but inform the architecture:

- **NFT line items**: `InvoiceNFT` placeholder ready for when SDK adds NFT support
- **Recurring invoices**: Repeat an invoice template on a schedule
- **Invoice templates**: Reusable invoice definitions without minting
- **Multi-signature approval**: Require N-of-M signers before invoice is valid
- **L1 payment matching**: Match L1 (ALPHA) transfers to invoice targets via L1 history
- **Cross-chain invoices**: Targets on different chains/networks
- **Invoice negotiation**: Counter-offers modifying invoice terms via transport messages
