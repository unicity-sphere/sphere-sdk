/**
 * Tests for shared configuration resolvers
 * Covers extend/override pattern for transport and oracle configs
 */

import { describe, it, expect } from 'vitest';
import {
  getNetworkConfig,
  resolveTransportConfig,
  resolveOracleConfig,
  resolveArrayConfig,
  resolveMarketConfig,
} from '../../../../impl/shared/resolvers';
import { NETWORKS } from '../../../../constants';

// =============================================================================
// getNetworkConfig
// =============================================================================

describe('getNetworkConfig', () => {
  it('should return mainnet config by default', () => {
    const config = getNetworkConfig();
    expect(config).toBe(NETWORKS.mainnet);
  });

  it('should return mainnet config when specified', () => {
    const config = getNetworkConfig('mainnet');
    expect(config.name).toBe('Mainnet');
    expect(config.aggregatorUrl).toBe(NETWORKS.mainnet.aggregatorUrl);
  });

  it('should return testnet config when specified (alias of testnet2 since the v1 cutover)', () => {
    const config = getNetworkConfig('testnet');
    expect(config.name).toBe('Testnet2');
    expect(config.aggregatorUrl).toBe(NETWORKS.testnet2.aggregatorUrl);
  });

  it('should return dev config when specified', () => {
    const config = getNetworkConfig('dev');
    expect(config.name).toBe('Development');
    expect(config.aggregatorUrl).toBe(NETWORKS.dev.aggregatorUrl);
  });
});

// =============================================================================
// resolveTransportConfig
// =============================================================================

describe('resolveTransportConfig', () => {
  describe('relay resolution (extend/override pattern)', () => {
    it('should use network defaults when no config provided', () => {
      const result = resolveTransportConfig('testnet');
      expect(result.relays).toEqual([...NETWORKS.testnet.nostrRelays]);
    });

    it('should use network defaults when empty config provided', () => {
      const result = resolveTransportConfig('testnet', {});
      expect(result.relays).toEqual([...NETWORKS.testnet.nostrRelays]);
    });

    it('should replace relays entirely when relays specified', () => {
      const customRelays = ['wss://custom1.relay', 'wss://custom2.relay'];
      const result = resolveTransportConfig('testnet', { relays: customRelays });
      expect(result.relays).toEqual(customRelays);
      expect(result.relays).not.toContain(NETWORKS.testnet.nostrRelays[0]);
    });

    it('should extend defaults with additionalRelays', () => {
      const additional = ['wss://extra.relay'];
      const result = resolveTransportConfig('testnet', { additionalRelays: additional });

      // Should contain both defaults and additional
      expect(result.relays).toContain(NETWORKS.testnet.nostrRelays[0]);
      expect(result.relays).toContain('wss://extra.relay');
      expect(result.relays.length).toBe(NETWORKS.testnet.nostrRelays.length + 1);
    });

    it('should prioritize relays over additionalRelays', () => {
      const result = resolveTransportConfig('testnet', {
        relays: ['wss://only-this.relay'],
        additionalRelays: ['wss://ignored.relay'],
      });

      expect(result.relays).toEqual(['wss://only-this.relay']);
      expect(result.relays).not.toContain('wss://ignored.relay');
    });
  });

  describe('other transport options', () => {
    it('should pass through timeout', () => {
      const result = resolveTransportConfig('testnet', { timeout: 15000 });
      expect(result.timeout).toBe(15000);
    });

    it('should pass through autoReconnect', () => {
      const result = resolveTransportConfig('testnet', { autoReconnect: true });
      expect(result.autoReconnect).toBe(true);
    });

    it('should pass through debug', () => {
      const result = resolveTransportConfig('testnet', { debug: true });
      expect(result.debug).toBe(true);
    });

    it('should pass through browser-specific options', () => {
      const result = resolveTransportConfig('testnet', {
        reconnectDelay: 5000,
        maxReconnectAttempts: 10,
      });
      expect(result.reconnectDelay).toBe(5000);
      expect(result.maxReconnectAttempts).toBe(10);
    });

    it('should return undefined for unset options', () => {
      const result = resolveTransportConfig('testnet');
      expect(result.timeout).toBeUndefined();
      expect(result.autoReconnect).toBeUndefined();
      expect(result.debug).toBeUndefined();
    });
  });
});

// =============================================================================
// resolveOracleConfig
// =============================================================================

describe('resolveOracleConfig', () => {
  describe('URL resolution', () => {
    it('should use network default URL when not specified', () => {
      const result = resolveOracleConfig('testnet');
      expect(result.url).toBe(NETWORKS.testnet.aggregatorUrl);
    });

    it('should use network default URL when empty config', () => {
      const result = resolveOracleConfig('testnet', {});
      expect(result.url).toBe(NETWORKS.testnet.aggregatorUrl);
    });

    it('should override URL when specified', () => {
      const customUrl = 'https://custom.aggregator.com';
      const result = resolveOracleConfig('testnet', { url: customUrl });
      expect(result.url).toBe(customUrl);
    });

    it('should use different defaults for different networks', () => {
      const mainnet = resolveOracleConfig('mainnet');
      const testnet = resolveOracleConfig('testnet');
      const dev = resolveOracleConfig('dev');

      expect(mainnet.url).toBe(NETWORKS.mainnet.aggregatorUrl);
      expect(testnet.url).toBe(NETWORKS.testnet.aggregatorUrl);
      expect(dev.url).toBe(NETWORKS.dev.aggregatorUrl);
    });
  });

  describe('other oracle options', () => {
    it('should pass through apiKey', () => {
      const result = resolveOracleConfig('testnet', { apiKey: 'secret-key' });
      expect(result.apiKey).toBe('secret-key');
    });

    it('should pass through timeout', () => {
      const result = resolveOracleConfig('testnet', { timeout: 60000 });
      expect(result.timeout).toBe(60000);
    });

    it('should pass through skipVerification', () => {
      const result = resolveOracleConfig('testnet', { skipVerification: true });
      expect(result.skipVerification).toBe(true);
    });

    it('should pass through debug', () => {
      const result = resolveOracleConfig('testnet', { debug: true });
      expect(result.debug).toBe(true);
    });

    it('should pass through node-specific trustBasePath', () => {
      const result = resolveOracleConfig('testnet', { trustBasePath: './trustbase.json' });
      expect(result.trustBasePath).toBe('./trustbase.json');
    });

    it('should NOT set an API key when not specified (no bundled default)', () => {
      const result = resolveOracleConfig('testnet');
      // The SDK no longer ships a default key — consumers inject config.oracle.apiKey from env.
      expect(result.apiKey).toBeUndefined();
      expect(result.timeout).toBeUndefined();
      expect(result.skipVerification).toBeUndefined();
    });

    it('should pass through an explicitly provided API key', () => {
      const result = resolveOracleConfig('testnet', { apiKey: 'sk_custom' });
      expect(result.apiKey).toBe('sk_custom');
    });
  });
});

// =============================================================================
// resolveArrayConfig
// =============================================================================

describe('resolveArrayConfig', () => {
  const defaults = ['a', 'b', 'c'] as const;

  it('should return copy of defaults when no replace or additional', () => {
    const result = resolveArrayConfig(defaults, undefined, undefined);
    expect(result).toEqual(['a', 'b', 'c']);
    // Should be a copy, not the same array
    expect(result).not.toBe(defaults);
  });

  it('should replace entirely when replace provided', () => {
    const result = resolveArrayConfig(defaults, ['x', 'y'], undefined);
    expect(result).toEqual(['x', 'y']);
  });

  it('should extend with additional when provided', () => {
    const result = resolveArrayConfig(defaults, undefined, ['d', 'e']);
    expect(result).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('should prioritize replace over additional', () => {
    const result = resolveArrayConfig(defaults, ['x'], ['d']);
    expect(result).toEqual(['x']);
    expect(result).not.toContain('d');
  });

  it('should handle empty replace array', () => {
    const result = resolveArrayConfig(defaults, [], undefined);
    expect(result).toEqual([]);
  });

  it('should handle empty additional array', () => {
    const result = resolveArrayConfig(defaults, undefined, []);
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('should handle empty defaults', () => {
    const result = resolveArrayConfig([], undefined, ['x']);
    expect(result).toEqual(['x']);
  });

  it('should work with complex objects', () => {
    const objDefaults = [{ id: 1 }, { id: 2 }] as const;
    const result = resolveArrayConfig(objDefaults, undefined, [{ id: 3 }]);
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({ id: 3 });
  });
});

// =============================================================================
// resolveMarketConfig
// =============================================================================

describe('resolveMarketConfig', () => {
  it('should return undefined when config is undefined', () => {
    const result = resolveMarketConfig(undefined);
    expect(result).toBeUndefined();
  });

  it('should return undefined when config is false', () => {
    const result = resolveMarketConfig(false);
    expect(result).toBeUndefined();
  });

  it('should return empty object when config is true', () => {
    const result = resolveMarketConfig(true);
    expect(result).toEqual({});
  });

  it('should pass through apiUrl from object config', () => {
    const result = resolveMarketConfig({ apiUrl: 'https://custom.market' });
    expect(result).toEqual({ apiUrl: 'https://custom.market', timeout: undefined });
  });

  it('should pass through timeout from object config', () => {
    const result = resolveMarketConfig({ timeout: 5000 });
    expect(result).toEqual({ apiUrl: undefined, timeout: 5000 });
  });

  it('should pass through both apiUrl and timeout', () => {
    const result = resolveMarketConfig({ apiUrl: 'https://api.test', timeout: 10000 });
    expect(result).toEqual({ apiUrl: 'https://api.test', timeout: 10000 });
  });

  it('should return object with undefined fields for empty object config', () => {
    const result = resolveMarketConfig({});
    expect(result).toEqual({ apiUrl: undefined, timeout: undefined });
  });
});

// =============================================================================
// Integration tests
// =============================================================================

describe('resolver integration', () => {
  it('should work together for full config resolution', () => {
    const network = 'testnet';

    const transport = resolveTransportConfig(network, {
      additionalRelays: ['wss://extra.relay'],
      timeout: 10000,
    });

    const oracle = resolveOracleConfig(network, {
      apiKey: 'test-key',
    });

    // Transport should have defaults + extra relay
    expect(transport.relays.length).toBeGreaterThan(1);
    expect(transport.relays).toContain('wss://extra.relay');
    expect(transport.timeout).toBe(10000);

    // Oracle should have testnet URL
    expect(oracle.url).toBe(NETWORKS.testnet.aggregatorUrl);
    expect(oracle.apiKey).toBe('test-key');
  });

  it('should handle minimal config (just network)', () => {
    const network = 'mainnet';

    const transport = resolveTransportConfig(network);
    const oracle = resolveOracleConfig(network);

    expect(transport.relays).toEqual([...NETWORKS.mainnet.nostrRelays]);
    expect(oracle.url).toBe(NETWORKS.mainnet.aggregatorUrl);
  });
});
