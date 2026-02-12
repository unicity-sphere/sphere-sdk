import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NodejsIpfsStatePersistence } from '../../../../../impl/nodejs/ipfs/nodejs-ipfs-state-persistence';
import type { StorageProvider } from '../../../../../storage';

describe('NodejsIpfsStatePersistence', () => {
  let persistence: NodejsIpfsStatePersistence;
  let mockStorage: StorageProvider;
  const store: Record<string, string> = {};
  const testIpnsName = '12D3KooWTest';

  beforeEach(() => {
    // Clear store
    for (const key of Object.keys(store)) delete store[key];

    mockStorage = {
      id: 'test',
      name: 'Test Storage',
      type: 'local',
      get: vi.fn(async (key: string) => store[key] ?? null),
      set: vi.fn(async (key: string, value: string) => { store[key] = value; }),
      remove: vi.fn(async (key: string) => { delete store[key]; }),
      has: vi.fn(async (key: string) => key in store),
      keys: vi.fn(async () => Object.keys(store)),
      clear: vi.fn(async () => { for (const k of Object.keys(store)) delete store[k]; }),
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      isConnected: vi.fn(() => true),
      getStatus: vi.fn(() => 'connected' as const),
      setIdentity: vi.fn(),
      saveTrackedAddresses: vi.fn(async () => {}),
      loadTrackedAddresses: vi.fn(async () => []),
    };

    persistence = new NodejsIpfsStatePersistence(mockStorage);
  });

  describe('load', () => {
    it('should return null when no state stored', async () => {
      const result = await persistence.load(testIpnsName);
      expect(result).toBeNull();
    });

    it('should load saved state', async () => {
      store[`sphere_ipfs_seq_${testIpnsName}`] = '5';
      store[`sphere_ipfs_cid_${testIpnsName}`] = 'bafytest';
      store[`sphere_ipfs_ver_${testIpnsName}`] = '3';

      const result = await persistence.load(testIpnsName);
      expect(result).toEqual({
        sequenceNumber: '5',
        lastCid: 'bafytest',
        version: 3,
      });
    });

    it('should handle missing CID and version', async () => {
      store[`sphere_ipfs_seq_${testIpnsName}`] = '1';

      const result = await persistence.load(testIpnsName);
      expect(result).toEqual({
        sequenceNumber: '1',
        lastCid: null,
        version: 0,
      });
    });
  });

  describe('save', () => {
    it('should save state via StorageProvider', async () => {
      await persistence.save(testIpnsName, {
        sequenceNumber: '10',
        lastCid: 'bafyabc',
        version: 5,
      });

      expect(mockStorage.set).toHaveBeenCalledWith(`sphere_ipfs_seq_${testIpnsName}`, '10');
      expect(mockStorage.set).toHaveBeenCalledWith(`sphere_ipfs_cid_${testIpnsName}`, 'bafyabc');
      expect(mockStorage.set).toHaveBeenCalledWith(`sphere_ipfs_ver_${testIpnsName}`, '5');
    });

    it('should remove CID key when lastCid is null', async () => {
      await persistence.save(testIpnsName, {
        sequenceNumber: '1',
        lastCid: null,
        version: 0,
      });

      expect(mockStorage.remove).toHaveBeenCalledWith(`sphere_ipfs_cid_${testIpnsName}`);
    });
  });

  describe('clear', () => {
    it('should remove all keys for the IPNS name', async () => {
      await persistence.clear(testIpnsName);

      expect(mockStorage.remove).toHaveBeenCalledWith(`sphere_ipfs_seq_${testIpnsName}`);
      expect(mockStorage.remove).toHaveBeenCalledWith(`sphere_ipfs_cid_${testIpnsName}`);
      expect(mockStorage.remove).toHaveBeenCalledWith(`sphere_ipfs_ver_${testIpnsName}`);
    });
  });

  describe('round-trip', () => {
    it('should save and load correctly', async () => {
      const state = {
        sequenceNumber: '42',
        lastCid: 'bafyroundtrip',
        version: 7,
      };

      await persistence.save(testIpnsName, state);
      const loaded = await persistence.load(testIpnsName);

      expect(loaded).toEqual(state);
    });
  });
});
