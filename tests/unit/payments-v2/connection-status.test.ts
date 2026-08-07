// §4 connectionStatus(): the current connection status is READABLE at any time,
// not only observable at transition (sphere#473 — the header indicator mounts
// after an offline sign-in and, during a persistent outage, no further
// transition ever comes). The getter reads the session; the event is only the
// change notification, so the two can never disagree.

import { afterEach, describe, expect, it } from 'vitest';

import { cleanupWorlds, eventsOf, flushTail, makeWorld } from './facade-harness';

afterEach(cleanupWorlds);

describe('PaymentsFacade — connectionStatus()', () => {
  it("unstarted → 'offline', and a stopped facade goes back to 'offline' (no session, no connectivity claim)", async () => {
    const world = makeWorld();

    expect(world.facade.connectionStatus()).toBe('offline');

    await world.facade.start();
    world.session.setStatus('connected');
    expect(world.facade.connectionStatus()).toBe('connected');

    await world.facade.stop();
    expect(world.facade.connectionStatus()).toBe('offline');
  });

  it('tracks the last emitted status across connected → degraded → offline', async () => {
    const world = makeWorld();
    await world.facade.start();

    world.session.setStatus('connected');
    expect(world.facade.connectionStatus()).toBe('connected');

    world.session.setStatus('degraded');
    expect(world.facade.connectionStatus()).toBe('degraded');

    world.session.setStatus('offline');
    expect(world.facade.connectionStatus()).toBe('offline');
  });

  it('#473: a status emitted BEFORE any subscriber exists is still readable — the late mount seeds the outage', async () => {
    const world = makeWorld();
    await world.facade.start();

    // Sign-in fails during init: the transition happens with nobody listening.
    world.session.setStatus('offline');
    const emittedByNow = eventsOf(world, 'connection:status').length;

    // The indicator mounts HERE. A persistent outage produces no further event…
    await flushTail();
    expect(eventsOf(world, 'connection:status').length).toBe(emittedByNow);

    // …yet the current status is readable, so the warning can render.
    expect(world.facade.connectionStatus()).toBe('offline');
  });

  it('getter and event never disagree across a run of transitions', async () => {
    const world = makeWorld();
    await world.facade.start();

    const run = ['connected', 'degraded', 'offline', 'degraded', 'connected', 'offline'] as const;
    for (const status of run) {
      world.session.setStatus(status);
      const emitted = eventsOf(world, 'connection:status').at(-1) as { status: string };
      expect(emitted.status).toBe(status);
      expect(world.facade.connectionStatus()).toBe(status);
    }
  });
});
