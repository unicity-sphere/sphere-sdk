/**
 * listWallets(): the wallets kept side by side in one Node data directory (#801).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listWallets } from '../../../../impl/nodejs/storage/list-wallets';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const MASTER_KEY = 'b'.repeat(64);
/** A CryptoJS passphrase-mode ciphertext, as a password-protected wallet stores it. */
const CIPHERTEXT = 'U2FsdGVkX1+0123456789abcdefghijklmnopqrstuvw==';

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

    const wallets = await listWallets(dir);

    expect(wallets.map((w) => [w.fileName, w.passwordProtected])).toEqual([
      ['bot-b.json', false],
      ['locked.json', true],
      ['phrase.txt', false],
      ['wallet.json', false],
    ]);
    expect(wallets[0].filePath).toBe(path.join(path.resolve(dir), 'bot-b.json'));
  });

  it('skips files that hold no wallet', async () => {
    write('settings.json', JSON.stringify({ theme: 'dark' }));
    write('broken.json', '{ not json');
    write('empty.txt', '   ');
    write('wallet.json.tmp', JSON.stringify({ mnemonic: MNEMONIC }));
    write('notes.md', MNEMONIC);
    fs.mkdirSync(path.join(dir, 'nested.json'));

    expect(await listWallets(dir)).toEqual([]);
  });

  it('returns an empty list for a directory that does not exist', async () => {
    expect(await listWallets(path.join(dir, 'missing'))).toEqual([]);
  });
});
