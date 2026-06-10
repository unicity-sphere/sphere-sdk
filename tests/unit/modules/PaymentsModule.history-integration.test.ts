/**
 * Integration tests for L3 transaction history deduplication (v2 engine).
 *
 * Verifies that each logical operation (send, receive) produces exactly ONE
 * history entry — even though tokens pass through multiple internal methods
 * (addToken, removeToken, storeEngineToken) along the way.
 *
 * Covers:
 * 1. send() with multiple direct tokens → 1 SENT entry (removeToken creates none)
 * 2. send() with an engine split → 1 SENT entry (change-token storage creates none)
 * 3. send() preserves memo and recipient metadata in history
 * 4. V2_TRANSFER receive → 1 RECEIVED entry (storeEngineToken creates none)
 * 5. V2 receive populates sender info via resolveSenderInfo
 * 6. V2 receive passes memo into history
 * 7. Re-delivered identical V2 payload → still 1 entry (dedup by genesis token id)
 * 8. resolveSenderInfo() — transport resolution and error handling
 * 9. history:updated event on addToHistory
 *
 * Clean harness (no SDK vi.mock): the FakeTokenEngine, the real SpendPlanner /
 * SpendQueue and the real send/receive paths run end-to-end.
 */

import { describe, it, expect, vi } from 'vitest';
import { createPaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { Token, FullIdentity } from '../../../types';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase, HistoryRecord } from '../../../storage';
import type { V2TransferPayload } from '../../../types/v2-transfer';
import { FakeTokenEngine } from '../token-engine/FakeTokenEngine';
import { encodeTokenBlob } from '../../../token-engine/token-blob';
import { bytesToHex } from '../../../core/crypto';

// =============================================================================
// Constants
// =============================================================================

const FAKE_PRIVATE_KEY = 'a'.repeat(64);
const FAKE_PUBKEY = '02' + 'b'.repeat(64);
const SENDER_TRANSPORT_PUBKEY = 'cc'.repeat(32);
const BOB_CHAIN_PUBKEY = '02' + 'ee'.repeat(32); // recipient's 33-byte chain pubkey (hex)
const RECIPIENT_DIRECT_ADDRESS = 'DIRECT://recipient';
const UCT = '11'.repeat(32); // v2 coin ids are lowercase hex

// =============================================================================
// Helpers
// =============================================================================

function createMockIdentity(): FullIdentity {
  return {
    chainPubkey: FAKE_PUBKEY,
    l1Address: 'alpha1testaddr',
    directAddress: 'DIRECT://testaddr',
    privateKey: FAKE_PRIVATE_KEY,
    transportPubkey: 'dd'.repeat(32),
  };
}

/** In-memory history store that mimics IndexedDB / File history store */
function createMockHistoryStore() {
  const entries = new Map<string, HistoryRecord>();
  return {
    addHistoryEntry: vi.fn(async (entry: HistoryRecord) => {
      entries.set(entry.dedupKey, entry);
    }),
    getHistoryEntries: vi.fn(async () =>
      [...entries.values()].sort((a, b) => b.timestamp - a.timestamp),
    ),
    hasHistoryEntry: vi.fn(async (key: string) => entries.has(key)),
    clearHistory: vi.fn(async () => entries.clear()),
    importHistoryEntries: vi.fn(async (importEntries: HistoryRecord[]) => {
      let count = 0;
      for (const e of importEntries) {
        if (!entries.has(e.dedupKey)) { entries.set(e.dedupKey, e); count++; }
      }
      return count;
    }),
    _entries: entries,
  };
}

function createMockStorage(): StorageProvider {
  const store = new Map<string, string>();
  return {
    id: 'mock-storage',
    name: 'Mock Storage',
    type: 'local',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    remove: vi.fn(async (key: string) => { store.delete(key); }),
    has: vi.fn(async (key: string) => store.has(key)),
    keys: vi.fn(async () => Array.from(store.keys())),
    clear: vi.fn(async () => { store.clear(); }),
  } as unknown as StorageProvider;
}

function createMockTransport(senderNametag?: string): TransportProvider {
  return {
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue({
      chainPubkey: BOB_CHAIN_PUBKEY,
      transportPubkey: 'bob-transport-pubkey',
      directAddress: RECIPIENT_DIRECT_ADDRESS,
      nametag: 'bob',
    }),
    resolveNametagInfo: vi.fn().mockResolvedValue(null),
    resolveTransportPubkeyInfo: vi.fn().mockResolvedValue({
      chainPubkey: FAKE_PUBKEY,
      transportPubkey: SENDER_TRANSPORT_PUBKEY,
      directAddress: 'DIRECT://sender',
      nametag: senderNametag ?? 'alice',
    }),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    publishNametag: vi.fn().mockResolvedValue(undefined),
    sendPaymentRequest: vi.fn().mockResolvedValue(undefined),
    sendPaymentRequestResponse: vi.fn().mockResolvedValue(undefined),
  } as unknown as TransportProvider;
}

function createMockOracle(): OracleProvider {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    getTrustBaseJson: vi.fn().mockReturnValue(null),
    getAggregatorUrl: vi.fn().mockReturnValue(null),
    getApiKey: vi.fn().mockReturnValue(null),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    onEvent: vi.fn().mockReturnValue(() => {}),
  } as unknown as OracleProvider;
}

interface TestContext {
  module: ReturnType<typeof createPaymentsModule>;
  deps: PaymentsModuleDependencies;
  engine: FakeTokenEngine;
  historyStore: ReturnType<typeof createMockHistoryStore>;
  transport: TransportProvider;
}

function setupModule(senderNametag?: string): TestContext {
  const engine = new FakeTokenEngine();
  const historyStore = createMockHistoryStore();
  const transport = createMockTransport(senderNametag);

  const mockTokenStorage = {
    id: 'mock-token-storage',
    name: 'Mock Token Storage',
    type: 'local' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    initialize: vi.fn().mockResolvedValue(true),
    shutdown: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue({ success: true, timestamp: Date.now() }),
    load: vi.fn().mockResolvedValue({ success: false, source: 'local' as const, timestamp: Date.now() }),
    sync: vi.fn().mockResolvedValue({ success: true, added: 0, removed: 0, conflicts: 0 }),
    ...historyStore,
  } as unknown as TokenStorageProvider<TxfStorageDataBase>;

  const tokenStorageProviders = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();
  tokenStorageProviders.set('local', mockTokenStorage);

  const deps: PaymentsModuleDependencies = {
    identity: createMockIdentity(),
    storage: createMockStorage(),
    tokenStorageProviders,
    transport,
    oracle: createMockOracle(),
    tokenEngine: engine,
    emitEvent: vi.fn(),
  };

  const module = createPaymentsModule({ debug: false });
  module.initialize(deps);

  return { module, deps, engine, historyStore, transport };
}

/** Mint a v2 engine token owned by this wallet and add it via addToken (no history). */
async function addOwnedToken(ctx: TestContext, amount: bigint): Promise<Token> {
  const minted = await ctx.engine.mint({
    recipientPubkey: ctx.engine.getIdentity().chainPubkey,
    value: { assets: [{ coinId: UCT, amount }] },
  });
  const sdkData = bytesToHex(encodeTokenBlob(ctx.engine.encodeToken(minted)));
  const token: Token = {
    id: `v2_${ctx.engine.tokenId(minted)}`,
    coinId: UCT,
    symbol: 'UCT',
    name: 'Unicity Token',
    decimals: 8,
    amount: String(amount),
    status: 'confirmed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sdkData,
  };
  await ctx.module.addToken(token);
  return token;
}

/** Build a V2_TRANSFER payload carrying a finished token minted to this wallet. */
async function v2Payload(
  engine: FakeTokenEngine,
  amount: bigint,
  memo?: string,
): Promise<V2TransferPayload> {
  const st = await engine.mint({
    recipientPubkey: engine.getIdentity().chainPubkey,
    value: { assets: [{ coinId: UCT, amount }] },
  });
  return { type: 'V2_TRANSFER', version: '2.0', tokenBlob: bytesToHex(encodeTokenBlob(engine.encodeToken(st))), memo };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function deliver(ctx: TestContext, payload: V2TransferPayload, id = 'nostr-evt-1') {
  return (ctx.module as any).handleIncomingTransfer({
    id,
    senderTransportPubkey: SENDER_TRANSPORT_PUBKEY,
    payload,
    timestamp: Date.now(),
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// =============================================================================
// Tests
// =============================================================================

describe('History deduplication — integration flows', () => {

  // ===========================================================================
  // send() flow
  // ===========================================================================

  describe('send() → single SENT history entry', () => {
    it('should create exactly 1 SENT entry for 2 direct tokens', async () => {
      const ctx = setupModule();
      await addOwnedToken(ctx, 1000000n);
      await addOwnedToken(ctx, 2000000n);

      await ctx.module.send({
        recipient: '@bob',
        amount: '3000000',
        coinId: UCT,
      });

      // Two whole-token transfers went out on the wire...
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      expect((ctx.transport.sendTokenTransfer as any).mock.calls).toHaveLength(2);

      // ...but exactly ONE SENT history entry was recorded.
      const history = ctx.module.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].type).toBe('SENT');
      expect(history[0].amount).toBe('3000000');
      expect(history[0].coinId).toBe(UCT);
    });

    it('should create exactly 1 SENT entry for an engine split', async () => {
      const ctx = setupModule();
      await addOwnedToken(ctx, 10000000n);

      await ctx.module.send({
        recipient: '@bob',
        amount: '3000000',
        coinId: UCT,
      });

      // The change token (7000000) was stored confirmed — without history.
      const tokens = ctx.module.getTokens();
      expect(tokens).toHaveLength(1);
      expect(tokens[0].amount).toBe('7000000');
      expect(tokens[0].status).toBe('confirmed');

      const history = ctx.module.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].type).toBe('SENT');
      expect(history[0].amount).toBe('3000000');
    });

    it('should preserve memo in SENT history entry', async () => {
      const ctx = setupModule();
      await addOwnedToken(ctx, 5000000n);

      await ctx.module.send({
        recipient: '@bob',
        amount: '5000000',
        coinId: UCT,
        memo: 'Payment for coffee',
      });

      const history = ctx.module.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].memo).toBe('Payment for coffee');
    });

    it('should populate recipient metadata from peerInfo', async () => {
      const ctx = setupModule();
      await addOwnedToken(ctx, 1000000n);

      await ctx.module.send({
        recipient: '@bob',
        amount: '1000000',
        coinId: UCT,
      });

      const history = ctx.module.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].recipientNametag).toBe('bob');
      expect(history[0].recipientAddress).toBe(RECIPIENT_DIRECT_ADDRESS);
    });

    it('should NOT create history entries from removeToken during send', async () => {
      const ctx = setupModule();
      const addToHistorySpy = vi.spyOn(ctx.module, 'addToHistory');
      await addOwnedToken(ctx, 1000000n);

      await ctx.module.send({
        recipient: '@bob',
        amount: '1000000',
        coinId: UCT,
      });

      // The source token was consumed and removed from the wallet...
      expect(ctx.module.getTokens()).toHaveLength(0);

      // ...and addToHistory was called exactly once — from the send() success
      // path, not from removeToken.
      expect(addToHistorySpy).toHaveBeenCalledTimes(1);
      expect(addToHistorySpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'SENT' }),
      );
    });
  });

  // ===========================================================================
  // V2 transfer receive flow
  // ===========================================================================

  describe('V2 transfer receive → single RECEIVED entry', () => {
    it('should create exactly 1 RECEIVED entry', async () => {
      const ctx = setupModule();

      await deliver(ctx, await v2Payload(ctx.engine, 500000n, 'hello'));

      const history = ctx.module.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].type).toBe('RECEIVED');
      expect(history[0].amount).toBe('500000');
      expect(history[0].coinId).toBe(UCT);
    });

    it('should populate sender info via resolveSenderInfo', async () => {
      const ctx = setupModule('alice');

      await deliver(ctx, await v2Payload(ctx.engine, 500000n));

      const history = ctx.module.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].senderPubkey).toBe(SENDER_TRANSPORT_PUBKEY);
      expect(history[0].senderNametag).toBe('alice');
      expect(history[0].senderAddress).toBe('DIRECT://sender');
    });

    it('should preserve memo in RECEIVED entry', async () => {
      const ctx = setupModule();

      await deliver(ctx, await v2Payload(ctx.engine, 500000n, 'Thanks!'));

      const history = ctx.module.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].memo).toBe('Thanks!');
    });

    it('should not create a second entry for a re-delivered identical payload', async () => {
      const ctx = setupModule();

      const payload = await v2Payload(ctx.engine, 500000n);
      await deliver(ctx, payload, 'evt-1');
      // Same payload again (Nostr re-delivery)
      await deliver(ctx, payload, 'evt-2');

      // Dedup: the genesis-stable token id blocks the second delivery
      expect(ctx.module.getTokens()).toHaveLength(1);
      expect(ctx.module.getHistory()).toHaveLength(1);
    });

    it('should emit transfer:incoming with senderNametag and memo', async () => {
      const ctx = setupModule('alice');

      await deliver(ctx, await v2Payload(ctx.engine, 500000n, 'test memo'));

      expect(ctx.deps.emitEvent).toHaveBeenCalledWith(
        'transfer:incoming',
        expect.objectContaining({
          senderNametag: 'alice',
          memo: 'test memo',
        }),
      );
    });
  });

  // ===========================================================================
  // resolveSenderInfo
  // ===========================================================================

  describe('resolveSenderInfo', () => {
    it('should resolve nametag and address from transport', async () => {
      const ctx = setupModule('alice');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = ctx.module as any;

      const info = await mod.resolveSenderInfo(SENDER_TRANSPORT_PUBKEY);
      expect(info.senderNametag).toBe('alice');
      expect(info.senderAddress).toBe('DIRECT://sender');
    });

    it('should return empty object when transport throws', async () => {
      const ctx = setupModule();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ctx.transport as any).resolveTransportPubkeyInfo = vi.fn().mockRejectedValue(new Error('network error'));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = ctx.module as any;

      const info = await mod.resolveSenderInfo(SENDER_TRANSPORT_PUBKEY);
      expect(info).toEqual({});
    });

    it('should return empty object when transport lacks resolveTransportPubkeyInfo', async () => {
      const ctx = setupModule();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (ctx.transport as any).resolveTransportPubkeyInfo;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = ctx.module as any;

      const info = await mod.resolveSenderInfo(SENDER_TRANSPORT_PUBKEY);
      expect(info).toEqual({});
    });

    it('should return empty object when resolveTransportPubkeyInfo returns null', async () => {
      const ctx = setupModule();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ctx.transport as any).resolveTransportPubkeyInfo = vi.fn().mockResolvedValue(null);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = ctx.module as any;

      const info = await mod.resolveSenderInfo(SENDER_TRANSPORT_PUBKEY);
      expect(info).toEqual({});
    });
  });

  // ===========================================================================
  // history:updated event
  // ===========================================================================

  describe('history:updated event', () => {
    it('should emit history:updated when addToHistory is called', async () => {
      const ctx = setupModule();

      await ctx.module.addToHistory({
        type: 'RECEIVED',
        amount: '100',
        coinId: 'UCT',
        symbol: 'UCT',
        timestamp: Date.now(),
        tokenId: 'evt-token',
      });

      expect(ctx.deps.emitEvent).toHaveBeenCalledWith(
        'history:updated',
        expect.objectContaining({
          type: 'RECEIVED',
          amount: '100',
          dedupKey: 'RECEIVED_evt-token',
        }),
      );
    });
  });
});
