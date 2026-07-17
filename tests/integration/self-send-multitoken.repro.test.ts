/**
 * REPRO — multi-token SELF-send over the wallet-api mailbox rail (field report,
 * sphere app @ sdk 0.11.14/0.11.15-dev.1):
 *
 *   Wallet holds 58 UCT as three tokens [5, 51, 2]. User sends 6 UCT to their
 *   OWN nametag. Coin selection (smallest-first) plans:
 *     - DIRECT-transfer the 2-token  (SAME genesis tokenId, new state), and
 *     - SPLIT the 5-token into 4 (sent, fresh tokenId) + 1 change.
 *   Reported: history shows only −6 / +4 (the +2 leg is missing, net −2);
 *   colleagues additionally report ACTUAL balance loss.
 *
 * Mechanism exercised here (deterministically):
 *   A self-send deposits into the wallet's OWN mailbox. The server fires a §9
 *   wake at deposit time, so in production the wallet's own incoming pump runs
 *   DURING the still-executing send (the on-chain split takes seconds). This
 *   test simulates that wake by draining the mailbox (module.receive()) right
 *   before the engine.split step — i.e. after the direct leg's deposit but
 *   before the send's applyDelta/removeToken bookkeeping.
 *
 *   - HISTORY loss: handleV2Transfer dedups incoming tokens by genesis id only
 *     (PaymentsModule.ts ~5218: `this.tokens.has('v2_<id>')`) — the old state
 *     of the 2-token is still in the map (status 'transferring'), so the
 *     incoming NEW state is classified 'duplicate', CLAIMED, seen-set forever:
 *     no RECEIVED +2 history, ever.
 *   - FUND loss: the claim (intoInventory:true) reactivates the server row for
 *     the 2-token at its NEW state. The real wallet-api (post-#70, d3c68c9)
 *     then treats the send's own applyDelta spend of that token as a noop
 *     (row is at the same-transfer deposit's final state) — this test shims
 *     that server rule onto the fake, which predates #70 and would otherwise
 *     tombstone the row one step earlier (same net loss, different line).
 *     But removeToken() then tombstones the token locally (state-blind), and
 *     the NEXT provider save's pushRemovals (WalletApiTokenStorageProvider.ts
 *     ~698-707) pushes spent=[tokenId] — tokenId-matched, no state check —
 *     under a FRESH transferId with zero deposit evidence, flipping the
 *     just-claimed ACTIVE row to removed/unevidenced. Balance drops by 2 and
 *     addKnownSpends() blocks recoverRemoved() from ever resurrecting it.
 *
 * Both tests are EXPECTED TO FAIL on the current code — they are bug repros.
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
 * inventory (the row sits at the deposit's final state). Without this shim the
 * fake tombstones the claim-reactivated row at the send's own applyDelta —
 * same 2-UCT loss, just one step earlier than the real backend.
 */
function shimServerNoopForClaimedSameTransferSpends(fake: FakeWalletApi, wallet: Wallet): void {
  const orig = wallet.client.applyInventoryDelta.bind(wallet.client);
  wallet.client.applyInventoryDelta = async (req: ApplyDeltaRequest) => {
    const spent = req.spent.filter((tokenId) => {
      const entry = fake
        .listMailboxEntries(SELF.chainPubkey)
        .find((e) => e.transferId === req.transferId && e.tokenId === tokenId);
      if (!entry) return true; // no same-transfer deposit → genuine spend
      const full = fake.getMailboxEntry(SELF.chainPubkey, entry.entryId);
      const claimedIntoInventory = full?.status === 'claimed' && full.intoInventory === true;
      if (claimedIntoInventory) {
        console.log(`[#70 shim] apply(${req.transferId.slice(0, 8)}…): spend of ${tokenId.slice(0, 8)}… is a noop (claimed same-transfer deposit)`);
      }
      return !claimedIntoInventory;
    });
    // Trace every apply so the row-killing call is visible in the output.
    if (spent.length > 0 || req.added.length > 0) {
      console.log(
        `[apply] transferId=${req.transferId.slice(0, 8)}… spent=[${spent.map((s) => `…${s.slice(-4)}`).join(',')}] added=[${req.added.map((a) => `…${a.tokenId.slice(-4)}`).join(',')}]`
      );
    }
    return orig({ ...req, spent });
  };
}

interface ScenarioResult {
  fake: FakeWalletApi;
  wallet: Wallet;
  tokenIds: { t5: string; t51: string; t2: string };
  sendResult: Awaited<ReturnType<PaymentsModule['send']>>;
}

async function runSelfSendScenario(deviceId: string): Promise<ScenarioResult> {
  const fake = new FakeWalletApi({ decodeAssets: decodeFakeTokenAssets, decodeTokenId: decodeFakeTokenId });
  const baseUrl = await fake.start();
  cleanups.push(() => fake.stop());

  const wallet = makeSelfWallet(baseUrl, fake.network, deviceId);
  const t5 = await seedServerToken(fake, wallet, 5n);
  const t51 = await seedServerToken(fake, wallet, 51n);
  const t2 = await seedServerToken(fake, wallet, 2n);
  await wallet.module.load();

  // Sanity: 58 across three tokens before the send.
  expect(await wallet.client.getBalances()).toEqual([{ coinId: UCT, total: 58n, tokenCount: 3 }]);

  shimServerNoopForClaimedSameTransferSpends(fake, wallet);

  // Pin the §9 wake ordering: the direct leg's mailbox deposit (to SELF) has
  // already landed when engine.split starts; the server wakes this same
  // wallet's pump immediately and the pump runs during the multi-second
  // on-chain split. NOTE: this race also fires NATURALLY in this harness —
  // PaymentsModule.initialize installs the wake subscription
  // (PaymentsModule.ts ~1354-1360 → handleWake 'mailbox' →
  // pumpIncomingDeliveries), and the fake's WS wake lands during the send's
  // own awaits (verified: with SELF_SEND_REPRO_NO_WAKE=1 skipping this hook,
  // both tests still fail identically). The explicit drain below only makes
  // the ordering deterministic so the repro cannot rot into flakiness.
  const origSplit = wallet.engine.split.bind(wallet.engine);
  const splitSpy = vi.spyOn(wallet.engine, 'split').mockImplementation(async (args, opts) => {
    if (process.env.SELF_SEND_REPRO_NO_WAKE === '1') return origSplit(args, opts); // natural-race baseline
    const { transfers } = await wallet.module.receive();
    console.log(
      `[wake-during-split] pump stored ${transfers.length} transfer(s); ` +
      `mailbox=${JSON.stringify(fake.listMailboxEntries(SELF.chainPubkey).map((e) => ({ token: e.tokenId.slice(0, 8), status: e.status })))}`
    );
    return origSplit(args, opts);
  });

  const sendResult = await wallet.module.send({ recipient: '@me', amount: '6', coinId: UCT });
  splitSpy.mockRestore();
  expect(sendResult.status).toBe('completed');

  // LOAD-BEARING plan check: the field scenario requires exactly
  // [direct 2-token, split 5-token → 4 + 1 change]. If selection changed, the
  // repro would silently test a different shape.
  const plan = sendResult.tokenTransfers.map((t) => ({ method: t.method, sourceTokenId: t.sourceTokenId }));
  console.log('[plan]', JSON.stringify(plan));
  expect(plan).toEqual([
    { method: 'direct', sourceTokenId: `v2_${t2}` },
    { method: 'split', sourceTokenId: `v2_${t5}` },
  ]);

  // Post-send settle: drain the remaining mailbox legs (the split output).
  await wallet.module.receive();
  await wallet.module.receive(); // second pass: nothing may remain unprocessed

  return { fake, wallet, tokenIds: { t5, t51, t2 }, sendResult };
}

function sumHistory(fake: FakeWalletApi, type: 'SENT' | 'RECEIVED'): bigint {
  return fake
    .getHistoryRecords(SELF.chainPubkey)
    .filter((r) => r.type === type)
    .flatMap((r) => (r.assets as { coinId: string; amount: string }[] | undefined) ?? [])
    .filter((a) => a.coinId === UCT)
    .reduce((s, a) => s + BigInt(a.amount), 0n);
}

describe('self-send of 6 from [5, 51, 2] over the wallet-api mailbox rail (field repro)', () => {
  it('Test A (history): the transfer nets to 0 in history — a −6 SENT matched by +6 of incoming records', async () => {
    const { fake } = await runSelfSendScenario('d-selfsend-history');

    const records = fake.getHistoryRecords(SELF.chainPubkey).map((r) => ({
      type: r.type,
      dedupKey: r.dedupKey,
      assets: r.assets,
    }));
    console.log('[history]', JSON.stringify(records, null, 2));

    const sent = sumHistory(fake, 'SENT');
    const received = sumHistory(fake, 'RECEIVED');
    console.log(`[history] sent=${sent} received=${received} net=${received - sent}`);

    expect(sent).toBe(6n); // the aggregate −6 SENT record (works today)
    // FIELD BUG: only +4 (split leg) is recorded; the +2 direct leg is
    // swallowed by the genesis-id-only 'duplicate' verdict → net history −2.
    expect(received).toBe(6n);
  });

  it('Test B (funds): inventory still holds 58 and the direct-leg 2-token is present and spendable', async () => {
    const { fake, wallet, tokenIds } = await runSelfSendScenario('d-selfsend-funds');

    const row2 = fake.getRow(SELF.chainPubkey, tokenIds.t2);
    const localTotal = wallet.module
      .getTokens()
      .filter((t) => t.coinId === UCT)
      .reduce((s, t) => s + BigInt(t.amount || '0'), 0n);
    const balances = await wallet.client.getBalances();
    console.log('[inventory] row2 =', JSON.stringify(row2));
    console.log('[inventory] server balances =', JSON.stringify(balances, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    console.log('[inventory] local token total =', localTotal.toString());

    // FIELD BUG (fund loss): the wallet's own pushRemovals (state-blind,
    // fresh transferId, no deposit evidence) re-kills the claim-reactivated
    // row of the direct leg → server flips it removed/unevidenced, balance 56.
    expect(row2).toMatchObject({ status: 'active' });
    expect(balances).toEqual([{ coinId: UCT, total: 58n, tokenCount: expect.any(Number) }]);
    expect(localTotal).toBe(58n);
  });
});
