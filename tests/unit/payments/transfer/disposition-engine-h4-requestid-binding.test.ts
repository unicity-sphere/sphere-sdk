/**
 * Tests for Audit #333 H4 — disposition engine RequestId binding.
 *
 * Background
 * ----------
 * Before the H4 fix, the engine called
 * `verifyProof(proof, trustBase, requestId)` with the bundle-supplied
 * `requestId` and trusted that the un-audited `hydrateChain` adapter
 * had derived it canonically (`RequestId.create(authenticator.publicKey,
 * sourceState)`). If the adapter erred or a malicious sender hand-
 * crafted the bundle with a proof anchored to a DIFFERENT transaction's
 * requestId, the proof would still verify (it IS a genuine on-chain
 * proof) but it would be incorrectly attributed to this transaction —
 * a proof-binding forgery.
 *
 * Fix
 * ---
 *   - Added optional `assertRequestIdBinding` hook to
 *     `DispositionEngineInput`. When provided, the engine calls it
 *     BEFORE `verifyProof` for every tx that has a proof, and:
 *       * `ok: true` → proof verification proceeds.
 *       * `ok: false` → cryptoInvalid('proof-invalid').
 *       * throw → structuralInvalid('proof-throw').
 *   - Plumbed through `legacy-shape-adapter.ts` so production wiring
 *     can supply the hook via `LegacyShapeAdapterInput`.
 *   - Optional shape preserves back-compat with the 66 existing
 *     engine tests (which do not set the hook). Production callers
 *     SHOULD wire `RequestId.create(auth.publicKey, auth.stateHash)`
 *     comparison.
 *
 * These tests exercise each path of the binding gate.
 */

import { describe, expect, it } from 'vitest';
import {
  processDisposition,
  type AssertRequestIdBindingFn,
  type DispositionEngineInput,
  type HydratedChain,
} from '../../../../modules/payments/transfer/disposition-engine';
import type { ContentHash } from '../../../../extensions/uxf/bundle/types';

// ---------------------------------------------------------------------------
// Minimal fixture — focused on the proof-verify branch so we can drive
// the binding gate without re-implementing the full disposition pipeline.
// ---------------------------------------------------------------------------

const POOL = new Map();
const TOKEN_ROOT_HASH = 'aabbccdd'.padEnd(64, 'a') as ContentHash;
const BUNDLE_CID = 'bafkreih4testcid';
const SENDER_PUBKEY = '02bb'.padEnd(66, 'b');
const PUBKEY = new Uint8Array(33).fill(0xaa);
const TRUSTBASE = { trustBase: true };

function makeChain(opts?: {
  requestId?: unknown;
  hasProof?: boolean;
}): HydratedChain {
  const requestId = opts?.requestId ?? 'request-id-from-bundle';
  const hasProof = opts?.hasProof !== false;
  return {
    tokenId: 'tok-h4-test',
    tokenRootHash: TOKEN_ROOT_HASH,
    chain: [
      {
        sourceStateHash: 'src-state-hash',
        destinationStateHash: 'dst-state-hash',
        transactionHash: { tx: 'hash' },
        authenticator: { publicKey: PUBKEY, stateHash: 'src-state-hash' },
        inclusionProof: hasProof ? { proof: 'data' } : null,
        requestId: hasProof ? requestId : null,
      },
    ],
    currentStatePredicate: { predicate: 'data' },
    currentDestinationStateHash: 'current-dst',
  };
}

function buildInput(opts?: {
  chain?: HydratedChain;
  bindingHook?: AssertRequestIdBindingFn;
  bindingThrow?: unknown;
  verifyProofResult?: 'OK' | 'PATH_INVALID';
}): DispositionEngineInput {
  return {
    tokenRootHash: TOKEN_ROOT_HASH,
    pool: POOL,
    bundleCid: BUNDLE_CID,
    senderTransportPubkey: SENDER_PUBKEY,
    mode: 'conservative',
    ourPubkey: PUBKEY,
    trustBase: TRUSTBASE,
    hydrateChain: async () => opts?.chain ?? makeChain(),
    readLocalManifest: async () => undefined,
    evaluatePredicate: async () => ({ ok: true, bindsToUs: true }),
    verifyAuthenticator: async () => ({ ok: true, valid: true }),
    walkContinuity: () => ({ ok: true }),
    verifyProof: async () => opts?.verifyProofResult ?? 'OK',
    oracleIsSpent: async () => false,
    ...(opts?.bindingHook ? { assertRequestIdBinding: opts.bindingHook } : {}),
    ...(opts?.bindingThrow !== undefined
      ? {
          assertRequestIdBinding: async () => {
            throw opts.bindingThrow;
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Audit #333 H4 — disposition engine requestId binding', () => {
  describe('binding hook absent (back-compat default)', () => {
    it('verifyProof is called WITHOUT the binding gate (pre-fix behaviour preserved)', async () => {
      let verifyProofCalled = false;
      const input = {
        ...buildInput(),
        verifyProof: async () => {
          verifyProofCalled = true;
          return 'OK' as const;
        },
      };
      const result = await processDisposition(input);
      expect(verifyProofCalled).toBe(true);
      // Without the binding gate, a tx with valid auth + verifyProof('OK')
      // makes it through the §5.3 [C](1)/(2)/(3) checks. Whether it
      // lands as VALID or PENDING depends on the rest of the pipeline,
      // but the absence of the binding gate must NOT route to
      // cryptoInvalid.
      expect(result.disposition).not.toBe('INVALID');
    });
  });

  describe('binding hook present and returns ok=true', () => {
    it('binding is asserted, verifyProof is called, proof verification proceeds', async () => {
      let bindingCalledWith: { req: unknown; auth: unknown } | null = null;
      let verifyProofCalled = false;
      const input = {
        ...buildInput({
          bindingHook: async (bundleRequestId, authenticator) => {
            bindingCalledWith = { req: bundleRequestId, auth: authenticator };
            return { ok: true };
          },
        }),
        verifyProof: async () => {
          verifyProofCalled = true;
          return 'OK' as const;
        },
      };
      const result = await processDisposition(input);
      expect(bindingCalledWith).not.toBeNull();
      expect(verifyProofCalled).toBe(true);
      expect(result.disposition).not.toBe('INVALID');
    });

    it('passes the bundle requestId AND the authenticator to the hook', async () => {
      let captured: { req: unknown; auth: unknown } | null = null;
      const customRequestId = { customRequestId: 'value' };
      const chain = makeChain({ requestId: customRequestId });
      const input = buildInput({
        chain,
        bindingHook: async (req, auth) => {
          captured = { req, auth };
          return { ok: true };
        },
      });
      await processDisposition(input);
      expect(captured).not.toBeNull();
      expect(captured!.req).toBe(customRequestId);
      // The authenticator object from the chain entry is forwarded
      // unchanged so the production hook can do its canonical
      // RequestId.create(auth.publicKey, auth.stateHash).
      expect(captured!.auth).toEqual({
        publicKey: PUBKEY,
        stateHash: 'src-state-hash',
      });
    });
  });

  describe('binding hook returns ok=false (forgery detected)', () => {
    it('routes to cryptoInvalid(proof-invalid) WITHOUT invoking verifyProof', async () => {
      let verifyProofCalled = false;
      const input = {
        ...buildInput({
          bindingHook: async () => ({ ok: false, reason: 'forged binding' }),
        }),
        verifyProof: async () => {
          verifyProofCalled = true;
          return 'OK' as const;
        },
      };
      const result = await processDisposition(input);
      expect(verifyProofCalled).toBe(false);
      expect(result.disposition).toBe('INVALID');
      expect((result as { reason: string }).reason).toBe('proof-invalid');
    });
  });

  describe('binding hook throws', () => {
    it('routes to structuralInvalid(proof-throw)', async () => {
      const input = buildInput({
        bindingThrow: new Error('SDK adapter exploded'),
      });
      const result = await processDisposition(input);
      expect(result.disposition).toBe('INVALID');
      expect((result as { reason: string }).reason).toBe('proof-throw');
    });
  });

  describe('binding gate fires BEFORE verifyProof (defense-in-depth ordering)', () => {
    it('verifyProof is never called when the binding rejects', async () => {
      const calls: string[] = [];
      const input = {
        ...buildInput({
          bindingHook: async () => {
            calls.push('binding');
            return { ok: false };
          },
        }),
        verifyProof: async () => {
          calls.push('verifyProof');
          return 'OK' as const;
        },
      };
      await processDisposition(input);
      // binding fires; verifyProof does NOT.
      expect(calls).toEqual(['binding']);
    });
  });

  describe('chain entries with null proof skip the binding gate', () => {
    it('does NOT call the binding hook when inclusionProof is null', async () => {
      let bindingCalled = false;
      const input = buildInput({
        chain: makeChain({ hasProof: false }),
        bindingHook: async () => {
          bindingCalled = true;
          return { ok: true };
        },
      });
      await processDisposition(input);
      // Null proof → §5.3 [B] / instant-mode handling, no requestId to
      // bind. The binding hook MUST NOT fire on this path.
      expect(bindingCalled).toBe(false);
    });
  });
});
