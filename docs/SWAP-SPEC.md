# Swap Module Specification

> **Status:** Implemented -- `modules/swap/` on `feat/swap-module-spec` branch
> **Companion:** [Escrow Protocol Spec](../../escrow-service/docs/protocol-spec.md)

## Table of Contents

1. [Overview and Scope](#1-overview-and-scope)
2. [Types](#2-types)
3. [Module Lifecycle](#3-module-lifecycle)
4. [proposeSwap](#4-proposeswap)
5. [acceptSwap](#5-acceptswap)
6. [rejectSwap](#6-rejectswap)
7. [deposit](#7-deposit)
8. [getSwapStatus](#8-getswapstatus)
9. [getSwaps](#9-getswaps)
10. [verifyPayout](#10-verifypayout)
11. [cancelSwap](#11-cancelswap)
12. [Incoming DM Processing](#12-incoming-dm-processing)
13. [Invoice Event Subscriptions](#13-invoice-event-subscriptions)
14. [Storage Schema](#14-storage-schema)
15. [Per-Swap Async Mutex](#15-per-swap-async-mutex)
16. [Local Timeout Management](#16-local-timeout-management)
17. [Validation Rules](#17-validation-rules)
18. [Configuration](#18-configuration)
19. [Error Codes](#19-error-codes)
20. [CLI Commands](#20-cli-commands)
21. [Future: Predicate-Based Direct Swaps](#21-future-predicate-based-direct-swaps)

---

## 1. Overview and Scope

### 1.1 Purpose

The `SwapModule` provides a high-level API for atomic two-party currency swaps within each party's Sphere wallet. It orchestrates the full swap lifecycle -- proposing a deal, negotiating acceptance, depositing into an escrow-managed invoice, and verifying payout -- while abstracting away the underlying DM protocol and invoice mechanics.

The module runs entirely in the wallet. It is a **client** of the escrow service, not a replacement for it. The escrow service holds deposited funds and executes the atomic swap; the `SwapModule` coordinates the wallet-side state machine, DM messaging between counterparties, and interaction with the `AccountingModule` for invoice import, payment, and verification.

### 1.2 Protocol Versions

The swap module supports two protocol versions:

| Version | Description | Escrow trust model |
|---------|-------------|-------------------|
| **v1** (legacy) | Proposer announces to escrow after receiving acceptance DM. No cryptographic consent proofs. | Escrow trusts that the announcing party is legitimate. |
| **v2** (signed) | Both parties sign a consent message. The acceptor announces directly to the escrow with both signatures. The escrow verifies both signatures before creating the swap record. | Escrow cryptographically verifies consent from both parties. |

Protocol version is determined at proposal time. When `proposeSwap()` is called, the implementation always builds a v2 manifest (with `escrow_address` and `protocol_version: 2` in the manifest) and signs the proposal. The `SwapRef.protocolVersion` field records which version is in use.

### 1.3 Non-Goals

- **Escrow logic duplication.** The module does not validate deposits, compute coverage, manage timeouts authoritatively, or execute payouts. Those responsibilities belong to the escrow service.
- **Price discovery or order matching.** The module does not find counterparties or negotiate exchange rates. Deal terms arrive fully specified from the application layer.
- **Multi-party swaps.** The current design supports exactly two parties (A and B). Multi-leg swaps require a different protocol.
- **Cross-chain swaps.** Both sides of the swap use L3 tokens on the Unicity network. L1 (ALPHA) swaps are out of scope.

### 1.4 Relationship to AccountingModule

The `SwapModule` is a **consumer** of the `AccountingModule`, not an extension. It uses the following AccountingModule APIs:

- `importInvoice(token)` -- import deposit and payout invoice tokens delivered by the escrow
- `payInvoice(invoiceId, params)` -- send deposit payments referencing the escrow's deposit invoice
- `getInvoiceStatus(invoiceId)` -- verify deposit coverage and payout receipt
- Invoice events (`invoice:payment`, `invoice:covered`, `invoice:created`) -- track deposit progress and payout arrival

The `SwapModule` does not create invoices, close invoices, or manage auto-return. Those operations are performed by the escrow service on its own `AccountingModule` instance.

### 1.5 Relationship to Escrow Service

The `SwapModule` communicates with the escrow service exclusively via NIP-17 encrypted DMs through `CommunicationsModule`. The escrow service's DM protocol is defined in [`escrow-service/docs/protocol-spec.md`](../../escrow-service/docs/protocol-spec.md).

Messages sent to the escrow: `announce` (v1 and v2), `status`, `request_invoice`, `cancel`.
Messages received from the escrow: `announce_result`, `invoice_delivery`, `status_result`, `payment_confirmation`, `swap_cancelled`, `bounce_notification`, `error`.

The `SwapModule` also exchanges peer-to-peer DMs with the counterparty wallet for proposal negotiation (`swap_proposal` v1/v2, `swap_acceptance` v1/v2, `swap_rejection`). These messages are NOT sent to the escrow.

---

## 2. Types

### 2.1 Deal and Manifest Types

```typescript
// =============================================================================
// Deal Types (user-facing)
// =============================================================================

/**
 * A swap deal -- the user-facing description of what is being exchanged.
 * Constructed by the application layer (e.g., UI, agent) and passed to
 * proposeSwap(). Addresses may use any Sphere-supported format; they are
 * resolved to DIRECT:// before manifest construction.
 */
interface SwapDeal {
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

// =============================================================================
// Manifest Types (wire format for escrow protocol)
// =============================================================================

/**
 * The 8+ manifest fields used for swap_id computation (without swap_id).
 * Passed to computeSwapId() for SHA-256(JCS(fields)) hashing.
 * Field names use snake_case to match the escrow's wire format exactly.
 *
 * For v1: 8 fields (the 7 core fields + salt).
 * For v2: 10 fields (same 8 + escrow_address + protocol_version).
 *
 * The `!== undefined` check (not truthiness) determines whether v2 fields
 * are included in the hash.
 */
interface ManifestFields {
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
  /** Random salt ensuring unique swap_id even for identical deal terms (32 lowercase hex chars) */
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
interface ManifestSignatures {
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
interface NametagBindingProof {
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
interface ManifestAuxiliary {
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
interface SwapManifest {
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
  /** Random salt ensuring unique swap_id even for identical deal terms (32 lowercase hex chars) */
  readonly salt: string;
  /** Escrow DIRECT:// address (v2, required when protocol_version === 2) */
  readonly escrow_address?: string;
  /** Protocol version (v2: 2, absent for v1) */
  readonly protocol_version?: number;
}
```

### 2.2 Swap State Types

```typescript
// =============================================================================
// Swap Progress (client-side state machine)
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
type SwapProgress =
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
type SwapRole = 'proposer' | 'acceptor';

/**
 * Valid SwapProgress transitions.
 * Used by the internal state guard to prevent illegal transitions.
 *
 * NOTE: `proposed` can transition directly to `announced` (v2: escrow's
 * announce_result may arrive before the acceptance DM from the counterparty).
 */
const VALID_PROGRESS_TRANSITIONS: Record<SwapProgress, readonly SwapProgress[]> = {
  proposed:         ['accepted', 'announced', 'cancelled', 'failed'],
  accepted:         ['announced', 'cancelled', 'failed'],
  announced:        ['depositing', 'cancelled', 'failed'],
  depositing:       ['awaiting_counter', 'concluding', 'completed', 'cancelled', 'failed'],
  awaiting_counter: ['concluding', 'completed', 'cancelled', 'failed'],
  concluding:       ['completed', 'cancelled', 'failed'],
  completed:        [],  // terminal
  cancelled:        [],  // terminal
  failed:           [],  // terminal
};

const TERMINAL_PROGRESS: ReadonlySet<SwapProgress> = new Set([
  'completed', 'cancelled', 'failed',
]);
```

### 2.3 Swap Reference Types

```typescript
// =============================================================================
// Swap Reference (persistent swap record)
// =============================================================================

/**
 * The persistent swap record stored locally per address.
 * Contains all state needed to resume a swap across wallet restarts.
 *
 * This is the wallet-side record. The escrow maintains its own
 * SwapRecord with different fields (see escrow-service/src/core/types.ts).
 */
interface SwapRef {
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
  /** Proposer's chain pubkey (33-byte compressed hex, from v2 proposal DM) */
  readonly proposerChainPubkey?: string;
  /** Proposer's signature over swap consent message (130-char hex) */
  readonly proposerSignature?: string;
  /** Acceptor's signature over swap consent message (130-char hex) */
  readonly acceptorSignature?: string;
  /** Auxiliary data (nametag bindings) */
  readonly auxiliary?: ManifestAuxiliary;
  /** Protocol version (2 for v2, undefined for v1) */
  readonly protocolVersion?: number;
}
```

### 2.4 DM Message Types (Peer-to-Peer)

```typescript
// =============================================================================
// Peer-to-Peer DM Messages (wallet <-> wallet)
// =============================================================================

/**
 * Swap proposal DM -- sent from proposer to counterparty.
 * Carries the full manifest and escrow address so the receiver
 * can independently verify the swap_id hash and decide whether to accept.
 *
 * Wire format: `swap_proposal:` prefix + JSON.stringify(SwapProposalMessage)
 */
interface SwapProposalMessage {
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
 * to proceed.
 *
 * In v1: The proposer announces the manifest to the escrow upon receipt.
 * In v2: Informational only -- the acceptor announces directly to the escrow
 * with both signatures. The proposer waits for the escrow's announce_result.
 *
 * Wire format: `swap_acceptance:` prefix + JSON.stringify(SwapAcceptanceMessage)
 */
interface SwapAcceptanceMessage {
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
interface SwapRejectionMessage {
  /** Discriminator */
  readonly type: 'swap_rejection';
  /** Protocol version */
  readonly version: 1;
  /** Swap ID identifying which proposal is being rejected */
  readonly swap_id: string;
  /** Optional human-readable reason for rejection */
  readonly reason?: string;
}
```

### 2.5 DM Message Types (Escrow Protocol)

The escrow DM protocol types are defined in the escrow service specification. The `SwapModule` parses the following inbound message types from the escrow. These are **not** re-defined here -- see [`escrow-service/docs/protocol-spec.md`](../../escrow-service/docs/protocol-spec.md) for canonical definitions.

| Inbound from Escrow | Fields Used by SwapModule |
|---|---|
| `announce_result` | `swap_id`, `state`, `deposit_invoice_id`, `is_new`, `created_at` |
| `invoice_delivery` | `swap_id`, `invoice_type`, `invoice_id`, `invoice_token`, `payment_instructions` |
| `status_result` | `swap_id`, `state`, plus extensible extra fields |
| `payment_confirmation` | `swap_id`, `party`, plus extensible extra fields |
| `swap_cancelled` | `swap_id`, `reason`, `deposits_returned` |
| `bounce_notification` | `swap_id`, `reason`, `returned_amount`, `returned_currency` |
| `error` | `error`, `swap_id?`, `details?` |

**Outbound to Escrow:**

| Outbound to Escrow | Description | v1 | v2 |
|---|---|---|---|
| `announce` | Submit manifest to escrow | `{ type: 'announce', manifest }` | `{ type: 'announce', version: 2, manifest, signatures, chain_pubkeys, auxiliary? }` |
| `status` | Query current swap state | `{ type: 'status', swap_id }` | Same |
| `request_invoice` | Request (re-)delivery of invoice token | `{ type: 'request_invoice', swap_id, invoice_type }` | Same |
| `cancel` | Request cancellation and deposit return | `{ type: 'cancel', swap_id, reason }` | Same |

### 2.6 Result Types

```typescript
// =============================================================================
// API Result Types
// =============================================================================

/**
 * Result of proposeSwap().
 */
interface SwapProposalResult {
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
interface ProposeSwapOptions {
  /** Human-readable message sent to the counterparty in the proposal DM. */
  readonly message?: string;
}

/**
 * Options for getSwapStatus().
 */
interface GetSwapStatusOptions {
  /** If true, send a 'status' DM to the escrow and merge the response. Default: false for terminal swaps, true for active swaps. */
  readonly queryEscrow?: boolean;
}

/**
 * Filter options for getSwaps().
 */
interface GetSwapsFilter {
  /** Filter by progress state(s) */
  readonly progress?: SwapProgress | SwapProgress[];
  /** Filter by role */
  readonly role?: SwapRole;
  /** When true, exclude swaps where progress is 'completed', 'cancelled', or 'failed' */
  readonly excludeTerminal?: boolean;
}
```

### 2.7 Event Payload Types

```typescript
// =============================================================================
// Event Payloads (added to SphereEventMap)
// =============================================================================

// New SphereEventType entries:
type SwapEventType =
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

// Event payloads -- these extend SphereEventMap:

interface SwapEventMap {
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
```

### 2.8 Configuration Types

```typescript
// =============================================================================
// Module Configuration
// =============================================================================

/**
 * Configuration for SwapModule.
 * Passed to createSwapModule() factory function.
 */
interface SwapModuleConfig {
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
interface SwapModuleDependencies {
  /**
   * AccountingModule subset -- invoice import, lookup, status, payment,
   * and event subscription. Used for deposit invoice import, deposit
   * payment, and payout verification.
   */
  readonly accounting: {
    importInvoice(token: unknown): Promise<unknown>;
    getInvoice(invoiceId: string): unknown | null;
    getInvoiceStatus(invoiceId: string): unknown;
    payInvoice(invoiceId: string, params: unknown): Promise<TransferResult>;
    on<T extends SphereEventType>(type: T, handler: (data: SphereEventMap[T]) => void): () => void;
  };
  /**
   * PaymentsModule subset -- L3 token validation during payout verification.
   */
  readonly payments: {
    validate(): Promise<{ valid: Token[]; invalid: Token[] }>;
  };
  /**
   * CommunicationsModule subset -- DM send/receive for peer and escrow messaging.
   */
  readonly communications: {
    sendDM(recipientPubkey: string, content: string): Promise<{ eventId: string }>;
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
```

### 2.9 Storage Types

```typescript
// =============================================================================
// Storage Types
// =============================================================================

/**
 * Persistent storage format for a single swap record.
 * Stored at key `swap:{swapId}`.
 */
interface SwapStorageData {
  readonly version: 1;
  readonly swap: SwapRef;
}

/**
 * Index entry for the swap_index key.
 * Lightweight summary for listing/filtering without loading full records.
 */
interface SwapIndexEntry {
  readonly swapId: string;
  readonly progress: SwapProgress;
  readonly role: SwapRole;
  readonly createdAt: number;
}
```

---

## 3. Module Lifecycle

### 3.1 Factory Function

```typescript
/**
 * Create a SwapModule instance.
 * Follows the same factory pattern as createAccountingModule().
 *
 * @param config - Module configuration
 * @returns Object with { module, initialize } -- call initialize() after construction
 */
function createSwapModule(config?: SwapModuleConfig): {
  module: SwapModule;
  initialize: (deps: SwapModuleDependencies) => void;
};
```

### 3.2 Constructor

```typescript
constructor(config?: SwapModuleConfig)
```

The constructor stores configuration only. No I/O, no subscriptions, no storage access. The module is inert until `initialize()` is called.

Internal state initialized:
- `swaps: Map<string, SwapRef>` -- empty
- `terminalSwapIds: Set<string>` -- empty (dedup set for rejected/cancelled/failed swaps)
- `localTimers: Map<string, ReturnType<typeof setTimeout>>` -- empty
- `invoiceToSwapIndex: Map<string, string>` -- empty (invoiceId -> swapId reverse index)
- `destroyed: boolean` -- false
- `loaded: boolean` -- false

### 3.3 initialize(deps)

```typescript
initialize(deps: SwapModuleDependencies): void
```

Stores dependency references. Resets the `destroyed` flag (allowing re-initialization after destroy, e.g., for `switchToAddress()`). Does NOT load data or subscribe to events. Called by `Sphere` immediately after factory construction, before `load()`.

### 3.4 load()

```typescript
async load(): Promise<void>
```

Called by `Sphere` after all modules are initialized. Re-entrant safe: concurrent `load()` calls share the same promise. Steps:

1. **Clear in-memory state** (`swaps`, `terminalSwapIds`, `invoiceToSwapIndex`). Set `loaded = false`.

2. **Load persisted swap records** from storage. Read the `swap_index` key, then load each non-terminal swap record from its per-swap key (`swap:{swapId}`). Purge terminal swap records older than `terminalPurgeTtlMs`. See [section 14.4](#144-load-pattern) for details.

3. **Clean up stale proposals.** For each swap with `progress === 'proposed'`:
   - If `role === 'proposer'` and `Date.now() - createdAt > config.proposalTimeoutMs`: transition to `'failed'` with error `'Proposal timed out'`. Track as terminal.
   - If `role === 'acceptor'`: leave as-is (the user may not have seen it yet).
   - Remove failed proposals from the in-memory `swaps` map (they are terminal).

4. **Register DM handler.** Subscribe to `CommunicationsModule.onDirectMessage()` for incoming swap-related and escrow-related DMs. The handler dispatches by message type prefix:
   - `swap_proposal:` -- see [section 12.1](#121-swap_proposal-received)
   - `swap_acceptance:` -- see [section 12.2](#122-swap_acceptance-received)
   - `swap_rejection:` -- see [section 12.3](#123-swap_rejection-received)
   - JSON objects with `type` field (`announce_result`, `invoice_delivery`, `status_result`, `payment_confirmation`, `swap_cancelled`, `bounce_notification`, `error`) -- see [section 12.4](#124-escrow-dm-processing)

5. **Subscribe to invoice events.** See [section 13](#13-invoice-event-subscriptions).

6. **Rebuild invoiceToSwapIndex.** For each swap with `depositInvoiceId` or `payoutInvoiceId`, populate the reverse index.

7. **Start local timers.** For each non-terminal swap, resume local timeout timers. See [section 16](#16-local-timeout-management).

8. **Crash recovery** (fire-and-forget per swap). For each non-terminal swap, perform state-specific recovery:
   - `accepted` (v2 proposer): send status query (Bob already announced).
   - `accepted` (v2 acceptor): re-announce with v2 format (both signatures).
   - `accepted` (v1): re-announce with v1 format.
   - `announced` / `depositing`: send status query + request deposit invoice if missing.
   - `awaiting_counter`: send status query.
   - `concluding`: send status query + request payout invoice if missing.

9. **Set `loaded = true`.**

### 3.5 destroy()

```typescript
async destroy(): Promise<void>
```

Cleanup sequence:

1. **Set `destroyed = true`** immediately. All public methods check this flag and throw `SWAP_MODULE_DESTROYED` if set.

2. **Unsubscribe** from `CommunicationsModule.onDirectMessage()` and all `AccountingModule` event subscriptions.

3. **Clear all local timers** (`localTimers.forEach(clearTimeout)`).

4. **Await in-flight gate operations.** Drain all entries in the `AsyncGateMap`. This serializes any queued mutations.

5. **Persist dirty state.** Write the current swap index to storage as a safety net.

---

## 4. proposeSwap

```typescript
async proposeSwap(deal: SwapDeal, options?: ProposeSwapOptions): Promise<SwapProposalResult>
```

### 4.1 Step-by-Step

1. **Guard checks.**
   - Throw `SWAP_MODULE_DESTROYED` if `destroyed` is true.
   - Throw `SWAP_NOT_INITIALIZED` if `loaded` is false.

2. **Validate deal fields** (see [section 17.1](#171-deal-validation)).
   - Throw `SWAP_INVALID_DEAL` with a descriptive message for any validation failure.

3. **Resolve escrow address.**
   - `escrowAddress = deal.escrowAddress ?? config.defaultEscrowAddress`
   - If neither is set, throw `SWAP_INVALID_DEAL` with message `'No escrow address: provide deal.escrowAddress or configure defaultEscrowAddress'`.
   - Resolve via `deps.resolve(escrowAddress)` to obtain the escrow's DIRECT:// address and transport pubkey.
   - If resolution fails (returns `null`), throw `SWAP_RESOLVE_FAILED` with message `'Cannot resolve escrow address: {escrowAddress}'`.

4. **Resolve party addresses.**
   - Resolve `deal.partyA` via `deps.resolve()` to obtain `PeerInfo`. Extract `directAddress`.
   - Resolve `deal.partyB` via `deps.resolve()` to obtain `PeerInfo`. Extract `directAddress`.
   - If either resolution fails, throw `SWAP_RESOLVE_FAILED` with the failing address.

5. **Determine role.**
   - Compare resolved DIRECT:// addresses against `deps.getActiveAddresses()`.
   - If `resolvedPartyA` matches one of our tracked addresses: `role = 'proposer'`, counterparty is party B.
   - If `resolvedPartyB` matches: `role = 'proposer'`, counterparty is party A.
   - If neither matches: throw `SWAP_INVALID_DEAL` with message `'Local wallet is neither party A nor party B'`.
   - If both match: throw `SWAP_INVALID_DEAL` with message `'Cannot swap with yourself'`.

6. **Check pending swap limit.**
   - Count non-terminal swaps in `this.swaps`.
   - If `count >= config.maxPendingSwaps`, throw `SWAP_LIMIT_EXCEEDED`.

7. **Build SwapManifest (v2).**
   The manifest always includes the escrow's resolved DIRECT:// address and `protocol_version: 2`. A random salt (32 lowercase hex chars via `randomHex(16)`) is generated to ensure unique swap_id even for identical deal terms.
   ```typescript
   const manifest = buildManifest(
     resolvedPartyA, resolvedPartyB, deal, deal.timeout, escrowPeer.directAddress,
   );
   // manifest includes: party_a_address, party_b_address, currencies, amounts,
   //   timeout, salt, escrow_address, protocol_version: 2, swap_id (computed)
   ```

8. **Sign the swap manifest (v2).**
   ```typescript
   const proposerSignature = signSwapManifest(
     deps.identity.privateKey, manifest.swap_id, escrowPeer.directAddress,
   );
   // Signs "swap_consent:{swapId}:{escrowAddress}" -> 130-char hex (v+r+s)
   ```

9. **Create nametag binding (v2, optional).**
   If the proposer's original address in the deal was a `@nametag`, create a `NametagBindingProof`:
   ```typescript
   const binding = createNametagBinding(
     privateKey, nametag, directAddress, swapId, chainPubkey,
   );
   // Signs "nametag_bind:{nametag}:{directAddress}:{swapId}"
   ```
   Stored in `auxiliary.party_a_binding` or `auxiliary.party_b_binding` depending on which party the proposer is.

10. **Check for duplicate (idempotent).**
   - If `this.swaps.has(swapId)`, return the existing `SwapProposalResult` without sending a duplicate DM or creating a new record. This makes `proposeSwap()` safe to retry.
   - If `swapId` is in `terminalSwapIds`, remove it (allow re-proposing a previously rejected/cancelled/failed swap).

11. **Create SwapRef.**
    ```typescript
    const swap: SwapRef = {
      swapId,
      deal,
      manifest,
      role: 'proposer',
      progress: 'proposed',
      counterpartyPubkey,
      counterpartyNametag,
      escrowPubkey,
      escrowDirectAddress,
      payoutVerified: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      proposerSignature,
      proposerChainPubkey: deps.identity.chainPubkey,
      auxiliary,
      protocolVersion: 2,
    };
    ```

12. **Persist** (persist-before-act): write `SwapRef` to the `swaps` map and persist to storage.

13. **Send proposal DM (v2)** to the counterparty.
    ```typescript
    const dmContent = buildProposalDM_v2(
      manifest, escrowAddress, proposerSignature,
      deps.identity.chainPubkey, auxiliary, options?.message,
    );
    await deps.communications.sendDM(counterpartyPubkey, dmContent);
    ```
    - If the DM send fails, transition to `'failed'`, persist, and throw `SWAP_DM_SEND_FAILED`.

14. **Start proposal timeout timer.**
    ```typescript
    const timer = setTimeout(() => {
      this.withSwapGate(swapId, async () => {
        const s = this.swaps.get(swapId);
        if (s && s.progress === 'proposed') {
          s.progress = 'failed';
          s.error = 'Proposal timed out -- no response from counterparty';
          s.updatedAt = Date.now();
          await this.persistSwap(s);
          deps.emitEvent('swap:failed', { swapId, error: s.error });
        }
      });
    }, config.proposalTimeoutMs ?? 300000);
    this.localTimers.set(swapId, timer);
    ```

15. **Emit event.**
    ```typescript
    deps.emitEvent('swap:proposed', {
      swapId,
      deal,
      recipientPubkey: counterpartyPubkey,
    });
    ```

16. **Return result.**
    ```typescript
    return { swapId, manifest, swap };
    ```

---

## 5. acceptSwap

```typescript
async acceptSwap(swapId: string): Promise<void>
```

### 5.1 Step-by-Step

1. **Guard checks.**
   - Throw `SWAP_MODULE_DESTROYED` if `destroyed` is true.
   - Throw `SWAP_NOT_INITIALIZED` if `loaded` is false.

2. **Look up SwapRef.**
   - `const swap = this.swaps.get(swapId)`
   - If not found, throw `SWAP_NOT_FOUND`.
   - If `swap.progress !== 'proposed'`, throw `SWAP_WRONG_STATE` with message `'Cannot accept: swap is in {swap.progress} state'`.
   - If `swap.role !== 'acceptor'`, throw `SWAP_WRONG_STATE` with message `'Cannot accept: you are the proposer, not the acceptor'`.

3. **Enter per-swap gate** (`withSwapGate(swapId, ...)`). All remaining steps execute inside the gate. Re-check state inside gate (TOCTOU safety).

4. **Transition to 'accepted'.** (persist-before-act)

5. **Protocol-specific flow:**

   **v2 path** (`swap.protocolVersion === 2`):

   a. **Sign the swap manifest.** Use `manifest.escrow_address` (locked at proposal time) as the escrow address for the consent message:
      ```typescript
      const acceptorSignature = signSwapManifest(
        deps.identity.privateKey, swap.manifest.swap_id, escrowAddressForSignature,
      );
      ```

   b. **Create nametag binding (optional).** If the acceptor has a nametag, create a `NametagBindingProof` and merge into the existing auxiliary data.

   c. **Store acceptor signature and auxiliary.** Persist to storage.

   d. **Send acceptance DM (v2) to proposer** (best-effort -- in v2, the acceptance DM is informational):
      ```typescript
      const acceptDM = buildAcceptanceDM_v2(swapId, acceptorSignature, deps.identity.chainPubkey);
      await deps.communications.sendDM(swap.counterpartyPubkey, acceptDM);
      ```

   e. **Emit `swap:accepted`.**

   f. **Announce directly to escrow (v2).** The acceptor sends the v2 announce DM with both party signatures and chain pubkeys:
      ```typescript
      const signatures: ManifestSignatures = {
        party_a: weArePartyA ? acceptorSignature : swap.proposerSignature,
        party_b: weArePartyA ? swap.proposerSignature : acceptorSignature,
      };
      const chainPubkeys = {
        party_a: weArePartyA ? acceptorChainPubkey : proposerChainPubkey,
        party_b: weArePartyA ? proposerChainPubkey : acceptorChainPubkey,
      };
      await sendAnnounce_v2(communications, escrowPubkey, manifest, signatures, chainPubkeys, auxiliary);
      ```
      - On announce failure: transition to `'failed'`, emit `swap:failed`, notify proposer via cancel DM (best-effort).

   **v1 path** (`swap.protocolVersion` is undefined or 1):

   a. **Send acceptance DM (v1) to proposer:**
      ```typescript
      const acceptDM = buildAcceptanceDM(swapId);
      await deps.communications.sendDM(swap.counterpartyPubkey, acceptDM);
      ```
      - On failure: throw `SWAP_DM_SEND_FAILED`. Do NOT change progress (the user can retry).

   b. **Emit `swap:accepted`.**

   c. **Resolve and store escrow address** (best-effort for crash recovery).

> **Design note (v2):** In v2, the acceptor announces directly to the escrow instead of relying on the proposer. This means the proposer does NOT need to be online after sending the proposal. The proposer learns about the escrow acknowledgment when the escrow's `announce_result` DM arrives asynchronously.

> **Design note (v1):** In v1, the proposer is responsible for announcing to the escrow after receiving the acceptance DM. The `acceptSwap()` method returns after sending the acceptance DM.

---

## 6. rejectSwap

```typescript
async rejectSwap(swapId: string, reason?: string): Promise<void>
```

### 6.1 Step-by-Step

1. **Guard checks.** Same as acceptSwap (destroyed, loaded).

2. **Look up SwapRef.**
   - Must exist.
   - Rejection is allowed at any pre-payout state: `proposed`, `accepted`, `announced`, `depositing`, `awaiting_counter`.
   - Throw `SWAP_WRONG_STATE` if `progress === 'concluding'` (payouts already in progress).
   - Throw `SWAP_ALREADY_COMPLETED` if `progress === 'completed'`.
   - Throw `SWAP_ALREADY_CANCELLED` if `progress === 'cancelled'` or `'failed'`.

3. **Enter per-swap gate.** Re-check state inside gate (TOCTOU safety).

4. **Send rejection DM** to the counterparty (best-effort -- failure is non-blocking).
   ```typescript
   const dmContent = buildRejectionDM(swapId, reason);
   await deps.communications.sendDM(swap.counterpartyPubkey, dmContent);
   ```

5. **Notify escrow** (if post-announcement). If the swap is in `announced`, `depositing`, or `awaiting_counter` state and an escrow pubkey is available, send a cancel DM to the escrow to request cancellation and deposit return:
   ```typescript
   const cancelDM = buildCancelDM(swapId, reason ?? 'Rejected by user');
   await deps.communications.sendDM(swap.escrowPubkey, cancelDM);
   ```

6. **Clear local timer.**

7. **Transition to 'cancelled'** (not 'failed' -- rejection is a deliberate user action, not an error).
   ```typescript
   await this.transitionProgress(swap, 'cancelled', { error: reason ?? 'Rejected by user' });
   ```

8. **Emit `swap:rejected`.**
   ```typescript
   deps.emitEvent('swap:rejected', { swapId, reason });
   ```

9. **Emit `swap:cancelled`.**
   ```typescript
   deps.emitEvent('swap:cancelled', { swapId, reason: 'rejected', depositsReturned: false });
   ```

---

## 7. deposit

```typescript
async deposit(swapId: string): Promise<TransferResult>
```

### 7.1 Step-by-Step

1. **Guard checks.** Same pattern (destroyed, loaded).

2. **Look up SwapRef.**
   - Must exist.
   - Must be in `'announced'` progress.
   - Throw `SWAP_NOT_FOUND` or `SWAP_WRONG_STATE` as appropriate.
   - Must have `depositInvoiceId` set (set during announcement processing). If missing, throw `SWAP_WRONG_STATE` with message `'Deposit invoice not yet available'`.

3. **Determine asset index.**
   - The deposit invoice has a single target (the escrow's address) with two assets:
     - Asset index 0 = `party_a_currency_to_change` (party A's deposit)
     - Asset index 1 = `party_b_currency_to_change` (party B's deposit)
   - Determine which party we are from `swap.manifest`:
     - Compare our DIRECT:// address against `swap.manifest.party_a_address` and `swap.manifest.party_b_address`.
     - If we are party A: `assetIndex = 0`.
     - If we are party B: `assetIndex = 1`.

4. **Enter per-swap gate.** Re-check state inside gate (TOCTOU safety).

5. **Call `accounting.payInvoice()`.**
   ```typescript
   const transferResult = await deps.accounting.payInvoice(swap.depositInvoiceId!, {
     targetIndex: 0,      // single-target deposit invoice
     assetIndex,           // 0 for party A, 1 for party B
     // amount is omitted -- SDK computes remaining needed amount
   });
   ```
   - On failure: throw `SWAP_DEPOSIT_FAILED` wrapping the underlying error. Do NOT change progress (the user can retry after resolving the issue, e.g., insufficient balance).

6. **Update state.**
   ```typescript
   await this.transitionProgress(swap, 'depositing', {
     localDepositTransferId: transferResult.id,
   });
   ```

7. **Emit `swap:deposit_sent`.**
   ```typescript
   deps.emitEvent('swap:deposit_sent', { swapId, transferResult });
   ```

8. **Return `transferResult`.**

> **Note:** The transition from `'depositing'` to `'awaiting_counter'` happens asynchronously when the `invoice:payment` event confirms our deposit. See [section 13.1](#131-invoicepayment-on-deposit-invoice).

---

## 8. getSwapStatus

```typescript
async getSwapStatus(swapId: string, options?: GetSwapStatusOptions): Promise<SwapRef>
```

### 8.1 Step-by-Step

1. **Guard checks.** (destroyed, loaded).

2. **Look up SwapRef.**
   - If not found, throw `SWAP_NOT_FOUND`.

3. **Optionally refresh from escrow.**
   - Determine whether to query: `const shouldQuery = options?.queryEscrow ?? !TERMINAL_PROGRESS.has(swap.progress)`. If `options.queryEscrow` is explicitly set, use that value; otherwise default to `true` for active swaps and `false` for terminal swaps.
   - If `shouldQuery` is true AND the swap has an escrow address, send a `status` DM to the escrow (fire-and-forget -- errors are logged but not propagated):
     ```typescript
     const statusDM = buildStatusQueryDM(swapId);
     deps.communications.sendDM(escrowTransportPubkey, statusDM);
     ```
   - The `status_result` response is handled asynchronously by the DM handler. The method does NOT block for the response.

4. **Return a deep copy** of the current `SwapRef` (prevents external mutation of internal state).

> **Design note:** `getSwapStatus()` is async to support the optional escrow query, but it returns immediately with the current local state. Applications that need the freshest escrow state should call `getSwapStatus()` and then listen for `swap:*` events triggered by the escrow's response.

---

## 9. getSwaps

```typescript
getSwaps(filter?: GetSwapsFilter): SwapRef[]
```

### 9.1 Behavior

- **Synchronous.** Reads from the in-memory `swaps` map. No I/O.
- Returns deep copies of `SwapRef` objects (not references to internal state).
- Default sort: `updatedAt` descending (most recently active first).

### 9.2 Filtering

```typescript
getSwaps(filter?: GetSwapsFilter): SwapRef[] {
  let results = Array.from(this.swaps.values());

  if (filter?.progress) {
    const allowed = Array.isArray(filter.progress)
      ? new Set(filter.progress)
      : new Set([filter.progress]);
    results = results.filter(s => allowed.has(s.progress));
  }

  if (filter?.excludeTerminal) {
    results = results.filter(s => !TERMINAL_PROGRESS.has(s.progress));
  }

  if (filter?.role) {
    results = results.filter(s => s.role === filter.role);
  }

  results.sort((a, b) => b.updatedAt - a.updatedAt);
  return results.map(s => ({ ...s, deal: { ...s.deal }, manifest: { ...s.manifest } }));
}
```

---

## 10. verifyPayout

```typescript
async verifyPayout(swapId: string): Promise<boolean>
```

### 10.1 Step-by-Step

1. **Guard checks.** (destroyed, loaded).

2. **Look up SwapRef.**
   - Must exist.
   - Must have `payoutInvoiceId` set. If not, throw `SWAP_WRONG_STATE` with message `'Payout invoice not yet received'`.

3. **Enter per-swap gate.**

4. **Get invoice ref and status.**
   ```typescript
   const invoiceRef = deps.accounting.getInvoice(swap.payoutInvoiceId!);
   if (!invoiceRef) throw new SphereError('Payout invoice not found', 'SWAP_PAYOUT_VERIFICATION_FAILED');
   const status = deps.accounting.getInvoiceStatus(swap.payoutInvoiceId!);
   ```

5. **Verify invoice terms match expectations.**
   - Determine expected currency and amount:
     - If we are party A (our DIRECT address matches `manifest.party_a_address`):
       - Expected currency: `manifest.party_b_currency_to_change` (we receive B's currency)
       - Expected amount: `manifest.party_b_value_to_change`
     - If we are party B:
       - Expected currency: `manifest.party_a_currency_to_change`
       - Expected amount: `manifest.party_a_value_to_change`
   - Verify:
     - `invoiceRef.terms.targets[0].address` matches our DIRECT:// address
     - `invoiceRef.terms.targets[0].assets[0].coin![0]` matches expected currency
     - `invoiceRef.terms.targets[0].assets[0].coin![1]` matches expected amount
     - `invoiceRef.terms.creator` is defined (escrow invoices are non-anonymous)
   - If any check fails: set `swap.payoutVerified = false`, persist, emit `swap:failed` with descriptive error, return `false`.

6. **Verify coverage.**
   - `status.state` must be `'COVERED'` or `'CLOSED'`.
   - `status.targets[0].coinAssets[0].isCovered` must be `true`.
   - `BigInt(status.targets[0].coinAssets[0].netCoveredAmount) >= BigInt(expectedAmount)`.
   - If not covered: return `false` without error (the payout may still be in progress).

7. **Verify escrow creator identity.**
   - Resolve the escrow address and verify `invoiceRef.terms.creator` matches the escrow's chain pubkey.
   - If mismatched: set `swap.payoutVerified = false`, persist, emit `swap:failed` with error `'Payout invoice creator does not match escrow pubkey'`, return `false`.

8. **Validate L3 inclusion proofs.**
   - Call `deps.payments.validate()` to confirm L3 inclusion proofs against the aggregator's Sparse Merkle Tree.
   - If any tokens are invalid: set `swap.payoutVerified = false`, persist, emit `swap:failed`, return `false`.

9. **Update state on success.**
   ```typescript
   await this.transitionProgress(swap, 'completed', { payoutVerified: true });
   ```

10. **Emit `swap:completed`.**
    ```typescript
    deps.emitEvent('swap:completed', { swapId, payoutVerified: true });
    ```

11. **Return `true`.**

---

## 11. cancelSwap

```typescript
async cancelSwap(swapId: string): Promise<void>
```

### 11.1 Cancellable States

`cancelSwap` can be called at any progress from `proposed` through `awaiting_counter` (inclusive). Specifically:

| Progress | Cancellation behavior |
|----------|----------------------|
| `proposed` | Local-only cancellation. Notifies counterparty via rejection DM (best-effort). |
| `accepted` | Local-only cancellation. Notifies counterparty. |
| `announced` | Notifies escrow via cancel DM + counterparty via rejection DM. |
| `depositing` | Notifies escrow via cancel DM + counterparty. Deposits will be returned by the escrow. |
| `awaiting_counter` | Notifies escrow via cancel DM + counterparty. Deposits will be returned by the escrow. |
| `concluding` | **NOT cancellable** -- payouts are already in progress. Throws `SWAP_WRONG_STATE`. |
| `completed` | Throws `SWAP_ALREADY_COMPLETED`. |
| `cancelled` / `failed` | Throws `SWAP_ALREADY_CANCELLED`. |

### 11.2 Step-by-Step

1. **Guard checks.** (destroyed, loaded).

2. **Look up SwapRef.**
   - Must exist.
   - If `swap.progress` is `concluding`: throw `SWAP_WRONG_STATE`.
   - If `swap.progress` is `completed`: throw `SWAP_ALREADY_COMPLETED`.
   - If `swap.progress` is `cancelled` or `failed`: throw `SWAP_ALREADY_CANCELLED`.

3. **Enter per-swap gate.** Re-check state inside gate (TOCTOU safety).

4. **Clear local timer.**

5. **Notify escrow** (if post-announcement). If the swap has `escrowPubkey` and progress is `announced`, `depositing`, or `awaiting_counter`, send a cancel DM:
   ```typescript
   const cancelDM = buildCancelDM(swapId, 'Cancelled by user');
   await deps.communications.sendDM(swap.escrowPubkey, cancelDM);
   ```
   On failure: log warning, continue.

6. **Notify counterparty** (best-effort) via rejection DM.

7. **Transition to 'cancelled'.**
   ```typescript
   await this.transitionProgress(swap, 'cancelled', { error: 'Cancelled by user' });
   ```

8. **Emit `swap:cancelled`.**
   ```typescript
   deps.emitEvent('swap:cancelled', {
     swapId,
     reason: 'explicit',
     depositsReturned: false,
   });
   ```

---

## 12. Incoming DM Processing

All DM processing uses the `parseSwapDM()` universal parser which returns a typed discriminated union (`ParsedSwapDM`) with kinds: `proposal`, `acceptance`, `rejection`, `escrow`. All errors during DM processing are caught internally and logged -- they NEVER propagate to the calling code.

### 12.1 swap_proposal Received

Triggered when a DM arrives with the `swap_proposal:` prefix.

1. **Parse message.**
   - Parse via `parseSwapDM()` into a `SwapProposalMessage`.
   - On parse failure: silently ignore.

2. **Validate version.**
   - Accept `version === 1` and `version === 2`.
   - Other values: silently ignore.

3. **Validate manifest integrity.**
   - Call `verifyManifestIntegrity(manifest)` to verify `swap_id` matches `SHA-256(JCS(manifestFields))`. Includes `salt`, and for v2, `escrow_address` and `protocol_version`.
   - Call `validateManifest(manifest)` for field-level validation.
   - On validation failure: silently ignore.

4. **Check pending swap limit.** If exceeded, silently ignore.

5. **Check for duplicate.** If `swaps.has(swap_id)` or `terminalSwapIds.has(swap_id)`, silently ignore.

6. **Determine role.**
   - Compare manifest party addresses against our tracked addresses.
   - If `manifest.party_a_address` matches: we are party A. Counterparty is B. `role = 'acceptor'`.
   - If `manifest.party_b_address` matches: we are party B. Counterparty is A. `role = 'acceptor'`.
   - If neither matches: silently ignore (proposal is not for us).

7. **Verify sender identity.**
   - Resolve the counterparty's address from the manifest.
   - If a peer is found, verify `dm.senderPubkey` matches the peer's `transportPubkey`. If not, silently drop.
   - If peer resolution returns null: allow v2 proposals to proceed (chain pubkey verification below will catch fakes); v1 relies on transport-layer authentication.

8. **v2 verification (when `version === 2`).**
   - Verify `proposer_signature` and `proposer_chain_pubkey` are present. If missing, silently drop.
   - Verify `manifest.escrow_address` is present. If missing, silently drop.
   - Verify proposer's signature via `verifySwapSignature(swap_id, escrow_address, proposer_signature, proposer_chain_pubkey)`. If invalid, silently drop.
   - Resolve proposer's address from the manifest and verify `chainPubkey` matches `proposer_chain_pubkey`. If mismatch, silently drop.
   - Verify any nametag bindings in `auxiliary` via `verifyNametagBinding()`. If invalid, silently drop.

9. **Reconstruct SwapDeal** from the manifest and escrow address in the proposal message.

10. **Resolve escrow address** (best-effort, for DM sender verification later).

11. **Create SwapRef.**
    ```typescript
    const swap: SwapRef = {
      swapId: manifest.swap_id,
      deal,
      manifest,
      role: 'acceptor',
      progress: 'proposed',
      counterpartyPubkey: dm.senderPubkey,
      counterpartyNametag: dm.senderNametag,
      escrowPubkey,
      escrowDirectAddress,
      payoutVerified: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      proposerSignature,            // v2 only
      proposerChainPubkey,          // v2 only
      auxiliary: proposalMsg.auxiliary,  // v2 only
      protocolVersion: proposalMsg.version,
    };
    ```

12. **Persist.**

13. **Emit `swap:proposal_received`.**

### 12.2 swap_acceptance Received

Triggered when a DM arrives with the `swap_acceptance:` prefix.

1. **Parse and validate.**

2. **Look up SwapRef** by `swap_id`.
   - Must exist, `role === 'proposer'`.
   - Must be in `proposed` or `accepted` state. If not, silently ignore.
   - Skip stale acceptances from a previous proposal instance (timestamp check).

3. **Verify sender** is the expected counterparty (`dm.senderPubkey === swap.counterpartyPubkey`). If not, silently ignore.

4. **Downgrade attack prevention (v2).** If `swap.protocolVersion === 2`:
   - **MUST** receive a v2 acceptance (`acceptMsg.version === 2`) with `acceptor_signature` and `acceptor_chain_pubkey`.
   - A v1-format acceptance on a v2 swap is silently dropped WITHOUT clearing the proposal timer. This prevents a malicious actor from downgrading the security model.
   - Verify the acceptor's signature via `verifySwapSignature()`. If invalid, silently drop without clearing the timer.

5. **Enter per-swap gate** (only if still in `proposed` state).

6. **Cancel proposal timeout timer.**

7. **Transition to 'accepted'.** Persist. Store verified v2 acceptor signature if present.

8. **Emit `swap:accepted`.**

9. **Protocol-specific escrow announcement:**
   - **v2:** Proposer does NOT announce to escrow. The acceptor already did it. Wait for `announce_result` from escrow.
   - **v1:** Proposer announces to escrow via `sendAnnounce()`.

### 12.3 swap_rejection Received

Triggered when a DM arrives with the `swap_rejection:` prefix.

1. **Parse and validate.**

2. **Look up SwapRef** by `swap_id`.
   - Must exist, `progress === 'proposed'`, `role === 'proposer'`.

3. **Verify sender** is the counterparty.

4. **Skip stale rejections** (timestamp check against `swap.createdAt`).

5. **Enter per-swap gate.** Skip if already terminal.

6. **Cancel proposal timeout timer.**

7. **Transition to 'cancelled'.** Store `reason` from the rejection message. Persist.

8. **Emit `swap:rejected`.**
   ```typescript
   deps.emitEvent('swap:rejected', { swapId, reason: rejectionMsg.reason });
   ```

9. **Emit `swap:cancelled`.**
   ```typescript
   deps.emitEvent('swap:cancelled', { swapId, reason: 'explicit', depositsReturned: false });
   ```

### 12.4 Escrow DM Processing

DMs from the escrow are JSON objects. The handler attempts `JSON.parse()` on the DM content. If parsing succeeds and the result has a `type` field matching a known escrow message type, it is dispatched here. If parsing fails or the type is unrecognized, the DM is ignored.

**Sender verification:** Before processing any escrow DM, verify that `dm.senderPubkey` matches the escrow's resolved transport pubkey for the associated swap. If not, silently ignore. This prevents a malicious party from spoofing escrow responses.

#### 12.4.1 announce_result

1. Find swap by `swap_id` in the message.
2. Verify escrow sender.
3. Must be in `'accepted'` or `'proposed'` progress. In v2, the escrow's `announce_result` may arrive before the acceptance DM from the counterparty (because the acceptor announces directly). If not in an accepted state, log and ignore.
4. Store `depositInvoiceId = msg.deposit_invoice_id`.
5. Store `escrowState = msg.state`.
6. Update `invoiceToSwapIndex`. Persist.
7. Do not transition yet -- wait for `invoice_delivery`.

#### 12.4.2 invoice_delivery (deposit)

**DM ordering note:** The `invoice_delivery` handler handles the case where `announce_result` hasn't arrived yet. If a swap in `accepted` state receives an `invoice_delivery` for a deposit invoice, the handler: (1) matches by `swap_id` from the invoice memo, (2) sets `depositInvoiceId` AND transitions to `announced` in one step.

1. Find swap by `swap_id`.
2. Verify escrow sender.
3. `msg.invoice_type` must be `'deposit'`.
4. Import the invoice token:
   ```typescript
   await deps.accounting.importInvoice(msg.invoice_token);
   ```
   - On failure: log error, transition to `'failed'`. Return.
5. Verify deposit invoice terms match the manifest (see [section 17.4](#174-deposit-invoice-verification)).
6. Transition to `'announced'`. Set `swap.announcedAt = Date.now()`. Persist.
7. Start local timeout timer (see [section 16](#16-local-timeout-management)).
8. Emit `swap:announced` with `depositInvoiceId`.

#### 12.4.3 invoice_delivery (payout)

1. Find swap by `swap_id`.
2. Verify escrow sender.
3. `msg.invoice_type` must be `'payout'`.
4. Import the payout invoice token:
   ```typescript
   await deps.accounting.importInvoice(msg.invoice_token);
   ```
5. Store `payoutInvoiceId = msg.invoice_id`.
6. Persist.
7. Emit `swap:payout_received` with `payoutInvoiceId`.
8. Attempt automatic verification via `verifyPayout(swapId)`. If verification succeeds, the swap transitions to `'completed'` and emits `swap:completed`. If verification returns `false` (payout not yet covered), leave state as-is -- the `invoice:payment` subscription will trigger re-verification when coverage arrives.

#### 12.4.4 status_result

1. Find swap by `swap_id`.
2. Verify escrow sender.
3. Update `swap.escrowState = msg.state`.
4. Map the escrow state to client-side progress via `mapEscrowStateToProgress()`:
   - `ANNOUNCED`, `DEPOSIT_INVOICE_CREATED` -> `announced`
   - `PARTIAL_DEPOSIT` -> `depositing`
   - `DEPOSIT_COVERED` -> `awaiting_counter`
   - `CONCLUDING` -> `concluding`
   - `COMPLETED` -> `completed`
   - `TIMED_OUT`, `CANCELLING`, `CANCELLED` -> `cancelled`
   - `FAILED` -> `failed`
5. Persist.
6. If the mapped progress is a terminal state and our local progress is non-terminal, transition accordingly.

#### 12.4.5 payment_confirmation

1. Find swap by `swap_id`.
2. Verify escrow sender.
3. Transition to `'concluding'` (if not already). Persist.
4. Emit `swap:concluding`.

#### 12.4.6 swap_cancelled

1. Find swap by `swap_id`.
2. Verify escrow sender.
3. If already terminal locally, ignore.
4. Transition to `'cancelled'`.
5. Clear local timers.
6. Persist.
7. Emit `swap:cancelled`:
   ```typescript
   deps.emitEvent('swap:cancelled', {
     swapId,
     reason: msg.reason === 'timeout' ? 'timeout' : 'escrow_failed',
     depositsReturned: msg.deposits_returned,
   });
   ```

#### 12.4.7 bounce_notification

1. Find swap by `swap_id`.
2. Verify escrow sender.
3. Log a warning with the bounce reason.
4. Emit `swap:bounce_received`:
   ```typescript
   deps.emitEvent('swap:bounce_received', {
     swapId,
     reason: msg.reason,
     returnedAmount: msg.returned_amount,
     returnedCurrency: msg.returned_currency,
   });
   ```

#### 12.4.8 error

1. Find swap by `swap_id` (if the error includes one).
2. Verify escrow sender (if swap found).
3. Log the error.
4. If the swap is in `'accepted'` state (error in response to announce): transition to `'failed'` with the escrow's error message. Persist. Emit `swap:failed`.
5. For other states: log only, do not change state. The error may be transient.

---

## 13. Invoice Event Subscriptions

The `SwapModule` subscribes to `AccountingModule` events to track deposit and payout progress. Subscriptions are established during `load()` for existing swaps and dynamically when new deposit/payout invoices are imported.

### 13.1 invoice:payment on Deposit Invoice

When an `invoice:payment` event fires for a deposit invoice associated with a swap:

1. **Identify the swap** by looking up which `SwapRef` has `depositInvoiceId === event.invoiceId` (via `invoiceToSwapIndex`).

2. **Determine which party's deposit this is.**
   - Inspect the event's `transfer.coinId`:
     - If `coinId === manifest.party_a_currency_to_change`: party A deposited.
     - If `coinId === manifest.party_b_currency_to_change`: party B deposited.
   - Emit `swap:deposit_confirmed`:
     ```typescript
     deps.emitEvent('swap:deposit_confirmed', {
       swapId,
       party,
       amount: transfer.amount,
       coinId: transfer.coinId,
     });
     ```

3. **Check if our deposit is confirmed.**
   - If the confirmed party matches our side AND `swap.progress === 'depositing'`:
     - Transition to `'awaiting_counter'`. Persist.
   - If our deposit was already confirmed (`progress === 'awaiting_counter'`) and the OTHER party's deposit just arrived:
     - This means both sides are covered. The escrow will fire `invoice:covered` next.

### 13.2 invoice:covered on Deposit Invoice

When `invoice:covered` fires for the deposit invoice:

1. **Emit `swap:deposits_covered`.**
   ```typescript
   deps.emitEvent('swap:deposits_covered', { swapId });
   ```

2. **Clear the local timeout timer** for this swap. The escrow will now execute payouts; timeout is no longer a concern.

3. **Transition to `'concluding'`** (if not already). Persist.

> **Note:** The `invoice:covered` event comes from the local `AccountingModule` -- it fires when the imported deposit invoice's status computation shows all assets covered. This happens when both parties' deposits are confirmed locally.

### 13.3 invoice:created for Payout Invoice

The payout invoice is imported by the DM handler (section 12.4.3) when `invoice_delivery` arrives from the escrow. The `invoice:created` event fires after the import. This event is informational -- the DM handler already handles the state transition. No additional action is needed here.

### 13.4 invoice:return_received

When the deposit invoice has returns (after timeout/cancellation):

1. **Identify the swap** by deposit invoice ID.
2. If `swap.progress` is non-terminal: the escrow cancelled and returned deposits.
3. Transition to `'cancelled'` with reason `'timeout'`. Persist.
4. Emit `swap:cancelled`.

---

## 14. Storage Schema

### 14.1 Per-Address Scoped

All swap data is stored per-address, following the same scoping model as `AccountingModule`.

Storage uses per-swap keys and an index key:

- **Per-swap key:** `swap:{swapId}` -- serialized `SwapStorageData` JSON containing the full `SwapRef`.
- **Index key:** `swap_index` -- JSON array of `SwapIndexEntry` entries. Provides a lightweight lookup without deserializing every swap record.

Where keys are scoped to the currently active `TrackedAddress.addressId` (e.g., `DIRECT_abc123_xyz789`) via the storage provider's per-address scoping.

### 14.2 Data Format

```typescript
/**
 * Persistent storage format for a single swap record.
 * Stored at key `swap:{swapId}`.
 */
interface SwapStorageData {
  /** Version for forward-compatible schema evolution */
  readonly version: 1;
  /** The swap record */
  readonly swap: SwapRef;
}

/**
 * Index entry for the swap_index key.
 * Lightweight summary for listing/filtering without loading full records.
 */
interface SwapIndexEntry {
  readonly swapId: string;
  readonly progress: SwapProgress;
  readonly role: SwapRole;
  readonly createdAt: number;
}
```

### 14.3 Persist Pattern

On state transition, write the per-swap key and update the index:

```typescript
// Pattern used in every state transition:
async function transitionProgress(
  swap: SwapRef,
  newProgress: SwapProgress,
  updates?: Partial<SwapRef>,
): Promise<void> {
  // 1. Validate transition
  assertTransition(swap.progress, newProgress);
  // 2. Update in memory
  swap.progress = newProgress;
  swap.updatedAt = Date.now();
  if (updates) Object.assign(swap, updates);
  // 3. Set announcedAt when entering 'announced' state
  if (newProgress === 'announced' && !swap.announcedAt) {
    swap.announcedAt = Date.now();
  }
  // 4. Persist per-swap key
  const data: SwapStorageData = { version: 1, swap };
  await this.storage.set(`swap:${swap.swapId}`, JSON.stringify(data));
  // 5. Update index
  await this.persistIndex();
  // 6. Track terminal ID and clear local timer on terminal states
  if (isTerminalProgress(newProgress)) {
    this.clearLocalTimer(swap.swapId);
    this.terminalSwapIds.add(swap.swapId);
  }
  // 7. External action happens AFTER persist returns
}
```

Every state transition is persisted to storage BEFORE any external action (DM send, invoice operation). This ensures that a crash between persist and action results in a recoverable state -- the worst case is a redundant DM or a redundant invoice operation, both of which are idempotent.

### 14.4 Load Pattern

On `load()`:
1. Read `swap_index` from storage. Parse JSON. If missing or corrupt, start with an empty array.
2. For each entry in the index where `progress` is NOT terminal (`completed`, `cancelled`, `failed`):
   a. Read `swap:{swapId}` from storage.
   b. Parse JSON as `SwapStorageData`. Validate `version` field. If `version > 1`, log warning and attempt best-effort parsing (ignore unknown fields).
   c. If missing or corrupt, skip (remove from index on next persist).
   d. Populate `this.swaps` with the deserialized `SwapRef`.
3. Terminal swap records are NOT loaded into memory -- they remain in storage for dedup (via `terminalSwapIds`) and are purged after `terminalPurgeTtlMs`.
4. Purge expired terminal records from storage (delete per-swap key) and re-persist a clean index.

---

## 15. Per-Swap Async Mutex

### 15.1 withSwapGate(swapId, fn)

The `SwapModule` uses `AsyncGateMap` (shared utility from `core/async-gate.ts`) to serialize operations per swap ID:

```typescript
private async withSwapGate<T>(swapId: string, fn: () => Promise<T>): Promise<T> {
  return this._gateMap.withGate(swapId, fn, () => this.destroyed, 'SWAP_MODULE_DESTROYED');
}
```

### 15.2 Guarantees

- **Serialization:** Only one mutation runs at a time for a given swap ID.
- **No global lock:** Different swaps run concurrently.
- **Drain on destroy:** `destroy()` calls `_gateMap.drainAll()` before returning.
- **Starvation prevention:** Each gate entry is a promise chain, not a blocking lock. JavaScript's event loop ensures FIFO ordering.
- **Destroy-aware:** If the module is destroyed while a gate is in progress, subsequent operations short-circuit with `SWAP_MODULE_DESTROYED`.

### 15.3 Which Operations Use the Gate

All state-mutating operations enter the gate:
- `acceptSwap()` (steps 3 onward)
- `rejectSwap()` (steps 3 onward)
- `deposit()` (step 4 onward)
- `cancelSwap()` (steps 3 onward)
- `verifyPayout()` (verification and state transition)
- All DM handlers in section 12 that modify `SwapRef`
- All invoice event handlers in section 13 that modify `SwapRef`
- Proposal timeout callback (section 4.1 step 14)
- Local timeout callback (section 16)
- Escrow resolution during crash recovery (section 3.4 step 8)

Read-only operations (`getSwaps()`, `getSwapStatus()`) do NOT enter the gate.

---

## 16. Local Timeout Management

### 16.1 Purpose

Local timers mirror the escrow's timeout as a defense-in-depth mechanism. If the escrow's `swap_cancelled` DM is lost (Nostr relay failure, escrow crash), the local timer ensures the swap eventually transitions to a terminal state in the wallet.

### 16.2 Timer Lifecycle

**Start:** When a swap enters `'announced'` state (deposit invoice available), start a timer:
```typescript
const timeoutMs = swap.manifest.timeout * 1000;
// Add a 30-second grace period to let the escrow cancel first
const localTimeoutMs = timeoutMs + 30_000;
const timer = setTimeout(() => {
  this.withSwapGate(swap.swapId, async () => {
    const s = this.swaps.get(swap.swapId);
    if (!s || isTerminalProgress(s.progress)) return; // already resolved
    await this.transitionProgress(s, 'cancelled', {
      error: 'Local timeout -- escrow did not respond within the expected window',
    });
    deps.emitEvent('swap:cancelled', {
      swapId: s.swapId,
      reason: 'timeout',
      depositsReturned: undefined,
    });
  });
}, localTimeoutMs);
this.localTimers.set(swap.swapId, timer);
```

**Clear:** Timers are cleared when:
- The swap reaches any terminal state (`completed`, `cancelled`, `failed`).
- `deposits_covered` fires (the escrow is proceeding with payouts -- timeout no longer relevant).
- `destroy()` clears all timers.

**Resume on load:** During `load()`, for non-terminal swaps that were `'announced'` or later, compute the remaining time. If `announcedAt` is undefined (swap not yet announced), skip timer -- the swap will be cancelled by the proposal timeout instead.
```typescript
if (!swap.announcedAt) return; // not yet announced -- proposal timeout handles this
const elapsed = Date.now() - swap.announcedAt;
const totalTimeout = swap.manifest.timeout * 1000 + 30_000;
const remaining = totalTimeout - elapsed;
if (remaining <= 0) {
  // Already expired -- cancel immediately
  await this.transitionProgress(swap, 'cancelled', {
    error: 'Swap timed out during offline period',
  });
} else {
  // Start timer for remaining duration
  const timer = setTimeout(/* same handler */, remaining);
  this.localTimers.set(swap.swapId, timer);
}
```

---

## 17. Validation Rules

### 17.1 Deal Validation

Called by `proposeSwap()` before any resolution or manifest construction.

| Field | Rule | Error |
|---|---|---|
| `partyA` | Non-empty string | `SWAP_INVALID_DEAL: partyA is required` |
| `partyB` | Non-empty string | `SWAP_INVALID_DEAL: partyB is required` |
| `partyA` vs `partyB` | Must differ (case-insensitive for nametags) | `SWAP_INVALID_DEAL: partyA and partyB must be different` |
| `partyACurrency` | Non-empty string, alphanumeric, 1-20 chars (`/^[A-Za-z0-9]{1,20}$/`). Aligned with AccountingModule's createInvoice validation (max 20 chars). | `SWAP_INVALID_DEAL: partyACurrency must be 1-20 alphanumeric characters` |
| `partyBCurrency` | Same rule as partyACurrency | `SWAP_INVALID_DEAL: partyBCurrency must be 1-20 alphanumeric characters` |
| `partyACurrency` vs `partyBCurrency` | Must differ (case-sensitive) | `SWAP_INVALID_DEAL: currencies must differ` |
| `partyAAmount` | Positive integer string: `/^[1-9][0-9]*$/` | `SWAP_INVALID_DEAL: partyAAmount must be a positive integer string` |
| `partyBAmount` | Same rule | `SWAP_INVALID_DEAL: partyBAmount must be a positive integer string` |
| `timeout` | Integer, range [60, 86400] | `SWAP_INVALID_DEAL: timeout must be an integer between 60 and 86400 seconds` |
| `escrowAddress` | If provided: non-empty string. If omitted: `config.defaultEscrowAddress` must exist. | `SWAP_INVALID_DEAL: No escrow address` |

### 17.2 Manifest Validation

Applied when receiving a `swap_proposal` DM. Mirrors the escrow's `manifest-validator.ts` rules.

| Field | Rule | Action on Failure |
|---|---|---|
| `swap_id` | Exactly 64 lowercase hex chars (`/^[0-9a-f]{64}$/`) | Silent reject |
| `party_a_address` | Valid Sphere address (DIRECT://, PROXY://, or @nametag) | Silent reject |
| `party_b_address` | Valid Sphere address, differs from `party_a_address` | Silent reject |
| `party_a_currency_to_change` | 1-20 alphanumeric chars. Aligned with AccountingModule's createInvoice validation (max 20 chars). | Silent reject |
| `party_b_currency_to_change` | 1-20 alphanumeric chars, differs from `party_a_currency_to_change` | Silent reject |
| `party_a_value_to_change` | Positive integer string (`/^[1-9][0-9]*$/`) | Silent reject |
| `party_b_value_to_change` | Same rule | Silent reject |
| `timeout` | Integer in [60, 86400] | Silent reject |
| `salt` | Exactly 32 lowercase hex chars (`/^[0-9a-f]{32}$/`) | Silent reject |
| `protocol_version` | When present, must be `2` | Silent reject |
| `escrow_address` | When `protocol_version` is `2`, must be a valid DIRECT:// address | Silent reject |
| `swap_id` integrity | Must equal `SHA-256(JCS(manifestFields))` where `manifestFields` contains all fields except `swap_id`. For v1: 8 fields. For v2: 10 fields (8 + `escrow_address` + `protocol_version`). The `!== undefined` check determines field inclusion. | Silent reject |

### 17.3 Swap ID Computation

```typescript
import canonicalize from 'canonicalize';
import { sha256 } from '../../core/crypto.js';

interface ManifestFields {
  party_a_address: string;
  party_b_address: string;
  party_a_currency_to_change: string;
  party_a_value_to_change: string;
  party_b_currency_to_change: string;
  party_b_value_to_change: string;
  timeout: number;
  salt: string;
  escrow_address?: string;      // v2 only
  protocol_version?: number;     // v2 only
}

function computeSwapId(fields: ManifestFields): string {
  const canonical = canonicalize(fields);
  if (!canonical) {
    throw new Error('Failed to canonicalize manifest fields');
  }
  return sha256(canonical, 'utf8');
}
```

The `canonicalize` npm package implements RFC 8785 (JSON Canonicalization Scheme). The SDK uses `sha256()` from `core/crypto.ts` which accepts a UTF-8 string input. The escrow service uses Node.js `crypto.createHash('sha256')`. Both produce the same SHA-256 output.

**Field inclusion rule:** Fields with value `!== undefined` are included in the canonical JSON. This means:
- v1 manifests: 8 fields (party addresses, currencies, amounts, timeout, salt)
- v2 manifests: 10 fields (same 8 + `escrow_address` + `protocol_version`)

### 17.4 Deposit Invoice Verification

When the escrow delivers a deposit invoice token via `invoice_delivery` DM, the `SwapModule` verifies the invoice terms before transitioning to `announced`:

1. Parse the invoice token's terms via `accounting.getInvoice()`.
2. Verify:
   - `terms.targets.length === 1` (single-target deposit invoice)
   - `terms.targets[0].assets.length === 2` (two coin assets)
   - `terms.targets[0].assets[0].coin![0] === manifest.party_a_currency_to_change`
   - `terms.targets[0].assets[0].coin![1] === manifest.party_a_value_to_change`
   - `terms.targets[0].assets[1].coin![0] === manifest.party_b_currency_to_change`
   - `terms.targets[0].assets[1].coin![1] === manifest.party_b_value_to_change`
3. Verify `terms.targets[0].address` matches the resolved escrow DIRECT:// address. If not, reject the invoice -- deposits would go to the wrong address.
4. If any check fails: reject the invoice, transition to `'failed'` with error `'Deposit invoice terms do not match manifest'`. Emit `swap:failed`.

### 17.5 Downgrade Attack Prevention

A v2 swap MUST reject incoming `swap_acceptance` (v1-format) DMs. Only `swap_acceptance_v2` (version 2 with `acceptor_signature` and `acceptor_chain_pubkey`) is valid for a v2 proposal. A non-v2 acceptance on a v2 swap MUST be silently dropped WITHOUT clearing the proposal timer.

This prevents an attacker from:
1. Intercepting a v2 proposal
2. Sending a forged v1 acceptance (without a valid signature)
3. Disarming the proposal timeout and stranding the swap indefinitely

### 17.6 Swap Consent Signing (v2)

**Signing:**
```typescript
function signSwapManifest(privateKey: string, swapId: string, escrowAddress: string): string {
  const message = `swap_consent:${swapId}:${escrowAddress}`;
  return signMessage(privateKey, message);
  // Returns 130-char hex signature (v + r + s)
}
```

**Verification:**
```typescript
function verifySwapSignature(
  swapId: string, escrowAddress: string, signature: string, chainPubkey: string,
): boolean {
  const message = `swap_consent:${swapId}:${escrowAddress}`;
  return verifySignedMessage(message, signature, chainPubkey);
}
```

### 17.7 Nametag Binding (v2)

**Creation:**
```typescript
function createNametagBinding(
  privateKey: string, nametag: string, directAddress: string, swapId: string, chainPubkey: string,
): NametagBindingProof {
  const message = `nametag_bind:${nametag}:${directAddress}:${swapId}`;
  const signature = signMessage(privateKey, message);
  return { nametag, direct_address: directAddress, chain_pubkey: chainPubkey, signature };
}
```

**Verification:**
```typescript
function verifyNametagBinding(proof: NametagBindingProof, swapId: string): boolean {
  const message = `nametag_bind:${proof.nametag}:${proof.direct_address}:${swapId}`;
  return verifySignedMessage(message, proof.signature, proof.chain_pubkey);
}
```

---

## 18. Configuration

### 18.1 SwapModuleConfig Defaults

| Property | Type | Default | Description |
|---|---|---|---|
| `debug` | `boolean` | `false` | Enable debug logging |
| `defaultEscrowAddress` | `string` | `undefined` | Pre-configured escrow address |
| `proposalTimeoutMs` | `number` | `300000` (5 min) | Client-side proposal acceptance timeout |
| `maxPendingSwaps` | `number` | `100` | Maximum non-terminal swaps tracked |
| `announceTimeoutMs` | `number` | `30000` (30 sec) | Announce response timeout |
| `terminalPurgeTtlMs` | `number` | `604800000` (7 days) | TTL for terminal swap records before purge |

### 18.2 Network-Specific Escrow Addresses

The escrow address can be configured per-network in the provider factory functions:

```typescript
// Browser
const providers = createBrowserProviders({
  network: 'testnet',
  swap: { defaultEscrowAddress: '@escrow-testnet' },
});

// Node.js
const providers = createNodeProviders({
  network: 'testnet',
  swap: { defaultEscrowAddress: '@escrow-testnet' },
});
```

The SDK's `constants.ts` should include per-network escrow addresses once deployed:

```typescript
NETWORKS: {
  testnet: {
    // ... existing fields
    escrowAddress: '@escrow-testnet',
  },
  mainnet: {
    escrowAddress: '@escrow',
  },
}
```

---

## 19. Error Codes

All errors use `SphereError` with the following codes. All codes are registered in the `SphereErrorCode` union type in `core/errors.ts`.

| Code | When |
|---|---|
| `SWAP_INVALID_DEAL` | Invalid `SwapDeal` fields in `proposeSwap()`, or no escrow address configured |
| `SWAP_INVALID_MANIFEST` | Incoming proposal has invalid manifest fields |
| `SWAP_NOT_FOUND` | Unknown swap ID in any operation |
| `SWAP_WRONG_STATE` | Operation incompatible with current progress (e.g., deposit when not announced, cancel when concluding) |
| `SWAP_RESOLVE_FAILED` | `deps.resolve()` returned null for a party or escrow address |
| `SWAP_DM_SEND_FAILED` | `CommunicationsModule.sendDM()` threw during proposal/acceptance/announcement |
| `SWAP_ESCROW_REJECTED` | Escrow responded with `error` message to announce |
| `SWAP_DEPOSIT_FAILED` | `accounting.payInvoice()` threw during deposit |
| `SWAP_PAYOUT_VERIFICATION_FAILED` | Payout invoice terms do not match manifest expectations |
| `SWAP_ALREADY_EXISTS` | Duplicate incoming proposal (proposeSwap is idempotent -- returns existing) |
| `SWAP_ALREADY_COMPLETED` | `cancelSwap()` on a completed swap |
| `SWAP_ALREADY_CANCELLED` | `cancelSwap()` on a cancelled/failed swap |
| `SWAP_TIMEOUT` | Local or escrow timeout fired |
| `SWAP_LIMIT_EXCEEDED` | `proposeSwap()` or incoming proposal when at capacity |
| `SWAP_ALREADY_INITIALIZED` | `initialize()` called twice without `destroy()` |
| `SWAP_MODULE_DESTROYED` | Any public method called after `destroy()` |
| `SWAP_NOT_INITIALIZED` | Any public method called before `initialize()` or `load()` completes |

**Error propagation:** Errors during DM event processing (section 12) are caught internally and logged. They NEVER propagate to the calling code or interrupt the DM processing pipeline. Only explicit API calls (`proposeSwap`, `acceptSwap`, `deposit`, etc.) throw `SphereError` to the caller.

---

## 20. CLI Commands

This section specifies the CLI commands for the swap module. Each command follows the same patterns established by the accounting CLI commands (`invoice-create`, `invoice-list`, `invoice-pay`, etc.): arguments parsed via `args.indexOf('--flag')`, error messages with usage strings, `getSphere()` to obtain the wallet instance, module availability checks, JSON output for structured data, and `closeSphere()` at exit.

### 20.1 `swap-propose`

**Usage:**

```
swap-propose --to <recipient> --offer "<amount> <symbol>" --want "<amount> <symbol>"
             [--escrow <address>] [--timeout <seconds>] [--message <text>]
```

**Step-by-step specification:**

1. Parse all `--flag` arguments using `args.indexOf()`:
   ```typescript
   const toIdx = args.indexOf('--to');
   const offerIdx = args.indexOf('--offer');
   const wantIdx = args.indexOf('--want');
   const escrowIdx = args.indexOf('--escrow');
   const timeoutIdx = args.indexOf('--timeout');
   const messageIdx = args.indexOf('--message');
   ```

2. Parse `--offer` and `--want` values. Each is a quoted `"<amount> <symbol>"` string (e.g., `"1000000 UCT"`). Split on whitespace to extract amount and symbol.

   Validate required flags. If `--offer` or `--want` do not provide both amount and symbol, print usage and `process.exit(1)`:
   ```typescript
   if (toIdx === -1 || !args[toIdx + 1] || !offerAmount || !offerCoin || !wantAmount || !wantCoin) {
     console.error('Usage: swap-propose --to <recipient> --offer "<amount> <symbol>" --want "<amount> <symbol>" [--escrow <address>] [--timeout <seconds>] [--message <text>]');
     process.exit(1);
   }
   ```

3. Validate offer and want amounts are positive integers (regex: `/^[1-9][0-9]*$/`). If either fails:
   ```typescript
   console.error(`Invalid amount "${rawAmount}" -- must be a positive integer in smallest units (no decimals, no leading zeros)`);
   process.exit(1);
   ```

4. Validate `--timeout` if provided. Must be an integer in [60, 86400]. Default: `3600`.

5. Call `getSphere()` and check swap module availability.

6. Determine local wallet role. The local wallet is the proposer (partyA); the `--to` recipient is the acceptor (partyB).

7. Build `SwapDeal` and call `sphere.swap.proposeSwap(deal, options)`.

8. Print result as structured JSON.

9. Call `closeSphere()`.

### 20.2 `swap-list`

**Usage:**

```
swap-list [--all] [--role <proposer|acceptor>] [--progress <state>]
```

Default filter: exclude terminal states unless `--all` is set.

### 20.3 `swap-accept`

**Usage:**

```
swap-accept <swap_id> [--deposit] [--no-wait]
```

Accepts a swap, optionally deposits immediately, optionally waits for completion.

### 20.4 `swap-status`

**Usage:**

```
swap-status <swap_id> [--query-escrow]
```

Prints the full `SwapRef` as structured JSON. If a deposit invoice ID is present, also fetches and prints the invoice status.

### 20.5 `swap-deposit`

**Usage:**

```
swap-deposit <swap_id>
```

Manual deposit command for when `swap-accept` was called without `--deposit`.

### 20.6 `swap-reject`

**Usage:**

```
swap-reject <swap_id> [reason]
```

Reject a swap proposal. Sends a `swap_rejection` DM to the proposer and transitions to `cancelled`.

### 20.7 `swap-cancel`

**Usage:**

```
swap-cancel <swap_id>
```

Cancel a swap. If post-announcement, notifies the escrow to cancel and return deposits.

### 20.8 CLI Command Quick Reference

| Command | Description |
|---------|-------------|
| `swap-propose` | Propose a swap deal to a counterparty |
| `swap-list` | List swap deals (default: open + in-progress only) |
| `swap-accept <id>` | Accept a proposed swap deal |
| `swap-reject <id> [reason]` | Reject a swap proposal |
| `swap-status <id>` | Show detailed swap status |
| `swap-deposit <id>` | Deposit into an announced swap |
| `swap-cancel <id>` | Cancel a swap |

---

## 21. Future: Predicate-Based Direct Swaps

### 21.1 Vision

The current escrow-based design requires a trusted intermediary to hold deposits. A future version will use HTLC-like predicates to enable trustless atomic swaps directly between parties, without an escrow.

### 21.2 API Stability

The public API (`proposeSwap`, `acceptSwap`, `deposit`, `verifyPayout`, `cancelSwap`) is designed to remain stable across both execution mechanisms. The key abstraction is that `deposit()` sends tokens to "the swap" and `verifyPayout()` confirms receipt of counter-currency. Whether "the swap" is an escrow's invoice or a conditional predicate is an internal implementation detail.

### 21.3 Predicate Approach (Sketch)

Instead of depositing to an escrow invoice, each party would:

1. **Create a conditional transfer** with an HTLC-like predicate:
   - Party A creates a token transfer to party B, conditioned on B revealing a preimage `s` where `H(s) = h`.
   - Party B creates a token transfer to party A, conditioned on the same hash `h`.
2. **Exchange hash commitments** via DM.
3. **Party B reveals preimage** to claim A's tokens. The preimage publication allows A to claim B's tokens.
4. **Timeout refund** if the preimage is not revealed within the timeout window.

This requires upstream support in `@unicitylabs/state-transition-sdk` for conditional predicates. The `SwapManifest` and `SwapDeal` types would remain unchanged; only the internal deposit and payout logic would change.

### 21.4 Migration Path

When predicate-based swaps are available:
- A new config option (`executionMode: 'escrow' | 'direct'`) would select the mechanism.
- Default could be `'direct'` with fallback to `'escrow'` when predicates are unavailable.
- `SwapRef` would gain an `executionMode` field for per-swap tracking.
- Events remain identical -- `swap:deposit_sent`, `swap:completed`, etc.
- Error codes are extended but not replaced.
