/**
 * The Connect host now stays alive for the whole lock window instead of dying within
 * milliseconds, so "keys leave memory on destroy()" must actually be true.
 * destroy() cleared _identity only; _mnemonic, _masterKey and _password survived, and
 * hasMasterKey()/getMnemonic()/getWalletInfo() answered from them with no guard.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenRegistry } from '../../../registry';
import { Sphere } from '../../../core/Sphere';
import { makeMockProviders, TEST_MNEMONIC } from './support/mock-providers';
import { TEST_NETWORK } from '../../test-network';

/** Registry refreshFromRemote() must not hit the network in a unit test. */
function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => [],
      text: async () => '[]',
    } as unknown as Response)),
  );
}

interface SphereSecrets {
  _mnemonic: string | null;
  _masterKey: unknown | null;
  _password: string | null;
}

function secrets(sphere: Sphere): SphereSecrets {
  return sphere as unknown as SphereSecrets;
}

async function initWallet(password?: string): Promise<Sphere> {
  const { storage, transport, oracle, walletApi } = makeMockProviders({ walletExists: false });
  const { sphere } = await Sphere.init({
    storage,
    transport,
    oracle,
    walletApi,
    network: TEST_NETWORK,
    mnemonic: TEST_MNEMONIC,
    ...(password ? { password } : {}),
  });
  return sphere;
}

function resetSingleton(): void {
  (Sphere as unknown as { instance: Sphere | null }).instance = null;
}

describe('Sphere.destroy() secret hygiene', () => {
  beforeEach(() => {
    TokenRegistry.resetInstance();
    stubFetch();
    resetSingleton();
  });

  afterEach(async () => {
    const live = Sphere.getInstance();
    if (live) {
      try { await live.destroy(); } catch { /* ignore */ }
    }
    resetSingleton();
    TokenRegistry.destroy();
    vi.unstubAllGlobals();
  });

  it('holds the mnemonic and master key while initialized', async () => {
    const sphere = await initWallet();

    expect(sphere.getMnemonic()).toBe(TEST_MNEMONIC);
    expect(sphere.hasMasterKey()).toBe(true);
    expect(secrets(sphere)._masterKey).not.toBeNull();
  });

  it('zeroes _mnemonic, _masterKey and _password on destroy()', async () => {
    const sphere = await initWallet('correct horse battery staple');

    await sphere.destroy();

    expect(secrets(sphere)._mnemonic).toBeNull();
    expect(secrets(sphere)._masterKey).toBeNull();
    expect(secrets(sphere)._password).toBeNull();
  });

  it('throws NOT_INITIALIZED instead of silently changing its answer after destroy()', async () => {
    const sphere = await initWallet();

    await sphere.destroy();

    // Silently answering false/null/a half-empty WalletInfo is worse than throwing: a
    // caller cannot tell "no master key" from "the wallet is gone".
    expect(() => sphere.getMnemonic()).toThrow('Sphere not initialized');
    expect(() => sphere.hasMasterKey()).toThrow('Sphere not initialized');
    expect(() => sphere.getWalletInfo()).toThrow('Sphere not initialized');
  });
});

describe('Sphere.encrypt() fails closed', () => {
  beforeEach(() => {
    TokenRegistry.resetInstance();
    stubFetch();
    resetSingleton();
  });

  afterEach(async () => {
    const live = Sphere.getInstance();
    if (live) {
      try { await live.destroy(); } catch { /* ignore */ }
    }
    resetSingleton();
    TokenRegistry.destroy();
    vi.unstubAllGlobals();
  });

  function encrypt(sphere: Sphere, data: string): string {
    return (sphere as unknown as { encrypt(d: string): string }).encrypt(data);
  }

  it('throws instead of writing plaintext when a protected wallet lost its password', async () => {
    const sphere = await initWallet('correct horse battery staple');
    (sphere as unknown as { _password: string | null })._password = null;

    expect(() => encrypt(sphere, 'secret')).toThrow('Wallet password is not available');
  });

  it('still passes through for a wallet that never had a password', async () => {
    const sphere = await initWallet();
    expect(encrypt(sphere, 'plain')).toBe('plain');
  });

  it('still encrypts normally while the password is present', async () => {
    const sphere = await initWallet('correct horse battery staple');
    const out = encrypt(sphere, 'secret');
    expect(out).not.toBe('secret');
    expect(out.length).toBeGreaterThan(0);
  });
});
