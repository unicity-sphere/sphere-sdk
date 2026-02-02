/**
 * Payment Session Types
 *
 * Types for tracking instant transfer sessions through their lifecycle.
 * Sessions track the state of both sender and receiver operations.
 */

// =============================================================================
// Payment Session Status
// =============================================================================

/**
 * Status of a payment session through its lifecycle
 *
 * SEND Flow:
 * INITIATED -> COMMITMENT_CREATED -> NOSTR_DELIVERED -> (background: SUBMITTED -> PROOF_RECEIVED) -> COMPLETED
 *
 * RECEIVE Flow:
 * INITIATED -> TOKEN_RECEIVED -> FINALIZING -> COMPLETED
 */
export type PaymentSessionStatus =
  | 'INITIATED' // Session created
  | 'COMMITMENT_CREATED' // Transfer commitment ready (SEND)
  | 'SUBMITTED' // Submitted to aggregator (SEND, background)
  | 'PROOF_RECEIVED' // Inclusion proof received (SEND, background)
  | 'TOKEN_RECEIVED' // Token received from Nostr (RECEIVE)
  | 'FINALIZING' // Running finalization (RECEIVE)
  | 'NOSTR_DELIVERED' // Token sent via Nostr (SEND)
  | 'COMPLETED' // Fully completed
  | 'FAILED' // Terminal failure
  | 'TIMED_OUT'; // Session exceeded deadline

/**
 * Direction of the payment session
 */
export type PaymentSessionDirection = 'SEND' | 'RECEIVE';

// =============================================================================
// Payment Session Error Types
// =============================================================================

/**
 * Error codes specific to instant transfers
 */
export type PaymentSessionErrorCode =
  | 'NOSTR_DELIVERY_FAILED' // Failed to send via Nostr
  | 'NOSTR_TIMEOUT' // Nostr confirmation timed out
  | 'AGGREGATOR_SUBMIT_FAILED' // Background aggregator submission failed
  | 'IPFS_SYNC_FAILED' // Background IPFS sync failed
  | 'TOKEN_FINALIZATION_FAILED' // Recipient couldn't finalize token
  | 'PROOF_FETCH_FAILED' // Recipient couldn't fetch proof
  | 'SESSION_TIMEOUT' // Session exceeded deadline
  | 'INSUFFICIENT_BALANCE' // Not enough balance for transfer
  | 'INVALID_RECIPIENT' // Recipient address invalid
  | 'SPLIT_BURN_FAILED' // Split burn phase failed
  | 'SPLIT_MINT_FAILED' // Split mint phase failed
  | 'UNKNOWN';

/**
 * Error details for a payment session
 */
export interface PaymentSessionError {
  /** Error code */
  code: PaymentSessionErrorCode;

  /** Human-readable error message */
  message: string;

  /** When the error occurred */
  timestamp: number;

  /** Whether the error is recoverable */
  recoverable: boolean;

  /** Additional error details */
  details?: Record<string, unknown>;
}

// =============================================================================
// Payment Session
// =============================================================================

/**
 * Payment session tracking structure
 *
 * Tracks the instant transfer lifecycle for both sender and receiver.
 */
export interface PaymentSession {
  /** Unique session identifier */
  id: string;

  /** Direction of transfer */
  direction: PaymentSessionDirection;

  /** Current status */
  status: PaymentSessionStatus;

  /** Timestamp when session was created */
  createdAt: number;

  /** Timestamp of last status update */
  updatedAt: number;

  /** Deadline for session completion (default: createdAt + 300_000 = 5 min) */
  deadline?: number;

  /** Error details if failed */
  error: PaymentSessionError | null;

  // ==========================================
  // SEND-specific fields
  // ==========================================

  /** Source token ID being sent */
  sourceTokenId?: string;

  /** Recipient's human-readable nametag */
  recipientNametag?: string;

  /** Recipient's Nostr public key */
  recipientPubkey?: string;

  /** Amount being sent (BigInt as string) */
  amount?: string;

  /** Coin ID for the token type */
  coinId?: string;

  /** Hex-encoded salt used in commitment */
  salt?: string;

  /** Serialized transfer commitment */
  commitmentJson?: string;

  /** Nostr event ID after delivery */
  nostrEventId?: string;

  /** Associated outbox entry ID */
  outboxEntryId?: string;

  // ==========================================
  // Background lane status (SEND)
  // ==========================================

  /** Background aggregator submission status */
  aggregatorStatus?: 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED';

  /** Background IPFS sync status */
  ipfsStatus?: 'PENDING' | 'SYNCED' | 'FAILED';

  // ==========================================
  // RECEIVE-specific fields
  // ==========================================

  /** Source Nostr event ID */
  sourceEventId?: string;

  /** Sender's Nostr public key */
  senderPubkey?: string;

  /** Serialized received token JSON (before finalization) */
  receivedTokenJson?: string;

  /** Finalized token */
  finalizedToken?: unknown;
}

// =============================================================================
// Split Payment Session
// =============================================================================

/**
 * Split payment session for tracking token split transfers
 * Similar to PaymentSession but tracks the multi-phase split operation.
 */
export interface SplitPaymentSession {
  /** Unique session identifier */
  id: string;

  /** Direction (always 'SEND' for split operations) */
  direction: 'SEND';

  /** Source token ID being split */
  sourceTokenId: string;

  /** Payment amount (sent to recipient) */
  paymentAmount: string;

  /** Change amount (kept by sender) */
  changeAmount: string;

  /** Recipient's human-readable nametag */
  recipientNametag?: string;

  /** Recipient's Nostr public key */
  recipientPubkey?: string;

  /** Phase tracking for split operation */
  phases: {
    /** Burn phase status */
    burn: 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED';
    /** Mints phase status (parallel submission) */
    mints: 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'PARTIAL' | 'FAILED';
    /** Transfer phase status (INSTANT_SEND) */
    transfer: 'PENDING' | 'NOSTR_DELIVERED' | 'CONFIRMED' | 'FAILED';
  };

  /** Timing information for performance tracking */
  timing: {
    burnStartedAt?: number;
    burnConfirmedAt?: number;
    mintsStartedAt?: number;
    mintsConfirmedAt?: number;
    nostrDeliveredAt?: number;
    completedAt?: number;
  };

  /** Payment token ID (after mint) */
  paymentTokenId?: string;

  /** Change token ID (after mint) */
  changeTokenId?: string;

  /** Split group ID (links all outbox entries) */
  splitGroupId?: string;

  /** Creation timestamp */
  createdAt: number;

  /** Last update timestamp */
  updatedAt: number;

  /** Error details if failed */
  error?: PaymentSessionError;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Create a new payment session
 */
export function createPaymentSession(params: {
  direction: PaymentSessionDirection;
  sourceTokenId?: string;
  recipientNametag?: string;
  recipientPubkey?: string;
  amount?: string;
  coinId?: string;
  salt?: string;
  deadlineMs?: number;
}): PaymentSession {
  const now = Date.now();
  const deadlineMs = params.deadlineMs ?? 300_000; // 5 minutes default

  return {
    id: generateSessionId(),
    direction: params.direction,
    status: 'INITIATED',
    createdAt: now,
    updatedAt: now,
    deadline: now + deadlineMs,
    error: null,
    sourceTokenId: params.sourceTokenId,
    recipientNametag: params.recipientNametag,
    recipientPubkey: params.recipientPubkey,
    amount: params.amount,
    coinId: params.coinId,
    salt: params.salt,
  };
}

/**
 * Create a new split payment session
 */
export function createSplitPaymentSession(params: {
  sourceTokenId: string;
  paymentAmount: string;
  changeAmount: string;
  recipientNametag?: string;
  recipientPubkey?: string;
  splitGroupId?: string;
}): SplitPaymentSession {
  const now = Date.now();

  return {
    id: generateSessionId(),
    direction: 'SEND',
    sourceTokenId: params.sourceTokenId,
    paymentAmount: params.paymentAmount,
    changeAmount: params.changeAmount,
    recipientNametag: params.recipientNametag,
    recipientPubkey: params.recipientPubkey,
    splitGroupId: params.splitGroupId ?? generateSessionId(),
    phases: {
      burn: 'PENDING',
      mints: 'PENDING',
      transfer: 'PENDING',
    },
    timing: {},
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Check if a payment session has timed out
 */
export function isPaymentSessionTimedOut(session: PaymentSession): boolean {
  if (!session.deadline) return false;
  return Date.now() > session.deadline;
}

/**
 * Check if a payment session is in a terminal state
 */
export function isPaymentSessionTerminal(session: PaymentSession): boolean {
  return (
    session.status === 'COMPLETED' ||
    session.status === 'FAILED' ||
    session.status === 'TIMED_OUT'
  );
}

/**
 * Create a payment session error
 */
export function createPaymentSessionError(
  code: PaymentSessionErrorCode,
  message: string,
  recoverable = false,
  details?: Record<string, unknown>
): PaymentSessionError {
  return {
    code,
    message,
    timestamp: Date.now(),
    recoverable,
    details,
  };
}

/**
 * Update a payment session status
 */
export function updatePaymentSession<T extends PaymentSession | SplitPaymentSession>(
  session: T,
  updates: Partial<T>
): T {
  return {
    ...session,
    ...updates,
    updatedAt: Date.now(),
  };
}

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
  // Use crypto.randomUUID if available, otherwise fallback
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  // Fallback: generate a UUID-like string
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
