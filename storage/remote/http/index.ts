/**
 * Real fetch HTTP clients for the Token-Vault v2 (Task 8.3) — the public barrel.
 *
 * Phase 6/7 ran the providers against in-memory fakes; this is the REAL layer over
 * `fetch` against `NETWORKS[net].vaultUrl`:
 *  - {@link HttpVaultAuthClient} — raw `/v1/auth/*` (challenge / verify / refresh / logout).
 *  - {@link HttpVaultClient} — authenticated `/v1/entries` · `/state` · `/history` ·
 *    `/account/*` (Bearer JWT + 401-refresh-retry; a 507 PATCH body is a valid response).
 *  - {@link HttpCourierClient} — authenticated `/v1/courier/*`.
 *
 * {@link createVaultHttpClients} is the convenience factory: given a base URL + a
 * {@link VaultTokenSource} (a `VaultApiClient`, or `RemoteTokenStorageProvider`'s
 * `authTokenSource()`), it builds the two authenticated clients sharing that one
 * auth session.
 */

import { HttpVaultAuthClient } from './HttpVaultAuthClient';
import { HttpVaultClient } from './HttpVaultClient';
import { HttpCourierClient } from '../../../transport/courier/http/HttpCourierClient';
import type { FetchLike, VaultTokenSource } from './http-core';

export { HttpVaultAuthClient } from './HttpVaultAuthClient';
export type { HttpVaultAuthClientConfig } from './HttpVaultAuthClient';
export { HttpVaultClient } from './HttpVaultClient';
export type { HttpVaultClientConfig } from './HttpVaultClient';
export { HttpCourierClient } from '../../../transport/courier/http/HttpCourierClient';
export type { HttpCourierClientConfig } from '../../../transport/courier/http/HttpCourierClient';
export { VaultHttpError, withTimeout, DEFAULT_REQUEST_TIMEOUT_MS } from './http-core';
export type { VaultTokenSource, FetchLike } from './http-core';

/** Config for the {@link createVaultHttpClients} convenience factory. */
export interface VaultHttpClientsConfig {
  /** Vault base URL — `NETWORKS[network].vaultUrl`. */
  vaultUrl: string;
  /** The JWT + serialized-refresh seam shared by the data + courier clients. */
  auth: VaultTokenSource;
  /** Defaults to the global `fetch`; injectable for tests / custom agents. */
  fetchImpl?: FetchLike;
  /** Per-request deadline (ms); defaults to `DEFAULT_REQUEST_TIMEOUT_MS`. `0` disables. */
  timeoutMs?: number;
}

/** The real authenticated clients, built over one shared auth session. */
export interface VaultHttpClients {
  vault: HttpVaultClient;
  courier: HttpCourierClient;
}

/**
 * Build the authenticated vault + courier clients over ONE shared {@link
 * VaultTokenSource}. The raw {@link HttpVaultAuthClient} (which `VaultApiClient`
 * wraps) is built separately — pass it as the provider's `authClient`.
 */
export function createVaultHttpClients(config: VaultHttpClientsConfig): VaultHttpClients {
  const { vaultUrl, auth, fetchImpl, timeoutMs } = config;
  return {
    vault: new HttpVaultClient({ vaultUrl, auth, fetchImpl, timeoutMs }),
    courier: new HttpCourierClient({ vaultUrl, auth, fetchImpl, timeoutMs }),
  };
}

/** Build the raw auth client (the provider's `authClient`) over `fetch`. */
export function createVaultAuthClient(vaultUrl: string, fetchImpl?: FetchLike): HttpVaultAuthClient {
  return new HttpVaultAuthClient({ vaultUrl, fetchImpl });
}
