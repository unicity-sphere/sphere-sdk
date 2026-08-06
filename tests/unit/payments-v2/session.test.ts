import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  createWalletApiHttp,
  WalletApiHttpError,
  type FetchLike,
  type HttpRequestInit,
  type HttpResponseLike,
} from '../../../impl/wallet-api-v2/http';
import { WalletApiV2Client } from '../../../impl/wallet-api-v2/client';
import {
  AUTH_CHALLENGE_PREFIX,
  ChallengeTemplateError,
  JwtGenerationCell,
  refreshTokenKey,
  WalletApiSession,
  WAKE_STREAMS,
  type ConnectionStatus,
  type WakeStream,
  type WebSocketLike,
} from '../../../impl/wallet-api-v2/session';
import { STORE_KEYS } from '../../../modules/payments-v2/stores';
import { deferred, memoryKV } from './support';

const BASE = 'https://wallet-api.test';
const PUB = `02${'ab'.repeat(32)}`;
const NET = 'testnet2';
const SIG = 'cd'.repeat(65);
const DEVICE = 'dev-1';
const ISSUED = '2026-07-31T00:00:00.000Z';
const EXPIRES = '2026-07-31T00:05:00.000Z';

class FakeWS implements WebSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number }) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  closedWith: number | undefined;
  constructor(readonly url: string) {}
  open(): void {
    this.onopen?.();
  }
  wake(stream: WakeStream, syncEpoch: number): void {
    this.onmessage?.({ data: JSON.stringify({ type: 'wake', stream, syncEpoch }) });
  }
  serverClose(code: number): void {
    this.onclose?.({ code });
  }
  close(code?: number): void {
    this.closedWith = code ?? 1000;
    this.onclose?.({ code: code ?? 1000 });
  }
}

interface RecordedCall {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  bodyRaw: string | Uint8Array | undefined;
}

type RouteHandler = (call: RecordedCall) => HttpResponseLike | Promise<HttpResponseLike>;

function jsonRes(status: number, body?: unknown, headers: Record<string, string> = {}): HttpResponseLike {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}

function makeChallenge(fields: Record<string, string>, prefix: string = AUTH_CHALLENGE_PREFIX): string {
  return prefix + JSON.stringify(fields);
}

function createHarness(opts: { seedRefresh?: boolean } = {}) {
  const kv = memoryKV();
  if (opts.seedRefresh) kv.map.set(refreshTokenKey(DEVICE), 'v1.s.seed');
  const cell = new JwtGenerationCell();
  const signer = { pubkey: PUB, network: NET, sign: vi.fn(async (_challenge: string) => SIG) };
  const calls: RecordedCall[] = [];
  const sockets: FakeWS[] = [];
  const statusEvents: ConnectionStatus[] = [];
  const onEpochChange = vi.fn(async (_epoch: string) => undefined);
  const routes = new Map<string, RouteHandler>();

  let challengeN = 0;
  let verifyN = 0;
  let refreshN = 0;
  let ticketN = 0;
  routes.set('POST /v1/auth/challenge', (call) => {
    const nonce = `nonce-${++challengeN}`;
    const pubkey = (call.body as { pubkey: string }).pubkey;
    const challenge = makeChallenge({ network: NET, pubkey, nonce, issuedAt: ISSUED, expiresAt: EXPIRES });
    return jsonRes(200, { nonce, challenge, expiresAt: EXPIRES });
  });
  routes.set('POST /v1/auth/verify', () =>
    jsonRes(200, { jwt: `jwt-v${++verifyN}`, refreshToken: `v1.s.v${verifyN}` })
  );
  routes.set('POST /v1/auth/refresh', () =>
    jsonRes(200, { jwt: `jwt-r${++refreshN}`, refreshToken: `v1.s.r${refreshN}` })
  );
  routes.set('POST /v1/ws-ticket', () => jsonRes(200, { ticket: `t${++ticketN}` }));

  const fetchFn: FetchLike = async (url: string, init?: HttpRequestInit) => {
    const method = init?.method ?? 'GET';
    const path = url.startsWith(BASE) ? url.slice(BASE.length).split('?')[0] : url;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = v;
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else {
      body = init?.body;
    }
    const call: RecordedCall = { method, url, path, headers, body, bodyRaw: init?.body };
    calls.push(call);
    const handler = routes.get(`${method} ${path}`) ?? routes.get(`${method} ${url}`);
    if (!handler) return jsonRes(404, { error: { code: 'NOT_FOUND', message: `no route ${method} ${path}` } });
    return handler(call);
  };

  const http = createWalletApiHttp({ baseUrl: BASE, fetchFn, getToken: () => cell.token() });
  const client = new WalletApiV2Client(http);
  const session = new WalletApiSession({
    client,
    cell,
    signer,
    deviceId: DEVICE,
    kv,
    webSocketFactory: (url: string) => {
      const ws = new FakeWS(url);
      sockets.push(ws);
      return ws;
    },
    emitStatus: (s) => statusEvents.push(s),
    random: () => 0,
  });
  // §5.1 restore hook rides the subscription surface (FacadeSession contract).
  session.subscribeEpochChange(onEpochChange);

  const count = (path: string): number => calls.filter((c) => c.path === path).length;
  return { kv, cell, signer, calls, sockets, statusEvents, onEpochChange, routes, http, client, session, count };
}

type Harness = ReturnType<typeof createHarness>;

async function startConnected(h: Harness): Promise<FakeWS> {
  await h.session.start();
  for (let i = 0; i < 10 && h.sockets.length === 0; i++) {
    await flush();
    await vi.advanceTimersByTimeAsync(0);
  }
  const ws = h.sockets.at(-1);
  if (!ws) throw new Error('socket never opened');
  ws.open();
  await flush();
  return ws;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('http: https enforcement', () => {
  const fetchFn: FetchLike = async () => jsonRes(200, {});
  const getToken = () => null;

  it('refuses a non-loopback http base URL at construction', () => {
    expect(() => createWalletApiHttp({ baseUrl: 'http://api.example.com', fetchFn, getToken })).toThrow(/https/);
  });

  it('allows https anywhere and plain http only on loopback', () => {
    expect(() => createWalletApiHttp({ baseUrl: 'https://wallet-api.example', fetchFn, getToken })).not.toThrow();
    expect(() => createWalletApiHttp({ baseUrl: 'http://localhost:3000', fetchFn, getToken })).not.toThrow();
    expect(() => createWalletApiHttp({ baseUrl: 'http://127.0.0.1:8080', fetchFn, getToken })).not.toThrow();
    expect(() => createWalletApiHttp({ baseUrl: 'not a url', fetchFn, getToken })).toThrow(/Invalid/);
  });
});

describe('http: error envelope', () => {
  it('parses { error: { code, message } } into WalletApiHttpError with status, code and retryAfter', async () => {
    const h = createHarness();
    h.routes.set('GET /v1/balances', () =>
      jsonRes(429, { error: { code: 'RATE_LIMITED', message: 'slow down' } }, { 'retry-after': '3' })
    );
    const err = await h.client.balances().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WalletApiHttpError);
    expect(err).toMatchObject({ status: 429, code: 'RATE_LIMITED', retryAfter: 3000 });
    expect((err as WalletApiHttpError).message).toContain('slow down');
  });

  it('falls back to HTTP_<status> when the body carries no envelope', async () => {
    const h = createHarness();
    h.routes.set('GET /v1/balances', () => jsonRes(503));
    const err = await h.client.balances().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 503, code: 'HTTP_503' });
  });
});

describe('client: S3 blob upload', () => {
  it('sends the SIGNED headers x-amz-checksum-sha256 (base64) and If-None-Match: * verbatim, and 412 = success', async () => {
    const h = createHarness();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    h.routes.set('PUT https://s3.test/blob', () => jsonRes(412));
    await expect(h.client.uploadBlob('https://s3.test/blob', bytes)).resolves.toBeUndefined();
    const call = h.calls.find((c) => c.url === 'https://s3.test/blob');
    expect(call).toBeDefined();
    expect(call!.headers['x-amz-checksum-sha256']).toBe(Buffer.from(sha256(bytes)).toString('base64'));
    expect(call!.headers['if-none-match']).toBe('*');
    expect(call!.bodyRaw).toBe(bytes);
  });

  it('a non-412 S3 failure throws typed', async () => {
    const h = createHarness();
    h.routes.set('PUT https://s3.test/blob', () => jsonRes(403));
    await expect(h.client.uploadBlob('https://s3.test/blob', new Uint8Array([1]))).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('client: amounts stay decimal strings', () => {
  it('history POST passes 30-digit amounts through verbatim as strings', async () => {
    const h = createHarness();
    h.routes.set('POST /v1/history', () => jsonRes(200, { inserted: 1, deduped: 0 }));
    const amount = '123456789012345678901234567890';
    await h.client.postHistory([
      { dedupKey: 'SENT:x', id: 'id-1', type: 'SENT', assets: [{ coinId: 'c1', amount }], ts: ISSUED },
    ]);
    const call = h.calls.find((c) => c.path === '/v1/history');
    const sent = (call!.body as { records: { assets: { amount: unknown }[] }[] }).records[0].assets[0].amount;
    expect(sent).toBe(amount);
    expect(typeof sent).toBe('string');
  });
});

describe('session: challenge template verification (signer never signs unverified text)', () => {
  const tamperedCases: [string, () => RouteHandler][] = [
    [
      'wrong pubkey',
      () => () => {
        const challenge = makeChallenge({
          network: NET,
          pubkey: `03${'ff'.repeat(32)}`,
          nonce: 'n1',
          issuedAt: ISSUED,
          expiresAt: EXPIRES,
        });
        return jsonRes(200, { nonce: 'n1', challenge, expiresAt: EXPIRES });
      },
    ],
    [
      'wrong network',
      () => () => {
        const challenge = makeChallenge({
          network: 'mainnet',
          pubkey: PUB,
          nonce: 'n1',
          issuedAt: ISSUED,
          expiresAt: EXPIRES,
        });
        return jsonRes(200, { nonce: 'n1', challenge, expiresAt: EXPIRES });
      },
    ],
    [
      'wrong prefix',
      () => () => {
        const challenge = makeChallenge(
          { network: NET, pubkey: PUB, nonce: 'n1', issuedAt: ISSUED, expiresAt: EXPIRES },
          'evil:wallet-api:auth:v9\n'
        );
        return jsonRes(200, { nonce: 'n1', challenge, expiresAt: EXPIRES });
      },
    ],
    [
      'nonce not echoed',
      () => () => {
        const challenge = makeChallenge({
          network: NET,
          pubkey: PUB,
          nonce: 'other-nonce',
          issuedAt: ISSUED,
          expiresAt: EXPIRES,
        });
        return jsonRes(200, { nonce: 'n1', challenge, expiresAt: EXPIRES });
      },
    ],
    [
      'stale timestamps (expiresAt before issuedAt)',
      () => () => {
        const challenge = makeChallenge({
          network: NET,
          pubkey: PUB,
          nonce: 'n1',
          issuedAt: EXPIRES,
          expiresAt: ISSUED,
        });
        return jsonRes(200, { nonce: 'n1', challenge, expiresAt: ISSUED });
      },
    ],
  ];

  for (const [name, makeRoute] of tamperedCases) {
    it(`${name}: refuses to sign — signer never invoked, verify never called`, async () => {
      const h = createHarness();
      h.routes.set('POST /v1/auth/challenge', makeRoute());
      await expect(h.session.ensureAuthenticated()).rejects.toBeInstanceOf(ChallengeTemplateError);
      expect(h.signer.sign).not.toHaveBeenCalled();
      expect(h.count('/v1/auth/verify')).toBe(0);
      expect(h.session.token()).toBeNull();
    });
  }

  it('an untampered challenge is signed exactly once and the session installs the verified JWT', async () => {
    const h = createHarness();
    const jwt = await h.session.ensureAuthenticated();
    expect(jwt).toBe('jwt-v1');
    expect(h.signer.sign).toHaveBeenCalledTimes(1);
    expect(String(h.signer.sign.mock.calls[0][0]).startsWith(AUTH_CHALLENGE_PREFIX)).toBe(true);
    expect(await h.kv.get(refreshTokenKey(DEVICE))).toBe('v1.s.v1');
  });
});

describe('session: single-flight refresh', () => {
  it('two concurrent 401s drive exactly ONE refresh call (a concurrent refresh would revoke the session)', async () => {
    const h = createHarness({ seedRefresh: true });
    h.cell.install(0, 'jwt-stale');
    const gate = deferred();
    h.routes.set('POST /v1/auth/refresh', async () => {
      await gate.promise;
      return jsonRes(200, { jwt: 'jwt-new', refreshToken: 'v1.s.next' });
    });
    const err401 = () => new WalletApiHttpError(401, 'UNAUTHORIZED', 'expired');
    const op = (tag: string) =>
      vi.fn(async (jwt: string) => {
        if (jwt === 'jwt-stale') throw err401();
        return `${tag}:${jwt}`;
      });
    const [op1, op2] = [op('a'), op('b')];
    const p1 = h.session.withAuth(op1);
    const p2 = h.session.withAuth(op2);
    await flush();
    expect(h.count('/v1/auth/refresh')).toBe(1);
    gate.resolve();
    expect(await p1).toBe('a:jwt-new');
    expect(await p2).toBe('b:jwt-new');
    expect(h.count('/v1/auth/refresh')).toBe(1);
    expect(await h.kv.get(refreshTokenKey(DEVICE))).toBe('v1.s.next');
  });
});

describe('session: F8 — identity switch mid-refresh-await', () => {
  it('the refresh continuation never installs the stale JWT and never persists the stale rotation', async () => {
    const h = createHarness({ seedRefresh: true });
    const gate = deferred();
    h.routes.set('POST /v1/auth/refresh', async () => {
      await gate.promise;
      return jsonRes(200, { jwt: 'jwt-stale-owner', refreshToken: 'v1.s.stale-owner' });
    });
    const pending = h.session.ensureAuthenticated();
    await flush();
    expect(h.count('/v1/auth/refresh')).toBe(1);

    h.session.invalidate();
    gate.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'AUTH_SUPERSEDED' });
    expect(h.session.token()).toBeNull();
    expect(await h.kv.get(refreshTokenKey(DEVICE))).toBe('v1.s.seed');

    h.routes.set('POST /v1/auth/refresh', () => jsonRes(200, { jwt: 'jwt-next-owner', refreshToken: 'v1.s.n1' }));
    const jwt = await h.session.ensureAuthenticated();
    expect(jwt).toBe('jwt-next-owner');
    expect(h.session.token()).toBe('jwt-next-owner');
  });
});

describe('session: F12 — epoch latch', () => {
  it('N concurrent epoch notifications run exactly ONE re-seed, and streams resume only after it', async () => {
    const h = createHarness({ seedRefresh: true });
    await h.kv.set(STORE_KEYS.epochLatch, '1');
    const gate = deferred();
    const order: string[] = [];
    h.onEpochChange.mockImplementation(async (epoch: string) => {
      order.push(`reseed:${epoch}`);
      await gate.promise;
      order.push('reseed-done');
    });
    const ws = await startConnected(h);
    const inv = vi.fn(() => order.push('pull:inventory'));
    h.session.subscribeStream('inventory', inv);

    ws.wake('inventory', 2);
    ws.wake('mailbox', 2);
    ws.wake('inventory', 2);
    await flush();
    expect(h.onEpochChange).toHaveBeenCalledTimes(1);
    expect(h.onEpochChange).toHaveBeenCalledWith('2');
    expect(inv).not.toHaveBeenCalled();

    gate.resolve();
    await flush();
    expect(h.onEpochChange).toHaveBeenCalledTimes(1);
    expect(inv).toHaveBeenCalledTimes(1);
    expect(await h.kv.get(STORE_KEYS.epochLatch)).toBe('2');
    expect(order).toEqual(['reseed:2', 'reseed-done', 'pull:inventory']);

    ws.wake('inventory', 2);
    await flush();
    expect(h.onEpochChange).toHaveBeenCalledTimes(1);
  });

  it('a same-epoch notification after the latch is a no-op (no re-seed on steady state)', async () => {
    const h = createHarness({ seedRefresh: true });
    await h.kv.set(STORE_KEYS.epochLatch, '7');
    const ws = await startConnected(h);
    ws.wake('inventory', 7);
    ws.wake('mailbox', 7);
    await flush();
    expect(h.onEpochChange).not.toHaveBeenCalled();
  });

  it('a rejected restore hook reverts the latch (currentEpoch + kv) so the SAME epoch retries the re-seed', async () => {
    const h = createHarness({ seedRefresh: true });
    await h.kv.set(STORE_KEYS.epochLatch, '1');
    h.onEpochChange.mockRejectedValueOnce(new Error('reseed failed'));
    const ws = await startConnected(h);
    expect(h.session.currentEpoch()).toBe('1');

    ws.wake('inventory', 2);
    await flush();
    expect(h.onEpochChange).toHaveBeenCalledTimes(1);
    expect(h.session.currentEpoch()).toBe('1'); // reverted — the restore never ran to completion
    expect(await h.kv.get(STORE_KEYS.epochLatch)).toBe('1');

    ws.wake('inventory', 2);
    await flush();
    expect(h.onEpochChange).toHaveBeenCalledTimes(2); // same epoch retried
    expect(h.session.currentEpoch()).toBe('2');
    expect(await h.kv.get(STORE_KEYS.epochLatch)).toBe('2');
  });
});

describe('session: F14 — authGone generation CAS', () => {
  it('authGone for generation G is a no-op when the cell is at G+1 — the newer JWT survives untouched', async () => {
    const h = createHarness({ seedRefresh: true });
    const ws1 = await startConnected(h);
    expect(h.session.token()).toBe('jwt-r1');

    h.session.invalidate();
    const jwt2 = await h.session.ensureAuthenticated();
    expect(jwt2).toBe('jwt-r2');
    const refreshesBefore = h.count('/v1/auth/refresh');

    ws1.serverClose(4401);
    await flush();
    expect(h.session.token()).toBe('jwt-r2');
    expect(h.count('/v1/auth/refresh')).toBe(refreshesBefore);
    const ticketCalls = h.calls.filter((c) => c.path === '/v1/ws-ticket');
    expect(ticketCalls.at(-1)!.headers['authorization']).toBe('Bearer jwt-r2');
  });

  it('4401 on the CURRENT generation refreshes and reconnects with a new ticket', async () => {
    const h = createHarness({ seedRefresh: true });
    const ws1 = await startConnected(h);
    expect(ws1.url).toContain('ticket=t1');
    const refreshesBefore = h.count('/v1/auth/refresh');

    ws1.serverClose(4401);
    await flush();
    expect(h.count('/v1/auth/refresh')).toBe(refreshesBefore + 1);
    expect(h.session.token()).toBe('jwt-r2');
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[1].url).toContain('ticket=t2');
  });
});

describe('session: wake socket supervisor', () => {
  it('every (re)connect fires one synthetic nudge per stream (inventory, mailbox, payment_requests)', async () => {
    const h = createHarness({ seedRefresh: true });
    const pulls: Record<WakeStream, ReturnType<typeof vi.fn>> = {
      inventory: vi.fn(),
      mailbox: vi.fn(),
      payment_requests: vi.fn(),
    };
    for (const s of WAKE_STREAMS) h.session.subscribeStream(s, pulls[s]);

    const ws1 = await startConnected(h);
    for (const s of WAKE_STREAMS) expect(pulls[s]).toHaveBeenCalledTimes(1);

    ws1.serverClose(1006);
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    const ws2 = h.sockets.at(-1)!;
    expect(ws2).not.toBe(ws1);
    ws2.open();
    await flush();
    for (const s of WAKE_STREAMS) expect(pulls[s]).toHaveBeenCalledTimes(2);
    expect(h.statusEvents).toEqual(['connected', 'degraded', 'connected']);
  });

  it('a wake dispatches only its own stream handler', async () => {
    const h = createHarness({ seedRefresh: true });
    await h.kv.set(STORE_KEYS.epochLatch, '1');
    const ws = await startConnected(h);
    const inv = vi.fn();
    const mail = vi.fn();
    h.session.subscribeStream('inventory', inv);
    h.session.subscribeStream('mailbox', mail);
    ws.wake('mailbox', 1);
    await flush();
    expect(mail).toHaveBeenCalledTimes(1);
    expect(inv).not.toHaveBeenCalled();
  });

  it('a periodic pull timer nudges every stream on a healthy socket (wakes are lossy)', async () => {
    const h = createHarness({ seedRefresh: true });
    const pulls: Record<WakeStream, ReturnType<typeof vi.fn>> = {
      inventory: vi.fn(),
      mailbox: vi.fn(),
      payment_requests: vi.fn(),
    };
    for (const s of WAKE_STREAMS) h.session.subscribeStream(s, pulls[s]);
    await startConnected(h);
    for (const s of WAKE_STREAMS) pulls[s].mockClear();

    await vi.advanceTimersByTimeAsync(30_000);
    for (const s of WAKE_STREAMS) expect(pulls[s]).toHaveBeenCalledTimes(1);
  });

  it('stop() closes the socket and silences timers and reconnects', async () => {
    const h = createHarness({ seedRefresh: true });
    const inv = vi.fn();
    h.session.subscribeStream('inventory', inv);
    const ws = await startConnected(h);
    inv.mockClear();
    const socketsBefore = h.sockets.length;
    const statusBefore = [...h.statusEvents];

    await h.session.stop();
    expect(ws.closedWith).toBeDefined();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(inv).not.toHaveBeenCalled();
    expect(h.sockets).toHaveLength(socketsBefore);
    expect(h.statusEvents).toEqual(statusBefore);
  });
});

describe('session: bearer plumbing', () => {
  it('auth endpoints carry no bearer; authenticated endpoints inject the cell token via the getter', async () => {
    const h = createHarness({ seedRefresh: true });
    await startConnected(h);
    const refreshCall = h.calls.find((c) => c.path === '/v1/auth/refresh')!;
    expect(refreshCall.headers['authorization']).toBeUndefined();
    const ticketCall = h.calls.find((c) => c.path === '/v1/ws-ticket')!;
    expect(ticketCall.headers['authorization']).toBe('Bearer jwt-r1');
  });

  it('a dead refresh token falls back to the challenge cycle without wedging', async () => {
    const h = createHarness({ seedRefresh: true });
    h.routes.set('POST /v1/auth/refresh', () =>
      jsonRes(401, { error: { code: 'UNAUTHORIZED', message: 'stale refresh token — session revoked' } })
    );
    const jwt = await h.session.ensureAuthenticated();
    expect(jwt).toBe('jwt-v1');
    expect(h.signer.sign).toHaveBeenCalledTimes(1);
    expect(await h.kv.get(refreshTokenKey(DEVICE))).toBe('v1.s.v1');
  });
});
