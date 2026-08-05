/**
 * The ONE source for the wallet-api cross-repo contract strings (§4 auth
 * challenge, E.4/#87/§16 seed-holder messages) — never re-derive them.
 * Grammar + rationale (#662 device-clock ban): wallet-api ARCHITECTURE §4/§16.
 */

import { sha256 } from './crypto';

/** The §16 progress-append message: signed over the EXACT stored-envelope bytes (E.4). */
export function progressSignMessage(transferId: string, opIndex: number, payloadEnvelope: string): string {
  return `wallet-api.progress.v1:${transferId}:${String(opIndex)}:${sha256(payloadEnvelope, 'utf8')}`;
}

/** The §16/#87 terminal-close message for a checkpoint-bearing intent. */
export function completeSignMessage(transferId: string): string {
  return `wallet-api.complete.v1:${transferId}`;
}

/** Fixed domain-separation prefix (ARCHITECTURE §4 step 1). */
export const AUTH_CHALLENGE_PREFIX = 'unicity:wallet-api:auth:v1\n';

/** Maximum plausible challenge validity window (server default: NONCE_TTL = 5 min). */
const MAX_VALIDITY_WINDOW_MS = 60 * 60 * 1000;

export class ChallengeTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChallengeTemplateError';
  }
}

export interface ChallengeExpectation {
  /** The client's own compressed pubkey hex — the challenge MUST embed it. */
  pubkey: string;
  nonce: string;
  /** The client's network — refused if the challenge names a different one. */
  network: string;
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
    if (typeof value !== 'string' || value === '') {
      throw new ChallengeTemplateError(`Challenge field "${key}" must be a non-empty string`);
    }
    fields.set(key, value);
  }
  return fields;
}

function requireField(fields: Map<string, string>, key: string): string {
  const value = fields.get(key);
  if (value === undefined) {
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

/** The spend key never signs unverified server text — throws on ANY violation. */
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

  // Server timestamps only — no device-clock comparison (#662).
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_VALIDITY_WINDOW_MS) {
    throw new ChallengeTemplateError('Challenge validity window is implausible');
  }
}
