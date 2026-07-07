/**
 * Unicity Aggregator Provider — v2 SDK edition.
 *
 * The oracle is a trusted service that provides verifiable truth about token
 * state through cryptographic inclusion proofs.
 *
 * Wave 6-P2-4a (Phase 6): shrunk from ~1,126 LoC to <450 by removing v1-obsolete
 * commitment paths (`submitCommitment`, `submitMintCommitment`, `waitForProofSdk`,
 * `verifyInclusionProof`) and their SDK-verification twins. Callers now route
 * through `ITokenEngine` (see `token-engine/`). Only the aggregator-RPC surface
 * (`getProof`, `waitForProof`, `isSpent`, `validateToken`, `getTokenState`,
 * `getCurrentRound`, `mint`) survives here as a stable JSON-RPC facade.
 *
 * SDK usage in this file is routed through `token-engine/sdk.ts` (the anti-
 * corruption layer). No direct `@unicitylabs/state-transition-sdk` imports.
 */

import { logger } from '../core/logger';
import { incr, time } from '../core/perf-counters';
import type { ProviderStatus } from '../types';
import type {
  OracleProvider,
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
import { SphereError } from '../core/errors';
import { sha256 } from '../core/crypto';

// SDK imports — routed exclusively through the token-engine anti-corruption
// layer. `token-engine/sdk.ts` is the single sanctioned import site for the
// v2 SDK; every other file (including this one) uses `token-engine`'s barrel.
import {
  AggregatorClient,
  StateTransitionClient,
  RootTrustBase,
} from '../token-engine/sdk';

// =============================================================================
// Configuration
// =============================================================================

export interface UnicityAggregatorProviderConfig {
  /** Aggregator URL */
  url: string;
  /** API key for authentication */
  apiKey?: string;
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

/**
 * Response shape from the aggregator's `get_inclusion_proof` RPC.
 * The aggregator returns `{ inclusionProof: { …, transactionHash, …} }` —
 * the historical Sphere wrapper incorrectly looked for a top-level `proof`
 * field, so every poll returned null and instant-mode finalization never
 * converged. Both fields are now accepted (proof for legacy / mainnet shapes,
 * inclusionProof for testnet).
 */
interface RpcProofResponse {
  /** Canonical aggregator shape (current). */
  inclusionProof?: unknown;
  /** Historical / fallback shape — kept for compatibility. */
  proof?: unknown;
  roundNumber?: number;
}

interface RpcValidateResponse {
  valid?: boolean;
  spent?: boolean;
  stateHash?: string;
  error?: string;
}

interface RpcTokenStateResponse {
  state?: {
    stateHash?: string;
    spent?: boolean;
    roundNumber?: number;
  };
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
 * Concrete implementation of OracleProvider using Unicity's aggregator service.
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

  /**
   * Get the bundled RootTrustBase (H6 — SPEC §8.4.2).
   * Alias for `getTrustBase()`, exposed under the spec-canonical name so the
   * pointer layer consumes the same bundled trust base as L4.
   */
  getRootTrustBase(): RootTrustBase | null {
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

  // Cache for spent states (immutable). Wave L: capped at 4096 with
  // delete-oldest LRU eviction to prevent unbounded growth. Spent states
  // are immutable so caching is safe; the cap protects long-running wallet
  // processes that observe many unique stateHashes from gradual memory bloat.
  private spentCache: Map<string, boolean> = new Map();
  private static SPENT_CACHE_MAX = 4096;

  /** Wave L: bounded cache insert. */
  private cacheSpent(cacheKey: string): void {
    if (this.spentCache.size >= UnicityAggregatorProvider.SPENT_CACHE_MAX) {
      const firstKey = this.spentCache.keys().next().value;
      if (firstKey !== undefined) this.spentCache.delete(firstKey);
    }
    this.spentCache.set(cacheKey, true);
  }

  constructor(config: UnicityAggregatorProviderConfig) {
    this.config = {
      url: config.url,
      apiKey: config.apiKey ?? '',
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
    // Actual connectivity is verified on first operation — the aggregator
    // requires requestId in every RPC even for status checks.
    this.status = 'connected';
    this.emitEvent({ type: 'oracle:connected', timestamp: Date.now() });
    this.log('Connected to oracle:', this.config.url);
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
    this.aggregatorClient = new AggregatorClient(
      this.config.url,
      this.config.apiKey || null,
    );
    this.stateTransitionClient = new StateTransitionClient(this.aggregatorClient);

    if (trustBase) {
      this.trustBase = trustBase;
    } else if (!this.config.skipVerification && this.config.trustBaseLoader) {
      // Steelman finding #156: trust-base load failures MUST NOT be silently
      // swallowed. Fail loudly so callers can escalate.
      try {
        const trustBaseJson = await this.config.trustBaseLoader.load();
        if (trustBaseJson) {
          this.trustBase = RootTrustBase.fromJSON(trustBaseJson);
        } else {
          throw new SphereError(
            'TrustBaseLoader.load() returned null/undefined — cannot verify proofs',
            'NOT_INITIALIZED',
          );
        }
      } catch (error) {
        if (error instanceof SphereError) throw error;
        throw new SphereError(
          `Failed to load trust base — refusing to initialize aggregator: ${
            error instanceof Error ? error.message : String(error)
          }`,
          'NOT_INITIALIZED',
          error,
        );
      }
    }

    await this.connect();
    this.log('Initialized with trust base:', !!this.trustBase);
  }

  async getProof(requestId: string): Promise<InclusionProof | null> {
    return time('aggregator.getProof', () => this._getProofImpl(requestId));
  }
  private async _getProofImpl(requestId: string): Promise<InclusionProof | null> {
    this.ensureConnected();

    try {
      const response = await this.rpcCall<RpcProofResponse>('get_inclusion_proof', { requestId });

      // The aggregator returns `inclusionProof` (canonical); some legacy
      // responders use `proof`. Accept either.
      const proof = response.inclusionProof ?? response.proof;
      if (!proof) {
        return null;
      }

      // Steelman finding #157: shape-validate the aggregator's proof payload
      // before handing it back to callers. A malicious or misbehaving
      // aggregator can return arbitrary JSON; require the canonical shape.
      if (typeof proof !== 'object' || proof === null || Array.isArray(proof)) {
        logger.warn(
          'Aggregator',
          `getProof: rejected non-object inclusion proof shape (got ${
            Array.isArray(proof) ? 'array' : typeof proof
          })`,
        );
        return null;
      }
      const proofObj = proof as Record<string, unknown>;
      const requiredKeys = [
        'authenticator',
        'merkleTreePath',
        'transactionHash',
        'unicityCertificate',
      ] as const;
      for (const k of requiredKeys) {
        if (!(k in proofObj)) {
          logger.warn(
            'Aggregator',
            `getProof: rejected inclusion proof missing required field "${k}"`,
          );
          return null;
        }
      }

      return {
        requestId,
        roundNumber: response.roundNumber ?? 0,
        proof,
        timestamp: Date.now(),
      };
    } catch (error) {
      logger.warn('Aggregator', 'getProof failed', error);
      return null;
    }
  }

  async waitForProof(requestId: string, options?: WaitOptions): Promise<InclusionProof> {
    return time('aggregator.waitForProof', () => this._waitForProofImpl(requestId, options));
  }
  private async _waitForProofImpl(requestId: string, options?: WaitOptions): Promise<InclusionProof> {
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

    throw new SphereError(`Timeout waiting for proof: ${requestId}`, 'TIMEOUT');
  }

  /**
   * Aggregator-RPC token validation.
   *
   * Wave 6-P2-4a: SDK-side crypto verification (v1 `SdkToken.verify(trustBase)`)
   * was removed — its v2 replacement requires `PredicateVerifierService` +
   * `MintJustificationVerifierService` bound to a token engine and is properly
   * expressed as `ITokenEngine.verify(token)`. This method now performs RPC
   * validation only. Full cryptographic verification callers MUST route through
   * the engine.
   */
  async validateToken(tokenData: unknown): Promise<ValidationResult> {
    return time('aggregator.validateToken', () => this._validateTokenImpl(tokenData));
  }
  private async _validateTokenImpl(tokenData: unknown): Promise<ValidationResult> {
    this.ensureConnected();

    // Accept both parsed object and JSON string forms — PaymentsModule.validate
    // pulls `token.sdkData` (string) directly from storage while receive-path
    // callers pass the parsed object.
    const parsedTokenData =
      typeof tokenData === 'string' ? JSON.parse(tokenData) : tokenData;

    try {
      const response = await this.rpcCall<RpcValidateResponse>('validateToken', {
        token: parsedTokenData,
      });

      const valid = response.valid ?? false;
      const spent = response.spent ?? false;

      this.emitEvent({
        type: 'validation:completed',
        timestamp: Date.now(),
        data: { valid },
      });

      if (response.stateHash && spent) {
        this.cacheSpent(response.stateHash);
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

  async isSpent(publicKey: string, stateHash: string): Promise<boolean> {
    return time('aggregator.isSpent', () => this._isSpentImpl(publicKey, stateHash));
  }
  private async _isSpentImpl(publicKey: string, stateHash: string): Promise<boolean> {
    // Cache key binds publicKey + stateHash. A given stateHash may be
    // commit-checked under multiple pubkeys in a multi-address wallet; we
    // MUST NOT cross-pollinate cache hits between keys.
    const cacheKey = `${publicKey}:${stateHash}`;
    if (this.spentCache.has(cacheKey)) {
      const cached = this.spentCache.get(cacheKey)!;
      this.spentCache.delete(cacheKey);
      this.spentCache.set(cacheKey, cached);
      return cached;
    }

    this.ensureConnected();

    // Issue #243 fix — the aggregator has no `isSpent` RPC method; it indexes
    // commitments by `requestId = SHA256(publicKey || stateHash.imprint)` and
    // exposes `get_inclusion_proof(requestId)`. Compute the requestId hex
    // directly (SHA256 → prefixed with sha256 multihash bytes `0000`) and probe
    // the inclusion-proof endpoint.
    //
    // v1 note: RequestId.create used `DataHasher(SHA256).update(pubkey).
    // update(stateHash.imprint).digest()` and the result's `.toJSON()` returned
    // the imprint hex (`0000` + digest). We reproduce that manually here so the
    // whole aggregator adapter has no v1 SDK dependency.
    let requestIdHex: string;
    try {
      // stateHash arrives as an imprint hex (typically 68 chars for sha256:
      // 2-byte algorithm prefix + 32-byte digest). Concat publicKey (66 chars)
      // + stateHash (68 chars) and SHA256 the raw bytes.
      const digestHex = sha256(publicKey + stateHash, 'hex');
      // Multihash SHA256 imprint prefix — algorithm code 0x0000 (matches
      // v1 HashAlgorithm.SHA256 = 0, encoded as [high, low] = [0, 0]).
      requestIdHex = '0000' + digestHex;
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new SphereError(
        `isSpent: failed to derive requestId from publicKey/stateHash (${cause})`,
        'AGGREGATOR_ERROR',
        error,
      );
    }

    // Do NOT fail-open on RPC failure — that opens a double-spend window.
    // Propagate as `AGGREGATOR_ERROR`; the disposition-engine's [E] hook
    // catches this and routes it to STRUCTURAL_INVALID (§5.3 [A]).
    let response: RpcProofResponse;
    try {
      response = await this.rpcCall<RpcProofResponse>('get_inclusion_proof', {
        requestId: requestIdHex,
      });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      logger.warn('Aggregator', 'isSpent RPC failed; refusing to fail-open', error);
      throw new SphereError(
        `isSpent: aggregator RPC failed (${cause})`,
        'AGGREGATOR_ERROR',
        error,
      );
    }

    // Accept canonical (`inclusionProof`) or legacy (`proof`) shape.
    // Issue #245 #4 — require canonical `transactionHash: non-empty string`
    // for the spent classification. A misbehaving aggregator returning an
    // unexpected shape would otherwise slip past a bare truthy check.
    const proof = (response.inclusionProof ?? response.proof) as
      | { transactionHash?: unknown }
      | null
      | undefined;
    let spent = false;
    if (proof !== undefined && proof !== null && typeof proof === 'object') {
      const txHash = (proof as { transactionHash?: unknown }).transactionHash;
      spent = typeof txHash === 'string' && txHash.length > 0;
    }

    if (spent) {
      this.cacheSpent(cacheKey);
    }
    return spent;
  }

  async getTokenState(tokenId: string): Promise<TokenState | null> {
    return time('aggregator.getTokenState', () => this._getTokenStateImpl(tokenId));
  }
  private async _getTokenStateImpl(tokenId: string): Promise<TokenState | null> {
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
    } catch (error) {
      logger.warn('Aggregator', 'getTokenState failed', error);
      return null;
    }
  }

  async getCurrentRound(): Promise<number> {
    return time('aggregator.getCurrentRound', () => this._getCurrentRoundImpl());
  }
  private async _getCurrentRoundImpl(): Promise<number> {
    if (!this.aggregatorClient) {
      // Defensive: aggregator client is constructed in `initialize()`. If
      // getCurrentRound is called before initialize (or after a failed init),
      // there's no live RPC channel — surface as a throw so AggregatorPinger
      // classifies the wallet as `'down'` rather than silently treating "no
      // client" as a numeric round.
      throw new Error('UnicityAggregatorProvider: aggregator client not initialized');
    }
    // Wave 6-P2-4a — v2 API drift: `getBlockHeight` → `getLatestBlockNumber`.
    const blockNumber = await this.aggregatorClient.getLatestBlockNumber();
    return Number(blockNumber);
  }

  async mint(params: MintParams): Promise<MintResult> {
    return time('aggregator.mint', () => this._mintImpl(params));
  }
  private async _mintImpl(params: MintParams): Promise<MintResult> {
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
    return time(`aggregator.rpc.${method}`, async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeout);

      try {
        const response = await fetch(this.config.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now(),
            method,
            params,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          incr(`aggregator.rpc.${method}.http_error`);
          throw new SphereError(`HTTP ${response.status}: ${response.statusText}`, 'AGGREGATOR_ERROR');
        }

        const result = await response.json();

        if (result.error) {
          incr(`aggregator.rpc.${method}.rpc_error`);
          throw new SphereError(result.error.message ?? 'RPC error', 'AGGREGATOR_ERROR');
        }

        return (result.result ?? {}) as T;
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  // ===========================================================================
  // Private: Helpers
  // ===========================================================================

  private ensureConnected(): void {
    if (this.status !== 'connected') {
      throw new SphereError('UnicityAggregatorProvider not connected', 'NOT_INITIALIZED');
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

  private log(message: string, ...args: unknown[]): void {
    logger.debug('Aggregator', message, ...args);
  }
}

// =============================================================================
// Backward Compatibility Aliases (Oracle -> Aggregator)
// =============================================================================

/** @deprecated Use UnicityAggregatorProvider instead */
export const UnicityOracleProvider = UnicityAggregatorProvider;
/** @deprecated Use UnicityAggregatorProviderConfig instead */
export type UnicityOracleProviderConfig = UnicityAggregatorProviderConfig;
