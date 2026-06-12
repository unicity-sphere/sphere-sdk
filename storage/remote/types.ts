/**
 * Vault wire seam (mirrors token-api `/v1/auth/*` + `/v1/entries` + `/v1/state`
 * — DESIGN §4, §5.4). The provider talks to the vault through these typed
 * interfaces, never raw `fetch`.
 *
 * Two seams, mirroring the courier's {@link CourierHttpClient} pattern:
 *  - {@link VaultAuthHttpClient} — the raw auth endpoints (challenge / verify /
 *    refresh / logout). {@link VaultApiClient} wraps it with template
 *    verification + serialized refresh. The fake server and the real fetch+JWT
 *    client both implement it.
 *  - {@link VaultHttpClient} — the AUTHENTICATED data endpoints (PATCH /entries,
 *    GET /state). The caller (`ownerId = chainPubkey`) is implied: the fake
 *    server binds it via `clientFor(ownerId)`; the real client supplies it via
 *    the JWT minted by {@link VaultApiClient}.
 *
 * Phase 8.3 swaps the fake for a real token-api HTTP client implementing these
 * same interfaces — the provider logic is unchanged.
 */

import type { VaultEntryPayload } from '../../vault-aead/entry';

// =============================================================================
// Auth wire (DESIGN §4) — raw endpoints
// =============================================================================

/** `POST /v1/auth/challenge` response. `challenge` is the literal string to sign. */
export interface ChallengeResponse {
  nonce: string;
  challenge: string;
  /** ISO-8601 (the server sends a serialized Date). */
  expiresAt: string;
}

/** `POST /v1/auth/verify` / `POST /v1/auth/refresh` response — the token pair. */
export interface AuthTokens {
  jwt: string;
  refreshToken: string;
}

/** `POST /v1/auth/verify` request body. */
export interface VerifyRequest {
  nonce: string;
  signature: string;
  deviceId: string;
  /** Accepted but IGNORED by the server (it stamps `config.NETWORK`). */
  network?: string;
}

/**
 * The raw auth endpoints. A `null` return models the server's 401 (bad
 * signature / stale-or-reused refresh) — the client maps it to an auth failure
 * without leaking the HTTP layer.
 */
export interface VaultAuthHttpClient {
  /** `POST /v1/auth/challenge {pubkey}`. */
  challenge(pubkey: string): Promise<ChallengeResponse>;
  /** `POST /v1/auth/verify` — `null` on a 401 (bad signature). */
  verify(req: VerifyRequest): Promise<AuthTokens | null>;
  /** `POST /v1/auth/refresh {refreshToken}` — `null` on a 401 (stale / reused). */
  refresh(refreshToken: string): Promise<AuthTokens | null>;
  /** `POST /v1/auth/logout {sessionId}` (Bearer) — 204. */
  logout(sessionId: string): Promise<void>;
}

// =============================================================================
// Vault data wire (DESIGN §5.4) — authenticated endpoints
// =============================================================================

/** Reason a single op was rejected. Lowercase — exactly the server's wire labels. */
export type RejectionReason = 'conflict' | 'entry_too_large' | 'insufficient_storage';

/** One CAS op in a `PATCH /v1/entries` batch. `key` is the OPAQUE wireKey. */
export interface PatchOp {
  key: string;
  baseVersion: number;
  /** Omitted on a delete op (the server retains the last ciphertext). */
  payload?: VaultEntryPayload;
  /** true → tombstone the entry. */
  deleted?: boolean;
}

/** A single rejected op surfaced in the PATCH response. */
export interface PatchRejection {
  key: string;
  reason: RejectionReason;
}

/**
 * `PATCH /v1/entries` response. `conflicts` is ALWAYS an empty array on the wire
 * (the SDK derives its own conflict COUNT from `rejected[].reason === 'conflict'`).
 */
export interface PatchResponse {
  cursor: number;
  applied: string[];
  rejected: PatchRejection[];
  conflicts: never[];
}

/** One `{key,version,payload,deleted,seq}` row in a `/state` page. */
export interface StateEntry {
  key: string;
  version: number;
  payload: VaultEntryPayload;
  deleted: boolean;
  seq: number;
}

/** `GET /v1/state?since=` response page. */
export interface StateResponse {
  cursor: number;
  syncEpoch: number;
  /** Server signature over `epochCanon(network, syncEpoch)`. */
  epochSig: string;
  formatVersion: string;
  more: boolean;
  entries: StateEntry[];
}

// =============================================================================
// History wire (DESIGN §5.6) — single-channel client-asserted log
// =============================================================================

/** One client-asserted history record on a `POST /v1/history` batch. */
export interface HistoryAppendRecord {
  dedupKey: string;
  /** AEAD-sealed `HistoryRecord` JSON, like a vault entry payload. */
  payload: VaultEntryPayload;
}

/** Why a history record was rejected (mirrors the real `HistoryReject`). */
export type HistoryRejectReason = 'record_too_large' | 'history_full';

/** One rejected record surfaced in the append response. */
export interface HistoryRejection {
  dedupKey: string;
  reason: HistoryRejectReason;
}

/** `POST /v1/history` response — `accepted` counts inserts + idempotent dups. */
export interface HistoryAppendResponse {
  accepted: number;
  rejected: HistoryRejection[];
}

/** One stored history row on a `GET /v1/history?since=` page. */
export interface HistoryStateRecord {
  dedupKey: string;
  seq: number;
  payload: VaultEntryPayload;
  /** ISO-8601 (the server serializes a Date). */
  createdAt: string;
}

/** `GET /v1/history?since=<seq>` response. No `more` flag — loop until `< PAGE_LIMIT`. */
export interface HistorySinceResponse {
  records: HistoryStateRecord[];
}

// =============================================================================
// Account wire (DESIGN §7.4) — fresh-signature-gated deletion
// =============================================================================

/** `POST /v1/account/delete-nonce` response — a fresh single-use, owner-bound nonce. */
export interface DeleteNonceResponse {
  nonce: string;
}

/** `DELETE /v1/account {nonce, signature}` response. */
export interface AccountDeleteResponse {
  ok: boolean;
}

/**
 * The authenticated vault data seam. The caller (`ownerId = chainPubkey`) is
 * implied by how the client was obtained. Each method is one `/v1/*` endpoint.
 */
export interface VaultHttpClient {
  /** `PATCH /v1/entries {ops}`. */
  patchEntries(ops: PatchOp[]): Promise<PatchResponse>;
  /** `GET /v1/state?since=<cursor>`. */
  getState(since: number): Promise<StateResponse>;
  /** `POST /v1/history {records}` — idempotent append; 200 with `{accepted, rejected}`. */
  appendHistory(records: HistoryAppendRecord[]): Promise<HistoryAppendResponse>;
  /** `GET /v1/history?since=<seq>` — seq-paginated; loop until a short page. */
  historySince(since: number): Promise<HistorySinceResponse>;
  /** `POST /v1/account/delete-nonce` — a fresh single-use delete nonce. */
  deleteNonce(): Promise<DeleteNonceResponse>;
  /** `DELETE /v1/account {nonce, signature}` — fresh-sig gated; 401 → `{ok:false}`. */
  deleteAccount(nonce: string, signature: string): Promise<AccountDeleteResponse>;
}
