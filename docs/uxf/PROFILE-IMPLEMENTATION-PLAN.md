# UXF Profile Implementation Plan

**Status:** Draft — pending validation
**Date:** 2026-03-30

---

## Implementation Plan: UXF Profile System

### Summary of Architecture Understanding

The UXF Profile system introduces a three-tier persistence model: OrbitDB (source of truth with CRDT conflict resolution), IPFS (content-addressed storage for UXF CAR token bundles), and local cache (fast transient layer). It integrates with existing sphere-sdk via `ProfileStorageProvider` (implementing `StorageProvider`) and `ProfileTokenStorageProvider` (implementing `TokenStorageProvider<TxfStorageDataBase>`). Token inventory uses a multi-bundle model where each device writes separate `tokens.bundle.{CID}` keys to OrbitDB, avoiding LWW conflicts. Lazy consolidation merges bundles in background.

Key files that anchor this design:
- `/home/vrogojin/uxf/storage/storage-provider.ts` -- the interfaces to implement
- `/home/vrogojin/uxf/impl/shared/ipfs/ipfs-storage-provider.ts` -- existing IPFS provider pattern to follow
- `/home/vrogojin/uxf/constants.ts` -- storage key mapping source
- `/home/vrogojin/uxf/uxf/UxfPackage.ts` -- UXF package operations (ingest, merge, toCar, fromCar)
- `/home/vrogojin/uxf/impl/browser/index.ts` and `/home/vrogojin/uxf/impl/nodejs/index.ts` -- factory patterns

---

### Layer 0: Foundation (No Dependencies)

**Parallel Group A** -- all three WUs can run simultaneously.

---

**WU-P01: Profile Types and Interfaces**

- **ID:** WU-P01
- **Name:** Profile Types and Interfaces
- **Files to create:**
  - `profile/types.ts`
  - `profile/errors.ts`
- **Dependencies:** None
- **Parallel group:** A (Layer 0)
- **Description:** Define all type definitions for the Profile system. References PROFILE-ARCHITECTURE.md Section 2 (Profile Schema), Section 2.1 (Global Keys), Section 2.2 (Per-Address Keys), Section 2.3 (UxfBundleRef), Section 5.1 (Interface Compatibility).

  Types to define:
  - `ProfileConfig` -- configuration for profile initialization (OrbitDB connection details, encryption flag, cache settings, consolidation retention period). Mirrors the `IpfsStorageConfig` pattern from `/home/vrogojin/uxf/impl/shared/ipfs/ipfs-types.ts`.
  - `UxfBundleRef` -- exactly as specified in Section 2.3: `{ cid, status, createdAt, device?, supersededBy?, removeFromProfileAfter?, tokenCount? }`
  - `ProfileKeyMap` -- type-safe mapping of old storage keys (from `STORAGE_KEYS_GLOBAL` and `STORAGE_KEYS_ADDRESS` in `/home/vrogojin/uxf/constants.ts`) to new Profile key names (Section 5.2 mapping table)
  - `ConsolidationPendingState` -- `{ sourceCids: string[], startedAt: number, device: string }` from Section 2.3 crash recovery
  - `MigrationPhase` -- `'syncing' | 'transforming' | 'persisting' | 'verifying' | 'cleaning' | 'complete'` from Section 7.6
  - `ProfileEncryptionConfig` -- encryption key derivation params (Section 9.1)
  - `ProfileStorageProviderOptions` -- options for the StorageProvider implementation
  - `ProfileTokenStorageProviderOptions` -- options for the TokenStorageProvider implementation
  - Error codes: `PROFILE_NOT_INITIALIZED`, `ORBITDB_WRITE_FAILED`, `BUNDLE_NOT_FOUND`, `CONSOLIDATION_IN_PROGRESS`, `MIGRATION_FAILED`, `ENCRYPTION_FAILED`, `DECRYPTION_FAILED`

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

  Functions to implement:
  - `deriveProfileEncryptionKey(masterKey: Uint8Array): Uint8Array` -- HKDF(masterKey, "uxf-profile-encryption", 32) using `@noble/hashes/hkdf` and `@noble/hashes/sha256` (already in dependencies)
  - `encryptProfileValue(key: Uint8Array, plaintext: Uint8Array): Uint8Array` -- AES-256-GCM with random 12-byte IV, returns `IV || ciphertext || tag`. Uses Web Crypto API (browser) or Node.js `crypto` module.
  - `decryptProfileValue(key: Uint8Array, encrypted: Uint8Array): Uint8Array` -- AES-256-GCM decryption, extracts IV from first 12 bytes
  - `encryptCarFile(key: Uint8Array, carBytes: Uint8Array, carContentHash: Uint8Array): Uint8Array` -- AES-256-GCM with deterministic IV: `HMAC(key, carContentHash)[:12]` (Section 9.1: "For CAR files, use a deterministic IV"). This ensures identical CAR content produces identical encrypted bytes and therefore identical CIDs.
  - `decryptCarFile(key: Uint8Array, encrypted: Uint8Array): Uint8Array` -- same as `decryptProfileValue` (IV is prepended)

  Platform abstraction: Use `globalThis.crypto.subtle` which is available in both modern browsers and Node.js 18+. Fallback to `@noble/ciphers` if subtle is unavailable (for older Node.js environments).

- **Acceptance criteria:**
  1. Round-trip encrypt/decrypt produces identical plaintext
  2. Two encryptions of the same plaintext with random IV produce different ciphertexts
  3. `encryptCarFile` with same key and same content hash produces identical output (deterministic IV)
  4. Key derivation is deterministic -- same master key always derives same encryption key
  5. Works in both browser (Web Crypto) and Node.js environments
  6. Unit tests cover: key derivation, encrypt/decrypt round-trip, deterministic CAR IV, invalid key rejection, tampered ciphertext detection (GCM auth tag failure)

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

  Implementation notes:
  - OrbitDB identity derived from wallet's secp256k1 key (Section 4.1)
  - Database type: `keyvalue` (Section 4.2)
  - Access control: only wallet holder can write (Section 9.3)
  - `@orbitdb/core` is a new dependency -- added in WU-P16

- **Acceptance criteria:**
  1. `connect()` creates a deterministic database address from a given private key
  2. `put/get/del` round-trip works correctly
  3. `all()` with prefix filter returns only matching keys
  4. `close()` cleanly shuts down Helia and libp2p (no dangling connections)
  5. `onReplication` callback fires when remote entries arrive (testable with two instances)
  6. Type-safe -- no `any` types in the public API
  7. Integration test: two OrbitDB instances sharing the same identity replicate a `put()` within 5 seconds

---

### Layer 1: Storage Providers (Depends on Layer 0)

**Parallel Group B** -- all three WUs can run simultaneously after Layer 0 completes.

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

  The provider must be a drop-in replacement for `IndexedDBStorageProvider` or `FileStorageProvider`. Existing code calling `storage.get('mnemonic')` must continue to work -- the provider translates old key names to Profile key names using the mapping table in Section 5.2.

  `key-mapping.ts` implements the translation:
  - Strips `sphere_` prefix (from `STORAGE_PREFIX` in constants.ts)
  - Maps `mnemonic` to `identity.mnemonic`, `master_key` to `identity.masterKey`, etc.
  - Maps per-address keys: `{addressId}_pending_transfers` to `{addressId}.pendingTransfers`
  - Cache-only keys (`token_registry_cache`, `price_cache`, etc.) are stored only in the local cache, NOT written to OrbitDB (Section 2.1 "Cache-only keys")

  Write behavior:
  - Critical keys (identity, tracked addresses, transport timestamps): write to local cache AND OrbitDB
  - Cache-only keys: write to local cache only
  - `wallet_exists` is special: maintained as a local-only fast-path flag (Section 5.2 note)

  Read behavior:
  - Read from local cache first (fast path)
  - On cache miss: read from OrbitDB, populate cache
  - Decrypt values using `profileEncryptionKey`

  `setIdentity()` derives the `profileEncryptionKey` from `identity.privateKey` and opens the OrbitDB database.

  `saveTrackedAddresses()` / `loadTrackedAddresses()` map to `addresses.tracked` Profile key.

- **Acceptance criteria:**
  1. Implements all methods of `StorageProvider` interface
  2. Key mapping covers every entry in the Section 5.2 table
  3. Cache-only keys never written to OrbitDB
  4. Critical keys written to both local cache and OrbitDB
  5. Existing sphere-sdk code using `storage.get('mnemonic')` works unchanged
  6. `setIdentity()` derives encryption key and opens OrbitDB connection
  7. Values encrypted before OrbitDB write, decrypted on read
  8. Unit tests: key mapping for all global keys, all per-address keys, cache-only exclusion

---

**WU-P05: ProfileTokenStorageProvider**

- **ID:** WU-P05
- **Name:** ProfileTokenStorageProvider implementing TokenStorageProvider
- **Files to create:**
  - `profile/profile-token-storage-provider.ts`
  - `profile/txf-adapter.ts`
- **Dependencies:** WU-P01 (types), WU-P02 (encryption), WU-P03 (OrbitDB adapter)
- **Parallel group:** B (Layer 1)
- **Description:** Implements `TokenStorageProvider<TxfStorageDataBase>` (from `/home/vrogojin/uxf/storage/storage-provider.ts`) using the UXF multi-bundle model. References PROFILE-ARCHITECTURE.md Section 5.3 (Token Storage Flow), Section 2.3 (Multi-Bundle Model), Section 2.4 (TXF Compatibility).

  This is the most complex provider -- it bridges the TxfStorageData format (what PaymentsModule expects) and the UXF bundle format (what the Profile stores).

  `txf-adapter.ts` handles conversion:
  - `txfTokenToITokenJson(token: TxfToken): ITokenJson` -- per DESIGN-DECISIONS.md Decision 1
  - `iTokenJsonToTxfToken(token: ITokenJson): TxfToken` -- reverse conversion
  - `buildTxfStorageData(tokens: Map<string, ITokenJson>, operationalState: {...}): TxfStorageDataBase` -- reassemble TxfStorageData from UXF tokens + profile operational keys

  `save(data: TxfStorageData)` flow (Section 5.3 "Saving tokens"):
  1. Extract tokens from `data` (keys starting with `_` that are TxfToken objects)
  2. Convert each to `ITokenJson` via adapter
  3. `UxfPackage.ingestAll()` to build UXF package
  4. `UxfPackage.toCar()` to serialize
  5. Encrypt CAR with `profileEncryptionKey` (deterministic IV)
  6. Pin encrypted CAR to IPFS
  7. `db.put('tokens.bundle.' + cid, bundleRef)` in OrbitDB
  8. Store operational state (`_tombstones`, `_outbox`, `_sent`, `_history`, `_mintOutbox`, `_invalidatedNametags`) as separate profile keys via `db.put()`

  `load()` flow (Section 5.3 "Loading tokens"):
  1. `db.all()` with prefix `tokens.bundle.` to list all bundle refs
  2. Filter to `status === 'active'`
  3. For each CID: fetch CAR from IPFS (or local cache), decrypt, `UxfPackage.fromCar()`
  4. `mergedPkg.merge(pkg)` for each bundle
  5. `mergedPkg.assembleAll()` to get all tokens as `ITokenJson`
  6. Convert each to `TxfToken` via adapter
  7. Read operational state from profile keys
  8. Build and return `TxfStorageDataBase`

  `sync()` is largely handled by OrbitDB replication (Section 5.3 "Syncing"). The provider checks for new bundle keys and merges them.

  `createForAddress()` returns a new instance scoped to a different address (same pattern as `IpfsStorageProvider.createForAddress()` at line 862 of `/home/vrogojin/uxf/impl/shared/ipfs/ipfs-storage-provider.ts`).

  History operations (`addHistoryEntry`, `getHistoryEntries`, etc.) are implemented by reading/writing `{addr}.transactionHistory` profile key.

- **Acceptance criteria:**
  1. Implements all methods of `TokenStorageProvider<TxfStorageDataBase>`
  2. `save()` creates a new UXF bundle and writes to OrbitDB
  3. `load()` merges all active bundles and returns valid TxfStorageDataBase
  4. TxfToken-to-ITokenJson round-trip preserves all token data
  5. Operational state (_tombstones, _outbox, _history, etc.) stored as separate profile keys
  6. `createForAddress()` returns independent instance
  7. History operations functional
  8. Integration test: save tokens, load them back, verify identical

---

**WU-P06: Local Cache Layer**

- **ID:** WU-P06
- **Name:** Local Cache Layer
- **Files to create:**
  - `profile/cache/profile-cache.ts` (interface)
  - `profile/cache/indexeddb-profile-cache.ts` (browser)
  - `profile/cache/file-profile-cache.ts` (Node.js)
- **Dependencies:** WU-P01 (types)
- **Parallel group:** B (Layer 1)
- **Description:** Local cache implementations for profile KV data and CAR block caching. References PROFILE-ARCHITECTURE.md Section 6.1 (Browser: IndexedDB), Section 6.2 (Node.js: SQLite/LevelDB), Section 6.3 (Cache Eviction), Section 3.5 (Lazy Loading).

  Interface `ProfileCache`:
  - `getKv(key: string): Promise<Uint8Array | null>` -- read from profile-kv store
  - `setKv(key: string, value: Uint8Array): Promise<void>` -- write to profile-kv store
  - `deleteKv(key: string): Promise<void>`
  - `getAllKv(prefix?: string): Promise<Map<string, Uint8Array>>`
  - `getCarBlock(cid: string): Promise<Uint8Array | null>` -- read block from car-blocks store
  - `putCarBlock(cid: string, data: Uint8Array): Promise<void>`
  - `getManifest(cid: string): Promise<Uint8Array | null>` -- read from car-manifests store
  - `putManifest(cid: string, manifest: Uint8Array): Promise<void>`
  - `clear(): Promise<void>`
  - `evict(maxAgeMs: number, maxSizeBytes: number): Promise<number>` -- LRU eviction (Section 6.3)

  Browser implementation (IndexedDB):
  - Database name: `sphere-profile-cache` (Section 6.1)
  - Object stores: `profile-kv`, `car-blocks` (keyed by CID, with `accessedAt` index), `car-manifests`
  - Calls `navigator.storage.persist()` per IPFS-KV-RESEARCH.md Section 7 recommendation

  Node.js implementation (file-based):
  - KV data: JSON file at `~/.sphere/profile-cache.json`
  - CAR blocks: directory at `~/.sphere/car-blocks/` with one file per CID
  - Manifests: JSON file at `~/.sphere/car-manifests.json`
  - Alternative: a single better-sqlite3 database as described in Section 6.2 (deferred to later iteration; file-based is simpler for Phase 1)

- **Acceptance criteria:**
  1. Interface is platform-agnostic
  2. Browser implementation creates correct IndexedDB schema
  3. Node.js implementation creates correct directory structure
  4. LRU eviction removes oldest blocks first, respects size cap
  5. Manifest-pinned blocks are never evicted (Section 6.3)
  6. `clear()` removes all cached data without affecting OrbitDB state
  7. Unit tests with `fake-indexeddb` (already in devDependencies)

---

### Layer 2: Token Integration (Depends on Layer 1 + existing UXF module)

**Parallel Group C** -- all three WUs can run simultaneously after Layer 1 completes.

---

**WU-P07: Multi-Bundle Manager**

- **ID:** WU-P07
- **Name:** Multi-Bundle Manager
- **Files to create:**
  - `profile/bundle-manager.ts`
- **Dependencies:** WU-P03 (OrbitDB adapter), WU-P01 (types), WU-P05 (token storage provider -- for integration)
- **Parallel group:** C (Layer 2)
- **Description:** Manages the lifecycle of UXF bundles in OrbitDB using the per-key pattern. References PROFILE-ARCHITECTURE.md Section 2.3 (Multi-Bundle Model), Section 2.3 "Lazy Consolidation", Section 2.3 "Bundle Lifecycle", Section 2.3 "Consolidation Triggers".

  Class `BundleManager`:
  - `listBundles(): Promise<Map<string, UxfBundleRef>>` -- `db.all()` filtered by `tokens.bundle.` prefix, deserialize values
  - `listActiveBundles(): Promise<Map<string, UxfBundleRef>>` -- filter to `status === 'active'`
  - `addBundle(cid: string, ref: UxfBundleRef): Promise<void>` -- `db.put('tokens.bundle.' + cid, ref)`
  - `removeBundle(cid: string): Promise<void>` -- `db.del('tokens.bundle.' + cid)`
  - `markSuperseded(cid: string, supersededBy: string, retentionMs: number): Promise<void>` -- updates status to 'superseded', sets `supersededBy` and `removeFromProfileAfter`
  - `cleanupExpired(): Promise<string[]>` -- removes bundle keys past their `removeFromProfileAfter` timestamp
  - `getActiveBundleCount(): Promise<number>` -- count for consolidation trigger check (threshold: 3 per Section 2.3 "Consolidation Triggers")
  - `shouldConsolidate(): Promise<boolean>` -- true if active count > 3

  Performance guard: if active bundle count exceeds 20, emit a degraded-mode warning (Section 2.3 "Performance limits").

- **Acceptance criteria:**
  1. `addBundle` writes a single key to OrbitDB -- no read-modify-write
  2. `listActiveBundles` returns only active bundles
  3. `markSuperseded` correctly sets supersededBy and removeFromProfileAfter
  4. `cleanupExpired` only removes bundles past retention period
  5. `shouldConsolidate` returns true when active count > 3
  6. Unit tests: add 5 bundles, consolidate 3, verify 2 active + 3 superseded

---

**WU-P08: TxfToken-ITokenJson Adapter**

- **ID:** WU-P08
- **Name:** TxfToken-ITokenJson Adapter
- **Files to create:**
  - `profile/txf-adapter.ts` (may already be started in WU-P05; this WU completes and tests it thoroughly)
- **Dependencies:** WU-P01 (types)
- **Parallel group:** C (Layer 2) -- can start early since it has minimal deps
- **Description:** Bidirectional conversion between `TxfToken` (from `/home/vrogojin/uxf/types/txf.ts`) and `ITokenJson` (from `@unicitylabs/state-transition-sdk`). References DESIGN-DECISIONS.md Decision 1 (Canonical Input Type), PROFILE-ARCHITECTURE.md Section 2.4 (TXF Compatibility mapping table).

  Key conversion challenges from Decision 1:
  - `TxfToken.nametags` is `string[]` while `ITokenJson.nametags` is recursive `Token[]` -- nametag tokens must be recursively deconstructed/reconstructed
  - `TxfToken` wraps genesis/transactions differently than `ITokenJson`
  - The adapter must handle archived tokens (`archived-{tokenId}` prefix) and forked tokens (`_forked_{tokenId}_{hash}` prefix) from TXF format

  Functions:
  - `txfTokenToITokenJson(token: TxfToken): ITokenJson`
  - `iTokenJsonToTxfToken(token: ITokenJson, tokenId: string): TxfToken`
  - `extractTokensFromTxfData(data: TxfStorageDataBase): Map<string, TxfToken>` -- extracts all `_<tokenId>`, `archived-<tokenId>`, `_forked_*` entries
  - `extractOperationalState(data: TxfStorageDataBase): OperationalState` -- extracts `_tombstones`, `_outbox`, `_mintOutbox`, `_sent`, `_invalid`, `_history`, `_invalidatedNametags`

- **Acceptance criteria:**
  1. Round-trip conversion preserves all token fields
  2. Nametag tokens correctly handled (recursive structure in ITokenJson vs string[] in TxfToken)
  3. Archived and forked tokens extracted and converted correctly
  4. Operational state extraction is complete (all TXF reserved keys)
  5. Unit tests with real TxfToken fixtures (from existing test data)

---

**WU-P09: CAR Pinning Service**

- **ID:** WU-P09
- **Name:** CAR Pinning Service
- **Files to create:**
  - `profile/car-pinning.ts`
- **Dependencies:** WU-P02 (encryption), WU-P01 (types)
- **Parallel group:** C (Layer 2)
- **Description:** Service for pinning/fetching encrypted UXF CAR files to/from IPFS gateways. References PROFILE-ARCHITECTURE.md Section 3.2 step 2a ("pin CAR to IPFS"), Section 5.3 ("UxfPackage.toCar() -> pin CAR to IPFS"), IPFS-KV-RESEARCH.md Section 5 (CAR Files), Section 10 (Lazy Loading).

  Reuses patterns from existing `IpfsHttpClient` in `/home/vrogojin/uxf/impl/shared/ipfs/ipfs-http-client.ts`.

  Interface `CarPinningService`:
  - `pinCar(encryptedCarBytes: Uint8Array): Promise<string>` -- uploads CAR to IPFS gateway, returns CID
  - `fetchCar(cid: string): Promise<Uint8Array>` -- fetches CAR from IPFS gateway by CID
  - `verifyCidAccessible(cid: string): Promise<boolean>` -- checks if CID is still pinned/accessible (Section 2.3 "CID availability")
  - `fetchBlock(cid: string): Promise<Uint8Array>` -- fetches individual IPLD block (for lazy loading per Section 3.5)

  Uses existing gateway infrastructure from `DEFAULT_IPFS_GATEWAYS` in `/home/vrogojin/uxf/constants.ts`. HTTP client follows multi-gateway fallback pattern from `IpfsHttpClient`.

- **Acceptance criteria:**
  1. `pinCar` uploads and returns valid CID
  2. `fetchCar` retrieves exactly what was pinned (byte-identical after decryption)
  3. `verifyCidAccessible` returns true for pinned CIDs, false for nonexistent
  4. Multi-gateway fallback works (try next gateway on failure)
  5. Integration test: pin a small CAR, fetch it back, verify content

---

### Layer 3: Operations (Depends on Layer 2)

**Parallel Group D** -- all three WUs can run simultaneously after Layer 2 completes.

---

**WU-P10: Migration Engine**

- **ID:** WU-P10
- **Name:** Migration Engine (Legacy to Profile)
- **Files to create:**
  - `profile/migration.ts`
- **Dependencies:** WU-P04 (ProfileStorageProvider), WU-P05 (ProfileTokenStorageProvider), WU-P08 (TxfAdapter), WU-P09 (CAR pinning), WU-P07 (BundleManager)
- **Parallel group:** D (Layer 3)
- **Description:** Implements the 6-step migration flow from PROFILE-ARCHITECTURE.md Section 7.6. Converts legacy storage format (IndexedDB/file + old IPFS) to Profile format (OrbitDB + UXF bundles).

  Class `ProfileMigration`:
  - `needsMigration(legacyStorage: StorageProvider): Promise<boolean>` -- checks if legacy data exists and Profile doesn't
  - `migrate(legacyStorage: StorageProvider, legacyTokenStorage: TokenStorageProvider, profileStorage: ProfileStorageProvider, profileTokenStorage: ProfileTokenStorageProvider): Promise<MigrationResult>`
  - `getMigrationPhase(): MigrationPhase` -- current phase for resume
  - `resumeMigration(...)` -- resumes from last completed phase

  The 6 steps:
  1. **SYNC OLD IPFS DATA** -- resolve existing IPNS name from `sphere_ipfs_seq_*` keys, fetch old TXF data, merge with local. Skip if no IPFS keys exist. Skip if IPNS resolution fails (log warning).
  2. **TRANSFORM LOCAL DATA** -- read all StorageProvider keys via `keys()`, map to Profile key names (WU-P04 key-mapping). Read all tokens from TokenStorageProvider, convert to ITokenJson (WU-P08), ingest into UxfPackage. Collect operational state.
  3. **PERSIST TO ORBITDB** -- open OrbitDB, write all Profile keys via `db.put()`. Pin UXF CAR to IPFS. Add bundle ref.
  4. **SANITY CHECK** -- read back all keys from OrbitDB, compare. Fetch UXF CAR, verify each token exists with correct transaction count and state hash. Verify operational state counts match. If ANY check fails: abort, keep legacy, log error.
  5. **CLEANUP** -- remove legacy data from local storage. Unpin last known CID from old IPNS. Do NOT delete `SphereVestingCacheV5` IndexedDB database.
  6. **DONE** -- set `migration.phase = 'complete'`

  Recovery: track `migration.phase` as local-only key. On restart, resume from last completed phase.

- **Acceptance criteria:**
  1. Full migration of a wallet with identity + 50 tokens + history + conversations succeeds
  2. Sanity check catches a deliberately corrupted token (abort path works)
  3. Interrupted migration resumes correctly from each of the 6 phases
  4. Legacy data preserved on failure (no data loss)
  5. `SphereVestingCacheV5` not deleted during cleanup
  6. Old IPFS state keys (`ipfs.seq`, `ipfs.cid`, `ipfs.ver`) not carried forward to Profile
  7. Integration test with mock legacy storage data

---

**WU-P11: Consolidation Engine**

- **ID:** WU-P11
- **Name:** Consolidation Engine
- **Files to create:**
  - `profile/consolidation.ts`
- **Dependencies:** WU-P07 (BundleManager), WU-P09 (CAR pinning), WU-P03 (OrbitDB adapter), WU-P02 (encryption)
- **Parallel group:** D (Layer 3)
- **Description:** Merges multiple active UXF bundles into a single consolidated bundle. References PROFILE-ARCHITECTURE.md Section 2.3 "Lazy Consolidation", "Crash recovery for consolidation", "Concurrent consolidation guard", "Consolidation Triggers".

  Class `ConsolidationEngine`:
  - `consolidate(bundleManager: BundleManager, carPinning: CarPinningService): Promise<ConsolidationResult>`
  - `isConsolidationInProgress(db: ProfileDatabase): Promise<boolean>` -- checks `consolidation.pending` key
  - `recoverFromCrash(db: ProfileDatabase, bundleManager: BundleManager, carPinning: CarPinningService): Promise<void>` -- startup recovery

  Consolidation flow:
  1. Check for existing `consolidation.pending` key -- if present and < 5 minutes old from another device, skip. If > 5 minutes, assume crashed and proceed.
  2. List all active bundles. If count <= 3, skip (no consolidation needed).
  3. Write `consolidation.pending` key to OrbitDB: `{ sourceCids: [...], startedAt: now, device: deviceId }`
  4. For each active CID: fetch CAR, decrypt, `UxfPackage.fromCar()`
  5. Merge all into one UxfPackage
  6. `toCar()`, encrypt, pin to IPFS, get consolidated CID
  7. Add consolidated bundle key via BundleManager
  8. Mark all source bundles as superseded (retention period from `profile.consolidationRetentionMs`, default 7 days, min 24h)
  9. Delete `consolidation.pending` key
  10. After safety period: `cleanupExpired()` removes superseded bundle keys

  Crash recovery:
  - On startup: if `consolidation.pending` exists, check if consolidated CID was pinned
  - If pinned: complete steps 7-9
  - If not pinned: delete pending key, restart consolidation

- **Acceptance criteria:**
  1. Consolidation merges 5 bundles into 1, all tokens preserved
  2. Source bundles marked superseded with correct retention period
  3. Concurrent consolidation guard prevents duplicate consolidation
  4. Crash recovery completes an interrupted consolidation
  5. Crash recovery restarts when consolidation didn't pin successfully
  6. Minimum retention period enforced (24h)
  7. Unit tests: merge scenario, crash recovery scenario, concurrent guard scenario

---

**WU-P12: Background Sync Coordinator**

- **ID:** WU-P12
- **Name:** Background Sync Coordinator
- **Files to create:**
  - `profile/sync-coordinator.ts`
- **Dependencies:** WU-P03 (OrbitDB adapter), WU-P07 (BundleManager), WU-P11 (ConsolidationEngine)
- **Parallel group:** D (Layer 3)
- **Description:** Coordinates OrbitDB replication events with consolidation triggers and local cache updates. References PROFILE-ARCHITECTURE.md Section 3.4 (Startup Flow), Section 7.3 (Cross-Device Sync), Section 4.4 (Replication), Section 2.3 "Consolidation Triggers".

  Class `SyncCoordinator`:
  - `start(db: ProfileDatabase, bundleManager: BundleManager, consolidation: ConsolidationEngine): void` -- subscribes to OrbitDB replication events, starts consolidation check loop
  - `stop(): void` -- unsubscribes and stops loop
  - `onSyncEvent(callback: SyncEventCallback): () => void` -- emit sync events to consuming code (PaymentsModule, etc.)

  Behavior:
  - On OrbitDB replication callback: check if any new `tokens.bundle.*` keys appeared. If so, emit `sync:completed` event (triggers PaymentsModule reload).
  - After replication: check `shouldConsolidate()`. If true, trigger background consolidation.
  - On startup: run `ConsolidationEngine.recoverFromCrash()` to handle interrupted consolidations.
  - Consolidation is debounced (wait 30 seconds after last replication event before triggering) to allow batching of multiple device syncs.

  Events emitted:
  - `profile:sync:new-bundles` -- new bundle CIDs discovered from other devices
  - `profile:sync:consolidation-started`
  - `profile:sync:consolidation-completed`
  - `profile:sync:error`

- **Acceptance criteria:**
  1. Replication events from OrbitDB trigger sync callbacks
  2. Consolidation triggered when active bundle count exceeds threshold
  3. Consolidation debounced (not triggered on every replication event)
  4. Crash recovery runs on startup
  5. `stop()` cleanly unsubscribes all listeners
  6. Events propagated to registered callbacks

---

### Layer 4: Integration (Depends on All Above)

**Parallel Group E** -- all three WUs can run simultaneously after Layer 3 completes.

---

**WU-P13: Factory Functions**

- **ID:** WU-P13
- **Name:** Factory Functions with `profile: true` Option
- **Files to modify:**
  - `impl/browser/index.ts` -- add `profile?: boolean` to `BrowserProvidersConfig`, conditional provider creation
  - `impl/nodejs/index.ts` -- add `profile?: boolean` to `NodeProvidersConfig`, conditional provider creation
- **Files to create:**
  - `profile/factory.ts` -- shared factory logic
- **Dependencies:** WU-P04 (ProfileStorageProvider), WU-P05 (ProfileTokenStorageProvider), WU-P06 (LocalCache), WU-P07 (BundleManager), WU-P09 (CAR pinning), WU-P10 (Migration), WU-P11 (Consolidation), WU-P12 (SyncCoordinator)
- **Parallel group:** E (Layer 4)
- **Description:** Extends existing factory functions to support Profile mode via a `profile: true` option. References PROFILE-ARCHITECTURE.md Section 8.2 (Factory Functions), Section 8.1 (Backward Compatibility).

  When `profile: true` is passed:
  - `createBrowserProviders({ profile: true })` returns `ProfileStorageProvider` (IndexedDB cache) and `ProfileTokenStorageProvider` instead of `IndexedDBStorageProvider` and `IndexedDBTokenStorageProvider`
  - `createNodeProviders({ profile: true })` returns `ProfileStorageProvider` (file cache) and `ProfileTokenStorageProvider` instead of `FileStorageProvider` and `FileTokenStorageProvider`
  - Without `profile: true`: existing behavior unchanged (Section 8.1)

  `profile/factory.ts` contains shared logic:
  - `createProfileProviders(config: ProfileConfig, cache: ProfileCache): { storage: ProfileStorageProvider, tokenStorage: ProfileTokenStorageProvider }`
  - Wires up OrbitDB adapter, encryption, bundle manager, CAR pinning, sync coordinator
  - Handles migration detection and trigger

  Additional ProfileConfig options in factory:
  - `profileOrbitDbPeers?: string[]` -- custom bootstrap peers for OrbitDB
  - `profileConsolidationRetentionMs?: number` -- override default 7-day retention
  - `profileCacheMaxSizeBytes?: number` -- override default cache size

- **Acceptance criteria:**
  1. `createBrowserProviders({ profile: true })` returns Profile-backed providers
  2. `createBrowserProviders()` (no profile flag) returns legacy providers unchanged
  3. `createNodeProviders({ profile: true })` returns Profile-backed providers
  4. Migration auto-triggers on first init with `profile: true` when legacy data exists
  5. All existing test suites pass with legacy providers
  6. Integration test: full init flow with `profile: true`

---

**WU-P14: Barrel Exports**

- **ID:** WU-P14
- **Name:** Profile Module Barrel Exports
- **Files to create:**
  - `profile/index.ts`
- **Files to modify:**
  - `index.ts` -- re-export profile types (types only, not runtime)
- **Dependencies:** All WU-P01 through WU-P13
- **Parallel group:** E (Layer 4)
- **Description:** Public API surface for the Profile module. References DESIGN-DECISIONS.md Decision 14 (Module Placement -- top-level `uxf/` pattern, but Profile is at `profile/`).

  Exports from `profile/index.ts`:
  - Types: `ProfileConfig`, `UxfBundleRef`, `ConsolidationPendingState`, `MigrationPhase`, `ProfileEncryptionConfig`
  - Classes: `ProfileStorageProvider`, `ProfileTokenStorageProvider`
  - Factory: `createProfileProviders`
  - Encryption: `deriveProfileEncryptionKey` (for advanced users who need direct access)
  - Errors: `ProfileError`

  The main `index.ts` re-exports types only (no runtime code) to avoid pulling OrbitDB into the main bundle.

- **Acceptance criteria:**
  1. `import { ProfileStorageProvider } from '@unicitylabs/sphere-sdk/profile'` works
  2. `import type { UxfBundleRef } from '@unicitylabs/sphere-sdk'` works (type-only re-export)
  3. No circular dependencies
  4. Tree-shaking: importing from main entry does not pull in OrbitDB runtime

---

**WU-P15: Build Configuration**

- **ID:** WU-P15
- **Name:** Build Config and Dependencies
- **Files to modify:**
  - `tsup.config.ts` -- add profile entry point
  - `package.json` -- add `@orbitdb/core` to dependencies, add `./profile` export map
- **Dependencies:** WU-P14 (barrel exports exist)
- **Parallel group:** E (Layer 4)
- **Description:** Configure the build system and package exports for the Profile module. References DESIGN-DECISIONS.md Decision 14 (separate entry point), existing `tsup.config.ts` pattern for UXF entry at line 164-181.

  New tsup entry:
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

  New package.json export:
  ```
  "./profile": {
    "import": { "types": "./dist/profile/index.d.ts", "default": "./dist/profile/index.js" },
    "require": { "types": "./dist/profile/index.d.cts", "default": "./dist/profile/index.cjs" }
  }
  ```

  New dependency: `@orbitdb/core` (added to `dependencies` or `optionalDependencies` depending on whether it should be lazy-loaded).

  Decision: add as `optionalDependency` with `peerDependenciesMeta.optional: true` to match the pattern used for `@libp2p/crypto`, `ipns`, etc. in the existing `package.json`. This way consumers who don't use Profile don't need to install OrbitDB.

- **Acceptance criteria:**
  1. `npm run build` produces `dist/profile/index.js` and `dist/profile/index.d.ts`
  2. `import { ProfileStorageProvider } from '@unicitylabs/sphere-sdk/profile'` resolves correctly in consuming projects
  3. Main bundle size unchanged (OrbitDB not included unless Profile entry point is imported)
  4. TypeScript declarations generated correctly
  5. Existing build entries unaffected

---

### Dependency Graph Summary

```
Layer 0 (Group A) ─ no deps ─────────────────────────────
  WU-P01 Types          ─┐
  WU-P02 Encryption      ├─ all parallel
  WU-P03 OrbitDB Adapter ─┘
                          │
Layer 1 (Group B) ─ depends on Layer 0 ───────────────────
  WU-P04 ProfileStorageProvider     ─ needs P01, P02, P03
  WU-P05 ProfileTokenStorageProvider ─ needs P01, P02, P03
  WU-P06 Local Cache Layer          ─ needs P01 only
                          │
Layer 2 (Group C) ─ depends on Layer 1 ───────────────────
  WU-P07 Bundle Manager   ─ needs P03, P01
  WU-P08 TxfToken Adapter ─ needs P01
  WU-P09 CAR Pinning      ─ needs P02, P01
                          │
Layer 3 (Group D) ─ depends on Layer 2 ───────────────────
  WU-P10 Migration Engine        ─ needs P04,P05,P07,P08,P09
  WU-P11 Consolidation Engine    ─ needs P07,P09,P03,P02
  WU-P12 Background Sync Coord  ─ needs P03,P07,P11
                          │
Layer 4 (Group E) ─ depends on all ───────────────────────
  WU-P13 Factory Functions  ─ needs all above
  WU-P14 Barrel Exports     ─ needs all above
  WU-P15 Build Config       ─ needs P14
```

**Maximum parallelism:** 3 workers at Layer 0, 3 at Layer 1, 3 at Layer 2, 3 at Layer 3, 3 at Layer 4. Critical path length: 5 layers.

**Estimated total files created:** ~18 new files in `profile/` directory.
**Estimated total files modified:** 3 existing files (tsup.config.ts, package.json, index.ts) + 2 factory files (impl/browser/index.ts, impl/nodejs/index.ts).

### Critical Files for Implementation
- `/home/vrogojin/uxf/storage/storage-provider.ts` -- the StorageProvider and TokenStorageProvider interfaces that ProfileStorageProvider and ProfileTokenStorageProvider must implement
- `/home/vrogojin/uxf/constants.ts` -- STORAGE_KEYS_GLOBAL and STORAGE_KEYS_ADDRESS that define the key mapping source for WU-P04
- `/home/vrogojin/uxf/impl/shared/ipfs/ipfs-storage-provider.ts` -- the existing IPFS provider whose patterns (write-behind buffer, identity derivation, createForAddress, event emission) should be followed
- `/home/vrogojin/uxf/uxf/UxfPackage.ts` -- the UXF package API (ingest, merge, toCar, fromCar, assembleAll) that the ProfileTokenStorageProvider calls
- `/home/vrogojin/uxf/impl/browser/index.ts` -- the browser factory function that must be extended with `profile: true` option