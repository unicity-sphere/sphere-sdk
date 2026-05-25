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

import type { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
import type { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase.js';

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
  setBlocked,
} from './blocked-state.js';
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
  /** Configuration (capabilities). */
  readonly config?: PointerLayerConfig;
}

// ── Public result types ────────────────────────────────────────────────────

export interface PublishResult {
  readonly version: PointerVersion;
  readonly attemptsUsed: number;
}

export interface RecoverResult {
  readonly cid: Uint8Array;
  readonly version: PointerVersion;
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
    return { version: result.v, attemptsUsed: result.attemptsUsed };
  }

  // ── recoverLatest ────────────────────────────────────────────────────────

  /**
   * Discover + recover the latest VALID pointer.
   * Returns null when no pointer has ever been published (validV == 0).
   *
   * SPEC §13 recoverLatest semantics: returns `{ cid, version }` for the
   * latest valid version (Phase 3 winner), having classified + fetched the
   * CAR successfully.
   */
  async recoverLatest(opts?: { abortSignal?: AbortSignal }): Promise<RecoverResult | null> {
    this.#assertNotShuttingDown('recoverLatest');
    return this.#tracked(this.#recoverLatestInner(opts?.abortSignal));
  }

  async #recoverLatestInner(abortSignal?: AbortSignal): Promise<RecoverResult | null> {
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
    if (discovery.validV === 0) return null;
    const cid = await this.#init.resolveRemoteCid(discovery.validV);
    return { cid, version: discovery.validV };
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
    this.#assertNotShuttingDown('discoverLatestVersion');
    return this.#tracked(this.#discoverLatestVersionInner(walkbackLimit, opts?.abortSignal));
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
    });
    this.#lastProbeVersions = result.probeVersions;
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
    this.#assertNotShuttingDown('probe');
    return this.#tracked(probeVersion({
      v,
      keyMaterial: this.#init.keyMaterial,
      signer: this.#init.signer,
      aggregatorClient: this.#init.aggregatorClient,
      trustBase: this.#init.trustBase,
    }));
  }

  /** Low-level classifyVersion. */
  async classify(v: PointerVersion): Promise<'VALID' | 'SEMANTICALLY_INVALID' | 'TRANSIENT_UNAVAILABLE'> {
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
  }
}
