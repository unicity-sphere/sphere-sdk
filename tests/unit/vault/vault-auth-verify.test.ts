/**
 * vault/auth.ts — the wallet→backend auth contract (Part 2, the `verifySphereAuth`
 * v2 successor).
 *
 * Pins the challenge builder's EXACT byte-string (key order network,pubkey,nonce,
 * issuedAt,expiresAt; Dates→ISO via JSON.stringify) and proves the SERVER-side
 * `verifyVaultAuth` returns the verified ownerId on a faithful bundle and `null`
 * (never throws) on every tamper: wrong prefix, wrong pubkey, wrong network,
 * expired, bad signature.
 *
 * The golden challenge is derived from the SHARED fixture keypair, so the same
 * 130-hex `signMessage` scheme the cross-plan golden vector pins is exercised here.
 */

import { describe, it, expect } from 'vitest';

import { signMessage } from '../../../core/crypto';
import { vaultAuthChallenge, verifyVaultAuth, VAULT_AUTH_PREFIX } from '../../../vault/auth';
import vectors from '../../fixtures/vault-signing-vectors.json';

const { sig } = vectors;
const NETWORK = 'testnet2';
const PUB = sig.pubkey;
const PRIV = sig.priv;
const NONCE = 'NONCE123';
const ISSUED = '2026-06-13T00:00:00.000Z';
const EXPIRES = '2026-06-13T00:05:00.000Z';

/** The golden challenge — a fixed, human-auditable byte-string. */
const GOLDEN_CHALLENGE =
  VAULT_AUTH_PREFIX +
  JSON.stringify({ network: NETWORK, pubkey: PUB, nonce: NONCE, issuedAt: ISSUED, expiresAt: EXPIRES });

/** A clock comfortably inside the [issued, expires] window. */
const NOW = Date.parse('2026-06-13T00:02:00.000Z');

function build(over: Partial<{ network: string; pubkey: string; nonce: string; issuedAt: string; expiresAt: string }> = {}): string {
  return vaultAuthChallenge({
    network: over.network ?? NETWORK,
    pubkey: over.pubkey ?? PUB,
    nonce: over.nonce ?? NONCE,
    issuedAt: over.issuedAt ?? ISSUED,
    expiresAt: over.expiresAt ?? EXPIRES,
  });
}

describe('vaultAuthChallenge — single-source builder', () => {
  it('emits the EXACT prefixed, fixed-key-order JSON challenge', () => {
    expect(build()).toBe(GOLDEN_CHALLENGE);
  });

  it('serializes Date issuedAt/expiresAt to ISO via JSON.stringify (byte-identical to strings)', () => {
    const fromDates = vaultAuthChallenge({
      network: NETWORK,
      pubkey: PUB,
      nonce: NONCE,
      issuedAt: new Date(ISSUED),
      expiresAt: new Date(EXPIRES),
    });
    expect(fromDates).toBe(GOLDEN_CHALLENGE);
  });
});

describe('verifyVaultAuth — server-side verifier', () => {
  it('returns the ownerId for a faithful challenge + signature', () => {
    const challenge = build();
    const signature = signMessage(PRIV, challenge);
    expect(
      verifyVaultAuth({ challenge, signature, expectedPubkey: PUB, expectedNetwork: NETWORK, now: NOW }),
    ).toBe(PUB);
  });

  it('returns null (never throws) on a wrong prefix', () => {
    const challenge = build();
    const signature = signMessage(PRIV, challenge);
    expect(
      verifyVaultAuth({ challenge: challenge.slice(5), signature, expectedPubkey: PUB, expectedNetwork: NETWORK, now: NOW }),
    ).toBeNull();
  });

  it('returns null when the embedded pubkey is not the expected one', () => {
    const challenge = build();
    const signature = signMessage(PRIV, challenge);
    expect(
      verifyVaultAuth({ challenge, signature, expectedPubkey: 'ff'.repeat(33), expectedNetwork: NETWORK, now: NOW }),
    ).toBeNull();
  });

  it('returns null when the embedded network is not the expected one', () => {
    const challenge = build();
    const signature = signMessage(PRIV, challenge);
    expect(
      verifyVaultAuth({ challenge, signature, expectedPubkey: PUB, expectedNetwork: 'mainnet', now: NOW }),
    ).toBeNull();
  });

  it('returns null when the challenge is already expired', () => {
    const challenge = build();
    const signature = signMessage(PRIV, challenge);
    const afterExpiry = Date.parse(EXPIRES) + 1;
    expect(
      verifyVaultAuth({ challenge, signature, expectedPubkey: PUB, expectedNetwork: NETWORK, now: afterExpiry }),
    ).toBeNull();
  });

  it('returns null on a bad signature (a bad sig is a 401, not a 500)', () => {
    const challenge = build();
    // A signature over a DIFFERENT challenge — recovers to a different/None pubkey.
    const wrongSig = signMessage(PRIV, build({ nonce: 'OTHER' }));
    expect(
      verifyVaultAuth({ challenge, signature: wrongSig, expectedPubkey: PUB, expectedNetwork: NETWORK, now: NOW }),
    ).toBeNull();
  });

  it('returns null on a malformed (wrong-length) signature without throwing', () => {
    const challenge = build();
    expect(
      verifyVaultAuth({ challenge, signature: 'deadbeef', expectedPubkey: PUB, expectedNetwork: NETWORK, now: NOW }),
    ).toBeNull();
  });
});
