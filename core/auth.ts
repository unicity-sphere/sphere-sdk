/**
 * Backend wallet-auth recipe — verify a signed challenge and return the
 * trusted identity. Single misuse-resistant call: combines signature
 * verification and address derivation, returns only proven values, refuses
 * any client-supplied identity claims (there is no `directAddress` parameter
 * on this function, by design).
 *
 * Typical usage in a Fastify/Express endpoint:
 *
 *   const { chainPubkey, directAddress } = await verifySphereAuth({
 *     challenge,    // the text we issued from POST /auth/challenge
 *     signature,    // what the wallet sent back from sign_message
 *     chainPubkey,  // the pubkey the client claimed
 *   });
 *   // chainPubkey is signature-proven; directAddress is math-derived.
 *   // Safe to use either as the user identifier.
 */
import { verifySignedMessage } from './crypto';
import { computeDirectAddressFromChainPubkey } from './address-derivation';

export type AuthVerificationErrorCode = 'SIGNATURE_INVALID' | 'PUBKEY_MALFORMED';

export class AuthVerificationError extends Error {
  readonly code: AuthVerificationErrorCode;
  constructor(message: string, code: AuthVerificationErrorCode) {
    super(message);
    this.name = 'AuthVerificationError';
    this.code = code;
  }
}

export interface SphereAuthInput {
  /** The exact text that was presented to the wallet for signing. */
  readonly challenge: string;
  /** Hex signature returned by the wallet's sign_message intent. */
  readonly signature: string;
  /** Compressed secp256k1 pubkey (66-char hex) the client claims to own. */
  readonly chainPubkey: string;
}

export interface SphereAuthResult {
  /** Pubkey, proven via signature. */
  readonly chainPubkey: string;
  /** Unicity L3 DIRECT:// address, derived from chainPubkey (never claimed). */
  readonly directAddress: string;
}

export async function verifySphereAuth(input: SphereAuthInput): Promise<SphereAuthResult> {
  const { challenge, signature, chainPubkey } = input;

  // 1. Derive the address first — this also serves as pubkey format validation.
  let directAddress: string;
  try {
    directAddress = await computeDirectAddressFromChainPubkey(chainPubkey);
  } catch (err) {
    throw new AuthVerificationError(
      `chainPubkey is malformed: ${(err as Error).message}`,
      'PUBKEY_MALFORMED',
    );
  }

  // 2. Verify the signature against the (now-known-valid-format) pubkey.
  if (!verifySignedMessage(challenge, signature, chainPubkey)) {
    throw new AuthVerificationError(
      'Signature does not verify against chainPubkey',
      'SIGNATURE_INVALID',
    );
  }

  return { chainPubkey, directAddress };
}
