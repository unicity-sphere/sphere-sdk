/**
 * Adversarial test — mode-claim mismatch (§3.1, §5.3, §11.4).
 *
 * Threat model: a hostile sender sets `payload.mode` to a value that
 * does not match the actual chain shape — hoping to trick the
 * recipient into a different code path:
 *
 *   1. **Conservative-claim with unfinalized chain**: sender writes
 *      `mode: 'conservative'` but ships a chain with unfinalized
 *      transactions. If the recipient TRUSTED the mode field naively,
 *      they might assume "all proofs present, no finalization queue
 *      needed" and finalize the token immediately as `valid` — leaking
 *      a token whose proofs are not yet anchored.
 *
 *   2. **Instant-claim with all-proofs**: sender writes
 *      `mode: 'instant'` but ships a chain with every tx already
 *      finalized. If the recipient was hard-coded to "instant means
 *      pending until our worker finishes", they might unnecessarily
 *      enqueue this token in the finalization queue and delay its
 *      availability.
 *
 * Spec defense (§3.1, §5.3, normative):
 *   "`payload.mode` is ADVISORY — the recipient processes per BUNDLE
 *    CONTENTS, not per the sender's mode claim. Disposition is driven
 *    by the chain shape (proof presence per tx), oracle isSpent, and
 *    local manifest state — not by `payload.mode`."
 *
 * The ONE exception: `mode === 'instant'` AND any unfinalized tx →
 * deferred-handling note throws BUNDLE_REJECTED_INSTANT_MODE_NOT_YET_
 * SUPPORTED (T.3.E early gate). This is implementation gating, not
 * a security defense.
 *
 * What this test pins:
 *   1. Conservative-claim + unfinalized → token ends up `PENDING`,
 *      NOT `VALID`. The recipient does NOT trust the claim.
 *   2. Instant-claim + all-finalized → token ends up `VALID` (or
 *      `AUDIT(off-record-spend)` if isSpent). NOT a deferred throw.
 *   3. Conservative-claim + all-finalized → `VALID` (sanity baseline).
 *   4. The disposition reasoning is identical when we toggle ONLY
 *      the `mode` field on the same chain — proof of the field's
 *      advisory nature.
 *
 * Spec references: §3.1, §5.3, §11.4.
 */

import { describe, expect, it } from 'vitest';

import {
  processDisposition,
  type DispositionEngineInput,
  type HydratedChain,
  type HydratedTx,
} from '../../../modules/payments/transfer/disposition-engine';
import type {
  ContinuityResult,
  TxLike,
} from '../../../modules/payments/transfer/continuity-walker';
import type { ContentHash, UxfElement } from '../../../extensions/uxf/bundle/types';

// =============================================================================
// Common fixtures
// =============================================================================

const TOKEN_ID =
  'aa00000000000000000000000000000000000000000000000000000000000001';
const TOKEN_ROOT_HASH =
  '00000000000000000000000000000000000000000000000000000000000000a1' as ContentHash;
const BUNDLE_CID =
  'bafytest00000000000000000000000000000000000000000000000000000001';
const SENDER_PUBKEY =
  'fefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefe';
const STATE_HASH_HEAD =
  '0000000000000000000000000000000000000000000000000000000000005646';

const PUBKEY = new Uint8Array(33);
PUBKEY[0] = 0x02;

const POOL = new Map<ContentHash, UxfElement>();
const TRUSTBASE = {} as unknown;

function makeTx(opts: { src?: string; dst?: string; hasProof?: boolean }): HydratedTx {
  return {
    sourceState: opts.src ?? 's0',
    destinationState: opts.dst ?? 's1',
    authenticator: { kind: 'auth' },
    transactionHash: { kind: 'txh' },
    inclusionProof: (opts.hasProof ?? true) ? ({ kind: 'proof' } as unknown) : null,
    requestId: (opts.hasProof ?? true) ? ({ kind: 'req' } as unknown) : null,
  };
}

function makeChain(txs: ReadonlyArray<HydratedTx>): HydratedChain {
  return {
    tokenId: TOKEN_ID,
    tokenRootHash: TOKEN_ROOT_HASH,
    chain: txs,
    currentStatePredicate: { kind: 'predicate' },
    currentDestinationStateHash: STATE_HASH_HEAD,
  };
}

function makeInput(opts: {
  mode: 'instant' | 'conservative';
  chain: HydratedChain;
  oracleIsSpent?: boolean;
}): DispositionEngineInput {
  return {
    tokenRootHash: TOKEN_ROOT_HASH,
    pool: POOL,
    bundleCid: BUNDLE_CID,
    senderTransportPubkey: SENDER_PUBKEY,
    mode: opts.mode,
    ourPubkey: PUBKEY,
    trustBase: TRUSTBASE,
    hydrateChain: async () => opts.chain,
    readLocalManifest: async () => undefined, // no prior entry
    evaluatePredicate: async () => ({ ok: true, bindsToUs: true }),
    verifyAuthenticator: async () => ({ ok: true, valid: true }),
    walkContinuity: (_chain: ReadonlyArray<TxLike>): ContinuityResult => ({ ok: true }),
    verifyProof: async () => 'OK',
    oracleIsSpent: async () => opts.oracleIsSpent ?? false,
  };
}

// =============================================================================
// Test cases
// =============================================================================

describe('§11.4 — mode-claim mismatch: payload.mode is advisory only', () => {
  it('CONSERVATIVE-claim + unfinalized chain → PENDING (not VALID)', async () => {
    // Hostile sender claims conservative ("all proofs present, finalize
    // me now") but ships a chain with an unfinalized tx. The defense:
    // disposition follows chain contents — the unfinalized tx forces
    // PENDING, regardless of the mode claim.
    const result = await processDisposition(
      makeInput({
        mode: 'conservative',
        chain: makeChain([makeTx({ hasProof: false })]),
      }),
    );
    expect(result.disposition).toBe('PENDING');
    if (result.disposition === 'PENDING') {
      expect(result.manifest.status).toBe('pending');
    }
  });

  it('INSTANT-claim + all-finalized chain → VALID (no deferred-handling throw)', async () => {
    // The §3.1 advisory-only invariant works in BOTH directions: the
    // T.3.E deferred-handling throw fires only when the claim AND
    // the chain shape both say "instant-needs-finalization". A claim
    // of instant with a coincidentally-finalized chain processes
    // normally as VALID.
    const result = await processDisposition(
      makeInput({
        mode: 'instant',
        chain: makeChain([makeTx({ hasProof: true })]),
        oracleIsSpent: false,
      }),
    );
    expect(result.disposition).toBe('VALID');
  });

  it('CONSERVATIVE-claim + all-finalized chain → VALID (sanity)', async () => {
    // Baseline: honest conservative-claim with all proofs lands at
    // VALID. The same chain with `mode: 'instant'` should land at the
    // SAME VALID — the next test pins that equivalence.
    const result = await processDisposition(
      makeInput({
        mode: 'conservative',
        chain: makeChain([makeTx({ hasProof: true })]),
        oracleIsSpent: false,
      }),
    );
    expect(result.disposition).toBe('VALID');
  });

  it('mode field is advisory: same chain → same disposition regardless of mode', async () => {
    // The deepest invariant: TOGGLING the mode field on an otherwise
    // identical chain shape DOES NOT change disposition (when the
    // T.3.E gate is not engaged). This is the testable form of
    // "mode is advisory only".
    const allFinalizedChain = makeChain([
      makeTx({ src: 's0', dst: 's1', hasProof: true }),
      makeTx({ src: 's1', dst: 's2', hasProof: true }),
    ]);
    const conservativeResult = await processDisposition(
      makeInput({ mode: 'conservative', chain: allFinalizedChain }),
    );
    const instantResult = await processDisposition(
      makeInput({ mode: 'instant', chain: allFinalizedChain }),
    );
    // Identical disposition + identical reason (when present).
    expect(conservativeResult.disposition).toBe(instantResult.disposition);
    expect(conservativeResult.disposition).toBe('VALID');
  });

  it('multi-tx chain with mid-chain unfinalized + CONSERVATIVE claim → INVALID(proof-invalid)', async () => {
    // Subtle adversarial: chain has a finalized tx[0], unfinalized
    // tx[1], finalized tx[2]. Sender claims conservative.
    //
    // Per #154 / W41 monotonic-proof invariant: proof finality is
    // monotonic over the chain. If tx[2] is anchored then tx[1] MUST
    // also be anchored — only the SUFFIX of a chain may be unfinalized.
    // A mid-chain null-proof with a later anchored tx is a structural
    // forgery (a hostile sender stripping a mid-chain proof to lure
    // the recipient into PENDING for a tx already anchored to a
    // competing successor). The engine routes this to
    // INVALID(proof-invalid) regardless of the mode claim.
    const result = await processDisposition(
      makeInput({
        mode: 'conservative',
        chain: makeChain([
          makeTx({ src: 's0', dst: 's1', hasProof: true }),
          makeTx({ src: 's1', dst: 's2', hasProof: false }),
          makeTx({ src: 's2', dst: 's3', hasProof: true }),
        ]),
      }),
    );
    expect(result.disposition).toBe('INVALID');
    if (result.disposition === 'INVALID') {
      expect(result.reason).toBe('proof-invalid');
    }
  });

  it('CONSERVATIVE-claim + unfinalized + isSpent=true → still PENDING (mid-chain unfinalized wins)', async () => {
    // Layered adversarial: oracle thinks the head IS spent, but the
    // chain is not yet anchored. Disposition routing is driven by
    // chain finalization first — PENDING is correct (we cannot
    // declare off-record-spend on an unfinalized chain because the
    // chain itself has not been observed by the aggregator).
    const result = await processDisposition(
      makeInput({
        mode: 'conservative',
        chain: makeChain([makeTx({ hasProof: false })]),
        oracleIsSpent: true,
      }),
    );
    expect(result.disposition).toBe('PENDING');
  });
});
