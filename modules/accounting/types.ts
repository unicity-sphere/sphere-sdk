/**
 * Accounting Module Type Definitions
 *
 * All types for the AccountingModule: invoices, status, receipts,
 * cancellation notices, storage schemas, and method parameters.
 *
 * @see docs/ACCOUNTING-SPEC.md
 */

import type { FullIdentity, TrackedAddress, SphereEventType, SphereEventMap, TransferResult, Token } from '../../types';
import type { TxfToken } from '../../types/txf';
import type { StorageProvider, TokenStorageProvider } from '../../storage/storage-provider';
import type { OracleProvider } from '../../oracle/oracle-provider';
import type { PaymentsModule } from '../payments/PaymentsModule';
import type { CommunicationsModule } from '../communications/CommunicationsModule';

// =============================================================================
// §1.1 Shared Asset Types (reused from TXF genesis coinData format)
// =============================================================================

/**
 * A fungible coin entry — same [coinId, amount] tuple used in TxfGenesisData.coinData.
 *
 * Examples: ["UCT", "1000000"], ["USDU", "500000000"], ["ALPHA", "200000"]
 *
 * This is the EXISTING format from TxfGenesisData.coinData: [string, string][].
 * Invoice targets reuse this exact type for consistency.
 */
export type CoinEntry = [string, string]; // [coinId, amount in smallest units]

/**
 * An NFT entry — placeholder for future NFT support (not yet implemented in Sphere SDK).
 * Same type will be used in both token genesis and invoice targets when NFTs are added.
 */
export interface NFTEntry {
  /** Unique NFT token ID (64-char hex) */
  readonly tokenId: string;
  /** NFT type identifier (64-char hex, optional) */
  readonly tokenType?: string;
}

// =============================================================================
// §1.2 Invoice Types
// =============================================================================

/**
 * A single requested asset in an invoice target.
 * Wraps either a CoinEntry (fungible) or NFTEntry (non-fungible).
 * Exactly one of `coin` or `nft` must be set.
 */
export interface InvoiceRequestedAsset {
  /** Fungible token request — same [coinId, amount] tuple as genesis coinData */
  readonly coin?: CoinEntry;
  /** NFT request (placeholder — not yet implemented) */
  readonly nft?: NFTEntry;
}

/**
 * A payment target within an invoice.
 * Each target specifies a destination address and the assets it should receive.
 */
export interface InvoiceTarget {
  /** Destination address (DIRECT://... format) */
  readonly address: string;
  /** Requested assets for this address */
  readonly assets: InvoiceRequestedAsset[];
}

/**
 * Invoice terms — the payload serialized into the token's genesis.data.tokenData field.
 * This is the complete invoice definition. The token IS the invoice.
 */
export interface InvoiceTerms {
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
export interface CreateInvoiceRequest {
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

// =============================================================================
// §1.3 Invoice Status Types
// =============================================================================

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
export type InvoiceState = 'OPEN' | 'PARTIAL' | 'COVERED' | 'CLOSED' | 'CANCELLED' | 'EXPIRED';

/**
 * Balance breakdown for a single sender contributing to a target:coinId.
 * Tracks how much this sender has forwarded and how much has been returned to them.
 */
export interface InvoiceSenderBalance {
  /**
   * Effective sender address (DIRECT:// format).
   * This is the per-sender balance key: `refundAddress ?? senderAddress` from the
   * transfer's InvoiceTransferRef. Refund address takes priority — if the payer
   * provided a refund address, that IS their identity for per-sender keying,
   * regardless of whether the sender's predicate is masked or unmasked.
   * Use `isRefundAddress` to distinguish.
   */
  readonly senderAddress: string;
  /**
   * True when `senderAddress` actually contains a refund address (the sender
   * provided `inv.ra`). False or undefined when no refund address was provided
   * and senderAddress was derived from the sender's predicate.
   */
  readonly isRefundAddress?: boolean;
  /**
   * Sender's chain pubkey (if known). Null when the sender's predicate was
   * masked (identity unresolvable on-chain). May be present even when
   * `isRefundAddress` is true — an unmasked sender who provides a refund
   * address has both a resolvable pubkey and isRefundAddress=true.
   */
  readonly senderPubkey?: string;
  /** Sender's nametag (if known) */
  readonly senderNametag?: string;
  /**
   * All unique contact info entries provided by the sender across transfers
   * (from on-chain TransferMessagePayload `inv.ct`).
   *
   * ALWAYS present (never undefined). Empty array if no contacts were provided.
   * Contacts are accumulated from all transfers by this effective sender —
   * different transfers may carry different contact info, and all unique entries
   * are preserved up to a maximum of 10 per sender (storage amplification defense).
   * Deduplication key: `${address}\0${url ?? ''}` (normalized, not JSON.stringify —
   * avoids key-ordering sensitivity). Two entries with the same address but
   * different url values are both kept.
   *
   * Contact is informational only — does not affect balance computation or per-sender keying.
   *
   * SECURITY: contact.address is self-asserted by the payer. Applications MUST NOT
   * trust it as identity verification. A malicious payer can set any DIRECT:// address
   * as their contact. Use out-of-band verification for identity-sensitive operations.
   */
  readonly contacts: ReadonlyArray<{ address: string; url?: string }>;
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
 *   surplusAmount = max(0, netCoveredAmount - requestedAmount) // overpayment beyond requested
 *
 * Note: These balances reflect memo-referenced transfers only.
 * Whether the underlying tokens are still in the wallet is irrelevant.
 */
export interface InvoiceCoinAssetStatus {
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
export interface InvoiceNFTAssetStatus {
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
export interface InvoiceTargetStatus {
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
export interface InvoiceTransferRef {
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
  /**
   * Sender's DIRECT:// address (derived from senderPubkey).
   * Null if the sender's predicate is masked (owner hidden on-chain).
   * Transfers with null senderAddress cannot participate in self-payment
   * detection or return matching — they are indexed but treated as
   * having an unknown sender for balance purposes.
   */
  readonly senderAddress: string | null;
  /**
   * Refund address extracted from the on-chain TransferMessagePayload `inv.ra` field.
   * Provides an explicit return destination for the payer. Essential for masked-predicate
   * senders (one-time address that becomes unresolvable), but also used by unmasked
   * senders who want returns sent to a different address than their sender address.
   * When present, takes priority over senderAddress for per-sender balance keying
   * (effectiveSender = refundAddress ?? senderAddress).
   * Undefined if not present in the on-chain payload.
   */
  readonly refundAddress?: string;
  /**
   * Contact info provided by the sender (from on-chain TransferMessagePayload `inv.ct`).
   * Allows the invoice target to reach the payer for receipts, cancellation notices,
   * or payment reminders. Undefined if not present in the on-chain payload.
   *
   * `address`: a reachable DIRECT:// address for the payer.
   * `url`: optional non-Nostr transport URL (https:// or wss://).
   *
   * NOT included in the transport memo (same privacy model as refund address).
   */
  readonly contact?: { address: string; url?: string };
  /** Sender chain pubkey (null if predicate is masked, undefined if not extracted) */
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
export interface IrrelevantTransfer extends InvoiceTransferRef {
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
export interface InvoiceStatus {
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

// =============================================================================
// §1.4 Result Types
// =============================================================================

/**
 * Result of invoice creation.
 */
export interface CreateInvoiceResult {
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
export interface GetInvoicesOptions {
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
export interface InvoiceRef {
  /** Invoice token ID */
  readonly invoiceId: string;
  /** Parsed invoice terms from token genesis */
  readonly terms: InvoiceTerms;
  /**
   * Whether this wallet created the invoice (based on terms.creator matching identity).
   * For anonymous invoices (terms.creator is undefined), this is always false — even
   * for the wallet that created the invoice.
   */
  readonly isCreator: boolean;
  /** Whether this invoice has been locally cancelled */
  readonly cancelled: boolean;
  /** Whether this invoice has been locally closed (explicitly or implicitly via all-covered+confirmed) */
  readonly closed: boolean;
}

/**
 * Auto-return settings for terminated invoices.
 */
export interface AutoReturnSettings {
  /** Global auto-return flag for all terminated invoices */
  readonly global: boolean;
  /** Per-invoice auto-return overrides (invoiceId -> enabled) */
  readonly perInvoice: Record<string, boolean>;
}

// =============================================================================
// §1.5 Receipt Types (Invoice Receipt DMs)
// =============================================================================

/**
 * Structured payload inside a receipt DM content field.
 * Sent by a target to each payer after invoice close or cancel.
 * Wire format: `invoice_receipt:` prefix + JSON.stringify(InvoiceReceiptPayload).
 */
export interface InvoiceReceiptPayload {
  /** Discriminator — always 'invoice_receipt' */
  readonly type: 'invoice_receipt';
  /** Format version — always 1 for forward compatibility */
  readonly version: 1;
  /** Invoice token ID (64-char hex) */
  readonly invoiceId: string;
  /** DIRECT:// address of the target sending this receipt */
  readonly targetAddress: string;
  /** Target's nametag (if known at send time) */
  readonly targetNametag?: string;
  /** Terminal state of the invoice when receipt was issued */
  readonly terminalState: 'CLOSED' | 'CANCELLED';
  /** This sender's contribution breakdown */
  readonly senderContribution: InvoiceReceiptContribution;
  /** Optional free-text memo from target (deal/service description) */
  readonly memo?: string;
  /** Timestamp when receipt was issued (ms) */
  readonly issuedAt: number;
}

/**
 * Per-sender contribution details within a receipt.
 */
export interface InvoiceReceiptContribution {
  /** Effective sender address (DIRECT:// format) — same as InvoiceSenderBalance.senderAddress */
  readonly senderAddress: string;
  /** True when senderAddress is actually a refund address */
  readonly isRefundAddress?: boolean;
  /** Per-asset breakdown of this sender's contribution to this target */
  readonly assets: InvoiceReceiptAsset[];
}

/**
 * Per-asset breakdown within a receipt contribution.
 */
export interface InvoiceReceiptAsset {
  /** Coin ID (e.g., 'UCT', 'USDU') */
  readonly coinId: string;
  /** Total forwarded by this sender for this target:coinId */
  readonly forwardedAmount: string;
  /** Total returned to this sender for this target:coinId */
  readonly returnedAmount: string;
  /** Net amount: forwardedAmount - returnedAmount */
  readonly netAmount: string;
  /** Requested amount from the invoice terms for this target:coinId */
  readonly requestedAmount: string;
}

/**
 * Parsed receipt on the payer side — constructed from an incoming DM
 * whose content starts with 'invoice_receipt:'.
 *
 * NOTE: `sender*` fields refer to the DM sender, who is the invoice TARGET
 * (not the invoice payer). The naming follows the DM layer convention where
 * "sender" = the party who sent the DM.
 */
export interface IncomingInvoiceReceipt {
  /** DirectMessage.id from the DM that carried this receipt */
  readonly dmId: string;
  /** Target's transport pubkey (DM sender = invoice target) */
  readonly senderPubkey: string;
  /** Target's nametag (from DM metadata or receipt payload) */
  readonly senderNametag?: string;
  /** Parsed receipt payload */
  readonly receipt: InvoiceReceiptPayload;
  /** Timestamp when the DM was received */
  readonly receivedAt: number;
}

// =============================================================================
// §1.6 Cancellation Notice Types (Invoice Cancellation DMs)
// =============================================================================

/**
 * Structured payload inside a cancellation notice DM content field.
 * Sent by a target to each payer after invoice cancellation.
 * Wire format: `invoice_cancellation:` prefix + JSON.stringify(InvoiceCancellationPayload).
 *
 * Unlike receipts (which apply to both CLOSED and CANCELLED invoices),
 * cancellation notices are specific to CANCELLED invoices and carry
 * cancellation-specific context (reason, deal description).
 *
 * No `terminalState` field — cancellation notices are only sent for CANCELLED
 * invoices (enforced by §8.10 validation), so the terminal state is implicit.
 */
export interface InvoiceCancellationPayload {
  /** Discriminator — always 'invoice_cancellation' */
  readonly type: 'invoice_cancellation';
  /** Format version — always 1 for forward compatibility */
  readonly version: 1;
  /** Invoice token ID (64-char hex) */
  readonly invoiceId: string;
  /** DIRECT:// address of the target sending this notice */
  readonly targetAddress: string;
  /** Target's nametag (if known at send time) */
  readonly targetNametag?: string;
  /** This sender's contribution breakdown at time of cancellation */
  readonly senderContribution: InvoiceReceiptContribution;
  /** Cancellation reason — free-text explaining why the invoice was cancelled */
  readonly reason?: string;
  /**
   * Optional deal/service/asset description — context about what was being
   * bought, sold, exchanged, or provided. Helps the payer understand the
   * commercial context of the cancelled transaction.
   */
  readonly dealDescription?: string;
  /** Timestamp when notice was issued (ms) */
  readonly issuedAt: number;
}

/**
 * Parsed cancellation notice on the payer side — constructed from an incoming DM
 * whose content starts with 'invoice_cancellation:'.
 *
 * NOTE: `sender*` fields refer to the DM sender, who is the invoice TARGET
 * (not the invoice payer). The naming follows the DM layer convention where
 * "sender" = the party who sent the DM.
 */
export interface IncomingCancellationNotice {
  /** DirectMessage.id from the DM that carried this notice */
  readonly dmId: string;
  /** Target's transport pubkey (DM sender = invoice target) */
  readonly senderPubkey: string;
  /** Target's nametag (from DM metadata or notice payload) */
  readonly senderNametag?: string;
  /** Parsed cancellation notice payload */
  readonly notice: InvoiceCancellationPayload;
  /** Timestamp when the DM was received */
  readonly receivedAt: number;
}

// =============================================================================
// §1.7 Configuration Types
// =============================================================================

/**
 * Configuration for AccountingModule.
 */
export interface AccountingModuleConfig {
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
export interface AccountingModuleDependencies {
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
  /**
   * All tracked wallet addresses — used for target check in close/cancel/return.
   * Target validation compares TrackedAddress.directAddress against
   * InvoiceTarget.address (both are DIRECT:// format). Checks all HD addresses,
   * not just the current one.
   */
  getActiveAddresses: () => TrackedAddress[];
  /** Event emitter (from Sphere) */
  emitEvent: <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => void;
  /**
   * Event subscriber (from Sphere) — allows the module to listen to events
   * fired by other modules (PaymentsModule 'transfer:incoming', 'transfer:confirmed',
   * 'history:updated') without holding a reference to the Sphere instance itself.
   * Returns an unsubscribe function.
   */
  on: <T extends SphereEventType>(type: T, handler: (data: SphereEventMap[T]) => void) => () => void;
  /** General storage for cancelled/closed sets, frozen balances, auto-return settings */
  storage: StorageProvider;
  /**
   * Optional CommunicationsModule instance for sending/receiving receipt and
   * cancellation notice DMs.
   * When provided:
   * - `sendInvoiceReceipts()` and `sendCancellationNotices()` send DMs via `sendDM()`
   * - Incoming DMs are monitored for `invoice_receipt:` and `invoice_cancellation:`
   *   prefixes (payer-side detection of receipts and cancellation notices)
   * When omitted:
   * - Both methods throw `COMMUNICATIONS_UNAVAILABLE`
   * - Payer-side receipt and cancellation notice detection is disabled (no subscription)
   */
  communications?: CommunicationsModule;
}

// =============================================================================
// §2.2 Memo Parsing Type
// =============================================================================

/**
 * Parsed invoice reference from a transfer memo.
 */
export interface InvoiceMemoRef {
  /** Invoice token ID (64-char hex) */
  readonly invoiceId: string;
  /** Payment direction (matches InvoiceTransferRef.paymentDirection values) */
  readonly paymentDirection: 'forward' | 'back' | 'return_closed' | 'return_cancelled';
  /** Optional free text after the structured prefix */
  readonly freeText?: string;
}

// =============================================================================
// §2.3 Payment Parameter Types
// =============================================================================

/**
 * Parameters for payInvoice().
 */
export interface PayInvoiceParams {
  /** Which target to pay (index into invoice terms.targets) */
  readonly targetIndex: number;
  /** Which asset within that target (index into target.assets). Defaults to 0. */
  readonly assetIndex?: number;
  /**
   * Amount to pay in smallest units (defaults to remaining needed to cover the asset).
   * Same convention as TransferRequest.amount.
   */
  readonly amount?: string;
  /** Optional free text appended to memo */
  readonly freeText?: string;
  /**
   * Optional refund address (DIRECT:// format) embedded in the on-chain
   * TransferMessagePayload. Provides an explicit return destination for the
   * payer. Essential for masked-predicate senders (one-time address that
   * becomes unresolvable), but also usable by unmasked senders who want
   * returns routed to a different address. When present, takes priority
   * over senderAddress for per-sender balance keying.
   *
   * This address is NOT included in the transport memo (privacy: transport
   * memos are human-readable). It is only recorded on-chain in the
   * structured `inv.ra` field of the TransferMessagePayload.
   *
   * Privacy note: while the refund address is not in the memo, it IS the
   * recipient of auto-return transfers and therefore visible in the transport
   * layer's addressing metadata (Nostr NIP-04/NIP-17 envelope), as with any
   * transfer recipient.
   *
   * Auto-return destination priority: refundAddress → senderAddress → fail.
   */
  readonly refundAddress?: string;
  /**
   * Optional contact info embedded in the on-chain TransferMessagePayload
   * (`inv.ct` field). Allows the invoice target to reach the payer for
   * future communication: receipts (after close), cancellation notices,
   * and payment reminders.
   *
   * `address`: a reachable DIRECT:// address for the payer (required within the object).
   * `url`: optional non-Nostr transport URL (https:// or wss://, max 2048 chars).
   *
   * NOT included in the transport memo (same privacy model as refund address).
   * Contact is purely informational — it does not affect auto-return routing,
   * balance computation, or per-sender keying.
   *
   * When not provided, auto-populated from `identity.directAddress` at runtime
   * (see §4.7). This ensures every outbound invoice payment carries contact info.
   *
   * Contact resolution priority (application-level recommendation):
   * `contacts[0].address → refundAddress → senderAddress → null`
   */
  readonly contact?: { address: string; url?: string };
}

/**
 * Parameters for returnInvoicePayment().
 */
export interface ReturnPaymentParams {
  /** Recipient address (original sender to return tokens to) */
  readonly recipient: string;
  /** Amount to return in smallest units (same convention as TransferRequest.amount) */
  readonly amount: string;
  /** Coin ID */
  readonly coinId: string;
  /** Optional free text appended to memo */
  readonly freeText?: string;
}

/**
 * Options for sendInvoiceReceipts().
 */
export interface SendInvoiceReceiptsOptions {
  /** Optional memo — deal/service description included in each receipt. Max 4096 chars. */
  readonly memo?: string;
  /** Whether to include senders with net balance of 0 (default: false) */
  readonly includeZeroBalance?: boolean;
}

/**
 * Result of sendInvoiceReceipts().
 */
export interface SendReceiptsResult {
  /** Number of receipts successfully sent */
  readonly sent: number;
  /** Number of receipts that failed to send */
  readonly failed: number;
  /** Details of each successfully sent receipt */
  readonly sentReceipts: SentReceiptInfo[];
  /** Details of each failed receipt */
  readonly failedReceipts: FailedReceiptInfo[];
}

/**
 * Info about a successfully sent receipt DM.
 */
export interface SentReceiptInfo {
  /** Target address this receipt was sent for (DIRECT:// format) */
  readonly targetAddress: string;
  /** Effective sender address the receipt was sent for */
  readonly senderAddress: string;
  /** Resolved DM recipient address */
  readonly recipientAddress: string;
  /** DM ID returned by CommunicationsModule.sendDM() */
  readonly dmId: string;
}

/**
 * Info about a failed receipt DM.
 */
export interface FailedReceiptInfo {
  /** Target address this receipt was attempted for (DIRECT:// format) */
  readonly targetAddress: string;
  /** Effective sender address the receipt was attempted for */
  readonly senderAddress: string;
  /** Reason the receipt failed */
  readonly reason: 'unresolvable' | 'dm_failed';
  /** Error message (for 'dm_failed' reason) */
  readonly error?: string;
}

/**
 * Options for sendCancellationNotices().
 */
export interface SendCancellationNoticesOptions {
  /** Cancellation reason — free-text explaining why the invoice was cancelled. Max 4096 chars. */
  readonly reason?: string;
  /**
   * Deal/service/asset description — context about what was being bought, sold,
   * exchanged, or provided. Max 4096 chars.
   */
  readonly dealDescription?: string;
  /** Whether to include senders with net balance of 0 (default: false) */
  readonly includeZeroBalance?: boolean;
}

/**
 * Result of sendCancellationNotices().
 */
export interface SendNoticesResult {
  /** Number of notices successfully sent */
  readonly sent: number;
  /** Number of notices that failed to send */
  readonly failed: number;
  /** Details of each successfully sent notice */
  readonly sentNotices: SentNoticeInfo[];
  /** Details of each failed notice */
  readonly failedNotices: FailedNoticeInfo[];
}

/**
 * Info about a successfully sent cancellation notice DM.
 */
export interface SentNoticeInfo {
  /** Target address this notice was sent for (DIRECT:// format) */
  readonly targetAddress: string;
  /** Effective sender address the notice was sent for */
  readonly senderAddress: string;
  /** Resolved DM recipient address */
  readonly recipientAddress: string;
  /** DM ID returned by CommunicationsModule.sendDM() */
  readonly dmId: string;
}

/**
 * Info about a failed cancellation notice DM.
 */
export interface FailedNoticeInfo {
  /** Target address this notice was attempted for (DIRECT:// format) */
  readonly targetAddress: string;
  /** Effective sender address the notice was attempted for */
  readonly senderAddress: string;
  /** Reason the notice failed */
  readonly reason: 'unresolvable' | 'dm_failed';
  /** Error message (for 'dm_failed' reason) */
  readonly error?: string;
}

// =============================================================================
// §4.1 Transfer Message Types (On-Chain Format)
// =============================================================================

/**
 * The `inv` sub-object within TransferMessagePayload.
 * Contains the invoice reference embedded in the on-chain token transaction message.
 */
export interface InvoiceMessageRef {
  /** Invoice token ID (64-char hex, lowercase) */
  readonly id: string;
  /** Direction code: F=forward, B=back, RC=return-closed, RX=return-cancelled */
  readonly dir: 'F' | 'B' | 'RC' | 'RX';
  /**
   * Refund address (DIRECT:// format, optional).
   * Provides an explicit return destination for the payer. Essential for
   * masked-predicate senders (one-time address that becomes unresolvable),
   * but also usable by unmasked senders who want returns routed differently.
   * When present, takes priority over sender address for per-sender keying.
   * Set by the payer via `payInvoice({ refundAddress })`.
   *
   * Auto-return destination priority: ra → sender address → fail.
   *
   * NOT included in the transport memo (privacy: transport memos are
   * human-readable, on-chain payload is structured).
   */
  readonly ra?: string;
  /**
   * Contact info (optional). Allows the invoice target to reach the payer
   * for future communication (receipts, cancellation notices, reminders).
   * Set by the payer via `payInvoice({ contact })`.
   *
   * `a`: contact address (DIRECT:// format, required within the object).
   * `u`: optional transport URL (https:// or wss://, max 2048 chars).
   *
   * NOT included in the transport memo (same privacy model as `ra`).
   * Contact is purely informational — does not affect auto-return routing
   * or balance computation.
   */
  readonly ct?: { a: string; u?: string };
}

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
export interface TransferMessagePayload {
  /** Invoice reference (present only for invoice-related transfers) */
  readonly inv?: InvoiceMessageRef;
  /** Human-readable text (optional, max 256 code points) */
  readonly txt?: string;
}

// =============================================================================
// §7.3 Frozen Balance Schema (Storage)
// =============================================================================

/**
 * Per-sender balance baseline at freeze time.
 * Stored within FrozenCoinAssetBalances as part of FrozenInvoiceBalances.
 */
export interface FrozenSenderBalance {
  /**
   * Effective sender address (DIRECT:// format) — the per-sender balance key.
   * Derived as `refundAddress ?? senderAddress`. When `isRefundAddress` is true,
   * this contains the refund address. See InvoiceSenderBalance.senderAddress for details.
   */
  readonly senderAddress: string;
  /**
   * True when `senderAddress` actually contains a refund address.
   * See InvoiceSenderBalance.isRefundAddress for semantics.
   */
  readonly isRefundAddress?: boolean;
  readonly senderPubkey?: string;
  /**
   * Refund address from the sender's on-chain TransferMessagePayload `inv.ra` field.
   * Persisted at freeze time to enable crash recovery of auto-return destination
   * resolution (refundAddress → senderAddress → fail) without re-parsing the
   * on-chain payload. Only present if the sender included a refund address.
   *
   * NOTE: When `isRefundAddress` is true, `refundAddress` equals `senderAddress`
   * (both contain the refund address). When `isRefundAddress` is false/undefined,
   * `refundAddress` is informational only — auto-return routing uses `senderAddress`
   * (the real sender address from the unmasked predicate) as the destination.
   */
  readonly refundAddress?: string;
  /**
   * All unique contact info entries from the sender's on-chain TransferMessagePayload
   * `inv.ct` fields, accumulated across all transfers from this sender.
   * Persisted at freeze time to enable post-termination communication (receipts,
   * cancellation notices, reminders) without re-parsing the on-chain payload.
   * ALWAYS present (never undefined). Empty array if no contacts were provided.
   * Max 10 entries per sender. Deduplication key: `${address}\0${url ?? ''}` —
   * same semantics as InvoiceSenderBalance.contacts.
   */
  readonly contacts: ReadonlyArray<{ address: string; url?: string }>;
  /** Returnable balance baseline at freeze time */
  readonly netBalance: string;
}

/**
 * Frozen balance data for a single coin asset within a target.
 * Stored as part of FrozenTargetBalances at invoice termination.
 */
export interface FrozenCoinAssetBalances {
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
   *   being processed inside the per-invoice gate when the close condition was met
   *   (for implicit close) or the sender of the most recent forward
   *   transfer for this target:coinId by timestamp, with ties broken by
   *   transferId lexicographic order (for explicit close).
   * For CANCELLED: each sender's full pre-cancellation senderNetBalance is preserved.
   *   Everything is returnable.
   *
   * Post-termination forwards and returns are tracked on top of these baselines.
   */
  readonly frozenSenderBalances: FrozenSenderBalance[];
  /**
   * The latest sender for this target:coinId at freeze time (CLOSED only).
   * Persisted to enable crash recovery (inverse reconciliation in §7.6 step 4c).
   * For CANCELLED invoices, this field is undefined (all balances preserved).
   */
  readonly latestSenderAddress?: string;
}

/**
 * Frozen balance data for a single target within a terminated invoice.
 */
export interface FrozenTargetBalances {
  readonly address: string;
  readonly coinAssets: FrozenCoinAssetBalances[];
  /** Per-NFT-asset status (frozen at termination) */
  readonly nftAssets: InvoiceNFTAssetStatus[];
  /** Whether all assets (coins and NFTs) for this target were covered at freeze time */
  readonly isCovered: boolean;
  /** Whether all related tokens for this target were confirmed at freeze time */
  readonly confirmed: boolean;
}

/**
 * Persisted frozen balance snapshot for a terminated invoice.
 * Stored when an invoice transitions to CLOSED or CANCELLED.
 * Stored under FROZEN_BALANCES key, keyed by invoiceId.
 */
export interface FrozenInvoiceBalances {
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

// =============================================================================
// §7.5 Auto-Return Deduplication Ledger (Storage)
// =============================================================================

/**
 * A single entry in the auto-return deduplication ledger.
 * Tracks the intent and outcome of an auto-return operation for a given
 * (invoiceId, originalTransferId) pair to prevent duplicate sends on crash recovery.
 *
 * Stored under AUTO_RETURN_LEDGER key.
 */
export interface AutoReturnLedgerEntry {
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
  /** Recipient address for the return transfer (resolved: refundAddress ?? senderAddress) */
  readonly recipient: string;
  /** Amount to return (smallest units) */
  readonly amount: string;
  /** Coin ID */
  readonly coinId: string;
  /** Full memo string (e.g., "INV:abc...:RC") */
  readonly memo: string;
}

/**
 * Auto-return deduplication ledger.
 * Key: "{invoiceId}:{originalTransferId}"
 * Value: AutoReturnLedgerEntry
 *
 * Uses a write-first intent log pattern to prevent duplicate sends on crash.
 * Pruning: completed entries older than 30 days are pruned on load().
 * Pending entries are never pruned.
 */
export interface AutoReturnLedger {
  /**
   * Key: "{invoiceId}:{originalTransferId}"
   * Value: AutoReturnLedgerEntry
   */
  entries: Record<string, AutoReturnLedgerEntry>;
}

// =============================================================================
// §5.4.6 In-Memory Balance Cache
// =============================================================================

/**
 * Per-invoice in-memory balance cache.
 * Invalidated on index mutation. Not persisted.
 *
 * Outer key (in the Map): invoiceId
 */
export interface InvoiceBalanceSnapshot {
  /**
   * Aggregate per (target, coinId) — for coverage computation.
   * Key: `${targetAddress}::${coinId}`
   */
  aggregate: Map<string, { covered: bigint; returned: bigint }>;
  /**
   * Per-sender per (target, effectiveSender, coinId) — for return cap and auto-return.
   * effectiveSender = refundAddress ?? senderAddress (refund address takes priority
   * as sender identity). If both are null/undefined, the entry is excluded from
   * per-sender tracking (but still counted in aggregate).
   * Key: `${targetAddress}::${effectiveSender}::${coinId}`
   */
  perSender: Map<string, { forwarded: bigint; returned: bigint }>;
}
