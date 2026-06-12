/**
 * real-vault-socket — wraps the in-memory {@link FakeVaultServer} +
 * {@link FakeCourierServer} behind a REAL `node:http` listening socket, so the
 * Phase-8.3 fetch clients are exercised over an actual TCP round trip (real fetch,
 * real JWT header, real status codes) WITHOUT needing mongo.
 *
 * It faithfully reproduces the token-api WIRE that the SDK clients depend on:
 *  - the Bearer-JWT → ownerId binding (the fake binds via `clientFor(ownerId)`; here
 *    the JWT the fake mints carries the ownerId, and the socket recovers it to scope
 *    the data/courier seam);
 *  - the **507** status on a whole-batch storage block, with the PatchResponse STILL
 *    in the body (`reply.code(507).send(body)` — DESIGN §5.4);
 *  - **401** for a missing/expired Bearer on an authenticated endpoint (drives the
 *    client's refresh+retry), and **401 → null** on `/auth/verify` · `/auth/refresh`.
 *
 * The fake mints a JWT shaped `jwt.<ownerId>.<deviceId>.<uniq>` — we split out the
 * ownerId from the Bearer to pick `clientFor(ownerId)`. A token issued before a
 * `forceExpire()` flips to expired so the next authed call 401s exactly once.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeVaultServer } from './fake-vault-server';
import { FakeCourierServer } from './fake-courier-server';
import type { VaultHttpClient } from '../../storage/remote/types';
import type { CourierHttpClient } from '../../transport/courier/types';

/** A listening real-socket vault server wrapping the in-memory fakes. */
export interface RealVaultSocket {
  baseUrl: string;
  vault: FakeVaultServer;
  courier: FakeCourierServer;
  /** Force the NEXT authed request to 401 once (expired JWT), then accept the retry. */
  expireNextToken(): void;
  close(): Promise<void>;
}

const enc = new TextEncoder();

/** Split the ownerId out of the fake's `jwt.<ownerId>.<deviceId>.<uniq>` token. */
function ownerOfJwt(jwt: string): string | null {
  const parts = jwt.split('.');
  return parts.length >= 2 && parts[0] === 'jwt' ? parts[1] : null;
}

/** Read the whole request body as text (JSON or empty). */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Send a JSON response with a status code (or 204 with no body). */
function sendJson(res: ServerResponse, status: number, body?: unknown): void {
  if (status === 204 || body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': enc.encode(text).length });
  res.end(text);
}

/** Mutable one-shot flag: when armed, the next authed request 401s, then disarms. */
class ExpiryGate {
  private armed = false;
  arm(): void {
    this.armed = true;
  }
  /** Returns true (and disarms) if this request should be forced to 401. */
  consume(): boolean {
    if (!this.armed) return false;
    this.armed = false;
    return true;
  }
}

/** Boot a real `node:http` server fronting fresh fake vault + courier instances. */
export async function startRealVaultSocket(network = 'testnet2'): Promise<RealVaultSocket> {
  const vault = new FakeVaultServer(network);
  const courier = new FakeCourierServer(network);
  const expiry = new ExpiryGate();
  const router = new Router(vault, courier, expiry);
  const server = createServer((req, res) => {
    void router.handle(req, res);
  });
  await listen(server);
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    vault,
    courier,
    expireNextToken: () => expiry.arm(),
    close: () => closeServer(server),
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

/** Routes one HTTP request onto the matching fake-server seam method. */
class Router {
  constructor(
    private readonly vault: FakeVaultServer,
    private readonly courier: FakeCourierServer,
    private readonly expiry: ExpiryGate,
  ) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const body = await readBody(req);
      const json = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      if (await this.route(req, url, json, res)) return;
      sendJson(res, 404, { error: 'not_found' });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'server_error' });
    }
  }

  /** Dispatch; returns true once handled. */
  private async route(
    req: IncomingMessage,
    url: URL,
    json: Record<string, unknown>,
    res: ServerResponse,
  ): Promise<boolean> {
    if (url.pathname.startsWith('/v1/auth/')) return this.auth(url.pathname, json, req, res);
    if (url.pathname.startsWith('/v1/courier/')) return this.courierRoute(url, json, req, res);
    return this.vaultRoute(req.method ?? 'GET', url, json, req, res);
  }

  // --- auth (no Bearer except logout) --------------------------------------

  private async auth(
    path: string,
    json: Record<string, unknown>,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const a = this.vault.authClient();
    if (path === '/v1/auth/challenge') return ok(res, await a.challenge(json.pubkey as string));
    if (path === '/v1/auth/verify') return orNull(res, await a.verify(json as never));
    if (path === '/v1/auth/refresh') return orNull(res, await a.refresh(json.refreshToken as string));
    if (path === '/v1/auth/logout') return logout(res, this.vault, req);
    return false;
  }

  // --- vault data (Bearer) -------------------------------------------------

  private async vaultRoute(
    method: string,
    url: URL,
    json: Record<string, unknown>,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const client = this.authed(req, res, (id) => this.vault.clientFor(id));
    if (!client) return true; // 401 already sent
    const p = url.pathname;
    if (method === 'PATCH' && p === '/v1/entries') return patch(res, client, json);
    if (method === 'GET' && p === '/v1/state') return ok(res, await client.getState(sinceOf(url)));
    if (method === 'POST' && p === '/v1/history') return ok(res, await client.appendHistory(json.records as never));
    if (method === 'GET' && p === '/v1/history') return ok(res, await client.historySince(sinceOf(url)));
    if (method === 'POST' && p === '/v1/account/delete-nonce') return ok(res, await client.deleteNonce());
    if (method === 'DELETE' && p === '/v1/account') return accountDelete(res, client, json);
    return false;
  }

  // --- courier (Bearer) ----------------------------------------------------

  private async courierRoute(
    url: URL,
    json: Record<string, unknown>,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const client = this.authed(req, res, (id) => this.courier.clientFor(id));
    if (!client) return true;
    const p = url.pathname;
    if (p === '/v1/courier/deposit') return ok(res, await client.deposit(json as never));
    if (p === '/v1/courier/inbox') return ok(res, await client.inbox(sinceOf(url)));
    if (p === '/v1/courier/ack-nonce') return ok(res, await client.ackNonce(url.searchParams.get('entryId') ?? ''));
    if (p === '/v1/courier/ack') return ok(res, await client.ack(json as never));
    if (p === '/v1/courier/sent') return ok(res, await client.sent(sinceOf(url)));
    return false;
  }

  /** Resolve the Bearer → ownerId; 401 (and the one-shot expiry gate) on failure. */
  private authed<T>(req: IncomingMessage, res: ServerResponse, make: (ownerId: string) => T): T | null {
    if (this.expiry.consume()) {
      sendJson(res, 401, { error: 'unauthorized' });
      return null;
    }
    const owner = ownerOfJwt(bearerOf(req) ?? '');
    if (!owner) {
      sendJson(res, 401, { error: 'unauthorized' });
      return null;
    }
    return make(owner);
  }
}

/** Extract the Bearer token from the Authorization header. */
function bearerOf(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
}

function sinceOf(url: URL): number {
  return Number(url.searchParams.get('since') ?? 0);
}

/** Plain 200 JSON helper that satisfies the `route` boolean contract. */
function ok(res: ServerResponse, body: unknown): true {
  sendJson(res, 200, body);
  return true;
}

/** 200 with the token pair, or 401 when the fake returned `null`. */
function orNull(res: ServerResponse, tokens: unknown): true {
  if (tokens === null) sendJson(res, 401, { error: 'unauthorized' });
  else sendJson(res, 200, tokens);
  return true;
}

async function logout(res: ServerResponse, vault: FakeVaultServer, req: IncomingMessage): Promise<true> {
  const body = await readBody(req).catch(() => '');
  void body;
  await vault.authClient().logout(''); // sessionId is opaque to the fake here
  sendJson(res, 204);
  return true;
}

/** PATCH /v1/entries — 507 status when the whole batch was storage-blocked, body intact. */
async function patch(res: ServerResponse, client: VaultHttpClient, json: Record<string, unknown>): Promise<true> {
  const body = await client.patchEntries((json.ops as never) ?? []);
  const blocked = body.applied.length === 0 && body.rejected.some((r) => r.reason === 'insufficient_storage');
  sendJson(res, blocked ? 507 : 200, body);
  return true;
}

/** DELETE /v1/account — 401 (never `{ok:false}`) when the delete signature is rejected. */
async function accountDelete(
  res: ServerResponse,
  client: VaultHttpClient,
  json: Record<string, unknown>,
): Promise<true> {
  const r = await client.deleteAccount(json.nonce as string, json.signature as string);
  if (r.ok) sendJson(res, 200, { ok: true });
  else sendJson(res, 401, { error: 'unauthorized' });
  return true;
}

// Keep the courier client type referenced for the seam (compile-time aid).
export type { CourierHttpClient };
