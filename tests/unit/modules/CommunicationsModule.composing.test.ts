/**
 * Tests for CommunicationsModule composing indicator functionality
 *
 * Covers:
 * - sendComposingIndicator() sends via transport
 * - onComposingIndicator() handler receives indicators
 * - Composing indicators routed to composing handlers, not message handlers
 * - Message buffering in NostrTransportProvider
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommunicationsModule } from '../../../modules/communications/CommunicationsModule';
import type { CommunicationsModuleDependencies } from '../../../modules/communications/CommunicationsModule';
import type { TransportProvider, IncomingMessage } from '../../../transport';
import type { StorageProvider } from '../../../storage';
import type { FullIdentity, ComposingIndicator } from '../../../types';

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

function createMockIdentity(): FullIdentity {
  return {
    privateKey: '0'.repeat(64),
    chainPubkey: '02' + 'a'.repeat(64),
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

describe('CommunicationsModule - Composing Indicators', () => {
  let comms: CommunicationsModule;
  let deps: CommunicationsModuleDependencies;

  beforeEach(() => {
    comms = new CommunicationsModule();
    deps = createDeps();
  });

  // ---------------------------------------------------------------------------
  // sendComposingIndicator
  // ---------------------------------------------------------------------------

  describe('sendComposingIndicator()', () => {
    it('sends a composing indicator via transport.sendComposingIndicator', async () => {
      const transport = createMockTransport({
        sendComposingIndicator: vi.fn().mockResolvedValue(undefined),
      });
      deps = createDeps({ transport });
      comms.initialize(deps);

      await comms.sendComposingIndicator('recipient-pubkey-hex');

      expect(transport.sendComposingIndicator).toHaveBeenCalledOnce();
      const [recipientArg, contentArg] = (transport.sendComposingIndicator as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(recipientArg).toBe('recipient-pubkey-hex');

      const parsed = JSON.parse(contentArg);
      expect(parsed.senderNametag).toBe('testuser');
      expect(parsed.expiresIn).toBe(30000);
      // No "type" field — discrimination is by event kind, not content
      expect(parsed.type).toBeUndefined();
    });

    it('resolves @nametag before sending', async () => {
      const transport = createMockTransport({
        resolveNametag: vi.fn().mockResolvedValue('resolved-pubkey-123'),
        sendComposingIndicator: vi.fn().mockResolvedValue(undefined),
      });
      deps = createDeps({ transport });
      comms.initialize(deps);

      await comms.sendComposingIndicator('@alice');

      expect(transport.resolveNametag).toHaveBeenCalledWith('alice');
      expect(transport.sendComposingIndicator).toHaveBeenCalledWith(
        'resolved-pubkey-123',
        expect.any(String),
      );
    });

    it('throws if module not initialized', async () => {
      await expect(comms.sendComposingIndicator('pubkey')).rejects.toThrow('not initialized');
    });
  });

  // ---------------------------------------------------------------------------
  // onComposingIndicator
  // ---------------------------------------------------------------------------

  describe('onComposingIndicator()', () => {
    it('receives composing indicators from transport', () => {
      // Capture the handler that CommunicationsModule registers with transport
      let capturedComposingHandler: ((indicator: ComposingIndicator) => void) | null = null;
      const transport = createMockTransport({
        onComposing: vi.fn().mockImplementation((handler: (indicator: ComposingIndicator) => void) => {
          capturedComposingHandler = handler;
          return () => {};
        }),
      });
      deps = createDeps({ transport });
      comms.initialize(deps);

      // Register a handler on the comms module
      const handler = vi.fn();
      comms.onComposingIndicator(handler);

      // Simulate transport delivering a composing indicator
      expect(capturedComposingHandler).not.toBeNull();
      capturedComposingHandler!({
        senderPubkey: 'sender-pubkey-abc',
        senderNametag: 'alice',
        expiresIn: 30000,
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith({
        senderPubkey: 'sender-pubkey-abc',
        senderNametag: 'alice',
        expiresIn: 30000,
      });
    });

    it('emits composing:started event', () => {
      let capturedComposingHandler: ((indicator: ComposingIndicator) => void) | null = null;
      const transport = createMockTransport({
        onComposing: vi.fn().mockImplementation((handler: (indicator: ComposingIndicator) => void) => {
          capturedComposingHandler = handler;
          return () => {};
        }),
      });
      const emitEvent = vi.fn();
      deps = createDeps({ transport, emitEvent });
      comms.initialize(deps);

      capturedComposingHandler!({
        senderPubkey: 'sender-pubkey',
        expiresIn: 15000,
      });

      expect(emitEvent).toHaveBeenCalledWith('composing:started', {
        senderPubkey: 'sender-pubkey',
        senderNametag: undefined,
        expiresIn: 15000,
      });
    });

    it('unsubscribe removes the handler', () => {
      let capturedComposingHandler: ((indicator: ComposingIndicator) => void) | null = null;
      const transport = createMockTransport({
        onComposing: vi.fn().mockImplementation((handler: (indicator: ComposingIndicator) => void) => {
          capturedComposingHandler = handler;
          return () => {};
        }),
      });
      deps = createDeps({ transport });
      comms.initialize(deps);

      const handler = vi.fn();
      const unsubscribe = comms.onComposingIndicator(handler);

      // Deliver one indicator
      capturedComposingHandler!({ senderPubkey: 'a', expiresIn: 30000 });
      expect(handler).toHaveBeenCalledOnce();

      // Unsubscribe and deliver another
      unsubscribe();
      capturedComposingHandler!({ senderPubkey: 'b', expiresIn: 30000 });
      expect(handler).toHaveBeenCalledOnce(); // still 1
    });
  });

  // ---------------------------------------------------------------------------
  // Routing: composing indicators vs regular messages
  // ---------------------------------------------------------------------------

  describe('routing', () => {
    it('does not route composing indicators to DM handlers', () => {
      let capturedComposingHandler: ((indicator: ComposingIndicator) => void) | null = null;
      const transport = createMockTransport({
        onComposing: vi.fn().mockImplementation((handler: (indicator: ComposingIndicator) => void) => {
          capturedComposingHandler = handler;
          return () => {};
        }),
      });
      deps = createDeps({ transport });
      comms.initialize(deps);

      const dmHandler = vi.fn();
      comms.onDirectMessage(dmHandler);

      // Deliver a composing indicator via the composing path
      capturedComposingHandler!({ senderPubkey: 'abc', senderNametag: 'alice', expiresIn: 30000 });

      expect(dmHandler).not.toHaveBeenCalled();
    });

    it('does not route regular messages to composing handlers', () => {
      let capturedMessageHandler: ((msg: IncomingMessage) => void) | null = null;
      const transport = createMockTransport({
        onMessage: vi.fn().mockImplementation((handler: (msg: IncomingMessage) => void) => {
          capturedMessageHandler = handler;
          return () => {};
        }),
        onComposing: vi.fn().mockReturnValue(() => {}),
      });
      deps = createDeps({ transport });
      comms.initialize(deps);

      const composingHandler = vi.fn();
      comms.onComposingIndicator(composingHandler);

      // Deliver a regular message
      capturedMessageHandler!({
        id: 'msg-1',
        senderTransportPubkey: 'sender-123',
        content: 'hello',
        timestamp: Date.now(),
        encrypted: true,
      });

      expect(composingHandler).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('works without onComposing support in transport', () => {
      // Transport without onComposing (older implementation)
      const transport = createMockTransport();
      // onComposing is not defined by default in createMockTransport
      deps = createDeps({ transport });

      // Should not throw
      expect(() => comms.initialize(deps)).not.toThrow();
    });

    it('cleanup on destroy unsubscribes composing handler', () => {
      const unsubComposing = vi.fn();
      const transport = createMockTransport({
        onComposing: vi.fn().mockReturnValue(unsubComposing),
      });
      deps = createDeps({ transport });
      comms.initialize(deps);

      comms.destroy();

      expect(unsubComposing).toHaveBeenCalledOnce();
    });
  });
});
