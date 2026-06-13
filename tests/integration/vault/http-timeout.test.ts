/**
 * HTTP request timeout for the vault/courier fetch core
 * (finding sdk-no-client-side-timeout = hang on a stalled server).
 *
 * Before this, the shared fetch core (`http-core.ts`) issued `fetch` with NO
 * `signal`/deadline, so a stalled or half-open server (accepts the socket, never
 * writes a response) hung the wallet's flush/auth FOREVER. `withTimeout` now wraps
 * the client `fetch` with a configurable `AbortController` deadline (named-const
 * default `DEFAULT_REQUEST_TIMEOUT_MS`) AND maps the abort to a typed
 * {@link VaultHttpError}; a stalled request REJECTS within the deadline instead of
 * hanging. The clients read `timeoutMs` from their config and wrap `fetch` in the
 * constructor, so the bound applies to EVERY round trip.
 *
 * Harness: a raw `node:http` server that ACCEPTS the request but never responds, so
 * only the client-side timeout can unblock the call. Open sockets are tracked and
 * destroyed on close so the server shuts down despite the never-finished request.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { HttpVaultAuthClient } from '../../../storage/remote/http/HttpVaultAuthClient';
import { HttpVaultClient } from '../../../storage/remote/http/HttpVaultClient';
import {
  VaultHttpError,
  withTimeout,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from '../../../storage/remote/http/http-core';
import type { VaultTokenSource } from '../../../storage/remote/http/http-core';

const SHORT_TIMEOUT_MS = 150;

let server: Server;
let baseUrl: string;
const sockets = new Set<Socket>();

/** Boot a server that accepts every request but NEVER writes a response. */
async function startStalledServer(): Promise<void> {
  server = createServer(() => {
    // Intentionally never call res.end() — the connection stays open forever.
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets.clear();
  if (!server?.listening) return; // a synchronous test never booted the server
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A token source whose refresh must NEVER run (timeout fires before any 401). */
const noRefreshAuth: VaultTokenSource = {
  token: 'jwt.owner.dev.x',
  refresh: () => Promise.reject(new Error('refresh should not be called on a timeout')),
};

describe('vault http-core request timeout', () => {
  it('exposes a sane named-const default timeout', () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  it('withTimeout rejects a stalled fetch with a typed error, not a hang', async () => {
    await startStalledServer();
    const timed = withTimeout(fetch, SHORT_TIMEOUT_MS);
    const started = Date.now();
    await expect(timed(`${baseUrl}/v1/state`)).rejects.toBeInstanceOf(VaultHttpError);
    expect(Date.now() - started).toBeLessThan(SHORT_TIMEOUT_MS + 2_000);
  });

  it('an unauthenticated client call REJECTS on a stalled server within the timeout', async () => {
    await startStalledServer();
    const auth = new HttpVaultAuthClient({ vaultUrl: baseUrl, timeoutMs: SHORT_TIMEOUT_MS });
    const started = Date.now();
    await expect(auth.challenge('pubkey')).rejects.toBeInstanceOf(VaultHttpError);
    // Resolved fast — the client-side deadline fired, not a hung socket.
    expect(Date.now() - started).toBeLessThan(SHORT_TIMEOUT_MS + 2_000);
  });

  it('an authed client call REJECTS on a stalled server WITHOUT driving a refresh', async () => {
    await startStalledServer();
    const vault = new HttpVaultClient({ vaultUrl: baseUrl, auth: noRefreshAuth, timeoutMs: SHORT_TIMEOUT_MS });
    await expect(vault.getState(0)).rejects.toBeInstanceOf(VaultHttpError);
  });
});
