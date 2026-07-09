/**
 * Unicity Aggregator Provider
 *
 * Post v1-cutover this is a thin NETWORK-CONFIG provider for the v2 token
 * engine: it loads the root trust base (JSON) via the injected platform loader
 * and exposes the gateway URL + API key. The engine (token-engine/) builds its
 * own SDK clients from these — no state-transition SDK objects live here.
 *
 * `validateToken` remains as a best-effort JSON-RPC check for LEGACY v1 TXF
 * tokens still present in storage (display-path only).
 *
 * TrustBaseLoader is injected for platform-specific loading:
 * - Browser: fetch from URL
 * - Node.js: read from file
 */

import { logger } from '../core/logger';
import type { ProviderStatus } from '../types';
import type {
  OracleProvider,
  ValidationResult,
  OracleEvent,
  OracleEventCallback,
  TrustBaseLoader,
} from './oracle-provider';
import { DEFAULT_AGGREGATOR_TIMEOUT } from '../constants';
import { SphereError } from '../core/errors';

// =============================================================================
// Configuration
// =============================================================================

export interface UnicityAggregatorProviderConfig {
  /** Aggregator (gateway) URL */
  url: string;
  /** API key for authentication */
  apiKey?: string;
  /** Request timeout (ms) */
  timeout?: number;
  /** Skip trust base loading (dev only) */
  skipVerification?: boolean;
  /** Enable debug logging */
  debug?: boolean;
  /** Trust base loader (platform-specific) */
  trustBaseLoader?: TrustBaseLoader;
}

// =============================================================================
// RPC Response Types
// =============================================================================

interface RpcValidateResponse {
  valid?: boolean;
  spent?: boolean;
  stateHash?: string;
  error?: string;
}

// =============================================================================
// Implementation
// =============================================================================

export class UnicityAggregatorProvider implements OracleProvider {
  readonly id = 'unicity-aggregator';
  readonly name = 'Unicity Aggregator';
  readonly type = 'network' as const;
  readonly description = 'Unicity gateway network config (trust base + URL + API key) for the v2 token engine';

  private config: Required<Omit<UnicityAggregatorProviderConfig, 'trustBaseLoader'>> & {
    trustBaseLoader?: TrustBaseLoader;
  };
  private status: ProviderStatus = 'disconnected';
  private eventCallbacks: Set<OracleEventCallback> = new Set();

  /** Raw trust-base JSON as loaded (the v2 token engine parses it itself). */
  private trustBaseJson: unknown | null = null;

  // Cache for spent states reported by validateToken (immutable once spent)
  private spentCache: Map<string, boolean> = new Map();

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
  // v2 token-engine config surface
  // ===========================================================================

  /** Raw trust-base JSON (for constructing the v2 token engine); null when unavailable. */
  getTrustBaseJson(): unknown | null {
    return this.trustBaseJson;
  }

  /** The gateway URL this provider is configured against. */
  getAggregatorUrl(): string {
    return this.config.url;
  }

  /** The gateway API key (for the v2 token engine); undefined when none is configured. */
  getApiKey(): string | undefined {
    return this.config.apiKey || undefined;
  }

  /**
   * Update the API key on this live provider. The v2 token engine snapshots the
   * key at build time, so this alone does NOT change money operations already
   * wired into a running engine — `Sphere.setOracleApiKey()` rebuilds the engine
   * for that. Paths that read `getApiKey()` fresh (e.g. the Unicity-ID minter)
   * pick up the new value immediately.
   */
  setApiKey(apiKey: string): void {
    this.config.apiKey = apiKey ?? '';
  }

  // ===========================================================================
  // BaseProvider Implementation
  // ===========================================================================

  async connect(): Promise<void> {
    if (this.status === 'connected') return;

    this.status = 'connecting';

    // Mark as connected — actual connectivity is verified on first operation.
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

  async initialize(trustBaseJson?: unknown): Promise<void> {
    if (trustBaseJson) {
      this.trustBaseJson = trustBaseJson;
    } else if (!this.config.skipVerification && this.config.trustBaseLoader) {
      try {
        const loaded = await this.config.trustBaseLoader.load();
        if (loaded) {
          this.trustBaseJson = loaded;
        }
      } catch (error) {
        this.log('Failed to load trust base:', error);
      }
    }

    await this.connect();
    this.log('Initialized with trust base JSON:', !!this.trustBaseJson);
  }

  /**
   * Best-effort RPC validation for LEGACY v1 TXF tokens (display path only).
   * v2 blob tokens are verified via the token engine and never reach this.
   */
  async validateToken(tokenData: unknown): Promise<ValidationResult> {
    this.ensureConnected();

    try {
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
        throw new SphereError(`HTTP ${response.status}: ${response.statusText}`, 'AGGREGATOR_ERROR');
      }

      const result = await response.json();

      if (result.error) {
        throw new SphereError(result.error.message ?? 'RPC error', 'AGGREGATOR_ERROR');
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
