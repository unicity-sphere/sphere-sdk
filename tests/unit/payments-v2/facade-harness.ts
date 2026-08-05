/**
 * Shared PaymentsFacade world builder (facade.test.ts + heartbeat.test.ts):
 * REAL wallet-api-v2 ports over FakeWalletApi + the Part-E realization engine,
 * with per-call hooks/gates and a cleanup registry. Assertions stay in suites.
 */

import { getPublicKey, hexToBytes } from '../../../core/crypto';
import type { SphereToken } from '../../../token-engine';
import { WalletApiStoragePort } from '../../../impl/wallet-api-v2/storage';
import { WalletApiDeliveryPort } from '../../../impl/wallet-api-v2/mailbox';
import type { DeliveryPort, StoragePort } from '../../../modules/payments-v2/ports';
import {
  PaymentsFacade,
  type FacadeClient,
  type RecipientInfo,
} from '../../../modules/payments-v2/PaymentsFacade';
import { RealizationEngine, fakeDecodeBlobFor } from './machine-harness';
import {
  FakeSession,
  memoryCheckpoints,
  memoryKV,
  registryStub,
  stubRequestMemoCodec,
  type MemoryKV,
} from './support';
import {
  FakeWalletApi,
  completeMessageFor,
  fakeSeedSignature,
  sha256Hex,
  type FakeBlobMeta,
  type FakeCaller,
} from './fakes/FakeWalletApi';
import { FakeWalletApiV2Client } from './fakes/fake-client';

export const NET = 'testnet2';
export const OWN_PRIV = '11'.repeat(32);
export const PEER_PRIV = '22'.repeat(32);
export const COIN = 'aa'.repeat(32);

export const OWN_PUB = getPublicKey(OWN_PRIV);
export const PEER_PUB = getPublicKey(PEER_PRIV);
export const ownCaller: FakeCaller = { chainPubkey: OWN_PUB, network: NET };
export const peerCaller: FakeCaller = { chainPubkey: PEER_PUB, network: NET };

export interface Gate {
  entered: boolean;
  enter(): Promise<void>;
  release(): void;
}

export function makeGate(): Gate {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  const gate: Gate = {
    entered: false,
    enter: async () => {
      gate.entered = true;
      await opened;
    },
    release,
  };
  return gate;
}

export interface Hooks {
  putIntent?: () => Promise<void>;
  listOpen?: () => Promise<void>;
  complete?: (transferId: string) => Promise<void>;
  applyDelta?: () => Promise<void>;
  deliver?: () => Promise<void>;
}

export interface Counters {
  putIntent: number;
  listOpen: number;
}

function hookedClient(inner: FakeWalletApiV2Client, hooks: Hooks, counters: Counters): FacadeClient {
  return {
    putIntent: async (t, p, r) => {
      counters.putIntent += 1;
      if (hooks.putIntent) await hooks.putIntent();
      await inner.putIntent(t, p, r);
    },
    listIntents: async (status) => {
      if ((status ?? 'open') === 'open') {
        counters.listOpen += 1;
        if (hooks.listOpen) await hooks.listOpen();
      }
      return inner.listIntents(status);
    },
    abortIntent: (t) => inner.abortIntent(t),
    completeIntent: async (t, s) => {
      if (hooks.complete) await hooks.complete(t);
      await inner.completeIntent(t, s);
    },
    listHistory: (o) => inner.listHistory(o),
    postHistory: (r) => inner.postHistory(r),
    createPaymentRequest: (i) => inner.createPaymentRequest(i),
    listPaymentRequests: (p) => inner.listPaymentRequests(p),
    respondPaymentRequest: (id, r) => inner.respondPaymentRequest(id, r),
  };
}

function hookedStorage(inner: StoragePort, hooks: Hooks): StoragePort {
  return {
    listInventory: (since) => inner.listInventory(since),
    getBlobs: (ids) => inner.getBlobs(ids),
    uploadBlobs: (blobs) => inner.uploadBlobs(blobs),
    applyDelta: async (delta) => {
      if (hooks.applyDelta) await hooks.applyDelta();
      return inner.applyDelta(delta);
    },
  };
}

// deliverBatch is intentionally omitted so every deposit routes through the hook.
function hookedDelivery(inner: DeliveryPort, hooks: Hooks): DeliveryPort {
  return {
    bindDeliveryKeys: (derive) => inner.bindDeliveryKeys(derive),
    deliver: async (recipient, blob, options) => {
      if (hooks.deliver) await hooks.deliver();
      return inner.deliver(recipient, blob, options);
    },
    incoming: (since) => inner.incoming(since),
    ack: (id, disposition, reason) => inner.ack(id, disposition, reason),
  };
}

const registry = registryStub();

export interface World {
  api: FakeWalletApi;
  engine: RealizationEngine;
  engines: RealizationEngine[];
  innerClient: FakeWalletApiV2Client;
  kv: MemoryKV;
  session: FakeSession;
  facade: PaymentsFacade;
  hooks: Hooks;
  counters: Counters;
  events: { event: string; payload: unknown }[];
  gates: Gate[];
  resolveMap: Map<string, RecipientInfo | null>;
  seed(amount: bigint): Promise<SphereToken>;
  peerDeliver(token: SphereToken, transferId: string): Promise<void>;
  gate(name: 'putIntent' | 'deliver' | 'listOpen' | 'applyDelta'): Gate;
}

const worlds: World[] = [];

/** afterEach body: releases every gate and stops every facade made since last cleanup. */
export async function cleanupWorlds(): Promise<void> {
  for (const world of worlds.splice(0)) {
    for (const gate of world.gates) gate.release();
    await world.facade.stop().catch(() => undefined);
  }
}

export function makeWorld(options: { engine?: RealizationEngine } = {}): World {
  const engine = options.engine ?? new RealizationEngine({ chainPubkey: hexToBytes(OWN_PUB) });
  const engines = [engine];
  const decodeBlob = (bytes: Uint8Array): FakeBlobMeta => {
    let last: unknown;
    for (const candidate of engines) {
      try {
        return fakeDecodeBlobFor(candidate)(bytes);
      } catch (err) {
        last = err;
      }
    }
    throw last;
  };
  // Every engine's lineage feeds one codec; later-added engines are consulted too.
  const combined = (bytes: Uint8Array): FakeBlobMeta => {
    const metas = engines.map((candidate) => {
      const meta = fakeDecodeBlobFor(candidate)(bytes);
      return meta;
    });
    const withLineage = metas.find((meta) => meta.consumedStates.length > 0 || meta.splitEvidence !== undefined);
    return withLineage ?? metas[0] ?? decodeBlob(bytes);
  };
  const api = new FakeWalletApi({ decodeBlob: combined });
  const innerClient = new FakeWalletApiV2Client(api, ownCaller, { decodeBlob: combined });
  const kv = memoryKV();
  const session = new FakeSession();
  const hooks: Hooks = {};
  const counters: Counters = { putIntent: 0, listOpen: 0 };
  const events: { event: string; payload: unknown }[] = [];
  const gates: Gate[] = [];
  const resolveMap = new Map<string, RecipientInfo | null>([
    ['@peer', { chainPubkey: PEER_PUB, network: NET }],
    ['@mars', { chainPubkey: PEER_PUB, network: 'mars' }],
  ]);

  let ids = 0;
  const facade = new PaymentsFacade({
    session,
    client: hookedClient(innerClient, hooks, counters),
    storagePort: hookedStorage(new WalletApiStoragePort(innerClient), hooks),
    deliveryPort: hookedDelivery(
      new WalletApiDeliveryPort({
        client: innerClient,
        kv,
        identity: { privateKey: OWN_PRIV, chainPubkey: OWN_PUB },
        custody: 'inventory',
      }),
      hooks
    ),
    checkpointStore: memoryCheckpoints(),
    engineRef: () => engine,
    kv,
    registry,
    emit: (event, payload) => {
      events.push({ event, payload });
    },
    resolveRecipient: async (identifier) => {
      if (resolveMap.has(identifier)) return resolveMap.get(identifier)!;
      if (/^0[23][0-9a-f]{64}$/.test(identifier)) return { chainPubkey: identifier, network: NET };
      return null;
    },
    signComplete: async (transferId) => fakeSeedSignature(OWN_PUB, completeMessageFor(transferId)),
    fieldKey: new Uint8Array(32).fill(7),
    network: NET,
    ownPubkey: OWN_PUB,
    requestMemo: stubRequestMemoCodec,
    newId: () => `tid-${String(++ids)}`,
    receivePollMs: 60 * 60 * 1000,
  });

  const world: World = {
    api,
    engine,
    engines,
    innerClient,
    kv,
    session,
    facade,
    hooks,
    counters,
    events,
    gates,
    resolveMap,
    seed: async (amount: bigint) => {
      const token = await engine.mint({
        recipientPubkey: hexToBytes(OWN_PUB),
        value: { assets: [{ coinId: COIN, amount }] },
      });
      const bytes = token.blob.token;
      const sha = sha256Hex(bytes);
      await innerClient.uploadBlob(`fake://put/${sha}`, bytes);
      await innerClient.apply({
        transferId: `seed-${token.blob.tokenId}`,
        spent: [],
        added: [{ tokenId: token.blob.tokenId, key: sha }],
      });
      return token;
    },
    peerDeliver: async (token: SphereToken, transferId: string) => {
      const peerPort = new WalletApiDeliveryPort({
        client: new FakeWalletApiV2Client(api, peerCaller, { decodeBlob: combined }),
        kv: memoryKV(),
        identity: { privateKey: PEER_PRIV, chainPubkey: PEER_PUB },
        custody: 'inventory',
      });
      peerPort.bindDeliveryKeys((blob) => engine.deliveryKeys(blob));
      await peerPort.deliver(OWN_PUB, token.blob.token, { transferId });
    },
    gate: (name) => {
      const gate = makeGate();
      gates.push(gate);
      hooks[name] = () => gate.enter();
      return gate;
    },
  };
  worlds.push(world);
  return world;
}

export async function flushTail(ms = 25): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function eventsOf(world: World, name: string): unknown[] {
  return world.events.filter((e) => e.event === name).map((e) => e.payload);
}
