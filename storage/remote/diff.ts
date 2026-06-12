/**
 * TXF ↔ vault-entry diff (DESIGN §5.4) — the pure core of `sync()`.
 *
 * Maps a {@link TxfStorageDataBase} snapshot to the set of plaintext token keys
 * it carries (the dynamic `_<tokenId>` entries, excluding the reserved meta
 * slots), and computes the CAS ops needed to converge the server toward it given
 * the provider's INTERNAL last-known server state. All version/CAS bookkeeping is
 * internal (finding #29); the caller seals each op's payload separately.
 */

import type { TxfStorageDataBase } from '../storage-provider';

/** Reserved TXF keys that are NOT token entries (never flushed as CAS rows here). */
const RESERVED_KEYS = new Set(['_meta', '_tombstones', '_outbox', '_sent', '_invalid', '_history']);

/** The provider's last-known view of one server entry. */
export interface KnownEntry {
  /** The server version this key was last observed/applied at. */
  version: number;
  deleted: boolean;
}

/** A pending CAS op the provider must seal + PATCH. `plainKey` is pre-wire. */
export interface PlannedOp {
  plainKey: string;
  baseVersion: number;
  /** false → create/update (carries a payload); true → delete (tombstone). */
  isDelete: boolean;
  /** The raw token value to seal (omitted on a delete). */
  value?: unknown;
}

/**
 * Extract the `{tokenId → value}` map from a TXF snapshot: every `_<id>` key that
 * is not a reserved meta slot, with the leading underscore stripped.
 */
export function extractTokens(data: TxfStorageDataBase): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith('_') || RESERVED_KEYS.has(key)) continue;
    out.set(key.slice(1), value);
  }
  return out;
}

/**
 * Plan the CAS ops to converge the server from `known` toward `tokens`:
 *  - a token absent from `known` → create (`baseVersion 0`);
 *  - a token present in `known` (even as a tombstone) → re-create/update at
 *    `baseVersion 0` if the known row is deleted (delete-resurrect), else update
 *    at the known version. (We only emit an update when the value changed —
 *    callers pass already-changed values; here we re-flush every present token
 *    that is missing from the clean known map, which the provider suppresses via
 *    its content hash before calling this.)
 *  - a token in `known` (live) but absent from `tokens` → delete.
 *
 * `changed(plainKey, value)` lets the caller suppress no-op updates by comparing
 * against a content hash it persisted (returns false ⇒ skip the update op).
 */
export function planOps(
  tokens: Map<string, unknown>,
  known: Map<string, KnownEntry>,
  changed: (plainKey: string, value: unknown) => boolean,
): PlannedOp[] {
  const ops: PlannedOp[] = [];
  for (const [plainKey, value] of tokens) {
    const cur = known.get(plainKey);
    if (!cur) {
      ops.push({ plainKey, baseVersion: 0, isDelete: false, value });
    } else if (cur.deleted) {
      // Delete-resurrect: create AGAINST the deleted row at baseVersion 0 (#16).
      ops.push({ plainKey, baseVersion: 0, isDelete: false, value });
    } else if (changed(plainKey, value)) {
      ops.push({ plainKey, baseVersion: cur.version, isDelete: false, value });
    }
  }
  for (const [plainKey, cur] of known) {
    if (!cur.deleted && !tokens.has(plainKey)) {
      ops.push({ plainKey, baseVersion: cur.version, isDelete: true });
    }
  }
  return ops;
}
