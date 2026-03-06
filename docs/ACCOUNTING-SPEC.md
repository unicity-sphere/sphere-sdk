# Accounting Module Specification

> **Status:** Draft specification — no code yet
> **Companion:** [ACCOUNTING-ARCHITECTURE.md](./ACCOUNTING-ARCHITECTURE.md)

## Table of Contents

1. [Types](#1-types)
2. [Module API](#2-module-api)
3. [Invoice Minting](#3-invoice-minting)
4. [Memo Format](#4-memo-format)
5. [Status Computation](#5-status-computation)
6. [Events](#6-events)
7. [Storage](#7-storage)
8. [Validation Rules](#8-validation-rules)
9. [Connect Protocol Extensions](#9-connect-protocol-extensions)
10. [Error Codes](#10-error-codes)

---

## 1. Types

### 1.1 Invoice Types

```typescript
// =============================================================================
// Invoice Core Types
// =============================================================================

/**
 * An asset requested in an invoice line item.
 * Represents a specific amount of a fungible token.
 */
interface InvoiceAsset {
  /** Token coin ID (e.g., 'UCT', 'USDU', 'ALPHA') */
  readonly coinId: string;
  /** Amount in smallest units (string to avoid precision loss) */
  readonly amount: string;
}

/**
 * Placeholder for future NFT support in invoice line items.
 * Not yet implemented in Sphere SDK — included for forward compatibility.
 */
interface InvoiceNFT {
  /** Unique NFT token ID (64-char hex) */
  readonly tokenId: string;
  /** NFT type identifier (64-char hex, optional) */
  readonly tokenType?: string;
  /** Arbitrary metadata (schema TBD when NFTs are implemented) */
  readonly metadata?: Record<string, unknown>;
}

/**
 * A payment target within an invoice.
 * Each target specifies a destination address and the assets it should receive.
 */
interface InvoiceTarget {
  /** Destination address (DIRECT://... format) */
  readonly address: string;
  /** Fungible assets requested for this address */
  readonly assets: InvoiceAsset[];
  /** NFTs requested for this address (placeholder, not yet supported) */
  readonly nfts?: InvoiceNFT[];
}

/**
 * Request to create a new invoice.
 * Passed to `accounting.createInvoice()`.
 */
interface CreateInvoiceRequest {
  /** Payment targets — at least one required */
  readonly targets: InvoiceTarget[];
  /** Optional due date (ms timestamp). Invoice expires after this time. */
  readonly dueDate?: number;
  /** Optional memo — free text or URL describing the reason for the invoice */
  readonly memo?: string;
}

/**
 * Full invoice data stored locally.
 * The `id` is the on-chain token ID (globally unique via aggregator).
 */
interface Invoice {
  /** Invoice ID = minted token ID (64-char hex) */
  readonly id: string;
  /** Chain pubkey of the creator */
  readonly creator: string;
  /** Payment targets */
  readonly targets: InvoiceTarget[];
  /** Optional due date (ms timestamp) */
  readonly dueDate?: number;
  /** Optional memo */
  readonly memo?: string;
  /** Creation timestamp (ms) */
  readonly createdAt: number;
  /** Whether this wallet is the creator */
  readonly isCreator: boolean;
  /** Explicitly cancelled by creator */
  cancelled: boolean;
  /** Timestamp of cancellation (ms), if cancelled */
  cancelledAt?: number;
}
```

### 1.2 Invoice Status Types

```typescript
/**
 * Computed invoice state (not stored — derived from local data).
 */
type InvoiceState = 'OPEN' | 'PARTIAL' | 'COVERED' | 'CLOSED' | 'CANCELLED' | 'EXPIRED';

/**
 * Detailed status of a single asset within a target.
 */
interface InvoiceAssetStatus {
  /** The requested asset */
  readonly coinId: string;
  /** Requested amount (smallest units) */
  readonly requestedAmount: string;
  /** Total forward payments received/sent for this asset (smallest units) */
  readonly coveredAmount: string;
  /** Total back/return payments for this asset (smallest units) */
  readonly returnedAmount: string;
  /** Net covered = coveredAmount - returnedAmount */
  readonly netCoveredAmount: string;
  /** Whether requestedAmount is fully met (netCovered >= requested) */
  readonly isCovered: boolean;
  /** Surplus amount if overpaid (netCovered - requested), '0' if not overpaid */
  readonly surplusAmount: string;
  /** Whether all related tokens are confirmed (full proof chain) */
  readonly confirmed: boolean;
  /** Individual transfers contributing to this asset */
  readonly transfers: InvoiceTransferRef[];
}

/**
 * Status of a single NFT line item (placeholder).
 */
interface InvoiceNFTStatus {
  /** The requested NFT token ID */
  readonly tokenId: string;
  /** Whether the NFT has been received */
  readonly received: boolean;
  /** Whether the received token is confirmed */
  readonly confirmed: boolean;
}

/**
 * Detailed status of a single target within an invoice.
 */
interface InvoiceTargetStatus {
  /** Target destination address */
  readonly address: string;
  /** Per-asset status */
  readonly assets: InvoiceAssetStatus[];
  /** Per-NFT status (placeholder) */
  readonly nfts?: InvoiceNFTStatus[];
  /** Whether all assets (and NFTs) for this target are covered */
  readonly isCovered: boolean;
  /** Whether all related tokens are confirmed */
  readonly confirmed: boolean;
}

/**
 * Reference to a transfer that contributes to an invoice.
 */
interface InvoiceTransferRef {
  /** Transfer/history entry ID */
  readonly transferId: string;
  /** Transfer direction from this wallet's perspective */
  readonly direction: 'inbound' | 'outbound';
  /** Invoice payment direction */
  readonly paymentDirection: 'forward' | 'back';
  /** Coin ID of the transferred token */
  readonly coinId: string;
  /** Amount transferred (smallest units) */
  readonly amount: string;
  /** Timestamp of the transfer */
  readonly timestamp: number;
  /** Whether the transfer's tokens are fully confirmed */
  readonly confirmed: boolean;
  /** Sender chain pubkey */
  readonly senderPubkey?: string;
  /** Sender nametag */
  readonly senderNametag?: string;
  /** Recipient chain pubkey */
  readonly recipientPubkey?: string;
  /** Recipient nametag */
  readonly recipientNametag?: string;
}

/**
 * Transfers related to an invoice that don't match any target.
 */
interface UnrelatedTransfer extends InvoiceTransferRef {
  /** Why this transfer is unrelated */
  readonly reason: 'unknown_address' | 'unknown_asset' | 'unknown_address_and_asset';
}

/**
 * Complete computed status of an invoice.
 * Returned by `accounting.getInvoiceStatus()`.
 */
interface InvoiceStatus {
  /** Invoice ID */
  readonly invoiceId: string;
  /** Current computed state */
  readonly state: InvoiceState;
  /** Per-target breakdown */
  readonly targets: InvoiceTargetStatus[];
  /** Transfers referencing this invoice but not matching any target/asset */
  readonly unrelatedTransfers: UnrelatedTransfer[];
  /** Total forward payments across all targets (sum of coveredAmounts by coinId) */
  readonly totalForward: Record<string, string>;
  /** Total back/return payments across all targets */
  readonly totalBack: Record<string, string>;
  /** Whether ALL related tokens are confirmed */
  readonly allConfirmed: boolean;
  /** Timestamp of last status change */
  readonly lastUpdatedAt: number;
}
```

### 1.3 Result Types

```typescript
/**
 * Result of invoice creation.
 */
interface CreateInvoiceResult {
  /** Whether the invoice was successfully minted */
  readonly success: boolean;
  /** Invoice data (if successful) */
  readonly invoice?: Invoice;
  /** Invoice token in TXF format (if successful) */
  readonly token?: TxfToken;
  /** Error message (if failed) */
  readonly error?: string;
}

/**
 * Options for listing invoices.
 */
interface GetInvoicesOptions {
  /** Filter by state */
  readonly state?: InvoiceState | InvoiceState[];
  /** Filter: only invoices created by this wallet */
  readonly createdByMe?: boolean;
  /** Filter: only invoices where this wallet is a target */
  readonly targetingMe?: boolean;
  /** Limit number of results */
  readonly limit?: number;
  /** Offset for pagination */
  readonly offset?: number;
  /** Sort order */
  readonly sortBy?: 'createdAt' | 'dueDate' | 'lastUpdated';
  readonly sortOrder?: 'asc' | 'desc';
}
```

### 1.4 Configuration Types

```typescript
/**
 * Configuration for AccountingModule.
 */
interface AccountingModuleConfig {
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Dependencies injected into AccountingModule.
 * Follows the same pattern as MarketModuleDependencies.
 */
interface AccountingModuleDependencies {
  /** PaymentsModule instance (read-only access) */
  payments: PaymentsModule;
  /** Storage provider for invoice metadata */
  storage: StorageProvider;
  /** Token storage for invoice tokens */
  tokenStorage: TokenStorageProvider;
  /** Oracle for minting invoice tokens */
  oracle: OracleProvider;
  /** Current wallet identity */
  identity: FullIdentity;
  /** Event emitter (from Sphere) */
  emitEvent: <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => void;
}
```

---

## 2. Module API

### 2.1 AccountingModule Class

```typescript
class AccountingModule {
  constructor(config: AccountingModuleConfig, deps: AccountingModuleDependencies);

  /**
   * Load persisted invoices from storage.
   * Called by Sphere after module construction.
   * Subscribes to PaymentsModule events for automatic tracking.
   */
  async load(): Promise<void>;

  /**
   * Create and mint a new invoice on-chain.
   *
   * Flow:
   * 1. Validate request (at least one target, valid amounts)
   * 2. Serialize invoice metadata deterministically
   * 3. Mint invoice token via aggregator (same flow as NametagMinter)
   * 4. Store invoice metadata + token locally
   * 5. Fire 'invoice:created' event
   *
   * @returns CreateInvoiceResult with invoice data and token
   */
  async createInvoice(request: CreateInvoiceRequest): Promise<CreateInvoiceResult>;

  /**
   * Import an invoice received from another party.
   * The invoice token is validated against the aggregator.
   *
   * @param token - Invoice token in TXF format (received via transfer or out-of-band)
   * @returns The parsed Invoice, or throws if token is invalid
   */
  async importInvoice(token: TxfToken): Promise<Invoice>;

  /**
   * Compute the current status of an invoice from local data.
   *
   * Scans PaymentsModule.getHistory() for transfers with matching
   * INV:<id> memo prefix and aggregates amounts per target per asset.
   *
   * @param invoiceId - The invoice token ID
   * @returns Computed InvoiceStatus
   * @throws SphereError if invoice not found locally
   */
  async getInvoiceStatus(invoiceId: string): Promise<InvoiceStatus>;

  /**
   * List invoices with optional filtering and pagination.
   *
   * Status is computed on-demand for each invoice in the result.
   *
   * @param options - Filter/sort/pagination options
   * @returns Array of Invoice objects (without computed status — call getInvoiceStatus per invoice)
   */
  getInvoices(options?: GetInvoicesOptions): Invoice[];

  /**
   * Get a single invoice by ID.
   *
   * @param invoiceId - The invoice token ID
   * @returns Invoice or null if not found
   */
  getInvoice(invoiceId: string): Invoice | null;

  /**
   * Cancel an invoice. Only the creator can cancel.
   * Sets `cancelled = true` and fires 'invoice:cancelled' event.
   *
   * Cancellation is local-only — there is no on-chain cancel.
   * The payer may still send tokens referencing this invoice.
   *
   * @param invoiceId - The invoice token ID
   * @throws SphereError if not creator or invoice not found
   */
  async cancelInvoice(invoiceId: string): Promise<void>;

  /**
   * Get all transfers related to a specific invoice.
   * Includes forward payments, back payments, and unrelated transfers.
   *
   * @param invoiceId - The invoice token ID
   * @returns InvoiceTransferRef[] sorted by timestamp
   */
  getRelatedTransfers(invoiceId: string): InvoiceTransferRef[];

  /**
   * Check if a transfer memo references an invoice.
   * Utility for external consumers parsing memos.
   *
   * @param memo - Transfer memo string
   * @returns Parsed reference or null if not an invoice memo
   */
  parseInvoiceMemo(memo: string): InvoiceMemoRef | null;

  /**
   * Cleanup: unsubscribe from events, release resources.
   * Called by Sphere.destroy().
   */
  async destroy(): Promise<void>;
}
```

### 2.2 Memo Parsing Type

```typescript
/**
 * Parsed invoice reference from a transfer memo.
 */
interface InvoiceMemoRef {
  /** Invoice token ID (64-char hex) */
  readonly invoiceId: string;
  /** Payment direction */
  readonly direction: 'forward' | 'back';
  /** Optional free text after the structured prefix */
  readonly freeText?: string;
}
```

### 2.3 Factory Function

```typescript
/**
 * Create an AccountingModule instance.
 * Follows SDK factory pattern (see createPaymentsModule, createMarketModule).
 */
function createAccountingModule(
  config: AccountingModuleConfig,
  deps: AccountingModuleDependencies
): AccountingModule;
```

### 2.4 Barrel Exports (`modules/accounting/index.ts`)

```typescript
export { AccountingModule, createAccountingModule } from './AccountingModule';
export * from './types';
```

---

## 3. Invoice Minting

### 3.1 Token ID Derivation

The invoice token ID is derived deterministically from the invoice content, ensuring that the same invoice parameters always produce the same token ID (enabling idempotent re-minting).

```typescript
// Deterministic token ID from invoice content
const invoiceBytes = canonicalSerialize({
  targets: request.targets,
  creator: identity.chainPubkey,
  memo: request.memo,
  dueDate: request.dueDate,
});
const tokenId = TokenId.fromData(invoiceBytes);
```

### 3.2 Minting Flow (Mirrors NametagMinter)

```
Step  Action                                SDK Class
────  ──────────────────────────────────    ─────────────────────
1     Validate CreateInvoiceRequest         AccountingModule
2     Canonical serialize invoice data      AccountingModule
3     Generate deterministic salt           SHA-256(signingKey ‖ invoiceBytes)
4     Create MintTransactionData            MintTransactionData.create()
      - tokenType: INVOICE_TOKEN_TYPE
      - tokenData: serialized invoice
      - coinData: [] (non-fungible)
      - recipient: creator's DirectAddress
5     Create MintCommitment                 MintCommitment.create()
6     Submit to aggregator (3 retries)      client.submitMintCommitment()
      - SUCCESS → continue
      - REQUEST_ID_EXISTS → continue (idempotent)
7     Wait for inclusion proof              waitInclusionProof()
8     Create genesis transaction            commitment.toTransaction()
9     Create UnmaskedPredicate + TokenState UnmaskedPredicate.create()
10    Create Token (with or without         Token.mint() or Token.fromJSON()
      verification based on config)
11    Store token via TokenStorageProvider   tokenStorage.saveToken()
12    Store invoice metadata via Storage     storage.set(key, metadata)
13    Fire 'invoice:created' event           emitEvent()
```

### 3.3 Invoice Token Type Constant

```typescript
// In constants.ts
/**
 * Token type for invoice tokens (SHA-256 of "unicity.invoice.v1").
 * Distinguishes invoice tokens from currency tokens, nametags, etc.
 */
const INVOICE_TOKEN_TYPE_HEX =
  sha256(new TextEncoder().encode('unicity.invoice.v1')).toString('hex');
```

### 3.4 Canonical Serialization

Invoice metadata must be serialized deterministically (same input → same bytes) for consistent token ID derivation:

```typescript
function canonicalSerialize(invoice: {
  targets: InvoiceTarget[];
  creator: string;
  memo?: string;
  dueDate?: number;
}): Uint8Array {
  // Sort targets by address (lexicographic)
  // Within each target, sort assets by coinId
  // Use JSON.stringify with sorted keys
  // Encode as UTF-8
  const sorted = {
    creator: invoice.creator,
    dueDate: invoice.dueDate ?? null,
    memo: invoice.memo ?? null,
    targets: [...invoice.targets]
      .sort((a, b) => a.address.localeCompare(b.address))
      .map(t => ({
        address: t.address,
        assets: [...t.assets].sort((a, b) => a.coinId.localeCompare(b.coinId)),
        nfts: t.nfts ? [...t.nfts].sort((a, b) => a.tokenId.localeCompare(b.tokenId)) : undefined,
      })),
  };
  return new TextEncoder().encode(JSON.stringify(sorted));
}
```

---

## 4. Memo Format

### 4.1 Grammar

```
invoice-memo  = "INV:" invoice-id [ ":" direction ] [ " " free-text ]
invoice-id    = 64HEXDIG
direction     = "F" / "B"
free-text     = *CHAR
```

### 4.2 Regex

```typescript
const INVOICE_MEMO_REGEX = /^INV:([0-9a-fA-F]{64})(?::(F|B))?(?: (.+))?$/;
```

### 4.3 Parsing Implementation

```typescript
function parseInvoiceMemo(memo: string): InvoiceMemoRef | null {
  const match = memo.match(INVOICE_MEMO_REGEX);
  if (!match) return null;
  return {
    invoiceId: match[1].toLowerCase(),
    direction: match[2] === 'B' ? 'back' : 'forward',
    freeText: match[3] || undefined,
  };
}
```

### 4.4 Constructing Invoice Memos

```typescript
function buildInvoiceMemo(
  invoiceId: string,
  direction: 'forward' | 'back' = 'forward',
  freeText?: string
): string {
  const dir = direction === 'back' ? ':B' : ':F';
  const text = freeText ? ` ${freeText}` : '';
  return `INV:${invoiceId}${dir}${text}`;
}
```

### 4.5 Integration with PaymentsModule.send()

No changes to `PaymentsModule.send()` are required. The caller constructs the memo using `buildInvoiceMemo()` and passes it via the existing `TransferRequest.memo` field:

```typescript
await sphere.payments.send({
  recipient: invoiceTarget.address,
  amount: invoiceAsset.amount,
  coinId: invoiceAsset.coinId,
  memo: buildInvoiceMemo(invoice.id, 'forward', 'Order #1234'),
});
```

---

## 5. Status Computation

### 5.1 Algorithm

```
function computeInvoiceStatus(invoice, history):
  1. Filter history for entries where parseInvoiceMemo(entry.memo)?.invoiceId === invoice.id
  2. For each matching transfer:
     a. Determine target match: find target where target.address matches
        the transfer's destination (inbound) or source (outbound)
     b. Determine asset match: find asset where asset.coinId matches transfer's coinId
     c. If both match → accumulate into target/asset status
     d. If address matches but coinId doesn't → unrelated (unknown_asset)
     e. If coinId matches but address doesn't → unrelated (unknown_address)
     f. If neither matches → unrelated (unknown_address_and_asset)
  3. Compute per-asset coverage:
     netCovered = sum(forward amounts) - sum(back amounts)
     isCovered = netCovered >= requestedAmount
     surplus = max(0, netCovered - requestedAmount)
  4. Compute per-target coverage:
     isCovered = all assets isCovered (AND all NFTs received, when supported)
  5. Determine state:
     - if invoice.cancelled → CANCELLED
     - if invoice.dueDate && now > invoice.dueDate && state != CLOSED → EXPIRED
     - if all targets isCovered AND allConfirmed → CLOSED
     - if all targets isCovered → COVERED
     - if any asset has netCovered > 0 → PARTIAL
     - else → OPEN
  6. Determine allConfirmed:
     Every InvoiceTransferRef.confirmed === true
```

### 5.2 Confirmation Tracking

A transfer is `confirmed` if:
- The token involved has a full proof chain (all `TxfTransaction.inclusionProof` are non-null)
- For outbound transfers: the commitment was included in a unicity certificate
- For inbound transfers: the received token's state transitions are all proven

This is determined by checking `TokenStatus === 'confirmed'` for the related tokens in `PaymentsModule.getTokens()`.

### 5.3 Perspective Handling

The same invoice viewed by different parties:

| Party | Sees inbound transfers as | Sees outbound transfers as |
|-------|--------------------------|---------------------------|
| Recipient (target address owner) | Forward payments covering invoice | Back/return payments (refunds they send) |
| Sender (payer) | Back/return payments they receive | Forward payments they sent |
| Creator (may be either) | Based on their address matching targets | Based on their outbound history |

The status computation uses the wallet's own transaction history, so each party naturally gets their perspective.

---

## 6. Events

### 6.1 Event Definitions

All new events are added to `SphereEventType` union and `SphereEventMap` interface in `types/index.ts`.

```typescript
// New SphereEventType additions:
| 'invoice:created'
| 'invoice:payment'
| 'invoice:asset_covered'
| 'invoice:target_covered'
| 'invoice:covered'
| 'invoice:closed'
| 'invoice:cancelled'
| 'invoice:expired'
| 'invoice:unknown_reference'
| 'invoice:overpayment'

// New SphereEventMap entries:
'invoice:created': {
  invoice: Invoice;
  confirmed: boolean;  // true once mint proof is confirmed
};

'invoice:payment': {
  invoiceId: string;
  transfer: InvoiceTransferRef;
  direction: 'forward' | 'back';
  confirmed: boolean;
};

'invoice:asset_covered': {
  invoiceId: string;
  address: string;     // target address
  coinId: string;
  confirmed: boolean;
};

'invoice:target_covered': {
  invoiceId: string;
  address: string;     // target address
  confirmed: boolean;
};

'invoice:covered': {
  invoiceId: string;
  confirmed: boolean;  // false if any related token is unconfirmed
};

'invoice:closed': {
  invoiceId: string;
  // No 'confirmed' field — CLOSED implies all confirmed
};

'invoice:cancelled': {
  invoiceId: string;
};

'invoice:expired': {
  invoiceId: string;
};

'invoice:unknown_reference': {
  invoiceId: string;          // referenced in memo but not in local storage
  transfer: InvoiceTransferRef;
};

'invoice:overpayment': {
  invoiceId: string;
  address: string;
  coinId: string;
  surplus: string;     // amount exceeding request (smallest units)
  confirmed: boolean;
};
```

### 6.2 Event Firing Logic

```
On PaymentsModule 'transfer:incoming' or 'history:updated':
  1. Parse memo → get invoiceId, direction
  2. If invoiceId not in local storage:
     → fire 'invoice:unknown_reference' { invoiceId, transfer, confirmed: false }
     → return
  3. Build InvoiceTransferRef from transfer data
  4. fire 'invoice:payment' { invoiceId, transfer, direction, confirmed: false }
  5. Recompute status:
     a. If asset just became covered → fire 'invoice:asset_covered' { ..., confirmed: false }
     b. If target just became covered → fire 'invoice:target_covered' { ..., confirmed: false }
     c. If all targets covered:
        - If all confirmed → fire 'invoice:closed'
        - Else → fire 'invoice:covered' { ..., confirmed: false }
     d. If surplus detected → fire 'invoice:overpayment' { ..., confirmed: false }

On PaymentsModule 'transfer:confirmed':
  1. Check if transfer has invoice memo reference
  2. If yes, recompute status with confirmed tokens:
     a. Re-fire 'invoice:payment' with confirmed: true
     b. Re-fire 'invoice:asset_covered' with confirmed: true (if still covered)
     c. Re-fire 'invoice:target_covered' with confirmed: true (if still covered)
     d. If all targets covered AND all confirmed:
        → fire 'invoice:closed'
     e. If overpayment → re-fire 'invoice:overpayment' with confirmed: true
```

### 6.3 Due Date Expiration

Expiration is checked lazily:
- On `getInvoiceStatus()` call — if dueDate passed and state is not CLOSED/CANCELLED
- On any event recomputation — if dueDate passed during processing

When detected, fire `'invoice:expired'` once (guard against duplicate fires via stored flag).

---

## 7. Storage

### 7.1 Storage Keys

Added to `STORAGE_KEYS_ADDRESS` in `constants.ts`:

```typescript
/** Invoice metadata map (JSON: Record<string, InvoiceStorageEntry>) */
INVOICES: 'invoices',
/** Invoice status index for quick lookups (JSON: Record<string, InvoiceIndexEntry>) */
INVOICE_INDEX: 'invoice_index',
```

Full key format: `sphere_{addressId}_invoices`, `sphere_{addressId}_invoice_index`

### 7.2 Storage Schemas

```typescript
/**
 * Persisted invoice metadata (stored in INVOICES key).
 * Keyed by invoice ID.
 */
interface InvoiceStorageEntry {
  /** Invoice ID (= token ID) */
  id: string;
  /** Creator's chain pubkey */
  creator: string;
  /** Serialized targets (InvoiceTarget[]) */
  targets: InvoiceTarget[];
  /** Due date (ms timestamp) */
  dueDate?: number;
  /** Memo */
  memo?: string;
  /** Creation timestamp */
  createdAt: number;
  /** Whether this wallet created it */
  isCreator: boolean;
  /** Cancellation flag */
  cancelled: boolean;
  /** Cancellation timestamp */
  cancelledAt?: number;
  /** Whether expiration event was already fired */
  expiredEventFired?: boolean;
}

/**
 * Lightweight index entry for quick status lookups.
 * Cached to avoid full recomputation on every getInvoices() call.
 * Invalidated when related transfers change.
 */
interface InvoiceIndexEntry {
  /** Last computed state */
  lastState: InvoiceState;
  /** Timestamp of last computation */
  computedAt: number;
  /** Whether all tokens were confirmed at last check */
  allConfirmed: boolean;
}
```

### 7.3 Invoice Tokens

Invoice tokens (TXF format) are stored via `TokenStorageProvider`, identical to how nametag tokens are stored:

- Active: `{tokenId}.json` in the per-address token directory
- The token's `tokenData` field contains the serialized invoice metadata
- Token type: `INVOICE_TOKEN_TYPE_HEX` (distinguishes from currency/nametag tokens)

### 7.4 Storage Operations

```
createInvoice():
  1. tokenStorage.saveToken(invoiceToken)    // TXF token
  2. storage.set(INVOICES_KEY, { ...existing, [id]: entry })  // metadata
  3. storage.set(INDEX_KEY, { ...existing, [id]: indexEntry }) // index

importInvoice():
  1. tokenStorage.saveToken(invoiceToken)    // TXF token
  2. storage.set(INVOICES_KEY, { ...existing, [id]: entry })  // metadata

cancelInvoice():
  1. entry.cancelled = true; entry.cancelledAt = Date.now()
  2. storage.set(INVOICES_KEY, updated)
  3. storage.set(INDEX_KEY, { ...existing, [id]: { lastState: 'CANCELLED', ... } })

getInvoiceStatus():
  1. Read invoice from storage
  2. Read history from PaymentsModule
  3. Compute status (no writes unless index update is needed)
```

---

## 8. Validation Rules

### 8.1 CreateInvoiceRequest Validation

| Rule | Error |
|------|-------|
| `targets` must be non-empty | `INVOICE_NO_TARGETS` |
| Each target must have a valid DIRECT:// address | `INVOICE_INVALID_ADDRESS` |
| Each target must have at least one asset or NFT | `INVOICE_NO_ASSETS` |
| Each asset `amount` must be a positive integer string | `INVOICE_INVALID_AMOUNT` |
| Each asset `coinId` must be non-empty | `INVOICE_INVALID_COIN` |
| `dueDate` (if provided) must be in the future | `INVOICE_PAST_DUE_DATE` |
| No duplicate addresses across targets | `INVOICE_DUPLICATE_ADDRESS` |
| No duplicate coinIds within a single target | `INVOICE_DUPLICATE_ASSET` |

### 8.2 Import Validation

| Rule | Error |
|------|-------|
| Token must have valid inclusion proof | `INVOICE_INVALID_PROOF` |
| Token type must be `INVOICE_TOKEN_TYPE_HEX` | `INVOICE_WRONG_TOKEN_TYPE` |
| Token data must parse as valid invoice metadata | `INVOICE_INVALID_DATA` |
| Invoice must not already exist locally | `INVOICE_ALREADY_EXISTS` |

### 8.3 Cancel Validation

| Rule | Error |
|------|-------|
| Invoice must exist locally | `INVOICE_NOT_FOUND` |
| Caller must be the creator (`isCreator === true`) | `INVOICE_NOT_CREATOR` |
| Invoice must not already be CLOSED | `INVOICE_ALREADY_CLOSED` |
| Invoice must not already be CANCELLED | `INVOICE_ALREADY_CANCELLED` |

---

## 9. Connect Protocol Extensions

### 9.1 New Query Methods

```typescript
// sphere_getInvoices
// Returns: Invoice[] (without computed status)
// Params: GetInvoicesOptions (optional)
{
  method: 'sphere_getInvoices',
  params: { state: 'OPEN', createdByMe: true, limit: 10 }
}

// sphere_getInvoiceStatus
// Returns: InvoiceStatus
// Params: { invoiceId: string }
{
  method: 'sphere_getInvoiceStatus',
  params: { invoiceId: 'abc123...' }
}
```

### 9.2 New Intent Actions

```typescript
// create_invoice — prompts user to confirm invoice creation
{
  action: 'create_invoice',
  params: {
    targets: [
      { address: 'DIRECT://...', assets: [{ coinId: 'UCT', amount: '1000000' }] }
    ],
    memo: 'Payment for services',
    dueDate: 1709251200000,
  }
}
// Returns: { invoiceId: string } on success

// pay_invoice — prompts user to confirm payment against an invoice
{
  action: 'pay_invoice',
  params: {
    invoiceId: 'abc123...',
    // Optional overrides (defaults to invoice targets):
    targetIndex: 0,       // which target to pay
    assetIndex: 0,        // which asset within that target
    amount: '500000',     // partial payment (defaults to remaining)
    direction: 'forward', // 'forward' or 'back'
  }
}
// Returns: TransferResult (from PaymentsModule.send())
```

### 9.3 New Permission Scopes

```typescript
// Added to PermissionScope type
'invoices:read'          // Read invoices and status
'intent:create_invoice'  // Create invoice intent
'intent:pay_invoice'     // Pay invoice intent
```

### 9.4 New Events (Connect push)

```typescript
// dApps can subscribe via client.on(...)
'invoice:payment'        // When a payment matches an invoice
'invoice:covered'        // When an invoice is fully covered
'invoice:closed'         // When an invoice transitions to CLOSED
```

---

## 10. Error Codes

All errors use `SphereError` with the following codes:

| Code | Message | When |
|------|---------|------|
| `INVOICE_NO_TARGETS` | Invoice must have at least one target | Empty targets array |
| `INVOICE_INVALID_ADDRESS` | Invalid target address: must be DIRECT:// format | Bad address format |
| `INVOICE_NO_ASSETS` | Target must have at least one asset or NFT | Empty assets in target |
| `INVOICE_INVALID_AMOUNT` | Asset amount must be a positive integer string | Non-positive or non-integer amount |
| `INVOICE_INVALID_COIN` | Asset coinId must be non-empty | Empty coinId |
| `INVOICE_PAST_DUE_DATE` | Due date must be in the future | dueDate <= now |
| `INVOICE_DUPLICATE_ADDRESS` | Duplicate target address in invoice | Same address appears twice |
| `INVOICE_DUPLICATE_ASSET` | Duplicate asset coinId in target | Same coinId in one target |
| `INVOICE_MINT_FAILED` | Failed to mint invoice token: {details} | Aggregator submission failure |
| `INVOICE_INVALID_PROOF` | Invoice token has invalid inclusion proof | Import validation failure |
| `INVOICE_WRONG_TOKEN_TYPE` | Token is not an invoice token | Wrong token type on import |
| `INVOICE_INVALID_DATA` | Cannot parse invoice metadata from token | Corrupt tokenData |
| `INVOICE_ALREADY_EXISTS` | Invoice already exists locally | Duplicate import |
| `INVOICE_NOT_FOUND` | Invoice not found | Unknown invoiceId |
| `INVOICE_NOT_CREATOR` | Only the creator can cancel an invoice | Cancel by non-creator |
| `INVOICE_ALREADY_CLOSED` | Cannot cancel a closed invoice | Cancel after CLOSED |
| `INVOICE_ALREADY_CANCELLED` | Invoice is already cancelled | Double cancel |
| `INVOICE_ORACLE_REQUIRED` | Oracle provider required for invoice minting | No oracle configured |

---

## Appendix A: File Structure

```
modules/accounting/
├── AccountingModule.ts    # Main module class
├── InvoiceMinter.ts       # Invoice token minting (mirrors NametagMinter)
├── StatusComputer.ts      # Invoice status computation logic
├── memo.ts                # Memo parsing/building utilities
├── types.ts               # All type definitions
└── index.ts               # Barrel exports
```

## Appendix B: Interaction Sequence — Full Invoice Lifecycle

```
Creator                    Aggregator              Payer
   │                          │                      │
   │ createInvoice(req)       │                      │
   │─── mint commitment ─────►│                      │
   │◄── inclusion proof ──────│                      │
   │                          │                      │
   │ send invoice token ──────────────────────────► │
   │                          │                      │ importInvoice(token)
   │                          │                      │
   │                          │                      │ send(amount, memo=INV:id:F)
   │◄─── token transfer ──────────────────────────── │
   │                          │                      │
   │ invoice:payment (unconfirmed)                   │ invoice:payment (unconfirmed)
   │                          │                      │
   │ ... more payments ...    │                      │
   │                          │                      │
   │ invoice:covered (unconfirmed)                   │
   │                          │                      │
   │ ... proofs confirmed ... │                      │
   │                          │                      │
   │ invoice:closed           │                      │
```

## Appendix C: Exchange/Swap Scenario

```
Exchange creates invoice:
  Target 1: exchange_address ← Buyer sends 100 USDU
  Target 2: buyer_address    ← Exchange sends 50 TOKEN_X

Both parties hold the invoice token.

Buyer sends 100 USDU → memo: INV:xxx:F
  → Exchange sees: target[0] COVERED (from their inbound history)
  → Buyer sees: target[0] payment sent (from their outbound history)

Exchange sends 50 TOKEN_X → memo: INV:xxx:F
  → Buyer sees: target[1] COVERED (from their inbound history)
  → Exchange sees: target[1] payment sent (from their outbound history)

Both parties independently compute COVERED → CLOSED.
```
