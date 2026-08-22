// The server nudges an owner on EVERY inventory change (§9), so a 54-token
// receive delivers 54 wakes. Each one used to call view.delta() straight
// through — 54 round trips queued on a strict-FIFO SerialChain, competing with
// the drain's own claims. Measured: 64 GET /v1/inventory during one receive.

import { describe, expect, it } from 'vitest';

import { makeCoalescedRefresh } from '../../../modules/payments-v2/compose';

/** A refresh whose completion the test controls. */
function gated() {
  const releases: (() => void)[] = [];
  let calls = 0;
  const refresh = (): Promise<void> => {
    calls += 1;
    return new Promise<void>((resolve) => releases.push(resolve));
  };
  return {
    refresh,
    calls: () => calls,
    releaseNext: async (): Promise<void> => {
      releases.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('makeCoalescedRefresh', () => {
  it('collapses a burst arriving during one in-flight refresh into ONE re-run', async () => {
    const g = gated();
    const trigger = makeCoalescedRefresh(g.refresh);

    trigger();
    expect(g.calls()).toBe(1);

    // 53 more wakes while the first is still in flight — the receive's shape.
    for (let i = 0; i < 53; i += 1) trigger();
    expect(g.calls()).toBe(1);

    await g.releaseNext();
    // Exactly one trailing re-run, not 53.
    expect(g.calls()).toBe(2);

    await g.releaseNext();
    expect(g.calls()).toBe(2);
  });

  it('always re-runs after a trigger seen mid-flight — dropping it would leave the mirror stale', async () => {
    const g = gated();
    const trigger = makeCoalescedRefresh(g.refresh);

    trigger();
    // This wake reports a change the in-flight read may already have passed, so
    // discarding it (a plain single-flight) can strand the mirror until some
    // unrelated event fires.
    trigger();

    await g.releaseNext();
    expect(g.calls()).toBe(2);
  });

  it('runs immediately when nothing is in flight', async () => {
    const g = gated();
    const trigger = makeCoalescedRefresh(g.refresh);

    trigger();
    await g.releaseNext();
    expect(g.calls()).toBe(1);

    trigger();
    expect(g.calls()).toBe(2);
  });

  it('keeps accepting triggers after the refresh rejects', async () => {
    let calls = 0;
    const trigger = makeCoalescedRefresh(() => {
      calls += 1;
      return Promise.reject(new Error('offline'));
    });

    trigger();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    trigger();
    await Promise.resolve();

    // A failed refresh must not wedge the refresher permanently.
    expect(calls).toBe(2);
  });
});
