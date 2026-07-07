/**
 * PaymentsModule.receive — Phase 6 v2 slim rebuild coverage.
 *
 * The v2 slim rebuild's receive path:
 *   transport.onTokenTransfer fires with a uxf-car payload
 *     → extract inline base64-CBOR blobs
 *     → engine.decodeToken + isOwnedBy + verify per blob
 *     → addTokenInternal (persist)
 *     → resolve senderAddress via transport.resolveTransportPubkeyInfo
 *     → recordHistory('RECEIVED', memo, recipientAddress, senderAddress)
 *     → emitEvent('transfer:incoming', ...)
 *
 * Wave-6-P2-5 quarantined the v1 receive-path tests (V6-recover, sending
 * recovery worker, etc.). This suite locks in the v2 contract for the
 * happy path plus the two invariants patched in wave 6-P2-6c/d:
 *   - memo propagates from payload → IncomingTransfer.memo AND
 *     RECEIVED-history.memo
 *   - senderAddress resolves via transport binding lookup and lands on
 *     both IncomingTransfer.senderAddress AND RECEIVED-history.senderAddress
 *     (feeds AccountingModule's auto-return routing)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  createPaymentsModule,
  type PaymentsModuleDependencies,
} from '../../../../modules/payments/PaymentsModule';
import type {
  FullIdentity,
  IncomingTransfer,
  SphereEventType,
  SphereEventMap,
} from '../../../../types';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../../../../storage';
import type {
  TransportProvider,
  IncomingTokenTransfer,
  TokenTransferHandler,
} from '../../../../transport';
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
// In-memory engine (mirrors send test's shape)
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
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function makeFakeEngine(identity: EngineIdentity): ITokenEngine {
  const ownerHex = bytesToHex(identity.chainPubkey);
  return {
    getIdentity: () => identity,
    deriveIdentityAddress: async (pubkey?: Uint8Array) =>
      `DIRECT://${bytesToHex(pubkey ?? identity.chainPubkey).slice(0, 20)}`,
    tokenId: (t) => t.blob.tokenId,
    readValue: (t) => t.value,
    balanceOf: (t, coinId) => {
      if (!t.value) return 0n;
      const a = t.value.assets.find((x) => x.coinId === coinId);
      return a ? a.amount : 0n;
    },
    readMemo: () => null,
    readTokenData: () => null,
    mint: async () => {
      throw new Error('unused');
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
        blob: { ...blob, tokenId: parsed.tokenId },
        value: { assets: [{ coinId: parsed.coinId, amount: BigInt(parsed.amount) }] },
      };
    },
    deliveryKeys: async (blobBytes) => {
      const hex = bytesToHex(blobBytes).slice(0, 64).padEnd(64, '0');
      return { tokenId: hex, stateHash: hex };
    },
    // Own-consumption: dev shim so send-path (unused here) still typechecks.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void ownerHex;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const RECEIVER_PUBKEY_HEX = '02' + 'a'.repeat(64);
const SENDER_TRANSPORT_PUBKEY = 'e'.repeat(64);
const SENDER_DIRECT_ADDRESS = 'DIRECT://sender-original';

interface Harness {
  module: ReturnType<typeof createPaymentsModule>;
  identity: MutableFullIdentity;
  emitEvent: ReturnType<typeof vi.fn>;
  events: Array<{ type: SphereEventType; data: unknown }>;
  engine: ITokenEngine;
  handler: TokenTransferHandler;
  resolveTransportPubkeyInfo: ReturnType<typeof vi.fn>;
}

async function makeHarness(): Promise<Harness> {
  const identity: MutableFullIdentity = {
    chainPubkey: RECEIVER_PUBKEY_HEX,
    directAddress: 'DIRECT://receiver-abc',
    privateKey: '0x' + 'c'.repeat(64),
  };

  const storage: StorageProvider = {
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

  let capturedHandler: TokenTransferHandler | null = null;
  const resolveTransportPubkeyInfo = vi.fn().mockResolvedValue({
    chainPubkey: '02' + 'e'.repeat(64),
    transportPubkey: SENDER_TRANSPORT_PUBKEY,
    directAddress: SENDER_DIRECT_ADDRESS,
    timestamp: Date.now(),
  });

  const transport = {
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
    sendTokenTransfer: vi.fn(),
    onTokenTransfer: vi.fn((h: TokenTransferHandler) => {
      capturedHandler = h;
      return () => {
        capturedHandler = null;
      };
    }),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolveTransportPubkeyInfo,
  } as unknown as TransportProvider;

  const oracle = {
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

  const engine = makeFakeEngine({ chainPubkey: hexToBytes(RECEIVER_PUBKEY_HEX) });

  const module = createPaymentsModule();
  const tokenStorageProviders = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();
  const deps: PaymentsModuleDependencies = {
    identity: identity as FullIdentity,
    storage,
    tokenStorageProviders,
    transport,
    oracle,
    emitEvent,
    tokenEngine: engine,
  };
  module.initialize(deps);

  if (!capturedHandler) throw new Error('handler was not captured');

  return {
    module,
    identity,
    emitEvent,
    events,
    engine,
    handler: capturedHandler,
    resolveTransportPubkeyInfo,
  };
}

/**
 * Build a uxf-car IncomingTokenTransfer whose payload carries one token
 * blob owned by the given owner hex.
 */
function buildIncoming(
  ownerHex: string,
  opts: { memo?: string; coinId?: string; amount?: bigint } = {},
): IncomingTokenTransfer {
  const coinId = opts.coinId ?? 'UCT';
  const amount = opts.amount ?? 100n;
  const st = makeSphereToken(coinId, amount, ownerHex);
  const encoded = [
    {
      v: st.blob.v,
      network: st.blob.network,
      tokenId: st.blob.tokenId,
      token: Buffer.from(st.blob.token).toString('base64'),
    },
  ];
  const carBase64 = Buffer.from(JSON.stringify({ tokens: encoded })).toString('base64');
  return {
    id: 'nostr-event-' + tokenSeq,
    senderTransportPubkey: SENDER_TRANSPORT_PUBKEY,
    payload: {
      kind: 'uxf-car',
      version: '1.0',
      mode: 'instant',
      bundleCid: 'bfake123',
      tokenIds: [st.blob.tokenId],
      sender: {
        transportPubkey: '02' + 'e'.repeat(64),
        nametag: 'alice',
      },
      ...(opts.memo !== undefined ? { memo: opts.memo } : {}),
      carBase64,
    },
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PaymentsModule.receive (v2 slim)', () => {
  beforeEach(() => {
    tokenSeq = 0;
  });

  it('accepts a token addressed to us and adds it to the local wallet', async () => {
    const h = await makeHarness();
    const durable = await h.handler(buildIncoming(RECEIVER_PUBKEY_HEX));
    expect(durable).toBe(true);

    const tokens = h.module.getTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].coinId).toBe('UCT');
    expect(tokens[0].amount).toBe('100');
    expect(tokens[0].status).toBe('confirmed');
  });

  it('drops a token NOT owned by us (isOwnedBy returns false)', async () => {
    const h = await makeHarness();
    const durable = await h.handler(buildIncoming('02' + 'z'.repeat(64)));
    expect(durable).toBe(true);
    expect(h.module.getTokens()).toHaveLength(0);
    // No transfer:incoming when nothing was accepted.
    const incoming = h.events.find((e) => e.type === 'transfer:incoming');
    expect(incoming).toBeUndefined();
  });

  it('emits transfer:incoming with memo + senderNametag + senderAddress', async () => {
    const h = await makeHarness();
    await h.handler(buildIncoming(RECEIVER_PUBKEY_HEX, { memo: 'INV:hash:F' }));

    const incoming = h.events.find((e) => e.type === 'transfer:incoming');
    expect(incoming).toBeDefined();
    const payload = incoming!.data as IncomingTransfer;
    expect(payload.senderPubkey).toBe(SENDER_TRANSPORT_PUBKEY);
    expect(payload.senderNametag).toBe('alice');
    expect(payload.memo).toBe('INV:hash:F');
    // v2-6d: senderAddress resolved via transport binding lookup.
    expect(payload.senderAddress).toBe(SENDER_DIRECT_ADDRESS);
    expect(payload.tokens).toHaveLength(1);
  });

  it('records a RECEIVED history entry with recipientAddress + senderAddress + memo', async () => {
    const h = await makeHarness();
    await h.handler(buildIncoming(RECEIVER_PUBKEY_HEX, { memo: 'INV:hash:F' }));

    const history = h.module.getHistory();
    expect(history).toHaveLength(1);
    const rec = history[0];
    expect(rec.type).toBe('RECEIVED');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((rec as any).memo).toBe('INV:hash:F');
    // v2-6c: recipient address MUST come from our own directAddress.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((rec as any).recipientAddress).toBe('DIRECT://receiver-abc');
    // v2-6d: sender address resolved via transport binding lookup.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((rec as any).senderAddress).toBe(SENDER_DIRECT_ADDRESS);
    expect(rec.amount).toBe('100');
    expect(rec.coinId).toBe('UCT');
  });

  it('resolves sender via transport.resolveTransportPubkeyInfo (called with the sender transport pubkey)', async () => {
    const h = await makeHarness();
    await h.handler(buildIncoming(RECEIVER_PUBKEY_HEX));
    expect(h.resolveTransportPubkeyInfo).toHaveBeenCalledWith(SENDER_TRANSPORT_PUBKEY);
  });

  it('gracefully degrades when transport binding lookup returns null (no senderAddress in history)', async () => {
    const h = await makeHarness();
    h.resolveTransportPubkeyInfo.mockResolvedValueOnce(null);
    await h.handler(buildIncoming(RECEIVER_PUBKEY_HEX, { memo: 'test' }));

    const history = h.module.getHistory();
    expect(history).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((history[0] as any).senderAddress).toBeUndefined();
    // The transfer STILL succeeded; coverage-attribution is best-effort.
    const incoming = h.events.find((e) => e.type === 'transfer:incoming');
    const payload = incoming!.data as IncomingTransfer;
    expect(payload.senderAddress).toBeUndefined();
  });

  it('ignores non-UXF (legacy) payload shapes and defers durability to a fatter consumer', async () => {
    const h = await makeHarness();
    const legacy: IncomingTokenTransfer = {
      id: 'nostr-legacy',
      senderTransportPubkey: SENDER_TRANSPORT_PUBKEY,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload: { kind: 'something-else', legacy: true } as any,
      timestamp: Date.now(),
    };
    const durable = await h.handler(legacy);
    expect(durable).toBe(false);
    expect(h.module.getTokens()).toHaveLength(0);
  });

  it('rejects a uxf-cid payload (slim receive does not fetch CARs by CID)', async () => {
    const h = await makeHarness();
    const cid: IncomingTokenTransfer = {
      id: 'nostr-cid',
      senderTransportPubkey: SENDER_TRANSPORT_PUBKEY,
      payload: {
        kind: 'uxf-cid',
        version: '1.0',
        mode: 'instant',
        bundleCid: 'bcid',
        tokenIds: ['t1'],
        sender: { transportPubkey: '02' + 'e'.repeat(64) },
      },
      timestamp: Date.now(),
    };
    const durable = await h.handler(cid);
    // Slim rebuild returns false so the transport can keep the event and
    // hand it to a fatter consumer later.
    expect(durable).toBe(false);
    expect(h.module.getTokens()).toHaveLength(0);
  });
});
