/**
 * Tests for l1/vesting.ts
 * Covers VestingClassifier - UTXO tracing to coinbase origin
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import type { UTXO } from '../../../l1/types';

// Mock network module
vi.mock('../../../l1/network', () => ({
  getTransaction: vi.fn(),
  getCurrentBlockHeight: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.resetModules();
});

// =============================================================================
// VESTING_THRESHOLD Tests
// =============================================================================

describe('VESTING_THRESHOLD', () => {
  it('should be 280000', async () => {
    const { VESTING_THRESHOLD } = await import('../../../l1/vesting');
    expect(VESTING_THRESHOLD).toBe(280000);
  });
});

// =============================================================================
// VestingClassifier Tests
// =============================================================================

describe('vestingClassifier', () => {
  describe('classifyUtxo()', () => {
    it('should return error for UTXO without tx_hash', async () => {
      const { vestingClassifier } = await import('../../../l1/vesting');

      const utxo = { value: 1000 } as UTXO;
      const result = await vestingClassifier.classifyUtxo(utxo);

      expect(result.isVested).toBe(false);
      expect(result.error).toBe('No transaction hash');
    });
  });

  describe('classifyUtxos()', () => {
    it('should classify vested UTXO (coinbase height <= 280000)', async () => {
      const { getTransaction, getCurrentBlockHeight } = await import('../../../l1/network');
      const { vestingClassifier } = await import('../../../l1/vesting');

      vi.mocked(getCurrentBlockHeight).mockResolvedValue(300000);
      vi.mocked(getTransaction).mockResolvedValue({
        txid: 'abc123',
        confirmations: 200001, // 300000 - 200001 + 1 = 100000
        vin: [{ coinbase: '04ffff001d0104' }],
      });

      await vestingClassifier.initDB();

      const utxos: UTXO[] = [{
        tx_hash: 'abc123',
        tx_pos: 0,
        value: 5000000000,
        height: 100000,
      }];

      const result = await vestingClassifier.classifyUtxos(utxos);

      expect(result.vested).toHaveLength(1);
      expect(result.vested[0].vestingStatus).toBe('vested');
      expect(result.vested[0].coinbaseHeight).toBe(100000);
    });

    it('should classify unvested UTXO (coinbase height > 280000)', async () => {
      const { getTransaction, getCurrentBlockHeight } = await import('../../../l1/network');
      const { vestingClassifier } = await import('../../../l1/vesting');

      vi.mocked(getCurrentBlockHeight).mockResolvedValue(400000);
      vi.mocked(getTransaction).mockResolvedValue({
        txid: 'def456',
        confirmations: 50001, // 400000 - 50001 + 1 = 350000
        vin: [{ coinbase: '04ffff001d0104' }],
      });

      await vestingClassifier.initDB();

      const utxos: UTXO[] = [{
        tx_hash: 'def456',
        tx_pos: 0,
        value: 5000000000,
        height: 350000,
      }];

      const result = await vestingClassifier.classifyUtxos(utxos);

      expect(result.unvested).toHaveLength(1);
      expect(result.unvested[0].vestingStatus).toBe('unvested');
      expect(result.unvested[0].coinbaseHeight).toBe(350000);
    });

    it('should trace non-coinbase transaction to origin', async () => {
      const { getTransaction, getCurrentBlockHeight } = await import('../../../l1/network');
      const { vestingClassifier } = await import('../../../l1/vesting');

      vi.mocked(getCurrentBlockHeight).mockResolvedValue(300000);

      vi.mocked(getTransaction)
        .mockResolvedValueOnce({
          txid: 'child_tx',
          confirmations: 1000,
          vin: [{ txid: 'parent_tx' }],
        })
        .mockResolvedValueOnce({
          txid: 'parent_tx',
          confirmations: 200001, // block 100000
          vin: [{ coinbase: '04ffff001d0104' }],
        });

      await vestingClassifier.initDB();

      const utxos: UTXO[] = [{
        tx_hash: 'child_tx',
        tx_pos: 0,
        value: 1000000,
        height: 299001,
      }];

      const result = await vestingClassifier.classifyUtxos(utxos);

      expect(result.vested).toHaveLength(1);
      expect(result.vested[0].coinbaseHeight).toBe(100000);
      expect(getTransaction).toHaveBeenCalledTimes(2);
    });

    it('should return error when transaction fetch fails', async () => {
      const { getTransaction, getCurrentBlockHeight } = await import('../../../l1/network');
      const { vestingClassifier } = await import('../../../l1/vesting');

      vi.mocked(getCurrentBlockHeight).mockResolvedValue(300000);
      vi.mocked(getTransaction).mockResolvedValue(null);

      await vestingClassifier.initDB();

      const utxos: UTXO[] = [{
        tx_hash: 'invalid_tx',
        tx_pos: 0,
        value: 1000000,
        height: 100000,
      }];

      const result = await vestingClassifier.classifyUtxos(utxos);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain('Failed to fetch');
    });

    it('should handle txid field as alternative to tx_hash', async () => {
      const { getTransaction, getCurrentBlockHeight } = await import('../../../l1/network');
      const { vestingClassifier } = await import('../../../l1/vesting');

      vi.mocked(getCurrentBlockHeight).mockResolvedValue(300000);
      vi.mocked(getTransaction).mockResolvedValue({
        txid: 'txid_test',
        confirmations: 200001,
        vin: [{ coinbase: '04ffff001d0104' }],
      });

      await vestingClassifier.initDB();

      const utxos = [{
        txid: 'txid_test',
        tx_pos: 0,
        value: 1000000,
      }] as UTXO[];

      const result = await vestingClassifier.classifyUtxos(utxos);

      expect(result.vested).toHaveLength(1);
    });

    it('should classify multiple UTXOs', async () => {
      const { getTransaction, getCurrentBlockHeight } = await import('../../../l1/network');
      const { vestingClassifier } = await import('../../../l1/vesting');

      vi.mocked(getCurrentBlockHeight).mockResolvedValue(400000);

      vi.mocked(getTransaction)
        .mockResolvedValueOnce({
          txid: 'vested_tx',
          confirmations: 300001, // block 100000
          vin: [{ coinbase: '04ffff001d0104' }],
        })
        .mockResolvedValueOnce({
          txid: 'unvested_tx',
          confirmations: 50001, // block 350000
          vin: [{ coinbase: '04ffff001d0104' }],
        });

      await vestingClassifier.initDB();

      const utxos: UTXO[] = [
        { tx_hash: 'vested_tx', tx_pos: 0, value: 1000000, height: 100000 },
        { tx_hash: 'unvested_tx', tx_pos: 0, value: 2000000, height: 350000 },
      ];

      const result = await vestingClassifier.classifyUtxos(utxos);

      expect(result.vested).toHaveLength(1);
      expect(result.unvested).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
    });

    it('should call progress callback', async () => {
      const { getTransaction, getCurrentBlockHeight } = await import('../../../l1/network');
      const { vestingClassifier } = await import('../../../l1/vesting');

      vi.mocked(getCurrentBlockHeight).mockResolvedValue(300000);
      vi.mocked(getTransaction).mockResolvedValue({
        txid: 'test',
        confirmations: 200001,
        vin: [{ coinbase: '04ffff001d0104' }],
      });

      await vestingClassifier.initDB();

      const utxos: UTXO[] = [
        { tx_hash: 'tx1', tx_pos: 0, value: 1000000, height: 100000 },
        { tx_hash: 'tx2', tx_pos: 0, value: 1000000, height: 100000 },
        { tx_hash: 'tx3', tx_pos: 0, value: 1000000, height: 100000 },
      ];

      const progressCalls: Array<[number, number]> = [];
      const onProgress = (current: number, total: number) => {
        progressCalls.push([current, total]);
      };

      await vestingClassifier.classifyUtxos(utxos, onProgress);

      expect(progressCalls).toEqual([
        [1, 3],
        [2, 3],
        [3, 3],
      ]);
    });

    it('should handle errors and add to errors array', async () => {
      const { getTransaction, getCurrentBlockHeight } = await import('../../../l1/network');
      const { vestingClassifier } = await import('../../../l1/vesting');

      vi.mocked(getCurrentBlockHeight).mockResolvedValue(300000);
      vi.mocked(getTransaction).mockResolvedValue(null);

      await vestingClassifier.initDB();

      const utxos: UTXO[] = [
        { tx_hash: 'bad_tx', tx_pos: 0, value: 1000000, height: 100000 },
      ];

      const result = await vestingClassifier.classifyUtxos(utxos);

      expect(result.errors).toHaveLength(1);
      expect(result.unvested).toHaveLength(1);
      expect(result.unvested[0].vestingStatus).toBe('error');
    });
  });

  describe('isCoinbaseTransaction detection', () => {
    it('should detect coinbase with coinbase field', async () => {
      const { getTransaction, getCurrentBlockHeight } = await import('../../../l1/network');
      const { vestingClassifier } = await import('../../../l1/vesting');

      vi.mocked(getCurrentBlockHeight).mockResolvedValue(300000);
      vi.mocked(getTransaction).mockResolvedValue({
        txid: 'coinbase_test',
        confirmations: 200001,
        vin: [{ coinbase: '04ffff001d0104' }],
      });

      await vestingClassifier.initDB();

      const utxos: UTXO[] = [{ tx_hash: 'coinbase_test', tx_pos: 0, value: 5000000000, height: 100000 }];
      const result = await vestingClassifier.classifyUtxos(utxos);

      expect(result.vested[0].coinbaseHeight).toBe(100000);
    });

    it('should detect coinbase with zero txid', async () => {
      const { getTransaction, getCurrentBlockHeight } = await import('../../../l1/network');
      const { vestingClassifier } = await import('../../../l1/vesting');

      vi.mocked(getCurrentBlockHeight).mockResolvedValue(300000);
      vi.mocked(getTransaction).mockResolvedValue({
        txid: 'zero_txid_test',
        confirmations: 200001,
        vin: [{
          txid: '0000000000000000000000000000000000000000000000000000000000000000',
        }],
      });

      await vestingClassifier.initDB();

      const utxos: UTXO[] = [{ tx_hash: 'zero_txid_test', tx_pos: 0, value: 5000000000, height: 100000 }];
      const result = await vestingClassifier.classifyUtxos(utxos);

      expect(result.vested[0].coinbaseHeight).toBe(100000);
    });
  });

  describe('clearCaches()', () => {
    it('should clear memory cache', async () => {
      const { getTransaction, getCurrentBlockHeight } = await import('../../../l1/network');
      const { vestingClassifier } = await import('../../../l1/vesting');

      vi.mocked(getCurrentBlockHeight).mockResolvedValue(300000);
      vi.mocked(getTransaction).mockResolvedValue({
        txid: 'cache_test',
        confirmations: 200001,
        vin: [{ coinbase: '04ffff001d0104' }],
      });

      await vestingClassifier.initDB();

      const utxos: UTXO[] = [{ tx_hash: 'cache_test', tx_pos: 0, value: 1000000, height: 100000 }];

      // First call populates cache
      await vestingClassifier.classifyUtxos(utxos);

      // Clear caches
      vestingClassifier.clearCaches();

      // Second call should fetch again (cache cleared)
      await vestingClassifier.classifyUtxos(utxos);

      // getTransaction called twice (cache was cleared between calls)
      expect(getTransaction).toHaveBeenCalledTimes(2);
    });
  });
});

// =============================================================================
// Node.js / No IndexedDB
// =============================================================================

describe('VestingClassifier without IndexedDB (Node.js)', () => {
  let savedIndexedDB: typeof globalThis.indexedDB;

  beforeEach(() => {
    savedIndexedDB = globalThis.indexedDB;
    // Simulate Node.js — no IndexedDB
    delete (globalThis as Record<string, unknown>).indexedDB;
  });

  afterEach(() => {
    // Restore fake-indexeddb
    globalThis.indexedDB = savedIndexedDB;
  });

  it('should not throw on initDB() when IndexedDB is unavailable', async () => {
    const { vestingClassifier } = await import('../../../l1/vesting');

    await expect(vestingClassifier.initDB()).resolves.not.toThrow();
  });

  it('should classify UTXOs using memory-only cache', async () => {
    const { getTransaction, getCurrentBlockHeight } = await import('../../../l1/network');
    const { vestingClassifier } = await import('../../../l1/vesting');

    vi.mocked(getCurrentBlockHeight).mockResolvedValue(300000);
    vi.mocked(getTransaction).mockResolvedValue({
      txid: 'node_test',
      confirmations: 200001, // block 100000
      vin: [{ coinbase: '04ffff001d0104' }],
    });

    await vestingClassifier.initDB(); // should be a no-op

    const utxos: UTXO[] = [{
      tx_hash: 'node_test',
      tx_pos: 0,
      value: 5000000000,
      height: 100000,
    }];

    const result = await vestingClassifier.classifyUtxos(utxos);

    expect(result.vested).toHaveLength(1);
    expect(result.vested[0].coinbaseHeight).toBe(100000);
  });

  it('should not throw on destroy() when IndexedDB is unavailable', async () => {
    const { vestingClassifier } = await import('../../../l1/vesting');

    await vestingClassifier.initDB();
    await expect(vestingClassifier.destroy()).resolves.not.toThrow();
  });

  it('should not throw on clearCaches() when IndexedDB is unavailable', async () => {
    const { vestingClassifier } = await import('../../../l1/vesting');

    await vestingClassifier.initDB();
    expect(() => vestingClassifier.clearCaches()).not.toThrow();
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe('Edge cases', () => {
  it('should handle exactly at vesting threshold (block 280000)', async () => {
    const { getTransaction, getCurrentBlockHeight } = await import('../../../l1/network');
    const { vestingClassifier, VESTING_THRESHOLD } = await import('../../../l1/vesting');

    vi.mocked(getCurrentBlockHeight).mockResolvedValue(300000);
    vi.mocked(getTransaction).mockResolvedValue({
      txid: 'threshold_tx',
      confirmations: 20001, // 300000 - 20001 + 1 = 280000
      vin: [{ coinbase: '04ffff001d0104' }],
    });

    await vestingClassifier.initDB();

    const utxos: UTXO[] = [{ tx_hash: 'threshold_tx', tx_pos: 0, value: 1000000, height: VESTING_THRESHOLD }];
    const result = await vestingClassifier.classifyUtxos(utxos);

    expect(result.vested).toHaveLength(1); // <= 280000 is vested
    expect(result.vested[0].coinbaseHeight).toBe(280000);
  });

  it('should handle block 280001 as unvested', async () => {
    const { getTransaction, getCurrentBlockHeight } = await import('../../../l1/network');
    const { vestingClassifier } = await import('../../../l1/vesting');

    vi.mocked(getCurrentBlockHeight).mockResolvedValue(300000);
    vi.mocked(getTransaction).mockResolvedValue({
      txid: 'unvested_boundary',
      confirmations: 20000, // 300000 - 20000 + 1 = 280001
      vin: [{ coinbase: '04ffff001d0104' }],
    });

    await vestingClassifier.initDB();

    const utxos: UTXO[] = [{ tx_hash: 'unvested_boundary', tx_pos: 0, value: 1000000, height: 280001 }];
    const result = await vestingClassifier.classifyUtxos(utxos);

    expect(result.unvested).toHaveLength(1);
    expect(result.unvested[0].coinbaseHeight).toBe(280001);
  });

  it('should handle empty UTXOs array', async () => {
    const { getCurrentBlockHeight } = await import('../../../l1/network');
    const { vestingClassifier } = await import('../../../l1/vesting');

    vi.mocked(getCurrentBlockHeight).mockResolvedValue(300000);

    await vestingClassifier.initDB();

    const result = await vestingClassifier.classifyUtxos([]);

    expect(result.vested).toHaveLength(0);
    expect(result.unvested).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});
