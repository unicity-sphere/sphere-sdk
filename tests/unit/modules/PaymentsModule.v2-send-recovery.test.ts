/**
 * send() failure recovery + crash recovery (v2 engine path).
 *
 * Money-safety invariants:
 *  - once a transfer/split is certified on-chain, the source is NEVER restored
 *    as 'confirmed' (it is terminal 'spent');
 *  - the FINISHED output blob is journaled (PENDING_V2_DELIVERIES) before the
 *    delivery attempt and replayed on load(), so a transport failure or crash
 *    cannot lose the recipient's token;
 *  - a pre-certification failure restores the source as 'confirmed' AND persists
 *    the restore (no stuck-'transferring' on reload);
 *  - tokens stuck in 'transferring' after a crash are reconciled on load()
 *    against the network (spent → 'spent', unspent → 'confirmed');
 *  - a tombstoned re-delivery emits NO transfer:incoming and NO history entry.
 *
 * Clean harness (no SDK vi.mock), mirrors PaymentsModule.v2-receive.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { createPaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { FullIdentity } from '../../../types';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase, HistoryRecord } from '../../../storage';
import { STORAGE_KEYS_ADDRESS } from '../../../constants';
import { FakeTokenEngine } from '../token-engine/FakeTokenEngine';
import { encodeTokenBlob } from '../../../token-engine/token-blob';
import { bytesToHex } from '../../../core/crypto';
import type { V2TransferPayload } from '../../../types/v2-transfer';

const FAKE_PRIVATE_KEY = 'a'.repeat(64);
const FAKE_PUBKEY = '02' + 'b'.repeat(64);
const SENDER_TRANSPORT_PUBKEY = 'cc'.repeat(32);
const UCT = '11'.repeat(32);
const BOB_CHAIN_PUBKEY = '02' + 'ee'.repeat(32);

function mockIdentity(): FullIdentity {
  return {
    chainPubkey: FAKE_PUBKEY, directAddress: 'DIRECT://x',
    privateKey: FAKE_PRIVATE_KEY, transportPubkey: 'dd'.repeat(32),
  };
}

function mockStorage(): { provider: StorageProvider; map: Map<string, string> } {
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
  return { provider, map: s };
}

function mockHistoryStore() {
  const entries = new Map<string, HistoryRecord>();
  return {
    addHistoryEntry: vi.fn(async (e: HistoryRecord) => { entries.set(e.dedupKey, e); }),
    getHistoryEntries: vi.fn(async () => [...entries.values()]),
    hasHistoryEntry: vi.fn(async (k: string) => entries.has(k)),
    clearHistory: vi.fn(async () => entries.clear()),
    importHistoryEntries: vi.fn(async () => 0),
  };
}

function mockTokenStorage(): TokenStorageProvider<TxfStorageDataBase> & { savedData: () => TxfStorageDataBase | null } {
  let lastSaved: TxfStorageDataBase | null = null;
  const provider = {
    id: 'ts', name: 'ts', type: 'local',
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: () => true, getStatus: () => 'connected', setIdentity: vi.fn(),
    initialize: vi.fn().mockResolvedValue(true), shutdown: vi.fn().mockResolvedValue(undefined),
    save: vi.fn(async (data: TxfStorageDataBase) => { lastSaved = data; return { success: true, timestamp: 0 }; }),
    load: vi.fn(async () => (lastSaved
      ? { success: true, source: 'local', timestamp: 0, data: lastSaved }
      : { success: false, source: 'local', timestamp: 0 })),
    sync: vi.fn().mockResolvedValue({ success: true, added: 0, removed: 0, conflicts: 0 }),
    ...mockHistoryStore(),
    savedData: () => lastSaved,
  };
  return provider as unknown as TokenStorageProvider<TxfStorageDataBase> & { savedData: () => TxfStorageDataBase | null };
}

function mockTransport(): TransportProvider {
  return {
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue({
      chainPubkey: BOB_CHAIN_PUBKEY,
      transportPubkey: 'bob-transport-pubkey',
      directAddress: 'DIRECT://bob',
      nametag: 'bob',
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

function setup(engine = new FakeTokenEngine()) {
  const tsp = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();
  const tokenStorage = mockTokenStorage();
  tsp.set('local', tokenStorage);
  const emitEvent = vi.fn();
  const transport = mockTransport();
  const storage = mockStorage();
  const deps: PaymentsModuleDependencies = {
    identity: mockIdentity(), storage: storage.provider, tokenStorageProviders: tsp,
    transport, oracle: mockOracle(), emitEvent, tokenEngine: engine,
  };
  const module = createPaymentsModule({ debug: false });
  module.initialize(deps);
  return { module, engine, emitEvent, transport, storage, tokenStorage, deps };
}

async function v2Payload(engine: FakeTokenEngine, amount: bigint): Promise<V2TransferPayload> {
  const st = await engine.mint({
    recipientPubkey: engine.getIdentity().chainPubkey,
    value: { assets: [{ coinId: UCT, amount }] },
  });
  return { type: 'V2_TRANSFER', version: '2.0', tokenBlob: bytesToHex(encodeTokenBlob(engine.encodeToken(st))) };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function deliver(module: ReturnType<typeof setup>['module'], payload: V2TransferPayload, id = 't1') {
  return (module as any).handleIncomingTransfer({
    id, senderTransportPubkey: SENDER_TRANSPORT_PUBKEY, payload, timestamp: 0,
  });
}

function journal(storage: { map: Map<string, string> }): Array<{ transferId: string; tokenBlob: string; recipientPubkey: string }> {
  const raw = storage.map.get(STORAGE_KEYS_ADDRESS.PENDING_V2_DELIVERIES);
  return raw ? JSON.parse(raw) : [];
}

describe('send() — failure recovery (v2)', () => {
  it('transport failure AFTER engine.transfer: source is spent (never confirmed), blob journaled, restore persisted', async () => {
    const { module, engine, transport, storage, tokenStorage } = setup();
    await deliver(module, await v2Payload(engine, 100n));
    (transport.sendTokenTransfer as any).mockRejectedValueOnce(new Error('relay down'));

    await expect(module.send({ recipient: '@bob', amount: '100', coinId: UCT })).rejects.toThrow('relay down');

    // Source token was certified on-chain — terminal 'spent', NOT confirmed.
    const tokens = module.getTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].status).toBe('spent');

    // The finished blob is journaled for replay. Since S3 the journal records
    // the recipient's CHAIN pubkey — the delivery port's canonical addressing
    // (the transport adapter resolves it to the transport pubkey at send time).
    const entries = journal(storage);
    expect(entries).toHaveLength(1);
    expect(entries[0].recipientPubkey).toBe(BOB_CHAIN_PUBKEY);

    // The restore was persisted (a crash now must not resurrect 'transferring').
    expect(tokenStorage.save).toHaveBeenCalled();
    const persisted = tokenStorage.savedData();
    expect(JSON.stringify(persisted)).toContain('"spent"');
  });

  it('replayPendingV2Deliveries delivers the journaled blob and clears the journal', async () => {
    const { module, engine, transport, storage } = setup();
    await deliver(module, await v2Payload(engine, 100n));
    (transport.sendTokenTransfer as any).mockRejectedValueOnce(new Error('relay down'));
    await expect(module.send({ recipient: '@bob', amount: '100', coinId: UCT })).rejects.toThrow();
    expect(journal(storage)).toHaveLength(1);
    const journaledBlob = journal(storage)[0].tokenBlob;

    (transport.sendTokenTransfer as any).mockResolvedValue(undefined);
    await (module as any).replayPendingV2Deliveries();

    expect(journal(storage)).toHaveLength(0);
    const replayCall = (transport.sendTokenTransfer as any).mock.calls.at(-1);
    expect(replayCall[1].type).toBe('V2_TRANSFER');
    expect(replayCall[1].tokenBlob).toBe(journaledBlob);
  });

  it('split: change token is stored and the recipient blob journaled even when delivery fails', async () => {
    const { module, engine, transport, storage } = setup();
    await deliver(module, await v2Payload(engine, 1000n));
    (transport.sendTokenTransfer as any).mockRejectedValueOnce(new Error('relay down'));

    await expect(module.send({ recipient: '@bob', amount: '300', coinId: UCT })).rejects.toThrow('relay down');

    const tokens = module.getTokens();
    // Change token (700) survived as confirmed; the split source is terminal 'spent'.
    const change = tokens.find((t) => t.amount === '700');
    expect(change?.status).toBe('confirmed');
    const source = tokens.find((t) => t.amount === '1000');
    expect(source?.status).toBe('spent');
    // Recipient's 300 blob is journaled for replay.
    expect(journal(storage)).toHaveLength(1);
  });

  it('pre-certification failure (engine.transfer throws): source restored confirmed, restore persisted, journal empty', async () => {
    const { module, engine, tokenStorage, storage } = setup();
    await deliver(module, await v2Payload(engine, 100n));
    vi.spyOn(engine, 'transfer').mockRejectedValueOnce(new Error('aggregator 500'));
    const savesBefore = (tokenStorage.save as any).mock.calls.length;

    await expect(module.send({ recipient: '@bob', amount: '100', coinId: UCT })).rejects.toThrow('aggregator 500');

    const tokens = module.getTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].status).toBe('confirmed');
    expect(journal(storage)).toHaveLength(0);
    expect((tokenStorage.save as any).mock.calls.length).toBeGreaterThan(savesBefore);
  });
});

describe('load() — crash recovery of stuck-transferring tokens (v2)', () => {
  it("reconciles a persisted 'transferring' token: unspent → confirmed", async () => {
    const first = setup();
    await deliver(first.module, await v2Payload(first.engine, 100n));
    // Simulate a crash mid-send: persist with status 'transferring'.
    const t = first.module.getTokens()[0];
    t.status = 'transferring';
    await (first.module as any).save();

    // "Restart": fresh module over the same storage + engine.
    const second = createPaymentsModule({ debug: false });
    second.initialize({ ...first.deps });
    await second.load();

    const tokens = second.getTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].status).toBe('confirmed');
  });

  it("reconciles a persisted 'transferring' token: spent on-chain → terminal 'spent'", async () => {
    const first = setup();
    await deliver(first.module, await v2Payload(first.engine, 100n));
    const t = first.module.getTokens()[0];
    t.status = 'transferring';
    await (first.module as any).save();
    vi.spyOn(first.engine, 'isSpent').mockResolvedValue(true);

    const second = createPaymentsModule({ debug: false });
    second.initialize({ ...first.deps });
    await second.load();

    expect(second.getTokens()[0].status).toBe('spent');
  });
});

describe('handleV2Transfer — storage rejection gates events (v2)', () => {
  it('a tombstoned re-delivery emits NO transfer:incoming and writes NO history', async () => {
    const { module, engine, emitEvent, transport } = setup();
    const payload = await v2Payload(engine, 100n);
    await deliver(module, payload);
    // Spend it: the send tombstones the exact received state.
    await module.send({ recipient: '@bob', amount: '100', coinId: UCT });
    expect(module.getTokens()).toHaveLength(0);
    expect(transport.sendTokenTransfer).toHaveBeenCalled();
    emitEvent.mockClear();

    // Relay re-delivers the original transfer after the state was spent.
    await deliver(module, payload, 't2');

    expect(module.getTokens()).toHaveLength(0);
    expect(emitEvent.mock.calls.find((c: any[]) => c[0] === 'transfer:incoming')).toBeUndefined();
    expect(module.getHistory().filter((h) => h.type === 'RECEIVED' && h.tokenId?.startsWith('v2_'))).toHaveLength(1); // only the original
  });
});

describe('load() — orphaned pending-V5 terminalization', () => {
  it("migrates the legacy PENDING_V5_TOKENS KV key: tokens become terminal 'invalid', key removed", async () => {
    const { module, storage } = setup();
    // Inject the key exactly as the removed v1 receiver persisted it.
    storage.map.set(STORAGE_KEYS_ADDRESS.PENDING_V5_TOKENS, JSON.stringify([{
      id: 'v5split_abc', coinId: UCT, symbol: 'UCT', name: 'UCT', decimals: 0,
      amount: '50', status: 'submitted', createdAt: Date.now(), updatedAt: Date.now(),
      sdkData: JSON.stringify({ _pendingFinalization: { stage: 'RECEIVED' } }),
    }]));

    await module.load();

    const v5 = module.getTokens({ status: 'invalid' });
    expect(v5).toHaveLength(1);
    expect(v5[0].id).toBe('v5split_abc');
    // Not counted as confirmed balance, and the legacy key is gone.
    expect(module.getTokens({ status: 'confirmed' })).toHaveLength(0);
    expect(storage.map.has(STORAGE_KEYS_ADDRESS.PENDING_V5_TOKENS)).toBe(false);
  });
});
