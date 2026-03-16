# Swap Module Specification

> **Status:** Draft specification -- no code yet
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
20. [Future: Predicate-Based Direct Swaps](#20-future-predicate-based-direct-swaps)

---

## 1. Overview and Scope

### 1.1 Purpose

The `SwapModule` provides a high-level API for atomic two-party currency swaps within each party's Sphere wallet. It orchestrates the full swap lifecycle -- proposing a deal, negotiating acceptance, depositing into an escrow-managed invoice, and verifying payout -- while abstracting away the underlying DM protocol and invoice mechanics.

The module runs entirely in the wallet. It is a **client** of the escrow service, not a replacement for it. The escrow service holds deposited funds and executes the atomic swap; the `SwapModule` coordinates the wallet-side state machine, DM messaging between counterparties, and interaction with the `AccountingModule` for invoice import, payment, and verification.

### 1.2 Non-Goals

- **Escrow logic duplication.** The module does not validate deposits, compute coverage, manage timeouts authoritatively, or execute payouts. Those responsibilities belong to the escrow service.
- **Price discovery or order matching.** The module does not find counterparties or negotiate exchange rates. Deal terms arrive fully specified from the application layer.
- **Multi-party swaps.** The current design supports exactly two parties (A and B). Multi-leg swaps require a different protocol.
- **Cross-chain swaps.** Both sides of the swap use L3 tokens on the Unicity network. L1 (ALPHA) swaps are out of scope.

### 1.3 Relationship to AccountingModule

The `SwapModule` is a **consumer** of the `AccountingModule`, not an extension. It uses the following AccountingModule APIs:

- `importInvoice(token)` -- import deposit and payout invoice tokens delivered by the escrow
- `payInvoice(invoiceId, params)` -- send deposit payments referencing the escrow's deposit invoice
- `getInvoiceStatus(invoiceId)` -- verify deposit coverage and payout receipt
- Invoice events (`invoice:payment`, `invoice:covered`, `invoice:created`) -- track deposit progress and payout arrival

The `SwapModule` does not create invoices, close invoices, or manage auto-return. Those operations are performed by the escrow service on its own `AccountingModule` instance.

### 1.4 Relationship to Escrow Service

The `SwapModule` communicates with the escrow service exclusively via NIP-17 encrypted DMs through `CommunicationsModule`. The escrow service's DM protocol is defined in [`escrow-service/docs/protocol-spec.md`](../../escrow-service/docs/protocol-spec.md).

Messages sent to the escrow: `announce`, `status`, `request_invoice`.
Messages received from the escrow: `announce_result`, `invoice_delivery`, `status_result`, `payment_confirmation`, `swap_cancelled`, `bounce_notification`, `error`.

The `SwapModule` also exchanges peer-to-peer DMs with the counterparty wallet for proposal negotiation (`swap_proposal`, `swap_acceptance`, `swap_rejection`). These messages are NOT sent to the escrow.

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
 *   proposed → accepted → announced → depositing → awaiting_counter
 *     → concluding → completed
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
 */
const VALID_PROGRESS_TRANSITIONS: Record<SwapProgress, Set<SwapProgress>> = {
  proposed:         new Set(['accepted', 'cancelled', 'failed']),
  accepted:         new Set(['announced', 'cancelled', 'failed']),
  announced:        new Set(['depositing', 'cancelled', 'failed']),
  depositing:       new Set(['awaiting_counter', 'concluding', 'completed', 'cancelled', 'failed']),
  awaiting_counter: new Set(['concluding', 'completed', 'cancelled', 'failed']),
  concluding:       new Set(['completed', 'cancelled', 'failed']),
  completed:        new Set([]),  // terminal
  cancelled:        new Set([]),  // terminal
  failed:           new Set([]),  // terminal
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
   * Counterparty's chain pubkey (33-byte compressed secp256k1).
   * Resolved during proposal or acceptance. Used for DM addressing.
   */
  counterpartyPubkey?: string;
  /**
   * Transfer ID of the local deposit payment (from TransferResult.id).
   * Used to correlate invoice:payment events with the local deposit.
   */
  localDepositTransferId?: string;
  /**
   * Whether the payout invoice has been verified (correct terms, covered).
   * Set to true by verifyPayout() after successful verification.
   */
  payoutVerified: boolean;
  /** Timestamp when the swap record was created (ms) */
  readonly createdAt: number;
  /** Timestamp of most recent state change (ms) */
  updatedAt: number;
  /** Error message if progress is 'failed' */
  error?: string;
}
```

### 2.4 DM Message Types (Peer-to-Peer)

```typescript
// =============================================================================
// Peer-to-Peer DM Messages (wallet ↔ wallet)
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
  /** Protocol version (always 1 for forward compatibility) */
  readonly version: 1;
  /** The swap manifest (wire format, addresses already resolved) */
  readonly manifest: SwapManifest;
  /** Escrow service address (@nametag or DIRECT://) */
  readonly escrow: string;
  /** Optional human-readable description of the deal */
  readonly message?: string;
}

/**
 * Swap acceptance DM -- sent from acceptor to proposer.
 * Signals that the acceptor agrees to the deal terms and is ready
 * to proceed. The acceptor will announce the manifest to the escrow.
 *
 * Wire format: `swap_acceptance:` prefix + JSON.stringify(SwapAcceptanceMessage)
 */
interface SwapAcceptanceMessage {
  /** Discriminator */
  readonly type: 'swap_acceptance';
  /** Protocol version */
  readonly version: 1;
  /** Swap ID confirming which proposal is being accepted */
  readonly swap_id: string;
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
| `announce_result` | `swap_id`, `state`, `deposit_invoice_id`, `is_new` |
| `invoice_delivery` | `swap_id`, `invoice_type`, `invoice_id`, `invoice_token`, `payment_instructions` |
| `status_result` | `swap_id`, `state`, `deposit_status`, `payout_a_invoice_id`, `payout_b_invoice_id` |
| `payment_confirmation` | `swap_id`, `payout_invoice_id`, `currency`, `amount`, `status` |
| `swap_cancelled` | `swap_id`, `reason`, `deposits_returned` |
| `bounce_notification` | `swap_id`, `reason`, `returned_amount`, `returned_currency` |
| `error` | `error`, `details` |

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
 * Filter options for getSwaps().
 */
interface GetSwapsFilter {
  /** Filter by progress state(s) */
  readonly progress?: SwapProgress | SwapProgress[];
  /** Filter by role */
  readonly role?: SwapRole;
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
  | 'swap:failed';

// Event payloads — these extend SphereEventMap:

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
  debug?: boolean;
  /**
   * Pre-configured escrow address (@nametag or DIRECT://).
   * Used as the default when SwapDeal.escrowAddress is omitted.
   * At least one of this or SwapDeal.escrowAddress must be provided
   * for any swap operation.
   */
  defaultEscrowAddress?: string;
  /**
   * Time to wait for the counterparty to accept or reject a proposal (ms).
   * After this timeout, the proposal is marked as 'failed' locally.
   * Default: 300000 (5 minutes).
   *
   * This is a CLIENT-SIDE timeout only. The proposal DM remains
   * deliverable on Nostr indefinitely -- the counterparty could still
   * respond after this timeout. Late responses are ignored.
   */
  proposalTimeoutMs?: number;
  /**
   * Maximum number of non-terminal swaps tracked simultaneously.
   * Prevents unbounded memory growth from DM spam.
   * Default: 100.
   *
   * When the limit is reached, new proposals (both outgoing and incoming)
   * are rejected with SWAP_LIMIT_EXCEEDED.
   */
  maxPendingSwaps?: number;
}

/**
 * Dependencies injected into SwapModule.
 * Follows the same pattern as AccountingModuleDependencies.
 */
interface SwapModuleDependencies {
  /** AccountingModule instance (for invoice import, payment, status) */
  accounting: AccountingModule;
  /** CommunicationsModule instance (for DM send/receive) */
  communications: CommunicationsModule;
  /** Current wallet identity */
  identity: FullIdentity;
  /** General storage for persistent swap records */
  storage: StorageProvider;
  /** Event emitter (from Sphere) */
  emitEvent: <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => void;
  /**
   * Transport-level peer resolution.
   * Used to resolve @nametag and chain pubkey addresses to DIRECT:// and PeerInfo.
   */
  resolve: (identifier: string) => Promise<PeerInfo | null>;
  /** All tracked wallet addresses (for determining party role) */
  getActiveAddresses: () => TrackedAddress[];
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
 * @returns Object with { module, initialize } — call initialize() after construction
 */
function createSwapModule(config?: SwapModuleConfig): {
  module: SwapModule;
  initialize: (deps: SwapModuleDependencies) => void;
};
```

### 3.2 Constructor

```typescript
constructor(config: SwapModuleConfig)
```

The constructor stores configuration only. No I/O, no subscriptions, no storage access. The module is inert until `initialize()` is called.

Internal state initialized:
- `swaps: Map<string, SwapRef>` -- empty
- `swapGates: Map<string, Promise<void>>` -- per-swap mutex chains (empty)
- `localTimers: Map<string, ReturnType<typeof setTimeout>>` -- empty
- `destroyed: boolean` -- false
- `loaded: boolean` -- false

### 3.3 initialize(deps)

```typescript
initialize(deps: SwapModuleDependencies): void
```

Stores dependency references. Does NOT load data or subscribe to events. Called by `Sphere` immediately after factory construction, before `load()`.

### 3.4 load()

```typescript
async load(): Promise<void>
```

Called by `Sphere` after all modules are initialized. Steps:

1. **Load persisted swap records** from storage (key: `swap_records_{addressId}`). Deserialize `Map<string, SwapRef>` from JSON. If the key does not exist, start with an empty map.

2. **Clean up stale proposals.** For each swap with `progress === 'proposed'`:
   - If `role === 'proposer'` and `Date.now() - createdAt > config.proposalTimeoutMs`: transition to `'failed'` with error `'Proposal timed out'`.
   - If `role === 'acceptor'`: leave as-is (the user may not have seen it yet).

3. **Register DM handler.** Subscribe to `CommunicationsModule.onDirectMessage()` for incoming swap-related and escrow-related DMs. The handler dispatches by message type prefix:
   - `swap_proposal:` -- see [section 12.1](#121-swap_proposal-received)
   - `swap_acceptance:` -- see [section 12.2](#122-swap_acceptance-received)
   - `swap_rejection:` -- see [section 12.3](#123-swap_rejection-received)
   - JSON objects with `type` field (`announce_result`, `invoice_delivery`, `status_result`, `payment_confirmation`, `swap_cancelled`, `bounce_notification`, `error`) -- see [section 12.4](#124-escrow-dm-processing)

4. **Subscribe to invoice events.** For each swap with a `depositInvoiceId` or `payoutInvoiceId`, subscribe to relevant `AccountingModule` events. See [section 13](#13-invoice-event-subscriptions).

5. **Start local timers.** For each swap in `'announced'`, `'depositing'`, or `'awaiting_counter'` progress, start a local timeout timer. See [section 16](#16-local-timeout-management).

6. **Set `loaded = true`.**

### 3.5 destroy()

```typescript
async destroy(): Promise<void>
```

Cleanup sequence:

1. **Set `destroyed = true`** immediately. All public methods check this flag and throw `SWAP_MODULE_DESTROYED` if set.

2. **Unsubscribe** from `CommunicationsModule.onDirectMessage()` and all `AccountingModule` event subscriptions.

3. **Clear all local timers** (`localTimers.forEach(clearTimeout)`).

4. **Await in-flight gate operations.** For each entry in `swapGates`, await the current promise chain tail. This drains any queued mutations.

5. **Persist dirty state.** Write the current `swaps` map to storage. This is a final-flush -- individual state transitions also persist (persist-before-act), so this is a safety net for any in-flight changes captured in step 4.

---

## 4. proposeSwap

```typescript
async proposeSwap(deal: SwapDeal): Promise<SwapProposalResult>
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
   - Resolve via `deps.resolve(escrowAddress)` to obtain the escrow's DIRECT:// address.
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

7. **Build SwapManifest.**
   ```typescript
   const manifestFields: ManifestFields = {
     party_a_address: resolvedPartyA,
     party_b_address: resolvedPartyB,
     party_a_currency_to_change: deal.partyACurrency,
     party_a_value_to_change: deal.partyAAmount,
     party_b_currency_to_change: deal.partyBCurrency,
     party_b_value_to_change: deal.partyBAmount,
     timeout: deal.timeout,
   };
   const swapId = computeSwapId(manifestFields);
   const manifest: SwapManifest = { swap_id: swapId, ...manifestFields };
   ```

8. **Check for duplicate.**
   - If `this.swaps.has(swapId)`, throw `SWAP_ALREADY_EXISTS` with message `'Swap with this ID already exists'`.

9. **Create SwapRef.**
   ```typescript
   const swap: SwapRef = {
     swapId,
     deal,
     manifest,
     role,
     progress: 'proposed',
     counterpartyPubkey: counterpartyPeerInfo.chainPubkey,
     payoutVerified: false,
     createdAt: Date.now(),
     updatedAt: Date.now(),
   };
   ```

10. **Persist** (persist-before-act): write `SwapRef` to the `swaps` map and persist to storage.

11. **Send proposal DM** to the counterparty.
    ```typescript
    const proposalMsg: SwapProposalMessage = {
      type: 'swap_proposal',
      version: 1,
      manifest,
      escrow: escrowAddress,
      message: undefined, // deal has no message field in this version
    };
    const dmContent = `swap_proposal:${JSON.stringify(proposalMsg)}`;
    await deps.communications.sendDM(counterpartyPubkey, dmContent);
    ```
    - If the DM send fails, transition to `'failed'`, persist, and throw `SWAP_DM_SEND_FAILED`.

12. **Start proposal timeout timer.**
    ```typescript
    const timer = setTimeout(() => {
      this.withSwapGate(swapId, async () => {
        const s = this.swaps.get(swapId);
        if (s && s.progress === 'proposed') {
          s.progress = 'failed';
          s.error = 'Proposal timed out — no response from counterparty';
          s.updatedAt = Date.now();
          await this.persist();
          deps.emitEvent('swap:failed', { swapId, error: s.error });
        }
      });
    }, config.proposalTimeoutMs ?? 300000);
    this.localTimers.set(`proposal:${swapId}`, timer);
    ```

13. **Emit event.**
    ```typescript
    deps.emitEvent('swap:proposed', {
      swapId,
      deal,
      recipientPubkey: counterpartyPubkey,
    });
    ```

14. **Return result.**
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

3. **Enter per-swap gate** (`withSwapGate(swapId, ...)`). All remaining steps execute inside the gate.

4. **Send acceptance DM** to the proposer.
   ```typescript
   const acceptMsg: SwapAcceptanceMessage = {
     type: 'swap_acceptance',
     version: 1,
     swap_id: swapId,
   };
   await deps.communications.sendDM(swap.counterpartyPubkey!, `swap_acceptance:${JSON.stringify(acceptMsg)}`);
   ```
   - On failure: throw `SWAP_DM_SEND_FAILED`. Do NOT change progress (the user can retry).

5. **Transition to 'accepted'.** Update `swap.progress = 'accepted'`, `swap.updatedAt = Date.now()`. Persist.

6. **Emit `swap:accepted`** event.

7. **Announce manifest to escrow.**
   - Resolve the escrow's transport pubkey from the stored `deal.escrowAddress` (or `config.defaultEscrowAddress`).
   - Send `announce` DM to escrow:
     ```typescript
     const announceMsg = { type: 'announce', manifest: swap.manifest };
     await deps.communications.sendDM(escrowPubkey, JSON.stringify(announceMsg));
     ```
   - On failure: transition to `'failed'` with error `'Failed to send announce to escrow'`. Persist. Emit `swap:failed`. Return.

8. **Wait for `announce_result` DM** from the escrow.
   - This is handled asynchronously by the DM handler (section 12.4). The `acceptSwap()` method does NOT block waiting for the result. The DM handler will:
     - Parse the `announce_result` and update `swap.depositInvoiceId` and `swap.progress = 'announced'`.
     - Import the deposit invoice token via `deps.accounting.importInvoice()`.
     - Emit `swap:announced`.
   - If the escrow responds with an `error` DM instead, the DM handler transitions to `'failed'`.

> **Design note:** The `acceptSwap()` method returns after sending the announce DM. The remaining steps (invoice import, state transition to 'announced') happen asynchronously when the escrow responds. This keeps the API non-blocking and consistent with the event-driven DM model.

---

## 6. rejectSwap

```typescript
async rejectSwap(swapId: string, reason?: string): Promise<void>
```

### 6.1 Step-by-Step

1. **Guard checks.** Same as acceptSwap (destroyed, loaded).

2. **Look up SwapRef.**
   - Must exist, `progress === 'proposed'`, `role === 'acceptor'`.
   - Throw `SWAP_NOT_FOUND` or `SWAP_WRONG_STATE` as appropriate.

3. **Enter per-swap gate.**

4. **Send rejection DM** to the proposer.
   ```typescript
   const rejectMsg: SwapRejectionMessage = {
     type: 'swap_rejection',
     version: 1,
     swap_id: swapId,
     reason,
   };
   await deps.communications.sendDM(swap.counterpartyPubkey!, `swap_rejection:${JSON.stringify(rejectMsg)}`);
   ```
   - On failure: log warning but continue. The rejection is a courtesy notification; the local state change is authoritative.

5. **Transition to 'cancelled'** (not 'failed' -- rejection is a deliberate user action, not an error).
   ```typescript
   swap.progress = 'cancelled';
   swap.updatedAt = Date.now();
   ```
   Persist.

6. **Emit `swap:rejected`** event.
   ```typescript
   deps.emitEvent('swap:rejected', { swapId, reason });
   ```

7. **Remove the swap from the `swaps` map** (optional -- rejected proposals can be pruned to save storage). Alternatively, retain for history and prune on next `load()` after a configurable retention period.

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

3. **Enter per-swap gate.**

4. **Determine asset index.**
   - The deposit invoice has a single target (the escrow's address) with two assets:
     - Asset index 0 = `party_a_currency_to_change` (party A's deposit)
     - Asset index 1 = `party_b_currency_to_change` (party B's deposit)
   - Determine which party we are from `swap.manifest`:
     - Compare our DIRECT:// address against `swap.manifest.party_a_address` and `swap.manifest.party_b_address`.
     - If we are party A: `assetIndex = 0`.
     - If we are party B: `assetIndex = 1`.

5. **Call `accounting.payInvoice()`.**
   ```typescript
   const transferResult = await deps.accounting.payInvoice(swap.depositInvoiceId!, {
     targetIndex: 0,      // single-target deposit invoice
     assetIndex,           // 0 for party A, 1 for party B
     // amount is omitted — SDK computes remaining needed amount
   });
   ```
   - On failure: throw `SWAP_DEPOSIT_FAILED` wrapping the underlying error. Do NOT change progress (the user can retry after resolving the issue, e.g., insufficient balance).

6. **Update state.**
   ```typescript
   swap.progress = 'depositing';
   swap.localDepositTransferId = transferResult.id;
   swap.updatedAt = Date.now();
   ```
   Persist.

7. **Emit `swap:deposit_sent`.**
   ```typescript
   deps.emitEvent('swap:deposit_sent', { swapId, transferResult });
   ```

8. **Return `transferResult`.**

> **Note:** The transition from `'depositing'` to `'awaiting_counter'` happens asynchronously when the `invoice:payment` event confirms our deposit. See [section 13.1](#131-invoicepayment-on-deposit-invoice).

---

## 8. getSwapStatus

```typescript
async getSwapStatus(swapId: string): Promise<SwapRef>
```

### 8.1 Step-by-Step

1. **Guard checks.** (destroyed, loaded).

2. **Look up SwapRef.**
   - If not found, throw `SWAP_NOT_FOUND`.

3. **Optionally refresh from escrow.**
   - If the swap is in a non-terminal state AND has an escrow address, send a `status` DM to the escrow:
     ```typescript
     await deps.communications.sendDM(escrowPubkey, JSON.stringify({
       type: 'status',
       swap_id: swapId,
     }));
     ```
   - The `status_result` response is handled asynchronously by the DM handler. The method does NOT block for the response.
   - The local `SwapRef` is updated when the `status_result` arrives (see [section 12.4](#124-escrow-dm-processing)).

4. **Return a copy** of the current `SwapRef`.
   ```typescript
   return { ...swap };
   ```

> **Design note:** `getSwapStatus()` is async to support the optional escrow query, but it returns immediately with the current local state. Applications that need the freshest escrow state should call `getSwapStatus()` and then listen for `swap:*` events triggered by the escrow's response.

---

## 9. getSwaps

```typescript
getSwaps(filter?: GetSwapsFilter): SwapRef[]
```

### 9.1 Behavior

- **Synchronous.** Reads from the in-memory `swaps` map. No I/O.
- Returns copies of `SwapRef` objects (not references to internal state).
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

  if (filter?.role) {
    results = results.filter(s => s.role === filter.role);
  }

  results.sort((a, b) => b.updatedAt - a.updatedAt);
  return results.map(s => ({ ...s }));
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

3. **Get invoice status.**
   ```typescript
   const status = await deps.accounting.getInvoiceStatus(swap.payoutInvoiceId!);
   ```

4. **Verify invoice terms match expectations.**
   - Get the invoice ref to access terms:
     ```typescript
     const invoiceRef = deps.accounting.getInvoice(swap.payoutInvoiceId!);
     if (!invoiceRef) throw new SphereError('Payout invoice not found', 'SWAP_PAYOUT_VERIFICATION_FAILED');
     ```
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

5. **Verify coverage.**
   - `status.state` must be `'COVERED'` or `'CLOSED'`.
   - `status.targets[0].coinAssets[0].isCovered` must be `true`.
   - `BigInt(status.targets[0].coinAssets[0].netCoveredAmount) >= BigInt(expectedAmount)`.
   - If not covered: return `false` without error (the payout may still be in progress).

6. **Update state on success.**
   ```typescript
   swap.payoutVerified = true;
   swap.progress = 'completed';
   swap.updatedAt = Date.now();
   ```
   Persist.

7. **Emit `swap:completed`.**
   ```typescript
   deps.emitEvent('swap:completed', { swapId, payoutVerified: true });
   ```

8. **Return `true`.**

---

## 11. cancelSwap

```typescript
async cancelSwap(swapId: string): Promise<void>
```

### 11.1 Step-by-Step

1. **Guard checks.** (destroyed, loaded).

2. **Look up SwapRef.**
   - Must exist.
   - If `swap.progress` is already terminal (`completed`, `cancelled`, `failed`):
     - If `cancelled`: throw `SWAP_ALREADY_CANCELLED`.
     - If `completed`: throw `SWAP_ALREADY_COMPLETED`.
     - If `failed`: throw `SWAP_ALREADY_CANCELLED` (treat failed as implicitly cancelled).

3. **Enter per-swap gate.**

4. **Determine cancellation scope.**

   **Pre-announcement** (`progress` is `'proposed'`, `'accepted'`):
   - Mark as cancelled locally. No escrow interaction needed.
   ```typescript
   swap.progress = 'cancelled';
   swap.updatedAt = Date.now();
   ```
   - If `role === 'proposer'` and `progress === 'proposed'`: the proposal may still be pending with the counterparty. Optionally send a `swap_rejection` DM to inform them (best-effort, failure is non-blocking).

   **Post-announcement** (`progress` is `'announced'`, `'depositing'`, `'awaiting_counter'`, `'concluding'`):
   - The escrow does not support explicit cancellation by parties. The only escrow-side cancellation mechanism is timeout.
   - Mark as cancelled locally. This is a **unilateral local decision** -- the escrow still considers the swap active until timeout.
   - If deposits were made, they will be returned by the escrow when the timeout fires (assuming the counterparty did not also deposit and trigger completion).
   - Log a warning: `'Swap cancelled locally but escrow may still be active. Deposits will be returned on escrow timeout.'`.

5. **Persist.**

6. **Clear local timers** associated with this swap.

7. **Emit `swap:cancelled`.**
   ```typescript
   deps.emitEvent('swap:cancelled', {
     swapId,
     reason: 'explicit',
     depositsReturned: undefined, // unknown for local cancellation
   });
   ```

> **Future extension:** When the escrow protocol supports explicit cancellation by parties, this method should send a `cancel` DM to the escrow before marking as locally cancelled. The current implementation is limited to local-only cancellation.

---

## 12. Incoming DM Processing

### 12.1 swap_proposal Received

Triggered when a DM arrives with the `swap_proposal:` prefix.

1. **Parse message.**
   - Extract JSON after `swap_proposal:` prefix.
   - Parse as `SwapProposalMessage`.
   - On parse failure: silently ignore (treat as regular DM).

2. **Validate version.**
   - If `version > 1`: silently ignore (forward compatibility).
   - If `version < 1` or not a number: silently ignore.

3. **Validate manifest** (see [section 17.2](#172-manifest-validation)).
   - Verify `swap_id` matches `SHA-256(JCS(manifestFields))`.
   - Validate all manifest fields.
   - On validation failure: silently ignore (do not send error DM -- the sender may be malicious).

4. **Check pending swap limit.** If exceeded, silently ignore.

5. **Check for duplicate.** If `swaps.has(swap_id)`, silently ignore.

6. **Determine role.**
   - Compare manifest party addresses against our tracked addresses.
   - If `manifest.party_a_address` matches: we are party A. Counterparty is B. `role = 'acceptor'`.
   - If `manifest.party_b_address` matches: we are party B. Counterparty is A. `role = 'acceptor'`.
   - If neither matches: silently ignore (proposal is not for us).

7. **Reconstruct SwapDeal** from the manifest and escrow address in the proposal message.
   ```typescript
   const deal: SwapDeal = {
     partyA: manifest.party_a_address,
     partyB: manifest.party_b_address,
     partyACurrency: manifest.party_a_currency_to_change,
     partyAAmount: manifest.party_a_value_to_change,
     partyBCurrency: manifest.party_b_currency_to_change,
     partyBAmount: manifest.party_b_value_to_change,
     timeout: manifest.timeout,
     escrowAddress: proposalMsg.escrow,
   };
   ```

8. **Create SwapRef.**
   ```typescript
   const swap: SwapRef = {
     swapId: manifest.swap_id,
     deal,
     manifest,
     role: 'acceptor',
     progress: 'proposed',
     counterpartyPubkey: dm.senderPubkey,
     payoutVerified: false,
     createdAt: Date.now(),
     updatedAt: Date.now(),
   };
   ```

9. **Persist.**

10. **Emit `swap:proposal_received`.**
    ```typescript
    deps.emitEvent('swap:proposal_received', {
      swapId: manifest.swap_id,
      deal,
      senderPubkey: dm.senderPubkey,
      senderNametag: dm.senderNametag,
    });
    ```

### 12.2 swap_acceptance Received

Triggered when a DM arrives with the `swap_acceptance:` prefix.

1. **Parse and validate** (same pattern as 12.1).

2. **Look up SwapRef** by `swap_id`.
   - Must exist, `progress === 'proposed'`, `role === 'proposer'`.
   - If any check fails: silently ignore.

3. **Verify sender** is the expected counterparty (`dm.senderPubkey === swap.counterpartyPubkey`). If not, silently ignore.

4. **Enter per-swap gate.**

5. **Cancel proposal timeout timer** (`localTimers.delete(`proposal:${swapId}`)`).

6. **Transition to 'accepted'.** Persist.

7. **Emit `swap:accepted`.**

8. **Announce to escrow** (same flow as step 7 in acceptSwap -- resolve escrow, send announce DM).
   - The announce_result handling is asynchronous (section 12.4).

### 12.3 swap_rejection Received

Triggered when a DM arrives with the `swap_rejection:` prefix.

1. **Parse and validate.**

2. **Look up SwapRef** by `swap_id`.
   - Must exist, `progress === 'proposed'`, `role === 'proposer'`.

3. **Verify sender** is the counterparty.

4. **Enter per-swap gate.**

5. **Cancel proposal timeout timer.**

6. **Transition to 'cancelled'.** Store `reason` from the rejection message. Persist.

7. **Emit `swap:rejected`.**
   ```typescript
   deps.emitEvent('swap:rejected', {
     swapId,
     reason: rejectionMsg.reason,
   });
   ```
   Also emit `swap:cancelled`:
   ```typescript
   deps.emitEvent('swap:cancelled', {
     swapId,
     reason: 'rejected',
   });
   ```

### 12.4 Escrow DM Processing

DMs from the escrow are JSON objects. The handler attempts `JSON.parse()` on the DM content. If parsing succeeds and the result has a `type` field matching a known escrow message type, it is dispatched here. If parsing fails or the type is unrecognized, the DM is ignored (it may be a regular conversation message or a peer-to-peer swap message handled by 12.1--12.3).

**Sender verification:** Before processing any escrow DM, verify that `dm.senderPubkey` matches the escrow's resolved transport pubkey for the associated swap. If not, silently ignore. This prevents a malicious party from spoofing escrow responses.

#### 12.4.1 announce_result

1. Find swap by `swap_id` in the message.
2. Must be in `'accepted'` progress (we just announced). If not, log and ignore.
3. Store `depositInvoiceId = msg.deposit_invoice_id`.
4. Store `escrowState = msg.state`.

#### 12.4.2 invoice_delivery (deposit)

1. Find swap by `swap_id`.
2. `msg.invoice_type` must be `'deposit'`.
3. Import the invoice token:
   ```typescript
   await deps.accounting.importInvoice(msg.invoice_token);
   ```
   - On failure: log error, transition to `'failed'`. Return.
4. Transition to `'announced'`. Persist.
5. Start local timeout timer (see [section 16](#16-local-timeout-management)).
6. Emit `swap:announced` with `depositInvoiceId`.

#### 12.4.3 invoice_delivery (payout)

1. Find swap by `swap_id`.
2. `msg.invoice_type` must be `'payout'`.
3. Import the payout invoice token:
   ```typescript
   await deps.accounting.importInvoice(msg.invoice_token);
   ```
4. Store `payoutInvoiceId = msg.invoice_id`.
5. Persist.
6. Emit `swap:payout_received` with `payoutInvoiceId`.
7. Attempt automatic verification via `verifyPayout(swapId)`. If verification succeeds, the swap transitions to `'completed'` and emits `swap:completed`. If verification returns `false` (payout not yet covered), leave state as-is -- the `invoice:payment` subscription will trigger re-verification when coverage arrives.

#### 12.4.4 status_result

1. Find swap by `swap_id`.
2. Update `swap.escrowState = msg.state`.
3. Update deposit status if available:
   - If `msg.deposit_status.party_a_covered` or `msg.deposit_status.party_b_covered` changed, emit `swap:deposit_confirmed` for the newly-covered party.
4. Persist.
5. If `msg.state` is a terminal escrow state (`'COMPLETED'`, `'CANCELLED'`, `'FAILED'`) and our local progress is non-terminal, transition accordingly.

#### 12.4.5 payment_confirmation

1. Find swap by `swap_id`.
2. Transition to `'concluding'` (if not already). Persist.
3. Emit `swap:concluding`.

#### 12.4.6 swap_cancelled

1. Find swap by `swap_id`.
2. If already terminal locally, ignore.
3. Transition to `'cancelled'`.
4. Clear local timers.
5. Persist.
6. Emit `swap:cancelled`:
   ```typescript
   deps.emitEvent('swap:cancelled', {
     swapId,
     reason: msg.reason === 'timeout' ? 'timeout' : 'escrow_failed',
     depositsReturned: msg.deposits_returned,
   });
   ```

#### 12.4.7 bounce_notification

1. Find swap by `swap_id`.
2. Log a warning with the bounce reason:
   ```
   Swap {swapId}: deposit bounced by escrow — reason: {msg.reason}
   ```
3. If `msg.reason === 'WRONG_CURRENCY'`: this indicates a bug in the deposit logic (sent the wrong coinId). Log error.
4. If `msg.reason === 'ALREADY_COVERED'`: our deposit arrived after coverage. The escrow will return the tokens. No state change needed.
5. If `msg.reason === 'SWAP_NOT_FOUND'` or `'SWAP_CLOSED'`: the escrow does not recognize this swap. Transition to `'failed'` with error. Persist. Emit `swap:failed`.

#### 12.4.8 error

1. Find swap by `swap_id` (if the error includes one).
2. Log the error: `Escrow error for swap {swapId}: {msg.error}`.
3. If the error is in response to an `announce` (swap in `'accepted'` state): transition to `'failed'` with the escrow's error message. Persist. Emit `swap:failed`.
4. For other states: log only, do not change state. The error may be transient.

---

## 13. Invoice Event Subscriptions

The `SwapModule` subscribes to `AccountingModule` events to track deposit and payout progress. Subscriptions are established during `load()` for existing swaps and dynamically when new deposit/payout invoices are imported.

### 13.1 invoice:payment on Deposit Invoice

When an `invoice:payment` event fires for a deposit invoice associated with a swap:

1. **Identify the swap** by looking up which `SwapRef` has `depositInvoiceId === event.invoiceId`.

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

**Storage key:** `swap_records_{addressId}`

Where `addressId` is the `TrackedAddress.addressId` of the currently active wallet address (e.g., `DIRECT_abc123_xyz789`).

### 14.2 Data Format

```typescript
/**
 * Persistent storage format for swap records.
 * Stored as a JSON-serialized object keyed by swapId.
 */
interface SwapStorageData {
  /** Version for forward-compatible schema evolution */
  readonly version: 1;
  /** Map of swapId -> SwapRef */
  readonly swaps: Record<string, SwapRef>;
}
```

### 14.3 Persist-Before-Act Pattern

Every state transition is persisted to storage BEFORE any external action (DM send, invoice operation). This ensures that a crash between persist and action results in a recoverable state -- the worst case is a redundant DM or a redundant invoice operation, both of which are idempotent.

```typescript
// Pattern used in every state transition:
async function transitionProgress(
  swap: SwapRef,
  newProgress: SwapProgress,
  updates?: Partial<SwapRef>,
): Promise<void> {
  // 1. Validate transition
  if (!VALID_PROGRESS_TRANSITIONS[swap.progress].has(newProgress)) {
    throw new Error(`Invalid progress transition: ${swap.progress} → ${newProgress}`);
  }
  // 2. Update in memory
  swap.progress = newProgress;
  swap.updatedAt = Date.now();
  if (updates) Object.assign(swap, updates);
  // 3. Persist to storage
  await this.persist();
  // 4. External action happens AFTER persist returns
}
```

### 14.4 Load and Migration

On `load()`:
1. Read `swap_records_{addressId}` from storage.
2. Parse JSON. If missing or corrupt, start with empty map.
3. Validate `version` field. If `version > 1`, log warning and attempt best-effort parsing (ignore unknown fields).
4. Populate `this.swaps` from the parsed records.

---

## 15. Per-Swap Async Mutex

### 15.1 withSwapGate(swapId, fn)

```typescript
private async withSwapGate<T>(swapId: string, fn: () => Promise<T>): Promise<T> {
  if (this.destroyed) {
    throw new SphereError('SwapModule is destroyed', 'SWAP_MODULE_DESTROYED');
  }

  const prev = this.swapGates.get(swapId) ?? Promise.resolve();
  let resolve: () => void;
  const next = new Promise<void>(r => { resolve = r; });
  this.swapGates.set(swapId, next);

  await prev;

  try {
    if (this.destroyed) return undefined as T; // gate drained during destroy
    return await fn();
  } finally {
    resolve!();
    // Clean up if this was the last entry
    if (this.swapGates.get(swapId) === next) {
      this.swapGates.delete(swapId);
    }
  }
}
```

### 15.2 Guarantees

- **Serialization:** Only one mutation runs at a time for a given swap ID.
- **No global lock:** Different swaps run concurrently.
- **Drain on destroy:** `destroy()` awaits all gate tails before returning.
- **Starvation prevention:** Each gate entry is a promise chain, not a blocking lock. JavaScript's event loop ensures FIFO ordering.

### 15.3 Which Operations Use the Gate

All state-mutating operations enter the gate:
- `acceptSwap()` (steps 4 onward)
- `rejectSwap()` (steps 4 onward)
- `deposit()` (steps 4 onward)
- `cancelSwap()` (steps 4 onward)
- All DM handlers in section 12 that modify `SwapRef`
- All invoice event handlers in section 13 that modify `SwapRef`
- Proposal timeout callback (section 4.1 step 12)
- Local timeout callback (section 16)

Read-only operations (`getSwaps()`, `getSwapStatus()`, `verifyPayout()`) do NOT enter the gate. However, `verifyPayout()` calls `getInvoiceStatus()` which may trigger implicit close on the accounting side -- this is acceptable because the swap module does not own the invoice lifecycle.

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
    if (!s || TERMINAL_PROGRESS.has(s.progress)) return; // already resolved
    s.progress = 'cancelled';
    s.error = 'Local timeout — escrow did not respond within the expected window';
    s.updatedAt = Date.now();
    await this.persist();
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
- `deposit:covered` fires (the escrow is proceeding with payouts -- timeout no longer relevant).
- `destroy()` clears all timers.

**Resume on load:** During `load()`, for non-terminal swaps that were `'announced'` or later, compute the remaining time:
```typescript
const elapsed = Date.now() - swap.createdAt;
const totalTimeout = swap.manifest.timeout * 1000 + 30_000;
const remaining = totalTimeout - elapsed;
if (remaining <= 0) {
  // Already expired -- cancel immediately
  swap.progress = 'cancelled';
  swap.error = 'Swap timed out during offline period';
  swap.updatedAt = Date.now();
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
| `partyACurrency` | Non-empty string, alphanumeric, 1-68 chars (`/^[A-Za-z0-9]{1,68}$/`) | `SWAP_INVALID_DEAL: partyACurrency must be 1-68 alphanumeric characters` |
| `partyBCurrency` | Same rule as partyACurrency | `SWAP_INVALID_DEAL: partyBCurrency must be 1-68 alphanumeric characters` |
| `partyACurrency` vs `partyBCurrency` | Must differ (case-sensitive) | `SWAP_INVALID_DEAL: currencies must differ` |
| `partyAAmount` | Positive integer string: `/^[1-9][0-9]*$/`, max 78 chars | `SWAP_INVALID_DEAL: partyAAmount must be a positive integer string` |
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
| `party_a_currency_to_change` | 1-68 alphanumeric chars | Silent reject |
| `party_b_currency_to_change` | 1-68 alphanumeric chars, differs from `party_a_currency_to_change` | Silent reject |
| `party_a_value_to_change` | Positive integer string (`/^[1-9][0-9]*$/`) | Silent reject |
| `party_b_value_to_change` | Same rule | Silent reject |
| `timeout` | Integer in [60, 86400] | Silent reject |
| `swap_id` integrity | Must equal `SHA-256(JCS(manifestFields))` where `manifestFields` contains all fields except `swap_id` | Silent reject |

### 17.3 Swap ID Computation

```typescript
import canonicalize from 'canonicalize';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

interface ManifestFields {
  party_a_address: string;
  party_b_address: string;
  party_a_currency_to_change: string;
  party_a_value_to_change: string;
  party_b_currency_to_change: string;
  party_b_value_to_change: string;
  timeout: number;
}

function computeSwapId(fields: ManifestFields): string {
  const canonical = canonicalize(fields);
  if (!canonical) {
    throw new Error('Failed to canonicalize manifest fields');
  }
  const hash = sha256(new TextEncoder().encode(canonical));
  return bytesToHex(hash);
}
```

> **Note:** The SDK uses `@noble/hashes` (browser-compatible). The escrow service uses Node.js `crypto.createHash`. Both produce the same SHA-256 output. The canonicalization library (`canonicalize`) implements RFC 8785 (JSON Canonicalization Scheme) and is deterministic across implementations.

### 17.4 Deposit Invoice Verification

When the escrow delivers a deposit invoice token via `invoice_delivery` DM, the `SwapModule` verifies the invoice terms before importing:

1. Parse the invoice token's terms.
2. Verify:
   - `terms.targets.length === 1` (single-target deposit invoice)
   - `terms.targets[0].assets.length === 2` (two coin assets)
   - `terms.targets[0].assets[0].coin![0] === manifest.party_a_currency_to_change`
   - `terms.targets[0].assets[0].coin![1] === manifest.party_a_value_to_change`
   - `terms.targets[0].assets[1].coin![0] === manifest.party_b_currency_to_change`
   - `terms.targets[0].assets[1].coin![1] === manifest.party_b_value_to_change`
3. If any check fails: reject the invoice, transition to `'failed'` with error `'Deposit invoice terms do not match manifest'`. Emit `swap:failed`.

---

## 18. Configuration

### 18.1 SwapModuleConfig Defaults

| Property | Type | Default | Description |
|---|---|---|---|
| `debug` | `boolean` | `false` | Enable debug logging |
| `defaultEscrowAddress` | `string` | `undefined` | Pre-configured escrow address |
| `proposalTimeoutMs` | `number` | `300000` (5 min) | Client-side proposal acceptance timeout |
| `maxPendingSwaps` | `number` | `100` | Maximum non-terminal swaps tracked |

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

All errors use `SphereError` with the following codes. All codes must be added to the `SphereErrorCode` union type in `core/errors.ts`.

| Code | Message | When |
|---|---|---|
| `SWAP_INVALID_DEAL` | Deal validation failed: {details} | Invalid `SwapDeal` fields in `proposeSwap()` |
| `SWAP_INVALID_MANIFEST` | Manifest validation failed | Incoming proposal has invalid manifest fields |
| `SWAP_NOT_FOUND` | Swap not found: {swapId} | Unknown swap ID in any operation |
| `SWAP_WRONG_STATE` | Cannot {operation}: swap is in {progress} state | Operation incompatible with current progress |
| `SWAP_RESOLVE_FAILED` | Cannot resolve address: {address} | `deps.resolve()` returned null for a party or escrow address |
| `SWAP_DM_SEND_FAILED` | Failed to send DM: {details} | `CommunicationsModule.sendDM()` threw |
| `SWAP_ESCROW_REJECTED` | Escrow rejected manifest: {error} | Escrow responded with `error` message to announce |
| `SWAP_DEPOSIT_FAILED` | Deposit payment failed: {details} | `accounting.payInvoice()` threw during deposit |
| `SWAP_PAYOUT_VERIFICATION_FAILED` | Payout verification failed: {details} | Payout invoice terms do not match manifest expectations |
| `SWAP_ALREADY_EXISTS` | Swap with this ID already exists | Duplicate `proposeSwap()` or duplicate incoming proposal |
| `SWAP_ALREADY_COMPLETED` | Swap is already completed | `cancelSwap()` on a completed swap |
| `SWAP_ALREADY_CANCELLED` | Swap is already cancelled | `cancelSwap()` on a cancelled/failed swap |
| `SWAP_TIMEOUT` | Swap timed out | Local or escrow timeout fired |
| `SWAP_LIMIT_EXCEEDED` | Maximum pending swaps ({limit}) exceeded | `proposeSwap()` or incoming proposal when at capacity |
| `SWAP_MODULE_DESTROYED` | SwapModule is destroyed | Any public method called after `destroy()` |
| `SWAP_NOT_INITIALIZED` | SwapModule is not initialized | Any public method called before `load()` completes |

**Error propagation:** Errors during DM event processing (section 12) are caught internally and logged. They NEVER propagate to the calling code or interrupt the DM processing pipeline. Only explicit API calls (`proposeSwap`, `acceptSwap`, `deposit`, etc.) throw `SphereError` to the caller.

---

## 20. Future: Predicate-Based Direct Swaps

### 20.1 Vision

The current escrow-based design requires a trusted intermediary to hold deposits. A future version will use HTLC-like predicates to enable trustless atomic swaps directly between parties, without an escrow.

### 20.2 API Stability

The public API (`proposeSwap`, `acceptSwap`, `deposit`, `verifyPayout`, `cancelSwap`) is designed to remain stable across both execution mechanisms. The key abstraction is that `deposit()` sends tokens to "the swap" and `verifyPayout()` confirms receipt of counter-currency. Whether "the swap" is an escrow's invoice or a conditional predicate is an internal implementation detail.

### 20.3 Predicate Approach (Sketch)

Instead of depositing to an escrow invoice, each party would:

1. **Create a conditional transfer** with an HTLC-like predicate:
   - Party A creates a token transfer to party B, conditioned on B revealing a preimage `s` where `H(s) = h`.
   - Party B creates a token transfer to party A, conditioned on the same hash `h`.
2. **Exchange hash commitments** via DM.
3. **Party B reveals preimage** to claim A's tokens. The preimage publication allows A to claim B's tokens.
4. **Timeout refund** if the preimage is not revealed within the timeout window.

This requires upstream support in `@unicitylabs/state-transition-sdk` for conditional predicates. The `SwapManifest` and `SwapDeal` types would remain unchanged; only the internal deposit and payout logic would change.

### 20.4 Migration Path

When predicate-based swaps are available:
- A new config option (`executionMode: 'escrow' | 'direct'`) would select the mechanism.
- Default could be `'direct'` with fallback to `'escrow'` when predicates are unavailable.
- `SwapRef` would gain an `executionMode` field for per-swap tracking.
- Events remain identical -- `swap:deposit_sent`, `swap:completed`, etc.
- Error codes are extended but not replaced.
