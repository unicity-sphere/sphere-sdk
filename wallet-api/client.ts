/**
 * wallet-api/client.ts — `WalletApiClient` (sdk-changes S1).
 *
 * A small typed client for the wallet-api backend: challenge→sign→JWT with a
 * rotating refresh token, typed REST for the §16 endpoints, and the WS wake
 * channel (ticket flow — §9). Injected into providers (DI; no singletons).
 *
 * Cross-cutting rules (S1):
 * - **Challenge template verification** — the spend key never signs text that
 *   fails `verifyChallengeTemplate` (prefix + own pubkey + plausible
 *   timestamps). See ./challenge.ts.
 * - **Credential hygiene** — the refresh token lives only in the injected
 *   {@link KeyValueStore} (never a URL, never logged). A rotation-reuse
 *   revocation or refresh expiry falls back to a fresh challenge→sign cycle —
 *   silent, since the wallet key is available at unlock. Non-loopback base
 *   URLs MUST be `https:` (ARCHITECTURE §4 transport rule), enforced at
 *   construction.
 * - **Amounts are decimal strings end-to-end**, parsed with `BigInt` (§11) —
 *   see ./codec.ts.
 *
 * The client also keeps the NORMATIVE LOCAL COPY of open intents (E.3): the
 * server is the primary, but intents are the one server table not
 * re-derivable from blobs — after a server restore (`syncEpoch` change,
 * ARCHITECTURE §5.4) the client re-PUTs its locally-known open intents
 * (idempotent) before anything resumes. `putIntent` persists locally before
 * the server PUT; the local copy survives a failed PUT as the restore
 * backstop.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { signMessage } from '../core/crypto';
import { logger } from '../core/logger';
import { timeoutSignal } from '../core/timeout';
import { completeSignMessage, progressSignMessage } from './intent-signing';
import { WalletApiError } from './errors';
import { verifyChallengeTemplate } from './challenge';
import {
  WakeSocketSupervisor,
  DEFAULT_WAKE_TIMING,
  type WakeSupervisorTiming,
} from './wake-supervisor';
import {
  parseApplyResult,
  parseAuthChallenge,
  parseAuthTokens,
  parseBalances,
  parseBlobUrls,
  parseClaimResult,
  parseDepositResult,
  parseHistoryPage,
  parseIntents,
  parseProgressRecord,
  parseProgressRecords,
  parseInventoryPage,
  parseMailboxPage,
  parsePaymentRequestRecord,
  parsePaymentRequestsPage,
  parseRejectResult,
  parseUploadUrls,
  parseWakeFrame,
  parseWsTicket,
} from './codec';
import type {
  ApplyDeltaRequest,
  BlobUrlEntry,
  CoinBalance,
  CreatePaymentRequestInput,
  FetchLike,
  FetchResponseLike,
  HistoryPage,
  HistoryWireRecord,
  IntentRecord,
  InventoryPage,
  KeyValueStore,
  ListPaymentRequestsParams,
  MailboxClaimResult,
  MailboxDepositRequest,
  MailboxPage,
  PaymentRequestRecord,
  PaymentRequestsPage,
  ProgressRecord,
  RespondPaymentRequestInput,
  SupervisedWakeSocketHandle,
  SuperviseWakeOptions,
  UploadUrlEntry,
  UploadUrlRequest,
  WakeCallback,
  WakeSocketHandle,
  WalletApiClientConfig,
  WalletApiIdentity,
  WalletApiRetryConfig,
  WebSocketFactoryLike,
  WebSocketLike,
} from './types';

interface LocalIntent {
  payload: string;
  status: 'open' | 'completed' | 'aborted';
  createdAt: number;
  /**
   * #516: set when the abort decision could NOT land on the server (dead
   * backend at send-failure cleanup). {@link WalletApiClient.resyncOpenIntents}
   * replays it (PUT + abort) so the server row converges to aborted instead of
   * resume re-executing a send the user watched fail.
   */
  abortPending?: boolean;
  /**
   * E.4/#87: a split intent whose terminal close needs a seed-holder signature. Set at PUT (before
   * the burn); re-PUT with the same flag on a syncEpoch re-seed; the close is signed when it is set.
   */
  requiresSeedClose?: boolean;
  /**
   * E.4 burn-checkpoint backstop: the exact enc1. envelope(s) POSTed to
   * `/v1/intents/{id}/progress`, keyed by opIndex. Persisted BEFORE the first POST and re-POSTed
   * byte-identically on retry / syncEpoch re-seed (content-idempotent; re-encryption is forbidden).
   */
  progress?: Record<number, string>;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

/** Enforce the §4 transport rule: non-loopback MUST be https. */
function assertSecureBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new WalletApiError(`Invalid wallet-api base URL: ${baseUrl}`, 'CONFIG');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new WalletApiError(
      'wallet-api base URL must be https (plain http is allowed only on loopback — ARCHITECTURE §4)',
      'CONFIG'
    );
  }
  return url;
}

/** Platform-neutral bytes→base64 (browser btoa + Node ≥16 global btoa). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function defaultWebSocketFactory(url: string): import('./types').WebSocketLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => import('./types').WebSocketLike }).WebSocket;
  if (!Ctor) {
    throw new WalletApiError(
      'No global WebSocket available — inject webSocketFactory (e.g. the "ws" package on Node < 22)',
      'CONFIG'
    );
  }
  return new Ctor(url);
}

/**
 * Resolved (all-fields-present) form of {@link WalletApiRetryConfig}. Transient
 * NETWORK failures retry on idempotent GETs; a 429 retries on any method
 * (rejected before execution); a 503 retries on GETs. See the config type.
 */
interface ResolvedRetryConfig {
  maxAttempts: number;
  baseMs: number;
  capMs: number;
  jitter: 'full' | 'none';
  honorRetryAfter: boolean;
  maxRetryAfterMs: number;
}

const DEFAULT_RETRY: ResolvedRetryConfig = {
  maxAttempts: 3,
  baseMs: 200,
  capMs: 10_000,
  jitter: 'full',
  honorRetryAfter: true,
  maxRetryAfterMs: 60_000,
};

/**
 * Default per-request timeout for the §16 REST path (#642). Generous — a JSON
 * page normally answers in well under a second; this only cuts off requests
 * that would otherwise hang indefinitely on a stalled socket.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** A finite number ≥ `min`, else `fallback` — sanitizes the public retry config. */
function finiteAtLeast(value: number | undefined, fallback: number, min: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback;
}

/**
 * Fill defaults and SANITIZE (retry is public API): `false` disables retry; a
 * non-finite/negative `maxAttempts` (e.g. `NaN`, which would never satisfy
 * `attempt >= maxAttempts` and loop forever) falls back to the default, and
 * negative/NaN delays fall back too. Always returns a fresh object.
 */
function resolveRetry(cfg: WalletApiRetryConfig | false | undefined): ResolvedRetryConfig {
  if (cfg === false) return { ...DEFAULT_RETRY, maxAttempts: 1 };
  if (!cfg) return { ...DEFAULT_RETRY };
  return {
    maxAttempts: Math.max(1, Math.floor(finiteAtLeast(cfg.maxAttempts, DEFAULT_RETRY.maxAttempts, 1))),
    baseMs: finiteAtLeast(cfg.baseMs, DEFAULT_RETRY.baseMs, 0),
    capMs: finiteAtLeast(cfg.capMs, DEFAULT_RETRY.capMs, 0),
    jitter: cfg.jitter === 'none' ? 'none' : 'full',
    honorRetryAfter: cfg.honorRetryAfter ?? DEFAULT_RETRY.honorRetryAfter,
    maxRetryAfterMs: finiteAtLeast(cfg.maxRetryAfterMs, DEFAULT_RETRY.maxRetryAfterMs, 0),
  };
}

export class WalletApiClient {
  /** Network name (also the blob-key prefix `<network>/t/<sha256>` — §5.2). */
  readonly network: string;

  private readonly baseUrl: string;
  private readonly deviceId: string;
  private readonly storage: KeyValueStore;
  private readonly fetchFn: FetchLike;
  private readonly wsFactory: WebSocketFactoryLike;
  private readonly now: () => number;
  private readonly retry: ResolvedRetryConfig;
  /** Per-request timeout in ms for the §16 REST path (#642); `0` disables. */
  private readonly requestTimeoutMs: number;

  private identity: WalletApiIdentity | null = null;
  private jwt: string | null = null;
  /** Serializes concurrent re-auth attempts. */
  private authInFlight: Promise<void> | null = null;
  /**
   * #583: monotonic auth-session counter. Bumped by every {@link setIdentity}
   * and {@link logout}. A sign-in/refresh attempt captures it at its START and
   * bails before any shared-state mutation (`this.jwt`, the refresh token) if it
   * no longer matches — i.e. the identity moved on while the attempt was async,
   * so its result is stale and would contaminate the new owner. See
   * {@link isStale}.
   */
  private authGeneration = 0;

  /** The construction config, retained so {@link clone} can mint a sibling. */
  private readonly config: WalletApiClientConfig;

  constructor(config: WalletApiClientConfig) {
    const url = assertSecureBaseUrl(config.baseUrl);
    this.baseUrl = url.toString().replace(/\/$/, '');
    if (!config.network) throw new WalletApiError('network is required', 'CONFIG');
    this.network = config.network;
    this.deviceId = config.deviceId;
    this.storage = config.storage;
    if (!config.fetchFn && !(globalThis as { fetch?: FetchLike }).fetch) {
      throw new WalletApiError('No fetch available — inject fetchFn', 'CONFIG');
    }
    // Resolve the global lazily THROUGH globalThis so the implementation keeps
    // its original receiver (browser fetch throws "Illegal invocation" when
    // called detached).
    this.fetchFn =
      config.fetchFn ?? ((u, init) => (globalThis as unknown as { fetch: FetchLike }).fetch(u, init));
    this.wsFactory = config.webSocketFactory ?? defaultWebSocketFactory;
    this.now = config.now ?? (() => Date.now());
    this.retry = resolveRetry(config.retry);
    this.requestTimeoutMs = finiteAtLeast(config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 0);
    this.config = config;
  }

  /**
   * #583: mint a FRESH, identity-less sibling client from the SAME construction
   * config (baseUrl, network, deviceId, storage, fetch/ws factories, clock).
   * Per-address client isolation builds one client per HD address from this, so
   * each address's providers authenticate as their OWN owner with their OWN JWT
   * — an orphaned previous-address poll pump can never drive a client that has
   * been re-authed to a DIFFERENT owner. The shared `storage` is intentional:
   * its keys are namespaced per (network, chainPubkey, deviceId), so per-owner
   * refresh tokens / cursors stay separate (no cross-owner collision). The clone
   * starts with no identity and no JWT — the caller binds it via setIdentity.
   */
  clone(): WalletApiClient {
    return new WalletApiClient(this.config);
  }

  /** Bind the wallet identity this client authenticates as. Resets the session. */
  setIdentity(identity: WalletApiIdentity): void {
    this.identity = identity;
    this.jwt = null;
    // #583: invalidate any in-flight sign-in for the PREVIOUS identity. Nulling
    // `authInFlight` only drops our reference — the orphaned challenge→sign /
    // refresh chain keeps running and could STILL resolve later, at which point
    // it would (a) cache `this.jwt` for the wrong owner and (b) write/clear the
    // refresh token under `refreshTokenKey()`, which is now derived from the NEW
    // identity — cross-owner contamination. Bumping `authGeneration` makes those
    // late mutations self-cancel: every attempt captured the generation at its
    // start and `isStale()`-guards each shared-state write, so a stale chain
    // discards its result instead of clobbering the new owner's session.
    this.authGeneration += 1;
    this.authInFlight = null;
  }

  // ── storage keys (scoped per network + pubkey + device) ────────────────────

  private requireIdentity(): WalletApiIdentity {
    if (!this.identity) throw new WalletApiError('No identity set — call setIdentity() first', 'CONFIG');
    return this.identity;
  }

  private scopedKey(kind: string): string {
    const { chainPubkey } = this.requireIdentity();
    return `wallet-api:${kind}:${this.network}:${chainPubkey}`;
  }

  private refreshTokenKey(): string {
    return `${this.scopedKey('refresh')}:${this.deviceId}`;
  }

  /**
   * #583: true once the identity has moved on since `gen` was captured (a
   * {@link setIdentity}/{@link logout} bumped {@link authGeneration}). A sign-in
   * attempt checks this before every mutation of `this.jwt` or the refresh token
   * and bails out when stale — its tokens belong to a now-discarded owner.
   */
  private isStale(gen: number): boolean {
    return this.authGeneration !== gen;
  }

  // ── auth (ARCHITECTURE §4) ──────────────────────────────────────────────────

  /**
   * Establish a session: try the stored refresh token first (rotating), fall
   * back to a fresh challenge→sign→verify cycle. Safe to call repeatedly.
   */
  async signIn(): Promise<void> {
    if (this.authInFlight) return this.authInFlight;
    // #583: bind this attempt to the CURRENT auth generation. A later
    // setIdentity()/logout() bumps the generation; the attempt then self-cancels
    // before mutating shared state (see `signInInner`/`tryRefresh`/`challengeSignIn`).
    const gen = this.authGeneration;
    const inFlight = this.signInInner(gen).finally(() => {
      // #583: only clear the slot if it still holds THIS promise. setIdentity()
      // may null `authInFlight` (abandoning a stale sign-in) and a fresh signIn()
      // may have stored a NEW promise; an unconditional clear here would clobber
      // that newer in-flight sign-in and break the de-dup guarantee.
      if (this.authInFlight === inFlight) this.authInFlight = null;
    });
    this.authInFlight = inFlight;
    return inFlight;
  }

  private async signInInner(gen: number): Promise<void> {
    if (await this.tryRefresh(gen)) return;
    // #583: `tryRefresh` returns false for TWO reasons — a genuine refresh miss
    // (no/expired token) OR the identity moved on mid-refresh (`isStale`). In the
    // stale case we must NOT fall through to a challenge→verify cycle: it would
    // run under the NEW owner, hit the network, possibly throw, and be discarded
    // by `challengeSignIn`'s own end-guard anyway. Bail cleanly instead.
    if (this.isStale(gen)) return;
    await this.challengeSignIn(gen);
  }

  /**
   * `POST /v1/auth/refresh` with the stored token; rotates on success. Any
   * 4xx (expired, revoked, rotation-reuse revocation) clears the stored token
   * and reports `false` — the caller falls back to a challenge cycle.
   */
  private async tryRefresh(gen: number): Promise<boolean> {
    // #583: capture the refresh-token key NOW. The whole attempt operates on
    // THIS owner's key; a mid-flight identity switch repoints `refreshTokenKey()`
    // at the new owner, so we must never read or write under the new key here.
    const key = this.refreshTokenKey();
    const stored = await this.storage.get(key);
    if (!stored) return false;
    const res = await this.rawFetch('POST', '/v1/auth/refresh', { refreshToken: stored });
    // The identity may have moved on while the request was in flight — discard
    // the result rather than caching the previous owner's JWT / refresh token.
    if (this.isStale(gen)) return false;
    if (res.status === 200) {
      const tokens = parseAuthTokens(await this.readJson(res, 'auth/refresh'));
      this.jwt = tokens.jwt;
      await this.storage.set(key, tokens.refreshToken);
      return true;
    }
    // Stale/revoked/reused token — discard it; a fresh challenge cycle follows.
    await this.storage.remove(key);
    return false;
  }

  /** The challenge→verify cycle (§4 steps 1–3) with template verification (S1). */
  private async challengeSignIn(gen: number): Promise<void> {
    const identity = this.requireIdentity();
    // #583: pin the refresh-token key to THIS owner up front (it is derived from
    // the identity); a mid-flight switch must not write under the new owner's key.
    const key = this.refreshTokenKey();
    const challengeRes = await this.rawFetch('POST', '/v1/auth/challenge', {
      pubkey: identity.chainPubkey,
    });
    if (challengeRes.status !== 200) throw await this.toError(challengeRes, 'auth/challenge');
    const { nonce, challenge } = parseAuthChallenge(await this.readJson(challengeRes, 'auth/challenge'));

    // The spend key never signs unverified server-chosen text (S1).
    verifyChallengeTemplate(challenge, {
      pubkey: identity.chainPubkey,
      nonce,
      network: this.network,
      nowMs: this.now(),
    });

    const signature = signMessage(identity.privateKey, challenge);
    const verifyRes = await this.rawFetch('POST', '/v1/auth/verify', {
      nonce,
      signature,
      deviceId: this.deviceId,
    });
    if (verifyRes.status !== 200) throw await this.toError(verifyRes, 'auth/verify');
    const tokens = parseAuthTokens(await this.readJson(verifyRes, 'auth/verify'));
    // The identity may have switched while challenge→verify was in flight —
    // discard this owner's freshly-minted session instead of caching the JWT /
    // persisting the refresh token under the new owner's storage key.
    if (this.isStale(gen)) return;
    this.jwt = tokens.jwt;
    await this.storage.set(key, tokens.refreshToken);
  }

  /** Revoke the session server-side and drop all local credentials. */
  async logout(): Promise<void> {
    // #583: invalidate any in-flight sign-in so it cannot re-cache a JWT or
    // re-persist the refresh token after we have just dropped them.
    this.authGeneration += 1;
    this.authInFlight = null;
    if (this.jwt) {
      try {
        await this.rawFetch('POST', '/v1/auth/logout', {}, this.jwt);
      } finally {
        this.jwt = null;
      }
    }
    await this.storage.remove(this.refreshTokenKey());
  }

  // ── request core ────────────────────────────────────────────────────────────

  private async rawFetch(
    method: string,
    path: string,
    body?: unknown,
    jwt?: string
  ): Promise<FetchResponseLike> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (jwt) headers['authorization'] = `Bearer ${jwt}`;
    try {
      return await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        // #642: a stalled request must not hang until the browser/OS gives up
        // (under a connection-pool pile-up that is effectively forever). The
        // abort lands in the catch below as the transient NETWORK class, so
        // the retry policy applies unchanged (GETs retry, writes don't).
        // timeoutSignal, NOT bare AbortSignal.timeout — the #617 older-WebView
        // guard (iOS 15 / older Android WebViews lack AbortSignal.timeout).
        signal: this.requestTimeoutMs > 0 ? timeoutSignal(this.requestTimeoutMs) : undefined,
      });
    } catch (err) {
      throw new WalletApiError(`wallet-api request failed: ${method} ${path}`, 'NETWORK', undefined, err);
    }
  }

  private async readJson(res: FetchResponseLike, what: string): Promise<unknown> {
    const text = await res.text();
    if (text === '') return null;
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new WalletApiError(`${what}: response is not JSON`, 'PROTOCOL', res.status, err);
    }
  }

  private async toError(res: FetchResponseLike, what: string): Promise<WalletApiError> {
    let message = `${what} failed with status ${res.status}`;
    try {
      const body = (await this.readJson(res, what)) as { error?: { code?: string; message?: string } } | null;
      if (body?.error?.message) message = `${what}: ${body.error.code ?? ''} ${body.error.message}`.trim();
    } catch {
      // keep the generic message
    }
    return WalletApiError.fromStatus(res.status, message);
  }

  /**
   * Retry transient REST failures with bounded exponential backoff + jitter:
   * - a thrown transient `NETWORK` failure (dropped/reset connection, DNS blip)
   *   retries on **idempotent requests** — every GET, plus a write the caller
   *   marked `idempotentWrite` (the server replays it as a no-op, so a
   *   lost-response retry cannot double-apply; today only `inventory/apply`,
   *   idempotent by transferId — #664). A non-idempotent write is single-attempt;
   * - a `429` response retries on **any** method (a 429 is rejected before the
   *   handler runs — the write never executed), honoring the server `Retry-After`;
   * - a `503` response retries on **idempotent requests only** (a non-idempotent
   *   write may have started).
   * Every other outcome (2xx, or a non-retryable status) is returned to the
   * caller, which maps a non-2xx to a typed {@link WalletApiError}.
   */
  private async rawFetchWithRetry(
    method: string,
    path: string,
    body: unknown,
    jwt: string,
    idempotentWrite = false
  ): Promise<FetchResponseLike> {
    // GETs are idempotent by method; a write is retry-safe only when the caller
    // explicitly declares it so (idempotentWrite) — i.e. the server makes a
    // re-applied request a no-op replay, so a lost-response retry cannot double
    // apply. Today that is `POST /v1/inventory/apply` (idempotent by transferId;
    // #664).
    const idempotent = method === 'GET' || idempotentWrite;
    for (let attempt = 1; ; attempt += 1) {
      let res: FetchResponseLike;
      try {
        res = await this.rawFetch(method, path, body, jwt);
      } catch (err) {
        const transient = err instanceof WalletApiError && err.code === 'NETWORK';
        if (!transient || !idempotent || attempt >= this.retry.maxAttempts) throw err;
        await this.sleep(this.backoffMs(attempt));
        continue;
      }
      const waitMs = this.retryDelayForStatus(res, idempotent, attempt);
      if (waitMs === null || attempt >= this.retry.maxAttempts) return res;
      await this.sleep(waitMs);
    }
  }

  /** Bounded full-jitter exponential backoff (mirrors the wake supervisor). */
  private backoffMs(attempt: number): number {
    const capped = Math.min(this.retry.capMs, this.retry.baseMs * 2 ** (attempt - 1));
    return this.retry.jitter === 'none' ? capped : Math.floor(Math.random() * capped);
  }

  /**
   * Delay before retrying a non-2xx response, or `null` to not retry. `429`
   * retries on any method (rejected before execution); `503` on idempotent
   * requests only. Honors a capped `Retry-After` when present, else backoff.
   */
  private retryDelayForStatus(res: FetchResponseLike, idempotent: boolean, attempt: number): number | null {
    const retryable = res.status === 429 || (res.status === 503 && idempotent);
    if (!retryable) return null;
    const hinted = this.retry.honorRetryAfter ? this.parseRetryAfter(res) : null;
    // A server `Retry-After` is capped at `maxRetryAfterMs`. The fallback backoff
    // is already bounded by `capMs`, so it is NOT re-clamped here — otherwise a
    // small `maxRetryAfterMs` would shrink every backoff too (contradicting its
    // documented "ceiling for an honored Retry-After" contract).
    return hinted === null ? this.backoffMs(attempt) : Math.min(hinted, this.retry.maxRetryAfterMs);
  }

  /** Parse `Retry-After` (delta-seconds or an HTTP-date) to ms, or `null` if absent/unparseable. */
  private parseRetryAfter(res: FetchResponseLike): number | null {
    const raw = res.headers?.get('retry-after');
    if (!raw) return null;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const when = Date.parse(raw);
    return Number.isNaN(when) ? null : Math.max(0, when - this.now());
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Authenticated JSON request. A 401 triggers one silent re-auth
   * (refresh → challenge fallback) and one retry; {@link rawFetchWithRetry}
   * additionally rides out transient failures — a dropped connection on an
   * idempotent request (any GET, or a write flagged `opts.idempotent`), or a
   * `429`/`503` with `Retry-After` — so a single blip or a brief rate-limit
   * window doesn't fail the call.
   */
  private async requestJson(
    method: string,
    path: string,
    body?: unknown,
    opts?: { idempotent?: boolean }
  ): Promise<unknown> {
    const idempotent = opts?.idempotent ?? false;
    if (!this.jwt) await this.signIn();
    const usedJwt = this.jwt;
    let res = await this.rawFetchWithRetry(method, path, body, this.jwt!, idempotent);
    if (res.status === 401) {
      // A concurrent request may already have refreshed the JWT since ours went
      // out. Only drive a (re-)auth if `this.jwt` is still the token we used (or
      // a peer's in-flight refresh nulled it — `signIn()` then coalesces onto
      // that same refresh); if a peer already rotated it to a fresh token, reuse
      // that token and retry once. This avoids a redundant second /auth/refresh
      // and never nulls a peer's freshly-obtained JWT.
      if (this.jwt === usedJwt) this.jwt = null;
      if (!this.jwt) await this.signIn();
      res = await this.rawFetchWithRetry(method, path, body, this.jwt!, idempotent);
    }
    if (res.status === 204) return null;
    if (!res.ok) throw await this.toError(res, `${method} ${path}`);
    return this.readJson(res, `${method} ${path}`);
  }

  // ── inventory / blobs (§16) ─────────────────────────────────────────────────

  /** `GET /v1/inventory?since=` — one page; the caller loops while `more`. */
  async listInventory(since?: bigint): Promise<InventoryPage> {
    const query = since !== undefined ? `?since=${since.toString()}` : '';
    const page = parseInventoryPage(await this.requestJson('GET', `/v1/inventory${query}`));
    await this.noteSyncEpoch(page.syncEpoch);
    return page;
  }

  /** `GET /v1/balances` — active rows only. */
  async getBalances(): Promise<CoinBalance[]> {
    return parseBalances(await this.requestJson('GET', '/v1/balances'));
  }

  /** `POST /v1/tokens/blob-urls` — owner's active *or tombstoned* rows (§5.3 recovery). */
  async getBlobUrls(tokenIds: string[]): Promise<BlobUrlEntry[]> {
    return parseBlobUrls(await this.requestJson('POST', '/v1/tokens/blob-urls', { tokenIds }));
  }

  /** `POST /v1/tokens/upload-urls` — checksum/length-bound presigned PUTs (§5.2). */
  async getUploadUrls(blobs: UploadUrlRequest[]): Promise<UploadUrlEntry[]> {
    return parseUploadUrls(await this.requestJson('POST', '/v1/tokens/upload-urls', { blobs }));
  }

  /**
   * `POST /v1/inventory/apply` (§5.3). Also marks the local intent copy
   * completed — the server completes the intent in the same transaction (§16).
   */
  async applyInventoryDelta(req: ApplyDeltaRequest): Promise<bigint> {
    const cursor = parseApplyResult(
      await this.requestJson(
        'POST',
        '/v1/inventory/apply',
        {
          transferId: req.transferId,
          spent: req.spent,
          added: req.added,
          ...(req.externalDelivery !== undefined ? { externalDelivery: req.externalDelivery } : {}),
        },
        // Idempotent by transferId — the server replays a re-applied transferId
        // to the same cursor (beginApplied), so a lost-response retry on a flaky
        // link is safe and won't double-apply (#664).
        { idempotent: true }
      )
    );
    await this.setLocalIntentStatus(req.transferId, 'completed');
    return cursor;
  }

  /** Download blob bytes from a signed GET URL (the URL itself is the credential). */
  async fetchBlob(getUrl: string): Promise<Uint8Array> {
    let res: FetchResponseLike;
    try {
      res = await this.fetchFn(getUrl, { method: 'GET' });
    } catch (err) {
      throw new WalletApiError('blob download failed', 'NETWORK', undefined, err);
    }
    if (!res.ok) throw WalletApiError.fromStatus(res.status, `blob download failed with status ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Upload blob bytes to a signed PUT URL. A `412 Precondition Failed` means
   * the identical blob already exists (content addressing, `If-None-Match: *`
   * — §5.2) and is treated as success.
   *
   * The §5.2 presign binds `x-amz-checksum-sha256` and `if-none-match` (plus
   * `content-length`) as SIGNED HEADERS — a real S3 endpoint rejects the
   * SigV4 signature unless the uploader sends them verbatim. (Caught by the
   * phase-2 harness on first contact with real MinIO — the in-process fake
   * had only validated the body, not the signed headers.)
   */
  async uploadBlob(putUrl: string, bytes: Uint8Array): Promise<void> {
    let res: FetchResponseLike;
    try {
      res = await this.fetchFn(putUrl, {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          'x-amz-checksum-sha256': bytesToBase64(sha256(bytes)),
          'if-none-match': '*',
        },
        body: bytes,
      });
    } catch (err) {
      throw new WalletApiError('blob upload failed', 'NETWORK', undefined, err);
    }
    if (res.ok || res.status === 412) return;
    throw WalletApiError.fromStatus(res.status, `blob upload failed with status ${res.status}`);
  }

  // ── mailbox (§6/§16) ────────────────────────────────────────────────────────

  /**
   * `POST /v1/mailbox` — deposit an already-uploaded finished blob to the
   * recipient's mailbox. Idempotent by content-derived `entry_id` (§6): an
   * existing entry in any status returns `200` with its id, provided the
   * request's recipient and key match the stored entry (a mismatch is `409`).
   */
  async depositMailbox(req: MailboxDepositRequest): Promise<string> {
    return parseDepositResult(
      await this.requestJson('POST', '/v1/mailbox', {
        recipientPubkey: req.recipientPubkey,
        key: req.key,
        transferId: req.transferId,
        stateHash: req.stateHash,
        tokenId: req.tokenId,
        ...(req.memo !== undefined ? { memo: req.memo } : {}),
      })
    );
  }

  /**
   * `GET /v1/mailbox?since=<seq>` — entries of EVERY status are listable for
   * any client-chosen `since`; a claimed entry carries a working `getUrl`
   * while its blob is within retention, `blobCollected: true` afterwards (§6).
   */
  async listMailbox(since?: bigint): Promise<MailboxPage> {
    const query = since !== undefined ? `?since=${since.toString()}` : '';
    const page = parseMailboxPage(await this.requestJson('GET', `/v1/mailbox${query}`));
    await this.noteSyncEpoch(page.syncEpoch);
    return page;
  }

  /**
   * `POST /v1/mailbox/claim` — addressee-only, idempotent ownership handoff
   * (§6). `intoInventory:false` is the delivery-only claim: the entry resolves
   * and the pointer advances with ZERO inventory writes.
   */
  async claimMailbox(entryIds: string[], intoInventory: boolean): Promise<MailboxClaimResult> {
    return parseClaimResult(
      await this.requestJson('POST', '/v1/mailbox/claim', { entryIds, intoInventory })
    );
  }

  /**
   * `POST /v1/mailbox/reject` — addressee-only; terminal for DISCOVERY only:
   * the entry counts toward read-pointer contiguity but remains claimable and
   * its blob is retained (§6 — reject is never a destruction path).
   */
  async rejectMailbox(entryIds: string[]): Promise<string[]> {
    return parseRejectResult(await this.requestJson('POST', '/v1/mailbox/reject', { entryIds }));
  }

  // ── history (§10/§16) ───────────────────────────────────────────────────────

  /**
   * `POST /v1/history` — client-asserted records, deduped by `dedupKey` (the
   * server never writes history rows — §10). `memo`/`counterpartyNametag`
   * MUST already be S6 envelopes.
   */
  async postHistoryRecords(records: HistoryWireRecord[]): Promise<void> {
    await this.requestJson('POST', '/v1/history', { records });
  }

  /** `GET /v1/history?before=&limit=` — newest-first keyset pages (§10). */
  async listHistory(options: { before?: string; limit?: number } = {}): Promise<HistoryPage> {
    const params = new URLSearchParams();
    if (options.before !== undefined) params.set('before', options.before);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    const qs = params.toString();
    return parseHistoryPage(await this.requestJson('GET', `/v1/history${qs ? `?${qs}` : ''}`));
  }

  // ── payment requests (§10/§16) ──────────────────────────────────────────────

  /**
   * `POST /v1/payment-requests` — create a request addressed to a payer (the
   * payer's account is auto-provisioned even if they never authenticated —
   * §4/§9; the per-payer open cap → 429, §5.5). `memo` MUST already be an S6
   * `enc1.` envelope (§8.3) — only the requester's wallet key decrypts it.
   */
  async createPaymentRequest(input: CreatePaymentRequestInput): Promise<PaymentRequestRecord> {
    return parsePaymentRequestRecord(
      await this.requestJson('POST', '/v1/payment-requests', {
        toPubkey: input.toPubkey,
        // Amounts are decimal strings in every JSON body (§11).
        assets: input.assets.map((a) => ({ coinId: a.coinId, amount: a.amount.toString() })),
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: new Date(input.expiresAt).toISOString() } : {}),
      }),
      'payment-request create response'
    );
  }

  /**
   * `GET /v1/payment-requests?role=…` (§16): `'incoming'` is the payer's
   * gap-free `?since=<seq>` stream (cursor = bigint, the standard §16 since
   * contract); `'outgoing'` is the requester's newest-first
   * `?before=<opaque keyset>` backfill (cursor = string | null). The two
   * cursor families never mix — the server 422s a mismatched parameter, and
   * the parameter types make it unrepresentable here.
   */
  async listPaymentRequests<R extends 'incoming' | 'outgoing'>(
    params: Extract<ListPaymentRequestsParams, { role: R }>
  ): Promise<Extract<PaymentRequestsPage, { role: R }>> {
    // Widened to the plain union — generic Extract<> members don't narrow.
    const p: ListPaymentRequestsParams = params;
    const query = new URLSearchParams();
    query.set('role', p.role);
    if (p.status !== undefined) query.set('status', p.status);
    if (p.role === 'incoming') {
      if (p.since !== undefined) query.set('since', p.since.toString());
    } else if (p.before !== undefined) {
      query.set('before', p.before);
    }
    const page = parsePaymentRequestsPage(
      await this.requestJson('GET', `/v1/payment-requests?${query.toString()}`),
      p.role
    );
    await this.noteSyncEpoch(page.syncEpoch);
    // The codec already discriminated the page by role; Extract<> re-states
    // the role-bound cursor family to the caller.
    return page as Extract<PaymentRequestsPage, { role: R }>;
  }

  /**
   * `POST /v1/payment-requests/{id}/respond` — addressee-only (§10, non-
   * addressee → 403); only an `open` request may be responded to (else 409).
   * `paid` REQUIRES and links the fulfilling send's transferId, `declined`
   * carries none — the pairing is enforced by {@link RespondPaymentRequestInput}.
   */
  async respondPaymentRequest(id: string, response: RespondPaymentRequestInput): Promise<PaymentRequestRecord> {
    return parsePaymentRequestRecord(
      await this.requestJson('POST', `/v1/payment-requests/${id}/respond`, response),
      'payment-request respond response'
    );
  }

  // ── intents (E.3) ───────────────────────────────────────────────────────────

  private intentsKey(): string {
    return this.scopedKey('intents');
  }

  private async readLocalIntents(): Promise<Record<string, LocalIntent>> {
    const raw = await this.storage.get(this.intentsKey());
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, LocalIntent>;
    } catch {
      return {};
    }
  }

  private async writeLocalIntents(intents: Record<string, LocalIntent>): Promise<void> {
    await this.storage.set(this.intentsKey(), JSON.stringify(intents));
  }

  private async setLocalIntentStatus(
    transferId: string,
    status: LocalIntent['status'],
    opts: { abortPending?: boolean } = {}
  ): Promise<void> {
    const intents = await this.readLocalIntents();
    const intent = intents[transferId];
    if (!intent) return;
    if (intent.status === 'completed') return; // completed never reverts (§16)
    const abortPending = opts.abortPending === true;
    if (intent.status === status && (intent.abortPending === true) === abortPending) return;
    intent.status = status;
    if (abortPending) intent.abortPending = true;
    else delete intent.abortPending;
    await this.writeLocalIntents(intents);
  }

  /**
   * #670: drop the LOCAL intent copy. Only for a DETERMINISTIC server
   * rejection of the payload (422 `VALIDATION`) on a send that committed
   * nothing on-chain: the server row was never created and a re-PUT of the
   * same bytes can never succeed, so keeping the copy would only poison
   * {@link resyncOpenIntents} with an eternal 422 replay. NEVER call this for
   * transient failures (NETWORK/5xx) — the local copy is the #516
   * double-pay/restore backstop.
   */
  async removeLocalIntent(transferId: string): Promise<void> {
    const intents = await this.readLocalIntents();
    const intent = intents[transferId];
    if (!intent) return;
    // Only a still-'open' copy with no pending server abort is safe to drop:
    // 'completed' never reverts (§16), and an 'aborted'+abortPending copy is a
    // #516 backstop whose server row may still be open.
    if (intent.status !== 'open' || intent.abortPending === true) return;
    delete intents[transferId];
    await this.writeLocalIntents(intents);
  }

  /**
   * Persist a (client-encrypted — S6) intent payload: LOCAL copy first, then
   * `PUT /v1/intents/{transferId}` and await the server ack (E.3 — the engine
   * MUST NOT be called before this resolves). A failed server PUT throws, but
   * the local copy stays as the restore backstop and is re-PUT by
   * {@link resyncOpenIntents} — except a deterministic 422 `VALIDATION`, which
   * the send path makes terminal via {@link removeLocalIntent} (#670).
   */
  async putIntent(
    transferId: string,
    payloadEnvelope: string,
    opts: { requiresSeedClose?: boolean } = {}
  ): Promise<void> {
    const requiresSeedClose = opts.requiresSeedClose === true;
    const intents = await this.readLocalIntents();
    if (!intents[transferId]) {
      intents[transferId] = {
        payload: payloadEnvelope,
        status: 'open',
        createdAt: this.now(),
        ...(requiresSeedClose ? { requiresSeedClose: true } : {}),
      };
      await this.writeLocalIntents(intents);
    }
    await this.requestJson('PUT', `/v1/intents/${transferId}`, this.intentPutBody(payloadEnvelope, requiresSeedClose));
  }

  /** §16/#87: requiresSeedClose is honored only on first insert (write-once); omit it when false. */
  private intentPutBody(payloadEnvelope: string, requiresSeedClose: boolean): Record<string, unknown> {
    return requiresSeedClose ? { payload: payloadEnvelope, requiresSeedClose: true } : { payload: payloadEnvelope };
  }

  // ── intent progress: the E.4 burn checkpoint (sphere-sdk#501) ────────────────

  /**
   * `POST /v1/intents/{id}/progress` — append the split burn checkpoint envelope for `opIndex`,
   * signed with the wallet chain key (§16/#87). Returns the AUTHORITATIVE stored envelope
   * (insert-once first-write-wins: our bytes on 201, the winner's on 200 — the caller adopts it).
   * The envelope is backed up locally BEFORE the POST and re-POSTed byte-identically on retry.
   */
  async postIntentProgress(transferId: string, opIndex: number, payloadEnvelope: string): Promise<string> {
    await this.backstopProgress(transferId, opIndex, payloadEnvelope);
    return this.postProgressEnvelope(transferId, opIndex, payloadEnvelope);
  }

  /**
   * POST one checkpoint envelope (signed) and RECONCILE the local backstop to the AUTHORITATIVE
   * returned envelope. Insert-once first-write-wins: a 200 returns the WINNER's envelope, which may
   * differ from ours if a racing device wrote first — so re-seeding (or a retry) must carry the
   * winner's proof, never our stale losing bytes (which would make our proof authoritative and
   * mismatch the leg the winner already certified). Shared by the append and the syncEpoch re-seed.
   */
  private async postProgressEnvelope(transferId: string, opIndex: number, envelope: string): Promise<string> {
    const signature = this.signProgress(transferId, opIndex, envelope);
    const body = await this.requestJson('POST', `/v1/intents/${transferId}/progress`, { opIndex, payload: envelope, signature });
    const authoritative = parseProgressRecord(body).payload;
    if (authoritative !== envelope) await this.backstopProgress(transferId, opIndex, authoritative);
    return authoritative;
  }

  /** `GET /v1/intents/{id}/progress` → the stored checkpoint records (ascending opIndex). */
  async getIntentProgress(transferId: string): Promise<ProgressRecord[]> {
    return parseProgressRecords(await this.requestJson('GET', `/v1/intents/${transferId}/progress`));
  }

  /** The E.4 seed-holder append signature over the exact stored-envelope bytes. */
  private signProgress(transferId: string, opIndex: number, payloadEnvelope: string): string {
    return signMessage(this.requireIdentity().privateKey, progressSignMessage(transferId, opIndex, payloadEnvelope));
  }

  /** Persist the exact envelope locally before the first POST (dual persistence — E.3/E.4). */
  private async backstopProgress(transferId: string, opIndex: number, payloadEnvelope: string): Promise<void> {
    const intents = await this.readLocalIntents();
    const intent = intents[transferId];
    if (!intent) return; // no local intent (fresh-device append) — the server row is the seed
    const progress = intent.progress ?? {};
    if (progress[opIndex] === payloadEnvelope) return;
    intent.progress = { ...progress, [opIndex]: payloadEnvelope };
    await this.writeLocalIntents(intents);
  }

  /** `GET /v1/intents?status=` — server-side intent list. */
  async listIntents(status: 'open' | 'aborted'): Promise<IntentRecord[]> {
    return parseIntents(await this.requestJson('GET', `/v1/intents?status=${status}`));
  }

  /**
   * `POST /v1/intents/{id}/abort` — soft, recoverable (§16).
   *
   * #516: the LOCAL copy flips to 'aborted' even when the server abort cannot
   * land (dead backend) — leaving it 'open' would make {@link resyncOpenIntents}
   * re-PUT it and the next sign-in's `resumeOpenIntents` RE-EXECUTE a send the
   * user watched fail (and possibly retried manually): a double-pay hazard.
   * An unlanded abort is marked pending and replayed by
   * {@link resyncOpenIntents} (PUT + abort) so the server converges too.
   */
  async abortIntent(transferId: string): Promise<void> {
    try {
      await this.requestJson('POST', `/v1/intents/${transferId}/abort`);
    } catch (err) {
      await this.setLocalIntentStatus(transferId, 'aborted', { abortPending: true });
      throw err;
    }
    await this.setLocalIntentStatus(transferId, 'aborted');
  }

  /**
   * `POST /v1/intents/{id}/complete` — the uniform client-side close (E.3). Always carries the
   * seed-holder signature over `wallet-api.complete.v1:{transferId}` (§16/#87): a checkpoint-bearing
   * intent REQUIRES it, and a valid own-key signature is harmlessly accepted for any other intent —
   * so a fresh-device close (no local flag) still works.
   */
  async completeIntent(transferId: string): Promise<void> {
    const signature = signMessage(this.requireIdentity().privateKey, completeSignMessage(transferId));
    await this.requestJson('POST', `/v1/intents/${transferId}/complete`, { signature });
    await this.setLocalIntentStatus(transferId, 'completed');
  }

  /** The locally-known open intents (the E.3 restore backstop). */
  async listLocalOpenIntents(): Promise<IntentRecord[]> {
    const intents = await this.readLocalIntents();
    return Object.entries(intents)
      .filter(([, i]) => i.status === 'open')
      .map(([transferId, i]) => ({ transferId, payload: i.payload, status: 'open' as const, createdAt: i.createdAt }));
  }

  /**
   * #676: the LOCAL disposition of one intent — its status and the #516
   * `abortPending` flag — or `null` when no local copy exists.
   *
   * Resume ({@link PaymentsModule.resumeOpenIntents}) consults this BEFORE
   * re-executing a server-`open` intent. A clean pre-certification send failure
   * soft-aborts the intent best-effort; when that abort's server leg cannot land
   * (dead backend), {@link abortIntent} flips the LOCAL copy to
   * `aborted`+`abortPending` and re-throws — leaving the SERVER row `open`.
   * `listIntents('open')` (a plain server GET) would then hand that row back and
   * resume would RE-EXECUTE a send the user already watched fail: a double-pay.
   * A `null` result (fresh device — no local copy) leaves the server row
   * authoritative, so resume correctly proceeds.
   */
  async getLocalIntent(
    transferId: string
  ): Promise<{ status: 'open' | 'completed' | 'aborted'; abortPending: boolean } | null> {
    const intents = await this.readLocalIntents();
    const intent = intents[transferId];
    if (!intent) return null;
    return { status: intent.status, abortPending: intent.abortPending === true };
  }

  /**
   * #676 (PR #681 review): the LOCAL disposition of EVERY known intent, keyed by
   * transferId, read + parsed in ONE pass. {@link PaymentsModule.resumeOpenIntents}
   * consults the local record before re-executing each server-`open` intent (see
   * {@link getLocalIntent}); calling the per-intent read once per server-open
   * intent re-parses the whole intents blob N times. This batch read parses it
   * ONCE so resume is O(1) reads regardless of the open-intent count. A `transferId`
   * absent from the map has no local copy (fresh device) → the server row is
   * authoritative and resume proceeds.
   */
  async getLocalIntentsMap(): Promise<
    Map<string, { status: 'open' | 'completed' | 'aborted'; abortPending: boolean }>
  > {
    const intents = await this.readLocalIntents();
    const map = new Map<string, { status: 'open' | 'completed' | 'aborted'; abortPending: boolean }>();
    for (const [transferId, intent] of Object.entries(intents)) {
      map.set(transferId, { status: intent.status, abortPending: intent.abortPending === true });
    }
    return map;
  }

  /**
   * Re-PUT every locally-known open intent (idempotent — the server PUT is
   * write-once while open/completed). Called after a `syncEpoch` change
   * (server restore — §5.4): intents are the one server table not
   * re-derivable from blobs.
   *
   * #516: also replays locally-aborted intents whose abort never landed on
   * the server (`abortPending`) — PUT (no-op while open/completed; (re)creates
   * the row after a restore or a failed original PUT) then abort, so the
   * server row lands as 'aborted' instead of an 'open' intent that resume
   * would re-execute. Completed-wins is preserved server-side (§16).
   *
   * #670: replay is per-intent isolated (one failing entry logs and moves on
   * instead of blocking the rest), and a deterministic 422 `VALIDATION` on the
   * abortPending re-PUT clears the pending flag instead of retrying forever —
   * the server will never accept those bytes.
   */
  async resyncOpenIntents(): Promise<void> {
    const intents = await this.readLocalIntents();
    for (const [transferId, intent] of Object.entries(intents)) {
      try {
        if (intent.status === 'open') {
          // Re-PUT with the SAME requiresSeedClose (the restore dropped the row), then re-POST every
          // locally-held checkpoint byte-identically (E.4 — the two tables not blob-derivable).
          await this.requestJson(
            'PUT',
            `/v1/intents/${transferId}`,
            this.intentPutBody(intent.payload, intent.requiresSeedClose === true)
          );
          for (const [opIndex, envelope] of Object.entries(intent.progress ?? {})) {
            // Reconcile to the authoritative record (a concurrent writer may have won the slot) so a
            // later re-seed never re-POSTs stale losing bytes — the wedge Copilot flagged on #638.
            await this.postProgressEnvelope(transferId, Number(opIndex), envelope);
          }
        } else if (intent.status === 'aborted' && intent.abortPending === true) {
          try {
            await this.requestJson(
              'PUT',
              `/v1/intents/${transferId}`,
              this.intentPutBody(intent.payload, intent.requiresSeedClose === true)
            );
          } catch (err) {
            // #670: a 422 `VALIDATION` rejection is DETERMINISTIC — the server
            // will never accept this payload, so the re-PUT can never land and
            // retrying every sync epoch only streams 422s. But a 422 does NOT
            // prove the row was never created (the server validates the payload
            // before row existence), so settle the server side first: an abort
            // that succeeds or 404s proves the row is closed/absent — only then
            // clear the pending flag. Any other abort failure rethrows into the
            // per-intent isolation catch and stays pending (#516 backstop).
            if (!(err instanceof WalletApiError && err.code === 'VALIDATION')) throw err;
            try {
              await this.requestJson('POST', `/v1/intents/${transferId}/abort`);
            } catch (abortErr) {
              if (!(abortErr instanceof WalletApiError && abortErr.code === 'NOT_FOUND')) throw abortErr;
            }
            await this.setLocalIntentStatus(transferId, 'aborted'); // clears abortPending
            continue;
          }
          await this.requestJson('POST', `/v1/intents/${transferId}/abort`);
          await this.setLocalIntentStatus(transferId, 'aborted'); // clears abortPending
        }
      } catch (err) {
        // #670: per-intent isolation — one failing entry must not block the
        // replay of the others (or become an unhandled rejection through the
        // void-ed noteSyncEpoch callers). The entry keeps its local state and
        // is retried on the next sync epoch.
        logger.warn('WalletApi', `resyncOpenIntents: replay of intent ${transferId} failed (retried next epoch):`, err);
      }
    }
  }

  // ── syncEpoch (§5.4/§9) ─────────────────────────────────────────────────────

  private syncEpochKey(): string {
    return this.scopedKey('syncEpoch');
  }

  /**
   * Track the server `syncEpoch` carried by cursor-bearing responses and
   * wakes. On a change (server restore), re-PUT locally-known open intents
   * before anything resumes (E.3). Storage-provider cursor invalidation is
   * the provider's own duty (S2) — it observes the same epoch values.
   */
  private async noteSyncEpoch(epoch: bigint): Promise<void> {
    const stored = await this.storage.get(this.syncEpochKey());
    if (stored === epoch.toString()) return;
    await this.storage.set(this.syncEpochKey(), epoch.toString());
    if (stored !== null) {
      await this.resyncOpenIntents();
    }
  }

  // ── realtime (§9) ───────────────────────────────────────────────────────────

  /**
   * Open the wake channel: `POST /v1/ws-ticket` (JWT-authed, single-use,
   * short TTL) then `GET /v1/ws?ticket=…` — the JWT never appears in a URL.
   * Wakes are nudges only; correctness comes from the `?since=` cursors.
   */
  async connectWakeSocket(onWake: WakeCallback): Promise<WakeSocketHandle> {
    const ws = await this.openWakeSocket();
    ws.onerror = null;
    ws.onclose = null;
    ws.onmessage = (ev) => {
      const frame = parseWakeFrame(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (!frame) return;
      void this.noteSyncEpoch(frame.syncEpoch);
      onWake(frame);
    };
    return { close: () => ws.close() };
  }

  /**
   * Mint a single-use ticket (a 401 silently re-auths via {@link requestJson}),
   * upgrade to a wake socket and resolve once it opens. ONE socket, no
   * auto-reconnect — the building block reused by {@link connectWakeSocket} and
   * the {@link superviseWakeSocket} supervisor.
   */
  private async openWakeSocket(): Promise<WebSocketLike> {
    const ticket = parseWsTicket(await this.requestJson('POST', '/v1/ws-ticket'));
    const wsBase = this.baseUrl.replace(/^http/, 'ws');
    const ws = this.wsFactory(`${wsBase}/v1/ws?ticket=${encodeURIComponent(ticket)}`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (err) => reject(new WalletApiError('wake socket failed to connect', 'NETWORK', undefined, err));
      ws.onclose = () => reject(new WalletApiError('wake socket closed before connecting', 'NETWORK'));
    });
    return ws;
  }

  /**
   * Open a SELF-HEALING wake channel (§9): the supervisor keeps the socket
   * alive across drops — bounded backoff + jitter reconnects (fresh ticket each
   * attempt; a 4401/auth-gone close also refreshes the token), a client-side
   * liveness watchdog that force-reconnects a half-open socket, and a full
   * catch-up pull of every stream on each (re)connect (`onReconnect`) so a dead
   * window converges WITHOUT waiting for the poll. `onStatus` surfaces true
   * socket liveness, decoupled from sign-in state. `close()` tears it down with
   * no further reconnects (a deliberate logout-close never loops).
   */
  superviseWakeSocket(
    options: SuperviseWakeOptions,
    timing: WakeSupervisorTiming = DEFAULT_WAKE_TIMING
  ): SupervisedWakeSocketHandle {
    const supervisor = new WakeSocketSupervisor(
      {
        onWake: (wake) => {
          void this.noteSyncEpoch(wake.syncEpoch);
          options.onWake(wake);
        },
        onReconnect: options.onReconnect,
        onStatus: options.onStatus,
      },
      {
        openSocket: () => this.openWakeSocket(),
        // A 4401/expiry close means the bound token is gone — drop the cached
        // JWT so the next ticket mint re-auths (refresh → challenge fallback).
        onAuthGone: () => {
          this.jwt = null;
        },
        setTimeout: (cb, ms) => setTimeout(cb, ms),
        clearTimeout: (h) => clearTimeout(h),
        random: () => Math.random(),
      },
      timing
    );
    supervisor.start();
    return {
      close: () => supervisor.close(),
      get status() {
        return supervisor.currentStatus;
      },
    };
  }
}
