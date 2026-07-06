/**
 * `ProfileStorageProvider.buildCidRefStore()` tests (Issue #285).
 *
 * The accessor mirrors the existing build* family (`buildOutboxWriter`,
 * `buildSentLedgerWriter`, `buildDispositionStorageAdapter`, …) and
 * returns null when:
 *   - encryption is disabled (`encrypt: false`), OR
 *   - the encryption key has not been derived yet (setIdentity pending),
 *     OR
 *   - no IPFS gateways are configured.
 *
 * Otherwise it returns a fully wired CidRefStore using the provider's
 * profile encryption key and configured gateway list. The returned
 * store's pinJson/fetchJson round-trip is covered separately in
 * `cid-ref-store.test.ts`; here we only assert the construction path
 * + null-handling.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ProfileStorageProvider } from '../../../extensions/uxf/profile/profile-storage-provider';
import { CidRefStore } from '../../../extensions/uxf/profile/cid-ref-store';
import type { ProfileDatabase } from '../../../extensions/uxf/profile/types';
import type { StorageProvider } from '../../../storage';
import type { FullIdentity } from '../../../types';

// ── Test fixtures ─────────────────────────────────────────────────────────

const TEST_PRIVKEY = 'aa'.repeat(32);
const TEST_PUBKEY = '02' + 'bb'.repeat(32);

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: TEST_PUBKEY,
  privateKey: TEST_PRIVKEY,
  directAddress: 'DIRECT://testaddr',
};

/** Minimal local-cache stub satisfying `StorageProvider` shape. */
function createStubLocalCache(): StorageProvider {
  const store = new Map<string, string>();
  return {
    id: 'stub-local-cache',
    name: 'Stub Local Cache',
    type: 'local',
    description: '',
    connect: async () => undefined,
    disconnect: async () => undefined,
    isConnected: () => true,
    getStatus: () => 'connected',
    setIdentity: () => undefined,
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => {
      store.set(k, v);
    },
    remove: async (k) => {
      store.delete(k);
    },
    has: async (k) => store.has(k),
    keys: async (prefix) => {
      const all = Array.from(store.keys());
      return prefix == null ? all : all.filter((k) => k.startsWith(prefix));
    },
    clear: async () => undefined,
    saveTrackedAddresses: async () => undefined,
    loadTrackedAddresses: async () => [],
  } as StorageProvider;
}

/** Minimal ProfileDatabase stub — never actually accessed in build* paths. */
function createStubProfileDb(): ProfileDatabase {
  return {
    connect: async () => undefined,
    disconnect: async () => undefined,
    put: async () => undefined,
    get: async () => null,
    del: async () => undefined,
    all: async () => [],
    keys: async () => [],
  } as unknown as ProfileDatabase;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('ProfileStorageProvider.buildCidRefStore (Issue #285)', () => {
  let cache: StorageProvider;
  let db: ProfileDatabase;

  beforeEach(() => {
    cache = createStubLocalCache();
    db = createStubProfileDb();
  });

  it('returns a wired CidRefStore when encryption + identity + gateways are configured', () => {
    const provider = new ProfileStorageProvider(cache, db, {
      encrypt: true,
      config: {
        ipfsGateways: ['https://ipfs.example.com'],
        orbitDb: { name: 'test-db' },
      },
    });
    provider.setIdentity(TEST_IDENTITY);

    const store = provider.buildCidRefStore();
    expect(store).not.toBeNull();
    expect(store).toBeInstanceOf(CidRefStore);
  });

  it('returns null when encryption is disabled', () => {
    const provider = new ProfileStorageProvider(cache, db, {
      encrypt: false,
      config: {
        ipfsGateways: ['https://ipfs.example.com'],
        orbitDb: { name: 'test-db' },
      },
    });
    provider.setIdentity(TEST_IDENTITY);

    expect(provider.buildCidRefStore()).toBeNull();
  });

  it('returns null when setIdentity has not been called yet (encryption key undefined)', () => {
    const provider = new ProfileStorageProvider(cache, db, {
      encrypt: true,
      config: {
        ipfsGateways: ['https://ipfs.example.com'],
        orbitDb: { name: 'test-db' },
      },
    });
    // setIdentity intentionally NOT called.
    expect(provider.buildCidRefStore()).toBeNull();
  });

  it('returns null when no IPFS gateways are configured', () => {
    const provider = new ProfileStorageProvider(cache, db, {
      encrypt: true,
      config: {
        // ipfsGateways omitted
        orbitDb: { name: 'test-db' },
      },
    });
    provider.setIdentity(TEST_IDENTITY);

    expect(provider.buildCidRefStore()).toBeNull();
  });

  it('returns null when IPFS gateways array is empty', () => {
    const provider = new ProfileStorageProvider(cache, db, {
      encrypt: true,
      config: {
        ipfsGateways: [],
        orbitDb: { name: 'test-db' },
      },
    });
    provider.setIdentity(TEST_IDENTITY);

    expect(provider.buildCidRefStore()).toBeNull();
  });

  it('each call returns a FRESH CidRefStore instance (callers cache externally)', () => {
    const provider = new ProfileStorageProvider(cache, db, {
      encrypt: true,
      config: {
        ipfsGateways: ['https://ipfs.example.com'],
        orbitDb: { name: 'test-db' },
      },
    });
    provider.setIdentity(TEST_IDENTITY);

    const a = provider.buildCidRefStore();
    const b = provider.buildCidRefStore();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });
});
