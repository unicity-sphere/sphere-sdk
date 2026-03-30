# UXF Profile: User Wallet Storage Architecture

**Status:** Draft — requires manual approval before implementation
**Date:** 2026-03-30

---

## 1. Overview

The **UXF Profile** is a key-value table that represents the complete persistent state of a Sphere user wallet. It serves as the universal storage schema for everything a wallet needs to store — identity, token inventory, transaction history, conversations, nametags, operational state, and metadata.

The Profile is designed with a clear persistence hierarchy:

```
┌─────────────────────────────────────────────────────┐
│  IPFS Layer (Source of Truth — persistent, trusted)  │
│  Profile stored as IPLD DAG, addressed via IPNS     │
│  Token inventory stored as UXF CAR                  │
├─────────────────────────────────────────────────────┤
│  Local Cache Layer (Transient — fast, untrusted)    │
│  Browser: IndexedDB / OPFS                          │
│  Node.js: SQLite / LevelDB / JSON files             │
│  Mobile: SQLite / AsyncStorage                      │
│  Serves as read cache + write-behind buffer         │
└─────────────────────────────────────────────────────┘
```

**Core principle:** IPFS is the source of truth for all critical data. Local storage is a performance cache that may be lost at any time (browser cache cleared, app reinstalled, device lost). On startup, the local cache is validated against IPFS and rehydrated if stale or missing. Critical writes are not considered durable until flushed to IPFS.

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
| `tokens.inventoryCid` | CID | IPFS | **CID of the current UXF package (CAR file) containing all tokens** |
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

### 2.3 Token Inventory Reference

The `tokens.inventoryCid` key is the bridge between the Profile and the UXF token packaging system:

```
Profile (KV table)
  └── tokens.inventoryCid: CID  ──→  UXF Package (CAR file on IPFS)
                                       ├── Envelope (metadata)
                                       ├── Manifest (tokenId → root)
                                       └── Element Pool (content-addressed DAG)
```

When tokens change (send, receive, split), the UXF package is updated, a new CAR is produced and pinned to IPFS, and the new CID is written to `tokens.inventoryCid`. This is the only field that changes frequently — most other profile keys change rarely.

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

## 3. Persistence Model: IPFS-First

### 3.1 Architecture

```
┌─────────────┐     write-behind     ┌──────────────┐     IPNS publish    ┌──────────┐
│ Application  │────────────────────→│ Local Cache   │────────────────────→│   IPFS   │
│ (Sphere SDK) │←───── read ─────────│ (IndexedDB/   │←──── IPNS resolve ──│ (Pinning │
│              │                     │  SQLite/etc)  │                     │  Service) │
└─────────────┘                     └──────────────┘                     └──────────┘
                                          │                                    ↑
                                          │        background sync             │
                                          └────────────────────────────────────┘
```

### 3.2 Write Path (Critical Operations)

When a critical operation occurs (token send, token receive, nametag registration):

1. **Write to local cache** (immediate, synchronous from caller's perspective)
2. **Queue IPFS flush** (async, debounced — 2 second window to batch writes)
3. **Flush to IPFS** (async background):
   a. Serialize affected profile keys to dag-cbor
   b. If tokens changed: build new UXF CAR, pin to IPFS, get new CID
   c. Update `tokens.inventoryCid` with new CID
   d. Serialize complete profile to dag-cbor IPLD blocks
   e. Pin profile root block to IPFS
   f. Publish new profile CID via IPNS
4. **Mark as durable** once IPFS confirms pinning

**Critical write guarantee:** The SDK's `send()`, `receive()`, and `registerNametag()` methods do NOT return success until the IPFS flush is confirmed. The caller can rely on durability.

**Non-critical writes** (price cache updates, registry cache, UI preferences) write to local cache only and are flushed lazily.

### 3.3 Read Path

1. **Read from local cache** (fast, synchronous) — if cache is warm
2. **Cache miss: resolve from IPFS** — fetch profile via IPNS, populate local cache
3. **Background validation:** periodically compare local cache's profile version with IPFS, rehydrate if stale

### 3.4 Startup Flow

```
1. Check local cache for profile
   ├── Found: load profile from cache, start operating immediately
   │   └── Background: resolve IPNS, compare with cached version
   │       ├── Same version: no action
   │       └── Newer version on IPFS: merge/replace local cache
   └── Not found (fresh install / cache cleared):
       ├── Resolve IPNS → get profile CID
       ├── Fetch profile from IPFS
       ├── Populate local cache
       └── Resume operation
```

### 3.5 Token Inventory: Lazy Loading from IPFS

The token inventory (UXF package) can be large. Local storage may not fit the entire package. The Profile supports **lazy loading**:

- `tokens.inventoryCid` points to a CAR file on IPFS
- The local cache stores a **partial CAR** containing only recently-accessed elements
- When a token is needed that isn't in the local cache:
  1. Look up the element's CID in the manifest
  2. Fetch the block from IPFS gateway by CID
  3. Cache locally for future access
- The manifest (token list + root hashes) is always fully cached locally (small, ~1-10 KB for 100 tokens)

This means a device with limited storage can operate on a 10,000-token wallet by only caching the tokens currently in use.

### 3.6 Conflict Resolution

Since the same wallet can be accessed from multiple devices, conflicts may arise:

| Conflict Type | Resolution |
|--------------|------------|
| Profile keys diverge | Last-writer-wins by `profile.updatedAt` timestamp |
| Token inventory diverge | Merge UXF packages (`UxfPackage.merge()`) — dedup by content hash |
| Messages diverge | Union of message sets (messages are append-only, dedup by ID) |
| History diverge | Union of history entries (dedup by `dedupKey`) |
| Pending transfers diverge | Union, remove confirmed entries |

---

## 4. Profile as IPLD DAG

The Profile is stored on IPFS as an IPLD DAG (not a flat JSON blob). This enables:

- **Partial updates:** changing one key doesn't require re-uploading the entire profile
- **Content deduplication:** unchanged sub-trees keep the same CIDs
- **Lazy resolution:** only fetch the keys you need

### 4.1 DAG Structure

```
Profile Root (dag-cbor block)
├── version: 1
├── updatedAt: 1711929600
├── identity: CID ──→ Identity Block (encrypted keys, derivation params)
├── addresses: CID ──→ Addresses Block (tracked addresses, nametags)
├── tokens: CID ──→ Tokens Ref Block
│   ├── inventoryCid: CID ──→ UXF Package CAR
│   ├── registryCache: CID ──→ Registry Cache Block (optional)
│   └── priceCache: CID ──→ Price Cache Block (optional)
├── transport: CID ──→ Transport State Block (event timestamps)
├── addressData: Map<addressId, CID>
│   ├── addr1: CID ──→ Address Data Block
│   │   ├── pendingTransfers: [...]
│   │   ├── outbox: [...]
│   │   ├── conversations: CID ──→ Conversations Block
│   │   ├── messages: CID ──→ Messages Block
│   │   ├── transactionHistory: CID ──→ History Block
│   │   ├── accounting: CID ──→ Accounting Block
│   │   └── swap: CID ──→ Swap Block
│   └── addr2: CID ──→ ...
└── groupchat: CID ──→ GroupChat Block
```

Each section is a separate IPLD block. When only one section changes (e.g., a new message arrives), only that section's block and the profile root need to be updated — all other blocks keep their CIDs.

### 4.2 Profile Root Block (CDDL)

```cddl
profile-root = {
  version: uint,
  updatedAt: uint,
  identity: ipld-link,
  addresses: ipld-link,
  tokens: ipld-link,
  transport: ipld-link,
  addressData: { * tstr => ipld-link },
  ? groupchat: ipld-link,
}

ipld-link = #6.42(bstr)  ; CID link (dag-cbor Tag 42)
```

### 4.3 IPNS Naming

The Profile's IPNS name is derived deterministically from the wallet's private key (same derivation as the existing `IpfsStorageProvider`):

```
IPNS name = PeerId(Ed25519PublicKey(HKDF(walletPrivateKey, "ipns-profile")))
```

Publishing the profile: `IPNS name → Profile Root CID`

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

### 5.3 Token Storage Flow (UXF Integration)

**Saving tokens (write path):**
```
PaymentsModule.save()
  → ProfileTokenStorageProvider.save(txfData)
    → Convert each TxfToken to ITokenJson (adapter)
    → UxfPackage.ingest(token) for each token
    → Handle _tombstones, _outbox, _sent as profile keys
    → UxfPackage.toCar() → pin CAR to IPFS → get CID
    → profile.set('tokens.inventoryCid', newCid)
    → Flush profile to IPFS
```

**Loading tokens (read path):**
```
PaymentsModule.load()
  → ProfileTokenStorageProvider.load()
    → cid = profile.get('tokens.inventoryCid')
    → If local CAR cache has this CID: use local
    → Else: fetch CAR from IPFS, cache locally
    → UxfPackage.fromCar(carBytes)
    → UxfPackage.assembleAll() → Map<tokenId, ITokenJson>
    → Convert each to TxfToken (adapter)
    → Build TxfStorageData from assembled tokens + profile operational keys
    → Return TxfStorageData
```

**Syncing (merge path):**
```
ProfileTokenStorageProvider.sync(localTxfData)
  → localPkg = UxfPackage from local cache
  → remoteCid = resolve IPNS → profile → tokens.inventoryCid
  → If remoteCid == localPkg CID: no changes, return
  → remotePkg = UxfPackage.fromCar(fetch(remoteCid))
  → localPkg.merge(remotePkg)
  → Return merged TxfStorageData
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
2. PaymentsModule selects tokens, performs split if needed
3. State transitions submitted to aggregator, proofs collected
4. Tokens updated in memory
5. CRITICAL WRITE:
   a. UxfPackage.ingest(updatedTokens) — update element pool
   b. UxfPackage.removeToken(spentTokenIds) — remove sent tokens
   c. UxfPackage.toCar() → pin to IPFS → new inventoryCid
   d. Update profile: {addr}.transactionHistory, {addr}.outbox
   e. Flush profile to IPFS (IPNS publish)
   f. ONLY NOW return success to caller
6. Local cache updated with new profile state
```

### 7.2 Token Receive (via Nostr)

```
1. Transport receives TOKEN_TRANSFER event from relay
2. PaymentsModule.processIncomingTransfer() validates and imports token
3. Token finalized (proof collected from aggregator)
4. CRITICAL WRITE:
   a. UxfPackage.ingest(receivedToken) — add to pool
   b. Update profile: {addr}.transactionHistory
   c. Flush to IPFS
5. Emit 'transfer:incoming' event to app
6. Local cache updated
```

### 7.3 IPFS Sync (Background)

```
1. Timer fires (every 90 seconds, or push notification via IPNS WebSocket)
2. Resolve IPNS → get remote profile CID
3. Compare with local profile CID
4. If different:
   a. Fetch remote profile blocks
   b. Merge remote token inventory with local (UxfPackage.merge)
   c. Merge operational state (union of messages, history, etc.)
   d. Update local cache
   e. Emit 'sync:completed' event
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

## 10. Open Questions for Review

1. **Should cache-only keys (prices, registry) be stored in the Profile at all, or kept entirely in local storage?** They can be regenerated from remote APIs and add bulk to the Profile.

2. **Should the Profile support selective encryption?** E.g., transaction history encrypted but token inventory not (to enable third-party verification without decryption).

3. **Should the UXF inventory CID be the profile root, or a child of it?** Making it the root simplifies the common case (token changes) but means profile metadata changes also require a new inventory CID.

4. **What's the migration strategy for existing wallets?** Should we auto-migrate on first load, or require explicit user action?

5. **OrbitDB vs raw IPLD DAG:** OrbitDB provides CRDT-based conflict resolution but adds complexity and dependencies. Raw IPLD DAG with manual merge (as proposed) is simpler but requires explicit conflict handling. Which approach?

6. **What about the Sphere app's `WalletRepository` which uses localStorage directly?** Should the app migrate to use sphere-sdk's ProfileStorageProvider, or keep its own layer?
