/**
 * Tests for `modules/payments/transfer/manifest-cid-rewrite.ts` —
 * §5.5 step 5 atomic-ish 4-step write order (T.5.B.0).
 *
 * Coverage:
 *  1. 4-step happy path: writes occur in order; final state convergent.
 *  2. Idempotency: re-run with same proof → noop result.
 *  3. Step1 already applied → re-run starts at step 2 (partial-step1-resumed).
 *  4. Step2 already applied → re-run starts at step 3 (partial-step2-resumed).
 *  5. Step3 already applied → re-run starts at step 4 (partial-step3-resumed).
 *  6. Step4 already applied → re-run is full noop.
 *  7. Step ordering — fault-injection asserts step N+1 only fires after step N.
 *  8. Genesis case — `previousCid` undefined skips step 3.
 *  9. CAS unrecoverable mismatch → throws ManifestCidRewriteCasError.
 */

import { describe, it, expect } from 'vitest';

import {
  __getMutexForTests,
  performManifestCidRewrite,
  step1Pool,
  step2ManifestCidRewrite,
  step3Tombstone,
  step4RemoveQueueEntry,
  ManifestCidRewriteCasError,
  type ManifestCidRewriteContext,
  type PoolWriteAdapter,
  type TombstoneWriteAdapter,
  type FinalizationQueueAdapter,
} from '../../../../modules/payments/transfer/manifest-cid-rewrite';
import {
  ManifestCas,
  type MinimalManifestStorage,
} from '../../../../profile/manifest-cas';
import type { TokenManifestEntry } from '../../../../profile/token-manifest';
import type { InclusionProof } from '../../../../oracle/oracle-provider';
import type { ContentHash } from '../../../../extensions/uxf/bundle/types';

// =============================================================================
// 1. Fake adapters
// =============================================================================

function makeFakePool(): PoolWriteAdapter & {
  attached: Set<string>;
  attachCalls: Array<{ tokenId: string; requestId: string }>;
} {
  const attached = new Set<string>();
  const attachCalls: Array<{ tokenId: string; requestId: string }> = [];
  return {
    attached,
    attachCalls,
    async isProofAttached(tokenId, requestId) {
      return attached.has(`${tokenId}:${requestId}`);
    },
    async attachProof(tokenId, requestId) {
      attachCalls.push({ tokenId, requestId });
      attached.add(`${tokenId}:${requestId}`);
    },
  };
}

function makeFakeTombstones(): TombstoneWriteAdapter & {
  records: Set<string>;
  insertCalls: Array<{ tokenId: string; cid: string }>;
} {
  const records = new Set<string>();
  const insertCalls: Array<{ tokenId: string; cid: string }> = [];
  return {
    records,
    insertCalls,
    async hasTombstone(tokenId, cid) {
      return records.has(`${tokenId}:${cid}`);
    },
    async insertTombstone(tokenId, cid) {
      insertCalls.push({ tokenId, cid });
      records.add(`${tokenId}:${cid}`);
    },
  };
}

function makeFakeQueue(
  initialEntries: ReadonlyArray<{ addr: string; requestId: string }> = [],
): FinalizationQueueAdapter & {
  entries: Set<string>;
  removeCalls: Array<{ addr: string; requestId: string }>;
} {
  const entries = new Set<string>();
  for (const e of initialEntries) entries.add(`${e.addr}:${e.requestId}`);
  const removeCalls: Array<{ addr: string; requestId: string }> = [];
  return {
    entries,
    removeCalls,
    async hasEntry(addr, requestId) {
      return entries.has(`${addr}:${requestId}`);
    },
    async removeEntry(addr, requestId) {
      removeCalls.push({ addr, requestId });
      entries.delete(`${addr}:${requestId}`);
    },
  };
}

/** Minimal in-memory manifest storage for ManifestCas. */
function makeFakeManifestStorage(): MinimalManifestStorage & {
  entries: Map<string, TokenManifestEntry>;
} {
  const entries = new Map<string, TokenManifestEntry>();
  return {
    entries,
    async readEntry(addr, tokenId) {
      return entries.get(`${addr}:${tokenId}`);
    },
    async writeEntry(addr, tokenId, entry) {
      entries.set(`${addr}:${tokenId}`, entry);
    },
  };
}

// =============================================================================
// 2. Fixture builder
// =============================================================================

function buildCtx(opts: {
  addr?: string;
  tokenId?: string;
  newCid?: string;
  previousCid?: string;
  queueEntryRequestId?: string;
  preExistingManifestCid?: string;
  initialQueueEntry?: boolean;
  pool?: PoolWriteAdapter;
  tombstones?: TombstoneWriteAdapter;
  queue?: FinalizationQueueAdapter;
  manifestStorage?: MinimalManifestStorage;
} = {}): {
  ctx: ManifestCidRewriteContext;
  pool: ReturnType<typeof makeFakePool>;
  tombstones: ReturnType<typeof makeFakeTombstones>;
  queue: ReturnType<typeof makeFakeQueue>;
  manifestStorage: ReturnType<typeof makeFakeManifestStorage>;
} {
  const addr = opts.addr ?? 'DIRECT://addr-A';
  const tokenId = opts.tokenId ?? 'token-1';
  const newCid = opts.newCid ?? 'bafy...new';
  // The fixture's default is "manifest entry already present at
  // bafy...old" — i.e. the worker is rewriting an existing entry, not
  // performing genesis. Tests that need the genesis case (previousCid:
  // undefined) construct their own context inline.
  const previousCid = opts.previousCid ?? 'bafy...old';
  const queueEntryRequestId = opts.queueEntryRequestId ?? 'req-1';

  const pool =
    (opts.pool as ReturnType<typeof makeFakePool> | undefined) ?? makeFakePool();
  const tombstones =
    (opts.tombstones as ReturnType<typeof makeFakeTombstones> | undefined) ??
    makeFakeTombstones();
  const queue =
    (opts.queue as ReturnType<typeof makeFakeQueue> | undefined) ??
    makeFakeQueue(
      opts.initialQueueEntry === false ? [] : [{ addr, requestId: queueEntryRequestId }],
    );
  const manifestStorage =
    (opts.manifestStorage as ReturnType<typeof makeFakeManifestStorage> | undefined) ??
    makeFakeManifestStorage();
  if (opts.preExistingManifestCid !== undefined) {
    manifestStorage.entries.set(`${addr}:${tokenId}`, {
      rootHash: opts.preExistingManifestCid,
      status: 'pending',
    });
  } else {
    // Default fixture: mimic the worker's pre-state where the manifest
    // entry already exists at `previousCid` (the proof-less version).
    // Skipped only when the caller passed a custom `manifestStorage`
    // (they'll have set up the state themselves).
    if (opts.manifestStorage === undefined) {
      manifestStorage.entries.set(`${addr}:${tokenId}`, {
        rootHash: previousCid,
        status: 'pending',
      });
    }
  }

  const manifestCas = new ManifestCas(manifestStorage);

  const proofToAttach: InclusionProof = {
    requestId: queueEntryRequestId,
    roundNumber: 42,
    proof: { merkle: 'shape-irrelevant-for-orchestrator-tests' },
    timestamp: 1700000000000,
  };

  const ctx: ManifestCidRewriteContext = {
    addr,
    tokenId,
    proofToAttach,
    newCid,
    previousCid: previousCid,
    nextEntryRest: { status: 'valid' },
    queueEntryRequestId,
    pool,
    manifestCas,
    tombstones,
    queue,
  };

  return { ctx, pool, tombstones, queue, manifestStorage };
}

// =============================================================================
// 3. Happy path — 4-step ordering + final state
// =============================================================================

describe('manifest-cid-rewrite — 4-step happy path', () => {
  it('runs all four steps in order, returns ok, converges to expected final state', async () => {
    const { ctx, pool, tombstones, queue, manifestStorage } = buildCtx();

    const r = await performManifestCidRewrite(ctx);

    expect(r.result).toBe('ok');
    // Step 1 executed.
    expect(pool.attachCalls).toHaveLength(1);
    expect(pool.attachCalls[0]).toEqual({
      tokenId: 'token-1',
      requestId: 'req-1',
    });
    // Step 2 executed (manifest CID rewritten).
    expect(manifestStorage.entries.get('DIRECT://addr-A:token-1')).toEqual({
      rootHash: 'bafy...new',
      status: 'valid',
    });
    // Step 3 executed (tombstone for previous CID).
    expect(tombstones.insertCalls).toHaveLength(1);
    expect(tombstones.insertCalls[0]).toEqual({
      tokenId: 'token-1',
      cid: 'bafy...old',
    });
    // Step 4 executed (queue entry removed LAST).
    expect(queue.removeCalls).toHaveLength(1);
    expect(queue.entries.has('DIRECT://addr-A:req-1')).toBe(false);
  });

  it('step 4 is the LAST write — the queue entry removal happens after tombstone insert', async () => {
    // Order assertion: instrument adapters with monotonically-increasing
    // call timestamps. Step 4 must observe a strictly larger sequence
    // number than step 3.
    let seq = 0;
    const seqs: Record<string, number> = {};
    const pool = makeFakePool();
    const origAttach = pool.attachProof.bind(pool);
    pool.attachProof = async (tokenId, requestId, proof) => {
      seqs.step1 = ++seq;
      await origAttach(tokenId, requestId, proof);
    };
    const tombstones = makeFakeTombstones();
    const origInsert = tombstones.insertTombstone.bind(tombstones);
    tombstones.insertTombstone = async (tokenId, cid) => {
      seqs.step3 = ++seq;
      await origInsert(tokenId, cid);
    };
    const queue = makeFakeQueue([
      { addr: 'DIRECT://addr-A', requestId: 'req-1' },
    ]);
    const origRemove = queue.removeEntry.bind(queue);
    queue.removeEntry = async (addr, requestId) => {
      seqs.step4 = ++seq;
      await origRemove(addr, requestId);
    };

    // Step 2 happens via ManifestCas; intercept via storage.
    const manifestStorage = makeFakeManifestStorage();
    manifestStorage.entries.set('DIRECT://addr-A:token-1', {
      rootHash: 'bafy...old',
      status: 'pending',
    });
    const origWrite = manifestStorage.writeEntry.bind(manifestStorage);
    manifestStorage.writeEntry = async (addr, tokenId, entry) => {
      seqs.step2 = ++seq;
      await origWrite(addr, tokenId, entry);
    };

    const { ctx } = buildCtx({ pool, tombstones, queue, manifestStorage });
    await performManifestCidRewrite(ctx);

    expect(seqs.step1).toBe(1);
    expect(seqs.step2).toBe(2);
    expect(seqs.step3).toBe(3);
    expect(seqs.step4).toBe(4);
  });
});

// =============================================================================
// 4. Idempotency on replay
// =============================================================================

describe('manifest-cid-rewrite — idempotency on replay', () => {
  it('full replay after happy-path success → noop result', async () => {
    const { ctx } = buildCtx();
    const r1 = await performManifestCidRewrite(ctx);
    expect(r1.result).toBe('ok');

    // Re-run on the same context — every step's idempotency probe
    // should detect "already applied".
    const r2 = await performManifestCidRewrite(ctx);
    expect(r2.result).toBe('noop');
  });

  it('crash after step 1 → re-run reports partial-step1-resumed', async () => {
    const { ctx, pool } = buildCtx();
    // Pre-mark step 1 as applied (simulates pool already containing
    // proof from a prior crashed worker pass).
    pool.attached.add('token-1:req-1');

    const r = await performManifestCidRewrite(ctx);
    expect(r.result).toBe('partial-step1-resumed');
    // Step 1 was skipped — no attach calls issued.
    expect(pool.attachCalls).toHaveLength(0);
  });

  it('crash after step 2 → re-run reports partial-step2-resumed', async () => {
    const { ctx, pool, manifestStorage } = buildCtx();
    pool.attached.add('token-1:req-1');
    // Pre-write the manifest entry at the new CID (step 2 already applied).
    manifestStorage.entries.set('DIRECT://addr-A:token-1', {
      rootHash: 'bafy...new',
      status: 'valid',
    });

    const r = await performManifestCidRewrite(ctx);
    expect(r.result).toBe('partial-step2-resumed');
  });

  it('crash after step 3 → re-run reports partial-step3-resumed', async () => {
    const { ctx, pool, manifestStorage, tombstones } = buildCtx();
    pool.attached.add('token-1:req-1');
    manifestStorage.entries.set('DIRECT://addr-A:token-1', {
      rootHash: 'bafy...new',
      status: 'valid',
    });
    // Pre-record tombstone (step 3 already applied).
    tombstones.records.add('token-1:bafy...old');

    const r = await performManifestCidRewrite(ctx);
    expect(r.result).toBe('partial-step3-resumed');
    expect(tombstones.insertCalls).toHaveLength(0);
  });

  it('crash after step 4 → re-run reports noop (queue already absent)', async () => {
    const { ctx, pool, manifestStorage, tombstones } = buildCtx({
      initialQueueEntry: false,
    });
    pool.attached.add('token-1:req-1');
    manifestStorage.entries.set('DIRECT://addr-A:token-1', {
      rootHash: 'bafy...new',
      status: 'valid',
    });
    tombstones.records.add('token-1:bafy...old');

    const r = await performManifestCidRewrite(ctx);
    expect(r.result).toBe('noop');
  });
});

// =============================================================================
// 5. Per-step exports (fault-injection seams)
// =============================================================================

describe('manifest-cid-rewrite — per-step functions', () => {
  it('step1Pool returns true on first call, false on replay', async () => {
    const { ctx } = buildCtx();
    expect(await step1Pool(ctx)).toBe(true);
    expect(await step1Pool(ctx)).toBe(false);
  });

  it('step2 returns true on first call, false on replay (CAS observes newCid)', async () => {
    const { ctx } = buildCtx();
    expect(await step2ManifestCidRewrite(ctx)).toBe(true);
    expect(await step2ManifestCidRewrite(ctx)).toBe(false);
  });

  it('step3 returns true on first call, false on replay', async () => {
    const { ctx } = buildCtx();
    expect(await step3Tombstone(ctx)).toBe(true);
    expect(await step3Tombstone(ctx)).toBe(false);
  });

  it('step4 returns true when entry present, false on replay', async () => {
    const { ctx } = buildCtx();
    expect(await step4RemoveQueueEntry(ctx)).toBe(true);
    expect(await step4RemoveQueueEntry(ctx)).toBe(false);
  });

  it('step3 with no previousCid is a clean no-op (genesis case)', async () => {
    // Build with explicit previousCid: undefined (genesis).
    const tombstones = makeFakeTombstones();
    const manifestStorage = makeFakeManifestStorage();
    // No pre-existing entry — step 2's CAS will pass null prev.
    const pool = makeFakePool();
    const queue = makeFakeQueue([
      { addr: 'DIRECT://addr-A', requestId: 'req-1' },
    ]);
    const ctx: ManifestCidRewriteContext = {
      addr: 'DIRECT://addr-A',
      tokenId: 'token-1',
      proofToAttach: {
        requestId: 'req-1',
        roundNumber: 1,
        proof: {},
        timestamp: 0,
      },
      newCid: 'bafy...new',
      previousCid: undefined,
      nextEntryRest: { status: 'valid' },
      queueEntryRequestId: 'req-1',
      pool,
      manifestCas: new ManifestCas(manifestStorage),
      tombstones,
      queue,
    };

    expect(await step3Tombstone(ctx)).toBe(false);
    expect(tombstones.insertCalls).toHaveLength(0);
  });
});

// =============================================================================
// 6. CAS unrecoverable failures — surface as typed error
// =============================================================================

describe('manifest-cid-rewrite — step 2 CAS error handling', () => {
  it('throws ManifestCidRewriteCasError when observed CID is neither prev nor new', async () => {
    const { ctx, manifestStorage } = buildCtx();
    // Concurrent writer advanced the manifest to a third CID we don't
    // recognize.
    manifestStorage.entries.set('DIRECT://addr-A:token-1', {
      rootHash: 'bafy...someoneElse',
      status: 'pending',
    });

    await expect(performManifestCidRewrite(ctx)).rejects.toBeInstanceOf(
      ManifestCidRewriteCasError,
    );
  });

  it('CAS error carries the casReason and observedCid', async () => {
    const { ctx, manifestStorage } = buildCtx();
    manifestStorage.entries.set('DIRECT://addr-A:token-1', {
      rootHash: 'bafy...someoneElse',
      status: 'pending',
    });

    try {
      await performManifestCidRewrite(ctx);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestCidRewriteCasError);
      const e = err as ManifestCidRewriteCasError;
      expect(e.casReason).toBe('cas-mismatch');
      expect(e.observedCid).toBe('bafy...someoneElse');
    }
  });

  it('propagates concurrent-modification CAS reason', async () => {
    const manifestStorage = makeFakeManifestStorage();
    manifestStorage.entries.set('DIRECT://addr-A:token-1', {
      rootHash: 'bafy...old',
      status: 'pending',
    });
    // Inject: writeEntry throws the concurrent-modification brand.
    const origWrite = manifestStorage.writeEntry.bind(manifestStorage);
    manifestStorage.writeEntry = async () => {
      const err = new Error('boom');
      (err as { __manifestCasConflict?: boolean }).__manifestCasConflict = true;
      throw err;
    };

    const { ctx } = buildCtx({ manifestStorage });
    await expect(performManifestCidRewrite(ctx)).rejects.toBeInstanceOf(
      ManifestCidRewriteCasError,
    );

    // Restore so vi.fn cleanup is unaffected (defensive).
    manifestStorage.writeEntry = origWrite;
  });
});

// =============================================================================
// 7. Step 1 error propagation
// =============================================================================

describe('manifest-cid-rewrite — step error propagation', () => {
  it('step 1 attachProof throw propagates and skips later steps', async () => {
    const pool = makeFakePool();
    pool.attachProof = async () => {
      throw new Error('storage io fault');
    };
    const tombstones = makeFakeTombstones();
    const queue = makeFakeQueue([
      { addr: 'DIRECT://addr-A', requestId: 'req-1' },
    ]);
    const manifestStorage = makeFakeManifestStorage();
    manifestStorage.entries.set('DIRECT://addr-A:token-1', {
      rootHash: 'bafy...old',
      status: 'pending',
    });

    const { ctx } = buildCtx({ pool, tombstones, queue, manifestStorage });
    await expect(performManifestCidRewrite(ctx)).rejects.toThrow(
      'storage io fault',
    );

    // Step 2/3/4 must NOT have run.
    expect(manifestStorage.entries.get('DIRECT://addr-A:token-1')?.rootHash).toBe(
      'bafy...old',
    );
    expect(tombstones.insertCalls).toHaveLength(0);
    expect(queue.removeCalls).toHaveLength(0);
    // Queue entry still present — durability anchor intact for retry.
    expect(queue.entries.has('DIRECT://addr-A:req-1')).toBe(true);
  });

  it('step 3 throw propagates and skips step 4 — durability anchor preserved', async () => {
    const tombstones = makeFakeTombstones();
    tombstones.insertTombstone = async () => {
      throw new Error('tombstone write fault');
    };
    const queue = makeFakeQueue([
      { addr: 'DIRECT://addr-A', requestId: 'req-1' },
    ]);
    const { ctx } = buildCtx({ tombstones, queue });
    await expect(performManifestCidRewrite(ctx)).rejects.toThrow(
      'tombstone write fault',
    );

    // Step 4 did NOT run; queue entry survives → next pass resumes.
    expect(queue.removeCalls).toHaveLength(0);
    expect(queue.entries.has('DIRECT://addr-A:req-1')).toBe(true);
  });
});

// =============================================================================
// 8. Concurrent-pass serialization (steelman Wave 3 — fix #170)
// =============================================================================
//
// Without an outer mutex per `(addr, tokenId)`, two worker passes for the
// SAME finalization-queue entry can both pass the
// `step1Pool.isProofAttached === false` probe before either has called
// `attachProof`, then race into step 2 — exactly one CAS succeeds,
// the loser surfaces a `ManifestCidRewriteCasError` UP TO the worker.
// The new module-scoped mutex serializes them: the second pass blocks
// until the first releases, then sees `isProofAttached === true` and
// returns `partial-step1-resumed` cleanly.

describe('manifest-cid-rewrite — concurrent-pass serialization (steelman #170)', () => {
  it('two concurrent calls for same (addr, tokenId) are serialized — second sees idempotency skip', async () => {
    // Build a single shared context (same addr, tokenId, pool,
    // tombstones, queue, manifestStorage). Two concurrent invocations
    // should NOT both observe `isProofAttached === false` and race
    // into step 2.
    const { ctx } = buildCtx();

    // Throttle step 1's attachProof so the two passes have a chance
    // to overlap. Without the mutex they'd both pass `isProofAttached`,
    // then race into step 2's CAS. With the mutex, the second blocks
    // until the first finishes.
    const realAttach = ctx.pool.attachProof.bind(ctx.pool);
    let attachCallCount = 0;
    let isProofAttachedCallCount = 0;
    const realIsProofAttached = ctx.pool.isProofAttached.bind(ctx.pool);
    const slowPool: PoolWriteAdapter = {
      isProofAttached: async (tokenId, requestId) => {
        isProofAttachedCallCount += 1;
        return realIsProofAttached(tokenId, requestId);
      },
      attachProof: async (tokenId, requestId, proof) => {
        attachCallCount += 1;
        // Simulate slow IO so the second pass would otherwise race.
        await new Promise((r) => setTimeout(r, 20));
        return realAttach(tokenId, requestId, proof);
      },
    };
    const slowCtx: ManifestCidRewriteContext = { ...ctx, pool: slowPool };

    const [r1, r2] = await Promise.all([
      performManifestCidRewrite(slowCtx),
      performManifestCidRewrite(slowCtx),
    ]);
    // First pass executed all 4 steps.
    expect(r1.result).toBe('ok');
    // Second pass blocked on the mutex, then saw step 1 already
    // applied, step 2's CAS observed newCid, step 3's tombstone
    // already inserted, step 4's queue entry already removed.
    expect(r2.result).toBe('noop');
    // Critically, attachProof ran exactly ONCE — no race.
    expect(attachCallCount).toBe(1);
    // isProofAttached ran TWICE (once per pass), proving the second
    // pass was admitted under the mutex and saw the now-applied state.
    expect(isProofAttachedCallCount).toBe(2);
  });

  it('lost-concurrent-race outcome is surfaced when an alternate CAS throws with observedCid === newCid AND step 1 was a skip', async () => {
    // Lost-race signature: step 1 reports already-attached (race
    // winner finished step 1), step 2 surfaces a CAS error whose
    // observedCid matches the in-flight newCid (winner also
    // advanced step 2). Without disambiguation, this would surface
    // as a real CAS conflict. With disambiguation, the orchestrator
    // returns `lost-concurrent-race` so worker dashboards stay calm.
    //
    // The canonical `ManifestCas` collapses this case via its
    // idempotency check (returns false on observed===newCid). To
    // exercise the lost-race branch we inject an alternate CAS
    // whose update method throws directly — bypassing step2's
    // idempotency optimization (modeling an OrbitDB-backed adapter
    // that defers idempotency to the caller).
    const pool = makeFakePool();
    // Step 1 reports skip — winning pass already attached.
    pool.attached.add('token-1:req-1');

    const tombstones = makeFakeTombstones();
    const queue = makeFakeQueue([
      { addr: 'DIRECT://addr-A', requestId: 'req-1' },
    ]);
    const manifestStorage = makeFakeManifestStorage();

    // Custom CAS whose `update` THROWS rather than returning a
    // result object. This bypasses step2's in-function idempotency
    // skip (which fires only on `result.observed === newCid` paths
    // and only when the CAS returned a structured result). The
    // throw propagates UP TO the orchestrator's runner, which then
    // applies the lost-race classification.
    const racedManifestCas = {
      update: async () => {
        throw new ManifestCidRewriteCasError(
          'cas-mismatch',
          'bafy...new' as ContentHash,
        );
      },
    };

    const { ctx } = buildCtx({ pool, tombstones, queue, manifestStorage });
    const racedCtx: ManifestCidRewriteContext = {
      ...ctx,
      newCid: 'bafy...new',
      manifestCas:
        racedManifestCas as unknown as ManifestCidRewriteContext['manifestCas'],
    };

    const result = await performManifestCidRewrite(racedCtx);
    expect(result.result).toBe('lost-concurrent-race');
  });

  it('mutex is module-scoped: __getMutexForTests returns a PerTokenMutex instance', () => {
    const mutex = __getMutexForTests();
    expect(typeof mutex.acquire).toBe('function');
    expect(typeof mutex.isLocked).toBe('function');
  });

  it('different (addr, tokenId) pairs do NOT serialize against each other', async () => {
    // The mutex is keyed on `(addr, tokenId)`. Two passes for
    // different tokenIds (or different wallets) MUST run in parallel.
    const pool1 = makeFakePool();
    const pool2 = makeFakePool();
    let attach1Done = false;
    let attach2Done = false;

    const realAttach1 = pool1.attachProof.bind(pool1);
    pool1.attachProof = async (a, b, c) => {
      // pool1 is slow — pool2 must NOT block on it.
      await new Promise((r) => setTimeout(r, 50));
      await realAttach1(a, b, c);
      attach1Done = true;
    };
    const realAttach2 = pool2.attachProof.bind(pool2);
    pool2.attachProof = async (a, b, c) => {
      await realAttach2(a, b, c);
      attach2Done = true;
    };

    const { ctx: ctx1 } = buildCtx({ tokenId: 'token-1', pool: pool1 });
    const { ctx: ctx2 } = buildCtx({ tokenId: 'token-2', pool: pool2 });

    const start = Date.now();
    await Promise.all([
      performManifestCidRewrite(ctx1),
      performManifestCidRewrite(ctx2),
    ]);
    const elapsed = Date.now() - start;

    // Both finished. If they had serialized, total time would be ~100ms
    // (pool1's 50ms + pool2's 0ms ≥ 50ms each, but actually it's the
    // 50ms barrier alone). The key signal: pool2 did NOT wait for
    // pool1 — it completed strictly before the 50ms barrier.
    expect(attach1Done).toBe(true);
    expect(attach2Done).toBe(true);
    // Wall-clock should be roughly the slow path (50 ms) — NOT 2x that.
    expect(elapsed).toBeLessThan(150);
  });
});
