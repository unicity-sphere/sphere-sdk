/**
 * Shared signing golden vector (§8.1) — the cross-plan crypto contract.
 *
 * `tests/fixtures/vault-signing-vectors.json` is authored here and imported
 * BYTE-FOR-BYTE by Part A's (`token-api`) server test, which asserts the same
 * 130-hex signatures against `verifySignedMessage` imported from
 * `@unicitylabs/sphere-sdk`. Both sides MUST agree, or the server's auth would
 * reject real wallet signatures.
 *
 * The negative case proves the SDK scheme (double-SHA256 over a prefixed
 * length-delimited message, `v‖r‖s` with `v=31+rec`) rejects a plain
 * single-SHA256 secp256k1 `r‖s‖v` forgery — so the server MUST reuse the SDK,
 * never re-implement signing.
 */

import { describe, it, expect } from 'vitest';

import {
  signMessage,
  verifySignedMessage,
  recoverPubkeyFromSignature,
} from '../../../core/crypto';
import vectors from '../../fixtures/vault-signing-vectors.json';

const { sig, negative } = vectors;

describe('vault shared signing golden vector', () => {
  it('signMessage(priv, message) === pinned signature (locks v‖r‖s + double-SHA256)', () => {
    expect(signMessage(sig.priv, sig.message)).toBe(sig.signature);
  });

  it('verifySignedMessage accepts the pinned signature under the fixture pubkey', () => {
    expect(verifySignedMessage(sig.message, sig.signature, sig.pubkey)).toBe(true);
  });

  it('recoverPubkeyFromSignature returns the fixture pubkey', () => {
    expect(recoverPubkeyFromSignature(sig.message, sig.signature)).toBe(sig.pubkey);
  });

  it('rejects a plain-secp256k1 single-SHA256 forgery (proves SDK scheme is not reimplementable)', () => {
    expect(
      verifySignedMessage(sig.message, negative.plainSecpSig, sig.pubkey),
    ).toBe(false);
  });
});
