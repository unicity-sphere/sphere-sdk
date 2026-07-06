/**
 * Fault-injection test for §5.5 step 5 — crash-between-step-3-and-step-4
 * convergence (W25, T.5.B.0).
 *
 * The protocol's normative claim: even though OrbitDB has no multi-key
 * atomicity primitive, the 4-step write order + per-step idempotency
 * guarantees that a crash anywhere between (1) and (4) leaves the next
 * worker pass with sufficient information to resume cleanly. The most
 * subtle boundary is between step 3 (tombstone insert) and step 4
 * (queue-entry removal LAST) — at that moment, the manifest entry
 * already points at `newCid`, the tombstone for `previousCid` is
 * already recorded, BUT the queue entry is still present, so the worker
 * MUST treat the operation as incomplete.
 *
 * This test deterministically simulates the crash and asserts that:
 *   (a) the next worker pass succeeds (does NOT throw),
 *   (b) only step 4 runs (steps 1, 2, 3 detect "already applied"),
 *   (c) the final state is identical to a single non-crashing run.
 *
 * Spec references: §5.5 step 5 (verbatim 4-step write order + crash
 * recovery rationale).
 */

import { describe, it, expect } from 'vitest';

import {
  performManifestCidRewrite,
  type ManifestCidRewriteContext,
  type PoolWriteAdapter,
  type TombstoneWriteAdapter,
  type FinalizationQueueAdapter,
} from '../../../../extensions/uxf/pipeline/manifest-cid-rewrite';
import {
  ManifestCas,
  type MinimalManifestStorage,
} from '../../../../profile/manifest-cas';
import type { TokenManifestEntry } from '../../../../profile/token-manifest';
import type { InclusionProof } from '../../../../oracle/oracle-provider';

// =============================================================================
// 1. Fault-injectable adapter set
// =============================================================================

/**
 * Build a fully-instrumented adapter set whose `removeEntry` (step 4)
 * can be configured to throw on the Nth invocation. This simulates the
 * "crash between step 3 and step 4" boundary precisely: steps 1–3 land,
 * step 4 throws, the process is conceptually killed, the worker restarts,
 * and the same context is fed back through `performManifestCidRewrite`.
 */
function makeAdapters(failStep4OnCallNumber?: number): {
  pool: PoolWriteAdapter & {
    attached: Set<string>;
    attachCalls: number;
  };
  tombstones: TombstoneWriteAdapter & {
    records: Set<string>;
    insertCalls: number;
  };
  queue: FinalizationQueueAdapter & {
    entries: Set<string>;
    removeCalls: number;
  };
  manifestStorage: MinimalManifestStorage & {
    entries: Map<string, TokenManifestEntry>;
    writeCalls: number;
  };
} {
  const poolAttached = new Set<string>();
  let poolAttachCalls = 0;
  const pool: PoolWriteAdapter & {
    attached: Set<string>;
    attachCalls: number;
  } = {
    attached: poolAttached,
    get attachCalls() {
      return poolAttachCalls;
    },
    set attachCalls(_v: number) {
      poolAttachCalls = _v;
    },
    async isProofAttached(tokenId, requestId) {
      return poolAttached.has(`${tokenId}:${requestId}`);
    },
    async attachProof(tokenId, requestId) {
      poolAttachCalls++;
      poolAttached.add(`${tokenId}:${requestId}`);
    },
  };

  const tombstoneRecords = new Set<string>();
  let tombstoneInserts = 0;
  const tombstones: TombstoneWriteAdapter & {
    records: Set<string>;
    insertCalls: number;
  } = {
    records: tombstoneRecords,
    get insertCalls() {
      return tombstoneInserts;
    },
    set insertCalls(_v: number) {
      tombstoneInserts = _v;
    },
    async hasTombstone(tokenId, cid) {
      return tombstoneRecords.has(`${tokenId}:${cid}`);
    },
    async insertTombstone(tokenId, cid) {
      tombstoneInserts++;
      tombstoneRecords.add(`${tokenId}:${cid}`);
    },
  };

  const queueEntries = new Set<string>();
  let queueRemoveCount = 0;
  let removeInvocations = 0;
  const queue: FinalizationQueueAdapter & {
    entries: Set<string>;
    removeCalls: number;
  } = {
    entries: queueEntries,
    get removeCalls() {
      return queueRemoveCount;
    },
    set removeCalls(_v: number) {
      queueRemoveCount = _v;
    },
    async hasEntry(addr, requestId) {
      return queueEntries.has(`${addr}:${requestId}`);
    },
    async removeEntry(addr, requestId) {
      removeInvocations++;
      if (failStep4OnCallNumber !== undefined && removeInvocations === failStep4OnCallNumber) {
        // Simulate process crash at step 4 — throw before the actual
        // removal lands. Manifest + tombstone state from steps 1–3 is
        // already persisted (as it would be after a real OrbitDB write).
        throw new Error('simulated crash between step 3 and step 4');
      }
      queueRemoveCount++;
      queueEntries.delete(`${addr}:${requestId}`);
    },
  };

  const manifestEntries = new Map<string, TokenManifestEntry>();
  let manifestWrites = 0;
  const manifestStorage: MinimalManifestStorage & {
    entries: Map<string, TokenManifestEntry>;
    writeCalls: number;
  } = {
    entries: manifestEntries,
    get writeCalls() {
      return manifestWrites;
    },
    set writeCalls(_v: number) {
      manifestWrites = _v;
    },
    async readEntry(addr, tokenId) {
      return manifestEntries.get(`${addr}:${tokenId}`);
    },
    async writeEntry(addr, tokenId, entry) {
      manifestWrites++;
      manifestEntries.set(`${addr}:${tokenId}`, entry);
    },
  };

  return { pool, tombstones, queue, manifestStorage };
}

function buildCtx(adapters: ReturnType<typeof makeAdapters>): ManifestCidRewriteContext {
  const addr = 'DIRECT://addr-A';
  const tokenId = 'token-1';
  const previousCid = 'bafy...old';
  const newCid = 'bafy...new';
  const queueEntryRequestId = 'req-1';

  // Pre-populate the manifest entry at `previousCid` and the queue entry —
  // matching the worker's pre-state immediately before invoking the rewrite.
  adapters.manifestStorage.entries.set(`${addr}:${tokenId}`, {
    rootHash: previousCid,
    status: 'pending',
  });
  adapters.queue.entries.add(`${addr}:${queueEntryRequestId}`);
  // Reset the spy counters so post-init counters reflect only the rewrite
  // operation under test.
  adapters.manifestStorage.writeCalls = 0;

  const proofToAttach: InclusionProof = {
    requestId: queueEntryRequestId,
    roundNumber: 7,
    proof: { ok: true },
    timestamp: 1700000000000,
  };

  return {
    addr,
    tokenId,
    proofToAttach,
    newCid,
    previousCid,
    nextEntryRest: { status: 'valid' },
    queueEntryRequestId,
    pool: adapters.pool,
    manifestCas: new ManifestCas(adapters.manifestStorage),
    tombstones: adapters.tombstones,
    queue: adapters.queue,
  };
}

// =============================================================================
// 2. The W25 test
// =============================================================================

describe('§5.5 step 5 atomicity (W25) — crash between step 3 and step 4', () => {
  it('first pass crashes at step 4; next pass commits cleanly to convergent state', async () => {
    // Configure step 4 (queue.removeEntry) to throw on its first call —
    // simulates process death after tombstone insert but before queue
    // entry removal lands.
    const adapters = makeAdapters(/* failStep4OnCallNumber */ 1);
    const ctx = buildCtx(adapters);

    // Pass 1: throws at step 4.
    await expect(performManifestCidRewrite(ctx)).rejects.toThrow(
      'simulated crash between step 3 and step 4',
    );

    // After-crash state assertions — steps 1–3 must have landed:
    expect(adapters.pool.attached.has('token-1:req-1')).toBe(true);
    expect(adapters.manifestStorage.entries.get('DIRECT://addr-A:token-1')).toEqual({
      rootHash: 'bafy...new',
      status: 'valid',
    });
    expect(adapters.tombstones.records.has('token-1:bafy...old')).toBe(true);
    // Step 4 did NOT land — queue entry still present (the durability anchor):
    expect(adapters.queue.entries.has('DIRECT://addr-A:req-1')).toBe(true);

    // Snapshot the per-step real-write counters so we can assert the
    // re-run only writes step 4.
    const callCountAfterCrash = {
      poolAttach: adapters.pool.attachCalls,
      manifestWrites: adapters.manifestStorage.writeCalls,
      tombstoneInserts: adapters.tombstones.insertCalls,
      queueRemovals: adapters.queue.removeCalls,
    };

    // ----- Simulate process restart -----
    // Replace `removeEntry` to no longer throw; reuse the SAME adapter
    // instances so all persisted state survives (this is the moral
    // equivalent of restarting the worker against the existing OrbitDB
    // store).
    const queueEntries = adapters.queue.entries;
    let queueRemoveCount = adapters.queue.removeCalls;
    adapters.queue.removeEntry = async (addr, requestId) => {
      queueRemoveCount++;
      queueEntries.delete(`${addr}:${requestId}`);
    };
    Object.defineProperty(adapters.queue, 'removeCalls', {
      get: () => queueRemoveCount,
      configurable: true,
    });

    // Pass 2: re-run the orchestrator on the same context.
    const r = await performManifestCidRewrite(ctx);

    // (a) Pass 2 succeeded.
    // (b) Only step 4 ran — pass 2 result discriminator must be
    //     `partial-step3-resumed`.
    expect(r.result).toBe('partial-step3-resumed');

    // Per-step counter assertions — only the queue removal advanced.
    expect(adapters.pool.attachCalls).toBe(callCountAfterCrash.poolAttach);
    expect(adapters.manifestStorage.writeCalls).toBe(
      callCountAfterCrash.manifestWrites,
    );
    expect(adapters.tombstones.insertCalls).toBe(
      callCountAfterCrash.tombstoneInserts,
    );
    expect(adapters.queue.removeCalls).toBe(
      callCountAfterCrash.queueRemovals + 1,
    );

    // (c) Final state identical to a single non-crashing run.
    expect(adapters.pool.attached.has('token-1:req-1')).toBe(true);
    expect(adapters.manifestStorage.entries.get('DIRECT://addr-A:token-1')).toEqual({
      rootHash: 'bafy...new',
      status: 'valid',
    });
    expect(adapters.tombstones.records.has('token-1:bafy...old')).toBe(true);
    expect(adapters.queue.entries.has('DIRECT://addr-A:req-1')).toBe(false);
  });

  it('crash at step 4, then immediate retry with fault still active, then succeed on third pass', async () => {
    // Two consecutive crashes — exercises the case where the first
    // restart also crashes (e.g. process killed twice in a row by an
    // ops auto-restart loop). Convergence must hold across multiple
    // crash-resume cycles.
    const adapters = makeAdapters(/* failStep4OnCallNumber */ 1);
    const ctx = buildCtx(adapters);

    // Pass 1: crash.
    await expect(performManifestCidRewrite(ctx)).rejects.toThrow();

    // Pass 2: re-arm crash on the FIRST step-4 invocation. Steps 1–3
    // skip via idempotency; step 4 is invocation #1 in this re-run, so
    // we set the trigger accordingly by replacing removeEntry to throw
    // once more, then succeed.
    let secondAttempted = false;
    adapters.queue.removeEntry = async (addr, requestId) => {
      if (!secondAttempted) {
        secondAttempted = true;
        throw new Error('second crash');
      }
      // Real removal:
      adapters.queue.entries.delete(`${addr}:${requestId}`);
    };
    await expect(performManifestCidRewrite(ctx)).rejects.toThrow('second crash');

    // Pass 3: clean run.
    const r = await performManifestCidRewrite(ctx);
    expect(r.result).toBe('partial-step3-resumed');
    expect(adapters.queue.entries.has('DIRECT://addr-A:req-1')).toBe(false);
  });

  it('crash before step 1 → next pass runs all four steps cleanly (full ok)', async () => {
    // Sanity: confirm the W25 mechanism is not specific to step 4 —
    // a crash at any earlier point also converges. Here we simulate
    // "crash before step 1 even started" simply by running the whole
    // thing on a fresh adapter set.
    const adapters = makeAdapters();
    const ctx = buildCtx(adapters);
    const r = await performManifestCidRewrite(ctx);
    expect(r.result).toBe('ok');
    expect(adapters.queue.entries.has('DIRECT://addr-A:req-1')).toBe(false);
  });
});
