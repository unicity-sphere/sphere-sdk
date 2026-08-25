// Shared concurrency primitives. Both advance on SETTLED, never fulfilled —
// a rejection never bricks the next run (async.test.ts pins the recovery).

export class SingleFlight<T> {
  private flight: Promise<T> | null = null;

  run(fn: () => Promise<T>): Promise<T> {
    if (this.flight !== null) return this.flight;
    const current = fn().finally(() => {
      this.flight = null;
    });
    this.flight = current;
    return current;
  }
}

export class SerialChain {
  private tail: Promise<unknown> = Promise.resolve();

  /** FIFO; starts after every prior fn settled; returns this fn's own outcome. */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

/** Fire-and-forget sibling of {@link SingleFlight}: one in flight, one queued behind it. */
export function coalesced(
  run: () => Promise<unknown>,
  observe?: (op: Promise<unknown>) => void
): () => void {
  let inFlight = false;
  let queued = false;
  const start = (): void => {
    inFlight = true;
    // A synchronous throw would escape before .catch attaches and strand
    // inFlight, wedging every later trigger. Started eagerly, not on a
    // microtask, so a caller can rely on the first run having begun.
    let running: Promise<unknown>;
    try {
      running = run();
    } catch {
      running = Promise.resolve();
    }
    observe?.(running);
    void running
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        if (!queued) return;
        queued = false;
        start();
      });
  };
  return () => {
    if (inFlight) {
      queued = true;
      return;
    }
    start();
  };
}
