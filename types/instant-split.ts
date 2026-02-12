/**
 * INSTANT_SPLIT V5 Types
 *
 * Optimized token split transfer types that achieve ~2.3s critical path latency
 * instead of the standard ~42s sequential flow.
 *
 * Key Insight: TransferCommitment.create() only needs token.state, NOT the mint proof.
 * This allows creating transfer commitments immediately after mint data creation,
 * without waiting for mint proofs.
 *
 * V5 Flow (Production Mode):
 * 1. Create burn commitment, submit to aggregator
 * 2. Wait for burn inclusion proof (~2s - unavoidable)
 * 3. Create mint commitments with proper SplitMintReason (requires burn proof)
 * 4. Create transfer commitment from mint data (no mint proof needed)
 * 5. Package bundle -> send via Nostr -> SUCCESS (~2.3s total!)
 * 6. Background: submit mints, wait for proofs, save change token, sync storage
 */

// Note: Token type is generic - we use 'any' to avoid import complexity
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SdkToken = any;

// =============================================================================
// INSTANT_SPLIT V5 Bundle Types
// =============================================================================

/**
 * Bundle payload for INSTANT_SPLIT V5 (Production Mode)
 *
 * V5 achieves ~2.3s sender latency while working with production aggregators:
 * - Burn proof is required for creating SplitMintReason
 * - Transfer commitment is created from mint data WITHOUT waiting for mint proof
 * - Mints are submitted in background after Nostr delivery
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
   * This is optional - recipient can create their own if they have the correct address.
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

  /**
   * Serialized nametag token JSON (for PROXY address transfers).
   *
   * For PROXY address transfers, the sender includes the nametag token
   * so the recipient can verify they're authorized to receive at this address.
   * This is REQUIRED for PROXY addresses - transfers without this will fail.
   */
  nametagTokenJson?: string;
}

// =============================================================================
// INSTANT_SPLIT V4 Bundle Types (Dev Mode Only)
// =============================================================================

/**
 * Bundle payload for INSTANT_SPLIT V4 (Dev Mode Only - True Nostr-First Split)
 *
 * V4 achieves near-zero sender latency (~0.3s) by:
 * 1. Creating ALL commitments locally BEFORE any aggregator submission
 * 2. Persisting via Nostr FIRST
 * 3. Then submitting ALL to aggregator in background
 *
 * NOTE: V4 only works in dev mode. Production requires V5 with proper SplitMintReason.
 */
export interface InstantSplitBundleV4 {
  /** Bundle version - V4 is true Nostr-first (dev mode only) */
  version: '4.0';

  /** Bundle type identifier */
  type: 'INSTANT_SPLIT';

  /**
   * Burn commitment JSON (NOT transaction - no proof yet!)
   * Both sender and recipient submit this to aggregator.
   */
  burnCommitment: string;

  /** Recipient's MintTransactionData JSON (they recreate commitment and submit) */
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
}

/** Union type for all InstantSplit bundle versions */
export type InstantSplitBundle = InstantSplitBundleV4 | InstantSplitBundleV5;

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
    // V4 has burnCommitment (no proof)
    return typeof bundle.burnCommitment === 'string';
  } else if (bundle.version === '5.0') {
    // V5 has burnTransaction (with proof), mintedTokenStateJson, finalRecipientStateJson, and recipientAddressJson
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
// Result Types
// =============================================================================

/**
 * Result of an instant split send operation
 */
export interface InstantSplitResult {
  /** Whether the operation succeeded (Nostr delivery) */
  success: boolean;

  /** Nostr event ID (if delivered) */
  nostrEventId?: string;

  /** Split group ID for recovery correlation */
  splitGroupId?: string;

  /** Time taken for critical path (Nostr delivery) in ms */
  criticalPathDurationMs: number;

  /** Error message (if failed) */
  error?: string;

  /** Whether background processing was started */
  backgroundStarted?: boolean;

  /** Promise that resolves when background processing completes (change token saved) */
  backgroundPromise?: Promise<void>;
}

/**
 * Result from processing an INSTANT_SPLIT bundle (recipient side)
 */
export interface InstantSplitProcessResult {
  /** Whether processing succeeded */
  success: boolean;

  /** The finalized SDK token (if successful) */
  token?: SdkToken;

  /** Error message (if failed) */
  error?: string;

  /** Processing duration in ms */
  durationMs: number;
}

// =============================================================================
// Options Types
// =============================================================================

/**
 * Options for instant split send operation
 */
export interface InstantSplitOptions {
  /** Timeout for Nostr delivery in ms (default: 30000) */
  nostrTimeoutMs?: number;

  /** Timeout for burn proof wait in ms (default: 60000) */
  burnProofTimeoutMs?: number;

  /** Timeout for mint proof wait in ms (default: 60000) */
  mintProofTimeoutMs?: number;

  /** Skip background processing (for testing) */
  skipBackground?: boolean;

  /** Use dev mode (V4 flow without SplitMintReason validation) */
  devMode?: boolean;

  /** Callback when burn is completed */
  onBurnCompleted?: (burnTxJson: string) => void;

  /** Callback when Nostr delivery is completed */
  onNostrDelivered?: (eventId: string) => void;

  /** Callback for background progress updates */
  onBackgroundProgress?: (status: BackgroundProgressStatus) => void;

  /** Callback when change token is created (background) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onChangeTokenCreated?: (token: any) => Promise<void>;

  /** Callback to trigger storage sync (background) */
  onStorageSync?: () => Promise<boolean>;
}

/**
 * Background processing status
 */
export interface BackgroundProgressStatus {
  stage:
    | 'MINTS_SUBMITTED'
    | 'MINTS_PROVEN'
    | 'CHANGE_TOKEN_SAVED'
    | 'STORAGE_SYNCED'
    | 'COMPLETED'
    | 'FAILED';
  message: string;
  error?: string;
}

// =============================================================================
// Recovery Types
// =============================================================================

/**
 * Metadata for V5 recovery (stored with outbox entry)
 */
export interface InstantSplitV5RecoveryMetadata {
  version: '5.0';
  seedString: string;
  senderTokenIdHex: string;
  senderSaltHex: string;
  changeAmount: string;
  burnRequestIdHex: string;
}

/**
 * Result of recovering an orphaned split
 */
export interface SplitRecoveryResult {
  /** Number of splits successfully recovered */
  splitsRecovered: number;

  /** Number of change tokens recovered */
  changeTokensRecovered: number;

  /** Errors encountered during recovery */
  errors: Array<{
    splitGroupId: string;
    error: string;
    timestamp: number;
  }>;

  /** Total duration of recovery in ms */
  durationMs: number;
}

// =============================================================================
// Pending Finalization Types (Lazy Proof Resolution)
// =============================================================================

/** Finalization stage for V5 bundles saved as unconfirmed */
export type V5FinalizationStage =
  | 'RECEIVED'
  | 'MINT_SUBMITTED'
  | 'MINT_PROVEN'
  | 'TRANSFER_SUBMITTED'
  | 'FINALIZED';

/** Pending finalization metadata stored in token.sdkData */
export interface PendingV5Finalization {
  type: 'v5_bundle';
  stage: V5FinalizationStage;
  bundleJson: string;
  senderPubkey: string;
  savedAt: number;
  lastAttemptAt?: number;
  attemptCount: number;
  mintProofJson?: string;
}

/** Result of resolveUnconfirmed() */
export interface UnconfirmedResolutionResult {
  resolved: number;
  stillPending: number;
  failed: number;
  details: Array<{
    tokenId: string;
    stage: string;
    status: 'resolved' | 'pending' | 'failed';
  }>;
}
