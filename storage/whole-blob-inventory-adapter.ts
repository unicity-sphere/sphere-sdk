/**
 * storage/whole-blob-inventory-adapter.ts — default lazy-port adapter for
 * whole-blob providers (sdk-changes S2).
 *
 * The lazy inventory port (`listInventory` / `getToken` / `applyDelta`) is the
 * wallet's hot path against wallet-api, but the port extension must keep every
 * EXISTING whole-blob provider conformant — swappability is a covenant
 * (sdk-changes S7), not an aspiration. This adapter derives the three methods
 * from the provider's own `load()`/`save()`:
 *
 * - `listInventory()` — the view computed from the loaded set: every stored
 *   token is `'active'`, with synthetic `seq`/`cursor`, `more: false`, and
 *   `syncEpoch: 0n` (a local store has no server restore to signal). There is
 *   no change journal, so `since` is ignored and the full active snapshot is
 *   returned — a degenerate but coherent cursor model.
 * - `getToken()` — decoded from the loaded set (v2 blob entries only).
 * - `applyDelta()` — tombstones `spent` entries (the provider's own tombstone
 *   handling deletes the stored blobs) and asserts `added` outputs are already
 *   present: a whole-blob provider cannot materialize bytes from a blob-store
 *   key — the engine path `save()`s its outputs first. Naturally idempotent:
 *   an already-tombstoned `spent` row and an already-present (or since-moved)
 *   `added` row are success, mirroring ARCHITECTURE §5.3 step 4.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { decodeTokenBlob } from '../token-engine/token-blob';
import type { TokenBlob } from '../token-engine/types';
import { SphereError } from '../core/errors';
import type {
  ApplyDeltaAdded,
  ApplyDeltaOptions,
  InventoryItem,
  InventoryView,
  LoadResult,
  SaveResult,
  TxfStorageDataBase,
  TxfTombstone,
} from './storage-provider';

/** The slice of a whole-blob provider the adapter needs. */
export interface WholeBlobStore<TData extends TxfStorageDataBase = TxfStorageDataBase> {
  load(identifier?: string): Promise<LoadResult<TData>>;
  save(data: TData): Promise<SaveResult>;
}

/** A stored token entry that carries a v2 blob (the UI token record). */
interface V2TokenEntry {
  sdkData: string;
  coinId?: string;
  amount?: string;
}

const TOKEN_KEY_RE = /^_[0-9a-f]{4,}$/i;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A v2 engine blob is even-length hex (CBOR); legacy v1 TXF is JSON. */
function isV2BlobHex(sdkData: unknown): sdkData is string {
  return (
    typeof sdkData === 'string' &&
    sdkData.length >= 2 &&
    sdkData.length % 2 === 0 &&
    /^[0-9a-f]+$/i.test(sdkData)
  );
}

function isV2TokenEntry(entry: unknown): entry is V2TokenEntry {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    !('genesis' in entry) &&
    isV2BlobHex((entry as V2TokenEntry).sdkData)
  );
}

/** Stored token entries keyed by genesis tokenId (the `_<id>` key minus `_`). */
function collectTokenEntries(data: TxfStorageDataBase): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, value] of Object.entries(data)) {
    if (!TOKEN_KEY_RE.test(key)) continue;
    if (value === null || typeof value !== 'object') continue;
    out.set(key.slice(1), value);
  }
  return out;
}

function entryAssets(entry: unknown): InventoryItem['assets'] {
  if (!isV2TokenEntry(entry)) return undefined;
  const { coinId, amount } = entry;
  if (typeof coinId !== 'string' || typeof amount !== 'string' || !/^[0-9]+$/.test(amount)) {
    return undefined;
  }
  return [{ coinId, amount: BigInt(amount) }];
}

/**
 * Default-adapter implementation of the S2 lazy port over a whole-blob store.
 * Providers instantiate one lazily and delegate their `listInventory` /
 * `getToken` / `applyDelta` to it (minimal edits, shared semantics).
 */
export class WholeBlobInventoryAdapter<TData extends TxfStorageDataBase = TxfStorageDataBase> {
  constructor(private readonly store: WholeBlobStore<TData>) {}

  private async loadData(): Promise<TData> {
    const result = await this.store.load();
    if (!result.success || !result.data) {
      throw new SphereError(
        `Whole-blob inventory adapter: load() failed${result.error ? `: ${result.error}` : ''}`,
        'STORAGE_ERROR'
      );
    }
    return result.data;
  }

  /** View computed from the loaded set: all `'active'`, synthetic seq/cursor, `more: false`. */
  async listInventory(_since?: bigint): Promise<InventoryView> {
    const data = await this.loadData();
    const entries = [...collectTokenEntries(data).entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    const items: InventoryItem[] = entries.map(([tokenId, entry], index) => ({
      tokenId,
      status: 'active' as const,
      assets: entryAssets(entry),
      seq: BigInt(index + 1),
    }));
    return { cursor: BigInt(items.length), syncEpoch: 0n, more: false, items };
  }

  /** Serve a token's decoded blob from the loaded set (v2 blob entries only). */
  async getToken(tokenId: string): Promise<TokenBlob> {
    const data = await this.loadData();
    const entry = collectTokenEntries(data).get(tokenId);
    if (entry === undefined) {
      throw new SphereError(`Token ${tokenId} not found in storage`, 'STORAGE_ERROR');
    }
    if (!isV2TokenEntry(entry)) {
      throw new SphereError(`Token ${tokenId} has no v2 blob (legacy TXF entry)`, 'STORAGE_ERROR');
    }
    const blob = decodeTokenBlob(hexToBytes(entry.sdkData));
    if (blob.tokenId !== tokenId) {
      throw new SphereError(
        `Stored blob tokenId mismatch for ${tokenId} (blob carries ${blob.tokenId})`,
        'STORAGE_ERROR'
      );
    }
    return blob;
  }

  /**
   * Tombstone `spent`, assert `added` present. Mirrors the §5.3 apply
   * semantics a local store can honor; idempotent by construction (replays
   * find spent already tombstoned / added already present → success).
   */
  async applyDelta(
    _transferId: string,
    spent: string[],
    added: ApplyDeltaAdded[],
    _opts?: ApplyDeltaOptions
  ): Promise<void> {
    const addedIds = new Set(added.map((a) => a.tokenId));
    for (const tokenId of spent) {
      if (addedIds.has(tokenId)) {
        // Mirrors the server's 422 (ARCHITECTURE §5.3): a self-send routes
        // through the mailbox, never through one apply.
        throw new SphereError(
          `applyDelta: token ${tokenId} appears in both spent and added`,
          'VALIDATION_ERROR'
        );
      }
    }

    const data = await this.loadData();
    const entries = collectTokenEntries(data);
    const tombstoned = new Set((data._tombstones ?? []).map((t) => t.tokenId));

    for (const { tokenId } of added) {
      // A whole-blob store cannot fetch bytes by blob-store key; the engine
      // path save()s outputs before recording the spend. Present (or already
      // moved on to a tombstone) is success; never-seen is a caller bug.
      if (!entries.has(tokenId) && !tombstoned.has(tokenId)) {
        throw new SphereError(
          `applyDelta: added token ${tokenId} is not in storage — save() engine outputs before applyDelta`,
          'STORAGE_ERROR'
        );
      }
    }

    const newTombstones: TxfTombstone[] = [];
    for (const tokenId of spent) {
      const entry = entries.get(tokenId);
      if (entry === undefined) continue; // already tombstoned/unknown → success (§5.3 step 4)
      let stateHash = '';
      if (isV2TokenEntry(entry)) {
        try {
          const blob = decodeTokenBlob(hexToBytes(entry.sdkData));
          stateHash = bytesToHex(sha256(blob.token));
        } catch {
          // Tombstone without a state hash is still a valid removal record.
        }
      }
      newTombstones.push({ tokenId, stateHash, timestamp: Date.now() });
      delete data[`_${tokenId}`];
    }

    if (newTombstones.length === 0) return; // pure replay — nothing to write

    data._tombstones = [...(data._tombstones ?? []), ...newTombstones];
    const result = await this.store.save(data);
    if (!result.success) {
      throw new SphereError(
        `Whole-blob inventory adapter: save() failed${result.error ? `: ${result.error}` : ''}`,
        'STORAGE_ERROR'
      );
    }
  }
}
