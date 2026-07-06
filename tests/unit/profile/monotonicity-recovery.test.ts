/**
 * Tests for Gap 4 — POINTER_MONOTONICITY_VIOLATION recovery.
 *
 * The runtime monotonicity check fires when OrbitDB has bundle CIDs
 * that aren't in `lastLoadedFromBundleCids` (stale baseline) or when a
 * flush's data is missing tokens present in `lastLoadedData` (partial
 * save). Before this fix, the violation was thrown unconditionally and
 * the at-least-once gate in PaymentsModule.handleIncomingTransfer
 * refused the Nostr ack — fine for save-driven flushes (next save
 * retries) but a deadlock for the at-least-once gate because the
 * replayed event finds no new pendingData (addToken dedup) and
 * `awaitNextFlush` returns true without re-running the flush. The
 * violation persists indefinitely.
 *
 * The fix:
 *   - `flushToIpfs` kicks off a fire-and-forget baseline refresh via
 *     `host.refreshBaselineForMonotonicity()` (queueMicrotask so the
 *     refresh's `load()` doesn't deadlock on its own flush promise).
 *   - `awaitNextFlush` permits ONE in-loop synchronous retry per call:
 *     on monotonicity violation, await `refreshBaselineForMonotonicity`
 *     and re-attempt the flush. If the refresh fails or the retry
 *     also fires the violation, surface the original error so the
 *     at-least-once gate still refuses the ack — replay on next
 *     reconnect remains the safe fallback.
 *
 * The one-shot budget prevents infinite recovery loops if the
 * violation is genuinely permanent (e.g., a peer is concurrently
 * writing new bundles faster than we can refresh the baseline).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type {
  ProfileDatabase,
  OrbitDbConfig,
  UxfBundleRef,
} from '../../../extensions/uxf/profile/types';
import type { FullIdentity } from '../../../types';
import { ProfileTokenStorageProvider } from '../../../extensions/uxf/profile/profile-token-storage-provider';
import {
  deriveProfileEncryptionKey,
  encryptProfileValue,
} from '../../../extensions/uxf/profile/encryption';
import { POINTER_MONOTONICITY_VIOLATION } from '../../../extensions/uxf/profile/profile-token-storage/flush-scheduler';

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';
const EXPECTED_ADDRESS_ID = 'DIRECT_aabbcc_ddeeff';
const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};
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

interface MockProfileDb extends ProfileDatabase {
  _store: Map<string, Uint8Array>;
}

function createMockDb(): MockProfileDb {
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
  } as MockProfileDb;
}

async function plantBundleInOrbit(
  db: MockProfileDb,
  cid: string,
  ref: UxfBundleRef,
): Promise<void> {
  const encKey = getEncryptionKey();
  db._store.set(
    `${BUNDLE_KEY_PREFIX}${cid}`,
    await encryptProfileValue(
      encKey,
      new TextEncoder().encode(JSON.stringify(ref)),
    ),
  );
}

function createProvider(db: MockProfileDb): ProfileTokenStorageProvider {
  const provider = new ProfileTokenStorageProvider(
    db,
    getEncryptionKey(),
    ['https://mock-ipfs.test'],
    {
      config: {
        orbitDb: { privateKey: TEST_PRIVATE_KEY },
        ipnsSnapshot: false,
      },
      addressId: EXPECTED_ADDRESS_ID,
      encrypt: true,
      flushDebounceMs: 30,
    },
  );
  provider.setIdentity(TEST_IDENTITY);
  return provider;
}

// Reach into the provider for the private flush-scheduler so we can
// stub `forceFlushSerialized` for the retry-logic tests.
function getFlushScheduler(provider: ProfileTokenStorageProvider): {
  forceFlushSerialized(): Promise<void>;
} {
  return (provider as unknown as { flushScheduler: { forceFlushSerialized(): Promise<void> } })
    .flushScheduler;
}

function setPendingData(provider: ProfileTokenStorageProvider): void {
  // Inject a non-null pendingData so awaitNextFlush enters its loop
  // body. The pendingData itself is never consumed because we stub
  // forceFlushSerialized.
  (provider as unknown as { pendingData: unknown }).pendingData = {
    _meta: {
      version: 1,
      address: EXPECTED_ADDRESS_ID,
      formatVersion: '1.0.0',
      updatedAt: 1_700_000_000_000,
    },
  };
}

describe('awaitNextFlush — POINTER_MONOTONICITY_VIOLATION recovery (Gap 4)', () => {
  let db: MockProfileDb;

  beforeEach(() => {
    db = createMockDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries the flush once after refreshBaselineForMonotonicity on a violation, then succeeds', async () => {
    const provider = createProvider(db);
    await provider.initialize();
    setPendingData(provider);

    const scheduler = getFlushScheduler(provider);
    let attempt = 0;
    const flushSpy = vi.spyOn(scheduler, 'forceFlushSerialized').mockImplementation(async () => {
      attempt++;
      if (attempt === 1) {
        const violation = new Error('stub monotonicity violation');
        (violation as Error & { code: string }).code = POINTER_MONOTONICITY_VIOLATION;
        // Clear pendingData on the throw to mimic the real catch
        // block re-queuing — we set it again below to keep the loop
        // entering the next iteration.
        throw violation;
      }
      // Second attempt — pretend the flush succeeded; clear pendingData
      // so the awaitNextFlush loop exits.
      (provider as unknown as { pendingData: unknown }).pendingData = null;
    });

    const refreshSpy = vi
      .spyOn(
        provider as unknown as { refreshBaselineForMonotonicity(): Promise<boolean> },
        'refreshBaselineForMonotonicity',
      )
      .mockResolvedValue(true);

    // Between iterations the real flush would have cleared+re-queued
    // pendingData; emulate the re-queue so the loop body's
    // "if pendingData is null AND no flush in flight" early-return
    // does not fire on iteration 2.
    flushSpy.mockImplementationOnce(async () => {
      const violation = new Error('stub monotonicity violation');
      (violation as Error & { code: string }).code = POINTER_MONOTONICITY_VIOLATION;
      throw violation;
    });
    flushSpy.mockImplementationOnce(async () => {
      // Successful retry.
      (provider as unknown as { pendingData: unknown }).pendingData = null;
    });

    await provider.awaitNextFlush(5_000);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(flushSpy).toHaveBeenCalledTimes(2);

    await provider.shutdown();
  });

  it('does NOT retry more than once — a second violation propagates to the caller', async () => {
    const provider = createProvider(db);
    await provider.initialize();
    setPendingData(provider);

    const scheduler = getFlushScheduler(provider);
    const flushSpy = vi.spyOn(scheduler, 'forceFlushSerialized').mockImplementation(async () => {
      const violation = new Error('persistent monotonicity violation');
      (violation as Error & { code: string }).code = POINTER_MONOTONICITY_VIOLATION;
      throw violation;
    });

    const refreshSpy = vi
      .spyOn(
        provider as unknown as { refreshBaselineForMonotonicity(): Promise<boolean> },
        'refreshBaselineForMonotonicity',
      )
      .mockResolvedValue(true);

    await expect(provider.awaitNextFlush(5_000)).rejects.toMatchObject({
      code: POINTER_MONOTONICITY_VIOLATION,
    });
    // Exactly one refresh attempt (the one-shot retry budget).
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    // Exactly two flush attempts: the initial one + the one retry.
    expect(flushSpy).toHaveBeenCalledTimes(2);

    await provider.shutdown();
  });

  it('propagates the original violation when refreshBaselineForMonotonicity returns false', async () => {
    const provider = createProvider(db);
    await provider.initialize();
    setPendingData(provider);

    const scheduler = getFlushScheduler(provider);
    const flushSpy = vi.spyOn(scheduler, 'forceFlushSerialized').mockImplementation(async () => {
      const violation = new Error('violation with failing refresh');
      (violation as Error & { code: string }).code = POINTER_MONOTONICITY_VIOLATION;
      throw violation;
    });

    const refreshSpy = vi
      .spyOn(
        provider as unknown as { refreshBaselineForMonotonicity(): Promise<boolean> },
        'refreshBaselineForMonotonicity',
      )
      .mockResolvedValue(false); // refresh failure (load() rejected)

    await expect(provider.awaitNextFlush(5_000)).rejects.toMatchObject({
      code: POINTER_MONOTONICITY_VIOLATION,
    });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    // No retry of the flush because the refresh did not succeed.
    expect(flushSpy).toHaveBeenCalledTimes(1);

    await provider.shutdown();
  });

  it('does NOT trigger recovery for non-monotonicity flush errors', async () => {
    const provider = createProvider(db);
    await provider.initialize();
    setPendingData(provider);

    const scheduler = getFlushScheduler(provider);
    const flushSpy = vi.spyOn(scheduler, 'forceFlushSerialized').mockImplementation(async () => {
      throw new Error('unrelated IPFS pin failure');
    });

    const refreshSpy = vi
      .spyOn(
        provider as unknown as { refreshBaselineForMonotonicity(): Promise<boolean> },
        'refreshBaselineForMonotonicity',
      )
      .mockResolvedValue(true);

    await expect(provider.awaitNextFlush(5_000)).rejects.toThrow(/IPFS pin failure/);
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(flushSpy).toHaveBeenCalledTimes(1);

    await provider.shutdown();
  });

  it('refreshBaselineForMonotonicity actually refreshes lastLoadedFromBundleCids from OrbitDB', async () => {
    // Direct integration check: planting a bundle in OrbitDB and
    // calling the refresh method updates the in-memory baseline.
    const provider = createProvider(db);
    await provider.initialize();

    // Seed an initial baseline with an empty set (mimics a fresh device).
    (provider as unknown as { lastLoadedFromBundleCids: Set<string> | null })
      .lastLoadedFromBundleCids = new Set();

    // Plant a bundle that the next load() should pick up.
    const cidPlant = 'bafkreigh2akiscaildc6ovwc6m3fy5puxhxcw7qveyf2nbn7xmqwfajeuy';
    await plantBundleInOrbit(db, cidPlant, {
      cid: cidPlant,
      status: 'active',
      createdAt: 1000,
    });

    // The load() that refreshBaselineForMonotonicity triggers will fail
    // when it tries to fetch the CAR (no mock-fetch installed here),
    // but the bundleIndex.listActiveBundles read DOES succeed — and
    // load() proceeds to update `lastLoadedFromBundleCids` to include
    // every bundle it enumerated, with per-bundle fetch failures
    // logged but non-fatal. So even with the CAR fetch failing, the
    // baseline-set is repaired.
    const ok = await (provider as unknown as {
      refreshBaselineForMonotonicity(): Promise<boolean>;
    }).refreshBaselineForMonotonicity();
    expect(ok).toBe(true);
    const baseline = (provider as unknown as {
      lastLoadedFromBundleCids: Set<string>;
    }).lastLoadedFromBundleCids;
    expect(baseline.has(cidPlant)).toBe(true);

    await provider.shutdown();
  });
});
