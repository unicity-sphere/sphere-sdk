/**
 * TXF ↔ vault-entry diff (DESIGN §5.4) — the pure core of `sync()`.
 *
 * Maps a {@link TxfStorageDataBase} snapshot to the set of plaintext token keys
 * it carries (the dynamic `_<tokenId>` entries, excluding the reserved meta
 * slots), and computes the CAS ops needed to converge the server toward it given
 * the provider's INTERNAL last-known server state.
 *
 * The last-known state is keyed by the OPAQUE wireKey — that is what `/state`
 * reports (the server is operator-blind and never sees plaintext token ids). The
 * diff computes `wireKey(plainKey)` for each local token to look it up, so a
 * deleted server row (known only by its wireKey) is matched and resurrected.
 * All version/CAS bookkeeping is internal (finding #29).
 */

import type { TxfStorageDataBase } from '../storage-provider';

/** Reserved TXF keys that are NOT token entries (never flushed as CAS rows here). */
const RESERVED_KEYS = new Set(['_meta', '_tombstones', '_outbox', '_sent', '_invalid', '_history']);

/** The provider's last-known view of one server entry, keyed by wireKey. */
export interface KnownEntry {
  /** The server version this key was last observed/applied at. */
  version: number;
  deleted: boolean;
}

/** A pending CAS op the provider must seal + PATCH. Carries the OPAQUE wireKey. */
export interface PlannedOp {
  /** The plaintext token id (for content-hash bookkeeping). */
  plainKey: string;
  /** The opaque wireKey the op targets on the wire. */
  wireKey: string;
  baseVersion: number;
  /**
   * The version the SERVER will assign to this entry once applied — the AAD seal
   * version (finding vault-aead-resurrect-version-mismatch). For a fresh create it
   * is 1 and for an update it is `baseVersion + 1`, BUT for a delete-RESURRECT
   * (CAS `baseVersion:0` against a known tombstone) the server converges the row
   * monotonically to `deletedRow.version + 1` — NOT 1 — so the payload AAD MUST be
   * sealed at that version or a fresh load() cannot decrypt the resurrected entry.
   */
  sealVersion: number;
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

export interface PlanOpsParams {
  tokens: Map<string, unknown>;
  /** Last-known server state, keyed by wireKey. */
  known: Map<string, KnownEntry>;
  /** Map a plaintext token id to its opaque wireKey. */
  wireKeyOf: (plainKey: string) => string;
  /** True when the value differs from the last-flushed content hash (skip no-op updates). */
  changed: (wireKey: string, value: unknown) => boolean;
  /**
   * Provider-managed reserved wireKeys (e.g. the meta-address slot) that are NOT
   * token entries — never swept as orphan deletes even though they live in `known`.
   */
  reserved?: ReadonlySet<string>;
  /**
   * Plaintext token ids the wallet has POSITIVELY spent (from `_tombstones`).
   * ONLY these are deleted from the server. An entry merely ABSENT from `tokens`
   * is NEVER deleted: absence ≠ spend — the local snapshot can be incomplete
   * (the load pull hasn't run, a decrypt failed, a fresh device), and deleting on
   * absence wiped the whole vault when local was empty
   * (finding: vault-orphan-sweep-data-loss).
   */
  tombstonedTokenIds?: Iterable<string>;
}

/**
 * Plan the CAS ops to converge the server from `known` toward `tokens`:
 *  - a token whose wireKey is absent from `known` → create (`baseVersion 0`);
 *  - a token whose wireKey is a known TOMBSTONE → re-create at `baseVersion 0`
 *    AGAINST the deleted row (delete-resurrect, #16 — NOT rebased to its version);
 *  - a token whose wireKey is a known LIVE row → update at the known version, but
 *    only when the value changed;
 *  - a token POSITIVELY spent (its id in `tombstonedTokenIds`) whose wireKey is a
 *    known LIVE row → delete. An entry merely ABSENT from `tokens` is NEVER
 *    deleted (absence ≠ spend); reserved provider-managed slots are never touched.
 */
export function planOps(params: PlanOpsParams): PlannedOp[] {
  const { tokens, known, wireKeyOf, changed, reserved } = params;
  const ops: PlannedOp[] = [];
  const liveWire = new Set<string>();
  for (const [plainKey, value] of tokens) {
    const wk = wireKeyOf(plainKey);
    liveWire.add(wk);
    const cur = known.get(wk);
    if (!cur) {
      // Fresh create: server assigns v1; seal the AAD at v1.
      ops.push({ plainKey, wireKey: wk, baseVersion: 0, sealVersion: 1, isDelete: false, value });
    } else if (cur.deleted) {
      // Delete-resurrect (#16): CAS baseVersion 0 against the tombstone, but the
      // server converges to `deletedRow.version + 1` (monotonic) — seal at THAT
      // version so a fresh load() can decrypt it (vault-aead-resurrect-version-mismatch).
      ops.push({ plainKey, wireKey: wk, baseVersion: 0, sealVersion: cur.version + 1, isDelete: false, value });
    } else if (changed(wk, value)) {
      // Update: CAS at the known version; server assigns `version + 1`.
      ops.push({ plainKey, wireKey: wk, baseVersion: cur.version, sealVersion: cur.version + 1, isDelete: false, value });
    }
  }
  // DELETE only POSITIVELY-spent tokens (explicit tombstones) — NEVER an entry that
  // is merely absent from `tokens`. Absence is not proof of a spend: the local
  // snapshot can be empty/partial (the load pull hasn't run, a decrypt failed, a
  // fresh device), and deleting on absence wiped the whole vault when local was
  // empty (vault-orphan-sweep-data-loss). A live token is keyed by its
  // genesis-stable tokenId, so a tombstone's tokenId maps straight to its wireKey.
  const sweptWire = new Set<string>();
  for (const tokenId of params.tombstonedTokenIds ?? []) {
    const wk = wireKeyOf(tokenId);
    if (sweptWire.has(wk)) continue;
    sweptWire.add(wk);
    const cur = known.get(wk);
    // Never delete a token we still hold locally (liveWire) or a reserved slot.
    if (cur && !cur.deleted && !liveWire.has(wk) && !reserved?.has(wk)) {
      ops.push({ plainKey: tokenId, wireKey: wk, baseVersion: cur.version, sealVersion: cur.version + 1, isDelete: true });
    }
  }
  return ops;
}
