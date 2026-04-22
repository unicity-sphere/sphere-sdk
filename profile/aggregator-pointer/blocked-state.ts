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
  | 'protocol_error';

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
      case AggregatorPointerErrorCode.NETWORK_ERROR: {
        // Sub-classify by error message heuristics (§10.2.2 categorical).
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

/**
 * Read the current BLOCKED state.  Returns `{ blocked: false }` if no flag
 * is present or if the stored record is unparseable (fail-open for reads).
 */
export async function isBlocked(store: FlagStore): Promise<BlockedState> {
  const raw = await store.get(BLOCKED_KEY);
  if (raw === null) return { blocked: false };

  try {
    const rec = JSON.parse(raw) as Partial<BlockedRecord>;
    if (rec.blocked === true && typeof rec.reason === 'string' && typeof rec.setAt === 'number') {
      return { blocked: true, reason: rec.reason, setAt: rec.setAt };
    }
  } catch {
    // Corrupt stored record — treat as unblocked (fail-open for reads).
  }

  return { blocked: false };
}

/**
 * Set the BLOCKED flag.
 *
 * Idempotent: a second call does NOT overwrite the original `setAt` timestamp
 * (preserves the earliest block event for diagnostics).
 */
export async function setBlocked(store: FlagStore, reason: BlockedReason): Promise<void> {
  const existing = await isBlocked(store);
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
