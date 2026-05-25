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

// Issue #213 (Option C) restored hierarchical per-block pinning:
// `uxf/ipld.ts:elementToIpldBlock` now emits sub-block bytes in the
// same canonical form used for content hashing, so
// `sha256(blockBytes) === blockCid.multihash.digest` holds and Kubo's
// `dag/put` pins each sub-block under exactly the CID we publish in
// the manifest. Bundle CARs go back to dag-cbor envelopes pinned
// block-by-block via `pinCarBlocksToIpfs`; per-block IPFS dedup is
// restored, closing the byte-cost-per-token-mutation regression
// introduced by the #212 monolithic-raw interim.
import { fetchCarFromIpfs, pinCarBlocksToIpfs } from '../ipfs-client.js';
import { extractCarRootCid } from '../../uxf/transfer-payload.js';
import type {
  ProfileSnapshotPublishResult,
  UxfBundleRef,
} from '../types.js';
import type { BundleIndex } from './bundle-index.js';
import type { ProfileTokenStorageHost } from './host.js';
import type { TxfStorageDataBase } from '../../storage/storage-provider.js';

/**
 * Issue #264 — historical compatibility constant.
 *
 * The runtime pointer-monotonicity check originally aborted the flush
 * and emitted this code on `storage:error` when either the token-set or
 * bundle-set invariant failed. Post-#264 the same conditions are
 * auto-recovered in place (see {@link POINTER_MONOTONICITY_RECOVERED}):
 *   - `tokenMissing` is healed by re-merging the missing TXF entries
 *     from the last-loaded baseline (`previousData`) back into the
 *     in-flight UXF package and re-exporting the CAR. Operational state
 *     is unioned with the SENT-wins-over-OUTBOX rule so the
 *     per-entry-key OrbitDB write does not tombstone live entries that
 *     are present in the baseline but absent from this flush's `data`.
 *   - `unknownBundleCids` is healed inline by fetching each foreign
 *     CAR and merging it into `pkg` (the #255 / PR #262 behavior). If
 *     the fetch fails for some subset, this is now logged at warn-level
 *     and the flush proceeds with whatever superset it managed to
 *     assemble — eventual convergence happens via subsequent
 *     cross-device syncs detecting the same residual.
 *
 * The constant is still exported so test suites and operator tooling
 * that pattern-match on the literal continue to compile, but it is no
 * longer emitted on the auto-merge path. The throw path is preserved
 * only for the truly-unrecoverable case where `previousData === null`
 * AND every unknown-bundle inline fetch failed AND the token-set check
 * had no source to recover from — i.e., no signal at all. Even then the
 * flush body does NOT throw; it logs warn-level and continues so the
 * at-least-once gate isn't held closed by metadata-layer transients.
 */
export const POINTER_MONOTONICITY_VIOLATION = 'POINTER_MONOTONICITY_VIOLATION';

/**
 * Issue #264 — emitted on `storage:monotonicity-recovered` when the
 * flush body auto-merges a detected monotonicity gap in place. Distinct
 * from `storage:error` so operators see auto-merges as routine
 * convergence work, not alarms.
 *
 * Payload (see flush-scheduler emit site):
 *   - `recoveredTokenIds`: token ids re-merged from `previousData` to
 *     satisfy the token-set invariant (capped at 100 for log volume).
 *   - `mergedUnknownBundleCids`: foreign bundle CIDs inline-fetched and
 *     merged into `pkg` (capped at 100).
 *   - `residualUnknownBundleCids`: foreign bundle CIDs that could not
 *     be fetched (network down, malformed CAR, etc.) — the flush
 *     continued without them; downstream convergence retries on the
 *     next flush.
 *   - `recoveredOutboxIdsDroppedAsSent`: outbox-entry ids that the
 *     SENT-wins dedup removed during the opState union.
 */
export const POINTER_MONOTONICITY_RECOVERED = 'POINTER_MONOTONICITY_RECOVERED';

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Lightweight projection of `OperationalState` arrays for the SENT-wins
 * union helper. The flush body reads/writes the actual OperationalState
 * shape via the host facade; this shape is just the loose subset we need
 * to reason about during the merge.
 */
export type OpStateArrays = {
  tombstones: unknown[];
  outbox: unknown[];
  sent: unknown[];
  invalid: unknown[];
  history: unknown[];
  mintOutbox: unknown[];
  invalidatedNametags: unknown[];
  audit: unknown[];
  finalizationQueue: unknown[];
};

/**
 * Issue #264 — union two OperationalState array sets with the
 * SENT-wins-over-OUTBOX dedup rule. Used by the flush-scheduler's
 * tokenMissing auto-merge so the per-entry-key OrbitDB write does NOT
 * tombstone live entries that exist in `previousOp` but were not
 * carried in this flush's in-memory `currentOp`.
 *
 * # Amplification-minimal contract (steelman fix)
 *
 * The naive union — "current ∪ previous" — re-emits EVERY previous
 * entry through the per-entry-key writer. Because `writeProfileKey`
 * encrypts each value with a fresh random IV (see
 * `profile/encryption.ts:encryptProfileValue`), every re-emit lands a
 * NEW OrbitDB OpLog row even when the plaintext is byte-identical to
 * the on-disk record. Under sustained cross-device replication churn
 * this would inflate the OpLog by O(previous-size) per recovery cycle.
 *
 * The amplification-minimal contract: `merged.outbox` (etc.) MUST
 * contain every entry from `currentOp` PLUS only those entries from
 * `previousOp` whose id is NOT in `currentOp`. The diff in
 * `writeOrbitOperationalStatePerEntry` writes every entry in
 * `merged`; by minimising the previous-only fill-in to the entries
 * that current is actually missing, we (a) preserve the original
 * "current wins on collision" semantic at zero extra cost, and
 * (b) bound the OpLog amplification to the smallest possible set —
 * the entries that current would otherwise have the writer tombstone
 * by omission.
 *
 * Steelman-residual: writes for entries that ARE in `currentOp` still
 * produce fresh ciphertext because the writer does not plaintext-
 * compare existing values. That amplification exists pre-#264 and is
 * a writer-layer concern out of scope for this issue (tracked in
 * follow-ups to the per-entry diff).
 *
 * Per-collection semantics:
 *   - `outbox`, `sent`, `audit`, `finalizationQueue`: union by
 *     `entry.id` (UxfTransferOutboxEntry / UxfSentLedgerEntry share the
 *     stable transferId as `.id`); current wins on id collision (i.e.
 *     entries from previous with the same id are dropped).
 *   - `outbox` then gets the SENT-wins filter applied: any outbox entry
 *     whose `id` matches a SENT entry's `id` is dropped — the
 *     transition outbox→sent is terminal and the OUTBOX residue should
 *     not be resurrected when we union with the baseline. The dropped
 *     outbox ids are returned so the flush body can surface them on
 *     the `storage:monotonicity-recovered` event for operator audit.
 *   - `tombstones`, `invalid`, `mintOutbox`, `invalidatedNametags`,
 *     `history`: union by `entry.tokenId` when present, else dedup by
 *     JSON serialization (best-effort; these collections are append-
 *     only by construction so duplicates are rare and tolerable).
 *
 * The helper does not parse the inner entry shapes beyond reading
 * `id` / `tokenId`; richer fields ride through opaquely. This keeps it
 * forward-compatible with `T.1.E` composite-key tokenIds and any
 * future per-entry fields.
 */
export function unionOpStateWithSentWins(
  currentOp: OpStateArrays,
  previousOp: OpStateArrays,
): { merged: OpStateArrays; droppedOutboxIds: string[] } {
  function readId(entry: unknown): string | undefined {
    if (!entry || typeof entry !== 'object') return undefined;
    const id = (entry as { id?: unknown }).id;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  }
  function readTokenId(entry: unknown): string | undefined {
    if (!entry || typeof entry !== 'object') return undefined;
    const id = (entry as { tokenId?: unknown }).tokenId;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  }

  function unionById(
    current: ReadonlyArray<unknown>,
    previous: ReadonlyArray<unknown>,
  ): unknown[] {
    // Amplification-minimal: emit every current entry, then ONLY the
    // previous entries whose id is not already in current. Entries
    // shared by both are written once (from current), not twice. This
    // keeps the per-entry-key write count at `|current| + |previous-only|`
    // instead of `|current ∪ previous|` doubling for shared ids.
    const currentIds = new Set<string>();
    const result: unknown[] = [];
    const previousNoId: unknown[] = [];
    for (const e of current) {
      result.push(e);
      const id = readId(e);
      if (id !== undefined) currentIds.add(id);
    }
    for (const e of previous) {
      const id = readId(e);
      if (id === undefined) {
        // No id → cannot dedup against current; treat as a separate
        // record (the writer will JSON-stringify the full opState
        // collection for non-per-entry stores like history).
        previousNoId.push(e);
        continue;
      }
      if (!currentIds.has(id)) {
        // Fill-in: current is missing this id, so the per-entry diff
        // would otherwise tombstone the on-disk record. Preserve it.
        result.push(e);
      }
      // else: id is in current — current already wrote (or will write)
      // a value for this id. Skip the previous version (would amplify
      // OpLog with a redundant write).
    }
    return [...result, ...previousNoId];
  }

  function unionByTokenIdOrJson(
    current: ReadonlyArray<unknown>,
    previous: ReadonlyArray<unknown>,
  ): unknown[] {
    // Amplification-minimal variant for collections persisted as a
    // single JSON blob (tombstones, invalidatedNametags, history): we
    // still want to dedup by `tokenId` when present, but only ADD
    // previous's entries that current is missing. Same rationale as
    // `unionById`: current's values are authoritative; previous is
    // only used as a fill-in source.
    const currentTokenIds = new Set<string>();
    const currentJsonKeys = new Set<string>();
    const result: unknown[] = [];
    for (const e of current) {
      result.push(e);
      const tid = readTokenId(e);
      if (tid !== undefined) {
        currentTokenIds.add(tid);
      } else {
        try {
          currentJsonKeys.add(JSON.stringify(e));
        } catch {
          // Non-serializable: cannot dedup, but it's already in result
          // so the consumer sees it once.
        }
      }
    }
    for (const e of previous) {
      const tid = readTokenId(e);
      if (tid !== undefined) {
        if (!currentTokenIds.has(tid)) result.push(e);
        continue;
      }
      // No tokenId in previous entry: dedup against current's JSON keys.
      try {
        const json = JSON.stringify(e);
        if (!currentJsonKeys.has(json)) {
          result.push(e);
          currentJsonKeys.add(json);
        }
      } catch {
        // Non-serializable previous entry: defensive append (can't
        // dedup against current; better to over-include than to drop
        // a tombstone or invalid record silently).
        result.push(e);
      }
    }
    return result;
  }

  const mergedSent = unionById(currentOp.sent, previousOp.sent);
  const mergedAudit = unionById(currentOp.audit, previousOp.audit);
  const mergedFinalizationQueue = unionById(
    currentOp.finalizationQueue,
    previousOp.finalizationQueue,
  );
  let mergedOutbox = unionById(currentOp.outbox, previousOp.outbox);

  // SENT-wins-over-OUTBOX dedup. The id space is shared between
  // OutboxEntry and UxfSentLedgerEntry (the SENT entry reuses the
  // outbox transferId as its primary key), so an outbox entry whose id
  // matches a SENT entry's id is the residue of a transition that has
  // already moved to terminal success — drop it.
  const sentIds = new Set<string>();
  for (const e of mergedSent) {
    const id = readId(e);
    if (id !== undefined) sentIds.add(id);
  }
  const droppedOutboxIds: string[] = [];
  if (sentIds.size > 0) {
    mergedOutbox = mergedOutbox.filter((e) => {
      const id = readId(e);
      if (id !== undefined && sentIds.has(id)) {
        droppedOutboxIds.push(id);
        return false;
      }
      return true;
    });
  }

  return {
    merged: {
      tombstones: unionByTokenIdOrJson(currentOp.tombstones, previousOp.tombstones),
      outbox: mergedOutbox,
      sent: mergedSent,
      invalid: unionByTokenIdOrJson(currentOp.invalid, previousOp.invalid),
      history: unionByTokenIdOrJson(currentOp.history, previousOp.history),
      mintOutbox: unionByTokenIdOrJson(currentOp.mintOutbox, previousOp.mintOutbox),
      invalidatedNametags: unionByTokenIdOrJson(
        currentOp.invalidatedNametags,
        previousOp.invalidatedNametags,
      ),
      audit: mergedAudit,
      finalizationQueue: mergedFinalizationQueue,
    },
    droppedOutboxIds,
  };
}

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
    this.startSerializedFlushInternal(mode, /* propagateError */ false);
  }

  /**
   * Public wrapper around the same serialized-flush chain. Returns the
   * chained flush promise so a caller (e.g. PaymentsModule's at-least-
   * once gate) can `await` it AND see any error thrown by the underlying
   * flush body (POINTER_MONOTONICITY_VIOLATION, IPFS pin failure, etc.).
   *
   * Differs from the timer-driven `startSerializedFlush` callsite only in
   * that:
   *   - the returned promise rejects on flush error rather than just
   *     logging — letting the caller decide whether to retry or refuse
   *     to ack;
   *   - the per-flush `storage:error` event is still emitted (same
   *     side effects).
   *
   * Serializes through `host.flushPromise` so concurrent callers
   * compose into the same chain — preventing the BUNDLE-SET-CHECK
   * race where parallel flushes both pass the monotonicity check (each
   * sees the OTHER's about-to-pin CID as unknown).
   */
  forceFlushSerialized(): Promise<void> {
    return this.startSerializedFlushInternal('save', /* propagateError */ true);
  }

  private startSerializedFlushInternal(
    mode: 'save' | 'no-data',
    propagateError: boolean,
  ): Promise<void> {
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
        if (propagateError) {
          // Caller asked to see the error — re-throw so the awaited
          // promise rejects (caller decides retry / ack semantics).
          throw err;
        }
      })
      .finally(() => {
        if (this.host.getFlushPromise() === flushBox.ref) {
          this.host.setFlushPromise(null);
        }
      });
    flushBox.ref = myFlush;
    this.host.setFlushPromise(myFlush);
    return myFlush;
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

    // Note on pending-publish retry: we deliberately do NOT throw at
    // the START of flushToIpfs when a previous publish was transient.
    // An early throw here would prevent pin + ref-write for the
    // current data, leaving OrbitDB stuck at whatever the last
    // successful flush wrote. A subsequent `PaymentsModule.receive()`
    // calls `load()` to rebuild the in-memory token map from storage;
    // if storage is stale, that load wipes every token added since
    // the last successful flush — silent token loss in the steady
    // state, even though PaymentsModule originally accepted the
    // tokens.
    //
    // Instead we always run the full pin + ref-write path. The
    // publish step at the END of the flush body publishes the LATEST
    // CID, which by virtue of CAR-content monotonicity covers every
    // earlier CID's tokens (the latest CAR is a superset of all
    // prior states this device authored). A successful new publish
    // therefore implicitly anchors any prior pending publish — the
    // latest pointer is the freshest CAR. The periodic pointer poll
    // (`runPointerPollOnce`) handles the idle case where no new
    // flush is triggered and the pending publish needs an out-of-
    // band retry.

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
      // 1. Extract tokens and operational state.
      //
      // Issue #264: both are `let` (was `const opState`) because the
      // monotonicity auto-merge below may union the in-memory `data`'s
      // opState with `previousData`'s to satisfy the per-entry-key
      // OrbitDB write contract — see `unionOpStateWithSentWins` for the
      // SENT-wins dedup rule.
      let tokens = this.host.extractTokensFromTxfData(data);
      let opState = this.host.extractOperationalState(data);

      // 2. Build UXF package
      const { UxfPackage } = await import('../../uxf/UxfPackage.js');
      const pkg = UxfPackage.create();

      // Ingest all token objects
      let tokenValues = [...tokens.values()];
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

      // 3. Export to CAR (unencrypted — see class doc).
      //
      // Issue #255 — `let` (not `const`) because the bundle-set
      // monotonicity check below may merge foreign bundles into `pkg`
      // and re-export. The no-data short-circuit just below uses this
      // initial export; if it fires, we return before any merge.
      let carBytes = await pkg.toCar();

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
        // Issue #213: bundle pinning returned to hierarchical
        // per-block pin via `pinCarBlocksToIpfs(carBytes,
        // expectedRootCid)`. The projected CID is the CAR envelope
        // root CID, extracted from the dag-cbor envelope block —
        // matches what `pinCarBlocksToIpfs` will pin as the
        // entry-point CID for the bundle.
        const projectedCid = await extractCarRootCid(carBytes);
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
      //
      // Issue #255 (post-PR #261) — **in-place recovery on unknown bundle**.
      //
      // Previously this arm threw POINTER_MONOTONICITY_VIOLATION and
      // delegated recovery to either (a) `awaitNextFlush`'s one-shot
      // Gap 4 retry, or (b) a fire-and-forget `queueMicrotask` baseline
      // refresh. Both paths only updated `lastLoadedFromBundleCids` —
      // they did NOT pull the foreign bundle's CONTENT into the local
      // merged state. Under cross-device replication churn (a peer
      // continuously writing bundle refs into OrbitDB), the retry race
      // window between "refresh baseline" and "next flush reads
      // listActiveBundles" lets a NEW unknown CID land, and the second
      // flush re-throws the same violation. Worst case: every flush in
      // a sequence fails, the at-least-once gate refuses every Nostr
      // ack, and incoming events replay forever without ever durably
      // landing.
      //
      // Structural fix (option #3 from the diagnosis): when an unknown
      // bundle is detected, fetch its CAR INLINE and merge it into the
      // in-flight `pkg`. This makes V_n's CAR genuinely a superset of
      // V_n-1's bundle union, satisfying the monotonicity invariant by
      // CONSTRUCTION rather than by deferred retry. The recovery is
      // atomic within the flush body — there is no race window with
      // concurrent peer writes (they land in the NEXT flush, not this
      // one).
      //
      // Fallback: if the inline fetch+merge fails (network down,
      // malformed CAR, etc.), we fall through to throwing the original
      // violation. The legacy Gap 4 retry + fire-and-forget refresh
      // path still applies as the safety net for this rare case.
      const loadedBundleCids = this.host.getLastLoadedFromBundleCids();
      let unknownBundleCids: string[] = [];
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

      // In-place recovery for unknown bundles (#255). Try to fetch and
      // merge each unknown bundle into `pkg`. On any failure the CID
      // stays in `unknownBundleCids` — issue #264 reframes the fallback
      // from "throw POINTER_MONOTONICITY_VIOLATION" to "log + continue
      // with the best-effort superset"; the auto-merge residual block
      // below emits the operator event and proceeds with the publish.
      //
      // `bundlesMergedInline` is hoisted to the outer scope so the
      // `storage:monotonicity-recovered` event emitted later can surface
      // both the merged set AND the residual set in a single payload.
      const bundlesMergedInline: string[] = [];
      if (unknownBundleCids.length > 0) {
        const stillUnknown: string[] = [];
        for (const cid of unknownBundleCids) {
          try {
            const foreignCarBytes = await fetchCarFromIpfs(
              this.host.ipfsGateways,
              cid,
              undefined,
              undefined,
              this.host.getHelia(),
            );
            const foreignPkg = await UxfPackage.fromCar(foreignCarBytes);
            pkg.merge(foreignPkg);
            bundlesMergedInline.push(cid);
            if (loadedBundleCids !== null) {
              loadedBundleCids.add(cid);
            }
          } catch (err) {
            stillUnknown.push(cid);
            this.host.log(
              `In-place merge failed for unknown bundle ${cid} ` +
                `(residual after auto-merge — flush continues): ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        // Replace token map / values with the merged set so downstream
        // code (CAR export, bundle ref tokenCount) reflects the union.
        // Re-export carBytes from the merged pkg so the pin step uses
        // the superset CAR (the pre-merge carBytes above is now stale).
        if (bundlesMergedInline.length > 0) {
          tokens = pkg.assembleAll() as Map<string, unknown>;
          tokenValues = [...tokens.values()];
          carBytes = await pkg.toCar();
          this.host.log(
            `In-place monotonicity recovery: merged ${bundlesMergedInline.length} foreign ` +
              `bundle(s) into in-flight CAR ` +
              `(${bundlesMergedInline.slice(0, 5).join(', ')}` +
              `${bundlesMergedInline.length > 5 ? ', ...' : ''}) — ` +
              `pkg now has ${tokens.size} token(s)`,
          );
        }
        // Anything we couldn't fetch+merge stays as a residual; see
        // the auto-merge residual block below.
        unknownBundleCids = stillUnknown;
      }

      // Issue #264 — token-set auto-merge.
      //
      // When the token-set check found token IDs in `previousData` that
      // are absent from this flush's `pkg`, the previous behavior threw
      // POINTER_MONOTONICITY_VIOLATION and relied on a fire-and-forget
      // baseline refresh + the at-least-once gate's `awaitNextFlush`
      // one-shot retry to recover. That deferred path:
      //   (a) was not reliable under cross-device replication churn
      //       (every retry race-loses to a fresh peer write); and
      //   (b) held the at-least-once Nostr gate closed for the entire
      //       retry window, manifesting as inbound TOKEN_TRANSFER events
      //       replaying forever without ever durably landing.
      //
      // Per #264 design principle: convergence MUST be guaranteed by
      // the aggregator pointer versions alone; profile metadata
      // convergence is eventually-consistent via auto-merge. So:
      //
      //   - For each missing tokenId, extract its TXF entry from
      //     `previousData` (the last-loaded baseline) and ingest it
      //     back into `pkg`. By construction `previousData` contains
      //     every missing entry (that's the definition of tokenMissing
      //     in the check above), so recovery is total.
      //   - Union the in-memory `opState` arrays with `previousData`'s
      //     opState via `unionOpStateWithSentWins` so the per-entry-key
      //     OrbitDB write does NOT tombstone live OUTBOX / SENT / etc.
      //     entries that exist in the baseline but were not carried in
      //     this flush's `data`. SENT-wins dedup drops any OUTBOX entry
      //     whose id matches a SENT entry's id — that transition is
      //     terminal and the OUTBOX residue should not survive the
      //     union.
      //   - Re-export `carBytes` from the merged `pkg` so the pin step
      //     writes the superset CAR.
      const recoveredTokenIds: string[] = [];
      let droppedOutboxIdsAsSent: string[] = [];
      if (tokenMissing.length > 0 && previousData) {
        const previousTokens = this.host.extractTokensFromTxfData(previousData);
        const toReingest: unknown[] = [];
        for (const tokenId of tokenMissing) {
          const txfEntry = previousTokens.get(tokenId);
          if (txfEntry !== undefined) {
            toReingest.push(txfEntry);
            recoveredTokenIds.push(tokenId);
          }
        }
        if (toReingest.length > 0) {
          pkg.ingestAll(toReingest);
          tokens = pkg.assembleAll() as Map<string, unknown>;
          tokenValues = [...tokens.values()];

          const previousOpState = this.host.extractOperationalState(previousData);
          const { merged: mergedOp, droppedOutboxIds } =
            unionOpStateWithSentWins(
              opState as unknown as OpStateArrays,
              previousOpState as unknown as OpStateArrays,
            );
          opState = mergedOp as unknown as typeof opState;
          droppedOutboxIdsAsSent = droppedOutboxIds;

          carBytes = await pkg.toCar();
          this.host.log(
            `In-place monotonicity recovery: re-merged ${recoveredTokenIds.length} ` +
              `missing token(s) from previous baseline ` +
              `(${recoveredTokenIds.slice(0, 5).join(', ')}` +
              `${recoveredTokenIds.length > 5 ? ', ...' : ''}); ` +
              `opState union dropped ${droppedOutboxIdsAsSent.length} OUTBOX ` +
              `id(s) superseded by SENT — pkg now has ${tokens.size} token(s)`,
          );
        }
      }

      // Compute residuals: tokens we wanted to recover but couldn't
      // (e.g., `previousData` was null, or the entry was somehow
      // missing from `previousTokens`). Unknown bundles that couldn't
      // be fetched in the inline merge above also stay in
      // `unknownBundleCids` and become residuals here.
      const residualTokenMissing = tokenMissing.filter(
        (id) => !recoveredTokenIds.includes(id),
      );
      const residualUnknownBundleCids = unknownBundleCids;
      const mergedUnknownBundleCids = bundlesMergedInline;

      // Emit the operator-visible recovery event whenever anything was
      // recovered OR any residual exists. This is a routine convergence
      // signal — distinct from `storage:error` — so monitoring
      // dashboards can plot recovery rates without conflating them with
      // alarms.
      if (
        recoveredTokenIds.length > 0 ||
        droppedOutboxIdsAsSent.length > 0 ||
        residualTokenMissing.length > 0 ||
        residualUnknownBundleCids.length > 0
      ) {
        this.host.emitEvent({
          type: 'storage:monotonicity-recovered',
          timestamp: Date.now(),
          code: POINTER_MONOTONICITY_RECOVERED,
          data: {
            recoveredTokenIds: recoveredTokenIds.slice(0, 100),
            recoveredTokenCount: recoveredTokenIds.length,
            mergedUnknownBundleCids: mergedUnknownBundleCids.slice(0, 100),
            mergedUnknownBundleCount: mergedUnknownBundleCids.length,
            residualUnknownBundleCids: residualUnknownBundleCids.slice(0, 100),
            residualUnknownBundleCount: residualUnknownBundleCids.length,
            residualTokenMissingIds: residualTokenMissing.slice(0, 100),
            residualTokenMissingCount: residualTokenMissing.length,
            recoveredOutboxIdsDroppedAsSent: droppedOutboxIdsAsSent.slice(0, 100),
            recoveredOutboxIdsDroppedAsSentCount: droppedOutboxIdsAsSent.length,
            truncated:
              recoveredTokenIds.length > 100 ||
              residualUnknownBundleCids.length > 100 ||
              residualTokenMissing.length > 100 ||
              droppedOutboxIdsAsSent.length > 100,
          },
        });
      }

      // Residuals: log at warn-level + emit `storage:error` with the
      // legacy POINTER_MONOTONICITY_VIOLATION code (so existing
      // monitoring dashboards keyed on that literal still fire), but
      // DO NOT throw. The publish proceeds with the best-effort
      // superset CAR we managed to assemble — the next cross-device
      // sync from any peer will detect the same residual and re-attempt
      // the inline merge, achieving eventual convergence per the
      // aggregator-pointer-as-source-of-truth design principle in #264.
      if (
        residualTokenMissing.length > 0 ||
        residualUnknownBundleCids.length > 0
      ) {
        const reasonParts: string[] = [];
        if (residualTokenMissing.length > 0) {
          reasonParts.push(
            `could not recover ${residualTokenMissing.length} token(s) from baseline ` +
              `(${residualTokenMissing.slice(0, 10).join(', ')}` +
              `${residualTokenMissing.length > 10 ? ', ...' : ''})`,
          );
        }
        if (residualUnknownBundleCids.length > 0) {
          reasonParts.push(
            `${residualUnknownBundleCids.length} unknown bundle(s) inline fetch failed ` +
              `(${residualUnknownBundleCids.slice(0, 5).join(', ')}` +
              `${residualUnknownBundleCids.length > 5 ? ', ...' : ''})`,
          );
        }
        const violation = new Error(
          `Pointer monotonicity auto-merge residuals: ${reasonParts.join('; ')}. ` +
            `Publishing best-effort superset; subsequent cross-device syncs will retry.`,
        );
        (violation as Error & { code?: string }).code =
          POINTER_MONOTONICITY_VIOLATION;
        this.host.log(
          `[POINTER_MONOTONICITY_VIOLATION] residual after auto-merge (continuing): ${reasonParts.join('; ')}`,
        );

        // Issue #264 — intentionally NOT scheduling the legacy
        // `refreshBaselineForMonotonicity` microtask anymore.
        //
        // Pre-#264 that helper rebuilt `lastLoadedFromBundleCids` from
        // OrbitDB's `listActiveBundles()` so the throw-then-retry path
        // could re-flush past a stale baseline. The retry path
        // (awaitNextFlush) is the only legitimate consumer that still
        // benefits.
        //
        // Post-#264, an unconditional refresh actively BREAKS the
        // residual-retry contract: the residual CID (the unfetchable
        // foreign bundle) IS present in `listActiveBundles()` because
        // it landed in OrbitDB before our flush. A refresh would mark
        // it as "in baseline", and the next flush's bundle-set check
        // would no longer treat it as unknown — silently skipping the
        // inline fetch retry. Subsequent saves would publish CARs
        // missing the residual's tokens despite OrbitDB still showing
        // the bundle as active. The auto-merge is precisely the
        // mechanism that keeps eventual convergence working; the
        // refresh would sabotage it.
        //
        // The `awaitNextFlush` Gap 4 path that DID rely on the throw
        // continues to work for synthetic-violation tests; for real
        // workloads it no longer triggers (no throw).

        // Surface to operators via the legacy `storage:error` code so
        // dashboards keyed on POINTER_MONOTONICITY_VIOLATION still
        // fire. The richer per-recovery payload is on the separate
        // `storage:monotonicity-recovered` event emitted above.
        //
        // Issue #264 steelman fix: the `alert: 'transfer:operator-alert'`
        // field is INTENTIONALLY NOT set on the residual emit anymore.
        // Pre-#264 a monotonicity violation was a rare hard-throw and
        // warranted paging. Post-#264 the residual fires whenever a
        // foreign bundle's inline fetch fails — a routine network
        // transient. Pagers keyed on `data.alert === 'transfer:operator-
        // alert'` would burn out on-call within hours of a flaky IPFS
        // gateway. Operators who DO want paging on residuals can opt in
        // explicitly via the new `autoMergeResidual: true` discriminator
        // (paired with the unchanged `code: POINTER_MONOTONICITY_VIOLATION`).
        this.host.emitEvent({
          type: 'storage:error',
          timestamp: Date.now(),
          code: POINTER_MONOTONICITY_VIOLATION,
          error: violation.message,
          data: {
            missingTokenIds: residualTokenMissing.slice(0, 100),
            missingTokenCount: residualTokenMissing.length,
            unknownBundleCids: residualUnknownBundleCids.slice(0, 100),
            unknownBundleCount: residualUnknownBundleCids.length,
            autoMergeResidual: true,
            truncated:
              residualTokenMissing.length > 100 ||
              residualUnknownBundleCids.length > 100,
          },
        });
        // Intentionally NOT throwing — see comment block above.
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
        // Issue #213 (Option C) restores hierarchical per-block pin.
        // UXF element bytes are now in the same canonical form used
        // for hashing (children as raw 32-byte Uint8Array per
        // `uxf/ipld.ts:elementToIpldBlock`), so
        // `sha256(block.bytes) === block.cid.multihash.digest` holds
        // for every sub-block. Kubo's `dag/put` re-derives CIDs from
        // bytes and pins under exactly the CIDs we publish in the
        // manifest, restoring per-block IPFS dedup.
        //
        // `extractCarRootCid` reads the envelope CID from the CAR
        // header — that's the entry-point CID published in our
        // `UxfBundleRef` and on the aggregator pointer. Receivers
        // walk the DAG starting from this CID via
        // `fetchCarFromIpfs`, which detects the dag-cbor codec and
        // traverses sub-blocks using the UXF-aware walker
        // (`walkUxfElement` in `ipfs-client.ts`).
        const expectedRootCid = await extractCarRootCid(carBytes);
        // Issue #236 — pass the local Helia handle so each block is
        // written to the on-disk blockstore before the HTTP pin. This
        // guarantees a subsequent same-`dataDir` process can read the
        // block via `blockstore.get` without waiting for gateway
        // propagation. Backward-compatible with adapters predating
        // issue #236: `getHelia` returns `null` and the HTTP-only path
        // continues to apply.
        cid = await pinCarBlocksToIpfs(
          this.host.ipfsGateways,
          carBytes,
          expectedRootCid,
          undefined,
          this.host.getHelia(),
        );
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

      // Issue #239 — record this as the most-recent UXF bundle CID we
      // pinned + indexed. Survives across flushes for the life of the
      // provider so `LifecycleManager.shutdown()` can HEAD-verify the
      // bundle CAR is served by ≥1 IPFS gateway before exiting (closes
      // the gap where `Sphere.destroy()` returned while the just-pinned
      // bundle was still propagating across gateways — the dominant
      // cross-process invoice-loss path documented in #234 / #239).
      this.host.setLastPinnedBundleCid(cid);

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

      // 9. Publish to the aggregator pointer layer for cold-start recovery.
      //
      //    Item #15 Phase D.1b: the published CID is the LEAN PROFILE
      //    SNAPSHOT CID (not the UXF bundle CID). The snapshot covers
      //    every per-writer encrypted KV entry (OUTBOX / SENT / disposition
      //    / finalization queue / recipient context) plus the bundle ref
      //    set including the bundle we just wrote at step 6. The bundle
      //    CAR is independently pinned to IPFS for content-addressed
      //    retrieval by `UxfPackage.merge()` at JOIN time.
      //
      //    The snapshot build + pin + publish is wired via the
      //    `onProfileDirtyFlush` callback (Phase C.3 / D.1a) and invoked
      //    here via the host's synchronous entry point. `null` indicates
      //    no snapshot publisher is wired — the same effective state as
      //    "no aggregator pointer layer" — and the publish step is
      //    skipped silently. Production wires the callback unconditionally
      //    via `createProfileProviders`; this branch covers tests that
      //    construct the provider directly without lean-snapshot wiring.
      //
      //    On a TRANSIENT publish failure the snapshot publisher's
      //    internal `runProfileDirtyFlush` throws — caught below.
      //
      //    Issue #241 — the at-least-once Nostr gate is decoupled from
      //    aggregator-publish transient failures. The cross-device
      //    recoverability invariant is satisfied by:
      //      (1) The UXF bundle CAR being pinned + HEAD-verifiable on
      //          IPFS (step 4 above + the verifyFlushDurability leg
      //          below); AND
      //      (2) The OrbitDB bundle ref being written (step 6).
      //    Together (1)+(2) guarantee that any device sharing this
      //    wallet's OrbitDB log will see the new bundle on the next
      //    sync — no aggregator pointer is needed for replica-to-
      //    replica propagation. The aggregator publish is a LIVENESS
      //    optimization for COLD-IMPORT discovery (a brand-new device
      //    with only the master key). A transient publish failure
      //    (replica lag, network blip) is handled by the existing
      //    `pendingPublishCid` retry marker — the next flush or
      //    pointer poll re-attempts before the wallet does any new
      //    save-driven work.
      //
      //    Before #241 a transient publish would throw here, which
      //    closed the at-least-once gate and forced the inbound
      //    TOKEN_TRANSFER event to replay on every Nostr reconnect.
      //    Each replay fired another flush; each flush re-hit the
      //    same `AGGREGATOR_POINTER_WALKBACK_FLOOR` (read-replica
      //    lagging behind the wallet's confirmed `localVersion`),
      //    converting an invisible transient into a sustained retry
      //    storm. Decoupling the gate from publish durability breaks
      //    that amplification while preserving the actual recover-
      //    ability invariant.
      //
      //    On PERMANENT failure the publisher returns `{ ok: false,
      //    transient: false }`, has already emitted `storage:error`
      //    upstream, and we continue — local state is durable, the
      //    cross-device anchor is missing, and no auto-retry would
      //    help (operator intervention required).
      let publishResult: ProfileSnapshotPublishResult | null = null;
      let publishThrew: unknown = undefined;
      try {
        publishResult = await this.host.publishSnapshotIfWired();
      } catch (err) {
        publishThrew = err;
      }

      this.host.emitEvent({
        type: 'storage:saved',
        timestamp: Date.now(),
        data: { cid, tokenCount: tokens.size },
      });

      if (publishThrew !== undefined) {
        throw publishThrew;
      }
      if (publishResult && !publishResult.ok && publishResult.transient) {
        // Issue #241 — see policy comment above. Emit a soft event so
        // operators can observe pending publishes without conflating
        // them with terminal `storage:error` signals. The flush still
        // proceeds to verifyFlushDurability for the bundle CAR — pin
        // durability is the gate the at-least-once invariant rides on.
        this.host.emitEvent({
          type: 'storage:pending-publish',
          timestamp: Date.now(),
          data: { cid, code: publishResult.code },
        });
      }

      // Issue #239 — per-profile-update remote-durability verification.
      //
      // The flush body above guarantees:
      //   - bundle CAR pin POST returned 200 (gateway accepted bytes);
      //   - bundle ref written to OrbitDB;
      //   - snapshot CAR pin POST returned 200;
      //   - aggregator pointer publish call returned ok (publishResult).
      //
      // None of those guarantee that the just-pinned CIDs are SERVED by
      // any gateway yet, nor that the aggregator's `recoverLatest()` has
      // caught up with the just-anchored version. Both gaps are the root
      // cause of cross-process invoice loss documented in #234 / #239.
      //
      // The user-stated contract for this PR: every profile update must
      // be confirmed durable (pin readable + pointer reflects new CID)
      // before the flush completes. Verification runs in parallel for
      // the bundle CID, the snapshot CID, and the aggregator read-back;
      // a failure throws so `forceFlushSerialized` rejects, which closes
      // the at-least-once gate's `awaitNextFlush` and prevents the
      // Nostr ack from advancing on an under-durable bundle.
      //
      // Skipped when:
      //   - shutting down (the shutdown gate handles its own
      //     verification with the configured deadline);
      //   - `flushVerificationDeadlineMs === 0` (test / dev opt-out);
      //   - no pointer layer wired (`getPointerLayer` absent or
      //     returns null). Without a pointer layer there is no cross-
      //     device recovery surface to verify against; the bundle is
      //     locally durable in OrbitDB and that is all this provider
      //     contract promises in non-pointer mode. Skipping in this
      //     case also keeps stub-only tests (which don't run real IPFS
      //     gateways) from hanging on HEAD retries against bogus URLs.
      // Default OFF for direct-construction callers (legacy tests that
      // wire stub pointers + mock gateways would otherwise hang on the
      // verification's HEAD retries). Production callers go through
      // `createProfileProviders` which injects the production default
      // (`ProfileConfig.flushVerificationDeadlineMs ?? 30_000`) so the
      // contract is preserved end-to-end for real wallets.
      const verifyDeadlineMs =
        this.host.options?.flushVerificationDeadlineMs ?? 0;
      const pointerWired = this.host.options?.getPointerLayer?.() ?? null;
      const shouldVerify =
        verifyDeadlineMs > 0 &&
        !this.host.getIsShuttingDown() &&
        pointerWired !== null;
      if (shouldVerify) {
        // Snapshot CID is set on host by the successful publish path
        // (`LifecycleManager.publishAggregatorPointerBestEffort` →
        // `setLastDiscoveredPointerCid`). Issue #241: a transient
        // publish failure does NOT update this CID — the host still
        // holds the PREVIOUS successful publish's snapshot CID (or
        // null if no publish has ever succeeded). Verifying that
        // stale CID would be both pointless (it's already-pinned
        // from a prior flush) and misleading (a pass here doesn't
        // mean THIS flush's state reached the aggregator). Skip the
        // snapshot leg unless we're sure a fresh snapshot was just
        // anchored.
        const freshSnapshotPublished =
          publishResult !== null && publishResult.ok;
        const snapshotCid = freshSnapshotPublished
          ? this.host.getLastDiscoveredPointerCid()
          : null;
        await this.host.verifyFlushDurability(cid, snapshotCid, verifyDeadlineMs);
      }
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
