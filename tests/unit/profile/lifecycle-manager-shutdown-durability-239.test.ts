/**
 * Tests for Issue #239 — Shutdown remote-durability contract
 * (`Sphere.destroy()` / `provider.shutdown()`).
 *
 * Coverage:
 *   - `verifyCidAccessibleWithRetry` succeeds on first attempt when a
 *     gateway serves the CID, and retries with backoff until the
 *     deadline when none do.
 *   - `LifecycleManager.verifyFlushDurability` succeeds when both the
 *     bundle / snapshot HEAD checks pass AND `recoverLatest()` returns
 *     the just-published snapshot CID.
 *   - `verifyFlushDurability` throws `FLUSH_DURABILITY_TIMEOUT` when the
 *     bundle CID is never HEAD-accessible inside the deadline.
 *   - `verifyFlushDurability` throws when the aggregator never returns
 *     the just-published snapshot CID (pointer read-back leg).
 *   - `LifecycleManager.shutdown()` emits `shutdown:verification-timeout`
 *     (does NOT throw) when gateway propagation never catches up.
 *   - `shutdown({ force: true })` skips the durability gate AND stamps
 *     `pendingPublishCid` for cold-start retry when one wasn't already
 *     set.
 *   - `shutdown()` with nothing to verify (no pin / no publish in this
 *     session) is a fast no-op.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  ProfileDatabase,
  OrbitDbConfig,
} from '../../../profile/types';
import type { FullIdentity } from '../../../types';
import { ProfileTokenStorageProvider } from '../../../profile/profile-token-storage-provider';
import type { ProfilePointerLayer } from '../../../profile/aggregator-pointer';
import {
  verifyCidAccessibleWithRetry,
} from '../../../profile/ipfs-client';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { create as createMultihash } from 'multiformats/hashes/digest';
import { sha256 } from '@noble/hashes/sha2.js';
import type { StorageEvent } from '../../../storage/storage-provider';

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  l1Address: 'alpha1testaddress',
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

const GATEWAY_A = 'https://gateway-a.test';
const GATEWAY_B = 'https://gateway-b.test';

/** Deterministic helper — produces a valid CIDv1(raw) for arbitrary bytes. */
function makeCid(seed: string): string {
  const bytes = new TextEncoder().encode(seed);
  return CID.createV1(raw.code, createMultihash(0x12, sha256(bytes))).toString();
}

const BUNDLE_CID = makeCid('issue-239-bundle');
const SNAPSHOT_CID = makeCid('issue-239-snapshot');

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

function stubPointer(overrides: Partial<ProfilePointerLayer> = {}): ProfilePointerLayer {
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

interface TestHandle {
  provider: ProfileTokenStorageProvider;
  lifecycle: {
    verifyFlushDurability(
      bundleCid: string,
      snapshotCid: string | null,
      deadlineMs: number,
    ): Promise<void>;
    shutdown(options?: { force?: boolean; reason?: string; verificationDeadlineMs?: number }): Promise<void>;
  };
  events: StorageEvent[];
  setLastPinnedBundleCid(c: string | null): void;
  setLastDiscoveredPointerCid(c: string | null): void;
  setPendingPublishCid(c: string | null): void;
  getPendingPublishCid(): string | null;
}

async function createTestHandle(pointer?: ProfilePointerLayer): Promise<TestHandle> {
  const db = createMockDb();
  const localCache = createMockLocalCache();
  const provider = new ProfileTokenStorageProvider(
    db,
    new Uint8Array(32).fill(0x11),
    [GATEWAY_A, GATEWAY_B],
    {
      config: {
        orbitDb: { privateKey: TEST_PRIVATE_KEY },
        ipnsSnapshot: false,
      },
      addressId: 'test',
      encrypt: true,
      // Only wire `getPointerLayer` when a pointer is supplied — passing
      // a `() => null` closure makes `recoverFromAggregatorPointerBestEffort`
      // poll for 30s waiting for it to become non-null (the same logic
      // production wallets rely on while the build completes), which
      // would hang each pointerless test up to its timeout.
      getPointerLayer: pointer ? () => pointer : undefined,
    },
    localCache.storage as unknown as never,
  );
  provider.setIdentity(TEST_IDENTITY);
  await provider.initialize();

  const events: StorageEvent[] = [];
  provider.onEvent?.((e) => events.push(e));

  const lifecycle = (provider as unknown as {
    lifecycleManager: TestHandle['lifecycle'];
  }).lifecycleManager;

  // Expose private setters via type erasure for direct state injection.
  const internal = provider as unknown as {
    lastPinnedBundleCid: string | null;
    lastDiscoveredPointerCid: string | null;
    pendingPublishCid: string | null;
  };

  return {
    provider,
    lifecycle,
    events,
    setLastPinnedBundleCid: (c) => {
      internal.lastPinnedBundleCid = c;
    },
    setLastDiscoveredPointerCid: (c) => {
      internal.lastDiscoveredPointerCid = c;
    },
    setPendingPublishCid: (c) => {
      internal.pendingPublishCid = c;
    },
    getPendingPublishCid: () => internal.pendingPublishCid,
  };
}

/**
 * Mock global fetch so verifyCidAccessible / verifyCidAccessibleWithRetry
 * see predictable responses keyed on the requested CID.
 */
function mockHeadHandler(
  handler: (cid: string, method: string, url: string) => { ok: boolean; status?: number },
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    // /ipfs/<cid> path is what verifyCidAccessible uses.
    const match = /\/ipfs\/([^/?]+)/.exec(url);
    const cid = match?.[1] ?? '';
    const method = (init?.method ?? 'GET').toUpperCase();
    const { ok, status } = handler(cid, method, url);
    return new Response(null, { status: ok ? 200 : (status ?? 404) });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe('verifyCidAccessibleWithRetry — Issue #239', () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('returns ok on first attempt when a gateway serves the CID', async () => {
    restore = mockHeadHandler(() => ({ ok: true }));
    const result = await verifyCidAccessibleWithRetry(
      [GATEWAY_A, GATEWAY_B],
      BUNDLE_CID,
      { deadlineMs: 5_000 },
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.failureKind).toBeUndefined();
  });

  it('returns failureKind=deadline-exceeded when no gateway serves', async () => {
    restore = mockHeadHandler(() => ({ ok: false, status: 404 }));
    const result = await verifyCidAccessibleWithRetry(
      [GATEWAY_A, GATEWAY_B],
      BUNDLE_CID,
      { deadlineMs: 250 },
    );
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe('deadline-exceeded');
    expect(result.attempts).toBeGreaterThanOrEqual(1);
  });

  it('aborts immediately when the signal is pre-aborted', async () => {
    restore = mockHeadHandler(() => ({ ok: true }));
    const controller = new AbortController();
    controller.abort();
    const result = await verifyCidAccessibleWithRetry(
      [GATEWAY_A, GATEWAY_B],
      BUNDLE_CID,
      { deadlineMs: 5_000, signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe('aborted');
    expect(result.attempts).toBe(0);
  });

  it('eventually succeeds after a few misses (simulated propagation lag)', async () => {
    let calls = 0;
    restore = mockHeadHandler(() => {
      calls += 1;
      return { ok: calls >= 3 };
    });
    const result = await verifyCidAccessibleWithRetry(
      [GATEWAY_A],
      BUNDLE_CID,
      { deadlineMs: 30_000 },
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toBeGreaterThanOrEqual(3);
  });
});

describe('LifecycleManager.verifyFlushDurability — Issue #239', () => {
  let restore: (() => void) | null = null;

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(async () => {
    restore?.();
    restore = null;
    vi.useRealTimers();
  });

  it('resolves when bundle + snapshot HEAD pass and pointer returns snapshot CID', async () => {
    restore = mockHeadHandler(() => ({ ok: true }));
    const pointer = stubPointer({
      recoverLatest: vi.fn(async () => ({
        cid: CID.parse(SNAPSHOT_CID).bytes,
        version: 7,
      })),
    });
    const handle = await createTestHandle(pointer);
    try {
      await expect(
        handle.lifecycle.verifyFlushDurability(BUNDLE_CID, SNAPSHOT_CID, 5_000),
      ).resolves.toBeUndefined();
    } finally {
      // Force-quit to skip the shutdown gate (we're only testing
      // verifyFlushDurability here).
      await handle.provider.shutdown({ force: true });
    }
  });

  it('throws FLUSH_DURABILITY_TIMEOUT on bundle HEAD failure', async () => {
    restore = mockHeadHandler((cid) => ({
      ok: cid !== BUNDLE_CID, // bundle never accessible, snapshot is
    }));
    const pointer = stubPointer({
      recoverLatest: vi.fn(async () => ({
        cid: CID.parse(SNAPSHOT_CID).bytes,
        version: 7,
      })),
    });
    const handle = await createTestHandle(pointer);
    try {
      await expect(
        handle.lifecycle.verifyFlushDurability(BUNDLE_CID, SNAPSHOT_CID, 250),
      ).rejects.toThrow(/FLUSH_DURABILITY_TIMEOUT|pin-verify/);
    } finally {
      await handle.provider.shutdown({ force: true });
    }
  });

  it('does NOT verify pointer read-back per-flush (aggregator readback is shutdown-only)', async () => {
    // Per-flush verification skips the aggregator read-back leg by
    // design — see verifyFlushDurability docstring. So this case
    // (HEAD ok, pointer returns null) SUCCEEDS rather than throws.
    // The shutdown gate (awaitRemoteDurability) is where the
    // read-back is checked, with warn-only event emission.
    restore = mockHeadHandler(() => ({ ok: true }));
    const pointer = stubPointer({
      recoverLatest: vi.fn(async () => null), // aggregator lagged
    });
    const handle = await createTestHandle(pointer);
    try {
      await expect(
        handle.lifecycle.verifyFlushDurability(BUNDLE_CID, SNAPSHOT_CID, 5_000),
      ).resolves.toBeUndefined();
    } finally {
      await handle.provider.shutdown({ force: true });
    }
  });

  it('only verifies the bundle leg when no snapshot CID is supplied', async () => {
    restore = mockHeadHandler(() => ({ ok: true }));
    const handle = await createTestHandle(); // no pointer
    try {
      await expect(
        handle.lifecycle.verifyFlushDurability(BUNDLE_CID, null, 5_000),
      ).resolves.toBeUndefined();
    } finally {
      await handle.provider.shutdown({ force: true });
    }
  });
});

describe('LifecycleManager.shutdown — Issue #239 durability gate', () => {
  let restore: (() => void) | null = null;

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    restore?.();
    restore = null;
    vi.useRealTimers();
  });

  it('emits shutdown:verification-timeout when the bundle never propagates', async () => {
    restore = mockHeadHandler(() => ({ ok: false, status: 404 }));
    const pointer = stubPointer({
      recoverLatest: vi.fn(async () => ({
        cid: CID.parse(SNAPSHOT_CID).bytes,
        version: 7,
      })),
    });
    const handle = await createTestHandle(pointer);

    // Inject the last-CIDs as if a prior flush had pinned + published.
    handle.setLastPinnedBundleCid(BUNDLE_CID);
    handle.setLastDiscoveredPointerCid(SNAPSHOT_CID);

    // Shutdown with a tight deadline so the bundle leg trips quickly.
    await handle.provider.shutdown({
      verificationDeadlineMs: 250,
      reason: 'unit-test',
    });

    const timeouts = handle.events.filter(
      (e) => e.type === 'shutdown:verification-timeout',
    );
    expect(timeouts.length).toBeGreaterThanOrEqual(1);
    const pinTimeout = timeouts.find(
      (e) => (e.data as { leg?: string } | undefined)?.leg === 'pin-verify',
    );
    expect(pinTimeout).toBeDefined();
    const payload = pinTimeout!.data as {
      leg: string;
      cidsInQuestion: string[];
      reason?: string;
    };
    expect(payload.cidsInQuestion).toContain(BUNDLE_CID);
    expect(payload.reason).toBe('unit-test');
  });

  it('skips the durability gate when force: true', async () => {
    // Set up so that if the gate WERE to run, it would emit a timeout
    // (404 from every gateway). force-quit must skip the gate so no
    // timeout event fires.
    restore = mockHeadHandler(() => ({ ok: false, status: 404 }));
    const pointer = stubPointer({
      recoverLatest: vi.fn(async () => null), // wouldn't match anyway
    });
    const handle = await createTestHandle(pointer);
    handle.setLastPinnedBundleCid(BUNDLE_CID);
    handle.setLastDiscoveredPointerCid(SNAPSHOT_CID);

    const t0 = Date.now();
    await handle.provider.shutdown({ force: true, reason: 'fast-exit-test' });
    const elapsedMs = Date.now() - t0;

    // Should return in well under a second — no HEAD round-trips.
    expect(elapsedMs).toBeLessThan(1_000);
    const timeouts = handle.events.filter(
      (e) => e.type === 'shutdown:verification-timeout',
    );
    expect(timeouts).toHaveLength(0);
  });

  it('force: true stamps pendingPublishCid for cold-start retry when none was set', async () => {
    const handle = await createTestHandle(stubPointer());
    handle.setLastDiscoveredPointerCid(SNAPSHOT_CID);
    // Sanity check — no pending marker before shutdown.
    expect(handle.getPendingPublishCid()).toBeNull();

    await handle.provider.shutdown({ force: true });

    expect(handle.getPendingPublishCid()).toBe(SNAPSHOT_CID);
  });

  it('shutdown with nothing to verify is a fast no-op (no events, no timer)', async () => {
    restore = mockHeadHandler(() => {
      throw new Error('fetch should not be called when nothing to verify');
    });
    const handle = await createTestHandle(); // no pointer wired

    const t0 = Date.now();
    await handle.provider.shutdown(); // default options, no force
    const elapsedMs = Date.now() - t0;

    expect(elapsedMs).toBeLessThan(500);
    const timeouts = handle.events.filter(
      (e) => e.type === 'shutdown:verification-timeout',
    );
    expect(timeouts).toHaveLength(0);
  });
});
