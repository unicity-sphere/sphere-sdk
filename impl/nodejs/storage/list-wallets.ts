/**
 * The wallets kept side by side in one Node data directory (#801): one per
 * `walletFileName` of `createNodeProviders()`. Import a new wallet under another
 * file name instead of over the current one, then let the user pick from this list.
 */

import * as fs from 'fs';
import * as path from 'path';
import { STORAGE_KEYS_GLOBAL } from '../../../constants';
import { validateMnemonic } from '../../../core/crypto';

export interface NodeWalletFile {
  /** Pass as `walletFileName` to `createNodeProviders()` to open this wallet. */
  fileName: string;
  filePath: string;
  /** The seed is stored encrypted: opening it needs the wallet's `password`. */
  passwordProtected: boolean;
}

const WALLET_FILE = /\.(json|txt)$/;
const PLAINTEXT_KEY = /^[0-9a-f]{64}$/i;

function readStoredSecret(filePath: string, content: string): string | null {
  if (filePath.endsWith('.txt')) return content || null;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof record !== 'object' || record === null) return null;
  for (const key of [STORAGE_KEYS_GLOBAL.MNEMONIC, STORAGE_KEYS_GLOBAL.MASTER_KEY]) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/** Wallet files in `dataDir` (the test `Sphere.exists()` applies), sorted by name. */
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
    const passwordProtected = !(validateMnemonic(secret) || PLAINTEXT_KEY.test(secret));
    wallets.push({ fileName: entry.name, filePath, passwordProtected });
  }
  return wallets.sort((a, b) => a.fileName.localeCompare(b.fileName));
}
