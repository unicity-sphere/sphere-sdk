/**
 * S1 realtime: the WS ticket flow (§9) — `POST /v1/ws-ticket` then
 * `GET /v1/ws?ticket=` — wake nudges, single-use tickets, close-on-logout.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { WalletApiClient, type WakeEvent, type WebSocketLike } from '../../../wallet-api';
import { signMessage } from '../../../core/crypto';
import { FakeWalletApi } from '../../support/fake-wallet-api';
import { MemoryKeyValueStore, testIdentity } from '../../support/wallet-api-test-helpers';

const identity = testIdentity(60);

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('waitFor timed out'));
      }
    }, 10);
  });
}

describe('WalletApiClient — wake socket (§9)', () => {
  let fake: FakeWalletApi;
  let baseUrl: string;
  let client: WalletApiClient;
  /** Sockets created through the injected factory (for state assertions). */
  let createdSockets: WebSocket[];

  beforeEach(async () => {
    fake = new FakeWalletApi();
    baseUrl = await fake.start();
    createdSockets = [];
    client = new WalletApiClient({
      baseUrl,
      network: fake.network,
      deviceId: 'dev-ws',
      storage: new MemoryKeyValueStore(),
      webSocketFactory: (url) => {
        const ws = new WebSocket(url);
        createdSockets.push(ws);
        return ws as unknown as WebSocketLike;
      },
    });
    client.setIdentity(identity);
  });

  afterEach(async () => {
    for (const ws of createdSockets) ws.close();
    await fake.stop();
  });

  it('connects via the ticket flow and delivers wake nudges', async () => {
    const wakes: WakeEvent[] = [];
    const handle = await client.connectWakeSocket((wake) => wakes.push(wake));

    fake.wakeOwner(identity.chainPubkey, 'inventory');
    await waitFor(() => wakes.length === 1);
    expect(wakes[0].stream).toBe('inventory');
    expect(typeof wakes[0].syncEpoch).toBe('bigint');

    fake.wakeOwner(identity.chainPubkey, 'payment_requests');
    await waitFor(() => wakes.length === 2);
    expect(wakes[1].stream).toBe('payment_requests');

    handle.close();
  });

  it('tickets are single-use: a second upgrade with the same ticket is refused (§9)', async () => {
    // Manual §4 auth + §9 ticket flow so the raw ticket is observable.
    const challengeRes = await fetch(`${baseUrl}/v1/auth/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pubkey: identity.chainPubkey }),
    });
    const { nonce, challenge } = (await challengeRes.json()) as { nonce: string; challenge: string };
    const verifyRes = await fetch(`${baseUrl}/v1/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, signature: signMessage(identity.privateKey, challenge), deviceId: 'manual' }),
    });
    const { jwt } = (await verifyRes.json()) as { jwt: string };
    const ticketRes = await fetch(`${baseUrl}/v1/ws-ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}` },
    });
    const { ticket } = (await ticketRes.json()) as { ticket: string };

    const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/v1/ws?ticket=${ticket}`;
    const first = new WebSocket(wsUrl);
    createdSockets.push(first);
    await new Promise<void>((resolve, reject) => {
      first.once('open', resolve);
      first.once('error', reject);
    });

    // The ticket was consumed by the first upgrade — reuse is refused.
    const second = new WebSocket(wsUrl);
    createdSockets.push(second);
    const refused = await new Promise<boolean>((resolve) => {
      second.once('open', () => resolve(false));
      second.once('error', () => resolve(true));
      second.once('unexpected-response', () => resolve(true));
    });
    expect(refused).toBe(true);
  });

  it('the socket is closed on logout (§9)', async () => {
    await client.connectWakeSocket(() => undefined);
    const socket = createdSockets[createdSockets.length - 1];
    expect(socket.readyState).toBe(WebSocket.OPEN);

    await client.logout();
    await waitFor(() => socket.readyState === WebSocket.CLOSED);
  });
});
