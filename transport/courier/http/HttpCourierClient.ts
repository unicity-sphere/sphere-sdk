/**
 * HttpCourierClient (Task 8.3, DESIGN §6) — the REAL fetch implementation of the
 * courier seam {@link CourierHttpClient}, against the Bearer-gated
 * `{vaultUrl}/v1/courier/*` endpoints. The swap-in for the fake courier server's
 * `clientFor(ownerId)`.
 *
 * The caller (`ownerId = chainPubkey`) is carried by the JWT, not the body. This
 * client reads that JWT (and drives one serialized refresh on a 401) through the
 * injected {@link VaultTokenSource}, reusing the vault's {@link authedJson} core so
 * the Bearer + 401-refresh-retry semantics are identical to the vault data client.
 *
 * Wire notes honoured verbatim:
 *  - deposit → `{entryId, seq, sentSeq, status}` (a 413/429 quota breach THROWS).
 *  - ack ALWAYS returns HTTP 200 with `{result}` — a per-entry problem is `failed`,
 *    never an HTTP error (DESIGN §8.2).
 *  - `/sent` rows carry `ackNonce` (the consumed serverNonce) so the sender can
 *    rebuild + verify the recipient ack template.
 */

import type {
  CourierAckNonceResponse,
  CourierAckRequest,
  CourierAckResponse,
  CourierDepositRequest,
  CourierDepositResponse,
  CourierHttpClient,
  CourierInboxResponse,
  CourierSentResponse,
} from '../types';
import { authedJson, withTimeout } from '../../../storage/remote/http/http-core';
import type { FetchLike, VaultTokenSource } from '../../../storage/remote/http/http-core';

export interface HttpCourierClientConfig {
  /** Vault/courier base URL — `NETWORKS[network].vaultUrl`. */
  vaultUrl: string;
  /** The JWT + serialized-refresh seam (a `VaultApiClient` satisfies it). */
  auth: VaultTokenSource;
  /** Defaults to the global `fetch`; injectable for tests. */
  fetchImpl?: FetchLike;
  /** Per-request deadline (ms); defaults to `DEFAULT_REQUEST_TIMEOUT_MS`. `0` disables. */
  timeoutMs?: number;
}

export class HttpCourierClient implements CourierHttpClient {
  private readonly base: string;
  private readonly auth: VaultTokenSource;
  private readonly fetchImpl: FetchLike;

  constructor(config: HttpCourierClientConfig) {
    this.base = config.vaultUrl;
    this.auth = config.auth;
    this.fetchImpl = withTimeout(config.fetchImpl ?? fetch, config.timeoutMs);
  }

  /** `POST /v1/courier/deposit` — the caller is the sender (a 413/429 quota → throw). */
  deposit(req: CourierDepositRequest): Promise<CourierDepositResponse> {
    return this.call<CourierDepositResponse>({ method: 'POST', path: '/v1/courier/deposit', body: req });
  }

  /** `GET /v1/courier/inbox?since=` — the caller is the recipient. */
  inbox(since: number): Promise<CourierInboxResponse> {
    return this.call<CourierInboxResponse>({ method: 'GET', path: `/v1/courier/inbox?since=${since}` });
  }

  /** `GET /v1/courier/ack-nonce?entryId=` — single-use server nonce. */
  ackNonce(entryId: string): Promise<CourierAckNonceResponse> {
    const q = encodeURIComponent(entryId);
    return this.call<CourierAckNonceResponse>({ method: 'GET', path: `/v1/courier/ack-nonce?entryId=${q}` });
  }

  /** `POST /v1/courier/ack` — frozen `{result}` at 200 (never an HTTP error). */
  ack(req: CourierAckRequest): Promise<CourierAckResponse> {
    return this.call<CourierAckResponse>({ method: 'POST', path: '/v1/courier/ack', body: req });
  }

  /** `GET /v1/courier/sent?since=` — rows carry `ackNonce` once claimed. */
  sent(since: number): Promise<CourierSentResponse> {
    return this.call<CourierSentResponse>({ method: 'GET', path: `/v1/courier/sent?since=${since}` });
  }

  /** One authenticated round trip (Bearer + 401-refresh-retry) to a courier endpoint. */
  private call<T>(req: {
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
  }): Promise<T> {
    return authedJson<T>(this.fetchImpl, this.base, this.auth, req);
  }
}
