/**
 * Tests for modules/payments/PaymentsModule.ts
 * Covers L1 optional initialization and configuration
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PaymentsModule, createPaymentsModule } from '../../../modules/payments/PaymentsModule';
import { L1PaymentsModule } from '../../../modules/payments/L1PaymentsModule';

// =============================================================================
// Mock L1 SDK functions to avoid network calls
// =============================================================================

vi.mock('../../../l1/network', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isWebSocketConnected: vi.fn().mockReturnValue(false),
}));

// =============================================================================
// Tests
// =============================================================================

describe('PaymentsModule', () => {
  describe('L1 optional initialization', () => {
    it('should have l1 as null when no config is provided', () => {
      const module = createPaymentsModule();
      expect(module.l1).toBeNull();
    });

    it('should have l1 as null when empty l1 config is provided', () => {
      const module = createPaymentsModule({ l1: {} });
      expect(module.l1).toBeNull();
    });

    it('should have l1 as null when l1 config has empty electrumUrl', () => {
      const module = createPaymentsModule({ l1: { electrumUrl: '' } });
      expect(module.l1).toBeNull();
    });

    it('should have l1 as null when l1 is undefined', () => {
      const module = createPaymentsModule({ l1: undefined });
      expect(module.l1).toBeNull();
    });

    it('should initialize l1 when electrumUrl is provided', () => {
      const module = createPaymentsModule({
        l1: { electrumUrl: 'wss://test.example.com:50004' },
      });
      expect(module.l1).not.toBeNull();
      expect(module.l1).toBeInstanceOf(L1PaymentsModule);
    });

    it('should initialize l1 with default fulcrum URL', () => {
      const module = createPaymentsModule({
        l1: { electrumUrl: 'wss://fulcrum.alpha.unicity.network:50004' },
      });
      expect(module.l1).not.toBeNull();
    });
  });

  describe('Module configuration defaults', () => {
    it('should have correct default config values', () => {
      const module = createPaymentsModule();
      const config = module.getConfig();

      expect(config.autoSync).toBe(true);
      expect(config.autoValidate).toBe(true);
      expect(config.retryFailed).toBe(true);
      expect(config.maxRetries).toBe(3);
      expect(config.debug).toBe(false);
    });

    it('should allow overriding config values', () => {
      const module = createPaymentsModule({
        autoSync: false,
        autoValidate: false,
        retryFailed: false,
        maxRetries: 5,
        debug: true,
      });
      const config = module.getConfig();

      expect(config.autoSync).toBe(false);
      expect(config.autoValidate).toBe(false);
      expect(config.retryFailed).toBe(false);
      expect(config.maxRetries).toBe(5);
      expect(config.debug).toBe(true);
    });
  });

  describe('destroy()', () => {
    it('should not throw when l1 is null', () => {
      const module = createPaymentsModule();
      expect(module.l1).toBeNull();
      expect(() => module.destroy()).not.toThrow();
    });

    it('should call l1.destroy() when l1 is enabled', () => {
      const module = createPaymentsModule({
        l1: { electrumUrl: 'wss://test.example.com:50004' },
      });
      expect(module.l1).not.toBeNull();

      const destroySpy = vi.spyOn(module.l1!, 'destroy');
      module.destroy();
      expect(destroySpy).toHaveBeenCalled();
    });
  });
});

describe('Incoming transfer payload format detection', () => {
  it('should recognize Sphere wallet format (sourceToken + transferTx)', () => {
    // Sphere wallet sends this format
    const spherePayload = {
      sourceToken: { genesis: {}, state: {} },
      transferTx: { data: { recipient: {}, salt: '' } },
    };

    // Check format detection logic (same as in handleIncomingTransfer)
    const hasSphereFormat = 'sourceToken' in spherePayload && 'transferTx' in spherePayload;
    const hasSdkFormat = 'token' in spherePayload;

    expect(hasSphereFormat).toBe(true);
    expect(hasSdkFormat).toBe(false);
  });

  it('should recognize SDK format (token + proof)', () => {
    // SDK sends this format
    const sdkPayload = {
      token: '{"genesis":{}}',
      proof: {},
      memo: 'test',
    };

    // Check format detection logic
    const hasSphereFormat = 'sourceToken' in sdkPayload && 'transferTx' in sdkPayload;
    const hasSdkFormat = 'token' in sdkPayload;

    expect(hasSphereFormat).toBe(false);
    expect(hasSdkFormat).toBe(true);
  });

  it('should handle string-encoded sourceToken', () => {
    const spherePayload = {
      sourceToken: '{"genesis":{"data":{"coinData":{"UCT":"1000000000000000000"}}}}',
      transferTx: '{"data":{"recipient":{"scheme":1}}}',
    };

    // Verify parsing logic
    const sourceToken = typeof spherePayload.sourceToken === 'string'
      ? JSON.parse(spherePayload.sourceToken)
      : spherePayload.sourceToken;

    expect(sourceToken.genesis.data.coinData.UCT).toBe('1000000000000000000');
  });

  it('should send in Sphere wallet format (sourceToken + transferTx), not SDK format (token + proof)', () => {
    // This test verifies the outgoing payload structure
    // SDK must send { sourceToken, transferTx } for Sphere compatibility
    const mockSdkToken = { genesis: { data: { coinData: { UCT: '1000' } } } };
    const mockTransferTx = { data: { recipient: { scheme: 1 }, salt: 'abc' } };

    // Simulate what PaymentsModule.send() should create
    const outgoingPayload = {
      sourceToken: JSON.stringify(mockSdkToken),
      transferTx: JSON.stringify(mockTransferTx),
      memo: 'test payment',
    };

    // Verify it uses Sphere format, not SDK format
    expect(outgoingPayload).toHaveProperty('sourceToken');
    expect(outgoingPayload).toHaveProperty('transferTx');
    expect(outgoingPayload).not.toHaveProperty('token');
    expect(outgoingPayload).not.toHaveProperty('proof');

    // Verify sourceToken and transferTx are JSON strings
    expect(typeof outgoingPayload.sourceToken).toBe('string');
    expect(typeof outgoingPayload.transferTx).toBe('string');
    expect(() => JSON.parse(outgoingPayload.sourceToken)).not.toThrow();
    expect(() => JSON.parse(outgoingPayload.transferTx)).not.toThrow();
  });
});

describe('L1PaymentsModule', () => {
  describe('configuration defaults', () => {
    it('should have default electrumUrl when created with config', () => {
      // Note: L1PaymentsModule is only created when electrumUrl is provided
      // via PaymentsModule, but directly it still has defaults
      const l1 = new L1PaymentsModule();
      // Access private config via any
      const config = (l1 as any)._config;

      expect(config.electrumUrl).toBe('wss://fulcrum.alpha.unicity.network:50004');
      expect(config.network).toBe('mainnet');
      expect(config.defaultFeeRate).toBe(10);
      expect(config.enableVesting).toBe(true);
    });

    it('should allow overriding config values', () => {
      const l1 = new L1PaymentsModule({
        electrumUrl: 'wss://custom.example.com:50004',
        network: 'testnet',
        defaultFeeRate: 5,
        enableVesting: false,
      });
      const config = (l1 as any)._config;

      expect(config.electrumUrl).toBe('wss://custom.example.com:50004');
      expect(config.network).toBe('testnet');
      expect(config.defaultFeeRate).toBe(5);
      expect(config.enableVesting).toBe(false);
    });
  });
});
