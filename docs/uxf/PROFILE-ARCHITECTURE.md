# UXF Profile: User Wallet Storage Architecture

**Status:** Draft — requires manual approval before implementation
**Date:** 2026-03-30
**Updated:** 2026-03-30 — OrbitDB for conflict resolution, multi-bundle CIDs with lazy consolidation

---

## 1. Overview

The **UXF Profile** is a key-value table that represents the complete persistent state of a Sphere user wallet. It serves as the universal storage schema for everything a wallet needs to store — identity, token inventory, transaction history, conversations, nametags, operational state, and metadata.

The Profile is designed with a clear persistence hierarchy:

```
┌─────────────────────────────────────────────────────┐
│  OrbitDB Layer (Source of Truth — persistent, CRDT)  │
│  Profile stored as OrbitDB KeyValue database         │
│  Automatic conflict resolution via Merkle-CRDTs      │
│  Replicated across devices via libp2p/IPFS           │
├─────────────────────────────────────────────────────┤
│  IPFS Layer (Content-Addressed Storage)              │
│  Token inventories stored as UXF CAR files           │
│  Multiple bundle CIDs — lazily consolidated          │
├─────────────────────────────────────────────────────┤
│  Local Cache Layer (Transient — fast, untrusted)    │
│  Browser: IndexedDB / OPFS                          │
│  Node.js: SQLite / LevelDB / JSON files             │
│  Mobile: SQLite / AsyncStorage                      │
│  Serves as read cache + write-behind buffer         │
└─────────────────────────────────────────────────────┘
```

**Core principles:**

1. **OrbitDB is the source of truth** for all profile KV data. Its Merkle-CRDT OpLog ensures automatic conflict resolution when the same wallet is accessed from multiple devices concurrently. No manual merge logic needed — OrbitDB's `keyvalue` database type uses last-writer-wins per key, and the OpLog guarantees causal ordering.

2. **IPFS is the content store** for bulk token data (UXF packages as CAR files). The Profile stores CID references to these packages, not the packages themselves.

3. **Local storage is a transient cache** that may be lost at any time (browser cache cleared, app reinstalled, device lost). On startup, the local cache is validated against OrbitDB state and rehydrated if stale or missing. Critical writes are not considered durable until replicated to OrbitDB.

---

## 2. Profile Schema

The Profile is a flat key-value table where each key is a string and each value is an IPLD-compatible data structure (serializable via dag-cbor). The schema is divided into **global keys** (wallet-wide) and **per-address keys** (scoped to an HD derivation address).

### 2.1 Global Keys

These exist once per wallet, regardless of how many HD addresses are derived.

| Key | Value Type | Persistence | Description |
|-----|-----------|-------------|-------------|
| `identity.mnemonic` | bytes (encrypted) | IPFS | Encrypted BIP39 mnemonic |
| `identity.masterKey` | bytes (encrypted) | IPFS | Encrypted master private key |
| `identity.chainCode` | bytes | IPFS | BIP32 chain code |
| `identity.derivationPath` | string | IPFS | Full HD derivation path |
| `identity.basePath` | string | IPFS | Base derivation path |
| `identity.derivationMode` | string | IPFS | `bip32` / `wif_hmac` / `legacy_hmac` |
| `identity.walletSource` | string | IPFS | `mnemonic` / `file` / `unknown` |
| `identity.currentAddressIndex` | uint | IPFS | Currently active address index |
| `addresses.tracked` | `TrackedAddress[]` | IPFS | Registry of all derived HD addresses |
| `addresses.nametags` | `Map<addressId, string>` | IPFS | Nametag cache per address |
| `tokens.bundles` | `UxfBundleRef[]` | OrbitDB | **Array of UXF bundle references (CIDs) — see Section 2.3** |
| `tokens.registryCache` | JSON | Cache-only | Token metadata registry (fetched from remote) |
| `tokens.registryCacheTs` | uint | Cache-only | Registry cache timestamp |
| `prices.cache` | JSON | Cache-only | Price data from CoinGecko |
| `prices.cacheTs` | uint | Cache-only | Price cache timestamp |
| `transport.lastWalletEventTs` | `Map<pubkey, uint>` | IPFS | Last processed Nostr wallet event timestamp per pubkey |
| `transport.lastDmEventTs` | `Map<pubkey, uint>` | IPFS | Last processed Nostr DM event timestamp per pubkey |
| `groupchat.relayUrl` | string | IPFS | Last used group chat relay URL |
| `profile.version` | uint | IPFS | Profile schema version (for migrations) |
| `profile.createdAt` | uint | IPFS | Profile creation timestamp (seconds) |
| `profile.updatedAt` | uint | IPFS | Last modification timestamp (seconds) |

### 2.2 Per-Address Keys

These are scoped to a specific HD address. The full key is `{addressId}.{key}` where `addressId` is the short identifier for the address (e.g., first 8 chars of pubkey hash).

| Key | Value Type | Persistence | Description |
|-----|-----------|-------------|-------------|
| `{addr}.pendingTransfers` | `PendingTransfer[]` | IPFS | In-flight transfers awaiting confirmation |
| `{addr}.outbox` | `OutboxEntry[]` | IPFS | Transfer outbox |
| `{addr}.conversations` | `Conversation[]` | IPFS | DM conversation metadata |
| `{addr}.messages` | `Map<peerId, Message[]>` | IPFS | DM message content |
| `{addr}.transactionHistory` | `HistoryRecord[]` | IPFS | Transaction history entries |
| `{addr}.pendingV5Tokens` | `PendingV5Token[]` | IPFS | Unconfirmed instant-split tokens |
| `{addr}.groupchat.groups` | `GroupData[]` | IPFS | Joined NIP-29 groups |
| `{addr}.groupchat.messages` | `Map<groupId, Message[]>` | IPFS | Group chat messages |
| `{addr}.groupchat.members` | `Map<groupId, Member[]>` | IPFS | Group member lists |
| `{addr}.groupchat.processedEvents` | `Set<eventId>` | IPFS | Dedup set for processed events |
| `{addr}.processedSplitGroupIds` | `Set<groupId>` | IPFS | V5 split dedup |
| `{addr}.processedCombinedTransferIds` | `Set<transferId>` | IPFS | V6 combined transfer dedup |
| `{addr}.accounting.cancelledInvoices` | `Set<invoiceId>` | IPFS | Cancelled invoice IDs |
| `{addr}.accounting.closedInvoices` | `Set<invoiceId>` | IPFS | Closed invoice IDs |
| `{addr}.accounting.frozenBalances` | `Map<invoiceId, FrozenBalance>` | IPFS | Frozen balances for terminated invoices |
| `{addr}.accounting.autoReturn` | `AutoReturnSettings` | IPFS | Auto-return configuration |
| `{addr}.accounting.autoReturnLedger` | `AutoReturnLedger` | IPFS | Auto-return dedup ledger |
| `{addr}.accounting.invLedgerIndex` | `Map<invoiceId, InvMeta>` | IPFS | Invoice-transfer index |
| `{addr}.accounting.tokenScanState` | `Map<tokenId, uint>` | IPFS | Token scan watermarks |
| `{addr}.swap.index` | `SwapSummary[]` | IPFS | Swap listing index |
| `{addr}.swap:{swapId}` | `SwapRecord` | IPFS | Per-swap state (dynamic keys) |

### 2.3 Token Inventory: Multi-Bundle Model

The `tokens.bundles` key stores an **array** of UXF bundle references, not a single CID. This is a key design choice that enables conflict-free multi-device operation:

```
Profile (OrbitDB KV)
  └── tokens.bundles: UxfBundleRef[]
        ├── { cid: CID_1, status: "active", createdAt: 1711929600, device: "browser-a" }
        ├── { cid: CID_2, status: "active", createdAt: 1711929700, device: "nodejs-b" }
        └── { cid: CID_3, status: "superseded", supersededBy: CID_4, deleteAfter: 1712534400 }
```

Each `UxfBundleRef`:
```typescript
interface UxfBundleRef {
  cid: string;              // CID of the UXF CAR file on IPFS
  status: 'active' | 'superseded' | 'pending-deletion';
  createdAt: number;        // Unix seconds
  device?: string;          // Optional device identifier that created this bundle
  supersededBy?: string;    // CID of the bundle that replaced this one (after consolidation)
  deleteAfter?: number;     // Unix seconds — safe deletion time (e.g., createdAt + 7 days)
  tokenCount?: number;      // Number of tokens in this bundle (for quick display)
}
```

#### Why Multiple Bundles?

When two devices operate on the same wallet concurrently:
- **Device A** sends a token → creates a new UXF bundle (CID_A) with the updated inventory → adds CID_A to `tokens.bundles`
- **Device B** receives a token → creates a new UXF bundle (CID_B) → adds CID_B to `tokens.bundles`
- OrbitDB's Merkle-CRDT ensures both entries appear in `tokens.bundles` (no conflict — they are appended, not overwritten)
- The wallet now has **two active bundles** with overlapping content

#### Reading with Multiple Bundles

When loading the token inventory, the client reads ALL active bundles and presents a merged view:

```
1. Read tokens.bundles → [CID_1, CID_2] (both active)
2. For each CID: UxfPackage.fromCar(fetch(CID))
3. Merge all packages: result = UxfPackage.create()
   result.merge(pkg1)  // add all tokens from bundle 1
   result.merge(pkg2)  // add all tokens from bundle 2 (dedup by content hash)
4. The merged result is the complete token inventory
```

Since UXF deduplication is content-addressed, overlapping tokens between bundles produce zero duplication in the merged in-memory view. The merge is cheap — it's just a Map union keyed by content hash.

#### Lazy Consolidation

Over time, multiple small bundles accumulate. A background consolidation process merges them:

```
1. Read tokens.bundles → [CID_1, CID_2, CID_3] (3 active bundles)
2. Merge all into one UxfPackage
3. Export merged package: UxfPackage.toCar() → pin to IPFS → CID_merged
4. Update tokens.bundles:
   - Add { cid: CID_merged, status: "active" }
   - Mark CID_1, CID_2, CID_3 as { status: "superseded", supersededBy: CID_merged, deleteAfter: now + 7 days }
5. After the safety period (7 days), mark superseded bundles as "pending-deletion"
6. Eventually, unpinned/deleted from IPFS
```

The safety period ensures that any device still referencing the old CIDs has time to sync and learn about the consolidated bundle. During the transition, both old and new CIDs are valid — clients that haven't synced yet can still read the old bundles.

#### Consolidation Triggers

- **Automatic:** when `tokens.bundles` has > 3 active entries, consolidate in background
- **Manual:** `UxfPackage.consolidateBundles()` API for explicit trigger
- **On sync:** when the profile loads from OrbitDB and finds multiple active bundles from other devices

#### Bundle Lifecycle

```
active → superseded (after consolidation) → pending-deletion (after safety period) → deleted (unpinned from IPFS)
```

### 2.4 Operational State (TXF Compatibility)

The existing `TxfStorageData` fields map to UXF Profile as follows:

| TxfStorageData Field | Profile Key | Notes |
|---------------------|-------------|-------|
| `_meta.address` | Derived from `identity.currentAddressIndex` | Not stored separately |
| `_meta.ipnsName` | Derived from identity key | Not stored |
| `_meta.version` | `profile.version` | Migrated |
| `_meta.formatVersion` | `profile.version` | Unified |
| `_tombstones[]` | Embedded in UXF package metadata | Moved to token inventory |
| `_outbox[]` | `{addr}.outbox` | Migrated |
| `_sent[]` | `{addr}.transactionHistory` (type=SENT) | Merged into history |
| `_invalid[]` | Embedded in UXF package metadata | Moved to token inventory |
| `_history[]` | `{addr}.transactionHistory` | Migrated |
| `_<tokenId>` entries | UXF element pool | Replaced by UXF |
| `archived-<tokenId>` | UXF element pool (archived flag in manifest) | Replaced |
| `_forked_<tokenId>_<hash>` | UXF element pool (forked flag in manifest) | Replaced |
| `_nametag` / `_nametags` | `addresses.nametags` + UXF nametag tokens | Split |

---

## 3. Persistence Model: OrbitDB + IPFS

### 3.1 Architecture

```
┌─────────────┐     write          ┌──────────────┐     OrbitDB         ┌──────────────┐
│ Application  │──────────────────→│ Local Cache   │──── replication ──→│   OrbitDB    │
│ (Sphere SDK) │←───── read ───────│ (IndexedDB/   │←── CRDT merge ────│   (IPFS +    │
│              │                   │  SQLite/etc)  │                    │   libp2p)    │
└─────────────┘                   └──────────────┘                    └──────────────┘
                                        │                                     │
                                        │     UXF CAR files                   │
                                        └───── pin/fetch ────────────────────→│
                                                                         ┌────┴────┐
                                                                         │  IPFS   │
                                                                         │ Pinning │
                                                                         └─────────┘
```

**OrbitDB provides:**
- Merkle-CRDT OpLog for automatic conflict resolution across devices
- `keyvalue` database type: last-writer-wins per key with causal ordering
- Replication via libp2p PubSub (real-time when peers are online) + DHT (cold sync)
- Persistent storage backed by IPFS blockstore

**IPFS provides:**
- Content-addressed storage for UXF CAR files (bulk token data)
- CID-based deduplication across bundles
- Lazy block fetching via gateways

### 3.2 Write Path (Critical Operations)

When a critical operation occurs (token send, token receive, nametag registration):

1. **Write to local cache** (immediate, synchronous from caller's perspective)
2. **Write to OrbitDB** (async, returns when local OpLog entry is created):
   a. If tokens changed: build new UXF CAR, pin to IPFS, get new CID
   b. Append new bundle CID to `tokens.bundles` array
   c. Update affected profile keys via `db.put(key, value)`
   d. OrbitDB creates an OpLog entry (content-addressed, signed)
3. **Background replication:** OrbitDB replicates the OpLog entry to other peers/devices via libp2p PubSub
4. **Mark as durable** once the OpLog entry is persisted to the local IPFS blockstore (OrbitDB does this automatically)

**Critical write guarantee:** The SDK's `send()`, `receive()`, and `registerNametag()` methods do NOT return success until the UXF CAR is pinned to IPFS AND the OrbitDB put() completes locally. Cross-device replication happens asynchronously.

**Non-critical writes** (price cache, registry cache) write to local cache only — not to OrbitDB.

### 3.3 Read Path

1. **Read from local cache** (fast, synchronous) — if cache is warm
2. **Cache miss: read from OrbitDB** — fetches from the local OrbitDB replica (fast, no network needed if synced)
3. **Background sync:** OrbitDB automatically merges incoming OpLog entries from other devices

### 3.4 Startup Flow

```
1. Open OrbitDB database (deterministic address from wallet key)
   ├── Local OrbitDB state exists: load from local IPFS blockstore (fast)
   │   └── Background: connect to peers, replicate new OpLog entries
   └── No local state (fresh install / cache cleared):
       ├── Connect to peers or Voyager relay
       ├── Replicate OrbitDB OpLog from remote peers
       ├── Derive current state from OpLog (CRDT merge)
       └── Populate local cache, resume operation
2. Read tokens.bundles → list of active UXF CIDs
3. For each CID: check local CAR cache, fetch from IPFS if missing
4. Merge all bundles in memory → ready to operate
```

### 3.5 Token Inventory: Multi-Bundle Lazy Loading

The token inventory may span multiple UXF bundles (see Section 2.3). Local storage may not fit all of them. The Profile supports **lazy loading**:

- `tokens.bundles` lists all active CIDs
- The local cache stores:
  - **Manifests from all active bundles** (small, ~1-10 KB each — always cached)
  - **A partial block cache** containing only recently-accessed element blocks
- When a token is needed that isn't in the local cache:
  1. Check which bundle(s) contain it (via cached manifests)
  2. Fetch the required blocks from IPFS gateway by CID
  3. Cache locally for future access
- Consolidation reduces the number of bundles over time, improving read performance

This means a device with limited storage can operate on a 10,000-token wallet by only caching the tokens currently in use.

### 3.6 Conflict Resolution (Handled by OrbitDB)

OrbitDB's Merkle-CRDT OpLog provides automatic conflict resolution:

| Data Type | OrbitDB Behavior | UXF Integration |
|-----------|-----------------|-----------------|
| **Scalar profile keys** (identity, settings) | Last-writer-wins per key (causal ordering via OpLog) | Direct — each `db.put()` is a CRDT operation |
| **Token bundles** (`tokens.bundles`) | Array append is conflict-free (both devices' bundles appear) | Merged view at read time via `UxfPackage.merge()` |
| **Messages / history** | Each entry is a separate `db.put()` with unique key | Union — OrbitDB preserves all writes from all devices |
| **Dedup sets** | Each ID is a separate key entry | Union — set grows monotonically |
| **Pending transfers** | Per-transfer key entries | Both devices' pending entries visible; confirmed entries removed by either device |

**Key insight:** By storing `tokens.bundles` as an array that grows (append new CIDs, mark old ones superseded), we avoid the most complex conflict scenario. Two devices never need to agree on a single CID — they just add their own and the merge view handles the rest.

---

## 4. Profile as OrbitDB Database

The Profile is stored as an **OrbitDB `keyvalue` database** backed by IPFS. Each profile key maps to an OrbitDB entry. OrbitDB handles replication, conflict resolution, and persistence automatically.

### 4.1 OrbitDB Database Identity

The OrbitDB database address is derived deterministically from the wallet's private key:

```
OrbitDB identity = OrbitDBIdentity(secp256k1PrivateKey(walletPrivateKey))
Database address = /orbitdb/<hash>/sphere-profile-<walletPubkeyShort>
```

Only the wallet holder can write to this database (OrbitDB access control via identity). Any peer can read (for discovery), but values are encrypted (Section 9).

### 4.2 Data Organization in OrbitDB

OrbitDB's `keyvalue` type stores each key as a separate OpLog entry. The Profile keys from Section 2 map directly:

```
db.put('identity.mnemonic', encryptedBytes)
db.put('identity.masterKey', encryptedBytes)
db.put('addresses.tracked', [...])
db.put('tokens.bundles', [{ cid: 'bafy...', status: 'active', ... }])
db.put('addr1.transactionHistory', [...])
db.put('addr1.messages', {...})
...
```

Large values (messages, history) are stored as IPLD-linked sub-structures, so the OpLog entries contain only CID references to the actual data blocks on IPFS.

### 4.3 OrbitDB OpLog and CRDT Merge

Each `db.put(key, value)` appends an entry to the Merkle-CRDT OpLog:

```
OpLog (append-only, content-addressed)
├── entry_1: { key: 'tokens.bundles', value: [{cid: CID_1, ...}], clock: 1, device: A }
├── entry_2: { key: 'addr1.messages', value: CID_msgs_v1, clock: 2, device: A }
├── entry_3: { key: 'tokens.bundles', value: [{cid: CID_2, ...}], clock: 1, device: B }  ← concurrent!
└── entry_4: { key: 'tokens.bundles', value: [{cid: CID_1, ...}, {cid: CID_2, ...}], clock: 3, device: A }  ← merged
```

When two devices write to the same key concurrently, OrbitDB's `keyvalue` type resolves by **last-writer-wins using the Lamport clock** from the OpLog. For `tokens.bundles`, this means the device that writes last includes both bundles in its array — no data is lost because both CIDs are accumulated.

### 4.4 Replication

OrbitDB replicates via libp2p:

- **PubSub (real-time):** When peers are online simultaneously, OpLog entries propagate in sub-second via libp2p gossipsub topic `orbitdb/<dbAddress>`
- **DHT/Relay (cold sync):** When a device comes online after being offline, it discovers peers and fetches missing OpLog entries via IPFS block exchange
- **Voyager (optional):** OrbitDB's relay service stores OpLog entries for offline peers — acts as a persistent relay. Alternative: use the existing sphere-sdk Nostr relay infrastructure as a fallback replication channel

---

## 5. SDK Integration: ProfileStorageProvider

The Profile integrates with the existing sphere-sdk via a new `ProfileStorageProvider` that implements both `StorageProvider` and `TokenStorageProvider` interfaces.

### 5.1 Interface Compatibility

```
ProfileStorageProvider implements StorageProvider {
  // Maps KV operations to Profile keys
  get(key: string) → look up in Profile KV table
  set(key: string, value: string) → update Profile KV table + queue IPFS flush
  remove(key: string) → remove from Profile KV table
  has(key: string) → check Profile KV table
  keys(prefix?) → scan Profile KV table
  clear(prefix?) → clear matching Profile keys
}

ProfileTokenStorageProvider implements TokenStorageProvider<TxfStorageDataBase> {
  // Maps TXF operations to UXF token inventory
  save(data: TxfStorageData) → convert tokens to UXF, update inventory CID
  load() → assemble tokens from UXF, convert to TxfStorageData format
  sync(localData) → merge local UXF with remote UXF via UxfPackage.merge()
}
```

### 5.2 Key Mapping from Existing Storage Keys

The existing `STORAGE_KEYS_GLOBAL` and `STORAGE_KEYS_ADDRESS` map directly to Profile keys:

| Existing Key | Profile Key |
|-------------|-------------|
| `mnemonic` | `identity.mnemonic` |
| `master_key` | `identity.masterKey` |
| `chain_code` | `identity.chainCode` |
| `derivation_path` | `identity.derivationPath` |
| `base_path` | `identity.basePath` |
| `derivation_mode` | `identity.derivationMode` |
| `wallet_source` | `identity.walletSource` |
| `wallet_exists` | Derived (profile exists = wallet exists) |
| `current_address_index` | `identity.currentAddressIndex` |
| `address_nametags` | `addresses.nametags` |
| `tracked_addresses` | `addresses.tracked` |
| `last_wallet_event_ts_{pubkey}` | `transport.lastWalletEventTs.{pubkey}` |
| `last_dm_event_ts_{pubkey}` | `transport.lastDmEventTs.{pubkey}` |
| `group_chat_relay_url` | `groupchat.relayUrl` |
| `token_registry_cache` | `tokens.registryCache` |
| `token_registry_cache_ts` | `tokens.registryCacheTs` |
| `price_cache` | `prices.cache` |
| `price_cache_ts` | `prices.cacheTs` |
| `{addr}_pending_transfers` | `{addr}.pendingTransfers` |
| `{addr}_outbox` | `{addr}.outbox` |
| `{addr}_conversations` | `{addr}.conversations` |
| `{addr}_messages` | `{addr}.messages` |
| `{addr}_transaction_history` | `{addr}.transactionHistory` |
| `{addr}_pending_v5_tokens` | `{addr}.pendingV5Tokens` |
| `{addr}_group_chat_*` | `{addr}.groupchat.*` |
| `{addr}_processed_split_group_ids` | `{addr}.processedSplitGroupIds` |
| `{addr}_processed_combined_transfer_ids` | `{addr}.processedCombinedTransferIds` |
| `{addr}_cancelled_invoices` | `{addr}.accounting.cancelledInvoices` |
| `{addr}_closed_invoices` | `{addr}.accounting.closedInvoices` |
| `{addr}_frozen_balances` | `{addr}.accounting.frozenBalances` |
| `{addr}_auto_return` | `{addr}.accounting.autoReturn` |
| `{addr}_auto_return_ledger` | `{addr}.accounting.autoReturnLedger` |
| `{addr}_inv_ledger_index` | `{addr}.accounting.invLedgerIndex` |
| `{addr}_token_scan_state` | `{addr}.accounting.tokenScanState` |
| `{addr}_swap_index` | `{addr}.swap.index` |
| `{addr}_swap:{swapId}` | `{addr}.swap:{swapId}` |

### 5.3 Token Storage Flow (UXF Multi-Bundle Integration)

**Saving tokens (write path):**
```
PaymentsModule.save()
  → ProfileTokenStorageProvider.save(txfData)
    → Convert each TxfToken to ITokenJson (adapter)
    → UxfPackage.ingest(token) for each changed/new token
    → Handle _tombstones, _outbox, _sent as separate profile keys
    → UxfPackage.toCar() → pin CAR to IPFS → get new CID
    → Append new UxfBundleRef to tokens.bundles array:
      db.put('tokens.bundles', [...existing, { cid: newCid, status: 'active', createdAt: now }])
    → OrbitDB replicates to peers
```

**Loading tokens (read path):**
```
PaymentsModule.load()
  → ProfileTokenStorageProvider.load()
    → bundles = db.get('tokens.bundles') → UxfBundleRef[]
    → activeBundles = bundles.filter(b => b.status === 'active')
    → mergedPkg = UxfPackage.create()
    → For each active bundle:
        → If local CAR cache has this CID: use local
        → Else: fetch CAR from IPFS, cache locally
        → pkg = UxfPackage.fromCar(carBytes)
        → mergedPkg.merge(pkg)  // content-addressed dedup — overlapping tokens stored once
    → mergedPkg.assembleAll() → Map<tokenId, ITokenJson>
    → Convert each to TxfToken (adapter)
    → Build TxfStorageData from assembled tokens + profile operational keys
    → Return TxfStorageData
```

**Syncing (handled automatically by OrbitDB):**
```
OrbitDB replication callback:
  → New OpLog entries arrive from peer device
  → OrbitDB merges via CRDT (automatic)
  → tokens.bundles now includes bundles from both devices
  → Next load() will see all bundles and merge them
  → Emit 'sync:completed' event

Background consolidation (if > 3 active bundles):
  → Merge all active bundles into one UxfPackage
  → UxfPackage.toCar() → pin to IPFS → consolidatedCid
  → Update tokens.bundles: mark old bundles as 'superseded', add consolidated
  → After safety period (7 days): mark superseded as 'pending-deletion'
```

---

## 6. Local Cache Implementations

### 6.1 Browser: IndexedDB

```
Database: "sphere-profile-cache"
Object stores:
  - "profile-kv" → key-value pairs (all profile keys)
  - "car-blocks" → individual IPLD blocks from CAR files (keyed by CID)
  - "car-manifests" → UXF manifests (keyed by inventory CID)
```

IndexedDB is used as a pure cache — it can be cleared at any time. The app recovers by re-fetching from IPFS.

### 6.2 Node.js: SQLite (better-sqlite3) or LevelDB

```
Single database file: ~/.sphere/profile-cache.db
Tables (SQLite):
  - profile_kv (key TEXT PRIMARY KEY, value BLOB, updated_at INTEGER)
  - car_blocks (cid TEXT PRIMARY KEY, data BLOB, accessed_at INTEGER)
  - car_manifests (cid TEXT PRIMARY KEY, manifest BLOB)
```

For lightweight backends (CLI tools, agents), a JSON file at `~/.sphere/profile.json` suffices.

### 6.3 Cache Eviction

The `car-blocks` store can grow large. Eviction policy:
- **LRU by access time:** blocks not accessed in 7 days are evicted
- **Size cap:** configurable max cache size (default: 100 MB browser, 1 GB Node.js)
- **Manifest pinning:** blocks referenced by the current manifest are never evicted
- **On-demand fetch:** evicted blocks are re-fetched from IPFS when needed

---

## 7. Operation Flows

### 7.1 Token Send (L3)

```
1. User initiates send(recipient, amount, coinId)
2. PaymentsModule selects tokens from merged bundle view, performs split if needed
3. State transitions submitted to aggregator, proofs collected
4. Tokens updated in memory
5. CRITICAL WRITE:
   a. UxfPackage with updated tokens (spent removed, change added)
   b. UxfPackage.toCar() → pin CAR to IPFS → new bundle CID
   c. db.put('tokens.bundles', [...existing, { cid: newCid, status: 'active' }])
   d. db.put('{addr}.transactionHistory', [...history, newEntry])
   e. ONLY NOW return success to caller
6. Local cache updated
7. OrbitDB replicates to peers in background
8. Background: if > 3 active bundles, trigger consolidation
```

### 7.2 Token Receive (via Nostr)

```
1. Transport receives TOKEN_TRANSFER event from relay
2. PaymentsModule.processIncomingTransfer() validates and imports token
3. Token finalized (proof collected from aggregator)
4. CRITICAL WRITE:
   a. UxfPackage.ingest(receivedToken) → toCar() → pin → new CID
   b. Append new bundle CID to tokens.bundles
   c. db.put('{addr}.transactionHistory', [...history, newEntry])
5. Emit 'transfer:incoming' event to app
6. OrbitDB replicates to peers in background
```

### 7.3 Cross-Device Sync (Automatic via OrbitDB)

```
OrbitDB replication is continuous — no polling needed:

1. Device connects to libp2p network
2. OrbitDB discovers peers sharing the same database address
3. OpLog entries replicate automatically via PubSub
4. CRDT merge: each key resolves to its latest value
5. tokens.bundles accumulates CIDs from all devices
6. Next load() sees all bundles → merge view is up to date
7. Emit 'sync:completed' event
8. Background consolidation reduces bundle count
```

### 7.4 DM Send/Receive

```
Send:
1. CommunicationsModule.sendDm(peerId, message)
2. Message sent via Nostr (NIP-17 gift-wrap)
3. Profile updated: {addr}.conversations, {addr}.messages
4. Flush to IPFS (debounced — messages are batched)

Receive:
1. Transport receives GIFT_WRAP event
2. Message decrypted, stored in {addr}.messages
3. {addr}.conversations updated
4. Flush to IPFS (debounced)
```

### 7.5 Nametag Registration

```
1. User calls sphere.registerNametag('alice')
2. NametagMinter mints nametag token on-chain
3. Nametag published to Nostr relay
4. CRITICAL WRITE:
   a. UxfPackage.ingest(nametagToken) — add to pool
   b. Profile: addresses.nametags updated
   c. Flush to IPFS
```

---

## 8. Compatibility Layer

### 8.1 Backward Compatibility

The Profile system must be backward-compatible with existing sphere-sdk consumers:

1. **`StorageProvider` interface unchanged** — `ProfileStorageProvider` implements the same `get/set/remove/has/keys/clear` interface. Existing code using `storage.get('mnemonic')` continues to work.

2. **`TokenStorageProvider` interface unchanged** — `ProfileTokenStorageProvider` implements `save/load/sync` with `TxfStorageDataBase` type parameter. `PaymentsModule` sees no difference.

3. **Migration path:** On first load with ProfileStorageProvider, detect existing data in legacy storage (IndexedDB `sphere-storage`, file-based storage) and migrate to Profile format. Legacy storage is preserved as fallback.

### 8.2 Factory Functions

```
// Browser
createBrowserProviders({ network, profile: true })
  → returns ProfileStorageProvider (backed by IndexedDB cache + IPFS)

// Node.js
createNodeProviders({ network, dataDir, profile: true })
  → returns ProfileStorageProvider (backed by SQLite cache + IPFS)

// Legacy (no IPFS, local only)
createBrowserProviders({ network })
  → returns IndexedDBStorageProvider (existing behavior, no change)
```

The `profile: true` option enables the IPFS-first persistence model. Without it, the existing local-only behavior is preserved.

---

## 9. Security Considerations

### 9.1 Encryption at Rest

The Profile on IPFS is **encrypted** using a key derived from the wallet's master key:

```
profileEncryptionKey = HKDF(masterKey, "uxf-profile-encryption", 32)
```

Each profile section block is encrypted with AES-256-GCM before IPFS upload. The encrypted blocks are content-addressed (CID of encrypted bytes, not plaintext). Only the wallet holder can decrypt.

This means:
- IPFS pinning services see only encrypted blobs
- Other IPFS users cannot read the profile
- The encryption key is derived deterministically — any device with the mnemonic can decrypt

### 9.2 Identity Block Protection

The `identity` section (encrypted mnemonic, master key) receives an additional encryption layer with a user-provided password, consistent with existing `Sphere.init({ password })` behavior. Without the password, even the wallet holder cannot decrypt the identity block.

### 9.3 Token Inventory Encryption

The UXF CAR file is encrypted at the CAR level (not per-block) for efficiency. The entire CAR is encrypted with `profileEncryptionKey` before IPFS upload.

---

## 10. Decided Questions

| # | Question | Decision |
|---|----------|----------|
| 5 | OrbitDB vs raw IPLD DAG | **OrbitDB** — Merkle-CRDTs handle multi-device conflict resolution automatically. No manual merge logic. |
| 3 | Single CID vs multiple bundle CIDs | **Multiple CIDs** — each device appends its own bundle CID. Lazy consolidation merges them over time. Content-addressed dedup ensures no duplication in the merged view. |

## 11. Remaining Open Questions

1. **Should cache-only keys (prices, registry) be stored in OrbitDB at all, or kept entirely in local storage?** They can be regenerated from remote APIs and add bulk to the OrbitDB OpLog.

2. **Should the Profile support selective encryption?** E.g., transaction history encrypted but token inventory not (to enable third-party verification without decryption).

3. **What's the migration strategy for existing wallets?** Should we auto-migrate on first load, or require explicit user action?

4. **What about the Sphere app's `WalletRepository` which uses localStorage directly?** Should the app migrate to use sphere-sdk's ProfileStorageProvider, or keep its own layer?

5. **OrbitDB bundle size in browser (~500KB+ gzipped with libp2p transports).** Is this acceptable for the browser bundle? Should OrbitDB be lazy-loaded, or should we accept the cost since it replaces the existing IPFS sync infrastructure?

6. **Voyager vs Nostr relay for offline replication.** Should we use OrbitDB's Voyager relay service, or reuse the existing sphere-sdk Nostr relay infrastructure as a fallback replication channel for OrbitDB OpLog entries?

7. **Consolidation safety period.** Is 7 days enough before deleting superseded bundles? Should it be configurable?
