/**
 * tests/support/fake-wallet-api.ts — in-process fake of the wallet-api
 * backend (the §16 subset used by S1/S2).
 *
 * EVERY behavior cites its ARCHITECTURE.md section in a comment — this fake is
 * contract documentation; drift between it and the spec is a bug. Where the
 * fake deliberately simplifies (no real SDK `token.verify`, no mailbox yet —
 * that arrives with S3), the simplification is called out inline as
 * "APPROXIMATION".
 *
 * Implemented surface:
 *   - auth: challenge/verify/refresh/logout (§4) — challenge prefix, refresh
 *     rotation wire form `v1.<sessionId>.<secretHex>`, rotation-reuse
 *     revocation;
 *   - inventory: tombstones/seq/PAGE_LIMIT/more/syncEpoch (§5.1, §16);
 *   - blob-urls / upload-urls + signed GET/PUT serving from memory (§5.2);
 *   - inventory/apply: idempotency, added-blob validation, lineage,
 *     evidence-marked tombstones (§5.3);
 *   - intents: write-once / abort / complete semantics (§16);
 *   - ws-ticket + WS wake nudges (§9);
 *   - `bumpSyncEpoch()` test hook (§5.4 restore semantics).
 */

import * as http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { recoverPubkeyFromSignature } from '../../core/crypto';
import { decodeTokenBlob } from '../../token-engine/token-blob';
import { AUTH_CHALLENGE_PREFIX } from '../../wallet-api/challenge';
import { assertFieldEnvelopeShape } from '../../core/field-encryption';

// =============================================================================
// Types
// =============================================================================

export interface FakeAsset {
  coinId: string;
  amount: bigint;
}

interface InventoryRow {
  tokenId: string;
  status: 'active' | 'removed';
  s3Key: string;
  /** hex(SHA-256(inner token bytes)) — the per-state hash convention. */
  stateHash: string;
  /** Asset rows exist only while active — balances drop at the spend (§5.3 step 4). */
  assets: FakeAsset[] | null;
  seq: bigint;
  /** §5.3 step 3 evidence verdict for tombstones. */
  removal?: 'evidenced' | 'unevidenced' | 'external';
}

interface OwnerState {
  cursor: bigint; // gap-free, commit-ordered per-owner counter (§9)
  rows: Map<string, InventoryRow>; // one row per (owner, token) (§5.1)
  appliedTransfers: Map<string, bigint>; // §5.3 step 1 idempotency record
  intents: Map<string, { payload: string; status: 'open' | 'completed' | 'aborted'; createdAt: string }>;
}

interface Session {
  sessionId: string;
  pubkey: string;
  deviceId: string;
  jwt: string;
  jwtExpiresAt: number;
  refreshHash: string; // SHA-256 of the current secret — never the secret (§4)
  refreshExpiresAt: number;
  revoked: boolean;
  /** Rotated-away hashes — presenting one is theft (reuse detection, §4). */
  staleRefreshHashes: Set<string>;
}

interface SignedUrl {
  key: string;
  method: 'GET' | 'PUT';
  expiresAt: number;
  /** PUT only: the pinned checksum + length (§5.2). */
  sha256?: string;
  size?: number;
}

export interface FakeWalletApiOptions {
  network?: string;
  /** PAGE_LIMIT (§14): cap on ?since= list responses. */
  pageLimit?: number;
  jwtTtlMs?: number; // JWT_TTL (§14), default 15 min
  nonceTtlMs?: number; // NONCE_TTL (§14), default 5 min
  wsTicketTtlMs?: number; // WS_TICKET_TTL (§14), default 30 s
  maxBlobBytes?: number; // MAX_BLOB_BYTES (§14), default 16 MiB
  intentMaxBytes?: number; // intent payload cap (§7), default 4 KiB
  /**
   * APPROXIMATION of §8.2 steps 3–6: the real backend CBOR-decodes the v2
   * token, runs `token.verify` against the pinned trustbase and decodes the
   * value with the SpherePaymentData codec. This fake cannot run the SDK
   * pipeline, so the inner-token decode is an injected port; the default
   * reads a JSON `{ assets: [{ coinId, amount }] }` payload (the synthetic
   * token format used by the contract tests). Returning null = validation
   * failure (422).
   */
  decodeAssets?: (tokenBytes: Uint8Array) => FakeAsset[] | null;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function defaultDecodeAssets(tokenBytes: Uint8Array): FakeAsset[] | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(tokenBytes)) as {
      assets?: { coinId?: unknown; amount?: unknown }[];
    };
    if (!Array.isArray(parsed.assets)) return null;
    const assets: FakeAsset[] = [];
    for (const a of parsed.assets) {
      if (typeof a.coinId !== 'string' || typeof a.amount !== 'string' || !/^[0-9]+$/.test(a.amount)) {
        return null;
      }
      assets.push({ coinId: a.coinId, amount: BigInt(a.amount) });
    }
    return assets;
  } catch {
    return null;
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

// =============================================================================
// The fake server
// =============================================================================

export class FakeWalletApi {
  readonly network: string;
  private readonly pageLimit: number;
  private readonly jwtTtlMs: number;
  private readonly nonceTtlMs: number;
  private readonly wsTicketTtlMs: number;
  private readonly maxBlobBytes: number;
  private readonly intentMaxBytes: number;
  private readonly decodeAssets: (tokenBytes: Uint8Array) => FakeAsset[] | null;

  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private baseUrl = '';

  /** Server-wide sync epoch — bumped ONLY by a restore (§5.4). */
  private syncEpoch = 1n;
  private readonly owners = new Map<string, OwnerState>(); // by pubkey
  /** Content-addressed blob store: key = `<network>/t/<sha256>` (§5.2). */
  readonly blobStore = new Map<string, Uint8Array>();
  private readonly nonces = new Map<string, { pubkey: string; challenge: string; expiresAt: number }>();
  private readonly sessions = new Map<string, Session>(); // by sessionId
  private readonly signedUrls = new Map<string, SignedUrl>(); // by sig token
  private readonly wsTickets = new Map<string, { pubkey: string; sessionId: string; expiresAt: number }>();
  private readonly socketsByOwner = new Map<string, Set<WebSocket>>();

  // ── test hooks / counters ────────────────────────────────────────────────────
  challengeRequests = 0;
  verifyRequests = 0;
  refreshRequests = 0;
  private tamperChallenge: ((challenge: string) => string) | null = null;
  private failInventory = false;
  private failIntents = false;

  constructor(options: FakeWalletApiOptions = {}) {
    this.network = options.network ?? 'testnet2';
    this.pageLimit = options.pageLimit ?? 1000; // PAGE_LIMIT default (§14)
    this.jwtTtlMs = options.jwtTtlMs ?? 15 * 60 * 1000; // JWT_TTL (§14)
    this.nonceTtlMs = options.nonceTtlMs ?? 5 * 60 * 1000; // NONCE_TTL (§14)
    this.wsTicketTtlMs = options.wsTicketTtlMs ?? 30 * 1000; // WS_TICKET_TTL (§14)
    this.maxBlobBytes = options.maxBlobBytes ?? 16 * 1024 * 1024; // MAX_BLOB_BYTES (§14)
    this.intentMaxBytes = options.intentMaxBytes ?? 4096; // intent payload ≤ 4 KiB (§7)
    this.decodeAssets = options.decodeAssets ?? defaultDecodeAssets;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address() as { port: number };
    // Loopback plain HTTP is the sanctioned test-harness exception to the
    // TLS-only transport rule (§4: REQUIRE_TLS=false only for local dev/§18 harnesses).
    this.baseUrl = `http://127.0.0.1:${addr.port}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    for (const sockets of this.socketsByOwner.values()) {
      for (const ws of sockets) ws.close();
    }
    this.wss?.close();
    await new Promise<void>((resolve, reject) =>
      this.server ? this.server.close((err) => (err ? reject(err) : resolve())) : resolve()
    );
    this.server = null;
  }

  // ── test hooks ───────────────────────────────────────────────────────────────

  /**
   * §5.4 restore semantics: a restore rewinds per-owner counters, so the
   * restore procedure MUST bump the server-wide sync epoch; clients that see
   * it change discard cursors, full-pull, and re-PUT locally-held open
   * intents — intents are the one table not re-derivable from blobs, which is
   * why `dropIntents` simulates losing them in the restore.
   */
  bumpSyncEpoch(opts: { dropIntents?: boolean } = {}): void {
    this.syncEpoch += 1n;
    if (opts.dropIntents) {
      for (const owner of this.owners.values()) owner.intents.clear();
    }
  }

  /** Make the next auth challenge malformed — the client MUST refuse to sign it. */
  tamperNextChallenge(fn: (challenge: string) => string): void {
    this.tamperChallenge = fn;
  }

  /** Simulate an inventory outage (a failed load — §5.1 client-guard tests). */
  setInventoryFailure(fail: boolean): void {
    this.failInventory = fail;
  }

  /** Simulate an intent-endpoint outage (E.3 local-backstop tests). */
  setIntentFailure(fail: boolean): void {
    this.failIntents = fail;
  }

  /** Force-expire all access tokens (drives the 401 → refresh path). */
  expireAccessTokens(): void {
    for (const s of this.sessions.values()) s.jwtExpiresAt = 0;
  }

  /** Direct row insertion for client-level tests (bypasses §8.2 — test seam only). */
  seedInventory(pubkey: string, tokens: { tokenId: string; assets: FakeAsset[]; blob?: Uint8Array }[]): void {
    const owner = this.owner(pubkey);
    for (const t of tokens) {
      const blobBytes = t.blob ?? new Uint8Array();
      const key = `${this.network}/t/${hex(sha256(blobBytes))}`;
      if (t.blob) this.blobStore.set(key, t.blob);
      owner.cursor += 1n;
      owner.rows.set(t.tokenId, {
        tokenId: t.tokenId,
        status: 'active',
        s3Key: key,
        stateHash: t.blob ? hex(sha256(decodeTokenBlob(t.blob).token)) : '',
        assets: t.assets,
        seq: owner.cursor,
      });
    }
  }

  getRow(pubkey: string, tokenId: string): { status: string; removal?: string } | null {
    const row = this.owner(pubkey).rows.get(tokenId);
    return row ? { status: row.status, removal: row.removal } : null;
  }

  getIntent(pubkey: string, transferId: string): { payload: string; status: string } | null {
    const intent = this.owner(pubkey).intents.get(transferId);
    return intent ? { payload: intent.payload, status: intent.status } : null;
  }

  isSessionRevoked(pubkey: string, deviceId: string): boolean {
    for (const s of this.sessions.values()) {
      if (s.pubkey === pubkey && s.deviceId === deviceId) return s.revoked;
    }
    return false;
  }

  // ── owner state ──────────────────────────────────────────────────────────────

  /** Accounts are auto-provisioned on first touch (§4/§9). */
  private owner(pubkey: string): OwnerState {
    let state = this.owners.get(pubkey);
    if (!state) {
      state = { cursor: 0n, rows: new Map(), appliedTransfers: new Map(), intents: new Map() };
      this.owners.set(pubkey, state);
    }
    return state;
  }

  // ── HTTP plumbing ────────────────────────────────────────────────────────────

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      await this.route(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        // Error wire shape: { error: { code, message } } (§16).
        this.json(res, err.status, { error: { code: err.code, message: err.message } });
      } else {
        this.json(res, 500, { error: { code: 'INTERNAL', message: String(err) } });
      }
    }
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === null ? '' : JSON.stringify(body));
  }

  private async readBody(req: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  private async readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const raw = (await this.readBody(req)).toString('utf8');
    try {
      const parsed: unknown = raw === '' ? {} : JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
      return parsed as Record<string, unknown>;
    } catch {
      throw new HttpError(422, 'VALIDATION', 'request body is not a JSON object');
    }
  }

  /** Bearer-JWT auth on every endpoint except challenge/verify (§16). */
  private authenticate(req: http.IncomingMessage): Session {
    const header = req.headers['authorization'];
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new HttpError(401, 'UNAUTHORIZED', 'missing bearer token');
    for (const session of this.sessions.values()) {
      if (session.jwt === token) {
        if (session.revoked) throw new HttpError(401, 'UNAUTHORIZED', 'session revoked'); // §4 revocation
        if (session.jwtExpiresAt <= Date.now()) throw new HttpError(401, 'UNAUTHORIZED', 'token expired'); // JWT_TTL (§4)
        return session;
      }
    }
    throw new HttpError(401, 'UNAUTHORIZED', 'unknown token');
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.baseUrl);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // Signed blob URLs — the URL itself is the credential (§5.2), no JWT.
    if (path.startsWith('/v1/_blob/')) return this.handleSignedBlob(req, res, url);

    if (method === 'POST' && path === '/v1/auth/challenge') return this.handleChallenge(req, res);
    if (method === 'POST' && path === '/v1/auth/verify') return this.handleVerify(req, res);
    if (method === 'POST' && path === '/v1/auth/refresh') return this.handleRefresh(req, res);
    if (method === 'POST' && path === '/v1/auth/logout') return this.handleLogout(req, res);

    if (method === 'GET' && path === '/v1/inventory') return this.handleInventory(req, res, url);
    if (method === 'GET' && path === '/v1/balances') return this.handleBalances(req, res);
    if (method === 'POST' && path === '/v1/tokens/blob-urls') return this.handleBlobUrls(req, res);
    if (method === 'POST' && path === '/v1/tokens/upload-urls') return this.handleUploadUrls(req, res);
    if (method === 'POST' && path === '/v1/inventory/apply') return this.handleApply(req, res);

    const intentMatch = path.match(/^\/v1\/intents\/([^/]+)(\/(abort|complete))?$/);
    if (intentMatch) return this.handleIntent(req, res, intentMatch[1], intentMatch[3]);
    if (method === 'GET' && path === '/v1/intents') return this.handleListIntents(req, res, url);

    if (method === 'POST' && path === '/v1/ws-ticket') return this.handleWsTicket(req, res);

    throw new HttpError(404, 'NOT_FOUND', `no route for ${method} ${path}`);
  }

  // ── auth (§4) ────────────────────────────────────────────────────────────────

  private async handleChallenge(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.challengeRequests++;
    const body = await this.readJsonBody(req);
    const pubkey = body.pubkey;
    if (typeof pubkey !== 'string' || !/^0[23][0-9a-f]{64}$/i.test(pubkey)) {
      throw new HttpError(422, 'VALIDATION', 'pubkey must be a 33-byte compressed secp256k1 key (hex)');
    }
    const now = Date.now();
    const nonce = hex(randomBytes(16));
    const expiresAt = now + this.nonceTtlMs; // NONCE_TTL (§14)
    // §4 step 1: a human-readable challenge beginning with the fixed
    // domain-separation prefix and embedding { network, pubkey, nonce,
    // issuedAt, expiresAt } — the spend key never signs unprefixed text.
    // §4: prefix + single-line JSON — byte-for-byte the real backend's grammar
    // (wallet-api src/auth/service.ts issueChallenge).
    let challenge =
      AUTH_CHALLENGE_PREFIX +
      JSON.stringify({
        network: this.network,
        pubkey,
        nonce,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
      });
    if (this.tamperChallenge) {
      challenge = this.tamperChallenge(challenge);
      this.tamperChallenge = null;
    }
    this.nonces.set(nonce, { pubkey, challenge, expiresAt }); // nonce stored server-side, 5-min TTL (§4)
    this.json(res, 200, { nonce, challenge, expiresAt: new Date(expiresAt).toISOString() });
  }

  private async handleVerify(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.verifyRequests++;
    const body = await this.readJsonBody(req);
    const { nonce, signature, deviceId } = body as { nonce?: string; signature?: string; deviceId?: string };
    if (typeof nonce !== 'string' || typeof signature !== 'string' || typeof deviceId !== 'string') {
      throw new HttpError(422, 'VALIDATION', 'nonce, signature and deviceId are required');
    }
    const stored = this.nonces.get(nonce);
    if (!stored || stored.expiresAt <= Date.now()) {
      throw new HttpError(401, 'UNAUTHORIZED', 'unknown or expired nonce');
    }
    // §4 step 3: recover the pubkey from the signature (sphere-sdk signMessage
    // scheme — 130-hex v‖r‖s over the double-SHA256 prefixed digest) and check
    // it matches the challenged pubkey; consume the nonce.
    let recovered: string;
    try {
      recovered = recoverPubkeyFromSignature(stored.challenge, signature);
    } catch {
      throw new HttpError(401, 'UNAUTHORIZED', 'signature does not parse');
    }
    if (recovered.toLowerCase() !== stored.pubkey.toLowerCase()) {
      throw new HttpError(401, 'UNAUTHORIZED', 'signature does not match the challenged pubkey');
    }
    this.nonces.delete(nonce);
    // One row per (owner, device); re-auth on the same device replaces it (§4).
    for (const [id, s] of this.sessions) {
      if (s.pubkey === recovered && s.deviceId === deviceId) this.sessions.delete(id);
    }
    const session = this.createSession(recovered, deviceId);
    this.owner(recovered); // accounts auto-provisioned on first touch (§4)
    this.json(res, 200, { jwt: session.jwt, refreshToken: this.issueRefreshToken(session) });
  }

  private createSession(pubkey: string, deviceId: string): Session {
    const session: Session = {
      sessionId: hex(randomBytes(16)),
      pubkey,
      deviceId,
      jwt: `jwt.${hex(randomBytes(24))}`,
      jwtExpiresAt: Date.now() + this.jwtTtlMs,
      refreshHash: '',
      refreshExpiresAt: 0,
      revoked: false,
      staleRefreshHashes: new Set(),
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  /**
   * Refresh wire form `v1.<sessionId>.<secretHex>` (§4): the secret is 32
   * random bytes (hex) returned once; only its SHA-256 is stored server-side.
   */
  private issueRefreshToken(session: Session): string {
    const secret = hex(randomBytes(32));
    if (session.refreshHash) session.staleRefreshHashes.add(session.refreshHash);
    session.refreshHash = hex(sha256(new TextEncoder().encode(secret)));
    session.refreshExpiresAt = Date.now() + 30 * 24 * 3600 * 1000; // REFRESH_TTL (§14)
    return `v1.${session.sessionId}.${secret}`;
  }

  private async handleRefresh(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.refreshRequests++;
    const body = await this.readJsonBody(req);
    const token = body.refreshToken;
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 3 || parts[0] !== 'v1') {
      throw new HttpError(401, 'UNAUTHORIZED', 'malformed refresh token');
    }
    const session = this.sessions.get(parts[1]);
    if (!session || session.revoked || session.refreshExpiresAt <= Date.now()) {
      throw new HttpError(401, 'UNAUTHORIZED', 'refresh failed'); // revoked sessions cannot refresh (§4)
    }
    const presentedHash = hex(sha256(new TextEncoder().encode(parts[2])));
    if (presentedHash === session.refreshHash) {
      // §4 rotation: new access JWT + new refresh token; old hash invalidated.
      session.jwt = `jwt.${hex(randomBytes(24))}`;
      session.jwtExpiresAt = Date.now() + this.jwtTtlMs;
      this.json(res, 200, { jwt: session.jwt, refreshToken: this.issueRefreshToken(session) });
      return;
    }
    if (session.staleRefreshHashes.has(presentedHash)) {
      // §4 reuse detection: presenting a previously-rotated token is treated
      // as theft — the whole session is revoked.
      session.revoked = true;
      this.closeOwnerSockets(session); // socket closed on logout/revocation (§9)
      throw new HttpError(401, 'UNAUTHORIZED', 'stale refresh token reuse — session revoked');
    }
    throw new HttpError(401, 'UNAUTHORIZED', 'unknown refresh token');
  }

  private async handleLogout(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const session = this.authenticate(req);
    session.revoked = true; // durable revocation on the session row (§4)
    this.closeOwnerSockets(session); // the socket is closed on logout (§9)
    this.json(res, 204, null);
  }

  private closeOwnerSockets(session: Session): void {
    const sockets = this.socketsByOwner.get(session.pubkey);
    if (sockets) {
      for (const ws of sockets) ws.close();
      sockets.clear();
    }
  }

  // ── inventory (§5.1, §16) ────────────────────────────────────────────────────

  private rowToWire(row: InventoryRow): Record<string, unknown> {
    return {
      tokenId: row.tokenId,
      status: row.status,
      // Amounts are decimal strings in every JSON body (§11); asset rows are
      // deleted at the spend, so tombstones carry no assets (§5.3 step 4).
      ...(row.status === 'active' && row.assets
        ? { assets: row.assets.map((a) => ({ coinId: a.coinId, amount: a.amount.toString() })) }
        : {}),
      // bigint counters travel as decimal strings (pg bigint wire form — §11).
      seq: row.seq.toString(),
    };
  }

  private handleInventory(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const session = this.authenticate(req);
    if (this.failInventory) throw new HttpError(500, 'INTERNAL', 'simulated inventory outage');
    const owner = this.owner(session.pubkey);
    const sinceRaw = url.searchParams.get('since');
    const since = sinceRaw !== null ? BigInt(sinceRaw) : null;

    // §5.1: a full pull (no since) returns ACTIVE rows only; a delta returns
    // every row — active and removed — with seq > cursor, so a stale device
    // learns about spends/handoffs (tombstones ARE the removals channel).
    const rows = [...owner.rows.values()]
      .filter((r) => (since === null ? r.status === 'active' : r.seq > since))
      .sort((a, b) => (a.seq < b.seq ? -1 : 1)); // seq-ordered (§16)

    // §16: responses are capped at PAGE_LIMIT rows; a truncated response sets
    // more:true with cursor reflecting the last returned row.
    const page = rows.slice(0, this.pageLimit);
    const more = rows.length > page.length;
    const cursor = more ? page[page.length - 1].seq : owner.cursor;

    this.json(res, 200, {
      cursor: cursor.toString(),
      syncEpoch: this.syncEpoch.toString(), // every cursor-bearing response carries syncEpoch (§9)
      more,
      items: page.map((r) => this.rowToWire(r)),
    });
  }

  private handleBalances(req: http.IncomingMessage, res: http.ServerResponse): void {
    const session = this.authenticate(req);
    const owner = this.owner(session.pubkey);
    // §16: balances aggregate ACTIVE rows only (asset rows exist only while active).
    const totals = new Map<string, { total: bigint; tokenCount: number }>();
    for (const row of owner.rows.values()) {
      if (row.status !== 'active' || !row.assets) continue;
      for (const asset of row.assets) {
        const entry = totals.get(asset.coinId) ?? { total: 0n, tokenCount: 0 };
        entry.total += asset.amount;
        entry.tokenCount += 1;
        totals.set(asset.coinId, entry);
      }
    }
    this.json(res, 200, {
      balances: [...totals.entries()].map(([coinId, t]) => ({
        coinId,
        total: t.total.toString(), // decimal strings (§11)
        tokenCount: t.tokenCount,
      })),
    });
  }

  // ── blobs (§5.2) ─────────────────────────────────────────────────────────────

  private signUrl(entry: SignedUrl): string {
    const sig = hex(randomBytes(16));
    this.signedUrls.set(sig, entry);
    return `${this.baseUrl}/v1/_blob/${encodeURIComponent(entry.key)}?sig=${sig}`;
  }

  private async handleBlobUrls(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const session = this.authenticate(req);
    const body = await this.readJsonBody(req);
    if (!Array.isArray(body.tokenIds)) throw new HttpError(422, 'VALIDATION', 'tokenIds must be an array');
    const owner = this.owner(session.pubkey);
    const urls: { tokenId: string; getUrl: string }[] = [];
    for (const tokenId of body.tokenIds as unknown[]) {
      if (typeof tokenId !== 'string') throw new HttpError(422, 'VALIDATION', 'tokenIds must be strings');
      // §16: owner-checked — the caller's active *or tombstoned* rows qualify
      // (tombstoned blobs are retained and fetchable: the recovery path, §5.3).
      const row = owner.rows.get(tokenId);
      if (!row || !this.blobStore.has(row.s3Key)) continue;
      urls.push({
        tokenId,
        // Short-lived signed GET (GET_URL_TTL, §14).
        getUrl: this.signUrl({ key: row.s3Key, method: 'GET', expiresAt: Date.now() + 5 * 60 * 1000 }),
      });
    }
    this.json(res, 200, { urls });
  }

  private async handleUploadUrls(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.authenticate(req);
    const body = await this.readJsonBody(req);
    if (!Array.isArray(body.blobs)) throw new HttpError(422, 'VALIDATION', 'blobs must be an array');
    const urls: { sha256: string; key: string; putUrl: string }[] = [];
    for (const blob of body.blobs as { sha256?: unknown; size?: unknown }[]) {
      if (typeof blob.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(blob.sha256)) {
        throw new HttpError(422, 'VALIDATION', 'sha256 must be 64-hex');
      }
      if (typeof blob.size !== 'number' || !Number.isSafeInteger(blob.size) || blob.size <= 0) {
        throw new HttpError(422, 'VALIDATION', 'size must be a positive integer');
      }
      if (blob.size > this.maxBlobBytes) {
        throw new HttpError(413, 'TOO_LARGE', `blob exceeds MAX_BLOB_BYTES (${this.maxBlobBytes})`); // §5.5
      }
      // §5.2: key = <network>/t/<hex(sha256(blob bytes))> — content addressing,
      // nothing derived from claimed metadata.
      const key = `${this.network}/t/${blob.sha256}`;
      urls.push({
        sha256: blob.sha256,
        key,
        // §5.2: the presigned PUT pins the checksum and exact length
        // (PUT_URL_TTL, §14).
        putUrl: this.signUrl({
          key,
          method: 'PUT',
          expiresAt: Date.now() + 15 * 60 * 1000,
          sha256: blob.sha256,
          size: blob.size,
        }),
      });
    }
    this.json(res, 200, { urls });
  }

  private async handleSignedBlob(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const sig = url.searchParams.get('sig') ?? '';
    const entry = this.signedUrls.get(sig);
    if (!entry || entry.expiresAt <= Date.now()) {
      throw new HttpError(403, 'FORBIDDEN', 'signed URL invalid or expired');
    }
    if (req.method === 'GET' && entry.method === 'GET') {
      const bytes = this.blobStore.get(entry.key);
      if (!bytes) throw new HttpError(404, 'NOT_FOUND', 'blob not found');
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.from(bytes));
      return;
    }
    if (req.method === 'PUT' && entry.method === 'PUT') {
      const bytes = await this.readBody(req);
      // §5.2: the URL pins the exact Content-Length…
      if (bytes.length !== entry.size) {
        throw new HttpError(403, 'FORBIDDEN', 'Content-Length does not match the presigned size');
      }
      // …and the checksum (x-amz-checksum-sha256 equivalent): S3 rejects
      // content that does not match the key.
      if (hex(sha256(bytes)) !== entry.sha256) {
        throw new HttpError(403, 'FORBIDDEN', 'content checksum does not match the presigned sha256');
      }
      // §5.2 If-None-Match:* — an existing object is never overwritten; 412
      // means the identical blob already exists and the client treats the
      // upload as already done (content addressing).
      if (this.blobStore.has(entry.key)) {
        throw new HttpError(412, 'PRECONDITION_FAILED', 'object already exists');
      }
      this.blobStore.set(entry.key, new Uint8Array(bytes));
      this.json(res, 200, {});
      return;
    }
    throw new HttpError(403, 'FORBIDDEN', 'method does not match the signed URL');
  }

  // ── apply-delta (§5.3) ──────────────────────────────────────────────────────

  private async handleApply(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const session = this.authenticate(req);
    const owner = this.owner(session.pubkey);
    const body = await this.readJsonBody(req);
    const transferId = body.transferId;
    const spent = body.spent;
    const added = body.added;
    const externalDelivery = body.externalDelivery === true;
    if (typeof transferId !== 'string' || transferId === '') {
      throw new HttpError(422, 'VALIDATION', 'transferId is required');
    }
    if (!Array.isArray(spent) || !spent.every((s): s is string => typeof s === 'string')) {
      throw new HttpError(422, 'VALIDATION', 'spent must be a string array');
    }
    if (!Array.isArray(added)) throw new HttpError(422, 'VALIDATION', 'added must be an array');
    const addedEntries = added.map((a: unknown) => {
      const rec = a as { tokenId?: unknown; key?: unknown };
      if (typeof rec.tokenId !== 'string' || typeof rec.key !== 'string') {
        throw new HttpError(422, 'VALIDATION', 'added entries must be { tokenId, key }');
      }
      return { tokenId: rec.tokenId, key: rec.key };
    });

    // §5.3: a tokenId may not appear in both spent and added of one apply —
    // a self-send routes through the mailbox.
    for (const tokenId of spent) {
      if (addedEntries.some((a) => a.tokenId === tokenId)) {
        throw new HttpError(422, 'VALIDATION', `token ${tokenId} appears in both spent and added`);
      }
    }

    // §5.3 step 1 — idempotency: a replayed transferId returns the recorded
    // result, a strict no-op (this record is what makes replay safe).
    const recorded = owner.appliedTransfers.get(transferId);
    if (recorded !== undefined) {
      this.json(res, 200, { cursor: recorded.toString() });
      return;
    }

    // §5.3 step 2 — validate every added blob through the §8.2 pipeline
    // (hash↔key, decode, tokenId match, value decode; nothing invalid stored).
    const validated = addedEntries.map((entry) => this.validateAddedBlob(entry, session.pubkey));

    // §5.3 lineage precedence: the cross-owner check runs first.
    for (const v of validated) this.checkLineage(v, session.pubkey);

    // §5.3 step 3 — evidence-check every spent token.
    // APPROXIMATION: the real evidence is a validated output blob on this
    // backend whose history consumes the spent state — the mailbox deposit of
    // the same transferId (whole-token transfer) or the split change in
    // `added`. This fake has no mailbox yet (S3), so: added present ⇒
    // 'evidenced' (split-change leg), otherwise 'unevidenced'.
    // externalDelivery declares removals 'external' (§5.3: same
    // never-collected retention as unevidenced, separate metric).
    const removal = externalDelivery ? 'external' : validated.length > 0 ? 'evidenced' : 'unevidenced';

    // §5.3 step 4 — one transaction: tombstone spent (drop asset rows), insert
    // or reactivate added, record applied_transfers, bump the owner cursor —
    // each changed row gets its own seq (§9).
    for (const tokenId of spent) {
      const row = owner.rows.get(tokenId);
      // A spent token whose row is already removed (or never recorded here)
      // is success, not an error (§5.3 step 4).
      if (!row || row.status === 'removed') continue;
      owner.cursor += 1n;
      row.status = 'removed';
      row.assets = null; // balances drop at the spend, not later (§5.3 step 4)
      row.seq = owner.cursor;
      row.removal = removal;
    }
    for (const v of validated) {
      owner.cursor += 1n;
      const existing = owner.rows.get(v.tokenId);
      if (existing) {
        // §5.3: any acceptance over the owner's own prior row is a
        // reactivating UPDATE (status, s3_key, state_hash, seq, assets) —
        // never a second insert.
        existing.status = 'active';
        existing.s3Key = v.key;
        existing.stateHash = v.stateHash;
        existing.assets = v.assets;
        existing.seq = owner.cursor;
        existing.removal = undefined;
      } else {
        owner.rows.set(v.tokenId, {
          tokenId: v.tokenId,
          status: 'active',
          s3Key: v.key,
          stateHash: v.stateHash,
          assets: v.assets,
          seq: owner.cursor,
        });
      }
    }
    owner.appliedTransfers.set(transferId, owner.cursor);

    // §16: inventory/apply marks the intent completed in the same transaction;
    // completion wins over a concurrent abort (aborted → completed is legal).
    const intent = owner.intents.get(transferId);
    if (intent) intent.status = 'completed';

    this.wakeOwner(session.pubkey, 'inventory'); // §9 wake nudge
    this.json(res, 200, { cursor: owner.cursor.toString() });
  }

  private validateAddedBlob(
    entry: { tokenId: string; key: string },
    _ownerPubkey: string
  ): { tokenId: string; key: string; stateHash: string; assets: FakeAsset[] } {
    // §8.2 step 1: fetch the blob by key; enforce the size cap.
    const bytes = this.blobStore.get(entry.key);
    if (!bytes) throw new HttpError(422, 'VALIDATION', `no blob stored at key ${entry.key}`);
    if (bytes.length > this.maxBlobBytes) throw new HttpError(413, 'TOO_LARGE', 'blob exceeds MAX_BLOB_BYTES');
    // §8.2 step 2: recompute SHA-256 over the bytes — it MUST equal the
    // content-addressed key (§5.2): key, bytes and index can never disagree.
    if (`${this.network}/t/${hex(sha256(bytes))}` !== entry.key) {
      throw new HttpError(422, 'VALIDATION', 'blob bytes do not match the content-addressed key');
    }
    // §8.2 step 3 — APPROXIMATION: the real server CBOR-decodes the v2 token
    // and runs the SDK's three-service token.verify against the pinned
    // trustbase. This fake decodes the sphere TokenBlob envelope only.
    let blob;
    try {
      blob = decodeTokenBlob(bytes);
    } catch {
      throw new HttpError(422, 'VALIDATION', 'blob is not a decodable TokenBlob');
    }
    // §8.2 step 4: the decoded tokenId MUST match the claimed tokenId.
    if (blob.tokenId !== entry.tokenId) {
      throw new HttpError(422, 'VALIDATION', 'decoded tokenId does not match the claimed tokenId');
    }
    // §8.2 step 5 (ownership = self) is NOT modeled — the fake has no
    // predicate decoding. APPROXIMATION, noted.
    // §8.2 step 6: decode the value to populate the index (injected decoder
    // standing in for SpherePaymentData — see FakeWalletApiOptions).
    const assets = this.decodeAssets(blob.token);
    if (assets === null) throw new HttpError(422, 'VALIDATION', 'token value does not decode');
    // The per-state hash convention: hex(SHA-256(inner token bytes)).
    return { tokenId: entry.tokenId, key: entry.key, stateHash: hex(sha256(blob.token)), assets };
  }

  /**
   * §5.3 lineage for `added`. APPROXIMATION: the real rule walks the
   * transition chain ("the recorded state_hash appears strictly earlier in
   * the incoming blob's chain"); this fake cannot decode v2 transition
   * history, so "different state hash" stands in for strict extension and
   * "equal state hash" for equal state. The evidenced/unevidenced tombstone
   * distinction — the part S2's recovery contract depends on — is exact.
   */
  private checkLineage(
    v: { tokenId: string; stateHash: string },
    ownerPubkey: string
  ): void {
    // Cross-owner precedence (§5.3): if any OTHER owner holds a row whose
    // recorded state the incoming blob does not strictly extend (equal state),
    // the add is 409 regardless of the reactivation disjunct.
    for (const [pubkey, state] of this.owners) {
      if (pubkey === ownerPubkey) continue;
      const other = state.rows.get(v.tokenId);
      if (other && other.stateHash === v.stateHash && other.status === 'active') {
        throw new HttpError(409, 'CONFLICT', 'another owner holds this token at this state');
      }
    }
    const own = this.owner(ownerPubkey).rows.get(v.tokenId);
    if (!own) return; // first contact — acceptance (§5.3)
    if (own.status === 'active' && own.stateHash === v.stateHash) {
      // Equal state over the owner's own ACTIVE row is not an extension and
      // not a reactivation — rejected ("anything else", §5.3).
      throw new HttpError(409, 'CONFLICT', 'row already active at this state');
    }
    if (own.status === 'removed' && own.stateHash === v.stateHash && own.removal === 'evidenced') {
      // §5.3: an EVIDENCED tombstone is a proven spend and never reactivates
      // at equal state — a wiped-view recovery cannot resurrect a spent
      // source as phantom balance. The client treats this 409 as "actually
      // spent" and keeps the tombstone.
      throw new HttpError(409, 'CONFLICT', 'evidenced tombstone never reactivates at equal state');
    }
    // Remaining cases: unevidenced/external tombstone at equal state
    // (reactivation — the undo path, §5.3) or a different state hash (strict
    // extension, APPROXIMATION above) — acceptance.
  }

  // ── intents (§7, §16) ────────────────────────────────────────────────────────

  private async handleIntent(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    transferId: string,
    action?: string
  ): Promise<void> {
    const session = this.authenticate(req);
    if (this.failIntents) throw new HttpError(500, 'INTERNAL', 'simulated intent outage');
    const owner = this.owner(session.pubkey);
    const method = req.method ?? 'GET';

    if (method === 'PUT' && !action) {
      const body = await this.readJsonBody(req);
      // §8.3 wire mapping: the body carries the `enc1.` envelope string
      // verbatim; the server validates ONLY prefix + base64 + size cap
      // (≤ 4 KiB — §7) and never sees plaintext.
      try {
        assertFieldEnvelopeShape(body.payload, this.intentMaxBytes);
      } catch (err) {
        throw new HttpError(422, 'VALIDATION', err instanceof Error ? err.message : 'bad intent payload');
      }
      const payload = body.payload as string;
      const existing = owner.intents.get(transferId);
      if (!existing) {
        owner.intents.set(transferId, { payload, status: 'open', createdAt: new Date().toISOString() });
        this.json(res, 204, null);
        return;
      }
      // §16: write-once while open or completed — a PUT against an existing
      // open/completed intent is a no-op 204 (a stolen JWT must not be able
      // to corrupt the resume seed).
      if (existing.status === 'open' || existing.status === 'completed') {
        this.json(res, 204, null);
        return;
      }
      // §16: a PUT against an ABORTED intent re-opens it iff the payload
      // equals the stored one (abort is soft and recoverable), else 409.
      if (existing.payload === payload) {
        existing.status = 'open';
        this.json(res, 204, null);
        return;
      }
      throw new HttpError(409, 'CONFLICT', 'aborted intent payload mismatch');
    }

    if (method === 'POST' && action === 'abort') {
      const intent = owner.intents.get(transferId);
      if (!intent) throw new HttpError(404, 'NOT_FOUND', 'unknown intent');
      // §16: abort is SOFT — flips status only; the row and payload remain;
      // completed never reverts (completion wins).
      if (intent.status !== 'completed') intent.status = 'aborted';
      this.json(res, 204, null);
      return;
    }

    if (method === 'POST' && action === 'complete') {
      const intent = owner.intents.get(transferId);
      if (!intent) throw new HttpError(404, 'NOT_FOUND', 'unknown intent');
      // §16: idempotent; aborted → completed is legal (completion wins);
      // completed never reverts. This is the uniform client-side close —
      // storage-opt-out senders depend on it.
      intent.status = 'completed';
      this.json(res, 204, null);
      return;
    }

    throw new HttpError(404, 'NOT_FOUND', 'no such intent route');
  }

  private handleListIntents(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const session = this.authenticate(req);
    const owner = this.owner(session.pubkey);
    const status = url.searchParams.get('status');
    // §16: GET /v1/intents?status=open|aborted — aborted intents stay
    // listable with their payload (abort is soft and recoverable).
    if (status !== 'open' && status !== 'aborted') {
      throw new HttpError(422, 'VALIDATION', 'status must be open or aborted');
    }
    const intents = [...owner.intents.entries()]
      .filter(([, i]) => i.status === status)
      .map(([transferId, i]) => ({ transferId, payload: i.payload, status: i.status, createdAt: i.createdAt }));
    this.json(res, 200, { intents });
  }

  // ── realtime (§9) ────────────────────────────────────────────────────────────

  private handleWsTicket(req: http.IncomingMessage, res: http.ServerResponse): void {
    const session = this.authenticate(req);
    // §9: a single-use ticket (random, 30 s TTL) — the JWT never appears in a
    // URL (URLs are logged by intermediaries; browsers cannot set WS headers).
    const ticket = hex(randomBytes(16));
    this.wsTickets.set(ticket, {
      pubkey: session.pubkey,
      sessionId: session.sessionId,
      expiresAt: Date.now() + this.wsTicketTtlMs,
    });
    this.json(res, 200, { ticket });
  }

  private handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', this.baseUrl);
    const ticket = url.searchParams.get('ticket') ?? '';
    const entry = this.wsTickets.get(ticket);
    // §9: single-use — consumed on first upgrade attempt; expired/reused
    // tickets are refused.
    this.wsTickets.delete(ticket);
    if (url.pathname !== '/v1/ws' || !entry || entry.expiresAt <= Date.now()) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    this.wss!.handleUpgrade(req, socket, head, (ws) => {
      // On connect the device subscribes to its owner (§9).
      let sockets = this.socketsByOwner.get(entry.pubkey);
      if (!sockets) {
        sockets = new Set();
        this.socketsByOwner.set(entry.pubkey, sockets);
      }
      sockets.add(ws);
      ws.on('close', () => sockets!.delete(ws));
    });
  }

  /** §9: any change publishes a `{ type:'wake', stream }` nudge with syncEpoch. */
  wakeOwner(pubkey: string, stream: 'inventory' | 'mailbox' | 'payment_requests'): void {
    const sockets = this.socketsByOwner.get(pubkey);
    if (!sockets) return;
    const frame = JSON.stringify({ type: 'wake', stream, syncEpoch: this.syncEpoch.toString() });
    for (const ws of sockets) ws.send(frame);
  }
}
