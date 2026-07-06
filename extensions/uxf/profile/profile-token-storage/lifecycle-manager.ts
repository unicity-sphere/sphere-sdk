/**
 * LifecycleManager
 *
 * Owns the connect / disconnect / initialize / shutdown state machine
 * for `ProfileTokenStorageProvider`, plus the cold-start recovery
 * helpers (aggregator pointer recover + one-shot IPNS migration).
 *
 * The manager coordinates with `BundleIndex` (for `refreshKnownBundles`
 * and the legacy IPNS migration's `onBundle` callback) and with
 * `FlushScheduler` (to drain pending data on shutdown). It does NOT
 * own any private state of its own — every mutation flows through the
 * host so the facade remains the single source of truth (tests poke
 * `(provider as any).initialized` directly; that field MUST stay on
 * the facade).
 *
 * Item #15 Phase E follow-up: the periodic-pointer-poll and cold-start
 * recovery paths dispatch the pointer's CID through the host's
 * `applySnapshotIfWired()` rather than calling `bundleIndex.addBundle()`
 * directly. Under Item #15 the pointer carries a SNAPSHOT CID, not a
 * UXF bundle CID — the legacy `addBundle` path would write the snapshot
 * bytes into the bundle index and the next `load()` would fail to parse
 * the snapshot CAR as a UXF package.
 *
 * Cross-seam reads / writes via the host:
 *   - status, initialized, isShuttingDown, identity, encryptionKey
 *   - replicationUnsub
 *   - addressId (computed at `setIdentity` time)
 *   - knownBundleCids (read by initialize() to decide whether to run
 *     cold-start recovery; mutated by `BundleIndex.refreshKnownBundles`)
 *   - lastLoadedData / lastTokenManifest (cleared on shutdown)
 *   - flushTimer / flushPromise / pendingData (cancelled / drained on
 *     shutdown via host.flushToIpfs())
 *
 * # Cross-device sync resilience: dual discovery paths
 *
 * The wallet has two cross-device state-discovery paths:
 *
 *   - **Path 1 — OrbitDB pubsub (libp2p gossipsub).** Live, peer-to-peer.
 *     Fires whenever a peer publishes a new bundle ref to the same
 *     OrbitDB log. This is the only path that delivers updates AFTER
 *     cold-start in the historical code.
 *
 *   - **Path 2 — Aggregator pointer + IPFS.** The pointer layer
 *     publishes a versioned CID to the aggregator on every flush;
 *     `recoverLatest()` returns the latest valid CID. This path is
 *     used at cold-start (`initialize()`) but was never re-polled
 *     afterwards. Two devices online with the same wallet would
 *     diverge for hours when libp2p pubsub failed (NAT, firewall,
 *     peer not discovered).
 *
 * `schedulePointerPoll()` arms a periodic poll of `recoverLatest()` at a
 * randomised interval in [30s, 90s) to provide a fallback when Path 1
 * stalls. New CIDs discovered via the poll are added to the bundle
 * index just like cold-start recovery. Already-known CIDs and null
 * results are no-ops. The randomised jitter avoids synchronised polling
 * across devices that booted at the same time.
 *
 * @module profile/profile-token-storage/lifecycle-manager
 */

import { hexToBytes } from '../../../../core/hex.js';
import type { FullIdentity } from '../../../../types/index.js';
import { CID } from 'multiformats/cid';
import {
  deriveProfileEncryptionKey,
} from '../encryption.js';
import { computeAddressId } from '../types.js';
import { logger } from '../../../../core/logger.js';
import {
  verifyCidAccessibleWithRetry,
  type VerifyCidAccessibleResult,
} from '../ipfs-client.js';
import type { ShutdownOptions } from '../../../../storage/storage-provider.js';
import type { BundleIndex } from './bundle-index.js';
import type { ProfileTokenStorageHost } from './host.js';
// RFC-251 Approach D / issue #255 Problem B — pointer-publish win-broadcast.
// Imported only for the publish-success path; absent pointer layer ⇒ skipped.
import {
  buildWinBroadcastTag,
  signWinBroadcastPayload,
  WIN_BROADCAST_KIND_MARKER,
  WIN_BROADCAST_SCHEMA_VERSION,
} from '../aggregator-pointer/win-broadcast.js';
import type { RecoverResult } from '../aggregator-pointer/ProfilePointerLayer.js';

/**
 * Pointer-layer error codes that indicate a permanent integrity /
 * configuration problem. These MUST be surfaced to the user rather
 * than silently swallowed — either the wallet is poisoned (marker
 * corrupt, streak of corrupt versions), the aggregator rotated its
 * trust base (SDK upgrade needed), the wallet was rejected (v-burn
 * that will never succeed again), or we hit an integrity-class
 * failure (untrusted proof, security origin mismatch).
 *
 * Unknown / missing codes default to TRANSIENT (see
 * `isPermanentPointerError`) — "keep running and retry" is safer
 * than "break the wallet" when classification is ambiguous.
 */
const PERMANENT_POINTER_ERROR_CODES: ReadonlySet<string> = new Set([
  'AGGREGATOR_POINTER_UNREACHABLE_RECOVERY_BLOCKED',
  'AGGREGATOR_POINTER_REJECTED',
  'AGGREGATOR_POINTER_UNTRUSTED_PROOF',
  'AGGREGATOR_POINTER_TRUST_BASE_STALE',
  'AGGREGATOR_POINTER_MARKER_CORRUPT',
  'AGGREGATOR_POINTER_CORRUPT_STREAK',
  'AGGREGATOR_POINTER_AGGREGATOR_REJECTED',
  'SECURITY_ORIGIN_MISMATCH',
  'AGGREGATOR_POINTER_CAPABILITY_DENIED',
  'AGGREGATOR_POINTER_UNSUPPORTED_RUNTIME',
  'AGGREGATOR_POINTER_PROTOCOL_ERROR',
]);

/**
 * Periodic-poll bounds: nominal interval is sampled uniformly from
 * [30 s, 90 s) on every re-arm. The randomised jitter avoids
 * synchronised polling across devices that booted simultaneously
 * (which would create thundering-herd load on the aggregator). On a
 * permanent failure we re-arm with `* 5` (so [150 s, 450 s)) to back
 * off — the underlying issue is operator-actionable and won't resolve
 * via fast retries.
 */
const POINTER_POLL_MIN_MS = 30_000;
const POINTER_POLL_RANGE_MS = 60_000; // → [30s, 90s)
const POINTER_POLL_BACKOFF_MULTIPLIER = 5;

/**
 * Issue #239 — default wall-clock budget for the
 * {@link LifecycleManager.awaitRemoteDurability} gate when the caller
 * omits `ShutdownOptions.verificationDeadlineMs`.
 *
 * The default is `0` (gate disabled) for direct-constructed providers
 * so legacy tests that don't pass options don't hang on the 30s
 * verification window. Production wallets go through `Sphere.destroy`,
 * which injects the production default (`SHUTDOWN_VERIFICATION_DEFAULT_PRODUCTION_MS`)
 * when no override is supplied.
 *
 * `Sphere.destroy({ verificationDeadlineMs: 0 })` explicitly disables
 * the gate on production wallets; `Sphere.destroy({ force: true })`
 * skips it AND stamps `pendingPublishCid` for cold-start retry.
 */
const SHUTDOWN_VERIFICATION_DEFAULT_DEADLINE_MS = 0;

/**
 * Issue #239 — pointer `recoverLatest()` poll cadence used by
 * {@link LifecycleManager.awaitAggregatorPointerReadBack}. The
 * aggregator's read-after-write is generally fast (single-digit ms in
 * the happy path) but transient propagation between aggregator
 * replicas can take a few seconds. 500 ms gives ~60 attempts inside a
 * 30 s deadline without hammering the aggregator.
 */
const POINTER_READBACK_POLL_MS = 500;

/**
 * Issue #239 — pending-publish retry cadence used by
 * {@link LifecycleManager.awaitPendingPublishCleared}. Calls back into
 * `publishAggregatorPointerBestEffort` so each tick exercises the full
 * retry path (same cadence as the periodic poll's fast retry).
 */
const PENDING_PUBLISH_RETRY_INTERVAL_MS = 1_000;

/**
 * Issue #450 — stuck-progress threshold for
 * {@link LifecycleManager.awaitPendingPublishCleared}. When N
 * consecutive iterations of the pre-shutdown retry loop observe the
 * SAME `pendingPublishCid` + SAME error code, treat the failure as
 * stable and bail rather than burn the rest of the shutdown deadline.
 *
 * Why this exists: under contended-testnet conditions, each retry can
 * burn the reconcile algorithm's shared 5-minute wall-clock budget
 * (see `reconcile-algorithm.ts:RECONCILE_WALL_CLOCK_BUDGET_MS`). In
 * the §D.1 hang reported in issue #450, the loop spun for ~6 hours at
 * ~150% CPU before SIGTERM rescued the host. Detecting that the
 * failure is stable and giving up cleanly hands the work to the
 * cold-start retry path on next boot (the `pendingPublishCid` marker
 * is preserved across the bail).
 *
 * Threshold = 3 balances responsiveness against false positives:
 *   - 1 single failure could be a transient blip.
 *   - 2 still gives the underlying lag one chance to clear.
 *   - 3 confirms the failure pattern is stable.
 *
 * Combined with `PENDING_PUBLISH_RETRY_INTERVAL_MS`, the worst-case
 * loop runtime drops from "deadline" to roughly
 * `3 × (per-attempt cost + sleep) ≈ 3 × (5 min budget + 1s)`,
 * bounded by `awaitRemoteDurability`'s deadline regardless.
 */
const STUCK_PENDING_PUBLISH_THRESHOLD = 3;

/**
 * Issue #239 — discriminated identifier for the durability leg that
 * tripped the shutdown deadline. Surfaced via the
 * `shutdown:verification-timeout` event so operators see which path
 * stalled.
 */
export type ShutdownVerificationLeg =
  | 'pin-verify'
  | 'pointer-read-back'
  | 'pending-publish-retry';

/**
 * Issue #245 #3 — outer throttle window applied AFTER a
 * `AGGREGATOR_POINTER_WALKBACK_FLOOR` transient failure. While this
 * window is active, subsequent `publishAggregatorPointerBestEffort`
 * calls short-circuit (returning the same transient outcome) rather
 * than burning another ~9-15s of inner reconcile-retry budget.
 *
 * Rationale: WALKBACK_FLOOR fires when the aggregator's current
 * highest-visible version is BELOW a version this wallet has already
 * confirmed (replication lag). It is DETERMINISTIC for a given
 * `(currentLocalVersion, aggregator state)` — retrying within
 * milliseconds returns the same answer. The existing inner retry
 * (5 attempts with exponential backoff up to ~15s total) already
 * absorbs short lag windows; this outer throttle absorbs the
 * longer-lag case where lag persists past the inner budget and we'd
 * otherwise re-burn it on every save-driven flush (debounce ~2s)
 * and every periodic pointer poll. A 25-min manual-test run with
 * this scenario emitted hundreds of identical WARN lines per #245.
 *
 * The `pendingPublishCid` marker is preserved across throttled
 * skips — the at-least-once gate (PaymentsModule.handleIncomingTransfer)
 * stays closed for the entire throttle window, exactly as if the
 * inner retries kept failing. The user observes a slightly longer
 * delay before durable publish, in exchange for orders-of-magnitude
 * less log noise and CPU spent in pointless retries.
 *
 * 60s is chosen so a routine ~30s replication lag clears within one
 * throttle window; at the typical 2s save debounce that reduces WARN
 * volume by ~30x. Other transient codes (NETWORK_ERROR,
 * UNCLASSIFIED) are NOT throttled — those are not deterministic given
 * local state and benefit from prompt retry.
 *
 * Note: PR #241 separately raised `WALKBACK_FLOOR_RETRY_BUDGET` from
 * 5 → 7 (inner reconcile-retry) and decoupled the at-least-once gate
 * from publish transience. PR #245's outer throttle complements that
 * by stopping the storm of inner-retries from save-driven flushes
 * once the lag is known to persist past the inner budget.
 */
const WALKBACK_FLOOR_RETRY_THROTTLE_MS = 60_000;
const WALKBACK_FLOOR_CODE = 'AGGREGATOR_POINTER_WALKBACK_FLOOR';

export class LifecycleManager {
  /**
   * Periodic-poll timer for Path 2 (aggregator pointer recovery).
   * Owned by this module — does NOT live on the host because it is
   * private to the polling mechanism (no other seam reads or mutates
   * it). Set by `schedulePointerPoll()`, cleared by `shutdown()`.
   */
  private pointerPollTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Aborted in `shutdown()` to cancel any in-flight `pointer.recoverLatest()`
   * calls that don't otherwise have a signal threaded through from a
   * higher caller. Page-freeze 2026-05-29: without this, a `Sphere.destroy()`
   * during a slow IPFS gateway round-trip leaves the recoverLatest walkback
   * issuing requests for tens of seconds AFTER the user has reloaded the
   * page or unmounted the provider — feeding the dual-instance leak we saw
   * in the browser flame graph.
   */
  private destroyController: AbortController | null = null;

  /**
   * Lazily-allocated accessor for the destroy controller's signal. We create
   * the controller on first use (after `initialize()` runs and before the
   * first pointer poll) so test harnesses that wire up a `LifecycleManager`
   * without ever polling don't pay the allocation cost.
   */
  private getDestroySignal(): AbortSignal {
    if (this.destroyController === null) {
      this.destroyController = new AbortController();
    }
    return this.destroyController.signal;
  }

  /**
   * Issue #245 #3 — wall-clock deadline (ms epoch) until which a
   * publish attempt should short-circuit because a recent attempt
   * hit `AGGREGATOR_POINTER_WALKBACK_FLOOR`. Zero when no throttle is
   * active. Cleared on:
   *   - any successful publish (lag has cleared)
   *   - a transient failure with a DIFFERENT code (the prior
   *     WALKBACK_FLOOR diagnosis no longer applies — different fault
   *     class, the inner retry budget is the right tool)
   * See `WALKBACK_FLOOR_RETRY_THROTTLE_MS` for rationale.
   */
  private walkbackFloorThrottleUntilMs = 0;
  /**
   * Issue #245 #3 — number of throttled-skip events accumulated
   * during the active throttle window. Logged at the END (next
   * non-throttled outcome) so a single summary replaces the storm.
   */
  private walkbackFloorThrottleSkipCount = 0;

  /**
   * Issue #247 — in-flight coalescing flag for
   * `publishAggregatorPointerBestEffort`.
   *
   * The PR #245 throttle (`walkbackFloorThrottleUntilMs`) only stops
   * SEQUENTIAL bursts: it's set in the catch arm AFTER
   * `pointer.publish()` resolves. Concurrent callers all pass the
   * entry check before any catch arm fires, all proceed to call
   * `pointer.publish()`, all fail, all 6+ print the same WARN line —
   * the storm PR #245 was supposed to suppress, reduced from
   * "hundreds" to "6 per cycle".
   *
   * The realistic concurrent callers in one process:
   *   - `flushScheduler.flushToIpfs` → `publishSnapshotIfWired`.
   *   - debounced `dispatchDirtyFlush` timer.
   *   - `retryPendingPublishIfAny` called from `runPointerPollOnce`.
   *
   * This field coalesces them: if a publish is in flight when a new
   * caller arrives, the new caller awaits and returns the in-flight
   * result instead of starting a parallel publish. Same shape as the
   * throttle entry check (returns `{ok, transient, code?}`); same
   * pendingPublishCid stamping semantics; same idempotency contract.
   *
   * Cleared in `finally` so a subsequent call after the in-flight
   * publish resolves starts a fresh attempt (or hits the throttle if
   * the prior publish armed it).
   */
  private walkbackPublishInFlight:
    | Promise<{ readonly ok: boolean; readonly transient: boolean; readonly code?: string }>
    | null = null;

  /**
   * Poll-discovery handler captured from `initialize()`. Invoked by
   * {@link runPointerPollOnce} after it adds a poll-discovered CID to
   * the bundle index — drives the necessary load() + scheduleFlushNoData
   * to keep `lastLoadedFromBundleCids` in sync with OrbitDB. Without it,
   * the periodic poll adds CIDs to OrbitDB but never loads them, and
   * subsequent save-driven flushes abort with
   * POINTER_MONOTONICITY_VIOLATION (correctly preventing silent token
   * loss, but causing the at-least-once gate to refuse every Nostr ack).
   *
   * Distinct from the pubsub-driven `replicationHandler` (closure
   * captured at line ~186) because the pubsub handler has its own
   * "did we observe anything new" diff check and snapshot ordering
   * that aren't applicable here (the poll already confirmed the CID
   * is new before invoking this callback).
   *
   * Set in `initialize()`; cleared (set to null) in `shutdown()`.
   */
  private onPollDiscoveredNewCid: (() => Promise<void>) | null = null;

  constructor(
    private readonly host: ProfileTokenStorageHost,
    private readonly bundleIndex: BundleIndex,
  ) {}

  setIdentity(identity: FullIdentity): void {
    this.host.setIdentityState(identity);

    // Derive encryption key from the private key if not already provided
    if (!this.host.getEncryptionKey()) {
      try {
        const privKeyBytes = hexToBytes(identity.privateKey);
        this.host.setEncryptionKey(deriveProfileEncryptionKey(privKeyBytes));
      } catch (err) {
        this.host.log(
          `Failed to derive encryption key: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Compute the short address ID for per-address key scoping
    if (identity.directAddress) {
      this.host.setComputedAddressId(computeAddressId(identity.directAddress));
    }
  }

  async initialize(
    replicationHandler: () => Promise<void>,
    onPollDiscoveredNewCid?: () => Promise<void>,
  ): Promise<boolean> {
    // Capture the poll-discovery callback so `runPointerPollOnce` can
    // trigger a load+flush after discovering and adding a new CID.
    // Optional — when omitted (legacy callers), the periodic-poll's
    // addBundle leaves loadedBundleCids stale and the next save-driven
    // flush may abort with POINTER_MONOTONICITY_VIOLATION.
    this.onPollDiscoveredNewCid = onPollDiscoveredNewCid ?? null;
    if (this.host.getInitialized()) return true;

    if (!this.host.getIdentity()) {
      this.host.log('Cannot initialize: no identity set');
      return false;
    }

    this.host.setStatus('connecting');

    // Issue #313 — lazy-load: seed the in-memory state from the local
    // snapshot blob BEFORE the OrbitDB connect / bundle-index refresh
    // path runs. On a valid snapshot the wallet has renderable
    // `lastLoadedData` + `knownBundleCids` + `lastDiscoveredPointerCid`
    // before any remote round-trip. The rest of this method continues
    // unchanged and effectively becomes the background sync — bundle
    // refresh + aggregator pointer recovery run from the seeded
    // baseline.
    //
    // Best-effort: any failure inside the snapshot path falls through
    // to the slow boot. The snapshot helper does NOT throw; it returns
    // `true` only when a valid blob was applied. Corruption emits
    // `profile:snapshot-corrupt` and removes the blob so the next
    // successful flush replaces it cleanly.
    let snapshotSeeded = false;
    try {
      snapshotSeeded = await this.host.readLocalSnapshot();
    } catch (err) {
      // Defensive — the host method already swallows storage errors.
      // A throw here would be a programmer bug; log + continue.
      this.host.log(
        `readLocalSnapshot threw unexpectedly (continuing with slow boot): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    try {
      // Ensure OrbitDB is connected
      if (!this.host.db.isConnected()) {
        this.host.log(
          `OrbitDB not connected; skipping bundle load until connected` +
            (snapshotSeeded ? ' (snapshot seeded for offline render)' : ''),
        );
        this.host.setStatus('connected');
        this.host.setInitialized(true);
        return true;
      }

      // Load known bundle CIDs from OrbitDB.
      //
      // Robustness band-aid (Issue #239 territory): a previous failed
      // migration may have written an OpLog entry whose IPFS payload
      // block was never durably pinned (gateway dropped, peer crashed
      // mid-flush). OrbitDB v3's `db.all()` walks the OpLog and resolves
      // every entry's block — a single unreachable block throws and
      // poisons the whole enumeration. Without this guard, the throw
      // propagates to the outer catch at this method's tail, returns
      // `false`, and `setInitialized(true)` is NEVER called. Every
      // subsequent `save()` then rejects with `"Provider not initialized"`,
      // making the wallet effectively unusable for the session.
      //
      // **Scope of this band-aid.** Tolerating the throw here ONLY
      // unblocks `initialize()`. Subsequent calls to `db.all()` —
      // notably `provider.load()`, `provider.sync()`, and the flush
      // scheduler's bundle-monotonicity checks — still throw on the
      // same corrupt block (those paths have pre-existing try/catch
      // swallows that may silently degrade further). The structural
      // fix is to make `OrbitDbAdapter.all()` tolerate per-OpLog-entry
      // block-load failures the same way it tolerates per-entry
      // coercion failures (see `tryCoerce` in orbitdb-adapter.ts). That
      // larger fix is tracked separately — search the issue tracker
      // for "OrbitDbAdapter.all per-block tolerance".
      //
      // **Operator observability.** The catch emits a `storage:error`
      // event with code `BUNDLE_INDEX_REFRESH_FAILED` so consumers
      // surface the degraded state instead of silently proceeding —
      // critical because the downstream `flush-scheduler` swallows its
      // own `db.all()` throws on `listActiveBundles()`, and a
      // user-triggered migration would otherwise publish a bundle
      // pointer that reflects ONLY the post-recovery state (silent
      // orphaning of any historical bundles the corrupt walk hid).
      // Consumers SHOULD treat this event as "wallet is operating with
      // an incomplete view of its remote state — back off destructive
      // writes (e.g., overwrite-style migrations) until investigated."
      try {
        await this.bundleIndex.refreshKnownBundles();
      } catch (err) {
        this.host.log(
          `bundleIndex.refreshKnownBundles failed (proceeding with empty ` +
            `bundle set; cold-start recovery may repopulate, but cross-` +
            `device sync and load() will continue to fail until the ` +
            `corrupt OpLog entry is bypassed): ${
              err instanceof Error ? err.message : String(err)
            }`,
        );
        // Emit the degraded-state event so operator dashboards and the
        // sphere.telco UI's migration banner can surface the condition
        // BEFORE the user clicks Migrate and unwittingly publishes a
        // partial-view bundle pointer.
        this.host.emitEvent(
          this.host.buildErrorEvent(
            'storage:error',
            err,
            'BUNDLE_INDEX_REFRESH_FAILED',
          ),
        );
        // Defense-in-depth reset. `refreshKnownBundles` builds its
        // result locally and only writes to host AFTER `db.all()`
        // succeeds, so a partial walk does NOT leak state under the
        // current implementation. We still reset here so a future
        // refactor that introduces incremental writes cannot silently
        // bypass the catch.
        this.host.setKnownBundleCids(new Set());
      }

      // COLD-START RECOVERY: if OrbitDB has no bundles locally, this
      // is likely a fresh device (wallet re-imported from mnemonic
      // after a wipe). Rebuild the active bundle set without waiting
      // for a live peer.
      //
      // Priority (T-D6 / T-D6b):
      //   (1) aggregator pointer layer — authoritative source of
      //       truth. On a successful recoverLatest the CID is
      //       trust-verified via inclusion proof + CAR content-
      //       address verify. Lands as a new bundle ref that the
      //       next JOIN pass assembles.
      //   (2) one-shot legacy IPNS → pointer migration. Only fires
      //       if the local cache carries a legacy `profile.ipns.
      //       sequence` key and no `profile.pointer.migration.done`
      //       marker. Reads the legacy IPNS snapshot ONE TIME,
      //       hydrates the bundle set into OrbitDB, and stamps the
      //       marker so subsequent loads go straight to the pointer
      //       path. New wallets (no IPNS history) skip this entirely.
      if (this.host.getKnownBundleCids().size === 0) {
        const pointerRecovered = await this.recoverFromAggregatorPointerBestEffort();
        if (!pointerRecovered) {
          await this.runLegacyIpnsMigrationBestEffort();
        }
      }

      // Subscribe to OrbitDB replication events for real-time sync
      const unsub = this.host.db.onReplication(() => {
        replicationHandler().catch((err) => {
          this.host.log(`Replication handler error: ${err instanceof Error ? err.message : String(err)}`);
        });
      });
      this.host.setReplicationUnsub(unsub);

      this.host.setStatus('connected');
      this.host.setInitialized(true);
      this.host.log(`Initialized with ${this.host.getKnownBundleCids().size} known bundle(s)`);

      // Start periodic Path 2 (aggregator pointer) polling. Acts as a
      // safety net for OrbitDB pubsub stalls (NAT / firewall / peer
      // discovery failures). Only fires when a pointer-layer closure
      // is wired — otherwise the poll is structurally pointless.
      this.schedulePointerPoll();

      return true;
    } catch (err) {
      this.host.setStatus('error');
      this.host.log(`Initialization failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async shutdown(options?: ShutdownOptions): Promise<void> {
    if (this.host.getIsShuttingDown()) return;
    this.host.setIsShuttingDown(true);

    // Cancel periodic pointer-poll timer first — its callback gates on
    // isShuttingDown but a poll already in flight would otherwise race
    // shutdown's bundle-index mutations.
    if (this.pointerPollTimer !== null) {
      clearTimeout(this.pointerPollTimer);
      this.pointerPollTimer = null;
    }

    // Abort any in-flight pointer.recoverLatest() calls that don't have a
    // signal threaded through from a higher caller. Page-freeze 2026-05-29:
    // a slow IPFS gateway can keep the discovery walkback alive for tens of
    // seconds after the user closes/reloads the tab, doubling resource use
    // until the network round-trip finally returns. The abort here lets
    // those promises settle (with an AbortError) so the rest of shutdown
    // can proceed promptly.
    if (this.destroyController !== null) {
      this.destroyController.abort();
      this.destroyController = null;
    }

    // Cancel debounce timer
    const timer = this.host.getFlushTimer();
    if (timer !== null) {
      clearTimeout(timer);
      this.host.setFlushTimer(null);
    }

    // Steelman³⁸ warning: AWAIT any in-flight flush BEFORE issuing a
    // direct flushToIpfs(). The previous order spawned two concurrent
    // flushes; lastPinnedCid interleaved across them and the retry-cache
    // invariant ("pinned CID matches currently flushed bytes") was
    // violated.
    const inflight = this.host.getFlushPromise();
    if (inflight) {
      try {
        await inflight;
      } catch {
        // best-effort
      }
    }

    // Flush any pending writes (after the in-flight flush settled)
    if (this.host.getPendingData()) {
      try {
        await this.host.flushToIpfs();
      } catch (err) {
        this.host.log(`Shutdown flush failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Issue #239 — remote-durability gate.
    //
    // The flush pipeline above only guarantees that:
    //   (a) the bundle CAR pin POST returned 200 (gateway accepted, but
    //       may not yet serve to other peers — observed propagation lag
    //       of ~15 s on testnet);
    //   (b) the aggregator pointer publish was attempted (transient
    //       failures leave a `pendingPublishCid` marker for retry; the
    //       caller already returned 'submitted').
    //
    // Neither is sufficient for cross-process recovery on the same
    // dataDir: the next process's `fetchCarFromIpfs(bundleCid)` may hit
    // a 404 if propagation hasn't caught up, and the next process's
    // `recoverLatest()` may miss the just-anchored pointer if a
    // transient failure stamped only the local marker.
    //
    // The gate below blocks `shutdown()` until BOTH legs are remotely
    // observable OR the deadline expires (in which case a
    // `shutdown:verification-timeout` event surfaces the stall).
    // `options.force === true` skips the gate (E2E / ungraceful-crash
    // simulation) — the cold-start recovery path on next boot retries
    // any unverified publish via the existing `pendingPublishCid`
    // machinery.
    const gateDeadlineMs =
      options?.verificationDeadlineMs ??
      SHUTDOWN_VERIFICATION_DEFAULT_DEADLINE_MS;
    if (!options?.force && gateDeadlineMs > 0) {
      try {
        await this.awaitRemoteDurability({
          deadlineMs: gateDeadlineMs,
          reason: options?.reason,
        });
      } catch (err) {
        // The gate emits structured events for the expected failure
        // modes (deadline exceeded, gateway not serving). Anything that
        // escapes here is a programmer error / unexpected throw — log
        // and continue with teardown so shutdown still completes.
        this.host.log(
          `Shutdown durability gate threw unexpectedly (continuing teardown): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } else {
      // Force-quit path: ensure the cold-start retry will fire on next
      // boot if the most recent publish wasn't confirmed. The
      // `setPendingPublishCid` setter persists to localCache so the
      // marker survives the immediate exit.
      const lastSnapshot = this.host.getLastDiscoveredPointerCid();
      if (lastSnapshot && !this.host.getPendingPublishCid()) {
        // We have no way to verify whether the last publish succeeded
        // here (the publisher clears `lastDiscoveredPointerCid` on
        // success too), so this is a deliberate over-stamp: cold-start
        // retry is idempotent — if the publish already landed, the
        // re-publish is a no-op against the aggregator's version map.
        this.host.setPendingPublishCid(lastSnapshot);
        this.host.log(
          `Shutdown (force): stamped pending-publish marker for cold-start retry: cid=${lastSnapshot}` +
            (options?.reason ? ` reason=${options.reason}` : ''),
        );
      }
    }

    // Issue #313 — atomic-write the lazy-load snapshot blob on
    // shutdown. This is the LAST safe point at which `lastLoadedData`
    // + `knownBundleCids` + `lastDiscoveredPointerCid` are all still
    // populated; the upcoming teardown block (`setLastLoadedData(null)`,
    // etc.) wipes them. The write is best-effort: failures route
    // through `storage:error` and do not block shutdown.
    //
    // Distinct from the flush-driven snapshot write at
    // `FlushScheduler.flushToIpfs` — that one fires per successful
    // flush; this one captures any in-memory state that arrived
    // BETWEEN the last flush and shutdown (e.g., a save that landed
    // after the final debounce cancel + force-flush above). For an
    // immediately-after-flush shutdown this write is a no-op rewrite of
    // the same blob; the cost is one local-storage transaction.
    try {
      await this.host.writeLocalSnapshot('shutdown');
    } catch (err) {
      this.host.log(
        `Shutdown snapshot write threw unexpectedly (best-effort): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Steelman³⁸ warning: unsubscribe from replication BEFORE we null
    // out the cache, so any in-flight onReplication handler that was
    // about to read this.lastLoadedData / lastTokenManifest sees its
    // pre-shutdown value rather than null mid-method.
    const unsub = this.host.getReplicationUnsub();
    if (unsub) {
      unsub();
      this.host.setReplicationUnsub(null);
    }

    // Steelman³⁸ warning: drop in-memory snapshots so a consumer that
    // retains a reference to this provider doesn't pin the entire
    // token graph forever.  Mirrors what `clear()` does.
    this.host.setLastLoadedData(null);
    this.host.setLastLoadedFromBundleCids(null);
    this.host.setLastTokenManifest(null);
    // Release the poll-discovery callback so a delayed `runPointerPollOnce`
    // tick that fires after shutdown doesn't reach back into the (now
    // torn-down) provider.
    this.onPollDiscoveredNewCid = null;

    this.host.setInitialized(false);
    this.host.setStatus('disconnected');
    this.host.setIsShuttingDown(false);
  }

  // ===========================================================================
  // Issue #239 — Remote-durability shutdown gate
  // ===========================================================================

  /**
   * Issue #239 — block until the prior process's pins + publishes are
   * verifiably durable on remote infrastructure, OR the deadline
   * elapses.
   *
   * Three legs run concurrently inside a shared deadline:
   *   1. **pending-publish retry**: if a previous publish left a
   *      `pendingPublishCid` marker, retry it until cleared or the
   *      deadline elapses.
   *   2. **pin-verify**: HEAD-poll the most-recent UXF bundle CID
   *      against the configured IPFS gateways until ≥1 gateway serves
   *      it. Skipped when no bundle has been pinned this process
   *      lifetime (`lastPinnedBundleCid === null`).
   *   3. **pointer-read-back**: poll `pointer.recoverLatest()` until it
   *      returns the most-recent published snapshot CID. Skipped when
   *      no snapshot has been published (`lastDiscoveredPointerCid ===
   *      null`) or no pointer layer is wired (the cross-process
   *      recovery path is structurally absent — nothing to verify).
   *
   * On any leg failing within the deadline, a
   * `shutdown:verification-timeout` event is emitted with structured
   * detail. Shutdown continues regardless: the event is informational
   * so operators can investigate cross-process recovery gaps without
   * blocking the calling thread indefinitely.
   *
   * NB: this method MUST NOT throw on the expected failure modes —
   * callers (`shutdown()` itself) wrap with a defensive try/catch but
   * we keep the contract clean: gate either completes within the
   * budget or emits a timeout event and returns.
   *
   * @param options.deadlineMs Total wall-clock budget across all legs.
   * @param options.reason     Free-form context recorded in the
   *                            timeout event payload.
   */
  async awaitRemoteDurability(options: {
    readonly deadlineMs: number;
    readonly reason?: string;
  }): Promise<void> {
    const deadline = Date.now() + Math.max(0, options.deadlineMs);
    const remainingMs = (): number => Math.max(0, deadline - Date.now());

    // Shared abort signal so a deadline-exceeded result in one leg
    // tears down the others promptly. We do NOT abort early on
    // single-leg success — the other legs still need to finish (or
    // hit the deadline) to surface their own diagnostics.
    const controller = new AbortController();
    const deadlineTimer = setTimeout(() => controller.abort(), remainingMs());

    const bundleCid = this.host.getLastPinnedBundleCid();
    const snapshotCid = this.host.getLastDiscoveredPointerCid();
    const pendingCid = this.host.getPendingPublishCid();

    // Issue #239 — per-flush watermark short-circuit. When the per-
    // flush gate already HEAD-verified the current pin and matched the
    // aggregator read-back on the current snapshot, the shutdown gate
    // has nothing new to confirm: re-running the legs would waste
    // 15-30s on round-trips that already succeeded. Skip the
    // corresponding leg when its watermark matches.
    const verifiedBundle = this.host.getLastVerifiedBundleCid();
    const verifiedSnapshot = this.host.getLastVerifiedSnapshotCid();
    const bundleNeedsVerify = bundleCid !== null && bundleCid !== verifiedBundle;
    const snapshotNeedsVerify = snapshotCid !== null && snapshotCid !== verifiedSnapshot;

    const reason = options.reason;

    // Pre-check: every leg is a no-op. Skip the timer + Promise.allSettled
    // overhead entirely so a shutdown with nothing to verify returns
    // in microseconds (common for read-only sessions OR steady-state
    // sessions where per-flush already verified everything).
    if (!bundleNeedsVerify && !snapshotNeedsVerify && !pendingCid) {
      clearTimeout(deadlineTimer);
      this.host.log(
        `Shutdown durability: nothing to verify (bundle ` +
          `${bundleCid ? 'already verified per-flush' : 'not pinned'}, ` +
          `snapshot ${snapshotCid ? 'already verified per-flush' : 'not published'}, ` +
          `no pending publish)`,
      );
      return;
    }

    this.host.log(
      `Shutdown durability gate: bundleCid=${bundleCid ?? 'none'} ` +
        `(verified=${verifiedBundle ?? 'none'}) ` +
        `snapshotCid=${snapshotCid ?? 'none'} ` +
        `(verified=${verifiedSnapshot ?? 'none'}) ` +
        `pendingCid=${pendingCid ?? 'none'} ` +
        `deadlineMs=${options.deadlineMs}`,
    );

    const legs: Array<Promise<void>> = [];

    // Leg 1 — pending-publish retry. Always runs (even when pendingCid
    // is null at gate-entry) because a leg 3 read-back miss may
    // re-arm the marker if the publish was lost.
    legs.push(
      this.awaitPendingPublishCleared(deadline, controller.signal, reason),
    );

    // Leg 2 — pin verify. Skip when (a) no bundle was pinned this
    // session (cold-start-only read sessions) OR (b) the per-flush
    // gate already verified this exact bundle CID.
    if (bundleNeedsVerify && bundleCid !== null) {
      legs.push(
        this.awaitPinVerified(bundleCid, deadline, controller.signal, reason),
      );
    }

    // Leg 3 — pointer read-back. Skip when (a) no pointer wired (no
    // recoverable surface), (b) no snapshot published yet, OR (c) the
    // per-flush gate already verified this exact snapshot CID is
    // HEAD-readable. Read-back still runs for the snapshot leg even
    // when per-flush verified it, because per-flush only checked HEAD
    // accessibility — the aggregator read-back is an additional check
    // the shutdown gate uniquely enforces.
    const pointer = this.host.options?.getPointerLayer?.() ?? null;
    if (snapshotCid && pointer) {
      legs.push(
        this.awaitAggregatorPointerReadBack(snapshotCid, deadline, controller.signal, reason),
      );
    }

    await Promise.allSettled(legs);
    clearTimeout(deadlineTimer);
  }

  /**
   * Leg 1 — drive `retryPendingPublishIfAny()` on a fast cadence until
   * the marker clears OR the deadline elapses. Emits
   * `shutdown:verification-timeout` (`leg: 'pending-publish-retry'`) on
   * deadline.
   */
  private async awaitPendingPublishCleared(
    deadline: number,
    signal: AbortSignal,
    reason: string | undefined,
  ): Promise<void> {
    const loopStartedAt = Date.now();
    let lastError: string | undefined;
    let lastCid: string | null = this.host.getPendingPublishCid();
    // Issue #450 stuck-progress detection: track the most recent
    // (cid, errorKey) tuple and how many CONSECUTIVE iterations have
    // observed it. When the count crosses `STUCK_PENDING_PUBLISH_THRESHOLD`,
    // emit `storage:pending-publish-stuck` and bail so cold-start
    // recovery on next boot handles the publish via the preserved
    // marker. See the constant's doc-comment for rationale.
    let lastFailureKey: string | null = null;
    let consecutiveSameFailures = 0;

    while (Date.now() < deadline && !signal.aborted) {
      const pending = this.host.getPendingPublishCid();
      if (!pending) return;
      lastCid = pending;

      try {
        const result = await this.retryPendingPublishIfAny();
        if (!result.attempted) {
          // Marker cleared between the check above and the retry —
          // we're done.
          return;
        }
        if (result.ok) {
          // Marker cleared inside the retry.
          return;
        }
        // Transient or permanent failure surface. Permanent leaves
        // marker cleared too (see `publishAggregatorPointerBestEffort`),
        // so we re-check at the top of the next loop iteration.
        lastError = result.code ?? (result.transient ? 'TRANSIENT' : 'PERMANENT');
      } catch (err) {
        // Issue #450 hardening: prefer a typed `.code` over the raw
        // message so the stuck-detection failureKey stays stable
        // iteration-over-iteration. Without this, a typed error whose
        // message embeds a varying value (e.g. elapsed-ms) would
        // produce a different key every loop and the counter would
        // never reach the threshold. In practice
        // `publishAggregatorPointerBestEffort` converts every internal
        // throw to a structured result before returning, so the catch
        // arm is currently dead code — this is defense-in-depth
        // against future regressions that let a typed error escape.
        const errCode =
          err && typeof (err as { code?: unknown }).code === 'string'
            ? (err as { code: string }).code
            : undefined;
        lastError = errCode ?? (err instanceof Error ? err.message : String(err));
      }

      // Issue #450: update the stuck-progress counter. Key combines
      // CID and error so a NEW pending CID or DIFFERENT failure code
      // resets the counter (we only bail on STABLE failure patterns).
      const failureKey = `${pending}|${lastError ?? 'unknown'}`;
      if (failureKey === lastFailureKey) {
        consecutiveSameFailures += 1;
      } else {
        consecutiveSameFailures = 1;
        lastFailureKey = failureKey;
      }
      if (consecutiveSameFailures >= STUCK_PENDING_PUBLISH_THRESHOLD) {
        const elapsedMs = Date.now() - loopStartedAt;
        this.host.log(
          `Shutdown durability: pending-publish appears stuck for ` +
            `cid=${pending} after ${consecutiveSameFailures} consecutive ` +
            `identical failures (lastError=${lastError ?? 'unknown'}, ` +
            `elapsedMs=${elapsedMs}). Bailing — cold-start retry on ` +
            `next boot will handle via preserved pendingPublishCid marker.`,
        );
        this.host.emitEvent({
          type: 'storage:pending-publish-stuck',
          timestamp: Date.now(),
          data: {
            cid: pending,
            consecutiveFailures: consecutiveSameFailures,
            lastError,
            elapsedMs,
            reason,
          },
          code: lastError,
        });
        // Also surface the existing verification-timeout signal so
        // operator dashboards routing on `shutdown:verification-timeout`
        // continue to receive this leg's terminal outcome.
        this.emitVerificationTimeout({
          leg: 'pending-publish-retry',
          cidsInQuestion: [pending],
          lastError,
          reason,
        });
        return;
      }

      if (signal.aborted || Date.now() >= deadline) break;

      const remaining = deadline - Date.now();
      const sleepMs = Math.min(PENDING_PUBLISH_RETRY_INTERVAL_MS, Math.max(0, remaining));
      if (sleepMs > 0) await this.sleepAbortable(sleepMs, signal);
    }

    // Marker may have cleared right at the abort/deadline boundary.
    if (!this.host.getPendingPublishCid()) return;

    this.emitVerificationTimeout({
      leg: 'pending-publish-retry',
      cidsInQuestion: lastCid ? [lastCid] : [],
      lastError,
      reason,
    });
  }

  /**
   * Leg 2 — wrap `verifyCidAccessibleWithRetry` for the bundle CID.
   * Emits `shutdown:verification-timeout` (`leg: 'pin-verify'`) on
   * `failureKind === 'deadline-exceeded'` or
   * `'gateway-not-serving'`. The `'aborted'` outcome is also surfaced
   * as a timeout — from the operator's perspective, the deadline (or
   * an abort) terminated the verification before it succeeded.
   */
  private async awaitPinVerified(
    bundleCid: string,
    deadline: number,
    signal: AbortSignal,
    reason: string | undefined,
  ): Promise<void> {
    const result: VerifyCidAccessibleResult = await verifyCidAccessibleWithRetry(
      this.host.ipfsGateways,
      bundleCid,
      {
        deadlineMs: Math.max(0, deadline - Date.now()),
        signal,
      },
    );
    if (result.ok) {
      this.host.log(
        `Shutdown durability: bundle ${bundleCid} HEAD-verified ` +
          `(attempts=${result.attempts}, elapsedMs=${result.elapsedMs})`,
      );
      return;
    }
    this.emitVerificationTimeout({
      leg: 'pin-verify',
      cidsInQuestion: [bundleCid],
      lastError: result.failureKind,
      reason,
    });
  }

  /**
   * Leg 3 — poll `pointer.recoverLatest()` until it returns
   * `snapshotCid` OR the deadline elapses. Emits
   * `shutdown:verification-timeout` (`leg: 'pointer-read-back'`) on
   * deadline. A transient `recoverLatest()` throw (network error)
   * is treated as a miss and the loop retries; permanent classification
   * surfaces as a `storage:error` via the lifecycle's existing
   * permanent-error path AND a verification-timeout event so the
   * shutdown record is complete.
   */
  private async awaitAggregatorPointerReadBack(
    snapshotCid: string,
    deadline: number,
    signal: AbortSignal,
    reason: string | undefined,
  ): Promise<void> {
    const pointer = this.host.options?.getPointerLayer?.() ?? null;
    if (!pointer) {
      // Defensive — the caller already gated on pointer being non-null,
      // but a teardown race could null it out between checks.
      this.emitVerificationTimeout({
        leg: 'pointer-read-back',
        cidsInQuestion: [snapshotCid],
        lastError: 'pointer-layer-unavailable',
        reason,
      });
      return;
    }

    let lastError: string | undefined;
    while (Date.now() < deadline && !signal.aborted) {
      let recovered: Awaited<ReturnType<typeof pointer.recoverLatest>> = null;
      try {
        recovered = await pointer.recoverLatest();
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (this.isPermanentPointerError(err)) {
          // Permanent failure — no point in retrying. Surface the
          // operator alert via the lifecycle's standard path AND the
          // verification-timeout event so the shutdown record is
          // complete.
          this.host.emitEvent(this.host.buildErrorEvent('storage:error', err));
          this.emitVerificationTimeout({
            leg: 'pointer-read-back',
            cidsInQuestion: [snapshotCid],
            lastError,
            reason,
          });
          return;
        }
        // Transient — fall through to sleep + retry.
      }

      // Treat all-unfetchable as "not yet recovered" — retry on next loop
      // iteration (within the deadline). The pointer chain exists but all
      // CARs are unreachable; keep trying until the deadline expires.
      // `'cid' in recovered` is the positive discriminant: RecoverResult has
      // `cid`, RecoverAllUnfetchableResult does not — TS narrows correctly.
      if (recovered && 'cid' in recovered) {
        try {
          const recoveredCidStr = CID.decode(recovered.cid).toString();
          if (recoveredCidStr === snapshotCid) {
            this.host.log(
              `Shutdown durability: aggregator read-back matched snapshot ` +
                `${snapshotCid} (version=${recovered.version})`,
            );
            return;
          }
          lastError = `aggregator returned different cid (${recoveredCidStr})`;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      } else if (!lastError) {
        lastError = 'aggregator returned null (no anchor yet)';
      }

      if (signal.aborted || Date.now() >= deadline) break;
      const remaining = deadline - Date.now();
      const sleepMs = Math.min(POINTER_READBACK_POLL_MS, Math.max(0, remaining));
      if (sleepMs > 0) await this.sleepAbortable(sleepMs, signal);
    }

    this.emitVerificationTimeout({
      leg: 'pointer-read-back',
      cidsInQuestion: [snapshotCid],
      lastError,
      reason,
    });
  }

  /**
   * Issue #239 — per-flush durability verification.
   *
   * Called by `FlushScheduler.flushToIpfs` AFTER pin + publish succeed,
   * before the flush is considered "done". Verifies that the just-
   * pinned CIDs are remotely fetchable by other peers (closes the
   * cross-process invoice-loss path documented in #234 / #239 where
   * `Sphere.destroy()` could return while the bundle CAR was still
   * propagating across HTTP gateways).
   *
   * Legs:
   *   1. **Bundle CID HEAD-accessible** on ≥1 IPFS gateway — the
   *      cross-device fetch path's critical block.
   *   2. **Snapshot CID HEAD-accessible** on ≥1 IPFS gateway — needed
   *      because cross-device recovery fetches the snapshot CAR first,
   *      then walks to bundle refs. Skipped when no snapshot was
   *      published (`snapshotCid === null`) — either because no pointer
   *      layer is wired OR because the publish returned a transient
   *      result (issue #241: a stale snapshot CID would be a no-op
   *      verify; only the bundle leg is checked in that case).
   *
   * NOT verified here:
   *   - **Aggregator `recoverLatest()` read-back of the snapshot CID.**
   *     The aggregator's read replicas can lag the primary by tens of
   *     seconds on testnet — verifying read-back per-flush would inject
   *     unacceptable latency into every save (every token receive /
   *     send / mint). The shutdown gate ({@link awaitRemoteDurability})
   *     does perform this leg with the configurable shutdown deadline,
   *     emitting a `shutdown:verification-timeout` event (warn-only,
   *     non-throwing) if the read-back doesn't catch up before exit.
   *     A successful `publishAggregatorPointerBestEffort` return already
   *     guarantees the aggregator COMMITTED the new version; only the
   *     replica catch-up is gapped, and the cold-start retry on next
   *     boot covers the small percentage of cases where the next
   *     process beats replica propagation.
   *
   * On ANY leg failing within the deadline, this method **throws** a
   * structured error so the caller (FlushScheduler) can propagate the
   * failure to `forceFlushSerialized`'s rejection arm. The at-least-
   * once gate (`awaitNextFlush` → `PaymentsModule.handleIncomingTransfer`)
   * then refuses to advance the Nostr `since` filter, the inbound event
   * replays on next reconnect, and the addToken stateHash dedup ensures
   * idempotency.
   *
   * Issue #241: only the IPFS pin legs gate the Nostr ack here. The
   * aggregator-publish durability (pointer read-back) is intentionally
   * NOT a per-flush leg — it's a liveness optimization for cold-import
   * discovery and is retried in background via `pendingPublishCid`.
   * Pin durability is the cross-device recoverability invariant.
   *
   * @param bundleCid    The UXF bundle CID just pinned via flushToIpfs.
   * @param snapshotCid  The lean-snapshot CID just published via
   *                      publishSnapshotIfWired. Null when no pointer
   *                      layer is wired.
   * @param deadlineMs   Total wall-clock budget across both legs.
   * @throws Error with code `FLUSH_DURABILITY_TIMEOUT` on any leg
   *         exhausting the deadline, with structured detail on which
   *         leg(s) failed.
   */
  async verifyFlushDurability(
    bundleCid: string,
    snapshotCid: string | null,
    deadlineMs: number,
  ): Promise<void> {
    // Issue #272 — short-circuit when both CIDs are already verified
    // within this provider's lifetime. Under replay storms the same
    // bundle CID can be presented many times (no save() in between);
    // each previous call to verifyFlushDurability stamped the watermark
    // (`setLastVerifiedBundleCid` below), so re-running ~80 HEAD probes
    // (4 awaitNextFlush iterations × 2 legs × ~10 retries each) is
    // pure wasted work that adds to the gateway contention this gate
    // is supposed to recover FROM.
    //
    // The watermark is cleared implicitly by a fresh flush on different
    // CIDs (the next per-flush gate either succeeds and updates it, or
    // fails and leaves it stale — shutdown still runs the legs on the
    // newer CIDs anyway). There is no TTL: the watermark is per-
    // provider-lifetime and a process restart clears it naturally.
    const verifiedBundle = this.host.getLastVerifiedBundleCid();
    const verifiedSnapshot = this.host.getLastVerifiedSnapshotCid();
    const bundleMatches = bundleCid === verifiedBundle;
    const snapshotMatches =
      snapshotCid === null || snapshotCid === verifiedSnapshot;
    if (bundleMatches && snapshotMatches) {
      this.host.log(
        `Profile durability: ${bundleCid} HEAD-verify short-circuited (already verified this lifetime)`,
      );
      return;
    }

    const deadline = Date.now() + Math.max(0, deadlineMs);

    // No shared abort signal — every leg honors `deadline` directly via
    // `Math.max(0, deadline - Date.now())`, and we wait for all legs
    // (Promise.all) regardless of any single leg's outcome. A controller-
    // based race against the same deadline can flip a happy-path success
    // into a spurious 'aborted' result when the controller's setTimeout
    // fires microseconds before the leg's own deadline check.
    const noAbort = new AbortController(); // never aborted; honored as a no-op signal
    const signal = noAbort.signal;

    // Always verify the bundle CID — it's the cross-device fetch path's
    // critical block.
    const legs: Array<Promise<{ leg: ShutdownVerificationLeg; ok: boolean; lastError?: string; cid: string }>> = [];
    legs.push(
      this.verifyPinLeg(bundleCid, deadline, signal),
    );

    // Verify the snapshot CID HEAD when a snapshot was actually
    // published. Cross-device recovery fetches the snapshot first, then
    // walks bundle refs; both layers must be remotely readable.
    if (snapshotCid) {
      legs.push(
        this.verifyPinLeg(snapshotCid, deadline, signal),
      );
    }

    const results = await Promise.all(legs);

    const failed = results.filter((r) => !r.ok);
    if (failed.length === 0) {
      // Stamp the verified watermark so the shutdown gate can skip its
      // own redundant verification when these same CIDs are still the
      // most-recent ones at destroy() time.
      this.host.setLastVerifiedBundleCid(bundleCid);
      if (snapshotCid) {
        this.host.setLastVerifiedSnapshotCid(snapshotCid);
      }
      return;
    }

    const cidsInQuestion = failed.map((f) => f.cid);
    const legSummary = failed.map((f) => `${f.leg}:${f.cid}=${f.lastError ?? 'fail'}`).join('; ');
    const err = new Error(
      `Flush durability verification timed out (${failed.length}/${results.length} legs failed): ` +
        legSummary,
    );
    (err as Error & { code?: string; details?: unknown }).code = 'FLUSH_DURABILITY_TIMEOUT';
    (err as Error & { code?: string; details?: unknown }).details = {
      failedLegs: failed.map((f) => ({ leg: f.leg, cid: f.cid, lastError: f.lastError })),
      cidsInQuestion,
    };
    throw err;
  }

  /**
   * Single pin-verify leg used by both the shutdown gate and the
   * per-flush gate. Returns a structured result instead of emitting /
   * throwing so each caller can compose the legs differently.
   */
  private async verifyPinLeg(
    cid: string,
    deadline: number,
    signal: AbortSignal,
  ): Promise<{ leg: 'pin-verify'; ok: boolean; lastError?: string; cid: string }> {
    const result = await verifyCidAccessibleWithRetry(
      this.host.ipfsGateways,
      cid,
      { deadlineMs: Math.max(0, deadline - Date.now()), signal },
    );
    if (result.ok) {
      this.host.log(
        `Profile durability: ${cid} HEAD-verified (attempts=${result.attempts}, elapsedMs=${result.elapsedMs})`,
      );
      return { leg: 'pin-verify', ok: true, cid };
    }
    return { leg: 'pin-verify', ok: false, lastError: result.failureKind, cid };
  }

  /**
   * Single pointer-read-back leg used by both the shutdown gate and
   * the per-flush gate. Returns a structured result for the same
   * composition reason as {@link verifyPinLeg}.
   */
  private async verifyPointerReadBackLeg(
    snapshotCid: string,
    deadline: number,
    signal: AbortSignal,
  ): Promise<{ leg: 'pointer-read-back'; ok: boolean; lastError?: string; cid: string }> {
    const pointer = this.host.options?.getPointerLayer?.() ?? null;
    if (!pointer) {
      return {
        leg: 'pointer-read-back',
        ok: false,
        lastError: 'pointer-layer-unavailable',
        cid: snapshotCid,
      };
    }

    let lastError: string | undefined;
    while (Date.now() < deadline && !signal.aborted) {
      let recovered: Awaited<ReturnType<typeof pointer.recoverLatest>> = null;
      try {
        recovered = await pointer.recoverLatest();
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (this.isPermanentPointerError(err)) {
          // Permanent failures surface via the lifecycle's standard
          // `storage:error` path — the per-flush gate also throws
          // through the caller (it's a verification failure either way).
          this.host.emitEvent(this.host.buildErrorEvent('storage:error', err));
          return {
            leg: 'pointer-read-back',
            ok: false,
            lastError,
            cid: snapshotCid,
          };
        }
      }

      // All-unfetchable is treated as "not yet matching" — retry within deadline.
      // `'cid' in recovered` is the positive discriminant: RecoverResult has
      // `cid`, RecoverAllUnfetchableResult does not — TS narrows correctly.
      if (recovered && 'cid' in recovered) {
        try {
          const recoveredStr = CID.decode(recovered.cid).toString();
          if (recoveredStr === snapshotCid) {
            this.host.log(
              `Profile durability: aggregator read-back matched ${snapshotCid} ` +
                `(version=${recovered.version})`,
            );
            return { leg: 'pointer-read-back', ok: true, cid: snapshotCid };
          }
          lastError = `aggregator returned different cid (${recoveredStr})`;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      } else if (!lastError) {
        lastError = 'aggregator returned null (no anchor yet)';
      }

      if (signal.aborted || Date.now() >= deadline) break;
      const remaining = deadline - Date.now();
      const sleepMs = Math.min(POINTER_READBACK_POLL_MS, Math.max(0, remaining));
      if (sleepMs > 0) await this.sleepAbortable(sleepMs, signal);
    }

    return {
      leg: 'pointer-read-back',
      ok: false,
      lastError,
      cid: snapshotCid,
    };
  }

  /**
   * Issue #239 — emit a structured `shutdown:verification-timeout`
   * event. Centralised so the payload shape is uniform across the
   * three legs.
   */
  private emitVerificationTimeout(payload: {
    readonly leg: ShutdownVerificationLeg;
    readonly cidsInQuestion: readonly string[];
    readonly lastError?: string;
    readonly reason?: string;
  }): void {
    this.host.log(
      `Shutdown durability TIMEOUT leg=${payload.leg} cids=[${payload.cidsInQuestion.join(',')}] ` +
        `lastError=${payload.lastError ?? 'unknown'} reason=${payload.reason ?? 'none'}`,
    );
    this.host.emitEvent({
      type: 'shutdown:verification-timeout',
      timestamp: Date.now(),
      data: {
        leg: payload.leg,
        cidsInQuestion: [...payload.cidsInQuestion],
        lastError: payload.lastError,
        reason: payload.reason,
      },
    });
  }

  /**
   * Resolves after `ms` ms OR when `signal` aborts (whichever first).
   * Local helper for the verification legs' inter-attempt sleeps so a
   * shared deadline tears them all down promptly.
   */
  private sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      if (signal.aborted) {
        clearTimeout(timer);
        resolve();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // ===========================================================================
  // Cold-start recovery
  // ===========================================================================

  /**
   * Classify a pointer-layer error as TRANSIENT (retry on next flush
   * / cold-start, no user action needed) or PERMANENT (user / operator
   * must intervene — wallet state is poisoned or aggregator rotation
   * requires SDK update). Used to decide whether to silently swallow
   * the error or surface it via a `storage:error` event.
   *
   * Non-exhaustive — unknown codes default to TRANSIENT on the premise
   * that "keep running and retry" is safer than "break the wallet".
   * Add to PERMANENT_POINTER_ERROR_CODES below when a new permanent
   * failure mode is introduced.
   */
  isPermanentPointerError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const code = (err as { code?: unknown }).code;
    if (typeof code !== 'string') return false;
    return PERMANENT_POINTER_ERROR_CODES.has(code);
  }

  /**
   * Publish the just-flushed CID to the aggregator pointer layer.
   *
   * Returns a structured result instead of swallowing failures so the
   * caller (FlushScheduler) can route transient failures via a soft
   * event without closing the at-least-once gate. The persistence of
   * the retry marker (`pendingPublishCid`) is handled here:
   *
   *   - SUCCESS — clears `pendingPublishCid`, anchors
   *     `lastDiscoveredPointerCid`, returns `{ ok: true }`.
   *   - TRANSIENT failure — sets `pendingPublishCid = cidString` (with
   *     localCache persistence for crash safety), returns
   *     `{ ok: false, transient: true, code? }`. Issue #241: callers
   *     route this to a `storage:pending-publish` event instead of
   *     throwing — the at-least-once Nostr gate is decoupled from
   *     aggregator-publish durability and rides on IPFS pin
   *     durability alone (which is the actual cross-device
   *     recoverability invariant). The pending marker is retried
   *     at start of every subsequent `flushToIpfs` and
   *     `runPointerPollOnce`.
   *
   *     A WALKBACK_FLOOR transient (aggregator read-replica lagging
   *     behind a version this wallet has already confirmed locally)
   *     additionally emits a typed `storage:replica-lag` event so
   *     operators can distinguish it from generic network
   *     transients in monitoring.
   *
   *   - PERMANENT failure (UNREACHABLE_RECOVERY_BLOCKED, REJECTED,
   *     UNTRUSTED_PROOF, TRUST_BASE_STALE, MARKER_CORRUPT, CORRUPT_STREAK,
   *     SECURITY_ORIGIN_MISMATCH, CAPABILITY_DENIED, UNSUPPORTED_RUNTIME,
   *     PROTOCOL_ERROR, AGGREGATOR_REJECTED) — emits `storage:error`
   *     event with the error code, clears `pendingPublishCid` (no
   *     retry would help; surfacing is the action), returns
   *     `{ ok: false, transient: false, code }`. Callers ack the event
   *     so the wallet does not deadlock on a permanently-failing
   *     publish — operator intervention is required and is surfaced
   *     via the emitted event.
   *
   * Returns `{ ok: false, transient: false }` (treated as permanent)
   * if no pointer-layer closure is wired — the wallet is not
   * configured for aggregator anchoring, so there's nothing to do.
   */
  async publishAggregatorPointerBestEffort(
    cidString: string,
  ): Promise<{ readonly ok: boolean; readonly transient: boolean; readonly code?: string }> {
    const pointer = this.host.options?.getPointerLayer?.() ?? null;
    if (!pointer) {
      // No pointer wiring — nothing to retry, no transient classification.
      this.host.setPendingPublishCid(null);
      return { ok: false, transient: false };
    }

    // Issue #247 — coalesce concurrent callers onto the in-flight
    // publish. PR #245's throttle (below) only stops SEQUENTIAL bursts:
    // parallel callers (flushScheduler publish + debounced
    // dispatchDirtyFlush + retryPendingPublishIfAny from periodic poll)
    // all pass the entry check before any catch arm fires, then all
    // call `pointer.publish()` in parallel, then all 6+ print the same
    // WARN line on the way back out. Awaiting the in-flight promise
    // collapses these to a single publish + a single result for every
    // caller in the window.
    //
    // Note: a coalesced caller may have arrived with a DIFFERENT
    // `cidString` than the in-flight publish (e.g. a fresh
    // save-driven flush after the prior bundle CID). In that case the
    // coalesced caller still receives the in-flight result; on the
    // next flush cycle, a fresh `publishAggregatorPointerBestEffort`
    // call with the latest CID will run normally. This trades a
    // single-cycle latency for the new CID against eliminating the
    // storm.
    if (this.walkbackPublishInFlight !== null) {
      return await this.walkbackPublishInFlight;
    }

    // Issue #245 #3 — short-circuit while a WALKBACK_FLOOR throttle is
    // active. Returns the same shape as the transient-failure arm so
    // callers (flushToIpfs / retryPendingPublishIfAny) keep the
    // `pendingPublishCid` marker live and hold the at-least-once gate
    // closed. No log line per skip — only a summary when the throttle
    // clears (in the catch arm or the success arm).
    const nowMs = Date.now();
    if (nowMs < this.walkbackFloorThrottleUntilMs) {
      this.walkbackFloorThrottleSkipCount += 1;
      // Mark the pending CID — caller may have invoked with a fresh
      // CID (save-driven flush) that we couldn't publish yet. Set
      // unconditionally so a wakeup retry uses the most recent CID
      // rather than a stale one.
      this.host.setPendingPublishCid(cidString);
      return { ok: false, transient: true, code: WALKBACK_FLOOR_CODE };
    }

    // Issue #247 — body wrapped in an IIFE assigned to
    // `walkbackPublishInFlight` so concurrent callers (above)
    // observe the same result. Cleared in the `finally` so the
    // next call after this resolves starts fresh (or hits the
    // throttle if this call armed it).
    const inFlight = (async () => {
      try {
        const cidBytes = CID.parse(cidString).bytes;
        const result = await pointer.publish(async () => cidBytes);

        // Issue #330 — inline durability gate. Before stamping
        // `lastDiscoveredPointerCid` (which is read by the no-data
        // flush short-circuit at `flush-scheduler.ts:700` and would
        // otherwise mask deferred work behind a stale CID) AND before
        // clearing `pendingPublishCid`, HEAD-verify the just-published
        // snapshot CID is fetchable from the configured IPFS gateways.
        // This closes the "publish-before-durable" gap that produces
        // the cross-device 404s in #330.
        //
        // The gate uses the same `verifyPinLeg` machinery as
        // `verifyFlushDurability` (which after PR #272 runs in
        // background). The flush still completes synchronously — only
        // the marker-clear is gated. On HEAD-verify timeout we treat
        // the publish as transient-failed (marker stays, retry on next
        // flush / pointer poll); the FlushScheduler routes the typed
        // result to `storage:pending-publish` so operators see the
        // deferred state.
        //
        // We pass `snapshotCid: null` (NOT the same `cidString` again):
        // `verifyFlushDurability` pushes one `verifyPinLeg` per non-
        // null CID, so passing it twice would double the HEAD probes
        // against the same CID — pointless and doubles gateway load.
        // The semantics of `verifyFlushDurability` are "verify
        // bundle (mandatory) + snapshot (when provided)"; here the
        // snapshot CID and the bundle CID are the same thing (it's
        // the only CID this publish references), so the snapshot leg
        // is folded into the bundle leg.
        //
        // Default 0 (no gate) preserves current behaviour for tests
        // and stub-pointer fixtures. The wallet factories opt-in with
        // 5_000 ms (`createBrowserProfileProviders`,
        // `createNodeProfileProviders`).
        const inlineGateMs =
          this.host.options?.pointerPublishDurabilityGateMs ?? 0;
        if (inlineGateMs > 0) {
          try {
            await this.verifyFlushDurability(cidString, null, inlineGateMs);
          } catch (verifyErr) {
            // HEAD-verify failed within the gate deadline. Keep the
            // marker live so a subsequent flush / pointer poll re-runs
            // this method (and re-HEADs the same CID against the
            // gateway). DO NOT stamp `lastDiscoveredPointerCid` —
            // leaving it at its previous (verified) value keeps the
            // no-data flush short-circuit honest.
            //
            // Event emit: the FlushScheduler caller emits
            // `storage:pending-publish` on transient publish failure
            // (`flush-scheduler.ts:1490-1501`). Suppress the emit here
            // to avoid the double-event in the flush path. The
            // pointer-poll path (`runPointerPollOnce` →
            // `retryPendingPublishIfAny`) does not emit on transient
            // either, so the gate-failure case there is silent at the
            // event surface; the log line below covers operator
            // forensics for both paths.
            this.host.setPendingPublishCid(cidString);
            this.host.log(
              `Pointer publish ok (aggregator) but IPFS HEAD-verify timed out within ${inlineGateMs}ms gate ` +
                `for cid=${cidString} — keeping pendingPublishCid for retry. ` +
                `Local state is durable; cross-device recovery is held until gateway propagation completes. ` +
                `verifyErr=${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}`,
            );
            return {
              ok: false as const,
              transient: true as const,
              code: 'IPFS_NOT_YET_DURABLE' as const,
            };
          }
        }

        // Gate passed (or was disabled) — NOW stamp the verified CID
        // and clear the retry marker.
        this.host.setLastDiscoveredPointerCid(cidString);
        // Clear any previously-pending marker — this publish succeeded,
        // so the cross-device recovery path can now reach the bundle.
        this.host.setPendingPublishCid(null);
        // Issue #245 #3 — successful publish clears the throttle and
        // logs the prior skip count (operator visibility on how much
        // noise was suppressed).
        if (this.walkbackFloorThrottleSkipCount > 0) {
          this.host.log(
            `Pointer publish recovered after ${this.walkbackFloorThrottleSkipCount} ` +
              `WALKBACK_FLOOR-throttled skip(s).`,
          );
        }
        this.walkbackFloorThrottleUntilMs = 0;
        this.walkbackFloorThrottleSkipCount = 0;
        this.host.log(
          `Pointer publish ok: cid=${cidString} version=${result.version} attempts=${result.attemptsUsed}`,
        );
        // NEEDS-FIX #2: emit the same typed event on the publish path when
        // conflict-driven rediscovery skipped past CAR_TRANSIENT versions.
        // The fast-path (attempt 0, no walkback) always produces an empty
        // list, so this branch fires only when a conflict forced Phase 3.
        if (result.walkbackUnfetchableSkipped && result.walkbackUnfetchableSkipped.length > 0) {
          const publishSkipped = result.walkbackUnfetchableSkipped;
          this.host.emitEvent(
            this.host.buildErrorEvent(
              'storage:pointer-version-skipped-unfetchable',
              new Error(
                `Pointer publish (conflict-rediscovery): walkback skipped ` +
                  `${publishSkipped.length} EXISTS-BUT-UNFETCHABLE version(s): ` +
                  `[${publishSkipped.join(', ')}]. Published at version=${result.version}; ` +
                  `the listed slot(s) had authentic proofs but unreachable CARs.`,
              ),
              'POINTER_VERSIONS_SKIPPED_UNFETCHABLE',
            ),
          );
        }
        // RFC-251 Approach D / issue #255 Problem B — emit the
        // pointer-published event so the wiring layer (Sphere) can
        // broadcast the win to sibling devices over Nostr. Siblings
        // sharing this wallet's identity adopt V=N without waiting for
        // the aggregator's 30-60 s read-replica lag.
        //
        // The crypto (build payload + sign with pointer signer) is done
        // here because we have the pointer layer ref; the wiring layer
        // (Sphere) just publishes the resulting wire-ready JSON over
        // Nostr with the supplied tag. Keeps Sphere stateless w.r.t.
        // pointer signing keys.
        //
        // Best-effort: any failure during sign / emit is logged and
        // dropped — the publish-success return path is the contract.
        //
        // Issue #264 — gated behind the `enablePointerWinBroadcasts`
        // capability (default OFF). When the flag is false the entire
        // sign + emit block is skipped: no payload built, no event
        // emitted, nothing for Sphere's `forwardPointerPublishedToNostr`
        // to forward. Convergence still works via the aggregator pointer
        // alone — broadcasts are an optimization, not a correctness
        // requirement.
        //
        // Tolerant of pointer stubs that predate the
        // `winBroadcastsEnabled` accessor (e.g. unit-test fakes): a
        // missing method is treated as flag=false (fail-closed). The
        // production code path always builds a real `ProfilePointerLayer`
        // which implements the method.
        // Defensive try/catch around the accessor: the
        // `winBroadcastsEnabled()` contract is "MUST be a pure
        // accessor, MUST NOT throw" (see ProfilePointerLayer doc),
        // but a misbehaving stub could violate it. Without this
        // catch, an accessor throw would escape to the broad outer
        // catch (~line 1326) and be misclassified as a TRANSIENT
        // publish failure returning `{ ok: false, transient: true,
        // code: 'UNCLASSIFIED' }` — making the entire publish
        // appear to have failed even though it had already
        // succeeded. Treat the throw as flag=false (fail-closed
        // policy), which silently disables broadcasts for this
        // publish but lets the publish itself report success.
        let winBroadcastsOn = false;
        try {
          winBroadcastsOn =
            typeof pointer.winBroadcastsEnabled === 'function' &&
            // Strict `=== true` to mirror the production
            // ProfilePointerLayer constructor's normalization (which
            // freezes the snapshot as `=== true`). A test stub that
            // returns a truthy non-boolean (`1`, `'yes'`, `{}`) MUST be
            // treated as flag=false — same fail-closed policy as
            // production config. Symmetric with the Sphere subscriber
            // guard in `core/Sphere.ts:maybeInstallPointerWinSubscription`.
            pointer.winBroadcastsEnabled() === true &&
            // Symmetric with the new accessor: stubs lacking the signer
            // helper fall through cleanly (fail-closed) rather than
            // surfacing a TypeError caught only by the broad catch arm
            // below. The two accessors are added together on real
            // ProfilePointerLayer instances; a stub omitting one but
            // not the other is a test-harness shape, not a production
            // path.
            typeof pointer.getSignerForWinBroadcast === 'function';
        } catch (accessorErr) {
          const msg =
            accessorErr instanceof Error
              ? accessorErr.message
              : String(accessorErr);
          this.host.log(
            `Pointer publish: winBroadcastsEnabled() threw (accessor ` +
              `contract violation, treating as flag=false): ${msg}`,
          );
          winBroadcastsOn = false;
        }
        // PR #316 F2 fix — emit `storage:pointer-published` UNCONDITIONALLY
        // on every successful publish. Previously this event only fired when
        // `winBroadcastsOn === true` (issue #264 default-OFF gate), so any
        // listener wanting a "publish landed" signal (e.g.,
        // `sphere.profile.resetEpoch` awaiting the post-bump version) was
        // dead-on-arrival in the default config.
        //
        // The event shape now carries `cid` + `version` + `attemptsUsed`
        // on every emit. The `signedPayloadJson` / `broadcastTag` fields
        // remain conditional on `winBroadcastsOn` — Sphere's
        // `forwardPointerPublishedToNostr` already short-circuits when
        // they are absent (see the type-narrow check in core/Sphere.ts).
        // Sphere's `maybeInstallPointerWinSubscription` also gates on
        // `winBroadcastsEnabled()` so the unconditional emit cannot
        // accidentally arm a sibling subscription.
        let signedPayloadJson: string | undefined;
        let broadcastTag: string | undefined;
        if (winBroadcastsOn) {
          try {
            const signerHandle = pointer.getSignerForWinBroadcast();
            const signed = await signWinBroadcastPayload(signerHandle.signer, {
              _kind: WIN_BROADCAST_KIND_MARKER,
              v: WIN_BROADCAST_SCHEMA_VERSION,
              version: result.version,
              cid: cidString,
              signingPubKey: signerHandle.signingPubKeyHex,
              ts: Date.now(),
            });
            signedPayloadJson = JSON.stringify(signed);
            broadcastTag = buildWinBroadcastTag(signerHandle.signingPubKeyHex);
          } catch (broadcastErr) {
            const errMsg =
              broadcastErr instanceof Error
                ? broadcastErr.message
                : String(broadcastErr);
            this.host.log(
              `Pointer publish: win-broadcast build/sign failed (best-effort, ` +
              `ignored): ${errMsg}`,
            );
          }
        }
        this.host.emitEvent({
          type: 'storage:pointer-published',
          timestamp: Date.now(),
          data: {
            cid: cidString,
            version: result.version,
            attemptsUsed: result.attemptsUsed,
            ...(signedPayloadJson !== undefined ? { signedPayloadJson } : {}),
            ...(broadcastTag !== undefined ? { broadcastTag } : {}),
          },
        });
        return { ok: true, transient: false } as const;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (this.isPermanentPointerError(err)) {
          const code = (err as { code?: string }).code ?? 'UNKNOWN';
          this.host.log(`Pointer publish PERMANENT failure (${code}): ${msg}`);
          this.host.emitEvent(this.host.buildErrorEvent('storage:error', err));
          // Permanent failures: drop the retry marker. The operator
          // alert event is the call to action; auto-retry would just
          // hammer a wallet that needs human intervention.
          this.host.setPendingPublishCid(null);
          // Issue #245 #3 — permanent failure also clears the WALKBACK
          // throttle (it no longer applies — we've decided to stop
          // retrying entirely).
          this.walkbackFloorThrottleUntilMs = 0;
          this.walkbackFloorThrottleSkipCount = 0;
          return { ok: false, transient: false, code } as const;
        }
        // Elevate the transient publish failure to warn-level so the
        // operator sees the underlying cause without enabling debug.
        // Issue #241: this no longer holds the at-least-once gate
        // closed (the flush proceeds and stamps a pending-publish
        // marker), but the underlying cause is still useful for
        // diagnosis when a wallet stays in pending-publish for long.
        const transientCode =
          typeof (err as { code?: unknown }).code === 'string'
            ? (err as { code: string }).code
            : 'UNCLASSIFIED';
        logger.warn(
          'Profile-TokenStorage',
          `Pointer publish failed (transient, code=${transientCode}, cid=${cidString}): ${msg}`,
        );
        // Issue #241 + #245 #3 + #247 — combined handling of
        // WALKBACK_FLOOR transient:
        //   - #241: emit a typed `storage:replica-lag` event so monitoring
        //     can distinguish replica-lag stalls from generic transients
        //     (network blips, gateway hiccups). All other transients flow
        //     through the generic `storage:pending-publish` event emitted
        //     by the caller (FlushScheduler).
        //   - #245 #3: arm the outer throttle so subsequent flushes
        //     short-circuit instead of burning another ~9-15s of inner
        //     reconcile-retry budget. A non-WALKBACK transient AFTER a
        //     WALKBACK clears the throttle (the prior diagnosis no longer
        //     applies — different fault class).
        //   - #247: attempt a same-identity cross-device reconcile BEFORE
        //     arming the throttle. Two devices sharing one wallet identity
        //     each push localVersion ahead of the aggregator's currently-
        //     visible value; both then hit W7 WALKBACK_FLOOR (per SPEC,
        //     deterministic-given-state) and the inner retry budget
        //     exhausts without convergence because every subsequent
        //     publish at this version reproduces the floor. Ask the
        //     aggregator what's currently visible (recoverLatest()
        //     authenticates the candidate as same-author via XOR-decode
        //     of the inclusion proof under this wallet's xorSeed — only
        //     a commitment authored under this signing identity can
        //     surface as a non-null result, so a foreign commitment is
        //     NEVER accepted as a downgrade), and if the visible version
        //     is strictly below our local cursor, adopt it as the new
        //     baseline. The next publish then operates from a floor the
        //     aggregator can see — converging.
        //
        //     Done OPPORTUNISTICALLY: if recoverLatest fails (network
        //     blip, discovery error) or the visible version is >= our
        //     local cursor (genuine replica lag, no same-identity race),
        //     fall through to the standard throttle arming below.
        if (transientCode === WALKBACK_FLOOR_CODE) {
          this.host.emitEvent({
            type: 'storage:replica-lag',
            timestamp: Date.now(),
            data: { cid: cidString, code: transientCode, message: msg },
          });
          let reconciledDownward = false;
          try {
            const recovered = await pointer.recoverLatest({
              abortSignal: this.getDestroySignal(),
            });
            // Only attempt downward reconcile when we have a concrete RecoverResult
            // (cid + version). RecoverAllUnfetchableResult (all-unfetchable) has no
            // fetchable version to adopt as a new baseline, so skip the downgrade.
            // `'cid' in recovered` is the positive discriminant — TS narrows to RecoverResult.
            if (recovered && 'cid' in recovered) {
              const outcome = await pointer.reconcileLocalVersionDownward(recovered as RecoverResult);
              if (outcome.reconciled) {
                reconciledDownward = true;
                this.host.log(
                  `Pointer publish reconciled localVersion downward: ` +
                    `from=${outcome.fromVersion} to=${outcome.toVersion} ` +
                    `(same-identity cross-device race; baseline now matches ` +
                    `aggregator-visible version).`,
                );
                this.host.emitEvent({
                  type: 'storage:replica-lag-reconciled',
                  timestamp: Date.now(),
                  data: {
                    cid: cidString,
                    fromVersion: outcome.fromVersion,
                    toVersion: outcome.toVersion,
                  },
                });
              }
            }
          } catch (reconcileErr) {
            // Reconciliation is best-effort — log and fall through to
            // throttle arming. pendingPublishCid stays stamped below;
            // the next flush / poll retries normally.
            const recMsg =
              reconcileErr instanceof Error
                ? reconcileErr.message
                : String(reconcileErr);
            this.host.log(
              `Pointer publish: WALKBACK_FLOOR reconcile attempt failed ` +
                `(${recMsg}); falling through to throttle.`,
            );
          }
          if (reconciledDownward) {
            // Reconciliation succeeded — DO NOT arm the throttle. The
            // next publish attempt from the reconciled baseline has a
            // fresh chance to land; throttling would only delay the
            // convergence we just unblocked. Clear any prior throttle
            // skip-count so the next non-throttled outcome doesn't log
            // a stale summary.
            this.walkbackFloorThrottleUntilMs = 0;
            this.walkbackFloorThrottleSkipCount = 0;
          } else {
            this.walkbackFloorThrottleUntilMs =
              Date.now() + WALKBACK_FLOOR_RETRY_THROTTLE_MS;
            this.walkbackFloorThrottleSkipCount = 0;
          }
        } else {
          if (this.walkbackFloorThrottleSkipCount > 0) {
            this.host.log(
              `Pointer publish: ${this.walkbackFloorThrottleSkipCount} ` +
                `WALKBACK_FLOOR-throttled skip(s) cleared by new transient code=${transientCode}.`,
            );
          }
          this.walkbackFloorThrottleUntilMs = 0;
          this.walkbackFloorThrottleSkipCount = 0;
        }
        // Transient: stamp the retry marker (with localCache persistence
        // for crash safety) so subsequent flushes / polls re-attempt
        // before any new save-driven work.
        this.host.setPendingPublishCid(cidString);
        return { ok: false, transient: true, code: transientCode } as const;
      }
    })();
    this.walkbackPublishInFlight = inFlight;
    try {
      return await inFlight;
    } finally {
      // Only clear if THIS call's promise is still latched (defensive
      // against a re-entrant call replacing it via the early-return
      // path above — which cannot happen with the current code shape,
      // but the guard makes the invariant explicit).
      if (this.walkbackPublishInFlight === inFlight) {
        this.walkbackPublishInFlight = null;
      }
    }
  }

  /**
   * If a previous publish left `pendingPublishCid` non-null, try
   * again. Called at the start of every `flushToIpfs` and every
   * `runPointerPollOnce` so the retry is gated on the normal flush
   * cadence rather than a dedicated timer.
   *
   * Returns the same result shape as `publishAggregatorPointerBestEffort`
   * with an additional `attempted` flag:
   *   - `attempted: false` when no marker is set (caller proceeds).
   *   - `attempted: true` when a retry was made (result indicates
   *     whether the marker was cleared).
   */
  async retryPendingPublishIfAny(): Promise<{
    readonly attempted: boolean;
    readonly ok: boolean;
    readonly transient: boolean;
    readonly code?: string;
  }> {
    const pending = this.host.getPendingPublishCid();
    if (!pending) {
      return { attempted: false, ok: true, transient: false };
    }
    this.host.log(`Retrying pending pointer publish: cid=${pending}`);
    const result = await this.publishAggregatorPointerBestEffort(pending);
    return { attempted: true, ok: result.ok, transient: result.transient, code: result.code };
  }

  /**
   * Try to rebuild the local bundle set from the aggregator pointer
   * layer's last valid CID. Returns `true` iff a bundle ref was
   * recorded (caller should skip the IPNS fallback). Returns `false`
   * when the pointer has no anchor yet or transiently failed — the
   * caller falls through to IPNS.
   */
  private async recoverFromAggregatorPointerBestEffort(): Promise<boolean> {
    // Wait for the pointer layer with a "build status"-aware policy.
    //
    // History: the original 5s ceiling conflated "build in flight on
    // slow CI" with "build will never produce one (no oracle wired)".
    // Both manifested as `getPointerLayer() === null` after 5s, and
    // both fell through to the legacy IPNS migration. On a fast happy
    // path the legacy path is a harmless no-op (no IPNS history). On
    // an oracle-wired-but-slow boot, the legacy path FORKS the pointer
    // chain: it stamps `profile.pointer.migration.done` AND seeds the
    // bundle index from the (probably empty) IPNS state, while the
    // deferred pointer build is still in flight elsewhere. Subsequent
    // flushes then publish a NEW pointer chain divergent from the one
    // the build was about to recover.
    //
    // Steelman fix: ask the storage provider whether a build is
    // pending. If yes, wait up to 30s (room for slow Helia bootstrap +
    // master-key denylist + lock-file acquisition on Node CI). If no
    // (no oracle, sticky skip, structurally unavailable), bail
    // immediately so the caller can take the legacy path with full
    // knowledge that no future build will reconcile.
    //
    // Wave G.7+ refinement: if no `getPointerLayer` closure is wired at
    // all, polling is structurally pointless — there is no codepath
    // that could ever flip the result from null to non-null. Bail
    // immediately. The previous code waited a full 30s in that case,
    // which manifested as test-suite hangs on every test fixture that
    // omitted the pointer wiring (the ProfileTokenStorageProvider unit
    // tests, the wave-g7-prereq fixtures, etc.). Production wallets
    // always wire `getPointerLayer` when an oracle is configured, so
    // this short-circuit only affects test fixtures and degenerate
    // setups; the slow-build-on-CI scenario is preserved when the
    // closure IS wired but returns null transiently.
    const getPointerLayer = this.host.options?.getPointerLayer;
    if (!getPointerLayer) {
      this.host.log(
        'Pointer recover: no getPointerLayer closure wired; ' +
          'skipping pointer-layer wait, falling through to legacy IPNS migration',
      );
      return false;
    }
    const getStatus = this.host.options?.getPointerBuildStatus;
    const pollDeadline = Date.now() + 30_000;
    let pointer = getPointerLayer() ?? null;
    while (!pointer && Date.now() < pollDeadline) {
      // If the build status accessor reports a deterministic
      // 'unavailable', skip the wait entirely — polling won't help.
      if (getStatus && getStatus() === 'unavailable') {
        this.host.log(
          'Pointer recover: build status reports unavailable (no oracle / sticky skip); ' +
            'skipping pointer-layer wait, falling through to legacy IPNS migration',
        );
        return false;
      }
      await new Promise((r) => setTimeout(r, 100));
      pointer = getPointerLayer() ?? null;
    }
    if (!pointer) {
      const status = getStatus ? getStatus() : 'unknown';
      this.host.log(
        `Pointer recover: no pointer layer wired after 30s wait (build status=${status}); ` +
          (status === 'pending'
            ? 'build is still in flight — bailing to avoid legacy-fallback fork. ' +
              'Subsequent sync()s will retry once the build completes.'
            : 'wallet has no aggregator pointer recovery (e.g., oracle not configured)'),
      );
      // When the build is STILL pending, we MUST NOT fall through to
      // the legacy IPNS migration: doing so could stamp the migration-
      // done marker before the eventual successful build observes it.
      // Returning `true` here tells the caller "pointer path was the
      // chosen path; do not fall back to legacy" — even though no CID
      // was recovered. The next sync() will retry the recovery via
      // the standard `coldStartLoadNeeded` gate.
      return status === 'pending';
    }

    let recovered: Awaited<ReturnType<typeof pointer.recoverLatest>>;
    try {
      recovered = await pointer.recoverLatest({
        abortSignal: this.getDestroySignal(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.isPermanentPointerError(err)) {
        const code = (err as { code?: string }).code ?? 'UNKNOWN';
        this.host.log(`Pointer recover PERMANENT failure (${code}): ${msg}`);
        this.host.emitEvent(this.host.buildErrorEvent('storage:error', err));
        return true;
      }
      this.host.log(`Pointer recover failed (transient, best-effort): ${msg}`);
      return false;
    }

    // Distinguish three recovery outcomes:
    //   1. null                    — fresh wallet, no pointer published → fall through to legacy IPNS.
    //   2. RecoverAllUnfetchableResult — pointer chain exists but every CAR unreachable →
    //                                    do NOT fall through to legacy; retry next poll.
    //   3. RecoverResult           — VALID version found; proceed to applySnapshot.
    if (!recovered) {
      this.host.log('Pointer recover: no anchor published yet');
      return false;
    }

    // Case 2: pointer chain exists but every CAR was CAR_TRANSIENT (no fetchable version).
    // Refusing legacy IPNS fallback prevents stamping the migration-done marker before
    // IPFS gateways come back up. Return true (pointer path chosen) so the caller
    // does not fall through to legacy. The next poll cycle retries.
    if ('kind' in recovered && recovered.kind === 'all-unfetchable') {
      const allSkipped = recovered.walkbackUnfetchableSkipped;
      this.host.emitEvent(
        this.host.buildErrorEvent(
          'storage:pointer-version-skipped-unfetchable',
          new Error(
            `Pointer recover: all ${allSkipped.length} known anchor version(s) ` +
              `EXISTS-BUT-UNFETCHABLE: [${allSkipped.join(', ')}]. ` +
              `No VALID predecessor was found. Refusing legacy IPNS fallback — ` +
              `the pointer chain is intact; IPFS gateways may be temporarily unreachable. ` +
              `Recovery will be re-attempted on the next pointer poll cycle.`,
          ),
          'POINTER_VERSIONS_SKIPPED_UNFETCHABLE',
        ),
      );
      // Return true: pointer path was chosen (prevents legacy IPNS fork).
      return true;
    }

    // Case 3: VALID version found.
    // At this point `recovered` is narrowed to RecoverResult (null + all-unfetchable
    // both returned early above). TypeScript's control-flow analysis does not narrow
    // `RecoverResult | RecoverAllUnfetchableResult` through `'kind' in …` early-return
    // guards because `RecoverResult` has no `kind` discriminant field declared — the
    // structural check is ambiguous in TS's view. Explicit cast is safe: both prior
    // guards exhausted every non-RecoverResult case.
    const validRecovered = recovered as RecoverResult;

    // Emit skipped-versions event if Phase 3 walkback skipped past
    // EXISTS-BUT-UNFETCHABLE (CAR_TRANSIENT) versions. host.log is
    // debug-level and stripped in production; emitEvent goes to the
    // application event bus and monitoring dashboards.
    const skipped = validRecovered.walkbackUnfetchableSkipped;
    if (skipped && skipped.length > 0) {
      this.host.emitEvent(
        this.host.buildErrorEvent(
          'storage:pointer-version-skipped-unfetchable',
          new Error(
            `Pointer recover: walkback skipped ${skipped.length} ` +
              `EXISTS-BUT-UNFETCHABLE version(s): [${skipped.join(', ')}]. ` +
              `Wallet recovered to older predecessor version=${validRecovered.version}; ` +
              `the listed slot(s) had authentic proofs but unreachable CARs. ` +
              `Operator: re-pin the missing CARs from a backup, or invoke ` +
              `acceptCarLoss(version) to permanently acknowledge the data loss.`,
          ),
          'POINTER_VERSIONS_SKIPPED_UNFETCHABLE',
        ),
      );
    }

    let cidString: string;
    try {
      cidString = CID.decode(validRecovered.cid).toString();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.host.log(`Pointer recover: failed to decode recovered CID bytes: ${msg}`);
      return false;
    }

    // Item #15 Phase E follow-up: under the snapshot-pointer model the
    // recovered CID is a SNAPSHOT CID, NOT a UXF bundle CID. Routing it
    // through `applySnapshotIfWired()` fetches the CAR, parses it as a
    // lean profile snapshot, and dispatches per-writer JOIN through the
    // factory-wired applier. The BundleIndex JOIN handles
    // `tokens.bundle.*` entries (and updates `knownBundleCids`); the
    // per-address writers handle their own slices.
    //
    // The legacy code path here called `bundleIndex.addBundle(cidString, …)`
    // directly on the snapshot CID — under Item #15 that wrote the
    // snapshot bytes into the bundle index, and the next `load()`
    // tried to parse the snapshot CAR as a UXF package and failed.
    //
    // `applySnapshotIfWired` returning `null` means no factory closure
    // was wired (legacy tests / non-Item-#15 providers). Per Phase E
    // we do NOT fall back to the legacy `addBundle` path — silently
    // re-writing the snapshot CID as a bundle ref is precisely the bug
    // this change fixes. Log and bail to the IPNS migration fallback
    // (which still works for genuinely-legacy wallets).
    try {
      const applyResult = await this.host.applySnapshotIfWired(cidString);
      if (applyResult === null) {
        this.host.log(
          `Pointer recover: snapshot applier not wired; ` +
            `treating as no-op (no legacy bundle-CID fallback per Item #15 Phase E)`,
        );
        return false;
      }
      // Track for the no-data republish idempotency check: if the
      // merged-state CAR a future no-data flush would build matches
      // this same snapshot CID, skip the publish (the remote pointer
      // is already authoritative).
      this.host.setLastDiscoveredPointerCid(cidString);
      this.host.log(
        `Pointer recover ok: cid=${cidString} version=${validRecovered.version} ` +
          `joinedAny=${applyResult.joinedAny} addresses=${applyResult.addressesSeen} ` +
          `bundles=${applyResult.bundleEntriesSeen}`,
      );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Best-effort: a transient fetch / parse failure must not POISON
      // the recovery. Return true to signal "pointer path was chosen"
      // so the caller does NOT fall through to legacy IPNS migration
      // (which would stamp the migration-done marker before the
      // pointer path could retry). The next sync() will re-attempt
      // via the periodic poll.
      this.host.log(
        `Pointer recover: applySnapshotIfWired failed (best-effort, will retry on next poll): ${msg}`,
      );
      return true;
    }
  }

  /**
   * Run the legacy IPNS → pointer migration if the wallet pre-dates
   * the pointer layer. No-op for fresh wallets or wallets that have
   * already migrated. Never throws — any failure logs and returns,
   * leaving subsequent flushes to seed the anchor via the pointer
   * layer directly.
   */
  private async runLegacyIpnsMigrationBestEffort(): Promise<void> {
    const identity = this.host.getIdentity();
    if (!identity || this.host.ipfsGateways.length === 0) return;
    if (!this.host.localCache) return;

    try {
      const { runIpnsToPointerMigration } = await import(
        '../migration/ipns-reader.js'
      );
      const localCache = this.host.localCache;
      const result = await runIpnsToPointerMigration({
        localCache: {
          get: (k) => localCache.get(k),
          set: (k, v) => localCache.set(k, v),
        },
        privateKeyHex: identity.privateKey,
        gateways: this.host.ipfsGateways,
        onBundle: async (cid, ref) => this.bundleIndex.addBundle(cid, ref),
        log: (msg) => this.host.log(msg),
      });
      if (result.migrated) {
        this.host.log(
          `Legacy IPNS → pointer migration: imported ${result.bundlesImported} bundles`,
        );
      } else if (result.skipped === 'not-legacy') {
        // Fresh install post-pointer — expected silent no-op.
      } else {
        this.host.log(
          `Legacy migration skipped: ${result.skipped ?? 'transient-failure'}`,
        );
      }
    } catch (err) {
      this.host.log(
        `Legacy IPNS migration threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ===========================================================================
  // Periodic Path 2 (aggregator-pointer) polling
  // ===========================================================================

  /**
   * Sample the next polling interval. Exposed as a private method so
   * tests can spy on it. Returns ms in [30_000, 90_000).
   */
  private samplePointerPollIntervalMs(): number {
    return POINTER_POLL_MIN_MS + Math.floor(Math.random() * POINTER_POLL_RANGE_MS);
  }

  /**
   * Arm (or re-arm) the periodic poll of `recoverLatest()`. Acts as a
   * safety net when OrbitDB pubsub (Path 1) stalls.
   *
   * Behaviour:
   *   - No pointer-layer closure wired → no-op (polling is structurally
   *     pointless). Production wires the closure when an oracle is
   *     configured; tests that omit it skip polling entirely.
   *   - `recoverLatest()` returns null (no anchor yet) → re-arm.
   *   - `recoverLatest()` returns a CID already in `knownBundleCids`
   *     → no-op (Path 1 or our own freshly-published flush already
   *     delivered it). Re-arm.
   *   - `recoverLatest()` returns a NEW CID → add to bundle index
   *     (mirrors cold-start recovery). Re-arm.
   *   - Transient failure → log + warn, re-arm at the normal interval.
   *   - Permanent failure → log + emit `storage:error` event, re-arm
   *     with a 5x back-off so we don't hammer a wallet that needs
   *     operator intervention.
   *
   * The intervals are randomised in [30s, 90s) to avoid synchronised
   * polling across devices that booted simultaneously.
   */
  /**
   * Public wake-up API: trigger an IMMEDIATE aggregator pointer poll
   * without waiting for the periodic [30s, 90s) cycle.
   *
   * Called by `ProfileTokenStorageProvider.handleReplication` when an
   * OrbitDB-pubsub replication event arrives. The aggregator is the
   * authoritative source of truth for the latest pointer version —
   * pubsub between two devices is unreliable (NAT, firewall, peer
   * discovery), so we treat the pubsub signal as a hint to consult
   * the aggregator NOW rather than waiting for the next periodic poll.
   *
   * When pubsub fails entirely, the periodic poll (worst case 90s)
   * still guarantees eventual sync — the aggregator is the ultimate
   * fallback channel.
   *
   * Idempotent: if no aggregator update is found, no-op. If a new CID
   * is found, adds it to the bundle index (same path as the periodic
   * poll). Re-arms the periodic timer so the next scheduled poll is
   * a fresh [30s, 90s) window from this call.
   *
   * Returns a promise that resolves when the poll completes (success
   * or transient failure). Rejection only on programmer error — all
   * transient/permanent failures are logged + swallowed (matching the
   * periodic-poll contract).
   */
  async triggerPointerPollNow(): Promise<void> {
    return this.runPointerPollOnce();
  }

  private schedulePointerPoll(): void {
    if (this.host.getIsShuttingDown()) return;

    // No pointer wiring → polling can never succeed; skip silently.
    const getPointerLayer = this.host.options?.getPointerLayer;
    if (!getPointerLayer) return;

    // Clear any pre-existing timer (defensive — shouldn't normally
    // happen because the only callers are initialize() at startup
    // and the timeout callback itself).
    if (this.pointerPollTimer !== null) {
      clearTimeout(this.pointerPollTimer);
      this.pointerPollTimer = null;
    }

    const intervalMs = this.samplePointerPollIntervalMs();
    this.pointerPollTimer = setTimeout(() => {
      this.pointerPollTimer = null;
      // Detached promise — the callback re-arms in its own try/catch
      // so a stray rejection here cannot break the cadence.
      void this.runPointerPollOnce();
    }, intervalMs);
  }

  /**
   * Single iteration of the periodic poll. Always re-arms unless
   * shutdown is in progress. Permanent failures re-arm with a 5x
   * back-off applied via the multiplier in the next-tick interval.
   */
  private async runPointerPollOnce(): Promise<void> {
    if (this.host.getIsShuttingDown()) return;

    const getPointerLayer = this.host.options?.getPointerLayer;
    if (!getPointerLayer) return; // wiring removed mid-flight — defensive

    // Issue #313 — start timer for the `background-sync` snapshot
    // refresh. Captured once at poll entry so the durationMs reported
    // in `profile:snapshot-refreshed` measures the full poll-to-write
    // window (recoverLatest + applySnapshotIfWired + load) not just
    // the snapshot write itself.
    const pollStartedAt = Date.now();

    let nextBackoffMultiplier = 1;
    const pointer = getPointerLayer() ?? null;
    if (!pointer) {
      // Closure exists but the layer isn't constructed yet (e.g.,
      // build still in flight). Skip this tick and re-arm.
      this.scheduleNextPointerPoll(nextBackoffMultiplier);
      return;
    }

    // Retry any pending publish from a previous transient failure
    // BEFORE polling for new pointer state. If the retry succeeds the
    // marker is cleared; if it stays transient the next periodic tick
    // or save-driven flush retries again. Failures here are non-fatal
    // to the poll itself — we still proceed to recoverLatest so this
    // tick is not wasted.
    try {
      await this.retryPendingPublishIfAny();
    } catch (err) {
      this.host.log(
        `Pointer poll: pending-publish retry threw (best-effort): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    let recovered: Awaited<ReturnType<typeof pointer.recoverLatest>> = null;
    try {
      recovered = await pointer.recoverLatest({
        abortSignal: this.getDestroySignal(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.isPermanentPointerError(err)) {
        const code = (err as { code?: string }).code ?? 'UNKNOWN';
        this.host.log(`Pointer poll PERMANENT failure (${code}): ${msg}`);
        this.host.emitEvent(this.host.buildErrorEvent('storage:error', err));
        nextBackoffMultiplier = POINTER_POLL_BACKOFF_MULTIPLIER;
      } else {
        this.host.log(`Pointer poll failed (transient, best-effort): ${msg}`);
      }
      this.scheduleNextPointerPoll(nextBackoffMultiplier);
      return;
    }

    // Issue #319 — successful `recoverLatest()` round-trip proves the
    // aggregator pointer chain is reachable end-to-end. If the wallet
    // had been BLOCKED for a transient-connectivity reason (most
    // commonly `retry_exhausted` after the 5-attempt publish budget
    // ran out during a brief aggregator flap) it is safe to clear the
    // flag now without operator intervention.
    //
    // This handles even the `recovered === null` case below (fresh
    // wallet — no anchor) because reaching that branch ALSO required a
    // successful aggregator round-trip; the null only signals "nothing
    // anchored yet", not connectivity loss. The `all-unfetchable`
    // branch similarly proves the aggregator responded — IPFS gateways
    // are a separate failure domain.
    //
    // Persistent BLOCKED reasons (`aggregator_rejected`, `protocol_error`,
    // `marker_corrupt`, `rejected`) are left in place; the
    // `clearBlockedIfTransient` predicate is the single source of
    // truth for that classification.
    try {
      const clearResult = await pointer.clearBlockedIfTransient();
      if (clearResult.cleared && clearResult.reason) {
        this.host.log(
          `Pointer poll: auto-cleared BLOCKED (reason=${clearResult.reason}) ` +
            `after successful recoverLatest — transient connectivity resolved.`,
        );
        // The pending publish (if any) was refused for the entire
        // BLOCKED window. Re-run the retry now so the wallet recovers
        // in the same poll tick instead of waiting up to ~90s for the
        // next scheduled poll. Steelman²³: the leading
        // `retryPendingPublishIfAny` above ran while BLOCKED was set,
        // so it failed with UNREACHABLE_RECOVERY_BLOCKED and (when
        // classified PERMANENT) may have already cleared
        // `pendingPublishCid`. Whether or not it did, this post-clear
        // call exercises the now-unblocked publish path: a no-op if
        // there is no pending CID, or a real retry if one survived.
        try {
          await this.retryPendingPublishIfAny();
        } catch (retryErr) {
          this.host.log(
            `Pointer poll: post-unblock pending-publish retry threw (best-effort): ${
              retryErr instanceof Error ? retryErr.message : String(retryErr)
            }`,
          );
        }
        // Steelman²³: only emit the auto-cleared event if BLOCKED is
        // still clear. The same-tick retry may have re-set BLOCKED via
        // `maybeSetBlocked` inside `publishOnceAtVersion`'s catch
        // (e.g., retry hit another transient → reason='retry_exhausted'
        // again). Emitting the cleared event in that case would cause
        // UI flicker: banner dismissed at T0, banner re-asserted at T1
        // when the next poll/save flush sees BLOCKED=true again.
        // Suppressing the event keeps the UI quiet until the wallet
        // actually recovers durably.
        let immediatelyReblocked = false;
        try {
          immediatelyReblocked = await pointer.isPublishBlocked();
        } catch {
          // If we can't query, default to emitting (safe: consumers
          // treat this as at-least-once observability). A spurious
          // emit is preferable to a silent miss.
          immediatelyReblocked = false;
        }
        if (!immediatelyReblocked) {
          this.host.emitEvent({
            type: 'storage:blocked-auto-cleared',
            timestamp: Date.now(),
            data: {
              clearedReason: clearResult.reason,
              clearedAt: Date.now(),
            },
          });
        } else {
          this.host.log(
            `Pointer poll: auto-cleared BLOCKED (${clearResult.reason}) ` +
              `but the same-tick retry re-blocked the wallet; ` +
              `suppressing storage:blocked-auto-cleared event to avoid UI flicker.`,
          );
        }
      }
    } catch (err) {
      // clearBlockedIfTransient should not throw on the happy path; any
      // throw is best-effort and must not abort the rest of the poll
      // (snapshot apply, schedule re-arm).
      this.host.log(
        `Pointer poll: clearBlockedIfTransient threw (best-effort): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (!recovered) {
      // No anchor published yet — operator hasn't flushed. Re-arm
      // silently; this is a normal state for a fresh wallet.
      this.scheduleNextPointerPoll(nextBackoffMultiplier);
      return;
    }

    // All-unfetchable: pointer chain exists but every CAR is CAR_TRANSIENT.
    // Emit event and re-arm; do NOT fall through to any legacy path.
    if ('kind' in recovered && recovered.kind === 'all-unfetchable') {
      const allSkipped = recovered.walkbackUnfetchableSkipped;
      this.host.emitEvent(
        this.host.buildErrorEvent(
          'storage:pointer-version-skipped-unfetchable',
          new Error(
            `Pointer poll: all ${allSkipped.length} known anchor version(s) ` +
              `EXISTS-BUT-UNFETCHABLE: [${allSkipped.join(', ')}]. ` +
              `No VALID predecessor found; IPFS gateways may be temporarily unreachable. ` +
              `Will retry on next poll cycle.`,
          ),
          'POINTER_VERSIONS_SKIPPED_UNFETCHABLE',
        ),
      );
      this.scheduleNextPointerPoll(nextBackoffMultiplier);
      return;
    }

    // VALID version found. Same skip-past observability as the cold-start
    // recovery path: emit a typed event for operator monitoring.
    // Explicit cast: null + all-unfetchable cases both returned early above.
    // TS does not narrow RecoverResult | RecoverAllUnfetchableResult through
    // the `'kind' in …` early-return guard because RecoverResult has no `kind`
    // field — the `in` check is ambiguous at the type level. Cast is safe.
    const validRecovered = recovered as RecoverResult;

    const skipped = validRecovered.walkbackUnfetchableSkipped;
    if (skipped && skipped.length > 0) {
      this.host.emitEvent(
        this.host.buildErrorEvent(
          'storage:pointer-version-skipped-unfetchable',
          new Error(
            `Pointer poll: walkback skipped ${skipped.length} ` +
              `EXISTS-BUT-UNFETCHABLE version(s): [${skipped.join(', ')}]. ` +
              `Recovered to predecessor version=${validRecovered.version}.`,
          ),
          'POINTER_VERSIONS_SKIPPED_UNFETCHABLE',
        ),
      );
    }

    let cidString: string;
    try {
      cidString = CID.decode(validRecovered.cid).toString();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.host.log(`Pointer poll: failed to decode recovered CID bytes: ${msg}`);
      this.scheduleNextPointerPoll(nextBackoffMultiplier);
      return;
    }

    // Idempotency — the recovered CID is the SNAPSHOT CID (Item #15),
    // not a UXF bundle CID, so the legacy `knownBundleCids` check is
    // structurally wrong here (the snapshot CID would never appear in
    // that set). Use `lastDiscoveredPointerCid` instead — that's the
    // last snapshot CID we successfully applied. Equality means we've
    // already JOIN-applied this version; skip the redundant fetch +
    // parse + dispatch.
    if (this.host.getLastDiscoveredPointerCid() === cidString) {
      // The aggregator may have re-anchored a new pointer version
      // pointing to the same CID; tracking is already in place, so
      // just re-arm and continue. No publish work needed — local
      // state already reflects this snapshot.
      this.scheduleNextPointerPoll(nextBackoffMultiplier);
      return;
    }

    // Item #15 Phase E follow-up: dispatch the snapshot CID through
    // the host-wired applier (fetch + parse + per-writer JOIN). The
    // legacy code path here called `bundleIndex.addBundle(cidString, …)`
    // directly — under Item #15 that wrote the snapshot bytes into
    // the bundle index, and the next `load()` tried to parse the
    // snapshot CAR as a UXF package and failed.
    //
    // `applySnapshotIfWired` returning `null` means no factory closure
    // was wired (legacy tests / non-Item-#15 providers). Per Phase E
    // we do NOT fall back to `addBundle` — silently re-writing the
    // snapshot CID as a bundle ref is precisely the bug this change
    // fixes. Log + re-arm; the next poll cycle will try again.
    try {
      const applyResult = await this.host.applySnapshotIfWired(cidString);
      if (applyResult === null) {
        this.host.log(
          `Pointer poll: snapshot applier not wired; ` +
            `skipping CID dispatch (no legacy bundle-CID fallback per Item #15 Phase E)`,
        );
        this.scheduleNextPointerPoll(nextBackoffMultiplier);
        return;
      }
      this.host.setLastDiscoveredPointerCid(cidString);
      this.host.log(
        `Pointer poll discovered NEW snapshot CID: cid=${cidString} ` +
          `version=${validRecovered.version} joinedAny=${applyResult.joinedAny} ` +
          `addresses=${applyResult.addressesSeen} bundles=${applyResult.bundleEntriesSeen}`,
      );

      // Invoke the poll-discovery handler so the new CID gets loaded
      // into `lastLoadedData` and the pointer is re-anchored at the
      // merged state. Without this, subsequent save-driven flushes
      // would see the JOIN-landed bundle refs as "unknown" relative
      // to `lastLoadedFromBundleCids` and abort with
      // POINTER_MONOTONICITY_VIOLATION — silently refusing to publish.
      //
      // Note: BundleIndex.joinSnapshot already updates
      // `knownBundleCids` AND fires `notifyProfileDirty` to schedule
      // a republish at the next debounce window. But `lastLoadedData`
      // is owned by the `load()` path — only an explicit load can
      // merge the new bundles into the in-memory snapshot.
      //
      // Best-effort: failures here are logged but do not abort the
      // poll-loop re-arm at the end.
      if (this.onPollDiscoveredNewCid) {
        try {
          await this.onPollDiscoveredNewCid();
        } catch (err2) {
          this.host.log(
            `Pointer poll: onPollDiscoveredNewCid failed (best-effort): ${
              err2 instanceof Error ? err2.message : String(err2)
            }`,
          );
        }
      }

      // Issue #313 — atomic-write the snapshot blob to capture the
      // background-sync's freshly-merged state. The poll just walked
      // the aggregator pointer forward + applied a new snapshot CID;
      // `lastLoadedData` (updated by `onPollDiscoveredNewCid`) and
      // `lastDiscoveredPointerCid` (set above) now reflect the
      // post-sync view. Persist it so the NEXT cold boot reads the
      // post-sync state without re-walking the aggregator.
      //
      // Fire-and-forget. Failures route through `storage:error`
      // (`PROFILE_SNAPSHOT_WRITE_FAILED`) so the poll re-arm at the
      // end of the method is unaffected.
      const durationMs = Date.now() - pollStartedAt;
      void this.host
        .writeLocalSnapshot('background-sync', {
          durationMs,
        })
        .catch((err2) => {
          this.host.log(
            `Pointer poll: writeLocalSnapshot threw unexpectedly: ${
              err2 instanceof Error ? err2.message : String(err2)
            }`,
          );
        });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.host.log(`Pointer poll: applySnapshotIfWired failed: ${msg}`);
    }

    this.scheduleNextPointerPoll(nextBackoffMultiplier);
  }

  /**
   * Re-arm the poll with the given back-off multiplier (1 = normal,
   * `POINTER_POLL_BACKOFF_MULTIPLIER` = permanent-failure back-off).
   */
  private scheduleNextPointerPoll(backoffMultiplier: number): void {
    if (this.host.getIsShuttingDown()) return;
    if (!this.host.options?.getPointerLayer) return;

    const baseIntervalMs = this.samplePointerPollIntervalMs();
    const intervalMs = baseIntervalMs * Math.max(1, backoffMultiplier);
    this.pointerPollTimer = setTimeout(() => {
      this.pointerPollTimer = null;
      void this.runPointerPollOnce();
    }, intervalMs);
  }
}
