/**
 * Swap Module Type Definitions
 *
 * All types for the SwapModule: deal/manifest, state machine, swap references,
 * DM message formats, escrow inbound messages, event payloads, configuration,
 * dependencies, and storage schemas.
 *
 * @see docs/SWAP-SPEC.md - Section 2
 */

import type {
  FullIdentity,
  TrackedAddress,
  SphereEventType,
  SphereEventMap,
  TransferResult,
  Token,
} from '../../types/index.js';
import type { InvoiceTransferRef } from '../accounting/types.js';
import type { StorageProvider } from '../../storage/storage-provider.js';
import type { PeerInfo } from '../../transport/transport-provider.js';

// =============================================================================
// §2.1 Deal and Manifest Types
// =============================================================================

/**
 * A swap deal -- the user-facing description of what is being exchanged.
 * Constructed by the application layer (e.g., UI, agent) and passed to
 * proposeSwap(). Addresses may use any Sphere-supported format; they are
 * resolved to DIRECT:// before manifest construction.
 */
export interface SwapDeal {
  /** Party A's address: @nametag, DIRECT://, or 33-byte chain pubkey (02.../03...) */
  readonly partyA: string;
  /** Party B's address: @nametag, DIRECT://, or 33-byte chain pubkey (02.../03...) */
  readonly partyB: string;
  /** Coin ID that party A will deposit (e.g., 'UCT') */
  readonly partyACurrency: string;
  /** Amount party A will deposit (positive integer string, smallest units) */
  readonly partyAAmount: string;
  /** Coin ID that party B will deposit (e.g., 'USDU') */
  readonly partyBCurrency: string;
  /** Amount party B will deposit (positive integer string, smallest units) */
  readonly partyBAmount: string;
  /**
   * Swap timeout in seconds. Range: [60, 86400] (1 minute to 24 hours).
   * Starts counting when the first deposit is received by the escrow.
   * If both deposits are not covered within this window, the escrow
   * cancels the swap and returns deposits.
   */
  readonly timeout: number;
  /**
   * Address of the escrow service: @nametag or DIRECT:// format.
   * If omitted, falls back to SwapModuleConfig.defaultEscrowAddress.
   * At least one of these must be provided.
   */
  readonly escrowAddress?: string;
}

/**
 * The 8 manifest fields used for swap_id computation (without swap_id).
 * Passed to computeSwapId() for SHA-256(JCS(fields)) hashing.
 * Field names use snake_case to match the escrow's wire format exactly.
 */
export interface ManifestFields {
  /** Party A's resolved DIRECT:// address */
  readonly party_a_address: string;
  /** Party B's resolved DIRECT:// address */
  readonly party_b_address: string;
  /** Coin ID party A deposits */
  readonly party_a_currency_to_change: string;
  /** Amount party A deposits (positive integer string) */
  readonly party_a_value_to_change: string;
  /** Coin ID party B deposits */
  readonly party_b_currency_to_change: string;
  /** Amount party B deposits (positive integer string) */
  readonly party_b_value_to_change: string;
  /** Timeout in seconds (integer, [60, 86400]) */
  readonly timeout: number;
  /** Random salt ensuring unique swap_id even for identical deal terms (32 hex chars) */
  readonly salt: string;
  /** Escrow DIRECT:// address (v2, required when protocol_version === 2) */
  readonly escrow_address?: string;
  /** Protocol version (v2: 2, absent for v1) */
  readonly protocol_version?: number;
}

/**
 * Signatures from both parties over the swap consent message.
 * Each signature is a 130-char hex string (v + r + s) produced by
 * signMessage() over "swap_consent:{swapId}:{escrowAddress}".
 */
export interface ManifestSignatures {
  /** Party A's consent signature (130-char hex) */
  readonly party_a?: string;
  /** Party B's consent signature (130-char hex) */
  readonly party_b?: string;
}

/**
 * Nametag binding proof -- proves that the nametag owner authorized
 * the DIRECT:// address for this swap. The signature covers
 * "nametag_bind:{nametag}:{directAddress}:{swapId}".
 */
export interface NametagBindingProof {
  /** The human-readable nametag (without @) */
  readonly nametag: string;
  /** The party's resolved DIRECT:// address */
  readonly direct_address: string;
  /** The party's 33-byte compressed chain pubkey (hex) */
  readonly chain_pubkey: string;
  /** 130-char hex signature over the binding message */
  readonly signature: string;
}

/**
 * Auxiliary manifest data (nametag bindings).
 * Not part of swap_id hash -- carried alongside the manifest
 * for UI enrichment and nametag verification.
 */
export interface ManifestAuxiliary {
  /** Nametag binding proof for party A */
  readonly party_a_binding?: NametagBindingProof;
  /** Nametag binding proof for party B */
  readonly party_b_binding?: NametagBindingProof;
}

/**
 * The swap manifest -- wire format submitted to the escrow service.
 * All addresses are resolved to DIRECT:// before construction.
 * The swap_id is a content-addressed hash ensuring manifest integrity.
 *
 * This is the same SwapManifest type used by the escrow service
 * (see escrow-service/src/core/manifest-validator.ts).
 */
export interface SwapManifest {
  /** SHA-256 of JCS(manifest fields excluding swap_id). 64 lowercase hex chars. */
  readonly swap_id: string;
  /** Party A's resolved DIRECT:// address */
  readonly party_a_address: string;
  /** Party B's resolved DIRECT:// address */
  readonly party_b_address: string;
  /** Coin ID party A deposits */
  readonly party_a_currency_to_change: string;
  /** Amount party A deposits (positive integer string) */
  readonly party_a_value_to_change: string;
  /** Coin ID party B deposits */
  readonly party_b_currency_to_change: string;
  /** Amount party B deposits (positive integer string) */
  readonly party_b_value_to_change: string;
  /** Timeout in seconds (integer, [60, 86400]) */
  readonly timeout: number;
  /** Random salt ensuring unique swap_id even for identical deal terms (32 hex chars) */
  readonly salt: string;
  /** Escrow DIRECT:// address (v2, required when protocol_version === 2) */
  readonly escrow_address?: string;
  /** Protocol version (v2: 2, absent for v1) */
  readonly protocol_version?: number;
}

// =============================================================================
// §2.2 Swap State Types
// =============================================================================

/**
 * Client-side swap progress. This is the wallet's LOCAL view of where
 * the swap is in its lifecycle. It does not 1:1 map to the escrow's
 * SwapState -- the escrow has its own state machine with different
 * granularity (ANNOUNCED, DEPOSIT_INVOICE_CREATED, PARTIAL_DEPOSIT, etc.).
 *
 * The client-side progress is a simplified projection:
 *
 *   proposed -> accepted -> announced -> depositing -> awaiting_counter
 *     -> concluding -> completed
 *
 * Terminal states: completed, cancelled, failed
 *
 * State transitions are strictly forward except for terminal states,
 * which can be reached from most non-terminal states.
 */
export type SwapProgress =
  | 'proposed'          // Proposal sent (proposer) or received (acceptor). No escrow contact yet.
  | 'accepted'          // Counterparty accepted. About to announce to escrow.
  | 'announced'         // Escrow acknowledged. Deposit invoice available.
  | 'depositing'        // Local deposit sent, awaiting confirmation or counterparty deposit.
  | 'awaiting_counter'  // Local deposit confirmed. Waiting for counterparty to deposit.
  | 'concluding'        // Escrow is executing payouts. Payout invoice expected soon.
  | 'completed'         // Payout received and verified. Terminal.
  | 'cancelled'         // Swap cancelled (timeout, explicit, or escrow failure). Terminal.
  | 'failed';           // Unrecoverable error. Terminal.

/**
 * The role this wallet plays in the swap.
 * Determined at proposal time and immutable for the swap's lifetime.
 */
export type SwapRole = 'proposer' | 'acceptor';

// NOTE: VALID_PROGRESS_TRANSITIONS and TERMINAL_PROGRESS are defined
// exclusively in state-machine.ts to avoid duplication conflicts.
// Import from './state-machine.js' if needed.

// =============================================================================
// §2.3 Swap Reference Types
// =============================================================================

/**
 * The persistent swap record stored locally per address.
 * Contains all state needed to resume a swap across wallet restarts.
 *
 * This is the wallet-side record. The escrow maintains its own
 * SwapRecord with different fields (see escrow-service/src/core/types.ts).
 */
export interface SwapRef {
  /** Swap ID (64 lowercase hex chars, content-addressed from manifest) */
  readonly swapId: string;
  /** The original deal description (user-facing, pre-resolution) */
  readonly deal: SwapDeal;
  /** The wire-format manifest (addresses resolved to DIRECT://) */
  readonly manifest: SwapManifest;
  /** This wallet's role in the swap */
  readonly role: SwapRole;
  /** Current progress in the client-side state machine */
  progress: SwapProgress;
  /**
   * Deposit invoice token ID (set after escrow announcement).
   * This is the invoice the escrow created for collecting deposits
   * from both parties.
   */
  depositInvoiceId?: string;
  /**
   * Payout invoice token ID (set after escrow delivers payout).
   * For proposer (party A): the invoice targeting party A's address
   * with party B's currency. For acceptor: vice versa.
   */
  payoutInvoiceId?: string;
  /**
   * Last known escrow state (from status_result or announce_result DMs).
   * Informational -- the client-side progress is authoritative for the
   * wallet's own state machine.
   */
  escrowState?: string;
  /**
   * Counterparty's transport pubkey (HKDF-derived, 64-hex).
   * Set from dm.senderPubkey on incoming proposals, or resolved from
   * PeerInfo.transportPubkey on outgoing proposals. Used for DM sender
   * verification on acceptance/rejection messages.
   */
  counterpartyPubkey?: string;
  /** Human-readable nametag of the counterparty (e.g., 'alice', 'bob'), if known. */
  counterpartyNametag?: string;
  /**
   * Transfer ID of the local deposit payment (from TransferResult.id).
   * Used to correlate invoice:payment events with the local deposit.
   */
  localDepositTransferId?: string;
  /**
   * Transport pubkey of the resolved escrow service (HKDF-derived, 64-hex).
   * Stored after escrow resolution so that incoming escrow DMs can be
   * authenticated by comparing dm.senderPubkey against this field.
   */
  escrowPubkey?: string;
  /**
   * DIRECT:// address of the resolved escrow service.
   * Used for deposit invoice term verification (target address check).
   */
  escrowDirectAddress?: string;
  /**
   * Whether the payout invoice has been verified (correct terms, covered).
   * Set to true by verifyPayout() after successful verification.
   */
  payoutVerified: boolean;
  /** Timestamp when the swap record was created (ms) */
  readonly createdAt: number;
  /** Timestamp when the swap entered 'announced' state (deposit invoice available). Used as timeout base. */
  announcedAt?: number;
  /** Timestamp of most recent state change (ms) */
  updatedAt: number;
  /** Error message if progress is 'failed' */
  error?: string;
  /** Proposer's chain pubkey (from v2 proposal DM) */
  readonly proposerChainPubkey?: string;
  /** Proposer's signature over swap consent message */
  readonly proposerSignature?: string;
  /** Acceptor's signature over swap consent message */
  readonly acceptorSignature?: string;
  /** Auxiliary data (nametag bindings) */
  readonly auxiliary?: ManifestAuxiliary;
  /** Protocol version (2 for v2, undefined for v1) */
  readonly protocolVersion?: number;
}

// =============================================================================
// §2.4 DM Message Types (Peer-to-Peer)
// =============================================================================

/**
 * Swap proposal DM -- sent from proposer to counterparty.
 * Carries the full manifest and escrow address so the receiver
 * can independently verify the swap_id hash and decide whether to accept.
 *
 * Wire format: `swap_proposal:` prefix + JSON.stringify(SwapProposalMessage)
 */
export interface SwapProposalMessage {
  /** Discriminator */
  readonly type: 'swap_proposal';
  /** Protocol version (1 = legacy, 2 = signed) */
  readonly version: 1 | 2;
  /** The swap manifest (wire format, addresses already resolved) */
  readonly manifest: SwapManifest;
  /** Escrow service address (@nametag or DIRECT://) */
  readonly escrow: string;
  /** Optional human-readable description of the deal */
  readonly message?: string;
  /** Proposer's consent signature over "swap_consent:{swap_id}:{escrow_address}" (v2 only, 130 hex chars) */
  readonly proposer_signature?: string;
  /** Proposer's 33-byte compressed chain pubkey (v2 only, 66 hex chars) */
  readonly proposer_chain_pubkey?: string;
  /** Nametag binding proofs (v2 only) */
  readonly auxiliary?: ManifestAuxiliary;
}

/**
 * Swap acceptance DM -- sent from acceptor to proposer.
 * Signals that the acceptor agrees to the deal terms and is ready
 * to proceed. The acceptor will announce the manifest to the escrow.
 *
 * Wire format: `swap_acceptance:` prefix + JSON.stringify(SwapAcceptanceMessage)
 */
export interface SwapAcceptanceMessage {
  /** Discriminator */
  readonly type: 'swap_acceptance';
  /** Protocol version (1 = legacy, 2 = signed) */
  readonly version: 1 | 2;
  /** Swap ID confirming which proposal is being accepted */
  readonly swap_id: string;
  /** Acceptor's consent signature over "swap_consent:{swap_id}:{escrow_address}" (v2 only, 130 hex chars) */
  readonly acceptor_signature?: string;
  /** Acceptor's 33-byte compressed chain pubkey (v2 only, 66 hex chars) */
  readonly acceptor_chain_pubkey?: string;
}

/**
 * Swap rejection DM -- sent from acceptor to proposer.
 * Signals that the acceptor declines the deal.
 *
 * Wire format: `swap_rejection:` prefix + JSON.stringify(SwapRejectionMessage)
 */
export interface SwapRejectionMessage {
  /** Discriminator */
  readonly type: 'swap_rejection';
  /** Protocol version (1 = legacy, 2 = signed) */
  readonly version: 1 | 2;
  /** Swap ID identifying which proposal is being rejected */
  readonly swap_id: string;
  /** Optional human-readable reason for rejection */
  readonly reason?: string;
}

// =============================================================================
// §2.5 Escrow Inbound Message Types (escrow -> wallet)
// =============================================================================

/**
 * Discriminated union of all escrow-to-wallet message types.
 * Parsed from JSON DMs received from the escrow service.
 * Canonical definitions live in the escrow service specification;
 * these are the fields the SwapModule actually consumes.
 *
 * @see escrow-service/docs/protocol-spec.md
 */
export type EscrowMessage =
  | EscrowAnnounceResult
  | EscrowInvoiceDelivery
  | EscrowStatusResult
  | EscrowPaymentConfirmation
  | EscrowSwapCancelled
  | EscrowBounceNotification
  | EscrowError;

/** Response to a successful `announce`. */
export interface EscrowAnnounceResult {
  readonly type: 'announce_result';
  readonly swap_id: string;
  readonly state: string;
  readonly deposit_invoice_id: string;
  readonly is_new: boolean;
  readonly created_at: number | string;
}

/** Delivers an invoice token to a party (deposit or payout). */
export interface EscrowInvoiceDelivery {
  readonly type: 'invoice_delivery';
  readonly swap_id: string;
  readonly invoice_type: 'deposit' | 'payout';
  readonly invoice_id?: string;
  readonly invoice_token: unknown;
  readonly payment_instructions?: {
    readonly your_currency: string;
    readonly your_amount: string;
    readonly memo: string;
  };
}

/** Response to a `status` query. */
export interface EscrowStatusResult {
  readonly type: 'status_result';
  readonly swap_id: string;
  readonly state: string;
  readonly [key: string]: unknown;
}

/** Sent after the escrow pays into a payout invoice. */
export interface EscrowPaymentConfirmation {
  readonly type: 'payment_confirmation';
  readonly swap_id: string;
  readonly party?: string;
  readonly [key: string]: unknown;
}

/** Sent when a swap is cancelled (timeout or manual). */
export interface EscrowSwapCancelled {
  readonly type: 'swap_cancelled';
  readonly swap_id: string;
  readonly reason: string;
  readonly deposits_returned?: boolean;
}

/** Sent when a payment is bounced back (wrong currency deposit). */
export interface EscrowBounceNotification {
  readonly type: 'bounce_notification';
  readonly swap_id: string;
  readonly reason: string;
  readonly returned_amount: string;
  readonly returned_currency: string;
}

/** Error response from the escrow. */
export interface EscrowError {
  readonly type: 'error';
  readonly error: string;
  readonly swap_id?: string;
  readonly details?: unknown[];
}

// =============================================================================
// §2.6 Result Types
// =============================================================================

/**
 * Result of proposeSwap().
 */
export interface SwapProposalResult {
  /** The swap ID (content-addressed from manifest) */
  readonly swapId: string;
  /** The constructed manifest (addresses resolved to DIRECT://) */
  readonly manifest: SwapManifest;
  /** The created SwapRef (progress='proposed', role='proposer') */
  readonly swap: SwapRef;
}

/**
 * Options for proposeSwap().
 */
export interface ProposeSwapOptions {
  /** Human-readable message sent to the counterparty in the proposal DM. */
  readonly message?: string;
}

/**
 * Options for getSwapStatus().
 */
export interface GetSwapStatusOptions {
  /**
   * If true, send a 'status' DM to the escrow and merge the response.
   * Default: false for terminal swaps, true for active swaps.
   */
  readonly queryEscrow?: boolean;
}

/**
 * Filter options for getSwaps().
 */
export interface GetSwapsFilter {
  /** Filter by progress state(s) */
  readonly progress?: SwapProgress | SwapProgress[];
  /** Filter by role */
  readonly role?: SwapRole;
  /** When true, exclude swaps where progress is 'completed', 'cancelled', or 'failed' */
  readonly excludeTerminal?: boolean;
}

// =============================================================================
// §2.7 Event Payload Types
// =============================================================================

/**
 * New SphereEventType entries for the SwapModule.
 * These are added to the main SphereEventType union when the swap module is active.
 */
export type SwapEventType =
  | 'swap:proposal_received'
  | 'swap:proposed'
  | 'swap:accepted'
  | 'swap:rejected'
  | 'swap:announced'
  | 'swap:deposit_sent'
  | 'swap:deposit_confirmed'
  | 'swap:deposits_covered'
  | 'swap:concluding'
  | 'swap:payout_received'
  | 'swap:completed'
  | 'swap:cancelled'
  | 'swap:failed'
  | 'swap:deposit_returned'
  | 'swap:bounce_received';

/**
 * Event payload map for all SwapModule events.
 * These extend SphereEventMap when the swap module is active.
 */
export interface SwapEventMap {
  /**
   * A counterparty sent us a swap proposal DM.
   * The application should present the deal to the user for accept/reject.
   */
  'swap:proposal_received': {
    /** Swap ID (content-addressed, verifiable) */
    readonly swapId: string;
    /** The deal terms (user-facing) */
    readonly deal: SwapDeal;
    /** Proposer's chain pubkey */
    readonly senderPubkey: string;
    /** Proposer's nametag (if known) */
    readonly senderNametag?: string;
  };

  /**
   * We successfully proposed a swap to a counterparty.
   * Emitted after the proposal DM is sent.
   */
  'swap:proposed': {
    readonly swapId: string;
    readonly deal: SwapDeal;
    /** Counterparty's resolved chain pubkey (DM recipient) */
    readonly recipientPubkey: string;
  };

  /**
   * A swap was accepted (by us or by the counterparty).
   * Emitted on BOTH sides when the acceptance is processed.
   */
  'swap:accepted': {
    readonly swapId: string;
    readonly role: SwapRole;
  };

  /**
   * A swap proposal was rejected (by counterparty, or we rejected it).
   * Emitted on BOTH sides when the rejection is processed.
   */
  'swap:rejected': {
    readonly swapId: string;
    readonly reason?: string;
  };

  /**
   * The escrow acknowledged the manifest and created a deposit invoice.
   * Deposit is now possible.
   */
  'swap:announced': {
    readonly swapId: string;
    /** Deposit invoice ID from the escrow's announce_result */
    readonly depositInvoiceId: string;
  };

  /**
   * We sent our deposit payment into the escrow's deposit invoice.
   * The deposit may not yet be confirmed on-chain.
   */
  'swap:deposit_sent': {
    readonly swapId: string;
    readonly transferResult: TransferResult;
  };

  /**
   * A deposit was confirmed (ours or the counterparty's).
   * The escrow notifies via invoice:payment events on the deposit invoice.
   */
  'swap:deposit_confirmed': {
    readonly swapId: string;
    /** Which party's deposit was confirmed (by currency, not sender identity) */
    readonly party: 'A' | 'B';
    /** Deposited amount */
    readonly amount: string;
    /** Deposited coin ID */
    readonly coinId: string;
  };

  /**
   * Both deposits are fully covered. The escrow will now execute payouts.
   */
  'swap:deposits_covered': {
    readonly swapId: string;
  };

  /**
   * The escrow is executing payouts (CONCLUDING state).
   * Emitted when a payment_confirmation DM arrives from the escrow.
   */
  'swap:concluding': {
    readonly swapId: string;
  };

  /**
   * We received a payout invoice token from the escrow.
   * The payout invoice can be verified with verifyPayout().
   */
  'swap:payout_received': {
    readonly swapId: string;
    readonly payoutInvoiceId: string;
  };

  /**
   * The swap is complete. Payout verified (or verification skipped).
   * Terminal state.
   */
  'swap:completed': {
    readonly swapId: string;
    /** Whether the payout was cryptographically verified via verifyPayout() */
    readonly payoutVerified: boolean;
  };

  /**
   * The swap was cancelled (timeout, explicit, or escrow-reported).
   * Terminal state. Deposits may or may not have been returned
   * (depends on whether any were made and whether auto-return succeeded).
   */
  'swap:cancelled': {
    readonly swapId: string;
    /** Why the swap was cancelled */
    readonly reason: 'timeout' | 'explicit' | 'escrow_failed' | 'rejected';
    /**
     * Whether deposits were returned. True if the escrow reported
     * deposits_returned=true. False or undefined if unknown.
     */
    readonly depositsReturned?: boolean;
  };

  /**
   * The swap failed due to an unrecoverable error. Terminal state.
   */
  'swap:failed': {
    readonly swapId: string;
    /** Human-readable error description */
    readonly error: string;
  };

  /**
   * A deposit was returned after swap cancellation (via invoice auto-return).
   * The wallet received tokens back from the escrow.
   */
  'swap:deposit_returned': {
    readonly swapId: string;
    /** The invoice transfer reference for the return */
    readonly transfer: InvoiceTransferRef;
    /** Return reason from the invoice system */
    readonly returnReason: 'closed' | 'cancelled';
  };

  /**
   * A bounce notification was received from the escrow (wrong currency deposit).
   * Informational -- the tokens were already returned.
   */
  'swap:bounce_received': {
    readonly swapId: string;
    /** Reason for the bounce */
    readonly reason: string;
    /** Amount returned */
    readonly returnedAmount: string;
    /** Currency returned */
    readonly returnedCurrency: string;
  };
}

// =============================================================================
// §2.8 Configuration Types
// =============================================================================

/**
 * Configuration for SwapModule.
 * Passed to createSwapModule() factory function.
 */
export interface SwapModuleConfig {
  /** Enable debug logging */
  readonly debug?: boolean;
  /**
   * Pre-configured escrow address (@nametag or DIRECT://).
   * Used as the default when SwapDeal.escrowAddress is omitted.
   * At least one of this or SwapDeal.escrowAddress must be provided
   * for any swap operation.
   */
  readonly defaultEscrowAddress?: string;
  /**
   * Time to wait for the counterparty to accept or reject a proposal (ms).
   * After this timeout, the proposal is marked as 'failed' locally.
   * Default: 300000 (5 minutes).
   *
   * This is a CLIENT-SIDE timeout only. The proposal DM remains
   * deliverable on Nostr indefinitely -- the counterparty could still
   * respond after this timeout. Late responses are ignored.
   */
  readonly proposalTimeoutMs?: number;
  /**
   * Maximum number of non-terminal swaps tracked simultaneously.
   * Prevents unbounded memory growth from DM spam.
   * Default: 100.
   *
   * When the limit is reached, new proposals (both outgoing and incoming)
   * are rejected with SWAP_LIMIT_EXCEEDED.
   */
  readonly maxPendingSwaps?: number;
  /**
   * Time to wait for the escrow's announce_result DM after announcing (ms).
   * After this timeout, the announce is considered failed.
   * Default: 30000 (30 seconds).
   */
  readonly announceTimeoutMs?: number;
  /**
   * TTL for terminal swap records before they are purged from storage (ms).
   * Completed, cancelled, and failed swaps older than this TTL are removed
   * during load() to prevent unbounded storage growth.
   * Default: 604800000 (7 days).
   */
  readonly terminalPurgeTtlMs?: number;
}

/**
 * Dependencies injected into SwapModule.
 * Follows the same pattern as AccountingModuleDependencies.
 * Each external module is represented by a narrow interface containing
 * only the methods the SwapModule actually calls.
 */
export interface SwapModuleDependencies {
  /**
   * AccountingModule subset -- invoice import, lookup, status, payment,
   * and event subscription. Used for deposit invoice import, deposit
   * payment, and payout verification.
   */
  readonly accounting: {
    /** Import a received invoice TXF token (deposit or payout) */
    importInvoice(token: unknown): Promise<unknown>;
    /** Lightweight invoice lookup by ID */
    getInvoice(invoiceId: string): unknown | null;
    /** Full status with per-target balances */
    getInvoiceStatus(invoiceId: string): unknown;
    /** Send payment referencing an invoice */
    payInvoice(invoiceId: string, params: unknown): Promise<TransferResult>;
    /** Subscribe to invoice events (returns unsubscribe function) */
    on<T extends SphereEventType>(type: T, handler: (data: SphereEventMap[T]) => void): () => void;
  };
  /**
   * PaymentsModule subset -- L3 token validation during payout verification.
   */
  readonly payments: {
    /** Validate all tokens against the aggregator */
    validate(): Promise<{ valid: Token[]; invalid: Token[] }>;
  };
  /**
   * CommunicationsModule subset -- DM send/receive for peer and escrow messaging.
   */
  readonly communications: {
    /** Send an encrypted DM to a peer by chain pubkey */
    sendDM(recipientPubkey: string, content: string): Promise<{ eventId: string }>;
    /** Subscribe to incoming DMs (returns unsubscribe function) */
    onDirectMessage(handler: (message: {
      readonly senderPubkey: string;
      readonly senderNametag?: string;
      readonly content: string;
      readonly timestamp: number;
    }) => void): () => void;
  };
  /** General storage for persistent swap records */
  readonly storage: StorageProvider;
  /** Current wallet identity */
  readonly identity: FullIdentity;
  /** Event emitter (from Sphere) */
  readonly emitEvent: <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => void;
  /**
   * Transport-level peer resolution.
   * Used to resolve @nametag and chain pubkey addresses to DIRECT:// and PeerInfo.
   */
  readonly resolve: (identifier: string) => Promise<PeerInfo | null>;
  /** All tracked wallet addresses (for determining party role) */
  readonly getActiveAddresses: () => TrackedAddress[];
}

// =============================================================================
// §2.9 Storage Types
// =============================================================================

/**
 * Persistent storage format for a single swap record.
 * Stored at key `swap:{swapId}`.
 */
export interface SwapStorageData {
  readonly version: 1;
  readonly swap: SwapRef;
}

/**
 * Index entry for the swap_index key.
 * Lightweight summary for listing/filtering without loading full records.
 */
export interface SwapIndexEntry {
  readonly swapId: string;
  readonly progress: SwapProgress;
  readonly role: SwapRole;
  readonly createdAt: number;
}
