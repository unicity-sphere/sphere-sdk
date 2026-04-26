/**
 * BLOCKED state persistence (T-B5, SPEC §10.2).
 *
 * The BLOCKED flag is wallet-wide (same signingPubKey across all HD addresses).
 * It persists across process restarts via the FlagStore.
 *
 * Categorical SET conditions (§10.2.2):
 *   - RETRY_EXHAUSTED after PUBLISH_RETRY_BUDGET attempts
 *   - Categorical network errors: timeout, DNS failure, TLS failure
 *   - AGGREGATOR_REJECTED (4xx permanent aggregator rejection)
 *   - PROTOCOL_ERROR (unrecognized aggregator response)
 *
 * CLEAR conditions (§10.2.4 — strict, operator-initiated only):
 *   - Explicit `clearBlocked()` call (gated on allowOperatorOverrides)
 *
 * SPEC §10.2.1–§10.2.5.
 */

import { AggregatorPointerError, AggregatorPointerErrorCode } from './errors.js';
import type { FlagStore } from './flag-store.js';
import type { BlockedState } from './types.js';

const BLOCKED_KEY = 'blocked';

// ── Categorical error classifier (§10.2.2) ─────────────────────────────────

export type BlockedReason =
  | 'retry_exhausted'
  | 'network_timeout'
  | 'dns_failure'
  | 'tls_failure'
  | 'aggregator_rejected'
  | 'protocol_error'
  | 'marker_corrupt'
  | 'rejected'
  /**
   * Steelman²⁰: synthetic read-side reason emitted by
   * ProfilePointerLayer.getBlockedState() / .isPublishBlocked() when the
   * stored blocked-state record is corrupt. NEVER persisted: it is
   * deliberately excluded from KNOWN_BLOCKED_REASONS so a stored record
   * with `reason: 'corrupt'` is still rejected as CORRUPT.
   * UI / telemetry consumers should add a 'corrupt' branch to their
   * reason switches.
   */
  | 'corrupt';

/**
 * Wave F.2 security advisory MEDIUM-3 remediation: typed network-error
 * category attached to error.details. Throw sites that produce
 * NETWORK_ERROR can SET this field directly with the canonical category;
 * the classifier uses it preferentially over substring matching of
 * error messages. Substring matching is preserved as a fallback for
 * raw Node.js errors and pre-existing throws that don't yet annotate.
 */
export type NetworkErrorCategory = 'network_timeout' | 'dns_failure' | 'tls_failure';

/**
 * Classify an error into a BlockedReason, or null if the error does not
 * trigger the BLOCKED state.
 *
 * The classifier is deliberately conservative — unknown errors are NOT
 * automatically blocking (fail-open for transient errors; fail-closed for
 * known permanent failures).
 */
export function classifyBlockedReason(err: unknown): BlockedReason | null {
  if (err instanceof AggregatorPointerError) {
    switch (err.code) {
      case AggregatorPointerErrorCode.RETRY_EXHAUSTED:
        return 'retry_exhausted';
      case AggregatorPointerErrorCode.AGGREGATOR_REJECTED:
        return 'aggregator_rejected';
      case AggregatorPointerErrorCode.PROTOCOL_ERROR:
        return 'protocol_error';
      case AggregatorPointerErrorCode.MARKER_CORRUPT:
        return 'marker_corrupt';
      case AggregatorPointerErrorCode.REJECTED:
        // H8 v-burning: the aggregator permanently rejected a commit.
        // Operator MUST investigate (possible key material corruption,
        // signing-service bug, or aggregator reconfiguration).
        return 'rejected';
      case AggregatorPointerErrorCode.NETWORK_ERROR: {
        // Wave F.2 MEDIUM-3: prefer the structured `category` field
        // when the throw site annotated the error. Falls back to
        // substring heuristics otherwise.
        const cat = (err.details as { category?: unknown } | undefined)?.category;
        if (cat === 'network_timeout' || cat === 'dns_failure' || cat === 'tls_failure') {
          return cat;
        }
        const msg = err.message.toLowerCase();
        if (msg.includes('timeout') || msg.includes('timed out')) return 'network_timeout';
        if (msg.includes('dns') || msg.includes('enotfound') || msg.includes('getaddrinfo'))
          return 'dns_failure';
        if (msg.includes('tls') || msg.includes('ssl') || msg.includes('cert'))
          return 'tls_failure';
        return null; // transient network error — do not block
      }
      default:
        return null;
    }
  }

  // Classify raw Node.js errors (e.g. from fetch/WebSocket).
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    const code = (err as NodeJS.ErrnoException).code?.toLowerCase() ?? '';
    if (code === 'econnreset' || code === 'econnrefused') return null; // transient
    if (msg.includes('timeout') || code === 'etimedout') return 'network_timeout';
    if (msg.includes('getaddrinfo') || msg.includes('enotfound') || code === 'enotfound')
      return 'dns_failure';
    if (msg.includes('tls') || msg.includes('ssl') || msg.includes('cert'))
      return 'tls_failure';
  }

  return null;
}

// ── Persistence ─────────────────────────────────────────────────────────────

interface BlockedRecord {
  blocked: true;
  reason: BlockedReason;
  setAt: number;
}

// Steelman²⁰: 'corrupt' is intentionally NOT in KNOWN_BLOCKED_REASONS.
// It is a SYNTHETIC reason emitted ONLY by the read-side wrapper in
// ProfilePointerLayer when the stored record fails validation. A stored
// record with `reason: 'corrupt'` is still rejected by isBlocked() as
// CORRUPT (the wrapper then synthesizes a stable read-side response).
const KNOWN_BLOCKED_REASONS = new Set<string>([
  'retry_exhausted',
  'network_timeout',
  'dns_failure',
  'tls_failure',
  'aggregator_rejected',
  'protocol_error',
  'marker_corrupt',
  'rejected',
]);

/**
 * Read the current BLOCKED state.  Returns `{ blocked: false }` if no flag
 * is present (normal — wallet never blocked).
 *
 * Fail-closed for integrity violations: if the stored record is present but
 * malformed, throws AGGREGATOR_POINTER_CORRUPT rather than silently returning
 * unblocked.  A corrupt record must be investigated — it could indicate
 * storage tampering or a migration bug.
 */
export async function isBlocked(store: FlagStore): Promise<BlockedState> {
  const raw = await store.get(BLOCKED_KEY);
  if (raw === null) return { blocked: false };

  let rec: unknown;
  try {
    rec = JSON.parse(raw);
  } catch {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.CORRUPT,
      'BLOCKED flag storage contains invalid JSON — possible corruption or tampering (SPEC §10.2).',
      { raw: raw.slice(0, 200) },
    );
  }

  const r = rec as Partial<BlockedRecord>;
  if (r.blocked !== true || typeof r.reason !== 'string' || typeof r.setAt !== 'number') {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.CORRUPT,
      'BLOCKED flag storage record failed shape check — possible corruption (SPEC §10.2).',
      { record: rec },
    );
  }

  if (!KNOWN_BLOCKED_REASONS.has(r.reason)) {
    // Steelman¹⁸: forward-compat unknown-reason is exploitable — anyone with
    // storage write access can persist { blocked:true, reason:"anything" } and
    // brick the wallet permanently (clearBlocked is gated on operator overrides).
    // Treat unrecognized reasons as CORRUPT: the record may be from a newer
    // spec version, but it may also be attacker-injected.  Failing closed here
    // surfaces the anomaly so operators can investigate rather than silently
    // accepting a permanent block with an unknown cause.
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.CORRUPT,
      `BLOCKED flag storage contains unrecognized reason "${r.reason}" — ` +
        'possible storage tampering or a newer spec version. ' +
        'Remove the BLOCKED flag manually or upgrade the SDK.',
      { record: rec },
    );
  }

  return { blocked: true, reason: r.reason as BlockedReason, setAt: r.setAt };
}

/**
 * Set the BLOCKED flag.
 *
 * Idempotent: a second call does NOT overwrite the original `setAt` timestamp
 * (preserves the earliest block event for diagnostics).
 */
export async function setBlocked(store: FlagStore, reason: BlockedReason): Promise<void> {
  // Steelman²¹/²² warning: any reason NOT in KNOWN_BLOCKED_REASONS would
  // cause isBlocked() to throw CORRUPT on the next read — bricking the
  // wallet from a coding error. The previous exact-string 'corrupt'
  // guard missed case-variants ('Corrupt', 'CORRUPT'), reachable via TS
  // `as` casts. Now reject ANYTHING the read-side wouldn't recognize,
  // which is the actual contract: persisted reasons must round-trip.
  if (!KNOWN_BLOCKED_REASONS.has(reason as string)) {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.PROTOCOL_ERROR,
      `BlockedReason "${String(reason)}" is not a recognized persistable reason. ` +
        `Allowed: ${[...KNOWN_BLOCKED_REASONS].join(', ')}. ` +
        "(The synthetic 'corrupt' reason is read-side only and must not be persisted.)",
    );
  }
  // Idempotency check: if a valid BLOCKED record exists, preserve it.
  // If the record is corrupt, overwrite it — registering the block is more
  // important than preserving a broken flag (fail-forward on corruption).
  let existing: BlockedState;
  try {
    existing = await isBlocked(store);
  } catch (err) {
    if (err instanceof AggregatorPointerError && err.code === AggregatorPointerErrorCode.CORRUPT) {
      existing = { blocked: false };
    } else {
      throw err;
    }
  }
  if (existing.blocked) return; // idempotent — keep original setAt

  const rec: BlockedRecord = { blocked: true, reason, setAt: Date.now() };
  await store.set(BLOCKED_KEY, JSON.stringify(rec));
}

/**
 * Clear the BLOCKED flag.
 *
 * Per SPEC §10.2.4 this is an operator-initiated action — callers MUST gate
 * this on `allowOperatorOverrides`.  The flag-store layer does NOT enforce
 * the capability check; enforcement is the caller's responsibility.
 */
export async function clearBlocked(store: FlagStore): Promise<void> {
  await store.remove(BLOCKED_KEY);
}

/**
 * Steelman⁴⁶ MEDIUM: forward-compat probe.
 *
 * Returns `true` iff the persisted BLOCKED record exists, is well-formed
 * in shape (blocked === true, string reason, number setAt), but the
 * `reason` field is not in `KNOWN_BLOCKED_REASONS`. This is the canonical
 * "downgrade footgun" shape: a newer SDK wrote a reason this build
 * doesn't recognize, and the user has rolled back. `isBlocked()` throws
 * CORRUPT in that case — without this probe, the only way to clear it
 * would be `allowOperatorOverrides=true`, which most production wallets
 * disable.
 *
 * Returns `false` if no record exists, the record JSON is malformed, the
 * shape is wrong, or the reason IS recognized. The caller should still
 * require operator override in those cases.
 *
 * Read-only — does not mutate any state.
 */
export async function hasUnrecognizedBlockedReason(store: FlagStore): Promise<boolean> {
  let raw: string | null;
  try {
    raw = await store.get(BLOCKED_KEY);
  } catch {
    // Steelman⁴⁶: on read failure, return false so the caller's
    // existing operator-override gate runs as before — this probe is
    // a forward-compat affordance, not a security boundary, so a
    // failure here MUST NOT relax authorization.
    return false;
  }
  if (raw === null) return false;
  let rec: unknown;
  try {
    rec = JSON.parse(raw);
  } catch {
    return false; // malformed JSON: caller's CORRUPT path is correct
  }
  const r = rec as Partial<BlockedRecord>;
  if (r.blocked !== true || typeof r.reason !== 'string' || typeof r.setAt !== 'number') {
    return false; // shape-malformed: caller's CORRUPT path is correct
  }
  return !KNOWN_BLOCKED_REASONS.has(r.reason);
}

/**
 * Set BLOCKED from an arbitrary error, using the categorical classifier.
 * Silently skips if the error does not map to a BLOCKED condition.
 *
 * Returns the reason used, or null if no BLOCKED was set.
 */
export async function maybeSetBlocked(
  store: FlagStore,
  err: unknown,
): Promise<BlockedReason | null> {
  const reason = classifyBlockedReason(err);
  if (reason === null) return null;
  await setBlocked(store, reason);
  return reason;
}
