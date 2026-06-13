/**
 * vault/auth.ts — the v2 wallet→backend AUTH contract (successor to the removed
 * `verifySphereAuth`).
 *
 * The challenge is the single byte-string both sides agree on:
 *
 *   challenge = 'unicity:vault:auth:v1\n'
 *             + JSON.stringify({ network, pubkey, nonce, issuedAt, expiresAt })
 *
 * KEY ORDER is exactly `network, pubkey, nonce, issuedAt, expiresAt`; `Date`s are
 * serialized to ISO-8601 by `JSON.stringify`. {@link vaultAuthChallenge} builds it;
 * the wallet (client) verifies the template before signing, and the SERVER verifies
 * the returned signature with {@link verifyVaultAuth} — the misuse-resistant,
 * domain-separated recipe that wallet-api's review found MISSING in the v2 SDK.
 *
 * `verifyVaultAuth` is SELF-CONTAINED (only `core/crypto` primitives) so the
 * token-api server can import it without pulling in any provider/storage code, and
 * it NEVER throws on a bad signature — a bad sig is a 401, not a 500.
 */

import { recoverPubkeyFromSignature, verifySignedMessage } from '../core/crypto';

/** The auth-challenge prefix the server stamps on every challenge. */
export const VAULT_AUTH_PREFIX = 'unicity:vault:auth:v1\n';

/** The challenge body the server JSON-encodes after the prefix (key order is load-bearing). */
export interface VaultAuthChallengeBody {
  network: string;
  pubkey: string;
  nonce: string;
  /** `Date` (serialized to ISO by JSON.stringify) or a pre-formatted ISO string. */
  issuedAt: string | Date;
  /** `Date` (serialized to ISO by JSON.stringify) or a pre-formatted ISO string. */
  expiresAt: string | Date;
}

/**
 * Build the EXACT auth challenge string the server issues. The body key order is
 * fixed at `network, pubkey, nonce, issuedAt, expiresAt`; `Date` values serialize
 * to ISO-8601 strings via `JSON.stringify` (matching token-api `auth.service.ts`
 * byte-for-byte — pinned by the golden auth vector + the e2e).
 */
export function vaultAuthChallenge(body: VaultAuthChallengeBody): string {
  return (
    VAULT_AUTH_PREFIX +
    JSON.stringify({
      network: body.network,
      pubkey: body.pubkey,
      nonce: body.nonce,
      issuedAt: body.issuedAt,
      expiresAt: body.expiresAt,
    })
  );
}

/** Parsed challenge body (timestamps land as ISO strings off the wire). */
interface ParsedAuthBody {
  network: string;
  pubkey: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export interface VerifyVaultAuthParams {
  /** The literal challenge string the wallet signed. */
  challenge: string;
  /** The wallet's 130-hex signature over `challenge`. */
  signature: string;
  /** The pubkey the challenge claims (must equal the embedded + recovered signer). */
  expectedPubkey: string;
  /** The canonical network the server expects (must equal the embedded network). */
  expectedNetwork: string;
  /** Clock for the expiry check; defaults to `Date.now()`. */
  now?: number;
}

/**
 * SERVER-side verifier (the `verifySphereAuth` v2 successor). Asserts the auth
 * prefix, parses the body, checks the embedded `pubkey`/`network` against the
 * expected values and a non-expired `expiresAt`, then recovers the signer and
 * verifies the signature under the SDK scheme.
 *
 * @returns the verified ownerId (the chain pubkey / signer) on success, or `null`
 * on ANY failure (wrong prefix, bad body, pubkey/network mismatch, expired, bad
 * sig). NEVER throws — a bad signature is a 401, not a 500 (mirrors token-api
 * `auth.service.ts recoverOwner`'s swallow-throws behavior).
 */
export function verifyVaultAuth(params: VerifyVaultAuthParams): string | null {
  const body = parseChallenge(params.challenge);
  if (!body) return null;
  if (body.pubkey !== params.expectedPubkey) return null;
  if (body.network !== params.expectedNetwork) return null;
  if (!isUnexpired(body, params.now ?? Date.now())) return null;
  return recoverAndVerify(params.challenge, params.signature, body.pubkey);
}

/** Assert the prefix and parse the JSON body; `null` on either failure. */
function parseChallenge(challenge: string): ParsedAuthBody | null {
  if (!challenge.startsWith(VAULT_AUTH_PREFIX)) return null;
  try {
    return JSON.parse(challenge.slice(VAULT_AUTH_PREFIX.length)) as ParsedAuthBody;
  } catch {
    return null;
  }
}

/** Plausible window: parseable timestamps and not already expired. */
function isUnexpired(body: ParsedAuthBody, now: number): boolean {
  const expires = Date.parse(body.expiresAt);
  if (Number.isNaN(expires)) return false;
  return expires > now;
}

/**
 * Recover the signer and verify the SDK-scheme signature; the recovered signer
 * MUST equal the (already validated) embedded pubkey. Swallows all throws → null.
 */
function recoverAndVerify(challenge: string, signature: string, pubkey: string): string | null {
  try {
    const signer = recoverPubkeyFromSignature(challenge, signature);
    if (signer !== pubkey) return null;
    if (!verifySignedMessage(challenge, signature, signer)) return null;
    return signer;
  } catch {
    return null;
  }
}
