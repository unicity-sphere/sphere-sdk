/**
 * Tests for the identity-key lazy backfill behaviour in
 * `Sphere.loadIdentityFromStorage` → `readIdentityKey`.
 *
 * Symptom motivating the fix (2026-06-02): wallets that existed BEFORE
 * the `IDENTITY_KEYS ⊂ CACHE_ONLY_KEYS` fix still have their seed
 * material in the legacy IndexedDB (configured as Sphere's
 * `fallbackStorage`). On every boot the Profile-mode primary read
 * returns `null` for every identity key, the helper consults the
 * fallback, succeeds, and the wallet boots — but emits one
 * `[Sphere] Identity read for "<key>" missing from primary storage`
 * warning per identity key on every single boot.
 *
 * Fix: when the fallback read succeeds, also write the value back to
 * the primary. With `IDENTITY_KEYS ⊂ CACHE_ONLY_KEYS`, that write
 * lands in the Profile localCache (IndexedDB) only — it never
 * reaches OrbitDB / IPFS. The next boot finds the value in the
 * primary on the first read; no fallback consult, no warning.
 *
 * The backfill must be best-effort: if the primary `set` throws, the
 * read already succeeded and the caller has the value — we must not
 * regress the load just because the backfill failed.
 */

import { describe, it, expect, vi } from 'vitest';
import { Sphere } from '../../../core/Sphere';
import { STORAGE_KEYS_GLOBAL } from '../../../constants';
import type { StorageProvider } from '../../../storage';
import type { ProviderStatus } from '../../../types';

function createMockStorage(
  seed: Map<string, string> = new Map(),
): StorageProvider & { _store: Map<string, string> } {
  const data = new Map(seed);
  return {
    id: 'mock-storage',
    name: 'Mock Storage',
    type: 'local' as const,
    _store: data,
    setIdentity: vi.fn(),
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      data.set(key, value);
    }),
    remove: vi.fn(async (key: string) => {
      data.delete(key);
    }),
    has: vi.fn(async (key: string) => data.has(key)),
    keys: vi.fn(async () => Array.from(data.keys())),
    clear: vi.fn(async () => {
      data.clear();
    }),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    getStatus: vi.fn((): ProviderStatus => 'connected'),
    saveTrackedAddresses: vi.fn(async () => {}),
    loadTrackedAddresses: vi.fn(async () => []),
  } as StorageProvider & { _store: Map<string, string> };
}

describe('Sphere — identity-key fallback backfill', () => {
  it('writes fallback values back into primary so subsequent boots skip the fallback consult', async () => {
    // Primary satisfies `Sphere.exists` via MNEMONIC alone — modelling
    // the real-world scenario where a wallet predates the Profile
    // refactor: SOME identity material is in the Profile localCache
    // (or, via legacy migration markers, was already partially
    // backfilled), but other identity keys are still ONLY in the
    // legacy fallback. The backfill path runs for every identity key
    // the primary doesn't yet have.
    const primary = createMockStorage(
      new Map<string, string>([
        // MNEMONIC present in primary so Sphere.exists returns true.
        [STORAGE_KEYS_GLOBAL.MNEMONIC, 'v2:primary-mnemonic'],
      ]),
    );
    const fallback = createMockStorage(
      new Map<string, string>([
        [STORAGE_KEYS_GLOBAL.MNEMONIC, 'v2:fallback-mnemonic'],
        [STORAGE_KEYS_GLOBAL.MASTER_KEY, 'v2:fallback-masterkey'],
        [STORAGE_KEYS_GLOBAL.CHAIN_CODE, 'cafebabe'],
        [STORAGE_KEYS_GLOBAL.DERIVATION_PATH, "m/44'/0'/0'/0/0"],
        [STORAGE_KEYS_GLOBAL.BASE_PATH, "m/44'/0'/0'/0"],
        [STORAGE_KEYS_GLOBAL.DERIVATION_MODE, 'mnemonic'],
        [STORAGE_KEYS_GLOBAL.WALLET_SOURCE, 'mnemonic'],
        [STORAGE_KEYS_GLOBAL.CURRENT_ADDRESS_INDEX, '0'],
      ]),
    );

    // Sphere.load WILL throw downstream of readIdentityKey — the
    // ciphertexts here aren't real v2 envelopes so decryption fails.
    // What matters for THIS test is whether the backfill happens
    // BEFORE the throw.
    try {
      await Sphere.load({ storage: primary, fallbackStorage: fallback });
    } catch {
      // Expected — see comment above.
    }

    // For each identity key the primary lacks, the loader should
    // have backfilled the fallback value. MNEMONIC is in primary so
    // it should NOT be backfilled; the rest should.
    const setCalls = (primary.set as ReturnType<typeof vi.fn>).mock.calls;
    const setKeys = setCalls.map(([k]) => k as string);

    expect(setKeys).not.toContain(STORAGE_KEYS_GLOBAL.MNEMONIC);
    expect(setKeys).toContain(STORAGE_KEYS_GLOBAL.MASTER_KEY);
    expect(setKeys).toContain(STORAGE_KEYS_GLOBAL.CHAIN_CODE);
    expect(setKeys).toContain(STORAGE_KEYS_GLOBAL.DERIVATION_PATH);

    // The values written must match the fallback values verbatim.
    const masterKeyWrite = setCalls.find(
      ([k]) => k === STORAGE_KEYS_GLOBAL.MASTER_KEY,
    );
    expect(masterKeyWrite?.[1]).toBe('v2:fallback-masterkey');

    const chainCodeWrite = setCalls.find(
      ([k]) => k === STORAGE_KEYS_GLOBAL.CHAIN_CODE,
    );
    expect(chainCodeWrite?.[1]).toBe('cafebabe');
  });

  it('backfill failure does NOT regress the wallet load (best-effort write)', async () => {
    // Primary's set() throws on every call (e.g., quota exhaustion,
    // contention, etc.). The fallback read still succeeds; readIdentityKey
    // must return the fallback value to the caller, not bubble the
    // backfill error.
    const primary = createMockStorage(
      new Map<string, string>([
        // Satisfy Sphere.exists.
        [STORAGE_KEYS_GLOBAL.MNEMONIC, 'v2:primary-mnemonic'],
      ]),
    );
    primary.set = vi.fn(async () => {
      throw new Error('quota exceeded');
    });
    const fallback = createMockStorage(
      new Map<string, string>([
        [STORAGE_KEYS_GLOBAL.MASTER_KEY, 'fallback-value'],
      ]),
    );

    // We don't care about Sphere.load succeeding here — only that the
    // failing backfill didn't surface as an error at the readIdentityKey
    // boundary. Verify by asserting primary.set was attempted (proving
    // the code path ran).
    let thrownMessage: string | null = null;
    try {
      await Sphere.load({ storage: primary, fallbackStorage: fallback });
    } catch (err) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }

    // Whatever downstream threw, it must NOT be 'quota exceeded' —
    // the backfill error was swallowed (best-effort) and the original
    // load-path error surfaced instead.
    if (thrownMessage !== null) {
      expect(thrownMessage).not.toContain('quota exceeded');
    }

    // primary.set was attempted for MASTER_KEY (the backfill) —
    // proving the fallback path was taken and the backfill code ran.
    const setCalls = (primary.set as ReturnType<typeof vi.fn>).mock.calls;
    const masterKeyAttempt = setCalls.find(
      ([k]) => k === STORAGE_KEYS_GLOBAL.MASTER_KEY,
    );
    expect(masterKeyAttempt).toBeDefined();
  });

  it('no fallback consult when primary already holds the value (no backfill triggered)', async () => {
    // The post-backfill steady state. On the second boot, primary has
    // the identity keys; fallback is never consulted; primary.set is
    // never called from readIdentityKey for these keys.
    const primary = createMockStorage(
      new Map<string, string>([
        [STORAGE_KEYS_GLOBAL.MNEMONIC, 'v2:already-here'],
        [STORAGE_KEYS_GLOBAL.MASTER_KEY, 'v2:already-here-too'],
        [STORAGE_KEYS_GLOBAL.CHAIN_CODE, 'cafebabe'],
        [STORAGE_KEYS_GLOBAL.DERIVATION_PATH, "m/44'/0'/0'/0/0"],
        [STORAGE_KEYS_GLOBAL.BASE_PATH, "m/44'/0'/0'/0"],
        [STORAGE_KEYS_GLOBAL.DERIVATION_MODE, 'mnemonic'],
        [STORAGE_KEYS_GLOBAL.WALLET_SOURCE, 'mnemonic'],
        [STORAGE_KEYS_GLOBAL.CURRENT_ADDRESS_INDEX, '0'],
      ]),
    );
    const fallback = createMockStorage(new Map());

    try {
      await Sphere.load({ storage: primary, fallbackStorage: fallback });
    } catch {
      // Decryption / downstream errors expected — irrelevant to this test.
    }

    // Fallback.get was never called for an identity key — we never
    // needed to consult it. (Other components might query fallback for
    // unrelated keys; this test only enforces identity-key behaviour.)
    const fallbackGetCalls = (fallback.get as ReturnType<typeof vi.fn>).mock
      .calls;
    const identityKeysAccessedFromFallback = fallbackGetCalls.filter(([k]) =>
      [
        STORAGE_KEYS_GLOBAL.MNEMONIC,
        STORAGE_KEYS_GLOBAL.MASTER_KEY,
        STORAGE_KEYS_GLOBAL.CHAIN_CODE,
        STORAGE_KEYS_GLOBAL.DERIVATION_PATH,
        STORAGE_KEYS_GLOBAL.BASE_PATH,
        STORAGE_KEYS_GLOBAL.DERIVATION_MODE,
        STORAGE_KEYS_GLOBAL.WALLET_SOURCE,
        STORAGE_KEYS_GLOBAL.CURRENT_ADDRESS_INDEX,
      ].includes(k as string),
    );
    expect(identityKeysAccessedFromFallback).toEqual([]);

    // And we did NOT re-write to primary for these keys via the
    // backfill path (primary.set may have been called by other paths
    // like finalizeWalletCreation — filter to identity keys only).
    const primarySetCalls = (primary.set as ReturnType<typeof vi.fn>).mock
      .calls;
    const identityBackfills = primarySetCalls.filter(([k]) =>
      [
        STORAGE_KEYS_GLOBAL.MNEMONIC,
        STORAGE_KEYS_GLOBAL.MASTER_KEY,
        STORAGE_KEYS_GLOBAL.CHAIN_CODE,
        STORAGE_KEYS_GLOBAL.DERIVATION_PATH,
        STORAGE_KEYS_GLOBAL.BASE_PATH,
        STORAGE_KEYS_GLOBAL.DERIVATION_MODE,
        STORAGE_KEYS_GLOBAL.WALLET_SOURCE,
        STORAGE_KEYS_GLOBAL.CURRENT_ADDRESS_INDEX,
      ].includes(k as string),
    );
    expect(identityBackfills).toEqual([]);
  });
});
