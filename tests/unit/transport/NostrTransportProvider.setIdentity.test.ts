/**
 * NostrTransportProvider.setIdentity() — client-swap safety (#770 item 1)
 *
 * setIdentity() replaces the live NostrClient when the identity changes while
 * connected. The swap must leave EXACTLY ONE surviving client on every path:
 *
 * - connect fails  → the half-built replacement is disposed, the provider keeps
 *   the working old client (which the Mux may be sharing — see the comment in
 *   setIdentity: tearing both down would kill the Mux's socket).
 * - connect succeeds, subscribe throws → the field has already moved, so the
 *   old client must be disposed anyway.
 *
 * The regression this pins: the field used to be assigned BEFORE connect, with
 * `oldClient.disconnect()` only on the success tail — so a failed connect
 * orphaned the old client (open socket, unreachable from the provider, so
 * `disconnect()` could not reach it either) and every retry leaked another one.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WebSocketFactory } from '../../../transport/websocket';

// =============================================================================
// Mock NostrClient — every construction is a DISTINGUISHABLE, recorded instance
// =============================================================================

interface MockClient {
  readonly id: number;
  readonly connect: ReturnType<typeof vi.fn>;
  readonly disconnect: ReturnType<typeof vi.fn>;
  readonly isConnected: ReturnType<typeof vi.fn>;
  readonly getConnectedRelays: ReturnType<typeof vi.fn>;
  readonly subscribe: ReturnType<typeof vi.fn>;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
  readonly publishEvent: ReturnType<typeof vi.fn>;
  readonly addConnectionListener: ReturnType<typeof vi.fn>;
  readonly removeConnectionListener: ReturnType<typeof vi.fn>;
}

/** Every NostrClient ever constructed, in construction order. */
const clients: MockClient[] = [];

/** Per-client failure injection, keyed by construction index. */
const rejectConnectFor = new Set<number>();
const hangConnectFor = new Set<number>();
const throwSubscribeFor = new Set<number>();

vi.mock('@unicitylabs/nostr-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@unicitylabs/nostr-js-sdk')>();
  return {
    ...actual,
    NostrClient: vi.fn().mockImplementation(() => {
      const id = clients.length;
      const client: MockClient = {
        id,
        connect: vi.fn(async () => {
          if (rejectConnectFor.has(id)) throw new Error(`relay refused (client ${id})`);
          if (hangConnectFor.has(id)) await new Promise<never>(() => { /* never settles */ });
        }),
        disconnect: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
        getConnectedRelays: vi.fn().mockReturnValue(new Set(['wss://relay1.test'])),
        subscribe: vi.fn(() => {
          if (throwSubscribeFor.has(id)) throw new Error(`subscribe failed (client ${id})`);
          return `sub-${id}`;
        }),
        unsubscribe: vi.fn(),
        publishEvent: vi.fn().mockResolvedValue('mock-event-id'),
        addConnectionListener: vi.fn(),
        removeConnectionListener: vi.fn(),
      };
      clients.push(client);
      return client;
    }),
  };
});

const { NostrTransportProvider } = await import('../../../transport/NostrTransportProvider');

// =============================================================================
// Helpers
// =============================================================================

const TIMEOUT_MS = 50;

function createProvider() {
  return new NostrTransportProvider({
    relays: ['wss://relay1.test'],
    // Inert: the (mocked) SDK NostrClient owns its own sockets.
    createWebSocket: (() => {}) as unknown as WebSocketFactory,
    timeout: TIMEOUT_MS,
    autoReconnect: false,
  });
}

/** Distinct valid secp256k1 private keys — NostrKeyManager is NOT mocked. */
function identity(n: number) {
  return {
    privateKey: n.toString(16).padStart(64, '0'),
    chainPubkey: `02${n.toString(16).padStart(64, '0')}`,
  };
}

/** Read the provider's private client field — the identity of the survivor. */
function currentClient(provider: InstanceType<typeof NostrTransportProvider>): MockClient | null {
  return (provider as unknown as { nostrClient: MockClient | null }).nostrClient;
}

/**
 * A client is leaked when it is neither disposed nor the provider's current
 * client: nothing can ever reach it again, and its socket stays open.
 */
function leakedClients(provider: InstanceType<typeof NostrTransportProvider>): number[] {
  const current = currentClient(provider);
  return clients
    .filter((c) => c.disconnect.mock.calls.length === 0 && c !== current)
    .map((c) => c.id);
}

// =============================================================================
// Tests
// =============================================================================

describe('NostrTransportProvider — setIdentity() client swap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clients.length = 0;
    rejectConnectFor.clear();
    hangConnectFor.clear();
    throwSubscribeFor.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('disposes the replacement and keeps the old client when connect REJECTS', async () => {
    const provider = createProvider();
    await provider.connect();                 // client 0 (temp key)
    await provider.setIdentity(identity(1));  // client 1 — the working client
    expect(currentClient(provider)).toBe(clients[1]);

    rejectConnectFor.add(2);
    await expect(provider.setIdentity(identity(2))).rejects.toThrow(/relay refused/);

    expect(clients).toHaveLength(3);
    expect(clients[2].disconnect).toHaveBeenCalledTimes(1); // replacement disposed
    expect(clients[1].disconnect).not.toHaveBeenCalled();   // old client untouched
    expect(currentClient(provider)).toBe(clients[1]);       // provider still usable
  });

  it('disposes the replacement and keeps the old client when connect TIMES OUT', async () => {
    const provider = createProvider();
    await provider.connect();
    await provider.setIdentity(identity(1));

    hangConnectFor.add(2);
    await expect(provider.setIdentity(identity(2))).rejects.toThrow(/timed out/);

    expect(clients).toHaveLength(3);
    expect(clients[2].disconnect).toHaveBeenCalledTimes(1);
    expect(clients[1].disconnect).not.toHaveBeenCalled();
    expect(currentClient(provider)).toBe(clients[1]);
  });

  it('disposes the OLD client when subscribeToEvents throws after the swap', async () => {
    const provider = createProvider();
    await provider.connect();
    await provider.setIdentity(identity(1));

    throwSubscribeFor.add(2);
    await expect(provider.setIdentity(identity(2))).rejects.toThrow(/subscribe failed/);

    expect(clients).toHaveLength(3);
    expect(clients[1].disconnect).toHaveBeenCalledTimes(1); // swap committed → old goes
    expect(clients[2].disconnect).not.toHaveBeenCalled();   // the new one is live
    expect(currentClient(provider)).toBe(clients[2]);
  });

  it('leaks nothing across repeated failures and a later success', async () => {
    const provider = createProvider();
    await provider.connect();
    await provider.setIdentity(identity(1));

    // Two failed retries in a row: setIdentity never touches `status`, so the
    // swap branch is re-entered every time — the pre-fix code leaked one client
    // per attempt.
    rejectConnectFor.add(2);
    await expect(provider.setIdentity(identity(2))).rejects.toThrow();
    hangConnectFor.add(3);
    await expect(provider.setIdentity(identity(3))).rejects.toThrow();
    // ...then a successful swap, and a failure after the swap point.
    await provider.setIdentity(identity(4));
    throwSubscribeFor.add(5);
    await expect(provider.setIdentity(identity(5))).rejects.toThrow();

    expect(clients).toHaveLength(6);
    expect(leakedClients(provider)).toEqual([]);
    // Exactly one survivor: every other client is disconnected.
    const alive = clients.filter((c) => c.disconnect.mock.calls.length === 0);
    expect(alive).toEqual([currentClient(provider)]);
    // ...and no client is disposed twice.
    for (const c of clients) {
      expect(c.disconnect.mock.calls.length).toBeLessThanOrEqual(1);
    }
  });

  it('leaves no pending connect-deadline timer behind', async () => {
    vi.useFakeTimers();
    const provider = createProvider();

    await provider.connect();                 // connect()'s own deadline race
    expect(vi.getTimerCount()).toBe(0);

    await provider.setIdentity(identity(1));  // setIdentity()'s deadline race
    expect(vi.getTimerCount()).toBe(0);
  });
});
