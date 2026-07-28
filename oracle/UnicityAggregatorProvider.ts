/**
 * Unicity Aggregator Provider
 *
 * Post v1-cutover this is a thin NETWORK-CONFIG provider for the v2 token
 * engine: it loads the root trust base (JSON) via the injected platform loader
 * and exposes the gateway URL + API key. The engine (token-engine/) builds its
 * own SDK clients from these — no state-transition SDK objects live here.
 *
 * TrustBaseLoader is injected for platform-specific loading:
 * - Browser: fetch from URL
 * - Node.js: read from file
 */

import { logger } from '../core/logger';
import type { ProviderStatus } from '../types';
import type {
  OracleProvider,
  OracleEvent,
  OracleEventCallback,
  TrustBaseLoader,
} from './oracle-provider';
import { DEFAULT_AGGREGATOR_TIMEOUT } from '../constants';

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

  // ===========================================================================
  // Event Subscription
  // ===========================================================================

  onEvent(callback: OracleEventCallback): () => void {
    this.eventCallbacks.add(callback);
    return () => this.eventCallbacks.delete(callback);
  }

  // ===========================================================================
  // Private: Helpers
  // ===========================================================================

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
