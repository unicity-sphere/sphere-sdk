/**
 * Offline-resilient boot: a transport (relay) connect failure must NOT brick the wallet.
 *
 * Before this change, initializeProviders() awaited `transport.connect()` directly, so a
 * relay outage threw TRANSPORT_ERROR and Sphere.init() rejected — the ENTIRE wallet failed
 * to load (no local tokens, no balance, no on-chain ops) just because relays were down.
 *
 * Now the connect failure is caught: the wallet boots in a degraded/offline state (local
 * tokens load, the aggregator stays reachable for on-chain ops) and peer send/receive is
 * simply unavailable until the transport (re)connects. This test drives a rejecting
 * transport.connect() and asserts init still resolves with a usable identity.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenRegistry } from '../../../registry';
import { Sphere } from '../../../core/Sphere';
import { makeMockProviders } from './support/mock-providers';
import { TEST_NETWORK } from '../../test-network';

// Mock L1 network module so init() never reaches Fulcrum (mirrors other core tests).
vi.mock('../../../l1/network', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isWebSocketConnected: vi.fn().mockReturnValue(false),
}));

/** Stub fetch so the registry load resolves offline. */
function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      ({ ok: true, status: 200, statusText: 'OK', json: async () => [], text: async () => '[]' }) as unknown as Response,
    ),
  );
}

describe('Sphere offline-resilient boot (transport.connect failure is non-fatal)', () => {
  beforeEach(() => {
    TokenRegistry.resetInstance();
    if (Sphere.getInstance()) (Sphere as unknown as { instance: null }).instance = null;
    stubFetch();
  });

  afterEach(async () => {
    if (Sphere.getInstance()) {
      try { await Sphere.getInstance()!.destroy(); } catch { /* ignore */ }
    }
    (Sphere as unknown as { instance: null }).instance = null;
    TokenRegistry.destroy();
    vi.unstubAllGlobals();
  });

  it('boots with a usable identity when the relay transport cannot connect', async () => {
    const { storage, transport, oracle, l1 } = makeMockProviders({ walletExists: false });
    // Simulate relays unreachable: not connected, and connect() rejects like a real outage.
    (transport.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (transport.connect as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Failed to connect to any relay'),
    );

    // Must NOT throw — previously this rejected with TRANSPORT_ERROR.
    const { sphere } = await Sphere.init({
      storage, transport, oracle, l1,
      network: TEST_NETWORK,
      autoGenerate: true,
    });

    expect(transport.connect).toHaveBeenCalled();      // the connect branch ran
    expect(sphere.identity).toBeTruthy();              // wallet booted with an identity
    expect(sphere.identity!.chainPubkey).toBeTruthy(); // L3 identity usable (local ops work)
  });

  it('still boots an EXISTING wallet (load path) when the transport cannot connect', async () => {
    const { storage, transport, oracle, l1 } = makeMockProviders({ walletExists: true });
    (transport.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (transport.connect as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Failed to connect to any relay'),
    );

    const { sphere } = await Sphere.init({
      storage, transport, oracle, l1,
      network: TEST_NETWORK,
    });

    expect(sphere.identity).toBeTruthy();
  });
});
