/**
 * Tests for Issue #450 — pre-shutdown `awaitPendingPublishCleared`
 * stuck-progress detection.
 *
 * Before the fix: the retry loop in
 * `LifecycleManager.awaitPendingPublishCleared` had no awareness of
 * stable failure modes. Under contended-testnet conditions every
 * iteration could burn the reconcile algorithm's shared 5-minute
 * wall-clock budget against the same `pendingPublishCid` and the same
 * error code; the soak report observed the loop spinning at ~150% CPU
 * for 6+ hours before SIGTERM rescued the host.
 *
 * The fix:
 *   - tracks the most recent `(cid, errorCode)` tuple per iteration
 *   - emits `storage:pending-publish-stuck` after N consecutive
 *     identical failures (threshold = 3)
 *   - bails the loop and preserves the `pendingPublishCid` marker so
 *     cold-start recovery on next boot retries the publish.
 *
 * These tests assert:
 *   - The bail event fires with the expected payload after exactly N
 *     stable failures (no spurious early fire, no late fire).
 *   - The verification-timeout event still fires alongside the stuck
 *     event so existing dashboards routing on
 *     `shutdown:verification-timeout` continue to receive the leg's
 *     terminal outcome.
 *   - The bail short-circuits well before the verification deadline.
 *   - The `pendingPublishCid` marker is preserved across the bail.
 *   - When the failure code CHANGES between iterations, the counter
 *     resets and the stuck event does NOT fire (we only treat STABLE
 *     failure patterns as terminal).
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
import type { StorageEvent } from '../../../storage/storage-provider';

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  l1Address: 'alpha1testaddress',
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

const GATEWAY = 'https://gateway-a.test';

function makeCid(seed: string): string {
  const bytes = new TextEncoder().encode(seed);
  return CID.createV1(raw.code, createMultihash(0x12, sha256(bytes))).toString();
}

const PENDING_CID = makeCid('issue-450-pending');

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

/**
 * Build a stub pointer layer whose `publish()` always throws a
 * caller-controlled error. Each invocation increments a counter so
 * tests can assert how many times the publish path was exercised.
 */
function stuckPointer(opts: {
  errorForCall: (callIndex: number) => Error;
}): { pointer: ProfilePointerLayer; callCount: () => number } {
  let calls = 0;
  return {
    callCount: () => calls,
    pointer: {
      async recoverLatest() {
        return null;
      },
      async publish() {
        const idx = calls;
        calls += 1;
        throw opts.errorForCall(idx);
      },
    } as unknown as ProfilePointerLayer,
  };
}

interface TestHandle {
  provider: ProfileTokenStorageProvider;
  events: StorageEvent[];
  setPendingPublishCid(c: string | null): void;
  getPendingPublishCid(): string | null;
}

async function createTestHandle(pointer: ProfilePointerLayer): Promise<TestHandle> {
  const db = createMockDb();
  const localCache = createMockLocalCache();
  const provider = new ProfileTokenStorageProvider(
    db,
    new Uint8Array(32).fill(0x11),
    [GATEWAY],
    {
      config: {
        orbitDb: { privateKey: TEST_PRIVATE_KEY },
        ipnsSnapshot: false,
      },
      addressId: 'test',
      encrypt: true,
      getPointerLayer: () => pointer,
    },
    localCache.storage as unknown as never,
  );
  provider.setIdentity(TEST_IDENTITY);
  await provider.initialize();

  const events: StorageEvent[] = [];
  provider.onEvent?.((e) => events.push(e));

  const internal = provider as unknown as {
    pendingPublishCid: string | null;
  };

  return {
    provider,
    events,
    setPendingPublishCid: (c) => {
      internal.pendingPublishCid = c;
    },
    getPendingPublishCid: () => internal.pendingPublishCid,
  };
}

describe('LifecycleManager.awaitPendingPublishCleared — stuck-progress detection (#450)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits storage:pending-publish-stuck after 3 identical (cid, code) failures and bails', async () => {
    const stableErr = (): Error => {
      const e = new Error('Discovery exceeded wall-clock deadline after 0ms.') as Error & {
        code?: string;
      };
      e.code = 'AGGREGATOR_POINTER_RETRY_EXHAUSTED';
      return e;
    };
    const { pointer, callCount } = stuckPointer({ errorForCall: () => stableErr() });
    const handle = await createTestHandle(pointer);

    // Pre-stamp the marker so `awaitPendingPublishCleared` has work to do.
    handle.setPendingPublishCid(PENDING_CID);

    // 10s deadline gives the loop ample time to spin past 3 retries
    // (each at 1s cadence) if the fix were not in place. We assert
    // below that shutdown completes WELL under that budget.
    const t0 = Date.now();
    await handle.provider.shutdown({
      verificationDeadlineMs: 10_000,
      reason: 'unit-test-stuck',
    });
    const elapsedMs = Date.now() - t0;

    const stuckEvents = handle.events.filter(
      (e) => e.type === 'storage:pending-publish-stuck',
    );
    expect(stuckEvents).toHaveLength(1);

    const payload = stuckEvents[0].data as {
      cid: string;
      consecutiveFailures: number;
      lastError?: string;
      elapsedMs: number;
      reason?: string;
    };
    expect(payload.cid).toBe(PENDING_CID);
    expect(payload.consecutiveFailures).toBe(3);
    expect(payload.lastError).toBe('AGGREGATOR_POINTER_RETRY_EXHAUSTED');
    expect(payload.reason).toBe('unit-test-stuck');
    expect(stuckEvents[0].code).toBe('AGGREGATOR_POINTER_RETRY_EXHAUSTED');

    // Companion verification-timeout signal still fires for legacy
    // dashboards routing on that event.
    const timeouts = handle.events.filter(
      (e) =>
        e.type === 'shutdown:verification-timeout' &&
        (e.data as { leg?: string } | undefined)?.leg === 'pending-publish-retry',
    );
    expect(timeouts).toHaveLength(1);
    expect((timeouts[0].data as { cidsInQuestion: string[] }).cidsInQuestion).toContain(
      PENDING_CID,
    );

    // The pending marker is PRESERVED across the bail so cold-start
    // recovery can retry the publish on next boot.
    expect(handle.getPendingPublishCid()).toBe(PENDING_CID);

    // The bail short-circuits well under the 10s verification deadline.
    // 3 retries × 1s cadence ≈ 3s of sleeps; allow generous headroom.
    expect(elapsedMs).toBeLessThan(7_000);

    // `pointer.publish` was called exactly 3 times — the bail prevented
    // a 4th retry that the old code would have attempted.
    expect(callCount()).toBe(3);
  }, 15_000);

  it('does NOT fire the stuck event when failure codes rotate (counter resets)', async () => {
    // Each call alternates between two codes — every iteration looks
    // DIFFERENT than the previous, so `consecutiveSameFailures` never
    // reaches 3.
    const rotateErr = (idx: number): Error => {
      const e = new Error(`rotating failure ${idx}`) as Error & { code?: string };
      e.code = idx % 2 === 0 ? 'CODE_A' : 'CODE_B';
      return e;
    };
    const { pointer, callCount } = stuckPointer({ errorForCall: rotateErr });
    const handle = await createTestHandle(pointer);
    handle.setPendingPublishCid(PENDING_CID);

    // Short deadline keeps the test fast; we only care that NO stuck
    // event fires — the verification-timeout will fire on deadline
    // expiry, which is fine.
    await handle.provider.shutdown({
      verificationDeadlineMs: 3_500,
      reason: 'unit-test-rotating',
    });

    const stuckEvents = handle.events.filter(
      (e) => e.type === 'storage:pending-publish-stuck',
    );
    expect(stuckEvents).toHaveLength(0);

    // Marker preserved (no successful publish).
    expect(handle.getPendingPublishCid()).toBe(PENDING_CID);

    // `pointer.publish` was called more than 3 times — the rotating
    // code prevented the stuck-detection short-circuit.
    expect(callCount()).toBeGreaterThan(3);
  }, 10_000);
});
