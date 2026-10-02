import { afterEach, describe, expect, it, vi } from 'vitest';

import { hexToBytes } from '../../../core/crypto';
import { logger } from '../../../core/logger';
import { WalletCoinClaims } from '../../../modules/payments-v2/inventory/coin-claims';
import { CoinClaims } from '../../../token-engine/claims';
import { TokenType } from '../../../token-engine/sdk';

const PLUGIN_COIN = 'ab'.repeat(32);
const REGISTRY_COIN = 'cd'.repeat(32);
const PLUGIN_TYPE = '6f'.repeat(32);
const REGISTRY_TYPE = '70'.repeat(32);

function plugin(): CoinClaims {
  const claims = new CoinClaims();
  claims.add({ tokenType: new TokenType(hexToBytes(PLUGIN_TYPE)), coinIds: [PLUGIN_COIN], revision: 'r1', verify: vi.fn() });
  return claims;
}

function registry(claims: Record<string, string>) {
  return { getIssuanceClaims: () => new Map(Object.entries(claims)) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WalletCoinClaims', () => {
  it('claims a coin for the registry type when no plugin claims it, and enforces only the types a plugin polices', () => {
    const claims = new WalletCoinClaims(plugin(), registry({ [REGISTRY_COIN]: REGISTRY_TYPE }));

    expect(claims.issuerOf(REGISTRY_COIN.toUpperCase())).toBe(REGISTRY_TYPE);
    expect(claims.issuerOf(PLUGIN_COIN)).toBe(PLUGIN_TYPE);
    expect(claims.issuerOf('ee'.repeat(32))).toBeNull();
    expect(claims.enforces(PLUGIN_TYPE)).toBe(true);
    expect(claims.enforces(REGISTRY_TYPE)).toBe(false);
  });

  it('keeps the fingerprint of the plugins when the registry only agrees or conflicts, and extends it for a coin only the registry claims', () => {
    const plugins = plugin();
    const agreeing = new WalletCoinClaims(plugin(), registry({ [PLUGIN_COIN]: PLUGIN_TYPE }));
    const conflicting = new WalletCoinClaims(plugin(), registry({ [PLUGIN_COIN]: REGISTRY_TYPE }));
    const extending = new WalletCoinClaims(plugin(), registry({ [REGISTRY_COIN]: REGISTRY_TYPE }));
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    expect(agreeing.fingerprint()).toBe(plugins.fingerprint());
    expect(conflicting.fingerprint()).toBe(plugins.fingerprint());
    expect(extending.fingerprint()).not.toBe(plugins.fingerprint());
    expect(extending.fingerprint()).toContain(REGISTRY_TYPE);
  });

  it('keeps the plugin claim over a conflicting registry claim, and logs the conflict once', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const claims = new WalletCoinClaims(plugin(), registry({ [PLUGIN_COIN]: REGISTRY_TYPE }));

    claims.fingerprint();
    claims.fingerprint();

    expect(claims.issuerOf(PLUGIN_COIN)).toBe(PLUGIN_TYPE);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![1])).toContain(PLUGIN_COIN);
  });

  it('is ready once the registry cache has been read', async () => {
    let read = (): void => undefined;
    const cacheRead = new Promise<void>((resolve) => {
      read = resolve;
    });
    const claims = new WalletCoinClaims(plugin(), { ...registry({}), cacheRead: () => cacheRead });
    let ready = false;
    void claims.whenReady().then(() => {
      ready = true;
    });

    await Promise.resolve();
    expect(ready).toBe(false);
    read();
    await vi.waitFor(() => expect(ready).toBe(true));
  });
});
