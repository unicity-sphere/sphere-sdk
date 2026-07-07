/**
 * Issue #330 — Tests for the inline pointer-publish durability gate.
 *
 * After PR #272, HEAD-verify of newly-pinned CIDs runs in background,
 * decoupled from the synchronous flush path. That decoupling fixed an
 * at-least-once Nostr replay loop but left a gap: the aggregator pointer
 * could be advanced before the just-pinned snapshot CID was durably
 * fetchable from the operator gateway. A cross-device reader that
 * resolved the pointer would then 404 on the snapshot CID — exactly the
 * symptom in #330.
 *
 * The fix adds an inline HEAD-verify gate inside
 * `publishAggregatorPointerBestEffort`. When configured (default 5s via
 * factory; 0 = off for legacy tests), the marker `pendingPublishCid` is
 * NOT cleared until the just-published snapshot CID is HEAD-verifiable
 * on at least one configured gateway. On gate timeout the publish is
 * classified as transient — marker stays, retry on next flush/poll.
 *
 * Tests below exercise the gate semantics directly against the
 * lifecycle-manager (not via a full flush) to keep the assertions
 * focused.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type {
  ProfileDatabase,
  OrbitDbConfig,
} from '../../../extensions/uxf/profile/types';
import type { FullIdentity } from '../../../types';
import { ProfileTokenStorageProvider } from '../../../extensions/uxf/profile/profile-token-storage-provider';
import type { ProfilePointerLayer } from '../../../extensions/uxf/profile/aggregator-pointer';

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

const FAKE_CID = 'bafkreigh2akiscaildc6ovwc6m3fy5puxhxcw7qveyf2nbn7xmqwfajeuy';

function createMockDb(): ProfileDatabase {
  const store = new Map<string, Uint8Array>();
  return {
    async connect(_config: OrbitDbConfig) {},
    async put(key: string, value: Uint8Array) {
      store.set(key, value);
    },
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async del(key: string) {
      store.delete(key);
    },
    async all(prefix?: string) {
      const out = new Map<string, Uint8Array>();
      for (const [k, v] of store) if (!prefix || k.startsWith(prefix)) out.set(k, v);
      return out;
    },
    async close() {},
    onReplication() {
      return () => {};
    },
    isConnected() {
      return true;
    },
  } as ProfileDatabase;
}

function createMockLocalCache() {
  const store = new Map<string, string>();
  return {
    storage: {
      async get(k: string) {
        return store.get(k) ?? null;
      },
      async set(k: string, v: string) {
        store.set(k, v);
      },
      async remove(k: string) {
        store.delete(k);
      },
      async clear() {
        store.clear();
      },
    },
    store,
  };
}

function stubPointer(overrides: Partial<ProfilePointerLayer>): ProfilePointerLayer {
  return {
    async recoverLatest() {
      return null;
    },
    async publish() {
      return { cid: new Uint8Array(0), version: 1, attemptsUsed: 1 } as never;
    },
    ...overrides,
  } as unknown as ProfilePointerLayer;
}

async function makeProvider(opts: {
  gateMs: number;
  ipfsGateways: string[];
  pointer: ProfilePointerLayer;
}) {
  const db = createMockDb();
  const localCache = createMockLocalCache();
  const provider = new ProfileTokenStorageProvider(
    db,
    new Uint8Array(32).fill(0x11),
    opts.ipfsGateways,
    {
      config: {
        orbitDb: { privateKey: TEST_PRIVATE_KEY },
      },
      addressId: 'test',
      encrypt: true,
      getPointerLayer: () => opts.pointer,
      pointerPublishDurabilityGateMs: opts.gateMs,
    },
    localCache.storage as unknown as never,
  );
  provider.setIdentity(TEST_IDENTITY);
  await provider.initialize();
  const lifecycle = (provider as unknown as { lifecycleManager: {
    publishAggregatorPointerBestEffort: (
      cid: string,
    ) => Promise<{ ok: boolean; transient: boolean; code?: string }>;
  } }).lifecycleManager;
  const getPendingPublishCid = (): string | null =>
    (provider as unknown as { pendingPublishCid: string | null }).pendingPublishCid;
  return { provider, lifecycle, getPendingPublishCid };
}

describe('Issue #330 — pointerPublishDurabilityGateMs', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useRealTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('clears pendingPublishCid when gate is disabled (gateMs=0) — preserves PR #272 behaviour', async () => {
    // No fetch mock needed — the gate is skipped entirely.
    const pointer = stubPointer({
      publish: vi.fn(async () => ({
        cid: new Uint8Array(0),
        version: 7,
        attemptsUsed: 1,
      })) as never,
    });
    const handle = await makeProvider({
      gateMs: 0,
      ipfsGateways: ['https://does-not-matter.test'],
      pointer,
    });
    try {
      const result = await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(result.ok).toBe(true);
      expect(result.transient).toBe(false);
      expect(handle.getPendingPublishCid()).toBeNull();
    } finally {
      await handle.provider.shutdown();
    }
  });

  it('clears pendingPublishCid when gate is enabled AND HEAD-verify succeeds', async () => {
    // Stub fetch so the HEAD-verify leg sees the CID as accessible.
    // `verifyCidAccessible` issues `HEAD ${gateway}/ipfs/<cid>`; return
    // 200 for any such probe so the verifier short-circuits to ok.
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (init?.method === 'HEAD' && url.includes('/ipfs/')) {
        return new Response('', { status: 200 });
      }
      return new Response('', { status: 404 });
    });
    globalThis.fetch = fetchStub as unknown as typeof fetch;

    const pointer = stubPointer({
      publish: vi.fn(async () => ({
        cid: new Uint8Array(0),
        version: 8,
        attemptsUsed: 1,
      })) as never,
    });
    const handle = await makeProvider({
      gateMs: 2_000,
      ipfsGateways: ['https://test-gateway.example'],
      pointer,
    });
    try {
      const result = await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(result.ok).toBe(true);
      expect(result.transient).toBe(false);
      expect(handle.getPendingPublishCid()).toBeNull();
      expect(fetchStub).toHaveBeenCalled();
    } finally {
      await handle.provider.shutdown();
    }
  });

  it('KEEPS pendingPublishCid when gate is enabled AND HEAD-verify times out (the #330 fix)', async () => {
    // Stub fetch to 404 every probe so the verifier never sees the CID.
    const fetchStub = vi.fn(async () => new Response('', { status: 404 }));
    globalThis.fetch = fetchStub as unknown as typeof fetch;

    const pointer = stubPointer({
      publish: vi.fn(async () => ({
        cid: new Uint8Array(0),
        version: 9,
        attemptsUsed: 1,
      })) as never,
    });
    // Use a tight gate so the test completes quickly.
    const handle = await makeProvider({
      gateMs: 200,
      ipfsGateways: ['https://test-gateway.example'],
      pointer,
    });
    try {
      const result = await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(result.ok).toBe(false);
      expect(result.transient).toBe(true);
      expect(result.code).toBe('IPFS_NOT_YET_DURABLE');
      // CRITICAL: marker MUST be retained so the next flush/poll retries.
      expect(handle.getPendingPublishCid()).toBe(FAKE_CID);
      expect(fetchStub).toHaveBeenCalled();
    } finally {
      await handle.provider.shutdown();
    }
  });
});
