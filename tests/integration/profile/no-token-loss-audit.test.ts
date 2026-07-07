/**
 * G1 + G2 — No-token-loss regression: PaymentsModule.save() MUST NOT
 * tombstone DispositionWriter-owned `_audit` and `_invalid` records.
 *
 * Background.
 * `ProfileTokenStorageProvider.writeOrbitOperationalStatePerEntry` runs a
 * per-entry diff under each `${addr}.audit.` / `${addr}.invalid.` /
 * `${addr}.finalizationQueue.` prefix. The diff tombstones any on-disk
 * key that does not appear in the live `liveAudit` / `liveInvalid` /
 * `liveFinalization` Maps — but those Maps are populated from
 * `data._audit` / `data._invalid` / `data._finalizationQueue`, which
 * the legacy PaymentsModule never writes (records owned by the new
 * DispositionWriter live in OrbitDB at the same prefix).
 *
 * Pre-fix symptom: every PaymentsModule.save() flush tombstones every
 * DispositionWriter-resident audit/invalid record. Forensic data loss.
 *
 * Fix: discriminator field `_schemaVersion: 'uxf-1'` stamped by
 * DispositionWriter on every audit/invalid write; `applyPerEntryDiff`
 * passed `skipForeignSchema: true` for these prefixes; the diff probes
 * each candidate-for-tombstone and skips any value carrying the
 * discriminator.
 *
 * This file exercises the END-TO-END path: a real
 * `ProfileTokenStorageProvider` over the same mock OrbitDB-shaped
 * database used by `legacy-outbox-restore-roundtrip.test.ts`, with a
 * production `OrbitDbDispositionStorageAdapter` writing audit/invalid
 * records, and three repeated provider.save() cycles in between. The
 * records MUST survive every save cycle.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type {
  ProfileDatabase,
  OrbitDbConfig,
} from '../../../extensions/uxf/profile/types.js';
import type { FullIdentity } from '../../../types/index.js';
import type {
  TxfStorageDataBase,
} from '../../../storage/storage-provider.js';
import { ProfileTokenStorageProvider } from '../../../extensions/uxf/profile/profile-token-storage-provider.js';
import {
  deriveProfileEncryptionKey,
} from '../../../extensions/uxf/profile/encryption.js';
import { OrbitDbDispositionStorageAdapter } from '../../../extensions/uxf/profile/disposition-storage-adapters.js';
import { DispositionWriter } from '../../../extensions/uxf/profile/disposition-writer.js';
import { ManifestStore } from '../../../extensions/uxf/profile/manifest-store.js';
import { Lamport } from '../../../extensions/uxf/profile/lamport.js';

// ---------------------------------------------------------------------------
// Constants & helpers (mirrors patterns from
// tests/unit/profile/profile-token-storage-provider.test.ts)
// ---------------------------------------------------------------------------

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

const EXPECTED_ADDRESS_ID = 'DIRECT_aabbcc_ddeeff';

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

function buildEmptyTxfData(): TxfStorageDataBase {
  return {
    _meta: {
      version: 1,
      address: EXPECTED_ADDRESS_ID,
      formatVersion: '1.0.0',
      updatedAt: Date.now(),
    },
  };
}

// ---------------------------------------------------------------------------
// Mock OrbitDB-shaped database
// ---------------------------------------------------------------------------

interface MockProfileDb extends ProfileDatabase {
  _store: Map<string, Uint8Array>;
}

function createMockDb(): MockProfileDb {
  const store = new Map<string, Uint8Array>();
  return {
    _store: store,
    async connect(_c: OrbitDbConfig) {},
    async put(k: string, v: Uint8Array) {
      store.set(k, new Uint8Array(v));
    },
    async get(k: string) {
      const v = store.get(k);
      return v ? new Uint8Array(v) : null;
    },
    async del(k: string) {
      store.delete(k);
    },
    async all(prefix?: string) {
      const out = new Map<string, Uint8Array>();
      for (const [k, v] of store) {
        if (!prefix || k.startsWith(prefix)) out.set(k, new Uint8Array(v));
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
  } as MockProfileDb;
}

// ---------------------------------------------------------------------------
// Mock fetch for IPFS pin
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function installMockFetch(): void {
  let fakeCidCounter = 0;
  globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.toString()
        : (input as Request).url;
    if (url.includes('/api/v0/dag/put') || url.includes('/api/v0/add')) {
      // Use a CID-shaped string with incrementing suffix so each pin is unique.
      const cid = `bafyreigh2akiscaildcafkrpl7wplncw6byxomav3hbm32rqu27qxv${fakeCidCounter
        .toString(16)
        .padStart(4, '0')}`;
      fakeCidCounter++;
      return new Response(JSON.stringify({ Cid: { '/': cid } }), { status: 200 });
    }
    if (url.includes('/api/v0/pin/add')) {
      return new Response(JSON.stringify({ Pins: ['ok'] }), { status: 200 });
    }
    return new Response('', { status: 404 });
  };
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

function createProvider(db: MockProfileDb): ProfileTokenStorageProvider {
  const provider = new ProfileTokenStorageProvider(
    db,
    getEncryptionKey(),
    ['https://mock-ipfs.test'],
    {
      config: {
        orbitDb: { privateKey: TEST_PRIVATE_KEY },
      },
      addressId: EXPECTED_ADDRESS_ID,
      encrypt: true,
      flushDebounceMs: 10,
    },
  );
  provider.setIdentity(TEST_IDENTITY);
  return provider;
}

// ---------------------------------------------------------------------------
// G1: _audit records survive provider.save() cycles
// ---------------------------------------------------------------------------

describe('G1 — _audit records survive PaymentsModule.save() cycles', () => {
  let db: MockProfileDb;

  beforeEach(() => {
    db = createMockDb();
    installMockFetch();
  });

  afterEach(() => {
    restoreFetch();
  });

  it('audit record written via DispositionWriter survives 3 save() cycles', async () => {
    const provider = createProvider(db);
    await provider.initialize();

    // Wire DispositionWriter against a production
    // OrbitDbDispositionStorageAdapter bound to the SAME db.
    const adapter = new OrbitDbDispositionStorageAdapter({
      db,
      encryptionKey: getEncryptionKey(),
    });
    const lamport = new Lamport();
    const manifestStorage = {
      _kv: new Map<string, unknown>(),
      async readEntry(_addr: string, _tokenId: string): Promise<unknown> {
        return undefined;
      },
      async writeEntry(_addr: string, _tokenId: string, _entry: unknown): Promise<void> {
        // no-op; we don't exercise manifest path here
      },
    };
    const manifestStore = new ManifestStore({
      storage: manifestStorage as unknown as ConstructorParameters<typeof ManifestStore>[0]['storage'],
      lamport,
    });
    const writer = new DispositionWriter({
      manifestStore,
      storage: adapter,
      emit: () => {},
      now: () => 1_700_000_000_000,
    });

    // Write an AUDIT disposition record via the production writer.
    const tokenId = 'a'.repeat(64);
    const observedTokenContentHash = 'b'.repeat(64);
    await writer.write(EXPECTED_ADDRESS_ID, {
      disposition: 'AUDIT',
      tokenId,
      observedTokenContentHash,
      bundleCid: 'bafyreigh2akiscaildcafkrpl7wplncw6byxomav3hbm32rqu27qxvrmiy',
      senderTransportPubkey: 'cd'.repeat(32),
      auditStatus: 'audit-not-our-state',
      reason: 'not-our-state',
    });

    const auditKey = `${EXPECTED_ADDRESS_ID}.audit.${tokenId}.${observedTokenContentHash}`;
    expect(db._store.has(auditKey)).toBe(true);

    // Run THREE provider.save() cycles with empty operational state —
    // simulates the legacy PaymentsModule.save() that does not surface
    // these new-shape records via `data._audit`.
    for (let i = 0; i < 3; i++) {
      const data = buildEmptyTxfData();
      await provider.save(data);
      // Wait for debounce.
      await new Promise((r) => setTimeout(r, 50));
    }

    // The audit record MUST still be readable via the adapter.
    const recovered = await adapter.readRecord(auditKey);
    expect(recovered).toBeDefined();
    expect((recovered as { tokenId: string }).tokenId).toBe(tokenId);
    expect((recovered as { auditStatus: string }).auditStatus).toBe(
      'audit-not-our-state',
    );

    // The on-disk value must NOT be a tombstone marker.
    expect(db._store.has(auditKey)).toBe(true);
    const liveCount = (await adapter.listKeysWithPrefix(
      `${EXPECTED_ADDRESS_ID}.audit.`,
    )).length;
    expect(liveCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// G2: _invalid records survive provider.save() cycles
// ---------------------------------------------------------------------------

describe('G2 — _invalid records survive PaymentsModule.save() cycles', () => {
  let db: MockProfileDb;

  beforeEach(() => {
    db = createMockDb();
    installMockFetch();
  });

  afterEach(() => {
    restoreFetch();
  });

  it('invalid record written via DispositionWriter survives 3 save() cycles', async () => {
    const provider = createProvider(db);
    await provider.initialize();

    const adapter = new OrbitDbDispositionStorageAdapter({
      db,
      encryptionKey: getEncryptionKey(),
    });
    const lamport = new Lamport();
    const manifestStorage = {
      async readEntry(_addr: string, _tokenId: string): Promise<unknown> {
        return undefined;
      },
      async writeEntry(): Promise<void> {},
    };
    const manifestStore = new ManifestStore({
      storage: manifestStorage as unknown as ConstructorParameters<typeof ManifestStore>[0]['storage'],
      lamport,
    });
    const writer = new DispositionWriter({
      manifestStore,
      storage: adapter,
      emit: () => {},
      now: () => 1_700_000_000_000,
    });

    const tokenId = 'c'.repeat(64);
    const observedTokenContentHash = 'd'.repeat(64);
    await writer.write(EXPECTED_ADDRESS_ID, {
      disposition: 'INVALID',
      tokenId,
      observedTokenContentHash,
      bundleCid: 'bafyreigh2akiscaildcafkrpl7wplncw6byxomav3hbm32rqu27qxvrmiy',
      senderTransportPubkey: 'ef'.repeat(32),
      reason: 'auth-invalid',
    });

    const invalidKey = `${EXPECTED_ADDRESS_ID}.invalid.${tokenId}.${observedTokenContentHash}`;
    expect(db._store.has(invalidKey)).toBe(true);

    for (let i = 0; i < 3; i++) {
      const data = buildEmptyTxfData();
      await provider.save(data);
      await new Promise((r) => setTimeout(r, 50));
    }

    const recovered = await adapter.readRecord(invalidKey);
    expect(recovered).toBeDefined();
    expect((recovered as { tokenId: string }).tokenId).toBe(tokenId);
    expect((recovered as { reason: string }).reason).toBe('auth-invalid');

    expect(db._store.has(invalidKey)).toBe(true);
    const liveCount = (await adapter.listKeysWithPrefix(
      `${EXPECTED_ADDRESS_ID}.invalid.`,
    )).length;
    expect(liveCount).toBe(1);
  });
});
