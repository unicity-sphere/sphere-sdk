import { describe, expect, it } from 'vitest';

import { secp256k1 } from '@noble/curves/secp256k1.js';

import {
  DeltaConflictError,
  WalletApiStoragePort,
  type StoragePortClient,
} from '../../../impl/wallet-api-v2/storage';
import {
  WalletApiDeliveryPort,
  computeDeliveryId,
  type DeliveryCustody,
  type WakeSource,
} from '../../../impl/wallet-api-v2/mailbox';
import {
  WalletApiSplitCheckpointStore,
  progressMessage,
  type CheckpointClient,
} from '../../../impl/wallet-api-v2/checkpoints';
import { deriveFieldEncryptionKey } from '../../../core/field-encryption';
import { SplitCheckpointLostError } from '../../../token-engine';
import { STORE_KEYS, type ScopedKV } from '../../../modules/payments-v2/stores';
import {
  FakeWalletApi,
  decodeFakeBlob,
  encodeFakeBlob,
  fakeSeedSignature,
  sha256Hex,
  type FakeBlobMeta,
  type FakeCaller,
} from './fakes/FakeWalletApi';
import { FakeWalletApiV2Client } from './fakes/fake-client';
import {
  describeStoragePortContract,
  type StorageBlobOptions,
  type StorageContractBlob,
  type StoragePortHarness,
} from './contracts/storage-port.contract';
import {
  describeDeliveryPortContract,
  expectedDeliveryId,
  type DeliveryBlobOptions,
  type DeliveryPortHarness,
} from './contracts/delivery-port.contract';

const NET = 'testnet2';
const OWNER_PRIV = '11'.repeat(32);
const SENDER_PRIV = '22'.repeat(32);

function pubOf(privHex: string): string {
  const bytes = secp256k1.getPublicKey(Uint8Array.from(Buffer.from(privHex, 'hex')), true);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const OWNER_PUB = pubOf(OWNER_PRIV);
const SENDER_PUB = pubOf(SENDER_PRIV);
const OWNER: FakeCaller = { chainPubkey: OWNER_PUB, network: NET };
const SENDER: FakeCaller = { chainPubkey: SENDER_PUB, network: NET };
const COIN = 'f0'.repeat(32);

function memKV(): ScopedKV {
  const map = new Map<string, string>();
  return {
    async get<T>(key: string): Promise<T | null> {
      const raw = map.get(key);
      return raw === undefined ? null : (JSON.parse(raw) as T);
    },
    async set<T>(key: string, value: T): Promise<void> {
      map.set(key, JSON.stringify(value));
    },
    async remove(key: string): Promise<void> {
      map.delete(key);
    },
  };
}

let uniq = 0;
function freshHex(): string {
  uniq += 1;
  return uniq.toString(16).padStart(8, '0').repeat(8);
}

interface FabricateOptions extends StorageBlobOptions, DeliveryBlobOptions {}

function fabricateBlob(ownerPubkey: string, opts: FabricateOptions = {}): StorageContractBlob {
  const meta: FakeBlobMeta & { variant?: string } = {
    tokenId: opts.tokenId ?? freshHex(),
    stateHash: opts.stateHash ?? freshHex(),
    consumedStates: opts.consumedStates ?? [],
    ownerPubkey,
    assets: [{ coinId: opts.coinId ?? COIN, amount: opts.amount ?? '100' }],
    ...(opts.variant !== undefined ? { variant: opts.variant } : {}),
  };
  const bytes = encodeFakeBlob(meta);
  return { bytes, sha256: sha256Hex(bytes), tokenId: meta.tokenId, stateHash: meta.stateHash };
}

const deriveFromFakeBlob = async (bytes: Uint8Array): Promise<{ tokenId: string; stateHash: string }> => {
  const meta = decodeFakeBlob(bytes);
  return { tokenId: meta.tokenId, stateHash: meta.stateHash };
};

// ── contract harnesses ────────────────────────────────────────────────────────

function storageHarness(): StoragePortHarness {
  const fake = new FakeWalletApi();
  const port = new WalletApiStoragePort(new FakeWalletApiV2Client(fake, OWNER));
  return {
    port,
    ownerPubkey: OWNER_PUB,
    makeBlob: (opts = {}) => fabricateBlob(opts.ownerPubkey ?? OWNER_PUB, opts),
  };
}

function deliveryHarness(): DeliveryPortHarness {
  const fake = new FakeWalletApi();
  const ownerKV = memKV();
  const storage = new WalletApiStoragePort(new FakeWalletApiV2Client(fake, OWNER));
  const makePort = ({ bound = true }: { bound?: boolean } = {}): WalletApiDeliveryPort => {
    const port = new WalletApiDeliveryPort({
      client: new FakeWalletApiV2Client(fake, OWNER),
      kv: ownerKV,
      identity: { privateKey: OWNER_PRIV, chainPubkey: OWNER_PUB },
      custody: 'inventory',
    });
    if (bound) port.bindDeliveryKeys(deriveFromFakeBlob);
    return port;
  };
  const counterpartyPort = new WalletApiDeliveryPort({
    client: new FakeWalletApiV2Client(fake, SENDER),
    kv: memKV(),
    identity: { privateKey: SENDER_PRIV, chainPubkey: SENDER_PUB },
    custody: 'inventory',
  });
  counterpartyPort.bindDeliveryKeys(deriveFromFakeBlob);
  return {
    makePort,
    storage,
    ownerPubkey: OWNER_PUB,
    counterpartyPort,
    counterpartyPubkey: SENDER_PUB,
    makeBlob: (toPubkey, opts = {}) => fabricateBlob(toPubkey, opts),
  };
}

describeStoragePortContract('WalletApiStoragePort over FakeWalletApi', () => storageHarness());
describeDeliveryPortContract('WalletApiDeliveryPort over FakeWalletApi', () => deliveryHarness());

// ── targeted: storage fan-out ─────────────────────────────────────────────────

describe('WalletApiStoragePort — request shape', () => {
  it('getBlobs makes exactly ONE blob-urls call and holds at most 8 GETs in flight', async () => {
    const fake = new FakeWalletApi();
    const client = new FakeWalletApiV2Client(fake, OWNER);
    let blobUrlCalls = 0;
    let inflight = 0;
    let maxInflight = 0;
    const counting: StoragePortClient = {
      listInventory: (since) => client.listInventory(since),
      uploadUrls: (blobs) => client.uploadUrls(blobs),
      uploadBlob: (url, bytes) => client.uploadBlob(url, bytes),
      apply: (delta) => client.apply(delta),
      blobUrls: (ids) => {
        blobUrlCalls += 1;
        return client.blobUrls(ids);
      },
      fetchBlob: async (url) => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        const bytes = await client.fetchBlob(url);
        inflight -= 1;
        return bytes;
      },
    };
    const port = new WalletApiStoragePort(counting);
    const blobs = Array.from({ length: 20 }, () => fabricateBlob(OWNER_PUB));
    await port.uploadBlobs(blobs.map((b) => ({ sha256: b.sha256, bytes: b.bytes })));
    const fetched = await port.getBlobs(blobs.map((b) => b.tokenId));
    expect(fetched.size).toBe(20);
    expect(blobUrlCalls).toBe(1);
    expect(maxInflight).toBe(8);
  });

  it('applyDelta maps a lineage 409 to DeltaConflictError carrying the cause', async () => {
    const h = storageHarness();
    const stale = h.makeBlob();
    const keys = await h.port.uploadBlobs([{ sha256: stale.sha256, bytes: stale.bytes }]);
    await h.port.applyDelta({
      transferId: 't1',
      spent: [],
      added: [{ tokenId: stale.tokenId, key: keys.get(stale.sha256) as string }],
    });
    const newer = h.makeBlob({ tokenId: stale.tokenId, consumedStates: [stale.stateHash] });
    const newerKeys = await h.port.uploadBlobs([{ sha256: newer.sha256, bytes: newer.bytes }]);
    await h.port.applyDelta({
      transferId: 't2',
      spent: [],
      added: [{ tokenId: newer.tokenId, key: newerKeys.get(newer.sha256) as string }],
    });
    const err = await h.port
      .applyDelta({
        transferId: 't3',
        spent: [],
        added: [{ tokenId: stale.tokenId, key: keys.get(stale.sha256) as string }],
      })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeltaConflictError);
    expect((err as DeltaConflictError).cause).toBeDefined();
  });
});

// ── targeted: delivery ────────────────────────────────────────────────────────

async function drain(port: WalletApiDeliveryPort, since?: string): Promise<string[]> {
  const ids: string[] = [];
  for await (const delivery of port.incoming(since)) ids.push(delivery.deliveryId);
  return ids;
}

function makeDeliveryPair(
  fake: FakeWalletApi,
  custody: DeliveryCustody,
  wake?: WakeSource
): { ownerPort: WalletApiDeliveryPort; senderPort: WalletApiDeliveryPort } {
  const ownerPort = new WalletApiDeliveryPort({
    client: new FakeWalletApiV2Client(fake, OWNER),
    kv: memKV(),
    identity: { privateKey: OWNER_PRIV, chainPubkey: OWNER_PUB },
    custody,
    ...(wake !== undefined ? { wake } : {}),
  });
  ownerPort.bindDeliveryKeys(deriveFromFakeBlob);
  const senderPort = new WalletApiDeliveryPort({
    client: new FakeWalletApiV2Client(fake, SENDER),
    kv: memKV(),
    identity: { privateKey: SENDER_PRIV, chainPubkey: SENDER_PUB, nametag: 'sender-tag' },
    custody: 'inventory',
  });
  senderPort.bindDeliveryKeys(deriveFromFakeBlob);
  return { ownerPort, senderPort };
}

describe('WalletApiDeliveryPort — targeted', () => {
  it('a transient seen-set write failure fails that ack but never bricks later acks (PR #727 review)', async () => {
    const fake = new FakeWalletApi();
    const inner = memKV();
    let failNextSet = false;
    const flakyKV: ScopedKV = {
      get: (k) => inner.get(k),
      set: (k, v) => {
        if (failNextSet) {
          failNextSet = false;
          return Promise.reject(new Error('kv outage'));
        }
        return inner.set(k, v);
      },
      remove: (k) => inner.remove(k),
    };
    const { senderPort } = makeDeliveryPair(fake, 'inventory');
    const ownerPort = new WalletApiDeliveryPort({
      client: new FakeWalletApiV2Client(fake, OWNER),
      kv: flakyKV,
      identity: { privateKey: OWNER_PRIV, chainPubkey: OWNER_PUB },
      custody: 'inventory',
    });
    ownerPort.bindDeliveryKeys(deriveFromFakeBlob);

    const blob = fabricateBlob(OWNER_PUB);
    await senderPort.deliver(OWNER_PUB, blob.bytes, { transferId: 'seen-chain-1' });
    const deliveries = [];
    for await (const d of ownerPort.incoming()) deliveries.push(d);
    expect(deliveries).toHaveLength(1);

    failNextSet = true;
    await expect(ownerPort.ack(deliveries[0]!.deliveryId, 'claimed')).rejects.toThrow('kv outage');

    await expect(ownerPort.ack(deliveries[0]!.deliveryId, 'claimed')).resolves.toBeUndefined();
    const replayed = [];
    for await (const d of ownerPort.incoming()) replayed.push(d);
    expect(replayed).toHaveLength(0);
  });

  it('the delivery memo travels the wire as an enc1. ciphertext envelope, never plaintext', async () => {
    const fake = new FakeWalletApi();
    const { senderPort } = makeDeliveryPair(fake, 'inventory');
    const blob = fabricateBlob(OWNER_PUB);
    await senderPort.deliver(OWNER_PUB, blob.bytes, { transferId: 'wire-memo', memo: 'secret coffee' });
    const page = await new FakeWalletApiV2Client(fake, OWNER).listMailbox();
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.memo?.startsWith('enc1.')).toBe(true);
    expect(page.entries[0]?.memo).not.toContain('secret coffee');
  });

  it('the sender identity nametag is bundled when options carry none, and the recipient decrypts it', async () => {
    const fake = new FakeWalletApi();
    const { ownerPort, senderPort } = makeDeliveryPair(fake, 'inventory');
    const blob = fabricateBlob(OWNER_PUB);
    await senderPort.deliver(OWNER_PUB, blob.bytes, { transferId: 'tag-fallback', memo: 'hi' });
    const deliveries = [];
    for await (const d of ownerPort.incoming()) deliveries.push(d);
    expect(deliveries[0]?.senderNametag).toBe('sender-tag');
    expect(deliveries[0]?.memo).toBe('hi');
    expect(deliveries[0]?.senderPubkey).toBe(SENDER_PUB);
  });

  it('incoming pages through more-pages from the caller cursor', async () => {
    const fake = new FakeWalletApi({ pageLimit: 2 });
    const { ownerPort, senderPort } = makeDeliveryPair(fake, 'inventory');
    const blobs = Array.from({ length: 5 }, () => fabricateBlob(OWNER_PUB));
    for (const blob of blobs) {
      await senderPort.deliver(OWNER_PUB, blob.bytes, { transferId: `page-${blob.tokenId.slice(0, 8)}` });
    }
    const ids = await drain(ownerPort);
    expect(ids).toEqual(blobs.map((b) => expectedDeliveryId(b.tokenId, b.stateHash)));
  });

  it('custody inventory is baked at construction: a plain ack(claimed) hands the token into the server inventory', async () => {
    const fake = new FakeWalletApi();
    const { ownerPort, senderPort } = makeDeliveryPair(fake, 'inventory');
    const blob = fabricateBlob(OWNER_PUB);
    await senderPort.deliver(OWNER_PUB, blob.bytes, { transferId: 'custody-inv' });
    const [id] = await drain(ownerPort);
    await ownerPort.ack(id as string, 'claimed');
    const inventory = await new FakeWalletApiV2Client(fake, OWNER).listInventory();
    expect(inventory.items.map((i) => i.tokenId)).toContain(blob.tokenId);
  });

  it('custody external is baked at construction: a plain ack(claimed) performs zero inventory writes', async () => {
    const fake = new FakeWalletApi();
    const { ownerPort, senderPort } = makeDeliveryPair(fake, 'external');
    const blob = fabricateBlob(OWNER_PUB);
    await senderPort.deliver(OWNER_PUB, blob.bytes, { transferId: 'custody-ext' });
    const [id] = await drain(ownerPort);
    await ownerPort.ack(id as string, 'claimed');
    const inventory = await new FakeWalletApiV2Client(fake, OWNER).listInventory();
    expect(inventory.items).toHaveLength(0);
  });

  it('onWake bridges the session mailbox stream only, and unsubscribing detaches it', () => {
    const handlers = new Map<string, Set<() => void>>();
    const wake: WakeSource = {
      subscribeStream: (stream, handler) => {
        const set = handlers.get(stream) ?? new Set();
        set.add(handler);
        handlers.set(stream, set);
        return () => set.delete(handler);
      },
    };
    const fake = new FakeWalletApi();
    const { ownerPort } = makeDeliveryPair(fake, 'inventory', wake);
    let woken = 0;
    const off = ownerPort.onWake(() => {
      woken += 1;
    });
    for (const handler of handlers.get('mailbox') ?? []) handler();
    expect(woken).toBe(1);
    expect((handlers.get('inventory') ?? new Set()).size).toBe(0);
    off();
    for (const handler of handlers.get('mailbox') ?? []) handler();
    expect(woken).toBe(1);
  });

  it('deliveryId equals the sha256 composition helper for the derived key pair', () => {
    expect(computeDeliveryId('ab'.repeat(32), 'cd'.repeat(32))).toBe(
      expectedDeliveryId('ab'.repeat(32), 'cd'.repeat(32))
    );
  });
});

// ── targeted: checkpoints ─────────────────────────────────────────────────────

interface CheckpointRig {
  fake: FakeWalletApi;
  client: FakeWalletApiV2Client;
  kv: ScopedKV;
  store: WalletApiSplitCheckpointStore;
  posts: { envelope: string; cachedAtPost: string | null }[];
  fieldKey: Uint8Array;
}

function checkpointRig(fake: FakeWalletApi, kv: ScopedKV = memKV()): CheckpointRig {
  const client = new FakeWalletApiV2Client(fake, OWNER);
  const fieldKey = deriveFieldEncryptionKey(OWNER_PRIV);
  const posts: CheckpointRig['posts'] = [];
  const recording: CheckpointClient = {
    postProgress: async (transferId, opIndex, envelope, signature) => {
      const cachedAtPost = await kv.get<string>(`${STORE_KEYS.checkpointCache}:${transferId}:${String(opIndex)}`);
      posts.push({ envelope, cachedAtPost });
      return client.postProgress(transferId, opIndex, envelope, signature);
    },
    getProgress: (transferId) => client.getProgress(transferId),
  };
  const store = new WalletApiSplitCheckpointStore({
    client: recording,
    kv,
    fieldKey,
    signProgress: (message) => fakeSeedSignature(OWNER_PUB, message),
  });
  return { fake, client, kv, store, posts, fieldKey };
}

const CHECKPOINT_BYTES = new TextEncoder().encode('burn-proof-checkpoint-cbor');

describe('WalletApiSplitCheckpointStore — targeted', () => {
  it('two puts of the same slot POST byte-identical envelopes (encrypt once, never re-encrypt on retry)', async () => {
    const rig = checkpointRig(new FakeWalletApi());
    await rig.client.putIntent('tx-once', 'enc1.payload', true);
    const first = await rig.store.put('tx-once', 0, CHECKPOINT_BYTES);
    const second = await rig.store.put('tx-once', 0, CHECKPOINT_BYTES);
    expect(rig.posts).toHaveLength(2);
    expect(rig.posts[1]?.envelope).toBe(rig.posts[0]?.envelope);
    expect([...first]).toEqual([...CHECKPOINT_BYTES]);
    expect([...second]).toEqual([...CHECKPOINT_BYTES]);
    expect(await rig.client.getProgress('tx-once')).toHaveLength(1);
  });

  it('the ciphertext is durably persisted to the ScopedKV BEFORE the first POST', async () => {
    const rig = checkpointRig(new FakeWalletApi());
    await rig.client.putIntent('tx-durable', 'enc1.payload', true);
    await rig.store.put('tx-durable', 3, CHECKPOINT_BYTES);
    expect(rig.posts[0]?.cachedAtPost).toBe(rig.posts[0]?.envelope);
  });

  it('a slot loser adopts the winner: put resolves with the STORED envelope plaintext, not its own', async () => {
    const fake = new FakeWalletApi();
    const winner = checkpointRig(fake);
    const loser = checkpointRig(fake);
    await winner.client.putIntent('tx-race', 'enc1.payload', true);
    const winnerBytes = new TextEncoder().encode('winner-proof');
    const loserBytes = new TextEncoder().encode('loser-proof');
    const fromWinner = await winner.store.put('tx-race', 1, winnerBytes);
    const fromLoser = await loser.store.put('tx-race', 1, loserBytes);
    expect([...fromWinner]).toEqual([...winnerBytes]);
    expect([...fromLoser]).toEqual([...winnerBytes]);
  });

  it('get returns null for an empty slot and the winner bytes for a taken slot', async () => {
    const rig = checkpointRig(new FakeWalletApi());
    await rig.client.putIntent('tx-get', 'enc1.payload', true);
    expect(await rig.store.get('tx-get', 0)).toBeNull();
    await rig.store.put('tx-get', 0, CHECKPOINT_BYTES);
    const stored = await checkpointRig(rig.fake).store.get('tx-get', 0);
    expect([...(stored ?? [])]).toEqual([...CHECKPOINT_BYTES]);
  });

  it('an undecryptable stored record surfaces SplitCheckpointLostError, never a raw decrypt error', async () => {
    const rig = checkpointRig(new FakeWalletApi());
    await rig.client.putIntent('tx-bad', 'enc1.payload', true);
    const garbage = 'not-an-envelope';
    await rig.client.postProgress(
      'tx-bad',
      0,
      garbage,
      fakeSeedSignature(OWNER_PUB, progressMessage('tx-bad', 0, garbage))
    );
    await expect(rig.store.get('tx-bad', 0)).rejects.toBeInstanceOf(SplitCheckpointLostError);
  });

  it('a checkpoint mis-served for another slot fails the AAD and surfaces SplitCheckpointLostError', async () => {
    const fake = new FakeWalletApi();
    const rig = checkpointRig(fake);
    await rig.client.putIntent('tx-aad', 'enc1.payload', true);
    await rig.store.put('tx-aad', 0, CHECKPOINT_BYTES);
    const record = (await rig.client.getProgress('tx-aad'))[0];
    const other = checkpointRig(fake);
    await other.client.putIntent('tx-other', 'enc1.payload', true);
    const envelope = record?.payload as string;
    await other.client.postProgress(
      'tx-other',
      0,
      envelope,
      fakeSeedSignature(OWNER_PUB, progressMessage('tx-other', 0, envelope))
    );
    await expect(other.store.get('tx-other', 0)).rejects.toBeInstanceOf(SplitCheckpointLostError);
  });
});
