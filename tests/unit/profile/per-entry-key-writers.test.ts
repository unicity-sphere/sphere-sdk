/**
 * Per-entry-key writer round-trip tests for the audit and
 * finalizationQueue collections (T.0.G7-fill-gaps).
 *
 * These two collections were missing from the wave G.7 per-entry-key
 * writer/reader. T.0.G7-verify (wave-g7-prereq.test.ts) established the
 * canary — once the mappings + writer plumbing land, the canary turns
 * green and these tests cover the round-trip behaviour:
 *
 *   1. write → keys appear under `${addr}.<collection>.<id>`
 *   2. write multiple entries → each lives at its own key, prefix-scan
 *      returns all of them
 *   3. write empty after non-empty → tombstone marker remains at the
 *      key (NOT a hard delete) so removals replicate cleanly via
 *      OrbitDB OpLog ordering
 *   4. id is treated as opaque — composite ids of the form
 *      `${tokenId}.${observedTokenContentHash}` survive the round-trip
 *      without being parsed
 *
 * The provider's internal layout is exercised directly against the
 * mock OrbitDB store. We do NOT exercise readback through `load()`
 * because that path requires a full UxfPackage / IPFS bundle round-
 * trip — already covered by the broader provider test suite. Here we
 * focus on the per-entry-key write path that T.1.E depends on.
 *
 * @see docs/uxf/UXF-TRANSFER-IMPL-PLAN.md §T.0.G7-fill-gaps
 * @see docs/uxf/PROFILE-ARCHITECTURE.md §10.10 (audit collection)
 * @see docs/uxf/UXF-TRANSFER-PROTOCOL.md §5.5 (finalization queue)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ProfileDatabase, OrbitDbConfig } from '../../../profile/types';
import type { FullIdentity } from '../../../types';
import type {
  TxfStorageDataBase,
  TxfAuditEntry,
  TxfFinalizationQueueEntry,
} from '../../../storage/storage-provider';
import { ProfileTokenStorageProvider } from '../../../profile/profile-token-storage-provider';
import { decryptProfileValue } from '../../../profile/encryption';
import { waitForFlushSettled } from '../../helpers/profile/waitForFlushSettled';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  l1Address: 'alpha1testaddress',
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

const ADDR = 'DIRECT_aabbcc_ddeeff';

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
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
      store.set(k, v);
    },
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async del(k: string) {
      store.delete(k);
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

// Mock UxfPackage so save() does not require a real CAR encoder.
// Issue #200 Phase 2: `toCar()` must return a real CAR (not JSON bytes)
// because the flush scheduler now calls `extractCarRootCid` +
// `pinCarBlocksToIpfs` against the result. `makeFakeUxfCar` produces a
// minimal valid single-block CAR — enough for the pin path while still
// allowing this test to bypass the real UxfPackage encoder.
vi.mock('../../../uxf/UxfPackage.js', async () => {
  const { makeFakeUxfCar } = await import('./_helpers/fake-uxf-car.js');
  return {
    UxfPackage: {
      create: () => ({
        ingestAll() {},
        merge() {},
        assembleAll: () => new Map(),
        toCar: async () => makeFakeUxfCar({ tokens: [] }),
        _tokens: [],
      }),
      fromCar: async () => ({
        _tokens: [],
        ingestAll() {},
        merge() {},
        assembleAll: () => new Map(),
        toCar: async () => makeFakeUxfCar({ tokens: [] }),
      }),
    },
  };
});

let originalFetch: typeof globalThis.fetch;
function installPinMock() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
    if (url.includes('/api/v0/dag/put') || url.includes('/api/v0/add')) {
      return new Response(JSON.stringify({ Cid: { '/': 'cid-mock' } }), { status: 200 });
    }
    return new Response('', { status: 404 });
  };
}

function buildProvider(db: MockProfileDb): ProfileTokenStorageProvider {
  const provider = new ProfileTokenStorageProvider(
    db,
    hexToBytes('11'.repeat(32)),
    ['https://mock-ipfs.test'],
    {
      config: { orbitDb: { privateKey: TEST_PRIVATE_KEY }, ipnsSnapshot: false },
      addressId: ADDR,
      encrypt: true,
      flushDebounceMs: 20,
    },
  );
  provider.setIdentity(TEST_IDENTITY);
  return provider;
}

function buildEmptyTxfData(): TxfStorageDataBase {
  return {
    _meta: {
      version: 1,
      address: ADDR,
      formatVersion: '1.0.0',
      updatedAt: Date.now(),
    },
  };
}

/**
 * Decrypt the per-entry value at `key` and parse the JSON. The provider
 * stores values via `encryptProfileValue(key, json-bytes)`; we use the
 * test fixture key (`0x11 × 32`) to decrypt.
 */
async function readEntry<T>(
  db: MockProfileDb,
  key: string,
): Promise<T | { tombstoned: true; deletedAt: number } | null> {
  const raw = db._store.get(key);
  if (!raw) return null;
  const encKey = hexToBytes('11'.repeat(32));
  const decrypted = await decryptProfileValue(encKey, raw);
  return JSON.parse(new TextDecoder().decode(decrypted));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Per-entry-key writers — audit + finalizationQueue (T.0.G7-fill-gaps)', () => {
  let db: MockProfileDb;

  beforeEach(() => {
    db = createMockDb();
    installPinMock();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // audit collection
  // -------------------------------------------------------------------------
  describe('${addr}.audit.*', () => {
    it('expands _audit array into one OrbitDB key per entry', async () => {
      const provider = buildProvider(db);
      await provider.initialize();

      const data = buildEmptyTxfData();
      const audit: TxfAuditEntry[] = [
        {
          id: 'tA.hashA',
          tokenId: 'tA',
          disposition: 'NOT_OUR_CURRENT_STATE',
          detectedAt: 1,
          observedTokenContentHash: 'hashA',
        },
        {
          id: 'tB.hashB',
          tokenId: 'tB',
          disposition: 'UNSPENDABLE_BY_US',
          detectedAt: 2,
          observedTokenContentHash: 'hashB',
          note: 'predicate mismatch',
        },
      ];
      data._audit = audit;
      await provider.save(data);
      await waitForFlushSettled(provider, 10000);

      const keys = [...db._store.keys()].filter((k) => k.startsWith(`${ADDR}.audit.`));
      expect(keys.length).toBe(2);
      expect(keys).toEqual(
        expect.arrayContaining([`${ADDR}.audit.tA.hashA`, `${ADDR}.audit.tB.hashB`]),
      );

      // Prefix-scan returns all entries.
      const scan = await db.all(`${ADDR}.audit.`);
      expect(scan.size).toBe(2);

      // Round-trip: payload at each key matches the input verbatim.
      const entryA = (await readEntry(db, `${ADDR}.audit.tA.hashA`)) as TxfAuditEntry;
      expect(entryA).toEqual(audit[0]);
      const entryB = (await readEntry(db, `${ADDR}.audit.tB.hashB`)) as TxfAuditEntry;
      expect(entryB).toEqual(audit[1]);
    });

    it('treats id as opaque — composite ids round-trip without parsing', async () => {
      // T.1.E will use `${tokenId}.${observedTokenContentHash}` as the
      // composite id. The base writer must not try to parse internal
      // structure; this fixture exercises a multi-dot composite id.
      const provider = buildProvider(db);
      await provider.initialize();

      const data = buildEmptyTxfData();
      const compositeId = '0xdeadbeef.0xcafebabe.0xfeedface';
      data._audit = [
        {
          id: compositeId,
          tokenId: '0xdeadbeef',
          disposition: 'NOT_OUR_CURRENT_STATE',
          detectedAt: 42,
          observedTokenContentHash: '0xcafebabe.0xfeedface',
        },
      ];
      await provider.save(data);
      await waitForFlushSettled(provider, 10000);

      const expectedKey = `${ADDR}.audit.${compositeId}`;
      expect(db._store.has(expectedKey)).toBe(true);
      const entry = (await readEntry(db, expectedKey)) as TxfAuditEntry;
      expect(entry.id).toBe(compositeId);
      expect(entry.observedTokenContentHash).toBe('0xcafebabe.0xfeedface');
    });

    it('removed entry leaves a tombstone marker at its key', async () => {
      const provider = buildProvider(db);
      await provider.initialize();

      // Round 1: write two audit entries.
      const data1 = buildEmptyTxfData();
      data1._audit = [
        { id: 'idKept', tokenId: 'tK', disposition: 'NOT_OUR_CURRENT_STATE', detectedAt: 1 },
        { id: 'idDropped', tokenId: 'tD', disposition: 'UNSPENDABLE_BY_US', detectedAt: 2 },
      ];
      await provider.save(data1);
      await waitForFlushSettled(provider, 10000);
      expect(db._store.has(`${ADDR}.audit.idKept`)).toBe(true);
      expect(db._store.has(`${ADDR}.audit.idDropped`)).toBe(true);

      // Round 2: drop the second entry.
      const data2 = buildEmptyTxfData();
      data2._audit = [
        { id: 'idKept', tokenId: 'tK', disposition: 'NOT_OUR_CURRENT_STATE', detectedAt: 1 },
      ];
      await provider.save(data2);
      await waitForFlushSettled(provider, 10000);

      // Kept entry: still live (parses as audit entry).
      const kept = (await readEntry(db, `${ADDR}.audit.idKept`)) as TxfAuditEntry;
      expect(kept.tokenId).toBe('tK');
      expect((kept as unknown as { tombstoned?: boolean }).tombstoned).toBeUndefined();

      // Dropped entry: tombstone marker at the same key.
      const tomb = (await readEntry(db, `${ADDR}.audit.idDropped`)) as {
        tombstoned: true;
        deletedAt: number;
      };
      expect(tomb.tombstoned).toBe(true);
      expect(typeof tomb.deletedAt).toBe('number');
    });
  });

  // -------------------------------------------------------------------------
  // finalizationQueue collection
  // -------------------------------------------------------------------------
  describe('${addr}.finalizationQueue.*', () => {
    it('expands _finalizationQueue array into one OrbitDB key per entry', async () => {
      const provider = buildProvider(db);
      await provider.initialize();

      const data = buildEmptyTxfData();
      const queue: TxfFinalizationQueueEntry[] = [
        { id: 'req-001', status: 'pending', enqueuedAt: 1000 },
        {
          id: 'req-002',
          status: 'awaiting-confirmation',
          enqueuedAt: 1001,
          payload: { tokenIds: ['tA', 'tB'] },
        },
        { id: 'req-003', status: 'pending', enqueuedAt: 1002 },
      ];
      data._finalizationQueue = queue;
      await provider.save(data);
      await waitForFlushSettled(provider, 10000);

      const keys = [...db._store.keys()].filter((k) =>
        k.startsWith(`${ADDR}.finalizationQueue.`),
      );
      expect(keys.length).toBe(3);
      expect(keys).toEqual(
        expect.arrayContaining([
          `${ADDR}.finalizationQueue.req-001`,
          `${ADDR}.finalizationQueue.req-002`,
          `${ADDR}.finalizationQueue.req-003`,
        ]),
      );

      const scan = await db.all(`${ADDR}.finalizationQueue.`);
      expect(scan.size).toBe(3);

      // Round-trip payload preservation.
      const entry2 = (await readEntry(
        db,
        `${ADDR}.finalizationQueue.req-002`,
      )) as TxfFinalizationQueueEntry;
      expect(entry2).toEqual(queue[1]);
    });

    it('removed queue entry leaves a tombstone marker', async () => {
      const provider = buildProvider(db);
      await provider.initialize();

      const data1 = buildEmptyTxfData();
      data1._finalizationQueue = [
        { id: 'reqA', status: 'pending', enqueuedAt: 1 },
        { id: 'reqB', status: 'pending', enqueuedAt: 2 },
      ];
      await provider.save(data1);
      await waitForFlushSettled(provider, 10000);

      const data2 = buildEmptyTxfData();
      data2._finalizationQueue = [
        { id: 'reqA', status: 'pending', enqueuedAt: 1 },
      ];
      await provider.save(data2);
      await waitForFlushSettled(provider, 10000);

      const tomb = (await readEntry(db, `${ADDR}.finalizationQueue.reqB`)) as {
        tombstoned: true;
        deletedAt: number;
      };
      expect(tomb.tombstoned).toBe(true);
      expect(typeof tomb.deletedAt).toBe('number');
    });
  });

  // -------------------------------------------------------------------------
  // Cross-collection isolation
  // -------------------------------------------------------------------------
  it('audit and finalizationQueue prefixes do not collide with each other or with outbox/invalid', async () => {
    const provider = buildProvider(db);
    await provider.initialize();

    const data = buildEmptyTxfData();
    data._outbox = [
      { id: 'shared-id', status: 'pending', tokenId: 't1', recipient: '@alice', createdAt: 1, data: {} },
    ];
    data._invalid = [{ tokenId: 'shared-id', reason: 'proof-invalid', detectedAt: 2 }];
    data._audit = [
      { id: 'shared-id', tokenId: 'shared-id', disposition: 'NOT_OUR_CURRENT_STATE', detectedAt: 3 },
    ];
    data._finalizationQueue = [
      { id: 'shared-id', status: 'pending', enqueuedAt: 4 },
    ];
    await provider.save(data);
    await waitForFlushSettled(provider, 10000);

    // All four collections have a key with the same trailing id but
    // distinct prefixes — they must not overwrite each other.
    expect(db._store.has(`${ADDR}.outbox.shared-id`)).toBe(true);
    expect(db._store.has(`${ADDR}.invalid.shared-id`)).toBe(true);
    expect(db._store.has(`${ADDR}.audit.shared-id`)).toBe(true);
    expect(db._store.has(`${ADDR}.finalizationQueue.shared-id`)).toBe(true);

    // Each prefix-scan returns exactly its own entry.
    expect((await db.all(`${ADDR}.outbox.`)).size).toBe(1);
    expect((await db.all(`${ADDR}.invalid.`)).size).toBe(1);
    expect((await db.all(`${ADDR}.audit.`)).size).toBe(1);
    expect((await db.all(`${ADDR}.finalizationQueue.`)).size).toBe(1);
  });
});
