/**
 * ConsolidationEngine
 *
 * Merges multiple active UXF bundles into a single consolidated bundle.
 * This reduces the number of IPFS fetches required on load and keeps
 * the OrbitDB key space compact.
 *
 * Consolidation is a background operation triggered when the active
 * bundle count exceeds 3. It is safe across multiple devices:
 *
 * - A `consolidation.pending` OrbitDB key acts as a distributed lock.
 *   If another device started consolidation less than 5 minutes ago,
 *   the current device skips.
 * - Crash recovery on startup checks for a stale pending key and
 *   either completes or aborts the previous attempt.
 * - Superseded bundles are retained in the Profile for a configurable
 *   safety period (default 7 days) before their OrbitDB keys are deleted.
 *   The CAR files are NOT unpinned from IPFS.
 *
 * @see PROFILE-ARCHITECTURE.md Section 2.3 (Lazy Consolidation, Crash Recovery)
 * @module profile/consolidation
 */

import { logger } from '../core/logger.js';
import type { ProfileDatabase } from './types.js';
import type { UxfBundleRef, ConsolidationPendingState } from './types.js';
import { ProfileError } from './errors.js';
import { buildLocalEntry, decodeEntry } from './oplog-entry.js';
import {
  encryptProfileValue,
  decryptProfileValue,
} from './encryption.js';
import { pinCarBlocksToIpfs, fetchCarFromIpfs } from './ipfs-client.js';
import { extractCarRootCid } from '../uxf/transfer-payload.js';

// =============================================================================
// Constants
// =============================================================================

/** OrbitDB key prefix for UXF bundle references. */
const BUNDLE_KEY_PREFIX = 'tokens.bundle.';

/** OrbitDB key for the consolidation pending lock. */
const CONSOLIDATION_PENDING_KEY = 'consolidation.pending';

/** Maximum age (ms) of a pending consolidation before it is considered stale. */
const PENDING_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/** Default retention period for superseded bundles (ms). */
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Threshold: consolidation is needed when active count exceeds this. */
const CONSOLIDATION_THRESHOLD = 3;


// =============================================================================
// ConsolidationResult
// =============================================================================

/**
 * Result of a consolidation operation.
 */
export interface ConsolidationResult {
  /** Whether consolidation was performed. */
  readonly consolidated: boolean;
  /** CID of the new consolidated bundle (undefined if skipped). */
  readonly consolidatedCid?: string;
  /** Number of source bundles that were merged. */
  readonly sourceBundleCount: number;
  /** Total token count in the consolidated bundle. */
  readonly tokenCount: number;
  /** Reason consolidation was skipped, if applicable. */
  readonly skippedReason?: string;
}

// =============================================================================
// ConsolidationEngine
// =============================================================================

export class ConsolidationEngine {
  constructor(
    private readonly db: ProfileDatabase,
    private readonly encryptionKey: Uint8Array,
    private readonly ipfsGateways: string[],
    private readonly retentionMs: number = DEFAULT_RETENTION_MS,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Check if consolidation is needed (active bundles > 3).
   */
  async shouldConsolidate(): Promise<boolean> {
    const active = await this.listActiveBundles();
    return active.size > CONSOLIDATION_THRESHOLD;
  }

  /**
   * Check if another device is currently consolidating.
   * Returns true if a pending key exists and is less than 5 minutes old.
   */
  async isConsolidationInProgress(): Promise<boolean> {
    const pending = await this.readPendingState();
    if (!pending) return false;

    const ageMs = Date.now() - pending.startedAt * 1000;
    return ageMs < PENDING_MAX_AGE_MS;
  }

  /**
   * Run consolidation: merge all active bundles into one.
   *
   * Flow:
   *  1. Check for concurrent consolidation (pending key < 5 min old) -- skip if so
   *  2. List active bundles -- skip if count <= 3
   *  3. Write `consolidation.pending` to OrbitDB
   *  4. Fetch each active bundle CAR from IPFS (unencrypted)
   *  5. Merge all into a single UxfPackage
   *  6. Export to CAR, pin to IPFS (unencrypted)
   *  7. Add consolidated bundle ref to OrbitDB
   *  8. Mark all source bundles as superseded
   *  9. Delete `consolidation.pending` key
   * 10. Return result
   */
  async consolidate(opts?: { abortSignal?: AbortSignal }): Promise<ConsolidationResult> {
    // Step 1: concurrent guard
    // Steelman⁴⁸ WARNING: caller can pass an AbortSignal to short-
    // circuit the long TOCTOU sleep on engine shutdown. Without this,
    // a 30s sleep would block shutdown drain and could lead to
    // post-teardown reads that throw PROFILE_NOT_INITIALIZED in
    // confusing ways. The signal triggers a typed
    // CONSOLIDATION_ABORTED error so callers can distinguish from
    // CONSOLIDATION_IN_PROGRESS / IO failures.
    const pending = await this.readPendingState();
    if (pending) {
      const ageMs = Date.now() - pending.startedAt * 1000;
      if (ageMs < PENDING_MAX_AGE_MS) {
        this.log(
          `Consolidation in progress on device "${pending.device}" ` +
          `(started ${Math.round(ageMs / 1000)}s ago) -- skipping`,
        );
        return {
          consolidated: false,
          sourceBundleCount: 0,
          tokenCount: 0,
          skippedReason: `Another device ("${pending.device}") is consolidating`,
        };
      }
      // Stale pending entry (> 5 min) -- assume crashed, proceed
      this.log(
        `Stale consolidation.pending from device "${pending.device}" ` +
        `(${Math.round(ageMs / 1000)}s ago) -- overriding`,
      );
    }

    // Step 2: check threshold
    const activeBundles = await this.listActiveBundles();
    if (activeBundles.size <= CONSOLIDATION_THRESHOLD) {
      return {
        consolidated: false,
        sourceBundleCount: activeBundles.size,
        tokenCount: 0,
        skippedReason: `Active bundle count (${activeBundles.size}) does not exceed threshold (${CONSOLIDATION_THRESHOLD})`,
      };
    }

    const sourceCids = [...activeBundles.keys()];
    const deviceId = this.generateDeviceId();

    // Step 3: write pending state
    const pendingState: ConsolidationPendingState = {
      sourceCids,
      startedAt: Math.floor(Date.now() / 1000),
      device: deviceId,
    };
    await this.writePendingState(pendingState);

    // TOCTOU mitigation: wait then read back to detect concurrent consolidation.
    // Steelman⁴³ warning: 30s window matches real-world OrbitDB/Nostr
    // replication lag observed in transport configs. Previously 3s
    // was too short — two devices both proceeded past abort, both
    // consolidated in parallel, both pinned redundant CARs.
    // If another device wrote a different pending state in the race window, we abort.
    // Steelman⁴⁸: race the sleep against the abort signal so shutdown
    // can pre-empt the 30s wait. On signal, throw a typed error.
    // Steelman⁴⁹: on abort, clean up the pending state we wrote on
    // line 177 BEFORE throwing, so subsequent consolidate() calls
    // within PENDING_MAX_AGE_MS don't see a stale CONSOLIDATION_IN_
    // PROGRESS from us. Best-effort: cleanup failure does not mask
    // the abort error.
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (opts?.abortSignal) opts.abortSignal.removeEventListener('abort', onAbort);
          resolve();
        }, 30_000);
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(
            Object.assign(
              new Error('Consolidation aborted by caller (TOCTOU sleep pre-empted)'),
              { code: 'CONSOLIDATION_ABORTED' },
            ),
          );
        };
        if (opts?.abortSignal) {
          if (opts.abortSignal.aborted) {
            clearTimeout(timer);
            reject(
              Object.assign(
                new Error('Consolidation aborted by caller (signal already aborted)'),
                { code: 'CONSOLIDATION_ABORTED' },
              ),
            );
            return;
          }
          opts.abortSignal.addEventListener('abort', onAbort, { once: true });
        }
        // Don't keep Node alive for the timer — it's a wait, not work.
        if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
          (timer as { unref: () => void }).unref();
        }
      });
    } catch (abortErr) {
      // Steelman⁵⁰ WARNING: only delete the pending key if it's still
      // OURS. During the 30s sleep, another device may have written
      // its own pending state — unconditionally deleting would
      // break their TOCTOU detection on their post-sleep readBack.
      try {
        const current = await this.readPendingState();
        if (current && current.device === deviceId) {
          await this.db.del(CONSOLIDATION_PENDING_KEY);
        }
      } catch {
        /* best-effort cleanup; do not mask abort error */
      }
      throw abortErr;
    }
    const readBack = await this.readPendingState();
    if (readBack && readBack.device !== deviceId) {
      this.log(
        `Concurrent consolidation detected from device ${readBack.device} — aborting our attempt`,
      );
      return { consolidated: false, consolidatedCid: undefined, sourceBundleCount: 0, tokenCount: 0 };
    }

    try {
      // Step 4-5: fetch, merge (CARs are unencrypted on IPFS)
      const { UxfPackage } = await import('../uxf/UxfPackage.js');
      const mergedPkg = UxfPackage.create({ description: 'consolidated' });
      const successfullyMergedCids: string[] = [];

      for (const cid of sourceCids) {
        try {
          // Issue #200 Phase 2: bundle CIDs are now dag-cbor envelope
          // CIDs (per-block pinned). `fetchCarFromIpfs` walks the
          // hierarchical DAG and reassembles a synthetic CAR so the
          // downstream `UxfPackage.fromCar` consumer stays unchanged.
          // Legacy raw-CIDs still resolve via the backward-compat branch.
          const carBytes = await fetchCarFromIpfs(this.ipfsGateways, cid);
          const pkg = await UxfPackage.fromCar(carBytes);
          mergedPkg.merge(pkg);
          successfullyMergedCids.push(cid);
        } catch (err) {
          this.log(
            `Failed to load bundle ${cid} during consolidation — ` +
            `keeping it active (will retry next consolidation): ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
          // Do NOT mark this bundle as superseded — it stays active for retry
        }
      }

      // If no bundles were successfully merged, abort
      if (successfullyMergedCids.length === 0) {
        await this.db.del(CONSOLIDATION_PENDING_KEY);
        return { consolidated: false, consolidatedCid: undefined, sourceBundleCount: 0, tokenCount: 0 };
      }

      // Step 6: export, pin (unencrypted)
      const consolidatedCar = await mergedPkg.toCar();
      // Issue #200 Phase 2: pin each block in the consolidated CAR
      // under its canonical CID and publish the dag-cbor envelope CID
      // as the consolidated bundle ref. Per-block pinning means tokens
      // shared between the consolidated bundle and unsuperseded sibling
      // bundles dedup at the IPFS storage layer.
      const consolidatedExpectedRootCid =
        await extractCarRootCid(consolidatedCar);
      const consolidatedCid = await pinCarBlocksToIpfs(
        this.ipfsGateways,
        consolidatedCar,
        consolidatedExpectedRootCid,
      );

      // Count tokens in the merged package
      const tokenCount = mergedPkg.assembleAll().size;

      // Steps 7-9: finalize — ONLY supersede bundles that were successfully merged
      await this.finalizeConsolidation(
        consolidatedCid,
        tokenCount,
        successfullyMergedCids,  // NOT sourceCids — prevents data loss on partial merge
        activeBundles,
      );

      const skippedCount = sourceCids.length - successfullyMergedCids.length;
      this.log(
        `Consolidation complete: ${successfullyMergedCids.length} of ${sourceCids.length} bundles ` +
        `merged into ${consolidatedCid} (${tokenCount} tokens)` +
        (skippedCount > 0 ? `, ${skippedCount} bundles kept active for retry` : ''),
      );

      return {
        consolidated: true,
        consolidatedCid,
        sourceBundleCount: successfullyMergedCids.length,
        tokenCount,
      };
    } catch (err) {
      // Clean up pending state on failure so another device can retry
      try {
        await this.db.del(CONSOLIDATION_PENDING_KEY);
      } catch {
        // best-effort cleanup
      }

      throw new ProfileError(
        'CONSOLIDATION_IN_PROGRESS',
        `Consolidation failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  /**
   * Recover from a crash that interrupted a previous consolidation.
   *
   * Called on startup. If `consolidation.pending` exists:
   * - Check if the consolidated bundle was already pinned and registered.
   *   (The consolidated CID would appear as an active bundle whose
   *   source CIDs are all listed in the pending state.)
   * - If yes: complete steps 7-9 (mark sources superseded, delete pending).
   * - If no: delete the pending key so consolidation retries on next trigger.
   */
  async recoverFromCrash(): Promise<void> {
    const pending = await this.readPendingState();
    if (!pending) return;

    this.log(
      `Found consolidation.pending from device "${pending.device}" ` +
      `(started at ${new Date(pending.startedAt * 1000).toISOString()}) -- recovering`,
    );

    const sourceCids = new Set(pending.sourceCids);
    const allBundles = await this.listAllBundles();

    // Look for a consolidated bundle: an active bundle whose CID is NOT
    // in the source list. If it exists, the pin succeeded before the crash.
    let consolidatedCid: string | null = null;
    let consolidatedRef: UxfBundleRef | null = null;

    for (const [cid, ref] of allBundles) {
      if (ref.status === 'active' && !sourceCids.has(cid)) {
        // Verify this bundle was created after the consolidation started
        if (ref.createdAt >= pending.startedAt) {
          consolidatedCid = cid;
          consolidatedRef = ref;
          break;
        }
      }
    }

    if (consolidatedCid && consolidatedRef) {
      // Consolidated bundle was pinned and registered -- complete the process
      this.log(
        `Consolidated bundle ${consolidatedCid} found -- completing recovery`,
      );

      // Build a map of the source bundles for finalization
      const activeSources = new Map<string, UxfBundleRef>();
      for (const cid of pending.sourceCids) {
        const ref = allBundles.get(cid);
        if (ref && ref.status === 'active') {
          activeSources.set(cid, ref);
        }
      }

      // Mark source bundles as superseded and clean up pending key
      await this.markSourcesSuperseded(
        consolidatedCid,
        pending.sourceCids,
        activeSources,
      );
      await this.db.del(CONSOLIDATION_PENDING_KEY);

      this.log('Crash recovery complete -- sources marked superseded');
    } else {
      // Consolidated bundle was NOT pinned -- just clean up and let next trigger retry
      this.log(
        'Consolidated bundle not found -- deleting stale pending key (will retry on next trigger)',
      );
      await this.db.del(CONSOLIDATION_PENDING_KEY);
    }
  }

  /**
   * Clean up expired superseded bundles.
   * Removes the `tokens.bundle.{CID}` key from OrbitDB when
   * `removeFromProfileAfter` has passed. Does NOT unpin from IPFS.
   *
   * @returns CIDs of removed bundle keys.
   */
  async cleanupExpired(): Promise<string[]> {
    const allBundles = await this.listAllBundles();
    const nowSec = Math.floor(Date.now() / 1000);
    const removed: string[] = [];

    for (const [cid, ref] of allBundles) {
      if (
        ref.status === 'superseded' &&
        ref.removeFromProfileAfter != null &&
        ref.removeFromProfileAfter <= nowSec
      ) {
        try {
          await this.db.del(BUNDLE_KEY_PREFIX + cid);
          removed.push(cid);
          this.log(`Cleaned up expired bundle key: ${cid}`);
        } catch (err) {
          this.log(
            `Failed to clean up expired bundle ${cid}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    if (removed.length > 0) {
      this.log(`Cleaned up ${removed.length} expired superseded bundle(s)`);
    }

    return removed;
  }

  // ---------------------------------------------------------------------------
  // Private: finalization helpers
  // ---------------------------------------------------------------------------

  /**
   * Complete steps 7-9 of consolidation:
   *  7. Add consolidated bundle to OrbitDB
   *  8. Mark all source bundles as superseded
   *  9. Delete consolidation.pending key
   */
  private async finalizeConsolidation(
    consolidatedCid: string,
    tokenCount: number,
    sourceCids: string[],
    activeBundles: Map<string, UxfBundleRef>,
  ): Promise<void> {
    // Step 7: add consolidated bundle ref
    const consolidatedRef: UxfBundleRef = {
      cid: consolidatedCid,
      status: 'active',
      createdAt: Math.floor(Date.now() / 1000),
      tokenCount,
    };
    await this.addBundle(consolidatedCid, consolidatedRef);

    // Step 8: mark source bundles as superseded
    await this.markSourcesSuperseded(consolidatedCid, sourceCids, activeBundles);

    // Step 9: delete pending key
    await this.db.del(CONSOLIDATION_PENDING_KEY);
  }

  /**
   * Mark all source bundles as superseded with a removal deadline.
   */
  private async markSourcesSuperseded(
    consolidatedCid: string,
    sourceCids: readonly string[],
    activeBundles: Map<string, UxfBundleRef>,
  ): Promise<void> {
    const removeAfter = Math.floor((Date.now() + this.retentionMs) / 1000);

    for (const cid of sourceCids) {
      const existing = activeBundles.get(cid);
      if (!existing) continue;

      const supersededRef: UxfBundleRef = {
        ...existing,
        status: 'superseded',
        supersededBy: consolidatedCid,
        removeFromProfileAfter: removeAfter,
      };
      await this.addBundle(cid, supersededRef);
    }
  }

  // ---------------------------------------------------------------------------
  // Private: bundle CRUD (mirrors ProfileTokenStorageProvider patterns)
  // ---------------------------------------------------------------------------

  /**
   * List all bundle refs from OrbitDB (all statuses).
   *
   * Post-T-D11, `ProfileTokenStorageProvider.addBundle` writes bundle
   * refs as envelope-stamped entries when the adapter supports
   * `putEntry` (originated='system', type='cache_index'). This
   * reader mirrors `ProfileTokenStorageProvider.listBundles`: try
   * envelope decode first, fall through to raw-bytes on throw. A
   * wallet with a mixed population (legacy raw-bytes from pre-T-D11
   * flushes alongside new stamped envelopes) round-trips in both
   * directions.
   */
  private async listAllBundles(): Promise<Map<string, UxfBundleRef>> {
    const rawEntries = await this.db.all(BUNDLE_KEY_PREFIX);
    const result = new Map<string, UxfBundleRef>();

    for (const [key, value] of rawEntries) {
      const cid = key.slice(BUNDLE_KEY_PREFIX.length);
      try {
        // Extract the encrypted payload from either a stamped
        // envelope (T-D11 write shape) or raw bytes (legacy). A
        // successful decode whose `v===1` wins; anything else falls
        // through to treating `value` as the encrypted payload
        // directly.
        let encryptedPayload: Uint8Array = value;
        try {
          const envelope = decodeEntry(value);
          if (envelope.v === 1) {
            encryptedPayload = envelope.payload;
          }
        } catch {
          // Not an envelope — raw-bytes legacy entry, use `value`.
        }
        const decrypted = await decryptProfileValue(this.encryptionKey, encryptedPayload);
        const ref = JSON.parse(new TextDecoder().decode(decrypted)) as UxfBundleRef;
        result.set(cid, ref);
      } catch (err) {
        this.log(
          `Failed to deserialize bundle ref for ${cid}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return result;
  }

  /**
   * List active bundle refs from OrbitDB.
   */
  private async listActiveBundles(): Promise<Map<string, UxfBundleRef>> {
    const all = await this.listAllBundles();
    const active = new Map<string, UxfBundleRef>();
    for (const [cid, ref] of all) {
      if (ref.status === 'active') {
        active.set(cid, ref);
      }
    }
    return active;
  }

  /**
   * Write a bundle ref to OrbitDB (encrypted, system-stamped).
   *
   * Mirrors ProfileTokenStorageProvider.addBundle's T-D11 W11
   * stamping: envelope with originated='system' when putEntry is
   * available, raw-bytes fallback otherwise (readers auto-wrap as
   * v=0 legacy with synthesized originated='system' at read time).
   */
  private async addBundle(cid: string, ref: UxfBundleRef): Promise<void> {
    const serialized = new TextEncoder().encode(JSON.stringify(ref));
    const encryptedPayload = await encryptProfileValue(this.encryptionKey, serialized);

    const key = BUNDLE_KEY_PREFIX + cid;
    if (typeof this.db.putEntry === 'function') {
      const envelope = buildLocalEntry({
        type: 'cache_index',
        originated: 'system',
        payload: encryptedPayload,
      });
      await this.db.putEntry(key, envelope);
    } else {
      await this.db.put(key, encryptedPayload);
      const markHook = (this.db as { markLocallyAuthored?: (k: string) => void })
        .markLocallyAuthored;
      if (typeof markHook === 'function') {
        markHook.call(this.db, key);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private: consolidation.pending state
  // ---------------------------------------------------------------------------

  /**
   * Read the consolidation pending state from OrbitDB.
   * Returns null if no pending key exists or if it cannot be deserialized.
   */
  private async readPendingState(): Promise<ConsolidationPendingState | null> {
    const raw = await this.db.get(CONSOLIDATION_PENDING_KEY);
    if (!raw) return null;

    try {
      const decrypted = await decryptProfileValue(this.encryptionKey, raw);
      return JSON.parse(new TextDecoder().decode(decrypted)) as ConsolidationPendingState;
    } catch (err) {
      this.log(
        `Failed to read consolidation.pending: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Write the consolidation pending state to OrbitDB.
   */
  private async writePendingState(state: ConsolidationPendingState): Promise<void> {
    const serialized = new TextEncoder().encode(JSON.stringify(state));
    const encrypted = await encryptProfileValue(this.encryptionKey, serialized);
    await this.db.put(CONSOLIDATION_PENDING_KEY, encrypted);
  }

  // ---------------------------------------------------------------------------
  // Private: utilities
  // ---------------------------------------------------------------------------

  /**
   * Generate a short device identifier for the pending state.
   * Uses a random 8-character hex string.
   */
  private generateDeviceId(): string {
    const bytes = new Uint8Array(4);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private log(message: string): void {
    logger.debug('Profile-Consolidation', message);
  }
}
