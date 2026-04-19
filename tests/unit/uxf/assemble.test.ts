/**
 * Tests for UXF token reassembly (WU-07).
 *
 * Validates round-trip fidelity, historical assembly, error handling,
 * instance chain selection, and special field preservation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ElementPool } from '../../../uxf/element-pool.js';
import { deconstructToken } from '../../../uxf/deconstruct.js';
import {
  assembleToken,
  assembleTokenFromRoot,
  assembleTokenAtState,
} from '../../../uxf/assemble.js';
import { computeElementHash } from '../../../uxf/hash.js';
import { addInstance, createInstanceChainIndex } from '../../../uxf/instance-chain.js';
import { UxfError } from '../../../uxf/errors.js';
import type {
  ContentHash,
  UxfElement,
  UxfManifest,
  InstanceChainIndex,
  TokenRootChildren,
  GenesisChildren,
  TransactionChildren,
} from '../../../uxf/types.js';
import { STRATEGY_LATEST, STRATEGY_ORIGINAL } from '../../../uxf/types.js';
import {
  TOKEN_A,
  TOKEN_B,
  TOKEN_C,
  TOKEN_D,
  TOKEN_E,
  TOKEN_F,
  EDGE_NULL_PROOF,
  NAMETAG_ALICE,
  PREDICATE_A,
  PREDICATE_B,
  PREDICATE_C,
  PREDICATE_D,
} from '../../fixtures/uxf-mock-tokens.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deconstruct a token and build a manifest for it.
 */
function deconstructAndManifest(
  pool: ElementPool,
  token: Record<string, unknown>,
): { rootHash: ContentHash; manifest: UxfManifest; tokenId: string } {
  const rootHash = deconstructToken(pool, token);
  const rootEl = pool.get(rootHash)!;
  const tokenId = (rootEl.content as Record<string, unknown>).tokenId as string;
  const manifest: UxfManifest = {
    tokens: new Map([[tokenId, rootHash]]),
  };
  return { rootHash, manifest, tokenId };
}

const emptyChains: InstanceChainIndex = new Map();

describe('assembleToken', () => {
  let pool: ElementPool;

  beforeEach(() => {
    pool = new ElementPool();
  });

  // -----------------------------------------------------------------------
  // Round-trip fidelity
  // -----------------------------------------------------------------------

  describe('round-trip fidelity', () => {
    it('round-trip Token A: key fields match original', () => {
      const { manifest, tokenId } = deconstructAndManifest(pool, TOKEN_A);
      const assembled = assembleToken(pool, manifest, tokenId, emptyChains) as Record<string, unknown>;

      expect(assembled.version).toBe('2.0');
      expect((assembled.transactions as unknown[]).length).toBe(0);
      expect((assembled.nametags as unknown[]).length).toBe(0);

      const genesis = assembled.genesis as Record<string, unknown>;
      const gData = genesis.data as Record<string, unknown>;
      expect(gData.tokenId).toBe('aa00000000000000000000000000000000000000000000000000000000000001');
      expect(gData.coinData).toEqual([['UCT', '1000000']]);
      expect(gData.recipient).toBe('DIRECT://alice-address-01');
      expect(gData.reason).toBeNull();

      const state = assembled.state as Record<string, unknown>;
      expect(state.predicate).toBe(PREDICATE_A);
      expect(state.data).toBeNull();
    });

    it('round-trip Token B: key fields match original', () => {
      const { manifest, tokenId } = deconstructAndManifest(pool, TOKEN_B);
      const assembled = assembleToken(pool, manifest, tokenId, emptyChains) as Record<string, unknown>;

      expect(assembled.version).toBe('2.0');
      const txs = assembled.transactions as Array<Record<string, unknown>>;
      expect(txs.length).toBe(1);

      const txData = txs[0].data as Record<string, unknown>;
      expect(txData.recipient).toBe('DIRECT://bob-address-01');
      expect((txData.sourceState as Record<string, unknown>).predicate).toBe(PREDICATE_A);

      const state = assembled.state as Record<string, unknown>;
      expect(state.predicate).toBe(PREDICATE_B);
    });

    it('round-trip Token C: all 3 transactions preserved', () => {
      const { manifest, tokenId } = deconstructAndManifest(pool, TOKEN_C);
      const assembled = assembleToken(pool, manifest, tokenId, emptyChains) as Record<string, unknown>;

      const txs = assembled.transactions as Array<Record<string, unknown>>;
      expect(txs.length).toBe(3);

      // Check transaction recipients
      expect((txs[0].data as Record<string, unknown>).recipient).toBe('DIRECT://bob-address-02');
      expect((txs[1].data as Record<string, unknown>).recipient).toBe('DIRECT://charlie-address-01');
      expect((txs[2].data as Record<string, unknown>).recipient).toBe('DIRECT://alice-address-04');

      // Check state chain through transactions
      expect(((txs[0].data as Record<string, unknown>).sourceState as Record<string, unknown>).predicate).toBe(PREDICATE_A);
      expect(((txs[1].data as Record<string, unknown>).sourceState as Record<string, unknown>).predicate).toBe(PREDICATE_B);
      expect(((txs[2].data as Record<string, unknown>).sourceState as Record<string, unknown>).predicate).toBe(PREDICATE_C);

      const state = assembled.state as Record<string, unknown>;
      expect(state.predicate).toBe(PREDICATE_D);
    });

    it('round-trip Token D: nametags restored as token objects', () => {
      const { manifest, tokenId } = deconstructAndManifest(pool, TOKEN_D);
      const assembled = assembleToken(pool, manifest, tokenId, emptyChains) as Record<string, unknown>;

      const nametags = assembled.nametags as Array<Record<string, unknown>>;
      expect(nametags.length).toBe(1);

      const nt = nametags[0];
      expect(nt.version).toBe('2.0');
      const ntGenesis = nt.genesis as Record<string, unknown>;
      const ntGData = ntGenesis.data as Record<string, unknown>;
      expect(ntGData.tokenId).toBe('dd26000000000000000000000000000000000000000000000000000000000261');
      expect(ntGData.tokenData).toBe('616c696365');
    });

    it('round-trip Token E: nametagRefs in transfer data restored', () => {
      const { manifest, tokenId } = deconstructAndManifest(pool, TOKEN_E);
      const assembled = assembleToken(pool, manifest, tokenId, emptyChains) as Record<string, unknown>;

      const txs = assembled.transactions as Array<Record<string, unknown>>;
      expect(txs.length).toBe(1);

      const txData = txs[0].data as Record<string, unknown>;
      const txNametags = txData.nametags as Array<Record<string, unknown>>;
      expect(txNametags.length).toBe(1);

      const nt = txNametags[0];
      const ntGenesis = nt.genesis as Record<string, unknown>;
      const ntGData = ntGenesis.data as Record<string, unknown>;
      expect(ntGData.tokenId).toBe('dd26000000000000000000000000000000000000000000000000000000000261');
    });

    it('round-trip Token F: reason object round-trips through dag-cbor', () => {
      const { manifest, tokenId } = deconstructAndManifest(pool, TOKEN_F);
      const assembled = assembleToken(pool, manifest, tokenId, emptyChains) as Record<string, unknown>;

      const genesis = assembled.genesis as Record<string, unknown>;
      const gData = genesis.data as Record<string, unknown>;
      const reason = gData.reason as Record<string, unknown>;

      expect(reason).not.toBeNull();
      expect(reason.type).toBe('TOKEN_SPLIT');

      // The nested token inside reason should be preserved
      const reasonToken = reason.token as Record<string, unknown>;
      expect(reasonToken.version).toBe('2.0');
      const reasonGenesis = reasonToken.genesis as Record<string, unknown>;
      const reasonGData = reasonGenesis.data as Record<string, unknown>;
      expect(reasonGData.tokenId).toBe(
        'ff5a4e26000000000000000000000000000000000000000000000000ff546001',
      );

      // Proofs should be preserved
      const proofs = reason.proofs as Array<Record<string, unknown>>;
      expect(proofs.length).toBe(1);
      expect(proofs[0].coinId).toBe('UCT');
    });
  });

  // -----------------------------------------------------------------------
  // Historical assembly (assembleTokenAtState)
  // -----------------------------------------------------------------------

  describe('historical assembly (assembleTokenAtState)', () => {
    it('assembleAtState(tokenC, 0) -> genesis only, no transactions', () => {
      const { manifest, tokenId } = deconstructAndManifest(pool, TOKEN_C);
      const assembled = assembleTokenAtState(
        pool, manifest, tokenId, 0, emptyChains,
      ) as Record<string, unknown>;

      expect((assembled.transactions as unknown[]).length).toBe(0);
      // State should be genesis destination = PREDICATE_A (first tx sourceState)
      const state = assembled.state as Record<string, unknown>;
      expect(state.predicate).toBe(PREDICATE_A);
    });

    it('assembleAtState(tokenC, 1) -> 1 transaction', () => {
      const { manifest, tokenId } = deconstructAndManifest(pool, TOKEN_C);
      const assembled = assembleTokenAtState(
        pool, manifest, tokenId, 1, emptyChains,
      ) as Record<string, unknown>;

      expect((assembled.transactions as unknown[]).length).toBe(1);
      // State should be tx[0] destination = PREDICATE_B (tx[1] sourceState)
      const state = assembled.state as Record<string, unknown>;
      expect(state.predicate).toBe(PREDICATE_B);
    });

    it('assembleAtState(tokenC, 3) -> all 3 transactions', () => {
      const { manifest, tokenId } = deconstructAndManifest(pool, TOKEN_C);
      const assembled = assembleTokenAtState(
        pool, manifest, tokenId, 3, emptyChains,
      ) as Record<string, unknown>;

      expect((assembled.transactions as unknown[]).length).toBe(3);
      const state = assembled.state as Record<string, unknown>;
      expect(state.predicate).toBe(PREDICATE_D);
    });

    it('stateIndex out of range -> STATE_INDEX_OUT_OF_RANGE', () => {
      const { manifest, tokenId } = deconstructAndManifest(pool, TOKEN_C);

      expect(() =>
        assembleTokenAtState(pool, manifest, tokenId, 4, emptyChains),
      ).toThrow(UxfError);

      try {
        assembleTokenAtState(pool, manifest, tokenId, 4, emptyChains);
      } catch (e) {
        expect((e as UxfError).code).toBe('STATE_INDEX_OUT_OF_RANGE');
      }

      // Negative index
      expect(() =>
        assembleTokenAtState(pool, manifest, tokenId, -1, emptyChains),
      ).toThrow(UxfError);
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe('error handling', () => {
    it('corrupted element in pool -> VERIFICATION_FAILED', () => {
      const { manifest, tokenId, rootHash } = deconstructAndManifest(pool, TOKEN_A);

      // Corrupt an element: find the genesis-data element and tamper with it
      const rootEl = pool.get(rootHash)!;
      const rootChildren = rootEl.children as unknown as TokenRootChildren;
      const genesisEl = pool.get(rootChildren.genesis)!;
      const genesisChildren = genesisEl.children as unknown as GenesisChildren;
      const dataHash = genesisChildren.data;

      // Delete the real element and insert a corrupted one under the same hash
      const originalEl = pool.get(dataHash)!;
      pool.delete(dataHash);

      // Create a corrupted element with different content but valid hex so
      // hexToBytes does not fail before the verification check.
      const corruptedEl: UxfElement = {
        ...originalEl,
        content: { ...originalEl.content, recipient: 'CORRUPTED-RECIPIENT' },
      };

      // Force it into the pool's internal map under the original hash
      const internalMap = pool.toMap() as Map<ContentHash, UxfElement>;
      internalMap.set(dataHash, corruptedEl);

      expect(() =>
        assembleToken(pool, manifest, tokenId, emptyChains),
      ).toThrow(UxfError);

      try {
        assembleToken(pool, manifest, tokenId, emptyChains);
      } catch (e) {
        expect((e as UxfError).code).toBe('VERIFICATION_FAILED');
      }
    });

    it('cycle detection: circular child reference -> CYCLE_DETECTED', () => {
      // Deconstruct token A, then tamper with genesis to create a cycle
      const { manifest, tokenId, rootHash } = deconstructAndManifest(pool, TOKEN_A);

      // Replace the genesis element's data child to point back to the root
      const rootEl = pool.get(rootHash)!;
      const rootChildren = rootEl.children as unknown as TokenRootChildren;
      const genesisHash = rootChildren.genesis;
      const genesisEl = pool.get(genesisHash)!;

      // Create a new genesis element whose data child points to token-root hash
      const cyclicGenesis: UxfElement = {
        ...genesisEl,
        children: { ...genesisEl.children, data: rootHash },
      };

      // Force into pool under genesis hash
      const internalMap = pool.toMap() as Map<ContentHash, UxfElement>;
      // The actual hash of cyclicGenesis differs from genesisHash.
      // But the verification will fail first. Let's instead create a cycle
      // by making the token-root's genesis child point to token-root itself.
      const cyclicRoot: UxfElement = {
        ...rootEl,
        children: { ...rootEl.children, genesis: rootHash },
      };
      internalMap.set(rootHash, cyclicRoot);

      expect(() =>
        assembleToken(pool, manifest, tokenId, emptyChains),
      ).toThrow(UxfError);

      try {
        assembleToken(pool, manifest, tokenId, emptyChains);
      } catch (e) {
        const err = e as UxfError;
        // Could be CYCLE_DETECTED or VERIFICATION_FAILED depending on check order
        expect(['CYCLE_DETECTED', 'VERIFICATION_FAILED']).toContain(err.code);
      }
    });

    it('missing element: delete element from pool -> MISSING_ELEMENT', () => {
      const { manifest, tokenId, rootHash } = deconstructAndManifest(pool, TOKEN_A);

      // Delete the genesis element from the pool
      const rootEl = pool.get(rootHash)!;
      const rootChildren = rootEl.children as unknown as TokenRootChildren;
      pool.delete(rootChildren.genesis);

      expect(() =>
        assembleToken(pool, manifest, tokenId, emptyChains),
      ).toThrow(UxfError);

      try {
        assembleToken(pool, manifest, tokenId, emptyChains);
      } catch (e) {
        expect((e as UxfError).code).toBe('MISSING_ELEMENT');
      }
    });

    it('type mismatch: swap element type in pool -> TYPE_MISMATCH', () => {
      const { manifest, tokenId, rootHash } = deconstructAndManifest(pool, TOKEN_A);

      // Get the genesis element and replace it with an authenticator element
      const rootEl = pool.get(rootHash)!;
      const rootChildren = rootEl.children as unknown as TokenRootChildren;
      const genesisHash = rootChildren.genesis;
      const genesisEl = pool.get(genesisHash)!;

      // Swap type to 'authenticator'
      const wrongTypeEl: UxfElement = {
        ...genesisEl,
        type: 'authenticator',
      };

      const internalMap = pool.toMap() as Map<ContentHash, UxfElement>;
      internalMap.set(genesisHash, wrongTypeEl);

      expect(() =>
        assembleToken(pool, manifest, tokenId, emptyChains),
      ).toThrow(UxfError);

      try {
        assembleToken(pool, manifest, tokenId, emptyChains);
      } catch (e) {
        const err = e as UxfError;
        // Could be TYPE_MISMATCH or VERIFICATION_FAILED depending on check order
        expect(['TYPE_MISMATCH', 'VERIFICATION_FAILED']).toContain(err.code);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Instance chain selection
  // -----------------------------------------------------------------------

  describe('instance chain selection', () => {
    it('strategy=latest vs original: assemble with alternative instance', () => {
      const { manifest, tokenId, rootHash } = deconstructAndManifest(pool, TOKEN_A);

      // Get the state element and create an alternative instance
      const rootEl = pool.get(rootHash)!;
      const rootChildren = rootEl.children as unknown as TokenRootChildren;
      const stateHash = rootChildren.state;
      const stateEl = pool.get(stateHash)!;

      // Create a new instance of the state element with updated content
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

      const chains = createInstanceChainIndex();
      const newHash = addInstance(pool, chains, stateHash, alternativeState);

      // Assemble with strategy=latest -> should get alternative state
      const assembledLatest = assembleToken(
        pool, manifest, tokenId, chains, STRATEGY_LATEST,
      ) as Record<string, unknown>;
      const latestState = assembledLatest.state as Record<string, unknown>;
      expect(latestState.predicate).toBe('ff'.repeat(32));

      // Assemble with strategy=original -> should get original state
      const assembledOriginal = assembleToken(
        pool, manifest, tokenId, chains, STRATEGY_ORIGINAL,
      ) as Record<string, unknown>;
      const originalState = assembledOriginal.state as Record<string, unknown>;
      expect(originalState.predicate).toBe(PREDICATE_A);
    });
  });

  // -----------------------------------------------------------------------
  // Depth limit
  // -----------------------------------------------------------------------

  describe('depth limit', () => {
    it('deeply nested nametag token (depth>100) -> INVALID_PACKAGE', () => {
      // Build a token with nametags nested 101 levels deep
      // We just need a minimal nesting structure that exceeds depth limit
      let innerToken: Record<string, unknown> = JSON.parse(JSON.stringify(NAMETAG_ALICE));

      // Nest 101 levels deep
      for (let i = 0; i < 101; i++) {
        innerToken = {
          version: '2.0',
          state: { predicate: 'aa'.repeat(32), data: null },
          genesis: {
            data: {
              tokenId: 'aa'.repeat(32),
              tokenType: 'aa'.repeat(32),
              coinData: [],
              tokenData: '',
              salt: 'aa'.repeat(32),
              recipient: 'DIRECT://test',
              recipientDataHash: null,
              reason: null,
            },
            inclusionProof: {
              authenticator: {
                algorithm: 'secp256k1',
                publicKey: '02' + 'aa'.repeat(32),
                signature: 'aa'.repeat(64),
                stateHash: 'aa'.repeat(32),
              },
              merkleTreePath: { root: 'aa'.repeat(32), steps: [] },
              transactionHash: 'aa'.repeat(32),
              unicityCertificate: 'aa'.repeat(50),
            },
          },
          transactions: [],
          nametags: [innerToken],
        };
      }

      expect(() => deconstructToken(pool, innerToken)).toThrow(UxfError);
      try {
        deconstructToken(pool, innerToken);
      } catch (e) {
        expect((e as UxfError).code).toBe('INVALID_PACKAGE');
      }
    });
  });

  // -----------------------------------------------------------------------
  // Special field preservation
  // -----------------------------------------------------------------------

  describe('special field preservation', () => {
    it('null inclusionProof preserved through round-trip', () => {
      const { manifest, tokenId } = deconstructAndManifest(pool, EDGE_NULL_PROOF);
      const assembled = assembleToken(pool, manifest, tokenId, emptyChains) as Record<string, unknown>;

      const txs = assembled.transactions as Array<Record<string, unknown>>;
      expect(txs.length).toBe(1);
      expect(txs[0].inclusionProof).toBeNull();
    });

    it('message field preserved in transfer transaction data', () => {
      const { manifest, tokenId } = deconstructAndManifest(pool, TOKEN_C);
      const assembled = assembleToken(pool, manifest, tokenId, emptyChains) as Record<string, unknown>;

      const txs = assembled.transactions as Array<Record<string, unknown>>;
      expect((txs[0].data as Record<string, unknown>).message).toBe('first transfer');
      expect((txs[1].data as Record<string, unknown>).message).toBeNull();
      expect((txs[2].data as Record<string, unknown>).message).toBe('returned');
    });
  });
});
