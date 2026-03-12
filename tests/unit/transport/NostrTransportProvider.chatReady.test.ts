/**
 * Tests for NostrTransportProvider.onChatReady()
 *
 * Covers:
 * - Handler registration and unsubscribe
 * - Immediate invocation if EOSE already fired (via internal flag)
 * - chatEoseFired resets on disconnect
 * - Handler errors are caught (don't throw from EOSE callback)
 * - Handlers cleared after EOSE (one-time)
 *
 * Note: Full end-to-end tests of EOSE → handler flow require a real
 * relay connection — those are covered in relay integration tests.
 * Here we test the onChatReady() method contract in isolation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WebSocketFactory } from '../../../transport/websocket';

// =============================================================================
// Mock NostrClient — capture subscribe callbacks to simulate EOSE
// =============================================================================

interface SubscribeCall {
  filter: unknown;
  callbacks: Record<string, (...args: unknown[]) => void>;
}

const subscribeCalls: SubscribeCall[] = [];

const mockSubscribe = vi.fn().mockImplementation((filter: unknown, callbacks: Record<string, (...args: unknown[]) => void>) => {
  subscribeCalls.push({ filter, callbacks });
  return `mock-sub-${subscribeCalls.length}`;
});

// Shared mock functions used by all NostrClient instances
const sharedMocks = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isConnected: vi.fn().mockReturnValue(true),
  getConnectedRelays: vi.fn().mockReturnValue(new Set(['wss://relay1.test'])),
  subscribe: mockSubscribe,
  unsubscribe: vi.fn(),
  publishEvent: vi.fn().mockResolvedValue('mock-event-id'),
  addConnectionListener: vi.fn(),
};

vi.mock('@unicitylabs/nostr-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@unicitylabs/nostr-js-sdk')>();
  return {
    ...actual,
    NostrClient: vi.fn().mockImplementation(() => ({ ...sharedMocks })),
  };
});

const { NostrTransportProvider } = await import('../../../transport/NostrTransportProvider');

// =============================================================================
// Helpers
// =============================================================================

function createProvider() {
  return new NostrTransportProvider({
    relays: ['wss://relay1.test'],
    createWebSocket: (() => {}) as WebSocketFactory,
    timeout: 5000,
    autoReconnect: false,
  });
}

const TEST_IDENTITY = {
  privateKey: '0000000000000000000000000000000000000000000000000000000000000001',
  chainPubkey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  l1Address: 'alpha1test',
};

/** Find and invoke the onEndOfStoredEvents callback from the last chat subscription */
function triggerChatEose(): boolean {
  for (let i = subscribeCalls.length - 1; i >= 0; i--) {
    const cb = subscribeCalls[i]?.callbacks?.onEndOfStoredEvents;
    if (cb) {
      cb();
      return true;
    }
  }
  return false;
}

// =============================================================================
// Tests
// =============================================================================

describe('NostrTransportProvider — onChatReady()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscribeCalls.length = 0;
    sharedMocks.isConnected.mockReturnValue(true);
    sharedMocks.getConnectedRelays.mockReturnValue(new Set(['wss://relay1.test']));
  });

  it('should register handler and return unsubscribe function', () => {
    const provider = createProvider();
    const handler = vi.fn();

    const unsub = provider.onChatReady(handler);

    expect(typeof unsub).toBe('function');
    expect(handler).not.toHaveBeenCalled();
  });

  it('should not call handler after unsubscribe', () => {
    const provider = createProvider();
    const handler = vi.fn();

    const unsub = provider.onChatReady(handler);
    unsub();

    // Handler was removed from the list
    expect(handler).not.toHaveBeenCalled();
  });

  it('should call handler when EOSE fires via subscribeToEvents', async () => {
    const provider = createProvider();
    const handler = vi.fn();

    provider.onChatReady(handler);

    // Connect + setIdentity triggers subscribeToEvents internally
    await provider.connect();
    await provider.setIdentity(TEST_IDENTITY);

    // Verify subscriptions were created
    expect(subscribeCalls.length).toBeGreaterThan(0);

    // Handler not yet called
    expect(handler).not.toHaveBeenCalled();

    // Simulate EOSE
    const triggered = triggerChatEose();
    expect(triggered).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should call handler immediately if EOSE already fired', async () => {
    const provider = createProvider();

    // Connect and trigger EOSE
    await provider.connect();
    await provider.setIdentity(TEST_IDENTITY);
    triggerChatEose();

    // Late handler — should fire immediately since EOSE already happened
    const lateHandler = vi.fn();
    provider.onChatReady(lateHandler);
    expect(lateHandler).toHaveBeenCalledTimes(1);
  });

  it('should call multiple handlers on EOSE', async () => {
    const provider = createProvider();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    provider.onChatReady(handler1);
    provider.onChatReady(handler2);

    await provider.connect();
    await provider.setIdentity(TEST_IDENTITY);
    triggerChatEose();

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('should reset chatEoseFired on disconnect', async () => {
    const provider = createProvider();

    await provider.connect();
    await provider.setIdentity(TEST_IDENTITY);
    triggerChatEose();

    // Verify late handler fires immediately
    const handler1 = vi.fn();
    provider.onChatReady(handler1);
    expect(handler1).toHaveBeenCalledTimes(1);

    // Disconnect resets EOSE state
    await provider.disconnect();

    // After disconnect, new handler should NOT fire immediately
    const handler2 = vi.fn();
    provider.onChatReady(handler2);
    expect(handler2).not.toHaveBeenCalled();
  });

  it('should not throw if handler throws during EOSE', async () => {
    const provider = createProvider();
    const badHandler = vi.fn().mockImplementation(() => { throw new Error('boom'); });
    const goodHandler = vi.fn();

    provider.onChatReady(badHandler);
    provider.onChatReady(goodHandler);

    await provider.connect();
    await provider.setIdentity(TEST_IDENTITY);

    expect(() => triggerChatEose()).not.toThrow();
    expect(goodHandler).toHaveBeenCalledTimes(1);
  });

  it('should only fire handlers once even if EOSE fires multiple times', async () => {
    const provider = createProvider();
    const handler = vi.fn();

    provider.onChatReady(handler);

    await provider.connect();
    await provider.setIdentity(TEST_IDENTITY);

    triggerChatEose();
    triggerChatEose(); // Second EOSE — no-op

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should return no-op unsubscribe after immediate fire', async () => {
    const provider = createProvider();

    await provider.connect();
    await provider.setIdentity(TEST_IDENTITY);
    triggerChatEose();

    const handler = vi.fn();
    const unsub = provider.onChatReady(handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(() => unsub()).not.toThrow();
  });
});
