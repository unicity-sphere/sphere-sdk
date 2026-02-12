import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IpfsHttpClient } from '../../../../../impl/shared/ipfs/ipfs-http-client';
import { IpfsCache } from '../../../../../impl/shared/ipfs/ipfs-cache';
import { IpfsError } from '../../../../../impl/shared/ipfs/ipfs-error-types';

describe('IpfsHttpClient', () => {
  let cache: IpfsCache;
  let client: IpfsHttpClient;
  const gateways = ['https://gw1.example.com', 'https://gw2.example.com'];

  beforeEach(() => {
    cache = new IpfsCache();
    client = new IpfsHttpClient({ gateways }, cache);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Gateway Health
  // ---------------------------------------------------------------------------

  describe('testConnectivity', () => {
    it('should return healthy for successful version response', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ Version: '0.20.0' }), { status: 200 }),
      );

      const result = await client.testConnectivity('https://gw1.example.com');
      expect(result.healthy).toBe(true);
      expect(result.gateway).toBe('https://gw1.example.com');
      expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should return unhealthy for failed response', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('error', { status: 500 }),
      );

      const result = await client.testConnectivity('https://gw1.example.com');
      expect(result.healthy).toBe(false);
      expect(result.error).toContain('500');
    });

    it('should return unhealthy on network error', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));

      const result = await client.testConnectivity('https://gw1.example.com');
      expect(result.healthy).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('findHealthyGateways', () => {
    it('should return only healthy gateways', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('ok', { status: 200 }))
        .mockRejectedValueOnce(new TypeError('Failed'));

      const healthy = await client.findHealthyGateways();
      expect(healthy).toEqual(['https://gw1.example.com']);
    });
  });

  describe('getAvailableGateways', () => {
    it('should exclude gateways in cooldown', () => {
      // Put gw1 in cooldown
      for (let i = 0; i < 3; i++) {
        cache.recordGatewayFailure('https://gw1.example.com');
      }

      const available = client.getAvailableGateways();
      expect(available).toEqual(['https://gw2.example.com']);
    });

    it('should return all gateways when none in cooldown', () => {
      const available = client.getAvailableGateways();
      expect(available).toEqual(gateways);
    });
  });

  // ---------------------------------------------------------------------------
  // Upload
  // ---------------------------------------------------------------------------

  describe('upload', () => {
    it('should upload to gateway and return CID', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ Hash: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' }), { status: 200 }),
      );

      const result = await client.upload({ test: 'data' });
      expect(result.cid).toBe('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi');
    });

    it('should throw IpfsError when all gateways fail', async () => {
      vi.mocked(fetch).mockRejectedValue(new TypeError('Failed'));

      await expect(client.upload({ test: 'data' })).rejects.toThrow(IpfsError);
    });

    it('should throw when no gateways available', async () => {
      // Put all gateways in cooldown
      for (const gw of gateways) {
        for (let i = 0; i < 3; i++) {
          cache.recordGatewayFailure(gw);
        }
      }

      await expect(client.upload({ test: 'data' })).rejects.toThrow('No gateways available');
    });
  });

  // ---------------------------------------------------------------------------
  // Content Fetch
  // ---------------------------------------------------------------------------

  describe('fetchContent', () => {
    const testCid = 'bafytest123';
    const testData = {
      _meta: { version: 1, address: 'test', formatVersion: '2.0', updatedAt: Date.now() },
    };

    it('should fetch content and cache it', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify(testData), { status: 200 }),
      );

      const result = await client.fetchContent(testCid);
      expect(result._meta.version).toBe(1);

      // Second call should use cache
      const cached = await client.fetchContent(testCid);
      expect(cached._meta.version).toBe(1);
      // fetch should only have been called for the first gateway attempts
    });

    it('should throw IpfsError when all gateways fail', async () => {
      vi.mocked(fetch).mockRejectedValue(new TypeError('Failed'));

      await expect(client.fetchContent(testCid)).rejects.toThrow(IpfsError);
    });

    it('should return cached content without network call', async () => {
      cache.setContent(testCid, testData as any);

      const result = await client.fetchContent(testCid);
      expect(result._meta.version).toBe(1);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // IPNS Resolution
  // ---------------------------------------------------------------------------

  describe('resolveIpnsViaRoutingApi', () => {
    const testIpnsName = '12D3KooWtest';

    it('should return null for NOT_FOUND', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('routing: not found', { status: 500 }),
      );

      const result = await client.resolveIpnsViaRoutingApi('https://gw1.example.com', testIpnsName);
      expect(result).toBeNull();
    });

    it('should return null on network error', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed'));

      const result = await client.resolveIpnsViaRoutingApi('https://gw1.example.com', testIpnsName);
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // IPNS Publishing
  // ---------------------------------------------------------------------------

  describe('publishIpnsViaRoutingApi', () => {
    const testIpnsName = '12D3KooWtest';
    const testRecord = new Uint8Array([1, 2, 3]);

    it('should return true on success', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('ok', { status: 200 }),
      );

      const result = await client.publishIpnsViaRoutingApi(
        'https://gw1.example.com', testIpnsName, testRecord,
      );
      expect(result).toBe(true);
    });

    it('should return false on failure', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('error', { status: 500 }),
      );

      const result = await client.publishIpnsViaRoutingApi(
        'https://gw1.example.com', testIpnsName, testRecord,
      );
      expect(result).toBe(false);
    });
  });

  describe('publishIpns', () => {
    const testIpnsName = '12D3KooWtest';
    const testRecord = new Uint8Array([1, 2, 3]);

    it('should return success when at least one gateway succeeds', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('ok', { status: 200 }))
        .mockRejectedValueOnce(new TypeError('Failed'));

      const result = await client.publishIpns(testIpnsName, testRecord);
      expect(result.success).toBe(true);
      expect(result.successfulGateways!.length).toBeGreaterThan(0);
    });

    it('should return failure when all gateways fail', async () => {
      vi.mocked(fetch).mockRejectedValue(new TypeError('Failed'));

      const result = await client.publishIpns(testIpnsName, testRecord);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
