/**
 * Instant Split Types
 *
 * Types for INSTANT_SPLIT V5 payment bundles and processing.
 *
 * INSTANT_SPLIT V5 achieves ~2.3s sender latency by:
 * 1. Create burn commitment, submit to aggregator
 * 2. Wait for burn inclusion proof (~2s - unavoidable for SplitMintReason)
 * 3. Create mint commitments with proper SplitMintReason (requires burn proof)
 * 4. Create transfer commitment from mint data (no mint proof needed!)
 * 5. Package bundle → send via Nostr → SUCCESS (~2.3s total!)
 * 6. Background: submit mints, wait for proofs, save change token, sync IPFS
 */

// =============================================================================
// INSTANT_SPLIT V5 Bundle (Production Mode)
// =============================================================================

/**
 * Bundle payload for INSTANT_SPLIT V5 (Production Mode)
 *
 * V5 achieves ~2.3s sender latency while working with production aggregators.
 * The burn transaction includes a proof, enabling SDK to create proper SplitMintReason.
 *
 * Security: Burn is proven on-chain before mints can be created, preventing double-spend.
 */
export interface InstantSplitBundleV5 {
  /** Bundle version - V5 is production mode (proper SplitMintReason) */
  version: '5.0';

  /** Bundle type identifier */
  type: 'INSTANT_SPLIT';

  /**
   * Burn TRANSACTION JSON (WITH inclusion proof!)
   * V5 sends the proven burn transaction so recipient can verify burn completed.
   */
  burnTransaction: string;

  /**
   * Recipient's MintTransactionData JSON (contains proper SplitMintReason in V5)
   * The SplitMintReason references the burn transaction.
   */
  recipientMintData: string;

  /**
   * Pre-created TransferCommitment JSON (recipient submits and waits for proof)
   * Created from mint data WITHOUT any proofs.
   */
  transferCommitment: string;

  /** Payment amount (display metadata) */
  amount: string;

  /** Coin ID hex */
  coinId: string;

  /** Token type hex */
  tokenTypeHex: string;

  /** Split group ID for recovery correlation */
  splitGroupId: string;

  /** Sender's pubkey for acknowledgment */
  senderPubkey: string;

  /** Salt for recipient predicate creation (hex) */
  recipientSaltHex: string;

  /** Salt for transfer commitment creation (hex) */
  transferSaltHex: string;

  /**
   * Serialized TokenState JSON for the intermediate minted token.
   *
   * In V5, the mint is to sender's address first, then transferred to recipient.
   * The recipient needs this state to reconstruct the minted token before applying transfer.
   * Without this, the recipient can't create a matching predicate (they don't have sender's signing key).
   */
  mintedTokenStateJson: string;

  /**
   * Serialized TokenState JSON for the final recipient state (after transfer).
   *
   * The sender creates the transfer commitment targeting the recipient's PROXY address.
   * The recipient can't recreate this state correctly because their signingService
   * creates predicates for their DIRECT address, not the PROXY address.
   * We include the expected final state so the recipient can use it directly.
   */
  finalRecipientStateJson: string;

  /**
   * Serialized recipient address JSON (PROXY or DIRECT).
   *
   * Used by the recipient to identify which nametag token is being targeted.
   * For PROXY address transfers, the recipient needs to find the matching
   * nametag token and pass it to finalizeTransaction() for verification.
   */
  recipientAddressJson: string;
}

// =============================================================================
// INSTANT_SPLIT V4 Bundle (Dev Mode Only - for reference)
// =============================================================================

/**
 * Bundle payload for INSTANT_SPLIT V4 (Dev Mode Only)
 *
 * V4 achieves near-zero sender latency (~0.3s) but only works with dev aggregators
 * that don't validate SplitMintReason content.
 *
 * @deprecated Use InstantSplitBundleV5 for production
 */
export interface InstantSplitBundleV4 {
  /** Bundle version - V4 is dev mode only */
  version: '4.0';

  /** Bundle type identifier */
  type: 'INSTANT_SPLIT';

  /**
   * Burn commitment JSON (NOT transaction - no proof yet!)
   * Both sender and recipient submit this to aggregator.
   */
  burnCommitment: string;

  /** Recipient's MintTransactionData JSON */
  recipientMintData: string;

  /** Pre-created TransferCommitment JSON */
  transferCommitment: string;

  /** Payment amount */
  amount: string;

  /** Coin ID hex */
  coinId: string;

  /** Token type hex */
  tokenTypeHex: string;

  /** Split group ID for recovery */
  splitGroupId: string;

  /** Sender's pubkey */
  senderPubkey: string;

  /** Salt for recipient predicate (hex) */
  recipientSaltHex: string;

  /** Salt for transfer commitment (hex) */
  transferSaltHex: string;
}

/**
 * Union type for all InstantSplit bundle versions
 */
export type InstantSplitBundle = InstantSplitBundleV4 | InstantSplitBundleV5;

// =============================================================================
// Instant Split Result Types
// =============================================================================

/**
 * Result of an instant split operation (sender side)
 */
export interface InstantSplitResult {
  /** Whether the operation succeeded (Nostr delivery) */
  success: boolean;

  /** Session ID for tracking */
  sessionId: string;

  /** Split group ID for recovery correlation */
  splitGroupId: string;

  /** Nostr event ID (if delivered) */
  nostrEventId?: string;

  /** Time taken for critical path in ms */
  criticalPathDurationMs: number;

  /** Whether background processing started */
  backgroundStarted: boolean;

  /** Error message (if failed) */
  error?: string;
}

/**
 * Result of processing a received InstantSplit bundle (recipient side)
 */
export interface InstantSplitProcessResult {
  /** Whether processing succeeded */
  success: boolean;

  /** The finalized token (if successful) */
  token?: unknown; // SDK Token type

  /** Error message (if failed) */
  error?: string;

  /** Processing duration in ms */
  durationMs: number;

  /** Whether token is immediately usable (before full finalization) */
  immediatelyUsable?: boolean;
}

// =============================================================================
// Instant Split Options
// =============================================================================

/**
 * Options for instant split execution
 */
export interface InstantSplitOptions {
  /** Enable instant mode (default: true) */
  instant?: boolean;

  /** Timeout for Nostr delivery confirmation in ms (default: 30000) */
  nostrTimeoutMs?: number;

  /** Skip background aggregator submission (for testing) */
  skipBackgroundAggregator?: boolean;

  /** Skip background IPFS sync (for testing) */
  skipBackgroundIpfs?: boolean;

  /** Callback for progress updates */
  onProgress?: (progress: InstantSplitProgress) => void;
}

/**
 * Progress update during instant split
 */
export interface InstantSplitProgress {
  /** Current stage */
  stage: InstantSplitStage;

  /** Progress message */
  message: string;

  /** Timestamp */
  timestamp: number;

  /** Optional metadata */
  data?: Record<string, unknown>;
}

/**
 * Stages of instant split processing
 */
export type InstantSplitStage =
  | 'INITIATED'
  | 'BURN_SUBMITTED'
  | 'BURN_PROOF_RECEIVED'
  | 'MINTS_CREATED'
  | 'TRANSFER_CREATED'
  | 'BUNDLE_PACKAGED'
  | 'NOSTR_SENDING'
  | 'NOSTR_DELIVERED'
  | 'BACKGROUND_STARTED'
  | 'BACKGROUND_MINTS_SUBMITTED'
  | 'BACKGROUND_PROOFS_RECEIVED'
  | 'CHANGE_TOKEN_SAVED'
  | 'COMPLETED'
  | 'FAILED';

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Type guard to check if an object is an InstantSplitBundle (V4 or V5)
 */
export function isInstantSplitBundle(obj: unknown): obj is InstantSplitBundle {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }

  const bundle = obj as Record<string, unknown>;

  // Check common fields
  if (bundle.type !== 'INSTANT_SPLIT') return false;
  if (typeof bundle.recipientMintData !== 'string') return false;
  if (typeof bundle.transferCommitment !== 'string') return false;
  if (typeof bundle.amount !== 'string') return false;
  if (typeof bundle.coinId !== 'string') return false;
  if (typeof bundle.splitGroupId !== 'string') return false;
  if (typeof bundle.senderPubkey !== 'string') return false;
  if (typeof bundle.recipientSaltHex !== 'string') return false;
  if (typeof bundle.transferSaltHex !== 'string') return false;

  // Version-specific checks
  if (bundle.version === '4.0') {
    return typeof bundle.burnCommitment === 'string';
  } else if (bundle.version === '5.0') {
    return (
      typeof bundle.burnTransaction === 'string' &&
      typeof bundle.mintedTokenStateJson === 'string' &&
      typeof bundle.finalRecipientStateJson === 'string' &&
      typeof bundle.recipientAddressJson === 'string'
    );
  }

  return false;
}

/**
 * Type guard to check if bundle is V4 (dev mode)
 */
export function isInstantSplitBundleV4(obj: unknown): obj is InstantSplitBundleV4 {
  return isInstantSplitBundle(obj) && obj.version === '4.0';
}

/**
 * Type guard to check if bundle is V5 (production mode)
 */
export function isInstantSplitBundleV5(obj: unknown): obj is InstantSplitBundleV5 {
  return isInstantSplitBundle(obj) && obj.version === '5.0';
}

// =============================================================================
// Background Commitment Types
// =============================================================================

/**
 * Status of a background commitment submission
 */
export type BackgroundCommitmentStatus =
  | 'PENDING'
  | 'SUBMITTED'
  | 'PROOF_RECEIVED'
  | 'COMPLETED'
  | 'FAILED';

/**
 * Entry tracking a background commitment
 */
export interface BackgroundCommitmentEntry {
  /** Unique entry ID */
  id: string;

  /** Commitment type */
  type: 'MINT' | 'TRANSFER';

  /** Serialized commitment JSON */
  commitmentJson: string;

  /** Current status */
  status: BackgroundCommitmentStatus;

  /** Associated split group ID */
  splitGroupId: string;

  /** Created timestamp */
  createdAt: number;

  /** Updated timestamp */
  updatedAt: number;

  /** Inclusion proof JSON (when received) */
  inclusionProofJson?: string;

  /** Error message (if failed) */
  error?: string;
}

/**
 * Callbacks for background commitment processing
 */
export interface BackgroundCommitmentCallbacks {
  /** Called when commitment is submitted */
  onSubmitted?: (entry: BackgroundCommitmentEntry) => void;

  /** Called when proof is received */
  onProofReceived?: (entry: BackgroundCommitmentEntry, proof: unknown) => void;

  /** Called on error */
  onError?: (entry: BackgroundCommitmentEntry, error: Error) => void;

  /** Called when all background work completes */
  onAllComplete?: (entries: BackgroundCommitmentEntry[]) => void;
}
