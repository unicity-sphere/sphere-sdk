/**
 * Unit tests for profile/migration/ipns-reader.ts — the one-shot
 * IPNS → pointer migration orchestrator (T-D6b).
 *
 * These tests exercise the REAL `runIpnsToPointerMigration`
 * orchestrator, injecting a fake resolver via the
 * `params.resolver` seam. That eliminates the copy-paste shim that
 * the earlier version of this file carried — production edits to
 * the orchestrator are now caught here rather than silently
 * diverging from a duplicate control-flow.
 *
 * Scope:
 *   - needsMigration heuristic (legacy marker present + done-marker
 *     absent is the only `true` case)
 *   - orchestrator skips cleanly on new wallets
 *   - orchestrator resolves + imports bundles + stamps done-marker
 *     on legacy wallets
 *   - transient resolver failure does NOT stamp the marker (the
 *     wallet must be able to retry on next load)
 *   - null-result (record genuinely absent OR total-gateway-failure)
 *     also does NOT stamp the marker — resolveIpns can't
 *     distinguish the two cases, so we fail safe (retry on every
 *     load until a positive resolve)
 *   - CID validation: malformed `bundles[].cid` strings from a
 *     potentially-hostile gateway are dropped before persistence
 */

import { describe, it, expect, vi } from 'vitest';

import {
  needsMigration,
  runIpnsToPointerMigration,
  LEGACY_IPNS_SEQUENCE_KEY,
  MIGRATION_DONE_KEY,
  type ProfileSnapshot,
} from '../../../../extensions/uxf/profile/migration/ipns-reader';

// A stable CIDv1 raw-codec string we can parse via multiformats.
const VALID_CID_A = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
const VALID_CID_B = 'bafkreidd7u5uluqqg2nwm6e3jbvjxk7vhfqsbc2dggfgxhvkosd4eqzwwm';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCache(initial: Record<string, string> = {}): {
  get: (k: string) => Promise<string | null>;
  set: (k: string, v: string) => Promise<void>;
  _store: Map<string, string>;
} {
  const store = new Map(Object.entries(initial));
  return {
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async set(k: string, v: string) {
      store.set(k, v);
    },
    _store: store,
  };
}

function makeSnapshot(bundles: Array<{ cid: string; status: 'active' | 'superseded'; createdAt?: number }>): ProfileSnapshot {
  return {
    version: 1,
    walletPubkey: '02' + 'ab'.repeat(32),
    timestamp: Date.now(),
    bundles: bundles.map((b) => ({
      cid: b.cid,
      status: b.status,
      createdAt: b.createdAt ?? 1_000_000,
    })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('needsMigration', () => {
  it('returns false for a wallet with no legacy IPNS history', async () => {
    expect(await needsMigration(makeCache())).toBe(false);
  });

  it('returns true when legacy sequence is set and done-marker is absent', async () => {
    expect(await needsMigration(makeCache({ [LEGACY_IPNS_SEQUENCE_KEY]: '5' }))).toBe(true);
  });

  it('returns false once the done-marker is set', async () => {
    expect(
      await needsMigration(
        makeCache({
          [LEGACY_IPNS_SEQUENCE_KEY]: '5',
          [MIGRATION_DONE_KEY]: '1',
        }),
      ),
    ).toBe(false);
  });
});

describe('runIpnsToPointerMigration (real orchestrator via injected resolver)', () => {
  it('skips cleanly on a new wallet (no legacy sequence)', async () => {
    const cache = makeCache();
    const onBundle = vi.fn();
    const resolver = vi.fn();

    const result = await runIpnsToPointerMigration({
      localCache: cache,
      privateKeyHex: 'aa'.repeat(32),
      gateways: ['https://ipfs.example'],
      onBundle,
      resolver,
    });

    expect(result).toEqual({ migrated: false, bundlesImported: 0, skipped: 'not-legacy' });
    expect(onBundle).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('imports bundles and stamps the done-marker on a legacy wallet', async () => {
    const cache = makeCache({ [LEGACY_IPNS_SEQUENCE_KEY]: '3' });
    const onBundle = vi.fn();
    const resolver = vi.fn().mockResolvedValue({
      cid: VALID_CID_A,
      sequence: 3n,
      snapshot: makeSnapshot([
        { cid: VALID_CID_A, status: 'active', createdAt: 1000 },
        { cid: VALID_CID_B, status: 'superseded', createdAt: 500 },
        { cid: VALID_CID_B, status: 'active', createdAt: 1100 },
      ]),
    });

    const result = await runIpnsToPointerMigration({
      localCache: cache,
      privateKeyHex: 'aa'.repeat(32),
      gateways: ['https://ipfs.example'],
      onBundle,
      resolver,
    });

    expect(result.migrated).toBe(true);
    expect(result.bundlesImported).toBe(2); // superseded entry skipped
    expect(onBundle).toHaveBeenCalledTimes(2);
    expect(onBundle).toHaveBeenCalledWith(VALID_CID_A, expect.objectContaining({ cid: VALID_CID_A }));
    expect(onBundle).toHaveBeenCalledWith(VALID_CID_B, expect.objectContaining({ cid: VALID_CID_B }));
    expect(cache._store.has(MIGRATION_DONE_KEY)).toBe(true);
  });

  it('does NOT stamp the done-marker if the resolver throws (transient network)', async () => {
    const cache = makeCache({ [LEGACY_IPNS_SEQUENCE_KEY]: '3' });
    const resolver = vi.fn().mockRejectedValue(new Error('all gateways down'));

    const result = await runIpnsToPointerMigration({
      localCache: cache,
      privateKeyHex: 'aa'.repeat(32),
      gateways: ['https://ipfs.example'],
      onBundle: vi.fn(),
      resolver,
    });

    expect(result.migrated).toBe(false);
    expect(cache._store.has(MIGRATION_DONE_KEY)).toBe(false);
  });

  it('does NOT stamp the done-marker on null result (could be transient total-gateway-failure)', async () => {
    // C1 steelman fix: resolveIpns returns null for BOTH
    // "never-published" and "every gateway failed". Stamping here
    // would permanently disable migration for a legacy wallet whose
    // gateways were briefly down on first cold-start. Fail safe —
    // no stamp, retry on next load.
    const cache = makeCache({ [LEGACY_IPNS_SEQUENCE_KEY]: '3' });
    const resolver = vi.fn().mockResolvedValue(null);

    const result = await runIpnsToPointerMigration({
      localCache: cache,
      privateKeyHex: 'aa'.repeat(32),
      gateways: ['https://ipfs.example'],
      onBundle: vi.fn(),
      resolver,
    });

    expect(result.migrated).toBe(false);
    expect(result.skipped).toBe('no-record');
    expect(cache._store.has(MIGRATION_DONE_KEY)).toBe(false);
  });

  it('individual onBundle failures are logged but do not block migration completion', async () => {
    const cache = makeCache({ [LEGACY_IPNS_SEQUENCE_KEY]: '3' });
    const onBundle = vi.fn().mockImplementation(async (cid: string) => {
      if (cid === VALID_CID_B) throw new Error('addBundle write failed');
    });
    const resolver = vi.fn().mockResolvedValue({
      cid: VALID_CID_A,
      sequence: 3n,
      snapshot: makeSnapshot([
        { cid: VALID_CID_A, status: 'active', createdAt: 1000 },
        { cid: VALID_CID_B, status: 'active', createdAt: 1100 },
      ]),
    });

    const result = await runIpnsToPointerMigration({
      localCache: cache,
      privateKeyHex: 'aa'.repeat(32),
      gateways: ['https://ipfs.example'],
      onBundle,
      resolver,
    });

    expect(result.migrated).toBe(true);
    expect(result.bundlesImported).toBe(1); // only VALID_CID_A succeeded
    expect(cache._store.has(MIGRATION_DONE_KEY)).toBe(true);
  });

  it('drops bundles with malformed CIDs from the snapshot (gateway MITM guard)', async () => {
    // C2 steelman fix: the snapshot fetch is NOT content-address-
    // verified (UnixFS wrapped), so a MITM on the `/ipfs/<cid>`
    // endpoint can inject arbitrary strings into bundles[].cid.
    // Validate via CID.parse before persistence.
    const cache = makeCache({ [LEGACY_IPNS_SEQUENCE_KEY]: '3' });
    const onBundle = vi.fn();
    const resolver = vi.fn().mockResolvedValue({
      cid: VALID_CID_A,
      sequence: 3n,
      snapshot: makeSnapshot([
        { cid: VALID_CID_A, status: 'active', createdAt: 1000 },
        { cid: 'not-a-real-cid', status: 'active', createdAt: 1100 },
        { cid: '', status: 'active', createdAt: 1200 },
        { cid: VALID_CID_B, status: 'active', createdAt: 1300 },
      ]),
    });

    const result = await runIpnsToPointerMigration({
      localCache: cache,
      privateKeyHex: 'aa'.repeat(32),
      gateways: ['https://ipfs.example'],
      onBundle,
      resolver,
    });

    expect(result.migrated).toBe(true);
    expect(result.bundlesImported).toBe(2); // only the two valid CIDs
    expect(onBundle).toHaveBeenCalledTimes(2);
    expect(onBundle).toHaveBeenCalledWith(VALID_CID_A, expect.anything());
    expect(onBundle).toHaveBeenCalledWith(VALID_CID_B, expect.anything());
    expect(onBundle).not.toHaveBeenCalledWith('not-a-real-cid', expect.anything());
    expect(onBundle).not.toHaveBeenCalledWith('', expect.anything());
  });

  it('returns skipped=already-done on a wallet where the marker was previously stamped', async () => {
    const cache = makeCache({
      [LEGACY_IPNS_SEQUENCE_KEY]: '3',
      [MIGRATION_DONE_KEY]: '1',
    });
    const resolver = vi.fn();

    const result = await runIpnsToPointerMigration({
      localCache: cache,
      privateKeyHex: 'aa'.repeat(32),
      gateways: ['https://ipfs.example'],
      onBundle: vi.fn(),
      resolver,
    });

    expect(result).toEqual({ migrated: false, bundlesImported: 0, skipped: 'already-done' });
    expect(resolver).not.toHaveBeenCalled();
  });
});
