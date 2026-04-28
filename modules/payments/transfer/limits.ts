/**
 * UXF Transfer — consolidated limits & comparators (T.1.D / W36).
 *
 * This module is the **single source of truth** for every protocol-level
 * limit referenced by the UXF inter-wallet transfer pipeline. Every
 * downstream module (sender, receiver, ingest worker pool, fetcher,
 * finalizer) imports its caps from here so future tuning is a one-file
 * change with mechanical greppability.
 *
 * **Side-effect freedom guarantee.** Importing this module MUST NOT
 * register handlers, open sockets, mutate global state, log to console,
 * read environment variables, or otherwise produce observable behavior.
 * It exports plain `const` values plus two pure functions
 * (`clampInlineCap`, `compareCidV1Binary`). Tests assert this invariant —
 * see `tests/unit/payments/transfer/limits.test.ts`.
 *
 * Spec references:
 * - §3.1   `bundleCid` is CIDv1 base32 (consumed by the comparator).
 * - §3.3.1 `MAX_INLINE_CAR_BYTES`, `RELAY_SAFE_CAP_BYTES`,
 *          `MAX_FETCHED_CAR_BYTES`, plus `clampInlineCap` semantics.
 * - §5.0   `INGEST_QUEUE_SIZE`, `INGEST_QUEUE_PER_TOKEN_CAP`.
 * - §5.1   `REPLAY_LRU_SIZE`.
 * - §5.2   `MAX_UNCLAIMED_ROOTS`, `MAX_CHAIN_DEPTH`.
 * - §5.3   `compareCidV1Binary` (lex-min tie-break — operates on the
 *          BINARY representation of the CID, NOT the base32 string).
 * - §6.1   `MAX_CONCURRENT_POLLS_PER_TOKEN`,
 *          `MAX_CONCURRENT_POLLS_PER_AGGREGATOR`.
 *
 * @packageDocumentation
 */

import { CID } from 'multiformats';

// =============================================================================
// 1. Numeric caps
// =============================================================================

/**
 * Default inline-CAR cap when `delivery: { kind: 'auto' }`. Below this, the
 * sender embeds the CAR bytes inside the Nostr event. Spec default: 16 KiB
 * (§3.3.1). Per-call overrides are clamped to {@link RELAY_SAFE_CAP_BYTES}.
 */
export const MAX_INLINE_CAR_BYTES = 16 * 1024;

/**
 * Hard ceiling for inline CAR delivery, regardless of caller override. The
 * SDK silently clamps `inlineCapBytes` to this value when the caller passes
 * a larger number — `auto` mode never publishes inline above the relay-safe
 * ceiling. (§3.3.1, normative.)
 */
export const RELAY_SAFE_CAP_BYTES = 96 * 1024;

/**
 * Maximum CAR size the recipient will fetch via `kind: 'uxf-cid'`. Streaming
 * fetches abort with `FETCHED_CAR_TOO_LARGE` once running byte-count crosses
 * this threshold. DoS defense against hostile pinned CIDs. (§3.3.1.)
 */
export const MAX_FETCHED_CAR_BYTES = 32 * 1024 * 1024;

/**
 * Per-bundle cap on the number of `token-root` (or future root-equivalent)
 * elements present in the pool but absent from `payload.tokenIds` (i.e.
 * "smuggled" roots). Beyond this, the bundle is rejected with
 * `BUNDLE_REJECTED:too-many-unclaimed-roots`. (§5.2 #4.)
 */
export const MAX_UNCLAIMED_ROOTS = 16;

/**
 * Per-token cap on unfinalized transactions in a chain. Claimed tokens
 * exceeding this depth reject the bundle entirely; smuggled roots exceeding
 * this depth are silently dropped. (§5.2 #3 two-tier rule.)
 */
export const MAX_CHAIN_DEPTH = 64;

/**
 * Bounded LRU of recently-processed `bundleCid` values. Re-processing the
 * same CID is idempotent (§5.1), so this LRU is purely an optimization.
 * Eviction is harmless.
 */
export const REPLAY_LRU_SIZE = 256;

/**
 * Per-token concurrent-poll cap for the finalization worker. Multiple
 * pending tokens of the SAME id (e.g., several outstanding `requestId`s
 * within one token's chain) cannot in aggregate consume more than this many
 * simultaneous aggregator polls. (§6.1 — DoS defense against deep chains.)
 */
export const MAX_CONCURRENT_POLLS_PER_TOKEN = 4;

/**
 * Per-aggregator concurrent-poll cap. The finalization worker shares this
 * budget across all pending tokens in flight. (§6.1.)
 */
export const MAX_CONCURRENT_POLLS_PER_AGGREGATOR = 16;

/**
 * Bounded ingest queue size for incoming bundle workers. Once full, new
 * arrivals are dropped with `INGEST_QUEUE_FULL`. (§5.0 back-pressure.)
 */
export const INGEST_QUEUE_SIZE = 256;

/**
 * Per-tokenId fairness cap inside the ingest queue. A single hot tokenId
 * (e.g., target of a bundle-flood attack) cannot fill more than this many
 * slots; further arrivals on the same id are rejected with
 * `INGEST_QUEUE_FULL_PER_TOKEN`. (§5.0 / round-2 W7.)
 */
export const INGEST_QUEUE_PER_TOKEN_CAP = 16;

// =============================================================================
// 2. clampInlineCap — §3.3.1 inline-cap normalization
// =============================================================================

/**
 * Discriminated reason returned by {@link clampInlineCap}.
 *
 * - `'ok'`             — the input was within `[1, RELAY_SAFE_CAP_BYTES]`.
 * - `'below-min'`      — input was `<= 0` or non-finite; clamped to `1`.
 * - `'above-relay-cap'`— input exceeded the relay-safe ceiling; clamped
 *                       down to `RELAY_SAFE_CAP_BYTES`.
 *
 * The reason is exposed for telemetry — operators want to know when their
 * users' overrides are being silently clamped (§3.3.1 normative behavior).
 */
export type ClampInlineCapReason = 'ok' | 'below-min' | 'above-relay-cap';

/**
 * Result of {@link clampInlineCap}. `clamped: true` indicates the SDK
 * adjusted the user's value; callers MAY emit a telemetry event when
 * `clamped` is true.
 */
export interface ClampInlineCapResult {
  /** Effective cap, in bytes. Always in `[1, RELAY_SAFE_CAP_BYTES]`. */
  readonly value: number;
  /** True iff the input was modified before being returned. */
  readonly clamped: boolean;
  /** Why we clamped (or didn't). See {@link ClampInlineCapReason}. */
  readonly reason: ClampInlineCapReason;
}

/**
 * Normalize a user-supplied `inlineCapBytes` override per §3.3.1.
 *
 * The protocol's behavior is **deterministic clamp**, NOT reject — passing
 * `inlineCapBytes: 1_000_000` does not error; the SDK silently caps the
 * effective value to {@link RELAY_SAFE_CAP_BYTES} (96 KiB) and surfaces the
 * decision via the `reason` field.
 *
 * Validation rules (in order):
 *  1. Non-finite input (`NaN`, `±Infinity`) → clamp to `1`,
 *     `reason: 'below-min'`.
 *  2. Input `<= 0` (zero, negative) → clamp to `1`, `reason: 'below-min'`.
 *  3. Input `> RELAY_SAFE_CAP_BYTES` → clamp down,
 *     `reason: 'above-relay-cap'`.
 *  4. Otherwise → pass through, `reason: 'ok'`.
 *
 * The function does NOT round non-integer inputs — the spec's cap is in
 * bytes and the SDK callers always pass integer values. We pass through
 * any in-range numeric. Callers needing integer semantics should
 * `Math.floor()` upstream.
 *
 * @param userValue The caller-supplied `inlineCapBytes` value.
 * @returns A {@link ClampInlineCapResult} carrying the clamped value, a
 *          flag, and the structured reason for telemetry.
 */
export function clampInlineCap(userValue: number): ClampInlineCapResult {
  if (!Number.isFinite(userValue) || userValue <= 0) {
    return { value: 1, clamped: true, reason: 'below-min' };
  }
  if (userValue > RELAY_SAFE_CAP_BYTES) {
    return {
      value: RELAY_SAFE_CAP_BYTES,
      clamped: true,
      reason: 'above-relay-cap',
    };
  }
  return { value: userValue, clamped: false, reason: 'ok' };
}

// =============================================================================
// 3. compareCidV1Binary — §5.3 [D-conflict] lex-min tie-break
// =============================================================================

/**
 * Lexicographic compare of two CIDv1 strings on their **binary**
 * representation, NOT on the base32-encoded string.
 *
 * **Why binary, not base32**: per §5.3 [D-conflict], when a divergent
 * (non-prefix) chain pair is detected, the tie-break selects the bundle
 * with the lex-min `bundleCid`. The protocol mandates the comparison
 * happen on the raw CIDv1 byte sequence: base32 alphabet ordering differs
 * from binary ordering at multiple byte positions, so the two orderings
 * are NOT equivalent. Implementations comparing base32 strings would
 * disagree with implementations comparing binary on the same input —
 * fatal for distributed convergence.
 *
 * This function is the canonical reference all other modules import for
 * tie-break ordering. T.3.D consumes it for manifest merge.
 *
 * **Throws**: `Error` if either input is not a parseable CID. The caller
 * is expected to validate inputs upstream (the bundle has already passed
 * `pkg.verify()` by the time this comparator runs); a parse failure
 * indicates programmer error, not adversarial input.
 *
 * @param a CIDv1 string (base32 multibase, prefix `b`).
 * @param b CIDv1 string (base32 multibase, prefix `b`).
 * @returns `-1` if `a < b` (binary), `0` if equal, `1` if `a > b`.
 */
export function compareCidV1Binary(a: string, b: string): -1 | 0 | 1 {
  // Parse both via multiformats; this is guaranteed-correct for any
  // CIDv1 in any multibase, so a well-formed CID-as-base32 input round-
  // trips through `.bytes` to its binary form.
  const aBytes = CID.parse(a).bytes;
  const bBytes = CID.parse(b).bytes;
  const len = Math.min(aBytes.length, bBytes.length);
  for (let i = 0; i < len; i++) {
    const ai = aBytes[i];
    const bi = bBytes[i];
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  // All shared-prefix bytes equal. The shorter array is "smaller".
  if (aBytes.length < bBytes.length) return -1;
  if (aBytes.length > bBytes.length) return 1;
  return 0;
}
