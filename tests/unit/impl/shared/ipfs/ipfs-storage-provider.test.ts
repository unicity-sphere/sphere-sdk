import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IpfsStorageProvider } from '../../../../../impl/shared/ipfs/ipfs-storage-provider';
import { InMemoryIpfsStatePersistence } from '../../../../../impl/shared/ipfs/ipfs-state-persistence';
import type { FullIdentity } from '../../../../../types';

// Mock the dynamic import dependencies
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

describe('IpfsStorageProvider', () => {
  let provider: IpfsStorageProvider;
  let statePersistence: InMemoryIpfsStatePersistence;
  const testIdentity: FullIdentity = {
    privateKey: 'e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35',
    chainPubkey: '0339a36013301597daef41fbe593a02cc513d0b55527ec2df1050e2e8ff49c85c2',
    l1Address: 'alpha1test',
    directAddress: 'DIRECT://test',
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    statePersistence = new InMemoryIpfsStatePersistence();
    provider = new IpfsStorageProvider(
      { gateways: ['https://gw1.example.com'] },
      statePersistence,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe('lifecycle', () => {
    it('should start disconnected', () => {
      expect(provider.getStatus()).toBe('disconnected');
      expect(provider.isConnected()).toBe(false);
    });

    it('should have correct provider metadata', () => {
      expect(provider.id).toBe('ipfs');
      expect(provider.name).toBe('IPFS Storage');
      expect(provider.type).toBe('p2p');
    });

    it('should fail to initialize without identity', async () => {
      const result = await provider.initialize();
      expect(result).toBe(false);
    });

    it('should initialize successfully with identity', async () => {
      // Mock the connectivity test
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ Version: '0.20.0' }), { status: 200 }),
      );

      provider.setIdentity(testIdentity);
      const result = await provider.initialize();
      expect(result).toBe(true);
      expect(provider.isConnected()).toBe(true);
      expect(provider.getIpnsName()).toBe('12D3KooWTestPeerId');
    });

    it('should load persisted state on initialize', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ Version: '0.20.0' }), { status: 200 }),
      );

      await statePersistence.save('12D3KooWTestPeerId', {
        sequenceNumber: '5',
        lastCid: 'bafyexisting',
        version: 3,
      });

      provider.setIdentity(testIdentity);
      await provider.initialize();

      expect(provider.getSequenceNumber()).toBe(5n);
      expect(provider.getLastCid()).toBe('bafyexisting');
    });

    it('should shutdown and reset status', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ Version: '0.20.0' }), { status: 200 }),
      );

      provider.setIdentity(testIdentity);
      await provider.initialize();
      await provider.shutdown();

      expect(provider.isConnected()).toBe(false);
      expect(provider.getStatus()).toBe('disconnected');
    });
  });

  describe('save', () => {
    const testData = {
      _meta: { version: 0, address: 'test', formatVersion: '2.0', updatedAt: 0 },
      _abc123: { some: 'token' },
    };

    beforeEach(async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ Version: '0.20.0' }), { status: 200 }),
      );
      provider.setIdentity(testIdentity);
      await provider.initialize();
    });

    it('should upload and publish successfully', async () => {
      // Upload response
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ Hash: 'bafynew123' }), { status: 200 }),
        )
        // Publish response
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      const result = await provider.save(testData as any);
      expect(result.success).toBe(true);
      expect(result.cid).toBe('bafynew123');
      expect(provider.getLastCid()).toBe('bafynew123');
      expect(provider.getSequenceNumber()).toBe(1n);
    });

    it('should persist state after save', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ Hash: 'bafynew123' }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      await provider.save(testData as any);

      const persisted = await statePersistence.load('12D3KooWTestPeerId');
      expect(persisted).not.toBeNull();
      expect(persisted!.sequenceNumber).toBe('1');
      expect(persisted!.lastCid).toBe('bafynew123');
    });

    it('should fail when not initialized', async () => {
      const uninitProvider = new IpfsStorageProvider(
        { gateways: ['https://gw1.example.com'] },
        statePersistence,
      );

      const result = await uninitProvider.save(testData as any);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Not initialized');
    });

    it('should return failure when publish fails', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ Hash: 'bafynew123' }), { status: 200 }),
        )
        // All publish attempts fail
        .mockRejectedValue(new TypeError('Failed'));

      const result = await provider.save(testData as any);
      expect(result.success).toBe(false);
    });
  });

  describe('load', () => {
    beforeEach(async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ Version: '0.20.0' }), { status: 200 }),
      );
      provider.setIdentity(testIdentity);
      await provider.initialize();
    });

    it('should fail when not initialized', async () => {
      const uninitProvider = new IpfsStorageProvider(
        { gateways: ['https://gw1.example.com'] },
        statePersistence,
      );

      const result = await uninitProvider.load();
      expect(result.success).toBe(false);
    });

    it('should return not found for new wallet', async () => {
      // IPNS resolution returns 500 routing not found
      vi.mocked(fetch).mockResolvedValue(
        new Response('routing: not found', { status: 500 }),
      );

      const result = await provider.load();
      expect(result.success).toBe(false);
    });
  });

  describe('sync', () => {
    const localData = {
      _meta: { version: 1, address: 'test', formatVersion: '2.0', updatedAt: 1000 },
      _token1: { id: 'token1' },
    };

    beforeEach(async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ Version: '0.20.0' }), { status: 200 }),
      );
      provider.setIdentity(testIdentity);
      await provider.initialize();
    });

    it('should upload local data when no remote exists', async () => {
      // IPNS resolution fails (no remote)
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('routing: not found', { status: 500 }))
        // Upload
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ Hash: 'bafynew' }), { status: 200 }),
        )
        // Publish
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      const result = await provider.sync(localData as any);
      expect(result.success).toBe(true);
      expect(result.added).toBe(0);
      expect(result.removed).toBe(0);
      expect(result.conflicts).toBe(0);
    });
  });

  describe('events', () => {
    it('should emit events via onEvent', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ Version: '0.20.0' }), { status: 200 }),
      );

      const events: any[] = [];
      const unsub = provider.onEvent!((event) => events.push(event));

      provider.setIdentity(testIdentity);
      await provider.initialize();

      expect(events.some((e) => e.type === 'storage:loading')).toBe(true);
      expect(events.some((e) => e.type === 'storage:loaded')).toBe(true);

      unsub();
    });

    it('should stop emitting after unsubscribe', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ Version: '0.20.0' }), { status: 200 }),
      );

      const events: any[] = [];
      const unsub = provider.onEvent!((event) => events.push(event));
      unsub();

      provider.setIdentity(testIdentity);
      await provider.initialize();

      expect(events.length).toBe(0);
    });
  });

  describe('exists', () => {
    it('should return false when not initialized', async () => {
      const result = await provider.exists!();
      expect(result).toBe(false);
    });
  });

  describe('recovery after local storage wipe', () => {
    const savedInventory = {
      _meta: { version: 5, address: 'DIRECT://test', formatVersion: '2.0', updatedAt: 1000 },
      _tokenA: { id: 'tokenA', coinId: 'UCT', amount: '5000000' },
      _tokenB: { id: 'tokenB', coinId: 'UCT', amount: '2500000' },
      _tokenC: { id: 'tokenC', coinId: 'GEMA', amount: '100' },
    };

    it('should recover full inventory via IPNS after destroying the original provider', async () => {
      // --- Provider A: save inventory ---
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ Version: '0.20.0' }), { status: 200 }),
      );
      provider.setIdentity(testIdentity);
      await provider.initialize();

      // Upload + publish
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ Hash: 'bafyInventoryCid' }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      const saveResult = await provider.save(savedInventory as any);
      expect(saveResult.success).toBe(true);
      expect(saveResult.cid).toBe('bafyInventoryCid');

      // Destroy Provider A (simulates full local wipe)
      await provider.shutdown();

      // --- Provider B: fresh instance, same key, NO persisted state ---
      const freshPersistence = new InMemoryIpfsStatePersistence();
      const providerB = new IpfsStorageProvider(
        { gateways: ['https://gw1.example.com'] },
        freshPersistence,
      );

      vi.stubGlobal('fetch', vi.fn());
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ Version: '0.20.0' }), { status: 200 }),
      );

      providerB.setIdentity(testIdentity);
      const initOk = await providerB.initialize();
      expect(initOk).toBe(true);

      // Verify Provider B has zero local state
      expect(providerB.getLastCid()).toBeNull();
      expect(providerB.getSequenceNumber()).toBe(0n);

      // Mock IPNS resolution: routing API returns record pointing to our CID
      const { parseRoutingApiResponse } = await import(
        '../../../../../impl/shared/ipfs/ipns-record-manager'
      );
      vi.mocked(parseRoutingApiResponse).mockResolvedValueOnce({
        cid: 'bafyInventoryCid',
        sequence: 1n,
        recordData: new Uint8Array([1, 2, 3]),
      });

      // Mock the routing API HTTP call (returns 200 so parseRoutingApiResponse is called)
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          new Response('routing-api-ndjson-body', { status: 200 }),
        )
        // Mock content fetch: GET /ipfs/bafyInventoryCid returns the saved inventory
        .mockResolvedValueOnce(
          new Response(JSON.stringify(savedInventory), { status: 200 }),
        );

      // Recovery: load via IPNS
      const recovered = await providerB.load();

      expect(recovered.success).toBe(true);
      expect(recovered.source).toBe('remote');
      expect(recovered.data).toBeTruthy();

      const data = recovered.data as any;
      expect(data._tokenA?.coinId).toBe('UCT');
      expect(data._tokenA?.amount).toBe('5000000');
      expect(data._tokenB?.coinId).toBe('UCT');
      expect(data._tokenB?.amount).toBe('2500000');
      expect(data._tokenC?.coinId).toBe('GEMA');
      expect(data._tokenC?.amount).toBe('100');

      await providerB.shutdown();
    });

    it('should return not-found when IPNS has no record for the key', async () => {
      // Fresh provider with same key but nothing ever published
      const freshPersistence = new InMemoryIpfsStatePersistence();
      const freshProvider = new IpfsStorageProvider(
        { gateways: ['https://gw1.example.com'] },
        freshPersistence,
      );

      vi.stubGlobal('fetch', vi.fn());
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ Version: '0.20.0' }), { status: 200 }),
      );

      freshProvider.setIdentity(testIdentity);
      await freshProvider.initialize();

      // IPNS resolution returns nothing
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('routing: not found', { status: 500 }),
      );

      const result = await freshProvider.load();
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');

      await freshProvider.shutdown();
    });
  });

  describe('version conflict protection', () => {
    // Helper to set up an initialized provider with mocked fetch
    async function createInitializedProvider(): Promise<IpfsStorageProvider> {
      const p = new IpfsStorageProvider(
        { gateways: ['https://gw1.example.com'] },
        new InMemoryIpfsStatePersistence(),
      );
      vi.stubGlobal('fetch', vi.fn());
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ Version: '0.20.0' }), { status: 200 }),
      );
      p.setIdentity(testIdentity);
      await p.initialize();
      return p;
    }

    it('sync with stale local should preserve remote-only tokens', async () => {
      const p = await createInitializedProvider();

      // Remote has v5 with 3 tokens (including tokenNew added by another device)
      const remoteData = {
        _meta: { version: 5, address: 'test', formatVersion: '2.0', updatedAt: 5000 },
        _tokenA: { id: 'tokenA', coinId: 'UCT', amount: '1000' },
        _tokenB: { id: 'tokenB', coinId: 'UCT', amount: '2000' },
        _tokenNew: { id: 'tokenNew', coinId: 'GEMA', amount: '500' },
      };

      // Stale local has v2 with only 2 tokens (missing tokenNew)
      const staleLocal = {
        _meta: { version: 2, address: 'test', formatVersion: '2.0', updatedAt: 2000 },
        _tokenA: { id: 'tokenA', coinId: 'UCT', amount: '1000' },
        _tokenB: { id: 'tokenB', coinId: 'UCT', amount: '2000' },
      } as any;

      // Mock sync flow: load() resolves IPNS → fetches remote data
      const { parseRoutingApiResponse } = await import(
        '../../../../../impl/shared/ipfs/ipns-record-manager'
      );
      vi.mocked(parseRoutingApiResponse).mockResolvedValueOnce({
        cid: 'bafyRemoteV5',
        sequence: 5n,
        recordData: new Uint8Array([1, 2, 3]),
      });

      vi.mocked(fetch)
        // IPNS routing API returns 200
        .mockResolvedValueOnce(new Response('routing-response', { status: 200 }))
        // Content fetch returns remote data
        .mockResolvedValueOnce(new Response(JSON.stringify(remoteData), { status: 200 }))
        // Upload merged result
        .mockResolvedValueOnce(new Response(JSON.stringify({ Hash: 'bafyMerged' }), { status: 200 }))
        // Publish IPNS
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      const result = await p.sync(staleLocal);

      expect(result.success).toBe(true);
      expect(result.merged).toBeTruthy();

      const merged = result.merged as any;
      // All 3 tokens must be present — tokenNew from remote must NOT be lost
      expect(merged._tokenA?.coinId).toBe('UCT');
      expect(merged._tokenB?.coinId).toBe('UCT');
      expect(merged._tokenNew?.coinId).toBe('GEMA');
      expect(merged._tokenNew?.amount).toBe('500');

      // tokenNew was added from remote
      expect(result.added).toBe(1);
      // No tokens were removed
      expect(result.removed).toBe(0);

      await p.shutdown();
    });

    it('sync with stale local should not lose tokens even when local has lower version', async () => {
      const p = await createInitializedProvider();

      // Remote v10: has 4 tokens (tokenD was added on another device)
      const remoteData = {
        _meta: { version: 10, address: 'test', formatVersion: '2.0', updatedAt: 10000 },
        _tokenA: { id: 'tokenA', coinId: 'UCT', amount: '100' },
        _tokenB: { id: 'tokenB', coinId: 'UCT', amount: '200' },
        _tokenC: { id: 'tokenC', coinId: 'UCT', amount: '300' },
        _tokenD: { id: 'tokenD', coinId: 'UCT', amount: '400' },
      };

      // Stale local v3: only has 2 of the original tokens
      const staleLocal = {
        _meta: { version: 3, address: 'test', formatVersion: '2.0', updatedAt: 3000 },
        _tokenA: { id: 'tokenA', coinId: 'UCT', amount: '100' },
        _tokenB: { id: 'tokenB', coinId: 'UCT', amount: '200' },
      } as any;

      const { parseRoutingApiResponse } = await import(
        '../../../../../impl/shared/ipfs/ipns-record-manager'
      );
      vi.mocked(parseRoutingApiResponse).mockResolvedValueOnce({
        cid: 'bafyRemoteV10',
        sequence: 10n,
        recordData: new Uint8Array([1, 2, 3]),
      });

      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('routing-response', { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(remoteData), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ Hash: 'bafyMerged' }), { status: 200 }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      const result = await p.sync(staleLocal);

      expect(result.success).toBe(true);
      const merged = result.merged as any;

      // ALL 4 tokens must survive — tokenC and tokenD from remote must be preserved
      expect(merged._tokenA).toBeTruthy();
      expect(merged._tokenB).toBeTruthy();
      expect(merged._tokenC?.amount).toBe('300');
      expect(merged._tokenD?.amount).toBe('400');
      expect(result.added).toBe(2); // tokenC + tokenD added from remote

      await p.shutdown();
    });

    it('sync with stale local should preserve remote tokens even when local has extra tokens', async () => {
      const p = await createInitializedProvider();

      // Remote v5: has tokenA + tokenRemoteOnly
      const remoteData = {
        _meta: { version: 5, address: 'test', formatVersion: '2.0', updatedAt: 5000 },
        _tokenA: { id: 'tokenA', coinId: 'UCT', amount: '1000' },
        _tokenRemoteOnly: { id: 'tokenRemoteOnly', coinId: 'GEMA', amount: '999' },
      };

      // Stale local v2: has tokenA + tokenLocalOnly (different additions on each side)
      const staleLocal = {
        _meta: { version: 2, address: 'test', formatVersion: '2.0', updatedAt: 2000 },
        _tokenA: { id: 'tokenA', coinId: 'UCT', amount: '1000' },
        _tokenLocalOnly: { id: 'tokenLocalOnly', coinId: 'UCT', amount: '777' },
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
        .mockResolvedValueOnce(new Response(JSON.stringify({ Hash: 'bafyMerged' }), { status: 200 }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      const result = await p.sync(staleLocal);

      expect(result.success).toBe(true);
      const merged = result.merged as any;

      // All 3 tokens from both sides must be present
      expect(merged._tokenA?.amount).toBe('1000');
      expect(merged._tokenLocalOnly?.amount).toBe('777');
      expect(merged._tokenRemoteOnly?.amount).toBe('999');

      // remote-only token was added
      expect(result.added).toBe(1);

      await p.shutdown();
    });

    it('merged version should always exceed both local and remote versions', async () => {
      const p = await createInitializedProvider();

      const remoteData = {
        _meta: { version: 20, address: 'test', formatVersion: '2.0', updatedAt: 5000 },
        _tokenA: { id: 'tokenA', coinId: 'UCT', amount: '1000' },
      };

      const staleLocal = {
        _meta: { version: 3, address: 'test', formatVersion: '2.0', updatedAt: 2000 },
        _tokenA: { id: 'tokenA', coinId: 'UCT', amount: '1000' },
      } as any;

      const { parseRoutingApiResponse } = await import(
        '../../../../../impl/shared/ipfs/ipns-record-manager'
      );
      vi.mocked(parseRoutingApiResponse).mockResolvedValueOnce({
        cid: 'bafyRemote',
        sequence: 20n,
        recordData: new Uint8Array([1, 2, 3]),
      });

      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('routing-response', { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(remoteData), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ Hash: 'bafyMerged' }), { status: 200 }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      const result = await p.sync(staleLocal);

      expect(result.success).toBe(true);
      // The merge sets version = max(local, remote) + 1
      // Then save() increments dataVersion again, so the saved _meta.version
      // must be > both 3 and 20
      const mergedVersion = (result.merged as any)._meta?.version;
      expect(mergedVersion).toBeGreaterThan(20);
      expect(mergedVersion).toBeGreaterThan(3);

      await p.shutdown();
    });
  });
});
