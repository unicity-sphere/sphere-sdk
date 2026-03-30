# Profile Module -- Test Specification

Comprehensive test plan for the Profile persistence layer (`profile/` directory).
Each test file covers a single module with full branch and error-path coverage.

**Framework:** Vitest
**Pattern:** follows existing UXF test conventions (see `tests/unit/uxf/errors.test.ts`, `tests/unit/uxf/hash.test.ts`)
**Location:** `tests/unit/profile/`

---

## 1. profile/errors.test.ts (~7 tests)

Tests for `ProfileError` construction, prototype chain, error code typing, and message formatting.

### ProfileError

- [ ] **constructs with code and message** -- `new ProfileError('ENCRYPTION_FAILED', 'bad key')` produces `message === '[PROFILE:ENCRYPTION_FAILED] bad key'` and `code === 'ENCRYPTION_FAILED'`
- [ ] **is an instance of Error** -- `instanceof Error` returns true (prototype chain correct)
- [ ] **is an instance of ProfileError** -- `instanceof ProfileError` returns true
- [ ] **sets name to ProfileError** -- `error.name === 'ProfileError'`
- [ ] **stores optional cause** -- `new ProfileError('MIGRATION_FAILED', 'fail', originalError)` stores `cause === originalError`
- [ ] **cause defaults to undefined** -- when no third argument is passed, `cause` is `undefined`
- [ ] **all 11 error codes produce valid formatted messages** -- iterate all `ProfileErrorCode` values (`PROFILE_NOT_INITIALIZED`, `ORBITDB_WRITE_FAILED`, `ORBITDB_READ_FAILED`, `ORBITDB_CONNECTION_FAILED`, `ORBITDB_NOT_INSTALLED`, `BUNDLE_NOT_FOUND`, `CONSOLIDATION_IN_PROGRESS`, `MIGRATION_FAILED`, `ENCRYPTION_FAILED`, `DECRYPTION_FAILED`, `BOOTSTRAP_REQUIRED`), verify `message` matches `[PROFILE:<code>] <msg>` and `code` property matches

---

## 2. profile/encryption.test.ts (~12 tests)

Tests for HKDF key derivation, AES-256-GCM encrypt/decrypt, string wrappers, and tamper detection.

### deriveProfileEncryptionKey

- [ ] **deterministic derivation** -- calling `deriveProfileEncryptionKey` twice with the same `masterKey` bytes returns identical 32-byte `Uint8Array` values
- [ ] **produces 32-byte key** -- output `.length === 32`
- [ ] **different master keys produce different encryption keys** -- two distinct 32-byte inputs yield different outputs
- [ ] **uses domain-specific HKDF salt** -- the function uses `'sphere-profile-v1'` as the HKDF salt; verify that changing the salt constant (by calling HKDF directly with a different salt) produces a different key, confirming the salt is load-bearing

### encryptProfileValue / decryptProfileValue

- [ ] **encrypt/decrypt round-trip** -- encrypting then decrypting arbitrary binary data returns the original plaintext byte-for-byte
- [ ] **random IV uniqueness** -- encrypting the same plaintext twice produces different ciphertext (first 12 bytes differ)
- [ ] **output format is IV(12) || ciphertext || tag** -- encrypted output length is at least `12 + 1` bytes; the first 12 bytes are the IV
- [ ] **tampered ciphertext causes DECRYPTION_FAILED** -- flipping a byte in the ciphertext portion and calling `decryptProfileValue` throws `ProfileError` with code `DECRYPTION_FAILED`
- [ ] **wrong key causes DECRYPTION_FAILED** -- decrypting with a different 32-byte key throws `ProfileError` with code `DECRYPTION_FAILED`
- [ ] **too-short input causes DECRYPTION_FAILED** -- passing a `Uint8Array` of length < 13 throws `ProfileError` with code `DECRYPTION_FAILED` and message mentioning expected byte count

### encryptString / decryptString

- [ ] **string encrypt/decrypt round-trip** -- `decryptString(key, await encryptString(key, 'hello world'))` returns `'hello world'`
- [ ] **empty string round-trip** -- encrypting and decrypting `''` returns `''`

---

## 3. profile/orbitdb-adapter.test.ts (~14 tests)

The `OrbitDbAdapter` class uses dynamic imports for `@orbitdb/core` and `helia`. All tests mock these dependencies.

### connect()

- [ ] **throws ORBITDB_NOT_INSTALLED when @orbitdb/core is missing** -- mock dynamic `import('@orbitdb/core')` to reject; calling `connect()` throws `ProfileError` with code `ORBITDB_NOT_INSTALLED`
- [ ] **throws ORBITDB_NOT_INSTALLED when helia is missing** -- mock `import('helia')` to reject (but `@orbitdb/core` succeeds); throws `ProfileError` with code `ORBITDB_NOT_INSTALLED`
- [ ] **throws ORBITDB_CONNECTION_FAILED on createHelia failure** -- mock `createHelia` to throw; `connect()` throws `ProfileError` with code `ORBITDB_CONNECTION_FAILED`
- [ ] **idempotent connect** -- calling `connect()` twice does not throw and does not create duplicate instances
- [ ] **cleans up partial state on connection failure** -- after a failed `connect()`, internal fields (helia, orbitdb, db) are nulled and `isConnected()` returns false

### put/get/del round-trip

- [ ] **put then get returns the stored value** -- mock OrbitDB `db.put()` and `db.get()` to use an in-memory map; `put('k', bytes)` followed by `get('k')` returns the same bytes
- [ ] **get on missing key returns null** -- `get('nonexistent')` returns `null`
- [ ] **del removes the key** -- after `put('k', v)` and `del('k')`, `get('k')` returns `null`
- [ ] **put on disconnected adapter throws PROFILE_NOT_INITIALIZED** -- calling `put()` without `connect()` throws `ProfileError` with code `PROFILE_NOT_INITIALIZED`

### all() with prefix filtering

- [ ] **all() returns all entries** -- after inserting `a.1`, `a.2`, `b.1`, calling `all()` returns all three entries
- [ ] **all(prefix) filters by prefix** -- `all('a.')` returns only `a.1` and `a.2`
- [ ] **all() handles Object-style return from OrbitDB** -- mock `db.all()` to return a plain object `{ key: value }`; adapter coerces values to Uint8Array

### onReplication / close

- [ ] **onReplication callback fires on 'update' event** -- mock `db.events.on('update', handler)`; emit an update event; verify the callback fires
- [ ] **close() unsubscribes all replication listeners and disconnects** -- after `close()`, `isConnected()` returns false; replication listeners are cleared; `db.close()`, `orbitdb.stop()`, and `helia.stop()` are called

---

## 4. profile/profile-storage-provider.test.ts (~22 tests)

Tests the `ProfileStorageProvider` class using a mock `StorageProvider` (local cache) and a mock `ProfileDatabase` (OrbitDB).

### Key translation

- [ ] **global key 'mnemonic' maps to 'identity.mnemonic'** -- `set('mnemonic', 'val')` writes to OrbitDB key `identity.mnemonic`
- [ ] **global key 'wallet_exists' maps to 'wallet_exists'** -- verify the profile key name
- [ ] **per-address key with explicit prefix translates correctly** -- `set('DIRECT_aabbcc_ddeeff_pending_transfers', 'val')` writes to OrbitDB key `DIRECT_aabbcc_ddeeff.pendingTransfers`
- [ ] **per-address key without prefix uses current addressId** -- after `setIdentity()` with a known address, `set('pending_transfers', 'val')` writes to `{addressId}.pendingTransfers`
- [ ] **dynamic transport key translates** -- `set('last_wallet_event_ts_abc123', '100')` writes to `transport.lastWalletEventTs.abc123`
- [ ] **dynamic swap key translates** -- `set('DIRECT_aabbcc_ddeeff_swap:xyz', 'val')` writes to `DIRECT_aabbcc_ddeeff.swap:xyz`
- [ ] **IPFS state keys are excluded** -- `set('ipfs_seq_something', 'val')` is silently dropped; `get('ipfs_seq_something')` returns `null`

### Cache-only keys

- [ ] **cache-only key 'token_registry_cache' written to cache only** -- `set('token_registry_cache', 'data')` writes to local cache; mock OrbitDB `put` is NOT called
- [ ] **cache-only key not read from OrbitDB on cache miss** -- `get('token_registry_cache')` with empty cache returns `null` without querying OrbitDB

### get/set round-trip

- [ ] **set then get returns value from cache** -- `set('mnemonic', 'secret')` then `get('mnemonic')` returns `'secret'` (served from local cache)
- [ ] **get falls back to OrbitDB on cache miss** -- local cache returns `null`; OrbitDB has the value (encrypted); `get()` decrypts and returns it; also populates cache
- [ ] **get returns null when neither cache nor OrbitDB has the key** -- both return null/null

### has() special cases

- [ ] **has('wallet_exists') on cold cache checks OrbitDB for identity keys** -- cache returns false; mock `db.all('identity.')` returns entries; `has('wallet_exists')` returns true
- [ ] **has('wallet_exists') returns false when profile.cleared is true** -- mock `db.get('profile.cleared')` returns encrypted `'true'`; `has('wallet_exists')` returns false even if identity keys exist

### keys()

- [ ] **keys() returns union of cache and OrbitDB keys in legacy format** -- cache has `['mnemonic']`; OrbitDB has `identity.mnemonic` and `identity.chainCode`; result includes `'mnemonic'` and `'chain_code'` (reverse-mapped), deduplicated

### clear()

- [ ] **clear() writes profile.cleared flag to OrbitDB** -- after `clear()`, OrbitDB has key `profile.cleared` with encrypted value `'true'`
- [ ] **clear() delegates to local cache clear** -- `localCache.clear()` is called

### saveTrackedAddresses / loadTrackedAddresses

- [ ] **saveTrackedAddresses writes to both cache and OrbitDB** -- verify `localCache.saveTrackedAddresses()` and `db.put('addresses.tracked', ...)` are both called
- [ ] **loadTrackedAddresses from cache** -- cache returns entries; OrbitDB not queried
- [ ] **loadTrackedAddresses falls back to OrbitDB on empty cache** -- cache returns `[]`; OrbitDB returns encrypted JSON; result is parsed array

### setIdentity

- [ ] **setIdentity is synchronous** -- does not return a promise; sets `addressId` and derives encryption key immediately
- [ ] **setIdentity derives encryption key and forwards to local cache** -- after calling `setIdentity()`, subsequent `set()` calls encrypt values before writing to OrbitDB

---

## 5. profile/profile-token-storage-provider.test.ts (~28 tests)

Tests the `ProfileTokenStorageProvider` using mock `ProfileDatabase`, mock IPFS fetch/pin, and mock `UxfPackage`.

### Lifecycle

- [ ] **initialize() returns false when no identity is set** -- calling `initialize()` before `setIdentity()` returns `false`
- [ ] **initialize() succeeds and loads known bundles** -- mock `db.all(BUNDLE_KEY_PREFIX)` returns two bundles; after `initialize()`, `isConnected()` is true
- [ ] **shutdown() cancels pending flush timer** -- set `save()` with data, then immediately call `shutdown()`; flush timer is cleared; no IPFS pin attempt
- [ ] **shutdown() flushes pending data before completing** -- save data, then `shutdown()`; verify `flushToIpfs` was called (mock IPFS pin)

### save() -- write-behind buffer

- [ ] **save() accepts data immediately and returns success** -- `save(txfData)` returns `{ success: true }` without waiting for IPFS
- [ ] **multiple rapid saves produce single flush** -- call `save()` three times in quick succession; after debounce, mock `pinCar` is called exactly once with the last data
- [ ] **save() without initialization returns error** -- `save(data)` before `initialize()` returns `{ success: false }`

### load() -- multi-bundle merge

- [ ] **load() returns pending data if present** -- `save(data)` then `load()` returns the buffered data with `source: 'cache'`
- [ ] **load() merges multiple active bundles** -- mock two `tokens.bundle.*` entries in OrbitDB, each referencing a different CID; mock `fetchCar` to return encrypted CAR bytes; mock `UxfPackage.fromCar` and `merge`; verify merged result contains tokens from both bundles
- [ ] **load() returns empty data when no bundles exist** -- mock `db.all(BUNDLE_KEY_PREFIX)` returns empty map; `load()` returns `{ success: true, data: { _meta: ... } }`
- [ ] **load() continues on partial bundle failure** -- one bundle fetch fails, another succeeds; `load()` returns tokens from the successful bundle only

### Bundle management

- [ ] **addBundle writes encrypted ref to OrbitDB** -- after a successful flush, `db.put('tokens.bundle.<cid>', ...)` is called with encrypted JSON matching `UxfBundleRef` shape
- [ ] **listActiveBundles filters by status** -- insert two bundle refs, one `active` and one `superseded`; `listActiveBundles()` returns only the active one
- [ ] **shouldConsolidate returns true when active count > 3** -- insert 4 active bundle refs; `shouldConsolidate()` returns true

### Operational state

- [ ] **operational state stored as separate OrbitDB keys** -- after flush, mock `db.put` is called with `{addr}.tombstones`, `{addr}.outbox`, `{addr}.sent`, etc.
- [ ] **readOperationalState reads all fields in parallel** -- mock `db.get` for each operational key; verify all 7 fields are populated in the result

### sync()

- [ ] **sync() detects new bundles and returns added count** -- first sync sees 1 bundle; refresh reveals 2 bundles; `sync()` returns `{ added: N }` where N is the new token count difference
- [ ] **sync() detects removed bundles** -- first sync sees 2 bundles; refresh reveals 1 bundle; `sync()` returns `{ removed: N }` based on token diff
- [ ] **sync() returns zero counts when nothing changed** -- no new or removed bundles; returns `{ added: 0, removed: 0 }`

### Replication events

- [ ] **storage:remote-updated event fires on replication with new bundles** -- register `onEvent` callback; trigger replication handler with a new bundle CID appearing; callback receives event with `type: 'storage:remote-updated'`
- [ ] **no event fires when replication has no new bundles** -- trigger replication handler with same bundle set; callback is NOT called

### createForAddress

- [ ] **createForAddress returns new provider with specified addressId** -- `createForAddress('DIRECT_111111_222222')` returns a new `ProfileTokenStorageProvider` instance with the given address ID

### History operations

- [ ] **addHistoryEntry adds and sorts by timestamp descending** -- add two entries with different timestamps; `getHistoryEntries()` returns them sorted newest-first
- [ ] **addHistoryEntry upserts by dedupKey** -- add entry with dedupKey `'A'`, then add another with same dedupKey but different data; only one entry with dedupKey `'A'` exists
- [ ] **hasHistoryEntry returns true for existing dedupKey** -- add entry with dedupKey `'X'`; `hasHistoryEntry('X')` returns true; `hasHistoryEntry('Y')` returns false
- [ ] **clearHistory removes all entries** -- add entries; `clearHistory()`; `getHistoryEntries()` returns `[]`
- [ ] **importHistoryEntries deduplicates and returns imported count** -- existing entries have dedupKeys `['A', 'B']`; import `['B', 'C', 'D']`; returns `2` (C and D imported); B is not duplicated

### Encryption

- [ ] **CAR files are encrypted before pinning** -- intercept `pinCar` call; verify the bytes passed are NOT the raw CAR bytes (they are the encrypted output of `encryptProfileValue`)
- [ ] **bundle refs are encrypted in OrbitDB** -- intercept `db.put('tokens.bundle.*', value)`; verify the value bytes decrypt to valid JSON matching `UxfBundleRef`

### Error handling

- [ ] **save() with null encryptionKey returns error** -- provider with no encryption key set; `save(data)` returns `{ success: false }`
- [ ] **flush retry reuses lastPinnedCid** -- first flush: `pinCar` succeeds but `db.put` for bundle ref fails; second flush: `pinCar` is NOT called again; the previously pinned CID is reused for the OrbitDB write

---

## 6. profile/migration.test.ts (~16 tests)

Tests for `ProfileMigration` using mock legacy providers and mock Profile providers.

### needsMigration

- [ ] **returns true when legacy data exists and migration not complete** -- mock `legacyStorage.has('wallet_exists')` returns true; `getMigrationPhase()` returns null; `needsMigration()` returns true
- [ ] **returns false when migration is already complete** -- mock `legacyStorage.get(MIGRATION_PHASE_KEY)` returns `'complete'`; `needsMigration()` returns false
- [ ] **returns false when no legacy data exists** -- mock `legacyStorage.has('wallet_exists')` returns false; `needsMigration()` returns false

### 6-step flow

- [ ] **full migration succeeds with mock providers** -- provide mock legacy storage with identity keys and token data; mock legacy token storage with TXF data containing 3 tokens; mock Profile providers that accept writes; `migrate()` returns `{ success: true, keysMigrated: N, tokensMigrated: 3 }`
- [ ] **_sent entries merged into transactionHistory** -- legacy TXF data has `_sent: [{ tokenId, txHash, sentAt, recipient }]` and existing `_history: [...]`; after migration, the profile storage receives a `transactionHistory` value containing both original history and converted sent entries, deduplicated by `dedupKey`
- [ ] **nametag tokens extracted from _nametag and _nametags** -- TXF data has `_nametag: { token: {...} }` and `_nametags: [{ token: {...} }, null]`; migration extracts `_nametag` and `_nametags_0` as token IDs (not `_nametags_1` since it is null)
- [ ] **forked tokens extracted from _forked_* keys** -- TXF data has `_forked_abc123: { ... }`; migration includes it in `tokenIds`
- [ ] **IPFS state keys not migrated** -- legacy storage has `ipfs_seq_xyz` and `ipfs_cid_abc`; these keys are skipped during transform (not in `profileKeys` map)

### Sanity check

- [ ] **sanity check catches missing profile key** -- during step 4, profile storage returns `null` for a key that was written in step 3; `migrate()` returns `{ success: false, failedAtPhase: 'verifying' }`
- [ ] **sanity check catches token count mismatch** -- legacy had 5 tokens; loaded profile has 3; migration fails with `MIGRATION_FAILED` error mentioning count mismatch

### Phase tracking and crash recovery

- [ ] **phase is tracked in legacy storage for crash recovery** -- after each step, `legacyStorage.set('migration.phase', phase)` is called with the current phase string
- [ ] **migration resumes from last completed phase** -- set `legacyStorage.get('migration.phase')` to return `'transforming'`; `migrate()` skips step 1 (syncing) and re-runs step 2 (transforming), then continues from step 3

### Edge cases

- [ ] **wallets with no IPFS keys skip step 1** -- legacy storage has no `ipfs_seq_*` keys; step 1 logs "No IPFS keys found" and returns without attempting sync
- [ ] **step 1 IPFS sync failure is non-fatal** -- mock `legacyTokenStorage.sync()` to throw; migration continues to step 2 without failing
- [ ] **cleanup preserves migration phase keys** -- during step 5, `legacyStorage.remove()` is called for all keys EXCEPT `migration.phase` and `migration.startedAt`
- [ ] **SphereVestingCacheV5 not deleted** -- verify that cleanup only calls `legacyStorage.remove()` (which operates on the StorageProvider KV store) and `legacyTokenStorage.clear()`, but does NOT touch VestingClassifier or its IndexedDB database

---

## 7. profile/integration.test.ts (~10 tests)

End-to-end tests using real (or near-real) module composition. Uses in-memory mocks for OrbitDB and IPFS but exercises the full provider stack.

### Full lifecycle

- [ ] **create providers, setIdentity, save, load, verify** -- use `createProfileProviders()` with a mock local cache and mock OrbitDB; set identity; save TXF data with 2 tokens; load back; verify token count matches and operational state is preserved
- [ ] **setIdentity derives encryption key, subsequent save/load decrypts correctly** -- after `setIdentity()`, save encrypted data; create a second provider instance sharing the same mock OrbitDB; set same identity; `load()` decrypts and returns matching data

### Multi-device simulation

- [ ] **two providers sharing OrbitDB see both bundles** -- provider A saves 2 tokens (bundle CID-A); provider B saves 3 tokens (bundle CID-B); both write to the same mock OrbitDB; provider A calls `load()` and merges both bundles, seeing 5 tokens
- [ ] **sync() detects new bundles from remote device** -- provider A has 1 known bundle; provider B writes a second bundle to shared OrbitDB; provider A calls `sync()` and gets `{ added: N }` reflecting the new tokens

### Migration flow

- [ ] **legacy data migrates to Profile and verifies correctly** -- create mock legacy storage with identity keys, tracked addresses, and per-address data; create mock legacy token storage with TXF data; run `migrate()`; verify `success: true`; use Profile providers to `load()` and verify token count, history count, and key presence
- [ ] **post-migration cleanup removes legacy data** -- after successful migration, verify legacy storage is empty except for migration tracking keys

### Factory function

- [ ] **createProfileProviders returns valid storage and tokenStorage** -- call `createProfileProviders(config, mockCache)`; verify `storage` is instance of `ProfileStorageProvider`; verify `tokenStorage` is instance of `ProfileTokenStorageProvider`
- [ ] **bootstrap peers merge from profileOrbitDbPeers alias** -- pass `profileOrbitDbPeers: ['peer1']` and `orbitDb.bootstrapPeers: ['peer0']`; verify the resolved config merges both into `bootstrapPeers: ['peer0', 'peer1']`
- [ ] **default IPFS gateways used when none specified** -- pass `ipfsGateways: undefined`; verify the token storage provider uses the default gateways from `constants.ts`
- [ ] **encryption disabled when encrypt: false** -- pass `encrypt: false`; after `setIdentity()`, OrbitDB writes contain raw UTF-8 bytes (not encrypted); verify by checking that `db.put` receives bytes that decode to the original string

---

## Summary

| Test File | Module Under Test | Test Count |
|-----------|-------------------|------------|
| `profile/errors.test.ts` | `profile/errors.ts` | 7 |
| `profile/encryption.test.ts` | `profile/encryption.ts` | 12 |
| `profile/orbitdb-adapter.test.ts` | `profile/orbitdb-adapter.ts` | 14 |
| `profile/profile-storage-provider.test.ts` | `profile/profile-storage-provider.ts` | 22 |
| `profile/profile-token-storage-provider.test.ts` | `profile/profile-token-storage-provider.ts` | 28 |
| `profile/migration.test.ts` | `profile/migration.ts` | 16 |
| `profile/integration.test.ts` | Full stack | 10 |
| **Total** | | **109** |

### Mock Strategy

All tests use Vitest mocks (`vi.fn()`, `vi.mock()`). No real OrbitDB, Helia, libp2p, or IPFS gateway connections are made.

- **Mock ProfileDatabase** -- in-memory `Map<string, Uint8Array>` implementing the `ProfileDatabase` interface. Used by storage provider and token storage provider tests.
- **Mock StorageProvider** -- in-memory `Map<string, string>` implementing `StorageProvider`. Used as the local cache layer in `ProfileStorageProvider` tests.
- **Mock TokenStorageProvider** -- returns predetermined `TxfStorageDataBase` from `load()` and records `save()` calls. Used in migration tests.
- **Mock IPFS** -- `globalThis.fetch` mocked to intercept `pinCar` and `fetchCar` HTTP calls; returns predetermined CIDs and CAR bytes.
- **Mock UxfPackage** -- `vi.mock('../uxf/UxfPackage.js')` to control `fromCar`, `toCar`, `merge`, `ingestAll`, `assembleAll` behavior without real CBOR/DAG-CBOR serialization.

### Test Execution

```bash
# Run all Profile tests
npx vitest run tests/unit/profile/

# Run a single file
npx vitest run tests/unit/profile/encryption.test.ts

# Watch mode
npx vitest tests/unit/profile/
```
