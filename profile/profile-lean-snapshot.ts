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
 * Lean snapshot schema version. Bumped past v1 (the fat back-up format)
 * so a v1 reader rejects this payload and vice versa.
 */
export const LEAN_PROFILE_SNAPSHOT_VERSION = 2 as const;

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
 * Decoded lean snapshot root document. The CAR carries this object as
 * its single root block — there are no additional embedded raw blocks.
 */
export interface LeanProfileSnapshot {
  /** Lean snapshot schema version. Always 2. */
  readonly version: 2;
  /** Wallet's chain pubkey at snapshot time (informational). */
  readonly chainPubkey: string;
  /** Network identifier at snapshot time (testnet/mainnet/dev). */
  readonly network: string;
  /** Snapshot timestamp (ms since epoch). */
  readonly createdAt: number;
  /** All Profile KV entries that should propagate (encrypted form). */
  readonly entries: ReadonlyArray<LeanProfileSnapshotKvEntry>;
  /** Bundle refs (CID + metadata) — bundle CAR bytes pinned separately. */
  readonly bundles: ReadonlyArray<LeanProfileSnapshotBundleEntry>;
}

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
 * Build the snapshot CAR bytes from a fully-populated lean snapshot
 * doc. Lean snapshots have exactly ONE block — the dag-cbor root.
 */
async function assembleCarBytes(
  snapshot: LeanProfileSnapshot,
  maxSizeBytes: number,
): Promise<{ carBytes: Uint8Array; rootCid: string }> {
  const rootBytes = dagCborEncode({
    version: snapshot.version,
    chainPubkey: snapshot.chainPubkey,
    network: snapshot.network,
    createdAt: snapshot.createdAt,
    entries: snapshot.entries.map((e) => ({ key: e.key, value: e.value })),
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

  // Pre-flight size estimate — CAR framing overhead is small but
  // include a 128-byte cushion for the header + single block frame.
  const estimatedTotal = rootBytes.byteLength + 128;
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

  await writer.put({ cid: rootCid, bytes: rootBytes });
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

  const entries = await readAllKvEntries(options.storage);
  const bundles = await readBundleRefs(options.tokenStorage);

  const snapshot: LeanProfileSnapshot = {
    version: LEAN_PROFILE_SNAPSHOT_VERSION,
    chainPubkey: options.chainPubkey,
    network: options.network,
    createdAt: options.createdAt ?? Date.now(),
    entries,
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
 * Parse a lean snapshot CAR back into its root document. Single-root
 * validation, version=2 check, size caps, and shape validation all run
 * here. Lean snapshots have NO embedded bundle CARs — the caller
 * fetches bundle CAR bytes from IPFS separately if needed.
 *
 * @throws ProfileError on any disagreement with the schema or caps.
 */
export async function parseLeanProfileSnapshot(
  carBytes: Uint8Array,
): Promise<LeanProfileSnapshot> {
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

  // Enforce block-count and per-block-byte caps as we walk blocks.
  // A well-formed lean snapshot has exactly ONE block; the caps catch
  // hostile shapes that try to slip in extra blocks.
  let rootBytes: Uint8Array | undefined;
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

  return validateLeanSnapshotShape(decoded);
}

/**
 * Validate the decoded snapshot's shape + version. Throws on any
 * disagreement; otherwise returns a safely-typed `LeanProfileSnapshot`.
 *
 * Rejects:
 *   - missing / non-numeric / non-integer / negative version
 *   - version != 2 (the lean reader does NOT accept v1 — that's the
 *     fat back-up format, parsed by `profile-export.ts`)
 *   - missing chainPubkey / network / createdAt
 *   - non-array entries[] or bundles[]
 *   - duplicate entry keys
 *   - over-cap entry counts / value lengths
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
  // The lean reader accepts exactly v2. v1 readers handle the fat
  // back-up format (`profile-export.ts`). v3+ is unknown to this SDK.
  if (version !== LEAN_PROFILE_SNAPSHOT_VERSION) {
    if (version > LEAN_PROFILE_SNAPSHOT_VERSION) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `Lean snapshot version ${version} is newer than this SDK supports (${LEAN_PROFILE_SNAPSHOT_VERSION}). Update the SDK.`,
      );
    }
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Lean snapshot version ${version} is not accepted by the lean reader (expected ${LEAN_PROFILE_SNAPSHOT_VERSION}). v1 payloads must be parsed by parseProfileSnapshot.`,
    );
  }

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

  const entriesRaw = obj.entries;
  if (!Array.isArray(entriesRaw)) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      'Lean snapshot `entries` must be an array.',
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

  const bundlesRaw = obj.bundles;
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

  const result: LeanProfileSnapshot = {
    version: LEAN_PROFILE_SNAPSHOT_VERSION,
    chainPubkey,
    network,
    createdAt,
    entries,
    bundles,
  };
  return result;
}
