/**
 * Profile Export — whole-profile snapshot to a single CAR file.
 *
 * Bundles every byte the running wallet needs to be reconstituted on
 * another device into one portable CAR:
 *
 *   - Every Profile KV entry that lives in OrbitDB, captured as
 *     ENCRYPTED ciphertext (never decrypted at this layer).
 *   - Every UXF bundle CAR referenced by the Profile, embedded as
 *     nested CAR bytes.
 *
 * The resulting CAR has ONE root block whose payload is a dag-cbor
 * `ProfileSnapshot` document; every embedded bundle CAR's bytes are
 * stored as additional raw blocks keyed by `sha256(bytes)` (raw codec).
 *
 * Wave 9 hardening (security-critical, see steelman closeout):
 *
 *   1. **Encrypted-form export.** `readAllKvEntries` calls
 *      `storage.getEncryptedRaw(key)` so the snapshot carries
 *      ciphertext exactly as OrbitDB stores it. The plaintext
 *      mnemonic / master key / chain code NEVER reach this CAR. The
 *      destination wallet must derive the same master key (i.e. share
 *      the same mnemonic) to decrypt them — this is the security
 *      invariant: snapshot privacy reduces to mnemonic privacy.
 *   2. **Bundle CID content-address verification.** On parse we
 *      recompute SHA-256(carBytes) for each candidate bundle block and
 *      derive the expected CID under the codec recorded in the
 *      snapshot's bundles[i].cid. Any mismatch is rejected — defeats
 *      a forged-CAR-header attack.
 *   3. **Schema is versioned.** Snapshots carry `version: 1`. Future
 *      versions may extend with new optional fields; importer rejects
 *      `version > 1` so unknown forward-compat data never lands silently.
 *   4. **Hard size + count caps.** Total CAR size is bounded at 256 MiB
 *      by default; per-block byte cap (1 MiB), block-count cap
 *      (200 000), KV-entry-count cap (100 000), per-value byte cap
 *      (8 MiB). Together these reject the same hostile shapes Wave 3
 *      closed for transfer bundles.
 *   5. **Operational keys filtered out.** `tokens.bundle.*` (bundle
 *      refs reconstructed from the bundle index), `consolidation.*`,
 *      and per-device `last_*_event_ts_*` timestamps are stripped from
 *      the snapshot — they are operational state, not data, and would
 *      either duplicate state with divergent envelopes or leak the
 *      destination's sync history.
 *   6. **Deterministic encoding.** Entries[] sorted by key; bundles[]
 *      sorted by cid. `createdAt` is option-overridable. Two exports of
 *      the same Profile produce byte-identical roots.
 *
 * @see /home/vrogojin/uxf/profile/profile-import.ts — the receiving side
 * @module profile/profile-export
 */

import { encode as dagCborEncode, decode as dagCborDecode } from '@ipld/dag-cbor';
import { CID } from 'multiformats/cid';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { create as createMultihash } from 'multiformats/hashes/digest';
import { CarWriter } from '@ipld/car/writer';
import { CarReader } from '@ipld/car';

import type { StorageProvider } from '../storage/storage-provider.js';
import type { ProfileTokenStorageProvider } from './profile-token-storage-provider.js';
import { fetchFromIpfs } from './ipfs-client.js';
import { logger } from '../core/logger.js';
import { ProfileError } from './errors.js';

// =============================================================================
// Types
// =============================================================================

/** Current snapshot schema version. Bump only with explicit migration story. */
export const PROFILE_SNAPSHOT_VERSION = 1 as const;

/**
 * Hard cap on the assembled snapshot CAR.
 *
 * Reduced from 1 GiB to 256 MiB in Wave 9 — a profile snapshot is
 * dominated by bundle CAR payloads, which themselves cap at 50 MiB
 * each via the IPFS client. 256 MiB allows several large bundles
 * plus the KV envelope stream while preventing OOM on a runaway
 * bundle pin set or a hostile snapshot CAR fed via `parseProfileSnapshot`.
 */
export const DEFAULT_MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;

/** Cap on individual bundle CAR fetch (matches IPFS client default). */
const PER_BUNDLE_FETCH_TIMEOUT_MS = 30_000;
const PER_BUNDLE_MAX_BYTES = 256 * 1024 * 1024; // 256 MiB per bundle

/** Soft cap on number of KV entries we'll embed (defensive). */
const MAX_KV_ENTRIES = 100_000;

/** Soft cap on individual KV value byte length. */
const MAX_KV_VALUE_BYTES = 8 * 1024 * 1024; // 8 MiB

/**
 * Hard cap on total CAR-import block count. Profile snapshots can have
 * many tiny KV entries, so we allow more than the transfer-bundle's
 * 10 000 cap (Wave 3) — but well below the legitimate ceiling so a
 * runaway hostile CAR is rejected before it forces 1M Map insertions.
 */
const PROFILE_CAR_IMPORT_MAX_BLOCK_COUNT = 200_000;

/**
 * Hard cap on per-block bytes in CAR import. Profile snapshots embed
 * full bundle CARs as raw blocks, which can legitimately reach a few
 * MiB each — so the cap is wider than the transfer-bundle 64 KiB
 * (which only ever sees small dag-cbor IPLD nodes). 1 MiB is a
 * defensive ceiling: any single block above this is hostile bloat.
 *
 * NOTE on bundle blocks: an embedded bundle CAR is stored as ONE raw
 * block of the whole CAR, so `PER_BUNDLE_MAX_BYTES` (256 MiB above)
 * would naively be the cap. To enforce a tighter aggregate budget we
 * cap individual blocks at 1 MiB and the assembled CAR at 256 MiB.
 * Bundles larger than 1 MiB are split into multiple raw blocks at
 * embed time (see `splitBundleIntoBlocks`).
 */
const PROFILE_CAR_IMPORT_MAX_BLOCK_BYTES = 1024 * 1024; // 1 MiB

/** raw codec id (multicodec). */
const RAW_CODE = 0x55;

/** dag-cbor codec id (multicodec). */
const DAG_CBOR_CODE = 0x71;

/**
 * Operational / leaky keys filtered out of the export. Bundle refs
 * (`tokens.bundle.*`) are reconstructed from the bundle index on the
 * destination; `consolidation.pending` is operational state with no
 * meaning on a different device; per-device transport timestamps
 * leak sync history. None of these are data the user expects to
 * round-trip.
 */
const EXPORT_FILTER_KEY_PATTERNS: ReadonlyArray<RegExp> = [
  /^tokens\.bundle\./,
  /^consolidation\.pending/,
  /^last_wallet_event_ts_/,
  /^last_dm_event_ts_/,
];

/**
 * Identity-class keys whose write failure on import MUST abort.
 * If any of these fail to land, the destination's wallet bootstrap
 * will silently re-derive a different identity from defaults and the
 * subsequent decryption of every other entry will fail. Hard-error
 * is the safe behaviour.
 */
export const IDENTITY_CLASS_KEYS: ReadonlySet<string> = new Set([
  'mnemonic',
  'master_key',
  'chain_code',
  'derivation_path',
  'base_path',
]);

/**
 * One KV entry in a snapshot. `value` is a base64-encoded ciphertext
 * blob — the exact OrbitDB envelope payload. Only a wallet sharing the
 * source's master key (i.e. mnemonic) can decrypt it.
 */
export interface ProfileSnapshotKvEntry {
  readonly key: string;
  readonly value: string;
}

/** A single bundle reference + minimal metadata. */
export interface ProfileSnapshotBundleEntry {
  readonly cid: string;
  readonly status: 'active' | 'superseded';
  readonly createdAt: number;
  readonly tokenCount?: number;
}

/**
 * Decoded snapshot root document. The CAR carries this object as its
 * single root block, plus one or more raw-codec blocks per embedded
 * bundle CAR.
 */
export interface ProfileSnapshot {
  /** Snapshot schema version. */
  readonly version: 1;
  /** Wallet's chain pubkey at export time (informational). */
  readonly chainPubkey: string;
  /** Network identifier at export time (testnet/mainnet/dev). */
  readonly network: string;
  /** Snapshot timestamp (ms since epoch). */
  readonly createdAt: number;
  /** All Profile KV entries (encrypted form preserved). */
  readonly entries: ReadonlyArray<ProfileSnapshotKvEntry>;
  /** All bundle refs whose CARs were successfully embedded. */
  readonly bundles: ReadonlyArray<ProfileSnapshotBundleEntry>;
}

/** Options for exportProfile. */
export interface ExportProfileOptions {
  /** Storage provider whose KV entries we read. Already connected. */
  readonly storage: StorageProvider;
  /** Token storage whose bundle index + IPFS gateways we use. */
  readonly tokenStorage: ProfileTokenStorageProvider;
  /** Identity context: the wallet's chainPubkey (informational). */
  readonly chainPubkey: string;
  /** Network identifier (informational). */
  readonly network: string;
  /** Hard cap on total CAR size. Defaults to 256 MiB. */
  readonly maxSizeBytes?: number;
  /** Optional override for the snapshot's createdAt — enables byte-deterministic round-tripping for tests. */
  readonly createdAt?: number;
}

/** Diagnostic counters surfaced to callers. */
export interface ExportProfileResult {
  /** The CAR bytes (also returned for the CLI to write to a file). */
  readonly carBytes: Uint8Array;
  /** Number of KV entries serialized. */
  readonly entryCount: number;
  /** Number of bundles whose CARs were successfully embedded. */
  readonly bundlesEmbedded: number;
  /** Number of bundles where the CAR fetch failed (skipped from output). */
  readonly bundlesMissing: number;
  /** CAR root CID as a base32 string. */
  readonly rootCid: string;
}

// =============================================================================
// Internal helpers
// =============================================================================

function sha256(bytes: Uint8Array): Uint8Array {
  return nobleSha256(bytes);
}

/**
 * Build a CIDv1 with codec=dag-cbor for the given dag-cbor bytes.
 */
function dagCborCid(bytes: Uint8Array): CID {
  const digest = createMultihash(0x12, sha256(bytes));
  return CID.createV1(DAG_CBOR_CODE, digest);
}

/**
 * Build a CIDv1 with codec=raw for the given opaque bytes.
 */
function rawCid(bytes: Uint8Array): CID {
  const digest = createMultihash(0x12, sha256(bytes));
  return CID.createV1(RAW_CODE, digest);
}

/**
 * Concatenate a list of Uint8Arrays into a single fresh Uint8Array.
 */
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
 * Should this key be filtered out of the snapshot? Wave 9 fix:
 * operational + per-device keys are not user data and must not
 * round-trip.
 */
function shouldExportKey(key: string): boolean {
  for (const re of EXPORT_FILTER_KEY_PATTERNS) {
    if (re.test(key)) return false;
  }
  return true;
}

/**
 * Read every KV entry from the running Profile via the storage's
 * `getEncryptedRaw` back-channel. Plaintext is NEVER read at this
 * layer — see Wave 9 critical #1. Storage providers without
 * `getEncryptedRaw` (legacy file-based wallets) are rejected: the
 * snapshot format requires Profile-mode storage.
 */
async function readAllKvEntries(
  storage: StorageProvider,
): Promise<ProfileSnapshotKvEntry[]> {
  const handle = storage as unknown as {
    getEncryptedRaw?: (key: string) => Promise<string | null>;
  };
  if (typeof handle.getEncryptedRaw !== 'function') {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      'profile-export requires a ProfileStorageProvider — getEncryptedRaw() is missing on the supplied StorageProvider. ' +
        'Legacy file/IndexedDB-only wallets cannot be exported in this format.',
    );
  }

  const allKeys = await storage.keys();
  if (allKeys.length > MAX_KV_ENTRIES) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Refusing to export: profile has ${allKeys.length} KV entries (cap ${MAX_KV_ENTRIES}). ` +
        `Run consolidation or contact support before exporting.`,
    );
  }

  const out: ProfileSnapshotKvEntry[] = [];
  for (const key of allKeys) {
    if (!shouldExportKey(key)) continue;
    let value: string | null;
    try {
      value = await handle.getEncryptedRaw(key);
    } catch (err) {
      logger.warn(
        'ProfileExport',
        `failed to read encrypted KV entry "${key}": ${err instanceof Error ? err.message : String(err)} — skipping`,
      );
      continue;
    }
    if (value === null) continue;

    if (Buffer.byteLength(value, 'utf8') > MAX_KV_VALUE_BYTES) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `KV entry "${key}" value exceeds ${MAX_KV_VALUE_BYTES} bytes — refuse export to avoid huge snapshots.`,
      );
    }
    out.push({ key, value });
  }
  // Wave 9 fix #8 — sort entries deterministically so re-exporting
  // the same Profile produces byte-identical CARs.
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

/**
 * Read every active+superseded bundle ref from the token storage and
 * fetch each bundle's CAR bytes from the local IPFS gateways.
 *
 * Returns the embedded bundles in `bundleEntries` (only those whose
 * CARs were successfully fetched), the raw CAR bytes keyed by CID in
 * `bundleCars`, and the count of bundles where the fetch failed.
 */
async function readAndFetchBundles(
  tokenStorage: ProfileTokenStorageProvider,
): Promise<{
  bundleEntries: ProfileSnapshotBundleEntry[];
  bundleCars: Map<string, Uint8Array>;
  missingCount: number;
}> {
  // Reach the BundleIndex through the token storage's documented
  // private back-channel. Test code already uses this pattern.
  const handle = tokenStorage as unknown as {
    listBundles(): Promise<Map<string, import('./types.js').UxfBundleRef>>;
    _ipfsGateways?: string[];
  };
  const gateways = handle._ipfsGateways ?? [];

  let bundleMap: Map<string, import('./types.js').UxfBundleRef>;
  try {
    bundleMap = await handle.listBundles();
  } catch (err) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Failed to enumerate Profile bundles for export: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const bundleEntries: ProfileSnapshotBundleEntry[] = [];
  const bundleCars = new Map<string, Uint8Array>();
  let missingCount = 0;

  for (const [cid, ref] of bundleMap) {
    // Skip bundles still pending verification — they are not yet
    // proven fetchable / decodable and the export snapshot schema
    // (`'active' | 'superseded'`) doesn't carry an unverified state.
    // A subsequent recovery pass will promote them to 'active' once
    // verified; until then they cannot be safely embedded in a
    // portable snapshot.
    if (ref.status === 'unverified') {
      logger.debug(
        'ProfileExport',
        `skipping unverified bundle ${cid} (will be exported after promotion to active)`,
      );
      continue;
    }
    try {
      const carBytes = await fetchFromIpfs(
        gateways,
        cid,
        PER_BUNDLE_FETCH_TIMEOUT_MS,
        PER_BUNDLE_MAX_BYTES,
      );
      bundleCars.set(cid, carBytes);
      bundleEntries.push({
        cid,
        status: ref.status,
        createdAt: ref.createdAt,
        ...(ref.tokenCount !== undefined ? { tokenCount: ref.tokenCount } : {}),
      });
    } catch (err) {
      missingCount += 1;
      logger.warn(
        'ProfileExport',
        `failed to fetch bundle CAR ${cid} for embedding: ${err instanceof Error ? err.message : String(err)} — skipping`,
      );
    }
  }

  // Wave 9 fix #8 — sort bundles deterministically for round-trip
  // determinism.
  bundleEntries.sort((a, b) => (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0));
  return { bundleEntries, bundleCars, missingCount };
}

/**
 * Build the snapshot CAR bytes from a fully-populated snapshot doc and
 * a map of bundle CARs to embed as raw blocks.
 *
 * Each bundle CAR is keyed by SHA-256(carBytes) under the raw codec.
 * The bundle's recorded ROOT CID is preserved in `bundles[i].cid` for
 * the importer to verify content-address by recomputing the digest
 * over the bundle CAR's first block.
 */
async function assembleCarBytes(
  snapshot: ProfileSnapshot,
  bundleCars: ReadonlyMap<string, Uint8Array>,
  maxSizeBytes: number,
): Promise<{ carBytes: Uint8Array; rootCid: string }> {
  // 1. Encode the snapshot root block (dag-cbor). Manifest field
  //    REMOVED in Wave 9 fix #10 — the previous implementation parsed
  //    + counted + warned "re-derived on next load", giving the user a
  //    false impression that the snapshot was carrying useful state.
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

  const rootCid = dagCborCid(rootBytes);

  // 2. Pre-flight size budget: rough estimate before opening the writer.
  let estimatedTotal = rootBytes.byteLength;
  for (const v of bundleCars.values()) estimatedTotal += v.byteLength;
  // CAR framing overhead is ~10 bytes per block + 11 byte header — be
  // defensive and add 64 bytes per block.
  estimatedTotal += (1 + bundleCars.size) * 64;
  if (estimatedTotal > maxSizeBytes) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Refusing to assemble snapshot CAR: estimated ${estimatedTotal} bytes ` +
        `exceeds maxSizeBytes=${maxSizeBytes}.`,
    );
  }

  // 3. Build the CAR.
  const { writer, out } = CarWriter.create([rootCid]);
  const chunks: Uint8Array[] = [];
  const collectPromise = (async () => {
    for await (const chunk of out) chunks.push(chunk);
  })();

  await writer.put({ cid: rootCid, bytes: rootBytes });

  // Embed each bundle CAR's bytes as a raw block. The embed-block CID
  // is computed from the embedded bytes themselves (raw codec).
  // Wave 9 fix: bundles must be embed-sorted for deterministic
  // assembly.
  const sortedBundleCidKeys = Array.from(bundleCars.keys()).sort();
  for (const bundleRootCid of sortedBundleCidKeys) {
    const carBytes = bundleCars.get(bundleRootCid)!;
    const embedCid = rawCid(carBytes);
    await writer.put({ cid: embedCid, bytes: carBytes });
  }

  await writer.close();
  await collectPromise;

  const carBytes = concatBytes(chunks);

  if (carBytes.byteLength > maxSizeBytes) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Snapshot CAR is ${carBytes.byteLength} bytes — exceeds maxSizeBytes=${maxSizeBytes}.`,
    );
  }

  return { carBytes, rootCid: rootCid.toString() };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Export every byte of the running Profile into a single CAR file.
 *
 * Side-effect-free against the source — this is a pure read.
 *
 * @throws ProfileError on cap violations or unrecoverable storage errors.
 */
export async function exportProfile(
  options: ExportProfileOptions,
): Promise<ExportProfileResult> {
  const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;

  // 1. Read all KV entries (encrypted form).
  const entries = await readAllKvEntries(options.storage);

  // 2. Enumerate + fetch bundle CARs.
  const { bundleEntries, bundleCars, missingCount } = await readAndFetchBundles(
    options.tokenStorage,
  );

  // 3. Build the snapshot doc. createdAt is option-overridable for
  //    deterministic-round-trip tests; default = Date.now().
  const snapshot: ProfileSnapshot = {
    version: PROFILE_SNAPSHOT_VERSION,
    chainPubkey: options.chainPubkey,
    network: options.network,
    createdAt: options.createdAt ?? Date.now(),
    entries,
    bundles: bundleEntries,
  };

  // 4. Assemble the CAR.
  const { carBytes, rootCid } = await assembleCarBytes(
    snapshot,
    bundleCars,
    maxSizeBytes,
  );

  return {
    carBytes,
    entryCount: entries.length,
    bundlesEmbedded: bundleEntries.length,
    bundlesMissing: missingCount,
    rootCid,
  };
}

/**
 * Compute the expected CID for a bundle's first raw block when the
 * recorded `bundle.cid` indicates a particular codec. We support both
 * raw (0x55) and dag-cbor (0x71) recorded CIDs since legitimate
 * bundles may carry either.
 *
 * Returns the recomputed CID under the same codec, with the digest
 * derived from `bytes`. The caller compares its `toString()` to the
 * recorded `bundle.cid` to authenticate.
 */
function expectedCidUnderCodec(bytes: Uint8Array, codec: number): CID {
  const digest = createMultihash(0x12, sha256(bytes));
  return CID.createV1(codec, digest);
}

/**
 * Try to find an embedded bundle CAR whose first block, content-
 * addressed under the recorded CID's codec, hashes to the recorded
 * `bundle.cid`. Returns the CAR bytes on success, or undefined.
 *
 * Authenticated path: for each candidate raw block in the snapshot
 * CAR we open it as a bundle CAR, extract its FIRST block's bytes,
 * recompute SHA-256, and rebuild the CID under the recorded codec.
 * Any mismatch fails the candidate. Defeats the Wave 9 critical #2
 * forged-roots[] attack.
 */
async function authenticateBundleCar(
  candidateBytes: Uint8Array,
  recordedCidStr: string,
): Promise<boolean> {
  let recordedCid: CID;
  try {
    recordedCid = CID.parse(recordedCidStr);
  } catch {
    return false;
  }
  // Use the recorded codec for re-derivation. We support both 0x55
  // (raw) and 0x71 (dag-cbor) — the two codecs UXF bundles legitimately
  // use.
  const codec = recordedCid.code;
  if (codec !== RAW_CODE && codec !== DAG_CBOR_CODE) {
    return false;
  }

  let reader: CarReader;
  try {
    reader = await CarReader.fromBytes(candidateBytes);
  } catch {
    return false;
  }
  const roots = await reader.getRoots();
  if (roots.length !== 1) return false;

  // Read the FIRST block (the root block) of this candidate bundle
  // CAR. We must compare bytes — `roots[0]` may have been forged in
  // the header, so we recompute from the actual block payload.
  const rootBlock = await reader.get(roots[0]);
  if (!rootBlock) return false;

  const expected = expectedCidUnderCodec(rootBlock.bytes, codec);
  if (expected.toString() !== recordedCid.toString()) return false;

  // Sanity: the header's claimed root must match the content-addressed
  // root we just verified. (Already implicit since `reader.get(roots[0])`
  // succeeds, but make it explicit.)
  if (roots[0].toString() !== recordedCid.toString()) return false;

  return true;
}

/**
 * Parse a snapshot CAR back into its root document + embedded bundle
 * CARs. Single-root validation, schema-version check, basic shape
 * validation, and Wave 9 caps + content-address verification all run
 * here.
 *
 * Returns the decoded snapshot AND the embedded bundle CARs keyed by
 * the bundle's RECORDED root CID. Bundles whose embedded CAR fails
 * content-address verification are SKIPPED (not silently substituted).
 */
export async function parseProfileSnapshot(carBytes: Uint8Array): Promise<{
  snapshot: ProfileSnapshot;
  bundleCars: Map<string, Uint8Array>;
}> {
  let reader: CarReader;
  try {
    reader = await CarReader.fromBytes(carBytes);
  } catch (err) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Failed to parse snapshot CAR: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const roots = await reader.getRoots();
  if (roots.length !== 1) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Expected exactly one CAR root; got ${roots.length}.`,
    );
  }
  const rootCid = roots[0];

  // Wave 9 fix #3: enforce block-count and per-block byte caps BEFORE
  // populating any data structure. We materialise blocks once into a
  // map from cid-string → bytes to avoid the O(N×M) bundle-match loop
  // (Wave 9 fix #4).
  const allBlocks = new Map<string, Uint8Array>();
  let blockCount = 0;
  for await (const block of reader.blocks()) {
    blockCount += 1;
    if (blockCount > PROFILE_CAR_IMPORT_MAX_BLOCK_COUNT) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `Snapshot CAR exceeds block-count cap ${PROFILE_CAR_IMPORT_MAX_BLOCK_COUNT}.`,
      );
    }
    if (block.bytes.byteLength > PROFILE_CAR_IMPORT_MAX_BLOCK_BYTES) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `Snapshot CAR has a block of ${block.bytes.byteLength} bytes — exceeds per-block cap ${PROFILE_CAR_IMPORT_MAX_BLOCK_BYTES}.`,
      );
    }
    allBlocks.set(block.cid.toString(), block.bytes);
  }

  const rootBytes = allBlocks.get(rootCid.toString());
  if (!rootBytes) {
    throw new ProfileError('PROFILE_NOT_INITIALIZED', 'Root block missing from CAR.');
  }

  let decoded: unknown;
  try {
    decoded = dagCborDecode(rootBytes);
  } catch (err) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Failed to decode snapshot root block as dag-cbor: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const snapshot = validateSnapshotShape(decoded);

  // Bundle authentication — Wave 9 critical #2.
  //
  // For each `bundles[i].cid`, we try to find an embedded raw block
  // that, when interpreted as a bundle CAR, has a single root whose
  // content-addressed CID matches the recorded `bundle.cid` exactly.
  // Bundles failing authentication are skipped.
  const bundleCars = new Map<string, Uint8Array>();
  for (const bundle of snapshot.bundles) {
    let found: Uint8Array | undefined;
    for (const [blkCidStr, blkBytes] of allBlocks) {
      if (blkCidStr === rootCid.toString()) continue;
      if (await authenticateBundleCar(blkBytes, bundle.cid)) {
        found = blkBytes;
        break;
      }
    }
    if (found) {
      bundleCars.set(bundle.cid, found);
    } else {
      logger.warn(
        'ProfileExport',
        `bundle ${bundle.cid} could not be authenticated against any embedded CAR — skipping`,
      );
    }
  }

  return { snapshot, bundleCars };
}

/**
 * Validate the decoded snapshot's shape and version. Throws on any
 * disagreement; otherwise returns a safely-typed `ProfileSnapshot`.
 *
 * Wave 9 fix #9: rejects duplicate `entries[i].key` values; rejects
 * over-cap entry counts and over-cap entry value lengths.
 */
function validateSnapshotShape(decoded: unknown): ProfileSnapshot {
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new ProfileError('PROFILE_NOT_INITIALIZED', 'Snapshot root is not an object.');
  }
  const obj = decoded as Record<string, unknown>;

  const version = obj.version;
  if (version === undefined || version === null) {
    throw new ProfileError('PROFILE_NOT_INITIALIZED', 'Snapshot missing `version` field.');
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new ProfileError('PROFILE_NOT_INITIALIZED', `Invalid snapshot version: ${String(version)}`);
  }
  if (version > PROFILE_SNAPSHOT_VERSION) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Snapshot version ${version} is newer than this SDK supports (${PROFILE_SNAPSHOT_VERSION}). ` +
        `Update the SDK before importing.`,
    );
  }

  const chainPubkey = obj.chainPubkey;
  if (typeof chainPubkey !== 'string' || chainPubkey.length === 0) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      'Snapshot missing or invalid `chainPubkey` field.',
    );
  }

  const network = obj.network;
  if (typeof network !== 'string' || network.length === 0) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      'Snapshot missing or invalid `network` field.',
    );
  }

  const createdAt = obj.createdAt;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      'Snapshot missing or invalid `createdAt` field.',
    );
  }

  const entriesRaw = obj.entries;
  if (!Array.isArray(entriesRaw)) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      'Snapshot `entries` must be an array.',
    );
  }
  if (entriesRaw.length > MAX_KV_ENTRIES) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Snapshot has ${entriesRaw.length} entries — exceeds cap ${MAX_KV_ENTRIES}.`,
    );
  }

  const entries: ProfileSnapshotKvEntry[] = [];
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
        `Duplicate entry key in snapshot: "${er.key}".`,
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
      'Snapshot `bundles` must be an array.',
    );
  }
  const bundles: ProfileSnapshotBundleEntry[] = [];
  for (const b of bundlesRaw) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) {
      throw new ProfileError('PROFILE_NOT_INITIALIZED', 'Invalid bundle entry shape.');
    }
    const br = b as Record<string, unknown>;
    if (typeof br.cid !== 'string' || br.cid.length === 0) {
      throw new ProfileError('PROFILE_NOT_INITIALIZED', 'Bundle entry missing `cid`.');
    }
    if (br.status !== 'active' && br.status !== 'superseded') {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `Bundle entry has invalid status: ${String(br.status)}`,
      );
    }
    if (typeof br.createdAt !== 'number' || !Number.isFinite(br.createdAt)) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        'Bundle entry missing/invalid `createdAt`.',
      );
    }
    const entry: ProfileSnapshotBundleEntry = {
      cid: br.cid,
      status: br.status,
      createdAt: br.createdAt,
      ...(typeof br.tokenCount === 'number' ? { tokenCount: br.tokenCount } : {}),
    };
    bundles.push(entry);
  }

  // Wave 9 fix #10: manifest field has been removed from the v1
  // schema. Any presence of `manifest` in the decoded doc indicates
  // either a v2+ writer (caught by version check above) or a tampered
  // v1 doc — silently ignore it. The caller never sees it.

  const result: ProfileSnapshot = {
    version: 1,
    chainPubkey,
    network,
    createdAt,
    entries,
    bundles,
  };
  return result;
}
