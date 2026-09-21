/**
 * listWallets(): the wallets kept side by side in one Node data directory (#801).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ENCRYPTION_KEY } from '../../../../constants';
import { encryptSimple } from '../../../../core/encryption';
import { FileStorageProvider } from '../../../../impl/nodejs/storage/FileStorageProvider';
import { listWallets } from '../../../../impl/nodejs/storage/list-wallets';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const MASTER_KEY = 'b'.repeat(64);
/** How a password-protected wallet stores its seed (Sphere.encrypt → encryptSimple). */
const CIPHERTEXT = encryptSimple(MNEMONIC, 'user-password');

describe('listWallets (#801)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-list-wallets-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, content: string) => fs.writeFileSync(path.join(dir, name), content);

  it('lists every wallet file, sorted, and marks password-protected ones', async () => {
    write('wallet.json', JSON.stringify({ mnemonic: MNEMONIC, wallet_exists: 'true' }));
    write('bot-b.json', JSON.stringify({ master_key: MASTER_KEY }));
    write('locked.json', JSON.stringify({ mnemonic: CIPHERTEXT }));
    write('phrase.txt', `${MNEMONIC}\n`);
    write('locked.txt', CIPHERTEXT);

    const wallets = await listWallets(dir);

    expect(wallets.map((w) => [w.fileName, w.passwordProtected])).toEqual([
      ['bot-b.json', false],
      ['locked.json', true],
      ['locked.txt', true],
      ['phrase.txt', false],
      ['wallet.json', false],
    ]);
    expect(wallets[0].filePath).toBe(path.join(path.resolve(dir), 'bot-b.json'));
  });

  it('does not mark a seed under the legacy default key (SDK <= 0.3.3) as password-protected', async () => {
    // Sphere.load() opens it only WITHOUT a password, through decrypt()'s fallback.
    write('old.json', JSON.stringify({ mnemonic: encryptSimple(MNEMONIC, DEFAULT_ENCRYPTION_KEY) }));
    expect(await listWallets(dir)).toMatchObject([{ fileName: 'old.json', passwordProtected: false }]);
  });

  it('skips files that hold no wallet store', async () => {
    write('settings.json', JSON.stringify({ theme: 'dark' }));
    write('broken.json', '{ not json');
    write('empty.txt', '   ');
    write('notes.txt', 'remember to top up the bot');
    // An exportToJSON() backup carries `mnemonic` too, but opening it as a wallet file
    // would let FileStorageProvider rewrite it.
    write('import-wallet.json', JSON.stringify({ version: '1.0', type: 'sphere-wallet', mnemonic: MNEMONIC, wallet: {} }));
    write('wallet.json.tmp', JSON.stringify({ mnemonic: MNEMONIC }));
    write('notes.md', MNEMONIC);
    fs.mkdirSync(path.join(dir, 'nested.json'));

    expect(await listWallets(dir)).toEqual([]);
  });

  it('a listed fileName opens that wallet as walletFileName', async () => {
    write('second.json', JSON.stringify({ mnemonic: MNEMONIC }));
    const [listed] = await listWallets(dir);

    const storage = new FileStorageProvider({ dataDir: dir, fileName: listed.fileName });
    await storage.connect();
    expect(await storage.get('mnemonic')).toBe(MNEMONIC);
    await storage.disconnect();
  });

  it('returns an empty list for a directory that does not exist', async () => {
    expect(await listWallets(path.join(dir, 'missing'))).toEqual([]);
  });
});
