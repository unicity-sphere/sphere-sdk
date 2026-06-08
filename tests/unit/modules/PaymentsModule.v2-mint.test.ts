/**
 * v2 self-mint / top-up — mintFungibleToken engine branch (feat/v2-self-mint-topup).
 *
 * When a token engine is present, mintFungibleToken self-mints a FINISHED v2 token
 * via engine.mint and stores it as a confirmed wallet token (id v2_<id>), with no
 * commitment / inclusion-proof round-trip. Without an engine it falls back to the
 * legacy v1 path. Clean harness (NO SDK vi.mock) so FakeTokenEngine runs end-to-end.
 */
import { describe, it, expect, vi } from 'vitest';
import { createPaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { FullIdentity } from '../../../types';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase, HistoryRecord } from '../../../storage';
import { FakeTokenEngine } from '../token-engine/FakeTokenEngine';
import { decodeTokenBlob } from '../../../token-engine/token-blob';
import { hexToBytes } from '../../../core/crypto';

class ThrowingMintEngine extends FakeTokenEngine {
  mint(): Promise<never> {
    return Promise.reject(new Error('boom'));
  }
}

const FAKE_PRIVATE_KEY = 'a'.repeat(64);
const FAKE_PUBKEY = '02' + 'b'.repeat(64);
const UCT = '11'.repeat(32); // v2 coin ids are lowercase hex

function mockIdentity(): FullIdentity {
  return {
    chainPubkey: FAKE_PUBKEY, l1Address: 'alpha1x', directAddress: 'DIRECT://x',
    privateKey: FAKE_PRIVATE_KEY,
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
    resolveNametagInfo: vi.fn().mockResolvedValue(null),
    resolveTransportPubkeyInfo: vi.fn().mockResolvedValue(null),
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(), isConnected: () => true,
    publishNametag: vi.fn().mockResolvedValue(undefined),
    sendPaymentRequest: vi.fn().mockResolvedValue(undefined),
    sendPaymentRequestResponse: vi.fn().mockResolvedValue(undefined),
  } as unknown as TransportProvider;
}

function mockOracle(withStClient: boolean): OracleProvider {
  return {
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    // When withStClient is false the v1 mint path bails with a deterministic error,
    // which is what the "no engine -> v1 fallback" test asserts on.
    getStateTransitionClient: vi.fn().mockReturnValue(withStClient ? {} : undefined),
    getTrustBase: vi.fn().mockReturnValue(withStClient ? {} : undefined),
    isDevMode: () => false,
    waitForProofSdk: vi.fn().mockResolvedValue({ proof: 'mock' }),
  } as unknown as OracleProvider;
}

function setup(opts: { engine?: FakeTokenEngine | null; withStClient?: boolean } = {}) {
  const engine = opts.engine === undefined ? new FakeTokenEngine() : opts.engine;
  const tsp = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();
  tsp.set('local', mockTokenStorage());
  const emitEvent = vi.fn();
  const deps: PaymentsModuleDependencies = {
    identity: mockIdentity(), storage: mockStorage(), tokenStorageProviders: tsp,
    transport: mockTransport(), oracle: mockOracle(opts.withStClient ?? true), emitEvent,
    ...(engine ? { tokenEngine: engine } : {}),
  };
  const module = createPaymentsModule({ debug: false });
  module.initialize(deps);
  return { module, engine, emitEvent };
}

describe('mintFungibleToken — v2 engine self-mint (top-up)', () => {
  it('self-mints a confirmed v2 token and stores it', async () => {
    const { module } = setup();
    const res = await module.mintFungibleToken(UCT, 500n);

    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.tokenId).toMatch(/^[0-9a-f]{64}$/);

    const tokens = module.getTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].id).toBe(`v2_${res.tokenId}`);
    expect(tokens[0].coinId).toBe(UCT);
    expect(tokens[0].amount).toBe('500');
    expect(tokens[0].status).toBe('confirmed');
    // Registry-fallback: unregistered coin — symbol = first 6 chars uppercased, name = full coinId
    expect(tokens[0].symbol).toBe('111111');
    expect(tokens[0].name).toBe(UCT);
  });

  it('stores a blob that decodes back to the requested value (engine.balanceOf)', async () => {
    const { module, engine } = setup();
    const res = await module.mintFungibleToken(UCT, 750n);

    expect(res.success).toBe(true);
    if (!res.success || !engine) return;

    const stored = module.getTokens()[0];
    const token = await engine.decodeToken(decodeTokenBlob(hexToBytes(stored.sdkData!)));
    expect(engine.balanceOf(token, UCT)).toBe(750n);
  });

  it('rejects a non-positive amount without minting', async () => {
    const { module } = setup();
    const res = await module.mintFungibleToken(UCT, 0n);

    expect(res.success).toBe(false);
    expect(module.getTokens()).toHaveLength(0);
  });

  it('rejects a non-hex coin id without minting', async () => {
    const { module } = setup();
    const res = await module.mintFungibleToken('not-hex', 100n);

    expect(res.success).toBe(false);
    expect(module.getTokens()).toHaveLength(0);
  });

  it('rejects an odd-length hex coin id without minting', async () => {
    const { module } = setup();
    const res = await module.mintFungibleToken('abc', 100n);

    expect(res.success).toBe(false);
    expect(module.getTokens()).toHaveLength(0);
  });

  it('rejects an uppercase hex coin id without minting', async () => {
    const { module } = setup();
    const res = await module.mintFungibleToken('AB'.repeat(32), 100n);

    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toContain('lowercase');
    expect(module.getTokens()).toHaveLength(0);
  });

  it('returns a V2 mint failed error and stores nothing when engine.mint throws', async () => {
    const { module } = setup({ engine: new ThrowingMintEngine() });
    const res = await module.mintFungibleToken(UCT, 100n);

    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toContain('V2 mint failed');
    expect(res.error).toContain('boom');
    expect(module.getTokens()).toHaveLength(0);
  });
});

describe('mintFungibleToken — v1 fallback when no engine', () => {
  it('takes the v1 path and surfaces the v1 unavailability error', async () => {
    const { module } = setup({ engine: null, withStClient: false });
    const res = await module.mintFungibleToken(UCT, 100n);

    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toContain('State transition client not available');
    expect(module.getTokens()).toHaveLength(0);
  });
});
