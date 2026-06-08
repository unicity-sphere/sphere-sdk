/**
 * Issue #423 — Nostr subscription handler-readiness gate
 *
 * Pre-#423: `transport.connect()` (and `setIdentity()` when already
 * connected) called `subscribeToEvents()` inline, opening the relay
 * subscription BEFORE any caller registered handlers. In the mux path
 * the outer NostrTransportProvider never gets handlers attached (they
 * live on the `AddressTransportAdapter` instead), so the outer
 * subscription would route every TOKEN_TRANSFER through the defensive
 * `pendingTransfers` buffer and pin `lastEventTs` — surfacing as the
 * persistent `[AT-LEAST-ONCE] TOKEN_TRANSFER ... not durable` warn
 * storm.
 *
 * Fix: defer `subscribeToEvents()` until ARMED. Two arming surfaces:
 *   1. Explicit `armSubscriptions()` — Sphere bootstrap uses this after
 *      every module's `initialize()` has registered its handlers.
 *   2. First `on*` handler registration — backward-compat for consumers
 *      that don't know about the explicit API.
 *
 * These tests exercise the public surface:
 *   - `connect()` does NOT subscribe before arming.
 *   - `armSubscriptions()` opens the subscription exactly once.
 *   - Idempotent re-arm is a no-op.
 *   - Reconnect after disconnect re-subscribes because the gate stays
 *     sticky.
 *   - Suppression (mux takeover) defeats arming (no relay sub opens).
 *   - Auto-arm-on-handler-register opens the sub for direct consumers.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WebSocketFactory } from '../../../transport/websocket';
import type { FullIdentity } from '../../../types';

// =============================================================================
// Mock NostrClient — record every subscribe() call so we can count them.
// =============================================================================

const mockSubscribe = vi.fn().mockReturnValue('mock-sub-id');
const mockUnsubscribe = vi.fn();
const mockPublishEvent = vi.fn().mockResolvedValue('mock-event-id');
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn();
const mockIsConnected = vi.fn().mockReturnValue(true);
const mockGetConnectedRelays = vi
  .fn()
  .mockReturnValue(new Set(['wss://relay.test']));
const mockAddConnectionListener = vi.fn();
const mockRelaysMap = new Map<string, unknown>();
const mockStopPingTimer = vi.fn();

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
      relays: mockRelaysMap,
      stopPingTimer: mockStopPingTimer,
    })),
  };
});

const { NostrTransportProvider } = await import(
  '../../../transport/NostrTransportProvider'
);

// =============================================================================
// Test setup
// =============================================================================

// Real-looking 64-hex private key — strictHexToBytes is strict, so the stub
// identity must use valid hex. The key derives a deterministic nostr pubkey
// which subscribe() embeds in the filter; we don't assert the value, only
// the call count and the fact that subscribe() WAS called.
const STUB_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'ab'.repeat(32),
  l1Address: 'alpha1stub',
  directAddress: 'DIRECT://stub',
  privateKey: 'cd'.repeat(32),
};

function createProvider() {
  return new NostrTransportProvider({
    relays: ['wss://relay.test'],
    createWebSocket: (() => {}) as unknown as WebSocketFactory,
    timeout: 100,
    autoReconnect: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsConnected.mockReturnValue(true);
  mockGetConnectedRelays.mockReturnValue(new Set(['wss://relay.test']));
  // Each subscribe() call gets a unique ID so the unsubscribe-on-rearm
  // logic in subscribeToEvents (clearing prior IDs) does the right thing.
  let counter = 0;
  mockSubscribe.mockImplementation(() => `mock-sub-${counter++}`);
});

// =============================================================================
// Gate behavior
// =============================================================================

describe('NostrTransportProvider — handler-readiness subscription gate (#423)', () => {
  it('does NOT subscribe to relay events on connect() until armed', async () => {
    const provider = createProvider();
    await provider.setIdentity(STUB_IDENTITY);
    await provider.connect();

    // Pre-#423 this would be 2 (wallet + chat subscriptions). With the gate
    // closed, subscribe() must NOT have been called.
    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(provider.isSubscriptionsArmed()).toBe(false);
  });

  it('armSubscriptions() opens the relay subscription exactly once', async () => {
    const provider = createProvider();
    await provider.setIdentity(STUB_IDENTITY);
    await provider.connect();
    expect(mockSubscribe).not.toHaveBeenCalled();

    await provider.armSubscriptions();
    // subscribeToEvents() creates two subscriptions: wallet + chat.
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    expect(provider.isSubscriptionsArmed()).toBe(true);
  });

  it('armSubscriptions() is idempotent — re-arming is a no-op', async () => {
    const provider = createProvider();
    await provider.setIdentity(STUB_IDENTITY);
    await provider.connect();
    await provider.armSubscriptions();
    expect(mockSubscribe).toHaveBeenCalledTimes(2);

    await provider.armSubscriptions();
    await provider.armSubscriptions();
    // No further subscribe calls — the gate is sticky.
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
  });

  it('armSubscriptions() before connect() defers subscribe until connect() runs', async () => {
    const provider = createProvider();
    await provider.armSubscriptions();
    // No connection yet — nothing to subscribe to.
    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(provider.isSubscriptionsArmed()).toBe(true);

    await provider.setIdentity(STUB_IDENTITY);
    await provider.connect();
    // Now that we're connected AND armed, subscribe runs.
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
  });

  it('registering onTokenTransfer auto-arms the gate', async () => {
    const provider = createProvider();
    await provider.setIdentity(STUB_IDENTITY);
    await provider.connect();
    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(provider.isSubscriptionsArmed()).toBe(false);

    const unsubscribe = provider.onTokenTransfer(async () => true);
    // Auto-arm fires immediately; subscribe is fire-and-forget so yield.
    await new Promise((r) => setTimeout(r, 0));
    expect(provider.isSubscriptionsArmed()).toBe(true);
    expect(mockSubscribe).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('registering onMessage auto-arms the gate', async () => {
    const provider = createProvider();
    await provider.setIdentity(STUB_IDENTITY);
    await provider.connect();

    const unsubscribe = provider.onMessage(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(provider.isSubscriptionsArmed()).toBe(true);
    expect(mockSubscribe).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('registering onPaymentRequest auto-arms the gate', async () => {
    const provider = createProvider();
    await provider.setIdentity(STUB_IDENTITY);
    await provider.connect();

    const unsubscribe = provider.onPaymentRequest(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(provider.isSubscriptionsArmed()).toBe(true);
    expect(mockSubscribe).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('registering onPaymentRequestResponse auto-arms the gate', async () => {
    const provider = createProvider();
    await provider.setIdentity(STUB_IDENTITY);
    await provider.connect();

    const unsubscribe = provider.onPaymentRequestResponse(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(provider.isSubscriptionsArmed()).toBe(true);
    expect(mockSubscribe).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('multiple handler registrations only subscribe once', async () => {
    const provider = createProvider();
    await provider.setIdentity(STUB_IDENTITY);
    await provider.connect();

    provider.onTokenTransfer(async () => true);
    provider.onMessage(() => undefined);
    provider.onPaymentRequest(() => undefined);
    await new Promise((r) => setTimeout(r, 0));

    // Still exactly 2 subscriptions (wallet + chat). The gate is sticky.
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
  });

  it('suppressSubscriptions() defeats arming — no subscribe opens', async () => {
    const provider = createProvider();
    await provider.setIdentity(STUB_IDENTITY);
    await provider.connect();
    // Mux scenario: suppress BEFORE handlers register.
    provider.suppressSubscriptions();

    // Even an explicit arm + handler registration must not open a sub.
    await provider.armSubscriptions();
    provider.onTokenTransfer(async () => true);
    await new Promise((r) => setTimeout(r, 0));

    expect(mockSubscribe).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Reconnect interaction
// =============================================================================

describe('NostrTransportProvider — gate + reconnect (#423)', () => {
  it('reconnect after disconnect re-subscribes because gate is sticky', async () => {
    const provider = createProvider();
    await provider.setIdentity(STUB_IDENTITY);
    await provider.connect();
    await provider.armSubscriptions();
    expect(mockSubscribe).toHaveBeenCalledTimes(2);

    // Disconnect — clears subscription IDs but the arm flag is sticky.
    await provider.disconnect();
    // Sticky: the gate state survives a disconnect/reconnect cycle.
    expect(provider.isSubscriptionsArmed()).toBe(true);

    // Reconnect → subscribeToEvents runs again because still armed.
    await provider.connect();
    // 2 from initial connect, 2 from reconnect = 4.
    expect(mockSubscribe).toHaveBeenCalledTimes(4);
  });
});
