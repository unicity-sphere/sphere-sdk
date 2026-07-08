/**
 * Tests for Audit #333 H3 — UxfPackage.mergePkg silent-drop fix.
 *
 * Background
 * ----------
 * Before this fix, a per-token resolver throw inside `mergePkg`
 * (e.g., `computeElementHash` rejecting a malformed child during a
 * Rule 4 synthetic rebuild) was silently dropped with only a
 * `logger.warn`. The affected tokenId vanished from the merged
 * manifest with no observable signal to the caller. On the receive
 * path this manifested as token loss from view: a legitimately-
 * received token whose sibling element was malformed disappeared
 * entirely instead of being flagged.
 *
 * Fix
 * ---
 *   - `UxfPackage.merge()` now returns `{ skipped: MergeSkip[] }`.
 *     Each `MergeSkip` records the tokenId, error, target's prior
 *     root (if any), and the source's incoming root that we failed
 *     to incorporate.
 *   - `opts.strict: true` aggregates skipped tokens into a
 *     `UxfError('MERGE_PARTIAL_FAILURE')` thrown BEFORE the atomic
 *     apply phase — target state is unchanged on the throw.
 *   - `opts.onSkip` fires once per skipped tokenId for callers that
 *     want telemetry visibility without strict-mode failure.
 *   - Back-compat: callers passing `verifiedProofs` directly as the
 *     positional third arg of internal mergePkg still work; the
 *     public `.merge()` API was always opts-bag-based.
 *
 * These tests use vi.mock to control `resolveTokenRoot`'s behavior
 * so the contract is exercised without depending on the natural
 * trigger conditions (which require constructing a malformed Rule 4
 * synthetic rebuild scenario).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UxfPackage } from '../../../extensions/uxf/bundle/UxfPackage.js';
import { UxfError } from '../../../extensions/uxf/bundle/errors.js';
import {
  TOKEN_A,
  TOKEN_B,
  TOKEN_C,
} from '../../fixtures/uxf-mock-tokens.js';
import * as tokenJoin from '../../../extensions/uxf/bundle/token-join.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tokenId(token: Record<string, unknown>): string {
  return (
    (token.genesis as { data: { tokenId: string } }).data.tokenId
  ).toLowerCase();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Audit #333 H3 — mergePkg surfaces per-token skips', () => {
  let resolveSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resolveSpy = vi.spyOn(tokenJoin, 'resolveTokenRoot');
  });

  afterEach(() => {
    resolveSpy.mockRestore();
  });

  describe('default (non-strict) mode', () => {
    it('returns an empty `skipped` array when every resolver succeeds', () => {
      const pkg1 = UxfPackage.create();
      pkg1.ingest(TOKEN_A);

      const pkg2 = UxfPackage.create();
      pkg2.ingest(TOKEN_B);

      const result = pkg1.merge(pkg2);
      expect(result.skipped).toEqual([]);
      // Sanity: both tokens landed in the merged manifest.
      expect(pkg1.hasToken(tokenId(TOKEN_A))).toBe(true);
      expect(pkg1.hasToken(tokenId(TOKEN_B))).toBe(true);
    });

    it('captures a per-token resolver throw in `skipped` (was silently dropped pre-fix)', () => {
      // Build two packages that BOTH carry TOKEN_A. Tamper pkg2's
      // manifest entry for TOKEN_A so it points to a different (but
      // syntactically valid) rootHash — this forces the resolver to
      // fire on the divergent pair instead of taking the
      // `existingRoot === incomingRoot` fast path. Then force the
      // resolver to throw via vi.spyOn.
      const pkg1 = UxfPackage.create();
      pkg1.ingest(TOKEN_A);

      const pkg2 = UxfPackage.create();
      pkg2.ingest(TOKEN_A);
      pkg2.ingest(TOKEN_C);

      const targetTokenId = tokenId(TOKEN_A);
      // Tamper pkg2 to force a divergent manifest entry for TOKEN_A.
      (pkg2.packageData.manifest.tokens as Map<string, string>).set(
        targetTokenId,
        '55'.repeat(32),
      );

      resolveSpy.mockImplementation((params: { tokenId: string }) => {
        if (params.tokenId === targetTokenId) {
          throw new Error('synthetic resolver fault');
        }
        throw new Error(
          `test bug: unexpected resolver call for tokenId=${params.tokenId}`,
        );
      });

      const result = pkg1.merge(pkg2);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].tokenId).toBe(targetTokenId);
      expect(result.skipped[0].error.message).toBe('synthetic resolver fault');
      // Pre-fix the affected token vanished; now it's preserved at the
      // target's PRIOR root (we DID NOT incorporate the incoming root
      // because we couldn't resolve, but we also did NOT drop the
      // entry we already had).
      expect(pkg1.hasToken(targetTokenId)).toBe(true);
      // TOKEN_C (disjoint tokenId) successfully merged.
      expect(pkg1.hasToken(tokenId(TOKEN_C))).toBe(true);
    });

    it('records the target-prior and source-incoming hashes in MergeSkip', () => {
      const pkg1 = UxfPackage.create();
      pkg1.ingest(TOKEN_A);
      const pkg2 = UxfPackage.create();
      pkg2.ingest(TOKEN_A);

      // Force divergence: tamper pkg2's manifest entry for TOKEN_A so
      // the resolver fires. Easiest: just inject a different rootHash.
      // We do this by directly mutating pkg2's manifest map post-
      // ingest. The pool stays valid; only the manifest pointer is
      // changed.
      const tokenAId = tokenId(TOKEN_A);
      const data = pkg2.packageData;
      const realRoot = data.manifest.tokens.get(tokenAId)!;
      const fakeRoot = ('00'.repeat(32)) as string;
      (data.manifest.tokens as Map<string, string>).set(tokenAId, fakeRoot);

      resolveSpy.mockImplementation((params: { tokenId: string }) => {
        if (params.tokenId === tokenAId) {
          throw new Error('forced fault');
        }
        throw new Error(`unexpected tokenId=${params.tokenId}`);
      });

      const result = pkg1.merge(pkg2);
      expect(result.skipped).toHaveLength(1);
      const skip = result.skipped[0];
      expect(skip.tokenId).toBe(tokenAId);
      expect(skip.sourceIncoming).toBe(fakeRoot);
      expect(skip.targetExisting).toBe(realRoot);
    });
  });

  describe('strict mode', () => {
    it('throws UxfError(MERGE_PARTIAL_FAILURE) when any per-token resolver throws', () => {
      const pkg1 = UxfPackage.create();
      pkg1.ingest(TOKEN_A);
      const pkg2 = UxfPackage.create();
      pkg2.ingest(TOKEN_A);

      const tokenAId = tokenId(TOKEN_A);
      // Tamper to force divergence.
      const data = pkg2.packageData;
      (data.manifest.tokens as Map<string, string>).set(
        tokenAId,
        '11'.repeat(32),
      );

      resolveSpy.mockImplementation(() => {
        throw new Error('forced strict-mode fault');
      });

      let thrown: unknown = null;
      try {
        pkg1.merge(pkg2, { strict: true });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(UxfError);
      expect((thrown as UxfError).code).toBe('MERGE_PARTIAL_FAILURE');
      // Structured skip list is attached to the error for caller use.
      const skipped = (thrown as unknown as {
        skipped: Array<{ tokenId: string; error: Error }>;
      }).skipped;
      expect(skipped).toHaveLength(1);
      expect(skipped[0].tokenId).toBe(tokenAId);
    });

    it('leaves target unchanged on strict-mode throw (atomic-failure invariant)', () => {
      const pkg1 = UxfPackage.create();
      pkg1.ingest(TOKEN_A);
      pkg1.ingest(TOKEN_B);
      const tokenAId = tokenId(TOKEN_A);
      const tokenBId = tokenId(TOKEN_B);
      const tokenCId = tokenId(TOKEN_C);
      const pkg2 = UxfPackage.create();
      pkg2.ingest(TOKEN_A);
      pkg2.ingest(TOKEN_C);

      // Force divergence on TOKEN_A so the resolver fires; the strict
      // throw should prevent TOKEN_C from landing.
      (pkg2.packageData.manifest.tokens as Map<string, string>).set(
        tokenAId,
        '22'.repeat(32),
      );

      resolveSpy.mockImplementation((params: { tokenId: string }) => {
        if (params.tokenId === tokenAId) {
          throw new Error('strict-mode atomicity probe');
        }
        throw new Error(`unexpected tokenId=${params.tokenId}`);
      });

      expect(() => pkg1.merge(pkg2, { strict: true })).toThrow(UxfError);

      // pkg1 still has TOKEN_A + TOKEN_B from its original ingest; it
      // did NOT acquire TOKEN_C because strict mode aborted before the
      // atomic apply phase.
      expect(pkg1.hasToken(tokenAId)).toBe(true);
      expect(pkg1.hasToken(tokenBId)).toBe(true);
      expect(pkg1.hasToken(tokenCId)).toBe(false);
    });

    it('does NOT throw under strict mode when no resolver fails', () => {
      const pkg1 = UxfPackage.create();
      pkg1.ingest(TOKEN_A);
      const pkg2 = UxfPackage.create();
      pkg2.ingest(TOKEN_B);
      // Disjoint tokenIds — no resolver call.

      const result = pkg1.merge(pkg2, { strict: true });
      expect(result.skipped).toEqual([]);
    });
  });

  describe('onSkip callback', () => {
    it('fires once per skipped tokenId', () => {
      const pkg1 = UxfPackage.create();
      pkg1.ingest(TOKEN_A);
      const pkg2 = UxfPackage.create();
      pkg2.ingest(TOKEN_A);

      const tokenAId = tokenId(TOKEN_A);
      (pkg2.packageData.manifest.tokens as Map<string, string>).set(
        tokenAId,
        '33'.repeat(32),
      );

      resolveSpy.mockImplementation(() => {
        throw new Error('callback test fault');
      });

      const observed: Array<{ tokenId: string; error: Error }> = [];
      pkg1.merge(pkg2, {
        onSkip: (event) => observed.push(event),
      });

      expect(observed).toHaveLength(1);
      expect(observed[0].tokenId).toBe(tokenAId);
      expect(observed[0].error.message).toBe('callback test fault');
    });

    it('does NOT change merge semantics when onSkip itself throws', () => {
      const pkg1 = UxfPackage.create();
      pkg1.ingest(TOKEN_A);
      const pkg2 = UxfPackage.create();
      pkg2.ingest(TOKEN_A);

      const tokenAId = tokenId(TOKEN_A);
      (pkg2.packageData.manifest.tokens as Map<string, string>).set(
        tokenAId,
        '44'.repeat(32),
      );

      resolveSpy.mockImplementation(() => {
        throw new Error('callback-throws-during-merge');
      });

      const result = pkg1.merge(pkg2, {
        onSkip: () => {
          throw new Error('observability-side fault');
        },
      });
      // Merge still completed (no strict mode), skipped is reported.
      expect(result.skipped).toHaveLength(1);
    });
  });
});
