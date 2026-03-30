## Research Report: IPFS-Based KV Storage and Sync Solutions (2024-2025)

### 1. OrbitDB

**Current state:** OrbitDB v2.x (published as `@orbitdb/core`) is actively maintained with monthly updates through 2025. It migrated from the deprecated js-ipfs to Helia. It is funded by community donations and does not have corporate backing or a token.

**Architecture:** OrbitDB builds databases on top of an immutable, append-only OpLog using Merkle-CRDTs. Libp2p PubSub propagates operations to peers. Every write is an IPLD-encoded operation appended to the log; the current state is derived by replaying the log.

**Database types:** `events` (append-only log), `documents` (JSON indexed by key), `keyvalue`, `keyvalue-indexed` (KV backed by a LevelDB index for faster reads).

**API:**
```javascript
import { createOrbitDB } from '@orbitdb/core'
const orbitdb = await createOrbitDB({ ipfs: heliaInstance })
const db = await orbitdb.open('my-profile', { type: 'keyvalue' })
await db.put('displayName', 'Alice')
const name = await db.get('displayName')
```

**TypeScript:** No first-class TypeScript types ship with `@orbitdb/core`. Community typings exist but lag behind releases.

**Browser:** Works in browsers (Helia + libp2p in-browser). Bundle size is significant (~500KB+ gzipped with all libp2p transports).

**Consistency:** Eventually consistent via Merkle-CRDTs. Concurrent writes to the same key are resolved by OpLog merge (last-writer-wins by default). No strong consistency guarantees. Replication depends on peers being online simultaneously or using the Voyager replication service (currently in testing).

**Verdict for UXF wallet profiles:** Overly heavy for simple profile KV storage. Pulls in full Helia + libp2p stack. The CRDT machinery is valuable for multi-device sync but adds complexity. The lack of TypeScript types is a concern. Consider only if peer-to-peer real-time sync between wallet instances is a hard requirement.

---

### 2. Helia + libp2p

**What it is:** Helia is the official TypeScript IPFS implementation, replacing the deprecated js-ipfs. It is lean and modular: you compose a node from a blockstore, a datastore, and networking transports.

**Storing a JSON document:**
```typescript
import { createHelia } from 'helia'
import { json } from '@helia/json'
import { dagCbor } from '@helia/dag-cbor'

const helia = await createHelia()
const j = json(helia)
const cid = await j.add({ displayName: 'Alice', avatar: 'Qm...' })
// cid is the content-addressed identifier
const profile = await j.get(cid) // { displayName: 'Alice', ... }
```

For structured data, `@helia/dag-cbor` is more compact and IPLD-native than `@helia/json`.

**Persistent blockstore in browser:** Use `blockstore-idb` (IndexedDB-backed) for persistence across sessions. In Node.js, use `blockstore-fs` or `blockstore-level`.

**Can it be a KV store?** Not natively. Helia is a content-addressed blockstore (CID -> bytes). To build a KV store, you would store a DAG-CBOR map, get its CID, and use IPNS to point to the latest version. Each mutation creates a new CID. This is essentially what OrbitDB does, but you can do it more simply for single-writer scenarios.

**Verdict:** Good foundation for storing immutable snapshots of profile state. Not a KV store by itself. For UXF, the pattern would be: serialize profile to DAG-CBOR, store via Helia, publish CID via IPNS or a custom pointer.

---

### 3. IPNS for Mutable Pointers

**How it works:** An IPNS name is derived from a public key (ed25519 or secp256k1). The owner signs an IPNS record pointing `name -> /ipfs/CID`. Records are published to the Amino DHT or via PubSub.

**Performance (ProbeLab measurements, 2025):**
- Median DHT publish latency: ~5-10 seconds
- Median DHT resolve latency: ~11 seconds
- P95 resolve latency: >30 seconds
- Success rate: High (correct record returned even under churn with quorum of 16)

**IPNS over PubSub:** Much faster (sub-second for subscribed peers) but only works when both publisher and resolver are online and subscribed to the same topic. Falls back to DHT for cold resolution.

**TTL:** Default suggested 5 minutes (300 billion nanoseconds). Can be tuned. Lower TTL = fresher data but more DHT queries. Higher TTL = better caching but stale data risk.

**Verdict:** IPNS DHT resolution is too slow (~11s median) for wallet profile lookups in interactive contexts. Acceptable for background sync. For UXF, consider IPNS only as a fallback discovery mechanism, not as the primary lookup path. Use a faster resolution layer (like Nostr relay events, which the SDK already has) and IPNS as a backup.

---

### 4. w3name / Storacha

**w3name:** A hosted IPNS-like service by Storacha (formerly web3.storage). Creates self-certifying mutable names backed by ed25519 keypairs. Records are signed locally; the service just stores and serves them. No account or API key needed for basic use.

**API:**
```typescript
import * as Name from 'w3name'
const name = await Name.create() // generates keypair
const revision = await Name.v0(name, '/ipfs/bafyabc...')
await Name.publish(revision, name.key)
// Later:
const latest = await Name.resolve(name)
```

**Performance:** w3name's hosted endpoint resolves much faster than DHT IPNS (sub-second for cached records). But it is a centralized service -- if Storacha goes down, resolution fails.

**Storacha / w3up:** The broader storage platform. Upload CAR files, get CIDs, use UCAN-based authorization. Supports delegation (a space owner can grant upload rights to clients). Free tier available. Data stored on IPFS + Filecoin.

**Verdict:** w3name is a pragmatic choice if you want fast mutable pointers without running DHT infrastructure. The centralization trade-off is acceptable for non-critical metadata (profile display name, avatar CID). For UXF, w3name could serve as the "fast path" for profile CID resolution, with DHT IPNS as backup.

---

### 5. CAR Files as Local Cache

**CARv1:** A streaming archive of IPLD blocks. Header contains root CIDs, followed by length-prefixed (CID, bytes) pairs. Sequential access only.

**CARv2:** Wraps CARv1 with a fixed 40-byte header (characteristics bitfield, data offset/size, index offset/size) and an appended index. The index maps CID to byte offset in the CARv1 payload, enabling random access by CID.

**Index types:** `IndexSorted` (sorted CID multihash digests + offsets), `MultihashIndexSorted`. Both support binary search for O(log n) lookups.

**TypeScript implementation:** `@ipld/car` (v5.4.2, Apache-2.0/MIT). `CarReader` for streaming, `CarIndexedReader` for random-access reads after a full scan to build an in-memory index. Works in browsers (async iterables) but some raw-file operations are Node.js only.

**As a local cache:** A CARv2 file is an excellent format for a local IPLD block cache:
- Content-addressed: blocks are deduplicated by CID
- Self-contained: no external dependencies
- Random access via index: fetch any block by CID in O(log n)
- Portable: can be synced, backed up, or transferred as a single file

**Limitations:**
- CARv2 is append-friendly but not easily mutable (deleting blocks requires rewriting)
- The JS `CarIndexedReader` builds an in-memory index on open (scan cost proportional to file size)
- No built-in compaction; deleted/superseded blocks remain until archive is rebuilt
- Browser storage: must store the CAR bytes in IndexedDB or OPFS (see section 7)

**Verdict:** CAR files are the recommended transport and cache format for UXF token pools. Use CARv2 for the on-disk/local representation. For small profiles (<1MB), the full-scan index cost is negligible. For larger token pools, consider pre-built indexes.

---

### 6. Existing Patterns for Wallet/User State on IPFS

**WNFS (WebNative File System):**
- Rust implementation compiled to WASM, actively developed (rs-wnfs, last updated Sep 2025)
- Two-layer encryption: private HAMT with XChaCha20-Poly1305, skip ratchets for temporal access control
- Versioned via content-addressing; each mutation produces a new root CID
- Conflict resolution: multivalue buckets in HAMT (all conflicting versions kept; app resolves)
- Designed for user-owned data; keys never leave the client
- **Applicable pattern for UXF:** The skip-ratchet key derivation (forward secrecy without backward access) is relevant for shared wallet profiles where you want to revoke past access. The HAMT structure for organizing private data by encrypted labels is elegant.

**Ceramic Network / ComposeDB:**
- **Deprecated.** 3Box Labs merged with Textile in 2024. ComposeDB and js-ceramic are no longer maintained.
- ceramic-one (Rust) continues as infrastructure but the developer-facing SDK layer is gone.
- **Do not build on Ceramic for new projects.**

**Textile (Threads/Buckets):**
- Original Textile Threads are deprecated. The company now focuses on Tableland (SQL on-chain) and Basin (data streaming).
- Not suitable for new IPFS-based storage projects.

**State of the art (2025):** The space has consolidated. WNFS is the most sophisticated user-owned-data-on-IPFS system still actively developed. For simpler use cases, the pattern is: DAG-CBOR serialization -> CAR packaging -> upload to Storacha/pin service -> IPNS/w3name pointer.

---

### 7. Browser Storage Options

| Storage | Capacity | Persistence | Random Access | Best For |
|---------|----------|-------------|---------------|----------|
| **IndexedDB** | Up to 10% of disk (Firefox), 60%+ (Chrome, dynamic) | Best-effort (evictable); use `navigator.storage.persist()` for durability | Yes (by key) | Structured KV data, token metadata |
| **OPFS** | Same quota pool as IndexedDB | Same eviction rules | Yes (sync access handles in Workers) | Large binary blobs, CAR files, SQLite WASM |
| **Cache API** | Same quota pool | Same eviction rules | By URL key only | HTTP response caching, not ideal for arbitrary data |
| **SQLite WASM + OPFS** | Same quota | Same | Full SQL | Complex queries, relational data |

**Key findings:**
- OPFS with `SyncAccessHandle` (in a Web Worker) is the best option for storing CAR files in the browser. It provides synchronous read/write without SharedArrayBuffer workarounds (since SQLite 3.43's opfs-sahpool VFS).
- IndexedDB is better for structured KV lookups (token metadata, profile fields).
- `navigator.storage.persist()` should always be called to prevent eviction of wallet data.
- Chromium grants persistent storage automatically to installed PWAs and sites with high engagement scores.

**Recommendation for UXF:**
- **Profile KV data** (nametag, display name, settings): IndexedDB (already used by sphere-sdk)
- **CAR file cache** (token pool blocks): OPFS in a Web Worker for best performance, with IndexedDB fallback for older browsers
- **SQLite WASM + OPFS**: Overkill unless you need relational queries over token data

---

### 8. Node.js Storage Options

| Engine | Read perf | Write perf | ACID | Size | Notes |
|--------|-----------|------------|------|------|-------|
| **lmdb-js** | ~1.9M ops/sec single-thread | ~500K puts/sec | Yes (MVCC) | ~5MB native | Memory-mapped, crash-safe, zero-copy reads, V8 fast-api integration. Best read performance. |
| **better-sqlite3** | ~314K row reads/sec | Varies by batch | Yes | ~3MB native | Full SQL, WAL mode, synchronous API. Best for complex queries. |
| **classic-level** (LevelDB) | Good | Good (LSM) | No | ~2MB native | Simple KV, sorted keys, range scans. Used by Helia internals. |

**Recommendation for UXF Node.js:**
- **lmdb-js** is the best fit for a profile KV store. It is the fastest for the read-heavy pattern of wallet lookups, supports structured JS values natively (MessagePack encoding built in), is fully ACID, and handles concurrent access across threads/processes. No schema overhead.
- **better-sqlite3** if you ever need SQL queries or want to store the profile alongside relational data (transaction history, etc.).
- **classic-level** if you want minimal dependencies and are already in the Helia/IPFS ecosystem (it is what Helia uses internally).

---

### 9. Sync Patterns

**Recommended architecture for UXF profile sync:**

1. **Single-writer model:** Each wallet identity owns its profile. Only the private key holder can update it. This eliminates multi-writer conflict resolution.

2. **Optimistic local-first writes:**
   - Mutate profile locally (IndexedDB/LMDB)
   - Serialize to DAG-CBOR, package as CAR
   - Upload CAR to IPFS (Storacha/pin service)
   - Publish new CID via IPNS/w3name
   - Background: no blocking on network

3. **Pull-based sync (other devices / readers):**
   - Resolve IPNS name -> get latest CID
   - Fetch CAR from IPFS gateway/trustless gateway
   - Verify blocks (content-addressed, self-authenticating)
   - Merge into local cache (CID-based dedup: if block already present, skip)

4. **Conflict resolution (multi-device same-owner):**
   - Since IPNS records have sequence numbers, the highest sequence wins
   - For concurrent edits from two devices: last-write-wins on the IPNS record level
   - For finer granularity: embed a logical clock or vector clock in the profile DAG, merge field-by-field
   - Simplest approach: treat the profile as a single atomic document; last publish wins

5. **Versioning:**
   - Each profile version is a distinct CID (immutable)
   - Previous versions remain retrievable if pinned
   - The IPNS record acts as a "HEAD pointer" to the latest version

**Applicable CRDT patterns:**
- For simple KV profiles: LWW-Register per field (timestamp + value) is sufficient
- For token pools: OR-Set (observed-remove set) for token membership
- For append-only data (transaction history): G-Set (grow-only set)

---

### 10. Lazy Loading from IPFS

**Individual block fetching:** Yes, IPFS supports fetching individual IPLD blocks by CID. The trustless gateway spec supports `application/vnd.ipld.raw` (single block) and `application/vnd.ipld.car` (DAG as CAR).

**Gateway pattern:**
```
GET https://trustless-gateway.link/ipfs/{cid}?format=raw
```
Returns the raw block bytes. The client verifies the CID matches the hash of the received bytes.

**Latency (2025):**
- CDN-cached block: 50-200ms (via gateways like `trustless-gateway.link`, `dweb.link`)
- Uncached, DHT discovery required: 2-10 seconds (content routing + retrieval)
- Edge-cached via dedicated gateway: <100ms

**@helia/verified-fetch:** A fetch()-like API for browsers that retrieves and verifies IPFS content from trustless gateways. Supports WebSocket and WebRTC Bitswap for direct provider retrieval, falls back to HTTP gateways.

```typescript
import { verifiedFetch } from '@helia/verified-fetch'
const response = await verifiedFetch('ipfs://bafyabc...')
const data = await response.json()
```

**Partial CAR retrieval (IPIP-0402):** Trustless gateways can serve partial CARs for byte ranges or directory listings, reducing round trips.

**Recommendation for UXF:** Design the profile DAG with lazy loading in mind:
- Root node contains metadata + CID links to sub-trees (tokens, history, settings)
- Fetch root first (small, fast)
- Fetch sub-trees on demand as the UI needs them
- Cache fetched blocks locally in a CARv2 file or IndexedDB blockstore
- Example structure:
  ```
  root (DAG-CBOR, ~500 bytes)
  ├── /meta    -> CID (profile metadata: nametag, display name)
  ├── /tokens  -> CID (HAMT of token pool)
  ├── /history -> CID (append-only log of transfers)
  └── /certs   -> CID (shared unicity certificates)
  ```
- Fetching `/meta` alone is one HTTP request (~200ms cached). The full token pool is only fetched when the payments view opens.

---

## Concrete Recommendations for UXF Profile Design

1. **Serialization:** Use DAG-CBOR for all profile data. It is IPLD-native, compact, and schema-evolvable. Avoid JSON-in-IPFS (wastes space, no IPLD linking).

2. **Packaging:** CARv2 files as the canonical exchange format for UXF token pools. Include a block-level index for random access. Use `@ipld/car` for TypeScript read/write.

3. **Mutable pointer:** Use w3name (Storacha) for fast profile CID resolution (sub-second). Publish to DHT IPNS as a fallback. The sphere-sdk's existing Nostr relay infrastructure can also serve as a resolution layer (publish `profile_cid` in a Nostr event, resolve via relay query -- fastest option, already deployed).

4. **Browser storage:** IndexedDB for profile KV fields via `IndexedDBStorageProvider` (already in sphere-sdk). OPFS (Web Worker + SyncAccessHandle) for CAR file cache of the full token pool. Call `navigator.storage.persist()`.

5. **Node.js storage:** lmdb-js for the profile KV store (fastest reads, ACID, native structured data). File system for CAR file cache.

6. **Sync:** Single-writer, local-first. Write locally, serialize to DAG-CBOR + CAR, upload to Storacha (UCAN-authorized), update w3name pointer. Readers resolve pointer, fetch CAR, verify blocks, merge into local blockstore.

7. **Lazy loading:** Structure the profile DAG as a shallow tree with CID links. Fetch root + metadata eagerly (<1KB). Fetch token pool, history, and certificates on demand. Use `@helia/verified-fetch` or direct trustless gateway HTTP calls.

8. **Skip OrbitDB** unless multi-writer real-time collaboration is required. The CRDT OpLog adds significant complexity and bundle size for a single-writer wallet profile.

9. **Skip Ceramic/Textile** -- both are deprecated/pivoted.

10. **Consider WNFS patterns** (skip ratchets, encrypted HAMT) if profile encryption and temporal access control become requirements. The Rust/WASM implementation is mature enough for production use.

Sources:
- [OrbitDB GitHub](https://github.com/orbitdb/orbitdb)
- [OrbitDB API v2.1](https://api.orbitdb.org/)
- [OrbitDB April 2025 Update](https://orbitdb.substack.com/p/what-happened-at-orbitdb-in-april)
- [Helia GitHub](https://github.com/ipfs/helia)
- [Helia 101 Examples](https://github.com/ipfs-examples/helia-101)
- [IPNS Docs](https://docs.ipfs.tech/concepts/ipns/)
- [IPNS Performance on Amino DHT (ProbeLab)](https://www.probelab.network/blog/ipns-performance-amino-dht)
- [IPNS over PubSub Discussion](https://discuss.libp2p.io/t/how-is-ipns-over-pubsub-faster-than-dht/1722)
- [w3name GitHub (Storacha)](https://github.com/storacha/w3name)
- [w3name Documentation](https://docs.storacha.network/how-to/w3name/)
- [Storacha w3up Protocol](https://github.com/storacha/w3up)
- [CARv2 Specification](https://ipld.io/specs/transport/car/carv2/)
- [@ipld/car npm](https://www.npmjs.com/package/@ipld/car)
- [WNFS Private Spec](https://github.com/wnfs-wg/spec/blob/main/spec/private-wnfs.md)
- [WNFS Rust Crate](https://lib.rs/crates/wnfs)
- [Ceramic FAQ](https://blog.ceramic.network/faq-ceramic-network/)
- [MDN Storage Quotas](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- [MDN OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
- [SQLite WASM + OPFS (Chrome)](https://developer.chrome.com/blog/sqlite-wasm-in-the-browser-backed-by-the-origin-private-file-system)
- [SQLite WASM Persistence State (Nov 2025)](https://www.powersync.com/blog/sqlite-persistence-on-the-web)
- [RxDB Browser Storage Comparison](https://rxdb.info/articles/localstorage-indexeddb-cookies-opfs-sqlite-wasm.html)
- [lmdb-js GitHub](https://github.com/kriszyp/lmdb-js)
- [better-sqlite3 GitHub](https://github.com/WiseLibs/better-sqlite3)
- [@helia/verified-fetch](https://blog.ipfs.tech/verified-fetch/)
- [Trustless Gateway Spec](https://specs.ipfs.tech/http-gateways/trustless-gateway/)
- [IPIP-0402 Partial CAR Support](https://specs.ipfs.tech/ipips/ipip-0402/)
- [Shipyard 2025 IPFS Year in Review](https://ipshipyard.com/blog/2025-shipyard-ipfs-year-in-review/)
