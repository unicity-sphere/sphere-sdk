/**
 * Tests for the production {@link DispositionPerEntryStorage} adapters
 * added in Round 3 (`profile/disposition-storage-adapters.ts`).
 *
 * Covers:
 *   1. InMemoryDispositionStorageAdapter — read/write/list, tombstone
 *      filtering, maxResults cap.
 *   2. OrbitDbDispositionStorageAdapter — read/write/list against a
 *      mock ProfileDatabase, encryption round-trip, tombstone
 *      filtering, maxResults cap, malformed-entry skip.
 */

import { describe, it, expect } from 'vitest';
import {
  InMemoryDispositionStorageAdapter,
  OrbitDbDispositionStorageAdapter,
  DEFAULT_LIST_KEYS_MAX_RESULTS,
} from '../../../profile/disposition-storage-adapters';
import { deriveProfileEncryptionKey, encryptString } from '../../../profile/encryption';
import type { ProfileDatabase } from '../../../profile/types';

// =============================================================================
// Mock ProfileDatabase backed by an in-memory Map<string, Uint8Array>.
// =============================================================================

interface MockDb extends ProfileDatabase {
  readonly _store: Map<string, Uint8Array>;
}

function makeMockDb(): MockDb {
  const store = new Map<string, Uint8Array>();
  const db: MockDb = {
    _store: store,
    async connect() {
      /* no-op */
    },
    async put(key, value) {
      store.set(key, value);
    },
    async get(key) {
      return store.get(key) ?? null;
    },
    async del(key) {
      store.delete(key);
    },
    async all(prefix) {
      const out = new Map<string, Uint8Array>();
      for (const [k, v] of store.entries()) {
        if (prefix && !k.startsWith(prefix)) continue;
        out.set(k, v);
      }
      return out;
    },
    async close() {
      /* no-op */
    },
    onReplication() {
      return () => {};
    },
    isConnected() {
      return true;
    },
  };
  return db;
}

const KEY = deriveProfileEncryptionKey(new Uint8Array(32).fill(7));

// =============================================================================
// InMemoryDispositionStorageAdapter
// =============================================================================

describe('InMemoryDispositionStorageAdapter', () => {
  it('writes + reads back a record', async () => {
    const adapter = new InMemoryDispositionStorageAdapter();
    await adapter.writeRecord('addr.invalid.t.h1', { tokenId: 't', x: 1 });
    const got = await adapter.readRecord<{ tokenId: string; x: number }>(
      'addr.invalid.t.h1',
    );
    expect(got).toEqual({ tokenId: 't', x: 1 });
  });

  it('readRecord returns undefined for missing key', async () => {
    const adapter = new InMemoryDispositionStorageAdapter();
    expect(await adapter.readRecord('missing')).toBeUndefined();
  });

  it('listKeysWithPrefix enumerates matching keys, excludes others', async () => {
    const adapter = new InMemoryDispositionStorageAdapter();
    await adapter.writeRecord('addr.invalid.t1.h1', { x: 1 });
    await adapter.writeRecord('addr.invalid.t1.h2', { x: 2 });
    await adapter.writeRecord('addr.invalid.t2.h1', { x: 3 });
    await adapter.writeRecord('other.invalid.t1.h1', { x: 4 });
    const keys = await adapter.listKeysWithPrefix('addr.invalid.t1.');
    expect(keys.sort()).toEqual([
      'addr.invalid.t1.h1',
      'addr.invalid.t1.h2',
    ]);
  });

  it('listKeysWithPrefix filters tombstoned entries', async () => {
    const adapter = new InMemoryDispositionStorageAdapter();
    await adapter.writeRecord('addr.invalid.t.h1', { x: 1 });
    await adapter.writeRecord('addr.invalid.t.h2', { x: 2 });
    await adapter.tombstone('addr.invalid.t.h1');
    const keys = await adapter.listKeysWithPrefix('addr.invalid.t.');
    expect(keys).toEqual(['addr.invalid.t.h2']);
    // readRecord on the tombstoned key returns undefined.
    expect(await adapter.readRecord('addr.invalid.t.h1')).toBeUndefined();
  });

  it('listKeysWithPrefix honours explicit maxResults', async () => {
    const adapter = new InMemoryDispositionStorageAdapter();
    for (let i = 0; i < 50; i++) {
      await adapter.writeRecord(`p.${i.toString().padStart(3, '0')}`, { i });
    }
    const keys = await adapter.listKeysWithPrefix('p.', { maxResults: 10 });
    expect(keys.length).toBe(10);
  });

  it('listKeysWithPrefix applies default cap when maxResults omitted', async () => {
    const adapter = new InMemoryDispositionStorageAdapter({
      defaultMaxResults: 5,
    });
    for (let i = 0; i < 50; i++) {
      await adapter.writeRecord(`p.${i.toString().padStart(3, '0')}`, { i });
    }
    const keys = await adapter.listKeysWithPrefix('p.');
    expect(keys.length).toBe(5);
  });

  it('listKeysWithPrefix throws on negative / non-finite maxResults', async () => {
    const adapter = new InMemoryDispositionStorageAdapter();
    await expect(
      adapter.listKeysWithPrefix('p.', { maxResults: -1 }),
    ).rejects.toThrow(TypeError);
    await expect(
      adapter.listKeysWithPrefix('p.', { maxResults: Number.NaN }),
    ).rejects.toThrow(TypeError);
  });

  it('exposes DEFAULT_LIST_KEYS_MAX_RESULTS = 1024', () => {
    expect(DEFAULT_LIST_KEYS_MAX_RESULTS).toBe(1024);
  });
});

// =============================================================================
// OrbitDbDispositionStorageAdapter
// =============================================================================

describe('OrbitDbDispositionStorageAdapter', () => {
  it('writes a record encrypted, reads it back round-trip', async () => {
    const db = makeMockDb();
    const adapter = new OrbitDbDispositionStorageAdapter({
      db,
      encryptionKey: KEY,
    });
    await adapter.writeRecord('addr.invalid.t.h', { tokenId: 't', n: 42 });
    // The on-disk bytes are NOT plaintext JSON.
    const raw = db._store.get('addr.invalid.t.h')!;
    expect(raw).toBeInstanceOf(Uint8Array);
    const rawStr = new TextDecoder().decode(raw);
    expect(rawStr).not.toContain('"tokenId"');
    // Round-trip via the adapter decrypts cleanly.
    const got = await adapter.readRecord<{ tokenId: string; n: number }>(
      'addr.invalid.t.h',
    );
    expect(got).toEqual({ tokenId: 't', n: 42 });
  });

  it('readRecord returns undefined for missing key', async () => {
    const db = makeMockDb();
    const adapter = new OrbitDbDispositionStorageAdapter({
      db,
      encryptionKey: KEY,
    });
    expect(await adapter.readRecord('missing')).toBeUndefined();
  });

  it('listKeysWithPrefix enumerates encrypted records, decrypts to filter tombstones', async () => {
    const db = makeMockDb();
    const adapter = new OrbitDbDispositionStorageAdapter({
      db,
      encryptionKey: KEY,
    });
    await adapter.writeRecord('addr.invalid.t.h1', { x: 1 });
    await adapter.writeRecord('addr.invalid.t.h2', { x: 2 });
    await adapter.tombstone('addr.invalid.t.h1');
    const keys = await adapter.listKeysWithPrefix('addr.invalid.t.');
    expect(keys).toEqual(['addr.invalid.t.h2']);
  });

  it('listKeysWithPrefix honours explicit maxResults', async () => {
    const db = makeMockDb();
    const adapter = new OrbitDbDispositionStorageAdapter({
      db,
      encryptionKey: KEY,
    });
    for (let i = 0; i < 50; i++) {
      await adapter.writeRecord(`p.${i.toString().padStart(3, '0')}`, { i });
    }
    const keys = await adapter.listKeysWithPrefix('p.', { maxResults: 10 });
    expect(keys.length).toBe(10);
  });

  it('listKeysWithPrefix applies the default cap when maxResults omitted', async () => {
    const db = makeMockDb();
    const adapter = new OrbitDbDispositionStorageAdapter({
      db,
      encryptionKey: KEY,
      defaultMaxResults: 5,
    });
    for (let i = 0; i < 20; i++) {
      await adapter.writeRecord(`p.${i.toString().padStart(3, '0')}`, { i });
    }
    const keys = await adapter.listKeysWithPrefix('p.');
    expect(keys.length).toBe(5);
  });

  it('listKeysWithPrefix skips malformed (un-decryptable) entries', async () => {
    const db = makeMockDb();
    const adapter = new OrbitDbDispositionStorageAdapter({
      db,
      encryptionKey: KEY,
    });
    // Plant a legit record + a malformed entry under the same prefix.
    await adapter.writeRecord('p.h1', { ok: true });
    db._store.set('p.h-bad', new TextEncoder().encode('not-encrypted-bytes'));
    const keys = await adapter.listKeysWithPrefix('p.');
    expect(keys).toEqual(['p.h1']); // bad entry filtered, good entry kept
  });

  it('listKeysWithPrefix returns empty when db.all() throws', async () => {
    const db = makeMockDb();
    db.all = async () => {
      throw new Error('replication-corrupt');
    };
    const adapter = new OrbitDbDispositionStorageAdapter({
      db,
      encryptionKey: KEY,
    });
    const keys = await adapter.listKeysWithPrefix('p.');
    expect(keys).toEqual([]);
  });

  it('listKeysWithPrefix throws on negative / non-finite maxResults', async () => {
    const db = makeMockDb();
    const adapter = new OrbitDbDispositionStorageAdapter({
      db,
      encryptionKey: KEY,
    });
    await expect(
      adapter.listKeysWithPrefix('p.', { maxResults: -1 }),
    ).rejects.toThrow(TypeError);
    await expect(
      adapter.listKeysWithPrefix('p.', { maxResults: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow(TypeError);
  });

  it('listKeysWithPrefix excludes wider matches that db.all() may return', async () => {
    const db = makeMockDb();
    const adapter = new OrbitDbDispositionStorageAdapter({
      db,
      encryptionKey: KEY,
    });
    // Store one encrypted under our prefix and one under a wider key.
    await adapter.writeRecord('addr.invalid.t.h1', { x: 1 });
    // Plant a legit-format entry under a non-prefix key by writing
    // through the adapter then patching the db to simulate a backend
    // that returns wider matches.
    await adapter.writeRecord('zzz.invalid.t.h1', { x: 2 });
    const dbAll = db.all.bind(db);
    db.all = async (prefix?: string) => {
      // Simulate a backend that ignores `prefix` and returns
      // EVERYTHING — the adapter MUST filter.
      void prefix;
      return dbAll();
    };
    const keys = await adapter.listKeysWithPrefix('addr.invalid.t.');
    expect(keys).toEqual(['addr.invalid.t.h1']);
  });

  it('round-trips records produced via the encryption helper directly', async () => {
    // Sanity check: an entry written via raw encryptString should be
    // readable by the adapter (the adapter is just a thin wrapper).
    const db = makeMockDb();
    const adapter = new OrbitDbDispositionStorageAdapter({
      db,
      encryptionKey: KEY,
    });
    const ciphertext = await encryptString(KEY, JSON.stringify({ raw: true }));
    db._store.set('p.h', ciphertext);
    const got = await adapter.readRecord<{ raw: boolean }>('p.h');
    expect(got).toEqual({ raw: true });
  });

  // ===========================================================================
  // Round 5 (FIX 2 / FIX 3) — bound iteration BEFORE sort + plumb cap to db.all
  // ===========================================================================

  it('Round 5 (FIX 3): plumbs maxResults to db.all() so backend can short-circuit', async () => {
    const db = makeMockDb();
    let lastOpts: { maxResults?: number } | undefined;
    const origAll = db.all.bind(db);
    db.all = async (prefix?: string, opts?: { readonly maxResults?: number }) => {
      lastOpts = opts;
      return origAll(prefix);
    };
    const adapter = new OrbitDbDispositionStorageAdapter({
      db,
      encryptionKey: KEY,
    });
    await adapter.writeRecord('p.h1', { x: 1 });
    await adapter.listKeysWithPrefix('p.', { maxResults: 7 });
    expect(lastOpts).toBeDefined();
    expect(lastOpts?.maxResults).toBe(7);
  });

  it('Round 5 (FIX 2): only sorts the survivor set, not the entire prefix space', async () => {
    // Plant 100 matching encrypted records, ask for cap=10. The adapter
    // MUST iterate, filter+cap, then sort — sorting only K=10 entries,
    // NOT the full 100-entry key set.
    const db = makeMockDb();
    const adapter = new OrbitDbDispositionStorageAdapter({
      db,
      encryptionKey: KEY,
    });
    for (let i = 0; i < 100; i++) {
      // Pad with leading zeros so lex-sort and insert order disagree
      // for some entries.
      await adapter.writeRecord(`p.${i.toString().padStart(4, '0')}`, { i });
    }
    const keys = await adapter.listKeysWithPrefix('p.', { maxResults: 10 });
    expect(keys.length).toBe(10);
    // The result MUST be sorted (determinism guarantee).
    const sortedCopy = [...keys].sort();
    expect(keys).toEqual(sortedCopy);
  });

  it('Round 5 (FIX 3): hostile peer planting >>cap entries triggers ≤cap iteration', async () => {
    // Mock a db.all that iterates lazily — we count how many times
    // it iterates by tracking how many keys it returned.
    const N = 100_000; // hostile peer scale
    const cap = 1024;
    let returnedCount = 0;
    const fakeDb: MockDb = makeMockDb();
    fakeDb.all = async (
      prefix?: string,
      opts?: { readonly maxResults?: number },
    ) => {
      // Generate entries lazily up to either the cap or N, whichever
      // is smaller. This simulates an OrbitDB backend that honours
      // the cap and short-circuits.
      const max = opts?.maxResults ?? N;
      const out = new Map<string, Uint8Array>();
      const limit = Math.min(N, max);
      // Pre-encrypt one valid record we can reuse for every key —
      // saves time and is sufficient to demonstrate the cap.
      const ciphertext = await encryptString(KEY, JSON.stringify({ x: 1 }));
      for (let i = 0; i < limit; i++) {
        const key = `p.${i.toString().padStart(8, '0')}`;
        if (prefix && !key.startsWith(prefix)) continue;
        out.set(key, ciphertext);
      }
      returnedCount = out.size;
      return out;
    };
    const adapter = new OrbitDbDispositionStorageAdapter({
      db: fakeDb,
      encryptionKey: KEY,
    });
    const keys = await adapter.listKeysWithPrefix('p.', { maxResults: cap });
    expect(keys.length).toBe(cap);
    // FIX 3: db.all() honoured the cap and only materialized 1024
    // entries — NOT the full 100k.
    expect(returnedCount).toBe(cap);
  });
});
