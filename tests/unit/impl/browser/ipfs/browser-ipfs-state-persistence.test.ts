import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BrowserIpfsStatePersistence } from '../../../../../impl/browser/ipfs/browser-ipfs-state-persistence';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
    get length() { return Object.keys(store).length; },
    key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
  };
})();

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

describe('BrowserIpfsStatePersistence', () => {
  let persistence: BrowserIpfsStatePersistence;
  const testIpnsName = '12D3KooWTest';

  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
    persistence = new BrowserIpfsStatePersistence();
  });

  describe('load', () => {
    it('should return null when no state stored', async () => {
      const result = await persistence.load(testIpnsName);
      expect(result).toBeNull();
    });

    it('should load saved state', async () => {
      localStorageMock.setItem(`sphere_ipfs_seq_${testIpnsName}`, '5');
      localStorageMock.setItem(`sphere_ipfs_cid_${testIpnsName}`, 'bafytest');
      localStorageMock.setItem(`sphere_ipfs_ver_${testIpnsName}`, '3');

      const result = await persistence.load(testIpnsName);
      expect(result).toEqual({
        sequenceNumber: '5',
        lastCid: 'bafytest',
        version: 3,
      });
    });

    it('should handle missing CID and version', async () => {
      localStorageMock.setItem(`sphere_ipfs_seq_${testIpnsName}`, '1');

      const result = await persistence.load(testIpnsName);
      expect(result).toEqual({
        sequenceNumber: '1',
        lastCid: null,
        version: 0,
      });
    });
  });

  describe('save', () => {
    it('should save state to localStorage', async () => {
      await persistence.save(testIpnsName, {
        sequenceNumber: '10',
        lastCid: 'bafyabc',
        version: 5,
      });

      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        `sphere_ipfs_seq_${testIpnsName}`, '10',
      );
      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        `sphere_ipfs_cid_${testIpnsName}`, 'bafyabc',
      );
      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        `sphere_ipfs_ver_${testIpnsName}`, '5',
      );
    });

    it('should remove CID key when lastCid is null', async () => {
      await persistence.save(testIpnsName, {
        sequenceNumber: '1',
        lastCid: null,
        version: 0,
      });

      expect(localStorageMock.removeItem).toHaveBeenCalledWith(
        `sphere_ipfs_cid_${testIpnsName}`,
      );
    });
  });

  describe('clear', () => {
    it('should remove all keys for the IPNS name', async () => {
      await persistence.save(testIpnsName, {
        sequenceNumber: '5',
        lastCid: 'bafytest',
        version: 2,
      });

      await persistence.clear(testIpnsName);

      expect(localStorageMock.removeItem).toHaveBeenCalledWith(`sphere_ipfs_seq_${testIpnsName}`);
      expect(localStorageMock.removeItem).toHaveBeenCalledWith(`sphere_ipfs_cid_${testIpnsName}`);
      expect(localStorageMock.removeItem).toHaveBeenCalledWith(`sphere_ipfs_ver_${testIpnsName}`);
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
