/**
 * Issue #310 — Profile-mode-only public API surface exposed on
 * `sphere.profile`.
 *
 * The handle is created by `Sphere` and bound to:
 *   - `ProfileStorageProvider` (for OrbitDB adapter + pointer-layer access)
 *   - the per-storage encryption context (so the snapshot built by
 *     the resets-publishCallback is encrypted with the wallet's
 *     own keys)
 *
 * When the wallet is not in Profile mode (e.g., legacy IndexedDB-only
 * storage), `Sphere.profile` returns `null`. Callers MUST null-check.
 *
 * Today's public surface:
 *
 *   - `resetEpoch({ reason })` — wipes the local OpLog, mints a new
 *     synthetic genesis carrying the in-memory snapshot, bumps the
 *     epoch by exactly +1, and publishes a new aggregator pointer
 *     so all clients refuse to walk back past the new floor.
 *
 *   - `getEpochFloor()` — read the wallet's currently-persisted
 *     epoch floor (the highest epoch ever observed on-chain OR
 *     produced via `resetEpoch`).
 *
 * @module profile/profile-handle
 */

import type { SphereEventMap, SphereEventType } from '../types/index.js';

/**
 * Result of `sphere.profile.resetEpoch()`.
 */
export interface ResetEpochResult {
  /**
   * The new epoch stamped into the freshly-minted OpLog snapshot.
   * Strictly `max(localFloor, discoveredFloor) + 1`, where
   * `discoveredFloor` is the highest epoch observed on-chain at
   * call time (PR #316 F1 fix). Persisted into the wallet's local
   * epoch-floor cache so subsequent walkback inspections refuse to
   * load any predecessor with `epoch < newEpoch`.
   */
  readonly newEpoch: number;
  /** The reason string supplied by the caller (truncated/validated). */
  readonly reason: string;
  /** Wall-clock timestamp of the reset (ms since epoch). */
  readonly ts: number;
  /**
   * PR #316 F2 fix — the aggregator-pointer version the post-reset
   * publish landed at. Populated when the publish completed within
   * the bounded `publishTimeoutMs` window (default 30 000 ms); `0`
   * otherwise.
   *
   * `publishedVersion === 0` is a SOFT signal, NOT a failure:
   * `'profile:epoch-reset-publish-pending'` is emitted with the same
   * `newEpoch`, and the periodic-poll / next dirty-flush will land
   * the publish on the wallet's behalf. Callers can also subscribe
   * to `'storage:pointer-published'` to observe the eventual landing.
   *
   * The wait is implemented as a one-shot listener on the storage
   * provider's `'storage:pointer-published'` event (which fires
   * UNCONDITIONALLY on every successful publish — see lifecycle-
   * manager). Set `publishTimeoutMs: 0` in {@link ResetEpochParams}
   * to skip the wait entirely.
   */
  readonly publishedVersion: number;
  /**
   * PR #316 F1 fix — `true` when the on-chain epoch floor was
   * consulted before bumping. `false` when the discovery RPC failed
   * (network / aggregator down): the bump was computed from the
   * local floor alone and is PROVISIONAL.
   *
   * A `false` result is rare — discovery uses the same RPC stack as
   * the publish path, so a `false` here is usually accompanied by a
   * `publishedVersion: 0` result (publish also failed). Callers in
   * sibling-device deployments SHOULD surface a warning when this is
   * `false`, since cross-device monotonicity was not verified at
   * mint time.
   */
  readonly discoveryConsulted: boolean;
}

/**
 * Parameters accepted by `sphere.profile.resetEpoch()`.
 */
export interface ResetEpochParams {
  /**
   * Operator triage reason captured into the post-reset snapshot's
   * `epochResetReason` field. Free-form ASCII; capped at
   * `EPOCH_RESET_REASON_MAX_BYTES`. REQUIRED — callers MUST supply
   * a reason to make the audit trail actionable.
   *
   * Examples:
   *   - `'oplog-corruption-recovery'`
   *   - `'user-initiated-from-settings'`
   *   - `'cidref-missing-block-bafyreih...'`
   */
  readonly reason: string;
  /**
   * PR #316 F1 fix — bounded timeout (ms) for the pre-bump
   * discovery RPC. Default: 15 000. On timeout, the bump proceeds
   * from the local floor alone and is PROVISIONAL (see
   * `discoveryConsulted` in {@link ResetEpochResult}). Set to
   * `0` to skip discovery entirely (test-only escape hatch — NOT
   * recommended in production because cross-device monotonicity
   * cannot then be enforced).
   */
  readonly discoveryTimeoutMs?: number;
  /**
   * PR #316 F2 fix — bounded timeout (ms) for the post-bump publish
   * await. Default: 30 000. On timeout,
   * `'profile:epoch-reset-publish-pending'` is emitted and
   * `publishedVersion: 0` is returned; the periodic-poll path will
   * republish in the background. Set to `0` to skip the await
   * entirely (caller does not need the version).
   */
  readonly publishTimeoutMs?: number;
}

/**
 * Issue #310 — Profile-mode-only API handle.
 *
 * Returned by `Sphere.profile` when (and only when) the wallet's
 * StorageProvider is a `ProfileStorageProvider`. Legacy / non-Profile
 * wallets see `null` and MUST surface a clear "this operation requires
 * Profile mode" message in the UI.
 */
export interface SphereProfileHandle {
  /**
   * Wipe the local OpLog and start a fresh one with a permanent
   * floor that all clients (this device AND any second device
   * replicating the same wallet) honor.
   *
   * Operation:
   *   1. (PR #316 F1 fix) **Consult the on-chain epoch floor.** Run a
   *      best-effort `pointer.discoverLatestVersion()` with a bounded
   *      timeout to capture `discoveredFloor = pickedEpoch` from
   *      Phase-3 walkback. On RPC failure the discovered floor is
   *      treated as 0 and `'profile:epoch-reset-discovery-skipped'`
   *      is emitted; the bump proceeds from the local floor alone
   *      and is PROVISIONAL.
   *   2. Compute `newEpoch = max(localFloor, discoveredFloor) + 1`.
   *   3. Snapshot in-memory state (identity, tokens, tracked
   *      addresses) into a transient buffer.
   *   4. Wipe the local OrbitDB OpLog via
   *      `OrbitDbAdapter.resetCorruptedLog`.
   *   5. Mint a fresh OpLog. Write the snapshot's KV entries back
   *      via the normal storage-provider write path (which lands
   *      them in the fresh OpLog).
   *   6. Persist the new epoch floor and trigger a dirty-flush so
   *      the next snapshot's root block carries `epoch = newEpoch`
   *      and the new aggregator-pointer version publishes.
   *   7. (PR #316 F2 fix) **Await the publish** via the
   *      `'storage:pointer-published'` event with a bounded timeout
   *      (default 30 000 ms; configurable via `publishTimeoutMs`).
   *      On observe, `publishedVersion` is set to the landed pointer
   *      version. On timeout,
   *      `'profile:epoch-reset-publish-pending'` is emitted and
   *      `publishedVersion === 0` is returned — the periodic poll
   *      will republish.
   *   8. Emit `profile:epoch-reset` on the Sphere event bus.
   *
   * Idempotency: calling `resetEpoch` a second time lands a NEW
   * +1 epoch — it does NOT skip. Each invocation is a distinct
   * user-affirmed reset.
   *
   * Crash-safety: every step persists durably before the next runs.
   * A crash between steps leaves the wallet in a state where the
   * next `Sphere.load()` either resumes from the half-reset (and
   * the next dirty-flush completes the publish) or — in the worst
   * case — re-runs the reset on operator request. Partial-reset
   * MUST NOT leave the wallet unloadable.
   *
   * Cross-device monotonicity (PR #316 F1 fix). Two devices A and B
   * sharing the same wallet identity that both call `resetEpoch`
   * concurrently SHOULD each observe the same `discoveredFloor`
   * (assuming the aggregator's read-replica lag is below
   * `discoveryTimeoutMs`). Each device bumps to
   * `max(local, discovered) + 1` — if A is already at epoch N and B
   * is at N, both bump to N+1. The first to land the publish wins;
   * the second hits `WALKBACK_FLOOR` on its next publish attempt
   * and re-discovers (now seeing the winner's N+1 on-chain), so its
   * NEXT bump goes to N+2. The convergence window is bounded by the
   * aggregator's read-replica lag. For DEVICES with disjoint
   * aggregator views (network partition), this fix cannot prevent
   * a temporary divergence — the cross-device walkback floor on the
   * pointer-pointer (see `epoch-floor.ts`) eventually catches up.
   *
   * Concurrent calls: a per-instance mutex serializes concurrent
   * `resetEpoch` invocations on the same `Sphere` so each call
   * lands its OWN +1 bump (consistent with the
   * idempotency-against-re-runs contract). The two calls are NOT
   * deduplicated.
   *
   * Concurrent SENDS: this method does NOT block sends from the
   * surrounding PaymentsModule. A send in-flight while the OpLog is
   * being wiped surfaces as a write error from the dispatcher's
   * retry path; the user-facing operation either fails or retries
   * automatically against the fresh OpLog. Callers SHOULD quiesce
   * the wallet (stop active sends, pause the swap module) before
   * invoking `resetEpoch` to keep the recovery deterministic; a UI
   * implementation should surface a confirmation dialog that gates
   * the call on a quiesced state. The SDK does not enforce this
   * because no general-purpose "stop all writes" primitive exists at
   * the Sphere level.
   *
   * @throws SphereError('NOT_PROFILE_MODE') if called when not in
   *         Profile mode (this should never happen — `Sphere.profile`
   *         returns `null` for non-Profile wallets, so the API is
   *         unreachable; the defensive throw guards against
   *         operator misuse via reflection).
   * @throws SphereError('PROFILE_RESET_FAILED', { cause }) if any
   *         step throws. The wallet is left in the half-reset state
   *         described above; the next `Sphere.load()` will resume.
   */
  resetEpoch(params: ResetEpochParams): Promise<ResetEpochResult>;

  /**
   * Read the wallet's currently-persisted epoch floor. Returns 0 for
   * a pre-#310 wallet that has never observed a higher epoch on-chain
   * AND has never invoked `resetEpoch`.
   */
  getEpochFloor(): Promise<number>;
}

/**
 * Event payload for `'profile:epoch-reset'` — fired AFTER the new
 * epoch is persisted locally and the publish has been kicked off
 * (the publish is best-effort; the event fires whether or not the
 * publish succeeded).
 */
export interface ProfileEpochResetEvent {
  /** The newly-minted epoch (= prior + 1). */
  readonly newEpoch: number;
  /** Operator triage reason captured from the caller. */
  readonly reason: string;
  /** Wall-clock timestamp of the reset (ms since epoch). */
  readonly ts: number;
}

// Re-exports for downstream wiring.
export type {
  SphereEventMap as _SphereEventMap,
  SphereEventType as _SphereEventType,
};
