/**
 * validate() — engine branch for v2 blob tokens.
 *
 * v2 blob tokens are verified via the engine (verify + isSpent); legacy v1 TXF
 * JSON tokens keep going through oracle.validateToken. Transient engine
 * failures must NOT mark a token invalid (fund-visibility safety) — the token
 * is skipped for that run. Clean harness (NO SDK vi.mock), mirrors
 * PaymentsModule.v2-receive.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { createPaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { FullIdentity, Token } from '../../../types';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase, HistoryRecord } from '../../../storage';
import { FakeTokenEngine } from '../token-engine/FakeTokenEngine';
import { encodeTokenBlob } from '../../../token-engine/token-blob';
import { bytesToHex } from '../../../core/crypto';

const FAKE_PRIVATE_KEY = 'a'.repeat(64);
const FAKE_PUBKEY = '02' + 'b'.repeat(64);
const UCT = '11'.repeat(32);

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

function mockTransport(): TransportProvider {
  return {
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue(null),
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
  tsp.set('local', mockTokenStorage());
  const oracle = mockOracle();
  const deps: PaymentsModuleDependencies = {
    identity: mockIdentity(), storage: mockStorage(), tokenStorageProviders: tsp,
    transport: mockTransport(), oracle, emitEvent: vi.fn(), tokenEngine: engine,
  };
  const module = createPaymentsModule({ debug: false });
  module.initialize(deps);
  return { module, engine, oracle };
}

/** Mint a v2 token to the engine's own identity and store it as a confirmed UI token. */
async function storeV2Token(
  module: ReturnType<typeof setup>['module'], engine: FakeTokenEngine, amount: bigint,
): Promise<Token> {
  const st = await engine.mint({
    recipientPubkey: engine.getIdentity().chainPubkey,
    value: { assets: [{ coinId: UCT, amount }] },
  });
  const token: Token = {
    id: `v2_${engine.tokenId(st)}`, coinId: UCT, symbol: 'UCT', name: 'UCT', decimals: 0,
    amount: amount.toString(), status: 'confirmed', createdAt: Date.now(), updatedAt: Date.now(),
    sdkData: bytesToHex(encodeTokenBlob(engine.encodeToken(st))),
  };
  await module.addToken(token);
  return token;
}

/** Store a legacy v1 TXF JSON token (engine cannot decode it). */
async function storeLegacyToken(module: ReturnType<typeof setup>['module']): Promise<Token> {
  const txf = {
    genesis: { data: { tokenId: 'aa'.repeat(34) } },
    state: { hash: 'bb'.repeat(32) },
  };
  const token: Token = {
    id: 'legacy_1', coinId: UCT, symbol: 'UCT', name: 'UCT', decimals: 0,
    amount: '50', status: 'confirmed', createdAt: Date.now(), updatedAt: Date.now(),
    sdkData: JSON.stringify(txf),
  };
  await module.addToken(token);
  return token;
}

describe('validate() — v2 engine branch', () => {
  it('classifies a verified, unspent v2 blob token as valid (status unchanged)', async () => {
    const { module, engine } = setup();
    const token = await storeV2Token(module, engine, 100n);

    const { valid, invalid } = await module.validate();

    expect(valid.map((t) => t.id)).toContain(token.id);
    expect(invalid).toHaveLength(0);
    expect(module.getTokens()[0].status).toBe('confirmed');
  });

  it('marks a v2 token failing engine verification as invalid', async () => {
    const { module, engine } = setup();
    const token = await storeV2Token(module, engine, 100n);
    vi.spyOn(engine, 'verify').mockResolvedValue({ ok: false, reason: 'NOT_AUTHENTICATED' });

    const { valid, invalid } = await module.validate();

    expect(valid).toHaveLength(0);
    expect(invalid.map((t) => t.id)).toContain(token.id);
    expect(invalid[0].status).toBe('invalid');
  });

  it('marks a spent v2 token as invalid', async () => {
    const { module, engine } = setup();
    const token = await storeV2Token(module, engine, 100n);
    vi.spyOn(engine, 'isSpent').mockResolvedValue(true);

    const { invalid } = await module.validate();

    expect(invalid.map((t) => t.id)).toContain(token.id);
  });

  it('skips (does NOT invalidate) a v2 token on a transient engine failure', async () => {
    const { module, engine } = setup();
    const token = await storeV2Token(module, engine, 100n);
    vi.spyOn(engine, 'isSpent').mockRejectedValue(new Error('network down'));

    const { valid, invalid } = await module.validate();

    expect(valid).toHaveLength(0);
    expect(invalid).toHaveLength(0);
    expect(module.getTokens().find((t) => t.id === token.id)?.status).toBe('confirmed');
  });

  it('routes legacy v1 TXF JSON tokens through oracle.validateToken', async () => {
    const { module, oracle } = setup();
    const token = await storeLegacyToken(module);

    const { valid } = await module.validate();

    expect(oracle.validateToken).toHaveBeenCalledWith(token.sdkData);
    expect(valid.map((t) => t.id)).toContain(token.id);
  });
});
