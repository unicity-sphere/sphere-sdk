/**
 * HttpVaultAuthClient (Task 8.3, DESIGN §4) — the REAL fetch implementation of the
 * raw auth seam {@link VaultAuthHttpClient}, against `POST {vaultUrl}/v1/auth/*`.
 *
 * It is the swap-in for the fake server's `authClient()`: `VaultApiClient` wraps it
 * with challenge-template verification + serialized refresh, so this layer carries
 * ONLY the wire mapping:
 *  - challenge → `{nonce,challenge,expiresAt}` (200).
 *  - verify / refresh → `{jwt,refreshToken}` (200) or **`null` on a 401** (bad
 *    signature / stale-or-reused token) — the 401 is modelled as `null`, never an
 *    error, exactly as the interface promises.
 *  - logout → 204 (Bearer); any 2xx is accepted.
 */

import type {
  AuthTokens,
  ChallengeResponse,
  VaultAuthHttpClient,
  VerifyRequest,
} from '../types';
import { joinUrl, postJson, VaultHttpError } from './http-core';
import type { FetchLike } from './http-core';

export interface HttpVaultAuthClientConfig {
  /** Vault base URL — `NETWORKS[network].vaultUrl`. */
  vaultUrl: string;
  /** Defaults to the global `fetch`; injectable for tests / custom agents. */
  fetchImpl?: FetchLike;
}

export class HttpVaultAuthClient implements VaultAuthHttpClient {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: HttpVaultAuthClientConfig) {
    this.base = config.vaultUrl;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** `POST /v1/auth/challenge {pubkey}` → the literal challenge to sign. */
  challenge(pubkey: string): Promise<ChallengeResponse> {
    return postJson<ChallengeResponse>(this.fetchImpl, this.base, '/v1/auth/challenge', { pubkey });
  }

  /** `POST /v1/auth/verify` — `null` on a 401 (the server rejected the signature). */
  verify(req: VerifyRequest): Promise<AuthTokens | null> {
    return this.tokensOrNull('/v1/auth/verify', req);
  }

  /** `POST /v1/auth/refresh {refreshToken}` — `null` on a 401 (stale / reused). */
  refresh(refreshToken: string): Promise<AuthTokens | null> {
    return this.tokensOrNull('/v1/auth/refresh', { refreshToken });
  }

  /** `POST /v1/auth/logout {sessionId}` — best-effort; any 2xx (incl. 204) is fine. */
  async logout(sessionId: string): Promise<void> {
    const res = await this.fetchImpl(joinUrl(this.base, '/v1/auth/logout'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok) throw new VaultHttpError(res.status, '/v1/auth/logout', await res.text());
  }

  /**
   * POST a JSON body to a token endpoint, returning the token pair on 200 and
   * `null` on a 401 (the interface's model of a rejected signature / stale token).
   * Any other non-2xx is a real failure → throw.
   */
  private async tokensOrNull(path: string, body: unknown): Promise<AuthTokens | null> {
    const res = await this.fetchImpl(joinUrl(this.base, path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) return null;
    if (!res.ok) throw new VaultHttpError(res.status, path, await res.text());
    return (await res.json()) as AuthTokens;
  }
}
