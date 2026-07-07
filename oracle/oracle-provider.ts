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
   * Get inclusion proof for a request.
   *
   * Now backed by v2 AggregatorClient — see implementation. Retains the v1
   * `requestId` shape so callers still on v1-style polling loops keep working
   * while the send/receive path moves onto `ITokenEngine`.
   */
  getProof(requestId: string): Promise<InclusionProof | null>;

  /**
   * Wait for inclusion proof with polling
   */
  waitForProof(requestId: string, options?: WaitOptions): Promise<InclusionProof>;

  /**
   * Validate token against aggregator.
   *
   * Now backed by v2 RPC — SDK-side crypto verification moved to
   * `ITokenEngine.verify`. This method now performs only aggregator RPC
   * validation; callers wanting full crypto verification MUST use
   * `sphere.payments` / `ITokenEngine.verify` (wave 6-P2-4b routing).
   */
  validateToken(tokenData: unknown): Promise<ValidationResult>;

  /**
   * Check if a state has been spent by the owner identified by `publicKey`.
   *
   * Implemented via `get_inclusion_proof(requestId)` where
   * `requestId = RequestId.create(publicKey, stateHash)`. The aggregator
   * indexes commitments by requestId (= hash of pubkey+stateHash), so we
   * cannot ask "has anyone spent this state" without knowing whose
   * predicate guards it — for normal flows this is the wallet's own
   * `chainPubkey` because the wallet owns the state it's probing.
   *
   * Spent iff the returned inclusion proof carries a non-null
   * `transactionHash` (path-included). A path-non-inclusion proof
   * (`transactionHash: null`) means no commitment exists → unspent.
   *
   * **Issue #243 — historical broken contract**: the prior implementation
   * called a non-existent `isSpent` JSON-RPC method with a single
   * `stateHash` parameter. The canonical aggregator (`aggregator-go`)
   * never exposed that method; it returns HTTP 400 ("requests must
   * include either requestId or shardId") at the validation layer.
   * Callers (the spent-state rescan worker, orphan recovery) saw a
   * cascade of failures, bumped their per-token backoff counters, and
   * the noise blocked `manual-test-full-recovery.sh` at §C.2. The fix
   * threads `publicKey` through and uses the canonical inclusion-proof
   * RPC.
   *
   * **Throws on RPC failure** — implementations MUST NOT fail-open
   * (returning `false` on a network/transport error opens a double-
   * spend window). On any RPC / network failure the call MUST throw
   * (typically a `SphereError` with code `'AGGREGATOR_ERROR'`). The
   * boolean return value carries cryptographically-verified state
   * only:
   *   - `true`  — aggregator returned a path-inclusion proof.
   *   - `false` — aggregator returned a path-non-inclusion proof.
   *
   * Callers (notably the disposition-engine `[E]` hook) treat a
   * throw as STRUCTURAL_INVALID per §5.3 [A] and re-evaluate when a
   * later bundle arrives.
   *
   * @param publicKey Hex-encoded compressed secp256k1 owner pubkey
   *                  (66 chars, "02"/"03" prefix). For wallet-local
   *                  scans this is `Identity.chainPubkey`.
   * @param stateHash Hex-encoded state hash imprint (typically 68 chars
   *                  including the algorithm prefix; the SDK accepts the
   *                  canonical imprint form).
   */
  isSpent(publicKey: string, stateHash: string): Promise<boolean>;

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
   * Get the bundled RootTrustBase (if available).
   *
   * Pointer-layer (H6, SPEC §8.4.2) requires the shared trust base consumed
   * by L4/PaymentsModule to be reused rather than a parallel trust-base
   * provider — see PROFILE-AGGREGATOR-POINTER-SPEC.md §8.4.
   */
  getRootTrustBase?(): unknown;

  // Removed in wave 6-P2-4a (v1→v2 SDK migration):
  //   - submitCommitment: v1 unified into `submitCertificationRequest` on the v2
  //     `AggregatorClient`. Callers now route through `ITokenEngine.mint /
  //     transfer / split` (see `token-engine/`). Extension code still on the
  //     v1 alias may keep a local shim.
  //   - waitForProofSdk: v1-shape SDK polling helper; v2 uses
  //     `waitInclusionProof(client, trustBase, predicateVerifier, transaction,
  //     signal)` which takes a full transaction (not an opaque commitment) and
  //     is invoked internally by `ITokenEngine` operations. Callers no longer
  //     need to reach for the SDK path directly.
  //   - verifyInclusionProof: v2's `InclusionProofVerificationRule.verify(
  //     trustBase, predicateVerifier, inclusionProof, transaction)` requires the
  //     full `ITransaction`, which the UXF Rule-4 enrichment gate does not carry
  //     at that call-site. Enrichment gating now happens inside the token
  //     engine at proof-adoption time, not as a standalone probe. See
  //     `token-engine/split-checkpoint.ts` for the pattern.
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
