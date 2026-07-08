/**
 * Tests for profile/token-storage-migration.ts (Issue #286)
 *
 * Verifies the bidirectional legacy ↔ Profile token-storage migration
 * helper. The helper is deliberately decoupled from PaymentsModule —
 * it operates at the `TokenStorageProvider` level — so the tests use
 * in-memory mock providers rather than a live SDK.
 *
 * Coverage:
 *   - 0-token migration is a noop with the marker set.
 *   - Token + archived + tombstone + OUTBOX + SENT + history + audit
 *     + finalizationQueue + invalid copy across with identical bytes.
 *   - Forked entries are counted but never copied (avoid silent state
 *     regressions).
 *   - 1500-token migration completes without error (no MAX_PAYLOAD_BYTES
 *     fail-loud — the helper writes via target.save which uses CARs).
 *   - Aggregator-spent gating: spent tokens are demoted to archived.
 *   - Aggregator probe error: token left in source slot, error counted.
 *   - Re-entry with marker set is a no-op (skippedDueToMarker).
 *   - Re-entry with force:true bypasses the marker.
 *   - Partial-progress recovery: marker write fails mid-run → second
 *     run resumes safely (re-writes target, re-stamps marker).
 *   - Reverse direction: profile → legacy preserves bytes.
 *   - Dry-run: counts non-zero but target.save not called.
 *   - Crash-safety: target.save failure does NOT stamp marker.
 *   - awaitNextFlush failure does NOT stamp marker.
 *   - identity without directAddress fails fast.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  migrateTokenStorage,
  migrateLegacyToProfile,
  migrateProfileToLegacy,
  isTokenStorageMigrationComplete,
  clearTokenStorageMigrationMarker,
  TOKEN_STORAGE_MIGRATION_MARKER_VERSION,
} from '../../../extensions/uxf/profile/token-storage-migration';
import type {
  TokenStorageProvider,
  TxfStorageDataBase,
  StorageProvider,
} from '../../../storage';
import type { OracleProvider } from '../../../oracle';
import type { FullIdentity } from '../../../types';
import type { TxfToken } from '../../../types/txf';
import { getAddressId } from '../../../constants';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOKEN_A = 'aa' + '00'.repeat(31);
const TOKEN_B = 'bb' + '00'.repeat(31);
const TOKEN_C = 'cc' + '00'.repeat(31);
const TOKEN_D = 'dd' + '00'.repeat(31);
const STATE_HASH_A = '0000' + 'a'.repeat(64);
const STATE_HASH_B = '0000' + 'b'.repeat(64);
const STATE_HASH_C = '0000' + 'c'.repeat(64);

const IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  directAddress: 'DIRECT://test',
  privateKey: '00' + '11'.repeat(31),
};

const ADDRESS_ID = getAddressId(IDENTITY.directAddress!);

function buildTxf(tokenId: string, stateHash?: string): TxfToken {
  return {
    version: '2.0',
    genesis: {
      data: {
        tokenId,
        tokenType: '01'.repeat(32),
        coinData: [['UCT_HEX', '1000']],
        tokenData: '',
        salt: '55'.repeat(32),
        recipient: 'DIRECT://test',
        recipientDataHash: null,
        reason: null,
      },
      inclusionProof: {
        authenticator: {
          algorithm: 'secp256k1',
          publicKey: '02' + 'aa'.repeat(32),
          signature: '30' + '44'.repeat(35),
          stateHash: stateHash ?? STATE_HASH_A,
        },
        merkleTreePath: { root: '00'.repeat(32), steps: [] },
        transactionHash: 'cd'.repeat(32),
        unicityCertificate: 'ab'.repeat(32),
      },
    },
    state: { data: '', predicate: 'de'.repeat(32) },
    transactions: [],
  };
}

interface MockProviderOptions {
  failLoad?: boolean;
  failSave?: boolean;
  /** When set, awaitNextFlush throws on call. */
  failFlush?: boolean;
  /** When set, the provider exposes awaitNextFlush as a vi.fn. */
  exposeAwaitNextFlush?: boolean;
}

interface MockProvider extends TokenStorageProvider<TxfStorageDataBase> {
  /** Operations the test should observe. */
  _calls: string[];
  /** Last data passed to save(). */
  _lastSavedData: TxfStorageDataBase | null;
  /** Mutate the stored snapshot directly (test helper). */
  _setStored(data: TxfStorageDataBase | null): void;
}

function createMockProvider(
  initial: TxfStorageDataBase | null = null,
  opts: MockProviderOptions = {},
): MockProvider {
  const calls: string[] = [];
  let stored: TxfStorageDataBase | null = initial;
  const provider: MockProvider = {
    id: 'mock',
    name: 'mock',
    type: 'local',
    _calls: calls,
    _lastSavedData: null,
    _setStored(data) {
      stored = data;
    },
    async connect() {
      calls.push('connect');
    },
    async disconnect() {
      calls.push('disconnect');
    },
    isConnected() {
      return true;
    },
    getStatus() {
      return 'connected';
    },
    setIdentity() {
      calls.push('setIdentity');
    },
    async initialize() {
      calls.push('initialize');
      return true;
    },
    async shutdown() {
      calls.push('shutdown');
    },
    async load() {
      calls.push('load');
      if (opts.failLoad) {
        return {
          success: false,
          source: 'local',
          timestamp: Date.now(),
          error: 'mock load failed',
        };
      }
      return {
        success: true,
        data: stored ?? undefined,
        source: 'local',
        timestamp: Date.now(),
      };
    },
    async save(data: TxfStorageDataBase) {
      calls.push('save');
      provider._lastSavedData = data;
      if (opts.failSave) {
        return {
          success: false,
          timestamp: Date.now(),
          error: 'mock save failed',
        };
      }
      stored = data;
      return { success: true, timestamp: Date.now() };
    },
    async sync(localData) {
      calls.push('sync');
      return { success: true, merged: localData, added: 0, removed: 0, conflicts: 0 };
    },
  };

  if (opts.exposeAwaitNextFlush) {
    provider.awaitNextFlush = async (timeoutMs?: number) => {
      // Record the call AND the timeoutMs argument so tests can assert
      // that bulk operations (migration) pass 0 / no-deadline and
      // hot-path callers pass a finite budget.
      calls.push(`awaitNextFlush:${timeoutMs ?? 'undefined'}`);
      if (opts.failFlush) {
        throw new Error('mock flush failure');
      }
    };
  }

  return provider;
}

function createMockKvStorage(): StorageProvider & {
  _store: Map<string, string>;
  _calls: string[];
} {
  const store = new Map<string, string>();
  const calls: string[] = [];
  return {
    _store: store,
    _calls: calls,
    id: 'mock-kv',
    name: 'mock-kv',
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
      calls.push(`get:${key}`);
      return store.get(key) ?? null;
    },
    async set(key: string, value: string) {
      calls.push(`set:${key}`);
      store.set(key, value);
    },
    async remove(key: string) {
      calls.push(`remove:${key}`);
      store.delete(key);
    },
    async has(key: string) {
      return store.has(key);
    },
    async keys(prefix?: string) {
      const all = Array.from(store.keys());
      return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
    },
    async clear(prefix?: string) {
      if (prefix) {
        for (const k of Array.from(store.keys())) {
          if (k.startsWith(prefix)) store.delete(k);
        }
      } else {
        store.clear();
      }
    },
    async saveTrackedAddresses() {},
    async loadTrackedAddresses() {
      return [];
    },
  };
}

function buildSourceData(opts: {
  active?: string[];
  archived?: string[];
  forked?: Array<{ tokenId: string; stateHash: string }>;
  withTombstones?: boolean;
  withOutbox?: boolean;
  withSent?: boolean;
  withHistory?: boolean;
  withAudit?: boolean;
  withFinalizationQueue?: boolean;
  withInvalid?: boolean;
  customStateHashes?: Record<string, string>;
}): TxfStorageDataBase {
  const data: Record<string, unknown> = {
    _meta: {
      version: 1,
      address: IDENTITY.chainPubkey,
      formatVersion: '2.0',
      updatedAt: 1000,
    },
  };
  for (const tid of opts.active ?? []) {
    data[`_${tid}`] = buildTxf(tid, opts.customStateHashes?.[tid]);
  }
  for (const tid of opts.archived ?? []) {
    data[`archived-${tid}`] = buildTxf(tid);
  }
  for (const f of opts.forked ?? []) {
    data[`_forked_${f.tokenId}_${f.stateHash}`] = buildTxf(f.tokenId);
  }
  if (opts.withTombstones) {
    data._tombstones = [{ tokenId: TOKEN_D, stateHash: STATE_HASH_C, timestamp: 1234 }];
  }
  if (opts.withOutbox) {
    data._outbox = [
      { id: 'o1', status: 'pending', tokenId: TOKEN_A, recipient: 'r', createdAt: 0, data: {} },
    ];
  }
  if (opts.withSent) {
    data._sent = [
      { tokenId: TOKEN_A, recipient: 'r', txHash: 'h', sentAt: 0 },
    ];
  }
  if (opts.withHistory) {
    data._history = [
      {
        dedupKey: 'SENT_x',
        id: 'h1',
        type: 'SENT',
        amount: '100',
        coinId: 'UCT',
        symbol: 'UCT',
        timestamp: 1,
      },
    ];
  }
  if (opts.withAudit) {
    data._audit = [
      { id: `${TOKEN_A}.h`, tokenId: TOKEN_A, disposition: 'NOT_OUR_CURRENT_STATE', detectedAt: 1 },
    ];
  }
  if (opts.withFinalizationQueue) {
    data._finalizationQueue = [{ id: 'req1', status: 'pending', enqueuedAt: 0 }];
  }
  if (opts.withInvalid) {
    data._invalid = [{ tokenId: TOKEN_A, reason: 'test', detectedAt: 0 }];
  }
  return data as TxfStorageDataBase;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migrateTokenStorage — happy path', () => {
  it('0-token migration → noop with marker set', async () => {
    const source = createMockProvider(buildSourceData({}));
    const target = createMockProvider(null);
    const marker = createMockKvStorage();

    const result = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
      markerStorage: marker,
    });

    expect(result.success).toBe(true);
    expect(result.tokensMigrated).toBe(0);
    expect(result.skippedDueToMarker).toBe(false);
    // Target.save was called once (with the empty TxfStorageDataBase).
    expect(target._calls.filter((c) => c === 'save').length).toBe(1);
    // Marker is set.
    const markerKey = `legacy_migration_v1_complete:${ADDRESS_ID}`;
    expect(marker._store.has(markerKey)).toBe(true);
    const payload = JSON.parse(marker._store.get(markerKey)!);
    expect(payload.v).toBe(TOKEN_STORAGE_MIGRATION_MARKER_VERSION);
    expect(payload.direction).toBe('legacy-to-profile');
  });

  it('copies every TxfStorageDataBase field', async () => {
    const source = createMockProvider(
      buildSourceData({
        active: [TOKEN_A, TOKEN_B],
        archived: [TOKEN_C],
        withTombstones: true,
        withOutbox: true,
        withSent: true,
        withHistory: true,
        withAudit: true,
        withFinalizationQueue: true,
        withInvalid: true,
      }),
    );
    const target = createMockProvider(null);

    const result = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
    });

    expect(result.success).toBe(true);
    expect(result.tokensMigrated).toBe(2);
    expect(result.archivedMigrated).toBe(1);
    expect(result.tombstonesMigrated).toBe(1);
    expect(result.outboxMigrated).toBe(1);
    expect(result.sentMigrated).toBe(1);
    expect(result.historyMigrated).toBe(1);
    expect(result.auditMigrated).toBe(1);
    expect(result.finalizationQueueMigrated).toBe(1);
    expect(result.invalidMigrated).toBe(1);

    // Verify the target snapshot is identical to source minus _meta.updatedAt
    const targetData = target._lastSavedData!;
    expect(targetData).not.toBeNull();
    expect(targetData[`_${TOKEN_A}`]).toBeDefined();
    expect(targetData[`_${TOKEN_B}`]).toBeDefined();
    expect(targetData[`archived-${TOKEN_C}`]).toBeDefined();
    expect(targetData._tombstones).toHaveLength(1);
    expect(targetData._outbox).toHaveLength(1);
    expect(targetData._sent).toHaveLength(1);
    expect(targetData._history).toHaveLength(1);
    expect(targetData._audit).toHaveLength(1);
    expect(targetData._finalizationQueue).toHaveLength(1);
    expect(targetData._invalid).toHaveLength(1);
  });

  it('source is read-only (no save/sync called on source)', async () => {
    const source = createMockProvider(buildSourceData({ active: [TOKEN_A] }));
    const target = createMockProvider(null);
    await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
    });
    // Only `load` should have been called on source.
    expect(source._calls.filter((c) => c !== 'load')).toEqual([]);
  });

  it('forked entries are migrated as-is (no key collision; preserves audit trail)', async () => {
    const source = createMockProvider(
      buildSourceData({
        active: [TOKEN_A],
        forked: [{ tokenId: TOKEN_B, stateHash: STATE_HASH_A }],
      }),
    );
    const target = createMockProvider(null);
    const result = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
    });
    // forksMigrated counts the forks copied. tokensMigrated only counts
    // ACTIVE token entries (`_<tokenId>` keys excluding reserved /
    // archived / forked).
    expect(result.tokensMigrated).toBe(1);
    expect(result.forksMigrated).toBe(1);
    // Forked key IS present on target (storage-level byte-copy).
    const targetData = target._lastSavedData!;
    const forkedKey = `_forked_${TOKEN_B}_${STATE_HASH_A}`;
    expect(targetData[forkedKey as keyof TxfStorageDataBase]).toBeDefined();
  });
});

describe('migrateTokenStorage — scale', () => {
  it('1500-token migration completes without payload-cap errors', async () => {
    const activeTokens = Array.from(
      { length: 1500 },
      (_, i) => i.toString(16).padStart(2, '0').repeat(32),
    );
    const source = createMockProvider(buildSourceData({ active: activeTokens }));
    const target = createMockProvider(null);
    const result = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
    });
    expect(result.success).toBe(true);
    expect(result.tokensMigrated).toBe(1500);
    // Single save call regardless of token count — target.save() handles
    // chunking internally (UXF CAR for Profile, multi-file for legacy).
    expect(target._calls.filter((c) => c === 'save').length).toBe(1);
  });
});

describe('migrateTokenStorage — aggregator-spent gating', () => {
  it('spent token is demoted from active to archived', async () => {
    const source = createMockProvider(
      buildSourceData({
        active: [TOKEN_A, TOKEN_B],
        customStateHashes: { [TOKEN_A]: STATE_HASH_A, [TOKEN_B]: STATE_HASH_B },
      }),
    );
    const target = createMockProvider(null);
    const oracle = {
      isSpent: vi.fn(async (_pk: string, stateHash: string) => stateHash === STATE_HASH_A),
    } as unknown as OracleProvider;

    const result = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
      oracle,
    });

    expect(result.success).toBe(true);
    expect(result.tokensMigrated).toBe(1); // TOKEN_B only
    expect(result.archivedMigrated).toBe(1); // TOKEN_A demoted to archived
    expect(result.spentTokensArchived).toBe(1);
    expect(result.oracleProbeErrors).toBe(0);

    const targetData = target._lastSavedData!;
    expect(targetData[`_${TOKEN_A}`]).toBeUndefined();
    expect(targetData[`archived-${TOKEN_A}`]).toBeDefined();
    expect(targetData[`_${TOKEN_B}`]).toBeDefined();
  });

  it('oracle probe throws → token stays in active slot, error counted', async () => {
    const source = createMockProvider(buildSourceData({ active: [TOKEN_A] }));
    const target = createMockProvider(null);
    const oracle = {
      isSpent: vi.fn(async () => {
        throw new Error('aggregator unreachable');
      }),
    } as unknown as OracleProvider;

    const result = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
      oracle,
    });

    expect(result.success).toBe(true);
    expect(result.tokensMigrated).toBe(1);
    expect(result.spentTokensArchived).toBe(0);
    expect(result.oracleProbeErrors).toBe(1);

    // Token still in active slot on target.
    const targetData = target._lastSavedData!;
    expect(targetData[`_${TOKEN_A}`]).toBeDefined();
  });

  it('oracle present but no chainPubkey on identity → probe skipped with error', async () => {
    const source = createMockProvider(buildSourceData({ active: [TOKEN_A] }));
    const target = createMockProvider(null);
    const oracle = {
      isSpent: vi.fn(async () => true),
    } as unknown as OracleProvider;

    const result = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: { ...IDENTITY, chainPubkey: '' },
      oracle,
    });

    expect(result.success).toBe(true);
    expect(result.spentTokensArchived).toBe(0);
    // isSpent was not called (no pubkey).
    expect(oracle.isSpent).not.toHaveBeenCalled();
    expect(result.errors.some((e) => /chainPubkey/.test(e.error))).toBe(true);
  });
});

describe('migrateTokenStorage — idempotency', () => {
  it('marker present + no force → second run is a no-op', async () => {
    const source = createMockProvider(buildSourceData({ active: [TOKEN_A] }));
    const target = createMockProvider(null);
    const marker = createMockKvStorage();

    const first = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
      markerStorage: marker,
    });
    expect(first.success).toBe(true);
    expect(first.skippedDueToMarker).toBe(false);

    const second = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
      markerStorage: marker,
    });
    expect(second.success).toBe(true);
    expect(second.skippedDueToMarker).toBe(true);
    expect(second.tokensMigrated).toBe(0);
    // Target.save NOT called the second time.
    expect(target._calls.filter((c) => c === 'save').length).toBe(1);
  });

  it('force:true bypasses the marker', async () => {
    const source = createMockProvider(buildSourceData({ active: [TOKEN_A] }));
    const target = createMockProvider(null);
    const marker = createMockKvStorage();

    await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
      markerStorage: marker,
    });
    const second = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
      markerStorage: marker,
      force: true,
    });
    expect(second.skippedDueToMarker).toBe(false);
    expect(second.tokensMigrated).toBe(1);
    expect(target._calls.filter((c) => c === 'save').length).toBe(2);
  });

  it('no marker storage provided → never short-circuits', async () => {
    const source = createMockProvider(buildSourceData({ active: [TOKEN_A] }));
    const target = createMockProvider(null);

    const first = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
    });
    const second = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
    });
    expect(first.tokensMigrated).toBe(1);
    expect(second.tokensMigrated).toBe(1);
    expect(target._calls.filter((c) => c === 'save').length).toBe(2);
  });

  it('legacy-to-profile marker does not collide with profile-to-legacy marker', async () => {
    const source = createMockProvider(buildSourceData({ active: [TOKEN_A] }));
    const target = createMockProvider(null);
    const marker = createMockKvStorage();

    // First direction stamps its marker.
    await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
      markerStorage: marker,
    });

    // Reverse direction sees no marker → runs.
    const reverse = await migrateTokenStorage({
      source: target, // swapped
      target: source, // swapped (the function does not actually mutate source —
                       // a mock provider will just save into the data slot)
      direction: 'profile-to-legacy',
      identity: IDENTITY,
      markerStorage: marker,
    });
    expect(reverse.skippedDueToMarker).toBe(false);
  });
});

describe('migrateTokenStorage — partial-progress recovery', () => {
  it('marker write fails mid-run → data is durable; second run completes', async () => {
    const source = createMockProvider(buildSourceData({ active: [TOKEN_A] }));
    const target = createMockProvider(null);
    const marker = createMockKvStorage();

    // Patch marker.set to throw once.
    let setCallCount = 0;
    const originalSet = marker.set.bind(marker);
    marker.set = vi.fn(async (key: string, value: string) => {
      setCallCount += 1;
      if (setCallCount === 1) {
        throw new Error('mock marker write failure');
      }
      return originalSet(key, value);
    });

    const first = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
      markerStorage: marker,
    });
    // Migration is reported as SUCCESS even if marker stamp failed:
    // the data IS durable, the next run will simply re-stamp.
    expect(first.success).toBe(true);
    expect(first.tokensMigrated).toBe(1);
    expect(first.errors.some((e) => e.phase === 'stamp-marker')).toBe(true);

    // Second run: marker not set → migration repeats → marker stamped.
    const second = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
      markerStorage: marker,
    });
    expect(second.skippedDueToMarker).toBe(false);
    expect(second.tokensMigrated).toBe(1);
    const markerKey = `legacy_migration_v1_complete:${ADDRESS_ID}`;
    expect(marker._store.has(markerKey)).toBe(true);
  });

  it('target.save failure does NOT stamp marker', async () => {
    const source = createMockProvider(buildSourceData({ active: [TOKEN_A] }));
    const target = createMockProvider(null, { failSave: true });
    const marker = createMockKvStorage();

    const result = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
      markerStorage: marker,
    });

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.phase === 'target-save')).toBe(true);
    // Marker NOT stamped.
    const markerKey = `legacy_migration_v1_complete:${ADDRESS_ID}`;
    expect(marker._store.has(markerKey)).toBe(false);
  });

  it('awaitNextFlush failure does NOT stamp marker', async () => {
    const source = createMockProvider(buildSourceData({ active: [TOKEN_A] }));
    const target = createMockProvider(null, {
      exposeAwaitNextFlush: true,
      failFlush: true,
    });
    const marker = createMockKvStorage();

    const result = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
      markerStorage: marker,
    });

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.phase === 'await-flush')).toBe(true);
    const markerKey = `legacy_migration_v1_complete:${ADDRESS_ID}`;
    expect(marker._store.has(markerKey)).toBe(false);
  });

  it('awaitNextFlush is called when target exposes it, with no-deadline argument', async () => {
    const source = createMockProvider(buildSourceData({ active: [TOKEN_A] }));
    const target = createMockProvider(null, { exposeAwaitNextFlush: true });

    const result = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
    });
    expect(result.success).toBe(true);
    // Migration MUST call awaitNextFlush with timeoutMs=0 — the bulk-
    // import flush legitimately scales with wallet size and the 30s
    // default deadline is for hot-path incoming-transfer acks only. A
    // regression that re-introduced a wall-clock cap here would
    // re-create the user-visible flush timeout reported in the migration
    // diagnosis on 2026-05-27.
    expect(target._calls).toContain('awaitNextFlush:0');
    // Defensive: no call with the legacy default surfaced.
    expect(
      target._calls.filter((c) => c.startsWith('awaitNextFlush:') && c !== 'awaitNextFlush:0'),
    ).toEqual([]);
  });

  it('source.load failure → fast-fail result without target write', async () => {
    const source = createMockProvider(null, { failLoad: true });
    const target = createMockProvider(null);

    const result = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
    });
    expect(result.success).toBe(false);
    expect(target._calls.includes('save')).toBe(false);
  });
});

describe('migrateTokenStorage — reverse direction (rollback)', () => {
  it('migrateProfileToLegacy preserves all fields', async () => {
    const sourceData = buildSourceData({
      active: [TOKEN_A, TOKEN_B],
      archived: [TOKEN_C],
      withTombstones: true,
      withOutbox: true,
      withSent: true,
    });
    const profile = createMockProvider(sourceData);
    const legacy = createMockProvider(null);

    const result = await migrateProfileToLegacy({
      profile,
      legacy,
      identity: IDENTITY,
    });

    expect(result.success).toBe(true);
    expect(result.direction).toBe('profile-to-legacy');
    expect(result.tokensMigrated).toBe(2);
    expect(result.archivedMigrated).toBe(1);
    expect(result.tombstonesMigrated).toBe(1);

    const targetData = legacy._lastSavedData!;
    expect(targetData[`_${TOKEN_A}`]).toBeDefined();
    expect(targetData[`_${TOKEN_B}`]).toBeDefined();
    expect(targetData[`archived-${TOKEN_C}`]).toBeDefined();
  });

  it('full round-trip: legacy → profile → legacy preserves bytes', async () => {
    const initial = buildSourceData({
      active: [TOKEN_A, TOKEN_B],
      archived: [TOKEN_C],
      withTombstones: true,
      withHistory: true,
    });
    const legacy = createMockProvider(initial);
    const profile = createMockProvider(null);
    const reverseLegacy = createMockProvider(null);

    await migrateLegacyToProfile({ legacy, profile, identity: IDENTITY });
    // Round-trip back to a fresh legacy target.
    await migrateProfileToLegacy({
      profile,
      legacy: reverseLegacy,
      identity: IDENTITY,
    });

    const final = reverseLegacy._lastSavedData!;
    // Token payload bytes are byte-identical (excluding _meta.updatedAt,
    // which the migration refreshes deliberately).
    expect(final[`_${TOKEN_A}`]).toEqual(initial[`_${TOKEN_A}`]);
    expect(final[`_${TOKEN_B}`]).toEqual(initial[`_${TOKEN_B}`]);
    expect(final[`archived-${TOKEN_C}`]).toEqual(initial[`archived-${TOKEN_C}`]);
    expect(final._tombstones).toEqual(initial._tombstones);
    expect(final._history).toEqual(initial._history);
  });
});

describe('migrateTokenStorage — dry run', () => {
  it('dryRun: counts non-zero but target.save not called and marker not set', async () => {
    const source = createMockProvider(
      buildSourceData({ active: [TOKEN_A, TOKEN_B] }),
    );
    const target = createMockProvider(null);
    const marker = createMockKvStorage();

    const result = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
      markerStorage: marker,
      dryRun: true,
    });

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.tokensMigrated).toBe(2);
    expect(target._calls.includes('save')).toBe(false);
    expect(marker._store.size).toBe(0);
  });
});

describe('migrateTokenStorage — edge cases', () => {
  it('identity without directAddress → fast-fail', async () => {
    const source = createMockProvider(buildSourceData({ active: [TOKEN_A] }));
    const target = createMockProvider(null);

    const result = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: { ...IDENTITY, directAddress: undefined },
    });

    expect(result.success).toBe(false);
    expect(target._calls.includes('save')).toBe(false);
  });

  it('marker read failure is non-fatal — migration proceeds', async () => {
    const source = createMockProvider(buildSourceData({ active: [TOKEN_A] }));
    const target = createMockProvider(null);
    const marker = createMockKvStorage();
    marker.get = vi.fn(async () => {
      throw new Error('mock marker read failure');
    });

    const result = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
      markerStorage: marker,
    });

    // The migration proceeds despite the read failure.
    expect(result.success).toBe(true);
    expect(result.tokensMigrated).toBe(1);
    expect(result.errors.some((e) => e.phase === 'check-marker')).toBe(true);
  });

  it('progress callback fires for each phase', async () => {
    const source = createMockProvider(buildSourceData({ active: [TOKEN_A] }));
    const target = createMockProvider(null);
    const marker = createMockKvStorage();
    const phases: string[] = [];

    await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
      markerStorage: marker,
      onProgress: (p) => phases.push(p.phase),
    });

    expect(phases).toContain('check-marker');
    expect(phases).toContain('source-load');
    expect(phases).toContain('target-save');
    expect(phases).toContain('stamp-marker');
    expect(phases).toContain('complete');
  });

  it('throwing progress callback does not abort the migration', async () => {
    const source = createMockProvider(buildSourceData({ active: [TOKEN_A] }));
    const target = createMockProvider(null);
    const result = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
      onProgress: () => {
        throw new Error('callback boom');
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('migrateTokenStorage — steelman fixes (PR #289 review)', () => {
  it('spent-token demote does NOT overwrite a pre-existing archived entry', async () => {
    // Source has BOTH an active token AND an archived entry for the
    // same tokenId — legitimate after a reissue cycle.
    const source = createMockProvider({
      _meta: {
        version: 1,
        address: IDENTITY.chainPubkey,
        formatVersion: '2.0',
        updatedAt: 1,
      },
      [`_${TOKEN_A}`]: buildTxf(TOKEN_A, STATE_HASH_A),
      [`archived-${TOKEN_A}`]: buildTxf(TOKEN_A, STATE_HASH_B), // distinct state
    } as TxfStorageDataBase);
    const target = createMockProvider(null);
    const oracle = {
      isSpent: vi.fn(async () => true), // reports active spent
    } as unknown as OracleProvider;

    const result = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
      oracle,
    });
    expect(result.success).toBe(true);
    // The demote is REFUSED because target already had archived-<TOKEN_A>.
    // Token stays in active slot; archived payload preserved.
    expect(result.spentTokensArchived).toBe(0);
    const targetData = target._lastSavedData!;
    expect(targetData[`_${TOKEN_A}`]).toBeDefined();
    expect(targetData[`archived-${TOKEN_A}`]).toBeDefined();
    // Original archived payload is preserved (stateHash=STATE_HASH_B).
    const archivedPayload = targetData[`archived-${TOKEN_A}`] as TxfToken;
    expect(archivedPayload.genesis.inclusionProof.authenticator.stateHash).toBe(STATE_HASH_B);
  });

  it('honors v=1 marker', async () => {
    const source = createMockProvider(buildSourceData({ active: [TOKEN_A] }));
    const target = createMockProvider(null);
    const marker = createMockKvStorage();
    const markerKey = `legacy_migration_v1_complete:${ADDRESS_ID}`;
    marker._store.set(
      markerKey,
      JSON.stringify({
        v: TOKEN_STORAGE_MIGRATION_MARKER_VERSION,
        direction: 'legacy-to-profile',
        addressId: ADDRESS_ID,
        completedAt: 0,
      }),
    );
    const result = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
      markerStorage: marker,
    });
    expect(result.skippedDueToMarker).toBe(true);
  });

  it('does NOT honor a future-version marker (v=2)', async () => {
    const source = createMockProvider(buildSourceData({ active: [TOKEN_A] }));
    const target = createMockProvider(null);
    const marker = createMockKvStorage();
    const markerKey = `legacy_migration_v1_complete:${ADDRESS_ID}`;
    marker._store.set(
      markerKey,
      JSON.stringify({ v: 2, direction: 'legacy-to-profile', addressId: ADDRESS_ID }),
    );
    const result = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
      markerStorage: marker,
    });
    // v=2 marker NOT honored → migration runs.
    expect(result.skippedDueToMarker).toBe(false);
    expect(result.tokensMigrated).toBe(1);
  });

  it('honors pre-versioned (non-JSON or no `v` field) markers for backward compat', async () => {
    // Case 1: non-JSON marker (plain string)
    const source1 = createMockProvider(buildSourceData({ active: [TOKEN_A] }));
    const target1 = createMockProvider(null);
    const marker1 = createMockKvStorage();
    marker1._store.set(`legacy_migration_v1_complete:${ADDRESS_ID}`, 'true');
    const result1 = await migrateTokenStorage({
      source: source1,
      target: target1,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
      markerStorage: marker1,
    });
    expect(result1.skippedDueToMarker).toBe(true);

    // Case 2: JSON marker without `v` field
    const source2 = createMockProvider(buildSourceData({ active: [TOKEN_A] }));
    const target2 = createMockProvider(null);
    const marker2 = createMockKvStorage();
    marker2._store.set(
      `legacy_migration_v1_complete:${ADDRESS_ID}`,
      JSON.stringify({ direction: 'legacy-to-profile', addressId: ADDRESS_ID }),
    );
    const result2 = await migrateTokenStorage({
      source: source2,
      target: target2,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
      markerStorage: marker2,
    });
    expect(result2.skippedDueToMarker).toBe(true);
  });

  it('does NOT honor a marker with malformed `v` (e.g., string)', async () => {
    const source = createMockProvider(buildSourceData({ active: [TOKEN_A] }));
    const target = createMockProvider(null);
    const marker = createMockKvStorage();
    marker._store.set(
      `legacy_migration_v1_complete:${ADDRESS_ID}`,
      JSON.stringify({ v: 'one' }),
    );
    const result = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
      markerStorage: marker,
    });
    expect(result.skippedDueToMarker).toBe(false);
    expect(result.tokensMigrated).toBe(1);
  });

  it('synthesizes _meta when source provides none', async () => {
    // Construct a source with NO _meta field (a malformed source).
    const source = createMockProvider({
      [`_${TOKEN_A}`]: buildTxf(TOKEN_A),
    } as unknown as TxfStorageDataBase);
    const target = createMockProvider(null);
    const result = await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
    });
    expect(result.success).toBe(true);
    const targetData = target._lastSavedData!;
    expect(targetData._meta).toBeDefined();
    expect(targetData._meta.version).toBe(1);
    expect(targetData._meta.address).toBe(IDENTITY.chainPubkey);
    expect(targetData._meta.formatVersion).toBe('2.0');
    expect(typeof targetData._meta.updatedAt).toBe('number');
  });
});

describe('migration marker helpers', () => {
  it('isTokenStorageMigrationComplete reflects marker presence', async () => {
    const marker = createMockKvStorage();
    expect(
      await isTokenStorageMigrationComplete({
        markerStorage: marker,
        direction: 'legacy-to-profile',
        identity: IDENTITY,
      }),
    ).toBe(false);

    // Run a migration to set the marker.
    const source = createMockProvider(buildSourceData({}));
    const target = createMockProvider(null);
    await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
      markerStorage: marker,
    });

    expect(
      await isTokenStorageMigrationComplete({
        markerStorage: marker,
        direction: 'legacy-to-profile',
        identity: IDENTITY,
      }),
    ).toBe(true);
  });

  it('clearTokenStorageMigrationMarker removes the marker', async () => {
    const marker = createMockKvStorage();
    const source = createMockProvider(buildSourceData({}));
    const target = createMockProvider(null);

    await migrateTokenStorage({
      source,
      target,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
      markerStorage: marker,
    });
    expect(
      await isTokenStorageMigrationComplete({
        markerStorage: marker,
        direction: 'legacy-to-profile',
        identity: IDENTITY,
      }),
    ).toBe(true);

    await clearTokenStorageMigrationMarker({
      markerStorage: marker,
      direction: 'legacy-to-profile',
      identity: IDENTITY,
    });

    expect(
      await isTokenStorageMigrationComplete({
        markerStorage: marker,
        direction: 'legacy-to-profile',
        identity: IDENTITY,
      }),
    ).toBe(false);
  });
});
