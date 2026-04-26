/**
 * Steelman⁵² regression: detect partial-write corruption at load time.
 *
 * F.56 added best-effort transactional rollback to storeMnemonic /
 * storeMasterKey. F.57 added a load-time guard so partial-write
 * corruption (rollback that itself failed) surfaces as
 * STORAGE_CORRUPTED rather than silently deriving the wrong
 * identity from defaults.
 */
import { describe, it, expect, vi } from 'vitest';
import { Sphere } from '../../../core/Sphere';
import { SphereError } from '../../../core/errors';
import type { StorageProvider } from '../../../storage';
import { STORAGE_KEYS_GLOBAL } from '../../../constants';
import type { ProviderStatus } from '../../../types';

function createMockStorage(seed: Map<string, string> = new Map()): StorageProvider {
  const data = new Map(seed);
  return {
    id: 'mock-storage',
    name: 'Mock Storage',
    type: 'local' as const,
    setIdentity: vi.fn(),
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { data.set(key, value); }),
    remove: vi.fn(async (key: string) => { data.delete(key); }),
    has: vi.fn(async (key: string) => data.has(key)),
    keys: vi.fn(async () => Array.from(data.keys())),
    clear: vi.fn(async () => { data.clear(); }),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    getStatus: vi.fn((): ProviderStatus => 'connected'),
    saveTrackedAddresses: vi.fn(async () => {}),
    loadTrackedAddresses: vi.fn(async () => []),
  };
}

describe('Sphere — partial-write corruption detection (steelman⁵²)', () => {
  it('load() throws STORAGE_CORRUPTED on partial metadata (BASE_PATH + WALLET_SOURCE present, DERIVATION_MODE missing)', async () => {
    // Simulate a partial-write scenario: MNEMONIC was written along
    // with SOME metadata, but a mid-sequence error left another
    // metadata key missing AND the best-effort rollback also failed.
    // This is the "have-some / missing-some" partial state — must
    // be detected because applying defaults to the missing fields
    // would derive the wrong identity.
    const storage = createMockStorage(
      new Map<string, string>([
        [STORAGE_KEYS_GLOBAL.MNEMONIC, 'v2:not-real-ciphertext'],
        [STORAGE_KEYS_GLOBAL.BASE_PATH, "m/44'/0'/0'/0"],
        [STORAGE_KEYS_GLOBAL.WALLET_SOURCE, 'mnemonic'],
        // DERIVATION_MODE intentionally absent
      ]),
    );

    let thrown: unknown = null;
    try {
      await Sphere.load({ storage });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SphereError);
    expect((thrown as SphereError).code).toBe('STORAGE_CORRUPTED');
    expect(String(thrown)).toMatch(/DERIVATION_MODE/);
  });

  it('load() does NOT throw STORAGE_CORRUPTED on legacy/external-app shape (MNEMONIC only, no metadata at all)', async () => {
    // Legacy path: external app drops a plaintext mnemonic into
    // wallet.json with no metadata. Defaults apply. The decrypt
    // attempt may still throw (because the mnemonic shape isn't
    // a v2: envelope), but it should NOT be STORAGE_CORRUPTED —
    // the partial-write detector must only trigger when SOME
    // metadata is present and SOME is missing.
    const storage = createMockStorage(
      new Map<string, string>([
        [STORAGE_KEYS_GLOBAL.MNEMONIC, 'plaintext mnemonic from external app'],
      ]),
    );
    let thrown: unknown = null;
    try {
      await Sphere.load({ storage });
    } catch (err) {
      thrown = err;
    }
    // Whatever throws, it must NOT be STORAGE_CORRUPTED.
    if (thrown instanceof SphereError) {
      expect(thrown.code).not.toBe('STORAGE_CORRUPTED');
    }
  });

  it('load() throws STORAGE_CORRUPTED when MASTER_KEY present but DERIVATION_MODE missing', async () => {
    const storage = createMockStorage(
      new Map<string, string>([
        [STORAGE_KEYS_GLOBAL.MASTER_KEY, 'v2:not-real-ciphertext'],
        [STORAGE_KEYS_GLOBAL.BASE_PATH, "m/44'/0'/0'/0"],
        [STORAGE_KEYS_GLOBAL.WALLET_SOURCE, 'file'],
        // DERIVATION_MODE intentionally absent
      ]),
    );
    let thrown: unknown = null;
    try {
      await Sphere.load({ storage });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SphereError);
    expect((thrown as SphereError).code).toBe('STORAGE_CORRUPTED');
    expect(String(thrown)).toMatch(/DERIVATION_MODE/);
  });

  it('load() throws NOT_INITIALIZED (not STORAGE_CORRUPTED) when no key material is present', async () => {
    const storage = createMockStorage(new Map());
    let thrown: unknown = null;
    try {
      await Sphere.load({ storage });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SphereError);
    expect((thrown as SphereError).code).toBe('NOT_INITIALIZED');
  });
});
