/**
 * Tests for CommunicationsModule self-message filtering in handleIncomingMessage.
 *
 * Covers the fix for the bug where senderTransportPubkey (32-byte x-only) was
 * compared against chainPubkey (33-byte compressed) — which never matched,
 * letting self-sent messages leak through to dmHandlers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommunicationsModule } from '../../../modules/communications/CommunicationsModule';
import type { CommunicationsModuleDependencies } from '../../../modules/communications/CommunicationsModule';
import type { TransportProvider, IncomingMessage, MessageHandler } from '../../../transport';
import type { StorageProvider } from '../../../storage';
import type { FullIdentity, DirectMessage } from '../../../types';

// =============================================================================
// Mock Factories
// =============================================================================

const MY_PUBKEY = '02' + 'a'.repeat(64); // 66 hex chars, realistic compressed key
const MY_XONLY = 'a'.repeat(64);          // 64 hex chars, x-only form
const PEER_PUBKEY = 'b'.repeat(64);       // different peer

function createMockTransport(onMessageImpl?: (handler: MessageHandler) => () => void): TransportProvider {
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
    onMessage: vi.fn().mockImplementation(onMessageImpl ?? (() => () => {})),
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

function createMockIdentity(chainPubkey = MY_PUBKEY): FullIdentity {
  return {
    privateKey: '0'.repeat(64),
    chainPubkey,
    l1Address: 'alpha1testaddr',
    directAddress: 'DIRECT://testaddr',
    nametag: 'testuser',
  };
}

function makeIncomingMessage(overrides: Partial<IncomingMessage> & { senderTransportPubkey: string }): IncomingMessage {
  return {
    id: 'msg-' + Math.random().toString(36).slice(2, 8),
    content: 'test message',
    timestamp: Date.now() + 5000, // future to avoid historical filtering
    encrypted: false,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('CommunicationsModule — self-message filtering', () => {
  let mod: CommunicationsModule;
  let messageHandler: MessageHandler | null;
  let emitEvent: ReturnType<typeof vi.fn>;
  let dmHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mod = new CommunicationsModule();
    messageHandler = null;
    emitEvent = vi.fn();
    dmHandler = vi.fn();
  });

  function initModule(chainPubkey = MY_PUBKEY) {
    const transport = createMockTransport((handler) => {
      messageHandler = handler;
      return () => {};
    });

    const deps: CommunicationsModuleDependencies = {
      identity: createMockIdentity(chainPubkey),
      storage: createMockStorage(),
      transport,
      emitEvent,
    };

    mod.initialize(deps);
    mod.onDirectMessage(dmHandler);
  }

  it('should skip message when senderTransportPubkey is x-only form of own chainPubkey', () => {
    initModule(MY_PUBKEY); // "02" + "a"*64

    messageHandler!(makeIncomingMessage({ senderTransportPubkey: MY_XONLY }));

    expect(dmHandler).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalledWith('message:dm', expect.anything());
  });

  it('should skip message when senderTransportPubkey exactly matches chainPubkey', () => {
    initModule(MY_PUBKEY);

    messageHandler!(makeIncomingMessage({ senderTransportPubkey: MY_PUBKEY }));

    expect(dmHandler).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalledWith('message:dm', expect.anything());
  });

  it('should accept message from a different sender', () => {
    initModule(MY_PUBKEY);

    messageHandler!(makeIncomingMessage({ senderTransportPubkey: PEER_PUBKEY }));

    expect(dmHandler).toHaveBeenCalledOnce();
    expect(emitEvent).toHaveBeenCalledWith('message:dm', expect.objectContaining({
      senderPubkey: PEER_PUBKEY,
    }));
  });

  it('should skip x-only self-check for chainPubkey with 03 prefix', () => {
    const cpk03 = '03' + 'c'.repeat(64);
    initModule(cpk03);

    messageHandler!(makeIncomingMessage({ senderTransportPubkey: 'c'.repeat(64) }));

    expect(dmHandler).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalledWith('message:dm', expect.anything());
  });

  it('should not strip prefix from chainPubkey shorter than 66 chars', () => {
    // Short chainPubkey — prefix stripping should NOT fire
    initModule('02abcdef');

    messageHandler!(makeIncomingMessage({ senderTransportPubkey: 'abcdef' }));

    // Should NOT be filtered (short key, not a real compressed pubkey)
    expect(dmHandler).toHaveBeenCalledOnce();
  });

  it('should handle self-wrap before self-skip (self-wrap path takes priority)', () => {
    initModule(MY_PUBKEY);

    // Self-wrap replay: isSelfWrap=true, has recipientTransportPubkey
    messageHandler!(makeIncomingMessage({
      senderTransportPubkey: MY_XONLY,
      isSelfWrap: true,
      recipientTransportPubkey: PEER_PUBKEY,
    }));

    // Self-wrap path emits 'message:dm' as sent-message replay but does NOT call dmHandlers
    expect(dmHandler).not.toHaveBeenCalled();
    expect(emitEvent).toHaveBeenCalledWith('message:dm', expect.objectContaining({
      senderPubkey: MY_PUBKEY, // self-wrap sets senderPubkey to chainPubkey
      recipientPubkey: PEER_PUBKEY,
    }));
  });
});
