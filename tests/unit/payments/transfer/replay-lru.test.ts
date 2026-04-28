/**
 * Tests for `modules/payments/transfer/replay-lru.ts` (T.3.A) —
 * per-sender-bucketed replay LRU with Note N5 cross-sender eviction
 * defense.
 *
 * Spec references:
 *  - §5.1   Replay handling (LRU is purely an optimization).
 *  - §5.6   Idempotency invariants.
 *
 * Key Note N5 invariant verified here: a hostile sender flooding the
 * LRU with junk bundleCids MUST NOT evict an honest sender's entries
 * — buckets are private per sender pubkey.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_PER_SENDER,
  MAX_SENDERS,
  ReplayLRU,
} from '../../../../modules/payments/transfer/replay-lru';

// =============================================================================
// 1. Module-level constants — pin the spec defaults
// =============================================================================

describe('ReplayLRU constants', () => {
  it('MAX_PER_SENDER === 64', () => {
    expect(MAX_PER_SENDER).toBe(64);
  });

  it('MAX_SENDERS === 32', () => {
    expect(MAX_SENDERS).toBe(32);
  });
});

// =============================================================================
// 2. Construction
// =============================================================================

describe('ReplayLRU construction', () => {
  it('default ctor has zero senders and zero entries', () => {
    const lru = new ReplayLRU();
    expect(lru.senderCount).toBe(0);
    expect(lru.totalEntries).toBe(0);
  });

  it('rejects maxPerSender <= 0', () => {
    expect(() => new ReplayLRU({ maxPerSender: 0 })).toThrow(RangeError);
    expect(() => new ReplayLRU({ maxPerSender: -1 })).toThrow(RangeError);
  });

  it('rejects non-finite maxPerSender', () => {
    expect(() => new ReplayLRU({ maxPerSender: Number.NaN })).toThrow(RangeError);
    expect(() => new ReplayLRU({ maxPerSender: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });

  it('rejects maxSenders <= 0', () => {
    expect(() => new ReplayLRU({ maxSenders: 0 })).toThrow(RangeError);
  });
});

// =============================================================================
// 3. Basic add/has semantics
// =============================================================================

describe('ReplayLRU basic add/has', () => {
  it('has() returns false before any add()', () => {
    const lru = new ReplayLRU();
    expect(lru.has('alice', 'bafyA')).toBe(false);
  });

  it('add() then has() returns true for the same pair', () => {
    const lru = new ReplayLRU();
    lru.add('alice', 'bafyA');
    expect(lru.has('alice', 'bafyA')).toBe(true);
  });

  it('has() differentiates by senderPubkey', () => {
    const lru = new ReplayLRU();
    lru.add('alice', 'bafyA');
    expect(lru.has('alice', 'bafyA')).toBe(true);
    // Same bundleCid, different sender → not in their bucket.
    expect(lru.has('bob', 'bafyA')).toBe(false);
  });

  it('add() is idempotent — re-adding same pair does not grow size', () => {
    const lru = new ReplayLRU();
    lru.add('alice', 'bafyA');
    lru.add('alice', 'bafyA');
    lru.add('alice', 'bafyA');
    expect(lru.totalEntries).toBe(1);
    expect(lru.bucketSize('alice')).toBe(1);
    expect(lru.has('alice', 'bafyA')).toBe(true);
  });

  it('clear() empties the entire LRU', () => {
    const lru = new ReplayLRU();
    lru.add('alice', 'bafyA');
    lru.add('bob', 'bafyB');
    expect(lru.senderCount).toBe(2);
    lru.clear();
    expect(lru.senderCount).toBe(0);
    expect(lru.totalEntries).toBe(0);
    expect(lru.has('alice', 'bafyA')).toBe(false);
  });
});

// =============================================================================
// 4. Per-sender LRU eviction (within bucket)
// =============================================================================

describe('ReplayLRU per-sender bucket eviction', () => {
  it('evicts oldest entry within sender bucket when cap is exceeded', () => {
    // Use a small cap for fast test.
    const lru = new ReplayLRU({ maxPerSender: 3 });
    lru.add('alice', 'cid-1');
    lru.add('alice', 'cid-2');
    lru.add('alice', 'cid-3');
    expect(lru.bucketSize('alice')).toBe(3);

    // Fourth add evicts cid-1.
    lru.add('alice', 'cid-4');
    expect(lru.bucketSize('alice')).toBe(3);
    expect(lru.has('alice', 'cid-1')).toBe(false);
    expect(lru.has('alice', 'cid-2')).toBe(true);
    expect(lru.has('alice', 'cid-3')).toBe(true);
    expect(lru.has('alice', 'cid-4')).toBe(true);
  });

  it('refreshing recency on existing entry moves it to back', () => {
    const lru = new ReplayLRU({ maxPerSender: 3 });
    lru.add('alice', 'cid-1');
    lru.add('alice', 'cid-2');
    lru.add('alice', 'cid-3');
    // Refresh cid-1 — it should now be the most recent.
    lru.add('alice', 'cid-1');
    // Adding cid-4 should evict cid-2 (now the oldest), not cid-1.
    lru.add('alice', 'cid-4');
    expect(lru.has('alice', 'cid-1')).toBe(true);
    expect(lru.has('alice', 'cid-2')).toBe(false);
    expect(lru.has('alice', 'cid-3')).toBe(true);
    expect(lru.has('alice', 'cid-4')).toBe(true);
  });
});

// =============================================================================
// 5. Cross-sender eviction defense (Note N5) — THE CRITICAL TEST
// =============================================================================

describe('ReplayLRU Note N5 — hostile sender cannot evict honest entries', () => {
  it('honest sender entries survive a flood from a hostile sender', () => {
    // Default per-sender cap (64); hostile sender publishes 1000 bundleCids.
    // The hostile flood should fill ITS OWN bucket only.
    const lru = new ReplayLRU();
    lru.add('honest', 'honest-cid-1');
    lru.add('honest', 'honest-cid-2');
    lru.add('honest', 'honest-cid-3');

    // Flood 1000 hostile entries.
    for (let i = 0; i < 1000; i++) {
      lru.add('hostile', `hostile-cid-${i}`);
    }

    // Honest sender's entries must be intact.
    expect(lru.has('honest', 'honest-cid-1')).toBe(true);
    expect(lru.has('honest', 'honest-cid-2')).toBe(true);
    expect(lru.has('honest', 'honest-cid-3')).toBe(true);
    expect(lru.bucketSize('honest')).toBe(3);

    // Hostile sender's bucket should have been trimmed to MAX_PER_SENDER.
    expect(lru.bucketSize('hostile')).toBe(MAX_PER_SENDER);
  });

  it('multiple honest senders survive a hostile flood', () => {
    const lru = new ReplayLRU();
    const honestSenders = ['alice', 'bob', 'carol', 'dave'];
    for (const sender of honestSenders) {
      lru.add(sender, `${sender}-cid`);
    }

    // Flood from a hostile sender.
    for (let i = 0; i < 500; i++) {
      lru.add('hostile', `cid-${i}`);
    }

    // Every honest sender's single entry should still be present.
    for (const sender of honestSenders) {
      expect(lru.has(sender, `${sender}-cid`)).toBe(true);
    }
  });

  it('hostile cannot evict honest by reusing the same bundleCid as honest', () => {
    // The (sender, cid) pairing means "alice's bafyA" and "hostile's
    // bafyA" are SEPARATE entries living in SEPARATE buckets.
    const lru = new ReplayLRU();
    lru.add('alice', 'bafyA');
    expect(lru.has('alice', 'bafyA')).toBe(true);
    // Hostile adds the same CID — to their OWN bucket, not Alice's.
    lru.add('hostile', 'bafyA');
    // Both pairs are tracked independently.
    expect(lru.has('alice', 'bafyA')).toBe(true);
    expect(lru.has('hostile', 'bafyA')).toBe(true);
    // Hostile floods their own bucket — alice's entry is untouched.
    for (let i = 0; i < 500; i++) {
      lru.add('hostile', `cid-${i}`);
    }
    expect(lru.has('alice', 'bafyA')).toBe(true);
  });
});

// =============================================================================
// 6. Global sender-bucket cap eviction
// =============================================================================

describe('ReplayLRU global sender-bucket cap', () => {
  it('evicts oldest sender bucket when maxSenders is exceeded', () => {
    // Tight maxSenders for a fast test.
    const lru = new ReplayLRU({ maxSenders: 3 });
    lru.add('sender-1', 'cid');
    lru.add('sender-2', 'cid');
    lru.add('sender-3', 'cid');
    expect(lru.senderCount).toBe(3);

    // Adding a 4th sender should evict sender-1's entire bucket.
    lru.add('sender-4', 'cid');
    expect(lru.senderCount).toBe(3);
    expect(lru.has('sender-1', 'cid')).toBe(false); // evicted
    expect(lru.has('sender-2', 'cid')).toBe(true);
    expect(lru.has('sender-3', 'cid')).toBe(true);
    expect(lru.has('sender-4', 'cid')).toBe(true);
  });

  it('refreshing a sender via add() moves it to most-recent position', () => {
    const lru = new ReplayLRU({ maxSenders: 3 });
    lru.add('sender-1', 'cid-a');
    lru.add('sender-2', 'cid-a');
    lru.add('sender-3', 'cid-a');

    // Refresh sender-1 by adding another entry — it should move to back.
    lru.add('sender-1', 'cid-b');

    // Now adding sender-4 should evict sender-2 (the oldest).
    lru.add('sender-4', 'cid-a');
    expect(lru.has('sender-1', 'cid-a')).toBe(true);
    expect(lru.has('sender-1', 'cid-b')).toBe(true);
    expect(lru.has('sender-2', 'cid-a')).toBe(false); // evicted
    expect(lru.has('sender-3', 'cid-a')).toBe(true);
    expect(lru.has('sender-4', 'cid-a')).toBe(true);
  });

  it('totalEntries reflects per-sender and global eviction', () => {
    const lru = new ReplayLRU({ maxPerSender: 4, maxSenders: 2 });
    // sender-1 adds 5 cids — last 4 stay (per-sender LRU evicts oldest).
    for (let i = 0; i < 5; i++) lru.add('sender-1', `cid-${i}`);
    expect(lru.bucketSize('sender-1')).toBe(4);

    // sender-2 adds 3 cids.
    for (let i = 0; i < 3; i++) lru.add('sender-2', `cid-${i}`);
    expect(lru.totalEntries).toBe(7);

    // sender-3 arrives — sender-1's whole bucket is evicted.
    lru.add('sender-3', 'lone-cid');
    expect(lru.has('sender-1', 'cid-4')).toBe(false);
    expect(lru.totalEntries).toBe(3 + 1); // sender-2 (3) + sender-3 (1)
  });
});
