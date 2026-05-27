/**
 * Category-E conformance tests — aggregator pointer-layer probe/classify
 * surface per SPEC §8.1 (probeVersion), §8.2 (classifyVersion +
 * decodeVersionCid), §10.2 (isReachable).
 *
 * Scope (E1–E13, plus E5b): complement — not duplicate —
 *   tests/unit/profile/pointer/aggregator-probe.test.ts.
 *
 * That file exercises the happy-path matrix and a handful of edge cases.
 * This file hardens the semantic boundaries that the existing tests do
 * not pin down, emphasising:
 *
 *   - probeVersion's H2 OR-predicate (symmetric over sides A / B) and
 *     its epoch-discrimination behaviour at the trust-base boundary
 *   - classifyVersion's four-way VALID / SEMANTICALLY_INVALID /
 *     PROOF_TRANSIENT / CAR_TRANSIENT discriminator (including the
 *     E5b partial-inclusion case that arises from an attacker
 *     poisoning exactly one of the two shares)
 *   - decodeVersionCid's Phase 1+2 standalone semantics — it MUST NOT
 *     touch the CAR fetcher and MUST carry the exact three-way
 *     outcome discrimination as its classify sibling
 *   - isReachable's strict distinction between "any HTTP response"
 *     (reachable — PATH_NOT_INCLUDED counts) vs. "network-level
 *     failure" (unreachable)
 *
 * Every test names its obligation in a top-level describe block.
 * Fixtures follow the fakeClient / fakeProof pattern established by
 * the existing unit file so that a breakage of the stub shape
 * surfaces uniformly across both.
 *
 * Level: unit — no network, no Profile init, no OrbitDB, no IPFS.
 */

import { describe, it, expect, vi } from 'vitest';
import { InclusionProofVerificationStatus } from '@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof.js';
import type { InclusionProof } from '@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof.js';
import { InclusionProofResponse } from '@unicitylabs/state-transition-sdk/lib/api/InclusionProofResponse.js';
import type { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
import type { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase.js';

import {
  probeVersion,
  classifyVersion,
  decodeVersionCid,
  isReachable,
  AggregatorPointerErrorCode,
  derivePointerKeyMaterial,
  buildPointerSigner,
  createMasterPrivateKey,
  type CidDecoder,
  type CarFetcher,
} from '../../../profile/aggregator-pointer/index.js';

// ── Fixtures (mirror aggregator-probe.test.ts shape intentionally) ─────────

/** Wallet seed — distinct from the existing file's 0x42 so a cross-bleed of
 *  cached KAT vectors between suites surfaces as a fixture-drift failure
 *  rather than a silent green. */
const WALLET_SEED = new Uint8Array(32).fill(0x5e);

async function buildFixtures() {
  const masterKey = createMasterPrivateKey(WALLET_SEED);
  const keyMaterial = derivePointerKeyMaterial(masterKey);
  const signer = await buildPointerSigner(keyMaterial.signingSeed);
  return { keyMaterial, signer };
}

/**
 * Build a fake InclusionProof-like object. We stub `.verify()` directly.
 * The transactionHash.data field is the 32-byte XOR ciphertext consumed
 * by decodeVersionCid / classifyVersion Phase 2; a non-null default is
 * supplied so the Phase-2 XOR path runs to completion unless explicitly
 * nulled out.
 */
function fakeProof(
  verifyResult: InclusionProofVerificationStatus,
  certEpoch: bigint = 1n,
  transactionHashData: Uint8Array | null = new Uint8Array(32).fill(0x01),
): InclusionProof {
  return {
    verify: vi.fn(async () => verifyResult),
    transactionHash:
      transactionHashData === null
        ? null
        : { data: transactionHashData, imprint: new Uint8Array([0x00, 0x00, ...transactionHashData]) },
    unicityCertificate: {
      unicitySeal: { epoch: certEpoch },
      inputRecord: { epoch: certEpoch },
    },
  } as unknown as InclusionProof;
}

/**
 * Client that returns a fixed rotation of proofs. One call per side
 * per probe/classify/decode pass. Index wraps so a test that fires two
 * probes in sequence against the same fixture array gets the expected
 * round-robin behaviour.
 */
function fakeClient(proofsForRequests: InclusionProof[]): AggregatorClient {
  let idx = 0;
  return {
    getInclusionProof: vi.fn(async () => {
      const proof = proofsForRequests[idx % proofsForRequests.length]!;
      idx += 1;
      return new InclusionProofResponse(proof);
    }),
  } as unknown as AggregatorClient;
}

function fakeTrustBase(epoch: bigint = 1n): RootTrustBase {
  return { epoch } as RootTrustBase;
}

// ── Common CID / CAR stubs for classify / decode paths ─────────────────────

/** Valid-looking CIDv1 / raw / SHA-256 byte prefix + 32 zero bytes. */
const validCid = new Uint8Array([0x01, 0x55, 0x12, 0x20, ...new Array(32).fill(0x00)]);

const okDecoder: CidDecoder = () => ({ ok: true, cidBytes: validCid });
const failDecoder: CidDecoder = () => ({ ok: false });

// Note: the "happy-path" CAR fetcher is provided via `spyFetcher()` below
// whenever a test also needs to assert call-count. The three explicit
// failure-kind fetchers are the three failure shapes for E6 / E7 / E8.
const transientFetcher: CarFetcher = async () => ({ ok: false, kind: 'transient_unavailable' });
const contentMismatchFetcher: CarFetcher = async () => ({ ok: false, kind: 'content_mismatch' });
const carParseFetcher: CarFetcher = async () => ({ ok: false, kind: 'car_parse_failed' });

/** Fetcher spy — lets a test assert the CAR path was (not) invoked. */
function spyFetcher(): { fetcher: CarFetcher; calls: { count: number } } {
  const calls = { count: 0 };
  const fetcher: CarFetcher = async () => {
    calls.count += 1;
    return { ok: true };
  };
  return { fetcher, calls };
}

// ───────────────────────────────────────────────────────────────────────────
// E1 — probeVersion H2 OR-predicate: EITHER side OK → true
// ───────────────────────────────────────────────────────────────────────────
describe('E1 — probeVersion OR-predicate: either side OK returns true (SPEC §8.1)', () => {
  it('side A OK + side B PATH_NOT_INCLUDED → true (asymmetric OR must see A)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    // Ordering in fakeClient: first call returns proofs[0] (side A),
    // second returns proofs[1] (side B). This pins the OR-predicate's
    // insensitivity to which side verifies.
    const proofA = fakeProof(InclusionProofVerificationStatus.OK);
    const proofB = fakeProof(InclusionProofVerificationStatus.PATH_NOT_INCLUDED);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    await expect(
      probeVersion({ v: 7, keyMaterial, signer, aggregatorClient: client, trustBase }),
    ).resolves.toBe(true);
  });

  it('side A PATH_NOT_INCLUDED + side B OK → true (symmetric partner of above)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.PATH_NOT_INCLUDED);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    await expect(
      probeVersion({ v: 7, keyMaterial, signer, aggregatorClient: client, trustBase }),
    ).resolves.toBe(true);
  });

  it('both sides OK → true (trivial conjunction must not regress the OR-predicate)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.OK);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    await expect(
      probeVersion({ v: 7, keyMaterial, signer, aggregatorClient: client, trustBase }),
    ).resolves.toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E2 — probeVersion returns false when BOTH sides PATH_NOT_INCLUDED
// ───────────────────────────────────────────────────────────────────────────
describe('E2 — probeVersion both-not-included returns false (SPEC §8.1)', () => {
  it('returns false (legitimate non-inclusion, NOT a trust-base event)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.PATH_NOT_INCLUDED);
    const proofB = fakeProof(InclusionProofVerificationStatus.PATH_NOT_INCLUDED);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    const result = await probeVersion({
      v: 42,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase,
    });
    expect(result).toBe(false);
  });

  it('both sides PATH_NOT_INCLUDED MUST NOT raise (legitimate non-inclusion is not an error)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.PATH_NOT_INCLUDED);
    const proofB = fakeProof(InclusionProofVerificationStatus.PATH_NOT_INCLUDED);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    // Steelman: a false-negative "rotation" alarm here would block
    // every discover() pass on a fresh-version probe. Assert that the
    // promise resolves rather than rejects.
    await expect(
      probeVersion({ v: 42, keyMaterial, signer, aggregatorClient: client, trustBase }),
    ).resolves.toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E3 — probeVersion raises TRUST_BASE_STALE when verify failure happens
//      against an epoch advance
// ───────────────────────────────────────────────────────────────────────────
describe('E3 — probeVersion TRUST_BASE_STALE on cert epoch mismatch (SPEC §8.4.1)', () => {
  it('NOT_AUTHENTICATED + certEpoch > localEpoch → TRUST_BASE_STALE (rotation)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.NOT_AUTHENTICATED, 9n);
    // Side B is OK at the same higher epoch — the raise still fires
    // because side A is checked first and short-circuits the OR-predicate.
    const proofB = fakeProof(InclusionProofVerificationStatus.OK, 9n);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase(3n);

    await expect(
      probeVersion({ v: 11, keyMaterial, signer, aggregatorClient: client, trustBase }),
    ).rejects.toMatchObject({ code: AggregatorPointerErrorCode.TRUST_BASE_STALE });
  });

  it('PATH_INVALID + certEpoch > localEpoch → TRUST_BASE_STALE (not UNTRUSTED_PROOF)', async () => {
    // Steelman boundary: PATH_INVALID is structurally distinct from
    // NOT_AUTHENTICATED but the trust-base classifier must collapse
    // both into TRUST_BASE_STALE when the epoch has advanced. If this
    // test flips to UNTRUSTED_PROOF the upper layers will surface a
    // "forgery" alarm for a legitimate rotation — catastrophic UX.
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.PATH_INVALID, 7n);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK, 7n);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase(2n);

    await expect(
      probeVersion({ v: 3, keyMaterial, signer, aggregatorClient: client, trustBase }),
    ).rejects.toMatchObject({ code: AggregatorPointerErrorCode.TRUST_BASE_STALE });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E4 — probeVersion raises UNTRUSTED_PROOF on verify failure without
//      epoch advance (forgery, or a replay from an older epoch)
// ───────────────────────────────────────────────────────────────────────────
describe('E4 — probeVersion UNTRUSTED_PROOF on verify failure at stable epoch (SPEC §8.4.1)', () => {
  it('NOT_AUTHENTICATED at identical epoch → UNTRUSTED_PROOF (forgery)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.NOT_AUTHENTICATED, 4n);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK, 4n);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase(4n);

    await expect(
      probeVersion({ v: 5, keyMaterial, signer, aggregatorClient: client, trustBase }),
    ).rejects.toMatchObject({ code: AggregatorPointerErrorCode.UNTRUSTED_PROOF });
  });

  it('NOT_AUTHENTICATED at OLDER epoch (replay) → UNTRUSTED_PROOF (not STALE)', async () => {
    // Steelman: an older-epoch proof is structurally a replay attempt.
    // It MUST NOT be interpreted as a legitimate rotation (which only
    // runs forward). Classification as TRUST_BASE_STALE would cause
    // the wallet to accept a rotated-root that is actually a replay
    // of a superseded trust base — catastrophic.
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.NOT_AUTHENTICATED, 2n);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK, 2n);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase(8n); // local is FAR AHEAD of cert

    await expect(
      probeVersion({ v: 1, keyMaterial, signer, aggregatorClient: client, trustBase }),
    ).rejects.toMatchObject({ code: AggregatorPointerErrorCode.UNTRUSTED_PROOF });
  });

  it('PATH_INVALID at identical epoch → UNTRUSTED_PROOF (structural forgery)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.OK, 5n);
    const proofB = fakeProof(InclusionProofVerificationStatus.PATH_INVALID, 5n);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase(5n);

    await expect(
      probeVersion({ v: 9, keyMaterial, signer, aggregatorClient: client, trustBase }),
    ).rejects.toMatchObject({ code: AggregatorPointerErrorCode.UNTRUSTED_PROOF });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E5 — classifyVersion is VALID only when the FULL chain succeeds:
//      both sides OK + CID decoder returns ok + CAR fetch returns ok
// ───────────────────────────────────────────────────────────────────────────
describe('E5 — classifyVersion VALID requires full chain (SPEC §8.2)', () => {
  it('all four gates pass → VALID', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.OK);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    const { fetcher, calls } = spyFetcher();
    const result = await classifyVersion({
      v: 12,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase,
      decodeCid: okDecoder,
      fetchCar: fetcher,
    });
    expect(result).toBe('VALID');
    // Steelman spec-tether: VALID MUST exercise Phase 3 exactly once
    // — the CAR fetcher is the content-address binding. Skipping it
    // would let a forged inclusion proof reach VALID if the attacker
    // controls the aggregator.
    expect(calls.count).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E5b — classifyVersion is SEMANTICALLY_INVALID on partial inclusion
//       (one side OK, other PATH_NOT_INCLUDED). This is stricter than
//       probeVersion's OR-predicate.
// ───────────────────────────────────────────────────────────────────────────
describe('E5b — classifyVersion partial-inclusion is SEMANTICALLY_INVALID (SPEC §8.2)', () => {
  it('side A OK, side B PATH_NOT_INCLUDED → SEMANTICALLY_INVALID', async () => {
    // Steelman: probeVersion would return TRUE here (OR-predicate).
    // classifyVersion MUST return SEMANTICALLY_INVALID — the XOR
    // plaintext would be truncated and the CID unreconstructable.
    // A VALID result here means an attacker could publish ONE side
    // and watch classifyVersion accept a torn pointer. The whole
    // point of the H1/H2 distinction is that classify is stricter.
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.OK);
    const proofB = fakeProof(InclusionProofVerificationStatus.PATH_NOT_INCLUDED);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    const { fetcher, calls } = spyFetcher();
    const result = await classifyVersion({
      v: 12,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase,
      decodeCid: okDecoder,
      fetchCar: fetcher,
    });
    expect(result).toBe('SEMANTICALLY_INVALID');
    // CAR fetch MUST NOT run when a side is missing — no point
    // wasting a network round-trip on an un-reconstructable CID,
    // and a fetch here could leak a probe about a CID the attacker
    // controls.
    expect(calls.count).toBe(0);
  });

  it('side A PATH_NOT_INCLUDED, side B OK → SEMANTICALLY_INVALID (symmetric)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.PATH_NOT_INCLUDED);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    const { fetcher, calls } = spyFetcher();
    const result = await classifyVersion({
      v: 12,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase,
      decodeCid: okDecoder,
      fetchCar: fetcher,
    });
    expect(result).toBe('SEMANTICALLY_INVALID');
    expect(calls.count).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E6 — classifyVersion: proofs VALID + CID decodes, but CAR content
//      does not match the content address → SEMANTICALLY_INVALID
// ───────────────────────────────────────────────────────────────────────────
describe('E6 — classifyVersion CAR content-mismatch → SEMANTICALLY_INVALID (SPEC §8.2)', () => {
  it('CAR fetcher reports content_mismatch → SEMANTICALLY_INVALID', async () => {
    // Steelman: an attacker who controls an IPFS gateway can serve a
    // CAR whose bytes mismatch the requested CID. The fetcher must
    // detect this (via re-hashing the received content against the
    // claimed CID) and we must classify it as semantically invalid
    // — NOT transient. A transient classification would trigger a
    // retry loop that the attacker can just answer the same way.
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.OK);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    const result = await classifyVersion({
      v: 12,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase,
      decodeCid: okDecoder,
      fetchCar: contentMismatchFetcher,
    });
    expect(result).toBe('SEMANTICALLY_INVALID');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E7 — classifyVersion: proofs VALID + CID decodes, but the CAR is
//      unreachable (all gateways 5xx / timeout) → CAR_TRANSIENT
//      (slot EXISTS on-chain; Phase 3 MAY skip past under policy)
// ───────────────────────────────────────────────────────────────────────────
describe('E7 — classifyVersion CAR transient_unavailable → CAR_TRANSIENT (SPEC §8.2)', () => {
  it('CAR fetcher reports transient_unavailable → CAR_TRANSIENT (slot EXISTS, proof verified)', async () => {
    // Distinct from E6: here the token pool might still exist; the
    // caller is expected to retry later. Misclassifying this as
    // SEMANTICALLY_INVALID would prematurely abandon a perfectly
    // valid version. Also distinct from PROOF_TRANSIENT: proof was
    // verified and CID decoded successfully — slot existence is KNOWN.
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.OK);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    const result = await classifyVersion({
      v: 12,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase,
      decodeCid: okDecoder,
      fetchCar: transientFetcher,
    });
    expect(result).toBe('CAR_TRANSIENT');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E8 — classifyVersion: proofs VALID + CID decodes, but CAR parse
//      failed → SEMANTICALLY_INVALID (not TRANSIENT_UNAVAILABLE)
// ───────────────────────────────────────────────────────────────────────────
describe('E8 — classifyVersion CAR car_parse_failed → SEMANTICALLY_INVALID (SPEC §8.2)', () => {
  it('CAR fetcher reports car_parse_failed → SEMANTICALLY_INVALID', async () => {
    // Steelman: car_parse_failed means the bytes ARRIVED but were
    // structurally un-decodable (mangled varints, truncated CAR, etc).
    // A retry would hit the same bytes from the same CID — the
    // failure is deterministic w.r.t. content address. Must be
    // semantic, not transient, so the caller rolls back to an older
    // version instead of spinning.
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.OK);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    const result = await classifyVersion({
      v: 12,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase,
      decodeCid: okDecoder,
      fetchCar: carParseFetcher,
    });
    expect(result).toBe('SEMANTICALLY_INVALID');
  });

  it('CID decoder returning ok:false also yields SEMANTICALLY_INVALID (E8 extension)', async () => {
    // Complementary boundary: if the 64-byte XOR plaintext decodes
    // into something that isn't a valid CID, the chain halts before
    // the CAR fetch. Same classification as a CAR parse failure.
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.OK);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    const { fetcher, calls } = spyFetcher();
    const result = await classifyVersion({
      v: 12,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase,
      decodeCid: failDecoder,
      fetchCar: fetcher,
    });
    expect(result).toBe('SEMANTICALLY_INVALID');
    // Phase 3 must not fire if Phase 2 rejected the plaintext.
    expect(calls.count).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E9 — decodeVersionCid returns cid bytes when both sides verify;
//      MUST NOT touch the CAR fetcher (it isn't even passed in).
// ───────────────────────────────────────────────────────────────────────────
describe('E9 — decodeVersionCid happy path returns cid bytes (SPEC §8.2)', () => {
  it('both sides OK + decoder ok → { ok: true, cidBytes } with cloned buffer', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.OK);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    const result = await decodeVersionCid({
      v: 13,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase,
      decodeCid: okDecoder,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Buffer identity check — runDecodePhases clones the decoder's
      // output so internal zeroization of `full`/`xorKeyA`/`xorKeyB`
      // cannot backfill a shared buffer. A test that pins this
      // invariant here surfaces a reversion immediately.
      expect(result.cidBytes).toBeInstanceOf(Uint8Array);
      expect(result.cidBytes.length).toBe(validCid.length);
      // Content equality.
      expect(Array.from(result.cidBytes)).toEqual(Array.from(validCid));
      // Identity non-equality — MUST be a copy.
      expect(result.cidBytes).not.toBe(validCid);
    }
  });

  it('does NOT invoke any CAR fetcher (Phase-1+2 only contract)', async () => {
    // decodeVersionCid's API intentionally omits fetchCar — this test
    // pins the absence. A future refactor that adds CAR fetching
    // here would blow out the fast-path round-trip budget on the
    // discovery walk.
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.OK);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    // Compile-time check: decodeVersionCid's input type has no fetchCar.
    // Runtime check: ensure the call succeeds without one.
    const result = await decodeVersionCid({
      v: 14,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase,
      decodeCid: okDecoder,
    });
    expect(result.ok).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E10 — decodeVersionCid returns { ok: false, reason: 'transient' } on
//       network-level proof-fetch failure
// ───────────────────────────────────────────────────────────────────────────
describe('E10 — decodeVersionCid transient on proof-fetch network error (SPEC §8.2)', () => {
  it('aggregator client throws → { ok: false, reason: "transient" }', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const client = {
      getInclusionProof: vi.fn(async () => {
        const err = new Error('ECONNRESET');
        err.name = 'AggregatorClientNetworkError';
        throw err;
      }),
    } as unknown as AggregatorClient;
    const trustBase = fakeTrustBase();

    const result = await decodeVersionCid({
      v: 13,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase,
      decodeCid: okDecoder,
    });
    expect(result).toEqual({ ok: false, reason: 'transient' });
  });

  it('aggregator client hangs indefinitely → transient via timeout', async () => {
    // Forces the timeout path (PointerProbeTimeout is NOT
    // PointerProtocolError — it is bucketed as transient by the
    // catch branch in runDecodePhases).
    const { keyMaterial, signer } = await buildFixtures();
    const client = {
      getInclusionProof: vi.fn(
        () =>
          new Promise(() => {
            /* never resolves */
          }),
      ),
    } as unknown as AggregatorClient;
    const trustBase = fakeTrustBase();

    const result = await decodeVersionCid({
      v: 13,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase,
      decodeCid: okDecoder,
      timeoutMs: 10, // short timeout — we want the test to complete fast
    });
    expect(result).toEqual({ ok: false, reason: 'transient' });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E11 — decodeVersionCid returns { ok: false, reason: 'semantic' } on
//       partial inclusion (one side OK, other PATH_NOT_INCLUDED)
// ───────────────────────────────────────────────────────────────────────────
describe('E11 — decodeVersionCid semantic on partial inclusion (SPEC §8.2)', () => {
  it('side A OK, side B PATH_NOT_INCLUDED → { ok: false, reason: "semantic" }', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.OK);
    const proofB = fakeProof(InclusionProofVerificationStatus.PATH_NOT_INCLUDED);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    const result = await decodeVersionCid({
      v: 13,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase,
      decodeCid: okDecoder,
    });
    expect(result).toEqual({ ok: false, reason: 'semantic' });
  });

  it('side A PATH_NOT_INCLUDED, side B OK → semantic (symmetric)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.PATH_NOT_INCLUDED);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    const result = await decodeVersionCid({
      v: 13,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase,
      decodeCid: okDecoder,
    });
    expect(result).toEqual({ ok: false, reason: 'semantic' });
  });

  it('both sides PATH_NOT_INCLUDED → semantic (the version simply does not exist)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.PATH_NOT_INCLUDED);
    const proofB = fakeProof(InclusionProofVerificationStatus.PATH_NOT_INCLUDED);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    const result = await decodeVersionCid({
      v: 13,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase,
      decodeCid: okDecoder,
    });
    expect(result).toEqual({ ok: false, reason: 'semantic' });
  });

  it('decoder returns ok:false → semantic (not transient)', async () => {
    // Edge: proofs succeed but the XOR plaintext fails the CID
    // decoder. Deterministic failure class — must be semantic.
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.OK);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    const result = await decodeVersionCid({
      v: 13,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase,
      decodeCid: failDecoder,
    });
    expect(result).toEqual({ ok: false, reason: 'semantic' });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E12 — isReachable returns true on ANY HTTP response, including
//       PATH_NOT_INCLUDED (the expected healthy reply)
// ───────────────────────────────────────────────────────────────────────────
describe('E12 — isReachable returns true on any HTTP response (SPEC §11.12)', () => {
  const signingPubKey = new Uint8Array(33).fill(0x02);

  it('PATH_NOT_INCLUDED response → reachable (the EXPECTED healthy reply)', async () => {
    const client = {
      getInclusionProof: vi.fn(async () =>
        new InclusionProofResponse(fakeProof(InclusionProofVerificationStatus.PATH_NOT_INCLUDED)),
      ),
    } as unknown as AggregatorClient;

    const reachable = await isReachable({ signingPubKey, aggregatorClient: client });
    expect(reachable).toBe(true);
  });

  it('OK response → reachable (irrelevant but shape-valid)', async () => {
    // Should be impossible for the health-check request id to be
    // included, but if some future aggregator state somehow hashes
    // into OK, the correct answer is still "reachable" — status is
    // explicitly ignored.
    const client = {
      getInclusionProof: vi.fn(async () =>
        new InclusionProofResponse(fakeProof(InclusionProofVerificationStatus.OK)),
      ),
    } as unknown as AggregatorClient;

    const reachable = await isReachable({ signingPubKey, aggregatorClient: client });
    expect(reachable).toBe(true);
  });

  it('JsonRpcNetworkError (5xx) → reachable (server answered, just unhappy)', async () => {
    const err = new Error('Gateway Timeout') as Error & { name: string; status: number };
    err.name = 'JsonRpcNetworkError';
    err.status = 504;
    const client = {
      getInclusionProof: vi.fn(async () => {
        throw err;
      }),
    } as unknown as AggregatorClient;

    const reachable = await isReachable({ signingPubKey, aggregatorClient: client });
    expect(reachable).toBe(true);
  });

  it('JsonRpcError → reachable (JSON-RPC-level error is still a response)', async () => {
    const err = new Error('method not found') as Error & { name: string };
    err.name = 'JsonRpcError';
    const client = {
      getInclusionProof: vi.fn(async () => {
        throw err;
      }),
    } as unknown as AggregatorClient;

    const reachable = await isReachable({ signingPubKey, aggregatorClient: client });
    expect(reachable).toBe(true);
  });

  it('uses a stable derivation of the HEALTH_CHECK request id (no hidden input)', async () => {
    // Two back-to-back calls with the same signingPubKey must use the
    // same requestId. If something in isReachable starts mixing wall-
    // clock or a random seed, the aggregator's rate-limiter would see
    // a new id each call and refuse to coalesce.
    const seenIds: string[] = [];
    const client = {
      getInclusionProof: vi.fn(async (reqId: unknown) => {
        seenIds.push(String(reqId));
        return new InclusionProofResponse(
          fakeProof(InclusionProofVerificationStatus.PATH_NOT_INCLUDED),
        );
      }),
    } as unknown as AggregatorClient;

    await isReachable({ signingPubKey, aggregatorClient: client });
    await isReachable({ signingPubKey, aggregatorClient: client });
    expect(seenIds.length).toBe(2);
    expect(seenIds[0]).toBe(seenIds[1]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E13 — isReachable returns false on a network-level failure
//       (timeout, DNS, TLS handshake) — the aggregator is silent.
// ───────────────────────────────────────────────────────────────────────────
describe('E13 — isReachable returns false on network-level failure (SPEC §11.12)', () => {
  const signingPubKey = new Uint8Array(33).fill(0x02);

  it('ECONNREFUSED → unreachable', async () => {
    const client = {
      getInclusionProof: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:443');
      }),
    } as unknown as AggregatorClient;

    const reachable = await isReachable({ signingPubKey, aggregatorClient: client });
    expect(reachable).toBe(false);
  });

  it('ETIMEDOUT (generic Error) → unreachable', async () => {
    const client = {
      getInclusionProof: vi.fn(async () => {
        throw new Error('ETIMEDOUT');
      }),
    } as unknown as AggregatorClient;

    const reachable = await isReachable({ signingPubKey, aggregatorClient: client });
    expect(reachable).toBe(false);
  });

  it('PointerProbeTimeout (hard timeout path) → unreachable', async () => {
    // Steelman: the fetchProofWithTimeout wrapper names its own
    // timeout error PointerProbeTimeout. That's a generic Error
    // subclass without the JsonRpcNetworkError / JsonRpcError
    // signal — it MUST fall through to the "network-level failure"
    // branch, not be silently treated as reachable.
    const client = {
      getInclusionProof: vi.fn(
        () =>
          new Promise(() => {
            /* hangs forever */
          }),
      ),
    } as unknown as AggregatorClient;

    const reachable = await isReachable({
      signingPubKey,
      aggregatorClient: client,
      timeoutMs: 10,
    });
    expect(reachable).toBe(false);
  });

  it('TypeError (malformed response) → unreachable (defensive default)', async () => {
    // Unknown error class without name=JsonRpc* — correct default
    // is unreachable so the BLOCKED-state CLEAR path does not fire
    // on a misbehaving aggregator shape.
    const client = {
      getInclusionProof: vi.fn(async () => {
        throw new TypeError('Cannot read properties of undefined');
      }),
    } as unknown as AggregatorClient;

    const reachable = await isReachable({ signingPubKey, aggregatorClient: client });
    expect(reachable).toBe(false);
  });
});
