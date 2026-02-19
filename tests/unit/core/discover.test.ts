/**
 * Tests for HD address discovery via transport binding events.
 */

import { describe, it, expect, vi } from 'vitest';
import { discoverAddressesImpl } from '../../../core/discover';
import type { PeerInfo } from '../../../transport/transport-provider';

// =============================================================================
// Helpers
// =============================================================================

function makeDeriveFunc() {
  return (index: number) => ({
    transportPubkey: `pubkey_${index}`,
    chainPubkey: `02pubkey_${index}`,
    l1Address: `alpha1_${index}`,
    directAddress: `DIRECT://addr_${index}`,
  });
}

function makeBatchResolve(foundIndices: number[], nametags?: Record<number, string>) {
  return async (pubkeys: string[]): Promise<PeerInfo[]> => {
    return pubkeys
      .filter(pk => {
        const idx = parseInt(pk.replace('pubkey_', ''));
        return foundIndices.includes(idx);
      })
      .map(pk => {
        const idx = parseInt(pk.replace('pubkey_', ''));
        return {
          transportPubkey: pk,
          chainPubkey: `02pubkey_${idx}`,
          l1Address: `alpha1_${idx}`,
          directAddress: `DIRECT://addr_${idx}`,
          nametag: nametags?.[idx],
          timestamp: Date.now(),
        };
      });
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('discoverAddressesImpl', () => {
  it('should discover addresses with binding events', async () => {
    const result = await discoverAddressesImpl(
      makeDeriveFunc(),
      makeBatchResolve([0, 2, 5], { 2: 'alice', 5: 'bob' }),
      { maxAddresses: 30, gapLimit: 20 },
    );

    expect(result.addresses).toHaveLength(3);
    expect(result.addresses[0].index).toBe(0);
    expect(result.addresses[1].index).toBe(2);
    expect(result.addresses[1].nametag).toBe('alice');
    expect(result.addresses[2].index).toBe(5);
    expect(result.addresses[2].nametag).toBe('bob');
    expect(result.addresses.every(a => a.source === 'transport')).toBe(true);
    expect(result.aborted).toBe(false);
  });

  it('should stop after gap limit of consecutive empty indices', async () => {
    // Only index 0 has a binding, gap limit = 5
    const result = await discoverAddressesImpl(
      makeDeriveFunc(),
      makeBatchResolve([0]),
      { maxAddresses: 50, gapLimit: 5 },
    );

    expect(result.addresses).toHaveLength(1);
    expect(result.addresses[0].index).toBe(0);
    // Should have scanned 0..5 (index 0 found, then 1,2,3,4,5 empty = gap 5)
    expect(result.scannedCount).toBe(6);
  });

  it('should reset gap counter when address is found', async () => {
    // Indices 0 and 10 have bindings, gap limit = 15
    const result = await discoverAddressesImpl(
      makeDeriveFunc(),
      makeBatchResolve([0, 10]),
      { maxAddresses: 50, gapLimit: 15 },
    );

    expect(result.addresses).toHaveLength(2);
    // After finding index 10, gap resets, then scans 11..25 (15 empty) → stops
    expect(result.scannedCount).toBe(26);
  });

  it('should return empty when no binding events found', async () => {
    const result = await discoverAddressesImpl(
      makeDeriveFunc(),
      makeBatchResolve([]),
      { maxAddresses: 50, gapLimit: 5 },
    );

    expect(result.addresses).toHaveLength(0);
    expect(result.scannedCount).toBe(5);
  });

  it('should respect abort signal', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await discoverAddressesImpl(
      makeDeriveFunc(),
      makeBatchResolve([0, 1, 2]),
      { signal: controller.signal },
    );

    expect(result.addresses).toHaveLength(0);
    expect(result.aborted).toBe(true);
  });

  it('should call progress callback', async () => {
    const onProgress = vi.fn();

    await discoverAddressesImpl(
      makeDeriveFunc(),
      makeBatchResolve([0]),
      { maxAddresses: 25, gapLimit: 20, batchSize: 10, onProgress },
    );

    expect(onProgress).toHaveBeenCalled();
    const firstCall = onProgress.mock.calls[0][0];
    expect(firstCall.phase).toBe('transport');
    expect(firstCall.currentBatch).toBe(1);
  });

  it('should use multiple batches for large maxAddresses', async () => {
    const batchResolve = vi.fn(makeBatchResolve([0, 1, 15, 16]));

    const result = await discoverAddressesImpl(
      makeDeriveFunc(),
      batchResolve,
      { maxAddresses: 40, gapLimit: 20, batchSize: 10 },
    );

    expect(result.addresses).toHaveLength(4);
    // Should have called batchResolve multiple times (batches of 10)
    expect(batchResolve).toHaveBeenCalledTimes(4);
    // First batch: 10 pubkeys, second batch: 10 pubkeys, etc.
    expect(batchResolve.mock.calls[0][0]).toHaveLength(10);
  });

  it('should use derived fields when binding event has empty fields', async () => {
    const batchResolve = async (pubkeys: string[]): Promise<PeerInfo[]> => {
      return [{
        transportPubkey: pubkeys[0],
        chainPubkey: '', // missing
        l1Address: '', // missing
        directAddress: '', // missing
        timestamp: Date.now(),
      }];
    };

    const result = await discoverAddressesImpl(
      makeDeriveFunc(),
      batchResolve,
      { maxAddresses: 5, gapLimit: 5 },
    );

    expect(result.addresses).toHaveLength(1);
    // Should fallback to derived values
    expect(result.addresses[0].chainPubkey).toBe('02pubkey_0');
    expect(result.addresses[0].l1Address).toBe('alpha1_0');
    expect(result.addresses[0].directAddress).toBe('DIRECT://addr_0');
  });

  it('should respect maxAddresses limit', async () => {
    const batchResolve = vi.fn(makeBatchResolve(
      Array.from({ length: 10 }, (_, i) => i), // all 10 have bindings
    ));

    const result = await discoverAddressesImpl(
      makeDeriveFunc(),
      batchResolve,
      { maxAddresses: 10, gapLimit: 20, batchSize: 5 },
    );

    expect(result.addresses).toHaveLength(10);
    expect(result.scannedCount).toBe(10);
  });
});
