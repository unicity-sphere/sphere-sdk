/**
 * Tests for Item #15 Phase D.2 — the snapshot-apply closure that
 * `profile/factory.ts` wires into `ProfileStorageProvider` via
 * `setSnapshotApplier`.
 *
 * The closure body is exposed as `runProfileSnapshotApply(snapshot, deps)`
 * for isolated testing. Production wiring constructs `deps` from the
 * live providers; here we stub every accessor so the test focuses on
 * the wrapper's contract:
 *
 *   1. Calls `getBundleIndex()` lazily — once per apply.
 *   2. Delegates to the pure dispatcher (`runProfileSnapshotJoin`) with
 *      a frozen view of `deps.writersFor` + `deps.getBundleIndex()`.
 *   3. Returns the dispatcher's result verbatim.
 *
 * The dispatcher's per-writer routing / aggregation semantics are
 * covered by `tests/unit/profile/profile-snapshot-dispatcher.test.ts`;
 * this file only proves the wrapper's binding.
 *
 * @see profile/factory.ts — runProfileSnapshotApply + createProfileProviders
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runProfileSnapshotApply,
  type ProfileSnapshotApplyDeps,
} from '../../../extensions/uxf/profile/factory.js';
import type {
  JoinResult,
  ProfileSyncWriter,
} from '../../../extensions/uxf/profile/profile-snapshot-merge.js';
import type { LeanProfileSnapshot } from '../../../extensions/uxf/profile/profile-lean-snapshot.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ADDR_A = 'DIRECT_aabbcc_ddeeff';

const NULL_RESULT: JoinResult = {
  entriesEvaluated: 0,
  liveLanded: 0,
  tombstonesLanded: 0,
  localWon: 0,
  remoteRejectedMalformed: 0,
};

function snapshotWith(entries: Array<{ key: string; value: string }>): LeanProfileSnapshot {
  return {
    version: 2,
    chainPubkey: '02' + 'bb'.repeat(32),
    network: 'testnet',
    createdAt: 1_700_000_000_000,
    entries,
    bundles: [],
  };
}

function recordingWriter(result: JoinResult = NULL_RESULT): ProfileSyncWriter & {
  calls: number;
} {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    snapshot: async () => [],
    joinSnapshot: async () => {
      calls += 1;
      return result;
    },
  } as ProfileSyncWriter & { calls: number };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runProfileSnapshotApply (Item #15 Phase D.2)', () => {
  it('calls writersFor exactly once per observed addressId', async () => {
    const writersFor = vi.fn<ProfileSnapshotApplyDeps['writersFor']>(() => []);
    const snapshot = snapshotWith([
      { key: `${ADDR_A}.outbox.id1`, value: 'AQID' },
    ]);

    await runProfileSnapshotApply(snapshot, {
      writersFor,
      getBundleIndex: () => null,
    });

    expect(writersFor).toHaveBeenCalledTimes(1);
    expect(writersFor).toHaveBeenCalledWith(ADDR_A);
  });

  it('calls getBundleIndex exactly once per apply (even if no bundle entries)', async () => {
    const getBundleIndex = vi.fn<ProfileSnapshotApplyDeps['getBundleIndex']>(() => null);
    const snapshot = snapshotWith([
      { key: `${ADDR_A}.outbox.id1`, value: 'AQID' },
    ]);

    await runProfileSnapshotApply(snapshot, {
      writersFor: () => [],
      getBundleIndex,
    });

    // The dispatcher reads the bundle index once at the start of the
    // call, regardless of whether tokens.bundle.* entries exist.
    expect(getBundleIndex).toHaveBeenCalledTimes(1);
  });

  it('propagates the writer + bundleIndex into the dispatcher', async () => {
    const outboxWriter = recordingWriter({
      ...NULL_RESULT,
      entriesEvaluated: 1,
      liveLanded: 1,
    });
    const bundleIndex = recordingWriter({
      ...NULL_RESULT,
      entriesEvaluated: 1,
      liveLanded: 1,
    });

    const snapshot = snapshotWith([
      { key: `${ADDR_A}.outbox.id1`, value: 'AQID' },
      { key: 'tokens.bundle.bafyA', value: 'AQID' },
    ]);

    const result = await runProfileSnapshotApply(snapshot, {
      writersFor: () => [
        { keyPrefix: `${ADDR_A}.outbox.`, writer: outboxWriter },
      ],
      getBundleIndex: () => bundleIndex,
    });

    expect(outboxWriter.calls).toBe(1);
    expect(bundleIndex.calls).toBe(1);
    // Counters aggregated across both writers (1 + 1).
    expect(result.counters.liveLanded).toBe(2);
    expect(result.joinedAny).toBe(true);
  });

  it('honors the lazy `getBundleIndex` returning null mid-test', async () => {
    // First apply: bundleIndex available.
    const w = recordingWriter({ ...NULL_RESULT, entriesEvaluated: 1, liveLanded: 1 });
    let bundleAvailable = true;
    const deps: ProfileSnapshotApplyDeps = {
      writersFor: () => [],
      getBundleIndex: () => (bundleAvailable ? w : null),
    };

    const snapshot = snapshotWith([
      { key: 'tokens.bundle.bafyA', value: 'AQID' },
    ]);

    const result1 = await runProfileSnapshotApply(snapshot, deps);
    expect(result1.joinedAny).toBe(true);
    expect(w.calls).toBe(1);

    // Second apply: bundleIndex now null — graceful skip.
    bundleAvailable = false;
    const result2 = await runProfileSnapshotApply(snapshot, deps);
    expect(result2.joinedAny).toBe(false);
    expect(w.calls).toBe(1); // Still 1 — second call did not invoke it.
  });

  it('returns the dispatcher result shape unchanged', async () => {
    // Smoke check that the wrapper does not transform the result.
    const snapshot = snapshotWith([]);

    const result = await runProfileSnapshotApply(snapshot, {
      writersFor: () => [],
      getBundleIndex: () => null,
    });

    expect(result).toEqual({
      joinedAny: false,
      addressesSeen: 0,
      bundleEntriesSeen: 0,
      counters: {
        entriesEvaluated: 0,
        liveLanded: 0,
        tombstonesLanded: 0,
        localWon: 0,
        remoteRejectedMalformed: 0,
      },
    });
  });
});
