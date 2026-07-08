/**
 * Wave 6-P2-16 — publish → decode round-trip on the v2 aggregator API.
 *
 * The v2 aggregator replaces v1's
 * `submitCommitment(requestId, transactionHash, authenticator)` with
 * `submitCertificationRequest(certificationData)` and derives a `StateId`
 * from the lockScript+sourceStateHash. This test verifies:
 *
 *   1. A publisher (submitPointer) commits a CID at version v. The
 *      aggregator receives a CertificationData whose transactionHash
 *      carries the ciphertext `ctSide` (SPEC §6).
 *
 *   2. A recoverer (decodeVersionCid) later reads back the inclusion
 *      proof by StateId. The proof's certificationData.transactionHash
 *      MUST carry the SAME ct bytes the submitter stored — XOR-decoding
 *      those against the per-side xorKey recovers the plaintext half.
 *
 * The fake aggregator memoizes `stateId.toString() → certificationData` on
 * submit and echoes the certificationData back on getInclusionProof.
 * `InclusionProofVerificationRule.verify` is mocked to return OK when a
 * committed record exists (the round-trip contract does not need real
 * merkle-path cryptography).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AggregatorClient,
  CertificationData,
  CertificationStatus,
  InclusionProofVerificationStatus,
  RootTrustBase,
  StateId,
} from '../../../token-engine/sdk.js';

// Mock InclusionProofVerificationRule so the probe path succeeds whenever
// the fake aggregator has a matching commitment stored. When there is no
// commitment (fake proof carries no certificationData) the mock returns
// INCLUSION_CERTIFICATE_MISSING so the runDecodePhases path reports
// 'semantic' failure — matching the v1 round-trip contract.
vi.mock('../../../token-engine/sdk.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    InclusionProofVerificationRule: {
      verify: vi.fn(async (_trustBase, _predVerifier, proof) => {
        if (proof && (proof.__missing || proof.certificationData == null)) {
          return { status: InclusionProofVerificationStatus.INCLUSION_CERTIFICATE_MISSING };
        }
        return { status: InclusionProofVerificationStatus.OK };
      }),
    },
  };
});

import {
  submitPointer,
  decodeVersionCid,
  createMasterPrivateKey,
  derivePointerKeyMaterial,
  buildPointerSigner,
  type CidDecoder,
  type PointerSigner,
  type PointerKeyMaterial,
} from '../../../extensions/uxf/profile/aggregator-pointer/index.js';

// ── Fake aggregator ───────────────────────────────────────────────────────

type Fixtures = { keyMaterial: PointerKeyMaterial; signer: PointerSigner };

async function fixturesFromSeed(seed: Uint8Array): Promise<Fixtures> {
  const master = createMasterPrivateKey(seed);
  const keyMaterial = derivePointerKeyMaterial(master);
  const signer = await buildPointerSigner(keyMaterial.signingSeed);
  return { keyMaterial, signer };
}

interface FakeAggregator {
  client: AggregatorClient;
  commitments: Map<string, CertificationData>;
}

function stateIdKey(stateId: StateId): string {
  return Array.from(stateId.data)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Build a fake aggregator that stores per-`stateId` the CertificationData
 * received via submitCertificationRequest, then echoes it back on
 * getInclusionProof(stateId).
 */
function makeFakeAggregator(): FakeAggregator {
  const commitments = new Map<string, CertificationData>();
  const client = {
    async submitCertificationRequest(certificationData: CertificationData) {
      const stateId = await StateId.fromCertificationData(certificationData);
      commitments.set(stateIdKey(stateId), certificationData);
      return { status: CertificationStatus.SUCCESS };
    },
    async getInclusionProof(stateId: StateId) {
      const stored = commitments.get(stateIdKey(stateId));
      if (!stored) {
        // No commitment — return a proof whose mocked verify() reports
        // INCLUSION_CERTIFICATE_MISSING.
        return {
          inclusionProof: {
            __missing: true,
            certificationData: null,
            inclusionCertificate: null,
            unicityCertificate: {
              unicitySeal: { epoch: 1n },
              inputRecord: { epoch: 1n },
            },
          },
          blockNumber: 0n,
        };
      }
      return {
        inclusionProof: {
          certificationData: stored,
          inclusionCertificate: {},
          unicityCertificate: {
            unicitySeal: { epoch: 1n },
            inputRecord: { epoch: 1n },
          },
        },
        blockNumber: 1n,
      };
    },
  } as unknown as AggregatorClient;
  return { client, commitments };
}

const fakeTrustBase = { epoch: 1n } as unknown as RootTrustBase;

const lengthPrefixCidDecoder: CidDecoder = (full) => {
  if (full.length === 0) return { ok: false };
  const cidLen = full[0];
  if (cidLen === undefined || cidLen === 0 || cidLen > full.length - 1) {
    return { ok: false };
  }
  return { ok: true, cidBytes: full.slice(1, 1 + cidLen) };
};

// ── Round-trip tests ──────────────────────────────────────────────────────

describe('publish → decode round-trip (T-C1 ↔ T-C2 contract, v2 API)', () => {
  it('publishes cidBytes at v=1 and decodeVersionCid recovers the same bytes', async () => {
    const seed = new Uint8Array(32).fill(0x33);
    const { keyMaterial, signer } = await fixturesFromSeed(seed);
    const { client } = makeFakeAggregator();

    const cidBytes = new Uint8Array([0x01, 0x55, 0x12, 0x20, ...new Array(32).fill(0xab)]);

    const outcome = await submitPointer({
      v: 1,
      cidBytes,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });
    expect(outcome.kind).toBe('success');

    const recovered = await decodeVersionCid({
      v: 1,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase: fakeTrustBase,
      decodeCid: lengthPrefixCidDecoder,
    });
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(Array.from(recovered.cidBytes)).toEqual(Array.from(cidBytes));
    }
  });

  it('supports the full 63-byte CID length (CID_MAX_BYTES boundary)', async () => {
    const seed = new Uint8Array(32).fill(0x44);
    const { keyMaterial, signer } = await fixturesFromSeed(seed);
    const { client } = makeFakeAggregator();

    const cidBytes = new Uint8Array(63);
    for (let i = 0; i < 63; i++) cidBytes[i] = (i * 7 + 13) & 0xff;

    const outcome = await submitPointer({
      v: 42,
      cidBytes,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });
    expect(outcome.kind).toBe('success');

    const recovered = await decodeVersionCid({
      v: 42,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase: fakeTrustBase,
      decodeCid: lengthPrefixCidDecoder,
    });
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(Array.from(recovered.cidBytes)).toEqual(Array.from(cidBytes));
    }
  });

  it('supports 1-byte CID (CID_MIN boundary — smallest valid payload)', async () => {
    const seed = new Uint8Array(32).fill(0x55);
    const { keyMaterial, signer } = await fixturesFromSeed(seed);
    const { client } = makeFakeAggregator();

    const cidBytes = new Uint8Array([0x99]);

    const outcome = await submitPointer({
      v: 7,
      cidBytes,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });
    expect(outcome.kind).toBe('success');

    const recovered = await decodeVersionCid({
      v: 7,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase: fakeTrustBase,
      decodeCid: lengthPrefixCidDecoder,
    });
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(Array.from(recovered.cidBytes)).toEqual([0x99]);
    }
  });

  it('recovering at an unpublished version returns { ok:false, reason:"semantic" }', async () => {
    const seed = new Uint8Array(32).fill(0x66);
    const { keyMaterial, signer } = await fixturesFromSeed(seed);
    const { client } = makeFakeAggregator();

    const cidBytes = new Uint8Array(36).fill(0x77);
    await submitPointer({
      v: 1,
      cidBytes,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });

    const recovered = await decodeVersionCid({
      v: 2,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase: fakeTrustBase,
      decodeCid: lengthPrefixCidDecoder,
    });
    expect(recovered.ok).toBe(false);
    if (!recovered.ok) {
      expect(recovered.reason).toBe('semantic');
    }
  });

  it('cross-wallet: seed-A publishes; seed-B recover returns { ok:false } (isolation)', async () => {
    const seedA = new Uint8Array(32).fill(0x88);
    const seedB = new Uint8Array(32).fill(0x99);
    const fixA = await fixturesFromSeed(seedA);
    const fixB = await fixturesFromSeed(seedB);
    const { client } = makeFakeAggregator();

    expect(fixA.signer.signingPubKeyHex).not.toBe(fixB.signer.signingPubKeyHex);

    const cidBytes = new Uint8Array(36).fill(0xaa);
    await submitPointer({
      v: 1,
      cidBytes,
      keyMaterial: fixA.keyMaterial,
      signer: fixA.signer,
      aggregatorClient: client,
      marker: null,
    });

    const recoveredA = await decodeVersionCid({
      v: 1,
      keyMaterial: fixA.keyMaterial,
      signer: fixA.signer,
      aggregatorClient: client,
      trustBase: fakeTrustBase,
      decodeCid: lengthPrefixCidDecoder,
    });
    expect(recoveredA.ok).toBe(true);

    const recoveredB = await decodeVersionCid({
      v: 1,
      keyMaterial: fixB.keyMaterial,
      signer: fixB.signer,
      aggregatorClient: client,
      trustBase: fakeTrustBase,
      decodeCid: lengthPrefixCidDecoder,
    });
    expect(recoveredB.ok).toBe(false);
  });

  it('two sequential publishes at distinct versions both decode independently', async () => {
    const seed = new Uint8Array(32).fill(0xbb);
    const { keyMaterial, signer } = await fixturesFromSeed(seed);
    const { client } = makeFakeAggregator();

    const cid1 = new Uint8Array(36).fill(0x11);
    const cid2 = new Uint8Array(36).fill(0x22);

    await submitPointer({
      v: 1,
      cidBytes: cid1,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });
    await submitPointer({
      v: 2,
      cidBytes: cid2,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });

    const r1 = await decodeVersionCid({
      v: 1,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase: fakeTrustBase,
      decodeCid: lengthPrefixCidDecoder,
    });
    const r2 = await decodeVersionCid({
      v: 2,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase: fakeTrustBase,
      decodeCid: lengthPrefixCidDecoder,
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok) expect(Array.from(r1.cidBytes)).toEqual(Array.from(cid1));
    if (r2.ok) expect(Array.from(r2.cidBytes)).toEqual(Array.from(cid2));
  });
});
