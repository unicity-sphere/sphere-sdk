/**
 * Real network-failure behaviour for the vault + courier HTTP clients
 * (finding sdk-no-real-network-failures).
 *
 * The clients were only proven against 401/404/507. This drives the remaining
 * transport failures over a REAL `node:http` socket (scripted responses) and a
 * CLOSED port, and asserts each one surfaces a CATCHABLE typed error (never a hang,
 * an unhandled rejection, or an opaque JSON-parse crash), AND that the client stays
 * usable for a subsequent successful call:
 *
 *  - server down / connection refused → REJECTS with a typed VaultHttpError.
 *  - 5xx (500 / 502)                  → throws a typed VaultHttpError carrying status.
 *  - non-JSON body where JSON expected → typed VaultHttpError (no opaque parse crash).
 *  - persistent 401 after refresh      → ONE refresh + retry, then throw (no infinite
 *                                        loop); refresh is driven EXACTLY once.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { HttpVaultAuthClient } from '../../../storage/remote/http/HttpVaultAuthClient';
import { HttpVaultClient } from '../../../storage/remote/http/HttpVaultClient';
import { HttpCourierClient } from '../../../transport/courier/http/HttpCourierClient';
import { VaultHttpError } from '../../../storage/remote/http/http-core';
import type { VaultTokenSource } from '../../../storage/remote/http/http-core';
import { VaultApiClient } from '../../../storage/remote/VaultApiClient';
import { VAULT_AUTH_PREFIX } from '../../../vault/auth';

/** A scripted response: status + body (string body lets us serve non-JSON). */
interface ScriptedResponse {
  status: number;
  /** A raw body string (e.g. HTML/empty) OR an object that is JSON-stringified. */
  body: string | object;
  /** When true, send `body` verbatim with NO content-type (mimics a non-JSON 502). */
  raw?: boolean;
}

/** A `node:http` server that replays a FIFO queue of scripted responses. */
class ScriptedServer {
  private readonly queue: ScriptedResponse[] = [];
  private server!: Server;
  private readonly sockets = new Set<Socket>();
  baseUrl = '';
  /** Every request path the server saw, in order (for call-count assertions). */
  readonly seen: string[] = [];

  enqueue(...responses: ScriptedResponse[]): this {
    this.queue.push(...responses);
    return this;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** Resolve the bound port, then close so a client points at a refused port. */
  async startThenClose(): Promise<void> {
    await this.start();
    await this.stop();
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    if (this.server?.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    this.seen.push(req.url ?? '/');
    // Drain the body so the socket is free, then reply with the next script entry.
    req.on('data', () => {});
    req.on('end', () => this.reply(res));
  }

  private reply(res: ServerResponse): void {
    const next = this.queue.shift() ?? { status: 500, body: { error: 'no_script' } };
    if (next.raw) {
      res.writeHead(next.status);
      res.end(typeof next.body === 'string' ? next.body : JSON.stringify(next.body));
      return;
    }
    const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    res.writeHead(next.status, { 'content-type': 'application/json' });
    res.end(text);
  }
}

const TOKENS = { jwt: 'jwt.owner.dev.fresh', refreshToken: 'refresh-1' };

/** A spy token source: counts refresh() calls and hands back a fixed token. */
function spyAuth(): VaultTokenSource & { refreshCount: number } {
  return {
    refreshCount: 0,
    token: 'jwt.owner.dev.x',
    refresh() {
      this.refreshCount += 1;
      return Promise.resolve('jwt.owner.dev.rotated');
    },
  };
}

let srv: ScriptedServer;
afterEach(async () => {
  await srv?.stop();
});

describe('vault HTTP clients — connection refused', () => {
  it('an unauthenticated call to a CLOSED port rejects with a typed VaultHttpError', async () => {
    srv = new ScriptedServer();
    await srv.startThenClose(); // bind a port then free it → ECONNREFUSED
    const auth = new HttpVaultAuthClient({ vaultUrl: srv.baseUrl, timeoutMs: 2_000 });
    await expect(auth.challenge('pubkey')).rejects.toBeInstanceOf(VaultHttpError);
  });

  it('an authed call to a CLOSED port rejects with a typed VaultHttpError', async () => {
    srv = new ScriptedServer();
    await srv.startThenClose();
    const vault = new HttpVaultClient({ vaultUrl: srv.baseUrl, auth: spyAuth(), timeoutMs: 2_000 });
    await expect(vault.getState(0)).rejects.toBeInstanceOf(VaultHttpError);
  });
});

describe('vault HTTP clients — 5xx', () => {
  it('a 500 on an authed GET throws a typed VaultHttpError carrying the status', async () => {
    srv = new ScriptedServer().enqueue({ status: 500, body: { error: 'boom' } });
    await srv.start();
    const vault = new HttpVaultClient({ vaultUrl: srv.baseUrl, auth: spyAuth() });
    const err = await vault.getState(0).catch((e) => e);
    expect(err).toBeInstanceOf(VaultHttpError);
    expect((err as VaultHttpError).status).toBe(500);
  });

  it('a 502 on the courier is NOT swallowed (typed error with status 502)', async () => {
    srv = new ScriptedServer().enqueue({ status: 502, body: { error: 'bad_gateway' } });
    await srv.start();
    const courier = new HttpCourierClient({ vaultUrl: srv.baseUrl, auth: spyAuth() });
    const err = await courier.inbox(0).catch((e) => e);
    expect(err).toBeInstanceOf(VaultHttpError);
    expect((err as VaultHttpError).status).toBe(502);
  });

  it('the client stays usable: a success after a 500 round-trips normally', async () => {
    srv = new ScriptedServer().enqueue(
      { status: 500, body: { error: 'boom' } },
      { status: 200, body: { records: [{ dedupKey: 'd1', payload: { nonce: 'bg==', ct: 'aA==' } }] } },
    );
    await srv.start();
    const vault = new HttpVaultClient({ vaultUrl: srv.baseUrl, auth: spyAuth() });
    await expect(vault.historySince(0)).rejects.toBeInstanceOf(VaultHttpError);
    const page = await vault.historySince(0); // same client, fresh request — works
    expect(page.records.map((r) => r.dedupKey)).toEqual(['d1']);
  });
});

describe('vault HTTP clients — non-JSON body where JSON expected', () => {
  it('a 200 with an HTML body surfaces a typed VaultHttpError, not an opaque parse crash', async () => {
    srv = new ScriptedServer().enqueue({ status: 200, body: '<html>502 Bad Gateway</html>', raw: true });
    await srv.start();
    const vault = new HttpVaultClient({ vaultUrl: srv.baseUrl, auth: spyAuth() });
    const err = await vault.getState(0).catch((e) => e);
    expect(err).toBeInstanceOf(VaultHttpError);
    expect((err as VaultHttpError).message).toContain('non-JSON');
  });

  it('an EMPTY 200 body surfaces a typed VaultHttpError', async () => {
    srv = new ScriptedServer().enqueue({ status: 200, body: '', raw: true });
    await srv.start();
    const courier = new HttpCourierClient({ vaultUrl: srv.baseUrl, auth: spyAuth() });
    await expect(courier.sent(0)).rejects.toBeInstanceOf(VaultHttpError);
  });
});

describe('vault HTTP clients — persistent 401 after refresh', () => {
  it('does ONE refresh + retry then throws (no infinite loop); refresh called exactly once', async () => {
    // Both authed attempts 401 (the first, and the retry after the refresh).
    srv = new ScriptedServer().enqueue(
      { status: 401, body: { error: 'unauthorized' } },
      { status: 401, body: { error: 'unauthorized' } },
    );
    await srv.start();
    const auth = spyAuth();
    const vault = new HttpVaultClient({ vaultUrl: srv.baseUrl, auth });

    const err = await vault.getState(0).catch((e) => e);
    expect(err).toBeInstanceOf(VaultHttpError);
    expect((err as VaultHttpError).status).toBe(401);
    // Exactly one refresh, exactly two authed round trips (initial + single retry).
    expect(auth.refreshCount).toBe(1);
    expect(srv.seen.filter((p) => p.startsWith('/v1/state'))).toHaveLength(2);
  });

  it('full stack: a verify→ok then data-401 with the refresh ALSO 401 throws without looping', async () => {
    // challenge(200) → verify(200) → state(401) → refresh(401: null → throws).
    const challenge = {
      nonce: 'n1',
      challenge: challengeFor('owner-pub'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    srv = new ScriptedServer().enqueue(
      { status: 200, body: challenge },
      { status: 200, body: TOKENS },
      { status: 401, body: { error: 'unauthorized' } },
      { status: 401, body: { error: 'unauthorized' } },
    );
    await srv.start();

    const api = new VaultApiClient({
      network: 'testnet2',
      chainPubkey: 'owner-pub',
      privateKey: '7c'.repeat(32),
      deviceId: 'd1',
      authClient: new HttpVaultAuthClient({ vaultUrl: srv.baseUrl }),
    });
    await api.authenticate();
    const vault = new HttpVaultClient({ vaultUrl: srv.baseUrl, auth: api });

    // state 401 → ONE refresh, which itself 401s → VaultApiClient.refresh() throws
    // and that propagates: the call terminates (no infinite retry loop).
    await expect(vault.getState(0)).rejects.toBeInstanceOf(Error);
    // Exactly one /v1/auth/refresh attempt (no loop hammering the refresh endpoint).
    expect(srv.seen.filter((p) => p === '/v1/auth/refresh')).toHaveLength(1);
  });
});

/** Build a vault-auth challenge string the VaultApiClient template-check accepts. */
function challengeFor(pubkey: string): string {
  const body = {
    network: 'testnet2',
    pubkey,
    nonce: 'n1',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  return VAULT_AUTH_PREFIX + JSON.stringify(body);
}
