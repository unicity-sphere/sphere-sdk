/**
 * SDK2 Constants
 * Default configuration values and storage keys
 */

// =============================================================================
// Storage Keys
// =============================================================================

/** Default prefix for all storage keys */
export const STORAGE_PREFIX = 'sphere_' as const;

/**
 * Default encryption key for wallet data
 * WARNING: This is a placeholder. In production, use user-provided password.
 * This key is used when no password is provided to encrypt/decrypt mnemonic.
 */
export const DEFAULT_ENCRYPTION_KEY = 'sphere-default-key' as const;

/**
 * Global storage keys (one per wallet, no address index)
 * Final key format: sphere_{key}
 */
export const STORAGE_KEYS_GLOBAL = {
  /** Encrypted BIP39 mnemonic */
  MNEMONIC: 'mnemonic',
  /** Encrypted master private key */
  MASTER_KEY: 'master_key',
  /** BIP32 chain code */
  CHAIN_CODE: 'chain_code',
  /** HD derivation path (full path like m/44'/0'/0'/0/0) */
  DERIVATION_PATH: 'derivation_path',
  /** Base derivation path (like m/44'/0'/0' without chain/index) */
  BASE_PATH: 'base_path',
  /** Derivation mode: bip32, wif_hmac, legacy_hmac */
  DERIVATION_MODE: 'derivation_mode',
  /** Wallet source: mnemonic, file, unknown */
  WALLET_SOURCE: 'wallet_source',
  /** Wallet existence flag */
  WALLET_EXISTS: 'wallet_exists',
  /** Current active address index */
  CURRENT_ADDRESS_INDEX: 'current_address_index',
  /** Nametag cache per address (separate from tracked addresses registry) */
  ADDRESS_NAMETAGS: 'address_nametags',
  /** Active addresses registry (JSON: TrackedAddressesStorage) */
  TRACKED_ADDRESSES: 'tracked_addresses',
  /** Last processed Nostr wallet event timestamp (unix seconds), keyed per pubkey */
  LAST_WALLET_EVENT_TS: 'last_wallet_event_ts',
  /** Group chat: last used relay URL (stale data detection) — global, same relay for all addresses */
  GROUP_CHAT_RELAY_URL: 'group_chat_relay_url',
  /** Cached token registry JSON (fetched from remote) */
  TOKEN_REGISTRY_CACHE: 'token_registry_cache',
  /** Timestamp of last token registry cache update (ms since epoch) */
  TOKEN_REGISTRY_CACHE_TS: 'token_registry_cache_ts',
  /** Cached price data JSON (from CoinGecko or other provider) */
  PRICE_CACHE: 'price_cache',
  /** Timestamp of last price cache update (ms since epoch) */
  PRICE_CACHE_TS: 'price_cache_ts',
} as const;

/**
 * Per-address storage keys (one per derived address)
 * Final key format: sphere_{DIRECT_xxx_yyy}_{key}
 * Example: sphere_DIRECT_abc123_xyz789_pending_transfers
 *
 * Note: Token data (tokens, tombstones, archived, forked) is stored via
 * TokenStorageProvider, not here. This avoids duplication.
 */
export const STORAGE_KEYS_ADDRESS = {
  /** Pending transfers for this address */
  PENDING_TRANSFERS: 'pending_transfers',
  /** Transfer outbox for this address */
  OUTBOX: 'outbox',
  /** Conversations for this address */
  CONVERSATIONS: 'conversations',
  /** Messages for this address */
  MESSAGES: 'messages',
  /** Transaction history for this address */
  TRANSACTION_HISTORY: 'transaction_history',
  /** Pending V5 finalization tokens (unconfirmed instant split tokens) */
  PENDING_V5_TOKENS: 'pending_v5_tokens',
  /** Group chat: joined groups for this address */
  GROUP_CHAT_GROUPS: 'group_chat_groups',
  /** Group chat: messages for this address */
  GROUP_CHAT_MESSAGES: 'group_chat_messages',
  /** Group chat: members for this address */
  GROUP_CHAT_MEMBERS: 'group_chat_members',
  /** Group chat: processed event IDs for deduplication */
  GROUP_CHAT_PROCESSED_EVENTS: 'group_chat_processed_events',
  /** Processed V5 split group IDs for Nostr re-delivery dedup */
  PROCESSED_SPLIT_GROUP_IDS: 'processed_split_group_ids',
} as const;

/** @deprecated Use STORAGE_KEYS_GLOBAL and STORAGE_KEYS_ADDRESS instead */
export const STORAGE_KEYS = {
  ...STORAGE_KEYS_GLOBAL,
  ...STORAGE_KEYS_ADDRESS,
} as const;

/**
 * Build a per-address storage key using address identifier
 * @param addressId - Short identifier for the address (e.g., first 8 chars of pubkey hash, or direct address hash)
 * @param key - The key from STORAGE_KEYS_ADDRESS
 * @returns Key in format: "{addressId}_{key}" e.g., "a1b2c3d4_tokens"
 */
export function getAddressStorageKey(addressId: string, key: string): string {
  return `${addressId}_${key}`;
}

/**
 * Create a readable address identifier from directAddress or chainPubkey
 * Format: DIRECT_first6_last6 (sanitized for filesystem/storage)
 * @param directAddress - The L3 direct address (DIRECT:xxx) or chainPubkey
 * @returns Sanitized identifier like "DIRECT_abc123_xyz789"
 */
export function getAddressId(directAddress: string): string {
  // Remove DIRECT:// or DIRECT: prefix if present
  let hash = directAddress;
  if (hash.startsWith('DIRECT://')) {
    hash = hash.slice(9);
  } else if (hash.startsWith('DIRECT:')) {
    hash = hash.slice(7);
  }
  // Format: DIRECT_first6_last6 (sanitized)
  const first = hash.slice(0, 6).toLowerCase();
  const last = hash.slice(-6).toLowerCase();
  return `DIRECT_${first}_${last}`;
}

// =============================================================================
// Nostr Defaults
// =============================================================================

/** Default Nostr relays */
export const DEFAULT_NOSTR_RELAYS = [
  'wss://relay.unicity.network',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
] as const;

/** Nostr event kinds used by SDK - must match @unicitylabs/nostr-js-sdk */
export const NOSTR_EVENT_KINDS = {
  /** NIP-04 encrypted direct message */
  DIRECT_MESSAGE: 4,
  /** Token transfer (Unicity custom - 31113) */
  TOKEN_TRANSFER: 31113,
  /** Payment request (Unicity custom - 31115) */
  PAYMENT_REQUEST: 31115,
  /** Payment request response (Unicity custom - 31116) */
  PAYMENT_REQUEST_RESPONSE: 31116,
  /** Nametag binding (NIP-78 app-specific data) */
  NAMETAG_BINDING: 30078,
  /** Public broadcast */
  BROADCAST: 1,
} as const;

/**
 * NIP-29 Event Kinds for relay-based group chat
 * https://github.com/nostr-protocol/nips/blob/master/29.md
 */
export const NIP29_KINDS = {
  /** Chat message sent to group */
  CHAT_MESSAGE: 9,
  /** Thread root message */
  THREAD_ROOT: 11,
  /** Thread reply message */
  THREAD_REPLY: 12,
  /** User join request */
  JOIN_REQUEST: 9021,
  /** User leave request */
  LEAVE_REQUEST: 9022,
  /** Admin: add/update user */
  PUT_USER: 9000,
  /** Admin: remove user */
  REMOVE_USER: 9001,
  /** Admin: edit group metadata */
  EDIT_METADATA: 9002,
  /** Admin: delete event */
  DELETE_EVENT: 9005,
  /** Admin: create group */
  CREATE_GROUP: 9007,
  /** Admin: delete group */
  DELETE_GROUP: 9008,
  /** Admin: create invite code */
  CREATE_INVITE: 9009,
  /** Relay-signed group metadata */
  GROUP_METADATA: 39000,
  /** Relay-signed group admins */
  GROUP_ADMINS: 39001,
  /** Relay-signed group members */
  GROUP_MEMBERS: 39002,
  /** Relay-signed group roles */
  GROUP_ROLES: 39003,
} as const;

// =============================================================================
// Aggregator (Oracle) Defaults
// =============================================================================

/**
 * Default aggregator URL
 * Note: The aggregator is conceptually an oracle - a trusted service that provides
 * verifiable truth about token state through cryptographic inclusion proofs.
 */
export const DEFAULT_AGGREGATOR_URL = 'https://aggregator.unicity.network/rpc' as const;

/** Dev aggregator URL */
export const DEV_AGGREGATOR_URL = 'https://dev-aggregator.dyndns.org/rpc' as const;

/** Test aggregator URL (Goggregator) */
export const TEST_AGGREGATOR_URL = 'https://goggregator-test.unicity.network' as const;

/** Default aggregator request timeout (ms) */
export const DEFAULT_AGGREGATOR_TIMEOUT = 30000;

/** Default API key for aggregator authentication */
export const DEFAULT_AGGREGATOR_API_KEY = 'sk_06365a9c44654841a366068bcfc68986' as const;

// =============================================================================
// IPFS Defaults
// =============================================================================

/** Default IPFS gateways */
export const DEFAULT_IPFS_GATEWAYS = [
  'https://unicity-ipfs1.dyndns.org',
] as const;

/** Unicity IPFS bootstrap peers */
export const DEFAULT_IPFS_BOOTSTRAP_PEERS = [
  '/dns4/unicity-ipfs2.dyndns.org/tcp/4001/p2p/12D3KooWLNi5NDPPHbrfJakAQqwBqymYTTwMQXQKEWuCrJNDdmfh',
  '/dns4/unicity-ipfs3.dyndns.org/tcp/4001/p2p/12D3KooWQ4aujVE4ShLjdusNZBdffq3TbzrwT2DuWZY9H1Gxhwn6',
  '/dns4/unicity-ipfs4.dyndns.org/tcp/4001/p2p/12D3KooWJ1ByPfUzUrpYvgxKU8NZrR8i6PU1tUgMEbQX9Hh2DEn1',
  '/dns4/unicity-ipfs5.dyndns.org/tcp/4001/p2p/12D3KooWB1MdZZGHN5B8TvWXntbycfe7Cjcz7n6eZ9eykZadvmDv',
] as const;

/** Unicity dedicated IPFS nodes (HTTP API access) */
export const UNICITY_IPFS_NODES = [
  {
    host: 'unicity-ipfs1.dyndns.org',
    peerId: '12D3KooWDKJqEMAhH4nsSSiKtK1VLcas5coUqSPZAfbWbZpxtL4u',
    httpPort: 9080,
    httpsPort: 443,
  },
] as const;

/**
 * Get IPFS gateway URLs for HTTP API access.
 * @param isSecure - Use HTTPS (default: true). Set false for development.
 */
export function getIpfsGatewayUrls(isSecure?: boolean): string[] {
  return UNICITY_IPFS_NODES.map((node) =>
    isSecure !== false
      ? `https://${node.host}`
      : `http://${node.host}:${node.httpPort}`,
  );
}

// =============================================================================
// Wallet Defaults
// =============================================================================

/** Default BIP32 base path (without chain/index) */
export const DEFAULT_BASE_PATH = "m/44'/0'/0'" as const;

/** Default BIP32 derivation path (full path with chain/index) */
export const DEFAULT_DERIVATION_PATH = `${DEFAULT_BASE_PATH}/0/0` as const;

/** Coin types */
export const COIN_TYPES = {
  /** ALPHA token (L1 blockchain) */
  ALPHA: 'ALPHA',
  /** Test token */
  TEST: 'TEST',
} as const;

// =============================================================================
// L1 (ALPHA Blockchain) Defaults
// =============================================================================

/** Default Fulcrum electrum server for mainnet */
export const DEFAULT_ELECTRUM_URL = 'wss://fulcrum.unicity.network:50004' as const;

/** Testnet Fulcrum electrum server */
export const TEST_ELECTRUM_URL = 'wss://fulcrum.unicity.network:50004' as const;

// =============================================================================
// Token Registry Defaults
// =============================================================================

/** Remote token registry URL (GitHub raw) */
export const TOKEN_REGISTRY_URL =
  'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/unicity-ids.testnet.json' as const;

/** Default token registry refresh interval (ms) — 1 hour */
export const TOKEN_REGISTRY_REFRESH_INTERVAL = 3_600_000;

// =============================================================================
// Network Defaults
// =============================================================================

/** Testnet Nostr relays */
export const TEST_NOSTR_RELAYS = [
  'wss://nostr-relay.testnet.unicity.network',
] as const;

/** Default group chat relays (NIP-29 Zooid relay) */
export const DEFAULT_GROUP_RELAYS = [
  'wss://sphere-relay.unicity.network',
] as const;

/** Network configurations */
export const NETWORKS = {
  mainnet: {
    name: 'Mainnet',
    aggregatorUrl: DEFAULT_AGGREGATOR_URL,
    nostrRelays: DEFAULT_NOSTR_RELAYS,
    ipfsGateways: DEFAULT_IPFS_GATEWAYS,
    electrumUrl: DEFAULT_ELECTRUM_URL,
    groupRelays: DEFAULT_GROUP_RELAYS,
    tokenRegistryUrl: TOKEN_REGISTRY_URL,
  },
  testnet: {
    name: 'Testnet',
    aggregatorUrl: TEST_AGGREGATOR_URL,
    nostrRelays: TEST_NOSTR_RELAYS,
    ipfsGateways: DEFAULT_IPFS_GATEWAYS,
    electrumUrl: TEST_ELECTRUM_URL,
    groupRelays: DEFAULT_GROUP_RELAYS,
    tokenRegistryUrl: TOKEN_REGISTRY_URL,
  },
  dev: {
    name: 'Development',
    aggregatorUrl: DEV_AGGREGATOR_URL,
    nostrRelays: TEST_NOSTR_RELAYS,
    ipfsGateways: DEFAULT_IPFS_GATEWAYS,
    electrumUrl: TEST_ELECTRUM_URL,
    groupRelays: DEFAULT_GROUP_RELAYS,
    tokenRegistryUrl: TOKEN_REGISTRY_URL,
  },
} as const;

export type NetworkType = keyof typeof NETWORKS;
export type NetworkConfig = (typeof NETWORKS)[NetworkType];

// =============================================================================
// Timeouts & Limits
// =============================================================================

/** Default timeouts (ms) */
export const TIMEOUTS = {
  /** WebSocket connection timeout */
  WEBSOCKET_CONNECT: 10000,
  /** Nostr relay reconnect delay */
  NOSTR_RECONNECT_DELAY: 3000,
  /** Max reconnect attempts */
  MAX_RECONNECT_ATTEMPTS: 5,
  /** Proof polling interval */
  PROOF_POLL_INTERVAL: 1000,
  /** Sync interval */
  SYNC_INTERVAL: 60000,
} as const;

// =============================================================================
// Sphere Connect
// =============================================================================

/** Signal sent by wallet popup to dApp when ConnectHost is ready */
export const HOST_READY_TYPE = 'sphere-connect:host-ready' as const;

/** Default timeout (ms) for waiting for the host-ready signal */
export const HOST_READY_TIMEOUT = 30_000;

/** Validation limits */
export const LIMITS = {
  /** Min nametag length */
  NAMETAG_MIN_LENGTH: 3,
  /** Max nametag length */
  NAMETAG_MAX_LENGTH: 20,
  /** Max memo length */
  MEMO_MAX_LENGTH: 500,
  /** Max message length */
  MESSAGE_MAX_LENGTH: 10000,
} as const;
