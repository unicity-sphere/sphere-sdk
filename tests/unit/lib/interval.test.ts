import { describe, it, expect, vi } from 'vitest';
import { runAbortableInterval } from '../../../lib/time/interval';

describe('lib/time/interval', () => {
  it('runs the runner repeatedly at the interval period', async () => {
    const runs: number[] = [];
    const stop = runAbortableInterval(
      async () => {
        runs.push(Date.now());
      },
      { ms: 10, runImmediately: true },
    );
    await new Promise(r => setTimeout(r, 55));
    stop();
    expect(runs.length).toBeGreaterThanOrEqual(3);
  });

  it('stops when abort signal fires', async () => {
    const ac = new AbortController();
    const runner = vi.fn().mockResolvedValue(undefined);
    runAbortableInterval(runner, { ms: 5, signal: ac.signal, runImmediately: true });
    await new Promise(r => setTimeout(r, 20));
    const countAtStop = runner.mock.calls.length;
    ac.abort();
    await new Promise(r => setTimeout(r, 30));
    // Not more than +1 more call (a call may be in-flight at the abort moment).
    expect(runner.mock.calls.length).toBeLessThanOrEqual(countAtStop + 1);
  });

  it('does not start if signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const runner = vi.fn();
    runAbortableInterval(runner, { ms: 5, signal: ac.signal, runImmediately: true });
    await new Promise(r => setTimeout(r, 20));
    expect(runner).not.toHaveBeenCalled();
  });

  it('swallows errors by default and continues', async () => {
    let calls = 0;
    const stop = runAbortableInterval(
      async () => {
        calls++;
        if (calls === 1) throw new Error('first-fails');
      },
      { ms: 5, runImmediately: true },
    );
    await new Promise(r => setTimeout(r, 30));
    stop();
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('calls onError when supplied', async () => {
    const onError = vi.fn();
    const stop = runAbortableInterval(
      async () => {
        throw new Error('boom');
      },
      { ms: 5, runImmediately: true, onError },
    );
    await new Promise(r => setTimeout(r, 15));
    stop();
    expect(onError).toHaveBeenCalled();
  });
});
