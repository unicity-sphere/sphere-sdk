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
import { UxfPackage } from '../../../extensions/uxf/bundle/UxfPackage.js';
import { InMemoryUxfStorage } from '../../../extensions/uxf/bundle/storage-adapters.js';
import { UxfError } from '../../../extensions/uxf/bundle/errors.js';
import { STRATEGY_ORIGINAL } from '../../../extensions/uxf/bundle/types.js';
import type { UxfElement, ContentHash } from '../../../extensions/uxf/bundle/types.js';
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

    // Steelman³¹ regression coverage: ingestAll must populate the
    // secondary indexes (byCoinId, byTokenType, byStateHash) the same
    // as per-token ingest does. F.35's first attempt called
    // updateIndexesForToken BEFORE syncPool, so the indexes silently
    // remained empty after batch ingest.
    it('ingestAll populates secondary indexes equivalently to per-token ingest', () => {
      const pkgBatch = UxfPackage.create();
      pkgBatch.ingestAll([TOKEN_A, TOKEN_B]);
      const pkgSeq = UxfPackage.create();
      pkgSeq.ingest(TOKEN_A);
      pkgSeq.ingest(TOKEN_B);
      // Same coin-id index population.
      const idsBatch = pkgBatch.tokensByCoinId('UCT').sort();
      const idsSeq = pkgSeq.tokensByCoinId('UCT').sort();
      expect(idsBatch).toEqual(idsSeq);
      expect(idsBatch.length).toBeGreaterThan(0);
      // Same token-type index population.
      const typesBatch = pkgBatch.tokensByTokenType(TOKEN_TYPE_FUNGIBLE).sort();
      const typesSeq = pkgSeq.tokensByTokenType(TOKEN_TYPE_FUNGIBLE).sort();
      expect(typesBatch).toEqual(typesSeq);
      expect(typesBatch.length).toBeGreaterThan(0);
      // Steelman³²: also pin byStateHash equivalence via the toJson
      // round-trip (the indexes serialize through there). A future
      // regression that broke byStateHash would diverge between batch
      // and per-token paths. We don't assert > 0 here because the
      // test fixture tokens may not produce a state hash; the
      // equivalence check is the load-bearing invariant.
      const jsonBatch = pkgBatch.toJson();
      const jsonSeq = pkgSeq.toJson();
      const idxBatch = JSON.parse(jsonBatch).indexes;
      const idxSeq = JSON.parse(jsonSeq).indexes;
      expect(idxBatch.byStateHash).toEqual(idxSeq.byStateHash);
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
    it('verify on valid package returns valid=true with no errors', () => {
      const pkg = UxfPackage.create();
      pkg.ingest(TOKEN_A);
      const result = pkg.verify();
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
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

  // -------------------------------------------------------------------------
  // Steelman Wave 3 — fromCar per-block caps (count + bytes)
  // -------------------------------------------------------------------------
  describe('fromCar — bloat-DoS caps', () => {
    /**
     * Build a hostile CAR with a real (parseable) envelope + manifest
     * pair, then flood with `extraTiny` tiny non-element blocks AND/OR
     * with one oversized block. The envelope/manifest are required so
     * importFromCar's preamble succeeds and we reach the for-await
     * loop where the per-block caps fire.
     */
    async function buildHostileCar(opts: {
      extraTinyCount?: number;
      injectOversized?: boolean;
    }): Promise<Uint8Array> {
      const { CarWriter } = await import('@ipld/car/writer');
      const { CID } = await import('multiformats');
      const { encode: dagCborEncode } = await import('@ipld/dag-cbor');
      const { sha256 } = await import('@noble/hashes/sha2.js');

      const cidFromBytes = (bytes: Uint8Array): CID => {
        const hash = sha256(bytes);
        const digestBytes = new Uint8Array(2 + hash.length);
        digestBytes[0] = 0x12;
        digestBytes[1] = hash.length;
        digestBytes.set(hash, 2);
        return CID.createV1(0x71, {
          code: 0x12,
          size: hash.length,
          digest: hash,
          bytes: digestBytes,
        } as never);
      };

      // Build a minimal valid manifest block (no tokens — empty
      // manifest is fine, importFromCar reaches the blocks() loop
      // regardless).
      const manifestNode = { tokens: {} as Record<string, CID> };
      const manifestBytes = dagCborEncode(manifestNode);
      const manifestCid = cidFromBytes(manifestBytes);

      // Build a minimal valid envelope referencing the manifest CID.
      const envelopeNode = {
        version: '1.0.0',
        createdAt: 1700000000,
        updatedAt: 1700000001,
        manifest: manifestCid,
      };
      const envelopeBytes = dagCborEncode(envelopeNode);
      const envelopeCid = cidFromBytes(envelopeBytes);

      const { writer, out } = CarWriter.create([envelopeCid]);
      const chunks: Uint8Array[] = [];
      const collectPromise = (async () => {
        for await (const chunk of out) chunks.push(chunk);
      })();
      await writer.put({ cid: envelopeCid, bytes: envelopeBytes });
      await writer.put({ cid: manifestCid, bytes: manifestBytes });

      if (opts.injectOversized) {
        // 128 KiB block — well above CAR_IMPORT_MAX_BLOCK_BYTES (64 KiB).
        const oversized = new Uint8Array(128 * 1024);
        for (let i = 0; i < oversized.length; i++) oversized[i] = i & 0xff;
        const blockBytes = dagCborEncode({ blob: oversized });
        const blockCid = cidFromBytes(blockBytes);
        await writer.put({ cid: blockCid, bytes: blockBytes });
      }

      const N = opts.extraTinyCount ?? 0;
      if (N > 0) {
        // Emit distinct VALID UXF token-state elements via the real
        // encoder so each block (a) decodes via `decodeIpldElement`,
        // (b) hash-verifies vs its CID, and (c) is structurally
        // non-malformed. Without this the loop body would throw
        // SERIALIZATION_ERROR on the first garbage block long before
        // reaching the count cap.
        const { elementToIpldBlock } = await import('../../../extensions/uxf/bundle/ipld.js');
        for (let i = 0; i < N; i++) {
          // Unique 64-char hex per element so each maps to a distinct CID.
          const counter = i.toString(16).padStart(8, '0');
          const predicateHex = (counter + '00'.repeat(28)).slice(0, 64);
          const el: UxfElement = {
            header: {
              representation: 1,
              semantics: 1,
              kind: 'default',
              predecessor: null,
            },
            type: 'token-state',
            content: { predicate: predicateHex, data: null },
            children: {},
          };
          const block = elementToIpldBlock(el);
          await writer.put({ cid: block.cid, bytes: block.bytes });
        }
      }
      await writer.close();
      await collectPromise;

      let total = 0;
      for (const c of chunks) total += c.byteLength;
      const carBytes = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        carBytes.set(c, off);
        off += c.byteLength;
      }
      return carBytes;
    }

    it('rejects a CAR whose block count exceeds CAR_IMPORT_MAX_BLOCK_COUNT', async () => {
      // 10_005 extra tiny blocks + envelope + manifest = 10_007 total —
      // exceeds CAR_IMPORT_MAX_BLOCK_COUNT (10_000).
      const carBytes = await buildHostileCar({ extraTinyCount: 10_005 });

      await expect(UxfPackage.fromCar(carBytes)).rejects.toThrow(UxfError);
      try {
        await UxfPackage.fromCar(carBytes);
      } catch (e) {
        expect((e as UxfError).code).toBe('INVALID_PACKAGE');
        expect((e as UxfError).message).toContain('CAR_IMPORT_MAX_BLOCK_COUNT');
      }
    }, 30_000);

    it('rejects a CAR whose single block exceeds CAR_IMPORT_MAX_BLOCK_BYTES', async () => {
      const carBytes = await buildHostileCar({ injectOversized: true });

      await expect(UxfPackage.fromCar(carBytes)).rejects.toThrow(UxfError);
      try {
        await UxfPackage.fromCar(carBytes);
      } catch (e) {
        expect((e as UxfError).code).toBe('INVALID_PACKAGE');
        expect((e as UxfError).message).toContain('CAR_IMPORT_MAX_BLOCK_BYTES');
      }
    });
  });
});
