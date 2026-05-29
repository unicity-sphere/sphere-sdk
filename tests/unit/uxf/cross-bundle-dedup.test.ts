/**
 * Issue #200 Phase 3 — Hierarchical bundle CAR dedup.
 *
 * Pins the architectural claim from the issue body:
 *
 *   "Bundles that share a token (or token component) reference the same
 *    CID and collapse to one stored block."
 *
 * Concretely: when two UXF packages contain the same token in their
 * manifests, the token-root block AND every reachable sub-element block
 * (genesis, state predicate, transitions, proofs, …) are pinned under
 * IDENTICAL CIDs in both CARs. A naive sum of CAR block counts would
 * double-count the shared elements; the actual IPFS storage cost is
 * `unique-CID count`, which is strictly less than the sum.
 *
 * The dedup is intrinsic to content-addressing: every element block is
 * `dag-cbor encoded with CID links` and the CID is derived from the
 * SHA-256 of the canonical hash form (see `uxf/ipld.ts:computeCid`).
 * Byte-identical content → byte-identical CIDs → IPFS dedups for free.
 *
 * Phase 2 (per-block `dag/put`, landed in commit f938e4c) made the
 * dedup observable at the storage layer. Phase 3 (this test) verifies
 * the architectural property holds end-to-end through the canonical
 * `exportToCar` pipeline.
 *
 * What this test does NOT cover (delegated to Phase 3 follow-ups):
 *  - Live IPFS gateway dedup. The Phase 1 integration test against a
 *    stub gateway (`tests/integration/transfer/uxf-cid-canonical-publisher.test.ts`)
 *    already exercises `pinCarBlocksToIpfs` end-to-end. The architectural
 *    claim verified here is sufficient to predict gateway behavior.
 *  - Cross-device E2E recovery. Covered by the broader profile test
 *    suite.
 */

import { describe, it, expect } from 'vitest';
import { CarReader } from '@ipld/car/reader';
import {
  exportToCar,
  importFromCar,
} from '../../../uxf/ipld.js';
import { ElementPool } from '../../../uxf/element-pool.js';
import { deconstructToken } from '../../../uxf/deconstruct.js';
import type {
  ContentHash,
  UxfElement,
  UxfPackageData,
} from '../../../uxf/types.js';

// ---------------------------------------------------------------------------
// Test fixtures — minimal valid V2 tokens with distinguishable identifiers
// ---------------------------------------------------------------------------

function hexFill(pattern: string, totalChars: number): string {
  return pattern.repeat(Math.ceil(totalChars / pattern.length)).slice(0, totalChars);
}

/**
 * Build a minimal V2 token with a deterministic tokenId derived from
 * `suffix`. Two tokens built with the same `suffix` produce byte-identical
 * elements and therefore identical CIDs — that's the property we exploit
 * to assert dedup.
 */
function makeValidToken(suffix: string): Record<string, unknown> {
  const tokenId = hexFill(suffix, 64);
  return {
    version: '2.0',
    state: { predicate: 'a0'.repeat(32), data: null },
    genesis: {
      data: {
        tokenId,
        tokenType: '00'.repeat(32),
        coinData: [['UCT', '1000000']],
        tokenData: '',
        salt: hexFill('ab', 64),
        recipient: 'DIRECT://test',
        recipientDataHash: null,
        reason: null,
      },
      inclusionProof: {
        authenticator: {
          algorithm: 'secp256k1',
          publicKey: '02' + 'aa'.repeat(32),
          signature: '30' + 'bb'.repeat(63),
          stateHash: 'cc'.repeat(32),
        },
        merkleTreePath: {
          root: 'dd'.repeat(32),
          steps: [{ data: 'ee'.repeat(32), path: '0' }],
        },
        transactionHash: 'ff'.repeat(32),
        unicityCertificate: '11'.repeat(100),
      },
    },
    transactions: [],
    nametags: [],
  };
}

/**
 * Build a UxfPackageData from a list of tokens with a FIXED envelope
 * timestamp. Fixed timestamps are critical for the manifest-dedup
 * assertion: if two packages have IDENTICAL token sets AND IDENTICAL
 * timestamps, their manifest+envelope blocks also collide.
 */
function buildPackageFromTokens(
  tokens: Record<string, unknown>[],
  createdAt: number,
  updatedAt: number,
): UxfPackageData {
  const pool = new ElementPool();
  const manifest = new Map<string, ContentHash>();
  for (const token of tokens) {
    const rootHash = deconstructToken(pool, token);
    const tokenId = (
      (token.genesis as { data: { tokenId: string } }).data.tokenId
    ).toLowerCase();
    manifest.set(tokenId, rootHash);
  }
  return {
    envelope: { version: '1.0.0', createdAt, updatedAt },
    manifest: { tokens: manifest },
    pool: pool.toMap() as Map<ContentHash, UxfElement>,
    instanceChains: new Map(),
    indexes: {
      byTokenType: new Map(),
      byCoinId: new Map(),
      byStateHash: new Map(),
    },
  };
}

async function collectCarBlockCids(car: Uint8Array): Promise<string[]> {
  const reader = await CarReader.fromBytes(car);
  const cids: string[] = [];
  for await (const block of reader.blocks()) {
    cids.push(block.cid.toString());
  }
  return cids;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Issue #200 Phase 3 — cross-bundle hierarchical dedup', () => {
  it('two bundles sharing a token produce overlapping CID sets', async () => {
    // Two distinct packages, each contains token A (shared). Bundle 1
    // additionally contains token B; bundle 2 additionally contains
    // token C. Same envelope timestamps so the envelope+manifest layer
    // dedup is purely about token-set divergence.
    const tokenA = makeValidToken('aa');
    const tokenB = makeValidToken('bb');
    const tokenC = makeValidToken('cc');

    const pkg1 = buildPackageFromTokens([tokenA, tokenB], 1700000000, 1700000001);
    const pkg2 = buildPackageFromTokens([tokenA, tokenC], 1700000002, 1700000003);

    const car1 = await exportToCar(pkg1);
    const car2 = await exportToCar(pkg2);

    const cids1 = new Set(await collectCarBlockCids(car1));
    const cids2 = new Set(await collectCarBlockCids(car2));

    // Architectural claim: at least one CID is shared between the two
    // CARs (the token-A sub-tree, since the same token element bytes
    // yield identical content-addressed CIDs).
    const shared = new Set<string>();
    for (const cid of cids1) {
      if (cids2.has(cid)) shared.add(cid);
    }
    expect(shared.size).toBeGreaterThan(0);

    // Stronger claim: the unique-CID count across BOTH CARs is strictly
    // less than the sum of individual block counts. This is the bedrock
    // dedup property — pinning both CARs to IPFS stores fewer blocks
    // than `cids1.size + cids2.size`.
    const unionSize = new Set([...cids1, ...cids2]).size;
    expect(unionSize).toBeLessThan(cids1.size + cids2.size);
    expect(unionSize).toBe(cids1.size + cids2.size - shared.size);
  });

  it('two bundles with byte-identical content produce identical CAR block sets', async () => {
    // Idempotency check: same token set + same envelope metadata → the
    // CARs may differ in framing bytes (CarWriter chunk boundaries are
    // not specified to be identical across calls) but the BLOCK-CID
    // sets MUST be identical. This is what makes `pinCarBlocksToIpfs`
    // a no-op on the second pin.
    const tokenA = makeValidToken('aa');
    const tokenB = makeValidToken('bb');

    const pkg1 = buildPackageFromTokens([tokenA, tokenB], 1700000000, 1700000001);
    const pkg2 = buildPackageFromTokens([tokenA, tokenB], 1700000000, 1700000001);

    const car1 = await exportToCar(pkg1);
    const car2 = await exportToCar(pkg2);

    const cids1 = new Set(await collectCarBlockCids(car1));
    const cids2 = new Set(await collectCarBlockCids(car2));

    expect(cids1.size).toBe(cids2.size);
    for (const cid of cids1) {
      expect(cids2.has(cid)).toBe(true);
    }
  });

  it('different tokens that share sub-elements still dedup at the sub-element layer', async () => {
    // Even bundles whose TOKENS differ entirely (different tokenIds,
    // different roots) can share sub-element blocks if any reachable
    // child happens to be byte-identical — typically the state
    // predicate, the token-type declaration, or signing-authenticator
    // boilerplate. The dedup payoff scales beyond shared-token bundles
    // because every element is content-addressed independently.
    //
    // This is a STRONGER property than the issue body asks for: not
    // only do shared TOKENS dedup, but shared TOKEN COMPONENTS dedup
    // across bundles whose token sets are otherwise fully disjoint.
    // The realised storage cost on IPFS therefore scales with the
    // count of distinct sub-element blocks, not with the count of
    // tokens or bundles.
    const tokenA = makeValidToken('aa');
    const tokenB = makeValidToken('bb');

    const pkg1 = buildPackageFromTokens([tokenA], 1700000000, 1700000001);
    const pkg2 = buildPackageFromTokens([tokenB], 1700000000, 1700000001);

    const car1 = await exportToCar(pkg1);
    const car2 = await exportToCar(pkg2);

    const cids1 = new Set(await collectCarBlockCids(car1));
    const cids2 = new Set(await collectCarBlockCids(car2));

    const shared = new Set<string>();
    for (const cid of cids1) {
      if (cids2.has(cid)) shared.add(cid);
    }
    // The test fixture intentionally reuses predicate/type/salt boilerplate
    // across the two tokens (see `makeValidToken`). Those shared
    // sub-elements MUST collapse into shared CIDs across the two CARs.
    expect(shared.size).toBeGreaterThan(0);

    // Token roots themselves MUST differ — distinct tokenIds yield
    // distinct genesis-data bytes which propagate up to distinct root
    // CIDs. So although sub-elements dedup, the manifests are bundle-
    // specific.
    const unionSize = new Set([...cids1, ...cids2]).size;
    expect(unionSize).toBeLessThan(cids1.size + cids2.size);
  });

  it('shared elements survive the round-trip via the second bundle alone', async () => {
    // Pin two bundles where bundle 1 has token A + token B and bundle 2
    // has only token A. After pinning, fetch any block in token A's
    // subtree via bundle 2's CAR — it should round-trip with the same
    // content as in bundle 1. This is the consumer-facing guarantee:
    // a wallet that fetches `bundleCid` for bundle 2 sees the canonical
    // token-A bytes even though bundle 1 was published first.
    //
    // We exercise this via `importFromCar(car2)` and confirm token A is
    // present in the restored manifest — proving the per-block view of
    // token A's subtree in CAR 2 reconstructs identically.
    const tokenA = makeValidToken('aa');
    const tokenB = makeValidToken('bb');

    const pkg1 = buildPackageFromTokens([tokenA, tokenB], 1700000000, 1700000001);
    const pkg2 = buildPackageFromTokens([tokenA], 1700000002, 1700000003);

    const car1 = await exportToCar(pkg1);
    const car2 = await exportToCar(pkg2);

    const restored1 = await importFromCar(car1);
    const restored2 = await importFromCar(car2);

    const tokenAId = hexFill('aa', 64).toLowerCase();
    expect(restored1.manifest.tokens.has(tokenAId)).toBe(true);
    expect(restored2.manifest.tokens.has(tokenAId)).toBe(true);
    // Same content → same root hash for token A in both packages.
    expect(restored1.manifest.tokens.get(tokenAId)).toBe(
      restored2.manifest.tokens.get(tokenAId),
    );
  });
});
