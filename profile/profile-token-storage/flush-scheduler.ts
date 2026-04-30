/**
 * FlushScheduler
 *
 * Owns the write-behind buffer mechanics for `ProfileTokenStorageProvider`:
 *   - debounce timer (`flushTimer`) that coalesces rapid `save()` calls
 *   - in-flight flush promise (`flushPromise`) so concurrent `load()` /
 *     `shutdown()` paths can await the active flush
 *   - last-pinned CID cache (`lastPinnedCid`) used to avoid duplicate
 *     IPFS pins on retry
 *
 * The actual flush body extracts tokens + operational state from the
 * pending `TxfStorageDataBase`, builds a `UxfPackage`, pins the CAR,
 * writes the bundle ref, and publishes the CID to the aggregator
 * pointer layer.
 *
 * Cross-seam dependencies:
 *   - `BundleIndex.listActiveBundles` — sanity-check that the cached
 *     `lastPinnedCid` is still active before reusing it.
 *   - `BundleIndex.addBundle` — write the freshly pinned CID.
 *   - `BundleIndex.shouldConsolidate` — gate the consolidation pass.
 *   - `LifecycleManager.publishAggregatorPointerBestEffort` — anchor
 *     the CID for cold-start recovery.
 *   - Host helpers (`extractTokensFromTxfData`,
 *     `extractOperationalState`, `writeOrbitOperationalState`,
 *     `writeLocalDerivedCache`) — facade-owned utilities that the
 *     flush body invokes via the host interface.
 *
 * Cross-seam shared state plumbed via the host:
 *   - `pendingData`, `flushTimer`, `flushPromise`, `lastPinnedCid` —
 *     owned by the scheduler but stored on the facade so `load()` and
 *     `shutdown()` can observe / cancel the in-flight flush.
 *   - `isShuttingDown` — read to skip consolidation + scheduling on
 *     shutdown.
 *
 * @module profile/profile-token-storage/flush-scheduler
 */

import { pinToIpfs } from '../ipfs-client.js';
import type { UxfBundleRef } from '../types.js';
import type { BundleIndex } from './bundle-index.js';
import type { LifecycleManager } from './lifecycle-manager.js';
import type { ProfileTokenStorageHost } from './host.js';
import type { TxfStorageDataBase } from '../../storage/storage-provider.js';

export class FlushScheduler {
  constructor(
    private readonly host: ProfileTokenStorageHost,
    private readonly bundleIndex: BundleIndex,
    private readonly lifecycle: LifecycleManager,
  ) {}

  /**
   * Arm (or re-arm) the debounce timer. Subsequent `save()` calls
   * within the debounce window coalesce into a single flush.
   */
  scheduleFlush(): void {
    if (this.host.getIsShuttingDown()) return;

    // Clear any existing timer
    const existing = this.host.getFlushTimer();
    if (existing !== null) {
      clearTimeout(existing);
    }

    // Set new debounced timer
    const timer = setTimeout(() => {
      this.host.setFlushTimer(null);
      // Steelman³⁸ warning: identity-check the finally clear so an older
      // flush settling AFTER a newer one was scheduled doesn't clobber
      // the in-flight `flushPromise`. Without the identity check, a
      // subsequent load() reading `if (this.flushPromise)` would see
      // null while the new flush is still running, and read a stale
      // snapshot.
      //
      // Steelman⁴⁶ ordering note: `this.flushPromise = myFlush` MUST
      // be observable before the `.finally` runs, otherwise the
      // identity check would compare against an out-of-date reference.
      // JS semantics guarantee this (sync code in this setTimeout
      // callback completes before any microtask), but the previous
      // arrangement built the .finally chain before the assignment
      // — making the dependency implicit. We now use an outer Promise
      // box that the .finally consults, which makes the invariant
      // explicit and immune to future refactors that might reorder
      // the chain build.
      const flushBox: { ref: Promise<void> | null } = { ref: null };
      const myFlush: Promise<void> = this.flushToIpfs()
        .catch((err) => {
          this.host.log(`Flush failed: ${err instanceof Error ? err.message : String(err)}`);
          this.host.emitEvent(this.host.buildErrorEvent('storage:error', err));
        })
        .finally(() => {
          // Compare against the boxed reference assigned after the
          // chain is built — this fires AFTER the assignment below
          // because .finally is microtask-deferred.
          if (this.host.getFlushPromise() === flushBox.ref) {
            this.host.setFlushPromise(null);
          }
        });
      flushBox.ref = myFlush;
      this.host.setFlushPromise(myFlush);
    }, this.host.flushDebounceMs);
    this.host.setFlushTimer(timer);
  }

  /**
   * Run a single flush of the pending data: extract tokens and
   * operational state, build a UXF package, pin the CAR, write the
   * bundle ref, persist operational state, and publish the CID to the
   * aggregator pointer layer.
   */
  async flushToIpfs(): Promise<void> {
    const data = this.host.getPendingData();
    const encryptionKey = this.host.getEncryptionKey();
    if (!data || !encryptionKey) return;

    // Snapshot and clear pending to avoid re-flushing the same data.
    //
    // Steelman⁴³ critical: identity-check before clearing. A concurrent
    // save() between the capture above and this clear would set
    // this.pendingData to NEWER data; an unconditional `= null` would
    // clobber the new save and permanently lose its content. With the
    // identity check, the new pendingData stays for the next flush.
    if (this.host.getPendingData() === data) {
      this.host.setPendingData(null);
    }

    try {
      // 1. Extract tokens and operational state
      const tokens = this.host.extractTokensFromTxfData(data);
      const opState = this.host.extractOperationalState(data);

      // 2. Build UXF package
      const { UxfPackage } = await import('../../uxf/UxfPackage.js');
      const pkg = UxfPackage.create();

      // Ingest all token objects
      const tokenValues = [...tokens.values()];
      if (tokenValues.length > 0) {
        pkg.ingestAll(tokenValues);
      }

      // 3. Export to CAR (unencrypted — see class doc)
      const carBytes = await pkg.toCar();

      // 4. Pin to IPFS (reuse last pinned CID on retry to avoid duplicate pins)
      //
      // Steelman⁴⁴ warning: re-validate the cached CID still represents
      // the CURRENT bundle state before reuse. A sibling instance may
      // have already pinned a superseding bundle; reusing the stale CID
      // would leave a redundant ref in OrbitDB. Cross-instance check:
      // if a NEWER bundle already exists for this address, abandon the
      // cached CID and pin fresh.
      let cid: string;
      const cachedCid = this.host.getLastPinnedCid();
      let useCachedCid = cachedCid !== null;
      if (useCachedCid && cachedCid !== null) {
        try {
          const activeBundles = await this.bundleIndex.listActiveBundles();
          if (!activeBundles.has(cachedCid)) {
            // Our cached CID is no longer active (superseded by another
            // instance's pin or by consolidation). Re-pin from scratch.
            useCachedCid = false;
            this.host.setLastPinnedCid(null);
          }
        } catch {
          // Best-effort — if we can't validate, fall through to using
          // the cached value. The OrbitDB write will reconcile via
          // CRDT merge.
        }
      }
      const cachedCidNow = this.host.getLastPinnedCid();
      if (useCachedCid && cachedCidNow) {
        cid = cachedCidNow;
      } else {
        cid = await pinToIpfs(this.host.ipfsGateways, carBytes);
        this.host.setLastPinnedCid(cid);
      }

      // 6. Write bundle ref to OrbitDB
      const bundleRef: UxfBundleRef = {
        cid,
        status: 'active',
        createdAt: Math.floor(Date.now() / 1000),
        tokenCount: tokens.size,
      };
      await this.bundleIndex.addBundle(cid, bundleRef);

      // 7. Write operational state:
      //    - synced portion to OrbitDB (outbox, mintOutbox, etc.)
      //    - derived portion to local cache (tombstones, sent, history)
      // The derived-cache write is best-effort. A failure is surfaced
      // via storage:error AND via the boolean return; we log here so
      // flush telemetry records it alongside the CID.
      await this.host.writeOrbitOperationalState(opState);
      const derivedOk = await this.host.writeLocalDerivedCache(opState);
      if (!derivedOk) {
        this.host.log(`Derived-cache write failed; next load will rebuild from pool`);
      }

      // Clear the pinned CID tracker after successful OrbitDB write
      this.host.setLastPinnedCid(null);

      // 8. Check consolidation
      // Steelman³⁸ warning: actually invoke the consolidation engine
      // (it already exists at profile/consolidation.ts) instead of
      // logging "deferred to Phase 2" forever. Bundle count grew
      // unboundedly across daemon lifetime with the previous warn-only
      // behavior; load latency degraded O(1)→O(N).
      //
      // Best-effort: failures are caught and logged but do not block
      // the flush. The consolidation engine has its own concurrent-
      // guard (consolidation.pending key) so multi-device races are
      // safe.
      //
      // Steelman⁴⁰ warning: SKIP consolidation when shutdown is in
      // progress. Consolidation does multiple unbounded IPFS round-trips
      // (fetch + pin) which would block shutdown for minutes per N
      // bundles. Without this gate, F.43's shutdown-await-flushPromise
      // could hold up to (N × per-gateway timeout) before completing.
      if (this.host.getIsShuttingDown()) {
        this.host.log('Consolidation skipped: shutdown in progress');
      } else if (await this.bundleIndex.shouldConsolidate()) {
        try {
          const { ConsolidationEngine } = await import('../consolidation.js');
          const engine = new ConsolidationEngine(
            this.host.db,
            encryptionKey,
            this.host.ipfsGateways,
          );
          if (!(await engine.isConsolidationInProgress())) {
            const result = await engine.consolidate();
            if (result.consolidated) {
              this.host.log(
                `Consolidation: merged ${result.sourceBundleCount} bundles → ${result.consolidatedCid ?? 'n/a'}`,
              );
            } else {
              this.host.log('Consolidation skipped (engine no-op)');
            }
          } else {
            this.host.log('Consolidation skipped: another device is in progress');
          }
        } catch (err) {
          // Best-effort: do not fail the flush on consolidation error.
          this.host.log(
            `Consolidation failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // 9. Publish to the pointer layer for cold-start recovery.
      //    Best-effort: the CAR is already pinned and the OrbitDB
      //    bundle ref is already written, so a failed publish only
      //    delays cold-start recovery for this flush — subsequent
      //    flushes retry. IPNS is no longer published (T-D6c) —
      //    the one-shot migration reader is the only remaining
      //    legacy touchpoint and it's read-only.
      await this.lifecycle.publishAggregatorPointerBestEffort(cid);

      this.host.emitEvent({
        type: 'storage:saved',
        timestamp: Date.now(),
        data: { cid, tokenCount: tokens.size },
      });
    } catch (err) {
      // On failure, re-queue the data so it is not lost
      if (!this.host.getPendingData()) {
        this.host.setPendingData(data);
      }
      throw err;
    }
  }

  /**
   * Update the pending-data buffer and arm the debounce timer. Called
   * by the facade's `save()` after validation. The buffer cache (and
   * `lastLoadedData`) bookkeeping happens on the facade so byte-
   * identical fields stay in their original location.
   */
  enqueueSave(data: TxfStorageDataBase): void {
    // Any new save() invalidates the lastPinnedCid retry cache
    // unconditionally. A reference-identity check is insufficient: a
    // caller that mutates the same object in place and re-calls save()
    // would otherwise leave a stale CID pinned. The only safe policy
    // is "fresh save → re-pin from scratch". The tiny cost (one extra
    // pin on legitimate retries with identical content) is worth the
    // correctness guarantee that the pinned CID always matches the
    // currently flushed bytes.
    this.host.setLastPinnedCid(null);
    this.host.setPendingData(data);
    this.scheduleFlush();
  }
}
