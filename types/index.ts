/**
 * SDK2 Core Types
 * Platform-independent type definitions
 */

// =============================================================================
// Provider Base Types
// =============================================================================

export type ProviderStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ProviderMetadata {
  readonly id: string;
  readonly name: string;
  readonly type: 'local' | 'cloud' | 'p2p' | 'network';
  readonly description?: string;
}

export interface BaseProvider extends ProviderMetadata {
  connect(config?: unknown): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getStatus(): ProviderStatus;
}

// =============================================================================
// Identity Types
// =============================================================================

export interface Identity {
  /** 33-byte compressed secp256k1 public key (for L3 chain) */
  readonly chainPubkey: string;
  /** L3 DIRECT address (DIRECT://...) */
  readonly directAddress?: string;
  readonly ipnsName?: string;
  readonly nametag?: string;
}

export interface FullIdentity extends Identity {
  readonly privateKey: string;
}

export interface IdentityConfig {
  mnemonic?: string;
  privateKey?: string;
  derivationPath?: string;
}

// =============================================================================
// Token Types
// =============================================================================

export type TokenStatus =
  | 'pending'      // Initial creation
  | 'submitted'    // Commitment sent, awaiting on-chain certification
  | 'confirmed'    // Has inclusion proof
  | 'transferring' // Being transferred
  | 'spent'        // Transferred away
  | 'invalid';     // Validation failed

export interface Token {
  readonly id: string;
  readonly coinId: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly iconUrl?: string;
  readonly amount: string;
  status: TokenStatus;
  readonly createdAt: number;
  updatedAt: number;
  readonly sdkData?: string;
  /**
   * Lazy inventory record (sdk-changes S2): the token's VALUE metadata came
   * from the storage provider's `listInventory()` view and its blob has not
   * been downloaded — `sdkData` is absent and the blob is fetched on demand
   * (`getToken`) only when the token is selected for a spend.
   */
  readonly lazy?: boolean;
  /**
   * #625 (self-healing coin selection): a send selected this source but its state was already spent
   * on-chain (`TransferConflictError`). It is KEPT in inventory (visible, recoverable by a resync —
   * never auto-removed) but EXCLUDED from spend selection, so coin-selection picks live tokens and the
   * send self-heals instead of wedging on a stale source.
   */
  suspectedSpent?: boolean;
}

export interface Asset {
  readonly coinId: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly iconUrl?: string;
  readonly totalAmount: string;
  readonly tokenCount: number;
  /** Sum of confirmed token amounts (smallest units) */
  readonly confirmedAmount: string;
  /** Sum of unconfirmed (submitted/pending) token amounts (smallest units) */
  readonly unconfirmedAmount: string;
  /** Number of confirmed tokens aggregated */
  readonly confirmedTokenCount: number;
  /** Number of unconfirmed tokens aggregated */
  readonly unconfirmedTokenCount: number;
  /** Number of tokens currently being sent (in-flight, NOT spendable) */
  readonly transferringTokenCount: number;
  /**
   * Sum of in-flight (`'transferring'`) token amounts (smallest units). These
   * tokens are LEAVING the wallet during an active send, so they are excluded
   * from {@link totalAmount}, {@link confirmedAmount}, and
   * {@link unconfirmedAmount} — surfaced here so a UI can still show a "Sending"
   * badge without inflating the spendable balance.
   */
  readonly transferringAmount: string;
  /** Price per whole unit in USD (null if PriceProvider not configured) */
  readonly priceUsd: number | null;
  /** Price per whole unit in EUR (null if PriceProvider not configured) */
  readonly priceEur: number | null;
  /** 24h price change percentage (null if unavailable) */
  readonly change24h: number | null;
  /** Total fiat value in USD: (totalAmount / 10^decimals) * priceUsd */
  readonly fiatValueUsd: number | null;
  /** Total fiat value in EUR */
  readonly fiatValueEur: number | null;
}

// =============================================================================
// Transfer Types
// =============================================================================

export type TransferStatus =
  | 'pending'
  | 'submitted'
  | 'confirmed'
  | 'delivered'
  | 'completed'
  | 'failed';

export interface TransferRequest {
  readonly coinId: string;
  readonly amount: string;
  readonly recipient: string;
  readonly memo?: string;
}

/**
 * Per-token transfer detail tracking the on-chain operation for each source
 * token involved in a transfer.
 */
export interface TokenTransferDetail {
  /** Source token ID that was consumed in this transfer */
  readonly sourceTokenId: string;
  /** Transfer method used for this token */
  readonly method: 'direct' | 'split';
}

export interface TransferResult {
  readonly id: string;
  status: TransferStatus;
  readonly tokens: Token[];
  /** Per-token transfer details — one entry per source token consumed */
  readonly tokenTransfers: TokenTransferDetail[];
  error?: string;
  /**
   * True when the send certified on-chain but the recipient-side delivery did not land
   * (covenant §3.1 — issue #621): the source is terminally spent, the finished blob is
   * journaled, and the sender is NOT failed. Distinguishes "sent, delivery deferred" from
   * a real send failure. See {@link deliveryState}.
   */
  deliveryPending?: boolean;
  /** 'landed' = delivered to the recipient's mailbox; 'pending-delivery' = certified, journaled, awaiting (re-)delivery. */
  deliveryState?: 'landed' | 'pending-delivery';
}

export interface IncomingTransfer {
  readonly id: string;
  readonly senderPubkey: string;
  readonly senderNametag?: string;
  readonly tokens: Token[];
  readonly memo?: string;
  readonly receivedAt: number;
}

// =============================================================================
// Message Types
// =============================================================================

export interface DirectMessage {
  readonly id: string;
  readonly senderPubkey: string;
  readonly senderNametag?: string;
  readonly recipientPubkey: string;
  readonly recipientNametag?: string;
  readonly content: string;
  readonly timestamp: number;
  isRead: boolean;
}

export interface BroadcastMessage {
  readonly id: string;
  readonly authorPubkey: string;
  readonly authorNametag?: string;
  readonly content: string;
  readonly timestamp: number;
  readonly tags?: string[];
}

export interface ComposingIndicator {
  readonly senderPubkey: string;
  readonly senderNametag?: string;
  readonly expiresIn: number;
}

// =============================================================================
// Tracked Addresses
// =============================================================================

/**
 * Minimal data stored in persistent storage for a tracked address.
 * Only contains user state — derived fields are computed on load.
 */
export interface TrackedAddressEntry {
  /** HD derivation index (0, 1, 2, ...) */
  readonly index: number;
  /** Whether this address is hidden from UI display */
  hidden: boolean;
  /** Timestamp (ms) when this address was first activated */
  readonly createdAt: number;
  /** Timestamp (ms) of last modification */
  updatedAt: number;
}

/**
 * Full tracked address with derived fields and nametag (available in memory).
 * Returned by Sphere.getActiveAddresses() / getAllTrackedAddresses().
 */
export interface TrackedAddress extends TrackedAddressEntry {
  /** Short address identifier (e.g., "DIRECT_abc123_xyz789") */
  readonly addressId: string;
  /** L3 DIRECT address (DIRECT://...) */
  readonly directAddress: string;
  /** 33-byte compressed secp256k1 public key */
  readonly chainPubkey: string;
  /** Primary nametag (from nametag cache, without @ prefix) */
  readonly nametag?: string;
}

// =============================================================================
// Event Types
// =============================================================================

export type SphereEventType =
  // payments events (§4 of docs/PAYMENTS-V2-DESIGN.md — the 8 facade events)
  | 'transfer:incoming'
  | 'transfer:updated'
  | 'transfer:attention'
  | 'inventory:updated'
  | 'history:updated'
  | 'payment_request:incoming'
  | 'payment_request:updated'
  | 'connection:status'
  // messaging
  | 'message:dm'
  | 'message:read'
  | 'message:typing'
  | 'composing:started'
  | 'message:broadcast'
  // wallet lifecycle
  | 'connection:changed'
  | 'nametag:registered'
  | 'nametag:recovered'
  | 'identity:changed'
  | 'address:activated'
  | 'address:hidden'
  | 'address:unhidden'
  // group chat
  | 'groupchat:message'
  | 'groupchat:joined'
  | 'groupchat:left'
  | 'groupchat:kicked'
  | 'groupchat:group_deleted'
  | 'groupchat:updated'
  | 'groupchat:connection'
  | 'groupchat:ready'
  | 'communications:ready';

export interface SphereEventMap {
  'transfer:incoming': IncomingTransfer;
  /** A transfer's lifecycle advanced (send/receive/mint) — carries the full result. */
  'transfer:updated': TransferResult;
  /** A transfer needs operator/user attention (undeliverable, checkpoint-stuck, ...) — coded. */
  'transfer:attention': { transferId: string; code: string; detail?: string };
  /** The wallet-api inventory mirror changed — re-read tokens()/assets(). */
  'inventory:updated': Record<string, never>;
  /** History changed — carries the just-recorded client-shaped entry (same toEntry mapping history() serves). */
  'history:updated': import('../modules/payments-v2/api').HistoryEntry;
  'payment_request:incoming': import('../modules/payments-v2/api').PaymentRequestView;
  'payment_request:updated': { id: string; status: 'pending' | 'settling' | 'paid' | 'rejected' | 'expired' };
  /** wallet-api session connectivity. */
  'connection:status': { status: 'connected' | 'degraded' | 'offline' };
  'message:dm': DirectMessage;
  'message:read': { messageIds: string[]; peerPubkey: string };
  'message:typing': { senderPubkey: string; senderNametag?: string; timestamp: number };
  'composing:started': ComposingIndicator;
  'message:broadcast': BroadcastMessage;
  'connection:changed': { provider: string; connected: boolean; status?: ProviderStatus; enabled?: boolean; error?: string };
  'nametag:registered': { nametag: string; addressIndex: number };
  'nametag:recovered': { nametag: string };
  'identity:changed': { directAddress?: string; chainPubkey: string; nametag?: string; addressIndex: number };
  'address:activated': { address: TrackedAddress };
  'address:hidden': { index: number; addressId: string };
  'address:unhidden': { index: number; addressId: string };
  'groupchat:message': import('../modules/groupchat/types').GroupMessageData;
  'groupchat:joined': { groupId: string; groupName: string };
  'groupchat:left': { groupId: string };
  'groupchat:kicked': { groupId: string; groupName: string };
  'groupchat:group_deleted': { groupId: string; groupName: string };
  'groupchat:updated': Record<string, never>;
  'groupchat:connection': { connected: boolean };
  'groupchat:ready': { groupCount: number };
  'communications:ready': { conversationCount: number };
}

export type SphereEventHandler<T extends SphereEventType> = (
  data: SphereEventMap[T]
) => void;

// =============================================================================
// Error Types (canonical source: core/errors.ts)
// =============================================================================

export { SphereError, isSphereError } from '../core/errors';
export type { SphereErrorCode } from '../core/errors';

// =============================================================================
// Wallet Management Types
// =============================================================================

/**
 * Derivation mode determines how child keys are derived:
 * - "bip32": Standard BIP32 with chain code (IL + parentKey) mod n
 * - "legacy_hmac": Legacy Sphere HMAC derivation with chain code
 * - "wif_hmac": Simple HMAC derivation without chain code (webwallet compatibility)
 */
export type DerivationMode = 'bip32' | 'legacy_hmac' | 'wif_hmac';

/**
 * Source of wallet creation
 */
export type WalletSource = 'mnemonic' | 'file' | 'unknown';

/**
 * Wallet information for backup/export purposes
 */
export interface WalletInfo {
  readonly source: WalletSource;
  readonly hasMnemonic: boolean;
  readonly hasChainCode: boolean;
  readonly derivationMode: DerivationMode;
  readonly basePath: string;
  /** Primary public address at index 0 (chain pubkey — display/reference only) */
  readonly address0: string | null;
}

/**
 * JSON export format for wallet backup (v1.0)
 */
export interface WalletJSON {
  readonly version: '1.0';
  readonly type: 'sphere-wallet';
  readonly createdAt: string;
  readonly wallet: {
    readonly masterPrivateKey?: string;
    readonly chainCode?: string;
    readonly addresses: ReadonlyArray<{
      /** Public address (chain pubkey) — display/reference only; re-import keys on masterPrivateKey + path */
      readonly address: string;
      readonly publicKey: string;
      readonly path: string;
      readonly index: number;
    }>;
    readonly isBIP32: boolean;
    readonly descriptorPath?: string;
  };
  readonly mnemonic?: string;
  readonly encrypted?: boolean;
  readonly source?: WalletSource;
  readonly derivationMode?: DerivationMode;
}

/**
 * Options for exporting wallet to JSON
 */
export interface WalletJSONExportOptions {
  /** Include mnemonic in export (default: true if available) */
  includeMnemonic?: boolean;
  /** Encrypt sensitive data with password */
  password?: string;
  /** Number of addresses to include (default: 1) */
  addressCount?: number;
}

// =============================================================================
// Address Derivation Types (re-exported from crypto)
// =============================================================================

export type { AddressInfo } from '../core/crypto';

// =============================================================================
// Network Health Types
// =============================================================================

/**
 * Result of a single service health check
 */
export interface ServiceHealthResult {
  /** Whether the service is reachable */
  healthy: boolean;
  /** URL that was checked */
  url: string;
  /** Response time in ms (null if unreachable) */
  responseTimeMs: number | null;
  /** Error message if unhealthy */
  error?: string;
}

/**
 * User-provided health check function for custom services.
 * Receives the configured timeout and should return a ServiceHealthResult.
 */
export type HealthCheckFn = (timeoutMs: number) => Promise<ServiceHealthResult>;

/**
 * Result of checking all network services (pre-init)
 */
export interface NetworkHealthResult {
  /** Overall health: true if all checked services are reachable */
  healthy: boolean;
  /** Per-service results (built-in + custom) */
  services: {
    relay?: ServiceHealthResult;
    oracle?: ServiceHealthResult;
    /** Custom service results keyed by user-provided name */
    [key: string]: ServiceHealthResult | undefined;
  };
  /** Total time to complete all checks (ms) */
  totalTimeMs: number;
}

// =============================================================================
// Provider Status Types
// =============================================================================

/** Role of a provider in the system */
export type ProviderRole = 'storage' | 'token-storage' | 'transport' | 'oracle' | 'price';

/**
 * Rich status information for a single provider (used in getStatus())
 */
export interface ProviderStatusInfo {
  /** Provider unique ID */
  id: string;
  /** Display name */
  name: string;
  /** Role in the system */
  role: ProviderRole;
  /** Detailed status */
  status: ProviderStatus;
  /** Shorthand for status === 'connected' */
  connected: boolean;
  /** Whether the provider is enabled (can be toggled at runtime) */
  enabled: boolean;
  /** Provider-specific metadata (e.g., relay count for transport) */
  metadata?: Record<string, unknown>;
}

/**
 * Aggregated status of all providers, grouped by role
 */
export interface SphereStatus {
  storage: ProviderStatusInfo[];
  tokenStorage: ProviderStatusInfo[];
  transport: ProviderStatusInfo[];
  oracle: ProviderStatusInfo[];
  price: ProviderStatusInfo[];
}
