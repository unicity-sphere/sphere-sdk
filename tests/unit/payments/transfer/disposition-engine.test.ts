/**
 * Tests for `modules/payments/transfer/disposition-engine.ts` (T.3.B.2).
 *
 * Strategy: every SDK / verifier / storage hook is mocked. We do NOT
 * re-test the per-element verifier behaviors covered by T.3.B.1's
 * suites — instead, we drive the engine's routing logic by feeding
 * canned hook outputs and asserting the engine produces the right
 * {@link DispositionRecord} shape per §5.3 + Appendix A.
 *
 * Coverage map (Appendix A rows + §11.1 unit-test list):
 *
 *   - [A] STRUCTURAL_INVALID
 *       • hydration throw                              (`structural`)
 *       • predicate-evaluator throw / SDK rejection    (`predicate-eval`)
 *       • authenticator-verifier throw                 (`structural`)
 *       • proof-verifier hook itself throws            (`proof-throw`)
 *       • oracle.isSpent throw                         (`structural`)
 *   - [B-not-ours] AUDIT(`not-our-state`)              — predicate
 *                                                       binds:false
 *   - [C-auth] INVALID(`auth-invalid`)                 — clean ECDSA
 *                                                       fail
 *   - [C-continuity] INVALID(`continuity-broken`)      — chain
 *                                                       broken-link
 *   - [C-proof] INVALID(`proof-invalid`) for each:
 *       • PATH_INVALID
 *       • NOT_AUTHENTICATED
 *       • PATH_NOT_INCLUDED at receive
 *   - [C-proof] INVALID(`proof-throw`) for `THROWN`
 *   - [D-conflict] CONFLICTING — divergent local manifest head
 *   - [D-fresh] no-conflict path proceeds to E
 *   - [E-pending] PENDING — chain has unfinalized tx (conservative)
 *   - [E-valid]   VALID   — all-finalized + isSpent=false
 *   - [E-unspendable] AUDIT(`off-record-spend`) — isSpent=true
 *
 * Soft-rejection:
 *   - mode='instant' + any unfinalized tx → throws
 *     `BUNDLE_REJECTED_INSTANT_MODE_NOT_YET_SUPPORTED`.
 *
 * Audit ordering acceptance:
 *   - C-continuity routes BEFORE [B] / [B'] checks (acceptance criterion):
 *     a chain whose continuity is broken AND whose current-state
 *     predicate would reject us still surfaces as INVALID(`continuity-
 *     broken`), not AUDIT(`not-our-state`).
 *
 * Spec references:
 *   - §5.3 (decision matrix)
 *   - §5.4 (DispositionReason mapping)
 *   - Appendix A (branch table)
 *   - §11.1 (unit-test list)
 */

import { describe, expect, it } from 'vitest';

import { isSphereError } from '../../../../core/errors';
import {
  processDisposition,
  type DispositionEngineInput,
  type HydratedChain,
  type HydratedTx,
} from '../../../../extensions/uxf/pipeline/disposition-engine';
import type { ContinuityResult, TxLike } from '../../../../extensions/uxf/pipeline/continuity-walker';
import type { EvaluatePredicateResult } from '../../../../extensions/uxf/pipeline/predicate-evaluator';
import type { ProofVerifyStatus } from '../../../../extensions/uxf/pipeline/proof-verifier';
import type { VerifyAuthenticatorResult } from '../../../../extensions/uxf/pipeline/authenticator-verifier';
import type { ManifestEntryDelta } from '../../../../extensions/uxf/types/disposition';
import type { ContentHash, UxfElement } from '../../../../extensions/uxf/bundle/types';

// =============================================================================
// 1. Common fixtures
// =============================================================================

const TOKEN_ID = 'aa00000000000000000000000000000000000000000000000000000000000001';
const TOKEN_ROOT_HASH = '00000000000000000000000000000000000000000000000000000000000000a1' as ContentHash;
const ALT_HEAD_HASH = '00000000000000000000000000000000000000000000000000000000000000a2' as ContentHash;
const BUNDLE_CID = 'bafytest00000000000000000000000000000000000000000000000000000001';
const SENDER_PUBKEY =
  'fefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefe';
const STATE_HASH_HEAD =
  '0000000000000000000000000000000000000000000000000000000000005646';

const PUBKEY = new Uint8Array(33);
PUBKEY[0] = 0x02;

const POOL = new Map<ContentHash, UxfElement>();
const TRUSTBASE = {} as unknown;

// =============================================================================
// 2. Hook builders
// =============================================================================

function tx(opts: {
  src?: string;
  dst?: string;
  hasProof?: boolean;
}): HydratedTx {
  return {
    sourceState: opts.src ?? 's0',
    destinationState: opts.dst ?? 's1',
    authenticator: { kind: 'auth' },
    transactionHash: { kind: 'txh' },
    inclusionProof:
      (opts.hasProof ?? true) ? ({ kind: 'proof' } as unknown) : null,
    requestId: (opts.hasProof ?? true) ? ({ kind: 'req' } as unknown) : null,
  };
}

function chain(opts: {
  txs?: ReadonlyArray<HydratedTx>;
  predicate?: unknown;
} = {}): HydratedChain {
  return {
    tokenId: TOKEN_ID,
    tokenRootHash: TOKEN_ROOT_HASH,
    chain: opts.txs ?? [],
    currentStatePredicate: opts.predicate ?? { kind: 'predicate' },
    currentDestinationStateHash: STATE_HASH_HEAD,
  };
}

interface BuildInputOverrides {
  readonly mode?: 'instant' | 'conservative';
  readonly chain?: HydratedChain;
  readonly hydrateThrow?: unknown;
  readonly continuityResult?: ContinuityResult;
  readonly continuityThrow?: unknown;
  readonly authResults?: ReadonlyArray<VerifyAuthenticatorResult>;
  readonly authThrow?: unknown;
  readonly proofResults?: ReadonlyArray<ProofVerifyStatus>;
  readonly proofThrow?: unknown;
  readonly predicateResult?: EvaluatePredicateResult;
  readonly predicateThrow?: unknown;
  readonly localManifest?: ManifestEntryDelta;
  readonly localManifestThrow?: unknown;
  readonly oracleIsSpent?: boolean;
  readonly oracleThrow?: unknown;
}

function buildInput(overrides: BuildInputOverrides = {}): DispositionEngineInput {
  const c = overrides.chain ?? chain();

  // Per-call counters so we can pop the next pre-canned answer.
  let authIdx = 0;
  let proofIdx = 0;

  return {
    tokenRootHash: TOKEN_ROOT_HASH,
    pool: POOL,
    bundleCid: BUNDLE_CID,
    senderTransportPubkey: SENDER_PUBKEY,
    mode: overrides.mode ?? 'conservative',
    ourPubkey: PUBKEY,
    trustBase: TRUSTBASE,
    hydrateChain: async () => {
      if (overrides.hydrateThrow !== undefined) {
        throw overrides.hydrateThrow;
      }
      return c;
    },
    readLocalManifest: async () => {
      if (overrides.localManifestThrow !== undefined) {
        throw overrides.localManifestThrow;
      }
      return overrides.localManifest;
    },
    evaluatePredicate: async () => {
      if (overrides.predicateThrow !== undefined) {
        throw overrides.predicateThrow;
      }
      return overrides.predicateResult ?? { ok: true, bindsToUs: true };
    },
    verifyAuthenticator: async () => {
      if (overrides.authThrow !== undefined) {
        throw overrides.authThrow;
      }
      const idx = authIdx++;
      const fallback: VerifyAuthenticatorResult = { ok: true, valid: true };
      return overrides.authResults?.[idx] ?? fallback;
    },
    walkContinuity: (_chain: ReadonlyArray<TxLike>): ContinuityResult => {
      if (overrides.continuityThrow !== undefined) {
        throw overrides.continuityThrow;
      }
      return overrides.continuityResult ?? { ok: true };
    },
    verifyProof: async () => {
      if (overrides.proofThrow !== undefined) {
        throw overrides.proofThrow;
      }
      const idx = proofIdx++;
      return overrides.proofResults?.[idx] ?? 'OK';
    },
    oracleIsSpent: async () => {
      if (overrides.oracleThrow !== undefined) {
        throw overrides.oracleThrow;
      }
      return overrides.oracleIsSpent ?? false;
    },
  };
}

// =============================================================================
// 3. [A] STRUCTURAL_INVALID
// =============================================================================

describe('[A] STRUCTURAL_INVALID — hydration throw', () => {
  it('routes hydrateChain throw to STRUCTURAL_INVALID(structural)', async () => {
    const result = await processDisposition(
      buildInput({ hydrateThrow: new Error('CBOR parse failed') }),
    );
    expect(result.disposition).toBe('INVALID');
    if (result.disposition === 'INVALID') {
      expect(result.reason).toBe('structural');
      expect(result.observedTokenContentHash).toBe(TOKEN_ROOT_HASH);
      // Hydration failed before tokenId was known — empty string per
      // engine convention.
      expect(result.tokenId).toBe('');
      expect(result.bundleCid).toBe(BUNDLE_CID);
      expect(result.senderTransportPubkey).toBe(SENDER_PUBKEY);
    }
  });

  it('routes empty/missing tokenId from hydration to STRUCTURAL_INVALID', async () => {
    const result = await processDisposition(
      buildInput({
        chain: {
          tokenId: '',
          tokenRootHash: TOKEN_ROOT_HASH,
          chain: [],
          currentStatePredicate: {},
          currentDestinationStateHash: STATE_HASH_HEAD,
        },
      }),
    );
    expect(result.disposition).toBe('INVALID');
    if (result.disposition === 'INVALID') {
      expect(result.reason).toBe('structural');
    }
  });

  it('routes continuity-walker throw to STRUCTURAL_INVALID', async () => {
    const result = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({}), tx({ src: 's1', dst: 's2' })] }),
        continuityThrow: new Error('walker exploded'),
      }),
    );
    expect(result.disposition).toBe('INVALID');
    if (result.disposition === 'INVALID') {
      expect(result.reason).toBe('structural');
    }
  });

  it('routes authenticator-verifier hook throw to STRUCTURAL_INVALID', async () => {
    const result = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({})] }),
        authThrow: new Error('hook adapter exploded'),
      }),
    );
    expect(result.disposition).toBe('INVALID');
    if (result.disposition === 'INVALID') {
      expect(result.reason).toBe('structural');
    }
  });

  it('routes auth-verifier ok:false threw:true to STRUCTURAL_INVALID', async () => {
    // Per T.3.B.1 contract: SDK-level throw inside Authenticator.verify
    // surfaces as `{ok: false, threw: true}` from the verifier hook.
    // The engine MUST route this to STRUCTURAL_INVALID, NOT to
    // INVALID(auth-invalid).
    const result = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({})] }),
        authResults: [{ ok: false, threw: true, error: new RangeError() }],
      }),
    );
    expect(result.disposition).toBe('INVALID');
    if (result.disposition === 'INVALID') {
      expect(result.reason).toBe('structural');
    }
  });

  it('routes predicate-evaluator throw to STRUCTURAL_INVALID(predicate-eval)', async () => {
    // Per §5.4 the predicate-throw sub-classification is `predicate-eval`,
    // distinct from the generic `structural`. Both go to `_invalid`,
    // but operators distinguishing the two need the separate reason.
    const result = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({})] }),
        predicateThrow: new Error('predicate parser blew up'),
      }),
    );
    expect(result.disposition).toBe('INVALID');
    if (result.disposition === 'INVALID') {
      expect(result.reason).toBe('predicate-eval');
    }
  });

  it('routes predicate-evaluator ok:false threw:true to STRUCTURAL_INVALID(predicate-eval)', async () => {
    const result = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({})] }),
        predicateResult: { ok: false, threw: true, error: new TypeError() },
      }),
    );
    expect(result.disposition).toBe('INVALID');
    if (result.disposition === 'INVALID') {
      expect(result.reason).toBe('predicate-eval');
    }
  });

  it('routes proof-verifier hook throw to STRUCTURAL_INVALID(proof-throw)', async () => {
    const result = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({ hasProof: true })] }),
        proofThrow: new Error('hook adapter exploded'),
      }),
    );
    expect(result.disposition).toBe('INVALID');
    if (result.disposition === 'INVALID') {
      expect(result.reason).toBe('proof-throw');
    }
  });

  it('routes proof-verifier THROWN status to STRUCTURAL_INVALID(proof-throw)', async () => {
    const result = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({ hasProof: true })] }),
        proofResults: ['THROWN'],
      }),
    );
    expect(result.disposition).toBe('INVALID');
    if (result.disposition === 'INVALID') {
      expect(result.reason).toBe('proof-throw');
    }
  });

  it('routes oracle.isSpent throw to STRUCTURAL_INVALID', async () => {
    const result = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({ hasProof: true })] }),
        oracleThrow: new Error('aggregator down'),
      }),
    );
    expect(result.disposition).toBe('INVALID');
    if (result.disposition === 'INVALID') {
      expect(result.reason).toBe('structural');
    }
  });

  it('routes readLocalManifest throw to STRUCTURAL_INVALID', async () => {
    const result = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({ hasProof: true })] }),
        localManifestThrow: new Error('OrbitDB corrupt'),
      }),
    );
    expect(result.disposition).toBe('INVALID');
    if (result.disposition === 'INVALID') {
      expect(result.reason).toBe('structural');
    }
  });

  it('routes proof-verifier output of unknown shape via PATH_INVALID safely', async () => {
    // Defensive sanity: the engine must accept the four documented
    // proof-verifier statuses + THROWN. PATH_INVALID is the simplest
    // negative case here.
    const result = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({ hasProof: true })] }),
        proofResults: ['PATH_INVALID'],
      }),
    );
    expect(result.disposition).toBe('INVALID');
    if (result.disposition === 'INVALID') {
      expect(result.reason).toBe('proof-invalid');
    }
  });

  it('routes missing requestId on a proofed tx to STRUCTURAL_INVALID', async () => {
    const customTx: HydratedTx = {
      ...tx({ hasProof: true }),
      requestId: null, // Defective hydration: proof present but reqId null
    };
    const result = await processDisposition(
      buildInput({ chain: chain({ txs: [customTx] }) }),
    );
    expect(result.disposition).toBe('INVALID');
    if (result.disposition === 'INVALID') {
      expect(result.reason).toBe('structural');
    }
  });
});

// =============================================================================
// 4. [B-not-ours] AUDIT(not-our-state)
// =============================================================================

describe('[B-not-ours] AUDIT(not-our-state)', () => {
  it('routes predicate bindsToUs:false to AUDIT(not-our-state) — no local state', async () => {
    const result = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({ hasProof: true })] }),
        predicateResult: { ok: true, bindsToUs: false },
        // No localManifest entry.
      }),
    );
    expect(result.disposition).toBe('AUDIT');
    if (result.disposition === 'AUDIT') {
      expect(result.reason).toBe('not-our-state');
      expect(result.auditStatus).toBe('audit-not-our-state');
      expect(result.tokenId).toBe(TOKEN_ID);
      expect(result.observedTokenContentHash).toBe(TOKEN_ROOT_HASH);
    }
  });

  it('routes predicate bindsToUs:false to AUDIT(not-our-state) — with local state', async () => {
    // Per Appendix A: B-not-ours is the same disposition shape whether
    // or not a local manifest entry pre-existed. (The promotion semantic
    // is T.3.D's concern.)
    const localManifest: ManifestEntryDelta = {
      rootHash: ALT_HEAD_HASH,
      status: 'valid',
    };
    const result = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({ hasProof: true })] }),
        predicateResult: { ok: true, bindsToUs: false },
        localManifest,
      }),
    );
    expect(result.disposition).toBe('AUDIT');
    if (result.disposition === 'AUDIT') {
      expect(result.reason).toBe('not-our-state');
    }
  });
});

// =============================================================================
// 5. [C-auth] INVALID(auth-invalid)
// =============================================================================

describe('[C-auth] INVALID(auth-invalid)', () => {
  it('routes clean ECDSA-failure verifier output to INVALID(auth-invalid)', async () => {
    const result = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({})] }),
        authResults: [{ ok: true, valid: false }],
      }),
    );
    expect(result.disposition).toBe('INVALID');
    if (result.disposition === 'INVALID') {
      expect(result.reason).toBe('auth-invalid');
    }
  });

  it('verifies EVERY tx in the chain (W37 / Note N7), short-circuits on first failure', async () => {
    // Three-tx chain where ONLY tx[1] (the middle) has an invalid
    // authenticator — mirrors the W37 mid-chain forgery test.
    const result = await processDisposition(
      buildInput({
        chain: chain({
          txs: [
            tx({ src: 's0', dst: 's1' }),
            tx({ src: 's1', dst: 's2' }),
            tx({ src: 's2', dst: 's3' }),
          ],
        }),
        authResults: [
          { ok: true, valid: true },
          { ok: true, valid: false }, // mid-chain forgery
          { ok: true, valid: true },
        ],
      }),
    );
    expect(result.disposition).toBe('INVALID');
    if (result.disposition === 'INVALID') {
      expect(result.reason).toBe('auth-invalid');
    }
  });
});

// =============================================================================
// 6. [C-continuity] INVALID(continuity-broken) — runs FIRST per acceptance
// =============================================================================

describe('[C-continuity] INVALID(continuity-broken)', () => {
  it('routes broken-continuity walker output to INVALID(continuity-broken)', async () => {
    const result = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({}), tx({ src: 's-broken', dst: 's2' })] }),
        continuityResult: { ok: false, brokenAt: 1, reason: 'continuity-broken' },
      }),
    );
    expect(result.disposition).toBe('INVALID');
    if (result.disposition === 'INVALID') {
      expect(result.reason).toBe('continuity-broken');
    }
  });

  it('routes through continuity walker BEFORE [B] / [B\'] checks (acceptance criterion)', async () => {
    // The acceptance criterion is: "the engine routes through the
    // continuity walker first, before [B]/[B'] checks". To prove this,
    // construct an input where continuity is broken AND the predicate
    // would reject us. The result MUST be continuity-broken, NOT
    // not-our-state.
    const result = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({}), tx({ src: 's-broken', dst: 's2' })] }),
        continuityResult: { ok: false, brokenAt: 1, reason: 'continuity-broken' },
        predicateResult: { ok: true, bindsToUs: false },
      }),
    );
    expect(result.disposition).toBe('INVALID');
    if (result.disposition === 'INVALID') {
      expect(result.reason).toBe('continuity-broken');
    }
  });

  it('routes through continuity walker BEFORE auth verifier (continuity is structural, cheaper)', async () => {
    // Continuity should also fire before auth fails — short-circuit.
    const result = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({}), tx({ src: 's-broken', dst: 's2' })] }),
        continuityResult: { ok: false, brokenAt: 1, reason: 'continuity-broken' },
        // Auth would fail too, but engine must short-circuit at continuity.
        authResults: [
          { ok: true, valid: true },
          { ok: true, valid: false },
        ],
      }),
    );
    expect(result.disposition).toBe('INVALID');
    if (result.disposition === 'INVALID') {
      expect(result.reason).toBe('continuity-broken');
    }
  });
});

// =============================================================================
// 7. [C-proof] INVALID(proof-invalid) — every receive-time mapping
// =============================================================================

describe('[C-proof] INVALID(proof-invalid) — receive-time mapping per §5.3 [C](3)', () => {
  for (const status of ['PATH_INVALID', 'NOT_AUTHENTICATED', 'PATH_NOT_INCLUDED'] as const) {
    it(`routes ${status} at receive to INVALID(proof-invalid)`, async () => {
      const result = await processDisposition(
        buildInput({
          chain: chain({ txs: [tx({ hasProof: true })] }),
          proofResults: [status],
        }),
      );
      expect(result.disposition).toBe('INVALID');
      if (result.disposition === 'INVALID') {
        expect(result.reason).toBe('proof-invalid');
      }
    });
  }

  it('verifies EVERY proofed tx; first failure is the surfaced reason', async () => {
    // Two-tx chain where tx[0] has a valid proof and tx[1] has
    // PATH_INVALID. Engine must walk through the chain.
    const result = await processDisposition(
      buildInput({
        chain: chain({
          txs: [
            tx({ src: 's0', dst: 's1', hasProof: true }),
            tx({ src: 's1', dst: 's2', hasProof: true }),
          ],
        }),
        proofResults: ['OK', 'PATH_INVALID'],
      }),
    );
    expect(result.disposition).toBe('INVALID');
    if (result.disposition === 'INVALID') {
      expect(result.reason).toBe('proof-invalid');
    }
  });
});

// =============================================================================
// 8. [D-conflict] CONFLICTING — divergent local manifest head
// =============================================================================

describe('[D-conflict] CONFLICTING', () => {
  it('emits CONFLICTING when local manifest has a different head', async () => {
    const localManifest: ManifestEntryDelta = {
      rootHash: ALT_HEAD_HASH,
      status: 'valid',
    };
    const result = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({ hasProof: true })] }),
        localManifest,
      }),
    );
    expect(result.disposition).toBe('CONFLICTING');
    if (result.disposition === 'CONFLICTING') {
      // The new chain head is the LAST tx's destinationState (#162);
      // the default `tx()` builder produces dst='s1'. The existing
      // head is in conflictingHeads.
      expect(result.manifest.rootHash).toBe('s1');
      expect(result.manifest.status).toBe('conflicting');
      expect(result.conflictingHeads).toContain(ALT_HEAD_HASH);
    }
  });

  it('does not surface CONFLICTING when local manifest is `invalid` status', async () => {
    // Per §5.6 idempotency invariant: "An `invalid` token MUST NEVER
    // transition out of `_invalid` — a later valid copy of the same
    // `tokenId` is treated as `CONFLICTING`". But the local manifest
    // entry IS already in `_invalid`, so the engine's behavior here is
    // to emit a fresh VALID disposition (the existing invalid record
    // remains; the writer's logic, T.3.C, preserves it).
    //
    // This test pins the engine's behavior: skipping the conflict check
    // when the local entry is `'invalid'` lets the new chain attempt to
    // surface as VALID; the writer is responsible for preserving the
    // legacy `_invalid` record per §5.6.
    const localManifest: ManifestEntryDelta = {
      rootHash: ALT_HEAD_HASH,
      status: 'invalid',
      invalidReason: 'auth-invalid',
    };
    const result = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({ hasProof: true })] }),
        localManifest,
      }),
    );
    expect(result.disposition).toBe('VALID');
  });

  it('preserves existing conflictingHeads from the local manifest', async () => {
    const localManifest: ManifestEntryDelta = {
      rootHash: ALT_HEAD_HASH,
      status: 'conflicting',
      conflictingHeads: ['00000000000000000000000000000000000000000000000000000000000000a3' as ContentHash],
    };
    const result = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({ hasProof: true })] }),
        localManifest,
      }),
    );
    expect(result.disposition).toBe('CONFLICTING');
    if (result.disposition === 'CONFLICTING') {
      expect(result.conflictingHeads.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// =============================================================================
// 9. [D-fresh] / [E-pending] / [E-valid] / [E-unspendable]
// =============================================================================

describe('[D-fresh] / [E-pending] / [E-valid] / [E-unspendable]', () => {
  it('emits PENDING when chain has unfinalized tx (conservative mode)', async () => {
    const result = await processDisposition(
      buildInput({
        mode: 'conservative',
        chain: chain({
          txs: [
            tx({ src: 's0', dst: 's1', hasProof: true }),
            tx({ src: 's1', dst: 's2', hasProof: false }),
          ],
        }),
      }),
    );
    expect(result.disposition).toBe('PENDING');
    if (result.disposition === 'PENDING') {
      // Chain head is last tx destinationState (#162) — 's2' for this
      // two-tx chain (tx[0] dst=s1, tx[1] dst=s2).
      expect(result.manifest.rootHash).toBe('s2');
      expect(result.manifest.status).toBe('pending');
    }
  });

  it('emits VALID when all txs finalized, isSpent=false, no local manifest', async () => {
    const result = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({ hasProof: true })] }),
        oracleIsSpent: false,
      }),
    );
    expect(result.disposition).toBe('VALID');
    if (result.disposition === 'VALID') {
      expect(result.manifest.status).toBe('valid');
      // Chain head is last tx destinationState (#162) — default
      // single-tx builder uses dst='s1'.
      expect(result.manifest.rootHash).toBe('s1');
    }
  });

  it('emits VALID when chain is empty (genesis-only token, finalized, isSpent=false)', async () => {
    const result = await processDisposition(
      buildInput({
        chain: chain({ txs: [] }),
        oracleIsSpent: false,
      }),
    );
    expect(result.disposition).toBe('VALID');
  });

  it('emits AUDIT(off-record-spend) when isSpent=true', async () => {
    const result = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({ hasProof: true })] }),
        oracleIsSpent: true,
      }),
    );
    expect(result.disposition).toBe('AUDIT');
    if (result.disposition === 'AUDIT') {
      expect(result.reason).toBe('off-record-spend');
      expect(result.auditStatus).toBe('audit-off-record-spend');
    }
  });

  it('does NOT call oracle when chain has unfinalized tx (PENDING short-circuit)', async () => {
    let oracleCallCount = 0;
    const input = buildInput({
      mode: 'conservative',
      chain: chain({
        txs: [
          tx({ src: 's0', dst: 's1', hasProof: true }),
          tx({ src: 's1', dst: 's2', hasProof: false }),
        ],
      }),
    });
    const wrapped: DispositionEngineInput = {
      ...input,
      oracleIsSpent: async (h: string) => {
        oracleCallCount++;
        return input.oracleIsSpent(h);
      },
    };
    const result = await processDisposition(wrapped);
    expect(result.disposition).toBe('PENDING');
    expect(oracleCallCount).toBe(0);
  });
});

// =============================================================================
// 10. Soft-rejection: instant mode + unfinalized tx
// =============================================================================

describe('soft-rejection: instant-mode-not-yet-supported', () => {
  it('throws BUNDLE_REJECTED_INSTANT_MODE_NOT_YET_SUPPORTED for instant mode + unfinalized tx', async () => {
    await expect(
      processDisposition(
        buildInput({
          mode: 'instant',
          chain: chain({
            txs: [tx({ hasProof: false })],
          }),
        }),
      ),
    ).rejects.toMatchObject({
      code: 'BUNDLE_REJECTED_INSTANT_MODE_NOT_YET_SUPPORTED',
    });
  });

  it('throws is a SphereError', async () => {
    let caught: unknown;
    try {
      await processDisposition(
        buildInput({
          mode: 'instant',
          chain: chain({ txs: [tx({ hasProof: false })] }),
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(isSphereError(caught)).toBe(true);
  });

  it('does NOT throw for instant mode + chain that is coincidentally fully finalized', async () => {
    // The gate is "any unfinalized tx"; an instant-mode bundle whose
    // chain has all-finalized txs is processed normally.
    const result = await processDisposition(
      buildInput({
        mode: 'instant',
        chain: chain({ txs: [tx({ hasProof: true })] }),
        oracleIsSpent: false,
      }),
    );
    expect(result.disposition).toBe('VALID');
  });

  it('does NOT throw for conservative mode + unfinalized tx (PENDING is correct)', async () => {
    const result = await processDisposition(
      buildInput({
        mode: 'conservative',
        chain: chain({ txs: [tx({ hasProof: false })] }),
      }),
    );
    expect(result.disposition).toBe('PENDING');
  });

  it('throws even when chain has both finalized AND unfinalized txs (one unfinalized is enough)', async () => {
    await expect(
      processDisposition(
        buildInput({
          mode: 'instant',
          chain: chain({
            txs: [
              tx({ src: 's0', dst: 's1', hasProof: true }),
              tx({ src: 's1', dst: 's2', hasProof: false }),
            ],
          }),
        }),
      ),
    ).rejects.toMatchObject({
      code: 'BUNDLE_REJECTED_INSTANT_MODE_NOT_YET_SUPPORTED',
    });
  });
});

// =============================================================================
// 11. Provenance fields on every disposition shape
// =============================================================================

describe('provenance fields are stamped on every disposition', () => {
  it('VALID carries bundleCid + senderTransportPubkey', async () => {
    const r = await processDisposition(
      buildInput({ chain: chain({ txs: [tx({ hasProof: true })] }) }),
    );
    expect(r.bundleCid).toBe(BUNDLE_CID);
    expect(r.senderTransportPubkey).toBe(SENDER_PUBKEY);
  });

  it('INVALID carries bundleCid + senderTransportPubkey', async () => {
    const r = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({})] }),
        authResults: [{ ok: true, valid: false }],
      }),
    );
    expect(r.bundleCid).toBe(BUNDLE_CID);
    expect(r.senderTransportPubkey).toBe(SENDER_PUBKEY);
  });

  it('AUDIT carries bundleCid + senderTransportPubkey', async () => {
    const r = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({ hasProof: true })] }),
        predicateResult: { ok: true, bindsToUs: false },
      }),
    );
    expect(r.bundleCid).toBe(BUNDLE_CID);
    expect(r.senderTransportPubkey).toBe(SENDER_PUBKEY);
  });

  it('CONFLICTING carries bundleCid + senderTransportPubkey', async () => {
    const r = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({ hasProof: true })] }),
        localManifest: { rootHash: ALT_HEAD_HASH, status: 'valid' },
      }),
    );
    expect(r.bundleCid).toBe(BUNDLE_CID);
    expect(r.senderTransportPubkey).toBe(SENDER_PUBKEY);
  });

  it('PENDING carries bundleCid + senderTransportPubkey', async () => {
    const r = await processDisposition(
      buildInput({
        mode: 'conservative',
        chain: chain({ txs: [tx({ hasProof: false })] }),
      }),
    );
    expect(r.bundleCid).toBe(BUNDLE_CID);
    expect(r.senderTransportPubkey).toBe(SENDER_PUBKEY);
  });

  it('STRUCTURAL_INVALID from hydration throw still carries bundleCid + senderTransportPubkey', async () => {
    const r = await processDisposition(
      buildInput({ hydrateThrow: new Error('boom') }),
    );
    expect(r.bundleCid).toBe(BUNDLE_CID);
    expect(r.senderTransportPubkey).toBe(SENDER_PUBKEY);
  });
});

// =============================================================================
// 12. Routing-order invariants (defense-in-depth)
// =============================================================================

describe('routing-order invariants', () => {
  it('hydration runs before continuity (hydration throw wins over continuity)', async () => {
    const r = await processDisposition(
      buildInput({
        hydrateThrow: new Error('hydration boom'),
        continuityResult: { ok: false, brokenAt: 1, reason: 'continuity-broken' },
      }),
    );
    expect(r.disposition).toBe('INVALID');
    if (r.disposition === 'INVALID') {
      expect(r.reason).toBe('structural');
    }
  });

  it('continuity runs before authenticator (continuity-broken wins)', async () => {
    const r = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({}), tx({})] }),
        continuityResult: { ok: false, brokenAt: 1, reason: 'continuity-broken' },
        authResults: [
          { ok: true, valid: true },
          { ok: true, valid: false },
        ],
      }),
    );
    expect(r.disposition).toBe('INVALID');
    if (r.disposition === 'INVALID') {
      expect(r.reason).toBe('continuity-broken');
    }
  });

  it('authenticator runs before proof-verify (auth-invalid wins)', async () => {
    const r = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({ hasProof: true })] }),
        authResults: [{ ok: true, valid: false }],
        proofResults: ['PATH_INVALID'],
      }),
    );
    expect(r.disposition).toBe('INVALID');
    if (r.disposition === 'INVALID') {
      expect(r.reason).toBe('auth-invalid');
    }
  });

  it('proof-verify runs before predicate-eval (proof-invalid wins)', async () => {
    const r = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({ hasProof: true })] }),
        proofResults: ['PATH_INVALID'],
        predicateResult: { ok: true, bindsToUs: false }, // would be not-our-state
      }),
    );
    expect(r.disposition).toBe('INVALID');
    if (r.disposition === 'INVALID') {
      expect(r.reason).toBe('proof-invalid');
    }
  });

  it('predicate runs before conflict-check (not-our-state wins)', async () => {
    const r = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({ hasProof: true })] }),
        predicateResult: { ok: true, bindsToUs: false },
        localManifest: { rootHash: ALT_HEAD_HASH, status: 'valid' }, // would be CONFLICTING
      }),
    );
    expect(r.disposition).toBe('AUDIT');
    if (r.disposition === 'AUDIT') {
      expect(r.reason).toBe('not-our-state');
    }
  });

  it('conflict-check runs before isSpent (CONFLICTING wins over isSpent=true)', async () => {
    const r = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({ hasProof: true })] }),
        localManifest: { rootHash: ALT_HEAD_HASH, status: 'valid' },
        oracleIsSpent: true,
      }),
    );
    expect(r.disposition).toBe('CONFLICTING');
  });
});

// =============================================================================
// 13. Edge: empty chain (genesis-only)
// =============================================================================

describe('empty chain (genesis-only token)', () => {
  it('zero-tx chain with predicate binding to us → VALID (no proof verify needed)', async () => {
    const r = await processDisposition(
      buildInput({
        chain: chain({ txs: [] }),
        oracleIsSpent: false,
      }),
    );
    expect(r.disposition).toBe('VALID');
  });

  it('zero-tx chain with predicate NOT binding to us → AUDIT(not-our-state)', async () => {
    const r = await processDisposition(
      buildInput({
        chain: chain({ txs: [] }),
        predicateResult: { ok: true, bindsToUs: false },
      }),
    );
    expect(r.disposition).toBe('AUDIT');
    if (r.disposition === 'AUDIT') {
      expect(r.reason).toBe('not-our-state');
    }
  });
});

// =============================================================================
// 14. Mid-chain null-proof rejection (#154 — monotonic-proof invariant)
// =============================================================================

describe('mid-chain null-proof rejection (#154)', () => {
  it('rejects 2-tx chain where tx[0] is null-proof and tx[1] is anchored', async () => {
    // The classic forgery shape: a hostile sender strips the proof
    // from tx[0] to lure us into PENDING for a tx that is in fact
    // already anchored to a competing successor.
    const r = await processDisposition(
      buildInput({
        mode: 'conservative',
        chain: chain({
          txs: [
            tx({ src: 's0', dst: 's1', hasProof: false }),
            tx({ src: 's1', dst: 's2', hasProof: true }),
          ],
        }),
      }),
    );
    expect(r.disposition).toBe('INVALID');
    if (r.disposition === 'INVALID') {
      expect(r.reason).toBe('proof-invalid');
    }
  });

  it('rejects 3-tx chain where tx[1] (middle) is null-proof and tx[2] is anchored', async () => {
    const r = await processDisposition(
      buildInput({
        mode: 'conservative',
        chain: chain({
          txs: [
            tx({ src: 's0', dst: 's1', hasProof: true }),
            tx({ src: 's1', dst: 's2', hasProof: false }),
            tx({ src: 's2', dst: 's3', hasProof: true }),
          ],
        }),
      }),
    );
    expect(r.disposition).toBe('INVALID');
    if (r.disposition === 'INVALID') {
      expect(r.reason).toBe('proof-invalid');
    }
  });

  it('accepts a SUFFIX-only unfinalized chain (PENDING)', async () => {
    // Defense: the rejection MUST only fire when a strictly-later tx
    // has a proof. A tail-pending chain is the legitimate
    // chain-mode-mid-hop / instant-mode-head-pending shape.
    const r = await processDisposition(
      buildInput({
        mode: 'conservative',
        chain: chain({
          txs: [
            tx({ src: 's0', dst: 's1', hasProof: true }),
            tx({ src: 's1', dst: 's2', hasProof: false }),
            tx({ src: 's2', dst: 's3', hasProof: false }),
          ],
        }),
      }),
    );
    expect(r.disposition).toBe('PENDING');
  });

  it('accepts a fully-unfinalized chain (no proofs anywhere → PENDING)', async () => {
    // No tx has a proof, so `lastProofedIndex === -1` and the gate
    // never fires. PENDING is the right outcome (conservative mode).
    const r = await processDisposition(
      buildInput({
        mode: 'conservative',
        chain: chain({
          txs: [
            tx({ src: 's0', dst: 's1', hasProof: false }),
            tx({ src: 's1', dst: 's2', hasProof: false }),
          ],
        }),
      }),
    );
    expect(r.disposition).toBe('PENDING');
  });

  it('rejects mid-chain null-proof BEFORE attempting proof-verify on the anchored tx', async () => {
    // The mid-chain gap is detected by the pre-check loop; we should
    // never reach the proof verifier (which here is set to PATH_INVALID
    // — the test would surface a different reason if the engine got
    // past the gate). The reason returned is the gate's `proof-invalid`,
    // which is the same string as the verifier-driven outcome, but
    // arises here without the verifier hook running.
    let proofVerifyCount = 0;
    const input = buildInput({
      mode: 'conservative',
      chain: chain({
        txs: [
          tx({ src: 's0', dst: 's1', hasProof: false }),
          tx({ src: 's1', dst: 's2', hasProof: true }),
        ],
      }),
      proofResults: ['OK'],
    });
    const wrapped: DispositionEngineInput = {
      ...input,
      verifyProof: async (proof, trustBase, requestId) => {
        proofVerifyCount++;
        return input.verifyProof(proof, trustBase, requestId);
      },
    };
    const r = await processDisposition(wrapped);
    expect(r.disposition).toBe('INVALID');
    if (r.disposition === 'INVALID') {
      expect(r.reason).toBe('proof-invalid');
    }
    expect(proofVerifyCount).toBe(0);
  });
});

// =============================================================================
// 15. chainHeadHash returns last tx destinationState (#162)
// =============================================================================

describe('chainHeadHash uses last tx destinationState (#162)', () => {
  it('VALID single-tx chain reports head=tx.destinationState', async () => {
    const r = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({ src: 's0', dst: 'head-1', hasProof: true })] }),
      }),
    );
    expect(r.disposition).toBe('VALID');
    if (r.disposition === 'VALID') {
      expect(r.manifest.rootHash).toBe('head-1');
    }
  });

  it('VALID multi-tx chain reports head=last-tx.destinationState', async () => {
    const r = await processDisposition(
      buildInput({
        chain: chain({
          txs: [
            tx({ src: 's0', dst: 's1', hasProof: true }),
            tx({ src: 's1', dst: 's2', hasProof: true }),
            tx({ src: 's2', dst: 'final-head', hasProof: true }),
          ],
        }),
      }),
    );
    expect(r.disposition).toBe('VALID');
    if (r.disposition === 'VALID') {
      expect(r.manifest.rootHash).toBe('final-head');
    }
  });

  it('PENDING multi-tx chain reports head=last-tx.destinationState (suffix-pending)', async () => {
    const r = await processDisposition(
      buildInput({
        mode: 'conservative',
        chain: chain({
          txs: [
            tx({ src: 's0', dst: 's1', hasProof: true }),
            tx({ src: 's1', dst: 'tail-head', hasProof: false }),
          ],
        }),
      }),
    );
    expect(r.disposition).toBe('PENDING');
    if (r.disposition === 'PENDING') {
      expect(r.manifest.rootHash).toBe('tail-head');
    }
  });

  it('empty chain reports head=tokenRootHash (genesis-only fallback)', async () => {
    const r = await processDisposition(
      buildInput({
        chain: chain({ txs: [] }),
        oracleIsSpent: false,
      }),
    );
    expect(r.disposition).toBe('VALID');
    if (r.disposition === 'VALID') {
      // Genesis-only fallback — no transitions to anchor a head state.
      expect(r.manifest.rootHash).toBe(TOKEN_ROOT_HASH);
    }
  });

  it('CONFLICTING compares against destinationState — re-anchor of same tokenRootHash with diverged head IS conflict', async () => {
    // Pre-fix bug: the engine compared `tokenRootHash` against the
    // local manifest's rootHash. A re-anchor of the same token-root
    // CID under a NEW chain (different head state) would NOT trigger
    // CONFLICTING. With the fix the comparison is against the chain
    // head's destinationState, so this case correctly surfaces.
    const localManifest: ManifestEntryDelta = {
      // Local manifest's recorded head is `s-old`.
      rootHash: 's-old' as ContentHash,
      status: 'valid',
    };
    const r = await processDisposition(
      buildInput({
        chain: chain({
          txs: [
            tx({ src: 's0', dst: 's1', hasProof: true }),
            tx({ src: 's1', dst: 's-new', hasProof: true }),
          ],
        }),
        localManifest,
      }),
    );
    expect(r.disposition).toBe('CONFLICTING');
    if (r.disposition === 'CONFLICTING') {
      expect(r.manifest.rootHash).toBe('s-new');
      expect(r.conflictingHeads).toContain('s-old');
    }
  });

  it('NO conflict when local manifest head matches the new chain head (converged chains)', async () => {
    // Defense: two chains may have legitimately converged on the same
    // head state (e.g., the user already imported this exact manifest
    // entry in a prior bundle). The engine MUST NOT fire CONFLICTING
    // in that case.
    const localManifest: ManifestEntryDelta = {
      rootHash: 'same-head' as ContentHash,
      status: 'valid',
    };
    const r = await processDisposition(
      buildInput({
        chain: chain({
          txs: [
            tx({ src: 's0', dst: 's1', hasProof: true }),
            tx({ src: 's1', dst: 'same-head', hasProof: true }),
          ],
        }),
        localManifest,
      }),
    );
    expect(r.disposition).toBe('VALID');
    if (r.disposition === 'VALID') {
      expect(r.manifest.rootHash).toBe('same-head');
    }
  });
});

// =============================================================================
// (Wave 3 steelman) PENDING + new chain head → 'pending-conflicting'
//
// When the local manifest is in `pending` state (in-flight T.5.C
// finalization worker tracking the queue entries), and a new bundle
// arrives with a different chain head, the engine's CONFLICTING
// disposition must NOT clobber the pending state with status='conflicting'
// — the worker would otherwise continue finalizing the previous chain
// (rootHash X) while the manifest declares a different head (rootHash Y)
// authoritative. Distinguish via 'pending-conflicting' so downstream
// reconciliation can drain the queue first.
// =============================================================================

describe('Wave 3 steelman: PENDING + conflicting head → pending-conflicting', () => {
  it('emits CONFLICTING with status="pending-conflicting" when local was pending', async () => {
    const localManifest: ManifestEntryDelta = {
      rootHash: ALT_HEAD_HASH,
      status: 'pending',
    };
    const result = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({ hasProof: true })] }),
        localManifest,
      }),
    );
    expect(result.disposition).toBe('CONFLICTING');
    if (result.disposition === 'CONFLICTING') {
      // The new manifest delta carries the new pending-conflicting status.
      expect(result.manifest.status).toBe('pending-conflicting');
      // Both heads surface in conflictingHeads.
      expect(result.conflictingHeads).toContain(ALT_HEAD_HASH);
    }
  });

  it('emits CONFLICTING with status="conflicting" when local was valid (default path)', async () => {
    const localManifest: ManifestEntryDelta = {
      rootHash: ALT_HEAD_HASH,
      status: 'valid',
    };
    const result = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({ hasProof: true })] }),
        localManifest,
      }),
    );
    expect(result.disposition).toBe('CONFLICTING');
    if (result.disposition === 'CONFLICTING') {
      expect(result.manifest.status).toBe('conflicting');
    }
  });

  it('emits CONFLICTING with status="conflicting" when local was conflicting (no escalation)', async () => {
    const localManifest: ManifestEntryDelta = {
      rootHash: ALT_HEAD_HASH,
      status: 'conflicting',
      conflictingHeads: ['00000000000000000000000000000000000000000000000000000000000000aa' as ContentHash],
    };
    const result = await processDisposition(
      buildInput({
        chain: chain({ txs: [tx({ hasProof: true })] }),
        localManifest,
      }),
    );
    expect(result.disposition).toBe('CONFLICTING');
    if (result.disposition === 'CONFLICTING') {
      expect(result.manifest.status).toBe('conflicting');
    }
  });
});

// =============================================================================
// (Wave 3 steelman) Empty-tokenId hydration failure surfaces with empty
// `tokenId` field — the writer routes this to the `invalid-orphan`
// keyspace (covered by `disposition-writer.test.ts`); here we just pin
// the engine's contract that a hydration throw produces a record with
// `tokenId === ''` and observedTokenContentHash === input root.
// =============================================================================

describe('Wave 3 steelman: hydration throw produces empty-tokenId STRUCTURAL_INVALID', () => {
  it('hydration throw → tokenId is empty string', async () => {
    const result = await processDisposition(
      buildInput({ hydrateThrow: new Error('CBOR parse failed') }),
    );
    expect(result.disposition).toBe('INVALID');
    if (result.disposition === 'INVALID') {
      expect(result.tokenId).toBe('');
      expect(result.observedTokenContentHash).toBe(TOKEN_ROOT_HASH);
      expect(result.reason).toBe('structural');
    }
  });
});
