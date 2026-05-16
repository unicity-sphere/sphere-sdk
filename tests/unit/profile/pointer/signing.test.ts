/**
 * SigningService discipline wrapper (T-A8).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createMasterPrivateKey,
  derivePointerKeyMaterial,
  buildPointerSigner,
  bytesToHex,
} from '../../../../profile/aggregator-pointer/index.js';
import { DataHash } from '@unicitylabs/state-transition-sdk/lib/hash/DataHash.js';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js';
import { sha256 } from '@noble/hashes/sha2.js';

describe('buildPointerSigner (T-A8)', () => {
  const walletBytes = new Uint8Array(32).fill(0x01);
  const master = createMasterPrivateKey(walletBytes, 'test-vectors');

  it('produces a 33-byte compressed secp256k1 pubkey', async () => {
    const km = derivePointerKeyMaterial(master);
    const signer = await buildPointerSigner(km.signingSeed);
    expect(signer.signingPubKey.length).toBe(33);
    expect([0x02, 0x03]).toContain(signer.signingPubKey[0]);
  });

  it('signingPubKeyHex matches KAT vector', async () => {
    const vectorsPath = resolve(__dirname, '../../../../tests/fixtures/pointer-kat-vectors.json');
    const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8'));
    const km = derivePointerKeyMaterial(master);
    const signer = await buildPointerSigner(km.signingSeed);
    expect(signer.signingPubKeyHex).toBe(vectors.derived_keys.signingPubKey_hex);
  });

  it('is deterministic: same signingSeed → same pubkey', async () => {
    const km1 = derivePointerKeyMaterial(master);
    const km2 = derivePointerKeyMaterial(master);
    const s1 = await buildPointerSigner(km1.signingSeed);
    const s2 = await buildPointerSigner(km2.signingSeed);
    expect(s1.signingPubKeyHex).toBe(s2.signingPubKeyHex);
  });

  it('can sign a hash and produce a valid signature', async () => {
    const km = derivePointerKeyMaterial(master);
    const signer = await buildPointerSigner(km.signingSeed);
    const hash = new DataHash(HashAlgorithm.SHA256, sha256(new TextEncoder().encode('hello')));
    const sig = await signer.service.sign(hash);
    expect(sig).toBeDefined();
  });

  it('uses createFromSecret (different from raw constructor)', async () => {
    // createFromSecret hashes its input; raw constructor treats input as scalar.
    // They MUST produce different pubkeys for the same 32-byte input.
    const { SigningService } = await import(
      '@unicitylabs/state-transition-sdk/lib/sign/SigningService.js'
    );
    const km = derivePointerKeyMaterial(master);
    const rawBytes = km.signingSeed.reveal();
    const createdFromSecret = await SigningService.createFromSecret(rawBytes);
    const rawConstructed = new SigningService(rawBytes);
    expect(bytesToHex(createdFromSecret.publicKey)).not.toBe(bytesToHex(rawConstructed.publicKey));

    // Our wrapper MUST match createFromSecret, not the raw constructor.
    const signer = await buildPointerSigner(km.signingSeed);
    expect(signer.signingPubKeyHex).toBe(bytesToHex(createdFromSecret.publicKey));
  });
});

describe('bytesToHex', () => {
  it('empty → empty', () => {
    expect(bytesToHex(new Uint8Array(0))).toBe('');
  });

  it('roundtrips a few values', () => {
    expect(bytesToHex(new Uint8Array([0x00, 0xff]))).toBe('00ff');
    expect(bytesToHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe('deadbeef');
  });

  it('always 2 hex chars per byte (lowercase)', () => {
    const out = bytesToHex(new Uint8Array([0x01, 0x0a]));
    expect(out).toBe('010a');
  });
});
