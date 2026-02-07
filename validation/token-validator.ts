/**
 * Token Validation Service for SDK2
 * Validates tokens against aggregator and fetches missing proofs
 *
 * Platform-independent implementation that accepts dependencies via constructor.
 */

import type { Token } from '../types';
import type { TxfTransaction, ValidationIssue, TokenValidationResult } from '../types/txf';
import { tokenToTxf } from '../serialization/txf-serializer';

// =============================================================================
// Types
// =============================================================================

export type ValidationAction = 'ACCEPT' | 'RETRY_LATER' | 'DISCARD_FORK';

export interface ExtendedValidationResult extends TokenValidationResult {
  action?: ValidationAction;
}

export interface SpentTokenInfo {
  tokenId: string;
  localId: string;
  stateHash: string;
}

export interface SpentTokenResult {
  spentTokens: SpentTokenInfo[];
  errors: string[];
}

export interface ValidationResult {
  validTokens: Token[];
  issues: ValidationIssue[];
}

/**
 * Aggregator client interface - must be provided by the platform
 */
export interface AggregatorClient {
  getInclusionProof(requestId: unknown): Promise<{
    inclusionProof?: {
      authenticator: unknown | null;
      merkleTreePath: {
        verify(key: bigint): Promise<{
          isPathValid: boolean;
          isPathIncluded: boolean;
        }>;
      };
    };
  }>;
  isTokenStateSpent?(trustBase: unknown, token: unknown, pubKey: Buffer): Promise<boolean>;
}

/**
 * Trust base loader interface
 */
export interface TrustBaseLoader {
  load(): Promise<unknown | null>;
}

// =============================================================================
// Token Validator
// =============================================================================

export class TokenValidator {
  private aggregatorClient: AggregatorClient | null = null;
  private trustBase: unknown | null = null;
  private skipVerification: boolean;

  // Cache for spent state verification
  private spentStateCache = new Map<string, {
    isSpent: boolean;
    timestamp: number;
  }>();
  private readonly UNSPENT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(options: {
    aggregatorClient?: AggregatorClient;
    trustBase?: unknown;
    skipVerification?: boolean;
  } = {}) {
    this.aggregatorClient = options.aggregatorClient || null;
    this.trustBase = options.trustBase || null;
    this.skipVerification = options.skipVerification || false;
  }

  /**
   * Set the aggregator client
   */
  setAggregatorClient(client: AggregatorClient): void {
    this.aggregatorClient = client;
  }

  /**
   * Set the trust base
   */
  setTrustBase(trustBase: unknown): void {
    this.trustBase = trustBase;
  }

  // =============================================================================
  // Public API
  // =============================================================================

  /**
   * Validate all tokens (parallel with batch limit)
   */
  async validateAllTokens(
    tokens: Token[],
    options?: { batchSize?: number; onProgress?: (completed: number, total: number) => void }
  ): Promise<ValidationResult> {
    const validTokens: Token[] = [];
    const issues: ValidationIssue[] = [];

    const batchSize = options?.batchSize ?? 5;
    const total = tokens.length;
    let completed = 0;

    for (let i = 0; i < tokens.length; i += batchSize) {
      const batch = tokens.slice(i, i + batchSize);

      const batchResults = await Promise.allSettled(
        batch.map(async (token) => {
          try {
            const result = await this.validateToken(token);
            return { token, result };
          } catch (err) {
            return {
              token,
              result: {
                isValid: false,
                reason: err instanceof Error ? err.message : String(err),
              } as TokenValidationResult,
            };
          }
        })
      );

      for (const settledResult of batchResults) {
        completed++;

        if (settledResult.status === 'fulfilled') {
          const { token, result } = settledResult.value;
          if (result.isValid) {
            validTokens.push(token);
          } else {
            issues.push({
              tokenId: token.id,
              reason: result.reason || 'Unknown validation error',
              recoverable: false,
            });
          }
        } else {
          issues.push({
            tokenId: batch[batchResults.indexOf(settledResult)]?.id || 'unknown',
            reason: String(settledResult.reason),
            recoverable: false,
          });
        }
      }

      if (options?.onProgress) {
        options.onProgress(completed, total);
      }
    }

    return { validTokens, issues };
  }

  /**
   * Validate a single token
   */
  async validateToken(token: Token): Promise<TokenValidationResult> {
    // Check if token has SDK data
    if (!token.sdkData) {
      return {
        isValid: false,
        reason: 'Token has no SDK data',
      };
    }

    let txfToken: unknown;
    try {
      txfToken = JSON.parse(token.sdkData);
    } catch {
      return {
        isValid: false,
        reason: 'Failed to parse token SDK data as JSON',
      };
    }

    // Check basic structure
    if (!this.hasValidTxfStructure(txfToken)) {
      return {
        isValid: false,
        reason: 'Token data missing required TXF fields (genesis, state)',
      };
    }

    // Check for uncommitted transactions
    const uncommitted = this.getUncommittedTransactions(txfToken);
    if (uncommitted.length > 0) {
      // Could try to fetch missing proofs from aggregator
      return {
        isValid: false,
        reason: `${uncommitted.length} uncommitted transaction(s)`,
      };
    }

    // Verify with SDK if trust base available and not skipping verification
    if (this.trustBase && !this.skipVerification) {
      try {
        const verificationResult = await this.verifyWithSdk(txfToken);
        if (!verificationResult.success) {
          return {
            isValid: false,
            reason: verificationResult.error || 'SDK verification failed',
          };
        }
      } catch (err) {
        // SDK verification is optional
        console.warn('SDK verification skipped:', err instanceof Error ? err.message : err);
      }
    }

    return { isValid: true };
  }

  /**
   * Check if a token state is spent on the aggregator
   */
  async isTokenStateSpent(
    tokenId: string,
    stateHash: string,
    publicKey: string
  ): Promise<boolean> {
    if (!this.aggregatorClient) {
      return false;
    }

    // Check cache first
    const cacheKey = `${tokenId}:${stateHash}:${publicKey}`;
    const cached = this.spentStateCache.get(cacheKey);
    if (cached !== undefined) {
      if (cached.isSpent) {
        return true; // SPENT is immutable
      }
      // UNSPENT expires after TTL
      if (Date.now() - cached.timestamp < this.UNSPENT_CACHE_TTL_MS) {
        return false;
      }
    }

    try {
      // Dynamic SDK imports
      const { RequestId } = await import(
        '@unicitylabs/state-transition-sdk/lib/api/RequestId'
      );
      const { DataHash } = await import(
        '@unicitylabs/state-transition-sdk/lib/hash/DataHash'
      );

      const pubKeyBytes = Buffer.from(publicKey, 'hex');
      const stateHashObj = DataHash.fromJSON(stateHash);
      const requestId = await RequestId.create(pubKeyBytes, stateHashObj);

      const response = await this.aggregatorClient.getInclusionProof(requestId);

      let isSpent = false;

      if (response.inclusionProof) {
        const proof = response.inclusionProof;
        const pathResult = await proof.merkleTreePath.verify(
          requestId.toBitString().toBigInt()
        );

        if (pathResult.isPathValid && pathResult.isPathIncluded && proof.authenticator !== null) {
          isSpent = true;
        }
      }

      // Cache result
      this.spentStateCache.set(cacheKey, {
        isSpent,
        timestamp: Date.now(),
      });

      return isSpent;
    } catch (err) {
      console.warn('Error checking token state:', err);
      return false;
    }
  }

  /**
   * Check which tokens are spent using SDK Token object to calculate state hash.
   *
   * Follows the same approach as the Sphere webgui TokenValidationService:
   * 1. Parse TXF using SDK's Token.fromJSON()
   * 2. Calculate CURRENT state hash via sdkToken.state.calculateHash()
   * 3. Create RequestId via RequestId.create(walletPubKey, calculatedHash)
   *
   * Uses wallet's own pubkey (not source state predicate key) because "spent" means
   * the CURRENT OWNER committed this state. Using the source state key would falsely
   * detect received tokens as "spent" (sender's commitment matches source state).
   */
  async checkSpentTokens(
    tokens: Token[],
    publicKey: string,
    options?: { batchSize?: number; onProgress?: (completed: number, total: number) => void }
  ): Promise<SpentTokenResult> {
    const spentTokens: SpentTokenInfo[] = [];
    const errors: string[] = [];

    if (!this.aggregatorClient) {
      errors.push('Aggregator client not available');
      return { spentTokens, errors };
    }

    const batchSize = options?.batchSize ?? 3;
    const total = tokens.length;
    let completed = 0;

    // Import SDK modules once
    const { Token: SdkToken } = await import(
      '@unicitylabs/state-transition-sdk/lib/token/Token'
    );
    const { RequestId } = await import(
      '@unicitylabs/state-transition-sdk/lib/api/RequestId'
    );

    const pubKeyBytes = Buffer.from(publicKey, 'hex');

    for (let i = 0; i < tokens.length; i += batchSize) {
      const batch = tokens.slice(i, i + batchSize);

      const batchResults = await Promise.allSettled(
        batch.map(async (token) => {
          try {
            const txf = tokenToTxf(token);
            if (!txf) {
              return { tokenId: token.id, localId: token.id, stateHash: '', spent: false, error: 'Invalid TXF' };
            }

            const tokenId = txf.genesis?.data?.tokenId || token.id;

            // Parse TXF into SDK Token object (like webgui does)
            const sdkToken = await SdkToken.fromJSON(txf);

            // Use SDK-calculated state hash + wallet's own public key for spent detection
            // (matching webgui TokenValidationService approach)
            //
            // Key insight: "spent" means the CURRENT OWNER has committed this state as input
            // for another transition. So we check:
            //   RequestId = hash(wallet_pubkey + current_state_hash)
            // If the aggregator has an inclusion proof → we spent this token
            // If exclusion proof → token is still ours (unspent)
            //
            // Using the SOURCE STATE's predicate key would incorrectly detect received tokens
            // as "spent" (because the sender's commitment matches the source state).
            const calculatedStateHash = await sdkToken.state.calculateHash();
            const calculatedStateHashStr = calculatedStateHash.toJSON();

            // Check cache
            const cacheKey = `${tokenId}:${calculatedStateHashStr}:${publicKey}`;
            const cached = this.spentStateCache.get(cacheKey);
            if (cached !== undefined) {
              if (cached.isSpent) {
                return { tokenId, localId: token.id, stateHash: calculatedStateHashStr, spent: true };
              }
              if (Date.now() - cached.timestamp < this.UNSPENT_CACHE_TTL_MS) {
                return { tokenId, localId: token.id, stateHash: calculatedStateHashStr, spent: false };
              }
            }

            // Create RequestId using wallet's public key + SDK-calculated state hash
            const { DataHash } = await import(
              '@unicitylabs/state-transition-sdk/lib/hash/DataHash'
            );
            const stateHashObj = DataHash.fromJSON(calculatedStateHashStr);
            const requestId = await RequestId.create(pubKeyBytes, stateHashObj);

            // Query aggregator
            const response = await this.aggregatorClient!.getInclusionProof(requestId);

            let isSpent = false;

            if (response.inclusionProof) {
              const proof = response.inclusionProof;
              const pathResult = await proof.merkleTreePath.verify(
                requestId.toBitString().toBigInt()
              );

              if (pathResult.isPathValid && pathResult.isPathIncluded && proof.authenticator !== null) {
                isSpent = true;
              }
            }

            // Cache result
            this.spentStateCache.set(cacheKey, {
              isSpent,
              timestamp: Date.now(),
            });

            return { tokenId, localId: token.id, stateHash: calculatedStateHashStr, spent: isSpent };
          } catch (err) {
            return {
              tokenId: token.id,
              localId: token.id,
              stateHash: '',
              spent: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        })
      );

      for (const result of batchResults) {
        completed++;
        if (result.status === 'fulfilled') {
          if (result.value.spent) {
            spentTokens.push({
              tokenId: result.value.tokenId,
              localId: result.value.localId,
              stateHash: result.value.stateHash,
            });
          }
          if (result.value.error) {
            errors.push(`Token ${result.value.tokenId}: ${result.value.error}`);
          }
        } else {
          errors.push(String(result.reason));
        }
      }

      if (options?.onProgress) {
        options.onProgress(completed, total);
      }
    }

    return { spentTokens, errors };
  }

  /**
   * Clear the spent state cache
   */
  clearSpentStateCache(): void {
    this.spentStateCache.clear();
  }

  // =============================================================================
  // Private Helpers
  // =============================================================================

  private hasValidTxfStructure(obj: unknown): boolean {
    if (!obj || typeof obj !== 'object') return false;

    const txf = obj as Record<string, unknown>;
    return !!(
      txf.genesis &&
      typeof txf.genesis === 'object' &&
      txf.state &&
      typeof txf.state === 'object'
    );
  }

  private getUncommittedTransactions(txfToken: unknown): TxfTransaction[] {
    const txf = txfToken as Record<string, unknown>;
    const transactions = txf.transactions as TxfTransaction[] | undefined;

    if (!transactions || !Array.isArray(transactions)) {
      return [];
    }

    return transactions.filter((tx) => tx.inclusionProof === null);
  }

  private async verifyWithSdk(txfToken: unknown): Promise<{ success: boolean; error?: string }> {
    try {
      const { Token } = await import(
        '@unicitylabs/state-transition-sdk/lib/token/Token'
      );

      const sdkToken = await Token.fromJSON(txfToken);

      if (!this.trustBase) {
        return { success: true };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await sdkToken.verify(this.trustBase as any);

      if (!result.isSuccessful) {
        return {
          success: false,
          error: String(result) || 'Verification failed',
        };
      }

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a token validator instance
 */
export function createTokenValidator(options?: {
  aggregatorClient?: AggregatorClient;
  trustBase?: unknown;
  skipVerification?: boolean;
}): TokenValidator {
  return new TokenValidator(options);
}
