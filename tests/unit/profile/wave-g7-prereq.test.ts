/**
 * Wave G.7 prerequisite verification (T.0.G7-verify).
 *
 * Verifies that the per-entry-key storage layout — used to expand
 * `{addr}.<collection>` into `${addr}.<collection>.${id}` records —
 * round-trips cleanly through the OrbitDB → KV translation for the
 * four prefix-scan key shapes the UXF inter-wallet transfer protocol
 * relies on:
 *
 *   1. `${addr}.outbox.*`               — outgoing transfer outbox
 *   2. `${addr}.invalid.*`              — cryptographically broken tokens
 *   3. `${addr}.audit.*`                — structurally-valid-but-unspendable
 *   4. `${addr}.finalizationQueue.*`    — pending chain-mode finalizations
 *
 * Acceptance: if any shape FAILS to round-trip on `main`, this test
 * fails loudly with a message identifying which shape is missing —
 * the conditional task `T.0.G7-fill-gaps` then becomes a hard
 * prerequisite for `T.1.E`. If all 4 pass, `T.0.G7-fill-gaps` is
 * dropped from the schedule.
 *
 * @see docs/uxf/UXF-TRANSFER-IMPL-PLAN.md §T.0.G7-verify
 * @see docs/uxf/UXF-TRANSFER-PROTOCOL.md §7 (outbox key shape)
 * @see docs/uxf/PROFILE-ARCHITECTURE.md §10.12
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ProfileDatabase, OrbitDbConfig } from '../../../profile/types';
import type { FullIdentity } from '../../../types';
import type { TxfStorageDataBase } from '../../../storage/storage-provider';
import { ProfileTokenStorageProvider } from '../../../profile/profile-token-storage-provider';
import { PROFILE_KEY_MAPPING } from '../../../profile/types';

// ---------------------------------------------------------------------------
// Fixtures (mirrors profile-token-storage-provider.test.ts conventions)
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
vi.mock('../../../uxf/UxfPackage.js', () => ({
  UxfPackage: {
    create: () => ({
      ingestAll() {},
      merge() {},
      assembleAll: () => new Map(),
      toCar: async () => new TextEncoder().encode('{}'),
      _tokens: [],
    }),
    fromCar: async () => ({
      _tokens: [],
      ingestAll() {},
      merge() {},
      assembleAll: () => new Map(),
      toCar: async () => new TextEncoder().encode('{}'),
    }),
  },
}));

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Wave G.7 prerequisite verification (T.0.G7-verify)', () => {
  let db: MockProfileDb;

  beforeEach(() => {
    db = createMockDb();
    installPinMock();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // Shape 1 of 4: {addr}.outbox.*  — REQUIRED by T.1.E
  // -------------------------------------------------------------------------
  it('shape 1: ${addr}.outbox.* — per-entry-key writer round-trips', async () => {
    const provider = buildProvider(db);
    await provider.initialize();

    const data: TxfStorageDataBase = {
      _meta: { version: 1, address: ADDR, formatVersion: '1.0.0', updatedAt: Date.now() },
    };
    data._outbox = [
      { id: 'oA', status: 'pending', tokenId: 't1', recipient: '@alice', createdAt: 1, data: {} },
      { id: 'oB', status: 'pending', tokenId: 't2', recipient: '@bob', createdAt: 2, data: {} },
    ];
    await provider.save(data);
    await new Promise((r) => setTimeout(r, 100));

    const perEntryKeys = [...db._store.keys()].filter((k) => k.startsWith(`${ADDR}.outbox.`));
    expect(
      perEntryKeys.length,
      `WAVE G.7 GAP: expected per-entry-key writer to expand _outbox into ` +
        `${ADDR}.outbox.<id> records, found 0 keys. T.0.G7-fill-gaps required.`,
    ).toBe(2);
    expect(perEntryKeys).toEqual(
      expect.arrayContaining([`${ADDR}.outbox.oA`, `${ADDR}.outbox.oB`]),
    );
    // Prefix-scan recognizes the shape.
    const scan = await db.all(`${ADDR}.outbox.`);
    expect(scan.size).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Shape 2 of 4: {addr}.invalid.*  — REQUIRED by T.1.E
  // -------------------------------------------------------------------------
  it('shape 2: ${addr}.invalid.* — per-entry-key writer round-trips', async () => {
    const provider = buildProvider(db);
    await provider.initialize();

    const data: TxfStorageDataBase = {
      _meta: { version: 1, address: ADDR, formatVersion: '1.0.0', updatedAt: Date.now() },
    };
    data._invalid = [
      { tokenId: 'tBad1', reason: 'proof-invalid', detectedAt: 1 },
      { tokenId: 'tBad2', reason: 'continuity-broken', detectedAt: 2 },
    ];
    await provider.save(data);
    await new Promise((r) => setTimeout(r, 100));

    const perEntryKeys = [...db._store.keys()].filter((k) => k.startsWith(`${ADDR}.invalid.`));
    expect(
      perEntryKeys.length,
      `WAVE G.7 GAP: expected per-entry-key writer to expand _invalid into ` +
        `${ADDR}.invalid.<tokenId> records, found 0 keys. T.0.G7-fill-gaps required.`,
    ).toBe(2);
    expect(perEntryKeys).toEqual(
      expect.arrayContaining([`${ADDR}.invalid.tBad1`, `${ADDR}.invalid.tBad2`]),
    );
    const scan = await db.all(`${ADDR}.invalid.`);
    expect(scan.size).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Shape 3 of 4: {addr}.audit.*  — NEW in Wave T.3 per PROFILE-ARCHITECTURE
  //   §10.10 / canonical UXF-TRANSFER-PROTOCOL §5.4. Required for the
  //   audit collection that holds structurally-valid-but-unspendable
  //   tokens (NOT_OUR_CURRENT_STATE / UNSPENDABLE_BY_US dispositions).
  // -------------------------------------------------------------------------
  it('shape 3: ${addr}.audit.* — mapping + per-entry-key writer present', () => {
    // Two preconditions for T.1.E:
    //   (a) PROFILE_KEY_MAPPING declares an `audit` per-address entry, OR
    //       a synthetic mapping is acceptable as long as a writer exists.
    //   (b) The token storage provider exposes a writer that emits keys
    //       with the `${addr}.audit.` prefix.
    //
    // On `main` neither (a) nor (b) is wired. We assert clearly so
    // T.0.G7-fill-gaps is triggered.
    const hasMapping = Object.values(PROFILE_KEY_MAPPING).some(
      (m) => m.profileKey === '{addr}.audit',
    );
    expect(
      hasMapping,
      'WAVE G.7 GAP: PROFILE_KEY_MAPPING does not declare an `audit` per-address ' +
        'entry. PROFILE-ARCHITECTURE.md §10.10 mandates `${addr}.audit.<tokenId>.` ' +
        '<contentHash>` — T.0.G7-fill-gaps must add the mapping AND a per-entry-key ' +
        'writer in profile-token-storage-provider.ts.',
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Shape 4 of 4: {addr}.finalizationQueue.*  — NEW per UXF-TRANSFER-PROTOCOL
  //   §5.5. Per-address finalization queue persists one entry per pending
  //   chain-mode transaction across process restarts.
  // -------------------------------------------------------------------------
  it('shape 4: ${addr}.finalizationQueue.* — mapping + per-entry-key writer present', () => {
    const hasMapping = Object.values(PROFILE_KEY_MAPPING).some(
      (m) => m.profileKey === '{addr}.finalizationQueue',
    );
    expect(
      hasMapping,
      'WAVE G.7 GAP: PROFILE_KEY_MAPPING does not declare a `finalizationQueue` ' +
        'per-address entry. UXF-TRANSFER-PROTOCOL §5.5 mandates ' +
        '`${addr}.finalizationQueue.<requestId>` — T.0.G7-fill-gaps must add the ' +
        'mapping AND a per-entry-key writer in profile-token-storage-provider.ts.',
    ).toBe(true);
  });
});
