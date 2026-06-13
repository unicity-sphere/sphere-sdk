/**
 * VaultApiClient (Task 6.1, DESIGN §4) — the auth half of the vault box.
 *
 * One client per `ownerId` (chain pubkey). It runs the challenge → verify → JWT
 * handshake and rotates the JWT behind a refresh token. Two hard guarantees:
 *
 *  1. CHALLENGE TEMPLATE VERIFICATION BEFORE SIGNING. The spend key never signs
 *     arbitrary server text: the client parses the challenge, asserts the auth
 *     prefix, the embedded `pubkey === our own`, the embedded `network ===` the
 *     expected canonical network, and plausible `issuedAt`/`expiresAt`, and only
 *     THEN signs the server's literal challenge string.
 *  2. SERIALIZED REFRESH. Concurrent 401s share ONE in-flight refresh promise, so
 *     the rotating-refresh server is hit exactly once — a second concurrent hit
 *     would replay the now-stale token and revoke the session (DESIGN §4.3).
 */

import { signMessage } from '../../core/crypto';
import { VAULT_AUTH_PREFIX } from '../../vault/auth';
import type { AuthTokens, ChallengeResponse, VaultAuthHttpClient } from './types';

/** Reject challenges whose lifetime is implausibly long (a clamp on a hostile TTL). */
const MAX_CHALLENGE_TTL_MS = 60 * 60_000; // 1 hour — the real server uses 5 min

export interface VaultApiClientConfig {
  /** Expected canonical network (must match the challenge's embedded network). */
  network: string;
  /** Our own compressed chain pubkey — must equal the challenge's embedded pubkey. */
  chainPubkey: string;
  /** Spend key used to sign the (verified) challenge. */
  privateKey: string;
  /** Stable device id stamped into the session. */
  deviceId: string;
  /** The raw auth wire seam (fake server in tests; fetch+JWT in Phase 8.3). */
  authClient: VaultAuthHttpClient;
}

/** The challenge body the server JSON-encodes after the prefix. */
interface ChallengeBody {
  network: string;
  pubkey: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export class VaultApiClient {
  private readonly config: VaultApiClientConfig;

  private jwt: string | null = null;
  private refreshToken: string | null = null;
  /** The single in-flight refresh promise (serialization, §4.3). */
  private refreshing: Promise<string> | null = null;

  constructor(config: VaultApiClientConfig) {
    this.config = config;
  }

  /** The current JWT, or `null` until `authenticate()` has run. */
  get token(): string | null {
    return this.jwt;
  }

  /**
   * Full handshake: fetch a challenge, VERIFY its template, sign the verified
   * literal, exchange it for a JWT + refresh token. Returns the JWT.
   */
  async authenticate(): Promise<string> {
    const challenge = await this.config.authClient.challenge(this.config.chainPubkey);
    this.verifyChallenge(challenge);
    const signature = signMessage(this.config.privateKey, challenge.challenge);
    const tokens = await this.config.authClient.verify({
      nonce: challenge.nonce,
      signature,
      deviceId: this.config.deviceId,
      network: this.config.network,
    });
    if (!tokens) throw new Error('vault auth: server rejected the signature (401)');
    this.adopt(tokens);
    return tokens.jwt;
  }

  /**
   * Rotate the JWT behind the refresh token, collapsing concurrent callers onto
   * ONE in-flight promise. A `null` from the server (stale/reused token) clears
   * the session and rejects.
   */
  async refresh(): Promise<string> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<string> {
    if (!this.refreshToken) throw new Error('vault auth: no refresh token — call authenticate() first');
    const tokens = await this.config.authClient.refresh(this.refreshToken);
    if (!tokens) {
      this.jwt = null;
      this.refreshToken = null;
      throw new Error('vault auth: refresh rejected (stale or reused)');
    }
    this.adopt(tokens);
    return tokens.jwt;
  }

  /** Logout (best-effort) — revokes the session server-side. */
  async logout(sessionId: string): Promise<void> {
    await this.config.authClient.logout(sessionId);
    this.jwt = null;
    this.refreshToken = null;
  }

  private adopt(tokens: AuthTokens): void {
    this.jwt = tokens.jwt;
    this.refreshToken = tokens.refreshToken;
  }

  /**
   * Verify the challenge template BEFORE signing. Throws (so the spend key never
   * signs) if the prefix is wrong, the embedded pubkey/network mismatch, or the
   * timestamps are implausible.
   */
  private verifyChallenge(c: ChallengeResponse): void {
    if (!c.challenge.startsWith(VAULT_AUTH_PREFIX)) {
      throw new Error('vault auth: challenge missing the expected prefix — refusing to sign');
    }
    const body = this.parseBody(c.challenge);
    if (body.pubkey !== this.config.chainPubkey) {
      throw new Error('vault auth: challenge pubkey is not our own — refusing to sign');
    }
    if (body.network !== this.config.network) {
      throw new Error(
        `vault auth: challenge network "${body.network}" != expected "${this.config.network}" — refusing to sign`,
      );
    }
    this.verifyTimestamps(body);
  }

  private parseBody(challenge: string): ChallengeBody {
    let body: ChallengeBody;
    try {
      body = JSON.parse(challenge.slice(VAULT_AUTH_PREFIX.length)) as ChallengeBody;
    } catch {
      throw new Error('vault auth: challenge body is not valid JSON — refusing to sign');
    }
    return body;
  }

  /** Plausible window: not already expired, and not an implausibly long TTL. */
  private verifyTimestamps(body: ChallengeBody): void {
    const issued = Date.parse(body.issuedAt);
    const expires = Date.parse(body.expiresAt);
    if (Number.isNaN(issued) || Number.isNaN(expires)) {
      throw new Error('vault auth: challenge has unparseable timestamps — refusing to sign');
    }
    const now = Date.now();
    if (expires <= now) {
      throw new Error('vault auth: challenge already expired — refusing to sign');
    }
    if (expires - issued > MAX_CHALLENGE_TTL_MS) {
      throw new Error('vault auth: challenge TTL implausibly long — refusing to sign');
    }
  }
}
