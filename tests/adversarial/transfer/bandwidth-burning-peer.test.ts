/**
 * Adversarial test — bandwidth-burning peer flood (§5.1 Note N5, §11.4).
 *
 * Threat model: a hostile sender drives a high-rate publish pipeline
 * with thousands of distinct `bundleCid` values per second, hoping
 * to either:
 *   1. Evict honest senders' LRU entries — making honest replays go
 *      through the full §5.2 verification pipeline (CPU drain via
 *      cross-sender LRU pollution).
 *   2. Exhaust memory if the LRU were unbounded.
 *
 * Spec defense (Note N5, normative):
 *   "The LRU is PARTITIONED by sender pubkey. Each sender gets a
 *    private sub-bucket; a hostile sender can ONLY evict entries from
 *    their OWN bucket. Honest senders' entries are protected by
 *    isolation, not by sheer LRU size."
 *
 * Plus a bounded global cap (`maxSenders`) so a hostile peer cannot
 * spawn 1M ephemeral pubkeys to bloat the bucket-keyed Map either.
 *
 * What this test pins:
 *   1. **Honest entries survive**: a hostile flood of 10,000 distinct
 *      CIDs from one pubkey does NOT evict any honest sender's
 *      entries.
 *   2. **Per-sender memory bound**: the hostile bucket caps at
 *      MAX_PER_SENDER (default 64) regardless of input rate. Memory
 *      growth is O(maxSenders × MAX_PER_SENDER), bounded.
 *   3. **Cross-sender flood does NOT cascade**: even if the hostile
 *      sender SPRAYS thousands of distinct sender-pubkeys (sybil
 *      attack vector), the global maxSenders cap kicks in and at
 *      most maxSenders distinct senders are tracked.
 *   4. **Honest sender activity refreshes recency**: an honest sender
 *      who keeps publishing during the flood is NEVER evicted by the
 *      sender-bucket eviction tier — they stay "active" in the
 *      Map's iteration order.
 *
 * Spec references: §5.1 Note N5, §11.4.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_PER_SENDER,
  MAX_TRUSTED_SENDERS,
  MAX_UNTRUSTED_SENDERS,
  ReplayLRU,
} from '../../../modules/payments/transfer/replay-lru';

const HONEST_ALICE = 'a'.repeat(64);
const HONEST_BOB = 'b'.repeat(64);
const HONEST_CAROL = 'c'.repeat(64);
const HOSTILE = 'f'.repeat(64);

describe('§5.1 Note N5 — bandwidth-burning peer cannot evict honest senders', () => {
  it('honest entries survive a 10,000-CID hostile flood', async () => {
    const lru = new ReplayLRU();

    // Three honest senders each register one entry.
    lru.add(HONEST_ALICE, 'cid-alice-1');
    lru.add(HONEST_BOB, 'cid-bob-1');
    lru.add(HONEST_CAROL, 'cid-carol-1');

    // Hostile flood — 10,000 distinct CIDs from a single sender.
    for (let i = 0; i < 10_000; i++) {
      lru.add(HOSTILE, `hostile-cid-${i}`);
    }

    // CRITICAL invariant 1: every honest entry is intact.
    expect(lru.has(HONEST_ALICE, 'cid-alice-1')).toBe(true);
    expect(lru.has(HONEST_BOB, 'cid-bob-1')).toBe(true);
    expect(lru.has(HONEST_CAROL, 'cid-carol-1')).toBe(true);

    // CRITICAL invariant 2: hostile bucket is bounded.
    expect(lru.bucketSize(HOSTILE)).toBe(MAX_PER_SENDER);
  });

  it('memory growth stays O(maxSenders × maxPerSender)', async () => {
    // Without per-sender bucketing, an unbounded sender could push
    // the LRU's totalEntries arbitrarily high. Defense: the LRU is
    // hard-capped by maxSenders × MAX_PER_SENDER.
    const lru = new ReplayLRU();
    for (let i = 0; i < 5000; i++) {
      lru.add(HOSTILE, `hostile-${i}`);
    }
    // Total entries does not exceed the per-sender cap.
    expect(lru.totalEntries).toBeLessThanOrEqual(MAX_PER_SENDER);
  });

  it('sybil flood (many ephemeral pubkeys) capped by maxUntrustedSenders', async () => {
    // Sophisticated adversarial vector: instead of spamming one
    // pubkey, the attacker generates thousands of distinct ephemeral
    // pubkeys (cheap on Nostr — anyone can mint a transport pubkey).
    // Untrusted-pool cap bounds the bucket Map's untrusted growth.
    const lru = new ReplayLRU();
    for (let i = 0; i < 1000; i++) {
      lru.add(`sybil-${i}`.padEnd(64, '0'), `cid-${i}`);
    }
    // Sender count across BOTH pools is capped by trusted + untrusted.
    expect(lru.senderCount).toBeLessThanOrEqual(
      MAX_TRUSTED_SENDERS + MAX_UNTRUSTED_SENDERS,
    );
    // None of the sybil senders graduated, so they are all in
    // the untrusted pool — capped by MAX_UNTRUSTED_SENDERS.
    expect(lru.untrustedSenderCount).toBeLessThanOrEqual(MAX_UNTRUSTED_SENDERS);
  });

  it('honest sender publishing during flood is NEVER evicted by sender-bucket cap', async () => {
    // This is the deep N5 defense: the SENDER-LEVEL eviction tier
    // MUST evict the LEAST-RECENTLY-ACTIVE sender, NOT a recently-active
    // honest sender. We simulate honest activity interleaved with sybil
    // floods and assert the honest sender's bucket is preserved.
    //
    // Pre-Option-B: this required the honest sender to keep refreshing
    // recency. Post-Option-B: graduating the honest sender to trusted
    // makes their bucket truly immune to sybil churn — no refresh
    // needed.
    const lru = new ReplayLRU({ maxPerSender: 4, maxUntrustedSenders: 4 });

    // Honest Alice publishes once and graduates (the bundle-acquirer
    // would mark her trusted on first verified bundle).
    lru.add(HONEST_ALICE, 'alice-1');
    lru.markSenderTrusted(HONEST_ALICE);

    // Sybil flood: 99 distinct sybil pubkeys. Alice need not refresh —
    // she's in the trusted pool and immune.
    for (let i = 0; i < 99; i++) {
      lru.add(`sybil-${i}`.padEnd(64, '0'), `cid-${i}`);
    }

    // Alice's first entry survives because trusted is immune to
    // untrusted-pool churn.
    expect(lru.has(HONEST_ALICE, 'alice-1')).toBe(true);
    expect(lru.isTrusted(HONEST_ALICE)).toBe(true);
  });

  it('honest sender publishes once, sits idle while sybil floods 1000 unknown senders → trusted bucket survives', async () => {
    // Steelman scenario: an honest sender ships a single verified
    // bundle (graduates to trusted), then sits IDLE. Meanwhile, a
    // sustained sybil flood burns through 1000+ throwaway pubkeys.
    // The honest trusted bucket MUST survive — Option B's whole point.
    const lru = new ReplayLRU();
    lru.add(HONEST_ALICE, 'cid-alice-1');
    lru.markSenderTrusted(HONEST_ALICE);

    // Alice goes idle. Sybil floods.
    for (let i = 0; i < 1000; i++) {
      lru.add(`sybil-${i}`.padEnd(64, '0'), `junk-${i}`);
    }

    expect(lru.has(HONEST_ALICE, 'cid-alice-1')).toBe(true);
    expect(lru.isTrusted(HONEST_ALICE)).toBe(true);
  });

  it('hostile cannot evict by reusing an honest CID — buckets are private', async () => {
    // Per the (sender, cid) keying: an attacker who SOMEHOW knows an
    // honest sender's bundleCid cannot exploit it to evict the honest
    // entry — the attacker's `add(HOSTILE, knownCid)` lands in their
    // OWN bucket, not Alice's.
    const lru = new ReplayLRU();
    lru.add(HONEST_ALICE, 'shared-cid');
    expect(lru.has(HONEST_ALICE, 'shared-cid')).toBe(true);

    // Attacker uses the same CID — separate bucket, separate entry.
    lru.add(HOSTILE, 'shared-cid');
    expect(lru.has(HONEST_ALICE, 'shared-cid')).toBe(true);
    expect(lru.has(HOSTILE, 'shared-cid')).toBe(true);

    // Attacker floods their own bucket — Alice untouched.
    for (let i = 0; i < 500; i++) {
      lru.add(HOSTILE, `flood-${i}`);
    }
    expect(lru.has(HONEST_ALICE, 'shared-cid')).toBe(true);
  });
});
