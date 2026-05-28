/**
 * Issue #308 — read-path corrupt-OpLog auto-reset.
 *
 * PR #305 added auto-reset on the WRITE path
 * (`FlushScheduler.addBundleWithOplogAutoReset`). But the same
 * "Failed to load block for <CID>" corruption also surfaces from the
 * READ path during `LifecycleManager.initialize()` →
 * `BundleIndex.refreshKnownBundles()` → `db.all('tokens.bundle.')`.
 * Before this fix that path only swallowed the error and proceeded with
 * an empty bundle set, so a wallet that performs no bundle writes
 * re-read the unreachable head block — and re-emitted the
 * `BUNDLE_INDEX_REFRESH_FAILED` warning — on every boot, never invoking
 * the reset.
 *
 * What this test pins:
 *
 *   1. When `db.all('tokens.bundle.')` throws the lost-head-CID
 *      signature AND the adapter exposes `resetCorruptedLog`,
 *      `initialize()` triggers the reset and retries
 *      `refreshKnownBundles` ONCE against the fresh log.
 *   2. The recovery is observable: `profile:oplog-auto-resetting` and a
 *      `profile:recovered` (retrySucceeded: true) event fire.
 *   3. On successful recovery the degraded-state `BUNDLE_INDEX_REFRESH_FAILED`
 *      warning is NOT emitted (we recovered, so we do not fall back).
 *   4. Counter-case: when the adapter has NO `resetCorruptedLog`, the
 *      pre-existing tolerant fallback still applies — exactly one
 *      `BUNDLE_INDEX_REFRESH_FAILED` event, empty bundle set, no
 *      `profile:recovered`.
 *
 * @see https://github.com/unicity-sphere/sphere-sdk/issues/308
 * @see profile/profile-token-storage/oplog-auto-reset.ts
 * @see profile/profile-token-storage/lifecycle-manager.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { ProfileDatabase, OrbitDbConfig } from '../../../profile/types';
import type { FullIdentity } from '../../../types';
import { ProfileTokenStorageProvider } from '../../../profile/profile-token-storage-provider';

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  l1Address: 'alpha1testaddress',
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

const LOST_HEAD_CID =
  'bafyreihx3oaghj4gzbpvp57pz3i5ytl3ptjwdbjsymuucdfl6xkffvn2by';

/**
 * Mock OrbitDB whose `all('tokens.bundle.')` throws the lost-head-CID
 * signature until `resetCorruptedLog` runs, after which it returns an
 * empty (fresh) bundle set — modelling a corrupt OpLog head block that
 * the reset clears.
 */
function createResettableCorruptDb(opts: { withReset: boolean }) {
  const store = new Map<string, Uint8Array>();
  let resetDone = false;
  let bundleAllCalls = 0;
  const resetCorruptedLog = vi.fn(
    async (reason: { lostHeadCid?: string; context: string }) => {
      resetDone = true;
      return {
        recovered: true as const,
        lostHeadCid: reason.lostHeadCid,
        recoveredAt: Date.now(),
      };
    },
  );

  const base = {
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
      const isBundleScan = prefix?.startsWith('tokens.bundle') ?? false;
      if (isBundleScan) {
        bundleAllCalls += 1;
        if (!resetDone) {
          const err = new Error(
            '[PROFILE:ORBITDB_READ_FAILED] Failed to read all entries with ' +
              `prefix "tokens.bundle.": Failed to load block for ${LOST_HEAD_CID}`,
          );
          (err as { code?: string }).code = 'ORBITDB_READ_FAILED';
          throw err;
        }
        // Fresh log after reset — no bundles to enumerate.
        return new Map<string, Uint8Array>();
      }
      const out = new Map<string, Uint8Array>();
      for (const [k, v] of store) {
        if (!prefix || k.startsWith(prefix)) out.set(k, v);
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
  };

  const db = (
    opts.withReset ? { ...base, resetCorruptedLog } : { ...base }
  ) as ProfileDatabase & { resetCorruptedLog?: typeof resetCorruptedLog };

  return {
    db,
    resetCorruptedLog,
    get bundleAllCalls() {
      return bundleAllCalls;
    },
  };
}

function createProvider(db: ProfileDatabase): ProfileTokenStorageProvider {
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
    },
  );
  provider.setIdentity(TEST_IDENTITY);
  return provider;
}

interface CapturedEvent {
  type: string;
  code?: string;
  retrySucceeded?: boolean;
}

function captureEvents(provider: ProfileTokenStorageProvider): CapturedEvent[] {
  const events: CapturedEvent[] = [];
  provider.onEvent((ev) => {
    events.push({
      type: ev.type,
      code: (ev as { code?: string }).code,
      retrySucceeded: (ev as { data?: { retrySucceeded?: boolean } }).data
        ?.retrySucceeded,
    });
  });
  return events;
}

describe('LifecycleManager.initialize() — read-path corrupt-OpLog auto-reset (#308)', () => {
  describe('adapter exposes resetCorruptedLog', () => {
    let harness: ReturnType<typeof createResettableCorruptDb>;
    let provider: ProfileTokenStorageProvider;
    let events: CapturedEvent[];

    beforeEach(() => {
      harness = createResettableCorruptDb({ withReset: true });
      provider = createProvider(harness.db);
      events = captureEvents(provider);
    });

    it('initialize() resolves true after auto-reset', async () => {
      const ok = await provider.initialize();
      expect(ok).toBe(true);
    });

    it('triggers resetCorruptedLog exactly once on the read path', async () => {
      await provider.initialize();
      expect(harness.resetCorruptedLog).toHaveBeenCalledTimes(1);
    });

    it('retries refreshKnownBundles against the fresh log (db.all bundle scan ≥ 2)', async () => {
      await provider.initialize();
      // First call throws the signature; the post-reset retry succeeds.
      expect(harness.bundleAllCalls).toBeGreaterThanOrEqual(2);
    });

    it('emits profile:oplog-auto-resetting and profile:recovered(retrySucceeded:true)', async () => {
      await provider.initialize();
      expect(events.some((e) => e.type === 'profile:oplog-auto-resetting')).toBe(
        true,
      );
      expect(
        events.some(
          (e) => e.type === 'profile:recovered' && e.retrySucceeded === true,
        ),
      ).toBe(true);
    });

    it('does NOT emit the degraded BUNDLE_INDEX_REFRESH_FAILED warning when recovery succeeds', async () => {
      await provider.initialize();
      const degraded = events.filter(
        (e) => e.code === 'BUNDLE_INDEX_REFRESH_FAILED',
      );
      expect(degraded.length).toBe(0);
    });
  });

  describe('adapter has NO resetCorruptedLog — pre-existing tolerant fallback preserved', () => {
    let harness: ReturnType<typeof createResettableCorruptDb>;
    let provider: ProfileTokenStorageProvider;
    let events: CapturedEvent[];

    beforeEach(() => {
      harness = createResettableCorruptDb({ withReset: false });
      provider = createProvider(harness.db);
      events = captureEvents(provider);
    });

    it('initialize() still resolves true (tolerant fallback)', async () => {
      const ok = await provider.initialize();
      expect(ok).toBe(true);
    });

    it('emits exactly one BUNDLE_INDEX_REFRESH_FAILED and no profile:recovered', async () => {
      await provider.initialize();
      const degraded = events.filter(
        (e) => e.code === 'BUNDLE_INDEX_REFRESH_FAILED',
      );
      expect(degraded.length).toBe(1);
      expect(events.some((e) => e.type === 'profile:recovered')).toBe(false);
    });

    it('leaves knownBundleCids empty', async () => {
      await provider.initialize();
      const known = (
        provider as unknown as { knownBundleCids: Set<string> }
      ).knownBundleCids;
      expect(known).toBeInstanceOf(Set);
      expect(known.size).toBe(0);
    });
  });
});
