/**
 * KAT test (T-A9, SPEC §14, TEST-SPEC P8) — v2 vectors.
 *
 * Verifies the Phase A key-derivation chain produces the exact bytes
 * pinned in tests/fixtures/pointer-kat-vectors.json. Any divergence
 * means HKDF / SigningService / StateId drift — fail loudly.
 *
 * Wave 6-P2-16 regenerated the pubkey / StateId vectors under v2 SDK
 * semantics — the SDK's SigningService constructor uses the input as
 * the scalar directly (v1's `createFromSecret` SHA-256-hashed the input
 * first, so the derived pubkey differs). The stateHashDigest / xorKey /
 * paddingBytes vectors are unchanged (derived from xorSeed / padSeed
 * only, no signing involvement). Requests are now `StateId`
 * (SHA256(CBOR([lockScript CBOR, stateHash]))) — the v1 `RequestId`
 * shape no longer exists.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createMasterPrivateKey,
  derivePointerKeyMaterial,
  deriveStateHashDigest,
  deriveXorKey,
  derivePaddingBytes,
  buildPointerSigner,
  deriveHealthCheckRequestId,
  bytesToHex,
  SIDE_A_NUM,
  SIDE_B_NUM,
} from '../../../../extensions/uxf/profile/aggregator-pointer/index.js';
import {
  DataHash,
  EncodedPredicate,
  HashAlgorithm,
  SignaturePredicate,
  StateId,
} from '../../../../token-engine/sdk.js';

interface KatVectors {
  inputs: {
    walletPrivateKey_hex: string;
    version_v: number;
    cidLen_bytes: number;
  };
  derived_keys: {
    pointerSecret_hex: string;
    signingSeed_hex: string;
    xorSeed_hex: string;
    padSeed_hex: string;
    signingScalar_hex: string;
    signingPubKey_hex: string;
  };
  per_version_per_side: {
    v_1: {
      stateHashDigest_A_hex: string;
      stateHashDigest_B_hex: string;
      xorKey_A_hex: string;
      xorKey_B_hex: string;
      paddingBytes_cidLen36_hex: string;
      stateId_A_hex: string;
      stateId_B_hex: string;
    };
  };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const vectorsPath = resolve(__dirname, '../../../../tests/fixtures/pointer-kat-vectors.json');
const vectors: KatVectors = JSON.parse(readFileSync(vectorsPath, 'utf8'));

describe('KAT vectors (T-A9 / P8, v2)', () => {
  const walletPrivateKey = hexToBytes(vectors.inputs.walletPrivateKey_hex);
  const v = vectors.inputs.version_v;
  const cidLen = vectors.inputs.cidLen_bytes;

  const master = createMasterPrivateKey(walletPrivateKey, 'test-vectors');
  const km = derivePointerKeyMaterial(master);

  it('derives pointerSecret to expected bytes', () => {
    expect(bytesToHex(km.pointerSecret.reveal())).toBe(vectors.derived_keys.pointerSecret_hex);
  });

  it('derives signingSeed to expected bytes', () => {
    expect(bytesToHex(km.signingSeed.reveal())).toBe(vectors.derived_keys.signingSeed_hex);
  });

  it('derives xorSeed to expected bytes', () => {
    expect(bytesToHex(km.xorSeed.reveal())).toBe(vectors.derived_keys.xorSeed_hex);
  });

  it('derives padSeed to expected bytes', () => {
    expect(bytesToHex(km.padSeed.reveal())).toBe(vectors.derived_keys.padSeed_hex);
  });

  it('seeds are pairwise distinct (H12 domain separation)', () => {
    const a = bytesToHex(km.pointerSecret.reveal());
    const b = bytesToHex(km.signingSeed.reveal());
    const c = bytesToHex(km.xorSeed.reveal());
    const d = bytesToHex(km.padSeed.reveal());
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it('SigningService produces expected signingPubKey (v2: raw-scalar constructor)', async () => {
    const signer = await buildPointerSigner(km.signingSeed);
    expect(signer.signingPubKeyHex).toBe(vectors.derived_keys.signingPubKey_hex);
  });

  it('stateHashDigest matches for SIDE_A @ v=1', () => {
    const digest = deriveStateHashDigest(km.xorSeed, SIDE_A_NUM, v);
    expect(bytesToHex(digest)).toBe(vectors.per_version_per_side.v_1.stateHashDigest_A_hex);
  });

  it('stateHashDigest matches for SIDE_B @ v=1', () => {
    const digest = deriveStateHashDigest(km.xorSeed, SIDE_B_NUM, v);
    expect(bytesToHex(digest)).toBe(vectors.per_version_per_side.v_1.stateHashDigest_B_hex);
  });

  it('xorKey matches for SIDE_A @ v=1', () => {
    const key = deriveXorKey(km.xorSeed, SIDE_A_NUM, v);
    expect(bytesToHex(key)).toBe(vectors.per_version_per_side.v_1.xorKey_A_hex);
  });

  it('xorKey matches for SIDE_B @ v=1', () => {
    const key = deriveXorKey(km.xorSeed, SIDE_B_NUM, v);
    expect(bytesToHex(key)).toBe(vectors.per_version_per_side.v_1.xorKey_B_hex);
  });

  it('paddingBytes_v matches for cidLen=36, v=1', () => {
    const pad = derivePaddingBytes(km.padSeed, v, cidLen);
    expect(bytesToHex(pad)).toBe(vectors.per_version_per_side.v_1.paddingBytes_cidLen36_hex);
  });

  it('v2 StateId matches for SIDE_A @ v=1 (SHA256(CBOR([lockScript CBOR, stateHash])))', async () => {
    const signer = await buildPointerSigner(km.signingSeed);
    const stateDigest = deriveStateHashDigest(km.xorSeed, SIDE_A_NUM, v);
    const stateHash = new DataHash(HashAlgorithm.SHA256, stateDigest);
    const encoded = EncodedPredicate.fromPredicate(SignaturePredicate.create(signer.signingPubKey));
    // Build a fake transaction that carries the lockScript + sourceStateHash
    // and derive its StateId via the public helper.
    const fakeTx = {
      lockScript: encoded,
      sourceStateHash: stateHash,
    } as unknown as import('../../../../token-engine/sdk.js').ITransaction;
    const stateId = await StateId.fromTransaction(fakeTx);
    expect(bytesToHex(stateId.data)).toBe(vectors.per_version_per_side.v_1.stateId_A_hex);
  });

  it('v2 StateId matches for SIDE_B @ v=1', async () => {
    const signer = await buildPointerSigner(km.signingSeed);
    const stateDigest = deriveStateHashDigest(km.xorSeed, SIDE_B_NUM, v);
    const stateHash = new DataHash(HashAlgorithm.SHA256, stateDigest);
    const encoded = EncodedPredicate.fromPredicate(SignaturePredicate.create(signer.signingPubKey));
    const fakeTx = {
      lockScript: encoded,
      sourceStateHash: stateHash,
    } as unknown as import('../../../../token-engine/sdk.js').ITransaction;
    const stateId = await StateId.fromTransaction(fakeTx);
    expect(bytesToHex(stateId.data)).toBe(vectors.per_version_per_side.v_1.stateId_B_hex);
  });

  it('deriveHealthCheckRequestId is deterministic for a given signingPubKey', async () => {
    const signer = await buildPointerSigner(km.signingSeed);
    const r1 = deriveHealthCheckRequestId(signer.signingPubKey);
    const r2 = deriveHealthCheckRequestId(signer.signingPubKey);
    expect(bytesToHex(r1)).toBe(bytesToHex(r2));
    expect(r1.length).toBe(32);
  });
});
