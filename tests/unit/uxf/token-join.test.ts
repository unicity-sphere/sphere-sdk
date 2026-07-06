/**
 * Unit tests for the per-token JOIN resolver (uxf/token-join.ts).
 *
 * The resolver is pure: no mutation, no I/O. These tests build
 * minimal-but-structurally-correct token-root + transaction elements
 * in an in-memory pool, then assert the resolver's decision for each
 * of the classical §10.4 Rule 3 scenarios enumerated in
 * PROFILE-AGGREGATOR-POINTER-D0-JOIN-AUDIT.md.
 */

import { describe, it, expect } from 'vitest';

import type { ContentHash, UxfElement } from '../../../extensions/uxf/bundle/types';
import { resolveTokenRoot } from '../../../extensions/uxf/bundle/token-join';

// ---------------------------------------------------------------------------
// Element factories — minimal enough to satisfy the resolver's reads.
// ---------------------------------------------------------------------------

/**
 * Content-hash-shaped identifiers. computeElementHash canonicalizes
 * children by hexToBytes(hash), so any ContentHash value that
 * reaches the element-hashing path must be 64-char lowercase hex.
 * Short fixtures would throw `UXF:INVALID_HASH` inside the Rule 4
 * synthesis path. We derive unique hex from a SHA-256 of the tag
 * so fixtures stay readable at the call site.
 */
function hexTag(tag: string): ContentHash {
  // Deterministic cheap hash: build a hex string by expanding each
  // char's code-point to 4 hex digits, then truncate/pad to 64.
  // Tags are short (≤16 chars) and this produces valid hex.
  let out = '';
  for (const ch of tag) {
    out += ch.charCodeAt(0).toString(16).padStart(4, '0');
  }
  if (out.length >= 64) return out.slice(0, 64) as ContentHash;
  return (out + '0'.repeat(64 - out.length)) as ContentHash;
}

function makeTransaction(id: string, opts: { committed: boolean }): [ContentHash, UxfElement] {
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
    // tokenId is a BYTE_FIELD for 'token-root' (see uxf/hash.ts:56)
    // — must be valid hex. version is semantic-string, left free.
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveTokenRoot', () => {
  it('returns `single` for a single candidate', () => {
    const [txH, tx] = makeTransaction('0', { committed: true });
    const [rootH, root] = makeTokenRoot('A', [txH]);
    const pool = buildPool([txH, tx], [rootH, root]);

    const outcome = resolveTokenRoot({
      tokenId: 'T',
      candidates: [rootH],
      pool,
    });
    expect(outcome.kind).toBe('single');
    expect(outcome.rootHash).toBe(rootH);
  });

  it('returns `longest-valid` when one chain is a strict prefix of the other', () => {
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [t1H, t1] = makeTransaction('1', { committed: true });
    const [t2H, t2] = makeTransaction('2', { committed: true });

    const [shortRootH, shortRoot] = makeTokenRoot('short', [t0H, t1H]);
    const [longRootH, longRoot] = makeTokenRoot('long', [t0H, t1H, t2H]);

    const pool = buildPool(
      [t0H, t0],
      [t1H, t1],
      [t2H, t2],
      [shortRootH, shortRoot],
      [longRootH, longRoot],
    );

    const outcome = resolveTokenRoot({
      tokenId: 'T',
      candidates: [shortRootH, longRootH],
      pool,
    });
    expect(outcome.kind).toBe('longest-valid');
    expect(outcome.rootHash).toBe(longRootH);
    if (outcome.kind === 'longest-valid') {
      expect(outcome.losers).toEqual([shortRootH]);
    }
  });

  it('is order-independent (swap candidates → same result)', () => {
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

    const outcomeA = resolveTokenRoot({
      tokenId: 'T',
      candidates: [shortRootH, longRootH],
      pool,
    });
    const outcomeB = resolveTokenRoot({
      tokenId: 'T',
      candidates: [longRootH, shortRootH],
      pool,
    });
    expect(outcomeA).toEqual(outcomeB);
  });

  it('returns `divergent` when chains fork (no prefix relation)', () => {
    // Two chains of length 2 whose second tx differs — different
    // forks of the same tokenId. Deterministic winner: higher
    // committed-tx count, else lexicographic rootHash.
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [t1aH, t1a] = makeTransaction('1a', { committed: true });
    const [t1bH, t1b] = makeTransaction('1b', { committed: false });

    const [rootAH, rootA] = makeTokenRoot('A', [t0H, t1aH]);
    const [rootBH, rootB] = makeTokenRoot('B', [t0H, t1bH]);

    const pool = buildPool(
      [t0H, t0],
      [t1aH, t1a],
      [t1bH, t1b],
      [rootAH, rootA],
      [rootBH, rootB],
    );

    const outcome = resolveTokenRoot({
      tokenId: 'T',
      candidates: [rootAH, rootBH],
      pool,
    });
    expect(outcome.kind).toBe('divergent');
    // rootA has 2 committed txs; rootB has 1. rootA should win.
    expect(outcome.rootHash).toBe(rootAH);
  });

  it('picks longest-valid when one chain is a prefix of the other with extra uncommitted txs', () => {
    // Prefix-relation semantics under content-addressed transactions:
    // shared tx hashes are bit-identical → identical committedness
    // on the common prefix. So the longer chain always has
    // ≥ committed-count of the shorter. The old `truncated` outcome
    // (which would have enriched the longer chain with the
    // shorter's "better" proof coverage) is unreachable under these
    // semantics and has been removed. Rule 4 (synthetic proof-
    // enriched root) is a separate future work item that will
    // re-introduce a distinct variant for that case.
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [t1H, t1] = makeTransaction('1', { committed: true });
    const [t2H, t2] = makeTransaction('2', { committed: false });

    const [shortRootH, shortRoot] = makeTokenRoot('short', [t0H, t1H]);
    const [longRootH, longRoot] = makeTokenRoot('long', [t0H, t1H, t2H]);

    const pool = buildPool(
      [t0H, t0],
      [t1H, t1],
      [t2H, t2],
      [shortRootH, shortRoot],
      [longRootH, longRoot],
    );

    const outcome = resolveTokenRoot({
      tokenId: 'T',
      candidates: [shortRootH, longRootH],
      pool,
    });
    // Prefix-relation: committed counts tie at 2, longer chain wins.
    expect(outcome.kind).toBe('longest-valid');
    expect(outcome.rootHash).toBe(longRootH);
  });

  it('treats missing token-root elements as malformed and skips them', () => {
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [realRootH, realRoot] = makeTokenRoot('real', [t0H]);
    const phantomRootH = 'root-phantom' as ContentHash;

    const pool = buildPool([t0H, t0], [realRootH, realRoot]);

    const outcome = resolveTokenRoot({
      tokenId: 'T',
      candidates: [realRootH, phantomRootH],
      pool,
    });
    // Only one well-formed candidate — treat as single.
    expect(outcome.kind).toBe('single');
    expect(outcome.rootHash).toBe(realRootH);
  });

  it('ties break deterministically by rootHash', () => {
    // Two roots with identical tx arrays (same committed count) and
    // same length → ranking falls through to lexicographic rootHash.
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [, realRoot] = makeTokenRoot('zzz', [t0H]);
    const [, realRoot2] = makeTokenRoot('aaa', [t0H]);
    const rootZ = 'root-zzz' as ContentHash;
    const rootA = 'root-aaa' as ContentHash;

    const pool = buildPool([t0H, t0], [rootZ, realRoot], [rootA, realRoot2]);

    const outcome = resolveTokenRoot({
      tokenId: 'T',
      candidates: [rootZ, rootA],
      pool,
    });
    // Same-length compatible chains with identical tx arrays are
    // treated as non-divergent; tiebreak picks `root-aaa`
    // (lexicographic).
    expect(outcome.rootHash).toBe(rootA);
  });

  it('throws on empty candidates list (invariant violation)', () => {
    expect(() =>
      resolveTokenRoot({
        tokenId: 'T',
        candidates: [],
        pool: new Map(),
      }),
    ).toThrow('empty candidates');
  });

  it('Rule 4 — enriches the longer chain when a same-position tx has a proof in a shorter chain (Wave G.3 oracle gate)', () => {
    // Position 0: t0 committed in both chains (identical hash).
    // Position 1: long has unproved version (t1_unproved), short
    //   has proved version (t1_proved). Under content-addressed
    //   encoding these produce different ContentHashes but same
    //   sourceState/data/destinationState children — the resolver
    //   should detect this and adopt the proved element.
    // Position 2: only in the longer chain (uncommitted tail).
    //
    // Expected outcome: `enriched` with a synthetic root whose
    // transactions array is [t0, t1_proved, t2_unproved]. The
    // synthetic root's ContentHash differs from both candidates.

    const t0 = makeTransaction('0', { committed: true });
    // ContentHashes must be 64-char lowercase hex — computeElementHash
    // calls hexToBytes() on every child ref during canonicalization.
    const HEX_STATE_A = 'a'.repeat(64);
    const HEX_STATE_B = 'b'.repeat(64);
    const HEX_DATA_1 = 'c'.repeat(64);
    const HEX_PROOF_1 = 'd'.repeat(64);
    const t1UnprovedChildren = {
      sourceState: HEX_STATE_A,
      data: HEX_DATA_1,
      inclusionProof: null,
      destinationState: HEX_STATE_B,
    };
    const t1ProvedChildren = {
      sourceState: HEX_STATE_A,
      data: HEX_DATA_1,
      inclusionProof: HEX_PROOF_1,
      destinationState: HEX_STATE_B,
    };
    const t1Unproved: PoolEntry = [
      hexTag('tx1u'),
      {
        header: {
      representation: 1,
      semantics: 1,
      kind: 'default' as const,
      predecessor: null,
    },
        type: 'transaction',
        content: {},
        children: t1UnprovedChildren,
      },
    ];
    const t1Proved: PoolEntry = [
      hexTag('tx1p'),
      {
        header: {
      representation: 1,
      semantics: 1,
      kind: 'default' as const,
      predecessor: null,
    },
        type: 'transaction',
        content: {},
        children: t1ProvedChildren,
      },
    ];
    const t2 = makeTransaction('2', { committed: false });

    const [shortRootH, shortRoot] = makeTokenRoot('short', [t0[0], t1Proved[0]]);
    const [longRootH, longRoot] = makeTokenRoot('long', [t0[0], t1Unproved[0], t2[0]]);

    const pool = buildPool(
      t0,
      t1Unproved,
      t1Proved,
      t2,
      [shortRootH, shortRoot],
      [longRootH, longRoot],
    );

    const outcome = resolveTokenRoot({
      tokenId: 'T',
      candidates: [shortRootH, longRootH],
      pool,
      // Wave G.3: caller has cryptographically verified the proof
      // element at HEX_PROOF_1. The resolver lifts t1_proved into
      // the synthetic root because its inclusion-proof child is in
      // the verified set. Without this set, the call falls through
      // to longest-valid (covered by the next test).
      verifiedProofs: new Set([HEX_PROOF_1]),
    });

    expect(outcome.kind).toBe('enriched');
    if (outcome.kind !== 'enriched') return;

    // Synthetic root is a NEW element with a different hash.
    expect(outcome.rootHash).not.toBe(shortRootH);
    expect(outcome.rootHash).not.toBe(longRootH);

    // Both original roots are losers (the longer chain is
    // superseded by the synthetic).
    expect(outcome.losers).toContain(shortRootH);
    expect(outcome.losers).toContain(longRootH);

    // Synthetic root has the enriched tx list: [t0, t1_proved, t2].
    const syntheticTxns = outcome.syntheticRoot.children.transactions;
    expect(syntheticTxns).toEqual([t0[0], t1Proved[0], t2[0]]);
    expect(outcome.syntheticRoot.type).toBe('token-root');
  });

  it('Rule 4 — falls back to divergent when verifiedProofs is omitted (steelman¹⁸ default-deny)', () => {
    // Same fixture as the enriched test, but no verifiedProofs in
    // the input. Must resolve as `divergent` — the conservative
    // pre-G.3 behavior, because the resolver cannot tell whether the
    // alt's inclusion-proof element is genuine or fabricated, so any
    // pairwise hash mismatch (even on a sameCore-different-proof
    // pair) is treated as a fork. Without the oracle gate, an
    // attacker-supplied structurally-valid-but-fake proof would
    // otherwise force `longest-valid` and bypass operator alerting.
    const t0 = makeTransaction('0', { committed: true });
    const HEX_STATE_A = 'a'.repeat(64);
    const HEX_STATE_B = 'b'.repeat(64);
    const HEX_DATA_1 = 'c'.repeat(64);
    const HEX_PROOF_1 = 'd'.repeat(64);
    const t1Unproved: PoolEntry = [
      hexTag('tx1u'),
      {
        header: { representation: 1, semantics: 1, kind: 'default' as const, predecessor: null },
        type: 'transaction',
        content: {},
        children: { sourceState: HEX_STATE_A, data: HEX_DATA_1, inclusionProof: null, destinationState: HEX_STATE_B },
      },
    ];
    const t1Proved: PoolEntry = [
      hexTag('tx1p'),
      {
        header: { representation: 1, semantics: 1, kind: 'default' as const, predecessor: null },
        type: 'transaction',
        content: {},
        children: { sourceState: HEX_STATE_A, data: HEX_DATA_1, inclusionProof: HEX_PROOF_1, destinationState: HEX_STATE_B },
      },
    ];
    const t2 = makeTransaction('2', { committed: false });
    const [shortRootH, shortRoot] = makeTokenRoot('short', [t0[0], t1Proved[0]]);
    const [longRootH, longRoot] = makeTokenRoot('long', [t0[0], t1Unproved[0], t2[0]]);
    const pool = buildPool(
      t0,
      t1Unproved,
      t1Proved,
      t2,
      [shortRootH, shortRoot],
      [longRootH, longRoot],
    );
    const outcome = resolveTokenRoot({
      tokenId: 'T',
      candidates: [shortRootH, longRootH],
      pool,
      // verifiedProofs omitted — empty set is the default
    });
    expect(outcome.kind).toBe('divergent');
  });

  it('Rule 4 — does NOT enrich when verifiedProofs lacks the alt proof (forged-proof rejection)', () => {
    // The proof is supplied in the pool but the caller's set DOES
    // NOT include it — simulating the case where oracle.verify
    // Inclusion Proof returned false for HEX_PROOF_1 (e.g., bad
    // signature). The resolver MUST NOT lift the unverified proof.
    const t0 = makeTransaction('0', { committed: true });
    const HEX_STATE_A = 'a'.repeat(64);
    const HEX_STATE_B = 'b'.repeat(64);
    const HEX_DATA_1 = 'c'.repeat(64);
    const HEX_PROOF_1 = 'd'.repeat(64);
    const t1Unproved: PoolEntry = [
      hexTag('tx1u'),
      {
        header: { representation: 1, semantics: 1, kind: 'default' as const, predecessor: null },
        type: 'transaction',
        content: {},
        children: { sourceState: HEX_STATE_A, data: HEX_DATA_1, inclusionProof: null, destinationState: HEX_STATE_B },
      },
    ];
    const t1Proved: PoolEntry = [
      hexTag('tx1p'),
      {
        header: { representation: 1, semantics: 1, kind: 'default' as const, predecessor: null },
        type: 'transaction',
        content: {},
        children: { sourceState: HEX_STATE_A, data: HEX_DATA_1, inclusionProof: HEX_PROOF_1, destinationState: HEX_STATE_B },
      },
    ];
    const t2 = makeTransaction('2', { committed: false });
    const [shortRootH, shortRoot] = makeTokenRoot('short', [t0[0], t1Proved[0]]);
    const [longRootH, longRoot] = makeTokenRoot('long', [t0[0], t1Unproved[0], t2[0]]);
    const pool = buildPool(
      t0,
      t1Unproved,
      t1Proved,
      t2,
      [shortRootH, shortRoot],
      [longRootH, longRoot],
    );
    const UNRELATED_PROOF = 'e'.repeat(64);
    const outcome = resolveTokenRoot({
      tokenId: 'T',
      candidates: [shortRootH, longRootH],
      pool,
      verifiedProofs: new Set([UNRELATED_PROOF]), // doesn't cover HEX_PROOF_1
    });
    // verifiedProofs.size > 0 enables the sameCore exemption check,
    // but neither side's proof is in the set, so isProofVerifiedOn
    // EitherSide returns false → still divergent. This is the
    // forged-proof rejection: the resolver REFUSES to lift an
    // unverified alt even when the merge would otherwise enrich.
    expect(outcome.kind).toBe('divergent');
  });

  it('Rule 4 — does NOT enrich when the shorter chain has no better-proofed tx', () => {
    // Both chains have uncommitted t1 (same hash). Common prefix is
    // identical. Tail differs. Resolver picks longest-valid, no
    // enrichment.
    const t0 = makeTransaction('0', { committed: true });
    const t1 = makeTransaction('1', { committed: false });
    const t2 = makeTransaction('2', { committed: false });

    const [shortRootH, shortRoot] = makeTokenRoot('short', [t0[0], t1[0]]);
    const [longRootH, longRoot] = makeTokenRoot('long', [t0[0], t1[0], t2[0]]);

    const pool = buildPool(t0, t1, t2, [shortRootH, shortRoot], [longRootH, longRoot]);

    const outcome = resolveTokenRoot({
      tokenId: 'T',
      candidates: [shortRootH, longRootH],
      pool,
    });
    expect(outcome.kind).toBe('longest-valid');
    expect(outcome.rootHash).toBe(longRootH);
  });

  it('Rule 4 — schema-evolution guard: extra child field present on one side alone blocks enrichment', () => {
    // Steelman C1: if a future TransactionChildren schema adds a
    // new non-inclusionProof field (say `receipt`), two tx elements
    // that differ ONLY in that new field must NOT be considered
    // same-core-different-proof. The exhaustive key-set check
    // rejects them so the resolver cannot enrich across a genuine
    // state divergence it cannot reason about.
    const t0 = makeTransaction('0', { committed: true });
    const HEX_STATE_A = 'a'.repeat(64);
    const HEX_STATE_B = 'b'.repeat(64);
    const HEX_DATA = 'c'.repeat(64);
    const HEX_PROOF = 'd'.repeat(64);
    const HEX_RECEIPT = 'e'.repeat(64);

    const t1WithReceipt: PoolEntry = [
      hexTag('tx1+receipt'),
      {
        header: {
          representation: 1,
          semantics: 1,
          kind: 'default' as const,
          predecessor: null,
        },
        type: 'transaction',
        content: {},
        children: {
          sourceState: HEX_STATE_A,
          data: HEX_DATA,
          inclusionProof: HEX_PROOF,
          destinationState: HEX_STATE_B,
          // Hypothetical future-schema field — not in today's
          // TransactionChildren but the resolver must defend
          // against the scenario.
          receipt: HEX_RECEIPT,
        } as unknown as Record<string, ContentHash | ContentHash[] | null>,
      },
    ];
    const t1NoReceipt: PoolEntry = [
      hexTag('tx1-noreceipt'),
      {
        header: {
          representation: 1,
          semantics: 1,
          kind: 'default' as const,
          predecessor: null,
        },
        type: 'transaction',
        content: {},
        children: {
          sourceState: HEX_STATE_A,
          data: HEX_DATA,
          inclusionProof: null,
          destinationState: HEX_STATE_B,
        },
      },
    ];

    const [shortRootH, shortRoot] = makeTokenRoot('short', [t0[0], t1WithReceipt[0]]);
    const [longRootH, longRoot] = makeTokenRoot('long', [t0[0], t1NoReceipt[0]]);

    const pool = buildPool(
      t0,
      t1WithReceipt,
      t1NoReceipt,
      [shortRootH, shortRoot],
      [longRootH, longRoot],
    );

    const outcome = resolveTokenRoot({
      tokenId: 'T',
      candidates: [shortRootH, longRootH],
      pool,
    });
    // Key sets differ (receipt only in one). Compatibility check
    // returns false → divergent path. Resolver must NOT produce
    // 'enriched' here.
    expect(outcome.kind).toBe('divergent');
  });

  it('Rule 4 — does NOT enrich when the proved-alt has DIFFERENT core fields (not same-core-different-proof)', () => {
    // Position 1 differs in sourceState — this is a real divergence,
    // not a proof mismatch. Resolver should classify as divergent or
    // fall through to longest-valid.
    const t0 = makeTransaction('0', { committed: true });

    const t1A: PoolEntry = [
      hexTag('tx1a'),
      {
        header: {
      representation: 1,
      semantics: 1,
      kind: 'default' as const,
      predecessor: null,
    },
        type: 'transaction',
        content: {},
        children: {
          sourceState: 'state-0-dst',
          data: 'tx-data-1',
          inclusionProof: null,
          destinationState: 'state-1-dst-A',
        },
      },
    ];
    const t1B: PoolEntry = [
      hexTag('tx1b'),
      {
        header: {
      representation: 1,
      semantics: 1,
      kind: 'default' as const,
      predecessor: null,
    },
        type: 'transaction',
        content: {},
        children: {
          sourceState: 'state-0-dst',
          data: 'tx-data-1',
          inclusionProof: 'proof-1',
          // DIFFERENT destinationState — this is a divergent transition, not
          // a proof lift. Even though t1B has a proof, Rule 4 must decline.
          destinationState: 'state-1-dst-B',
        },
      },
    ];
    const t2 = makeTransaction('2', { committed: false });

    const [shortRootH, shortRoot] = makeTokenRoot('short', [t0[0], t1B[0]]);
    const [longRootH, longRoot] = makeTokenRoot('long', [t0[0], t1A[0], t2[0]]);

    const pool = buildPool(t0, t1A, t1B, t2, [shortRootH, shortRoot], [longRootH, longRoot]);

    const outcome = resolveTokenRoot({
      tokenId: 'T',
      candidates: [shortRootH, longRootH],
      pool,
    });
    // The chains have different tx hashes at position 1 and the
    // txns arrays no longer satisfy the prefix relation — this is
    // a divergent pair.
    expect(outcome.kind).toBe('divergent');
  });

  it('Rule 4 — synthetic root carries ENRICHED_SYNTHETIC_KIND and null predecessor (steelman C1, Wave G.3)', async () => {
    // Steelman round 2 C1: synthetic with predecessor=winner.rootHash
    // caused rebuildInstanceChainIndex (public export) to record
    // phantom instance-chain links between natural roots and
    // synthetic merge-artifacts. Fix: set predecessor=null and
    // tag kind='enriched-synthetic' so downstream consumers can
    // distinguish and filter.
    const { ENRICHED_SYNTHETIC_KIND, isEnrichedSyntheticRoot } = await import(
      '../../../extensions/uxf/bundle/token-join'
    );

    const t0 = makeTransaction('0', { committed: true });
    const HEX_STATE_A = 'a'.repeat(64);
    const HEX_STATE_B = 'b'.repeat(64);
    const HEX_DATA = 'c'.repeat(64);
    const HEX_PROOF = 'd'.repeat(64);
    const t1Unproved: PoolEntry = [
      hexTag('tx1-unproved'),
      {
        header: {
          representation: 1,
          semantics: 1,
          kind: 'default' as const,
          predecessor: null,
        },
        type: 'transaction',
        content: {},
        children: {
          sourceState: HEX_STATE_A,
          data: HEX_DATA,
          inclusionProof: null,
          destinationState: HEX_STATE_B,
        },
      },
    ];
    const t1Proved: PoolEntry = [
      hexTag('tx1-proved'),
      {
        header: {
          representation: 1,
          semantics: 1,
          kind: 'default' as const,
          predecessor: null,
        },
        type: 'transaction',
        content: {},
        children: {
          sourceState: HEX_STATE_A,
          data: HEX_DATA,
          inclusionProof: HEX_PROOF,
          destinationState: HEX_STATE_B,
        },
      },
    ];
    const t2 = makeTransaction('2', { committed: false });

    const [shortRootH, shortRoot] = makeTokenRoot('short', [t0[0], t1Proved[0]]);
    const [longRootH, longRoot] = makeTokenRoot('long', [t0[0], t1Unproved[0], t2[0]]);
    const pool = buildPool(
      t0,
      t1Unproved,
      t1Proved,
      t2,
      [shortRootH, shortRoot],
      [longRootH, longRoot],
    );

    const outcome = resolveTokenRoot({
      tokenId: 'T',
      candidates: [shortRootH, longRootH],
      pool,
      verifiedProofs: new Set([HEX_PROOF]),
    });
    expect(outcome.kind).toBe('enriched');
    if (outcome.kind !== 'enriched') return;

    // predecessor null → not indexed as a successor by
    // rebuildInstanceChainIndex.
    expect(outcome.syntheticRoot.header.predecessor).toBeNull();

    // Distinct kind tag → downstream consumers can filter.
    expect(outcome.syntheticRoot.header.kind).toBe(ENRICHED_SYNTHETIC_KIND);
    expect(isEnrichedSyntheticRoot(outcome.syntheticRoot)).toBe(true);

    // The original natural roots should NOT report as synthetic.
    const winnerEl = pool.get(longRootH);
    expect(winnerEl && isEnrichedSyntheticRoot(winnerEl)).toBe(false);
  });

  it('Rule 4 — synthetic root is deterministic (same inputs, any order → same hash, Wave G.3)', () => {
    // Use the same scenario as the happy-path Rule 4 test above:
    // the LONG chain has an unproved t1 + extra tail; the SHORT
    // chain has a proved t1. Enrichment is a genuine fire here.
    const t0 = makeTransaction('0', { committed: true });
    const HEX_STATE_A = 'a'.repeat(64);
    const HEX_STATE_B = 'b'.repeat(64);
    const HEX_DATA_1 = 'c'.repeat(64);
    const HEX_PROOF_1 = 'd'.repeat(64);
    const t1Unproved: PoolEntry = [
      hexTag('tx1u'),
      {
        header: {
      representation: 1,
      semantics: 1,
      kind: 'default' as const,
      predecessor: null,
    },
        type: 'transaction',
        content: {},
        children: {
          sourceState: HEX_STATE_A,
          data: HEX_DATA_1,
          inclusionProof: null,
          destinationState: HEX_STATE_B,
        },
      },
    ];
    const t1Proved: PoolEntry = [
      hexTag('tx1p'),
      {
        header: {
      representation: 1,
      semantics: 1,
      kind: 'default' as const,
      predecessor: null,
    },
        type: 'transaction',
        content: {},
        children: {
          sourceState: HEX_STATE_A,
          data: HEX_DATA_1,
          inclusionProof: HEX_PROOF_1,
          destinationState: HEX_STATE_B,
        },
      },
    ];
    const t2 = makeTransaction('2', { committed: false });

    const [shortRootH, shortRoot] = makeTokenRoot('short', [t0[0], t1Proved[0]]);
    const [longRootH, longRoot] = makeTokenRoot('long', [t0[0], t1Unproved[0], t2[0]]);
    const pool = buildPool(
      t0,
      t1Unproved,
      t1Proved,
      t2,
      [shortRootH, shortRoot],
      [longRootH, longRoot],
    );

    const verifiedProofs = new Set([HEX_PROOF_1]);
    const a = resolveTokenRoot({ tokenId: 'T', candidates: [shortRootH, longRootH], pool, verifiedProofs });
    const b = resolveTokenRoot({ tokenId: 'T', candidates: [longRootH, shortRootH], pool, verifiedProofs });
    expect(a.kind).toBe('enriched');
    expect(b.kind).toBe('enriched');
    if (a.kind !== 'enriched' || b.kind !== 'enriched') return;
    expect(a.rootHash).toBe(b.rootHash);
  });

  it('dedupes identical rootHashes — `[rh, rh, rh]` is treated as single candidate', () => {
    // A degenerate multi-source merge where the same rootHash shows
    // up N times should not produce N-1 fake losers. Dedup at entry.
    const [txH, tx] = makeTransaction('0', { committed: true });
    const [rootH, root] = makeTokenRoot('A', [txH]);
    const pool = buildPool([txH, tx], [rootH, root]);

    const outcome = resolveTokenRoot({
      tokenId: 'T',
      candidates: [rootH, rootH, rootH],
      pool,
    });
    expect(outcome.kind).toBe('single');
    expect(outcome.rootHash).toBe(rootH);
  });

  // ---------------------------------------------------------------------------
  // Rule 4 — FIX 4 regression: altProofIsStructurallyValid checks the
  // schema-correct field `merkleTreePath` (was `smtPath` typo) so the
  // gate actually accepts well-formed alt candidates. Previously
  // `pc.smtPath !== 'string'` ALWAYS returned `false`, silently disabling
  // Rule 4 enrichment for every alt whose proof element was present in
  // the pool.
  // ---------------------------------------------------------------------------
  it('Rule 4 — FIX 4: enrichment activates when alt has well-formed inclusion-proof element with merkleTreePath child', () => {
    const t0 = makeTransaction('0', { committed: true });
    const HEX_STATE_A = 'a'.repeat(64);
    const HEX_STATE_B = 'b'.repeat(64);
    const HEX_DATA_1 = 'c'.repeat(64);
    const HEX_PROOF_1 = 'd'.repeat(64);
    const HEX_AUTH = 'e'.repeat(64);
    const HEX_MERKLE = 'f'.repeat(64);
    const HEX_CERT = '1'.repeat(64);

    const t1Unproved: PoolEntry = [
      hexTag('tx1u'),
      {
        header: { representation: 1, semantics: 1, kind: 'default' as const, predecessor: null },
        type: 'transaction',
        content: {},
        children: { sourceState: HEX_STATE_A, data: HEX_DATA_1, inclusionProof: null, destinationState: HEX_STATE_B },
      },
    ];
    // The proved alt's transaction references HEX_PROOF_1 as its
    // inclusion-proof child.
    const t1Proved: PoolEntry = [
      hexTag('tx1p'),
      {
        header: { representation: 1, semantics: 1, kind: 'default' as const, predecessor: null },
        type: 'transaction',
        content: {},
        children: { sourceState: HEX_STATE_A, data: HEX_DATA_1, inclusionProof: HEX_PROOF_1, destinationState: HEX_STATE_B },
      },
    ];
    // The actual inclusion-proof element with the schema-correct
    // children: authenticator + merkleTreePath (+ unicityCertificate).
    // Pre-fix this element would be REJECTED because the gate looked
    // for the wrong field name `smtPath`.
    const proofEl: PoolEntry = [
      HEX_PROOF_1 as ContentHash,
      {
        header: { representation: 1, semantics: 1, kind: 'default' as const, predecessor: null },
        type: 'inclusion-proof',
        content: { transactionHash: HEX_DATA_1 },
        children: {
          authenticator: HEX_AUTH,
          merkleTreePath: HEX_MERKLE,
          unicityCertificate: HEX_CERT,
        },
      },
    ];
    const t2 = makeTransaction('2', { committed: false });
    const [shortRootH, shortRoot] = makeTokenRoot('short', [t0[0], t1Proved[0]]);
    const [longRootH, longRoot] = makeTokenRoot('long', [t0[0], t1Unproved[0], t2[0]]);
    const pool = buildPool(
      t0,
      t1Unproved,
      t1Proved,
      proofEl,
      t2,
      [shortRootH, shortRoot],
      [longRootH, longRoot],
    );

    const outcome = resolveTokenRoot({
      tokenId: 'T',
      candidates: [shortRootH, longRootH],
      pool,
      verifiedProofs: new Set([HEX_PROOF_1 as ContentHash]),
    });

    // With the typo fixed, the alt's structural validation passes and
    // Rule 4 enrichment fires. Before the fix, this same fixture
    // would have classified as `divergent` because the gate rejected
    // the proof element on a non-existent `smtPath` field.
    expect(outcome.kind).toBe('enriched');
    if (outcome.kind !== 'enriched') return;
    expect(outcome.syntheticRoot.children.transactions).toEqual([
      t0[0],
      t1Proved[0],
      t2[0],
    ]);
  });
});
