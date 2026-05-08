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
  l1Address: 'alpha1testaddr',
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
    const sharedClient = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
      getConnectedRelays: vi.fn().mockReturnValue(new Set(['wss://relay1.test'])),
      subscribe: vi.fn().mockReturnValue('shared-sub-id'),
      unsubscribe: vi.fn(),
      publishEvent: vi.fn().mockResolvedValue('mock-event-id'),
      addConnectionListener: vi.fn(),
    };

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
  };
}
