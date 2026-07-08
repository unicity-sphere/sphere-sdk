/**
 * Wave 6-P2-16 — SigningService wrapper (T-A8) v2 coverage.
 *
 * Under the v2 SDK there is no `SigningService.createFromSecret` helper —
 * the constructor uses the 32-byte input directly AS the scalar. The
 * pointer's `buildPointerSigner` therefore constructs
 * `new SigningService(signingSeed)` and captures `signingPubKey` /
 * `signingPubKeyHex` for the rest of the pointer state machine.
 *
 * Properties pinned here:
 *
 *   Shape:
 *     - signingPubKey is exactly 33 bytes and starts with 0x02 or 0x03
 *       (compressed secp256k1).
 *     - signingPubKeyHex is a 66-char lowercase hex string that echoes
 *       the byte array.
 *
 *   Determinism:
 *     - Same seed → identical pubkey / hex on every build.
 *     - Cross-wallet distinctness: two independent seeds → distinct pubkeys.
 *
 *   Signing round-trip:
 *     - Sign a DataHash → produces a Signature object with ≥64 bytes.
 *     - Signature verifies against the wrapper's public key.
 *
 *   T-A8 v2 semantics:
 *     - Wrapper's pubkey MUST equal `new SigningService(seed).publicKey` —
 *       the wrapper uses the raw constructor per the v2 SDK. This is the
 *       inverse of the v1 pin (which required `createFromSecret`).
 *
 *   Utility:
 *     - bytesToHex is lowercase, always 2 chars per byte, handles empty.
 */

import { describe, it, expect } from 'vitest';
import { SigningService, DataHash, HashAlgorithm } from '../../../token-engine/sdk.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  createMasterPrivateKey,
  derivePointerKeyMaterial,
  buildPointerSigner,
  bytesToHex,
} from '../../../extensions/uxf/profile/aggregator-pointer/index.js';

const WALLET_SEED_A = new Uint8Array(32).fill(0x42);
const WALLET_SEED_B = new Uint8Array(32).fill(0xa5);

async function buildSigner(seed: Uint8Array) {
  const master = createMasterPrivateKey(seed);
  const km = derivePointerKeyMaterial(master);
  return buildPointerSigner(km.signingSeed);
}

// ── Shape guarantees ──────────────────────────────────────────────────────

describe('buildPointerSigner — public key shape', () => {
  it('produces a 33-byte compressed secp256k1 pubkey (0x02 or 0x03 prefix)', async () => {
    const signer = await buildSigner(WALLET_SEED_A);
    expect(signer.signingPubKey).toBeInstanceOf(Uint8Array);
    expect(signer.signingPubKey.length).toBe(33);
    expect([0x02, 0x03]).toContain(signer.signingPubKey[0]);
  });

  it('signingPubKeyHex is 66 lowercase hex chars and matches signingPubKey bytes', async () => {
    const signer = await buildSigner(WALLET_SEED_A);
    expect(signer.signingPubKeyHex).toMatch(/^[0-9a-f]{66}$/);
    expect(signer.signingPubKeyHex).toBe(bytesToHex(signer.signingPubKey));
  });
});

// ── Determinism ───────────────────────────────────────────────────────────

describe('buildPointerSigner — determinism', () => {
  it('same seed produces identical signingPubKey across repeated derivations', async () => {
    const s1 = await buildSigner(WALLET_SEED_A);
    const s2 = await buildSigner(WALLET_SEED_A);
    expect(s1.signingPubKeyHex).toBe(s2.signingPubKeyHex);
  });

  it('different seeds produce distinct signingPubKeys', async () => {
    const s1 = await buildSigner(WALLET_SEED_A);
    const s2 = await buildSigner(WALLET_SEED_B);
    expect(s1.signingPubKeyHex).not.toBe(s2.signingPubKeyHex);
  });
});

// ── Signing round-trip ────────────────────────────────────────────────────

describe('buildPointerSigner — signing round-trip', () => {
  it('signs a hash and produces a Signature-shaped object', async () => {
    const signer = await buildSigner(WALLET_SEED_A);
    const hash = new DataHash(HashAlgorithm.SHA256, sha256(new TextEncoder().encode('probe')));
    const sig = await signer.service.sign(hash);
    expect(sig).toBeDefined();
    expect(sig.bytes).toBeInstanceOf(Uint8Array);
    expect(sig.bytes.length).toBeGreaterThanOrEqual(64);
  });

  it('signature verifies against the wrapper\'s own public key', async () => {
    const signer = await buildSigner(WALLET_SEED_A);
    const hash = new DataHash(HashAlgorithm.SHA256, sha256(new TextEncoder().encode('verify me')));
    const sig = await signer.service.sign(hash);
    const ok = await SigningService.verifyWithPublicKey(hash, sig.bytes, signer.signingPubKey);
    expect(ok).toBe(true);
  });

  it('signature FAILS verification under a different pubkey (sanity)', async () => {
    const signerA = await buildSigner(WALLET_SEED_A);
    const signerB = await buildSigner(WALLET_SEED_B);
    const hash = new DataHash(HashAlgorithm.SHA256, sha256(new TextEncoder().encode('cross-check')));
    const sigA = await signerA.service.sign(hash);
    const okAgainstB = await SigningService.verifyWithPublicKey(hash, sigA.bytes, signerB.signingPubKey);
    expect(okAgainstB).toBe(false);
  });
});

// ── T-A8 v2 discipline: raw constructor is the canonical path ──────────────

describe('buildPointerSigner — v2 T-A8 discipline', () => {
  it('wrapper uses `new SigningService(seed)` — matches raw constructor for the same input', async () => {
    // In v2 the SDK dropped `createFromSecret`; the constructor uses the
    // input as the scalar directly. The wrapper's pubkey MUST equal the
    // raw-constructor path — otherwise the pointer layer would derive a
    // different pubkey from the aggregator's expectations.
    const master = createMasterPrivateKey(WALLET_SEED_A);
    const km = derivePointerKeyMaterial(master);
    const seedBytes = km.signingSeed.reveal();

    const fromRaw = new SigningService(new Uint8Array(seedBytes));
    const wrapper = await buildPointerSigner(km.signingSeed);
    expect(wrapper.signingPubKeyHex).toBe(bytesToHex(fromRaw.publicKey));
  });
});

// ── bytesToHex utility ────────────────────────────────────────────────────

describe('bytesToHex', () => {
  it('empty input → empty string', () => {
    expect(bytesToHex(new Uint8Array(0))).toBe('');
  });

  it('single-byte low value pads to 2 chars', () => {
    expect(bytesToHex(new Uint8Array([0x00]))).toBe('00');
    expect(bytesToHex(new Uint8Array([0x0a]))).toBe('0a');
  });

  it('always emits lowercase hex', () => {
    expect(bytesToHex(new Uint8Array([0xff, 0xab, 0xcd]))).toBe('ffabcd');
  });

  it('handles a 33-byte compressed pubkey shape', () => {
    const buf = new Uint8Array(33);
    buf[0] = 0x02;
    for (let i = 1; i < 33; i++) buf[i] = i;
    const hex = bytesToHex(buf);
    expect(hex.length).toBe(66);
    expect(hex.slice(0, 2)).toBe('02');
  });
});
