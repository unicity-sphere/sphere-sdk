/**
 * Regression guard: Sphere.init({ network }) must configure the TokenRegistry
 * for THAT network through BOTH delegations — Sphere.create() (fresh wallet)
 * and Sphere.load() (existing wallet).
 *
 * Background: a bug had Sphere.init() configure the registry for the requested
 * network, then call create()/load() WITHOUT forwarding options.network. Inside
 * those, configureTokenRegistry(storage, undefined) fell back to NETWORKS.testnet
 * and silently re-pointed the registry at the testnet (v1) URL — so testnet2
 * wallets fetched the wrong-network registry (testnet coinIds, no icons).
 *
 * These tests use a fetch spy to record which registry URL the SDK actually
 * fetched. If the network forwarding regresses, the second configure (inside
 * create/load) re-points remoteUrl at testnet, the testnet URL gets fetched,
 * and these assertions fail. Do NOT weaken the assertions to make them pass —
 * a failure here means the production fix regressed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenRegistry } from '../../../registry';
import { NETWORKS } from '../../../constants';
import { Sphere } from '../../../core/Sphere';
import { makeMockProviders } from './support/mock-providers';
import { TEST_NETWORK } from '../../test-network';

/**
 * Install a fetch spy that records every requested URL and returns a minimal,
 * valid token-definitions response ('[]' with HTTP 200) so refreshFromRemote()
 * succeeds. Returns the array the spy appends URLs to.
 */
function stubFetchRecording(): string[] {
  const fetched: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
      fetched.push(url);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => [],
        text: async () => '[]',
      } as unknown as Response;
    }),
  );
  return fetched;
}

describe('Sphere.init network → TokenRegistry delegation (regression guard)', () => {
  beforeEach(() => {
    // Fresh registry singleton per test so a prior test's remoteUrl can't leak.
    TokenRegistry.resetInstance();
    if (Sphere.getInstance()) {
      (Sphere as unknown as { instance: null }).instance = null;
    }
  });

  afterEach(async () => {
    if (Sphere.getInstance()) {
      try { await Sphere.getInstance()!.destroy(); } catch { /* ignore */ }
    }
    (Sphere as unknown as { instance: null }).instance = null;
    TokenRegistry.destroy();
    vi.unstubAllGlobals();
  });

  it('Test A: fresh wallet (create path) fetches testnet2 registry, not testnet', async () => {
    const fetched = stubFetchRecording();
    const { storage, transport, oracle, l1 } = makeMockProviders({ walletExists: false });

    const { sphere, created } = await Sphere.init({
      storage,
      transport,
      oracle,
      l1,
      network: TEST_NETWORK,
      autoGenerate: true,
    });

    // Sanity: this went through the create branch.
    expect(created).toBe(true);
    expect(sphere).toBeDefined();

    // Ensure the registry's initial remote load (the fetch) has resolved.
    await TokenRegistry.waitForReady();

    const registryFetches = fetched.filter((u) => u.includes('unicity-ids'));
    expect(registryFetches.length).toBeGreaterThan(0);
    expect(registryFetches).toContain(NETWORKS.testnet2.tokenRegistryUrl);
    // The legacy v1 registry (still pointed at by dev/mainnet) must never be fetched.
    // (Since the v1 cutover NETWORKS.testnet aliases testnet2, so the legacy URL
    // lives on NETWORKS.dev.)
    expect(registryFetches).not.toContain(NETWORKS.dev.tokenRegistryUrl);
  });

  it('Test B: existing wallet (load path) fetches testnet2 registry, not testnet', async () => {
    const fetched = stubFetchRecording();
    const { storage, transport, oracle, l1 } = makeMockProviders({ walletExists: true });

    const { sphere, created } = await Sphere.init({
      storage,
      transport,
      oracle,
      l1,
      network: TEST_NETWORK,
    });

    // Sanity: this went through the load branch.
    expect(created).toBe(false);
    expect(sphere).toBeDefined();

    await TokenRegistry.waitForReady();

    const registryFetches = fetched.filter((u) => u.includes('unicity-ids'));
    expect(registryFetches.length).toBeGreaterThan(0);
    expect(registryFetches).toContain(NETWORKS.testnet2.tokenRegistryUrl);
    // The legacy v1 registry (still pointed at by dev/mainnet) must never be fetched.
    // (Since the v1 cutover NETWORKS.testnet aliases testnet2, so the legacy URL
    // lives on NETWORKS.dev.)
    expect(registryFetches).not.toContain(NETWORKS.dev.tokenRegistryUrl);
  });
});
