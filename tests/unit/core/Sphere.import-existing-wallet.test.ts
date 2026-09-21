/**
 * `Sphere.import()` over a storage that already holds a wallet (#801).
 *
 * import() used to erase the existing wallet FIRST and validate its input afterwards,
 * so a rejected import (bad mnemonic, a missing network with walletApi 'none', an empty
 * password, a non-hex master key) left the storage empty, or bricked with a key the
 * loader cannot read. Replacing a wallet is now an explicit `overwrite: true`, and every
 * input check runs before anything on storage is touched.
 *
 * Each rejection below asserts both halves: the error, and that the existing wallet is
 * still there — its mnemonic unchanged and no full `storage.clear()` (one without a
 * prefix; payments start-up legitimately sweeps the retired 'pv2:' prefix).
 */

import { afterEach, describe, expect, it, type Mock } from 'vitest';

import { Sphere } from '../../../core/Sphere';
import { STORAGE_KEYS_GLOBAL } from '../../../constants';
import type { NetworkType } from '../../../constants';
import type { OracleProvider } from '../../../oracle';
import type { TransportProvider } from '../../../transport';
import { TEST_NETWORK } from '../../test-network';
import { makeMockProviders, TEST_MNEMONIC, type MockProviders } from './support/mock-providers';

/** A second valid BIP39 vector, so a replacing import is distinguishable from the original. */
const OTHER_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const VALID_HEX = 'a'.repeat(64);

describe('Sphere.import over an existing wallet (#801)', () => {
  let live: Sphere | null = null;

  afterEach(async () => {
    if (live) {
      try { await live.destroy(); } catch { /* already torn down */ }
    }
    live = null;
  });

  function common(p: MockProviders) {
    return {
      storage: p.storage,
      transport: p.transport as unknown as TransportProvider,
      oracle: p.oracle as unknown as OracleProvider,
      walletApi: p.walletApi,
      network: TEST_NETWORK,
    };
  }

  /** Mock providers whose clear() honours its prefix, as the real providers do. */
  function providers(walletExists: boolean): MockProviders {
    const p = makeMockProviders({ walletExists });
    (p.storage.clear as Mock).mockImplementation(async (prefix?: string) => {
      for (const key of [...p.storage._data.keys()]) {
        if (!prefix || key.startsWith(prefix)) p.storage._data.delete(key);
      }
    });
    return p;
  }

  /** clear() calls without a prefix: the ones that erase a whole wallet. */
  const fullClears = (p: MockProviders): number =>
    (p.storage.clear as Mock).mock.calls.filter((args) => !args[0]).length;

  function expectWalletUntouched(p: MockProviders): void {
    expect(p.storage._data.get(STORAGE_KEYS_GLOBAL.MNEMONIC)).toBe(TEST_MNEMONIC);
    expect(fullClears(p)).toBe(0);
  }

  it('refuses without overwrite and leaves the wallet in place', async () => {
    const p = providers(true);
    await expect(
      Sphere.import({ ...common(p), mnemonic: OTHER_MNEMONIC }),
    ).rejects.toMatchObject({ code: 'ALREADY_INITIALIZED' });
    expectWalletUntouched(p);
  });

  it('checks the mnemonic before erasing, even with overwrite', async () => {
    const p = providers(true);
    await expect(
      Sphere.import({ ...common(p), mnemonic: 'clearly not a valid bip39 phrase', overwrite: true }),
    ).rejects.toMatchObject({ code: 'INVALID_IDENTITY' });
    expectWalletUntouched(p);
  });

  it("checks the network before erasing with walletApi 'none' (missing)", async () => {
    const p = providers(true);
    await expect(
      Sphere.import({ ...common(p), walletApi: 'none', network: undefined, mnemonic: OTHER_MNEMONIC, overwrite: true }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expectWalletUntouched(p);
  });

  it("checks the network before erasing with walletApi 'none' (unknown name)", async () => {
    const p = providers(true);
    await expect(
      Sphere.import({
        ...common(p),
        walletApi: 'none',
        network: 'dev' as unknown as NetworkType,
        mnemonic: OTHER_MNEMONIC,
        overwrite: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expectWalletUntouched(p);
  });

  it('rejects an empty password before erasing', async () => {
    const p = providers(true);
    await expect(
      Sphere.import({ ...common(p), mnemonic: OTHER_MNEMONIC, password: '', overwrite: true }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expectWalletUntouched(p);
  });

  it('rejects a master key the loader could not read back, instead of storing it', async () => {
    const p = providers(true);
    await expect(
      Sphere.import({ ...common(p), masterKey: 'zz-not-hex', overwrite: true }),
    ).rejects.toMatchObject({ code: 'INVALID_IDENTITY' });
    expectWalletUntouched(p);
    expect(p.storage._data.has(STORAGE_KEYS_GLOBAL.MASTER_KEY)).toBe(false);
  });

  it('rejects a malformed chain code before erasing', async () => {
    const p = providers(true);
    await expect(
      Sphere.import({ ...common(p), masterKey: VALID_HEX, chainCode: 'xyz', overwrite: true }),
    ).rejects.toMatchObject({ code: 'INVALID_IDENTITY' });
    expectWalletUntouched(p);
  });

  it('importFromJSON with an invalid mnemonic reports failure and keeps the wallet', async () => {
    const p = providers(true);
    // A well-formed backup (the format check passes) whose phrase is not valid BIP39.
    const jsonContent = JSON.stringify({ version: '1.0', type: 'sphere-wallet', mnemonic: 'not a real phrase at all', wallet: {} });
    const result = await Sphere.importFromJSON({ ...common(p), jsonContent, overwrite: true });
    expect(result.success).toBe(false);
    expectWalletUntouched(p);
  });

  it('replaces the wallet with overwrite: true and valid input', async () => {
    const p = providers(true);
    live = await Sphere.import({ ...common(p), mnemonic: OTHER_MNEMONIC, overwrite: true });
    expect(fullClears(p)).toBe(1);
    expect(p.storage._data.get(STORAGE_KEYS_GLOBAL.MNEMONIC)).toBe(OTHER_MNEMONIC);
  });

  it('imports into empty storage without overwrite', async () => {
    const p = providers(false);
    live = await Sphere.import({ ...common(p), mnemonic: OTHER_MNEMONIC });
    expect(fullClears(p)).toBe(0);
    expect(p.storage._data.get(STORAGE_KEYS_GLOBAL.MNEMONIC)).toBe(OTHER_MNEMONIC);
  });

  it('importFromJSON reports a wrong password that decrypts to garbage, and keeps the wallet', async () => {
    const p = providers(true);
    // OTHER_MNEMONIC encrypted with 'right-password'. CryptoJS has no MAC, and 'wrong-34'
    // decrypts this ciphertext to a 2-character string instead of throwing.
    const jsonContent = JSON.stringify({
      version: '1.0', type: 'sphere-wallet', encrypted: true, wallet: {},
      mnemonic: 'U2FsdGVkX18Vj01wyiL3v4L/OQpvF5LENkk1Wk7FjwFcnEn+MmdNJ54VOluRiIgCfvqplWIlqErro+V3J/kwODQ+qmhFpu8MyyOv9cnzt4KYTMLEU+FItqqDPMqGAkah',
    });
    const result = await Sphere.importFromJSON({ ...common(p), jsonContent, password: 'wrong-34', overwrite: true });
    expect(result).toMatchObject({ success: false, error: 'Failed to decrypt mnemonic - wrong password?' });
    expectWalletUntouched(p);
  });

  describe('a store that fails to open is never taken for an empty one', () => {
    /** connect() fails `failures` times, then succeeds: a blocked IndexedDB open, for example. */
    function flakyStore(failures: number): MockProviders {
      const p = providers(true);
      let connected = false;
      let left = failures;
      (p.storage.isConnected as Mock).mockImplementation(() => connected);
      (p.storage.connect as Mock).mockImplementation(async () => {
        if (left-- > 0) throw new Error('open timed out');
        connected = true;
      });
      (p.storage.disconnect as Mock).mockImplementation(async () => { connected = false; });
      return p;
    }

    it('import rejects instead of writing over the wallet', async () => {
      const p = flakyStore(1);
      await expect(Sphere.import({ ...common(p), mnemonic: OTHER_MNEMONIC })).rejects.toThrow('open timed out');
      expectWalletUntouched(p);
    });

    it('create rejects instead of writing over the wallet', async () => {
      const p = flakyStore(1);
      await expect(Sphere.create({ ...common(p), mnemonic: OTHER_MNEMONIC })).rejects.toThrow('open timed out');
      expectWalletUntouched(p);
    });

    it('init with autoGenerate rejects instead of generating a new seed over the wallet', async () => {
      const p = flakyStore(1);
      await expect(Sphere.init({ ...common(p), autoGenerate: true })).rejects.toThrow('open timed out');
      expectWalletUntouched(p);
    });
  });
});
