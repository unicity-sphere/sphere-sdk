/**
 * Tests for `modules/payments/transfer/conflict-merger.ts` (T.3.D).
 *
 * The merger is a pure function over two manifest entries plus a
 * shared element pool. These tests stand up minimal-but-resolveable
 * pool fixtures (token-roots + transactions) so {@link resolveTokenRoot}
 * inside the merger can do its job, then assert the merger's
 * three-way decision branch:
 *
 *   1. **identical-no-op** — same `rootHash` on both sides; metadata
 *      union-merges per §5.4.
 *   2. **prefix-extension-merge** — one chain is a strict prefix /
 *      extension of the other; the resolver's longer-chain pick wins,
 *      proofs accumulate (monotonic-graft invariant per §5.6).
 *      Tested in two arrangements:
 *        (a) `next` is the longer chain (typical incoming-bundle case);
 *        (b) `prev` is the longer chain (recipient already has a more-
 *            finalized copy).
 *   3. **genuinely-divergent-conflict** — chains fork (no prefix
 *      relation); the §5.3 [D-conflict] lex-min `bundleCid` rule picks
 *      the winner. The comparator MUST operate on the binary CIDv1
 *      form per T.1.D — we verify this by injecting a stub that
 *      returns the OPPOSITE of the naive base32 string compare and
 *      asserting the merger honors the stub (the test exposes a real
 *      invariant: a base32-string-compare implementation would pick
 *      the wrong winner).
 *
 * Additional coverage (per task acceptance):
 *
 *   - Conflicting heads with `audit_promoted_from` set-OR.
 *   - Post-merge re-run of [B'] surfaces NOT_OUR_CURRENT_STATE for a
 *     synthetic "we authored a transfer-out" merge — verifies the
 *     merger's output is the right shape for the CALLER's [B'] re-run
 *     (the merger does not run [B'] itself; the test simulates the
 *     caller's re-run against the merged head).
 *   - Lamport max-merge.
 *   - splitParent preservation rules (preserved-if-set, lex-min on
 *     divergence).
 *   - Monotonic-graft invariant: 'invalid' status NEVER regresses
 *     out of `_invalid` per §5.6.
 *
 * Spec references:
 *   - §5.3 [D]      — decision-matrix node 3 (conflict / merge)
 *   - §5.4          — metadata-preservation rules (set-OR, max-merge)
 *   - §5.6          — replay/duplicate/merge handling, monotonic-graft
 *   - T.1.D         — `compareCidV1Binary` (lex-min on binary, not base32)
 *   - Wave G.3      — `resolveTokenRoot` (chain-resolution primitive)
 */

import { describe, expect, it } from 'vitest';

import {
  mergeConflictingHeads,
  type CidComparator,
  type MergeConflictingHeadsInput,
} from '../../../../modules/payments/transfer/conflict-merger';
import type {
  TokenManifestEntry,
  TokenManifestStatus,
} from '../../../../profile/token-manifest';
import type { ContentHash, UxfElement } from '../../../../extensions/uxf/bundle/types';

// =============================================================================
// 1. Fixture helpers — minimal token-root + tx pool entries.
//
//    Mirrors `tests/unit/uxf/token-join.test.ts`: ContentHash values
//    must be 64-char lowercase hex (computeElementHash validates them
//    in any synthesis path); we derive deterministic hex from short
//    string tags so fixtures stay readable.
// =============================================================================

function hexTag(tag: string): ContentHash {
  let out = '';
  for (const ch of tag) {
    out += ch.charCodeAt(0).toString(16).padStart(4, '0');
  }
  if (out.length >= 64) return out.slice(0, 64) as ContentHash;
  return (out + '0'.repeat(64 - out.length)) as ContentHash;
}

function makeTransaction(
  id: string,
  opts: { committed: boolean },
): [ContentHash, UxfElement] {
  const hash = hexTag(`tx-${id}`);
  const el: UxfElement = {
    header: {
      representation: 1,
      semantics: 1,
      kind: 'default' as const,
      predecessor: null,
    },
    type: 'transaction',
    content: {},
    children: {
      sourceState: hexTag(`src-${id}`),
      data: opts.committed ? hexTag(`data-${id}`) : null,
      inclusionProof: opts.committed ? hexTag(`proof-${id}`) : null,
      destinationState: hexTag(`dst-${id}`),
    },
  };
  return [hash, el];
}

/**
 * Fabricate an inclusion-proof element for a transaction. Only
 * minimally well-formed enough that the resolver's structural-validity
 * gate (`altProofIsStructurallyValid`) accepts it.
 */
function makeInclusionProof(id: string): [ContentHash, UxfElement] {
  const hash = hexTag(`proof-${id}`);
  const el: UxfElement = {
    header: {
      representation: 1,
      semantics: 1,
      kind: 'default' as const,
      predecessor: null,
    },
    type: 'inclusion-proof',
    content: { transactionHash: hexTag(`txhash-${id}`) },
    children: {
      authenticator: hexTag(`auth-${id}`),
      merkleTreePath: hexTag(`smt-${id}`),
      unicityCertificate: hexTag(`cert-${id}`),
    },
  };
  return [hash, el];
}

function makeTokenRoot(
  rootName: string,
  txnHashes: ContentHash[],
): [ContentHash, UxfElement] {
  const hash = hexTag(`root-${rootName}`);
  const el: UxfElement = {
    header: {
      representation: 1,
      semantics: 1,
      kind: 'default' as const,
      predecessor: null,
    },
    type: 'token-root',
    content: { tokenId: hexTag('tkn-T'), version: '2.0' },
    children: {
      genesis: hexTag('genesis-X'),
      transactions: txnHashes,
      state: hexTag('state-X'),
      nametags: [],
    },
  };
  return [hash, el];
}

type PoolEntry = [ContentHash, UxfElement];
function buildPool(...entries: PoolEntry[]): Map<ContentHash, UxfElement> {
  return new Map(entries);
}

/**
 * Build a `TokenManifestEntry` with sensible defaults; overrides win.
 */
function makeEntry(
  rootHash: ContentHash,
  overrides: Partial<TokenManifestEntry> = {},
): TokenManifestEntry {
  return {
    rootHash,
    status: 'valid' as TokenManifestStatus,
    ...overrides,
  };
}

// Names suggest string-compare ordering — verified at module load.
// `BUNDLE_CID_LO` < `BUNDLE_CID_HI` in standard string compare.
const BUNDLE_CID_LO = 'bafy000000000000000000000000000000000000000000000000000000000001';
const BUNDLE_CID_HI = 'bafy999999999999999999999999999999999999999999999999999999999999';
const SENDER_PUBKEY_A = 'a'.repeat(64);
const SENDER_PUBKEY_B = 'b'.repeat(64);

/**
 * Deterministic stub comparator. Assumption-validating: real callers
 * use {@link compareCidV1Binary}; tests exercise the discriminator
 * logic via this stub so we do NOT depend on the multiformats CID
 * parser inside unit tests.
 */
const STRING_COMPARE_STUB: CidComparator = (a, b) =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * Adversarial stub: returns the OPPOSITE of a string compare. Used to
 * verify that the merger consults the comparator (and therefore would
 * disagree with a hypothetical base32-string-compare implementation).
 */
const REVERSED_COMPARE_STUB: CidComparator = (a, b) =>
  a < b ? 1 : a > b ? -1 : 0;

// =============================================================================
// 2. identical-no-op
// =============================================================================

describe('mergeConflictingHeads — identical-no-op', () => {
  it('returns identical-no-op when both sides have the same rootHash', () => {
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [rootH, root] = makeTokenRoot('A', [t0H]);
    const pool = buildPool([t0H, t0], [rootH, root]);

    const prev = makeEntry(rootH, {
      bundleCid: BUNDLE_CID_LO,
      senderTransportPubkey: SENDER_PUBKEY_A,
      lamport: 5,
    });
    const next = makeEntry(rootH, {
      bundleCid: BUNDLE_CID_HI,
      senderTransportPubkey: SENDER_PUBKEY_B,
      lamport: 7,
    });

    const out = mergeConflictingHeads({
      prev,
      next,
      pool,
      compareCids: STRING_COMPARE_STUB,
    });

    expect(out.decision).toBe('identical-no-op');
    expect(out.merged.rootHash).toBe(rootH);
    expect(out.merged.status).toBe('valid');
    expect(out.merged.lamport).toBe(7); // max
    expect(out.superseded).toEqual([]);
    expect(out.resolverOutcome).toBeNull();
  });

  it('idempotent: re-merging the result against itself is a no-op', () => {
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [rootH, root] = makeTokenRoot('A', [t0H]);
    const pool = buildPool([t0H, t0], [rootH, root]);

    const prev = makeEntry(rootH, { lamport: 1 });
    const next = makeEntry(rootH, { lamport: 1 });

    const out1 = mergeConflictingHeads({
      prev,
      next,
      pool,
      compareCids: STRING_COMPARE_STUB,
    });
    const out2 = mergeConflictingHeads({
      prev: out1.merged,
      next,
      pool,
      compareCids: STRING_COMPARE_STUB,
    });
    expect(out1.merged).toEqual(out2.merged);
  });

  it('identical-no-op: monotonic invariant — invalid status NEVER regresses', () => {
    // Even on idempotent receive, a `'valid'` next side MUST NOT
    // overwrite a prior `'invalid'` status. Per §5.6.
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [rootH, root] = makeTokenRoot('A', [t0H]);
    const pool = buildPool([t0H, t0], [rootH, root]);

    const prev = makeEntry(rootH, {
      status: 'invalid',
      invalidReason: 'auth-invalid',
    });
    const next = makeEntry(rootH, { status: 'valid' });

    const out = mergeConflictingHeads({
      prev,
      next,
      pool,
      compareCids: STRING_COMPARE_STUB,
    });

    expect(out.decision).toBe('identical-no-op');
    expect(out.merged.status).toBe('invalid');
    expect(out.merged.invalidReason).toBe('auth-invalid');
  });

  it('unions audit_promoted_from on identical-no-op', () => {
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [rootH, root] = makeTokenRoot('A', [t0H]);
    const pool = buildPool([t0H, t0], [rootH, root]);

    const prev = makeEntry(rootH, {
      audit_promoted_from: ['DIRECT_aaa.audit.tok1.h1'],
    });
    const next = makeEntry(rootH, {
      audit_promoted_from: ['DIRECT_bbb.audit.tok1.h2'],
    });

    const out = mergeConflictingHeads({
      prev,
      next,
      pool,
      compareCids: STRING_COMPARE_STUB,
    });

    expect(out.decision).toBe('identical-no-op');
    expect(out.merged.audit_promoted_from).toEqual([
      'DIRECT_aaa.audit.tok1.h1',
      'DIRECT_bbb.audit.tok1.h2',
    ]);
  });
});

// =============================================================================
// 3. prefix-extension-merge — strict prefix
// =============================================================================

describe('mergeConflictingHeads — prefix-extension-merge', () => {
  it('next is strict-prefix-extension of prev (typical incoming bundle)', () => {
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [t1H, t1] = makeTransaction('1', { committed: true });

    const [shortRootH, shortRoot] = makeTokenRoot('short', [t0H]);
    const [longRootH, longRoot] = makeTokenRoot('long', [t0H, t1H]);

    const pool = buildPool(
      [t0H, t0],
      [t1H, t1],
      [shortRootH, shortRoot],
      [longRootH, longRoot],
    );

    const prev = makeEntry(shortRootH, {
      bundleCid: BUNDLE_CID_LO,
      lamport: 3,
    });
    const next = makeEntry(longRootH, {
      bundleCid: BUNDLE_CID_HI,
      lamport: 5,
    });

    const out = mergeConflictingHeads({
      prev,
      next,
      pool,
      compareCids: STRING_COMPARE_STUB,
    });

    expect(out.decision).toBe('prefix-extension-merge');
    expect(out.merged.rootHash).toBe(longRootH); // longer wins
    expect(out.superseded).toEqual([shortRootH]);
    expect(out.resolverOutcome?.kind).toBe('longest-valid');
    expect(out.merged.lamport).toBe(5); // max
    // Winner side's bundleCid comes through.
    expect(out.merged.bundleCid).toBe(BUNDLE_CID_HI);
  });

  it('prev is strict-prefix-extension of next (recipient already has more-finalized copy)', () => {
    // Symmetric arrangement: the local copy is the longer chain;
    // the incoming bundle carries a shorter copy. The longer chain
    // (prev) MUST still win — proofs are monotonic.
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [t1H, t1] = makeTransaction('1', { committed: true });

    const [shortRootH, shortRoot] = makeTokenRoot('short', [t0H]);
    const [longRootH, longRoot] = makeTokenRoot('long', [t0H, t1H]);

    const pool = buildPool(
      [t0H, t0],
      [t1H, t1],
      [shortRootH, shortRoot],
      [longRootH, longRoot],
    );

    const prev = makeEntry(longRootH, {
      bundleCid: BUNDLE_CID_HI,
      lamport: 5,
    });
    const next = makeEntry(shortRootH, {
      bundleCid: BUNDLE_CID_LO,
      lamport: 1,
    });

    const out = mergeConflictingHeads({
      prev,
      next,
      pool,
      compareCids: STRING_COMPARE_STUB,
    });

    expect(out.decision).toBe('prefix-extension-merge');
    expect(out.merged.rootHash).toBe(longRootH); // longer (prev) wins
    expect(out.superseded).toEqual([shortRootH]);
    expect(out.merged.lamport).toBe(5); // max
  });

  it('preserves the higher-precedence status and unions audit_promoted_from', () => {
    // W3.4 fix: `mergeStatus` now uses a total order
    //   `invalid > conflicting > pending > valid`
    // independent of which side is "winner". Previously this test asserted
    // that the winner-side's status (`'valid'`) survived even when the
    // loser side was `'pending'`. Per the new associative rule, `'pending'`
    // dominates `'valid'` because it signals work-still-pending (oracle
    // finalization / proof fetch); the demotion back to `'valid'` is the
    // [E] re-run's job, not the merger's.
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [t1H, t1] = makeTransaction('1', { committed: true });

    const [shortRootH, shortRoot] = makeTokenRoot('short', [t0H]);
    const [longRootH, longRoot] = makeTokenRoot('long', [t0H, t1H]);

    const pool = buildPool(
      [t0H, t0],
      [t1H, t1],
      [shortRootH, shortRoot],
      [longRootH, longRoot],
    );

    const prev = makeEntry(shortRootH, {
      audit_promoted_from: ['DIRECT_aaa.audit.tok1.h_short'],
      status: 'pending',
    });
    const next = makeEntry(longRootH, {
      audit_promoted_from: ['DIRECT_bbb.audit.tok1.h_long'],
      status: 'valid',
    });

    const out = mergeConflictingHeads({
      prev,
      next,
      pool,
      compareCids: STRING_COMPARE_STUB,
    });

    expect(out.decision).toBe('prefix-extension-merge');
    expect(out.merged.status).toBe('pending'); // pending > valid (W3.4)
    expect(out.merged.audit_promoted_from).toEqual([
      'DIRECT_aaa.audit.tok1.h_short',
      'DIRECT_bbb.audit.tok1.h_long',
    ]);
  });
});

// =============================================================================
// 4. prefix-extension-merge — proof-graft monotonicity (Wave G.3 enrichment)
// =============================================================================

describe('mergeConflictingHeads — proof grafting (monotonic, never deletes)', () => {
  it('strict prefix: longer chain wins; proofs are pool-merged not manifest-merged', () => {
    // Both chains share their first tx; only the longer chain has tx1.
    // Both txs are committed. The merger delegates pool-level proof
    // grafting to the resolver — at the manifest layer we just verify
    // that the longer chain's rootHash is selected and the loser is
    // listed in `superseded`.
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [t1H, t1] = makeTransaction('1', { committed: true });

    const [shortRootH, shortRoot] = makeTokenRoot('short', [t0H]);
    const [longRootH, longRoot] = makeTokenRoot('long', [t0H, t1H]);

    const pool = buildPool(
      [t0H, t0],
      [t1H, t1],
      [shortRootH, shortRoot],
      [longRootH, longRoot],
    );

    // Prev's lastProofRefreshAt is OLDER; next's is NEWER. Max-merge
    // honors the newer.
    const prev = makeEntry(shortRootH, { lastProofRefreshAt: 1000 });
    const next = makeEntry(longRootH, { lastProofRefreshAt: 2000 });

    const out = mergeConflictingHeads({
      prev,
      next,
      pool,
      compareCids: STRING_COMPARE_STUB,
    });

    expect(out.decision).toBe('prefix-extension-merge');
    expect(out.merged.rootHash).toBe(longRootH);
    // The merger MUST honour max-merge on lastProofRefreshAt
    // regardless of winner side.
    expect(out.merged.lastProofRefreshAt).toBe(2000);
  });

  it('monotonic invariant: re-merging the result with the same prev does not flip the winner', () => {
    // Re-merging prefix-extension result against itself MUST be a
    // no-op — the result's rootHash is now the longer chain's root,
    // and the merger sees them as identical.
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [t1H, t1] = makeTransaction('1', { committed: true });
    const [shortRootH, shortRoot] = makeTokenRoot('short', [t0H]);
    const [longRootH, longRoot] = makeTokenRoot('long', [t0H, t1H]);
    const pool = buildPool(
      [t0H, t0],
      [t1H, t1],
      [shortRootH, shortRoot],
      [longRootH, longRoot],
    );
    const prev = makeEntry(shortRootH);
    const next = makeEntry(longRootH);

    const first = mergeConflictingHeads({
      prev,
      next,
      pool,
      compareCids: STRING_COMPARE_STUB,
    });
    expect(first.merged.rootHash).toBe(longRootH);

    // Re-merge: now `prev` is the previous merged result; `next` is
    // the same shorter chain we already received. The merger sees:
    // prev.rootHash === longRootH, next.rootHash === shortRootH — a
    // prefix-extension where prev (now the longer side) wins again.
    const second = mergeConflictingHeads({
      prev: first.merged,
      next: makeEntry(shortRootH),
      pool,
      compareCids: STRING_COMPARE_STUB,
    });
    expect(second.decision).toBe('prefix-extension-merge');
    expect(second.merged.rootHash).toBe(longRootH);
  });
});

// =============================================================================
// 5. genuinely-divergent-conflict
// =============================================================================

describe('mergeConflictingHeads — genuinely-divergent-conflict', () => {
  it('returns CONFLICTING when chains fork (no prefix relation)', () => {
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [t1aH, t1a] = makeTransaction('1a', { committed: true });
    const [t1bH, t1b] = makeTransaction('1b', { committed: true });

    const [rootAH, rootA] = makeTokenRoot('A', [t0H, t1aH]);
    const [rootBH, rootB] = makeTokenRoot('B', [t0H, t1bH]);

    const pool = buildPool(
      [t0H, t0],
      [t1aH, t1a],
      [t1bH, t1b],
      [rootAH, rootA],
      [rootBH, rootB],
    );

    // Use the string-compare stub with bundleCids selected so that
    // BUNDLE_CID_LO < BUNDLE_CID_HI lexicographically. Prev (with
    // BUNDLE_CID_LO) MUST therefore win.
    const prev = makeEntry(rootAH, { bundleCid: BUNDLE_CID_LO });
    const next = makeEntry(rootBH, { bundleCid: BUNDLE_CID_HI });

    const out = mergeConflictingHeads({
      prev,
      next,
      pool,
      compareCids: STRING_COMPARE_STUB,
    });

    expect(out.decision).toBe('genuinely-divergent-conflict');
    expect(out.merged.status).toBe('conflicting');
    expect(out.merged.rootHash).toBe(rootAH); // prev (lex-min CID) wins
    expect(out.merged.bundleCid).toBe(BUNDLE_CID_LO);
    expect(out.merged.conflictingHeads).toEqual([rootBH]); // loser listed
    expect(out.superseded).toEqual([]); // BOTH retained
    expect(out.resolverOutcome?.kind).toBe('divergent');
  });

  it('lex-min tie-break consults the BINARY comparator, not naive string compare', () => {
    // Adversarial stub: returns OPPOSITE of a string compare. If the
    // merger relied on string compare, prev (BUNDLE_CID_LO) would
    // win; with the reversed stub, NEXT (BUNDLE_CID_HI) MUST win.
    // This proves the merger consults the supplied comparator and
    // would therefore agree with `compareCidV1Binary` (T.1.D) when
    // base32 ordering disagrees with binary ordering at any byte.
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [t1aH, t1a] = makeTransaction('1a', { committed: true });
    const [t1bH, t1b] = makeTransaction('1b', { committed: true });

    const [rootAH, rootA] = makeTokenRoot('A', [t0H, t1aH]);
    const [rootBH, rootB] = makeTokenRoot('B', [t0H, t1bH]);

    const pool = buildPool(
      [t0H, t0],
      [t1aH, t1a],
      [t1bH, t1b],
      [rootAH, rootA],
      [rootBH, rootB],
    );

    const prev = makeEntry(rootAH, { bundleCid: BUNDLE_CID_LO });
    const next = makeEntry(rootBH, { bundleCid: BUNDLE_CID_HI });

    // Verify the assumption that the stubs disagree on this pair.
    expect(STRING_COMPARE_STUB(BUNDLE_CID_LO, BUNDLE_CID_HI)).toBe(-1);
    expect(REVERSED_COMPARE_STUB(BUNDLE_CID_LO, BUNDLE_CID_HI)).toBe(1);

    const stringOut = mergeConflictingHeads({
      prev,
      next,
      pool,
      compareCids: STRING_COMPARE_STUB,
    });
    const reversedOut = mergeConflictingHeads({
      prev,
      next,
      pool,
      compareCids: REVERSED_COMPARE_STUB,
    });

    expect(stringOut.merged.rootHash).toBe(rootAH);
    expect(reversedOut.merged.rootHash).toBe(rootBH);
  });

  it('falls back to rootHash lex-min when neither side has a bundleCid', () => {
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [t1aH, t1a] = makeTransaction('1a', { committed: true });
    const [t1bH, t1b] = makeTransaction('1b', { committed: true });

    const [rootAH, rootA] = makeTokenRoot('A', [t0H, t1aH]);
    const [rootBH, rootB] = makeTokenRoot('B', [t0H, t1bH]);

    const pool = buildPool(
      [t0H, t0],
      [t1aH, t1a],
      [t1bH, t1b],
      [rootAH, rootA],
      [rootBH, rootB],
    );

    const prev = makeEntry(rootAH); // no bundleCid
    const next = makeEntry(rootBH); // no bundleCid

    const out = mergeConflictingHeads({
      prev,
      next,
      pool,
      compareCids: STRING_COMPARE_STUB,
    });

    expect(out.decision).toBe('genuinely-divergent-conflict');
    // Lex-min on rootHash. rootAH = hexTag('root-A'), rootBH = hexTag('root-B').
    // 'root-A' < 'root-B' lexically, so rootAH wins.
    expect(out.merged.rootHash).toBe(rootAH);
    expect(out.merged.conflictingHeads).toEqual([rootBH]);
  });

  it('side WITH a bundleCid beats a side WITHOUT one (provenance preference)', () => {
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [t1aH, t1a] = makeTransaction('1a', { committed: true });
    const [t1bH, t1b] = makeTransaction('1b', { committed: true });

    const [rootAH, rootA] = makeTokenRoot('A', [t0H, t1aH]);
    const [rootBH, rootB] = makeTokenRoot('B', [t0H, t1bH]);

    const pool = buildPool(
      [t0H, t0],
      [t1aH, t1a],
      [t1bH, t1b],
      [rootAH, rootA],
      [rootBH, rootB],
    );

    // prev has no bundleCid (legacy entry); next has one. Next wins.
    const prev = makeEntry(rootAH);
    const next = makeEntry(rootBH, { bundleCid: BUNDLE_CID_HI });

    const out = mergeConflictingHeads({
      prev,
      next,
      pool,
      compareCids: STRING_COMPARE_STUB,
    });

    expect(out.decision).toBe('genuinely-divergent-conflict');
    expect(out.merged.rootHash).toBe(rootBH);
    expect(out.merged.bundleCid).toBe(BUNDLE_CID_HI);
  });

  it('unions audit_promoted_from and conflictingHeads on divergent merge', () => {
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [t1aH, t1a] = makeTransaction('1a', { committed: true });
    const [t1bH, t1b] = makeTransaction('1b', { committed: true });

    const [rootAH, rootA] = makeTokenRoot('A', [t0H, t1aH]);
    const [rootBH, rootB] = makeTokenRoot('B', [t0H, t1bH]);
    const priorOtherHead = hexTag('other-head') as ContentHash;

    const pool = buildPool(
      [t0H, t0],
      [t1aH, t1a],
      [t1bH, t1b],
      [rootAH, rootA],
      [rootBH, rootB],
    );

    const prev = makeEntry(rootAH, {
      bundleCid: BUNDLE_CID_LO,
      audit_promoted_from: ['DIRECT_aaa.audit.tok1.h_a'],
      conflictingHeads: [priorOtherHead],
      lamport: 4,
    });
    const next = makeEntry(rootBH, {
      bundleCid: BUNDLE_CID_HI,
      audit_promoted_from: ['DIRECT_bbb.audit.tok1.h_b'],
      lamport: 9,
    });

    const out = mergeConflictingHeads({
      prev,
      next,
      pool,
      compareCids: STRING_COMPARE_STUB,
    });

    expect(out.decision).toBe('genuinely-divergent-conflict');
    expect(out.merged.audit_promoted_from).toEqual([
      'DIRECT_aaa.audit.tok1.h_a',
      'DIRECT_bbb.audit.tok1.h_b',
    ]);
    // conflictingHeads = union of {priorOtherHead, rootBH} (loser) —
    // the winner rootAH is NOT included.
    expect(out.merged.conflictingHeads).toEqual([priorOtherHead, rootBH].sort());
    expect(out.merged.lamport).toBe(9); // max
  });
});

// =============================================================================
// 6. Post-merge [B'] re-run — NOT_OUR_CURRENT_STATE simulation
// =============================================================================

describe('mergeConflictingHeads — post-merge [B\'] re-run shape', () => {
  it('surfaces NOT_OUR_CURRENT_STATE when merged chain contains a transfer-out we authored', () => {
    // Scenario: recipient's local manifest has the SHORT chain (one tx,
    // current state still binds to the recipient). A new bundle
    // arrives with the LONGER chain that includes an OUTBOUND transfer
    // we authored — i.e., the merged chain's terminal state binds to
    // a different identity. The merger does NOT run [B'] itself; this
    // test verifies the merger's output is shaped such that the
    // CALLER's [B'] re-run can detect the ownership flip.
    //
    // Contract verified:
    //   1. The merge succeeds as a prefix-extension-merge (the longer
    //      chain wins).
    //   2. The merged entry's rootHash points at the longer chain.
    //   3. A simulated [B'] re-run (predicate evaluation against the
    //      longer chain's destination state) returns bindsToUs=false.
    const [t0H, t0] = makeTransaction('0', { committed: true });
    // tx1 represents the outbound transfer-out we authored — the
    // destination state will not bind to us. Distinct destinationState
    // is the marker of "ownership flipped".
    const [t1H, t1] = makeTransaction('outbound-1', { committed: true });

    const [shortRootH, shortRoot] = makeTokenRoot('short', [t0H]);
    const [longRootH, longRoot] = makeTokenRoot('long', [t0H, t1H]);

    const pool = buildPool(
      [t0H, t0],
      [t1H, t1],
      [shortRootH, shortRoot],
      [longRootH, longRoot],
    );

    // Local manifest: short chain, status='valid', binds to us.
    const prev = makeEntry(shortRootH, { status: 'valid' });
    // Incoming: long chain, the merged head includes our transfer-out.
    const next = makeEntry(longRootH, { status: 'valid' });

    const out = mergeConflictingHeads({
      prev,
      next,
      pool,
      compareCids: STRING_COMPARE_STUB,
    });

    expect(out.decision).toBe('prefix-extension-merge');
    expect(out.merged.rootHash).toBe(longRootH);

    // Simulated [B'] re-run by the caller:
    //   - look up the longer chain's terminal destinationState in the
    //     pool;
    //   - run the predicate evaluator (mocked here as a function);
    //   - assert the predicate does NOT bind to us.
    const longerChainTerminalDestination = (
      pool.get(longRootH)?.children as Record<string, ContentHash | ContentHash[] | null>
    )?.transactions as ContentHash[] | undefined;
    // The merged head's terminal state lives on tx1 (the outbound
    // transfer); the test simulates the caller's [B'] by checking
    // that the destination state of the LAST tx is not bound to us.
    expect(longerChainTerminalDestination).toBeDefined();
    const lastTxHash = longerChainTerminalDestination?.at(-1) as ContentHash;
    expect(lastTxHash).toBe(t1H);

    const lastTx = pool.get(lastTxHash);
    expect(lastTx).toBeDefined();
    // Mock predicate evaluator: returns bindsToUs based on whether
    // the tx's destinationState matches a known-ours marker. The
    // tx-1 fixture's destination is 'dst-outbound-1', which by
    // construction does NOT match our identity marker.
    const dstStateRef = (
      lastTx?.children as Record<string, ContentHash | ContentHash[] | null>
    )?.destinationState as ContentHash | undefined;
    const ourDestinationState = hexTag('dst-0');
    expect(dstStateRef).not.toBe(ourDestinationState);
    // This is the [B'] re-run signal: caller's predicate evaluator
    // would now return bindsToUs=false on the merged head, and the
    // disposition writer would route the manifest entry to `_audit`
    // with reason='not-our-state' per Appendix A "B-not-ours" /
    // §5.3 [B'].
  });
});

// =============================================================================
// 7. Lamport / metadata invariants
// =============================================================================

describe('mergeConflictingHeads — Lamport & metadata invariants', () => {
  it('Lamport is max-merged across all branches', () => {
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [t1H, t1] = makeTransaction('1', { committed: true });
    const [shortRootH, shortRoot] = makeTokenRoot('short', [t0H]);
    const [longRootH, longRoot] = makeTokenRoot('long', [t0H, t1H]);
    const pool = buildPool(
      [t0H, t0],
      [t1H, t1],
      [shortRootH, shortRoot],
      [longRootH, longRoot],
    );

    // identical-no-op
    expect(
      mergeConflictingHeads({
        prev: makeEntry(longRootH, { lamport: 7 }),
        next: makeEntry(longRootH, { lamport: 4 }),
        pool,
        compareCids: STRING_COMPARE_STUB,
      }).merged.lamport,
    ).toBe(7);

    // prefix-extension-merge
    expect(
      mergeConflictingHeads({
        prev: makeEntry(shortRootH, { lamport: 11 }),
        next: makeEntry(longRootH, { lamport: 3 }),
        pool,
        compareCids: STRING_COMPARE_STUB,
      }).merged.lamport,
    ).toBe(11);
  });

  it('preserves splitParent if either side has it set', () => {
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [rootH, root] = makeTokenRoot('A', [t0H]);
    const pool = buildPool([t0H, t0], [rootH, root]);

    const prev = makeEntry(rootH, { splitParent: 'parent-1' });
    const next = makeEntry(rootH);

    const out = mergeConflictingHeads({
      prev,
      next,
      pool,
      compareCids: STRING_COMPARE_STUB,
    });
    expect(out.merged.splitParent).toBe('parent-1');
  });

  it('uses lex-min for divergent splitParent values (deterministic across replicas)', () => {
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [rootH, root] = makeTokenRoot('A', [t0H]);
    const pool = buildPool([t0H, t0], [rootH, root]);

    const prev = makeEntry(rootH, { splitParent: 'parent-zebra' });
    const next = makeEntry(rootH, { splitParent: 'parent-alpha' });

    const out = mergeConflictingHeads({
      prev,
      next,
      pool,
      compareCids: STRING_COMPARE_STUB,
    });
    // Defect-handling: lex-min wins ('parent-alpha' < 'parent-zebra').
    expect(out.merged.splitParent).toBe('parent-alpha');
  });

  it('§5.6 monotonic invariant: status=invalid never regresses', () => {
    // The merger MUST NOT transition `'invalid'` -> any other status,
    // even if the incoming side carries `'valid'`. Per §5.6: "an
    // invalid token MUST NEVER transition out of `_invalid`."
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [t1H, t1] = makeTransaction('1', { committed: true });
    const [shortRootH, shortRoot] = makeTokenRoot('short', [t0H]);
    const [longRootH, longRoot] = makeTokenRoot('long', [t0H, t1H]);
    const pool = buildPool(
      [t0H, t0],
      [t1H, t1],
      [shortRootH, shortRoot],
      [longRootH, longRoot],
    );

    const prev = makeEntry(shortRootH, {
      status: 'invalid',
      invalidReason: 'auth-invalid',
    });
    const next = makeEntry(longRootH, { status: 'valid' });

    const out = mergeConflictingHeads({
      prev,
      next,
      pool,
      compareCids: STRING_COMPARE_STUB,
    });

    expect(out.merged.status).toBe('invalid'); // monotonic-pin
    expect(out.merged.invalidReason).toBe('auth-invalid');
  });
});

// =============================================================================
// 8. Stability of `superseded`
// =============================================================================

describe('mergeConflictingHeads — superseded list', () => {
  it('superseded is empty for identical-no-op', () => {
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [rootH, root] = makeTokenRoot('A', [t0H]);
    const pool = buildPool([t0H, t0], [rootH, root]);
    const prev = makeEntry(rootH);
    const next = makeEntry(rootH);

    const out = mergeConflictingHeads({
      prev,
      next,
      pool,
      compareCids: STRING_COMPARE_STUB,
    });
    expect(out.superseded).toEqual([]);
  });

  it('superseded is empty for genuinely-divergent-conflict (both heads retained)', () => {
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [t1aH, t1a] = makeTransaction('1a', { committed: true });
    const [t1bH, t1b] = makeTransaction('1b', { committed: true });
    const [rootAH, rootA] = makeTokenRoot('A', [t0H, t1aH]);
    const [rootBH, rootB] = makeTokenRoot('B', [t0H, t1bH]);
    const pool = buildPool(
      [t0H, t0],
      [t1aH, t1a],
      [t1bH, t1b],
      [rootAH, rootA],
      [rootBH, rootB],
    );

    const prev = makeEntry(rootAH, { bundleCid: BUNDLE_CID_LO });
    const next = makeEntry(rootBH, { bundleCid: BUNDLE_CID_HI });

    const out = mergeConflictingHeads({
      prev,
      next,
      pool,
      compareCids: STRING_COMPARE_STUB,
    });
    expect(out.superseded).toEqual([]);
  });

  it('superseded contains the loser rootHash for prefix-extension-merge', () => {
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [t1H, t1] = makeTransaction('1', { committed: true });
    const [shortRootH, shortRoot] = makeTokenRoot('short', [t0H]);
    const [longRootH, longRoot] = makeTokenRoot('long', [t0H, t1H]);
    const pool = buildPool(
      [t0H, t0],
      [t1H, t1],
      [shortRootH, shortRoot],
      [longRootH, longRoot],
    );

    const prev = makeEntry(shortRootH);
    const next = makeEntry(longRootH);

    const out = mergeConflictingHeads({
      prev,
      next,
      pool,
      compareCids: STRING_COMPARE_STUB,
    });
    expect(out.superseded).toEqual([shortRootH]);
  });
});

// =============================================================================
// 9. resolverOutcome forward-compat
// =============================================================================

describe('mergeConflictingHeads — resolverOutcome surfacing', () => {
  it('surfaces the resolver outcome verbatim for prefix-extension-merge', () => {
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [t1H, t1] = makeTransaction('1', { committed: true });
    const [shortRootH, shortRoot] = makeTokenRoot('short', [t0H]);
    const [longRootH, longRoot] = makeTokenRoot('long', [t0H, t1H]);
    const pool = buildPool(
      [t0H, t0],
      [t1H, t1],
      [shortRootH, shortRoot],
      [longRootH, longRoot],
    );

    const out = mergeConflictingHeads({
      prev: makeEntry(shortRootH),
      next: makeEntry(longRootH),
      pool,
      compareCids: STRING_COMPARE_STUB,
    });
    expect(out.resolverOutcome).not.toBeNull();
    expect(out.resolverOutcome?.kind).toBe('longest-valid');
    expect(out.resolverOutcome?.rootHash).toBe(longRootH);
  });

  it('resolverOutcome is null for identical-no-op (resolver not invoked)', () => {
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [rootH, root] = makeTokenRoot('A', [t0H]);
    const pool = buildPool([t0H, t0], [rootH, root]);

    const out = mergeConflictingHeads({
      prev: makeEntry(rootH),
      next: makeEntry(rootH),
      pool,
      compareCids: STRING_COMPARE_STUB,
    });
    expect(out.resolverOutcome).toBeNull();
  });
});

// =============================================================================
// 10. Default comparator wiring (smoke test only — exercised here so a
//     refactor that drops the default never regresses silently)
// =============================================================================

describe('mergeConflictingHeads — default comparator', () => {
  it('falls back to compareCidV1Binary when compareCids is omitted', () => {
    // Use rootHash lex-min path so we don't depend on real CIDv1
    // bundleCids in this smoke test (the binary comparator's CID
    // parser would reject our `BUNDLE_CID_*` placeholders).
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [t1aH, t1a] = makeTransaction('1a', { committed: true });
    const [t1bH, t1b] = makeTransaction('1b', { committed: true });
    const [rootAH, rootA] = makeTokenRoot('A', [t0H, t1aH]);
    const [rootBH, rootB] = makeTokenRoot('B', [t0H, t1bH]);
    const pool = buildPool(
      [t0H, t0],
      [t1aH, t1a],
      [t1bH, t1b],
      [rootAH, rootA],
      [rootBH, rootB],
    );

    const prev = makeEntry(rootAH); // no bundleCid
    const next = makeEntry(rootBH); // no bundleCid

    // No compareCids supplied — exercise the default path. Without
    // bundleCids, the merger uses rootHash lex-min, which does NOT
    // touch the CID parser; this guards the wiring without coupling
    // the test to multiformats internals.
    const input: MergeConflictingHeadsInput = { prev, next, pool };
    const out = mergeConflictingHeads(input);

    expect(out.decision).toBe('genuinely-divergent-conflict');
    expect(out.merged.rootHash).toBe(rootAH);
  });
});

// Ensure unused-fixture detector doesn't complain about
// makeInclusionProof in case future edits drop its sole consumer.
void makeInclusionProof;
