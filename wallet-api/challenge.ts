/**
 * wallet-api/challenge.ts — auth-challenge template verification (S1,
 * ARCHITECTURE §4).
 *
 * The checks live in `core/wallet-api-protocol.ts` (the single source for the
 * cross-repo contract, #662 device-clock rationale included); this module only
 * preserves the historical wallet-api surface: the same exported names, and
 * violations thrown as the {@link ChallengeTemplateError} that extends
 * WalletApiError (code `CHALLENGE_TEMPLATE`).
 */

import {
  AUTH_CHALLENGE_PREFIX,
  ChallengeTemplateError as ProtocolChallengeTemplateError,
  verifyChallengeTemplate as verifyCanonical,
} from '../core/wallet-api-protocol';
import { ChallengeTemplateError } from './errors';

export { AUTH_CHALLENGE_PREFIX };

export interface ChallengeExpectation {
  /** The client's own compressed pubkey hex — the challenge MUST embed it. */
  pubkey: string;
  /** The nonce returned by `POST /v1/auth/challenge` alongside the challenge. */
  nonce: string;
  /** The client's network — refused if the challenge names a different one. */
  network: string;
  /**
   * @deprecated Ignored since #662. The challenge is validated against the
   * server's own timestamps only; the device clock is never used (a skewed
   * clock previously produced false "expired" rejections). Retained so the
   * exported signature stays source-compatible for existing callers.
   */
  nowMs?: number;
}

/**
 * Verify a server auth challenge before signing. Throws
 * {@link ChallengeTemplateError} on ANY violation — the caller MUST refuse to
 * sign in that case.
 */
export function verifyChallengeTemplate(challenge: string, expect: ChallengeExpectation): void {
  try {
    verifyCanonical(challenge, { pubkey: expect.pubkey, nonce: expect.nonce, network: expect.network });
  } catch (err) {
    if (err instanceof ProtocolChallengeTemplateError) throw new ChallengeTemplateError(err.message);
    throw err;
  }
}
