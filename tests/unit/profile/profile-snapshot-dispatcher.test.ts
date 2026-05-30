/**
 * Unit tests for profile/profile-snapshot-dispatcher.ts (Item #15 Phase D.2).
 *
 * The dispatcher is the per-writer JOIN orchestrator on the pull side
 * of the lean-snapshot sync. It:
 *   - decodes base64-encoded ciphertext from the snapshot's entries[]
 *   - extracts unique addressIds (pattern DIRECT_[0-9a-f]{6}_[0-9a-f]{6})
 *   - dispatches each per-address writer's joinSnapshot() over its
 *     prefix-filtered slice
 *   - dispatches the wallet-global BundleIndex over `tokens.bundle.*`
 *   - aggregates counters and reports `joinedAny`
 *
 * These tests use stub writers that record what they receive — no
 * encryption / OrbitDB / IPFS dependencies.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runProfileSnapshotJoin,
  __internal,
  type SnapshotJoinWriterEntry,
} from '../../../profile/profile-snapshot-dispatcher';
import type {
  JoinResult,
  ProfileSyncWriter,
  SnapshotEntry,
} from '../../../profile/profile-snapshot-merge';
import type { LeanProfileSnapshot } from '../../../profile/profile-lean-snapshot';

// =============================================================================
// Helpers
// =============================================================================

/** Build a stub LeanProfileSnapshot with the given entries. */
function buildSnapshot(
  entries: Array<{ key: string; value: string }>,
): LeanProfileSnapshot {
  return {
    version: 2,
    chainPubkey: '02' + 'bb'.repeat(32),
    network: 'testnet',
    createdAt: 1_700_000_000_000,
    entries,
    bundles: [],
  };
}

/** Encode arbitrary bytes (as a unique tag for the test) to base64. */
function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Build a stub ProfileSyncWriter that records every joinSnapshot call. */
function createStubWriter(
  result: JoinResult = {
    entriesEvaluated: 0,
    liveLanded: 0,
    tombstonesLanded: 0,
    localWon: 0,
    remoteRejectedMalformed: 0,
  },
): ProfileSyncWriter & {
  calls: Array<ReadonlyArray<SnapshotEntry>>;
} {
  const calls: Array<ReadonlyArray<SnapshotEntry>> = [];
  return {
    calls,
    snapshot: async () => [],
    joinSnapshot: async (entries) => {
      calls.push(entries);
      // Synthesize entriesEvaluated from the input so tests can pin the
      // counter aggregation; per-writer test fixtures override this when
      // they want specific live/tombstone counts.
      return {
        ...result,
        entriesEvaluated: result.entriesEvaluated || entries.length,
      };
    },
  };
}

const ADDR_A = 'DIRECT_aabbcc_ddeeff';
const ADDR_B = 'DIRECT_112233_445566';

// =============================================================================
// 1. Address extraction
// =============================================================================

describe('runProfileSnapshotJoin — address extraction', () => {
  it('extracts unique addressIds from per-address keys', async () => {
    const seen: string[] = [];
    const snapshot = buildSnapshot([
      { key: `${ADDR_A}.outbox.id1`, value: b64(new Uint8Array([1])) },
      { key: `${ADDR_A}.sent.id1`, value: b64(new Uint8Array([2])) },
      { key: `${ADDR_B}.outbox.id1`, value: b64(new Uint8Array([3])) },
    ]);

    const result = await runProfileSnapshotJoin(snapshot, {
      writersFor: (addressId) => {
        seen.push(addressId);
        return [];
      },
      bundleIndex: null,
    });

    expect(new Set(seen)).toEqual(new Set([ADDR_A, ADDR_B]));
    expect(result.addressesSeen).toBe(2);
  });

  it('ignores entries whose key does not match the addressId pattern', async () => {
    const seen: string[] = [];
    const snapshot = buildSnapshot([
      { key: 'global_key', value: b64(new Uint8Array([1])) },
      { key: 'tokens.bundle.cidX', value: b64(new Uint8Array([2])) },
      { key: 'last_wallet_event_ts_abc', value: b64(new Uint8Array([3])) },
    ]);

    const result = await runProfileSnapshotJoin(snapshot, {
      writersFor: (addressId) => {
        seen.push(addressId);
        return [];
      },
      bundleIndex: null,
    });

    expect(seen).toEqual([]);
    expect(result.addressesSeen).toBe(0);
  });

  it('keys with the right pattern but no trailing `.` do not count as addresses', async () => {
    // Defensive: DIRECT_aabbcc_ddeeff (no trailing dot, no suffix) is
    // a legacy / odd key shape — the regex requires a trailing `.`.
    const seen: string[] = [];
    const snapshot = buildSnapshot([
      { key: ADDR_A, value: b64(new Uint8Array([1])) },
      { key: `${ADDR_A}_outbox.id1`, value: b64(new Uint8Array([2])) },
    ]);

    await runProfileSnapshotJoin(snapshot, {
      writersFor: (addressId) => {
        seen.push(addressId);
        return [];
      },
      bundleIndex: null,
    });

    expect(seen).toEqual([]);
  });
});

// =============================================================================
// 2. Per-writer routing
// =============================================================================

describe('runProfileSnapshotJoin — per-writer routing', () => {
  it('dispatches each writer over its prefix-filtered slice', async () => {
    const outboxWriter = createStubWriter();
    const sentWriter = createStubWriter();

    const snapshot = buildSnapshot([
      { key: `${ADDR_A}.outbox.id1`, value: b64(new Uint8Array([1])) },
      { key: `${ADDR_A}.outbox.id2`, value: b64(new Uint8Array([2])) },
      { key: `${ADDR_A}.sent.id1`, value: b64(new Uint8Array([3])) },
    ]);

    const writersFor = (addressId: string): ReadonlyArray<SnapshotJoinWriterEntry> => {
      if (addressId !== ADDR_A) return [];
      return [
        { keyPrefix: `${ADDR_A}.outbox.`, writer: outboxWriter },
        { keyPrefix: `${ADDR_A}.sent.`, writer: sentWriter },
      ];
    };

    await runProfileSnapshotJoin(snapshot, {
      writersFor,
      bundleIndex: null,
    });

    expect(outboxWriter.calls).toHaveLength(1);
    expect(outboxWriter.calls[0].map((e) => e.key)).toEqual([
      `${ADDR_A}.outbox.id1`,
      `${ADDR_A}.outbox.id2`,
    ]);

    expect(sentWriter.calls).toHaveLength(1);
    expect(sentWriter.calls[0].map((e) => e.key)).toEqual([
      `${ADDR_A}.sent.id1`,
    ]);
  });

  it('skips writers with no matching entries', async () => {
    const outboxWriter = createStubWriter();
    const sentWriter = createStubWriter();

    const snapshot = buildSnapshot([
      { key: `${ADDR_A}.outbox.id1`, value: b64(new Uint8Array([1])) },
    ]);

    await runProfileSnapshotJoin(snapshot, {
      writersFor: () => [
        { keyPrefix: `${ADDR_A}.outbox.`, writer: outboxWriter },
        { keyPrefix: `${ADDR_A}.sent.`, writer: sentWriter },
      ],
      bundleIndex: null,
    });

    expect(outboxWriter.calls).toHaveLength(1);
    expect(sentWriter.calls).toHaveLength(0);
  });

  it('skips an addressId when writersFor returns an empty array', async () => {
    // Simulates the "encryption / identity preconditions not yet met"
    // branch. The dispatcher logs and continues without throwing.
    const snapshot = buildSnapshot([
      { key: `${ADDR_A}.outbox.id1`, value: b64(new Uint8Array([1])) },
    ]);

    const result = await runProfileSnapshotJoin(snapshot, {
      writersFor: () => [],
      bundleIndex: null,
    });

    // Address was seen but no JOIN performed — counters stay at zero.
    expect(result.addressesSeen).toBe(1);
    expect(result.counters.entriesEvaluated).toBe(0);
    expect(result.joinedAny).toBe(false);
  });

  it('handles two addresses in the same snapshot', async () => {
    const outboxA = createStubWriter();
    const outboxB = createStubWriter();

    const snapshot = buildSnapshot([
      { key: `${ADDR_A}.outbox.id1`, value: b64(new Uint8Array([1])) },
      { key: `${ADDR_B}.outbox.id1`, value: b64(new Uint8Array([2])) },
    ]);

    await runProfileSnapshotJoin(snapshot, {
      writersFor: (addressId) => {
        if (addressId === ADDR_A) {
          return [{ keyPrefix: `${ADDR_A}.outbox.`, writer: outboxA }];
        }
        return [{ keyPrefix: `${ADDR_B}.outbox.`, writer: outboxB }];
      },
      bundleIndex: null,
    });

    expect(outboxA.calls).toHaveLength(1);
    expect(outboxB.calls).toHaveLength(1);
    // Each writer sees only its own address's slice.
    expect(outboxA.calls[0]).toHaveLength(1);
    expect(outboxA.calls[0][0].key).toBe(`${ADDR_A}.outbox.id1`);
    expect(outboxB.calls[0]).toHaveLength(1);
    expect(outboxB.calls[0][0].key).toBe(`${ADDR_B}.outbox.id1`);
  });
});

// =============================================================================
// 3. BundleIndex routing
// =============================================================================

describe('runProfileSnapshotJoin — BundleIndex routing', () => {
  it('dispatches the BundleIndex over the tokens.bundle.* slice', async () => {
    const bundleIndex = createStubWriter();

    const snapshot = buildSnapshot([
      { key: 'tokens.bundle.bafyA', value: b64(new Uint8Array([1])) },
      { key: 'tokens.bundle.bafyB', value: b64(new Uint8Array([2])) },
      { key: `${ADDR_A}.outbox.id1`, value: b64(new Uint8Array([3])) },
    ]);

    const result = await runProfileSnapshotJoin(snapshot, {
      writersFor: () => [],
      bundleIndex,
    });

    expect(bundleIndex.calls).toHaveLength(1);
    expect(bundleIndex.calls[0].map((e) => e.key)).toEqual([
      'tokens.bundle.bafyA',
      'tokens.bundle.bafyB',
    ]);
    expect(result.bundleEntriesSeen).toBe(2);
  });

  it('skips BundleIndex dispatch when no tokens.bundle.* entries exist', async () => {
    const bundleIndex = createStubWriter();

    const snapshot = buildSnapshot([
      { key: `${ADDR_A}.outbox.id1`, value: b64(new Uint8Array([1])) },
    ]);

    const result = await runProfileSnapshotJoin(snapshot, {
      writersFor: () => [],
      bundleIndex,
    });

    expect(bundleIndex.calls).toHaveLength(0);
    expect(result.bundleEntriesSeen).toBe(0);
  });

  it('logs and continues when bundleIndex is null', async () => {
    const log = vi.fn();
    const snapshot = buildSnapshot([
      { key: 'tokens.bundle.bafyA', value: b64(new Uint8Array([1])) },
    ]);

    const result = await runProfileSnapshotJoin(snapshot, {
      writersFor: () => [],
      bundleIndex: null,
      log,
    });

    expect(result.bundleEntriesSeen).toBe(0);
    expect(log.mock.calls.some(([msg]: [string]) => msg.includes('bundleIndex not available'))).toBe(true);
  });
});

// =============================================================================
// 4. Aggregation + joinedAny semantics
// =============================================================================

describe('runProfileSnapshotJoin — aggregation', () => {
  it('aggregates per-writer counters', async () => {
    const w1 = createStubWriter({
      entriesEvaluated: 2,
      liveLanded: 2,
      tombstonesLanded: 0,
      localWon: 0,
      remoteRejectedMalformed: 0,
    });
    const w2 = createStubWriter({
      entriesEvaluated: 1,
      liveLanded: 0,
      tombstonesLanded: 1,
      localWon: 0,
      remoteRejectedMalformed: 0,
    });

    const snapshot = buildSnapshot([
      { key: `${ADDR_A}.outbox.id1`, value: b64(new Uint8Array([1])) },
      { key: `${ADDR_A}.outbox.id2`, value: b64(new Uint8Array([2])) },
      { key: `${ADDR_A}.sent.id1`, value: b64(new Uint8Array([3])) },
    ]);

    const result = await runProfileSnapshotJoin(snapshot, {
      writersFor: () => [
        { keyPrefix: `${ADDR_A}.outbox.`, writer: w1 },
        { keyPrefix: `${ADDR_A}.sent.`, writer: w2 },
      ],
      bundleIndex: null,
    });

    expect(result.counters).toEqual({
      entriesEvaluated: 3,
      liveLanded: 2,
      tombstonesLanded: 1,
      localWon: 0,
      remoteRejectedMalformed: 0,
    });
    expect(result.joinedAny).toBe(true);
  });

  it('joinedAny is false when no live or tombstone landed', async () => {
    const w = createStubWriter({
      entriesEvaluated: 1,
      liveLanded: 0,
      tombstonesLanded: 0,
      localWon: 1,
      remoteRejectedMalformed: 0,
    });

    const snapshot = buildSnapshot([
      { key: `${ADDR_A}.outbox.id1`, value: b64(new Uint8Array([1])) },
    ]);

    const result = await runProfileSnapshotJoin(snapshot, {
      writersFor: () => [{ keyPrefix: `${ADDR_A}.outbox.`, writer: w }],
      bundleIndex: null,
    });

    expect(result.joinedAny).toBe(false);
    expect(result.counters.localWon).toBe(1);
  });

  it('joinedAny is true when only tombstones landed', async () => {
    const w = createStubWriter({
      entriesEvaluated: 1,
      liveLanded: 0,
      tombstonesLanded: 1,
      localWon: 0,
      remoteRejectedMalformed: 0,
    });

    const snapshot = buildSnapshot([
      { key: `${ADDR_A}.outbox.id1`, value: b64(new Uint8Array([1])) },
    ]);

    const result = await runProfileSnapshotJoin(snapshot, {
      writersFor: () => [{ keyPrefix: `${ADDR_A}.outbox.`, writer: w }],
      bundleIndex: null,
    });

    expect(result.joinedAny).toBe(true);
  });
});

// =============================================================================
// 5. Error isolation
// =============================================================================

describe('runProfileSnapshotJoin — error isolation', () => {
  it('per-writer error does NOT abort the dispatch', async () => {
    const throwingWriter: ProfileSyncWriter = {
      snapshot: async () => [],
      joinSnapshot: async () => {
        throw new Error('storage failure');
      },
    };
    const goodWriter = createStubWriter();
    const log = vi.fn();

    const snapshot = buildSnapshot([
      { key: `${ADDR_A}.outbox.id1`, value: b64(new Uint8Array([1])) },
      { key: `${ADDR_A}.sent.id1`, value: b64(new Uint8Array([2])) },
    ]);

    const result = await runProfileSnapshotJoin(snapshot, {
      writersFor: () => [
        { keyPrefix: `${ADDR_A}.outbox.`, writer: throwingWriter },
        { keyPrefix: `${ADDR_A}.sent.`, writer: goodWriter },
      ],
      bundleIndex: null,
      log,
    });

    expect(goodWriter.calls).toHaveLength(1);
    // The throwing writer's counters are NOT aggregated — only goodWriter's.
    expect(result.counters.entriesEvaluated).toBe(1);
    expect(log.mock.calls.some(([msg]: [string]) =>
      msg.includes(`writer @ ${ADDR_A}.outbox.`) && msg.includes('storage failure'),
    )).toBe(true);
  });

  it('bundleIndex error does NOT abort the dispatch', async () => {
    const throwingBundle: ProfileSyncWriter = {
      snapshot: async () => [],
      joinSnapshot: async () => {
        throw new Error('bundle index failure');
      },
    };
    const outboxWriter = createStubWriter();
    const log = vi.fn();

    const snapshot = buildSnapshot([
      { key: `${ADDR_A}.outbox.id1`, value: b64(new Uint8Array([1])) },
      { key: 'tokens.bundle.bafyA', value: b64(new Uint8Array([2])) },
    ]);

    await runProfileSnapshotJoin(snapshot, {
      writersFor: () => [
        { keyPrefix: `${ADDR_A}.outbox.`, writer: outboxWriter },
      ],
      bundleIndex: throwingBundle,
      log,
    });

    // Per-address writer still ran despite the bundleIndex throw.
    expect(outboxWriter.calls).toHaveLength(1);
    expect(log.mock.calls.some(([msg]: [string]) =>
      msg.includes('bundleIndex.joinSnapshot threw'),
    )).toBe(true);
  });
});

// =============================================================================
// 6. base64 decoding
// =============================================================================

describe('runProfileSnapshotJoin — base64 decoding', () => {
  it('decodes base64 ciphertext into Uint8Array for writers', async () => {
    const receivedBytes: Uint8Array[] = [];
    const writer: ProfileSyncWriter = {
      snapshot: async () => [],
      joinSnapshot: async (entries) => {
        for (const e of entries) receivedBytes.push(e.encryptedValue);
        return {
          entriesEvaluated: entries.length,
          liveLanded: 0,
          tombstonesLanded: 0,
          localWon: 0,
          remoteRejectedMalformed: 0,
        };
      },
    };

    const original = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    const snapshot = buildSnapshot([
      { key: `${ADDR_A}.outbox.id1`, value: b64(original) },
    ]);

    await runProfileSnapshotJoin(snapshot, {
      writersFor: () => [{ keyPrefix: `${ADDR_A}.outbox.`, writer }],
      bundleIndex: null,
    });

    expect(receivedBytes).toHaveLength(1);
    expect(Array.from(receivedBytes[0])).toEqual([0xDE, 0xAD, 0xBE, 0xEF]);
  });
});

// =============================================================================
// 7. Internal helpers
// =============================================================================

describe('__internal.base64ToBytes', () => {
  it('round-trips arbitrary bytes', () => {
    const original = new Uint8Array([0, 1, 2, 3, 255, 254, 253]);
    const b64Encoded = Buffer.from(original).toString('base64');
    const decoded = __internal.base64ToBytes(b64Encoded);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it('handles empty input', () => {
    const decoded = __internal.base64ToBytes('');
    expect(decoded.length).toBe(0);
  });
});

describe('__internal.ADDRESS_ID_PREFIX_RE', () => {
  it('matches canonical addressIds', () => {
    expect(__internal.ADDRESS_ID_PREFIX_RE.test('DIRECT_aabbcc_ddeeff.outbox.id1')).toBe(true);
  });

  it('rejects malformed addressIds', () => {
    expect(__internal.ADDRESS_ID_PREFIX_RE.test('DIRECT_short_xxxxxx.outbox.id1')).toBe(false);
    expect(__internal.ADDRESS_ID_PREFIX_RE.test('PROXY_aabbcc_ddeeff.outbox.id1')).toBe(false);
    expect(__internal.ADDRESS_ID_PREFIX_RE.test('DIRECT_aabbccddee_ff.outbox.id1')).toBe(false);
  });
});

// =============================================================================
// 8. Issue #360 Finding #8 — single-pass bucketing + longest-prefix-wins
// =============================================================================

describe('runProfileSnapshotJoin — single-pass bucketing (Finding #8)', () => {
  it('routes 500 entries across 5 writers in a single pass over the entry list', async () => {
    // Build a fixture with N writers each owning a distinct prefix
    // and assert (a) every entry lands in exactly one writer's
    // bucket and (b) `entries` is iterated at most once. We probe
    // the iteration count by wrapping `snapshot.entries` in a Proxy
    // whose `get` counter we inspect afterwards — `Array.prototype.filter`
    // would re-enter for each writer; the new bucketing reads each
    // index exactly once.
    const PREFIXES = [
      `${ADDR_A}.outbox.`,
      `${ADDR_A}.sent.`,
      `${ADDR_A}.recipientContext.request.`,
      `${ADDR_A}.recipientContext.finalization.`,
      `${ADDR_A}.invalid.`,
    ] as const;
    const writers = PREFIXES.map(() => createStubWriter());
    const entriesArr: Array<{ key: string; value: string }> = [];
    for (let i = 0; i < 500; i++) {
      const prefix = PREFIXES[i % PREFIXES.length];
      entriesArr.push({
        key: `${prefix}id${i}`,
        value: b64(new Uint8Array([i & 0xff])),
      });
    }
    // Track index-level reads on the entries array. We can't easily
    // proxy a plain array literal through the runtime path, but we
    // can count `.value` and `.key` accesses on each entry: in the
    // old code each entry's `.key` was read W=5 times (once per
    // writer's filter). In the new single-pass code each entry's
    // `.key` is read exactly once during normalization + bucketing.
    let keyReads = 0;
    let valueReads = 0;
    const probed = entriesArr.map((e) =>
      new Proxy(e, {
        get(target, prop, recv) {
          if (prop === 'key') keyReads++;
          if (prop === 'value') valueReads++;
          return Reflect.get(target, prop, recv);
        },
      }),
    );
    const snapshot: LeanProfileSnapshot = {
      version: 2,
      chainPubkey: '02' + 'cc'.repeat(32),
      network: 'testnet',
      createdAt: 1_700_000_000_000,
      entries: probed,
      bundles: [],
    };

    const writersFor = (addressId: string): ReadonlyArray<SnapshotJoinWriterEntry> => {
      if (addressId !== ADDR_A) return [];
      return PREFIXES.map((p, i) => ({ keyPrefix: p, writer: writers[i] }));
    };

    await runProfileSnapshotJoin(snapshot, { writersFor, bundleIndex: null });

    // Each writer received its 1/5 slice.
    for (let i = 0; i < writers.length; i++) {
      expect(writers[i].calls).toHaveLength(1);
      expect(writers[i].calls[0]).toHaveLength(100);
      for (const e of writers[i].calls[0]) {
        expect(e.key.startsWith(PREFIXES[i])).toBe(true);
      }
    }
    // Single-pass invariant: `.key` is read once for normalization
    // and once for the address-id regex + bucketing. Either way it
    // must be MUCH less than 500 * 5 (which is what the original
    // per-writer filter approach used). Allow a small constant
    // multiplier headroom for normalization re-reads.
    expect(keyReads).toBeLessThan(500 * 3);
    // Each entry's value is decoded exactly once (when bucketed).
    expect(valueReads).toBe(500);
  });

  it('longest-prefix-wins when one writer prefix is a prefix of another', async () => {
    // Construct an overlap: a (hypothetical) shorter prefix and a
    // longer one. Entries that start with the longer prefix must
    // land in the longer-prefix writer ONLY, not in the shorter
    // one's bucket. Entries that start with the short prefix but
    // not the long one stay with the short writer.
    const SHORT = `${ADDR_A}.outer.`;
    const LONG = `${ADDR_A}.outer.inner.`;
    const shortWriter = createStubWriter();
    const longWriter = createStubWriter();

    const snapshot = buildSnapshot([
      // Long-prefix entries
      { key: `${LONG}a1`, value: b64(new Uint8Array([1])) },
      { key: `${LONG}a2`, value: b64(new Uint8Array([2])) },
      // Short-only entries (don't match the long prefix)
      { key: `${SHORT}other`, value: b64(new Uint8Array([3])) },
    ]);

    await runProfileSnapshotJoin(snapshot, {
      writersFor: (addressId) => {
        if (addressId !== ADDR_A) return [];
        return [
          { keyPrefix: SHORT, writer: shortWriter },
          { keyPrefix: LONG, writer: longWriter },
        ];
      },
      bundleIndex: null,
    });

    // Long writer claims both long-prefix entries.
    expect(longWriter.calls).toHaveLength(1);
    expect(longWriter.calls[0].map((e) => e.key)).toEqual([
      `${LONG}a1`,
      `${LONG}a2`,
    ]);
    // Short writer claims only the entry that doesn't match the
    // longer prefix.
    expect(shortWriter.calls).toHaveLength(1);
    expect(shortWriter.calls[0].map((e) => e.key)).toEqual([
      `${SHORT}other`,
    ]);
  });

  it('skips base64 decode for entries that match no writer prefix', async () => {
    // Entries that match neither a writer prefix nor BUNDLE_KEY_PREFIX
    // must NOT have their base64 value read — that's the lazy-decode
    // half of Finding #8. Use a Proxy on a junk entry's `.value` to
    // assert it stays untouched.
    const writer = createStubWriter();
    let unroutedValueReads = 0;
    const unroutedEntry = new Proxy(
      { key: 'global_key_not_routed', value: b64(new Uint8Array([0xAA])) },
      {
        get(target, prop, recv) {
          if (prop === 'value') unroutedValueReads++;
          return Reflect.get(target, prop, recv);
        },
      },
    );

    const snapshot: LeanProfileSnapshot = {
      version: 2,
      chainPubkey: '02' + 'dd'.repeat(32),
      network: 'testnet',
      createdAt: 1_700_000_000_000,
      entries: [
        unroutedEntry,
        { key: `${ADDR_A}.outbox.id1`, value: b64(new Uint8Array([1])) },
      ],
      bundles: [],
    };

    await runProfileSnapshotJoin(snapshot, {
      writersFor: (addressId) => {
        if (addressId !== ADDR_A) return [];
        return [{ keyPrefix: `${ADDR_A}.outbox.`, writer }];
      },
      bundleIndex: null,
    });

    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]).toHaveLength(1);
    expect(unroutedValueReads).toBe(0);
  });
});
