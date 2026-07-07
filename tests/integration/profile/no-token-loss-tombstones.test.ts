/**
 * G4 — No-token-loss regression: tombstones MUST survive cold-start
 * (security boundary).
 *
 * Background.
 * `_tombstones` are derived from `archived-` prefixed keys in the
 * remote bundle pool, but UXF round-trip strips that prefix. The local
 * cache at `deriver.{addr}.all` is wiped on cold-start. So tombstones
 * return EMPTY after re-import — and a Nostr re-delivery of the
 * archived-token bundle would re-ingest as if it were live.
 *
 * Pre-fix: only the local-only cache (`deriver.${addr}.all`) holds
 * tombstones. A wallet wiped + re-imported has no replay protection
 * for archived tokens until the local cache is rebuilt — which
 * requires the assembled token pool to surface them, which the
 * round-trip strips.
 *
 * Fix: also persist `_tombstones` to OrbitDB at `${addr}.tombstones`
 * so cross-device replication carries the security boundary, AND so
 * cold-start (local cache wiped, OrbitDB persisted via Profile
 * replication) hydrates from the synced source.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type {
  ProfileDatabase,
  OrbitDbConfig,
  UxfBundleRef,
} from '../../../extensions/uxf/profile/types.js';
import type { FullIdentity } from '../../../types/index.js';
import type {
  TxfStorageDataBase,
  TxfTombstone,
} from '../../../storage/storage-provider.js';
import { ProfileTokenStorageProvider } from '../../../extensions/uxf/profile/profile-token-storage-provider.js';
import {
  deriveProfileEncryptionKey,
  encryptProfileValue,
} from '../../../extensions/uxf/profile/encryption.js';
import { waitForFlushSettled } from '../../helpers/profile/waitForFlushSettled.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { create as createDigest } from 'multiformats/hashes/digest';

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

const ADDR = 'DIRECT_aabbcc_ddeeff';
const BUNDLE_KEY_PREFIX = 'tokens.bundle.';

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function getEncryptionKey(): Uint8Array {
  return deriveProfileEncryptionKey(hexToBytes(TEST_PRIVATE_KEY));
}

function buildTxfData(): TxfStorageDataBase {
  return {
    _meta: {
      version: 1,
      address: ADDR,
      formatVersion: '1.0.0',
      updatedAt: Date.now(),
    },
  };
}

function cidForBytes(bytes: Uint8Array): string {
  const digest = createDigest(0x12, sha256(bytes));
  return CID.createV1(raw.code, digest).toString();
}

interface MockProfileDb extends ProfileDatabase {
  _store: Map<string, Uint8Array>;
}

function createMockDb(): MockProfileDb {
  const store = new Map<string, Uint8Array>();
  return {
    _store: store,
    async connect(_c: OrbitDbConfig) {},
    async put(k: string, v: Uint8Array) {
      store.set(k, new Uint8Array(v));
    },
    async get(k: string) {
      const v = store.get(k);
      return v ? new Uint8Array(v) : null;
    },
    async del(k: string) {
      store.delete(k);
    },
    async all(prefix?: string) {
      const out = new Map<string, Uint8Array>();
      for (const [k, v] of store) {
        if (!prefix || k.startsWith(prefix)) out.set(k, new Uint8Array(v));
      }
      return out;
    },
    async close() {},
    onReplication() {
      return () => {};
    },
    isConnected() {
      return true;
    },
  } as MockProfileDb;
}

interface MockLocalCache {
  _kv: Map<string, string>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getStatus(): string;
  setIdentity(identity: unknown): void;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  keys(prefix?: string): Promise<string[]>;
  clear(prefix?: string): Promise<void>;
  saveTrackedAddresses(entries: unknown[]): Promise<void>;
  loadTrackedAddresses(): Promise<unknown[]>;
  id: string;
  name: string;
  type: 'local';
}

function createMockLocalCache(): MockLocalCache {
  const kv = new Map<string, string>();
  return {
    _kv: kv,
    id: 'mock-local-cache',
    name: 'Mock Local Cache',
    type: 'local',
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    getStatus() {
      return 'connected';
    },
    setIdentity() {},
    async get(key: string) {
      return kv.get(key) ?? null;
    },
    async set(key: string, value: string) {
      kv.set(key, value);
    },
    async remove(key: string) {
      kv.delete(key);
    },
    async has(key: string) {
      return kv.has(key);
    },
    async keys(prefix?: string) {
      const out: string[] = [];
      for (const k of kv.keys()) {
        if (!prefix || k.startsWith(prefix)) out.push(k);
      }
      return out;
    },
    async clear(prefix?: string) {
      if (!prefix) {
        kv.clear();
        return;
      }
      for (const k of Array.from(kv.keys())) {
        if (k.startsWith(prefix)) kv.delete(k);
      }
    },
    async saveTrackedAddresses() {},
    async loadTrackedAddresses() {
      return [];
    },
  };
}

const originalFetch = globalThis.fetch;

function installMockFetch(): void {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.toString()
        : (input as Request).url;
    if (url.includes('/api/v0/dag/put')) {
      // Compute the real CID from the multipart body so the local
      // verification step (verifyCidMatchesBytes) accepts it.
      const body = init?.body as FormData | undefined;
      let cid = 'bafkreieoqxvbojxwm5oarq22u3otpcz5p6cu7noazq57nbf6gzn5fuxhza';
      if (body && typeof (body as FormData).get === 'function') {
        const blob = (body as FormData).get('data') as Blob | null;
        if (blob) {
          const ab = await blob.arrayBuffer();
          cid = cidForBytes(new Uint8Array(ab));
        }
      }
      return new Response(JSON.stringify({ Cid: { '/': cid } }), {
        status: 200,
      });
    }
    return new Response('', { status: 404 });
  };
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

function createProvider(
  db: MockProfileDb,
  localCache: MockLocalCache | null,
): ProfileTokenStorageProvider {
  const provider = new ProfileTokenStorageProvider(
    db,
    getEncryptionKey(),
    ['https://mock-ipfs.test'],
    {
      config: {
        orbitDb: { privateKey: TEST_PRIVATE_KEY },
      },
      addressId: ADDR,
      encrypt: true,
      flushDebounceMs: 10,
    },
    localCache as unknown as Parameters<typeof ProfileTokenStorageProvider>[4],
  );
  provider.setIdentity(TEST_IDENTITY);
  return provider;
}

describe('G4 — tombstones survive cold-start (security boundary)', () => {
  let db: MockProfileDb;
  let localCache: MockLocalCache;

  beforeEach(() => {
    db = createMockDb();
    localCache = createMockLocalCache();
    installMockFetch();
  });

  afterEach(() => {
    restoreFetch();
  });

  it('tombstones written via save() are persisted to OrbitDB at `${addr}.tombstones`', async () => {
    const provider = createProvider(db, localCache);
    await provider.initialize();

    const tombstones: TxfTombstone[] = [
      {
        tokenId: 'a'.repeat(64),
        stateHash: 'b'.repeat(64),
        timestamp: 1_700_000_000_000,
      },
    ];
    const data = buildTxfData();
    data._tombstones = tombstones;
    await provider.save(data);
    // Issue #219: wait deterministically for the flush body (pin → bundle
    // write → operational state at `${addr}.tombstones`) to fully settle
    // instead of polling on a fixed timer. Under full-suite worker
    // contention the bundle write can land before the tombstone write,
    // making any fixed budget racy.
    await waitForFlushSettled(provider, 10000);

    // Dump keys for diagnostic clarity if the assertion fails — without
    // this, a flush-scheduler regression here is opaque to triage.
    if (!db._store.has(`${ADDR}.tombstones`)) {
      const keys = [...db._store.keys()];
      throw new Error(
        `Expected ${ADDR}.tombstones to exist after save() flush. Got keys=${JSON.stringify(keys)}`,
      );
    }
  });

  it('after wiping local cache + rebuilding provider, tombstones are recovered from OrbitDB', async () => {
    // Lifecycle 1: write a tombstone via save().
    const provider1 = createProvider(db, localCache);
    await provider1.initialize();
    const tombstones: TxfTombstone[] = [
      {
        tokenId: 'a'.repeat(64),
        stateHash: 'b'.repeat(64),
        timestamp: 1_700_000_000_000,
      },
    ];
    const data1 = buildTxfData();
    data1._tombstones = tombstones;
    await provider1.save(data1);
    await waitForFlushSettled(provider1, 10000);

    // Plant a dummy bundle so load() goes through the merge path
    // (zero bundles short-circuits load). Must be done BEFORE wiping
    // the local cache so the second-lifecycle load() hits the
    // operational-state read path.
    const emptyCarData = new TextEncoder().encode(JSON.stringify({ tokens: [] }));
    const cidDummy = cidForBytes(emptyCarData);
    const dummyRef: UxfBundleRef = {
      cid: cidDummy,
      status: 'active',
      createdAt: 100,
    };
    db._store.set(
      `${BUNDLE_KEY_PREFIX}${cidDummy}`,
      await encryptProfileValue(
        getEncryptionKey(),
        new TextEncoder().encode(JSON.stringify(dummyRef)),
      ),
    );
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
          ? input.toString()
          : (input as Request).url;
      if (url.includes(`/ipfs/${cidDummy}`) || url.includes(`arg=${cidDummy}`)) {
        return new Response(emptyCarData, { status: 200 });
      }
      return new Response('', { status: 404 });
    };

    // Cold-start simulation: wipe the local cache (mirrors the
    // browser-IndexedDB wipe + Profile-IPFS-replication recovery flow).
    await localCache.clear();

    // Lifecycle 2: fresh provider against the SAME db + a fresh
    // (empty) local cache.
    const localCache2 = createMockLocalCache();
    const provider2 = createProvider(db, localCache2);
    await provider2.initialize();
    const loadResult = await provider2.load();
    expect(loadResult.success).toBe(true);
    expect(loadResult.data!._tombstones).toBeDefined();
    expect(loadResult.data!._tombstones!.length).toBe(1);
    expect(loadResult.data!._tombstones![0]!.tokenId).toBe('a'.repeat(64));
  });
});
