/**
 * Lean Profile Snapshot — full-profile-state CAR for the aggregator-pointer
 * sync path (Item #15 Phase A).
 *
 * This is a sibling of `profile/profile-export.ts` (the "fat" v1 used by
 * the operator-facing back-up / restore CLI). The lean variant is the
 * payload published to the aggregator pointer under the new sync
 * architecture: every peer-local mutation (OUTBOX/SENT/dispositions/
 * UXF-token state) flushes into a lean snapshot whose CID becomes the
 * next pointer version. Other peers pull the snapshot, JOIN per writer,
 * converge.
 *
 * Differences from v1 (`profile-export.ts`):
 *
 *   - **No bundle CAR embedding.** `bundles[]` carries CID + minimal
 *     metadata only. The bundle CARs themselves stay pinned on IPFS via
 *     the existing per-bundle pin path; receivers fetch them lazily.
 *     This collapses snapshot size from "sum of all bundle CARs" to
 *     "sum of OrbitDB KV envelopes" — orders of magnitude smaller for
 *     a wallet with many tokens.
 *
 *   - **Filter reversal.** v1 strips operational keys (`tokens.bundle.*`,
 *     `consolidation.*`) since the fat snapshot is meant for back-up,
 *     where bundle refs get reconstructed from the bundle index. Under
 *     #15 the snapshot IS the propagation mechanism for these writers,
 *     so we INCLUDE them in `entries[]`. Per-device transport sync
 *     cursors (`last_wallet_event_ts_*`, `last_dm_event_ts_*`) remain
 *     filtered — those are per-device state that must NOT propagate
 *     (or peer B picks up peer A's transport cursor and skips events it
 *     has not actually seen).
 *
 *   - **Version 2.** Disambiguates the two payload shapes at the CAR
 *     level. v1 readers reject v2 (the existing
 *     `parseProfileSnapshot` rejects `version > PROFILE_SNAPSHOT_VERSION
 *     = 1`); v2 readers (this file's `parseLeanProfileSnapshot`)
 *     accept exactly version 2 and reject everything else. No
 *     cross-decoding — the two formats are not interchangeable.
 *
 * Encryption-form invariant carries over from v1: KV values are read
 * via `getEncryptedRaw` and emitted as ciphertext. Plaintext mnemonics
 * / master keys never reach this layer. Snapshot privacy reduces to
 * mnemonic privacy — the destination peer must derive the same master
 * key (same mnemonic) to decrypt them. Phases B / D add the per-writer
 * JOIN logic that consumes the encrypted KV envelopes.
 *
 * Determinism: entries[] sorted by key, bundles[] sorted by CID,
 * `createdAt` option-overridable. Two builds of the same Profile state
 * produce byte-identical CARs.
 *
 * @see profile/profile-export.ts — the v1 fat snapshot (CLI export/import)
 * @see docs/uxf/OUTBOX-SEND-FOLLOWUPS.md — Item #15 (full design)
 * @module profile/profile-lean-snapshot
 */

import { encode as dagCborEncode, decode as dagCborDecode } from '@ipld/dag-cbor';
import { CID } from 'multiformats/cid';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { create as createMultihash } from 'multiformats/hashes/digest';
import { CarWriter } from '@ipld/car/writer';
import { CarReader } from '@ipld/car';

import type { StorageProvider } from '../storage/storage-provider.js';
import type { ProfileTokenStorageProvider } from './profile-token-storage-provider.js';
import { logger } from '../core/logger.js';
import { ProfileError } from './errors.js';
import type { UxfBundleRef } from './types.js';

// =============================================================================
// Types & constants
// =============================================================================

/**
 * Lean profile snapshot schema version emitted by the builder.
 *
 * **v3 (current)** — hierarchical: root block carries a sorted list of
 *   `entryGroups` (each: `{ groupKey, entriesCid }`) and the bundles[]
 *   list inline. Each `entriesCid` links to a per-group dag-cbor
 *   sub-block holding that group's encrypted KV entries. Grouping key:
 *   the addressId prefix (`DIRECT_[0-9a-f]{6}_[0-9a-f]{6}`) for
 *   per-address keys; `__global__` for wallet-global keys. Two
 *   snapshots whose entries for a given group are byte-identical share
 *   the same `entriesCid` and dedup at the IPFS storage layer; a
 *   partial-recovery client can fetch only the groups it needs (Phase 4
 *   of issue #200).
 *
 * **v2 (legacy)** — single-block: root block carries `entries[]`
 *   inline. The parser still accepts v2 for backward compatibility
 *   with any in-flight snapshots from before the v3 cutover, but the
 *   builder no longer emits v2.
 *
 * **v1** — the fat back-up format handled by
 *   `profile-export.ts:parseProfileSnapshot`. The lean parser rejects
 *   v1 with an explicit error.
 */
export const LEAN_PROFILE_SNAPSHOT_VERSION = 3 as const;

/** Earliest snapshot version the lean parser will accept. */
const LEAN_PROFILE_SNAPSHOT_MIN_READ_VERSION = 2 as const;

/**
 * Group key assigned to KV entries that do not match the addressId
 * pattern. These are wallet-global keys (mnemonic, master_key,
 * tracked-addresses index, bundle index entries, consolidation
 * pending, etc.) that always belong to the same logical group.
 *
 * Chosen with a `__` prefix so it cannot collide with a real addressId
 * (which is always lowercase-hex with a `DIRECT_` prefix).
 */
export const LEAN_PROFILE_SNAPSHOT_GLOBAL_GROUP_KEY = '__global__' as const;

/**
 * Regex matching an addressId prefix at the start of a KV key. Mirrors
 * the regex in `profile/profile-snapshot-dispatcher.ts` —
 * `^DIRECT_[0-9a-f]{6}_[0-9a-f]{6}\.` — so the v3 grouping is exactly
 * what the dispatcher will partition by on the read side. Requires a
 * trailing `.` so keys that happen to share the prefix bytes without
 * the dot separator (e.g. a literal `DIRECT_aabbcc_ddeeff_outbox` flat
 * key) are NOT swept into a per-address group; they go to the global
 * group instead, matching the dispatcher's filter-by-prefix contract.
 */
const ADDRESS_GROUP_PREFIX_RE = /^(DIRECT_[0-9a-f]{6}_[0-9a-f]{6})\./;

/**
 * Compute the v3 group key for a KV key. Per-address keys map to the
 * captured addressId; everything else maps to the global group.
 */
function groupKeyFor(key: string): string {
  const m = ADDRESS_GROUP_PREFIX_RE.exec(key);
  return m !== null ? m[1] : LEAN_PROFILE_SNAPSHOT_GLOBAL_GROUP_KEY;
}

/**
 * Hard cap on the assembled snapshot CAR. Lean snapshots are dominated
 * by the encrypted KV envelope stream — bundle CARs are NOT embedded.
 * 256 MiB is the same defensive ceiling v1 uses; in practice lean
 * snapshots will be a few hundred KiB to a few MiB.
 */
export const LEAN_DEFAULT_MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;

/** Soft cap on number of KV entries we'll embed (matches v1). */
const MAX_KV_ENTRIES = 100_000;

/** Soft cap on individual KV value byte length (matches v1). */
const MAX_KV_VALUE_BYTES = 8 * 1024 * 1024; // 8 MiB

/**
 * Hard cap on total CAR-import block count. A lean snapshot has
 * exactly ONE block (the dag-cbor root); the cap matches v1 for
 * defense-in-depth against malformed inputs that claim many blocks.
 */
const PROFILE_CAR_IMPORT_MAX_BLOCK_COUNT = 200_000;

/**
 * Hard cap on per-block bytes in CAR import. Same 1 MiB ceiling v1
 * uses — but note: for a lean snapshot the root block holds the entire
 * (encoded) entries[] inline, so a very tall wallet with many KV
 * entries can hit this cap. If real-world snapshots exceed 1 MiB at
 * the root, Phase A's followup is to split the root into a manifest +
 * per-writer subtrees. For Phase A we keep the parity with v1 and let
 * the cap surface in soak.
 */
const PROFILE_CAR_IMPORT_MAX_BLOCK_BYTES = 1024 * 1024; // 1 MiB

/** dag-cbor codec id (multicodec). */
const DAG_CBOR_CODE = 0x71;

/**
 * Operational / leaky keys filtered out of the LEAN snapshot.
 *
 * Note: this is intentionally narrower than v1's filter. v1 strips
 * `tokens.bundle.*` and `consolidation.pending` because the fat
 * snapshot reconstructs them from the bundle index on import. Under
 * Item #15 the lean snapshot IS the propagation channel for those
 * writers, so they MUST round-trip. The only category we still strip
 * is per-device transport sync cursors — those are local clocks that
 * would corrupt the receiver's view if propagated.
 */
const LEAN_SNAPSHOT_FILTER_KEY_PATTERNS: ReadonlyArray<RegExp> = [
  /^last_wallet_event_ts_/,
  /^last_dm_event_ts_/,
];

/**
 * One KV entry in a snapshot. `value` is a base64-encoded ciphertext
 * blob — the exact OrbitDB envelope payload. Only a wallet sharing the
 * source's master key (i.e. mnemonic) can decrypt it.
 *
 * Structurally identical to v1's `ProfileSnapshotKvEntry`; redeclared
 * here so the lean snapshot module can stand alone (no cross-imports
 * from the v1 file's surface).
 */
export interface LeanProfileSnapshotKvEntry {
  readonly key: string;
  readonly value: string;
}

/**
 * A single bundle reference in the lean snapshot — CID + minimal
 * metadata, NO embedded CAR bytes. The receiving peer fetches the CAR
 * from IPFS (via its own gateways) on demand if it is not already
 * pinned locally.
 */
export interface LeanProfileSnapshotBundleEntry {
  readonly cid: string;
  readonly status: 'active' | 'superseded';
  readonly createdAt: number;
  readonly tokenCount?: number;
}

/**
 * One v3 entry-group reference in the snapshot root. Points at a
 * per-group sub-block holding the encrypted KV entries that belong to
 * this group (a single addressId, or `__global__` for wallet-global
 * keys).
 *
 * The sub-block CID provides both per-group addressability (a
 * partial-recovery client can fetch only the groups it needs) and
 * dedup (two snapshots whose entries for the same group are
 * byte-identical share the same CID at the IPFS storage layer).
 *
 * `entryCount` is included as informational metadata so a recipient
 * can pre-allocate / log without round-tripping to the sub-block.
 */
export interface LeanProfileSnapshotEntryGroupRef {
  /** Group key — addressId (DIRECT_aabbcc_ddeeff) or `__global__`. */
  readonly groupKey: string;
  /** dag-cbor CID of the per-group entries sub-block. */
  readonly entriesCid: string;
  /** Number of KV entries inside the sub-block. */
  readonly entryCount: number;
}

/**
 * Decoded lean snapshot root document.
 *
 * In v3 the `entries` field is **logical**: the parser materialises it
 * by walking each `entryGroups[*].entriesCid` link and concatenating
 * the per-group entry slices in sorted key order. Callers that need
 * partial fetch should consume {@link LeanProfileSnapshotPartial}
 * instead.
 *
 * In v2 the `entries` field is direct: the root block carries the
 * entries inline and `entryGroups` is an empty array.
 */
export interface LeanProfileSnapshot {
  /** Lean snapshot schema version (2 or 3). */
  readonly version: 2 | 3;
  /** Wallet's chain pubkey at snapshot time (informational). */
  readonly chainPubkey: string;
  /** Network identifier at snapshot time (testnet/mainnet/dev). */
  readonly network: string;
  /** Snapshot timestamp (ms since epoch). */
  readonly createdAt: number;
  /**
   * All Profile KV entries that should propagate (encrypted form),
   * fully materialised across all entry groups for v3 snapshots and
   * carried inline for v2 snapshots. Always sorted by `key`.
   */
  readonly entries: ReadonlyArray<LeanProfileSnapshotKvEntry>;
  /**
   * v3 entry-group references (sorted by groupKey). Empty for v2
   * snapshots. Each ref's sub-block is fetched and decoded by the v3
   * parsers; partial-recovery callers can use the partial parser
   * variants to fetch only the groups they need.
   */
  readonly entryGroups: ReadonlyArray<LeanProfileSnapshotEntryGroupRef>;
  /** Bundle refs (CID + metadata) — bundle CAR bytes pinned separately. */
  readonly bundles: ReadonlyArray<LeanProfileSnapshotBundleEntry>;
}

/**
 * Partial snapshot result. The root metadata (`version`, `chainPubkey`,
 * `network`, `createdAt`, `bundles`, `entryGroups`) is always
 * available; `entries` carries ONLY the slices for groups the caller
 * asked to fetch (or all groups, when no filter is supplied).
 *
 * `unfetchedGroupKeys` records the group keys that were skipped because
 * of the address filter — `bundles[]` is always fully present (those
 * are inline CIDs in the root block) so this is purely an entries-side
 * concern.
 */
export interface LeanProfileSnapshotPartial {
  readonly version: 2 | 3;
  readonly chainPubkey: string;
  readonly network: string;
  readonly createdAt: number;
  readonly entries: ReadonlyArray<LeanProfileSnapshotKvEntry>;
  readonly entryGroups: ReadonlyArray<LeanProfileSnapshotEntryGroupRef>;
  readonly bundles: ReadonlyArray<LeanProfileSnapshotBundleEntry>;
  /** Group keys present in `entryGroups` but not fetched by this call. */
  readonly unfetchedGroupKeys: ReadonlyArray<string>;
}

/**
 * Caller-supplied fetcher for the v3 per-group entries sub-blocks.
 * Returns the dag-cbor encoded bytes of the block addressed by `cid`.
 * Implementations MUST sha256-verify the returned bytes against the
 * CID (Production wiring uses `fetchFromIpfs` which does this; tests
 * substitute an in-memory map).
 */
export type LeanProfileSnapshotBlockFetcher = (cid: string) => Promise<Uint8Array>;

/** Options for buildLeanProfileSnapshot. */
export interface BuildLeanProfileSnapshotOptions {
  /** Storage provider whose KV entries we read. Already connected. */
  readonly storage: StorageProvider;
  /** Token storage whose bundle index we enumerate. */
  readonly tokenStorage: ProfileTokenStorageProvider;
  /** Identity context: the wallet's chainPubkey (informational). */
  readonly chainPubkey: string;
  /** Network identifier (informational). */
  readonly network: string;
  /** Hard cap on total CAR size. Defaults to LEAN_DEFAULT_MAX_SNAPSHOT_BYTES. */
  readonly maxSizeBytes?: number;
  /** Optional override for createdAt — enables byte-deterministic round-tripping for tests. */
  readonly createdAt?: number;
  /**
   * Item #15 Phase F — optional pre-read GC hook. When provided, the
   * builder invokes this callback BEFORE reading any KV entries so that
   * per-writer `gcExpiredTombstones()` sweeps can `db.del()` expired
   * tombstone slots, and the subsequent storage scan naturally excludes
   * those keys from the published snapshot.
   *
   * The factory wires this to a closure that iterates active address
   * IDs and calls `gcExpiredTombstones({ retentionMs })` on every
   * `OutboxWriter` / `SentLedgerWriter` bound to those addresses.
   *
   * Best-effort: errors are swallowed by the callback implementation; a
   * failed GC sweep leaves the tombstones in place for the next cycle
   * but does NOT block snapshot publication. The builder treats this
   * callback as opaque — it does not inspect the result or propagate
   * thrown errors.
   *
   * The split between "GC closure runs here vs in the orchestration
   * layer" is intentional: lean-snapshot is ciphertext-only and cannot
   * decrypt tombstone envelopes itself, so the per-writer GC must run
   * elsewhere. The hook position (before `storage.keys()`) ensures the
   * scan observes the post-GC state.
   *
   * Phase F doc:
   * @see docs/uxf/OUTBOX-SEND-FOLLOWUPS.md
   */
  readonly gcExpiredTombstones?: () => Promise<void>;
}

/** Diagnostic counters surfaced to callers. */
export interface BuildLeanProfileSnapshotResult {
  /** The CAR bytes (also returned for the publisher to pin/upload). */
  readonly carBytes: Uint8Array;
  /** Number of KV entries serialized. */
  readonly entryCount: number;
  /** Number of bundle refs serialized (excludes 'unverified'). */
  readonly bundleCount: number;
  /** CAR root CID as a base32 string — this is what gets published. */
  readonly rootCid: string;
}

// =============================================================================
// Internal helpers (small + pure; intentionally duplicated from v1 to keep
// the lean module independent — extract to shared helper if a third
// snapshot variant appears)
// =============================================================================

function sha256(bytes: Uint8Array): Uint8Array {
  return nobleSha256(bytes);
}

/** Build a CIDv1 with codec=dag-cbor for the given dag-cbor bytes. */
function dagCborCid(bytes: Uint8Array): CID {
  const digest = createMultihash(0x12, sha256(bytes));
  return CID.createV1(DAG_CBOR_CODE, digest);
}

/** Concatenate a list of Uint8Arrays into a single fresh Uint8Array. */
function concatBytes(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Should this key be included in the lean snapshot? Per-device
 * transport cursors are the only category we strip; see
 * `LEAN_SNAPSHOT_FILTER_KEY_PATTERNS` for the rationale.
 */
function shouldExportKey(key: string): boolean {
  for (const re of LEAN_SNAPSHOT_FILTER_KEY_PATTERNS) {
    if (re.test(key)) return false;
  }
  return true;
}

/**
 * Read every KV entry from the running Profile via the storage's
 * `getEncryptedRaw` back-channel — plaintext is NEVER read at this
 * layer. Identical to v1's `readAllKvEntries` modulo the filter.
 */
async function readAllKvEntries(
  storage: StorageProvider,
): Promise<LeanProfileSnapshotKvEntry[]> {
  const handle = storage as unknown as {
    getEncryptedRaw?: (key: string) => Promise<string | null>;
  };
  if (typeof handle.getEncryptedRaw !== 'function') {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      'profile-lean-snapshot requires a ProfileStorageProvider — getEncryptedRaw() is missing on the supplied StorageProvider. ' +
        'Legacy file/IndexedDB-only wallets cannot be lean-snapshotted.',
    );
  }

  const allKeys = await storage.keys();
  if (allKeys.length > MAX_KV_ENTRIES) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Refusing to build lean snapshot: profile has ${allKeys.length} KV entries (cap ${MAX_KV_ENTRIES}).`,
    );
  }

  const out: LeanProfileSnapshotKvEntry[] = [];
  for (const key of allKeys) {
    if (!shouldExportKey(key)) continue;
    let value: string | null;
    try {
      value = await handle.getEncryptedRaw(key);
    } catch (err) {
      logger.warn(
        'ProfileLeanSnapshot',
        `failed to read encrypted KV entry "${key}": ${err instanceof Error ? err.message : String(err)} — skipping`,
      );
      continue;
    }
    if (value === null) continue;

    if (Buffer.byteLength(value, 'utf8') > MAX_KV_VALUE_BYTES) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `KV entry "${key}" value exceeds ${MAX_KV_VALUE_BYTES} bytes — refuse build to avoid huge snapshots.`,
      );
    }
    out.push({ key, value });
  }
  // Deterministic ordering — rebuild produces byte-identical bytes.
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

/**
 * Enumerate the Profile's bundle index. Returns bundle entries by CID
 * only — the lean snapshot does not embed CAR bytes. 'unverified'
 * bundles are skipped: by definition their CAR is not authenticated
 * locally, so propagating them via the authoritative pointer would
 * forward potentially-poisoned CIDs to peers.
 */
async function readBundleRefs(
  tokenStorage: ProfileTokenStorageProvider,
): Promise<LeanProfileSnapshotBundleEntry[]> {
  const handle = tokenStorage as unknown as {
    listBundles(): Promise<Map<string, UxfBundleRef>>;
  };

  let bundleMap: Map<string, UxfBundleRef>;
  try {
    bundleMap = await handle.listBundles();
  } catch (err) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Failed to enumerate Profile bundles for lean snapshot: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const entries: LeanProfileSnapshotBundleEntry[] = [];
  for (const [cid, ref] of bundleMap) {
    if (ref.status === 'unverified') {
      logger.debug(
        'ProfileLeanSnapshot',
        `skipping unverified bundle ${cid} (not propagated via lean snapshot)`,
      );
      continue;
    }
    entries.push({
      cid,
      status: ref.status,
      createdAt: ref.createdAt,
      ...(ref.tokenCount !== undefined ? { tokenCount: ref.tokenCount } : {}),
    });
  }
  // Deterministic ordering by CID.
  entries.sort((a, b) => (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0));
  return entries;
}

/**
 * Build the v3 entry-group sub-blocks. Returns one block per non-empty
 * group, plus a list of group-refs (sorted by groupKey) for embedding
 * in the root. The group-ref list is deterministic — two builds of
 * the same Profile state yield identical group CIDs and identical root
 * bytes.
 */
function buildEntryGroupBlocks(
  entries: ReadonlyArray<LeanProfileSnapshotKvEntry>,
): {
  groupRefs: LeanProfileSnapshotEntryGroupRef[];
  groupBlocks: Array<{ cid: CID; bytes: Uint8Array }>;
} {
  // Partition by group key. Entries are already sorted by key at the
  // call site (readAllKvEntries sorts before returning); per-group
  // order therefore matches insertion order and stays sorted by key.
  const groups = new Map<string, LeanProfileSnapshotKvEntry[]>();
  for (const entry of entries) {
    const groupKey = groupKeyFor(entry.key);
    let bucket = groups.get(groupKey);
    if (bucket === undefined) {
      bucket = [];
      groups.set(groupKey, bucket);
    }
    bucket.push({ key: entry.key, value: entry.value });
  }

  const groupBlocks: Array<{ cid: CID; bytes: Uint8Array }> = [];
  const groupRefs: LeanProfileSnapshotEntryGroupRef[] = [];

  // Sort group keys for deterministic root layout.
  const sortedGroupKeys = Array.from(groups.keys()).sort();
  for (const groupKey of sortedGroupKeys) {
    const groupEntries = groups.get(groupKey)!;
    const groupBytes = dagCborEncode({
      groupKey,
      entries: groupEntries.map((e) => ({ key: e.key, value: e.value })),
    });
    if (groupBytes.byteLength > PROFILE_CAR_IMPORT_MAX_BLOCK_BYTES) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `Lean snapshot entry-group "${groupKey}" sub-block is ${groupBytes.byteLength} bytes ` +
          `— exceeds per-block cap ${PROFILE_CAR_IMPORT_MAX_BLOCK_BYTES}. ` +
          `Reduce the number/size of KV entries for this group.`,
      );
    }
    const groupCid = dagCborCid(groupBytes);
    groupBlocks.push({ cid: groupCid, bytes: groupBytes });
    groupRefs.push({
      groupKey,
      entriesCid: groupCid.toString(),
      entryCount: groupEntries.length,
    });
  }

  return { groupRefs, groupBlocks };
}

/**
 * Build the v3 snapshot CAR bytes. Emits ONE dag-cbor block per
 * non-empty entry group plus ONE root block carrying the
 * group-CID-list + bundles[] + envelope metadata. The CAR's root[0]
 * points at the root block; consumers walk the CID links to load
 * per-group entries (or use the partial parser to fetch only a
 * subset).
 */
async function assembleCarBytes(
  snapshot: LeanProfileSnapshot,
  maxSizeBytes: number,
): Promise<{ carBytes: Uint8Array; rootCid: string }> {
  // Phase 4 (issue #200) — v3 hierarchical layout. Build per-group
  // sub-blocks first so the root block can embed their CIDs (using
  // dag-cbor's built-in CID-link tagging via the CID instance type).
  const { groupRefs, groupBlocks } = buildEntryGroupBlocks(snapshot.entries);

  const rootBytes = dagCborEncode({
    version: LEAN_PROFILE_SNAPSHOT_VERSION,
    chainPubkey: snapshot.chainPubkey,
    network: snapshot.network,
    createdAt: snapshot.createdAt,
    entryGroups: groupRefs.map((g, idx) => ({
      groupKey: g.groupKey,
      // Embed the CID instance directly — dag-cbor encodes CID
      // instances as link tags (Tag 42), which is what
      // `fetchCarFromIpfs`'s `collectCidLinks` walker expects.
      entriesCid: groupBlocks[idx].cid,
      entryCount: g.entryCount,
    })),
    bundles: snapshot.bundles.map((b) => {
      const obj: Record<string, unknown> = {
        cid: b.cid,
        status: b.status,
        createdAt: b.createdAt,
      };
      if (b.tokenCount !== undefined) obj.tokenCount = b.tokenCount;
      return obj;
    }),
  });

  // Per-block byte cap fires on the root block itself.
  if (rootBytes.byteLength > PROFILE_CAR_IMPORT_MAX_BLOCK_BYTES) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Lean snapshot root block is ${rootBytes.byteLength} bytes — exceeds per-block cap ${PROFILE_CAR_IMPORT_MAX_BLOCK_BYTES}. ` +
        `Reduce the number/size of KV entries or split into per-writer subtrees.`,
    );
  }

  const rootCid = dagCborCid(rootBytes);

  // Pre-flight size estimate — CAR framing overhead per block is
  // bounded by ~64 bytes (header + length-prefix + CID); include a
  // generous 128-byte cushion per block plus header.
  let estimatedTotal = rootBytes.byteLength + 128;
  for (const block of groupBlocks) estimatedTotal += block.bytes.byteLength + 64;
  if (estimatedTotal > maxSizeBytes) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Refusing to assemble lean snapshot CAR: estimated ${estimatedTotal} bytes exceeds maxSizeBytes=${maxSizeBytes}.`,
    );
  }

  const { writer, out } = CarWriter.create([rootCid]);
  const chunks: Uint8Array[] = [];
  const collectPromise = (async () => {
    for await (const chunk of out) chunks.push(chunk);
  })();

  // Root block first so a CAR consumer that streams sees the envelope
  // before any sub-block (mirrors `exportToCar`'s ordering invariant
  // in uxf/ipld.ts).
  await writer.put({ cid: rootCid, bytes: rootBytes });
  for (const block of groupBlocks) {
    await writer.put({ cid: block.cid, bytes: block.bytes });
  }
  await writer.close();
  await collectPromise;

  const carBytes = concatBytes(chunks);

  if (carBytes.byteLength > maxSizeBytes) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Lean snapshot CAR is ${carBytes.byteLength} bytes — exceeds maxSizeBytes=${maxSizeBytes}.`,
    );
  }

  return { carBytes, rootCid: rootCid.toString() };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Build a lean profile snapshot CAR containing all encrypted KV
 * entries + bundle refs (CID-only). Side-effect-free read of the
 * running Profile.
 *
 * @throws ProfileError on cap violations or unrecoverable storage errors.
 */
export async function buildLeanProfileSnapshot(
  options: BuildLeanProfileSnapshotOptions,
): Promise<BuildLeanProfileSnapshotResult> {
  const maxSizeBytes = options.maxSizeBytes ?? LEAN_DEFAULT_MAX_SNAPSHOT_BYTES;

  // Item #15 Phase F — run the GC hook (if wired) before the storage
  // scan so any tombstones purged by per-writer
  // `gcExpiredTombstones()` sweeps are already absent from the
  // subsequent `storage.keys()` enumeration. Failures inside the hook
  // are swallowed at the hook implementation level; a thrown error
  // here is logged and ignored so a failing GC pass cannot block
  // snapshot publication.
  if (options.gcExpiredTombstones) {
    try {
      await options.gcExpiredTombstones();
    } catch (err) {
      logger.warn(
        'ProfileLeanSnapshot',
        `tombstone GC hook threw: ${err instanceof Error ? err.message : String(err)} — proceeding with snapshot build (expired tombstones may propagate this round)`,
      );
    }
  }

  const entries = await readAllKvEntries(options.storage);
  const bundles = await readBundleRefs(options.tokenStorage);

  // `entryGroups` is constructed inside `assembleCarBytes` from
  // `entries`, so the build-time view holds an empty list. The parser
  // populates it on the read side from the actual root block.
  const snapshot: LeanProfileSnapshot = {
    version: LEAN_PROFILE_SNAPSHOT_VERSION,
    chainPubkey: options.chainPubkey,
    network: options.network,
    createdAt: options.createdAt ?? Date.now(),
    entries,
    entryGroups: [],
    bundles,
  };

  const { carBytes, rootCid } = await assembleCarBytes(snapshot, maxSizeBytes);

  return {
    carBytes,
    entryCount: entries.length,
    bundleCount: bundles.length,
    rootCid,
  };
}

/**
 * Parse a lean snapshot CAR back into its root document.
 *
 * **v2 (legacy)** snapshots are single-block: the root block carries
 *   `entries[]` inline; the parser returns the populated snapshot
 *   directly.
 *
 * **v3 (current)** snapshots are hierarchical: the root block carries
 *   `entryGroups[*]` CID-links. The parser walks every group sub-block
 *   contained in the CAR and materialises the flat `entries[]` view
 *   (sorted by key) for the returned snapshot. Use
 *   {@link parseLeanProfileSnapshotPartial} if you only need a subset
 *   of address groups.
 *
 * Caps enforced: single CAR root; per-block byte cap on every block;
 * block-count cap; root CID re-verified via content-address (defeats
 * forged-CID attacks).
 *
 * Lean snapshots have NO embedded bundle CARs — the caller fetches
 * bundle CAR bytes from IPFS separately if needed.
 *
 * @throws ProfileError on any disagreement with the schema or caps.
 */
export async function parseLeanProfileSnapshot(
  carBytes: Uint8Array,
): Promise<LeanProfileSnapshot> {
  const { rootBytes, blockMap } = await loadCarBlocks(carBytes);

  let decoded: unknown;
  try {
    decoded = dagCborDecode(rootBytes);
  } catch (err) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Failed to decode lean snapshot root block as dag-cbor: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const validated = validateLeanSnapshotShape(decoded);

  if (validated.version === 2) {
    // v2 has all entries inline — no sub-blocks to walk.
    return validated;
  }

  // v3: hydrate per-group entries from sub-blocks present in the CAR.
  // We use an in-CAR-blocks fetcher so the offline parse path stays
  // self-contained; the IPFS-walking variant is the
  // `parseLeanProfileSnapshotFromRootBlock` family.
  const fetcher: LeanProfileSnapshotBlockFetcher = async (cid) => {
    const bytes = blockMap.get(cid);
    if (bytes === undefined) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `Lean snapshot CAR is missing entry-group sub-block ${cid} — incomplete CAR.`,
      );
    }
    return bytes;
  };

  const entries = await fetchAndDecodeAllGroupEntries(
    validated.entryGroups,
    fetcher,
  );
  return {
    version: validated.version,
    chainPubkey: validated.chainPubkey,
    network: validated.network,
    createdAt: validated.createdAt,
    entries,
    entryGroups: validated.entryGroups,
    bundles: validated.bundles,
  };
}

/**
 * Internal helper: parse a CAR envelope, enforce caps, and return the
 * root block bytes plus a map of every block found in the CAR (so the
 * caller can resolve per-group sub-block CIDs without re-reading the
 * envelope).
 */
async function loadCarBlocks(
  carBytes: Uint8Array,
): Promise<{ rootBytes: Uint8Array; blockMap: Map<string, Uint8Array> }> {
  let reader: CarReader;
  try {
    reader = await CarReader.fromBytes(carBytes);
  } catch (err) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Failed to parse lean snapshot CAR: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const roots = await reader.getRoots();
  if (roots.length !== 1) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Expected exactly one CAR root in lean snapshot; got ${roots.length}.`,
    );
  }
  const rootCid = roots[0];

  let rootBytes: Uint8Array | undefined;
  const blockMap = new Map<string, Uint8Array>();
  let blockCount = 0;
  for await (const block of reader.blocks()) {
    blockCount += 1;
    if (blockCount > PROFILE_CAR_IMPORT_MAX_BLOCK_COUNT) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `Lean snapshot CAR exceeds block-count cap ${PROFILE_CAR_IMPORT_MAX_BLOCK_COUNT}.`,
      );
    }
    if (block.bytes.byteLength > PROFILE_CAR_IMPORT_MAX_BLOCK_BYTES) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `Lean snapshot CAR has a block of ${block.bytes.byteLength} bytes — exceeds per-block cap ${PROFILE_CAR_IMPORT_MAX_BLOCK_BYTES}.`,
      );
    }
    blockMap.set(block.cid.toString(), block.bytes);
    if (block.cid.toString() === rootCid.toString()) {
      rootBytes = block.bytes;
    }
  }

  if (!rootBytes) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      'Lean snapshot root block missing from CAR.',
    );
  }

  // Re-verify content address — defeats forged-CID attacks. CarReader
  // already does this for the standard CID-block binding, but we
  // recompute explicitly so that a CAR with a forged header root[0]
  // that points to a different block's payload is rejected.
  const expectedRootCid = dagCborCid(rootBytes);
  if (expectedRootCid.toString() !== rootCid.toString()) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Lean snapshot root CID mismatch: header claims ${rootCid.toString()}, content-addressed CID is ${expectedRootCid.toString()}.`,
    );
  }

  return { rootBytes, blockMap };
}

/**
 * Parse a lean snapshot from the dag-cbor encoded root block bytes
 * alone (no CAR envelope). Used by the recovery path when the snapshot
 * was pinned via per-block `dag/put`: each contained block is stored
 * individually under its dag-cbor CID, so `fetchFromIpfs(rootCid)`
 * returns the root block bytes directly — NOT a CAR. Content-address
 * verification is done by the fetcher
 * (`verifyCidMatchesBytes` against the published CID), so this parser
 * only needs to dag-cbor-decode and validate the resulting shape.
 *
 * **v2** snapshots are returned with `entries[]` materialised inline
 *   from the root block.
 * **v3** snapshots require fetching the per-group sub-blocks via the
 *   supplied `fetcher` callback. The callback signature mirrors
 *   {@link fetchFromIpfs} for production wiring and an in-memory map
 *   for tests. If the snapshot is v3 and no fetcher is supplied, the
 *   returned snapshot carries the root's `entryGroups` metadata but
 *   `entries` is empty — useful when the caller plans to fetch groups
 *   lazily via {@link parseLeanProfileSnapshotPartial}.
 *
 * Symmetric with {@link parseLeanProfileSnapshot} (which serves the
 * in-process / integration test path where CAR bytes are handed off
 * directly).
 *
 * @throws ProfileError on dag-cbor decode failure, shape mismatch, or
 *         (when a fetcher is supplied) sub-block fetch / decode
 *         failure.
 */
export async function parseLeanProfileSnapshotFromRootBlock(
  rootBlockBytes: Uint8Array,
  fetcher?: LeanProfileSnapshotBlockFetcher,
): Promise<LeanProfileSnapshot> {
  if (rootBlockBytes.byteLength > PROFILE_CAR_IMPORT_MAX_BLOCK_BYTES) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Lean snapshot root block is ${rootBlockBytes.byteLength} bytes — exceeds per-block cap ${PROFILE_CAR_IMPORT_MAX_BLOCK_BYTES}.`,
    );
  }
  let decoded: unknown;
  try {
    decoded = dagCborDecode(rootBlockBytes);
  } catch (err) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Failed to decode lean snapshot root block as dag-cbor: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const validated = validateLeanSnapshotShape(decoded);

  if (validated.version === 2) {
    // v2 — entries already inline.
    return validated;
  }

  if (validated.entryGroups.length === 0) {
    // v3 with no groups (empty wallet): nothing to fetch.
    return validated;
  }

  if (fetcher === undefined) {
    // v3 without a fetcher — return the root metadata; entries left
    // empty so the caller can decide whether to load lazily.
    return {
      version: validated.version,
      chainPubkey: validated.chainPubkey,
      network: validated.network,
      createdAt: validated.createdAt,
      entries: [],
      entryGroups: validated.entryGroups,
      bundles: validated.bundles,
    };
  }

  const entries = await fetchAndDecodeAllGroupEntries(
    validated.entryGroups,
    fetcher,
  );
  return {
    version: validated.version,
    chainPubkey: validated.chainPubkey,
    network: validated.network,
    createdAt: validated.createdAt,
    entries,
    entryGroups: validated.entryGroups,
    bundles: validated.bundles,
  };
}

/**
 * Partial-fetch parser for v3 snapshots. Reads the root block,
 * validates the envelope, then fetches ONLY the per-group sub-blocks
 * for `addressIds` (plus the global group if `includeGlobal` is true,
 * default) via `fetcher`.
 *
 * Returns the populated entry slice plus `unfetchedGroupKeys` — the
 * list of group keys present in `entryGroups` but skipped by the
 * filter. Callers handling cross-device recovery for a known subset
 * of HD addresses can fetch only the slices they need, leaving the
 * rest as IPFS-resident state.
 *
 * On v2 snapshots `addressIds` is ignored (the root carries all
 * entries inline) and `unfetchedGroupKeys` is empty.
 *
 * @throws ProfileError on dag-cbor decode failure, shape mismatch, or
 *         sub-block fetch / decode failure.
 */
export async function parseLeanProfileSnapshotPartial(
  rootBlockBytes: Uint8Array,
  fetcher: LeanProfileSnapshotBlockFetcher,
  options: {
    readonly addressIds?: ReadonlyArray<string>;
    readonly includeGlobal?: boolean;
  } = {},
): Promise<LeanProfileSnapshotPartial> {
  if (rootBlockBytes.byteLength > PROFILE_CAR_IMPORT_MAX_BLOCK_BYTES) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Lean snapshot root block is ${rootBlockBytes.byteLength} bytes — exceeds per-block cap ${PROFILE_CAR_IMPORT_MAX_BLOCK_BYTES}.`,
    );
  }
  let decoded: unknown;
  try {
    decoded = dagCborDecode(rootBlockBytes);
  } catch (err) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Failed to decode lean snapshot root block as dag-cbor: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  const validated = validateLeanSnapshotShape(decoded);

  if (validated.version === 2) {
    // v2 — caller asked for partial, but the legacy format has no
    // sub-blocks to skip; return all entries unfiltered.
    return {
      version: validated.version,
      chainPubkey: validated.chainPubkey,
      network: validated.network,
      createdAt: validated.createdAt,
      entries: validated.entries,
      entryGroups: validated.entryGroups,
      bundles: validated.bundles,
      unfetchedGroupKeys: [],
    };
  }

  const includeGlobal = options.includeGlobal ?? true;
  const wantedAddressSet =
    options.addressIds !== undefined ? new Set(options.addressIds) : null;

  const wantedGroups: LeanProfileSnapshotEntryGroupRef[] = [];
  const unfetchedGroupKeys: string[] = [];
  for (const group of validated.entryGroups) {
    const isGlobal = group.groupKey === LEAN_PROFILE_SNAPSHOT_GLOBAL_GROUP_KEY;
    const include = isGlobal
      ? includeGlobal
      : wantedAddressSet === null
        ? true
        : wantedAddressSet.has(group.groupKey);
    if (include) {
      wantedGroups.push(group);
    } else {
      unfetchedGroupKeys.push(group.groupKey);
    }
  }

  const entries = await fetchAndDecodeAllGroupEntries(wantedGroups, fetcher);
  return {
    version: validated.version,
    chainPubkey: validated.chainPubkey,
    network: validated.network,
    createdAt: validated.createdAt,
    entries,
    entryGroups: validated.entryGroups,
    bundles: validated.bundles,
    unfetchedGroupKeys,
  };
}

/**
 * Fetch every per-group sub-block in `groups`, dag-cbor-decode it,
 * validate the shape against the group ref, and return the flat
 * entries list (sorted by key for determinism).
 *
 * Per-group validation: decoded block's `groupKey` must equal the
 * ref's `groupKey`; `entryCount` must equal the entries length; the
 * computed CID of the fetched bytes is NOT re-verified here because
 * production fetchers (`fetchFromIpfs`) already do CID-binding
 * verification. Test fetchers MUST do the same to stay sound.
 */
async function fetchAndDecodeAllGroupEntries(
  groups: ReadonlyArray<LeanProfileSnapshotEntryGroupRef>,
  fetcher: LeanProfileSnapshotBlockFetcher,
): Promise<LeanProfileSnapshotKvEntry[]> {
  if (groups.length === 0) return [];

  const groupResults: LeanProfileSnapshotKvEntry[][] = await Promise.all(
    groups.map(async (group) => {
      const blockBytes = await fetcher(group.entriesCid);
      if (blockBytes.byteLength > PROFILE_CAR_IMPORT_MAX_BLOCK_BYTES) {
        throw new ProfileError(
          'PROFILE_NOT_INITIALIZED',
          `Lean snapshot entry-group "${group.groupKey}" sub-block is ${blockBytes.byteLength} bytes ` +
            `— exceeds per-block cap ${PROFILE_CAR_IMPORT_MAX_BLOCK_BYTES}.`,
        );
      }
      let groupDecoded: unknown;
      try {
        groupDecoded = dagCborDecode(blockBytes);
      } catch (err) {
        throw new ProfileError(
          'PROFILE_NOT_INITIALIZED',
          `Failed to decode lean snapshot entry-group "${group.groupKey}" sub-block: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }
      return validateGroupBlockShape(group, groupDecoded);
    }),
  );

  const flat: LeanProfileSnapshotKvEntry[] = [];
  for (const slice of groupResults) {
    for (const entry of slice) flat.push(entry);
  }
  flat.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return flat;
}

/**
 * Validate a per-group sub-block payload. Lifts the entries[]
 * validation out of `validateLeanSnapshotShape` because the v3
 * per-group sub-block uses the same KV entry shape but a different
 * envelope.
 */
function validateGroupBlockShape(
  ref: LeanProfileSnapshotEntryGroupRef,
  decoded: unknown,
): LeanProfileSnapshotKvEntry[] {
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Lean snapshot entry-group "${ref.groupKey}" sub-block is not an object.`,
    );
  }
  const obj = decoded as Record<string, unknown>;
  if (typeof obj.groupKey !== 'string' || obj.groupKey !== ref.groupKey) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Lean snapshot entry-group "${ref.groupKey}" sub-block has wrong groupKey field ` +
        `(claims "${String(obj.groupKey)}").`,
    );
  }
  if (!Array.isArray(obj.entries)) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Lean snapshot entry-group "${ref.groupKey}" sub-block missing entries[] array.`,
    );
  }
  if (obj.entries.length !== ref.entryCount) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Lean snapshot entry-group "${ref.groupKey}" sub-block has ${obj.entries.length} entries, ` +
        `but root metadata claims ${ref.entryCount}.`,
    );
  }
  const out: LeanProfileSnapshotKvEntry[] = [];
  const seen = new Set<string>();
  for (const e of obj.entries) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `Lean snapshot entry-group "${ref.groupKey}" sub-block has invalid KV entry shape.`,
      );
    }
    const er = e as Record<string, unknown>;
    if (typeof er.key !== 'string' || typeof er.value !== 'string') {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `Lean snapshot entry-group "${ref.groupKey}" sub-block KV entry must have string \`key\` and \`value\`.`,
      );
    }
    if (seen.has(er.key)) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `Duplicate entry key in lean snapshot entry-group "${ref.groupKey}": "${er.key}".`,
      );
    }
    seen.add(er.key);
    if (Buffer.byteLength(er.value, 'utf8') > MAX_KV_VALUE_BYTES) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `Entry "${er.key}" value in entry-group "${ref.groupKey}" exceeds ${MAX_KV_VALUE_BYTES} bytes.`,
      );
    }
    out.push({ key: er.key, value: er.value });
  }
  return out;
}

/**
 * Validate the decoded snapshot's shape + version. Returns a
 * safely-typed `LeanProfileSnapshot` whose `entries[]` is materialised
 * for v2 (inline) or empty for v3 (caller fetches per-group sub-blocks
 * via {@link fetchAndDecodeAllGroupEntries}).
 *
 * Rejects:
 *   - missing / non-numeric / non-integer / negative version
 *   - version < 2 or > LEAN_PROFILE_SNAPSHOT_VERSION (v1 is the fat
 *     back-up format — parse with `profile-export.ts:parseProfileSnapshot`)
 *   - missing chainPubkey / network / createdAt
 *   - v2: non-array entries[]; missing bundles[]; duplicate keys;
 *     over-cap entry counts / value lengths
 *   - v3: non-array entryGroups[] or bundles[]; missing per-group
 *     `entriesCid`; invalid CID; duplicate group keys; entry-count
 *     metadata cap violations
 *   - invalid bundle shape (missing cid, unknown status, etc.)
 *   - duplicate bundle cids
 */
function validateLeanSnapshotShape(decoded: unknown): LeanProfileSnapshot {
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      'Lean snapshot root is not an object.',
    );
  }
  const obj = decoded as Record<string, unknown>;

  const version = obj.version;
  if (version === undefined || version === null) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      'Lean snapshot missing `version` field.',
    );
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Invalid lean snapshot version: ${String(version)}`,
    );
  }
  if (version > LEAN_PROFILE_SNAPSHOT_VERSION) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Lean snapshot version ${version} is newer than this SDK supports (${LEAN_PROFILE_SNAPSHOT_VERSION}). Update the SDK.`,
    );
  }
  if (version < LEAN_PROFILE_SNAPSHOT_MIN_READ_VERSION) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Lean snapshot version ${version} is not accepted by the lean reader (min ${LEAN_PROFILE_SNAPSHOT_MIN_READ_VERSION}). v1 payloads must be parsed by parseProfileSnapshot.`,
    );
  }
  const typedVersion = version as 2 | 3;

  const chainPubkey = obj.chainPubkey;
  if (typeof chainPubkey !== 'string' || chainPubkey.length === 0) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      'Lean snapshot missing or invalid `chainPubkey` field.',
    );
  }

  const network = obj.network;
  if (typeof network !== 'string' || network.length === 0) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      'Lean snapshot missing or invalid `network` field.',
    );
  }

  const createdAt = obj.createdAt;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      'Lean snapshot missing or invalid `createdAt` field.',
    );
  }

  let entries: LeanProfileSnapshotKvEntry[] = [];
  let entryGroups: LeanProfileSnapshotEntryGroupRef[] = [];

  if (typedVersion === 2) {
    entries = parseV2Entries(obj.entries);
  } else {
    entryGroups = parseV3EntryGroups(obj.entryGroups);
  }

  const bundles = parseBundleEntries(obj.bundles);

  const result: LeanProfileSnapshot = {
    version: typedVersion,
    chainPubkey,
    network,
    createdAt,
    entries,
    entryGroups,
    bundles,
  };
  return result;
}

/**
 * Parse + validate the v2 inline `entries[]` field. Lifted out of
 * `validateLeanSnapshotShape` so v3 / v2 branches are symmetric.
 */
function parseV2Entries(entriesRaw: unknown): LeanProfileSnapshotKvEntry[] {
  if (!Array.isArray(entriesRaw)) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      'Lean snapshot v2 `entries` must be an array.',
    );
  }
  if (entriesRaw.length > MAX_KV_ENTRIES) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Lean snapshot has ${entriesRaw.length} entries — exceeds cap ${MAX_KV_ENTRIES}.`,
    );
  }
  const entries: LeanProfileSnapshotKvEntry[] = [];
  const seenKeys = new Set<string>();
  for (const e of entriesRaw) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      throw new ProfileError('PROFILE_NOT_INITIALIZED', 'Invalid KV entry shape.');
    }
    const er = e as Record<string, unknown>;
    if (typeof er.key !== 'string' || typeof er.value !== 'string') {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        'KV entry must have string `key` and `value`.',
      );
    }
    if (seenKeys.has(er.key)) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `Duplicate entry key in lean snapshot: "${er.key}".`,
      );
    }
    seenKeys.add(er.key);
    if (Buffer.byteLength(er.value, 'utf8') > MAX_KV_VALUE_BYTES) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `KV entry "${er.key}" value exceeds ${MAX_KV_VALUE_BYTES} bytes.`,
      );
    }
    entries.push({ key: er.key, value: er.value });
  }
  return entries;
}

/**
 * Parse + validate the v3 `entryGroups[]` root field. Each ref's
 * `entriesCid` must be a parseable CID (no codec restriction enforced
 * here — production builds always emit dag-cbor, but a hostile root
 * could embed e.g. a raw-codec CID; the sub-block fetcher path will
 * surface the wrong-decode error if the link doesn't dag-cbor-decode).
 *
 * dag-cbor decodes CID links (Tag 42) into actual `multiformats/cid`
 * `CID` instances — accept those, and also accept plain strings for
 * resilience against any future serializer change. Mixed shapes
 * within the same root are rejected.
 */
function parseV3EntryGroups(groupsRaw: unknown): LeanProfileSnapshotEntryGroupRef[] {
  if (!Array.isArray(groupsRaw)) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      'Lean snapshot v3 `entryGroups` must be an array.',
    );
  }
  if (groupsRaw.length > MAX_KV_ENTRIES) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Lean snapshot v3 has ${groupsRaw.length} entry groups — exceeds cap ${MAX_KV_ENTRIES}.`,
    );
  }
  const groups: LeanProfileSnapshotEntryGroupRef[] = [];
  const seenGroupKeys = new Set<string>();
  let totalEntries = 0;
  for (const g of groupsRaw) {
    if (!g || typeof g !== 'object' || Array.isArray(g)) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        'Lean snapshot v3 entryGroup ref must be an object.',
      );
    }
    const gr = g as Record<string, unknown>;
    if (typeof gr.groupKey !== 'string' || gr.groupKey.length === 0) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        'Lean snapshot v3 entryGroup ref missing or invalid `groupKey`.',
      );
    }
    if (seenGroupKeys.has(gr.groupKey)) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `Duplicate entryGroup key in lean snapshot v3: "${gr.groupKey}".`,
      );
    }
    seenGroupKeys.add(gr.groupKey);

    let entriesCidStr: string;
    const cidValue = gr.entriesCid;
    // dag-cbor decodes Tag 42 links as CID instances.
    const asCid = cidValue instanceof Object ? CID.asCID(cidValue as CID) : null;
    if (asCid !== null) {
      entriesCidStr = asCid.toString();
    } else if (typeof cidValue === 'string' && cidValue.length > 0) {
      try {
        CID.parse(cidValue);
      } catch {
        throw new ProfileError(
          'PROFILE_NOT_INITIALIZED',
          `Lean snapshot v3 entryGroup "${gr.groupKey}" has unparseable entriesCid: "${cidValue}"`,
        );
      }
      entriesCidStr = cidValue;
    } else {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `Lean snapshot v3 entryGroup "${gr.groupKey}" missing or invalid \`entriesCid\` ` +
          `(expected CID link or string, got ${typeof cidValue}).`,
      );
    }

    if (
      typeof gr.entryCount !== 'number' ||
      !Number.isInteger(gr.entryCount) ||
      gr.entryCount < 0
    ) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `Lean snapshot v3 entryGroup "${gr.groupKey}" has missing/invalid entryCount.`,
      );
    }
    totalEntries += gr.entryCount;
    if (totalEntries > MAX_KV_ENTRIES) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `Lean snapshot v3 declares ${totalEntries} total entries across groups — exceeds cap ${MAX_KV_ENTRIES}.`,
      );
    }

    groups.push({
      groupKey: gr.groupKey,
      entriesCid: entriesCidStr,
      entryCount: gr.entryCount,
    });
  }
  return groups;
}

/**
 * Parse + validate the `bundles[]` field — common to v2 and v3.
 */
function parseBundleEntries(bundlesRaw: unknown): LeanProfileSnapshotBundleEntry[] {
  if (!Array.isArray(bundlesRaw)) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      'Lean snapshot `bundles` must be an array.',
    );
  }
  const bundles: LeanProfileSnapshotBundleEntry[] = [];
  const seenBundleCids = new Set<string>();
  for (const b of bundlesRaw) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) {
      throw new ProfileError('PROFILE_NOT_INITIALIZED', 'Invalid bundle entry shape.');
    }
    const br = b as Record<string, unknown>;
    if (typeof br.cid !== 'string' || br.cid.length === 0) {
      throw new ProfileError('PROFILE_NOT_INITIALIZED', 'Bundle entry missing `cid`.');
    }
    // CID must parse — defends against malformed-CID propagation that
    // would later trip the bundle fetch path with an opaque error.
    try {
      CID.parse(br.cid);
    } catch {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `Bundle entry has unparseable cid: "${br.cid}"`,
      );
    }
    if (seenBundleCids.has(br.cid)) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `Duplicate bundle cid in lean snapshot: "${br.cid}".`,
      );
    }
    seenBundleCids.add(br.cid);
    if (br.status !== 'active' && br.status !== 'superseded') {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `Bundle entry has invalid status: ${String(br.status)} (lean snapshot accepts only 'active' | 'superseded')`,
      );
    }
    if (typeof br.createdAt !== 'number' || !Number.isFinite(br.createdAt)) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        'Bundle entry missing/invalid `createdAt`.',
      );
    }
    const entry: LeanProfileSnapshotBundleEntry = {
      cid: br.cid,
      status: br.status,
      createdAt: br.createdAt,
      ...(typeof br.tokenCount === 'number' ? { tokenCount: br.tokenCount } : {}),
    };
    bundles.push(entry);
  }
  return bundles;
}
