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
  /** Last processed Nostr DM (gift-wrap) event timestamp (unix seconds), keyed per pubkey */
  LAST_DM_EVENT_TS: 'last_dm_event_ts',
  /**
   * Issue #275 — persistent dedup for Nostr wallet event IDs that have
   * been SUCCESSFULLY processed (cursor advanced). Keyed per pubkey;
   * stored as a JSON string array bounded by
   * `LIMITS.PROCESSED_EVENT_IDS_CAP` (FIFO eviction).
   *
   * Distinct from in-memory `inFlightEventIds`: this set persists across
   * process restarts so cross-process CLI invocations don't re-walk the
   * full relay backlog. At-least-once is preserved because we ONLY add
   * to this set after the event's cursor was advanced (durability ok
   * or replay budget exhausted), never after a transient failure.
   */
  PROCESSED_WALLET_EVENT_IDS: 'processed_wallet_event_ids',
  /**
   * Issue #275 — persistent durability-cooldown ledger for
   * TOKEN_TRANSFER events. Tracks `attempts` and `nextRetryAt` across
   * process restarts so the bounded replay budget
   * (`DURABILITY_MAX_REPLAY_ATTEMPTS = 3`) accumulates across CLI
   * invocations rather than resetting per-process.
   */
  FAILED_EVENT_COOLDOWNS: 'failed_event_cooldowns',
  /**
   * Issue #275 — persistent dedup set for the MultiAddressTransportMux
   * level. The Mux maintains its own `processedEventIds` (independent
   * of NostrTransportProvider's set) and dispatches to per-address
   * adapters. Without persistence, every fresh CLI invocation
   * re-walked the relay backlog through the Mux path as well as the
   * outer-provider path. Bounded by `LIMITS.PROCESSED_EVENT_IDS_CAP`.
   * Per-wallet storage scope: each Sphere instance has its own
   * `storage` provider, so a bare global key is sufficient (no
   * per-pubkey suffix needed because the Mux spans all per-wallet
   * addresses).
   */
  MUX_PROCESSED_EVENT_IDS: 'mux_processed_event_ids',
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
  /**
   * CID whose CAR is pinned + OrbitDB ref written but whose aggregator
   * pointer publish is pending due to a transient failure. Persisted
   * so a process restart resumes the retry rather than abandoning the
   * publish (which would leave cross-device peers unable to discover
   * the bundle via the aggregator path). Per-address suffix appended
   * by the Profile provider (`<key>_<addressId>`).
   */
  PROFILE_PENDING_PUBLISH_CID: 'profile_pending_publish_cid',
  /**
   * Issue #454 finding #2 — SIGKILL recovery marker for the Issue #444
   * `skipPublish` (local-only flush) path.
   *
   * `awaitNextLocalFlush` intentionally skips the aggregator pointer
   * publish and schedules a deferred publish via the dirty-flush
   * debouncer (`notifyProfileDirty()`). The in-process drain in
   * {@link ProfileTokenStorageProvider.shutdown} handles graceful
   * exits; a SIGKILL (or hard crash) during the debounce window
   * leaves no `pendingPublishCid` marker (the BUNDLE CID alone is
   * insufficient — pendingPublishCid stores SNAPSHOT CIDs that the
   * pointer layer expects).
   *
   * This sibling marker is a boolean flag: presence ⇒ "a deferred
   * publish is owed for the most recent local-only flush". Set inside
   * the `skipPublish` branch of `__flushToIpfsBody` after the bundle
   * ref is durably written; cleared after a successful snapshot
   * publish via the dirty-flush callback or a same-CID `pendingPublishCid`
   * retry. On the next process boot, `initialize()` restores the flag
   * and triggers a deferred `publishSnapshotIfWired()` (best-effort)
   * so siblings discover the bundle without waiting for the next
   * local mutation to drive a save-side flush.
   *
   * Per-address suffix appended by the Profile provider
   * (`<key>_<addressId>`). Value: literal "1" for set, key absent for
   * unset.
   */
  PROFILE_PENDING_DEFERRED_PUBLISH: 'profile_pending_deferred_publish',
  /**
   * Issue #313 — local snapshot blob for cold-boot lazy load. Holds the
   * most recent in-memory state (identity, tokens, bundles, pointer,
   * timestamps) so the next cold boot can render the wallet UI from
   * local cache BEFORE connecting to aggregator / remote IPFS. Atomically
   * replaced after every successful flush + publish and on graceful
   * shutdown. Per-address suffix appended by the Profile provider
   * (`<key>_<addressId>`).
   *
   * A companion key `<key>_<addressId>_pending` is written first; the
   * swap to the main key happens via `setMany` (or a sequential fallback
   * with explicit cleanup). Crash mid-write leaves the previous main
   * key intact.
   */
  PROFILE_SNAPSHOT_BLOB: 'profile_snapshot_blob',
  /**
   * Issue #313 — last-known aggregator pointer for cold-boot priming.
   * Mirrors the `pointer` field embedded in the snapshot blob so the
   * boot path can short-circuit a pointer fetch when the cached version
   * matches what the aggregator now exposes. Per-address suffix appended
   * by the Profile provider (`<key>_<addressId>`).
   *
   * Stored as JSON: `{ version: number, cid: string, epoch?: number, ts: number }`.
   */
  PROFILE_LAST_POINTER: 'profile_last_pointer',
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
  /** Processed V6 combined transfer IDs for Nostr re-delivery dedup */
  PROCESSED_COMBINED_TRANSFER_IDS: 'processed_combined_transfer_ids',
  // Invoice / Accounting storage keys
  /** Set of cancelled invoice IDs (JSON string array) */
  CANCELLED_INVOICES: 'cancelled_invoices',
  /** Set of closed invoice IDs (JSON string array) */
  CLOSED_INVOICES: 'closed_invoices',
  /** Frozen balances for terminated invoices (JSON map: invoiceId → FrozenInvoiceBalances) */
  FROZEN_BALANCES: 'frozen_balances',
  /** Auto-return settings (JSON: AutoReturnSettings) */
  AUTO_RETURN: 'auto_return',
  /** Auto-return dedup ledger (JSON: AutoReturnLedger) */
  AUTO_RETURN_LEDGER: 'auto_return_ledger',
  /** Invoice-transfer index metadata (JSON: Record<invoiceId, { terminated, frozenAt? }>) */
  INV_LEDGER_INDEX: 'inv_ledger_index',
  /** Token scan state watermarks (JSON: Record<tokenId, txCount>) */
  TOKEN_SCAN_STATE: 'token_scan_state',
  /**
   * Persisted NOSTR-FIRST proof-polling jobs. Issue #144: the in-memory
   * `proofPollingJobs` Map dies with the process; on CLI usage every
   * `sphere <cmd>` is a fresh Node.js process, so V6-direct receives
   * whose proof arrives later never finalize. We persist enough state
   * (genesisTokenId, stateHash, requestIdHex, commitmentJson,
   * sourceTokenJson) to re-fire `finalizeReceivedToken` on next load().
   */
  PROOF_POLLING_JOBS: 'proof_polling_jobs',
  /**
   * Issue #378 (#275 P4) — persistent ledger of V6-RECOVER permanent
   * verdicts. When `finalizeStrandedReceivedToken` hits
   * `permanent recipient-address mismatch (HD-index recovery exhausted)`
   * or `permanent structural failure`, the tokenId is recorded here
   * with the verdict reason + timestamp.
   *
   * Read by `drainPendingFinalizations` (and the V6-RECOVER stranded
   * scan at `handleStrandedReceive`) so subsequent `sphere balance` /
   * `sphere payments receive` invocations skip the 60s drain timeout
   * for already-failed tokens.
   *
   * Cleared by `Sphere.clear()` (full wallet wipe) and by an explicit
   * `payments receive --finalize` (operator-forced retry — gives the
   * token one more shot at finalization in case the HD-index window
   * has since widened).
   */
  V6_RECOVER_PERMANENT: 'v6_recover_permanent',
  // Swap storage keys
  /** Per-swap key: swap:{swapId} */
  SWAP_RECORD_PREFIX: 'swap:',
  /** Lightweight index array for listing */
  SWAP_INDEX: 'swap_index',
  // UXF inter-wallet transfer protocol storage keys (T.0.G7-fill-gaps)
  /**
   * Audit collection for structurally-valid-but-unspendable tokens
   * (NOT_OUR_CURRENT_STATE / UNSPENDABLE_BY_US dispositions). Stored
   * with composite id `${tokenId}.${observedTokenContentHash}` per
   * PROFILE-ARCHITECTURE.md §10.10 / canonical UXF-TRANSFER-PROTOCOL §5.4.
   * The per-entry-key writer treats the id as opaque — T.1.E declares
   * the specific composite-id shape.
   */
  AUDIT: 'audit',
  /**
   * Finalization queue for pending chain-mode transactions, keyed by
   * the request id. Persists across process restarts per
   * UXF-TRANSFER-PROTOCOL §5.5.
   */
  FINALIZATION_QUEUE: 'finalizationQueue',
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

/** Test aggregator URL (Goggregator — v1 protocol, retired once Phase 6.C rewires core to v2) */
export const TEST_AGGREGATOR_URL = 'https://goggregator-test.unicity.network' as const;

/**
 * testnet2 gateway URL — v2 state-transition SDK protocol.
 *
 * Adopted from unicity-sphere/sphere-sdk main@ce758f6b as the mandatory
 * network for Phase 6 (STSDK v1→v2 swap). The `token-engine/` adapter (see
 * repo-root `token-engine/` — SHA-pinned) speaks this endpoint's
 * certification RPC; the v1 aggregator at `goggregator-test.unicity.network`
 * cannot serve a v2 client (different wire protocol, per
 * scratchpad/investigation-stsdk-v2.md §2c).
 *
 * Wired into `NETWORKS.testnet2` below. Not yet consumed by anything in
 * core — Phase 6.C rewire is pending.
 */
export const TESTNET2_GATEWAY_URL = 'https://gateway.testnet2.unicity.network' as const;

/**
 * testnet2 root trust base — raw GitHub URL, per mainstream's convention
 * (referenced by execution-plan-v2 §7 R3). The v2 engine's
 * `NetworkId` is taken from `RootTrustBase.networkId` in this JSON
 * (testnet2 = 4). Fetched lazily when the engine is constructed; not held
 * in-memory as a constant.
 */
export const TESTNET2_TRUST_BASE_URL =
  'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/bft-trustbase.testnet2.json' as const;

/**
 * testnet2 token registry URL (v2). Distinct from `TOKEN_REGISTRY_URL`
 * (mainnet/testnet1 v1 endpoint).
 */
export const TESTNET2_TOKEN_REGISTRY_URL =
  'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/unicity-ids.testnet2.json' as const;

/** Default aggregator request timeout (ms) */
export const DEFAULT_AGGREGATOR_TIMEOUT = 30000;

/** Default API key for aggregator authentication */
export const DEFAULT_AGGREGATOR_API_KEY = 'sk_06365a9c44654841a366068bcfc68986' as const;

// =============================================================================
// IPFS Defaults
// =============================================================================

/**
 * Built-in (compiled-in) IPFS gateway list. Kept as a separate constant so
 * tests and consumers that need to compare against the static defaults can do
 * so without going through {@link DEFAULT_IPFS_GATEWAYS} (which honors the
 * `SPHERE_IPFS_GATEWAY` env override).
 */
export const BUILTIN_IPFS_GATEWAYS = [
  'https://unicity-ipfs1.dyndns.org',
] as const;

/**
 * Parse the `SPHERE_IPFS_GATEWAY` env override into a non-empty URL list,
 * or `null` when the env var is unset/empty.
 *
 * Accepts a single URL or a comma-separated list. Whitespace around entries
 * is trimmed; empty entries are dropped. The Node-only guard (`typeof
 * process !== 'undefined'`) keeps this safe under the browser bundle, where
 * `process` is undefined.
 *
 * Why it lives here: the override targets the testnet IPFS gateway outage
 * (issue #154) so e2e suites can point at an alternate gateway without
 * patching factories. Reading at module init means every downstream consumer
 * (`NETWORKS[*].ipfsGateways`, `getIpfsGatewayUrls()`, the deprecated
 * `IpfsStorageProvider` ctor) inherits the override automatically.
 */
function readIpfsGatewayEnvOverride(): readonly string[] | null {
  if (typeof process === 'undefined' || typeof process.env === 'undefined') {
    return null;
  }
  const raw = process.env.SPHERE_IPFS_GATEWAY;
  if (!raw) return null;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : null;
}

const ENV_IPFS_GATEWAYS = readIpfsGatewayEnvOverride();

/**
 * Default IPFS gateways.
 *
 * Honors the `SPHERE_IPFS_GATEWAY` env override (single URL or comma-separated
 * list) when present, falling back to {@link BUILTIN_IPFS_GATEWAYS}. The
 * override is evaluated once at module load, so it must be set BEFORE
 * `@unicitylabs/sphere-sdk` is imported (e2e runners and CI set this in the
 * shell or vitest globalSetup).
 */
export const DEFAULT_IPFS_GATEWAYS: readonly string[] =
  ENV_IPFS_GATEWAYS ?? BUILTIN_IPFS_GATEWAYS;

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
 *
 * If `SPHERE_IPFS_GATEWAY` is set, returns the override list verbatim — the
 * caller is responsible for using a scheme/port compatible with their needs.
 * Otherwise derives URLs from {@link UNICITY_IPFS_NODES}.
 *
 * @param isSecure - Use HTTPS (default: true). Set false for development.
 *                   Ignored when the env override is in effect.
 */
export function getIpfsGatewayUrls(isSecure?: boolean): string[] {
  if (ENV_IPFS_GATEWAYS) return [...ENV_IPFS_GATEWAYS];
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
  /** Test token */
  TEST: 'TEST',
} as const;

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
    groupRelays: DEFAULT_GROUP_RELAYS,
    tokenRegistryUrl: TOKEN_REGISTRY_URL,
  },
  testnet: {
    name: 'Testnet',
    aggregatorUrl: TEST_AGGREGATOR_URL,
    nostrRelays: TEST_NOSTR_RELAYS,
    ipfsGateways: DEFAULT_IPFS_GATEWAYS,
    groupRelays: DEFAULT_GROUP_RELAYS,
    tokenRegistryUrl: TOKEN_REGISTRY_URL,
  },
  // Phase 6 (STSDK v1→v2). testnet2 is a NEW key alongside `testnet` so both
  // remain resolvable until the core rewire is complete. Only the `token-engine/`
  // adapter can consume this endpoint (it speaks the v2 certification RPC); the
  // v1 aggregator objects (RequestId/Authenticator/SubmitCommitmentRequest) that
  // core code still uses cannot talk to it. Phase 6.C flips consumers from
  // `testnet` → `testnet2` once the rewire lands. Kept separate — mainstream
  // aliases `testnet` to testnet2, but we cannot until v1 is out of core.
  testnet2: {
    name: 'Testnet2 (v2 gateway)',
    aggregatorUrl: TESTNET2_GATEWAY_URL,
    // testnet2 gateway API key (Phase 6). NOT a secret — testnet2 keys are safe
    // to embed. A MAINNET key, by contrast, IS a secret and must be
    // env-injected via SphereInitOptions.tokenEngine.apiKey.
    aggregatorApiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590',
    // Root-trust-base JSON URL (Phase 6). The v2 SphereTokenEngine takes its
    // NetworkId from `RootTrustBase.networkId` in this JSON (testnet2 = 4).
    trustBaseUrl: TESTNET2_TRUST_BASE_URL,
    nostrRelays: TEST_NOSTR_RELAYS,
    ipfsGateways: DEFAULT_IPFS_GATEWAYS,
    groupRelays: DEFAULT_GROUP_RELAYS,
    tokenRegistryUrl: TESTNET2_TOKEN_REGISTRY_URL,
  },
  dev: {
    name: 'Development',
    aggregatorUrl: DEV_AGGREGATOR_URL,
    nostrRelays: TEST_NOSTR_RELAYS,
    ipfsGateways: DEFAULT_IPFS_GATEWAYS,
    groupRelays: DEFAULT_GROUP_RELAYS,
    tokenRegistryUrl: TOKEN_REGISTRY_URL,
  },
} as const;

export type NetworkType = keyof typeof NETWORKS;
export type NetworkConfig = (typeof NETWORKS)[NetworkType];

/**
 * Default escrow service address for the swap module.
 *
 * Used as the fallback when neither the per-deal `escrowAddress` nor the
 * module-level `SwapModuleConfig.defaultEscrowAddress` is set. Hardcoded here
 * so a wallet initialised with `swap: true` (no explicit escrow override) can
 * still propose / accept swaps without per-call wiring.
 *
 * Versioned suffix so a future operator rotation (e.g. when the production
 * escrow daemon's transport key changes and the old binding is no longer
 * recoverable) can publish a new nametag (`-02`, `-03`, ...) without
 * breaking older SDK builds that still reference the previous default.
 *
 * Tracked in sphere-sdk#456:
 *   - `@escrow-testnet`    — original default; the production daemon never
 *                            published it (operator missed the env var).
 *   - `@escrow-testnet-v1` — first rotation attempt; landed on the production
 *                            tenant's secondary HD address via custom
 *                            multi-address routing, but the routing had
 *                            subtle relay-subscription gaps.
 *   - `@escrow-test-01`    — second rotation attempt; squatted on the relay
 *                            by a failed boot whose binding published before
 *                            it crashed (Nostr first-seen-wins anti-hijacking).
 *   - `@escrow-test-02`    — current default. Owned by a freshly-initialised
 *                            escrow tenant wallet so the nametag is the
 *                            tenant's sole primary identity — no
 *                            cross-address routing needed.
 */
export const DEFAULT_ESCROW_ADDRESS = '@escrow-test-02' as const;

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
export const INVOICE_TOKEN_TYPE_HEX = '14676a280bda4275baf865b67cd4c611bcd58c9bf8226d508acaa10a8fcaccc6' as const;

export const LIMITS = {
  /** Min nametag length */
  NAMETAG_MIN_LENGTH: 3,
  /** Max nametag length */
  NAMETAG_MAX_LENGTH: 20,
  /** Max memo length */
  MEMO_MAX_LENGTH: 500,
  /** Max message length */
  MESSAGE_MAX_LENGTH: 10000,
  /**
   * Issue #275 — FIFO cap for persisted dedup IDs in
   * `STORAGE_KEYS_GLOBAL.PROCESSED_WALLET_EVENT_IDS`. Sized for several
   * days of Nostr relay retention (typical relay holds 1-7 days). A
   * 10k cap at ~70 bytes per id is ~700KB serialized — well under
   * IndexedDB / file storage budgets.
   */
  PROCESSED_EVENT_IDS_CAP: 10_000,
  /**
   * Issue #275 — debounce interval for persisted dedup-set flushes.
   * Coalesces rapid arrivals (e.g., EOSE replay burst of N events) into
   * a single storage write rather than N writes. 200ms matches the
   * proven pattern in `GroupChatModule.persistProcessedEvents`.
   */
  PROCESSED_EVENT_IDS_FLUSH_MS: 200,
} as const;
