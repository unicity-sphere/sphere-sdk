/**
 * SDK2 Core Types
 * Platform-independent type definitions
 */

import type { AdditionalAsset } from './asset-target';
import type { DeliveryStrategy } from './uxf-transfer';

// =============================================================================
// Provider Base Types
// =============================================================================

export type ProviderStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ProviderMetadata {
  readonly id: string;
  readonly name: string;
  readonly type: 'local' | 'cloud' | 'p2p' | 'network';
  readonly description?: string;
}

export interface BaseProvider extends ProviderMetadata {
  connect(config?: unknown): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getStatus(): ProviderStatus;
}

// =============================================================================
// Identity Types
// =============================================================================

export interface Identity {
  /** 33-byte compressed secp256k1 public key (for L3 chain) */
  readonly chainPubkey: string;
  /** L1 address (alpha1...) */
  readonly l1Address: string;
  /** L3 DIRECT address (DIRECT://...) */
  readonly directAddress?: string;
  readonly ipnsName?: string;
  readonly nametag?: string;
}

export interface FullIdentity extends Identity {
  readonly privateKey: string;
}

export interface IdentityConfig {
  mnemonic?: string;
  privateKey?: string;
  derivationPath?: string;
}

// =============================================================================
// Token Types
// =============================================================================

export type TokenStatus =
  | 'pending'      // Initial creation
  | 'submitted'    // Commitment sent, waiting for proof (NOSTR-FIRST)
  | 'confirmed'    // Has inclusion proof
  | 'transferring' // Being transferred
  | 'spent'        // Transferred away
  | 'invalid';     // Validation failed

export interface Token {
  readonly id: string;
  readonly coinId: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly iconUrl?: string;
  readonly amount: string;
  status: TokenStatus;
  readonly createdAt: number;
  updatedAt: number;
  readonly sdkData?: string;
}

export interface Asset {
  readonly coinId: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly iconUrl?: string;
  readonly totalAmount: string;
  readonly tokenCount: number;
  /** Sum of confirmed token amounts (smallest units) */
  readonly confirmedAmount: string;
  /** Sum of unconfirmed (submitted/pending) token amounts (smallest units) */
  readonly unconfirmedAmount: string;
  /** Number of confirmed tokens aggregated */
  readonly confirmedTokenCount: number;
  /** Number of unconfirmed tokens aggregated */
  readonly unconfirmedTokenCount: number;
  /** Number of tokens currently being sent */
  readonly transferringTokenCount: number;
  /** Price per whole unit in USD (null if PriceProvider not configured) */
  readonly priceUsd: number | null;
  /** Price per whole unit in EUR (null if PriceProvider not configured) */
  readonly priceEur: number | null;
  /** 24h price change percentage (null if unavailable) */
  readonly change24h: number | null;
  /** Total fiat value in USD: (totalAmount / 10^decimals) * priceUsd */
  readonly fiatValueUsd: number | null;
  /** Total fiat value in EUR */
  readonly fiatValueEur: number | null;
}

// =============================================================================
// Transfer Types
// =============================================================================

export type TransferStatus =
  | 'pending'
  | 'submitted'
  | 'confirmed'
  | 'delivered'
  | 'completed'
  | 'failed';

export type AddressMode = 'auto' | 'direct' | 'proxy';

/**
 * Public transfer mode — what callers pass to `payments.send({ transferMode })`.
 *
 * Values:
 *  - `'instant'`      — UXF / legacy fast path; sender publishes proofs ASAP
 *                       and the receiver finalizes its end of the chain.
 *  - `'conservative'` — sender collects ALL inclusion proofs before
 *                       publishing the bundle on Nostr.
 *
 * @remarks
 * The `'txf'` mode (legacy single-token wire shape) lives in the INTERNAL
 * {@link InternalTransferMode} union; it is intentionally absent from the
 * public surface so call-sites do not have to switch on a value that is not
 * yet routable. T.7.A lands the TXF arm; until then,
 * `payments.send({ transferMode: 'txf' as TransferMode })` (test-only cast)
 * rejects with `UNSUPPORTED_TRANSFER_MODE` via the
 * `modules/payments/transfer/transfer-mode-shims.ts` per-call-site shim.
 *
 * Spec: §10.1 (sender-side widening; "Breaking-widening note" — the public
 * type stays `'instant' | 'conservative'` until T.7.E flips the default).
 */
export type TransferMode = 'instant' | 'conservative';

/**
 * INTERNAL transfer mode — extends {@link TransferMode} with the legacy
 * `'txf'` arm. Used inside the SDK after the per-call-site narrowing shim
 * has run (`modules/payments/transfer/transfer-mode-shims.ts`).
 *
 * @internal
 *
 * @remarks
 * Do NOT consume from app code. The public surface is {@link TransferMode}.
 * This type exists ONLY so the shim can return a value that the future TXF
 * router (T.7.A) can switch on without losing exhaustiveness. Re-exported
 * from the main barrel because every internal arm of the SDK consumes it
 * post-shim, but documented as `@internal` so doc generators flag it.
 *
 * Note N8 of `docs/uxf/UXF-TRANSFER-IMPL-PLAN.md` (§T.1.B.1).
 */
export type InternalTransferMode = 'instant' | 'conservative' | 'txf';

export interface TransferRequest {
  /**
   * Primary coin slot — coin id of the fungible slice. Together with
   * {@link TransferRequest.amount} forms the request's primary entry.
   *
   * **Optional** as of T.1.B.1 (§10.1 widening): NFT-only sends omit both
   * `coinId` and `amount` and rely entirely on `additionalAssets`. The
   * §4.1 step 1 validator (T.2.B) prepends `{kind:'coin', coinId, amount}`
   * to the target list iff BOTH fields are present and `amount > 0`.
   *
   * @remarks
   * Widened from `string` to `string | undefined`. Existing single-coin
   * callers that always pass `coinId` continue to work unchanged.
   */
  readonly coinId?: string;
  /**
   * Primary coin slot — amount in smallest unit (string-encoded big int).
   * See {@link TransferRequest.coinId} for the optional-pair semantics.
   *
   * @remarks
   * Widened from `string` to `string | undefined` per T.1.B.1.
   */
  readonly amount?: string;
  readonly recipient: string;
  readonly memo?: string;
  /** Address mode: 'auto' (default) uses directAddress if available, 'direct' forces DIRECT, 'proxy' forces PROXY */
  readonly addressMode?: AddressMode;
  /**
   * Transfer mode: `'instant'` (default) sends via Nostr immediately,
   * `'conservative'` collects all proofs first. The future `'txf'` arm
   * (legacy wire shape) is gated by the per-call-site narrowing shim and
   * NOT part of the public surface; see {@link TransferMode} for details.
   */
  readonly transferMode?: TransferMode;
  /**
   * Multi-asset extension — additional coin slices and/or whole-token (NFT)
   * targets to deliver in the same UXF bundle. Each entry is either a
   * `{kind:'coin'}` slice or a `{kind:'nft'}` whole-token reference.
   *
   * - All `kind:'coin'` `coinId`s (including the primary slot) MUST be
   *   distinct.
   * - All `kind:'nft'` `tokenId`s MUST be distinct.
   * - Receivers REJECT unrecognized `kind` values with `UNKNOWN_ASSET_KIND`
   *   (forward-compat — §4.1 / §10.4).
   *
   * Spec: §10.1 (sender-side widening); §4.1 step 1 (target list build).
   */
  readonly additionalAssets?: ReadonlyArray<AdditionalAsset>;
  /**
   * Per §2.5 chain-mode opt-in. Default `false` — only finalized tokens
   * are eligible as sources. When `true`, the source selector accepts
   * pending-but-confirmed-able sources (§5.5 chain mode).
   *
   * Forced-conservative coercion (T.7.D): When the receiver flow is bridged to
   * an external escrow (e.g., swap deposit invoices), this flag is silently
   * coerced to `false` by the bridging caller. The coercion is surfaced via
   * `TransferResult.overrides`. See AccountingModule.payInvoice().
   *
   * @remarks
   * Routing is owned by T.5.B / T.5.C.
   */
  readonly allowPendingTokens?: boolean;
  /**
   * NFT cascade asymmetry warning acknowledgement — required `true` to
   * send NFT-class targets backed by pending source tokens (§4.1 step 2).
   * NFT cascades cost non-fungible identity (irrecoverable); coin
   * cascades cost fungible value (replaceable). Default `false` rejects
   * pending-NFT sends with `NFT_PENDING_REQUIRES_CONFIRMATION`.
   */
  readonly confirmNftPending?: boolean;
  /**
   * Per-call delivery override controlling inline-vs-CID UXF bundle
   * delivery. Defaults to `{ kind: 'auto', inlineCapBytes: 16384 }` — the
   * sender picks `uxf-car` if the assembled CAR fits, else `uxf-cid`.
   * See {@link DeliveryStrategy} (re-exported from `./uxf-transfer`) for
   * the full union.
   *
   * @remarks
   * Type-level only at T.1.B.1; routing is owned by T.2.C / T.2.D.
   */
  readonly delivery?: DeliveryStrategy;
  /**
   * Only applies when `transferMode === 'txf'` (post-T.7.A). Selects the
   * legacy TXF wire shape's finalization style:
   *  - `'instant'`      — TXF-instant: receiver finalizes from a pending
   *                       sender chain.
   *  - `'conservative'` — TXF-conservative: full proofs before send.
   * Default `'conservative'` (per §10.1).
   *
   * @remarks
   * Ignored at T.1.B.1 (TXF arm not yet routed); the shim throws
   * `UNSUPPORTED_TRANSFER_MODE` for any `'txf'` mode regardless of this
   * field's value. T.7.A wires this in.
   */
  readonly txfFinalization?: 'instant' | 'conservative';
  /** Invoice refund address (DIRECT://) — embedded in on-chain message for return routing */
  readonly invoiceRefundAddress?: string;
  /** Invoice contact info — embedded in on-chain message for receipt/notice delivery */
  readonly invoiceContact?: { address: string; url?: string };
  /**
   * Issue #166 P2 #2 — explicit override for the duplicate-bundle guard.
   *
   * Default `false`. The dispatcher rejects sends whose source token
   * selection includes a `tokenId` already referenced by a LIVE OUTBOX
   * entry (status not in the hard-terminal partition) OR present in the
   * SENT ledger. This catches:
   *  - Concurrent-send races (two windows / tabs both planning against
   *    the same wallet state).
   *  - Post-restart state disagreements where the in-memory token
   *    mirror briefly disagrees with the durable OUTBOX before
   *    `installOutboxWriter` hydration finishes.
   *  - Bugs that bypass the natural `'transferring'`-status filter in
   *    `SpendPlanner.buildParsedPool`.
   *
   * Set `true` to bypass the guard for intentional re-sends (e.g. the
   * recipient lost the bundle and the operator wants to re-deliver with
   * fresh state evidence). The error code on violation is
   * `DUPLICATE_BUNDLE_MEMBERSHIP`.
   *
   * No-op on legacy-only wallets where either writer is uninstalled —
   * the guard self-skips because it cannot distinguish "not in any
   * tracked structure" from "writer unavailable."
   */
  readonly allowDuplicateBundleMembership?: boolean;
}

/**
 * Per-token transfer detail tracking the on-chain commitment or split operation
 * for each source token involved in a transfer.
 */
export interface TokenTransferDetail {
  /** Source token ID that was consumed in this transfer */
  readonly sourceTokenId: string;
  /** Transfer method used for this token */
  readonly method: 'direct' | 'split';
  /** Aggregator commitment request ID hex (for direct transfers) */
  readonly requestIdHex?: string;
  /** Split group ID (for split transfers — correlates sender/recipient/change tokens) */
  readonly splitGroupId?: string;
  /** Nostr event ID (for split transfers delivered via Nostr) */
  readonly nostrEventId?: string;
  /**
   * Coin-class split provenance (UXF C11). Set ONLY for coin children
   * (the recipient's freshly-minted token plus any change tokens the
   * sender retained). NEVER set for NFT direct transfers — those
   * preserve `tokenId` and have no split parent.
   *
   *  - `tokenId` — the parent (source) token whose burn produced this
   *    child's mint.
   *  - `status`  — `'pending'` while the parent's commit-transition is
   *    awaiting an inclusion proof; `'valid'` once the worker attaches
   *    the proof (T.5.B). The recipient cascades this status onto the
   *    received child until the parent finalizes (§6.1.1).
   *
   * Spec refs: UXF impl-plan C11 (class-disjoint splitParent rule),
   * §6.1.1 (cascade semantics).
   */
  readonly splitParent?: {
    readonly tokenId: string;
    readonly status: 'pending' | 'valid';
  };
}

export interface TransferResult {
  readonly id: string;
  status: TransferStatus;
  readonly tokens: Token[];
  /** Per-token transfer details — one entry per source token consumed */
  readonly tokenTransfers: TokenTransferDetail[];
  /**
   * Caller-visible record of silent overrides applied by intermediary modules
   * to the original request. Each entry is a stable, machine-readable token
   * (e.g., 'allowPendingTokens-coerced-to-false'). Surfaced when the SDK
   * silently overrides a caller-supplied flag — for example, when an invoice
   * payment bridging to escrow forces conservative source selection.
   *
   * When no overrides apply, the field is either omitted or an empty array.
   * Backward-compatible with consumers that ignore unknown TransferResult fields.
   */
  readonly overrides?: ReadonlyArray<string>;
  error?: string;
}

export interface IncomingTransfer {
  readonly id: string;
  readonly senderPubkey: string;
  readonly senderNametag?: string;
  readonly tokens: Token[];
  readonly memo?: string;
  readonly receivedAt: number;
}

// =============================================================================
// Payment Request Types
// =============================================================================

export type PaymentRequestStatus = 'pending' | 'accepted' | 'rejected' | 'paid' | 'expired';

/**
 * Outgoing payment request (requesting payment from someone)
 */
export interface PaymentRequest {
  /** Unique request ID */
  readonly id: string;
  /** Amount requested (in smallest units) */
  readonly amount: string;
  /** Coin/token type */
  readonly coinId: string;
  /** Optional message/memo */
  readonly message?: string;
  /** Where tokens should be sent */
  readonly recipientNametag?: string;
  /** Custom metadata */
  readonly metadata?: Record<string, unknown>;
  /** Expiration timestamp (ms) */
  readonly expiresAt?: number;
  /** Created timestamp */
  readonly createdAt: number;
}

/**
 * Incoming payment request (someone requesting payment from us)
 */
export interface IncomingPaymentRequest {
  /** Event ID from Nostr */
  readonly id: string;
  /** Sender's public key */
  readonly senderPubkey: string;
  /** Sender's nametag (if known) */
  readonly senderNametag?: string;
  /** Amount requested */
  readonly amount: string;
  /** Coin/token type */
  readonly coinId: string;
  /** Symbol for display */
  readonly symbol: string;
  /** Message from sender */
  readonly message?: string;
  /** Requester's nametag (where tokens should be sent) */
  readonly recipientNametag?: string;
  /** Original request ID from sender */
  readonly requestId: string;
  /** Timestamp */
  readonly timestamp: number;
  /** Current status */
  status: PaymentRequestStatus;
  /** Custom metadata */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Result of sending a payment request
 */
export interface PaymentRequestResult {
  readonly success: boolean;
  readonly requestId?: string;
  readonly eventId?: string;
  readonly error?: string;
}

/**
 * Handler for incoming payment requests
 */
export type PaymentRequestHandler = (request: IncomingPaymentRequest) => void;

/**
 * Response type for payment requests
 */
export type PaymentRequestResponseType = 'accepted' | 'rejected' | 'paid';

/**
 * Outgoing payment request (we sent to someone)
 */
export interface OutgoingPaymentRequest {
  /** Unique request ID */
  readonly id: string;
  /** Nostr event ID */
  readonly eventId: string;
  /** Recipient's public key */
  readonly recipientPubkey: string;
  /** Recipient's nametag (if known) */
  readonly recipientNametag?: string;
  /** Amount requested */
  readonly amount: string;
  /** Coin/token type */
  readonly coinId: string;
  /** Message sent with request */
  readonly message?: string;
  /** Created timestamp */
  readonly createdAt: number;
  /** Current status */
  status: PaymentRequestStatus;
  /** Response data (if received) */
  response?: PaymentRequestResponse;
}

/**
 * Response to a payment request
 */
export interface PaymentRequestResponse {
  /** Response event ID */
  readonly id: string;
  /** Responder's public key */
  readonly responderPubkey: string;
  /** Responder's nametag (if known) */
  readonly responderNametag?: string;
  /** Original request ID */
  readonly requestId: string;
  /** Response type */
  readonly responseType: PaymentRequestResponseType;
  /** Optional message */
  readonly message?: string;
  /** Transfer ID (if paid) */
  readonly transferId?: string;
  /** Timestamp */
  readonly timestamp: number;
}

/**
 * Handler for payment request responses
 */
export type PaymentRequestResponseHandler = (response: PaymentRequestResponse) => void;

// =============================================================================
// Message Types
// =============================================================================

export interface DirectMessage {
  readonly id: string;
  readonly senderPubkey: string;
  readonly senderNametag?: string;
  readonly recipientPubkey: string;
  readonly recipientNametag?: string;
  readonly content: string;
  readonly timestamp: number;
  isRead: boolean;
}

export interface BroadcastMessage {
  readonly id: string;
  readonly authorPubkey: string;
  readonly authorNametag?: string;
  readonly content: string;
  readonly timestamp: number;
  readonly tags?: string[];
}

export interface ComposingIndicator {
  readonly senderPubkey: string;
  readonly senderNametag?: string;
  readonly expiresIn: number;
}

// =============================================================================
// Tracked Addresses
// =============================================================================

/**
 * Minimal data stored in persistent storage for a tracked address.
 * Only contains user state — derived fields are computed on load.
 */
export interface TrackedAddressEntry {
  /** HD derivation index (0, 1, 2, ...) */
  readonly index: number;
  /** Whether this address is hidden from UI display */
  hidden: boolean;
  /** Timestamp (ms) when this address was first activated */
  readonly createdAt: number;
  /** Timestamp (ms) of last modification */
  updatedAt: number;
}

/**
 * Full tracked address with derived fields and nametag (available in memory).
 * Returned by Sphere.getActiveAddresses() / getAllTrackedAddresses().
 */
export interface TrackedAddress extends TrackedAddressEntry {
  /** Short address identifier (e.g., "DIRECT_abc123_xyz789") */
  readonly addressId: string;
  /** L1 bech32 address (alpha1...) */
  readonly l1Address: string;
  /** L3 DIRECT address (DIRECT://...) */
  readonly directAddress: string;
  /** 33-byte compressed secp256k1 public key */
  readonly chainPubkey: string;
  /** Primary nametag (from nametag cache, without @ prefix) */
  readonly nametag?: string;
}

// =============================================================================
// Event Types
// =============================================================================

export type SphereEventType =
  | 'transfer:incoming'
  | 'transfer:confirmed'
  | 'transfer:submitted'
  | 'transfer:cascade-risk-warning'
  | 'transfer:failed'
  | 'transfer:finalization-trigger-failed'
  | 'transfer:operator-alert'
  | 'transfer:fetch-failed'
  | 'transfer:ingest-queue-full'
  | 'transfer:cascade-failed'
  | 'transfer:trustbase-warning'
  | 'transfer:security-alert'
  | 'transfer:proof-superseded'
  | 'transfer:override-applied'
  | 'transfer:capability-warning'
  | 'transfer:recovery-republished'
  | 'transfer:orphan-spending-detected'
  | 'transfer:orphan-recovered'
  | 'transfer:sent-reconciliation-recovered'
  | 'transfer:sent-reconciliation-failed'
  | 'transfer:retention-warning'
  | 'transfer:retention-republish-rearmed'
  | 'transfer:retention-republish-skipped'
  | 'transfer:double-spend-detected'
  | 'transfer:off-record-spent'
  | 'payment_request:incoming'
  | 'payment_request:accepted'
  | 'payment_request:rejected'
  | 'payment_request:paid'
  | 'payment_request:response'
  | 'message:dm'
  | 'message:read'
  | 'message:typing'
  | 'composing:started'
  | 'message:broadcast'
  | 'sync:started'
  | 'sync:completed'
  | 'sync:provider'
  | 'sync:error'
  | 'connection:changed'
  /**
   * Issue #312 — connectivity surface. Emitted on every transition of
   * any per-backend (`aggregator | ipfs | nostr`) reachability state.
   * Payload is the full {@link ConnectivityStatusPayload} snapshot.
   */
  | 'connectivity:changed'
  /**
   * Issue #312 — fires when all three backends transition from a state
   * where at least one was `'down'` / `'unknown'` to all `'up'`. Pairs
   * with `'connectivity:offline-degraded'`.
   */
  | 'connectivity:online'
  /**
   * Issue #312 — fires when at least one backend transitions to `'down'`
   * while the wallet was previously fully online. `'degraded'` alone
   * does not trigger this event (the send-path retry layer absorbs it).
   */
  | 'connectivity:offline-degraded'
  | 'nametag:registered'
  | 'nametag:recovered'
  | 'identity:changed'
  | 'address:activated'
  | 'address:hidden'
  | 'address:unhidden'
  | 'sync:remote-update'
  /**
   * Issue #264 — Sphere bridge of the provider-level
   * `storage:monotonicity-recovered` event. Fires when the
   * flush-scheduler auto-merges a detected monotonicity gap in
   * place: tokens re-merged from the previously-loaded baseline,
   * unknown bundle CIDs inline-fetched + merged, OUTBOX entries
   * dropped by SENT-wins dedup, or residuals surfaced for
   * subsequent retries. See `StorageEventType` for the full payload
   * shape — Sphere forwards the provider event's `data` verbatim
   * with an added `providerId` field.
   *
   * Informational. Distinct from `transfer:operator-alert` /
   * `storage:error`: auto-merges are routine convergence work, not
   * alarms. Observability hook for dashboards plotting recovery rates,
   * not a paging signal.
   */
  | 'storage:monotonicity-recovered'
  /**
   * Issue #309 — Fires when the caller-supplied `fallbackStorage`
   * (typically the legacy IndexedDB) fails to connect during Sphere
   * load/init. The fallback is demoted to `null` so the rest of the
   * boot proceeds, but identity-key reads that would have consulted it
   * are now strictly bound to the primary's success. UI surfaces and
   * monitoring dashboards listen for this so they can warn users that
   * a Profile-mode wallet whose primary state has lost a block will
   * not recover from cache on this boot.
   */
  | 'storage:fallback-demoted'
  | 'groupchat:message'
  | 'groupchat:joined'
  | 'groupchat:left'
  | 'groupchat:kicked'
  | 'groupchat:group_deleted'
  | 'groupchat:updated'
  | 'groupchat:connection'
  | 'groupchat:ready'
  | 'communications:ready'
  | 'history:updated'
  // Invoice / Accounting events
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
  | 'invoice:receipt_sent'
  | 'invoice:receipt_received'
  | 'invoice:cancellation_sent'
  | 'invoice:cancellation_received'
  // Swap events
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
  | 'swap:bounce_received'
  /**
   * Issue #310 — fires AFTER `sphere.profile.resetEpoch()` persists
   * the new epoch floor locally. Payload: `{ newEpoch, reason, ts }`.
   */
  | 'profile:epoch-reset'
  /**
   * Issue #310 / PR #316 F1 fix — fires when `resetEpoch` could NOT
   * consult the on-chain epoch floor (aggregator/discovery failure).
   * The local epoch was still bumped from `localFloor + 1`, but the
   * new epoch is PROVISIONAL — if a sibling device's higher epoch
   * exists on-chain, the two devices may collide. The next discovery
   * cycle (periodic poll or explicit `recoverLatest`) will surface
   * the conflict via the normal walkback-floor path.
   *
   * Payload: `{ newEpoch, reason, discoveryError, ts }`.
   */
  | 'profile:epoch-reset-discovery-skipped'
  /**
   * Issue #310 / PR #316 F2 fix — fires when `resetEpoch` timed out
   * waiting for the aggregator-pointer publish to land. The local
   * epoch floor IS already persisted; the periodic-poll retry or
   * next dirty-flush will republish in the background. Callers
   * monitoring for the post-reset publish should keep watching
   * `'storage:pointer-published'` events (or re-call
   * `getEpochFloor()` after a few seconds).
   *
   * Payload: `{ newEpoch, reason, timeoutMs, ts }`.
   */
  | 'profile:epoch-reset-publish-pending';

export interface SphereEventMap {
  'transfer:incoming': IncomingTransfer;
  'transfer:confirmed': TransferResult;
  /**
   * Instant-mode UXF send acked by the relay (T.5.A). Distinct from
   * `transfer:confirmed` (which fires only after inclusion proofs land
   * locally — that is `transfer:finalized` in spec language but mapped
   * onto the existing `transfer:confirmed` event by T.5.B's worker once
   * proofs are attached). The status carried here is `'submitted'`:
   * the bundle has reached the recipient, but the source-token proofs
   * have not yet been polled.
   *
   * Spec refs: §2.1 (instant mode definition), §6.1 (sender-side
   * finalization worker — runs after this event fires).
   */
  'transfer:submitted': TransferResult;
  /**
   * Diagnostic warning emitted by the instant-mode sender when a
   * recipient is fed a freshly-minted child whose source token is still
   * pending (per §6.1.1 cascade rule). The recipient's wallet may need
   * to wait for the sender's source proofs before the child resolves.
   *
   * Spec refs: §6.1.1 (cascade rule — "pending source → pending child").
   */
  'transfer:cascade-risk-warning': {
    readonly transferId: string;
    readonly bundleCid: string;
    readonly recipientTransportPubkey: string;
    readonly pendingSourceTokenIds: ReadonlyArray<string>;
    readonly freshlyMintedChildTokenIds: ReadonlyArray<string>;
  };
  'transfer:failed': TransferResult;
  /**
   * UXF Inter-Wallet Transfer T.5.A / T.7.A — sender-side finalization
   * trigger callback failed (Wave 3 steelman fix #170 issue 2).
   *
   * The instant-mode sender registers each `delivered-instant` outbox
   * entry with its finalization-worker registry via the `onTriggerFinalization`
   * callback. Production wiring may surface a non-fatal error from the
   * registry (worker not yet available, transient registry hiccup);
   * historically the orchestrator swallowed those throws silently
   * because the publish has already completed and re-throwing would
   * pollute the success path.
   *
   * Silent swallow has an observability gap: a wallet that never reboots
   * after the trigger failure will keep the outbox entry at
   * `delivered-instant` indefinitely (the worker never picks it up).
   * This event surfaces that gap so operator dashboards / telemetry
   * pick up the failure without breaking the success-path contract.
   *
   * Spec refs: §6.1 (sender-side worker error model), §6.3 (resume on
   * boot — orphan `delivered-instant` entries).
   */
  'transfer:finalization-trigger-failed': {
    /** Per-address outbox key prefix (`${addr}.outbox.`). */
    readonly addressId: string;
    /** Outbox entry id (the transferId). */
    readonly outboxId: string;
    /** Bundle CID (forensic — same value persisted on the outbox entry).
     *  Empty string for legacy TXF mode (no bundle CID). */
    readonly bundleCid: string;
    /** Outstanding requestIds the worker would have polled. */
    readonly outstandingRequestIds: ReadonlyArray<string>;
    /** Human-readable failure reason. */
    readonly message: string;
  };
  /**
   * Operator-level alert raised when the §5.3 / §6.1 disposition path
   * surfaces a condition that warrants human attention but is NOT a
   * normal `transfer:failed` (e.g. C13: `'client-error'` reason from
   * `REQUEST_ID_MISMATCH` indicates a CLIENT BUG — the wallet computed
   * an inconsistent `(requestId, sourceState, transactionHash)` tuple).
   *
   * The payload is intentionally minimal so the event surface stays
   * stable across the §6.1 error model evolution: `code` carries the
   * `DispositionReason` that triggered the alert, `tokenId` (when
   * available) lets operators correlate to a specific token, and
   * `bundleCid` ties back to the originating UXF bundle.
   *
   * Spec refs: §6.1 (sender-side finalization error model),
   * §5.4 / `DispositionReason` enum.
   */
  'transfer:operator-alert': {
    readonly code: import('./disposition').DispositionReason;
    readonly tokenId?: string;
    readonly bundleCid?: string;
    readonly observedTokenContentHash?: import('../uxf/types').ContentHash;
    readonly senderTransportPubkey?: string;
    /**
     * Human-readable diagnostic. **Round 5 contract:** emit sites MUST
     * pre-sanitize this field via `sanitizeReasonString` (from
     * `core/error-sanitize.ts`) so any peer-/aggregator-supplied content
     * is stripped of control characters, HTML markup, and oversize
     * payloads before reaching operator dashboards. The dispatcher does
     * NOT centrally sanitize — callers own this for explicitness. New
     * emit sites: pipe untrusted text (especially `safeErrorMessage(err)`)
     * through `sanitizeReasonString(...)` before splicing into this
     * field. Audit closure tracks the existing emit sites.
     */
    readonly message: string;
  };
  /**
   * UXF Inter-Wallet Transfer T.4.B — recipient gateway-fetch failure (§9.2).
   *
   * Emitted exactly once when the CID-by-reference fetch path
   * (`kind: 'uxf-cid'`) has exhausted EVERY configured gateway without a
   * verified CAR. The bundle is NOT considered delivered; per §3.3.2 +
   * §9.2 the recipient does NOT acknowledge the sender, and per W13 NO
   * `_invalid` / `_audit` disposition record is written — failure is
   * transient by definition (a different gateway, or the sender's CAR-
   * embed retry, may resolve it).
   *
   * Payload fields:
   *  - `bundleCid` — the CIDv1 base32 the fetcher was asked to retrieve.
   *  - `senderTransportPubkey` — the AUTHENTICATED Nostr signing pubkey
   *    of the event author (NOT the unauthenticated `sender.transportPubkey`
   *    claim from the envelope).
   *  - `gatewaysAttempted` — every gateway URL the fetcher tried, in
   *    order. Length matches `failureReasons.length`.
   *  - `failureReasons` — per-gateway human-readable failure strings
   *    (`"network: ..."`, `"http 503"`, `"car-too-large"`, `"cid-mismatch"`,
   *    ...). Indexed identically to `gatewaysAttempted`. Useful for
   *    operator triage; not machine-parseable.
   *
   * Spec refs: §3.3.2 (delivery-completion semantics), §9.2 (recipient
   * gateway can't fetch CID), W13 (no disposition record on transient).
   */
  'transfer:fetch-failed': {
    readonly bundleCid: string;
    readonly senderTransportPubkey: string;
    readonly gatewaysAttempted: ReadonlyArray<string>;
    readonly failureReasons: ReadonlyArray<string>;
  };
  /**
   * UXF Inter-Wallet Transfer T.3.E — recipient ingest queue overflow
   * (§5.0 / W7).
   *
   * Emitted by `IngestWorkerPool.enqueue()` when the back-pressure cap
   * fires. Two distinct causes share this event for operator-monitoring
   * purposes:
   *
   *   - `'queue-full'`            — the global `INGEST_QUEUE_SIZE`
   *                                 (default 256) cap is exhausted; ANY
   *                                 incoming bundle is rejected until
   *                                 workers drain the queue.
   *   - `'queue-full-per-token'`  — at least one of the bundle's
   *                                 claimed token-ids has already
   *                                 accumulated `INGEST_QUEUE_PER_TOKEN_CAP`
   *                                 (default 16) pending entries; the
   *                                 hot tokenId is gated, others continue
   *                                 to enqueue.
   *
   * Per §5.0 the recipient does NOT acknowledge the sender on either
   * cause; the sender's outbox times out (transient-class). The
   * `tokenIds` field is populated only for the per-token variant — the
   * specific id(s) over-cap.
   */
  'transfer:ingest-queue-full': {
    readonly cause: 'queue-full' | 'queue-full-per-token';
    readonly senderTransportPubkey: string;
    readonly bundleCid: string;
    readonly queueSize: number;
    readonly capacity: number;
    readonly tokenIds?: ReadonlyArray<string>;
  };
  /**
   * UXF Inter-Wallet Transfer T.5.B / T.5.B.5 — cascade-failed signal
   * (§6.1.1).
   *
   * Emitted by the sender-side finalization worker (T.5.B) on hard-fail
   * of a queue entry whose token had outgoing outbox bundles in instant
   * mode. The actual cascade walk lives in T.5.B.5; T.5.B raises the
   * INTENT to cascade by emitting this event with the failing token's
   * id, the failure reason (so the walker knows the §6.1.1 race-lost
   * skip rule applies), and the outbox id so consumers (test harnesses,
   * the walker itself) can correlate.
   *
   * The race-lost reason intentionally short-circuits the cascade per
   * §6.1.1's "race-lost special case" rule — a worker that hard-fails
   * with `reason: 'race-lost'` MUST NOT emit this event. Tests pin the
   * absence of the event for race-lost.
   *
   * Spec refs: §6.1.1 (cascade rule), §6.1 (sender-side worker error
   * model), §5.4 / `DispositionReason` enum.
   */
  'transfer:cascade-failed': {
    readonly outboxId: string;
    readonly tokenId: string;
    readonly bundleCid: string;
    readonly recipientTransportPubkey: string;
    readonly reason: import('./disposition').DispositionReason;
    /**
     * Outbox entry's transfer mode at cascade time.
     *
     * - `'instant'` (the default when omitted) — the live finalization
     *   path. Receiver-side reconciliation may still recover (e.g. via
     *   `revalidateCascadedChildren()`).
     * - `'conservative'` / `'txf'` — shipped via the eager-finalization
     *   path: the bundle was committed before publish, so the source
     *   token is now forensically irrecoverable for the recipient.
     *   Sender-side UI MUST surface this as a hard error (the user
     *   thought the transfer succeeded; the cascade just told us it
     *   silently failed).
     *
     * **NFT class implication.** NFTs preserve their `tokenId` across
     * transfers — no `splitParent` walk recovers them. A conservative
     * NFT cascade is therefore the canonical "lost-NFT" signal; the UI
     * should treat it as terminal and prompt the operator to contact
     * the recipient out-of-band.
     */
    readonly mode?: 'instant' | 'conservative' | 'txf';
    /**
     * `true` iff this cascade-failed event corresponds to a non-instant
     * outbox entry that the historic walker would have silently dropped.
     * UI consumers MUST render `silent: true` events as hard errors
     * (with copy distinct from instant-mode cascade-failed) — see the
     * `mode` field for the rationale.
     *
     * Omitted (treated as `false`) when the event came from an instant-
     * mode entry.
     */
    readonly silent?: boolean;
  };
  /**
   * UXF Inter-Wallet Transfer T.5.B / T.5.C / T.5.F — trustBase
   * staleness warning (§6.1, §9.4.1).
   *
   * Emitted when an inclusion proof's verifier returns
   * `NOT_AUTHENTICATED` — the proof's validator signatures don't verify
   * against the local trustBase. The most likely cause is a stale local
   * trustBase (per §9.4.1's threat model — active forgery is out of
   * scope). Consumers SHOULD attempt a trustBase refresh; the worker
   * retries up to `MAX_PROOF_ERROR_RETRIES` and then hard-fails with
   * reason='proof-invalid'.
   *
   * Distinct from `transfer:security-alert`: trustbase-warning is the
   * routine "your local trustBase is stale" signal; security-alert is
   * reserved for the explicitly out-of-scope cases (e.g. two distinct
   * proofs for the same requestId with disagreeing values).
   *
   * Spec refs: §6.1 (NOT_AUTHENTICATED row), §9.4.1 (threat boundary).
   */
  'transfer:trustbase-warning': {
    readonly tokenId: string;
    readonly requestId: string;
    readonly outboxId?: string;
    readonly bundleCid?: string;
    readonly attempt: number;
    readonly message: string;
  };
  /**
   * UXF Inter-Wallet Transfer T.5.B / T.5.C — single-spend invariant
   * violation alert (§6.3, C10).
   *
   * Reserved for the §6.3 "forbidden case": observing two proofs for
   * the SAME `requestId` with DIFFERENT `(transactionHash,
   * authenticator)` values. The aggregator's single-spend invariant
   * guarantees this never happens in a non-faulty deployment; if it
   * does, the trust boundary may have been violated and operators must
   * investigate.
   *
   * The protocol does NOT auto-recover — the worker REFUSES to merge
   * the conflicting proof and emits this event so the operator is
   * notified. Per §6.3, this is the ONLY routine path that emits
   * `transfer:security-alert`; all other suspect events emit
   * `transfer:trustbase-warning` first.
   *
   * Spec refs: §6.3 (most-recent-proof rule + forbidden case).
   *
   * Authenticator field privacy (W40 / steelman warning):
   *   `attachedAuthenticator` / `observedAuthenticator` are emitted as
   *   the FIRST 16 HEX CHARS of `SHA-256(authenticator)` — NOT the raw
   *   authenticator. This gives operators enough entropy to correlate
   *   two conflicting proofs in dashboards/logs without leaking the
   *   ~130-char authenticator string into log sinks or telemetry. The
   *   raw authenticator is still retained in durable manifest-store
   *   entries for deep forensics. An empty string in either field
   *   means the source authenticator was empty.
   */
  'transfer:security-alert': {
    readonly tokenId: string;
    readonly requestId: string;
    readonly outboxId?: string;
    readonly attachedTransactionHash: string;
    readonly observedTransactionHash: string;
    /** SHA-256(rawAuthenticator).slice(0,16) — see jsdoc above. */
    readonly attachedAuthenticator?: string;
    /** SHA-256(rawAuthenticator).slice(0,16) — see jsdoc above. */
    readonly observedAuthenticator?: string;
    readonly message: string;
  };
  /**
   * UXF Inter-Wallet Transfer T.5.B / T.5.C — most-recent-proof
   * superseded notification (§6.3, W16).
   *
   * Emitted when a fresh poll returns a NEWER proof for an
   * already-attached requestId (same `(transactionHash, authenticator)`,
   * different unicityCertificate / round). The worker replaces the old
   * proof and tombstones the previous CID per §6.3's most-recent-proof
   * canonicalization rule. This event lets observability layers track
   * the maintenance operation.
   *
   * Distinct from `transfer:security-alert`: superseded means SAME
   * value (legitimate same-proof-newer-snapshot); security-alert means
   * DIFFERENT value (forbidden).
   *
   * Spec refs: §6.3 (most-recent-proof rule).
   */
  'transfer:proof-superseded': {
    readonly tokenId: string;
    readonly requestId: string;
    readonly outboxId?: string;
    readonly previousCid: string;
    readonly newCid: string;
  };
  /**
   * UXF Inter-Wallet Transfer T.5.D — operator override applied (§6.3 +
   * W30 / W31 / N4).
   *
   * Emitted exactly once per successful
   * `payments.importInclusionProof({ allowInvalidOverride: true })` call
   * that flips a token from `_invalid` back to the active pool. Carries
   * the durable audit trail recorded on the manifest entry:
   *
   *   - `overrideAppliedAt` — wall-clock millisecond timestamp.
   *   - `overrideAppliedBy` — operator pubkey (hex), if supplied at the
   *                           call site. Optional.
   *   - `previousReason`    — the {@link DispositionReason} the entry
   *                           carried in `_invalid` BEFORE the override.
   *                           Useful for forensic correlation.
   *   - `transition`        — `'invalid→valid'` for case 5 (single
   *                           hard-failed queue entry; manifest flipped
   *                           to `'valid'`) or `'invalid→pending'` for
   *                           case 6 (K-1 re-queue; manifest flipped to
   *                           `'pending'` until the remaining entries
   *                           resolve).
   *
   * The event is informational — operator consoles surface it
   * prominently because it represents an explicit breach of the §5.6
   * monotonicity invariant ("invalid → ?" is normally forbidden).
   *
   * Spec refs: §6.3 (stuck-PENDING escape), W31 (event), N4 (audit
   * listener).
   */
  'transfer:override-applied': {
    readonly tokenId: string;
    readonly overrideAppliedAt: number;
    readonly overrideAppliedBy?: string;
    readonly previousReason: import('./disposition').DispositionReason;
    readonly transition: 'invalid→valid' | 'invalid→pending';
  };
  /**
   * UXF Inter-Wallet Transfer T.8.B — capability hint mismatch (§10.4).
   *
   * Emitted by the sender BEFORE a UXF send when the resolved recipient's
   * identity-binding-event capability hints (`wireProtocols`, `assetKinds`)
   * indicate the recipient may not understand the bundle being shipped.
   *
   * The event is INFORMATIONAL ONLY: the sender DOES NOT auto-strip
   * unsupported asset kinds, DOES NOT downgrade the wire format, and
   * proceeds to publish the bundle unchanged. The actual interop
   * guarantee comes from the receiver's T.2.B `UNKNOWN_ASSET_KIND`
   * reject rule and the §10.4 forward-compat behaviour.
   *
   * Per W20: when the binding event is SILENT about `assetKinds`, the
   * peer is treated as `['coin']` (older v1.0 wallet pre-dating NFTs).
   * In that case, an outbound NFT entry triggers this warning.
   *
   * Payload fields:
   *  - `recipientTransportPubkey` — authenticated Nostr signing pubkey
   *    of the resolved peer (NOT a self-claimed envelope field).
   *  - `recipientAssetKinds` — the hint as observed (or the W20 default
   *    `['coin']` when absent). Empty array means hints were present
   *    but explicitly empty (informational quirk).
   *  - `recipientWireProtocols` — observed wire protocol hints. Absent
   *    on the wire ⇒ `undefined` here (no W20 default for this field).
   *  - `outboundAssetKinds` — the kinds present in the outbound bundle
   *    (subset of `'coin' | 'nft'` for v1.0).
   *  - `outboundWireProtocol` — the wire format the sender intends to
   *    use for this bundle (`'uxf-car' | 'uxf-cid' | 'txf'`).
   *  - `mismatchedAssetKinds` — kinds in `outboundAssetKinds` NOT
   *    advertised by the peer. Triggers the warning when non-empty.
   *  - `wireProtocolMismatch` — `true` when `outboundWireProtocol` is
   *    NOT in `recipientWireProtocols` (and hints were present). When
   *    hints are absent the field is `false` (no negative claim).
   *
   * Spec refs: §10.4 (capability hints — informational), W20 (assetKinds
   * absent ⇒ default ['coin']), T.2.B (receiver-side UNKNOWN_ASSET_KIND
   * reject — the actual interop guarantee).
   */
  'transfer:capability-warning': {
    readonly recipientTransportPubkey: string;
    readonly recipientAssetKinds: ReadonlyArray<string>;
    readonly recipientWireProtocols?: ReadonlyArray<string>;
    readonly outboundAssetKinds: ReadonlyArray<string>;
    readonly outboundWireProtocol: string;
    readonly mismatchedAssetKinds: ReadonlyArray<string>;
    readonly wireProtocolMismatch: boolean;
  };
  /**
   * UXF Inter-Wallet Transfer Phase 8 steelman post-cutover —
   * sending-recovery worker has re-published a stuck-in-`'sending'`
   * outbox entry and successfully transitioned it forward.
   *
   * Fired by `SendingRecoveryWorker` (gated behind
   * `features.recoveryWorker`) after a re-publish callback succeeded
   * AND the §7.0 `sending → delivered{,-instant}` transition committed.
   *
   * Payload fields:
   *  - `outboxId` — the outbox entry id whose status advanced.
   *  - `bundleCid` — content-addressed bundle CID (preserved across
   *    re-publish; the recipient's replay-LRU short-circuits dupes).
   *  - `tokenIds` — the bundle's genesis token ids.
   *  - `mode` — the entry's transfer mode (drives the target status).
   *  - `targetStatus` — the §7.0 status the entry advanced to.
   *  - `recoveredAt` — wall-clock ms timestamp of the recovery.
   *
   * Idempotent re-publish contract: §6.3 / T.3.A.
   */
  'transfer:recovery-republished': {
    readonly outboxId: string;
    readonly bundleCid: string;
    readonly tokenIds: ReadonlyArray<string>;
    readonly mode: 'conservative' | 'instant' | 'txf';
    readonly targetStatus: 'delivered' | 'delivered-instant';
    readonly recoveredAt: number;
  };
  /**
   * Issue #97 — A token in `'transferring'` status (= has an
   * in-flight spending tx) was found in neither the OUTBOX nor the
   * SENT ledger. This indicates a crash between Step 1 (append
   * spending tx) and Step 2 (persist outbox entry) of the canonical
   * send flow; the spending tx is on-chain but the delivery never
   * persisted. Operators must intervene — auto-recovery requires
   * bundle reconstruction (re-package + re-pin) which is gated to a
   * follow-up wave. See `payments.detectOrphanSpendingTokens()`.
   *
   * Payload fields:
   *  - `tokenId`     — the orphan token id
   *  - `detectedAt`  — wall-clock ms timestamp of detection
   *  - `coinId`      — coin id for operator triage
   *  - `amount`      — token amount (smallest units) for operator triage
   */
  'transfer:orphan-spending-detected': {
    readonly tokenId: string;
    readonly detectedAt: number;
    readonly coinId: string;
    readonly amount: string;
  };
  /**
   * Issue #166 P2 #1 — An orphan-spending token was successfully
   * auto-recovered by the orphan sweeper's recovery hook (gated on
   * `features.orphanAutoRecovery`, default OFF). The token's local
   * status was restored from `'transferring'` to a recoverable status
   * (today: `'confirmed'`) so the wallet can re-use the token's value.
   *
   * **Strategy-of-record.** The `strategy` field documents WHICH
   * recovery technique was applied. Future strategies (e.g.
   * `'restore-with-aggregator-check'`) extend the union additively.
   * Today only `'restore-to-confirmed'` is implemented — a best-effort
   * in-memory flip that assumes the spending commit never reached
   * the aggregator. If that assumption is wrong, the next operation
   * touching this token will see a state-mismatch rejection from the
   * aggregator (preserving correctness at the cost of an extra error
   * surfaced to the user).
   *
   * Payload fields:
   *  - `tokenId`     — the recovered orphan token id
   *  - `coinId`      — coin id (forensic / operator triage)
   *  - `amount`      — token amount in smallest units
   *  - `fromStatus`  — `'transferring'` (the orphan-status precondition)
   *  - `toStatus`    — the status the token was restored to
   *  - `strategy`    — recovery technique applied (see above)
   *  - `recoveredAt` — wall-clock ms timestamp of the recovery
   */
  'transfer:orphan-recovered': {
    readonly tokenId: string;
    readonly coinId: string;
    readonly amount: string;
    readonly fromStatus: 'transferring';
    readonly toStatus: string;
    readonly strategy: 'restore-to-confirmed';
    readonly recoveredAt: number;
  };
  /**
   * Issue #166 P2 #4 — A SENT-ledger write that was missed at the
   * dispatcher's delivered/delivered-instant transition (because the
   * SENT writer threw) was successfully retried by the
   * SentReconciliationWorker. The OUTBOX entry is now tombstoned.
   *
   * Payload fields:
   *  - `outboxId`    — the recovered entry's id (matches the SENT id)
   *  - `tokenIds`    — the bundle's genesis token ids
   *  - `mode`        — the entry's transfer mode (forensic only)
   *  - `recoveredAt` — wall-clock ms timestamp of the successful retry
   *
   * Companion to the round-2 steelman fix (`fcf1d53`) that keeps the
   * OUTBOX entry live at `status='delivered'` when SENT write fails so
   * an operator (or this worker) can complete the recovery.
   */
  'transfer:sent-reconciliation-recovered': {
    readonly outboxId: string;
    readonly tokenIds: ReadonlyArray<string>;
    readonly mode: 'conservative' | 'instant' | 'txf';
    readonly recoveredAt: number;
  };
  /**
   * Issue #166 P2 #4 — A SENT-ledger reconciliation retry exceeded
   * `maxRetries` consecutive failures. The OUTBOX entry remains live
   * at `status='delivered'` / `'delivered-instant'` for operator
   * triage; auto-retry is suspended for this entry until the worker
   * restarts (the in-memory failure counter is process-local).
   *
   * Payload fields:
   *  - `outboxId`            — the entry that could not be reconciled
   *  - `consecutiveFailures` — total failure count at the moment of
   *                            give-up (equals `maxRetries`)
   *  - `lastError`           — redacted message of the most recent
   *                            SENT-write throw (for operator triage)
   *  - `failedAt`            — wall-clock ms timestamp
   */
  'transfer:sent-reconciliation-failed': {
    readonly outboxId: string;
    readonly consecutiveFailures: number;
    readonly lastError: string;
    readonly failedAt: number;
  };
  /**
   * Issue #166 P2 #3 — A previously delivered TOKEN_TRANSFER event is
   * no longer retained on the queried relay set. The recipient may
   * have already received the bundle (Nostr publish + relay ack
   * succeeded earlier), but the event is now absent from the relay's
   * persistent store — likely due to retention policy eviction, relay
   * restart, or relay-segregation.
   *
   * The {@link NostrPersistenceVerifier} worker emits this once per
   * SENT entry per process lifetime (in-memory tracking; a process
   * restart re-arms the check).
   *
   * Payload fields:
   *  - `sentId`        — the SENT-ledger entry id (= original OUTBOX id)
   *  - `nostrEventId`  — the event id that's no longer retained
   *  - `bundleCid`     — the content-addressed bundle CID
   *  - `tokenIds`      — the bundle's genesis token ids
   *  - `recipientTransportPubkey` — recipient pubkey from SENT
   *  - `detectedAt`    — wall-clock ms timestamp
   */
  'transfer:retention-warning': {
    readonly sentId: string;
    readonly nostrEventId: string;
    readonly bundleCid: string;
    readonly tokenIds: ReadonlyArray<string>;
    readonly recipientTransportPubkey: string;
    readonly detectedAt: number;
  };
  /**
   * OUTBOX-SEND-FOLLOWUPS item #2 — emitted by `NostrPersistenceVerifier`
   * when a retention-drop ('missing' outcome) was successfully turned
   * into a re-publish attempt: the live OUTBOX entry at `sentId`
   * transitioned `delivered`/`delivered-instant` → `sending`, and the
   * SendingRecoveryWorker will pick it up on its next cycle.
   *
   * Recipient idempotency: the replay-LRU dedupes by `bundleCid`, so
   * an extra publish in the racing window is harmless (§6.3 / T.3.A).
   *
   * Operator semantics: this is informational. The retention-warning
   * event has already fired for the same `sentId`; this is the "we're
   * trying to recover" companion.
   */
  'transfer:retention-republish-rearmed': {
    readonly sentId: string;
    readonly nostrEventId: string;
    readonly bundleCid: string;
    readonly tokenIds: ReadonlyArray<string>;
    readonly recipientTransportPubkey: string;
    /** Status the OUTBOX entry held when we transitioned it back. */
    readonly fromStatus: 'delivered' | 'delivered-instant';
    /** Always `'sending'` today — kept explicit for forward-compat. */
    readonly toStatus: 'sending';
    readonly rearmedAt: number;
  };
  /**
   * OUTBOX-SEND-FOLLOWUPS item #2 — emitted by `NostrPersistenceVerifier`
   * when the retention-driven re-publish could NOT be initiated. The
   * verifier emits `transfer:retention-warning` first for operator
   * visibility; this companion event explains WHY no re-publish will
   * happen, so a downstream consumer can route to a different recovery
   * surface or escalate.
   *
   * `reason` values:
   *  - `'no-outbox-writer'` — feature wired but no OutboxWriter is
   *    currently installed (e.g. legacy wallet).
   *  - `'entry-tombstoned-or-missing'` — the SENT-ledger id has no
   *    live OUTBOX counterpart. Most common in conservative-mode
   *    wallets where successful SENT writes tombstone the OUTBOX
   *    entry; bundle bytes are not retained, so this code path cannot
   *    reconstruct. Requires the bundle-retention work tracked as the
   *    cross-cutting "Re-publish from where?" item in OUTBOX-SEND-
   *    FOLLOWUPS.
   *  - `'wrong-status'` — the OUTBOX entry exists but is NOT at
   *    `delivered`/`delivered-instant` (e.g. already in `'finalizing'`,
   *    `'expired'`, or post-cancellation). Out of scope for retention
   *    re-publish; another recovery path owns this case.
   *  - `'transition-failed'` — the state-machine transition itself
   *    rejected the update (e.g. terminal-state validator) or threw.
   */
  'transfer:retention-republish-skipped': {
    readonly sentId: string;
    readonly nostrEventId: string;
    readonly bundleCid: string;
    readonly reason:
      | 'no-outbox-writer'
      | 'entry-tombstoned-or-missing'
      | 'wrong-status'
      | 'transition-failed';
    readonly observedStatus?: string;
    readonly errorMessage?: string;
    readonly detectedAt: number;
  };
  /**
   * OUTBOX-SEND-FOLLOWUPS Item #14 Phase 1 — emitted by the dispatch
   * outer-catch when `submitTransferCommitment` failed AND the
   * dispatcher's `oracle.isSpent(sourceStateHash)` re-query confirms
   * the source state is already spent on-chain. Signals a multi-device
   * double-spend: another peer of the same wallet committed the
   * SAME source token to a DIFFERENT destination, and our commit
   * lost the race.
   *
   * Distinct from `transfer:orphan-spending-detected` (crash-window
   * orphan where the local OUTBOX entry is missing): this event
   * documents an operator-visible decision the L3 aggregator made
   * against our intended commit. Operators / UIs route the two
   * differently.
   *
   * Payload fields:
   *  - `tokenId`              — the source token id our commit
   *                             targeted.
   *  - `sourceStateHash`      — imprint hex of the source state hash
   *                             we tried to spend (the same value
   *                             we re-queried via `oracle.isSpent`).
   *  - `ourIntendedRecipient` — `directAddress` / `@nametag` /
   *                             pubkey we were sending to. Plain
   *                             string carried for forensics — not
   *                             authenticated against the on-chain
   *                             winner's recipient (that disambiguation
   *                             is Phase 2 work — see Item #14 work
   *                             items 5+7).
   *  - `detectedAt`           — wall-clock ms timestamp.
   *
   * Phase 2 follow-up: enrich the payload with the winning chain
   * head once the JOIN-time disambiguation lands (`winningChainHead`).
   *
   * Operator action: see `docs/uxf/RUNBOOK-SEND-PIPELINE.md` (Phase 2
   * work item — runbook section to be added alongside the JOIN-time
   * Token.status correction).
   */
  'transfer:double-spend-detected': {
    readonly tokenId: string;
    readonly sourceStateHash: string;
    readonly ourIntendedRecipient: string;
    readonly detectedAt: number;
  };
  /**
   * Issue #174 — Per-token spent-state rescan worker
   * ({@link SpentStateRescanWorker}; UXF-TRANSFER-PROTOCOL §12.3.2)
   * detected that a token sitting in the active pool at
   * `status === 'confirmed'` has its current destination state recorded
   * as SPENT by the L3 aggregator. The local manifest still believed
   * the token was spendable; the aggregator says otherwise.
   *
   * The most common producer is **another instance of the same wallet
   * (sibling-device spend)**: e.g. desktop + mobile share keys, mobile
   * spent the token, desktop has not yet pulled the spender's snapshot
   * via the profile-pointer rescan (§12.3.1 / Item #15). The
   * `suspectedSiblingInstance` flag carries the worker's heuristic
   * verdict — `true` when neither the local OUTBOX nor SENT ledger
   * holds any record referencing this `tokenId`, which means the spend
   * could not have been initiated on THIS device.
   *
   * Distinct from `transfer:double-spend-detected` (reactive — fires
   * only when the local instance attempts a send) and from
   * `transfer:orphan-spending-detected` (covers `'transferring'` tokens
   * stuck mid-send, not the active pool).
   *
   * Payload fields:
   *  - `tokenId`                  — the off-record-spent token id
   *  - `detectedAt`               — wall-clock ms timestamp of detection
   *  - `suspectedSiblingInstance` — heuristic: `true` when local
   *                                 OUTBOX+SENT ledgers have no entry
   *                                 referencing the token, so the
   *                                 spender is most likely another
   *                                 instance sharing our keys
   *  - `coinId`                   — coin id (forensic / operator triage)
   *  - `amount`                   — token amount in smallest units
   *                                 (forensic / operator triage)
   *
   * Operator action: see `docs/uxf/RUNBOOK-SEND-PIPELINE.md` —
   * "transfer:off-record-spent" section.
   */
  'transfer:off-record-spent': {
    readonly tokenId: string;
    readonly detectedAt: number;
    readonly suspectedSiblingInstance: boolean;
    readonly coinId: string;
    readonly amount: string;
  };
  'payment_request:incoming': IncomingPaymentRequest;
  'payment_request:accepted': IncomingPaymentRequest;
  'payment_request:rejected': IncomingPaymentRequest;
  'payment_request:paid': IncomingPaymentRequest;
  'payment_request:response': PaymentRequestResponse;
  'message:dm': DirectMessage;
  'message:read': { messageIds: string[]; peerPubkey: string };
  'message:typing': { senderPubkey: string; senderNametag?: string; timestamp: number };
  'composing:started': ComposingIndicator;
  'message:broadcast': BroadcastMessage;
  'sync:started': { source: string };
  'sync:completed': { source: string; count: number };
  'sync:provider': { providerId: string; success: boolean; added?: number; removed?: number; error?: string };
  'sync:error': { source: string; error: string };
  'connection:changed': { provider: string; connected: boolean; status?: ProviderStatus; enabled?: boolean; error?: string };
  'connectivity:changed': ConnectivityStatusPayload;
  'connectivity:online': ConnectivityStatusPayload;
  'connectivity:offline-degraded': ConnectivityStatusPayload;
  'nametag:registered': { nametag: string; addressIndex: number };
  'nametag:recovered': { nametag: string };
  'identity:changed': { l1Address: string; directAddress?: string; chainPubkey: string; nametag?: string; addressIndex: number };
  'address:activated': { address: TrackedAddress };
  'address:hidden': { index: number; addressId: string };
  'address:unhidden': { index: number; addressId: string };
  'sync:remote-update': { providerId: string; name: string; sequence: number; cid: string; added: number; removed: number };
  'storage:monotonicity-recovered': {
    providerId: string;
    recoveredTokenIds: string[];
    recoveredTokenCount: number;
    mergedUnknownBundleCids: string[];
    mergedUnknownBundleCount: number;
    residualUnknownBundleCids: string[];
    residualUnknownBundleCount: number;
    residualTokenMissingIds: string[];
    residualTokenMissingCount: number;
    recoveredOutboxIdsDroppedAsSent: string[];
    recoveredOutboxIdsDroppedAsSentCount: number;
    truncated: boolean;
  };
  'storage:fallback-demoted': {
    reason: 'connect-failed' | 'isConnected-false-after-connect';
    error: string;
    at: number;
  };
  'groupchat:message': import('../modules/groupchat/types').GroupMessageData;
  'groupchat:joined': { groupId: string; groupName: string };
  'groupchat:left': { groupId: string };
  'groupchat:kicked': { groupId: string; groupName: string };
  'groupchat:group_deleted': { groupId: string; groupName: string };
  'groupchat:updated': Record<string, never>;
  'groupchat:connection': { connected: boolean };
  'groupchat:ready': { groupCount: number };
  'communications:ready': { conversationCount: number };
  'history:updated': import('../modules/payments/PaymentsModule').TransactionHistoryEntry;
  // Invoice / Accounting event payloads
  'invoice:created': { invoiceId: string; confirmed: boolean };
  'invoice:payment': {
    invoiceId: string;
    transfer: import('../modules/accounting/types').InvoiceTransferRef;
    paymentDirection: 'forward' | 'back' | 'return_closed' | 'return_cancelled';
    confirmed: boolean;
  };
  'invoice:asset_covered': { invoiceId: string; address: string; coinId: string; confirmed: boolean };
  'invoice:target_covered': { invoiceId: string; address: string; confirmed: boolean };
  'invoice:covered': { invoiceId: string; confirmed: boolean };
  'invoice:closed': { invoiceId: string; explicit: boolean };
  'invoice:cancelled': { invoiceId: string };
  'invoice:expired': { invoiceId: string };
  'invoice:unknown_reference': { invoiceId: string; transfer: import('../modules/accounting/types').InvoiceTransferRef };
  'invoice:overpayment': { invoiceId: string; address: string; coinId: string; surplus: string; confirmed: boolean };
  'invoice:irrelevant': {
    invoiceId: string;
    transfer: import('../modules/accounting/types').InvoiceTransferRef;
    reason: import('../modules/accounting/types').IrrelevantTransfer['reason'];
    confirmed: boolean;
  };
  'invoice:auto_returned': {
    invoiceId: string;
    originalTransfer: import('../modules/accounting/types').InvoiceTransferRef;
    returnTransfer: import('../modules/accounting/types').InvoiceTransferRef;
  };
  'invoice:auto_return_failed': {
    invoiceId: string; transferId: string;
    reason: 'sender_unresolvable' | 'send_failed' | 'max_retries_exceeded';
    refundAddress?: string; contactAddresses?: string[];
  };
  'invoice:return_received': {
    invoiceId: string;
    transfer: import('../modules/accounting/types').InvoiceTransferRef;
    returnReason: 'manual' | 'closed' | 'cancelled';
  };
  'invoice:over_refund_warning': { invoiceId: string; senderAddress: string; coinId: string; forwardedAmount: string; returnedAmount: string };
  'invoice:receipt_sent': { invoiceId: string; sent: number; failed: number };
  'invoice:receipt_received': { invoiceId: string; receipt: import('../modules/accounting/types').IncomingInvoiceReceipt };
  'invoice:cancellation_sent': { invoiceId: string; sent: number; failed: number };
  'invoice:cancellation_received': { invoiceId: string; notice: import('../modules/accounting/types').IncomingCancellationNotice };
  // Swap event payloads
  'swap:proposal_received': { swapId: string; deal: Record<string, unknown>; senderPubkey: string; senderNametag?: string };
  'swap:proposed': { swapId: string; deal: Record<string, unknown>; recipientPubkey: string };
  'swap:accepted': { swapId: string; role: string };
  'swap:rejected': { swapId: string; reason?: string };
  'swap:announced': { swapId: string; depositInvoiceId: string };
  'swap:deposit_sent': { swapId: string; transferResult: TransferResult };
  'swap:deposit_confirmed': { swapId: string; party: string; amount: string; coinId: string };
  'swap:deposits_covered': { swapId: string };
  'swap:concluding': { swapId: string };
  'swap:payout_received': { swapId: string; payoutInvoiceId: string };
  'swap:completed': { swapId: string; payoutVerified: boolean };
  'swap:cancelled': { swapId: string; reason: string; depositsReturned?: boolean };
  'swap:failed': { swapId: string; error: string };
  'swap:deposit_returned': { swapId: string; transfer: import('../modules/accounting/types').InvoiceTransferRef; returnReason: string };
  'swap:bounce_received': { swapId: string; reason: string; returnedAmount: string; returnedCurrency: string };
  /**
   * Issue #310 — payload for `'profile:epoch-reset'`. `newEpoch` is the
   * post-reset value (strictly `prev + 1`). `reason` is the
   * operator-supplied triage string. `ts` is the wall-clock instant
   * (ms epoch) of the reset.
   */
  'profile:epoch-reset': { newEpoch: number; reason: string; ts: number };
  /**
   * Issue #310 / PR #316 F1 fix — payload for
   * `'profile:epoch-reset-discovery-skipped'`. `newEpoch` is the
   * bumped local floor (provisional — see event-type doc).
   * `discoveryError` is a short diagnostic string suitable for
   * operator triage; the underlying error is also logged.
   */
  'profile:epoch-reset-discovery-skipped': {
    newEpoch: number;
    reason: string;
    discoveryError: string;
    ts: number;
  };
  /**
   * Issue #310 / PR #316 F2 fix — payload for
   * `'profile:epoch-reset-publish-pending'`. Fires when the publish
   * step did not land within the bounded timeout. The wallet's local
   * floor is unchanged from the corresponding `'profile:epoch-reset'`
   * event; the publish will be retried by the periodic poll.
   */
  'profile:epoch-reset-publish-pending': {
    newEpoch: number;
    reason: string;
    timeoutMs: number;
    ts: number;
  };
}

export type SphereEventHandler<T extends SphereEventType> = (
  data: SphereEventMap[T]
) => void;

// =============================================================================
// Configuration Types
// =============================================================================

export interface SphereConfig {
  identity: IdentityConfig;
  storage?: StorageProviderConfig;
  transport?: TransportProviderConfig;
  aggregator?: AggregatorProviderConfig;
  logging?: LoggingConfig;
}

export interface StorageProviderConfig {
  type: 'local' | 'ipfs' | 'hybrid';
  prefix?: string;
  // IPFS specific
  gateways?: string[];
  bootstrapPeers?: string[];
  enableIpns?: boolean;
}

export interface TransportProviderConfig {
  type: 'nostr';
  relays?: string[];
  timeout?: number;
  autoReconnect?: boolean;
}

/**
 * Aggregator (oracle) provider configuration
 * The aggregator provides verifiable truth about token state through inclusion proofs
 */
export interface AggregatorProviderConfig {
  /** Aggregator/oracle URL endpoint */
  url: string;
  /** Request timeout in ms */
  timeout?: number;
  /** Skip proof verification (for testing only) */
  skipVerification?: boolean;
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  logger?: (level: string, message: string, data?: unknown) => void;
}

// =============================================================================
// Error Types (canonical source: core/errors.ts)
// =============================================================================

export { SphereError, isSphereError } from '../core/errors';
export type { SphereErrorCode } from '../core/errors';

// =============================================================================
// Wallet Management Types
// =============================================================================

/**
 * Derivation mode determines how child keys are derived:
 * - "bip32": Standard BIP32 with chain code (IL + parentKey) mod n
 * - "legacy_hmac": Legacy Sphere HMAC derivation with chain code
 * - "wif_hmac": Simple HMAC derivation without chain code (webwallet compatibility)
 */
export type DerivationMode = 'bip32' | 'legacy_hmac' | 'wif_hmac';

/**
 * Source of wallet creation
 */
export type WalletSource = 'mnemonic' | 'file' | 'unknown';

/**
 * Wallet information for backup/export purposes
 */
export interface WalletInfo {
  readonly source: WalletSource;
  readonly hasMnemonic: boolean;
  readonly hasChainCode: boolean;
  readonly derivationMode: DerivationMode;
  readonly basePath: string;
  readonly address0: string | null;
}

/**
 * JSON export format for wallet backup (v1.0)
 */
export interface WalletJSON {
  readonly version: '1.0';
  readonly type: 'sphere-wallet';
  readonly createdAt: string;
  readonly wallet: {
    readonly masterPrivateKey?: string;
    readonly chainCode?: string;
    readonly addresses: ReadonlyArray<{
      readonly address: string;
      readonly publicKey: string;
      readonly path: string;
      readonly index: number;
    }>;
    readonly isBIP32: boolean;
    readonly descriptorPath?: string;
  };
  readonly mnemonic?: string;
  readonly encrypted?: boolean;
  readonly source?: WalletSource;
  readonly derivationMode?: DerivationMode;
}

/**
 * Options for exporting wallet to JSON
 */
export interface WalletJSONExportOptions {
  /** Include mnemonic in export (default: true if available) */
  includeMnemonic?: boolean;
  /** Encrypt sensitive data with password */
  password?: string;
  /** Number of addresses to include (default: 1) */
  addressCount?: number;
}

// =============================================================================
// Address Derivation Types (re-exported from crypto)
// =============================================================================

export type { AddressInfo } from '../core/crypto';

// Re-export TXF types
export * from './txf';

// Re-export instant split types
export * from './instant-split';

// Re-export payment session types
export * from './payment-session';

// Re-export UXF transfer wire-format types (T.1.A)
export * from './uxf-transfer';

// Re-export Asset Target / Additional Asset types (T.1.B.1)
export * from './asset-target';

// Re-export DispositionReason / AuditStatus enums + record schemas (T.1.C)
export * from './disposition';

// =============================================================================
// Network Health Types
// =============================================================================

/**
 * Result of a single service health check
 */
export interface ServiceHealthResult {
  /** Whether the service is reachable */
  healthy: boolean;
  /** URL that was checked */
  url: string;
  /** Response time in ms (null if unreachable) */
  responseTimeMs: number | null;
  /** Error message if unhealthy */
  error?: string;
}

/**
 * User-provided health check function for custom services.
 * Receives the configured timeout and should return a ServiceHealthResult.
 */
export type HealthCheckFn = (timeoutMs: number) => Promise<ServiceHealthResult>;

/**
 * Result of checking all network services (pre-init)
 */
export interface NetworkHealthResult {
  /** Overall health: true if all checked services are reachable */
  healthy: boolean;
  /** Per-service results (built-in + custom) */
  services: {
    relay?: ServiceHealthResult;
    oracle?: ServiceHealthResult;
    l1?: ServiceHealthResult;
    /** Custom service results keyed by user-provided name */
    [key: string]: ServiceHealthResult | undefined;
  };
  /** Total time to complete all checks (ms) */
  totalTimeMs: number;
}

// =============================================================================
// Connectivity Types (Issue #312)
// =============================================================================

/**
 * Per-backend reachability state. Mirrors `ConnectivityBackendStatus`
 * in `core/connectivity.ts`, re-declared here so it can be referenced from
 * the central event-map typings without a runtime import cycle.
 *
 * `'unknown'` is the pre-probe state right after Sphere.init() — the
 * manager fires the first probe asynchronously, so any caller that reads
 * `sphere.connectivity.status()` immediately after `init()` sees `'unknown'`
 * for every backend.
 */
export type ConnectivityBackendStatusType = 'up' | 'down' | 'degraded' | 'unknown';

/**
 * Snapshot of the connectivity surface, emitted as the payload of
 * `connectivity:changed` / `connectivity:online` /
 * `connectivity:offline-degraded`.
 */
export interface ConnectivityStatusPayload {
  /** Aggregator (L3 state-transition oracle) reachability. */
  readonly aggregator: ConnectivityBackendStatusType;
  /** IPFS gateway reachability. */
  readonly ipfs: ConnectivityBackendStatusType;
  /** Nostr relay reachability. */
  readonly nostr: ConnectivityBackendStatusType;
  /** ms-epoch of the most recent fully-online moment, or null if never. */
  readonly lastOnlineAt: number | null;
  /** ms-epoch of the most recent backend transition (any direction). */
  readonly lastChangedAt: number;
}

// =============================================================================
// Provider Status Types
// =============================================================================

/** Role of a provider in the system */
export type ProviderRole = 'storage' | 'token-storage' | 'transport' | 'oracle' | 'l1' | 'price';

/**
 * Rich status information for a single provider (used in getStatus())
 */
export interface ProviderStatusInfo {
  /** Provider unique ID */
  id: string;
  /** Display name */
  name: string;
  /** Role in the system */
  role: ProviderRole;
  /** Detailed status */
  status: ProviderStatus;
  /** Shorthand for status === 'connected' */
  connected: boolean;
  /** Whether the provider is enabled (can be toggled at runtime) */
  enabled: boolean;
  /** Provider-specific metadata (e.g., relay count for transport) */
  metadata?: Record<string, unknown>;
}

/**
 * Aggregated status of all providers, grouped by role
 */
export interface SphereStatus {
  storage: ProviderStatusInfo[];
  tokenStorage: ProviderStatusInfo[];
  transport: ProviderStatusInfo[];
  oracle: ProviderStatusInfo[];
  l1: ProviderStatusInfo[];
  price: ProviderStatusInfo[];
}
