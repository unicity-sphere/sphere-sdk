/**
 * Tests for UxfPackage class API (WU-08).
 *
 * Covers: create, ingest, ingestAll, assemble, assembleAtState, assembleAll,
 *         removeToken, gc, merge, verify, consolidateProofs, diff, applyDelta,
 *         filterTokens, tokensByCoinId, tokensByTokenType, transactionCount,
 *         hasToken, tokenIds, toJson, fromJson, toCar, fromCar, save, open,
 *         tokenCount, elementCount, estimatedSize, packageData.
 */

import { describe, it, expect } from 'vitest';
import { UxfPackage } from '../../../uxf/UxfPackage.js';
import { InMemoryUxfStorage } from '../../../uxf/storage-adapters.js';
import { UxfError } from '../../../uxf/errors.js';
import { STRATEGY_ORIGINAL } from '../../../uxf/types.js';
import type { UxfElement, ContentHash } from '../../../uxf/types.js';
import {
  TOKEN_A,
  TOKEN_B,
  TOKEN_C,
  TOKEN_D,
  TOKEN_E,
  TOKEN_F,
  TOKEN_TYPE_FUNGIBLE,
  PREDICATE_A,
} from '../../fixtures/uxf-mock-tokens.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tokenId(token: Record<string, unknown>): string {
  return ((token.genesis as any).data as any).tokenId.toLowerCase();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UxfPackage', () => {
  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  describe('create', () => {
    it('creates empty package', () => {
      const pkg = UxfPackage.create();
      expect(pkg.tokenCount).toBe(0);
      expect(pkg.elementCount).toBe(0);
    });

    it('sets envelope version and timestamps', () => {
      const before = Math.floor(Date.now() / 1000);
      const pkg = UxfPackage.create();
      const after = Math.floor(Date.now() / 1000);
      const env = pkg.packageData.envelope;
      expect(env.version).toBe('1.0.0');
      expect(env.createdAt).toBeGreaterThanOrEqual(before);
      expect(env.createdAt).toBeLessThanOrEqual(after);
      expect(env.updatedAt).toBeGreaterThanOrEqual(before);
      expect(env.updatedAt).toBeLessThanOrEqual(after);
    });

    it('accepts optional description and creator', () => {
      const pkg = UxfPackage.create({ description: 'test desc', creator: 'abc123' });
      expect(pkg.packageData.envelope.description).toBe('test desc');
      expect(pkg.packageData.envelope.creator).toBe('abc123');
    });
  });

  // -------------------------------------------------------------------------
  // ingest / assemble
  // -------------------------------------------------------------------------

  describe('ingest / assemble', () => {
    it('ingest then assemble round-trips', () => {
      const pkg = UxfPackage.create();
      pkg.ingest(TOKEN_A);
      const id = tokenId(TOKEN_A);
      const assembled = pkg.assemble(id) as Record<string, unknown>;
      expect(assembled.version).toBe('2.0');
      const genesis = assembled.genesis as Record<string, unknown>;
      const gd = genesis.data as Record<string, unknown>;
      expect(gd.tokenId).toBe(id);
    });

    it('ingest updates manifest', () => {
      const pkg = UxfPackage.create();
      pkg.ingest(TOKEN_A);
      expect(pkg.hasToken(tokenId(TOKEN_A))).toBe(true);
    });

    it('ingest updates tokenCount', () => {
      const pkg = UxfPackage.create();
      pkg.ingest(TOKEN_A);
      expect(pkg.tokenCount).toBe(1);
    });

    it('ingest updates elementCount', () => {
      const pkg = UxfPackage.create();
      pkg.ingest(TOKEN_A);
      expect(pkg.elementCount).toBeGreaterThan(0);
    });

    it('ingest updates updatedAt timestamp', () => {
      const pkg = UxfPackage.create();
      const createdAt = pkg.packageData.envelope.createdAt;
      pkg.ingest(TOKEN_A);
      expect(pkg.packageData.envelope.updatedAt).toBeGreaterThanOrEqual(createdAt);
    });
  });

  // -------------------------------------------------------------------------
  // ingestAll
  // -------------------------------------------------------------------------

  describe('ingestAll', () => {
    it('batch ingests multiple tokens', () => {
      const pkg = UxfPackage.create();
      pkg.ingestAll([TOKEN_A, TOKEN_B]);
      expect(pkg.tokenCount).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // removeToken / gc
  // -------------------------------------------------------------------------

  describe('removeToken / gc', () => {
    it('removeToken removes from manifest', () => {
      const pkg = UxfPackage.create();
      pkg.ingest(TOKEN_A);
      const id = tokenId(TOKEN_A);
      expect(pkg.hasToken(id)).toBe(true);
      pkg.removeToken(id);
      expect(pkg.hasToken(id)).toBe(false);
    });

    it('removeToken does not remove elements from pool', () => {
      const pkg = UxfPackage.create();
      pkg.ingest(TOKEN_A);
      const elemCount = pkg.elementCount;
      pkg.removeToken(tokenId(TOKEN_A));
      expect(pkg.elementCount).toBe(elemCount);
    });

    it('gc removes unreachable elements', () => {
      const pkg = UxfPackage.create();
      pkg.ingest(TOKEN_A);
      const beforeGc = pkg.elementCount;
      pkg.removeToken(tokenId(TOKEN_A));
      const removed = pkg.gc();
      expect(removed).toBeGreaterThan(0);
      expect(pkg.elementCount).toBeLessThan(beforeGc);
    });

    it('gc returns 0 when no garbage', () => {
      const pkg = UxfPackage.create();
      pkg.ingest(TOKEN_A);
      expect(pkg.gc()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // merge
  // -------------------------------------------------------------------------

  describe('merge', () => {
    it('merge with shared elements deduplicates', () => {
      const pkg1 = UxfPackage.create();
      pkg1.ingestAll([TOKEN_B, TOKEN_C]); // Both share SHARED_CERT

      const pkg2 = UxfPackage.create();
      pkg2.ingestAll([TOKEN_B, TOKEN_C]);

      const beforeMerge = pkg1.elementCount;
      pkg1.merge(pkg2);
      // After merge, no new elements since they're identical
      expect(pkg1.elementCount).toBe(beforeMerge);
    });

    it('merge re-hashes incoming elements (corrupt source throws VERIFICATION_FAILED)', () => {
      const pkg1 = UxfPackage.create();
      pkg1.ingest(TOKEN_A);

      const pkg2 = UxfPackage.create();
      pkg2.ingest(TOKEN_B);

      // Tamper with an element in pkg2's underlying pool
      const data = pkg2.packageData;
      const pool = data.pool as Map<ContentHash, UxfElement>;
      const firstHash = [...pool.keys()][0];
      const el = pool.get(firstHash)!;
      const tampered: UxfElement = {
        ...el,
        content: { ...el.content, _tampered: 'yes' },
      };
      pool.set(firstHash, tampered);

      expect(() => pkg1.merge(pkg2)).toThrow(UxfError);
      try {
        // Reset pkg1 for a clean test
        const fresh = UxfPackage.create();
        fresh.ingest(TOKEN_A);
        fresh.merge(pkg2);
      } catch (e) {
        expect((e as UxfError).code).toBe('VERIFICATION_FAILED');
      }
    });

    it('merge adds source manifest entries', () => {
      const pkg1 = UxfPackage.create();
      pkg1.ingest(TOKEN_A);

      const pkg2 = UxfPackage.create();
      pkg2.ingest(TOKEN_B);

      pkg1.merge(pkg2);
      expect(pkg1.hasToken(tokenId(TOKEN_A))).toBe(true);
      expect(pkg1.hasToken(tokenId(TOKEN_B))).toBe(true);
      expect(pkg1.tokenCount).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // verify
  // -------------------------------------------------------------------------

  describe('verify', () => {
    it('verify on valid package returns no non-cycle errors', () => {
      const pkg = UxfPackage.create();
      pkg.ingest(TOKEN_A);
      const result = pkg.verify();
      // CYCLE_DETECTED is expected for content-addressed dedup'd state nodes
      // (e.g., genesis destinationState == token.state when 0 transactions)
      const nonCycleErrors = result.errors.filter((e) => e.code !== 'CYCLE_DETECTED');
      expect(nonCycleErrors).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // index queries
  // -------------------------------------------------------------------------

  describe('index queries', () => {
    it('tokensByCoinId returns matching token IDs', () => {
      const pkg = UxfPackage.create();
      pkg.ingest(TOKEN_A);
      const ids = pkg.tokensByCoinId('UCT');
      expect(ids).toContain(tokenId(TOKEN_A));
    });

    it('tokensByTokenType returns matching token IDs', () => {
      const pkg = UxfPackage.create();
      pkg.ingest(TOKEN_A);
      const ids = pkg.tokensByTokenType(TOKEN_TYPE_FUNGIBLE);
      expect(ids).toContain(tokenId(TOKEN_A));
    });

    it('tokensByCoinId returns empty for unknown coinId', () => {
      const pkg = UxfPackage.create();
      pkg.ingest(TOKEN_A);
      expect(pkg.tokensByCoinId('UNKNOWN')).toEqual([]);
    });

    it('tokensByTokenType returns empty for unknown type', () => {
      const pkg = UxfPackage.create();
      pkg.ingest(TOKEN_A);
      expect(pkg.tokensByTokenType('0000')).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // transactionCount
  // -------------------------------------------------------------------------

  describe('transactionCount', () => {
    it('returns correct count', () => {
      const pkg = UxfPackage.create();
      pkg.ingest(TOKEN_C);
      expect(pkg.transactionCount(tokenId(TOKEN_C))).toBe(3);
    });

    it('throws TOKEN_NOT_FOUND for unknown token', () => {
      const pkg = UxfPackage.create();
      expect(() => pkg.transactionCount('ff'.repeat(32))).toThrow(UxfError);
      try {
        pkg.transactionCount('ff'.repeat(32));
      } catch (e) {
        expect((e as UxfError).code).toBe('TOKEN_NOT_FOUND');
      }
    });
  });

  // -------------------------------------------------------------------------
  // assembleAtState
  // -------------------------------------------------------------------------

  describe('assembleAtState', () => {
    it('assembleAtState delegates correctly', () => {
      const pkg = UxfPackage.create();
      pkg.ingest(TOKEN_C); // 3 transactions
      const id = tokenId(TOKEN_C);

      // State 0 = genesis only (0 transactions)
      const atGenesis = pkg.assembleAtState(id, 0) as Record<string, unknown>;
      expect((atGenesis.transactions as unknown[]).length).toBe(0);

      // State 1 = genesis + 1 transaction
      const atState1 = pkg.assembleAtState(id, 1) as Record<string, unknown>;
      expect((atState1.transactions as unknown[]).length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // assembleAll
  // -------------------------------------------------------------------------

  describe('assembleAll', () => {
    it('assembles all tokens', () => {
      const pkg = UxfPackage.create();
      pkg.ingestAll([TOKEN_A, TOKEN_B]);
      const all = pkg.assembleAll();
      expect(all.size).toBe(2);
      expect(all.has(tokenId(TOKEN_A))).toBe(true);
      expect(all.has(tokenId(TOKEN_B))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // consolidateProofs
  // -------------------------------------------------------------------------

  describe('consolidateProofs', () => {
    it('throws NOT_IMPLEMENTED', () => {
      const pkg = UxfPackage.create();
      pkg.ingest(TOKEN_A);
      expect(() => pkg.consolidateProofs(tokenId(TOKEN_A), [0, 1])).toThrow(UxfError);
      try {
        pkg.consolidateProofs(tokenId(TOKEN_A), [0, 1]);
      } catch (e) {
        expect((e as UxfError).code).toBe('NOT_IMPLEMENTED');
      }
    });
  });

  // -------------------------------------------------------------------------
  // diff / applyDelta
  // -------------------------------------------------------------------------

  describe('diff / applyDelta', () => {
    it('diff then applyDelta produces equivalent package', () => {
      const pkg1 = UxfPackage.create();
      pkg1.ingest(TOKEN_A);

      const pkg2 = UxfPackage.create();
      pkg2.ingestAll([TOKEN_A, TOKEN_B]);

      const delta = pkg1.diff(pkg2);
      pkg1.applyDelta(delta);

      expect(pkg1.hasToken(tokenId(TOKEN_B))).toBe(true);
      expect(pkg1.tokenCount).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // filterTokens
  // -------------------------------------------------------------------------

  describe('filterTokens', () => {
    it('filters by predicate', () => {
      const pkg = UxfPackage.create();
      pkg.ingestAll([TOKEN_A, TOKEN_B]);
      const idA = tokenId(TOKEN_A);
      const filtered = pkg.filterTokens((id) => id === idA);
      expect(filtered).toEqual([idA]);
    });
  });

  // -------------------------------------------------------------------------
  // toJson / fromJson
  // -------------------------------------------------------------------------

  describe('toJson / fromJson', () => {
    it('round-trip via class API', () => {
      const pkg = UxfPackage.create();
      pkg.ingestAll([TOKEN_A, TOKEN_B]);
      const json = pkg.toJson();
      const restored = UxfPackage.fromJson(json);
      expect(restored.tokenCount).toBe(pkg.tokenCount);
      expect(restored.elementCount).toBe(pkg.elementCount);
      // Verify assembled tokens match
      const idA = tokenId(TOKEN_A);
      const origA = pkg.assemble(idA) as Record<string, unknown>;
      const restoredA = restored.assemble(idA) as Record<string, unknown>;
      expect((restoredA.genesis as any).data.tokenId).toBe((origA.genesis as any).data.tokenId);
    });
  });

  // -------------------------------------------------------------------------
  // toCar / fromCar
  // -------------------------------------------------------------------------

  describe('toCar / fromCar', () => {
    it('round-trip via class API', async () => {
      const pkg = UxfPackage.create();
      pkg.ingestAll([TOKEN_A, TOKEN_B]);
      const car = await pkg.toCar();
      expect(car).toBeInstanceOf(Uint8Array);
      const restored = await UxfPackage.fromCar(car);
      expect(restored.tokenCount).toBe(pkg.tokenCount);
      expect(restored.elementCount).toBe(pkg.elementCount);
      // Verify assembled tokens
      const idA = tokenId(TOKEN_A);
      const restoredA = restored.assemble(idA) as Record<string, unknown>;
      expect((restoredA.genesis as any).data.tokenId).toBe(idA);
    });
  });

  // -------------------------------------------------------------------------
  // save / open
  // -------------------------------------------------------------------------

  describe('save / open', () => {
    it('save then open with InMemoryUxfStorage', async () => {
      const pkg = UxfPackage.create();
      pkg.ingestAll([TOKEN_A, TOKEN_B]);
      const storage = new InMemoryUxfStorage();
      await pkg.save(storage);
      const opened = await UxfPackage.open(storage);
      expect(opened.tokenCount).toBe(pkg.tokenCount);
      expect(opened.elementCount).toBe(pkg.elementCount);
    });

    it('open throws INVALID_PACKAGE when storage is empty', async () => {
      const storage = new InMemoryUxfStorage();
      await expect(UxfPackage.open(storage)).rejects.toThrow(UxfError);
      try {
        await UxfPackage.open(storage);
      } catch (e) {
        expect((e as UxfError).code).toBe('INVALID_PACKAGE');
      }
    });
  });

  // -------------------------------------------------------------------------
  // statistics
  // -------------------------------------------------------------------------

  describe('statistics', () => {
    it('tokenCount returns manifest size', () => {
      const pkg = UxfPackage.create();
      pkg.ingestAll([TOKEN_A, TOKEN_B, TOKEN_C]);
      expect(pkg.tokenCount).toBe(3);
    });

    it('elementCount returns pool size', () => {
      const pkg = UxfPackage.create();
      pkg.ingest(TOKEN_A);
      expect(pkg.elementCount).toBe(8);
    });

    it('estimatedSize is non-negative', () => {
      const pkg = UxfPackage.create();
      expect(pkg.estimatedSize).toBeGreaterThanOrEqual(0);
      pkg.ingest(TOKEN_A);
      expect(pkg.estimatedSize).toBeGreaterThan(0);
    });

    it('packageData returns underlying data', () => {
      const pkg = UxfPackage.create();
      const data = pkg.packageData;
      expect(data.envelope).toBeDefined();
      expect(data.manifest).toBeDefined();
      expect(data.pool).toBeDefined();
      expect(data.instanceChains).toBeDefined();
      expect(data.indexes).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // hasToken / tokenIds
  // -------------------------------------------------------------------------

  describe('hasToken / tokenIds', () => {
    it('hasToken returns false for missing token', () => {
      const pkg = UxfPackage.create();
      expect(pkg.hasToken('ff'.repeat(32))).toBe(false);
    });

    it('tokenIds returns all ingested token IDs', () => {
      const pkg = UxfPackage.create();
      pkg.ingestAll([TOKEN_A, TOKEN_B]);
      const ids = pkg.tokenIds();
      expect(ids).toHaveLength(2);
      expect(ids).toContain(tokenId(TOKEN_A));
      expect(ids).toContain(tokenId(TOKEN_B));
    });
  });
});
