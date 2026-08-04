/**
 * LIVE staging money e2e for the payments-v2 VERTICAL (docs/PAYMENTS-V2-DESIGN.md
 * §10 transfer-shape matrix + standing rule): PaymentsFacade composed over the
 * REAL impl/wallet-api-v2 ports (storage/mailbox/checkpoints/session) and the
 * REAL token engine against the REAL staging wallet-api + testnet2 gateway.
 * No fakes anywhere — every seam the unit facade suite stubbed is real here.
 *
 * Tests are SEQUENTIAL and share wallets: later tests spend earlier balances.
 *
 * Gated on STAGING_AGGREGATOR_KEY. Run:
 *   set -a && source .env && set +a && npx vitest run --config vitest.e2e.config.ts \
 *     tests/e2e/payments-v2-vertical.staging.e2e.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';

import { hexToBytes, signMessage } from '../../core/crypto';
import { deriveFieldEncryptionKey } from '../../core/field-encryption';
import {
  decryptDeliveryBundle,
  deriveDeliveryEncryptionKey,
  encryptDeliveryBundle,
} from '../../core/delivery-envelope';
import { createWalletApiHttp } from '../../impl/wallet-api-v2/http';
import { WalletApiV2Client } from '../../impl/wallet-api-v2/client';
import {
  JwtGenerationCell,
  WalletApiSession,
  type WebSocketLike,
} from '../../impl/wallet-api-v2/session';
import { WalletApiStoragePort, type StoragePortClient } from '../../impl/wallet-api-v2/storage';
import { WalletApiDeliveryPort, type DeliveryPortClient } from '../../impl/wallet-api-v2/mailbox';
import {
  WalletApiSplitCheckpointStore,
  type CheckpointClient,
} from '../../impl/wallet-api-v2/checkpoints';
import { PaymentsFacade, type FacadeClient } from '../../modules/payments-v2/PaymentsFacade';
import type { DeliveryPort, InventoryItem } from '../../modules/payments-v2/ports';
import type { ScopedKV } from '../../modules/payments-v2/stores';
import { createMachineStores } from '../../modules/payments-v2/machine/journal';
import type { RequestMemoCodec } from '../../modules/payments-v2/requests/Requests';
import { createSphereTokenEngine } from '../../token-engine/factory';
import type { ITokenEngine } from '../../token-engine/engine';
import type { HistoryEntry } from '../../modules/payments-v2/api';
import { HARNESS_COIN, randomIdentity } from '../harness/support/stack';

const API_KEY = process.env.STAGING_AGGREGATOR_KEY;
const RUN = API_KEY !== undefined && API_KEY !== '';

const BASE_URL = process.env.STAGING_WALLET_API ?? 'https://wallet-api.staging.unicity.network';
const AGGREGATOR_URL = process.env.STAGING_AGGREGATOR ?? 'https://gateway.testnet2.unicity.network';
const TRUSTBASE_URL =
  process.env.STAGING_TRUSTBASE ??
  'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/main/bft-trustbase.testnet2.json';
const NETWORK = 'testnet2';

// ── shared plumbing ──────────────────────────────────────────────────────────

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

// Fetched ONCE per run — the same pinned testnet2 root the other staging suites use.
let trustbasePromise: Promise<unknown> | null = null;
function trustbase(): Promise<unknown> {
  trustbasePromise ??= (async () => {
    const res = await fetch(TRUSTBASE_URL);
    if (!res.ok) throw new Error(`trustbase fetch failed: HTTP ${String(res.status)} (${TRUSTBASE_URL})`);
    return res.json() as Promise<unknown>;
  })();
  return trustbasePromise;
}

// Minimal RegistryReader: answers the harness coin; decimals 0 (integer amounts).
const registry = {
  getSymbol: (coinId: string) => (coinId === HARNESS_COIN ? 'HARN' : coinId.slice(0, 8)),
  getName: (coinId: string) => (coinId === HARNESS_COIN ? 'Harness Coin' : 'Unknown'),
  getDecimals: () => 0,
  getIconUrl: () => null,
};

// The server /v1/balances endpoint stays a TEST observation surface (serverTotal)
// even though the StoragePort no longer exposes it (assets() aggregates the mirror).
type AuthedClient = StoragePortClient &
  DeliveryPortClient &
  CheckpointClient &
  FacadeClient &
  Pick<WalletApiV2Client, 'balances'>;

/**
 * Every wallet-api call the facade/ports make rides session.withAuth (one 401 →
 * single-flight re-auth → one retry): the suite outlives the 900 s JWT TTL.
 * Presigned-S3 fetch/upload carry no bearer and pass straight through.
 */
function authedClient(session: WalletApiSession, client: WalletApiV2Client): AuthedClient {
  const auth = <T,>(op: () => Promise<T>): Promise<T> => session.withAuth(() => op());
  return {
    listInventory: (since) => auth(() => client.listInventory(since)),
    balances: () => auth(() => client.balances()),
    blobUrls: (tokenIds) => auth(() => client.blobUrls(tokenIds)),
    uploadUrls: (blobs) => auth(() => client.uploadUrls(blobs)),
    apply: (delta) => auth(() => client.apply(delta)),
    fetchBlob: (getUrl) => client.fetchBlob(getUrl),
    uploadBlob: (putUrl, bytes) => client.uploadBlob(putUrl, bytes),
    putIntent: (t, payload, requiresSeedClose) => auth(() => client.putIntent(t, payload, requiresSeedClose)),
    listIntents: (status) => auth(() => client.listIntents(status)),
    abortIntent: (t) => auth(() => client.abortIntent(t)),
    completeIntent: (t, signature) => auth(() => client.completeIntent(t, signature)),
    postProgress: (t, opIndex, payload, signature) => auth(() => client.postProgress(t, opIndex, payload, signature)),
    getProgress: (t) => auth(() => client.getProgress(t)),
    deposit: (entry) => auth(() => client.deposit(entry)),
    depositBatch: (entries) => auth(() => client.depositBatch(entries)),
    listMailbox: (since) => auth(() => client.listMailbox(since)),
    claim: (entryIds, intoInventory) => auth(() => client.claim(entryIds, intoInventory)),
    reject: (entryIds, reason, detail) => auth(() => client.reject(entryIds, reason, detail)),
    postHistory: (records) => auth(() => client.postHistory(records)),
    listHistory: (options) => auth(() => client.listHistory(options)),
    createPaymentRequest: (input) => auth(() => client.createPaymentRequest(input)),
    listPaymentRequests: (params) => auth(() => client.listPaymentRequests(params)),
    respondPaymentRequest: (id, response) => auth(() => client.respondPaymentRequest(id, response)),
  };
}

// The REAL recipient-ECDH bundle codec (S6) — same primitive delivery memos use.
function memoCodec(privateKey: string): RequestMemoCodec {
  return {
    encrypt: (peerPubkey, bundle) =>
      encryptDeliveryBundle(deriveDeliveryEncryptionKey(privateKey, peerPubkey), {
        ...(bundle.memo !== undefined ? { memo: bundle.memo } : {}),
        ...(bundle.senderNametag !== undefined ? { senderNametag: bundle.senderNametag } : {}),
      }),
    decrypt: (peerPubkey, envelope) => {
      const bundle = decryptDeliveryBundle(deriveDeliveryEncryptionKey(privateKey, peerPubkey), envelope);
      return {
        ...(bundle.memo !== undefined ? { memo: bundle.memo } : {}),
        ...(bundle.senderNametag !== undefined ? { senderNametag: bundle.senderNametag } : {}),
      };
    },
  };
}

interface VIdentity {
  privateKey: string;
  chainPubkey: string;
}

interface VWallet {
  facade: PaymentsFacade;
  session: WalletApiSession;
  api: AuthedClient;
  kv: ScopedKV;
  identity: VIdentity;
  engine: ITokenEngine;
  events: { event: string; payload: unknown }[];
}

const openWallets: VWallet[] = [];

interface MakeOptions {
  identity?: VIdentity;
  kv?: ScopedKV;
  wrapDelivery?: (inner: DeliveryPort) => DeliveryPort;
}

/** The whole vertical, composed for real: session → authed client → ports → engine → facade. */
async function makeVerticalWallet(tag: string, options: MakeOptions = {}): Promise<VWallet> {
  const identity = options.identity ?? randomIdentity();
  const kv = options.kv ?? memoryKV();
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
      pubkey: identity.chainPubkey,
      network: NETWORK,
      sign: (msg: string) => signMessage(identity.privateKey, msg),
    },
    // Deterministic per (tag, identity): a restarted instance reuses its refresh token.
    deviceId: `e2e-vert-${tag}-${identity.chainPubkey.slice(2, 12)}`,
    kv,
    webSocketFactory: nodeWsFactory,
    emitStatus: () => undefined,
    onEpochChange: async () => undefined,
    timing: { pullIntervalMs: 5_000 },
  });
  const api = authedClient(session, client);
  const fieldKey = deriveFieldEncryptionKey(identity.privateKey);
  const realDelivery = new WalletApiDeliveryPort({
    client: api,
    kv,
    identity: { privateKey: identity.privateKey, chainPubkey: identity.chainPubkey },
    custody: 'inventory',
  });
  const engine = await createSphereTokenEngine({
    aggregatorUrl: AGGREGATOR_URL,
    ...(API_KEY !== undefined && API_KEY !== '' ? { apiKey: API_KEY } : {}),
    privateKey: hexToBytes(identity.privateKey),
    trustBaseJson: await trustbase(),
  });
  const events: { event: string; payload: unknown }[] = [];
  const facade = new PaymentsFacade({
    session,
    client: api,
    storagePort: new WalletApiStoragePort(api),
    deliveryPort: options.wrapDelivery ? options.wrapDelivery(realDelivery) : realDelivery,
    checkpointStore: new WalletApiSplitCheckpointStore({
      client: api,
      kv,
      fieldKey,
      signProgress: (message) => signMessage(identity.privateKey, message),
    }),
    engineRef: () => engine,
    kv,
    registry,
    emit: (event, payload) => {
      events.push({ event, payload });
    },
    // Raw-pubkey identifiers only (this suite never uses nametags); pinned to the session network.
    resolveRecipient: async (identifier) =>
      /^0[23][0-9a-f]{64}$/.test(identifier) ? { chainPubkey: identifier, network: NETWORK } : null,
    // The #87 canonical close message the server's seedGate verifies.
    signComplete: async (transferId) =>
      signMessage(identity.privateKey, `wallet-api.complete.v1:${transferId}`),
    fieldKey,
    network: NETWORK,
    ownPubkey: identity.chainPubkey,
    requestMemo: memoCodec(identity.privateKey),
  });
  await session.ensureAuthenticated();
  await facade.start();
  const wallet: VWallet = { facade, session, api, kv, identity, engine, events };
  openWallets.push(wallet);
  return wallet;
}

afterAll(async () => {
  for (const w of openWallets.splice(0)) {
    await w.facade.stop().catch(() => undefined);
  }
}, 120_000);

// ── observation helpers (state-based; never trust a single drain's return) ──

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function localTotal(w: VWallet): bigint {
  return w.facade
    .tokens({ coinId: HARNESS_COIN })
    .reduce((sum, token) => sum + BigInt(token.amount), 0n);
}

async function serverTotal(w: VWallet): Promise<bigint> {
  const balances = await w.api.balances();
  const row = balances.find((b) => b.coinId === HARNESS_COIN);
  return row === undefined ? 0n : BigInt(row.total);
}

async function activeRows(w: VWallet): Promise<InventoryItem[]> {
  const rows: InventoryItem[] = [];
  let page = await w.api.listInventory();
  for (;;) {
    rows.push(...page.items.filter((item) => item.status === 'active'));
    if (!page.more) return rows;
    page = await w.api.listInventory(page.cursor);
  }
}

async function historyEntries(w: VWallet): Promise<HistoryEntry[]> {
  return (await w.facade.history({ limit: 100 })).entries;
}

async function receivedLegs(w: VWallet, tokenId: string): Promise<HistoryEntry[]> {
  return (await historyEntries(w)).filter(
    (e) => e.type === 'RECEIVED' && e.tokenId === tokenId.toLowerCase()
  );
}

async function openIntentIds(w: VWallet): Promise<string[]> {
  return (await w.api.listIntents('open')).map((i) => i.transferId);
}

async function diagnose(label: string, w: VWallet): Promise<string> {
  const grab = async (what: () => Promise<unknown>): Promise<unknown> => {
    try {
      return await what();
    } catch (err) {
      return `unavailable: ${String(err)}`;
    }
  };
  return JSON.stringify(
    {
      label,
      localTokens: w.facade.tokens().map((t) => ({ id: t.id, amount: t.amount, status: t.status })),
      serverBalances: await grab(() => w.api.balances()),
      openIntents: await grab(() => openIntentIds(w)),
      mailbox: await grab(async () =>
        (await w.api.listMailbox(0)).entries.map((e) => ({
          tokenId: e.tokenId,
          status: e.status,
          transferId: e.transferId,
        }))
      ),
    },
    null,
    2
  );
}

/** Poll a state predicate. Staging hiccups: retry the CHECK, never a send. */
async function waitFor(
  w: VWallet,
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  for (;;) {
    try {
      if (await check()) return;
      lastError = null;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `waitFor timeout: ${label}${lastError !== null ? ` (last error: ${String(lastError)})` : ''}\n${await diagnose(label, w)}`
      );
    }
    await sleep(2_000);
  }
}

/** Drain the mailbox (retrying failed DRAINS) until the state predicate holds. */
async function drainUntil(
  w: VWallet,
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
  label: string
): Promise<void> {
  await waitFor(
    w,
    async () => {
      await w.facade.receive().catch(() => undefined);
      return check();
    },
    timeoutMs,
    label
  );
}

// ── wallets shared ACROSS tests (sequential; later tests spend earlier balances) ──

let walletA: VWallet | undefined;
let walletB: VWallet | undefined;
let mintedA = ''; // test 1: A's minted 1000-token genesis id
let splitToA = ''; // test 3: the fresh 400 genesis A received from B's split
let legsBeforeRoundtrip = 0; // test 5: A's RECEIVED count for splitToA before the roundtrip

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} missing — a prior test did not complete`);
  return value;
}

describe.runIf(RUN)('LIVE staging: payments-v2 vertical (facade over real ports + engine)', () => {
  it('mint: journal-first self-mint lands on-chain, in server inventory, and in MINT history', async () => {
    walletA = await makeVerticalWallet('a');
    const a = walletA;

    const result = await a.facade.mint(HARNESS_COIN, 1000n);
    expect(result.success).toBe(true);
    expect(result.tokenId).toMatch(/^[0-9a-f]+$/);
    mintedA = must(result.tokenId, 'mint tokenId');

    // finalizeMint cleared the journal before mint() resolved (journal-first lifecycle).
    expect(await createMachineStores(a.kv).mintJournal.list()).toEqual([]);

    await waitFor(a, () => localTotal(a) === 1000n, 60_000, 'A local view shows the 1000 mint');
    const assets = await a.facade.assets(HARNESS_COIN);
    expect(assets).toHaveLength(1);
    expect(assets[0]?.totalAmount).toBe('1000');
    expect(a.facade.tokens().map((t) => t.id)).toEqual([mintedA]);

    const rows = await activeRows(a);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenId).toBe(mintedA);
    expect(await serverTotal(a)).toBe(1000n);

    await waitFor(
      a,
      async () =>
        (await historyEntries(a)).some((e) => e.type === 'MINT' && e.tokenId === mintedA && e.amount === '1000'),
      30_000,
      'MINT history record'
    );
  }, 150_000);

  it('exact single: whole-token A→B; recipient verifies before balance; intent completes', async () => {
    const a = must(walletA, 'wallet A');
    walletB = await makeVerticalWallet('b');
    const b = walletB;

    const result = await a.facade.send({
      recipient: b.identity.chainPubkey,
      amount: '1000',
      coinId: HARNESS_COIN,
    });
    expect(result.status).toBe('delivered');
    expect(result.deliveryPending).toBe(false);
    expect(result.tokenTransfers).toEqual([{ sourceTokenId: mintedA, method: 'direct' }]);

    // B's acceptance implies the full real trust-base verify + isOwnedBy passed
    // (Receive screens BEFORE store/claim); the claim puts the row in B's inventory.
    await drainUntil(b, () => localTotal(b) === 1000n, 90_000, 'B receives 1000');
    expect((await activeRows(b)).map((r) => r.tokenId)).toEqual([mintedA]);
    expect(await serverTotal(b)).toBe(1000n);

    await waitFor(a, async () => (await serverTotal(a)) === 0n && localTotal(a) === 0n, 60_000, 'A drained to 0');

    await waitFor(
      a,
      async () => (await historyEntries(a)).some((e) => e.type === 'SENT' && e.transferId === result.id),
      30_000,
      'A SENT history record'
    );
    expect(await receivedLegs(b, mintedA)).toHaveLength(1);

    // closeTail is fire-and-forget after send() resolves — poll to empty.
    await waitFor(a, async () => (await openIntentIds(a)).length === 0, 60_000, 'A open intents empty');
  }, 180_000);

  it('split: B→A 400 of 1000 — burn+checkpoint+mints; change stays with B', async () => {
    const a = must(walletA, 'wallet A');
    const b = must(walletB, 'wallet B');

    const result = await b.facade.send({
      recipient: a.identity.chainPubkey,
      amount: '400',
      coinId: HARNESS_COIN,
    });
    expect(result.status).toBe('delivered');
    expect(result.tokenTransfers).toEqual([{ sourceTokenId: mintedA, method: 'split' }]);

    await drainUntil(a, () => localTotal(a) === 400n, 90_000, 'A receives the 400 split output');
    const aTokens = a.facade.tokens();
    expect(aTokens).toHaveLength(1);
    splitToA = must(aTokens[0], 'A split-output token').id;
    expect(splitToA).not.toBe(mintedA); // split mints a FRESH genesis
    legsBeforeRoundtrip = (await receivedLegs(a, splitToA)).length;
    expect(legsBeforeRoundtrip).toBe(1);

    // B keeps exactly the 600 change (fresh genesis), locally and on the server.
    await waitFor(
      b,
      () => {
        const tokens = b.facade.tokens();
        return tokens.length === 1 && tokens[0]?.amount === '600' && tokens[0].id !== mintedA;
      },
      90_000,
      'B local view settles to the 600 change token'
    );
    const changeId = must(b.facade.tokens()[0], 'B change token').id;
    const bRows = await activeRows(b);
    expect(bRows.map((r) => r.tokenId)).toEqual([changeId]);
    expect(await serverTotal(b)).toBe(600n);

    // requiresSeedClose intent: an empty open list proves the SIGNED seed-close
    // (wallet-api.complete.v1) was accepted by the real server gate.
    await waitFor(b, async () => (await openIntentIds(b)).length === 0, 60_000, 'B open intents empty');
  }, 180_000);

  it('self-send: spend and claim commute; no phantom, no double', async () => {
    const a = must(walletA, 'wallet A');

    const result = await a.facade.send({
      recipient: a.identity.chainPubkey,
      amount: '400',
      coinId: HARNESS_COIN,
    });
    expect(result.status).toBe('delivered');
    expect(result.tokenTransfers).toEqual([{ sourceTokenId: splitToA, method: 'direct' }]);

    // The self-output rides A's own mailbox; the claim reactivates the row at
    // the NEW state. Settled = same genesis, same value, exactly once.
    await drainUntil(
      a,
      async () =>
        localTotal(a) === 400n &&
        (await serverTotal(a)) === 400n &&
        (await receivedLegs(a, splitToA)).length === 2,
      120_000,
      'A self-send round-trips through the mailbox'
    );

    const rows = await activeRows(a);
    expect(rows.map((r) => r.tokenId)).toEqual([splitToA]); // one active row — no phantom, no double
    expect(a.facade.tokens().map((t) => ({ id: t.id, amount: t.amount }))).toEqual([
      { id: splitToA, amount: '400' },
    ]);
    legsBeforeRoundtrip = 2; // (splitToA@mint-state, splitToA@self-send-state)
    await waitFor(a, async () => (await openIntentIds(a)).length === 0, 60_000, 'A open intents empty');
  }, 180_000);

  it('roundtrip A→B→A: the re-acquired genesis at a NEW state is accepted; two RECEIVED legs', async () => {
    const a = must(walletA, 'wallet A');
    const b = must(walletB, 'wallet B');

    const out = await a.facade.send({
      recipient: b.identity.chainPubkey,
      amount: '400',
      coinId: HARNESS_COIN,
    });
    expect(out.tokenTransfers).toEqual([{ sourceTokenId: splitToA, method: 'direct' }]);
    await drainUntil(b, () => localTotal(b) === 1000n, 90_000, 'B holds 600 change + the 400 roundtrip token');
    expect(await receivedLegs(b, splitToA)).toHaveLength(1);

    // B's pool is {600, 400}: exact-single selection MUST send the SAME genesis back whole.
    const back = await b.facade.send({
      recipient: a.identity.chainPubkey,
      amount: '400',
      coinId: HARNESS_COIN,
    });
    expect(back.tokenTransfers).toEqual([{ sourceTokenId: splitToA, method: 'direct' }]);

    // Per-state dedup accepts the re-acquired genesis at its NEW state: the
    // roundtrip return is a FRESH leg on top of the two prior states (test 3
    // receipt + test 4 self-send), never deduped away and never doubled.
    await drainUntil(
      a,
      async () =>
        localTotal(a) === 400n && (await receivedLegs(a, splitToA)).length === legsBeforeRoundtrip + 1,
      120_000,
      'A re-acquires the same genesis at a new state'
    );
    expect(await receivedLegs(a, splitToA)).toHaveLength(3);
    expect((await activeRows(a)).map((r) => r.tokenId)).toEqual([splitToA]);
    expect(await serverTotal(a)).toBe(400n);
    await waitFor(b, async () => (await serverTotal(b)) === 600n && localTotal(b) === 600n, 60_000, 'B back to 600');
  }, 240_000);

  it('crash-window resume: a deposit that fails once is journaled and a SECOND instance replays it — recipient paid exactly once', async () => {
    // Fail the FIRST deliverBatch call AND the FIRST deliver call, then pass through:
    // the certified blob must survive in the journal across the simulated crash.
    const failOnce = (inner: DeliveryPort): DeliveryPort => {
      let batchFailed = false;
      let deliverFailed = false;
      return {
        bindDeliveryKeys: (derive) => inner.bindDeliveryKeys(derive),
        deliver: async (recipient, blob, options) => {
          if (!deliverFailed) {
            deliverFailed = true;
            throw new Error('synthetic network error: deliver (crash window)');
          }
          return inner.deliver(recipient, blob, options);
        },
        deliverBatch: async (recipient, blobs, options) => {
          if (!batchFailed) {
            batchFailed = true;
            throw new Error('synthetic network error: deliverBatch (crash window)');
          }
          return inner.deliverBatch!(recipient, blobs, options);
        },
        incoming: (since) => inner.incoming(since),
        ack: (id, disposition, reason) => inner.ack(id, disposition, reason),
        ...(inner.onWake !== undefined ? { onWake: inner.onWake.bind(inner) } : {}),
      };
    };

    const cIdentity = randomIdentity();
    const cKv = memoryKV();
    const c1 = await makeVerticalWallet('c', { identity: cIdentity, kv: cKv, wrapDelivery: failOnce });
    const d = await makeVerticalWallet('d');

    const mint = await c1.facade.mint(HARNESS_COIN, 500n);
    expect(mint.success).toBe(true);
    const genesis = must(mint.tokenId, 'C mint tokenId');
    await waitFor(c1, () => localTotal(c1) === 500n, 60_000, 'C local view shows the 500 mint');

    const result = await c1.facade.send({
      recipient: d.identity.chainPubkey,
      amount: '500',
      coinId: HARNESS_COIN,
    });
    // Certification succeeded, both delivery attempts failed: the send resolves
    // with the blob JOURNALED, never lost and never re-certified.
    expect(result.deliveryPending).toBe(true);
    expect(result.status).toBe('confirmed');
    const journaled = await createMachineStores(cKv).deliveryJournal.list();
    expect(journaled).toHaveLength(1);
    expect(journaled[0]?.transferId).toBe(result.id);
    expect(journaled[0]?.recipientPubkey).toBe(d.identity.chainPubkey);

    // Simulated crash: instance 1 goes away; instance 2 rises on the SAME kv + identity.
    await c1.facade.stop();
    const c2 = await makeVerticalWallet('c', { identity: cIdentity, kv: cKv });

    await drainUntil(d, async () => localTotal(d) === 500n && (await serverTotal(d)) === 500n, 120_000, 'D paid via journal replay');
    await waitFor(c2, async () => (await createMachineStores(cKv).deliveryJournal.list()).length === 0, 60_000, 'C journal drained');
    await waitFor(c2, async () => (await openIntentIds(c2)).length === 0, 60_000, 'C open intents empty');
    expect(await serverTotal(c2)).toBe(0n);

    // No double delivery: a further 10 s drain window changes NOTHING for D.
    await sleep(10_000);
    await d.facade.receive().catch(() => undefined);
    expect(localTotal(d)).toBe(500n);
    expect(await serverTotal(d)).toBe(500n);
    expect((await activeRows(d)).map((r) => r.tokenId)).toEqual([genesis]);
    expect(await receivedLegs(d, genesis)).toHaveLength(1);
  }, 240_000);
});
