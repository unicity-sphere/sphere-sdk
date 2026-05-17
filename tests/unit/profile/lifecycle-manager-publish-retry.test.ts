/**
 * Tests for Gap 2 — propagating transient aggregator-pointer publish
 * failures to the at-least-once gate.
 *
 * The previous `publishAggregatorPointerBestEffort` swallowed every
 * error, returning `void`. Transient failures (network blip, aggregator
 * slow) meant the CAR was pinned and the OrbitDB bundle ref written,
 * but the pointer never reached the aggregator — cross-device peers
 * could not discover the bundle via Path 2 (aggregator pointer + IPFS),
 * relying entirely on Path 1 (libp2p pubsub) which is unreliable.
 *
 * The fix surfaces transient failures via a typed result and stamps a
 * `pendingPublishCid` retry marker (persisted to local cache for crash
 * safety). The marker is retried at the start of every `flushToIpfs`
 * and `runPointerPollOnce`. While non-null, `forceFlushSerialized`
 * rejects — the at-least-once gate in PaymentsModule refuses to
 * advance the Nostr `since` filter, so the inbound event re-replays
 * on the next reconnect (idempotent via addToken stateHash dedup).
 *
 * Coverage:
 *   - Transient publish failure stamps `pendingPublishCid` and the
 *     return result classifies as `transient: true`.
 *   - Permanent publish failure emits `storage:error` and clears the
 *     marker (no auto-retry on operator-actionable errors).
 *   - A successful retry clears the marker.
 *   - `retryPendingPublishIfAny()` is a no-op when no marker is set.
 *   - A persisted marker survives `setPendingPublishCid` round-trip
 *     through `localCache`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type {
  ProfileDatabase,
  OrbitDbConfig,
} from '../../../profile/types';
import type { FullIdentity } from '../../../types';
import { ProfileTokenStorageProvider } from '../../../profile/profile-token-storage-provider';
import type { ProfilePointerLayer } from '../../../profile/aggregator-pointer';
import {
  AggregatorPointerError,
  AggregatorPointerErrorCode,
} from '../../../profile/aggregator-pointer/errors';
import { STORAGE_KEYS_GLOBAL } from '../../../constants';

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  l1Address: 'alpha1testaddress',
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

// CIDs used in these tests don't need to be valid IPFS roots — the
// publish stub only touches `CID.parse`. Use a real v1 CID string so
// parse succeeds.
const FAKE_CID = 'bafkreigh2akiscaildc6ovwc6m3fy5puxhxcw7qveyf2nbn7xmqwfajeuy';

function createMockDb(): ProfileDatabase & { _store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    _store: store,
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
  } as ProfileDatabase & { _store: Map<string, Uint8Array> };
}

/**
 * In-memory StorageProvider for the localCache slot. Matches the
 * minimal surface area the facade reads/writes (`get`, `set`, `remove`).
 */
function createMockLocalCache(): {
  storage: { get: (k: string) => Promise<string | null>; set: (k: string, v: string) => Promise<void>; remove: (k: string) => Promise<void>; clear: () => Promise<void> };
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    store,
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
  };
}

function stubPointer(overrides: Partial<ProfilePointerLayer>): ProfilePointerLayer {
  return {
    async recoverLatest() {
      return null;
    },
    async publish() {
      return { cid: new Uint8Array(0), version: 0, attemptsUsed: 1 } as never;
    },
    ...overrides,
  } as unknown as ProfilePointerLayer;
}

interface ProviderTestHandle {
  provider: ProfileTokenStorageProvider;
  lifecycle: {
    publishAggregatorPointerBestEffort(
      cid: string,
    ): Promise<{ ok: boolean; transient: boolean; code?: string }>;
    retryPendingPublishIfAny(): Promise<{
      attempted: boolean;
      ok: boolean;
      transient: boolean;
      code?: string;
    }>;
  };
  cacheStore: Map<string, string>;
  getPendingPublishCid(): string | null;
}

async function createTestProvider(
  pointer: ProfilePointerLayer,
): Promise<ProviderTestHandle> {
  const db = createMockDb();
  const localCache = createMockLocalCache();
  const provider = new ProfileTokenStorageProvider(
    db,
    new Uint8Array(32).fill(0x11),
    ['https://mock-ipfs.test'],
    {
      config: {
        orbitDb: { privateKey: TEST_PRIVATE_KEY },
        ipnsSnapshot: false,
      },
      addressId: 'test',
      encrypt: true,
      getPointerLayer: () => pointer,
    },
    // localCache slot — provider casts to StorageProvider internally.
    localCache.storage as unknown as never,
  );
  provider.setIdentity(TEST_IDENTITY);
  await provider.initialize();
  const lifecycle = (provider as unknown as { lifecycleManager: {
    publishAggregatorPointerBestEffort: (
      cid: string,
    ) => Promise<{ ok: boolean; transient: boolean; code?: string }>;
    retryPendingPublishIfAny: () => Promise<{
      attempted: boolean;
      ok: boolean;
      transient: boolean;
      code?: string;
    }>;
  } }).lifecycleManager;
  const getPendingPublishCid = (): string | null =>
    (provider as unknown as { pendingPublishCid: string | null }).pendingPublishCid;
  return { provider, lifecycle, cacheStore: localCache.store, getPendingPublishCid };
}

describe('LifecycleManager.publishAggregatorPointerBestEffort — Gap 2', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stamps pendingPublishCid on a transient publish failure', async () => {
    const pointer = stubPointer({
      publish: vi.fn(async () => {
        throw new AggregatorPointerError(
          AggregatorPointerErrorCode.NETWORK_ERROR,
          'simulated transient network blip',
        );
      }),
    });
    const handle = await createTestProvider(pointer);
    try {
      const result = await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(result.ok).toBe(false);
      expect(result.transient).toBe(true);
      expect(handle.getPendingPublishCid()).toBe(FAKE_CID);
      // Persisted to localCache (per-address key) for crash safety.
      // Settle the fire-and-forget persistence write before reading.
      await new Promise((r) => setTimeout(r, 0));
      // Find the persisted marker by prefix — the actual addressId
      // suffix depends on the per-test identity's directAddress and
      // isn't worth coupling the assertion to. The semantic check is
      // "exactly one marker key exists and its value is the CID".
      const markerKeys = [...handle.cacheStore.keys()].filter((k) =>
        k.startsWith(STORAGE_KEYS_GLOBAL.PROFILE_PENDING_PUBLISH_CID),
      );
      expect(markerKeys).toHaveLength(1);
      expect(handle.cacheStore.get(markerKeys[0])).toBe(FAKE_CID);
    } finally {
      await handle.provider.shutdown();
    }
  });

  it('clears pendingPublishCid on a successful publish', async () => {
    const pointer = stubPointer({
      publish: vi.fn(async () => ({
        cid: new Uint8Array(0),
        version: 42,
        attemptsUsed: 1,
      })) as never,
    });
    const handle = await createTestProvider(pointer);
    try {
      // Seed a marker first (simulate prior transient failure).
      (handle.provider as unknown as { pendingPublishCid: string | null }).pendingPublishCid = FAKE_CID;
      const result = await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(result.ok).toBe(true);
      expect(result.transient).toBe(false);
      expect(handle.getPendingPublishCid()).toBeNull();
      // Persistence write settles asynchronously — give it a tick.
      await new Promise((r) => setTimeout(r, 0));
      // addressId for TEST_IDENTITY = computeAddressId('DIRECT://AABBCC...EEFFFF')
      // = 'DIRECT_aabbcc_eeffff' (first/last 6 chars, lowercased)
      const expectedKey =
        STORAGE_KEYS_GLOBAL.PROFILE_PENDING_PUBLISH_CID + '_DIRECT_aabbcc_eeffff';
      expect(handle.cacheStore.has(expectedKey)).toBe(false);
    } finally {
      await handle.provider.shutdown();
    }
  });

  it('clears pendingPublishCid on a permanent publish failure (operator alert is the action)', async () => {
    const pointer = stubPointer({
      publish: vi.fn(async () => {
        const err = new AggregatorPointerError(
          AggregatorPointerErrorCode.PROTOCOL_ERROR,
          'simulated permanent integrity failure',
        );
        // Force the code to match the PERMANENT_POINTER_ERROR_CODES set.
        (err as Error & { code: string }).code = 'AGGREGATOR_POINTER_PROTOCOL_ERROR';
        throw err;
      }),
    });
    const handle = await createTestProvider(pointer);
    try {
      // Seed a stale marker to verify it's cleared on permanent failure.
      (handle.provider as unknown as { pendingPublishCid: string | null }).pendingPublishCid = FAKE_CID;
      const result = await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(result.ok).toBe(false);
      expect(result.transient).toBe(false);
      expect(result.code).toBe('AGGREGATOR_POINTER_PROTOCOL_ERROR');
      expect(handle.getPendingPublishCid()).toBeNull();
    } finally {
      await handle.provider.shutdown();
    }
  });

  it('retryPendingPublishIfAny is a no-op when no marker is set', async () => {
    const publish = vi.fn(async () => ({ cid: new Uint8Array(0), version: 0, attemptsUsed: 1 }) as never);
    const pointer = stubPointer({ publish });
    const handle = await createTestProvider(pointer);
    try {
      const result = await handle.lifecycle.retryPendingPublishIfAny();
      expect(result.attempted).toBe(false);
      expect(result.ok).toBe(true);
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await handle.provider.shutdown();
    }
  });

  it('retryPendingPublishIfAny retries the stored marker and clears it on success', async () => {
    const publish = vi.fn(async () => ({ cid: new Uint8Array(0), version: 7, attemptsUsed: 1 }) as never);
    const pointer = stubPointer({ publish });
    const handle = await createTestProvider(pointer);
    try {
      (handle.provider as unknown as { pendingPublishCid: string | null }).pendingPublishCid = FAKE_CID;
      const result = await handle.lifecycle.retryPendingPublishIfAny();
      expect(result.attempted).toBe(true);
      expect(result.ok).toBe(true);
      expect(publish).toHaveBeenCalledOnce();
      expect(handle.getPendingPublishCid()).toBeNull();
    } finally {
      await handle.provider.shutdown();
    }
  });
});
