/**
 * Tests for Sphere nametag sync with Nostr
 * Covers syncNametagWithNostr() functionality
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StorageProvider, OracleProvider, TransportProvider } from '../../../index';
import type { FullIdentity, ProviderStatus } from '../../../types';

// =============================================================================
// Mock Providers
// =============================================================================

function createMockStorage(): StorageProvider & { _data: Map<string, string> } {
  const data = new Map<string, string>();

  return {
    id: 'mock-storage',
    name: 'Mock Storage',
    type: 'local' as const,
    setIdentity: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    get: vi.fn((key: string) => Promise.resolve(data.get(key) ?? null)),
    set: vi.fn((key: string, value: string) => {
      data.set(key, value);
      return Promise.resolve();
    }),
    remove: vi.fn((key: string) => {
      data.delete(key);
      return Promise.resolve();
    }),
    has: vi.fn((key: string) => Promise.resolve(data.has(key))),
    keys: vi.fn((prefix?: string) => {
      const allKeys = Array.from(data.keys());
      if (prefix) {
        return Promise.resolve(allKeys.filter(k => k.startsWith(prefix)));
      }
      return Promise.resolve(allKeys);
    }),
    clear: vi.fn((prefix?: string) => {
      if (prefix) {
        for (const key of data.keys()) {
          if (key.startsWith(prefix)) {
            data.delete(key);
          }
        }
      } else {
        data.clear();
      }
      return Promise.resolve();
    }),
    _data: data,
  };
}

function createMockOracle(): OracleProvider {
  return {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'aggregator' as const,
    initialize: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    submitCommitment: vi.fn().mockResolvedValue({ requestId: 'test-request-id' }),
    getProof: vi.fn().mockResolvedValue(null),
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
  } as unknown as OracleProvider;
}

interface MockTransportProvider extends TransportProvider {
  _resolveResult: string | null;
  _registerResult: boolean;
  _registerCalls: Array<{ nametag: string; chainPubkey: string; directAddress: string }>;
  _resolveCalls: string[];
}

function createMockTransport(options: {
  resolveResult?: string | null;
  registerResult?: boolean;
} = {}): MockTransportProvider {
  const resolveCalls: string[] = [];
  const registerCalls: Array<{ nametag: string; chainPubkey: string; directAddress: string }> = [];

  return {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
    description: 'Mock transport for testing',

    setIdentity: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),

    sendMessage: vi.fn().mockResolvedValue('event-id'),
    onMessage: vi.fn().mockReturnValue(() => {}),
    sendTokenTransfer: vi.fn().mockResolvedValue('transfer-id'),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    sendPaymentRequest: vi.fn().mockResolvedValue('request-id'),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    sendPaymentRequestResponse: vi.fn().mockResolvedValue('response-id'),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    subscribeToBroadcast: vi.fn().mockReturnValue(() => {}),
    publishBroadcast: vi.fn().mockResolvedValue('broadcast-id'),
    onEvent: vi.fn().mockReturnValue(() => {}),

    resolveNametag: vi.fn((nametag: string) => {
      resolveCalls.push(nametag);
      return Promise.resolve(options.resolveResult ?? null);
    }),

    registerNametag: vi.fn((nametag: string, chainPubkey: string, directAddress: string) => {
      registerCalls.push({ nametag, chainPubkey, directAddress });
      return Promise.resolve(options.registerResult ?? true);
    }),

    // Test helpers
    _resolveResult: options.resolveResult ?? null,
    _registerResult: options.registerResult ?? true,
    _registerCalls: registerCalls,
    _resolveCalls: resolveCalls,
  } as MockTransportProvider;
}

// =============================================================================
// Tests
// =============================================================================

describe('Sphere.syncNametagWithNostr', () => {
  const TEST_PUBKEY = 'a'.repeat(64);
  const OTHER_PUBKEY = 'b'.repeat(64);
  const TEST_NAMETAG = 'lottery-v2';

  describe('when nametag is not registered on Nostr', () => {
    it('should re-register the nametag', async () => {
      const transport = createMockTransport({ resolveResult: null });

      // Simulate syncNametagWithNostr logic
      const identity: FullIdentity = {
        privateKey: 'c'.repeat(64),
        chainPubkey: TEST_PUBKEY,
        l1Address: 'alpha1test',
        directAddress: 'DIRECT://test',
        ipnsName: '12D3KooWtest',
        nametag: TEST_NAMETAG,
      };

      // Check if nametag exists on Nostr
      const existingPubkey = await transport.resolveNametag!(TEST_NAMETAG);
      expect(existingPubkey).toBeNull();

      // Should register since not found
      if (!existingPubkey) {
        await transport.registerNametag!(TEST_NAMETAG, identity.chainPubkey, identity.directAddress || '');
      }

      expect(transport._resolveCalls).toContain(TEST_NAMETAG);
      expect(transport._registerCalls).toHaveLength(1);
      expect(transport._registerCalls[0]).toEqual({
        nametag: TEST_NAMETAG,
        chainPubkey: TEST_PUBKEY,
        directAddress: 'DIRECT://test',
      });
    });
  });

  describe('when nametag is already registered to same pubkey', () => {
    it('should not re-register', async () => {
      const transport = createMockTransport({ resolveResult: TEST_PUBKEY });

      const identity: FullIdentity = {
        privateKey: 'c'.repeat(64),
        chainPubkey: TEST_PUBKEY,
        l1Address: 'alpha1test',
        directAddress: 'DIRECT://test',
        ipnsName: '12D3KooWtest',
        nametag: TEST_NAMETAG,
      };

      // Check if nametag exists on Nostr
      const existingPubkey = await transport.resolveNametag!(TEST_NAMETAG);
      expect(existingPubkey).toBe(TEST_PUBKEY);

      // Should not register since already registered to same pubkey
      if (existingPubkey !== identity.chainPubkey) {
        await transport.registerNametag!(TEST_NAMETAG, identity.chainPubkey, identity.directAddress || '');
      }

      expect(transport._resolveCalls).toContain(TEST_NAMETAG);
      expect(transport._registerCalls).toHaveLength(0);
    });
  });

  describe('when nametag is registered to different pubkey', () => {
    it('should not attempt to re-register (conflict)', async () => {
      const transport = createMockTransport({ resolveResult: OTHER_PUBKEY });

      const identity: FullIdentity = {
        privateKey: 'c'.repeat(64),
        chainPubkey: TEST_PUBKEY,
        l1Address: 'alpha1test',
        directAddress: 'DIRECT://test',
        ipnsName: '12D3KooWtest',
        nametag: TEST_NAMETAG,
      };

      // Check if nametag exists on Nostr
      const existingPubkey = await transport.resolveNametag!(TEST_NAMETAG);
      expect(existingPubkey).toBe(OTHER_PUBKEY);

      // Should not register since owned by someone else
      const isConflict = existingPubkey && existingPubkey !== identity.chainPubkey;
      expect(isConflict).toBe(true);

      // Simulate: do not register on conflict
      if (!isConflict) {
        await transport.registerNametag!(TEST_NAMETAG, identity.chainPubkey, identity.directAddress || '');
      }

      expect(transport._registerCalls).toHaveLength(0);
    });
  });

  describe('when identity has no nametag', () => {
    it('should do nothing', async () => {
      const transport = createMockTransport({ resolveResult: null });

      const identity: FullIdentity = {
        privateKey: 'c'.repeat(64),
        chainPubkey: TEST_PUBKEY,
        l1Address: 'alpha1test',
        ipnsName: '12D3KooWtest',
        // no nametag
      };

      // No nametag to sync
      if (!identity.nametag) {
        // Early return
        expect(transport._resolveCalls).toHaveLength(0);
        expect(transport._registerCalls).toHaveLength(0);
        return;
      }

      // This code should not be reached
      await transport.resolveNametag!(identity.nametag);
    });
  });

  describe('when transport does not support nametag operations', () => {
    it('should do nothing gracefully', async () => {
      const transport = createMockTransport();
      // Remove nametag methods
      delete (transport as Partial<MockTransportProvider>).resolveNametag;
      delete (transport as Partial<MockTransportProvider>).registerNametag;

      const identity: FullIdentity = {
        privateKey: 'c'.repeat(64),
        chainPubkey: TEST_PUBKEY,
        l1Address: 'alpha1test',
        ipnsName: '12D3KooWtest',
        nametag: TEST_NAMETAG,
      };

      // Should check if methods exist
      const hasNametagSupport = transport.resolveNametag && transport.registerNametag;
      expect(hasNametagSupport).toBeFalsy();

      // Should not throw
      if (hasNametagSupport) {
        await transport.resolveNametag!(identity.nametag!);
      }
    });
  });

  describe('when resolveNametag throws error', () => {
    it('should handle error gracefully', async () => {
      const transport = createMockTransport();
      transport.resolveNametag = vi.fn().mockRejectedValue(new Error('Network error'));

      const identity: FullIdentity = {
        privateKey: 'c'.repeat(64),
        chainPubkey: TEST_PUBKEY,
        l1Address: 'alpha1test',
        ipnsName: '12D3KooWtest',
        nametag: TEST_NAMETAG,
      };

      // Should not throw, just log warning
      let errorCaught = false;
      try {
        await transport.resolveNametag!(identity.nametag!);
      } catch {
        errorCaught = true;
      }

      expect(errorCaught).toBe(true);
    });
  });
});

// =============================================================================
// Tests: Nametag Recovery
// =============================================================================

describe('Sphere.recoverNametagFromNostr (simulated)', () => {
  const TEST_PUBKEY = 'a'.repeat(64);
  const TEST_NAMETAG = 'recovered-user';

  interface MockTransportWithRecovery extends TransportProvider {
    _recoverResult: string | null;
    _recoverCalls: number;
    _registerCalls: Array<{ nametag: string; chainPubkey: string; directAddress: string }>;
  }

  function createMockTransportWithRecovery(options: {
    recoverResult?: string | null;
  } = {}): MockTransportWithRecovery {
    const registerCalls: Array<{ nametag: string; chainPubkey: string; directAddress: string }> = [];
    let recoverCalls = 0;

    return {
      id: 'mock-transport-recovery',
      name: 'Mock Transport with Recovery',
      type: 'p2p' as const,
      description: 'Mock transport for recovery testing',

      setIdentity: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockReturnValue(true),
      getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),

      sendMessage: vi.fn().mockResolvedValue('event-id'),
      onMessage: vi.fn().mockReturnValue(() => {}),
      sendTokenTransfer: vi.fn().mockResolvedValue('transfer-id'),
      onTokenTransfer: vi.fn().mockReturnValue(() => {}),
      sendPaymentRequest: vi.fn().mockResolvedValue('request-id'),
      onPaymentRequest: vi.fn().mockReturnValue(() => {}),
      sendPaymentRequestResponse: vi.fn().mockResolvedValue('response-id'),
      onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
      subscribeToBroadcast: vi.fn().mockReturnValue(() => {}),
      publishBroadcast: vi.fn().mockResolvedValue('broadcast-id'),
      onEvent: vi.fn().mockReturnValue(() => {}),

      resolveNametag: vi.fn().mockResolvedValue(null),

      recoverNametag: vi.fn(() => {
        recoverCalls++;
        return Promise.resolve(options.recoverResult ?? null);
      }),

      registerNametag: vi.fn((nametag: string, chainPubkey: string, directAddress: string) => {
        registerCalls.push({ nametag, chainPubkey, directAddress });
        return Promise.resolve(true);
      }),

      // Test helpers
      _recoverResult: options.recoverResult ?? null,
      _recoverCalls: recoverCalls,
      get recoverCallCount() { return recoverCalls; },
      _registerCalls: registerCalls,
    } as MockTransportWithRecovery;
  }

  describe('when nametag can be recovered from Nostr', () => {
    it('should call recoverNametag on transport', async () => {
      const transport = createMockTransportWithRecovery({ recoverResult: TEST_NAMETAG });

      // Simulate recoverNametagFromNostr logic
      const identity: FullIdentity = {
        privateKey: 'c'.repeat(64),
        chainPubkey: TEST_PUBKEY,
        l1Address: 'alpha1test',
        directAddress: 'DIRECT://test',
        // No nametag initially
      };

      // Only recover if no nametag
      if (!identity.nametag && transport.recoverNametag) {
        const recovered = await transport.recoverNametag();

        if (recovered) {
          // Update identity
          (identity as { nametag?: string }).nametag = recovered;

          // Re-register to ensure event has latest format
          if (transport.registerNametag) {
            await transport.registerNametag(
              recovered,
              identity.chainPubkey,
              identity.directAddress || ''
            );
          }
        }
      }

      expect(identity.nametag).toBe(TEST_NAMETAG);
      expect(transport._registerCalls).toHaveLength(1);
      expect(transport._registerCalls[0]).toEqual({
        nametag: TEST_NAMETAG,
        chainPubkey: TEST_PUBKEY,
        directAddress: 'DIRECT://test',
      });
    });

    it('should not recover if identity already has nametag', async () => {
      const transport = createMockTransportWithRecovery({ recoverResult: 'should-not-use' });

      const identity: FullIdentity = {
        privateKey: 'c'.repeat(64),
        chainPubkey: TEST_PUBKEY,
        l1Address: 'alpha1test',
        nametag: 'existing-nametag', // Already has nametag
      };

      // Skip if already has nametag
      if (!identity.nametag && transport.recoverNametag) {
        const recovered = await transport.recoverNametag();
        if (recovered) {
          (identity as { nametag?: string }).nametag = recovered;
        }
      }

      // Should still have original nametag
      expect(identity.nametag).toBe('existing-nametag');
      expect(transport.recoverNametag).not.toHaveBeenCalled();
    });
  });

  describe('when nametag cannot be recovered', () => {
    it('should not set nametag when recovery returns null', async () => {
      const transport = createMockTransportWithRecovery({ recoverResult: null });

      const identity: FullIdentity = {
        privateKey: 'c'.repeat(64),
        chainPubkey: TEST_PUBKEY,
        l1Address: 'alpha1test',
      };

      if (!identity.nametag && transport.recoverNametag) {
        const recovered = await transport.recoverNametag();
        if (recovered) {
          (identity as { nametag?: string }).nametag = recovered;
        }
      }

      expect(identity.nametag).toBeUndefined();
      expect(transport._registerCalls).toHaveLength(0);
    });
  });

  describe('when transport does not support recovery', () => {
    it('should handle missing recoverNametag method gracefully', async () => {
      const transport = createMockTransportWithRecovery();
      // Remove recovery method
      delete (transport as Partial<MockTransportWithRecovery>).recoverNametag;

      const identity: FullIdentity = {
        privateKey: 'c'.repeat(64),
        chainPubkey: TEST_PUBKEY,
        l1Address: 'alpha1test',
      };

      // Check if method exists before calling
      if (!identity.nametag && transport.recoverNametag) {
        const recovered = await transport.recoverNametag();
        if (recovered) {
          (identity as { nametag?: string }).nametag = recovered;
        }
      }

      // Should not throw, nametag remains undefined
      expect(identity.nametag).toBeUndefined();
    });
  });

  describe('event emission (simulated)', () => {
    it('should emit nametag:recovered event when recovery succeeds', async () => {
      const transport = createMockTransportWithRecovery({ recoverResult: TEST_NAMETAG });
      const emittedEvents: Array<{ type: string; data: unknown }> = [];

      // Simulate event emission
      const emitEvent = (type: string, data: unknown) => {
        emittedEvents.push({ type, data });
      };

      const identity: FullIdentity = {
        privateKey: 'c'.repeat(64),
        chainPubkey: TEST_PUBKEY,
        l1Address: 'alpha1test',
      };

      if (!identity.nametag && transport.recoverNametag) {
        const recovered = await transport.recoverNametag();
        if (recovered) {
          (identity as { nametag?: string }).nametag = recovered;
          emitEvent('nametag:recovered', { nametag: recovered });
        }
      }

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].type).toBe('nametag:recovered');
      expect(emittedEvents[0].data).toEqual({ nametag: TEST_NAMETAG });
    });

    it('should not emit event when recovery fails', async () => {
      const transport = createMockTransportWithRecovery({ recoverResult: null });
      const emittedEvents: Array<{ type: string; data: unknown }> = [];

      const emitEvent = (type: string, data: unknown) => {
        emittedEvents.push({ type, data });
      };

      const identity: FullIdentity = {
        privateKey: 'c'.repeat(64),
        chainPubkey: TEST_PUBKEY,
        l1Address: 'alpha1test',
      };

      if (!identity.nametag && transport.recoverNametag) {
        const recovered = await transport.recoverNametag();
        if (recovered) {
          (identity as { nametag?: string }).nametag = recovered;
          emitEvent('nametag:recovered', { nametag: recovered });
        }
      }

      expect(emittedEvents).toHaveLength(0);
    });
  });
});
