/**
 * wallet-api/challenge.ts — auth-challenge template verification (S1,
 * ARCHITECTURE §4).
 *
 * The spend key NEVER signs arbitrary server-chosen text. Before signing, the
 * client verifies the challenge:
 *   1. begins with the fixed domain-separation prefix
 *      `unicity:wallet-api:auth:v1\n`;
 *   2. embeds the client's OWN pubkey (and the nonce returned alongside it);
 *   3. carries plausible timestamps (`issuedAt` near now, `expiresAt` in the
 *      future, a sane validity window).
 *
 * The accepted grammar is the prefix line followed by `key: value` lines —
 * `network`, `pubkey`, `nonce`, `issuedAt`, `expiresAt` (ISO-8601). This
 * grammar is the client's acceptance contract: a server whose challenge does
 * not parse is refused, by design. The fake server
 * (tests/support/fake-wallet-api.ts) produces exactly this form.
 */

import { ChallengeTemplateError } from './errors';

/** Fixed domain-separation prefix (ARCHITECTURE §4 step 1). */
export const AUTH_CHALLENGE_PREFIX = 'unicity:wallet-api:auth:v1\n';

/** Allowed clock skew between client and server (ms). */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Maximum plausible challenge validity window (server default: NONCE_TTL = 5 min). */
const MAX_VALIDITY_WINDOW_MS = 60 * 60 * 1000;

export interface ChallengeExpectation {
  /** The client's own compressed pubkey hex — the challenge MUST embed it. */
  pubkey: string;
  /** The nonce returned by `POST /v1/auth/challenge` alongside the challenge. */
  nonce: string;
  /** The client's network — refused if the challenge names a different one. */
  network: string;
  /** Current time, ms since epoch. */
  nowMs: number;
}

function parseFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of body.split('\n')) {
    if (line.trim() === '') continue;
    const idx = line.indexOf(':');
    if (idx <= 0) {
      throw new ChallengeTemplateError(`Challenge line does not parse as "key: value": ${JSON.stringify(line)}`);
    }
    fields.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
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

  if (issuedAt > expect.nowMs + MAX_CLOCK_SKEW_MS) {
    throw new ChallengeTemplateError('Challenge issuedAt is in the future');
  }
  if (expiresAt <= expect.nowMs - MAX_CLOCK_SKEW_MS) {
    throw new ChallengeTemplateError('Challenge is already expired');
  }
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_VALIDITY_WINDOW_MS) {
    throw new ChallengeTemplateError('Challenge validity window is implausible');
  }
}
