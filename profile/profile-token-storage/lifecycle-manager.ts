/**
 * LifecycleManager
 *
 * Owns the connect / disconnect / initialize / shutdown state machine
 * for `ProfileTokenStorageProvider`, plus the cold-start recovery
 * helpers (aggregator pointer recover + one-shot IPNS migration).
 *
 * The manager coordinates with `BundleIndex` (for `refreshKnownBundles`
 * and `addBundle` on recovery) and with `FlushScheduler` (to drain
 * pending data on shutdown). It does NOT own any private state of its
 * own — every mutation flows through the host so the facade remains the
 * single source of truth (tests poke `(provider as any).initialized`
 * directly; that field MUST stay on the facade).
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

import { hexToBytes } from '../../core/hex.js';
import type { FullIdentity } from '../../types/index.js';
import { CID } from 'multiformats/cid';
import {
  deriveProfileEncryptionKey,
} from '../encryption.js';
import { computeAddressId } from '../types.js';
import type { BundleIndex } from './bundle-index.js';
import type { ProfileTokenStorageHost } from './host.js';
import { fetchFromIpfs } from '../ipfs-client.js';

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

export class LifecycleManager {
  /**
   * Periodic-poll timer for Path 2 (aggregator pointer recovery).
   * Owned by this module — does NOT live on the host because it is
   * private to the polling mechanism (no other seam reads or mutates
   * it). Set by `schedulePointerPoll()`, cleared by `shutdown()`.
   */
  private pointerPollTimer: ReturnType<typeof setTimeout> | null = null;

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

    try {
      // Ensure OrbitDB is connected
      if (!this.host.db.isConnected()) {
        this.host.log('OrbitDB not connected; skipping bundle load until connected');
        this.host.setStatus('connected');
        this.host.setInitialized(true);
        return true;
      }

      // Load known bundle CIDs from OrbitDB
      await this.bundleIndex.refreshKnownBundles();

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

  async shutdown(): Promise<void> {
    if (this.host.getIsShuttingDown()) return;
    this.host.setIsShuttingDown(true);

    // Cancel periodic pointer-poll timer first — its callback gates on
    // isShuttingDown but a poll already in flight would otherwise race
    // shutdown's bundle-index mutations.
    if (this.pointerPollTimer !== null) {
      clearTimeout(this.pointerPollTimer);
      this.pointerPollTimer = null;
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
   * caller (FlushScheduler) can propagate transient errors up to the
   * at-least-once gate. The persistence of the retry marker
   * (`pendingPublishCid`) is handled here:
   *
   *   - SUCCESS — clears `pendingPublishCid`, anchors
   *     `lastDiscoveredPointerCid`, returns `{ ok: true }`.
   *   - TRANSIENT failure — sets `pendingPublishCid = cidString` (with
   *     localCache persistence for crash safety), returns
   *     `{ ok: false, transient: true }`. Caller MUST treat this as
   *     "not durable" — the at-least-once gate refuses the Nostr ack
   *     so the inbound event replays on next reconnect (idempotent
   *     via addToken stateHash dedup and processedCombinedTransferIds).
   *     The pending marker is retried at start of every subsequent
   *     `flushToIpfs` and `runPointerPollOnce`.
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

    try {
      const cidBytes = CID.parse(cidString).bytes;
      const result = await pointer.publish(async () => cidBytes);
      this.host.setLastDiscoveredPointerCid(cidString);
      // Clear any previously-pending marker — this publish succeeded,
      // so the cross-device recovery path can now reach the bundle.
      this.host.setPendingPublishCid(null);
      this.host.log(
        `Pointer publish ok: cid=${cidString} version=${result.version} attempts=${result.attemptsUsed}`,
      );
      return { ok: true, transient: false };
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
        return { ok: false, transient: false, code };
      }
      this.host.log(`Pointer publish failed (transient): ${msg}`);
      // Transient: stamp the retry marker (with localCache persistence
      // for crash safety) so subsequent flushes / polls re-attempt
      // before any new save-driven work.
      this.host.setPendingPublishCid(cidString);
      return { ok: false, transient: true };
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

    let recovered: { readonly cid: Uint8Array; readonly version: number } | null;
    try {
      recovered = await pointer.recoverLatest();
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

    if (!recovered) {
      this.host.log('Pointer recover: no anchor published yet');
      return false;
    }

    let cidString: string;
    try {
      cidString = CID.decode(recovered.cid).toString();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.host.log(`Pointer recover: failed to decode recovered CID bytes: ${msg}`);
      return false;
    }

    // Steelman defense — verify the recovered CID is fetchable AND its
    // bytes match the CID hash BEFORE writing to the durable bundle
    // index. The pointer layer's verification covers the
    // pointer→aggregator anchor cryptography; it does NOT prove the
    // CID points to legitimate CAR bytes that this wallet's encryption
    // key can decrypt. A compromised aggregator could redirect the
    // pointer to attacker-controlled CIDs that decrypt as garbage —
    // surviving in OrbitDB and propagating to peers.
    //
    // The fetch+verify pre-flight is best-effort: a transient gateway
    // failure must not POISON the recovery. We fall back to writing
    // the bundle ref under `status: 'unverified'` so a future sync
    // can retry the verification before the JOIN walker promotes it
    // to 'active'.
    let verifiedActive = false;
    try {
      const carBytes = await fetchFromIpfs(this.host.ipfsGateways, cidString);
      // fetchFromIpfs already verifies CID-hash binding (sha256 vs
      // multihash). Reaching here means the CAR bytes are
      // content-authentic. The encryption key check is delegated to
      // the JOIN walker (UxfPackage.fromCar throws on malformed bytes;
      // bundleIndex.listBundles' decryption path drops un-decryptable
      // entries). Promote to 'active' once we know the bytes resolve.
      verifiedActive = carBytes.byteLength > 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.host.log(
        `Pointer recover: CAR fetch+verify failed for cid=${cidString} ` +
          `(treating as unverified, will retry via sync): ${msg}`,
      );
    }

    try {
      await this.bundleIndex.addBundle(cidString, {
        cid: cidString,
        // Steelman: only mark 'active' after the fetch+verify step
        // succeeded. Otherwise the bundle ref persists but is gated
        // out of the JOIN until a subsequent sync re-fetches and
        // promotes it. listActiveBundles filters on `status === 'active'`.
        status: verifiedActive ? 'active' : 'unverified',
        createdAt: Math.floor(Date.now() / 1000),
      });
      // Track for the no-data republish idempotency check: if the
      // merged-state CAR a future no-data flush would build matches
      // this same CID, skip the publish (the remote pointer is
      // already authoritative).
      this.host.setLastDiscoveredPointerCid(cidString);
      this.host.log(
        `Pointer recover ok: cid=${cidString} version=${recovered.version} ` +
          `status=${verifiedActive ? 'active' : 'unverified'}`,
      );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.host.log(`Pointer recover: addBundle failed post-recover: ${msg}`);
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

    let recovered: { readonly cid: Uint8Array; readonly version: number } | null = null;
    try {
      recovered = await pointer.recoverLatest();
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

    if (!recovered) {
      // No anchor published yet — operator hasn't flushed. Re-arm
      // silently; this is a normal state for a fresh wallet.
      this.scheduleNextPointerPoll(nextBackoffMultiplier);
      return;
    }

    let cidString: string;
    try {
      cidString = CID.decode(recovered.cid).toString();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.host.log(`Pointer poll: failed to decode recovered CID bytes: ${msg}`);
      this.scheduleNextPointerPoll(nextBackoffMultiplier);
      return;
    }

    // Idempotency — if we already know this CID, OrbitDB pubsub (or our
    // own flush) already delivered it. Skip the bundle-index write to
    // avoid an unnecessary OrbitDB op.
    if (this.host.getKnownBundleCids().has(cidString)) {
      // Still update the discovered-pointer CID — this lets a future
      // no-data flush short-circuit on idempotent republish. (Even
      // though we already had this CID locally, the AGGREGATOR may
      // have anchored a new pointer version pointing to it; tracking
      // ensures our flush idempotency stays correct.)
      this.host.setLastDiscoveredPointerCid(cidString);
      this.scheduleNextPointerPoll(nextBackoffMultiplier);
      return;
    }

    try {
      await this.bundleIndex.addBundle(cidString, {
        cid: cidString,
        // Mirror the cold-start path's conservative default: CARs are
        // verified by JOIN walker / decryption on first use; until
        // then, mark active (Path 1's normal write also does so).
        // Permanent verify failures will be caught by listBundles
        // and emit CID_REF_CORRUPT events.
        status: 'active',
        createdAt: Math.floor(Date.now() / 1000),
      });
      this.host.setLastDiscoveredPointerCid(cidString);
      this.host.log(
        `Pointer poll discovered NEW CID: cid=${cidString} version=${recovered.version}`,
      );

      // Invoke the poll-discovery handler so the new CID gets loaded
      // into `lastLoadedData` and the pointer is re-anchored at the
      // merged state. Without this, subsequent save-driven flushes
      // would see the new CID as "unknown" relative to
      // `lastLoadedFromBundleCids` and abort with
      // POINTER_MONOTONICITY_VIOLATION — silently refusing to publish
      // (which the at-least-once gate correctly surfaces as a Nostr-
      // ack refusal, but causes spurious replays).
      //
      // This is a DIFFERENT callback from `replicationHandler` —
      // replicationHandler does its own diff check (previousCids vs
      // current knownBundleCids) which would skip the load if it
      // runs AFTER our addBundle (the diff is no-op once addBundle
      // already updated knownBundleCids). `onPollDiscoveredNewCid`
      // unconditionally loads + schedules a no-data flush; the caller
      // (this method) already confirmed it's a new CID via the
      // knownBundleCids.has(cidString) guard above.
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.host.log(`Pointer poll: addBundle failed: ${msg}`);
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
