/**
 * PaymentsModule read-model — Phase 6 v2 slim rebuild coverage.
 *
 * Covers the read-only surface (`getBalance`, `getAssets`, `getTokens`,
 * `getToken`, `getHistory`, `getFiatBalance`) that the slim rebuild
 * inherits from the `./read-model` submodule. Wave-6-P2-5 quarantined
 * the exhaustive v1 tests; this suite locks in the shape and filtering
 * semantics against the v2 slim wiring.
 *
 * The engine is a minimal fake that lets us mint tokens directly through
 * `PaymentsModule.mintFungibleToken` so we exercise the same in-memory
 * paths the real send/receive pipelines use.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  createPaymentsModule,
  type PaymentsModuleDependencies,
} from '../../../../modules/payments/PaymentsModule';
import type { FullIdentity, Token, SphereEventType, SphereEventMap } from '../../../../types';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../../../../storage';
import type { TransportProvider } from '../../../../transport';
import type { OracleProvider } from '../../../../oracle';
import type {
  ITokenEngine,
  SphereToken,
  TokenBlob,
  EngineIdentity,
} from '../../../../token-engine';

type MutableFullIdentity = { -readonly [K in keyof FullIdentity]: FullIdentity[K] };

vi.mock('../../../../registry', () => ({
  TokenRegistry: {
    getInstance: () => ({
      getDefinition: (id: string) => ({
        symbol: id.slice(0, 4).toUpperCase(),
        name: id,
        decimals: 8,
        icons: [],
      }),
      getIconUrl: () => null,
      getSymbol: (id: string) => id.slice(0, 4).toUpperCase(),
      getName: (id: string) => id,
      getDecimals: () => 8,
    }),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  },
}));

let tokenSeq = 0;
function makeSphereToken(coinId: string, amount: bigint, ownerHex: string): SphereToken {
  tokenSeq++;
  const tokenId = `token-${tokenSeq.toString().padStart(4, '0')}`;
  const blob: TokenBlob = {
    v: 1,
    network: 2,
    tokenId,
    token: new TextEncoder().encode(
      JSON.stringify({ tokenId, coinId, amount: amount.toString(), owner: ownerHex }),
    ),
  };
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sdkToken: { tokenId, coinId, amount, ownerHex } as any,
    blob,
    value: { assets: [{ coinId, amount }] },
  };
}
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '').toLowerCase();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}
function makeFakeEngine(identity: EngineIdentity): ITokenEngine {
  return {
    getIdentity: () => identity,
    deriveIdentityAddress: async () => 'DIRECT://self',
    tokenId: (t) => t.blob.tokenId,
    readValue: (t) => t.value,
    balanceOf: (t, coinId) => {
      if (!t.value) return 0n;
      const a = t.value.assets.find((x) => x.coinId === coinId);
      return a ? a.amount : 0n;
    },
    readMemo: () => null,
    readTokenData: () => null,
    mint: async ({ recipientPubkey, value }) => {
      const a = value!.assets[0];
      return makeSphereToken(a.coinId, a.amount, bytesToHex(recipientPubkey));
    },
    mintDataToken: async () => {
      throw new Error('unused');
    },
    transfer: async () => {
      throw new Error('unused');
    },
    split: async () => ({ outputs: [] }),
    verify: async () => ({ ok: true }),
    isSpent: async () => false,
    isOwnedBy: () => true,
    encodeToken: (t) => t.blob,
    decodeToken: async () => {
      throw new Error('unused');
    },
    deliveryKeys: async () => ({ tokenId: '0'.repeat(64), stateHash: '0'.repeat(64) }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

async function makeHarness(): Promise<{
  module: ReturnType<typeof createPaymentsModule>;
  identity: MutableFullIdentity;
}> {
  const identity: MutableFullIdentity = {
    chainPubkey: '02' + 'a'.repeat(64),
    directAddress: 'DIRECT://self',
    privateKey: '0x' + 'b'.repeat(64),
  };
  const storage: StorageProvider = {
    id: 's',
    name: 's',
    type: 'local',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    has: vi.fn().mockResolvedValue(false),
    keys: vi.fn().mockResolvedValue([]),
    clear: vi.fn().mockResolvedValue(undefined),
    saveTrackedAddresses: vi.fn().mockResolvedValue(undefined),
    loadTrackedAddresses: vi.fn().mockResolvedValue([]),
  };
  const transport = {
    id: 't',
    name: 't',
    type: 'p2p' as const,
    setIdentity: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as const),
    sendMessage: vi.fn(),
    onMessage: vi.fn().mockReturnValue(() => {}),
    sendTokenTransfer: vi.fn(),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
  } as unknown as TransportProvider;
  const oracle = {
    id: 'o',
    name: 'o',
    type: 'aggregator' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as const),
    initialize: vi.fn().mockResolvedValue(undefined),
  } as unknown as OracleProvider;
  const events: Array<{ type: SphereEventType; data: unknown }> = [];
  const emitEvent = vi.fn(<T extends SphereEventType>(type: T, data: SphereEventMap[T]) => {
    events.push({ type, data });
  });
  const module = createPaymentsModule();
  const tokenStorageProviders = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();
  const deps: PaymentsModuleDependencies = {
    identity: identity as FullIdentity,
    storage,
    tokenStorageProviders,
    transport,
    oracle,
    emitEvent,
    tokenEngine: makeFakeEngine({ chainPubkey: hexToBytes(identity.chainPubkey) }),
  };
  module.initialize(deps);
  return { module, identity };
}

async function mint(
  module: ReturnType<typeof createPaymentsModule>,
  coinId: string,
  amount: bigint,
): Promise<Token> {
  const r = await module.mintFungibleToken(coinId, amount);
  if (!r.success) throw new Error(r.error);
  return r.token;
}

describe('PaymentsModule read-model (v2 slim)', () => {
  beforeEach(() => {
    tokenSeq = 0;
  });

  it('getTokens() returns every added token; filter by coinId narrows the set', async () => {
    const { module } = await makeHarness();
    await mint(module, 'UCTHEXCOIN', 100n);
    await mint(module, 'UCTHEXCOIN', 250n);
    await mint(module, 'USDUHEXID', 500n);

    expect(module.getTokens()).toHaveLength(3);
    const uct = module.getTokens({ coinId: 'UCTHEXCOIN' });
    expect(uct).toHaveLength(2);
    uct.forEach((t) => expect(t.coinId).toBe('UCTHEXCOIN'));
  });

  it('getTokens({status}) filters by status', async () => {
    const { module } = await makeHarness();
    const t = await mint(module, 'UCTHEXCOIN', 100n);
    // All minted tokens start 'confirmed' via the slim rebuild.
    expect(module.getTokens({ status: 'confirmed' })).toHaveLength(1);
    // Nothing pending yet.
    expect(module.getTokens({ status: 'pending' })).toHaveLength(0);
    expect(t.status).toBe('confirmed');
  });

  it('getToken(id) returns undefined for an unknown id, the exact Token for a known one', async () => {
    const { module } = await makeHarness();
    const t = await mint(module, 'UCTHEXCOIN', 100n);
    expect(module.getToken(t.id)).toBeDefined();
    expect(module.getToken('does-not-exist')).toBeUndefined();
  });

  it('getBalance() aggregates by coinId with confirmed/unconfirmed breakdown', async () => {
    const { module } = await makeHarness();
    await mint(module, 'UCTHEXCOIN', 100n);
    await mint(module, 'UCTHEXCOIN', 250n);
    await mint(module, 'USDUHEXID', 500n);

    const assets = module.getBalance();
    expect(assets.length).toBe(2);
    const uct = assets.find((a) => a.coinId === 'UCTHEXCOIN')!;
    expect(uct.totalAmount).toBe('350');
    expect(uct.tokenCount).toBe(2);
    expect(uct.confirmedAmount).toBe('350');
    expect(uct.confirmedTokenCount).toBe(2);
    expect(uct.unconfirmedAmount).toBe('0');
    expect(uct.unconfirmedTokenCount).toBe(0);

    // Filter by coinId narrows down.
    const usduOnly = module.getBalance('USDUHEXID');
    expect(usduOnly).toHaveLength(1);
    expect(usduOnly[0].coinId).toBe('USDUHEXID');
    expect(usduOnly[0].totalAmount).toBe('500');
  });

  it('getAssets() returns the same aggregated shape as getBalance() (v2 slim behaviour)', async () => {
    const { module } = await makeHarness();
    await mint(module, 'UCTHEXCOIN', 100n);

    const assets = await module.getAssets();
    expect(assets).toHaveLength(1);
    expect(assets[0].coinId).toBe('UCTHEXCOIN');
    expect(assets[0].totalAmount).toBe('100');
    // No PriceProvider wired — fiat fields must be null (never NaN, never 0).
    expect(assets[0].priceUsd).toBeNull();
    expect(assets[0].fiatValueUsd).toBeNull();
  });

  it('getFiatBalance() returns null when no PriceProvider is wired', async () => {
    const { module } = await makeHarness();
    await mint(module, 'UCTHEXCOIN', 100n);
    const balance = await module.getFiatBalance();
    expect(balance).toBeNull();
  });

  it('getHistory() sorts entries newest-first (descending by timestamp)', async () => {
    const { module } = await makeHarness();
    // Seed a couple of arbitrary history entries.
    await module.addToHistory({
      type: 'SENT',
      amount: '100',
      coinId: 'UCTHEXCOIN',
      symbol: 'UCTH',
      timestamp: 1000,
      transferId: 'tx-1',
      tokenIds: [],
    });
    await module.addToHistory({
      type: 'RECEIVED',
      amount: '200',
      coinId: 'UCTHEXCOIN',
      symbol: 'UCTH',
      timestamp: 3000,
      transferId: 'tx-2',
      tokenIds: [],
    });
    await module.addToHistory({
      type: 'SENT',
      amount: '300',
      coinId: 'UCTHEXCOIN',
      symbol: 'UCTH',
      timestamp: 2000,
      transferId: 'tx-3',
      tokenIds: [],
    });
    const h = module.getHistory();
    expect(h.map((e) => e.timestamp)).toEqual([3000, 2000, 1000]);
  });

  it('getPendingTransfers() returns an empty list when no send is in-flight', async () => {
    const { module } = await makeHarness();
    expect(module.getPendingTransfers()).toEqual([]);
  });
});
