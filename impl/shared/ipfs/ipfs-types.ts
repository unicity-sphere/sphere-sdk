/**
 * IPFS Storage Provider Types
 * Type definitions for all IPFS/IPNS operations
 */

// =============================================================================
// IPNS Resolution Types
// =============================================================================

/** Result of resolving an IPNS name from a single gateway */
export interface IpnsGatewayResult {
  /** Resolved CID */
  cid: string;
  /** IPNS sequence number */
  sequence: bigint;
  /** Gateway that returned the result */
  gateway: string;
  /** Raw IPNS record data (marshalled protobuf) */
  recordData?: Uint8Array;
}

/** Result of progressive IPNS resolution across multiple gateways */
export interface IpnsProgressiveResult {
  /** Best result (highest sequence number) */
  best: IpnsGatewayResult | null;
  /** All results from responding gateways */
  allResults: IpnsGatewayResult[];
  /** Number of gateways that responded */
  respondedCount: number;
  /** Total gateways queried */
  totalGateways: number;
}

/** Result of publishing an IPNS record */
export interface IpnsPublishResult {
  /** Whether at least one gateway accepted the record */
  success: boolean;
  /** IPNS name that was published */
  ipnsName?: string;
  /** CID that was published */
  cid?: string;
  /** New sequence number */
  sequence?: bigint;
  /** Gateways that accepted the record */
  successfulGateways?: string[];
  /** Error message if all gateways failed */
  error?: string;
}

// =============================================================================
// IPFS Content Types
// =============================================================================

/** Result of fetching content from IPFS */
export interface IpfsContentResult<T = unknown> {
  /** Whether the fetch succeeded */
  success: boolean;
  /** Fetched content */
  data?: T;
  /** CID of the content */
  cid?: string;
  /** Gateway that returned the content */
  gateway?: string;
  /** Error message on failure */
  error?: string;
}

/** Result of uploading content to IPFS */
export interface IpfsUploadResult {
  /** Whether the upload succeeded */
  success: boolean;
  /** CID of the uploaded content */
  cid?: string;
  /** Gateway that accepted the upload */
  gateway?: string;
  /** Error message on failure */
  error?: string;
}

// =============================================================================
// Gateway Health Types
// =============================================================================

/** Result of checking gateway connectivity */
export interface GatewayHealthResult {
  /** Gateway URL */
  gateway: string;
  /** Whether the gateway is reachable */
  healthy: boolean;
  /** Response time in ms */
  responseTimeMs?: number;
  /** Error if unhealthy */
  error?: string;
}

// =============================================================================
// Configuration Types
// =============================================================================

/** IPFS storage provider configuration */
export interface IpfsStorageConfig {
  /** Gateway URLs for HTTP API (defaults to Unicity dedicated nodes) */
  gateways?: string[];
  /** Content fetch timeout in ms (default: 15000) */
  fetchTimeoutMs?: number;
  /** IPNS resolution timeout in ms (default: 10000) */
  resolveTimeoutMs?: number;
  /** IPNS publish timeout in ms (default: 30000) */
  publishTimeoutMs?: number;
  /** Gateway connectivity test timeout in ms (default: 5000) */
  connectivityTimeoutMs?: number;
  /** IPNS record lifetime in ms (default: 99 years) */
  ipnsLifetimeMs?: number;
  /** IPNS cache TTL in ms (default: 60000) */
  ipnsCacheTtlMs?: number;
  /** Circuit breaker failure threshold (default: 3) */
  circuitBreakerThreshold?: number;
  /** Circuit breaker cooldown in ms (default: 60000) */
  circuitBreakerCooldownMs?: number;
  /** Known-fresh window in ms (default: 30000) */
  knownFreshWindowMs?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** WebSocket factory for IPNS push subscriptions (cross-platform) */
  createWebSocket?: import('../../../transport/websocket').WebSocketFactory;
  /** Override WebSocket URL (auto-derived from gateways if omitted) */
  wsUrl?: string;
  /** Fallback polling interval in ms when WS unavailable (default: 90000) */
  fallbackPollIntervalMs?: number;
  /** Debounce for push-triggered sync in ms (default: 500) */
  syncDebounceMs?: number;
  /** Debounce interval for background flush in ms (default: 2000) */
  flushDebounceMs?: number;
}

/** IPNS update event received via WebSocket push or polling */
export interface IpnsUpdateEvent {
  name: string;
  sequence: number;
  cid: string;
  timestamp: string;
}

// =============================================================================
// State Persistence Types
// =============================================================================

/** State persisted between sessions */
export interface IpfsPersistedState {
  /** IPNS sequence number (stored as string because bigint) */
  sequenceNumber: string;
  /** Last known CID */
  lastCid: string | null;
  /** Data version counter */
  version: number;
}

/** Interface for platform-specific state storage */
export interface IpfsStatePersistence {
  /** Load persisted state for an IPNS name */
  load(ipnsName: string): Promise<IpfsPersistedState | null>;
  /** Save state for an IPNS name */
  save(ipnsName: string, state: IpfsPersistedState): Promise<void>;
  /** Clear persisted state for an IPNS name */
  clear(ipnsName: string): Promise<void>;
}

// =============================================================================
// Merge Types
// =============================================================================

/** Result of merging local and remote TXF data */
export interface MergeResult<T> {
  /** Merged data */
  merged: T;
  /** Number of tokens added from remote */
  added: number;
  /** Number of tokens removed (tombstoned) */
  removed: number;
  /** Number of conflicts resolved */
  conflicts: number;
}
