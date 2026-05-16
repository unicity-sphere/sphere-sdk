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
 * # No-data flush (cross-device sync resilience)
 *
 * `scheduleFlushNoData()` arms the same debounce timer but signals the
 * flush body to source bytes from `lastLoadedData` (the merged
 * post-load state) when `pendingData` is null. Use case: when
 * `handleReplication` detects a NEW remote bundle, the local OrbitDB
 * log now reflects state our previously-published pointer doesn't.
 * Anchoring our own pointer at the merged state ensures Device C
 * joining via the aggregator pointer sees the full union when both
 * Device A and Device B contributed bundles.
 *
 * The flush body short-circuits before pin + publish when the CAR's
 * CID equals `lastDiscoveredPointerCid` (the authoritative pointer is
 * already anchored at this exact bytes; B re-publishing version V2
 * would be gratuitous churn).
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
 *   - `pendingData`, `flushTimer`, `flushPromise`, `lastPinnedCid`,
 *     `lastDiscoveredPointerCid` — owned by the scheduler but stored
 *     on the facade so `load()` and `shutdown()` can observe / cancel
 *     the in-flight flush, and so the lifecycle's pointer recovery /
 *     poll paths can publish the latest discovered CID.
 *   - `isShuttingDown` — read to skip consolidation + scheduling on
 *     shutdown.
 *
 * @module profile/profile-token-storage/flush-scheduler
 */

import { pinToIpfs } from '../ipfs-client.js';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from '@noble/hashes/sha2.js';
import { create as createMultihash } from 'multiformats/hashes/digest';
import type { UxfBundleRef } from '../types.js';
import type { BundleIndex } from './bundle-index.js';
import type { LifecycleManager } from './lifecycle-manager.js';
import type { ProfileTokenStorageHost } from './host.js';
import type { TxfStorageDataBase } from '../../storage/storage-provider.js';

/**
 * Error code emitted when the runtime pointer-monotonicity assertion
 * fires. The flush is aborted before pin + publish; the operator-alert
 * event is emitted with the missing token IDs so monitoring can surface
 * the regression. Exported so consumers/tests can reference the literal.
 */
export const POINTER_MONOTONICITY_VIOLATION = 'POINTER_MONOTONICITY_VIOLATION';

export class FlushScheduler {
  /**
   * Set when `scheduleFlushNoData()` arms a flush in the absence of
   * pending local data. The flush body reads this flag to decide
   * whether to source the CAR from `lastLoadedData` (merged
   * post-load state) instead of `pendingData`. The flag is cleared
   * inside `flushToIpfs()` after the snapshot is captured (analogous
   * to how `pendingData` is cleared after capture).
   */
  private noDataFlushPending = false;

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
      this.startSerializedFlush('save');
    }, this.host.flushDebounceMs);
    this.host.setFlushTimer(timer);
  }

  /**
   * Arm a flush in the absence of pending local data. Used by
   * `handleReplication()` to anchor our own pointer at the merged
   * post-load state when remote bundles arrive via OrbitDB pubsub.
   *
   * If a normal `scheduleFlush()` is already armed (or about to be —
   * the debounce timer is non-null), this just sets the flag and
   * lets the existing timer fire; the flush body will read the flag
   * and source from `lastLoadedData`.
   *
   * If no timer is armed, this arms one identical to `scheduleFlush()`.
   */
  scheduleFlushNoData(): void {
    if (this.host.getIsShuttingDown()) return;

    this.noDataFlushPending = true;

    // If a timer is already armed (because of a concurrent save()),
    // don't re-arm — let it fire. The flushToIpfs body will read
    // both `pendingData` and the no-data flag and merge.
    if (this.host.getFlushTimer() !== null) return;

    // Otherwise arm a fresh timer. Same plumbing as scheduleFlush so
    // load() / shutdown() observers see the in-flight flushPromise
    // identically to a save-driven flush.
    const timer = setTimeout(() => {
      this.host.setFlushTimer(null);
      this.startSerializedFlush('no-data');
    }, this.host.flushDebounceMs);
    this.host.setFlushTimer(timer);
  }

  /**
   * Wrap a `flushToIpfs()` call in the chain barrier + identity-checked
   * finally clear that scheduleFlush() and scheduleFlushNoData() both
   * need.
   *
   * # Why serialize flushes (PR #127 follow-up — partial-CAR race fix)
   *
   * Without serialization, two `flushToIpfs()` calls can run in parallel
   * — the older one captures `pendingData_1`, the newer captures
   * `pendingData_2`, and both proceed to pinning + publish. The
   * aggregator's per-wallet publish mutex serializes the publishes in
   * mutex-acquisition order, NOT capture order. A slower-pinning OLDER
   * flush can publish AFTER a faster-pinning NEWER flush, putting the
   * older (partial) CAR behind the higher pointer version. A remote
   * device joining via `recoverLatest()` then walks to that higher
   * version, fetches the partial CAR, and silently misses tokens that
   * lived only in the newer save.
   *
   * Mode-A's monotonicity assertion (b5d347e) is defense-in-depth, but
   * does NOT cover the inversion: it reads `lastLoadedData` BEFORE pin
   * + publish, so at check-time the older flush's view of
   * `lastLoadedData` is still the older state — the check passes — and
   * by the time the older flush actually publishes, the newer flush
   * has already overtaken it on the aggregator.
   *
   * Serializing flushes guarantees publish order matches save order:
   * older save → older flush → older publish → smaller version. Newer
   * save → newer flush → newer publish → larger version with a CAR
   * that is byte-for-byte at-least-as-recent as anything below. The
   * latest pointer is always the freshest CAR; intermediate versions
   * remain partial by design (each save → snapshot of that point in
   * time), which is fine — `recoverLatest()` always walks to the top.
   *
   * # Mechanics
   *
   * - `previous = getFlushPromise() ?? Promise.resolve()` reads the
   *   current in-flight flush as the chain anchor. If no flush is in
   *   flight, the chain starts immediately.
   * - `previous.catch(() => {})` swallows the prior flush's rejection
   *   so a single failure does not stall every queued flush. Errors
   *   are still surfaced — each flush has its own catch arm below.
   * - `.then(() => this.flushToIpfs())` is what enforces ordering: the
   *   new flush only starts after the previous chain settles.
   * - The boxed `.finally` identity check prevents an older flush's
   *   completion handler from clobbering the host's `flushPromise`
   *   when a newer flush has already replaced it (Steelman³⁸).
   *   Steelman⁴⁶ is preserved: `flushBox.ref` is assigned synchronously
   *   after the chain is built and BEFORE the `.finally` microtask can
   *   run.
   */
  private startSerializedFlush(mode: 'save' | 'no-data'): void {
    const previous = this.host.getFlushPromise() ?? Promise.resolve();
    const flushBox: { ref: Promise<void> | null } = { ref: null };
    const myFlush: Promise<void> = previous
      .catch(() => {
        // Prior flush already surfaced its error via its own catch arm.
        // Don't propagate — we want our flush to run regardless.
      })
      .then(() => this.flushToIpfs())
      .catch((err) => {
        const prefix = mode === 'no-data' ? 'Flush (no-data) failed' : 'Flush failed';
        this.host.log(`${prefix}: ${err instanceof Error ? err.message : String(err)}`);
        this.host.emitEvent(this.host.buildErrorEvent('storage:error', err));
      })
      .finally(() => {
        if (this.host.getFlushPromise() === flushBox.ref) {
          this.host.setFlushPromise(null);
        }
      });
    flushBox.ref = myFlush;
    this.host.setFlushPromise(myFlush);
  }

  /**
   * Run a single flush of the pending data: extract tokens and
   * operational state, build a UXF package, pin the CAR, write the
   * bundle ref, persist operational state, and publish the CID to the
   * aggregator pointer layer.
   *
   * No-data flush mode (Fix 2 of cross-device sync): if `pendingData`
   * is null but `noDataFlushPending` is set, source the CAR from
   * `lastLoadedData` (the merged post-load state). Skip pin + publish
   * if the resulting CID equals `lastDiscoveredPointerCid` (the
   * authoritative pointer already anchored this exact bytes — e.g.,
   * the remote originator already published while we were merging).
   */
  async flushToIpfs(): Promise<void> {
    const encryptionKey = this.host.getEncryptionKey();
    if (!encryptionKey) return;

    // Capture and clear the no-data flag immediately so a concurrent
    // scheduleFlushNoData() doesn't get masked by this flush in flight.
    const noDataMode = this.noDataFlushPending;
    this.noDataFlushPending = false;

    let data = this.host.getPendingData();

    // No-data flush: source from lastLoadedData when pendingData is
    // null. If lastLoadedData is also null, there's nothing to anchor
    // — silently no-op.
    if (!data && noDataMode) {
      const merged = this.host.getLastLoadedData();
      if (!merged) {
        this.host.log(
          'Flush (no-data): no lastLoadedData to anchor, skipping',
        );
        return;
      }
      data = merged;
    }

    if (!data) return;

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

      // Diagnostic at debug-level: token count + per-coinId histogram +
      // flush mode. Useful for investigating cross-device-sync issues
      // where a flush captures partial state. The original PR #127
      // partial-CAR cause (concurrent flushToIpfs() calls publishing
      // their CARs out of capture order, putting an older partial CAR
      // behind a higher pointer version) is now closed by the
      // serialization in startSerializedFlush(). The diagnostic stays
      // in as a permanent debug tool — useful for catching any future
      // regression where save and no-data sources diverge. Run with
      // DEBUG=Profile-TokenStorage or equivalent to surface.
      const tokenCoinIds = tokenValues
        .map((t) => {
          const tok = t as {
            genesis?: { data?: { coinData?: ReadonlyArray<readonly [string, string]> } };
            coinData?: ReadonlyArray<readonly [string, string]>;
          };
          const c = tok.genesis?.data?.coinData ?? tok.coinData;
          if (!c || c.length === 0) return '∅';
          return String(c[0]?.[0] ?? '').slice(-6);
        })
        .sort();
      const counts: Record<string, number> = {};
      for (const id of tokenCoinIds) counts[id] = (counts[id] ?? 0) + 1;
      const histogram = Object.entries(counts)
        .map(([id, n]) => `${id}×${n}`)
        .sort()
        .join(' ');
      this.host.log(
        `flushToIpfs: ${tokenValues.length} tokens {${histogram}} noDataMode=${noDataMode}`,
      );

      // 3. Export to CAR (unencrypted — see class doc)
      const carBytes = await pkg.toCar();

      // 3a. No-data flush idempotency: compute the locally-deterministic
      //     CID for the about-to-pin bytes and short-circuit if either
      //     (a) the aggregator pointer has already anchored these exact
      //     bytes (set by lifecycle on cold-start / poll / publish), or
      //     (b) the OrbitDB bundle index already has this CID active
      //     (our previous flush already pinned it).
      //
      //     The match in (a) is the central defense against gratuitous
      //     re-publish when Device A originated the bundle and Device B
      //     receives it, merges, and would otherwise pay the IPFS pin +
      //     aggregator submit cost just to re-anchor the same bytes
      //     under a higher version number.
      //
      //     A normal save-driven flush keeps publishing because the CAR
      //     bytes change with every token mutation; this short-circuit
      //     only fires when the merged-state CAR happens to be byte-
      //     identical to a known anchor.
      if (noDataMode) {
        const projectedCid = CID.createV1(
          raw.code,
          createMultihash(0x12, sha256(carBytes)),
        ).toString();
        const knownDiscovered = this.host.getLastDiscoveredPointerCid();
        if (knownDiscovered === projectedCid) {
          this.host.log(
            `Flush (no-data) short-circuit: merged-state CID ${projectedCid} ` +
              `equals authoritative pointer; skipping pin + publish`,
          );
          return;
        }
        try {
          const activeBundles = await this.bundleIndex.listActiveBundles();
          if (activeBundles.has(projectedCid)) {
            this.host.log(
              `Flush (no-data) short-circuit: merged-state CID ${projectedCid} ` +
                `already in OrbitDB bundle index; skipping pin + publish`,
            );
            return;
          }
        } catch {
          // listActiveBundles is best-effort here — if it fails, fall
          // through to the normal pin path. A stale CID in OrbitDB is
          // self-correcting (next consolidation pass merges it).
        }
      }

      // 3b. POINTER MONOTONICITY ASSERTION (defense-in-depth).
      //
      //     Invariant: the published pointer V_n MUST reference a CAR
      //     that contains every token reachable from V_n-1's CARs. A
      //     violation means a cross-device sync race or a partial save()
      //     produced a flush that would silently drop tokens on cold-
      //     start recovery from the aggregator pointer.
      //
      //     We check two independent failure surfaces:
      //
      //     (i) TOKEN-SET CHECK: the new flush's data MUST contain every
      //         token id present in `lastLoadedData` (the most recent
      //         merge across active bundles). Catches a partial save()
      //         that dropped tokens from the in-memory state. Skipped
      //         when `lastLoadedData === data` (typical save-driven
      //         flush, where save() set `lastLoadedData = data`) or when
      //         `lastLoadedData` is null (no V_n-1 baseline).
      //
      //     (ii) BUNDLE-SET CHECK: the OrbitDB active bundle index MUST
      //          NOT contain any CID that was NOT merged into the
      //          current `lastLoadedData`. If unknown bundles appeared
      //          since the last successful load(), the flush's source
      //          state is stale and the new CAR would silently drop the
      //          unknown bundles' tokens from V_n. The about-to-pin CID
      //          is allowed to be missing from the snapshot (the new
      //          flush is itself V_n's bundle).
      //
      //     Mode A fix #2 (handleReplication awaits load() before
      //     scheduling) keeps the baseline fresh; this assertion is
      //     defense-in-depth that catches future regressions and edge
      //     cases (e.g., a partial save() bug from PaymentsModule, or
      //     a slow load() that doesn't complete before the flush fires).
      //
      //     The check is in-memory only — no extra IPFS round-trips
      //     except the bundleIndex listActiveBundles() which we already
      //     call below for cached-CID validation.
      const previousData = this.host.getLastLoadedData();

      // (i) Token-set check.
      const tokenMissing: string[] = [];
      if (previousData && previousData !== data) {
        const previousTokens = this.host.extractTokensFromTxfData(previousData);
        for (const tokenId of previousTokens.keys()) {
          if (!tokens.has(tokenId)) tokenMissing.push(tokenId);
        }
      }

      // (ii) Bundle-set check. The set of CIDs that load() merged into
      //      lastLoadedData is captured by `lastLoadedFromBundleCids`.
      //      Compare against the current active bundle index — any CID
      //      in the index that's NOT in the loaded snapshot AND NOT the
      //      about-to-pin CID is a stale-baseline indicator.
      const loadedBundleCids = this.host.getLastLoadedFromBundleCids();
      const unknownBundleCids: string[] = [];
      if (loadedBundleCids !== null) {
        try {
          const activeBundles = await this.bundleIndex.listActiveBundles();
          for (const cid of activeBundles.keys()) {
            if (!loadedBundleCids.has(cid)) {
              unknownBundleCids.push(cid);
            }
          }
        } catch (err) {
          // Best-effort: if listActiveBundles fails we cannot run this
          // check. Log and proceed — the token-set check still gates
          // the partial-save() failure mode, and the next flush will
          // re-attempt the bundle check.
          this.host.log(
            `Pointer monotonicity bundle-set check skipped (listActiveBundles failed): ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (tokenMissing.length > 0 || unknownBundleCids.length > 0) {
        const reasonParts: string[] = [];
        if (tokenMissing.length > 0) {
          reasonParts.push(
            `would drop ${tokenMissing.length} token(s) from baseline ` +
              `(${tokenMissing.slice(0, 10).join(', ')}${tokenMissing.length > 10 ? ', ...' : ''})`,
          );
        }
        if (unknownBundleCids.length > 0) {
          reasonParts.push(
            `${unknownBundleCids.length} unknown bundle(s) in OrbitDB not in baseline ` +
              `(${unknownBundleCids.slice(0, 5).join(', ')}${unknownBundleCids.length > 5 ? ', ...' : ''})`,
          );
        }
        const violation = new Error(
          `Pointer monotonicity violation: ${reasonParts.join('; ')}. ` +
            `Aborting publish to prevent silent token loss across cross-device sync.`,
        );
        (violation as Error & { code?: string }).code = POINTER_MONOTONICITY_VIOLATION;
        this.host.log(`[POINTER_MONOTONICITY_VIOLATION] aborting publish: ${reasonParts.join('; ')}`);

        // The catch block at the bottom of flushToIpfs() re-queues
        // `data` so the user's writes are not lost; subsequent
        // flushes will re-evaluate once lastLoadedData refreshes.
        // Surface to operators via storage:error AND a structured
        // alert so monitoring dashboards can fire on the literal code.
        this.host.emitEvent(
          this.host.buildErrorEvent(
            'storage:error',
            violation,
            POINTER_MONOTONICITY_VIOLATION,
          ),
        );
        this.host.emitEvent({
          type: 'storage:error',
          timestamp: Date.now(),
          code: POINTER_MONOTONICITY_VIOLATION,
          error: violation.message,
          data: {
            alert: 'transfer:operator-alert',
            missingTokenIds: tokenMissing.slice(0, 100),
            missingTokenCount: tokenMissing.length,
            unknownBundleCids: unknownBundleCids.slice(0, 100),
            unknownBundleCount: unknownBundleCids.length,
            truncated:
              tokenMissing.length > 100 || unknownBundleCids.length > 100,
          },
        });
        throw violation;
      }

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

      // 6a. Pointer-monotonicity invariant maintenance: a bundle this
      //     flush just added is, by construction, "loaded" — its tokens
      //     are precisely what we built the CAR from. Including it in
      //     `lastLoadedFromBundleCids` prevents the next save-driven
      //     flush from flagging it as an unknown remote bundle (which
      //     would block publish with POINTER_MONOTONICITY_VIOLATION
      //     even though the bundle is the originator's own state).
      //     Without this maintenance, every save→flush after the
      //     first establishes a false-positive baseline drift.
      const loadedBundleCidsForUpdate = this.host.getLastLoadedFromBundleCids();
      if (loadedBundleCidsForUpdate !== null) {
        loadedBundleCidsForUpdate.add(cid);
      }

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
