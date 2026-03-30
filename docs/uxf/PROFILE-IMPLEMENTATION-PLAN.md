# UXF Profile Implementation Plan

**Status:** Validated -- pending steelman
**Date:** 2026-03-30

---

## Implementation Plan: UXF Profile System

### Summary of Architecture Understanding

The UXF Profile system introduces a three-tier persistence model: OrbitDB (source of truth with CRDT conflict resolution), IPFS (content-addressed storage for UXF CAR token bundles), and local cache (fast transient layer using existing IndexedDBStorageProvider/FileStorageProvider). It integrates with existing sphere-sdk via `ProfileStorageProvider` (implementing `StorageProvider`) and `ProfileTokenStorageProvider` (implementing `TokenStorageProvider<TxfStorageDataBase>`). Token inventory uses a multi-bundle model where each device writes separate `tokens.bundle.{CID}` keys to OrbitDB, avoiding LWW conflicts. Lazy consolidation is deferred to Phase 2; a `shouldConsolidate()` check logs a warning when bundle count exceeds 3.

Key files that anchor this design:
- `/home/vrogojin/uxf/storage/storage-provider.ts` -- the interfaces to implement
- `/home/vrogojin/uxf/impl/shared/ipfs/ipfs-storage-provider.ts` -- existing IPFS provider pattern to follow
- `/home/vrogojin/uxf/constants.ts` -- storage key mapping source
- `/home/vrogojin/uxf/uxf/UxfPackage.ts` -- UXF package operations (ingest, merge, toCar, fromCar)
- `/home/vrogojin/uxf/impl/browser/index.ts` and `/home/vrogojin/uxf/impl/nodejs/index.ts` -- factory patterns

---

### Dependency Graph Summary

```
Layer 0 (Group A) -- no deps, all parallel ──────────────────
  WU-P01 Types + Errors
  WU-P02 Encryption Module
  WU-P03 OrbitDB Wrapper/Adapter

Layer 1 (Group B) -- depends on Layer 0, all parallel ──────
  WU-P04 ProfileStorageProvider      -- needs P01, P02, P03
  WU-P05 ProfileTokenStorageProvider -- needs P01, P02, P03
         (includes TxfAdapter, BundleManager, CAR pinning,
          sync/replication callbacks)

Layer 2 (Group C) -- depends on Layer 1, all parallel ──────
  WU-P10 Migration Engine            -- needs P04, P05
  WU-P13 Factory Functions           -- needs P04, P05 (standalone)
  WU-P14 Barrel Exports + Build Config -- needs all above
```

**Maximum parallelism:** 3 workers at Layer 0, 2 at Layer 1, 3 at Layer 2. Critical path length: 3 layers.

**Estimated total files created:** ~10 new files in `profile/` directory.
**Estimated total files modified:** 2 existing files (tsup.config.ts, package.json).

---

### Layer 0: Foundation (No Dependencies)

**Parallel Group A** -- all three WUs can run simultaneously.

---

**WU-P01: Profile Types and Errors**

- **ID:** WU-P01
- **Name:** Profile Types and Errors
- **Files to create:**
  - `profile/types.ts`
  - `profile/errors.ts`
- **Dependencies:** None
- **Parallel group:** A (Layer 0)
- **Description:** Define all type definitions for the Profile system. References PROFILE-ARCHITECTURE.md Section 2 (Profile Schema), Section 2.1 (Global Keys), Section 2.2 (Per-Address Keys), Section 2.3 (UxfBundleRef), Section 5.1 (Interface Compatibility).

  Types to define:
  - `ProfileConfig` -- configuration for profile initialization (OrbitDB connection details, encryption flag, cache settings). Mirrors the `IpfsStorageConfig` pattern from `/home/vrogojin/uxf/impl/shared/ipfs/ipfs-types.ts`.
  - `UxfBundleRef` -- exactly as specified in Section 2.3: `{ cid, status, createdAt, device?, supersededBy?, removeFromProfileAfter?, tokenCount? }`
  - `ProfileKeyMap` -- type-safe mapping of old storage keys (from `STORAGE_KEYS_GLOBAL` and `STORAGE_KEYS_ADDRESS` in `/home/vrogojin/uxf/constants.ts`) to new Profile key names (Section 5.2 mapping table)
  - `MigrationPhase` -- `'syncing' | 'transforming' | 'persisting' | 'verifying' | 'cleaning' | 'complete'` from Section 7.6
  - `ProfileEncryptionConfig` -- encryption key derivation params (Section 9.1)
  - `ProfileStorageProviderOptions` -- options for the StorageProvider implementation
  - `ProfileTokenStorageProviderOptions` -- options for the TokenStorageProvider implementation
  - Error codes: `PROFILE_NOT_INITIALIZED`, `ORBITDB_WRITE_FAILED`, `BUNDLE_NOT_FOUND`, `MIGRATION_FAILED`, `ENCRYPTION_FAILED`, `DECRYPTION_FAILED`

- **Acceptance criteria:**
  1. All types compile with strict TypeScript
  2. `UxfBundleRef` matches the interface in Section 2.3 exactly
  3. `ProfileKeyMap` covers every key in the Section 5.2 mapping table (both global and per-address)
  4. No runtime dependencies -- types-only file except for error class
  5. Error class follows `UxfError` pattern from `/home/vrogojin/uxf/uxf/errors.ts`

---

**WU-P02: Profile Encryption Module**

- **ID:** WU-P02
- **Name:** Profile Encryption Module
- **Files to create:**
  - `profile/encryption.ts`
- **Dependencies:** None
- **Parallel group:** A (Layer 0)
- **Description:** Implement encryption/decryption for Profile values stored in OrbitDB and CAR files on IPFS. References PROFILE-ARCHITECTURE.md Section 9.1 (Encryption Model: Shared Key), Section 9.2 (Identity Protection).

  All encryption uses random IVs. There is no deterministic IV mode. CID dedup applies at the OrbitDB key level (`tokens.bundle.{CID}`), not at the encrypted-bytes level. Two devices encrypting the same content produce different CIDs, but this is handled by the multi-bundle merge model.

  Functions to implement:
  - `deriveProfileEncryptionKey(masterKey: Uint8Array): Uint8Array` -- HKDF(masterKey, "uxf-profile-encryption", 32) using `@noble/hashes/hkdf` and `@noble/hashes/sha256` (already in dependencies)
  - `encryptProfileValue(key: Uint8Array, plaintext: Uint8Array): Uint8Array` -- AES-256-GCM with random 12-byte IV, returns `IV || ciphertext || tag`. Uses Web Crypto API (browser) or Node.js `crypto` module.
  - `decryptProfileValue(key: Uint8Array, encrypted: Uint8Array): Uint8Array` -- AES-256-GCM decryption, extracts IV from first 12 bytes
  - `encryptCarFile(key: Uint8Array, carBytes: Uint8Array): Uint8Array` -- AES-256-GCM with random 12-byte IV, returns `IV || ciphertext || tag`. Same as `encryptProfileValue` (no deterministic IV).
  - `decryptCarFile(key: Uint8Array, encrypted: Uint8Array): Uint8Array` -- same as `decryptProfileValue` (IV is prepended)

  Bootstrap sequence for Profile encryption:
  1. User provides password (or mnemonic for recovery)
  2. Password decrypts mnemonic/masterKey from local cache or user input
  3. masterKey -> HKDF -> profileEncryptionKey
  4. profileEncryptionKey decrypts all OrbitDB values
  5. On fresh device with no local cache: user must provide mnemonic + password

  Platform abstraction: Use `globalThis.crypto.subtle` which is available in both modern browsers and Node.js 18+. Fallback to `@noble/ciphers` if subtle is unavailable (for older Node.js environments).

- **Acceptance criteria:**
  1. Round-trip encrypt/decrypt produces identical plaintext
  2. Two encryptions of the same plaintext with random IV produce different ciphertexts
  3. Two encryptions of the same CAR file produce different ciphertexts (random IV, no deterministic mode)
  4. Key derivation is deterministic -- same master key always derives same encryption key
  5. Works in both browser (Web Crypto) and Node.js environments
  6. Unit tests cover: key derivation, encrypt/decrypt round-trip, invalid key rejection, tampered ciphertext detection (GCM auth tag failure)

---

**WU-P03: OrbitDB Wrapper/Adapter**

- **ID:** WU-P03
- **Name:** OrbitDB Wrapper/Adapter
- **Files to create:**
  - `profile/orbitdb-adapter.ts`
  - `profile/orbitdb-types.ts`
- **Dependencies:** None
- **Parallel group:** A (Layer 0)
- **Description:** Thin wrapper around `@orbitdb/core` providing a typed, promise-based API for the Profile's KV database. References PROFILE-ARCHITECTURE.md Section 4 (Profile as OrbitDB Database), Section 4.1 (Database Identity), Section 4.2 (Data Organization), Section 4.3 (OpLog and CRDT Merge), Section 4.4 (Replication).

  The wrapper abstracts OrbitDB internals so the rest of the Profile system never imports `@orbitdb/core` directly.

  Interface `ProfileDatabase`:
  - `connect(config: OrbitDbConfig): Promise<void>` -- creates Helia instance, OrbitDB instance, opens KV database with deterministic address from wallet key (Section 4.1)
  - `put(key: string, value: Uint8Array): Promise<void>` -- writes encrypted value
  - `get(key: string): Promise<Uint8Array | null>` -- reads value
  - `del(key: string): Promise<void>` -- deletes key
  - `all(prefix?: string): Promise<Map<string, Uint8Array>>` -- returns all entries, optionally filtered by prefix (needed for `tokens.bundle.*` listing per Section 2.3)
  - `close(): Promise<void>` -- closes database, Helia, libp2p
  - `onReplication(callback: () => void): () => void` -- subscribe to replication events (Section 4.4)

  `OrbitDbConfig`:
  - `privateKey: string` -- wallet private key for identity derivation
  - `directory?: string` -- local storage directory (Node.js)
  - `bootstrapPeers?: string[]` -- libp2p bootstrap peers
  - `enablePubSub?: boolean` -- default true

  Access control:
  - Use `OrbitDBAccessController` with `write: [orbitDbIdentityId]`
  - Identity derived from wallet secp256k1 key (Section 4.1)
  - Database type: `keyvalue` (Section 4.2)
  - `@orbitdb/core` is a new dependency -- added in WU-P14

  Implementation notes:
  - OrbitDB identity derived from wallet's secp256k1 key (Section 4.1)

- **Acceptance criteria:**
  1. `connect()` creates a deterministic database address from a given private key
  2. `put/get/del` round-trip works correctly
  3. `all()` with prefix filter returns only matching keys
  4. `close()` cleanly shuts down Helia and libp2p (no dangling connections)
  5. `onReplication` callback fires when remote entries arrive (testable with two instances)
  6. Type-safe -- no `any` types in the public API
  7. Second OrbitDB instance with different identity CANNOT write to the database
  8. Integration test: two OrbitDB instances sharing the same identity replicate a `put()` within 5 seconds

---

### Layer 1: Storage Providers (Depends on Layer 0)

**Parallel Group B** -- both WUs can run simultaneously after Layer 0 completes.

---

**WU-P04: ProfileStorageProvider**

- **ID:** WU-P04
- **Name:** ProfileStorageProvider implementing StorageProvider
- **Files to create:**
  - `profile/profile-storage-provider.ts`
  - `profile/key-mapping.ts`
- **Dependencies:** WU-P01 (types), WU-P02 (encryption), WU-P03 (OrbitDB adapter)
- **Parallel group:** B (Layer 1)
- **Description:** Implements the `StorageProvider` interface (from `/home/vrogojin/uxf/storage/storage-provider.ts`) backed by the Profile's OrbitDB database with a local cache layer. References PROFILE-ARCHITECTURE.md Section 5.1 (Interface Compatibility), Section 5.2 (Key Mapping), Section 3.2 (Write Path), Section 3.3 (Read Path).

  The local cache layer reuses existing `IndexedDBStorageProvider` (browser) or `FileStorageProvider` (Node.js) directly -- no custom cache implementation needed. `ProfileStorageProvider` composes one of these as its local cache.

  The provider must be a drop-in replacement for `IndexedDBStorageProvider` or `FileStorageProvider`. Existing code calling `storage.get('mnemonic')` must continue to work -- the provider translates old key names to Profile key names using the mapping table in Section 5.2.

  `key-mapping.ts` implements the translation:
  - Strips `sphere_` prefix (from `STORAGE_PREFIX` in constants.ts)
  - Maps `mnemonic` to `identity.mnemonic`, `master_key` to `identity.masterKey`, etc.
  - Maps per-address keys: `{addressId}_pending_transfers` to `{addressId}.pendingTransfers`
  - Dynamic key pattern support: `{addr}_swap:*` -> `{addr}.swap:*` (regex-based)
  - Explicit exclusion of IPFS state keys (`sphere_ipfs_seq_*`, `sphere_ipfs_cid_*`, `sphere_ipfs_ver_*`) -- these are not written to OrbitDB or cache
  - Cache-only keys (`token_registry_cache`, `price_cache`, etc.) are stored only in the local cache, NOT written to OrbitDB (Section 2.1 "Cache-only keys")
  - Reverse key mapping for `keys()` method -- return keys in legacy format with `sphere_` prefix so existing sphere-sdk code sees expected key names

  Write behavior:
  - Critical keys (identity, tracked addresses, transport timestamps): write to local cache AND OrbitDB
  - Cache-only keys: write to local cache only
  - `wallet_exists` is special: maintained as a local-only fast-path flag (Section 5.2 note)

  Read behavior:
  - Read from local cache first (fast path)
  - On cache miss: read from OrbitDB, populate cache
  - Decrypt values using `profileEncryptionKey`

  `setIdentity()` behavior:
  - Stores identity and derives `profileEncryptionKey` from `identity.privateKey` **synchronously**
  - Does NOT open network connections or create OrbitDB instances
  - OrbitDB connection is deferred to `connect()` or `initialize()` (async)

  `connect()` / `disconnect()` lifecycle:
  - `connect()` opens the local cache provider and OrbitDB connection
  - `disconnect()` flushes pending writes and closes both connections

  `clear()` specification:
  - Writes `profile.cleared = true` to OrbitDB (so other devices see the clear)
  - Clears local cache via the composed StorageProvider's `clear()` method

  `has('wallet_exists')` on cold cache:
  - When local cache has no data, checks OrbitDB for `identity.*` keys as fallback

  `saveTrackedAddresses()` / `loadTrackedAddresses()` map to `addresses.tracked` Profile key.

  Bootstrap sequence for Profile encryption (also documented in WU-P02):
  1. User provides password (or mnemonic for recovery)
  2. Password decrypts mnemonic/masterKey from local cache or user input
  3. masterKey -> HKDF -> profileEncryptionKey
  4. profileEncryptionKey decrypts all OrbitDB values
  5. On fresh device with no local cache: user must provide mnemonic + password

- **Acceptance criteria:**
  1. Implements all methods of `StorageProvider` interface
  2. Key mapping covers every entry in the Section 5.2 table
  3. Cache-only keys never written to OrbitDB
  4. Critical keys written to both local cache and OrbitDB
  5. Existing sphere-sdk code using `storage.get('mnemonic')` works unchanged
  6. `setIdentity()` is synchronous, does NOT open network connections
  7. Values encrypted before OrbitDB write, decrypted on read
  8. Dynamic key patterns (`{addr}_swap:*`) mapped correctly
  9. IPFS state keys excluded from OrbitDB and cache
  10. `keys()` returns keys in legacy format with `sphere_` prefix
  11. `clear()` writes `profile.cleared` to OrbitDB and clears local cache
  12. `has('wallet_exists')` on cold cache falls back to OrbitDB `identity.*` check
  13. Bootstrap sequence correctly derives encryption key from password -> mnemonic -> masterKey -> HKDF
  14. Unit tests: key mapping for all global keys, all per-address keys, cache-only exclusion, dynamic patterns, reverse mapping

---

**WU-P05: ProfileTokenStorageProvider**

- **ID:** WU-P05
- **Name:** ProfileTokenStorageProvider implementing TokenStorageProvider
- **Files to create:**
  - `profile/profile-token-storage-provider.ts`
  - `profile/txf-adapter.ts`
- **Dependencies:** WU-P01 (types), WU-P02 (encryption), WU-P03 (OrbitDB adapter)
- **Parallel group:** B (Layer 1)
- **Description:** Implements `TokenStorageProvider<TxfStorageDataBase>` (from `/home/vrogojin/uxf/storage/storage-provider.ts`) using the UXF multi-bundle model. This is the most complex provider -- it bridges the TxfStorageData format (what PaymentsModule expects) and the UXF bundle format (what the Profile stores). References PROFILE-ARCHITECTURE.md Section 5.3 (Token Storage Flow), Section 2.3 (Multi-Bundle Model), Section 2.4 (TXF Compatibility).

  This WU includes what was previously split across TxfAdapter (WU-P08), BundleManager (WU-P07), CAR pinning (WU-P09), and SyncCoordinator (WU-P12). All are inlined as private helpers within the provider.

  **TxfAdapter** (`txf-adapter.ts`) handles conversion:
  - `txfTokenToITokenJson(token: TxfToken): ITokenJson` -- per DESIGN-DECISIONS.md Decision 1
  - `iTokenJsonToTxfToken(token: ITokenJson, tokenId: string): TxfToken` -- reverse conversion
  - `buildTxfStorageData(tokens: Map<string, ITokenJson>, operationalState: {...}): TxfStorageDataBase` -- reassemble TxfStorageData from UXF tokens + profile operational keys
  - `extractTokensFromTxfData(data: TxfStorageDataBase): Map<string, TxfToken>` -- extracts all `_<tokenId>`, `archived-<tokenId>`, `_forked_*` entries
  - `extractOperationalState(data: TxfStorageDataBase): OperationalState` -- extracts `_tombstones`, `_outbox`, `_mintOutbox`, `_sent`, `_invalid`, `_history`, `_invalidatedNametags`

  **BundleManager** (private methods within the provider) -- thin CRUD on OrbitDB keys:
  - `listBundles(): Promise<Map<string, UxfBundleRef>>` -- `db.all()` filtered by `tokens.bundle.` prefix
  - `listActiveBundles(): Promise<Map<string, UxfBundleRef>>` -- filter to `status === 'active'`
  - `addBundle(cid: string, ref: UxfBundleRef): Promise<void>` -- `db.put('tokens.bundle.' + cid, ref)`
  - `removeBundle(cid: string): Promise<void>` -- `db.del('tokens.bundle.' + cid)`
  - `shouldConsolidate(): Promise<boolean>` -- true if active count > 3. Logs warning but does NOT consolidate (consolidation deferred to Phase 2).

  **CAR pinning** (private helper methods) -- reuses existing `IpfsHttpClient` patterns from `/home/vrogojin/uxf/impl/shared/ipfs/ipfs-http-client.ts`:
  - `pinCar(encryptedCarBytes: Uint8Array): Promise<string>` -- uploads CAR to IPFS gateway, returns CID
  - `fetchCar(cid: string): Promise<Uint8Array>` -- fetches CAR from IPFS gateway by CID
  - Uses existing gateway infrastructure from `DEFAULT_IPFS_GATEWAYS` in `/home/vrogojin/uxf/constants.ts`

  **Write-behind buffer:**
  - `save()` writes to local cache immediately, queues IPFS pin + OrbitDB write
  - Debounce window: 2 seconds (matches IpfsStorageProvider pattern)
  - Multiple rapid `save()` calls coalesce into single IPFS pin

  **Sync/replication callbacks** (inline, replacing WU-P12):
  - On OrbitDB replication delivering new `tokens.bundle.*` keys, emit `storage:remote-updated` via the `onEvent()` callback
  - This triggers PaymentsModule reload (existing subscription)

  `save(data: TxfStorageData)` flow (Section 5.3 "Saving tokens"):
  1. Write to local cache immediately
  2. Extract tokens from `data` (keys starting with `_` that are TxfToken objects)
  3. Convert each to `ITokenJson` via adapter
  4. `UxfPackage.ingestAll()` to build UXF package
  5. `UxfPackage.toCar()` to serialize
  6. Encrypt CAR with `profileEncryptionKey` (random IV)
  7. Pin encrypted CAR to IPFS (debounced -- coalesced with other save() calls within 2s window)
  8. `db.put('tokens.bundle.' + cid, bundleRef)` in OrbitDB
  9. Store operational state (`_tombstones`, `_outbox`, `_sent`, `_history`, `_mintOutbox`, `_invalidatedNametags`) as separate profile keys via `db.put()`
  10. Check `shouldConsolidate()` -- log warning if bundle count > 3

  `load()` flow (Section 5.3 "Loading tokens"):
  1. `db.all()` with prefix `tokens.bundle.` to list all bundle refs
  2. Filter to `status === 'active'`
  3. For each CID: fetch CAR from IPFS (or local cache), decrypt, `UxfPackage.fromCar()`
  4. `mergedPkg.merge(pkg)` for each bundle
  5. `mergedPkg.assembleAll()` to get all tokens as `ITokenJson`
  6. Convert each to `TxfToken` via adapter
  7. Read operational state from profile keys
  8. Build and return `TxfStorageDataBase`

  `sync()` behavior:
  - Check for new bundle keys from OrbitDB (query `tokens.bundle.*` and compare against locally known set)
  - Fetch and merge any new bundles not yet in local cache
  - Return valid `SyncResult` with merged `TxfStorageDataBase` and accurate `added`/`removed` counts
  - This is an explicit operation, not just "OrbitDB handles it"

  `createForAddress()` returns a new instance scoped to a different address (same pattern as `IpfsStorageProvider.createForAddress()` at line 862 of `/home/vrogojin/uxf/impl/shared/ipfs/ipfs-storage-provider.ts`).

  History operations (`addHistoryEntry`, `getHistoryEntries`, etc.) are implemented by reading/writing `{addr}.transactionHistory` profile key.

- **Acceptance criteria:**
  1. Implements all methods of `TokenStorageProvider<TxfStorageDataBase>`
  2. `save()` creates a new UXF bundle and writes to OrbitDB
  3. `load()` merges all active bundles and returns valid TxfStorageDataBase
  4. TxfToken-to-ITokenJson round-trip preserves all token data
  5. Nametag tokens correctly handled (recursive structure in ITokenJson vs string[] in TxfToken)
  6. Archived and forked tokens extracted and converted correctly
  7. Operational state (_tombstones, _outbox, _history, etc.) stored as separate profile keys
  8. `createForAddress()` returns independent instance
  9. History operations functional
  10. N consecutive `save()` calls within 2s produce exactly 1 IPFS pin
  11. Replication of new bundle key from remote device triggers `storage:remote-updated` event
  12. `shouldConsolidate()` returns true when active count > 3 (logs warning, no consolidation action)
  13. `sync()` returns valid `SyncResult` with accurate added/removed counts
  14. Integration test: save tokens, load them back, verify identical

---

### Layer 2: Integration (Depends on Layer 1)

**Parallel Group C** -- all three WUs can run simultaneously after Layer 1 completes.

---

**WU-P10: Migration Engine**

- **ID:** WU-P10
- **Name:** Migration Engine (Legacy to Profile)
- **Files to create:**
  - `profile/migration.ts`
- **Dependencies:** WU-P04 (ProfileStorageProvider), WU-P05 (ProfileTokenStorageProvider)
- **Parallel group:** C (Layer 2)
- **Description:** Implements the 6-step migration flow from PROFILE-ARCHITECTURE.md Section 7.6. Converts legacy storage format (IndexedDB/file + old IPFS) to Profile format (OrbitDB + UXF bundles).

  Class `ProfileMigration`:
  - `needsMigration(legacyStorage: StorageProvider): Promise<boolean>` -- checks if legacy data exists and Profile doesn't
  - `migrate(legacyStorage: StorageProvider, legacyTokenStorage: TokenStorageProvider, profileStorage: ProfileStorageProvider, profileTokenStorage: ProfileTokenStorageProvider): Promise<MigrationResult>`
  - `getMigrationPhase(): MigrationPhase` -- current phase for resume
  - `resumeMigration(...)` -- resumes from last completed phase

  The 6 steps:
  1. **SYNC OLD IPFS DATA** -- resolve existing IPNS name from `sphere_ipfs_seq_*` keys, fetch old TXF data, merge with local. Skip if no IPFS keys exist. Skip if IPNS resolution fails (log warning).
  2. **TRANSFORM LOCAL DATA** -- read all StorageProvider keys via `keys()`, map to Profile key names (WU-P04 key-mapping). Read all tokens from TokenStorageProvider, convert to ITokenJson (WU-P05 txf-adapter), ingest into UxfPackage. Collect operational state. Extract nametag tokens from `_nametag.token` and `_nametags[].token`. Extract forked tokens from `_forked_*` entries, convert, and ingest. Merge `_sent` entries into `{addr}.transactionHistory` as type=SENT (not stored as a separate key). Consume but do NOT migrate IPFS state keys (`sphere_ipfs_seq_*`, `sphere_ipfs_cid_*`, `sphere_ipfs_ver_*`).
  3. **PERSIST TO ORBITDB** -- open OrbitDB, write all Profile keys via `db.put()`. Pin UXF CAR to IPFS. Add bundle ref.
  4. **SANITY CHECK** -- read back all keys from OrbitDB, compare. Fetch UXF CAR, verify each token exists with correct transaction count and state hash. Verify operational state counts match. Include accounting keys and swap keys in the sanity check. If ANY check fails: abort, keep legacy, log error.
  5. **CLEANUP** -- remove legacy data from local storage. Unpin last known CID from old IPNS. Do NOT delete `SphereVestingCacheV5` IndexedDB database.
  6. **DONE** -- set `migration.phase = 'complete'`

  Recovery: track `migration.phase` as local-only key. On restart, resume from last completed phase.

- **Acceptance criteria:**
  1. Full migration of a wallet with identity + 50 tokens + history + conversations succeeds
  2. Sanity check catches a deliberately corrupted token (abort path works)
  3. Interrupted migration resumes correctly from each of the 6 phases
  4. Legacy data preserved on failure (no data loss)
  5. `SphereVestingCacheV5` not deleted during cleanup
  6. Old IPFS state keys (`ipfs.seq`, `ipfs.cid`, `ipfs.ver`) consumed but not carried forward to Profile
  7. Accounting keys and swap keys included in sanity check
  8. Nametag tokens extracted from `_nametag.token` and `_nametags[].token`
  9. Forked tokens (`_forked_*`) extracted, converted, and ingested
  10. `_sent` entries merged into `{addr}.transactionHistory` as type=SENT
  11. End-to-end integration test covering full lifecycle: init -> send -> receive -> sync -> switchAddress -> clear -> re-init
  12. Integration test with mock legacy storage data

---

**WU-P13: Factory Functions (Standalone)**

- **ID:** WU-P13
- **Name:** Standalone Profile Factory Functions
- **Files to create:**
  - `profile/browser.ts` -- `createBrowserProfileProviders()`
  - `profile/node.ts` -- `createNodeProfileProviders()`
  - `profile/factory.ts` -- shared factory logic
- **Dependencies:** WU-P04 (ProfileStorageProvider), WU-P05 (ProfileTokenStorageProvider)
- **Parallel group:** C (Layer 2)
- **Description:** Standalone factory functions for creating Profile-backed providers. These do NOT modify `impl/browser/index.ts` or `impl/nodejs/index.ts`. References PROFILE-ARCHITECTURE.md Section 8.2 (Factory Functions).

  `profile/browser.ts` exports `createBrowserProfileProviders()`:
  - Calls existing `createBrowserProviders()` internally to get base configuration
  - Wraps with Profile layer: creates `ProfileStorageProvider` (composing `IndexedDBStorageProvider` as local cache) and `ProfileTokenStorageProvider`
  - Returns Profile-backed providers that are drop-in replacements

  `profile/node.ts` exports `createNodeProfileProviders()`:
  - Calls existing `createNodeProviders()` internally to get base configuration
  - Wraps with Profile layer: creates `ProfileStorageProvider` (composing `FileStorageProvider` as local cache) and `ProfileTokenStorageProvider`
  - Returns Profile-backed providers that are drop-in replacements

  When profile providers are used, `IpfsStorageProvider` is NOT created. IPNS-based sync is replaced by OrbitDB replication.

  `profile/factory.ts` contains shared logic:
  - `createProfileProviders(config: ProfileConfig, cacheStorage: StorageProvider): { storage: ProfileStorageProvider, tokenStorage: ProfileTokenStorageProvider }`
  - Wires up OrbitDB adapter, encryption
  - Handles migration detection and trigger

  Additional ProfileConfig options in factory:
  - `profileOrbitDbPeers?: string[]` -- custom bootstrap peers for OrbitDB
  - `profileCacheMaxSizeBytes?: number` -- override default cache size

- **Acceptance criteria:**
  1. `createBrowserProfileProviders()` returns Profile-backed providers
  2. `createNodeProfileProviders()` returns Profile-backed providers
  3. Existing `createBrowserProviders()` and `createNodeProviders()` are NOT modified
  4. `impl/browser/index.ts` and `impl/nodejs/index.ts` are NOT modified
  5. Migration auto-triggers on first init when legacy data exists
  6. IpfsStorageProvider is NOT created when using Profile providers
  7. All existing test suites pass unchanged (no upstream modifications)
  8. Integration test: full init flow with Profile providers

---

**WU-P14: Barrel Exports and Build Configuration**

- **ID:** WU-P14
- **Name:** Barrel Exports and Build Configuration
- **Files to create:**
  - `profile/index.ts`
- **Files to modify:**
  - `tsup.config.ts` -- add profile entry points
  - `package.json` -- add `@orbitdb/core` as peerDependency, add `./profile` and `./profile/browser` and `./profile/node` export maps
- **Dependencies:** All WU-P01 through WU-P13
- **Parallel group:** C (Layer 2)
- **Description:** Public API surface and build configuration for the Profile module. References DESIGN-DECISIONS.md Decision 14 (Module Placement -- top-level `uxf/` pattern, but Profile is at `profile/`).

  Exports from `profile/index.ts`:
  - Types: `ProfileConfig`, `UxfBundleRef`, `MigrationPhase`, `ProfileEncryptionConfig`
  - Classes: `ProfileStorageProvider`, `ProfileTokenStorageProvider`
  - Factory: `createProfileProviders`
  - Encryption: `deriveProfileEncryptionKey` (for advanced users who need direct access)
  - Errors: `ProfileError`

  Platform-specific entry points (matching `impl/browser` / `impl/nodejs` pattern):
  - `profile/browser.ts` -- browser-specific factory (`createBrowserProfileProviders`)
  - `profile/node.ts` -- Node.js-specific factory (`createNodeProfileProviders`)

  New tsup entries:
  ```
  {
    entry: { 'profile/index': 'profile/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    platform: 'neutral',
    target: 'es2022',
    external: [
      /^@unicitylabs\//,
      '@orbitdb/core',
      '@ipld/dag-cbor',
      '@ipld/car',
      'multiformats',
    ],
  }
  ```

  Additional entries for `profile/browser` and `profile/node` following the same pattern as `impl/browser` and `impl/nodejs` entries.

  New package.json exports:
  ```
  "./profile": {
    "import": { "types": "./dist/profile/index.d.ts", "default": "./dist/profile/index.js" },
    "require": { "types": "./dist/profile/index.d.cts", "default": "./dist/profile/index.cjs" }
  },
  "./profile/browser": {
    "import": { "types": "./dist/profile/browser.d.ts", "default": "./dist/profile/browser.js" },
    "require": { "types": "./dist/profile/browser.d.cts", "default": "./dist/profile/browser.cjs" }
  },
  "./profile/node": {
    "import": { "types": "./dist/profile/node.d.ts", "default": "./dist/profile/node.js" },
    "require": { "types": "./dist/profile/node.d.cts", "default": "./dist/profile/node.cjs" }
  }
  ```

  Dependency management:
  - `@orbitdb/core` as `peerDependency` with `peerDependenciesMeta: { "@orbitdb/core": { "optional": true } }` (NOT a direct `dependency`)
  - Runtime check in `ProfileStorageProvider` and `ProfileTokenStorageProvider` constructors: throw clear error if `@orbitdb/core` is not installed
  - Verify libp2p version compatibility with existing `@libp2p/crypto` deps

  The main `index.ts` does NOT re-export Profile runtime code to avoid pulling OrbitDB into the main bundle. Type-only re-exports are acceptable.

- **Acceptance criteria:**
  1. `import { ProfileStorageProvider } from '@unicitylabs/sphere-sdk/profile'` works
  2. `import { createBrowserProfileProviders } from '@unicitylabs/sphere-sdk/profile/browser'` works
  3. `import { createNodeProfileProviders } from '@unicitylabs/sphere-sdk/profile/node'` works
  4. `import type { UxfBundleRef } from '@unicitylabs/sphere-sdk/profile'` works (type-only)
  5. No circular dependencies
  6. Tree-shaking: importing from main entry does not pull in OrbitDB runtime
  7. `npm run build` produces `dist/profile/index.js`, `dist/profile/browser.js`, `dist/profile/node.js` and their `.d.ts` files
  8. Main bundle size unchanged (OrbitDB not included unless Profile entry point is imported)
  9. TypeScript declarations generated correctly
  10. Existing build entries unaffected
  11. Runtime error with clear message when `@orbitdb/core` is not installed

---

### Deferred to Phase 2

The following components are not needed for correctness in Phase 1. They are noted here for future implementation:

- **ConsolidationEngine** (was WU-P11) -- merges multiple active UXF bundles into a single consolidated bundle. Not needed for correctness, only for performance. Phase 1 includes a `shouldConsolidate()` check in WU-P05 that logs a warning when bundle count exceeds 3.

- **Local Cache Layer** (was WU-P06) -- custom cache implementations deferred. Phase 1 reuses existing `IndexedDBStorageProvider` (browser) and `FileStorageProvider` (Node.js) as the local cache directly, composed by `ProfileStorageProvider`.

---

### Critical Files for Implementation

- `/home/vrogojin/uxf/storage/storage-provider.ts` -- the StorageProvider and TokenStorageProvider interfaces that ProfileStorageProvider and ProfileTokenStorageProvider must implement
- `/home/vrogojin/uxf/constants.ts` -- STORAGE_KEYS_GLOBAL and STORAGE_KEYS_ADDRESS that define the key mapping source for WU-P04
- `/home/vrogojin/uxf/impl/shared/ipfs/ipfs-storage-provider.ts` -- the existing IPFS provider whose patterns (write-behind buffer, identity derivation, createForAddress, event emission) should be followed
- `/home/vrogojin/uxf/uxf/UxfPackage.ts` -- the UXF package API (ingest, merge, toCar, fromCar, assembleAll) that the ProfileTokenStorageProvider calls
- `/home/vrogojin/uxf/impl/shared/ipfs/ipfs-http-client.ts` -- existing IPFS HTTP client for CAR pinning pattern reuse
