// O-1 KAT vector computation for Profile Aggregator Pointer Layer
// Reads SPEC §3 constants and §4 derivations; produces test-vectors.json

import { hkdf, expand } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { writeFileSync } from 'node:fs';

const enc = new TextEncoder();

// Spec §3 constants
const PROFILE_POINTER_HKDF_INFO = enc.encode('uxf-profile-aggregator-pointer-v1'); // 33 bytes
const SIGNING_SEED_INFO = enc.encode('uxf-profile-pointer-sig-v1'); // 26 bytes
const XOR_SEED_INFO     = enc.encode('uxf-profile-pointer-xor-v1'); // 26 bytes
const PAD_SEED_INFO     = enc.encode('uxf-profile-pointer-pad-v1'); // 26 bytes
const SIDE_A = 0x00;
const SIDE_B = 0x01;
const VERSION_MIN = 1;

// Sanity checks
if (PROFILE_POINTER_HKDF_INFO.length !== 33) throw new Error(`PROFILE_POINTER_HKDF_INFO length ${PROFILE_POINTER_HKDF_INFO.length} != 33`);
if (SIGNING_SEED_INFO.length !== 26) throw new Error('SIGNING_SEED_INFO length');
if (XOR_SEED_INFO.length !== 26) throw new Error('XOR_SEED_INFO length');
if (PAD_SEED_INFO.length !== 26) throw new Error('PAD_SEED_INFO length');

// Canonical test input — boring, public, NOT a real wallet
const walletPrivateKey = new Uint8Array(32).fill(0x01);

// Helpers
const hex = (u8) => Buffer.from(u8).toString('hex');
const be32 = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false); // big-endian
  return b;
};
const concat = (...arrs) => {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};

// §4.1 pointerSecret = HKDF(walletPrivateKey, salt="", info=PROFILE_POINTER_HKDF_INFO, L=32)
const pointerSecret = hkdf(sha256, walletPrivateKey, new Uint8Array(0), PROFILE_POINTER_HKDF_INFO, 32);

// §4.2 subkeys via HKDF-Expand from pointerSecret
// @noble's hkdf() does Extract+Expand; we need Expand with PRK=pointerSecret.
const signingSeed = expand(sha256, pointerSecret, SIGNING_SEED_INFO, 32);
const xorSeed     = expand(sha256, pointerSecret, XOR_SEED_INFO,     32);
const padSeed     = expand(sha256, pointerSecret, PAD_SEED_INFO,     32);

// §4.3 SigningService.createFromSecret: SHA-256(signingSeed) → scalar; compressed pubkey
const signingScalar = sha256(signingSeed);
const signingPubKey = secp256k1.getPublicKey(signingScalar, true); // 33 bytes compressed

// §4.4 stateHashDigest_{side, v} = SHA256(xorSeed || [side] || be32(v) || "state")
function stateHashDigest(side, v) {
  return sha256(concat(xorSeed, new Uint8Array([side]), be32(v), enc.encode('state')));
}

// §4.5 xorKey_{side, v} = SHA256(xorSeed || [side] || be32(v) || "xor")
function xorKey(side, v) {
  return sha256(concat(xorSeed, new Uint8Array([side]), be32(v), enc.encode('xor')));
}

// §4.6 paddingBytes_v = HKDF-Expand(padSeed, be32(v) || "pad", 63 - cidLen)
// For KAT we pick a realistic cidLen. CIDv1 dag-cbor SHA-256 is typically 36 bytes (0x01 0x71 0x12 0x20 + 32 hash bytes).
// Use cidLen = 36 → paddingBytes length = 27.
function paddingBytes(v, cidLen) {
  return expand(sha256, padSeed, concat(be32(v), enc.encode('pad')), 63 - cidLen);
}

// §4.7 requestId_{side, v} = SHA256(signingPubKey || [0x00, 0x00] || stateHashDigest_{side, v})
function requestId(side, v) {
  return sha256(concat(signingPubKey, new Uint8Array([0x00, 0x00]), stateHashDigest(side, v)));
}

// Produce vectors at v=1
const v = VERSION_MIN;
const cidLen = 36; // CIDv1 dag-cbor SHA-256

const vectors = {
  $schema: 'SPEC §14 KAT vectors for Profile Aggregator Pointer Layer',
  description: 'Known-Answer Test vectors. Inputs are non-secret test values. Outputs pinned from a correct impl of SPEC §3, §4.',
  spec_version: 'v3.3',
  computed_at: new Date().toISOString(),
  inputs: {
    walletPrivateKey_hex: hex(walletPrivateKey),
    walletPrivateKey_note: '32 bytes, all 0x01 — canonical test value, NOT a real wallet',
    PROFILE_POINTER_HKDF_INFO_utf8: 'uxf-profile-aggregator-pointer-v1',
    PROFILE_POINTER_HKDF_INFO_hex: hex(PROFILE_POINTER_HKDF_INFO),
    PROFILE_POINTER_HKDF_INFO_len: PROFILE_POINTER_HKDF_INFO.length,
    SIGNING_SEED_INFO_utf8: 'uxf-profile-pointer-sig-v1',
    SIGNING_SEED_INFO_hex: hex(SIGNING_SEED_INFO),
    XOR_SEED_INFO_utf8: 'uxf-profile-pointer-xor-v1',
    XOR_SEED_INFO_hex: hex(XOR_SEED_INFO),
    PAD_SEED_INFO_utf8: 'uxf-profile-pointer-pad-v1',
    PAD_SEED_INFO_hex: hex(PAD_SEED_INFO),
    version_v: v,
    cidLen_bytes: cidLen,
  },
  derived_keys: {
    pointerSecret_hex: hex(pointerSecret),
    signingSeed_hex: hex(signingSeed),
    xorSeed_hex: hex(xorSeed),
    padSeed_hex: hex(padSeed),
    signingScalar_hex: hex(signingScalar),
    signingPubKey_hex: hex(signingPubKey),
    signingPubKey_len: signingPubKey.length,
  },
  per_version_per_side: {
    v_1: {
      stateHashDigest_A_hex: hex(stateHashDigest(SIDE_A, v)),
      stateHashDigest_B_hex: hex(stateHashDigest(SIDE_B, v)),
      xorKey_A_hex: hex(xorKey(SIDE_A, v)),
      xorKey_B_hex: hex(xorKey(SIDE_B, v)),
      paddingBytes_cidLen36_hex: hex(paddingBytes(v, cidLen)),
      paddingBytes_cidLen36_len: 63 - cidLen,
      requestId_A_hex: hex(requestId(SIDE_A, v)),
      requestId_B_hex: hex(requestId(SIDE_B, v)),
    },
  },
  domain_separation_check: {
    // H12 invariant: three subkeys must be pairwise distinct
    signingSeed_eq_xorSeed: hex(signingSeed) === hex(xorSeed),
    signingSeed_eq_padSeed: hex(signingSeed) === hex(padSeed),
    xorSeed_eq_padSeed: hex(xorSeed) === hex(padSeed),
  },
};

// Assert domain separation
if (vectors.domain_separation_check.signingSeed_eq_xorSeed) throw new Error('H12 violated: signingSeed == xorSeed');
if (vectors.domain_separation_check.signingSeed_eq_padSeed) throw new Error('H12 violated: signingSeed == padSeed');
if (vectors.domain_separation_check.xorSeed_eq_padSeed) throw new Error('H12 violated: xorSeed == padSeed');

console.log(JSON.stringify(vectors, null, 2));
writeFileSync('/tmp/claude/pointer-kat-vectors.json', JSON.stringify(vectors, null, 2) + '\n');
console.log('\n✓ Written to /tmp/claude/pointer-kat-vectors.json');
