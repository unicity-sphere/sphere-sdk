/**
 * Issue #310 — OpLog epoch-floor walkback primitive.
 *
 * The pointer chain that an aggregator hosts is a strictly-increasing
 * sequence of versions, each addressed by a snapshot CAR. Each CAR's
 * root block carries an `epoch` field (default 0 for pre-#310 wallets).
 * `sphere.profile.resetEpoch()` mints a NEW snapshot whose `epoch` is
 * `max(seen.epoch) + 1` and publishes it at the next pointer version.
 *
 * Once a higher epoch is observed on-chain, NO lower-epoch version is
 * considered VALID for walkback purposes — the wallet has explicitly
 * abandoned the prior OpLog state. Walking back into it would let a
 * crashing client (or a second-device read) re-load the corruption
 * that drove the user to reset in the first place.
 *
 * This module is pure (no I/O, no globals). The walkback algorithm
 * imports `pickEpochFloor` / `shouldSkipForEpochFloor` and consults
 * the running floor at every classify step.
 *
 * Backwards-compat invariant
 * ──────────────────────────
 * - Pre-#310 snapshots have NO epoch field; readers treat them as
 *   `epoch = 0`. A pre-#310 chain therefore has `max(seen.epoch) = 0`,
 *   and `shouldSkipForEpochFloor` returns `false` for every entry —
 *   walkback behavior is identical to pre-#310 SDKs.
 * - A post-#310 chain whose latest entry is `epoch = N > 0` causes
 *   `shouldSkipForEpochFloor` to return `true` for any prior entry
 *   whose `epoch < N`. Those prior entries are skipped past with the
 *   same Phase-3 semantics as CAR_TRANSIENT or SEMANTICALLY_INVALID —
 *   they count toward the walkback budget and are surfaced in a
 *   dedicated `walkbackEpochSkipped` list for operator observability.
 *
 * Forward-compat invariant
 * ────────────────────────
 * - A wallet running an OLDER SDK that doesn't recognize the `epoch`
 *   field reads pre-#310 semantics (every entry treated as
 *   `epoch = 0`) and may walk back into the abandoned state. This is
 *   acceptable for v1 — the user-facing API (`sphere.profile.
 *   resetEpoch`) is gated on the LATEST SDK. Issue #310 ships the
 *   reader floor; older SDKs upgrade naturally.
 */

/**
 * Normalize an entry's epoch claim into a strict non-negative integer.
 * Returns 0 for `undefined` (the "field absent" signal — pre-#310 /
 * backwards-compat). Throws on any explicit non-integer / negative
 * value: a caller passing a malformed claim is a programmer bug, not
 * a recoverable input.
 */
export function normalizeEpoch(claimed: number | undefined): number {
  if (claimed === undefined) return 0;
  if (
    typeof claimed !== 'number' ||
    !Number.isFinite(claimed) ||
    !Number.isInteger(claimed) ||
    claimed < 0
  ) {
    throw new TypeError(
      `epoch-floor: claimed epoch must be a non-negative integer or undefined; got ${String(claimed)}`,
    );
  }
  return claimed;
}

/**
 * Compute the running epoch floor given the prior floor and a newly
 * observed entry's claimed epoch. Monotone-nondecreasing.
 *
 * Example walkback (top-down, Phase-3 order):
 *
 *   v=10 → epoch=2  → floor = max(0, 2) = 2
 *   v=9  → epoch=2  → floor = max(2, 2) = 2  (no change)
 *   v=8  → epoch=1  → floor = max(2, 1) = 2  → SKIPPED (1 < 2)
 *   v=7  → epoch=2  → floor = max(2, 2) = 2  (VALID — passes)
 *
 * The function is intentionally symmetric: it accepts both the
 * "running floor" and the "candidate's claim" and returns the
 * post-observation floor. Callers can therefore pre-prime the floor
 * with a locally-known value (e.g., from the wallet's last persisted
 * snapshot's epoch) before consulting on-chain entries.
 */
export function pickEpochFloor(
  priorFloor: number,
  candidateEpoch: number | undefined,
): number {
  const normalized = normalizeEpoch(candidateEpoch);
  const normalizedFloor = normalizeEpoch(priorFloor);
  return normalized > normalizedFloor ? normalized : normalizedFloor;
}

/**
 * Decide whether a walkback candidate should be SKIPPED PAST because
 * its epoch is strictly below the running floor. The floor is the
 * `max(epoch)` observed so far in the chain (including this
 * candidate's own neighbors — `pickEpochFloor` must be called first
 * for higher-epoch siblings encountered earlier in the walkback).
 *
 * Returns `true` iff the candidate is below the floor — the caller
 * walks back one more, exactly as it does for SEMANTICALLY_INVALID
 * / CAR_TRANSIENT. Returns `false` for `candidate.epoch >= floor` —
 * the candidate is at-or-above the floor and walkback proceeds with
 * the candidate's normal classification (VALID / CAR_TRANSIENT /
 * SEMANTICALLY_INVALID).
 *
 * Steelman: backwards-compat strictness. A pre-#310 entry whose
 * snapshot has no `epoch` field decodes as `epoch=0`. A post-#310
 * chain with `floor=1` would mark that pre-#310 entry as SKIPPED.
 * This is intentional: once a wallet has published its FIRST
 * post-reset pointer (epoch ≥ 1), the user has affirmatively
 * abandoned the pre-reset chain. Including a pre-#310 ancestor in
 * walkback would re-load the abandoned state.
 *
 * The asymmetry only fires AFTER the user calls `resetEpoch` at
 * least once. Until then, every entry's epoch is 0, the floor is 0,
 * and `candidate.epoch >= 0` for every entry — no skips.
 */
export function shouldSkipForEpochFloor(
  floor: number,
  candidateEpoch: number | undefined,
): boolean {
  const normalized = normalizeEpoch(candidateEpoch);
  const normalizedFloor = normalizeEpoch(floor);
  return normalized < normalizedFloor;
}

/**
 * Compose a list of seen epochs into the final floor. Useful for
 * stub callers / unit tests that have all observations in hand at once.
 */
export function computeEpochFloor(
  seen: ReadonlyArray<number | undefined>,
): number {
  let floor = 0;
  for (const e of seen) {
    floor = pickEpochFloor(floor, e);
  }
  return floor;
}
