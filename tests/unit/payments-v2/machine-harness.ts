/**
 * Shared harness for the TransferMachine tests (machine.test.ts +
 * machine-resume.test.ts): a realization-aware wrapper over FakeTokenEngine
 * (E.1/E.2 semantics — memoized (transferId, opIndex) re-runs, foreign-spend
 * conflicts, fault injection), thin port adapters over FakeWalletApi, an
 * in-memory ScopedKV with fault flags, and plan/seed builders.
 */

import { CborDeserializer, HexConverter } from '../../../token-engine/sdk';
import type {
  EngineOpOptions,
  SphereToken,
  SplitParams,
  SplitResult,
  TransferParams,
} from '../../../token-engine';
import { TransferConflictError } from '../../../token-engine/errors';
import type { DeliverOptions, DeliveryPort, StoragePort, InventoryItem } from '../../../modules/payments-v2/ports';
import type { IntentPayload } from '../../../modules/payments-v2/machine/types';
import {
  TransferMachine,
  buildOps,
  type IntentApi,
  type MachineDeps,
  type MachinePlan,
} from '../../../modules/payments-v2/machine/TransferMachine';
import { createMachineStores, type MachineStores } from '../../../modules/payments-v2/machine/journal';
import { FakeTokenEngine, decodeFakeTokenAssets } from '../token-engine/FakeTokenEngine';
import { memoryCheckpoints, memoryKV, type MemoryKV } from './support';
import {
  FakeWalletApi,
  completeMessageFor,
  fakeSeedSignature,
  sha256Hex,
  type FakeBlobMeta,
  type FakeCaller,
} from './fakes/FakeWalletApi';

export const COIN = 'aa'.repeat(32);
export const SENDER_PUBKEY = new Uint8Array([0x02, ...new Array<number>(32).fill(0x11)]);
export const RECIPIENT_PUBKEY = new Uint8Array([0x03, ...new Array<number>(32).fill(0x22)]);
const FOREIGN_PUBKEY = new Uint8Array([0x03, ...new Array<number>(32).fill(0xee)]);

export function opKey(options?: EngineOpOptions): string {
  return `${options?.transferId ?? 'anon'}:${String(options?.opIndex ?? 0)}`;
}

interface LineageInfo {
  consumed: string[];
  splitEvidence?: { burntTokenId: string; preBurnState: string };
}

/**
 * FakeTokenEngine + Part E realization semantics: a re-run under the same
 * (transferId, opIndex) returns the memoized result (the E.2 OK-match), a run
 * whose source another realization consumed raises TransferConflictError, and
 * fault hooks model pre-submit rejects / post-certify indeterminate outcomes.
 */
export class RealizationEngine extends FakeTokenEngine {
  readonly transferCalls: { key: string; sourceTokenId: string }[] = [];
  readonly splitCalls: { key: string; checkpointStore: boolean }[] = [];
  readonly lineage = new Map<string, LineageInfo>();
  opLog: string[] | null = null;
  beforeOp: ((key: string, kind: 'direct' | 'split') => void) | null = null;
  afterOp: ((key: string, kind: 'direct' | 'split') => Error | null) | null = null;

  private readonly memoTransfer = new Map<string, SphereToken>();
  private readonly memoSplit = new Map<string, SplitResult>();
  private readonly consumedBy = new Map<string, string>();

  override async transfer(params: TransferParams, options?: EngineOpOptions): Promise<SphereToken> {
    const key = opKey(options);
    this.transferCalls.push({ key, sourceTokenId: params.token.blob.tokenId });
    this.opLog?.push('engine:transfer');
    const memo = this.memoTransfer.get(key);
    if (memo !== undefined) return memo;
    this.beforeOp?.(key, 'direct');
    this.claim(stateOf(params.token), key);
    const out = await super.transfer(params, options);
    this.memoTransfer.set(key, out);
    this.lineage.set(sha256Hex(out.blob.token), { consumed: [stateOf(params.token)] });
    this.throwAfter(key, 'direct');
    return out;
  }

  override async split(params: SplitParams, options?: EngineOpOptions): Promise<SplitResult> {
    const key = opKey(options);
    this.splitCalls.push({ key, checkpointStore: options?.checkpointStore !== undefined });
    this.opLog?.push('engine:split');
    const memo = this.memoSplit.get(key);
    if (memo !== undefined) return memo;
    this.beforeOp?.(key, 'split');
    const preBurnState = stateOf(params.token);
    this.claim(preBurnState, key);
    const result = await super.split(params, options);
    this.memoSplit.set(key, result);
    for (const output of result.outputs) {
      this.lineage.set(sha256Hex(output.blob.token), {
        consumed: [preBurnState],
        splitEvidence: { burntTokenId: params.token.blob.tokenId, preBurnState },
      });
    }
    this.throwAfter(key, 'split');
    return result;
  }

  /** Another device wins the race for this source state. */
  async foreignSpend(token: SphereToken): Promise<void> {
    const state = stateOf(token);
    await super.transfer({ token, recipientPubkey: FOREIGN_PUBKEY });
    this.consumedBy.set(state, 'foreign');
  }

  private claim(state: string, key: string): void {
    const holder = this.consumedBy.get(state);
    if (holder !== undefined && holder !== key) {
      throw new TransferConflictError(`source state already consumed by ${holder}`);
    }
    this.consumedBy.set(state, key);
  }

  private throwAfter(key: string, kind: 'direct' | 'split'): void {
    const err = this.afterOp?.(key, kind);
    if (err) throw err;
  }
}

export function stateOf(token: SphereToken): string {
  return sha256Hex(token.blob.token);
}

/** FakeWalletApi decodeBlob over FakeTokenEngine inner bytes + recorded lineage. */
export function fakeDecodeBlobFor(engine: RealizationEngine): (bytes: Uint8Array) => FakeBlobMeta {
  return (bytes) => {
    const fields = CborDeserializer.decodeArray(bytes, 5);
    const tokenId = HexConverter.encode(CborDeserializer.decodeByteString(fields[0]));
    const owner = HexConverter.encode(CborDeserializer.decodeByteString(fields[2]));
    const lineage = engine.lineage.get(sha256Hex(bytes));
    const assets = (decodeFakeTokenAssets(bytes) ?? []).map((a) => ({ coinId: a.coinId, amount: a.amount.toString() }));
    return {
      tokenId,
      stateHash: sha256Hex(bytes),
      consumedStates: lineage?.consumed ?? [],
      ownerPubkey: owner,
      assets,
      ...(lineage?.splitEvidence !== undefined ? { splitEvidence: lineage.splitEvidence } : {}),
    };
  };
}

export interface Overrides {
  putIntent?: () => Promise<void>;
  applyDelta?: () => Promise<void>;
  deliver?: () => Promise<void>;
  complete?: (transferId: string) => Promise<void>;
  abort?: () => Promise<void>;
}

export interface World {
  api: FakeWalletApi;
  engine: RealizationEngine;
  kv: MemoryKV;
  caller: FakeCaller;
  recipientCaller: FakeCaller;
  senderHex: string;
  recipientHex: string;
  deps: MachineDeps;
  log: string[];
  events: { event: string; payload: unknown }[];
  applied: { transferId: string; spent: string[]; added: { tokenId: string; key: string }[] }[];
  deposits: { transferId: string; tokenId: string }[];
  completes: { transferId: string; signature?: string }[];
  signCalls: string[];
  clock: { t: number };
  overrides: Overrides;
  blobByTokenId: Map<string, Uint8Array>;
  seq: { n: number };
  stores(): MachineStores;
  machine(): TransferMachine;
  seed(amount: bigint): Promise<SphereToken>;
  plan(opts: PlanOpts): Promise<MachinePlan>;
  flushTail(): Promise<void>;
}

export interface PlanOpts {
  tokens?: SphereToken[];
  amount: string;
  split?: { token: SphereToken; splitAmount: string; remainderAmount: string };
  memo?: string;
  transferId?: string;
}

export function makeWorld(): World {
  const senderHex = HexConverter.encode(SENDER_PUBKEY);
  const recipientHex = HexConverter.encode(RECIPIENT_PUBKEY);
  const engine = new RealizationEngine({ chainPubkey: SENDER_PUBKEY });
  const api = new FakeWalletApi({ decodeBlob: fakeDecodeBlobFor(engine) });
  const kv = memoryKV();
  const caller: FakeCaller = { chainPubkey: senderHex, network: 'testnet2' };
  const recipientCaller: FakeCaller = { chainPubkey: recipientHex, network: 'testnet2' };

  const world = {
    api,
    engine,
    kv,
    caller,
    recipientCaller,
    senderHex,
    recipientHex,
    log: [] as string[],
    events: [] as { event: string; payload: unknown }[],
    applied: [] as { transferId: string; spent: string[]; added: { tokenId: string; key: string }[] }[],
    deposits: [] as { transferId: string; tokenId: string }[],
    completes: [] as { transferId: string; signature?: string }[],
    signCalls: [] as string[],
    clock: { t: 1_000_000 },
    overrides: {} as Overrides,
    blobByTokenId: new Map<string, Uint8Array>(),
    seq: { n: 0 },
  };
  engine.opLog = world.log;

  const deps: MachineDeps = {
    engine: () => engine,
    storage: makeStorage(world),
    delivery: makeDelivery(world),
    intents: makeIntents(world),
    checkpointStore: memoryCheckpoints(),
    kv,
    encryptPayload: async (p) => `enc:${JSON.stringify(p)}`,
    decryptPayload: async (envelope) => {
      if (!envelope.startsWith('enc:')) throw new Error('undecryptable envelope');
      return JSON.parse(envelope.slice(4)) as unknown;
    },
    signComplete: async (transferId) => {
      world.signCalls.push(transferId);
      return fakeSeedSignature(senderHex, completeMessageFor(transferId));
    },
    ownPubkey: SENDER_PUBKEY,
    emit: (event, payload) => {
      world.events.push({ event, payload });
    },
    now: () => world.clock.t,
  };

  return {
    ...world,
    deps,
    stores: () => createMachineStores(kv),
    machine: () => new TransferMachine(deps),
    seed: (amount: bigint) => seedToken(world, amount),
    plan: (opts: PlanOpts) => buildPlan(world, opts),
    flushTail: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
  };
}

interface WorldState {
  api: FakeWalletApi;
  engine: RealizationEngine;
  caller: FakeCaller;
  recipientHex: string;
  senderHex: string;
  log: string[];
  applied: { transferId: string; spent: string[]; added: { tokenId: string; key: string }[] }[];
  deposits: { transferId: string; tokenId: string }[];
  completes: { transferId: string; signature?: string }[];
  overrides: Overrides;
  blobByTokenId: Map<string, Uint8Array>;
  seq: { n: number };
}

function makeStorage(w: WorldState): StoragePort {
  return {
    async listInventory(since) {
      const page = await w.api.listInventory(w.caller, since);
      const items: InventoryItem[] = page.items.map((it) => ({
        tokenId: it.tokenId,
        status: it.status,
        seq: it.seq,
        stateHash: it.stateHash,
        ...(it.assets !== undefined ? { assets: it.assets.map((a) => ({ coinId: a.coinId, amount: a.amount })) } : {}),
      }));
      return { cursor: page.cursor, syncEpoch: String(page.syncEpoch), more: page.more, items };
    },
    async getBlobs(tokenIds) {
      const out = new Map<string, Uint8Array>();
      for (const id of tokenIds) {
        const bytes = w.blobByTokenId.get(id);
        if (bytes !== undefined) out.set(id, bytes);
      }
      return out;
    },
    async uploadBlobs(blobs) {
      w.log.push('uploadBlobs');
      const out = new Map<string, string>();
      for (const blob of blobs) {
        const { key } = await w.api.putBlob(blob.sha256, blob.bytes);
        const { tokenId } = await w.engine.deliveryKeys(blob.bytes);
        w.blobByTokenId.set(tokenId, Uint8Array.from(blob.bytes));
        out.set(blob.sha256, key);
      }
      return out;
    },
    async applyDelta(delta) {
      w.log.push('applyDelta');
      if (w.overrides.applyDelta) await w.overrides.applyDelta();
      const result = await w.api.apply(w.caller, delta);
      w.applied.push({ transferId: delta.transferId, spent: [...delta.spent], added: [...delta.added] });
      return { cursor: result.cursor, syncEpoch: String(result.syncEpoch) };
    },
  };
}

function makeDelivery(w: WorldState): DeliveryPort {
  let derive: ((blob: Uint8Array) => Promise<{ tokenId: string; stateHash: string }>) | null = null;
  const depositOne = async (recipientPubkey: string, blob: Uint8Array, options: DeliverOptions) => {
    w.log.push('deliver');
    if (w.overrides.deliver) await w.overrides.deliver();
    const keys = derive !== null ? await derive(blob) : await w.engine.deliveryKeys(blob);
    const digest = sha256Hex(blob);
    await w.api.putBlob(digest, blob);
    const { entryId } = await w.api.deposit(w.caller, {
      recipientPubkey,
      key: digest,
      transferId: options.transferId,
      ...(options.memo !== undefined ? { memo: options.memo } : {}),
      stateHash: keys.stateHash,
      tokenId: keys.tokenId,
    });
    w.deposits.push({ transferId: options.transferId, tokenId: keys.tokenId });
    return { deliveryId: entryId };
  };
  return {
    bindDeliveryKeys(fn) {
      derive = fn;
    },
    deliver: depositOne,
    async deliverBatch(recipientPubkey, blobs, options) {
      const receipts = [];
      for (const blob of blobs) receipts.push(await depositOne(recipientPubkey, blob, options));
      return receipts;
    },
    incoming() {
      return emptyAsyncIterable();
    },
    incomingEpoch() {
      return null; // this fake never lists a page
    },
    async ack() {
      /* not exercised by the machine */
    },
  };
}

function emptyAsyncIterable<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return { next: async () => ({ done: true as const, value: undefined }) };
    },
  };
}

function makeIntents(w: WorldState): IntentApi {
  return {
    async put(transferId, envelope, requiresSeedClose) {
      w.log.push('putIntent');
      if (w.overrides.putIntent) await w.overrides.putIntent();
      await w.api.putIntent(w.caller, { transferId, payload: envelope, requiresSeedClose });
    },
    async listOpen() {
      const intents = await w.api.listIntents(w.caller, 'open');
      return intents.map((i) => ({ transferId: i.transferId, payload: i.payload, createdAt: i.createdAt }));
    },
    async abort(transferId) {
      w.log.push('abortIntent');
      if (w.overrides.abort) await w.overrides.abort();
      await w.api.abortIntent(w.caller, transferId);
    },
    async complete(transferId, signature) {
      w.log.push('completeIntent');
      if (w.overrides.complete) await w.overrides.complete(transferId);
      w.completes.push({ transferId, ...(signature !== undefined ? { signature } : {}) });
      await w.api.completeIntent(w.caller, {
        transferId,
        ...(signature !== undefined ? { signature } : {}),
      });
    },
  };
}

async function seedToken(w: WorldState, amount: bigint): Promise<SphereToken> {
  const token = await w.engine.mint({ recipientPubkey: SENDER_PUBKEY, value: { assets: [{ coinId: COIN, amount }] } });
  const bytes = token.blob.token;
  const digest = sha256Hex(bytes);
  await w.api.putBlob(digest, bytes);
  await w.api.apply(w.caller, {
    transferId: `seed-${token.blob.tokenId}`,
    spent: [],
    added: [{ tokenId: token.blob.tokenId, key: digest }],
  });
  w.blobByTokenId.set(token.blob.tokenId, bytes);
  return token;
}

async function buildPlan(w: WorldState, opts: PlanOpts): Promise<MachinePlan> {
  w.seq.n += 1;
  const transferId = opts.transferId ?? `transfer-${String(w.seq.n)}`;
  const tokens = opts.tokens ?? [];
  const all = [...tokens, ...(opts.split !== undefined ? [opts.split.token] : [])];
  const spentStates: Record<string, { local: string; protocol: string }> = {};
  for (const token of all) {
    const keys = await w.engine.deliveryKeys(token.blob.token);
    spentStates[token.blob.tokenId] = { local: keys.stateHash, protocol: keys.stateHash };
  }
  const payload: IntentPayload = {
    v: 2,
    recipient: w.recipientHex,
    coinId: COIN,
    amount: opts.amount,
    ...(opts.memo !== undefined ? { memo: opts.memo } : {}),
    direct: tokens.map((t) => t.blob.tokenId),
    ...(opts.split !== undefined
      ? {
          split: {
            tokenId: opts.split.token.blob.tokenId,
            splitAmount: opts.split.splitAmount,
            remainderAmount: opts.split.remainderAmount,
          },
        }
      : {}),
    spentStates,
  };
  return {
    transferId,
    recipientPubkey: w.recipientHex,
    payload,
    ops: buildOps(payload),
    sources: new Map(all.map((t) => [t.blob.tokenId, t])),
    ...(opts.memo !== undefined ? { memo: opts.memo } : {}),
  };
}
