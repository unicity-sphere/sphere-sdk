# Sphere-SDK Storage Layer -- Complete Inventory

## Architecture Overview

The SDK has a **two-tier** storage architecture:

1. **`StorageProvider`** (`/home/vrogojin/uxf/storage/storage-provider.ts`) -- A simple key-value store for wallet metadata, messaging state, tracked addresses, and caches. Interface methods: `get`, `set`, `remove`, `has`, `keys`, `clear`, `saveTrackedAddresses`, `loadTrackedAddresses`, `setIdentity`.

2. **`TokenStorageProvider<TData>`** (`/home/vrogojin/uxf/storage/storage-provider.ts`) -- A structured store for token data in TXF format. Interface methods: `save`, `load`, `sync`, `exists`, `clear`, `createForAddress`, `addHistoryEntry`, `getHistoryEntries`, `hasHistoryEntry`, `clearHistory`, `importHistoryEntries`.

All keys in `StorageProvider` are prefixed with `sphere_` (constant `STORAGE_PREFIX` in `/home/vrogojin/uxf/constants.ts`).

### Platform Implementations

| Implementation | File | Backing Store |
|---|---|---|
| `IndexedDBStorageProvider` | `/home/vrogojin/uxf/impl/browser/storage/IndexedDBStorageProvider.ts` | Browser IndexedDB (`sphere-storage` DB, `kv` object store) |
| `LocalStorageProvider` | `/home/vrogojin/uxf/impl/browser/storage/LocalStorageProvider.ts` | Browser localStorage |
| `FileStorageProvider` | `/home/vrogojin/uxf/impl/nodejs/storage/FileStorageProvider.ts` | JSON file on disk (`wallet.json`) |
| `IndexedDBTokenStorageProvider` | `/home/vrogojin/uxf/impl/browser/storage/IndexedDBTokenStorageProvider.ts` | Browser IndexedDB (per-address DB: `sphere-token-storage-{addressId}`) with stores `tokens`, `meta`, `history` |
| `FileTokenStorageProvider` | `/home/vrogojin/uxf/impl/nodejs/storage/FileTokenStorageProvider.ts` | Per-address subdirectories with individual JSON files per token |
| `IpfsStorageProvider` | `/home/vrogojin/uxf/impl/shared/ipfs/ipfs-storage-provider.ts` | IPFS/IPNS (remote, cross-device sync) |

---

## Per-Address Scoping Mechanism

Defined in `/home/vrogojin/uxf/constants.ts`:

- **`getAddressId(directAddress)`** produces a key like `DIRECT_abc123_xyz789` (first 6 + last 6 chars of the direct address hash).
- **`getAddressStorageKey(addressId, key)`** produces `{addressId}_{key}`.
- Per-address KV keys in `StorageProvider` use format: `sphere_DIRECT_abc123_xyz789_{key}`.
- `TokenStorageProvider` implementations scope themselves per-address: `IndexedDBTokenStorageProvider` creates a separate IndexedDB database per address; `FileTokenStorageProvider` creates a separate directory per address; `IpfsStorageProvider` derives a separate IPNS identity per address.

---

## 1. Identity Storage (GLOBAL -- CRITICAL)

**Source:** `STORAGE_KEYS_GLOBAL` in `/home/vrogojin/uxf/constants.ts` lines 24-61.

| Storage Key | Constant | Data Shape | Notes | Approx Size |
|---|---|---|---|---|
| `sphere_mnemonic` | `MNEMONIC` | `string` (encrypted BIP39 mnemonic, 12-24 words) | AES-encrypted with user password or `DEFAULT_ENCRYPTION_KEY` | ~200-500 bytes |
| `sphere_master_key` | `MASTER_KEY` | `string` (encrypted hex private key, 64 chars) | Encrypted master private key | ~200 bytes |
| `sphere_chain_code` | `CHAIN_CODE` | `string` (hex, 64 chars) | BIP32 chain code for HD derivation | 64 bytes |
| `sphere_derivation_path` | `DERIVATION_PATH` | `string` (e.g. `m/44'/0'/0'/0/0`) | Full HD path | ~20 bytes |
| `sphere_base_path` | `BASE_PATH` | `string` (e.g. `m/44'/0'/0'`) | Base path without chain/index | ~15 bytes |
| `sphere_derivation_mode` | `DERIVATION_MODE` | `string` enum: `bip32`, `wif_hmac`, `legacy_hmac` | How child keys are derived | ~10 bytes |
| `sphere_wallet_source` | `WALLET_SOURCE` | `string` enum: `mnemonic`, `file`, `unknown` | Wallet origin | ~10 bytes |
| `sphere_wallet_exists` | `WALLET_EXISTS` | `string` (boolean flag) | Quick existence check | ~5 bytes |
| `sphere_current_address_index` | `CURRENT_ADDRESS_INDEX` | `string` (integer) | Active HD index | ~2 bytes |

**Criticality:** All CRITICAL. Loss of mnemonic/master_key = loss of funds. Cannot be regenerated.

---

## 2. Tracked Addresses (GLOBAL -- CRITICAL)

**Storage Key:** `sphere_tracked_addresses`

**Stored via:** `saveTrackedAddresses()` / `loadTrackedAddresses()` on `StorageProvider`.

**Data Shape** (serialized as JSON):
```typescript
{
  version: 1,
  addresses: TrackedAddressEntry[]
}
```
Where `TrackedAddressEntry` (from `/home/vrogojin/uxf/types/index.ts` lines 338-347):
```typescript
{
  index: number;       // HD derivation index (0, 1, 2, ...)
  hidden: boolean;     // Hidden from UI
  createdAt: number;   // ms timestamp
  updatedAt: number;   // ms timestamp
}
```

**Scope:** Global. Derived fields (`addressId`, `l1Address`, `directAddress`, `chainPubkey`, `nametag`) are computed at load time from the HD index.

**Criticality:** Important but regenerable. If lost, address index 0 is re-derived automatically. Other addresses require re-discovery.

**Approx Size:** ~100 bytes per tracked address.

---

## 3. Address Nametag Cache (GLOBAL -- CACHE)

**Storage Key:** `sphere_address_nametags`

**Data Shape** (from `/home/vrogojin/uxf/core/Sphere.ts` lines 3377-3388):
```typescript
{
  "DIRECT_abc123_xyz789": { "0": "alice", "1": "alice2" },
  "DIRECT_def456_uvw012": { "0": "bob" }
}
```
Maps `addressId` to a map of nametag-index to nametag string (an address can have multiple nametags).

**Criticality:** Cache. Nametags are recoverable from Nostr relay bindings. This is a legacy format; new wallets prefer `TRACKED_ADDRESSES` which co-locates address metadata.

**Approx Size:** ~50-200 bytes per address.

---

## 4. Token Data (PER-ADDRESS via TokenStorageProvider -- CRITICAL)

Stored through `TokenStorageProvider` (not via KV keys). The data format is **TXF (Token eXchange Format)** defined in `/home/vrogojin/uxf/types/txf.ts`.

**Complete TXF storage structure** (`TxfStorageData`, lines 195-204):

| Field | Type | Purpose |
|---|---|---|
| `_meta` | `TxfMeta` | Metadata: version, address, ipnsName, formatVersion, lastCid, deviceId |
| `_nametag` | `NametagData` | Primary nametag: `{ name, token, timestamp, format, version }` where `token` is the full nametag NFT object |
| `_nametags` | `NametagData[]` | All nametags for this address |
| `_tombstones` | `TombstoneEntry[]` | Spent token records: `{ tokenId, stateHash, timestamp }` |
| `_invalidatedNametags` | `InvalidatedNametagEntry[]` | Revoked nametags with reason |
| `_outbox` | `OutboxEntry[]` | Pending outgoing transfers: `{ id, status, sourceTokenId, salt, commitmentJson, recipientPubkey, recipientNametag, amount, createdAt, updatedAt, error, retryCount }` |
| `_mintOutbox` | `MintOutboxEntry[]` | Pending mints: `{ id, status, type, salt, requestIdHex, mintDataJson, createdAt, updatedAt, error }` |
| `_sent` | `TxfSentEntry[]` | Completed sends: `{ tokenId, recipient, txHash, sentAt }` |
| `_invalid` | `TxfInvalidEntry[]` | Invalidated tokens: `{ tokenId, reason, detectedAt }` |
| `_history` | `HistoryRecord[]` | Transaction history (synced via IPFS, max 5000 entries) |
| `_<tokenId>` | `TxfToken` | Each active token: full TXF token with genesis, state, transactions, inclusion proofs |
| `archived-<tokenId>` | `TxfToken` | Spent tokens preserved for history |
| `_forked_<tokenId>_<stateHash>` | `TxfToken` | Alternative token states (fork resolution) |

**Reserved keys** (from `/home/vrogojin/uxf/types/txf.ts` line 248): `_meta`, `_nametag`, `_nametags`, `_tombstones`, `_invalidatedNametags`, `_outbox`, `_mintOutbox`, `_sent`, `_invalid`, `_integrity`, `_history`.

**Criticality:** CRITICAL. Token data = ownership of funds. The `_outbox` and `_mintOutbox` represent in-flight operations; loss could mean funds stuck in limbo.

**Approx Size:** 2-20 KB per token (due to inclusion proofs). A wallet with 50 tokens could be 100 KB - 1 MB.

---

## 5. Transaction History (PER-ADDRESS -- IMPORTANT)

**Two storage paths:**

### 5a. Via TokenStorageProvider (in TXF `_history` field)
Synced to IPFS, capped at 5000 entries (`MAX_SYNCED_HISTORY_ENTRIES`).

### 5b. Via StorageProvider KV (per-address key)
**Key:** `sphere_{addressId}_transaction_history` (constant `STORAGE_KEYS_ADDRESS.TRANSACTION_HISTORY`)

### 5c. Via IndexedDB `history` object store
`IndexedDBTokenStorageProvider` has a dedicated `history` store with `dedupKey` as primary key.

**Data Shape** (`HistoryRecord` from `/home/vrogojin/uxf/storage/storage-provider.ts` lines 67-92):
```typescript
{
  dedupKey: string;           // Primary key, e.g. "RECEIVED_v5split_abc123"
  id: string;                 // UUID
  type: 'SENT' | 'RECEIVED' | 'SPLIT' | 'MINT';
  amount: string;
  coinId: string;
  symbol: string;
  timestamp: number;
  transferId?: string;
  tokenId?: string;
  senderPubkey?: string;
  senderAddress?: string;
  senderNametag?: string;
  recipientPubkey?: string;
  recipientAddress?: string;
  recipientNametag?: string;
  memo?: string;
  tokenIds?: Array<{ id: string; amount: string; source: 'split' | 'direct' }>;
}
```

**Criticality:** Important but regenerable from on-chain data in principle. In practice, losing history means losing human-readable send/receive records and nametag associations.

**Approx Size:** ~200-500 bytes per entry. With 5000 entries, ~1-2.5 MB.

---

## 6. DM/Communications Storage (PER-ADDRESS -- IMPORTANT)

**Source:** `/home/vrogojin/uxf/modules/communications/CommunicationsModule.ts`, constants from `/home/vrogojin/uxf/constants.ts` lines 77-79.

| Storage Key | Data Shape | Description |
|---|---|---|
| `sphere_{addressId}_conversations` | JSON: `Map<peerPubkey, DirectMessage[]>` serialized | All conversation threads |
| `sphere_{addressId}_messages` | JSON: `Map<messageId, DirectMessage>` serialized | All messages indexed by ID |

**`DirectMessage`** (from `/home/vrogojin/uxf/types/index.ts` lines 304-313):
```typescript
{
  id: string;
  senderPubkey: string;
  senderNametag?: string;
  recipientPubkey: string;
  recipientNametag?: string;
  content: string;
  timestamp: number;
  isRead: boolean;
}
```

**In-memory limits:** `maxMessages: 1000` global cap, `maxPerConversation: 200` per peer.

**Criticality:** Important. Messages are end-to-end encrypted and cannot be re-fetched from Nostr relays after relay garbage collection.

**Approx Size:** ~200 bytes per message. With 1000 messages, ~200 KB.

---

## 7. Group Chat Storage (PER-ADDRESS -- IMPORTANT)

**Source:** `/home/vrogojin/uxf/modules/groupchat/GroupChatModule.ts`, types in `/home/vrogojin/uxf/modules/groupchat/types.ts`.

| Storage Key | Data Shape | Description |
|---|---|---|
| `sphere_{addressId}_group_chat_groups` | JSON: `GroupData[]` | Joined groups |
| `sphere_{addressId}_group_chat_messages` | JSON: `Map<groupId, GroupMessageData[]>` | Messages per group |
| `sphere_{addressId}_group_chat_members` | JSON: `Map<groupId, GroupMemberData[]>` | Members per group |
| `sphere_{addressId}_group_chat_processed_events` | JSON: `string[]` (Nostr event IDs) | Dedup set |
| `sphere_group_chat_relay_url` | `string` (URL) | **GLOBAL** -- Last relay URL for stale detection |

**`GroupData`**: `{ id, relayUrl, name, description?, picture?, visibility, createdAt, updatedAt?, memberCount?, unreadCount?, lastMessageTime?, lastMessageText?, writeRestricted?, localJoinedAt? }`

**`GroupMessageData`**: `{ id?, groupId, content, timestamp, senderPubkey, senderNametag?, replyToId?, previousIds? }`

**`GroupMemberData`**: `{ pubkey, groupId, role, nametag?, joinedAt }`

**Criticality:** Messages can be re-fetched from the NIP-29 relay, but joined-groups state is important. Processed events are cache-level (dedup only).

**Approx Size:** ~100 bytes per message, ~50 bytes per member. Groups themselves ~200 bytes each.

---

## 8. Transport/Nostr State (GLOBAL -- IMPORTANT)

**Source:** `/home/vrogojin/uxf/transport/NostrTransportProvider.ts`, `/home/vrogojin/uxf/transport/MultiAddressTransportMux.ts`.

| Storage Key Pattern | Data Shape | Description |
|---|---|---|
| `sphere_last_wallet_event_ts_{pubkey16}` | `string` (unix seconds) | Last processed Nostr wallet event (token transfers, kind 4/31113/31115/31116). Keyed by first 16 hex chars of nostr pubkey. |
| `sphere_last_dm_event_ts_{pubkey16}` | `string` (unix seconds) | Last processed Nostr DM (gift-wrap, kind 1059). Same keying. |

The `TransportStorageAdapter` interface (lines 75-78 of `NostrTransportProvider.ts`) is a minimal `{ get, set }` backed by `StorageProvider`.

**Criticality:** Important. Without these timestamps, the SDK would re-process ALL historical Nostr events on reconnect, causing duplicate token imports and message floods.

**Approx Size:** ~20 bytes per pubkey (one per tracked address).

---

## 9. Pending V5 Instant Split Tokens (PER-ADDRESS -- CRITICAL)

**Storage Key:** `sphere_{addressId}_pending_v5_tokens`

**Data Shape:** JSON array of `PendingV5Finalization` objects (unconfirmed instant-split tokens awaiting finalization).

**Criticality:** CRITICAL. These represent tokens in an intermediate split state. Loss could mean funds are inaccessible until manual recovery.

**Approx Size:** ~500 bytes - 5 KB per pending split.

---

## 10. Dedup State (PER-ADDRESS -- CACHE)

| Storage Key | Data Shape | Description |
|---|---|---|
| `sphere_{addressId}_processed_split_group_ids` | JSON `string[]` | V5 split group IDs already processed (prevents re-processing same Nostr delivery) |
| `sphere_{addressId}_processed_combined_transfer_ids` | JSON `string[]` | V6 combined transfer IDs already processed |

**Criticality:** Cache. Loss causes harmless re-processing (dedup logic in token layer prevents actual duplicates).

**Approx Size:** ~64 bytes per ID. Could grow to a few KB over time.

---

## 11. Outbox/Pending Transfers (PER-ADDRESS via both KV and TXF -- CRITICAL)

| Storage Key | Data Shape |
|---|---|
| `sphere_{addressId}_pending_transfers` | JSON: pending transfer objects |
| `sphere_{addressId}_outbox` | JSON: outbox transfer objects |

Additionally, `_outbox` and `_mintOutbox` are stored inside the TXF data (see item 4).

**Criticality:** CRITICAL. Represents in-flight operations.

---

## 12. Price Cache (GLOBAL -- CACHE)

**Source:** `/home/vrogojin/uxf/price/CoinGeckoPriceProvider.ts`.

| Storage Key | Data Shape | Description |
|---|---|---|
| `sphere_price_cache` | JSON: `{ [tokenName]: TokenPrice }` where `TokenPrice = { tokenName, priceUsd, priceEur?, change24h?, timestamp }` | Cached market prices |
| `sphere_price_cache_ts` | `string` (ms epoch) | When cache was last written |

**Criticality:** Pure cache. Regenerated from CoinGecko API. Default TTL: 60 seconds in-memory, persisted for cross-reload survival.

**Approx Size:** ~100 bytes per token. Typically < 1 KB.

---

## 13. Token Registry Cache (GLOBAL -- CACHE)

**Source:** `/home/vrogojin/uxf/registry/TokenRegistry.ts`.

| Storage Key | Data Shape | Description |
|---|---|---|
| `sphere_token_registry_cache` | JSON: `TokenDefinition[]` with fields `{ network, assetKind, name, symbol?, decimals?, description, icons?, id }` | Cached token metadata from remote GitHub URL |
| `sphere_token_registry_cache_ts` | `string` (ms epoch) | When cache was last written |

**Criticality:** Pure cache. Fetched from `https://raw.githubusercontent.com/.../unicity-ids.testnet.json`. Refresh interval: 1 hour.

**Approx Size:** ~500 bytes per token definition. With ~20 tokens, ~10 KB.

---

## 14. IPFS/IPNS State (GLOBAL, per IPNS name -- IMPORTANT)

**Source:** `/home/vrogojin/uxf/impl/nodejs/ipfs/nodejs-ipfs-state-persistence.ts`, `/home/vrogojin/uxf/impl/shared/ipfs/ipfs-types.ts`.

Persisted via `IpfsStatePersistence` interface. The Node.js implementation stores in the KV `StorageProvider`:

| Storage Key Pattern | Data Shape | Description |
|---|---|---|
| `sphere_ipfs_seq_{ipnsName}` | `string` (bigint as string) | IPNS sequence number |
| `sphere_ipfs_cid_{ipnsName}` | `string` (CID) | Last known IPFS content identifier |
| `sphere_ipfs_ver_{ipnsName}` | `string` (integer) | Data version counter |

The `IpfsPersistedState` type (from `/home/vrogojin/uxf/impl/shared/ipfs/ipfs-types.ts` lines 149-156):
```typescript
{
  sequenceNumber: string;  // bigint as string
  lastCid: string | null;
  version: number;
}
```

Additionally, `IpfsStorageProvider` (line 52-55) tracks in memory: `ipnsName`, `ipnsSequenceNumber`, `lastCid`, `lastKnownRemoteSequence`, `dataVersion`, `remoteCid`.

**Criticality:** Important. Without sequence numbers, the SDK cannot publish valid IPNS updates (sequence must be monotonically increasing). Loss could temporarily prevent IPFS sync until the remote state is re-resolved.

**Approx Size:** ~100 bytes per IPNS name (one per tracked address).

---

## 15. L1 (ALPHA) Vesting Cache (BROWSER-ONLY -- CACHE)

**Source:** `/home/vrogojin/uxf/l1/vesting.ts`.

| Storage | Backing | Data Shape |
|---|---|---|
| IndexedDB: `SphereVestingCacheV5` database, `vestingCache` object store | Browser IndexedDB (separate from SDK's main storage) | `{ txHash: string, blockHeight: number | null, isCoinbase: boolean, inputTxId: string | null }` per transaction |

**Not** stored via `StorageProvider`. This is a standalone IndexedDB database used directly by the `VestingClassifier` class. Falls back to in-memory-only on Node.js.

The `VestingStateManager` (`/home/vrogojin/uxf/l1/vestingState.ts`) holds `AddressVestingCache` in memory only (not persisted):
```typescript
{
  classifiedUtxos: { vested: ClassifiedUTXO[], unvested: ClassifiedUTXO[], all: ClassifiedUTXO[] },
  vestingBalances: { vested: bigint, unvested: bigint, all: bigint }
}
```

**Note:** L1 balance (`L1Balance`) is NOT persisted -- it is queried live from the Fulcrum electrum server.

**Criticality:** Pure cache. Regenerated by re-tracing UTXOs to coinbase origins.

**Approx Size:** ~100 bytes per traced transaction. Can grow to several MB for wallets with many UTXOs.

---

## 16. Connect Protocol State (IN-MEMORY ONLY -- EPHEMERAL)

**Source:** `/home/vrogojin/uxf/connect/host/ConnectHost.ts`, `/home/vrogojin/uxf/connect/types.ts`.

The `ConnectHost` class holds session state **in memory only**:
```typescript
private session: ConnectSession | null;
private grantedPermissions: Set<string>;
```

`ConnectSession` shape:
```typescript
{
  id: string;
  dapp: DAppMetadata;       // { name, origin, icon? }
  permissions: PermissionScope[];
  createdAt: number;
  expiresAt: number;
  active: boolean;
}
```

The client can pass `resumeSessionId` to attempt session resumption, but the host does NOT persist sessions to storage. Default TTL: 24 hours, then expired.

**Criticality:** Ephemeral. Not persisted. Sessions are re-established on page reload.

**Approx Size:** N/A (memory only).

---

## 17. Nametag Storage (PER-ADDRESS via TXF -- CRITICAL)

**Source:** `/home/vrogojin/uxf/types/txf.ts` lines 117-123, `/home/vrogojin/uxf/modules/payments/PaymentsModule.ts`.

Within the TXF data (`TokenStorageProvider`):

| TXF Field | Type | Description |
|---|---|---|
| `_nametag` | `NametagData` | Primary nametag for this address |
| `_nametags` | `NametagData[]` | All nametags for this address |
| `_invalidatedNametags` | `InvalidatedNametagEntry[]` | Revoked nametags |

**`NametagData`**:
```typescript
{ name: string, token: object, timestamp: number, format: string, version: string }
```
The `token` field contains the full nametag NFT token object (TXF format) which is the on-chain proof of ownership.

**`InvalidatedNametagEntry`** extends `NametagData` with:
```typescript
{ invalidatedAt: number, invalidationReason: string }
```

The nametag cache (`sphere_address_nametags`) described in item 3 is a separate lookup table for quick access without loading full TXF data.

**Criticality:** CRITICAL. The nametag token is the proof of ownership. Nametag bindings on Nostr relays can help recovery, but the token itself is the authoritative proof.

**Approx Size:** ~5-20 KB per nametag (includes full NFT token with proofs).

---

## Summary Table

| # | Storage Area | Key Pattern | Scope | Criticality | Persisted Where |
|---|---|---|---|---|---|
| 1 | Identity (mnemonic, keys, paths) | `sphere_mnemonic`, `sphere_master_key`, etc. | Global | CRITICAL | StorageProvider KV |
| 2 | Tracked Addresses | `sphere_tracked_addresses` | Global | Important | StorageProvider KV |
| 3 | Address Nametag Cache | `sphere_address_nametags` | Global | Cache | StorageProvider KV |
| 4 | Token Data (TXF) | Per-address DB/directory/IPFS | Per-address | CRITICAL | TokenStorageProvider |
| 5 | Transaction History | `_history` in TXF + `{addr}_transaction_history` + IDB store | Per-address | Important | Both providers |
| 6 | DM Conversations | `{addr}_conversations`, `{addr}_messages` | Per-address | Important | StorageProvider KV |
| 7 | Group Chat | `{addr}_group_chat_*` (4 keys) + global `group_chat_relay_url` | Per-address + 1 global | Important | StorageProvider KV |
| 8 | Nostr Event Timestamps | `sphere_last_wallet_event_ts_{pub16}`, `sphere_last_dm_event_ts_{pub16}` | Global (per pubkey) | Important | StorageProvider KV |
| 9 | Pending V5 Tokens | `{addr}_pending_v5_tokens` | Per-address | CRITICAL | StorageProvider KV |
| 10 | Dedup IDs | `{addr}_processed_split_group_ids`, `{addr}_processed_combined_transfer_ids` | Per-address | Cache | StorageProvider KV |
| 11 | Outbox/Pending Transfers | `{addr}_pending_transfers`, `{addr}_outbox` + TXF `_outbox`/`_mintOutbox` | Per-address | CRITICAL | Both providers |
| 12 | Price Cache | `sphere_price_cache`, `sphere_price_cache_ts` | Global | Cache | StorageProvider KV |
| 13 | Token Registry Cache | `sphere_token_registry_cache`, `sphere_token_registry_cache_ts` | Global | Cache | StorageProvider KV |
| 14 | IPFS/IPNS State | `sphere_ipfs_seq_{name}`, `sphere_ipfs_cid_{name}`, `sphere_ipfs_ver_{name}` | Global (per IPNS name) | Important | StorageProvider KV |
| 15 | L1 Vesting Cache | IndexedDB `SphereVestingCacheV5` | Global | Cache | Standalone IndexedDB |
| 16 | Connect Sessions | (in-memory only) | N/A | Ephemeral | Not persisted |
| 17 | Nametag Tokens | TXF `_nametag`, `_nametags`, `_invalidatedNametags` | Per-address | CRITICAL | TokenStorageProvider |

### Total Key Count

- **Global StorageProvider keys:** 9 identity keys + 1 tracked addresses + 1 nametag cache + 1 group chat relay URL + 2 price cache + 2 registry cache + 2 nostr timestamps per address + 3 IPFS state per IPNS name = **~18 + (5 * N_addresses)** keys
- **Per-address StorageProvider keys:** 12 keys per address (from `STORAGE_KEYS_ADDRESS`)
- **TokenStorageProvider:** 1 structured TXF blob per address (containing ~10+ reserved fields + N token entries)
- **Standalone IndexedDB:** 1 vesting cache database (browser only)
