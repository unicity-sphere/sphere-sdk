/**
 * resolveNetworkConfig + assertNetworkConsistency.
 *
 * The assertion is the startup safety net for the mainnet-readiness scaffolding:
 * it refuses to run a network whose trust base is null or mismatched (which would
 * silently accept unverified tokens — a funds risk), while leaving currently-valid
 * networks working.
 */

import { describe, it, expect } from 'vitest';
import { resolveNetworkConfig, assertNetworkConsistency } from '../../../../impl/shared/network';
import { createBrowserProviders } from '../../../../impl/browser';

describe('resolveNetworkConfig', () => {
  it('resolves a complete testnet2 config (own registry, trust base, networkId 4)', () => {
    const r = resolveNetworkConfig('testnet2');
    expect(r.config.tokenRegistryUrl).toContain('unicity-ids.testnet2.json');
    expect(r.trustBase).not.toBeNull();
    expect(r.networkId).toBe(4);
  });

  it('resolves networkId 3 for testnet', () => {
    expect(resolveNetworkConfig('testnet').networkId).toBe(3);
  });
});

describe('assertNetworkConsistency', () => {
  it('passes for testnet / testnet2 / dev (non-null trust base, matching networkId)', () => {
    expect(() => assertNetworkConsistency('testnet')).not.toThrow();
    expect(() => assertNetworkConsistency('testnet2')).not.toThrow();
    expect(() => assertNetworkConsistency('dev')).not.toThrow();
  });

  it('throws for mainnet — no embedded trust base (would accept unverified tokens)', () => {
    expect(() => assertNetworkConsistency('mainnet')).toThrow(/trust base/i);
  });

  it('is wired into createBrowserProviders — mainnet is refused at provider construction', () => {
    expect(() => createBrowserProviders({ network: 'mainnet' })).toThrow(/trust base/i);
  });
});
