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
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn());
    statePersistence = new InMemoryIpfsStatePersistence();
    provider = new IpfsStorageProvider(
      { gateways: ['https://gw1.example.com'], flushDebounceMs: 100 },
      statePersistence,
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
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

    it('should not have syncOnly property', () => {
      expect((provider as any).syncOnly).toBeUndefined();
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

      vi.useRealTimers();
      await provider.shutdown();

      expect(provider.isConnected()).toBe(false);
      expect(provider.getStatus()).toBe('disconnected');
    });
  });

  describe('save (non-blocking with write-behind)', () => {
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

    it('should return success immediately (non-blocking)', async () => {
      const result = await provider.save(testData as any);
      expect(result.success).toBe(true);
      // No network calls yet — still buffered
    });

    it('should upload and publish on flush', async () => {
      // Upload response
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ Hash: 'bafynew123' }), { status: 200 }),
        )
        // Publish response
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      await provider.save(testData as any);

      // Trigger the debounced flush
      vi.useRealTimers();
      await provider.waitForFlush();

      expect(provider.getLastCid()).toBe('bafynew123');
      expect(provider.getSequenceNumber()).toBe(1n);
    });

    it('should persist state after flush', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ Hash: 'bafynew123' }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      await provider.save(testData as any);

      vi.useRealTimers();
      await provider.waitForFlush();

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
      vi.useRealTimers();

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

      await provider.save(savedInventory as any);

      // Trigger the flush
      vi.useRealTimers();
      await provider.waitForFlush();

      expect(provider.getLastCid()).toBe('bafyInventoryCid');

      // Destroy Provider A (simulates full local wipe)
      await provider.shutdown();

      // --- Provider B: fresh instance, same key, NO persisted state ---
      const freshPersistence = new InMemoryIpfsStatePersistence();
      const providerB = new IpfsStorageProvider(
        { gateways: ['https://gw1.example.com'], flushDebounceMs: 100 },
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
        { gateways: ['https://gw1.example.com'], flushDebounceMs: 100 },
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

      vi.useRealTimers();
      await freshProvider.shutdown();
    });
  });

  describe('sidecar chain validation compliance', () => {
    // The IPFS sidecar requires:
    // - Bootstrap (first save): _meta.version >= 1, NO lastCid field
    // - Normal update: _meta.lastCid == current CID on sidecar, version == current + 1
    // These tests verify the uploaded JSON meets those requirements.

    it('bootstrap save should NOT include lastCid in _meta', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ Version: '0.20.0' }), { status: 200 }),
      );
      provider.setIdentity(testIdentity);
      await provider.initialize();

      // Capture what gets uploaded
      let uploadedBody: string | undefined;
      vi.mocked(fetch)
        .mockImplementationOnce(async (_url, opts) => {
          // Upload call - extract the body
          if (opts?.body instanceof FormData) {
            const blob = opts.body.get('file') as Blob;
            if (blob) uploadedBody = await blob.text();
          }
          return new Response(JSON.stringify({ Hash: 'bafyBootstrap' }), { status: 200 });
        })
        .mockResolvedValueOnce(new Response('ok', { status: 200 })); // publish

      await provider.save({
        _meta: { version: 0, address: 'test', formatVersion: '2.0', updatedAt: 0 },
        _tok1: { id: 'tok1' },
      } as any);

      // Wait for the flush to happen
      vi.useRealTimers();
      await provider.waitForFlush();

      expect(uploadedBody).toBeTruthy();
      const uploaded = JSON.parse(uploadedBody!);
      expect(uploaded._meta.version).toBe(1); // >= 1
      expect(uploaded._meta).not.toHaveProperty('lastCid'); // NO lastCid for bootstrap
    });

    it('second save should include lastCid pointing to first CID', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ Version: '0.20.0' }), { status: 200 }),
      );
      provider.setIdentity(testIdentity);
      await provider.initialize();

      // First save (bootstrap)
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response(JSON.stringify({ Hash: 'bafyFirst' }), { status: 200 }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));
      await provider.save({
        _meta: { version: 0, address: 'test', formatVersion: '2.0', updatedAt: 0 },
        _tok1: { id: 'tok1' },
      } as any);

      vi.useRealTimers();
      await provider.waitForFlush();
      expect(provider.getRemoteCid()).toBe('bafyFirst');

      // Second save — capture uploaded data
      let uploadedBody: string | undefined;
      vi.mocked(fetch)
        .mockImplementationOnce(async (_url, opts) => {
          if (opts?.body instanceof FormData) {
            const blob = opts.body.get('file') as Blob;
            if (blob) uploadedBody = await blob.text();
          }
          return new Response(JSON.stringify({ Hash: 'bafySecond' }), { status: 200 });
        })
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      await provider.save({
        _meta: { version: 0, address: 'test', formatVersion: '2.0', updatedAt: 0 },
        _tok1: { id: 'tok1' },
        _tok2: { id: 'tok2' },
      } as any);

      await provider.waitForFlush();

      expect(uploadedBody).toBeTruthy();
      const uploaded = JSON.parse(uploadedBody!);
      expect(uploaded._meta.lastCid).toBe('bafyFirst'); // chain to previous CID
      expect(uploaded._meta.version).toBe(2); // version 1 + 1
    });

    it('save after load should include lastCid from remote CID', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ Version: '0.20.0' }), { status: 200 }),
      );
      provider.setIdentity(testIdentity);
      await provider.initialize();

      // Simulate load() returning remote data at version 5
      const remoteData = {
        _meta: { version: 5, address: 'test', formatVersion: '2.0', updatedAt: 5000 },
        _tok1: { id: 'tok1' },
      };

      const { parseRoutingApiResponse } = await import(
        '../../../../../impl/shared/ipfs/ipns-record-manager'
      );
      vi.mocked(parseRoutingApiResponse).mockResolvedValueOnce({
        cid: 'bafyRemoteV5',
        sequence: 5n,
        recordData: new Uint8Array([1, 2, 3]),
      });

      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('routing-response', { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(remoteData), { status: 200 }));

      await provider.load();

      expect(provider.getRemoteCid()).toBe('bafyRemoteV5');
      expect(provider.getDataVersion()).toBe(5);

      // Now save — should chain to remote CID and use version 6
      let uploadedBody: string | undefined;
      vi.mocked(fetch)
        .mockImplementationOnce(async (_url, opts) => {
          if (opts?.body instanceof FormData) {
            const blob = opts.body.get('file') as Blob;
            if (blob) uploadedBody = await blob.text();
          }
          return new Response(JSON.stringify({ Hash: 'bafyNew' }), { status: 200 });
        })
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      await provider.save({
        _meta: { version: 0, address: 'test', formatVersion: '2.0', updatedAt: 0 },
        _tok1: { id: 'tok1' },
        _tok2: { id: 'tok2' },
      } as any);

      vi.useRealTimers();
      await provider.waitForFlush();

      const uploaded = JSON.parse(uploadedBody!);
      expect(uploaded._meta.lastCid).toBe('bafyRemoteV5');
      expect(uploaded._meta.version).toBe(6); // remote 5 + 1
    });

    it('version should increment by exactly 1 on consecutive saves', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ Version: '0.20.0' }), { status: 200 }),
      );
      provider.setIdentity(testIdentity);
      await provider.initialize();

      vi.useRealTimers();

      const versions: number[] = [];
      const cids: (string | undefined)[] = [];

      for (let i = 0; i < 3; i++) {
        let uploadedBody: string | undefined;
        vi.mocked(fetch)
          .mockImplementationOnce(async (_url, opts) => {
            if (opts?.body instanceof FormData) {
              const blob = opts.body.get('file') as Blob;
              if (blob) uploadedBody = await blob.text();
            }
            return new Response(JSON.stringify({ Hash: `bafyCid${i}` }), { status: 200 });
          })
          .mockResolvedValueOnce(new Response('ok', { status: 200 }));

        await provider.save({
          _meta: { version: 0, address: 'test', formatVersion: '2.0', updatedAt: 0 },
        } as any);

        await provider.waitForFlush();

        const uploaded = JSON.parse(uploadedBody!);
        versions.push(uploaded._meta.version);
        cids.push(uploaded._meta.lastCid);
      }

      // Versions: 1, 2, 3 (incrementing by 1)
      expect(versions).toEqual([1, 2, 3]);
      // Chain: no lastCid, bafyCid0, bafyCid1
      expect(cids[0]).toBeUndefined();       // bootstrap
      expect(cids[1]).toBe('bafyCid0');       // chains to first
      expect(cids[2]).toBe('bafyCid1');       // chains to second
    });

    it('failed flush should not advance version', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ Version: '0.20.0' }), { status: 200 }),
      );
      provider.setIdentity(testIdentity);
      await provider.initialize();

      vi.useRealTimers();

      // Successful save: version becomes 1
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response(JSON.stringify({ Hash: 'bafyOk' }), { status: 200 }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));
      await provider.save({ _meta: { version: 0, address: 'test', formatVersion: '2.0', updatedAt: 0 } } as any);
      await provider.waitForFlush();
      expect(provider.getDataVersion()).toBe(1);

      // Failed save: upload succeeds but publish fails
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response(JSON.stringify({ Hash: 'bafyFail' }), { status: 200 }))
        .mockRejectedValueOnce(new TypeError('Network error'));

      await provider.save({ _meta: { version: 0, address: 'test', formatVersion: '2.0', updatedAt: 0 } } as any);

      // waitForFlush will catch the error and the buffer will retry
      // But the version should still be rolled back
      try {
        await provider.waitForFlush();
      } catch {
        // Expected — flush failed
      }

      // Version should be rolled back to 1
      expect(provider.getDataVersion()).toBe(1);
    });

    it('persisted state should restore remoteCid for chain continuity', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ Version: '0.20.0' }), { status: 200 }),
      );

      // Simulate persisted state from previous session
      await statePersistence.save('12D3KooWTestPeerId', {
        sequenceNumber: '5',
        lastCid: 'bafyPrevSession',
        version: 5,
      });

      provider.setIdentity(testIdentity);
      await provider.initialize();

      // remoteCid should be restored from persisted state
      expect(provider.getRemoteCid()).toBe('bafyPrevSession');

      // Next save should chain to persisted CID
      let uploadedBody: string | undefined;
      vi.mocked(fetch)
        .mockImplementationOnce(async (_url, opts) => {
          if (opts?.body instanceof FormData) {
            const blob = opts.body.get('file') as Blob;
            if (blob) uploadedBody = await blob.text();
          }
          return new Response(JSON.stringify({ Hash: 'bafyNewSession' }), { status: 200 });
        })
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      await provider.save({ _meta: { version: 0, address: 'test', formatVersion: '2.0', updatedAt: 0 } } as any);

      vi.useRealTimers();
      await provider.waitForFlush();

      const uploaded = JSON.parse(uploadedBody!);
      expect(uploaded._meta.lastCid).toBe('bafyPrevSession');
      expect(uploaded._meta.version).toBe(6); // persisted 5 + 1
    });
  });

  describe('individual token operations', () => {
    beforeEach(async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ Version: '0.20.0' }), { status: 200 }),
      );
      provider.setIdentity(testIdentity);
      await provider.initialize();
    });

    it('saveToken stores and getToken retrieves', async () => {
      await provider.saveToken!('_tok1', { id: 'tok1', coinId: 'UCT', amount: '1000' });
      const result = await provider.getToken!('_tok1');
      expect(result).toEqual({ id: 'tok1', coinId: 'UCT', amount: '1000' });
    });

    it('getToken returns null for unknown token', async () => {
      const result = await provider.getToken!('_nonexistent');
      expect(result).toBeNull();
    });

    it('deleteToken removes a buffered token', async () => {
      await provider.saveToken!('_tok1', { id: 'tok1' });
      await provider.deleteToken!('_tok1');
      const result = await provider.getToken!('_tok1');
      expect(result).toBeNull();
    });

    it('listTokenIds returns buffered minus deleted', async () => {
      await provider.saveToken!('_tok1', { id: 'tok1' });
      await provider.saveToken!('_tok2', { id: 'tok2' });
      await provider.saveToken!('_tok3', { id: 'tok3' });
      await provider.deleteToken!('_tok2');

      const ids = await provider.listTokenIds!();
      expect(ids).toEqual(expect.arrayContaining(['_tok1', '_tok3']));
      expect(ids).not.toContain('_tok2');
      expect(ids).toHaveLength(2);
    });

    it('saveToken after deleteToken re-adds the token', async () => {
      await provider.saveToken!('_tok1', { id: 'tok1', v: 1 });
      await provider.deleteToken!('_tok1');
      await provider.saveToken!('_tok1', { id: 'tok1', v: 2 });

      const result = await provider.getToken!('_tok1');
      expect(result).toEqual({ id: 'tok1', v: 2 });

      const ids = await provider.listTokenIds!();
      expect(ids).toContain('_tok1');
    });

    it('flush includes buffered tokens in uploaded payload', async () => {
      await provider.saveToken!('_bufTok1', { id: 'bufTok1', coinId: 'UCT', amount: '500' });
      await provider.saveToken!('_bufTok2', { id: 'bufTok2', coinId: 'GEMA', amount: '100' });

      let uploadedBody: string | undefined;
      vi.mocked(fetch)
        .mockImplementationOnce(async (_url, opts) => {
          if (opts?.body instanceof FormData) {
            const blob = opts.body.get('file') as Blob;
            if (blob) uploadedBody = await blob.text();
          }
          return new Response(JSON.stringify({ Hash: 'bafyWithTokens' }), { status: 200 });
        })
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      // Also save full data to trigger flush with meaningful payload
      await provider.save({
        _meta: { version: 0, address: 'test', formatVersion: '2.0', updatedAt: 0 },
      } as any);

      vi.useRealTimers();
      await provider.waitForFlush();

      expect(uploadedBody).toBeTruthy();
      const uploaded = JSON.parse(uploadedBody!);
      expect(uploaded._bufTok1).toEqual({ id: 'bufTok1', coinId: 'UCT', amount: '500' });
      expect(uploaded._bufTok2).toEqual({ id: 'bufTok2', coinId: 'GEMA', amount: '100' });
    });

    it('flush excludes deleted tokens from uploaded payload', async () => {
      await provider.saveToken!('_keep', { id: 'keep' });
      await provider.saveToken!('_remove', { id: 'remove' });
      await provider.deleteToken!('_remove');

      let uploadedBody: string | undefined;
      vi.mocked(fetch)
        .mockImplementationOnce(async (_url, opts) => {
          if (opts?.body instanceof FormData) {
            const blob = opts.body.get('file') as Blob;
            if (blob) uploadedBody = await blob.text();
          }
          return new Response(JSON.stringify({ Hash: 'bafyFiltered' }), { status: 200 });
        })
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      await provider.save({
        _meta: { version: 0, address: 'test', formatVersion: '2.0', updatedAt: 0 },
        _remove: { id: 'remove', fromData: true },
      } as any);

      vi.useRealTimers();
      await provider.waitForFlush();

      const uploaded = JSON.parse(uploadedBody!);
      expect(uploaded._keep).toEqual({ id: 'keep' });
      expect(uploaded._remove).toBeUndefined();
    });

    it('load() populates buffer from remote data', async () => {
      const remoteData = {
        _meta: { version: 3, address: 'test', formatVersion: '2.0', updatedAt: 3000 },
        _remTok1: { id: 'remTok1', coinId: 'UCT', amount: '2000' },
        _remTok2: { id: 'remTok2', coinId: 'GEMA', amount: '50' },
        _tombstones: [{ tokenId: 'old', stateHash: 'abc', timestamp: 1000 }],
      };

      const { parseRoutingApiResponse } = await import(
        '../../../../../impl/shared/ipfs/ipns-record-manager'
      );
      vi.mocked(parseRoutingApiResponse).mockResolvedValueOnce({
        cid: 'bafyRemoteTokens',
        sequence: 3n,
        recordData: new Uint8Array([1, 2, 3]),
      });

      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('routing-response', { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(remoteData), { status: 200 }));

      const loadResult = await provider.load();
      expect(loadResult.success).toBe(true);

      // Buffer should contain token entries but not meta keys
      const tok1 = await provider.getToken!('_remTok1');
      expect(tok1).toEqual({ id: 'remTok1', coinId: 'UCT', amount: '2000' });

      const tok2 = await provider.getToken!('_remTok2');
      expect(tok2).toEqual({ id: 'remTok2', coinId: 'GEMA', amount: '50' });

      // Meta keys should NOT be in the buffer
      const tombstones = await provider.getToken!('_tombstones');
      expect(tombstones).toBeNull();

      const ids = await provider.listTokenIds!();
      expect(ids).toEqual(expect.arrayContaining(['_remTok1', '_remTok2']));
      expect(ids).toHaveLength(2);
    });

    it('clear() empties the token buffer', async () => {
      await provider.saveToken!('_tok1', { id: 'tok1' });
      await provider.saveToken!('_tok2', { id: 'tok2' });
      await provider.deleteToken!('_tok2');

      // Mock save inside clear (uses _doSave directly)
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response(JSON.stringify({ Hash: 'bafyClear' }), { status: 200 }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      vi.useRealTimers();
      await provider.clear!();

      const ids = await provider.listTokenIds!();
      expect(ids).toHaveLength(0);
      expect(await provider.getToken!('_tok1')).toBeNull();
    });
  });

  describe('version conflict protection', () => {
    // Helper to set up an initialized provider with mocked fetch
    async function createInitializedProvider(): Promise<IpfsStorageProvider> {
      const p = new IpfsStorageProvider(
        { gateways: ['https://gw1.example.com'], flushDebounceMs: 100 },
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
      vi.useRealTimers();
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
      vi.useRealTimers();
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
      vi.useRealTimers();
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
      vi.useRealTimers();
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
      // Then _doSave() increments dataVersion again, so the saved _meta.version
      // must be > both 3 and 20
      const mergedVersion = (result.merged as any)._meta?.version;
      expect(mergedVersion).toBeGreaterThan(20);
      expect(mergedVersion).toBeGreaterThan(3);

      await p.shutdown();
    });
  });

  describe('write-behind buffer behavior', () => {
    beforeEach(async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ Version: '0.20.0' }), { status: 200 }),
      );
      provider.setIdentity(testIdentity);
      await provider.initialize();
    });

    it('multiple rapid save() calls coalesce into single flush', async () => {
      let ipfsAddCount = 0;
      vi.mocked(fetch).mockImplementation(async (_url, opts) => {
        const url = String(_url);
        if (url.includes('/api/v0/add')) {
          ipfsAddCount++;
          return new Response(JSON.stringify({ Hash: 'bafyCoalesced' }), { status: 200 });
        }
        // Routing/publish and other calls
        return new Response('ok', { status: 200 });
      });

      // Fire multiple saves rapidly — debounce should coalesce
      await provider.save({ _meta: { version: 0, address: 'test', formatVersion: '2.0', updatedAt: 0 } } as any);
      await provider.save({ _meta: { version: 0, address: 'test', formatVersion: '2.0', updatedAt: 0 }, _tok1: { id: 'tok1' } } as any);
      await provider.save({ _meta: { version: 0, address: 'test', formatVersion: '2.0', updatedAt: 0 }, _tok1: { id: 'tok1' }, _tok2: { id: 'tok2' } } as any);

      vi.useRealTimers();
      await provider.waitForFlush();

      // Should only upload once (all coalesced by debounce)
      expect(ipfsAddCount).toBe(1);
    });

    it('saveToken() schedules a flush', async () => {
      let uploadedBody: string | undefined;
      vi.mocked(fetch)
        .mockImplementationOnce(async (_url, opts) => {
          if (opts?.body instanceof FormData) {
            const blob = opts.body.get('file') as Blob;
            if (blob) uploadedBody = await blob.text();
          }
          return new Response(JSON.stringify({ Hash: 'bafyTokenFlush' }), { status: 200 });
        })
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      await provider.saveToken!('_myTok', { id: 'myTok', coinId: 'UCT' });

      vi.useRealTimers();
      await provider.waitForFlush();

      expect(uploadedBody).toBeTruthy();
      const uploaded = JSON.parse(uploadedBody!);
      expect(uploaded._myTok).toEqual({ id: 'myTok', coinId: 'UCT' });
    });

    it('deleteToken() schedules a flush', async () => {
      // Pre-populate a token in the buffer
      await provider.saveToken!('_delTok', { id: 'delTok' });

      // Now delete it
      let uploadedBody: string | undefined;
      vi.mocked(fetch)
        .mockImplementationOnce(async (_url, opts) => {
          if (opts?.body instanceof FormData) {
            const blob = opts.body.get('file') as Blob;
            if (blob) uploadedBody = await blob.text();
          }
          return new Response(JSON.stringify({ Hash: 'bafyAfterDel' }), { status: 200 });
        })
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      await provider.deleteToken!('_delTok');

      vi.useRealTimers();
      await provider.waitForFlush();

      expect(uploadedBody).toBeTruthy();
      const uploaded = JSON.parse(uploadedBody!);
      expect(uploaded._delTok).toBeUndefined();
    });

    it('shutdown() drains pending buffer', async () => {
      let ipfsAddCount = 0;
      vi.mocked(fetch).mockImplementation(async (_url, opts) => {
        const url = String(_url);
        if (url.includes('/api/v0/add')) {
          ipfsAddCount++;
          return new Response(JSON.stringify({ Hash: 'bafyShutdown' }), { status: 200 });
        }
        return new Response('ok', { status: 200 });
      });

      await provider.save({
        _meta: { version: 0, address: 'test', formatVersion: '2.0', updatedAt: 0 },
        _tok1: { id: 'tok1' },
      } as any);

      // Don't wait for flush — shutdown should drain it
      vi.useRealTimers();
      await provider.shutdown();

      expect(ipfsAddCount).toBe(1);
    });

    it('failed flush merges buffer back and retries', async () => {
      vi.useRealTimers();

      let attemptCount = 0;
      vi.mocked(fetch).mockImplementation(async (_url, opts) => {
        if (opts?.body instanceof FormData) {
          attemptCount++;
          if (attemptCount === 1) {
            // First attempt: upload OK but publish fails
            return new Response(JSON.stringify({ Hash: 'bafyAttempt1' }), { status: 200 });
          }
          if (attemptCount === 2) {
            // This is the publish call that fails
            throw new TypeError('Network error');
          }
          // Subsequent attempts: succeed
          return new Response(JSON.stringify({ Hash: 'bafyRetry' }), { status: 200 });
        }
        // Publish succeeds on retry
        return new Response('ok', { status: 200 });
      });

      await provider.save({
        _meta: { version: 0, address: 'test', formatVersion: '2.0', updatedAt: 0 },
        _tok1: { id: 'tok1' },
      } as any);

      // First flush will fail (publish throws), but data should not be lost
      // The retry mechanism will schedule another flush
      try {
        await provider.waitForFlush();
      } catch {
        // Expected
      }

      // Eventually the retry should succeed
      // waitForFlush again to catch the retry
      await provider.waitForFlush();

      // Data should not be lost — version should eventually advance
      expect(provider.getDataVersion()).toBeGreaterThanOrEqual(1);
    });
  });
});
