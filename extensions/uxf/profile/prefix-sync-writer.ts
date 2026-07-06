/**
 * Generic prefix-scoped sync writer for per-entry-key surfaces that
 * don't carry an explicit Lamport field (Item #15 Phase B helper).
 *
 * **When to use vs OUTBOX/SENT style.** Two flavours of per-entry-key
 * writer exist in the Profile system:
 *
 *  1. **Lamport-tracked, mutable entries** — OUTBOX, SENT. Each entry
 *     records a `lamport` field that monotonically increases on every
 *     local write per §7.1, so the Item #15 merge table can pick the
 *     winner by Lamport comparison. These writers each implement
 *     `ProfileSyncWriter` directly with rich classifiers (`OutboxWriter`,
 *     `SentLedgerWriter`).
 *
 *  2. **Constant-Lamport, content-immutable entries** —
 *     FinalizationQueue, RecipientContext, BundleRef, Disposition
 *     (_invalid / _audit). Each entry is written-once at a key whose
 *     unique disambiguator (requestId, tokenId, observed-content-hash,
 *     etc.) ensures two replicas writing the same entry produce
 *     byte-equivalent content. They DON'T carry an explicit Lamport.
 *     The merge degenerates to "absent + live → land; live + live →
 *     no-op; tombstones are sticky" — exactly what the shared
 *     {@link mergeSlots} primitive produces if every entry's Lamport
 *     is fixed at 0.
 *
 * This file is for case 2. We treat every well-formed live entry as
 * `live(lamport=0)` and every tombstone as `tombstone(lamport=0)`,
 * then delegate to `runJoinSnapshot`. The resulting semantics:
 *
 *   - absent + live      → write remote      (new entry lands)
 *   - live   + live      → no-op             (same content expected; first wins)
 *   - live   + tombstone → tombstone wins    (`tomb.lamport >= live.lamport` at 0=0)
 *   - tombstone + live   → tombstone preserved (`live.lamport > tomb.lamport` is false at 0=0)
 *   - tombstone + tombstone → no-op           (same content; first wins)
 *
 * Tombstones stay sticky — once an entry is tombstoned on either
 * replica, the JOIN preserves the tombstone across both sides. This
 * matches the operational intent of these surfaces (deletes are
 * deliberate and should propagate, not be overridden by a stale
 * cross-replica live entry).
 *
 * **Forward path to per-prefix Lamports.** If a future requirement
 * adds Lamport tracking to one of these surfaces (e.g. recipient
 * context becomes mutable mid-lifecycle), the writer can be moved out
 * of `PrefixSyncWriter` and given its own ProfileSyncWriter implementation
 * with the same shape as `OutboxWriter`.
 *
 * @module profile/prefix-sync-writer
 * @see profile/profile-snapshot-merge.ts — shared merge primitive
 * @see docs/uxf/OUTBOX-SEND-FOLLOWUPS.md — Item #15 Phase B
 */

import { decryptProfileValue } from './encryption.js';
import { unwrapEnvelopeBytes } from './oplog-envelope-io.js';
import {
  runJoinSnapshot,
  type ClassifiedSlot,
  type JoinResult,
  type ProfileSyncWriter,
  type SnapshotEntry,
} from './profile-snapshot-merge.js';
import type { ProfileDatabase } from './types.js';
import { MAX_ENTRY_BYTES_RAW } from '../../../types/uxf-bounds.js';

// =============================================================================
// 1. Options + value-validator type
// =============================================================================

/**
 * Per-instance options for {@link PrefixSyncWriter}.
 */
export interface PrefixSyncWriterOptions {
  /** OrbitDB key-value adapter — the writer's underlying store. */
  readonly db: ProfileDatabase;
  /** AES-256 key for decrypting on-disk values. `null` disables decrypt
   *  (the bytes are treated as plaintext JSON). MUST match the key used
   *  by the underlying writer that produced the bytes. */
  readonly encryptionKey: Uint8Array | null;
  /** Full key prefix to scope this sync writer (e.g.
   *  `"DIRECT_aaaaaa_bbbbbb.finalizationQueue."`). The writer enforces
   *  the prefix on every snapshot entry — foreign keys are rejected as
   *  malformed at JOIN time. */
  readonly keyPrefix: string;
  /**
   * Optional schema-validation hook applied to decoded LIVE entries.
   * Returns `true` if the parsed payload matches the writer's expected
   * shape (e.g. carries `_schemaVersion: 'uxf-1'`). Returns `false` to
   * reject the entry as malformed.
   *
   * Defaults to "accept any object that is not a tombstone marker".
   * Tombstones are recognised by the canonical
   * `{ tombstoned: true, ... }` shape regardless of this validator.
   */
  readonly validateValue?: (decoded: unknown) => boolean;
  /**
   * Label for diagnostics (logger prefix in error messages). Defaults
   * to `'PrefixSyncWriter'`.
   */
  readonly label?: string;
  /**
   * Item #15 Phase C — fired once after a JOIN that lands at least one
   * live or tombstone remote entry into the local store. The wrapping
   * adapter (FinalizationQueue / RecipientContext / Disposition) is
   * what receives this for content-immutable surfaces; the underlying
   * `writeKey` / `deleteKey` mutations on the adapter itself are
   * notified separately by the adapter. Optional — when omitted the
   * wrapper is a pure read+join surface.
   */
  readonly notifyProfileDirty?: () => void;
}

// =============================================================================
// 2. PrefixSyncWriter
// =============================================================================

/**
 * Prefix-scoped {@link ProfileSyncWriter} for content-immutable
 * per-entry-key surfaces. See the module-level doc-comment for the
 * full rationale.
 *
 * **What this class does NOT do**:
 *   - Re-encryption on the write-remote path. The remote's bytes are
 *     persisted verbatim. Same rationale as `OutboxWriter.joinSnapshot`
 *     (see profile/outbox-writer.ts for the decryption-key sharing
 *     contract).
 *   - Lamport observation / bump. The writers consuming this helper
 *     do not maintain a Lamport clock; nothing to bump.
 *   - Schema migration. If a remote sends a v1 record at a key that
 *     local already has at v2, this writer will let v1 land (live+live
 *     no-op at the same lamport=0 unless local is absent). Schema
 *     migration is a write-time concern handled elsewhere.
 */
export class PrefixSyncWriter implements ProfileSyncWriter {
  private readonly db: ProfileDatabase;
  private readonly encryptionKey: Uint8Array | null;
  private readonly keyPrefix: string;
  private readonly validateValue: (decoded: unknown) => boolean;
  private readonly notifyProfileDirty: (() => void) | null;

  constructor(opts: PrefixSyncWriterOptions) {
    if (typeof opts.keyPrefix !== 'string' || opts.keyPrefix.length === 0) {
      throw new TypeError(
        'PrefixSyncWriter: keyPrefix must be a non-empty string',
      );
    }
    this.db = opts.db;
    this.encryptionKey = opts.encryptionKey;
    this.keyPrefix = opts.keyPrefix;
    this.validateValue = opts.validateValue ?? defaultValidator;
    this.notifyProfileDirty = opts.notifyProfileDirty ?? null;
  }

  async snapshot(): Promise<ReadonlyArray<SnapshotEntry>> {
    let entries: Map<string, Uint8Array>;
    try {
      entries = await this.db.all(this.keyPrefix);
    } catch {
      return [];
    }
    const out: SnapshotEntry[] = [];
    const sortedKeys = [...entries.keys()].sort();
    for (const key of sortedKeys) {
      if (!key.startsWith(this.keyPrefix)) continue;
      const encryptedValue = entries.get(key);
      if (encryptedValue === undefined) continue;
      out.push({ key, encryptedValue });
    }
    return out;
  }

  async joinSnapshot(
    remote: ReadonlyArray<SnapshotEntry>,
  ): Promise<JoinResult> {
    const result = await runJoinSnapshot(remote, {
      classifyLocal: async (key) => {
        if (!key.startsWith(this.keyPrefix)) return { kind: 'absent' };
        const raw = await this.safeGet(key);
        if (raw === null) return { kind: 'absent' };
        const slot = await this.classifyBytes(raw, /* remote = */ false);
        return slot ?? { kind: 'absent' };
      },
      classifyRemote: async (entry) => {
        if (!entry.key.startsWith(this.keyPrefix)) return null;
        return this.classifyBytes(entry.encryptedValue, /* remote = */ true);
      },
      writeRemote: async (key, bytes) => {
        await this.db.put(key, bytes);
      },
    });
    // Item #15 Phase C — fire the host's dirty signal if anything
    // landed. Guarded against notifier exceptions.
    if (
      (result.liveLanded > 0 || result.tombstonesLanded > 0) &&
      this.notifyProfileDirty !== null
    ) {
      try {
        this.notifyProfileDirty();
      } catch {
        // Best-effort signal — never propagate notifier errors.
      }
    }
    return result;
  }

  /**
   * Defensive `db.get` wrapper — converts thrown errors to `null` so
   * the JOIN loop treats them as absent (let remote land) rather than
   * aborting.
   */
  private async safeGet(key: string): Promise<Uint8Array | null> {
    try {
      return await this.db.get(key);
    } catch {
      return null;
    }
  }

  /**
   * Decrypt + parse + classify a raw byte buffer.
   *
   * @param raw    The on-disk / on-wire bytes.
   * @param remote `true` for remote bytes (stricter — schema-invalid
   *               payloads reject); `false` for local (schema-invalid
   *               maps to `absent` so remote can land).
   */
  private async classifyBytes(
    raw: Uint8Array,
    remote: boolean,
  ): Promise<ClassifiedSlot | null> {
    if (!raw || raw.byteLength === 0) {
      return remote ? null : { kind: 'absent' };
    }
    if (raw.byteLength > MAX_ENTRY_BYTES_RAW) {
      return remote ? null : { kind: 'absent' };
    }
    // Issue #247 — `raw` may be either a CBOR-encoded OpLog envelope
    // (post-#247 writes via putEntry) or legacy raw AES-GCM ciphertext
    // (pre-#247 writes via raw db.put). Unwrap to the inner ciphertext
    // before attempting decryption.
    const ciphertext = unwrapEnvelopeBytes(raw);
    let plaintextBytes: Uint8Array;
    try {
      plaintextBytes = this.encryptionKey
        ? await decryptProfileValue(this.encryptionKey, ciphertext)
        : ciphertext;
    } catch {
      return remote ? null : { kind: 'absent' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(plaintextBytes));
    } catch {
      return remote ? null : { kind: 'absent' };
    }
    if (isTombstoneMarker(parsed)) {
      // Tombstones don't carry a Lamport on these surfaces; use 0.
      return { kind: 'tombstone', lamport: 0 };
    }
    if (!this.validateValue(parsed)) {
      return remote ? null : { kind: 'absent' };
    }
    return { kind: 'live', lamport: 0 };
  }
}

// =============================================================================
// 3. Helpers
// =============================================================================

function isTombstoneMarker(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  return (value as { tombstoned?: unknown }).tombstoned === true;
}

/**
 * Default validator: accept any plain object that is not a tombstone
 * marker. Writers with stricter schemas pass an explicit validator.
 */
function defaultValidator(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== 'object') return false;
  if (Array.isArray(parsed)) return false;
  if (isTombstoneMarker(parsed)) return false;
  return true;
}
