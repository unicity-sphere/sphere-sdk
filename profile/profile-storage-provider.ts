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
  computeAddressId,
} from './types';
import { ProfileError } from './errors';
import { deriveProfileEncryptionKey, encryptString, decryptString } from './encryption';
import { OrbitDbDispositionStorageAdapter } from './disposition-storage-adapters';
import {
  OrbitDbFinalizationQueueStorageAdapter,
  OrbitDbRecipientContextStorageAdapter,
} from './finalization-queue-storage-adapter';
import { OutboxWriter } from './outbox-writer';
import { SentLedgerWriter } from './sent-ledger-writer';
import { Lamport } from './lamport';
import {
  buildLocalEntry,
  type OpLogEntryEnvelope,
} from './oplog-entry';
import type { OpLogEntryType } from './aggregator-pointer/originated-tag';
import type { ProfilePointerLayer } from './aggregator-pointer';
import {
  buildProfilePointerLayer,
  type PointerWiringSkipReason,
} from './pointer-wiring';
import { logger } from '../core/logger';
import { hexToBytes } from '../core/hex';

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

/**
 * System-action types from originated-tag.ts SYSTEM_ACTION_TYPES.
 * Kept as a local const to avoid runtime-importing a private constant;
 * validated at write time by `assertOriginTagLocal` inside
 * `buildLocalEntry`, so drift between this set and the canonical list
 * produces an error at the write site.
 */
// Canonical SYSTEM_ACTION_SET + deriveOriginForType live in
// `aggregator-pointer/originated-tag.ts` to prevent the silent-divergence
// pattern that caused the cross-provider OpLog encoding collision (see
// profile-token-storage-provider.ts: writeProfileKey/readProfileKey
// envelope-path fix). Re-export for callers within this module.
import { deriveOriginForType } from './aggregator-pointer/originated-tag';

/**
 * Soft-warn threshold for OpLog payload size (PROFILE-CID-REFERENCES.md §9).
 *
 * Writes exceeding this size emit a warning at the write site. Not an error
 * — the hard cap is MAX_PAYLOAD_BYTES in oplog-entry.ts (128 KiB). This
 * threshold catches regressions before they approach the cap: any payload
 * >8 KiB should almost certainly be stored as a CID reference (Pattern A
 * in PROFILE-CID-REFERENCES.md) rather than inline in the OpLog.
 *
 * A correctly-migrated write site produces envelopes of ~200 bytes
 * (encrypted CID ref), so the threshold has a wide margin before it fires.
 * If you see this warning in production logs: either a new write site was
 * added without CID-ref migration, or a legacy wallet is replaying unmigrated
 * inline data — both actionable signals.
 */
const PAYLOAD_SIZE_WARN_BYTES = 8 * 1024;

/**
 * Truncate identifier-like suffixes from profile keys before logging.
 *
 * Dynamic profile keys embed sensitive identifiers (pubkeys, swap IDs,
 * group IDs) in their suffix — e.g., `transport.lastWalletEventTs.02ab…cd`
 * encodes a wallet pubkey. Log-aggregation pipelines (Sentry, Datadog, …)
 * commonly ship warn-level lines off-host, so full keys can leak identity
 * fingerprints.
 *
 * Heuristic: redact any trailing segment after the last `.` or `:` that
 * looks like an identifier (16+ chars of base32/hex/base64 alphabet). This
 * catches every known dynamic key shape (pubkey hex, CID-like IDs, UUIDs)
 * while leaving static keys (`identity.mnemonic`, `addresses.tracked`,
 * `DIRECT_abc_def.outbox`) untouched — their suffixes are short English
 * words.
 *
 * The first 4 chars of the suffix survive, which is enough to distinguish
 * different wallets/swaps/groups during triage without reconstructing the
 * full identifier.
 */
function redactProfileKey(key: string): string {
  return key.replace(
    /([.:])([A-Za-z0-9_-]{16,})$/,
    (_, sep: string, suffix: string) => `${sep}${suffix.slice(0, 4)}…`,
  );
}

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
  /**
   * Base provider status — reflects LOCAL CACHE connectivity only.
   * A Phase-B (OrbitDB attach) failure does not poison this status because
   * the local cache is still usable; callers who defensively disconnect()
   * shouldn't destroy the working cache just because OrbitDB couldn't attach.
   */
  private status: ProviderStatus = 'disconnected';
  /**
   * Independent sub-status for the OrbitDB attach phase.
   *
   *   'disconnected' → initial / after disconnect
   *   'attaching'    → Phase B in progress
   *   'attached'     → OrbitDB is ready for reads/writes
   *   'error'        → transient failure (may be retried by next connect())
   *   'fatal'        → permanent failure (e.g. missing dependency); no retry
   */
  private dbStatus: 'disconnected' | 'attaching' | 'attached' | 'error' | 'fatal' = 'disconnected';
  private addressId: string | null = null;
  private encryptionEnabled: boolean;
  private debug: boolean;
  /**
   * Identity pubkey captured at the last successful Phase B attach.
   * Used by `setIdentity()` to detect a key swap after attach — which
   * would cause writes encrypted under key-B to hit an OrbitDB whose
   * access controller was initialised with key-A, silently rejecting
   * them. The warning gives operators a breadcrumb to diagnose.
   */
  private attachedChainPubkey: string | null = null;
  /**
   * In-flight connect() promise. Deduplicates concurrent callers so Phase A
   * and Phase B each run at most once per observable result. Cleared on
   * completion (success or failure) so the next caller can retry.
   */
  private connectPromise: Promise<void> | null = null;
  /**
   * In-flight disconnect() promise. Blocks new connect() calls from
   * piggy-backing on a dying attach while disconnect awaits connectPromise.
   * Without this, a concurrent connect() could return success while the DB
   * is being torn down, and subsequent writes would hit a closing OrbitDB.
   */
  private disconnectPromise: Promise<void> | null = null;
  /**
   * Aggregator pointer layer (Phase D). Constructed lazily after Phase B
   * OrbitDB attach when an OracleProvider is configured AND all
   * preconditions are met (see profile/pointer-wiring.ts). Null when the
   * preconditions are not met — the caller falls back to the legacy
   * recovery path until T-D6 removes it.
   */
  private pointerLayer: ProfilePointerLayer | null = null;
  /**
   * Reason pointer construction was skipped (or null when successful /
   * not yet attempted). Surfaced via getPointerSkipReason() for
   * diagnostics and test assertions.
   */
  private pointerSkipReason: PointerWiringSkipReason | null = null;
  /**
   * Steelman pass — serialize concurrent tryBuildPointerLayer() calls.
   * Both connect()'s Phase C and setIdentity()'s deferred fire-and-
   * forget can call tryBuildPointerLayer concurrently when they
   * interleave. Without serialization the buildProfilePointerLayer()
   * lock-file path and master-key construction can race; the layer
   * for identity A may be overwritten by a slower build for identity B
   * (or vice-versa) — silent divergence with OrbitDB writes.
   *
   * The dedup is an in-flight promise: while ANY build is running,
   * subsequent callers wait for it (idempotent re-entry); after it
   * settles, the next caller starts a fresh build.
   */
  private pointerBuildPromise: Promise<void> | null = null;

  /**
   * Item #15 Phase C — host-supplied "profile state changed" callback.
   * When set, every {@link OutboxWriter} / {@link SentLedgerWriter} /
   * {@link OrbitDbFinalizationQueueStorageAdapter} /
   * {@link OrbitDbRecipientContextStorageAdapter} produced by the
   * `build*` factories is wired with this callback. Mutations and
   * JOIN-applied remote changes invoke it to signal the host's
   * FlushScheduler.
   *
   * Null until {@link setProfileDirtyNotifier} runs (typically during
   * Sphere's wiring step alongside the token-storage facade). Writers
   * constructed before the notifier is set treat the callback as
   * absent — they simply don't emit dirty signals. This matches the
   * Phase A/B contract (the existing pre-#15 flush path is
   * functionally complete without the dirty signals).
   */
  private profileDirtyNotifier: (() => void) | null = null;

  /**
   * Item #15 Phase D.2 / E — host-supplied snapshot-apply callback.
   * REQUIRED for pointer-layer construction under Phase E: the
   * `fetchAndJoin` callback parses each remote CAR as a lean profile
   * snapshot and dispatches per-writer JOIN through this callback.
   * The legacy bundle-CID-only write path was removed in Phase E, so
   * `tryBuildPointerLayer` skips with the `snapshot_applier_missing`
   * reason when this is null.
   *
   * Null until {@link setSnapshotApplier} runs (typically during the
   * Profile factory wiring step alongside the token-storage facade,
   * AFTER both providers are constructed so the closure can capture
   * `storage.buildOutboxWriter(...)` and `tokenStorage.getBundleIndex()`).
   *
   * The applier is read each time `tryBuildPointerLayer` runs (i.e.
   * each attach cycle), so callers may change it across reconnects.
   * In practice the factory sets it once at construction.
   */
  private snapshotApplier:
    | ((snapshot: import('./profile-lean-snapshot').LeanProfileSnapshot)
        => Promise<import('./profile-snapshot-dispatcher').ApplySnapshotResult>)
    | null = null;

  /**
   * Derived: true iff OrbitDB has been attached.
   * Single source of truth — no separate `dbConnected` field to diverge.
   */
  private get dbConnected(): boolean {
    return this.dbStatus === 'attached';
  }

  /**
   * Item #15 Phase C — register the host's "profile dirty" callback.
   * Idempotent: callers MAY re-register (the most recent callback
   * wins). Pass `null` to disable.
   *
   * The notifier propagates into every writer/adapter built AFTER
   * this call via the `build*` factories. Writers built BEFORE the
   * call continue with their construction-time notifier (or with
   * none if they were built without one). Sphere's wiring sets the
   * notifier early enough that the typical wallet-build path picks
   * it up.
   */
  setProfileDirtyNotifier(notifier: (() => void) | null): void {
    this.profileDirtyNotifier = notifier;
  }

  /**
   * Item #15 Phase D.2 / E — register the host's snapshot-apply
   * callback. Idempotent: callers MAY re-register (the most recent
   * callback wins). Pass `null` to disable.
   *
   * The applier is threaded into the pointer-wiring layer on the next
   * `tryBuildPointerLayer` run (called from `doConnect`); callers
   * should set it BEFORE the first `connect()` call so it lands on
   * the first attach cycle. The factory wires it during provider
   * construction, satisfying this ordering.
   *
   * Phase E made the applier REQUIRED for pointer-layer construction.
   * Passing `null` causes the next `tryBuildPointerLayer` run to skip
   * with the `snapshot_applier_missing` reason — the wallet runs
   * without aggregator-pointer recovery rather than silently writing
   * the wrong CAR shape to the bundle index.
   */
  setSnapshotApplier(
    applier:
      | ((snapshot: import('./profile-lean-snapshot').LeanProfileSnapshot)
          => Promise<import('./profile-snapshot-dispatcher').ApplySnapshotResult>)
      | null,
  ): void {
    this.snapshotApplier = applier;
  }

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
    // Two-phase connect that tolerates being called before `setIdentity()`:
    //
    //   Phase A — base connection: opens the local cache. Runs once.
    //   Phase B — OrbitDB attach: requires identity + orbitDb config.
    //             Runs lazily whenever both become available and the
    //             database is not yet connected.
    //
    // Sphere's startup calls connect() BEFORE identity is known (to
    // read wallet-exists) and AGAIN after setIdentity(). The previous
    // implementation returned early on the second call because status
    // was already 'connected', leaving OrbitDB un-attached. Callers
    // then hit `ensureConnected` errors during module load.
    //
    // Concurrency: two promise latches dedupe callers.
    //   * `disconnectPromise` — if a teardown is in flight, NEW
    //     connect() calls MUST wait for it to drain. Otherwise a
    //     concurrent connect() piggy-backing on the in-flight connect
    //     (that disconnect is awaiting) returns success just as the DB
    //     is being closed, and subsequent writes hit a dying OrbitDB.
    //   * `connectPromise` — dedupes parallel connect() calls so Phase A
    //     and Phase B each run at most once per observable result.

    if (this.disconnectPromise) {
      try {
        await this.disconnectPromise;
      } catch {
        // swallowed — disconnect() already rethrew to its caller if needed
      }
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  /**
   * Serialized connect logic — always invoked through the `connectPromise`
   * guard in `connect()`. Must not be called directly.
   */
  private async doConnect(): Promise<void> {
    // Snapshot identity at ENTRY, before any await. If a caller invokes
    // setIdentity() while connect() is in flight, the snapshot holds the
    // identity that was current when this attach started. The next
    // connect() call (after the swap) will see dbStatus='attached', skip
    // Phase B, and the caller is responsible for disconnect()+reconnect()
    // if they intended to rebind. This preserves the invariant that the
    // OrbitDB key and the encryption key used for reads are the same.
    const identityAtStart = this.identity;
    const orbitDbConfig = this.options?.config?.orbitDb ?? null;

    // Phase A — base connection (local cache). Runs at most once per
    // `disconnected`/`error` cycle. A Phase-B failure does NOT reset
    // `status` to 'error'; the local cache remains usable.
    if (this.status !== 'connected' && this.status !== 'connecting') {
      this.status = 'connecting';
      try {
        await this.localCache.connect();
        this.status = 'connected';
        this.log('Local cache connected');
      } catch (err) {
        this.status = 'error';
        throw new ProfileError(
          'PROFILE_NOT_INITIALIZED',
          `Failed to connect ProfileStorageProvider (local cache): ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }
    }

    // Phase B — lazy OrbitDB attach. Inline guard (no intermediate
    // `needsAttach` const) so TypeScript's control-flow narrowing
    // propagates `identityAtStart !== null` and `orbitDbConfig !== null`
    // into the branch body — avoiding fragile `!` non-null assertions.
    //
    //   dbStatus='fatal'        — permanent failure (e.g. missing dep);
    //                             no retry, caller must disconnect() first.
    //   dbStatus='attached'/'attaching' — already done / in progress.
    if (
      this.dbStatus !== 'attached' &&
      this.dbStatus !== 'attaching' &&
      this.dbStatus !== 'fatal' &&
      identityAtStart !== null &&
      orbitDbConfig !== null
    ) {
      this.dbStatus = 'attaching';
      try {
        // Steelman²⁹ critical: derive dbNameOverride from wipeable
        // Uint8Array bytes BEFORE handing off to OrbitDB. The privateKey
        // hex string is unavoidable at this layer (identity stores it as
        // a string), but at least the per-call derivation goes through
        // bytes that can be zeroized. The dbName is non-secret (a public
        // identifier in the OrbitDB peer mesh), safe to retain.
        let dbNameOverride: string | undefined;
        const pkHex = identityAtStart.privateKey;
        if (pkHex && pkHex.length > 0) {
          const pkBytes = hexToBytes(pkHex);
          try {
            const secp256k1Module = await import('@noble/curves/secp256k1.js' as string);
            const pubKeyBytes: Uint8Array =
              (secp256k1Module as { secp256k1: { getPublicKey(k: Uint8Array, c: boolean): Uint8Array } })
                .secp256k1.getPublicKey(pkBytes, true);
            const pubHex = Array.from(pubKeyBytes, (b) => b.toString(16).padStart(2, '0')).join('');
            dbNameOverride = `sphere-profile-${pubHex.slice(0, 16)}`;
          } catch {
            // Fall back to letting OrbitDB derive — preserves backward compat
            // when @noble/curves is unavailable.
          } finally {
            pkBytes.fill(0);
          }
        }
        // Steelman³⁰ note: when dbNameOverride is set, withhold the hex
        // privateKey from the adapter — eliminates the duplicate
        // memory-resident copy in OrbitDbConfig. The wallet identity
        // still holds the same hex string (FullIdentity is immutable JS
        // string, can't be wiped), but at least we avoid making a
        // second long-lived copy in the db config slot.
        await this.db.connect({
          ...orbitDbConfig,
          privateKey: dbNameOverride ? undefined : identityAtStart.privateKey,
          dbNameOverride,
        });
        this.dbStatus = 'attached';
        this.attachedChainPubkey = identityAtStart.chainPubkey ?? null;
        this.log('OrbitDB attached');
      } catch (err) {
        // Terminal / configuration failures are marked 'fatal' so the
        // retry loop in `connect()` doesn't hammer an unrecoverable
        // condition on every startup hop.
        const isFatal =
          err instanceof ProfileError && err.code === 'ORBITDB_NOT_INSTALLED';
        this.dbStatus = isFatal ? 'fatal' : 'error';
        throw new ProfileError(
          'PROFILE_NOT_INITIALIZED',
          `Failed to attach OrbitDB: ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }
    }

    // Phase C — pointer-layer construction (Phase D wiring per
    // PROFILE-AGGREGATOR-POINTER-INTEGRATION-MAP.md §3.2). Fail-open:
    // any missing precondition (no oracle, no aggregator client, no
    // trust base, storage not durable, etc.) is logged as a skip
    // reason and the provider continues without a pointer layer.
    //
    // The gate distinguishes RETRYABLE vs STICKY skip reasons. A
    // retryable reason reflects external state that can change
    // between calls (no oracle wired, aggregator/trust base not yet
    // loaded). Re-running connect() with updated options must
    // re-attempt construction rather than silently staying in the
    // skipped state — otherwise a caller that calls `connect()`
    // once without an oracle and again with one wired never gets
    // the pointer layer. Sticky reasons (permanent config errors,
    // unrecoverable init failures) short-circuit the next attempt.
    if (
      this.dbStatus === 'attached' &&
      this.pointerLayer === null &&
      !this.isPointerSkipSticky() &&
      identityAtStart !== null
    ) {
      await this.runPointerBuildSerialized(identityAtStart);
    }
  }

  /**
   * Serialized wrapper around tryBuildPointerLayer. Dedupes concurrent
   * calls from connect()'s Phase C and setIdentity()'s deferred build
   * (steelman). While a build is in-flight, subsequent callers await
   * the same promise; after settle, the field is cleared so a future
   * caller starts a fresh build.
   */
  private async runPointerBuildSerialized(identity: FullIdentity): Promise<void> {
    if (this.pointerBuildPromise) {
      try {
        await this.pointerBuildPromise;
      } catch {
        // Prior build already logged its failure; we still re-attempt
        // below if the layer is still null (transient retry).
      }
      // If a peer build already produced the layer (or set a sticky
      // skip reason), don't re-enter.
      if (this.pointerLayer !== null || this.isPointerSkipSticky()) {
        return;
      }
    }
    const promise = this.tryBuildPointerLayer(identity);
    this.pointerBuildPromise = promise;
    try {
      await promise;
    } finally {
      // Only clear if THIS promise is still the latched value. If a
      // concurrent setIdentity replaced it, leave the new one alone.
      if (this.pointerBuildPromise === promise) {
        this.pointerBuildPromise = null;
      }
    }
  }

  /**
   * Is the current skip reason a terminal config error that will not
   * be resolved by another connect() attempt? Terminal cases:
   *   - `lock_file_path_missing` — Node without a lock path; fixing
   *     it requires re-constructing the provider
   *   - `pointer_init_failed`    — crypto stack failure (denylist,
   *     malformed key); re-attempting against the same inputs will
   *     fail identically
   * Everything else (oracle_missing, aggregator_client_unavailable,
   * trust_base_unavailable, storage_not_durable, identity_missing)
   * reflects state the caller can fix between connects.
   */
  private isPointerSkipSticky(): boolean {
    return (
      this.pointerSkipReason === 'lock_file_path_missing' ||
      this.pointerSkipReason === 'pointer_init_failed'
    );
  }

  /**
   * Attempt to construct the pointer layer. Never throws — sets
   * `pointerLayer` on success, `pointerSkipReason` otherwise. Runs
   * at most once per attach cycle (reset on disconnect()).
   */
  private async tryBuildPointerLayer(identity: FullIdentity): Promise<void> {
    const oracle = this.options?.oracle;
    if (!oracle) {
      // Oracle is optional during rollout — no warning, no skip
      // reason set (nothing to report: the caller opted out).
      return;
    }

    const gateways = this.options?.config?.ipfsGateways ?? [];
    const orbitDbDir = this.options?.config?.orbitDb?.directory;
    // Node-only lock path: peer lock-file with the OrbitDB data dir
    // so ownership/permissions align with the rest of the wallet
    // state on disk.
    const lockFilePath = orbitDbDir
      ? `${orbitDbDir.replace(/\/+$/, '')}/profile-pointer-publish.lock`
      : undefined;

    // Item #15 Phase E: the pointer layer requires the snapshot applier
    // — the legacy bundle-CID-only fallback has been removed. Skip the
    // build with the dedicated `snapshot_applier_missing` reason instead
    // of constructing a layer whose `fetchAndJoin` would crash on first
    // remote. (`buildProfilePointerLayer` performs the same check, but
    // bailing here is cheaper and exposes the contract at the call site.)
    if (!this.snapshotApplier) {
      this.pointerLayer = null;
      this.pointerSkipReason = 'snapshot_applier_missing';
      logger.warn(
        'ProfileStorage',
        'pointer layer skipped: snapshot_applier_missing (factory wiring incomplete)',
      );
      return;
    }

    const result = await buildProfilePointerLayer({
      identity,
      localCache: this.localCache,
      oracle,
      ipfsGateways: gateways,
      lockFilePath,
      // SPEC §14.1 / §11.12 denylist gate: pass network through so
      // the pointer layer's master-key construction can reject the
      // canonical 0x01×32 KAT vector outside test-vectors deployments.
      network: this.options?.config?.network,
      // Item #15 Phase D.2 / E — required. Thread the host's snapshot
      // applier (set via `setSnapshotApplier` during factory wiring)
      // into the pointer-wiring layer. The pointer layer's
      // `fetchAndJoin` callback parses each remote CAR as a lean
      // profile snapshot and dispatches per-writer JOIN through this
      // callback.
      applySnapshot: this.snapshotApplier,
      debug: this.debug,
    });

    if (result.ok) {
      this.pointerLayer = result.layer;
      this.pointerSkipReason = null;
      this.log('Pointer layer constructed');
    } else {
      this.pointerLayer = null;
      this.pointerSkipReason = result.reason;
      logger.warn(
        'ProfileStorage',
        `pointer layer skipped: ${result.reason}${result.detail ? ` — ${result.detail}` : ''}`,
      );
    }
  }

  /**
   * Accessor for the constructed pointer layer. Returns null when the
   * layer could not be built (see `getPointerSkipReason()` for why).
   * Downstream call sites (T-D6 recovery/publish wiring) use this to
   * decide whether to go through the pointer layer or fall back to
   * the legacy path.
   */
  getPointerLayer(): ProfilePointerLayer | null {
    return this.pointerLayer;
  }

  /**
   * Steelman accessor: the pointer-build state machine viewed from the
   * outside.
   *   - 'ready'       — `pointerLayer !== null`.
   *   - 'pending'     — a build is in-flight (`pointerBuildPromise`),
   *                     OR the preconditions are present but the build
   *                     hasn't started yet (e.g., `setIdentity` is about
   *                     to fire-and-forget the build).
   *   - 'unavailable' — no oracle wired, sticky skip reason, or the
   *                     pointer is structurally inaccessible. Callers
   *                     SHOULD NOT poll further; fall through to the
   *                     legacy path immediately.
   *
   * The "pending" classification is conservative: when in doubt, we
   * prefer to keep callers waiting rather than to fire the legacy
   * IPNS migration prematurely (which would fork the pointer chain).
   */
  getPointerBuildStatus(): 'pending' | 'unavailable' | 'ready' {
    if (this.pointerLayer !== null) return 'ready';
    if (this.pointerBuildPromise !== null) return 'pending';
    if (this.isPointerSkipSticky()) return 'unavailable';
    if (!this.options?.oracle) return 'unavailable';
    // Oracle is wired, no sticky failure, no in-flight build —
    // either the deferred build hasn't kicked off yet or a previous
    // attempt failed transiently and will re-attempt on next connect.
    // Treat as pending so the caller waits.
    return 'pending';
  }

  /**
   * Returns the reason pointer-layer construction was skipped on the
   * last attach attempt, or null when construction succeeded or was
   * not yet attempted (no oracle configured).
   */
  getPointerSkipReason(): PointerWiringSkipReason | null {
    return this.pointerSkipReason;
  }

  /**
   * Round 7 (FIX 1) — Build an {@link OrbitDbDispositionStorageAdapter}
   * bound to this provider's OrbitDB instance and profile encryption
   * key. Returns null when:
   *  - encryption is disabled (no key to encrypt records with), OR
   *  - identity has not been set yet (no key derived), OR
   *  - the caller passes nothing useful (defensive null-check).
   *
   * The adapter is intentionally constructed lazily: bootstrap callers
   * (Sphere) invoke this AFTER `setIdentity()` (which derives the
   * encryption key) but possibly BEFORE OrbitDB has finished attaching
   * (Phase B). The underlying `OrbitDbAdapter.put/get/all` methods all
   * `ensureConnected()`, so the adapter's actual reads/writes are
   * deferred until the DB is ready — there's no need for the adapter
   * to wait at construction time.
   *
   * Returned adapter is a fresh instance each call; callers SHOULD
   * cache the reference (the returned adapter holds a reference to
   * `this.db` and `this.profileEncryptionKey`, so it follows the
   * lifecycle of this provider).
   *
   * Encryption key sharing: the returned adapter shares the encryption
   * key reference with this provider's internal encrypt/decrypt. If the
   * provider's encryption key is rotated (e.g. via setIdentity with a
   * different chainPubkey), the existing adapter holds the OLD key.
   * Bootstrap layers that detect identity rotation MUST rebuild the
   * adapter via this method.
   */
  buildDispositionStorageAdapter(): OrbitDbDispositionStorageAdapter | null {
    if (!this.encryptionEnabled) {
      this.log('buildDispositionStorageAdapter: encryption disabled — returning null');
      return null;
    }
    if (this.profileEncryptionKey === null) {
      this.log('buildDispositionStorageAdapter: encryption key not yet derived (setIdentity pending) — returning null');
      return null;
    }
    return new OrbitDbDispositionStorageAdapter({
      db: this.db,
      encryptionKey: this.profileEncryptionKey,
      // Item #15 Phase B.4 — thread the dirty notifier into the adapter
      // so the four PrefixSyncWriters returned by `syncWritersFor` mark
      // the profile dirty when JOIN-applied remote records land.
      notifyProfileDirty: this.profileDirtyNotifier ?? undefined,
    });
  }

  /**
   * G3 — Build an {@link OrbitDbFinalizationQueueStorageAdapter} bound
   * to this provider's OrbitDB instance and profile encryption key.
   * Lifecycle and null semantics mirror
   * {@link buildDispositionStorageAdapter}.
   *
   * The returned adapter persists recipient-side finalization queue
   * entries under `${addr}.finalizationQueue.${entryId}` keys. Each
   * record carries `_schemaVersion: 'uxf-1'` so the legacy
   * PaymentsModule.save() flush path leaves them alone.
   */
  buildFinalizationQueueStorageAdapter(): OrbitDbFinalizationQueueStorageAdapter | null {
    if (!this.encryptionEnabled) return null;
    if (this.profileEncryptionKey === null) return null;
    return new OrbitDbFinalizationQueueStorageAdapter({
      db: this.db,
      encryptionKey: this.profileEncryptionKey,
      notifyProfileDirty: this.profileDirtyNotifier ?? undefined,
    });
  }

  /**
   * G7 — Build an {@link OrbitDbRecipientContextStorageAdapter} bound
   * to this provider's OrbitDB instance and profile encryption key.
   * Persists `_recipientRequestContextMap` and
   * `_recipientFinalizationContext` records under
   * `${addr}.recipientContext.{request,finalization}.${id}` keys.
   * Lifecycle and null semantics mirror
   * {@link buildDispositionStorageAdapter}.
   */
  buildRecipientContextStorageAdapter(): OrbitDbRecipientContextStorageAdapter | null {
    if (!this.encryptionEnabled) return null;
    if (this.profileEncryptionKey === null) return null;
    return new OrbitDbRecipientContextStorageAdapter({
      db: this.db,
      encryptionKey: this.profileEncryptionKey,
      notifyProfileDirty: this.profileDirtyNotifier ?? undefined,
    });
  }

  /**
   * Issue #97 — Build an {@link OutboxWriter} bound to this provider's
   * OrbitDB instance and profile encryption key, scoped to the given
   * address. The writer persists per-entry-key UXF outbox entries under
   * `${addressId}.outbox.${id}` (PROFILE-ARCHITECTURE §10.12) which are
   * IPFS-synced as part of the profile so they survive total local
   * profile loss.
   *
   * Returns null when:
   *  - encryption is disabled, OR
   *  - the encryption key has not been derived yet (setIdentity pending)
   *
   * Lifecycle: callers SHOULD cache the returned writer for the current
   * address. On address switch, callers MUST rebuild via this method —
   * the writer's `addressId` is captured at construction.
   *
   * Lamport clock: the writer takes a fresh {@link Lamport} unless the
   * caller passes one. The writer's first `write()` calls
   * `collectObservedLamports()` to rehydrate `max(observed) + 1`, so the
   * fresh-instance default is correct after restart.
   */
  buildOutboxWriter(addressId: string, lamport?: Lamport): OutboxWriter | null {
    if (!this.encryptionEnabled) {
      this.log('buildOutboxWriter: encryption disabled — returning null');
      return null;
    }
    if (this.profileEncryptionKey === null) {
      this.log('buildOutboxWriter: encryption key not yet derived (setIdentity pending) — returning null');
      return null;
    }
    if (typeof addressId !== 'string' || addressId.length === 0) {
      this.log('buildOutboxWriter: addressId must be a non-empty string — returning null');
      return null;
    }
    return new OutboxWriter({
      db: this.db,
      encryptionKey: this.profileEncryptionKey,
      addressId,
      lamport: lamport ?? new Lamport(),
      notifyProfileDirty: this.profileDirtyNotifier ?? undefined,
    });
  }

  /**
   * Issue #97 — Build a {@link SentLedgerWriter} bound to this
   * provider's OrbitDB instance and profile encryption key, scoped to
   * the given address. The writer persists per-entry-key SENT ledger
   * entries under `${addressId}.sent.${id}` (PROFILE-ARCHITECTURE
   * §10.12). Lifecycle and null semantics mirror
   * {@link buildOutboxWriter}.
   *
   * The SENT ledger and the outbox use distinct Lamport instances by
   * design — see profile/sent-ledger-writer.ts module docs. The
   * default `new Lamport()` is correct because the writer's first
   * `write()` rehydrates the max via `collectObservedLamports()`.
   */
  buildSentLedgerWriter(addressId: string, lamport?: Lamport): SentLedgerWriter | null {
    if (!this.encryptionEnabled) {
      this.log('buildSentLedgerWriter: encryption disabled — returning null');
      return null;
    }
    if (this.profileEncryptionKey === null) {
      this.log('buildSentLedgerWriter: encryption key not yet derived (setIdentity pending) — returning null');
      return null;
    }
    if (typeof addressId !== 'string' || addressId.length === 0) {
      this.log('buildSentLedgerWriter: addressId must be a non-empty string — returning null');
      return null;
    }
    return new SentLedgerWriter({
      db: this.db,
      encryptionKey: this.profileEncryptionKey,
      addressId,
      lamport: lamport ?? new Lamport(),
      notifyProfileDirty: this.profileDirtyNotifier ?? undefined,
    });
  }

  async disconnect(): Promise<void> {
    // Dedupe concurrent disconnect() calls.
    if (this.disconnectPromise) {
      return this.disconnectPromise;
    }
    this.disconnectPromise = this.doDisconnect();
    try {
      await this.disconnectPromise;
    } finally {
      this.disconnectPromise = null;
    }
  }

  private async doDisconnect(): Promise<void> {
    this.log('Disconnecting');

    // If a connect() is still in flight, wait for it to settle before
    // tearing down — otherwise we could race against an in-progress
    // OrbitDB attach and leave a live Helia instance around.
    if (this.connectPromise) {
      try {
        await this.connectPromise;
      } catch {
        // swallowed — connect() already rethrew to its caller
      }
    }

    // 1. Drain the pointer layer BEFORE closing OrbitDB. Any in-
    //    flight publish holds the publish mutex (Node file-lock
    //    and/or Web Lock). If we drop the reference without draining
    //    and the process exits, the file lock can be orphaned —
    //    next publish blocks until proper-lockfile's stale detector
    //    reclaims it. Await the pointer layer's drain hook so any
    //    running operation finishes releasing its mutex handle.
    //    Pointer layer may not expose a drain API in older builds;
    //    fall through gracefully when absent.
    try {
      const drainable = this.pointerLayer as unknown as {
        shutdown?: () => Promise<void>;
      } | null;
      if (drainable && typeof drainable.shutdown === 'function') {
        await drainable.shutdown();
      }
    } catch {
      // best-effort
    }

    // 2. Close OrbitDB (if attached)
    try {
      if (this.dbStatus === 'attached') {
        await this.db.close();
      }
    } catch {
      // best-effort
    } finally {
      this.dbStatus = 'disconnected';
      this.attachedChainPubkey = null;
      // Reset capability cache so a re-connect re-probes (adapter could
      // have been swapped between disconnect/connect cycles, e.g. in tests).
      this._envelopesSupported = null;
      // Reset pointer-layer state so the next connect() re-probes — an
      // oracle or durability marker may be wired in only on the second
      // connect cycle.
      //
      // Steelman fix: preserve STICKY skip reasons across disconnect.
      // `lock_file_path_missing` and `pointer_init_failed` reflect
      // permanent config / crypto failures that won't be resolved by
      // a reconnect against the same inputs. Wiping them on disconnect
      // means every reconnect re-runs `buildProfilePointerLayer`,
      // which re-runs the same expensive master-key denylist check
      // and re-fails with the same code — wasted CPU on every reboot.
      // Retain sticky reasons; clear only retryable ones.
      this.pointerLayer = null;
      if (!this.isPointerSkipSticky()) {
        this.pointerSkipReason = null;
      }
    }

    // 3. Close local cache
    try {
      await this.localCache.disconnect();
    } catch {
      // best-effort
    }

    this.status = 'disconnected';
    this.log('Disconnected');
  }

  isConnected(): boolean {
    // Fully connected means the local cache is up AND — if this provider
    // was configured with OrbitDB — the database is attached. Reporting
    // false in the half-attached state signals callers
    // (Sphere.initializeProviders) to re-call connect() so the lazy-attach
    // branch fires.
    //
    // Note: we check the orbitDb config, NOT `identity`, to decide whether
    // an attach is required. Previously the check gated on identity too,
    // which meant a provider constructed with orbitDb config but without
    // an identity yet would report `true` even though all DB operations
    // would silently fall back to the local cache — users could then make
    // writes that are never backfilled to OrbitDB once identity arrives.
    // Now, if orbitDb is configured, isConnected() stays false until the
    // attach completes (which in turn requires setIdentity()).
    if (this.status !== 'connected') return false;
    if (this.options?.config?.orbitDb && this.dbStatus !== 'attached') {
      return false;
    }
    return true;
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
    // Identity-swap detection: if OrbitDB is already attached under a
    // different pubkey, any writes from here on will be encrypted with
    // the new identity's key but OrbitDB's AccessController was
    // initialized with the old key — writes will be silently rejected.
    // Warn loudly; the caller should disconnect() and reconnect() to
    // rebind OrbitDB properly.
    if (
      this.dbStatus === 'attached' &&
      this.attachedChainPubkey !== null &&
      identity.chainPubkey !== this.attachedChainPubkey
    ) {
      logger.warn(
        'ProfileStorage',
        'setIdentity called with a different chainPubkey while OrbitDB is attached — OrbitDB AccessController will reject writes under the new key. Call disconnect() and reconnect() to rebind.',
      );
    }

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

    // If OrbitDB attached BEFORE setIdentity (the common Sphere.init/import
    // ordering: storage.connect() runs while identity is still null, then
    // Sphere derives identity from mnemonic and calls setIdentity), retry
    // the pointer-layer build now that the identity prerequisite is met.
    // Fire-and-forget — setIdentity is sync per the StorageProvider
    // interface contract; downstream callers (tokenStorage.initialize →
    // recoverFromAggregatorPointerBestEffort) poll for the pointer with a
    // short timeout so they don't race the build.
    //
    // Steelman serialization: route through `runPointerBuildSerialized`
    // so concurrent identity rotations + connect()'s Phase C don't both
    // race buildProfilePointerLayer's lock-file path and master-key
    // construction. Errors are also routed to `pointerSkipReason` via
    // tryBuildPointerLayer's internal handler so a future call can
    // observe the skip state instead of treating the layer as "not yet
    // attempted".
    if (
      this.dbStatus === 'attached' &&
      this.pointerLayer === null &&
      !this.isPointerSkipSticky()
    ) {
      void this.runPointerBuildSerialized(identity).catch((err) => {
        this.log(
          `setIdentity: deferred pointer-layer build failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
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

    const encrypted = await this.readEnvelopePayload(translated.profileKey);
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
   *
   * PROFILE-OPLOG-SCHEMA.md §5.1: the encrypted payload is wrapped in a
   * structured envelope carrying an originated tag. Generic `set` calls
   * default to `type='cache_index', originated='system'` — a safe
   * conservative classification. Callers that know the action semantics
   * SHOULD use `setEntry()` (see below) which accepts an explicit type.
   */
  async set(key: string, value: string, opts?: { entryType?: OpLogEntryType }): Promise<void> {
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

    // 3. Write to OrbitDB (encrypted envelope)
    if (this.dbConnected) {
      const encrypted = await this.encrypt(value);
      await this.writeEnvelope(translated.profileKey, encrypted, opts?.entryType ?? 'cache_index');
    }
  }

  /**
   * Typed-entry write helper — lets callers pass an explicit OpLogEntryType
   * for W11 originated-tag discipline. Maps the user's `OpLogEntryType` to
   * the envelope's `(type, originated)` pair via the originated-tag coherence
   * rules (user-action types → 'user'; system types → 'system').
   *
   * Delegates to `set()` for local-cache write + key translation;
   * the envelope wrap happens internally.
   */
  async setEntry(
    key: string,
    value: string,
    entryType: OpLogEntryType,
  ): Promise<void> {
    return this.set(key, value, { entryType });
  }

  // ---------- Envelope helpers (PROFILE-OPLOG-SCHEMA.md §5) ----------

  /**
   * Computed ONCE lazily from the adapter's capability surface. Both
   * putEntry AND getEntry must exist together, OR both must be absent —
   * an asymmetric adapter (one method but not the other) would silently
   * corrupt reads, so we treat it as a configuration error.
   *
   * Value is cached after first probe to avoid repeated `typeof` checks
   * on hot paths; reset in `disconnect()` on re-connect.
   */
  private _envelopesSupported: boolean | null = null;

  /** Probe both putEntry + getEntry exactly once; throw on asymmetry. */
  private supportsEnvelopes(): boolean {
    if (this._envelopesSupported !== null) return this._envelopesSupported;
    const hasPut = typeof this.db.putEntry === 'function';
    const hasGet = typeof this.db.getEntry === 'function';
    if (hasPut !== hasGet) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `ProfileDatabase adapter has asymmetric envelope support: putEntry=${hasPut}, ` +
          `getEntry=${hasGet}. Adapter must implement BOTH methods or NEITHER — ` +
          `asymmetric support would silently corrupt reads of envelope-wrapped writes ` +
          `(PROFILE-OPLOG-SCHEMA.md §7).`,
      );
    }
    this._envelopesSupported = hasPut;
    return hasPut;
  }

  /**
   * Write `encryptedPayload` to OrbitDB wrapped in a structured envelope.
   * Falls back to raw-bytes `db.put` if the underlying adapter does not
   * implement putEntry (legacy test stubs, older adapter versions).
   *
   * Capability probe is symmetric: the first call asserts that putEntry
   * and getEntry are either both present or both absent. See
   * `supportsEnvelopes()`.
   */
  private async writeEnvelope(
    profileKey: string,
    encryptedPayload: Uint8Array,
    entryType: OpLogEntryType = 'cache_index',
  ): Promise<void> {
    // Soft-warn when a payload approaches the fat-data regime. See
    // PAYLOAD_SIZE_WARN_BYTES comment and PROFILE-CID-REFERENCES.md §9.
    // We log the key + type + size but NEVER the payload itself (ciphertext
    // would leak nothing, but plaintext len is a fingerprint for some
    // attackers). This lets the write proceed — the hard failure is at
    // MAX_PAYLOAD_BYTES in oplog-entry.ts.
    if (encryptedPayload.byteLength > PAYLOAD_SIZE_WARN_BYTES) {
      // Redact sensitive dynamic suffixes (pubkey / swap ID / group ID)
      // so the warning is safe to ship to off-host log aggregation.
      logger.warn(
        'ProfileStorage',
        `[PAYLOAD-SIZE] OpLog write exceeds ${PAYLOAD_SIZE_WARN_BYTES} B ` +
          `soft-warn threshold — consider migrating this write site to a CID ` +
          `reference (PROFILE-CID-REFERENCES.md §8). ` +
          `key=${redactProfileKey(profileKey)} type=${entryType} size=${encryptedPayload.byteLength}`,
      );
    }
    const originated = deriveOriginForType(entryType);
    if (this.supportsEnvelopes()) {
      const envelope = buildLocalEntry({
        type: entryType,
        originated,
        payload: encryptedPayload,
      });
      await this.db.putEntry!(profileKey, envelope);
    } else {
      // Legacy adapter without putEntry support — write raw bytes.
      // Readers using the companion legacy path (also no getEntry) see
      // raw bytes via db.get. getEntry's legacy fallback wraps raw
      // bytes on decode for MIXED adapters where only part of the surface
      // has migrated — which the symmetric probe above forbids.
      await this.db.put(profileKey, encryptedPayload);
      // Mark locally-authored for adapters that support the tracking hook
      // (OrbitDbAdapter exposes markLocallyAuthored as a non-interface method).
      const markHook = (this.db as { markLocallyAuthored?: (k: string) => void }).markLocallyAuthored;
      if (typeof markHook === 'function') {
        markHook.call(this.db, profileKey);
      }
    }
  }

  /**
   * Read an envelope's encrypted payload from OrbitDB. Returns null if
   * the key is absent. Legacy raw-bytes entries are auto-wrapped by
   * `getEntry`'s legacy fallback (§7.1), so this helper works on both
   * pre-schema and post-schema OpLog contents.
   *
   * Passes `trustLocalClaim: true` — callers at this layer have already
   * established that this wallet's OrbitDB instance is its own source of
   * truth (no cross-wallet sharing). Peer writes reach this path only
   * through replication events, which clear the locally-authored set.
   */
  private async readEnvelopePayload(profileKey: string): Promise<Uint8Array | null> {
    if (this.supportsEnvelopes()) {
      const envelope = (await this.db.getEntry!(profileKey, {
        trustLocalClaim: true,
      })) as OpLogEntryEnvelope | null;
      return envelope ? envelope.payload : null;
    }
    return this.db.get(profileKey);
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
        const clearedBytes = await this.readEnvelopePayload(PROFILE_CLEARED_KEY);
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
      const value = await this.readEnvelopePayload(translated.profileKey);
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
        // 'cache_index' classification: wallet-clear marker is a system event.
        await this.writeEnvelope(PROFILE_CLEARED_KEY, clearedBytes, 'cache_index');
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
      // Tracked addresses list is wallet-configuration metadata —
      // classified as a system event (not a user action).
      await this.writeEnvelope(TRACKED_ADDRESSES_PROFILE_KEY, encrypted, 'cache_index');
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

    const encrypted = await this.readEnvelopePayload(TRACKED_ADDRESSES_PROFILE_KEY);
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
  // Raw Encrypted Round-Trip (Wave 9 — profile-export/import)
  // ===========================================================================

  /**
   * Read the ENCRYPTED OrbitDB envelope payload for a key WITHOUT
   * decryption. Returns a base64-encoded ciphertext string suitable
   * for round-tripping through `setEncryptedRaw`. Returns null when
   * the key is absent or stored cache-only / excluded.
   *
   * The whole point of this method is to defeat the "decrypt-on-read,
   * leak-into-CAR" mnemonic-leak path closed in Wave 9 critical #1.
   * `profile-export` must NOT see plaintext for identity-class keys
   * (`mnemonic`, `master_key`, `chain_code`, ...) — the snapshot CAR
   * is supposed to carry encrypted bytes only, decryptable solely
   * by a wallet sharing the source's master key (and therefore
   * mnemonic). This entry point bypasses the in-cache plaintext
   * shadow that `set()` populates and reads the OrbitDB ciphertext
   * envelope directly.
   *
   * Cache-only keys (price cache, registry cache) and excluded keys
   * (IPFS state) return null — they are never written to OrbitDB.
   *
   * @param key - The legacy (caller-facing) key name, same shape as
   *              passed to `get()` / `set()`.
   * @returns Base64-encoded encrypted bytes, or null when absent.
   * @throws ProfileError when OrbitDB is not connected (the export
   *         path requires durable backing — refusing here forces
   *         the caller to surface the error rather than silently
   *         emit a snapshot with missing identity entries).
   */
  async getEncryptedRaw(key: string): Promise<string | null> {
    const translated = translateKey(key, this.addressId);
    if (translated.excluded) return null;
    if (translated.cacheOnly) return null;
    if (!this.dbConnected) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `getEncryptedRaw("${redactProfileKey(translated.profileKey)}") requires OrbitDB to be attached.`,
      );
    }
    const encrypted = await this.readEnvelopePayload(translated.profileKey);
    if (encrypted === null) return null;
    // Encode as base64 so the export's snapshot.entries[i].value (string)
    // can carry the ciphertext bytes through dag-cbor (which also
    // accepts strings, but we keep the value field as a string to match
    // the existing schema and avoid silently shifting it to byte-string
    // type).
    return Buffer.from(encrypted).toString('base64');
  }

  /**
   * Write a previously-extracted encrypted envelope payload back to
   * OrbitDB without re-encryption. The destination wallet's master
   * key MUST match the source's (verified by the importer's
   * `expectedChainPubkey` check), or the ciphertext will be
   * unreadable on subsequent `get()` calls — but this method does
   * NOT verify decryptability, since the import path runs before the
   * destination's storage has settled.
   *
   * Local-cache plaintext is intentionally NOT populated here: the
   * destination's `get()` will fall through to OrbitDB and decrypt
   * fresh on first read. Populating cache with the ciphertext would
   * defeat the cache (it'd pretend to be plaintext and fail callers
   * with corrupted bytes).
   *
   * @param key   - Legacy key name (same shape as `set()`).
   * @param value - Base64-encoded encrypted bytes from `getEncryptedRaw`.
   */
  async setEncryptedRaw(key: string, value: string): Promise<void> {
    const translated = translateKey(key, this.addressId);
    if (translated.excluded) return;
    if (translated.cacheOnly) {
      // Cache-only keys have no OrbitDB backing — write the value
      // verbatim to local cache so `get()` returns it. The "value"
      // here is a base64 string (ciphertext form) which is wrong
      // semantics for a cache-only key, so refuse loudly.
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `setEncryptedRaw refuses cache-only key "${redactProfileKey(translated.profileKey)}" — ` +
          `cache-only keys are not encrypted and must be replayed via set().`,
      );
    }
    if (!this.dbConnected) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `setEncryptedRaw("${redactProfileKey(translated.profileKey)}") requires OrbitDB to be attached.`,
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(Buffer.from(value, 'base64'));
    } catch (err) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `setEncryptedRaw: value is not valid base64: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
    // Reuse the writeEnvelope path so the OpLog envelope wrapper is
    // identical to a normal write — `cache_index` is the safe
    // conservative classification (matches set()'s default).
    await this.writeEnvelope(translated.profileKey, bytes, 'cache_index');
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
       
      console.debug('[ProfileStorage]', ...args);
    }
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

// Steelman³⁵: hexToBytes consolidated to core/hex.ts (top-of-file import).
