/**
 * Retry + Circuit Breaker for the Market API.
 *
 * Why this exists:
 * The Market API sits behind a load balancer that occasionally returns
 * transient errors (HTTP 502/503/504/408) or drops connections during
 * deploys. Without tolerance, a single 502 from the testnet Market API
 * kills an in-progress test or trader operation even when the rest of
 * the protocol is working fine.
 *
 * Policy:
 *  - Retry on:    HTTP 502, 503, 504, 408 and network/abort errors.
 *  - Don't retry: 400, 401, 403, 404, 422 — anything 4xx that isn't 408
 *                 indicates a caller bug, not an outage.
 *  - Backoff:     exponential with full jitter, schedule 200/500/1000/2000/4000 ms,
 *                 capped at 5 attempts and a 10s total budget.
 *  - Breaker:     after N consecutive failures across operations, fail fast
 *                 for `cooldownMs` before allowing the next attempt.
 */

import { SphereError } from '../../core/errors';
import { logger } from '../../core/logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RetryConfig {
  /** Maximum number of attempts (including the first). Default: 5. */
  maxAttempts?: number;
  /** Per-attempt delays in ms. Length should equal maxAttempts - 1. */
  delaysMs?: number[];
  /** Maximum total time spent retrying before giving up. Default: 10_000. */
  totalBudgetMs?: number;
  /** Failures across operations needed to open the breaker. Default: 5. */
  breakerThreshold?: number;
  /** How long the breaker stays open after tripping. Default: 30_000. */
  breakerCooldownMs?: number;
  /** Inject for tests: override the wall-clock used for backoff/breaker. */
  now?: () => number;
  /** Inject for tests: override the sleep implementation. */
  sleep?: (ms: number) => Promise<void>;
  /** Inject for tests: override jitter (0..1). Default: Math.random. */
  random?: () => number;
}

/**
 * Marker error used internally to signal "this status looked transient".
 * The retry layer catches it and re-issues the request; if all attempts are
 * exhausted, the original {@link SphereError} produced by the request body
 * is re-thrown so callers see the same shape they saw before this was added.
 */
export class TransientMarketError extends Error {
  /** Optional HTTP status, when the trigger was an HTTP response. */
  readonly status?: number;
  /** Underlying SphereError that should surface if retries are exhausted. */
  readonly final: SphereError;

  constructor(final: SphereError, status?: number) {
    super(final.message);
    this.name = 'TransientMarketError';
    this.status = status;
    this.final = final;
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** HTTP statuses that should be retried. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 502, 503, 504]);

/** Returns true if `status` is a retryable transient HTTP status. */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

/**
 * Returns true if `err` looks like a transient network failure
 * (timeout, connection reset, abort, generic fetch failure).
 *
 * We can't enumerate every shape the platform throws, so we look at
 * the common signals:
 *   - DOMException with name 'AbortError' or 'TimeoutError' (AbortSignal.timeout)
 *   - Error.name === 'AbortError' / 'TimeoutError' (older runtimes)
 *   - Node-style code: ECONNRESET / ETIMEDOUT / ENOTFOUND / EAI_AGAIN /
 *     ECONNREFUSED / EPIPE / UND_ERR_SOCKET
 *   - The vague but very real "TypeError: fetch failed" (undici / browsers)
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;

  const name = (err as { name?: unknown }).name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;

  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'ECONNREFUSED' ||
      code === 'ENOTFOUND' ||
      code === 'EAI_AGAIN' ||
      code === 'EPIPE' ||
      code === 'UND_ERR_SOCKET' ||
      code === 'UND_ERR_CONNECT_TIMEOUT' ||
      code === 'UND_ERR_HEADERS_TIMEOUT' ||
      code === 'UND_ERR_BODY_TIMEOUT'
    ) {
      return true;
    }
  }

  // The browser/undici TypeError("fetch failed") case — common in Node 20+
  // when the upstream resets mid-request.
  if (err instanceof TypeError) {
    const msg = err.message.toLowerCase();
    if (msg.includes('fetch failed') || msg.includes('network') || msg.includes('socket')) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Backoff schedule
// ---------------------------------------------------------------------------

/** Default per-attempt base delays in ms. Total ≤ 7.7s leaves slack under 10s budget. */
export const DEFAULT_DELAYS_MS: readonly number[] = [200, 500, 1000, 2000, 4000];
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_TOTAL_BUDGET_MS = 10_000;
export const DEFAULT_BREAKER_THRESHOLD = 5;
export const DEFAULT_BREAKER_COOLDOWN_MS = 30_000;

/**
 * Compute the delay before attempt `attemptIndex` (0-based among _retries_,
 * so 0 means "delay before the first retry, i.e. between attempt 1 and 2").
 *
 * Uses full jitter: `random(0, base)`. This avoids thundering herd while
 * still tightening the average wait.
 */
export function backoffDelay(
  attemptIndex: number,
  delaysMs: readonly number[],
  random: () => number,
): number {
  const idx = Math.min(attemptIndex, delaysMs.length - 1);
  const base = delaysMs[idx] ?? 0;
  // Full jitter: a random number in [0, base].
  return Math.floor(random() * base);
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

type BreakerState = 'closed' | 'open' | 'half-open';

/**
 * Lightweight in-process circuit breaker.
 *
 * Closed → requests flow through and we count consecutive failures.
 * Once the threshold is hit we open the breaker and start a cooldown.
 * Open → all calls fail fast with a SphereError (`NETWORK_ERROR`).
 * After cooldown the next call goes through in `half-open`; if it succeeds
 * we close the breaker; if it fails we re-open with a fresh cooldown.
 */
export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(opts?: { threshold?: number; cooldownMs?: number; now?: () => number }) {
    this.threshold = opts?.threshold ?? DEFAULT_BREAKER_THRESHOLD;
    this.cooldownMs = opts?.cooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS;
    this.now = opts?.now ?? Date.now;
  }

  /** Throws SphereError('NETWORK_ERROR') when the breaker is open. */
  assertCanProceed(): void {
    if (this.state === 'open') {
      const elapsed = this.now() - this.openedAt;
      if (elapsed < this.cooldownMs) {
        throw new SphereError(
          `Market API circuit breaker open — backing off ${Math.max(0, this.cooldownMs - elapsed)}ms before retrying`,
          'NETWORK_ERROR',
        );
      }
      // Cooldown elapsed → allow a single trial request.
      this.state = 'half-open';
    }
  }

  /** Record a successful operation; closes a half-open breaker. */
  recordSuccess(): void {
    if (this.state === 'half-open') {
      logger.warn('Market', 'market_circuit_closed — Market API recovered, resuming normal operation');
    }
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.openedAt = 0;
  }

  /** Record a transient failure; may open the breaker. */
  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.state === 'half-open' || this.consecutiveFailures >= this.threshold) {
      if (this.state !== 'open') {
        logger.warn(
          'Market',
          `market_circuit_open — ${this.consecutiveFailures} consecutive transient failures; failing fast for ${this.cooldownMs}ms`,
        );
      }
      this.state = 'open';
      this.openedAt = this.now();
    }
  }

  /** Inspect (for tests + logging). */
  getState(): BreakerState {
    return this.state;
  }

  /** Inspect (for tests). */
  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }
}

// ---------------------------------------------------------------------------
// runWithRetry
// ---------------------------------------------------------------------------

/**
 * Run `op`, retrying on TransientMarketError up to the configured budget.
 * Permanent errors propagate immediately without consuming retries.
 *
 * The breaker is recorded at the boundary:
 *   - `recordSuccess()` once `op` returns,
 *   - `recordFailure()` once we give up retrying (NOT per attempt — we count
 *     "failed operations", not "failed HTTP roundtrips", so a flapping API
 *     that eventually answers doesn't trip the breaker).
 */
export async function runWithRetry<T>(
  op: () => Promise<T>,
  breaker: CircuitBreaker,
  config: RetryConfig = {},
): Promise<T> {
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const delaysMs = config.delaysMs ?? DEFAULT_DELAYS_MS;
  const totalBudgetMs = config.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
  const now = config.now ?? Date.now;
  const sleep =
    config.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = config.random ?? Math.random;

  breaker.assertCanProceed();

  const startedAt = now();
  let lastTransient: TransientMarketError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await op();
      breaker.recordSuccess();
      return result;
    } catch (err) {
      if (err instanceof TransientMarketError) {
        lastTransient = err;
        // Out of attempts?
        if (attempt >= maxAttempts) break;
        // Out of time budget?
        const nextDelay = backoffDelay(attempt - 1, delaysMs, random);
        const elapsed = now() - startedAt;
        if (elapsed + nextDelay >= totalBudgetMs) break;

        logger.debug(
          'Market',
          `Transient Market API failure (attempt ${attempt}/${maxAttempts}) — retrying in ${nextDelay}ms`,
          { status: err.status, message: err.message },
        );
        await sleep(nextDelay);
        continue;
      }
      // Non-transient — propagate immediately, no breaker bookkeeping.
      throw err;
    }
  }

  // Exhausted retries → record failure + surface the original error.
  breaker.recordFailure();
  // Defensive: lastTransient should always be set when we hit this branch, but
  // narrow the type for TS strict mode.
  if (!lastTransient) {
    throw new SphereError('Market API retry loop exited without a recorded error', 'NETWORK_ERROR');
  }
  throw lastTransient.final;
}
