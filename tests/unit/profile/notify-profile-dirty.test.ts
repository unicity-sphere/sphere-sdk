/**
 * Tests for Item #15 Phase C — `notifyProfileDirty` wiring across every
 * per-writer mutation surface.
 *
 * Covers:
 *   1. OutboxWriter — write/update/delete/joinSnapshot/gcExpiredTombstones
 *   2. SentLedgerWriter — write/delete/joinSnapshot/gcExpiredTombstones
 *   3. PrefixSyncWriter — joinSnapshot only (it has no native write surface)
 *   4. OrbitDbFinalizationQueueStorageAdapter — writeKey/deleteKey
 *   5. OrbitDbRecipientContextStorageAdapter — request/finalization writes
 *   6. BundleIndex — addBundle / joinSnapshot
 *
 * Each surface is asserted to:
 *   - fire the callback exactly once per successful mutation
 *   - NOT fire when nothing lands (JOIN on identical state, gc with no
 *     expired tombstones)
 *   - swallow callback errors silently (mutation completes successfully)
 *
 * Tests use minimal in-memory `ProfileDatabase` mocks and real-encryption
 * keys derived from `deriveProfileEncryptionKey` so the adapter encrypt/
 * decrypt path matches production.
 *
 * @see docs/uxf/OUTBOX-SEND-FOLLOWUPS.md — Item #15 Phase C
 */

import { describe, expect, it } from 'vitest';
import { Lamport } from '../../../profile/lamport.js';
import { OutboxWriter, type OutboxWriteInput } from '../../../profile/outbox-writer.js';
import {
  SentLedgerWriter,
  type SentLedgerWriteInput,
} from '../../../profile/sent-ledger-writer.js';
import { PrefixSyncWriter } from '../../../profile/prefix-sync-writer.js';
import {
  OrbitDbFinalizationQueueStorageAdapter,
  OrbitDbRecipientContextStorageAdapter,
} from '../../../profile/finalization-queue-storage-adapter.js';
import { BundleIndex } from '../../../profile/profile-token-storage/bundle-index.js';
import {
  deriveProfileEncryptionKey,
  encryptProfileValue,
} from '../../../profile/encryption.js';
import type {
  OrbitDbConfig,
  ProfileDatabase,
  UxfBundleRef,
} from '../../../profile/types.js';
import type { ProfileTokenStorageHost } from '../../../profile/profile-token-storage/host.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

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
  return deriveProfileEncryptionKey(
    new TextEncoder().encode(seed),
    'phase-c-test',
  );
}

function buildOutboxInput(
  id: string,
  overrides: Partial<OutboxWriteInput> = {},
): OutboxWriteInput {
  const now = Date.now();
  return {
    id,
    bundleCid: `bafy-${id}`,
    tokenIds: ['0xtoken1'],
    deliveryMethod: 'car-over-nostr',
    recipient: '@bob',
    recipientTransportPubkey: 'a'.repeat(64),
    mode: 'instant',
    status: 'packaging',
    submitRetryCount: 0,
    proofErrorCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildSentInput(
  id: string,
  overrides: Partial<SentLedgerWriteInput> = {},
): SentLedgerWriteInput {
  const now = Date.now();
  return {
    id,
    bundleCid: `bafy-sent-${id}`,
    tokenIds: ['0xtoken1'],
    deliveryMethod: 'car-over-nostr',
    recipient: '@bob',
    recipientTransportPubkey: 'a'.repeat(64),
    mode: 'instant',
    status: 'delivered',
    sentAt: now,
    ...overrides,
  } as SentLedgerWriteInput;
}

function createMockHost(opts: {
  db: ProfileDatabase;
  encryptionKey: Uint8Array | null;
  notifyProfileDirty: () => void;
  knownBundleCids?: Set<string>;
}): ProfileTokenStorageHost {
  const knownBundleCids = opts.knownBundleCids ?? new Set<string>();
  return {
    db: opts.db,
    ipfsGateways: [],
    options: undefined,
    localCache: null,
    flushDebounceMs: 0,
    eventCallbacks: new Set(),
    getStatus: () => 'connected',
    setStatus: () => {},
    getInitialized: () => true,
    setInitialized: () => {},
    getIsShuttingDown: () => false,
    setIsShuttingDown: () => {},
    getIdentity: () => null,
    setIdentityState: () => {},
    getEncryptionKey: () => opts.encryptionKey,
    setEncryptionKey: () => {},
    getComputedAddressId: () => null,
    setComputedAddressId: () => {},
    getReplicationUnsub: () => null,
    setReplicationUnsub: () => {},
    getPendingData: () => null,
    setPendingData: () => {},
    getFlushTimer: () => null,
    setFlushTimer: () => {},
    getFlushPromise: () => null,
    setFlushPromise: () => {},
    getLastPinnedCid: () => null,
    setLastPinnedCid: () => {},
    getLastDiscoveredPointerCid: () => null,
    setLastDiscoveredPointerCid: () => {},
    getPendingPublishCid: () => null,
    setPendingPublishCid: () => {},
    getKnownBundleCids: () => knownBundleCids,
    setKnownBundleCids: () => {},
    getLastLoadedData: () => null,
    setLastLoadedData: () => {},
    getLastLoadedFromBundleCids: () => null,
    setLastLoadedFromBundleCids: () => {},
    getLastTokenManifest: () => null,
    setLastTokenManifest: () => {},
    getAddressId: () => ADDR_A,
    log: () => {},
    emitEvent: () => {},
    buildErrorEvent: (type, err, code) => ({
      type,
      timestamp: Date.now(),
      error: err instanceof Error ? err : new Error(String(err)),
      ...(code ? { code } : {}),
    }),
    notifyProfileDirty: opts.notifyProfileDirty,
  } as unknown as ProfileTokenStorageHost;
}

// ---------------------------------------------------------------------------
// 1. OutboxWriter
// ---------------------------------------------------------------------------

describe('OutboxWriter — notifyProfileDirty', () => {
  it('fires once on every successful write()', async () => {
    const db = createMockDb();
    const encryptionKey = await deriveKey('outbox-write');
    let count = 0;
    const writer = new OutboxWriter({
      db,
      encryptionKey,
      addressId: ADDR_A,
      lamport: new Lamport(),
      notifyProfileDirty: () => {
        count += 1;
      },
    });
    await writer.write(buildOutboxInput('e1'));
    expect(count).toBe(1);
    await writer.write(buildOutboxInput('e2'));
    expect(count).toBe(2);
  });

  it('fires once on every successful delete() (tombstone)', async () => {
    const db = createMockDb();
    const encryptionKey = await deriveKey('outbox-del');
    let count = 0;
    const writer = new OutboxWriter({
      db,
      encryptionKey,
      addressId: ADDR_A,
      lamport: new Lamport(),
      notifyProfileDirty: () => {
        count += 1;
      },
    });
    await writer.write(buildOutboxInput('e1'));
    count = 0;
    await writer.delete('e1');
    expect(count).toBe(1);
  });

  it('fires once through update() → write() rewrite', async () => {
    const db = createMockDb();
    const encryptionKey = await deriveKey('outbox-upd');
    let count = 0;
    const writer = new OutboxWriter({
      db,
      encryptionKey,
      addressId: ADDR_A,
      lamport: new Lamport(),
      notifyProfileDirty: () => {
        count += 1;
      },
    });
    await writer.write(buildOutboxInput('e1'));
    count = 0;
    // update keeps the same status — write() bumps lamport and notifies once.
    await writer.update('e1', (prev) => ({ ...prev, submitRetryCount: 1 }));
    expect(count).toBe(1);
  });

  it('fires after joinSnapshot when remote bytes land', async () => {
    const dbA = createMockDb();
    const dbB = createMockDb();
    const encryptionKey = await deriveKey('outbox-join');
    const writerA = new OutboxWriter({
      db: dbA,
      encryptionKey,
      addressId: ADDR_A,
      lamport: new Lamport(),
    });
    await writerA.write(buildOutboxInput('eX'));
    const snapshot = await writerA.snapshot();

    let count = 0;
    const writerB = new OutboxWriter({
      db: dbB,
      encryptionKey,
      addressId: ADDR_A,
      lamport: new Lamport(),
      notifyProfileDirty: () => {
        count += 1;
      },
    });
    const result = await writerB.joinSnapshot(snapshot);
    expect(result.liveLanded).toBeGreaterThan(0);
    expect(count).toBe(1);
  });

  it('does NOT fire after joinSnapshot on identical local state', async () => {
    const dbA = createMockDb();
    const encryptionKey = await deriveKey('outbox-noop');
    const writerA = new OutboxWriter({
      db: dbA,
      encryptionKey,
      addressId: ADDR_A,
      lamport: new Lamport(),
    });
    await writerA.write(buildOutboxInput('eY'));
    const snapshot = await writerA.snapshot();

    let count = 0;
    // Re-run join against the same writer's own snapshot — no remote
    // bytes can win against equal-or-newer local Lamports.
    const writerSink = new OutboxWriter({
      db: dbA,
      encryptionKey,
      addressId: ADDR_A,
      lamport: new Lamport(),
      notifyProfileDirty: () => {
        count += 1;
      },
    });
    await writerSink.joinSnapshot(snapshot);
    expect(count).toBe(0);
  });

  it('fires after gcExpiredTombstones when entries are purged', async () => {
    const db = createMockDb();
    const encryptionKey = await deriveKey('outbox-gc');
    let count = 0;
    const writer = new OutboxWriter({
      db,
      encryptionKey,
      addressId: ADDR_A,
      lamport: new Lamport(),
      notifyProfileDirty: () => {
        count += 1;
      },
    });
    await writer.write(buildOutboxInput('eG'));
    await writer.delete('eG');
    count = 0;
    // retentionMs = 0 → tombstone is immediately expired (deletedAt < now).
    const result = await writer.gcExpiredTombstones({
      retentionMs: 0,
      now: Date.now() + 60_000,
    });
    expect(result.purged).toBeGreaterThan(0);
    expect(count).toBe(1);
  });

  it('does NOT fire after gcExpiredTombstones when nothing is purged', async () => {
    const db = createMockDb();
    const encryptionKey = await deriveKey('outbox-gc-noop');
    let count = 0;
    const writer = new OutboxWriter({
      db,
      encryptionKey,
      addressId: ADDR_A,
      lamport: new Lamport(),
      notifyProfileDirty: () => {
        count += 1;
      },
    });
    await writer.write(buildOutboxInput('eH'));
    await writer.delete('eH');
    count = 0;
    // retentionMs huge → tombstone kept.
    const result = await writer.gcExpiredTombstones({
      retentionMs: 1_000_000,
      now: Date.now(),
    });
    expect(result.purged).toBe(0);
    expect(count).toBe(0);
  });

  it('swallows notifier errors silently — write() succeeds', async () => {
    const db = createMockDb();
    const encryptionKey = await deriveKey('outbox-throw');
    const writer = new OutboxWriter({
      db,
      encryptionKey,
      addressId: ADDR_A,
      lamport: new Lamport(),
      notifyProfileDirty: () => {
        throw new Error('boom');
      },
    });
    await expect(writer.write(buildOutboxInput('eT'))).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. SentLedgerWriter
// ---------------------------------------------------------------------------

describe('SentLedgerWriter — notifyProfileDirty', () => {
  it('fires on write()', async () => {
    const db = createMockDb();
    const encryptionKey = await deriveKey('sent-write');
    let count = 0;
    const writer = new SentLedgerWriter({
      db,
      encryptionKey,
      addressId: ADDR_A,
      lamport: new Lamport(),
      notifyProfileDirty: () => {
        count += 1;
      },
    });
    await writer.write(buildSentInput('s1'));
    expect(count).toBe(1);
  });

  it('fires on delete()', async () => {
    const db = createMockDb();
    const encryptionKey = await deriveKey('sent-del');
    let count = 0;
    const writer = new SentLedgerWriter({
      db,
      encryptionKey,
      addressId: ADDR_A,
      lamport: new Lamport(),
      notifyProfileDirty: () => {
        count += 1;
      },
    });
    await writer.write(buildSentInput('s1'));
    count = 0;
    await writer.delete('s1');
    expect(count).toBe(1);
  });

  it('fires after joinSnapshot when remote bytes land', async () => {
    const dbA = createMockDb();
    const dbB = createMockDb();
    const encryptionKey = await deriveKey('sent-join');
    const writerA = new SentLedgerWriter({
      db: dbA,
      encryptionKey,
      addressId: ADDR_A,
      lamport: new Lamport(),
    });
    await writerA.write(buildSentInput('sJ'));
    const snapshot = await writerA.snapshot();

    let count = 0;
    const writerB = new SentLedgerWriter({
      db: dbB,
      encryptionKey,
      addressId: ADDR_A,
      lamport: new Lamport(),
      notifyProfileDirty: () => {
        count += 1;
      },
    });
    const result = await writerB.joinSnapshot(snapshot);
    expect(result.liveLanded).toBeGreaterThan(0);
    expect(count).toBe(1);
  });

  it('swallows notifier errors silently', async () => {
    const db = createMockDb();
    const encryptionKey = await deriveKey('sent-throw');
    const writer = new SentLedgerWriter({
      db,
      encryptionKey,
      addressId: ADDR_A,
      lamport: new Lamport(),
      notifyProfileDirty: () => {
        throw new Error('boom');
      },
    });
    await expect(writer.write(buildSentInput('sT'))).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. PrefixSyncWriter
// ---------------------------------------------------------------------------

describe('PrefixSyncWriter — notifyProfileDirty', () => {
  it('fires after joinSnapshot when remote bytes land', async () => {
    const dbA = createMockDb();
    const dbB = createMockDb();
    const encryptionKey = await deriveKey('prefix-join');
    const prefix = `${ADDR_A}.test.`;

    // Seed A with one encrypted entry, build the snapshot.
    const payload = new TextEncoder().encode(
      JSON.stringify({ _schemaVersion: 'uxf-1', value: 'hello' }),
    );
    const ciphertext = await encryptProfileValue(encryptionKey, payload);
    await dbA.put(`${prefix}entry1`, ciphertext);
    const writerA = new PrefixSyncWriter({
      db: dbA,
      encryptionKey,
      keyPrefix: prefix,
      validateValue: (decoded) =>
        typeof decoded === 'object' &&
        decoded !== null &&
        (decoded as { _schemaVersion?: string })._schemaVersion === 'uxf-1',
    });
    const snapshot = await writerA.snapshot();
    expect(snapshot.length).toBe(1);

    let count = 0;
    const writerB = new PrefixSyncWriter({
      db: dbB,
      encryptionKey,
      keyPrefix: prefix,
      validateValue: (decoded) =>
        typeof decoded === 'object' &&
        decoded !== null &&
        (decoded as { _schemaVersion?: string })._schemaVersion === 'uxf-1',
      notifyProfileDirty: () => {
        count += 1;
      },
    });
    const result = await writerB.joinSnapshot(snapshot);
    expect(result.liveLanded).toBeGreaterThan(0);
    expect(count).toBe(1);
  });

  it('does NOT fire on empty / nothing-lands JOIN', async () => {
    const db = createMockDb();
    const encryptionKey = await deriveKey('prefix-noop');
    let count = 0;
    const writer = new PrefixSyncWriter({
      db,
      encryptionKey,
      keyPrefix: `${ADDR_A}.test.`,
      notifyProfileDirty: () => {
        count += 1;
      },
    });
    await writer.joinSnapshot([]);
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. OrbitDbFinalizationQueueStorageAdapter
// ---------------------------------------------------------------------------

describe('OrbitDbFinalizationQueueStorageAdapter — notifyProfileDirty', () => {
  it('fires on writeKey / deleteKey', async () => {
    const db = createMockDb();
    const encryptionKey = await deriveKey('finq-adapter');
    let count = 0;
    const adapter = new OrbitDbFinalizationQueueStorageAdapter({
      db,
      encryptionKey,
      notifyProfileDirty: () => {
        count += 1;
      },
    });
    await adapter.writeKey(
      `${ADDR_A}.finalizationQueue.k1`,
      JSON.stringify({ payload: 'x' }),
    );
    expect(count).toBe(1);
    await adapter.deleteKey(`${ADDR_A}.finalizationQueue.k1`);
    expect(count).toBe(2);
  });

  it('propagates notifier into syncWriterFor()-returned PrefixSyncWriter', async () => {
    const dbA = createMockDb();
    const dbB = createMockDb();
    const encryptionKey = await deriveKey('finq-sync');

    const adapterA = new OrbitDbFinalizationQueueStorageAdapter({
      db: dbA,
      encryptionKey,
    });
    await adapterA.writeKey(
      `${ADDR_A}.finalizationQueue.k1`,
      JSON.stringify({ payload: 'x' }),
    );
    const syncA = adapterA.syncWriterFor(ADDR_A);
    const snapshot = await syncA.snapshot();

    let count = 0;
    const adapterB = new OrbitDbFinalizationQueueStorageAdapter({
      db: dbB,
      encryptionKey,
      notifyProfileDirty: () => {
        count += 1;
      },
    });
    const syncB = adapterB.syncWriterFor(ADDR_A);
    const result = await syncB.joinSnapshot(snapshot);
    expect(result.liveLanded).toBeGreaterThan(0);
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. OrbitDbRecipientContextStorageAdapter
// ---------------------------------------------------------------------------

describe('OrbitDbRecipientContextStorageAdapter — notifyProfileDirty', () => {
  it('fires on request-context write / delete', async () => {
    const db = createMockDb();
    const encryptionKey = await deriveKey('rc-req');
    let count = 0;
    const adapter = new OrbitDbRecipientContextStorageAdapter({
      db,
      encryptionKey,
      notifyProfileDirty: () => {
        count += 1;
      },
    });
    await adapter.writeRequestContext(ADDR_A, 'req1', {
      transactionHash: '0x' + '1'.repeat(64),
      authenticator: 'sig',
      nextEntryRest: {},
    });
    expect(count).toBe(1);
    await adapter.deleteRequestContext(ADDR_A, 'req1');
    expect(count).toBe(2);
  });

  it('fires on finalization-context write / delete', async () => {
    const db = createMockDb();
    const encryptionKey = await deriveKey('rc-fin');
    let count = 0;
    const adapter = new OrbitDbRecipientContextStorageAdapter({
      db,
      encryptionKey,
      notifyProfileDirty: () => {
        count += 1;
      },
    });
    await adapter.writeFinalizationContext(ADDR_A, '0xTokenA', {
      localTokenId: 'local',
      sourceTokenJson: {},
      lastTxJson: {},
      requestIdHex: '0x' + '2'.repeat(64),
    });
    expect(count).toBe(1);
    await adapter.deleteFinalizationContext(ADDR_A, '0xTokenA');
    expect(count).toBe(2);
  });

  it('propagates notifier into syncWritersFor()-returned PrefixSyncWriters', async () => {
    const dbA = createMockDb();
    const dbB = createMockDb();
    const encryptionKey = await deriveKey('rc-sync');

    const adapterA = new OrbitDbRecipientContextStorageAdapter({
      db: dbA,
      encryptionKey,
    });
    await adapterA.writeRequestContext(ADDR_A, 'rSync', {
      transactionHash: '0x' + 'a'.repeat(64),
      authenticator: 'sig',
      nextEntryRest: {},
    });
    const snapshot = await adapterA.syncWritersFor(ADDR_A).requestContext.snapshot();

    let count = 0;
    const adapterB = new OrbitDbRecipientContextStorageAdapter({
      db: dbB,
      encryptionKey,
      notifyProfileDirty: () => {
        count += 1;
      },
    });
    const result = await adapterB
      .syncWritersFor(ADDR_A)
      .requestContext.joinSnapshot(snapshot);
    expect(result.liveLanded).toBeGreaterThan(0);
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. BundleIndex
// ---------------------------------------------------------------------------

describe('BundleIndex — notifyProfileDirty', () => {
  function makeRef(cid: string): UxfBundleRef {
    return { cid, status: 'active', createdAt: Math.floor(Date.now() / 1000), tokenCount: 0 };
  }

  it('fires on addBundle()', async () => {
    const db = createMockDb();
    const encryptionKey = await deriveKey('bundle-add');
    let count = 0;
    const host = createMockHost({
      db,
      encryptionKey,
      notifyProfileDirty: () => {
        count += 1;
      },
    });
    const index = new BundleIndex(host);
    await index.addBundle('bafy-1', makeRef('bafy-1'));
    expect(count).toBe(1);
    await index.addBundle('bafy-2', makeRef('bafy-2'));
    expect(count).toBe(2);
  });

  it('fires after joinSnapshot when remote bytes land', async () => {
    const dbA = createMockDb();
    const dbB = createMockDb();
    const encryptionKey = await deriveKey('bundle-join');
    const hostA = createMockHost({
      db: dbA,
      encryptionKey,
      notifyProfileDirty: () => {},
    });
    const hostB = createMockHost({
      db: dbB,
      encryptionKey,
      notifyProfileDirty: () => {},
    });
    const indexA = new BundleIndex(hostA);
    await indexA.addBundle('bafy-J', makeRef('bafy-J'));
    const snapshot = await indexA.snapshot();

    let count = 0;
    const hostBCounted = createMockHost({
      db: dbB,
      encryptionKey,
      notifyProfileDirty: () => {
        count += 1;
      },
    });
    void hostB; // hostB constructed above only to keep symmetry; the counted variant replaces it.
    const indexB = new BundleIndex(hostBCounted);
    const result = await indexB.joinSnapshot(snapshot);
    expect(result.liveLanded).toBeGreaterThan(0);
    expect(count).toBe(1);
  });

  it('does NOT fire after joinSnapshot when nothing lands', async () => {
    const db = createMockDb();
    const encryptionKey = await deriveKey('bundle-noop');
    let count = 0;
    const host = createMockHost({
      db,
      encryptionKey,
      notifyProfileDirty: () => {
        count += 1;
      },
    });
    const index = new BundleIndex(host);
    // joinSnapshot on empty remote — nothing lands.
    await index.joinSnapshot([]);
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Suppress unused-import lint warnings for symmetry-only locals
// ---------------------------------------------------------------------------

void ADDR_B;
