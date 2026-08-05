/**
 * tests/e2e/support/vertical.ts — the LIVE staging payments-v2 VERTICAL wallet
 * composition + its degraded-staging convergence helpers, extracted verbatim
 * from payments-v2-vertical.staging.e2e.test.ts so sibling suites (the
 * cross-version interop e2e) REUSE the exact composition the vertical e2e
 * certifies instead of copying it.
 *
 * Degraded-staging posture (observed: submits admitted, inclusion proofs late,
 * so the SDK correctly returns keep-open outcomes): a keep-open mint or send is
 * NEVER re-issued (F13 / #631 — a fresh id would double-pay). Convergence is
 * always the RECOVERY machinery: rebuild the vertical on the SAME kv+identity
 * and let start() replay journals / resume the SAME transferId, paced under a
 * generous deadline.
 */

import { hexToBytes, signMessage } from '../../../core/crypto';
import { isPossiblyCommittedSendOutcome } from '../../../core/errors';
import { deriveFieldEncryptionKey } from '../../../core/field-encryption';
import { completeSignMessage } from '../../../core/wallet-api-protocol';
import {
  authedWireClient,
  requestMemoCodec,
  type PaymentsV2WireClient,
} from '../../../core/payments-v2-wiring';
import { createWalletApiHttp } from '../../../impl/wallet-api-v2/http';
import { WalletApiV2Client } from '../../../impl/wallet-api-v2/client';
import { JwtGenerationCell, WalletApiSession } from '../../../impl/wallet-api-v2/session';
import { WalletApiStoragePort } from '../../../impl/wallet-api-v2/storage';
import { WalletApiDeliveryPort } from '../../../impl/wallet-api-v2/mailbox';
import { WalletApiSplitCheckpointStore } from '../../../impl/wallet-api-v2/checkpoints';
import { PaymentsFacade } from '../../../modules/payments-v2/PaymentsFacade';
import type { DeliveryPort, InventoryItem } from '../../../modules/payments-v2/ports';
import type { ScopedKV } from '../../../modules/payments-v2/stores';
import { createMachineStores } from '../../../modules/payments-v2/machine/journal';
import { createSphereTokenEngine } from '../../../token-engine/factory';
import type { ITokenEngine } from '../../../token-engine/engine';
import type { HistoryEntry } from '../../../modules/payments-v2/api';
import type { TransferResult } from '../../../types';
import { HARNESS_COIN, randomIdentity } from '../../harness/support/stack';
import { registryStub } from '../../unit/payments-v2/support';
import {
  AGGREGATOR_URL,
  BASE_URL,
  memoryKV,
  NETWORK,
  nodeWsFactory,
  STAGING_API_KEY as API_KEY,
  trustbase,
} from './staging';

// Replay-convergence pacing (observed 2026-08-04: the shared staging submit key
// can refuse 9+ paced attempts over 6 min): fast cadence — a cycle is ~30 s —
// under LARGE budgets; every cycle is the same idempotent replay, never a re-issue.
export const PACE_MS = 10_000;
export const POLL_MS = 3_000;
export const CYCLE_WINDOW_MS = 15_000;
export const MINT_CONVERGE_MS = 1_200_000;
export const SEND_CONVERGE_MS = 900_000;
let aborted = false; // set by shutdownVerticalWallets so an abandoned loop exits

export function logStep(step: string): void {
  console.log(`[pv2-e2e ${new Date().toISOString()}] ${step}`);
}

// ── shared plumbing ──────────────────────────────────────────────────────────

// Minimal RegistryReader: answers the harness coin; decimals 0 (integer amounts).
const registry = registryStub({
  getSymbol: (coinId: string) => (coinId === HARNESS_COIN ? 'HARN' : coinId.slice(0, 8)),
  getName: (coinId: string) => (coinId === HARNESS_COIN ? 'Harness Coin' : 'Unknown'),
});

// The server /v1/balances endpoint stays a TEST observation surface (serverTotal)
// even though the StoragePort no longer exposes it (assets() aggregates the mirror).
export type AuthedClient = PaymentsV2WireClient & Pick<WalletApiV2Client, 'balances'>;

// The PRODUCTION authed wrapper (suites outlive the 900 s JWT TTL) plus the
// test-only balances observation surface.
function authedClient(session: WalletApiSession, client: WalletApiV2Client): AuthedClient {
  return {
    ...authedWireClient(session, client),
    balances: () => session.withAuth(() => client.balances()),
  };
}

export interface VIdentity {
  privateKey: string;
  chainPubkey: string;
}

export interface VWallet {
  facade: PaymentsFacade;
  session: WalletApiSession;
  api: AuthedClient;
  kv: ScopedKV;
  identity: VIdentity;
  engine: ITokenEngine;
  events: { event: string; payload: unknown }[];
  tag: string;
}

const openWallets: VWallet[] = [];

export interface MakeOptions {
  identity?: VIdentity;
  kv?: ScopedKV;
  wrapDelivery?: (inner: DeliveryPort) => DeliveryPort;
}

/** The whole vertical, composed for real: session → authed client → ports → engine → facade. */
export async function makeVerticalWallet(tag: string, options: MakeOptions = {}): Promise<VWallet> {
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
      // Surface refusal/attention states in the run log (e.g. mint:unresolved).
      if (event === 'transfer:attention') logStep(`[${tag}] attention: ${JSON.stringify(payload)}`);
    },
    // Raw-pubkey identifiers only (these suites never use nametags); pinned to the session network.
    resolveRecipient: async (identifier) =>
      /^0[23][0-9a-f]{64}$/.test(identifier) ? { chainPubkey: identifier, network: NETWORK } : null,
    signComplete: async (transferId) => signMessage(identity.privateKey, completeSignMessage(transferId)),
    fieldKey,
    network: NETWORK,
    ownPubkey: identity.chainPubkey,
    requestMemo: requestMemoCodec(identity.privateKey),
  });
  await session.ensureAuthenticated();
  await facade.start();
  const wallet: VWallet = { facade, session, api, kv, identity, engine, events, tag };
  openWallets.push(wallet);
  return wallet;
}

/** afterAll teardown: abort any abandoned convergence loop, stop every wallet. */
export async function shutdownVerticalWallets(): Promise<void> {
  aborted = true;
  for (const w of openWallets.splice(0)) {
    await w.facade.stop().catch(() => undefined);
  }
}

// ── observation helpers (state-based; never trust a single drain's return) ──

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function localTotal(w: VWallet): bigint {
  return w.facade
    .tokens({ coinId: HARNESS_COIN })
    .reduce((sum, token) => sum + BigInt(token.amount), 0n);
}

export async function serverTotal(w: VWallet): Promise<bigint> {
  const balances = await w.api.balances();
  const row = balances.find((b) => b.coinId === HARNESS_COIN);
  return row === undefined ? 0n : BigInt(row.total);
}

export async function activeRows(w: VWallet): Promise<InventoryItem[]> {
  const rows: InventoryItem[] = [];
  let page = await w.api.listInventory();
  for (;;) {
    rows.push(...page.items.filter((item) => item.status === 'active'));
    if (!page.more) return rows;
    page = await w.api.listInventory(page.cursor);
  }
}

export async function historyEntries(w: VWallet): Promise<HistoryEntry[]> {
  return (await w.facade.history({ limit: 100 })).entries;
}

export async function receivedLegs(w: VWallet, tokenId: string): Promise<HistoryEntry[]> {
  return (await historyEntries(w)).filter(
    (e) => e.type === 'RECEIVED' && e.tokenId === tokenId.toLowerCase()
  );
}

export async function openIntentIds(w: VWallet): Promise<string[]> {
  return (await w.api.listIntents('open')).map((i) => i.transferId);
}

export async function diagnose(label: string, w: VWallet): Promise<string> {
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
export async function waitFor(
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
export async function drainUntil(
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

// ── keep-open convergence (the ONLY answer to a degraded aggregator) ─────────

/**
 * Rebuild the SAME wallet (kv + identity + tag) so start() replays the mint /
 * delivery journals and resumes open intents under their ORIGINAL transferIds
 * (F13 / #631 — never a re-issued mint() or send()), then poll `settled` until
 * the money state converges. Paced: staging finalization is slow and contended.
 */
export async function convergeByReplay(
  wallet: VWallet,
  settled: (w: VWallet) => Promise<boolean> | boolean,
  deadlineMs: number,
  label: string,
  rebuildOptions: Omit<MakeOptions, 'identity' | 'kv'> = {}
): Promise<VWallet> {
  const deadline = Date.now() + deadlineMs;
  let current = wallet;
  for (let cycle = 1; !aborted; cycle++) {
    await sleep(PACE_MS);
    await current.facade.stop().catch(() => undefined);
    current = await makeVerticalWallet(current.tag, {
      ...rebuildOptions,
      identity: current.identity,
      kv: current.kv,
    });
    const windowEnd = Math.min(Date.now() + CYCLE_WINDOW_MS, deadline);
    for (;;) {
      let ok = false;
      try {
        ok = await settled(current);
      } catch {
        // transient observation failure — keep polling
      }
      if (ok) {
        logStep(`${label}: converged via replay on cycle ${String(cycle)}`);
        return current;
      }
      if (Date.now() >= windowEnd || aborted) break;
      await sleep(POLL_MS);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${label}: no convergence within ${String(deadlineMs)} ms\n${await diagnose(label, current)}`
      );
    }
    if (cycle % 5 === 0) logStep(`${label}: still degraded after ${String(cycle)} replay cycles`);
  }
  throw new Error(`${label}: aborted before convergence`);
}

const MINT_VALIDATION_ERROR = 'coinId must be even-length lowercase hex and amount positive';

/**
 * F13 posture: mint() is called exactly ONCE. Any journaled failure (keep-open
 * certification, late finalize) converges by replaying the SAME mintId — a
 * re-call would risk a SECOND token. Only the pre-journal validation reject
 * (nothing submitted, nothing journaled) fails hard.
 */
export async function mintConverged(
  wallet: VWallet,
  amount: bigint,
  label: string,
  rebuildOptions: Omit<MakeOptions, 'identity' | 'kv'> = {}
): Promise<{ wallet: VWallet; tokenId: string }> {
  const before = await serverTotal(wallet);
  const result = await wallet.facade.mint(HARNESS_COIN, amount);
  if (result.success) {
    logStep(`${label}: admitted directly (${result.tokenId ?? ''})`);
    return { wallet, tokenId: must(result.tokenId, 'mint tokenId') };
  }
  if (result.error === MINT_VALIDATION_ERROR) throw new Error(`${label}: ${result.error}`);
  logStep(`${label}: keep-open (${(result.error ?? 'unknown').slice(0, 90)}) — converging via journal replay, no re-call`);
  const stores = createMachineStores(wallet.kv);
  const converged = await convergeByReplay(
    wallet,
    async (w) =>
      (await stores.mintJournal.list()).length === 0 && (await serverTotal(w)) === before + amount,
    MINT_CONVERGE_MS,
    label,
    rebuildOptions
  );
  const rows = await activeRows(converged);
  if (rows.length !== 1) {
    throw new Error(`${label}: expected exactly ONE active row after replay convergence, saw ${String(rows.length)}`);
  }
  return { wallet: converged, tokenId: must(rows[0], 'converged mint row').tokenId };
}

/**
 * #631 posture: a keep-open send outcome is NEVER re-issued — the rebuilt
 * instance's start() gate resumes the SAME transferId. A resolved-but-pending
 * delivery converges the same way (journal replay of the SAME certified blob).
 */
export async function sendConverged(
  wallet: VWallet,
  request: { recipient: string; amount: string; coinId: string },
  settled: (w: VWallet) => Promise<boolean> | boolean,
  label: string
): Promise<{ wallet: VWallet; result: TransferResult | null; transferId: string }> {
  let result: TransferResult;
  try {
    result = await wallet.facade.send(request);
  } catch (err) {
    if (!isPossiblyCommittedSendOutcome(err)) throw err;
    const transferId = must((err as { transferId?: string }).transferId, 'keep-open transferId');
    logStep(`${label}: keep-open ${transferId} (${(err as Error).message.slice(0, 80)}…) — converging via same-transferId resume`);
    const converged = await convergeByReplay(wallet, settled, SEND_CONVERGE_MS, label);
    return { wallet: converged, result: null, transferId };
  }
  if (result.deliveryPending === true) {
    logStep(`${label}: certified but delivery pending — converging via delivery-journal replay`);
    const converged = await convergeByReplay(wallet, settled, SEND_CONVERGE_MS, label);
    return { wallet: converged, result, transferId: result.id };
  }
  logStep(`${label}: admitted directly (${result.id})`);
  return { wallet, result, transferId: result.id };
}

export function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} missing — a prior test did not complete`);
  return value;
}
