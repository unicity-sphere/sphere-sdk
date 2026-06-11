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

import { signMessage } from '../core/crypto';
import { WalletApiError } from './errors';
import { verifyChallengeTemplate } from './challenge';
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
  parseInventoryPage,
  parseMailboxPage,
  parseRejectResult,
  parseUploadUrls,
  parseWakeFrame,
  parseWsTicket,
} from './codec';
import type {
  ApplyDeltaRequest,
  BlobUrlEntry,
  CoinBalance,
  FetchLike,
  FetchResponseLike,
  HistoryPage,
  HistoryWireRecord,
  IntentRecord,
  InventoryPage,
  KeyValueStore,
  MailboxClaimResult,
  MailboxDepositRequest,
  MailboxPage,
  UploadUrlEntry,
  UploadUrlRequest,
  WakeCallback,
  WakeSocketHandle,
  WalletApiClientConfig,
  WalletApiIdentity,
  WebSocketFactoryLike,
} from './types';

interface LocalIntent {
  payload: string;
  status: 'open' | 'completed' | 'aborted';
  createdAt: number;
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

export class WalletApiClient {
  /** Network name (also the blob-key prefix `<network>/t/<sha256>` — §5.2). */
  readonly network: string;

  private readonly baseUrl: string;
  private readonly deviceId: string;
  private readonly storage: KeyValueStore;
  private readonly fetchFn: FetchLike;
  private readonly wsFactory: WebSocketFactoryLike;
  private readonly now: () => number;

  private identity: WalletApiIdentity | null = null;
  private jwt: string | null = null;
  /** Serializes concurrent re-auth attempts. */
  private authInFlight: Promise<void> | null = null;

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
  }

  /** Bind the wallet identity this client authenticates as. Resets the session. */
  setIdentity(identity: WalletApiIdentity): void {
    this.identity = identity;
    this.jwt = null;
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

  // ── auth (ARCHITECTURE §4) ──────────────────────────────────────────────────

  /**
   * Establish a session: try the stored refresh token first (rotating), fall
   * back to a fresh challenge→sign→verify cycle. Safe to call repeatedly.
   */
  async signIn(): Promise<void> {
    if (this.authInFlight) return this.authInFlight;
    this.authInFlight = this.signInInner().finally(() => {
      this.authInFlight = null;
    });
    return this.authInFlight;
  }

  private async signInInner(): Promise<void> {
    if (await this.tryRefresh()) return;
    await this.challengeSignIn();
  }

  /**
   * `POST /v1/auth/refresh` with the stored token; rotates on success. Any
   * 4xx (expired, revoked, rotation-reuse revocation) clears the stored token
   * and reports `false` — the caller falls back to a challenge cycle.
   */
  private async tryRefresh(): Promise<boolean> {
    const stored = await this.storage.get(this.refreshTokenKey());
    if (!stored) return false;
    const res = await this.rawFetch('POST', '/v1/auth/refresh', { refreshToken: stored });
    if (res.status === 200) {
      const tokens = parseAuthTokens(await this.readJson(res, 'auth/refresh'));
      this.jwt = tokens.jwt;
      await this.storage.set(this.refreshTokenKey(), tokens.refreshToken);
      return true;
    }
    // Stale/revoked/reused token — discard it; a fresh challenge cycle follows.
    await this.storage.remove(this.refreshTokenKey());
    return false;
  }

  /** The challenge→verify cycle (§4 steps 1–3) with template verification (S1). */
  private async challengeSignIn(): Promise<void> {
    const identity = this.requireIdentity();
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
    this.jwt = tokens.jwt;
    await this.storage.set(this.refreshTokenKey(), tokens.refreshToken);
  }

  /** Revoke the session server-side and drop all local credentials. */
  async logout(): Promise<void> {
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
   * Authenticated JSON request. A 401 triggers one silent re-auth
   * (refresh → challenge fallback) and one retry.
   */
  private async requestJson(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.jwt) await this.signIn();
    let res = await this.rawFetch(method, path, body, this.jwt!);
    if (res.status === 401) {
      this.jwt = null;
      await this.signIn();
      res = await this.rawFetch(method, path, body, this.jwt!);
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
      await this.requestJson('POST', '/v1/inventory/apply', {
        transferId: req.transferId,
        spent: req.spent,
        added: req.added,
        ...(req.externalDelivery !== undefined ? { externalDelivery: req.externalDelivery } : {}),
      })
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
   */
  async uploadBlob(putUrl: string, bytes: Uint8Array): Promise<void> {
    let res: FetchResponseLike;
    try {
      res = await this.fetchFn(putUrl, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
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

  private async setLocalIntentStatus(transferId: string, status: LocalIntent['status']): Promise<void> {
    const intents = await this.readLocalIntents();
    const intent = intents[transferId];
    if (!intent || intent.status === status) return;
    if (intent.status === 'completed') return; // completed never reverts (§16)
    intent.status = status;
    await this.writeLocalIntents(intents);
  }

  /**
   * Persist a (client-encrypted — S6) intent payload: LOCAL copy first, then
   * `PUT /v1/intents/{transferId}` and await the server ack (E.3 — the engine
   * MUST NOT be called before this resolves). A failed server PUT throws, but
   * the local copy stays as the restore backstop and is re-PUT by
   * {@link resyncOpenIntents}.
   */
  async putIntent(transferId: string, payloadEnvelope: string): Promise<void> {
    const intents = await this.readLocalIntents();
    if (!intents[transferId]) {
      intents[transferId] = { payload: payloadEnvelope, status: 'open', createdAt: this.now() };
      await this.writeLocalIntents(intents);
    }
    await this.requestJson('PUT', `/v1/intents/${transferId}`, { payload: payloadEnvelope });
  }

  /** `GET /v1/intents?status=` — server-side intent list. */
  async listIntents(status: 'open' | 'aborted'): Promise<IntentRecord[]> {
    return parseIntents(await this.requestJson('GET', `/v1/intents?status=${status}`));
  }

  /** `POST /v1/intents/{id}/abort` — soft, recoverable (§16). */
  async abortIntent(transferId: string): Promise<void> {
    await this.requestJson('POST', `/v1/intents/${transferId}/abort`);
    await this.setLocalIntentStatus(transferId, 'aborted');
  }

  /** `POST /v1/intents/{id}/complete` — the uniform client-side close (E.3). */
  async completeIntent(transferId: string): Promise<void> {
    await this.requestJson('POST', `/v1/intents/${transferId}/complete`);
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
   * Re-PUT every locally-known open intent (idempotent — the server PUT is
   * write-once while open/completed). Called after a `syncEpoch` change
   * (server restore — §5.4): intents are the one server table not
   * re-derivable from blobs.
   */
  async resyncOpenIntents(): Promise<void> {
    for (const intent of await this.listLocalOpenIntents()) {
      await this.requestJson('PUT', `/v1/intents/${intent.transferId}`, { payload: intent.payload });
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
    const ticket = parseWsTicket(await this.requestJson('POST', '/v1/ws-ticket'));
    const wsBase = this.baseUrl.replace(/^http/, 'ws');
    const ws = this.wsFactory(`${wsBase}/v1/ws?ticket=${encodeURIComponent(ticket)}`);

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (err) => reject(new WalletApiError('wake socket failed to connect', 'NETWORK', undefined, err));
      ws.onclose = () => reject(new WalletApiError('wake socket closed before connecting', 'NETWORK'));
    });

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
}
