/**
 * PaymentsModule.send() — v2 engine path: failure modes, recovery, outbox
 * lifecycle, SENT history metadata and TransferResult.tokenTransfers entries.
 *
 * Complements PaymentsModule.v2-receive.test.ts (which covers the send
 * happy-path wire format, split balances and memo placement). Clean
 * FakeTokenEngine harness — no SDK vi.mocks; only public APIs plus the
 * deliver() pattern to seed the wallet with received tokens.
 */
import { describe, it, expect, vi, type Mock } from 'vitest';
import { createPaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { FullIdentity } from '../../../types';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase, HistoryRecord } from '../../../storage';
import { FakeTokenEngine } from '../token-engine/FakeTokenEngine';
import { encodeTokenBlob } from '../../../token-engine/token-blob';
import { bytesToHex } from '../../../core/crypto';
import { SphereError } from '../../../core/errors';
import { STORAGE_KEYS_ADDRESS } from '../../../constants';
import type { V2TransferPayload } from '../../../types/v2-transfer';

const FAKE_PRIVATE_KEY = 'a'.repeat(64);
const FAKE_PUBKEY = '02' + 'b'.repeat(64);
const SENDER_TRANSPORT_PUBKEY = 'cc'.repeat(32);
const UCT = '11'.repeat(32); // v2 coin ids are lowercase hex
const BOB_CHAIN_PUBKEY = '02' + 'ee'.repeat(32); // recipient's 33-byte chain pubkey (hex)
const BOB_DIRECT_ADDRESS = 'DIRECT://0000b97b4a83dc3fe636d4f21dbfe4c93149e07367539a059a9c8e64ad7d9fdc30644eaaf64b';

function mockIdentity(): FullIdentity {
  return {
    chainPubkey: FAKE_PUBKEY, directAddress: 'DIRECT://x',
    privateKey: FAKE_PRIVATE_KEY, transportPubkey: 'dd'.repeat(32),
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

function mockTokenStorage(): TokenStorageProvider<TxfStorageDataBase> {
  return {
    id: 'ts', name: 'ts', type: 'local',
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: () => true, getStatus: () => 'connected', setIdentity: vi.fn(),
    initialize: vi.fn().mockResolvedValue(true), shutdown: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue({ success: true, timestamp: 0 }),
    load: vi.fn().mockResolvedValue({ success: false, source: 'local', timestamp: 0 }),
    sync: vi.fn().mockResolvedValue({ success: true, added: 0, removed: 0, conflicts: 0 }),
    ...mockHistoryStore(),
  } as unknown as TokenStorageProvider<TxfStorageDataBase>;
}

function mockTransport(nametag = 'alice'): TransportProvider {
  return {
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue({
      chainPubkey: BOB_CHAIN_PUBKEY,
      transportPubkey: 'bob-transport-pubkey',
      directAddress: BOB_DIRECT_ADDRESS,
      nametag: 'bob',
    }),
    resolveNametagInfo: vi.fn().mockResolvedValue(null),
    resolveTransportPubkeyInfo: vi.fn().mockResolvedValue({
      chainPubkey: FAKE_PUBKEY, transportPubkey: SENDER_TRANSPORT_PUBKEY,
      directAddress: 'DIRECT://sender', nametag,
    }),
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(), isConnected: () => true,
    publishNametag: vi.fn().mockResolvedValue(undefined),
    sendPaymentRequest: vi.fn().mockResolvedValue(undefined),
    sendPaymentRequestResponse: vi.fn().mockResolvedValue(undefined),
  } as unknown as TransportProvider;
}

/** Post-cutover oracle surface: network config only (no v1 client accessors). */
function mockOracle(): OracleProvider {
  return {
    id: 'o', name: 'o', type: 'aggregator',
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(),
    isConnected: () => true, getStatus: () => 'connected',
    initialize: vi.fn().mockResolvedValue(undefined),
    validateToken: vi.fn().mockResolvedValue({ valid: true, spent: false }),
    getTrustBaseJson: () => null,
    getAggregatorUrl: () => 'https://aggregator.test',
    getApiKey: () => undefined,
    onEvent: vi.fn().mockReturnValue(() => {}),
  } as unknown as OracleProvider;
}

/** engine: undefined → default FakeTokenEngine; null → no engine wired at all. */
function setup(engine: FakeTokenEngine | null = new FakeTokenEngine()) {
  const tsp = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();
  tsp.set('local', mockTokenStorage());
  const emitEvent = vi.fn();
  const transport = mockTransport();
  const storage = mockStorage();
  const deps: PaymentsModuleDependencies = {
    identity: mockIdentity(), storage, tokenStorageProviders: tsp,
    transport, oracle: mockOracle(), emitEvent,
    ...(engine ? { tokenEngine: engine } : {}),
  };
  const module = createPaymentsModule({ debug: false });
  module.initialize(deps);
  return { module, engine, emitEvent, transport, storage };
}

async function v2Payload(
  engine: FakeTokenEngine, coinId: string, amount: bigint, memo?: string,
  recipientPubkey: Uint8Array = engine.getIdentity().chainPubkey,
): Promise<V2TransferPayload> {
  const st = await engine.mint({ recipientPubkey, value: { assets: [{ coinId, amount }] } });
  return { type: 'V2_TRANSFER', version: '2.0', tokenBlob: bytesToHex(encodeTokenBlob(engine.encodeToken(st))), memo };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function deliver(module: ReturnType<typeof setup>['module'], payload: V2TransferPayload, id = 't1') {
  return (module as any).handleIncomingTransfer({
    id, senderTransportPubkey: SENDER_TRANSPORT_PUBKEY, payload, timestamp: 0,
  });
}

async function sendError(promise: Promise<unknown>): Promise<SphereError> {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(SphereError);
  return err as SphereError;
}

describe('send — recipient resolution failures', () => {
  it('fails with INVALID_RECIPIENT when transport.resolve returns null', async () => {
    const { module, engine, transport } = setup();
    await deliver(module, await v2Payload(engine!, UCT, 100n));
    (transport.resolve as Mock).mockResolvedValue(null);

    const err = await sendError(module.send({ recipient: '@ghost', amount: '100', coinId: UCT }));
    expect(err.code).toBe('INVALID_RECIPIENT');

    // Nothing left the wallet and nothing hit the wire.
    expect(transport.sendTokenTransfer).not.toHaveBeenCalled();
    expect(module.getTokens()).toHaveLength(1);
  });

  it('fails with INVALID_RECIPIENT when the peer has no published chain pubkey', async () => {
    const { module, engine, transport } = setup();
    await deliver(module, await v2Payload(engine!, UCT, 100n));
    // Peer is reachable on transport but never published a chain identity.
    (transport.resolve as Mock).mockResolvedValue({
      transportPubkey: 'bob-transport-pubkey', directAddress: BOB_DIRECT_ADDRESS, nametag: 'bob',
    });

    const err = await sendError(module.send({ recipient: '@bob', amount: '100', coinId: UCT }));
    expect(err.code).toBe('INVALID_RECIPIENT');
    expect(err.message).toContain('no published identity');
    expect(transport.sendTokenTransfer).not.toHaveBeenCalled();
  });
});

describe('send — engine availability', () => {
  it('fails with AGGREGATOR_ERROR when no token engine is configured', async () => {
    const { module, transport } = setup(null); // no engine wired

    const err = await sendError(module.send({ recipient: '@bob', amount: '100', coinId: UCT }));
    expect(err.code).toBe('AGGREGATOR_ERROR');
    expect(err.message).toContain('Token engine unavailable');
    expect(transport.sendTokenTransfer).not.toHaveBeenCalled();
  });
});

describe('send — insufficient balance', () => {
  it('fails with SEND_INSUFFICIENT_BALANCE when the wallet is empty', async () => {
    const { module, transport } = setup();

    const err = await sendError(module.send({ recipient: '@bob', amount: '100', coinId: UCT }));
    expect(err.code).toBe('SEND_INSUFFICIENT_BALANCE');
    expect(err.message).toContain('Insufficient balance');
    expect(transport.sendTokenTransfer).not.toHaveBeenCalled();
  });
});

describe('send — failure recovery (engine.transfer throws mid-send)', () => {
  class ExplodingTransferEngine extends FakeTokenEngine {
    public override transfer(): Promise<never> {
      return Promise.reject(new Error('engine transfer failed mid-send'));
    }
  }

  it('restores the source token to confirmed and notifies the spend queue', async () => {
    const { module, engine, emitEvent, transport } = setup(new ExplodingTransferEngine());
    await deliver(module, await v2Payload(engine!, UCT, 100n));
    const notifySpy = vi.spyOn((module as any).spendQueue, 'notifyChange');

    await expect(
      module.send({ recipient: '@bob', amount: '100', coinId: UCT })
    ).rejects.toThrow('engine transfer failed mid-send');

    // Source token is back in the wallet, spendable again.
    const tokens = module.getTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].status).toBe('confirmed');

    // Queue is woken AFTER restoration so queued sends see the restored token.
    expect(notifySpy).toHaveBeenCalledWith(UCT);

    // Failure is surfaced; nothing was handed to the recipient, no SENT history.
    const failed = emitEvent.mock.calls.find((c: any[]) => c[0] === 'transfer:failed');
    expect(failed).toBeDefined();
    expect(failed![1].status).toBe('failed');
    expect(failed![1].error).toContain('engine transfer failed mid-send');
    expect(transport.sendTokenTransfer).not.toHaveBeenCalled();
    expect(module.getHistory().filter((h) => h.type === 'SENT')).toHaveLength(0);
  });
});

describe('send — outbox lifecycle', () => {
  it('writes an outbox entry during send and removes it on success', async () => {
    const { module, engine, storage } = setup();
    await deliver(module, await v2Payload(engine!, UCT, 100n));

    const result = await module.send({ recipient: '@bob', amount: '100', coinId: UCT });
    expect(result.status).toBe('completed');

    // The transfer was journaled to the outbox while in flight…
    const outboxWrites = (storage.set as Mock).mock.calls
      .filter(([key]: [string, string]) => key === STORAGE_KEYS_ADDRESS.OUTBOX);
    expect(outboxWrites.length).toBeGreaterThanOrEqual(2);
    expect(outboxWrites[0][1]).toContain(result.id);

    // …and removed once the send completed.
    const finalOutbox = await storage.get(STORAGE_KEYS_ADDRESS.OUTBOX);
    expect(JSON.parse(finalOutbox!)).toEqual([]);
  });
});

describe('send — SENT history entry', () => {
  it('records a single SENT entry with recipient metadata, memo and token breakdown', async () => {
    const { module, engine } = setup();
    await deliver(module, await v2Payload(engine!, UCT, 100n));
    const sourceTokenId = module.getTokens()[0].id;

    const result = await module.send({ recipient: '@bob', amount: '100', coinId: UCT, memo: 'lunch' });

    const sent = module.getHistory().filter((h) => h.type === 'SENT');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'SENT',
      amount: '100',
      coinId: UCT,
      memo: 'lunch',
      transferId: result.id,
      recipientPubkey: 'bob-transport-pubkey',
      recipientNametag: 'bob',
      recipientAddress: BOB_DIRECT_ADDRESS,
      tokenIds: [{ id: sourceTokenId, amount: '100', source: 'direct' }],
    });
    expect(sent[0].timestamp).toBeGreaterThan(0);
  });
});

describe('TransferResult.tokenTransfers', () => {
  it('produces one direct entry per whole token consumed (multi-token send)', async () => {
    const { module, engine, transport } = setup();
    // 100 + 40 exactly covers 140 → both tokens go whole, no split.
    await deliver(module, await v2Payload(engine!, UCT, 100n), 't1');
    await deliver(module, await v2Payload(engine!, UCT, 40n), 't2');
    const sourceIds = module.getTokens().map((t) => t.id).sort();

    const result = await module.send({ recipient: '@bob', amount: '140', coinId: UCT });

    expect(result.status).toBe('completed');
    expect(result.tokenTransfers).toHaveLength(2);
    for (const tt of result.tokenTransfers) {
      expect(tt).toEqual({ sourceTokenId: tt.sourceTokenId, method: 'direct' });
    }
    expect(result.tokenTransfers.map((tt) => tt.sourceTokenId).sort()).toEqual(sourceIds);

    // One V2_TRANSFER wire payload per consumed token, but a single SENT entry.
    expect((transport.sendTokenTransfer as Mock).mock.calls).toHaveLength(2);
    expect(module.getHistory().filter((h) => h.type === 'SENT')).toHaveLength(1);
    expect(module.getTokens()).toHaveLength(0);
  });

  it('produces a single split entry for a split send and no txHash field', async () => {
    const { module, engine } = setup();
    await deliver(module, await v2Payload(engine!, UCT, 1000n));
    const sourceTokenId = module.getTokens()[0].id;

    const result = await module.send({ recipient: '@bob', amount: '300', coinId: UCT });

    expect(result.tokenTransfers).toEqual([{ sourceTokenId, method: 'split' }]);
    // txHash was replaced by tokenTransfers long ago and must not resurface.
    expect(result).not.toHaveProperty('txHash');
  });
});

describe('send — transferMode is ignored (single engine path)', () => {
  it('sends the same V2_TRANSFER wire payload regardless of transferMode', async () => {
    const { module, engine, transport } = setup();
    await deliver(module, await v2Payload(engine!, UCT, 100n), 't1');
    await deliver(module, await v2Payload(engine!, UCT, 100n), 't2');

    const conservative = await module.send({ recipient: '@bob', amount: '100', coinId: UCT, transferMode: 'conservative' });
    const instant = await module.send({ recipient: '@bob', amount: '100', coinId: UCT, transferMode: 'instant' });

    expect(conservative.status).toBe('completed');
    expect(instant.status).toBe('completed');
    const payloads = (transport.sendTokenTransfer as Mock).mock.calls.map((c: any[]) => c[1]);
    expect(payloads).toHaveLength(2);
    for (const p of payloads) {
      expect(p.type).toBe('V2_TRANSFER');
      expect(p.version).toBe('2.0');
      expect(typeof p.tokenBlob).toBe('string');
    }
  });
});
