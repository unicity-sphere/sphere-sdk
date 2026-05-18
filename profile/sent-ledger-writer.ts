/**
 * UXF Inter-Wallet Transfer — SentLedgerWriter (Issue #97)
 *
 * Per-entry-key writer / reader for {@link UxfSentLedgerEntry}. The
 * SENT ledger is a permanent record of delivered bundles, persisted
 * under keys of the form `${addr}.sent.${id}` per
 * PROFILE-ARCHITECTURE §10.12. Companion to {@link OutboxWriter} — the
 * outbox queues in-flight transfers, the SENT ledger records what got
 * out the door.
 *
 * **Scope** — write/read only. The crash-recovery sweeper (Issue #97
 * step 6) and PaymentsModule integration (Issue #97 step 4) live
 * elsewhere and consume this writer's primitives.
 *
 * **Lamport invariant** — same §7.1 rule as OutboxWriter. On every
 * local write, the writer:
 *   1. Reads the current Lamport value AND every Lamport observed
 *      across all concurrently-stored SENT entries for the address.
 *   2. Calls {@link Lamport.bumpFor} which yields
 *      `next = max(local, observedRemotes) + 1`.
 *   3. Stamps `next` onto the entry being written.
 *
 * The Lamport instance is intentionally separate from the outbox's
 * Lamport: SENT entries form their own CRDT namespace. Sharing a clock
 * across distinct entry families would over-bump unrelated writes and
 * could produce false-ordering between independent activities (e.g.
 * a high-volume outbox storm would inflate the SENT clock without any
 * SENT writes).
 *
 * **Per-entry-key isolation** — writing entry `a` does not touch
 * entries `b` or `c`. Tombstones use the same marker shape as
 * OutboxWriter (`{ tombstoned: true, deletedAt: number }`).
 *
 * **Encryption** — values are encrypted with the same AES-256-GCM
 * scheme as the outbox writer.
 *
 * @module profile/sent-ledger-writer
 *
 * @see types/uxf-sent.ts          (entry shape)
 * @see profile/outbox-writer.ts   (analogous structure)
 * @see profile/lamport.ts         (§7.1 Lamport rule)
 */

import { SphereError } from '../core/errors.js';
import {
  isUxfSentLedgerEntry,
  type UxfSentLedgerEntry,
} from '../types/uxf-sent.js';
import { decryptProfileValue, encryptProfileValue } from './encryption.js';
import { Lamport } from './lamport.js';
import type { ProfileDatabase, TombstoneGcResult } from './types.js';
import { MAX_ENTRY_BYTES_RAW } from '../types/uxf-bounds.js';

// =============================================================================
// 1. Public option / input types
// =============================================================================

/**
 * Construction-time options for {@link SentLedgerWriter}.
 */
export interface SentLedgerWriterOptions {
  /** OrbitDB key-value adapter — same instance the provider uses. */
  readonly db: ProfileDatabase;
  /** AES-256 key for encrypting on-disk values. Pass `null` to disable
   *  encryption (parity with `OutboxWriter`). */
  readonly encryptionKey: Uint8Array | null;
  /** Address id — the `${addr}` prefix in `${addr}.sent.${id}`. */
  readonly addressId: string;
  /** Lamport clock instance. The writer mutates it on every write per
   *  §7.1. Use a fresh instance per Sphere instantiation; do NOT share
   *  with the OutboxWriter (see module-level rationale). */
  readonly lamport: Lamport;
}

/**
 * Input shape for {@link SentLedgerWriter.write}. The writer stamps
 * `_schemaVersion` and `lamport` itself.
 */
export type SentLedgerWriteInput = Omit<
  UxfSentLedgerEntry,
  '_schemaVersion' | 'lamport'
>;

/**
 * Optional second argument to {@link SentLedgerWriter.write}. Mirrors
 * the OutboxWriter shape — see {@link OutboxWriter.WriteOptions}.
 * Issue #166 P1 #2.
 */
export interface SentWriteOptions {
  /**
   * By default, calling `write()` on an id whose slot is currently a
   * tombstone is REFUSED with `OUTBOX_ENTRY_TOMBSTONED`. Pass `true`
   * ONLY for operator escape-hatch resurrections / test fixtures.
   */
  readonly allowResurrection?: boolean;
}

// =============================================================================
// 2. SentLedgerWriter
// =============================================================================

/**
 * Per-entry-key writer/reader for {@link UxfSentLedgerEntry}.
 */
export class SentLedgerWriter {
  private readonly db: ProfileDatabase;
  private readonly encryptionKey: Uint8Array | null;
  private readonly addressId: string;
  private readonly lamport: Lamport;
  private readonly keyPrefix: string;

  /**
   * OUTBOX-SEND-FOLLOWUPS item #3 — lazy in-memory `tokenId → entryId`
   * index. Populated on the first {@link contains} or
   * {@link findByTokenId} call via {@link ensureIndex}; maintained
   * incrementally by {@link write} and {@link delete}. NOT persisted —
   * each `SentLedgerWriter` instance re-derives the index from
   * {@link readAll} on first lookup after construction.
   *
   * `null` means "not yet built". The companion {@link entryTokenIds}
   * map is initialised in lockstep so an entry's prior tokenIds can be
   * looked up at maintenance time without re-reading the entry.
   */
  private tokenIndex: Map<string, Set<string>> | null = null;
  private entryTokenIds: Map<string, ReadonlyArray<string>> | null = null;

  constructor(options: SentLedgerWriterOptions) {
    if (!options.addressId || options.addressId.length === 0) {
      throw new SphereError(
        'SentLedgerWriter: addressId must be a non-empty string',
        'VALIDATION_ERROR',
      );
    }
    // Issue #166 P4 #1 — same defense-in-depth as OutboxWriter.
    // See profile/outbox-writer.ts for the prefix-overlap rationale.
    if (!/^DIRECT_[0-9a-f]{6}_[0-9a-f]{6}$/.test(options.addressId)) {
      throw new SphereError(
        `SentLedgerWriter: addressId must match DIRECT_[0-9a-f]{6}_[0-9a-f]{6} (got: ${options.addressId})`,
        'VALIDATION_ERROR',
      );
    }
    this.db = options.db;
    this.encryptionKey = options.encryptionKey;
    this.addressId = options.addressId;
    this.lamport = options.lamport;
    this.keyPrefix = `${this.addressId}.sent.`;
  }

  /**
   * Compose the on-disk key for an entry id. Exposed for callers that
   * need to read raw values directly (tests).
   */
  keyFor(id: string): string {
    return `${this.keyPrefix}${id}`;
  }

  /**
   * Write a new SENT entry at `${addr}.sent.${entry.id}`. Stamps
   * `_schemaVersion: 'uxf-1'` and a Lamport bumped per §7.1.
   *
   * Idempotent on input: writing the same `entry` twice produces two
   * distinct Lamport stamps but the same `id` slot is overwritten —
   * second write wins. Callers typically only write each SENT entry
   * once (on `delivered` / `delivered-instant` transition), but the
   * second-write-wins behaviour gives the recovery sweeper room to
   * safely re-stamp without checking existence first.
   */
  async write(
    input: SentLedgerWriteInput,
    options?: SentWriteOptions,
  ): Promise<UxfSentLedgerEntry> {
    if (typeof input.id !== 'string' || input.id.length === 0) {
      throw new SphereError(
        'SentLedgerWriter.write: input.id must be a non-empty string',
        'VALIDATION_ERROR',
      );
    }

    // Issue #166 P1 #2 — refuse-write guard against tombstone
    // resurrection. SENT tombstones are rare (the ledger is meant to
    // be permanent), but the operator escape-hatch path exists; once
    // tombstoned a SENT entry must not silently come back.
    if (options?.allowResurrection !== true) {
      const existing = await this.readTombstoneAt(input.id);
      if (existing !== null) {
        throw new SphereError(
          `SentLedgerWriter.write: refusing to resurrect tombstoned slot "${input.id}" ` +
            `(tombstone lamport=${existing.lamport}, deletedAt=${existing.deletedAt}). ` +
            `If this is intentional (operator escape-hatch / test fixture), pass { allowResurrection: true }.`,
          'OUTBOX_ENTRY_TOMBSTONED',
        );
      }
    }

    // Cold-restart correctness: same rationale as OutboxWriter — see
    // profile/outbox-writer.ts for the W39 bounds-defense explanation.
    // Rehydrate from trusted local observations BEFORE bumpFor so the
    // bounds defense doesn't reject our own prior writes on restart.
    const observedLamports = await this.collectObservedLamports();
    this.lamport.rehydrate(observedLamports);
    const next = this.lamport.bumpFor([]);

    const stamped: UxfSentLedgerEntry = {
      ...input,
      _schemaVersion: 'uxf-1',
      lamport: next,
    };

    await this.writeRaw(stamped.id, JSON.stringify(stamped));
    // OUTBOX-SEND-FOLLOWUPS item #3 — keep the in-memory index in
    // sync. No-op when the index hasn't been built yet (ensureIndex()
    // will catch up on first read).
    this.updateIndexAfterWrite(stamped.id, stamped.tokenIds);
    return stamped;
  }

  /**
   * Tombstone the SENT entry at `${addr}.sent.${id}`. Subsequent
   * {@link readAll}/{@link readOne}/{@link contains} calls treat the
   * id as absent.
   *
   * In normal operation, SENT entries are NEVER deleted — the ledger
   * is a permanent record. This API exists for operator escape-hatch
   * scenarios (e.g. recovery from a poisoned ledger) and tests.
   */
  async delete(id: string): Promise<void> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new SphereError(
        'SentLedgerWriter.delete: id must be a non-empty string',
        'VALIDATION_ERROR',
      );
    }
    // Issue #166 P1 #2 — Lamport-stamp the tombstone. Same rationale
    // as OutboxWriter.delete.
    const observedLamports = await this.collectObservedLamports();
    this.lamport.rehydrate(observedLamports);
    const lamport = this.lamport.bumpFor([]);
    const tombstone = JSON.stringify({
      tombstoned: true,
      deletedAt: Date.now(),
      lamport,
    });
    await this.writeRaw(id, tombstone);
    // OUTBOX-SEND-FOLLOWUPS item #3 — clear the index slot for this id.
    this.removeFromIndexAfterDelete(id);
  }

  /**
   * OUTBOX-SEND-FOLLOWUPS item #4 — reclaim storage occupied by SENT-
   * ledger tombstones older than `opts.retentionMs`.
   *
   * SENT-ledger tombstones are rare (the ledger is permanent in
   * normal operation; tombstones only appear on operator escape-
   * hatch or test fixture paths), so this sweep is largely a
   * defensive surface — but the same monotonic-growth concern that
   * motivates the OUTBOX sweep applies here. See
   * {@link OutboxWriter.gcExpiredTombstones} for the full safety
   * contract; the implementation is structurally identical.
   */
  async gcExpiredTombstones(opts: {
    readonly retentionMs: number;
    readonly now?: number;
  }): Promise<TombstoneGcResult> {
    if (
      typeof opts.retentionMs !== 'number' ||
      !Number.isFinite(opts.retentionMs) ||
      opts.retentionMs < 0
    ) {
      throw new SphereError(
        `SentLedgerWriter.gcExpiredTombstones: retentionMs must be a non-negative finite number ` +
          `(got ${String(opts.retentionMs)})`,
        'VALIDATION_ERROR',
      );
    }
    const nowMs =
      typeof opts.now === 'number' && Number.isFinite(opts.now)
        ? opts.now
        : Date.now();

    let entries: Map<string, Uint8Array>;
    try {
      entries = await this.db.all(this.keyPrefix);
    } catch {
      return { scanned: 0, purged: 0, kept: 0, skipped: true };
    }

    let scanned = 0;
    let purged = 0;
    let kept = 0;
    for (const key of entries.keys()) {
      if (!key.startsWith(this.keyPrefix)) continue;
      const shape = await this.readSlotShape(key);
      if (shape === null) continue;
      if (shape.kind !== 'tombstone') continue;
      scanned += 1;
      // Defensive: same `deletedAt === 0` guard as
      // `OutboxWriter.gcExpiredTombstones`. See that method for the
      // full rationale — a malformed tombstone still functions as a
      // refuse-write guard, and purging without a real timestamp
      // risks resurrection by a pre-sync replica.
      if (shape.deletedAt === 0) {
        kept += 1;
        continue;
      }
      if (nowMs - shape.deletedAt <= opts.retentionMs) {
        kept += 1;
        continue;
      }
      try {
        await this.db.del(key);
        purged += 1;
      } catch {
        kept += 1;
      }
    }
    return { scanned, purged, kept, skipped: false };
  }

  /**
   * Read a single entry at `${addr}.sent.${id}`. Returns `null` if the
   * key is absent OR carries a tombstone marker OR fails to classify.
   */
  async readOne(id: string): Promise<UxfSentLedgerEntry | null> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new SphereError(
        'SentLedgerWriter.readOne: id must be a non-empty string',
        'VALIDATION_ERROR',
      );
    }
    const decoded = await this.readDecoded(this.keyFor(id));
    if (decoded === null) return null;
    if (!isUxfSentLedgerEntry(decoded)) return null;
    return decoded;
  }

  /**
   * Prefix-scan all SENT entries under `${addr}.sent.*`. Skips
   * tombstones and entries that fail the schema guard. Stable order:
   * ascending lexicographic key.
   */
  async readAll(): Promise<ReadonlyArray<UxfSentLedgerEntry>> {
    let entries: Map<string, Uint8Array>;
    try {
      entries = await this.db.all(this.keyPrefix);
    } catch {
      return [];
    }
    const out: UxfSentLedgerEntry[] = [];
    const sortedKeys = [...entries.keys()].sort();
    for (const key of sortedKeys) {
      if (!key.startsWith(this.keyPrefix)) continue;
      const decoded = await this.readDecoded(key);
      if (decoded === null) continue;
      if (!isUxfSentLedgerEntry(decoded)) continue;
      out.push(decoded);
    }
    return out;
  }

  /**
   * Check whether `tokenId` appears in ANY live SENT entry. Used by
   * the crash-recovery sweeper (Issue #97 step 6) and the duplicate-
   * bundle guard (Issue #97 step 7).
   *
   * **Cost contract.** Backed by a lazy in-memory index (OUTBOX-SEND-
   * FOLLOWUPS item #3). The first call after construction is O(n × m)
   * — it iterates `readAll()` to build the index. Subsequent calls:
   *
   *  - **Miss path** (tokenId not in any bucket): O(1) — single
   *    `Map.has` returns false, no storage I/O. This is the common
   *    case for the duplicate-bundle guard (most candidate tokens are
   *    fresh).
   *  - **Hit path**: O(b) where `b` is the bucket size (typically 1).
   *    Each hit reads one entry from storage to verify the index is
   *    not stale against cross-replica tombstones — see
   *    "Cross-replica staleness" below.
   *
   * **Index maintenance.** `write()` and `delete()` keep the index
   * consistent with the on-disk state in O(m) per call (the entry's
   * tokenIds count). The index is purely in-memory; each `SentLedgerWriter`
   * instance re-derives it on first lookup, so a process restart
   * naturally rebuilds.
   *
   * **Cross-replica staleness.** If a remote peer tombstones an entry
   * via a synchronised `ProfileDatabase`, the local in-memory index
   * does not see the eviction (the local `delete()` was never called).
   * The verify-on-hit step catches this: when the bucket is non-empty
   * but every referenced entry returns `null` from `readOne()`, the
   * stale ids are evicted from the index and the call returns `false`.
   * Subsequent calls for the same tokenId are O(1) misses.
   *
   * **Storage scale.** Typical wallets carry <1k SENT entries; m ~ 1-4.
   * The duplicate-bundle guard (which calls `contains()` per-token
   * per-send) is the load-bearing consumer.
   */
  async contains(tokenId: string): Promise<boolean> {
    if (typeof tokenId !== 'string' || tokenId.length === 0) return false;
    await this.ensureIndex();
    if (this.tokenIndex === null) return false;
    const bucket = this.tokenIndex.get(tokenId);
    if (bucket === undefined || bucket.size === 0) return false;
    // Cross-replica staleness defense: a remote peer may have
    // tombstoned an entry our in-memory index still references (no
    // local delete() call → no incremental eviction). Verify the hit
    // by reading at least one matching entry from durable storage;
    // if every referenced entry is gone, the bucket is stale —
    // evict the slot and report absence. The extra cost is bounded
    // by the bucket size (typically 1) and is paid only on hits;
    // misses remain O(1).
    let liveFound = false;
    const staleIds: string[] = [];
    for (const entryId of bucket) {
      const entry = await this.readOne(entryId);
      if (entry !== null) {
        liveFound = true;
        // Don't break — continue collecting stale ids so we evict
        // them in one pass. Avoids re-paying the verify cost on the
        // next contains() call for the same tokenId.
        continue;
      }
      staleIds.push(entryId);
    }
    if (staleIds.length > 0) this.evictStaleEntries(staleIds);
    return liveFound;
  }

  /**
   * Convenience: return all SENT entries that include `tokenId` in
   * their `tokenIds`. Used by tooling and tests that need the full
   * delivery history of a single token (a token MAY appear in multiple
   * SENT entries when it was re-sent intentionally).
   *
   * **Cost contract.** Same lazy-index backing as {@link contains}. The
   * first call is O(n × m); subsequent calls are O(k) where k is the
   * number of entries containing `tokenId` (typically 1).
   */
  async findByTokenId(tokenId: string): Promise<ReadonlyArray<UxfSentLedgerEntry>> {
    if (typeof tokenId !== 'string' || tokenId.length === 0) return [];
    await this.ensureIndex();
    if (this.tokenIndex === null) return [];
    const ids = this.tokenIndex.get(tokenId);
    if (ids === undefined || ids.size === 0) return [];
    const out: UxfSentLedgerEntry[] = [];
    for (const id of ids) {
      const entry = await this.readOne(id);
      if (entry !== null) out.push(entry);
    }
    return out;
  }

  /**
   * OUTBOX-SEND-FOLLOWUPS item #3 — lazy-build the in-memory
   * `tokenId → entryId` index from the durable SENT-ledger state.
   *
   * Cheap re-entry: if the index is already built (`tokenIndex !== null`),
   * this is a no-op. If a prior maintenance step invalidated the index
   * by setting it back to `null` (defensive on unexpected throws), the
   * next lookup rebuilds.
   *
   * Cost: O(n) decrypts (mirrors `readAll()`), once per index lifetime.
   */
  private async ensureIndex(): Promise<void> {
    if (this.tokenIndex !== null && this.entryTokenIds !== null) return;
    const tokenIndex = new Map<string, Set<string>>();
    const entryTokenIds = new Map<string, ReadonlyArray<string>>();
    const all = await this.readAll();
    for (const entry of all) {
      entryTokenIds.set(entry.id, entry.tokenIds);
      for (const t of entry.tokenIds) {
        let bucket = tokenIndex.get(t);
        if (bucket === undefined) {
          bucket = new Set();
          tokenIndex.set(t, bucket);
        }
        bucket.add(entry.id);
      }
    }
    this.tokenIndex = tokenIndex;
    this.entryTokenIds = entryTokenIds;
  }

  /**
   * OUTBOX-SEND-FOLLOWUPS item #3 — incremental index maintenance after
   * a successful {@link write}. No-op when the index hasn't been built
   * yet ({@link ensureIndex} will catch up on first lookup).
   *
   * Handles the second-write-wins case: if a prior entry existed at the
   * same id with a different tokenIds set, the old tokenIds are
   * removed from the index before the new ones are added.
   */
  private updateIndexAfterWrite(
    id: string,
    newTokenIds: ReadonlyArray<string>,
  ): void {
    if (this.tokenIndex === null || this.entryTokenIds === null) return;
    const priorTokenIds = this.entryTokenIds.get(id);
    if (priorTokenIds !== undefined) {
      for (const t of priorTokenIds) {
        const bucket = this.tokenIndex.get(t);
        if (bucket === undefined) continue;
        bucket.delete(id);
        if (bucket.size === 0) this.tokenIndex.delete(t);
      }
    }
    this.entryTokenIds.set(id, newTokenIds);
    for (const t of newTokenIds) {
      let bucket = this.tokenIndex.get(t);
      if (bucket === undefined) {
        bucket = new Set();
        this.tokenIndex.set(t, bucket);
      }
      bucket.add(id);
    }
  }

  /**
   * OUTBOX-SEND-FOLLOWUPS item #3 — incremental index maintenance after
   * a successful {@link delete}. Removes the entry's contribution from
   * every tokenId bucket and drops it from the reverse map. No-op when
   * the index hasn't been built yet OR when the id is unknown to the
   * index (idempotent delete-of-absent).
   */
  private removeFromIndexAfterDelete(id: string): void {
    if (this.tokenIndex === null || this.entryTokenIds === null) return;
    const priorTokenIds = this.entryTokenIds.get(id);
    if (priorTokenIds === undefined) return;
    for (const t of priorTokenIds) {
      const bucket = this.tokenIndex.get(t);
      if (bucket === undefined) continue;
      bucket.delete(id);
      if (bucket.size === 0) this.tokenIndex.delete(t);
    }
    this.entryTokenIds.delete(id);
  }

  /**
   * Drop entries from the index that {@link contains} discovered to
   * be stale (tombstoned remotely or otherwise unreadable). Mirrors
   * {@link removeFromIndexAfterDelete} but acts on multiple ids in
   * one pass. Safe to call even when the index hasn't been built
   * (no-op).
   */
  private evictStaleEntries(staleIds: ReadonlyArray<string>): void {
    if (this.tokenIndex === null || this.entryTokenIds === null) return;
    for (const id of staleIds) {
      const priorTokenIds = this.entryTokenIds.get(id);
      if (priorTokenIds === undefined) continue;
      for (const t of priorTokenIds) {
        const bucket = this.tokenIndex.get(t);
        if (bucket === undefined) continue;
        bucket.delete(id);
        if (bucket.size === 0) this.tokenIndex.delete(t);
      }
      this.entryTokenIds.delete(id);
    }
  }

  // ===========================================================================
  // Private helpers — mirror OutboxWriter's implementation tightly so
  // future maintainers can side-by-side diff the two writers.
  // ===========================================================================

  private async collectObservedLamports(): Promise<ReadonlyArray<number>> {
    let entries: Map<string, Uint8Array>;
    try {
      entries = await this.db.all(this.keyPrefix);
    } catch {
      return [];
    }
    const out: number[] = [];
    for (const key of entries.keys()) {
      if (!key.startsWith(this.keyPrefix)) continue;
      // Issue #166 P1 #2 — observe live AND tombstone Lamports.
      const shape = await this.readSlotShape(key);
      if (shape === null) continue;
      if (shape.kind === 'value') {
        if (isUxfSentLedgerEntry(shape.value)) out.push(shape.value.lamport);
      } else if (shape.kind === 'tombstone') {
        out.push(shape.lamport);
      }
    }
    return out;
  }

  /**
   * Issue #166 P1 #2 — check whether the slot at `id` is currently a
   * tombstone. Returns the tombstone metadata (lamport, deletedAt) or
   * null. Mirrors OutboxWriter.readTombstoneAt.
   */
  private async readTombstoneAt(
    id: string,
  ): Promise<{ readonly lamport: number; readonly deletedAt: number } | null> {
    const shape = await this.readSlotShape(this.keyFor(id));
    if (shape === null) return null;
    if (shape.kind !== 'tombstone') return null;
    return { lamport: shape.lamport, deletedAt: shape.deletedAt };
  }

  /**
   * Issue #166 P1 #2 — discriminated-union slot reader. Mirrors
   * OutboxWriter.readSlotShape.
   */
  private async readSlotShape(
    key: string,
  ): Promise<
    | null
    | { readonly kind: 'tombstone'; readonly lamport: number; readonly deletedAt: number }
    | { readonly kind: 'value'; readonly value: unknown }
  > {
    let raw: Uint8Array | null;
    try {
      raw = await this.db.get(key);
    } catch {
      return null;
    }
    if (!raw) return null;
    // Issue #166 P1 #3 — pre-decrypt size cap; see readDecoded().
    if (raw.byteLength > MAX_ENTRY_BYTES_RAW) return null;
    let plaintextBytes: Uint8Array;
    try {
      plaintextBytes = this.encryptionKey
        ? await decryptProfileValue(this.encryptionKey, raw)
        : raw;
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(plaintextBytes));
    } catch {
      return null;
    }
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'tombstoned' in (parsed as Record<string, unknown>) &&
      (parsed as Record<string, unknown>).tombstoned === true
    ) {
      const p = parsed as Record<string, unknown>;
      const lamport =
        typeof p.lamport === 'number' && Number.isInteger(p.lamport) && p.lamport >= 0
          ? p.lamport
          : 0;
      const deletedAt = typeof p.deletedAt === 'number' ? p.deletedAt : 0;
      return { kind: 'tombstone', lamport, deletedAt };
    }
    return { kind: 'value', value: parsed };
  }

  private async writeRaw(id: string, value: string): Promise<void> {
    const encoded = new TextEncoder().encode(value);
    const toWrite = this.encryptionKey
      ? await encryptProfileValue(this.encryptionKey, encoded)
      : encoded;
    await this.db.put(this.keyFor(id), toWrite);
  }

  private async readDecoded(key: string): Promise<unknown | null> {
    let raw: Uint8Array | null;
    try {
      raw = await this.db.get(key);
    } catch {
      return null;
    }
    if (!raw) return null;
    // Issue #166 P1 #3 — pre-decrypt size cap.
    if (raw.byteLength > MAX_ENTRY_BYTES_RAW) return null;
    let plaintextBytes: Uint8Array;
    try {
      plaintextBytes = this.encryptionKey
        ? await decryptProfileValue(this.encryptionKey, raw)
        : raw;
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(plaintextBytes));
    } catch {
      return null;
    }
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'tombstoned' in (parsed as Record<string, unknown>) &&
      (parsed as Record<string, unknown>).tombstoned === true
    ) {
      return null;
    }
    return parsed;
  }
}
