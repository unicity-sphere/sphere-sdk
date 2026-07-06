/**
 * Tests for win-broadcast — RFC-251 Approach D / issue #255 Problem B.
 *
 * Pins the standalone signing module's behavior: payload schema, canonical
 * hash determinism, sign/verify roundtrip, replay-window enforcement,
 * spoof rejection (wrong pubkey), tamper rejection (bit-flip in any
 * field).
 *
 * Uses real PointerSigner (secp256k1 crypto) so the test exercises the
 * actual `Signature.toJSON` ↔ `SigningService.verifyWithPublicKey`
 * round-trip — no mock signing.
 */

import { describe, it, expect } from 'vitest';

import {
  buildPointerSigner,
  derivePointerKeyMaterial,
  createMasterPrivateKey,
} from '../../../extensions/uxf/profile/aggregator-pointer/index.js';
import {
  buildWinBroadcastHash,
  buildWinBroadcastTag,
  MAX_PAYLOAD_AGE_MS,
  signWinBroadcastPayload,
  verifyWinBroadcastPayload,
  WIN_BROADCAST_KIND_MARKER,
  WIN_BROADCAST_SCHEMA_VERSION,
  WIN_BROADCAST_TAG_PREFIX,
  type SignedWinBroadcastPayload,
  type UnsignedWinBroadcastPayload,
} from '../../../extensions/uxf/profile/aggregator-pointer/win-broadcast.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

const WALLET_SEED_A = new Uint8Array(32).fill(0x42);
const WALLET_SEED_B = new Uint8Array(32).fill(0xfe);  // distinct identity for spoof test

async function makeSigner(seed: Uint8Array) {
  const masterKey = createMasterPrivateKey(seed);
  const keyMaterial = derivePointerKeyMaterial(masterKey);
  return buildPointerSigner(keyMaterial.signingSeed);
}

const SAMPLE_CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

function makeUnsignedPayload(
  signingPubKey: string,
  overrides: Partial<UnsignedWinBroadcastPayload> = {},
): UnsignedWinBroadcastPayload {
  return {
    _kind: WIN_BROADCAST_KIND_MARKER,
    v: WIN_BROADCAST_SCHEMA_VERSION,
    version: 42,
    cid: SAMPLE_CID,
    signingPubKey,
    ts: 1716567890123,
    ...overrides,
  };
}

// ── buildWinBroadcastTag ──────────────────────────────────────────────────

describe('buildWinBroadcastTag', () => {
  it('produces the canonical pointer-win:<hex> tag', () => {
    const tag = buildWinBroadcastTag('02ABCDEF');
    expect(tag).toBe(`${WIN_BROADCAST_TAG_PREFIX}02abcdef`);
  });

  it('lowercases the pubkey hex so siblings always agree on the tag', () => {
    expect(buildWinBroadcastTag('02DEADBEEF')).toBe(buildWinBroadcastTag('02deadbeef'));
  });

  it('throws on empty input — fail loud rather than subscribe to "pointer-win:"', () => {
    expect(() => buildWinBroadcastTag('')).toThrow(/non-empty/);
  });
});

// ── buildWinBroadcastHash determinism ─────────────────────────────────────

describe('buildWinBroadcastHash', () => {
  it('produces the same hash for the same payload (determinism)', async () => {
    const signer = await makeSigner(WALLET_SEED_A);
    const p = makeUnsignedPayload(signer.signingPubKeyHex);
    const h1 = await buildWinBroadcastHash(p);
    const h2 = await buildWinBroadcastHash(p);
    expect(Array.from(h1.imprint)).toEqual(Array.from(h2.imprint));
  });

  it('produces different hashes for different `version`s', async () => {
    const signer = await makeSigner(WALLET_SEED_A);
    const a = makeUnsignedPayload(signer.signingPubKeyHex, { version: 1 });
    const b = makeUnsignedPayload(signer.signingPubKeyHex, { version: 2 });
    const ha = await buildWinBroadcastHash(a);
    const hb = await buildWinBroadcastHash(b);
    expect(Array.from(ha.imprint)).not.toEqual(Array.from(hb.imprint));
  });

  it('produces different hashes for different `cid`s', async () => {
    const signer = await makeSigner(WALLET_SEED_A);
    const a = makeUnsignedPayload(signer.signingPubKeyHex, { cid: 'cid-1' });
    const b = makeUnsignedPayload(signer.signingPubKeyHex, { cid: 'cid-2' });
    const ha = await buildWinBroadcastHash(a);
    const hb = await buildWinBroadcastHash(b);
    expect(Array.from(ha.imprint)).not.toEqual(Array.from(hb.imprint));
  });

  it('produces different hashes for different `ts`s', async () => {
    const signer = await makeSigner(WALLET_SEED_A);
    const a = makeUnsignedPayload(signer.signingPubKeyHex, { ts: 1000 });
    const b = makeUnsignedPayload(signer.signingPubKeyHex, { ts: 2000 });
    const ha = await buildWinBroadcastHash(a);
    const hb = await buildWinBroadcastHash(b);
    expect(Array.from(ha.imprint)).not.toEqual(Array.from(hb.imprint));
  });

  it('produces different hashes for different `signingPubKey`s', async () => {
    const signerA = await makeSigner(WALLET_SEED_A);
    const signerB = await makeSigner(WALLET_SEED_B);
    const a = makeUnsignedPayload(signerA.signingPubKeyHex);
    const b = makeUnsignedPayload(signerB.signingPubKeyHex);
    const ha = await buildWinBroadcastHash(a);
    const hb = await buildWinBroadcastHash(b);
    expect(Array.from(ha.imprint)).not.toEqual(Array.from(hb.imprint));
  });

  it('rejects schema v !== 1', async () => {
    const signer = await makeSigner(WALLET_SEED_A);
    const p = { ...makeUnsignedPayload(signer.signingPubKeyHex), v: 2 as 1 };
    await expect(buildWinBroadcastHash(p)).rejects.toThrow(/schema/);
  });

  it('rejects non-integer / out-of-range version', async () => {
    const signer = await makeSigner(WALLET_SEED_A);
    await expect(
      buildWinBroadcastHash(makeUnsignedPayload(signer.signingPubKeyHex, { version: -1 })),
    ).rejects.toThrow(/uint32/);
    await expect(
      buildWinBroadcastHash(makeUnsignedPayload(signer.signingPubKeyHex, { version: 2 ** 32 })),
    ).rejects.toThrow(/uint32/);
    await expect(
      buildWinBroadcastHash(makeUnsignedPayload(signer.signingPubKeyHex, { version: 1.5 })),
    ).rejects.toThrow(/uint32/);
  });

  it('rejects malformed pubkey (length != 33 after hex decode)', async () => {
    const tooShort = '02abcdef';  // 4 bytes, not 33
    await expect(
      buildWinBroadcastHash(makeUnsignedPayload(tooShort)),
    ).rejects.toThrow(/33 bytes/);
  });
});

// ── sign + verify roundtrip ───────────────────────────────────────────────

describe('signWinBroadcastPayload / verifyWinBroadcastPayload roundtrip', () => {
  it('signs a payload and verifies successfully against the same key', async () => {
    const signer = await makeSigner(WALLET_SEED_A);
    const unsigned = makeUnsignedPayload(signer.signingPubKeyHex, { ts: Date.now() });
    const signed = await signWinBroadcastPayload(signer, unsigned);
    expect(signed.sig).toBeTruthy();
    const ok = await verifyWinBroadcastPayload(signed, signer.signingPubKeyHex);
    expect(ok).toBe(true);
  });

  it('refuses to sign when signer pubkey != payload signingPubKey (anti-spoof guard)', async () => {
    const signerA = await makeSigner(WALLET_SEED_A);
    const signerB = await makeSigner(WALLET_SEED_B);
    const unsigned = makeUnsignedPayload(signerB.signingPubKeyHex);
    await expect(signWinBroadcastPayload(signerA, unsigned)).rejects.toThrow(/pubkey/);
  });
});

// ── verify rejects ────────────────────────────────────────────────────────

describe('verifyWinBroadcastPayload rejections', () => {
  let signerA: Awaited<ReturnType<typeof makeSigner>>;
  let signerB: Awaited<ReturnType<typeof makeSigner>>;

  it('rejects payload signed by a different identity', async () => {
    signerA = await makeSigner(WALLET_SEED_A);
    signerB = await makeSigner(WALLET_SEED_B);
    const unsignedForA = makeUnsignedPayload(signerA.signingPubKeyHex, { ts: Date.now() });
    const signed = await signWinBroadcastPayload(signerA, unsignedForA);
    // Try to verify against B's pubkey — must reject (signingPubKey field
    // says A, but verifier expects B).
    const ok = await verifyWinBroadcastPayload(signed, signerB.signingPubKeyHex);
    expect(ok).toBe(false);
  });

  it('rejects payload older than MAX_PAYLOAD_AGE_MS', async () => {
    signerA = await makeSigner(WALLET_SEED_A);
    const oldTs = Date.now() - MAX_PAYLOAD_AGE_MS - 1000;
    const unsigned = makeUnsignedPayload(signerA.signingPubKeyHex, { ts: oldTs });
    const signed = await signWinBroadcastPayload(signerA, unsigned);
    const ok = await verifyWinBroadcastPayload(signed, signerA.signingPubKeyHex);
    expect(ok).toBe(false);
  });

  it('rejects payload from too far in the future (clock skew bound)', async () => {
    signerA = await makeSigner(WALLET_SEED_A);
    const futureTs = Date.now() + MAX_PAYLOAD_AGE_MS + 1000;
    const unsigned = makeUnsignedPayload(signerA.signingPubKeyHex, { ts: futureTs });
    const signed = await signWinBroadcastPayload(signerA, unsigned);
    const ok = await verifyWinBroadcastPayload(signed, signerA.signingPubKeyHex);
    expect(ok).toBe(false);
  });

  it('rejects payload with tampered version field', async () => {
    signerA = await makeSigner(WALLET_SEED_A);
    const unsigned = makeUnsignedPayload(signerA.signingPubKeyHex, { ts: Date.now() });
    const signed = await signWinBroadcastPayload(signerA, unsigned);
    const tampered: SignedWinBroadcastPayload = { ...signed, version: signed.version + 1 };
    const ok = await verifyWinBroadcastPayload(tampered, signerA.signingPubKeyHex);
    expect(ok).toBe(false);
  });

  it('rejects payload with tampered cid field', async () => {
    signerA = await makeSigner(WALLET_SEED_A);
    const unsigned = makeUnsignedPayload(signerA.signingPubKeyHex, { ts: Date.now() });
    const signed = await signWinBroadcastPayload(signerA, unsigned);
    const tampered: SignedWinBroadcastPayload = { ...signed, cid: 'attacker-cid' };
    const ok = await verifyWinBroadcastPayload(tampered, signerA.signingPubKeyHex);
    expect(ok).toBe(false);
  });

  it('rejects payload with tampered ts field', async () => {
    signerA = await makeSigner(WALLET_SEED_A);
    const baseTs = Date.now();
    const unsigned = makeUnsignedPayload(signerA.signingPubKeyHex, { ts: baseTs });
    const signed = await signWinBroadcastPayload(signerA, unsigned);
    const tampered: SignedWinBroadcastPayload = { ...signed, ts: baseTs + 1 };
    // Even a 1-ms shift breaks the signature (canonical hash includes ts).
    const ok = await verifyWinBroadcastPayload(tampered, signerA.signingPubKeyHex);
    expect(ok).toBe(false);
  });

  it('rejects payload with garbage sig', async () => {
    signerA = await makeSigner(WALLET_SEED_A);
    const unsigned = makeUnsignedPayload(signerA.signingPubKeyHex, { ts: Date.now() });
    const signed: SignedWinBroadcastPayload = { ...unsigned, sig: 'not-hex-data' };
    const ok = await verifyWinBroadcastPayload(signed, signerA.signingPubKeyHex);
    expect(ok).toBe(false);
  });

  it('rejects payload with wrong _kind marker', async () => {
    signerA = await makeSigner(WALLET_SEED_A);
    const unsigned = makeUnsignedPayload(signerA.signingPubKeyHex, { ts: Date.now() });
    const signed = await signWinBroadcastPayload(signerA, unsigned);
    // Cast through unknown to bypass type system — simulates wire-level
    // adversary sending a payload with a different _kind marker.
    const tampered = { ...signed, _kind: 'evil' } as unknown as SignedWinBroadcastPayload;
    const ok = await verifyWinBroadcastPayload(tampered, signerA.signingPubKeyHex);
    expect(ok).toBe(false);
  });

  it('rejects payload with unsupported schema version', async () => {
    signerA = await makeSigner(WALLET_SEED_A);
    const unsigned = makeUnsignedPayload(signerA.signingPubKeyHex, { ts: Date.now() });
    const signed = await signWinBroadcastPayload(signerA, unsigned);
    const tampered = { ...signed, v: 99 } as unknown as SignedWinBroadcastPayload;
    const ok = await verifyWinBroadcastPayload(tampered, signerA.signingPubKeyHex);
    expect(ok).toBe(false);
  });

  it('accepts payload within the age window (boundary test)', async () => {
    signerA = await makeSigner(WALLET_SEED_A);
    // Right at the edge — 1 ms inside the window.
    const now = Date.now();
    const ts = now - (MAX_PAYLOAD_AGE_MS - 1);
    const unsigned = makeUnsignedPayload(signerA.signingPubKeyHex, { ts });
    const signed = await signWinBroadcastPayload(signerA, unsigned);
    const ok = await verifyWinBroadcastPayload(signed, signerA.signingPubKeyHex, now);
    expect(ok).toBe(true);
  });
});

// ── JSON wire shape ───────────────────────────────────────────────────────

describe('JSON round-trip (wire compatibility)', () => {
  it('survives JSON.stringify + JSON.parse without loss', async () => {
    const signer = await makeSigner(WALLET_SEED_A);
    const unsigned = makeUnsignedPayload(signer.signingPubKeyHex, { ts: Date.now() });
    const signed = await signWinBroadcastPayload(signer, unsigned);
    const wireString = JSON.stringify(signed);
    const reparsed = JSON.parse(wireString) as SignedWinBroadcastPayload;
    const ok = await verifyWinBroadcastPayload(reparsed, signer.signingPubKeyHex);
    expect(ok).toBe(true);
  });
});
