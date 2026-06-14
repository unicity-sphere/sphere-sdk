/**
 * Sphere vault wiring (vault wallet wiring, concern 3).
 *
 * The wallet enables the remote vault as a backup/sync token-storage provider with a
 * single config flag: `Sphere.init({ vault: { enabled: true } })`. The SDK constructs
 * the provider internally (the app never has the spend key) and registers it ADDITIVELY
 * — the primary local token store is untouched. Everything is gated behind the flag and
 * defaults OFF, so existing wallets are unaffected.
 *
 * These tests assert REGISTRATION + the flag gate, not vault liveness: the vault's
 * `initialize()` is no-throw (a vault outage degrades), so registration must happen
 * regardless of whether the (stubbed) vault endpoint answers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenRegistry } from '../../../registry';
import { Sphere } from '../../../core/Sphere';
import { makeMockProviders } from './support/mock-providers';
import { TEST_NETWORK } from '../../test-network';

const VAULT_PROVIDER_ID = 'remote-token-storage';

// Mock L1 network module so init() never reaches Fulcrum (mirrors other core tests).
vi.mock('../../../l1/network', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isWebSocketConnected: vi.fn().mockReturnValue(false),
}));

/** Stub fetch so the registry load + the vault's no-throw init resolve offline. */
function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      ({ ok: true, status: 200, statusText: 'OK', json: async () => [], text: async () => '[]' }) as unknown as Response,
    ),
  );
}

describe('Sphere vault wiring (init flag)', () => {
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

  it('registers the vault provider when vault.enabled is true', async () => {
    const { storage, transport, oracle, l1 } = makeMockProviders({ walletExists: false });

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      l1,
      network: TEST_NETWORK,
      autoGenerate: true,
      vault: { enabled: true, url: 'http://localhost:1/unreachable' },
    });

    expect(sphere.hasTokenStorageProvider(VAULT_PROVIDER_ID)).toBe(true);
  });

  it('does NOT register the vault provider when vault is omitted (default OFF)', async () => {
    const { storage, transport, oracle, l1 } = makeMockProviders({ walletExists: false });

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      l1,
      network: TEST_NETWORK,
      autoGenerate: true,
    });

    expect(sphere.hasTokenStorageProvider(VAULT_PROVIDER_ID)).toBe(false);
  });

  it('does NOT register the vault provider when vault.enabled is false', async () => {
    const { storage, transport, oracle, l1 } = makeMockProviders({ walletExists: false });

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      l1,
      network: TEST_NETWORK,
      autoGenerate: true,
      vault: { enabled: false },
    });

    expect(sphere.hasTokenStorageProvider(VAULT_PROVIDER_ID)).toBe(false);
  });

  it('registers the vault on the load path too (existing wallet)', async () => {
    const { storage, transport, oracle, l1 } = makeMockProviders({ walletExists: true });

    const { sphere, created } = await Sphere.init({
      storage,
      transport,
      oracle,
      l1,
      network: TEST_NETWORK,
      vault: { enabled: true, url: 'http://localhost:1/unreachable' },
    });

    expect(created).toBe(false);
    expect(sphere.hasTokenStorageProvider(VAULT_PROVIDER_ID)).toBe(true);
  });

  it('keeps the primary local token store registered alongside the vault (additive)', async () => {
    const providers = makeMockProviders({ walletExists: false });

    const { sphere } = await Sphere.init({
      storage: providers.storage,
      transport: providers.transport,
      oracle: providers.oracle,
      tokenStorage: providers.tokenStorage, // the primary local store
      l1: providers.l1,
      network: TEST_NETWORK,
      autoGenerate: true,
      vault: { enabled: true, url: 'http://localhost:1/unreachable' },
    });

    // The vault is ADDITIVE: the primary local store is still registered too.
    expect(sphere.hasTokenStorageProvider(providers.tokenStorage.id)).toBe(true);
    expect(sphere.hasTokenStorageProvider(VAULT_PROVIDER_ID)).toBe(true);
  });
});
