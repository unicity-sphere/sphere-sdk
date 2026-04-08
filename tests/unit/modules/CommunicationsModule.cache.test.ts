/**
 * Tests for CommunicationsModule cacheMessages option
 *
 * Covers:
 * - cacheMessages: false skips storing incoming DMs in memory
 * - cacheMessages: false skips save() to storage
 * - cacheMessages: false still fires onDirectMessage handlers
 * - cacheMessages: false still emits message:dm events
 * - sendDM with cacheMessages: false sends but doesn't cache
 * - getConversation/getConversations return empty when caching disabled
 * - getUnreadCount returns 0 when caching disabled
 * - load() is a no-op when caching disabled
 * - read receipts are ignored when caching disabled (no messages to mark)
 * - cacheMessages: true (default) works as before
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommunicationsModule } from '../../../modules/communications/CommunicationsModule';
import type { CommunicationsModuleDependencies } from '../../../modules/communications/CommunicationsModule';
import type { TransportProvider } from '../../../transport';
import type { StorageProvider } from '../../../storage';
import type { FullIdentity, DirectMessage } from '../../../types';
// =============================================================================
// Mock Factories (same as storage tests)
// =============================================================================

function createMockTransport(): TransportProvider {
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
const PEER_PUBKEY_XONLY = 'b'.repeat(64);

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

// Helper: capture the onMessage callback registered during initialize()
function captureOnMessage(transport: TransportProvider): (msg: any) => void {
  return (transport.onMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
}

describe('CommunicationsModule cacheMessages option', () => {
  describe('cacheMessages: false', () => {
    let mod: CommunicationsModule;
    let deps: CommunicationsModuleDependencies;

    beforeEach(() => {
      mod = new CommunicationsModule({ cacheMessages: false });
      deps = createDeps();
      mod.initialize(deps);
    });

    it('does not store incoming DMs in memory', () => {
      const onMsg = captureOnMessage(deps.transport);
      onMsg({
        id: 'msg-1',
        senderTransportPubkey: PEER_PUBKEY,
        content: 'hello',
        timestamp: Date.now(),
      });

      expect(mod.getConversation(PEER_PUBKEY)).toEqual([]);
    });

    it('does not call storage.set on incoming DM', () => {
      const onMsg = captureOnMessage(deps.transport);
      onMsg({
        id: 'msg-1',
        senderTransportPubkey: PEER_PUBKEY,
        content: 'hello',
        timestamp: Date.now(),
      });

      expect(deps.storage.set).not.toHaveBeenCalled();
    });

    it('still fires onDirectMessage handlers', () => {
      const handler = vi.fn();
      mod.onDirectMessage(handler);

      const onMsg = captureOnMessage(deps.transport);
      onMsg({
        id: 'msg-1',
        senderTransportPubkey: PEER_PUBKEY,
        content: 'hello',
        timestamp: Date.now(),
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        id: 'msg-1',
        content: 'hello',
      }));
    });

    it('still emits message:dm event', () => {
      const onMsg = captureOnMessage(deps.transport);
      onMsg({
        id: 'msg-1',
        senderTransportPubkey: PEER_PUBKEY,
        content: 'hello',
        timestamp: Date.now(),
      });

      expect(deps.emitEvent).toHaveBeenCalledWith('message:dm', expect.objectContaining({
        id: 'msg-1',
      }));
    });

    it('sendDM sends via transport but does not cache', async () => {
      const message = await mod.sendDM(PEER_PUBKEY, 'hi');

      expect(deps.transport.sendMessage).toHaveBeenCalledWith(PEER_PUBKEY_XONLY, 'hi');
      expect(message).toMatchObject({ content: 'hi' });
      expect(mod.getConversation(PEER_PUBKEY)).toEqual([]);
      expect(deps.storage.set).not.toHaveBeenCalled();
    });

    it('getConversations returns empty map', () => {
      expect(mod.getConversations().size).toBe(0);
    });

    it('getUnreadCount returns 0', () => {
      expect(mod.getUnreadCount()).toBe(0);
    });

    it('load() does not read from storage', async () => {
      await mod.load();
      expect(deps.storage.get).not.toHaveBeenCalled();
    });
  });

  describe('cacheMessages: true (default)', () => {
    it('stores incoming DMs as before', () => {
      const mod = new CommunicationsModule(); // default config
      const deps = createDeps();
      mod.initialize(deps);

      const onMsg = captureOnMessage(deps.transport);
      onMsg({
        id: 'msg-1',
        senderTransportPubkey: PEER_PUBKEY,
        content: 'hello',
        timestamp: Date.now(),
      });

      expect(mod.getConversation(PEER_PUBKEY).length).toBe(1);
    });
  });
});
