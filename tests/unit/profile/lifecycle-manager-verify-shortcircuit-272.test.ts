/**
 * Issue #272 — `verifyFlushDurability` short-circuits on already-verified CIDs.
 *
 * Background: pre-#272, each `awaitNextFlush` iteration (capped at 4)
 * called `verifyFlushDurability` from scratch — including the HEAD-verify
 * retry loop against the operator gateway. Under replay storms the same
 * bundle CID was presented many times (no save() in between), each
 * call running up to ~80 HEAD probes (4 iterations × 2 legs × ~10
 * retries) before throwing TIMEOUT.
 *
 * Fix: when both `bundleCid === getLastVerifiedBundleCid()` AND
 * `snapshotCid === null || === getLastVerifiedSnapshotCid()`, return
 * immediately. The watermark is per-provider-lifetime; a fresh flush on
 * different CIDs leaves the watermark stale (shutdown still verifies
 * the new CIDs) — there is no TTL.
 *
 * Coverage:
 *   1. First call with fresh CIDs hits the network (verifyCidAccessible
 *      fetch is invoked) and stamps the watermark.
 *   2. Second call with the SAME CIDs short-circuits (no network calls).
 *   3. A second call with a DIFFERENT bundleCid hits the network again.
 *   4. snapshotCid=null is accepted even when getLastVerifiedSnapshotCid
 *      returns null (the bundle-only common case).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ProfileDatabase,
  OrbitDbConfig,
} from '../../../profile/types';
import type { FullIdentity } from '../../../types';
import { ProfileTokenStorageProvider } from '../../../profile/profile-token-storage-provider';
import type { ProfilePointerLayer } from '../../../profile/aggregator-pointer';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { create as createMultihash } from 'multiformats/hashes/digest';
import { sha256 } from '@noble/hashes/sha2.js';

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

const GATEWAY_A = 'https://gateway-a.test';
const GATEWAY_B = 'https://gateway-b.test';

function makeCid(seed: string): string {
  const bytes = new TextEncoder().encode(seed);
  return CID.createV1(raw.code, createMultihash(0x12, sha256(bytes))).toString();
}

const BUNDLE_CID = makeCid('272-bundle-A');
const BUNDLE_CID_B = makeCid('272-bundle-B');
const SNAPSHOT_CID = makeCid('272-snapshot-A');

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

function createMockLocalCache(): {
  storage: {
    get: (k: string) => Promise<string | null>;
    set: (k: string, v: string) => Promise<void>;
    remove: (k: string) => Promise<void>;
    clear: () => Promise<void>;
  };
} {
  const store = new Map<string, string>();
  return {
    storage: {
      async get(k: string) { return store.get(k) ?? null; },
      async set(k: string, v: string) { store.set(k, v); },
      async remove(k: string) { store.delete(k); },
      async clear() { store.clear(); },
    },
  };
}

function stubPointer(): ProfilePointerLayer {
  return {
    async recoverLatest() {
      return null;
    },
    async publish() {
      return { cid: new Uint8Array(0), version: 0, attemptsUsed: 1 } as never;
    },
  } as unknown as ProfilePointerLayer;
}

async function createHandle() {
  const db = createMockDb();
  const localCache = createMockLocalCache();
  const pointer = stubPointer();
  const provider = new ProfileTokenStorageProvider(
    db,
    new Uint8Array(32).fill(0x11),
    [GATEWAY_A, GATEWAY_B],
    {
      config: { orbitDb: { privateKey: TEST_PRIVATE_KEY }, ipnsSnapshot: false },
      addressId: 'test-272',
      encrypt: true,
      getPointerLayer: () => pointer,
    },
    localCache.storage as unknown as never,
  );
  provider.setIdentity(TEST_IDENTITY);
  await provider.initialize();

  const lifecycle = (provider as unknown as {
    lifecycleManager: {
      verifyFlushDurability(b: string, s: string | null, dms: number): Promise<void>;
    };
  }).lifecycleManager;

  return { provider, lifecycle };
}

function mockFetchCounter(): { calls: number; restore: () => void } {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return {
    get calls() { return calls; },
    restore: () => { globalThis.fetch = original; },
  };
}

describe('LifecycleManager.verifyFlushDurability — short-circuit on already-verified CIDs (Issue #272)', () => {
  let restore: (() => void) | null = null;

  beforeEach(() => { vi.useRealTimers(); });
  afterEach(async () => {
    restore?.();
    restore = null;
  });

  it('first verify call hits the network and stamps the watermark', async () => {
    const counter = mockFetchCounter();
    restore = counter.restore;
    const handle = await createHandle();
    try {
      await expect(
        handle.lifecycle.verifyFlushDurability(BUNDLE_CID, SNAPSHOT_CID, 5_000),
      ).resolves.toBeUndefined();
      expect(counter.calls).toBeGreaterThanOrEqual(1);
    } finally {
      await handle.provider.shutdown({ force: true });
    }
  });

  it('second verify call with the SAME CIDs short-circuits (zero network calls)', async () => {
    const counter = mockFetchCounter();
    restore = counter.restore;
    const handle = await createHandle();
    try {
      await handle.lifecycle.verifyFlushDurability(BUNDLE_CID, SNAPSHOT_CID, 5_000);
      const callsAfterFirst = counter.calls;
      expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

      // Second call — identical CIDs. Must short-circuit.
      await handle.lifecycle.verifyFlushDurability(BUNDLE_CID, SNAPSHOT_CID, 5_000);
      expect(counter.calls).toBe(callsAfterFirst); // no additional network calls
    } finally {
      await handle.provider.shutdown({ force: true });
    }
  });

  it('second verify call with a DIFFERENT bundleCid re-hits the network', async () => {
    const counter = mockFetchCounter();
    restore = counter.restore;
    const handle = await createHandle();
    try {
      await handle.lifecycle.verifyFlushDurability(BUNDLE_CID, SNAPSHOT_CID, 5_000);
      const callsAfterFirst = counter.calls;

      // Different bundle CID — must NOT short-circuit.
      await handle.lifecycle.verifyFlushDurability(BUNDLE_CID_B, SNAPSHOT_CID, 5_000);
      expect(counter.calls).toBeGreaterThan(callsAfterFirst);
    } finally {
      await handle.provider.shutdown({ force: true });
    }
  });

  it('bundle-only verify (snapshotCid=null) short-circuits on repeat', async () => {
    const counter = mockFetchCounter();
    restore = counter.restore;
    const handle = await createHandle();
    try {
      await handle.lifecycle.verifyFlushDurability(BUNDLE_CID, null, 5_000);
      const callsAfterFirst = counter.calls;
      expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

      await handle.lifecycle.verifyFlushDurability(BUNDLE_CID, null, 5_000);
      expect(counter.calls).toBe(callsAfterFirst);
    } finally {
      await handle.provider.shutdown({ force: true });
    }
  });
});
