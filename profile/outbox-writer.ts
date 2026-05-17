/**
 * UXF Inter-Wallet Transfer — OutboxWriter (T.6.A)
 *
 * Per-entry-key writer / reader for {@link UxfTransferOutboxEntry}.
 * Operates directly on the {@link ProfileDatabase} (OrbitDB key-value store)
 * under keys of the form `${addr}.outbox.${id}` per
 * `docs/uxf/PROFILE-ARCHITECTURE.md` §10.12 / Wave G.7.
 *
 * **Scope** — write/read only. The CRDT merger (T.6.B) and PaymentsModule
 * integration (T.2.D.2 / T.5.C) live elsewhere and consume this writer's
 * primitives.
 *
 * **Lamport invariant** (per UXF-TRANSFER-PROTOCOL §7.1). On every local
 * write to an entry, the writer:
 *   1. Reads the current `lamport` value AND every Lamport observed across
 *      all concurrently-known outbox entries for the address.
 *   2. Calls {@link Lamport.bumpFor} which yields
 *      `next = max(local, observedRemotes) + 1`.
 *   3. Stamps `next` onto the entry being written.
 *
 * **Schema discriminator**. Every entry written by this class carries
 * `_schemaVersion: 'uxf-1'`. Legacy entries (pre-T.6.A) lack the field;
 * `readAll` classifies each entry on read so callers can dispatch.
 *
 * **Per-entry-key isolation**. Writing entry `a` does NOT touch entries
 * `b` or `c`. Deleting entry `b` does NOT touch entries `a` or `c`. This
 * is the canonical CRDT-friendly layout per §7.1: two devices adding
 * different entries never conflict at the OrbitDB layer.
 *
 * **Tombstones**. `delete()` writes a tombstone marker
 * (`{ tombstoned: true, deletedAt: number }`) at the entry's key rather
 * than hard-deleting, matching the existing per-entry-key pattern in
 * `profile-token-storage-provider.ts` (Wave G.7). Tombstones are skipped
 * by `readAll`. Tombstone retention / GC is handled by the provider's
 * existing flush path; this writer only writes the tombstone marker.
 *
 * **Encryption**. If an `encryptionKey` is supplied at construction, all
 * values are encrypted via {@link encryptProfileValue} (AES-256-GCM)
 * before writing. The provider's main writer uses the same encryption
 * scheme — no AAD, matching `profile-token-storage-provider.ts`'s
 * `writeProfileKey` / `readProfileKey`.
 *
 * @module profile/outbox-writer
 *
 * @see docs/uxf/UXF-TRANSFER-PROTOCOL.md   §7, §7.0, §7.1, §7.2
 * @see docs/uxf/PROFILE-ARCHITECTURE.md     §10.12
 * @see profile/profile-token-storage-provider.ts (canonical per-entry-key writer)
 * @see profile/lamport.ts                   (Lamport clock — §7.1 invariants)
 */

import { SphereError } from '../core/errors.js';
import {
  classifyOutboxEntryShape,
  isLegacyOutboxEntry,
  isUxfTransferOutboxEntry,
  type LegacyOutboxEntry,
  type UxfTransferOutboxEntry,
} from '../types/uxf-outbox.js';
import { decryptProfileValue, encryptProfileValue } from './encryption.js';
import { Lamport } from './lamport.js';
import { assertTransition } from './outbox-state-machine.js';
import type { ProfileDatabase, TombstoneGcResult } from './types.js';
import { MAX_ENTRY_BYTES_RAW } from '../types/uxf-bounds.js';

// =============================================================================
// 1. Public option / classification types
// =============================================================================

/**
 * Construction-time options for {@link OutboxWriter}.
 */
export interface OutboxWriterOptions {
  /** OrbitDB key-value adapter — same instance the provider uses. */
  readonly db: ProfileDatabase;
  /** AES-256 key for encrypting on-disk values. Pass `null` to disable
   *  encryption (parity with `ProfileTokenStorageProvider` when no key
   *  was injected at construction). */
  readonly encryptionKey: Uint8Array | null;
  /** Address id — the `${addr}` prefix in `${addr}.outbox.${id}`. */
  readonly addressId: string;
  /** Lamport clock instance. The writer mutates it on every write per
   *  §7.1. Per-instance scoped — supply a fresh clock per Sphere instance
   *  to avoid bleed across destroy-recreate cycles. */
  readonly lamport: Lamport;
}

/**
 * One entry returned by {@link OutboxWriter.readAll}. Each variant carries
 * the parsed payload alongside the on-disk shape classification so callers
 * can route at the call site without re-sniffing.
 */
export type ClassifiedOutboxEntry =
  | { readonly shape: 'uxf-1'; readonly entry: UxfTransferOutboxEntry }
  | { readonly shape: 'legacy'; readonly entry: LegacyOutboxEntry };

/**
 * Input shape for {@link OutboxWriter.write}. The writer stamps
 * `_schemaVersion`, `lamport`, and (optionally) `updatedAt` itself.
 */
export type OutboxWriteInput = Omit<
  UxfTransferOutboxEntry,
  '_schemaVersion' | 'lamport'
> & {
  /** Optional: explicit timestamp for the write. Defaults to `Date.now()`. */
  readonly updatedAt?: number;
};

/**
 * Optional second argument to {@link OutboxWriter.write}. Issue #166
 * P1 #2 adds the {@link WriteOptions.allowResurrection} escape hatch.
 */
export interface WriteOptions {
  /**
   * Issue #166 P1 #2 — by default, calling `write()` on an id whose
   * slot is currently a tombstone is REFUSED with
   * `OUTBOX_ENTRY_TOMBSTONED`. The tombstone represents a completed
   * delivery (the matching SENT entry is the durable record); writing
   * a new entry over it would silently resurrect a key that should
   * stay dead, defeating the whole point of the OUTBOX drain.
   *
   * Pass `true` ONLY for legitimate escape-hatch resurrections —
   * operator triage of a poisoned key, test fixtures, or explicit
   * spec-defined "rewind" operations. The writer emits no log on
   * `true` so the caller takes responsibility for the audit trail.
   */
  readonly allowResurrection?: boolean;
}

// =============================================================================
// 2. OutboxWriter
// =============================================================================

/**
 * Per-entry-key writer/reader for {@link UxfTransferOutboxEntry}.
 *
 * @remarks
 * Holds NO module-level state. All state lives on the instance (the
 * {@link Lamport} clock, the address binding). Constructing two writers
 * for the same address is harmless — they each serialize their own
 * Lamport, and OrbitDB's key-value semantics absorb the writes.
 */
export class OutboxWriter {
  private readonly db: ProfileDatabase;
  private readonly encryptionKey: Uint8Array | null;
  private readonly addressId: string;
  private readonly lamport: Lamport;
  private readonly keyPrefix: string;

  constructor(options: OutboxWriterOptions) {
    if (!options.addressId || options.addressId.length === 0) {
      throw new SphereError(
        'OutboxWriter: addressId must be a non-empty string',
        'VALIDATION_ERROR',
      );
    }
    // Issue #166 P4 #1 — defense-in-depth against key-prefix overlap.
    // The keyPrefix is `${addressId}.outbox.`; an addressId containing
    // `.` would extend the prefix into adjacent collections (e.g.
    // `DIRECT_a.b_c.outbox.*` overlaps with `DIRECT_a.b_c.sent.*`).
    // Production callers always pass the canonical shape returned by
    // `constants.ts:getAddressId()` — `DIRECT_[0-9a-f]{6}_[0-9a-f]{6}`
    // — so enforcing it here catches misuse without breaking
    // production traffic.
    if (!/^DIRECT_[0-9a-f]{6}_[0-9a-f]{6}$/.test(options.addressId)) {
      throw new SphereError(
        `OutboxWriter: addressId must match DIRECT_[0-9a-f]{6}_[0-9a-f]{6} (got: ${options.addressId})`,
        'VALIDATION_ERROR',
      );
    }
    this.db = options.db;
    this.encryptionKey = options.encryptionKey;
    this.addressId = options.addressId;
    this.lamport = options.lamport;
    this.keyPrefix = `${this.addressId}.outbox.`;
  }

  /**
   * Compose the on-disk key for an entry id.
   * Exposed for callers that need to read raw values directly (tests).
   */
  keyFor(id: string): string {
    return `${this.keyPrefix}${id}`;
  }

  /**
   * Write a new entry — or replace an existing one — at
   * `${addr}.outbox.${entry.id}`. Stamps `_schemaVersion: 'uxf-1'`,
   * `updatedAt`, and a Lamport bumped per §7.1 invariants.
   *
   * The Lamport bump observes:
   *   - the current local clock value
   *   - every concurrently-stored entry's `lamport` field (read via
   *     prefix-scan)
   * and writes `next = max(local, observedRemotes) + 1`.
   *
   * Idempotent on the input shape: writing the same `entry` twice
   * produces two distinct Lamport stamps but the same `id` slot is
   * overwritten — second write wins.
   */
  async write(
    input: OutboxWriteInput,
    options?: WriteOptions,
  ): Promise<UxfTransferOutboxEntry> {
    if (typeof input.id !== 'string' || input.id.length === 0) {
      throw new SphereError(
        'OutboxWriter.write: input.id must be a non-empty string',
        'VALIDATION_ERROR',
      );
    }

    // Issue #166 P1 #2 — refuse-write guard against tombstone
    // resurrection. After sync, the slot at `input.id` may be a
    // tombstone from another replica that completed delivery + SENT
    // write. Resurrecting it would erase that completion signal.
    // Callers that genuinely need to resurrect (e.g. test fixtures,
    // operator escape-hatch) pass `{ allowResurrection: true }`.
    //
    // Legacy tombstones (pre-#166, no `lamport` field) are still
    // refused — the resurrection risk is the same regardless of
    // whether the tombstone carries a Lamport stamp.
    if (options?.allowResurrection !== true) {
      const existing = await this.readTombstoneAt(input.id);
      if (existing !== null) {
        throw new SphereError(
          `OutboxWriter.write: refusing to resurrect tombstoned slot "${input.id}" ` +
            `(tombstone lamport=${existing.lamport}, deletedAt=${existing.deletedAt}). ` +
            `If this is intentional (operator escape-hatch / test fixture), pass { allowResurrection: true }.`,
          'OUTBOX_ENTRY_TOMBSTONED',
        );
      }
    }

    // Read all observed Lamports for the bump rule. Includes the
    // current entry's own previous Lamport (if any) — that's correct
    // per §7.1: max(local, observedRemotes) where the local view of the
    // entry counts as "observed".
    //
    // Cold-restart correctness: on first write after restart the clock's
    // `current` resets to 0; if N prior writes exist the observed max is
    // N, and Lamport.bumpFor's W39 bounds defense would reject any N>2
    // (`2 × max(0, 1) = 2`). Rehydrate first — the observations come
    // from our own durable store, not an untrusted remote — then bumpFor
    // with an empty array so the bounds defense doesn't fire against
    // values we just trusted.
    const observedLamports = await this.collectObservedLamports();
    this.lamport.rehydrate(observedLamports);
    const next = this.lamport.bumpFor([]);

    const updatedAt = input.updatedAt ?? Date.now();
    // Sticky `everFinalizing` (steelman crit #12). Writers may pass through
    // an existing `everFinalizing: true` flag (set-OR persistence). We
    // additionally stamp it whenever the current write transitions the
    // entry into the `finalizing` status — that observation is what the
    // CRDT merger depends on across the gossip-fold for override revival.
    const everFinalizing =
      input.everFinalizing === true || input.status === 'finalizing'
        ? true
        : undefined;
    const stamped: UxfTransferOutboxEntry = {
      ...input,
      _schemaVersion: 'uxf-1',
      lamport: next,
      updatedAt,
      ...(everFinalizing === true ? { everFinalizing: true } : {}),
    };

    await this.writeRaw(stamped.id, JSON.stringify(stamped));
    return stamped;
  }

  /**
   * Apply `mutator` to an existing entry, then write the result with a
   * bumped Lamport. Throws `OUTBOX_ENTRY_NOT_FOUND` if no live entry
   * exists at the key (the prior value was a tombstone or missing).
   *
   * The mutator runs on the immutable input; it MAY return a new object
   * or a structural copy. The writer does NOT enforce immutability of
   * unrelated fields — callers are responsible for honoring the spec's
   * monotonic invariants (e.g., G-counter shape on `submitRetryCount`).
   */
  async update(
    id: string,
    mutator: (prev: UxfTransferOutboxEntry) => UxfTransferOutboxEntry,
  ): Promise<UxfTransferOutboxEntry> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new SphereError(
        'OutboxWriter.update: id must be a non-empty string',
        'VALIDATION_ERROR',
      );
    }

    const existing = await this.readOne(id);
    if (existing === null || existing.shape !== 'uxf-1') {
      throw new SphereError(
        `OutboxWriter.update: no live UXF outbox entry at id "${id}"`,
        'OUTBOX_ENTRY_NOT_FOUND',
      );
    }

    const next = mutator(existing.entry);
    if (next.id !== id) {
      throw new SphereError(
        `OutboxWriter.update: mutator must not change entry.id (got "${next.id}", expected "${id}")`,
        'VALIDATION_ERROR',
      );
    }

    // T.6.C — gate every status transition against the canonical §7.0
    // table. Self-loops (status unchanged) are skipped so callers can use
    // `update()` to mutate non-status fields (e.g. retry counters, error)
    // without forcing a bogus `from===to` arc through the validator.
    if (next.status !== existing.entry.status) {
      assertTransition({
        from: existing.entry.status,
        to: next.status,
        // The override flag is sticky (set-OR per §7.1) — a true on the
        // NEW entry permits the `failed-permanent → finalizing` arc. The
        // PREV entry's flag is irrelevant: the override is "applied" by
        // the same write that performs the transition.
        overrideApplied: next.overrideApplied === true,
        // Per-status dual-write arcs are not currently in the table; the
        // W43 schema-mode arcs are validated separately by
        // `assertDualWriteArc()`. Pass `false` so any future spec
        // revision adding a status-level dual-write row defaults safely.
        dualWriteEnabled: false,
      });
    }

    // Re-route through write() so the Lamport bump rule and
    // discriminator stamping happen in exactly one place. We strip the
    // old `_schemaVersion` and `lamport` so write() restamps them.
    const writeInput: OutboxWriteInput = stripWriterStampedFields(next);
    return this.write(writeInput);
  }

  /**
   * Tombstone the entry at `${addr}.outbox.${id}`. Subsequent
   * {@link readAll}/{@link readOne} calls return null for this id.
   *
   * Idempotent: tombstoning an already-tombstoned key (or a missing key)
   * is a no-op apart from refreshing `deletedAt`.
   *
   * Per-entry-key isolation: deleting `b` does NOT modify entries `a`
   * or `c`. The on-disk tombstone remains until the provider's flush
   * path GCs it after the retention window (§ Wave G.7 retention rule).
   */
  async delete(id: string): Promise<void> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new SphereError(
        'OutboxWriter.delete: id must be a non-empty string',
        'VALIDATION_ERROR',
      );
    }
    // Issue #166 P1 #2 — stamp the tombstone with a Lamport via the
    // same §7.1 bump rule used by live writes. The Lamport lets the
    // refuse-write guard in write() identify "previously deleted"
    // slots after sync and lets collectObservedLamports() count
    // tombstones toward the clock so subsequent writes don't reuse a
    // stale Lamport. Cold-restart rehydrate happens for the same
    // reason as in write() — observations come from our durable
    // store so the W39 bounds defense must not fire.
    const observedLamports = await this.collectObservedLamports();
    this.lamport.rehydrate(observedLamports);
    const lamport = this.lamport.bumpFor([]);
    const tombstone = JSON.stringify({
      tombstoned: true,
      deletedAt: Date.now(),
      lamport,
    });
    await this.writeRaw(id, tombstone);
  }

  /**
   * OUTBOX-SEND-FOLLOWUPS item #4 — reclaim storage occupied by
   * tombstones older than `opts.retentionMs`.
   *
   * Tombstone semantics. `delete(id)` writes a tombstone marker
   * (`{ tombstoned: true, deletedAt, lamport }`) at the entry's key
   * rather than calling `db.del()`. This is load-bearing for the
   * Issue #166 P1 #2 refuse-write guard — without the durable
   * tombstone marker, a concurrent replica's pre-sync state could
   * resurrect a completed delivery. But tombstones never go away,
   * so the OrbitDB log grows monotonically.
   *
   * After enough time has passed that no replica can still hold a
   * pre-sync state for the slot, the marker can be safely replaced
   * with an actual `db.del()` to reclaim space. 30 days is the
   * conservative default the doc prescribes; callers tune via
   * `retentionMs`.
   *
   * **What this method does:**
   *  1. Prefix-scans all keys under the writer's address.
   *  2. For each key, classifies the slot shape (`value` /
   *     `tombstone`).
   *  3. For tombstones where `(now - deletedAt) > retentionMs`,
   *     calls `db.del(key)`.
   *  4. Returns counts for diagnostics.
   *
   * **Idempotent.** Re-running after a successful sweep is a no-op
   * (the tombstones are gone). The Lamport monotonicity invariant
   * is preserved — once the actual key is `del()`'d, future writes
   * to the same id rehydrate the clock from observed live entries
   * only, and a fresh slot is born with a Lamport ≥ max(observed) + 1.
   *
   * **Safety contract.** Sweeping a tombstone that is still within
   * any concurrent replica's pre-sync horizon can resurrect the
   * slot. Callers MUST ensure `retentionMs` exceeds the longest
   * realistic replica re-sync window. The 30-day default is large
   * enough that even fortnight-long offline replicas converge before
   * sweep.
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
        `OutboxWriter.gcExpiredTombstones: retentionMs must be a non-negative finite number ` +
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
      // Defensive: `deletedAt === 0` means the field was missing or
      // non-numeric at parse time (see `readSlotShape`'s fallback).
      // Without a real timestamp we cannot compute a true retention
      // age, and purging based on the Unix-epoch fallback could free
      // a slot whose concurrent pre-sync replica still holds the
      // live value. Keep these tombstones; an operator can clean
      // them up via direct DB access if needed. Pre-#166 tombstones
      // (which lacked `lamport` but DID carry a real `deletedAt`)
      // are unaffected — they age out normally via this code path.
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
        // del() failure leaves the tombstone in place; next sweep
        // retries. No throw — gc is best-effort.
        kept += 1;
      }
    }
    return { scanned, purged, kept, skipped: false };
  }

  /**
   * Read a single entry at `${addr}.outbox.${id}`. Returns `null` if
   * the key is absent OR carries a tombstone marker. Returns a
   * classified union otherwise so callers can route by shape.
   */
  async readOne(id: string): Promise<ClassifiedOutboxEntry | null> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new SphereError(
        'OutboxWriter.readOne: id must be a non-empty string',
        'VALIDATION_ERROR',
      );
    }
    const decoded = await this.readDecoded(this.keyFor(id));
    if (decoded === null) return null;
    return this.classify(decoded);
  }

  /**
   * Prefix-scan all entries under `${addr}.outbox.*`. Skips tombstoned
   * keys and entries that fail to classify (corrupt JSON, partial
   * shapes). Stable order: ascending lexicographic key.
   */
  async readAll(): Promise<ReadonlyArray<ClassifiedOutboxEntry>> {
    let entries: Map<string, Uint8Array>;
    try {
      entries = await this.db.all(this.keyPrefix);
    } catch {
      return [];
    }
    const out: ClassifiedOutboxEntry[] = [];
    const sortedKeys = [...entries.keys()].sort();
    for (const key of sortedKeys) {
      if (!key.startsWith(this.keyPrefix)) continue;
      const decoded = await this.readDecoded(key);
      if (decoded === null) continue; // tombstone or corrupt
      const classified = this.classify(decoded);
      if (classified === null) continue; // unknown shape — skip
      out.push(classified);
    }
    return out;
  }

  /**
   * Convenience: only the new-shape entries from {@link readAll}.
   */
  async readAllNew(): Promise<ReadonlyArray<UxfTransferOutboxEntry>> {
    const all = await this.readAll();
    const out: UxfTransferOutboxEntry[] = [];
    for (const c of all) if (c.shape === 'uxf-1') out.push(c.entry);
    return out;
  }

  /**
   * Convenience: only the legacy-shape entries from {@link readAll}.
   * Useful for the §7.2 migration window — callers can fold these into
   * synthetic UXF entries.
   */
  async readAllLegacy(): Promise<ReadonlyArray<LegacyOutboxEntry>> {
    const all = await this.readAll();
    const out: LegacyOutboxEntry[] = [];
    for (const c of all) if (c.shape === 'legacy') out.push(c.entry);
    return out;
  }

  // ===========================================================================
  // Private helpers
  // ===========================================================================

  /**
   * Collect every observed Lamport across all currently-stored UXF
   * outbox entries for the address. Used by the §7.1 bump rule.
   *
   * Legacy entries (no `lamport` field) contribute nothing — they are
   * outside the new CRDT regime and are migrated forward on first write
   * by T.6.B.
   */
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
      // Without including tombstones, a fresh write after deletion
      // could stamp a Lamport equal to or below the tombstone's,
      // violating the §7.1 monotonic invariant.
      const shape = await this.readSlotShape(key);
      if (shape === null) continue;
      if (shape.kind === 'value') {
        if (isUxfTransferOutboxEntry(shape.value)) out.push(shape.value.lamport);
      } else if (shape.kind === 'tombstone') {
        out.push(shape.lamport);
      }
    }
    return out;
  }

  /**
   * Issue #166 P1 #2 — check whether the slot at `id` is currently a
   * tombstone, and if so return its Lamport + deletedAt for the
   * refuse-write guard. Returns `null` for absent slots, live values,
   * and any decode/decrypt failures.
   *
   * Legacy tombstones (pre-#166, no `lamport` field) report
   * `lamport: 0` so the refusal still fires. The lamport field is
   * forensic for the error message; the refusal itself is unconditional
   * on the presence of the tombstone marker.
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
   * Issue #166 P1 #2 — read raw bytes at `key`, decrypt + parse, and
   * classify the slot. Returns a discriminated union so callers can
   * distinguish absent / tombstone / live value without re-decoding.
   *
   * `readDecoded()` remains the backward-compat surface (returns
   * `null` for absent + tombstone, the parsed value otherwise) — most
   * consumers want that semantics.
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
      // Legacy tombstones lack `lamport`; coerce to 0 so callers can
      // still identify the slot as tombstoned. Same for missing
      // `deletedAt` — purely forensic.
      const lamport = typeof p.lamport === 'number' && Number.isInteger(p.lamport) && p.lamport >= 0
        ? p.lamport
        : 0;
      const deletedAt = typeof p.deletedAt === 'number' ? p.deletedAt : 0;
      return { kind: 'tombstone', lamport, deletedAt };
    }
    return { kind: 'value', value: parsed };
  }

  /**
   * Encrypt and write a JSON-encoded value at `${prefix}${id}`.
   */
  private async writeRaw(id: string, value: string): Promise<void> {
    const encoded = new TextEncoder().encode(value);
    const toWrite = this.encryptionKey
      ? await encryptProfileValue(this.encryptionKey, encoded)
      : encoded;
    await this.db.put(this.keyFor(id), toWrite);
  }

  /**
   * Read raw bytes at `key`, decrypt if a key is configured, decode JSON.
   * Returns `null` for missing key, decryption failure, parse failure,
   * or tombstone marker.
   */
  private async readDecoded(key: string): Promise<unknown | null> {
    let raw: Uint8Array | null;
    try {
      raw = await this.db.get(key);
    } catch {
      return null;
    }
    if (!raw) return null;
    // Issue #166 P1 #3 — pre-decrypt size cap. A hostile peer
    // replicating a 100MB blob would otherwise cost RAM + CPU at the
    // decrypt step before we could reject. Cap BEFORE decrypt so the
    // cost stays bounded.
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

  /**
   * Classify a parsed value as one of the three on-disk shapes (`uxf-1`,
   * `legacy`, `unknown`). Returns `null` for `unknown` so callers can
   * skip silently.
   */
  private classify(value: unknown): ClassifiedOutboxEntry | null {
    const shape = classifyOutboxEntryShape(value);
    if (shape === 'uxf-1') {
      return { shape: 'uxf-1', entry: value as UxfTransferOutboxEntry };
    }
    if (shape === 'legacy') {
      // isLegacyOutboxEntry was checked inside classifyOutboxEntryShape;
      // re-running it here would be redundant. Type-narrow via cast.
      return { shape: 'legacy', entry: value as LegacyOutboxEntry };
    }
    return null;
  }
}

// =============================================================================
// 3. Module-internal helpers
// =============================================================================

/**
 * Strip the writer-stamped fields (`_schemaVersion`, `lamport`) from an
 * existing entry so it can be re-written via `write()` (which restamps
 * them). Preserves all other fields including `updatedAt` (caller may
 * override).
 */
function stripWriterStampedFields(
  entry: UxfTransferOutboxEntry,
): OutboxWriteInput {
  // Use destructuring to isolate the stripped fields without mutation.
  // The eslint comment is intentional — we WANT the unused locals to
  // signal the strip semantically.
  /* eslint-disable @typescript-eslint/no-unused-vars */
  const { _schemaVersion, lamport, ...rest } = entry;
  /* eslint-enable @typescript-eslint/no-unused-vars */
  return rest;
}

/**
 * Re-export the legacy guard so consumers of `OutboxWriter` can route on
 * shape without importing both modules. Keeps the surface area small.
 */
export { isLegacyOutboxEntry, isUxfTransferOutboxEntry };
