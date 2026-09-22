/**
 * #811: `FileStorageProvider` keeps the whole store as an in-memory snapshot that only
 * `connect()` fills, and `save()` rewrites the ENTIRE file from it. Used before connect,
 * it wrote that empty snapshot over an existing `wallet.json` — one `set()` left a
 * single-key file and a bare `disconnect()` left `{}`, taking the seed and every
 * `pv2g2:*` journal with it. Reads were wrong the other way: `get('mnemonic')` answered
 * `null` for a wallet that was on disk, which is the "storage looks empty" signal #801
 * hardened `Sphere.init` against.
 *
 * Every data method now loads the file first, so an unconnected provider reads and
 * writes the real store instead of an empty one. Calling `connect()` explicitly stays
 * the normal path — this is the safety net under it.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileStorageProvider } from '../../../../impl/nodejs/storage/FileStorageProvider';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SEEDED = {
  mnemonic: MNEMONIC,
  master_key: 'a'.repeat(64),
  'pv2g2:testnet2:02ab:delivery-journal': '{"entries":[]}',
};

describe('FileStorageProvider used before connect() (#811)', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-fsp-guard-'));
    file = path.join(dir, 'wallet.json');
    fs.writeFileSync(file, JSON.stringify(SEEDED));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const onDisk = () => JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, string>;

  it('a write keeps every key already in the file instead of replacing it', async () => {
    const p = new FileStorageProvider({ dataDir: dir });

    await p.set('tracked_addresses', '[]');

    expect(onDisk()).toEqual({ ...SEEDED, tracked_addresses: '[]' });
  });

  it('a bare disconnect() does not empty the file', async () => {
    const p = new FileStorageProvider({ dataDir: dir });

    await p.disconnect();

    expect(onDisk()).toEqual(SEEDED);
  });

  it('reads answer from the file, so a stored wallet is never reported as missing', async () => {
    const p = new FileStorageProvider({ dataDir: dir });

    expect(await p.get('mnemonic')).toBe(MNEMONIC);
    expect(await p.has('master_key')).toBe(true);
    expect(await p.keys()).toContain('mnemonic');
  });

  it('remove() and a prefix clear() touch only what they name', async () => {
    const p = new FileStorageProvider({ dataDir: dir });

    await p.remove('master_key');
    await p.clear('pv2g2:');

    expect(onDisk()).toEqual({ mnemonic: MNEMONIC });
  });

  it('concurrent first calls load the file once and none of them loses a write', async () => {
    const p = new FileStorageProvider({ dataDir: dir });

    await Promise.all([
      p.set('a', '1'),
      p.set('b', '2'),
      p.get('mnemonic'),
      p.has('master_key'),
    ]);

    expect(onDisk()).toEqual({ ...SEEDED, a: '1', b: '2' });
  });

  it('an explicit clear() still empties the store', async () => {
    const p = new FileStorageProvider({ dataDir: dir });

    await p.clear();

    expect(onDisk()).toEqual({});
  });

  it('still works on a directory that holds no wallet yet', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-fsp-empty-'));
    try {
      const p = new FileStorageProvider({ dataDir: empty });

      await p.set('mnemonic', MNEMONIC);

      expect(JSON.parse(fs.readFileSync(path.join(empty, 'wallet.json'), 'utf-8'))).toEqual({
        mnemonic: MNEMONIC,
      });
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('a reconnect after disconnect reads the file again', async () => {
    const p = new FileStorageProvider({ dataDir: dir });
    await p.connect();
    await p.disconnect();

    expect(await p.get('mnemonic')).toBe(MNEMONIC);
  });
});
