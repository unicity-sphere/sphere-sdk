/**
 * ProfilePointerLayer (T-D4) — top-level public API per SPEC §13.
 *
 * Single entry point for all pointer-layer operations. Wires:
 *   - flag-store (per-wallet durable storage)
 *   - mutex (cross-tab / cross-process publish serialization)
 *   - signer + key material (HKDF-derived from master key)
 *   - aggregator client (via OracleProvider.getAggregatorClient)
 *   - trust base (via OracleProvider.getRootTrustBase)
 *   - publish / discover / reconcile algorithms
 *
 * Injected callbacks (pointer layer does NOT own these subsystems):
 *   - cidProducer: outer Profile layer builds CAR + returns CID
 *   - decodeCid: multiformats parser
 *   - fetchCar: IPFS gateway fetcher with content-address verify
 *   - fetchAndJoin: OrbitDB OpLog merge
 *   - persistLocalVersion: writes profile.pointer.version to KV storage
 *   - resolveRemoteCid: discovers CID at a given version (used during reconcile)
 *   - readLocalVersion: reads profile.pointer.version from KV storage
 */

import type { AggregatorClient } from 'stsdk-v1/lib/api/AggregatorClient.js';
import type { RootTrustBase } from 'stsdk-v1/lib/bft/RootTrustBase.js';

import {
  classifyVersion,
  isReachable,
  probeVersion,
  type CarFetcher,
  type CidDecoder,
} from './aggregator-probe.js';
import {
  assertConfigCapabilities,
  assertOperatorOverridesAllowed,
  type PointerLayerConfig,
} from './config.js';
import {
  assertAcceptCarLossEligible,
  clearAttempts,
  recordAttempt,
} from './car-loss-tracker.js';
import {
  clearBlocked as clearBlockedFlag,
  hasUnrecognizedBlockedReason,
  isBlocked as readBlockedState,
  isTransientRecoveryReason,
  setBlocked,
} from './blocked-state.js';
import type { BlockedReason } from './blocked-state.js';
import { AggregatorPointerError, AggregatorPointerErrorCode } from './errors.js';
import {
  computeProbeFingerprint,
  findLatestValidVersion,
  type DiscoverResult,
} from './discover-algorithm.js';
import type { FlagStore } from './flag-store.js';
import type { PointerKeyMaterial } from './key-derivation.js';
import { clearMarker } from './marker.js';
import type { PointerMutex } from './mutex-lock.js';
import { reconcileAndPublish, type FetchAndJoinCallback } from './reconcile-algorithm.js';
import type { PointerSigner } from './signing.js';
import type { BlockedState, PointerVersion } from './types.js';
import { incr, time } from '../../../../core/perf-counters.js';

// ── Constructor input ──────────────────────────────────────────────────────

export interface ProfilePointerLayerInit {
  /** HKDF-derived key material. */
  readonly keyMaterial: PointerKeyMaterial;
  /** Signing service wrapper. */
  readonly signer: PointerSigner;
  /** Aggregator client from OracleProvider.getAggregatorClient(). */
  readonly aggregatorClient: AggregatorClient;
  /** Bundled RootTrustBase from OracleProvider.getRootTrustBase(). */
  readonly trustBase: RootTrustBase;
  /** Per-wallet FlagStore (FlagStore.create(storage, signingPubKeyHex)). */
  readonly flagStore: FlagStore;
  /** Publish mutex (createPointerMutex with per-wallet path/key). */
  readonly mutex: PointerMutex;
  /** CID decoder callback (multiformats). */
  readonly decodeCid: CidDecoder;
  /** CAR fetcher (wraps profile/ipfs-client). */
  readonly fetchCar: CarFetcher;
  /** fetchAndJoin callback — merges remote bundle into local OpLog. */
  readonly fetchAndJoin: FetchAndJoinCallback;
  /** Read `profile.pointer.version` from local storage. */
  readonly readLocalVersion: () => Promise<PointerVersion>;
  /** Persist `profile.pointer.version` to local storage. */
  readonly persistLocalVersion: (v: PointerVersion) => Promise<void>;
  /** Given a version, resolve its CID bytes (via classifyVersion or recoverLatest). */
  readonly resolveRemoteCid: (version: PointerVersion) => Promise<Uint8Array>;
  /**
   * Issue #310 — read the wallet's locally-persisted epoch floor.
   * Optional: when omitted (or when a read throws), the discovery
   * walkback floor starts at 0 — backwards-compatible with pre-#310
   * SDK behavior. Otherwise the floor is primed with the returned
   * value, preventing an aggregator that still serves a pre-reset
   * pointer for the same wallet from tricking us into walking back
   * to it.
   */
  readonly readEpochFloor?: () => Promise<number>;
  /**
   * Issue #310 — persist a newly-observed epoch floor (best-effort).
   * Called by `discoverLatestVersion` whenever the Phase-3 walkback
   * observes `pickedEpoch > initialEpochFloor`, so the wallet
   * converges with sibling-device resets without requiring the user
   * to re-trigger any reset locally.
   */
  readonly persistEpochFloor?: (epoch: number) => Promise<void>;
  /**
   * Issue #310 — given a Phase-3 candidate version, return the
   * snapshot's claimed `epoch` (or `undefined` for pre-#310
   * snapshots). The lifecycle layer wires this to a closure that
   * re-resolves the CID + fetches the root block + dag-cbor decodes
   * the `epoch` field. Throws on decode failure so the walkback
   * treats the candidate as undetermined / SEMANTICALLY_INVALID-
   * equivalent.
   */
  readonly inspectSnapshotEpoch?: (
    version: PointerVersion,
  ) => Promise<number | undefined>;
  /** Configuration (capabilities). */
  readonly config?: PointerLayerConfig;
  /**
   * Issue #364 Item #1 — TTL (ms) for the `recoverLatest()` head cache.
   *
   * A short cache eliminates the read-back tight-loop's redundant
   * aggregator round-trips: the §D.4 recovery soak observed 108
   * recoverLatest calls in 123 s (0.88/s), driven by the
   * `awaitAggregatorPointerReadBack` loop polling every 500 ms while
   * the per-call cost averages 250 ms. With this cache, only the first
   * call in each TTL window hits the aggregator; subsequent calls
   * within the window return the cached value in sub-millisecond time
   * and bump the `pointerLayer.recoverLatest.cacheHit` counter.
   *
   * Concurrent callers that arrive while a call is in flight attach to
   * the in-flight promise (`pointerLayer.recoverLatest.inFlightDedup`)
   * rather than launching a parallel aggregator round-trip.
   *
   * Default: 10_000 (10 s). Trade-off rationale:
   *   - The read-back loop's 500 ms poll cadence over a typical 30 s
   *     shutdown-durability deadline drops from 60 calls to 3.
   *   - The periodic pointer poll's 30-90 s cadence is unaffected
   *     (each poll exceeds the TTL).
   *   - New pointer versions are still observed within 10 s, which is
   *     well inside the worst-case aggregator read-replica lag this
   *     loop is designed to absorb.
   *
   * Set `0` to disable the cache entirely (every call hits the
   * aggregator — restores pre-#364 behavior).
   */
  readonly recoverLatestCacheTtlMs?: number;
}

// ── Public result types ────────────────────────────────────────────────────

export interface PublishResult {
  readonly version: PointerVersion;
  readonly attemptsUsed: number;
  /**
   * Versions skipped past during Phase 3 walkback within this publish
   * session (conflict-driven rediscovery only — the fast-path attempt 0
   * does no walkback and produces an empty list).
   *
   * Mirrors `RecoverResult.walkbackUnfetchableSkipped`. Surfaced so
   * `publishAggregatorPointerBestEffort` can emit the same
   * `storage:pointer-version-skipped-unfetchable` event on the publish
   * path as on the recover path.
   *
   * Empty when no CAR_TRANSIENT skip-past occurred or when publish
   * succeeded on the fast-path (no walkback).
   */
  readonly walkbackUnfetchableSkipped: readonly PointerVersion[];
}

export interface RecoverResult {
  readonly cid: Uint8Array;
  readonly version: PointerVersion;
  /**
   * Versions walked past during Phase 3 walkback whose CAR was
   * EXISTS-BUT-UNFETCHABLE (proof authentic, CID decoded, but no
   * gateway could serve the bytes). Empty when no such versions were
   * encountered or when the wallet ran in SPEC-strict
   * `skipUnfetchableInWalkback: false` mode.
   *
   * The wallet's `version` field is the latest VALID predecessor — older
   * than every entry in this list. Surfaced so the lifecycle layer can
   * emit a typed `storage:pointer-version-skipped-unfetchable` event for
   * operator monitoring.
   *
   * See `discover-algorithm.ts` for the full design rationale.
   */
  readonly walkbackUnfetchableSkipped?: readonly PointerVersion[];
}

/**
 * Returned by `recoverLatest()` when the discovery walkback found at
 * least one anchor (includedV > 0) but EVERY visited slot returned
 * `CAR_TRANSIENT` — i.e. the pointer history EXISTS on-chain but not
 * a single CAR is fetchable from any configured gateway.
 *
 * This is distinct from `recoverLatest() === null` (fresh wallet — no
 * pointer ever published). Callers MUST NOT fall through to legacy IPNS
 * migration on this result: the pointer chain exists; the gateways are
 * the problem. The wallet should retry on the next poll cycle.
 *
 * Lifecycle-layer handling:
 *   - Do NOT stamp the legacy migration-done marker.
 *   - Do NOT import IPNS bundles.
 *   - Emit `storage:pointer-version-skipped-unfetchable` event (carried
 *     in `walkbackUnfetchableSkipped`) so operators know the outage depth.
 *   - Return `true` (pointer path was chosen) so the caller skips legacy.
 */
export interface RecoverAllUnfetchableResult {
  readonly kind: 'all-unfetchable';
  /**
   * Every version that was walked but whose CAR was unreachable.
   * Non-empty by definition (at least one slot existed and was skipped).
   */
  readonly walkbackUnfetchableSkipped: readonly PointerVersion[];
}

/**
 * Issue #247 — outcome of `reconcileLocalVersionDownward`.
 *
 *   - `reconciled` — the candidate.version was strictly less than
 *     `localVersion` AND the candidate authored under this wallet's
 *     signing identity (see authoring trust note on the method). Local
 *     state was rewritten and persisted; the next discovery starts
 *     from the lower floor.
 *   - `up-to-date` — candidate.version >= localVersion. Nothing to
 *     reconcile (a normal forward publish path applies). Local state
 *     unchanged.
 */
export interface ReconcileDownwardResult {
  readonly reconciled: boolean;
  readonly fromVersion: PointerVersion;
  readonly toVersion: PointerVersion;
}

// ── Class ──────────────────────────────────────────────────────────────────

export class ProfilePointerLayer {
  readonly #init: ProfilePointerLayerInit;
  readonly #config: PointerLayerConfig;
  #lastProbeVersions: readonly PointerVersion[] = [];
  /**
   * Tracks all in-flight publish/recover/probe operations so `shutdown()`
   * can drain them. The set holds Promises (resolution status irrelevant);
   * `Promise.allSettled` waits for every entry. Each operation removes
   * itself from the set in a `finally` block.
   */
  readonly #inFlight = new Set<Promise<unknown>>();
  // Steelman¹⁸: set by shutdown() to prevent new operations from being
  // enqueued during drain.  Public methods check this flag and reject
  // immediately after shutdown starts.
  #shuttingDown = false;

  // ── Issue #364 Item #1 — recoverLatest head cache ──────────────────────
  // Cached most-recent result of recoverLatest() with a short TTL.
  // Subsequent calls within the TTL return the cached value, eliminating
  // the read-back tight-loop's redundant aggregator round-trips.
  // Cleared on shutdown(); concurrent callers attach to #inFlightRecover.
  readonly #recoverCacheTtlMs: number;
  #cachedRecover: {
    readonly result: RecoverResult | RecoverAllUnfetchableResult | null;
    readonly expiresAt: number;
  } | null = null;
  // In-flight dedup: when set, a concurrent recoverLatest awaits this
  // promise instead of launching a parallel aggregator round-trip.
  // Cleared in finally after settle (success or failure).
  #inFlightRecover: Promise<RecoverResult | RecoverAllUnfetchableResult | null> | null = null;

  constructor(init: ProfilePointerLayerInit) {
    this.#init = init;
    // Steelman² remediation: extract just the known boolean fields
    // into a normalized frozen snapshot. Previous fix used spread +
    // Object.freeze, which is SHALLOW — a future config schema with
    // nested objects (e.g. `{ gateways: { trusted: [...] } }`) would
    // silently re-introduce the post-construction-mutation bug for
    // nested fields. Normalizing to known fields with `=== true`
    // coercion also defensively rejects truthy non-boolean values
    // (e.g., `'yes'`, `1`) which could otherwise sneak through.
    const suppliedConfig: PointerLayerConfig = init.config ?? {};
    // T-E26 production guard runs against the RAW input so the
    // `allowUnverifiedOverride` v1-deferral marker (raises CAPABILITY_DENIED
    // outside NODE_ENV=development per SPEC §13.4 / O-5) still fires
    // even though the field is not retained in the normalized snapshot.
    assertConfigCapabilities(suppliedConfig);
    // Steelman² remediation: extract just the known boolean field into
    // a normalized frozen snapshot. This drops `allowUnverifiedOverride`
    // post-guard — defense-in-depth, since the field has no behavior
    // effect in v1 and won't be read by any code path.
    //
    // Issue #264: `enablePointerWinBroadcasts` is normalized via
    // `=== true` so accidental truthy non-boolean values (`'true'`,
    // `1`) fail closed. The flag's default is OFF — the broadcast
    // pipeline is an optimization layer not load-bearing for
    // convergence (see PointerLayerConfig.enablePointerWinBroadcasts
    // for the full design rationale).
    this.#config = Object.freeze({
      allowOperatorOverrides: suppliedConfig.allowOperatorOverrides === true,
      enablePointerWinBroadcasts:
        suppliedConfig.enablePointerWinBroadcasts === true,
    });

    // Issue #364 Item #1 — clamp the recoverLatest cache TTL. A non-
    // finite / negative value disables the cache (treated as 0). The
    // upper bound (60s) prevents pathological misconfigurations from
    // pinning a stale aggregator view for arbitrarily long.
    const rawTtl = init.recoverLatestCacheTtlMs;
    const ttlCandidate =
      typeof rawTtl === 'number' && Number.isFinite(rawTtl) && rawTtl >= 0
        ? rawTtl
        : 10_000;
    this.#recoverCacheTtlMs = Math.min(ttlCandidate, 60_000);
  }

  /**
   * Issue #264 — capability gate for the pointer-win broadcast
   * pipeline. Consulted by:
   *   - `LifecycleManager.publishAggregatorPointerBestEffort` before
   *     signing the broadcast payload and emitting the
   *     `storage:pointer-published` event (publisher).
   *   - `Sphere.maybeInstallPointerWinSubscription` before installing
   *     the per-wallet Nostr subscription (subscriber).
   *
   * Default: `false`. See PointerLayerConfig.enablePointerWinBroadcasts
   * for the full rationale.
   *
   * **API pairing contract.** Test stubs / alternative pointer-layer
   * implementations that expose `winBroadcastsEnabled()` MUST also
   * expose `getSignerForWinBroadcast()` — the publisher and subscriber
   * guards treat them as a coupled pair (a partial implementation is
   * treated as flag=false / fail-closed). Implementing only one
   * silently disables broadcasts with no error.
   *
   * **Accessor contract.** `winBroadcastsEnabled()` MUST be a pure
   * accessor and MUST NOT throw. Both the publisher (lifecycle-
   * manager) and subscriber (Sphere) guards wrap the accessor call
   * in a defensive try/catch that treats a throw as flag=false
   * (fail-closed). The publish path still reports success; the
   * subscriber early-returns without registering the per-wallet
   * Nostr subscription. A single log line is emitted per accessor
   * throw at debug-level (Sphere) and host-log level
   * (lifecycle-manager) so operators can correlate. A real
   * `ProfilePointerLayer` reads its frozen config snapshot and
   * cannot throw; this defensive treatment exists so a misbehaving
   * stub or alternative implementation cannot silently corrupt
   * publish-success classification or trigger noisy
   * subscription-install retries.
   *
   * **Init-time-only flag.** The flag is captured in the frozen
   * `#config` snapshot at construction time. Flipping
   * `enablePointerWinBroadcasts` at runtime (e.g., via a hot config
   * reload that constructs a NEW `ProfilePointerLayer`) requires:
   *   (1) Tearing down the old layer (calling `shutdown()`); AND
   *   (2) Rebuilding the wiring so the new layer's
   *       `winBroadcastsEnabled() === true` is observed by both
   *       publisher and subscriber on next event.
   * The publisher side picks up the new flag on its next successful
   * publish. The subscriber side picks it up on the next emitted
   * `storage:pointer-published` event — which only fires when the
   * publisher is also enabled, so the first such event after the flip
   * arms the subscription automatically. There is no third trigger
   * that would re-arm the subscriber on a flip from false→true
   * without a fresh publish.
   *
   * **Receive-only-wallet caveat.** A wallet that has the flag
   * enabled but never PUBLISHES (e.g., a pure receive endpoint that
   * only ingests sibling-device payments) will never emit a
   * `storage:pointer-published` event of its own. Its
   * `maybeInstallPointerWinSubscription` is therefore not triggered
   * by its own publish path; the subscription only arms if some
   * external code path calls `maybeInstallPointerWinSubscription()`
   * directly. As of #264, `core/Sphere.ts` does NOT arrange an
   * explicit init-time call — receive-only-wallet support for
   * pointer-win broadcasts requires a follow-up wiring change (an
   * init-time invocation gated on the flag's enabled state, OR a
   * lazy first-incoming-event trigger). Acceptable today because
   * the flag is default-OFF and the broadcast pipeline is an
   * optimization layer (the aggregator pointer + auto-merge cover
   * correctness without it).
   */
  winBroadcastsEnabled(): boolean {
    return this.#config.enablePointerWinBroadcasts === true;
  }

  /**
   * RFC-251 Approach D (issue #255 Problem B) — expose the pointer layer's
   * signing pubkey + signer to the integration wiring layer (Sphere /
   * ProfileTokenStorageProvider). The win-broadcast publisher needs
   * the pubkey hex to build the per-wallet broadcast tag, and the
   * signer to sign the broadcast payload. The signer itself is exposed
   * read-only — callers can only sign payloads, not mutate the signer's
   * state.
   *
   * Returns a tuple rather than two getters so consumers can destructure
   * once and cache for the wallet's lifetime; the underlying signer
   * never rotates within a `ProfilePointerLayer` instance.
   */
  getSignerForWinBroadcast(): {
    readonly signer: import('./signing.js').PointerSigner;
    readonly signingPubKeyHex: string;
  } {
    return {
      signer: this.#init.signer,
      signingPubKeyHex: this.#init.signer.signingPubKeyHex,
    };
  }

  /**
   * Wrap an async operation so it's tracked in `#inFlight` and removes
   * itself on settle. Used by the public publish/recover/probe entry
   * points so `shutdown()` can drain them.
   *
   * Implementation note: we use `op.then(cleanup, cleanup)` with both
   * handlers wired explicitly — NOT `op.finally(cleanup)` — to avoid
   * a dangling-rejection chain. `op.finally(...)` returns a NEW promise
   * that propagates the original rejection; if nothing awaits that
   * resulting promise (we don't — we return `op` directly), the
   * rejection surfaces as an unhandledRejection. The two-handler
   * `.then` form swallows the rejection on the CLEANUP chain only;
   * the caller's `await op` still observes the original rejection.
   */
  #tracked<T>(op: Promise<T>): Promise<T> {
    this.#inFlight.add(op);
    void op.then(
      () => { this.#inFlight.delete(op); },
      () => { this.#inFlight.delete(op); },
    );
    return op;
  }

  /** Throw if shutdown is in progress — used by all public entry points. */
  #assertNotShuttingDown(opName: string): void {
    if (this.#shuttingDown) {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.PUBLISH_BUSY,
        `ProfilePointerLayer.${opName}() called after shutdown() started — operation rejected.`,
      );
    }
  }

  /**
   * Wave F.2 architecture-advisory remediation: drain in-flight
   * publish/recover/probe operations before the surrounding
   * ProfileStorageProvider tears down OrbitDB. Previously the
   * disconnect path duck-typed `pointerLayer.shutdown?.()` and silently
   * no-op'd because the method did not exist — leaving an in-flight
   * Node publish able to leak its proper-lockfile mutex for up to
   * 8 seconds (until proper-lockfile's stale detector reclaimed it).
   *
   * `shutdown()` waits for all tracked operations to settle, with a
   * hard internal deadline (default 30 s) so a single hung tracked
   * promise (e.g. an aggregator-probe stuck on an unresponsive socket
   * with no per-call timeout) cannot block the entire teardown
   * indefinitely. Steelman⁴⁶ HIGH: previously, shutdown() relied on
   * callers wrapping in their own Promise.race against a timeout —
   * but no caller did, so process tear-down could hang forever.
   *
   * After the deadline expires, shutdown() returns; any still-tracked
   * operations are abandoned (they may run to completion, but the
   * surrounding storage provider can proceed with disconnect — pin/db
   * close paths are idempotent with respect to ghost continuations).
   * The caller can pass `{ timeoutMs: ... }` to override; pass `null`
   * to disable the deadline (legacy behavior).
   *
   * Steelman¹⁸: sets #shuttingDown to block new operations from being
   * enqueued during the drain. Concurrent calls both participate in
   * draining (via Promise.allSettled) rather than racing on a snapshot.
   * Safe to call multiple times — subsequent calls drain any operations
   * enqueued after the previous shutdown() completed.
   */
  async shutdown(opts?: { timeoutMs?: number | null }): Promise<void> {
    this.#shuttingDown = true;
    const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
    const timeoutMs =
      opts?.timeoutMs === null
        ? null
        : Math.max(0, opts?.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
    const drainStart = Date.now();
    while (this.#inFlight.size > 0) {
      if (timeoutMs !== null) {
        const elapsed = Date.now() - drainStart;
        const remaining = timeoutMs - elapsed;
        if (remaining <= 0) {
          // Steelman⁴⁶: deadline tripped — log and return. The set may
          // still contain promises that will eventually settle in the
          // background; their #inFlight self-removal handler is harmless
          // after the layer is shut down (Set.delete on absent key noops).
          // We deliberately do NOT clear #inFlight: a caller observing
          // it post-shutdown can still see what was abandoned.
          break;
        }
        let drainTimer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<void>((resolve) => {
          drainTimer = setTimeout(() => resolve(), remaining);
          if (typeof drainTimer === 'object' && drainTimer !== null && 'unref' in drainTimer) {
            (drainTimer as { unref: () => void }).unref();
          }
        });
        try {
          await Promise.race([Promise.allSettled([...this.#inFlight]), timeoutPromise]);
        } finally {
          if (drainTimer !== undefined) clearTimeout(drainTimer);
        }
      } else {
        await Promise.allSettled([...this.#inFlight]);
      }
    }
    // Steelman⁴⁰ note: drop the probe-fingerprint history so a consumer
    // holding a layer reference doesn't pin ~33KB of integers per
    // shutdown cycle. The fingerprint API is not safe to call after
    // shutdown anyway (#assertNotShuttingDown gates it).
    this.#lastProbeVersions = [];
    // Issue #364 Item #1 — clear the recoverLatest cache so a future
    // re-init reading a fresh aggregator view never observes stale
    // bytes. The in-flight slot is cleared by the operation's own
    // finally arm during the drain above.
    this.#cachedRecover = null;
  }

  // ── publish ──────────────────────────────────────────────────────────────

  /**
   * Publish a CID as the new latest pointer. Runs the full reconcile loop:
   *   - discover V_true
   *   - target nextV = max(validV, includedV) + 1 (H4)
   *   - submit + §7.3 state machine + §7.4 backoff
   *   - on conflict: fetchAndJoin remote, advance localVersion, retry
   *
   * @param cidProducer  Callback that (re)produces the CID bytes. Called
   *   fresh on each reconcile iteration so the bundle may include state
   *   merged from fetchAndJoin on prior conflicts.
   * @param opts.abortSignal  Wave G.4: caller-supplied cancellation
   *   signal. Aborting unwinds the reconcile loop at the next safe
   *   checkpoint (between iterations, or via the deadline race inside
   *   submitPointer / probeVersion). The signal is propagated all the
   *   way down through `submitOneSide` and `fetchProofWithTimeout`,
   *   so an in-flight HTTP RPC is cancelled promptly rather than
   *   running to its per-side timeout.
   */
  async publish(
    cidProducer: () => Promise<Uint8Array>,
    opts?: { abortSignal?: AbortSignal },
  ): Promise<PublishResult> {
    this.#assertNotShuttingDown('publish');
    return this.#tracked(this.#publishInner(cidProducer, opts?.abortSignal));
  }

  async #publishInner(
    cidProducer: () => Promise<Uint8Array>,
    abortSignal?: AbortSignal,
  ): Promise<PublishResult> {
    if (abortSignal?.aborted) {
      const err = new Error('publish aborted by caller');
      err.name = 'AbortError';
      throw err;
    }
    const currentLocalVersion = await this.#init.readLocalVersion();
    const result = await reconcileAndPublish({
      cidProducer,
      currentLocalVersion,
      keyMaterial: this.#init.keyMaterial,
      signer: this.#init.signer,
      aggregatorClient: this.#init.aggregatorClient,
      trustBase: this.#init.trustBase,
      flagStore: this.#init.flagStore,
      mutex: this.#init.mutex,
      decodeCid: this.#init.decodeCid,
      fetchCar: this.#init.fetchCar,
      fetchAndJoin: this.#init.fetchAndJoin,
      persistLocalVersion: this.#init.persistLocalVersion,
      resolveRemoteCid: this.#init.resolveRemoteCid,
      abortSignal,
    });
    // Issue #366 — invalidate the recoverLatest head cache after a
    // successful publish. The cache's pre-#366 design assumed the
    // aggregator view was the only source of pointer-version change
    // observable to this layer; a local publish that commits a new
    // version (`reconcileAndPublish` returns without throwing) breaks
    // that assumption. Downstream readers — chiefly the read-back loop
    // at `LifecycleManager.awaitAggregatorPointerReadBack`, but also
    // any caller polling after a flush — must see the freshly-committed
    // version, not the cached pre-publish view served for the rest of
    // the TTL window. The §D.4 wall-clock degradation observed in PR
    // #365's A/B (243s → 467s when the cache was enabled) traced
    // directly to this gap: the read-back loop spent the cache TTL
    // re-asserting a stale answer.
    //
    // Cleared inside the `#publishInner` body (post-publish, pre-
    // return) so EVERY successful publish path invalidates — including
    // the fast-path that skips Step B (`result.attemptsUsed === 0`).
    // The in-flight slot is NOT touched here: a concurrent recover
    // that's already awaiting `#inFlightRecover` will still receive
    // that round-trip's result. A NEW recover after this point starts
    // fresh.
    if (this.#cachedRecover !== null) {
      incr('pointerLayer.recoverLatest.cacheInvalidatedOnPublish');
      this.#cachedRecover = null;
    }
    // Issue #264 steelman fix: only overwrite the probe history when
    // the publish actually ran a discovery walkback. The fast-path
    // (#263, attempts === 0) skips Step B and returns
    // `probeHistory: []`. Unconditionally assigning would clobber any
    // fingerprint populated by a prior discovery / recoverLatest /
    // probe call — destroying the UI same-wallet-clustering signal
    // surfaced by `getProbeFingerprint()`. The non-empty guard keeps
    // the last meaningful probe sequence available across fast-path
    // publishes.
    if (result.probeHistory.length > 0) {
      this.#lastProbeVersions = result.probeHistory;
    }
    return {
      version: result.v,
      attemptsUsed: result.attemptsUsed,
      walkbackUnfetchableSkipped: result.walkbackUnfetchableSkipped,
    };
  }

  // ── recoverLatest ────────────────────────────────────────────────────────

  /**
   * Discover + recover the latest VALID pointer.
   *
   * Return value semantics (three distinct cases):
   *
   *   `RecoverResult`              — VALID version found; `cid` and `version`
   *                                  are the latest fetchable snapshot.
   *                                  `walkbackUnfetchableSkipped` lists any
   *                                  CAR_TRANSIENT slots walked past.
   *
   *   `null`                       — Fresh wallet: no pointer has ever been
   *                                  published (validV === 0 AND no
   *                                  walkbackUnfetchableSkipped). The
   *                                  lifecycle layer may fall through to
   *                                  legacy IPNS migration or skip it for
   *                                  a truly new wallet.
   *
   *   `RecoverAllUnfetchableResult` — Anchors EXIST on-chain (validV === 0
   *                                   because every slot returned CAR_TRANSIENT)
   *                                   but NOT a single CAR is reachable.
   *                                   Callers MUST NOT fall through to legacy
   *                                   IPNS migration — the pointer chain is
   *                                   intact; only the gateways are down.
   *                                   Retry on the next poll cycle.
   *
   * SPEC §13 recoverLatest semantics are extended: the three-case return
   * disambiguates "no pointer" from "pointer exists but gateways are down".
   */
  async recoverLatest(opts?: {
    abortSignal?: AbortSignal;
  }): Promise<RecoverResult | RecoverAllUnfetchableResult | null> {
    return time('pointerLayer.recoverLatest', async () => {
      this.#assertNotShuttingDown('recoverLatest');
      // Issue #364 Item #1 — cache-first path. The cache sits INSIDE
      // the `time()` wrapper so hit/miss latencies both count toward
      // the aggregate cost recorded in `pointerLayer.recoverLatest`.
      // Cache hits are sub-millisecond, which shows up in the counter
      // snapshot as a dramatic drop in totalMs/avgMs without changing
      // the call count semantic (every public call is counted once).
      const abortSignal = opts?.abortSignal;
      if (abortSignal?.aborted) {
        const err = new Error('recoverLatest aborted by caller');
        err.name = 'AbortError';
        throw err;
      }
      // Cache hit: serve from #cachedRecover when within TTL. The
      // cached value is shared across callers — this is sound because
      // RecoverResult / RecoverAllUnfetchableResult / null are
      // immutable value types from the caller's perspective.
      if (this.#recoverCacheTtlMs > 0 && this.#cachedRecover !== null) {
        if (Date.now() < this.#cachedRecover.expiresAt) {
          incr('pointerLayer.recoverLatest.cacheHit');
          return this.#cachedRecover.result;
        }
        // TTL expired — fall through to a fresh aggregator round-trip.
        incr('pointerLayer.recoverLatest.cacheStale');
        this.#cachedRecover = null;
      }
      // In-flight dedup: a concurrent caller already triggered the
      // aggregator call. Attach to the same promise instead of
      // launching a parallel round-trip. The attached caller does NOT
      // share the upstream call's abort signal — aborting one waiter
      // must not cancel the request for the others (we've already
      // checked our own signal above).
      if (this.#inFlightRecover !== null) {
        incr('pointerLayer.recoverLatest.inFlightDedup');
        return this.#inFlightRecover;
      }
      // cacheMiss is only meaningful when caching is enabled. With
      // TTL=0 (cache disabled) every call is structurally a miss and
      // emitting the counter would conflate the two modes.
      if (this.#recoverCacheTtlMs > 0) {
        incr('pointerLayer.recoverLatest.cacheMiss');
      }
      const inner = this.#tracked(this.#recoverLatestInner(abortSignal));
      this.#inFlightRecover = inner;
      try {
        const result = await inner;
        // Populate the cache only when the TTL is enabled. A fresh
        // shutdown() between launch and settle clears #cachedRecover
        // below; we still record the result on the local variable so
        // any awaiting callers receive it consistently.
        if (this.#recoverCacheTtlMs > 0 && !this.#shuttingDown) {
          this.#cachedRecover = {
            result,
            expiresAt: Date.now() + this.#recoverCacheTtlMs,
          };
        }
        return result;
      } finally {
        // Always clear the in-flight slot, even on failure — the next
        // call should retry the aggregator rather than re-throwing the
        // cached rejection (which would defeat the read-back retry
        // loop's recovery semantics).
        if (this.#inFlightRecover === inner) {
          this.#inFlightRecover = null;
        }
      }
    });
  }

  async #recoverLatestInner(
    abortSignal?: AbortSignal,
  ): Promise<RecoverResult | RecoverAllUnfetchableResult | null> {
    // Steelman¹⁹ critical #3: call the INNER discoverLatestVersion helper
    // directly. Going through the public method would re-run
    // #assertNotShuttingDown — if shutdown() fires after recoverLatest's
    // own assert passed but before this inner call, the inner assert
    // would throw PUBLISH_BUSY mid-recovery, surfacing a confusing
    // "called after shutdown() started" error and leaving the recover
    // half-completed.  The OUTER recoverLatest tracking via #tracked()
    // already covers this composite operation.
    if (abortSignal?.aborted) {
      const err = new Error('recoverLatest aborted by caller');
      err.name = 'AbortError';
      throw err;
    }
    const discovery = await this.#discoverLatestVersionInner(undefined, abortSignal);

    if (discovery.validV === 0) {
      // Disambiguate: did Phase 3 skip-past any CAR_TRANSIENT versions?
      //   - Yes (walkbackUnfetchableSkipped non-empty): anchors exist on-chain
      //     but every CAR is unreachable. Return RecoverAllUnfetchableResult so
      //     the lifecycle layer can refuse legacy IPNS migration and schedule
      //     a retry.
      //   - No: genuinely fresh wallet — no pointer ever published. Return null.
      const skippedOnly = discovery.walkbackUnfetchableSkipped;
      if (skippedOnly && skippedOnly.length > 0) {
        return { kind: 'all-unfetchable', walkbackUnfetchableSkipped: skippedOnly };
      }
      return null;
    }

    const cid = await this.#init.resolveRemoteCid(discovery.validV);
    // Surface walkback-unfetchable telemetry to the caller. The lifecycle
    // layer uses this to emit a typed event so operators can detect when
    // a wallet recovered to an older predecessor because a newer slot
    // was EXISTS-BUT-UNFETCHABLE. Empty when no skip-past occurred or
    // when the wallet ran in SPEC-strict mode.
    const walkbackUnfetchableSkipped = discovery.walkbackUnfetchableSkipped;
    return {
      cid,
      version: discovery.validV,
      ...(walkbackUnfetchableSkipped && walkbackUnfetchableSkipped.length > 0
        ? { walkbackUnfetchableSkipped }
        : {}),
    };
  }

  // ── reconcileLocalVersionDownward ────────────────────────────────────────

  /**
   * Issue #247 — adopt a strictly-lower aggregator-visible version as
   * the wallet's local baseline. Solves the same-identity cross-device
   * race where two devices each push localVersion ahead of the
   * aggregator's currently-visible value and both subsequently hit
   * W7 WALKBACK_FLOOR for the SPEC-correct reason (cannot walk past
   * a version this wallet has already confirmed as its own).
   *
   * **Authoring trust note (SAFETY-CRITICAL).** The `candidate` MUST
   * originate from this wallet's own `recoverLatest()` call. Because
   * `recoverLatest()` runs `classifyVersion`, which XOR-decodes the
   * inclusion-proof ciphertext with the wallet's `keyMaterial.xorSeed`
   * (HKDF-derived from the wallet's private key) and then verifies the
   * decoded CID via `fetchCar`'s content-address check, a candidate
   * surfaced by `recoverLatest()` is *implicitly* authenticated as
   * authored by this wallet. A foreign-author commitment at the same
   * version V would XOR-decode under our seed to a different 32-byte
   * pair, the resulting CID would fail content-address verification,
   * and `classifyVersion` would return SEMANTICALLY_INVALID — never
   * surfaced through `recoverLatest()` as a non-null result.
   *
   * Callers passing a `RecoverResult` from `recoverLatest()` therefore
   * get same-author-only downgrades by construction. Callers crafting
   * a candidate from another source MUST guarantee equivalent author
   * verification themselves (no such caller exists in this SDK).
   *
   * **Side effects.** When `candidate.version < currentLocalVersion`,
   * the method:
   *   1. Persists `profile.pointer.version = candidate.version` via
   *      the wired `persistLocalVersion` callback.
   *   2. Returns `{ reconciled: true, fromVersion, toVersion }`.
   *
   * Otherwise (`candidate.version >= currentLocalVersion`), it is a
   * no-op and returns `{ reconciled: false, ... }`.
   *
   * **NOT a CONFLICT path.** This is not §9.2 conflict reconciliation
   * — there is no `fetchAndJoin` of remote OpLog state, no bundle ref
   * write. The semantic is "the aggregator's view of our pointer is
   * BEHIND our local cursor; rewind our cursor so we publish from a
   * baseline the aggregator can see." Bundle data already published
   * at versions in `(candidate.version, fromVersion]` remains on IPFS
   * and is rediscoverable via the standard publish-retry path —
   * publish at `candidate.version + 1` will conflict against any
   * still-live version, re-trigger discovery, and converge.
   */
  async reconcileLocalVersionDownward(
    candidate: RecoverResult,
  ): Promise<ReconcileDownwardResult> {
    this.#assertNotShuttingDown('reconcileLocalVersionDownward');
    return this.#tracked(this.#reconcileLocalVersionDownwardInner(candidate));
  }

  async #reconcileLocalVersionDownwardInner(
    candidate: RecoverResult,
  ): Promise<ReconcileDownwardResult> {
    const fromVersion = await this.#init.readLocalVersion();
    if (candidate.version >= fromVersion) {
      // No downgrade possible — caller should fall through to the
      // normal forward publish path.
      return { reconciled: false, fromVersion, toVersion: fromVersion };
    }
    // The candidate is strictly lower AND (by recoverLatest's classify-
    // version XOR-decode authentication) authored under this wallet's
    // signing identity. Adopt it as the new local baseline.
    await this.#init.persistLocalVersion(candidate.version);
    return { reconciled: true, fromVersion, toVersion: candidate.version };
  }

  // ── discoverLatestVersion ────────────────────────────────────────────────

  /**
   * Run only the discovery phase (no CAR fetch, no XOR-decode, no CID parse —
   * BUT Phase 3 still calls classifyVersion which DOES fetch CAR for
   * validation per SPEC §8.2 step 3). Returns { validV, includedV } per H4.
   */
  async discoverLatestVersion(
    walkbackLimit?: number,
    opts?: { abortSignal?: AbortSignal },
  ): Promise<DiscoverResult> {
    return time('pointerLayer.discoverLatestVersion', () => {
      this.#assertNotShuttingDown('discoverLatestVersion');
      return this.#tracked(this.#discoverLatestVersionInner(walkbackLimit, opts?.abortSignal));
    });
  }

  async #discoverLatestVersionInner(
    walkbackLimit?: number,
    abortSignal?: AbortSignal,
  ): Promise<DiscoverResult> {
    if (abortSignal?.aborted) {
      const err = new Error('discoverLatestVersion aborted by caller');
      err.name = 'AbortError';
      throw err;
    }
    const currentLocalVersion = await this.#init.readLocalVersion();
    // Issue #310 — prime walkback with the wallet's persisted epoch
    // floor (best-effort). A missing or erroring callback leaves the
    // floor at 0 (pre-#310 behavior).
    let initialEpochFloor = 0;
    if (this.#init.readEpochFloor) {
      try {
        const stored = await this.#init.readEpochFloor();
        if (
          typeof stored === 'number' &&
          Number.isFinite(stored) &&
          Number.isInteger(stored) &&
          stored >= 0
        ) {
          initialEpochFloor = stored;
        }
      } catch {
        // Best-effort: bad read → floor stays at 0.
      }
    }
    const inspectEpochCb = this.#init.inspectSnapshotEpoch;
    const result = await findLatestValidVersion({
      currentLocalVersion,
      keyMaterial: this.#init.keyMaterial,
      signer: this.#init.signer,
      aggregatorClient: this.#init.aggregatorClient,
      trustBase: this.#init.trustBase,
      decodeCid: this.#init.decodeCid,
      fetchCar: this.#init.fetchCar,
      walkbackLimit,
      abortSignal,
      initialEpochFloor,
      inspectSnapshotEpoch: inspectEpochCb
        ? (v: PointerVersion, _cidBytes: Uint8Array) => inspectEpochCb(v)
        : undefined,
    });
    // Issue #310 — persist a newly-observed epoch floor (best-effort).
    // The next discovery starts from this primed value, so an
    // aggregator that still serves a pre-reset pointer (e.g.,
    // cross-device sync lag after a sibling's resetEpoch) cannot
    // trick this wallet into walking back to a pre-reset version.
    if (
      this.#init.persistEpochFloor &&
      typeof result.pickedEpoch === 'number' &&
      result.pickedEpoch > initialEpochFloor
    ) {
      try {
        await this.#init.persistEpochFloor(result.pickedEpoch);
      } catch {
        // Best-effort: next discovery re-observes + re-persists.
      }
    }
    // Issue #264 steelman fix (symmetric with `publish`): only overwrite
    // the probe-fingerprint history when discovery actually produced
    // probes. A discoverLatestVersion that resolves on the first probe
    // (no walkback needed) returns an empty `probeVersions` array;
    // unconditionally assigning would clobber any fingerprint
    // populated by a prior discovery / publish / probe call. Since
    // `recoverLatest()` is implemented as
    // `#recoverLatestInner → #discoverLatestVersionInner → here`, this
    // fix also covers the recoverLatest path the steelman flagged.
    if (result.probeVersions.length > 0) {
      this.#lastProbeVersions = result.probeVersions;
    }
    return result;
  }

  // ── isReachable ──────────────────────────────────────────────────────────

  /**
   * Aggregator reachability probe via HEALTH_CHECK_REQUEST_ID (§11.12).
   * Returns true iff aggregator responded with any HTTP response (even a
   * permissible PATH_NOT_INCLUDED). False only on network-level failure.
   */
  async isReachable(): Promise<boolean> {
    this.#assertNotShuttingDown('isReachable');
    return this.#tracked(
      isReachable({
        signingPubKey: this.#init.signer.signingPubKey,
        aggregatorClient: this.#init.aggregatorClient,
      }),
    );
  }

  // ── isPublishBlocked ─────────────────────────────────────────────────────

  /**
   * Query the persistent BLOCKED state (§10.2). Returns true iff
   * BLOCKED_FLAG_KEY is set.
   *
   * Steelman¹⁹ warning: a CORRUPT record (invalid JSON, bad shape, or
   * unrecognized reason) is treated as BLOCKED for the purpose of read-
   * API queries. Read APIs are pure observations — letting CORRUPT
   * propagate would change a stable contract (always returns boolean) into
   * a throwing API and break consumers (UIs, telemetry, the publish
   * pre-check). The publish path still routes CORRUPT through the proper
   * error code via `setBlocked`'s catch-and-overwrite recovery, so this
   * wrapper does not mask the CORRUPT classification — it just keeps the
   * read API predictable.
   */
  async isPublishBlocked(): Promise<boolean> {
    this.#assertNotShuttingDown('isPublishBlocked');
    return this.#tracked(this.#isPublishBlockedInner());
  }
  async #isPublishBlockedInner(): Promise<boolean> {
    try {
      const state = await readBlockedState(this.#init.flagStore);
      return state.blocked;
    } catch (err) {
      if (err instanceof AggregatorPointerError && err.code === AggregatorPointerErrorCode.CORRUPT) {
        return true; // fail-closed: treat corrupt record as blocked
      }
      throw err;
    }
  }

  /**
   * Returns the full BlockedState including reason and setAt timestamp.
   *
   * Steelman¹⁹ warning: on CORRUPT, returns a synthetic state with
   * `reason='corrupt'` and `setAt=0` so callers (UIs, telemetry) get a
   * stable shape. Operators investigating a corrupt block flag can read
   * the underlying record directly via the FlagStore.
   */
  async getBlockedState(): Promise<BlockedState> {
    this.#assertNotShuttingDown('getBlockedState');
    return this.#tracked(this.#getBlockedStateInner());
  }
  async #getBlockedStateInner(): Promise<BlockedState> {
    try {
      return await readBlockedState(this.#init.flagStore);
    } catch (err) {
      if (err instanceof AggregatorPointerError && err.code === AggregatorPointerErrorCode.CORRUPT) {
        // Steelman²⁰: setAt = Date.now() (capture-time of the synthetic
        // event) so downstream `Date.now() - setAt` math returns small
        // values, not "blocked since 1970". 'corrupt' is now a recognized
        // synthetic-only BlockedReason in the union (see blocked-state.ts).
        return { blocked: true, reason: 'corrupt', setAt: Date.now() };
      }
      throw err;
    }
  }

  // ── clearBlocked ─────────────────────────────────────────────────────────

  /**
   * Clear BLOCKED after a legitimate §10.2.4 exit condition is met.
   * Gated on allowOperatorOverrides — the spec's strict CLEAR paths
   * (exclusion-proof or successful recovery) are typically detected and
   * cleared automatically by recoverLatest; this method is for operator-
   * initiated recovery when automatic detection is insufficient.
   *
   * Steelman⁴⁶ MEDIUM (forward-compat downgrade): when the persisted
   * BLOCKED record is well-formed in shape but its `reason` is not
   * recognized by this SDK build (e.g. a newer SDK wrote it and the
   * user rolled back), allow clearing WITHOUT operator override. A
   * recognized BLOCKED state still requires the override. This trades a
   * small attacker-injected-unknown-reason gap (which is already gated
   * by storage-write access — equivalent to setting any recognized
   * reason that this SDK could clear) for a real recovery path on
   * downgrade.
   *
   * @throws AggregatorPointerError(CAPABILITY_DENIED) if overrides disabled
   *   AND the persisted reason is recognized (or there is no persisted
   *   record at all — calling clearBlocked without a real block is a
   *   no-op but should still respect the capability gate).
   */
  async clearBlocked(): Promise<void> {
    this.#assertNotShuttingDown('clearBlocked');
    return this.#tracked(this.#clearBlockedInner());
  }
  async #clearBlockedInner(): Promise<void> {
    // Steelman⁴⁷ MEDIUM: TOCTOU between the unrecognized-reason probe
    // and the clear. A sibling process can flip an unrecognized
    // reason to a recognized one between the two reads, allowing the
    // clear to land without operator-override authority. Defense:
    // re-read inside the critical section just before clearing and
    // require the reason to STILL be unrecognized (or assert the
    // override).  If the override is present, no re-read is needed.
    if (this.#config.allowOperatorOverrides) {
      await clearBlockedFlag(this.#init.flagStore);
      return;
    }
    const isUnrecognized = await hasUnrecognizedBlockedReason(this.#init.flagStore);
    if (!isUnrecognized) {
      assertOperatorOverridesAllowed(this.#config, 'clearBlocked');
    }
    // Re-read just before the destructive remove. If the reason is
    // no longer unrecognized (sibling rewrote it), enforce the gate.
    const stillUnrecognized = await hasUnrecognizedBlockedReason(this.#init.flagStore);
    if (!stillUnrecognized) {
      assertOperatorOverridesAllowed(this.#config, 'clearBlocked');
    }
    await clearBlockedFlag(this.#init.flagStore);
  }

  // ── clearBlockedIfTransient ──────────────────────────────────────────────

  /**
   * Issue #319 — auto-clear the BLOCKED flag iff the current reason is a
   * transient-connectivity class (see {@link isTransientRecoveryReason}).
   * Intended to be invoked by the pointer-poll worker AFTER a successful
   * `recoverLatest()` round-trip, on the principle that a working
   * aggregator response refutes any prior "I can't reach the aggregator"
   * BLOCKED reason.
   *
   * Categorical safety rules:
   *
   *   - Does NOT consult `allowOperatorOverrides`. This is not an
   *     operator-initiated clear — it is a self-healing clear gated on
   *     the narrow predicate that the reason itself is transient. The
   *     existing operator-override gate is reserved for `clearBlocked()`
   *     which must remain capable of clearing ANY reason (including
   *     persistent ones like `rejected` / `marker_corrupt`).
   *
   *   - Treats a CORRUPT blocked-state record as "do not clear". A
   *     tampered or malformed record must surface to the operator via
   *     the existing CORRUPT paths.
   *
   *   - Treats no-block-set (`{ blocked: false }`) as a no-op success.
   *
   *   - Persistent-class reasons (`aggregator_rejected`, `protocol_error`,
   *     `marker_corrupt`, `rejected`) are LEFT UNTOUCHED and reported back
   *     via the return value's `reason` field so callers can surface them.
   *
   * Race window: between the read (`isBlocked`) and the destructive
   * `clearBlockedFlag`, a sibling process MAY rewrite the BLOCKED record
   * with a persistent reason. The transient/persistent classification is
   * a property of the SPEC reason taxonomy, so the worst-case outcome of
   * such a race is that we clear a persistent block whose persistent
   * status was being established. We accept this because (a) the sibling
   * race is exceptionally narrow and (b) the next failed publish will
   * immediately re-set BLOCKED with the persistent reason. The mutex on
   * publish prevents the AUTOMATED case (poll + publish overlap) entirely.
   *
   * @returns `{ cleared: true, reason }` when the flag was removed,
   *   `{ cleared: false }` when nothing was cleared, or
   *   `{ cleared: false, reason }` when a non-transient block remains in place.
   */
  async clearBlockedIfTransient(): Promise<{
    readonly cleared: boolean;
    readonly reason?: BlockedReason;
  }> {
    this.#assertNotShuttingDown('clearBlockedIfTransient');
    return this.#tracked(this.#clearBlockedIfTransientInner());
  }
  async #clearBlockedIfTransientInner(): Promise<{
    readonly cleared: boolean;
    readonly reason?: BlockedReason;
  }> {
    let state: BlockedState;
    try {
      state = await readBlockedState(this.#init.flagStore);
    } catch (err) {
      // CORRUPT / read failure: never auto-clear. The existing CORRUPT
      // surfacing path (via getBlockedState / publishOnceAtVersion) is the
      // correct channel for the operator-investigation signal.
      if (err instanceof AggregatorPointerError && err.code === AggregatorPointerErrorCode.CORRUPT) {
        return { cleared: false };
      }
      throw err;
    }
    if (!state.blocked) return { cleared: false };
    // When `blocked === true`, `readBlockedState` (isBlocked in
    // blocked-state.ts) has already validated `reason` against
    // KNOWN_BLOCKED_REASONS, so the cast to BlockedReason is sound.
    // The structural typing in `BlockedState.reason: string | undefined`
    // is intentionally loose to accommodate the `blocked: false` branch.
    const reason = state.reason as BlockedReason | undefined;
    if (!reason || !isTransientRecoveryReason(reason)) {
      return { cleared: false, reason };
    }
    // Steelman²³: re-read inside the critical section just before the
    // destructive clear. Two failure modes this defends against:
    //
    //   (1) Bare TOCTOU. A sibling process may have written a
    //       PERSISTENT reason (e.g. `marker_corrupt`, `aggregator_rejected`,
    //       `rejected`, `protocol_error`) between our initial read and
    //       this point. The earlier read would surface the older
    //       transient reason; clearing the record now would silently
    //       wipe the persistent signal.
    //
    //   (2) Idempotency masking. `setBlocked` is idempotent — once a
    //       record exists, subsequent calls SKIP overwriting. So if
    //       the wallet was blocked with `retry_exhausted` and a
    //       concurrent publish path then tried to flag `marker_corrupt`,
    //       the persistent reason WAS dropped at write time. Our
    //       initial read sees only the original transient reason.
    //       Re-reading does NOT save us here — the persistent reason
    //       was never persisted to read. The mitigation is owned by
    //       `setBlocked`'s precedence rule (see blocked-state.ts);
    //       this re-read defends only against case (1).
    //
    // Net guarantee with this guard: if a PERSISTENT reason was
    // observably persisted at any point between our two reads, we
    // refuse to clear. This is the narrow correctness property that
    // matters; the broader masking concern is documented in
    // `blocked-state.ts:setBlocked` and gated by the operator runbook.
    const stateAfter = await readBlockedState(this.#init.flagStore);
    if (!stateAfter.blocked) {
      // Sibling cleared between our reads (e.g., explicit
      // `clearBlocked()` from another tab). Nothing to do.
      return { cleared: false };
    }
    const reasonAfter = stateAfter.reason as BlockedReason | undefined;
    if (!reasonAfter || !isTransientRecoveryReason(reasonAfter) || reasonAfter !== reason) {
      // Reason changed under us — either to a persistent class (must
      // not clear) or to a different transient class (must report the
      // current state, not the stale one we initially read).
      return { cleared: false, reason: reasonAfter };
    }
    await clearBlockedFlag(this.#init.flagStore);
    return { cleared: true, reason };
  }

  // ── clearPendingMarker ───────────────────────────────────────────────────

  /**
   * Operator recovery path for a corrupt pending-version marker (§7.1.4 C1
   * clamp failure). Gated on allowOperatorOverrides. Side effect: SETs
   * BLOCKED so the next pass through §10.2.4 CLEAR requires verified
   * recovery — prevents a bypass where clearing a marker alone would
   * resume publish without re-verification.
   *
   * @throws AggregatorPointerError(CAPABILITY_DENIED) if overrides disabled.
   */
  async clearPendingMarker(): Promise<void> {
    this.#assertNotShuttingDown('clearPendingMarker');
    assertOperatorOverridesAllowed(this.#config, 'clearPendingMarker');
    return this.#tracked(this.#clearPendingMarkerInner());
  }
  async #clearPendingMarkerInner(): Promise<void> {
    await clearMarker(this.#init.flagStore);
    // SET BLOCKED as documented in SPEC §13 clearPendingMarker contract.
    await setBlocked(this.#init.flagStore, 'marker_corrupt');
  }

  // ── acceptCarLoss ────────────────────────────────────────────────────────

  /**
   * H7 operator override for §10.7 CAR-unavailable state.
   *
   * This is the MINIMAL implementation — it checks the wall-clock gate
   * and the capability flag, then delegates the republish + advance to
   * the caller (via the existing publish() and persistLocalVersion
   * callbacks). Peer-availability poll and the §10.7.1 (3) gossipsub
   * integration remain caller responsibilities.
   *
   * @throws AggregatorPointerError(CAPABILITY_DENIED) if overrides disabled.
   * @throws AggregatorPointerError(UNREACHABLE_RECOVERY_BLOCKED) if gate not met.
   */
  async acceptCarLoss(version: PointerVersion, cidProducer: () => Promise<Uint8Array>): Promise<PublishResult> {
    this.#assertNotShuttingDown('acceptCarLoss');
    assertOperatorOverridesAllowed(this.#config, 'acceptCarLoss');
    return this.#tracked(this.#acceptCarLossInner(version, cidProducer));
  }

  async #acceptCarLossInner(version: PointerVersion, cidProducer: () => Promise<Uint8Array>): Promise<PublishResult> {
    // Step 1: H7 wall-clock gate.
    await assertAcceptCarLossEligible(this.#init.flagStore, version);
    // Step 2: MANDATORY republish BEFORE advance (H7 step 4).
    //
    // Steelman¹⁹ critical #3: call the INNER publish helper directly so the
    // public method's #assertNotShuttingDown does not fire mid-acceptCarLoss
    // if shutdown() was triggered after the outer assert but before this
    // inner call. The outer acceptCarLoss is already tracked via #tracked();
    // the publish work is part of the same composite operation.
    const result = await this.#publishInner(cidProducer);
    // Step 3: clear the CAR-loss ledger for this version now that we've
    // successfully republished.
    await clearAttempts(this.#init.flagStore, version);
    return result;
  }

  /**
   * Record a CAR-fetch failure for H7 ledger (caller invokes this when
   * IPFS gateway fetches fail during recovery).
   */
  async recordCarFetchFailure(version: PointerVersion, gateway: string): Promise<void> {
    this.#assertNotShuttingDown('recordCarFetchFailure');
    return this.#tracked(recordAttempt(this.#init.flagStore, version, gateway));
  }

  // ── acceptCorruptStreak ──────────────────────────────────────────────────

  /**
   * W6 / §10.8 operator override: raise DISCOVERY_CORRUPT_WALKBACK for a
   * single subsequent recovery attempt. Caller passes the raised ceiling
   * to the next `discoverLatestVersion(walkbackLimit)` call.
   *
   * @throws AggregatorPointerError(CAPABILITY_DENIED) if overrides disabled.
   */
  async acceptCorruptStreak(walkbackLimit = 4096): Promise<{ walkbackUsed: number }> {
    this.#assertNotShuttingDown('acceptCorruptStreak');
    assertOperatorOverridesAllowed(this.#config, 'acceptCorruptStreak');
    // Safety ceiling per SPEC §13.
    const capped = Math.min(walkbackLimit, 4096);
    return { walkbackUsed: capped };
  }

  // ── getProbeFingerprint ─────────────────────────────────────────────────

  /**
   * Short stable hash of the last discovery probe sequence for UI
   * same-wallet-clustering signal. Returns '' if no probe has run.
   */
  async getProbeFingerprint(): Promise<string> {
    this.#assertNotShuttingDown('getProbeFingerprint');
    return computeProbeFingerprint(this.#lastProbeVersions);
  }

  // ── Probe helper (for external use / testing) ───────────────────────────

  /** Low-level probe for a single version — H2 OR-predicate. */
  async probe(v: PointerVersion): Promise<boolean> {
    return time('pointerLayer.probe', () => {
      this.#assertNotShuttingDown('probe');
      return this.#tracked(probeVersion({
        v,
        keyMaterial: this.#init.keyMaterial,
        signer: this.#init.signer,
        aggregatorClient: this.#init.aggregatorClient,
        trustBase: this.#init.trustBase,
      }));
    });
  }

  /** Low-level classifyVersion. */
  async classify(v: PointerVersion): Promise<'VALID' | 'SEMANTICALLY_INVALID' | 'PROOF_TRANSIENT' | 'CAR_TRANSIENT'> {
    return time('pointerLayer.classify', () => {
      this.#assertNotShuttingDown('classify');
      return this.#tracked(classifyVersion({
      v,
      keyMaterial: this.#init.keyMaterial,
      signer: this.#init.signer,
      aggregatorClient: this.#init.aggregatorClient,
      trustBase: this.#init.trustBase,
      decodeCid: this.#init.decodeCid,
      fetchCar: this.#init.fetchCar,
    }));
    });
  }
}
