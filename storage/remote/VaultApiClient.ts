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

/**
 * Durable session store — persists `{jwt, refreshToken}` so a PAGE RELOAD reuses
 * the existing session instead of re-running challenge→verify (which is what made
 * every reload flash `Unauthorized` and churn the rotating session). Mirrors the
 * sphere-api `userApi.ts` pattern (it keeps its JWT in localStorage). Backed by the
 * wallet's own StorageProvider (IndexedDB in browser), so it is cross-env.
 */
export interface VaultSessionStore {
  load(): Promise<{ jwt: string; refreshToken: string } | null>;
  save(tokens: { jwt: string; refreshToken: string }): Promise<void>;
  clear(): Promise<void>;
}

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
  /** Optional durable session store (persists across reloads — see VaultSessionStore). */
  sessionStore?: VaultSessionStore;
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
  /** The single in-flight handshake promise (serialization — see authenticate()). */
  private authenticating: Promise<string> | null = null;
  /** The single in-flight ensure (reuse-persisted-or-auth) promise. */
  private ensuring: Promise<string> | null = null;

  constructor(config: VaultApiClientConfig) {
    this.config = config;
  }

  /** The current JWT, or `null` until `authenticate()` has run. */
  get token(): string | null {
    return this.jwt;
  }

  /**
   * Full handshake (SERIALIZED): fetch a challenge, VERIFY its template, sign the
   * verified literal, exchange it for a JWT + refresh token. Returns the JWT.
   *
   * Concurrent callers collapse onto ONE in-flight handshake — the vault data
   * client and the courier SHARE this instance, so a boot where both the vault's
   * initialize() and a courier 401-self-heal authenticate at once must NOT run two
   * handshakes (each `verify` opens a session on the unique (ownerId, deviceId) row,
   * so the second would rotate the first off and 401 it).
   */
  async authenticate(): Promise<string> {
    if (this.authenticating) return this.authenticating;
    this.authenticating = this.doAuthenticate().finally(() => {
      this.authenticating = null;
    });
    return this.authenticating;
  }

  private async doAuthenticate(): Promise<string> {
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
   * Return a usable JWT, REUSING a persisted session across reloads (the sphere-api
   * pattern) instead of re-running challenge→verify every time — this is why a plain
   * page reload no longer flashes `Unauthorized`. Serialized so the vault data client
   * and the shared courier collapse onto ONE in-flight ensure. Order: in-memory valid
   * JWT → persisted session (rotate if its JWT expired) → full authenticate().
   */
  async ensureAuthenticated(): Promise<string> {
    if (this.jwt && !this.isExpired(this.jwt)) return this.jwt;
    if (this.ensuring) return this.ensuring;
    this.ensuring = this.doEnsure().finally(() => {
      this.ensuring = null;
    });
    return this.ensuring;
  }

  private async doEnsure(): Promise<string> {
    if (this.jwt && !this.isExpired(this.jwt)) return this.jwt;
    // Load the persisted session (survives reload) when we have neither an
    // in-memory JWT nor a refresh token yet.
    if (!this.jwt && !this.refreshToken) {
      const stored = await this.config.sessionStore?.load();
      if (stored) {
        this.jwt = stored.jwt;
        this.refreshToken = stored.refreshToken;
      }
    }
    if (this.jwt && !this.isExpired(this.jwt)) return this.jwt;
    // A loaded-but-expired JWT: rotate quietly via the long-lived refresh token;
    // refresh() self-heals to a full authenticate() if the refresh is also dead.
    if (this.refreshToken) return this.refresh();
    return this.authenticate();
  }

  /** True if the JWT `exp` is past (30s skew). Unparseable → treat as valid (a 401 catches it). */
  private isExpired(jwt: string): boolean {
    try {
      const part = jwt.split('.')[1] ?? '';
      const exp = (JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number }).exp;
      return typeof exp === 'number' ? exp * 1000 <= Date.now() + 30_000 : false;
    } catch {
      return false;
    }
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
    // SELF-HEAL (was: throw). A 401 must RE-ESTABLISH the session, not dead-end the
    // whole vault+courier. Two cases both fall back to a full authenticate():
    //  - no refresh token: a fresh page load where a request (e.g. courier inbox)
    //    fired before initialize()'s authenticate() completed.
    //  - server rejected the refresh: the token was stale/reused, or the session was
    //    rotated/expired (e.g. a deviceId change orphaned the old session).
    // authenticate() is serialized, so concurrent 401s share ONE handshake.
    if (!this.refreshToken) return this.authenticate();
    const tokens = await this.config.authClient.refresh(this.refreshToken);
    if (!tokens) {
      this.jwt = null;
      this.refreshToken = null;
      return this.authenticate();
    }
    this.adopt(tokens);
    return tokens.jwt;
  }

  /** Logout (best-effort) — revokes the session server-side + drops the persisted one. */
  async logout(sessionId: string): Promise<void> {
    await this.config.authClient.logout(sessionId);
    this.jwt = null;
    this.refreshToken = null;
    void this.config.sessionStore?.clear();
  }

  private adopt(tokens: AuthTokens): void {
    this.jwt = tokens.jwt;
    this.refreshToken = tokens.refreshToken;
    // Persist so a page reload reuses this session instead of re-authenticating.
    void this.config.sessionStore?.save({ jwt: tokens.jwt, refreshToken: tokens.refreshToken });
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
