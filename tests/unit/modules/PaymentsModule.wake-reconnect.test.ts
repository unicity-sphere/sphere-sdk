/**
 * PaymentsModule × the §9 wake-socket RECONNECT SUPERVISOR, end-to-end against
 * the in-process fake backend — the heart of the cross-session-sync fix.
 *
 * The wake socket self-heals: when window B's socket drops, the supervisor
 * reconnects (backoff) AND runs a full catch-up pull of all three streams,
 * because wakes that fired while B was dark are NOT replayed by the server
 * (best-effort pub/sub). The KEY guarantee: a state change window A made while
 * B's socket was dead converges in B on RECONNECT — without waiting for the
 * 30 s poll backstop.
 *
 * Node < 22 has no global WebSocket — sockets are injected via the `ws` package
 * (this exact omission already broke a CI node-20 leg).
 */
import WebSocket from 'ws';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPaymentsModule, type PaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { FullIdentity, IncomingPaymentRequest } from '../../../types';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { StorageProvider } from '../../../storage';
import { FakeTokenEngine, decodeFakeTokenAssets, decodeFakeTokenId } from '../token-engine/FakeTokenEngine';
import { FakeWalletApi } from '../../support/fake-wallet-api';
import { MemoryKeyValueStore, testIdentity } from '../../support/wallet-api-test-helpers';
import { WalletApiClient, type WebSocketLike } from '../../../wallet-api';
import { WalletApiMailboxProvider, WalletApiTokenStorageProvider } from '../../../impl/shared/wallet-api';
import { encodeTokenBlob } from '../../../token-engine/token-blob';
import { hexToBytes } from '../../../core/crypto';

const UCT = '11'.repeat(32);
const OWNER = testIdentity(81);
const REQUESTER = testIdentity(82);

function fullIdentity(id: { privateKey: string; chainPubkey: string }): FullIdentity {
  return {
    chainPubkey: id.chainPubkey,
    privateKey: id.privateKey,
    l1Address: `alpha1${id.chainPubkey.slice(0, 8)}`,
    directAddress: `DIRECT://${id.chainPubkey.slice(0, 12)}`,
    transportPubkey: id.chainPubkey.slice(2),
  };
}

function mockStorage(): { provider: StorageProvider } {
  const s = new Map<string, string>();
  const provider = {
    id: 's', name: 's', type: 'local', connect: vi.fn(), disconnect: vi.fn(),
    isConnected: () => true, getStatus: () => 'connected', setIdentity: vi.fn(),
    get: vi.fn(async (k: string) => s.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { s.set(k, v); }),
    remove: vi.fn(async (k: string) => { s.delete(k); }),
    has: vi.fn(async (k: string) => s.has(k)),
    keys: vi.fn(async () => [...s.keys()]),
    clear: vi.fn(async () => { s.clear(); }),
  } as unknown as StorageProvider;
  return { provider };
}

function mockTransport(): TransportProvider {
  return {
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    sendPaymentRequest: vi.fn().mockResolvedValue('nostr-event'),
    sendPaymentRequestResponse: vi.fn().mockResolvedValue('nostr-event'),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn(async (recipient: string) =>
      /^0[23][0-9a-f]{64}$/i.test(recipient)
        ? { chainPubkey: recipient.toLowerCase(), transportPubkey: recipient.slice(2), directAddress: `DIRECT://${recipient.slice(0, 12)}` }
        : null
    ),
    resolveTransportPubkeyInfo: vi.fn().mockResolvedValue(null),
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(), isConnected: () => true,
  } as unknown as TransportProvider;
}

function mockOracle(): OracleProvider {
  return { validateToken: vi.fn().mockResolvedValue({ valid: true }), isDevMode: () => false } as unknown as OracleProvider;
}

interface Wallet {
  module: PaymentsModule;
  engine: FakeTokenEngine;
  client: WalletApiClient;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startFake(): Promise<{ fake: FakeWalletApi; baseUrl: string }> {
  const fake = new FakeWalletApi({ decodeAssets: decodeFakeTokenAssets, decodeTokenId: decodeFakeTokenId });
  const baseUrl = await fake.start();
  cleanups.push(() => fake.stop());
  return { fake, baseUrl };
}

function makeWallet(baseUrl: string, network: string, who: { privateKey: string; chainPubkey: string }, deviceId: string): Wallet {
  const identity = fullIdentity(who);
  const kv = new MemoryKeyValueStore();
  const client = new WalletApiClient({
    baseUrl,
    network,
    deviceId,
    storage: kv,
    webSocketFactory: (url) => new WebSocket(url) as unknown as WebSocketLike,
  });
  const tokenStorage = new WalletApiTokenStorageProvider({ client, stateStore: kv });
  tokenStorage.setIdentity(identity);
  const delivery = new WalletApiMailboxProvider({ client, custody: 'inventory', stateStore: kv });
  const engine = new FakeTokenEngine({ chainPubkey: hexToBytes(who.chainPubkey) });
  const deps: PaymentsModuleDependencies = {
    identity,
    storage: mockStorage().provider,
    tokenStorageProviders: new Map([[tokenStorage.id, tokenStorage]]),
    transport: mockTransport(),
    oracle: mockOracle(),
    emitEvent: vi.fn(),
    tokenEngine: engine,
    delivery,
    walletApi: client,
  };
  const module = createPaymentsModule({ l1: null });
  module.initialize(deps);
  cleanups.push(() => module.destroy());
  return { module, engine, client };
}

async function seedServerToken(fake: FakeWalletApi, wallet: Wallet, who: { chainPubkey: string }, amount: bigint): Promise<void> {
  const minted = await wallet.engine.mint({ recipientPubkey: wallet.engine.getIdentity().chainPubkey, value: { assets: [{ coinId: UCT, amount }] } });
  const bytes = encodeTokenBlob(wallet.engine.encodeToken(minted));
  fake.seedInventory(who.chainPubkey, [{ tokenId: wallet.engine.tokenId(minted), assets: [{ coinId: UCT, amount }], blob: bytes }]);
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: predicate never became true');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('wallet-api wake reconnect converges a window whose socket went dark (§9)', () => {
  it('B reconnects after a drop AND catches up an inventory top-up made while it was dark — no 30 s poll', async () => {
    const { fake, baseUrl } = await startFake();
    const windowB = makeWallet(baseUrl, fake.network, OWNER, 'win-b');
    await windowB.module.load();
    expect(windowB.module.getTokens()).toHaveLength(0);
    await waitFor(() => fake.socketCount(OWNER.chainPubkey) === 1);

    // B's wake socket dies (proxy/idle/network kill) — unobserved by the bare handle.
    expect(fake.dropSockets(OWNER.chainPubkey)).toBe(1);
    await waitFor(() => fake.socketCount(OWNER.chainPubkey) === 0);

    // While B is DARK, window A tops up the shared inventory (+ the wake that
    // fires now reaches nobody — B has no socket; the server does not replay it).
    await seedServerToken(fake, windowB, OWNER, 1000n);
    fake.wakeOwner(OWNER.chainPubkey, 'inventory'); // lands on zero sockets

    // The supervisor reconnects and its catch-up pump full-resyncs every stream:
    // B converges on the top-up it NEVER got a live wake for.
    await waitFor(() => fake.socketCount(OWNER.chainPubkey) === 1);
    await waitFor(() => windowB.module.getTokens().length === 1);
    expect(windowB.module.getTokens()[0]).toMatchObject({ amount: '1000', coinId: UCT, status: 'confirmed' });
  });

  it('B reconnects and catches up a payment-request created while it was dark', async () => {
    const { fake, baseUrl } = await startFake();
    const payer = makeWallet(baseUrl, fake.network, OWNER, 'pay-b');
    const requester = makeWallet(baseUrl, fake.network, REQUESTER, 'req-a');
    await payer.module.load();
    await waitFor(() => fake.socketCount(OWNER.chainPubkey) === 1);

    const surfaced: IncomingPaymentRequest[] = [];
    payer.module.onPaymentRequest((r) => surfaced.push(r));

    // The payer's socket dies.
    fake.dropSockets(OWNER.chainPubkey);
    await waitFor(() => fake.socketCount(OWNER.chainPubkey) === 0);

    // The requester creates a PR while the payer is dark — its `payment_requests`
    // wake reaches no socket.
    const created = await requester.module.sendPaymentRequest(OWNER.chainPubkey, { amount: '25', coinId: UCT });
    expect(created.success).toBe(true);

    // On reconnect the catch-up PR pump surfaces the request the payer never got
    // a live wake for — convergence from the reconnect alone, not the poll.
    await waitFor(() => fake.socketCount(OWNER.chainPubkey) === 1);
    await waitFor(() => surfaced.length === 1);
    expect(surfaced[0]).toMatchObject({ id: created.requestId, amount: '25', coinId: UCT, status: 'pending' });
  });

  it('destroy() tears the wake socket down and it does not reconnect', async () => {
    const { fake, baseUrl } = await startFake();
    const windowB = makeWallet(baseUrl, fake.network, OWNER, 'win-destroy');
    await windowB.module.load();
    await waitFor(() => fake.socketCount(OWNER.chainPubkey) === 1);

    windowB.module.destroy();
    await waitFor(() => fake.socketCount(OWNER.chainPubkey) === 0);

    // A torn-down module must never re-establish the socket.
    await new Promise((r) => setTimeout(r, 150));
    expect(fake.socketCount(OWNER.chainPubkey)).toBe(0);
  });
});
