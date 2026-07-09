/**
 * Oracle Provider Interface
 * Platform-independent Unicity oracle abstraction
 *
 * Post v1-cutover the oracle is a thin NETWORK-CONFIG provider: it loads the
 * root trust base (JSON) and exposes the gateway URL + API key. The v2 token
 * engine (token-engine/) builds its own aggregator clients from these — no
 * SDK client objects cross this boundary anymore.
 *
 * `validateToken` survives as a best-effort JSON-RPC check for LEGACY v1 TXF
 * tokens still present in storage (display-path only); v2 blob tokens are
 * verified via the engine (`engine.verify` + `engine.isSpent`).
 */

import type { BaseProvider } from '../types';

// =============================================================================
// Oracle Provider Interface
// =============================================================================

export interface OracleProvider extends BaseProvider {
  /**
   * Initialize the provider. Loads the trust base JSON via the configured
   * platform loader when none is passed explicitly.
   *
   * @param trustBaseJson - Optional raw trust-base JSON (overrides the loader).
   */
  initialize(trustBaseJson?: unknown): Promise<void>;

  /**
   * Validate a LEGACY v1 TXF token against the aggregator (best-effort RPC).
   * v2 blob tokens never reach this — they are verified via the token engine.
   */
  validateToken(tokenData: unknown): Promise<ValidationResult>;

  // ── v2 token-engine config surface ─────────────────────────────────────────
  // Sphere.buildTokenEngine reads exactly these three accessors; the engine
  // constructs its own StateTransitionClient/AggregatorClient/RootTrustBase.

  /** Raw trust-base JSON (the engine parses it; the networkId comes from it). */
  getTrustBaseJson(): unknown | null;

  /** Gateway (aggregator) base URL. */
  getAggregatorUrl(): string;

  /** Gateway API key, when the gateway requires one (e.g. testnet2). */
  getApiKey(): string | undefined;

  /**
   * Update the gateway API key on a LIVE provider (optional). Lets a consumer
   * swap the key (e.g. a per-wallet subscription key provisioned after init)
   * WITHOUT rebuilding the whole Sphere. Note: the token engine snapshots the
   * key when it is built, so the caller must rebuild the engine for the change
   * to reach money operations — use `Sphere.setOracleApiKey()`, which does both.
   */
  setApiKey?(apiKey: string): void;
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

// =============================================================================
// Oracle Events
// =============================================================================

export type OracleEventType =
  | 'oracle:connected'
  | 'oracle:disconnected'
  | 'oracle:error'
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
