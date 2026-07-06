/**
 * T.8.E.2 — Cross-mode compatibility: UXF sender ↔ TXF-only recipient.
 *
 * **Scenario**: a modern (post-T.7.A) sender ships a UXF v1.0 envelope
 * (`kind: 'uxf-car'` or `kind: 'uxf-cid'`) on the wire. The recipient is a
 * pre-UXF "TXF-only" wallet: its `decodeTokenTransfer` consumes EXCLUSIVELY
 * the four §3.4 legacy shapes. What outcome does the recipient produce?
 *
 * **Documented choice (per §3.4 + §10.2)**: a TXF-only recipient SHOULD NOT
 * silently mis-classify a UXF envelope as legacy. The contract is enforced
 * by two invariants both verified here:
 *
 *  1. **Type guard**: `isLegacyTokenTransferPayload(uxfPayload)` MUST
 *     return `false` for any well-formed UXF v1.0 envelope. The legacy
 *     detector only matches the four documented structural discriminators
 *     (`type === 'COMBINED_TRANSFER'`, `type === 'INSTANT_SPLIT'`,
 *     `sourceToken && transferTx`, `token && proof`). The `kind: 'uxf-…'`
 *     discriminator is alien to legacy code; it neither matches any of
 *     the four nor offers a fallback path.
 *
 *  2. **Adapter rejection**: even if a malicious caller forced the UXF
 *     envelope through the T.7.B legacy-shape adapter (which a TXF-only
 *     recipient does NOT have, but which models the strictest possible
 *     "recognize-or-reject" policy), the adapter rejects with
 *     `VALIDATION_ERROR` rather than producing a synthetic disposition.
 *     The error message instructs the caller to route through
 *     `acquireBundle` instead — this is the §10.2 single-pipeline rule
 *     surfaced as a typed error.
 *
 * **Why this is the right behavior** (vs. silent fallback): the §3.4
 * detection precedence places UXF FIRST (`isUxfTransferPayload` before
 * `isLegacyTokenTransferPayload` in any recipient hot path). A TXF-only
 * recipient has no UXF detection — so on receipt of a UXF event, the
 * recipient's decoder yields `null` / "unknown shape" and the message
 * is dropped at the transport layer (or surfaces as a forensic
 * `_invalid` record at the integration layer). The wire contract here
 * is "pre-UXF wallets do not see UXF traffic"; a sender that suspects
 * its peer is pre-UXF MUST opt into `transferMode: 'txf'` (enforced by
 * the T.8.B capability hint warning, separately tested).
 *
 * **Scope of this test**:
 *  - Build a real UXF `uxf-car` payload via the T.4.A `transfer-payload`
 *    helpers (real CAR bytes, real bundleCid).
 *  - Build a real UXF `uxf-cid` payload (force-cid envelope).
 *  - Assert each tripped through `isLegacyTokenTransferPayload` is
 *    rejected (`false`).
 *  - Assert each pushed through `adaptLegacyShape` raises
 *    `VALIDATION_ERROR` with the documented diagnostic.
 *  - Assert the legacy adapter's `classifyLegacyShape` returns `null`
 *    for both shapes (no false-positive classification).
 *
 * **Not in scope**:
 *  - The UXF sender's full pipeline (covered by `instant-sender.test.ts`,
 *    `conservative-sender.test.ts`).
 *  - Capability-hint warnings (covered by `capability-hint-warning.test.ts`
 *    in this same compatibility suite).
 *  - The full transport-layer drop semantics — that path runs through
 *    `NostrTransportProvider.test.ts`.
 *
 * Spec references:
 *  - §3.4   Legacy shape detection (the negative space — what UXF is NOT).
 *  - §10.2  Single-pipeline convergence (UXF and legacy share §5.3).
 *  - §10.4  Forward-compat — older wallets stay on TXF.
 *
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';

import {
  adaptLegacyShape,
  classifyLegacyShape,
} from '../../../extensions/uxf/pipeline/legacy-shape-adapter';
import { isSphereError } from '../../../core/errors';
import {
  isLegacyTokenTransferPayload,
  isUxfTransferPayload,
  isUxfTransferPayloadCar,
  isUxfTransferPayloadCid,
  type UxfTransferPayloadCar,
  type UxfTransferPayloadCid,
  type LegacyTokenTransferPayload,
} from '../../../extensions/uxf/types/uxf-transfer';
import {
  carBytesToBase64,
  extractCarRootCid,
} from '../../../extensions/uxf/bundle/transfer-payload';
import { UxfPackage } from '../../../extensions/uxf/bundle/UxfPackage';
import type { ContinuityResult, TxLike } from '../../../extensions/uxf/pipeline/continuity-walker';
import type { EvaluatePredicateResult } from '../../../extensions/uxf/pipeline/predicate-evaluator';
import type { ProofVerifyStatus } from '../../../extensions/uxf/pipeline/proof-verifier';
import type { VerifyAuthenticatorResult } from '../../../extensions/uxf/pipeline/authenticator-verifier';

import { TOKEN_A } from '../../fixtures/uxf-mock-tokens';

// =============================================================================
// 1. Test fixtures — produce real UXF v1.0 envelopes
// =============================================================================

const TOKEN_A_ID =
  'aa00000000000000000000000000000000000000000000000000000000000001';
const SENDER_PUBKEY = 'fe'.repeat(32);
const PUBKEY_BYTES = (() => {
  const k = new Uint8Array(33);
  k[0] = 0x02;
  return k;
})();

interface UxfArtifacts {
  readonly carBytes: Uint8Array;
  readonly bundleCid: string;
  readonly carPayload: UxfTransferPayloadCar;
  readonly cidPayload: UxfTransferPayloadCid;
}

async function buildUxfArtifacts(): Promise<UxfArtifacts> {
  const pkg = UxfPackage.create();
  pkg.ingestAll([TOKEN_A as unknown as Record<string, unknown>]);
  const carBytes = await pkg.toCar();
  const bundleCid = await extractCarRootCid(carBytes);
  const carPayload: UxfTransferPayloadCar = {
    kind: 'uxf-car',
    version: '1.0',
    mode: 'instant',
    bundleCid,
    tokenIds: [TOKEN_A_ID],
    carBase64: carBytesToBase64(carBytes),
    sender: { transportPubkey: SENDER_PUBKEY },
  };
  const cidPayload: UxfTransferPayloadCid = {
    kind: 'uxf-cid',
    version: '1.0',
    mode: 'instant',
    bundleCid,
    tokenIds: [TOKEN_A_ID],
    sender: { transportPubkey: SENDER_PUBKEY },
  };
  return { carBytes, bundleCid, carPayload, cidPayload };
}

function happyHooks(): {
  readonly evaluatePredicate: () => Promise<EvaluatePredicateResult>;
  readonly verifyAuthenticator: () => Promise<VerifyAuthenticatorResult>;
  readonly walkContinuity: (chain: ReadonlyArray<TxLike>) => ContinuityResult;
  readonly verifyProof: () => Promise<ProofVerifyStatus>;
  readonly oracleIsSpent: (stateHash: string) => Promise<boolean>;
  readonly readLocalManifest: () => Promise<undefined>;
} {
  return {
    evaluatePredicate: async () => ({ ok: true, bindsToUs: true }),
    verifyAuthenticator: async () => ({ ok: true, valid: true }),
    walkContinuity: () => ({ ok: true }),
    verifyProof: async () => 'OK' as ProofVerifyStatus,
    oracleIsSpent: async () => false,
    readLocalManifest: async () => undefined,
  };
}

// =============================================================================
// 2. Type-guard rejection — the first line of defense
// =============================================================================

describe('UXF sender → TXF-only recipient — type-guard rejection', () => {
  it('a real uxf-car payload is REJECTED by isLegacyTokenTransferPayload', async () => {
    const { carPayload } = await buildUxfArtifacts();
    // Sanity: it IS a valid UXF v1.0 payload.
    expect(isUxfTransferPayload(carPayload)).toBe(true);
    expect(isUxfTransferPayloadCar(carPayload)).toBe(true);
    // Acceptance (1): NOT a legacy shape — TXF-only decoders see "unknown".
    expect(
      isLegacyTokenTransferPayload(carPayload as unknown as LegacyTokenTransferPayload),
    ).toBe(false);
  });

  it('a real uxf-cid payload is REJECTED by isLegacyTokenTransferPayload', async () => {
    const { cidPayload } = await buildUxfArtifacts();
    expect(isUxfTransferPayload(cidPayload)).toBe(true);
    expect(isUxfTransferPayloadCid(cidPayload)).toBe(true);
    expect(
      isLegacyTokenTransferPayload(cidPayload as unknown as LegacyTokenTransferPayload),
    ).toBe(false);
  });

  it('classifyLegacyShape returns null for both UXF kinds — no false-positive shape pinning', async () => {
    const { carPayload, cidPayload } = await buildUxfArtifacts();
    expect(classifyLegacyShape(carPayload)).toBeNull();
    expect(classifyLegacyShape(cidPayload)).toBeNull();
  });

  it('does NOT mis-classify by structural overlap (UXF carries no sourceToken/transferTx)', async () => {
    // Defensive: confirm the UXF payload does not accidentally satisfy
    // any of the legacy structural discriminators. A regression in the
    // type guard could otherwise let UXF traffic leak into the legacy
    // §5.3 path on a pre-UXF wallet.
    const { carPayload } = await buildUxfArtifacts();
    const obj = carPayload as unknown as Record<string, unknown>;
    expect(obj.sourceToken).toBeUndefined();
    expect(obj.transferTx).toBeUndefined();
    expect(obj.token).toBeUndefined();
    expect(obj.proof).toBeUndefined();
    expect(obj.type).not.toBe('COMBINED_TRANSFER');
    expect(obj.type).not.toBe('INSTANT_SPLIT');
  });
});

// =============================================================================
// 3. Adapter-level rejection — the last line of defense
// =============================================================================

describe('UXF sender → TXF-only recipient — adapter rejection', () => {
  it('adaptLegacyShape throws VALIDATION_ERROR for a uxf-car payload', async () => {
    const { carPayload } = await buildUxfArtifacts();

    let caught: unknown;
    try {
      await adaptLegacyShape({
        // The cast is the entire point — we are simulating the worst-case
        // mis-routing where a caller bypasses the type guard. The adapter
        // is the runtime safety net.
        payload: carPayload as unknown as LegacyTokenTransferPayload,
        senderTransportPubkey: SENDER_PUBKEY,
        ourPubkey: PUBKEY_BYTES,
        trustBase: {} as unknown,
        extractTxLegacyChain: async () => [],
        ...happyHooks(),
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(isSphereError(caught)).toBe(true);
    if (isSphereError(caught)) {
      expect(caught.code).toBe('VALIDATION_ERROR');
      // The diagnostic guides the caller to the correct pipeline.
      expect(caught.message).toContain('acquireBundle');
    }
  });

  it('adaptLegacyShape throws VALIDATION_ERROR for a uxf-cid payload', async () => {
    const { cidPayload } = await buildUxfArtifacts();

    let caught: unknown;
    try {
      await adaptLegacyShape({
        payload: cidPayload as unknown as LegacyTokenTransferPayload,
        senderTransportPubkey: SENDER_PUBKEY,
        ourPubkey: PUBKEY_BYTES,
        trustBase: {} as unknown,
        extractTxLegacyChain: async () => [],
        ...happyHooks(),
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(isSphereError(caught)).toBe(true);
    if (isSphereError(caught)) {
      expect(caught.code).toBe('VALIDATION_ERROR');
    }
  });

  it('hook is NOT invoked when the payload fails shape recognition (early-exit)', async () => {
    // The adapter classifies the shape BEFORE calling the
    // extractTxLegacyChain hook. A UXF envelope must reach the typed
    // throw without producing any side-effects on the SDK boundary.
    const { carPayload } = await buildUxfArtifacts();
    let hookInvocations = 0;
    let caught: unknown;
    try {
      await adaptLegacyShape({
        payload: carPayload as unknown as LegacyTokenTransferPayload,
        senderTransportPubkey: SENDER_PUBKEY,
        ourPubkey: PUBKEY_BYTES,
        trustBase: {} as unknown,
        extractTxLegacyChain: async () => {
          hookInvocations++;
          return [];
        },
        ...happyHooks(),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(hookInvocations).toBe(0);
  });
});

// =============================================================================
// 4. Documented contract: a fresh UXF bundle is byte-roundable
// =============================================================================

describe('UXF sender — sanity check on the constructed bundle', () => {
  it('the constructed CAR roundtrips through extractCarRootCid', async () => {
    // Sanity that our test fixture is producing a real, well-formed UXF
    // bundle — not a malformed envelope that happens to fail legacy
    // detection for the wrong reason.
    const { carBytes, bundleCid } = await buildUxfArtifacts();
    expect(carBytes.byteLength).toBeGreaterThan(0);
    const reExtracted = await extractCarRootCid(carBytes);
    expect(reExtracted).toBe(bundleCid);
  });
});
