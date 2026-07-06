/**
 * Profile Import — restore a Profile from a `profile-export` CAR file.
 *
 * Reads a snapshot produced by {@link exportProfile}, replays every KV
 * entry into the destination StorageProvider as ENCRYPTED bytes (so
 * the destination's master key, which must match the source's, can
 * decrypt them on subsequent reads), and re-pins every reconstructed
 * bundle DAG to the destination's IPFS gateway block-by-block under
 * each block's canonical CID.
 *
 * Issue #200 Phase 5: the snapshot is now hierarchical — every bundle
 * block is individually addressable in the snapshot CAR, and the
 * importer pins them block-by-block via {@link pinCarBlocksToIpfs}.
 * Bundles that share sub-components dedup naturally at the pin layer
 * because identical bytes produce identical CIDs and the gateway's
 * `dag/put` is idempotent (a re-pin of the same CID is a no-op).
 *
 * Wave 9 hardening:
 *
 *   - **Refuse silent clobber.** If the destination Profile has any
 *     KV entries OR bundle refs, the import bails with an error. The
 *     CLI exposes `--force` to override.
 *   - **Identity check is REQUIRED.** `expectedChainPubkey` is a
 *     required option. If the snapshot's `chainPubkey` does not match,
 *     the import fails unless `allowDifferentIdentity` is also set.
 *   - **Hard hazard gate.** `force=true && allowDifferentIdentity=true`
 *     is rejected unless `acknowledgeOverwriteRisk=true` is also set.
 *     This combination overwrites the destination wallet with the
 *     snapshot's identity — irrecoverable data loss without a backup.
 *   - **IPFS gateway required.** `pinCarBlocksToIpfs` will refuse to
 *     mark a bundle as pinned without a configured gateway. Imports
 *     run with no gateway throw `IPFS_GATEWAY_REQUIRED`.
 *   - **Identity-class write failures abort.** Failure to land
 *     `mnemonic`, `master_key`, `chain_code`, etc. is a hard error —
 *     the destination wallet would otherwise re-derive a different
 *     identity from defaults and silently corrupt every other KV
 *     entry on first read.
 *   - **Encrypted-form replay.** When the destination's storage
 *     provider exposes `setEncryptedRaw`, KV values are written
 *     verbatim (the snapshot already carries ciphertext). When it
 *     does not, we fall back to the legacy `set()` path — a no-op
 *     for legacy wallets that this format does not target.
 *
 * @see /home/vrogojin/uxf/profile/profile-export.ts
 * @module profile/profile-import
 */

import type { StorageProvider } from '../../../storage/storage-provider.js';
import type { ProfileTokenStorageProvider } from './profile-token-storage-provider.js';
import type { ProfileSnapshot } from './profile-export.js';
import { IDENTITY_CLASS_KEYS } from './profile-export.js';
import { pinCarBlocksToIpfs } from './ipfs-client.js';
import { logger } from '../../../core/logger.js';
import { ProfileError } from './errors.js';

// =============================================================================
// Types
// =============================================================================

/** Options accepted by importProfile. */
export interface ImportProfileOptions {
  /** Destination Profile KV storage. */
  readonly storage: StorageProvider;
  /** Destination Profile token storage (provides bundle index + IPFS). */
  readonly tokenStorage: ProfileTokenStorageProvider;
  /** Parsed snapshot — `parseProfileSnapshot(carBytes).snapshot`. */
  readonly snapshot: ProfileSnapshot;
  /**
   * Reconstructed bundle CARs keyed by their root CID. Each value is a
   * CARv1 byte stream containing the bundle's root block plus all
   * reachable sub-blocks; the importer pins each block individually
   * via {@link pinCarBlocksToIpfs}.
   */
  readonly bundleCars: ReadonlyMap<string, Uint8Array>;
  /**
   * REQUIRED. The running wallet's chainPubkey. Must match
   * `snapshot.chainPubkey` unless `allowDifferentIdentity` is true.
   *
   * Wave 9 fix #6 — was previously optional, allowing a CLI handler
   * with an unset `sphere.identity` to silently bypass the identity
   * check. Now a missing value throws `INVALID_OPTIONS`.
   */
  readonly expectedChainPubkey: string;
  /**
   * Override the silent-clobber refusal. Default false. When true, the
   * importer overwrites any existing destination state.
   */
  readonly force?: boolean;
  /**
   * Skip the chainPubkey identity check. Default false. Use only when
   * intentionally re-keying a wallet (the encrypted KV entries will be
   * unreadable to the destination if its master key differs).
   */
  readonly allowDifferentIdentity?: boolean;
  /**
   * Required when `force=true && allowDifferentIdentity=true`. The CLI
   * gates this behind `--understand-overwrite-risk` and prints a
   * multi-line warning before allowing the combination. Without this
   * flag the importer rejects the dangerous combination — a wallet
   * could be irrecoverably overwritten otherwise.
   */
  readonly acknowledgeOverwriteRisk?: boolean;
}

/** Diagnostic counters surfaced to callers. */
export interface ImportProfileResult {
  /** KV entries replayed to the destination. */
  readonly entriesReplayed: number;
  /** Bundle DAGs successfully re-pinned to local IPFS. */
  readonly bundlesPinned: number;
  /** Bundle DAGs whose pin failed (logged and skipped). */
  readonly bundlesFailed: number;
  /** Bundle refs successfully restored under `tokens.bundle.*`. */
  readonly bundleRefsRestored: number;
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Determine whether a destination Profile is empty enough to receive
 * an import without `--force`.
 *
 * Wave 9 fix #9: we now check `(await storage.keys()).length > 0 ||
 * bundleCount > 0` — any persisted state, not just identity-class
 * keys, blocks an unforced import.
 */
async function isProfileNonEmpty(
  storage: StorageProvider,
  tokenStorage: ProfileTokenStorageProvider,
): Promise<{ nonEmpty: boolean; reason?: string }> {
  try {
    const keys = await storage.keys();
    if (keys.length > 0) {
      return { nonEmpty: true, reason: `${keys.length} KV entries present` };
    }
  } catch {
    // Disconnected provider raises here — treat as empty so callers
    // who haven't yet attached storage aren't blocked.
  }

  // Bundle refs check.
  try {
    const handle = tokenStorage as unknown as {
      listBundles(): Promise<Map<string, unknown>>;
    };
    const bundleMap = await handle.listBundles();
    if (bundleMap.size > 0) {
      return { nonEmpty: true, reason: `${bundleMap.size} existing bundle refs` };
    }
  } catch {
    // Token storage might not be initialized yet — that's fine.
  }

  return { nonEmpty: false };
}

/**
 * Replay every KV entry from the snapshot into the destination
 * StorageProvider.
 *
 * Wave 9 critical #1 + fix #9 — values are ciphertext (base64).
 * If the destination supports `setEncryptedRaw`, write through that;
 * otherwise fall back to `set()` for legacy compatibility (callers
 * targeting non-Profile wallets).
 *
 * Identity-class key failures (`mnemonic`, `master_key`, ...) abort
 * the import. Other key failures are logged + skipped.
 *
 * **Write ordering (steelman finding):** identity-class keys (mnemonic,
 * master_key, chain_code, derivation_path, base_path) are written
 * LAST so that a process crash mid-import leaves a destination
 * profile that is unbootable (no identity present) rather than one
 * that boots a freshly-derived identity from defaults and then fails
 * to decrypt any of the partially-imported encrypted KV entries. The
 * input `entries` array is sorted alphabetically at export time —
 * without this partition, the lowercase `master_key` / `mnemonic`
 * keys would land in the middle of the iteration, after uppercase
 * `DIRECT_*` tracked-address entries.
 */
async function replayKvEntries(
  storage: StorageProvider,
  entries: ReadonlyArray<{ key: string; value: string }>,
): Promise<number> {
  const handle = storage as unknown as {
    setEncryptedRaw?: (key: string, value: string) => Promise<void>;
  };
  const hasEncryptedRaw = typeof handle.setEncryptedRaw === 'function';

  // Partition: non-identity-class entries write first; identity-class
  // entries (mnemonic / master_key / chain_code / derivation_path /
  // base_path) write LAST. A crash mid-non-identity leaves the
  // destination identity-less → next boot creates a fresh wallet, no
  // identity ambiguity. A crash mid-identity is the only window where
  // partial-identity state could exist; that window is now O(#identity
  // keys) ≈ 5 writes instead of O(#total entries).
  const dataEntries: Array<{ key: string; value: string }> = [];
  const identityEntries: Array<{ key: string; value: string }> = [];
  for (const e of entries) {
    if (IDENTITY_CLASS_KEYS.has(e.key)) identityEntries.push(e);
    else dataEntries.push(e);
  }
  const ordered = [...dataEntries, ...identityEntries];

  let successCount = 0;
  for (const { key, value } of ordered) {
    try {
      if (hasEncryptedRaw) {
        await handle.setEncryptedRaw!(key, value);
      } else {
        await storage.set(key, value);
      }
      successCount += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (IDENTITY_CLASS_KEYS.has(key)) {
        // Wave 9 fix #9 — identity-class writes failing means the
        // destination wallet will re-derive a different identity
        // from defaults on next load and the rest of the imported
        // entries will be unreadable. Hard-fail loudly.
        throw new ProfileError(
          'PROFILE_NOT_INITIALIZED',
          `IDENTITY_WRITE_FAILED — failed to replay identity-class key "${key}": ${msg}`,
          err,
        );
      }
      logger.warn(
        'ProfileImport',
        `failed to replay KV entry "${key}": ${msg}`,
      );
    }
  }
  return successCount;
}

/**
 * Re-pin a bundle DAG to the destination's IPFS gateway and restore
 * its `tokens.bundle.{cid}` ref entry.
 *
 * Phase 5: the bundle CAR carries every reachable block (envelope +
 * manifest + per-token / per-element). Each block is pinned under its
 * canonical CID via {@link pinCarBlocksToIpfs}. Re-pinning a block
 * that was already pinned (e.g. shared between two bundles, or pinned
 * from a previous import) is idempotent at the gateway — the resulting
 * pin count for shared blocks is the count of importing bundles, but
 * the stored bytes are one copy. The bundle's recorded `cid` is the
 * dag-cbor root CID, addressable in isolation via `block/get`.
 *
 * Wave 9 fix #5: `pinned: true` is set ONLY after a successful pin
 * call against a configured gateway. With no gateway configured the
 * caller is responsible for refusing the import altogether — this
 * helper does NOT silently mark unpinned bundles as pinned.
 */
async function pinAndRegisterBundle(
  tokenStorage: ProfileTokenStorageProvider,
  cid: string,
  carBytes: Uint8Array,
  ref: { status: 'active' | 'superseded'; createdAt: number; tokenCount?: number },
): Promise<{ pinned: boolean; refRestored: boolean }> {
  const handle = tokenStorage as unknown as {
    _ipfsGateways?: string[];
    addBundle(cid: string, ref: unknown): Promise<void>;
  };
  const gateways = handle._ipfsGateways ?? [];

  // Wave 9 fix #5 — gate `pinned` strictly on a successful gateway pin.
  let pinned = false;
  if (gateways.length > 0) {
    try {
      // Phase 5: every bundle re-pin uses the per-block pin path. The
      // helper internally validates that `cid` is present among the
      // CAR's blocks (defense against snapshot-CAR/manifest mismatch)
      // and pins each block under its canonical CID — including the
      // legacy raw-CID single-block backcompat case (a raw-CID bundle
      // CAR contains exactly one raw block whose CID is the bundle CID).
      await pinCarBlocksToIpfs(gateways, carBytes, cid);
      pinned = true;
    } catch (err) {
      logger.warn(
        'ProfileImport',
        `failed to re-pin bundle ${cid}: ${err instanceof Error ? err.message : String(err)} — ` +
          `the ref will still be registered; sync from peers will pull the CAR back later`,
      );
    }
  } else {
    // The caller MUST refuse the import when no gateways are
    // configured — see importProfile() preflight. Reaching here with
    // no gateway is a programmer error; emit a hard log so it shows
    // up in test output.
    logger.warn(
      'ProfileImport',
      `BUG: pinAndRegisterBundle reached without IPFS gateways — bundle ${cid} will not be pinned`,
    );
  }

  // Register the bundle ref into OrbitDB regardless of pin status.
  // A pin-failed-but-ref-registered bundle is recoverable; a
  // pin-succeeded-but-ref-missing bundle is silently lost.
  let refRestored = false;
  try {
    await handle.addBundle(cid, {
      cid,
      status: ref.status,
      createdAt: ref.createdAt,
      ...(ref.tokenCount !== undefined ? { tokenCount: ref.tokenCount } : {}),
    });
    refRestored = true;
  } catch (err) {
    logger.warn(
      'ProfileImport',
      `failed to register bundle ref ${cid}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { pinned, refRestored };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Restore a Profile from a parsed snapshot + reconstructed bundle CARs.
 *
 * @throws ProfileError when:
 *   - `expectedChainPubkey` is missing (`INVALID_OPTIONS`)
 *   - `force=true && allowDifferentIdentity=true` without
 *     `acknowledgeOverwriteRisk` (refused)
 *   - the destination has no IPFS gateway configured
 *     (`IPFS_GATEWAY_REQUIRED`)
 *   - the destination is non-empty and `force` is not set
 *   - chainPubkey check fails without `allowDifferentIdentity`
 *   - any identity-class KV write fails
 */
export async function importProfile(
  options: ImportProfileOptions,
): Promise<ImportProfileResult> {
  const { storage, tokenStorage, snapshot, bundleCars } = options;

  // 0. Required-options check (Wave 9 fix #6).
  if (typeof options.expectedChainPubkey !== 'string' ||
      options.expectedChainPubkey.length === 0) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      'INVALID_OPTIONS — expectedChainPubkey is required for security; ' +
        'pass the running wallet\'s chainPubkey to gate the identity check.',
    );
  }

  // 0a. Hard hazard gate — `force + allowDifferentIdentity` without
  //     explicit acknowledgement is refused. The combination
  //     overwrites a non-empty wallet with a different identity,
  //     which is irrecoverable without the destination's mnemonic.
  if (options.force && options.allowDifferentIdentity &&
      !options.acknowledgeOverwriteRisk) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      'OVERWRITE_RISK — force + allowDifferentIdentity overwrites the destination ' +
        'wallet with the snapshot\'s identity. Pass acknowledgeOverwriteRisk:true ' +
        '(CLI: --understand-overwrite-risk) to confirm you have the destination\'s ' +
        'mnemonic backed up.',
    );
  }

  // 1. IPFS gateway preflight (Wave 9 fix #5).
  //    A profile-import with no gateway cannot persist bundle bytes
  //    durably — the bundles silently disappear once the import
  //    process exits and the in-memory CARs are GC'd. Refuse the
  //    import outright unless there are no bundles to replay
  //    (a degenerate empty snapshot).
  const tokenStorageHandle = tokenStorage as unknown as {
    _ipfsGateways?: string[];
  };
  const gateways = tokenStorageHandle._ipfsGateways ?? [];
  if (gateways.length === 0 && snapshot.bundles.length > 0) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      'IPFS_GATEWAY_REQUIRED — profile-import requires an IPFS gateway to ' +
        'persist bundle bytes; configure --ipfs-gateway or refuse the import.',
    );
  }

  // 2. Identity check.
  if (
    !options.allowDifferentIdentity &&
    options.expectedChainPubkey !== snapshot.chainPubkey
  ) {
    throw new ProfileError(
      'PROFILE_NOT_INITIALIZED',
      `Snapshot chainPubkey (${snapshot.chainPubkey}) does not match destination ` +
        `wallet chainPubkey (${options.expectedChainPubkey}). ` +
        `Pass allowDifferentIdentity:true to override (caller must understand ` +
        `that encrypted KV entries will be unreadable if the destination's ` +
        `master key differs).`,
    );
  }

  // 3. Clobber check (unless --force).
  if (!options.force) {
    const { nonEmpty, reason } = await isProfileNonEmpty(storage, tokenStorage);
    if (nonEmpty) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `Refusing to import: destination Profile is non-empty (${reason ?? 'unknown'}). ` +
          `Pass force:true to overwrite.`,
      );
    }
  }

  // 4. Replay KV entries. Identity-class write failures abort.
  const entriesReplayed = await replayKvEntries(storage, snapshot.entries);

  // 5. Re-pin + register every embedded bundle.
  let bundlesPinned = 0;
  let bundlesFailed = 0;
  let bundleRefsRestored = 0;
  for (const bundle of snapshot.bundles) {
    const carBytes = bundleCars.get(bundle.cid);
    if (!carBytes) {
      logger.warn(
        'ProfileImport',
        `snapshot listed bundle ${bundle.cid} but its CAR could not be reconstructed — skipping`,
      );
      bundlesFailed += 1;
      continue;
    }
    const { pinned, refRestored } = await pinAndRegisterBundle(
      tokenStorage,
      bundle.cid,
      carBytes,
      bundle,
    );
    if (pinned) bundlesPinned += 1;
    else bundlesFailed += 1;
    if (refRestored) bundleRefsRestored += 1;
  }

  return {
    entriesReplayed,
    bundlesPinned,
    bundlesFailed,
    bundleRefsRestored,
  };
}
