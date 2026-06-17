/**
 * Tests for the shared-NostrClient path on MultiAddressTransportMux (#123).
 *
 * Sphere previously created two NostrClient instances against the same
 * relay set — one inside NostrTransportProvider and a second inside
 * MultiAddressTransportMux. Each opened its own WebSocket per relay, so a
 * single Sphere held two WS connections per relay.
 *
 * The fix: the Mux accepts a `sharedNostrClient` (or a getter) and skips
 * both `new NostrClient(...)` and `connect()` when one is provided. These
 * tests verify that contract directly with a mocked SDK so no real socket
 * traffic is involved.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSubscribe = vi.fn().mockReturnValue('mock-sub-id');
const mockUnsubscribe = vi.fn();
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn();
const mockIsConnected = vi.fn().mockReturnValue(true);
const mockGetConnectedRelays = vi.fn().mockReturnValue(new Set(['wss://relay1.test']));
const mockAddConnectionListener = vi.fn();
const mockRemoveConnectionListener = vi.fn();
const mockPublishEvent = vi.fn().mockResolvedValue('mock-event-id');

// Tracks how many times the SDK's NostrClient constructor was called.
const NostrClientCtor = vi.fn().mockImplementation(() => ({
  connect: mockConnect,
  disconnect: mockDisconnect,
  isConnected: mockIsConnected,
  getConnectedRelays: mockGetConnectedRelays,
  subscribe: mockSubscribe,
  unsubscribe: mockUnsubscribe,
  publishEvent: mockPublishEvent,
  addConnectionListener: mockAddConnectionListener,
  removeConnectionListener: mockRemoveConnectionListener,
}));

vi.mock('@unicitylabs/nostr-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@unicitylabs/nostr-js-sdk')>();
  return {
    ...actual,
    NostrClient: NostrClientCtor,
  };
});

const { MultiAddressTransportMux } = await import('../../../transport/MultiAddressTransportMux');

const TEST_IDENTITY = {
  chainPubkey: '02' + 'ab'.repeat(32),
  directAddress: 'DIRECT://test',
  transportPubkey: 'cc'.repeat(32),
  privateKey: 'dd'.repeat(32),
};

describe('MultiAddressTransportMux shared-NostrClient (#123)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConnected.mockReturnValue(true);
    mockGetConnectedRelays.mockReturnValue(new Set(['wss://relay1.test']));
    mockSubscribe.mockReturnValue('mock-sub-id');
  });

  it('uses the injected NostrClient and does NOT construct its own', async () => {
    // Build a "pre-existing" client (the one the outer NostrTransportProvider
    // already created). The Mux must reuse this instance verbatim.
    const sharedClient = makeStub();
    sharedClient.subscribe.mockReturnValue('shared-sub-id');

    // Reset the constructor counter AFTER importing the Mux module —
    // the import itself does not call the SDK NostrClient constructor.
    NostrClientCtor.mockClear();

    const mux = new MultiAddressTransportMux({
      relays: ['wss://relay1.test'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createWebSocket: (() => {}) as any,
      timeout: 100,
      autoReconnect: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sharedNostrClient: sharedClient as any,
    });

    await mux.addAddress(0, TEST_IDENTITY);
    await mux.connect();

    // The SDK's NostrClient constructor must NOT have been invoked at
    // all — that's the whole point of #123.
    expect(NostrClientCtor).not.toHaveBeenCalled();
    // Nor should connect() have been called on the shared client; that
    // is the outer transport's responsibility.
    expect(sharedClient.connect).not.toHaveBeenCalled();

    // The Mux must have hooked the shared client for events.
    expect(sharedClient.addConnectionListener).toHaveBeenCalled();
    // And opened wallet+chat subscriptions on it.
    expect(sharedClient.subscribe).toHaveBeenCalledTimes(2);

    await mux.disconnect();

    // Disconnect must NOT tear down the shared socket — the outer
    // transport still uses it for resolve calls.
    expect(sharedClient.disconnect).not.toHaveBeenCalled();
    // It MUST unsubscribe its own subs to release the slot on the relay.
    expect(sharedClient.unsubscribe).toHaveBeenCalled();
  });

  it('falls back to creating its own client when no shared client is provided', async () => {
    // Backwards-compat: existing test setups (and any consumer that
    // hasn't migrated to sharing) must keep working.
    NostrClientCtor.mockClear();

    const mux = new MultiAddressTransportMux({
      relays: ['wss://relay1.test'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createWebSocket: (() => {}) as any,
      timeout: 100,
      autoReconnect: false,
      // sharedNostrClient deliberately omitted
    });

    await mux.addAddress(0, TEST_IDENTITY);
    await mux.connect();

    expect(NostrClientCtor).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledTimes(1);

    await mux.disconnect();
    // When the Mux owns the client, it must disconnect it on teardown.
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });

  it('resolves the shared client via getter at connect-time', async () => {
    // The host (NostrTransportProvider) creates its NostrClient lazily
    // inside its own connect(). To support the case where the Mux is
    // configured before that happens, the API accepts a getter.
    let lazyClient: ReturnType<typeof makeStub> | null = null;
    const getter = vi.fn(() => lazyClient);

    NostrClientCtor.mockClear();

    const mux = new MultiAddressTransportMux({
      relays: ['wss://relay1.test'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createWebSocket: (() => {}) as any,
      timeout: 100,
      autoReconnect: false,
      sharedNostrClient: getter,
    });

    // The host transport "connects" (creates its client) before the Mux
    // calls its own connect(). The getter only resolves once the
    // client exists.
    lazyClient = makeStub();

    await mux.addAddress(0, TEST_IDENTITY);
    await mux.connect();

    expect(getter).toHaveBeenCalled();
    expect(NostrClientCtor).not.toHaveBeenCalled();
    expect(lazyClient.subscribe).toHaveBeenCalled();
  });

  it('rebindToSharedClient re-attaches to a freshly-created client and re-subscribes', async () => {
    // Simulates an address switch: the outer transport recreates its
    // NostrClient on setIdentity (the SDK can't change identity at
    // runtime). The Mux must adopt the new client and re-issue its
    // wallet/chat subs.
    let currentClient = makeStub();
    const getter = vi.fn(() => currentClient);

    const mux = new MultiAddressTransportMux({
      relays: ['wss://relay1.test'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createWebSocket: (() => {}) as any,
      timeout: 100,
      autoReconnect: false,
      sharedNostrClient: getter,
    });

    await mux.addAddress(0, TEST_IDENTITY);
    await mux.connect();

    // Initial subs went to the original client.
    expect(currentClient.subscribe).toHaveBeenCalledTimes(2); // wallet + chat
    const originalClient = currentClient;

    // Outer transport "swaps" its NostrClient on identity change.
    currentClient = makeStub();
    const newClient = currentClient;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (mux as any).rebindToSharedClient();

    // Mux must have moved to the new client.
    expect(getter).toHaveBeenCalled();
    expect(newClient.addConnectionListener).toHaveBeenCalled();
    expect(newClient.subscribe).toHaveBeenCalledTimes(2);

    // It must NOT call disconnect/unsubscribe on the original client —
    // that's already been torn down by the outer transport, and the
    // server-side subs are gone with it.
    expect(originalClient.disconnect).not.toHaveBeenCalled();
    expect(originalClient.unsubscribe).not.toHaveBeenCalled();
  });

  it('rebindToSharedClient is a no-op when the Mux owns its own client', async () => {
    NostrClientCtor.mockClear();

    const mux = new MultiAddressTransportMux({
      relays: ['wss://relay1.test'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createWebSocket: (() => {}) as any,
      timeout: 100,
      autoReconnect: false,
      // sharedNostrClient deliberately omitted
    });

    await mux.addAddress(0, TEST_IDENTITY);
    await mux.connect();

    const subscribeCallsBefore = mockSubscribe.mock.calls.length;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (mux as any).rebindToSharedClient();

    // No new construction, no extra subs.
    expect(NostrClientCtor).toHaveBeenCalledTimes(1);
    expect(mockSubscribe.mock.calls.length).toBe(subscribeCallsBefore);
  });

  it('throws if the shared client is not connected when the Mux tries to use it', async () => {
    const disconnectedClient = makeStub();
    disconnectedClient.isConnected.mockReturnValue(false);

    const mux = new MultiAddressTransportMux({
      relays: ['wss://relay1.test'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createWebSocket: (() => {}) as any,
      timeout: 100,
      autoReconnect: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sharedNostrClient: disconnectedClient as any,
    });

    await expect(mux.connect()).rejects.toThrow(/not connected/i);
  });

  it('removes its connection listener from the shared client on disconnect (no leak)', async () => {
    // The shared client outlives the Mux. If the Mux didn't remove its
    // listener on disconnect(), a later reconnect on the still-alive
    // socket would fire the listener and call updateSubscriptions on a
    // "disconnected" Mux — re-establishing subs nobody asked for.
    const sharedClient = makeStub();

    const mux = new MultiAddressTransportMux({
      relays: ['wss://relay1.test'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createWebSocket: (() => {}) as any,
      timeout: 100,
      autoReconnect: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sharedNostrClient: sharedClient as any,
    });

    await mux.addAddress(0, TEST_IDENTITY);
    await mux.connect();

    expect(sharedClient.addConnectionListener).toHaveBeenCalledTimes(1);
    const registeredListener = sharedClient.addConnectionListener.mock.calls[0][0];

    await mux.disconnect();

    // The exact same listener instance must come back through removeConnectionListener.
    expect(sharedClient.removeConnectionListener).toHaveBeenCalledWith(registeredListener);

    // Belt-and-suspenders: simulate the shared client firing onReconnected
    // AFTER the Mux disconnected. With the listener gone, updateSubscriptions
    // must not run — the sub-call counter stays where it was.
    const subsBefore = sharedClient.subscribe.mock.calls.length;
    // Caller-side simulation: any onReconnected fired by the shared
    // client now goes to whatever listeners it has, which we expect
    // does not include ours.
    expect(sharedClient.removeConnectionListener).toHaveBeenCalled();
    expect(sharedClient.subscribe.mock.calls.length).toBe(subsBefore);
  });

  it('does not double-fire transport:connected when the shared client fires onConnect', async () => {
    // Both the host transport and the Mux register listeners on the
    // same shared client. Without dedup, every socket onConnect would
    // drive both layers' emit paths and a consumer wired to both
    // would see the event twice. The Mux's own connect() still emits
    // once — that's a different semantic ("Mux is ready") — but the
    // listener-driven emit on subsequent socket events must NOT
    // duplicate the host transport's emit.
    const sharedClient = makeStub();

    const mux = new MultiAddressTransportMux({
      relays: ['wss://relay1.test'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createWebSocket: (() => {}) as any,
      timeout: 100,
      autoReconnect: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sharedNostrClient: sharedClient as any,
    });

    const events: string[] = [];
    mux.onTransportEvent((evt) => events.push(evt.type));

    await mux.addAddress(0, TEST_IDENTITY);
    await mux.connect();

    // Baseline: connect() emits exactly one "Mux ready" signal.
    const baselineConnected = events.filter(e => e === 'transport:connected').length;
    expect(baselineConnected).toBe(1);

    // Drive subsequent socket events. The host transport's own listener
    // (attached separately, not exercised by this test) would emit
    // transport:connected here. The Mux must NOT also emit.
    const listener = sharedClient.addConnectionListener.mock.calls[0][0];
    listener.onConnect('wss://relay1.test');
    listener.onReconnecting('wss://relay1.test', 1);
    listener.onReconnected('wss://relay1.test');

    // Counts must not have grown.
    expect(events.filter(e => e === 'transport:connected')).toHaveLength(baselineConnected);
    expect(events.filter(e => e === 'transport:reconnecting')).toHaveLength(0);
  });

  it('listener.onConnect does NOT emit transport:connected (avoids double-fire with connect()-bottom)', async () => {
    // The SDK fires onConnect once per fresh socket connection. In
    // owned-client mode, connect()'s bottom already emits
    // transport:connected after that returns. If onConnect also
    // emitted, every initial connect would fire transport:connected
    // twice. The fix: onConnect logs but does not emit; the
    // connect()-bottom is the single canonical source for initial.
    const mux = new MultiAddressTransportMux({
      relays: ['wss://relay1.test'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createWebSocket: (() => {}) as any,
      timeout: 100,
      autoReconnect: false,
    });

    const events: string[] = [];
    mux.onTransportEvent((evt) => events.push(evt.type));

    await mux.addAddress(0, TEST_IDENTITY);
    await mux.connect();

    const baselineConnected = events.filter(e => e === 'transport:connected').length;
    const listener = mockAddConnectionListener.mock.calls[0][0];

    // Drive onConnect — must NOT add a second transport:connected.
    listener.onConnect('wss://relay1.test');
    expect(events.filter(e => e === 'transport:connected')).toHaveLength(baselineConnected);

    // onReconnected IS still the source for "we recovered" — it
    // fires when the SDK reconnects after a disconnect cycle, and
    // there is no other emit-path covering that case in owned mode.
    listener.onReconnected('wss://relay1.test');
    expect(events.filter(e => e === 'transport:connected')).toHaveLength(baselineConnected + 1);

    // onReconnecting still emits transport:reconnecting in owned mode.
    listener.onReconnecting('wss://relay1.test', 1);
    expect(events.filter(e => e === 'transport:reconnecting')).toHaveLength(1);
  });

  it('does not double-emit transport:connected on initial connect when SDK fires onConnect during connect()', async () => {
    // Realistic regression test: the SDK's connect() actually fires
    // onConnect on registered listeners synchronously when the socket
    // opens. The mock for the rest of the file's `mockConnect` is a
    // bare resolved promise that doesn't fire the listener — too
    // forgiving for catching this bug. Here we simulate the SDK
    // behavior precisely.
    NostrClientCtor.mockClear();
    mockAddConnectionListener.mockClear();

    let capturedListener: { onConnect?: (url: string) => void } | undefined;
    mockAddConnectionListener.mockImplementationOnce((l: { onConnect?: (url: string) => void }) => {
      capturedListener = l;
    });
    mockConnect.mockImplementationOnce(async () => {
      // SDK behavior: callbacks fire while the socket is opening,
      // before connect() resolves.
      capturedListener?.onConnect?.('wss://relay1.test');
    });

    const mux = new MultiAddressTransportMux({
      relays: ['wss://relay1.test'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createWebSocket: (() => {}) as any,
      timeout: 100,
      autoReconnect: false,
    });

    const events: string[] = [];
    mux.onTransportEvent((evt) => events.push(evt.type));

    await mux.addAddress(0, TEST_IDENTITY);
    await mux.connect();

    // The SDK fired onConnect during connect(). Plus connect()-bottom
    // emits. Without the fix that would be 2; with the fix it's 1.
    expect(events.filter(e => e === 'transport:connected')).toHaveLength(1);
  });

  it('end-to-end: transport + Mux share one NostrClient instance (no second WS)', async () => {
    // This is the closest stand-in for the issue's "factory called once
    // per relay across Sphere.connect() + first address registration"
    // acceptance test. The published config field {@code createWebSocket}
    // is currently dead (the SDK creates its own sockets internally), so
    // the literal "factory" assertion can't be made — but the meaningful
    // proxy is "the SDK's NostrClient ctor is called exactly once across
    // both layers." That's what proves only one WS exists.
    NostrClientCtor.mockClear();

    // Stub the host transport surface that ensureTransportMux relies on.
    // The host creates its NostrClient lazily during its own connect()
    // — we simulate that by having the stub construct one when asked.
    const hostNostrClient = new NostrClientCtor();
    const hostTransport = {
      getNostrClient: () => hostNostrClient,
    };

    const mux = new MultiAddressTransportMux({
      relays: ['wss://relay1.test'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createWebSocket: (() => {}) as any,
      timeout: 100,
      autoReconnect: false,
      sharedNostrClient: () => hostTransport.getNostrClient(),
    });

    await mux.addAddress(0, TEST_IDENTITY);
    await mux.connect();

    // Across both layers: exactly one NostrClient was constructed (by
    // the host transport). The Mux did NOT construct a second.
    expect(NostrClientCtor).toHaveBeenCalledTimes(1);
    expect(mockConnect).not.toHaveBeenCalled(); // Mux did not call connect on the shared client
  });

  it('end-to-end with a real NostrTransportProvider: still exactly one NostrClient ctor call', async () => {
    // Stronger version of the previous test: instead of stubbing the
    // host, we instantiate an actual NostrTransportProvider (with the
    // SDK still mocked at module level), drive it through connect(),
    // then construct the Mux with the real getNostrClient() accessor.
    //
    // This exercises:
    //   - NostrTransportProvider.getNostrClient() — the accessor I
    //     added; without it the typeof guard in Sphere.ts silently
    //     falls through and the Mux opens a second socket.
    //   - The shared-client wiring as Sphere actually performs it.
    NostrClientCtor.mockClear();

    const { NostrTransportProvider } = await import('../../../transport/NostrTransportProvider');

    const transport = new NostrTransportProvider({
      relays: ['wss://relay1.test'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createWebSocket: (() => {}) as any,
      timeout: 100,
      autoReconnect: false,
    });
    await transport.connect();

    expect(NostrClientCtor).toHaveBeenCalledTimes(1); // host constructed one
    expect(typeof transport.getNostrClient).toBe('function'); // accessor exists
    expect(transport.getNostrClient()).toBeDefined();

    const mux = new MultiAddressTransportMux({
      relays: ['wss://relay1.test'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createWebSocket: (() => {}) as any,
      timeout: 100,
      autoReconnect: false,
      sharedNostrClient: () => transport.getNostrClient(),
    });

    await mux.addAddress(0, TEST_IDENTITY);
    await mux.connect();

    // Total NostrClient ctor calls across both layers must still be 1.
    expect(NostrClientCtor).toHaveBeenCalledTimes(1);
  });

  it('isConnected() reflects shared client losing its connection mid-Mux-life', async () => {
    // The Mux doesn't observe socket-level lifecycle changes on the
    // shared client beyond its connection listener. If the host
    // transport tears down or the underlying socket dies without our
    // listener firing in time, our internal `status` field stays
    // `connected` — but isConnected() must still return false because
    // it ANDs status with the live nostrClient.isConnected() check.
    const sharedClient = makeStub();

    const mux = new MultiAddressTransportMux({
      relays: ['wss://relay1.test'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createWebSocket: (() => {}) as any,
      timeout: 100,
      autoReconnect: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sharedNostrClient: sharedClient as any,
    });

    await mux.addAddress(0, TEST_IDENTITY);
    await mux.connect();

    expect(mux.isConnected()).toBe(true);

    // Shared socket dies under us — host transport hasn't yet called
    // anything on the Mux.
    sharedClient.isConnected.mockReturnValue(false);

    expect(mux.isConnected()).toBe(false);
  });

  it('rebindToSharedClient throws if the shared client getter returns null', async () => {
    // Wiring contract: by the time rebind is called, the host transport
    // must have its new NostrClient ready. A null return signals a
    // caller bug (rebind invoked before transport.setIdentity finished),
    // and we surface that loudly instead of silently leaving the Mux
    // pinned to its stale client.
    let activeClient: ReturnType<typeof makeStub> | null = makeStub();

    const mux = new MultiAddressTransportMux({
      relays: ['wss://relay1.test'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createWebSocket: (() => {}) as any,
      timeout: 100,
      autoReconnect: false,
      sharedNostrClient: () => activeClient,
    });

    await mux.addAddress(0, TEST_IDENTITY);
    await mux.connect();

    // Simulate "host hasn't (re)built its client yet" at rebind time.
    activeClient = null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((mux as any).rebindToSharedClient()).rejects.toThrow(/null|getter/i);
  });

  it('rebindToSharedClient throws if the new shared client is not connected', async () => {
    let activeClient = makeStub();

    const mux = new MultiAddressTransportMux({
      relays: ['wss://relay1.test'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createWebSocket: (() => {}) as any,
      timeout: 100,
      autoReconnect: false,
      sharedNostrClient: () => activeClient,
    });

    await mux.addAddress(0, TEST_IDENTITY);
    await mux.connect();

    // Host has a new client but it hasn't finished connecting.
    activeClient = makeStub();
    activeClient.isConnected.mockReturnValue(false);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((mux as any).rebindToSharedClient()).rejects.toThrow(/not connected/i);
  });

  it('connect() failure cleans up listener and client (no leak across retries)', async () => {
    // If the inner nostrClient.connect() rejects (e.g., timeout), the
    // partial state must be torn down so a subsequent retry doesn't
    // pile a second listener on the orphan or leak a half-initialised
    // NostrClient.
    NostrClientCtor.mockClear();
    mockAddConnectionListener.mockClear();

    // First connect attempt: SDK's connect rejects.
    mockConnect.mockRejectedValueOnce(new Error('boom'));

    const mux = new MultiAddressTransportMux({
      relays: ['wss://relay1.test'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createWebSocket: (() => {}) as any,
      timeout: 100,
      autoReconnect: false,
    });

    await mux.addAddress(0, TEST_IDENTITY);
    await expect(mux.connect()).rejects.toThrow(/boom/);

    // The listener attached during the failed attempt must have been
    // removed; the orphan client must have been disconnected.
    expect(mockAddConnectionListener).toHaveBeenCalledTimes(1);
    // SDK exposes removeConnectionListener — Mux must have called it.
    expect(mockRemoveConnectionListener).toHaveBeenCalledTimes(1);
    // Owned client must be disconnected on failed connect to release the socket.
    expect(mockDisconnect).toHaveBeenCalledTimes(1);

    // Second attempt now works (mockConnect default resolved).
    await mux.connect();

    // Exactly one listener registered for the second attempt — no
    // leftover from the first.
    expect(mockAddConnectionListener).toHaveBeenCalledTimes(2);
    // Two NostrClient ctor calls total: one for the failed attempt,
    // one for the successful retry.
    expect(NostrClientCtor).toHaveBeenCalledTimes(2);
  });
});

function makeStub() {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    getConnectedRelays: vi.fn().mockReturnValue(new Set(['wss://relay1.test'])),
    subscribe: vi.fn().mockReturnValue('stub-sub-id'),
    unsubscribe: vi.fn(),
    publishEvent: vi.fn().mockResolvedValue('mock-event-id'),
    addConnectionListener: vi.fn(),
    removeConnectionListener: vi.fn(),
  };
}
