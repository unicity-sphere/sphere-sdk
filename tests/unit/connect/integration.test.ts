import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectHost } from '../../../connect/host/ConnectHost';
import { ConnectClient } from '../../../connect/client/ConnectClient';
import type { ConnectTransport, SphereConnectMessage } from '../../../connect/types';
import { PERMISSION_SCOPES } from '../../../connect/permissions';
import { ERROR_CODES, RPC_METHODS, INTENT_ACTIONS } from '../../../connect/protocol';
import type { PermissionScope } from '../../../connect/permissions';

// =============================================================================
// Mock Transport: connects two sides in-memory
// =============================================================================

function createMockTransportPair(): { host: ConnectTransport; client: ConnectTransport } {
  const hostHandlers = new Set<(msg: SphereConnectMessage) => void>();
  const clientHandlers = new Set<(msg: SphereConnectMessage) => void>();

  const host: ConnectTransport = {
    send(msg) {
      // Host sends → client receives
      for (const h of clientHandlers) h(msg);
    },
    onMessage(handler) {
      hostHandlers.add(handler);
      return () => hostHandlers.delete(handler);
    },
    destroy() { hostHandlers.clear(); },
  };

  const client: ConnectTransport = {
    send(msg) {
      // Client sends → host receives
      for (const h of hostHandlers) h(msg);
    },
    onMessage(handler) {
      clientHandlers.add(handler);
      return () => clientHandlers.delete(handler);
    },
    destroy() { clientHandlers.clear(); },
  };

  return { host, client };
}

// =============================================================================
// Mock Sphere
// =============================================================================

function createMockSphere() {
  const eventHandlers = new Map<string, Set<(data: unknown) => void>>();

  return {
    identity: {
      chainPubkey: '02abc123',
      l1Address: 'alpha1test',
      directAddress: 'DIRECT://test',
      nametag: 'alice',
    },
    payments: {
      getBalance: vi.fn().mockReturnValue([{ coinId: 'UCT', totalAmount: '1000000' }]),
      getAssets: vi.fn().mockResolvedValue([{ coinId: 'UCT', symbol: 'UCT', totalAmount: '1000000' }]),
      getFiatBalance: vi.fn().mockResolvedValue(10.5),
      getTokens: vi.fn().mockReturnValue([
        { id: 'tok1', coinId: 'UCT', amount: '1000000', sdkData: { internal: true } },
      ]),
      getHistory: vi.fn().mockReturnValue([
        { type: 'sent', amount: '500', coinId: 'UCT', timestamp: 1700000000 },
      ]),
      l1: {
        getBalance: vi.fn().mockResolvedValue({ confirmed: '100000', total: '100000' }),
        getHistory: vi.fn().mockResolvedValue([]),
      },
    },
    resolve: vi.fn().mockResolvedValue({
      nametag: 'bob',
      chainPubkey: '03def456',
      l1Address: 'alpha1bob',
      directAddress: 'DIRECT://bob',
      transportPubkey: 'ff00ff',
    }),
    on: vi.fn((type: string, handler: (data: unknown) => void) => {
      if (!eventHandlers.has(type)) eventHandlers.set(type, new Set());
      eventHandlers.get(type)!.add(handler);
      return () => eventHandlers.get(type)?.delete(handler);
    }),
    // Test helper to emit events
    _emit(type: string, data: unknown) {
      for (const h of eventHandlers.get(type) ?? []) h(data);
    },
    // Optional communications module (set by tests that need DM support)
    communications: undefined as unknown,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('Sphere Connect Integration', () => {
  let transports: ReturnType<typeof createMockTransportPair>;
  let mockSphere: ReturnType<typeof createMockSphere>;
  let host: ConnectHost;
  let client: ConnectClient;

  const defaultDapp = { name: 'Test dApp', url: 'https://test.app' };

  beforeEach(() => {
    transports = createMockTransportPair();
    mockSphere = createMockSphere();
  });

  function createHost(overrides?: Partial<Parameters<typeof ConnectHost['prototype']['constructor']>[0]>) {
    host = new ConnectHost({
      sphere: mockSphere,
      transport: transports.host,
      onConnectionRequest: vi.fn().mockResolvedValue({
        approved: true,
        grantedPermissions: Object.values(PERMISSION_SCOPES),
      }),
      onIntent: vi.fn().mockResolvedValue({ result: { success: true } }),
      ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    return host;
  }

  function createClient(overrides?: Partial<Parameters<typeof ConnectClient['prototype']['constructor']>[0]>) {
    client = new ConnectClient({
      transport: transports.client,
      dapp: defaultDapp,
      ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    return client;
  }

  // ===========================================================================
  // Handshake
  // ===========================================================================

  describe('Handshake', () => {
    it('connects successfully with all permissions', async () => {
      createHost();
      createClient();

      const result = await client.connect();

      expect(result.sessionId).toBeDefined();
      expect(result.identity.chainPubkey).toBe('02abc123');
      expect(result.identity.nametag).toBe('alice');
      expect(result.permissions).toContain(PERMISSION_SCOPES.IDENTITY_READ);
      expect(client.isConnected).toBe(true);
    });

    it('rejects connection when wallet denies', async () => {
      createHost({
        onConnectionRequest: vi.fn().mockResolvedValue({
          approved: false,
          grantedPermissions: [],
        }),
      });
      createClient();

      await expect(client.connect()).rejects.toThrow('Connection rejected');
      expect(client.isConnected).toBe(false);
    });

    it('grants only requested permissions', async () => {
      createHost({
        onConnectionRequest: vi.fn().mockResolvedValue({
          approved: true,
          grantedPermissions: [PERMISSION_SCOPES.BALANCE_READ] as PermissionScope[],
        }),
      });
      createClient({ permissions: [PERMISSION_SCOPES.BALANCE_READ] });

      const result = await client.connect();

      expect(result.permissions).toContain(PERMISSION_SCOPES.IDENTITY_READ); // always granted
      expect(result.permissions).toContain(PERMISSION_SCOPES.BALANCE_READ);
    });
  });

  // ===========================================================================
  // Query Methods
  // ===========================================================================

  describe('Query', () => {
    beforeEach(async () => {
      createHost();
      createClient();
      await client.connect();
    });

    it('gets identity', async () => {
      const identity = await client.query(RPC_METHODS.GET_IDENTITY);
      expect(identity).toEqual({
        chainPubkey: '02abc123',
        l1Address: 'alpha1test',
        directAddress: 'DIRECT://test',
        nametag: 'alice',
      });
    });

    it('gets balance', async () => {
      const balance = await client.query(RPC_METHODS.GET_BALANCE, { coinId: 'UCT' });
      expect(mockSphere.payments.getBalance).toHaveBeenCalledWith('UCT');
      expect(balance).toEqual([{ coinId: 'UCT', totalAmount: '1000000' }]);
    });

    it('gets assets', async () => {
      const _assets = await client.query(RPC_METHODS.GET_ASSETS);
      expect(mockSphere.payments.getAssets).toHaveBeenCalled();
    });

    it('gets fiat balance', async () => {
      const result = await client.query<{ fiatBalance: number }>(RPC_METHODS.GET_FIAT_BALANCE);
      expect(result.fiatBalance).toBe(10.5);
    });

    it('gets tokens with sdkData stripped', async () => {
      const tokens = await client.query<{ id: string; sdkData?: unknown }[]>(RPC_METHODS.GET_TOKENS);
      expect(tokens).toHaveLength(1);
      expect(tokens[0].id).toBe('tok1');
      expect(tokens[0].sdkData).toBeUndefined();
    });

    it('gets history', async () => {
      const history = await client.query(RPC_METHODS.GET_HISTORY);
      expect(history).toHaveLength(1);
    });

    it('gets L1 balance', async () => {
      const balance = await client.query(RPC_METHODS.L1_GET_BALANCE);
      expect(balance).toEqual({ confirmed: '100000', total: '100000' });
    });

    it('resolves nametag', async () => {
      const peer = await client.query(RPC_METHODS.RESOLVE, { identifier: '@bob' });
      expect(mockSphere.resolve).toHaveBeenCalledWith('@bob');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((peer as any).nametag).toBe('bob');
    });
  });

  // ===========================================================================
  // Intents
  // ===========================================================================

  describe('Intent', () => {
    beforeEach(async () => {
      createHost();
      createClient();
      await client.connect();
    });

    it('sends a transfer intent', async () => {
      const result = await client.intent(INTENT_ACTIONS.SEND, {
        to: '@bob',
        amount: '1000',
        coinId: 'UCT',
      });

      expect(result).toEqual({ success: true });
    });

    it('sends a DM intent', async () => {
      host.destroy();
      transports = createMockTransportPair();
      const onIntent = vi.fn().mockResolvedValue({
        result: { sent: true, messageId: 'msg123' },
      });
      createHost({ onIntent });
      createClient();
      await client.connect();

      const result = await client.intent<{ sent: boolean; messageId: string }>(INTENT_ACTIONS.DM, {
        to: '@alice',
        message: 'Hello!',
      });

      expect(onIntent).toHaveBeenCalledWith('dm', { to: '@alice', message: 'Hello!' }, expect.any(Object));
      expect(result.sent).toBe(true);
      expect(result.messageId).toBe('msg123');
    });

    it('handles user rejection', async () => {
      host.destroy();
      transports = createMockTransportPair();
      createHost({
        onIntent: vi.fn().mockResolvedValue({
          error: { code: ERROR_CODES.USER_REJECTED, message: 'User rejected' },
        }),
      });
      createClient();
      await client.connect();

      await expect(
        client.intent(INTENT_ACTIONS.SEND, { to: '@bob', amount: '1000', coinId: 'UCT' }),
      ).rejects.toThrow('User rejected');
    });
  });

  // ===========================================================================
  // Events
  // ===========================================================================

  describe('Events', () => {
    beforeEach(async () => {
      createHost();
      createClient();
      await client.connect();
    });

    it('subscribes to and receives events', async () => {
      const handler = vi.fn();
      client.on('transfer:incoming', handler);

      // Wait for subscribe to be processed
      await new Promise((r) => setTimeout(r, 10));

      // Emit event from mock Sphere
      mockSphere._emit('transfer:incoming', { amount: '500', coinId: 'UCT' });

      await new Promise((r) => setTimeout(r, 10));

      expect(handler).toHaveBeenCalledWith({ amount: '500', coinId: 'UCT' });
    });

    it('unsubscribes from events', async () => {
      const handler = vi.fn();
      const unsub = client.on('transfer:incoming', handler);

      await new Promise((r) => setTimeout(r, 10));

      unsub();

      await new Promise((r) => setTimeout(r, 10));

      mockSphere._emit('transfer:incoming', { amount: '500' });

      await new Promise((r) => setTimeout(r, 10));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Permission Enforcement
  // ===========================================================================

  describe('Permission Enforcement', () => {
    it('denies query without required permission', async () => {
      createHost({
        onConnectionRequest: vi.fn().mockResolvedValue({
          approved: true,
          grantedPermissions: [PERMISSION_SCOPES.IDENTITY_READ] as PermissionScope[],
        }),
      });
      createClient({ permissions: [PERMISSION_SCOPES.IDENTITY_READ] });
      await client.connect();

      await expect(client.query(RPC_METHODS.GET_BALANCE)).rejects.toThrow('Permission denied');
    });

    it('denies intent without required permission', async () => {
      createHost({
        onConnectionRequest: vi.fn().mockResolvedValue({
          approved: true,
          grantedPermissions: [PERMISSION_SCOPES.IDENTITY_READ] as PermissionScope[],
        }),
      });
      createClient({ permissions: [PERMISSION_SCOPES.IDENTITY_READ] });
      await client.connect();

      await expect(
        client.intent(INTENT_ACTIONS.SEND, { to: '@bob', amount: '1', coinId: 'UCT' }),
      ).rejects.toThrow('Permission denied');
    });
  });

  // ===========================================================================
  // Session Management
  // ===========================================================================

  describe('Session Management', () => {
    it('denies requests without connection', async () => {
      createHost();
      createClient();
      // Don't connect

      await expect(client.query(RPC_METHODS.GET_BALANCE)).rejects.toThrow('Not connected');
    });

    it('disconnect cleans up state', async () => {
      createHost();
      createClient();
      await client.connect();

      expect(client.isConnected).toBe(true);
      await client.disconnect();
      expect(client.isConnected).toBe(false);
    });

    it('host can revoke session', async () => {
      createHost();
      createClient();
      await client.connect();

      expect(host.getSession()).not.toBeNull();
      host.revokeSession();
      expect(host.getSession()).toBeNull();
    });

    it('session expiry rejects requests', async () => {
      createHost({ sessionTtlMs: 1 }); // 1ms TTL
      createClient();
      await client.connect();

      // Wait for session to expire
      await new Promise((r) => setTimeout(r, 10));

      await expect(client.query(RPC_METHODS.GET_IDENTITY)).rejects.toThrow('Session expired');
    });
  });

  // ===========================================================================
  // Rate Limiting
  // ===========================================================================

  describe('Rate Limiting', () => {
    it('rejects when rate limit exceeded', async () => {
      createHost({ maxRequestsPerSecond: 2 });
      createClient();
      await client.connect();

      // First two should succeed
      await client.query(RPC_METHODS.GET_IDENTITY);
      await client.query(RPC_METHODS.GET_IDENTITY);

      // Third should be rate limited
      await expect(client.query(RPC_METHODS.GET_IDENTITY)).rejects.toThrow('Too many requests');
    });
  });

  // ===========================================================================
  // GET_CONVERSATIONS nametag fallback
  // ===========================================================================

  describe('GET_CONVERSATIONS nametag resolution', () => {
    const MY_PK = '02abc123';
    const PEER_PK = '02peer456';

    function addCommunications(
      messages: Map<string, Array<{ id: string; senderPubkey: string; senderNametag?: string; recipientPubkey: string; recipientNametag?: string; content: string; timestamp: number; isRead: boolean }>>,
      resolvePeerNametag?: (pubkey: string) => Promise<string | undefined>,
    ) {
      mockSphere.communications = {
        getConversations: vi.fn().mockReturnValue(messages),
        getConversationPage: vi.fn().mockReturnValue({ messages: [], hasMore: false, oldestTimestamp: null }),
        getUnreadCount: vi.fn().mockReturnValue(0),
        markAsRead: vi.fn().mockResolvedValue(undefined),
        sendDM: vi.fn().mockResolvedValue({ id: 'new', senderPubkey: MY_PK, recipientPubkey: PEER_PK, content: 'hi', timestamp: Date.now(), isRead: false }),
        resolvePeerNametag: resolvePeerNametag ?? vi.fn().mockResolvedValue(undefined),
      };
    }

    it('returns peerNametag from messages when available', async () => {
      const messages = new Map([
        [PEER_PK, [
          { id: 'm1', senderPubkey: PEER_PK, senderNametag: 'bob', recipientPubkey: MY_PK, content: 'hi', timestamp: 1000, isRead: false },
        ]],
      ]);
      addCommunications(messages);

      createHost();
      createClient();
      await client.connect();

      const result = await client.query(RPC_METHODS.GET_CONVERSATIONS) as Array<{ peerPubkey: string; peerNametag?: string }>;
      expect(result).toHaveLength(1);
      expect(result[0].peerNametag).toBe('bob');
    });

    it('resolves peerNametag via transport fallback when missing from messages', async () => {
      const messages = new Map([
        [PEER_PK, [
          { id: 'm1', senderPubkey: PEER_PK, recipientPubkey: MY_PK, content: 'hi', timestamp: 1000, isRead: false },
        ]],
      ]);
      addCommunications(messages, vi.fn().mockResolvedValue('bob'));

      createHost();
      createClient();
      await client.connect();

      const result = await client.query(RPC_METHODS.GET_CONVERSATIONS) as Array<{ peerPubkey: string; peerNametag?: string }>;
      expect(result).toHaveLength(1);
      expect(result[0].peerNametag).toBe('bob');
    });

    it('leaves peerNametag undefined when both messages and transport have no nametag', async () => {
      const messages = new Map([
        [PEER_PK, [
          { id: 'm1', senderPubkey: PEER_PK, recipientPubkey: MY_PK, content: 'hi', timestamp: 1000, isRead: false },
        ]],
      ]);
      addCommunications(messages, vi.fn().mockResolvedValue(undefined));

      createHost();
      createClient();
      await client.connect();

      const result = await client.query(RPC_METHODS.GET_CONVERSATIONS) as Array<{ peerPubkey: string; peerNametag?: string }>;
      expect(result).toHaveLength(1);
      expect(result[0].peerNametag).toBeUndefined();
    });

    it('does not call resolvePeerNametag when nametag already in messages', async () => {
      const resolveFn = vi.fn().mockResolvedValue('shouldnt-be-called');
      const messages = new Map([
        [PEER_PK, [
          { id: 'm1', senderPubkey: PEER_PK, senderNametag: 'bob', recipientPubkey: MY_PK, content: 'hi', timestamp: 1000, isRead: false },
        ]],
      ]);
      addCommunications(messages, resolveFn);

      createHost();
      createClient();
      await client.connect();

      await client.query(RPC_METHODS.GET_CONVERSATIONS);
      expect(resolveFn).not.toHaveBeenCalled();
    });

    it('handles resolvePeerNametag errors gracefully', async () => {
      const messages = new Map([
        [PEER_PK, [
          { id: 'm1', senderPubkey: PEER_PK, recipientPubkey: MY_PK, content: 'hi', timestamp: 1000, isRead: false },
        ]],
      ]);
      addCommunications(messages, vi.fn().mockRejectedValue(new Error('Network error')));

      createHost();
      createClient();
      await client.connect();

      const result = await client.query(RPC_METHODS.GET_CONVERSATIONS) as Array<{ peerPubkey: string; peerNametag?: string }>;
      expect(result).toHaveLength(1);
      expect(result[0].peerNametag).toBeUndefined();
    });
  });
});
