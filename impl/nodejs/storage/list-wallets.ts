/** Wallets kept side by side in one Node data directory, one per `walletFileName` (#801). */

import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_ENCRYPTION_KEY, STORAGE_KEYS_GLOBAL } from '../../../constants';
import { validateMnemonic } from '../../../core/crypto';
import { decryptSimple } from '../../../core/encryption';

export interface NodeWalletFile {
  /** Pass as `walletFileName` to `createNodeProviders()` to open this wallet. */
  fileName: string;
  filePath: string;
  /** Opening this wallet needs its `password`: `Sphere.load()` cannot read the seed without one. */
  passwordProtected: boolean;
}

const WALLET_FILE = /\.(json|txt)$/i;
const PLAINTEXT_KEY = /^[0-9a-f]{64}$/i;
// CryptoJS passphrase output (encryptSimple): base64 of "Salted__" + salt + ciphertext.
const PASSPHRASE_CIPHERTEXT = /^U2FsdGVkX1[0-9A-Za-z+/=]+$/;

function readStoredSecret(filePath: string, content: string): string | null {
  if (/\.txt$/i.test(filePath)) {
    return validateMnemonic(content) || PASSPHRASE_CIPHERTEXT.test(content) ? content : null;
  }
  let record: unknown;
  try {
    record = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof record !== 'object' || record === null) return null;
  const fields = record as Record<string, unknown>;
  // Backups carry `mnemonic` too, but they are not wallet stores: exportToJSON() files, and the
  // legacy flat exports importFromLegacyFile() reads (camelCase keys a store never has).
  if (fields.type === 'sphere-wallet') return null;
  if ('masterPrivateKey' in fields || 'descriptorPath' in fields || 'encrypted' in fields) return null;
  for (const key of [STORAGE_KEYS_GLOBAL.MNEMONIC, STORAGE_KEYS_GLOBAL.MASTER_KEY]) {
    const value = fields[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/** Mirrors Sphere's password-less decrypt(), including the legacy default key (SDK <= 0.3.3). */
function opensWithoutPassword(secret: string): boolean {
  if (validateMnemonic(secret) || PLAINTEXT_KEY.test(secret)) return true;
  try {
    const legacy = decryptSimple(secret, DEFAULT_ENCRYPTION_KEY);
    return validateMnemonic(legacy) || PLAINTEXT_KEY.test(legacy);
  } catch {
    return false;
  }
}

/** `*.json`/`*.txt` wallet stores in `dataDir`, sorted by name; `exportToJSON()` backups are skipped. */
export async function listWallets(dataDir: string): Promise<NodeWalletFile[]> {
  const dir = path.resolve(dataDir);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const wallets: NodeWalletFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !WALLET_FILE.test(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    const secret = readStoredSecret(filePath, (await fs.promises.readFile(filePath, 'utf-8')).trim());
    if (secret === null) continue;
    wallets.push({ fileName: entry.name, filePath, passwordProtected: !opensWithoutPassword(secret) });
  }
  return wallets.sort((a, b) => a.fileName.localeCompare(b.fileName));
}
