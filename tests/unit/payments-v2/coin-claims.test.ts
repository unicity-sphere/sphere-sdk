import { afterEach, describe, expect, it, vi } from 'vitest';

import { hexToBytes } from '../../../core/crypto';
import { logger } from '../../../core/logger';
import { WalletCoinClaims } from '../../../modules/payments-v2/inventory/coin-claims';
import { CoinClaims } from '../../../token-engine/claims';
import { TokenType } from '../../../token-engine/sdk';

const PLUGIN_COIN = 'ab'.repeat(32);
const REGISTRY_COIN = 'cd'.repeat(32);
const OTHER_COIN = 'ef'.repeat(32);
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
  it('claims a coin for the registry type when no plugin claims it, and vouches only for a coin a plugin claims for that type', () => {
    const claims = new WalletCoinClaims(plugin(), registry({ [REGISTRY_COIN]: REGISTRY_TYPE, [OTHER_COIN]: PLUGIN_TYPE }));

    expect(claims.issuerOf(REGISTRY_COIN.toUpperCase())).toBe(REGISTRY_TYPE);
    expect(claims.issuerOf(PLUGIN_COIN)).toBe(PLUGIN_TYPE);
    expect(claims.issuerOf(OTHER_COIN)).toBe(PLUGIN_TYPE);
    expect(claims.issuerOf('ee'.repeat(32))).toBeNull();
    expect(claims.vouches(PLUGIN_COIN, PLUGIN_TYPE)).toBe(true);
    expect(claims.vouches(REGISTRY_COIN, REGISTRY_TYPE)).toBe(false);
    expect(claims.vouches(OTHER_COIN, PLUGIN_TYPE)).toBe(false);
  });

  it('keeps its plugin fingerprint whatever the registry says, and moves its version only for a coin no plugin claims', () => {
    const plugins = plugin();
    const silent = new WalletCoinClaims(plugin(), registry({}));
    const agreeing = new WalletCoinClaims(plugin(), registry({ [PLUGIN_COIN]: PLUGIN_TYPE }));
    const conflicting = new WalletCoinClaims(plugin(), registry({ [PLUGIN_COIN]: REGISTRY_TYPE }));
    const extending = new WalletCoinClaims(plugin(), registry({ [REGISTRY_COIN]: REGISTRY_TYPE }));
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    for (const claims of [silent, agreeing, conflicting, extending]) expect(claims.fingerprint()).toBe(plugins.fingerprint());
    expect(agreeing.version()).toBe(silent.version());
    expect(conflicting.version()).toBe(silent.version());
    expect(extending.version()).not.toBe(silent.version());
    expect(extending.version()).toContain(REGISTRY_TYPE);
  });

  it('keeps the plugin claim over a conflicting registry claim, and logs the conflict once', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const claims = new WalletCoinClaims(plugin(), registry({ [PLUGIN_COIN]: REGISTRY_TYPE }));

    claims.version();
    claims.version();

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
