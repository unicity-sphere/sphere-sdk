import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IpfsCache } from '../../../../../impl/shared/ipfs/ipfs-cache';
import type { IpnsGatewayResult } from '../../../../../impl/shared/ipfs/ipfs-types';
import type { TxfStorageDataBase } from '../../../../../storage';

// =============================================================================
// Test Helpers
// =============================================================================

function createIpnsResult(overrides?: Partial<IpnsGatewayResult>): IpnsGatewayResult {
  return {
    cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    sequence: 1n,
    gateway: 'https://ipfs.io',
    ...overrides,
  };
}

function createTxfData(overrides?: Partial<TxfStorageDataBase>): TxfStorageDataBase {
  return {
    _meta: {
      version: 1,
      address: 'DIRECT_abc123_xyz789',
      formatVersion: '1.0',
      updatedAt: Date.now(),
    },
    ...overrides,
  } as TxfStorageDataBase;
}

// =============================================================================
// Tests
// =============================================================================

describe('IpfsCache', () => {
  let cache: IpfsCache;

  beforeEach(() => {
    cache = new IpfsCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // Constructor / Configuration
  // ---------------------------------------------------------------------------

  describe('constructor', () => {
    it('should create an instance with default config', () => {
      const c = new IpfsCache();
      expect(c).toBeInstanceOf(IpfsCache);
    });

    it('should create an instance with custom config', () => {
      const c = new IpfsCache({
        ipnsTtlMs: 120_000,
        failureCooldownMs: 30_000,
        failureThreshold: 5,
        knownFreshWindowMs: 10_000,
      });
      expect(c).toBeInstanceOf(IpfsCache);
    });

    it('should create an instance with partial config', () => {
      const c = new IpfsCache({ ipnsTtlMs: 5000 });
      expect(c).toBeInstanceOf(IpfsCache);
    });
  });

  // ---------------------------------------------------------------------------
  // IPNS Record Cache
  // ---------------------------------------------------------------------------

  describe('IPNS record cache', () => {
    it('should return null for unknown IPNS name', () => {
      expect(cache.getIpnsRecord('unknown')).toBeNull();
    });

    it('should store and retrieve an IPNS record', () => {
      const result = createIpnsResult();
      cache.setIpnsRecord('k51qzi5uqu5dl', result);

      const retrieved = cache.getIpnsRecord('k51qzi5uqu5dl');
      expect(retrieved).toEqual(result);
    });

    it('should store records for different IPNS names independently', () => {
      const result1 = createIpnsResult({ cid: 'cid-one', sequence: 1n });
      const result2 = createIpnsResult({ cid: 'cid-two', sequence: 2n });

      cache.setIpnsRecord('name-a', result1);
      cache.setIpnsRecord('name-b', result2);

      expect(cache.getIpnsRecord('name-a')).toEqual(result1);
      expect(cache.getIpnsRecord('name-b')).toEqual(result2);
    });

    it('should overwrite an existing record for the same IPNS name', () => {
      const result1 = createIpnsResult({ cid: 'old-cid', sequence: 1n });
      const result2 = createIpnsResult({ cid: 'new-cid', sequence: 2n });

      cache.setIpnsRecord('k51name', result1);
      cache.setIpnsRecord('k51name', result2);

      const retrieved = cache.getIpnsRecord('k51name');
      expect(retrieved).toEqual(result2);
      expect(retrieved!.cid).toBe('new-cid');
    });

    it('should return null after TTL expires (default 60s)', () => {
      vi.useFakeTimers();

      const result = createIpnsResult();
      cache.setIpnsRecord('name', result);

      // Still valid at 59.999 seconds
      vi.advanceTimersByTime(59_999);
      expect(cache.getIpnsRecord('name')).toEqual(result);

      // Expired at 60.001 seconds
      vi.advanceTimersByTime(2);
      expect(cache.getIpnsRecord('name')).toBeNull();
    });

    it('should respect custom TTL', () => {
      vi.useFakeTimers();

      const customCache = new IpfsCache({ ipnsTtlMs: 5_000 });
      const result = createIpnsResult();
      customCache.setIpnsRecord('name', result);

      vi.advanceTimersByTime(4_999);
      expect(customCache.getIpnsRecord('name')).toEqual(result);

      vi.advanceTimersByTime(2);
      expect(customCache.getIpnsRecord('name')).toBeNull();
    });

    it('should delete expired entries from internal map on TTL expiry', () => {
      vi.useFakeTimers();

      const result = createIpnsResult();
      cache.setIpnsRecord('name', result);

      vi.advanceTimersByTime(60_001);

      // First call returns null and deletes
      expect(cache.getIpnsRecord('name')).toBeNull();
      // getIpnsRecordIgnoreTtl should also return null since the entry was deleted
      expect(cache.getIpnsRecordIgnoreTtl('name')).toBeNull();
    });

    it('should return null after invalidation', () => {
      const result = createIpnsResult();
      cache.setIpnsRecord('name', result);

      cache.invalidateIpns('name');

      expect(cache.getIpnsRecord('name')).toBeNull();
    });

    it('should not throw when invalidating a non-existent record', () => {
      expect(() => cache.invalidateIpns('nonexistent')).not.toThrow();
    });

    it('should only invalidate the specified IPNS name', () => {
      const result1 = createIpnsResult({ cid: 'cid-a' });
      const result2 = createIpnsResult({ cid: 'cid-b' });

      cache.setIpnsRecord('name-a', result1);
      cache.setIpnsRecord('name-b', result2);

      cache.invalidateIpns('name-a');

      expect(cache.getIpnsRecord('name-a')).toBeNull();
      expect(cache.getIpnsRecord('name-b')).toEqual(result2);
    });

    it('should handle IPNS record with recordData', () => {
      const recordData = new Uint8Array([0x01, 0x02, 0x03]);
      const result = createIpnsResult({ recordData });

      cache.setIpnsRecord('name', result);

      const retrieved = cache.getIpnsRecord('name');
      expect(retrieved).toEqual(result);
      expect(retrieved!.recordData).toEqual(recordData);
    });

    it('should handle IPNS record without recordData', () => {
      const result = createIpnsResult();
      delete result.recordData;

      cache.setIpnsRecord('name', result);
      expect(cache.getIpnsRecord('name')!.recordData).toBeUndefined();
    });

    it('should reset TTL when overwriting a record', () => {
      vi.useFakeTimers();

      const result1 = createIpnsResult({ cid: 'old' });
      const result2 = createIpnsResult({ cid: 'new' });

      cache.setIpnsRecord('name', result1);

      // Advance 50s (within 60s TTL)
      vi.advanceTimersByTime(50_000);

      // Overwrite resets the TTL
      cache.setIpnsRecord('name', result2);

      // Advance another 50s (100s since first set, but only 50s since overwrite)
      vi.advanceTimersByTime(50_000);

      // Should still be valid since TTL was reset
      expect(cache.getIpnsRecord('name')).toEqual(result2);
    });
  });

  // ---------------------------------------------------------------------------
  // getIpnsRecordIgnoreTtl
  // ---------------------------------------------------------------------------

  describe('getIpnsRecordIgnoreTtl', () => {
    it('should return null for unknown IPNS name', () => {
      expect(cache.getIpnsRecordIgnoreTtl('unknown')).toBeNull();
    });

    it('should return the record within TTL', () => {
      const result = createIpnsResult();
      cache.setIpnsRecord('name', result);

      expect(cache.getIpnsRecordIgnoreTtl('name')).toEqual(result);
    });

    it('should return the record even after TTL has expired', () => {
      vi.useFakeTimers();

      const result = createIpnsResult();
      cache.setIpnsRecord('name', result);

      // Advance well past TTL
      vi.advanceTimersByTime(300_000);

      // Regular get returns null
      // But we must NOT call getIpnsRecord first because it would delete the entry
      expect(cache.getIpnsRecordIgnoreTtl('name')).toEqual(result);
    });

    it('should return null after explicit invalidation even with ignoreTtl', () => {
      const result = createIpnsResult();
      cache.setIpnsRecord('name', result);

      cache.invalidateIpns('name');

      expect(cache.getIpnsRecordIgnoreTtl('name')).toBeNull();
    });

    it('should return null after clear() even with ignoreTtl', () => {
      const result = createIpnsResult();
      cache.setIpnsRecord('name', result);

      cache.clear();

      expect(cache.getIpnsRecordIgnoreTtl('name')).toBeNull();
    });

    it('should not delete expired entries from the internal map', () => {
      vi.useFakeTimers();

      const result = createIpnsResult();
      cache.setIpnsRecord('name', result);

      vi.advanceTimersByTime(300_000);

      // Call ignoreTtl - should not remove
      const first = cache.getIpnsRecordIgnoreTtl('name');
      const second = cache.getIpnsRecordIgnoreTtl('name');

      expect(first).toEqual(result);
      expect(second).toEqual(result);
    });
  });

  // ---------------------------------------------------------------------------
  // Content Cache
  // ---------------------------------------------------------------------------

  describe('content cache', () => {
    it('should return null for unknown CID', () => {
      expect(cache.getContent('bafyunknown')).toBeNull();
    });

    it('should store and retrieve content by CID', () => {
      const data = createTxfData();
      cache.setContent('bafycid1', data);

      expect(cache.getContent('bafycid1')).toEqual(data);
    });

    it('should store content for different CIDs independently', () => {
      const data1 = createTxfData({ _meta: { version: 1, address: 'addr-1', formatVersion: '1.0', updatedAt: 100 } });
      const data2 = createTxfData({ _meta: { version: 1, address: 'addr-2', formatVersion: '1.0', updatedAt: 200 } });

      cache.setContent('cid-1', data1);
      cache.setContent('cid-2', data2);

      expect(cache.getContent('cid-1')).toEqual(data1);
      expect(cache.getContent('cid-2')).toEqual(data2);
    });

    it('should overwrite content for the same CID', () => {
      const data1 = createTxfData({ _meta: { version: 1, address: 'old', formatVersion: '1.0', updatedAt: 100 } });
      const data2 = createTxfData({ _meta: { version: 2, address: 'new', formatVersion: '2.0', updatedAt: 200 } });

      cache.setContent('cid', data1);
      cache.setContent('cid', data2);

      expect(cache.getContent('cid')).toEqual(data2);
    });

    it('should have infinite TTL (content never expires)', () => {
      vi.useFakeTimers();

      const data = createTxfData();
      cache.setContent('bafycid', data);

      // Advance far into the future
      vi.advanceTimersByTime(24 * 60 * 60 * 1000); // 24 hours

      expect(cache.getContent('bafycid')).toEqual(data);
    });

    it('should handle content with additional token entries', () => {
      const data = createTxfData();
      (data as Record<string, unknown>)['_token123'] = { state: 'active' };

      cache.setContent('cid', data);

      const retrieved = cache.getContent('cid');
      expect((retrieved as Record<string, unknown>)['_token123']).toEqual({ state: 'active' });
    });
  });

  // ---------------------------------------------------------------------------
  // Gateway Failure Tracking (Circuit Breaker)
  // ---------------------------------------------------------------------------

  describe('gateway failure tracking (circuit breaker)', () => {
    it('should not be in cooldown for an unknown gateway', () => {
      expect(cache.isGatewayInCooldown('https://unknown-gateway.io')).toBe(false);
    });

    it('should not trigger cooldown for a single failure', () => {
      cache.recordGatewayFailure('https://gw.io');

      expect(cache.isGatewayInCooldown('https://gw.io')).toBe(false);
    });

    it('should not trigger cooldown for 2 failures (below threshold of 3)', () => {
      cache.recordGatewayFailure('https://gw.io');
      cache.recordGatewayFailure('https://gw.io');

      expect(cache.isGatewayInCooldown('https://gw.io')).toBe(false);
    });

    it('should trigger cooldown after 3 consecutive failures (default threshold)', () => {
      cache.recordGatewayFailure('https://gw.io');
      cache.recordGatewayFailure('https://gw.io');
      cache.recordGatewayFailure('https://gw.io');

      expect(cache.isGatewayInCooldown('https://gw.io')).toBe(true);
    });

    it('should trigger cooldown after more than threshold failures', () => {
      for (let i = 0; i < 5; i++) {
        cache.recordGatewayFailure('https://gw.io');
      }

      expect(cache.isGatewayInCooldown('https://gw.io')).toBe(true);
    });

    it('should respect custom failure threshold', () => {
      const customCache = new IpfsCache({ failureThreshold: 5 });

      for (let i = 0; i < 4; i++) {
        customCache.recordGatewayFailure('https://gw.io');
      }
      expect(customCache.isGatewayInCooldown('https://gw.io')).toBe(false);

      customCache.recordGatewayFailure('https://gw.io');
      expect(customCache.isGatewayInCooldown('https://gw.io')).toBe(true);
    });

    it('should reset failure count on success', () => {
      cache.recordGatewayFailure('https://gw.io');
      cache.recordGatewayFailure('https://gw.io');
      cache.recordGatewayFailure('https://gw.io');

      expect(cache.isGatewayInCooldown('https://gw.io')).toBe(true);

      cache.recordGatewaySuccess('https://gw.io');

      expect(cache.isGatewayInCooldown('https://gw.io')).toBe(false);
    });

    it('should allow new failures to accumulate after success reset', () => {
      // Trip the circuit breaker
      cache.recordGatewayFailure('https://gw.io');
      cache.recordGatewayFailure('https://gw.io');
      cache.recordGatewayFailure('https://gw.io');
      expect(cache.isGatewayInCooldown('https://gw.io')).toBe(true);

      // Reset
      cache.recordGatewaySuccess('https://gw.io');
      expect(cache.isGatewayInCooldown('https://gw.io')).toBe(false);

      // Need 3 more failures to trip again
      cache.recordGatewayFailure('https://gw.io');
      cache.recordGatewayFailure('https://gw.io');
      expect(cache.isGatewayInCooldown('https://gw.io')).toBe(false);

      cache.recordGatewayFailure('https://gw.io');
      expect(cache.isGatewayInCooldown('https://gw.io')).toBe(true);
    });

    it('should expire cooldown after cooldown period (default 60s)', () => {
      vi.useFakeTimers();

      cache.recordGatewayFailure('https://gw.io');
      cache.recordGatewayFailure('https://gw.io');
      cache.recordGatewayFailure('https://gw.io');

      expect(cache.isGatewayInCooldown('https://gw.io')).toBe(true);

      // Advance just under cooldown
      vi.advanceTimersByTime(59_999);
      expect(cache.isGatewayInCooldown('https://gw.io')).toBe(true);

      // Advance past cooldown
      vi.advanceTimersByTime(2);
      expect(cache.isGatewayInCooldown('https://gw.io')).toBe(false);
    });

    it('should respect custom cooldown period', () => {
      vi.useFakeTimers();

      const customCache = new IpfsCache({ failureCooldownMs: 10_000 });

      customCache.recordGatewayFailure('https://gw.io');
      customCache.recordGatewayFailure('https://gw.io');
      customCache.recordGatewayFailure('https://gw.io');

      expect(customCache.isGatewayInCooldown('https://gw.io')).toBe(true);

      vi.advanceTimersByTime(9_999);
      expect(customCache.isGatewayInCooldown('https://gw.io')).toBe(true);

      vi.advanceTimersByTime(2);
      expect(customCache.isGatewayInCooldown('https://gw.io')).toBe(false);
    });

    it('should clean up internal state when cooldown expires', () => {
      vi.useFakeTimers();

      cache.recordGatewayFailure('https://gw.io');
      cache.recordGatewayFailure('https://gw.io');
      cache.recordGatewayFailure('https://gw.io');

      vi.advanceTimersByTime(60_001);

      // Calling isGatewayInCooldown should delete the expired entry
      expect(cache.isGatewayInCooldown('https://gw.io')).toBe(false);
      // Subsequent call confirms it's cleaned up
      expect(cache.isGatewayInCooldown('https://gw.io')).toBe(false);
    });

    it('should track different gateways independently', () => {
      cache.recordGatewayFailure('https://gw-a.io');
      cache.recordGatewayFailure('https://gw-a.io');
      cache.recordGatewayFailure('https://gw-a.io');

      cache.recordGatewayFailure('https://gw-b.io');

      expect(cache.isGatewayInCooldown('https://gw-a.io')).toBe(true);
      expect(cache.isGatewayInCooldown('https://gw-b.io')).toBe(false);
    });

    it('should not throw when recording success for an unknown gateway', () => {
      expect(() => cache.recordGatewaySuccess('https://never-failed.io')).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Known-Fresh Flag
  // ---------------------------------------------------------------------------

  describe('known-fresh flag', () => {
    it('should return false for an unknown IPNS name', () => {
      expect(cache.isIpnsKnownFresh('unknown')).toBe(false);
    });

    it('should return true immediately after marking as fresh', () => {
      cache.markIpnsFresh('name');

      expect(cache.isIpnsKnownFresh('name')).toBe(true);
    });

    it('should return true within the fresh window (default 30s)', () => {
      vi.useFakeTimers();

      cache.markIpnsFresh('name');

      vi.advanceTimersByTime(29_999);
      expect(cache.isIpnsKnownFresh('name')).toBe(true);
    });

    it('should return false after the fresh window expires (default 30s)', () => {
      vi.useFakeTimers();

      cache.markIpnsFresh('name');

      vi.advanceTimersByTime(30_001);
      expect(cache.isIpnsKnownFresh('name')).toBe(false);
    });

    it('should respect custom fresh window', () => {
      vi.useFakeTimers();

      const customCache = new IpfsCache({ knownFreshWindowMs: 5_000 });

      customCache.markIpnsFresh('name');

      vi.advanceTimersByTime(4_999);
      expect(customCache.isIpnsKnownFresh('name')).toBe(true);

      vi.advanceTimersByTime(2);
      expect(customCache.isIpnsKnownFresh('name')).toBe(false);
    });

    it('should clean up expired entries from internal map', () => {
      vi.useFakeTimers();

      cache.markIpnsFresh('name');

      vi.advanceTimersByTime(30_001);

      // First call deletes the entry
      expect(cache.isIpnsKnownFresh('name')).toBe(false);
      // Subsequent call confirms deletion
      expect(cache.isIpnsKnownFresh('name')).toBe(false);
    });

    it('should track different IPNS names independently', () => {
      vi.useFakeTimers();

      cache.markIpnsFresh('name-a');

      vi.advanceTimersByTime(15_000);

      cache.markIpnsFresh('name-b');

      vi.advanceTimersByTime(16_000);

      // name-a: 31s elapsed -> expired
      expect(cache.isIpnsKnownFresh('name-a')).toBe(false);
      // name-b: 16s elapsed -> still fresh
      expect(cache.isIpnsKnownFresh('name-b')).toBe(true);
    });

    it('should reset fresh window when marked again', () => {
      vi.useFakeTimers();

      cache.markIpnsFresh('name');

      vi.advanceTimersByTime(25_000);
      expect(cache.isIpnsKnownFresh('name')).toBe(true);

      // Re-mark as fresh, resetting the window
      cache.markIpnsFresh('name');

      vi.advanceTimersByTime(25_000);
      // 25s since re-mark, within 30s window
      expect(cache.isIpnsKnownFresh('name')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // clear()
  // ---------------------------------------------------------------------------

  describe('clear()', () => {
    it('should clear IPNS records', () => {
      cache.setIpnsRecord('name', createIpnsResult());

      cache.clear();

      expect(cache.getIpnsRecord('name')).toBeNull();
    });

    it('should clear content cache', () => {
      cache.setContent('cid', createTxfData());

      cache.clear();

      expect(cache.getContent('cid')).toBeNull();
    });

    it('should clear gateway failure tracking', () => {
      cache.recordGatewayFailure('https://gw.io');
      cache.recordGatewayFailure('https://gw.io');
      cache.recordGatewayFailure('https://gw.io');
      expect(cache.isGatewayInCooldown('https://gw.io')).toBe(true);

      cache.clear();

      expect(cache.isGatewayInCooldown('https://gw.io')).toBe(false);
    });

    it('should clear known-fresh timestamps', () => {
      cache.markIpnsFresh('name');
      expect(cache.isIpnsKnownFresh('name')).toBe(true);

      cache.clear();

      expect(cache.isIpnsKnownFresh('name')).toBe(false);
    });

    it('should clear everything at once', () => {
      // Populate all caches
      cache.setIpnsRecord('ipns-name', createIpnsResult());
      cache.setContent('content-cid', createTxfData());
      cache.recordGatewayFailure('https://gw.io');
      cache.recordGatewayFailure('https://gw.io');
      cache.recordGatewayFailure('https://gw.io');
      cache.markIpnsFresh('fresh-name');

      // Verify populated
      expect(cache.getIpnsRecord('ipns-name')).not.toBeNull();
      expect(cache.getContent('content-cid')).not.toBeNull();
      expect(cache.isGatewayInCooldown('https://gw.io')).toBe(true);
      expect(cache.isIpnsKnownFresh('fresh-name')).toBe(true);

      cache.clear();

      // Verify all cleared
      expect(cache.getIpnsRecord('ipns-name')).toBeNull();
      expect(cache.getContent('content-cid')).toBeNull();
      expect(cache.isGatewayInCooldown('https://gw.io')).toBe(false);
      expect(cache.isIpnsKnownFresh('fresh-name')).toBe(false);
    });

    it('should allow re-use after clear', () => {
      cache.setIpnsRecord('name', createIpnsResult({ cid: 'old' }));
      cache.clear();

      const newResult = createIpnsResult({ cid: 'new' });
      cache.setIpnsRecord('name', newResult);

      expect(cache.getIpnsRecord('name')).toEqual(newResult);
    });

    it('should not throw when called on an empty cache', () => {
      expect(() => cache.clear()).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Edge Cases / Interaction between features
  // ---------------------------------------------------------------------------

  describe('cross-feature interactions', () => {
    it('should not confuse IPNS records and content with same key', () => {
      const ipnsResult = createIpnsResult({ cid: 'ipns-cid' });
      const contentData = createTxfData();

      // Use the same string as both an IPNS name and a content CID
      cache.setIpnsRecord('shared-key', ipnsResult);
      cache.setContent('shared-key', contentData);

      expect(cache.getIpnsRecord('shared-key')).toEqual(ipnsResult);
      expect(cache.getContent('shared-key')).toEqual(contentData);

      // Invalidating IPNS should not affect content
      cache.invalidateIpns('shared-key');
      expect(cache.getIpnsRecord('shared-key')).toBeNull();
      expect(cache.getContent('shared-key')).toEqual(contentData);
    });

    it('should handle bigint sequence numbers correctly', () => {
      const result = createIpnsResult({ sequence: 9007199254740993n }); // > Number.MAX_SAFE_INTEGER

      cache.setIpnsRecord('name', result);

      const retrieved = cache.getIpnsRecord('name');
      expect(retrieved!.sequence).toBe(9007199254740993n);
    });

    it('getIpnsRecord TTL expiry should not affect getIpnsRecordIgnoreTtl for different entries', () => {
      vi.useFakeTimers();

      cache.setIpnsRecord('name-a', createIpnsResult({ cid: 'a' }));
      cache.setIpnsRecord('name-b', createIpnsResult({ cid: 'b' }));

      vi.advanceTimersByTime(60_001);

      // Expire name-a via regular get (deletes it)
      expect(cache.getIpnsRecord('name-a')).toBeNull();

      // name-b should still be accessible via ignoreTtl (not yet deleted)
      expect(cache.getIpnsRecordIgnoreTtl('name-b')).toEqual(
        expect.objectContaining({ cid: 'b' }),
      );
    });
  });
});
