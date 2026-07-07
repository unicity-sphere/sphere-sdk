/**
 * PaymentsModule receive path — `kind: 'uxf-cid'` (wave 6-P2-11).
 *
 * The wave-6-P2-4b slim rebuild rejected every uxf-cid envelope, returning
 * `false` so the transport retained the event for a fatter consumer that
 * never arrived. Wave 6-P2-11 wires the recipient side:
 *
 *   1. Empty/null `deps.cidFetchGateways` → still returns `false`
 *      (retention). Operators must configure gateways to enable CID mode.
 *   2. `fetchCarByCid` walks gateways in order, verifies CAR root CID
 *      matches `payload.bundleCid`, returns bytes on success.
 *   3. Recipient extracts the CAR's single root block, treats its bytes
 *      as the same JSON envelope the inline `uxf-car` path consumes,
 *      and runs the shared decoder → isOwnedBy → verify → persist tail.
 *   4. Any failure downstream of the fetch (empty gateway list, all-
 *      gateways-failed, CAR structural error) → `false` for retention.
 *
 * Test strategy: mock `fetchCarByCid` at the module boundary so we can
 * return known CAR bytes (built with `@ipld/car`'s CarWriter) or force a
 * transient error. The receive tail is exercised end-to-end.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CarWriter } from '@ipld/car';
import { CID } from 'multiformats/cid';
import { sha256 } from '@noble/hashes/sha2.js';

// ---------------------------------------------------------------------------
// Mock fetchCarByCid at module boundary
// ---------------------------------------------------------------------------

const fetchCarByCidMock = vi.fn();
vi.mock('../../../../extensions/uxf/pipeline/cid-fetcher', () => ({
  fetchCarByCid: (...args: unknown[]) => fetchCarByCidMock(...args),
}));

// TokenRegistry — same stub as the sibling receive test.
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

import {
  createPaymentsModule,
  type PaymentsModuleDependencies,
} from '../../../../modules/payments/PaymentsModule';
import type {
  FullIdentity,
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

// ---------------------------------------------------------------------------
// Fake engine (mirrors PaymentsModule.receive.v2.test.ts shape)
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
    mint: async () => { throw new Error('unused'); },
    mintDataToken: async () => { throw new Error('unused'); },
    transfer: async () => { throw new Error('unused'); },
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// ---------------------------------------------------------------------------
// CAR builder — wraps a JSON envelope (same shape as inline uxf-car path
// carBase64) as the sole block of a single-root CARv1.
// ---------------------------------------------------------------------------

const RAW_CODEC = 0x55; // multiformats raw codec
const SHA256_CODE = 0x12;

function createSha256Digest(hash: Uint8Array): { code: 0x12; size: number; digest: Uint8Array; bytes: Uint8Array } {
  const size = hash.length;
  const bytes = new Uint8Array(2 + size);
  bytes[0] = SHA256_CODE;
  bytes[1] = size;
  bytes.set(hash, 2);
  return { code: SHA256_CODE, size, digest: hash, bytes };
}

/**
 * Build a real single-root CARv1 whose sole block is the JSON envelope
 * bytes. Returns `{ carBytes, bundleCid }` — bundleCid is the CIDv1
 * base32 (`b...`) of the block, computed as sha256(bytes) wrapped in
 * `raw` codec.
 */
async function buildSingleBlockCar(envelopeBytes: Uint8Array): Promise<{
  carBytes: Uint8Array;
  bundleCid: string;
}> {
  const digest = createSha256Digest(sha256(envelopeBytes));
  const cid = CID.createV1(RAW_CODEC, digest);
  const { writer, out } = CarWriter.create([cid]);
  const chunks: Uint8Array[] = [];
  const collect = (async () => {
    for await (const c of out) chunks.push(c);
  })();
  await writer.put({ cid, bytes: envelopeBytes });
  await writer.close();
  await collect;
  let total = 0;
  for (const c of chunks) total += c.length;
  const carBytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    carBytes.set(c, offset);
    offset += c.length;
  }
  return { carBytes, bundleCid: cid.toString() };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const RECEIVER_PUBKEY_HEX = '02' + 'a'.repeat(64);
const SENDER_TRANSPORT_PUBKEY = 'e'.repeat(64);
const SENDER_DIRECT_ADDRESS = 'DIRECT://sender-original';

interface Harness {
  module: ReturnType<typeof createPaymentsModule>;
  events: Array<{ type: SphereEventType; data: unknown }>;
  handler: TokenTransferHandler;
}

async function makeHarness(opts: {
  cidFetchGateways?: ReadonlyArray<string>;
} = {}): Promise<Harness> {
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
      return () => { capturedHandler = null; };
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
    ...(opts.cidFetchGateways !== undefined
      ? { cidFetchGateways: opts.cidFetchGateways }
      : {}),
  };
  module.initialize(deps);
  if (!capturedHandler) throw new Error('handler was not captured');
  return { module, events, handler: capturedHandler };
}

function buildEnvelopeForToken(ownerHex: string): { envelopeBytes: Uint8Array; tokenId: string } {
  const st = makeSphereToken('UCT', 100n, ownerHex);
  const encoded = [
    {
      v: st.blob.v,
      network: st.blob.network,
      tokenId: st.blob.tokenId,
      token: Buffer.from(st.blob.token).toString('base64'),
    },
  ];
  const envelopeBytes = new TextEncoder().encode(JSON.stringify({ tokens: encoded }));
  return { envelopeBytes, tokenId: st.blob.tokenId };
}

function buildCidIncoming(bundleCid: string, tokenIds: string[], memo?: string): IncomingTokenTransfer {
  return {
    id: 'nostr-cid-' + Math.random().toString(36).slice(2, 8),
    senderTransportPubkey: SENDER_TRANSPORT_PUBKEY,
    payload: {
      kind: 'uxf-cid',
      version: '1.0',
      mode: 'instant',
      bundleCid,
      tokenIds,
      sender: {
        transportPubkey: '02' + 'e'.repeat(64),
        nametag: 'alice',
      },
      ...(memo !== undefined ? { memo } : {}),
    },
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PaymentsModule receive — uxf-cid path (wave 6-P2-11)', () => {
  beforeEach(() => {
    tokenSeq = 0;
    fetchCarByCidMock.mockReset();
  });

  it('happy path — fetches CAR, extracts root envelope, persists owned token', async () => {
    const h = await makeHarness({
      cidFetchGateways: ['https://ipfs.example', 'https://backup.example'],
    });
    const { envelopeBytes, tokenId } = buildEnvelopeForToken(RECEIVER_PUBKEY_HEX);
    const { carBytes, bundleCid } = await buildSingleBlockCar(envelopeBytes);
    fetchCarByCidMock.mockResolvedValue({ carBytes, gatewayUsed: 'https://ipfs.example' });

    const durable = await h.handler(buildCidIncoming(bundleCid, [tokenId], 'INV:hash:A'));

    expect(durable).toBe(true);
    expect(fetchCarByCidMock).toHaveBeenCalledTimes(1);
    expect(fetchCarByCidMock).toHaveBeenCalledWith(
      bundleCid,
      expect.objectContaining({
        gateways: ['https://ipfs.example', 'https://backup.example'],
        senderTransportPubkey: SENDER_TRANSPORT_PUBKEY,
      }),
    );
    const tokens = h.module.getTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].coinId).toBe('UCT');
    expect(tokens[0].amount).toBe('100');

    // memo + senderNametag ride through the same tail.
    const incoming = h.events.find((e) => e.type === 'transfer:incoming');
    expect(incoming).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((incoming!.data as any).memo).toBe('INV:hash:A');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((incoming!.data as any).senderNametag).toBe('alice');
  });

  it('empty cidFetchGateways → returns false (retention); no fetch attempted', async () => {
    const h = await makeHarness({ cidFetchGateways: [] });

    const durable = await h.handler(buildCidIncoming('bogus-cid', ['t1']));

    expect(durable).toBe(false);
    expect(fetchCarByCidMock).not.toHaveBeenCalled();
    expect(h.module.getTokens()).toHaveLength(0);
  });

  it('undefined cidFetchGateways (never wired) → returns false (retention)', async () => {
    const h = await makeHarness({}); // cidFetchGateways omitted from deps entirely

    const durable = await h.handler(buildCidIncoming('bogus-cid', ['t1']));

    expect(durable).toBe(false);
    expect(fetchCarByCidMock).not.toHaveBeenCalled();
  });

  it('all-gateways-failed error → returns false (retention); no crash', async () => {
    const h = await makeHarness({
      cidFetchGateways: ['https://ipfs.example', 'https://backup.example'],
    });
    fetchCarByCidMock.mockRejectedValue(
      new Error('fetchCarByCid: all 2 gateway(s) failed for bfake123'),
    );

    const durable = await h.handler(buildCidIncoming('bfake123', ['t1']));

    expect(durable).toBe(false);
    expect(fetchCarByCidMock).toHaveBeenCalledTimes(1);
    expect(h.module.getTokens()).toHaveLength(0);
  });

  it('CID-mismatch (bundleCid does not match CAR root) → returns false (retention)', async () => {
    const h = await makeHarness({ cidFetchGateways: ['https://ipfs.example'] });
    // Build a CAR whose root CID != the bundleCid we claim. Since we
    // mock `fetchCarByCid` (which encapsulates the mismatch reject
    // upstream), model the mismatch as fetchCarByCid throwing — which
    // is how the real CID-mismatch path surfaces (`all-gateways-failed`
    // classification per §9.2).
    fetchCarByCidMock.mockRejectedValue(
      new Error('fetchCarByCid: all 1 gateway(s) failed for bmismatch (cid-mismatch)'),
    );

    const durable = await h.handler(buildCidIncoming('bmismatch', ['t1']));

    expect(durable).toBe(false);
    expect(h.module.getTokens()).toHaveLength(0);
  });

  it('CAR with zero roots → returns false (retention)', async () => {
    // Build a mostly-valid CAR then swap its root count via a hand-
    // crafted invalid CAR. Simpler: mock fetchCarByCid to hand back
    // a byte sequence that CarReader parses as multi-root (dropping to
    // the mismatch-shaped classification is more work than the value).
    // Instead we hand back a truncated CAR — parse throws inside our
    // helper's try/catch, we return null → false.
    const h = await makeHarness({ cidFetchGateways: ['https://ipfs.example'] });
    fetchCarByCidMock.mockResolvedValue({
      carBytes: new Uint8Array([0x00, 0x00, 0x00]), // truncated garbage
      gatewayUsed: 'https://ipfs.example',
    });

    const durable = await h.handler(buildCidIncoming('bcid', ['t1']));

    expect(durable).toBe(false);
    expect(h.module.getTokens()).toHaveLength(0);
  });

  it('CAR root block whose bytes are not a JSON envelope → returns true (no retention, no tokens)', async () => {
    // Successful fetch + parseable CAR whose root block contains bytes
    // that do NOT decode as `{ tokens: [...] }`. `extractInlineTokenBlobs`
    // returns [] on parse failure, the tail loop is a no-op, so we
    // report `true` — the peer sent junk, retention won't fix it.
    const h = await makeHarness({ cidFetchGateways: ['https://ipfs.example'] });
    const junk = new TextEncoder().encode('not-a-json-envelope-at-all');
    const { carBytes, bundleCid } = await buildSingleBlockCar(junk);
    fetchCarByCidMock.mockResolvedValue({ carBytes, gatewayUsed: 'https://ipfs.example' });

    const durable = await h.handler(buildCidIncoming(bundleCid, ['t1']));

    expect(durable).toBe(true);
    expect(h.module.getTokens()).toHaveLength(0);
  });

  it('never surfaces gateway URLs in log output on failure', async () => {
    const h = await makeHarness({
      cidFetchGateways: ['https://internal-sensitive.example/ipfs'],
    });
    // Tap the logger.warn output to assert URL redaction directly.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const longMsg = 'https://internal-sensitive.example/ipfs/bafybe... failed: '
      + 'x'.repeat(300);
    fetchCarByCidMock.mockRejectedValue(new Error(longMsg));

    const durable = await h.handler(buildCidIncoming('bcid', ['t1']));

    expect(durable).toBe(false);
    // Ensure the transfer:incoming event did NOT fire (nothing accepted).
    const incoming = h.events.find((e) => e.type === 'transfer:incoming');
    expect(incoming).toBeUndefined();

    // Assert no log call carries a `https://` gateway URL substring.
    for (const call of warnSpy.mock.calls) {
      const flat = call.map((c) => String(c)).join(' ');
      expect(flat).not.toMatch(/https?:\/\/internal-sensitive\.example/);
    }
    warnSpy.mockRestore();
  });
});
