/**
 * Tests for CommunicationsModule.resolvePeerNametag()
 *
 * Covers:
 * - Returns nametag from transport.resolveTransportPubkeyInfo()
 * - Returns undefined when transport doesn't support resolveTransportPubkeyInfo
 * - Returns undefined when peer has no nametag (info.nametag is undefined)
 * - Returns undefined when resolveTransportPubkeyInfo returns null
 * - Returns undefined when resolveTransportPubkeyInfo throws
 * - Returns undefined when module is not initialized
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommunicationsModule } from '../../../modules/communications/CommunicationsModule';
import type { CommunicationsModuleDependencies } from '../../../modules/communications/CommunicationsModule';
import type { TransportProvider, PeerInfo } from '../../../transport';
import type { StorageProvider } from '../../../storage';
import type { FullIdentity } from '../../../types';

// =============================================================================
// Mock Factories
// =============================================================================

function createMockTransport(overrides?: Partial<TransportProvider>): TransportProvider {
  return {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
    description: 'Mock transport for testing',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue('mock-event-id'),
    onMessage: vi.fn().mockReturnValue(() => {}),
    sendTokenTransfer: vi.fn().mockResolvedValue('mock-event-id'),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

function createMockStorage(): StorageProvider {
  const store = new Map<string, string>();
  return {
    id: 'mock-storage',
    name: 'Mock Storage',
    type: 'local' as const,
    description: 'Mock storage for testing',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    get: vi.fn().mockImplementation((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn().mockImplementation((key: string, value: string) => { store.set(key, value); return Promise.resolve(); }),
    remove: vi.fn().mockResolvedValue(undefined),
    has: vi.fn().mockImplementation((key: string) => Promise.resolve(store.has(key))),
    keys: vi.fn().mockResolvedValue([]),
    clear: vi.fn().mockResolvedValue(undefined),
    saveTrackedAddresses: vi.fn().mockResolvedValue(undefined),
    loadTrackedAddresses: vi.fn().mockResolvedValue([]),
  };
}

const MY_PUBKEY = '02' + 'a'.repeat(64);
const PEER_PUBKEY = '02' + 'b'.repeat(64);

function createMockIdentity(): FullIdentity {
  return {
    privateKey: '0'.repeat(64),
    chainPubkey: MY_PUBKEY,
    l1Address: 'alpha1testaddr',
    directAddress: 'DIRECT://testaddr',
    nametag: 'testuser',
  };
}

function createDeps(overrides?: Partial<CommunicationsModuleDependencies>): CommunicationsModuleDependencies {
  return {
    identity: createMockIdentity(),
    storage: createMockStorage(),
    transport: createMockTransport(),
    emitEvent: vi.fn(),
    ...overrides,
  };
}

function makePeerInfo(nametag?: string): PeerInfo {
  return {
    transportPubkey: PEER_PUBKEY,
    chainPubkey: PEER_PUBKEY,
    l1Address: 'alpha1peer',
    directAddress: 'DIRECT://peer',
    timestamp: Date.now(),
    ...(nametag ? { nametag } : {}),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('CommunicationsModule — resolvePeerNametag', () => {
  let mod: CommunicationsModule;

  beforeEach(() => {
    mod = new CommunicationsModule();
  });

  it('should return nametag when transport resolves peer info with nametag', async () => {
    const transport = createMockTransport({
      resolveTransportPubkeyInfo: vi.fn().mockResolvedValue(makePeerInfo('alice')),
    });
    mod.initialize(createDeps({ transport }));

    const result = await mod.resolvePeerNametag(PEER_PUBKEY);
    expect(result).toBe('alice');
    expect(transport.resolveTransportPubkeyInfo).toHaveBeenCalledWith(PEER_PUBKEY);
  });

  it('should return undefined when transport does not support resolveTransportPubkeyInfo', async () => {
    const transport = createMockTransport();
    // Ensure resolveTransportPubkeyInfo is not defined
    delete (transport as Record<string, unknown>).resolveTransportPubkeyInfo;
    mod.initialize(createDeps({ transport }));

    const result = await mod.resolvePeerNametag(PEER_PUBKEY);
    expect(result).toBeUndefined();
  });

  it('should return undefined when peer has no nametag', async () => {
    const transport = createMockTransport({
      resolveTransportPubkeyInfo: vi.fn().mockResolvedValue(makePeerInfo(undefined)),
    });
    mod.initialize(createDeps({ transport }));

    const result = await mod.resolvePeerNametag(PEER_PUBKEY);
    expect(result).toBeUndefined();
  });

  it('should return undefined when resolveTransportPubkeyInfo returns null', async () => {
    const transport = createMockTransport({
      resolveTransportPubkeyInfo: vi.fn().mockResolvedValue(null),
    });
    mod.initialize(createDeps({ transport }));

    const result = await mod.resolvePeerNametag(PEER_PUBKEY);
    expect(result).toBeUndefined();
  });

  it('should return undefined when resolveTransportPubkeyInfo throws', async () => {
    const transport = createMockTransport({
      resolveTransportPubkeyInfo: vi.fn().mockRejectedValue(new Error('Network error')),
    });
    mod.initialize(createDeps({ transport }));

    const result = await mod.resolvePeerNametag(PEER_PUBKEY);
    expect(result).toBeUndefined();
  });

  it('should return undefined when module is not initialized', async () => {
    // Do not call initialize — deps is null
    const result = await mod.resolvePeerNametag(PEER_PUBKEY);
    expect(result).toBeUndefined();
  });
});
