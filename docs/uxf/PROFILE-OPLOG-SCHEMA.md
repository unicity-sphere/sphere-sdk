# Profile OpLog Entry Schema — Structured Envelope

**Status:** Draft 2 — post-steelman hardening (replication-edge authentication, DoS guards, symmetric capability probe, v=0 legacy sentinel)
**Precedes:** PROFILE-ARCHITECTURE.md §4 (OrbitDB integration); POINTER-SPEC.md §10.2.3 (originated-tag discipline)
**Supersedes:** the implicit `(key, encryptedBytes)` OpLog schema from PROFILE-ARCHITECTURE.md §4.2.

---

## §1 Motivation

### 1.1 The gap

The current Profile implementation writes opaque `Uint8Array` values to OrbitDB:

```typescript
// profile/orbitdb-adapter.ts:202
async put(key: string, value: Uint8Array): Promise<void>
```

The pointer-layer spec (`PROFILE-AGGREGATOR-POINTER-SPEC.md` §10.2.3) introduces an **originated-tag discipline**:

> Every OpLog write MUST carry an `originated` tag indicating who initiated the write.
> Rules: user-action entries carry `'user'`; system entries carry `'system'`;
> replicated entries are downgraded to `'replicated'` at the replication ingress.

For this discipline to hold, the tag must be INSIDE the OpLog entry. Tag-on-the-envelope-only (e.g. a sibling key, a Nostr event tag, an OrbitDB metadata field) does not work:

- A malicious peer can forge a sibling key / metadata field independently of the payload.
- OrbitDB's entry signing covers only the `(key, payload)` pair — not application-layer metadata stored elsewhere.
- The downgrade at replication ingress must be authenticated; only fields cryptographically bound to the entry qualify.

### 1.2 Why structured entries solve this

A structured envelope with `originated` as a typed field, sealed by the same signature that protects the payload, makes the tag:

- **Authenticated** — OrbitDB signs the whole entry; tampering breaks the signature.
- **Atomic** — downgrade-at-replication-edge is a single field mutation on a decrypted struct, not a coordination across two writes.
- **Validatable** — `assertOriginTagLocal` / `assertOriginTagReplicated` can run over every entry deterministically without reaching outside the entry.
- **Schema-versioned** — future fields (retention hints, cache-eviction class, UI decoration tags) can be added without breaking existing readers.

### 1.3 Non-goals

This schema:
- Does NOT redefine OrbitDB's wire format. OrbitDB's `keyvalue` database still stores `(key: string, value: Uint8Array)` tuples.
- Does NOT change IPLD / CID derivation for stored bundle references.
- Does NOT change Nostr event encoding (`kind: 30078`, encrypted `content` field).

Only the **interpretation** of the `value` bytes changes: they now represent a serialized `OpLogEntryEnvelope`.

---

## §2 Envelope Format

### 2.1 TypeScript shape

```typescript
/** Schema version. Bump on breaking envelope changes (additive fields are non-breaking). */
export const OPLOG_ENTRY_SCHEMA_VERSION = 1;

export interface OpLogEntryEnvelope {
  /** Must equal OPLOG_ENTRY_SCHEMA_VERSION for this build. Unknown versions → fail-closed. */
  readonly v: 1;

  /**
   * Entry classification (OpLogEntryType from originated-tag.ts):
   * user actions:  'token_send' | 'token_receive' | 'nametag_register'
   *              | 'dm_send' | 'dm_receive' | 'invoice_mint' | 'invoice_pay'
   *              | 'invoice_close' | 'invoice_cancel'
   *              | 'swap_propose' | 'swap_accept' | 'swap_deposit'
   * system:       'session_receipt' | 'cache_index' | 'last_opened_ts'
   */
  readonly type: OpLogEntryType;

  /** Originated tag — 'user' | 'system' | 'replicated'. */
  readonly originated: OriginTag;

  /**
   * Wall-clock timestamp of the ORIGINATING write (ms since epoch).
   * Preserved across replication — a replicated entry carries the author's
   * timestamp, not the replayer's receipt time.
   */
  readonly ts: number;

  /**
   * Opaque application payload. Meaning defined by `type`. May itself be
   * AES-256-GCM encrypted (see §3 Encryption Boundary).
   */
  readonly payload: Uint8Array;
}
```

### 2.2 Serialization — CBOR

**On-the-wire format: deterministic CBOR (RFC 8949 §4.2.3, core deterministic encoding).**

Rationale:
- Binary, compact (~5–10 bytes overhead vs JSON's ~40+ bytes per entry).
- Deterministic encoding available via `@ipld/dag-cbor` or equivalent — two clients serializing the same envelope produce byte-identical output, guaranteeing signature stability across implementations.
- Native Uint8Array support (no base64 round-trip).
- IPLD-native — OrbitDB already uses IPLD internally.

Field ordering (deterministic CBOR requires sorted keys):

```
{
  "originated": <text>,      // CBOR text string
  "payload":    <bytes>,     // CBOR byte string
  "ts":         <uint>,      // CBOR positive integer
  "type":       <text>,      // CBOR text string
  "v":          <uint>       // CBOR positive integer
}
```

The envelope's CBOR byte-encoding is the value written to OrbitDB via `db.put(key, cborBytes)`. OrbitDB's own signature (on `hash(key || cborBytes)`) covers the entire envelope.

### 2.3 Size budget

Typical entry (with 200-byte encrypted token-ref payload):

```
CBOR envelope overhead: ~40 bytes (field names + type tags)
Encrypted payload:       ~200 bytes
-----------------------------------------
Total entry size:        ~240 bytes
```

PROFILE-ARCHITECTURE.md §4.5 estimates 100–500 bytes per entry; the envelope adds 40 bytes of overhead, landing at 140–540 bytes. Acceptable.

---

## §3 Encryption Boundary

Encryption applies to the `payload` field only. The envelope metadata (`v`, `type`, `originated`, `ts`) is **plaintext**.

### 3.1 Rationale

- **Replication can validate without key access.** A peer replicating the OpLog can check `v === 1`, assert `originated ∈ {'user','system','replicated'}`, and enforce `downgradeForReplication` — without ever decrypting the payload.
- **OpLog readers can index by type.** Phase 2 features (selective sync, type-filtered recovery) can scan the OpLog for `type === 'invoice_mint'` entries without decrypting non-matching entries.
- **Timestamp ordering is correct without decrypt.** OrbitDB's Lamport clock is sufficient for CRDT merge, but `ts` is useful for UI sort — visible timestamps enable this.

### 3.2 Threat model

The envelope's plaintext metadata leaks:
- **Action types** — an observer sees the wallet did `token_send`, `swap_deposit`, etc.
- **Timing pattern** — wall-clock timestamps of activity.

These are acceptable given:
- The observer already sees OpLog entries appearing (from PubSub / Nostr relay observation).
- Activity timing was already inferrable from entry-count rate.
- The existing IPFS content-addressed model already leaks CIDs (and thus bundle membership counts via pinned-bundle observation).

Full metadata privacy is a Phase 2 feature (onion routing, mixnet, timing-obfuscated publish) out of scope for this design.

### 3.3 Encryption primitive

`payload` uses the existing `encryptProfileValue` / `decryptProfileValue` primitives (AES-256-GCM, wallet-derived key from `profile/encryption.ts` or equivalent). The envelope itself is NOT re-encrypted — only the payload.

### 3.4 Replication-ingress attack surface (post-steelman)

The `originated` tag is the load-bearing security field. A peer that can get a write accepted by OrbitDB's access controller will author envelopes of its choice — including `originated: 'user'` forgery attempts. Without defense-in-depth, any local code path that reads envelopes and trusts the stored tag would treat peer forgery as authentic local activity.

**Authentication boundary: `OrbitDbAdapter.getEntry()` is the choke point.**

Default behavior (post-steelman):

```typescript
// Default — replicated-downgrade enforced:
const envelope = await adapter.getEntry(key);
// → envelope.originated is ALWAYS 'replicated' (or v=0 legacy sentinel)

// Explicit trust — requires BOTH the caller's signal AND local authorship:
const envelope = await adapter.getEntry(key, { trustLocalClaim: true });
// → envelope.originated is the stored tag IFF the key was written via
//   putEntry in THIS session AND no replication event has fired since.
```

The adapter maintains a session-scoped `localAuthoredKeys: Set<string>` that:
- Gains an entry on every local `putEntry(key, ...)` call.
- Is CLEARED entirely on every `onReplication` event (conservative: a peer may have overwritten any key via OrbitDB's LWW-per-key CRDT).
- Is CLEARED on `close()` / session end.

A key written in session N cannot be trusted across sessions — a remote peer may have overwritten it (LWW) while we were offline. Local writes are always re-stamped on next write, so long-lived trust is not required.

**What this defeats:**
- Peer publishes `{originated: 'user', type: 'token_send', ...}` → default `getEntry` returns `originated: 'replicated'`. Local code that conditionally trusts 'user' origins does not conditionally trust this envelope.
- Peer replays a forgery after a local write → the replication event fires → `localAuthoredKeys` clears → subsequent trusted reads downgrade again.
- Peer crafts legacy-shaped CBOR (bare `Uint8Array`) at replication ingress → `decodeAndDowngradeReplicated` rejects with `OpLogEntryCorrupt` (legacy format is strictly local synthesis).

**What this does NOT defeat** (out-of-scope for this layer):
- An attacker with local code execution — they can call `markLocallyAuthored()` directly or bypass the adapter entirely.
- A compromised OrbitDB identity used to write from a trusted device — indistinguishable from a legitimate local write.
- Timing attacks inferring wallet activity from replication-event timing.

### 3.5 DoS guards

CBOR decode of untrusted replicated data is protected by:
- `MAX_ENVELOPE_BYTES` = 256 KiB (pre-decode byte cap — rejects 4 GB-declared byte strings before allocation).
- `MAX_PAYLOAD_BYTES` = 128 KiB (post-decode payload cap).
- Strict shape check: envelope MUST contain exactly the five known fields `(v, type, originated, ts, payload)` — extra fields rejected.
- `MIN_PLAUSIBLE_TS` = 2020-01-01 UTC: real envelopes must carry ts >= this value. `ts = 0` is reserved for the legacy sentinel; `ts < MIN_PLAUSIBLE_TS` is treated as corruption.

---

## §4 Validation

Every envelope read from OrbitDB MUST be validated BEFORE the caller sees the decoded object:

```typescript
function validateEnvelope(e: unknown): OpLogEntryEnvelope {
  // 1. Structural shape check
  if (typeof e !== 'object' || e === null) throw CORRUPT;
  const r = e as Partial<OpLogEntryEnvelope>;

  // 2. Schema-version gate — unknown versions fail-closed
  if (r.v !== OPLOG_ENTRY_SCHEMA_VERSION) {
    throw CORRUPT({ reason: 'schema_version_mismatch', got: r.v });
  }

  // 3. Field presence + type
  if (typeof r.type !== 'string')        throw CORRUPT;
  if (typeof r.originated !== 'string')  throw CORRUPT;
  if (typeof r.ts !== 'number' || !Number.isFinite(r.ts) || r.ts < 0) throw CORRUPT;
  if (!(r.payload instanceof Uint8Array)) throw CORRUPT;

  // 4. Type in known enum (uses ALL_ENTRY_TYPES from originated-tag.ts)
  if (!ALL_ENTRY_TYPES.includes(r.type as OpLogEntryType)) throw CORRUPT;

  // 5. Originated in valid set (delegates to originated-tag.ts)
  if (!['user', 'system', 'replicated'].includes(r.originated)) throw CORRUPT;

  return r as OpLogEntryEnvelope;
}
```

Validation is the FIRST step of every `getEntry()` / replication-ingest path. No caller may observe an invalid envelope.

---

## §5 Write Path

### 5.1 Local writes (user / system)

```
Module (e.g. PaymentsModule.send)
  │
  │  1. Compute payload bytes (encrypted via encryptProfileValue)
  │
  ▼
storage.set(key, payload, { type: 'token_send' })
  │
  │  2. StorageProvider wraps:
  │     envelope = {
  │       v: 1,
  │       type: 'token_send',
  │       originated: 'user',       // derived from call-site type
  │       ts: Date.now(),
  │       payload: encryptedBytes,
  │     }
  │  3. stampOriginated() enforces "no double-stamp" (originated-tag.ts)
  │  4. assertOriginTagLocal(type, 'user') enforces type/origin coherence
  │  5. Serialize envelope as deterministic CBOR
  │
  ▼
OrbitDbAdapter.putEntry(key, envelope)
  │
  │  6. validateEnvelope() on the constructed struct
  │  7. CBOR-encode → cborBytes
  │
  ▼
orbitdb.db.put(key, cborBytes)
  │  8. OrbitDB signs the entry and appends to OpLog
```

### 5.2 Replicated writes (from a peer / another device)

```
OrbitDB replication event fires  (libp2p PubSub or Nostr replay)
  │  cborBytes arrive
  │
  ▼
OrbitDbAdapter.onReplication() handler
  │
  │  1. CBOR-decode cborBytes → envelope candidate
  │  2. validateEnvelope() — FIRST, before any other processing
  │  3. downgradeForReplication(envelope) — force originated = 'replicated'
  │     (enforces non-forgeability: peer claims of 'user'/'system' are OVERWRITTEN
  │      to 'replicated' at the trust boundary)
  │  4. assertOriginTagReplicated(type, 'replicated') — validate post-downgrade
  │
  ▼
Deliver validated + downgraded envelope to the application layer
  (ProfileStorageProvider / ProfileTokenStorageProvider consumers)
```

Note: OrbitDB's `keyvalue` database stores the **last write per key** via Lamport-clock LWW. The downgrade happens at the moment of LOCAL observation — we do not modify what's in OrbitDB on the wire (that would break the signature). The `originated: 'replicated'` is imposed on the DECODED envelope returned to application code.

### 5.3 System writes

System writes (e.g., `cache_index`, `last_opened_ts`, `session_receipt`) use the same envelope but pass `type ∈ SYSTEM_ACTION_TYPES` and expect `originated = 'system'`. They bypass user-action validation but still go through `stampOriginated` + `assertOriginTagLocal`.

---

## §6 Read Path

```
Caller (e.g., PaymentsModule.load)
  │
  ▼
storage.get(key)
  │
  ▼
OrbitDbAdapter.getEntry(key)
  │
  │  1. orbitdb.db.get(key) → cborBytes (or null)
  │  2. CBOR-decode → envelope candidate
  │  3. validateEnvelope() — reject malformed
  │
  ▼
Return { v, type, originated, ts, payload } to caller
  │
  │  Application may:
  │    - decrypt payload via decryptProfileValue
  │    - ignore entries with unexpected `type` (forward-compat)
  │    - use `ts` for UI ordering
  │    - log `originated` for audit trails
```

The decrypted payload is returned as-is to the caller — the envelope does not attempt to interpret the payload's structure. That stays with the calling module.

---

## §7 Backward Compatibility

### 7.1 Existing wallets

Existing wallets have OrbitDB databases full of **raw opaque `Uint8Array`** values (not CBOR envelopes). When upgraded SDK reads these, `CBOR.decode` will either:
- Throw (malformed CBOR) — trigger a migration-detection fallback.
- Succeed with a non-envelope shape — `validateEnvelope` rejects.

**Migration strategy (§7.2):** the adapter implements a LEGACY READ PATH that detects non-envelope values and wraps them on-the-fly in a synthetic envelope with:

```typescript
{
  v: 1,
  type: 'cache_index',      // conservative default: treat unknown legacy as system
  originated: 'system',
  ts: 0,                     // unknown origin time
  payload: <original bytes>,
}
```

Legacy entries are NEVER WRITTEN BACK — on subsequent modifications, the caller writes a fresh envelope. The OpLog thus gradually migrates through normal wallet activity.

### 7.2 Detection heuristic

Attempt CBOR decode. If:
- It throws → legacy (treat as wrapped).
- It succeeds but produces a non-object / missing `v` field → legacy.
- It produces `{ v: 1, type, originated, ts, payload }` with valid types → envelope.
- It produces `{ v: N }` with N > 1 → forward-compat unknown version → CORRUPT, refuse to read.

The heuristic has a tiny false-positive probability (a raw byte sequence that happens to decode as a valid CBOR map with `v: 1` and the exact field names). Upper bound: < 2^-80 for any realistic payload. Acceptable.

### 7.3 Adapter gradual adoption

The `OrbitDbAdapter` exposes BOTH APIs during migration:

```typescript
// Legacy (opaque bytes — preserved for backward compat)
async put(key: string, value: Uint8Array): Promise<void>;
async get(key: string): Promise<Uint8Array | null>;

// New (structured envelope — callers migrate one module at a time)
async putEntry(key: string, entry: OpLogEntryEnvelope): Promise<void>;
async getEntry(key: string, opts?: { trustLocalClaim?: boolean }): Promise<OpLogEntryEnvelope | null>;
```

Once all callers have migrated, the legacy methods are deprecated in a single follow-up (not this design doc's scope).

### 7.4 Deployment sequencing ⚠️ LOAD-BEARING

**Strict requirement: all devices sharing an OrbitDB instance MUST upgrade to the new SDK before ANY of them write envelopes.**

The migration is asymmetric by design:

| Writer | Reader | Outcome |
|--------|--------|---------|
| Old SDK (raw bytes) | Old SDK | ✓ raw round-trip (pre-schema behavior) |
| New SDK (envelope) | New SDK | ✓ envelope round-trip with downgrade enforcement |
| Old SDK (raw bytes) | New SDK | ✓ legacy fallback wraps raw Uint8Array CBOR as synthetic v=0 envelope |
| **New SDK (envelope)** | **Old SDK** | ❌ **BREAKS** — old SDK passes envelope bytes to `decryptProfileValue`, which interprets CBOR header bytes as AES-GCM nonce → `DECRYPTION_FAILED`. Wallet sees data as missing. |

**Consequence:** if a user runs the new SDK on one device and the old SDK on another, the second device breaks the moment the first writes anything. Multi-device wallets MUST coordinate upgrades.

**Deployment patterns:**

1. **Coordinated fleet upgrade (simplest):** release the new SDK with a version-gate on an external signal (e.g., operator-controlled feature flag) and flip it after all known devices have updated. Keep the new SDK in legacy mode (reads only, does not write envelopes) until the flag flips. Not implemented in this schema — would require a per-adapter config flag.

2. **Dual-write transition window (future hardening):** during a deprecation period, write BOTH formats under parallel keys (`key` = raw legacy, `key.v1` = envelope) and have new readers prefer the envelope form. After all old SDKs are decommissioned, dual-writing can stop. Not in scope for the initial rollout.

3. **Big-bang upgrade (current default):** ship the new SDK with clear release notes: "all devices must upgrade together". Acceptable for early adopters. NOT acceptable once there's a production user base with multi-device wallets.

**Recommendation:** production deployment SHOULD gate the envelope-write path on an explicit `enableEnvelopeWrites: boolean` configuration flag, defaulting to `false` in release builds until a fleet-upgrade window is complete.

### 7.5 Symmetric capability probe

`ProfileStorageProvider.supportsEnvelopes()` runs a one-shot probe on first access: both `putEntry` AND `getEntry` must exist on the adapter, or NEITHER. An asymmetric adapter (one method but not the other) throws `PROFILE_NOT_INITIALIZED` at the first write. This prevents the silent-corruption mode where an adapter writes envelopes but reads raw bytes (or vice versa) — a scenario that would otherwise leave unreadable data on disk with no error at write time.

---

## §8 Integration with Pointer Layer

The pointer layer publishes OpLog head CIDs to the aggregator. It does NOT read or write individual OpLog entries — it operates on the OrbitDB manifest CID.

The envelope is load-bearing for the pointer layer in one place: **recovery-time validation**. When `ProfilePointerLayer.recoverLatest()` returns a CID and the caller fetches the bundle, the replay of OpLog entries into the local OpLog passes through the replication ingress path (§5.2). `downgradeForReplication` fires, `assertOriginTagReplicated` runs, and the newly-joined entries carry `originated: 'replicated'`.

This closes the security gap that motivated this schema: a malicious peer publishing a bundle whose entries claim `originated: 'user'` will have those claims OVERWRITTEN by the ingress downgrade.

---

## §9 Open questions (resolved)

| # | Question | Resolution |
|---|----------|-----------|
| 1 | Encrypt envelope metadata? | NO — plaintext metadata enables non-decrypting validation + indexing; threat model accepts the leak. |
| 2 | Sign envelope independently of OrbitDB? | NO — OrbitDB's own entry signature covers the envelope bytes; no second layer needed. |
| 3 | CBOR vs JSON vs protobuf? | CBOR — determinism, binary compactness, IPLD alignment, native bytes. |
| 4 | Schema version gating behavior? | Fail-closed on unknown `v`. Forward-compat requires explicit support, not silent success. |
| 5 | Timestamp source (local vs CRDT clock)? | Wall-clock `ts` preserved across replication — Lamport clock is for CRDT merge, `ts` is for UI. |
| 6 | Migration approach — big-bang vs gradual? | Gradual via legacy read fallback. Avoids a one-shot rewrite that could fail mid-flight. |

---

## §10 Non-scope (future work)

- **Encrypted metadata** — phase 2 if privacy threat model changes.
- **Multi-version envelope** — V2 may add retention hints, sub-type, payload compression flags. Additive-only changes keep v=1 readers compatible; breaking changes require v bump + coordinated migration.
- **Schema registry** — a canonical list of `type` → payload-schema bindings (for type-safe module writers) is deferred to the W11 work.
- **Rename `type` → `kind`?** — Keep `type` per SPEC §10.2.3. Rename would cascade through originated-tag.ts and break the existing public export.

---

## §11 Implementation checklist

This document unblocks:
- [ ] `profile/oplog-entry.ts` — envelope type, encode/decode, validate, wrap-legacy
- [ ] `OrbitDbAdapter.putEntry` / `getEntry` / replication downgrade hook
- [ ] `ProfileStorageProvider` migration (storage.set passes `type` through)
- [ ] `ProfileTokenStorageProvider` migration (writes stamped with correct `type`)
- [ ] `NostrReplicationBridge` — downgrade at decrypted-entry boundary (§5.2)
- [ ] W11 module stamps (PaymentsModule, AccountingModule, SwapModule, CommunicationsModule)
- [ ] Update `PROFILE-ARCHITECTURE.md` §4.2 / §4.3 to reference this schema
- [ ] Update `PROFILE-AGGREGATOR-POINTER-ARCHITECTURE.md` integration section

Each step is independently committable. Backward compat (§7) means a partial migration ships cleanly.
