/**
 * P2/P3a LIVE staging validation of the NEW impl/wallet-api-v2 stack
 * (docs/PAYMENTS-V2-DESIGN.md §10 standing rule): real auth, real inventory,
 * real S3 signed-header uploads, real wake socket — no mocks anywhere.
 *
 * Run: npx vitest run --config vitest.e2e.config.ts tests/e2e/wallet-api-v2-session.staging.e2e.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { signMessage } from '../../core/crypto';
import { createWalletApiHttp, isWalletApiHttpError } from '../../impl/wallet-api-v2/http';
import { WalletApiV2Client } from '../../impl/wallet-api-v2/client';
import {
  JwtGenerationCell,
  WalletApiSession,
  type WebSocketLike,
} from '../../impl/wallet-api-v2/session';
import type { ScopedKV } from '../../modules/payments-v2/stores';
import { randomIdentity } from '../harness/support/stack';

const BASE_URL = process.env.STAGING_WALLET_API ?? 'https://wallet-api.staging.unicity.network';
const NETWORK = 'testnet2';
const RUN = process.env.STAGING_AGGREGATOR_KEY !== undefined;

function memoryKV(): ScopedKV {
  const m = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async (k, v) => void m.set(k, v),
    remove: async (k) => void m.delete(k),
  };
}

function nodeWsFactory(url: string): WebSocketLike {
  const ws = new NodeWebSocket(url);
  const like: WebSocketLike = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    close: (code?: number, reason?: string) => ws.close(code, reason),
  };
  ws.on('open', () => like.onopen?.());
  ws.on('message', (data) => like.onmessage?.({ data: data.toString() }));
  ws.on('close', (code) => like.onclose?.({ code }));
  ws.on('error', (err) => like.onerror?.(err));
  return like;
}

interface Harness {
  session: WalletApiSession;
  client: WalletApiV2Client;
  pubkey: string;
}

const open: Harness[] = [];

function makeHarness(): Harness {
  const id = randomIdentity();
  const cell = new JwtGenerationCell();
  const http = createWalletApiHttp({
    baseUrl: BASE_URL,
    fetchFn: (url, init) => fetch(url, init as RequestInit) as never,
    getToken: () => cell.token(),
  });
  const client = new WalletApiV2Client(http);
  const session = new WalletApiSession({
    client,
    cell,
    signer: {
      pubkey: id.chainPubkey,
      network: NETWORK,
      sign: (msg: string) => signMessage(id.privateKey, msg),
    },
    deviceId: `e2e-v2-${id.chainPubkey.slice(2, 12)}`,
    kv: memoryKV(),
    webSocketFactory: nodeWsFactory,
    emitStatus: () => undefined,
    onEpochChange: async () => undefined,
  });
  const h = { session, client, pubkey: id.chainPubkey };
  open.push(h);
  return h;
}

afterAll(async () => {
  for (const h of open) await h.session.stop().catch(() => undefined);
});

describe.runIf(RUN)('LIVE staging: impl/wallet-api-v2 session + client', () => {
  it('authenticates a fresh identity via challenge template verification and reads an empty inventory', async () => {
    const h = makeHarness();
    const jwt = await h.session.ensureAuthenticated();
    expect(jwt.split('.')).toHaveLength(3);

    const page = await h.session.withAuth(() => h.client.listInventory());
    expect(page.items).toHaveLength(0);
    expect(page.syncEpoch).toBeTruthy();
    expect(page.more).toBe(false);

    const balances = await h.session.withAuth(() => h.client.balances());
    expect(balances).toHaveLength(0);
  }, 30_000);

  it('uploads a blob through the presigned PUT with the SIGNED headers and re-upload is idempotent', async () => {
    const h = makeHarness();
    await h.session.ensureAuthenticated();
    const bytes = randomBytes(64);
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    const urls = await h.session.withAuth(() => h.client.uploadUrls([{ sha256, size: bytes.length }]));
    expect(urls).toHaveLength(1);
    await h.client.uploadBlob(urls[0].putUrl, bytes);

    const again = await h.session.withAuth(() => h.client.uploadUrls([{ sha256, size: bytes.length }]));
    await h.client.uploadBlob(again[0].putUrl, bytes);
  }, 30_000);

  it('history POST round-trips with dedupKey idempotency and the §16 wire shape', async () => {
    const h = makeHarness();
    await h.session.ensureAuthenticated();
    const dedupKey = `e2e:${randomUUID()}`;
    const record = {
      dedupKey,
      id: randomUUID(),
      type: 'MINT' as const,
      assets: [{ coinId: 'e2e0', amount: '123456789012345678901' }],
      ts: new Date().toISOString().replace('Z', '+00:00'),
    };
    const first = await h.session.withAuth(() => h.client.postHistory([record]));
    expect(first.inserted).toBe(1);
    const replay = await h.session.withAuth(() => h.client.postHistory([record]));
    expect(replay.deduped).toBe(1);

    const page = await h.session.withAuth(() => h.client.listHistory({ limit: 10 }));
    const mine = page.records.find((r) => r.dedupKey === dedupKey || r.id === record.id);
    expect(mine?.assets[0]?.amount).toBe('123456789012345678901');
  }, 30_000);

  it('a self payment request round-trips the S4 incoming stream, declines once, and 409s a second respond', async () => {
    const h = makeHarness();
    await h.session.ensureAuthenticated();
    const created = await h.session.withAuth(() =>
      h.client.createPaymentRequest({
        toPubkey: h.pubkey,
        assets: [{ coinId: 'e2e0', amount: '1' }],
      })
    );
    expect(created.status).toBe('open');

    const incoming = await h.session.withAuth(() =>
      h.client.listPaymentRequests({ role: 'incoming', since: 0 })
    );
    const mine = incoming.requests.find((r) => r.id === created.id);
    expect(mine).toBeDefined();

    const declined = await h.session.withAuth(() =>
      h.client.respondPaymentRequest(created.id, { action: 'declined' })
    );
    expect(declined.status).toBe('declined');

    await expect(
      h.session.withAuth(() => h.client.respondPaymentRequest(created.id, { action: 'declined' }))
    ).rejects.toSatisfy((e: unknown) => isWalletApiHttpError(e, 409));
  }, 30_000);

  it('the wake socket connects with a ticket and a payment-request write pushes a payment_requests wake', async () => {
    const h = makeHarness();
    await h.session.ensureAuthenticated();
    const woke = new Promise<void>((resolve) => {
      h.session.subscribeStream('payment_requests', () => resolve());
    });
    await h.session.start();
    await h.session.withAuth(() =>
      h.client.createPaymentRequest({ toPubkey: h.pubkey, assets: [{ coinId: 'e2e0', amount: '2' }] })
    );
    await expect(
      Promise.race([
        woke.then(() => 'woke'),
        new Promise((r) => setTimeout(() => r('timeout'), 20_000)),
      ])
    ).resolves.toBe('woke');
  }, 45_000);
});
