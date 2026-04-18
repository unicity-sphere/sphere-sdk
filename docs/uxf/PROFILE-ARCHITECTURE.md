# UXF Profile: User Wallet Storage Architecture

**Status:** Draft — requires manual approval before implementation
**Date:** 2026-03-30
**Updated:** 2026-04-17 — CAR batch transfer, server-side validation, manifest status, outbox CIDs, Kubo semantic plugin

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
| `identity.mnemonic` | bytes | OrbitDB | BIP39 mnemonic (password-encrypted at application level) |
| `identity.masterKey` | bytes | OrbitDB | Master private key (password-encrypted at application level) |
| `identity.chainCode` | bytes | OrbitDB | BIP32 chain code |
| `identity.derivationPath` | string | IPFS | Full HD derivation path |
| `identity.basePath` | string | IPFS | Base derivation path |
| `identity.derivationMode` | string | IPFS | `bip32` / `wif_hmac` / `legacy_hmac` |
| `identity.walletSource` | string | IPFS | `mnemonic` / `file` / `unknown` |
| `identity.currentAddressIndex` | uint | IPFS | Currently active address index |
| `addresses.tracked` | `TrackedAddress[]` | IPFS | Registry of all derived HD addresses |
| `addresses.nametags` | `Map<addressId, string>` | IPFS | Nametag cache per address |
| `tokens.bundle.{CID}` | `UxfBundleRef` | OrbitDB | **Per-bundle reference — one key per UXF bundle (see Section 2.3)** |
| `transport.lastWalletEventTs` | `Map<pubkey, uint>` | OrbitDB | Last processed Nostr wallet event timestamp per pubkey |
| `transport.lastDmEventTs` | `Map<pubkey, uint>` | OrbitDB | Last processed Nostr DM event timestamp per pubkey |
| `groupchat.relayUrl` | string | OrbitDB | Last used group chat relay URL |
| `profile.version` | uint | OrbitDB | Profile schema version (for migrations) |
| `profile.createdAt` | uint | OrbitDB | Profile creation timestamp (seconds) |
| `profile.updatedAt` | uint | OrbitDB | Last modification timestamp (seconds) |
| `profile.consolidationRetentionMs` | uint | OrbitDB | Safety period before removing superseded bundles (default: 7 days, min: 24h) |

**Cache-only keys (NOT in OrbitDB — local storage only):**

| Key | Value Type | Description |
|-----|-----------|-------------|
| `tokens.registryCache` | JSON | Token metadata registry (fetched from remote) |
| `tokens.registryCacheTs` | uint | Registry cache timestamp |
| `prices.cache` | JSON | Price data from CoinGecko |
| `prices.cacheTs` | uint | Price cache timestamp |

These are regenerated from external APIs and are not replicated. Stored in the local `StorageProvider` (IndexedDB/file) as they are today.

**IPFS/IPNS state keys** (`ipfs.seq`, `ipfs.cid`, `ipfs.ver` per IPNS name) are obsoleted by OrbitDB and are NOT migrated to the Profile. OrbitDB replaces IPNS as the mutable pointer mechanism. During migration (Section 7.6), these keys are consumed for the final IPFS sync but not carried forward.

### 2.2 Per-Address Keys

These are scoped to a specific HD address. The full key is `{addressId}.{key}` where `addressId` is the short identifier for the address (e.g., first 8 chars of pubkey hash).

| Key | Value Type | Persistence | Description |
|-----|-----------|-------------|-------------|
| `{addr}.pendingTransfers` | `PendingTransfer[]` | IPFS | In-flight transfers awaiting confirmation |
| `{addr}.outbox` | `OutboxEntry[]` | IPFS | Transfer outbox |
| `{addr}.conversations` | `Conversation[]` | IPFS | DM conversation metadata |
| `{addr}.messages` | `Map<peerId, Message[]>` | IPFS | DM message content |
| ~~`{addr}.transactionHistory`~~ | — | **DERIVED** | **Not stored in UXF/OrbitDB.** Rebuilt on the fly by scanning token ownership chain predicates. Cached in local storage. See Section 10.3. |
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
| `{addr}.mintOutbox` | `MintOutboxEntry[]` | OrbitDB | Pending mint operations (CRITICAL — loss means stuck mints) |
| `{addr}.invalidTokens` | `InvalidTokenEntry[]` | OrbitDB | Tokens flagged as invalid |
| `{addr}.invalidatedNametags` | `InvalidatedNametagEntry[]` | OrbitDB | Revoked nametags with reason |
| ~~`{addr}.tombstones`~~ | — | **DERIVED** | **Not stored in UXF/OrbitDB.** Derived from oracle spent-checks during token status derivation. Cached in local storage. See Section 10.5. |

### 2.3 Token Inventory: Multi-Bundle Model

Each UXF bundle is stored as a **separate OrbitDB key** using the pattern `tokens.bundle.{CID}`. This ensures that two devices adding different bundles write to different keys — no LWW conflict is possible.

```
Profile (OrbitDB KV)
  └── tokens.bundle.bafy_CID_1 = { cid: "bafy_CID_1", status: "active", createdAt: 1711929600, device: "browser-a" }
  └── tokens.bundle.bafy_CID_2 = { cid: "bafy_CID_2", status: "active", createdAt: 1711929700, device: "nodejs-b" }
  └── tokens.bundle.bafy_CID_3 = { cid: "bafy_CID_3", status: "superseded", supersededBy: "bafy_CID_4", ... }
```

- **Adding a bundle:** `db.put('tokens.bundle.' + cid, ref)` — writes a single key, no read-modify-write cycle
- **Listing bundles:** `db.all()` filtered by prefix `tokens.bundle.` — returns all bundle refs
- **Removing a bundle:** `db.del('tokens.bundle.' + cid)` — removes a single key

Each `UxfBundleRef`:
```typescript
interface UxfBundleRef {
  cid: string;                    // CID of the UXF CAR file on IPFS
  status: 'active' | 'superseded';
  createdAt: number;              // Unix seconds
  device?: string;                // Optional device identifier that created this bundle
  supersededBy?: string;          // CID of the consolidated bundle that includes this one
  removeFromProfileAfter?: number; // Unix seconds — when to remove this entry from the Profile
  tokenCount?: number;            // Number of tokens in this bundle (for quick display)
}
```

**Important:** Old CIDs are removed from the Profile but are **NOT unpinned from IPFS**. IPFS-side garbage collection is a separate future workstream. The `removeFromProfileAfter` field controls only when the reference key is deleted from the Profile — the CAR file remains pinned on IPFS indefinitely until explicit GC logic is implemented.

#### Why Multiple Bundles?

When two devices operate on the same wallet concurrently:
- **Device A** sends a token → creates a new UXF bundle (CID_A) with the updated inventory → `db.put('tokens.bundle.' + CID_A, ref)`
- **Device B** receives a token → creates a new UXF bundle (CID_B) → `db.put('tokens.bundle.' + CID_B, ref)`
- These are **different OrbitDB keys** — no LWW conflict occurs. Both entries appear after replication.
- The wallet now has **two active bundles** with overlapping content

#### Reading with Multiple Bundles

When loading the token inventory, the client reads ALL active bundles and presents a merged view:

```
1. List all keys with prefix 'tokens.bundle.' → { CID_1: ref1, CID_2: ref2 }
2. Filter to active: refs where status === 'active' → [CID_1, CID_2]
3. For each CID: UxfPackage.fromCar(fetch(CID))
4. Merge all packages: result = UxfPackage.create()
   result.merge(pkg1)  // add all tokens from bundle 1
   result.merge(pkg2)  // add all tokens from bundle 2 (dedup by content hash)
5. The merged result is the complete token inventory
```

Since UXF deduplication is content-addressed, overlapping tokens between bundles produce zero duplication in the merged in-memory view. The merge is cheap — it's just a Map union keyed by content hash.

**CID availability:** If an active bundle's CID cannot be fetched from IPFS (gateway down, CID unpinned externally), the wallet logs a warning and operates with the remaining available bundles. The unavailable tokens are marked as 'unresolvable' in the UI. A periodic pinning verification step checks that all active CIDs are still accessible.

#### Lazy Consolidation

Over time, multiple small bundles accumulate. A background consolidation process merges them:

```
1. List all keys with prefix 'tokens.bundle.' → filter to active → [CID_1, CID_2, CID_3]
2. Merge all into one UxfPackage
3. Export merged package: UxfPackage.toCar() → pin to IPFS → CID_merged
4. Update OrbitDB:
   - db.put('tokens.bundle.' + CID_merged, { cid: CID_merged, status: 'active', ... })
   - db.put('tokens.bundle.' + CID_1, { ...existing, status: 'superseded', supersededBy: CID_merged, removeFromProfileAfter: now + 7d })
   - db.put('tokens.bundle.' + CID_2, { ...existing, status: 'superseded', supersededBy: CID_merged, removeFromProfileAfter: now + 7d })
   - db.put('tokens.bundle.' + CID_3, { ...existing, status: 'superseded', supersededBy: CID_merged, removeFromProfileAfter: now + 7d })
5. After the safety period (7 days): db.del('tokens.bundle.' + CID_1), etc.
```

The safety period ensures that any device still referencing the old CIDs has time to sync and learn about the consolidated bundle. During the transition, both old and new CIDs are valid — clients that haven't synced yet can still read the old bundles.

**Crash recovery for consolidation:**
- Before pinning the consolidated CAR, write a `consolidation.pending` key to OrbitDB:
  `db.put('consolidation.pending', { sourceCids: [...], startedAt: timestamp, device: deviceId })`
- After pinning: add the new bundle key, mark source bundles as superseded, delete `consolidation.pending`
- On startup: if `consolidation.pending` exists, check if the consolidated CID was pinned:
  - If pinned: complete the remaining steps (mark sources superseded, clean up pending key)
  - If not pinned: delete the pending key and restart consolidation

**Concurrent consolidation guard:** Before starting consolidation, check for `consolidation.pending` key. If another device's consolidation is in progress (started < 5 minutes ago), skip. If the pending entry is older than 5 minutes, assume the other device crashed and proceed.

**Performance limits:** Maximum recommended active bundles: 20. If consolidation consistently fails and bundle count exceeds 20, the wallet enters degraded mode: new writes are blocked until consolidation succeeds or manual intervention clears stale bundles.

#### Consolidation Triggers

- **Automatic:** when active bundle count (keys with prefix `tokens.bundle.` and status `active`) exceeds 3, consolidate in background
- **Manual:** `UxfPackage.consolidateBundles()` API for explicit trigger
- **On sync:** when the profile loads from OrbitDB and finds multiple active bundles from other devices

#### Bundle Lifecycle

```
active → superseded (after consolidation) → removed from Profile (after safety period)
```

Note: "removed from Profile" means the `tokens.bundle.{CID}` key is deleted from OrbitDB. The CAR file remains on IPFS — no unpinning occurs. IPFS-side garbage collection is a separate future concern.

**Specification note:** The `UxfBundleRef` type and multi-bundle protocol should be added to SPECIFICATION.md as an appendix or separate specification document in a future update.

### 2.4 Operational State (TXF Compatibility)

The existing `TxfStorageData` fields map to UXF Profile as follows:

| TxfStorageData Field | Profile Key | Notes |
|---------------------|-------------|-------|
| `_meta.address` | Derived from `identity.currentAddressIndex` | Not stored separately |
| `_meta.ipnsName` | Derived from identity key | Not stored |
| `_meta.version` | `profile.version` | Migrated |
| `_meta.formatVersion` | `profile.version` | Unified |
| `_tombstones[]` | **DERIVED** — not migrated to OrbitDB, rebuilt from oracle spent-checks | Not migrated |
| `_outbox[]` | `{addr}.outbox` | Migrated |
| `_sent[]` | **DERIVED** — rebuilt from token ownership predicates | Not migrated; history derived from pool |
| `_invalid[]` | `{addr}.invalidTokens` | Migrated |
| `_history[]` | **DERIVED** — rebuilt from token ownership predicates | Not migrated; history derived from pool |
| `_mintOutbox[]` | `{addr}.mintOutbox` | Migrated |
| `_invalidatedNametags[]` | `{addr}.invalidatedNametags` | Migrated |
| `_<tokenId>` entries | UXF element pool | Replaced by UXF |
| `archived-<tokenId>` | UXF element pool (archived flag in manifest) | Replaced |
| `_forked_<tokenId>_<hash>` | UXF element pool (forked tokens ingested as separate token entries with metadata) | Migrated |
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
   b. Add new bundle: `db.put('tokens.bundle.' + cid, ref)`
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
2. List all tokens.bundle.{CID} keys → filter active → list of UXF CIDs
3. For each CID: check local CAR cache, fetch from IPFS if missing
4. Merge all bundles in memory → ready to operate
```

### 3.5 Token Inventory: Multi-Bundle Lazy Loading

The token inventory may span multiple UXF bundles (see Section 2.3). Local storage may not fit all of them. The Profile supports **lazy loading**:

- `tokens.bundle.{CID}` keys list all active CIDs
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
| **Token bundles** (`tokens.bundle.{CID}`) | Each bundle is a separate OrbitDB key. Two devices adding different bundles write to different keys — no LWW conflict possible. | Merged view at read time via `UxfPackage.merge()` |
| **Messages / history** | Each entry is a separate `db.put()` with unique key | Union — OrbitDB preserves all writes from all devices |
| **Dedup sets** | Each ID is a separate key entry | Union — set grows monotonically |
| **Pending transfers** | Per-transfer key entries | Both devices' pending entries visible; confirmed entries removed by either device |

**Key insight:** By storing each bundle as a separate OrbitDB key (`tokens.bundle.{CID}`), we avoid all conflict scenarios. Two devices adding different bundles write to different keys — no LWW conflict is possible. Each device simply adds its own key and the merged view at read time handles the rest.

---

## 4. Profile as OrbitDB Database

The Profile is stored as an **OrbitDB `keyvalue` database** backed by IPFS. Each profile key maps to an OrbitDB entry. OrbitDB handles replication, conflict resolution, and persistence automatically.

### 4.1 OrbitDB Database Identity

The OrbitDB database address is derived deterministically from the wallet's private key:

```
OrbitDB identity = OrbitDBIdentity(secp256k1PrivateKey(walletPrivateKey))
Database address = /orbitdb/<hash>/sphere-profile-<walletPubkeyShort>
```

Only the wallet holder can write to this database (OrbitDB access control via identity). Any peer can replicate, but all values are AES-256-GCM encrypted — only the wallet holder can decrypt (Section 9).

### 4.2 Data Organization in OrbitDB

OrbitDB's `keyvalue` type stores each key as a separate OpLog entry. The Profile keys from Section 2 map directly:

```
db.put('identity.mnemonic', encryptedBytes)
db.put('identity.masterKey', encryptedBytes)
db.put('addresses.tracked', [...])
db.put('tokens.bundle.bafy...', { cid: 'bafy...', status: 'active', ... })
// transactionHistory: DERIVED from token pool, not stored in OrbitDB
db.put('addr1.messages', {...})
...
```

Large values (messages, history) are stored as IPLD-linked sub-structures, so the OpLog entries contain only CID references to the actual data blocks on IPFS.

### 4.3 OrbitDB OpLog and CRDT Merge

Each `db.put(key, value)` appends an entry to the Merkle-CRDT OpLog:

```
OpLog (append-only, content-addressed)
├── entry_1: { key: 'tokens.bundle.CID_1', value: {cid: CID_1, status: 'active', ...}, clock: 1, device: A }
├── entry_2: { key: 'addr1.messages', value: CID_msgs_v1, clock: 2, device: A }
├── entry_3: { key: 'tokens.bundle.CID_2', value: {cid: CID_2, status: 'active', ...}, clock: 1, device: B }  ← concurrent!
```

When two devices add bundles concurrently, they write to **different keys** (`tokens.bundle.CID_1` vs `tokens.bundle.CID_2`). No LWW conflict occurs — both entries coexist after replication. LWW only applies when two devices write to the **same** key (e.g., marking a bundle as superseded), which is resolved by Lamport clock ordering.

### 4.4 Replication

OrbitDB replicates via libp2p:

- **PubSub (real-time):** When peers are online simultaneously, OpLog entries propagate in sub-second via libp2p gossipsub topic `orbitdb/<dbAddress>`
- **Nostr relay as persistence fallback:** OrbitDB OpLog entries can be serialized as Nostr events (kind: 30078, encrypted content) for persistence on the existing relay infrastructure. This is NOT a thin adapter — it requires: (1) serializing OrbitDB OpLog entries to Nostr event format, (2) handling OpLog ordering (Nostr does not guarantee causal order), (3) implementing a custom OrbitDB replication protocol over Nostr. This is a **Phase 2 feature**. Phase 1 relies on standard libp2p PubSub for real-time replication and IPFS block exchange for cold sync.
- **DHT (fallback):** Standard IPFS DHT-based peer discovery as a last-resort fallback

### 4.5 OpLog Growth Management

OrbitDB's OpLog is append-only and grows indefinitely. For long-lived wallets:

- **Periodic snapshots:** Every N months (configurable), create a fresh OrbitDB database from the current state, replacing the old one. This resets the OpLog.
- **Write batching:** Batch rapid writes (e.g., multiple message receives) into single `db.put()` calls to reduce OpLog entry count.
- **Key consolidation:** Use compound values (JSON objects) for frequently-updated keys to reduce the number of OpLog entries.

Expected growth: ~100-500 bytes per OpLog entry. A wallet with 10 operations/day accumulates ~1.5-3.5 MB/year of OpLog data.

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
| `wallet_exists` | Derived (profile exists = wallet exists). Implementation: `has('wallet_exists')` checks local cache first (synchronous, fast). A `wallet_exists` flag is also maintained in local storage as a fast-path check that does not require OrbitDB access. |
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
| `{addr}_transaction_history` | ~~`{addr}.transactionHistory`~~ **DERIVED** — not migrated to OrbitDB, rebuilt from token pool |
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
    → Handle _outbox, _mintOutbox as separate profile keys (_tombstones, _sent, _history are DERIVED from token pool, not written)
    → UxfPackage.toCar() → pin CAR to IPFS → get new CID
    → Add new bundle as separate key:
      db.put('tokens.bundle.' + newCid, { cid: newCid, status: 'active', createdAt: now })
    → OrbitDB replicates to peers
```

**Loading tokens (read path):**
```
PaymentsModule.load()
  → ProfileTokenStorageProvider.load()
    → allBundles = db.all() filtered by prefix 'tokens.bundle.' → Map<key, UxfBundleRef>
    → activeBundles = [...allBundles.values()].filter(b => b.status === 'active')
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
  → tokens.bundle.{CID} keys now include bundles from both devices
  → Next load() will see all bundle keys and merge them
  → Emit 'sync:completed' event

Background consolidation (if > 3 active bundles):
  → Merge all active bundles into one UxfPackage
  → UxfPackage.toCar() → pin to IPFS → consolidatedCid
  → Add consolidated bundle key, mark old bundle keys as 'superseded'
  → After safety period (7 days): delete superseded bundle keys from OrbitDB
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

**Browser runtime constraints for OrbitDB:**
- libp2p in browsers requires WebRTC or WebTransport for peer discovery (NAT traversal via relay)
- WebRTC connection limits (~256 concurrent connections in Chrome)
- Service workers cannot run libp2p (no WebRTC in service workers)
- Bundle size: Helia + OrbitDB + libp2p is approximately 500KB-1MB minified
- Fallback for browsers without WebRTC: HTTP-based IPFS gateway fetch only (degraded mode)

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
   c. db.put('tokens.bundle.' + newCid, { cid: newCid, status: 'active', createdAt: now })
   d. ONLY NOW return success to caller
   (Transaction history NOT written to OrbitDB — derived from token pool on next read)
6. Local cache updated (incl. derived tx history cache refresh)
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
   b. db.put('tokens.bundle.' + newCid, { cid: newCid, status: 'active', createdAt: now })
   (Transaction history derived from token pool, not written to OrbitDB)
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
5. tokens.bundle.{CID} keys accumulate from all devices
6. Next load() lists all bundle keys → merge view is up to date
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

DM message content is encrypted with `profileEncryptionKey` before storing in OrbitDB (see Section 9.6). The NIP-17 privacy guarantee is preserved — messages are encrypted in both the Nostr relay (gift-wrap) and OrbitDB (AES-256-GCM). Only the wallet holder can decrypt.

### 7.5 Nametag Registration

```
1. User calls sphere.registerNametag('alice')
2. NametagMinter mints nametag token on-chain
3. Nametag published to Nostr relay
4. CRITICAL WRITE:
   a. UxfPackage.ingest(nametagToken) → toCar() → pin CAR to IPFS → new bundle CID
   b. db.put('tokens.bundle.' + newCid, { cid: newCid, status: 'active', createdAt: now })
   c. db.put('addresses.nametags', updatedNametagMap)
5. OrbitDB replicates to peers in background
```

### 7.6 Legacy Migration Flow

When `Sphere.init({ profile: true })` is called on a wallet that has legacy-format data (existing IndexedDB/file storage + old-format IPFS inventory), the following migration runs silently:

```
1. SYNC OLD IPFS DATA FIRST
   - For wallets that never used IPFS sync (no `sphere_ipfs_seq_*` keys), skip step 1 entirely.
   - Resolve existing IPNS name → get latest old-format CID
   - If IPNS resolution fails (expired name, network issues), skip step 1 and proceed
     with local-only data. Log a warning: 'IPNS resolution failed — migrating from
     local data only. Remote IPFS data may not be included.' The local data is likely
     more recent than the last IPFS sync.
   - Fetch old TXF data from IPFS
   - Merge with local legacy storage (ensures we have the most recent state)
   - This step MUST complete before transformation begins

2. TRANSFORM LOCAL DATA
   a. Read all StorageProvider keys → map to Profile key names (Section 5.2)
   b. Read all TokenStorageProvider tokens (TXF format)
      → Convert each to ITokenJson via adapter
      → Ingest all into a single UXF bundle via UxfPackage.ingestAll()
   c. Collect operational state: migrate _outbox, _mintOutbox, _invalidatedNametags to Profile per-address keys. Skip _tombstones, _sent, _history (these are DERIVED from the token pool after migration)
   d. Persist the complete new Profile to local storage (new format)

3. PERSIST TO ORBITDB
   - Open/create OrbitDB database with wallet identity
   - Write all Profile keys via db.put()
   - Pin UXF CAR file to IPFS → record CID via db.put('tokens.bundle.' + cid, ref)
   - Wait for OrbitDB local persistence (OpLog committed to IPFS blockstore)

4. SANITY CHECK (mandatory — blocks until complete)
   a. Read back all Profile keys from OrbitDB → compare with transformed data
   b. Fetch UXF CAR from IPFS by CID → UxfPackage.fromCar()
   c. For each migrated token:
      - Verify tokenId exists in the UXF bundle
      - Verify transaction count matches the original TXF token
      - Verify the current state hash matches (fast check via SHA-256 of predicate + data)
   d. For operational state: verify history entry count, conversation count,
      and pending transfer IDs match
   e. If ANY check fails: abort migration, keep legacy data, log error, continue
      with legacy storage (no data loss)

5. CLEANUP (only after step 4 passes completely)
   a. Remove all legacy-formatted user data from local storage
      (old IndexedDB entries, old file-based storage).
      Note: the `SphereVestingCacheV5` IndexedDB database is NOT deleted during
      cleanup — it is a standalone cache unrelated to the Profile migration.
      It will be regenerated naturally by the VestingClassifier.
   b. Unpin the last known CID from `sphere_ipfs_cid_{ipnsName}` (the only tracked
      CID). Previous CIDs are not tracked and will be garbage collected by the IPFS
      pinning service's retention policy.
   c. The old IPNS name is no longer published to

6. DONE — Profile is the sole storage layer from this point forward
```

**Recovery from interrupted migration:** Track migration state via a local-only key `migration.phase` (values: 'syncing', 'transforming', 'persisting', 'verifying', 'cleaning', 'complete'). On restart, resume from the last completed phase. If `migration.phase = 'verifying'` and OrbitDB profile exists, re-run steps 4 and 5 only.

**Idempotency:** If migration is interrupted (app crash, network failure), it resumes from the last completed phase on next launch. The presence of an OrbitDB profile (step 4 passed previously) skips re-migration.

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

The `profile: true` option enables the OrbitDB/IPFS persistence model. Without it, the existing local-only behavior is preserved.

**Note on Sphere app:** The Sphere web app currently uses `WalletRepository` with raw `localStorage` — a separate, unsynchronized storage layer. Migrating the app to use `ProfileStorageProvider` is a separate follow-up task (app-level change, not SDK change). The SDK provides the `ProfileStorageProvider`; the app migration is documented but not blocked on.

---

## 9. Security Considerations

### 9.1 Storage Model: Unencrypted Elements, Encrypted Manifests

UXF element blocks on IPFS are stored **unencrypted** (plaintext). This is a deliberate design choice that enables **cross-user deduplication** — the core value proposition of UXF.

```
IPFS (public, content-addressed, cross-user dedup):
  element[hash_A] — unicity certificate (shared by N users, stored ONCE)
  element[hash_B] — authenticator
  element[hash_C] — SMT path
  element[hash_D] — nametag token sub-DAG
  ...

OrbitDB (private, per-user, encrypted):
  tokens.bundle.{CID} — encrypted bundle reference (CID, status, device)
  (transactionHistory is DERIVED from token pool, not stored)
  {addr}.messages — encrypted (DM content)
  identity.mnemonic — password-encrypted (private keys)
  ...
```

**What is encrypted (in OrbitDB):** All profile KV values — identity, bundle references (which CIDs belong to this user), messages, operational state. These reveal **which** bundles a user owns, **who** they transacted with, and **what** messages they exchanged. Note: the bundle manifests inside the CAR files on IPFS are unencrypted (they list tokenId→hash mappings but without user context this reveals nothing about ownership). Encrypted with `profileEncryptionKey = HKDF(masterKey, "uxf-profile-encryption", 32)` using AES-256-GCM with random IV.

**What is NOT encrypted (on IPFS):** Individual UXF element blocks — token genesis data, state transitions, inclusion proofs, unicity certificates, predicates, authenticators, SMT paths. These are **cryptographic proof materials**, not secrets.

### 9.2 Why Token Elements Are Not Secrets (Privacy Analysis)

A common security concern is: "if token data is public on IPFS, can someone steal funds?" The answer is **no**, and here is why:

**Token elements are cryptographic proofs, not authorization credentials.** To perform a state transition (transfer a token), an attacker needs the **private key** corresponding to the token's current predicate. The token elements on IPFS contain:

| Element | Contains | Can an observer steal funds? | Can an observer learn anything? |
|---------|----------|-------|------|
| **UnicityCertificate** | BFT validator signatures for an aggregator round | No — proves round commitment, not ownership | Which aggregator round a transition was committed in |
| **Authenticator** | Public key + signature + state hash | No — signature proves a past transition, not future authorization | The public key that authorized a past transition |
| **Predicate** | Public key, signing algorithm, nonce | No — knowing the pubkey doesn't reveal the private key | The current owner's public key (already public in Nostr binding events) |
| **SMT Path** | Merkle tree path segments | No — proves inclusion in the aggregator's tree | Position in the Sparse Merkle Tree |
| **Genesis Data** | Token ID, type, coin data, recipient address | No — address is already public | Token denomination and recipient (already visible to aggregator) |
| **Token State** | Current predicate + data | No — same as Predicate above | Current ownership state |

**The critical insight:** Unicity tokens derive their security from **private key custody**, not from data secrecy. The entire state transition chain is designed to be **publicly verifiable** — that's the point of inclusion proofs and unicity certificates. Hiding token elements behind encryption would be like encrypting a blockchain — it defeats the purpose of the transparency/verifiability model.

**What IS private and must be encrypted:**
- **Manifests** — reveal which tokens a user owns (balance disclosure)
- **Transaction history** — reveals counterparties and amounts
- **DM messages** — private communications
- **Identity keys** — mnemonic and master key (fund access)
- **Operational state** — pending transfers, outbox (reveals intent)

These are all stored in OrbitDB and encrypted with the profile key.

### 9.3 Cross-User Deduplication (Why This Matters)

By storing UXF elements unencrypted, we achieve **cross-user deduplication at the IPFS level**:

```
User A has token T (genesis + 3 transactions + proofs)
User B receives token T from A (same genesis + 3 transactions + 1 new transaction)

With encryption (broken model):
  User A: encrypt(CAR_A, key_A) → CID_X (encrypted blob, 15 KB)
  User B: encrypt(CAR_B, key_B) → CID_Y (different encrypted blob, 20 KB)
  IPFS stores: 35 KB (zero dedup — different keys produce different CIDs)

Without encryption (correct model):
  User A: UXF elements → individual IPLD blocks → CIDs based on content
  User B: UXF elements → same blocks for shared history + 1 new block
  IPFS stores: 20 KB (15 KB shared + 5 KB new — 43% saved)

At scale (1000 users, 100 tokens each, tokens passing through ~5 owners on average):
  With encryption: ~1000 × 100 × 15 KB = 1.5 GB (no dedup)
  Without encryption: ~200 × 100 × 15 KB = 300 MB (80% dedup from shared elements)
```

The unicity certificates alone (shared by all tokens in the same aggregator round) represent 25-40% of token data. With 1000 users, the same certificate is stored once instead of thousands of times.

### 9.4 Identity and Key Protection

The `identity.mnemonic` and `identity.masterKey` fields receive **two layers of protection**:

1. **Application-level password encryption** — the user's password encrypts the mnemonic via AES (consistent with existing `Sphere.init({ password })` behavior). Without the password, the mnemonic cannot be recovered even by someone with the profile encryption key.

2. **Profile-level encryption** — the password-encrypted bytes are further encrypted with `profileEncryptionKey` before storing in OrbitDB. This prevents OrbitDB replication from exposing even the password-encrypted form to peers.

### 9.5 OrbitDB Access Control

OrbitDB databases are **writable only by the wallet identity** (secp256k1 key pair). The database address is derived from the wallet's public key. Other peers:
- **Cannot write** — OrbitDB `OrbitDBAccessController` restricts writes to the owner identity
- **Can replicate** — OrbitDB's libp2p PubSub allows peers to replicate the OpLog
- **Cannot decrypt** — all values are AES-256-GCM encrypted; the `profileEncryptionKey` is derived from the mnemonic which only the wallet holder possesses

Even if a peer replicates the OrbitDB database, they see only encrypted blobs for all profile values. The only unencrypted data is on IPFS (UXF element blocks), which as analyzed in Section 9.2, contains only publicly-verifiable cryptographic proof materials.

### 9.6 DM Message Privacy

DM message content is encrypted with `profileEncryptionKey` before storing in OrbitDB. The NIP-17 gift-wrap privacy model is preserved:
- **Nostr relay** sees NIP-17 gift-wrapped (encrypted) events
- **OrbitDB/IPFS** sees AES-encrypted values
- **Only the wallet holder** can decrypt both layers

### 9.7 Threat Model Summary

| Threat | Mitigation | Residual Risk |
|--------|-----------|---------------|
| Attacker reads UXF elements on IPFS | Elements are cryptographic proofs, not secrets. Cannot steal funds without private key. | Attacker learns token structure (denomination, proof chain) — same as inspecting a public blockchain. |
| Attacker reads OrbitDB values | AES-256-GCM encryption. Key derived from mnemonic via HKDF. | None — ciphertext without key is computationally infeasible to break. |
| Attacker correlates CIDs to users | Manifests are encrypted in OrbitDB. CIDs of individual elements don't reveal ownership. | Attacker who monitors IPFS pin timing may correlate activity patterns (same as any network observer). |
| Attacker forges OrbitDB entries | OrbitDB access controller restricts writes to the wallet identity. | A compromised Helia node could present stale data (denial of service, not data theft). |
| Attacker compromises IPFS node | Token elements are public proof materials (no loss). Profile values are encrypted (no disclosure). | Storage denial — attacker could unpin data. Mitigated by multi-node pinning. |
| Attacker obtains mnemonic | Game over — full access to wallet, tokens, and profile. | Same as any wallet — mnemonic custody is the security boundary. |

---

## 10. Token Versioning, Manifest Consolidation, and Oracle Validation

### 10.1 Token DAG Versioning

A token's DAG changes with every state transition. When a new transaction is appended, the TokenRoot element gets new children (the new transaction) and therefore a new content hash. The same `tokenId` can reference **multiple DAGs** representing the token at different points in its history:

```
tokenId: aaa111...
  ├── DAG v1 (hash_R1): genesis only           ← initial mint
  ├── DAG v2 (hash_R2): genesis + 1 transfer   ← after first transfer
  └── DAG v3 (hash_R3): genesis + 2 transfers  ← after second transfer
```

All three DAGs share most elements (genesis, first proof, certificate) — only the new transaction elements and the updated TokenRoot differ. The element pool deduplicates the shared parts.

### 10.2 Two Kinds of Manifest

The term "manifest" is used in two distinct contexts that must not be confused:

#### 10.2.1 Bundle Manifest (package-level, STORED)

The **bundle manifest** is a structural artifact of the UXF/CAR package format. It lists the DAG nodes contained in a specific bundle and how they link together. This is defined in SPECIFICATION.md Section 5.4 and is ALWAYS stored inside the CAR file as part of the package envelope.

```
Bundle Manifest (inside CAR file):
  Envelope → manifest block → { tokenId_aaa: hash_R3, tokenId_bbb: hash_R1 }
```

Every standalone UXF bundle carries its bundle manifest. This makes the package **self-describing** — you can inspect a CAR file and know which tokens it contains without scanning every block. This is the SPECIFICATION's manifest, and the ARCHITECTURE's `UxfManifest` type (`Map<string, ContentHash>`).

#### 10.2.2 Token Manifest (wallet-level, DERIVED)

The **token manifest** is a Unicity-level artifact that maps tokens to their latest valid DAG versions WITH status information. It is **never stored** — it is computed client-side after loading and joining one or more bundles. It incorporates oracle validation results, chain integrity checks, conflict detection, and ownership predicates.

```typescript
interface TokenManifestEntry {
  rootHash: ContentHash;           // root of the primary (valid) DAG
  status: 'valid' | 'invalid' | 'conflicting' | 'pending';
  conflictingHeads?: ContentHash[];  // alternative DAGs for investigation
  invalidReason?: string;
}

// Token manifest: derived, never stored
Map<tokenId, TokenManifestEntry>
```

The token manifest is **derived** by:
1. Reading bundle manifests from all active UXF bundles
2. JOINing them (union, longest valid chain per tokenId, proof enrichment)
3. Running the status derivation algorithm (Section 10.6) with oracle checks
4. Cached in local storage for fast reads, rebuilt on demand

| | Bundle Manifest | Token Manifest |
|---|---|---|
| **Level** | Package/CAR structure | Wallet/Unicity semantics |
| **Stored?** | Yes (in CAR envelope) | No (derived client-side) |
| **Contents** | tokenId → rootHash (simple) | tokenId → { rootHash, status, conflicts } |
| **When created** | On `toCar()` serialization | On load/JOIN, after oracle validation |
| **Defined in** | SPECIFICATION.md Section 5.4 | PROFILE-ARCHITECTURE.md Section 10.11 |

**Key distinction:** "latest known" in a bundle manifest is NOT necessarily "latest globally." Once a token has been transferred to another user, the original holder stops receiving updates. The token manifest's `status` field (via oracle checks) reveals whether the bundle manifest's version is still current or stale.

### 10.3 UXF Minimalism Principle

**The UXF bundle must be minimalistic** — it stores only the absolute minimum information needed for full profile reconstruction. All secondary structures (transaction history, balance summaries, nametag lookups, etc.) are **derived on the fly** from the token pool and cached in local storage.

**What UXF stores:**
- Token DAGs (the cryptographic proof materials)
- Manifest (tokenId → root hash mapping)

**What UXF does NOT store (derived instead):**
- Transaction history — scanned from token ownership chain predicates
- Balance summaries — computed from owned token coin data
- Nametag lookup tables — extracted from nametag-type tokens
- Invoice listings — extracted from invoice-type tokens
- Tombstones — derived from oracle spent-checks

If a token was sent to an unknown destination (no sync), the transaction history entry simply records "destination: unknown" — derived from the fact that the current predicate doesn't match us and no destination data is available.

### 10.3.1 Token Inventory Cleanup

Not all tokens in the pool belong to the user or serve a purpose. A cleanup method should remove unnecessary tokens:

- Tokens **not currently owned** AND **not a nametag** AND **not an invoice** AND **never owned** → can be removed
- Tokens flagged as **invalid/conflicting** → can be removed after investigation period
- This is a user-triggered or GC-triggered operation, not automatic

```
sphere.payments.cleanupInventory(): {
  removed: number,       // tokens removed
  kept: {
    owned: number,       // currently owned (spendable)
    nametags: number,    // nametag tokens (for PROXY resolution)
    invoices: number,    // invoice tokens (accounting)
    archived: number,    // previously owned (history)
    invalid: number,     // kept for investigation
  }
}
```

### 10.4 Multi-Bundle JOIN Operation

When multiple UXF bundles exist (from multiple devices or sync gaps), they are merged via a **JOIN** operation. This is a client-side operation — the IPFS node stores content but never performs joins.

**JOIN rules:**

1. **Manifests are UNIONED** — all tokenId entries from all bundles are combined
2. **Element pools are UNIONED** — all DAG nodes from all bundles are combined (content-hash dedup)
3. **Same tokenId in multiple bundles** — keep the longest **valid** chain:
   - Validate each chain: every transaction must have a valid inclusion proof (or be the last pending tx)
   - Longest valid chain wins (more transactions = more recent version)
   - If a longer chain is INVALID (broken proof, mismatched unicity proof), discard it and keep the shorter valid chain
   - If both chains are valid but diverge (conflicting transactions spending same state), see Section 10.7

4. **Proof and element enrichment** — during JOIN, elements from one bundle can enrich another:
   - Bundle A has token T with 3 txs but tx[2] has no inclusion proof (pending)
   - Bundle B has token T with 3 txs and tx[2] HAS the inclusion proof (finalized on another device)
   - JOIN result: token T with 3 txs, all with proofs (enriched from B)
   - Same for missing nametag sub-DAGs: if one bundle has the nametag token and the other doesn't, the JOIN includes it

5. **OrbitDB may contain multiple non-joined bundles temporarily** — this is accepted by design. JOIN happens on the client when loading. Between loads, bundles coexist independently in OrbitDB.

```
JOIN(Bundle_A, Bundle_B):
  1. Union all element pools (dedup by content hash)
  2. For each tokenId in union of manifests:
     a. If only in one bundle → take it
     b. If in both → validate both chains
        - Both valid, one longer → keep longer
        - Both valid, same length but one has more proofs → keep the enriched one
        - One valid, one invalid → keep valid
        - Both invalid → keep both, flag as conflicting
        - Divergent (conflicting txs on same state) → see Section 10.7
  3. Build consolidated manifest
  4. Export as single UXF package
```

### 10.5 Oracle Validation

**UXF stores the latest version known to the user, but this may be stale.** The only authoritative way to confirm a token is genuinely unspent is to query the **Unicity oracle** (aggregator).

#### 10.5.1 Non-Spend Check

| Oracle Response | Meaning | Token Status |
|---|---|---|
| **Non-inclusion proof** (state NOT in SMT) | This state has not been spent | **UNSPENT** — token is genuinely current |
| **Inclusion proof** (state IS in SMT) | This state was committed (spent) | **SPENT** — someone transitioned further without sync |

#### 10.5.2 Finalization (Acquiring Missing Proofs)

A transaction in the token DAG **contains all necessary information** to submit to the Unicity oracle and acquire its inclusion proof. If a transaction is pending (no proof):

1. Submit the transaction to the oracle
2. Oracle returns either:
   - **Matching inclusion proof** → transaction is finalized, token is valid
   - **Inclusion proof for a DIFFERENT transaction** on the same state → **double-spend detected** — another transaction spent this state first. Our transaction is invalid.
3. If double-spend: mark the token version with the mismatched proof as **CONFLICTING/INVALID**

#### 10.5.3 When to Query the Oracle

1. **On token load from UXF** — validate ownership claims against the oracle
2. **Before spending** — PaymentsModule already does this
3. **Periodic background validation** — `payments.validate()` checks all owned tokens
4. **During finalization** — when acquiring proofs for pending transactions

### 10.6 Token Status Derivation (Complete Algorithm)

Given the user's `pubkey` and a reassembled `ITokenJson` from UXF:

```
Step 1: CHAIN VALIDATION (local, instant)
  • Verify all inclusion proofs in the transaction chain are valid
  • Verify each transaction's proof matches the transaction (not another tx)
  • If any proof mismatches → INVALID/CONFLICTING token
  • If chain is structurally broken → INVALID

Step 2: PREDICATE CHECK (local, instant)
  • Decode current state predicate → extract owner pubkey
  • If owner === userPubkey → potentially OWNED (proceed to Step 3)
  • If owner !== userPubkey → NOT CURRENT OWNER
    - Scan all transaction predicates for userPubkey
    - If found → PREVIOUSLY OWNED (sent away)
    - If not found → check token type:
      · Nametag type → REFERENCE (for PROXY resolution)
      · Invoice type → REFERENCE INVOICE
      · Other → UNRELATED (candidate for cleanup)

Step 3: FINALIZATION CHECK (local + network)
  • If last transaction has inclusionProof → FINALIZED
  • If last transaction has NO proof:
    a. Submit transaction to oracle
    b. Oracle returns matching proof → FINALIZED (proof acquired)
    c. Oracle returns mismatched proof → DOUBLE-SPEND DETECTED
       - Mark as CONFLICTING/INVALID
       - Store the mismatched proof in the token DAG for investigation
       - Do NOT count toward balances
    d. Oracle returns non-inclusion → transaction not yet committed
       - Mark as PENDING (retry later)

Step 4: ORACLE SPEND CHECK (network, async — only for finalized owned tokens)
  • Compute RequestId from (pubkey, stateHash) for the current state
  • Query Unicity oracle for non-inclusion proof
  • Non-inclusion proof → CONFIRMED UNSPENT, SPENDABLE
  • Inclusion proof → SPENT TO UNKNOWN DESTINATION
    - Keep in manifest (for history), flag as spent-unknown
    - When sync delivers the new state → update DAG

Step 5: TYPE CLASSIFICATION (local, instant)
  • tokenType === f8aa1383...7509 → NAMETAG
  • tokenType matches invoice pattern → INVOICE
  • Otherwise → FUNGIBLE
```

### 10.7 Conflicting Token Versions

The same token can exist in two conflicting versions when two different transactions attempt to spend the same state (double-spend scenario, or two unsynced Sphere instances creating different transactions):

```
Token T at state S2:
  Version A: S2 → tx_A → S3a (sends to Alice)
  Version B: S2 → tx_B → S3b (sends to Bob)
```

**Resolution:**

1. **One has a valid unicity proof, the other doesn't** → the proven one wins. The unicity proof is the authoritative record of which transaction was committed.

2. **Neither has a proof yet** → try to finalize both:
   - Submit tx_A to oracle → if accepted (non-inclusion for S2 means no prior spend), tx_A wins
   - If tx_A's finalization returns a proof for tx_B → tx_B was committed first, tx_A is invalid
   - **Prioritize the transaction that sends to OUR address** — if one version spends into our wallet, attempt to finalize that one first

3. **Both claimed to have proofs** → verify both proofs:
   - Only one can be valid for a given state (unicity guarantee)
   - The one with a valid proof matching its transaction is correct
   - The other's proof is either forged or for a different transaction → INVALID

**Storage of conflicting versions:**

Both versions are kept in the UXF pool for investigation. The manifest can reference both:

```
manifest:
  tokenId_x → {
    primary: hash_R3a,          // the valid/finalized version
    conflicting: [hash_R3b],    // alternative version(s) for investigation
    status: 'conflict-resolved' // or 'conflict-pending'
  }
```

Invalid tokens:
- Do NOT count toward coin balances
- Are visible in a special "conflicts" view for investigation
- Can be removed by `cleanupInventory()` after investigation

### 10.8 Profile Version History and Rogue Instance Protection

OrbitDB's Merkle-CRDT OpLog is **append-only** — every write creates a new OpLog entry without destroying previous state. This provides inherent version history:

- Every profile state is recoverable by replaying the OpLog to a specific point
- A rogue Sphere instance that corrupts data creates new OpLog entries but doesn't destroy old ones
- Rolling back to a previous state: replay OpLog up to the last known-good entry

**Rogue instance mitigation:**

1. **Detection:** When joining bundles, validate all token chains. If a bundle contains invalid chains (broken proofs, mismatched unicity proofs), flag it as potentially rogue.

2. **Isolation:** A rogue bundle's tokens are not merged into the primary manifest. They are quarantined in a `conflicting` list.

3. **Recovery:** Since OrbitDB preserves the complete OpLog, a recovery tool can:
   - List all bundle CIDs ever written (from OpLog history)
   - Identify the last known-good bundle set
   - Rebuild the manifest from the good bundles only
   - The rogue bundle's elements remain on IPFS (no unpinning) but are excluded from the active manifest

4. **Space efficiency:** Version history doesn't consume much additional IPFS space because:
   - Different profile versions reference overlapping DAGs
   - Only changed elements produce new blocks
   - OrbitDB OpLog entries are small (key + encrypted value reference)
   - The actual token elements are shared across versions via content-hash dedup

### 10.9 Load Pipeline from UXF to TXF

```
UxfPackage (after JOIN of all active bundles)
    │
    ▼
assembleAll() → Map<tokenId, ITokenJson>
    │
    ▼
For each token: derive status (Steps 1-5 above)
    │
    ├── OWNED + UNSPENT + CONFIRMED   → TXF: _<tokenId> (active, spendable)
    ├── OWNED + UNSPENT + PENDING     → TXF: _<tokenId> (status=submitted)
    ├── OWNED + SPENT TO UNKNOWN      → TXF: archived-<tokenId>
    ├── PREVIOUSLY OWNED (sent away)  → TXF: archived-<tokenId>
    ├── MY NAMETAG (owned)            → TXF: _<tokenId> + _nametags entry
    ├── MY INVOICE (owned)            → TXF: _<tokenId> (accounting module)
    ├── REFERENCE NAMETAG (not mine)  → memory only (for PROXY resolution)
    ├── REFERENCE INVOICE (not mine)  → memory only (accounting reference)
    ├── UNRELATED (not mine, not ref) → kept in pool, candidate for cleanup
    ├── CONFLICTING/INVALID           → flagged, NOT in balances, for investigation
    └── INVALID CHAIN                 → flagged, NOT in balances, for investigation

Transaction history: DERIVED from token ownership chain scanning
  • For each token where user was ever an owner:
    - Extract transfer records from the transaction chain
    - Source/destination from predicate pubkeys
    - Amounts from coin data
    - Timestamps from proof inclusion records
    - Destination "unknown" when current predicate is not ours and no sync data
  • Cache in local storage, rebuild on demand
```

### 10.10 Dual-Purpose UXF: Storage and Exchange

UXF serves two distinct purposes with the same format but different scope:

#### 10.10.1 Purpose 1: Profile Storage (replacing IPFS sync)

UXF replaces the legacy TXF-over-IPFS storage with a streamlined approach:

**Saving user profile to IPFS:**
```
Sphere SDK (TXF in memory)
    │
    ▼
SMART FILTER: what goes into UXF vs what is skipped
    │
    ├── INCLUDE in UXF bundle:
    │   • All token DAGs (owned, nametags, invoices, archived, references)
    │   • Token elements (genesis, transactions, proofs, predicates, certs)
    │
    ├── STORE in OrbitDB (encrypted, not in UXF):
    │   • Identity keys, addresses, nametag name mappings
    │   • DM messages, conversations, group chat data
    │   • Outbox, pending transfers, swap state
    │   • Accounting settings (auto-return, frozen balances)
    │
    └── SKIP entirely (local cache, regenerated from APIs):
        • Price cache, token registry cache
        • Other users' nametag resolution cache
        • Transaction history (derived from token pool)
        • Tombstones (derived from oracle checks)
        • Balance summaries (derived from owned tokens)

Result: UXF bundle = pure element pool (bag of DAG nodes)
Pin to IPFS → get CID → store CID in OrbitDB tokens.bundle.{CID}
```

**Recovering user profile from IPFS:**
```
OrbitDB tokens.bundle.{CID} keys → list of UXF bundle CIDs
    │
    ▼
Fetch each CID from IPFS → UXF element pools
    │
    ▼
JOIN all bundles → single merged element pool
    │
    ▼
Reconstruct manifest (scan pool for TokenRoot elements)
    │
    ▼
For each token: derive status (Section 10.6)
    │
    ▼
Populate TXF structures:
    ├── Active tokens → _<tokenId> (spendable)
    ├── Archived tokens → archived-<tokenId>
    ├── Nametag tokens → _nametags + PROXY resolution cache
    ├── Invoice tokens → accounting module
    ├── Reference tokens → memory cache
    └── Invalid tokens → flagged for investigation

Rebuild derived structures → cache locally:
    ├── Transaction history (scan ownership predicates)
    ├── Balances (sum owned token coinData)
    ├── Tombstones (oracle spent-checks)
    └── Nametag/invoice lookups
```

#### 10.10.2 Purpose 2: Token Exchange (sending/receiving)

UXF bundles are used to package tokens for transfer between users. The exchange bundle contains ONLY the tokens being transferred — not the sender's entire profile.

**Sending tokens via UXF:**
```
Sender selects tokens to send
    │
    ▼
Build UXF bundle with ONLY the selected tokens:
    • The token DAGs being sent
    • Their nametag sub-DAGs (if PROXY transfer)
    • Shared elements (certs, proofs) that the tokens reference
    • NOT the sender's other tokens, history, or profile data
    │
    ▼
Two delivery options:

Option A: Send UXF as CAR over Nostr
    • UxfPackage.toCar() → CAR bytes
    • Embed CAR in Nostr TOKEN_TRANSFER event content
    • Recipient receives CAR, imports via UxfPackage.fromCar()
    • Best for: small transfers (< 256 KB, few tokens)

Option B: Pin UXF to IPFS, send CID over Nostr
    • UxfPackage.toCar() → pin to IPFS → CID
    • Send CID in Nostr TOKEN_TRANSFER event
    • Recipient fetches CAR from IPFS by CID
    • Best for: large transfers (many tokens, split operations)
```

**Receiving tokens via UXF:**
```
Receive UXF bundle (CAR bytes or CID → fetch)
    │
    ▼
UxfPackage.fromCar(carBytes)
    │
    ▼
For each token in received bundle:
    • Validate chain (all proofs correct)
    • Verify current predicate assigns ownership to us
    • Finalize if needed (submit pending tx to oracle)
    │
    ▼
Merge into our pool: UxfPackage.merge(receivedPkg)
    • Content-hash dedup: shared elements not duplicated
    • New tokens appear in our manifest
    │
    ▼
Pin updated bundle → OrbitDB → synced to other devices
```

#### 10.10.3 Archive/Export

UXF also supports archiving and exporting:

```
Export specific tokens:
    sphere.export({ tokenIds: ['aaa...', 'bbb...'] })
    → builds UXF bundle with only those tokens
    → returns CAR bytes or file

Export entire profile:
    sphere.exportProfile()
    → builds UXF bundle with ALL tokens from manifest
    → includes all token types (fungible, nametag, invoice)
    → returns CAR bytes or file
    → can be imported on another device or backed up offline

Import from archive:
    sphere.import(carBytes)
    → UxfPackage.fromCar() → validate → merge into pool
    → oracle check all imported tokens
```

#### 10.10.4 UXF Bundle Content Summary

| Use Case | Element Pool | Bundle Manifest | Token Manifest | Encrypted? | OrbitDB? |
|---|---|---|---|---|---|
| **Profile storage** | All user's tokens | Stored in CAR | Derived on load | Elements: no. Bundle ref: yes. | CID in OrbitDB |
| **Token send** | Only selected + deps | Stored in CAR | N/A (recipient derives) | No | No (via Nostr) |
| **Token receive** | Received tokens | Stored in CAR | Derived after merge | No | Merged into profile |
| **Archive/export** | Selected or all | Stored in CAR | Derived on import | Optional | No (offline file) |

In ALL cases, the UXF bundle contains the element pool plus a **bundle manifest** (the structural DAG index, per SPECIFICATION.md Section 5). The **token manifest** (wallet-level with status, conflicts, oracle validation) is always derived client-side — never stored in the bundle. No history, no caches in the bundle — proof materials plus structural index only.

#### 10.10.5 CAR Batch Transfer

UXF bundles are serialized as CARv1 files. A single CAR file transfers the **entire element pool as a batch** in one HTTP request — no per-element round trips:

**Upload (client → IPFS):**
```
POST /api/v0/dag/put
Content-Type: multipart/form-data
Body: <CAR file containing all element blocks>

IPFS node unpacks the CAR, stores each block individually.
All blocks pinned atomically. One request = entire token pool.
```

**Download (IPFS → client):**
```
GET /ipfs/{rootCID}?format=car
Accept: application/vnd.ipld.car

IPFS node traverses the DAG from the root CID,
packages all reachable blocks into a CAR file,
streams it back in a single response.
```

This is efficient for both storage saves (entire pool in one upload) and token transfers (selected tokens as a mini-CAR).

#### 10.10.6 IPFS Server-Side Validation

The IPFS Kubo node validates all submitted material and drops invalid submissions to prevent corrupted data storage:

**Level 1: Block-level validation (standard Kubo)**
- Verify each block's CID matches its content hash (reject corrupted blocks)
- Verify DAG-CBOR encoding is well-formed (reject malformed CBOR)
- Reject blocks exceeding size limits (50 MB per `dag/put`)
- Rate limit by IP (configured in nginx)

**Level 2: UXF semantic validation (Kubo plugin — future)**

The IPFS Kubo node can be extended with a **Unicity token semantic plugin** that understands UXF element structure:

| Validation | What it checks | Benefit |
|---|---|---|
| **Element type verification** | Submitted blocks are valid UXF elements with correct headers (type ID, version) | Prevents garbage data from consuming storage |
| **Hash chain integrity** | Parent elements' child references point to valid existing blocks | Prevents orphaned references |
| **Inclusion proof verification** | Unicity proofs are structurally valid (correct CBOR tags, valid SMT path) | Prevents fake proofs from polluting the pool |
| **Unicity certificate verification** | BFT signatures in certificates are valid against known validator set | Prevents forged certificates |
| **Predicate structure validation** | Predicate CBOR encodes a valid secp256k1 public key | Prevents malformed ownership claims |
| **Token chain validation** | Transaction chains are append-only, each tx's source state matches previous destination | Prevents fabricated token histories |

**Critical: Quick send mode compatibility.** The validation MUST NOT reject tokens with missing or pending inclusion proofs. Unfinalized transactions are valid submissions — the quick send flow persists tokens to IPFS *before* oracle finalization. The plugin only rejects structurally **broken** data (malformed CBOR, corrupted hashes, fabricated chains with impossible state transitions), not incomplete data (pending proofs, partial histories).

**Implementation approach:** A Kubo plugin (Go) or sidecar service that intercepts `dag/put` requests, decodes the DAG-CBOR blocks, validates UXF structure, and rejects invalid submissions before they are pinned. This is a separate infrastructure component — not part of the sphere-sdk.

**Benefits of server-side validation:**
- Reduced storage waste (trash and corrupted data never pinned)
- Cross-user data quality (all elements in the pool are structurally valid)
- Defense against malicious submissions (forged proofs, fake certificates)

**Kubo remains trustless.** The semantic plugin improves storage hygiene by filtering out garbage, but does not change the trust model. All data stored by Kubo is self-authenticated via content hashing — clients always verify independently. The plugin is a quality filter, not a trust authority.

### 10.11 Token Manifest: Status and Invalid Tokens

The **token manifest** (derived, wallet-level — see Section 10.2.2) is NOT a simple `tokenId → rootHash` map. It includes token validity status derived from oracle checks and chain validation:

```typescript
interface ManifestEntry {
  rootHash: ContentHash;           // root of the primary (valid) DAG
  status: 'valid' | 'invalid' | 'conflicting' | 'pending';
  conflictingHeads?: ContentHash[];  // alternative DAGs (for investigation/history)
  invalidReason?: string;            // why the token is invalid (if applicable)
}

// Derived manifest:
Map<tokenId, ManifestEntry>
```

**Token status in the manifest:**

| Status | Meaning | Counts in balance? | Action |
|---|---|---|---|
| `valid` | Chain validated, proofs correct | Yes (if owned + unspent) | Normal operation |
| `invalid` | Chain broken, mismatched proof, or double-spend detected | **No** | Kept for investigation, removable by GC |
| `conflicting` | Two alternative DAGs exist for same tokenId | **No** | Oracle decides winner during finalization |
| `pending` | Last transaction awaiting proof from oracle | **No** (until finalized) | Submit to oracle to finalize |

**Invalid tokens are preserved in the pool** for investigation and debugging. They are:
- Visible in a "conflicts/invalid" view in the UI
- Excluded from balance calculations
- Removable via `cleanupInventory()`
- Useful for detecting double-spend attempts, rogue instances, or sync issues

**Conflicting tokens:** When two DAG versions exist with divergent transactions spending the same state, both are kept:
```
manifest:
  tokenId_x → {
    rootHash: hash_R3a,           // the version we're trying to finalize
    status: 'conflicting',
    conflictingHeads: [hash_R3b], // the other version
  }
```

After oracle resolution (one version gets a valid proof, the other gets a mismatched proof), the winner becomes `valid` and the loser becomes `invalid`.

### 10.12 Outbox: In-Flight Transfer Tracking via CIDs

The outbox tracks UXF bundles currently being sent to recipients. Each entry references the **CID of the UXF bundle** being transferred:

```typescript
interface OutboxEntry {
  /** Unique transfer identifier */
  id: string;
  /** CID of the UXF CAR file containing the tokens being sent */
  bundleCid: string;
  /** Token IDs included in this bundle */
  tokenIds: string[];
  /** Recipient identifier (@nametag, DIRECT address, pubkey) */
  recipient: string;
  /** Delivery status */
  status: 'packaging' | 'pinned' | 'sending' | 'delivered' | 'confirmed' | 'failed';
  /** How the bundle is being delivered */
  deliveryMethod: 'car-over-nostr' | 'cid-over-nostr';
  /** Timestamps */
  createdAt: number;
  updatedAt: number;
  /** Error info if failed */
  error?: string;
  /** Retry count */
  retryCount: number;
}
```

**Outbox lifecycle:**
```
1. packaging  — building UXF bundle with selected tokens
2. pinned     — CAR pinned to IPFS, CID obtained
3. sending    — Nostr event published (CAR bytes or CID)
4. delivered  — recipient acknowledged receipt
5. confirmed  — recipient finalized tokens (oracle confirmed)
6. failed     — delivery failed (retry or abort)
```

The outbox is stored in **OrbitDB** (`{addr}.outbox`), encrypted. This allows:
- Multi-device visibility of in-flight transfers
- Retry after app crash (CID is preserved, just re-send the Nostr event)
- Tracking delivery status across devices

Once a transfer is confirmed, the outbox entry can be cleaned up. The sent tokens remain in the pool as `previously owned` (archived) with the destination derived from the transaction predicate.

---

## 11. Decided Questions

> Section numbers shifted: previous Section 10 → Section 11, previous Section 11 → Section 12.

| # | Question | Decision |
|---|----------|----------|
| 1 | Cache-only keys in OrbitDB? | **No** — prices and registry cache stay in local storage only. Regenerated from APIs, would bloat OpLog. |
| 2 | Encryption? | **Split model: encrypted manifests, unencrypted elements.** OrbitDB profile values (manifests, history, messages, identity) encrypted with `profileEncryptionKey`. UXF element blocks on IPFS stored unencrypted (plaintext) to enable cross-user content-addressed deduplication. Token elements are cryptographic proofs, not secrets — see Section 9.2 privacy analysis. |
| 3 | Migration strategy | **Silent auto-migration** with 6-step flow: sync old IPFS → transform locally → persist to OrbitDB → sanity check → cleanup legacy → done. See Section 7.6. |
| 4 | Sphere app WalletRepository | **Migrate to ProfileStorageProvider** — separate follow-up task (app-level, not SDK). SDK provides the provider; app migration documented but not blocking. |
| 5 | OrbitDB bundle size | **Accept the cost.** Replaces ~3,000 lines of custom IPFS sync code. Load via UXF/Profile entry point, lazy-load in browser if needed. |
| 6 | Offline replication | **Nostr as Phase 2 fallback.** Phase 1 uses standard libp2p PubSub + IPFS block exchange. Nostr bridge is complex (requires custom OpLog serialization, causal ordering) — deferred to Phase 2. |
| 7 | Consolidation / IPFS cleanup | **Remove from Profile only, do NOT unpin from IPFS.** Superseded bundle keys (`tokens.bundle.{CID}`) deleted after 7-day safety period (configurable, min 24h). IPFS-side GC is a separate future workstream. |
| — | OrbitDB vs raw IPLD DAG | **OrbitDB** — Merkle-CRDTs handle multi-device conflict resolution automatically. |
| — | Single CID vs multiple bundle CIDs | **Multiple CIDs** — each device writes its own bundle key. Lazy consolidation merges over time. |
| — | Phase alignment | The Profile architecture advances some Phase 2 concepts (UXF as storage backend). The UXF library itself remains Phase 1-scoped; the Profile layer handles wallet state outside the UXF package. |

---

## 12. Required SDK API Additions

The following API gaps must be addressed for proper token-type-based access to the inventory:

### 11.1 PaymentsModule: Nametag Token Access (MISSING)

The PaymentsModule has no public method for listing or extracting nametag tokens. Nametag tokens are regular tokens in the inventory with `tokenType = f8aa13834268d29355ff12183066f0cb902003629bbc5eb9ef0efbe397867509`. Currently they are accessed ad-hoc via internal `findNametagToken()` callbacks and `_nametag`/`_nametags` TXF fields.

**Required additions:**
- `payments.getNametagTokens(): Token[]` — returns all nametag tokens for the current address, filtered by tokenType from the inventory
- `payments.getNametagToken(name: string): Token | undefined` — returns the specific nametag token for a given name

These should use `UxfPackage.tokensByTokenType(NAMETAG_TOKEN_TYPE_HEX)` under the hood when Profile mode is active.

### 11.2 AccountingModule: Invoice Token Access (EXISTS)

The AccountingModule already provides comprehensive invoice access:
- `accounting.getInvoices(options?)` → `InvoiceRef[]` (listing)
- `accounting.getInvoice(invoiceId)` → `InvoiceRef | null` (single lookup)
- `accounting.getInvoiceStatus(invoiceId)` → `InvoiceStatus` with parsed `InvoiceTerms`
- `accounting.importInvoice(token)` → parses `InvoiceTerms` from `genesis.data.tokenData`
- `accounting.createInvoice(...)` → mints invoice token

No changes needed — the accounting module correctly treats invoices as tokens and extracts structured data from `tokenData`.

### 11.3 UxfPackage: Token Type Index (EXISTS)

`UxfPackage.tokensByTokenType(tokenTypeHex)` already provides the underlying index lookup. Both PaymentsModule and AccountingModule should use this when operating in Profile/UXF mode, instead of scanning TXF fields directly.

### 11.4 Token Type Constants (MISSING)

Define well-known token type constants in the SDK:
```typescript
export const TOKEN_TYPES = {
  NAMETAG: 'f8aa13834268d29355ff12183066f0cb902003629bbc5eb9ef0efbe397867509',
  INVOICE: '<invoice token type hex>',  // TBD — needs verification from AccountingModule
} as const;
```

This avoids hardcoding hex strings across the codebase.
