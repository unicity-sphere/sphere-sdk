/**
 * REPRO — BLAST-RADIUS map of the self-send money-loss bug (sdk 0.11.14).
 *
 * The confirmed bug (tests/integration/self-send-multitoken.repro.test.ts): a
 * MULTI-token self-send (6 from [5,51,2]) loses the whole-token DIRECT leg. The
 * direct leg reuses the SAME genesis tokenId (new state), is deposited to the
 * wallet's OWN mailbox, the wallet's own pump claims it back REACTIVATING the
 * server row at the new state, and then a state-blind, evidence-free
 * pushRemovals (WalletApiTokenStorageProvider.ts:698-707; the stateHash is
 * dropped at :636) re-kills the just-reactivated row under a fresh transferId.
 * recoverRemoved is then blocked by the tokenId-keyed knownSpends (:541,:706).
 *
 * This file maps which OTHER self-send shapes lose funds, reusing the exact
 * multitoken harness (FakeWalletApi, custody 'inventory', transport.resolve
 * pinned to SELF, the #70 server-noop shim). Variants:
 *
 *   V1  — single-token WHOLE self-send (hold [10], send 10, pure direct, NO split)
 *   V2  — partial single-token self-send (hold [10], send 4 → split 10→4+6)
 *   V3  — repeated self-send round-trip (a self-send, settle, then a SECOND one)
 *
 * For each: assert (a) balance conserved and (b) no inventory row ends
 * removed/unevidenced. A FAILING assertion == the loss reproduced.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createPaymentsModule,
  type PaymentsModule,
  type PaymentsModuleDependencies,
} from '../../modules/payments/PaymentsModule';
import type { FullIdentity } from '../../types';
import type { TransportProvider } from '../../transport';
import type { OracleProvider } from '../../oracle';
import type { StorageProvider } from '../../storage';
import {
  FakeTokenEngine,
  decodeFakeTokenAssets,
  decodeFakeTokenId,
} from '../unit/token-engine/FakeTokenEngine';
import { FakeWalletApi } from '../support/fake-wallet-api';
import { MemoryKeyValueStore, testIdentity } from '../support/wallet-api-test-helpers';
import { WalletApiClient, type ApplyDeltaRequest } from '../../wallet-api';
import { WalletApiMailboxProvider, WalletApiTokenStorageProvider } from '../../impl/shared/wallet-api';
import { encodeTokenBlob } from '../../token-engine/token-blob';
import { hexToBytes } from '../../core/crypto';

const UCT = '11'.repeat(32);
const SELF = testIdentity(21);

function fullIdentity(id: { privateKey: string; chainPubkey: string }): FullIdentity {
  return {
    chainPubkey: id.chainPubkey,
    privateKey: id.privateKey,
    directAddress: `DIRECT://${id.chainPubkey.slice(0, 12)}`,
    transportPubkey: id.chainPubkey.slice(2),
  };
}

function mockStorage(): StorageProvider {
  const s = new Map<string, string>();
  return {
    id: 's', name: 's', type: 'local', connect: vi.fn(), disconnect: vi.fn(),
    isConnected: () => true, getStatus: () => 'connected', setIdentity: vi.fn(),
    get: vi.fn(async (k: string) => s.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { s.set(k, v); }),
    remove: vi.fn(async (k: string) => { s.delete(k); }),
    has: vi.fn(async (k: string) => s.has(k)),
    keys: vi.fn(async () => [...s.keys()]),
    clear: vi.fn(async () => { s.clear(); }),
  } as unknown as StorageProvider;
}

/** Transport that resolves EVERY recipient to this wallet's own identity — the self-send. */
function selfTransport(): TransportProvider {
  return {
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue({
      chainPubkey: SELF.chainPubkey,
      transportPubkey: SELF.chainPubkey.slice(2),
      directAddress: `DIRECT://${SELF.chainPubkey.slice(0, 12)}`,
      nametag: 'me',
    }),
    resolveTransportPubkeyInfo: vi.fn().mockResolvedValue(null),
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(), isConnected: () => true,
  } as unknown as TransportProvider;
}

function mockOracle(): OracleProvider {
  return {
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    isDevMode: () => false,
  } as unknown as OracleProvider;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

interface Wallet {
  module: PaymentsModule;
  engine: FakeTokenEngine;
  client: WalletApiClient;
}

/** FULL wallet-api preset (custody 'inventory') — the sphere app's composition. */
function makeSelfWallet(baseUrl: string, network: string, deviceId: string): Wallet {
  const identity = fullIdentity(SELF);
  const kv = new MemoryKeyValueStore();
  const client = new WalletApiClient({ baseUrl, network, deviceId, storage: kv });
  const tokenStorage = new WalletApiTokenStorageProvider({ client, stateStore: kv });
  tokenStorage.setIdentity(identity);
  const delivery = new WalletApiMailboxProvider({ client, custody: 'inventory', stateStore: kv });
  const engine = new FakeTokenEngine({ chainPubkey: hexToBytes(SELF.chainPubkey) });
  const deps: PaymentsModuleDependencies = {
    identity,
    storage: mockStorage(),
    tokenStorageProviders: new Map([[tokenStorage.id, tokenStorage]]),
    transport: selfTransport(),
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

async function seedServerToken(fake: FakeWalletApi, wallet: Wallet, amount: bigint): Promise<string> {
  const minted = await wallet.engine.mint({
    recipientPubkey: wallet.engine.getIdentity().chainPubkey,
    value: { assets: [{ coinId: UCT, amount }] },
  });
  const bytes = encodeTokenBlob(wallet.engine.encodeToken(minted));
  const tokenId = wallet.engine.tokenId(minted);
  fake.seedInventory(SELF.chainPubkey, [{ tokenId, assets: [{ coinId: UCT, amount }], blob: bytes }]);
  return tokenId;
}

/**
 * Shim the wallet-api#70 (d3c68c9) server rule onto the fake, which predates
 * it: an inventory apply's spend of a token is a NOOP when that token has a
 * mailbox deposit under the SAME transferId that was already claimed into
 * inventory (the row sits at the deposit's final state). Optionally also drains
 * the mailbox ONCE right before the send's own apply — reproducing the §9
 * wake's incoming pump claiming the direct-leg deposit DURING the still-running
 * send (the multitoken repro pins the identical ordering inside engine.split;
 * a whole self-send has no split to hook, so we hook the apply instead).
 */
function shimServer(
  fake: FakeWalletApi,
  wallet: Wallet,
  opts: { drainBeforeFirstSpendApply?: boolean } = {}
): void {
  const orig = wallet.client.applyInventoryDelta.bind(wallet.client);
  let drained = false;
  wallet.client.applyInventoryDelta = async (req: ApplyDeltaRequest) => {
    // One-shot pre-apply drain: only before the send's OWN apply (it carries
    // spent tokens); pushRemovals/pushAdditions applies carry no spent+deposit.
    if (opts.drainBeforeFirstSpendApply && !drained && req.spent.length > 0) {
      drained = true; // set BEFORE receive() so a reentrant apply cannot re-drain
      const { transfers } = await wallet.module.receive();
      console.log(
        `[wake-before-apply] pump stored ${transfers.length}; ` +
        `mailbox=${JSON.stringify(fake.listMailboxEntries(SELF.chainPubkey).map((e) => ({ token: e.tokenId.slice(0, 6), status: e.status })))}`
      );
    }
    const spent = req.spent.filter((tokenId) => {
      const entry = fake
        .listMailboxEntries(SELF.chainPubkey)
        .find((e) => e.transferId === req.transferId && e.tokenId === tokenId);
      if (!entry) return true; // no same-transfer deposit → genuine spend
      const full = fake.getMailboxEntry(SELF.chainPubkey, entry.entryId);
      const claimedIntoInventory = full?.status === 'claimed' && full.intoInventory === true;
      if (claimedIntoInventory) {
        console.log(`[#70 shim] apply(${req.transferId.slice(0, 8)}…): spend of ${tokenId.slice(0, 6)}… is a noop (claimed same-transfer deposit)`);
      }
      return !claimedIntoInventory;
    });
    if (spent.length > 0 || req.added.length > 0) {
      console.log(
        `[apply] transferId=${req.transferId.slice(0, 8)}… spent=[${spent.map((s) => `…${s.slice(-4)}`).join(',')}] added=[${req.added.map((a) => `…${a.tokenId.slice(-4)}`).join(',')}]`
      );
    }
    return orig({ ...req, spent });
  };
}

/** Pin the §9 wake into the middle of engine.split (like the multitoken repro). */
function drainDuringSplit(wallet: Wallet): void {
  const origSplit = wallet.engine.split.bind(wallet.engine);
  vi.spyOn(wallet.engine, 'split').mockImplementation(async (args, options) => {
    const { transfers } = await wallet.module.receive();
    console.log(`[wake-during-split] pump stored ${transfers.length} transfer(s)`);
    return origSplit(args, options);
  });
}

function sumHistory(fake: FakeWalletApi, type: 'SENT' | 'RECEIVED'): bigint {
  return fake
    .getHistoryRecords(SELF.chainPubkey)
    .filter((r) => r.type === type)
    .flatMap((r) => (r.assets as { coinId: string; amount: string }[] | undefined) ?? [])
    .filter((a) => a.coinId === UCT)
    .reduce((s, a) => s + BigInt(a.amount), 0n);
}

async function balances(wallet: Wallet): Promise<{ coinId: string; total: bigint; tokenCount: number }[]> {
  return wallet.client.getBalances();
}

function localTotal(wallet: Wallet): bigint {
  return wallet.module
    .getTokens()
    .filter((t) => t.coinId === UCT)
    .reduce((s, t) => s + BigInt(t.amount || '0'), 0n);
}

/** Every server row's status/removal — the inventory-truth we assert against. */
function serverRows(fake: FakeWalletApi, tokenIds: string[]): Record<string, { status: string; removal?: string } | null> {
  const out: Record<string, { status: string; removal?: string } | null> = {};
  for (const id of tokenIds) out[id.slice(0, 8)] = fake.getRow(SELF.chainPubkey, id);
  return out;
}

// =============================================================================
// V1 — single-token WHOLE self-send (pure direct transfer, NO split)
// =============================================================================

describe('V1 — WHOLE single-token self-send (hold [10], send 10; pure direct, no split)', () => {
  async function setup(deviceId: string, drainBeforeFirstSpendApply: boolean) {
    const fake = new FakeWalletApi({ decodeAssets: decodeFakeTokenAssets, decodeTokenId: decodeFakeTokenId });
    const baseUrl = await fake.start();
    cleanups.push(() => fake.stop());
    const wallet = makeSelfWallet(baseUrl, fake.network, deviceId);
    const t10 = await seedServerToken(fake, wallet, 10n);
    await wallet.module.load();
    expect(await balances(wallet)).toEqual([{ coinId: UCT, total: 10n, tokenCount: 1 }]);
    shimServer(fake, wallet, { drainBeforeFirstSpendApply });

    const sendResult = await wallet.module.send({ recipient: '@me', amount: '10', coinId: UCT });
    expect(sendResult.status).toBe('completed');

    // LOAD-BEARING plan check: pure whole-token direct, NO split.
    const plan = sendResult.tokenTransfers.map((t) => ({ method: t.method, sourceTokenId: t.sourceTokenId }));
    console.log('[V1 plan]', JSON.stringify(plan));
    expect(plan).toEqual([{ method: 'direct', sourceTokenId: `v2_${t10}` }]);

    // Row status the instant send() returns (before any post-send drain): tells
    // us whether the kill landed DURING the send (natural mid-send wake) or only
    // once the post-send drain reactivates + re-kills the row.
    console.log('[V1 right after send()] row =', JSON.stringify(fake.getRow(SELF.chainPubkey, t10)),
      'mailbox =', JSON.stringify(fake.listMailboxEntries(SELF.chainPubkey).map((e) => ({ t: e.tokenId.slice(0, 6), s: e.status }))));

    // Post-send settle: drain the direct-leg deposit back into inventory.
    await wallet.module.receive();
    console.log('[V1 after receive#1] row =', JSON.stringify(fake.getRow(SELF.chainPubkey, t10)));
    await wallet.module.receive();

    console.log('[V1] server rows =', JSON.stringify(serverRows(fake, [t10])));
    console.log('[V1] balances =', JSON.stringify(await balances(wallet), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    console.log('[V1] localTotal =', localTotal(wallet).toString());
    console.log(`[V1] history SENT=${sumHistory(fake, 'SENT')} RECEIVED=${sumHistory(fake, 'RECEIVED')}`);
    return { fake, wallet, t10 };
  }

  // NB: empirically the natural §9 wake pump claims the direct-leg deposit
  // DURING the send (the row is already removed/unevidenced the instant send()
  // returns — see the "[V1 right after send()]" log), so this needs NO
  // test-imposed drain to reproduce. That is the field condition.
  it('V1a (natural §9 wake — no test-imposed drain): funds conserved, row not removed/unevidenced', async () => {
    const { fake, wallet, t10 } = await setup('v1a-natural', false);
    const row = fake.getRow(SELF.chainPubkey, t10);
    expect(row).not.toMatchObject({ status: 'removed', removal: 'unevidenced' });
    expect(await balances(wallet)).toEqual([{ coinId: UCT, total: 10n, tokenCount: expect.any(Number) }]);
    expect(localTotal(wallet)).toBe(10n);
  });

  it('V1b (§9 wake claims DURING the send — mid-send ordering): funds conserved, row not removed/unevidenced', async () => {
    const { fake, wallet, t10 } = await setup('v1b-midsend', true);
    const row = fake.getRow(SELF.chainPubkey, t10);
    expect(row).not.toMatchObject({ status: 'removed', removal: 'unevidenced' });
    expect(await balances(wallet)).toEqual([{ coinId: UCT, total: 10n, tokenCount: expect.any(Number) }]);
    expect(localTotal(wallet)).toBe(10n);
  });
});

// =============================================================================
// V2 — partial single-token self-send (split 10 → 4 sent + 6 change; NO direct)
// =============================================================================

describe('V2 — PARTIAL single-token self-send (hold [10], send 4 → split 10→4+6; no direct leg)', () => {
  it('funds conserved, no row removed/unevidenced, and the +4 split leg IS recorded in history', async () => {
    const fake = new FakeWalletApi({ decodeAssets: decodeFakeTokenAssets, decodeTokenId: decodeFakeTokenId });
    const baseUrl = await fake.start();
    cleanups.push(() => fake.stop());
    const wallet = makeSelfWallet(baseUrl, fake.network, 'v2-partial');
    const t10 = await seedServerToken(fake, wallet, 10n);
    await wallet.module.load();
    expect(await balances(wallet)).toEqual([{ coinId: UCT, total: 10n, tokenCount: 1 }]);
    shimServer(fake, wallet);
    drainDuringSplit(wallet); // §9 wake pump runs during the on-chain split (faithful ordering)

    const sendResult = await wallet.module.send({ recipient: '@me', amount: '4', coinId: UCT });
    expect(sendResult.status).toBe('completed');

    // LOAD-BEARING plan check: a PURE split (no whole-token direct leg).
    const plan = sendResult.tokenTransfers.map((t) => ({ method: t.method, sourceTokenId: t.sourceTokenId }));
    console.log('[V2 plan]', JSON.stringify(plan));
    expect(plan).toEqual([{ method: 'split', sourceTokenId: `v2_${t10}` }]);

    // Post-send settle: claim the +4 split-output leg from own mailbox.
    await wallet.module.receive();
    await wallet.module.receive();

    const bals = await balances(wallet);
    console.log('[V2] server row(source) =', JSON.stringify(fake.getRow(SELF.chainPubkey, t10)));
    console.log('[V2] balances =', JSON.stringify(bals, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    console.log('[V2] localTotal =', localTotal(wallet).toString());
    const received = sumHistory(fake, 'RECEIVED');
    console.log(`[V2] history SENT=${sumHistory(fake, 'SENT')} RECEIVED=${received}`);

    // No server row ends removed/unevidenced; funds conserved.
    expect(fake.getRow(SELF.chainPubkey, t10)).not.toMatchObject({ status: 'removed', removal: 'unevidenced' });
    expect(await balances(wallet)).toEqual([{ coinId: UCT, total: 10n, tokenCount: expect.any(Number) }]);
    expect(localTotal(wallet)).toBe(10n);
    // The +4 self-claim must be recorded (fresh split-output tokenId — not swallowed as a genesis-id duplicate).
    expect(received).toBe(4n);
  });
});

// =============================================================================
// V3 — repeated self-send round-trip: a multi-token self-send, settle/drain,
// then a SECOND self-send reusing the now-current (round-tripped, fresh-id)
// tokens. Does the second send lose its whole-token direct legs too?
// =============================================================================

/** Genesis id of every ACTIVE local token → its server row status. */
function localRows(fake: FakeWalletApi, wallet: Wallet): Record<string, { status: string; removal?: string } | null> {
  const out: Record<string, { status: string; removal?: string } | null> = {};
  for (const t of wallet.module.getTokens()) {
    const genesis = t.id.startsWith('v2_') ? t.id.slice(3) : t.id;
    out[`${genesis.slice(0, 6)}(${t.amount})`] = fake.getRow(SELF.chainPubkey, genesis);
  }
  return out;
}

describe('V3 — REPEATED self-send (multi-token self-send, settle, then self-send the survivors)', () => {
  it('a second self-send of the round-tripped tokens loses its whole-direct legs too (compounding loss)', async () => {
    const fake = new FakeWalletApi({ decodeAssets: decodeFakeTokenAssets, decodeTokenId: decodeFakeTokenId });
    const baseUrl = await fake.start();
    cleanups.push(() => fake.stop());
    const wallet = makeSelfWallet(baseUrl, fake.network, 'v3-repeated');
    await seedServerToken(fake, wallet, 5n);
    await seedServerToken(fake, wallet, 51n);
    await seedServerToken(fake, wallet, 2n);
    await wallet.module.load();
    expect(await balances(wallet)).toEqual([{ coinId: UCT, total: 58n, tokenCount: 3 }]);
    shimServer(fake, wallet);
    drainDuringSplit(wallet); // faithful §9-wake ordering, as in the multitoken repro

    // ── First self-send: 6 from [5,51,2] (direct 2 + split 5→4+1) — the known loss ─
    const first = await wallet.module.send({ recipient: '@me', amount: '6', coinId: UCT });
    expect(first.status).toBe('completed');
    console.log('[V3 first plan]', JSON.stringify(first.tokenTransfers.map((t) => ({ method: t.method }))));
    await wallet.module.receive();
    await wallet.module.receive();
    const afterFirst = await balances(wallet);
    console.log('[V3 after first] balances =', JSON.stringify(afterFirst, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      'localTotal =', localTotal(wallet).toString(), 'rows =', JSON.stringify(localRows(fake, wallet)));

    // ── Second self-send: 4 from the survivors — reuses the round-tripped +4
    // self-claim (a fresh-id token the FIRST send delivered into inventory) as a
    // WHOLE-DIRECT leg. Single leg → deterministic, like V1. ─────────────────────
    const second = await wallet.module.send({ recipient: '@me', amount: '4', coinId: UCT });
    expect(second.status).toBe('completed');
    console.log('[V3 second plan]', JSON.stringify(second.tokenTransfers.map((t) => ({ method: t.method, id: t.sourceTokenId.slice(0, 10) }))));
    await wallet.module.receive();
    await wallet.module.receive();

    const afterSecond = await balances(wallet);
    console.log('[V3 after second] balances =', JSON.stringify(afterSecond, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      'localTotal =', localTotal(wallet).toString(), 'rows =', JSON.stringify(localRows(fake, wallet)));
    console.log(`[V3] history SENT=${sumHistory(fake, 'SENT')} RECEIVED=${sumHistory(fake, 'RECEIVED')}`);

    // The wallet only ever moved money to ITSELF: the balance must still be 58.
    expect(afterSecond).toEqual([{ coinId: UCT, total: 58n, tokenCount: expect.any(Number) }]);
    expect(localTotal(wallet)).toBe(58n);
  });
});
