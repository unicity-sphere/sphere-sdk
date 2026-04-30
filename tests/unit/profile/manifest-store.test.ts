/**
 * Tests for `profile/manifest-store.ts` — UXF Transfer Protocol
 * §5.4 / §5.5 step 9 (T.3.C).
 *
 * Covers:
 *   1. mergeManifestEntry (pure)
 *      a. set-OR merge for `audit_promoted_from`.
 *      b. union merge for `conflictingHeads` (deduplicated, sorted).
 *      c. max-merge for `lamport`.
 *      d. max-merge for `lastProofRefreshAt`.
 *      e. splitParent preserved-if-set; lex-min on divergence.
 *      f. chain-content fields (rootHash, status) taken from `next`.
 *      g. first-write passthrough (prev === undefined).
 *
 *   2. ManifestStore.upsert
 *      h. Straight write when no existing entry.
 *      i. Set-OR merge of audit_promoted_from on overwrite.
 *      j. Lamport monotonic merge (post-merge >= max(prev, next, observed)).
 *      k. CAS retry on `cas-mismatch` (one mismatch, then succeeds).
 *      l. CAS retry exhaustion → MANIFEST_CAS_RETRY_EXHAUSTED.
 *      m. concurrent-modification → also retries.
 *
 *   3. ManifestStore.addAuditPromotedFrom
 *      n. set-OR semantics with existing array.
 *      o. idempotent on the same audit key (no duplication).
 *
 *   4. Constructor validation
 *      p. maxRetries must be a positive integer.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CAS_MAX_RETRIES,
  ManifestStore,
  mergeManifestEntry,
} from '../../../profile/manifest-store.js';
import {
  ManifestCas,
  ManifestCasConcurrentModificationError,
  type MinimalManifestStorage,
} from '../../../profile/manifest-cas.js';
import { Lamport } from '../../../profile/lamport.js';
import { SphereError } from '../../../core/errors.js';
import type {
  TokenManifestEntry,
  TokenManifestStatus,
} from '../../../profile/token-manifest.js';
import type { ContentHash } from '../../../uxf/types.js';

// =============================================================================
// Fixtures
// =============================================================================

const ch = (s: string): ContentHash => s as ContentHash;

const ADDR = 'DIRECT_aabbcc_ddeeff';
const TOKEN_A = '0xtokenA';

const makeEntry = (
  overrides: Partial<TokenManifestEntry> = {},
): TokenManifestEntry => ({
  rootHash: ch('a'.repeat(64)),
  status: 'valid' as TokenManifestStatus,
  ...overrides,
});

/** In-memory MinimalManifestStorage with deterministic CAS-conflict injection. */
class FakeStorage implements MinimalManifestStorage {
  readonly store = new Map<string, TokenManifestEntry>();
  /** Queue of errors to throw on subsequent writeEntry calls — FIFO. */
  readonly throwQueue: Array<Error | null> = [];
  /** Number of successful writes (for assertions). */
  writeCount = 0;
  /** Number of read calls. */
  readCount = 0;

  private k(addr: string, tokenId: string): string {
    return `${addr}|${tokenId}`;
  }

  async readEntry(
    addr: string,
    tokenId: string,
  ): Promise<TokenManifestEntry | undefined> {
    this.readCount++;
    return this.store.get(this.k(addr, tokenId));
  }

  async writeEntry(
    addr: string,
    tokenId: string,
    entry: TokenManifestEntry,
  ): Promise<void> {
    if (this.throwQueue.length > 0) {
      const next = this.throwQueue.shift();
      if (next) throw next;
    }
    this.writeCount++;
    this.store.set(this.k(addr, tokenId), entry);
  }

  setRaw(addr: string, tokenId: string, entry: TokenManifestEntry): void {
    this.store.set(this.k(addr, tokenId), entry);
  }
}

// =============================================================================
// 1. mergeManifestEntry — pure helper
// =============================================================================

describe('mergeManifestEntry — §5.4 metadata-preservation rules', () => {
  it('returns next as-is when prev is undefined (first write)', () => {
    const next = makeEntry({ lamport: 7, audit_promoted_from: ['k1'] });
    expect(mergeManifestEntry(undefined, next)).toEqual(next);
  });

  it('set-OR merges audit_promoted_from (deduplicated + lex-sorted)', () => {
    const prev = makeEntry({
      audit_promoted_from: ['z-key', 'a-key'],
    });
    const next = makeEntry({
      audit_promoted_from: ['m-key', 'a-key'],
    });
    const merged = mergeManifestEntry(prev, next);
    expect(merged.audit_promoted_from).toEqual(['a-key', 'm-key', 'z-key']);
  });

  it('omits audit_promoted_from when both sides are empty/absent', () => {
    const prev = makeEntry();
    const next = makeEntry();
    const merged = mergeManifestEntry(prev, next);
    expect('audit_promoted_from' in merged).toBe(false);
  });

  it('unions conflictingHeads (deduplicated + lex-sorted)', () => {
    const prev = makeEntry({
      conflictingHeads: [ch('cccc'), ch('aaaa')],
    });
    const next = makeEntry({
      conflictingHeads: [ch('bbbb'), ch('aaaa')],
    });
    const merged = mergeManifestEntry(prev, next);
    expect(merged.conflictingHeads).toEqual(['aaaa', 'bbbb', 'cccc']);
  });

  it('max-merges lamport per §7.1', () => {
    const prev = makeEntry({ lamport: 5 });
    const next = makeEntry({ lamport: 12 });
    expect(mergeManifestEntry(prev, next).lamport).toBe(12);
    expect(mergeManifestEntry(next, prev).lamport).toBe(12);
  });

  it('max-merges lastProofRefreshAt', () => {
    const prev = makeEntry({ lastProofRefreshAt: 1_000 });
    const next = makeEntry({ lastProofRefreshAt: 2_000 });
    expect(mergeManifestEntry(prev, next).lastProofRefreshAt).toBe(2_000);
  });

  it('preserves splitParent if either side has it', () => {
    const prev = makeEntry({ splitParent: 'parent-tok' });
    const next = makeEntry();
    expect(mergeManifestEntry(prev, next).splitParent).toBe('parent-tok');
    expect(mergeManifestEntry(next, prev).splitParent).toBe('parent-tok');
  });

  it('uses lex-min splitParent on divergence (defect path)', () => {
    const prev = makeEntry({ splitParent: 'parent-z' });
    const next = makeEntry({ splitParent: 'parent-a' });
    expect(mergeManifestEntry(prev, next).splitParent).toBe('parent-a');
  });

  it('chain-content fields (rootHash, status) taken from chain winner — next when lex-min', () => {
    // prev='prev-root...' vs next='next-root...'. With no bundleCids set,
    // the symmetric defense-in-depth fallback picks lex-min on rootHash.
    // 'next-root...' < 'prev-root...' (since 'n' < 'p' in ASCII), so `next`
    // wins — same outcome as the old "next always wins" rule on these inputs.
    const prev = makeEntry({
      rootHash: ch('prev-root'.padEnd(64, '0')),
      status: 'valid',
    });
    const next = makeEntry({
      rootHash: ch('next-root'.padEnd(64, '0')),
      status: 'pending',
    });
    const merged = mergeManifestEntry(prev, next);
    expect(merged.rootHash).toBe(ch('next-root'.padEnd(64, '0')));
    expect(merged.status).toBe('pending');
  });

  it('defense-in-depth: rootHash divergence is resolved symmetrically via the comparator', () => {
    // The `compareCidsBinary` arg drives the symmetric tie-break when
    // `prev.rootHash !== next.rootHash` and no bundleCid is available.
    // With a stub that always returns 1 (a > b), the second arg is the
    // lex-min winner — i.e., `next` here.
    const stub = (): -1 | 0 | 1 => 1;
    const prev = makeEntry({ rootHash: ch('a'.repeat(64)) });
    const next = makeEntry({ rootHash: ch('b'.repeat(64)) });
    const merged = mergeManifestEntry(prev, next, stub);
    expect(merged.rootHash).toBe(ch('b'.repeat(64)));
  });

  it('mergeManifestEntry(A, B).rootHash === mergeManifestEntry(B, A).rootHash on divergent rootHash inputs', () => {
    // Symmetry property — the steelman defense. Without the symmetric
    // fallback, the persisted rootHash would flip-flop between replicas
    // depending on whose merge ran first. Test all three branches of the
    // tie-break ladder.

    // Branch 1: both sides have bundleCid → lex-min bundleCid wins.
    const a1 = makeEntry({
      rootHash: ch('aa'.repeat(32)),
      bundleCid: 'zzz-cid',
    });
    const b1 = makeEntry({
      rootHash: ch('bb'.repeat(32)),
      bundleCid: 'aaa-cid',
    });
    const ab1 = mergeManifestEntry(a1, b1);
    const ba1 = mergeManifestEntry(b1, a1);
    expect(ab1.rootHash).toBe(ba1.rootHash);
    expect(ab1.bundleCid).toBe(ba1.bundleCid);
    expect(ab1.bundleCid).toBe('aaa-cid'); // lex-min wins
    expect(ab1.rootHash).toBe(ch('bb'.repeat(32))); // rootHash from same side

    // Branch 2: only one side has bundleCid → that side wins symmetrically.
    const a2 = makeEntry({
      rootHash: ch('aa'.repeat(32)),
      bundleCid: 'some-cid',
    });
    const b2 = makeEntry({ rootHash: ch('bb'.repeat(32)) });
    const ab2 = mergeManifestEntry(a2, b2);
    const ba2 = mergeManifestEntry(b2, a2);
    expect(ab2.rootHash).toBe(ba2.rootHash);
    expect(ab2.rootHash).toBe(ch('aa'.repeat(32))); // a2 wins (has bundleCid)

    // Branch 3: neither side has bundleCid → lex-min rootHash wins.
    const a3 = makeEntry({ rootHash: ch('aa'.repeat(32)) });
    const b3 = makeEntry({ rootHash: ch('bb'.repeat(32)) });
    const ab3 = mergeManifestEntry(a3, b3);
    const ba3 = mergeManifestEntry(b3, a3);
    expect(ab3.rootHash).toBe(ba3.rootHash);
    expect(ab3.rootHash).toBe(ch('aa'.repeat(32))); // lex-min
  });
});

// =============================================================================
// 2. ManifestStore.upsert — read-merge-CAS-retry semantics
// =============================================================================

describe('ManifestStore.upsert', () => {
  let storage: FakeStorage;
  let store: ManifestStore;
  let lamport: Lamport;

  beforeEach(() => {
    storage = new FakeStorage();
    lamport = new Lamport();
    store = new ManifestStore({ storage, lamport });
  });

  it('writes straight through when no existing entry', async () => {
    const next = makeEntry({ rootHash: ch('a'.repeat(64)) });
    const result = await store.upsert(ADDR, TOKEN_A, next);
    expect(result.rootHash).toBe(ch('a'.repeat(64)));
    expect(result.lamport).toBe(1); // first bump
    expect(storage.writeCount).toBe(1);
  });

  it('set-OR merges audit_promoted_from on overwrite', async () => {
    // Boot the local Lamport up to a value compatible with the W39
    // bounds defense (2× the max observed remote). In production, the
    // local clock loads from storage; in tests we hand-prime it.
    lamport.bumpFor([]);
    lamport.bumpFor([]);
    lamport.bumpFor([]); // local now 3

    storage.setRaw(
      ADDR,
      TOKEN_A,
      makeEntry({
        rootHash: ch('a'.repeat(64)),
        audit_promoted_from: ['key-1'],
        lamport: 3,
      }),
    );

    const next = makeEntry({
      rootHash: ch('a'.repeat(64)),
      audit_promoted_from: ['key-2'],
    });

    const result = await store.upsert(ADDR, TOKEN_A, next);
    expect(result.audit_promoted_from).toEqual(['key-1', 'key-2']);
  });

  it('Lamport bump observes both prev and next (monotonic merge)', async () => {
    // Boot local clock high enough that observed=10 satisfies the W39
    // bound `2 × max(local, 1) ≥ 10`, i.e. local ≥ 5.
    const primed = new Lamport(5);
    const localStore = new ManifestStore({ storage, lamport: primed });

    // Prime storage with prev.lamport = 10.
    storage.setRaw(
      ADDR,
      TOKEN_A,
      makeEntry({ rootHash: ch('p'.repeat(64)), lamport: 10 }),
    );

    // next.lamport = 5 (older). Bump should observe both 10 and 5,
    // pick max(local=5, observedRemotes={10,5}) = 10, and bump to 11.
    const next = makeEntry({ rootHash: ch('p'.repeat(64)), lamport: 5 });
    const result = await localStore.upsert(ADDR, TOKEN_A, next);
    expect(result.lamport).toBe(11);
    expect(primed.getCurrent()).toBe(11);
  });

  it('CAS retries once on cas-mismatch then succeeds', async () => {
    // Initial state: an entry exists. We want `next` to win the symmetric
    // tie-break so the assertion below remains meaningful — pick prev with
    // a lex-greater rootHash than next.
    storage.setRaw(
      ADDR,
      TOKEN_A,
      makeEntry({ rootHash: ch('c'.repeat(64)), lamport: 1 }),
    );

    // Inject a one-shot ManifestCasConcurrentModificationError on the
    // first writeEntry attempt — the upsert MUST catch and retry.
    storage.throwQueue.push(new ManifestCasConcurrentModificationError());

    const next = makeEntry({
      rootHash: ch('b'.repeat(64)),
      lamport: 2,
    });

    const result = await store.upsert(ADDR, TOKEN_A, next);
    // 'b'×64 < 'c'×64 → next wins under lex-min defense-in-depth.
    expect(result.rootHash).toBe(ch('b'.repeat(64)));
    expect(storage.writeCount).toBe(1); // one successful, one threw
    // Read count: at least 2 (one per attempt).
    expect(storage.readCount).toBeGreaterThanOrEqual(2);
  });

  it('CAS retries on every attempt → MANIFEST_CAS_RETRY_EXHAUSTED', async () => {
    storage.setRaw(
      ADDR,
      TOKEN_A,
      makeEntry({ rootHash: ch('a'.repeat(64)), lamport: 1 }),
    );

    // Inject `CAS_MAX_RETRIES + 1` failures so every attempt fails.
    for (let i = 0; i < CAS_MAX_RETRIES + 1; i++) {
      storage.throwQueue.push(new ManifestCasConcurrentModificationError());
    }

    const next = makeEntry({ rootHash: ch('b'.repeat(64)) });

    await expect(store.upsert(ADDR, TOKEN_A, next)).rejects.toMatchObject({
      code: 'MANIFEST_CAS_RETRY_EXHAUSTED',
    });
    expect(storage.writeCount).toBe(0);
  });

  it('non-CAS errors propagate immediately', async () => {
    const fatal = new Error('fs corrupted');
    storage.throwQueue.push(fatal);

    const next = makeEntry();

    await expect(store.upsert(ADDR, TOKEN_A, next)).rejects.toThrow(fatal);
    // Should NOT retry on a non-CAS error.
    expect(storage.throwQueue.length).toBe(0);
  });

  it('respects custom maxRetries setting', async () => {
    storage.setRaw(
      ADDR,
      TOKEN_A,
      makeEntry({ rootHash: ch('a'.repeat(64)), lamport: 1 }),
    );

    const customStore = new ManifestStore({ storage, lamport, maxRetries: 1 });

    // One failure exhausts a 1-retry budget.
    storage.throwQueue.push(new ManifestCasConcurrentModificationError());

    const next = makeEntry({ rootHash: ch('b'.repeat(64)) });

    await expect(customStore.upsert(ADDR, TOKEN_A, next)).rejects.toMatchObject({
      code: 'MANIFEST_CAS_RETRY_EXHAUSTED',
    });
  });
});

// =============================================================================
// 3. ManifestStore.addAuditPromotedFrom
// =============================================================================

describe('ManifestStore.addAuditPromotedFrom', () => {
  let storage: FakeStorage;
  let store: ManifestStore;

  beforeEach(() => {
    storage = new FakeStorage();
    store = new ManifestStore({ storage, lamport: new Lamport() });
  });

  it('seeds audit_promoted_from on first write', async () => {
    const baseDelta = makeEntry({
      rootHash: ch('a'.repeat(64)),
      status: 'valid',
    });
    const result = await store.addAuditPromotedFrom(
      ADDR,
      TOKEN_A,
      ['audit-key-1'],
      baseDelta,
    );
    expect(result.audit_promoted_from).toEqual(['audit-key-1']);
  });

  it('set-OR merges with existing audit_promoted_from', async () => {
    storage.setRaw(
      ADDR,
      TOKEN_A,
      makeEntry({
        rootHash: ch('a'.repeat(64)),
        audit_promoted_from: ['existing-key'],
        lamport: 1,
      }),
    );

    const result = await store.addAuditPromotedFrom(
      ADDR,
      TOKEN_A,
      ['new-key'],
      makeEntry({ rootHash: ch('a'.repeat(64)) }),
    );
    expect(result.audit_promoted_from).toEqual(['existing-key', 'new-key']);
  });

  it('is idempotent on the same audit key (no duplication)', async () => {
    storage.setRaw(
      ADDR,
      TOKEN_A,
      makeEntry({
        rootHash: ch('a'.repeat(64)),
        audit_promoted_from: ['k1'],
        lamport: 1,
      }),
    );

    const baseDelta = makeEntry({ rootHash: ch('a'.repeat(64)) });
    await store.addAuditPromotedFrom(ADDR, TOKEN_A, ['k1'], baseDelta);
    const result = await store.addAuditPromotedFrom(ADDR, TOKEN_A, ['k1'], baseDelta);

    expect(result.audit_promoted_from).toEqual(['k1']);
  });
});

// =============================================================================
// 4. lex-min tie-break for conflicting bundleCids — exposed via a CID
//    comparator stub. The comparator hook on `mergeManifestEntry` is
//    intentionally a no-op today (chain-content from next), but the
//    constructor accepts a custom CAS so we can exercise the
//    upstream-decision contract here by constructing the conflicting
//    delta with a known winner.
// =============================================================================

describe('lex-min tie-break (upstream-decision contract)', () => {
  it('manifest store records the lex-min bundleCid winner stamped by upstream', async () => {
    const storage = new FakeStorage();
    const store = new ManifestStore({ storage, lamport: new Lamport() });

    // Initial: prev came from a HIGHER bundleCid (the loser, lex-greater).
    storage.setRaw(
      ADDR,
      TOKEN_A,
      makeEntry({
        rootHash: ch('loser-root'.padEnd(64, '0')),
        status: 'conflicting',
        conflictingHeads: [ch('loser-root'.padEnd(64, '0'))],
        bundleCid: 'bafy-z-loser',
        lamport: 1,
      }),
    );

    // Upstream §5.3 [D] picked the lex-min winner and stamps the
    // manifest delta with the winner's rootHash + bundleCid. With the
    // T.3.C defense-in-depth fallback, the merge ALSO picks lex-min
    // bundleCid locally — both paths converge on the same winner.
    const winnerDelta = makeEntry({
      rootHash: ch('winner-root'.padEnd(64, '0')),
      status: 'conflicting',
      conflictingHeads: [
        ch('winner-root'.padEnd(64, '0')),
        ch('loser-root'.padEnd(64, '0')),
      ],
      bundleCid: 'bafy-a-winner', // lex-min wins
    });

    const result = await store.upsert(ADDR, TOKEN_A, winnerDelta);
    // Winner survives in chain-content fields.
    expect(result.rootHash).toBe(ch('winner-root'.padEnd(64, '0')));
    expect(result.bundleCid).toBe('bafy-a-winner');
    // Loser preserved in conflictingHeads via set-OR merge.
    expect(result.conflictingHeads).toEqual([
      ch('loser-root'.padEnd(64, '0')),
      ch('winner-root'.padEnd(64, '0')),
    ]);
  });
});

// =============================================================================
// 5. Constructor validation
// =============================================================================

describe('ManifestStore constructor', () => {
  it('rejects non-positive maxRetries', () => {
    const storage = new FakeStorage();
    expect(
      () => new ManifestStore({ storage, lamport: new Lamport(), maxRetries: 0 }),
    ).toThrow(SphereError);
    expect(
      () => new ManifestStore({ storage, lamport: new Lamport(), maxRetries: -1 }),
    ).toThrow(SphereError);
    expect(
      () => new ManifestStore({ storage, lamport: new Lamport(), maxRetries: 1.5 }),
    ).toThrow(SphereError);
  });

  it('accepts a custom CAS injection', async () => {
    const storage = new FakeStorage();
    const cas = new ManifestCas(storage);
    const store = new ManifestStore({ storage, lamport: new Lamport(), cas });

    const result = await store.upsert(ADDR, TOKEN_A, makeEntry());
    expect(result.lamport).toBe(1);
  });
});
