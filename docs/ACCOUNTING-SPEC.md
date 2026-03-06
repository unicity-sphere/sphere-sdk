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

### 1.1 Shared Asset Types

These types are shared between token genesis data and invoice targets — the same representation is used everywhere in the SDK.

```typescript
// =============================================================================
// Shared Asset Types (reused from TXF genesis coinData format)
// =============================================================================

/**
 * A fungible coin entry — same [coinId, amount] tuple used in TxfGenesisData.coinData.
 *
 * Examples: ["UCT", "1000000"], ["USDU", "500000000"], ["ALPHA", "200000"]
 *
 * This is the EXISTING format from TxfGenesisData.coinData: [string, string][].
 * Invoice targets reuse this exact type for consistency.
 */
type CoinEntry = [string, string]; // [coinId, amount in smallest units]

/**
 * An NFT entry — placeholder for future NFT support (not yet implemented in Sphere SDK).
 * Same type will be used in both token genesis and invoice targets when NFTs are added.
 */
interface NFTEntry {
  /** Unique NFT token ID (64-char hex) */
  readonly tokenId: string;
  /** NFT type identifier (64-char hex, optional) */
  readonly tokenType?: string;
}
```

### 1.2 Invoice Types

```typescript
// =============================================================================
// Invoice Types
// =============================================================================

/**
 * A single requested asset in an invoice target.
 * Wraps either a CoinEntry (fungible) or NFTEntry (non-fungible).
 * Exactly one of `coin` or `nft` must be set.
 */
interface InvoiceRequestedAsset {
  /** Fungible token request — same [coinId, amount] tuple as genesis coinData */
  readonly coin?: CoinEntry;
  /** NFT request (placeholder — not yet implemented) */
  readonly nft?: NFTEntry;
}

/**
 * A payment target within an invoice.
 * Each target specifies a destination address and the assets it should receive.
 */
interface InvoiceTarget {
  /** Destination address (DIRECT://... format) */
  readonly address: string;
  /** Requested assets for this address */
  readonly assets: InvoiceRequestedAsset[];
}

/**
 * Invoice terms — the payload serialized into the token's genesis.data.tokenData field.
 * This is the complete invoice definition. The token IS the invoice.
 */
interface InvoiceTerms {
  /**
   * Chain pubkey of the invoice creator.
   * OPTIONAL — when omitted, the invoice is anonymous.
   * Anonymous invoices cannot be cancelled (no creator to verify).
   */
  readonly creator?: string;
  /** Creation timestamp (ms) */
  readonly createdAt: number;
  /** Optional due date (ms timestamp). Expiration does NOT invalidate the invoice. */
  readonly dueDate?: number;
  /** Optional memo — free text or URL describing the reason */
  readonly memo?: string;
  /** Payment targets — at least one required */
  readonly targets: InvoiceTarget[];
}

/**
 * Request to create a new invoice.
 * Passed to `accounting.createInvoice()`.
 */
interface CreateInvoiceRequest {
  /** Payment targets — at least one required */
  readonly targets: InvoiceTarget[];
  /** Optional due date (ms timestamp). */
  readonly dueDate?: number;
  /** Optional memo — free text or URL describing the reason for the invoice */
  readonly memo?: string;
  /**
   * Whether to include the creator's chain pubkey in the invoice terms.
   * Default: true. Set to false to create an anonymous invoice.
   * Anonymous invoices cannot be cancelled.
   */
  readonly anonymous?: boolean;
}
```

### 1.3 Invoice Status Types

```typescript
/**
 * Computed invoice state.
 * NEVER stored — always derived on-demand from transaction history.
 *
 * IMPORTANT: Balances are computed from memo-referenced transfers only.
 * Physical token inventory (whether tokens are still held) is irrelevant.
 * Once CLOSED or CANCELLED, balances are frozen — no further computation.
 */
type InvoiceState = 'OPEN' | 'PARTIAL' | 'COVERED' | 'CLOSED' | 'CANCELLED' | 'EXPIRED';

/**
 * Detailed status of a single coin asset within a target.
 *
 * Balance formula:
 *   coveredAmount = sum of all forward payment amounts referencing this invoice for this target:coinId
 *   returnedAmount = sum of all back payment amounts referencing this invoice for this target:coinId
 *   netCoveredAmount = coveredAmount - returnedAmount
 *
 * Note: These balances reflect memo-referenced transfers only.
 * Whether the underlying tokens are still in the wallet is irrelevant.
 */
interface InvoiceCoinAssetStatus {
  /** The coin entry from the invoice target: [coinId, amount] */
  readonly coin: CoinEntry;
  /** Total forward payments for this asset (smallest units) */
  readonly coveredAmount: string;
  /** Total back/return payments for this asset (smallest units) */
  readonly returnedAmount: string;
  /** Net covered = coveredAmount - returnedAmount */
  readonly netCoveredAmount: string;
  /** Whether requested amount is fully met (netCovered >= requested) */
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
interface InvoiceNFTAssetStatus {
  /** The NFT entry from the invoice target */
  readonly nft: NFTEntry;
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
  /** Per-coin-asset status */
  readonly coinAssets: InvoiceCoinAssetStatus[];
  /** Per-NFT-asset status (placeholder) */
  readonly nftAssets: InvoiceNFTAssetStatus[];
  /** Whether all assets (coins and NFTs) for this target are covered */
  readonly isCovered: boolean;
  /** Whether all related tokens are confirmed */
  readonly confirmed: boolean;
}

/**
 * Reference to a transfer that contributes to (or is related to) an invoice.
 */
interface InvoiceTransferRef {
  /** Transfer/history entry ID */
  readonly transferId: string;
  /** Transfer direction from this wallet's perspective */
  readonly direction: 'inbound' | 'outbound';
  /** Invoice payment direction (from memo) */
  readonly paymentDirection: 'forward' | 'back';
  /** Coin ID of the transferred token */
  readonly coinId: string;
  /** Amount transferred (smallest units) */
  readonly amount: string;
  /** Destination address of the transfer */
  readonly destinationAddress: string;
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
 * A transfer that references this invoice but doesn't match any target.
 */
interface IrrelevantTransfer extends InvoiceTransferRef {
  /** Why this transfer is irrelevant */
  readonly reason: 'unknown_address' | 'unknown_asset' | 'unknown_address_and_asset';
}

/**
 * Complete computed status of an invoice.
 * Returned by `accounting.getInvoiceStatus()`.
 * NEVER persisted — always computed fresh from transaction history.
 *
 * When the invoice is in a terminal state (CLOSED or CANCELLED),
 * balances are frozen and no further computation occurs.
 */
interface InvoiceStatus {
  /** Invoice token ID */
  readonly invoiceId: string;
  /** Current computed state */
  readonly state: InvoiceState;
  /** Per-target breakdown */
  readonly targets: InvoiceTargetStatus[];
  /** Transfers referencing this invoice but not matching any target/asset */
  readonly irrelevantTransfers: IrrelevantTransfer[];
  /** Total forward payments across all targets, keyed by coinId */
  readonly totalForward: Record<string, string>;
  /** Total back/return payments across all targets, keyed by coinId */
  readonly totalBack: Record<string, string>;
  /** Whether ALL related tokens are confirmed */
  readonly allConfirmed: boolean;
  /** Timestamp of most recent related transfer */
  readonly lastActivityAt: number;
}
```

### 1.4 Result Types

```typescript
/**
 * Result of invoice creation.
 */
interface CreateInvoiceResult {
  /** Whether the invoice was successfully minted */
  readonly success: boolean;
  /** Invoice token ID (if successful) */
  readonly invoiceId?: string;
  /** Invoice token in TXF format (if successful) */
  readonly token?: TxfToken;
  /** Parsed invoice terms (if successful) */
  readonly terms?: InvoiceTerms;
  /** Error message (if failed) */
  readonly error?: string;
}

/**
 * Options for listing invoices.
 */
interface GetInvoicesOptions {
  /** Filter by computed state */
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
  readonly sortBy?: 'createdAt' | 'dueDate';
  readonly sortOrder?: 'asc' | 'desc';
}

/**
 * Lightweight invoice reference returned by getInvoices().
 * Contains the token ID and parsed terms. Status is NOT included --
 * call getInvoiceStatus() per invoice when needed.
 */
interface InvoiceRef {
  /** Invoice token ID */
  readonly invoiceId: string;
  /** Parsed invoice terms from token genesis */
  readonly terms: InvoiceTerms;
  /** Whether this wallet created the invoice (based on terms.creator matching identity) */
  readonly isCreator: boolean;
  /** Whether this invoice has been locally cancelled */
  readonly cancelled: boolean;
}
```

### 1.5 Configuration Types

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
  /** PaymentsModule instance (read-only access to history and tokens) */
  payments: PaymentsModule;
  /** Token storage for invoice tokens (same provider as currency/nametag tokens) */
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
   * Load invoice tokens from TokenStorageProvider.
   * Called by Sphere after module construction.
   *
   * Steps:
   * 1. Enumerate tokens, filter by INVOICE_TOKEN_TYPE_HEX
   * 2. Parse InvoiceTerms from each token's genesis.data.tokenData
   * 3. Load cancelled set from storage
   * 4. Subscribe to PaymentsModule events
   * 5. Scan full transaction history for any pre-existing payments
   *    referencing known invoices, and fire retroactive events
   */
  async load(): Promise<void>;

  /**
   * Create and mint a new invoice on-chain.
   *
   * Flow:
   * 1. Validate request (at least one target, valid amounts)
   * 2. Build InvoiceTerms (optionally adding creator pubkey, createdAt timestamp)
   * 3. Serialize InvoiceTerms canonically into tokenData
   * 4. Mint token via aggregator (same flow as NametagMinter)
   * 5. Store token via TokenStorageProvider
   * 6. Scan full transaction history for pre-existing payments referencing
   *    this invoice (handles P2P async: payment arrives before invoice)
   * 7. Fire 'invoice:created' event + any retroactive payment/coverage events
   *
   * @param request - Invoice creation parameters
   * @returns CreateInvoiceResult with token and parsed terms
   */
  async createInvoice(request: CreateInvoiceRequest): Promise<CreateInvoiceResult>;

  /**
   * Import an invoice token received from another party.
   * The token is validated (proof chain, token type, parseable tokenData).
   * Stored via TokenStorageProvider alongside other tokens.
   *
   * After import, scans full transaction history for any pre-existing
   * payments referencing this invoice and fires retroactive events.
   * This handles the P2P async case where payments arrive before the invoice.
   *
   * @param token - Invoice token in TXF format (received via transfer or out-of-band)
   * @returns Parsed InvoiceTerms
   * @throws SphereError if token is invalid or not an invoice token
   */
  async importInvoice(token: TxfToken): Promise<InvoiceTerms>;

  /**
   * Compute the current status of an invoice from local data.
   *
   * Reads invoice terms from the token's genesis tokenData, then scans
   * the full transaction history of all active and sent tokens for
   * transfers with matching INV:<id> memo prefix.
   *
   * Balance formula per target:asset:
   *   net = sum(forward payments) - sum(back payments)
   *
   * IMPORTANT:
   * - Balances are based on memo-referenced transfers, NOT token inventory
   * - Spending received tokens does not affect invoice balances
   * - For terminal states (CLOSED, CANCELLED), balances are frozen
   *
   * Status is NEVER cached or stored -- always computed fresh.
   *
   * @param invoiceId - The invoice token ID
   * @returns Computed InvoiceStatus
   * @throws SphereError if invoice token not found locally
   */
  async getInvoiceStatus(invoiceId: string): Promise<InvoiceStatus>;

  /**
   * List invoice tokens with optional filtering and pagination.
   *
   * Returns lightweight InvoiceRef objects (token ID + parsed terms).
   * Status is NOT computed here -- call getInvoiceStatus() per invoice when needed.
   *
   * When filtering by state, status IS computed per invoice to apply the filter
   * (but not returned -- caller must call getInvoiceStatus() separately).
   *
   * @param options - Filter/sort/pagination options
   * @returns Array of InvoiceRef objects
   */
  getInvoices(options?: GetInvoicesOptions): InvoiceRef[];

  /**
   * Get a single invoice by token ID.
   *
   * @param invoiceId - The invoice token ID
   * @returns InvoiceRef or null if not found
   */
  getInvoice(invoiceId: string): InvoiceRef | null;

  /**
   * Cancel an invoice. Only the creator can cancel.
   * Cancellation is local-only (not on-chain). Fires 'invoice:cancelled' event.
   *
   * Once cancelled, balances are frozen -- subsequent transfers referencing
   * this invoice are still recorded but do not change the terminal state.
   *
   * Anonymous invoices (terms.creator is undefined) cannot be cancelled.
   *
   * @param invoiceId - The invoice token ID
   * @throws SphereError if not creator, anonymous, not found, or already closed/cancelled
   */
  async cancelInvoice(invoiceId: string): Promise<void>;

  /**
   * Get all transfers related to a specific invoice.
   * Includes forward payments, back payments, and irrelevant transfers.
   * Scans full transaction history of active and sent tokens.
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
// Deterministic token ID from canonical invoice terms
const terms: InvoiceTerms = {
  creator: request.anonymous ? undefined : identity.chainPubkey,
  createdAt: Date.now(),
  dueDate: request.dueDate,
  memo: request.memo,
  targets: request.targets,
};
const invoiceBytes = canonicalSerialize(terms);
const tokenId = TokenId.fromData(invoiceBytes);
```

### 3.2 Minting Flow (Mirrors NametagMinter)

```
Step  Action                                SDK Class
----  ------                                ---------
1     Validate CreateInvoiceRequest         AccountingModule
2     Build InvoiceTerms (optionally add    AccountingModule
      creator pubkey, add createdAt)
3     Canonical serialize InvoiceTerms      AccountingModule
4     Generate deterministic salt           SHA-256(signingKey || invoiceBytes)
5     Create MintTransactionData            MintTransactionData.create()
      - tokenType: INVOICE_TOKEN_TYPE
      - tokenData: serialized InvoiceTerms
      - coinData: [] (non-fungible)
      - recipient: creator's DirectAddress
6     Create MintCommitment                 MintCommitment.create()
7     Submit to aggregator (3 retries)      client.submitMintCommitment()
      - SUCCESS -> continue
      - REQUEST_ID_EXISTS -> continue (idempotent)
8     Wait for inclusion proof              waitInclusionProof()
9     Create genesis transaction            commitment.toTransaction()
10    Create UnmaskedPredicate + TokenState  UnmaskedPredicate.create()
11    Create Token (with or without          Token.mint() or Token.fromJSON()
      verification based on config)
12    Store token via TokenStorageProvider   tokenStorage.saveToken()
13    Scan full history for pre-existing     AccountingModule
      payments referencing this invoice
14    Fire 'invoice:created' event +        emitEvent()
      retroactive payment/coverage events
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

InvoiceTerms must be serialized deterministically (same input -> same bytes) for consistent token ID derivation:

```typescript
function canonicalSerialize(terms: InvoiceTerms): Uint8Array {
  // Sort targets by address (lexicographic)
  // Within each target, sort assets: coins first (sorted by coinId), then NFTs (sorted by tokenId)
  const sorted: Record<string, unknown> = {
    createdAt: terms.createdAt,
    dueDate: terms.dueDate ?? null,
    memo: terms.memo ?? null,
    targets: [...terms.targets]
      .sort((a, b) => a.address.localeCompare(b.address))
      .map(t => ({
        address: t.address,
        assets: [...t.assets].sort((a, b) => {
          // Coins before NFTs, then sort within category
          if (a.coin && b.coin) return a.coin[0].localeCompare(b.coin[0]);
          if (a.nft && b.nft) return a.nft.tokenId.localeCompare(b.nft.tokenId);
          return a.coin ? -1 : 1; // coins first
        }),
      })),
  };
  // Only include creator if present (anonymous invoices omit it)
  if (terms.creator !== undefined) {
    sorted.creator = terms.creator;
  }
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
  amount: invoiceAsset.coin![1], // amount from CoinEntry tuple
  coinId: invoiceAsset.coin![0], // coinId from CoinEntry tuple
  memo: buildInvoiceMemo(invoiceId, 'forward', 'Order #1234'),
});
```

---

## 5. Status Computation

### 5.1 Algorithm

```
function computeInvoiceStatus(invoiceId, terms, cancelledSet, history):
  1. Parse terms from token's genesis.data.tokenData

  2. Check terminal states first:
     - if invoiceId in cancelledSet -> return CANCELLED with frozen balances
     - if previously computed as CLOSED (all covered + all confirmed)
       -> return CLOSED with frozen balances

  3. Scan FULL transaction history (active + sent tokens):
     Filter for entries where parseInvoiceMemo(entry.memo)?.invoiceId === invoiceId

  4. For each matching transfer:
     a. Determine target match: find target where target.address matches
        the transfer's destination address
     b. Determine asset match: find coin asset where coinId matches
     c. If both match -> accumulate into target/asset status
        - forward payment: add to coveredAmount
        - back payment: add to returnedAmount
     d. If address matches but coinId doesn't -> irrelevant (unknown_asset)
     e. If coinId matches but address doesn't -> irrelevant (unknown_address)
     f. If neither matches -> irrelevant (unknown_address_and_asset)

  5. Compute per-coin-asset coverage:
     netCovered = coveredAmount - returnedAmount
     isCovered = netCovered >= requestedAmount (from CoinEntry tuple[1])
     surplus = max(0, netCovered - requestedAmount)

  6. Compute per-target coverage:
     isCovered = all coin assets isCovered AND all NFTs received

  7. Determine state (order matters):
     a. if cancelled -> CANCELLED (terminal, already handled in step 2)
     b. if all targets isCovered AND allConfirmed -> CLOSED (terminal)
     c. if all targets isCovered -> COVERED
     d. if any asset has netCovered > 0 -> PARTIAL
     e. if terms.dueDate && now > terms.dueDate -> EXPIRED
     f. else -> OPEN

  8. Note: EXPIRED is checked AFTER CLOSED/COVERED. If all targets are
     covered+confirmed after dueDate, the state is CLOSED, not EXPIRED.

  9. Determine allConfirmed:
     Every InvoiceTransferRef.confirmed === true
```

### 5.2 Balance Computation Details

**The core formula for each target:asset:**

```
coveredAmount  = SUM(amount) for all transfers WHERE:
                 - memo matches INV:<invoiceId>:F (or INV:<invoiceId> without suffix)
                 - destination matches target.address
                 - coinId matches asset.coin[0]

returnedAmount = SUM(amount) for all transfers WHERE:
                 - memo matches INV:<invoiceId>:B
                 - destination matches target.address
                 - coinId matches asset.coin[0]

netCoveredAmount = coveredAmount - returnedAmount
isCovered        = netCoveredAmount >= asset.coin[1] (requested amount)
surplusAmount    = max(0, netCoveredAmount - asset.coin[1])
```

**Key semantics:**

- **Only memo-referenced transfers count.** A token received without an `INV:` memo does not affect any invoice balance, even if sent to a target address with a matching coin.
- **Spending tokens is independent.** If Alice receives 500 UCT with memo `INV:abc:F`, then spends that 500 UCT on something else (no `INV:abc` memo), the invoice `abc` still shows 500 UCT covered. The spent token's outbound transfer has no invoice memo, so it doesn't affect the invoice.
- **Self-payments affect balance.** If a target address owner sends tokens to themselves with memo `INV:abc:F`, the forward payment increases the covered balance. If they send with `INV:abc:B`, it decreases the balance. This is intentional and valid.
- **Terminal state freeze.** Once CLOSED or CANCELLED, `getInvoiceStatus()` returns the frozen state. New transfers referencing the invoice are still visible via `getRelatedTransfers()` but do not change the status or balances.

### 5.3 History Scanning Scope

The status computation scans the **full transaction history** from `PaymentsModule.getHistory()`. This includes:

- **Inbound transfers** — tokens received by this wallet (active tokens)
- **Outbound transfers** — tokens sent from this wallet (sent/archived tokens)
- Both active and archived (spent) token histories are included

This ensures that all memo-referenced transfers are captured regardless of whether the underlying tokens are still in the inventory.

### 5.4 Confirmation Tracking

A transfer is `confirmed` if:
- The token involved has a full proof chain (all `TxfTransaction.inclusionProof` are non-null)
- For outbound transfers: the commitment was included in a unicity certificate
- For inbound transfers: the received token's state transitions are all proven

This is determined by checking `TokenStatus === 'confirmed'` for the related tokens in `PaymentsModule.getTokens()`.

### 5.5 Perspective Handling

The same invoice viewed by different parties:

| Party | Sees inbound transfers as | Sees outbound transfers as |
|-------|--------------------------|---------------------------|
| Recipient (target address owner) | Forward payments covering invoice | Back/return payments (refunds they send) |
| Sender (payer) | Back/return payments they receive | Forward payments they sent |
| Creator (may be either) | Based on their address matching targets | Based on their outbound history |

The status computation uses the wallet's own transaction history, so each party naturally gets their perspective.

### 5.6 EXPIRED State Semantics

EXPIRED is **informational, not terminal**. When `dueDate` has passed:
- If the invoice is already CLOSED -> stays CLOSED (terminal)
- If the invoice is COVERED (all covered but not all confirmed) -> stays COVERED (will transition to CLOSED on confirmation)
- If the invoice is OPEN or PARTIAL -> becomes EXPIRED
- An EXPIRED invoice can still transition to CLOSED if all targets become covered and confirmed after expiration

This means: due date is a signal to participants, not an enforcement mechanism. The on-chain tokens don't enforce deadlines.

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
| 'invoice:irrelevant'

// New SphereEventMap entries:
'invoice:created': {
  invoiceId: string;
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
  // No 'confirmed' field -- CLOSED implies all confirmed
};

'invoice:cancelled': {
  invoiceId: string;
};

'invoice:expired': {
  invoiceId: string;
  // Informational only -- invoice can still transition to CLOSED
};

'invoice:unknown_reference': {
  invoiceId: string;          // referenced in memo but not in local token storage
  transfer: InvoiceTransferRef;
};

'invoice:overpayment': {
  invoiceId: string;
  address: string;
  coinId: string;
  surplus: string;     // amount exceeding request (smallest units)
  confirmed: boolean;
};

'invoice:irrelevant': {
  invoiceId: string;
  transfer: InvoiceTransferRef;
  reason: 'unknown_address' | 'unknown_asset' | 'unknown_address_and_asset';
  confirmed: boolean;
};
```

### 6.2 Event Firing Logic

```
On PaymentsModule 'transfer:incoming' or 'history:updated':
  1. Parse memo -> get invoiceId, direction
  2. If invoiceId not in local token storage:
     -> fire 'invoice:unknown_reference' { invoiceId, transfer }
     -> return
  3. If invoice is in terminal state (CLOSED or CANCELLED):
     -> do not fire balance-related events (frozen)
     -> return
  4. Build InvoiceTransferRef from transfer data
  5. Match transfer against invoice targets:
     a. If matches target + asset:
        -> fire 'invoice:payment' { invoiceId, transfer, direction, confirmed }
     b. If doesn't match any target/asset:
        -> fire 'invoice:irrelevant' { invoiceId, transfer, reason, confirmed }
  6. Recompute status:
     a. If asset just became covered -> fire 'invoice:asset_covered'
     b. If target just became covered -> fire 'invoice:target_covered'
     c. If all targets covered:
        - If all confirmed -> fire 'invoice:closed'
        - Else -> fire 'invoice:covered' { confirmed: false }
     d. If surplus detected -> fire 'invoice:overpayment'

On PaymentsModule 'transfer:confirmed':
  1. Check if transfer has invoice memo reference
  2. If invoice is in terminal state -> skip
  3. If yes, recompute and re-fire all applicable events with confirmed: true
  4. If all targets covered AND now all confirmed -> fire 'invoice:closed'

On createInvoice() or importInvoice():
  1. Store the invoice token
  2. Scan FULL transaction history for transfers referencing this invoice
  3. For each matching transfer found: fire events as if the transfer just arrived
     (invoice:payment, invoice:asset_covered, invoice:target_covered, etc.)
  4. This handles the P2P async case where payments arrive before the invoice
```

### 6.3 Idempotency Contract

**Events may fire multiple times.** The AccountingModule does NOT track which events have been fired. On every relevant trigger (incoming transfer, confirmation, history update, invoice creation/import with retroactive scan), it recomputes from scratch and fires all applicable events.

This means consumers WILL receive duplicate events and MUST handle them idempotently:
- A UI should update its display, not append to a list
- A notification system should deduplicate by (invoiceId, event type, transferId)
- A logging system can safely log duplicates

This design is intentional -- it avoids complex "already-fired" bookkeeping and aligns with the Nostr re-delivery model used elsewhere in the SDK.

### 6.4 Due Date Expiration

The `invoice:expired` event fires when `getInvoiceStatus()` or event recomputation detects that `dueDate` has passed and the invoice is in OPEN or PARTIAL state. Since events are idempotent, this may fire multiple times. Consumers should treat it as informational.

---

## 7. Storage

### 7.1 Token Storage (Primary)

Invoice tokens are stored via `TokenStorageProvider` -- the **same** provider used for currency tokens, nametag tokens, etc. The token's `genesis.data.tokenType` of `INVOICE_TOKEN_TYPE_HEX` identifies it as an invoice.

On `load()`, the AccountingModule filters all tokens in storage by token type to discover invoice tokens. All invoice data (terms, creator, targets, etc.) is read from the token's `genesis.data.tokenData` field.

### 7.2 Cancellation Storage

Since cancellation is local-only (not encoded in the token), a minimal per-address key tracks cancelled invoice IDs:

Added to `STORAGE_KEYS_ADDRESS` in `constants.ts`:

```typescript
/** Cancelled invoice IDs (JSON string array) */
CANCELLED_INVOICES: 'cancelled_invoices',
```

Full key format: `sphere_{addressId}_cancelled_invoices`

Storage schema:

```typescript
// Simple array of cancelled invoice token IDs
type CancelledInvoicesStorage = string[];
```

### 7.3 Storage Operations

```
createInvoice():
  1. tokenStorage.saveToken(invoiceToken)       // TXF token with InvoiceTerms in tokenData
  2. Scan full history for pre-existing payments // retroactive evaluation
  3. Fire events                                 // created + any retroactive events

importInvoice():
  1. tokenStorage.saveToken(invoiceToken)       // same as any received token
  2. Scan full history for pre-existing payments // retroactive evaluation
  3. Fire events                                 // any retroactive events

cancelInvoice():
  1. Load cancelled set from storage
  2. Add invoiceId to set
  3. storage.set(CANCELLED_INVOICES_KEY, updatedSet)

getInvoiceStatus():
  1. Read token from tokenStorage (parse terms from genesis.data.tokenData)
  2. Read cancelled set from storage
  3. If terminal (cancelled or closed) -> return frozen status
  4. Read full history from PaymentsModule (active + sent tokens)
  5. Compute status (pure function, no writes)

load():
  1. Enumerate tokens from tokenStorage
  2. Filter by tokenType === INVOICE_TOKEN_TYPE_HEX
  3. Parse InvoiceTerms from each token's genesis.data.tokenData
  4. Load cancelled set from storage
  5. Subscribe to PaymentsModule events
  6. Scan full history for pre-existing payments -> fire retroactive events
```

---

## 8. Validation Rules

### 8.1 CreateInvoiceRequest Validation

| Rule | Error |
|------|-------|
| `targets` must be non-empty | `INVOICE_NO_TARGETS` |
| Each target must have a valid DIRECT:// address | `INVOICE_INVALID_ADDRESS` |
| Each target must have at least one asset | `INVOICE_NO_ASSETS` |
| Each asset must have exactly one of `coin` or `nft` set | `INVOICE_INVALID_ASSET` |
| Each coin asset's amount (tuple index 1) must be a positive integer string | `INVOICE_INVALID_AMOUNT` |
| Each coin asset's coinId (tuple index 0) must be non-empty | `INVOICE_INVALID_COIN` |
| Each NFT asset's tokenId must be non-empty (64-char hex) | `INVOICE_INVALID_NFT` |
| `dueDate` (if provided) must be in the future | `INVOICE_PAST_DUE_DATE` |
| No duplicate addresses across targets | `INVOICE_DUPLICATE_ADDRESS` |
| No duplicate coinIds within a single target's coin assets | `INVOICE_DUPLICATE_COIN` |
| No duplicate NFT tokenIds within a single target | `INVOICE_DUPLICATE_NFT` |

### 8.2 Import Validation

| Rule | Error |
|------|-------|
| Token must have valid inclusion proof | `INVOICE_INVALID_PROOF` |
| Token type must be `INVOICE_TOKEN_TYPE_HEX` | `INVOICE_WRONG_TOKEN_TYPE` |
| Token's `genesis.data.tokenData` must parse as valid InvoiceTerms | `INVOICE_INVALID_DATA` |
| Invoice token must not already exist in local TokenStorage | `INVOICE_ALREADY_EXISTS` |

### 8.3 Cancel Validation

| Rule | Error |
|------|-------|
| Invoice token must exist locally | `INVOICE_NOT_FOUND` |
| Invoice must not be anonymous (terms.creator must be defined) | `INVOICE_ANONYMOUS` |
| Caller must be the creator (terms.creator === identity.chainPubkey) | `INVOICE_NOT_CREATOR` |
| Invoice must not already be CLOSED (computed) | `INVOICE_ALREADY_CLOSED` |
| Invoice must not already be cancelled | `INVOICE_ALREADY_CANCELLED` |

---

## 9. Connect Protocol Extensions

### 9.1 New Query Methods

```typescript
// sphere_getInvoices
// Returns: InvoiceRef[] (without computed status)
// Params: GetInvoicesOptions (optional)
{
  method: 'sphere_getInvoices',
  params: { state: 'OPEN', createdByMe: true, limit: 10 }
}

// sphere_getInvoiceStatus
// Returns: InvoiceStatus (computed fresh)
// Params: { invoiceId: string }
{
  method: 'sphere_getInvoiceStatus',
  params: { invoiceId: 'abc123...' }
}
```

### 9.2 New Intent Actions

```typescript
// create_invoice -- prompts user to confirm invoice creation
{
  action: 'create_invoice',
  params: {
    targets: [
      {
        address: 'DIRECT://...',
        assets: [
          { coin: ['UCT', '1000000'] },
          { coin: ['USDU', '500000000'] }
        ]
      }
    ],
    memo: 'Payment for services',
    dueDate: 1709251200000,
    anonymous: false, // default: false
  }
}
// Returns: { invoiceId: string } on success

// pay_invoice -- prompts user to confirm payment against an invoice
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
'invoice:irrelevant'     // When a non-matching payment references an invoice
```

---

## 10. Error Codes

All errors use `SphereError` with the following codes:

| Code | Message | When |
|------|---------|------|
| `INVOICE_NO_TARGETS` | Invoice must have at least one target | Empty targets array |
| `INVOICE_INVALID_ADDRESS` | Invalid target address: must be DIRECT:// format | Bad address format |
| `INVOICE_NO_ASSETS` | Target must have at least one asset | Empty assets in target |
| `INVOICE_INVALID_ASSET` | Asset must have exactly one of coin or nft | Both or neither set |
| `INVOICE_INVALID_AMOUNT` | Coin amount must be a positive integer string | Non-positive or non-integer |
| `INVOICE_INVALID_COIN` | Coin ID must be non-empty | Empty coinId in CoinEntry |
| `INVOICE_INVALID_NFT` | NFT tokenId must be a 64-char hex string | Bad NFT tokenId |
| `INVOICE_PAST_DUE_DATE` | Due date must be in the future | dueDate <= now |
| `INVOICE_DUPLICATE_ADDRESS` | Duplicate target address in invoice | Same address twice |
| `INVOICE_DUPLICATE_COIN` | Duplicate coin ID in target | Same coinId in one target |
| `INVOICE_DUPLICATE_NFT` | Duplicate NFT tokenId in target | Same NFT in one target |
| `INVOICE_MINT_FAILED` | Failed to mint invoice token: {details} | Aggregator failure |
| `INVOICE_INVALID_PROOF` | Invoice token has invalid inclusion proof | Import validation |
| `INVOICE_WRONG_TOKEN_TYPE` | Token is not an invoice token | Wrong tokenType on import |
| `INVOICE_INVALID_DATA` | Cannot parse invoice terms from token data | Corrupt tokenData |
| `INVOICE_ALREADY_EXISTS` | Invoice token already exists locally | Duplicate import |
| `INVOICE_NOT_FOUND` | Invoice token not found | Unknown invoiceId |
| `INVOICE_ANONYMOUS` | Anonymous invoices cannot be cancelled | Cancel on anonymous |
| `INVOICE_NOT_CREATOR` | Only the creator can cancel an invoice | Cancel by non-creator |
| `INVOICE_ALREADY_CLOSED` | Cannot cancel a closed invoice | Cancel after CLOSED |
| `INVOICE_ALREADY_CANCELLED` | Invoice is already cancelled | Double cancel |
| `INVOICE_ORACLE_REQUIRED` | Oracle provider required for invoice minting | No oracle configured |

---

## Appendix A: File Structure

```
modules/accounting/
+-- AccountingModule.ts    # Main module class
+-- InvoiceMinter.ts       # Invoice token minting (mirrors NametagMinter)
+-- StatusComputer.ts      # Invoice status computation logic
+-- memo.ts                # Memo parsing/building utilities
+-- types.ts               # All type definitions (InvoiceTerms, CoinEntry, NFTEntry, etc.)
+-- index.ts               # Barrel exports
```

## Appendix B: Interaction Sequence -- Full Invoice Lifecycle

```
Creator                    Aggregator              Payer
   |                          |                      |
   | createInvoice(req)       |                      |
   |--- mint commitment ----->|                      |
   |<-- inclusion proof ------|                      |
   | scan history (retroactive)                      |
   |                          |                      |
   | send invoice token ---------------------------> |
   |                          |                      | importInvoice(token)
   |                          |                      | scan history (retroactive)
   |                          |                      |
   |                          |                      | send(amount, memo=INV:id:F)
   |<---- token transfer ----------------------------|
   |                          |                      |
   | invoice:payment (conf=false)                    | invoice:payment (conf=false)
   |                          |                      |
   | ... more payments ...    |                      |
   |                          |                      |
   | invoice:covered (conf=false)                    |
   |                          |                      |
   | ... proofs confirmed ... |                      |
   |                          |                      |
   | invoice:payment (conf=true, re-fire)            |
   | invoice:closed           |                      |
   | (balances frozen)        |                      |
```

## Appendix C: Exchange/Swap Scenario

```
Exchange creates invoice:
  Target 1: exchange_address <- Buyer sends 100 USDU  [coin: ["USDU", "100000000"]]
  Target 2: buyer_address    <- Exchange sends 50 TKN  [coin: ["TKN", "50000000"]]

Both parties hold the invoice token.

Buyer sends 100 USDU -> memo: INV:xxx:F
  -> Exchange sees: target[0] COVERED (from their inbound history)
  -> Buyer sees: target[0] payment sent (from their outbound history)

Exchange sends 50 TKN -> memo: INV:xxx:F
  -> Buyer sees: target[1] COVERED (from their inbound history)
  -> Exchange sees: target[1] payment sent (from their outbound history)

Both parties independently compute COVERED -> CLOSED.
Balances frozen after CLOSED.
```

## Appendix D: P2P Async -- Payment Before Invoice

```
Time 1: Payer sends 500 USDU with memo INV:abc:F
        -> Recipient receives transfer
        -> AccountingModule fires invoice:unknown_reference (abc not yet known)
        -> Transfer recorded in history

Time 2: Recipient creates/imports invoice token abc
        -> AccountingModule performs full history rescan
        -> Finds the Time 1 transfer with memo INV:abc:F
        -> Fires invoice:payment for 500 USDU (retroactive)
        -> If 500 USDU covers the target:asset, fires invoice:asset_covered
        -> Continues with normal event cascade

This works because all events are idempotent.
```

## Appendix E: Token Spending Independence

```
Time 1: Alice receives 500 UCT with memo INV:abc:F
        -> Invoice abc: target[alice] UCT covered = 500

Time 2: Alice spends the 500 UCT token to buy something (memo: "Coffee")
        -> Invoice abc: target[alice] UCT covered = 500 (UNCHANGED)
        -> The outbound transfer has no INV:abc memo, so it doesn't affect the invoice
        -> The 500 UCT token is archived, but its INBOUND history entry still exists

Time 3: Alice receives another 500 UCT with memo INV:abc:F
        -> Invoice abc: target[alice] UCT covered = 1000

Time 4: Alice sends 200 UCT back with memo INV:abc:B
        -> Invoice abc: target[alice] UCT covered = 1000, returned = 200, net = 800
```
