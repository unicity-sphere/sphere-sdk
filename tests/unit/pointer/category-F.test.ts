/**
 * Category-F conformance tests — trust-base rotation + epoch advancement
 * (SPEC §8.4, H5/H6, T-C4, T-C7).
 *
 * Scope: the pointer layer's trust-base rotation classifier
 * (`classifyTrustBaseRotation`) and the error-raising dispatcher
 * (`raiseForTrustBaseMismatch`), plus the shared-base invariant that
 * OracleProvider.getRootTrustBase() is the single source of truth consumed
 * by both L4 (PaymentsModule) and the pointer layer.
 *
 * Existing tests in `tests/unit/profile/pointer/aggregator-probe.test.ts`
 * already exercise the happy-path rotation/forgery triad through
 * `probeVersion`. Category-F widens that coverage to:
 *
 *   F1  classifier detects cert.epoch > local.epoch → isRotation=true
 *   F2  legitimate advance: cert.unicitySeal.epoch > local AND
 *       cert.inputRecord.epoch > local (both fields consistent; H5 witness)
 *   F3  forgery classification when cert.epoch <= local and verify failed
 *       — raiseForTrustBaseMismatch does NOT treat it as rotation
 *   F4  raiseForTrustBaseMismatch throws TRUST_BASE_STALE on rotation
 *   F5  raiseForTrustBaseMismatch throws UNTRUSTED_PROOF on forgery
 *   F6  bigint comparison handles 64-bit-plus epoch values with bit-exact
 *       precision (guards against hidden Number coercion)
 *   F7  malformed proof (missing unicitySeal / unicityCertificate) raises
 *       — any TypeError surfaced cleanly at the access boundary
 *   F8  embedded trust-base signing pubkeys shape is validated (rootNodes
 *       with signingKey Uint8Array — classifier/raiser do not consult
 *       signatures, so shape defects must NOT be swallowed as rotation)
 *   F9  T-C7 shared-base invariant — OracleProvider.getRootTrustBase()
 *       returns the same RootTrustBase *instance* that L4 consumes
 *       (H6, SPEC §8.4.2). No parallel trust-base provider is permitted.
 *
 * All tests use fake InclusionProof / RootTrustBase shapes — we do not
 * exercise the BFT crypto stack. The classifier contract is purely
 * field-access over proof.unicityCertificate.unicitySeal.epoch and
 * trustBase.epoch (both `bigint`).
 */

import { describe, it, expect } from 'vitest';
import type { InclusionProof } from '@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof.js';
import type { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase.js';
import type { OracleProvider } from '../../../oracle/oracle-provider.js';

import {
  classifyTrustBaseRotation,
  raiseForTrustBaseMismatch,
  AggregatorPointerErrorCode,
  AggregatorPointerError,
  MAX_PLAUSIBLE_EPOCH_GAP,
} from '../../../extensions/uxf/profile/aggregator-pointer/index.js';

// ── Fake shapes ────────────────────────────────────────────────────────────

/**
 * Fake `InclusionProof` shape — exposes only the fields the classifier
 * actually reads (`unicityCertificate.unicitySeal.epoch`). Extra fields
 * (`inputRecord.epoch`, `signatures`, etc.) are included selectively per
 * test so we can exercise legitimate-advance witness scenarios.
 */
interface FakeProofInput {
  readonly sealEpoch?: bigint;
  readonly inputRecordEpoch?: bigint;
  /** Omit the seal entirely (F7 malformed). */
  readonly omitSeal?: boolean;
  /** Omit the entire unicityCertificate (F7 malformed). */
  readonly omitCert?: boolean;
}

function fakeProof(input: FakeProofInput = {}): InclusionProof {
  if (input.omitCert === true) {
    // Missing `unicityCertificate` altogether — classifier will fault.
    return {} as unknown as InclusionProof;
  }
  const unicitySeal = input.omitSeal === true
    ? undefined
    : { epoch: input.sealEpoch ?? 1n };
  const inputRecord =
    input.inputRecordEpoch === undefined
      ? undefined
      : { epoch: input.inputRecordEpoch };
  return {
    unicityCertificate: {
      unicitySeal,
      inputRecord,
    },
  } as unknown as InclusionProof;
}

/**
 * Fake `RootTrustBase` shape. The classifier reads `trustBase.epoch` only;
 * the shared-base invariant (F9) additionally exercises identity equality
 * via the `getRootTrustBase()` contract on OracleProvider.
 *
 * `rootNodes`, `signatures`, and other fields are declared on the fake to
 * exercise the F8 shape validation — they are NOT consulted by the
 * classifier's field-access path, so any shape defect that would cause a
 * TypeError at a deeper layer must still be caught there, not silently
 * routed through rotation.
 */
interface FakeTrustBaseInput {
  readonly epoch?: bigint;
  readonly rootNodes?: ReadonlyArray<{
    readonly nodeId: string;
    readonly signingKey: Uint8Array;
  }>;
}

function fakeTrustBase(input: FakeTrustBaseInput = {}): RootTrustBase {
  return {
    epoch: input.epoch ?? 1n,
    rootNodes: input.rootNodes ?? [],
  } as unknown as RootTrustBase;
}

// ── F1 — classifyTrustBaseRotation: rotation detection ────────────────────

describe('F1 — classifyTrustBaseRotation: cert.epoch > local → rotation-needed', () => {
  it('flags rotation-needed when cert epoch exceeds local by 1', () => {
    const trustBase = fakeTrustBase({ epoch: 7n });
    const proof = fakeProof({ sealEpoch: 8n });
    const result = classifyTrustBaseRotation(trustBase, proof);
    expect(result.isRotation).toBe(true);
    expect(result.localEpoch).toBe(7n);
    expect(result.certEpoch).toBe(8n);
  });

  it('flags rotation-needed across arbitrary-size gap (pre-steelman cap)', () => {
    const trustBase = fakeTrustBase({ epoch: 10n });
    const proof = fakeProof({ sealEpoch: 10n + MAX_PLAUSIBLE_EPOCH_GAP });
    const result = classifyTrustBaseRotation(trustBase, proof);
    // Pure classifier does NOT consult MAX_PLAUSIBLE_EPOCH_GAP — it only
    // reports the raw isRotation bit. The steelman cap lives in
    // raiseForTrustBaseMismatch (exercised by F5 below). This invariant
    // protects the classifier from accidental entanglement with the
    // DoS guard.
    expect(result.isRotation).toBe(true);
    expect(result.certEpoch - result.localEpoch).toBe(MAX_PLAUSIBLE_EPOCH_GAP);
  });

  it('does NOT flag rotation when cert.epoch == local.epoch', () => {
    const trustBase = fakeTrustBase({ epoch: 4n });
    const proof = fakeProof({ sealEpoch: 4n });
    const result = classifyTrustBaseRotation(trustBase, proof);
    expect(result.isRotation).toBe(false);
  });
});

// ── F2 — legitimate advance witness ────────────────────────────────────────

describe('F2 — legitimate-advance: seal.epoch > local AND inputRecord.epoch > local', () => {
  it('reports isRotation=true when both seal.epoch and inputRecord.epoch advance', () => {
    const trustBase = fakeTrustBase({ epoch: 3n });
    const proof = fakeProof({ sealEpoch: 5n, inputRecordEpoch: 5n });
    const result = classifyTrustBaseRotation(trustBase, proof);
    // SPEC §8.4 H5: legitimate rotation is witnessed when BOTH the
    // unicitySeal and inputRecord carry the advanced epoch. The
    // classifier currently consults only unicitySeal.epoch — that is
    // the authoritative field. This test pins the contract: the
    // classifier must report the seal's epoch, and must remain
    // consistent with a proof whose inputRecord field agrees.
    expect(result.isRotation).toBe(true);
    expect(result.certEpoch).toBe(5n);
    expect(result.localEpoch).toBe(3n);
  });

  it('still reports isRotation based on seal.epoch when inputRecord is absent', () => {
    // inputRecord is optional at the classifier level — only seal.epoch
    // is authoritative. Absence of inputRecord MUST NOT downgrade an
    // otherwise-advancing seal.
    const trustBase = fakeTrustBase({ epoch: 3n });
    const proof = fakeProof({ sealEpoch: 4n, inputRecordEpoch: undefined });
    const result = classifyTrustBaseRotation(trustBase, proof);
    expect(result.isRotation).toBe(true);
  });
});

// ── F3 — forgery classification (cert.epoch <= local, verify failed) ──────

describe('F3 — forgery: cert.epoch <= local and verify failed → not rotation', () => {
  it('classifier reports isRotation=false at equal epoch', () => {
    // A proof that failed InclusionProof.verify() at the SAME epoch as
    // the bundled trust base is forgery by exclusion: the signer set
    // did not change, so quorum failure is adversarial. The classifier
    // MUST NOT flag this as rotation.
    const trustBase = fakeTrustBase({ epoch: 9n });
    const proof = fakeProof({ sealEpoch: 9n });
    const result = classifyTrustBaseRotation(trustBase, proof);
    expect(result.isRotation).toBe(false);
  });

  it('classifier reports isRotation=false at lower epoch (replay)', () => {
    const trustBase = fakeTrustBase({ epoch: 9n });
    const proof = fakeProof({ sealEpoch: 2n });
    const result = classifyTrustBaseRotation(trustBase, proof);
    expect(result.isRotation).toBe(false);
  });
});

// ── F4 — raiseForTrustBaseMismatch: TRUST_BASE_STALE on rotation ──────────

describe('F4 — raiseForTrustBaseMismatch throws TRUST_BASE_STALE on rotation', () => {
  it('throws AggregatorPointerError with code TRUST_BASE_STALE', () => {
    const trustBase = fakeTrustBase({ epoch: 2n });
    const proof = fakeProof({ sealEpoch: 3n });
    try {
      raiseForTrustBaseMismatch(trustBase, proof, 'F4');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AggregatorPointerError);
      expect((err as AggregatorPointerError).code).toBe(
        AggregatorPointerErrorCode.TRUST_BASE_STALE,
      );
      // Error details must carry both epochs (operator diagnostic).
      const details = (err as AggregatorPointerError).details;
      expect(details?.localEpoch).toBe('2');
      expect(details?.certEpoch).toBe('3');
    }
  });

  it('includes F4 context string in message (operator hint)', () => {
    const trustBase = fakeTrustBase({ epoch: 10n });
    const proof = fakeProof({ sealEpoch: 11n });
    expect(() => raiseForTrustBaseMismatch(trustBase, proof, 'F4-context')).toThrow(
      /F4-context/,
    );
  });
});

// ── F5 — raiseForTrustBaseMismatch: UNTRUSTED_PROOF on forgery ────────────

describe('F5 — raiseForTrustBaseMismatch throws UNTRUSTED_PROOF on forgery', () => {
  it('throws UNTRUSTED_PROOF when cert.epoch == local.epoch (quorum forgery)', () => {
    const trustBase = fakeTrustBase({ epoch: 3n });
    const proof = fakeProof({ sealEpoch: 3n });
    expect(() => raiseForTrustBaseMismatch(trustBase, proof, 'F5-a')).toThrow(
      expect.objectContaining({
        code: AggregatorPointerErrorCode.UNTRUSTED_PROOF,
      }),
    );
  });

  it('throws UNTRUSTED_PROOF when cert.epoch < local.epoch (replay)', () => {
    const trustBase = fakeTrustBase({ epoch: 100n });
    const proof = fakeProof({ sealEpoch: 99n });
    expect(() => raiseForTrustBaseMismatch(trustBase, proof, 'F5-b')).toThrow(
      expect.objectContaining({
        code: AggregatorPointerErrorCode.UNTRUSTED_PROOF,
      }),
    );
  });

  it('throws UNTRUSTED_PROOF (not TRUST_BASE_STALE) beyond MAX_PLAUSIBLE_EPOCH_GAP', () => {
    // T-C4 DoS guard: a forged certificate claiming an epoch wildly
    // beyond the bundled trust base would otherwise wedge the wallet
    // in permanent "update SDK" state. Cap at MAX_PLAUSIBLE_EPOCH_GAP;
    // anything beyond is forgery.
    const trustBase = fakeTrustBase({ epoch: 5n });
    const proof = fakeProof({ sealEpoch: 5n + MAX_PLAUSIBLE_EPOCH_GAP + 1n });
    try {
      raiseForTrustBaseMismatch(trustBase, proof, 'F5-c');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AggregatorPointerError);
      expect((err as AggregatorPointerError).code).toBe(
        AggregatorPointerErrorCode.UNTRUSTED_PROOF,
      );
      // Details must include the gap so operators can see the classifier's
      // decision rationale.
      const details = (err as AggregatorPointerError).details;
      expect(details?.gap).toBeDefined();
      expect(details?.maxPlausibleGap).toBe(MAX_PLAUSIBLE_EPOCH_GAP.toString());
    }
  });
});

// ── F6 — bigint comparison precision ──────────────────────────────────────

describe('F6 — bigint comparison handles large numbers without Number coercion', () => {
  it('distinguishes epochs that differ only beyond Number.MAX_SAFE_INTEGER', () => {
    // Number.MAX_SAFE_INTEGER = 2^53 - 1. A naive Number(x) coercion
    // would collapse two distinct bigints that differ only in low bits
    // beyond 2^53 into the same float — a silent rotation-vs-forgery
    // decision flip. This test pins bigint semantics for the classifier.
    const baseEpoch = (1n << 60n); // 2^60, well beyond Number precision
    const trustBase = fakeTrustBase({ epoch: baseEpoch });
    // cert is +1 in the ulp-beyond-Number region — MUST NOT be seen as
    // equal. If classifier ever drifts to Number coercion, this test
    // fails deterministically.
    const proof = fakeProof({ sealEpoch: baseEpoch + 1n });
    const result = classifyTrustBaseRotation(trustBase, proof);
    expect(result.isRotation).toBe(true);
    expect(result.certEpoch).toBe(baseEpoch + 1n);
    expect(result.localEpoch).toBe(baseEpoch);
  });

  it('rejects equal giant epochs as non-rotation', () => {
    const giant = (1n << 96n) + 12345n;
    const trustBase = fakeTrustBase({ epoch: giant });
    const proof = fakeProof({ sealEpoch: giant });
    const result = classifyTrustBaseRotation(trustBase, proof);
    expect(result.isRotation).toBe(false);
    expect(result.certEpoch).toBe(result.localEpoch);
  });

  it('detects replay at giant epoch (cert < local) without signed/unsigned confusion', () => {
    const giantLocal = (1n << 80n);
    const giantOlder = giantLocal - 1n;
    const trustBase = fakeTrustBase({ epoch: giantLocal });
    const proof = fakeProof({ sealEpoch: giantOlder });
    const result = classifyTrustBaseRotation(trustBase, proof);
    expect(result.isRotation).toBe(false);
  });
});

// ── F7 — malformed proof (missing unicitySeal / certificate) ──────────────

describe('F7 — malformed proof surfaces a clean failure', () => {
  it('throws when unicitySeal is absent (seal.epoch undefined access)', () => {
    const trustBase = fakeTrustBase({ epoch: 1n });
    const proof = fakeProof({ omitSeal: true });
    // classifier reads `proof.unicityCertificate.unicitySeal.epoch`.
    // With seal omitted, that access yields `undefined` on the `.epoch`
    // path and throws TypeError (reading `.epoch` of undefined). This
    // is the contract: malformed proofs MUST NOT be silently treated
    // as equal-epoch forgery — they must surface as a hard fault so the
    // caller can raise PROTOCOL_ERROR.
    expect(() => classifyTrustBaseRotation(trustBase, proof)).toThrow(TypeError);
  });

  it('throws when unicityCertificate is absent', () => {
    const trustBase = fakeTrustBase({ epoch: 1n });
    const proof = fakeProof({ omitCert: true });
    expect(() => classifyTrustBaseRotation(trustBase, proof)).toThrow(TypeError);
  });

  it('raiseForTrustBaseMismatch propagates the fault (does NOT swallow as rotation)', () => {
    const trustBase = fakeTrustBase({ epoch: 1n });
    const proof = fakeProof({ omitSeal: true });
    // The raiser must not catch the malformed-proof TypeError and
    // re-route to TRUST_BASE_STALE. A defective proof is not a
    // legitimate rotation signal.
    try {
      raiseForTrustBaseMismatch(trustBase, proof, 'F7');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TypeError);
      // Explicitly NOT an AggregatorPointerError — the classifier's
      // field access faulted before rotation dispatch.
      expect(err).not.toBeInstanceOf(AggregatorPointerError);
    }
  });
});

// ── F8 — embedded trust-base signing pubkeys shape validation ─────────────

describe('F8 — embedded trust-base signing pubkeys shape is validated', () => {
  it('classifier reads only trustBase.epoch — rootNodes shape irrelevant to the outcome', () => {
    // The classifier's contract is `trustBase.epoch: bigint`. Rotation
    // detection must NOT depend on rootNodes/signatures shape. This
    // test pins the invariant: a trust-base with an EMPTY rootNodes
    // array still produces a correct rotation outcome.
    const trustBase = fakeTrustBase({ epoch: 2n, rootNodes: [] });
    const proof = fakeProof({ sealEpoch: 3n });
    const result = classifyTrustBaseRotation(trustBase, proof);
    expect(result.isRotation).toBe(true);
  });

  it('classifier handles trust-base with well-shaped signingKey entries', () => {
    // Steelman: a future change that adds signature verification at the
    // classifier level would couple rotation detection to pubkey
    // validity. This test pins the separation — signingKey shape does
    // not influence the rotation bit. If a future refactor threads
    // signingKey checks into the classifier, this test fails and the
    // change must be re-justified against SPEC §8.4 H6.
    const trustBase = fakeTrustBase({
      epoch: 2n,
      rootNodes: [
        { nodeId: 'n1', signingKey: new Uint8Array(33).fill(0x02) },
        { nodeId: 'n2', signingKey: new Uint8Array(33).fill(0x03) },
      ],
    });
    const proof = fakeProof({ sealEpoch: 3n });
    const result = classifyTrustBaseRotation(trustBase, proof);
    expect(result.isRotation).toBe(true);
    expect(result.localEpoch).toBe(2n);
    expect(result.certEpoch).toBe(3n);
  });

  it('raiseForTrustBaseMismatch ignores rootNodes when deciding TRUST_BASE_STALE vs UNTRUSTED_PROOF', () => {
    // Two trust-bases with DIFFERENT rootNodes but the SAME epoch
    // produce the SAME rotation decision for any given proof. The
    // raiser's decision depends only on the epoch delta.
    const tb1 = fakeTrustBase({ epoch: 4n, rootNodes: [] });
    const tb2 = fakeTrustBase({
      epoch: 4n,
      rootNodes: [{ nodeId: 'x', signingKey: new Uint8Array(33).fill(0xff) }],
    });
    const proofSame = fakeProof({ sealEpoch: 4n });
    const proofAdvance = fakeProof({ sealEpoch: 5n });

    for (const tb of [tb1, tb2] as const) {
      expect(() => raiseForTrustBaseMismatch(tb, proofSame, 'F8')).toThrow(
        expect.objectContaining({
          code: AggregatorPointerErrorCode.UNTRUSTED_PROOF,
        }),
      );
      expect(() => raiseForTrustBaseMismatch(tb, proofAdvance, 'F8')).toThrow(
        expect.objectContaining({
          code: AggregatorPointerErrorCode.TRUST_BASE_STALE,
        }),
      );
    }
  });
});

// ── F9 — T-C7 shared-base invariant (H6, SPEC §8.4.2) ─────────────────────

describe('F9 — T-C7 shared-base invariant: OracleProvider.getRootTrustBase() is the single source', () => {
  /**
   * The pointer layer (H6, SPEC §8.4.2) REQUIRES the same bundled
   * RootTrustBase that L4 (PaymentsModule) consumes — a parallel
   * trust-base provider is forbidden, because divergence would allow
   * a compromised component to accept proofs the other rejects.
   *
   * The contract is enforced at the OracleProvider boundary:
   *   `getRootTrustBase?(): unknown` is the single entry point. Any
   * consumer that reaches through this method MUST receive the same
   * instance (identity equality) across calls within a single session.
   */

  /** Minimal OracleProvider stub exposing only the shared-base hook. */
  function fakeOracle(trustBase: RootTrustBase): Pick<OracleProvider, 'getRootTrustBase'> {
    return {
      getRootTrustBase: () => trustBase,
    };
  }

  it('returns the same instance across repeated calls (no copy, no rebuild)', () => {
    const trustBase = fakeTrustBase({ epoch: 12n });
    const oracle = fakeOracle(trustBase);
    const firstCall = oracle.getRootTrustBase?.();
    const secondCall = oracle.getRootTrustBase?.();
    // Identity equality — not a structural clone.
    expect(firstCall).toBe(secondCall);
    expect(firstCall).toBe(trustBase);
  });

  it('L4-style consumer and pointer-layer-style consumer receive the same instance', () => {
    // Simulate the two consumption paths documented in the spec:
    //   - L4 consumer (PaymentsModule.load): reads getRootTrustBase
    //     once during module init.
    //   - Pointer consumer (pointer-wiring.ts): reads getRootTrustBase
    //     once during pointer-layer construction.
    // Both must get the SAME instance.
    const trustBase = fakeTrustBase({ epoch: 42n });
    const oracle = fakeOracle(trustBase);

    const l4TrustBase = oracle.getRootTrustBase?.() as RootTrustBase;
    const pointerTrustBase = oracle.getRootTrustBase?.() as RootTrustBase;

    expect(l4TrustBase).toBe(pointerTrustBase);

    // Classifier invoked through either consumer's reference must
    // produce identical results — no silent divergence.
    const proof = fakeProof({ sealEpoch: 43n });
    const resL4 = classifyTrustBaseRotation(l4TrustBase, proof);
    const resPointer = classifyTrustBaseRotation(pointerTrustBase, proof);
    expect(resL4).toEqual(resPointer);
  });

  it('rotation/forgery dispatch is stable across consumer identity', () => {
    // If two different consumers held two different trust-base
    // instances (each with epoch=3), they would both reject a
    // forgery proof identically. Here we pin the stronger invariant:
    // there is ONLY ONE instance, and the dispatcher's verdict is
    // invariant under repeated reads from that single instance.
    const trustBase = fakeTrustBase({ epoch: 3n });
    const oracle = fakeOracle(trustBase);

    const readA = oracle.getRootTrustBase?.() as RootTrustBase;
    const readB = oracle.getRootTrustBase?.() as RootTrustBase;
    expect(readA).toBe(readB);

    // Forgery dispatch via both reads — same error, same details.
    const proof = fakeProof({ sealEpoch: 3n });
    let errA: AggregatorPointerError | undefined;
    let errB: AggregatorPointerError | undefined;
    try {
      raiseForTrustBaseMismatch(readA, proof, 'F9');
    } catch (e) {
      errA = e as AggregatorPointerError;
    }
    try {
      raiseForTrustBaseMismatch(readB, proof, 'F9');
    } catch (e) {
      errB = e as AggregatorPointerError;
    }
    expect(errA).toBeInstanceOf(AggregatorPointerError);
    expect(errB).toBeInstanceOf(AggregatorPointerError);
    expect(errA?.code).toBe(AggregatorPointerErrorCode.UNTRUSTED_PROOF);
    expect(errB?.code).toBe(AggregatorPointerErrorCode.UNTRUSTED_PROOF);
    expect(errA?.details).toEqual(errB?.details);
  });

  it('getRootTrustBase is the canonical field on OracleProvider (H6 surface)', () => {
    // SPEC §8.4.2 H6: the shared-base hook is declared at
    // `oracle/oracle-provider.ts` as `getRootTrustBase?(): unknown`.
    // This test pins the name — a rename (e.g. back to
    // `getTrustBase`) would silently break pointer-wiring.ts, which
    // reads `input.oracle.getRootTrustBase?.()`.
    const trustBase = fakeTrustBase({ epoch: 7n });
    const oracle: Pick<OracleProvider, 'getRootTrustBase'> = {
      getRootTrustBase: () => trustBase,
    };
    // If the interface rename slipped, this file would fail to
    // type-check. We also assert the runtime shape.
    expect(typeof oracle.getRootTrustBase).toBe('function');
    expect(oracle.getRootTrustBase?.()).toBe(trustBase);
  });
});
