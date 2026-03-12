/**
 * Tests for CommunicationsModule `communications:ready` event emission
 *
 * Covers:
 * - emits `communications:ready` when transport `onChatReady` fires
 * - reports correct conversationCount in event payload
 * - does not emit if transport lacks `onChatReady`
 * - fires immediately if EOSE already occurred before initialize()
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommunicationsModule } from '../../../modules/communications/CommunicationsModule';
import type { CommunicationsModuleDependencies } from '../../../modules/communications/CommunicationsModule';
import type { TransportProvider } from '../../../transport';
import type { StorageProvider } from '../../../storage';
import type { FullIdentity } from '../../../types';
import { STORAGE_KEYS_ADDRESS } from '../../../constants';

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
const PEER_A_PUBKEY = '02' + 'b'.repeat(64);
const PEER_B_PUBKEY = '02' + 'c'.repeat(64);

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

// =============================================================================
// Tests
// =============================================================================

describe('CommunicationsModule — communications:ready event', () => {
  let mod: CommunicationsModule;

  beforeEach(() => {
    mod = new CommunicationsModule();
  });

  it('should emit communications:ready when onChatReady fires', () => {
    let capturedHandler: (() => void) | null = null;
    const transport = createMockTransport({
      onChatReady: vi.fn().mockImplementation((handler: () => void) => {
        capturedHandler = handler;
        return () => {};
      }),
    });

    const deps = createDeps({ transport });
    mod.initialize(deps);

    expect(capturedHandler).not.toBeNull();

    // Simulate EOSE
    capturedHandler!();

    expect(deps.emitEvent).toHaveBeenCalledWith('communications:ready', {
      conversationCount: 0,
    });
  });

  it('should report correct conversationCount with loaded messages', async () => {
    let capturedHandler: (() => void) | null = null;
    const transport = createMockTransport({
      onChatReady: vi.fn().mockImplementation((handler: () => void) => {
        capturedHandler = handler;
        return () => {};
      }),
    });

    const messages = [
      { id: 'm1', senderPubkey: PEER_A_PUBKEY, recipientPubkey: MY_PUBKEY, content: 'hi', timestamp: 1000, isRead: false },
      { id: 'm2', senderPubkey: MY_PUBKEY, recipientPubkey: PEER_A_PUBKEY, content: 'hey', timestamp: 2000, isRead: false },
      { id: 'm3', senderPubkey: PEER_B_PUBKEY, recipientPubkey: MY_PUBKEY, content: 'yo', timestamp: 3000, isRead: false },
    ];

    const storage = createMockStorage();
    (storage.get as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === STORAGE_KEYS_ADDRESS.MESSAGES) return Promise.resolve(JSON.stringify(messages));
      return Promise.resolve(null);
    });

    const deps = createDeps({ transport, storage });
    mod.initialize(deps);
    await mod.load();

    // Fire EOSE after messages are loaded
    capturedHandler!();

    expect(deps.emitEvent).toHaveBeenCalledWith('communications:ready', {
      conversationCount: 2, // PEER_A and PEER_B
    });
  });

  it('should not fail if transport lacks onChatReady', () => {
    const transport = createMockTransport();
    // onChatReady is not defined on this transport
    expect(transport.onChatReady).toBeUndefined();

    const deps = createDeps({ transport });

    // Should not throw
    expect(() => mod.initialize(deps)).not.toThrow();
    expect(deps.emitEvent).not.toHaveBeenCalledWith('communications:ready', expect.anything());
  });

  it('should handle onChatReady firing immediately (EOSE already received)', () => {
    // Transport that calls handler synchronously (simulates EOSE already fired)
    const transport = createMockTransport({
      onChatReady: vi.fn().mockImplementation((handler: () => void) => {
        handler(); // Call immediately
        return () => {};
      }),
    });

    const deps = createDeps({ transport });
    mod.initialize(deps);

    expect(deps.emitEvent).toHaveBeenCalledWith('communications:ready', {
      conversationCount: 0,
    });
  });

  it('should only register onChatReady once per initialize call', () => {
    const onChatReady = vi.fn().mockReturnValue(() => {});
    const transport = createMockTransport({ onChatReady });

    const deps = createDeps({ transport });
    mod.initialize(deps);

    expect(onChatReady).toHaveBeenCalledTimes(1);
  });
});
