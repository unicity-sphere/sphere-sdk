/**
 * Wave-6-P2-10a shared v2 harness for PaymentsModule tests.
 *
 * The existing v2 test files (send.v2, receive.v2, readModel.v2) inline a
 * ~200-line harness each. This file consolidates the common scaffolding so
 * the new tests written this wave stay focused on their behaviour.
 *
 * Constraints:
 *   - `vi.mock('../../../../registry', ...)` is hoisted per-file; callers must
 *     still declare that mock at the top of every test file that imports
 *     PaymentsModule. There is no way to package it here.
 *   - Everything here is a `vi.fn()`-backed stub — no real network, no crypto.
 *   - The fake engine mirrors the shape used in the send/receive tests.
 */

import { vi } from 'vitest';

import { createPaymentsModule } from '../../../../../modules/payments/PaymentsModule';
import type { PaymentsModuleDependencies } from '../../../../../modules/payments/PaymentsModule';
import type {
  FullIdentity,
  Token,
  SphereEventMap,
  SphereEventType,
} from '../../../../../types';
import type {
  StorageProvider,
  TokenStorageProvider,
  TxfStorageDataBase,
} from '../../../../../storage';
import type {
  IncomingTokenTransfer,
  PeerInfo,
  TokenTransferHandler,
  TransportProvider,
} from '../../../../../transport';
import type { OracleProvider } from '../../../../../oracle';
import type {
  EngineIdentity,
  ITokenEngine,
  SphereToken,
  TokenBlob,
} from '../../../../../token-engine';

// ---------------------------------------------------------------------------
// Fake engine
// ---------------------------------------------------------------------------

let tokenSeq = 0;

export function resetTokenSeq(): void {
  tokenSeq = 0;
}

export function makeSphereToken(
  coinId: string,
  amount: bigint,
  ownerHex: string,
): SphereToken {
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

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '').toLowerCase();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

export interface FakeEngineOptions {
  identity: EngineIdentity;
  /** If provided, verify() will return this instead of `{ok:true}`. */
  verifyResult?: { ok: true } | { ok: false; reason: string };
  /** If true, isOwnedBy always returns false (drop incoming). */
  refuseOwnership?: boolean;
}

/**
 * Build a fake ITokenEngine that supports the full send + receive surface.
 * The token model is a JSON envelope for easy in-memory manipulation.
 */
export function makeFakeEngine(opts: FakeEngineOptions): ITokenEngine {
  const ownerHex = bytesToHex(opts.identity.chainPubkey);
  const verifyResult = opts.verifyResult ?? { ok: true };
  return {
    getIdentity: () => opts.identity,
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
      throw new Error('mintDataToken not implemented in fake');
    },
    transfer: async ({ token, recipientPubkey }) => {
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
    verify: async () => verifyResult,
    isSpent: async () => false,
    isOwnedBy: (t, pubkey) => {
      if (opts.refuseOwnership) return false;
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
        sdkToken: {
          tokenId: parsed.tokenId,
          coinId: parsed.coinId,
          amount: BigInt(parsed.amount),
          ownerHex: parsed.owner,
        } as any,
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
// Provider stubs
// ---------------------------------------------------------------------------

export function makeStorageStub(): StorageProvider {
  return {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

export interface RecordingTokenStorage {
  provider: TokenStorageProvider<TxfStorageDataBase>;
  saved: TxfStorageDataBase[];
  setInitialData(data: TxfStorageDataBase | null): void;
  setSyncResult(result: {
    added?: number;
    removed?: number;
    conflicts?: number;
    merged?: TxfStorageDataBase;
  }): void;
}

/**
 * Recording token storage: keeps every save() payload so tests can assert
 * what the module wrote to disk, and lets tests preload load() results and
 * override sync() output.
 */
export function makeRecordingTokenStorage(): RecordingTokenStorage {
  const saved: TxfStorageDataBase[] = [];
  let stored: TxfStorageDataBase | null = null;
  let syncOverride: {
    added: number;
    removed: number;
    conflicts: number;
    merged?: TxfStorageDataBase;
  } = { added: 0, removed: 0, conflicts: 0 };
  const provider = {
    id: 'mock-token-storage',
    name: 'Mock Token Storage',
    type: 'local',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    initialize: vi.fn().mockResolvedValue(true),
    shutdown: vi.fn().mockResolvedValue(undefined),
    load: vi.fn(async () => ({
      success: stored !== null,
      data: stored ?? undefined,
      source: 'local' as const,
      timestamp: Date.now(),
    })),
    save: vi.fn(async (data: TxfStorageDataBase) => {
      saved.push(JSON.parse(JSON.stringify(data)) as TxfStorageDataBase);
      stored = data;
      return { success: true, timestamp: Date.now() };
    }),
    sync: vi.fn(async () => ({
      success: true,
      added: syncOverride.added,
      removed: syncOverride.removed,
      conflicts: syncOverride.conflicts,
      merged: syncOverride.merged,
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as TokenStorageProvider<TxfStorageDataBase>;
  return {
    provider,
    saved,
    setInitialData(data) {
      stored = data;
    },
    setSyncResult(result) {
      syncOverride = {
        added: result.added ?? 0,
        removed: result.removed ?? 0,
        conflicts: result.conflicts ?? 0,
        ...(result.merged !== undefined ? { merged: result.merged } : {}),
      };
    },
  };
}

export function makeOracleStub(): OracleProvider {
  return {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'aggregator',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    initialize: vi.fn().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// ---------------------------------------------------------------------------
// Full harness
// ---------------------------------------------------------------------------

export const DEFAULT_SENDER_PUBKEY = '02' + 'a'.repeat(64);
export const DEFAULT_RECIPIENT_PUBKEY = '03' + 'b'.repeat(64);
export const DEFAULT_RECIPIENT_TRANSPORT_PUBKEY = 'c'.repeat(64);
export const DEFAULT_SENDER_TRANSPORT_PUBKEY = 'e'.repeat(64);
export const DEFAULT_SENDER_DIRECT_ADDRESS = 'DIRECT://sender-original';

export type MutableIdentity = { -readonly [K in keyof FullIdentity]: FullIdentity[K] };

export interface HarnessOptions {
  /** Override the resolve() result. `undefined` = default happy path. */
  resolveResult?: PeerInfo | null;
  /** If set, transport.sendTokenTransfer rejects with this error. */
  sendError?: Error;
  /** Override peer for transport.resolveTransportPubkeyInfo. */
  transportPubkeyInfoResult?: PeerInfo | null;
  /** Verify override. */
  verifyResult?: { ok: true } | { ok: false; reason: string };
  /** Preload local storage with data (drives load()). */
  initialStorageData?: TxfStorageDataBase | null;
  /** Register this identity's nametag. */
  nametag?: string;
}

export interface Harness {
  module: ReturnType<typeof createPaymentsModule>;
  identity: MutableIdentity;
  transport: TransportProvider;
  emitEvent: ReturnType<typeof vi.fn>;
  events: Array<{ type: SphereEventType; data: unknown }>;
  engine: ITokenEngine;
  handler: TokenTransferHandler;
  storage: RecordingTokenStorage;
  sendTokenTransfer: ReturnType<typeof vi.fn>;
  resolve: ReturnType<typeof vi.fn>;
  resolveTransportPubkeyInfo: ReturnType<typeof vi.fn>;
  destroy(): Promise<void>;
}

/**
 * Build a fully-wired PaymentsModule with the fake engine attached, a
 * recording token storage provider, and captured transport handlers.
 */
export async function makeV2Harness(options: HarnessOptions = {}): Promise<Harness> {
  const identity: MutableIdentity = {
    chainPubkey: DEFAULT_SENDER_PUBKEY,
    directAddress: 'DIRECT://sender-abc',
    privateKey: '0x' + 'b'.repeat(64),
    ...(options.nametag !== undefined ? { nametag: options.nametag } : {}),
  };

  const storage = makeRecordingTokenStorage();
  if (options.initialStorageData !== undefined) {
    storage.setInitialData(options.initialStorageData);
  }

  const sendTokenTransfer = options.sendError
    ? vi.fn().mockRejectedValue(options.sendError)
    : vi.fn().mockResolvedValue('nostr-event-id-xyz');

  const resolve = vi.fn().mockResolvedValue(
    options.resolveResult === undefined
      ? {
          nametag: 'bob',
          chainPubkey: DEFAULT_RECIPIENT_PUBKEY,
          transportPubkey: DEFAULT_RECIPIENT_TRANSPORT_PUBKEY,
          directAddress: 'DIRECT://bob-address',
          timestamp: Date.now(),
        }
      : options.resolveResult,
  );

  const resolveTransportPubkeyInfo = vi.fn().mockResolvedValue(
    options.transportPubkeyInfoResult === undefined
      ? {
          chainPubkey: '02' + 'e'.repeat(64),
          transportPubkey: DEFAULT_SENDER_TRANSPORT_PUBKEY,
          directAddress: DEFAULT_SENDER_DIRECT_ADDRESS,
          timestamp: Date.now(),
        }
      : options.transportPubkeyInfoResult,
  );

  let capturedHandler: TokenTransferHandler | null = null;
  const onTokenTransfer = vi.fn((h: TokenTransferHandler) => {
    capturedHandler = h;
    return () => {
      capturedHandler = null;
    };
  });

  const transport = {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p',
    setIdentity: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    sendMessage: vi.fn(),
    onMessage: vi.fn().mockReturnValue(() => {}),
    sendTokenTransfer,
    onTokenTransfer,
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve,
    resolveTransportPubkeyInfo,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as TransportProvider;

  const events: Array<{ type: SphereEventType; data: unknown }> = [];
  const emitEvent = vi.fn(<T extends SphereEventType>(type: T, data: SphereEventMap[T]) => {
    events.push({ type, data });
  });

  const engine = makeFakeEngine({
    identity: { chainPubkey: hexToBytes(DEFAULT_SENDER_PUBKEY) },
    ...(options.verifyResult !== undefined ? { verifyResult: options.verifyResult } : {}),
  });

  const module = createPaymentsModule();
  const tokenStorageProviders = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();
  tokenStorageProviders.set('default', storage.provider);
  const deps: PaymentsModuleDependencies = {
    identity: identity as FullIdentity,
    storage: makeStorageStub(),
    tokenStorageProviders,
    transport,
    oracle: makeOracleStub(),
    emitEvent,
    tokenEngine: engine,
  };
  module.initialize(deps);
  if (options.initialStorageData !== undefined) {
    await module.load();
  }

  if (!capturedHandler) {
    throw new Error('onTokenTransfer handler was not captured — check initialize wiring');
  }

  return {
    module,
    identity,
    transport,
    emitEvent,
    events,
    engine,
    handler: capturedHandler,
    storage,
    sendTokenTransfer,
    resolve,
    resolveTransportPubkeyInfo,
    async destroy() {
      await module.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export async function mint(
  h: Harness,
  coinId: string,
  amount: bigint,
): Promise<Token> {
  const r = await h.module.mintFungibleToken(coinId, amount);
  if (!r.success) throw new Error(`mintFungibleToken failed: ${r.error}`);
  return r.token;
}

/**
 * Build a UXF-CAR incoming event carrying the given token blobs.
 */
export function buildIncomingTransfer(
  ownerHex: string,
  opts: {
    memo?: string;
    coinId?: string;
    amount?: bigint;
    tokenCount?: number;
    senderNametag?: string;
    senderTransportPubkey?: string;
    eventId?: string;
    tokens?: SphereToken[];
  } = {},
): IncomingTokenTransfer {
  const senderTransportPubkey =
    opts.senderTransportPubkey ?? DEFAULT_SENDER_TRANSPORT_PUBKEY;
  const senderNametag = opts.senderNametag ?? 'alice';
  const eventId = opts.eventId ?? `nostr-event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const coinId = opts.coinId ?? 'UCT';
  const amount = opts.amount ?? 100n;
  const tokenCount = opts.tokenCount ?? 1;
  const tokens =
    opts.tokens ??
    Array.from({ length: tokenCount }, () => makeSphereToken(coinId, amount, ownerHex));
  const encoded = tokens.map((st) => ({
    v: st.blob.v,
    network: st.blob.network,
    tokenId: st.blob.tokenId,
    token: Buffer.from(st.blob.token).toString('base64'),
  }));
  const carBase64 = Buffer.from(JSON.stringify({ tokens: encoded })).toString('base64');
  return {
    id: eventId,
    senderTransportPubkey,
    payload: {
      kind: 'uxf-car',
      version: '1.0',
      mode: 'instant',
      bundleCid: 'b' + eventId.slice(0, 24),
      tokenIds: tokens.map((t) => t.blob.tokenId),
      sender: {
        transportPubkey: '02' + 'e'.repeat(64),
        ...(senderNametag !== undefined ? { nametag: senderNametag } : {}),
      },
      ...(opts.memo !== undefined ? { memo: opts.memo } : {}),
      carBase64,
    },
    timestamp: Date.now(),
  };
}
