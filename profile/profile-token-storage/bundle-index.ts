/**
 * BundleIndex
 *
 * Owns the OrbitDB-side bundle reference catalogue that
 * `ProfileTokenStorageProvider` uses to enumerate UXF bundles attached
 * to the wallet identity. Bundle refs live under the `tokens.bundle.*`
 * prefix, are individually encrypted with the per-wallet key, and are
 * wrapped in a system-stamped envelope (T-D11) so peers replicating the
 * ref see it as a system event rather than a forged user action.
 *
 * Cross-seam reads:
 *   - `FlushScheduler.flushToIpfs()` → `addBundle()` after pinning a
 *     fresh CAR; `listActiveBundles()` to validate a cached pinned CID
 *     and to drive consolidation; `shouldConsolidate()` to gate the
 *     consolidation pass.
 *   - The facade's `load()` / `sync()` → `listActiveBundles()` to
 *     enumerate bundles for the JOIN pass.
 *   - The facade's `clear()` → wipes all `tokens.bundle.*` keys plus
 *     `knownBundleCids`.
 *   - The replication handler → `refreshKnownBundles()` to detect newly
 *     replicated bundles.
 *
 * Cross-seam mutations: `knownBundleCids` (a `Set<string>`) is owned by
 * this module but stored on the facade (via host getters/setters) so
 * `clear()` and shutdown observers can read the same source of truth.
 *
 * @module profile/profile-token-storage/bundle-index
 */

import type { UxfBundleRef } from '../types.js';
import {
  encryptProfileValue,
  decryptProfileValue,
} from '../encryption.js';
import { buildLocalEntry, decodeEntry } from '../oplog-entry.js';
import {
  runJoinSnapshot,
  type ClassifiedSlot,
  type JoinResult,
  type ProfileSyncWriter,
  type SnapshotEntry,
} from '../profile-snapshot-merge.js';
import type { ProfileTokenStorageHost } from './host.js';

/** OrbitDB key prefix for UXF bundle references. */
export const BUNDLE_KEY_PREFIX = 'tokens.bundle.';

/** Threshold for invoking the consolidation engine. */
export const CONSOLIDATION_WARNING_THRESHOLD = 3;

/**
 * Steelman⁴¹ note: cap the inline-listed CIDs at 100 entries when
 * surfacing wholesale corruption via `storage:error`. The exact count
 * stays in the event payload regardless of truncation.
 */
const CORRUPT_CIDS_PREVIEW_CAP = 100;

export class BundleIndex implements ProfileSyncWriter {
  constructor(private readonly host: ProfileTokenStorageHost) {}

  /**
   * List all bundle refs from OrbitDB, filtered to active status.
   */
  async listActiveBundles(): Promise<Map<string, UxfBundleRef>> {
    const allBundles = await this.listBundles();
    const active = new Map<string, UxfBundleRef>();
    for (const [cid, ref] of allBundles) {
      if (ref.status === 'active') {
        active.set(cid, ref);
      }
    }
    return active;
  }

  /**
   * List all bundle refs from OrbitDB (all statuses).
   *
   * Bundle refs are written as system-stamped envelopes by
   * `addBundle` (T-D11). Legacy wallets may have raw-bytes entries
   * (pre-envelope writes) — we detect those by attempting the
   * structured decode first, falling back to treating the stored
   * bytes as the encrypted payload directly. On the fallback path
   * the entry acts as a `v=0` legacy entry under the oplog-schema
   * contract (synthetic `originated='system'` at read time via the
   * adapter's legacy-wrapping).
   */
  async listBundles(): Promise<Map<string, UxfBundleRef>> {
    const rawEntries = await this.host.db.all(BUNDLE_KEY_PREFIX);
    const result = new Map<string, UxfBundleRef>();

    // Steelman⁴⁰ warning: aggregate corrupt-bundle events into a single
    // emit so wholesale corruption (key drift after restore-from-backup,
    // etc.) doesn't flood the consumer with N events for N bundles.
    const corruptCids: string[] = [];
    let firstCorruptError: unknown = null;

    const encryptionKey = this.host.getEncryptionKey();

    for (const [key, value] of rawEntries) {
      const cid = key.slice(BUNDLE_KEY_PREFIX.length);
      try {
        // Extract the encrypted payload from either a stamped
        // envelope (new path, T-D11) or the raw bytes (legacy). A
        // successful envelope decode whose `v===1` wins; anything
        // else — decode throws, or `v===0` legacy sentinel — falls
        // through to treating `value` as the raw encrypted payload.
        let encryptedPayload: Uint8Array = value;
        try {
          const envelope = decodeEntry(value);
          if (envelope.v === 1) {
            encryptedPayload = envelope.payload;
          }
        } catch {
          // Not an envelope — raw-bytes legacy write. Use `value`
          // directly.
        }

        const decrypted = encryptionKey
          ? await decryptProfileValue(encryptionKey, encryptedPayload)
          : encryptedPayload;
        const ref = JSON.parse(new TextDecoder().decode(decrypted)) as UxfBundleRef;
        result.set(cid, ref);
      } catch (err) {
        // Steelman³⁸/⁴⁰: log per-bundle but AGGREGATE the events into a
        // single emit at the end of the loop so wholesale corruption
        // doesn't flood the UI with N banners for N bundles.
        this.host.log(`Failed to deserialize bundle ref for ${cid}: ${err instanceof Error ? err.message : String(err)}`);
        corruptCids.push(cid);
        if (firstCorruptError === null) firstCorruptError = err;
      }
    }

    if (corruptCids.length > 0) {
      const ev = this.host.buildErrorEvent('storage:error', firstCorruptError, 'CID_REF_CORRUPT');
      const truncated = corruptCids.length > CORRUPT_CIDS_PREVIEW_CAP;
      this.host.emitEvent({
        ...ev,
        data: {
          corruptCids: truncated ? corruptCids.slice(0, CORRUPT_CIDS_PREVIEW_CAP) : corruptCids,
          truncated,
          count: corruptCids.length,
        },
      });
    }

    return result;
  }

  /**
   * Write a bundle ref to OrbitDB under a system-stamped envelope
   * (T-D11 W11). Bundle events are system-generated cache-index
   * writes; they are NOT user-actions (they reflect a token-pool
   * flush produced by the wallet itself, not a user intent to
   * commit tokens). Stamping `originated='system'` means peers
   * replicating the ref see it as a replicated system event after
   * the orbitdb-adapter's read-time downgrade, not a forged user
   * action.
   *
   * If the underlying adapter lacks `putEntry` (very old code paths
   * or test stubs), fall back to `db.put` of raw encrypted bytes —
   * readers auto-wrap raw writes as legacy entries (`v=0`, synthetic
   * `type='cache_index'`, `originated='system'`), so the semantic
   * outcome is identical and replication remains safe.
   */
  async addBundle(cid: string, ref: UxfBundleRef): Promise<void> {
    const encryptionKey = this.host.getEncryptionKey();
    const serialized = new TextEncoder().encode(JSON.stringify(ref));
    const encryptedPayload = encryptionKey
      ? await encryptProfileValue(encryptionKey, serialized)
      : serialized;

    const key = BUNDLE_KEY_PREFIX + cid;
    const db = this.host.db;
    if (typeof db.putEntry === 'function') {
      const envelope = buildLocalEntry({
        type: 'cache_index',
        originated: 'system',
        payload: encryptedPayload,
      });
      await db.putEntry(key, envelope);
    } else {
      await db.put(key, encryptedPayload);
      // Mark locally-authored on the fallback path too, so any
      // downstream `getEntry` consumer that consults
      // `localAuthoredKeys` sees this write as local rather than
      // force-downgrading it to 'replicated'. Mirrors the
      // convention in profile/profile-storage-provider.ts:writeEnvelope.
      const markHook = (db as { markLocallyAuthored?: (k: string) => void }).markLocallyAuthored;
      if (typeof markHook === 'function') {
        markHook.call(db, key);
      }
    }
    this.host.getKnownBundleCids().add(cid);
  }

  /**
   * Check if the number of active bundles exceeds the consolidation
   * threshold.
   */
  async shouldConsolidate(): Promise<boolean> {
    const active = await this.listActiveBundles();
    return active.size > CONSOLIDATION_WARNING_THRESHOLD;
  }

  /**
   * Refresh the local set of known bundle CIDs from OrbitDB.
   */
  async refreshKnownBundles(): Promise<void> {
    const bundles = await this.listActiveBundles();
    this.host.setKnownBundleCids(new Set(bundles.keys()));
  }

  // ===========================================================================
  // Item #15 Phase B.6 — full-profile-snapshot sync API
  // ===========================================================================

  /**
   * Return every `tokens.bundle.*` entry as raw on-disk bytes for the
   * lean-snapshot builder. Bytes are returned verbatim — the envelope
   * wrapper, encrypted payload, and JSON-encoded UxfBundleRef stay
   * intact so the receiving peer can persist them with a single
   * `db.put` and let its own `listBundles()` decode them transparently.
   *
   * **No tombstones to surface.** Bundle refs do not get tombstoned in
   * the current architecture — superseded refs transition via the
   * `status: 'superseded'` field on a fresh `addBundle()` write, not via
   * a tombstone marker. Phase B's tombstone-sticky rules therefore
   * never fire here; the merge degenerates to "absent → write, live +
   * live → no-op (first wins at Lamport=0)".
   *
   * Stable order: ascending lexicographic key.
   */
  async snapshot(): Promise<ReadonlyArray<SnapshotEntry>> {
    let entries: Map<string, Uint8Array>;
    try {
      entries = await this.host.db.all(BUNDLE_KEY_PREFIX);
    } catch {
      return [];
    }
    const out: SnapshotEntry[] = [];
    const sortedKeys = [...entries.keys()].sort();
    for (const key of sortedKeys) {
      if (!key.startsWith(BUNDLE_KEY_PREFIX)) continue;
      const encryptedValue = entries.get(key);
      if (encryptedValue === undefined) continue;
      out.push({ key, encryptedValue });
    }
    return out;
  }

  /**
   * Apply a remote peer's bundle-index snapshot. Each remote entry
   * carries an envelope-wrapped, encrypted UxfBundleRef; the classifier
   * decodes + decrypts + parses + validates before the merge primitive
   * picks a winner.
   *
   * **Constant-Lamport semantics.** UxfBundleRef does not carry a
   * Lamport field, so `live + live` ties always favour local (the
   * first-wins behaviour matches Issue #166's refuse-write guard
   * semantics extended to this surface). If two replicas independently
   * transition the same CID from `active` to `superseded` after a
   * consolidation, both writes are observationally idempotent (the
   * resulting state is the same — superseded with the same
   * `supersededBy`).
   *
   * **Side-effect: known-CID refresh.** After a successful JOIN that
   * lands new bundles, this writer updates `knownBundleCids` so the
   * consolidation gate and replication handler observe the freshly-
   * landed refs.
   */
  async joinSnapshot(
    remote: ReadonlyArray<SnapshotEntry>,
  ): Promise<JoinResult> {
    const result = await runJoinSnapshot(remote, {
      classifyLocal: async (key) => {
        if (!key.startsWith(BUNDLE_KEY_PREFIX)) return { kind: 'absent' };
        let raw: Uint8Array | null;
        try {
          raw = await this.host.db.get(key);
        } catch {
          return { kind: 'absent' };
        }
        if (raw === null) return { kind: 'absent' };
        const slot = await this.classifyBundleBytes(raw, /* remote = */ false);
        return slot ?? { kind: 'absent' };
      },
      classifyRemote: async (entry) => {
        if (!entry.key.startsWith(BUNDLE_KEY_PREFIX)) return null;
        return this.classifyBundleBytes(entry.encryptedValue, /* remote = */ true);
      },
      writeRemote: async (key, bytes) => {
        await this.host.db.put(key, bytes);
        const cid = key.slice(BUNDLE_KEY_PREFIX.length);
        if (cid.length > 0) {
          this.host.getKnownBundleCids().add(cid);
        }
      },
    });
    return result;
  }

  /**
   * Decode an envelope (if present), decrypt the inner payload, parse
   * as JSON, and validate the shape is a `UxfBundleRef`. Returns a
   * {@link ClassifiedSlot} on success or `null` on the remote path
   * for any failure (the JOIN counts as `remoteRejectedMalformed`).
   * On the local path, failure maps to `absent` so a well-formed
   * remote can land.
   *
   * UxfBundleRef shape (per `profile/types.ts`):
   *   - required: cid:string, status: 'active'|'superseded'|'unverified', createdAt:number
   *   - optional: device, supersededBy, removeFromProfileAfter, tokenCount
   */
  private async classifyBundleBytes(
    raw: Uint8Array,
    remote: boolean,
  ): Promise<ClassifiedSlot | null> {
    if (!raw || raw.byteLength === 0) {
      return remote ? null : { kind: 'absent' };
    }
    // Envelope decode — falls back to raw bytes for legacy (pre-T-D11)
    // entries. Mirrors `listBundles()`.
    let encryptedPayload: Uint8Array = raw;
    try {
      const envelope = decodeEntry(raw);
      if (envelope.v === 1) {
        encryptedPayload = envelope.payload;
      }
    } catch {
      // Legacy raw-bytes write — use the raw payload directly.
    }
    const encryptionKey = this.host.getEncryptionKey();
    let decrypted: Uint8Array;
    try {
      decrypted = encryptionKey
        ? await decryptProfileValue(encryptionKey, encryptedPayload)
        : encryptedPayload;
    } catch {
      return remote ? null : { kind: 'absent' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(decrypted));
    } catch {
      return remote ? null : { kind: 'absent' };
    }
    if (!isUxfBundleRef(parsed)) {
      return remote ? null : { kind: 'absent' };
    }
    // No Lamport field on bundle refs — treat as constant Lamport=0
    // (matches the FinalizationQueue / RecipientContext sync writer
    // semantics; see profile/prefix-sync-writer.ts).
    return { kind: 'live', lamport: 0 };
  }
}

/**
 * Runtime guard for {@link UxfBundleRef}. Validates the required
 * fields and the `status` enum; tolerates optional fields when
 * present (`device`, `supersededBy`, `removeFromProfileAfter`,
 * `tokenCount`).
 */
function isUxfBundleRef(value: unknown): value is UxfBundleRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.cid !== 'string' || obj.cid.length === 0) return false;
  if (obj.status !== 'active' && obj.status !== 'superseded' && obj.status !== 'unverified') {
    return false;
  }
  if (typeof obj.createdAt !== 'number' || !Number.isFinite(obj.createdAt)) return false;
  // Optional fields: type-check when present.
  if (obj.device !== undefined && typeof obj.device !== 'string') return false;
  if (obj.supersededBy !== undefined && typeof obj.supersededBy !== 'string') return false;
  if (
    obj.removeFromProfileAfter !== undefined &&
    typeof obj.removeFromProfileAfter !== 'number'
  ) {
    return false;
  }
  if (obj.tokenCount !== undefined && typeof obj.tokenCount !== 'number') return false;
  return true;
}
