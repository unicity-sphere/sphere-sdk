/**
 * Oracle Provider Interface
 * Platform-independent Unicity oracle abstraction
 *
 * The oracle is a trusted third-party service that provides verifiable truth
 * about the state of tokens in the Unicity network. It aggregates state
 * transitions into rounds and provides inclusion proofs that cryptographically
 * verify token ownership and transfers.
 */

import type { BaseProvider } from '../types';

// =============================================================================
// Oracle Provider Interface
// =============================================================================

/**
 * Unicity state transition oracle provider
 *
 * The oracle serves as the source of truth for:
 * - Token state validation (spent/unspent)
 * - State transition inclusion proofs
 * - Round-based commitment aggregation
 */
export interface OracleProvider extends BaseProvider {
  /**
   * Initialize with trust base
   */
  initialize(trustBase?: unknown): Promise<void>;

  /**
   * Submit transfer commitment
   */
  submitCommitment(commitment: TransferCommitment): Promise<SubmitResult>;

  /**
   * Get inclusion proof for a request
   */
  getProof(requestId: string): Promise<InclusionProof | null>;

  /**
   * Wait for inclusion proof with polling
   */
  waitForProof(requestId: string, options?: WaitOptions): Promise<InclusionProof>;

  /**
   * Validate token against aggregator
   */
  validateToken(tokenData: unknown): Promise<ValidationResult>;

  /**
   * Check if token state is spent
   */
  isSpent(stateHash: string): Promise<boolean>;

  /**
   * Get token state
   */
  getTokenState(tokenId: string): Promise<TokenState | null>;

  /**
   * Get current round number
   */
  getCurrentRound(): Promise<number>;

  /**
   * Mint new tokens (for faucet/testing)
   */
  mint?(params: MintParams): Promise<MintResult>;

  /**
   * Get underlying StateTransitionClient (if available)
   * Used for advanced SDK operations like commitment creation
   */
  getStateTransitionClient?(): unknown;

  /**
   * Get underlying AggregatorClient (if available)
   * Used for direct aggregator API access
   */
  getAggregatorClient?(): unknown;

  /**
   * Wait for inclusion proof using SDK commitment (if available)
   * Used for transfer flows with SDK TransferCommitment
   */
  waitForProofSdk?(commitment: unknown, signal?: AbortSignal): Promise<unknown>;
}

// =============================================================================
// Commitment Types
// =============================================================================

export interface TransferCommitment {
  /** Source token (SDK format) */
  sourceToken: unknown;
  /** Recipient address/predicate */
  recipient: string;
  /** Random salt (non-reproducible) */
  salt: Uint8Array;
  /** Optional additional data */
  data?: unknown;
}

export interface SubmitResult {
  success: boolean;
  requestId?: string;
  error?: string;
  timestamp: number;
}

// =============================================================================
// Proof Types
// =============================================================================

export interface InclusionProof {
  requestId: string;
  roundNumber: number;
  proof: unknown;
  timestamp: number;
}

export interface WaitOptions {
  /** Timeout in ms (default: 30000) */
  timeout?: number;
  /** Poll interval in ms (default: 1000) */
  pollInterval?: number;
  /** Callback on each poll attempt */
  onPoll?: (attempt: number) => void;
}

// =============================================================================
// Validation Types
// =============================================================================

export interface ValidationResult {
  valid: boolean;
  spent: boolean;
  error?: string;
  stateHash?: string;
}

export interface TokenState {
  tokenId: string;
  stateHash: string;
  spent: boolean;
  roundNumber?: number;
  lastUpdated: number;
}

// =============================================================================
// Mint Types
// =============================================================================

export interface MintParams {
  coinId: string;
  amount: string;
  recipientAddress: string;
  recipientPubkey?: string;
}

export interface MintResult {
  success: boolean;
  requestId?: string;
  tokenId?: string;
  error?: string;
}

// =============================================================================
// Oracle Events
// =============================================================================

export type OracleEventType =
  | 'oracle:connected'
  | 'oracle:disconnected'
  | 'oracle:error'
  | 'commitment:submitted'
  | 'proof:received'
  | 'validation:completed';

export interface OracleEvent {
  type: OracleEventType;
  timestamp: number;
  data?: unknown;
  error?: string;
}

export type OracleEventCallback = (event: OracleEvent) => void;

// =============================================================================
// Trust Base Loader
// =============================================================================

/**
 * Trust base loader interface for platform-specific loading
 * Browser: fetch from URL
 * Node.js: read from file
 */
export interface TrustBaseLoader {
  /**
   * Load trust base JSON data
   * @returns Trust base data or null if not available
   */
  load(): Promise<unknown | null>;
}

// =============================================================================
// Provider Factory Type
// =============================================================================

export type OracleProviderFactory<TConfig, TProvider extends OracleProvider> = (
  config: TConfig
) => TProvider;

// =============================================================================
// Backward Compatibility Aliases
// =============================================================================

/** @deprecated Use OracleProvider instead */
export type AggregatorProvider = OracleProvider;
/** @deprecated Use OracleEventType instead */
export type AggregatorEventType = OracleEventType;
/** @deprecated Use OracleEvent instead */
export type AggregatorEvent = OracleEvent;
/** @deprecated Use OracleEventCallback instead */
export type AggregatorEventCallback = OracleEventCallback;
