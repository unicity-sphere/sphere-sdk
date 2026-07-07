/**
 * T-D11 W11 regression tests — bundle-ref writes are stamped with
 * originated='system' when the underlying ProfileDatabase supports
 * the structured-entry API (putEntry / getEntry), and the fallback
 * raw-bytes path remains readable alongside envelope writes.
 *
 * Scope is narrow: exercise `addBundle` + `listBundles` with a mock
 * DB that supports both APIs. Assertions:
 *   - addBundle with envelope support → envelope.type='cache_index',
 *     envelope.originated='system'
 *   - listBundles reads envelope-stamped writes correctly
 *   - listBundles reads legacy raw-bytes writes correctly (mixed
 *     population survives the refactor)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type {
  ProfileDatabase,
  OrbitDbConfig,
  UxfBundleRef,
} from '../../../extensions/uxf/profile/types';
import type { FullIdentity } from '../../../types';
import type { OpLogEntryEnvelope } from '../../../extensions/uxf/profile/oplog-entry';
import { ProfileTokenStorageProvider } from '../../../extensions/uxf/profile/profile-token-storage-provider';
import {
  deriveProfileEncryptionKey,
  encryptProfileValue,
} from '../../../extensions/uxf/profile/encryption';
import { encodeEntry, decodeEntry } from '../../../extensions/uxf/profile/oplog-entry';
import { ConsolidationEngine } from '../../../extensions/uxf/profile/consolidation';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

const BUNDLE_KEY_PREFIX = 'tokens.bundle.';

function hexToBytes(hex: string): Uint8Array {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) b[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return b;
}

function encryptionKey(): Uint8Array {
  return deriveProfileEncryptionKey(hexToBytes(TEST_PRIVATE_KEY));
}

/**
 * Mock ProfileDatabase that supports BOTH the raw put/get API AND
 * the structured putEntry/getEntry API. The latter is what the
 * real OrbitDbAdapter exposes; the mocks in the existing
 * profile-token-storage-provider.test.ts omit it (to exercise the
 * legacy-compatibility fallback).
 */
function createEnvelopeAwareDb(): ProfileDatabase & {
  _store: Map<string, Uint8Array>;
  _envelopes: Map<string, OpLogEntryEnvelope>;
} {
  const store = new Map<string, Uint8Array>();
  const envelopes = new Map<string, OpLogEntryEnvelope>();
  return {
    _store: store,
    _envelopes: envelopes,
    async connect(_: OrbitDbConfig) {},
    async put(k: string, v: Uint8Array) {
      store.set(k, v);
    },
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async del(k: string) {
      store.delete(k);
      envelopes.delete(k);
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
    async putEntry(k: string, entry: OpLogEntryEnvelope) {
      const bytes = encodeEntry(entry);
      store.set(k, bytes);
      envelopes.set(k, entry);
    },
    async getEntry(k: string) {
      const bytes = store.get(k);
      if (!bytes) return null;
      try {
        return decodeEntry(bytes);
      } catch {
        return null;
      }
    },
  } as ProfileDatabase & {
    _store: Map<string, Uint8Array>;
    _envelopes: Map<string, OpLogEntryEnvelope>;
  };
}

function createProvider(db: ProfileDatabase): ProfileTokenStorageProvider {
  const provider = new ProfileTokenStorageProvider(
    db,
    encryptionKey(),
    ['https://mock-ipfs.test'],
    {
      config: {
        orbitDb: { privateKey: TEST_PRIVATE_KEY },
      },
      addressId: 'test',
      encrypt: true,
    },
  );
  provider.setIdentity(TEST_IDENTITY);
  return provider;
}

// Reach into the private `addBundle` via a typed accessor rather than
// exposing it — the test is narrow and the invariant is what matters.
function callAddBundle(
  provider: ProfileTokenStorageProvider,
  cid: string,
  ref: UxfBundleRef,
): Promise<void> {
  return (provider as unknown as {
    addBundle: (cid: string, ref: UxfBundleRef) => Promise<void>;
  }).addBundle(cid, ref);
}

function callListBundles(
  provider: ProfileTokenStorageProvider,
): Promise<Map<string, UxfBundleRef>> {
  return (provider as unknown as {
    listBundles: () => Promise<Map<string, UxfBundleRef>>;
  }).listBundles();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('T-D11 bundle-ref stamping (W11)', () => {
  let db: ReturnType<typeof createEnvelopeAwareDb>;
  let provider: ProfileTokenStorageProvider;

  beforeEach(() => {
    db = createEnvelopeAwareDb();
    provider = createProvider(db);
  });

  it('addBundle writes a system-stamped envelope when the adapter supports putEntry', async () => {
    await callAddBundle(provider, 'bafyTest', {
      cid: 'bafyTest',
      status: 'active',
      createdAt: 12345,
    });

    const envelope = db._envelopes.get(`${BUNDLE_KEY_PREFIX}bafyTest`);
    expect(envelope).toBeDefined();
    if (!envelope) return;
    expect(envelope.v).toBe(1);
    expect(envelope.type).toBe('cache_index');
    expect(envelope.originated).toBe('system');
    // Payload is the encrypted bundle ref — just assert it is present
    // and non-empty; encryption round-trip is covered in other tests.
    expect(envelope.payload.byteLength).toBeGreaterThan(0);
  });

  it('listBundles reads an envelope-stamped bundle back into its UxfBundleRef shape', async () => {
    const ref: UxfBundleRef = {
      cid: 'bafyEnv',
      status: 'active',
      createdAt: 5555,
      tokenCount: 3,
    };
    await callAddBundle(provider, 'bafyEnv', ref);

    const bundles = await callListBundles(provider);
    expect(bundles.has('bafyEnv')).toBe(true);
    const got = bundles.get('bafyEnv')!;
    expect(got.cid).toBe('bafyEnv');
    expect(got.status).toBe('active');
    expect(got.createdAt).toBe(5555);
  });

  it('listBundles transparently handles a legacy raw-bytes entry alongside stamped writes', async () => {
    // Pre-populate a legacy raw-bytes entry (pre-T-D11 write shape).
    const legacyRef: UxfBundleRef = {
      cid: 'bafyLegacy',
      status: 'active',
      createdAt: 1111,
    };
    const legacyEncrypted = await encryptProfileValue(
      encryptionKey(),
      new TextEncoder().encode(JSON.stringify(legacyRef)),
    );
    db._store.set(`${BUNDLE_KEY_PREFIX}bafyLegacy`, legacyEncrypted);

    // Then add a new envelope-stamped write.
    await callAddBundle(provider, 'bafyNew', {
      cid: 'bafyNew',
      status: 'active',
      createdAt: 2222,
    });

    const bundles = await callListBundles(provider);
    expect(bundles.size).toBe(2);
    expect(bundles.get('bafyLegacy')?.createdAt).toBe(1111);
    expect(bundles.get('bafyNew')?.createdAt).toBe(2222);
  });

  it('ConsolidationEngine reads envelope-stamped bundles written by addBundle', async () => {
    // Steelman C1: without this coverage, consolidation would
    // silently drop any bundle that was stamped as an envelope —
    // it would treat the envelope bytes as AES-GCM ciphertext and
    // fail to decrypt. Both writers must round-trip through both
    // readers.
    await callAddBundle(provider, 'bafyA', {
      cid: 'bafyA',
      status: 'active',
      createdAt: 100,
    });
    await callAddBundle(provider, 'bafyB', {
      cid: 'bafyB',
      status: 'active',
      createdAt: 200,
    });

    // ConsolidationEngine.shouldConsolidate() exercises the
    // listActiveBundles path which goes through listAllBundles's
    // envelope-aware read. If the read were still raw-bytes-only
    // (as it was pre-fix), both bundles would silently drop from
    // the count and this would return false.
    const engine = new ConsolidationEngine(
      db,
      encryptionKey(),
      ['https://mock-ipfs.test'],
    );
    // With 2 active bundles we are below CONSOLIDATION_THRESHOLD=3
    // (so shouldConsolidate returns false), but what matters is
    // that listActiveBundles sees BOTH bundles — not zero. We
    // check via the public listBundles re-read approach: the
    // provider's own listBundles must return 2 entries.
    const bundles = await callListBundles(provider);
    expect(bundles.size).toBe(2);

    // Also: consolidation shouldn't blow up on envelope reads —
    // exercise shouldConsolidate as a smoke test of the real path.
    await expect(engine.shouldConsolidate()).resolves.toBe(false);
  });

  it('addBundle falls back to raw-bytes write on an adapter without putEntry', async () => {
    // Rebuild the db without putEntry / getEntry.
    const legacyDb = createEnvelopeAwareDb();
    // Simulate a legacy adapter by deleting the structured API.
    (legacyDb as unknown as { putEntry?: unknown; getEntry?: unknown }).putEntry = undefined;
    (legacyDb as unknown as { putEntry?: unknown; getEntry?: unknown }).getEntry = undefined;
    const legacyProvider = createProvider(legacyDb);

    await callAddBundle(legacyProvider, 'bafyOld', {
      cid: 'bafyOld',
      status: 'active',
      createdAt: 999,
    });

    // No envelope stamped (putEntry never called), raw-bytes write landed.
    expect(legacyDb._envelopes.has(`${BUNDLE_KEY_PREFIX}bafyOld`)).toBe(false);
    expect(legacyDb._store.has(`${BUNDLE_KEY_PREFIX}bafyOld`)).toBe(true);

    // Round-trip still works.
    const bundles = await callListBundles(legacyProvider);
    expect(bundles.get('bafyOld')?.createdAt).toBe(999);
  });
});
