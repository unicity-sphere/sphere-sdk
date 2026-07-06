/**
 * G3 + G7 — No-token-loss regression: recipient-side finalization queue
 * AND recipient context maps MUST survive Sphere.destroy() / re-import.
 *
 * Background.
 * The default `buildDefaultFinalizationWorkerRecipient` constructs an
 * in-memory `Map<string,string>` storage for `FinalizationQueue` and
 * uses two in-memory Maps on `PaymentsModule` for the per-tokenId /
 * per-requestId recipient finalization contexts. None of these survive
 * a process restart — recipient cross-restart safety net is absent.
 *
 * Pre-fix symptom: a Sphere that crashes after enqueueing a recipient
 * finalization entry but before the aggregator confirms loses ALL the
 * state needed to re-resume. The token stays pending forever; the
 * worker has no record to drive.
 *
 * Fix:
 *  - New `FinalizationQueueStorageAdapter` (Profile/OrbitDb) so the
 *    wave G.7 `${addr}.finalizationQueue.${entryId}` slot persists.
 *    Records carry `_schemaVersion: 'uxf-1'` so they survive legacy
 *    PaymentsModule.save() flushes (G3 ↔ G2 same prefix).
 *  - Plumb the same Profile-backed storage for the two in-memory
 *    recipient context Maps (G7).
 *
 * This test exercises the loss-prevention contract directly against
 * the new storage adapter — without requiring the full Sphere boot
 * stack — and re-builds a fresh PaymentsModule against the SAME
 * underlying mock OrbitDb to assert the persisted entries hydrate.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type {
  ProfileDatabase,
  OrbitDbConfig,
} from '../../../extensions/uxf/profile/types.js';
import type { FullIdentity } from '../../../types/index.js';
import { OrbitDbFinalizationQueueStorageAdapter } from '../../../extensions/uxf/profile/finalization-queue-storage-adapter.js';
import {
  FinalizationQueue,
  type FinalizationQueueEntry,
  entryIdFor,
} from '../../../extensions/uxf/pipeline/finalization-queue.js';
import { deriveProfileEncryptionKey } from '../../../extensions/uxf/profile/encryption.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';

const _TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

const ADDR = 'DIRECT_aabbcc_ddeeff';

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

// ---------------------------------------------------------------------------
// Mock OrbitDB-shaped database (parity with no-token-loss-audit.test.ts)
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
// G3: FinalizationQueue persistence
// ---------------------------------------------------------------------------

describe('G3 — FinalizationQueue entries survive Sphere process restart', () => {
  let db: MockProfileDb;

  beforeEach(() => {
    db = createMockDb();
  });

  function makeQueueEntry(tokenId: string, txIndex: number): FinalizationQueueEntry {
    return {
      entryId: entryIdFor(tokenId, txIndex),
      tokenId,
      bundleCid: 'bafyreigh2akiscaildcafkrpl7wplncw6byxomav3hbm32rqu27qxvrmiy',
      txIndex,
      commitmentRequestId: '0001' + 'aa'.repeat(33),
      transactionHash: '00' + 'bb'.repeat(33),
      authenticator: '{"sig":"deadbeef"}',
      submittedAt: 1_700_000_000_000,
      createdAt: 1_700_000_000_000,
      submitRetryCount: 0,
      proofErrorCount: 0,
      status: 'pending',
      source: 'received',
    };
  }

  it('entry written via FinalizationQueue.add survives a fresh adapter rebuild against the same db', async () => {
    // First lifecycle: enqueue an entry.
    const adapter1 = new OrbitDbFinalizationQueueStorageAdapter({
      db,
      encryptionKey: getEncryptionKey(),
    });
    const queue1 = new FinalizationQueue({ storage: adapter1 });
    const tokenId = 'a'.repeat(64);
    const entry = makeQueueEntry(tokenId, 0);
    await queue1.add(ADDR, entry);

    // The on-disk slot exists.
    expect(
      db._store.has(`${ADDR}.finalizationQueue.${entry.entryId}`),
    ).toBe(true);

    // Second lifecycle: a fresh adapter against the SAME db (simulates
    // Sphere.destroy() + Sphere.import() with persisted profile).
    const adapter2 = new OrbitDbFinalizationQueueStorageAdapter({
      db,
      encryptionKey: getEncryptionKey(),
    });
    const queue2 = new FinalizationQueue({ storage: adapter2 });
    const recovered = await queue2.get(ADDR, entry.entryId);
    expect(recovered).toBeDefined();
    expect(recovered!.tokenId).toBe(tokenId);
    expect(recovered!.commitmentRequestId).toBe(entry.commitmentRequestId);
    expect(recovered!.transactionHash).toBe(entry.transactionHash);
    expect(recovered!.status).toBe('pending');

    // listByPrefix must also surface the entry — that's what the
    // recipient worker uses on resume.
    const all = await queue2.list(ADDR);
    expect(all.length).toBe(1);
    expect(all[0]!.entryId).toBe(entry.entryId);
  });

  it('persisted record carries `_schemaVersion: "uxf-1"` for cross-prefix coexistence with legacy save()', async () => {
    const adapter = new OrbitDbFinalizationQueueStorageAdapter({
      db,
      encryptionKey: getEncryptionKey(),
    });
    const queue = new FinalizationQueue({ storage: adapter });
    const tokenId = 'b'.repeat(64);
    const entry = makeQueueEntry(tokenId, 0);
    await queue.add(ADDR, entry);

    // Read the raw ciphertext, decrypt, and parse.
    const raw = db._store.get(`${ADDR}.finalizationQueue.${entry.entryId}`);
    expect(raw).toBeDefined();
    const { decryptString } = await import('../../../extensions/uxf/profile/encryption.js');
    const json = await decryptString(getEncryptionKey(), raw!);
    const parsed = JSON.parse(json);
    expect(parsed._schemaVersion).toBe('uxf-1');
  });

  it('queue.remove() writes a tombstone marker that is decryptable and survives a fresh adapter', async () => {
    const adapter1 = new OrbitDbFinalizationQueueStorageAdapter({
      db,
      encryptionKey: getEncryptionKey(),
    });
    const queue1 = new FinalizationQueue({ storage: adapter1 });
    const tokenId = 'c'.repeat(64);
    const entry = makeQueueEntry(tokenId, 0);
    await queue1.add(ADDR, entry);
    await queue1.remove(ADDR, entry.entryId);

    const adapter2 = new OrbitDbFinalizationQueueStorageAdapter({
      db,
      encryptionKey: getEncryptionKey(),
    });
    const queue2 = new FinalizationQueue({ storage: adapter2 });
    const recovered = await queue2.get(ADDR, entry.entryId);
    expect(recovered).toBeUndefined();
    const all = await queue2.list(ADDR);
    expect(all.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// G7: recipient context Maps persistence
// ---------------------------------------------------------------------------

describe('G7 — recipient context records survive Sphere process restart', () => {
  let db: MockProfileDb;

  beforeEach(() => {
    db = createMockDb();
  });

  it('OrbitDbRecipientContextStorageAdapter persists request-context records across rebuild', async () => {
    const { OrbitDbRecipientContextStorageAdapter } = await import(
      '../../../extensions/uxf/profile/finalization-queue-storage-adapter.js'
    );

    const adapter1 = new OrbitDbRecipientContextStorageAdapter({
      db,
      encryptionKey: getEncryptionKey(),
    });
    const reqId = '1234' + 'aa'.repeat(30);
    const recordIn = {
      transactionHash: 'cc'.repeat(34),
      authenticator: '{"sig":"feedface"}',
      nextEntryRest: { status: 'valid' as const },
    };
    await adapter1.writeRequestContext(ADDR, reqId, recordIn);

    const adapter2 = new OrbitDbRecipientContextStorageAdapter({
      db,
      encryptionKey: getEncryptionKey(),
    });
    const recovered = await adapter2.readRequestContext(ADDR, reqId);
    expect(recovered).toBeDefined();
    expect(recovered!.transactionHash).toBe(recordIn.transactionHash);
    expect(recovered!.authenticator).toBe(recordIn.authenticator);
  });

  it('OrbitDbRecipientContextStorageAdapter persists finalization-context records and lists them', async () => {
    const { OrbitDbRecipientContextStorageAdapter } = await import(
      '../../../extensions/uxf/profile/finalization-queue-storage-adapter.js'
    );

    const adapter1 = new OrbitDbRecipientContextStorageAdapter({
      db,
      encryptionKey: getEncryptionKey(),
    });
    const tokenId = 'd'.repeat(64);
    const recordIn = {
      localTokenId: tokenId,
      sourceTokenJson: { _placeholder: 'source' },
      lastTxJson: { tx: 'last' } as Record<string, unknown>,
      requestIdHex: '5678' + 'bb'.repeat(30),
    };
    await adapter1.writeFinalizationContext(ADDR, tokenId, recordIn);

    const adapter2 = new OrbitDbRecipientContextStorageAdapter({
      db,
      encryptionKey: getEncryptionKey(),
    });
    const recovered = await adapter2.readFinalizationContext(ADDR, tokenId);
    expect(recovered).toBeDefined();
    expect(recovered!.localTokenId).toBe(tokenId);
    expect(recovered!.requestIdHex).toBe(recordIn.requestIdHex);

    // listAllFinalizationContexts returns the persisted record.
    const all = await adapter2.listAllFinalizationContexts(ADDR);
    expect(all.size).toBe(1);
    expect(all.get(tokenId)!.localTokenId).toBe(tokenId);
  });

  it('persisted recipient-context records carry `_schemaVersion: "uxf-1"`', async () => {
    const { OrbitDbRecipientContextStorageAdapter } = await import(
      '../../../extensions/uxf/profile/finalization-queue-storage-adapter.js'
    );

    const adapter = new OrbitDbRecipientContextStorageAdapter({
      db,
      encryptionKey: getEncryptionKey(),
    });
    const tokenId = 'e'.repeat(64);
    await adapter.writeFinalizationContext(ADDR, tokenId, {
      localTokenId: tokenId,
      sourceTokenJson: {},
      lastTxJson: {},
      requestIdHex: 'ff'.repeat(34),
    });

    const raw = db._store.get(
      `${ADDR}.recipientContext.finalization.${tokenId}`,
    );
    expect(raw).toBeDefined();
    const { decryptString } = await import('../../../extensions/uxf/profile/encryption.js');
    const parsed = JSON.parse(await decryptString(getEncryptionKey(), raw!));
    expect(parsed._schemaVersion).toBe('uxf-1');
  });
});
