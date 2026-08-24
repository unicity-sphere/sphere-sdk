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
export function coalesced(run: () => Promise<unknown>): () => void {
  let inFlight = false;
  let queued = false;
  const start = (): void => {
    inFlight = true;
    void run()
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
