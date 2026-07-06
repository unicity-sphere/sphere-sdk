/**
 * Targeted tests for §7.1 Rule 4 — G-counter max-merge for
 * `submitRetryCount` and `proofErrorCount` (T.6.B, W28).
 *
 * G-counter shape:
 *  - Each replica only ever increments locally.
 *  - The merge of two replicas at the same logical entry is the per-key
 *    max — `merged := max(a, b)`.
 *  - Result is monotonically non-decreasing across replicas / merges.
 *
 * These tests focus on Rule 4 specifically — broader tests live in
 * `outbox-merger.test.ts`. The W28 audit checkpoint requires that this
 * file exists as a stand-alone artifact for forensic traceability.
 */

import { describe, it, expect } from 'vitest';
import type { UxfTransferOutboxEntry } from '../../../extensions/uxf/types/uxf-outbox';
import { mergeOutboxEntries, mergeErrorFields, mergeStatus } from '../../../extensions/uxf/profile/outbox-merger';

function makeEntry(overrides: Partial<UxfTransferOutboxEntry> = {}): UxfTransferOutboxEntry {
  return {
    _schemaVersion: 'uxf-1',
    id: 'gcounter-1',
    bundleCid: 'bafy-test',
    tokenIds: ['tok-1'],
    deliveryMethod: 'car-over-nostr',
    recipient: 'DIRECT://gcounter-test',
    recipientTransportPubkey: 'pub-test',
    mode: 'instant',
    status: 'sending',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    lamport: 1,
    submitRetryCount: 0,
    proofErrorCount: 0,
    ...overrides,
  };
}

describe('§7.1 Rule 4: submitRetryCount G-counter', () => {
  it('max-merge: 3 vs 5 → 5', () => {
    const a = makeEntry({ submitRetryCount: 3 });
    const b = makeEntry({ submitRetryCount: 5 });
    const r = mergeOutboxEntries(a, b);
    expect(r.submitRetryCount).toBe(5);
  });

  it('max-merge: 0 vs 0 → 0', () => {
    const a = makeEntry({ submitRetryCount: 0 });
    const b = makeEntry({ submitRetryCount: 0 });
    const r = mergeOutboxEntries(a, b);
    expect(r.submitRetryCount).toBe(0);
  });

  it('max-merge is symmetric: max(a, b) === max(b, a)', () => {
    const a = makeEntry({ submitRetryCount: 7 });
    const b = makeEntry({ submitRetryCount: 11 });
    const r1 = mergeOutboxEntries(a, b);
    const r2 = mergeOutboxEntries(b, a);
    expect(r1.submitRetryCount).toBe(r2.submitRetryCount);
  });

  it('idempotent: merge(x, x) preserves the counter', () => {
    const a = makeEntry({ submitRetryCount: 4 });
    const r = mergeOutboxEntries(a, a);
    expect(r.submitRetryCount).toBe(4);
  });

  it('counter cannot decrease across merges (monotonicity)', () => {
    const a = makeEntry({ submitRetryCount: 9 });
    const b = makeEntry({ submitRetryCount: 1 });
    const r = mergeOutboxEntries(a, b);
    expect(r.submitRetryCount).toBeGreaterThanOrEqual(a.submitRetryCount);
    expect(r.submitRetryCount).toBeGreaterThanOrEqual(b.submitRetryCount);
  });

  it('three-way fold: max-merge applies left-to-right', () => {
    const a = makeEntry({ submitRetryCount: 2 });
    const b = makeEntry({ submitRetryCount: 8 });
    const c = makeEntry({ submitRetryCount: 5 });
    const r = mergeOutboxEntries(mergeOutboxEntries(a, b), c);
    expect(r.submitRetryCount).toBe(8);
  });
});

describe('§7.1 Rule 4: proofErrorCount G-counter', () => {
  it('max-merge: 7 vs 2 → 7', () => {
    const a = makeEntry({ proofErrorCount: 7 });
    const b = makeEntry({ proofErrorCount: 2 });
    const r = mergeOutboxEntries(a, b);
    expect(r.proofErrorCount).toBe(7);
  });

  it('max-merge: 0 vs N → N (replica may never have seen errors yet)', () => {
    const a = makeEntry({ proofErrorCount: 0 });
    const b = makeEntry({ proofErrorCount: 13 });
    const r = mergeOutboxEntries(a, b);
    expect(r.proofErrorCount).toBe(13);
  });

  it('no decay on idempotent merge', () => {
    const a = makeEntry({ proofErrorCount: 6 });
    const r = mergeOutboxEntries(a, a);
    expect(r.proofErrorCount).toBe(6);
  });

  it('monotonicity: result ≥ both inputs', () => {
    const a = makeEntry({ proofErrorCount: 1 });
    const b = makeEntry({ proofErrorCount: 5 });
    const r = mergeOutboxEntries(a, b);
    expect(r.proofErrorCount).toBeGreaterThanOrEqual(Math.max(a.proofErrorCount, b.proofErrorCount));
  });
});

describe('§7.1 Rule 4: counters are independent', () => {
  it('submitRetryCount and proofErrorCount max-merge independently', () => {
    const a = makeEntry({ submitRetryCount: 9, proofErrorCount: 1 });
    const b = makeEntry({ submitRetryCount: 4, proofErrorCount: 6 });
    const r = mergeOutboxEntries(a, b);
    expect(r.submitRetryCount).toBe(9);
    expect(r.proofErrorCount).toBe(6);
  });

  it('mergeErrorFields produces the same counter values directly', () => {
    const a = makeEntry({ submitRetryCount: 9, proofErrorCount: 1 });
    const b = makeEntry({ submitRetryCount: 4, proofErrorCount: 6 });
    const sm = mergeStatus(a, b);
    const r = mergeErrorFields(a, b, sm);
    expect(r.submitRetryCount).toBe(9);
    expect(r.proofErrorCount).toBe(6);
  });
});

describe('§7.1 Rule 4: G-counter does not interact with status', () => {
  // The counter merge must NOT depend on which status wins. A failed-permanent
  // replica with proofErrorCount=2 and a finalizing replica with
  // proofErrorCount=99 should still produce proofErrorCount=99 even though
  // hard-terminal beats active for status.
  it('counter max-merges across distinct status partitions', () => {
    const a = makeEntry({ status: 'failed-permanent', proofErrorCount: 2 });
    const b = makeEntry({ status: 'finalizing', proofErrorCount: 99 });
    const r = mergeOutboxEntries(a, b);
    expect(r.status).toBe('failed-permanent'); // hard-terminal wins
    expect(r.proofErrorCount).toBe(99); // counter still max-merges
  });

  it('counter max-merges across override-stickiness arc', () => {
    const a = makeEntry({
      status: 'failed-permanent',
      lamport: 999,
      submitRetryCount: 3,
    });
    const b = makeEntry({
      status: 'finalizing',
      overrideApplied: true,
      lamport: 1,
      submitRetryCount: 7,
    });
    const r = mergeOutboxEntries(a, b);
    expect(r.status).toBe('finalizing'); // override fired
    expect(r.submitRetryCount).toBe(7); // still max
  });
});
