/**
 * Single-blob sync writer for OrbitDB keys whose value is one self-
 * contained JSON array (or set), persisted under an EXACT key with NO
 * per-entry suffix.
 *
 * **Why this exists (issue #335).** All other per-address writers
 * (`OutboxWriter`, `SentLedgerWriter`, `PrefixSyncWriter`-based
 * disposition/finalization/recipient-context) own a `keyPrefix` that
 * ends with `.` — they fan out into per-entry keys
 * (`${addressId}.outbox.${id}`, `${addressId}.audit.${tokenId}`, etc.).
 * The lean-snapshot dispatcher (`profile-snapshot-dispatcher.ts`)
 * pre-filters snapshot entries with `e.key.startsWith(keyPrefix)`, so
 * each per-entry-prefix writer receives only its own slice.
 *
 * A small number of OrbitDB keys are NOT per-entry — they are a single
 * blob whose value contains the entire collection (e.g.
 * `${addressId}.tombstones` is a `TxfTombstone[]` array;
 * `${addressId}.invalidatedNametags` is a `string[]` set). Before this
 * module existed, those keys had no registered dispatcher writer, so
 * cross-device snapshot apply silently dropped them. For
 * `${addressId}.tombstones` this caused the soak regression in
 * `bob-peer1-vs-peer2-after`: peer2 recovered from the aggregator-
 * pointer snapshot without the spent-token tombstones, then re-ingested
 * a CAR bundle that contained the spent source token as if it were
 * live, doubling the post-recovery balance.
 *
 * **Semantics — union merge, not byte-verbatim.** Per-entry writers
 * persist remote bytes verbatim because each key is independently
 * owned (one writer per key). Single-blob keys are jointly owned: peer
 * A and peer B may each have observed local-only entries before
 * sync'ing, and a byte-verbatim apply of either side's blob would lose
 * the other side's entries. This writer decrypts both sides, computes
 * the SET UNION (dedup via a caller-supplied key function), and writes
 * back the merged JSON re-encrypted under the same exact key.
 *
 * This matches the existing in-memory union semantics used by
 * `PaymentsModule.mergeTombstones` (modules/payments/PaymentsModule.ts)
 * and the on-disk RMW union loop in
 * `ProfileTokenStorageProvider.writeOrbitOperationalState` (the
 * `merged.invalidatedNametags = Array.from(new Set([...remote, ...opState]))`
 * pattern). Convergence is monotonic and idempotent — re-running the
 * JOIN with the same remote is a no-op once the first pass converges.
 *
 * **Counter semantics.** A single entry in the snapshot translates to
 * `entriesEvaluated: 1`:
 *   - `liveLanded: 1` if the union added at least one new dedup-key
 *     and the writer persisted the merged blob;
 *   - `localWon: 1` if local was already a superset (no writeback);
 *   - `remoteRejectedMalformed: 1` if decrypt / JSON parse / shape
 *     check failed, or the underlying writeback threw.
 *
 * Tombstones in the merge-table sense (the `{ tombstoned: true }`
 * marker pattern used by `PrefixSyncWriter`) do NOT apply to a single-
 * blob key: the entire blob IS the collection. The on-disk
 * representation is a JSON array (or set) — there is no "soft delete"
 * marker. `tombstonesLanded` is therefore always 0 for this writer;
 * the `liveLanded`/`localWon` columns cover every relevant outcome.
 *
 * **Encryption + envelope.** The writer:
 *   - decrypts incoming snapshot bytes after defensively stripping an
 *     OpLog envelope if present (`unwrapEnvelopeBytes`) — mirrors the
 *     pre-#247 vs post-#247 dual format handling that `OutboxWriter`,
 *     `SentLedgerWriter`, and `PrefixSyncWriter` already implement;
 *   - re-encrypts the merged blob with a fresh IV and writes via
 *     `putEnvelopePayload` so the on-disk format stays envelope-wrapped
 *     (the canonical post-#247 layout consumed by
 *     `ProfileTokenStorageProvider.readProfileKey`).
 *
 * **Out of scope.** Single-blob writers cannot use the Lamport-based
 * (live, tombstone) merge table from `profile-snapshot-merge.ts` — the
 * blob is a flat array with no per-element Lamport. The union merge
 * here is fundamentally a set-CRDT (deletes are not propagated at the
 * blob level — they require explicit GC at the publish side, e.g.
 * `gcExpiredTombstones`). If a future requirement adds blob-level
 * deletion semantics, this writer can be extended with a tombstone
 * marker shape akin to `PrefixSyncWriter`.
 *
 * @module profile/single-blob-sync-writer
 * @see profile/factory.ts — `writersFor()` registration site
 * @see profile/profile-snapshot-dispatcher.ts — dispatcher contract
 * @see profile/prefix-sync-writer.ts — sibling for per-entry keys
 */

import { decryptProfileValue, encryptProfileValue } from './encryption.js';
import {
  putEnvelopePayload,
  unwrapEnvelopeBytes,
} from './oplog-envelope-io.js';
import type {
  JoinResult,
  ProfileSyncWriter,
  SnapshotEntry,
} from './profile-snapshot-merge.js';
import type { ProfileDatabase } from './types.js';
import { MAX_ENTRY_BYTES_RAW } from '../types/uxf-bounds.js';

// =============================================================================
// 1. Options
// =============================================================================

/**
 * Per-instance options for {@link SingleBlobSyncWriter}.
 *
 * Construction-time invariants:
 *   - `key` MUST be a non-empty string with no trailing `.` (it is the
 *     EXACT OrbitDB key, not a prefix).
 *   - `encryptionKey` SHOULD be non-null in production; `null` disables
 *     encryption (matches the rest of the profile layer's optionality
 *     and is used by test fixtures).
 */
export interface SingleBlobSyncWriterOptions<T> {
  /** OrbitDB key-value adapter — the writer's underlying store. */
  readonly db: ProfileDatabase;
  /** AES-256 key for encrypt/decrypt. `null` disables encryption. */
  readonly encryptionKey: Uint8Array | null;
  /** EXACT OrbitDB key (e.g. `"${addressId}.tombstones"`). */
  readonly key: string;
  /**
   * Validator for the decoded JSON. MUST return `true` if the parsed
   * value is a well-formed collection (typically an array of `T`).
   * Returning `false` for remote payloads causes the entry to be
   * rejected as malformed and the local blob is left untouched.
   */
  readonly validate: (decoded: unknown) => decoded is ReadonlyArray<T>;
  /**
   * Dedup-key extractor. The union merge inserts every remote item
   * whose `dedupKey(item)` is not already present in the local set.
   * The function MUST be pure and deterministic.
   */
  readonly dedupKey: (item: T) => string;
  /**
   * Optional tie-breaker on dedup collision. Called when both sides
   * carry an item with the same `dedupKey`. The returned item replaces
   * the local one. Defaults to "keep local" (no replacement). Use this
   * to prefer the earliest timestamp on tombstones, or a stricter
   * shape on heterogeneous payloads.
   */
  readonly preferOnCollision?: (local: T, remote: T) => T;
  /**
   * Fired once after a JOIN that landed at least one new item — same
   * contract as the `notifyProfileDirty` hook on `PrefixSyncWriter`.
   * The next dirty-flush re-publishes the union so peers downstream
   * also converge.
   */
  readonly notifyProfileDirty?: () => void;
  /** Label for diagnostics. Defaults to `'SingleBlobSyncWriter'`. */
  readonly label?: string;
}

// =============================================================================
// 2. SingleBlobSyncWriter
// =============================================================================

/**
 * Set-CRDT union writer for OrbitDB single-blob keys. See module-level
 * doc-comment for the full rationale.
 */
export class SingleBlobSyncWriter<T> implements ProfileSyncWriter {
  private readonly db: ProfileDatabase;
  private readonly encryptionKey: Uint8Array | null;
  private readonly key: string;
  private readonly validate: (decoded: unknown) => decoded is ReadonlyArray<T>;
  private readonly dedupKey: (item: T) => string;
  private readonly preferOnCollision: ((local: T, remote: T) => T) | null;
  private readonly notifyProfileDirty: (() => void) | null;

  constructor(opts: SingleBlobSyncWriterOptions<T>) {
    if (typeof opts.key !== 'string' || opts.key.length === 0) {
      throw new TypeError(
        'SingleBlobSyncWriter: key must be a non-empty string',
      );
    }
    if (opts.key.endsWith('.')) {
      // Prefix-style keys belong on PrefixSyncWriter; reject here so a
      // future refactor that mis-routes a per-entry key fails loudly
      // rather than silently mis-merging at JOIN time.
      throw new TypeError(
        'SingleBlobSyncWriter: key must NOT end with "." — use PrefixSyncWriter for per-entry keys',
      );
    }
    this.db = opts.db;
    this.encryptionKey = opts.encryptionKey;
    this.key = opts.key;
    this.validate = opts.validate;
    this.dedupKey = opts.dedupKey;
    this.preferOnCollision = opts.preferOnCollision ?? null;
    this.notifyProfileDirty = opts.notifyProfileDirty ?? null;
  }

  /**
   * Return the (at-most-one) snapshot entry for this writer's exact
   * key. Returns an empty array when the key is absent. Bytes are the
   * envelope-stripped ciphertext suitable for receiver-side decrypt.
   */
  async snapshot(): Promise<ReadonlyArray<SnapshotEntry>> {
    let raw: Uint8Array | null;
    try {
      raw = await this.db.get(this.key);
    } catch {
      return [];
    }
    if (raw === null || raw.byteLength === 0) return [];
    // `db.get` may return either an envelope-wrapped CBOR record
    // (post-#247 writes via putEntry / putEnvelopePayload) or raw
    // ciphertext (pre-#247 legacy writes). Strip the envelope so the
    // emitted snapshot entry carries the inner ciphertext consistently
    // — same format the lean-snapshot exporter produces via
    // `getEncryptedRaw` on the ProfileStorageProvider path.
    const ciphertext = unwrapEnvelopeBytes(raw);
    return [{ key: this.key, encryptedValue: ciphertext }];
  }

  /**
   * Apply a remote single-blob snapshot. The dispatcher pre-filters
   * the snapshot to entries whose key starts with this writer's
   * configured key — defense-in-depth, this method enforces an EXACT
   * match below.
   */
  async joinSnapshot(
    remote: ReadonlyArray<SnapshotEntry>,
  ): Promise<JoinResult> {
    let entriesEvaluated = 0;
    let liveLanded = 0;
    let localWon = 0;
    let remoteRejectedMalformed = 0;

    for (const entry of remote) {
      if (entry.key !== this.key) {
        // Foreign key — the dispatcher's `startsWith` pre-filter may
        // surface this writer's slice plus any longer keys that share
        // the prefix. Skip silently (no counter bump) so foreign
        // entries do not pollute the malformed-counter signal.
        continue;
      }
      entriesEvaluated += 1;

      const remoteItems = await this.decodeBlob(
        entry.encryptedValue,
        /* remote = */ true,
      );
      if (remoteItems === null) {
        remoteRejectedMalformed += 1;
        continue;
      }

      const localItems = await this.readLocalBlob();
      const merged = this.union(localItems, remoteItems);
      if (merged === null) {
        // Local was already a superset → nothing to write.
        localWon += 1;
        continue;
      }

      try {
        await this.writeMerged(merged);
        liveLanded += 1;
      } catch {
        remoteRejectedMalformed += 1;
      }
    }

    if (liveLanded > 0 && this.notifyProfileDirty !== null) {
      try {
        this.notifyProfileDirty();
      } catch {
        // Best-effort signal — never propagate notifier errors.
      }
    }

    return {
      entriesEvaluated,
      liveLanded,
      tombstonesLanded: 0,
      localWon,
      remoteRejectedMalformed,
    };
  }

  /**
   * Compute the union of local + remote. Returns `null` when every
   * remote item's dedup key is already present locally AND the
   * collision tie-breaker (if configured) does not prefer any remote
   * variant — the caller treats this as `localWon` and skips writeback.
   */
  private union(
    local: ReadonlyArray<T>,
    remote: ReadonlyArray<T>,
  ): ReadonlyArray<T> | null {
    const merged: T[] = [...local];
    const indexByKey = new Map<string, number>();
    for (let i = 0; i < merged.length; i += 1) {
      indexByKey.set(this.dedupKey(merged[i]), i);
    }

    let changed = false;
    for (const item of remote) {
      const key = this.dedupKey(item);
      const idx = indexByKey.get(key);
      if (idx === undefined) {
        indexByKey.set(key, merged.length);
        merged.push(item);
        changed = true;
        continue;
      }
      if (this.preferOnCollision !== null) {
        const next = this.preferOnCollision(merged[idx], item);
        if (next !== merged[idx]) {
          merged[idx] = next;
          changed = true;
        }
      }
    }

    return changed ? merged : null;
  }

  /**
   * Read + decode the local blob. Returns an empty array when the key
   * is absent OR when decode fails — in both cases the union below
   * treats local as "nothing to keep", so a well-formed remote lands
   * intact. This biases convergence toward propagating remote state on
   * local corruption, matching the convention used elsewhere in the
   * profile sync layer (`PrefixSyncWriter`, `runJoinSnapshot`).
   */
  private async readLocalBlob(): Promise<ReadonlyArray<T>> {
    let raw: Uint8Array | null;
    try {
      raw = await this.db.get(this.key);
    } catch {
      return [];
    }
    if (raw === null || raw.byteLength === 0) return [];
    const ciphertext = unwrapEnvelopeBytes(raw);
    const decoded = await this.decodeBlob(ciphertext, /* remote = */ false);
    return decoded ?? [];
  }

  /**
   * Decrypt + JSON-parse + validate a ciphertext blob.
   *
   * `remote=true` is the strict path: any failure (decrypt, parse,
   * shape) returns `null` so the caller bumps `remoteRejectedMalformed`
   * and leaves local untouched. `remote=false` (local read) returns
   * `null` the same way, but the caller treats `null` as "empty local"
   * for the union — letting a well-formed remote land cleanly even
   * when local is corrupted.
   */
  private async decodeBlob(
    raw: Uint8Array,
    _remote: boolean,
  ): Promise<ReadonlyArray<T> | null> {
    if (raw.byteLength === 0) return null;
    if (raw.byteLength > MAX_ENTRY_BYTES_RAW) return null;
    const ciphertext = unwrapEnvelopeBytes(raw);
    let plaintextBytes: Uint8Array;
    try {
      plaintextBytes = this.encryptionKey
        ? await decryptProfileValue(this.encryptionKey, ciphertext)
        : ciphertext;
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(plaintextBytes));
    } catch {
      return null;
    }
    if (!this.validate(parsed)) return null;
    return parsed;
  }

  /**
   * Encrypt + envelope-wrap + persist the merged blob under this
   * writer's exact key.
   *
   * Goes through `putEnvelopePayload` so the on-disk format is the
   * canonical post-#247 envelope — the same format
   * `ProfileTokenStorageProvider.writeProfileKey` produces. This keeps
   * subsequent reads via `getEnvelopePayload` on the happy path (no
   * legacy raw-bytes fallback).
   */
  private async writeMerged(merged: ReadonlyArray<T>): Promise<void> {
    const plaintext = new TextEncoder().encode(JSON.stringify(merged));
    const ciphertext = this.encryptionKey
      ? await encryptProfileValue(this.encryptionKey, plaintext)
      : plaintext;
    await putEnvelopePayload(this.db, this.key, ciphertext);
  }
}

// =============================================================================
// 3. Type-safe builders for the two single-blob keys wired by issue #335
// =============================================================================

/**
 * Build a {@link SingleBlobSyncWriter} for `${addressId}.tombstones`.
 *
 * Tombstones are deduped by the composite `${tokenId}:${stateHash}`
 * key — the same key `PaymentsModule.mergeTombstones` and the
 * `readOperationalState` merge use. On collision the EARLIEST
 * timestamp wins so two replicas that independently recorded the same
 * tombstone (with different wall-clock stamps) converge deterministically.
 */
export function buildTombstonesSyncWriter(opts: {
  readonly db: ProfileDatabase;
  readonly encryptionKey: Uint8Array | null;
  readonly addressId: string;
  readonly notifyProfileDirty?: () => void;
}): SingleBlobSyncWriter<TombstoneShape> {
  if (typeof opts.addressId !== 'string' || opts.addressId.length === 0) {
    throw new TypeError(
      'buildTombstonesSyncWriter: addressId must be a non-empty string',
    );
  }
  return new SingleBlobSyncWriter<TombstoneShape>({
    db: opts.db,
    encryptionKey: opts.encryptionKey,
    key: `${opts.addressId}.tombstones`,
    validate: isTombstoneArray,
    dedupKey: (t) => `${t.tokenId}:${t.stateHash}`,
    preferOnCollision: (local, remote) =>
      remote.timestamp < local.timestamp ? remote : local,
    notifyProfileDirty: opts.notifyProfileDirty,
    label: 'SingleBlobSyncWriter.tombstones',
  });
}

/**
 * Build a {@link SingleBlobSyncWriter} for
 * `${addressId}.invalidatedNametags`.
 *
 * The collection is a `string[]` set; dedup key is the string itself.
 * No collision tie-break needed — equal strings are equal payloads.
 */
export function buildInvalidatedNametagsSyncWriter(opts: {
  readonly db: ProfileDatabase;
  readonly encryptionKey: Uint8Array | null;
  readonly addressId: string;
  readonly notifyProfileDirty?: () => void;
}): SingleBlobSyncWriter<string> {
  if (typeof opts.addressId !== 'string' || opts.addressId.length === 0) {
    throw new TypeError(
      'buildInvalidatedNametagsSyncWriter: addressId must be a non-empty string',
    );
  }
  return new SingleBlobSyncWriter<string>({
    db: opts.db,
    encryptionKey: opts.encryptionKey,
    key: `${opts.addressId}.invalidatedNametags`,
    validate: isStringArray,
    dedupKey: (s) => s,
    notifyProfileDirty: opts.notifyProfileDirty,
    label: 'SingleBlobSyncWriter.invalidatedNametags',
  });
}

// =============================================================================
// 4. Shape predicates
// =============================================================================

/** Local copy of TxfTombstone (kept here to avoid a storage layer import). */
interface TombstoneShape {
  readonly tokenId: string;
  readonly stateHash: string;
  readonly timestamp: number;
}

function isTombstoneArray(value: unknown): value is ReadonlyArray<TombstoneShape> {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (item === null || typeof item !== 'object') return false;
    const r = item as Record<string, unknown>;
    if (typeof r.tokenId !== 'string' || r.tokenId.length === 0) return false;
    if (typeof r.stateHash !== 'string' || r.stateHash.length === 0) return false;
    if (typeof r.timestamp !== 'number' || !Number.isFinite(r.timestamp)) return false;
  }
  return true;
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (typeof item !== 'string') return false;
  }
  return true;
}
