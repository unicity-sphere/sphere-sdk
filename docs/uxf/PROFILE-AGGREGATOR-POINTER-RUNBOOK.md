# Profile Aggregator Pointer — Operator Runbook

**Scope:** operational procedures for the Profile Aggregator Pointer layer
(SPEC §7, §8, §10, §13). Audience: wallet operators, support engineers,
and on-call responders. Read the spec first if you have not; this runbook
assumes familiarity with the layer's architecture.

**Status:** Phase D + E in progress. The content-address-verified CAR
fetch, IPNS-record signature verification, and per-token JOIN resolver
(Rule 3) are live. Rule 4 (proof-enriched synthetic root) and the full
§10.7.1 gossipsub peer-discovery integration are future work.

---

## 1. Glossary

- **Pointer layer** — the anchor channel that binds the wallet's latest
  CAR CID to a monotonically increasing version number via aggregator
  inclusion proofs. Replaces the legacy IPNS snapshot channel as the
  sole cold-start recovery mechanism post-T-D6c.
- **CAR** — Content-Addressed aRchive; serialized IPLD DAG whose root
  CID is the authoritative identifier of the wallet's token pool at a
  given flush.
- **BLOCKED state** — persistent per-wallet flag set when the layer
  detects an integrity failure that requires operator intervention to
  clear (SPEC §10.2). New publish attempts are suppressed while BLOCKED.
- **Pending version marker** — crash-safety record of a publish in
  flight, read on restart to detect and idempotent-retry a half-
  committed v (SPEC §7.1.4 C1).
- **Legacy wallet** — a wallet created before the pointer layer
  existed; identified by the presence of a `profile.ipns.sequence`
  local-cache key and absence of `profile.pointer.migration.done`.

---

## 2. Steady-state monitoring

### 2.1 Signals of health

A healthy wallet emits:

- `storage:saved` on every successful flush.
- No `storage:error` events carrying an `AGGREGATOR_POINTER_*` code.
- `ProfileStorageProvider.getPointerLayer()` returns a non-null layer
  and `layer.isPublishBlocked()` returns `false`.
- `layer.isReachable()` returns `true` to the configured aggregator.

### 2.2 Signals to investigate

| Signal | Probable cause | First response |
|---|---|---|
| `storage:error` with `TRUST_BASE_STALE` | aggregator rotated its trust base; wallet's bundled copy is older than required | upgrade the SDK to the release that bundles the new trust base |
| `storage:error` with `UNREACHABLE_RECOVERY_BLOCKED` | wallet is in BLOCKED state; auto-CLEAR conditions (§10.2.4) did not fire | §3.2 below — manual BLOCKED recovery |
| `storage:error` with `MARKER_CORRUPT` | pending-version marker failed integrity check (§7.1.5) | §3.3 below — `clearPendingMarker` |
| `storage:error` with `CORRUPT_STREAK` | §10.8 — too many consecutive corrupt versions during discovery walkback | §3.5 below — `acceptCorruptStreak` |
| `storage:error` with `CAR_UNAVAILABLE` | every configured IPFS gateway failed or returned bad content | check gateway config; if it is a genuine outage, §3.4 below |
| `storage:error` with `UNTRUSTED_PROOF` | aggregator returned a verify-failing inclusion proof and no rotation detected | STOP — probable aggregator compromise; do not attempt auto-recovery |
| `storage:error` with `SECURITY_ORIGIN_MISMATCH` | local OpLog entry carries an inconsistent `originated` tag | collect the key name from the error payload; treat as wallet-state corruption |
| `storage:error` with `PROTOCOL_ERROR` | SDK shape drift (e.g., aggregator response missing expected field) | pin the SDK version; file a bug with the payload shape |
| `storage:error` with `CAPABILITY_DENIED` | operator-override flag set in production build | build config error — see §6 |

Transient errors (`NETWORK_ERROR`, `CAR_FETCH_TIMEOUT`,
`PUBLISH_BUSY`, `CONFLICT`, `RETRY_EXHAUSTED`) are suppressed as
best-effort and do NOT raise a `storage:error` event. They are logged
at debug level — if a wallet never successfully publishes after many
flushes, check debug logs for repeated transient failures.

---

## 3. Recovery procedures

### 3.1 Pre-flight checklist for any operator override

1. Confirm the wallet is in the state you think it is in. `getPointerSkipReason()`
   on the storage provider surfaces the exact skip reason if the pointer
   layer failed to construct.
2. Confirm `NODE_ENV !== 'production'` — the production guard will refuse
   `allowOperatorOverrides=true` at init (T-E26). The correct workflow
   for production is to rebuild with a non-production environment, not
   to bypass the guard.
3. Confirm `SPHERE_ALLOW_OVERRIDES=1` is set at the environment level
   (not only in code). This prevents a library default from silently
   enabling dangerous APIs.
4. Always take a filesystem-level backup of the wallet's data directory
   (including the OrbitDB store and the local cache) before invoking
   any override.

### 3.2 BLOCKED state — `clearBlocked`

**Symptom:** `layer.isPublishBlocked()` returns `true`. Writes are
suppressed; reads still work.

**Auto-CLEAR conditions (SPEC §10.2.4) — no operator action needed if any fires:**

- (a) v=1 `PATH_NOT_INCLUDED` exclusion proof on BOTH sides A and B
  (the aggregator cryptographically attests that no pointer was ever
  published for this wallet). Auto-detected on next `recoverLatest()`.
- (b) a successful `recoverLatest() > 0` that fetches a CAR and merges
  the OpLog without error. Auto-detected as a consequence of normal
  recovery.

**Manual CLEAR (operator override) — when auto-CLEAR doesn't fire:**

Preconditions:
- You have verified via an independent channel that the wallet's
  state is recoverable (not an integrity failure).
- You have completed §3.1 pre-flight.

Procedure:
```ts
const state = await layer.getBlockedState();
console.log('blocked reason:', state.reason, 'setAt:', new Date(state.setAt));
// Validate the reason is not UNTRUSTED_PROOF or similar integrity class.
// If it is, STOP — do not clear.

await layer.clearBlocked();
// Subsequent publish() attempts will proceed normally.
```

**Contraindications:** never clear BLOCKED when the reason is
`UNTRUSTED_PROOF`, `SECURITY_ORIGIN_MISMATCH`, or
`AGGREGATOR_REJECTED`. These indicate integrity problems that require
investigation, not reset.

### 3.3 Corrupt pending-version marker — `clearPendingMarker`

**Symptom:** `storage:error` with `MARKER_CORRUPT` on init, or
`getPointerSkipReason()` returns `pointer_init_failed` with a message
referencing the marker.

**Context:** the pending-version marker protects against a publish
that crashed mid-submit (SPEC §7.1.4). If the marker itself is
corrupt (checksum mismatch per §7.1.5), the layer refuses to
initialize because it cannot safely infer the last publish attempt's
outcome.

Procedure:
```ts
await layer.clearPendingMarker();
// Side effect: SETs BLOCKED with reason='marker_corrupt'.
// Next recovery must succeed via §10.2.4 auto-CLEAR before publishes resume.
```

**Why the enforced BLOCKED:** clearing the marker alone would let the
wallet retry publishes from an unknown state. Re-running discovery +
recoverLatest before the next publish ensures the wallet re-synchronizes
with the on-network truth.

### 3.4 CAR unavailable — `acceptCarLoss`

**Symptom:** `storage:error` with `CAR_UNAVAILABLE`, or discovery's
Phase 3 returns `TRANSIENT_UNAVAILABLE` for the latest version across
extended time.

**Auto-path:** the pointer layer records each CAR-fetch failure to the
per-version ledger (T-C5). If the wall-clock gate in
`assertAcceptCarLossEligible` (§10.7) is met, `acceptCarLoss` is
invocable. Otherwise it throws `UNREACHABLE_RECOVERY_BLOCKED` — you
must wait for the gate.

Procedure:
```ts
await layer.recordCarFetchFailure(version, gatewayUrl);
// … repeat as IPFS fetches fail, across multiple load cycles.
// … after POINTER_CAR_LOSS_GATE_MS has elapsed per SPEC §10.7:
const result = await layer.acceptCarLoss(version, cidProducer);
```

The `cidProducer` MUST produce the FRESH CID of the wallet's current
token pool — `acceptCarLoss` publishes the new CID at the next
version, effectively abandoning the unavailable historical version.
This is a last-resort recovery; the prior CAR is considered lost.

**Gossipsub peer-discovery (SPEC §10.7.1 step 3) is not yet wired in
this release.** Acceptance still relies on the wall-clock gate +
ledger. Future versions will add a peer-availability poll before
acceptance.

### 3.5 Corrupt-version streak — `acceptCorruptStreak`

**Symptom:** `storage:error` with `CORRUPT_STREAK` (W6 / §10.8).
Discovery walkback hit the walkback-ceiling of consecutive
`SEMANTICALLY_INVALID` versions without finding a valid one.

**Cause:** usually an aggregator anomaly — a run of versions where
the inclusion proof or CAR fails validation. Less commonly, a
wallet that burned through versions due to a publish-reject loop.

Procedure:
```ts
// Raise the walkback ceiling for a single subsequent recovery attempt.
// Safety cap is 4096 versions regardless of what you pass.
const { walkbackUsed } = await layer.acceptCorruptStreak(4096);

// Next recoverLatest() uses the raised ceiling:
const recovered = await layer.recoverLatest(); // picks up walkbackUsed internally
```

This is a one-shot gate — the raised ceiling does not persist. If the
next discovery also hits the streak, investigate deeper (likely a
genuine aggregator integrity event).

---

## 4. Backup and restore

### 4.1 What to back up

| Location | What | Restored state |
|---|---|---|
| `<dataDir>/orbitdb/` | OrbitDB store (OpLog + heads) | Local bundle refs, operational state, derived caches |
| `<dataDir>/wallet.json` (or IndexedDB `sphere-storage`) | Local cache (identity, pointer version, IPNS sequence if legacy) | Wallet identity, monotonic version counters |
| `<dataDir>/orbitdb/profile-pointer-publish.lock` | Node-only publish lockfile | Not required for restore (it's a leased advisory lock) |

### 4.2 Restore procedure

1. Stop any running wallet process that may hold the OrbitDB directory.
2. Copy the backup over the target `dataDir`.
3. On next wallet init:
   - Phase A connects the local cache from the restored wallet.json /
     IndexedDB.
   - Phase B attaches OrbitDB from the restored store.
   - Phase C constructs the pointer layer.
   - `profile.pointer.version` from the local cache tells the layer
     which version it last published. The next publish will target
     `max(validV, includedV) + 1`, which self-corrects if the backup
     is older than the on-network state.

**Caveat:** if you restore from a backup older than the on-network
pointer version, the first publish after restore will CONFLICT once —
which triggers `fetchAndJoin` to merge the remote state, then
re-publishes. The bundle refs that the remote merged are added to
OrbitDB; no data loss for tokens whose CID is still pinned.

### 4.3 Restoring a wallet on a fresh device (mnemonic re-import)

No backup available? Cold-start recovery path:

1. Re-import the wallet from mnemonic. Identity is deterministic.
2. On init, `knownBundleCids.size === 0` triggers
   `recoverFromAggregatorPointerBestEffort()`.
3. The pointer layer's `recoverLatest()` resolves the latest valid
   version from the aggregator, decodes the CID, fetches the CAR
   with content-address verification, and records the ref.
4. Subsequent flushes continue normally.

No IPFS gateway access → the wallet initializes empty. The next flush
from a connected device will publish an anchor; the offline device
can recover when connectivity returns.

---

## 5. IPNS → pointer migration

Legacy wallets (`profile.ipns.sequence` present, `profile.pointer.migration.done`
absent) auto-migrate on next load via
`profile/migration/ipns-reader.ts:runIpnsToPointerMigration`:

1. Derives the legacy Ed25519 IPNS identity (HKDF info
   `'uxf-profile-ed25519-v1'`, byte-identical to pre-T-D6c).
2. Resolves the legacy IPNS record via the signature-verified routing
   API.
3. Iterates active bundle refs, validates each via `CID.parse`, writes
   them into OrbitDB via the provider's `addBundle`.
4. Stamps `MIGRATION_DONE_KEY` with a Date.now() string.

**What's NOT stamped:**

- Transient resolver failures (exception thrown). The migration
  retries on the next load; an operator should not force-stamp in
  response to a one-off IPNS outage.
- `null` resolver results (IpfsHttpClient.resolveIpns returns null
  for both "no record" and "all gateways down"; the distinction is
  not preserved). The migration retries on every load until a
  positive resolve — cheap operation.

**Post-migration:** the IPNS key is never re-published. The wallet is
on the pointer channel permanently. To force a re-migration (for
debugging), delete `MIGRATION_DONE_KEY` from the local cache; the
next load will re-read the IPNS record.

---

## 6. Configuration reference

### 6.1 `PointerLayerConfig`

| Field | Production default | Notes |
|---|---|---|
| `allowOperatorOverrides` | `false` | MUST be `false` in production builds (T-E26). Enables `clearBlocked`, `acceptCarLoss`, `clearPendingMarker`, `acceptCorruptStreak`. |
| `allowUnverifiedOverride` | `false` | Dev-only. Production builds throw `CAPABILITY_DENIED` at init if `true`. |

### 6.2 Environment variables

| Variable | Purpose | Production value |
|---|---|---|
| `NODE_ENV` | Production-build gate. `'production'` activates the T-E26 guard that rejects `allowOperatorOverrides=true`. Case-insensitive per the remediation. | `production` |
| `SPHERE_ALLOW_OVERRIDES` | Belt-and-braces for `allowOperatorOverrides`. Must equal `'1'` alongside the config flag. | unset |

---

## 7. Known residual risks (R-series)

### R-11 — SDK internal residual copies of ciphertext / private key

The aggregator submit path zeroes local buffers via `.fill(0)` on exit
(T-C1b, T-C1c). However, the underlying
`@unicitylabs/state-transition-sdk` may retain internal copies via
JSON serialization, base64 encoding, or wrapper classes (notably
`DataHash` and `Authenticator`). These are outside our reach to zero.

**Mitigation:** SPEC §11.11 documents this as an accepted residual
risk. Keep the SDK version pinned and audited; rotate wallet keys
periodically if operating in a hostile memory environment.

### R-12 — IPFS gateway MITM on UnixFS snapshot fetch (pre-migration)

Legacy IPNS snapshots are fetched via `/ipfs/<cid>` which does NOT
content-address verify (UnixFS wrapping). A MITM gateway could inject
bundle-ref strings into the snapshot.

**Mitigation:** the migration reader now validates each
`bundles[].cid` via `CID.parse` before handing to `addBundle` (Wave-3
remediation). The IPNS record's Ed25519 signature is verified
independently.

### R-18 — Lock ordering invariant (Node in-process layer above file lock)

The Node mutex stacks `async-mutex` in-process above `proper-lockfile`.
Acquire in-process-first, file-second; release LIFO. A reversed order
risks deadlock. Enforced by spy-instrumented test in
`tests/unit/profile/pointer/mutex.test.ts`.

### R-20 — JOIN rule coverage (partial)

T-D0 audit flagged Rules 3 + 4 as the blocking gap. Rule 3 (longest-
valid-chain selection) is implemented in `uxf/token-join.ts` (MVP).
Rule 4 (synthetic proof-enriched root) is deferred — the UXF JOIN
currently runs last-writer-wins on same-tokenId collisions for the
proof-enrichment case. Under content-addressed transactions this is
safe for the common cases; operators should watch for divergent
outcomes logged by `resolveTokenRoot`.

---

## 8. When to escalate

- `UNTRUSTED_PROOF`, `SECURITY_ORIGIN_MISMATCH`, `AGGREGATOR_REJECTED`:
  probable integrity event, do not auto-recover.
- Repeated `TRUST_BASE_STALE` after an SDK upgrade: the bundled trust
  base in the release you upgraded to is also stale — escalate to
  whoever publishes SDK builds.
- Wallet reports `BLOCKED` with reason `marker_corrupt` repeatedly:
  storage backend may not be honoring the `DURABLE_STORAGE` contract
  (fsync not actually flushing). Investigate the underlying
  filesystem / browser state; may require platform-specific
  remediation.
- `CORRUPT_STREAK` after `acceptCorruptStreak` raised to 4096: likely
  a genuine aggregator integrity event. Stop publishing, capture the
  last ~20 probe versions via `getProbeFingerprint`, escalate.
