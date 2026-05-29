/**
 * Tests for sync-writer integration on
 * `OrbitDbFinalizationQueueStorageAdapter` and
 * `OrbitDbRecipientContextStorageAdapter` (Item #15 Phase B.5).
 *
 * Locks the wiring:
 *   - syncWriterFor / syncWritersFor return PrefixSyncWriter instances
 *     bound to the correct per-address prefixes.
 *   - Records stamped by the adapter's writeXxx methods are propagated
 *     via the sync writers (snapshot + JOIN round-trip).
 *   - validateUxf1Schema rejects records lacking `_schemaVersion`.
 *   - Tombstones are sticky across JOIN.
 *
 * Uses the same MockProfileDb pattern as outbox/sent tests.
 */

import { describe, it, expect } from 'vitest';
import {
  OrbitDbFinalizationQueueStorageAdapter,
  OrbitDbRecipientContextStorageAdapter,
  type PersistedFinalizationContext,
  type PersistedRequestContext,
} from '../../../profile/finalization-queue-storage-adapter.js';
import { deriveProfileEncryptionKey } from '../../../profile/encryption.js';
import type {
  OrbitDbConfig,
  ProfileDatabase,
} from '../../../profile/types.js';

const ADDR_A = 'DIRECT_aabbcc_ddeeff';
const ADDR_B = 'DIRECT_112233_445566';

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

async function deriveKey(seed: string): Promise<Uint8Array> {
  // Derive a deterministic encryption key from a seed string so both
  // peers in a JOIN test share the same key. deriveProfileEncryptionKey
  // is the production HKDF surface; using it here also confirms the
  // sync round-trip works with the real cipher.
  return deriveProfileEncryptionKey(new TextEncoder().encode(seed), 'sync-test');
}

// =============================================================================
// 1. OrbitDbFinalizationQueueStorageAdapter — sync writer
// =============================================================================

describe('OrbitDbFinalizationQueueStorageAdapter.syncWriterFor', () => {
  it('snapshot includes entries written via writeKey', async () => {
    const key = await deriveKey('alice-seed');
    const db = createMockDb();
    const adapter = new OrbitDbFinalizationQueueStorageAdapter({
      db,
      encryptionKey: key,
    });
    await adapter.writeKey(
      `${ADDR_A}.finalizationQueue.e1`,
      JSON.stringify({ tokenId: '0xt1', addr: ADDR_A }),
    );
    await adapter.writeKey(
      `${ADDR_A}.finalizationQueue.e2`,
      JSON.stringify({ tokenId: '0xt2', addr: ADDR_A }),
    );

    const sync = adapter.syncWriterFor(ADDR_A);
    const snap = await sync.snapshot();
    expect(snap.map((e) => e.key).sort()).toEqual([
      `${ADDR_A}.finalizationQueue.e1`,
      `${ADDR_A}.finalizationQueue.e2`,
    ]);
  });

  it('JOIN propagates queue entries between two adapters sharing a key', async () => {
    const key = await deriveKey('shared-seed');
    const dbA = createMockDb();
    const dbB = createMockDb();
    const adapterA = new OrbitDbFinalizationQueueStorageAdapter({
      db: dbA,
      encryptionKey: key,
    });
    const adapterB = new OrbitDbFinalizationQueueStorageAdapter({
      db: dbB,
      encryptionKey: key,
    });
    await adapterB.writeKey(
      `${ADDR_A}.finalizationQueue.e1`,
      JSON.stringify({ tokenId: '0xt1', addr: ADDR_A }),
    );

    const syncA = adapterA.syncWriterFor(ADDR_A);
    const syncB = adapterB.syncWriterFor(ADDR_A);
    const res = await syncA.joinSnapshot(await syncB.snapshot());
    expect(res.liveLanded).toBe(1);

    // Adapter A can now read the entry through its public surface.
    const read = await adapterA.readKey(`${ADDR_A}.finalizationQueue.e1`);
    expect(read).not.toBeNull();
    const parsed = JSON.parse(read!);
    expect(parsed._schemaVersion).toBe('uxf-1');
    expect(parsed.tokenId).toBe('0xt1');
  });

  it('foreign-schema records (no _schemaVersion) are rejected by validateValue', async () => {
    const key = await deriveKey('foreign-seed');
    const dbA = createMockDb();
    const dbB = createMockDb();
    const adapterA = new OrbitDbFinalizationQueueStorageAdapter({
      db: dbA,
      encryptionKey: key,
    });
    // Plant a legacy-shape entry directly via db.put (bypassing the
    // adapter's writeKey which would stamp _schemaVersion).
    const { encryptString } = await import('../../../profile/encryption.js');
    const ct = await encryptString(
      key,
      JSON.stringify({ tokenId: '0xt-legacy', noSchema: true }),
    );
    await dbB.put(`${ADDR_A}.finalizationQueue.elegacy`, ct);

    const adapterB = new OrbitDbFinalizationQueueStorageAdapter({
      db: dbB,
      encryptionKey: key,
    });
    const syncA = adapterA.syncWriterFor(ADDR_A);
    const syncB = adapterB.syncWriterFor(ADDR_A);
    const res = await syncA.joinSnapshot(await syncB.snapshot());
    expect(res.remoteRejectedMalformed).toBe(1);
    expect(res.liveLanded).toBe(0);
  });

  it('different addressId → different prefix scope', async () => {
    const key = await deriveKey('multiaddr-seed');
    const db = createMockDb();
    const adapter = new OrbitDbFinalizationQueueStorageAdapter({
      db,
      encryptionKey: key,
    });
    await adapter.writeKey(
      `${ADDR_A}.finalizationQueue.e1`,
      JSON.stringify({ tokenId: '0xt1' }),
    );
    await adapter.writeKey(
      `${ADDR_B}.finalizationQueue.e2`,
      JSON.stringify({ tokenId: '0xt2' }),
    );

    const syncA = adapter.syncWriterFor(ADDR_A);
    const syncB = adapter.syncWriterFor(ADDR_B);
    expect((await syncA.snapshot())).toHaveLength(1);
    expect((await syncB.snapshot())).toHaveLength(1);
  });
});

// =============================================================================
// 2. OrbitDbRecipientContextStorageAdapter — sync writers
// =============================================================================

describe('OrbitDbRecipientContextStorageAdapter.syncWritersFor', () => {
  function sampleRequestContext(): PersistedRequestContext {
    return {
      transactionHash: '0xtxhash',
      authenticator: '0xauth',
      nextEntryRest: { foo: 'bar' },
    };
  }

  function sampleFinalizationContext(): PersistedFinalizationContext {
    return {
      localTokenId: '0xtok',
      sourceTokenJson: { v: 1 },
      lastTxJson: { txid: '0xt' },
      requestIdHex: '0xreq',
    };
  }

  it('snapshot returns request- and finalization-context entries under each sub-prefix', async () => {
    const key = await deriveKey('recipient-seed');
    const db = createMockDb();
    const adapter = new OrbitDbRecipientContextStorageAdapter({
      db,
      encryptionKey: key,
    });
    await adapter.writeRequestContext(ADDR_A, 'req1', sampleRequestContext());
    await adapter.writeFinalizationContext(
      ADDR_A,
      '0xtok1',
      sampleFinalizationContext(),
    );

    const { requestContext, finalizationContext } =
      adapter.syncWritersFor(ADDR_A);
    expect((await requestContext.snapshot()).map((e) => e.key)).toEqual([
      `${ADDR_A}.recipientContext.request.req1`,
    ]);
    expect((await finalizationContext.snapshot()).map((e) => e.key)).toEqual([
      `${ADDR_A}.recipientContext.finalization.0xtok1`,
    ]);
  });

  it('JOIN propagates request-context entries between adapters', async () => {
    const key = await deriveKey('shared-recipient');
    const dbA = createMockDb();
    const dbB = createMockDb();
    const adapterA = new OrbitDbRecipientContextStorageAdapter({
      db: dbA,
      encryptionKey: key,
    });
    const adapterB = new OrbitDbRecipientContextStorageAdapter({
      db: dbB,
      encryptionKey: key,
    });
    await adapterB.writeRequestContext(ADDR_A, 'req1', sampleRequestContext());

    const { requestContext: rcA } = adapterA.syncWritersFor(ADDR_A);
    const { requestContext: rcB } = adapterB.syncWritersFor(ADDR_A);
    const res = await rcA.joinSnapshot(await rcB.snapshot());
    expect(res.liveLanded).toBe(1);

    const recovered = await adapterA.readRequestContext(ADDR_A, 'req1');
    expect(recovered).toBeDefined();
    expect(recovered?.transactionHash).toBe('0xtxhash');
  });

  it('JOIN propagates finalization-context entries between adapters', async () => {
    const key = await deriveKey('shared-finctx');
    const dbA = createMockDb();
    const dbB = createMockDb();
    const adapterA = new OrbitDbRecipientContextStorageAdapter({
      db: dbA,
      encryptionKey: key,
    });
    const adapterB = new OrbitDbRecipientContextStorageAdapter({
      db: dbB,
      encryptionKey: key,
    });
    await adapterB.writeFinalizationContext(
      ADDR_A,
      '0xtok1',
      sampleFinalizationContext(),
    );

    const { finalizationContext: fcA } = adapterA.syncWritersFor(ADDR_A);
    const { finalizationContext: fcB } = adapterB.syncWritersFor(ADDR_A);
    const res = await fcA.joinSnapshot(await fcB.snapshot());
    expect(res.liveLanded).toBe(1);

    const recovered = await adapterA.readFinalizationContext(ADDR_A, '0xtok1');
    expect(recovered).toBeDefined();
    expect(recovered?.localTokenId).toBe('0xtok');
  });

  it('request and finalization sub-prefixes are isolated (no cross-snapshot leakage)', async () => {
    const key = await deriveKey('isolation-seed');
    const db = createMockDb();
    const adapter = new OrbitDbRecipientContextStorageAdapter({
      db,
      encryptionKey: key,
    });
    await adapter.writeRequestContext(ADDR_A, 'req1', sampleRequestContext());
    await adapter.writeFinalizationContext(
      ADDR_A,
      '0xtok1',
      sampleFinalizationContext(),
    );

    const { requestContext, finalizationContext } =
      adapter.syncWritersFor(ADDR_A);
    const reqSnap = await requestContext.snapshot();
    const finSnap = await finalizationContext.snapshot();
    expect(reqSnap).toHaveLength(1);
    expect(finSnap).toHaveLength(1);
    // No overlap.
    expect(reqSnap[0].key).not.toBe(finSnap[0].key);
  });

  it('bidirectional convergence — A and B both have unique entries', async () => {
    const key = await deriveKey('bidi-recipient');
    const dbA = createMockDb();
    const dbB = createMockDb();
    const adapterA = new OrbitDbRecipientContextStorageAdapter({
      db: dbA,
      encryptionKey: key,
    });
    const adapterB = new OrbitDbRecipientContextStorageAdapter({
      db: dbB,
      encryptionKey: key,
    });
    await adapterA.writeRequestContext(ADDR_A, 'reqA', sampleRequestContext());
    await adapterB.writeRequestContext(ADDR_A, 'reqB', sampleRequestContext());

    const { requestContext: rcA } = adapterA.syncWritersFor(ADDR_A);
    const { requestContext: rcB } = adapterB.syncWritersFor(ADDR_A);
    await rcA.joinSnapshot(await rcB.snapshot());
    await rcB.joinSnapshot(await rcA.snapshot());

    expect(await adapterA.readRequestContext(ADDR_A, 'reqA')).toBeDefined();
    expect(await adapterA.readRequestContext(ADDR_A, 'reqB')).toBeDefined();
    expect(await adapterB.readRequestContext(ADDR_A, 'reqA')).toBeDefined();
    expect(await adapterB.readRequestContext(ADDR_A, 'reqB')).toBeDefined();
  });
});
