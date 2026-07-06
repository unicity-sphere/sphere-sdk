/**
 * Tests for the relay-subscription gate on MultiAddressTransportMux (#442).
 *
 * Issue #442 (cross-process Nostr delivery gap) — `ensureTransportMux()`
 * called `mux.connect()` and `mux.addAddress()` BEFORE non-critical
 * modules (SwapModule, AccountingModule, GroupChatModule, MarketModule)
 * registered their `communications.onDirectMessage(...)` fan-out
 * subscribers. Any DM replayed by the relay between the subscription open
 * and the late module loads landed in CommunicationsModule's inbox (its
 * own `onMessage` registered early) but never reached the late-
 * registering DM consumers — `sphere dm history` showed the message but
 * `sphere swap list` returned "No swaps found".
 *
 * The fix mirrors `NostrTransportProvider`'s #423 gate: a
 * `suppressSubscriptions` / `armSubscriptions` pair on the mux that
 * decouples the WebSocket open from the relay-subscription open. Sphere
 * bootstrap suppresses BEFORE `connect()`, runs every module's `load()`,
 * then arms — guaranteeing every late subscriber is wired before events
 * start streaming.
 *
 * These tests pin the gate semantics with a mocked SDK so the regression
 * cannot reappear:
 *   - Default-armed (backward compat for direct-construction consumers).
 *   - Suppressed mux: connect + addAddress is a relay-subscription no-op.
 *   - armSubscriptions opens the relay subscription with every tracked
 *     pubkey.
 *   - Idempotent / always-rebuild on arm so the multi-address switch path
 *     can re-call `armSubscriptions` to fold the newly-added pubkey into
 *     the filter without losing the gate's protection.
 *   - Suppressed updateSubscriptions does NOT tear down existing
 *     subscriptions — primary's active filter keeps delivering events
 *     during the gate window.
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

const TEST_IDENTITY_0 = {
  chainPubkey: '02' + 'ab'.repeat(32),
  directAddress: 'DIRECT://test0',
  transportPubkey: 'cc'.repeat(32),
  privateKey: 'dd'.repeat(32),
};

const TEST_IDENTITY_1 = {
  chainPubkey: '02' + 'cd'.repeat(32),
  directAddress: 'DIRECT://test1',
  transportPubkey: '11'.repeat(32),
  // secp256k1 private keys must be in [1..N-1]; 'ff'.repeat(32) is above N.
  // 22.. is a safe low-bit constant.
  privateKey: '22'.repeat(32),
};

function newMux() {
  return new MultiAddressTransportMux({
    relays: ['wss://relay1.test'],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createWebSocket: (() => {}) as any,
    timeout: 100,
    autoReconnect: false,
  });
}

describe('MultiAddressTransportMux — subscription gate (#442)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConnected.mockReturnValue(true);
    mockGetConnectedRelays.mockReturnValue(new Set(['wss://relay1.test']));
    mockSubscribe.mockReturnValue('mock-sub-id');
  });

  it('default-armed: connect + addAddress opens the relay subscription (backward compat)', async () => {
    // Direct-construction consumers (tests, custom hosts) that never call
    // suppressSubscriptions must see the same behavior as pre-#442:
    // connect + addAddress immediately opens wallet + chat subs.
    const mux = newMux();
    expect(mux.isSubscriptionsArmed()).toBe(true);

    await mux.connect();
    await mux.addAddress(0, TEST_IDENTITY_0);

    // updateSubscriptions ran inside addAddress because isConnected was
    // true and the gate was open. Two subscribes — wallet filter + chat
    // (gift-wrap) filter.
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
  });

  it('suppressed: connect + addAddress does NOT call subscribe', async () => {
    const mux = newMux();
    mux.suppressSubscriptions();
    expect(mux.isSubscriptionsArmed()).toBe(false);

    await mux.connect();
    await mux.addAddress(0, TEST_IDENTITY_0);

    // The gate short-circuited updateSubscriptions inside addAddress.
    // No relay subscribes — events cannot flow yet.
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('armSubscriptions after suppress opens the relay subscription with the tracked pubkey', async () => {
    const mux = newMux();
    mux.suppressSubscriptions();

    await mux.connect();
    await mux.addAddress(0, TEST_IDENTITY_0);
    expect(mockSubscribe).not.toHaveBeenCalled();

    await mux.armSubscriptions();

    expect(mux.isSubscriptionsArmed()).toBe(true);
    // Both wallet and chat filters open exactly once. updateSubscriptions
    // ran with all (one) tracked pubkey.
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
  });

  it('armSubscriptions always rebuilds (idempotent in effect, supports multi-address switch)', async () => {
    // The multi-address switch path re-arms the mux after suppressing it
    // around addAddress(N). Re-arm must rebuild the filter to include the
    // newly-added pubkey — calling armSubscriptions a second time cannot
    // be a no-op.
    const mux = newMux();
    mux.suppressSubscriptions();

    await mux.connect();
    await mux.addAddress(0, TEST_IDENTITY_0);
    await mux.armSubscriptions();
    expect(mockSubscribe).toHaveBeenCalledTimes(2);

    // Multi-address switch: suppress, addAddress(1), arm.
    mockSubscribe.mockClear();
    mockUnsubscribe.mockClear();
    mux.suppressSubscriptions();
    await mux.addAddress(1, TEST_IDENTITY_1);
    // While suppressed, addAddress's auto-update no-oped.
    expect(mockSubscribe).not.toHaveBeenCalled();

    await mux.armSubscriptions();
    // Now the rebuild ran: 2 unsubscribes (old wallet + old chat IDs) +
    // 2 subscribes (new wallet + new chat with both pubkeys in the filter).
    expect(mockUnsubscribe).toHaveBeenCalledTimes(2);
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
  });

  it('suppressSubscriptions does NOT tear down active subscriptions', async () => {
    // The multi-address-switch invariant: primary's active wallet/chat
    // subs MUST keep delivering events through the suppression window.
    // suppress sets the gate; it does not unsubscribe.
    const mux = newMux();

    await mux.connect();
    await mux.addAddress(0, TEST_IDENTITY_0);
    // Pre-suppression baseline: subs were opened.
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    mockSubscribe.mockClear();
    mockUnsubscribe.mockClear();

    mux.suppressSubscriptions();

    // No unsubscribes triggered by the gate flip.
    expect(mockUnsubscribe).not.toHaveBeenCalled();
    // And no new subscribes either.
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('suppressed updateSubscriptions does NOT tear down stale IDs (no event blackout)', async () => {
    // Regression guard: a naive "early-return after unsubscribe" version
    // of the gate would tear down the active subs without rebuilding,
    // dropping incoming events for already-tracked addresses. The gate
    // MUST short-circuit BEFORE the stale-ID unsubscribe.
    const mux = newMux();

    await mux.connect();
    await mux.addAddress(0, TEST_IDENTITY_0);
    mockUnsubscribe.mockClear();
    mockSubscribe.mockClear();

    // Now suppress + force a new updateSubscriptions trigger (addAddress on
    // a different index re-enters updateSubscriptions).
    mux.suppressSubscriptions();
    await mux.addAddress(1, TEST_IDENTITY_1);

    // No relay traffic at all — gate fires before the unsubscribe of the
    // stale wallet/chat IDs.
    expect(mockUnsubscribe).not.toHaveBeenCalled();
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('armSubscriptions before connect does NOT open subs (deferred until connect)', async () => {
    // Pre-connect arming is allowed (the flag is sticky). connect() opens
    // the WebSocket; updateSubscriptions runs inside connect()'s tail only
    // when there are tracked addresses. Without any address, no subscribe.
    const mux = newMux();
    mux.suppressSubscriptions();
    await mux.armSubscriptions();
    // No connect yet → no subscribe.
    expect(mockSubscribe).not.toHaveBeenCalled();

    // Connect with no addresses tracked → still no subscribe.
    await mux.connect();
    expect(mockSubscribe).not.toHaveBeenCalled();

    // Add an address → updateSubscriptions opens the relay sub.
    await mux.addAddress(0, TEST_IDENTITY_0);
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
  });

  it('AddressTransportAdapter exposes the gate API and delegates to the mux', async () => {
    const mux = newMux();
    mux.suppressSubscriptions();
    await mux.connect();
    const adapter = await mux.addAddress(0, TEST_IDENTITY_0);

    expect(adapter.isSubscriptionsArmed()).toBe(false);
    expect(mockSubscribe).not.toHaveBeenCalled();

    // Adapter delegates to the underlying mux — arming through the adapter
    // opens the relay sub for every tracked address.
    await adapter.armSubscriptions();
    expect(mux.isSubscriptionsArmed()).toBe(true);
    expect(mockSubscribe).toHaveBeenCalledTimes(2);

    // Re-suppress through the adapter — the gate closes for future
    // updateSubscriptions triggers (e.g., reconnect-driven re-subs).
    adapter.suppressSubscriptions();
    expect(mux.isSubscriptionsArmed()).toBe(false);
  });
});
