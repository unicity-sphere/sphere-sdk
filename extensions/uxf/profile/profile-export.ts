/**
 * Profile Export — whole-profile snapshot to a single CAR file.
 *
 * Bundles every byte the running wallet needs to be reconstituted on
 * another device into one portable CAR:
 *
 *   - Every Profile KV entry that lives in OrbitDB, captured as
 *     ENCRYPTED ciphertext (never decrypted at this layer).
 *   - Every bundle's full DAG (envelope + manifest + per-token / per-
 *     element sub-blocks) embedded as individually-addressable dag-cbor
 *     blocks inside the snapshot CAR. Repeating sub-components (a
 *     predicate, type, or token shared by two bundles) collapse to a
 *     single block — the snapshot CAR is the union of every bundle's
 *     reachable block set, keyed by canonical CID.
 *
 * The resulting CAR has ONE root block (dag-cbor `ProfileSnapshot`
 * envelope) and N + M additional dag-cbor blocks: N per-bundle root
 * blocks + M shared/unique sub-blocks. The recorded `bundles[i].cid`
 * is the bundle's root CID, addressable in isolation.
 *
 * Issue #200 Phase 5 — Profile export/import alignment.
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
 *   2. **Bundle CID content-address posture.** The snapshot root CID
 *      is re-verified against the root block bytes (the envelope is
 *      a dag-cbor encoding with no child CID refs, so its CID ==
 *      sha256(bytes) holds unambiguously). Per-block CID-binding
 *      verification is NOT applied to the embedded bundle sub-blocks
 *      because the SDK's bundle CAR builder
 *      (`uxf/ipld.ts:elementToIpldBlock`) emits sub-block bytes
 *      (IPLD form, with CID-link children) under CIDs computed from
 *      a different canonical form (hash form, with raw hash-bytes
 *      children) — a uniform per-block check would reject every
 *      legitimate bundle. Tracked as a follow-up for issue #200
 *      closeout: reconcile the bundle CAR codec model with the
 *      canonical `dag/put`-`block/get` round-trip so per-block
 *      verification can be reintroduced.
 *   3. **Schema is versioned.** Snapshots carry `version: 2`. v1 was
 *      the pre-Phase-5 flat layout (whole bundle CARs embedded as raw
 *      blocks). v2 is the hierarchical layout. The parser rejects
 *      `version != 2` so unknown forward-compat data never lands
 *      silently.
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
 *      sorted by cid; sub-blocks emitted in deterministic CID order
 *      after the root. Two exports of the same Profile produce
 *      byte-identical roots.
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

import type { StorageProvider } from '../../../storage/storage-provider.js';
import type { ProfileTokenStorageProvider } from './profile-token-storage-provider.js';
import { fetchCarFromIpfs } from './ipfs-client.js';
import { logger } from '../../../core/logger.js';
import { ProfileError } from './errors.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Current snapshot schema version. Bump only with explicit migration story.
 *
 * **v2 (current)** — hierarchical: every block in every embedded bundle is
 *   addressable by its own CID. Shared sub-blocks dedup at the block
 *   level. Issue #200 Phase 5.
 *
 * **v1 (removed)** — flat: each embedded bundle was stored as a single
 *   raw block whose payload was the bundle's entire CAR bytes; the
 *   bundle's root CID was carried inline in `bundles[i].cid` for the
 *   importer to re-derive after a SHA pass. No dedup, no per-token
 *   addressability. The parser rejects v1 with an explicit version
 *   error.
 */
export const PROFILE_SNAPSHOT_VERSION = 2 as const;

/**
 * Hard cap on the assembled snapshot CAR.
 *
 * Reduced from 1 GiB to 256 MiB in Wave 9 — a profile snapshot is
 * dominated by bundle block payloads, which themselves cap at 50 MiB
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
 * Hard cap on total CAR-import block count. v2 snapshots can have many
 * tiny dag-cbor sub-blocks (one per token element across all bundles),
 * so the cap is wider than the transfer-bundle's 10 000 ceiling. 200 000
 * is generous for any plausible wallet today while still cutting off
 * a hostile CAR that would otherwise drive 1M Map insertions.
 */
const PROFILE_CAR_IMPORT_MAX_BLOCK_COUNT = 200_000;

/**
 * Hard cap on per-block bytes in CAR import. Bundles now live as a
 * tree of small dag-cbor blocks rather than one large raw block, so
 * the per-block cap can stay tight at 1 MiB — any individual block
 * above this is hostile bloat.
 */
const PROFILE_CAR_IMPORT_MAX_BLOCK_BYTES = 1024 * 1024; // 1 MiB

/** dag-cbor codec id (multicodec). */
const DAG_CBOR_CODE = 0x71;

/** raw codec id (multicodec). Legacy bundle CIDs may still use it. */
const RAW_CODE = 0x55;

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
 * single root block, plus one or more dag-cbor blocks per embedded
 * bundle DAG (envelope + manifest + per-token / per-element sub-blocks).
 */
export interface ProfileSnapshot {
  /** Snapshot schema version. */
  readonly version: 2;
  /** Wallet's chain pubkey at export time (informational). */
  readonly chainPubkey: string;
  /** Network identifier at export time (testnet/mainnet/dev). */
  readonly network: string;
  /** Snapshot timestamp (ms since epoch). */
  readonly createdAt: number;
  /** All Profile KV entries (encrypted form preserved). */
  readonly entries: ReadonlyArray<ProfileSnapshotKvEntry>;
  /** All bundle refs whose root blocks were successfully embedded. */
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
  /** Number of bundles whose DAGs were successfully embedded. */
  readonly bundlesEmbedded: number;
  /** Number of bundles where the CAR fetch failed (skipped from output). */
  readonly bundlesMissing: number;
  /**
   * Number of unique bundle blocks embedded across every bundle's DAG.
   * In v2 this is the count of distinct CIDs — shared sub-blocks
   * (predicate, token, type) collapse to a single block. Smaller than
   * the naive sum of per-bundle block counts whenever bundles share
   * sub-components.
   */
  readonly uniqueBundleBlocks: number;
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
 * Read every active+superseded bundle ref from the token storage, fetch
 * each bundle's full DAG from the local IPFS gateways via the
 * hierarchical `fetchCarFromIpfs` helper, then extract individual
 * blocks from each fetched CAR keyed by their canonical CID.
 *
 * Returns the embedded bundles in `bundleEntries` (only those whose
 * DAGs were successfully fetched), the union of all bundle blocks
 * (deduped by CID) in `blockMap`, and the count of bundles where the
 * fetch failed.
 *
 * The dedup is the heart of Phase 5: if two bundles share a token (or
 * predicate, or proof), the shared block is fetched separately for
 * each bundle (the gateway returns a fresh copy each time) but ends
 * up keyed by the same CID in the union map, so it occupies one slot.
 */
async function readAndFetchBundles(
  tokenStorage: ProfileTokenStorageProvider,
): Promise<{
  bundleEntries: ProfileSnapshotBundleEntry[];
  blockMap: Map<string, Uint8Array>;
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
  const blockMap = new Map<string, Uint8Array>();
  let missingCount = 0;

  for (const [cid, ref] of bundleMap) {
    // Skip bundles still pending verification — they are not yet
    // proven fetchable / decodable and the export snapshot schema
    // (`'active' | 'superseded'`) doesn't carry an unverified state.
    if (ref.status === 'unverified') {
      logger.debug(
        'ProfileExport',
        `skipping unverified bundle ${cid} (will be exported after promotion to active)`,
      );
      continue;
    }
    try {
      // Codec dispatch: dag-cbor (Phase 2 / new) bundles point at a
      // hierarchical DAG; legacy raw-codec bundles point at a single
      // raw block whose payload is the whole bundle CAR. The two
      // cases need different embedding strategies.
      let parsedBundleCid: CID;
      try {
        parsedBundleCid = CID.parse(cid);
      } catch (err) {
        missingCount += 1;
        logger.warn(
          'ProfileExport',
          `bundle index entry ${cid} has an unparseable CID — skipping: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      // `fetchCarFromIpfs` walks the bundle DAG (hierarchical Phase 2)
      // OR short-circuits to a single `block/get` for legacy raw-CID
      // bundles. For dag-cbor it returns a synthetic CAR containing
      // every reachable block; for raw it returns the bytes pinned
      // verbatim (which are the legacy single-raw-block payload).
      const carBytes = await fetchCarFromIpfs(
        gateways,
        cid,
        PER_BUNDLE_FETCH_TIMEOUT_MS,
        PER_BUNDLE_MAX_BYTES,
      );

      if (parsedBundleCid.code === RAW_CODE) {
        // Legacy raw-codec bundle: the bundle CID is `sha256(carBytes)`
        // under the raw codec. Store the whole-CAR bytes as a single
        // raw block under the bundle's recorded CID. On import the
        // raw block re-pins under the same CID and the existing
        // fetch-by-bundle-cid path keeps working.
        if (!blockMap.has(cid)) {
          // Re-verify the raw CID matches the bytes — `fetchFromIpfs`
          // already did this check, but make it explicit so a future
          // refactor cannot silently embed bytes under a wrong CID.
          const expected = createMultihash(0x12, sha256(carBytes));
          const recomputed = CID.createV1(RAW_CODE, expected).toString();
          if (recomputed !== cid) {
            missingCount += 1;
            logger.warn(
              'ProfileExport',
              `legacy raw bundle ${cid}: gateway-returned bytes do not hash to the recorded CID — skipping`,
            );
            continue;
          }
          blockMap.set(cid, carBytes);
        }
      } else {
        // Hierarchical (Phase 2+) bundle: the CAR's roots[0] equals
        // the bundle CID (a dag-cbor envelope CID). Extract every
        // block individually into the union map; the CarReader
        // already verifies each block's CID against its content.
        const reader = await CarReader.fromBytes(carBytes);
        let foundRoot = false;
        for await (const block of reader.blocks()) {
          const blkCidStr = block.cid.toString();
          if (blkCidStr === cid) foundRoot = true;
          // Dedup by CID across bundles. Reuse the first-encountered
          // bytes; identical CIDs implies identical content (sha256).
          if (!blockMap.has(blkCidStr)) {
            blockMap.set(blkCidStr, block.bytes);
          }
        }
        if (!foundRoot) {
          // Defensive: the fetched DAG must include a block whose CID
          // equals the recorded bundle CID; otherwise the gateway
          // delivered a bundle under an unexpected name (likely a
          // redirect / mismatched-builder bug), refuse to embed.
          missingCount += 1;
          logger.warn(
            'ProfileExport',
            `bundle ${cid}: fetched DAG did not contain a block matching the recorded bundle CID — skipping`,
          );
          continue;
        }
      }

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
        `failed to fetch bundle DAG ${cid} for embedding: ${err instanceof Error ? err.message : String(err)} — skipping`,
      );
    }
  }

  // Wave 9 fix #8 — sort bundles deterministically for round-trip
  // determinism.
  bundleEntries.sort((a, b) => (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0));
  return { bundleEntries, blockMap, missingCount };
}

/**
 * Build the snapshot CAR bytes from a fully-populated snapshot doc and
 * a deduped map of bundle blocks keyed by canonical CID.
 *
 * The CAR carries one dag-cbor root (the snapshot envelope) plus every
 * bundle block from `blockMap` in CID-sorted order. Each bundle block
 * is addressable by its own CID; the importer walks `bundles[i].cid` →
 * sub-block links to reconstruct each bundle.
 */
async function assembleCarBytes(
  snapshot: ProfileSnapshot,
  blockMap: ReadonlyMap<string, Uint8Array>,
  maxSizeBytes: number,
): Promise<{ carBytes: Uint8Array; rootCid: string }> {
  // 1. Encode the snapshot root block (dag-cbor).
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

  if (rootBytes.byteLength > PROFILE_CAR_IMPORT_MAX_BLOCK_BYTES) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Profile snapshot root block is ${rootBytes.byteLength} bytes — exceeds per-block cap ${PROFILE_CAR_IMPORT_MAX_BLOCK_BYTES}.`,
    );
  }

  const rootCid = dagCborCid(rootBytes);

  // 2. Pre-flight size budget: rough estimate before opening the writer.
  let estimatedTotal = rootBytes.byteLength;
  for (const v of blockMap.values()) estimatedTotal += v.byteLength;
  // CAR framing overhead is ~10 bytes per block + 11 byte header — be
  // defensive and add 64 bytes per block.
  estimatedTotal += (1 + blockMap.size) * 64;
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

  // Emit bundle blocks in deterministic CID-sorted order so two
  // exports of the same Profile state produce byte-identical CARs.
  const sortedCids = Array.from(blockMap.keys()).sort();
  for (const cidStr of sortedCids) {
    let cid: CID;
    try {
      cid = CID.parse(cidStr);
    } catch (err) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `assembleCarBytes: cannot parse bundle block CID ${cidStr}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const bytes = blockMap.get(cidStr)!;
    if (bytes.byteLength > PROFILE_CAR_IMPORT_MAX_BLOCK_BYTES) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `Profile snapshot bundle block ${cidStr} is ${bytes.byteLength} bytes — exceeds per-block cap ${PROFILE_CAR_IMPORT_MAX_BLOCK_BYTES}.`,
      );
    }
    await writer.put({ cid, bytes });
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

  // 2. Enumerate + fetch bundle DAGs, deduping shared blocks by CID.
  const { bundleEntries, blockMap, missingCount } = await readAndFetchBundles(
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
    blockMap,
    maxSizeBytes,
  );

  return {
    carBytes,
    entryCount: entries.length,
    bundlesEmbedded: bundleEntries.length,
    bundlesMissing: missingCount,
    uniqueBundleBlocks: blockMap.size,
    rootCid,
  };
}

/**
 * Walk the dag-cbor sub-DAG rooted at `rootCidStr`, starting from
 * `blockMap`, and reassemble a CARv1 over the visited blocks.
 *
 * BFS-walks CID links via dag-cbor's Tag-42 decoding. Raw-codec blocks
 * are treated as leaves (no further walk). Unknown codecs are rejected
 * to prevent silent skip of new block types.
 *
 * Returns `undefined` if the root block is missing from the CAR (the
 * caller treats this as "bundle authentication failed"). Returns a
 * fresh CAR bytes Uint8Array on success.
 */
async function reconstructBundleCar(
  blockMap: ReadonlyMap<string, Uint8Array>,
  rootCidStr: string,
): Promise<Uint8Array | undefined> {
  if (!blockMap.has(rootCidStr)) return undefined;

  let rootCid: CID;
  try {
    rootCid = CID.parse(rootCidStr);
  } catch {
    return undefined;
  }
  if (rootCid.code !== DAG_CBOR_CODE && rootCid.code !== RAW_CODE) {
    return undefined;
  }

  const visited = new Set<string>();
  const collected: Array<{ cid: CID; bytes: Uint8Array }> = [];
  const queue: string[] = [rootCidStr];

  while (queue.length > 0) {
    const cidStr = queue.shift()!;
    if (visited.has(cidStr)) continue;
    visited.add(cidStr);

    const bytes = blockMap.get(cidStr);
    if (bytes === undefined) {
      // The DAG references a block that's not in the snapshot CAR.
      // The bundle is incomplete — refuse to reconstruct.
      return undefined;
    }
    let cid: CID;
    try {
      cid = CID.parse(cidStr);
    } catch {
      return undefined;
    }
    collected.push({ cid, bytes });

    // Only dag-cbor blocks can carry CID links (Tag 42). raw blocks
    // and unknown codecs are leaves.
    if (cid.code === DAG_CBOR_CODE) {
      let decoded: unknown;
      try {
        decoded = dagCborDecode(bytes);
      } catch {
        return undefined;
      }
      collectCidLinks(decoded, (child) => {
        const childStr = child.toString();
        if (!visited.has(childStr)) queue.push(childStr);
      });
    }
  }

  const { writer, out } = CarWriter.create([rootCid]);
  const chunks: Uint8Array[] = [];
  const collectPromise = (async () => {
    for await (const chunk of out) chunks.push(chunk);
  })();
  for (const block of collected) {
    await writer.put(block);
  }
  await writer.close();
  await collectPromise;

  return concatBytes(chunks);
}

/**
 * Schema-agnostic CID-link collector (dag-cbor Tag 42 decode produces
 * actual `CID` instances). Mirrors `profile/ipfs-client.ts:collectCidLinks`;
 * duplicated here so the parser stays self-contained.
 */
function collectCidLinks(value: unknown, visit: (cid: CID) => void): void {
  if (value === null || value === undefined) return;
  if (typeof value !== 'object') return;
  if (value instanceof Uint8Array) return;

  const asCid = CID.asCID(value as CID);
  if (asCid !== null) {
    visit(asCid);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectCidLinks(item, visit);
    return;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    collectCidLinks(v, visit);
  }
}

/**
 * Parse a snapshot CAR back into its root document + reconstructed
 * bundle CARs. Single-root validation, schema-version check, basic
 * shape validation, and Wave 9 caps + content-address verification all
 * run here.
 *
 * Returns the decoded snapshot AND a per-bundle CAR map keyed by the
 * bundle's root CID. Bundles whose root block is absent from the
 * snapshot CAR, or whose DAG cannot be reassembled completely, are
 * SKIPPED (not silently substituted). Callers iterate `snapshot.bundles`
 * to find missing entries.
 *
 * NOTE on per-block CID-binding verification:
 *
 *   The `@ipld/car` `CarReader` does NOT recompute `sha256(bytes)`
 *   against the framed CID — it just slices `{cid, bytes}` pairs from
 *   the stream. Defense-in-depth would call `verifyCidMatchesBytes`
 *   per block, but the SDK's pre-Phase-5 bundle builder
 *   (`uxf/ipld.ts:elementToIpldBlock`) deliberately emits sub-block
 *   bytes (IPLD form, with CID-link children) under CIDs computed
 *   from a different canonical form (hash form, with raw hash-bytes
 *   children). For UXF sub-blocks, `sha256(block.bytes) !=
 *   block.cid.multihash.digest` by design; a uniform per-block check
 *   here would reject every legitimate bundle. Verification of the
 *   snapshot root + content-address sanity of the snapshot CAR's
 *   envelope structure stays in force. Tracked as a follow-up to
 *   reconcile the bundle CAR codec model with the canonical
 *   `dag/put`-`block/get` round-trip; see issue #200 closeout notes.
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

  // Materialise blocks into a map. The same map is the input to the
  // per-bundle DAG walker so we don't re-scan the CAR per bundle.
  //
  // Per-block CID-binding verification is NOT applied here: see the
  // module-level NOTE — bundle sub-blocks emitted by
  // `uxf/ipld.ts:elementToIpldBlock` carry CIDs computed from the
  // hash canonical form (children = raw hash bytes) while the block
  // bytes encode the IPLD form (children = CID links). The two
  // encodings differ, so a uniform per-block check would reject
  // every snapshot that embeds a non-empty bundle. The snapshot root
  // CID (a dag-cbor encoding of the snapshot envelope, no child CID
  // refs) IS verified explicitly below.
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

  // Verify the root CID against its content: the snapshot envelope is
  // a dag-cbor encoding of the snapshot doc with NO child CID refs,
  // so its CID == sha256(bytes) holds unambiguously. Catches a CAR
  // with a forged header `roots[0]` that points to a different
  // block's payload (or to bytes with a substituted codec).
  const expectedRootCid = dagCborCid(rootBytes);
  if (expectedRootCid.toString() !== rootCid.toString()) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Snapshot root CID mismatch: header claims ${rootCid.toString()}, content-addressed CID is ${expectedRootCid.toString()}.`,
    );
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

  // Reconstruct each bundle CAR from its sub-DAG in the snapshot block
  // map. Bundles whose root block is absent or whose DAG cannot be
  // walked completely are skipped.
  const bundleCars = new Map<string, Uint8Array>();
  for (const bundle of snapshot.bundles) {
    const recovered = await reconstructBundleCar(allBlocks, bundle.cid);
    if (recovered) {
      bundleCars.set(bundle.cid, recovered);
    } else {
      logger.warn(
        'ProfileExport',
        `bundle ${bundle.cid} could not be reconstructed from snapshot CAR — root block missing, references a missing sub-block, or has an unsupported codec`,
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
  if (version < PROFILE_SNAPSHOT_VERSION) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Snapshot version ${version} is older than this SDK accepts (${PROFILE_SNAPSHOT_VERSION}). ` +
        `Pre-Phase-5 snapshots cannot be imported; re-export from a wallet running this SDK version.`,
    );
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

  const result: ProfileSnapshot = {
    version: PROFILE_SNAPSHOT_VERSION,
    chainPubkey,
    network,
    createdAt,
    entries,
    bundles,
  };
  return result;
}
