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

/** Storage keys for wallet data */
export const STORAGE_KEYS = {
  /** Encrypted BIP39 mnemonic */
  MNEMONIC: `${STORAGE_PREFIX}mnemonic`,
  /** Encrypted master private key */
  MASTER_KEY: `${STORAGE_PREFIX}master_key`,
  /** BIP32 chain code */
  CHAIN_CODE: `${STORAGE_PREFIX}chain_code`,
  /** HD derivation path (full path like m/44'/0'/0'/0/0) */
  DERIVATION_PATH: `${STORAGE_PREFIX}derivation_path`,
  /** Base derivation path (like m/44'/0'/0' without chain/index) */
  BASE_PATH: `${STORAGE_PREFIX}base_path`,
  /** Derivation mode: bip32, wif_hmac, legacy_hmac */
  DERIVATION_MODE: `${STORAGE_PREFIX}derivation_mode`,
  /** Wallet source: mnemonic, file, unknown */
  WALLET_SOURCE: `${STORAGE_PREFIX}wallet_source`,
  /** Wallet existence flag */
  WALLET_EXISTS: `${STORAGE_PREFIX}wallet_exists`,
  /** Registered nametag */
  NAMETAG: `${STORAGE_PREFIX}nametag`,
  /** Token data */
  TOKENS: `${STORAGE_PREFIX}tokens`,
  /** Pending transfers */
  PENDING_TRANSFERS: `${STORAGE_PREFIX}pending_transfers`,
  /** Transfer outbox */
  OUTBOX: `${STORAGE_PREFIX}outbox`,
  /** Conversations */
  CONVERSATIONS: `${STORAGE_PREFIX}conversations`,
  /** Messages */
  MESSAGES: `${STORAGE_PREFIX}messages`,
  /** Transaction history */
  TRANSACTION_HISTORY: `${STORAGE_PREFIX}transaction_history`,
  /** Archived tokens (spent token history) */
  ARCHIVED_TOKENS: `${STORAGE_PREFIX}archived_tokens`,
  /** Tombstones (records of deleted/spent tokens) */
  TOMBSTONES: `${STORAGE_PREFIX}tombstones`,
  /** Forked tokens (alternative histories) */
  FORKED_TOKENS: `${STORAGE_PREFIX}forked_tokens`,
} as const;

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

/** Nostr event kinds used by SDK */
export const NOSTR_EVENT_KINDS = {
  /** NIP-04 encrypted direct message */
  DIRECT_MESSAGE: 4,
  /** Token transfer (custom) */
  TOKEN_TRANSFER: 21000,
  /** Payment request (custom) */
  PAYMENT_REQUEST: 21001,
  /** Payment request response (custom) */
  PAYMENT_REQUEST_RESPONSE: 21002,
  /** Nametag binding (custom NIP-30078 replaceable) */
  NAMETAG_BINDING: 30078,
  /** Public broadcast */
  BROADCAST: 1,
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

// =============================================================================
// IPFS Defaults
// =============================================================================

/** Default IPFS gateways */
export const DEFAULT_IPFS_GATEWAYS = [
  'https://ipfs.unicity.network',
  'https://dweb.link',
  'https://ipfs.io',
] as const;

/** Unicity IPFS bootstrap peers */
export const DEFAULT_IPFS_BOOTSTRAP_PEERS = [
  '/dns4/unicity-ipfs2.dyndns.org/tcp/4001/p2p/12D3KooWLNi5NDPPHbrfJakAQqwBqymYTTwMQXQKEWuCrJNDdmfh',
  '/dns4/unicity-ipfs3.dyndns.org/tcp/4001/p2p/12D3KooWQ4aujVE4ShLjdusNZBdffq3TbzrwT2DuWZY9H1Gxhwn6',
  '/dns4/unicity-ipfs4.dyndns.org/tcp/4001/p2p/12D3KooWJ1ByPfUzUrpYvgxKU8NZrR8i6PU1tUgMEbQX9Hh2DEn1',
  '/dns4/unicity-ipfs5.dyndns.org/tcp/4001/p2p/12D3KooWB1MdZZGHN5B8TvWXntbycfe7Cjcz7n6eZ9eykZadvmDv',
] as const;

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
// Network Defaults
// =============================================================================

/** Network configurations */
export const NETWORKS = {
  mainnet: {
    name: 'Mainnet',
    aggregatorUrl: DEFAULT_AGGREGATOR_URL,
    nostrRelays: DEFAULT_NOSTR_RELAYS,
    ipfsGateways: DEFAULT_IPFS_GATEWAYS,
  },
  testnet: {
    name: 'Testnet',
    aggregatorUrl: TEST_AGGREGATOR_URL,
    nostrRelays: DEFAULT_NOSTR_RELAYS,
    ipfsGateways: DEFAULT_IPFS_GATEWAYS,
  },
  dev: {
    name: 'Development',
    aggregatorUrl: DEV_AGGREGATOR_URL,
    nostrRelays: ['wss://relay.damus.io'],
    ipfsGateways: DEFAULT_IPFS_GATEWAYS,
  },
} as const;

export type NetworkType = keyof typeof NETWORKS;

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
