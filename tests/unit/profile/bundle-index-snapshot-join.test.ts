/**
 * Tests for `BundleIndex.snapshot()` + `BundleIndex.joinSnapshot()` —
 * Item #15 Phase B.6.
 *
 * Locks the contract:
 *   - snapshot() returns every `tokens.bundle.*` entry as raw on-disk
 *     bytes (envelope-wrapped, encrypted UxfBundleRef payload).
 *   - joinSnapshot() decodes envelope + decrypts + parses + validates
 *     UxfBundleRef shape before applying the merge.
 *   - Constant-Lamport semantics: absent + live → write; live + live →
 *     no-op (first wins).
 *   - Known-CID set updates after a successful JOIN.
 *   - Malformed remote (corrupt bytes, wrong key, invalid shape) is
 *     rejected as remoteRejectedMalformed.
 *   - Encryption end-to-end (shared key passes, wrong key rejects).
 */

import { describe, it, expect } from 'vitest';
import {
  BundleIndex,
  BUNDLE_KEY_PREFIX,
} from '../../../profile/profile-token-storage/bundle-index.js';
import {
  encryptProfileValue,
  deriveProfileEncryptionKey,
} from '../../../profile/encryption.js';
import { buildLocalEntry } from '../../../profile/oplog-entry.js';
import type {
  OrbitDbConfig,
  ProfileDatabase,
} from '../../../profile/types.js';
import type { ProfileTokenStorageHost } from '../../../profile/profile-token-storage/host.js';
import type { UxfBundleRef } from '../../../profile/types.js';

// ---------------------------------------------------------------------------
// Test doubles
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

/**
 * Minimal {@link ProfileTokenStorageHost} stub — only the fields
 * BundleIndex.snapshot/joinSnapshot actually consume.
 */
function createMockHost(opts: {
  db: ProfileDatabase;
  encryptionKey: Uint8Array | null;
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
    getAddressId: () => 'DIRECT_aabbcc_ddeeff',
    log: () => {},
    emitEvent: () => {},
    buildErrorEvent: (type, err, code) => ({
      type,
      timestamp: Date.now(),
      error: err instanceof Error ? err : new Error(String(err)),
      ...(code ? { code } : {}),
    }),
    // Item #15 Phase C — BundleIndex calls this after every mutation /
    // JOIN-applied change. Stub as a no-op for tests that only assert
    // on the bundle-ref surface.
    notifyProfileDirty: () => {},
  } as unknown as ProfileTokenStorageHost;
}

async function deriveKey(seed: string): Promise<Uint8Array> {
  return deriveProfileEncryptionKey(new TextEncoder().encode(seed), 'sync-test');
}

function makeBundleRef(cid: string, status: UxfBundleRef['status'] = 'active'): UxfBundleRef {
  return {
    cid,
    status,
    createdAt: 1_700_000_000,
    tokenCount: 1,
  };
}

/**
 * Encode a bundle ref the same way BundleIndex.addBundle does — JSON →
 * encrypt → wrap in a v=1 envelope. Returns the bytes that would land
 * in OrbitDB at `tokens.bundle.{cid}`.
 */
async function encodeBundleEntry(
  ref: UxfBundleRef,
  key: Uint8Array | null,
): Promise<Uint8Array> {
  const json = new TextEncoder().encode(JSON.stringify(ref));
  const encryptedPayload = key ? await encryptProfileValue(key, json) : json;
  const envelope = buildLocalEntry({
    type: 'cache_index',
    originated: 'system',
    payload: encryptedPayload,
  });
  return envelope;
}

// =============================================================================
// 1. snapshot
// =============================================================================

describe('BundleIndex.snapshot', () => {
  it('returns empty array on empty store', async () => {
    const db = createMockDb();
    const host = createMockHost({ db, encryptionKey: null });
    const index = new BundleIndex(host);
    expect(await index.snapshot()).toEqual([]);
  });

  it('returns every tokens.bundle.* entry sorted', async () => {
    const key = await deriveKey('snap-seed');
    const db = createMockDb();
    const host = createMockHost({ db, encryptionKey: key });
    const index = new BundleIndex(host);

    await index.addBundle('bafy-zzz', makeBundleRef('bafy-zzz'));
    await index.addBundle('bafy-aaa', makeBundleRef('bafy-aaa'));
    await index.addBundle('bafy-mmm', makeBundleRef('bafy-mmm'));

    const snap = await index.snapshot();
    expect(snap.map((e) => e.key)).toEqual([
      `${BUNDLE_KEY_PREFIX}bafy-aaa`,
      `${BUNDLE_KEY_PREFIX}bafy-mmm`,
      `${BUNDLE_KEY_PREFIX}bafy-zzz`,
    ]);
  });

  it('does not leak non-bundle keys', async () => {
    const db = createMockDb();
    const host = createMockHost({ db, encryptionKey: null });
    // Plant a foreign key.
    await db.put('outbox.entry-1', new TextEncoder().encode('x'));
    const index = new BundleIndex(host);
    expect(await index.snapshot()).toEqual([]);
  });

  it('returns empty array on db.all throw', async () => {
    const db = createMockDb();
    db.all = async () => {
      throw new Error('boom');
    };
    const host = createMockHost({ db, encryptionKey: null });
    const index = new BundleIndex(host);
    expect(await index.snapshot()).toEqual([]);
  });
});

// =============================================================================
// 2. joinSnapshot — merge table (constant-Lamport)
// =============================================================================

describe('BundleIndex.joinSnapshot — merge table', () => {
  it('absent + live → write remote; bundle visible via listBundles', async () => {
    const key = await deriveKey('absent-live');
    const dbA = createMockDb();
    const dbB = createMockDb();
    const indexA = new BundleIndex(createMockHost({ db: dbA, encryptionKey: key }));
    const indexB = new BundleIndex(createMockHost({ db: dbB, encryptionKey: key }));
    await indexB.addBundle('bafy-r1', makeBundleRef('bafy-r1'));

    const res = await indexA.joinSnapshot(await indexB.snapshot());
    expect(res.liveLanded).toBe(1);

    const bundles = await indexA.listBundles();
    expect(bundles.has('bafy-r1')).toBe(true);
    const ref = bundles.get('bafy-r1');
    expect(ref?.status).toBe('active');
    expect(ref?.cid).toBe('bafy-r1');
  });

  it('live + live → no-op (idempotent / local wins at Lamport=0 tie)', async () => {
    const key = await deriveKey('live-live');
    const dbA = createMockDb();
    const dbB = createMockDb();
    const indexA = new BundleIndex(createMockHost({ db: dbA, encryptionKey: key }));
    const indexB = new BundleIndex(createMockHost({ db: dbB, encryptionKey: key }));
    await indexA.addBundle('bafy-r1', makeBundleRef('bafy-r1', 'active'));
    await indexB.addBundle('bafy-r1', makeBundleRef('bafy-r1', 'superseded'));

    const res = await indexA.joinSnapshot(await indexB.snapshot());
    expect(res.localWon).toBe(1);
    expect(res.liveLanded).toBe(0);
    // Local 'active' status preserved.
    const bundles = await indexA.listBundles();
    expect(bundles.get('bafy-r1')?.status).toBe('active');
  });

  it('idempotence — re-running JOIN with same remote yields no-op', async () => {
    const key = await deriveKey('idempotent');
    const dbA = createMockDb();
    const dbB = createMockDb();
    const indexA = new BundleIndex(createMockHost({ db: dbA, encryptionKey: key }));
    const indexB = new BundleIndex(createMockHost({ db: dbB, encryptionKey: key }));
    await indexB.addBundle('bafy-r1', makeBundleRef('bafy-r1'));
    await indexB.addBundle('bafy-r2', makeBundleRef('bafy-r2'));

    const snap = await indexB.snapshot();
    const first = await indexA.joinSnapshot(snap);
    expect(first.liveLanded).toBe(2);
    const second = await indexA.joinSnapshot(snap);
    expect(second.liveLanded).toBe(0);
    expect(second.localWon).toBe(2);
  });

  it('bidirectional convergence — non-overlapping union', async () => {
    const key = await deriveKey('bidi');
    const dbA = createMockDb();
    const dbB = createMockDb();
    const indexA = new BundleIndex(createMockHost({ db: dbA, encryptionKey: key }));
    const indexB = new BundleIndex(createMockHost({ db: dbB, encryptionKey: key }));
    await indexA.addBundle('bafy-a-only', makeBundleRef('bafy-a-only'));
    await indexB.addBundle('bafy-b-only', makeBundleRef('bafy-b-only'));

    await indexA.joinSnapshot(await indexB.snapshot());
    await indexB.joinSnapshot(await indexA.snapshot());

    expect((await indexA.listBundles()).size).toBe(2);
    expect((await indexB.listBundles()).size).toBe(2);
  });
});

// =============================================================================
// 3. Side-effects — knownBundleCids refresh
// =============================================================================

describe('BundleIndex.joinSnapshot — knownBundleCids', () => {
  it('updates the host known-CID set when remote bundles land', async () => {
    const key = await deriveKey('known-set');
    const dbA = createMockDb();
    const dbB = createMockDb();
    const knownA = new Set<string>();
    const indexA = new BundleIndex(
      createMockHost({ db: dbA, encryptionKey: key, knownBundleCids: knownA }),
    );
    const indexB = new BundleIndex(createMockHost({ db: dbB, encryptionKey: key }));
    await indexB.addBundle('bafy-new', makeBundleRef('bafy-new'));

    expect(knownA.has('bafy-new')).toBe(false);
    await indexA.joinSnapshot(await indexB.snapshot());
    expect(knownA.has('bafy-new')).toBe(true);
  });
});

// =============================================================================
// 4. Malformed remote
// =============================================================================

describe('BundleIndex.joinSnapshot — malformed remote', () => {
  it('foreign-prefix key → rejected', async () => {
    const key = await deriveKey('foreign');
    const dbA = createMockDb();
    const indexA = new BundleIndex(createMockHost({ db: dbA, encryptionKey: key }));
    const bytes = await encodeBundleEntry(makeBundleRef('bafy-x'), key);
    const res = await indexA.joinSnapshot([
      { key: 'foreign.bundle.bafy-x', encryptedValue: bytes },
    ]);
    expect(res.remoteRejectedMalformed).toBe(1);
  });

  it('garbage bytes → rejected', async () => {
    const key = await deriveKey('garbage');
    const indexA = new BundleIndex(createMockHost({ db: createMockDb(), encryptionKey: key }));
    const res = await indexA.joinSnapshot([
      { key: `${BUNDLE_KEY_PREFIX}bafy-x`, encryptedValue: new TextEncoder().encode('not-an-envelope') },
    ]);
    expect(res.remoteRejectedMalformed).toBe(1);
  });

  it('invalid UxfBundleRef shape (missing required fields) → rejected', async () => {
    const key = await deriveKey('invalid-shape');
    const indexA = new BundleIndex(createMockHost({ db: createMockDb(), encryptionKey: key }));
    // Encode a payload that's NOT a valid UxfBundleRef (missing status,
    // createdAt etc).
    const garbageRef = { cid: 'bafy-x' } as unknown as UxfBundleRef;
    const bytes = await encodeBundleEntry(garbageRef, key);
    const res = await indexA.joinSnapshot([
      { key: `${BUNDLE_KEY_PREFIX}bafy-x`, encryptedValue: bytes },
    ]);
    expect(res.remoteRejectedMalformed).toBe(1);
  });

  it('invalid status enum → rejected', async () => {
    const key = await deriveKey('bad-status');
    const indexA = new BundleIndex(createMockHost({ db: createMockDb(), encryptionKey: key }));
    const ref = {
      cid: 'bafy-x',
      status: 'pending', // not a valid status
      createdAt: 1_700_000_000,
    } as unknown as UxfBundleRef;
    const bytes = await encodeBundleEntry(ref, key);
    const res = await indexA.joinSnapshot([
      { key: `${BUNDLE_KEY_PREFIX}bafy-x`, encryptedValue: bytes },
    ]);
    expect(res.remoteRejectedMalformed).toBe(1);
  });
});

// =============================================================================
// 5. Encryption end-to-end
// =============================================================================

describe('BundleIndex.joinSnapshot — encryption', () => {
  it('wrong-key remote → rejected', async () => {
    const keyA = await deriveKey('wrong-key-a');
    const keyB = await deriveKey('wrong-key-b');
    const dbA = createMockDb();
    const dbB = createMockDb();
    const indexA = new BundleIndex(createMockHost({ db: dbA, encryptionKey: keyA }));
    const indexB = new BundleIndex(createMockHost({ db: dbB, encryptionKey: keyB }));
    await indexB.addBundle('bafy-x', makeBundleRef('bafy-x'));

    const res = await indexA.joinSnapshot(await indexB.snapshot());
    expect(res.remoteRejectedMalformed).toBe(1);
    expect((await indexA.listBundles()).has('bafy-x')).toBe(false);
  });

  it('shared-key round-trip preserves ref fields', async () => {
    const key = await deriveKey('shared');
    const dbA = createMockDb();
    const dbB = createMockDb();
    const indexA = new BundleIndex(createMockHost({ db: dbA, encryptionKey: key }));
    const indexB = new BundleIndex(createMockHost({ db: dbB, encryptionKey: key }));
    await indexB.addBundle('bafy-x', {
      cid: 'bafy-x',
      status: 'superseded',
      createdAt: 1_700_000_999,
      tokenCount: 42,
      supersededBy: 'bafy-newer',
    });

    await indexA.joinSnapshot(await indexB.snapshot());
    const recovered = (await indexA.listBundles()).get('bafy-x')!;
    expect(recovered.status).toBe('superseded');
    expect(recovered.createdAt).toBe(1_700_000_999);
    expect(recovered.tokenCount).toBe(42);
    expect(recovered.supersededBy).toBe('bafy-newer');
  });
});

// =============================================================================
// 6. Empty remote
// =============================================================================

describe('BundleIndex.joinSnapshot — empty remote', () => {
  it('no remote entries → zero counters', async () => {
    const indexA = new BundleIndex(createMockHost({ db: createMockDb(), encryptionKey: null }));
    const res = await indexA.joinSnapshot([]);
    expect(res.entriesEvaluated).toBe(0);
    expect(res.liveLanded).toBe(0);
  });
});
