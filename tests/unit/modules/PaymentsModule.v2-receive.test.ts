/**
 * v2 transfer RECEIVER — handleV2Transfer (B1, path B).
 *
 * Sender-driven model: the sender hands a FINISHED token (a V2_TRANSFER payload
 * carrying the token blob), the receiver decodes it via the engine and just
 * STORES it as a confirmed token — no commitment / inclusion-proof /
 * finalization round-trip. Clean harness (NO SDK vi.mock) so FakeTokenEngine and
 * the engine-injected SpendQueue run end-to-end.
 */
import { describe, it, expect, vi } from 'vitest';
import { createPaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { FullIdentity } from '../../../types';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase, HistoryRecord } from '../../../storage';
import { FakeTokenEngine } from '../token-engine/FakeTokenEngine';
import { encodeTokenBlob, decodeTokenBlob } from '../../../token-engine/token-blob';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { decodeTransferMessage } from '../../../modules/accounting/memo';
import type { V2TransferPayload } from '../../../types/v2-transfer';

const FAKE_PRIVATE_KEY = 'a'.repeat(64);
const FAKE_PUBKEY = '02' + 'b'.repeat(64);
const SENDER_TRANSPORT_PUBKEY = 'cc'.repeat(32);
const FOREIGN_PUBKEY = new Uint8Array([0x02, ...new Array<number>(32).fill(7)]); // 33 bytes, NOT this wallet
const UCT = '11'.repeat(32); // v2 coin ids are lowercase hex
const BOB_CHAIN_PUBKEY = '02' + 'ee'.repeat(32); // recipient's 33-byte chain pubkey (hex)

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
      // a valid DIRECT address (AddressFactory parses the hex after DIRECT://)
      directAddress: 'DIRECT://0000b97b4a83dc3fe636d4f21dbfe4c93149e07367539a059a9c8e64ad7d9fdc30644eaaf64b',
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

function mockOracle(): OracleProvider {
  return {
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    // Stub present so the v1 requirement passes; the v2 engine send path ignores it.
    getStateTransitionClient: vi.fn().mockReturnValue({ submitTransferCommitment: vi.fn().mockResolvedValue({ status: 'SUCCESS' }) }),
    getTrustBase: vi.fn().mockReturnValue({}),
    isDevMode: () => false,
    waitForProofSdk: vi.fn().mockResolvedValue({ proof: 'mock' }),
  } as unknown as OracleProvider;
}

function setup(engine = new FakeTokenEngine()) {
  const tsp = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();
  tsp.set('local', mockTokenStorage());
  const emitEvent = vi.fn();
  const transport = mockTransport();
  const deps: PaymentsModuleDependencies = {
    identity: mockIdentity(), storage: mockStorage(), tokenStorageProviders: tsp,
    transport, oracle: mockOracle(), emitEvent, tokenEngine: engine,
  };
  const module = createPaymentsModule({ debug: false });
  module.initialize(deps);
  return { module, engine, emitEvent, transport };
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

describe('handleV2Transfer — v2 receiver (B1)', () => {
  it('stores the finished token as confirmed', async () => {
    const { module, engine } = setup();
    await deliver(module, await v2Payload(engine, UCT, 100n));

    const tokens = module.getTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].coinId).toBe(UCT);
    expect(tokens[0].amount).toBe('100');
    expect(tokens[0].status).toBe('confirmed');
  });

  it('emits transfer:incoming with the token, memo and resolved sender nametag', async () => {
    const { module, engine, emitEvent } = setup();
    await deliver(module, await v2Payload(engine, UCT, 250n, 'gm'));

    const call = emitEvent.mock.calls.find((c: any[]) => c[0] === 'transfer:incoming');
    expect(call).toBeDefined();
    expect(call![1].tokens).toHaveLength(1);
    expect(call![1].memo).toBe('gm');
    expect(call![1].senderNametag).toBe('alice');
  });

  it('records a single RECEIVED history entry', async () => {
    const { module, engine } = setup();
    await deliver(module, await v2Payload(engine, UCT, 100n));

    const received = module.getHistory().filter((h) => h.type === 'RECEIVED');
    expect(received).toHaveLength(1);
    expect(received[0].amount).toBe('100');
  });

  it('dedups a re-delivered identical token (genesis-stable id)', async () => {
    const { module, engine } = setup();
    const payload = await v2Payload(engine, UCT, 100n);
    await deliver(module, payload, 't1');
    await deliver(module, payload, 't2');

    expect(module.getTokens()).toHaveLength(1);
  });

  it('rejects a token that fails engine verification (not stored, no event)', async () => {
    class RejectingEngine extends FakeTokenEngine {
      public override verify() {
        return Promise.resolve({ ok: false, reason: 'NOT_AUTHENTICATED' });
      }
    }
    const { module, engine, emitEvent } = setup(new RejectingEngine());
    await deliver(module, await v2Payload(engine as FakeTokenEngine, UCT, 100n));

    expect(module.getTokens()).toHaveLength(0);
    expect(emitEvent.mock.calls.find((c: any[]) => c[0] === 'transfer:incoming')).toBeUndefined();
    expect(module.getHistory().filter((h) => h.type === 'RECEIVED')).toHaveLength(0);
  });

  it('rejects a token whose final state is owned by a FOREIGN pubkey (not stored)', async () => {
    const { module, engine, emitEvent } = setup();
    await deliver(module, await v2Payload(engine, UCT, 100n, undefined, FOREIGN_PUBKEY));

    expect(module.getTokens()).toHaveLength(0);
    expect(emitEvent.mock.calls.find((c: any[]) => c[0] === 'transfer:incoming')).toBeUndefined();
  });
});

describe('send — v2 engine path, whole-token (B1)', () => {
  it('round-trips: receive a token, then send it whole via engine.transfer', async () => {
    const { module, engine, transport } = setup();
    // Receive a 100-UCT token (exact match → no split).
    await deliver(module, await v2Payload(engine, UCT, 100n));
    expect(module.getTokens()).toHaveLength(1);

    const result = await module.send({ recipient: '@bob', amount: '100', coinId: UCT, memo: 'thanks' });

    expect(result.status).toBe('completed');
    // Source token was consumed by the engine and removed from the wallet.
    expect(module.getTokens()).toHaveLength(0);

    // A V2_TRANSFER payload (finished token blob) was handed to the recipient.
    const sent = (transport.sendTokenTransfer as any).mock.calls;
    expect(sent).toHaveLength(1);
    expect(sent[0][1].type).toBe('V2_TRANSFER');
    expect(sent[0][1].memo).toBe('thanks');
    expect(typeof sent[0][1].tokenBlob).toBe('string');

    // One SENT history entry.
    const history = module.getHistory().filter((h) => h.type === 'SENT');
    expect(history).toHaveLength(1);
    expect(history[0].amount).toBe('100');
  });

  it('the emitted blob decodes back to a token the recipient can store', async () => {
    const { module, engine, transport } = setup();
    await deliver(module, await v2Payload(engine, UCT, 100n));
    await module.send({ recipient: '@bob', amount: '100', coinId: UCT });

    // Feed the emitted V2_TRANSFER into a fresh recipient wallet (bob's identity,
    // matching the transferred token's new owner predicate).
    const sentPayload = (transport.sendTokenTransfer as any).mock.calls[0][1];
    const recipient = setup(new FakeTokenEngine({ chainPubkey: hexToBytes(BOB_CHAIN_PUBKEY) }));
    await deliver(recipient.module, sentPayload);

    expect(recipient.module.getTokens()).toHaveLength(1);
    expect(recipient.module.getTokens()[0].amount).toBe('100');
  });

  it('splits via engine.split: recipient gets the amount, sender keeps the change', async () => {
    const { module, engine, transport } = setup();
    // Hold a single 1000-UCT token, send 300 → engine split (300 out, 700 change).
    await deliver(module, await v2Payload(engine, UCT, 1000n));

    const result = await module.send({ recipient: '@bob', amount: '300', coinId: UCT });

    expect(result.status).toBe('completed');
    // Source consumed; the 700 change token remains, confirmed.
    const tokens = module.getTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].amount).toBe('700');
    expect(tokens[0].status).toBe('confirmed');

    // Recipient's V2_TRANSFER decodes to a 300 token (bob's wallet owns it).
    const sentPayload = (transport.sendTokenTransfer as any).mock.calls[0][1];
    expect(sentPayload.type).toBe('V2_TRANSFER');
    const recipient = setup(new FakeTokenEngine({ chainPubkey: hexToBytes(BOB_CHAIN_PUBKEY) }));
    await deliver(recipient.module, sentPayload);
    expect(recipient.module.getTokens()[0].amount).toBe('300');
  });

  it('carries the structured invoice ref on-chain for an invoice-memo payment', async () => {
    const { module, engine, transport } = setup();
    await deliver(module, await v2Payload(engine, UCT, 100n));

    const invoiceId = 'ab'.repeat(32); // 64-char hex invoice id
    await module.send({ recipient: '@bob', amount: '100', coinId: UCT, memo: `INV:${invoiceId}:F` });

    // The finished token's on-chain memo decodes to the structured invoice ref.
    const sentPayload = (transport.sendTokenTransfer as any).mock.calls[0][1];
    const token = await engine.decodeToken(decodeTokenBlob(hexToBytes(sentPayload.tokenBlob)));
    const onChainMemo = engine.readMemo(token);
    expect(onChainMemo).not.toBeNull();
    expect(decodeTransferMessage(onChainMemo)?.inv?.id?.toLowerCase()).toBe(invoiceId);
  });

  it('keeps a plain memo transport-only (no on-chain memo, for privacy)', async () => {
    const { module, engine, transport } = setup();
    await deliver(module, await v2Payload(engine, UCT, 100n));
    await module.send({ recipient: '@bob', amount: '100', coinId: UCT, memo: 'thanks' });

    const sentPayload = (transport.sendTokenTransfer as any).mock.calls[0][1];
    const token = await engine.decodeToken(decodeTokenBlob(hexToBytes(sentPayload.tokenBlob)));
    expect(engine.readMemo(token)).toBeNull();  // not put on-chain
    expect(sentPayload.memo).toBe('thanks');    // still on the transport wire
  });
});
