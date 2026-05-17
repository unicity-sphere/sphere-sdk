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
import type { ProfileDatabase } from './types.js';

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

  constructor(options: SentLedgerWriterOptions) {
    if (!options.addressId || options.addressId.length === 0) {
      throw new SphereError(
        'SentLedgerWriter: addressId must be a non-empty string',
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
  async write(input: SentLedgerWriteInput): Promise<UxfSentLedgerEntry> {
    if (typeof input.id !== 'string' || input.id.length === 0) {
      throw new SphereError(
        'SentLedgerWriter.write: input.id must be a non-empty string',
        'VALIDATION_ERROR',
      );
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
    const tombstone = JSON.stringify({ tombstoned: true, deletedAt: Date.now() });
    await this.writeRaw(id, tombstone);
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
   * Implementation note: scans `readAll()` results. For wallets with
   * tens of thousands of SENT entries this is O(n × m) where m is the
   * average tokenIds length per entry. Acceptable for current user
   * volumes; a future optimization could maintain a parallel
   * tokenId → entryIds index, but that doubles the durability
   * surface for no immediate benefit.
   */
  async contains(tokenId: string): Promise<boolean> {
    if (typeof tokenId !== 'string' || tokenId.length === 0) return false;
    const all = await this.readAll();
    for (const e of all) {
      for (const t of e.tokenIds) {
        if (t === tokenId) return true;
      }
    }
    return false;
  }

  /**
   * Convenience: return all SENT entries that include `tokenId` in
   * their `tokenIds`. Used by tooling and tests that need the full
   * delivery history of a single token (a token MAY appear in multiple
   * SENT entries when it was re-sent intentionally).
   */
  async findByTokenId(tokenId: string): Promise<ReadonlyArray<UxfSentLedgerEntry>> {
    if (typeof tokenId !== 'string' || tokenId.length === 0) return [];
    const all = await this.readAll();
    const out: UxfSentLedgerEntry[] = [];
    for (const e of all) {
      for (const t of e.tokenIds) {
        if (t === tokenId) {
          out.push(e);
          break;
        }
      }
    }
    return out;
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
      const decoded = await this.readDecoded(key);
      if (decoded === null) continue;
      if (isUxfSentLedgerEntry(decoded)) out.push(decoded.lamport);
    }
    return out;
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
