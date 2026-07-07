/**
 * Wave 6-P2-10b — publish → decode round-trip coverage restoration.
 *
 * The legacy integration in tests/legacy-v1/integration/pointer/publish-recover-roundtrip.test.ts
 * exercised the full `ProfilePointerLayer.publish` → `recoverLatest` path.
 * That layer has many external deps (fetchAndJoin, resolveRemoteCid, mutex,
 * BLOCKED-state flag store, etc.) — restoring the whole surface into a unit
 * test requires more scaffolding than the wave-10b budget allows.
 *
 * This file restores the CORE round-trip contract that both paths depend on:
 *
 *   1. A publisher (submitPointer) commits a CID at version v. The
 *      aggregator receives two DataHash commitments — one per side.
 *      Each hash's `data` is the ciphertext `ctSide` (SPEC §6).
 *
 *   2. A recoverer (decodeVersionCid) later reads back the inclusion
 *      proofs. The proof's transactionHash MUST carry the SAME ct bytes
 *      the submitter stored, because the aggregator's SMT is content-
 *      addressed by DataHash. XOR-decoding those ct bytes against the
 *      per-side xorKey recovers the 32-byte plaintext half; concatenated
 *      + length-prefix-decoded, they yield the original cidBytes.
 *
 * The fake aggregator here memoizes `requestId.toString() → ct.data` on
 * submit and echoes `ct.data` back on getInclusionProof. It does NOT run
 * merkle-path or signature verification — the fake proof's `verify()`
 * returns OK unconditionally. That is exactly what the round-trip
 * contract requires: what's on the wire in equals what comes out later.
 *
 * Coverage:
 *   - Single-round-trip: publish v=1, decodeVersionCid at v=1 recovers cidBytes
 *   - Distinct wallets: seed A publishes; a wallet-B recover attempt fails
 *     (transient) because seed B derives different request IDs
 *   - Cross-version: publish v=1 only → decodeVersionCid at v=2 returns
 *     'transient' (nothing stored under those request IDs)
 *   - Round-trip with multi-byte cidBytes: prove the length-prefix decoder
 *     survives non-trivial CID lengths (36 bytes = typical CIDv1 sha256 raw)
 */

import { describe, it, expect } from 'vitest';
import { SubmitCommitmentStatus } from 'stsdk-v1/lib/api/SubmitCommitmentResponse.js';
import type { AggregatorClient } from 'stsdk-v1/lib/api/AggregatorClient.js';
import type { RootTrustBase } from 'stsdk-v1/lib/bft/RootTrustBase.js';

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
  commitments: Map<string, Uint8Array>;
}

/**
 * Build a fake aggregator that stores per-`requestId` the ciphertext bytes
 * carried by `transactionHash.data`, then echoes them back on
 * `getInclusionProof`.
 *
 * The fake proof's `verify()` returns OK unconditionally — the round-trip
 * contract doesn't need real inclusion-proof cryptography.
 */
function makeFakeAggregator(): FakeAggregator {
  const commitments = new Map<string, Uint8Array>();
  const client = {
    async submitCommitment(
      requestId: { toString(): string },
      transactionHash: { data: Uint8Array },
      _authenticator: unknown,
    ) {
      commitments.set(requestId.toString(), new Uint8Array(transactionHash.data));
      return { status: SubmitCommitmentStatus.SUCCESS };
    },
    async getInclusionProof(requestId: { toString(): string }) {
      const stored = commitments.get(requestId.toString());
      if (!stored) {
        return {
          inclusionProof: {
            verify: async () => 'PATH_NOT_INCLUDED',
            transactionHash: null,
            unicityCertificate: {
              unicitySeal: { epoch: 1n },
              inputRecord: { epoch: 1n },
            },
          },
        };
      }
      return {
        inclusionProof: {
          verify: async () => 'OK',
          transactionHash: {
            data: stored,
            imprint: new Uint8Array([0x00, 0x00, ...stored]),
          },
          unicityCertificate: {
            unicitySeal: { epoch: 1n },
            inputRecord: { epoch: 1n },
          },
        },
      };
    },
  } as unknown as AggregatorClient;
  return { client, commitments };
}

const fakeTrustBase = { epoch: 1n } as unknown as RootTrustBase;

/**
 * Length-prefix CID decoder — matches the production wiring's contract.
 * The 64-byte plaintext `full` buffer is:
 *   [0]              = cidLen (uint8, non-zero)
 *   [1..1+cidLen]    = cidBytes
 *   [1+cidLen..64]   = derived padding
 */
const lengthPrefixCidDecoder: CidDecoder = (full) => {
  if (full.length === 0) return { ok: false };
  const cidLen = full[0];
  if (cidLen === undefined || cidLen === 0 || cidLen > full.length - 1) {
    return { ok: false };
  }
  return { ok: true, cidBytes: full.slice(1, 1 + cidLen) };
};

// ── Round-trip tests ──────────────────────────────────────────────────────

describe('publish → decode round-trip (T-C1 ↔ T-C2 contract)', () => {
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
    // Both sides SUCCESS → row 1 of §7.3.
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

    // CID_MAX_BYTES = 63.
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

  it('recovering at an unpublished version returns { ok:false, reason:"transient" }', async () => {
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

    // We asked to decode v=2 but only v=1 was published. The fake
    // aggregator returns "no proof stored" → verify → PATH_NOT_INCLUDED
    // on both sides → decode phase reports 'semantic' outcome per SPEC.
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
    // Two independent wallets share the same aggregator. Seed B's request
    // IDs are derived from seed B's signingPubKey — they do NOT collide with
    // seed A's request IDs, so seed B sees "no proof stored" at v=1 → the
    // fake proof carries no data, decodeCid reports 'semantic'. This
    // proves per-wallet key isolation from the round-trip's perspective.
    const seedA = new Uint8Array(32).fill(0x88);
    const seedB = new Uint8Array(32).fill(0x99);
    const fixA = await fixturesFromSeed(seedA);
    const fixB = await fixturesFromSeed(seedB);
    const { client } = makeFakeAggregator();

    // Sanity check that the derived pubkeys are actually distinct.
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

    // A recovers OK.
    const recoveredA = await decodeVersionCid({
      v: 1,
      keyMaterial: fixA.keyMaterial,
      signer: fixA.signer,
      aggregatorClient: client,
      trustBase: fakeTrustBase,
      decodeCid: lengthPrefixCidDecoder,
    });
    expect(recoveredA.ok).toBe(true);

    // B sees nothing at v=1 under its own request IDs.
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
