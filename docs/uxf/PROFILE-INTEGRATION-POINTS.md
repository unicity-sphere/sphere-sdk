# Profile System: SDK Integration Points Analysis

**Status:** Reference — analysis of existing sphere-sdk storage usage for Profile integration planning
**Date:** 2026-03-30

---

## 1. StorageProvider Integration Points

The `StorageProvider` interface (defined in `storage/storage-provider.ts`) is a flat key-value store with `get/set/remove/has/keys/clear` methods plus `setIdentity()` for per-address scoping. The Profile system's `ProfileStorageProvider` must implement this interface identically.

### 1.1 Sphere.ts Storage Calls

**Wallet existence check** — `Sphere.exists(storage)` (line 531):
- `storage.get(STORAGE_KEYS_GLOBAL.MNEMONIC)` — checks for encrypted mnemonic
- `storage.get(STORAGE_KEYS_GLOBAL.MASTER_KEY)` — checks for encrypted master key
- Connects/disconnects storage around these reads if not already connected
- Profile implication: `ProfileStorageProvider.get('mnemonic')` must work before `setIdentity()` is called — these keys are global, not address-scoped

**Wallet creation** — `storeMnemonic()` (line 3670) and `storeMasterKey()` (line 3692):
- Writes the following global keys in sequence:
  - `MNEMONIC` — AES-encrypted mnemonic string
  - `DERIVATION_PATH` — full HD path (e.g., `m/44'/0'/0'/0/0`)
  - `BASE_PATH` — base path (e.g., `m/44'/0'/0'`)
  - `DERIVATION_MODE` — string: `bip32`, `wif_hmac`, or `legacy_hmac`
  - `WALLET_SOURCE` — string: `mnemonic`, `file`, or `unknown`
  - (or `MASTER_KEY` + `CHAIN_CODE` for file-imported wallets)
- `finalizeWalletCreation()` (line 3734): sets `WALLET_EXISTS = 'true'`
- Profile implication: these writes happen before transport/oracle connect. The provider must accept writes immediately after `connect()`, even before `setIdentity()`.

**Wallet load** — `loadIdentityFromStorage()` (line 3742):
- Reads all global keys: `MNEMONIC`, `MASTER_KEY`, `CHAIN_CODE`, `DERIVATION_PATH`, `BASE_PATH`, `DERIVATION_MODE`, `WALLET_SOURCE`, `CURRENT_ADDRESS_INDEX`
- Decrypts mnemonic or master key using the configured password
- Derives identity from the decrypted material
- Profile implication: read-after-write consistency required — keys written during create must be readable during load on the same or different device

**Address switching** — `switchToAddress()`:
- `storage.set(CURRENT_ADDRESS_INDEX, index.toString())` (line 2237)

**Nametag management** — multiple locations around lines 3267-3397:
- `storage.get(ADDRESS_NAMETAGS)` — reads JSON map of `{addressId: nametag}`
- `storage.set(ADDRESS_NAMETAGS, JSON.stringify(result))` — writes updated map
- Profile implication: this is a read-modify-write cycle. Under multi-device scenarios with OrbitDB LWW, concurrent nametag registrations on different devices could lose one write. The Profile schema maps this to `addresses.nametags` as a single LWW key.

**Tracked addresses**:
- `saveTrackedAddresses(entries)` — serializes via `JSON.stringify({ version: 1, addresses: entries })`
- `loadTrackedAddresses()` — deserializes, returns `TrackedAddressEntry[]`
- These are dedicated interface methods, not generic `get/set`
- Profile maps to `addresses.tracked`

**Wallet clear** — `Sphere.clear()`:
- `storage.clear()` — removes all keys (no prefix = full wipe)
- Also calls `tokenStorage.clear()` and `vestingClassifier.destroy()`

### 1.2 PaymentsModule Storage Calls (via `this.deps!.storage`)

All per-address keys use the `STORAGE_KEYS_ADDRESS` constants. The `IndexedDBStorageProvider` auto-prefixes these with the address ID when `setIdentity()` has been called (see `getFullKey()` at line 261 of `IndexedDBStorageProvider.ts`).

**During load** (line 922):
- `storage.get(PENDING_TRANSFERS)` — JSON array of `TransferResult[]`

**During send** (lines 5226-5241):
- `storage.set(OUTBOX, JSON.stringify(outbox))` — append to outbox
- `storage.get(OUTBOX)` — read outbox
- `storage.set(OUTBOX, JSON.stringify(filtered))` — remove from outbox after completion

**Pending V5 tokens** (lines 3308-3371):
- `storage.set(PENDING_V5_TOKENS, JSON.stringify(tokens))` — save pending V5 finalization
- `storage.get(PENDING_V5_TOKENS)` — restore on load
- `storage.set(PENDING_V5_TOKENS, '')` — clear after finalization

**Dedup state** (lines 1901, 1912, 3360, 3371):
- `storage.set(PROCESSED_SPLIT_GROUP_IDS, JSON.stringify(ids))` — persist V5 split dedup set
- `storage.get(PROCESSED_SPLIT_GROUP_IDS)` — restore on load
- `storage.set(PROCESSED_COMBINED_TRANSFER_IDS, JSON.stringify(ids))` — V6 transfer dedup
- `storage.get(PROCESSED_COMBINED_TRANSFER_IDS)` — restore on load

**Transaction history (legacy fallback)** (lines 3901-3923):
- `storage.get(TRANSACTION_HISTORY)` — legacy KV-stored history (migrated to IndexedDB history store)
- `storage.remove(TRANSACTION_HISTORY)` — cleanup after migration to dedicated store

**Summary of per-address keys written by PaymentsModule:**

| Key | Format | Read When | Written When |
|-----|--------|-----------|--------------|
| `pending_transfers` | JSON `TransferResult[]` | load | send (start/complete) |
| `outbox` | JSON `OutboxEntry[]` | load, send | send (start/complete) |
| `pending_v5_tokens` | JSON `PendingV5Finalization[]` | load | receive (V5 instant split) |
| `processed_split_group_ids` | JSON `string[]` | load | receive (dedup) |
| `processed_combined_transfer_ids` | JSON `string[]` | load | receive (dedup) |
| `transaction_history` | JSON `HistoryRecord[]` | load (legacy migration) | deprecated (now in IndexedDB) |

### 1.3 Other Modules Using StorageProvider

**Transport (NostrTransportProvider):**
- `storage.get('last_wallet_event_ts_{pubkey_prefix}')` — last processed Nostr timestamp
- `storage.set('last_wallet_event_ts_{pubkey_prefix}', ...)` — update on each wallet event
- `storage.get('last_dm_event_ts_{pubkey_prefix}')` — DM timestamp
- These are global keys (no address scoping), written via a `TransportStorageAdapter`

**TokenRegistry:**
- `storage.get(TOKEN_REGISTRY_CACHE)` — cached token metadata JSON
- `storage.set(TOKEN_REGISTRY_CACHE, json)` — refresh cache
- `storage.get(TOKEN_REGISTRY_CACHE_TS)` / `storage.set(TOKEN_REGISTRY_CACHE_TS, ts)` — cache timestamp
- Cache-only: NOT replicated to OrbitDB in Profile architecture

**CoinGeckoPriceProvider:**
- `storage.get(PRICE_CACHE)` / `storage.set(PRICE_CACHE, json)` — persistent price cache
- `storage.get(PRICE_CACHE_TS)` / `storage.set(PRICE_CACHE_TS, ts)` — cache timestamp
- Cache-only: NOT replicated to OrbitDB

**CommunicationsModule:**
- `storage.get/set` for `CONVERSATIONS` and `MESSAGES` (per-address)

**GroupChatModule:**
- `storage.get/set` for `GROUP_CHAT_GROUPS`, `GROUP_CHAT_MESSAGES`, `GROUP_CHAT_MEMBERS`, `GROUP_CHAT_PROCESSED_EVENTS` (per-address)
- `storage.get/set` for `GROUP_CHAT_RELAY_URL` (global)

---

## 2. TokenStorageProvider Integration Points

### 2.1 Interface Shape

`TokenStorageProvider<TxfStorageDataBase>` has these core methods:
- `setIdentity(identity: FullIdentity)` — scope to a wallet/address
- `initialize(): Promise<boolean>` — open connection/database
- `shutdown(): Promise<void>` — close connection
- `save(data: TxfStorageDataBase): Promise<SaveResult>` — persist token data
- `load(identifier?): Promise<LoadResult<TxfStorageDataBase>>` — retrieve token data
- `sync(localData): Promise<SyncResult<TxfStorageDataBase>>` — merge with remote
- `createForAddress?(): TokenStorageProvider` — clone for multi-address

Optional methods: `exists()`, `clear()`, `onEvent()`, `addHistoryEntry()`, `getHistoryEntries()`, `hasHistoryEntry()`, `importHistoryEntries()`, `clearHistory()`

### 2.2 TxfStorageDataBase Structure

The data shape passed to `save()` and returned from `load()`:

```typescript
{
  _meta: { version, address, ipnsName?, formatVersion, updatedAt },
  _tombstones?: [{ tokenId, stateHash, timestamp }],
  _outbox?: [{ id, status, tokenId, recipient, createdAt, data }],
  _sent?: [{ tokenId, recipient, txHash, sentAt }],
  _invalid?: [{ tokenId, reason, detectedAt }],
  _history?: HistoryRecord[],
  // Dynamic token entries: _<tokenId> → TxfToken objects
  [key: `_${string}`]: unknown,
}
```

Each active token is stored under a key like `_abc123def456` where the key (minus the underscore prefix) is the token ID. Archived tokens use `archived-<tokenId>` keys.

### 2.3 How PaymentsModule Uses TokenStorageProvider

**Load flow** (PaymentsModule.load(), line 850):
1. Calls `TokenRegistry.waitForReady()` — blocks until token metadata is available
2. Iterates registered providers via `this.getTokenStorageProviders()` (returns a `Map<string, TokenStorageProvider>`)
3. For each provider: calls `provider.load()` — returns `LoadResult<TxfStorageDataBase>`
4. On first successful load: calls `this.loadFromStorageData(result.data)` — populates in-memory token map
5. Imports `_history` entries from the loaded TXF data into the local history store
6. **Breaks after first successful provider** — does not merge across providers during load

**Save flow** (PaymentsModule.save(), line 5195):
1. Calls `this.createStorageData()` — builds `TxfStorageDataBase` from in-memory state
2. For each registered provider: calls `provider.save(data)` — fire-and-forget per provider (errors logged, not thrown)
3. Additionally saves pending V5 tokens to KV storage (separate from TXF providers)

**Sync flow** (PaymentsModule.sync(), line 4189):
1. Coalesces concurrent sync calls (returns in-flight promise if already syncing)
2. Builds `localData` via `createStorageData()`
3. For each provider: calls `provider.sync(localData)` — returns `SyncResult<TxfStorageDataBase>`
4. On success: calls `this.loadFromStorageData(result.merged)` — replaces in-memory state
5. Restores tokens that were lost in the TXF round-trip (V5 pending tokens, recently arrived tokens)
6. Emits `sync:provider` event per provider, then `sync:completed` event

### 2.4 Per-Address Scoping (createForAddress)

Multi-address support works as follows:

1. `Sphere` maintains `_tokenStorageProviders: Map<string, TokenStorageProvider>`
2. When switching to a new address (`initModulesForAddress()`, around line 2322):
   - For each registered provider: calls `provider.createForAddress()` — returns a fresh instance
   - Sets identity on the new instance: `newProvider.setIdentity(addressIdentity)`
   - Initializes: `newProvider.initialize()`
   - Passes the new provider map to the new `PaymentsModule` instance for that address
3. Each address module set has its own `tokenStorageProviders` Map

**IndexedDBTokenStorageProvider.createForAddress()** (line 597):
- Returns `new IndexedDBTokenStorageProvider({ dbNamePrefix, debug })`
- The new instance gets a different `dbName` when `setIdentity()` is called: `sphere-token-storage-DIRECT_abc123_xyz789`
- Each address has its own IndexedDB database

**IpfsStorageProvider.createForAddress()** (line 861):
- Returns `new IpfsStorageProvider(this._config, this._statePersistenceCtor)`
- The new instance derives its own IPNS key pair from the new address's private key
- Each address has its own IPNS name and publish path

### 2.5 History Store Operations

The `IndexedDBTokenStorageProvider` implements optional history methods:
- `addHistoryEntry(entry)` — upsert by `dedupKey` into a dedicated `STORE_HISTORY` object store
- `getHistoryEntries()` — returns all entries sorted by timestamp descending
- `hasHistoryEntry(dedupKey)` — existence check for dedup
- `importHistoryEntries(entries)` — bulk import, skips existing dedupKeys
- `clearHistory()` — wipes the history store

PaymentsModule delegates history to whichever provider supports it. Providers without history support (IPFS) serialize `_history` in the TXF payload for cross-device sync.

---

## 3. Factory Function Patterns

### 3.1 createBrowserProviders (impl/browser/index.ts)

**Config type:** `BrowserProvidersConfig`
**Returns:** `BrowserProviders`

Construction sequence:
1. Resolves network config (mainnet/testnet/dev)
2. Configures logger debug flags
3. Resolves transport, oracle, L1, price configs via shared utilities
4. Creates `IndexedDBStorageProvider` — the KV storage
5. Creates `IndexedDBTokenStorageProvider` — the token storage (always created, not optional)
6. Optionally creates `IpfsStorageProvider` if `tokenSync.ipfs.enabled`
7. Configures `TokenRegistry.configure({ remoteUrl, storage })` — passes storage for persistent cache
8. Returns all providers bundled together

**Key pattern:** Storage is created first, then passed to transport (for timestamp persistence) and TokenRegistry (for cache persistence).

### 3.2 createNodeProviders (impl/nodejs/index.ts)

**Config type:** `NodeProvidersConfig`
**Returns:** `NodeProviders`

Same pattern as browser but uses:
- `FileStorageProvider` instead of IndexedDB for KV
- `FileTokenStorageProvider` instead of IndexedDB for tokens
- Different config options (`dataDir`, `tokensDir`, `walletFileName`)

### 3.3 How to Add `profile: true` Option

Based on the Profile Architecture (Section 8.2), the approach:

```
createBrowserProviders({ network: 'testnet', profile: true })
```

When `profile: true`:
1. Create `ProfileStorageProvider` (implements `StorageProvider`) instead of `IndexedDBStorageProvider`
   - Internally backed by an IndexedDB cache for local reads
   - Writes replicate to OrbitDB
2. Create `ProfileTokenStorageProvider` (implements `TokenStorageProvider<TxfStorageDataBase>`) instead of `IndexedDBTokenStorageProvider`
   - Converts TXF tokens to UXF packages
   - Saves as CAR files to IPFS
   - Records bundle CIDs in OrbitDB
3. The IPFS storage provider (`ipfsTokenStorage`) is no longer needed as a separate provider — the Profile subsumes its functionality

When `profile: false` (default):
- Existing behavior unchanged
- `IndexedDBStorageProvider` + `IndexedDBTokenStorageProvider` as today

**Config additions needed:**

```typescript
interface BrowserProvidersConfig {
  // ... existing fields ...
  /** Enable Profile storage (OrbitDB + IPFS). Default: false (local-only storage). */
  profile?: boolean | ProfileConfig;
}

interface ProfileConfig {
  /** OrbitDB database options */
  orbitdb?: { directory?: string };
  /** IPFS pinning configuration */
  ipfs?: { gateways?: string[] };
  /** Consolidation settings */
  consolidation?: { retentionMs?: number; maxBundles?: number };
}
```

---

## 4. Event Model

### 4.1 Sphere Events Related to Storage

The SDK emits events via `this.deps!.emitEvent(type, data)` (delegated to Sphere's event emitter):

| Event | Emitted By | When | Payload |
|-------|-----------|------|---------|
| `sync:started` | PaymentsModule._doSync() | Sync begins | `{ source: 'payments' }` |
| `sync:completed` | PaymentsModule._doSync() | Sync finishes | `{ source: 'payments', count }` |
| `sync:error` | PaymentsModule._doSync() | Sync fails | `{ source, error }` |
| `sync:provider` | PaymentsModule._doSync() | Per-provider sync result | `{ providerId, success, added, removed, error? }` |

### 4.2 TokenStorageProvider Events (StorageEvent)

Providers emit these via `onEvent()` callback:

| Event Type | Emitted By | Purpose |
|-----------|-----------|---------|
| `storage:saving` | Before save | UI loading indicator |
| `storage:saved` | After save | UI refresh |
| `storage:loading` | Before load | UI loading indicator |
| `storage:loaded` | After load | UI refresh |
| `storage:error` | On failure | Error display |
| `storage:remote-updated` | Push notification (IPNS subscription / OrbitDB) | Triggers debounced sync |
| `sync:started` | Before sync | UI indicator |
| `sync:completed` | After sync | UI refresh |
| `sync:conflict` | During merge | Conflict notification |
| `sync:error` | On sync failure | Error display |

### 4.3 Push-Based Sync Trigger

PaymentsModule subscribes to `storage:remote-updated` events from all token storage providers (line 4357). When this event fires:
1. A debounced sync is triggered via `debouncedSyncFromRemoteUpdate(providerId, eventData)`
2. The sync calls `provider.sync(localData)` which merges local and remote state
3. The UI receives `sync:completed` and refreshes

For the Profile system, OrbitDB replication events should emit `storage:remote-updated` to trigger this same debounced sync flow. The existing mechanism is provider-agnostic — the `ProfileTokenStorageProvider` just needs to emit the right event.

---

## 5. Backward Compatibility Risks

### 5.1 Synchronous vs Asynchronous Behavior

**Risk: `setIdentity()` is synchronous.** Both `IndexedDBStorageProvider` and `IndexedDBTokenStorageProvider` implement `setIdentity()` as a synchronous method (just stores the identity object in memory). If `ProfileStorageProvider.setIdentity()` needs to open an OrbitDB connection or perform async initialization, this breaks the contract.

**Mitigation:** Keep `setIdentity()` synchronous (store identity in memory). Defer OrbitDB connection to the `connect()` / `initialize()` call.

### 5.2 Key Scoping Logic

**Risk: `getFullKey()` auto-prefixing.** `IndexedDBStorageProvider.getFullKey()` (line 261) checks whether a key is in `STORAGE_KEYS_ADDRESS` values and auto-adds the address prefix. This is a hardcoded check against the known enum values. If `ProfileStorageProvider` implements a different key-mapping scheme (e.g., dotted notation like `addr1.pendingTransfers`), all key lookups must be consistent.

**Mitigation:** The `ProfileStorageProvider` should implement the same `getFullKey()` logic, mapping from existing flat keys to Profile dotted keys internally. Callers must not see any difference.

### 5.3 Write Ordering and Consistency

**Risk: Read-after-write during wallet creation.** `Sphere.create()` writes keys sequentially (mnemonic, derivation path, base path, etc.) then reads them back during `loadIdentityFromStorage()`. If the Profile provider buffers writes (write-behind) or depends on OrbitDB replication, the read-back may fail.

**Mitigation:** Local writes must be immediately readable from the local cache before OrbitDB persistence. The write-behind model used by `IpfsStorageProvider` (save returns immediately, flush is async) is the correct pattern. The `ProfileStorageProvider` should maintain an in-memory write buffer that is always consulted during reads.

### 5.4 `clear()` Semantics

**Risk: Full clear vs prefix clear.** `Sphere.clear()` calls `storage.clear()` with no prefix — this must wipe ALL keys. `PaymentsModule` never calls `storage.clear()` — it only reads/writes individual keys. If `ProfileStorageProvider.clear()` does not also clear the OrbitDB database, a subsequent `Sphere.init()` on the same device would find no local data but OrbitDB still has the old profile, leading to ghost wallet recovery.

**Mitigation:** `clear()` must: (1) clear local cache, (2) optionally tombstone/delete OrbitDB entries, (3) ensure `Sphere.exists()` returns false afterward. The Profile Architecture specifies this in the migration cleanup (Section 7.6 step 5).

### 5.5 `exists()` Check Without Identity

**Risk: `Sphere.exists(storage)` is called before `setIdentity()`.** It checks for `mnemonic` and `master_key` global keys. The `ProfileStorageProvider` must support reads of global keys before identity is set.

**Mitigation:** Global keys must be accessible without address scoping. The Profile schema stores these under `identity.mnemonic` etc., and the key-mapping logic in `get()` must handle the pre-identity state.

### 5.6 TrackedAddresses Dedicated Methods

**Risk: `saveTrackedAddresses()` / `loadTrackedAddresses()` are dedicated interface methods**, not generic `get/set`. The `IndexedDBStorageProvider` implements them as thin wrappers over `set(TRACKED_ADDRESSES, JSON.stringify(...))` and `get(TRACKED_ADDRESSES)`. The `ProfileStorageProvider` must implement these same methods.

**Mitigation:** Implement as wrappers that map to `addresses.tracked` in the Profile.

### 5.7 TokenStorageProvider `save()` Is Called Very Frequently

PaymentsModule calls `this.save()` after almost every token state change (send, receive, split, resolve, etc. — over 30 call sites). If `ProfileStorageProvider.save()` pins a new CAR file to IPFS on every call, IPFS will accumulate hundreds of CIDs per session.

**Mitigation:** The `IpfsStorageProvider` already solves this with a write-behind buffer and debounced flush (2-second coalesce window). The `ProfileTokenStorageProvider` must use the same pattern: accept writes immediately, debounce the actual IPFS pin + OrbitDB update.

### 5.8 History Store: Optional Methods

The `addHistoryEntry()`, `getHistoryEntries()`, etc. are optional on the `TokenStorageProvider` interface. `PaymentsModule` checks for their existence before calling. The `ProfileTokenStorageProvider` should implement all optional history methods to maintain feature parity with `IndexedDBTokenStorageProvider`. If it does not, history entries will only be serialized in the `_history` array inside TXF data (less efficient, no dedup store).

---

## 6. Migration Touchpoints

### 6.1 Data to Read from Legacy Storage

The migration (Profile Architecture Section 7.6) must read:

**From `StorageProvider` (IndexedDB `sphere-storage` / file storage):**

| Key | Format | Notes |
|-----|--------|-------|
| `sphere_mnemonic` | AES-encrypted string | Password-encrypted BIP39 mnemonic |
| `sphere_master_key` | AES-encrypted string | Password-encrypted hex private key |
| `sphere_chain_code` | Plain hex string | BIP32 chain code |
| `sphere_derivation_path` | Plain string | e.g., `m/44'/0'/0'/0/0` |
| `sphere_base_path` | Plain string | e.g., `m/44'/0'/0'` |
| `sphere_derivation_mode` | Plain string | `bip32` / `wif_hmac` / `legacy_hmac` |
| `sphere_wallet_source` | Plain string | `mnemonic` / `file` / `unknown` |
| `sphere_wallet_exists` | `'true'` | Existence flag |
| `sphere_current_address_index` | Numeric string | e.g., `'0'` |
| `sphere_address_nametags` | JSON `{ [addressId]: string }` | Nametag map |
| `sphere_tracked_addresses` | JSON `{ version: 1, addresses: TrackedAddressEntry[] }` | Address registry |
| `sphere_last_wallet_event_ts_*` | Numeric string (unix seconds) | Per-pubkey timestamp |
| `sphere_last_dm_event_ts_*` | Numeric string (unix seconds) | Per-pubkey timestamp |
| `sphere_group_chat_relay_url` | URL string | Last relay URL |
| `sphere_{addressId}_pending_transfers` | JSON `TransferResult[]` | |
| `sphere_{addressId}_outbox` | JSON `OutboxEntry[]` | |
| `sphere_{addressId}_conversations` | JSON | DM conversation metadata |
| `sphere_{addressId}_messages` | JSON | DM message content |
| `sphere_{addressId}_pending_v5_tokens` | JSON `PendingV5Finalization[]` | |
| `sphere_{addressId}_processed_split_group_ids` | JSON `string[]` | Dedup set |
| `sphere_{addressId}_processed_combined_transfer_ids` | JSON `string[]` | Dedup set |
| `sphere_{addressId}_group_chat_*` | JSON | Group chat state |

Note: All keys are prefixed with `sphere_` (the `STORAGE_PREFIX`). Per-address keys additionally include the address ID (e.g., `sphere_DIRECT_abc123_xyz789_pending_transfers`).

**From `TokenStorageProvider` (IndexedDB `sphere-token-storage-{addressId}`):**

| Store | Key Pattern | Format |
|-------|------------|--------|
| `meta` -> `meta` | Single entry | `TxfMeta` object |
| `meta` -> `tombstones` | Single entry | `TxfTombstone[]` |
| `meta` -> `outbox` | Single entry | `TxfOutboxEntry[]` |
| `meta` -> `sent` | Single entry | `TxfSentEntry[]` |
| `meta` -> `invalid` | Single entry | `TxfInvalidEntry[]` |
| `tokens` -> `{tokenId}` | Per-token | `{ id: string, data: TxfToken }` |
| `tokens` -> `archived-{tokenId}` | Per-archived-token | `{ id: string, data: TxfToken }` |
| `history` -> `{dedupKey}` | Per-entry | `HistoryRecord` |

**From IPFS (old-format sync):**
- Resolve IPNS name (derived from wallet private key via `deriveIpnsIdentity()`)
- Fetch latest CID -> `TxfStorageDataBase` JSON
- Merge with local data to get the most complete state before transformation

### 6.2 Legacy Key Discovery

To enumerate all per-address data, the migration must:
1. Load tracked addresses from `sphere_tracked_addresses` -> get list of `addressId` values
2. For each address ID, read all `STORAGE_KEYS_ADDRESS` keys with that prefix
3. Find all IndexedDB databases matching `sphere-token-storage-*` pattern (via `indexedDB.databases()`)

### 6.3 IPFS State Keys (Consumed, Not Migrated)

The old IPFS sync system persists state in the KV store. These keys are used during migration step 1 but NOT carried into the Profile:

| Key Pattern | Purpose |
|------------|---------|
| `sphere_ipfs_seq_{ipnsName}` | IPNS sequence number |
| `sphere_ipfs_cid_{ipnsName}` | Last known CID |
| `sphere_ipfs_ver_{ipnsName}` | Data version |

These are managed by `IpfsStatePersistence` (the `statePersistence` field in `IpfsStorageProvider`). The migration reads the latest CID from here to fetch the final old-format IPFS state before converting to UXF.

### 6.4 Cache-Only Keys (Not Migrated to OrbitDB)

Per the Profile Architecture Section 2.1, these keys stay local-only:
- `sphere_token_registry_cache` / `sphere_token_registry_cache_ts`
- `sphere_price_cache` / `sphere_price_cache_ts`

They are regenerated from external APIs and should not be replicated across devices (they would bloat the OrbitDB OpLog with transient data).

---

## Summary: Critical Integration Contracts

1. **`get/set` must work before `setIdentity()`** for global keys (mnemonic, master_key, wallet_exists, etc.)
2. **`setIdentity()` must be synchronous** — no async initialization allowed in this method
3. **Write-behind buffering is mandatory** — `save()` is called 30+ times per session; each call must not trigger an IPFS pin
4. **Read-after-write consistency required** — writes to local cache must be immediately readable, even if OrbitDB/IPFS persistence is pending
5. **`createForAddress()` must return a fully independent instance** with its own IPNS/OrbitDB scope
6. **`clear()` with no arguments must make `Sphere.exists()` return false** on both local and remote
7. **`storage:remote-updated` event drives cross-device sync** — the Profile provider must emit this when OrbitDB replication delivers new data
8. **History methods are optional but strongly recommended** — without them, history only survives via the `_history` array in TXF, which is less efficient
9. **Cache-only keys must stay local** — token registry cache and price cache must not replicate to OrbitDB
10. **Migration must read from both StorageProvider and TokenStorageProvider** to capture the complete wallet state before converting to Profile format
