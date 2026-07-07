/**
 * PaymentsModule.send — Phase 6 v2 slim rebuild coverage.
 *
 * The v2 slim rebuild collapses the send pipeline into a straight-line:
 *   resolve peer → plan sources → per-asset engine op → encode outputs
 *   → transport.sendTokenTransfer → local state + history + event.
 *
 * Wave-6-P2-5 quarantined the v1-shaped tests (OUTBOX/SENT worker, dispatch
 * dedup, etc.). This suite locks in the v2 public contract:
 *
 *   - Happy-path single-coin send routes through engine.transfer or
 *     engine.split, delivers via transport.sendTokenTransfer with a
 *     `uxf-car` payload carrying the memo + sender identity, records SENT
 *     history with the resolved recipient DIRECT address, and fires the
 *     `transfer:confirmed` event.
 *   - Multi-asset send (primary + additionalAssets) issues one engine op
 *     per target and delivers a single bundle.
 *   - Split path fires when the source token holds MORE than needed; the
 *     change output is added back to the local wallet.
 *   - INSUFFICIENT_BALANCE surfaces as a failed result, not a throw.
 *   - Unresolvable recipient surfaces as a failed result, not a throw.
 *
 * The engine is a per-test in-memory fake — no network, no SDK, no crypto.
 * The transport's `sendTokenTransfer` is a spy so we can assert the
 * delivered payload shape.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  createPaymentsModule,
  type PaymentsModuleDependencies,
} from '../../../../modules/payments/PaymentsModule';
import type {
  FullIdentity,
  Token,
  SphereEventType,
  SphereEventMap,
} from '../../../../types';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../../../../storage';
import type { TransportProvider, PeerInfo } from '../../../../transport';
import type { OracleProvider } from '../../../../oracle';
import type {
  ITokenEngine,
  SphereToken,
  EngineIdentity,
  TokenBlob,
} from '../../../../token-engine';

// Local mutable view of FullIdentity for tests that need to flip fields.
type MutableFullIdentity = { -readonly [K in keyof FullIdentity]: FullIdentity[K] };

// SDK static-import mocks — the slim rebuild only touches these transitively
// via TokenRegistry; keep the registry deterministic.
vi.mock('../../../../registry', () => ({
  TokenRegistry: {
    getInstance: () => ({
      getDefinition: () => null,
      getIconUrl: () => null,
      getSymbol: (id: string) => id,
      getName: (id: string) => id,
      getDecimals: () => 8,
    }),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  },
}));

// ---------------------------------------------------------------------------
// Fake in-memory engine
// ---------------------------------------------------------------------------

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
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function makeFakeEngine(identity: EngineIdentity): ITokenEngine {
  const ownerHex = bytesToHex(identity.chainPubkey);
  return {
    getIdentity: () => identity,
    deriveIdentityAddress: async (pubkey?: Uint8Array) => {
      const hex = pubkey ? bytesToHex(pubkey) : ownerHex;
      return `DIRECT://${hex.slice(0, 20)}`;
    },
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
      const asset = value?.assets?.[0];
      if (!asset) throw new Error('mint needs value');
      return makeSphereToken(asset.coinId, asset.amount, bytesToHex(recipientPubkey));
    },
    mintDataToken: async () => {
      throw new Error('not used in this test');
    },
    transfer: async ({ token, recipientPubkey }) => {
      // Fresh SphereToken with same coin+amount, owner rebound to recipient.
      const v = token.value!;
      const asset = v.assets[0];
      return makeSphereToken(asset.coinId, asset.amount, bytesToHex(recipientPubkey));
    },
    split: async ({ outputs }) => {
      const out = outputs.map((o) =>
        makeSphereToken(o.coinId, o.amount, bytesToHex(o.recipientPubkey)),
      );
      return { outputs: out };
    },
    verify: async () => ({ ok: true }),
    isSpent: async () => false,
    isOwnedBy: (t, pubkey) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (t.sdkToken as any).ownerHex === bytesToHex(pubkey);
    },
    encodeToken: (t) => t.blob,
    decodeToken: async (blob) => {
      const parsed = JSON.parse(new TextDecoder().decode(blob.token)) as {
        tokenId: string;
        coinId: string;
        amount: string;
        owner: string;
      };
      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sdkToken: { tokenId: parsed.tokenId, coinId: parsed.coinId, amount: BigInt(parsed.amount), ownerHex: parsed.owner } as any,
        blob,
        value: { assets: [{ coinId: parsed.coinId, amount: BigInt(parsed.amount) }] },
      };
    },
    deliveryKeys: async (blobBytes) => {
      const hex = bytesToHex(blobBytes).slice(0, 64).padEnd(64, '0');
      return { tokenId: hex, stateHash: hex };
    },
  };
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const SENDER_PUBKEY_HEX = '02' + 'a'.repeat(64);
const RECIPIENT_PUBKEY_HEX = '03' + 'b'.repeat(64);

interface Harness {
  module: ReturnType<typeof createPaymentsModule>;
  identity: MutableFullIdentity;
  transport: TransportProvider;
  emitEvent: ReturnType<typeof vi.fn>;
  engine: ITokenEngine;
  events: Array<{ type: SphereEventType; data: unknown }>;
  sendTokenTransfer: ReturnType<typeof vi.fn>;
  resolve: ReturnType<typeof vi.fn>;
}

async function makeHarness(opts: {
  resolveResult?: PeerInfo | null;
  sendError?: Error;
} = {}): Promise<Harness> {
  const identity: MutableFullIdentity = {
    chainPubkey: SENDER_PUBKEY_HEX,
    directAddress: 'DIRECT://sender-abc',
    privateKey: '0x' + 'b'.repeat(64),
  };

  const mockStorage: StorageProvider = {
    id: 'mock-storage',
    name: 'Mock Storage',
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

  const tokenStorageProviders = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();

  const sendTokenTransfer = opts.sendError
    ? vi.fn().mockRejectedValue(opts.sendError)
    : vi.fn().mockResolvedValue('nostr-event-id-xyz');

  const resolve = vi.fn().mockResolvedValue(
    opts.resolveResult === undefined
      ? {
          nametag: 'bob',
          chainPubkey: RECIPIENT_PUBKEY_HEX,
          transportPubkey: 'c'.repeat(64),
          directAddress: 'DIRECT://bob-address',
          timestamp: Date.now(),
        }
      : opts.resolveResult,
  );

  const mockTransport = {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
    setIdentity: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as const),
    sendMessage: vi.fn(),
    onMessage: vi.fn().mockReturnValue(() => {}),
    sendTokenTransfer,
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve,
  } as unknown as TransportProvider;

  const mockOracle = {
    id: 'mock-oracle',
    name: 'Mock Oracle',
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

  const engine = makeFakeEngine({ chainPubkey: hexToBytes(SENDER_PUBKEY_HEX) });

  const module = createPaymentsModule();
  const deps: PaymentsModuleDependencies = {
    identity: identity as FullIdentity,
    storage: mockStorage,
    tokenStorageProviders,
    transport: mockTransport,
    oracle: mockOracle,
    emitEvent,
    tokenEngine: engine,
  };
  module.initialize(deps);

  return {
    module,
    identity,
    transport: mockTransport,
    emitEvent,
    engine,
    events,
    sendTokenTransfer,
    resolve,
  };
}

async function seedFungibleToken(
  h: Harness,
  coinId: string,
  amount: bigint,
): Promise<Token> {
  const result = await h.module.mintFungibleToken(coinId, amount);
  if (!result.success) throw new Error(`seed mint failed: ${result.error}`);
  return result.token;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PaymentsModule.send (v2 slim)', () => {
  beforeEach(() => {
    tokenSeq = 0;
  });

  it('happy path: single-coin send delivers a uxf-car payload with sender identity + memo', async () => {
    const h = await makeHarness();
    await seedFungibleToken(h, 'UCT', 1_000n);

    const result = await h.module.send({
      recipient: '@bob',
      coinId: 'UCT',
      amount: '1000',
      memo: 'thanks for lunch',
    });

    expect(result.status).toBe('delivered');
    expect(result.tokens).toHaveLength(1);
    expect(result.error).toBeUndefined();

    // The transport must have been called with a UXF payload carrying our
    // memo and sender identity.
    expect(h.sendTokenTransfer).toHaveBeenCalledTimes(1);
    const [recipientTransportPubkey, payload] = h.sendTokenTransfer.mock.calls[0];
    expect(recipientTransportPubkey).toBe('c'.repeat(64));
    expect(payload.kind).toBe('uxf-car');
    expect(payload.mode).toBe('instant');
    expect(payload.memo).toBe('thanks for lunch');
    expect(payload.sender.nametag).toBeUndefined(); // identity.nametag not set
    expect(Array.isArray(payload.tokenIds)).toBe(true);
    expect(payload.tokenIds.length).toBe(1);
    expect(typeof payload.bundleCid).toBe('string');
    expect(payload.bundleCid.startsWith('b')).toBe(true);

    // transfer:confirmed event fired with the delivered result.
    const confirmed = h.events.find((e) => e.type === 'transfer:confirmed');
    expect(confirmed).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((confirmed!.data as any).status).toBe('delivered');
  });

  it('records a SENT history entry with resolved recipient nametag + directAddress + memo', async () => {
    const h = await makeHarness();
    await seedFungibleToken(h, 'UCT', 500n);

    await h.module.send({
      recipient: '@bob',
      coinId: 'UCT',
      amount: '500',
      memo: 'INV:hash:F',
    });

    const history = h.module.getHistory();
    expect(history).toHaveLength(1);
    const sent = history[0];
    expect(sent.type).toBe('SENT');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sent as any).recipientNametag).toBe('bob');
    // v2-6c: recorded recipient address MUST come from peer resolution
    // (peer.directAddress), not the sender's own directAddress.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sent as any).recipientAddress).toBe('DIRECT://bob-address');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sent as any).memo).toBe('INV:hash:F');
    expect(sent.amount).toBe('500');
    expect(sent.coinId).toBe('UCT');
  });

  it('multi-asset send delivers all targets in one bundle', async () => {
    const h = await makeHarness();
    await seedFungibleToken(h, 'UCT', 1_000n);
    await seedFungibleToken(h, 'USDU', 2_000n);

    const result = await h.module.send({
      recipient: '@bob',
      coinId: 'UCT',
      amount: '1000',
      additionalAssets: [{ kind: 'coin', coinId: 'USDU', amount: '500' }],
    });

    expect(result.status).toBe('delivered');
    // 1 primary + 1 additional = 2 delivered tokens.
    expect(result.tokens).toHaveLength(2);
    // Single transport call — one bundle for the whole multi-asset send.
    expect(h.sendTokenTransfer).toHaveBeenCalledTimes(1);
    const payload = h.sendTokenTransfer.mock.calls[0][1];
    expect(payload.tokenIds.length).toBe(2);
  });

  it('split path: sending less than a source-token balance routes through engine.split and returns change to self', async () => {
    const h = await makeHarness();
    await seedFungibleToken(h, 'UCT', 1_000n);

    const splitSpy = vi.spyOn(h.engine, 'split');
    const transferSpy = vi.spyOn(h.engine, 'transfer');

    const result = await h.module.send({
      recipient: '@bob',
      coinId: 'UCT',
      amount: '300',
    });

    expect(result.status).toBe('delivered');
    expect(splitSpy).toHaveBeenCalledTimes(1);
    expect(transferSpy).not.toHaveBeenCalled();
    const splitCall = splitSpy.mock.calls[0][0];
    // Two outputs: recipient (300) + change back to self (700).
    expect(splitCall.outputs).toHaveLength(2);
    expect(splitCall.outputs[0].amount).toBe(300n);
    expect(splitCall.outputs[1].amount).toBe(700n);
    // Change output owner MUST be the sender's chain pubkey (not the recipient).
    expect(bytesToHex(splitCall.outputs[1].recipientPubkey)).toBe(SENDER_PUBKEY_HEX);
    // Local wallet retains a change token.
    const remainingUct = h.module
      .getTokens({ coinId: 'UCT' })
      .filter((t) => t.status === 'confirmed');
    expect(remainingUct).toHaveLength(1);
    expect(remainingUct[0].amount).toBe('700');
  });

  it('INSUFFICIENT_BALANCE surfaces as a failed result (no throw), and emits transfer:failed', async () => {
    const h = await makeHarness();
    await seedFungibleToken(h, 'UCT', 100n);

    const result = await h.module.send({
      recipient: '@bob',
      coinId: 'UCT',
      amount: '1000',
    });

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Insufficient balance/);
    const failed = h.events.find((e) => e.type === 'transfer:failed');
    expect(failed).toBeDefined();
    // Transport was never touched.
    expect(h.sendTokenTransfer).not.toHaveBeenCalled();
  });

  it('unresolvable recipient surfaces as a failed result (no throw)', async () => {
    const h = await makeHarness({ resolveResult: null });
    await seedFungibleToken(h, 'UCT', 1_000n);

    const result = await h.module.send({
      recipient: 'not-a-valid-recipient',
      coinId: 'UCT',
      amount: '100',
    });

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/INVALID_RECIPIENT|Unable to derive|Cannot resolve/);
    expect(h.sendTokenTransfer).not.toHaveBeenCalled();
  });

  it('zero primary amount is rejected', async () => {
    const h = await makeHarness();
    await seedFungibleToken(h, 'UCT', 1_000n);
    const result = await h.module.send({
      recipient: '@bob',
      coinId: 'UCT',
      amount: '0',
    });
    expect(result.status).toBe('failed');
  });

  it('transport send failure surfaces as failed status + error', async () => {
    const h = await makeHarness({ sendError: new Error('nostr publish blew up') });
    await seedFungibleToken(h, 'UCT', 1_000n);
    const result = await h.module.send({
      recipient: '@bob',
      coinId: 'UCT',
      amount: '1000',
    });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/nostr publish blew up/);
  });
});
