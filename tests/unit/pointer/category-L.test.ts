/**
 * Category-L conformance suite — identity / key handling per SPEC §11.11.
 *
 * Scope: the aggregator-pointer *identity* boundary — master-key
 * construction, subkey derivation determinism, and the wallet-wide
 * scoping of the BLOCKED_FLAG_KEY template.
 *
 * This file deliberately COMPLEMENTS the existing per-unit tests at
 * tests/unit/profile/pointer/{master-key,secret-key,key-derivation,
 * master-key-zeroize,log-scrub,signing}.test.ts — it does not duplicate
 * their per-field assertions. Each test here maps to a named SPEC
 * obligation (L1..L7) and is written so a reviewer can grep the SPEC
 * clause and find the conformance evidence.
 *
 * Level: unit (no network, no Profile init, no OrbitDB).
 *
 * Notes on residual skips:
 *   - L1 / L2 target SPEC §11.12 / §14.1 (well-known test-key denylist).
 *     v1 of the pointer layer does NOT implement a denylist at
 *     createMasterPrivateKey() time; the spec places the check at
 *     Profile.init(). Until that check lands the L1/L2 obligations
 *     cannot be asserted at this layer — they are marked `.skip` with
 *     an explicit reason so the gap is visible rather than silently
 *     green.
 */

import { describe, it, expect } from 'vitest';
import { inspect } from 'node:util';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  createMasterPrivateKey,
  derivePointerKeyMaterial,
  buildPointerSigner,
  bytesToHex,
  blockedFlagKey,
} from '../../../extensions/uxf/profile/aggregator-pointer/index.js';

// --- Fixtures ---------------------------------------------------------------

/** SPEC §14.1 canonical test-vector key — all-0x01, publicly known. */
const CANONICAL_DENYLIST_BYTES = new Uint8Array(32).fill(0x01);

/** SHA-256(walletPrivateKey) of the canonical vector — used by SPEC §11.12
 *  to test denylist membership without storing the raw scalar. Kept here so
 *  the L1 spec-tether survives future wiring of the denylist check. */
const CANONICAL_DENYLIST_DIGEST = sha256(CANONICAL_DENYLIST_BYTES);

/** Two distinct, non-denylisted keys used across L4/L5/L7. */
const WALLET_A_BYTES = Uint8Array.from(
  Array.from({ length: 32 }, (_, i) => (0x40 + i) & 0xff),
);
const WALLET_B_BYTES = Uint8Array.from(
  Array.from({ length: 32 }, (_, i) => (0x80 + i) & 0xff),
);

// ---------------------------------------------------------------------------
// L1 — SPEC §14.1 denylist key rejected by createMasterPrivateKey
// ---------------------------------------------------------------------------

describe('Category L — identity / key handling (SPEC §11.11)', () => {
  // L1: per SPEC §11.12 the denylist check is REQUIRED but placed at
  // Profile.init() time — NOT inside createMasterPrivateKey. Today
  // createMasterPrivateKey(0x01^32) succeeds and is used by many other
  // tests as an explicit KAT fixture (see tests/unit/profile/pointer/
  // master-key.test.ts, key-derivation.test.ts, signing.test.ts — all
  // of which pin outputs against the §14.1 canonical vector).
  //
  // Skipped — not green — so the conformance gap is visible. Re-enable
  // once a denylist check lands at this layer (or re-home the test at
  // whichever entrypoint eventually carries it).
  it.skip('L1 §14.1 denylist key (all-0x01) is rejected by createMasterPrivateKey [PENDING denylist impl]', () => {
    expect(() => createMasterPrivateKey(CANONICAL_DENYLIST_BYTES)).toThrow();
    // Spec-tether anchor: ensures the digest-form check still resolves
    // even while the runtime check is missing. Do NOT fold this into
    // the thrown assertion — the point is that the implementation can
    // use the digest to test membership without ever storing the raw
    // scalar in a denylist table.
    expect(CANONICAL_DENYLIST_DIGEST.length).toBe(32);
  });

  // ---------------------------------------------------------------------------
  // L2 — §11.12 network='test-vectors' escape valve
  // ---------------------------------------------------------------------------

  // L2: SPEC §11.12 allows the denylisted key ONLY when
  // `config.network === 'test-vectors'`. master-key.ts has no `network`
  // parameter and no such branch; the escape valve (if any) lives at
  // the Profile.init() boundary alongside the rejection it complements.
  // Skipped for the same reason as L1.
  it.skip('L2 §11.12 denylist key allowed when network="test-vectors" [PENDING denylist impl]', () => {
    // If implemented, the signature would plausibly look like:
    //   createMasterPrivateKey(bytes, { network: 'test-vectors' })
    // — returning a valid instance rather than throwing. Today the
    // function takes only `bytes`, so the branch cannot be exercised.
    expect(true).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // L3 — createMasterPrivateKey rejects non-32-byte inputs
  // ---------------------------------------------------------------------------

  it('L3 createMasterPrivateKey rejects non-32-byte inputs across the length spectrum', () => {
    // The existing master-key.test.ts asserts 16 and 33. Complement by
    // covering the boundary conditions that matter for a defensive
    // check: empty, off-by-one on both sides, large, and a
    // `Buffer`-backed view that would silently succeed if the length
    // check compared against something other than `.length`.
    const cases = [
      new Uint8Array(0),
      new Uint8Array(1),
      new Uint8Array(31),
      new Uint8Array(33),
      new Uint8Array(64),
      new Uint8Array(256),
    ];
    for (const input of cases) {
      expect(() => createMasterPrivateKey(input)).toThrow(RangeError);
      expect(() => createMasterPrivateKey(input)).toThrow(/32 bytes/);
    }

    // Subarray view with wrong length must also be rejected — a caller
    // slicing a larger buffer and forgetting the end offset is a
    // realistic bug, and the check MUST NOT be defeated by a view.
    const wideBuf = new Uint8Array(64).fill(0xaa);
    const shortView = wideBuf.subarray(0, 31);
    expect(shortView.length).toBe(31);
    expect(() => createMasterPrivateKey(shortView)).toThrow(RangeError);

    // And the positive boundary — exactly 32 bytes succeeds.
    expect(() => createMasterPrivateKey(new Uint8Array(32).fill(0x22))).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // L4 — different wallet-root keys produce different signingPubKeys
  // ---------------------------------------------------------------------------

  it('L4 two different wallet keys derive DIFFERENT signingPubKeys end-to-end', async () => {
    // L4 asserts the end-to-end identity chain (wallet-root → HKDF
    // subkeys → SigningService.createFromSecret → compressed pubkey)
    // is input-sensitive. key-derivation.test.ts covers the subkey
    // stage; this test threads the whole chain through buildPointerSigner
    // so a regression that collapses the signing stage (e.g. accidental
    // reuse of a constant seed) surfaces here.
    const kmA = derivePointerKeyMaterial(createMasterPrivateKey(WALLET_A_BYTES));
    const kmB = derivePointerKeyMaterial(createMasterPrivateKey(WALLET_B_BYTES));

    const signerA = await buildPointerSigner(kmA.signingSeed);
    const signerB = await buildPointerSigner(kmB.signingSeed);

    expect(signerA.signingPubKeyHex).not.toBe(signerB.signingPubKeyHex);
    // Shape sanity — compressed secp256k1, 33 bytes, 0x02/0x03 prefix.
    expect(signerA.signingPubKey.length).toBe(33);
    expect(signerB.signingPubKey.length).toBe(33);
    expect([0x02, 0x03]).toContain(signerA.signingPubKey[0]);
    expect([0x02, 0x03]).toContain(signerB.signingPubKey[0]);
  });

  // ---------------------------------------------------------------------------
  // L5 — same master-key bytes produce identical signingPubKey (determinism)
  // ---------------------------------------------------------------------------

  it('L5 same master key produces identical signingPubKey across independent runs (determinism)', async () => {
    // signing.test.ts asserts determinism within a single MasterPrivateKey
    // instance. This test asserts the stronger property relevant to
    // recovery flows: two INDEPENDENT MasterPrivateKey instances
    // constructed from the SAME bytes — as would happen across wallet
    // restart / reload cycles — derive to the SAME signingPubKey.
    //
    // Uses three independent instances (not just two) to catch an
    // accidental once-only cache that would still pass with a pair.
    const mk1 = createMasterPrivateKey(WALLET_A_BYTES);
    const mk2 = createMasterPrivateKey(WALLET_A_BYTES);
    const mk3 = createMasterPrivateKey(WALLET_A_BYTES);
    // Each instance MUST be a distinct object with its own backing
    // buffer (copy-discipline) — that's what makes determinism a
    // meaningful property.
    expect(mk1).not.toBe(mk2);
    expect(mk1).not.toBe(mk3);
    expect(mk1.bytes).not.toBe(mk2.bytes);

    const s1 = await buildPointerSigner(derivePointerKeyMaterial(mk1).signingSeed);
    const s2 = await buildPointerSigner(derivePointerKeyMaterial(mk2).signingSeed);
    const s3 = await buildPointerSigner(derivePointerKeyMaterial(mk3).signingSeed);

    expect(s1.signingPubKeyHex).toBe(s2.signingPubKeyHex);
    expect(s2.signingPubKeyHex).toBe(s3.signingPubKeyHex);

    // Bytes match too (hex equality is implied by this, but we check
    // both so a future bytesToHex regression can't silently pass).
    expect(bytesToHex(s1.signingPubKey)).toBe(bytesToHex(s2.signingPubKey));
    expect(bytesToHex(s2.signingPubKey)).toBe(bytesToHex(s3.signingPubKey));
  });

  // ---------------------------------------------------------------------------
  // L6 — SecretKey wrappers never leak raw bytes via any serialization path
  // ---------------------------------------------------------------------------

  it('L6 SecretKey never leaks raw bytes via toString / JSON.stringify / util.inspect / template literals', () => {
    // Conformance version of the log-scrub pattern, scoped narrowly to
    // SPEC §11.11(d)'s denylist:
    //   - pointerSecret, signingSeed, xorSeed, padSeed
    //   - (walletPrivateKey is stored as a raw Uint8Array inside the
    //     MasterPrivateKey and is NOT a SecretKey — out of scope for
    //     this wrapper-centric assertion. The §11.11 narrowing for the
    //     master key is tested via master-key-zeroize.test.ts.)
    //
    // Uses a distinctive input so even accidental 4-byte-prefix leaks
    // of any derived secret are observable in the captured output.
    const mk = createMasterPrivateKey(WALLET_A_BYTES);
    const km = derivePointerKeyMaterial(mk);

    const secretHexes = {
      pointerSecret: bytesToHex(km.pointerSecret.reveal()),
      signingSeed: bytesToHex(km.signingSeed.reveal()),
      xorSeed: bytesToHex(km.xorSeed.reveal()),
      padSeed: bytesToHex(km.padSeed.reveal()),
    };

    // Hit every serialization surface per SPEC §11.11(d). Collect into
    // a single buffer and grep — exactly the pattern in log-scrub
    // but scoped to the denylist instead of the full A/B stack.
    const seeds = [km.pointerSecret, km.signingSeed, km.xorSeed, km.padSeed];
    const capture: string[] = [];
    for (const k of seeds) {
      capture.push(k.toString());
      capture.push(JSON.stringify(k));
      capture.push(JSON.stringify({ nested: k }));
      capture.push(inspect(k, { depth: 5 }));
      capture.push(inspect({ wrapped: { inner: k } }, { depth: 10 }));
      capture.push(`${k}`); // Symbol.toPrimitive
      capture.push(String(k));
      // Own-property enumeration surfaces that TypeScript `private` fails
      capture.push(JSON.stringify(Object.keys(k)));
      capture.push(JSON.stringify(Object.entries(k)));
      capture.push(JSON.stringify({ ...k }));
      capture.push(JSON.stringify(Object.assign({}, k)));
      capture.push(JSON.stringify(Object.getOwnPropertyNames(k)));
    }
    // Also probe a bundle-shaped view (like an error payload might capture).
    capture.push(JSON.stringify({ keyMaterial: km }));
    capture.push(inspect({ keyMaterial: km }, { depth: 10 }));
    // Error-message interpolation — stack traces are the most likely
    // real-world leak path.
    const err = new Error(
      `derivation failed: ps=${km.pointerSecret} ss=${km.signingSeed} xs=${km.xorSeed} pd=${km.padSeed}`,
    );
    capture.push(String(err));
    capture.push(inspect(err));

    // Sanity — the capture harness actually captured something.
    expect(capture.length).toBeGreaterThan(40);
    const joined = capture.join('\n');

    // Full-hex check (64 hex chars) for each secret — hard fail.
    for (const [label, hex] of Object.entries(secretHexes)) {
      expect(joined, `full hex of ${label} leaked`).not.toContain(hex);
    }
    // Partial-leak defence — 16-byte windows from start, middle, end.
    // A partial XOR of the wrapper that dropped the last half is a
    // realistic bug class and this catches it.
    for (const [label, hex] of Object.entries(secretHexes)) {
      const prefix = hex.slice(0, 32);
      const middle = hex.slice(20, 52);
      const suffix = hex.slice(-32);
      expect(joined, `${label} prefix leaked`).not.toContain(prefix);
      expect(joined, `${label} middle leaked`).not.toContain(middle);
      expect(joined, `${label} suffix leaked`).not.toContain(suffix);
    }
    // The redaction marker MUST be present — this proves the
    // serialization paths were actually reached (vs silently throwing
    // and leaving the capture empty, which would let a broken wrapper
    // slip through).
    expect(joined).toContain('REDACTED');
  });

  // ---------------------------------------------------------------------------
  // L7 — BLOCKED state is wallet-wide (wallet-root identity, NOT HD-indexed)
  // ---------------------------------------------------------------------------

  it('L7 BLOCKED_FLAG_KEY is wallet-wide: pointer identity is derived from wallet-root, not an HD child', async () => {
    // Semantic (SPEC §3 per-wallet storage keys + §10.2 BLOCKED state):
    //
    //   BLOCKED_FLAG_KEY = `profile.pointer.blocked.${hex(signingPubKey)}`
    //
    // and `signingPubKey` is derived from the WALLET-ROOT private key
    // (createMasterPrivateKey input) via a single HKDF chain. The
    // pointer layer does NOT fan out by HD index — there is no
    // `addressIndex` parameter in master-key.ts or key-derivation.ts.
    //
    // Consequence: if a wallet is wired at HD index 0 and subsequently
    // switches to HD index 1 (sphere.switchToAddress), the pointer
    // layer's signingPubKey is UNCHANGED because both sessions start
    // from the same wallet-root bytes. Therefore the BLOCKED flag is
    // wallet-wide — flipping it once puts all HD indices of the same
    // wallet into BLOCKED until cleared.
    //
    // Test simulates this by taking two MasterPrivateKey instances from
    // the SAME wallet-root bytes (representing two session contexts
    // that a switchToAddress would produce at the pointer boundary)
    // and verifying they produce the SAME BLOCKED_FLAG_KEY. The
    // converse — DIFFERENT wallets must produce DIFFERENT keys —
    // is asserted below as a control.

    // Same wallet root → same signingPubKey → same BLOCKED_FLAG_KEY.
    const mkA0 = createMasterPrivateKey(WALLET_A_BYTES);
    const mkA1 = createMasterPrivateKey(WALLET_A_BYTES);
    const signerA0 = await buildPointerSigner(derivePointerKeyMaterial(mkA0).signingSeed);
    const signerA1 = await buildPointerSigner(derivePointerKeyMaterial(mkA1).signingSeed);
    expect(signerA0.signingPubKeyHex).toBe(signerA1.signingPubKeyHex);
    const flagA0 = blockedFlagKey(signerA0.signingPubKeyHex);
    const flagA1 = blockedFlagKey(signerA1.signingPubKeyHex);
    expect(flagA0).toBe(flagA1);
    // Template sanity — the key contains the signingPubKey hex so any
    // future template-string regression surfaces here too.
    expect(flagA0).toContain(signerA0.signingPubKeyHex);
    expect(flagA0.startsWith('profile.pointer.blocked.')).toBe(true);

    // Control: a DIFFERENT wallet-root MUST produce a DIFFERENT key.
    // Without this, a bug that returns a constant string would still
    // pass the same-wallet assertion.
    const signerB = await buildPointerSigner(
      derivePointerKeyMaterial(createMasterPrivateKey(WALLET_B_BYTES)).signingSeed,
    );
    const flagB = blockedFlagKey(signerB.signingPubKeyHex);
    expect(flagB).not.toBe(flagA0);
  });
});
