/**
 * Token Validation Service for SDK2
 * Validates tokens against aggregator and fetches missing proofs
 *
 * Platform-independent implementation that accepts dependencies via constructor.
 */

import type { Token } from '../types';
import type { TxfTransaction, ValidationIssue, TokenValidationResult } from '../types/txf';
import { getCurrentStateHash, tokenToTxf } from '../serialization/txf-serializer';

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
   * IMPORTANT: This follows the same approach as the Sphere webgui:
   * 1. Parse TXF using SDK's Token.fromJSON()
   * 2. Calculate state hash via sdkToken.state.calculateHash()
   * 3. Create RequestId via RequestId.create(walletPubKey, calculatedHash)
   *
   * The stored stateHash from getCurrentStateHash() can be STALE for received tokens.
   * For received tokens, the state is updated with a new predicate (new owner),
   * so the CURRENT state hash must be CALCULATED, not read from storage.
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

            // NOTE: We skip ownership check here because:
            // 1. Per TOKEN_INVENTORY_SPEC.md, ownership is verified in Step 5.2 (during token receipt)
            // 2. Tokens in our storage have already been validated for ownership when received
            // 3. Step 7 (Spent Detection) checks if our ALREADY-OWNED tokens have been spent
            //
            // For PROXY tokens that were finalized, the predicate is updated to use the wallet's
            // predicate, but the isOwner() check may fail due to SDK implementation details.
            // Since the token is already in our storage and was validated during receipt,
            // we trust that it belongs to us.

            // IMPORTANT: Use STORED state hash for spent detection
            //
            // For spent detection, we need to check the state hash that WAS COMMITTED to aggregator.
            // The SDK-calculated hash reflects the CURRENT state (after local finalization),
            // but if a token was SPENT, the commitment used the state hash BEFORE the spend.
            //
            // Priority:
            // 1. Use stored stateHash from the token's last transaction (what was committed)
            // 2. Fall back to SDK-calculated hash for tokens without transaction history
            const storedStateHash = getCurrentStateHash(txf);
            const calculatedStateHash = await sdkToken.state.calculateHash();
            const calculatedStateHashStr = calculatedStateHash.toJSON();

            // Prefer stored state hash if available (it's what was committed)
            const stateHashStr = storedStateHash || calculatedStateHashStr;

            // CRITICAL: Extract public key from the SOURCE STATE's predicate
            //
            // For spent detection, we need the public key that was used to SIGN the spending commitment.
            // This is the public key in the SOURCE STATE's predicate (the state being spent),
            // NOT the current state's predicate (which belongs to the recipient).
            //
            // For tokens with transaction history:
            // - The last transaction's data.sourceState.predicate contains the spender's key
            // For tokens without transactions (genesis only):
            // - The current state's predicate is the owner's key
            //
            let predicatePublicKey: Buffer = pubKeyBytes; // Default to wallet's key

            // Try to extract public key from source state of last transaction
            const lastTx = txf.transactions?.[txf.transactions.length - 1];
            const sourceStatePredicate = lastTx?.data?.sourceState?.predicate;

            if (sourceStatePredicate) {
              // Extract public key from predicate hex
              // Pattern: 5821 (CBOR byte string of 33 bytes) followed by 02 or 03 (compressed pubkey)
              const predicateHex = typeof sourceStatePredicate === 'string'
                ? sourceStatePredicate
                : JSON.stringify(sourceStatePredicate);
              const match = predicateHex.match(/5821(0[23][a-f0-9]{64})/i);
              if (match) {
                predicatePublicKey = Buffer.from(match[1], 'hex');
              }
            } else {
              // No transaction history - use current state's predicate
              const currentPredicate = txf.state?.predicate;
              if (currentPredicate) {
                const predicateHex = typeof currentPredicate === 'string'
                  ? currentPredicate
                  : JSON.stringify(currentPredicate);
                const match = predicateHex.match(/5821(0[23][a-f0-9]{64})/i);
                if (match) {
                  predicatePublicKey = Buffer.from(match[1], 'hex');
                }
              }
            }

            // Check cache first (use predicate pubkey for cache key)
            const predicatePubkeyHex = predicatePublicKey.toString('hex');
            const cacheKey = `${tokenId}:${stateHashStr}:${predicatePubkeyHex}`;
            const cached = this.spentStateCache.get(cacheKey);
            if (cached !== undefined) {
              if (cached.isSpent) {
                return { tokenId, localId: token.id, stateHash: stateHashStr, spent: true };
              }
              if (Date.now() - cached.timestamp < this.UNSPENT_CACHE_TTL_MS) {
                return { tokenId, localId: token.id, stateHash: stateHashStr, spent: false };
              }
            }

            // Create RequestId using predicate's public key + stored state hash
            // The predicate's public key is what would have been used to sign the spending commitment
            const { DataHash } = await import(
              '@unicitylabs/state-transition-sdk/lib/hash/DataHash'
            );
            const stateHashObj = DataHash.fromJSON(stateHashStr);
            const requestId = await RequestId.create(predicatePublicKey, stateHashObj);

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

            return { tokenId, localId: token.id, stateHash: stateHashStr, spent: isSpent };
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
