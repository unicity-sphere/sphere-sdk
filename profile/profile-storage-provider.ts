/**
 * ProfileStorageProvider — Drop-in replacement for IndexedDBStorageProvider
 * and FileStorageProvider that backs the Profile KV table with OrbitDB.
 *
 * Composes an existing StorageProvider (IndexedDB or file-based) as a local
 * cache with OrbitDB as the durable, replicated store. The provider translates
 * legacy sphere_* key names to Profile dot-notation keys using the mapping
 * table from types.ts.
 *
 * @see PROFILE-ARCHITECTURE.md Sections 3.2, 3.3, 5.1, 5.2
 * @module profile/profile-storage-provider
 */

import type { ProviderStatus, FullIdentity, TrackedAddressEntry } from '../types';
import type { StorageProvider } from '../storage/storage-provider';
import { STORAGE_KEYS_ADDRESS, STORAGE_PREFIX } from '../constants';
import {
  type ProfileDatabase,
  type ProfileStorageProviderOptions,
  PROFILE_KEY_MAPPING,
  CACHE_ONLY_KEYS,
  IPFS_STATE_KEYS_PATTERN,
} from './types';
import { ProfileError } from './errors';
import { deriveProfileEncryptionKey, encryptString, decryptString } from './encryption';

// =============================================================================
// Constants
// =============================================================================

/** Profile key used to signal a wallet clear across devices. */
const PROFILE_CLEARED_KEY = 'profile.cleared';

/** Profile key for tracked addresses. */
const TRACKED_ADDRESSES_PROFILE_KEY = 'addresses.tracked';

/**
 * Dynamic transport key patterns.
 * These are global keys with a pubkey suffix: `last_wallet_event_ts_{hex}`.
 */
const TRANSPORT_KEY_PATTERNS: ReadonlyArray<{
  readonly legacyPrefix: string;
  readonly profilePrefix: string;
}> = [
  { legacyPrefix: 'last_wallet_event_ts_', profilePrefix: 'transport.lastWalletEventTs.' },
  { legacyPrefix: 'last_dm_event_ts_', profilePrefix: 'transport.lastDmEventTs.' },
];

/**
 * Regex matching per-address swap keys: `{addr}_swap:{swapId}`.
 * Captures the address ID and swap ID.
 */
const SWAP_KEY_PATTERN = /^(.+)_swap:(.+)$/;

// =============================================================================
// Key Mapping Utilities
// =============================================================================

/**
 * Result of translating a legacy key to its Profile equivalent.
 */
interface TranslatedKey {
  /** The Profile key name (dot-notation). */
  readonly profileKey: string;
  /** Whether this key should be stored only in the local cache (never in OrbitDB). */
  readonly cacheOnly: boolean;
  /** Whether this key is an IPFS state key that should be excluded entirely. */
  readonly excluded: boolean;
}

/**
 * Cached set of per-address key names from STORAGE_KEYS_ADDRESS for fast lookup.
 */
const PER_ADDRESS_KEYS: ReadonlySet<string> = new Set(
  Object.values(STORAGE_KEYS_ADDRESS),
);

/**
 * Translate a legacy storage key (as passed by callers) to a Profile key.
 *
 * Incoming keys may be:
 * - A global key: `'mnemonic'`, `'wallet_exists'`
 * - A per-address key: `'pending_transfers'` (address ID added by getFullKey
 *   in the original provider, but here the caller passes the raw key and the
 *   provider internally prefixes with addressId)
 * - A dynamic transport key: `'last_wallet_event_ts_abc123'`
 * - A dynamic swap key: `'{addr}_swap:{swapId}'`
 * - A raw key already including the address prefix: `'{addr}_pending_transfers'`
 *
 * The IndexedDBStorageProvider stores keys as `sphere_{key}` or
 * `sphere_{addressId}_{key}`. Since it internally adds the prefix, callers
 * pass keys WITHOUT the `sphere_` prefix. However, `keys()` returns them
 * without the prefix too.
 *
 * @param key - The raw key as passed to get/set/remove/has
 * @param addressId - The current address ID (for per-address key detection)
 * @returns The translated key info, or null if the key cannot be mapped
 */
function translateKey(key: string, addressId: string | null): TranslatedKey {
  // 1. Strip `sphere_` prefix if present (defensive — callers normally don't include it)
  let stripped = key;
  if (stripped.startsWith(STORAGE_PREFIX)) {
    stripped = stripped.slice(STORAGE_PREFIX.length);
  }

  // 2. Check for IPFS state keys (excluded from both cache and OrbitDB)
  if (IPFS_STATE_KEYS_PATTERN.test(stripped)) {
    return { profileKey: stripped, cacheOnly: false, excluded: true };
  }

  // 3. Check dynamic transport keys (global, with pubkey suffix)
  for (const tp of TRANSPORT_KEY_PATTERNS) {
    if (stripped.startsWith(tp.legacyPrefix)) {
      const suffix = stripped.slice(tp.legacyPrefix.length);
      return { profileKey: `${tp.profilePrefix}${suffix}`, cacheOnly: false, excluded: false };
    }
  }

  // 4. Check for per-address key with explicit address prefix: `{addr}_{key}`
  //    This handles keys returned by keys() or used with explicit address scoping.
  const addrSepIdx = findAddressSeparator(stripped);
  if (addrSepIdx !== -1) {
    const addrPart = stripped.slice(0, addrSepIdx);
    const keyPart = stripped.slice(addrSepIdx + 1);

    // Check for swap dynamic pattern: `{addr}_swap:{swapId}`
    // The keyPart would be `swap:{swapId}`
    if (keyPart.startsWith('swap:')) {
      return { profileKey: `${addrPart}.${keyPart}`, cacheOnly: false, excluded: false };
    }

    // Look up the key part in the static mapping
    const mapping = PROFILE_KEY_MAPPING[keyPart];
    if (mapping) {
      const profileKey = mapping.profileKey.replace('{addr}', addrPart);
      const cacheOnly = CACHE_ONLY_KEYS.has(keyPart);
      return { profileKey, cacheOnly, excluded: false };
    }

    // Unknown per-address key — pass through with dot notation
    return { profileKey: `${addrPart}.${keyPart}`, cacheOnly: false, excluded: false };
  }

  // 5. Check for per-address key WITHOUT address prefix (caller relies on
  //    the provider to add the address ID, like IndexedDBStorageProvider does)
  if (PER_ADDRESS_KEYS.has(stripped) && addressId) {
    const mapping = PROFILE_KEY_MAPPING[stripped];
    if (mapping && mapping.dynamic) {
      const profileKey = mapping.profileKey.replace('{addr}', addressId);
      return { profileKey, cacheOnly: false, excluded: false };
    }
  }

  // 6. Check for swap key without explicit address: `swap:{swapId}`
  //    (unlikely but defensive)
  if (stripped.startsWith('swap:') && addressId) {
    return { profileKey: `${addressId}.${stripped}`, cacheOnly: false, excluded: false };
  }

  // 7. Check global static mapping
  const globalMapping = PROFILE_KEY_MAPPING[stripped];
  if (globalMapping) {
    const cacheOnly = CACHE_ONLY_KEYS.has(stripped);
    // For dynamic global keys that weren't caught above (should not happen),
    // substitute addressId if available
    let profileKey = globalMapping.profileKey;
    if (globalMapping.dynamic && addressId) {
      profileKey = profileKey.replace('{addr}', addressId);
    }
    return { profileKey, cacheOnly, excluded: false };
  }

  // 8. No mapping found — pass through as-is (unknown key)
  return { profileKey: stripped, cacheOnly: false, excluded: false };
}

/**
 * Find the separator index between the address ID and the key part.
 * Address IDs look like `DIRECT_abc123_xyz789`, so we need to find the
 * underscore that separates the address ID from the key name.
 *
 * Strategy: look for `DIRECT_` prefix. If present, the address ID is
 * `DIRECT_xxxxxx_yyyyyy` (21 chars), and the separator is at index 21.
 */
function findAddressSeparator(key: string): number {
  if (!key.startsWith('DIRECT_')) {
    // Could be a key with a non-standard address prefix.
    // Fall back to the swap pattern check.
    const swapMatch = SWAP_KEY_PATTERN.exec(key);
    if (swapMatch) {
      return swapMatch[1].length;
    }
    return -1;
  }

  // DIRECT_xxxxxx_yyyyyy_ — the address ID is `DIRECT_` + 6 chars + `_` + 6 chars = 20 chars
  // So the separator underscore is at index 20
  const expectedSepIdx = 20; // length of "DIRECT_xxxxxx_yyyyyy"
  if (key.length > expectedSepIdx && key[expectedSepIdx] === '_') {
    return expectedSepIdx;
  }

  return -1;
}

/**
 * Build a reverse mapping from Profile key to legacy key format.
 * Used by `keys()` to return keys in the format callers expect.
 */
function reverseMapProfileKey(profileKey: string): string {
  // Check transport keys
  for (const tp of TRANSPORT_KEY_PATTERNS) {
    if (profileKey.startsWith(tp.profilePrefix)) {
      const suffix = profileKey.slice(tp.profilePrefix.length);
      return `${tp.legacyPrefix}${suffix}`;
    }
  }

  // Check swap keys: `{addr}.swap:{swapId}` -> `{addr}_swap:{swapId}`
  const swapDotIdx = profileKey.indexOf('.swap:');
  if (swapDotIdx !== -1) {
    const addr = profileKey.slice(0, swapDotIdx);
    const rest = profileKey.slice(swapDotIdx + 1);
    return `${addr}_${rest}`;
  }

  // Iterate static mappings (build reverse map on first call)
  const reverseEntry = getReverseMapping(profileKey);
  if (reverseEntry) {
    return reverseEntry;
  }

  // Unknown key — return as-is
  return profileKey;
}

/**
 * Lazily built reverse mapping from profile key patterns to legacy key names.
 */
let reverseMappingCache: Map<string, string> | null = null;

/**
 * Per-address profile key prefix patterns to their legacy key suffix.
 * E.g., `.pendingTransfers` -> `pending_transfers`
 */
let perAddressReverseCache: Array<{ suffix: string; legacyKey: string }> | null = null;

function buildReverseMapping(): void {
  reverseMappingCache = new Map();
  perAddressReverseCache = [];

  for (const [legacyKey, entry] of Object.entries(PROFILE_KEY_MAPPING)) {
    if (entry.dynamic) {
      // Per-address key: extract the suffix after {addr}
      const suffix = entry.profileKey.replace('{addr}', '');
      perAddressReverseCache.push({ suffix, legacyKey });
    } else {
      reverseMappingCache.set(entry.profileKey, legacyKey);
    }
  }
}

function getReverseMapping(profileKey: string): string | null {
  if (!reverseMappingCache || !perAddressReverseCache) {
    buildReverseMapping();
  }

  // Check global keys first
  const globalMatch = reverseMappingCache!.get(profileKey);
  if (globalMatch !== undefined) {
    return globalMatch;
  }

  // Check per-address keys: find the address prefix and match suffix
  for (const { suffix, legacyKey } of perAddressReverseCache!) {
    if (profileKey.endsWith(suffix)) {
      const addr = profileKey.slice(0, profileKey.length - suffix.length);
      // Verify the addr part looks like an address ID (starts with DIRECT_)
      if (addr.startsWith('DIRECT_') || addr.length > 0) {
        return `${addr}_${legacyKey}`;
      }
    }
  }

  return null;
}

// =============================================================================
// ProfileStorageProvider
// =============================================================================

/**
 * Storage provider backed by OrbitDB with a local cache layer.
 *
 * Implements the full `StorageProvider` interface as a drop-in replacement
 * for `IndexedDBStorageProvider` or `FileStorageProvider`. Existing code
 * calling `storage.get('mnemonic')` continues to work — the provider
 * translates old key names to Profile key names internally.
 *
 * Constructor takes a local cache provider (existing IndexedDB or file
 * provider), an OrbitDB adapter, and optional configuration.
 */
export class ProfileStorageProvider implements StorageProvider {
  // --- ProviderMetadata ---
  readonly id = 'profile-storage';
  readonly name = 'Profile Storage (OrbitDB)';
  readonly type = 'p2p' as const;
  readonly description = 'OrbitDB-backed profile storage with local cache';

  // --- Internal state ---
  private identity: FullIdentity | null = null;
  private profileEncryptionKey: Uint8Array | null = null;
  private status: ProviderStatus = 'disconnected';
  private addressId: string | null = null;
  private encryptionEnabled: boolean;
  private debug: boolean;
  /** Whether OrbitDB has been connected via this provider. */
  private dbConnected = false;

  constructor(
    private readonly localCache: StorageProvider,
    private readonly db: ProfileDatabase,
    private readonly options?: ProfileStorageProviderOptions,
  ) {
    this.encryptionEnabled = options?.encrypt !== false;
    this.debug = options?.debug ?? false;
  }

  // ===========================================================================
  // BaseProvider Implementation
  // ===========================================================================

  async connect(): Promise<void> {
    if (this.status === 'connected') return;
    this.status = 'connecting';

    try {
      // 1. Open the local cache provider
      await this.localCache.connect();

      // 2. Open OrbitDB via adapter (requires identity to have been set)
      if (this.identity && this.options?.config?.orbitDb) {
        await this.db.connect({
          ...this.options.config.orbitDb,
          privateKey: this.identity.privateKey,
        });
        this.dbConnected = true;
      }

      this.status = 'connected';
      this.log('Connected');
    } catch (err) {
      this.status = 'error';
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `Failed to connect ProfileStorageProvider: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  async disconnect(): Promise<void> {
    this.log('Disconnecting');

    // 1. Close OrbitDB
    try {
      if (this.dbConnected) {
        await this.db.close();
        this.dbConnected = false;
      }
    } catch {
      this.dbConnected = false;
      // best-effort
    }

    // 2. Close local cache
    try {
      await this.localCache.disconnect();
    } catch {
      // best-effort
    }

    this.status = 'disconnected';
    this.log('Disconnected');
  }

  isConnected(): boolean {
    return this.status === 'connected';
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  // ===========================================================================
  // StorageProvider Implementation
  // ===========================================================================

  /**
   * Set identity for scoped storage.
   * Synchronous. Stores identity, derives profileEncryptionKey via HKDF.
   * Does NOT open OrbitDB — that is deferred to `connect()`.
   */
  setIdentity(identity: FullIdentity): void {
    this.identity = identity;

    // Derive the profile encryption key from the private key bytes
    if (this.encryptionEnabled) {
      const privKeyBytes = hexToBytes(identity.privateKey);
      this.profileEncryptionKey = deriveProfileEncryptionKey(privKeyBytes);
    }

    // Compute the address ID for per-address key scoping
    if (identity.directAddress) {
      this.addressId = computeAddressId(identity.directAddress);
    }

    // Forward identity to local cache
    this.localCache.setIdentity(identity);

    this.log('Identity set:', identity.l1Address);
  }

  /**
   * Get value by key.
   * Reads from local cache first. On cache miss, falls back to OrbitDB
   * (decrypt), populates cache, and returns the value.
   */
  async get(key: string): Promise<string | null> {
    const translated = translateKey(key, this.addressId);

    // Excluded keys (IPFS state) — not stored anywhere
    if (translated.excluded) {
      return null;
    }

    // 1. Try local cache first (fast path)
    const cached = await this.localCache.get(key);
    if (cached !== null) {
      return cached;
    }

    // 2. Cache-only keys have no OrbitDB backing
    if (translated.cacheOnly) {
      return null;
    }

    // 3. Fall back to OrbitDB
    if (!this.dbConnected) {
      return null;
    }

    const encrypted = await this.db.get(translated.profileKey);
    if (encrypted === null) {
      return null;
    }

    // 4. Decrypt
    const value = await this.decrypt(encrypted);

    // 5. Populate cache
    try {
      await this.localCache.set(key, value);
    } catch {
      // Cache population failure is non-fatal
    }

    return value;
  }

  /**
   * Set value by key.
   * Cache-only keys are written to local cache only.
   * All other keys are encrypted and written to both local cache AND OrbitDB.
   */
  async set(key: string, value: string): Promise<void> {
    const translated = translateKey(key, this.addressId);

    // Excluded keys — silently drop
    if (translated.excluded) {
      return;
    }

    // 1. Always write to local cache
    await this.localCache.set(key, value);

    // 2. Cache-only keys stop here
    if (translated.cacheOnly) {
      return;
    }

    // 3. Write to OrbitDB (encrypted)
    if (this.dbConnected) {
      const encrypted = await this.encrypt(value);
      await this.db.put(translated.profileKey, encrypted);
    }
  }

  /**
   * Remove key from both cache and OrbitDB.
   */
  async remove(key: string): Promise<void> {
    const translated = translateKey(key, this.addressId);

    if (translated.excluded) {
      return;
    }

    // 1. Remove from local cache
    await this.localCache.remove(key);

    // 2. Remove from OrbitDB
    if (!translated.cacheOnly && this.dbConnected) {
      await this.db.del(translated.profileKey);
    }
  }

  /**
   * Check if key exists.
   * Checks cache first, then OrbitDB.
   * Special handling for `wallet_exists` on cold cache — falls back to
   * checking OrbitDB for `identity.*` keys.
   */
  async has(key: string): Promise<boolean> {
    const translated = translateKey(key, this.addressId);

    if (translated.excluded) {
      return false;
    }

    // 1. Check local cache first
    const inCache = await this.localCache.has(key);
    if (inCache) {
      return true;
    }

    // 2. Cache-only keys — if not in cache, it doesn't exist
    if (translated.cacheOnly) {
      return false;
    }

    // 3. Special case: `wallet_exists` on cold cache
    //    Check OrbitDB for any `identity.*` keys as a fallback
    if (key === 'wallet_exists' || key === `${STORAGE_PREFIX}wallet_exists`) {
      if (this.dbConnected) {
        // Check if the profile was cleared
        const clearedBytes = await this.db.get(PROFILE_CLEARED_KEY);
        if (clearedBytes !== null) {
          const clearedStr = await this.decrypt(clearedBytes);
          if (clearedStr === 'true') {
            return false;
          }
        }

        // Check for identity keys
        const identityKeys = await this.db.all('identity.');
        return identityKeys.size > 0;
      }
      return false;
    }

    // 4. Check OrbitDB
    if (this.dbConnected) {
      const value = await this.db.get(translated.profileKey);
      return value !== null;
    }

    return false;
  }

  /**
   * Get all keys with optional prefix filter.
   * Returns the union of keys from cache and OrbitDB, mapped back to
   * legacy format (with appropriate prefixes for callers to consume).
   */
  async keys(prefix?: string): Promise<string[]> {
    const keySet = new Set<string>();

    // 1. Get keys from local cache
    const cacheKeys = await this.localCache.keys(prefix);
    for (const k of cacheKeys) {
      keySet.add(k);
    }

    // 2. Get keys from OrbitDB and reverse-map to legacy format
    if (this.dbConnected) {
      const allEntries = await this.db.all();
      for (const profileKey of allEntries.keys()) {
        // Skip the profile.cleared marker
        if (profileKey === PROFILE_CLEARED_KEY) continue;

        const legacyKey = reverseMapProfileKey(profileKey);

        // Apply prefix filter if provided
        if (prefix && !legacyKey.startsWith(prefix)) {
          continue;
        }

        keySet.add(legacyKey);
      }
    }

    return Array.from(keySet);
  }

  /**
   * Clear all keys with optional prefix filter.
   * Writes `profile.cleared = true` to OrbitDB so other devices see the clear.
   * Clears local cache via the composed provider.
   */
  async clear(prefix?: string): Promise<void> {
    // 1. Write cleared flag to OrbitDB (so other devices detect the clear)
    if (this.dbConnected) {
      if (!prefix) {
        const clearedBytes = await this.encrypt('true');
        await this.db.put(PROFILE_CLEARED_KEY, clearedBytes);
      } else {
        // Prefix-scoped clear: delete matching keys from OrbitDB
        const allEntries = await this.db.all();
        for (const profileKey of allEntries.keys()) {
          const legacyKey = reverseMapProfileKey(profileKey);
          if (legacyKey.startsWith(prefix)) {
            await this.db.del(profileKey);
          }
        }
      }
    }

    // 2. Clear local cache
    await this.localCache.clear(prefix);
  }

  /**
   * Save tracked addresses — encrypt and write to OrbitDB key `addresses.tracked`.
   */
  async saveTrackedAddresses(entries: TrackedAddressEntry[]): Promise<void> {
    const json = JSON.stringify({ version: 1, addresses: entries });

    // 1. Write to local cache via the standard key
    await this.localCache.saveTrackedAddresses(entries);

    // 2. Write to OrbitDB
    if (this.dbConnected) {
      const encrypted = await this.encrypt(json);
      await this.db.put(TRACKED_ADDRESSES_PROFILE_KEY, encrypted);
    }
  }

  /**
   * Load tracked addresses — read from cache or OrbitDB, decrypt, parse.
   */
  async loadTrackedAddresses(): Promise<TrackedAddressEntry[]> {
    // 1. Try local cache first
    const cached = await this.localCache.loadTrackedAddresses();
    if (cached.length > 0) {
      return cached;
    }

    // 2. Fall back to OrbitDB
    if (!this.dbConnected) {
      return [];
    }

    const encrypted = await this.db.get(TRACKED_ADDRESSES_PROFILE_KEY);
    if (encrypted === null) {
      return [];
    }

    try {
      const json = await this.decrypt(encrypted);
      const parsed = JSON.parse(json);
      const addresses: TrackedAddressEntry[] = parsed.addresses ?? [];

      // Populate cache
      try {
        await this.localCache.saveTrackedAddresses(addresses);
      } catch {
        // non-fatal
      }

      return addresses;
    } catch {
      return [];
    }
  }

  // ===========================================================================
  // Private Helpers: Encryption
  // ===========================================================================

  /**
   * Encrypt a string value for OrbitDB storage.
   * If encryption is disabled, returns the raw UTF-8 bytes.
   */
  private async encrypt(value: string): Promise<Uint8Array> {
    if (!this.encryptionEnabled || !this.profileEncryptionKey) {
      return new TextEncoder().encode(value);
    }
    return encryptString(this.profileEncryptionKey, value);
  }

  /**
   * Decrypt bytes from OrbitDB to a string.
   * If encryption is disabled, decodes as raw UTF-8.
   */
  private async decrypt(encrypted: Uint8Array): Promise<string> {
    if (!this.encryptionEnabled || !this.profileEncryptionKey) {
      return new TextDecoder().decode(encrypted);
    }
    return decryptString(this.profileEncryptionKey, encrypted);
  }

  // ===========================================================================
  // Private Helpers: Logging
  // ===========================================================================

  private log(...args: unknown[]): void {
    if (this.debug) {
      // eslint-disable-next-line no-console
      console.debug('[ProfileStorage]', ...args);
    }
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Compute an address ID from a direct address string.
 * Mirrors `getAddressId` from constants.ts.
 */
function computeAddressId(directAddress: string): string {
  let hash = directAddress;
  if (hash.startsWith('DIRECT://')) {
    hash = hash.slice(9);
  } else if (hash.startsWith('DIRECT:')) {
    hash = hash.slice(7);
  }
  const first = hash.slice(0, 6).toLowerCase();
  const last = hash.slice(-6).toLowerCase();
  return `DIRECT_${first}_${last}`;
}

/**
 * Convert a hex string to Uint8Array.
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}
