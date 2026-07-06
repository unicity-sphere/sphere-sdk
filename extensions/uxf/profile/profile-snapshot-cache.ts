/**
 * Profile Snapshot Cache — Issue #313
 *
 * Atomic-write / atomic-read of a single local-storage blob holding the
 * wallet's most-recent in-memory state. Used by `LifecycleManager` to
 * SEED the wallet view at cold boot WITHOUT waiting for the aggregator
 * pointer recovery or any remote IPFS round trip.
 *
 * # Boot sequence (post-#313)
 *
 *   T+0      open local storage (IndexedDB / file)
 *   T+10ms   read the snapshot blob via `readSnapshot()`
 *   T+15ms   seed `host.lastLoadedData` + `host.knownBundleCids` +
 *            `host.lastDiscoveredPointerCid` from the blob; emit
 *            `profile:snapshot-loaded` event — UI renders the wallet
 *   T+...    `LifecycleManager.initialize()` continues normally:
 *            OrbitDB connect → bundle-index refresh → aggregator pointer
 *            recovery → if newer state observed, FlushScheduler writes a
 *            new snapshot via `writeSnapshot()` and emits
 *            `profile:snapshot-refreshed`.
 *
 * # Write semantics
 *
 * `writeSnapshot()` uses a temp-key + swap pattern to prevent partial
 * writes from being read as truth on the next boot:
 *
 *   1. Compute the snapshot bytes (JSON.stringify of the schema below)
 *      and embed a sha256 content hash for tamper detection.
 *   2. If the storage provider implements `setMany()` (IndexedDB
 *      transaction, FileStorage atomic batch), issue
 *      `[pendingKey, blob], [mainKey, blob]` and on success
 *      `remove(pendingKey)`. All within a single durable transaction.
 *   3. If `setMany()` is unavailable, fall back to:
 *        a. `set(pendingKey, blob)`
 *        b. `set(mainKey, blob)`
 *        c. `remove(pendingKey)`  (best effort; a stale pending key
 *           does not corrupt the main key)
 *
 * On crash between `(a)` and `(b)`, the next boot finds the previous
 * mainKey blob intact AND a pending blob. `readSnapshot()` prefers
 * mainKey; the stale pending blob is cleaned up on the next successful
 * write.
 *
 * # Read semantics
 *
 * `readSnapshot()` accepts the wallet identity, reads the mainKey blob,
 * parses + validates the schema (version, walletId match, content hash),
 * and returns a typed result. Validation failures route through a
 * structured `SnapshotReadResult` so callers can choose to emit a
 * `profile:snapshot-corrupt` event and continue with the slow path
 * (OpLog walk) without crashing.
 *
 * # Schema
 *
 * Single JSON blob; the field set is minimised to "what the UI needs
 * BEFORE remote state arrives":
 *
 *   {
 *     version:    1                            // bump on incompatible change
 *     walletId:   string                       // chainPubkey hex (binds to wallet)
 *     addressId:  string                       // per-derived-address id
 *     network:    string                       // testnet/mainnet/dev
 *     ts:         number                       // creation ms-since-epoch
 *     epoch:      number | null                // OpLog epoch (when known)
 *     pointer:    { version: number; cid: string; ts: number } | null
 *     bundleCids: ReadonlyArray<string>        // active bundle CIDs primed at boot
 *     data:       TxfStorageDataBase           // serialised wallet state
 *     contentHash: string                      // sha256 hex over the canonical-stringified
 *                                              // pre-image (all other fields)
 *   }
 *
 * # Backward compatibility
 *
 * Wallets that have never written a snapshot return `{ found: false }`
 * and the old boot path runs unchanged. A schema-version mismatch is
 * treated as corruption (clean + re-write on next flush) — this lets
 * post-upgrade boots silently re-build the cache rather than carrying
 * a stale shape forward.
 *
 * @see profile/profile-token-storage/lifecycle-manager.ts initialize()
 * @see profile/profile-token-storage/flush-scheduler.ts flushToIpfs()
 */

import type { StorageProvider, TxfStorageDataBase } from '../../../storage/storage-provider.js';
import { STORAGE_KEYS_GLOBAL } from '../../../constants.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { time } from '../../../core/perf-counters.js';

/**
 * Current snapshot schema version. Bumped on incompatible changes; the
 * reader treats a mismatched version as corruption and falls through to
 * the slow boot path. Wallets upgrading from a prior SDK version will
 * pay the cold-boot cost once, then operate from the new cache shape
 * thereafter.
 */
export const PROFILE_SNAPSHOT_SCHEMA_VERSION = 1 as const;

/**
 * Pointer cache embedded in the snapshot blob — mirrors the runtime
 * `lastDiscoveredPointerCid` accessor on the token-storage host so the
 * next boot can short-circuit `recoverLatest()` when the pointer hasn't
 * changed.
 */
export interface ProfileSnapshotPointer {
  readonly version: number;
  readonly cid: string;
  /** When the pointer was first observed by THIS wallet (ms since epoch). */
  readonly ts: number;
}

/**
 * Canonical snapshot blob shape. Persisted as a single JSON record under
 * `STORAGE_KEYS_GLOBAL.PROFILE_SNAPSHOT_BLOB_<addressId>`.
 */
export interface ProfileSnapshotBlob {
  readonly version: typeof PROFILE_SNAPSHOT_SCHEMA_VERSION;
  /**
   * Chain pubkey hex (binds the snapshot to a specific wallet). A
   * cross-wallet read returns false and surfaces a `walletId` mismatch
   * reason — defends against snapshot reuse across different mnemonics
   * sharing the same on-disk storage (e.g., dev profiles).
   */
  readonly walletId: string;
  /** Per-derived-address id (DIRECT_xxxxxx_xxxxxx). */
  readonly addressId: string;
  /** Network identifier (testnet/mainnet/dev). */
  readonly network: string;
  /** Snapshot creation timestamp (ms since epoch). */
  readonly ts: number;
  /** OpLog epoch from the recovery marker, or null when never reset. */
  readonly epoch: number | null;
  /** Last-known aggregator pointer, or null when never observed. */
  readonly pointer: ProfileSnapshotPointer | null;
  /** Active bundle CIDs at snapshot time. */
  readonly bundleCids: ReadonlyArray<string>;
  /** Serialised wallet state (tokens + operational state). */
  readonly data: TxfStorageDataBase;
  /**
   * sha256 hex over the canonical pre-image. Failed verification → the
   * blob is treated as corrupt (partial write or tampering).
   */
  readonly contentHash: string;
}

/**
 * Structured result of {@link readSnapshot}. Distinguishes between
 * "never written" (no event), "valid and applied" (emit
 * `profile:snapshot-loaded`), and "corrupt / mismatched" (emit
 * `profile:snapshot-corrupt`).
 */
export type SnapshotReadResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ok'; readonly blob: ProfileSnapshotBlob; readonly ageMs: number }
  | { readonly kind: 'corrupt'; readonly reason: string; readonly walletId?: string };

/**
 * Compose the per-address storage key for the snapshot blob. Mirrors
 * `ProfileTokenStorageProvider.getPendingPublishCidKey()` — both rely on
 * the `addressId` computed by `setIdentity()`.
 */
export function getSnapshotBlobKey(addressId: string): string {
  return `${STORAGE_KEYS_GLOBAL.PROFILE_SNAPSHOT_BLOB}_${addressId}`;
}

/**
 * Pending-write companion key — see the temp-key + swap pattern in the
 * module header. `readSnapshot()` does NOT read from this key (it could
 * contain a partial write); a stale entry is cleaned up on the next
 * successful write.
 */
export function getSnapshotPendingKey(addressId: string): string {
  return `${getSnapshotBlobKey(addressId)}_pending`;
}

/**
 * Per-address storage key for the standalone last-pointer record.
 * Redundant with the `pointer` field inside the snapshot blob, but
 * cheaper to read in isolation when callers only need the version /
 * CID (no full blob deserialisation). Currently unused by the cold-boot
 * path (the blob's pointer field is canonical); reserved for future
 * lightweight pre-checks.
 */
export function getLastPointerKey(addressId: string): string {
  return `${STORAGE_KEYS_GLOBAL.PROFILE_LAST_POINTER}_${addressId}`;
}

/**
 * Compute sha256 hex over the canonical pre-image of `blob` (all fields
 * except `contentHash`). Stable across JSON-encoder differences thanks
 * to the explicit field ordering below.
 *
 * The pre-image deliberately uses `JSON.stringify` with explicit keys
 * rather than rolling a hand-written serialiser — the result is not
 * cryptographically committed to wire bytes, only used as a tamper
 * detector against partial writes / on-disk corruption.
 */
function computeContentHash(blob: Omit<ProfileSnapshotBlob, 'contentHash'>): string {
  // Canonical key order — version → walletId → addressId → network →
  // ts → epoch → pointer → bundleCids → data. Mirrors the field order
  // in the interface so a reviewer cross-checking the two stays sane.
  const preimage = JSON.stringify({
    version: blob.version,
    walletId: blob.walletId,
    addressId: blob.addressId,
    network: blob.network,
    ts: blob.ts,
    epoch: blob.epoch,
    pointer: blob.pointer,
    bundleCids: blob.bundleCids,
    data: blob.data,
  });
  const bytes = new TextEncoder().encode(preimage);
  const hash = nobleSha256(bytes);
  let hex = '';
  for (let i = 0; i < hash.length; i++) {
    hex += hash[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Input contract for {@link writeSnapshot}. The caller (FlushScheduler /
 * LifecycleManager / shutdown path) constructs this from the live host
 * state at flush-complete time.
 */
export interface WriteSnapshotInput {
  readonly walletId: string;
  readonly addressId: string;
  readonly network: string;
  readonly epoch: number | null;
  readonly pointer: ProfileSnapshotPointer | null;
  readonly bundleCids: ReadonlyArray<string>;
  readonly data: TxfStorageDataBase;
  /**
   * Optional injected clock — tests pin a deterministic timestamp;
   * production omits this and uses `Date.now()`. Kept as a function so a
   * test can advance time between successive writes without re-wiring.
   */
  readonly now?: () => number;
}

/**
 * Atomically write the snapshot blob. Returns the timestamp that was
 * embedded in the blob (caller logs / emits `profile:snapshot-refreshed`
 * from this).
 *
 * # Atomicity contract
 *
 * The implementation uses the storage provider's `setMany()` when
 * available (browser IndexedDB transaction, FileStorage atomic batch).
 * `setMany()` commits all keys or none — guaranteed by both production
 * implementations (`IndexedDBStorageProvider.setMany` wraps a single
 * IDBTransaction; `FileStorageProvider.setMany` uses an internal
 * journal).
 *
 * If `setMany()` is absent (test stub, third-party storage), the
 * fallback path is:
 *   1. `set(pendingKey, blob)` — must succeed before main is touched
 *   2. `set(mainKey, blob)` — overwrites the previous main blob
 *   3. `remove(pendingKey)` — best-effort cleanup
 *
 * Crash between (1) and (2): main retains the previous valid snapshot,
 * pending is stale (cleaned up on next write).
 * Crash between (2) and (3): main is fresh, pending is a duplicate.
 * Either way the next `readSnapshot()` returns the latest VALID blob.
 *
 * # Failure handling
 *
 * Any underlying storage failure (transient IndexedDB error, disk full)
 * REJECTS. Caller logs + emits `storage:error`. The previous valid blob
 * is NEVER replaced by a partial / failed write — that is the central
 * crash-safety guarantee.
 */
export async function writeSnapshot(
  storage: StorageProvider,
  input: WriteSnapshotInput,
): Promise<number> {
  return time('snapshotCache.writeSnapshot', () => _writeSnapshotImpl(storage, input));
}
async function _writeSnapshotImpl(
  storage: StorageProvider,
  input: WriteSnapshotInput,
): Promise<number> {
  const ts = (input.now ?? Date.now)();
  const blobNoHash: Omit<ProfileSnapshotBlob, 'contentHash'> = {
    version: PROFILE_SNAPSHOT_SCHEMA_VERSION,
    walletId: input.walletId,
    addressId: input.addressId,
    network: input.network,
    ts,
    epoch: input.epoch,
    pointer: input.pointer,
    bundleCids: input.bundleCids,
    data: input.data,
  };
  const contentHash = computeContentHash(blobNoHash);
  const blob: ProfileSnapshotBlob = { ...blobNoHash, contentHash };
  const serialized = JSON.stringify(blob);

  const mainKey = getSnapshotBlobKey(input.addressId);
  const pendingKey = getSnapshotPendingKey(input.addressId);

  // Preferred path: atomic multi-key write — both `pendingKey` and
  // `mainKey` land in one transaction. A crash inside the transaction
  // rolls back both writes; the previous valid blob at `mainKey` stays
  // intact.
  //
  // We deliberately write both rather than just `mainKey` so that
  // observers (e.g. another wallet instance reading the same storage)
  // never observe a window where the main blob is updated but the
  // pending blob is stale from a prior write. After the transaction
  // commits, `pendingKey` is removed as a separate write — this is
  // best-effort and a leftover pending blob is benign (readSnapshot
  // ignores it).
  if (typeof storage.setMany === 'function') {
    await storage.setMany([
      [pendingKey, serialized],
      [mainKey, serialized],
    ]);
    // Best-effort cleanup of the now-redundant pending blob. A failure
    // here leaves a duplicate copy — readSnapshot tolerates it.
    try {
      await storage.remove(pendingKey);
    } catch {
      // intentional: pending leftover is benign
    }
    return ts;
  }

  // Fallback: sequential writes. The intermediate pending write means a
  // crash between steps 1 and 2 leaves `mainKey` at the PREVIOUS valid
  // value; step 2 overwrites it only after step 1 has fully succeeded.
  await storage.set(pendingKey, serialized);
  await storage.set(mainKey, serialized);
  try {
    await storage.remove(pendingKey);
  } catch {
    // intentional: pending leftover is benign
  }
  return ts;
}

/**
 * Read the snapshot blob for the given wallet identity. Returns a
 * structured result so callers can route on:
 *
 *   - `absent`  — no blob has ever been written. Caller emits no event
 *                 and runs the normal slow-boot path.
 *   - `ok`     — blob parsed + validated + walletId matched. Caller
 *                 seeds in-memory state and emits
 *                 `profile:snapshot-loaded`.
 *   - `corrupt` — blob was present but parse/validation failed. Caller
 *                 removes the blob (so the next write replaces it
 *                 cleanly), emits `profile:snapshot-corrupt`, and runs
 *                 the slow-boot path.
 *
 * # walletId binding
 *
 * The reader compares the blob's `walletId` to the expected
 * `expectedWalletId` argument. A mismatch is reported as a `corrupt`
 * result with `reason = 'walletId-mismatch'`. This defends against:
 *   - Two wallets that share an on-disk storage directory (e.g., CLI
 *     `--dataDir` reused across mnemonics) — the second wallet's
 *     identity does not match the first's snapshot.
 *   - A wallet imported from a different mnemonic on the same browser
 *     after the previous wallet was cleared but the snapshot blob
 *     survived (cleared via `Sphere.clear()` which calls
 *     `storage.clear()` — but tests / partial-clear edge cases may
 *     leave the blob behind).
 *
 * # contentHash binding
 *
 * The reader recomputes the sha256 hash and compares to the embedded
 * `contentHash`. A mismatch is reported as `reason = 'contentHash-
 * mismatch'`. This detects on-disk corruption (rare) and partial-write
 * residues that somehow bypassed the atomic-write contract.
 *
 * # Schema version
 *
 * A blob whose `version` does not match
 * {@link PROFILE_SNAPSHOT_SCHEMA_VERSION} is reported as
 * `reason = 'schema-mismatch'`. Boot continues via the slow path;
 * the next successful flush writes a fresh blob in the current schema.
 */
export async function readSnapshot(
  storage: StorageProvider,
  addressId: string,
  expectedWalletId: string,
  now: () => number = Date.now,
): Promise<SnapshotReadResult> {
  return time('snapshotCache.readSnapshot', () => _readSnapshotImpl(storage, addressId, expectedWalletId, now));
}
async function _readSnapshotImpl(
  storage: StorageProvider,
  addressId: string,
  expectedWalletId: string,
  now: () => number = Date.now,
): Promise<SnapshotReadResult> {
  const mainKey = getSnapshotBlobKey(addressId);
  let raw: string | null;
  try {
    raw = await storage.get(mainKey);
  } catch (err) {
    return {
      kind: 'corrupt',
      reason: `storage-error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (raw === null || raw.length === 0) {
    return { kind: 'absent' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      kind: 'corrupt',
      reason: `parse-error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Type-narrow + per-field validation.
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as Partial<ProfileSnapshotBlob>).version !== 'number'
  ) {
    return { kind: 'corrupt', reason: 'shape-invalid' };
  }
  const blob = parsed as ProfileSnapshotBlob;

  if (blob.version !== PROFILE_SNAPSHOT_SCHEMA_VERSION) {
    return {
      kind: 'corrupt',
      reason: `schema-mismatch: blob.version=${blob.version} expected=${PROFILE_SNAPSHOT_SCHEMA_VERSION}`,
      walletId: blob.walletId,
    };
  }

  if (
    typeof blob.walletId !== 'string' ||
    typeof blob.addressId !== 'string' ||
    typeof blob.network !== 'string' ||
    typeof blob.ts !== 'number' ||
    !Array.isArray(blob.bundleCids) ||
    blob.data === undefined ||
    blob.data === null ||
    typeof blob.contentHash !== 'string'
  ) {
    return {
      kind: 'corrupt',
      reason: 'field-types-invalid',
      walletId: blob.walletId,
    };
  }

  if (blob.walletId !== expectedWalletId) {
    return {
      kind: 'corrupt',
      reason: `walletId-mismatch: blob=${blob.walletId.slice(0, 16)}... expected=${expectedWalletId.slice(0, 16)}...`,
      walletId: blob.walletId,
    };
  }

  // Recompute hash and compare. `computeContentHash` strips the
  // `contentHash` field by construction (it only reads named fields).
  const expected = computeContentHash({
    version: blob.version,
    walletId: blob.walletId,
    addressId: blob.addressId,
    network: blob.network,
    ts: blob.ts,
    epoch: blob.epoch ?? null,
    pointer: blob.pointer ?? null,
    bundleCids: blob.bundleCids,
    data: blob.data,
  });
  if (expected !== blob.contentHash) {
    return {
      kind: 'corrupt',
      reason: 'contentHash-mismatch',
      walletId: blob.walletId,
    };
  }

  return { kind: 'ok', blob, ageMs: Math.max(0, now() - blob.ts) };
}

/**
 * Best-effort cleanup of the snapshot keys. Used on cold-boot when
 * {@link readSnapshot} returns `corrupt` — the corrupt blob is deleted
 * so it does not keep tripping the next boot, and the pending companion
 * is removed in case it is the cause.
 *
 * Failures are swallowed: a stale corrupt blob is degraded perf, not a
 * correctness bug — the next successful write replaces it.
 */
export async function clearSnapshot(
  storage: StorageProvider,
  addressId: string,
): Promise<void> {
  const mainKey = getSnapshotBlobKey(addressId);
  const pendingKey = getSnapshotPendingKey(addressId);
  try {
    await storage.remove(mainKey);
  } catch {
    // best-effort
  }
  try {
    await storage.remove(pendingKey);
  } catch {
    // best-effort
  }
}
