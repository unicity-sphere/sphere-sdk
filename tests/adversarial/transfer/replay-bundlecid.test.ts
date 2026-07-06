/**
 * Adversarial test — replay-bundleCid (§5.1, §5.6, §11.4).
 *
 * Threat model: a hostile sender sends the IDENTICAL `bundleCid` 100
 * times in a tight loop, hoping to:
 *   1. Trigger the §5.2 verification pipeline (CAR-parse, hash recheck,
 *      `pkg.verify()`) 100 times → CPU drain.
 *   2. Trigger 100 OrbitDB writes → I/O drain.
 *   3. Cause manifest divergence by some race-window-only bug.
 *
 * Spec defense (§5.1, normative):
 *   "Re-processing the same `bundleCid` is **idempotent** by
 *    construction — tokens are identified by their immutable
 *    `tokenId`, and the local pool only ever holds one canonical copy
 *    per id. Re-processing wastes compute but cannot diverge from the
 *    first processing. The replay-LRU is therefore an OPTIMIZATION,
 *    not a correctness gate — eviction is harmless."
 *
 * What this test pins:
 *   1. With the LRU fronting the pipeline, 100 arrivals → 1 verifies
 *      and 99 short-circuit (the fast path).
 *   2. The short-circuit returns a `ReplayOutcome` (typed signal that
 *      the recipient code may use to skip downstream work).
 *   3. The (sender, bundleCid) pairing means the SAME bundleCid from
 *      a DIFFERENT sender does NOT short-circuit — a sophisticated
 *      attacker can't free-ride on an honest sender's replay credits.
 *   4. EVEN IF the LRU evicts the entry mid-flood (forcing re-processing
 *      of a "replay"), the recipient's pool / manifest state remains
 *      idempotent. We assert the §5.6 invariant: every "replay" path
 *      that we DO re-process produces the same VerifiedBundle shape
 *      as the first.
 *
 * This is a thin adversarial wrap around the bundle-acquirer + replay-
 * LRU unit tests, surfacing the §5.1 / §11.4 contract in the
 * adversarial-suite layer.
 *
 * Spec references: §5.1, §5.6, §11.4.
 */

import { describe, expect, it } from 'vitest';

import {
  acquireBundle,
  isReplayOutcome,
} from '../../../extensions/uxf/pipeline/bundle-acquirer';
import { ReplayLRU } from '../../../extensions/uxf/pipeline/replay-lru';
import type { UxfTransferPayloadCar } from '../../../types/uxf-transfer';
import { UxfPackage } from '../../../extensions/uxf/bundle/UxfPackage';
import {
  carBytesToBase64,
  extractCarRootCid,
} from '../../../extensions/uxf/bundle/transfer-payload';

import { TOKEN_A } from '../../fixtures/uxf-mock-tokens';

const TOKEN_A_ID = 'aa00000000000000000000000000000000000000000000000000000000000001';
const HOSTILE_SENDER = 'h'.repeat(64);
const HONEST_SENDER = 'a'.repeat(64);

async function buildPayload(): Promise<UxfTransferPayloadCar> {
  const pkg = UxfPackage.create();
  pkg.ingestAll([TOKEN_A]);
  const carBytes = await pkg.toCar();
  const realBundleCid = await extractCarRootCid(carBytes);
  return {
    kind: 'uxf-car',
    version: '1.0',
    mode: 'instant',
    bundleCid: realBundleCid,
    tokenIds: [TOKEN_A_ID],
    carBase64: carBytesToBase64(carBytes),
  };
}

describe('§5.1 — replay-bundleCid flood is short-circuited', () => {
  it('100 identical (sender, bundleCid) arrivals: 1 verify + 99 short-circuits', async () => {
    const payload = await buildPayload();
    const lru = new ReplayLRU();

    // First arrival — full verification path.
    const first = await acquireBundle(payload, HOSTILE_SENDER, lru);
    expect(isReplayOutcome(first)).toBe(false);
    if (isReplayOutcome(first)) throw new Error('unreachable');
    expect(first.verified).toBe(true);
    // LRU now contains (HOSTILE_SENDER, payload.bundleCid).
    expect(lru.has(HOSTILE_SENDER, payload.bundleCid)).toBe(true);

    // Next 99 arrivals — every one is a replay, every one short-circuits.
    let replayCount = 0;
    for (let i = 0; i < 99; i++) {
      const result = await acquireBundle(payload, HOSTILE_SENDER, lru);
      if (isReplayOutcome(result)) replayCount++;
    }
    expect(replayCount).toBe(99);

    // The hostile sender's bucket has exactly 1 entry — they cannot
    // bloat the LRU by re-publishing the same CID.
    expect(lru.bucketSize(HOSTILE_SENDER)).toBe(1);
  });

  it('replay short-circuit is per-(sender, cid) — different sender does NOT free-ride', async () => {
    // Subtle adversarial vector: an attacker observes a known CID
    // (say, the BUNDLE_CID of an honest exchange) and tries to
    // benefit from the recipient's "this CID is safe" caching.
    //
    // Defense: the LRU is keyed by (senderPubkey, bundleCid), NOT by
    // bundleCid alone. The same CID from a different sender is a
    // FRESH bundle from the recipient's perspective.
    const payload = await buildPayload();
    const lru = new ReplayLRU();

    // Honest sender publishes; LRU records (HONEST, cid).
    const first = await acquireBundle(payload, HONEST_SENDER, lru);
    expect(isReplayOutcome(first)).toBe(false);
    expect(lru.has(HONEST_SENDER, payload.bundleCid)).toBe(true);

    // Attacker tries the same CID — does NOT short-circuit.
    // The attacker's bundle is verified afresh.
    const attackerAttempt = await acquireBundle(payload, HOSTILE_SENDER, lru);
    expect(isReplayOutcome(attackerAttempt)).toBe(false);
    if (isReplayOutcome(attackerAttempt)) throw new Error('unreachable');
    expect(attackerAttempt.verified).toBe(true);
    // Both sender buckets now contain the CID — independently.
    expect(lru.has(HONEST_SENDER, payload.bundleCid)).toBe(true);
    expect(lru.has(HOSTILE_SENDER, payload.bundleCid)).toBe(true);
  });

  it('LRU eviction → re-processing → idempotent (§5.6)', async () => {
    // Simulate a tiny LRU (1 slot per sender) so the SAME (sender, cid)
    // gets evicted as new entries land. The follow-up re-arrival of
    // the original CID re-runs the §5.2 pipeline.
    //
    // Per §5.6 idempotency invariant: re-processing must produce the
    // SAME VerifiedBundle shape (same claimedTokens, same bundleCid).
    const payload = await buildPayload();
    const lru = new ReplayLRU({ maxPerSender: 1 });

    const first = await acquireBundle(payload, HOSTILE_SENDER, lru);
    expect(isReplayOutcome(first)).toBe(false);
    if (isReplayOutcome(first)) throw new Error('unreachable');

    // Force eviction by adding a different bundleCid for the same sender.
    lru.add(HOSTILE_SENDER, 'bafy-other-distinct-cid');
    expect(lru.has(HOSTILE_SENDER, payload.bundleCid)).toBe(false);

    // Re-arrival re-runs verification — and per §5.6 returns a
    // VerifiedBundle with the SAME content.
    const reprocess = await acquireBundle(payload, HOSTILE_SENDER, lru);
    expect(isReplayOutcome(reprocess)).toBe(false);
    if (isReplayOutcome(reprocess)) throw new Error('unreachable');
    expect(reprocess.verified).toBe(true);
    expect(reprocess.bundleCid).toBe(first.bundleCid);
    expect(reprocess.claimedTokens.map((t) => t.tokenId).sort())
      .toEqual(first.claimedTokens.map((t) => t.tokenId).sort());
  });

  it('flood of 1000 replays does NOT bloat memory beyond per-sender cap', async () => {
    // Memory invariant: the LRU is hard-capped by maxPerSender. A
    // 1000-message flood of the SAME (sender, cid) cannot grow the
    // bucket beyond 1 (because the same key short-circuits).
    const payload = await buildPayload();
    const lru = new ReplayLRU(); // default cap

    for (let i = 0; i < 1000; i++) {
      await acquireBundle(payload, HOSTILE_SENDER, lru);
    }
    // Exactly 1 entry — the same CID hits the LRU 1000 times but only
    // ever counts as 1.
    expect(lru.bucketSize(HOSTILE_SENDER)).toBe(1);
    expect(lru.totalEntries).toBe(1);
  });
});
