/**
 * Per-token atomicity tests for UxfPackage.mergePkg.
 *
 * mergePkg iterates `source.manifest.tokens`. Historically, a throw
 * inside `resolveTokenRoot` on the i-th iteration would commit the
 * 0..i-1 iterations and skip the tail, leaving the target in a
 * partially-merged state. The fix stages all pool and manifest
 * mutations before any commit, wraps each per-token resolver call in
 * a try/catch, and applies all staged writes atomically at the end.
 *
 * These tests pin that contract:
 *   1. A resolver throw on ONE tokenId does not abort the rest of
 *      the merge — the other tokenIds land and a warning is logged
 *      citing the failed tokenId + error.
 *   2. A whole-bundle integrity failure (Phase 1 pool hash mismatch)
 *      leaves target state completely unchanged.
 *
 * The resolver is mocked via `vi.mock` so a poisoned tokenId can
 * synthetically throw without requiring an invalid-hex element
 * (which would fail Phase 1 pool verification before ever reaching
 * the resolver, and therefore cannot exercise the Phase 2
 * try/catch).
 *
 * A separate test file (not UxfPackage.test.ts) is used so the mock
 * does not leak into the 38 existing merge/ingest/etc. tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { ResolveInput, ResolveOutcome } from '../../../extensions/uxf/bundle/token-join.js';
import { logger, type LogLevel } from '../../../core/logger.js';
import { TOKEN_A, TOKEN_B, TOKEN_C } from '../../fixtures/uxf-mock-tokens.js';

// ---------------------------------------------------------------------------
// Mock wiring. vi.mock() factories run at hoist time; the factory
// cannot reference outer-scope const declarations, so the globalThis
// handle keys are inlined as literal strings both inside the factory
// and in the helper functions below.
//
// The real resolver is stashed on globalThis so test bodies can
// selectively delegate (throw for tokenId X, real resolver otherwise)
// without re-importing the mocked module (which would recurse).
// ---------------------------------------------------------------------------

type ResolveBehavior = (input: ResolveInput) => ResolveOutcome;

function setResolveBehavior(fn: ResolveBehavior): void {
  (globalThis as Record<string, unknown>)[
    '__uxf_merge_atomicity_test_resolver_behavior__'
  ] = fn;
}

function clearResolveBehavior(): void {
  delete (globalThis as Record<string, unknown>)[
    '__uxf_merge_atomicity_test_resolver_behavior__'
  ];
}

function getRealResolver(): ResolveBehavior {
  return (globalThis as Record<string, unknown>)[
    '__uxf_merge_atomicity_test_resolver_real__'
  ] as ResolveBehavior;
}

vi.mock('../../../extensions/uxf/bundle/token-join.js', async () => {
  const actual = await vi.importActual<typeof import('../../../extensions/uxf/bundle/token-join.js')>(
    '../../../extensions/uxf/bundle/token-join.js',
  );
  // Stash the real resolver on globalThis so test bodies reach it
  // without re-importing (which would hit the mock again and recurse).
  (globalThis as Record<string, unknown>)[
    '__uxf_merge_atomicity_test_resolver_real__'
  ] = actual.resolveTokenRoot;
  return {
    ...actual,
    resolveTokenRoot: (input: ResolveInput): ResolveOutcome => {
      const override = (globalThis as Record<string, unknown>)[
        '__uxf_merge_atomicity_test_resolver_behavior__'
      ] as ResolveBehavior | undefined;
      if (override) return override(input);
      return actual.resolveTokenRoot(input);
    },
  };
});

// UxfPackage must be imported AFTER vi.mock so its internal
// `resolveTokenRoot` reference points at the mocked module.
import { UxfPackage } from '../../../extensions/uxf/bundle/UxfPackage.js';
import type { UxfPackageData, UxfElement, ContentHash } from '../../../extensions/uxf/bundle/types.js';
import { UxfError } from '../../../extensions/uxf/bundle/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tokenId(token: Record<string, unknown>): string {
  return ((token.genesis as any).data as any).tokenId.toLowerCase();
}

/**
 * Clone a fixture and bump the genesis salt so the resulting
 * rootHash differs from the original. This simulates the cross-
 * device fork scenario mergePkg must handle (same tokenId, distinct
 * content chain).
 */
function forkToken(
  token: Record<string, unknown>,
  saltSuffix: string,
): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(token)) as Record<string, unknown>;
  const genesis = clone.genesis as Record<string, unknown>;
  const data = genesis.data as Record<string, unknown>;
  const origSalt = data.salt as string;
  const prefix = origSalt.slice(0, origSalt.length - saltSuffix.length);
  data.salt = prefix + saltSuffix;
  return clone;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UxfPackage.merge — per-token atomicity', () => {
  beforeEach(() => {
    clearResolveBehavior();
  });

  afterEach(() => {
    clearResolveBehavior();
    logger.configure({ handler: null });
  });

  it('resolver throw on one tokenId does not abort the other tokens', () => {
    // Target pkg has forks of A, B, C. Source pkg has the ORIGINAL
    // A, B, C. All three tokenIds collide on different rootHashes →
    // resolver is invoked for each. We poison the resolver for
    // tokenId(TOKEN_B), leaving A and C to resolve normally.
    const pkgTarget = UxfPackage.create();
    pkgTarget.ingest(forkToken(TOKEN_A, 'a1a1a1a1'));
    pkgTarget.ingest(forkToken(TOKEN_B, 'b1b1b1b1'));
    pkgTarget.ingest(forkToken(TOKEN_C, 'c1c1c1c1'));

    const pkgSource = UxfPackage.create();
    pkgSource.ingest(TOKEN_A);
    pkgSource.ingest(TOKEN_B);
    pkgSource.ingest(TOKEN_C);

    const idA = tokenId(TOKEN_A);
    const idB = tokenId(TOKEN_B);
    const idC = tokenId(TOKEN_C);

    // Snapshot the target's rootHashes before merge so we can assert
    // B stayed on its original root (resolver skipped) while A and C
    // moved to a resolver-chosen candidate.
    const targetData = pkgTarget.packageData as UxfPackageData;
    const targetManifestBefore = new Map(targetData.manifest.tokens);
    const rootABefore = targetManifestBefore.get(idA)!;
    const rootBBefore = targetManifestBefore.get(idB)!;
    const rootCBefore = targetManifestBefore.get(idC)!;

    // Collect warnings through a pluggable logger handler so we can
    // assert the skipped tokenId was surfaced to operators.
    const warnings: Array<{ tag: string; message: string }> = [];
    logger.configure({
      handler: (level: LogLevel, tag: string, message: string) => {
        if (level === 'warn') warnings.push({ tag, message });
      },
    });

    // Poison the resolver for tokenId B. Fall through to the real
    // resolver for A and C.
    setResolveBehavior((input) => {
      if (input.tokenId === idB) {
        throw new UxfError(
          'VERIFICATION_FAILED',
          `synthetic poison for ${input.tokenId}`,
        );
      }
      return getRealResolver()(input);
    });

    // Must NOT throw — the other two tokens must land cleanly.
    expect(() => pkgTarget.merge(pkgSource)).not.toThrow();

    // A and C: resolver ran. Their post-merge rootHash is either
    // the target candidate or the source candidate (whichever the
    // deterministic resolver picked — lexicographic rootHash order
    // for 0-transaction tokens).
    const manifestAfter = targetData.manifest.tokens;
    const sourceManifest = (pkgSource.packageData as UxfPackageData).manifest.tokens;
    const sourceRootA = sourceManifest.get(idA)!;
    const sourceRootC = sourceManifest.get(idC)!;

    expect([rootABefore, sourceRootA]).toContain(manifestAfter.get(idA));
    expect([rootCBefore, sourceRootC]).toContain(manifestAfter.get(idC));

    // B: unchanged. This is the whole point of the atomicity fix.
    expect(manifestAfter.get(idB)).toBe(rootBBefore);

    // All three tokenIds still present (poisoned entry not deleted).
    expect(manifestAfter.size).toBe(3);

    // Pool still resolves every manifest entry (no dangling refs).
    for (const [, rootHash] of manifestAfter) {
      expect(targetData.pool.has(rootHash)).toBe(true);
    }

    // A warning was logged for tokenId B, naming the tokenId and
    // carrying the resolver's error message.
    const matching = warnings.filter(
      (w) => w.tag === 'UxfPackage' && w.message.includes(idB),
    );
    expect(matching.length).toBe(1);
    expect(matching[0].message).toContain('synthetic poison');
    expect(matching[0].message).toContain('resolver threw');
  });

  it('pool remains content-addressable after a per-token resolver throw', () => {
    // Even though tokenId B's manifest entry stayed on the old root,
    // the source's B-specific pool elements were staged and applied
    // (per the documented pool-rollback policy — unused elements are
    // cheap bloat, gc() prunes later). Assert that pool growth
    // occurred and that target can still resolve every surviving
    // manifest entry.
    const pkgTarget = UxfPackage.create();
    pkgTarget.ingest(forkToken(TOKEN_A, 'a2a2a2a2'));
    pkgTarget.ingest(forkToken(TOKEN_B, 'b2b2b2b2'));
    pkgTarget.ingest(forkToken(TOKEN_C, 'c2c2c2c2'));

    const pkgSource = UxfPackage.create();
    pkgSource.ingest(TOKEN_A);
    pkgSource.ingest(TOKEN_B);
    pkgSource.ingest(TOKEN_C);

    const idB = tokenId(TOKEN_B);
    const poolSizeBefore = pkgTarget.elementCount;

    setResolveBehavior((input) => {
      if (input.tokenId === idB) {
        throw new Error('boom');
      }
      return getRealResolver()(input);
    });

    pkgTarget.merge(pkgSource);

    // Pool grew (source's unique elements for A and C were added).
    expect(pkgTarget.elementCount).toBeGreaterThan(poolSizeBefore);

    // Every manifest entry still resolves to a pool element.
    const manifest = (pkgTarget.packageData as UxfPackageData).manifest.tokens;
    for (const [, rootHash] of manifest) {
      expect(pkgTarget.packageData.pool.has(rootHash)).toBe(true);
    }
  });

  it('target state unchanged if pool verification fails on first element', () => {
    // Phase 1 is a whole-bundle hash-verify gate. A tampered source
    // pool element must abort the merge BEFORE any target mutation.
    // This edge case proves the staged-then-applied invariant holds
    // for the fast-fail path too.
    const pkgTarget = UxfPackage.create();
    pkgTarget.ingest(TOKEN_A);
    pkgTarget.ingest(TOKEN_B);

    const pkgSource = UxfPackage.create();
    pkgSource.ingest(TOKEN_C);

    // Snapshot BEFORE tampering.
    const targetData = pkgTarget.packageData as UxfPackageData;
    const manifestBefore = new Map(targetData.manifest.tokens);
    const poolSizeBefore = pkgTarget.elementCount;
    const updatedAtBefore = targetData.envelope.updatedAt;

    // Tamper: pick any pool element in the source and overwrite its
    // content. The hash key no longer matches computeElementHash of
    // the element → Phase 1 rejects.
    const sourcePool = (pkgSource.packageData as UxfPackageData).pool as Map<
      ContentHash,
      UxfElement
    >;
    const [firstHash, firstElement] = [...sourcePool.entries()][0];
    const tampered: UxfElement = {
      ...firstElement,
      content: { ...firstElement.content, _tampered: 'yes' },
    };
    sourcePool.set(firstHash, tampered);

    expect(() => pkgTarget.merge(pkgSource)).toThrow(UxfError);
    try {
      pkgTarget.merge(pkgSource);
    } catch (e) {
      expect((e as UxfError).code).toBe('VERIFICATION_FAILED');
    }

    // Target is UNCHANGED: manifest, pool size, and envelope
    // updatedAt are all at pre-merge values.
    expect(targetData.manifest.tokens.size).toBe(manifestBefore.size);
    for (const [id, root] of manifestBefore) {
      expect(targetData.manifest.tokens.get(id)).toBe(root);
    }
    expect(pkgTarget.elementCount).toBe(poolSizeBefore);
    expect(targetData.envelope.updatedAt).toBe(updatedAtBefore);
  });

  it('merge completes cleanly when no source tokenId triggers the resolver', () => {
    // Sanity regression: the staging refactor must not alter the
    // common-case behaviour (all source tokenIds are fresh → no
    // resolver invocations, all manifest writes staged + applied).
    const pkgTarget = UxfPackage.create();
    pkgTarget.ingest(TOKEN_A);

    const pkgSource = UxfPackage.create();
    pkgSource.ingest(TOKEN_B);
    pkgSource.ingest(TOKEN_C);

    // Fail-the-test if the resolver is called at all in this
    // scenario — no tokenId collisions means no resolver work.
    setResolveBehavior(() => {
      throw new Error('resolveTokenRoot must not be invoked here');
    });

    expect(() => pkgTarget.merge(pkgSource)).not.toThrow();
    expect(pkgTarget.tokenCount).toBe(3);
    expect(pkgTarget.hasToken(tokenId(TOKEN_A))).toBe(true);
    expect(pkgTarget.hasToken(tokenId(TOKEN_B))).toBe(true);
    expect(pkgTarget.hasToken(tokenId(TOKEN_C))).toBe(true);
  });
});
