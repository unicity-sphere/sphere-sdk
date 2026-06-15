/**
 * Tests for the NIP-17 self-wrap opt-out path on MultiAddressTransportMux.
 *
 * Issue sphere-sdk#555 — every NIP-17 sendDM publishes TWO events: the
 * gift-wrap addressed to the recipient AND a self-wrap copy addressed to
 * the sender's own pubkey (so the sender can recover outbound history on
 * reconnect). For short-lived senders (one-shot CLI RPC like
 * `sphere trader portfolio`) the process exits before it could ever read
 * its own self-wrap, making the second publish pure relay-index
 * pollution — directly contributing to the M5 amplification described
 * in #555.
 *
 * The fix: `SendMessageOptions.selfWrap = false` skips the second publish.
 * Default behavior (`selfWrap` unset OR `selfWrap: true`) is unchanged.
 *
 * These tests confirm the contract by counting `publishEvent` calls on a
 * mocked NostrClient — no real socket traffic.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Buffer } from 'buffer';

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
const { NostrKeyManager } = await import('@unicitylabs/nostr-js-sdk');

// Real key material — the Mux runs NIP-17 gift-wrap construction inline,
// which performs ECDH against the recipient pubkey, so stub byte-fills
// like 'cc'.repeat(32) would fail (point-not-on-curve). Derive two real
// keypairs from fixed seeds for determinism.
const SENDER_SK_HEX = '11'.repeat(32);
const RECIPIENT_SK_HEX = '22'.repeat(32);
const senderKm = NostrKeyManager.fromPrivateKey(
  Uint8Array.from(Buffer.from(SENDER_SK_HEX, 'hex')),
);
const recipientKm = NostrKeyManager.fromPrivateKey(
  Uint8Array.from(Buffer.from(RECIPIENT_SK_HEX, 'hex')),
);
const RECIPIENT_X_PUBKEY = recipientKm.getPublicKeyHex(); // 64 hex (x-only)
// Compressed (33-byte) form derived from the same x-only pubkey — exercises
// the prefix-strip branch inside sendGiftWrap.
const RECIPIENT_COMPRESSED_PUBKEY = '02' + RECIPIENT_X_PUBKEY;

const SENDER_IDENTITY = {
  chainPubkey: '02' + senderKm.getPublicKeyHex(),
  l1Address: 'alpha1sender',
  directAddress: 'DIRECT://sender',
  transportPubkey: senderKm.getPublicKeyHex(),
  privateKey: SENDER_SK_HEX,
};

function buildMux() {
  return new MultiAddressTransportMux({
    relays: ['wss://relay1.test'],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createWebSocket: (() => {}) as any,
    timeout: 100,
    autoReconnect: false,
  });
}

describe('Mux NIP-17 self-wrap opt-out (sphere-sdk#555)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConnected.mockReturnValue(true);
    mockGetConnectedRelays.mockReturnValue(new Set(['wss://relay1.test']));
    mockSubscribe.mockReturnValue('mock-sub-id');
    mockPublishEvent.mockResolvedValue('mock-event-id');
  });

  it('publishes gift-wrap + self-wrap by default (2 publishes)', async () => {
    const mux = buildMux();
    await mux.addAddress(0, SENDER_IDENTITY);
    await mux.connect();
    mockPublishEvent.mockClear();

    await mux.sendGiftWrap(0, RECIPIENT_X_PUBKEY, 'hello');

    // Wait one microtask tick so the fire-and-forget self-wrap publish lands.
    await Promise.resolve();
    await Promise.resolve();

    expect(mockPublishEvent).toHaveBeenCalledTimes(2);
  });

  it('publishes only the gift-wrap when selfWrap is explicitly false', async () => {
    const mux = buildMux();
    await mux.addAddress(0, SENDER_IDENTITY);
    await mux.connect();
    mockPublishEvent.mockClear();

    await mux.sendGiftWrap(0, RECIPIENT_X_PUBKEY, 'hello', { selfWrap: false });

    await Promise.resolve();
    await Promise.resolve();

    expect(mockPublishEvent).toHaveBeenCalledTimes(1);
  });

  it('honours selfWrap: true the same as default (2 publishes)', async () => {
    const mux = buildMux();
    await mux.addAddress(0, SENDER_IDENTITY);
    await mux.connect();
    mockPublishEvent.mockClear();

    await mux.sendGiftWrap(0, RECIPIENT_X_PUBKEY, 'hello', { selfWrap: true });

    await Promise.resolve();
    await Promise.resolve();

    expect(mockPublishEvent).toHaveBeenCalledTimes(2);
  });

  it('strips the 02/03 prefix from the recipient pubkey on both branches', async () => {
    // Each option-shape must produce a publish even when given a 33-byte
    // compressed pubkey — confirms the new branch did not break the
    // prefix-stripping path.
    const mux = buildMux();
    await mux.addAddress(0, SENDER_IDENTITY);
    await mux.connect();
    mockPublishEvent.mockClear();

    await mux.sendGiftWrap(0, RECIPIENT_COMPRESSED_PUBKEY, 'hello', { selfWrap: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(mockPublishEvent).toHaveBeenCalledTimes(1);

    mockPublishEvent.mockClear();
    await mux.sendGiftWrap(0, RECIPIENT_COMPRESSED_PUBKEY, 'hello');
    await Promise.resolve();
    await Promise.resolve();
    expect(mockPublishEvent).toHaveBeenCalledTimes(2);
  });

  it('AddressTransportAdapter.sendMessage threads selfWrap through to the Mux', async () => {
    const mux = buildMux();
    const adapter = await mux.addAddress(0, SENDER_IDENTITY);
    await mux.connect();
    mockPublishEvent.mockClear();

    await adapter.sendMessage(RECIPIENT_X_PUBKEY, 'hello', { selfWrap: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(mockPublishEvent).toHaveBeenCalledTimes(1);

    mockPublishEvent.mockClear();
    await adapter.sendMessage(RECIPIENT_X_PUBKEY, 'hello');
    await Promise.resolve();
    await Promise.resolve();
    expect(mockPublishEvent).toHaveBeenCalledTimes(2);
  });
});
