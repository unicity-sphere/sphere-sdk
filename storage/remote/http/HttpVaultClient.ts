/**
 * HttpVaultClient (Task 8.3, DESIGN §5.4/§5.6/§7.4) — the REAL fetch implementation
 * of the authenticated data seam {@link VaultHttpClient}, against the Bearer-gated
 * `{vaultUrl}/v1/*` endpoints. The swap-in for the fake server's `clientFor(ownerId)`.
 *
 * The owner (`ownerId = chainPubkey`) is NOT a body field — it is carried by the
 * JWT minted by {@link VaultApiClient}. This client reads that JWT (and drives one
 * serialized refresh on a 401) through the injected {@link VaultTokenSource}.
 *
 * Two wire quirks it honours exactly:
 *  - **507 is NOT an error.** A storage-watermark 507 on `PATCH /v1/entries` carries
 *    a full {@link PatchResponse} body (the route does `reply.code(status).send(body)`),
 *    so the client PARSES and RETURNS it (`okStatuses: [507]`). The provider then
 *    folds `rejected[].reason === 'insufficient_storage'`. Other non-2xx throw.
 *  - **401 → ONE refresh + retry** (DESIGN §4.3), serialized in `VaultApiClient`.
 */

import type {
  AccountDeleteResponse,
  DeleteNonceResponse,
  HistoryAppendRecord,
  HistoryAppendResponse,
  HistorySinceResponse,
  PatchOp,
  PatchResponse,
  StateResponse,
  VaultHttpClient,
} from '../types';
import { authedJson } from './http-core';
import type { FetchLike, VaultTokenSource } from './http-core';

/** A 507 body is still a valid PatchResponse — never thrown (DESIGN §5.4). */
const PATCH_OK_STATUSES = [507];

export interface HttpVaultClientConfig {
  /** Vault base URL — `NETWORKS[network].vaultUrl`. */
  vaultUrl: string;
  /** The JWT + serialized-refresh seam (a `VaultApiClient` satisfies it). */
  auth: VaultTokenSource;
  /** Defaults to the global `fetch`; injectable for tests. */
  fetchImpl?: FetchLike;
}

export class HttpVaultClient implements VaultHttpClient {
  private readonly base: string;
  private readonly auth: VaultTokenSource;
  private readonly fetchImpl: FetchLike;

  constructor(config: HttpVaultClientConfig) {
    this.base = config.vaultUrl;
    this.auth = config.auth;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** `PATCH /v1/entries {ops}` — 200 OR 507 both return a `PatchResponse` body. */
  patchEntries(ops: PatchOp[]): Promise<PatchResponse> {
    return this.call<PatchResponse>({
      method: 'PATCH',
      path: '/v1/entries',
      body: { ops },
      okStatuses: PATCH_OK_STATUSES,
    });
  }

  /** `GET /v1/state?since=<cursor>`. */
  getState(since: number): Promise<StateResponse> {
    return this.call<StateResponse>({ method: 'GET', path: `/v1/state?since=${since}` });
  }

  /** `POST /v1/history {records}` — idempotent append; `{accepted, rejected}`. */
  appendHistory(records: HistoryAppendRecord[]): Promise<HistoryAppendResponse> {
    return this.call<HistoryAppendResponse>({
      method: 'POST',
      path: '/v1/history',
      body: { records },
    });
  }

  /** `GET /v1/history?since=<seq>`. */
  historySince(since: number): Promise<HistorySinceResponse> {
    return this.call<HistorySinceResponse>({ method: 'GET', path: `/v1/history?since=${since}` });
  }

  /** `POST /v1/account/delete-nonce` — a fresh single-use delete nonce. */
  deleteNonce(): Promise<DeleteNonceResponse> {
    return this.call<DeleteNonceResponse>({
      method: 'POST',
      path: '/v1/account/delete-nonce',
      body: {},
    });
  }

  /** `DELETE /v1/account {nonce, signature}` — fresh-sig gated; `{ok:false}` on a 401. */
  async deleteAccount(nonce: string, signature: string): Promise<AccountDeleteResponse> {
    // A bad/stale signature is a 401 here; the route models it as `{ok:false}` and
    // the provider returns the boolean. We surface `{ok:false}` rather than throwing.
    try {
      return await this.call<AccountDeleteResponse>({
        method: 'DELETE',
        path: '/v1/account',
        body: { nonce, signature },
      });
    } catch (err) {
      if (isAccountUnauthorized(err)) return { ok: false };
      throw err;
    }
  }

  /** One authenticated round trip (Bearer + 401-refresh-retry) to a JSON endpoint. */
  private call<T>(req: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
    body?: unknown;
    okStatuses?: number[];
  }): Promise<T> {
    return authedJson<T>(this.fetchImpl, this.base, this.auth, req);
  }
}

/**
 * A 401 that survived the single refresh+retry on `DELETE /v1/account` means the
 * delete signature itself was rejected (fresh-sig gate) — the server's `{ok:false}`,
 * not a transport failure. Mapped to `{ok:false}` so the caller returns `false`.
 */
function isAccountUnauthorized(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.name === 'VaultHttpError' &&
    (err as { status?: number }).status === 401
  );
}
