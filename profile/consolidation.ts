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
import {
  encryptProfileValue,
  decryptProfileValue,
} from './encryption.js';

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

/** Default IPFS gateway URL. */
const DEFAULT_IPFS_API_URL = 'https://ipfs.unicity.network';

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
   *  4. Fetch and decrypt each active bundle CAR from IPFS
   *  5. Merge all into a single UxfPackage
   *  6. Export to CAR, encrypt, pin to IPFS
   *  7. Add consolidated bundle ref to OrbitDB
   *  8. Mark all source bundles as superseded
   *  9. Delete `consolidation.pending` key
   * 10. Return result
   */
  async consolidate(): Promise<ConsolidationResult> {
    // Step 1: concurrent guard
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

    // TOCTOU mitigation: wait briefly then read back to detect concurrent consolidation.
    // If another device wrote a different pending state in the race window, we abort.
    await new Promise(resolve => setTimeout(resolve, 3000));
    const readBack = await this.readPendingState();
    if (readBack && readBack.device !== deviceId) {
      this.log(
        `Concurrent consolidation detected from device ${readBack.device} — aborting our attempt`,
      );
      return { consolidated: false, consolidatedCid: undefined, sourceBundleCount: 0, tokenCount: 0 };
    }

    try {
      // Step 4-5: fetch, decrypt, merge
      const { UxfPackage } = await import('../uxf/UxfPackage.js');
      const mergedPkg = UxfPackage.create({ description: 'consolidated' });
      const successfullyMergedCids: string[] = [];

      for (const cid of sourceCids) {
        try {
          const encryptedCar = await this.fetchCar(cid);
          const carBytes = await decryptProfileValue(this.encryptionKey, encryptedCar);
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

      // Step 6: export, encrypt, pin
      const consolidatedCar = await mergedPkg.toCar();
      const encryptedCar = await encryptProfileValue(this.encryptionKey, consolidatedCar);
      const consolidatedCid = await this.pinCar(encryptedCar);

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
   */
  private async listAllBundles(): Promise<Map<string, UxfBundleRef>> {
    const rawEntries = await this.db.all(BUNDLE_KEY_PREFIX);
    const result = new Map<string, UxfBundleRef>();

    for (const [key, value] of rawEntries) {
      const cid = key.slice(BUNDLE_KEY_PREFIX.length);
      try {
        const decrypted = await decryptProfileValue(this.encryptionKey, value);
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
   * Write a bundle ref to OrbitDB (encrypted).
   */
  private async addBundle(cid: string, ref: UxfBundleRef): Promise<void> {
    const serialized = new TextEncoder().encode(JSON.stringify(ref));
    const encrypted = await encryptProfileValue(this.encryptionKey, serialized);
    await this.db.put(BUNDLE_KEY_PREFIX + cid, encrypted);
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
  // Private: IPFS CAR helpers (duplicated from ProfileTokenStorageProvider)
  // ---------------------------------------------------------------------------

  /**
   * Pin an encrypted CAR file to IPFS and return the CID.
   */
  private async pinCar(encryptedCarBytes: Uint8Array): Promise<string> {
    const gatewayUrl = this.ipfsGateways[0] ?? DEFAULT_IPFS_API_URL;
    const url = `${gatewayUrl.replace(/\/$/, '')}/api/v0/dag/put`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      body: encryptedCarBytes,
    });

    if (!response.ok) {
      throw new ProfileError(
        'ORBITDB_WRITE_FAILED',
        `IPFS pin failed: HTTP ${response.status} ${response.statusText}`,
      );
    }

    const result = (await response.json()) as { Cid?: { '/': string }; Hash?: string };
    const cid = result.Cid?.['/'] ?? result.Hash;
    if (!cid) {
      throw new ProfileError(
        'ORBITDB_WRITE_FAILED',
        'IPFS pin response did not contain a CID',
      );
    }

    return cid;
  }

  /**
   * Fetch an encrypted CAR file from IPFS by CID.
   * Tries each configured gateway in order until one succeeds.
   */
  private async fetchCar(cid: string): Promise<Uint8Array> {
    const gateways =
      this.ipfsGateways.length > 0 ? this.ipfsGateways : [DEFAULT_IPFS_API_URL];

    let lastError: Error | null = null;

    for (const gateway of gateways) {
      try {
        const url = `${gateway.replace(/\/$/, '')}/ipfs/${cid}`;
        const response = await fetch(url, {
          headers: { Accept: 'application/octet-stream' },
        });

        if (!response.ok) {
          lastError = new Error(`HTTP ${response.status} from ${gateway}`);
          continue;
        }

        const buffer = await response.arrayBuffer();
        return new Uint8Array(buffer);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw new ProfileError(
      'BUNDLE_NOT_FOUND',
      `Failed to fetch CAR ${cid} from all gateways: ${lastError?.message ?? 'unknown error'}`,
    );
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
