/**
 * lib/time/backoff — exponential backoff with jitter and abort-signal support.
 *
 * Consolidates the ad-hoc backoff patterns used by v6RecoverPermSaveRetry,
 * swap-timers, polling-policy, etc.
 */

export interface BackoffOptions {
  /** Base delay in ms. Default 1000. */
  baseMs?: number;
  /** Max delay in ms. Default 60_000. */
  maxMs?: number;
  /** Growth factor per attempt. Default 2. */
  factor?: number;
  /** Jitter fraction (0–1). Default 0.2. */
  jitter?: number;
}

/**
 * Compute the sleep interval for `attempt` (1-based). Deterministic if
 * jitter=0; otherwise uniformly randomized within ±jitter*base.
 */
export function nextBackoffMs(attempt: number, opts: BackoffOptions = {}): number {
  const baseMs = opts.baseMs ?? 1000;
  const maxMs = opts.maxMs ?? 60_000;
  const factor = opts.factor ?? 2;
  const jitter = opts.jitter ?? 0.2;
  const raw = Math.min(baseMs * Math.pow(factor, Math.max(0, attempt - 1)), maxMs);
  if (jitter <= 0) return raw;
  const delta = raw * jitter * (2 * Math.random() - 1);
  return Math.max(0, Math.round(raw + delta));
}

/**
 * Sleep for `ms` unless `signal` aborts. Rejects with AbortError on abort.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
