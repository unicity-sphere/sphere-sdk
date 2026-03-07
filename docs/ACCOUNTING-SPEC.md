# Accounting Module Specification

> **Status:** Draft specification — no code yet
> **Companion:** [ACCOUNTING-ARCHITECTURE.md](./ACCOUNTING-ARCHITECTURE.md)

## Table of Contents

1. [Types](#1-types)
2. [Module API](#2-module-api)
3. [Invoice Minting](#3-invoice-minting)
4. [Invoice Reference Encoding](#4-invoice-reference-encoding)
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
   * This field is informational only — it does not gate any authorization.
   * All explicit close/cancel authorization is target-based.
   */
  readonly creator?: string;
  /**
   * Creation timestamp (ms). Set to the creator's local clock at mint time
   * (Date.now() when createInvoice() is called), NOT the aggregator's timestamp.
   * The aggregator inclusion proof has its own timestamp for ordering.
   * This field is informational — used for display and dueDate calculations.
   */
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
   * Anonymous invoices follow the same authorization: only targets can close or cancel.
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
 * Balance breakdown for a single sender contributing to a target:coinId.
 * Tracks how much this sender has forwarded and how much has been returned to them.
 */
interface InvoiceSenderBalance {
  /** Sender's DIRECT:// address */
  readonly senderAddress: string;
  /** Sender's chain pubkey (if known) */
  readonly senderPubkey?: string;
  /** Sender's nametag (if known) */
  readonly senderNametag?: string;
  /** Total forwarded by this sender for this target:coinId */
  readonly forwardedAmount: string;
  /** Total returned to this sender for this target:coinId (includes :B, :RC, :RX) */
  readonly returnedAmount: string;
  /** Net balance: max(0, forwardedAmount - returnedAmount) — the max returnable to this sender */
  readonly netBalance: string;
}

/**
 * Detailed status of a single coin asset within a target.
 *
 * Balance formula:
 *   coveredAmount = sum of all forward payment amounts referencing this invoice for this target:coinId
 *   returnedAmount = sum of all back/return payment amounts referencing this invoice for this target:coinId
 *                    (includes :B, :RC, and :RX directions)
 *   netCoveredAmount = max(0, coveredAmount - returnedAmount)   // defensive floor; validation prevents negative
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
  /** Net covered = coveredAmount - returnedAmount (validation ensures non-negative; max(0,...) as defensive floor) */
  readonly netCoveredAmount: string;
  /** Whether requested amount is fully met (netCovered >= requested) */
  readonly isCovered: boolean;
  /** Surplus amount if overpaid (netCovered - requested), '0' if not overpaid */
  readonly surplusAmount: string;
  /** Whether all related tokens are confirmed (full proof chain) */
  readonly confirmed: boolean;
  /** Individual transfers contributing to this asset */
  readonly transfers: InvoiceTransferRef[];
  /** Per-sender balance breakdown for this target:coinId */
  readonly senderBalances: InvoiceSenderBalance[];
}

/**
 * Status of a single NFT line item (placeholder — not implemented in v1).
 * In v1, `received` is always `false` and `confirmed` is always `false`.
 * NFT coverage is excluded from the target `isCovered` check until NFT
 * matching logic is implemented. The `isCovered` computation in §5.1 step 6
 * considers only coin assets in v1.
 */
interface InvoiceNFTAssetStatus {
  /** The NFT entry from the invoice target */
  readonly nft: NFTEntry;
  /** Whether the NFT has been received (always false in v1) */
  readonly received: boolean;
  /** Whether the received token is confirmed (always false in v1) */
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
  /** Sender's DIRECT:// address (derived from senderPubkey).
   *  Null if the sender's predicate is masked (owner hidden on-chain).
   *  Transfers with null senderAddress cannot participate in self-payment
   *  detection or return matching — they are indexed but treated as
   *  having an unknown sender for balance purposes. */
  readonly senderAddress: string | null;
  /** Sender chain pubkey (null if predicate is masked) */
  readonly senderPubkey?: string | null;
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
  /**
   * Whether ALL related tokens are confirmed.
   * ALWAYS dynamically derived from PaymentsModule — never stored.
   * For terminal invoices, this is computed by checking related token
   * confirmation status at query time, not frozen at termination.
   * This ensures tokens confirmed after termination are reflected.
   */
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
  /** Sort order. When sortBy is 'dueDate', invoices without a dueDate sort last (null-last). */
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
  /** Whether this invoice has been locally closed (explicitly or implicitly via all-covered+confirmed) */
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
   *
   * NOTE: This is a construction-time config, NOT persisted to storage.
   * The value is set when `createAccountingModule()` is called and remains
   * fixed for the lifetime of the module instance. Changing this setting
   * requires restarting the module with a new config.
   */
  autoTerminateOnReturn?: boolean;
  /**
   * Maximum number of coinData entries processed per token transaction.
   * Defense against adversarial tokens with thousands of coin types.
   * Default: 50. In practice, tokens carry 1-3 coin types.
   */
  maxCoinDataEntries?: number;
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
  /** Oracle for minting invoice tokens (also provides stateTransitionClient via getStateTransitionClient()) */
  oracle: OracleProvider;
  /**
   * Trust base for aggregator proof verification.
   * Required by waitInclusionProof() and Token.mint() during invoice minting.
   * Follows the same pattern as NametagMinterConfig.trustBase.
   * Obtained via the oracle/aggregator configuration at init time.
   */
  trustBase: unknown;
  /** Current wallet identity */
  identity: FullIdentity;
  /** All tracked wallet addresses — used for target check in close/cancel/return.
   *  Target validation compares TrackedAddress.directAddress against
   *  InvoiceTarget.address (both are DIRECT:// format). Checks all HD addresses,
   *  not just the current one. */
  getActiveAddresses: () => TrackedAddress[];
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
   * Because state filtering requires async status computation, this method
   * is async.
   *
   * Pagination: offset and limit are applied AFTER all filters (state,
   * createdByMe, targetingMe). offset=10 means skip the first 10 invoices
   * that pass all filters. Implementations MAY optimize terminal-state
   * filtering by reading directly from the in-memory cancelled/closed sets
   * without full status recomputation.
   *
   * @param options - Filter/sort/pagination options
   * @returns Array of InvoiceRef objects
   */
  async getInvoices(options?: GetInvoicesOptions): Promise<InvoiceRef[]>;

  /**
   * Get a single invoice by token ID. Synchronous — cancelled/closed sets
   * are kept in memory after load(), so no async storage reads are needed.
   *
   * @param invoiceId - The invoice token ID
   * @returns InvoiceRef or null if not found
   */
  getInvoice(invoiceId: string): InvoiceRef | null;

  /**
   * Explicitly close an invoice. Signals that a target party is satisfied
   * with the current payment state — no more payments needed.
   * Only target parties may close.
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
   * @throws SphereError with INVOICE_NOT_TARGET if caller is not a target party
   * @throws SphereError if not found, already closed, or already cancelled
   */
  async closeInvoice(invoiceId: string, options?: { autoReturn?: boolean }): Promise<void>;

  /**
   * Cancel an invoice. Only target parties can cancel.
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
   * @param invoiceId - The invoice token ID
   * @param options - Optional: { autoReturn?: boolean } — enable auto-return on cancel
   * @throws SphereError with INVOICE_NOT_TARGET if caller is not a target party
   * @throws SphereError if not found, already closed, or already cancelled
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
   * The terminal-state check acquires the per-invoice gate to prevent TOCTOU
   * races with concurrent implicit close. The gate is released before send().
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
   * RETURN CAP: The return amount is capped at the per-sender net balance for
   * the (target=caller's address, sender=params.recipient, coinId=params.coinId)
   * tuple. This is the total amount params.recipient has forwarded to this
   * target for this coinId, minus any amounts already returned to them.
   * A target cannot return more to a sender than that sender originally sent.
   * Throws INVOICE_RETURN_EXCEEDS_BALANCE if the amount exceeds this cap.
   *
   * @param invoiceId - The invoice token ID
   * @param params - { recipient, amount, coinId, freeText? }
   * @returns TransferResult from PaymentsModule.send()
   * @throws SphereError with INVOICE_NOT_TARGET if wallet is not an invoice target
   * @throws SphereError with INVOICE_RETURN_EXCEEDS_BALANCE if amount exceeds per-sender net balance
   */
  async returnInvoicePayment(invoiceId: string, params: ReturnPaymentParams): Promise<TransferResult>;

  /**
   * Enable or disable auto-return for terminated invoices.
   *
   * When auto-return is enabled, two things happen:
   *
   * 1. **Immediate trigger:** If the invoice (or any terminated invoice for '*')
   *    is already terminated, auto-return is executed immediately:
   *    - CLOSED invoice: return the SURPLUS ONLY to the latest sender per
   *      (target, coinId) — the sender whose forward payment for that tuple
   *      triggered closure (see §5.2). Pre-closure payments are accepted as
   *      final (non-returnable). If no surplus exists for a given target:coinId,
   *      nothing is returned for that pair.
   *    - CANCELLED invoice: return EVERYTHING — each sender gets back their full
   *      per-sender net balance.
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
   * Irrelevant transfers are returned as IrrelevantTransfer (extends InvoiceTransferRef
   * with a `reason` field). Callers can discriminate using `'reason' in transfer`.
   *
   * @param invoiceId - The invoice token ID
   * @returns (InvoiceTransferRef | IrrelevantTransfer)[] sorted by timestamp
   */
  getRelatedTransfers(invoiceId: string): (InvoiceTransferRef | IrrelevantTransfer)[];

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
   *
   * Sequence:
   * 1. Set internal `destroyed` flag (FIRST — prevents new operations immediately)
   * 2. Unsubscribe from all PaymentsModule events (prevents new event-driven entries)
   * 3. Await the current promise-chain tail for ALL active gate entries
   *    (captures the map snapshot at flag-set time)
   *
   * The `destroyed` flag is checked in TWO places:
   * - At the TOP of every PUBLIC METHOD (getInvoiceStatus, payInvoice,
   *   closeInvoice, cancelInvoice, returnInvoicePayment, setAutoReturn).
   *   If set, the method throws immediately without entering the gate.
   * - At the TOP of every gate `fn` body. If set, the fn returns immediately
   *   without storage writes (catches operations queued before flag was set).
   *
   * Setting the flag BEFORE unsubscribing (step 1 before step 2) closes the
   * race window where a direct API call could enter the gate between unsubscribe
   * and flag-set. The `withInvoiceGate()` helper also rejects immediately if
   * `destroyed` is true, before chaining onto the promise — preventing new
   * operations from extending the gate tail after step 3's snapshot.
   *
   * Net guarantee: after destroy() resolves, no further storage writes will
   * occur from any source. Direct API calls after destroy throw immediately.
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
  /** Payment direction (matches InvoiceTransferRef.paymentDirection values) */
  readonly paymentDirection: 'forward' | 'back' | 'return_closed' | 'return_cancelled';
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

The invoice token ID is derived deterministically from the invoice content, ensuring that the same invoice parameters always produce the same token ID (enabling idempotent re-minting). **Known constraint:** Two `createInvoice()` calls with identical parameters in the same millisecond are treated as the same invoice (idempotent). To create distinct invoices with identical terms, callers must ensure at least 1ms separation or include distinguishing text in the `memo` field.

```typescript
// Deterministic token ID from canonical invoice terms
const terms: InvoiceTerms = {
  creator: request.anonymous ? undefined : identity.chainPubkey,
  createdAt: Date.now(),
  dueDate: request.dueDate,
  memo: request.memo,
  deliveryMethods: request.deliveryMethods,
  targets: request.targets,
};
const invoiceBytes = canonicalSerialize(terms);
const hash = await new DataHasher(HashAlgorithm.SHA256).update(invoiceBytes).digest();
const tokenId = new TokenId(hash.imprint);
```

### 3.2 Minting Flow (Mirrors NametagMinter)

> **Factory method:** `MintTransactionData.create()` is the general-purpose factory
> (accepts arbitrary `tokenData: Uint8Array | null` and `coinData: TokenCoinData | null`).
> This is distinct from `MintTransactionData.createFromNametag()` which is a convenience
> wrapper for nametag tokens only. Invoice minting uses `create()` because it carries
> arbitrary `InvoiceTerms` in `tokenData`, not a nametag string.

```
Step  Action                                SDK Class
----  ------                                ---------
1     Validate CreateInvoiceRequest         AccountingModule
2     Build InvoiceTerms (optionally add    AccountingModule
      creator pubkey, add createdAt)
3     Canonical serialize InvoiceTerms      AccountingModule
4     Generate deterministic salt           SHA-256(signingKey || invoiceBytes)
5     Create MintTransactionData            MintTransactionData.create()
      - tokenType: INVOICE_TOKEN_TYPE_HEX
      - tokenData: serialized InvoiceTerms
      - coinData: null (non-fungible — null, not empty array)
      - recipient: creator's DirectAddress
6     Create MintCommitment                 MintCommitment.create()
7     Submit to aggregator (3 retries)      client.submitMintCommitment()
      - SUCCESS -> continue
      - REQUEST_ID_EXISTS -> continue (idempotent re-mint by same wallet).
        NOTE: REQUEST_ID_EXISTS only returns a success status, NOT the original
        inclusion proof. A different wallet cannot obtain a usable proof by
        guessing invoice terms — they would need the original minter's proof.
8     Wait for inclusion proof              waitInclusionProof()
9     Create genesis transaction            commitment.toTransaction()
10    Create UnmaskedPredicate + TokenState  UnmaskedPredicate.create()
11    Create Token (with or without          Token.mint() or Token.fromJSON()
      verification based on config)
12    Store token via TokenStorageProvider   tokenStorage.saveToken()
13    Scan history for pre-existing payments  AccountingModule
      via processTokenTransactions() (§5.4.3)
14    Fire 'invoice:created' event +        emitEvent()
      retroactive payment/coverage events
```

**Privacy note on anonymous invoices:** Even when `creator` is omitted, the minting process uses the minter's signing key for salt derivation (step 4) and sets the minter's DirectAddress as the `recipient` in the genesis data (step 5). This means the minter's identity is still embedded in the token's on-chain data. Additionally, since `salt = SHA-256(signingKey || invoiceBytes)` uses a constant signing key, any observer who can see multiple invoice tokens on-chain can determine whether two invoices were created by the same wallet by testing candidate keys against the salt — the salt is a cross-invoice linkability vector. However, this vector is **strictly dominated** by the `recipient` field exposure — the recipient DirectAddress directly identifies the minter without any brute-forcing. The salt linkability is therefore redundant with existing exposure. True anonymity would require changing BOTH the recipient strategy AND salt derivation (random nonce). For v1, "anonymous" means the `creator` field is absent from `InvoiceTerms` (informational only), not that the minter's on-chain identity is hidden.

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

**Security note on `creator` field:** The `creator` field in InvoiceTerms is **self-asserted** — the minter can set it to any pubkey. The aggregator does not verify that the `creator` matches the minting key. This means a malicious party could mint an invoice claiming to be someone else. Import validation (§8.2) does NOT verify creator identity against the minting key because the minting key is not exposed in the token's genesis data. Applications requiring verified creator identity should use out-of-band verification (e.g., the invoice token is received directly from the claimed creator via authenticated transport). The `creator` field is **informational only** — it identifies the invoice creator but does not gate any authorization. All explicit close/cancel authorization is target-based (see §2.1 `closeInvoice()` and `cancelInvoice()`).

InvoiceTerms must be serialized deterministically (same input -> same bytes) for consistent token ID derivation:

```typescript
function canonicalSerialize(terms: InvoiceTerms): Uint8Array {
  // Sort targets by address (lexicographic)
  // Within each target, sort assets: coins first (sorted by coinId), then NFTs (sorted by tokenId)
  // Build sorted targets (address lexicographic, coins before NFTs within each target)
  const sortedTargets = [...terms.targets]
    .sort((a, b) => a.address.localeCompare(b.address))
    .map(t => ({
      address: t.address,
      assets: [...t.assets].sort((a, b) => {
        if (a.coin && b.coin) return a.coin[0].localeCompare(b.coin[0]);
        if (a.nft && b.nft) return a.nft.tokenId.localeCompare(b.nft.tokenId);
        return a.coin ? -1 : 1; // coins first
      }),
    }));

  // Keys MUST be inserted in strict alphabetical order.
  // The normative key order is: createdAt, [creator], deliveryMethods, dueDate, memo, targets.
  // `creator` is conditionally included (omitted for anonymous invoices).
  // Other optional fields use `null` normalization (always present).
  // Any reimplementation MUST produce this exact key order.
  const sorted: Record<string, unknown> = { createdAt: terms.createdAt };
  if (terms.creator !== undefined) {
    sorted.creator = terms.creator; // inserted between createdAt and deliveryMethods
  }
  // Normalize empty array to null for canonical equivalence:
  // deliveryMethods: [] and deliveryMethods: undefined produce the same serialization.
  sorted.deliveryMethods = (terms.deliveryMethods?.length ? terms.deliveryMethods : null);
  sorted.dueDate = terms.dueDate ?? null;
  sorted.memo = terms.memo ?? null;
  sorted.targets = sortedTargets;
  // NOTE: JSON.stringify preserves insertion order of object keys in all
  // modern JS engines (V8, SpiderMonkey, JSC) per ES2015+ spec. The `sorted`
  // object above uses alphabetical key insertion order to ensure determinism.
  // This is safe for all SDK target environments (Node.js >= 18, modern browsers).
  // PORTABILITY: All InvoiceTerms field names are semantic strings (not integer-
  // like), so ES2015+ [[OwnPropertyKeys]] numeric-first ordering cannot reorder
  // them. If a future field with an integer-like name is ever added, it would
  // break canonical ordering on all engines. Future maintainers: do not add
  // fields with numeric names. For maximum cross-environment safety, an
  // implementation MAY use a deterministic JSON serializer library (e.g.,
  // json-stable-stringify) instead of relying on insertion order.
  return new TextEncoder().encode(JSON.stringify(sorted));
}
```

---

## 4. Invoice Reference Encoding

Invoice references are recorded in **two places** for every invoice-related transfer:

1. **On-chain (primary, authoritative):** The `TransferTransactionData.message` field in the token's proof chain carries a structured `TransferMessagePayload`. This is embedded in the aggregator's Sparse Merkle Tree and is verifiable. The accounting module reads invoice references from token transaction histories.

2. **Transport memo (secondary, display):** The `TransferRequest.memo` field carried via Nostr transport uses the `INV:` text format. This provides human-readable context and backward compatibility. It is NOT the authoritative source for invoice linking.

### 4.1 On-Chain Format: TransferMessagePayload (Primary)

The `TransferTransactionData.message` field (`Uint8Array | null`) carries a UTF-8 encoded JSON payload:

```typescript
/**
 * Structured payload for the on-chain TransferTransactionData.message field.
 * This is the AUTHORITATIVE source for linking a token transfer to an invoice.
 *
 * Encoding: new TextEncoder().encode(JSON.stringify(payload))
 * Decoding: JSON.parse(new TextDecoder().decode(messageBytes))
 *
 * The `inv` field is RESERVED for invoice references. Other fields may be
 * added in future versions. Unknown fields MUST be ignored by parsers.
 */
interface TransferMessagePayload {
  /** Invoice reference (present only for invoice-related transfers) */
  readonly inv?: {
    /** Invoice token ID (64-char hex, lowercase) */
    readonly id: string;
    /** Direction code: F=forward, B=back, RC=return-closed, RX=return-cancelled */
    readonly dir: 'F' | 'B' | 'RC' | 'RX';
  };
  /** Human-readable text (optional, max 256 code points) */
  readonly txt?: string;
}
```

**Encoding:**

```typescript
function encodeTransferMessage(payload: TransferMessagePayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}
```

**Decoding from TxfTransaction:**

```typescript
function decodeTransferMessage(txfTransaction: TxfTransaction): TransferMessagePayload | null {
  const messageHex = (txfTransaction.data as any)?.message;
  if (!messageHex || typeof messageHex !== 'string') return null;
  try {
    const bytes = hexToBytes(messageHex);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    // Type-guard the inv field: id must be string, dir must be string (if present).
    // A malicious memo could pass JSON.parse but contain wrong types
    // (e.g., { inv: { id: 123, dir: true } }). Reject non-string fields.
    if (parsed.inv) {
      // Structural type guard: reject non-object, arrays, null
      if (typeof parsed.inv !== 'object' || parsed.inv === null || Array.isArray(parsed.inv)) {
        return null;
      }
      // Field type guards: id must be string, dir must be string (if present)
      if (typeof parsed.inv.id !== 'string' || (parsed.inv.dir !== undefined && typeof parsed.inv.dir !== 'string')) {
        return null; // malformed inv shape — treat as no invoice reference
      }
      // Normalize id to lowercase before validation — matches parseInvoiceMemo()
      // behavior. Without this, an on-chain message with uppercase hex would fail
      // validation here, causing the fallback to the transport memo to activate
      // with a different authority source (split-brain indexing risk).
      parsed.inv.id = parsed.inv.id.toLowerCase();
      // Format validation: id must be 64-char lowercase hex, dir must be known value
      if (!/^[0-9a-f]{64}$/.test(parsed.inv.id)) {
        return null; // invalid invoice ID format
      }
      if (parsed.inv.dir !== undefined && !['F', 'B', 'RC', 'RX'].includes(parsed.inv.dir)) {
        return null; // unknown direction code
      }
    }
    // Truncate inbound txt to 1024 code points to bound index cache and
    // event payload size. Outbound is capped at 256 by buildInvoiceMemo(),
    // but inbound messages from untrusted senders may be arbitrarily long.
    if (parsed.txt && typeof parsed.txt === 'string') {
      parsed.txt = Array.from(parsed.txt).slice(0, 1024).join('');
    }
    return parsed;
  } catch {
    return null; // malformed or non-JSON message — treat as no invoice reference
  }
}
```

**Validation:** The `inv.id` field MUST be a 64-char lowercase hex string. The `inv.dir` field MUST be one of `'F'`, `'B'`, `'RC'`, `'RX'`. Payloads failing validation are treated as non-invoice transfers (no error thrown, silently ignored).

**On-chain / transport disagreement:** When both the on-chain message and the transport memo contain invoice references, the on-chain reference is authoritative (§4.8). The transport memo is ignored for balance computation. If the two disagree (different invoiceId or direction), no error is raised — the on-chain reference wins silently. This can happen if a sender modifies the transport memo after constructing the on-chain commitment, or if a relay replays a stale transport message.

### 4.2 Direction Codes

| Code | Constant | Meaning | Balance effect | Auto-returnable | Who can send |
|------|----------|---------|----------------|-----------------|--------------|
| `F` | `'forward'` | Forward payment towards covering the invoice | +coveredAmount | Yes | Anyone |
| `B` | `'back'` | Manual return/refund | +returnedAmount | **No** | **Target only** |
| `RC` | `'return_closed'` | Auto-return because invoice is closed | +returnedAmount | **No** | **Target only** |
| `RX` | `'return_cancelled'` | Auto-return because invoice is cancelled | +returnedAmount | **No** | **Target only** |

All return directions (`B`, `RC`, `RX`) have the same effect on balance computation — they increase `returnedAmount`. The distinction is semantic.

**Sender restriction:** Only a party whose wallet address matches one of the invoice targets may send return payments (`B`, `RC`, `RX`). Non-target parties can only make forward payments (`F`). The `returnInvoicePayment()` method and auto-return system enforce this with `INVOICE_NOT_TARGET`.

### 4.3 Transport Memo Format (Secondary)

The Nostr transport memo uses a text format for human-readable display and backward compatibility with pre-accounting-module transfers:

```
invoice-memo  = "INV:" invoice-id [ ":" direction ] [ " " free-text ]
invoice-id    = 64HEXDIG
direction     = "F" / "B" / "RC" / "RX"
free-text     = *CHAR
```

### 4.4 Transport Memo Regex

```typescript
const INVOICE_MEMO_REGEX = /^INV:([0-9a-fA-F]{64})(?::(F|B|RC|RX))?(?: (.+))?$/;
```

### 4.5 Transport Memo Parsing

```typescript
function parseInvoiceMemo(memo: string): InvoiceMemoRef | null {
  const match = memo.match(INVOICE_MEMO_REGEX);
  if (!match) return null;

  let direction: InvoiceMemoRef['paymentDirection'];
  switch (match[2]) {
    case 'B':  direction = 'back'; break;
    case 'RC': direction = 'return_closed'; break;
    case 'RX': direction = 'return_cancelled'; break;
    default:   direction = 'forward'; break; // F or omitted
  }

  // Invoice IDs are always stored and compared in lowercase hex.
  // TokenId constructor produces lowercase hex via DataHasher; this normalization ensures
  // that case-insensitive memo input matches storage lookups.
  // Truncate inbound freeText to 1024 code points. buildInvoiceMemo() caps
  // outbound at 256, but inbound memos from untrusted senders may be
  // arbitrarily long. Truncation bounds index cache and event payload size.
  const rawFreeText = match[3] || undefined;
  const freeText = rawFreeText
    ? Array.from(rawFreeText).slice(0, 1024).join('')
    : undefined;

  return {
    invoiceId: match[1].toLowerCase(),
    paymentDirection: direction,
    freeText,
  };
}
```

### 4.6 Constructing Invoice Memos

```typescript
const INVOICE_ID_REGEX = /^[0-9a-fA-F]{64}$/;

function buildInvoiceMemo(
  invoiceId: string,
  direction: 'forward' | 'back' | 'return_closed' | 'return_cancelled' = 'forward',
  freeText?: string
): string {
  // MUST validate invoiceId format to prevent memo injection
  if (!INVOICE_ID_REGEX.test(invoiceId)) {
    throw new SphereError('INVOICE_INVALID_ID', 'Invoice ID must be a 64-char hex string');
  }
  const dirMap = {
    forward: ':F',
    back: ':B',
    return_closed: ':RC',
    return_cancelled: ':RX',
  };
  // Strip newlines from freeText to prevent memo injection via line splitting
  // Enforce max length to prevent storage amplification via memo-referenced history
  // Use Array.from() to split on code points (not UTF-16 code units) to avoid
  // splitting surrogate pairs for astral plane characters (emoji, CJK, etc.)
  const sanitized = freeText
    ? Array.from(freeText.replace(/[\r\n]/g, ' ')).slice(0, 256).join('')
    : undefined;
  const text = sanitized ? ` ${sanitized}` : '';
  return `INV:${invoiceId}${dirMap[direction]}${text}`;
}
```

### 4.7 Integration with PaymentsModule.send()

**PaymentsModule.send() MUST be modified** to encode the `TransferRequest.memo` into BOTH the Nostr transport payload AND the on-chain `TransferTransactionData.message` field. Currently, `TransferCommitment.create()` always receives `null` for the `message` parameter — this must change.

> **NOTE:** The upstream `@unicitylabs/state-transition-sdk` **already supports** the
> `message: Uint8Array | null` parameter on `TransferCommitment.create()`. The actual
> signature is `(token, recipient, salt, recipientDataHash, message, signingService)`.
> No upstream SDK change is required — the work is entirely within sphere-sdk's
> `PaymentsModule.createSdkCommitment()` and related transfer paths, which currently
> pass `null` for the `message` parameter.

**Required change to PaymentsModule.send():**

```typescript
// BEFORE (current code — message parameter always null):
const commitment = await TransferCommitment.create(
  sdkToken, recipientAddress, salt,
  null,  // recipientDataHash
  null,  // message (unused — always null currently)
  signingService
);

// AFTER (required change — encode memo into on-chain message):
// For invoice-related transfers, the memo contains the INV: text format.
// The on-chain message carries a structured JSON TransferMessagePayload.
// PaymentsModule.send() must detect invoice memos and encode accordingly:
const payload = parseInvoiceMemoForOnChain(request.memo);
// parseInvoiceMemoForOnChain returns:
//   - TransferMessagePayload JSON bytes if memo is INV: format
//   - null if no memo or if memo is non-invoice (non-invoice memos stay
//     transport-only to preserve privacy)
const messageBytes = payload;
const commitment = await TransferCommitment.create(
  sdkToken, recipientAddress, salt,
  null,  // recipientDataHash
  messageBytes,  // ← now carries the memo on-chain
  signingService
);
```

**`parseInvoiceMemoForOnChain()` helper (in PaymentsModule):**

```typescript
function parseInvoiceMemoForOnChain(memo: string | undefined): Uint8Array | null {
  if (!memo) return null;
  const ref = parseInvoiceMemo(memo);
  if (ref) {
    // Invoice-related: encode as structured TransferMessagePayload
    const dirMap = { forward: 'F', back: 'B', return_closed: 'RC', return_cancelled: 'RX' } as const;
    const payload: TransferMessagePayload = {
      inv: { id: ref.invoiceId, dir: dirMap[ref.paymentDirection] },
      ...(ref.freeText ? { txt: ref.freeText } : {}),
    };
    return new TextEncoder().encode(JSON.stringify(payload));
  }
  // Non-invoice memo: DO NOT encode on-chain.
  // Only invoice-related memos are written to the on-chain message field.
  // Non-invoice memos remain transport-only (Nostr) to avoid leaking
  // private user text into the permanent on-chain record.
  return null;
}
```

**This change applies to ALL transfer paths in PaymentsModule:**
- `PaymentsModule.createTransferCommitment()` (direct send)
- `TokenSplitExecutor.execute()` (split-and-send)
- `InstantSplitExecutor.createTransferCommitmentFromMintData()` (V5 instant split)

**The accounting module constructs memos for both channels:**

```typescript
// For payInvoice() and auto-return, the module constructs:
const payload: TransferMessagePayload = {
  inv: { id: invoiceId, dir: 'F' },
  txt: freeText,  // optional human-readable text
};
const memo = buildInvoiceMemo(invoiceId, 'forward', freeText);  // for Nostr display

await this.deps.payments.send({
  recipient: invoiceTarget.address,
  amount: invoiceAsset.coin![1],
  coinId: invoiceAsset.coin![0],
  // memo carries BOTH the INV: text format (for Nostr transport display)
  // AND the structured payload is encoded via PaymentsModule.send() into
  // TransferTransactionData.message (for on-chain proof chain).
  // PaymentsModule.send() encodes request.memo → message bytes.
  memo: buildInvoiceMemo(invoiceId, 'forward', freeText),
});
```

**Backward compatibility:** Transfers made before this change have `message: null` in their on-chain data. The accounting module MUST fall back to `HistoryRecord.memo` (Nostr transport) when `TxfTransaction.data.message` is null or unparseable. See §5.4.3 for the fallback logic.

**Legacy fallback join:** To match a `TxfTransaction` to its corresponding `HistoryRecord` for the legacy fallback, `processTokenTransactions()` must build a lookup map from `PaymentsModule.getHistory()` keyed by `(tokenId, transactionIndex)`. `HistoryRecord` entries contain a `tokenId` field and can be correlated by position in the token's transaction chain. This join is built once during `load()` and updated incrementally from `history:updated` events.

### 4.8 Reference Resolution Priority

When resolving invoice references for a transfer, the accounting module uses this priority:

1. **On-chain `TransferTransactionData.message`** — decode `TransferMessagePayload`, check `inv` field. This is the authoritative source because it is embedded in the cryptographic proof chain and verifiable against the aggregator's SMT root.
2. **Fallback: `HistoryRecord.memo`** — parse `INV:` format via `parseInvoiceMemo()`. Used only when the on-chain message is null (legacy pre-change transfers) or unparseable.
3. If neither source contains an invoice reference, the transfer is not invoice-related.

### 4.9 Security

- **On-chain references are tamper-evident.** The `TransferTransactionData.message` is included in the transaction data hash committed to the aggregator. Modifying it would invalidate the inclusion proof.
- **Invoice ID validation:** Only 64-char lowercase hex strings are accepted. Guaranteed by SHA-256 token ID derivation.
- **Direction code enforcement:** Only `F`, `B`, `RC`, `RX` are recognized. Unrecognized values cause the reference to be ignored.
- **Sender validation for returns:** Inbound `B`/`RC`/`RX` transfers are validated against invoice target addresses (see §6.2 step 3).
- **Self-payment exclusion:** Forward payments where sender == destination == target are excluded (see §5.2). **Limitation (Sybil):** Self-payment detection is per-address only — it does not prevent a target from creating a second wallet (different HD address or different mnemonic) and fabricating forward payments from that wallet. Cross-wallet self-payment detection is impossible in a privacy-preserving system. Applications requiring verified external payments should use out-of-band identity verification or trusted intermediaries.
- **Untrusted string sanitization:** `txt` field in `TransferMessagePayload`, `InvoiceTerms.memo`, `deliveryMethods` URLs, and `senderNametag`/`recipientNametag` in `InvoiceTransferRef` contain untrusted user input. Applications MUST sanitize before HTML/DOM rendering. React (JSX) provides automatic escaping; other contexts must apply their own.
- Applications MUST use the SDK's decoding functions — never parse on-chain messages or transport memos manually.

---

## 5. Status Computation

### 5.1 Algorithm

```
function computeInvoiceStatus(invoiceId, terms, cancelledSet, closedSet, frozenBalances, invoiceLedger, balanceCache):
  1. Parse terms from token's genesis.data.tokenData

  2. Check terminal states first:
     - if invoiceId in cancelledSet -> return CANCELLED with frozen balances from frozenBalances
     - if invoiceId in closedSet -> return CLOSED with frozen balances from frozenBalances
     - if previously reached implicit CLOSED (all covered + all confirmed)
       -> return CLOSED with persisted frozen balances

  3. Read from persistent invoice-transfer index (§5.4):
     entries = invoiceLedger.get(invoiceId)
     // The index contains expanded per-coin InvoiceTransferRef entries,
     // pre-built from HistoryRecord + token coinData at processing time.
     // No history scan occurs at query time.

  4. For each entry in the index:
     a. Each entry represents ONE coin from a transfer's coinData.
        Multi-asset tokens produce multiple entries (same transferId,
        different coinId). The full coinData was captured at processing
        time (§5.4.3) — no token lookup needed here.
     b. For EACH coin entry [coinId, amount] in the token:
        (Skip coin entries where amount is "0" — they carry no economic value
         and should not produce InvoiceTransferRef entries, fire events, or
         consume index cache storage. This prevents low-cost spam via
         zero-amount transfers.)
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
     isCovered = all coin assets isCovered
     (NFT coverage is excluded in v1 — see InvoiceNFTAssetStatus)

  7. Determine state (order matters):
     a. if cancelled -> CANCELLED (terminal, already handled in step 2)
     b. if closed (explicit) -> CLOSED (terminal, already handled in step 2)
     c. if all targets isCovered AND allConfirmed -> schedule implicit close:
        -> acquire per-invoice serialization gate (see §5.9)
        -> inside gate: re-verify by full recomputation from history
           (another operation may have terminated the invoice; the recomputed
           balances may differ from the pre-gate snapshot)
        -> if still all covered + all confirmed AND not already terminated:
           freeze recomputed balances with `explicitClose: false`,
           persist to FROZEN_BALANCES, add to closedSet,
           fire 'invoice:closed' { explicit: false }
        -> **Latest sender for surplus (per target:coinId):** For each target:coinId
           with surplus, the "latest sender" is the sender whose forward payment for
           THAT specific target:coinId was being processed inside the gate when the
           close condition was met. In a multi-target invoice, different targets may
           have different latest senders. This is determined by processing order —
           the payment inside the gate — not by timestamp.
        -> **Race condition:** A payment from another sender may arrive while this
           close sequence executes inside the gate. That payment queues behind the
           gate and will be processed as a post-closure payment. Its per-sender
           balance must NOT be reset to zero and must NOT receive surplus.
        -> **Event ordering:** 'invoice:closed' fires BEFORE any 'invoice:auto_returned'
           events, for both explicit and implicit close paths.
        -> after freeze: if auto-return is enabled (perInvoice[id] ?? global)
           AND wallet is a target,
           trigger surplus auto-return (same as explicit close with autoReturn).
           Surplus is calculated from the recomputed-and-frozen balances
           (the balances just frozen inside this gate, not the pre-gate snapshot).
           If recomputed surplus is zero for all target:coinId pairs, the
           auto-return is a no-op (nothing to return).
        -> return CLOSED
        NOTE: the implicit close MUST go through the gate to prevent races
        with concurrent closeInvoice()/cancelInvoice() calls.
        **Cross-invoice token race:** The per-invoice gate serializes operations
        within a single invoice. However, two invoices auto-returning simultaneously
        may compete for the same wallet tokens via `PaymentsModule.send()`. The
        PaymentsModule handles token selection internally — if insufficient tokens
        are available for one return, `send()` throws (insufficient balance), and
        the auto-return is recorded as failed in the dedup ledger. Crash recovery
        (§7.6 step 5) retries failed entries. There is no global cross-invoice mutex
        — introducing one would serialize all invoice operations and defeat the
        per-invoice gate design. Token contention between invoices is expected to be
        rare and is handled by the existing retry mechanism.
     d. if all targets isCovered -> COVERED
     e. if terms.dueDate && now > terms.dueDate -> EXPIRED
        (reachable from OPEN or PARTIAL — any payment activity + past due)
     f. if any asset has netCovered > 0 -> PARTIAL
     g. else -> OPEN

  8. Note: EXPIRED is checked AFTER COVERED but BEFORE PARTIAL.
     If all targets are covered (+ confirmed), the state is CLOSED, not EXPIRED.
     If all targets are covered (unconfirmed), the state is COVERED, not EXPIRED.
     If partially covered and past due date, the state is EXPIRED (not PARTIAL).
     EXPIRED is only reachable from states where not all targets are covered.

  9. Determine allConfirmed:
     Every InvoiceTransferRef.confirmed === true
```

### 5.2 Balance Computation Details

**Arithmetic requirement:** All amount fields in invoices and transfers are strings representing non-negative integers (e.g., `"1000000"`). All arithmetic operations (sums, comparisons, differences) MUST use `BigInt` or equivalent arbitrary-precision integer parsing — **never** lexicographic string comparison or floating-point conversion. Amount strings MUST be validated on input: parseable as a non-negative integer, no leading zeros (except `"0"` itself), no whitespace, no decimal points, no sign prefix. **Length limit:** Amount strings MUST NOT exceed 78 digits (sufficient to represent 2^256, the maximum for any practical token amount). Strings exceeding this length are rejected before `BigInt` parsing to prevent CPU exhaustion from adversarial inputs. Invalid amount strings are rejected with `INVOICE_INVALID_AMOUNT`.

**The core formula for each target:asset:**

```
coveredAmount  = SUM(amount) for all InvoiceTransferRef entries WHERE:
                 // NOTE: entries are already scoped to a single invoice via the
                 // invoiceLedger map key — no ref.invoiceId field needed.
                 - ref.paymentDirection == 'forward'
                   (on-chain: TransferMessagePayload.inv.dir == 'F' or omitted;
                    legacy fallback: transport memo matches INV:<invoiceId>:F)
                 - ref.destinationAddress matches target.address
                 - ref.coinId matches asset.coin[0]

returnedAmount = SUM(amount) for all InvoiceTransferRef entries WHERE:
                 - ref.paymentDirection in ('back', 'return_closed', 'return_cancelled')
                   (on-chain: TransferMessagePayload.inv.dir in ('B', 'RC', 'RX');
                    legacy fallback: transport memo matches INV:<invoiceId>:B or :RC or :RX)
                 - ref.senderAddress matches target.address (returns flow FROM target TO payer)
                   NOTE: For inbound return transfers, the sender is identified via
                   the transfer's senderPubkey/senderAddress fields. For outbound
                   return transfers (sent by this wallet), the sender is this wallet's
                   own address. The module resolves sender identity from the
                   InvoiceTransferRef fields, not from history record field names.
                 - coinId matches asset.coin[0]

netCoveredAmount = coveredAmount - returnedAmount
// returnedAmount <= coveredAmount is enforced by returnInvoicePayment() and the
// auto-return system (throws INVOICE_RETURN_EXCEEDS_BALANCE). However, this is a
// convenience-layer check — direct PaymentsModule.send() with an INV: memo can
// bypass it. The max(0, ...) defensive floor below is therefore a necessary
// safeguard, not dead code.
netCoveredAmount = max(0, netCoveredAmount)
isCovered        = netCoveredAmount >= asset.coin[1] (requested amount)
surplusAmount    = max(0, netCoveredAmount - asset.coin[1])
```

**Per-sender balance (for return cap enforcement and auto-return distribution):**

The aggregate formula above is used for coverage computation (`isCovered`, `surplusAmount`). In addition, balances are tracked per `(target, sender, coinId)` tuple for return cap enforcement and auto-return distribution:

```
senderForwarded = SUM(amount) for all InvoiceTransferRef entries WHERE:
                  - ref.paymentDirection == 'forward'
                  - ref.destinationAddress == target.address
                  - ref.senderAddress == sender
                  - ref.coinId == coinId

senderReturned  = SUM(amount) for all InvoiceTransferRef entries WHERE:
                  - ref.paymentDirection in ('back', 'return_closed', 'return_cancelled')
                  - ref.senderAddress == target.address   (return flows FROM target)
                  - ref.destinationAddress == sender       (return goes TO original sender)
                  - ref.coinId == coinId

senderNetBalance = max(0, senderForwarded - senderReturned)
```

**Return cap rule:** `returnInvoicePayment(invoiceId, { recipient: S, amount, coinId })` MUST validate that `amount <= senderNetBalance` for the `(target=caller's address, sender=S, coinId)` tuple. This replaces the old aggregate `netCoveredAmount` cap.

**Key semantics:**

- **Only memo-referenced transfers count.** A token received without an `INV:` memo does not affect any invoice balance, even if sent to a target address with a matching coin.
- **Spending tokens is independent.** If Alice receives 500 UCT with memo `INV:abc:F`, then spends that 500 UCT on something else (no `INV:abc` memo), the invoice `abc` still shows 500 UCT covered. The spent token's outbound transfer has no invoice memo, so it doesn't affect the invoice.
- **Self-payments are excluded.** If a target address owner sends tokens to themselves with memo `INV:abc:F` (sender address == destination address == target address), the forward payment is NOT counted toward `coveredAmount`. It is classified as `invoice:irrelevant` with reason `'self_payment'`. This prevents a target from fabricating coverage without external payments. **Address comparison:** All `DIRECT://` address comparisons (self-payment detection, target matching, return sender matching) are **case-sensitive exact string matches**. `DIRECT://` addresses are derived deterministically from public keys and always have consistent casing — no normalization is needed. **Limitation:** Self-payment detection compares addresses per-transfer — it does not detect cross-HD-address self-payments within the same wallet (e.g., address 0 paying address 1 where both belong to the same mnemonic). Each HD address is treated as an independent party, consistent with the SDK's address-level isolation model.
- **Only target parties may return.** Back/return payments (`:B`, `:RC`, `:RX`) can only be sent by a party whose wallet address matches one of the invoice targets. Non-target parties can only make forward payments (`:F`).
- **Per-sender return cap (convenience-layer enforcement).** Returns to a specific sender are prevented from exceeding that sender's effective balance by the `returnInvoicePayment()` API and the auto-return system, which throw `INVOICE_RETURN_EXCEEDS_BALANCE` before the transfer happens. This is a **convenience-layer check**, NOT a protocol-level invariant — a user with direct access to `PaymentsModule.send()` can construct an `INV:<id>:B` memo and bypass the cap entirely. The `max(0, ...)` floor in the formula is therefore a necessary defensive safeguard, not dead code. Applications building on the SDK SHOULD use `returnInvoicePayment()` rather than raw `send()` for all return payments to benefit from cap enforcement. What differs between terminal and non-terminal invoices is the *baseline*: closure resets per-sender balances to zero and assigns surplus (see CLOSED/CANCELLED rules below), but the cap still applies against the effective post-reset balance.
- **Terminal state freeze.** Once CLOSED or CANCELLED, balances are frozen and persisted. Post-termination transfers continue to be tracked per-sender on top of the frozen baseline.
- **CLOSED resets per-sender balances (payments accepted).** Closing means the target party accepts the payments as final. At freeze time, all pre-closure per-sender balances are reset to zero — **pre-closure payments are non-returnable.** The surplus (if any) is assigned **per (target, coinId)** to the **latest sender** for that tuple (by processing order — the sender whose forward payment for that specific target:coinId was being processed inside the per-invoice serialization gate when the close condition was met). In multi-target invoices, different targets may have different latest senders. Post-closure per-sender tracking starts from: surplus for the latest sender of each target:coinId, zero for all others. New forward payments after closure are tracked per-sender normally and are fully returnable.
  **Race condition awareness:** A payment from another sender may arrive while the triggering payment's close sequence is executing inside the gate. That concurrent payment queues behind the gate and is processed as a *post-closure* payment — its per-sender balance must NOT be reset to zero and must NOT receive surplus. The per-invoice gate serialization ensures exactly one payment is "inside" at the close moment.
- **CANCELLED preserves per-sender balances (deal abandoned).** Cancellation preserves all per-sender balances as-is — everything is returnable to each sender. Post-cancellation forwards are tracked per-sender normally (added on top).
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

**Missing coinId in status queries:** For any coinId not present in the computed `coinData` map (i.e., no payments received for that asset), `amountCovered` is `'0'` and `tokenCount` is `0`. The `InvoiceCoinAssetStatus` is still returned with zero values — the target's requested assets always appear in the status regardless of payment activity.
- If the invoice target for alice only requests UCT: the UCT entry matches, the USDU entry is irrelevant (`unknown_asset`).

### 5.4 Invoice-Transfer Index (Primary Data Source)

Invoice balance computation reads from a **persistent invoice-transfer index**, NOT from `PaymentsModule.getHistory()` on every query. The index is the primary data source for all non-terminal invoice status computation.

#### 5.4.1 Why Token Transaction Histories?

The **authoritative source** for invoice references is the on-chain `TransferTransactionData.message` field embedded in each token's proof chain (`TxfToken.transactions[]`). This is cryptographically committed to the aggregator's SMT and cannot be tampered with.

`PaymentsModule.getHistory()` returns `HistoryRecord` entries with a **single** `coinId` and `amount` per entry — multi-asset data is invisible. The full `coinData` and the on-chain message are only available from the token itself (`Token.sdkData` → `TxfToken`).

Additionally, rescanning all token transactions on every `getInvoiceStatus()` call is O(T×N) where T=tokens and N=avg transactions per token — unacceptable at scale.

#### 5.4.2 Index Architecture

The index captures **expanded per-coin entries** at the time each transfer is processed. A single multi-asset transfer produces one `InvoiceTransferRef` per coin entry, each persisted in the index. Once captured, the index entry is self-contained — no token lookup is needed at query time.

**Two-level structure:**

```typescript
// Level 1: Per-invoice transfer ledger (primary index)
// In-memory: Map<invoiceId, Map<entryKey, InvoiceTransferRef>>
// entryKey = `${transferId}::${coinId}` (composite dedup key)
// Persisted: one storage key per invoice (see §7.2)
private invoiceLedger: Map<string, Map<string, InvoiceTransferRef>>;

// Level 2: Token scan watermark (tracks processing progress per token)
// In-memory: Map<tokenId, number>  — value = number of transactions processed
// Persisted: single storage key (see §7.2)
// For each token, tracks how many TxfToken.transactions[] entries have been
// scanned for invoice references. Incremental updates process only the tail.
private tokenScanState: Map<string, number>;
```

**Secondary in-memory index (not persisted, rebuilt on load):**

```typescript
// Token-to-invoice mapping — answers "which invoices does this token affect?"
// Needed for efficient transfer:confirmed updates.
// Rebuilt from invoiceLedger entries on load().
private tokenInvoiceMap: Map<string, Set<string>>; // tokenId → Set<invoiceId>
```

**Balance cache (not persisted, computed lazily):**

```typescript
// Per-invoice balance cache — invalidated on index mutation.
// Outer key: invoiceId
// Inner structure: per-target, per-coinId, per-sender balance breakdown
private balanceCache: Map<string, InvoiceBalanceSnapshot>;

interface InvoiceBalanceSnapshot {
  // Aggregate per (target, coinId) — for coverage computation
  aggregate: Map<string, { covered: bigint; returned: bigint }>;  // key = `${targetAddress}::${coinId}`
  // Per-sender per (target, sender, coinId) — for return cap and auto-return
  perSender: Map<string, { forwarded: bigint; returned: bigint }>; // key = `${targetAddress}::${senderAddress}::${coinId}`
}
```

#### 5.4.3 Token Transaction Processing: `processTokenTransactions()`

This is the core function called by both cold-start and incremental updates. It scans a token's transaction history for invoice references in the on-chain `TransferTransactionData.message` field.

```
async processTokenTransactions(token: Token, startIndex: number): Promise<InvoiceTransferRef[]>
  const newEntries: InvoiceTransferRef[] = []
  txf = JSON.parse(token.sdkData) as TxfToken
  coinData = txf.genesis.data.coinData   // multi-asset: [string, string][]
  // NOTE: coinData is read from GENESIS and is IMMUTABLE across the token's
  // lifecycle. State transitions (transfers) do not alter the token's coin
  // composition — the same [coinId, amount][] applies to every transaction.
  // This is a Unicity protocol invariant: token splits create new tokens
  // with new genesis data; the original token's genesis data never changes.

  // NOTE: `absIdx` is the ABSOLUTE index into txf.transactions[].
  // The loop starts at startIndex and increments. All array accesses use
  // absIdx directly — no double-offsetting (startIndex + i).
  //
  // ERROR HANDLING: Each transaction is processed in a try/catch. If a single
  // transaction fails (e.g., malformed tx.data, fromJSON() throws), the error
  // is logged and the loop continues to the next transaction. This prevents a
  // single malformed transaction from creating an infinite retry loop on cold
  // start (tokenScanState would never advance past the failing index).
  // After the loop, tokenScanState is updated to txf.transactions.length
  // regardless of per-transaction errors, marking all as "attempted."
  For each transaction tx at absolute index absIdx in txf.transactions[startIndex..]:
    1. Decode invoice reference from on-chain message (§4.1):
       payload = decodeTransferMessage(tx)
       If payload?.inv is present:
         ref = { invoiceId: payload.inv.id, paymentDirection: mapDir(payload.inv.dir) }
         // mapDir maps: 'F'->'forward', 'B'->'back', 'RC'->'return_closed', 'RX'->'return_cancelled'
       Else:
         // Fallback for legacy transfers (pre-accounting-module):
         // Check HistoryRecord.memo via parseInvoiceMemo() if available.
         // This path handles transfers made before the on-chain message
         // change was deployed. Once all tokens have been migrated,
         // this fallback can be removed.
         ref = null  // try legacy fallback (see §4.8)

    2. If no invoice reference found: continue to next transaction

    3. If ref.invoiceId not in local invoice token storage:
       (fire invoice:unknown_reference from caller, not here)
       continue

    4. Derive transferId from tx:
       // Use the SDK's own TransferTransactionData hash — the canonical identity
       // of a state transition. Recompute on demand from tx.data; NEVER store
       // separately (avoids confusion if stored hash diverges from actual data).
       //
       // tx.data contains the serialized TransferTransactionData fields.
       // Reconstruct the TransferTransactionData object from tx.data, then call
       // calculateHash() which computes SHA256(TransferTransactionData.toCBOR()).
       //
       // This hash is STABLE for a given SDK version: it is computed from the
       // transaction data itself (sourceState, recipient, salt, message,
       // nametags), which is immutable once the transaction is created. It does
       // NOT depend on the inclusion proof — the same hash is produced whether
       // the transaction is confirmed or unconfirmed. It is the same value
       // that appears in inclusionProof.transactionHash after confirmation.
       //
       // CBOR STABILITY WARNING: calculateHash() computes SHA256(toCBOR()).
       // If the SDK's CBOR encoder changes field ordering across versions,
       // the hash changes for the same logical data. This is acceptable because:
       // (1) the dedup key `${transferId}::${coinId}` is compared only within
       //     a single wallet's persisted index — no cross-wallet hash comparison;
       // (2) the index is rebuilt from token transaction data on cold start —
       //     a new SDK version will produce consistent hashes for all entries;
       // (3) the tokenScanState watermark prevents reprocessing unless the index
       //     is reset, so stale hashes and new hashes never coexist.
       // If a future SDK version changes CBOR encoding, a one-time index rebuild
       // (reset tokenScanState) is sufficient to re-derive all transferIds.
       //
       // Reconstruction from tx.data:
       //   tx.data in TxfTransaction is a Record<string, unknown> parsed from
       //   the TXF JSON. The SDK provides TransferTransactionData.fromJSON()
       //   which accepts this shape. Note: despite the field being CBOR-encoded
       //   on-chain, the TXF serializer has already decoded it to JSON by the
       //   time it reaches TxfTransaction.data.
       //   const txData = await TransferTransactionData.fromJSON(tx.data);
       //   const hash = await txData.calculateHash();
       //   transferId = bytesToHex(hash.data);  // 64-char hex
       //
       // IMPORTANT: Use fromJSON(), NOT fromCBOR(). The TxfTransaction.data
       // field is the JSON-decoded form. fromCBOR() expects raw CBOR bytes
       // and would fail on the already-decoded object.
       //
       // NOTE: Both fromJSON() and calculateHash() return Promises.
       // The first await resolves the TransferTransactionData instance,
       // the second resolves the DataHash. Do NOT chain .calculateHash()
       // directly on fromJSON() — that calls a method on a Promise.
       //
       // ORDERING: destinationAddress validation (step 4a) runs BEFORE
       // the hash computation (step 4b) because fromJSON()+calculateHash()
       // are async and comparatively expensive. If the recipient is
       // malformed, skip early without computing the hash.

    4a. Validate destinationAddress (cheap check — before hash computation):
       destinationAddress = (tx.data as any)?.recipient   // TransferTransactionData.recipient
       // Validate destinationAddress format: must be a DIRECT:// address string.
       // Reject malformed values (prevents garbage data from flowing into events/UI).
       if (typeof destinationAddress !== 'string' || !destinationAddress.startsWith('DIRECT://')) {
         continue  // skip transaction with invalid recipient
       }

    4b. Derive transferId (expensive — async hash computation):
       const txData = await TransferTransactionData.fromJSON(tx.data)
       transferId = bytesToHex((await txData.calculateHash()).data)
       // Edge case: TxfTransaction.data is typed as optional (Record<string, unknown> | undefined).
       // If tx.data is missing, skip this transaction — it cannot be linked to an invoice
       // without its transaction data. This should not occur for well-formed tokens.

    5. Resolve sender from tx and token state:
       // IMPORTANT: tx.predicate at index N is the NEW owner's predicate
       // (the recipient of transaction N), NOT the sender's. The SENDER is
       // the PREVIOUS state's owner — identified by the predicate at the
       // previous transaction, or the genesis recipient for the first tx.
       //
       // Sender derivation:
       //   - For transaction at absIdx 0: sender = genesis.data.recipient
       //     (the original minter/owner)
       //   - For transaction at absIdx N > 0: sender = derived from
       //     txf.transactions[N-1].predicate via UnmaskedPredicate.fromCBOR()
       //     (the predicate set by transaction N-1 identifies the owner
       //     before transaction N transferred the token)
       //
       // NOTE: absIdx is the ABSOLUTE index into txf.transactions[].
       // The guard uses absIdx === 0 (not relative to startIndex).
       // The previous-predicate lookup uses absIdx - 1 (no double-offset).
       //
       // Extract the public key from the predicate, then derive the
       // DIRECT:// address from it using the SDK's address derivation.
       // IMPORTANT: Predicate may be MASKED (owner hidden) or UNMASKED.
       // UnmaskedPredicate.fromCBOR() will throw on a masked predicate.
       // If the predicate is masked, the sender address is unresolvable —
       // set senderAddress to null. The entry is still indexed (see step 6e
       // NOTE below). Downstream logic skips null-sender entries for
       // self-payment detection and return matching, but includes them in
       // aggregate coverage computation.
       // ADDRESS DERIVATION: Uses PaymentsModule.createDirectAddressFromPubkey()
       // which calls UnmaskedPredicateReference.create(tokenType, 'secp256k1',
       // pubkeyBytes).toString(). This produces the same DIRECT:// format as
       // genesis.data.recipient for the same public key. No normalization needed.
       // NOTE: This derivation is ASYNC (requires await). The caller
       // (processTokenTransactions) is async due to TransferTransactionData.fromJSON().
       senderAddress = (absIdx === 0)
         ? txf.genesis.data.recipient
         : await (async () => {
             try {
               const predicate = UnmaskedPredicate.fromCBOR(
                 hexToBytes(txf.transactions[absIdx - 1].predicate)
               );
               // Derive DIRECT:// address from public key using the SDK's
               // address derivation (same as PaymentsModule.createDirectAddressFromPubkey)
               return await createDirectAddressFromPubkey(predicate.publicKey);
             } catch {
               return null;  // masked predicate or empty — sender unknown
             }
           })()

    6. For each [coinId, amount] in coinData (capped at first MAX_COIN_DATA_ENTRIES entries,
       default 50; configurable via AccountingModuleConfig.maxCoinDataEntries):
       // KNOWN LIMITATION: Tokens with more than MAX_COIN_DATA_ENTRIES distinct
       // coin types will have trailing entries silently ignored. In practice,
       // tokens carry 1-3 coin types. The cap is a defense against adversarial
       // tokens with thousands of entries causing O(N) processing per transaction.
       a. Skip if amount.length > 78 or !/^[1-9][0-9]*$/.test(amount)
          // LENGTH CHECK FIRST (short-circuit): prevents regex engine from
          // scanning multi-million-character adversarial strings before rejection.
          // Rejects: "0", negative ("-500"), non-numeric ("abc"), decimals ("12.5"),
          // leading zeros ("007"), whitespace, empty strings, and strings > 78 digits.
          // This is the INBOUND validation — token coinData is adversarial input.
          // Only positive integer strings survive to BigInt balance computation.
       b. entryKey = `${transferId}::${coinId}`
       c. invoiceMap = invoiceLedger.get(ref.invoiceId)
          // Lazy creation: if invoiceLedger does not have an entry for
          // ref.invoiceId (e.g., cold start with stale inv_ledger_index),
          // create an empty Map before proceeding.
          if (!invoiceMap) { invoiceMap = new Map(); invoiceLedger.set(ref.invoiceId, invoiceMap); }
       d. If invoiceMap.has(entryKey): continue  // dedup
       e. Create InvoiceTransferRef:
          - transferId
          - direction: determine 'inbound' or 'outbound' by comparing
            senderAddress/destinationAddress against this wallet's addresses
            (from getActiveAddresses()). If senderAddress matches a wallet
            address → 'outbound'; otherwise → 'inbound'.
          - paymentDirection: ref.paymentDirection  // 'forward' | 'back' | 'return_closed' | 'return_cancelled'
          - coinId, amount
          - senderAddress (may be null if predicate was masked),
            destinationAddress
          - timestamp: Date.now()
            // NOTE: TxfAuthenticator does not have a timestamp field.
            // Use the local clock when the transaction is first processed.
            // For confirmed transactions, the inclusion proof provides ordering
            // via its position in the SMT, but no extractable timestamp.
            // The timestamp is informational (display/sorting) — all balance
            // computation and ordering uses the TXF transaction chain index.
          - confirmed: tx.inclusionProof !== null
          NOTE: If senderAddress is null (masked predicate), the entry is
          still indexed. Self-payment detection (§5.2) skips entries with
          null senderAddress. For return transfers (:B/:RC/:RX) with null
          senderAddress, the entry is indexed here with its declared
          paymentDirection, but the §6.2 step 3a post-validation reclassifies
          it as 'forward' (preventing returnedAmount inflation) and marks it
          as 'unauthorized_return'. This two-phase approach ensures the
          index always contains the entry (for getRelatedTransfers) while
          preventing unverifiable senders from manipulating balance computation.
       f. invoiceMap.set(entryKey, entry)
       g. newEntries.push(entry)
       h. Update tokenInvoiceMap(tokenId → invoiceId)
       i. Invalidate balanceCache for ref.invoiceId
       j. Mark invoice as dirty (needs storage flush)

  Update tokenScanState: tokenScanState.set(tokenId, txf.transactions.length)
  return newEntries
```

**Idempotency guarantee:** The composite key `${transferId}::${coinId}` ensures that reprocessing the same transaction is a no-op. The `tokenScanState` watermark provides a fast-path skip: if `tokenScanState.get(tokenId) >= txf.transactions.length`, the token is fully processed.

**Legacy fallback (§4.8):** For transfers made before the on-chain message change, `TxfTransaction.data.message` is `null`. In this case, `processTokenTransactions()` checks the `HistoryRecord.memo` for the corresponding transfer (matched by tokenId + transaction index). This ensures backward compatibility during the migration period.

#### 5.4.4 Population: Cold Start (`load()`)

Cold start loads persisted state, then scans token transaction histories for gaps.

```
Phase 1 — Load persisted index:
  1. Load inv_ledger_index → populate invoiceLedger outer map (keys only)
  2. Load inv_ledger:{invoiceId} for each invoice → populate transfer Maps
  3. Load token_scan_state → populate tokenScanState
  4. Rebuild tokenInvoiceMap from loaded entries

Phase 2 — Scan token transaction tails:
  5. allTokens = PaymentsModule.getTokens() + PaymentsModule.getArchivedTokens()
     // BOTH active and archived tokens must be scanned. Archived tokens may
     // have unprocessed transaction tails if the process crashed between
     // archiving the token and updating tokenScanState. The tokenScanState
     // watermark provides the fast-path skip for fully-processed tokens.
     // NOTE: getArchivedTokens() exists in current PaymentsModule API and
     // returns Map<string, TxfToken> (not Token[]). For archived tokens,
     // the TxfToken is available directly — no JSON.parse(sdkData) needed.
     // Construct a lightweight Token-shaped object for processTokenTransactions:
     //   { id: tokenId, sdkData: JSON.stringify(txfToken) } for each entry.
  6. For each token T in allTokens:
     a. txf = JSON.parse(T.sdkData) as TxfToken
     b. startIndex = tokenScanState.get(T.id) ?? 0
     c. If txf.transactions.length > startIndex:
        → processTokenTransactions(T, startIndex)
     d. **Yield check:** After every BATCH_SIZE tokens (default 100),
        yield to the event loop (await new Promise(r => setTimeout(r, 0)))
        to prevent blocking the main thread during cold start with large
        token inventories. This is a SHOULD, not a MUST — implementations
        may omit yielding if the runtime supports worker threads.
  7. Flush dirty invoice entries to storage
  8. Persist updated tokenScanState
```

**Cost analysis:** Phase 1 is O(persisted entries). Phase 2 is O(new transactions since last session) — the watermark ensures only the tail of each token's transaction array is processed. On a warm start with no new transactions, Phase 2 does zero work per token (single Map lookup).

#### 5.4.5 Population: Incremental Updates

**On `transfer:incoming` event** (IncomingTransfer payload):
```
1. For each token in IncomingTransfer.tokens:
   a. startIndex = tokenScanState.get(token.id) ?? 0
   b. txf = JSON.parse(token.sdkData) as TxfToken
   c. If txf.transactions.length > startIndex:
      → processTokenTransactions(token, startIndex)
2. Flush dirty entries to storage (async)
```

**On `transfer:confirmed` event** (TransferResult payload):
```
1. For each token in TransferResult.tokens:
   a. startIndex = tokenScanState.get(token.id) ?? 0
   b. txf = JSON.parse(token.sdkData) as TxfToken
   c. If txf.transactions.length > startIndex:
      → processTokenTransactions(token, startIndex)
      // New transactions may have appeared (e.g., confirmation proof added)
   d. Additionally: update confirmed=true for existing entries where
      tx.inclusionProof was previously null but is now present
   e. Invalidate balanceCache for affected invoices
2. Flush dirty entries to storage (async)
```

**On `history:updated` event** (HistoryRecord payload):
```
// Used only as a legacy fallback trigger for pre-change transfers
// where on-chain message is null:
1. If historyEntry.tokenId:
   a. Look up token via getTokens()
   b. If token found and tokenScanState indicates unprocessed transactions:
      → processTokenTransactions(token, startIndex)
2. Flush dirty entries to storage (async)
```

#### 5.4.6 Query: Balance from Index

`getInvoiceStatus()` reads directly from the in-memory `invoiceLedger`:

```
1. If terminal → return frozen balances (no index read)
2. entries = invoiceLedger.get(invoiceId)
3. If balanceCache has valid entry → return cached balances
4. Else: iterate entries, accumulate per-coin BigInt sums
   - forward → coveredAmount
   - back/return_closed/return_cancelled → returnedAmount
5. Cache result in balanceCache
6. Return computed status
```

This is O(E) where E = entries for this invoice, not O(H) where H = full history. The balance cache makes repeated queries O(1).

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
- If the invoice is OPEN or PARTIAL (not all targets covered) -> becomes EXPIRED
- An EXPIRED invoice can still transition to COVERED/CLOSED if all targets become covered after expiration
- Note: EXPIRED takes priority over PARTIAL in the algorithm (§5.1 step 7e). A partially covered invoice past its due date shows EXPIRED, not PARTIAL.
- **Reverse transitions:** Return payments can reduce coverage. If all coverage is returned on an expired invoice, the state reverts to EXPIRED (step 7e still matches due date check). If coverage is returned on a non-expired invoice, it can go from PARTIAL back to OPEN. These reverse transitions are inherent to the on-demand recomputation model.

This means: due date is a signal to participants, not an enforcement mechanism. The on-chain tokens don't enforce deadlines.

**Clock skew:** EXPIRED is derived from `Date.now() > dueDate` locally. Different parties may disagree on expiration status if their clocks differ. Implementations SHOULD tolerate up to 60 seconds of clock skew when presenting expiration status to users.

### 5.8 Termination Semantics

**Close and cancel are local operations with persisted frozen balances.**

- **Explicit close (`closeInvoice()`).** A target party is satisfied with current payments. Balances are frozen at the moment of close. Subsequent forward payments may be auto-returned with `:RC`.
- **Cancel (`cancelInvoice()`).** A target party abandons the deal. Balances are frozen at the moment of cancel. Subsequent forward payments may be auto-returned with `:RX`.
- **Implicit close.** Happens automatically when all targets are fully covered AND all tokens confirmed. Balances are frozen. This is functionally identical to explicit close but with `explicitClose: false` in the status.
- **Outbound blocking.** `payInvoice()` throws `INVOICE_TERMINATED` if the invoice is locally terminated (closed or cancelled). The transfer does NOT happen. This is the only case where the accounting module prevents a transfer.
- **Perspective divergence.** Your CLOSED does not imply others' CLOSED. Different parties have different transaction histories.
- **Frozen balance staleness.** The `coveredAmount`, `returnedAmount`, `netCoveredAmount`, and `transfers` arrays in frozen balances reflect the state at the moment of termination. Post-termination transfers (including auto-returns sent after freezing) are NOT reflected in the frozen snapshot — they are visible only via `getRelatedTransfers()`. Specifically, `InvoiceStatus.targets[].coinAssets[].transfers` for terminal invoices is the frozen list, NOT a live query. The `allConfirmed` field is the exception: it is dynamically derived (see §7.3). Applications needing a complete post-termination picture should combine frozen balances with `getRelatedTransfers()`.

### 5.9 Concurrency Model

All state-mutating operations on a given invoice are serialized through a **per-invoice async mutex** (`Map<string, Promise<void>>`). This prevents race conditions where concurrent events could corrupt terminal state or cause double auto-returns.

**Serialized operations** (per invoiceId):
- `closeInvoice()`, `cancelInvoice()`
- Implicit close (all targets covered + confirmed)
- Auto-return execution (immediate and ongoing)
- `setAutoReturn()` immediate trigger
- Inbound event processing that may trigger auto-return or implicit close
- `returnInvoicePayment()` — holds the gate through validation AND send.
  Unlike `payInvoice()` (where over-payment is benign and auto-returnable),
  over-return is direct fund loss with no automatic recovery. Serialization
  prevents two concurrent returns from both passing the balance check before
  either's send completes. Returns are infrequent, so the blocking cost is
  acceptable. **Timeout:** Implementations MUST apply a 60-second timeout to the
  `send()` call within the gate. If the timeout
  fires, release the gate and reject the return with a timeout error. The
  dedup ledger is NOT written until after send succeeds, so a timed-out
  return leaves no ledger entry and can be safely retried by the caller.
  **Index update:** After a successful `send()` inside the gate,
  `returnInvoicePayment()` MUST synchronously update the in-memory
  invoice-transfer index with the new outbound return transfer BEFORE
  releasing the gate. The update sequence inside the gate is:
  (1) call `send()` → (2) update invoice-transfer index (synchronous) →
  (3) write dedup ledger entry as 'completed' → (4) invalidate balanceCache →
  (5) release gate.
  This ensures the next serialized operation's balance
  check (via `getRelatedTransfers()`) sees the return. Do not rely on the
  async event path (transfer:confirmed) for intra-gate consistency.

**Non-serialized** (read-only, with one exception):
- `getInvoiceStatus()` — read-only in the common case. However, when it detects
  an implicit close condition (all targets covered + all confirmed), it acquires
  the per-invoice gate to perform the freeze-and-persist operation. Inside the gate
  it **re-verifies by full recomputation from history** — checking both the
  terminal sets (closedSet/cancelledSet, which may have been modified by a
  concurrent `closeInvoice()`/`cancelInvoice()`) AND recomputing balances from
  scratch (which may differ if new transfers arrived during the wait). Only if the
  recomputed state still meets the implicit close condition is the freeze performed.
- `getInvoice()`, `getInvoices()`, `getRelatedTransfers()`
- `payInvoice()` (gate for check only, released before send) — acquires the per-invoice gate for the terminal-state check
  only (released before calling `PaymentsModule.send()`). This prevents a TOCTOU
  race where a concurrent implicit close could terminate the invoice between the
  check and the send. The gate is NOT held during the send itself to avoid blocking
  other operations for the duration of the network call.
  **Accepted race:** A narrow window exists between gate release and `send()`
  completion where a concurrent implicit close can terminate the invoice. If this
  occurs, the payment succeeds (tokens are transferred) but the frozen balance
  snapshot will not include it. This is accepted because: (1) holding the gate
  through the network call would block all other invoice operations for seconds;
  (2) the transfer is visible via `getRelatedTransfers()` regardless; (3) if
  auto-return is enabled, the next inbound event or `setAutoReturn()` call will
  return the surplus. Applications concerned about this race SHOULD enable
  auto-return on close to ensure post-freeze payments are automatically handled.
  **Rapid-call drain risk:** Because `payInvoice()` releases the gate before
  `send()`, rapid successive calls can each pass the terminal-state check and
  queue multiple sends before any completes. This is by design (non-blocking),
  but callers SHOULD serialize their own `payInvoice()` calls (await each before
  calling the next) to avoid unintended overpayment. Connect hosts enforce this
  via intent confirmation modals (one at a time). SDK consumers calling
  `payInvoice()` programmatically MUST implement their own call serialization
  or accept that concurrent calls may overpay.
- `parseInvoiceMemo()`

```typescript
// Conceptual implementation
private readonly invoiceGates = new Map<string, Promise<void>>();

private async withInvoiceGate(invoiceId: string, fn: () => Promise<void>): Promise<void> {
  if (this.destroyed) throw new SphereError('MODULE_DESTROYED', 'AccountingModule is destroyed');
  const prev = this.invoiceGates.get(invoiceId) ?? Promise.resolve();
  // Chain fn after previous operation completes. Use .then(run, run) to ensure
  // fn executes even if the prior operation rejected — each gate entry runs
  // independently. fn's own rejection propagates to the caller via `await next`.
  const run = () => fn();
  const next = prev.then(run, run);
  this.invoiceGates.set(invoiceId, next);
  try {
    await next;
  } finally {
    // Cleanup: if this was the last queued operation, remove the gate entry
    // to prevent unbounded memory growth over thousands of invoices.
    if (this.invoiceGates.get(invoiceId) === next) {
      this.invoiceGates.delete(invoiceId);
    }
  }
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
- Auto-return sender resolution failure -> if the original sender's address cannot be resolved for the return transfer, the auto-return is skipped for that transfer, logged, and `invoice:auto_return_failed` event is emitted with `{ invoiceId, transferId, reason: 'sender_unresolvable' }`. The dedup ledger is NOT written, so the return will be retried on the next trigger (e.g., `setAutoReturn()` call or next inbound event)
- Storage failure -> transfer data persists in PaymentsModule history, accounting catches up on next recomputation

No exception from the accounting layer may propagate to or interrupt the payment layer for inbound transfers.

**Outbound forward payments to terminated invoices ARE blocked** — `payInvoice()` throws before calling `send()`. This is deliberate: the caller explicitly attempted to pay a terminated invoice.

---

## 6. Events

### 6.1 Event Definitions

All new events are added to `SphereEventType` union and `SphereEventMap` interface in `types/index.ts`.

**IMPORTANT: `SphereEventType` is a `type` alias (union), not an `interface`.** Module augmentation
cannot extend it. The additions below MUST be made directly in `types/index.ts`. Similarly,
`SphereEventMap` entries must be added directly. The `connect/permissions.ts` file must also be
updated: add `'invoice:read'` to `PERMISSION_SCOPES`, add `sphere_getInvoices` and
`sphere_getInvoiceStatus` to `METHOD_PERMISSIONS`, and add all six intent actions
(`create_invoice`, `close_invoice`, `cancel_invoice`, `pay_invoice`, `return_invoice_payment`,
`set_auto_return`) to `INTENT_PERMISSIONS`.

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
| 'invoice:auto_return_failed'
| 'invoice:return_received'
| 'invoice:over_refund_warning'

// New SphereEventMap entries:
'invoice:created': {
  invoiceId: string;
  confirmed: boolean;  // true once mint proof is confirmed
};

'invoice:payment': {
  invoiceId: string;
  transfer: InvoiceTransferRef;
  paymentDirection: 'forward' | 'back' | 'return_closed' | 'return_cancelled';
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

'invoice:over_refund_warning': {
  invoiceId: string;
  senderAddress: string;                  // the sender's address (this wallet's address)
  coinId: string;
  forwardedAmount: string;                // total forwarded by this sender
  returnedAmount: string;                 // total returned to this sender (exceeds forwarded)
};

'invoice:auto_return_failed': {
  invoiceId: string;
  transferId: string;                     // the inbound transfer that could not be returned
  reason: 'sender_unresolvable' | 'send_failed' | 'max_retries_exceeded';
};
```

### 6.2 Event Firing Logic

```
On PaymentsModule 'transfer:incoming' or 'history:updated':
  1. Parse memo -> get invoiceId, paymentDirection (from InvoiceMemoRef)
  2. If invoiceId not in local token storage:
     -> fire 'invoice:unknown_reference' { invoiceId, transfer }
     -> return
  3. If paymentDirection is 'back', 'return_closed', or 'return_cancelled':
     -> Process transfer into index via processTokenTransactions() (§5.4.3)
        FIRST, before gate acquisition. This ensures the return transfer is
        indexed in invoiceLedger (updating returnedAmount) regardless of
        whether the gate body terminates the invoice. The returned
        InvoiceTransferRef entries are passed to subsequent steps.
     -> **acquire per-invoice gate** (serializes all return processing for
        this invoice; released at end of step 3 or on early return)
     a. **Validate sender:** check that the transfer's sender address matches
        one of the invoice's target addresses. If senderAddress is null (masked
        predicate) OR the sender is NOT an invoice target:
        - Remove the InvoiceTransferRef entries created by the pre-gate
          processTokenTransactions() call from invoiceLedger (using the
          entryKeys `${transferId}::${coinId}` from the returned entries).
          Invalidate balanceCache for the invoiceId.
        - Re-insert the entries with `paymentDirection: 'forward'` so the
          transfer is still indexed (it carries real tokens) but does not
          inflate returnedAmount.
        - Treat the transfer as `invoice:irrelevant` with reason
          `'unauthorized_return'` and return (releasing gate).
        This prevents spoofed :B/:RC/:RX transfers from non-target parties or
        masked-predicate senders from inflating returnedAmount or triggering
        auto-termination.
     b. fire 'invoice:return_received' { invoiceId, transfer, returnReason }
     c. **Over-refund check:** Compare total returned to this sender vs total
        forwarded by this sender (for this coinId). If returned > forwarded,
        fire 'invoice:over_refund_warning' { invoiceId, senderAddress, coinId,
        forwardedAmount, returnedAmount }. The transfer is NOT blocked — this
        is an informational warning only.
     d. if autoTerminateOnReturn config is true:
        - :RC -> auto-close invoice locally (if not already terminated).
          NOTE: The invoice may not appear fully covered from the sender's
          perspective — the target decided to close, and the sender accepts
          this via the implicit termination signal.
        - :RX -> auto-cancel invoice locally (if not already terminated)
        **Implementation note:** Auto-termination uses an internal
        `_terminateInvoice(invoiceId, state)` method that performs the
        freeze-and-persist directly without gate acquisition (since the
        gate is already held from step 3 entry). MUST NOT call the public
        `closeInvoice()`/`cancelInvoice()` methods, which would re-acquire
        the gate and deadlock.
        **PREREQUISITE:** `_terminateInvoice()` MUST only be called from
        code paths that already hold the per-invoice gate. The gate was
        acquired at step 3 entry, satisfying this requirement. This
        ensures: (a) no concurrent `closeInvoice()`/`cancelInvoice()` can
        race with the freeze, and (b) the frozen balance computation uses
        a consistent index state.
        The `_terminateInvoice()` method checks terminal sets atomically
        (if already terminated, returns immediately — no double-freeze).
        It performs the same steps as closeInvoice()/cancelInvoice()
        (compute balances, freeze, persist to terminal set) but skips
        the outer gate acquisition. **Write order:** terminal set FIRST,
        frozen balances SECOND — matching closeInvoice()/cancelInvoice()
        (see §7.6 crash recovery rationale).
        **Trust note:** A legitimate target CAN send :RC/:RX even if the
        invoice is not actually closed/cancelled on their side. The payer's
        `autoTerminateOnReturn` trusts the target's direction code at face
        value. This is acceptable because: (1) auto-termination is opt-in
        (default false); (2) the target already holds the tokens and could
        simply not return them; (3) spoofing a direction code gains the
        target nothing — the tokens are being returned regardless.
     -> return (releasing gate)
  4. Process transfer into index via processTokenTransactions() (§5.4.3)
     This builds InvoiceTransferRef entries and updates invoiceLedger.
     Returns the list of newly-created InvoiceTransferRef entries for use
     by subsequent steps (including transferId, coinId, amount, senderAddress).
     NOTE: This step runs for ALL invoices (terminal and non-terminal) so that
     post-termination transfers are captured in the index for getRelatedTransfers().
  5. If invoice is in terminal state (CLOSED or CANCELLED):
     -> fire 'invoice:payment' (transfer is still recorded)
     -> if paymentDirection is 'forward' AND auto-return enabled (perInvoice[id] ?? global)
        AND wallet is a target:
        -> **acquire per-invoice gate** (entire auto-return block is serialized)
        -> inside gate (using InvoiceTransferRef entries returned by step 4):
           - check dedup ledger for (invoiceId, transferId) — skip if status='completed'
             ('failed' entries are also skipped here — they are only retried via
             setAutoReturn(), which explicitly resets them to 'pending' first)
           - write dedup ledger entry with status='pending' (intent log)
           - invoke auto-return: send the entire incoming amount back to the SENDER
             of this specific transfer. The amount and sender come from the
             triggering transfer's own data (passed as context to this handler),
             NOT from a fresh index read. This makes auto-return independent of
             concurrent index mutations by other event handlers.
             (Any new forward payment to a terminated invoice is surplus by
             definition; return is always to the specific sender.)
           - use :RC for CLOSED, :RX for CANCELLED
             The freeText parameter MUST be set to the originalTransferId
             (from the InvoiceTransferRef returned by step 4) to enable
             secondary dedup matching (§7.5).
           - update dedup ledger entry to status='completed'
           - fire 'invoice:auto_returned'
     -> do not fire balance-related events (frozen)
     -> return
  6. (Non-terminal invoices only) Match transfer against invoice targets (using index entries):
     a. If matches target + asset:
        -> fire 'invoice:payment' { invoiceId, transfer, paymentDirection, confirmed }
     b. If doesn't match any target/asset:
        -> fire 'invoice:irrelevant' { invoiceId, transfer, reason, confirmed }
  7. (Non-terminal invoices only) Recompute status:
     a. If asset just became covered -> fire 'invoice:asset_covered'
     b. If target just became covered -> fire 'invoice:target_covered'
     c. If all targets covered:
        - If all confirmed -> acquire per-invoice gate, re-verify by full
          recomputation (see §5.1 step 7c), then if still valid:
          freeze balances, persist, fire 'invoice:closed' { explicit: false },
          then trigger surplus auto-return if enabled (see §5.1 step 7c)
        - Else -> fire 'invoice:covered' { confirmed: false }
     d. If surplus detected -> fire 'invoice:overpayment'
     e. If terms.dueDate && now > terms.dueDate && not all targets covered:
        -> fire 'invoice:expired' { invoiceId }

On PaymentsModule 'transfer:confirmed':
  1. Check if transfer has invoice memo reference
  2. If invoice is in terminal state -> skip
  3. If yes, recompute and re-fire all applicable events with confirmed: true
  4. If all targets covered AND now all confirmed -> acquire per-invoice gate,
     re-verify by full recomputation inside gate, then if still valid:
     freeze balances, persist, fire 'invoice:closed' { explicit: false },
     then trigger surplus auto-return if enabled (see §5.1 step 7c)

On createInvoice() or importInvoice():
  1. Store the invoice token
  2. Scan FULL transaction history for transfers referencing this invoice
  3. For each matching transfer found: fire events as if the transfer just arrived
     (invoice:payment, invoice:asset_covered, invoice:target_covered, etc.)
  4. This handles the P2P async case where payments arrive before the invoice
```

### 6.3 Idempotency Contract

**Events may fire multiple times.** The AccountingModule does NOT track which events have been fired. On every relevant trigger (incoming transfer, confirmation, history update, invoice creation/import with retroactive scan), it recomputes the current invoice status from the index and fires all events that apply to the current state. The §6.2 step-by-step logic describes what events to fire based on the computed state — not a stateful transition tracker. For example, "if asset just became covered" means "the recomputed status shows this asset is covered AND this is the event that triggered the recomputation" — it does not mean the module remembers whether `invoice:asset_covered` was previously fired.

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

On `load()`, the AccountingModule discovers invoice tokens via `PaymentsModule.getTokens()` (which returns `Token[]` with `sdkData` containing TXF JSON) filtered by `genesis.data.tokenType === INVOICE_TOKEN_TYPE_HEX`. `TokenStorageProvider` does not expose an enumeration API — all token discovery goes through `PaymentsModule`. All invoice data (terms, creator, targets, etc.) is read from the token's `genesis.data.tokenData` field.

### 7.2 Termination Storage

Since termination (close/cancel) is local-only (not encoded in the token), per-address keys track terminated invoice IDs and their frozen balances:

Added to `STORAGE_KEYS_ADDRESS` in `constants.ts`. Full storage keys are built via
`getAddressStorageKey(addressId, key)` which produces `{addressId}_{key}` format
(e.g., `DIRECT_abc123_xyz789_cancelled_invoices`). Note: no `sphere_` prefix — the
existing SDK pattern uses the addressId directly as the prefix. Storage access uses
`storage.get(key)` / `storage.set(key, value)` (not `getItem`/`setItem`).

The per-invoice ledger keys use a colon separator (`inv_ledger:{invoiceId}`) which
is distinct from the underscore separator in address-scoped keys. This is safe because
invoiceIds are 64-char hex (no colons or underscores) and the colon cannot collide
with any existing key pattern.

```typescript
/** Cancelled invoice IDs (JSON string array) */
CANCELLED_INVOICES: 'cancelled_invoices',
/** Closed invoice IDs — both explicit closeInvoice() and implicit all-covered+confirmed (JSON string array) */
CLOSED_INVOICES: 'closed_invoices',
/** Frozen balance snapshots for terminated invoices (JSON map: invoiceId -> FrozenInvoiceBalances) */
FROZEN_BALANCES: 'frozen_balances',
/** Auto-return settings (JSON: AutoReturnSettings) */
AUTO_RETURN: 'auto_return',
/** Auto-return deduplication ledger (JSON: AutoReturnLedger) */
AUTO_RETURN_LEDGER: 'auto_return_ledger',
/**
 * Invoice-transfer index — partitioned per invoice for efficient targeted reads/writes.
 * Each key stores the expanded InvoiceTransferRef[] for one invoice.
 * Format: 'inv_ledger:{invoiceId}' → JSON InvoiceTransferRef[]
 */
// INV_LEDGER prefix: 'inv_ledger:',
/**
 * Invoice ledger directory — lightweight map of all known invoice IDs
 * and their termination status. Loaded on startup to populate the outer
 * invoiceLedger map without loading all transfer data.
 * Format: Record<invoiceId, { terminated: boolean; frozenAt?: number }>
 */
INV_LEDGER_INDEX: 'inv_ledger_index',
/**
 * Token scan watermark — tracks how many transactions have been processed
 * per token. Enables incremental updates: only the tail of each token's
 * TxfToken.transactions[] array is scanned on restart.
 * Format: Record<tokenId, number> (tokenId → txCount)
 */
TOKEN_SCAN_STATE: 'token_scan_state',
```

Full key format: `sphere_{addressId}_cancelled_invoices`, etc. The `addressId` value (e.g., `DIRECT_abc123_xyz789`) is guaranteed colon-free and underscore-delimited, so no separator collision is possible.

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
  /** Transfers referencing this invoice but not matching any target/asset (frozen at termination) */
  readonly irrelevantTransfers: IrrelevantTransfer[];
  /** Total forward payments across all targets, keyed by coinId */
  readonly totalForward: Record<string, string>;
  /** Total back/return payments across all targets, keyed by coinId */
  readonly totalBack: Record<string, string>;
  /** Timestamp of most recent related transfer at time of freezing */
  readonly lastActivityAt: number;
  // NOTE: allConfirmed is NOT stored in FrozenInvoiceBalances.
  // It is a computed property on InvoiceStatus, derived dynamically from
  // PaymentsModule on each query (see InvoiceStatus.allConfirmed).
}

interface FrozenTargetBalances {
  readonly address: string;
  readonly coinAssets: FrozenCoinAssetBalances[];
  /** Per-NFT-asset status (frozen at termination) */
  readonly nftAssets: InvoiceNFTAssetStatus[];
  /** Whether all assets (coins and NFTs) for this target were covered at freeze time */
  readonly isCovered: boolean;
  /** Whether all related tokens for this target were confirmed at freeze time */
  readonly confirmed: boolean;
}

interface FrozenCoinAssetBalances {
  readonly coin: CoinEntry;
  readonly coveredAmount: string;
  readonly returnedAmount: string;
  readonly netCoveredAmount: string;
  readonly isCovered: boolean;
  readonly surplusAmount: string;
  /** Whether all transfers for this asset were confirmed at freeze time */
  readonly confirmed: boolean;
  /** Individual transfers contributing to this asset (frozen snapshot) */
  readonly transfers: InvoiceTransferRef[];
  /**
   * Per-sender balance baseline after freeze. This is the starting point for
   * post-termination per-sender tracking.
   *
   * For CLOSED: all entries are zero EXCEPT the latest sender gets the surplus.
   *   Pre-closure payments are accepted as final (non-returnable).
   *   latestSender = sender whose forward payment for THIS target:coinId was
   *   being processed inside the per-invoice gate when the close condition was met.
   *   Different target:coinId pairs may have different latest senders.
   * For CANCELLED: each sender's full pre-cancellation senderNetBalance is preserved.
   *   Everything is returnable.
   *
   * Post-termination forwards and returns are tracked on top of these baselines.
   * Post-termination identification: A transfer is "post-termination" if its
   * entry was NOT in the frozen snapshot (i.e., it was added to the live
   * invoiceLedger after the freeze). This is determined by set difference
   * (live ledger keys minus frozen transfer IDs), NOT by timestamp comparison.
   * The frozenAt timestamp is informational only — not used for filtering.
   */
  readonly frozenSenderBalances: FrozenSenderBalance[];
  /**
   * The latest sender for this target:coinId at freeze time (CLOSED only).
   * Persisted to enable crash recovery (inverse reconciliation in §7.6 step 4c).
   * For CANCELLED invoices, this field is undefined (all balances preserved).
   */
  readonly latestSenderAddress?: string;
}

interface FrozenSenderBalance {
  readonly senderAddress: string;
  readonly senderPubkey?: string;
  /** Returnable balance baseline at freeze time */
  readonly netBalance: string;
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
interface AutoReturnLedgerEntry {
  /** When the intent was recorded */
  readonly intentAt: number;
  /** 'pending' = intent recorded, send not yet confirmed; 'completed' = send confirmed; 'failed' = max retries exceeded */
  readonly status: 'pending' | 'completed' | 'failed';
  /** Return transfer ID (set when status = 'completed') */
  readonly returnTransferId?: string;
  /** When the return was completed (set when status = 'completed') */
  readonly completedAt?: number;
  /** Number of retry attempts (incremented on each crash-recovery retry) */
  readonly retryCount?: number;
  /** Timestamp of last retry attempt */
  readonly lastRetryAt?: number;
  /**
   * Fields required for crash recovery retry (populated at intent time):
   * Without these, a 'pending' entry found on load() cannot be retried
   * because the original transfer data may no longer be available.
   */
  /** Recipient address for the return transfer */
  readonly recipient: string;
  /** Amount to return (smallest units) */
  readonly amount: string;
  /** Coin ID */
  readonly coinId: string;
  /** Full memo string (e.g., "INV:abc...:RC") */
  readonly memo: string;
}

interface AutoReturnLedger {
  /**
   * Key: "{invoiceId}:{originalTransferId}"
   * Value: AutoReturnLedgerEntry
   *
   * Uses a write-first intent log pattern to prevent duplicate sends on crash:
   *
   * The full auto-return sequence (within the per-invoice serialization gate):
   * 1. Check ledger for (invoiceId, originalTransferId)
   * 2. If exists with status 'completed' -> skip (already returned)
   *    If exists with status 'pending' -> check if transfer landed (see step 3b)
   * 3a. Write ledger entry with status: 'pending', recipient, amount,
   *     coinId, and memo fields, then persist
   * 3b. Call PaymentsModule.send() to return tokens
   * 4. Update ledger entry to status: 'completed' with returnTransferId
   * 5. Fire 'invoice:auto_returned' event
   *
   * On crash recovery (during load()), scan for 'pending' entries:
   * - Check if the return transfer landed (via getHistory())
   * - If found -> update to 'completed'
   * - If not found -> retry using the persisted recipient/amount/coinId/memo
   *
   * This intent-log pattern ensures that re-delivery of the original inbound
   * event hits step 2 and skips, preventing duplicate returns entirely.
   *
   * **Pruning:** On `load()`, after crash recovery, remove all `completed`
   * entries older than 30 days (`completedAt < Date.now() - 30*86400000`).
   * This bounds ledger growth while retaining enough history for dedup
   * of delayed Nostr re-deliveries. Pending entries are never pruned.
   *
   * **Secondary dedup (defense-in-depth):** Before executing any auto-return
   * send, check `getHistory()` for an existing outbound `:RC`/`:RX` transfer
   * whose memo freeText contains the `originalTransferId`. The match tuple is
   * `(invoiceId, originalTransferId)` — derived by parsing the outbound memo
   * and extracting the freeText field which auto-return populates with the
   * original transfer ID (see §4.6 buildInvoiceMemo). If a match is found,
   * skip the send and write the ledger entry as `completed` with the existing
   * return transfer ID. This prevents duplicate returns when ledger entries
   * have been pruned (e.g., Nostr re-delivery after 30+ days offline).
   *
   * **Why not (invoiceId, senderAddress, coinId)?** A coarse tuple would
   * falsely suppress a legitimate second auto-return when the same sender
   * sends two separate forward payments for the same coinId. The per-transfer
   * match ensures each forward payment is independently trackable.
   */
  entries: Record<string, AutoReturnLedgerEntry>;
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
  2. Scan history for pre-existing payments     // retroactive via processTokenTransactions() (§5.4.3)
  3. If immediately reaches CLOSED (all covered + all confirmed):
     -> acquire per-invoice gate, re-verify by full recomputation,
        freeze balances and persist to FROZEN_BALANCES,
        trigger surplus auto-return if enabled (see §5.1 step 7c)
  4. Fire events                                 // created + any retroactive events

importInvoice():
  1. tokenStorage.saveToken(invoiceToken)       // same as any received token
  2. Scan history for pre-existing payments     // retroactive via processTokenTransactions() (§5.4.3)
  3. If immediately reaches CLOSED:
     -> acquire per-invoice gate, re-verify, freeze balances and persist,
        trigger surplus auto-return if enabled
  4. Fire events                                 // any retroactive events

closeInvoice():
  1. Compute current balances one final time
  2. Reset per-sender balances for frozen snapshot:
     a. Set all pre-closure per-sender netBalance to '0' (payments accepted as final)
     b. For EACH target:coinId with surplusAmount > 0:
        - Identify the latest sender FOR THIS target:coinId: the sender whose
          forward payment for this specific target:coinId was being processed
          inside the per-invoice gate when the close condition was met
          (for implicit close) or the sender of the most recent forward
          transfer for this target:coinId by timestamp, with ties broken by
          transferId lexicographic order (for explicit close).
          NOTE: "timestamp" is the processing-time timestamp set by
          `processTokenTransactions()` step 6e (`Date.now()` at indexing time),
          NOT the transfer's creation time on the sender's clock. Out-of-order
          Nostr delivery means "latest" is "most recently processed by the
          local node" — this is consistent with implicit close (which uses
          processing order inside the gate) and is deterministic regardless
          of Map iteration order or restart state.
          Different target:coinId pairs may have different latest senders.
        - Assign surplusAmount as that sender's frozenSenderBalance.netBalance
        - Store latestSenderAddress in FrozenCoinAssetBalances (for crash recovery)
     c. Store frozenSenderBalances[] in FrozenCoinAssetBalances
  3. Add invoiceId to CLOSED_INVOICES set in storage (MUST complete before step 4).
     **Write order rationale:** Terminal set is written FIRST because the inverse
     reconciliation path (load() step 4c: invoice in terminal set but no frozen
     balances) recomputes balances from history losslessly — only the latest-sender
     assignment uses a heuristic. The forward reconciliation path (load() step 4b:
     frozen balances exist but not in terminal set) is also lossless. Writing the
     terminal set first means a crash between steps 3 and 4 triggers the inverse
     path, which is recoverable. The opposite order (frozen first, terminal second)
     would also be recoverable via forward reconciliation, but the inverse path
     is the more thoroughly tested recovery scenario.
  4. Persist frozen balances to FROZEN_BALANCES storage with `explicitClose: true`
  5. If options.autoReturn:
     -> enable auto-return for this invoice
     -> immediately return SURPLUS ONLY to the latest sender (from step 2b).
        This is a single return per target:coinId with surplus.
        Dedup key: `(invoiceId, "CLOSE_IMMEDIATE:<targetAddress>:<senderAddress>:<coinId>")`
        follows the same intent-log pattern as ongoing auto-return (§7.5).
     -> use :RC memo direction
     -> Partial failure semantics: same as cancelInvoice() — completed returns
        are recorded, failed returns remain as 'pending' for crash recovery retry.
  6. Fire 'invoice:closed' { explicit: true }
  7. Fire 'invoice:auto_returned' for each successful surplus return (if any)
  8. Fire 'invoice:auto_return_failed' for each failed return

cancelInvoice():
  1. Load cancelled set from storage
  2. Compute current balances one final time
     Per-sender balances are PRESERVED as-is (unlike closeInvoice which resets them).
     Each sender's full senderNetBalance is stored in frozenSenderBalances[].
  3. Add invoiceId to CANCELLED_INVOICES set in storage (MUST complete before step 4).
     (Same write-order rationale as closeInvoice — terminal set first.)
  4. Persist frozen balances to FROZEN_BALANCES storage
  5. If options.autoReturn:
     -> enable auto-return for this invoice
     -> immediately return EVERYTHING: decompose into individual returns
        per sender. For each target:coinId, iterate all senders with
        senderNetBalance > 0 and return each sender's full senderNetBalance.
        Each individual return uses a synthetic dedup key:
        `(invoiceId, "CANCEL_IMMEDIATE:<targetAddress>:<senderAddress>:<coinId>")`
        and follows the same intent-log pattern as ongoing auto-return (§7.5).
     -> use :RX memo direction
     -> **Partial failure semantics:** If some returns succeed and others fail
        (e.g., insufficient tokens for a different coinId), the completed returns
        are recorded as 'completed' in the dedup ledger. Failed returns remain
        as 'pending' entries with recipient/amount/coinId/memo fields, and are
        retried on next `load()` crash recovery (§7.6 step 5). The invoice
        still transitions to CANCELLED regardless of return success.
  6. Fire 'invoice:cancelled'
  7. Fire 'invoice:auto_returned' for each successful return
  8. Fire 'invoice:auto_return_failed' for each failed return

getInvoiceStatus():
  1. Read token from tokenStorage (parse terms from genesis.data.tokenData)
  2. Check cancelled set and closed set
  3. If terminal -> load frozen balances from FROZEN_BALANCES, return frozen status
  4. Read from invoice-transfer index: entries = invoiceLedger.get(invoiceId)
     (No history scan — the index is the primary data source, see §5.4)
  5. Compute status from index entries using balanceCache (§5.4.6)
  6. If just reached implicit CLOSED -> freeze and persist

setAutoReturn():
  1. Load AUTO_RETURN from storage
  2. Update global flag or per-invoice entry
     - Precedence: perInvoice[id] ?? global
     - Setting perInvoice[id] = false overrides global = true for that invoice
  3. Persist to storage
  4. If enabling (enabled=true):
     a. **Reset failed entries:** For the target invoice(s), scan the dedup ledger
        and reset any entries with status='failed' back to status='pending' with
        retryCount=0. Persist the updated ledger. This is the ONLY mechanism
        to retry failed auto-returns — the ongoing event handler (§6.2 step 5)
        skips both 'completed' and 'failed' entries.
     b. Trigger immediate auto-return for applicable invoices
     (within per-invoice serialization gate, checking dedup ledger for each):
     - For specific invoiceId: if terminated AND wallet is a target:
       - CLOSED -> return surplus only (per target:asset)
       - CANCELLED -> return everything
     - For '*': iterate all terminated invoices sequentially, each with its own gate.
       **Bounded execution:** Process at most 100 invoices per `setAutoReturn('*')`
       call. If more terminated invoices exist, the remainder are processed on
       the next call or on future inbound events. This prevents unbounded
       execution time when thousands of terminated invoices exist. Progress is
       tracked via the dedup ledger (completed entries are skipped on retry).
       **Cooldown:** Implementations MUST enforce a minimum 5-second cooldown
       between `setAutoReturn('*')` calls to prevent tight-loop abuse.
       Calls within the cooldown window are rejected with `RATE_LIMITED`.
       The caller receives the count of invoices processed and remaining via
       the returned promise (future: consider returning a progress object).
       - CLOSED -> return surplus only
       - CANCELLED -> return everything
  5. Fire 'invoice:auto_returned' for each return executed

load():
  1. Enumerate tokens from tokenStorage
  2. Filter by tokenType === INVOICE_TOKEN_TYPE_HEX
  3. Parse InvoiceTerms from each token's genesis.data.tokenData
  4. Load cancelled set, closed set, frozen balances, auto-return settings, and dedup ledger from storage.
     **Corruption resilience:** If any storage key fails to parse (JSON.parse throws),
     treat the value as empty/missing and log a warning. For FROZEN_BALANCES corruption:
     affected invoices fall through to the inverse reconciliation path (step 4c) which
     recomputes balances from history. For terminal set corruption: perform a forward
     scan of FROZEN_BALANCES to rebuild the missing terminal set (each frozen entry
     contains a `state` field indicating CLOSED or CANCELLED).
  4b. **Storage reconciliation (forward):** Scan FROZEN_BALANCES for any invoiceId
      that exists in frozen balances but NOT in the corresponding terminal set
      (CLOSED_INVOICES or CANCELLED_INVOICES). This handles crash between
      writing frozen balances and updating the terminal set. For each orphan:
      - Read `FrozenInvoiceBalances.state` ('CLOSED' or 'CANCELLED')
      - Add the invoiceId to the matching terminal set and persist
      - Fire the corresponding retroactive terminal event:
        'invoice:closed' (with explicit from frozen data) or 'invoice:cancelled'
        (consumers that missed the event due to the original crash now receive it)
  4c. **Storage reconciliation (inverse):** Scan CLOSED_INVOICES and
      CANCELLED_INVOICES for any invoiceId that exists in a terminal set but
      has NO entry in FROZEN_BALANCES. This handles the crash between writing
      the terminal set and writing frozen balances (possible if write order
      is not guaranteed by the storage provider). For each orphan:
      - Recompute balances from history (same formula as non-terminal status
        computation — the balance formula is state-agnostic)
      - For CLOSED invoices: the per-sender reset and latest-sender assignment
        cannot be fully reconstructed from history alone (processing order is
        lost). Use a conservative fallback: assign surplus to the sender with
        the highest forwarded amount for each target:coinId (deterministic,
        though may differ from original processing order). Persist the
        `latestSenderAddress` field in `FrozenCoinAssetBalances` with the
        fallback value, and log a warning noting the approximation.
      - Persist as FrozenInvoiceBalances with `state` set based on which
        terminal set the invoice belongs to (CLOSED or CANCELLED)
      - The `state` field (not the balance values) drives auto-return
        semantics: CLOSED → surplus only, CANCELLED → everything
      This ensures storage is consistent before proceeding.
  5. **Crash recovery:** Scan dedup ledger for 'pending' entries. For each:
     - Check if the return transfer landed (via getHistory())
     - If found -> update to 'completed'
     - If not found AND retryCount < 5 -> increment retryCount, set lastRetryAt,
       retry using persisted recipient/amount/coinId/memo fields (within per-invoice gate)
     - If not found AND retryCount >= 5 -> transition to 'failed' status,
       fire 'invoice:auto_return_failed' with reason 'max_retries_exceeded'.
       The user can manually retry via returnInvoicePayment() or re-enable
       auto-return via setAutoReturn(invoiceId, true) which re-triggers
       failed entries (resets retryCount to 0, status back to 'pending').
     'failed' entries are never pruned (unlike 'completed' entries).
  6. **Populate invoice-transfer index** (§5.4.4):
     a. Load persisted index state:
        - Load INV_LEDGER_INDEX → populate invoiceLedger outer map (keys only)
        - Load inv_ledger:{invoiceId} for each invoice → populate transfer Maps
        - Load TOKEN_SCAN_STATE → populate tokenScanState
        - Rebuild tokenInvoiceMap from loaded transfer entries
     b. Scan token transaction tails (gap fill):
        - allTokens = PaymentsModule.getTokens()
        - For each token T:
          · txf = JSON.parse(T.sdkData) as TxfToken
          · startIndex = tokenScanState.get(T.id) ?? 0
          · If txf.transactions.length > startIndex:
            → processTokenTransactions(T, startIndex) — see §5.4.3
        - Flush dirty invoice entries to storage
        - Persist updated tokenScanState
     c. **Corruption resilience for index:** If INV_LEDGER_INDEX or
        TOKEN_SCAN_STATE fails to parse, reset to empty and rescan all
        tokens from transaction index 0. If inv_ledger:{invoiceId} fails
        to parse, delete the corrupted key and reset tokenScanState entries
        for tokens referencing that invoice. Dedup in processTokenTransactions()
        prevents duplicate entries on rescan.
  7. Subscribe to PaymentsModule events
  8. Fire retroactive events for any transfers discovered during index gap fill

**Required ordering:** Steps 4-6 (reconciliation, crash recovery, index build) MUST
complete before step 7 (event subscription). This prevents races between recovery
retries and incoming event processing for the same transfer — both would enter the
per-invoice gate, but recovery must finish first to populate the dedup ledger.

**Load-subscribe gap:** Tokens may arrive between step 6 (scan) and step 7
(subscription). After subscribing, perform a **one-time re-scan** of all tokens
to catch any transfers that arrived during the gap:
  7b. allTokens = PaymentsModule.getTokens()
      For each token T:
        startIndex = tokenScanState.get(T.id) ?? 0
        If txf.transactions.length > startIndex:
          → processTokenTransactions(T, startIndex)
      Flush dirty entries and update tokenScanState.
This re-scan is idempotent (dedup by transferId::coinId) and closes the window
between the initial scan and the subscription becoming active.
```

#### Invoice-Transfer Index (Primary Data Source)

The module maintains a **persistent invoice-transfer index** as the primary data source for all non-terminal invoice balance computation. See §5.4 for the complete index architecture, data structures, population strategy, and query patterns.

```typescript
// Primary index: per-invoice transfer ledger
// entryKey = `${transferId}::${coinId}` (composite dedup key)
private invoiceLedger: Map<string, Map<string, InvoiceTransferRef>>;

// Token scan watermark — tracks processed tx count per token
private tokenScanState: Map<string, number>;

// Secondary: token → invoice mapping (rebuilt on load, not persisted)
private tokenInvoiceMap: Map<string, Set<string>>;

// Computed balance cache (invalidated on mutation, not persisted)
// See InvoiceBalanceSnapshot: aggregate per (target, coinId) + perSender per (target, sender, coinId)
private balanceCache: Map<string, InvoiceBalanceSnapshot>;
```

**Key properties:**

- **Persistent and partitioned:** Each invoice's transfer entries are stored under a separate key (`inv_ledger:{invoiceId}`). This allows targeted reads/writes without loading the entire dataset. **Growth bound:** For invoices with very high transfer counts (thousands of micro-payments), the per-invoice key may grow large. Implementations SHOULD monitor per-key size and log a warning when an `inv_ledger:{invoiceId}` entry exceeds 1MB. No automatic compaction is specified — the partitioned design ensures that large invoices do not impact reads of other invoices.
- **Idempotent updates by (transferId, coinId):** The composite dedup key ensures that reprocessing the same transfer is a no-op. This is critical because `returnInvoicePayment()` synchronously updates the index after `send()` (§5.9), and the subsequent async event must not produce a duplicate.
- **Terminal invoices included:** The index records ALL invoice-related transfers regardless of terminal state. Frozen balances are a separate point-in-time snapshot. The index powers `getRelatedTransfers()` (complete picture); frozen balances power `getInvoiceStatus()` for terminal invoices (snapshot at termination).
- **Multi-asset correctness:** Each transfer is expanded into per-coin entries at processing time using the token's full `coinData` from `TxfToken.genesis.data.coinData`. Once captured, no token lookup is needed at query time.
- **Incremental via watermark:** The `tokenScanState` map tracks how many `TxfToken.transactions[]` entries have been processed per token. On restart, only the tail of each token's transaction array is scanned. On a warm start with no new transactions, gap processing does a single Map lookup per token.
- **Retroactive on create/import:** On `createInvoice()` / `importInvoice()`, the full history is scanned for pre-existing payments referencing the new invoice. Each match goes through `processTokenTransactions()` (§5.4.3), which respects the dedup key.

#### Storage Efficiency Estimates

| Component | Per-entry size | Typical scale | Total |
|-----------|---------------|---------------|-------|
| InvoiceTransferRef (JSON) | ~400–500 bytes | 1000 invoices × 20 entries | ~10 MB |
| Token scan state | ~80 bytes/token | 5,000 tokens | ~400 KB |
| Invoice ledger index | ~80 bytes/invoice | 1000 invoices | ~80 KB |

Per-invoice partitioned storage means any single read/write operation touches at most one invoice's data. IndexedDB (browser) and file-based storage (Node.js) handle this scale without issue.

#### Crash Recovery

**Storage write order** (on flush):
1. Write `inv_ledger:{invoiceId}` for each dirty invoice
2. Write `token_scan_state`
3. Write `inv_ledger_index`

If the process crashes after step 1 but before step 2, the next cold start will reprocess some token transactions from the tail. The dedup check on `${transferId}::${coinId}` inside `processTokenTransactions()` catches duplicates — the ledger is the source of truth.

**Corruption recovery:**
- If `inv_ledger:{invoiceId}` is corrupted: log warning, delete key, reset tokenScanState entries for tokens referencing that invoice, rescan their transactions from index 0.
- If `token_scan_state` is corrupted: reset to empty, rescan all tokens from transaction index 0. Dedup in `processTokenTransactions()` prevents duplicate ledger entries. This is O(all tokens × all transactions) but recovers correctly.
- If `inv_ledger_index` is corrupted: rebuild from `inv_ledger:*` keys discovered via storage enumeration.

---

## 8. Validation Rules

### 8.1 CreateInvoiceRequest Validation

| Rule | Error |
|------|-------|
| `targets` must be non-empty | `INVOICE_NO_TARGETS` |
| Each target must have a valid DIRECT:// address | `INVOICE_INVALID_ADDRESS` |
| Each target must have at least one asset | `INVOICE_NO_ASSETS` |
| Each asset must have exactly one of `coin` or `nft` set | `INVOICE_INVALID_ASSET` |
| Each coin asset's amount (tuple index 1) must be a positive integer string, max 78 digits | `INVOICE_INVALID_AMOUNT` |
| Each coin asset's coinId (tuple index 0) must be non-empty, alphanumeric only (`/^[A-Za-z0-9]+$/`), max 20 characters | `INVOICE_INVALID_COIN` |
| Each NFT asset's tokenId must be non-empty (64-char hex) | `INVOICE_INVALID_NFT` |
| `dueDate` (if provided) must be in the future | `INVOICE_PAST_DUE_DATE` |
| `deliveryMethods` entries (if provided) must use `https://` or `wss://` scheme only, max 2048 chars each, max 10 entries | `INVOICE_INVALID_DELIVERY_METHOD` |
| Oracle provider must be available | `INVOICE_ORACLE_REQUIRED` |
| Aggregator submission failure (after retries) | `INVOICE_MINT_FAILED` |
| No duplicate addresses across targets | `INVOICE_DUPLICATE_ADDRESS` |
| No duplicate coinIds within a single target's coin assets | `INVOICE_DUPLICATE_COIN` |
| No duplicate NFT tokenIds within a single target | `INVOICE_DUPLICATE_NFT` |
| Maximum 100 targets per invoice | `INVOICE_TOO_MANY_TARGETS` |
| Maximum 50 assets per target | `INVOICE_TOO_MANY_ASSETS` |
| `memo` (if provided) must be max 4096 characters | `INVOICE_MEMO_TOO_LONG` |
| Serialized InvoiceTerms (`canonicalSerialize(terms)`) must not exceed 64 KB | `INVOICE_TERMS_TOO_LARGE` |

**Note on inbound transfer amounts:** Coin entries with amount `"0"` in incoming token coinData are silently excluded from balance computation by the `processTokenTransactions()` regex validation (`/^[1-9][0-9]*$/` in §5.4.3 step 6a). This is correct — zero-value entries carry no economic value. No error is raised; the entry is simply skipped.

### 8.2 Import Validation

| Rule | Error |
|------|-------|
| Token must have valid inclusion proof | `INVOICE_INVALID_PROOF` |
| Token type must be `INVOICE_TOKEN_TYPE_HEX` | `INVOICE_WRONG_TOKEN_TYPE` |
| Token's `genesis.data.tokenData` must parse as valid InvoiceTerms | `INVOICE_INVALID_DATA` |
| Parsed InvoiceTerms must pass full business validation (non-empty targets, valid addresses, positive amounts, no duplicate addresses/coins — same rules as §8.1 CreateInvoiceRequest, except `dueDate` may be in the past for imported invoices) | `INVOICE_INVALID_DATA` |
| `createdAt` must be a positive integer not exceeding `Date.now() + 86400000` (1-day clock skew tolerance). `dueDate` (if present) must be a positive integer. | `INVOICE_INVALID_DATA` |
| Invoice token must not already exist in local TokenStorage | `INVOICE_ALREADY_EXISTS` |

### 8.3 Close Validation

| Rule | Error |
|------|-------|
| Invoice token must exist locally | `INVOICE_NOT_FOUND` |
| Caller must be a target: the `directAddress` of ANY tracked address from `getActiveAddresses()` must match one of the `targets[].address` entries in the invoice terms. Note: `targets[].address` is a `DIRECT://` address — compare against `TrackedAddress.directAddress`, NOT `chainPubkey`. | `INVOICE_NOT_TARGET` |
| Invoice must not already be CLOSED | `INVOICE_ALREADY_CLOSED` |
| Invoice must not already be CANCELLED | `INVOICE_ALREADY_CANCELLED` |

### 8.4 Cancel Validation

| Rule | Error |
|------|-------|
| Invoice token must exist locally | `INVOICE_NOT_FOUND` |
| Caller must be a target: the `directAddress` of ANY tracked address from `getActiveAddresses()` must match one of the `targets[].address` entries in the invoice terms. Note: `targets[].address` is a `DIRECT://` address — compare against `TrackedAddress.directAddress`, NOT `chainPubkey`. | `INVOICE_NOT_TARGET` |
| Invoice must not already be CLOSED (computed) | `INVOICE_ALREADY_CLOSED` |
| Invoice must not already be cancelled | `INVOICE_ALREADY_CANCELLED` |

### 8.5 Pay Invoice Validation

| Rule | Error |
|------|-------|
| Invoice token must exist locally | `INVOICE_NOT_FOUND` |
| Invoice must NOT be in a terminal state (CLOSED or CANCELLED) | `INVOICE_TERMINATED` |
| `targetIndex` must be valid | `INVOICE_INVALID_TARGET` |
| `assetIndex` must be valid (if provided) | `INVOICE_INVALID_ASSET_INDEX` |

**Downstream errors:** `payInvoice()` and `returnInvoicePayment()` delegate to `PaymentsModule.send()`, which may throw its own errors (insufficient balance, network failure, etc.). These errors pass through to the caller unchanged — the accounting module does not wrap them.

### 8.6 Return Invoice Payment Validation

| Rule | Error |
|------|-------|
| Invoice token must exist locally | `INVOICE_NOT_FOUND` |
| Caller's wallet address must match one of the invoice targets | `INVOICE_NOT_TARGET` |
| Return amount must not exceed the effective per-sender net balance for `(target=caller's address, sender=params.recipient, coinId=params.coinId)`. **For non-terminal invoices:** `senderNetBalance` from the live balance index. **For CLOSED invoices:** the frozen baseline starts at zero for all senders except the latest sender who gets the surplus (see §7.6 `closeInvoice()` step 2). The effective returnable is: `frozenSenderBalance.netBalance + sum(post-freeze forwards from this sender) - sum(post-freeze returns to this sender)`. Pre-closure payments are non-returnable. **For CANCELLED invoices:** the frozen baseline preserves each sender's full pre-cancellation balance. The effective returnable is: `frozenSenderBalance.netBalance + sum(post-freeze forwards from this sender) - sum(post-freeze returns to this sender)`. Post-freeze transfers are identified by **set difference**: entries in the live `invoiceLedger` whose `entryKey` does not appear in the frozen snapshot's transfers (NOT by timestamp comparison — see §7.3). **Note:** This balance check executes inside the per-invoice gate (§5.9), ensuring the in-memory index is consistent — no concurrent return can modify it between this check and the subsequent `send()`. | `INVOICE_RETURN_EXCEEDS_BALANCE` |

### 8.7 setAutoReturn Validation

| Rule | Error |
|------|-------|
| For specific invoiceId (not `'*'`): invoice token must exist locally | `INVOICE_NOT_FOUND` |

### 8.8 getInvoiceStatus / getRelatedTransfers Validation

| Rule | Error |
|------|-------|
| Invoice token must exist locally | `INVOICE_NOT_FOUND` |

**Note:** `getRelatedTransfers()` throws `INVOICE_NOT_FOUND` for unknown invoices rather than returning an empty array, consistent with `getInvoiceStatus()`. This prevents silent failures when callers pass an incorrect invoice ID. `getInvoice()` returns `null` for unknown invoices (non-throwing, lightweight lookup).

---

## 9. Connect Protocol Extensions

**Teardown ordering:** Wallet hosts MUST stop dispatching new Connect RPC calls to the AccountingModule before calling `accounting.destroy()`. In-flight operations that already acquired the per-invoice gate will complete normally (destroy awaits all gate tails), but new operations entering after the `destroyed` flag is set will bail immediately.

### 9.1 New Query Methods

```typescript
// sphere_getInvoices
// Returns: InvoiceRef[] (without computed status)
// Params: GetInvoicesOptions (optional)
// Requires: invoice:read permission scope
{
  method: 'sphere_getInvoices',
  params: { state: 'OPEN', createdByMe: true, limit: 10 }
}

// sphere_getInvoiceStatus
// Returns: InvoiceStatus (computed fresh for non-terminal, frozen for terminal)
// Params: { invoiceId: string }
// Requires: invoice:read permission scope
//
// NOTE: sphere_getRelatedTransfers is intentionally NOT exposed via Connect.
// It returns detailed per-transfer data that should be consumed via
// getInvoiceStatus().targets[].coinAssets[].transfers instead.
// sphere_getAutoReturnSettings is also not exposed — auto-return is a
// wallet-level concern managed by the wallet host, not dApps.
//
// NOTE: This is a query method but it has a SIDE EFFECT. When the computed
// status reaches implicit close (all covered + all confirmed), this call
// triggers the freeze-and-persist operation and may trigger surplus auto-return
// (token sends). This is a known exception to the Connect Protocol's
// query/intent separation. The side effect only occurs once per invoice
// (subsequent calls return the frozen snapshot).
//
// WALLET HOST GUIDANCE: When getInvoiceStatus triggers implicit close, the
// entire operation — including surplus auto-return sends — completes inside
// the per-invoice gate before the query returns. This ensures atomicity: no
// other operation can interleave between freeze and auto-return. The Connect
// query blocks until the full close+auto-return sequence finishes. Wallet
// hosts MUST rate-limit sphere_getInvoiceStatus calls from dApps:
// - Max 1 call/second per invoiceId
// - Max 10 calls/second aggregate across all invoiceIds per session
// This is REQUIRED (not optional) to prevent a malicious dApp from:
// (a) triggering implicit close cascades by rapidly querying all invoices,
// (b) draining wallet funds via auto-return sends triggered by queries.
// A dApp with invoice:read permission can trigger fund-moving operations
// (auto-return sends) purely through queries — rate limiting is the primary
// defense against abuse. Without it, a polling loop can close every invoice
// and drain surplus funds without user confirmation.
// Note: getInvoiceStatus is classified as a QUERY (invoice:read permission),
// but its implicit close side effect can trigger token sends (auto-return).
// This is a known design trade-off — alternatives (separate explicit trigger,
// background timer) add complexity without solving the fundamental issue that
// close detection must happen somewhere. Wallet hosts MUST stop accepting
// new Connect RPC calls before calling accounting.destroy() to avoid
// in-flight operations racing with teardown.
//
// LATENCY: When implicit close triggers auto-return for multiple target:coinId
// pairs, each requires a PaymentsModule.send() network call. To bound query
// latency, the implicit close path MUST process at most MAX_SYNC_RETURNS (10)
// surplus pairs synchronously within the gate. Any remaining surplus pairs are
// queued as separate gate entries via setTimeout(0), each re-acquiring the
// per-invoice gate independently. The query returns after the synchronous batch
// completes. The remaining auto-returns execute asynchronously and may interleave
// with other gated operations on the same invoice (the gate is NOT held
// continuously across the setTimeout boundary). This caps worst-case synchronous
// query latency to ~600s (10 * 60s send timeout). Connect hosts SHOULD set
// response timeouts accordingly (recommended: 120s — if more than 2 surplus
// pairs exist, the query returns after the first batch and remaining auto-returns
// complete asynchronously).
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
    deliveryMethods: ['https://pay.example.com/inv/abc'], // optional placeholder
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
    freeText: 'Order #42', // optional free text appended to memo
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

// return_invoice_payment -- prompts user to confirm returning tokens
{
  action: 'return_invoice_payment',
  params: {
    invoiceId: 'abc123...',
    recipient: 'DIRECT://...',
    amount: '500000',
    coinId: 'UCT',
    freeText: 'Refund',   // optional
  }
}
// Returns: TransferResult (from PaymentsModule.send())

// set_auto_return -- prompts user to confirm auto-return toggle
{
  action: 'set_auto_return',
  params: {
    invoiceId: 'abc123...',  // or '*' for global
    enabled: true,
  }
}
// Returns: { success: true }
```

### 9.3 New Permission Scopes

```typescript
// Added to PermissionScope type
'invoice:read'                    // Read invoices and status
'intent:create_invoice'           // Create invoice intent
'intent:pay_invoice'              // Pay invoice intent
'intent:close_invoice'            // Close invoice intent
'intent:cancel_invoice'           // Cancel invoice intent
'intent:return_invoice_payment'   // Return invoice payment intent
'intent:set_auto_return'          // Set auto-return intent
```

### 9.4 New Events (Connect push)

```typescript
// dApps can subscribe via client.on(...)
// All invoice events from §6.1 are forwarded to Connect clients:
'invoice:created'          // Invoice token minted
'invoice:payment'          // When a payment matches an invoice
'invoice:asset_covered'    // One asset fully covered for one target
'invoice:target_covered'   // All assets for one target covered
'invoice:covered'          // When an invoice is fully covered
'invoice:closed'           // When an invoice transitions to CLOSED
'invoice:cancelled'        // When an invoice is cancelled
'invoice:expired'          // Due date passed (informational)
'invoice:unknown_reference' // Transfer references unknown invoice
'invoice:overpayment'      // Payment exceeds requested amount
'invoice:irrelevant'       // When a non-matching payment references an invoice
'invoice:auto_returned'    // When tokens are auto-returned for a terminated invoice
'invoice:auto_return_failed' // Auto-return failed
'invoice:return_received'  // When auto-return tokens are received
'invoice:over_refund_warning' // Total returned exceeds total forwarded (informational)
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
| `INVOICE_INVALID_COIN` | Coin ID must be non-empty, alphanumeric, max 20 chars | Invalid coinId format |
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
| `INVOICE_NOT_TARGET` | Only a target party can perform this operation | Close, cancel, or return by non-target party |
| `INVOICE_ALREADY_CLOSED` | Invoice is already closed | Close/cancel after CLOSED |
| `INVOICE_ALREADY_CANCELLED` | Invoice is already cancelled | Close/cancel after CANCELLED |
| `INVOICE_ORACLE_REQUIRED` | Oracle provider required for invoice minting | No oracle configured |
| `INVOICE_TERMINATED` | Cannot pay a terminated invoice (closed or cancelled) | Forward payment to terminated invoice |
| `INVOICE_INVALID_TARGET` | Invalid target index | Out-of-bounds targetIndex in payInvoice |
| `INVOICE_INVALID_ASSET_INDEX` | Invalid asset index | Out-of-bounds assetIndex in payInvoice |
| `INVOICE_RETURN_EXCEEDS_BALANCE` | Return amount exceeds the per-sender net balance for (target, sender, coinId). Returns MUST NOT cause returnedAmount to exceed coveredAmount. | Excessive return to a specific sender |
| `INVOICE_INVALID_DELIVERY_METHOD` | Delivery method must use https:// or wss:// scheme, max 2048 chars, max 10 entries | Invalid deliveryMethods entry |
| `INVOICE_INVALID_ID` | Invoice ID must be a 64-char hex string | Invalid invoiceId passed to buildInvoiceMemo |
| `INVOICE_TOO_MANY_TARGETS` | Invoice exceeds maximum of 100 targets | Too many targets in CreateInvoiceRequest |
| `INVOICE_TOO_MANY_ASSETS` | Target exceeds maximum of 50 assets | Too many assets in a single target |
| `INVOICE_MEMO_TOO_LONG` | Invoice memo exceeds maximum of 4096 characters | InvoiceTerms.memo too long |
| `INVOICE_TERMS_TOO_LARGE` | Serialized invoice terms exceed 64 KB limit | Aggregate size of all targets, assets, memo, deliveryMethods too large |
| `RATE_LIMITED` | Operation rate-limited, try again later | `setAutoReturn('*')` called within 5-second cooldown |
| `MODULE_DESTROYED` | AccountingModule is destroyed | Any public method called after `destroy()` completes |

Note: `INVOICE_INVALID_ID` and `INVOICE_MINT_FAILED` are thrown from internal utilities (`buildInvoiceMemo` and the minting flow respectively), not from §8 validation tables. They are included here for completeness.

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
--- Explicit Close with Auto-Return (surplus only, per-sender) ---

Invoice abc requests 1000 UCT from DIRECT://alice.
S1 sends 700 UCT (INV:abc:F) to alice.
S2 sends 500 UCT (INV:abc:F) to alice.
Total covered = 1200 UCT, surplus = 200 UCT.
S2 is the latest sender for (alice, UCT) — by processing order, S2's payment
was being processed when the total crossed the 1000 UCT threshold.

Alice closes invoice (satisfied with payments):
  -> closeInvoice('abc', { autoReturn: true })
  -> Per-sender balances RESET: S1=0, S2=0 (pre-closure payments accepted)
  -> Surplus 200 UCT assigned to latest sender S2
  -> frozenSenderBalances = [{ S1: netBalance="0" }, { S2: netBalance="200" }]
  -> Auto-return: returns 200 UCT to S2 with memo INV:abc:RC
  -> Fires invoice:closed { explicit: true }
  -> Fires invoice:auto_returned (200 UCT to S2)
  NOTE: S1's 700 is non-returnable (accepted). Only S2's surplus is returned.

--- Implicit Close with Race Condition (processing order matters) ---

Invoice xyz requests 1000 UCT from DIRECT://alice.
S1 sends 700 UCT (INV:xyz:F) to alice.  -> processIncomingTransfer() runs, total=700 (PARTIAL)
S2 sends 400 UCT (INV:xyz:F) to alice.  -> processIncomingTransfer() runs:
  -> enters per-invoice gate for xyz
  -> recomputes: total=1100, surplus=100, all confirmed
  -> S2 is the "latest sender" (S2's payment is inside the gate when close triggers)
  -> freeze: S1=0, S2=0 (reset), surplus 100 assigned to S2
  -> frozenSenderBalances = [{ S1: netBalance="0" }, { S2: netBalance="100" }]
  -> fires invoice:closed { explicit: false }

Meanwhile, S3 sends 200 UCT (INV:xyz:F) WHILE S2's close sequence is inside the gate:
  -> S3's processIncomingTransfer() queues behind the gate
  -> gate releases after close completes
  -> S3's payment is now processed as POST-CLOSURE
  -> S3's per-sender balance = 200 (0 baseline + 200 new) — NOT reset to 0
  -> if auto-return enabled: returns 200 UCT to S3 with INV:xyz:RC

CRITICAL: S3 is NOT the "latest sender" even if S3's payment arrived before
the close completed. Processing order is what matters — S2's payment was
inside the gate when the close triggered; S3's payment queued behind it.

--- Explicit Close with Auto-Return (continued) ---

Later, S1 sends 500 UCT with memo INV:abc:F (unaware of closure):
  -> Token transfer succeeds (inbound transfers are NEVER blocked)
  -> Post-closure per-sender balance: S1 now has 500 (0 baseline + 500 new)
  -> Auto-return enabled -> entire 500 UCT returned to S1 with INV:abc:RC
  -> Fires invoice:auto_returned

Later, S3 sends 300 UCT with INV:abc:F:
  -> Post-closure: S3 has 300 (new sender, 0 baseline + 300 new)
  -> Auto-return -> 300 UCT returned to S3 with INV:abc:RC

Sender receives the auto-return (INV:abc:RC):
  -> Fires invoice:return_received { returnReason: 'closed' }
  -> If autoTerminateOnReturn is true:
     -> Sender's module auto-closes invoice abc locally
        (even though the invoice may not appear fully covered from the sender's view —
         the target decided to close, and the sender accepts the implicit signal)

--- Over-Refund Warning ---

Invoice xyz: target alice manually returns 600 UCT to S1 with INV:xyz:B,
but S1 only sent 400 UCT to alice.
  -> S1's module detects: returned (600) > forwarded (400)
  -> Fires invoice:over_refund_warning { senderAddress: S1, coinId: 'UCT',
     forwardedAmount: '400', returnedAmount: '600' }
  -> Transfer is NOT blocked — warning is informational only.

--- Cancellation with Auto-Return (everything, per-sender) ---

Invoice abc requests 1000 UCT from DIRECT://alice.
S1 sends 400 UCT (INV:abc:F) to alice.
S2 sends 200 UCT (INV:abc:F) to alice.
Total covered = 600 UCT (partially covered).

Alice cancels invoice (abandoning the deal):
  -> cancelInvoice('abc', { autoReturn: true })
  -> Per-sender balances PRESERVED: S1=400, S2=200
  -> frozenSenderBalances = [{ S1: netBalance="400" }, { S2: netBalance="200" }]
  -> Auto-return: returns 400 UCT to S1, 200 UCT to S2 (each gets their full balance)
     with memo INV:abc:RX (return-for-cancelled)
  -> Fires invoice:cancelled
  -> Fires invoice:auto_returned (400 to S1, 200 to S2)
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
