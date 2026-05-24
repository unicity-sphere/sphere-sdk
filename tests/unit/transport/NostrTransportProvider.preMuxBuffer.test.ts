/**
 * Issue #247 — pre-Mux TOKEN_TRANSFER buffer drain
 *
 * The relay-side `handleTokenTransfer` callback in NostrTransportProvider
 * fires the moment a kind:31113 event arrives, regardless of whether
 * downstream consumers (PaymentsModule, the AddressTransportAdapter
 * Mux) have wired up their handlers yet. Issue #223 — the pre-Mux race
 * — saw events landing on the outer provider with zero registered
 * handlers; the original handler returned `true` (vacuous "all
 * handlers durable"), advancing `lastEventTs` and silently dropping
 * the event. The #223 fix flipped it to `false`, which left the event
 * stranded in a replay loop: every reconnect re-delivered the same
 * event, but PaymentsModule's handler was on the Mux adapter, not the
 * outer provider, so no live process ever drained it.
 *
 * The #247 fix BUFFERS the transfer when no handler is registered and
 * DRAINS the buffer when a handler arrives via `onTokenTransfer`,
 * advancing `lastEventTs` per-event on successful delivery so the
 * events don't replay on next reconnect.
 *
 * This test exercises the public surface directly:
 *   1. Push a transfer to `pendingTransfers` (simulating the
 *      no-handler-yet path inside handleTokenTransfer).
 *   2. Register a handler via onTokenTransfer.
 *   3. Verify the handler was called for the buffered event.
 *   4. Verify `lastEventTs` advanced to the buffered event's created_at.
 *   5. Verify the buffer is empty after the drain.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock NostrClient before importing the provider (matches the
// per-file mock setup of other transport unit tests).
const mockSubscribe = vi.fn().mockReturnValue('mock-sub-id');
const mockUnsubscribe = vi.fn();
const mockPublishEvent = vi.fn().mockResolvedValue('mock-event-id');
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn();
const mockIsConnected = vi.fn().mockReturnValue(true);
const mockGetConnectedRelays = vi.fn().mockReturnValue(new Set(['wss://relay.test']));
const mockAddConnectionListener = vi.fn();

vi.mock('@unicitylabs/nostr-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@unicitylabs/nostr-js-sdk')>();
  return {
    ...actual,
    NostrClient: vi.fn().mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
      isConnected: mockIsConnected,
      getConnectedRelays: mockGetConnectedRelays,
      subscribe: mockSubscribe,
      unsubscribe: mockUnsubscribe,
      publishEvent: mockPublishEvent,
      addConnectionListener: mockAddConnectionListener,
      relays: new Map(),
      stopPingTimer: vi.fn(),
    })),
  };
});

import { NostrTransportProvider } from '../../../transport/NostrTransportProvider';
import type { IncomingTokenTransfer } from '../../../transport/transport-provider';

// Minimal in-memory storage stub satisfying the StorageProvider surface
// touched by updateLastEventTimestamp.
function createMockStorage(): {
  store: Map<string, string>;
  get: (k: string) => Promise<string | null>;
  set: (k: string, v: string) => Promise<void>;
  remove: (k: string) => Promise<void>;
  clear: () => Promise<void>;
} {
  const store = new Map<string, string>();
  return {
    store,
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async set(k: string, v: string) {
      store.set(k, v);
    },
    async remove(k: string) {
      store.delete(k);
    },
    async clear() {
      store.clear();
    },
  };
}

interface PrivateMembers {
  pendingTransfers: Array<{ transfer: IncomingTokenTransfer; createdAtSec: number }>;
  lastEventTs: number;
  identity: unknown;
  keyManager: unknown;
  storage: unknown;
}

function asPrivate(provider: NostrTransportProvider): PrivateMembers {
  return provider as unknown as PrivateMembers;
}

describe('NostrTransportProvider — pre-Mux TOKEN_TRANSFER buffer drain (#247)', () => {
  let provider: NostrTransportProvider;
  let storage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    storage = createMockStorage();
    provider = new NostrTransportProvider({ relays: ['wss://relay.test'] });
    // Inject the minimal state that `updateLastEventTimestamp` reads.
    // The real provider gets these from `connect()`; for unit-level
    // buffer/drain semantics we shortcut to keep the test focused.
    const priv = asPrivate(provider);
    priv.storage = storage as unknown;
    priv.keyManager = {
      getPublicKeyHex: () => 'a'.repeat(64),
    } as unknown;
    priv.identity = {
      chainPubkey: '02' + 'a'.repeat(64),
      l1Address: 'alpha1mock',
      privateKey: 'b'.repeat(64),
    } as unknown;
  });

  it('drains buffered transfers to the first registered handler and advances lastEventTs', async () => {
    const priv = asPrivate(provider);
    const transferA: IncomingTokenTransfer = {
      id: 'evt-a',
      senderTransportPubkey: 'sender-pub-a',
      payload: { foo: 'bar' } as never,
      timestamp: 1_700_000_000_000,
    };
    const transferB: IncomingTokenTransfer = {
      id: 'evt-b',
      senderTransportPubkey: 'sender-pub-b',
      payload: { foo: 'baz' } as never,
      timestamp: 1_700_000_005_000,
    };
    priv.pendingTransfers.push({ transfer: transferA, createdAtSec: 1_700_000_000 });
    priv.pendingTransfers.push({ transfer: transferB, createdAtSec: 1_700_000_005 });
    expect(priv.lastEventTs).toBe(0);

    const handler = vi.fn().mockResolvedValue(true);
    const unsubscribe = provider.onTokenTransfer(handler);

    // Buffer was cleared synchronously; drain runs as a microtask.
    expect(priv.pendingTransfers).toHaveLength(0);

    // Yield to the microtask queue so the fire-and-forget drain runs.
    await new Promise((r) => setTimeout(r, 0));

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, transferA);
    expect(handler).toHaveBeenNthCalledWith(2, transferB);

    // lastEventTs advanced to the later of the two buffered events.
    expect(priv.lastEventTs).toBe(1_700_000_005);

    // The storage write is fire-and-forget; yield once more to ensure
    // the persistence write completes.
    await new Promise((r) => setTimeout(r, 0));
    const persistedKey = Array.from(storage.store.keys()).find((k) =>
      k.startsWith('last_wallet_event_ts_'),
    );
    expect(persistedKey).toBeDefined();
    expect(storage.store.get(persistedKey!)).toBe('1700000005');

    unsubscribe();
  });

  it('does not advance lastEventTs for buffered transfers whose handler returns false', async () => {
    const priv = asPrivate(provider);
    priv.pendingTransfers.push({
      transfer: {
        id: 'evt-c',
        senderTransportPubkey: 'sender-pub-c',
        payload: { foo: 'qux' } as never,
        timestamp: 1_700_000_010_000,
      },
      createdAtSec: 1_700_000_010,
    });
    expect(priv.lastEventTs).toBe(0);

    const handler = vi.fn().mockResolvedValue(false);
    provider.onTokenTransfer(handler);
    await new Promise((r) => setTimeout(r, 0));

    expect(handler).toHaveBeenCalledOnce();
    // Handler returned false → lastEventTs MUST stay at 0 so the
    // event re-replays on next reconnect.
    expect(priv.lastEventTs).toBe(0);
  });

  it('does not advance lastEventTs for buffered transfers whose handler throws', async () => {
    const priv = asPrivate(provider);
    priv.pendingTransfers.push({
      transfer: {
        id: 'evt-d',
        senderTransportPubkey: 'sender-pub-d',
        payload: { foo: 'err' } as never,
        timestamp: 1_700_000_020_000,
      },
      createdAtSec: 1_700_000_020,
    });
    expect(priv.lastEventTs).toBe(0);

    const handler = vi.fn().mockRejectedValue(new Error('persist failed'));
    provider.onTokenTransfer(handler);
    await new Promise((r) => setTimeout(r, 0));

    expect(handler).toHaveBeenCalledOnce();
    expect(priv.lastEventTs).toBe(0);
  });

  it('subsequent live transfers (handler already registered) bypass the buffer', async () => {
    const handler = vi.fn().mockResolvedValue(true);
    provider.onTokenTransfer(handler);
    const priv = asPrivate(provider);

    // No buffered events at this point.
    expect(priv.pendingTransfers).toHaveLength(0);
    expect(handler).not.toHaveBeenCalled();

    // The drain only runs ONCE on the handler-registration call. A new
    // buffered transfer added later (which should not happen in
    // production, but exercises the contract) is not retroactively
    // drained — caller must re-register to pick it up.
    priv.pendingTransfers.push({
      transfer: {
        id: 'evt-e',
        senderTransportPubkey: 'pub-e',
        payload: {} as never,
        timestamp: 1_700_000_030_000,
      },
      createdAtSec: 1_700_000_030,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(handler).not.toHaveBeenCalled(); // buffer not retroactively drained
  });
});
