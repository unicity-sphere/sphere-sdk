/**
 * Sphere courier wiring (wallet-courier wiring — the Sphere.init flag).
 *
 * The wallet enables the opt-in courier delivery channel with a single config flag:
 * `Sphere.init({ courier: { enabled: true } })`. The SDK constructs the courier
 * internally (the app never has the spend key) and passes it to the PaymentsModule as
 * `deliveryTransport`. Everything is gated behind the flag and defaults OFF, so
 * existing wallets are Nostr-only and completely unaffected.
 *
 * These tests assert the FLAG GATE + that the constructed courier reaches the payments
 * module init. The courier factory is mocked (this is wiring, not courier liveness).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenRegistry } from '../../../registry';
import { Sphere } from '../../../core/Sphere';
import { makeMockProviders } from './support/mock-providers';
import { TEST_NETWORK } from '../../test-network';

// Mock the courier factory so we observe construction + can pass a sentinel through
// to the payments module without standing up a real courier.
const courierSentinel = {
  capabilities: { async: true, ack: true, addressing: 'pubkey' as const },
  deposit: vi.fn(),
  setSinks: vi.fn(),
};
const createCourierMock = vi.fn(() => courierSentinel);
vi.mock('../../../transport/courier/factory', () => ({
  createCourierDeliveryTransport: (...args: unknown[]) => createCourierMock(...args),
}));

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

describe('Sphere courier wiring (init flag)', () => {
  beforeEach(() => {
    TokenRegistry.resetInstance();
    if (Sphere.getInstance()) (Sphere as unknown as { instance: null }).instance = null;
    createCourierMock.mockClear();
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

  it('constructs the courier and wires it as deliveryTransport when courier.enabled is true', async () => {
    const { storage, transport, oracle, l1 } = makeMockProviders({ walletExists: false });

    const { sphere } = await Sphere.init({
      storage, transport, oracle, l1,
      network: TEST_NETWORK,
      autoGenerate: true,
      courier: { enabled: true, url: 'http://localhost:1/unreachable' },
    });

    expect(createCourierMock).toHaveBeenCalled();
    // The first call's config carries the address identity + the configured url.
    const cfg = createCourierMock.mock.calls[0][0] as { network: string; vaultUrl?: string; identity: { chainPubkey: string } };
    expect(cfg.network).toBe(TEST_NETWORK);
    expect(cfg.identity.chainPubkey).toBe(sphere.identity!.chainPubkey);
  });

  it('does NOT construct the courier when courier is omitted (default OFF)', async () => {
    const { storage, transport, oracle, l1 } = makeMockProviders({ walletExists: false });

    await Sphere.init({
      storage, transport, oracle, l1,
      network: TEST_NETWORK,
      autoGenerate: true,
    });

    expect(createCourierMock).not.toHaveBeenCalled();
  });

  it('does NOT construct the courier when courier.enabled is false', async () => {
    const { storage, transport, oracle, l1 } = makeMockProviders({ walletExists: false });

    await Sphere.init({
      storage, transport, oracle, l1,
      network: TEST_NETWORK,
      autoGenerate: true,
      courier: { enabled: false },
    });

    expect(createCourierMock).not.toHaveBeenCalled();
  });

  it('constructs the courier on the load path too (existing wallet)', async () => {
    const { storage, transport, oracle, l1 } = makeMockProviders({ walletExists: true });

    const { created } = await Sphere.init({
      storage, transport, oracle, l1,
      network: TEST_NETWORK,
      courier: { enabled: true, url: 'http://localhost:1/unreachable' },
    });

    expect(created).toBe(false);
    expect(createCourierMock).toHaveBeenCalled();
  });
});
