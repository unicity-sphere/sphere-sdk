/**
 * wallet-api/challenge.ts — auth-challenge template verification (S1,
 * ARCHITECTURE §4).
 *
 * The spend key NEVER signs arbitrary server-chosen text. Before signing, the
 * client verifies the challenge:
 *   1. begins with the fixed domain-separation prefix
 *      `unicity:wallet-api:auth:v1\n`;
 *   2. embeds the client's OWN pubkey (and the nonce returned alongside it);
 *   3. carries a structurally sane validity window (`issuedAt < expiresAt`,
 *      window ≤ `MAX_VALIDITY_WINDOW_MS`), using ONLY the server's own
 *      timestamps — NOT the local device clock (#662).
 *
 * Why not gate on the device clock: the challenge is fetched and signed
 * immediately, and the server authoritatively enforces expiry on
 * `/v1/auth/verify`. Comparing the server's `issuedAt`/`expiresAt` against the
 * device's `now` only produced false rejections — a clock off by more than a
 * few minutes (dead RTC, wrong date, bad NTP) failed EVERY sign-in with
 * "Challenge is already expired", a hard send blocker with no security
 * benefit. The anti-forgery property ("never sign arbitrary server text")
 * comes entirely from the prefix + pubkey + nonce + network binding below.
 *
 * The accepted grammar matches the REAL backend (wallet-api M1,
 * src/auth/service.ts): the prefix followed by a single-line JSON object with
 * `network`, `pubkey`, `nonce`, `issuedAt`, `expiresAt` (ISO-8601). This
 * grammar is the client's acceptance contract: a server whose challenge does
 * not parse is refused, by design. The fake server
 * (tests/support/fake-wallet-api.ts) produces exactly this form.
 */

import { ChallengeTemplateError } from './errors';

/** Fixed domain-separation prefix (ARCHITECTURE §4 step 1). */
export const AUTH_CHALLENGE_PREFIX = 'unicity:wallet-api:auth:v1\n';

/** Maximum plausible challenge validity window (server default: NONCE_TTL = 5 min). */
const MAX_VALIDITY_WINDOW_MS = 60 * 60 * 1000;

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

function parseFields(body: string): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ChallengeTemplateError('Challenge body is not the single-line JSON object the backend emits');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ChallengeTemplateError('Challenge body must be a JSON object');
  }
  const fields = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new ChallengeTemplateError(`Challenge field "${key}" must be a string`);
    }
    fields.set(key, value);
  }
  return fields;
}

function requireField(fields: Map<string, string>, key: string): string {
  const value = fields.get(key);
  if (value === undefined || value === '') {
    throw new ChallengeTemplateError(`Challenge is missing the "${key}" field`);
  }
  return value;
}

function parseTimestamp(value: string, key: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new ChallengeTemplateError(`Challenge "${key}" is not a parseable timestamp: ${value}`);
  }
  return ms;
}

/**
 * Verify a server auth challenge before signing. Throws
 * {@link ChallengeTemplateError} on ANY violation — the caller MUST refuse to
 * sign in that case.
 */
export function verifyChallengeTemplate(challenge: string, expect: ChallengeExpectation): void {
  if (typeof challenge !== 'string' || !challenge.startsWith(AUTH_CHALLENGE_PREFIX)) {
    throw new ChallengeTemplateError('Challenge does not start with the unicity:wallet-api:auth:v1 domain prefix');
  }
  const fields = parseFields(challenge.slice(AUTH_CHALLENGE_PREFIX.length));

  const pubkey = requireField(fields, 'pubkey');
  if (pubkey.toLowerCase() !== expect.pubkey.toLowerCase()) {
    throw new ChallengeTemplateError('Challenge embeds a different pubkey than this wallet');
  }

  const nonce = requireField(fields, 'nonce');
  if (nonce !== expect.nonce) {
    throw new ChallengeTemplateError('Challenge nonce does not match the nonce issued with it');
  }

  const network = requireField(fields, 'network');
  if (network !== expect.network) {
    throw new ChallengeTemplateError(`Challenge is for network "${network}", expected "${expect.network}"`);
  }

  const issuedAt = parseTimestamp(requireField(fields, 'issuedAt'), 'issuedAt');
  const expiresAt = parseTimestamp(requireField(fields, 'expiresAt'), 'expiresAt');

  // Server timestamps only — no device-clock comparison (#662). A well-formed
  // challenge has a positive, bounded validity window; actual expiry is the
  // server's authoritative call on /v1/auth/verify.
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_VALIDITY_WINDOW_MS) {
    throw new ChallengeTemplateError('Challenge validity window is implausible');
  }
}
