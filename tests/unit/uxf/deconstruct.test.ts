/**
 * Tests for UXF token deconstruction (WU-06).
 *
 * Validates element decomposition, deduplication, nametag recursion,
 * state derivation, hex normalization, null handling, special fields,
 * and pre-validation rejection.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ElementPool } from '../../../uxf/element-pool.js';
import { deconstructToken } from '../../../uxf/deconstruct.js';
import { UxfError } from '../../../uxf/errors.js';
import type { ContentHash, UxfElement, TokenRootChildren, GenesisChildren, TransactionChildren } from '../../../uxf/types.js';
import {
  TOKEN_A,
  TOKEN_B,
  TOKEN_C,
  TOKEN_D,
  TOKEN_E,
  TOKEN_F,
  ALL_TOKENS,
  EXPECTED_POOL_SIZE_ALL,
  EXPECTED_POOL_SIZE_INCREMENTAL,
  EDGE_PLACEHOLDER,
  EDGE_PENDING_FINALIZATION,
  EDGE_NULL_PROOF,
  NAMETAG_ALICE,
  PREDICATE_A,
  PREDICATE_B,
} from '../../fixtures/uxf-mock-tokens.js';

describe('deconstructToken', () => {
  let pool: ElementPool;

  beforeEach(() => {
    pool = new ElementPool();
  });

  // -----------------------------------------------------------------------
  // Element count tests
  // -----------------------------------------------------------------------

  describe('element counts', () => {
    it('Token A (0 tx): pool has 8 elements after deconstruction', () => {
      deconstructToken(pool, TOKEN_A);
      expect(pool.size).toBe(8);
    });

    it('Token B (1 tx): pool has 15 elements', () => {
      deconstructToken(pool, TOKEN_B);
      expect(pool.size).toBe(15);
    });

    it('Token C (3 tx): pool has 29 elements', () => {
      deconstructToken(pool, TOKEN_C);
      expect(pool.size).toBe(29);
    });
  });

  // -----------------------------------------------------------------------
  // Deduplication tests
  // -----------------------------------------------------------------------

  describe('deduplication', () => {
    it('ingest A then B -> pool size 22 (shared PREDICATE_A state)', () => {
      deconstructToken(pool, TOKEN_A);
      expect(pool.size).toBe(8);
      deconstructToken(pool, TOKEN_B);
      expect(pool.size).toBe(22);
    });

    it('ingest A, B, C -> pool size 48 (shared states + SHARED_CERT)', () => {
      deconstructToken(pool, TOKEN_A);
      deconstructToken(pool, TOKEN_B);
      deconstructToken(pool, TOKEN_C);
      expect(pool.size).toBe(48);
    });

    it('full dedup: ingest all 6 tokens -> pool size 87', () => {
      for (const token of ALL_TOKENS) {
        deconstructToken(pool, token);
      }
      expect(pool.size).toBe(EXPECTED_POOL_SIZE_ALL);
    });

    it('incremental sizes match EXPECTED_POOL_SIZE_INCREMENTAL', () => {
      for (let i = 0; i < ALL_TOKENS.length; i++) {
        deconstructToken(pool, ALL_TOKENS[i]);
        expect(pool.size).toBe(EXPECTED_POOL_SIZE_INCREMENTAL[i]);
      }
    });

    it('idempotent: deconstruct same token twice -> pool size unchanged', () => {
      deconstructToken(pool, TOKEN_A);
      const sizeAfterFirst = pool.size;
      deconstructToken(pool, TOKEN_A);
      expect(pool.size).toBe(sizeAfterFirst);
    });
  });

  // -----------------------------------------------------------------------
  // Nametag handling
  // -----------------------------------------------------------------------

  describe('nametag handling', () => {
    it('Token D produces 16 elements (8 own + 8 nametag)', () => {
      deconstructToken(pool, TOKEN_D);
      expect(pool.size).toBe(16);
    });

    it('string nametags silently skipped', () => {
      const tokenWithStringNametags = {
        ...TOKEN_A,
        nametags: ['alice', 'bob'],
      };
      deconstructToken(pool, tokenWithStringNametags);
      // Same count as TOKEN_A (8) -- string nametags produce no extra elements
      expect(pool.size).toBe(8);

      // Verify token-root's nametags children array is empty
      const rootHash = deconstructToken(pool, tokenWithStringNametags);
      const rootEl = pool.get(rootHash)!;
      const rootChildren = rootEl.children as unknown as TokenRootChildren;
      expect(rootChildren.nametags).toEqual([]);
    });

    it('nametag in transfer data: Token E has nametagRefs in transaction-data', () => {
      deconstructToken(pool, TOKEN_E);
      // Token E alone: 23 elements (15 own + 8 nametag)
      expect(pool.size).toBe(23);
    });
  });

  // -----------------------------------------------------------------------
  // State derivation
  // -----------------------------------------------------------------------

  describe('state derivation', () => {
    it('genesis destinationState derived correctly (0 tx case: equals token.state)', () => {
      const rootHash = deconstructToken(pool, TOKEN_A);
      const rootEl = pool.get(rootHash)!;
      const rootChildren = rootEl.children as unknown as TokenRootChildren;

      // Genesis destination state and current state should be the same element
      const genesisEl = pool.get(rootChildren.genesis)!;
      const genesisChildren = genesisEl.children as unknown as GenesisChildren;

      expect(genesisChildren.destinationState).toBe(rootChildren.state);
    });

    it('genesis destinationState derived correctly (1+ tx case: equals tx[0].data.sourceState)', () => {
      const rootHash = deconstructToken(pool, TOKEN_B);
      const rootEl = pool.get(rootHash)!;
      const rootChildren = rootEl.children as unknown as TokenRootChildren;

      const genesisEl = pool.get(rootChildren.genesis)!;
      const genesisChildren = genesisEl.children as unknown as GenesisChildren;

      const tx0El = pool.get(rootChildren.transactions[0])!;
      const tx0Children = tx0El.children as unknown as TransactionChildren;

      // Genesis destination state = tx[0] source state
      expect(genesisChildren.destinationState).toBe(tx0Children.sourceState);
    });
  });

  // -----------------------------------------------------------------------
  // Hex normalization
  // -----------------------------------------------------------------------

  describe('hex normalization', () => {
    it('construct token with UPPERCASE hex tokenId -> element stores lowercase', () => {
      const upperToken = JSON.parse(JSON.stringify(TOKEN_A));
      // Uppercase the tokenId
      upperToken.genesis.data.tokenId =
        'AA00000000000000000000000000000000000000000000000000000000000001';

      const rootHash = deconstructToken(pool, upperToken);
      const rootEl = pool.get(rootHash)!;
      expect((rootEl.content as Record<string, unknown>).tokenId).toBe(
        'aa00000000000000000000000000000000000000000000000000000000000001',
      );
    });
  });

  // -----------------------------------------------------------------------
  // Null handling
  // -----------------------------------------------------------------------

  describe('null handling', () => {
    it('null state.data preserved as null', () => {
      const rootHash = deconstructToken(pool, TOKEN_A);
      const rootEl = pool.get(rootHash)!;
      const rootChildren = rootEl.children as unknown as TokenRootChildren;
      const stateEl = pool.get(rootChildren.state)!;
      expect((stateEl.content as Record<string, unknown>).data).toBeNull();
    });

    it('null SmtPath step.data preserved as null', () => {
      // Token A has a step with data: null at index 2
      const rootHash = deconstructToken(pool, TOKEN_A);
      const rootEl = pool.get(rootHash)!;
      const rootChildren = rootEl.children as unknown as TokenRootChildren;
      const genesisEl = pool.get(rootChildren.genesis)!;
      const genesisChildren = genesisEl.children as unknown as GenesisChildren;
      const ipEl = pool.get(genesisChildren.inclusionProof)!;
      const ipChildren = ipEl.children as Record<string, ContentHash>;
      const smtEl = pool.get(ipChildren.merkleTreePath)!;
      const segments = (smtEl.content as Record<string, unknown>).segments as Array<{
        data: string | null;
        path: string;
      }>;
      // The third step has data: null
      expect(segments[2].data).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Special fields
  // -----------------------------------------------------------------------

  describe('special fields', () => {
    it('SmtPath path stored as string (not hex-decoded)', () => {
      const rootHash = deconstructToken(pool, TOKEN_A);
      const rootEl = pool.get(rootHash)!;
      const rootChildren = rootEl.children as unknown as TokenRootChildren;
      const genesisEl = pool.get(rootChildren.genesis)!;
      const genesisChildren = genesisEl.children as unknown as GenesisChildren;
      const ipEl = pool.get(genesisChildren.inclusionProof)!;
      const ipChildren = ipEl.children as Record<string, ContentHash>;
      const smtEl = pool.get(ipChildren.merkleTreePath)!;
      const segments = (smtEl.content as Record<string, unknown>).segments as Array<{
        data: string | null;
        path: string;
      }>;
      // The third step has the large decimal bigint string
      expect(segments[2].path).toBe('9999999999999999999');
      expect(typeof segments[2].path).toBe('string');
    });

    it('UnicityCertificate stored opaquely (raw field)', () => {
      const rootHash = deconstructToken(pool, TOKEN_A);
      const rootEl = pool.get(rootHash)!;
      const rootChildren = rootEl.children as unknown as TokenRootChildren;
      const genesisEl = pool.get(rootChildren.genesis)!;
      const genesisChildren = genesisEl.children as unknown as GenesisChildren;
      const ipEl = pool.get(genesisChildren.inclusionProof)!;
      const ipChildren = ipEl.children as Record<string, ContentHash>;
      const certEl = pool.get(ipChildren.unicityCertificate)!;
      expect(certEl.type).toBe('unicity-certificate');
      expect((certEl.content as Record<string, unknown>).raw).toBeDefined();
      expect(typeof (certEl.content as Record<string, unknown>).raw).toBe('string');
    });

    it('split token reason (Token F): reason stored as Uint8Array', () => {
      const rootHash = deconstructToken(pool, TOKEN_F);
      const rootEl = pool.get(rootHash)!;
      const rootChildren = rootEl.children as unknown as TokenRootChildren;
      const genesisEl = pool.get(rootChildren.genesis)!;
      const genesisChildren = genesisEl.children as unknown as GenesisChildren;
      const gdEl = pool.get(genesisChildren.data)!;
      const reason = (gdEl.content as Record<string, unknown>).reason;
      expect(reason).toBeInstanceOf(Uint8Array);
    });
  });

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  describe('validation', () => {
    it('placeholder rejected with INVALID_PACKAGE', () => {
      expect(() => deconstructToken(pool, EDGE_PLACEHOLDER)).toThrow(UxfError);
      try {
        deconstructToken(pool, EDGE_PLACEHOLDER);
      } catch (e) {
        expect((e as UxfError).code).toBe('INVALID_PACKAGE');
      }
    });

    it('pendingFinalization rejected with INVALID_PACKAGE', () => {
      expect(() => deconstructToken(pool, EDGE_PENDING_FINALIZATION)).toThrow(UxfError);
      try {
        deconstructToken(pool, EDGE_PENDING_FINALIZATION);
      } catch (e) {
        expect((e as UxfError).code).toBe('INVALID_PACKAGE');
      }
    });

    it('missing genesis rejected with INVALID_PACKAGE', () => {
      const noGenesis = { version: '2.0', state: { predicate: 'aa'.repeat(32), data: null }, transactions: [], nametags: [] };
      expect(() => deconstructToken(pool, noGenesis)).toThrow(UxfError);
      try {
        deconstructToken(pool, noGenesis);
      } catch (e) {
        expect((e as UxfError).code).toBe('INVALID_PACKAGE');
      }
    });

    it('null inclusionProof -> null child ref in transaction', () => {
      const rootHash = deconstructToken(pool, EDGE_NULL_PROOF);
      const rootEl = pool.get(rootHash)!;
      const rootChildren = rootEl.children as unknown as TokenRootChildren;
      const txEl = pool.get(rootChildren.transactions[0])!;
      const txChildren = txEl.children as unknown as TransactionChildren;
      expect(txChildren.inclusionProof).toBeNull();
    });
  });
});
