/**
 * lib/time/interval — abortable periodic runner.
 *
 * Consolidates the scattered `setInterval` patterns for proof-polling,
 * resolve-unconfirmed, retention-verifier, etc. Each currently rolls its
 * own start/stop pair. This helper accepts an AbortSignal so shutdown is
 * uniform.
 */

export interface AbortableIntervalOptions {
  /** Interval period in ms. */
  ms: number;
  /** Run immediately on start rather than waiting the first period. */
  runImmediately?: boolean;
  /** Abort signal — when aborted, the interval is stopped. */
  signal?: AbortSignal;
  /** Called if the runner throws. Default: swallow (loop continues). */
  onError?: (err: unknown) => void;
}

/**
 * Start a periodic runner. Returns a stop() function; also stops when
 * `signal` aborts.
 */
export function runAbortableInterval(
  runner: () => Promise<void> | void,
  opts: AbortableIntervalOptions,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let stopped = false;

  const runOnce = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await runner();
    } catch (err) {
      if (opts.onError) opts.onError(err);
    } finally {
      running = false;
      if (!stopped) schedule();
    }
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void runOnce();
    }, opts.ms);
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  if (opts.signal) {
    if (opts.signal.aborted) {
      stop();
      return stop;
    }
    opts.signal.addEventListener('abort', stop, { once: true });
  }

  if (opts.runImmediately) {
    void runOnce();
  } else {
    schedule();
  }

  return stop;
}
