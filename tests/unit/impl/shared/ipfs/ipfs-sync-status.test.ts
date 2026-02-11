import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IpfsStorageProvider } from '../../../../../impl/shared/ipfs/ipfs-storage-provider';
import { InMemoryIpfsStatePersistence } from '../../../../../impl/shared/ipfs/ipfs-state-persistence';
import type { FullIdentity } from '../../../../../types';
import type { StorageEvent } from '../../../../../storage';
import type { IWebSocket, WebSocketFactory } from '../../../../../transport/websocket';
import { WebSocketReadyState } from '../../../../../transport/websocket';

// =============================================================================
// Mocks
// =============================================================================

vi.mock('../../../../../impl/shared/ipfs/ipns-key-derivation', () => ({
  deriveIpnsIdentity: vi.fn().mockResolvedValue({
    keyPair: { type: 'Ed25519', raw: new Uint8Array(32) },
    ipnsName: '12D3KooWTestPeerId',
  }),
  deriveIpnsName: vi.fn().mockResolvedValue('12D3KooWTestPeerId'),
  deriveEd25519KeyMaterial: vi.fn().mockReturnValue(new Uint8Array(32)),
  IPNS_HKDF_INFO: 'ipfs-storage-ed25519-v1',
}));

vi.mock('../../../../../impl/shared/ipfs/ipns-record-manager', () => ({
  createSignedRecord: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  parseRoutingApiResponse: vi.fn(),
  verifySequenceProgression: vi.fn().mockReturnValue(true),
}));

vi.mock('../../../../../impl/shared/ipfs/txf-merge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../impl/shared/ipfs/txf-merge')>();
  return {
    ...actual,
    mergeTxfData: vi.fn(actual.mergeTxfData),
  };
});

// =============================================================================
// Helpers
// =============================================================================

const testIdentity: FullIdentity = {
  privateKey: 'e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35',
  chainPubkey: '0339a36013301597daef41fbe593a02cc513d0b55527ec2df1050e2e8ff49c85c2',
  l1Address: 'alpha1test',
  directAddress: 'DIRECT://test',
};

function createMockWebSocket(): IWebSocket & {
  simulateOpen: () => void;
  simulateMessage: (data: string) => void;
  simulateClose: () => void;
  simulateError: () => void;
} {
  const ws: IWebSocket & {
    readyState: number;
    simulateOpen: () => void;
    simulateMessage: (data: string) => void;
    simulateClose: () => void;
    simulateError: () => void;
  } = {
    readyState: WebSocketReadyState.CONNECTING,
    send: vi.fn(),
    close: vi.fn(),
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    simulateOpen() {
      this.readyState = WebSocketReadyState.OPEN;
      this.onopen?.({});
    },
    simulateMessage(data: string) {
      this.onmessage?.({ data });
    },
    simulateClose() {
      this.readyState = WebSocketReadyState.CLOSED;
      this.onclose?.({});
    },
    simulateError() {
      this.onerror?.({});
    },
  };
  return ws;
}

async function initProvider(
  config?: Record<string, unknown>,
  persistence?: InMemoryIpfsStatePersistence,
): Promise<IpfsStorageProvider> {
  const p = new IpfsStorageProvider(
    { gateways: ['https://gw1.example.com'], flushDebounceMs: 100, ...config } as any,
    persistence ?? new InMemoryIpfsStatePersistence(),
  );

  vi.mocked(fetch).mockResolvedValue(
    new Response(JSON.stringify({ Version: '0.20.0' }), { status: 200 }),
  );

  p.setIdentity(testIdentity);
  await p.initialize();
  return p;
}

// =============================================================================
// Tests
// =============================================================================

describe('IPFS Sync Status', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Push-based sync integration (subscription client inside provider)
  // ---------------------------------------------------------------------------

  describe('push-based subscription integration', () => {
    let mockWs: ReturnType<typeof createMockWebSocket>;
    let wsFactory: WebSocketFactory;

    beforeEach(() => {
      mockWs = createMockWebSocket();
      wsFactory = vi.fn().mockReturnValue(mockWs);
    });

    it('should create subscription client when createWebSocket is provided', async () => {
      const provider = await initProvider({ createWebSocket: wsFactory });

      // WS factory should have been called with derived URL
      expect(wsFactory).toHaveBeenCalledWith('wss://gw1.example.com/ws/ipns');

      await provider.shutdown();
    });

    it('should use explicit wsUrl when provided', async () => {
      const provider = await initProvider({
        createWebSocket: wsFactory,
        wsUrl: 'wss://custom.example.com/ws/ipns',
      });

      expect(wsFactory).toHaveBeenCalledWith('wss://custom.example.com/ws/ipns');

      await provider.shutdown();
    });

    it('should emit storage:remote-updated on push update', async () => {
      const provider = await initProvider({ createWebSocket: wsFactory });

      const events: StorageEvent[] = [];
      provider.onEvent!((event) => events.push(event));

      // Simulate WS open and receiving an update
      mockWs.simulateOpen();
      mockWs.simulateMessage(JSON.stringify({
        type: 'update',
        name: '12D3KooWTestPeerId',
        sequence: 7,
        cid: 'bafyPushCid',
        timestamp: '2026-02-11T00:00:00Z',
      }));

      const remoteEvents = events.filter((e) => e.type === 'storage:remote-updated');
      expect(remoteEvents).toHaveLength(1);
      expect(remoteEvents[0].data).toEqual({
        name: '12D3KooWTestPeerId',
        sequence: 7,
        cid: 'bafyPushCid',
      });

      await provider.shutdown();
    });

    it('should not emit storage:remote-updated for different IPNS name', async () => {
      const provider = await initProvider({ createWebSocket: wsFactory });

      const events: StorageEvent[] = [];
      provider.onEvent!((event) => events.push(event));

      mockWs.simulateOpen();
      mockWs.simulateMessage(JSON.stringify({
        type: 'update',
        name: '12D3KooWOtherPeer',
        sequence: 1,
        cid: 'bafyOther',
        timestamp: '2026-02-11T00:00:00Z',
      }));

      const remoteEvents = events.filter((e) => e.type === 'storage:remote-updated');
      expect(remoteEvents).toHaveLength(0);

      await provider.shutdown();
    });

    it('should subscribe to own IPNS name after WS connect', async () => {
      const provider = await initProvider({ createWebSocket: wsFactory });

      mockWs.simulateOpen();

      // Should have sent subscribe message for own IPNS name
      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ action: 'subscribe', names: ['12D3KooWTestPeerId'] }),
      );

      await provider.shutdown();
    });

    it('should disconnect subscription client on shutdown', async () => {
      const provider = await initProvider({ createWebSocket: wsFactory });
      mockWs.simulateOpen();

      await provider.shutdown();

      expect(mockWs.close).toHaveBeenCalled();
    });

    it('should not create subscription client when createWebSocket is absent', async () => {
      const factory = vi.fn();
      const provider = await initProvider({});

      // No WS factory called
      expect(factory).not.toHaveBeenCalled();

      await provider.shutdown();
    });

    it('should derive wss:// from https:// gateway', async () => {
      const provider = await initProvider({ createWebSocket: wsFactory });
      expect(wsFactory).toHaveBeenCalledWith('wss://gw1.example.com/ws/ipns');
      await provider.shutdown();
    });

    it('should derive ws:// from http:// gateway', async () => {
      const p = new IpfsStorageProvider(
        { gateways: ['http://localhost:5001'], createWebSocket: wsFactory } as any,
        new InMemoryIpfsStatePersistence(),
      );
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ Version: '0.20.0' }), { status: 200 }),
      );
      p.setIdentity(testIdentity);
      await p.initialize();

      expect(wsFactory).toHaveBeenCalledWith('ws://localhost:5001/ws/ipns');

      await p.shutdown();
    });
  });

  // ---------------------------------------------------------------------------
  // Fallback polling integration
  // ---------------------------------------------------------------------------

  describe('fallback polling integration', () => {
    let mockWs: ReturnType<typeof createMockWebSocket>;
    let wsFactory: WebSocketFactory;

    beforeEach(() => {
      mockWs = createMockWebSocket();
      wsFactory = vi.fn().mockReturnValue(mockWs);
    });

    it('should emit storage:remote-updated when poll detects new sequence', async () => {
      const provider = await initProvider({
        createWebSocket: wsFactory,
        fallbackPollIntervalMs: 30000,
      });

      // Let the immediate poll (fire-and-forget during init) settle
      await vi.advanceTimersByTimeAsync(0);

      const events: StorageEvent[] = [];
      provider.onEvent!((event) => events.push(event));

      // Don't open WS — fallback polling should activate on interval
      // Mock the IPNS resolution for the next interval poll
      const { parseRoutingApiResponse } = await import(
        '../../../../../impl/shared/ipfs/ipns-record-manager'
      );
      vi.mocked(parseRoutingApiResponse).mockResolvedValueOnce({
        cid: 'bafyPolledCid',
        sequence: 3n,
        recordData: new Uint8Array([1, 2, 3]),
      });
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('routing-response', { status: 200 }),
      );

      // Advance timer to trigger the interval poll (not the immediate one)
      await vi.advanceTimersByTimeAsync(30000);

      const remoteEvents = events.filter((e) => e.type === 'storage:remote-updated');
      expect(remoteEvents).toHaveLength(1);
      expect(remoteEvents[0].data).toEqual({
        name: '12D3KooWTestPeerId',
        sequence: 3,
        cid: 'bafyPolledCid',
      });

      await provider.shutdown();
    });

    it('should not emit event when poll sees same sequence', async () => {
      const provider = await initProvider({
        createWebSocket: wsFactory,
        fallbackPollIntervalMs: 30000,
      });

      // Let the immediate poll (fire-and-forget during init) settle
      await vi.advanceTimersByTimeAsync(0);

      const events: StorageEvent[] = [];
      provider.onEvent!((event) => events.push(event));

      // Poll returns sequence 0 (same as initial)
      const { parseRoutingApiResponse } = await import(
        '../../../../../impl/shared/ipfs/ipns-record-manager'
      );
      vi.mocked(parseRoutingApiResponse).mockResolvedValueOnce({
        cid: 'bafySame',
        sequence: 0n,
        recordData: new Uint8Array([1, 2, 3]),
      });
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('routing-response', { status: 200 }),
      );

      // Advance to the interval poll
      await vi.advanceTimersByTimeAsync(30000);

      const remoteEvents = events.filter((e) => e.type === 'storage:remote-updated');
      expect(remoteEvents).toHaveLength(0);

      await provider.shutdown();
    });

    it('should not poll when WS is connected', async () => {
      const provider = await initProvider({
        createWebSocket: wsFactory,
        fallbackPollIntervalMs: 30000,
      });

      // Connect WS — should suppress polling
      mockWs.simulateOpen();

      const events: StorageEvent[] = [];
      provider.onEvent!((event) => events.push(event));

      // Advance timer — no polling should happen
      await vi.advanceTimersByTimeAsync(30000);

      const remoteEvents = events.filter((e) => e.type === 'storage:remote-updated');
      expect(remoteEvents).toHaveLength(0);

      await provider.shutdown();
    });
  });

  // ---------------------------------------------------------------------------
  // Status accessor tracking through operations
  // ---------------------------------------------------------------------------

  describe('status tracking through save/load/sync', () => {
    it('should start with zero state before any operations', async () => {
      const provider = await initProvider();

      expect(provider.getSequenceNumber()).toBe(0n);
      expect(provider.getLastCid()).toBeNull();
      expect(provider.getDataVersion()).toBe(0);
      expect(provider.getRemoteCid()).toBeNull();
      expect(provider.getIpnsName()).toBe('12D3KooWTestPeerId');
      expect(provider.getStatus()).toBe('connected');

      await provider.shutdown();
    });

    it('should update status after successful save', async () => {
      const provider = await initProvider();

      vi.mocked(fetch)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ Hash: 'bafySave1' }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      await provider.save({
        _meta: { version: 0, address: 'test', formatVersion: '2.0', updatedAt: 0 },
      } as any);

      // save() is non-blocking — flush to trigger actual upload
      vi.useRealTimers();
      await provider.waitForFlush();

      expect(provider.getSequenceNumber()).toBe(1n);
      expect(provider.getLastCid()).toBe('bafySave1');
      expect(provider.getRemoteCid()).toBe('bafySave1');
      expect(provider.getDataVersion()).toBe(1);

      await provider.shutdown();
    });

    it('should update status after successful load', async () => {
      const provider = await initProvider();

      const remoteData = {
        _meta: { version: 8, address: 'test', formatVersion: '2.0', updatedAt: 8000 },
        _tok1: { id: 'tok1' },
      };

      const { parseRoutingApiResponse } = await import(
        '../../../../../impl/shared/ipfs/ipns-record-manager'
      );
      vi.mocked(parseRoutingApiResponse).mockResolvedValueOnce({
        cid: 'bafyLoaded',
        sequence: 8n,
        recordData: new Uint8Array([1, 2, 3]),
      });

      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('routing-response', { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(remoteData), { status: 200 }));

      const result = await provider.load();
      expect(result.success).toBe(true);

      expect(provider.getRemoteCid()).toBe('bafyLoaded');
      expect(provider.getDataVersion()).toBe(8);

      await provider.shutdown();
    });

    it('should track cumulative saves with incrementing sequence and version', async () => {
      const provider = await initProvider();
      vi.useRealTimers();

      for (let i = 0; i < 3; i++) {
        vi.mocked(fetch)
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ Hash: `bafyCid${i}` }), { status: 200 }),
          )
          .mockResolvedValueOnce(new Response('ok', { status: 200 }));

        await provider.save({
          _meta: { version: 0, address: 'test', formatVersion: '2.0', updatedAt: 0 },
        } as any);

        // save() is non-blocking — flush each one before next
        await provider.waitForFlush();
      }

      expect(provider.getSequenceNumber()).toBe(3n);
      expect(provider.getLastCid()).toBe('bafyCid2');
      expect(provider.getRemoteCid()).toBe('bafyCid2');
      expect(provider.getDataVersion()).toBe(3);

      await provider.shutdown();
    });

    it('should not advance version on failed save', async () => {
      const provider = await initProvider();
      vi.useRealTimers();

      // Successful save first
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ Hash: 'bafyOk' }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));
      await provider.save({
        _meta: { version: 0, address: 'test', formatVersion: '2.0', updatedAt: 0 },
      } as any);
      await provider.waitForFlush();
      expect(provider.getDataVersion()).toBe(1);

      // Failed save: upload ok, publish fails
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ Hash: 'bafyFail' }), { status: 200 }),
        )
        .mockRejectedValueOnce(new TypeError('Network error'));
      await provider.save({
        _meta: { version: 0, address: 'test', formatVersion: '2.0', updatedAt: 0 },
      } as any);
      try {
        await provider.waitForFlush();
      } catch {
        // Expected — flush failed
      }

      // Version should be rolled back
      expect(provider.getDataVersion()).toBe(1);
      // But lastCid/remoteCid should still be from the successful save
      expect(provider.getLastCid()).toBe('bafyOk');

      await provider.shutdown();
    });

    it('should restore status from persisted state', async () => {
      const persistence = new InMemoryIpfsStatePersistence();
      await persistence.save('12D3KooWTestPeerId', {
        sequenceNumber: '10',
        lastCid: 'bafyPersisted',
        version: 10,
      });

      const provider = await initProvider({}, persistence);

      expect(provider.getSequenceNumber()).toBe(10n);
      expect(provider.getLastCid()).toBe('bafyPersisted');
      expect(provider.getRemoteCid()).toBe('bafyPersisted');
      expect(provider.getDataVersion()).toBe(10);

      await provider.shutdown();
    });

    it('should report disconnected after shutdown', async () => {
      const provider = await initProvider();
      expect(provider.getStatus()).toBe('connected');
      expect(provider.isConnected()).toBe(true);

      await provider.shutdown();

      expect(provider.getStatus()).toBe('disconnected');
      expect(provider.isConnected()).toBe(false);
    });

    it('should update status after sync with remote data', async () => {
      const provider = await initProvider();

      const remoteData = {
        _meta: { version: 5, address: 'test', formatVersion: '2.0', updatedAt: 5000 },
        _tok1: { id: 'tok1', coinId: 'UCT', amount: '1000' },
      };

      const localData = {
        _meta: { version: 2, address: 'test', formatVersion: '2.0', updatedAt: 2000 },
        _tok1: { id: 'tok1', coinId: 'UCT', amount: '1000' },
      } as any;

      const { parseRoutingApiResponse } = await import(
        '../../../../../impl/shared/ipfs/ipns-record-manager'
      );
      vi.mocked(parseRoutingApiResponse).mockResolvedValueOnce({
        cid: 'bafyRemote',
        sequence: 5n,
        recordData: new Uint8Array([1, 2, 3]),
      });

      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('routing-response', { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(remoteData), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ Hash: 'bafyMerged' }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      const result = await provider.sync(localData);
      expect(result.success).toBe(true);

      // After sync: version advances beyond remote, sequence increments
      expect(provider.getDataVersion()).toBeGreaterThan(5);
      expect(provider.getSequenceNumber()).toBeGreaterThan(0n);
      expect(provider.getLastCid()).toBe('bafyMerged');
      expect(provider.getRemoteCid()).toBe('bafyMerged');

      await provider.shutdown();
    });
  });

  // ---------------------------------------------------------------------------
  // Event emission during sync lifecycle
  // ---------------------------------------------------------------------------

  describe('event emission during sync lifecycle', () => {
    it('should emit sync:started and sync:completed on successful sync', async () => {
      const provider = await initProvider();

      const events: StorageEvent[] = [];
      provider.onEvent!((event) => events.push(event));

      // No remote — just upload local
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('routing: not found', { status: 500 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ Hash: 'bafySync' }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      await provider.sync({
        _meta: { version: 1, address: 'test', formatVersion: '2.0', updatedAt: 0 },
        _tok1: { id: 'tok1' },
      } as any);

      expect(events.some((e) => e.type === 'sync:started')).toBe(true);
      expect(events.some((e) => e.type === 'sync:completed')).toBe(true);

      await provider.shutdown();
    });

    it('should emit sync:error when merge throws', async () => {
      const provider = await initProvider();

      const events: StorageEvent[] = [];
      provider.onEvent!((event) => events.push(event));

      // Mock load() to return success with remote data that has different version
      const remoteData = {
        _meta: { version: 5, address: 'test', formatVersion: '2.0', updatedAt: 5000 },
        _tok1: { id: 'tok1' },
      };

      const { parseRoutingApiResponse } = await import(
        '../../../../../impl/shared/ipfs/ipns-record-manager'
      );
      vi.mocked(parseRoutingApiResponse).mockResolvedValueOnce({
        cid: 'bafyRemote',
        sequence: 5n,
        recordData: new Uint8Array([1, 2, 3]),
      });

      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('routing-response', { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(remoteData), { status: 200 }));

      // Make mergeTxfData throw to trigger sync:error
      const { mergeTxfData } = await import('../../../../../impl/shared/ipfs/txf-merge');
      vi.mocked(mergeTxfData).mockImplementationOnce(() => {
        throw new Error('Merge failed unexpectedly');
      });

      await provider.sync({
        _meta: { version: 2, address: 'test', formatVersion: '2.0', updatedAt: 2000 },
        _tok1: { id: 'tok1' },
      } as any);

      expect(events.some((e) => e.type === 'sync:error')).toBe(true);
      const errorEvent = events.find((e) => e.type === 'sync:error');
      expect(errorEvent?.error).toContain('Merge failed unexpectedly');

      await provider.shutdown();
    });

    it('should emit storage:saving and storage:saved on successful save', async () => {
      const provider = await initProvider();

      const events: StorageEvent[] = [];
      provider.onEvent!((event) => events.push(event));

      vi.mocked(fetch)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ Hash: 'bafySave' }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      await provider.save({
        _meta: { version: 0, address: 'test', formatVersion: '2.0', updatedAt: 0 },
      } as any);

      // save() is non-blocking — flush to trigger actual events
      vi.useRealTimers();
      await provider.waitForFlush();

      expect(events.some((e) => e.type === 'storage:saving')).toBe(true);
      expect(events.some((e) => e.type === 'storage:saved')).toBe(true);

      await provider.shutdown();
    });

    it('should emit storage:loading and storage:loaded on successful load', async () => {
      const provider = await initProvider();

      const events: StorageEvent[] = [];
      provider.onEvent!((event) => events.push(event));

      const remoteData = {
        _meta: { version: 1, address: 'test', formatVersion: '2.0', updatedAt: 1000 },
        _tok1: { id: 'tok1' },
      };

      const { parseRoutingApiResponse } = await import(
        '../../../../../impl/shared/ipfs/ipns-record-manager'
      );
      vi.mocked(parseRoutingApiResponse).mockResolvedValueOnce({
        cid: 'bafyLoaded',
        sequence: 1n,
        recordData: new Uint8Array([1, 2, 3]),
      });

      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('routing-response', { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(remoteData), { status: 200 }));

      await provider.load();

      expect(events.some((e) => e.type === 'storage:loading')).toBe(true);
      expect(events.some((e) => e.type === 'storage:loaded')).toBe(true);

      await provider.shutdown();
    });
  });
});
