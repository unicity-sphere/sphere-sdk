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
   * For anonymous invoices, any party holding the invoice may close or cancel it.
   */
  readonly creator?: string;
  /** Creation timestamp (ms) */
  readonly createdAt: number;
  /** Optional due date (ms timestamp). Expiration does NOT invalidate the invoice. */
  readonly dueDate?: number;
  /** Optional memo — free text or URL describing the reason */
  readonly memo?: string;
  /**
   * Optional ordered list of delivery method URLs, highest priority first.
   *
   * PLACEHOLDER — not used by the current SDK. The SDK currently uses
   * the Nostr-based delivery network exclusively. When delivery method
   * support is implemented, a payer should attempt delivery to the first
   * URL, falling back to subsequent URLs on failure.
   *
   * Examples: ["https://pay.example.com/inv/abc", "wss://relay.example.com"]
   */
  readonly deliveryMethods?: string[];
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
   * Optional ordered list of delivery method URLs, highest priority first.
   * PLACEHOLDER — not used by current SDK (Nostr delivery only).
   */
  readonly deliveryMethods?: string[];
  /**
   * Whether to include the creator's chain pubkey in the invoice terms.
   * Default: true. Set to false to create an anonymous invoice.
   * Anonymous invoices can be closed or cancelled by any holder.
   */
  readonly anonymous?: boolean;
}
```

### 1.3 Invoice Status Types

```typescript
/**
 * Computed invoice state.
 *
 * For non-terminal states (OPEN, PARTIAL, COVERED, EXPIRED): always derived
 * on-demand from transaction history. Never stored.
 *
 * For terminal states (CLOSED, CANCELLED): balances are frozen and persisted.
 * Dynamic recomputation stops.
 *
 * IMPORTANT: Balances are computed from memo-referenced transfers only.
 * Physical token inventory (whether tokens are still held) is irrelevant.
 */
type InvoiceState = 'OPEN' | 'PARTIAL' | 'COVERED' | 'CLOSED' | 'CANCELLED' | 'EXPIRED';

/**
 * Detailed status of a single coin asset within a target.
 *
 * Balance formula:
 *   coveredAmount = sum of all forward payment amounts referencing this invoice for this target:coinId
 *   returnedAmount = sum of all back/return payment amounts referencing this invoice for this target:coinId
 *                    (includes :B, :RC, and :RX directions)
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
  /** Total back/return payments for this asset (smallest units, includes :B, :RC, :RX) */
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
 *
 * IMPORTANT: A single token transfer may carry multiple coin entries
 * (multi-asset tokens). In that case, one InvoiceTransferRef is produced
 * per coin entry in the token's coinData. They share the same transferId
 * but have different coinId/amount values.
 */
interface InvoiceTransferRef {
  /** Transfer/history entry ID */
  readonly transferId: string;
  /** Transfer direction from this wallet's perspective */
  readonly direction: 'inbound' | 'outbound';
  /** Invoice payment direction (from memo) */
  readonly paymentDirection: 'forward' | 'back' | 'return_closed' | 'return_cancelled';
  /**
   * Coin ID for this specific coin entry.
   * A multi-asset token transfer produces one InvoiceTransferRef per coin.
   */
  readonly coinId: string;
  /**
   * Amount for this specific coin entry (smallest units).
   * A multi-asset token transfer produces one InvoiceTransferRef per coin.
   */
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
  readonly reason: 'unknown_address' | 'unknown_asset' | 'unknown_address_and_asset' | 'self_payment' | 'no_coin_data' | 'unauthorized_return';
}

/**
 * Complete computed status of an invoice.
 * Returned by `accounting.getInvoiceStatus()`.
 *
 * For non-terminal invoices: computed fresh from transaction history on every call.
 * For terminal invoices (CLOSED, CANCELLED): returns persisted frozen balances.
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
  /** Whether this is an explicit close (true) or implicit (false). Only meaningful when state === CLOSED. */
  readonly explicitClose?: boolean;
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
  /** Whether this invoice has been locally closed (explicitly) */
  readonly closed: boolean;
}

/**
 * Auto-return settings for terminated invoices.
 */
interface AutoReturnSettings {
  /** Global auto-return flag for all terminated invoices */
  readonly global: boolean;
  /** Per-invoice auto-return overrides (invoiceId -> enabled) */
  readonly perInvoice: Record<string, boolean>;
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
  /**
   * Whether to auto-terminate (close/cancel) the local invoice when
   * receiving an auto-return transfer with :RC or :RX direction.
   * Default: false (opt-in).
   */
  autoTerminateOnReturn?: boolean;
}

/**
 * Dependencies injected into AccountingModule.
 * Follows the same pattern as MarketModuleDependencies.
 */
interface AccountingModuleDependencies {
  /** PaymentsModule instance (read access to history/tokens, send() for auto-return) */
  payments: PaymentsModule;
  /** Token storage for invoice tokens (same provider as currency/nametag tokens) */
  tokenStorage: TokenStorageProvider;
  /** Oracle for minting invoice tokens */
  oracle: OracleProvider;
  /** Current wallet identity */
  identity: FullIdentity;
  /** Event emitter (from Sphere) */
  emitEvent: <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => void;
  /** General storage for cancelled/closed sets, frozen balances, auto-return settings */
  storage: StorageProvider;
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
   * 3. Load cancelled set, closed set, frozen balances, and auto-return settings from storage
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
   * For non-terminal invoices: reads invoice terms from the token's genesis
   * tokenData, then scans full transaction history for transfers with matching
   * INV:<id> memo prefix. Computes balances fresh.
   *
   * For terminal invoices (CLOSED, CANCELLED): returns persisted frozen balances
   * without recomputation.
   *
   * Balance formula per target:asset:
   *   net = sum(forward payments) - sum(back + return payments)
   *
   * IMPORTANT:
   * - Balances are based on memo-referenced transfers, NOT token inventory
   * - Spending received tokens does not affect invoice balances
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
   * Explicitly close an invoice. Signals that the creator is satisfied
   * with the current payment state — no more payments needed.
   * Only the creator may close (for anonymous invoices, any holder may close).
   *
   * The difference from implicit close: implicit close happens automatically
   * when all targets are fully covered AND all tokens confirmed. Explicit close
   * can happen at any non-terminal state (even OPEN or PARTIAL).
   *
   * On close:
   * 1. Current balances are computed one final time and frozen (persisted)
   * 2. Invoice ID is added to the closed set in storage
   * 3. Fires 'invoice:closed' event with { explicit: true }
   * 4. If autoReturn is true, auto-return is enabled and triggered immediately:
   *    - Returns SURPLUS ONLY (amount exceeding requested per target:asset)
   *    - Uses :RC memo direction
   *    - Fires 'invoice:auto_returned' for each return executed
   *
   * @param invoiceId - The invoice token ID
   * @param options - Optional: { autoReturn?: boolean } — enable auto-return on close
   * @throws SphereError with INVOICE_NOT_CREATOR if not the creator (non-anonymous)
   * @throws SphereError if not found, already closed, or already cancelled
   */
  async closeInvoice(invoiceId: string, options?: { autoReturn?: boolean }): Promise<void>;

  /**
   * Cancel an invoice. Only the creator can cancel.
   * Cancellation is local-only (not on-chain). Fires 'invoice:cancelled' event.
   *
   * Cancelling means abandoning the deal/session associated with this invoice.
   * This is distinct from closing (accepting current payments as final).
   *
   * On cancel:
   * 1. Current balances are computed one final time and frozen (persisted)
   * 2. Invoice ID is added to the cancelled set in storage
   * 3. Fires 'invoice:cancelled' event
   * 4. If autoReturn is true, auto-return is enabled and triggered immediately:
   *    - Returns EVERYTHING (all forward payments received)
   *    - Uses :RX memo direction
   *    - Fires 'invoice:auto_returned' for each return executed
   *
   * For anonymous invoices (terms.creator undefined), any party holding the invoice
   * locally may cancel it — since there is no creator to verify against.
   *
   * @param invoiceId - The invoice token ID
   * @param options - Optional: { autoReturn?: boolean } — enable auto-return on cancel
   * @throws SphereError if not creator (non-anonymous), not found, or already closed/cancelled
   */
  async cancelInvoice(invoiceId: string, options?: { autoReturn?: boolean }): Promise<void>;

  /**
   * Pay an invoice — send tokens referencing the given invoice.
   *
   * This is a convenience wrapper around PaymentsModule.send() that:
   * 1. Validates the invoice is not terminated locally (throws INVOICE_TERMINATED if it is)
   * 2. Constructs the appropriate INV:<id>:F memo
   * 3. Calls PaymentsModule.send()
   *
   * IMPORTANT: Outgoing forward payments to terminated invoices are BLOCKED.
   * An INVOICE_TERMINATED exception is thrown BEFORE the transfer happens.
   *
   * @param invoiceId - The invoice token ID
   * @param params - { targetIndex, assetIndex?, amount?, freeText? }
   * @returns TransferResult from PaymentsModule.send()
   * @throws SphereError with INVOICE_TERMINATED if invoice is CLOSED or CANCELLED
   * @throws SphereError with INVOICE_NOT_FOUND if invoice not found
   */
  async payInvoice(invoiceId: string, params: PayInvoiceParams): Promise<TransferResult>;

  /**
   * Return tokens for an invoice — send tokens back to the original sender.
   *
   * This is always allowed regardless of invoice terminal state.
   * Uses :B direction code in the memo.
   *
   * RESTRICTION: Only callable when the local wallet's address matches
   * one of the invoice targets. Non-target parties cannot send return
   * payments — they can only make forward payments. Throws INVOICE_NOT_TARGET
   * if the wallet is not an invoice target.
   *
   * @param invoiceId - The invoice token ID
   * @param params - { recipient, amount, coinId, freeText? }
   * @returns TransferResult from PaymentsModule.send()
   * @throws SphereError with INVOICE_NOT_TARGET if wallet is not an invoice target
   */
  async returnInvoicePayment(invoiceId: string, params: ReturnPaymentParams): Promise<TransferResult>;

  /**
   * Enable or disable auto-return for terminated invoices.
   *
   * When auto-return is enabled, two things happen:
   *
   * 1. **Immediate trigger:** If the invoice (or any terminated invoice for '*')
   *    is already terminated, auto-return is executed immediately:
   *    - CLOSED invoice: return the SURPLUS ONLY (amount exceeding requested).
   *      If no surplus exists, nothing is returned.
   *    - CANCELLED invoice: return EVERYTHING (all forward payments received).
   *
   * 2. **Ongoing:** Future incoming forward payments referencing the terminated
   *    invoice are automatically returned to the sender:
   *    - CLOSED: entire incoming amount returned (any new payment is surplus).
   *    - CANCELLED: entire incoming amount returned (deal is abandoned).
   *
   * The return memo uses :RC (return-for-closed) or :RX (return-for-cancelled).
   *
   * Auto-return ONLY applies to terminated invoices (CLOSED or CANCELLED).
   * Calling this on a non-terminated invoice stores the preference but has
   * no effect until the invoice terminates.
   *
   * RESTRICTION: Auto-return only executes if the local wallet's address
   * matches one of the invoice targets. Non-target parties cannot return tokens.
   *
   * Return payments (:B, :RC, :RX) are NEVER auto-returned (prevents loops).
   *
   * @param invoiceId - Invoice token ID, or '*' for global setting
   * @param enabled - Whether auto-return is enabled
   */
  async setAutoReturn(invoiceId: string | '*', enabled: boolean): Promise<void>;

  /**
   * Get current auto-return settings.
   *
   * @returns AutoReturnSettings with global flag and per-invoice overrides
   */
  getAutoReturnSettings(): AutoReturnSettings;

  /**
   * Get all transfers related to a specific invoice.
   * Includes forward payments, back payments, return payments, and irrelevant transfers.
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
  readonly direction: 'forward' | 'back' | 'return_closed' | 'return_cancelled';
  /** Optional free text after the structured prefix */
  readonly freeText?: string;
}
```

### 2.3 Payment Parameter Types

```typescript
/**
 * Parameters for payInvoice().
 */
interface PayInvoiceParams {
  /** Which target to pay (index into invoice terms.targets) */
  readonly targetIndex: number;
  /** Which asset within that target (index into target.assets). Defaults to 0. */
  readonly assetIndex?: number;
  /** Amount to pay (defaults to remaining needed to cover the asset) */
  readonly amount?: string;
  /** Optional free text appended to memo */
  readonly freeText?: string;
}

/**
 * Parameters for returnInvoicePayment().
 */
interface ReturnPaymentParams {
  /** Recipient address (original sender to return tokens to) */
  readonly recipient: string;
  /** Amount to return */
  readonly amount: string;
  /** Coin ID */
  readonly coinId: string;
  /** Optional free text appended to memo */
  readonly freeText?: string;
}
```

### 2.4 Factory Function

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

### 2.5 Barrel Exports (`modules/accounting/index.ts`)

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
  bytesToHex(sha256(new TextEncoder().encode('unicity.invoice.v1')));
```

### 3.4 Canonical Serialization

InvoiceTerms must be serialized deterministically (same input -> same bytes) for consistent token ID derivation:

```typescript
function canonicalSerialize(terms: InvoiceTerms): Uint8Array {
  // Sort targets by address (lexicographic)
  // Within each target, sort assets: coins first (sorted by coinId), then NFTs (sorted by tokenId)
  const sorted: Record<string, unknown> = {
    createdAt: terms.createdAt,
    deliveryMethods: terms.deliveryMethods ?? null,
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
direction     = "F" / "B" / "RC" / "RX"
free-text     = *CHAR
```

### 4.2 Direction Codes

| Code | Constant | Meaning | Balance effect | Auto-returnable | Who can send |
|------|----------|---------|----------------|-----------------|--------------|
| `F` (or omitted) | `'forward'` | Forward payment towards covering the invoice | +coveredAmount | Yes | Anyone |
| `B` | `'back'` | Manual return/refund | +returnedAmount | **No** | **Target only** |
| `RC` | `'return_closed'` | Auto-return because invoice is closed | +returnedAmount | **No** | **Target only** |
| `RX` | `'return_cancelled'` | Auto-return because invoice is cancelled | +returnedAmount | **No** | **Target only** |

All return directions (`:B`, `:RC`, `:RX`) have the same effect on balance computation — they increase `returnedAmount`. The distinction is semantic.

**Sender restriction:** Only a party whose wallet address matches one of the invoice targets may send return payments (`:B`, `:RC`, `:RX`). Non-target parties can only make forward payments (`:F`). The `returnInvoicePayment()` method and auto-return system enforce this with `INVOICE_NOT_TARGET`.

### 4.3 Regex

```typescript
const INVOICE_MEMO_REGEX = /^INV:([0-9a-fA-F]{64})(?::(F|B|RC|RX))?(?: (.+))?$/;
```

### 4.4 Parsing Implementation

```typescript
function parseInvoiceMemo(memo: string): InvoiceMemoRef | null {
  const match = memo.match(INVOICE_MEMO_REGEX);
  if (!match) return null;

  let direction: InvoiceMemoRef['direction'];
  switch (match[2]) {
    case 'B':  direction = 'back'; break;
    case 'RC': direction = 'return_closed'; break;
    case 'RX': direction = 'return_cancelled'; break;
    default:   direction = 'forward'; break; // F or omitted
  }

  return {
    invoiceId: match[1].toLowerCase(),
    direction,
    freeText: match[3] || undefined,
  };
}
```

### 4.5 Constructing Invoice Memos

```typescript
function buildInvoiceMemo(
  invoiceId: string,
  direction: 'forward' | 'back' | 'return_closed' | 'return_cancelled' = 'forward',
  freeText?: string
): string {
  const dirMap = {
    forward: ':F',
    back: ':B',
    return_closed: ':RC',
    return_cancelled: ':RX',
  };
  const text = freeText ? ` ${freeText}` : '';
  return `INV:${invoiceId}${dirMap[direction]}${text}`;
}
```

### 4.6 Integration with PaymentsModule.send()

No changes to `PaymentsModule.send()` are required. The caller constructs the memo using `buildInvoiceMemo()` and passes it via the existing `TransferRequest.memo` field:

```typescript
await sphere.payments.send({
  recipient: invoiceTarget.address,
  amount: invoiceAsset.coin![1], // amount from CoinEntry tuple
  coinId: invoiceAsset.coin![0], // coinId from CoinEntry tuple
  memo: buildInvoiceMemo(invoiceId, 'forward', 'Order #1234'),
});
```

For auto-return, the accounting module internally calls:

```typescript
await this.deps.payments.send({
  recipient: originalSenderAddress,
  amount: tokenAmount,
  coinId: tokenCoinId,
  memo: buildInvoiceMemo(invoiceId, invoiceIsClosed ? 'return_closed' : 'return_cancelled'),
});
```

### 4.7 Memo Injection Defense

The `INV:` memo field is user-controlled — any sender can write any memo string. The canonical parser (`parseInvoiceMemo()`) is the **sole authority** for extracting invoice references. Security measures:

- **Invoice ID validation:** Only 64-char hex strings are accepted as invoice IDs. Other formats are rejected (treated as non-invoice transfers).
- **Direction code normalization:** Only `:F`, `:B`, `:RC`, `:RX` are recognized. Unknown suffixes are ignored (treated as forward).
- **Sender validation for returns:** Inbound `:B`/`:RC`/`:RX` transfers are validated against invoice target addresses before being accepted as return payments (see §6.2 step 3).
- **Self-payment exclusion:** Forward payments where sender == destination == target are excluded (see §5.2).
- Applications **MUST NOT** parse invoice memos manually — always use `parseInvoiceMemo()`.

---

## 5. Status Computation

### 5.1 Algorithm

```
function computeInvoiceStatus(invoiceId, terms, cancelledSet, closedSet, frozenBalances, history):
  1. Parse terms from token's genesis.data.tokenData

  2. Check terminal states first:
     - if invoiceId in cancelledSet -> return CANCELLED with frozen balances from frozenBalances
     - if invoiceId in closedSet -> return CLOSED with frozen balances from frozenBalances
     - if previously reached implicit CLOSED (all covered + all confirmed)
       -> compute frozen balances, persist, return CLOSED

  3. Scan FULL transaction history (active + sent tokens):
     Filter for entries where parseInvoiceMemo(entry.memo)?.invoiceId === invoiceId

  4. For each matching transfer:
     a. Extract ALL coin entries from the transferred token's coinData.
        A single token may carry multiple coins (multi-asset token).
     b. For EACH coin entry [coinId, amount] in the token:
        i.  Determine target match:
            - For FORWARD payments (F): match target where target.address matches
              the transfer's DESTINATION address
            - For RETURN payments (B, RC, RX): match target where target.address matches
              the transfer's SENDER address (returns flow FROM target TO payer)
        ii. Determine asset match: find coin asset where coinId matches
        iii. If both match -> accumulate into target/asset status
             - forward payment (F): add amount to coveredAmount
             - back/return payment (B, RC, RX): add amount to returnedAmount
        iv.  If address matches but coinId doesn't -> irrelevant (unknown_asset)
        v.   If coinId matches but address doesn't -> irrelevant (unknown_address)
        vi.  If neither matches -> irrelevant (unknown_address_and_asset)
     c. Produce one InvoiceTransferRef per coin entry (same transferId,
        different coinId/amount)

  5. Compute per-coin-asset coverage:
     netCovered = coveredAmount - returnedAmount
     isCovered = netCovered >= requestedAmount (from CoinEntry tuple[1])
     surplus = max(0, netCovered - requestedAmount)

  6. Compute per-target coverage:
     isCovered = all coin assets isCovered AND all NFTs received

  7. Determine state (order matters):
     a. if cancelled -> CANCELLED (terminal, already handled in step 2)
     b. if closed (explicit) -> CLOSED (terminal, already handled in step 2)
     c. if all targets isCovered AND allConfirmed -> CLOSED (implicit terminal)
        -> freeze balances and persist
     d. if all targets isCovered -> COVERED
     e. if any asset has netCovered > 0 -> PARTIAL
     f. if terms.dueDate && now > terms.dueDate -> EXPIRED
     g. else -> OPEN

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
                 - memo matches INV:<invoiceId>:B or :RC or :RX
                 - sender matches target.address (returns flow FROM target TO payer)
                 - coinId matches asset.coin[0]

netCoveredAmount = max(0, coveredAmount - returnedAmount)   // floored at zero
isCovered        = netCoveredAmount >= asset.coin[1] (requested amount)
surplusAmount    = max(0, netCoveredAmount - asset.coin[1])
```

**Key semantics:**

- **Only memo-referenced transfers count.** A token received without an `INV:` memo does not affect any invoice balance, even if sent to a target address with a matching coin.
- **Spending tokens is independent.** If Alice receives 500 UCT with memo `INV:abc:F`, then spends that 500 UCT on something else (no `INV:abc` memo), the invoice `abc` still shows 500 UCT covered. The spent token's outbound transfer has no invoice memo, so it doesn't affect the invoice.
- **Self-payments are excluded.** If a target address owner sends tokens to themselves with memo `INV:abc:F` (sender address == destination address == target address), the forward payment is NOT counted toward `coveredAmount`. It is classified as `invoice:irrelevant` with reason `'self_payment'`. This prevents a target from fabricating coverage without external payments.
- **Only target parties may return.** Back/return payments (`:B`, `:RC`, `:RX`) can only be sent by a party whose wallet address matches one of the invoice targets. Non-target parties can only make forward payments (`:F`).
- **Terminal state freeze.** Once CLOSED or CANCELLED, balances are frozen and persisted. `getInvoiceStatus()` returns the persisted snapshot. No recomputation occurs. New transfers referencing the invoice are still visible via `getRelatedTransfers()`.
- **Multi-asset tokens.** A single token may carry multiple coin entries (e.g., `coinData = [["UCT", "500"], ["USDU", "1000"]]`). When such a token is transferred with an invoice memo, each coin entry is matched independently against the invoice targets. One transfer of a multi-asset token may cover multiple requested assets for the same target simultaneously.

### 5.3 Multi-Asset Token Handling

When a transfer involves a multi-asset token:

1. Extract all `[coinId, amount]` pairs from the token's `coinData`.
2. For each pair, independently match against the invoice target's address and requested assets.
3. Produce one `InvoiceTransferRef` per coin entry (they share the same `transferId` but have distinct `coinId`/`amount`).
4. Each coin entry may match a different requested asset, or some may be irrelevant.

Example: A token with `coinData = [["UCT", "500"], ["USDU", "1000"]]` transferred to `DIRECT://alice` with memo `INV:abc:F`:
- If the invoice target for alice requests UCT and USDU: both are matched as forward payments.

**Empty coinData handling:** If a transfer's token has empty `coinData` (e.g., an NFT-only token or a malformed token), the transfer is classified as `invoice:irrelevant` with reason `'no_coin_data'`. No balance computation is performed for that transfer. This edge case is logged but does not throw.
- If the invoice target for alice only requests UCT: the UCT entry matches, the USDU entry is irrelevant (`unknown_asset`).

### 5.4 History Scanning Scope

The status computation scans the **full transaction history** from `PaymentsModule.getHistory()`. This includes:

- **Inbound transfers** — tokens received by this wallet (active tokens)
- **Outbound transfers** — tokens sent from this wallet (sent/archived tokens)
- Both active and archived (spent) token histories are included

This ensures that all memo-referenced transfers are captured regardless of whether the underlying tokens are still in the inventory.

**Dynamic scanning applies only to non-terminal invoices.** For terminal invoices, the persisted frozen balances are returned directly.

### 5.5 Confirmation Tracking

A transfer is `confirmed` if:
- The token involved has a full proof chain (all `TxfTransaction.inclusionProof` are non-null)
- For outbound transfers: the commitment was included in a unicity certificate
- For inbound transfers: the received token's state transitions are all proven

This is determined by checking `TokenStatus === 'confirmed'` for the related tokens in `PaymentsModule.getTokens()`.

### 5.6 Perspective Handling

The same invoice viewed by different parties:

| Party | Sees inbound transfers as | Sees outbound transfers as |
|-------|--------------------------|---------------------------|
| Recipient (target address owner) | Forward payments covering invoice | Back/return payments (refunds they send) |
| Sender (payer) | Back/return payments they receive | Forward payments they sent |
| Creator (may be either) | Based on their address matching targets | Based on their outbound history |

The status computation uses the wallet's own transaction history, so each party naturally gets their perspective.

### 5.7 EXPIRED State Semantics

EXPIRED is **informational, not terminal**. When `dueDate` has passed:
- If the invoice is already CLOSED -> stays CLOSED (terminal)
- If the invoice is already CANCELLED -> stays CANCELLED (terminal)
- If the invoice is COVERED (all covered but not all confirmed) -> stays COVERED (will transition to CLOSED on confirmation). EXPIRED is NOT reachable from COVERED.
- If the invoice is OPEN or PARTIAL -> becomes EXPIRED
- An EXPIRED invoice can still transition to CLOSED if all targets become covered and confirmed after expiration

This means: due date is a signal to participants, not an enforcement mechanism. The on-chain tokens don't enforce deadlines.

### 5.8 Termination Semantics

**Close and cancel are local operations with persisted frozen balances.**

- **Explicit close (`closeInvoice()`).** The creator is satisfied with current payments. Balances are frozen at the moment of close. Subsequent forward payments may be auto-returned with `:RC`.
- **Cancel (`cancelInvoice()`).** The creator abandons the deal. Balances are frozen at the moment of cancel. Subsequent forward payments may be auto-returned with `:RX`.
- **Implicit close.** Happens automatically when all targets are fully covered AND all tokens confirmed. Balances are frozen. This is functionally identical to explicit close but with `explicitClose: false` in the status.
- **Outbound blocking.** `payInvoice()` throws `INVOICE_TERMINATED` if the invoice is locally terminated (closed or cancelled). The transfer does NOT happen. This is the only case where the accounting module prevents a transfer.
- **Perspective divergence.** Your CLOSED does not imply others' CLOSED. Different parties have different transaction histories.
- **Frozen balance staleness.** The `coveredAmount`, `returnedAmount`, and `netCoveredAmount` in frozen balances reflect the state at the moment of termination. Transfers that arrive after termination (and are auto-returned) are NOT reflected in the frozen snapshot — they are visible only via `getRelatedTransfers()`. The `allConfirmed` field is the exception: it is dynamically derived (see §7.3). Applications needing a complete post-termination picture should combine frozen balances with `getRelatedTransfers()`.

### 5.9 Concurrency Model

All state-mutating operations on a given invoice are serialized through a **per-invoice async mutex** (`Map<string, Promise<void>>`). This prevents race conditions where concurrent events could corrupt terminal state or cause double auto-returns.

**Serialized operations** (per invoiceId):
- `closeInvoice()`, `cancelInvoice()`
- Implicit close (all targets covered + confirmed)
- Auto-return execution (immediate and ongoing)
- `setAutoReturn()` immediate trigger
- Inbound event processing that may trigger auto-return or implicit close

**Non-serialized** (read-only):
- `getInvoiceStatus()`, `getInvoice()`, `getInvoices()`, `getRelatedTransfers()`
- `payInvoice()` (reads terminal state, delegates send to PaymentsModule)
- `parseInvoiceMemo()`

```typescript
// Conceptual implementation
private readonly invoiceGates = new Map<string, Promise<void>>();

private async withInvoiceGate(invoiceId: string, fn: () => Promise<void>): Promise<void> {
  const prev = this.invoiceGates.get(invoiceId) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run fn after previous completes (even on error)
  this.invoiceGates.set(invoiceId, next);
  await next;
}
```

Global operations (`setAutoReturn('*', true)`) acquire the gate for each affected invoice **sequentially**, not all at once. This prevents deadlocks and allows interleaving with per-invoice operations on other invoices.

### 5.10 Non-Blocking Inbound Guarantee

**Accounting errors MUST NEVER break the inbound token transfer flow.**

Inbound token transfers are atomic — they either happen fully or not at all. The accounting module is a post-hoc observer. All inbound event processing is wrapped in try/catch:

- Memo parsing failure -> transfer proceeds, accounting ignores it
- Invoice lookup failure -> transfer proceeds, `invoice:unknown_reference` fires (best-effort)
- Status computation error -> transfer already complete, event firing skipped
- Auto-return failure -> inbound transfer already recorded, auto-return can be retried
- Auto-return sender resolution failure -> if the original sender's address cannot be resolved for the return transfer, the auto-return is skipped for that transfer and logged. The dedup ledger is NOT written, so the return will be retried on the next trigger (e.g., `setAutoReturn()` call or next inbound event)
- Storage failure -> transfer data persists in PaymentsModule history, accounting catches up on next recomputation

No exception from the accounting layer may propagate to or interrupt the payment layer for inbound transfers.

**Outbound forward payments to terminated invoices ARE blocked** — `payInvoice()` throws before calling `send()`. This is deliberate: the caller explicitly attempted to pay a terminated invoice.

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
| 'invoice:auto_returned'
| 'invoice:return_received'

// New SphereEventMap entries:
'invoice:created': {
  invoiceId: string;
  confirmed: boolean;  // true once mint proof is confirmed
};

'invoice:payment': {
  invoiceId: string;
  transfer: InvoiceTransferRef;
  direction: 'forward' | 'back' | 'return_closed' | 'return_cancelled';
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
  explicit: boolean;   // true if via closeInvoice(), false if implicit (all confirmed)
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
  reason: 'unknown_address' | 'unknown_asset' | 'unknown_address_and_asset' | 'self_payment' | 'no_coin_data' | 'unauthorized_return';
  confirmed: boolean;
};

'invoice:auto_returned': {
  invoiceId: string;
  originalTransfer: InvoiceTransferRef;   // the inbound forward payment that was returned
  returnTransfer: InvoiceTransferRef;     // the outbound return payment
};

'invoice:return_received': {
  invoiceId: string;
  transfer: InvoiceTransferRef;           // the received :RC or :RX transfer
  returnReason: 'closed' | 'cancelled';   // derived from :RC or :RX
};
```

### 6.2 Event Firing Logic

```
On PaymentsModule 'transfer:incoming' or 'history:updated':
  1. Parse memo -> get invoiceId, direction
  2. If invoiceId not in local token storage:
     -> fire 'invoice:unknown_reference' { invoiceId, transfer }
     -> return
  3. If direction is 'return_closed' or 'return_cancelled':
     a. **Validate sender:** check that the transfer's sender address matches
        one of the invoice's target addresses. If the sender is NOT an invoice
        target, treat the transfer as `invoice:irrelevant` with reason
        `'unauthorized_return'` and return. This prevents spoofed :RC/:RX
        transfers from non-target parties triggering auto-termination.
     b. fire 'invoice:return_received' { invoiceId, transfer, returnReason }
     c. if autoTerminateOnReturn config is true:
        - :RC -> auto-close invoice locally (if not already terminated)
        - :RX -> auto-cancel invoice locally (if not already terminated)
     -> return
  4. If invoice is in terminal state (CLOSED or CANCELLED):
     -> fire 'invoice:payment' (transfer is still recorded)
     -> if direction is 'forward' AND auto-return enabled (perInvoice[id] ?? global)
        AND wallet is a target:
        - check dedup ledger for (invoiceId, transferId) — skip if already returned
        - invoke auto-return: send entire incoming amount back
          (any new forward payment to a terminated invoice is surplus by definition)
        - use :RC for CLOSED, :RX for CANCELLED
        - write dedup ledger entry
        - fire 'invoice:auto_returned'
     -> do not fire balance-related events (frozen)
     -> return
  5. Build InvoiceTransferRef from transfer data
  6. Match transfer against invoice targets:
     a. If matches target + asset:
        -> fire 'invoice:payment' { invoiceId, transfer, direction, confirmed }
     b. If doesn't match any target/asset:
        -> fire 'invoice:irrelevant' { invoiceId, transfer, reason, confirmed }
  7. Recompute status:
     a. If asset just became covered -> fire 'invoice:asset_covered'
     b. If target just became covered -> fire 'invoice:target_covered'
     c. If all targets covered:
        - If all confirmed -> fire 'invoice:closed' { explicit: false }
          -> freeze balances and persist
        - Else -> fire 'invoice:covered' { confirmed: false }
     d. If surplus detected -> fire 'invoice:overpayment'
     e. If terms.dueDate && now > terms.dueDate && state is OPEN or PARTIAL:
        -> fire 'invoice:expired' { invoiceId }

On PaymentsModule 'transfer:confirmed':
  1. Check if transfer has invoice memo reference
  2. If invoice is in terminal state -> skip
  3. If yes, recompute and re-fire all applicable events with confirmed: true
  4. If all targets covered AND now all confirmed -> fire 'invoice:closed' { explicit: false }
     -> freeze balances and persist

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

**Passive detection limitation:** There is no background timer for due date expiration. The `invoice:expired` event only fires when triggered by a status query or an inbound event. If no activity occurs after the due date, the event will not fire until the next interaction. Applications requiring prompt expiration notification should either poll `getInvoiceStatus()` periodically or set their own `setTimeout(callback, dueDate - Date.now())` timer.

---

## 7. Storage

### 7.1 Token Storage (Primary)

Invoice tokens are stored via `TokenStorageProvider` -- the **same** provider used for currency tokens, nametag tokens, etc. The token's `genesis.data.tokenType` of `INVOICE_TOKEN_TYPE_HEX` identifies it as an invoice.

On `load()`, the AccountingModule filters all tokens in storage by token type to discover invoice tokens. All invoice data (terms, creator, targets, etc.) is read from the token's `genesis.data.tokenData` field.

### 7.2 Termination Storage

Since termination (close/cancel) is local-only (not encoded in the token), per-address keys track terminated invoice IDs and their frozen balances:

Added to `STORAGE_KEYS_ADDRESS` in `constants.ts`:

```typescript
/** Cancelled invoice IDs (JSON string array) */
CANCELLED_INVOICES: 'cancelled_invoices',
/** Explicitly closed invoice IDs (JSON string array) */
CLOSED_INVOICES: 'closed_invoices',
/** Frozen balance snapshots for terminated invoices (JSON map: invoiceId -> FrozenInvoiceBalances) */
FROZEN_BALANCES: 'frozen_balances',
/** Auto-return settings (JSON: AutoReturnSettings) */
AUTO_RETURN: 'auto_return',
/** Auto-return deduplication ledger (JSON: AutoReturnLedger) */
AUTO_RETURN_LEDGER: 'auto_return_ledger',
```

Full key format: `sphere_{addressId}_cancelled_invoices`, etc.

### 7.3 Frozen Balance Schema

```typescript
/**
 * Persisted frozen balance snapshot for a terminated invoice.
 * Stored when an invoice transitions to CLOSED or CANCELLED.
 */
interface FrozenInvoiceBalances {
  /** Terminal state at time of freezing */
  readonly state: 'CLOSED' | 'CANCELLED';
  /** Whether this was an explicit close (true) or implicit (false). Only for CLOSED. */
  readonly explicitClose?: boolean;
  /** Timestamp when balances were frozen */
  readonly frozenAt: number;
  /** Per-target, per-asset balance snapshot */
  readonly targets: FrozenTargetBalances[];
  /** Total forward payments across all targets, keyed by coinId */
  readonly totalForward: Record<string, string>;
  /** Total back/return payments across all targets, keyed by coinId */
  readonly totalBack: Record<string, string>;
  /**
   * Whether all related tokens have confirmed proofs.
   * IMPORTANT: This field is NOT frozen — it is dynamically derived from
   * PaymentsModule on each query. Tokens may be confirmed after termination,
   * and this field reflects the current state, not the state at freeze time.
   * The persisted value serves as a cache hint; the authoritative value
   * comes from checking related token confirmation status at query time.
   */
  readonly allConfirmed: boolean;
}

interface FrozenTargetBalances {
  readonly address: string;
  readonly coinAssets: FrozenCoinAssetBalances[];
}

interface FrozenCoinAssetBalances {
  readonly coin: CoinEntry;
  readonly coveredAmount: string;
  readonly returnedAmount: string;
  readonly netCoveredAmount: string;
  readonly isCovered: boolean;
  readonly surplusAmount: string;
}

// Storage format: Record<string, FrozenInvoiceBalances>
// Key: invoiceId, Value: FrozenInvoiceBalances
type FrozenBalancesStorage = Record<string, FrozenInvoiceBalances>;
```

### 7.4 Auto-Return Storage Schema

```typescript
// Stored under AUTO_RETURN key
interface AutoReturnStorage {
  /** Global auto-return for all terminated invoices */
  global: boolean;
  /** Per-invoice overrides: invoiceId -> enabled. Precedence: perInvoice[id] ?? global */
  perInvoice: Record<string, boolean>;
}
```

### 7.5 Auto-Return Deduplication Ledger

```typescript
// Stored under AUTO_RETURN_LEDGER key
// Tracks which transfers have already been auto-returned, preventing double-returns
// on event re-delivery (Nostr reconnection, retroactive scan, etc.)
interface AutoReturnLedger {
  /**
   * Key: "{invoiceId}:{originalTransferId}"
   * Value: { returnedAt: number, returnTransferId: string }
   *
   * Before executing an auto-return, the module checks this ledger.
   * If the key exists, the return is skipped (already done).
   * After a successful auto-return send(), the entry is written.
   *
   * The full auto-return sequence (within the per-invoice serialization gate):
   * 1. Check ledger for (invoiceId, originalTransferId)
   * 2. If exists -> skip (already returned)
   * 3. Call PaymentsModule.send() to return tokens
   * 4. Write ledger entry
   * 5. Fire 'invoice:auto_returned' event
   *
   * If step 4 fails after step 3 succeeds, the next retry will re-send
   * (PaymentsModule.send() is not idempotent). This is acceptable —
   * a duplicate return is better than a lost return. The recipient sees
   * two return transfers but the accounting balance is correct.
   */
  entries: Record<string, { returnedAt: number; returnTransferId: string }>;
}
```

Added to `STORAGE_KEYS_ADDRESS`:

```typescript
/** Auto-return deduplication ledger (JSON: AutoReturnLedger) */
AUTO_RETURN_LEDGER: 'auto_return_ledger',
```

### 7.6 Storage Operations

```
createInvoice():
  1. tokenStorage.saveToken(invoiceToken)       // TXF token with InvoiceTerms in tokenData
  2. Scan full history for pre-existing payments // retroactive evaluation
  3. If immediately reaches CLOSED (all covered + all confirmed):
     -> freeze balances and persist to FROZEN_BALANCES
  4. Fire events                                 // created + any retroactive events

importInvoice():
  1. tokenStorage.saveToken(invoiceToken)       // same as any received token
  2. Scan full history for pre-existing payments // retroactive evaluation
  3. If immediately reaches CLOSED:
     -> freeze balances and persist
  4. Fire events                                 // any retroactive events

closeInvoice():
  1. Compute current balances one final time
  2. Persist frozen balances to FROZEN_BALANCES storage
  3. Add invoiceId to CLOSED_INVOICES set in storage
  4. If options.autoReturn:
     -> enable auto-return for this invoice
     -> immediately return SURPLUS ONLY (per target:asset, amount exceeding requested)
     -> use :RC memo direction
  5. Fire 'invoice:closed' { explicit: true }
  6. Fire 'invoice:auto_returned' for each surplus return (if any)

cancelInvoice():
  1. Load cancelled set from storage
  2. Compute current balances one final time
  3. Persist frozen balances to FROZEN_BALANCES storage
  4. Add invoiceId to CANCELLED_INVOICES set in storage
  5. If options.autoReturn:
     -> enable auto-return for this invoice
     -> immediately return EVERYTHING (all forward payments received)
     -> use :RX memo direction
  6. Fire 'invoice:cancelled'
  7. Fire 'invoice:auto_returned' for each return (if any)

getInvoiceStatus():
  1. Read token from tokenStorage (parse terms from genesis.data.tokenData)
  2. Check cancelled set and closed set
  3. If terminal -> load frozen balances from FROZEN_BALANCES, return frozen status
  4. Read full history from PaymentsModule (active + sent tokens)
  5. Compute status (pure function)
  6. If just reached implicit CLOSED -> freeze and persist

setAutoReturn():
  1. Load AUTO_RETURN from storage
  2. Update global flag or per-invoice entry
     - Precedence: perInvoice[id] ?? global
     - Setting perInvoice[id] = false overrides global = true for that invoice
  3. Persist to storage
  4. If enabling (enabled=true), trigger immediate auto-return for applicable invoices
     (within per-invoice serialization gate, checking dedup ledger for each):
     - For specific invoiceId: if terminated AND wallet is a target:
       - CLOSED -> return surplus only (per target:asset)
       - CANCELLED -> return everything
     - For '*': iterate all terminated invoices sequentially, each with its own gate:
       - CLOSED -> return surplus only
       - CANCELLED -> return everything
  5. Fire 'invoice:auto_returned' for each return executed

load():
  1. Enumerate tokens from tokenStorage
  2. Filter by tokenType === INVOICE_TOKEN_TYPE_HEX
  3. Parse InvoiceTerms from each token's genesis.data.tokenData
  4. Load cancelled set, closed set, frozen balances, auto-return settings, and dedup ledger from storage
  5. Build in-memory invoice-transfer index (see below)
  6. Subscribe to PaymentsModule events
  7. Scan full history for pre-existing payments -> fire retroactive events
```

#### Performance: In-Memory Invoice-Transfer Index

To avoid scanning the full transaction history on every `getInvoiceStatus()` call, the module maintains an **in-memory index** mapping invoice IDs to their related transfer references:

```typescript
// Built on load(), updated incrementally on each inbound/confirmed event
private invoiceTransferIndex: Map<string, InvoiceTransferRef[]>;
```

- **Built on `load()`:** Full history scan populates the index for all known invoices.
- **Updated incrementally:** Each `transfer:incoming` / `transfer:confirmed` event with an invoice memo adds/updates the entry.
- **Used by `getInvoiceStatus()`:** Instead of re-scanning full history, reads from the index.
- **Invalidated on `createInvoice()` / `importInvoice()`:** A full rescan rebuilds the entry for the new invoice (to catch retroactive payments).
- **Not persisted:** The index is ephemeral — rebuilt from history on each `load()`. This avoids storage synchronization complexity.

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
| Parsed InvoiceTerms must pass full business validation (non-empty targets, valid addresses, positive amounts, no duplicate addresses/coins — same rules as §8.1 CreateInvoiceRequest, except `dueDate` may be in the past for imported invoices) | `INVOICE_INVALID_DATA` |
| Invoice token must not already exist in local TokenStorage | `INVOICE_ALREADY_EXISTS` |

### 8.3 Close Validation

| Rule | Error |
|------|-------|
| Invoice token must exist locally | `INVOICE_NOT_FOUND` |
| Caller must be the creator (`terms.creator === identity.chainPubkey`). For anonymous invoices (`terms.creator` undefined), any party holding the invoice may close it. The creator check uses **all tracked addresses** (`getActiveAddresses()`), not just the current active address. | `INVOICE_NOT_CREATOR` |
| Invoice must not already be CLOSED | `INVOICE_ALREADY_CLOSED` |
| Invoice must not already be CANCELLED | `INVOICE_ALREADY_CANCELLED` |

### 8.4 Cancel Validation

| Rule | Error |
|------|-------|
| Invoice token must exist locally | `INVOICE_NOT_FOUND` |
| If non-anonymous: caller must be the creator (`terms.creator === identity.chainPubkey`). The creator check uses **all tracked addresses** (`getActiveAddresses()`), not just the current active address. For anonymous invoices (`terms.creator` undefined), any party holding the invoice may cancel it. | `INVOICE_NOT_CREATOR` |
| Invoice must not already be CLOSED (computed) | `INVOICE_ALREADY_CLOSED` |
| Invoice must not already be cancelled | `INVOICE_ALREADY_CANCELLED` |

### 8.5 Pay Invoice Validation

| Rule | Error |
|------|-------|
| Invoice token must exist locally | `INVOICE_NOT_FOUND` |
| Invoice must NOT be in a terminal state (CLOSED or CANCELLED) | `INVOICE_TERMINATED` |
| `targetIndex` must be valid | `INVOICE_INVALID_TARGET` |
| `assetIndex` must be valid (if provided) | `INVOICE_INVALID_ASSET_INDEX` |

### 8.6 Return Invoice Payment Validation

| Rule | Error |
|------|-------|
| Invoice token must exist locally | `INVOICE_NOT_FOUND` |
| Caller's wallet address must match one of the invoice targets | `INVOICE_NOT_TARGET` |
| Return amount must not exceed current `netCoveredAmount` for the specified target:coinId (computed from current history for non-terminal, from frozen balances for terminal) | `INVOICE_RETURN_EXCEEDS_BALANCE` |

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
// Returns: InvoiceStatus (computed fresh for non-terminal, frozen for terminal)
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
// BLOCKED if invoice is terminated (CLOSED or CANCELLED)
{
  action: 'pay_invoice',
  params: {
    invoiceId: 'abc123...',
    // Optional overrides (defaults to invoice targets):
    targetIndex: 0,       // which target to pay
    assetIndex: 0,        // which asset within that target
    amount: '500000',     // partial payment (defaults to remaining)
  }
}
// Returns: TransferResult (from PaymentsModule.send())

// close_invoice -- prompts user to confirm closing an invoice
{
  action: 'close_invoice',
  params: {
    invoiceId: 'abc123...',
    autoReturn: true,     // optional: enable auto-return on close
  }
}
// Returns: { success: true }

// cancel_invoice -- prompts user to confirm cancelling an invoice
{
  action: 'cancel_invoice',
  params: {
    invoiceId: 'abc123...',
    autoReturn: true,     // optional: enable auto-return on cancel
  }
}
// Returns: { success: true }
```

### 9.3 New Permission Scopes

```typescript
// Added to PermissionScope type
'invoices:read'          // Read invoices and status
'intent:create_invoice'  // Create invoice intent
'intent:pay_invoice'     // Pay invoice intent
'intent:close_invoice'   // Close invoice intent
'intent:cancel_invoice'  // Cancel invoice intent
```

### 9.4 New Events (Connect push)

```typescript
// dApps can subscribe via client.on(...)
'invoice:payment'        // When a payment matches an invoice
'invoice:covered'        // When an invoice is fully covered
'invoice:closed'         // When an invoice transitions to CLOSED
'invoice:cancelled'      // When an invoice is cancelled
'invoice:irrelevant'     // When a non-matching payment references an invoice
'invoice:auto_returned'  // When tokens are auto-returned for a terminated invoice
'invoice:return_received' // When auto-return tokens are received
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
| `INVOICE_NOT_CREATOR` | Only the creator can close or cancel this invoice | Close/cancel by non-creator (non-anonymous invoices). For anonymous invoices, any holder is allowed. |
| `INVOICE_ALREADY_CLOSED` | Invoice is already closed | Close/cancel after CLOSED |
| `INVOICE_ALREADY_CANCELLED` | Invoice is already cancelled | Close/cancel after CANCELLED |
| `INVOICE_ORACLE_REQUIRED` | Oracle provider required for invoice minting | No oracle configured |
| `INVOICE_TERMINATED` | Cannot pay a terminated invoice (closed or cancelled) | Forward payment to terminated invoice |
| `INVOICE_INVALID_TARGET` | Invalid target index | Out-of-bounds targetIndex in payInvoice |
| `INVOICE_INVALID_ASSET_INDEX` | Invalid asset index | Out-of-bounds assetIndex in payInvoice |
| `INVOICE_NOT_TARGET` | Only invoice target parties can send return payments | Return from non-target wallet address |
| `INVOICE_RETURN_EXCEEDS_BALANCE` | Return amount exceeds net covered balance for this target:coinId | Excessive return |

**IMPORTANT:** All error codes above apply to the accounting module's own operations. Accounting errors during inbound transfer event processing are caught internally and logged — they NEVER propagate to or interrupt the inbound token transfer flow. The one exception is `INVOICE_TERMINATED` for outbound forward payments, which is thrown intentionally to prevent paying a terminated invoice.

---

## Appendix A: File Structure

```
modules/accounting/
+-- AccountingModule.ts    # Main module class
+-- InvoiceMinter.ts       # Invoice token minting (mirrors NametagMinter)
+-- StatusComputer.ts      # Invoice status computation logic
+-- AutoReturnManager.ts   # Auto-return logic for terminated invoices
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
   | fire retroactive events if pre-existing payments|
   |                          |                      |
   | send invoice token ---------------------------> |
   |                          |                      | importInvoice(token)
   |                          |                      | scan history (retroactive)
   |                          |                      | fire retroactive events
   |                          |                      |
   |                          |                      | payInvoice(id, params)
   |<---- token transfer ----------------------------|  (memo: INV:id:F)
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
   | invoice:closed { explicit: false }              |
   | (balances frozen and persisted)                 |
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

Both parties independently compute COVERED -> CLOSED (implicit).
Balances frozen and persisted after CLOSED.
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

## Appendix F: Multi-Asset Token Transfer

```
Invoice abc:
  Target: DIRECT://alice
    - coin: ["UCT", "1000"]
    - coin: ["USDU", "500"]

Time 1: Payer sends a MULTI-ASSET token with
        coinData = [["UCT", "600"], ["USDU", "500"]]
        memo: INV:abc:F
        destination: DIRECT://alice

        -> AccountingModule extracts both coin entries:
           - InvoiceTransferRef { transferId: "tx1", coinId: "UCT", amount: "600" }
           - InvoiceTransferRef { transferId: "tx1", coinId: "USDU", amount: "500" }
        -> UCT: coveredAmount = 600, net = 600 (needs 1000 -- not yet covered)
        -> USDU: coveredAmount = 500, net = 500 (needs 500 -- COVERED)
        -> Fires: invoice:payment (x2, one per coin)
        -> Fires: invoice:asset_covered for USDU
        -> State: PARTIAL (UCT still uncovered)

Time 2: Payer sends another token with coinData = [["UCT", "400"]]
        memo: INV:abc:F
        -> UCT: coveredAmount = 1000, net = 1000 -- COVERED
        -> Fires: invoice:asset_covered for UCT
        -> Fires: invoice:target_covered for alice
        -> Fires: invoice:covered
        -> ... all confirmed -> invoice:closed { explicit: false }
        -> Balances frozen and persisted
```

## Appendix G: Termination and Auto-Return

```
--- Explicit Close with Auto-Return (surplus only) ---

Invoice abc requests 1000 UCT from DIRECT://alice.
Alice has received 1200 UCT via INV:abc:F (200 surplus).

Alice closes invoice (satisfied with payments):
  -> closeInvoice('abc', { autoReturn: true })
  -> Balances frozen: covered=1200, net=1200, surplus=200
  -> Auto-return enabled -> IMMEDIATELY returns 200 UCT surplus
     with memo INV:abc:RC (return-for-closed)
  -> Fires invoice:closed { explicit: true }
  -> Fires invoice:auto_returned (for the 200 surplus)
  NOTE: Only the surplus (200) is returned, not the full 1200.

Later, sender sends 500 UCT with memo INV:abc:F (unaware of closure):
  -> Token transfer succeeds (inbound transfers are NEVER blocked)
  -> Auto-return enabled -> entire 500 UCT returned with INV:abc:RC
     (any new forward payment to a CLOSED invoice is surplus by definition)
  -> Fires invoice:auto_returned

Sender receives the auto-return (INV:abc:RC):
  -> Fires invoice:return_received { returnReason: 'closed' }
  -> If autoTerminateOnReturn is true:
     -> Sender's module auto-closes invoice abc locally

--- Cancellation with Auto-Return (everything) ---

Invoice abc requests 1000 UCT from DIRECT://alice.
Alice has received 600 UCT via INV:abc:F (no surplus, partially covered).

Alice cancels invoice (abandoning the deal):
  -> cancelInvoice('abc', { autoReturn: true })
  -> Balances frozen: covered=600, net=600
  -> Auto-return enabled -> IMMEDIATELY returns ALL 600 UCT
     with memo INV:abc:RX (return-for-cancelled)
  -> Fires invoice:cancelled
  -> Fires invoice:auto_returned (for the full 600)
  NOTE: Everything is returned, not just surplus.

Later, sender sends 500 UCT with memo INV:abc:F (unaware of cancellation):
  -> Token transfer succeeds (inbound NEVER blocked)
  -> Auto-return -> entire 500 UCT back with memo INV:abc:RX
  -> Fires invoice:auto_returned

Sender receives the auto-return (INV:abc:RX):
  -> Fires invoice:return_received { returnReason: 'cancelled' }
  -> Sender's module MAY auto-cancel invoice abc locally

--- Manual Return (Always Allowed, Target Only) ---

At any time, an invoice TARGET can return tokens:
  -> returnInvoicePayment('abc', { recipient, amount, coinId })
  -> Sends with memo INV:abc:B
  -> This is independent of auto-return settings
  -> Works for both terminated and non-terminated invoices
  -> NON-TARGET parties CANNOT return (throws INVOICE_NOT_TARGET)

--- Outbound Forward Payment Blocking ---

After sender's invoice abc is locally CLOSED or CANCELLED:
  -> payInvoice('abc', ...) -> throws INVOICE_TERMINATED
  -> The token transfer does NOT happen
  -> Caller must handle the error (show UI message, etc.)

--- Enabling Auto-Return After Termination ---

If auto-return was NOT enabled at termination time, it can be enabled later:
  -> setAutoReturn('abc', true)
  -> Triggers immediate auto-return for invoice abc:
     - If CLOSED: returns surplus only
     - If CANCELLED: returns everything
  -> Also enables ongoing auto-return for future incoming payments

Global enable:
  -> setAutoReturn('*', true)
  -> Triggers immediate auto-return for ALL terminated invoices
     where wallet is a target
  -> Also enables ongoing auto-return for all future terminated invoices
```

## Appendix H: Auto-Return Loop Prevention

```
Auto-return is specifically designed to prevent infinite loops:

1. Only FORWARD payments (:F) are auto-returned.
2. Return payments (:B, :RC, :RX) are NEVER auto-returned.

Example:
  Alice closes invoice, enables auto-return.
  Bob sends 500 UCT with INV:abc:F -> Alice auto-returns with INV:abc:RC
  Bob receives INV:abc:RC -> this is a RETURN, not auto-returned
  -> No loop. Bob sees the return and knows the invoice is closed.

Even if Bob has auto-return enabled on his side:
  Bob's auto-return only triggers on incoming :F payments.
  The :RC payment Bob receives is NOT :F, so it is NOT auto-returned.
  -> Still no loop.
```

## Appendix I: Target-Only Return Restriction

```
Invoice abc:
  Target: DIRECT://alice (requests 1000 UCT)

Bob (payer, NOT a target):
  -> payInvoice('abc', ...) with INV:abc:F -> OK (anyone can make forward payments)
  -> returnInvoicePayment('abc', ...) -> throws INVOICE_NOT_TARGET
     (Bob's address doesn't match any invoice target)

Alice (target):
  -> returnInvoicePayment('abc', ...) with INV:abc:B -> OK (alice IS a target)
  -> Auto-return also works for Alice (she is a target)

This restriction ensures that only the party who received tokens for an
invoice can return them. Non-targets have no tokens to return and no
authority to affect the invoice balance via return payments.
```
