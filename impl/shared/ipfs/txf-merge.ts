/**
 * TXF Data Merge / Conflict Resolution
 * Merges local and remote TXF storage data with proper conflict handling
 */

import type { TxfStorageDataBase, TxfTombstone } from '../../../storage';
import type { MergeResult } from './ipfs-types';

// =============================================================================
// Merge Logic
// =============================================================================

/**
 * Merge local and remote TXF data.
 *
 * Rules:
 * 1. Meta: Higher version wins as base; increment by 1
 * 2. Tombstones: Union by composite key (tokenId, stateHash)
 * 3. Token entries: present in only one source -> add; both -> local wins
 * 4. Tombstone filtering: exclude tokens present in merged tombstones
 * 5. Outbox/Sent: Union with dedup by id/tokenId
 */
export function mergeTxfData<T extends TxfStorageDataBase>(
  local: T,
  remote: T,
): MergeResult<T> {
  let added = 0;
  let removed = 0;
  let conflicts = 0;

  // 1. Merge meta — use higher version as base, increment
  const localVersion = local._meta?.version ?? 0;
  const remoteVersion = remote._meta?.version ?? 0;
  const baseMeta = localVersion >= remoteVersion ? local._meta : remote._meta;
  const mergedMeta = {
    ...baseMeta,
    version: Math.max(localVersion, remoteVersion) + 1,
    updatedAt: Date.now(),
  };

  // 2. Merge tombstones — union by composite key (tokenId + stateHash)
  const mergedTombstones = mergeTombstones(
    local._tombstones ?? [],
    remote._tombstones ?? [],
  );
  const tombstoneKeys = new Set(
    mergedTombstones.map((t) => `${t.tokenId}:${t.stateHash}`),
  );

  // 3. Merge token entries
  const localTokenKeys = getTokenKeys(local);
  const remoteTokenKeys = getTokenKeys(remote);
  const allTokenKeys = new Set([...localTokenKeys, ...remoteTokenKeys]);

  const mergedTokens: Record<string, unknown> = {};

  for (const key of allTokenKeys) {
    const tokenId = key.startsWith('_') ? key.slice(1) : key;
    const localToken = (local as Record<string, unknown>)[key];
    const remoteToken = (remote as Record<string, unknown>)[key];

    // Check tombstone filter
    if (isTokenTombstoned(tokenId, localToken, remoteToken, tombstoneKeys)) {
      if (localTokenKeys.has(key)) removed++;
      continue;
    }

    if (localToken && !remoteToken) {
      // Only in local
      mergedTokens[key] = localToken;
    } else if (!localToken && remoteToken) {
      // Only in remote
      mergedTokens[key] = remoteToken;
      added++;
    } else if (localToken && remoteToken) {
      // In both — local wins (with conflict count)
      mergedTokens[key] = localToken;
      conflicts++;
    }
  }

  // 4. Merge outbox — union with dedup by id
  const mergedOutbox = mergeArrayById(
    local._outbox ?? [],
    remote._outbox ?? [],
    'id',
  );

  // 5. Merge sent — union with dedup by tokenId
  const mergedSent = mergeArrayById(
    local._sent ?? [],
    remote._sent ?? [],
    'tokenId',
  );

  // 6. Merge invalid — union with dedup by tokenId
  const mergedInvalid = mergeArrayById(
    local._invalid ?? [],
    remote._invalid ?? [],
    'tokenId',
  );

  // Build merged result
  const merged = {
    _meta: mergedMeta,
    _tombstones: mergedTombstones.length > 0 ? mergedTombstones : undefined,
    _outbox: mergedOutbox.length > 0 ? mergedOutbox : undefined,
    _sent: mergedSent.length > 0 ? mergedSent : undefined,
    _invalid: mergedInvalid.length > 0 ? mergedInvalid : undefined,
    ...mergedTokens,
  } as T;

  return { merged, added, removed, conflicts };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Merge tombstone arrays by composite key (tokenId + stateHash).
 * On duplicates, keep the one with the newer timestamp.
 */
function mergeTombstones(
  local: TxfTombstone[],
  remote: TxfTombstone[],
): TxfTombstone[] {
  const merged = new Map<string, TxfTombstone>();

  for (const tombstone of [...local, ...remote]) {
    const key = `${tombstone.tokenId}:${tombstone.stateHash}`;
    const existing = merged.get(key);
    if (!existing || tombstone.timestamp > existing.timestamp) {
      merged.set(key, tombstone);
    }
  }

  return Array.from(merged.values());
}

/**
 * Get all token entry keys from TXF data.
 * Token keys start with '_' but are not meta fields.
 */
function getTokenKeys(data: TxfStorageDataBase): Set<string> {
  const reservedKeys = new Set([
    '_meta', '_tombstones', '_outbox', '_sent', '_invalid',
    '_nametag', '_mintOutbox', '_invalidatedNametags', '_integrity',
  ]);
  const keys = new Set<string>();

  for (const key of Object.keys(data)) {
    if (reservedKeys.has(key)) continue;
    // Exclude archived, forked, and nametag entries from token merge
    if (key.startsWith('archived-') || key.startsWith('_forked_') || key.startsWith('nametag-')) continue;
    keys.add(key);
  }

  return keys;
}

/**
 * Check if a token should be filtered by tombstones.
 */
function isTokenTombstoned(
  tokenId: string,
  localToken: unknown,
  remoteToken: unknown,
  tombstoneKeys: Set<string>,
): boolean {
  // Check if any variant of this token is tombstoned
  // We check generic tokenId matching since we may not have the stateHash here
  for (const key of tombstoneKeys) {
    if (key.startsWith(`${tokenId}:`)) {
      return true;
    }
  }
  // Keep token if not tombstoned
  void localToken;
  void remoteToken;
  return false;
}

/**
 * Merge arrays by a key field, deduplicating.
 * On duplicates, keep the one from the first array (local).
 */
function mergeArrayById<T>(
  local: T[],
  remote: T[],
  idField: keyof T,
): T[] {
  const seen = new Map<unknown, T>();

  for (const item of local) {
    const id = item[idField];
    if (id !== undefined) {
      seen.set(id, item);
    }
  }

  for (const item of remote) {
    const id = item[idField];
    if (id !== undefined && !seen.has(id)) {
      seen.set(id, item);
    }
  }

  return Array.from(seen.values());
}
