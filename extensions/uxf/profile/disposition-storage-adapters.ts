/**
 * UXF Inter-Wallet Transfer — Production adapters for
 * {@link DispositionPerEntryStorage} (T.3.C / Round 3).
 *
 * The {@link DispositionPerEntryStorage} interface in
 * `profile/disposition-writer.ts` is consumed by both the disposition
 * writer (T.3.C) and the inclusion-proof importer
 * (`modules/payments/transfer/import-inclusion-proof.ts`). Round 1 added
 * `listKeysWithPrefix` to the interface but no concrete production
 * implementation existed — the interface was implemented only by test
 * fakes. Without a production adapter the importer's `_findInvalidEntry`
 * prefix-scan path raises `dispositionStorage.listKeysWithPrefix is not
 * a function` at runtime.
 *
 * This module provides two production-ready adapters:
 *
 *  1. {@link InMemoryDispositionStorageAdapter} — pure in-memory
 *     implementation, suitable for tests, CLI dev tools, and
 *     development-mode wallets that don't need OrbitDB persistence.
 *
 *  2. {@link OrbitDbDispositionStorageAdapter} — wraps a
 *     {@link ProfileDatabase} (the same OrbitDB key-value store the
 *     rest of the profile system uses). Records are encrypted with the
 *     profile encryption key before write and decrypted on read.
 *     Tombstoned keys (carrying the canonical
 *     `{ tombstoned: true, deletedAt: number }` marker, mirroring the
 *     OutboxWriter convention) are skipped on reads and excluded from
 *     prefix scans.
 *
 * Both adapters honour the `maxResults` cap added in Round 3 to defend
 * against a hostile peer planting millions of crafted prefix matches —
 * unbounded scans degrade into N sequential `readRecord` round-trips
 * via the importer's `_findInvalidEntry` consumer.
 *
 * @module profile/disposition-storage-adapters
 *
 * @see profile/disposition-writer.ts (the interface contract)
 * @see modules/payments/transfer/import-inclusion-proof.ts (consumer)
 * @see PROFILE-ARCHITECTURE §10 (OrbitDB profile KV store)
 */

import { logger } from '../../../core/logger.js';
import { decryptString, encryptString } from './encryption.js';
import type { DispositionPerEntryStorage } from './disposition-writer.js';
import {
  getEnvelopePayload,
  putEnvelopePayload,
  unwrapEnvelopeBytes,
} from './oplog-envelope-io.js';
import { PrefixSyncWriter } from './prefix-sync-writer.js';
import type { ProfileSyncWriter } from './profile-snapshot-merge.js';
import type { ProfileDatabase } from './types.js';

// =============================================================================
// 0. Constants
// =============================================================================

/**
 * Default cap on enumerated keys when callers omit `maxResults`. The
 * ceiling is generous enough that legitimate operations (a tokenId with
 * dozens of forensic re-arrivals) never hit it, but tight enough that
 * a hostile peer planting millions of crafted entries cannot trigger
 * an unbounded sequential `readRecord` cascade.
 */
export const DEFAULT_LIST_KEYS_MAX_RESULTS = 1024;

/**
 * Tombstone marker shape — mirrors `OutboxWriter`'s convention so the
 * profile system has a single uniform tombstone protocol.
 */
interface TombstoneMarker {
  readonly tombstoned: true;
  readonly deletedAt: number;
}

function isTombstone(value: unknown): value is TombstoneMarker {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { tombstoned?: unknown }).tombstoned === true
  );
}

// =============================================================================
// 1. In-memory adapter
// =============================================================================

/**
 * Pure-memory implementation of {@link DispositionPerEntryStorage}.
 *
 * Suitable for tests and dev-mode wallets. Holds a single `Map<string,
 * unknown>` and filters tombstoned entries on read / list per the
 * interface contract.
 *
 * The adapter does NOT serialize values — references to the supplied
 * objects are stored as-is. Callers that want to defend against
 * post-write mutation of stored values SHOULD pre-clone before
 * passing to {@link writeRecord}.
 */
export class InMemoryDispositionStorageAdapter
  implements DispositionPerEntryStorage
{
  private readonly entries = new Map<string, unknown>();

  /**
   * Default `maxResults` applied when callers omit the option. Exposed
   * for tests that want to assert overflow behaviour at the cap.
   */
  private readonly defaultMaxResults: number;

  constructor(opts: { readonly defaultMaxResults?: number } = {}) {
    this.defaultMaxResults =
      opts.defaultMaxResults ?? DEFAULT_LIST_KEYS_MAX_RESULTS;
  }

  async readRecord<T>(key: string): Promise<T | undefined> {
    const v = this.entries.get(key);
    if (v === undefined) return undefined;
    if (isTombstone(v)) return undefined;
    return v as T;
  }

  async writeRecord<T>(key: string, value: T): Promise<void> {
    this.entries.set(key, value);
  }

  /**
   * Mark a key as tombstoned. Future reads / list scans skip it.
   * Idempotent.
   */
  async tombstone(key: string): Promise<void> {
    const marker: TombstoneMarker = { tombstoned: true, deletedAt: Date.now() };
    this.entries.set(key, marker);
  }

  async listKeysWithPrefix(
    keyPrefix: string,
    opts?: { readonly maxResults?: number },
  ): Promise<ReadonlyArray<string>> {
    const cap = opts?.maxResults ?? this.defaultMaxResults;
    if (!Number.isFinite(cap) || cap < 0) {
      throw new TypeError(
        `InMemoryDispositionStorageAdapter.listKeysWithPrefix: maxResults must be a non-negative finite number (got ${String(cap)})`,
      );
    }
    const out: string[] = [];
    for (const [k, v] of this.entries.entries()) {
      if (!k.startsWith(keyPrefix)) continue;
      if (isTombstone(v)) continue;
      out.push(k);
      if (out.length >= cap) break;
    }
    return out;
  }
}

// =============================================================================
// 2. OrbitDB adapter
// =============================================================================

/**
 * Construction options for {@link OrbitDbDispositionStorageAdapter}.
 */
export interface OrbitDbDispositionStorageAdapterOptions {
  /** OrbitDB-backed profile database (same instance the rest of the profile uses). */
  readonly db: ProfileDatabase;
  /** AES-256 key derived from the wallet master key (see {@link deriveProfileEncryptionKey}). */
  readonly encryptionKey: Uint8Array;
  /**
   * Default `maxResults` applied when callers omit the option. Defaults
   * to {@link DEFAULT_LIST_KEYS_MAX_RESULTS}.
   */
  readonly defaultMaxResults?: number;
  /**
   * Item #15 Phase C — fired after every successful mutation on either
   * the `_invalid` / `_audit` sub-prefixes. Also threaded into the four
   * {@link PrefixSyncWriter}s returned by
   * {@link OrbitDbDispositionStorageAdapter.syncWritersFor} so
   * JOIN-applied remote changes mark the profile dirty as well.
   *
   * The local `writeRecord` / `tombstone` paths on this adapter do NOT
   * fire the notifier today — they are write-side surfaces that
   * `DispositionWriter` calls in tandem with manifest mutations that
   * already drive the dirty-flush. Threading the notifier here would
   * cause double-fires; leave it as JOIN-only signalling.
   */
  readonly notifyProfileDirty?: () => void;
}

/**
 * {@link DispositionPerEntryStorage} backed by OrbitDB.
 *
 * Records are JSON-encoded then encrypted with the profile encryption
 * key before write. On read, ciphertext is decrypted and JSON-parsed.
 * Tombstones use the same `{ tombstoned: true, deletedAt }` marker as
 * `OutboxWriter` and the rest of the profile system, so the tombstone
 * protocol is uniform across the codebase.
 *
 * **Prefix-scan implementation.** OrbitDB exposes `db.all(prefix?)`
 * which returns a `Map<string, Uint8Array>` of every stored entry under
 * the prefix. The adapter caps enumeration at `maxResults` to defend
 * against hostile peers planting millions of crafted matches — once
 * the cap is hit, the rest of the iteration is skipped (we still
 * iterate the whole map that `db.all()` returns, but we don't decrypt
 * past the cap, which is the expensive operation for the importer's
 * downstream `readRecord` cascade).
 *
 * Tombstones are filtered: entries that successfully decrypt to a
 * tombstone marker are dropped from the returned key list.
 *
 * **Decode failures.** A peer may write a malformed envelope at any
 * matching key. Rather than fail the whole scan, decode failures are
 * logged once and the offending key is excluded from the result. This
 * matches `OrbitDbAdapter.all()`'s lenient handling of malformed
 * peer-replicated values.
 */
export class OrbitDbDispositionStorageAdapter
  implements DispositionPerEntryStorage
{
  private readonly db: ProfileDatabase;
  private readonly encryptionKey: Uint8Array;
  private readonly defaultMaxResults: number;
  private readonly notifyProfileDirty: (() => void) | null;

  constructor(opts: OrbitDbDispositionStorageAdapterOptions) {
    this.db = opts.db;
    this.encryptionKey = opts.encryptionKey;
    this.defaultMaxResults =
      opts.defaultMaxResults ?? DEFAULT_LIST_KEYS_MAX_RESULTS;
    this.notifyProfileDirty = opts.notifyProfileDirty ?? null;
  }

  async readRecord<T>(key: string): Promise<T | undefined> {
    // Issue #247 — dual-format reader for envelope-wrapped (new)
    // and raw-ciphertext (legacy) entries.
    const raw = await getEnvelopePayload(this.db, key);
    if (raw === null) return undefined;
    const decoded = await this.tryDecode<T | TombstoneMarker>(raw, key);
    if (decoded === undefined) return undefined; // decode failure
    if (isTombstone(decoded)) return undefined;
    return decoded as T;
  }

  async writeRecord<T>(key: string, value: T): Promise<void> {
    const encoded = await this.encodeValue(value);
    // Issue #247 — wrap in an OpLog envelope so the lean-snapshot
    // reader (db.getEntry -> decodeEntry) finds the entry.
    await putEnvelopePayload(this.db, key, encoded);
  }

  /**
   * Tombstone a key. Subsequent reads return undefined; subsequent
   * prefix scans exclude the key. Idempotent.
   */
  async tombstone(key: string): Promise<void> {
    const marker: TombstoneMarker = { tombstoned: true, deletedAt: Date.now() };
    await this.writeRecord(key, marker);
  }

  async listKeysWithPrefix(
    keyPrefix: string,
    opts?: { readonly maxResults?: number },
  ): Promise<ReadonlyArray<string>> {
    const cap = opts?.maxResults ?? this.defaultMaxResults;
    if (!Number.isFinite(cap) || cap < 0) {
      throw new TypeError(
        `OrbitDbDispositionStorageAdapter.listKeysWithPrefix: maxResults must be a non-negative finite number (got ${String(cap)})`,
      );
    }
    // Round 5 (FIX 3) — plumb the cap through to ProfileDatabase.all() so
    // a hostile peer planting millions of crafted prefix matches cannot
    // trigger an unbounded materialization at the OrbitDB layer. The
    // adapter previously only bounded DECRYPT calls; the underlying map
    // was still fully populated. The new optional `maxResults` parameter
    // on ProfileDatabase.all() lets the OrbitDB backend short-circuit
    // iteration once it has buffered enough live entries.
    let entries: Map<string, Uint8Array>;
    try {
      entries = await this.db.all(keyPrefix, { maxResults: cap });
    } catch (err) {
      logger.warn(
        'OrbitDbDispositionStorageAdapter',
        `listKeysWithPrefix("${keyPrefix}"): db.all() failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
    // Round 5 (FIX 2) — filter + cap FIRST, then sort. The previous
    // `[...entries.keys()].sort()` materialized ALL keys then sorted
    // O(N log N) BEFORE applying the cap. A hostile prefix saturation
    // (db.all() returning N >> cap entries with the same prefix) made
    // this the DoS vector; the result-set sort is O(K log K) where
    // K = cap, while the iteration is bounded but unsorted until the
    // cap is hit.
    const out: string[] = [];
    for (const [k, ciphertext] of entries) {
      if (out.length >= cap) break;
      if (!k.startsWith(keyPrefix)) continue; // db.all may return wider matches
      const decoded = await this.tryDecode<unknown>(ciphertext, k);
      if (decoded === undefined) continue; // decode failure
      if (isTombstone(decoded)) continue;
      out.push(k);
    }
    // Sort the survivors for deterministic ordering — callers that want
    // most-recent-by-observedAt sort by the read record value, but
    // determinism in the key enumeration helps testability and helps
    // operators triage by-eye. The sort is O(K log K) where K <= cap.
    out.sort();
    return out;
  }

  // ---------------------------------------------------------------------------
  // Private — encode / decode helpers
  // ---------------------------------------------------------------------------

  private async encodeValue<T>(value: T): Promise<Uint8Array> {
    const json = JSON.stringify(value);
    return encryptString(this.encryptionKey, json);
  }

  private async tryDecode<T>(
    raw: Uint8Array,
    key: string,
  ): Promise<T | undefined> {
    // Issue #247 — `raw` may be either a CBOR-encoded OpLog envelope
    // (new writes via putEntry) or legacy raw AES-GCM ciphertext
    // (pre-#247 writes via raw db.put, OR bytes already unwrapped by
    // readRecord's getEnvelopePayload call). `unwrapEnvelopeBytes` is
    // idempotent — if `raw` is already unwrapped ciphertext, the
    // envelope decode fails and `raw` passes through unchanged.
    const ciphertext = unwrapEnvelopeBytes(raw);
    try {
      const json = await decryptString(this.encryptionKey, ciphertext);
      return JSON.parse(json) as T;
    } catch (err) {
      logger.warn(
        'OrbitDbDispositionStorageAdapter',
        `decode failed at key="${key}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  /**
   * Item #15 Phase B.4 — Return four prefix-scoped
   * {@link ProfileSyncWriter}s covering the address's disposition
   * surfaces:
   *
   *   - `${addressId}.invalid.`         — `_invalid` records keyed by
   *                                       (tokenId, observedContentHash).
   *                                       Content-immutable on the key
   *                                       disambiguator; constant-Lamport
   *                                       JOIN via {@link PrefixSyncWriter}
   *                                       is the correct semantics.
   *   - `${addressId}.invalid-orphan.`  — `_invalid` records for entries
   *                                       whose `tokenId` was the empty
   *                                       sentinel (structural-defect
   *                                       hydration throws). See
   *                                       `invalidKeyFor` in
   *                                       `profile/disposition-writer.ts`
   *                                       for the orphan-routing
   *                                       rationale.
   *   - `${addressId}.audit.`           — `_audit` records keyed by
   *                                       (tokenId, observedContentHash).
   *                                       Mostly content-immutable; the
   *                                       rare `auditStatus:
   *                                       'audit-promoted'` mutation
   *                                       causes operator-visible
   *                                       interim divergence that
   *                                       converges eventually.
   *                                       Constant-Lamport semantics
   *                                       are acceptable per the B.4
   *                                       scope analysis (see
   *                                       docs/uxf/OUTBOX-SEND-FOLLOWUPS.md).
   *   - `${addressId}.audit-orphan.`    — `_audit` orphan records (same
   *                                       sentinel routing as
   *                                       `_invalid-orphan`).
   *
   * **NOT covered by this method**: the `${addressId}.manifest.` surface.
   * Manifest entries are Lamport-tracked AND CAS-guarded with per-field
   * merge rules in `mergeManifestEntry`. A byte-verbatim JOIN would lose
   * the per-field merge. The production manifest storage is currently
   * in-memory only (an `MinimalManifestStorage` Map inside `PaymentsModule`),
   * so there is no OrbitDB persistence to JOIN against today. Treat as
   * a deferred follow-up; see `docs/uxf/OUTBOX-SEND-FOLLOWUPS.md` item
   * #15 "Deferred — B.4 manifest" for the path forward.
   *
   * Lifecycle and null semantics mirror
   * {@link OrbitDbRecipientContextStorageAdapter.syncWritersFor}.
   *
   * @param addressId  Wallet-address scope (`DIRECT_xxxxxx_yyyyyy`).
   * @throws TypeError when `addressId` is empty.
   */
  syncWritersFor(addressId: string): {
    readonly invalid: ProfileSyncWriter;
    readonly invalidOrphan: ProfileSyncWriter;
    readonly audit: ProfileSyncWriter;
    readonly auditOrphan: ProfileSyncWriter;
  } {
    if (typeof addressId !== 'string' || addressId.length === 0) {
      throw new TypeError(
        'OrbitDbDispositionStorageAdapter.syncWritersFor: addressId must be a non-empty string',
      );
    }
    // The four PrefixSyncWriters share the same db + key + notifier;
    // each is scoped to its own prefix. `validateValue` defaults to
    // "accept any plain non-tombstone object" — the disposition records
    // are heterogeneous shapes (InvalidRecord, AuditRecord, etc.) that
    // do not carry a `_schemaVersion` discriminator, so the default
    // validator is correct here.
    const common = {
      db: this.db,
      encryptionKey: this.encryptionKey,
      notifyProfileDirty: this.notifyProfileDirty ?? undefined,
    } as const;
    return {
      invalid: new PrefixSyncWriter({
        ...common,
        keyPrefix: dispositionInvalidPrefix(addressId),
        label: 'OrbitDbDispositionStorageAdapter.invalid',
      }),
      invalidOrphan: new PrefixSyncWriter({
        ...common,
        keyPrefix: dispositionInvalidOrphanPrefix(addressId),
        label: 'OrbitDbDispositionStorageAdapter.invalidOrphan',
      }),
      audit: new PrefixSyncWriter({
        ...common,
        keyPrefix: dispositionAuditPrefix(addressId),
        label: 'OrbitDbDispositionStorageAdapter.audit',
      }),
      auditOrphan: new PrefixSyncWriter({
        ...common,
        keyPrefix: dispositionAuditOrphanPrefix(addressId),
        label: 'OrbitDbDispositionStorageAdapter.auditOrphan',
      }),
    };
  }
}

// =============================================================================
// 3. Public prefix helpers — Item #15 Phase B.4
// =============================================================================

/**
 * Item #15 Phase B.4 — full prefix for `_invalid` records of an
 * address. Mirrors `invalidKeyFor`'s non-orphan branch (with trailing
 * dot for prefix-scan exactness).
 */
export function dispositionInvalidPrefix(addressId: string): string {
  return `${addressId}.invalid.`;
}

/**
 * Item #15 Phase B.4 — full prefix for `_invalid-orphan` records
 * (entries whose `tokenId` was the empty sentinel).
 */
export function dispositionInvalidOrphanPrefix(addressId: string): string {
  return `${addressId}.invalid-orphan.`;
}

/**
 * Item #15 Phase B.4 — full prefix for `_audit` records.
 */
export function dispositionAuditPrefix(addressId: string): string {
  return `${addressId}.audit.`;
}

/**
 * Item #15 Phase B.4 — full prefix for `_audit-orphan` records.
 */
export function dispositionAuditOrphanPrefix(addressId: string): string {
  return `${addressId}.audit-orphan.`;
}
