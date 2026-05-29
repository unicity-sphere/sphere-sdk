# Profile OpLog CID References — Design

**Status:** Draft 1 — foundation for the fat-data migration (PaymentsModule, CommunicationsModule, GroupChatModule, AccountingModule)
**Precedes:** per-module refactor commits
**Cross-refs:**
- `PROFILE-OPLOG-SCHEMA.md` — envelope format (§5 write path already accommodates CID-ref payloads)
- `PROFILE-ARCHITECTURE.md` §4.5 — OpLog growth management
- Audit findings (commit message of 40662fe and its successor)

---

## §1 Motivation

The fat-data audit identified that several module write sites store unbounded user data (pending V5 tokens with full SDK data, V5 outbox with full `TransferResult`, DM messages, group chat state, invoice ledgers) directly in the OpLog as JSON blobs. These entries routinely exceed 100 KiB and can reach multi-MB ranges for heavy wallets.

Consequences:
- OrbitDB replicates each OpLog entry AS A WHOLE UNIT over gossip. A 2 MB messages-cache entry means 2 MB gossiped on every change.
- Cold sync of a wallet downloads the entire OpLog head CID, whose size depends on the largest entries.
- The pointer layer publishes the OpLog head CID to the aggregator; bloated OpLog entries make snapshot bundles unnecessarily large.

The invariant this design restores:

> **Any OpLog value whose encrypted size MAY exceed 1 KiB, or whose item count grows unboundedly with user activity, MUST be stored as a CID reference pointing to IPFS-pinned content. The actual data never touches OpLog.**

Bounded small metadata (tracked addresses, swap records, bundle refs) remains inline.

---

## §2 The `CidRef` type

```typescript
export interface CidRef {
  /** Schema version of this reference envelope. Bump on breaking changes. */
  readonly v: 1;
  /** IPFS CID of the encrypted payload. sha2-256 multihash only. */
  readonly cid: string;
  /** Encrypted byte size — useful for size-budgeting and telemetry. */
  readonly size: number;
  /** Wall-clock timestamp when this ref was created (ms since epoch). */
  readonly ts: number;
  /** Optional — caller-supplied content-version tag for layered schema changes. */
  readonly contentV?: number;
}
```

Serialized to JSON for embedding in `StorageProvider.set(key, JSON.stringify(ref))`:

```json
{"v":1,"cid":"bafybeihash...","size":842,"ts":1700000000000}
```

**Size:** ~100-150 bytes serialized. The tiny OpLog entry carrying this JSON is encrypted by ProfileStorageProvider as usual, landing at ~200 bytes total in the envelope payload.

### 2.1 Discriminator

`CidRefStore.tryParseRef(jsonString)` returns a `CidRef` iff the input is a JSON object with `v === 1` AND a non-empty `cid` string AND a numeric `size` AND a numeric `ts`. Otherwise returns `null`, signaling the value is legacy inline content.

This discriminator is the backward-compat hinge — see §6.

---

## §3 The bounded-vs-unbounded rule

An OpLog value MUST use a CidRef if ANY of:
- The value's encrypted byte size CAN exceed 1 KiB (defensive cutoff — actual typical cap might be much smaller).
- The value is a list/map that grows with user activity over wallet lifetime (messages, invoices, sent transfers, received tokens, group state).
- The value contains serialized SDK artifacts (`Token.sdkData`, inclusion proofs, predicate chains, genesis data).

An OpLog value MAY stay inline if:
- The value's encrypted byte size is bounded to a small constant (e.g. identity fields, single version numbers, boolean flags).
- The value is a short bounded list (e.g. tracked HD addresses, typically ≤ 20 entries).
- The value is itself already a CID reference with surrounding bounded metadata (e.g. `tokens.bundle.<cid>` with status/timestamps).

**Enforcement** (future hardening):
- `writeEnvelope` warns on payload > 8 KiB (commit 8 of this refactor series).
- CI-level grep or AST check for `storage.set(key, JSON.stringify(array))` patterns in module code.

---

## §4 Two storage patterns

### Pattern A — whole-content-as-CID

The entire data structure is pinned as a single blob.

```
OpLog value:                IPFS content:
{cid:"bafy...", size:...}   encrypt(JSON.stringify([token1, token2, token3, ...]))
```

**Best for:**
- Write-light data (updated infrequently)
- Full-list-read-write access (always read or write the whole thing)
- Moderate total size (< 100 KiB plaintext)

**Uses:**
- PaymentsModule pending V5 tokens
- PaymentsModule V5 outbox
- AccountingModule auto-return state (already small enough to stay inline, reconsider only if it grows)

**Lifecycle:**
- Every mutation: pin new CID, update OpLog entry to point at new CID.
- Old CID becomes orphan (never unpinned in v1; see §7).

### Pattern B — index-of-items-as-CIDs

The data structure is an array; each item is pinned separately; OpLog holds an index.

```
OpLog value:                             IPFS content:
{                                        message 1 → encrypt(msg1)
  v: 1,                                  message 2 → encrypt(msg2)
  items: [                               ...
    {id, ts, cid, size},
    {id, ts, cid, size},
    ...
  ]
}
```

**Best for:**
- Append-heavy data (messages, events)
- Per-item read access (fetch one message by ID)
- Large total size with many small items (1000 × 300-byte messages = 300 KB total)

**Uses:**
- CommunicationsModule DM messages
- GroupChatModule messages (per-group sharding)

**Lifecycle:**
- Append: pin new item CID, update index with new entry, write new index.
- Delete: remove from index, write new index. Item CID becomes orphan.
- Read-all: iterate index, fetch each CID in parallel (or sequential based on cache).

**Note on index size:** the index itself can grow. Each entry is ~80 bytes. 1000 entries = 80 KB — still under the 1 KiB inline rule's 100 KiB upper bound but worth monitoring. Phase 2 will introduce archival/sharding (older entries migrate to an `archive.<n>` key with its own CID).

### Pattern C — per-item OpLog key

Not part of this design. Discussed for completeness: each item becomes its own OpLog entry (e.g. `messages.<id>`). This was considered and rejected because:
- OpLog entry count growth is costlier than byte-count growth (each entry has merkle-CRDT overhead).
- "List all messages" requires iterating all keys matching a prefix, which is O(n) scan in OrbitDB.
- CRDT merge doesn't benefit per-item — messages aren't concurrent-edited.

Pattern B keeps OpLog key count low while giving per-item granularity through the index.

---

## §5 Encryption flow

Both patterns preserve the existing encryption boundary. ProfileStorageProvider's `encryptProfileValue` / `decryptProfileValue` (AES-256-GCM with wallet-derived key) is used for the IPFS content as well.

```
Pattern A (whole-list):
  plaintext list
    → JSON.stringify
    → encrypt(jsonBytes) via encryptProfileValue
    → pinToIpfs(encryptedBytes)
    → CID
    → build CidRef { cid, size = encryptedBytes.length, ts, v:1 }
    → ProfileStorageProvider.set(key, JSON.stringify(ref))   // ref ~100B, ProfileStorageProvider encrypts again at OpLog layer

Pattern B (per-item):
  For each new item:
    → JSON.stringify(item)
    → encrypt
    → pinToIpfs
    → CID entry for index

  Index write:
    → update index.items array
    → JSON.stringify(index)
    → encrypt
    → pinToIpfs
    → CidRef → ProfileStorageProvider.set(...)
```

**Double-encryption cost:** negligible. The outer layer (ProfileStorageProvider encrypting the ref JSON) operates on a ~100-byte blob. The inner layer (CidRefStore encrypting the content) is what was always happening — we've just moved WHERE the ciphertext is stored.

**Privacy note:** the CID itself is public (pinned content is visible at the IPFS layer). An observer correlating OpLog entries to IPFS pins learns that a specific wallet pinned specific CIDs. They do NOT learn the content (AES-256-GCM). Current threat model already accepts CID-level observability for UXF bundles; extending that to the OpLog-ref pattern adds nothing new.

---

## §6 Migration strategy — dual-read, single-write

Existing wallets have JSON blobs inline in OpLog. After this refactor ships, new writes always go through CID-ref. Reads detect which format is present:

```typescript
async loadPendingV5Tokens(): Promise<void> {
  const data = await storage.get(PENDING_V5_TOKENS_KEY);
  if (!data) return;

  const ref = CidRefStore.tryParseRef(data);
  let tokens: Token[];

  if (ref) {
    // New path — fetch from IPFS.
    tokens = await this.cidRefStore.fetchJson<Token[]>(ref);
  } else {
    // Legacy path — inline JSON (pre-refactor wallet data).
    tokens = JSON.parse(data);
  }

  this.mergePendingTokens(tokens);
}
```

**Write path is ONE-WAY:** always write CID-ref. On first write after upgrade, the legacy inline blob is replaced with a ref. The legacy data migrates opportunistically through normal wallet activity.

**Caveats:**
- A user who reads but never writes keeps legacy format forever. That's fine — reads still work.
- A legacy blob > 1 KiB is tolerated on read (the rule only binds writes).
- Rolling back the SDK after the refactor ships means the old SDK reads a CID-ref JSON string and tries `JSON.parse` → gets `{v:1,cid:...,...}` instead of the expected token array → crash. **Downgrade is breaking.** This matches the existing OpLog-schema migration sequencing (documented in PROFILE-OPLOG-SCHEMA.md §7.4).

---

## §7 Pin lifecycle — never-unpin v1

When a CID-ref is overwritten with a new ref, the old CID becomes an orphan in the wallet's IPFS store. This refactor **does not unpin orphans**. Rationale:

1. **Simpler.** Pin/unpin timing races with replication. A premature unpin on one device while another is still replicating the old entry = data loss.
2. **Safer.** Orphan data is cost (disk space), not correctness. Users have disk space; they don't have recoverability from premature GC.
3. **Consistent.** UXF bundles already follow this policy (see PROFILE-AGGREGATOR-POINTER-ARCHITECTURE §9 superseded-bundle retention).

**Storage cost estimate:** a wallet writing 1000 messages will accumulate ~1000 orphan message CIDs over time. At ~300 bytes each, ~300 KB total orphan cost per 1000 messages. Acceptable.

**Phase 2 feature:** operator-triggered GC. A background scan reads all OpLog refs, collects currently-referenced CIDs, compares to a pin ledger tracking `(key, cid, firstPinnedAt)`, and unpins CIDs not referenced for > 7 days. NOT implemented in this refactor.

---

## §8 Per-module schemas

### 8.1 PaymentsModule — pending V5 tokens

**Key:** `<addr>.pendingV5Tokens`

**Old (inline):**
```json
[{...token1...}, {...token2...}, ...]
```

**New (Pattern A):**
```json
{"v":1,"cid":"bafy...","size":8421,"ts":1700000000000}
```

Content at CID: `encrypt(JSON.stringify([{...token1...}, {...token2...}, ...]))`

### 8.2 PaymentsModule — V5 outbox

**Key:** `<addr>.outbox`

**Old (inline):**
```json
[{"transfer":{id,status,tokens:[...],...},"recipient":"...","createdAt":123}]
```

**New (Pattern A):**
```json
{"v":1,"cid":"bafy...","size":12485,"ts":1700000000000}
```

Content at CID: `encrypt(JSON.stringify(outboxArray))`

Note: outbox entries are individually mutable (update status, remove on confirm). Every mutation rewrites the whole blob and pins new CID. Write-light pattern: typical user sends < 10 transfers/day, so ~10 pin operations per wallet per day. Acceptable.

### 8.3 AccountingModule — invoice ledger

**Key:** `<addr>.invoiceLedger.<invoiceId>` (per-invoice)

**Old (inline):**
```json
{"transferId1":{...},"transferId2":{...},...}
```

**New (Pattern A per-invoice):**
```json
{"v":1,"cid":"bafy...","size":3421,"ts":1700000000000}
```

Content at CID: `encrypt(JSON.stringify({transferId1:{...},...}))`

Already partitioned by invoice (no global mega-blob), so ledger growth is bounded by invoice lifetime. Each invoice typically reaches final-state within days/weeks.

### 8.4 CommunicationsModule — DM messages

**Key:** `<addr>.messages`

**Old (inline):**
```json
[{id,senderPubkey,...,content,timestamp,isRead},...]
```

**New (Pattern B — index):**
```json
{"v":1,"cid":"bafyIndex...","size":18200,"ts":1700000000000}
```

Content at `bafyIndex`: `encrypt(JSON.stringify({
  v: 1,
  items: [
    {id: "msg1", ts: 1700000000000, cid: "bafyMsg1...", size: 342},
    {id: "msg2", ts: 1700000000100, cid: "bafyMsg2...", size: 401},
    ...
  ]
}))`

Each `bafyMsg<n>`: `encrypt(JSON.stringify({id,senderPubkey,...,content,timestamp,isRead}))`

**Index size:** ~80 bytes per entry. 1000 messages → 80 KB index, pinned as one blob.

**Read one message:** load index (~80 KB fetch if cold), find entry by ID, fetch message CID.

**Append message:** pin new message CID, update index array, pin new index CID, update OpLog ref.

**Phase 2 — archive:** when index exceeds N entries (e.g. 5000), move oldest half to an archive key (`<addr>.messages.archive.<counter>`) and keep only recent in the live index.

### 8.5 GroupChatModule — group state

**Keys:** `<addr>.groupChatGroups`, `<addr>.groupChatMembers.<groupId>`, `<addr>.groupChatMessages.<groupId>`

**New (Pattern A for groups/members, Pattern B for messages-per-group):**

- `groupChatGroups` — Pattern A (bounded by group count, typically < 100)
- `groupChatMembers.<groupId>` — Pattern A per group (bounded by member count per group)
- `groupChatMessages.<groupId>` — Pattern B per group (unbounded per group)

Keys are partitioned by groupId so no single blob accumulates all groups' state.

---

## §9 Size telemetry

Commit 8 of this refactor series adds a `console.warn` in `ProfileStorageProvider.writeEnvelope` when the encrypted payload exceeds 8 KiB. This:
- Catches regressions where new code writes fat data inline.
- Surfaces legacy data that hasn't migrated yet.
- Provides signal during testing that CID-refs are being used correctly (refs are ~200 bytes, never warn).

Not an error — just a warning. Errors come from the envelope MAX_PAYLOAD_BYTES cap (128 KiB) which is a hard fail.

---

## §10 Test strategy per module

Each module refactor commit includes:

1. **Round-trip test**: write via new CID-ref path, read back, assert content identical.
2. **Legacy-read test**: inject a legacy inline JSON value into mock storage, read via new code, assert correct decode.
3. **Migration test**: write via new path AFTER reading legacy; assert subsequent reads use CID-ref path.
4. **Size assertion**: after write, assert OpLog entry payload size < 500 bytes (even though content is large).
5. **Encryption test**: verify content at CID is NOT plaintext (AES-GCM ciphertext is uniformly random; check first byte entropy).

Integration tests covering multi-device replication (peer B reads CID-ref written by peer A, fetches from IPFS, decrypts) are out of scope for per-module unit tests — covered by the existing E2E suites.

---

## §11 What this design does NOT cover

- **Pin ledger / orphan GC** — Phase 2. Current: never-unpin.
- **Cross-wallet CID sharing** — a feature, not a concern for this design.
- **IPFS availability under offline conditions** — current behavior already assumes IPFS reachable for UXF bundle reads; extending to OpLog-ref reads is consistent. Fallback (local blockstore) already exists.
- **IPNS publish of an OpLog snapshot** — this design keeps the OpLog thin so snapshots remain small. IPNS-publish integration is the pointer layer's job.
- **Automatic archival** — Pattern B's archive mechanism for long index chains is Phase 2 future work.
