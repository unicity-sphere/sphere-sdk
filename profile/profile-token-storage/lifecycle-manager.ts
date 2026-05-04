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

export class LifecycleManager {
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

  async initialize(replicationHandler: () => Promise<void>): Promise<boolean> {
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
    this.host.setLastTokenManifest(null);

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
   * TRANSIENT failures are silently logged — the CAR is already
   * pinned and the OrbitDB bundle ref is already written, so the
   * next flush can retry the publish.
   *
   * PERMANENT failures (UNREACHABLE_RECOVERY_BLOCKED, REJECTED,
   * UNTRUSTED_PROOF, TRUST_BASE_STALE, MARKER_CORRUPT, CORRUPT_STREAK,
   * SECURITY_ORIGIN_MISMATCH, CAPABILITY_DENIED, UNSUPPORTED_RUNTIME,
   * PROTOCOL_ERROR, AGGREGATOR_REJECTED) are surfaced via a
   * `storage:error` event with the error code in the payload.
   */
  async publishAggregatorPointerBestEffort(cidString: string): Promise<void> {
    const pointer = this.host.options?.getPointerLayer?.() ?? null;
    if (!pointer) return;

    try {
      const cidBytes = CID.parse(cidString).bytes;
      const result = await pointer.publish(async () => cidBytes);
      this.host.log(
        `Pointer publish ok: cid=${cidString} version=${result.version} attempts=${result.attemptsUsed}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.isPermanentPointerError(err)) {
        const code = (err as { code?: string }).code ?? 'UNKNOWN';
        this.host.log(`Pointer publish PERMANENT failure (${code}): ${msg}`);
        this.host.emitEvent(this.host.buildErrorEvent('storage:error', err));
      } else {
        this.host.log(`Pointer publish failed (transient, best-effort): ${msg}`);
      }
    }
  }

  /**
   * Try to rebuild the local bundle set from the aggregator pointer
   * layer's last valid CID. Returns `true` iff a bundle ref was
   * recorded (caller should skip the IPNS fallback). Returns `false`
   * when the pointer has no anchor yet or transiently failed — the
   * caller falls through to IPNS.
   */
  private async recoverFromAggregatorPointerBestEffort(): Promise<boolean> {
    // Poll for the pointer layer briefly. Sphere.init/import calls
    // storage.connect() (which builds the pointer when identity is
    // already set) BEFORE setIdentity (which is when identity becomes
    // available); setIdentity then fire-and-forgets a deferred pointer
    // rebuild. tokenStorage.initialize() — where this method runs —
    // races against that deferred rebuild on the very first connect.
    // Polling with a 5s ceiling lets the rebuild complete without
    // forcing the caller to know about the ordering quirk.
    const pollDeadline = Date.now() + 5_000;
    let pointer = this.host.options?.getPointerLayer?.() ?? null;
    while (!pointer && Date.now() < pollDeadline) {
      await new Promise((r) => setTimeout(r, 100));
      pointer = this.host.options?.getPointerLayer?.() ?? null;
    }
    if (!pointer) {
      this.host.log(
        'Pointer recover: no pointer layer wired after 5s wait — ' +
          'wallet has no aggregator pointer recovery (e.g., oracle not configured)',
      );
      return false;
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

    try {
      const cidString = CID.decode(recovered.cid).toString();
      await this.bundleIndex.addBundle(cidString, {
        cid: cidString,
        status: 'active',
        createdAt: Math.floor(Date.now() / 1000),
      });
      this.host.log(
        `Pointer recover ok: cid=${cidString} version=${recovered.version}`,
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
}
