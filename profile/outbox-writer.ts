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
import type { ProfileDatabase } from './types.js';

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
  async write(input: OutboxWriteInput): Promise<UxfTransferOutboxEntry> {
    if (typeof input.id !== 'string' || input.id.length === 0) {
      throw new SphereError(
        'OutboxWriter.write: input.id must be a non-empty string',
        'VALIDATION_ERROR',
      );
    }

    // Read all observed Lamports for the bump rule. Includes the
    // current entry's own previous Lamport (if any) — that's correct
    // per §7.1: max(local, observedRemotes) where the local view of the
    // entry counts as "observed".
    const observedLamports = await this.collectObservedLamports();
    const next = this.lamport.bumpFor(observedLamports);

    const updatedAt = input.updatedAt ?? Date.now();
    const stamped: UxfTransferOutboxEntry = {
      ...input,
      _schemaVersion: 'uxf-1',
      lamport: next,
      updatedAt,
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
    const tombstone = JSON.stringify({ tombstoned: true, deletedAt: Date.now() });
    await this.writeRaw(id, tombstone);
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
      const decoded = await this.readDecoded(key);
      if (decoded === null) continue;
      if (isUxfTransferOutboxEntry(decoded)) out.push(decoded.lamport);
    }
    return out;
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
