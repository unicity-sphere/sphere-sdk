/**
 * S1 realtime — the wake-socket reconnect SUPERVISOR (§9). The bare
 * `connectWakeSocket` nulled `onclose`/`onerror` after open, so ANY post-open
 * drop (server `terminate()` on a missed heartbeat, a 4401 token-expiry close,
 * a proxy/idle/network drop) went unobserved: the handle looked open but was
 * dead until a reload. `superviseWakeSocket` makes it self-heal — these tests
 * prove the real behaviour against the in-process fake:
 *
 *  - a forcibly dropped socket RECONNECTS (a fresh socket appears for the owner);
 *  - the liveness watchdog force-reconnects a HALF-OPEN socket (pongs/pings stop
 *    while the server socket stays open);
 *  - an intentional `close()` spawns NO reconnect loop and leaks no timers;
 *  - `onReconnect` (the catch-up pump) runs on every (re)connect;
 *  - a 4401 logout-close is distinguished from a drop (drops the JWT for a
 *    re-auth, and an intentional close after it does not loop);
 *  - `onStatus` surfaces true liveness (connected → reconnecting → connected →
 *    closed).
 *
 * Node < 22 has no global WebSocket — sockets are injected via the `ws` package
 * (this exact omission already broke a CI node-20 leg). `wsLikeWithPing` also
 * bridges the protocol ping/pong events the watchdog observes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WalletApiClient, type WakeSocketStatus } from '../../../wallet-api';
import { FakeWalletApi } from '../../support/fake-wallet-api';
import { MemoryKeyValueStore, testIdentity, wsLikeWithPing } from '../../support/wallet-api-test-helpers';

const identity = testIdentity(70);

// Tiny backoff/heartbeat so the suite runs well under the 10 s test timeout.
const FAST_TIMING = { backoffBaseMs: 5, backoffCapMs: 20, heartbeatMs: 25 };

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: predicate never became true');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('WalletApiClient — wake-socket reconnect supervisor (§9)', () => {
  let fake: FakeWalletApi;
  let baseUrl: string;
  let client: WalletApiClient;

  beforeEach(async () => {
    fake = new FakeWalletApi();
    baseUrl = await fake.start();
    client = new WalletApiClient({
      baseUrl,
      network: fake.network,
      deviceId: 'dev-sup',
      storage: new MemoryKeyValueStore(),
      webSocketFactory: wsLikeWithPing,
    });
    client.setIdentity(identity);
  });

  afterEach(async () => {
    await fake.stop();
  });

  it('reconnects after a forced drop — a fresh socket appears for the owner', async () => {
    const statuses: WakeSocketStatus[] = [];
    const handle = client.superviseWakeSocket(
      { onWake: () => undefined, onStatus: (s) => statuses.push(s) },
      FAST_TIMING
    );
    try {
      await waitFor(() => fake.socketCount(identity.chainPubkey) === 1);
      await waitFor(() => handle.status === 'connected');

      // The exact defect: a post-open drop the bare handle never noticed.
      expect(fake.dropSockets(identity.chainPubkey)).toBe(1);
      await waitFor(() => fake.socketCount(identity.chainPubkey) === 0);

      // The supervisor heals it — a NEW socket is established (backoff applied).
      await waitFor(() => fake.socketCount(identity.chainPubkey) === 1);
      await waitFor(() => handle.status === 'connected');
      // It went through the reconnecting state, not straight back to connected.
      expect(statuses).toContain('reconnecting');
      expect(statuses[statuses.length - 1]).toBe('connected');
    } finally {
      handle.close();
    }
  });

  it('survives REPEATED drops — heals each time (bounded backoff never gives up)', async () => {
    const handle = client.superviseWakeSocket({ onWake: () => undefined }, FAST_TIMING);
    try {
      for (let i = 0; i < 3; i += 1) {
        await waitFor(() => fake.socketCount(identity.chainPubkey) === 1);
        fake.dropSockets(identity.chainPubkey);
        await waitFor(() => fake.socketCount(identity.chainPubkey) === 0);
      }
      // After three drops it is still self-healing.
      await waitFor(() => fake.socketCount(identity.chainPubkey) === 1);
      await waitFor(() => handle.status === 'connected');
    } finally {
      handle.close();
    }
  });

  it('liveness watchdog force-reconnects a HALF-OPEN socket (pings stop)', async () => {
    const ownerSockets = (): Set<unknown> =>
      (fake as unknown as { socketsByOwner: Map<string, Set<unknown>> }).socketsByOwner.get(identity.chainPubkey) ?? new Set();

    // Keep the socket alive with periodic protocol pings — the watchdog (2× the
    // 25 ms heartbeat) stays armed while they flow.
    const ping = setInterval(() => fake.pingOwner(identity.chainPubkey), 10);
    const handle = client.superviseWakeSocket({ onWake: () => undefined }, FAST_TIMING);
    try {
      await waitFor(() => fake.socketCount(identity.chainPubkey) === 1);
      const firstSocket = [...ownerSockets()][0];

      // Half-open: stop the heartbeat but DON'T close the server socket. The
      // client sees only silence — the bare handle would stay "open" forever.
      clearInterval(ping);

      // The watchdog fires (~50 ms) and forces a reconnect: a DIFFERENT socket
      // instance ends up subscribed (the dead one was force-closed by the client).
      await waitFor(() => {
        const set = ownerSockets();
        return set.size === 1 && [...set][0] !== firstSocket;
      });
      await waitFor(() => handle.status === 'connected');
    } finally {
      clearInterval(ping);
      handle.close();
    }
  });

  it('an intentional close() spawns NO reconnect (no loop, no leaked socket)', async () => {
    const statuses: WakeSocketStatus[] = [];
    const handle = client.superviseWakeSocket(
      { onWake: () => undefined, onStatus: (s) => statuses.push(s) },
      FAST_TIMING
    );
    await waitFor(() => fake.socketCount(identity.chainPubkey) === 1);

    handle.close();
    await waitFor(() => fake.socketCount(identity.chainPubkey) === 0);
    expect(handle.status).toBe('closed');
    expect(statuses[statuses.length - 1]).toBe('closed');

    // Stays at zero — a closed supervisor must never reconnect. Wait several
    // backoff windows to be sure no socket reappears.
    await new Promise((r) => setTimeout(r, 120));
    expect(fake.socketCount(identity.chainPubkey)).toBe(0);
  });

  it('runs the catch-up pump (onReconnect) on EVERY (re)connect', async () => {
    let catchUps = 0;
    const handle = client.superviseWakeSocket(
      { onWake: () => undefined, onReconnect: () => { catchUps += 1; } },
      FAST_TIMING
    );
    try {
      // First connect.
      await waitFor(() => catchUps === 1);
      // A drop → reconnect runs the catch-up again (missed wakes aren't replayed).
      fake.dropSockets(identity.chainPubkey);
      await waitFor(() => catchUps === 2);
    } finally {
      handle.close();
    }
  });

  it('a 4401 logout-close drops the JWT (re-auth) and does not loop after close()', async () => {
    const handle = client.superviseWakeSocket({ onWake: () => undefined }, FAST_TIMING);
    await waitFor(() => fake.socketCount(identity.chainPubkey) === 1);

    // A clean 4401 close (auth gone) — the supervisor reconnects with a fresh
    // ticket (and a refreshed token), so a new socket appears.
    fake.dropSockets(identity.chainPubkey, { code: 4401, reason: 'access token expired' });
    await waitFor(() => fake.socketCount(identity.chainPubkey) === 0);
    await waitFor(() => fake.socketCount(identity.chainPubkey) === 1);
    await waitFor(() => handle.status === 'connected');

    // A deliberate close after the 4401 must NOT spin up an infinite reconnect.
    handle.close();
    await waitFor(() => fake.socketCount(identity.chainPubkey) === 0);
    await new Promise((r) => setTimeout(r, 120));
    expect(fake.socketCount(identity.chainPubkey)).toBe(0);
  });
});
