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

// ── Class ──────────────────────────────────────────────────────────────────

export class ProfilePointerLayer {
  readonly #init: ProfilePointerLayerInit;
  readonly #config: PointerLayerConfig;
  #lastProbeVersions: readonly PointerVersion[] = [];

  constructor(init: ProfilePointerLayerInit) {
    this.#init = init;
    // Steelman remediation: clone + freeze so post-construction mutation
    // of `init.config.allowOperatorOverrides = true` does not bypass the
    // production guard below. Previously the constructor stored the
    // caller's reference directly, letting operator-override APIs
    // (clearBlocked / acceptCarLoss / clearPendingMarker /
    // acceptCorruptStreak) be enabled at runtime in production builds.
    const suppliedConfig: PointerLayerConfig = init.config ?? {};
    this.#config = Object.freeze({ ...suppliedConfig });
    // T-E26 production guard runs at init.
    assertConfigCapabilities(this.#config);
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
   */
  async publish(cidProducer: () => Promise<Uint8Array>): Promise<PublishResult> {
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
    });
    this.#lastProbeVersions = result.probeHistory;
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
  async recoverLatest(): Promise<RecoverResult | null> {
    const discovery = await this.discoverLatestVersion();
    if (discovery.validV === 0) return null;
    const cid = await this.#init.resolveRemoteCid(discovery.validV);
    return { cid, version: discovery.validV };
  }

  // ── discoverLatestVersion ────────────────────────────────────────────────

  /**
   * Run only the discovery phase (no CAR fetch, no XOR-decode, no CID parse —
   * BUT Phase 3 still calls classifyVersion which DOES fetch CAR for
   * validation per SPEC §8.2 step 3). Returns { validV, includedV } per H4.
   */
  async discoverLatestVersion(walkbackLimit?: number): Promise<DiscoverResult> {
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
    return isReachable({
      signingPubKey: this.#init.signer.signingPubKey,
      aggregatorClient: this.#init.aggregatorClient,
    });
  }

  // ── isPublishBlocked ─────────────────────────────────────────────────────

  /**
   * Query the persistent BLOCKED state (§10.2). Returns true iff
   * BLOCKED_FLAG_KEY is set.
   */
  async isPublishBlocked(): Promise<boolean> {
    const state = await readBlockedState(this.#init.flagStore);
    return state.blocked;
  }

  /** Returns the full BlockedState including reason and setAt timestamp. */
  async getBlockedState(): Promise<BlockedState> {
    return readBlockedState(this.#init.flagStore);
  }

  // ── clearBlocked ─────────────────────────────────────────────────────────

  /**
   * Clear BLOCKED after a legitimate §10.2.4 exit condition is met.
   * Gated on allowOperatorOverrides — the spec's strict CLEAR paths
   * (exclusion-proof or successful recovery) are typically detected and
   * cleared automatically by recoverLatest; this method is for operator-
   * initiated recovery when automatic detection is insufficient.
   *
   * @throws AggregatorPointerError(CAPABILITY_DENIED) if overrides disabled.
   */
  async clearBlocked(): Promise<void> {
    assertOperatorOverridesAllowed(this.#config, 'clearBlocked');
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
    assertOperatorOverridesAllowed(this.#config, 'clearPendingMarker');
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
    assertOperatorOverridesAllowed(this.#config, 'acceptCarLoss');
    // Step 1: H7 wall-clock gate.
    await assertAcceptCarLossEligible(this.#init.flagStore, version);
    // Step 2: MANDATORY republish BEFORE advance (H7 step 4).
    const result = await this.publish(cidProducer);
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
    await recordAttempt(this.#init.flagStore, version, gateway);
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
    return computeProbeFingerprint(this.#lastProbeVersions);
  }

  // ── Probe helper (for external use / testing) ───────────────────────────

  /** Low-level probe for a single version — H2 OR-predicate. */
  async probe(v: PointerVersion): Promise<boolean> {
    return probeVersion({
      v,
      keyMaterial: this.#init.keyMaterial,
      signer: this.#init.signer,
      aggregatorClient: this.#init.aggregatorClient,
      trustBase: this.#init.trustBase,
    });
  }

  /** Low-level classifyVersion. */
  async classify(v: PointerVersion): Promise<'VALID' | 'SEMANTICALLY_INVALID' | 'TRANSIENT_UNAVAILABLE'> {
    return classifyVersion({
      v,
      keyMaterial: this.#init.keyMaterial,
      signer: this.#init.signer,
      aggregatorClient: this.#init.aggregatorClient,
      trustBase: this.#init.trustBase,
      decodeCid: this.#init.decodeCid,
      fetchCar: this.#init.fetchCar,
    });
  }
}
