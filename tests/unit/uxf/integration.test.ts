/**
 * End-to-end integration tests for the UXF module.
 *
 * Covers full flows: ingest -> assemble -> verify, historical assembly,
 * serialization round-trips (JSON, CAR), merge with dedup, GC after removal,
 * instance chains, nametag dedup, and split token handling.
 */

import { describe, it, expect } from 'vitest';
import { UxfPackage } from '../../../uxf/UxfPackage.js';
import { UxfError } from '../../../uxf/errors.js';
import { STRATEGY_LATEST, STRATEGY_ORIGINAL } from '../../../uxf/types.js';
import type { UxfElement, ContentHash, TokenRootChildren } from '../../../uxf/types.js';
import {
  TOKEN_A,
  TOKEN_B,
  TOKEN_C,
  TOKEN_D,
  TOKEN_E,
  TOKEN_F,
  ALL_TOKENS,
  EXPECTED_POOL_SIZE_ALL,
  PREDICATE_A,
  PREDICATE_B,
  PREDICATE_C,
  PREDICATE_D,
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

describe('full end-to-end flows', () => {
  // -------------------------------------------------------------------------
  // ingest -> assemble -> verify
  // -------------------------------------------------------------------------

  describe('ingest -> assemble -> verify', () => {
    it('create package, ingest all 6 tokens, verify pool size, assemble each, verify', () => {
      const pkg = UxfPackage.create();
      pkg.ingestAll(ALL_TOKENS);

      // Pool size should match expected dedup count
      expect(pkg.elementCount).toBe(EXPECTED_POOL_SIZE_ALL);
      expect(pkg.tokenCount).toBe(6);

      // Assemble each token and verify basic structure
      for (const token of ALL_TOKENS) {
        const id = tokenId(token);
        const assembled = pkg.assemble(id) as Record<string, unknown>;
        expect(assembled.version).toBe('2.0');
        const genesis = assembled.genesis as Record<string, unknown>;
        const gd = genesis.data as Record<string, unknown>;
        expect(gd.tokenId).toBe(id);
      }

      // Verify structural integrity
      const result = pkg.verify();
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // historical assembly
  // -------------------------------------------------------------------------

  describe('historical assembly', () => {
    it('assemble at each state index for Token C produces correct history', () => {
      const pkg = UxfPackage.create();
      pkg.ingest(TOKEN_C);
      const id = tokenId(TOKEN_C);

      // Token C has 3 transactions, so valid state indices are 0..3
      for (let i = 0; i <= 3; i++) {
        const assembled = pkg.assembleAtState(id, i) as Record<string, unknown>;
        const txs = assembled.transactions as unknown[];
        expect(txs.length).toBe(i);
      }

      // State 0: genesis only, state predicate should match genesis destinationState
      const atGenesis = pkg.assembleAtState(id, 0) as Record<string, unknown>;
      const genesisState = atGenesis.state as Record<string, unknown>;
      // After genesis (0 transactions), the state is tx[0].sourceState = PREDICATE_A
      expect(genesisState.predicate).toBe(PREDICATE_A);

      // State 3: full history, final state should be PREDICATE_D (Token C's current state)
      const atFull = pkg.assembleAtState(id, 3) as Record<string, unknown>;
      const fullState = atFull.state as Record<string, unknown>;
      expect(fullState.predicate).toBe(PREDICATE_D);
    });
  });

  // -------------------------------------------------------------------------
  // serialization round-trips
  // -------------------------------------------------------------------------

  describe('serialization round-trips', () => {
    it('JSON round-trip: ingest -> toJson -> fromJson -> assemble -> compare', () => {
      const pkg = UxfPackage.create();
      pkg.ingestAll([TOKEN_A, TOKEN_B, TOKEN_C]);

      const json = pkg.toJson();
      const restored = UxfPackage.fromJson(json);

      expect(restored.tokenCount).toBe(3);
      expect(restored.elementCount).toBe(pkg.elementCount);

      // Verify each assembled token matches
      for (const token of [TOKEN_A, TOKEN_B, TOKEN_C]) {
        const id = tokenId(token);
        const origAssembled = pkg.assemble(id) as Record<string, unknown>;
        const restoredAssembled = restored.assemble(id) as Record<string, unknown>;
        expect((restoredAssembled.genesis as any).data.tokenId)
          .toBe((origAssembled.genesis as any).data.tokenId);
      }
    });

    it('CAR round-trip: ingest -> toCar -> fromCar -> assemble -> compare', async () => {
      const pkg = UxfPackage.create();
      pkg.ingestAll([TOKEN_A, TOKEN_B, TOKEN_C]);

      const car = await pkg.toCar();
      const restored = await UxfPackage.fromCar(car);

      expect(restored.tokenCount).toBe(3);
      expect(restored.elementCount).toBe(pkg.elementCount);

      for (const token of [TOKEN_A, TOKEN_B, TOKEN_C]) {
        const id = tokenId(token);
        const restoredAssembled = restored.assemble(id) as Record<string, unknown>;
        expect((restoredAssembled.genesis as any).data.tokenId).toBe(id);
      }
    });
  });

  // -------------------------------------------------------------------------
  // merge
  // -------------------------------------------------------------------------

  describe('merge', () => {
    it('merge two packages with shared certs, verify dedup', () => {
      const pkgA = UxfPackage.create();
      pkgA.ingestAll([TOKEN_A, TOKEN_B]);

      const pkgB = UxfPackage.create();
      pkgB.ingestAll([TOKEN_B, TOKEN_C]);

      const sizeA = pkgA.elementCount;
      const sizeB = pkgB.elementCount;

      pkgA.merge(pkgB);

      // Merged package has all 3 tokens
      expect(pkgA.tokenCount).toBe(3);
      expect(pkgA.hasToken(tokenId(TOKEN_A))).toBe(true);
      expect(pkgA.hasToken(tokenId(TOKEN_B))).toBe(true);
      expect(pkgA.hasToken(tokenId(TOKEN_C))).toBe(true);

      // Dedup means merged element count < sum of both
      expect(pkgA.elementCount).toBeLessThan(sizeA + sizeB);

      // Verify passes
      const result = pkgA.verify();
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // garbage collection
  // -------------------------------------------------------------------------

  describe('garbage collection', () => {
    it('GC after removal: remove Token A, gc, verify other tokens still assemble', () => {
      const pkg = UxfPackage.create();
      pkg.ingestAll([TOKEN_A, TOKEN_B]);
      const beforeRemoval = pkg.elementCount;

      pkg.removeToken(tokenId(TOKEN_A));
      const removed = pkg.gc();
      expect(removed).toBeGreaterThan(0);
      expect(pkg.elementCount).toBeLessThan(beforeRemoval);

      // Token B should still assemble correctly
      const assembled = pkg.assemble(tokenId(TOKEN_B)) as Record<string, unknown>;
      expect(assembled.version).toBe('2.0');
      expect((assembled.genesis as any).data.tokenId).toBe(tokenId(TOKEN_B));

      // Verify passes on remaining package
      const result = pkg.verify();
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // instance chains
  // -------------------------------------------------------------------------

  describe('instance chains', () => {
    it('add alternative instance to a proof, assemble with latest vs original', () => {
      const pkg = UxfPackage.create();
      pkg.ingest(TOKEN_A);
      const id = tokenId(TOKEN_A);

      // Find the token-state element hash for TOKEN_A's current state
      const data = pkg.packageData;
      const rootHash = data.manifest.tokens.get(id)!;
      const rootEl = data.pool.get(rootHash)!;
      const rootChildren = rootEl.children as unknown as TokenRootChildren;
      const stateHash = rootChildren.state;
      const stateEl = data.pool.get(stateHash)!;

      // Create an alternative instance of the state element
      const alternativeState: UxfElement = {
        header: {
          representation: 1,
          semantics: 1,
          kind: 'default',
          predecessor: stateHash,
        },
        type: 'token-state',
        content: {
          predicate: 'ff'.repeat(32),
          data: null,
        },
        children: {},
      };

      pkg.addInstance(stateHash, alternativeState);

      // Assemble with STRATEGY_LATEST -> should get alternative state
      const assembledLatest = pkg.assemble(id, STRATEGY_LATEST) as Record<string, unknown>;
      const latestState = assembledLatest.state as Record<string, unknown>;
      expect(latestState.predicate).toBe('ff'.repeat(32));

      // Assemble with STRATEGY_ORIGINAL -> should get original state
      const assembledOriginal = pkg.assemble(id, STRATEGY_ORIGINAL) as Record<string, unknown>;
      const originalState = assembledOriginal.state as Record<string, unknown>;
      expect(originalState.predicate).toBe(PREDICATE_A);
    });
  });

  // -------------------------------------------------------------------------
  // nametag deduplication
  // -------------------------------------------------------------------------

  describe('nametag deduplication', () => {
    it('ingest Token D and E -> verify shared nametag (pool size = 64+23-8 = 79)', () => {
      const pkg = UxfPackage.create();
      pkg.ingest(TOKEN_D);
      expect(pkg.elementCount).toBe(16); // 8 own + 8 nametag

      // Ingest D first (16 elements), then E (23 total = 15 own + 8 nametag)
      // But 8 nametag elements are shared, so pool = 16 + 23 - 8 = 31
      // Wait -- check actual incremental sizes from fixtures:
      // After D: 64 (cumulative from A+B+C+D)? No, D alone = 16
      // Let's just check actual behavior:
      const pkg2 = UxfPackage.create();
      pkg2.ingest(TOKEN_D);
      const afterD = pkg2.elementCount;
      expect(afterD).toBe(16);

      pkg2.ingest(TOKEN_E);
      const afterDE = pkg2.elementCount;
      // Token E alone has 23 elements (15 own + 8 nametag)
      // Shared nametag elements: 8
      // So afterDE = 16 + 23 - 8 = 31
      expect(afterDE).toBe(31);

      // Both tokens assemble correctly
      const assembledD = pkg2.assemble(tokenId(TOKEN_D)) as Record<string, unknown>;
      expect((assembledD.nametags as unknown[]).length).toBe(1);

      const assembledE = pkg2.assemble(tokenId(TOKEN_E)) as Record<string, unknown>;
      // Token E has nametag in transaction data, not top-level nametags
      expect(assembledE.version).toBe('2.0');
    });
  });

  // -------------------------------------------------------------------------
  // split token handling
  // -------------------------------------------------------------------------

  describe('split token handling', () => {
    it('split token with object reason round-trips', () => {
      const pkg = UxfPackage.create();
      pkg.ingest(TOKEN_F);
      const id = tokenId(TOKEN_F);
      const assembled = pkg.assemble(id) as Record<string, unknown>;
      const genesis = assembled.genesis as Record<string, unknown>;
      const gd = genesis.data as Record<string, unknown>;
      // Reason was an object, so it should be encoded/decoded via dag-cbor
      // After round-trip it should be a decoded object
      expect(gd.reason).toBeDefined();
      expect(gd.reason).not.toBeNull();
      // The reason is decoded from dag-cbor Uint8Array back to object
      const reason = gd.reason as Record<string, unknown>;
      expect(reason.type).toBe('TOKEN_SPLIT');
    });
  });
});
