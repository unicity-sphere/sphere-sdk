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
   * Strictly `prev.epoch + 1`. Persisted into the wallet's local
   * epoch-floor cache so subsequent walkback inspections refuse to
   * load any predecessor with `epoch < newEpoch`.
   */
  readonly newEpoch: number;
  /** The reason string supplied by the caller (truncated/validated). */
  readonly reason: string;
  /** Wall-clock timestamp of the reset (ms since epoch). */
  readonly ts: number;
  /**
   * The aggregator-pointer version the publish landed at (or 0 if
   * the publish did not run / failed gracefully — the local reset
   * is still durable in that case; the publish will be retried on
   * the next dirty-flush cycle).
   */
  readonly publishedVersion: number;
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
   *   1. Snapshot in-memory state (identity, tokens, tracked
   *      addresses) into a transient buffer.
   *   2. Wipe the local OrbitDB OpLog via
   *      `OrbitDbAdapter.resetCorruptedLog`.
   *   3. Mint a fresh OpLog. Write the snapshot's KV entries back
   *      via the normal storage-provider write path (which lands
   *      them in the fresh OpLog).
   *   4. Bump the persisted epoch floor by exactly +1 and trigger
   *      a dirty-flush so the next snapshot's root block carries
   *      `epoch = newEpoch` and the new aggregator-pointer version
   *      publishes.
   *   5. Emit `profile:epoch-reset` on the Sphere event bus.
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
