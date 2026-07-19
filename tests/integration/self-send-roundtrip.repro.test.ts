/**
 * BLAST-RADIUS PROBE — is the multi-token SELF-send fund-loss bug
 * (tests/integration/self-send-multitoken.repro.test.ts) STRICTLY confined to
 * self-sends, or does a NON-self round-trip A→B→A trigger the identical
 * state-blind, evidence-free pushRemovals kill?
 *
 * The confirmed self-send loss chain (sdk 0.11.14, wallet-api inventory custody):
 *   1. send() DIRECT-transfers a token X (same genesis tokenId, new state) and
 *      calls removeToken(X) → a LOCAL tombstone (X.tokenId, X.oldStateHash) that
 *      lives in PaymentsModule.tombstones (PaymentsModule.ts:2287, :3892-3913).
 *   2. X's server inventory row is REACTIVATED to 'active' (a mailbox claim that
 *      handed X back — self-send: own pump; round-trip: the return claim —
 *      fake-wallet-api.ts performClaimHandoff :1538-1556).
 *   3. The NEXT save() serializes tombstones into data._tombstones
 *      (PaymentsModule.ts:6695) and WalletApiTokenStorageProvider.save()
 *      →pushRemovals (:698-706) DROPS the stateHash (:636) and pushes
 *      spent=[X.tokenId] under a FRESH newTransferId() with ZERO deposit
 *      evidence, because it matches X by tokenId ONLY and sees the server row is
 *      'active'. The fake flips it removed/'unevidenced'
 *      (fake-wallet-api.ts removalFor :1086-1090) → permanent loss;
 *      addKnownSpends (:706) then blocks recoverRemoved (:540-541).
 *
 * THE OPEN QUESTION probed here: A sends X to a DIFFERENT wallet B (ordinary
 * direct transfer; X keeps its genesis tokenId). Later B sends the same X back
 * to A. When A re-claims X, A's inventory row for X reactivates. A's STALE local
 * tombstone for X — left from A's original outbound send, never reconciled in a
 * single session — is still in PaymentsModule.tombstones. Does the next save()
 * collide it with the reactivated 'active' row and fire the same kill?
 *
 * The scenario below drives A→B→A with two distinct wallets over ONE shared
 * FakeWalletApi (real mailbox/inventory between them), then FORCES a save() on A
 * and asserts A's server row for X and A's balance. The assertions encode the
 * NO-LOSS expectation, so a FAILURE here means the loss is NOT self-send-specific.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createPaymentsModule,
  type PaymentsModule,
  type PaymentsModuleDependencies,
} from '../../modules/payments/PaymentsModule';
import type { FullIdentity } from '../../types';
import type { TransportProvider, PeerInfo } from '../../transport';
import type { OracleProvider } from '../../oracle';
import type { StorageProvider } from '../../storage';
import {
  FakeTokenEngine,
  decodeFakeTokenAssets,
  decodeFakeTokenId,
} from '../unit/token-engine/FakeTokenEngine';
import { FakeWalletApi } from '../support/fake-wallet-api';
import { MemoryKeyValueStore, testIdentity } from '../support/wallet-api-test-helpers';
import { WalletApiClient } from '../../wallet-api';
import { WalletApiMailboxProvider, WalletApiTokenStorageProvider } from '../../impl/shared/wallet-api';
import { encodeTokenBlob } from '../../token-engine/token-blob';
import { hexToBytes } from '../../core/crypto';

const UCT = '11'.repeat(32);
const A = testIdentity(31);
const B = testIdentity(32);

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

/** Transport that resolves EVERY recipient to a FIXED target identity (A→B, B→A). */
function transportTo(target: { chainPubkey: string }): TransportProvider {
  const peer: PeerInfo = {
    chainPubkey: target.chainPubkey,
    transportPubkey: target.chainPubkey.slice(2),
    directAddress: `DIRECT://${target.chainPubkey.slice(0, 12)}`,
    nametag: 'peer',
    timestamp: Date.now(),
  };
  return {
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue(peer),
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
  identity: FullIdentity;
}

/** FULL wallet-api preset (custody 'inventory') — the sphere app's composition. */
function makeWallet(
  baseUrl: string,
  network: string,
  deviceId: string,
  who: { privateKey: string; chainPubkey: string },
  target: { chainPubkey: string },
): Wallet {
  const identity = fullIdentity(who);
  const kv = new MemoryKeyValueStore();
  const client = new WalletApiClient({ baseUrl, network, deviceId, storage: kv });
  const tokenStorage = new WalletApiTokenStorageProvider({ client, stateStore: kv });
  tokenStorage.setIdentity(identity);
  const delivery = new WalletApiMailboxProvider({ client, custody: 'inventory', stateStore: kv });
  const engine = new FakeTokenEngine({ chainPubkey: hexToBytes(who.chainPubkey) });
  const deps: PaymentsModuleDependencies = {
    identity,
    storage: mockStorage(),
    tokenStorageProviders: new Map([[tokenStorage.id, tokenStorage]]),
    transport: transportTo(target),
    oracle: mockOracle(),
    emitEvent: vi.fn(),
    tokenEngine: engine,
    delivery,
    walletApi: client,
  };
  const module = createPaymentsModule({ l1: null });
  module.initialize(deps);
  cleanups.push(() => module.destroy());
  return { module, engine, client, identity };
}

async function seedServerToken(fake: FakeWalletApi, wallet: Wallet, amount: bigint): Promise<string> {
  const minted = await wallet.engine.mint({
    recipientPubkey: wallet.engine.getIdentity().chainPubkey,
    value: { assets: [{ coinId: UCT, amount }] },
  });
  const bytes = encodeTokenBlob(wallet.engine.encodeToken(minted));
  const tokenId = wallet.engine.tokenId(minted);
  fake.seedInventory(wallet.identity.chainPubkey, [{ tokenId, assets: [{ coinId: UCT, amount }], blob: bytes }]);
  return tokenId;
}

function balanceOf(client: WalletApiClient): Promise<{ coinId: string; total: bigint; tokenCount: number }[]> {
  return client.getBalances();
}

describe('A→B→A round-trip of a single direct-transferable token over the wallet-api mailbox rail', () => {
  it('does NOT lose funds: A re-claims X, and a forced save() must not re-kill the reactivated row', async () => {
    const fake = new FakeWalletApi({ decodeAssets: decodeFakeTokenAssets, decodeTokenId: decodeFakeTokenId });
    const baseUrl = await fake.start();
    cleanups.push(() => fake.stop());

    const walletA = makeWallet(baseUrl, fake.network, 'd-rt-A', A, B);
    const walletB = makeWallet(baseUrl, fake.network, 'd-rt-B', B, A);

    // Trace EVERY inventory apply A issues, so the killing call is visible in the
    // output: its transferId is a FRESH uuid (not A's send transferId) and it
    // carries spent=[X] with added=[] and zero mailbox deposit → the fake scores
    // the removal 'unevidenced' (fake-wallet-api.ts removalFor :1086-1090).
    const applies: { transferId: string; spent: string[]; added: number }[] = [];
    const origApply = walletA.client.applyInventoryDelta.bind(walletA.client);
    walletA.client.applyInventoryDelta = async (req) => {
      applies.push({ transferId: req.transferId, spent: [...req.spent], added: req.added.length });
      if (req.spent.length > 0 || req.added.length > 0) {
        console.log(
          `[A apply] transferId=${req.transferId.slice(0, 8)}… spent=[${req.spent.map((s) => `…${s.slice(-4)}`).join(',')}] added=${req.added.length}`
        );
      }
      return origApply(req);
    };

    // A holds a single 10-UCT token X (direct-transferable — exact-amount send
    // takes the DIRECT path, so X keeps its genesis tokenId through the trip).
    const X = await seedServerToken(fake, walletA, 10n);
    await walletA.module.load();
    await walletB.module.load();

    expect(await balanceOf(walletA.client)).toEqual([{ coinId: UCT, total: 10n, tokenCount: 1 }]);
    expect(await balanceOf(walletB.client)).toEqual([]);
    console.log(`[setup] X=${X.slice(0, 12)}… A=${A.chainPubkey.slice(0, 10)}… B=${B.chainPubkey.slice(0, 10)}…`);

    // ── Leg 1: A sends X to @B (direct). ──────────────────────────────────────
    const sendAB = await walletA.module.send({ recipient: '@B', amount: '10', coinId: UCT });
    expect(sendAB.status).toBe('completed');
    const planAB = sendAB.tokenTransfers.map((t) => ({ method: t.method, sourceTokenId: t.sourceTokenId }));
    console.log('[leg1 A→B plan]', JSON.stringify(planAB));
    expect(planAB).toEqual([{ method: 'direct', sourceTokenId: `v2_${X}` }]); // load-bearing: must be a DIRECT transfer of X

    // A's tombstone for X is created HERE (removeToken after the server apply,
    // PaymentsModule.ts:2287) and — the crux of this probe — is never reconciled
    // away in a single session.
    const tombstonesAfterLeg1 = walletA.module.getTombstones().map((t) => t.tokenId);
    console.log('[leg1] A tombstones =', JSON.stringify(tombstonesAfterLeg1.map((t) => t.slice(0, 12))));
    expect(tombstonesAfterLeg1).toContain(X);

    console.log('[leg1] A row(X) =', JSON.stringify(fake.getRow(A.chainPubkey, X)));

    // ── B claims X. ───────────────────────────────────────────────────────────
    await walletB.module.receive();
    await walletB.module.receive(); // settle
    console.log('[leg1] B row(X) =', JSON.stringify(fake.getRow(B.chainPubkey, X)));
    expect(await balanceOf(walletB.client)).toEqual([{ coinId: UCT, total: 10n, tokenCount: 1 }]);
    expect(await balanceOf(walletA.client)).toEqual([]); // A gave X away

    // ── Leg 2: B sends X back to @A (direct — same genesis tokenId, new state). ─
    const sendBA = await walletB.module.send({ recipient: '@A', amount: '10', coinId: UCT });
    expect(sendBA.status).toBe('completed');
    const planBA = sendBA.tokenTransfers.map((t) => ({ method: t.method, sourceTokenId: t.sourceTokenId }));
    console.log('[leg2 B→A plan]', JSON.stringify(planBA));
    expect(planBA).toEqual([{ method: 'direct', sourceTokenId: `v2_${X}` }]);

    // ── A re-claims X (return trip). This REACTIVATES A's inventory row for X. ─
    await walletA.module.receive();
    await walletA.module.receive(); // settle

    const rowBeforeSave = fake.getRow(A.chainPubkey, X);
    const balBeforeSave = await balanceOf(walletA.client);
    const tombstonesBeforeSave = walletA.module.getTombstones().map((t) => t.tokenId);
    console.log('[return] A row(X) BEFORE forced save =', JSON.stringify(rowBeforeSave));
    console.log('[return] A balances BEFORE forced save =', JSON.stringify(balBeforeSave, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    console.log('[return] A still tombstones X? =', tombstonesBeforeSave.includes(X), JSON.stringify(tombstonesBeforeSave.map((t) => t.slice(0, 12))));

    // Precondition for the probe: X came back (row reactivated) AND A still
    // carries the stale tombstone for X.tokenId. If either is false the probe is
    // vacuous — assert both so a fixture accident cannot masquerade as "no loss".
    expect(rowBeforeSave).toMatchObject({ status: 'active' });
    expect(balBeforeSave).toEqual([{ coinId: UCT, total: 10n, tokenCount: 1 }]);
    expect(tombstonesBeforeSave).toContain(X);

    // ── Force ONE more save() on A — the same private persist the module runs
    // after every mutation (createStorageData → provider.save → syncInventory →
    // pushRemovals). If the round-trip shares the self-send mechanism, THIS is
    // where the state-blind, evidence-free spent=[X] push fires.
    await (walletA.module as unknown as { save(): Promise<void> }).save();

    const rowAfterSave = fake.getRow(A.chainPubkey, X);
    const balAfterSave = await balanceOf(walletA.client);

    // The killing apply: the LAST spent=[X] push. Show it is a fresh transferId,
    // distinct from A's original leg-1 send apply (evidence-free re-kill).
    const spendsOfX = applies.filter((a) => a.spent.includes(X));
    console.log('[return] A applies that spent X =', JSON.stringify(spendsOfX.map((a) => ({ tid: a.transferId.slice(0, 8), added: a.added }))));
    console.log('[return] A row(X) AFTER forced save =', JSON.stringify(rowAfterSave));
    console.log('[return] A balances AFTER forced save =', JSON.stringify(balAfterSave, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

    // Conservation across the two wallets (X lives in exactly one place).
    const bBal = await balanceOf(walletB.client);
    const total =
      (balAfterSave.find((x) => x.coinId === UCT)?.total ?? 0n) +
      (bBal.find((x) => x.coinId === UCT)?.total ?? 0n);
    console.log(`[return] conserved total across A+B = ${total} (expect 10)`);

    // NO-LOSS expectation: X ends ACTIVE under A, A's balance is 10, total conserved.
    // A FAILURE here (row removed/'unevidenced', balance 0) proves the loss is
    // NOT confined to self-sends.
    expect(rowAfterSave).toMatchObject({ status: 'active' });
    expect(balAfterSave).toEqual([{ coinId: UCT, total: 10n, tokenCount: 1 }]);
    expect(total).toBe(10n);
  });
});
