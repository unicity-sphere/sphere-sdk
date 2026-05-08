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
  MAX_TRUSTED_SENDERS,
  MAX_UNTRUSTED_SENDERS,
  ReplayLRU,
} from '../../../../modules/payments/transfer/replay-lru';

// =============================================================================
// 1. Module-level constants — pin the spec defaults
// =============================================================================

describe('ReplayLRU constants', () => {
  it('MAX_PER_SENDER === 64', () => {
    expect(MAX_PER_SENDER).toBe(64);
  });

  it('MAX_UNTRUSTED_SENDERS === 64 (Option B post-steelman absorber pool)', () => {
    // Sybil churn lands here; bigger value would bloat memory without
    // benefit since untrusted entries are short-lived by design (they
    // graduate on first verified bundle).
    expect(MAX_UNTRUSTED_SENDERS).toBe(64);
  });

  it('MAX_TRUSTED_SENDERS === 256 (Option B post-steelman protected pool)', () => {
    // Senders that have shipped at least one verified bundle. Immune to
    // sybil-driven bucket eviction since this pool is independent.
    expect(MAX_TRUSTED_SENDERS).toBe(256);
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

  it('rejects maxUntrustedSenders <= 0', () => {
    expect(() => new ReplayLRU({ maxUntrustedSenders: 0 })).toThrow(RangeError);
  });

  it('rejects maxTrustedSenders <= 0', () => {
    expect(() => new ReplayLRU({ maxTrustedSenders: 0 })).toThrow(RangeError);
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

describe('ReplayLRU global sender-bucket cap (untrusted pool)', () => {
  it('evicts oldest sender bucket when maxUntrustedSenders is exceeded', () => {
    // Tight maxUntrustedSenders for a fast test.
    const lru = new ReplayLRU({ maxUntrustedSenders: 3 });
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
    const lru = new ReplayLRU({ maxUntrustedSenders: 3 });
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
    const lru = new ReplayLRU({ maxPerSender: 4, maxUntrustedSenders: 2 });
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

// =============================================================================
// 7. Option B post-steelman — trusted/untrusted bucket split
// =============================================================================

describe('ReplayLRU trusted/untrusted bucket split (Option B post-steelman)', () => {
  it('a fresh sender lands in the untrusted pool', () => {
    const lru = new ReplayLRU();
    lru.add('alice', 'cid-1');
    expect(lru.untrustedSenderCount).toBe(1);
    expect(lru.trustedSenderCount).toBe(0);
    expect(lru.isTrusted('alice')).toBe(false);
  });

  it('markSenderTrusted graduates a sender into the trusted pool with bucket preserved', () => {
    const lru = new ReplayLRU();
    lru.add('alice', 'cid-1');
    lru.add('alice', 'cid-2');
    expect(lru.has('alice', 'cid-1')).toBe(true);
    expect(lru.has('alice', 'cid-2')).toBe(true);

    lru.markSenderTrusted('alice');
    expect(lru.isTrusted('alice')).toBe(true);
    expect(lru.untrustedSenderCount).toBe(0);
    expect(lru.trustedSenderCount).toBe(1);
    // Both bundleCids preserved across the migration.
    expect(lru.has('alice', 'cid-1')).toBe(true);
    expect(lru.has('alice', 'cid-2')).toBe(true);
  });

  it('markSenderTrusted is idempotent (no-op on already-trusted sender)', () => {
    const lru = new ReplayLRU();
    lru.add('alice', 'cid-1');
    lru.markSenderTrusted('alice');
    expect(lru.trustedSenderCount).toBe(1);

    // Calling again should be a no-op.
    lru.markSenderTrusted('alice');
    expect(lru.trustedSenderCount).toBe(1);
    expect(lru.untrustedSenderCount).toBe(0);
    expect(lru.has('alice', 'cid-1')).toBe(true);
  });

  it('markSenderTrusted on never-seen sender creates an empty trusted bucket', () => {
    // Edge case: the acquirer happens to call markSenderTrusted before
    // add() (unlikely in production but defensively covered). No prior
    // bucket exists; a fresh empty bucket is created in the trusted pool.
    const lru = new ReplayLRU();
    lru.markSenderTrusted('alice');
    expect(lru.isTrusted('alice')).toBe(true);
    expect(lru.bucketSize('alice')).toBe(0);

    // Subsequent add() targets the existing trusted bucket (NOT
    // untrusted), preserving the trust relationship.
    lru.add('alice', 'cid-1');
    expect(lru.isTrusted('alice')).toBe(true);
    expect(lru.has('alice', 'cid-1')).toBe(true);
    expect(lru.untrustedSenderCount).toBe(0);
  });

  it('after graduation, subsequent add() on the same sender stays in the trusted pool', () => {
    const lru = new ReplayLRU();
    lru.add('alice', 'cid-1');
    lru.markSenderTrusted('alice');
    lru.add('alice', 'cid-2'); // post-graduation add
    expect(lru.isTrusted('alice')).toBe(true);
    expect(lru.untrustedSenderCount).toBe(0);
    expect(lru.has('alice', 'cid-1')).toBe(true);
    expect(lru.has('alice', 'cid-2')).toBe(true);
  });

  it('CRITICAL: trusted bucket survives an unbounded untrusted sybil flood', () => {
    // Scenario: honest Alice ships a verified bundle, graduates to
    // trusted. Sybil attacker churns 1000 distinct ephemeral pubkeys
    // afterwards (each one a fresh untrusted sender). With Option B,
    // sybil churn fills/cycles the UNTRUSTED pool only — Alice's
    // trusted bucket is untouchable.
    const lru = new ReplayLRU();
    lru.add('alice', 'alice-cid');
    lru.markSenderTrusted('alice');
    expect(lru.has('alice', 'alice-cid')).toBe(true);

    // Sybil flood: 1000 distinct pubkeys, each adding a junk CID.
    for (let i = 0; i < 1000; i++) {
      lru.add(`sybil-${i}`.padEnd(64, '0'), `junk-${i}`);
    }

    // Alice's trusted bucket survives intact.
    expect(lru.isTrusted('alice')).toBe(true);
    expect(lru.has('alice', 'alice-cid')).toBe(true);
    // Untrusted pool capped at MAX_UNTRUSTED_SENDERS (64).
    expect(lru.untrustedSenderCount).toBeLessThanOrEqual(MAX_UNTRUSTED_SENDERS);
    // Trusted pool unchanged.
    expect(lru.trustedSenderCount).toBe(1);
  });

  it('property: untrusted churn at any rate cannot evict trusted entries', () => {
    // Generalizes the previous scenario across multiple trusted senders
    // and an interleaved sybil flood. Every trusted entry MUST survive.
    const lru = new ReplayLRU();
    const trusted = ['alice', 'bob', 'carol', 'dave', 'eve'];
    for (const t of trusted) {
      lru.add(t, `${t}-cid`);
      lru.markSenderTrusted(t);
    }
    // Massive untrusted flood, interleaved (just to make sure recency
    // pressure on the untrusted pool cannot somehow leak across pools).
    for (let i = 0; i < 5000; i++) {
      lru.add(`u-${i}`.padEnd(64, '0'), `cid-${i}`);
    }
    for (const t of trusted) {
      expect(lru.has(t, `${t}-cid`)).toBe(true);
      expect(lru.isTrusted(t)).toBe(true);
    }
    // Trusted-pool sender count is still 5 — sybil flood cannot push
    // a trusted sender out.
    expect(lru.trustedSenderCount).toBe(5);
  });

  it('trusted-pool overflow evicts ONLY the LRA trusted sender (never untrusted)', () => {
    // Bounded trusted pool of 3. Graduate 4 senders sequentially —
    // the oldest trusted sender gets evicted. Untrusted senders are
    // unaffected.
    const lru = new ReplayLRU({ maxTrustedSenders: 3 });
    // Park an untrusted sender first to verify it is NOT evicted by
    // trusted-pool churn.
    lru.add('untrusted-witness', 'witness-cid');
    expect(lru.untrustedSenderCount).toBe(1);

    lru.add('t1', 'cid');
    lru.markSenderTrusted('t1');
    lru.add('t2', 'cid');
    lru.markSenderTrusted('t2');
    lru.add('t3', 'cid');
    lru.markSenderTrusted('t3');
    expect(lru.trustedSenderCount).toBe(3);

    // 4th graduation evicts t1 (the LRA in the trusted pool).
    lru.add('t4', 'cid');
    lru.markSenderTrusted('t4');
    expect(lru.trustedSenderCount).toBe(3);
    expect(lru.isTrusted('t1')).toBe(false);
    expect(lru.has('t1', 'cid')).toBe(false);

    // The untrusted witness is untouched.
    expect(lru.has('untrusted-witness', 'witness-cid')).toBe(true);
    expect(lru.untrustedSenderCount).toBe(1);
  });

  it('graduation test: unknown sender → has() expected miss; markSenderTrusted called → has() now hits in trusted pool', () => {
    // Threat path the steelman finding identifies: a sender's first
    // access is in untrusted; after pkg.verify() succeeds the acquirer
    // calls markSenderTrusted; subsequent has() hits in the trusted
    // pool and is immune to sybil churn.
    const lru = new ReplayLRU();

    // Unknown sender — has() returns false.
    expect(lru.has('alice', 'cid-1')).toBe(false);

    // First arrival: enters untrusted pool.
    lru.add('alice', 'cid-1');
    expect(lru.has('alice', 'cid-1')).toBe(true);
    expect(lru.isTrusted('alice')).toBe(false);

    // Acquirer marks trusted post-verify.
    lru.markSenderTrusted('alice');
    expect(lru.isTrusted('alice')).toBe(true);

    // Sybil flood the untrusted pool.
    for (let i = 0; i < 500; i++) {
      lru.add(`sybil-${i}`.padEnd(64, '0'), `junk-${i}`);
    }

    // Alice still hits — she's in trusted, immune.
    expect(lru.has('alice', 'cid-1')).toBe(true);
  });

  it('memory bound: trusted (256×64) + untrusted (64×64) = 20480 entries worst case', () => {
    // Sanity check: the full default caps loaded simultaneously yield
    // the documented bound. Use distinct (collision-free) sender ids;
    // pad-then-prefix avoids collisions between e.g. "u-1" + 61 zeros
    // and "u-10" + 60 zeros, which produce the same string.
    const lru = new ReplayLRU();
    // Fill trusted pool to capacity.
    for (let s = 0; s < MAX_TRUSTED_SENDERS; s++) {
      for (let c = 0; c < 64; c++) {
        lru.add(`t-${s}`, `cid-${s}-${c}`);
      }
      lru.markSenderTrusted(`t-${s}`);
    }
    // Fill untrusted pool to capacity (with senders that never
    // graduate). Use a numeric suffix as the LAST chars so distinct
    // `s` values always produce distinct strings regardless of length.
    for (let s = 0; s < MAX_UNTRUSTED_SENDERS; s++) {
      const senderId = `u-${String(s).padStart(60, '0')}`;
      for (let c = 0; c < 64; c++) {
        lru.add(senderId, `cid-${s}-${c}`);
      }
    }
    expect(lru.trustedSenderCount).toBe(MAX_TRUSTED_SENDERS);
    expect(lru.untrustedSenderCount).toBe(MAX_UNTRUSTED_SENDERS);
    expect(lru.totalEntries).toBe(
      (MAX_TRUSTED_SENDERS + MAX_UNTRUSTED_SENDERS) * 64,
    );
  });
});
