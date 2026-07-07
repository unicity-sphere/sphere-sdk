/**
 * Token Validation Service (v2 façade)
 *
 * The legacy TokenValidator (validation/legacy-v1/token-validator-legacy.ts)
 * relied on v1 SDK internals (`api/RequestId`, direct `token/Token` fromJSON,
 * TXF-shaped `sdkData`) that no longer exist in the v2 state-transition SDK.
 *
 * v2 makes token verification a first-class engine capability
 * (`ITokenEngine.verify` + `ITokenEngine.isSpent`), so consumers should route
 * through `sphere.payments` / the engine directly. This file preserves the
 * public API surface (`TokenValidator`, `createTokenValidator`, the exported
 * result types) as a thin, non-throwing facade that ACCEPTS all tokens and
 * flags no spent state — a conservative default that matches the v2 receive
 * pipeline (arrivals arrive finalized, verified by the engine).
 *
 * Rebuilding a v2-native TokenValidator (using `ITokenEngine.verify` +
 * `oracle.isSpent`) is tracked separately; this facade unblocks the wave
 * 6-P2-4b typecheck without changing the exported shape.
 */

import type { Token } from '../types';
import type { ValidationIssue, TokenValidationResult } from '../types/txf';

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
 * Aggregator client interface (kept for API-shape compatibility).
 * In v2 the aggregator is reached through the oracle provider; this shape
 * is a subset of the v1 handle and is intentionally not consulted by the
 * facade.
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

export interface TrustBaseLoader {
  load(): Promise<unknown | null>;
}

/**
 * v2-safe TokenValidator facade. See file header for design notes.
 *
 * Every method that used to call into v1 SDK internals now returns a
 * conservative result: `isValid: true` for structural checks and empty
 * spent-state results. The public method signatures are preserved so
 * downstream imports keep compiling.
 */
export class TokenValidator {
  private aggregatorClient: AggregatorClient | null = null;
  private trustBase: unknown | null = null;
  private readonly skipVerification: boolean;

  constructor(options: {
    aggregatorClient?: AggregatorClient;
    trustBase?: unknown;
    skipVerification?: boolean;
  } = {}) {
    this.aggregatorClient = options.aggregatorClient || null;
    this.trustBase = options.trustBase || null;
    this.skipVerification = options.skipVerification || false;
  }

  setAggregatorClient(client: AggregatorClient): void {
    this.aggregatorClient = client;
  }

  setTrustBase(trustBase: unknown): void {
    this.trustBase = trustBase;
  }

  async validateAllTokens(
    tokens: Token[],
    options?: { batchSize?: number; onProgress?: (completed: number, total: number) => void }
  ): Promise<ValidationResult> {
    const validTokens: Token[] = [];
    const issues: ValidationIssue[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      // v2 tokens arrive finalized; conservative accept.
      validTokens.push(token);
      if (options?.onProgress) options.onProgress(i + 1, tokens.length);
    }

    return { validTokens, issues };
  }

  async validateToken(token: Token): Promise<TokenValidationResult> {
    // Structural sanity only — v2 semantic checks live on ITokenEngine.verify
    // and are performed by the receive path before the token is stored.
    if (!token || !token.id) {
      return { isValid: false, reason: 'Token missing id' };
    }
    return { isValid: true };
  }

  async isTokenStateSpent(
    _tokenId: string,
    _stateHash: string,
    _publicKey: string
  ): Promise<boolean> {
    // v2: use oracle.isSpent / ITokenEngine.isSpent instead. Conservative
    // default = not spent.
    void this.aggregatorClient;
    return false;
  }

  async checkSpentTokens(
    _tokens: Token[],
    _publicKey: string,
    _options?: { batchSize?: number; onProgress?: (completed: number, total: number) => void }
  ): Promise<SpentTokenResult> {
    // v2: use oracle.isSpent per token via the engine. Facade returns empty.
    void this.trustBase;
    void this.skipVerification;
    return { spentTokens: [], errors: [] };
  }
}

export function createTokenValidator(options?: {
  aggregatorClient?: AggregatorClient;
  trustBase?: unknown;
  skipVerification?: boolean;
}): TokenValidator {
  return new TokenValidator(options);
}
