/**
 * resolveNetworkConfig + assertNetworkConsistency.
 *
 * The assertion is the startup safety net for every network: it refuses to run one
 * whose trust base is null or whose networkId contradicts the pinned expectation
 * (either would silently verify tokens against the wrong chain — a funds risk).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { TRUSTBASE_TESTNET2 } from '../../../../assets/trustbase';

// getEmbeddedTrustBase is imported directly by impl/shared/network.ts, so an ESM
// namespace spy cannot reach it — mock the module and drive it from a hoisted cell.
const override = vi.hoisted(() => ({ value: null as unknown }));

vi.mock('../../../../impl/shared/trustbase-loader', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../impl/shared/trustbase-loader')>();
  return {
    ...actual,
    getEmbeddedTrustBase: (network: Parameters<typeof actual.getEmbeddedTrustBase>[0]) =>
      override.value !== null ? override.value : actual.getEmbeddedTrustBase(network),
  };
});

const { resolveNetworkConfig, assertNetworkConsistency } = await import(
  '../../../../impl/shared/network'
);
const { createBrowserProviders } = await import('../../../../impl/browser');
const { createNodeProviders } = await import('../../../../impl/nodejs');

afterEach(() => {
  override.value = null;
});

describe('resolveNetworkConfig', () => {
  it('resolves a complete testnet2 config (own registry, trust base, networkId 4)', () => {
    const r = resolveNetworkConfig('testnet2');
    expect(r.config.tokenRegistryUrl).toContain('unicity-ids.testnet2.json');
    expect(r.trustBase).not.toBeNull();
    expect(r.networkId).toBe(4);
  });

  it('resolves networkId 4 for testnet (alias of testnet2 since the v1 cutover)', () => {
    expect(resolveNetworkConfig('testnet').networkId).toBe(4);
  });

  it('resolves a complete mainnet config (trust base, networkId 1)', () => {
    const r = resolveNetworkConfig('mainnet');
    expect(r.config.aggregatorUrl).toBe('https://gateway.mainnet.unicity.network');
    expect(r.trustBase).not.toBeNull();
    expect(r.networkId).toBe(1);
  });
});

describe('assertNetworkConsistency', () => {
  it('passes for testnet / testnet2 / dev (non-null trust base, matching networkId)', () => {
    expect(() => assertNetworkConsistency('testnet')).not.toThrow();
    expect(() => assertNetworkConsistency('testnet2')).not.toThrow();
    expect(() => assertNetworkConsistency('dev')).not.toThrow();
  });

  it('passes for mainnet — embedded trust base carries networkId 1', () => {
    expect(() => assertNetworkConsistency('mainnet')).not.toThrow();
  });

  it('throws when a network carries a trust base for a DIFFERENT chain', () => {
    // The failure this guard exists for: the testnet2 trust base (networkId 4) pasted
    // into the mainnet slot. Without the mainnet row in EXPECTED_NETWORK_ID the check
    // is skipped entirely and mainnet money verifies against testnet2 root nodes.
    override.value = TRUSTBASE_TESTNET2;
    expect(() => assertNetworkConsistency('mainnet')).toThrow(/does not match expected/i);
  });

  it('still throws when a network has no embedded trust base at all', () => {
    override.value = undefined;
    expect(() => assertNetworkConsistency('mainnet')).toThrow(/trust base/i);
  });

  it('is wired into createBrowserProviders — a mismatched trust base is refused', () => {
    // Proves assertNetworkConsistency is actually REACHED from the provider factory.
    // Asserting that mainnet merely constructs would not: both factories could drop
    // the call entirely and this suite would stay green.
    override.value = TRUSTBASE_TESTNET2;
    expect(() => createBrowserProviders({ network: 'mainnet' })).toThrow(
      /does not match expected/i,
    );
  });

  it('is wired into createNodeProviders — a mismatched trust base is refused', () => {
    override.value = TRUSTBASE_TESTNET2;
    expect(() => createNodeProviders({ network: 'mainnet' })).toThrow(
      /does not match expected/i,
    );
  });
});
