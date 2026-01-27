/**
 * Unicity Aggregator Provider
 * Platform-independent implementation using @unicitylabs/state-transition-sdk
 *
 * The oracle is a trusted service that provides verifiable truth
 * about token state through cryptographic inclusion proofs.
 *
 * TrustBaseLoader is injected for platform-specific loading:
 * - Browser: fetch from URL
 * - Node.js: read from file
 */

import type { ProviderStatus } from '../types';
import type {
  OracleProvider,
  TransferCommitment,
  SubmitResult,
  InclusionProof,
  WaitOptions,
  ValidationResult,
  TokenState,
  MintParams,
  MintResult,
  OracleEvent,
  OracleEventCallback,
  TrustBaseLoader,
} from './oracle-provider';
import { DEFAULT_AGGREGATOR_TIMEOUT, TIMEOUTS } from '../constants';

// SDK imports - using direct imports from the SDK
import { StateTransitionClient } from '@unicitylabs/state-transition-sdk/lib/StateTransitionClient';
import { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient';
import { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase';
import { Token as SdkToken } from '@unicitylabs/state-transition-sdk/lib/token/Token';
import { waitInclusionProof } from '@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils';
import type { TransferCommitment as SdkTransferCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment';

// SDK MintCommitment type - using interface to avoid generic complexity
interface SdkMintCommitment {
  requestId?: { toString(): string };
  [key: string]: unknown;
}

// =============================================================================
// Configuration
// =============================================================================

export interface UnicityAggregatorProviderConfig {
  /** Aggregator URL */
  url: string;
  /** Request timeout (ms) */
  timeout?: number;
  /** Skip trust base verification (dev only) */
  skipVerification?: boolean;
  /** Enable debug logging */
  debug?: boolean;
  /** Trust base loader (platform-specific) */
  trustBaseLoader?: TrustBaseLoader;
}

// =============================================================================
// RPC Response Types
// =============================================================================

interface RpcSubmitResponse {
  requestId?: string;
}

interface RpcProofResponse {
  proof?: unknown;
  roundNumber?: number;
}

interface RpcValidateResponse {
  valid?: boolean;
  spent?: boolean;
  stateHash?: string;
  error?: string;
}

interface RpcSpentResponse {
  spent?: boolean;
}

interface RpcTokenStateResponse {
  state?: {
    stateHash?: string;
    spent?: boolean;
    roundNumber?: number;
  };
}

interface RpcRoundResponse {
  round?: number;
  roundNumber?: number;
}

interface RpcMintResponse {
  requestId?: string;
  tokenId?: string;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Unicity Aggregator Provider
 * Concrete implementation of OracleProvider using Unicity's aggregator service
 */
export class UnicityAggregatorProvider implements OracleProvider {
  readonly id = 'unicity-aggregator';
  readonly name = 'Unicity Aggregator';
  readonly type = 'network' as const;
  readonly description = 'Unicity state transition aggregator (oracle implementation)';

  private config: Required<Omit<UnicityAggregatorProviderConfig, 'trustBaseLoader'>> & {
    trustBaseLoader?: TrustBaseLoader;
  };
  private status: ProviderStatus = 'disconnected';
  private eventCallbacks: Set<OracleEventCallback> = new Set();

  // SDK clients
  private aggregatorClient: AggregatorClient | null = null;
  private stateTransitionClient: StateTransitionClient | null = null;
  private trustBase: RootTrustBase | null = null;

  /** Get the current trust base */
  getTrustBase(): RootTrustBase | null {
    return this.trustBase;
  }

  /** Get the state transition client */
  getStateTransitionClient(): StateTransitionClient | null {
    return this.stateTransitionClient;
  }

  /** Get the aggregator client */
  getAggregatorClient(): AggregatorClient | null {
    return this.aggregatorClient;
  }

  // Cache for spent states (immutable)
  private spentCache: Map<string, boolean> = new Map();

  constructor(config: UnicityAggregatorProviderConfig) {
    this.config = {
      url: config.url,
      timeout: config.timeout ?? DEFAULT_AGGREGATOR_TIMEOUT,
      skipVerification: config.skipVerification ?? false,
      debug: config.debug ?? false,
      trustBaseLoader: config.trustBaseLoader,
    };
  }

  // ===========================================================================
  // BaseProvider Implementation
  // ===========================================================================

  async connect(): Promise<void> {
    if (this.status === 'connected') return;

    this.status = 'connecting';

    try {
      // Test connection
      await this.getCurrentRound();
      this.status = 'connected';
      this.emitEvent({ type: 'oracle:connected', timestamp: Date.now() });
      this.log('Connected to oracle:', this.config.url);
    } catch (error) {
      this.status = 'error';
      throw new Error(`Oracle connection failed: ${error}`);
    }
  }

  async disconnect(): Promise<void> {
    this.status = 'disconnected';
    this.emitEvent({ type: 'oracle:disconnected', timestamp: Date.now() });
    this.log('Disconnected from oracle');
  }

  isConnected(): boolean {
    return this.status === 'connected';
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  // ===========================================================================
  // OracleProvider Implementation
  // ===========================================================================

  async initialize(trustBase?: RootTrustBase): Promise<void> {
    // Initialize SDK clients
    this.aggregatorClient = new AggregatorClient(this.config.url);
    this.stateTransitionClient = new StateTransitionClient(this.aggregatorClient);

    if (trustBase) {
      this.trustBase = trustBase;
    } else if (!this.config.skipVerification && this.config.trustBaseLoader) {
      // Load trust base using injected loader
      try {
        const trustBaseJson = await this.config.trustBaseLoader.load();
        if (trustBaseJson) {
          this.trustBase = RootTrustBase.fromJSON(trustBaseJson);
        }
      } catch (error) {
        this.log('Failed to load trust base:', error);
      }
    }

    await this.connect();
    this.log('Initialized with trust base:', !!this.trustBase);
  }

  /**
   * Submit a transfer commitment to the aggregator.
   * Accepts either an SDK TransferCommitment or a simple commitment object.
   */
  async submitCommitment(commitment: TransferCommitment | SdkTransferCommitment): Promise<SubmitResult> {
    this.ensureConnected();

    try {
      let requestId: string;

      // Check if it's an SDK commitment (has submitTransferCommitment method signature)
      if (this.isSdkTransferCommitment(commitment)) {
        // Use SDK client directly
        const response = await this.stateTransitionClient!.submitTransferCommitment(commitment);
        requestId = commitment.requestId?.toString() ?? response.status;
      } else {
        // Fallback to RPC for simple commitment objects
        const response = await this.rpcCall<RpcSubmitResponse>('submitCommitment', {
          sourceToken: commitment.sourceToken,
          recipient: commitment.recipient,
          salt: Array.from(commitment.salt),
          data: commitment.data,
        });
        requestId = response.requestId ?? '';
      }

      this.emitEvent({
        type: 'commitment:submitted',
        timestamp: Date.now(),
        data: { requestId },
      });

      return {
        success: true,
        requestId,
        timestamp: Date.now(),
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errorMsg,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Submit a mint commitment to the aggregator (SDK only)
   * @param commitment - SDK MintCommitment instance
   */
  async submitMintCommitment(commitment: SdkMintCommitment): Promise<SubmitResult> {
    this.ensureConnected();

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await this.stateTransitionClient!.submitMintCommitment(commitment as any);
      const requestId = commitment.requestId?.toString() ?? response.status;

      this.emitEvent({
        type: 'commitment:submitted',
        timestamp: Date.now(),
        data: { requestId },
      });

      return {
        success: true,
        requestId,
        timestamp: Date.now(),
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errorMsg,
        timestamp: Date.now(),
      };
    }
  }

  private isSdkTransferCommitment(commitment: unknown): commitment is SdkTransferCommitment {
    return (
      commitment !== null &&
      typeof commitment === 'object' &&
      'requestId' in commitment &&
      typeof (commitment as SdkTransferCommitment).requestId?.toString === 'function'
    );
  }

  async getProof(requestId: string): Promise<InclusionProof | null> {
    this.ensureConnected();

    try {
      const response = await this.rpcCall<RpcProofResponse>('getInclusionProof', { requestId });

      if (!response.proof) {
        return null;
      }

      return {
        requestId,
        roundNumber: response.roundNumber ?? 0,
        proof: response.proof,
        timestamp: Date.now(),
      };
    } catch {
      return null;
    }
  }

  async waitForProof(requestId: string, options?: WaitOptions): Promise<InclusionProof> {
    const timeout = options?.timeout ?? this.config.timeout;
    const pollInterval = options?.pollInterval ?? TIMEOUTS.PROOF_POLL_INTERVAL;
    const startTime = Date.now();
    let attempt = 0;

    while (Date.now() - startTime < timeout) {
      options?.onPoll?.(++attempt);

      const proof = await this.getProof(requestId);
      if (proof) {
        this.emitEvent({
          type: 'proof:received',
          timestamp: Date.now(),
          data: { requestId, roundNumber: proof.roundNumber },
        });
        return proof;
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error(`Timeout waiting for proof: ${requestId}`);
  }

  async validateToken(tokenData: unknown): Promise<ValidationResult> {
    this.ensureConnected();

    try {
      // Try SDK validation first if we have trust base
      if (this.trustBase && !this.config.skipVerification) {
        try {
          const sdkToken = await SdkToken.fromJSON(tokenData);
          const verifyResult = await sdkToken.verify(this.trustBase);

          // Calculate state hash
          const stateHash = await sdkToken.state.calculateHash();
          const stateHashStr = stateHash.toJSON();

          const valid = verifyResult.isSuccessful;

          this.emitEvent({
            type: 'validation:completed',
            timestamp: Date.now(),
            data: { valid },
          });

          return {
            valid,
            spent: false, // Spend check is separate
            stateHash: stateHashStr,
            error: valid ? undefined : 'SDK verification failed',
          };
        } catch (sdkError) {
          this.log('SDK validation failed, falling back to RPC:', sdkError);
        }
      }

      // Fallback to RPC validation
      const response = await this.rpcCall<RpcValidateResponse>('validateToken', { token: tokenData });

      const valid = response.valid ?? false;
      const spent = response.spent ?? false;

      this.emitEvent({
        type: 'validation:completed',
        timestamp: Date.now(),
        data: { valid },
      });

      // Cache spent state if spent
      if (response.stateHash && spent) {
        this.spentCache.set(response.stateHash, true);
      }

      return {
        valid,
        spent,
        stateHash: response.stateHash,
        error: response.error,
      };
    } catch (error) {
      return {
        valid: false,
        spent: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Wait for inclusion proof using SDK (for SDK commitments)
   */
  async waitForProofSdk(
    commitment: SdkTransferCommitment | SdkMintCommitment,
    signal?: AbortSignal
  ): Promise<unknown> {
    this.ensureConnected();

    if (!this.trustBase) {
      throw new Error('Trust base not initialized');
    }

    return await waitInclusionProof(
      this.trustBase,
      this.stateTransitionClient!,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      commitment as any,
      signal
    );
  }

  async isSpent(stateHash: string): Promise<boolean> {
    // Check cache first (spent is immutable)
    if (this.spentCache.has(stateHash)) {
      return this.spentCache.get(stateHash)!;
    }

    this.ensureConnected();

    try {
      const response = await this.rpcCall<RpcSpentResponse>('isSpent', { stateHash });
      const spent = response.spent ?? false;

      // Cache result
      if (spent) {
        this.spentCache.set(stateHash, true);
      }

      return spent;
    } catch {
      return false;
    }
  }

  async getTokenState(tokenId: string): Promise<TokenState | null> {
    this.ensureConnected();

    try {
      const response = await this.rpcCall<RpcTokenStateResponse>('getTokenState', { tokenId });

      if (!response.state) {
        return null;
      }

      return {
        tokenId,
        stateHash: response.state.stateHash ?? '',
        spent: response.state.spent ?? false,
        roundNumber: response.state.roundNumber,
        lastUpdated: Date.now(),
      };
    } catch {
      return null;
    }
  }

  async getCurrentRound(): Promise<number> {
    const response = await this.rpcCall<RpcRoundResponse>('getCurrentRound', {});
    return response.round ?? response.roundNumber ?? 0;
  }

  async mint(params: MintParams): Promise<MintResult> {
    this.ensureConnected();

    try {
      const response = await this.rpcCall<RpcMintResponse>('mint', {
        coinId: params.coinId,
        amount: params.amount,
        recipientAddress: params.recipientAddress,
        recipientPubkey: params.recipientPubkey,
      });

      return {
        success: true,
        requestId: response.requestId,
        tokenId: response.tokenId,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ===========================================================================
  // Event Subscription
  // ===========================================================================

  onEvent(callback: OracleEventCallback): () => void {
    this.eventCallbacks.add(callback);
    return () => this.eventCallbacks.delete(callback);
  }

  // ===========================================================================
  // Private: RPC
  // ===========================================================================

  private async rpcCall<T>(method: string, params: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(this.config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method,
          params,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();

      if (result.error) {
        throw new Error(result.error.message ?? 'RPC error');
      }

      return (result.result ?? {}) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ===========================================================================
  // Private: Helpers
  // ===========================================================================

  private ensureConnected(): void {
    if (this.status !== 'connected') {
      throw new Error('UnicityAggregatorProvider not connected');
    }
  }

  private emitEvent(event: OracleEvent): void {
    for (const callback of this.eventCallbacks) {
      try {
        callback(event);
      } catch (error) {
        this.log('Event callback error:', error);
      }
    }
  }

  private log(...args: unknown[]): void {
    if (this.config.debug) {
      console.log('[UnicityAggregatorProvider]', ...args);
    }
  }
}

// =============================================================================
// Backward Compatibility Aliases (Oracle -> Aggregator)
// =============================================================================

/** @deprecated Use UnicityAggregatorProvider instead */
export const UnicityOracleProvider = UnicityAggregatorProvider;
/** @deprecated Use UnicityAggregatorProviderConfig instead */
export type UnicityOracleProviderConfig = UnicityAggregatorProviderConfig;
