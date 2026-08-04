/**
 * LIVE staging gate for the SPHERE-LEVEL paymentsV2 wiring (P9, docs §10
 * standing rule: fakes prove invariants, STAGING PROVES REALITY): a full
 * `Sphere.init({ paymentsV2: true, autoGenerate: true })` against the REAL
 * staging wallet-api + testnet2 gateway, with the transport composed by the
 * DEFAULT wiring path — the old S4 `WalletApiClient` passed as `walletApi` is
 * only the config source (baseUrl / network / deviceId / ws factory via the
 * `ws` package); the vertical builds its own client + auth lineage.
 *
 * Flow: mint HARNESS coin → assets() shows it → self-send the exact amount
 * (spend and claim commute through the wallet's own mailbox) → receive()
 * drains → balance unchanged, one RECEIVED leg, `transfer:incoming` reached
 * `sphere.on` → destroy() is clean.
 *
 * Throttle reality: the shared testnet2 gateway rate-limits certification
 * submits per minute (429 = rejected BEFORE execution, Retry-After ~1 min).
 * Mint retries are safe (a refused submit certified nothing). A send that
 * lands keep-open (`isPossiblyCommittedSendOutcome`) is NEVER re-issued —
 * convergence is a same-transferId resume, exercised here the way production
 * does it: re-init Sphere on the same storage and let `facade.start()` resume.
 * Assertions stay exact: one genesis, amount unchanged, exactly-once receipt.
 *
 * Gated on STAGING_AGGREGATOR_KEY. Run:
 *   set -a && source .env && set +a && npx vitest run --config vitest.e2e.config.ts \
 *     tests/e2e/sphere-paymentsv2-wiring.staging.e2e.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';

import { Sphere, type SphereWalletApiSession } from '../../core/Sphere';
import { isPossiblyCommittedSendOutcome } from '../../core/errors';
import { FileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import { WalletApiClient } from '../../wallet-api';
import type { WebSocketLike as OldWebSocketLike } from '../../wallet-api/types';
import type { TransportProvider } from '../../transport';
import type { OracleProvider } from '../../oracle';
import type { IncomingTransfer, ProviderStatus, TransferResult } from '../../types';
import type { PaymentsV2 } from '../../modules/payments-v2/api';
import { HARNESS_COIN } from '../harness/support/stack';

const API_KEY = process.env.STAGING_AGGREGATOR_KEY;
const RUN = API_KEY !== undefined && API_KEY !== '';

const BASE_URL = process.env.STAGING_WALLET_API ?? 'https://wallet-api.staging.unicity.network';
const AGGREGATOR_URL = process.env.STAGING_AGGREGATOR ?? 'https://gateway.testnet2.unicity.network';
const TRUSTBASE_URL =
  process.env.STAGING_TRUSTBASE ??
  'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/main/bft-trustbase.testnet2.json';
const NETWORK = 'testnet2';

/**
 * The shared testnet2 submit key is heavily contended (observed 2026-08-04:
 * long stretches where every certification_request 429s; a failed engine
 * attempt itself costs the 10 s proof-poll window). Attempts are paced ~20 s
 * apart under a large budget; `aborted` stops any loop the vitest timeout
 * abandoned so teardown's stop() can drain pendingOps.
 */
const THROTTLE_WAIT_MS = 10_000;
const MAX_MINT_ATTEMPTS = 60;
const MAX_RESUME_CYCLES = 20;
let aborted = false;

function logStep(step: string): void {
  console.log(`[pv2-e2e ${new Date().toISOString()}] ${step}`);
}

function nodeWsFactory(url: string): OldWebSocketLike {
  const ws = new NodeWebSocket(url);
  const like: OldWebSocketLike = {
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

async function trustbase(): Promise<unknown> {
  const res = await fetch(TRUSTBASE_URL);
  if (!res.ok) throw new Error(`trustbase fetch failed: HTTP ${String(res.status)} (${TRUSTBASE_URL})`);
  return res.json() as Promise<unknown>;
}

function createMockTransport(): TransportProvider {
  return {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
    description: 'Mock transport (assets ride wallet-api; this e2e sends to raw pubkeys)',
    setIdentity: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    sendMessage: vi.fn().mockResolvedValue('event-id'),
    onMessage: vi.fn().mockReturnValue(() => {}),
    sendTokenTransfer: vi.fn().mockResolvedValue('transfer-id'),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    sendPaymentRequest: vi.fn().mockResolvedValue('request-id'),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    sendPaymentRequestResponse: vi.fn().mockResolvedValue('response-id'),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    subscribeToBroadcast: vi.fn().mockReturnValue(() => {}),
    publishBroadcast: vi.fn().mockResolvedValue('broadcast-id'),
    onEvent: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue(null),
    resolveNametag: vi.fn().mockResolvedValue(null),
    publishIdentityBinding: vi.fn().mockResolvedValue(true),
    recoverNametag: vi.fn().mockResolvedValue(null),
  } as unknown as TransportProvider;
}

function createStagingOracle(trustBaseJson: unknown): OracleProvider {
  let apiKey = API_KEY ?? '';
  return {
    id: 'staging-oracle',
    name: 'Staging Oracle',
    type: 'aggregator' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    initialize: vi.fn().mockResolvedValue(undefined),
    getTrustBaseJson: () => trustBaseJson,
    getAggregatorUrl: () => AGGREGATOR_URL,
    getApiKey: () => apiKey,
    setApiKey: (key: string) => {
      apiKey = key;
    },
  } as unknown as OracleProvider;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function totalOf(pv2: PaymentsV2): bigint {
  return pv2
    .tokens({ coinId: HARNESS_COIN })
    .reduce((sum, token) => sum + BigInt(token.amount), 0n);
}

// ── one wallet, rebuildable on the SAME storage (resume rides re-init) ──────

let sphere: Sphere | null = null;
let dataDir = '';
let trustBaseJson: unknown;
const deviceId = `sphere-pv2-e2e-${Date.now().toString(36)}`;
const incoming: IncomingTransfer[] = [];

async function bootSphere(): Promise<Sphere> {
  const storage = new FileStorageProvider({ dataDir });
  const walletApi = new WalletApiClient({
    baseUrl: BASE_URL,
    network: NETWORK,
    deviceId,
    storage,
    webSocketFactory: nodeWsFactory,
  });
  const { sphere: built } = await Sphere.init({
    storage,
    transport: createMockTransport(),
    oracle: createStagingOracle(trustBaseJson),
    walletApi: walletApi as unknown as SphereWalletApiSession,
    paymentsV2: true,
    autoGenerate: true,
    network: NETWORK,
  });
  built.on('transfer:incoming', (transfer) => incoming.push(transfer));
  sphere = built;
  return built;
}

afterAll(async () => {
  aborted = true; // stop any loop the test timeout abandoned mid-flight
  if (sphere) await sphere.destroy().catch(() => undefined);
  if (dataDir !== '') fs.rmSync(dataDir, { recursive: true, force: true });
}, 240_000);

async function diagnose(label: string): Promise<string> {
  const pv2 = sphere?.paymentsV2;
  if (!pv2) return `${label}: no active vertical`;
  const history = await pv2.history({ limit: 50 }).catch(() => ({ entries: [] }));
  return JSON.stringify(
    {
      label,
      tokens: pv2.tokens().map((t) => ({ id: t.id, amount: t.amount, status: t.status })),
      history: history.entries.map((e) => ({ type: e.type, tokenId: e.tokenId, amount: e.amount })),
      incomingEvents: incoming.length,
    },
    null,
    2
  );
}

/** Mint retries are SAFE: a 429-refused submit executed nothing server-side. */
async function mintThroughThrottle(amount: bigint): Promise<string> {
  for (let attempt = 1; attempt <= MAX_MINT_ATTEMPTS && !aborted; attempt++) {
    const result = await sphere!.paymentsV2!.mint(HARNESS_COIN, amount);
    if (result.success) {
      logStep(`mint admitted on attempt ${attempt}: ${result.tokenId ?? ''}`);
      return result.tokenId!;
    }
    if (!/certification unconfirmed/i.test(result.error ?? '')) {
      throw new Error(`mint failed hard (attempt ${attempt}): ${result.error ?? 'unknown'}`);
    }
    if (attempt % 5 === 0) logStep(`mint still throttled after ${attempt} attempts`);
    await sleep(THROTTLE_WAIT_MS);
  }
  throw new Error(`mint never admitted by the gateway submit throttle\n${await diagnose('mint')}`);
}

/**
 * A keep-open send is NEVER re-issued (#631 — a fresh transferId double-pays).
 * Production convergence is the same-transferId resume at vertical start; this
 * drives exactly that: re-init Sphere on the same storage until the record
 * shows the settled outcome.
 */
async function sendConvergedThroughThrottle(
  recipient: string,
  amount: string,
  settled: () => Promise<boolean>
): Promise<TransferResult | null> {
  try {
    const result = await sphere!.paymentsV2!.send({ recipient, amount, coinId: HARNESS_COIN });
    logStep(`send admitted directly: ${result.id}`);
    return result;
  } catch (err) {
    if (!isPossiblyCommittedSendOutcome(err)) throw err;
    logStep(`send keep-open (${(err as Error).message.slice(0, 60)}…) — converging via resume`);
  }
  for (let cycle = 1; cycle <= MAX_RESUME_CYCLES && !aborted; cycle++) {
    await sleep(THROTTLE_WAIT_MS);
    await sphere!.destroy();
    await bootSphere(); // facade.start() resumes the open intent, same transferId
    for (let i = 0; i < 10 && !aborted; i++) {
      await sphere!.paymentsV2!.receive().catch(() => undefined);
      if (await settled()) {
        logStep(`send converged via resume on cycle ${cycle}`);
        return null;
      }
      await sleep(3_000);
    }
    if (cycle % 5 === 0) logStep(`resume still throttled after ${cycle} cycles`);
  }
  throw new Error(`send never converged via resume\n${await diagnose('send-resume')}`);
}

describe.runIf(RUN)('LIVE staging: Sphere paymentsV2 wiring (default transport path)', () => {
  it('init(paymentsV2) → mint → assets → exact self-send → receive drains → balance unchanged → clean destroy', async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-pv2-e2e-'));
    trustBaseJson = await trustbase();

    const wallet = await bootSphere();
    expect(() => wallet.payments).toThrowError(/disabled by paymentsV2/);
    expect(wallet.paymentsV2).not.toBeNull();
    logStep(`wallet up: ${wallet.identity!.chainPubkey.slice(0, 12)}… on ${NETWORK}`);

    // 1. Mint 100 HARNESS on-chain via the engine; the record shows it.
    const genesis = await mintThroughThrottle(100n);
    expect(genesis).toMatch(/^[0-9a-f]+$/);
    for (let i = 0; totalOf(sphere!.paymentsV2!) !== 100n && i < 30; i++) await sleep(2_000);
    expect(totalOf(sphere!.paymentsV2!)).toBe(100n);
    const assets = await sphere!.paymentsV2!.assets(HARNESS_COIN);
    expect(assets).toHaveLength(1);
    expect(assets[0]?.totalAmount).toBe('100');

    // 2. Exact self-send (whole-token direct spend to our own chain pubkey);
    //    the self-output rides our own mailbox back at a NEW state.
    const own = sphere!.identity!.chainPubkey;
    const settled = async (): Promise<boolean> => {
      if (totalOf(sphere!.paymentsV2!) !== 100n) return false;
      const { entries } = await sphere!.paymentsV2!.history({ limit: 100 });
      return entries.some((e) => e.type === 'RECEIVED' && e.tokenId === genesis.toLowerCase());
    };
    const direct = await sendConvergedThroughThrottle(own, '100', settled);
    if (direct !== null) {
      expect(['delivered', 'confirmed']).toContain(direct.status);
      expect(direct.tokenTransfers).toEqual([{ sourceTokenId: genesis, method: 'direct' }]);
    }

    // 3. Drain until the round-trip is settled (also covers the direct path).
    const deadline = Date.now() + 180_000;
    while (!(await settled())) {
      if (Date.now() > deadline) {
        throw new Error(`self-send did not settle\n${await diagnose('settle')}`);
      }
      await sphere!.paymentsV2!.receive().catch(() => undefined);
      await sleep(3_000);
    }
    expect(sphere!.paymentsV2!.tokens().map((t) => ({ id: t.id, amount: t.amount }))).toEqual([
      { id: genesis, amount: '100' },
    ]);
    expect(incoming.length).toBeGreaterThanOrEqual(1);
    expect(incoming[0]?.tokens[0]?.amount).toBe('100');

    // 4. Balance unchanged after a further drain window (no phantom, no double).
    await sleep(5_000);
    await sphere!.paymentsV2!.receive().catch(() => undefined);
    expect(totalOf(sphere!.paymentsV2!)).toBe(100n);
    const finalAssets = await sphere!.paymentsV2!.assets(HARNESS_COIN);
    expect(finalAssets[0]?.totalAmount).toBe('100');

    // 5. Clean teardown.
    await sphere!.destroy();
    expect(sphere!.paymentsV2).toBeNull();
    sphere = null;
    logStep('done: mint → self-send → drain → balance 100, clean destroy');
  }, 2_700_000);
});
