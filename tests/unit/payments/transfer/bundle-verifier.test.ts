/**
 * Tests for `modules/payments/transfer/bundle-verifier.ts` (T.3.A).
 *
 * Spec references:
 *  - §5.2 #1 — `pkg.verify()` delegation.
 *  - §5.2 #2 — `tokenIds` advisory + claimed/unclaimed split.
 *  - §5.2 #3 — chain-depth cap (two-tier rule).
 *  - §5.2 #4 — smuggled-roots count cap (fail-closed type-tag handling).
 *
 * Strategy:
 *  - Build real UxfPackage instances via `ingest`/`ingestAll` for the
 *    happy-path / advisory-unclaimed cases — exercises the real pool
 *    layout and `pkg.verify()` end-to-end.
 *  - For the chain-depth cap (need > 64 transactions in a chain) and
 *    the unknown-type-tag case, build minimal pkg-like fixtures that
 *    expose only the surface the verifier reads: `verify()` and
 *    `packageData.pool`. The verifier is a pure function over those
 *    inputs, so a thin double is sufficient.
 */

import { describe, expect, it } from 'vitest';

import { isSphereError } from '../../../../core/errors';
import {
  verifyBundleStructure,
  type RootRef,
} from '../../../../modules/payments/transfer/bundle-verifier';
import {
  MAX_CHAIN_DEPTH,
  MAX_UNCLAIMED_ROOTS,
} from '../../../../modules/payments/transfer/limits';
import type { UxfTransferPayloadCar } from '../../../../types/uxf-transfer';
import { UxfPackage } from '../../../../uxf/UxfPackage';
import {
  ELEMENT_TYPE_TOKEN_ROOT,
  type ContentHash,
  type UxfElement,
  type UxfPackageData,
  type UxfVerificationResult,
} from '../../../../uxf/types';

import { TOKEN_A, TOKEN_B, TOKEN_C } from '../../../fixtures/uxf-mock-tokens';

// =============================================================================
// 1. Helpers
// =============================================================================

/** TokenIds used by the fixtures, lowercased. */
const TOKEN_A_ID = 'aa00000000000000000000000000000000000000000000000000000000000001';
const TOKEN_B_ID = 'bb00000000000000000000000000000000000000000000000000000000000002';
const TOKEN_C_ID = 'cc00000000000000000000000000000000000000000000000000000000000003';

/** A representative bundleCid (any string — verifier doesn't parse it). */
const BUNDLE_CID = 'bafytest00000000000000000000000000000000000000000000000000000001';

/**
 * Build a `kind: 'uxf-car'` payload claiming the given tokenIds. The
 * `carBase64` field is unused by the verifier (the acquirer extracts
 * the CAR upstream), so we leave it empty.
 */
function payload(tokenIds: readonly string[]): UxfTransferPayloadCar {
  return {
    kind: 'uxf-car',
    version: '1.0',
    mode: 'instant',
    bundleCid: BUNDLE_CID,
    tokenIds,
    carBase64: '',
  };
}

/**
 * Build a thin pkg-like double that exposes the surface the verifier
 * reads: `verify()` and `packageData.pool`. Used only in tests where
 * we need fine-grained control over the pool contents (chain-depth
 * boundary, unknown type-tag, etc.) — the real `UxfPackage` instances
 * cover the happy paths.
 */
function pkgDouble(opts: {
  pool: Map<ContentHash, UxfElement>;
  verifyResult?: UxfVerificationResult;
}): UxfPackage {
  const verifyResult: UxfVerificationResult = opts.verifyResult ?? {
    valid: true,
    errors: [],
    warnings: [],
    stats: {
      tokensChecked: 0,
      elementsChecked: 0,
      orphanedElements: 0,
      instanceChainsChecked: 0,
    },
  };
  const fakePackageData = {
    envelope: { version: '1.0.0', createdAt: 0, updatedAt: 0 },
    manifest: { tokens: new Map() },
    pool: opts.pool,
    instanceChains: new Map(),
    indexes: { byTokenType: new Map(), byCoinId: new Map(), byStateHash: new Map() },
  } as unknown as UxfPackageData;

  const fake = {
    verify: () => verifyResult,
    packageData: fakePackageData,
  };
  return fake as unknown as UxfPackage;
}

/**
 * Build a fake token-root element with a configurable transactions[]
 * length so we can cross the chain-depth cap.
 */
function fakeTokenRootElement(
  tokenId: string,
  txCount: number,
): { hash: ContentHash; element: UxfElement } {
  // The hash is just a unique 64-hex string per tokenId × txCount; we
  // never re-derive it cryptographically here because the verifier
  // does NOT recompute hashes (it trusts pkg.verify()).
  const hash = (tokenId + 'f'.repeat(64)).slice(0, 64) as ContentHash;
  const transactions: ContentHash[] = [];
  for (let i = 0; i < txCount; i++) {
    transactions.push(`${hash.slice(0, 60)}${i.toString(16).padStart(4, '0')}` as ContentHash);
  }
  const element: UxfElement = {
    header: {
      representation: 1,
      semantics: 1,
      kind: 'default',
      predecessor: null,
    },
    type: ELEMENT_TYPE_TOKEN_ROOT,
    content: {
      tokenId,
      version: '2.0',
    },
    children: {
      genesis: 'genesis-placeholder' as ContentHash,
      transactions,
      state: 'state-placeholder' as ContentHash,
      nametags: [],
    },
  };
  return { hash, element };
}

// =============================================================================
// 2. §5.2 #1 — pkg.verify() delegation
// =============================================================================

describe('verifyBundleStructure §5.2 #1 — pkg.verify() wrapper', () => {
  it('happy path: clean package with claimed token passes', () => {
    const pkg = UxfPackage.create();
    pkg.ingest(TOKEN_A);
    const result = verifyBundleStructure(pkg, payload([TOKEN_A_ID]), BUNDLE_CID);
    expect(result.verified).toBe(true);
    expect(result.claimedTokens).toHaveLength(1);
    expect(result.claimedTokens[0].tokenId).toBe(TOKEN_A_ID);
    expect(result.advisoryUnclaimedRoots).toHaveLength(0);
    expect(result.missingClaimedTokenIds).toHaveLength(0);
  });

  it('rejects with BUNDLE_REJECTED_VERIFY_FAILED on pkg.verify() failure', () => {
    // Inject a verify result with errors.
    const pkg = pkgDouble({
      pool: new Map(),
      verifyResult: {
        valid: false,
        errors: [
          { code: 'CYCLE_DETECTED', message: 'cycle in tok subgraph', tokenId: 'tok' },
        ],
        warnings: [],
        stats: {
          tokensChecked: 1,
          elementsChecked: 0,
          orphanedElements: 0,
          instanceChainsChecked: 0,
        },
      },
    });
    let caught: unknown;
    try {
      verifyBundleStructure(pkg, payload([]), BUNDLE_CID);
    } catch (err) {
      caught = err;
    }
    expect(isSphereError(caught)).toBe(true);
    if (!isSphereError(caught)) throw new Error('unreachable');
    expect(caught.code).toBe('BUNDLE_REJECTED_VERIFY_FAILED');
  });

  it('forwards UxfVerificationIssue[] as cause', () => {
    const pkg = pkgDouble({
      pool: new Map(),
      verifyResult: {
        valid: false,
        errors: [
          { code: 'MISSING_ELEMENT', message: 'missing X' },
        ],
        warnings: [],
        stats: {
          tokensChecked: 0,
          elementsChecked: 0,
          orphanedElements: 0,
          instanceChainsChecked: 0,
        },
      },
    });
    let caught: unknown;
    try {
      verifyBundleStructure(pkg, payload([]), BUNDLE_CID);
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.cause).toBeDefined();
    expect(Array.isArray(caught.cause)).toBe(true);
  });
});

// =============================================================================
// 3. §5.2 #2 — token-id claim consistency (advisory tokenIds)
// =============================================================================

describe('verifyBundleStructure §5.2 #2 — tokenIds are advisory', () => {
  it('processes a token NOT in payload.tokenIds as advisoryUnclaimedRoots', () => {
    const pkg = UxfPackage.create();
    pkg.ingest(TOKEN_A);
    pkg.ingest(TOKEN_B);
    // Only claim TOKEN_A; TOKEN_B is unclaimed.
    const result = verifyBundleStructure(pkg, payload([TOKEN_A_ID]), BUNDLE_CID);
    expect(result.claimedTokens).toHaveLength(1);
    expect(result.claimedTokens[0].tokenId).toBe(TOKEN_A_ID);
    expect(result.advisoryUnclaimedRoots).toHaveLength(1);
    expect(result.advisoryUnclaimedRoots[0].tokenId).toBe(TOKEN_B_ID);
  });

  it('reports missing claimed tokenIds (claim present in payload, root absent)', () => {
    const pkg = UxfPackage.create();
    pkg.ingest(TOKEN_A);
    const result = verifyBundleStructure(
      pkg,
      payload([TOKEN_A_ID, 'ff' + '0'.repeat(62)]),
      BUNDLE_CID,
    );
    expect(result.claimedTokens).toHaveLength(1);
    expect(result.missingClaimedTokenIds).toEqual(['ff' + '0'.repeat(62)]);
  });

  it('empty payload.tokenIds — every root becomes unclaimed', () => {
    const pkg = UxfPackage.create();
    pkg.ingest(TOKEN_A);
    pkg.ingest(TOKEN_B);
    const result = verifyBundleStructure(pkg, payload([]), BUNDLE_CID);
    expect(result.claimedTokens).toHaveLength(0);
    expect(result.advisoryUnclaimedRoots).toHaveLength(2);
  });
});

// =============================================================================
// 4. §5.2 #3 — chain-depth cap (two-tier rule)
// =============================================================================

describe('verifyBundleStructure §5.2 #3 — chain-depth cap', () => {
  it('passes when claimed token is within depth cap', () => {
    // TOKEN_C has 3 transactions in fixture.
    const pkg = UxfPackage.create();
    pkg.ingest(TOKEN_C);
    const result = verifyBundleStructure(pkg, payload([TOKEN_C_ID]), BUNDLE_CID);
    expect(result.claimedTokens[0].chainDepth).toBe(3);
  });

  it('claimed token with chainDepth > MAX_CHAIN_DEPTH rejects WHOLE bundle', () => {
    const { hash, element } = fakeTokenRootElement(TOKEN_A_ID, MAX_CHAIN_DEPTH + 1);
    const pool = new Map<ContentHash, UxfElement>([[hash, element]]);
    const pkg = pkgDouble({ pool });

    let caught: unknown;
    try {
      verifyBundleStructure(pkg, payload([TOKEN_A_ID]), BUNDLE_CID);
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('BUNDLE_REJECTED_CHAIN_DEPTH_EXCEEDED');
    expect(caught.message).toContain(TOKEN_A_ID);
  });

  it('claimed token at exactly MAX_CHAIN_DEPTH passes (boundary)', () => {
    const { hash, element } = fakeTokenRootElement(TOKEN_A_ID, MAX_CHAIN_DEPTH);
    const pool = new Map<ContentHash, UxfElement>([[hash, element]]);
    const pkg = pkgDouble({ pool });
    const result = verifyBundleStructure(pkg, payload([TOKEN_A_ID]), BUNDLE_CID);
    expect(result.claimedTokens[0].chainDepth).toBe(MAX_CHAIN_DEPTH);
  });

  it('UNCLAIMED token with chainDepth > MAX_CHAIN_DEPTH is silently dropped', () => {
    // One unclaimed deep root; one shallow root; nothing claimed.
    const deep = fakeTokenRootElement(TOKEN_A_ID, MAX_CHAIN_DEPTH + 1);
    const shallow = fakeTokenRootElement(TOKEN_B_ID, 2);
    const pool = new Map<ContentHash, UxfElement>([
      [deep.hash, deep.element],
      [shallow.hash, shallow.element],
    ]);
    const pkg = pkgDouble({ pool });
    const result = verifyBundleStructure(pkg, payload([]), BUNDLE_CID);
    // Deep root is silently dropped; shallow stays.
    expect(result.advisoryUnclaimedRoots.map((r: RootRef) => r.tokenId)).toEqual([
      TOKEN_B_ID,
    ]);
    expect(result.droppedDeepUnclaimed).toBe(1);
  });

  it('mixing claimed-shallow + unclaimed-deep: bundle survives, deep dropped silently', () => {
    const claimed = fakeTokenRootElement(TOKEN_A_ID, 5);
    const unclaimedDeep = fakeTokenRootElement(TOKEN_B_ID, MAX_CHAIN_DEPTH + 5);
    const pool = new Map<ContentHash, UxfElement>([
      [claimed.hash, claimed.element],
      [unclaimedDeep.hash, unclaimedDeep.element],
    ]);
    const pkg = pkgDouble({ pool });
    const result = verifyBundleStructure(pkg, payload([TOKEN_A_ID]), BUNDLE_CID);
    expect(result.claimedTokens.map((r: RootRef) => r.tokenId)).toEqual([TOKEN_A_ID]);
    expect(result.advisoryUnclaimedRoots).toHaveLength(0);
    expect(result.droppedDeepUnclaimed).toBe(1);
  });
});

// =============================================================================
// 5. §5.2 #4 — smuggled-roots count cap
// =============================================================================

describe('verifyBundleStructure §5.2 #4 — smuggled-roots count cap', () => {
  it('passes when unclaimed root count <= MAX_UNCLAIMED_ROOTS', () => {
    // Build exactly MAX_UNCLAIMED_ROOTS unclaimed roots — should pass.
    const pool = new Map<ContentHash, UxfElement>();
    for (let i = 0; i < MAX_UNCLAIMED_ROOTS; i++) {
      const id = `ab${i.toString(16).padStart(62, '0')}`;
      const { hash, element } = fakeTokenRootElement(id, 1);
      pool.set(hash, element);
    }
    const pkg = pkgDouble({ pool });
    const result = verifyBundleStructure(pkg, payload([]), BUNDLE_CID);
    expect(result.advisoryUnclaimedRoots).toHaveLength(MAX_UNCLAIMED_ROOTS);
  });

  it('rejects when unclaimed root count > MAX_UNCLAIMED_ROOTS', () => {
    const pool = new Map<ContentHash, UxfElement>();
    for (let i = 0; i < MAX_UNCLAIMED_ROOTS + 1; i++) {
      const id = `ab${i.toString(16).padStart(62, '0')}`;
      const { hash, element } = fakeTokenRootElement(id, 1);
      pool.set(hash, element);
    }
    const pkg = pkgDouble({ pool });
    let caught: unknown;
    try {
      verifyBundleStructure(pkg, payload([]), BUNDLE_CID);
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('BUNDLE_REJECTED_UNCLAIMED_ROOT_COUNT_EXCEEDED');
  });

  it('claimed roots do NOT count toward the smuggled-roots cap', () => {
    // 20 claimed roots + 0 unclaimed → does not trip the cap (cap counts
    // only unclaimed/unknown elements).
    const pool = new Map<ContentHash, UxfElement>();
    const claimedIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = `cd${i.toString(16).padStart(62, '0')}`;
      claimedIds.push(id);
      const { hash, element } = fakeTokenRootElement(id, 1);
      pool.set(hash, element);
    }
    const pkg = pkgDouble({ pool });
    const result = verifyBundleStructure(pkg, payload(claimedIds), BUNDLE_CID);
    expect(result.claimedTokens).toHaveLength(20);
  });

  it('unknown top-level type-tag counts toward MAX_UNCLAIMED_ROOTS (fail-closed)', () => {
    // Build MAX_UNCLAIMED_ROOTS legitimate unclaimed roots PLUS one
    // unknown-type-tag element. Together they exceed the cap → reject.
    const pool = new Map<ContentHash, UxfElement>();
    for (let i = 0; i < MAX_UNCLAIMED_ROOTS; i++) {
      const id = `ef${i.toString(16).padStart(62, '0')}`;
      const { hash, element } = fakeTokenRootElement(id, 1);
      pool.set(hash, element);
    }
    // One unknown element — type-tag the verifier doesn't recognize.
    const unknownHash = ('f' + '1'.repeat(63)) as ContentHash;
    pool.set(unknownHash, {
      header: { representation: 1, semantics: 1, kind: 'default', predecessor: null },
      // Cast — TypeScript's UxfElementType union forbids unknown strings,
      // but at runtime this is exactly the case the spec documents.
      type: 'future-mystery-type' as unknown as UxfElement['type'],
      content: {},
      children: {},
    });
    const pkg = pkgDouble({ pool });
    let caught: unknown;
    try {
      verifyBundleStructure(pkg, payload([]), BUNDLE_CID);
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('BUNDLE_REJECTED_UNCLAIMED_ROOT_COUNT_EXCEEDED');
  });

  it('recognized non-root element types do NOT count toward the cap', () => {
    // 16 unclaimed roots — at the cap exactly — plus a bunch of
    // legitimately-typed sub-elements. Should pass.
    const pool = new Map<ContentHash, UxfElement>();
    for (let i = 0; i < MAX_UNCLAIMED_ROOTS; i++) {
      const id = `12${i.toString(16).padStart(62, '0')}`;
      const { hash, element } = fakeTokenRootElement(id, 1);
      pool.set(hash, element);
    }
    // Add sub-DAG elements (predicate, transaction-data, etc.) — these
    // have known types but are NOT root-equivalent.
    const sub1 = ('30' + '0'.repeat(62)) as ContentHash;
    pool.set(sub1, {
      header: { representation: 1, semantics: 1, kind: 'default', predecessor: null },
      type: 'predicate',
      content: { raw: 'deadbeef' },
      children: {},
    });
    const sub2 = ('31' + '0'.repeat(62)) as ContentHash;
    pool.set(sub2, {
      header: { representation: 1, semantics: 1, kind: 'default', predecessor: null },
      type: 'transaction-data',
      content: {},
      children: {},
    });
    const pkg = pkgDouble({ pool });
    const result = verifyBundleStructure(pkg, payload([]), BUNDLE_CID);
    expect(result.advisoryUnclaimedRoots).toHaveLength(MAX_UNCLAIMED_ROOTS);
  });
});
