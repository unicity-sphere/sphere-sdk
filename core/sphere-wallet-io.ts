/**
 * Sphere wallet I/O — Wave 6-P2-8 extraction from `core/Sphere.ts`.
 *
 * Serializes the wallet to / deserializes the wallet from external formats:
 *   - Native JSON (v1.0 `sphere-wallet`).
 *   - Text backup (`UNICITY WALLET DETAILS`).
 *   - Bitcoin Core `.dat` (SQLite).
 *   - Legacy web-wallet flat JSON.
 *
 * The extraction is behavior-preserving: bodies are moved verbatim from
 * `Sphere.exportToJSON` / `exportToTxt` / `importFromJSON` /
 * `importFromLegacyFile` / `detectLegacyFileType` /
 * `isLegacyFileEncrypted`. The Sphere class keeps thin one-line
 * delegators.
 *
 * Instance-side helpers (`exportToJSON`, `exportToTxt`) take a
 * `WalletIoInstanceHost` — an interface that exposes the Sphere private
 * fields these functions actually read. Static helpers take the plain
 * option object.
 */

import type { DerivationMode, WalletJSON, WalletJSONExportOptions } from '../types';
import type { MasterKey } from './crypto';
import { publicKeyToAddress, type AddressInfo } from './crypto';
import { SphereError } from './errors';
import { encryptSimple, decryptSimple, decryptWithSalt } from './encryption';
import {
  parseWalletText,
  parseAndDecryptWalletText,
  isTextWalletEncrypted,
  isWalletTextFormat,
  serializeWalletToText,
  serializeEncryptedWalletToText,
  encryptForTextFormat,
} from '../serialization/wallet-text';
import {
  parseWalletDat,
  parseAndDecryptWalletDat,
  isSQLiteDatabase,
  isWalletDatEncrypted,
} from '../serialization/wallet-dat';
import type {
  LegacyFileType,
  DecryptionProgressCallback,
} from '../serialization/types';
import { DEFAULT_BASE_PATH } from '../constants';

/**
 * Instance host shim used by `exportToJSON` / `exportToTxt`. Mirrors the
 * fields that were reached for on `this` in the Sphere class.
 */
export interface WalletIoInstanceHost {
  readonly _masterKey: MasterKey | null;
  readonly _identity: { chainPubkey: string } | null;
  readonly _mnemonic: string | null;
  readonly _source: string;
  readonly _derivationMode: DerivationMode;
  readonly _basePath: string;
  ensureReady(): void;
  deriveAddress(index: number, isChange?: boolean): AddressInfo;
  getDefaultAddressPath(): string;
}

/**
 * Static import type param — a minimal reference back to the Sphere
 * class, so import helpers can call `Sphere.import`, `Sphere.validateMnemonic`,
 * and `Sphere.getInstance` without importing Sphere itself (which would
 * create a circular import).
 */
export interface WalletIoSphereRef<TSphere> {
  import(options: any): Promise<TSphere>;
  importFromJSON(options: any): Promise<{ success: boolean; mnemonic?: string; error?: string }>;
  validateMnemonic(mnemonic: string): boolean;
  getInstance(): TSphere | null;
}

/**
 * Export wallet to JSON format for backup.
 *
 * Behavior-preserving move of `Sphere.exportToJSON`.
 */
export function exportToJSON(
  host: WalletIoInstanceHost,
  options: WalletJSONExportOptions = {},
): WalletJSON {
  host.ensureReady();

  if (!host._masterKey && !host._identity) {
    throw new SphereError('Wallet not initialized', 'NOT_INITIALIZED');
  }

  // Build addresses array
  const addressCount = options.addressCount || 1;
  const addresses: Array<{
    address: string;
    publicKey: string;
    path: string;
    index: number;
  }> = [];

  for (let i = 0; i < addressCount; i++) {
    try {
      const addr = host.deriveAddress(i, false);
      addresses.push({
        address: addr.address,
        publicKey: addr.publicKey,
        path: addr.path,
        index: addr.index,
      });
    } catch {
      // Stop if we can't derive more addresses (e.g., no masterKey)
      if (i === 0 && host._identity) {
        addresses.push({
          address: publicKeyToAddress(host._identity.chainPubkey, 'alpha'),
          publicKey: host._identity.chainPubkey,
          path: host.getDefaultAddressPath(),
          index: 0,
        });
      }
      break;
    }
  }

  // Build wallet data
  let masterPrivateKey: string | undefined;
  let chainCode: string | undefined;

  if (host._masterKey) {
    masterPrivateKey = host._masterKey.privateKey;
    chainCode = host._masterKey.chainCode || undefined;
  }

  // Prepare mnemonic (optionally encrypt)
  let mnemonic: string | undefined;
  let encrypted = false;

  if (host._mnemonic && options.includeMnemonic !== false) {
    if (options.password) {
      mnemonic = encryptSimple(host._mnemonic, options.password);
      encrypted = true;
    } else {
      mnemonic = host._mnemonic;
    }
  }

  // Encrypt master key if password provided
  if (masterPrivateKey && options.password) {
    masterPrivateKey = encryptSimple(masterPrivateKey, options.password);
    encrypted = true;
  }

  return {
    version: '1.0',
    type: 'sphere-wallet',
    createdAt: new Date().toISOString(),
    wallet: {
      masterPrivateKey,
      chainCode,
      addresses,
      isBIP32: host._derivationMode === 'bip32',
      descriptorPath: host._basePath.replace(/^m\//, ''),
    },
    mnemonic,
    encrypted,
    source: host._source as WalletJSON['source'],
    derivationMode: host._derivationMode,
  };
}

/**
 * Export wallet to text format for backup.
 *
 * Behavior-preserving move of `Sphere.exportToTxt`.
 */
export function exportToTxt(
  host: WalletIoInstanceHost,
  options: { password?: string; addressCount?: number } = {},
): string {
  host.ensureReady();

  if (!host._masterKey && !host._identity) {
    throw new SphereError('Wallet not initialized', 'NOT_INITIALIZED');
  }

  // Build addresses array
  const addressCount = options.addressCount || 1;
  const addresses: Array<{
    index: number;
    address: string;
    path: string;
    isChange: boolean;
  }> = [];

  for (let i = 0; i < addressCount; i++) {
    try {
      const addr = host.deriveAddress(i, false);
      addresses.push({
        address: addr.address,
        path: addr.path,
        index: addr.index,
        isChange: false,
      });
    } catch {
      // Stop if we can't derive more addresses
      if (i === 0 && host._identity) {
        addresses.push({
          address: publicKeyToAddress(host._identity.chainPubkey, 'alpha'),
          path: host.getDefaultAddressPath(),
          index: 0,
          isChange: false,
        });
      }
      break;
    }
  }

  const masterPrivateKey = host._masterKey?.privateKey || '';
  const chainCode = host._masterKey?.chainCode || undefined;
  const isBIP32 = host._derivationMode === 'bip32';
  const descriptorPath = host._basePath.replace(/^m\//, '');

  // If password provided, encrypt
  if (options.password) {
    const encryptedMasterKey = encryptForTextFormat(masterPrivateKey, options.password);
    return serializeEncryptedWalletToText({
      encryptedMasterKey,
      chainCode,
      descriptorPath,
      isBIP32,
      addresses,
    });
  }

  // Unencrypted export
  return serializeWalletToText({
    masterPrivateKey,
    chainCode,
    descriptorPath,
    isBIP32,
    addresses,
  });
}

/**
 * Import wallet from JSON backup.
 *
 * Behavior-preserving move of `Sphere.importFromJSON` (static).
 */
export async function importFromJSON<TSphere>(
  sphereRef: WalletIoSphereRef<TSphere>,
  options: {
    jsonContent: string;
    password?: string;
    [k: string]: unknown;
  },
): Promise<{ success: boolean; mnemonic?: string; error?: string }> {
  const { jsonContent, password, ...baseOptions } = options;

  try {
    const data = JSON.parse(jsonContent) as WalletJSON;

    if (data.version !== '1.0' || data.type !== 'sphere-wallet') {
      return { success: false, error: 'Invalid wallet format' };
    }

    // Decrypt if needed
    let mnemonic = data.mnemonic;
    let masterKey = data.wallet.masterPrivateKey;

    if (data.encrypted && password) {
      if (mnemonic) {
        const decrypted = decryptSimple(mnemonic, password);
        if (!decrypted) {
          return { success: false, error: 'Failed to decrypt mnemonic - wrong password?' };
        }
        mnemonic = decrypted;
      }
      if (masterKey) {
        const decrypted = decryptSimple(masterKey, password);
        if (!decrypted) {
          return { success: false, error: 'Failed to decrypt master key - wrong password?' };
        }
        masterKey = decrypted;
      }
    } else if (data.encrypted && !password) {
      return { success: false, error: 'Password required for encrypted wallet' };
    }

    // Determine base path
    const basePath = data.wallet.descriptorPath
      ? `m/${data.wallet.descriptorPath}`
      : DEFAULT_BASE_PATH;

    // Import using mnemonic if available (preferred)
    if (mnemonic) {
      await sphereRef.import({ ...baseOptions, mnemonic, basePath });
      return { success: true, mnemonic };
    }

    // Otherwise import using master key
    if (masterKey) {
      await sphereRef.import({
        ...baseOptions,
        masterKey,
        chainCode: data.wallet.chainCode,
        basePath,
        derivationMode: data.derivationMode || (data.wallet.isBIP32 ? 'bip32' : 'wif_hmac'),
      });
      return { success: true };
    }

    return { success: false, error: 'No mnemonic or master key in wallet data' };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : 'Failed to parse wallet JSON',
    };
  }
}

/**
 * Import wallet from legacy file (.dat, .txt, .json, or mnemonic text).
 *
 * Behavior-preserving move of `Sphere.importFromLegacyFile` (static).
 */
export async function importFromLegacyFile<TSphere>(
  sphereRef: WalletIoSphereRef<TSphere>,
  options: {
    fileContent: string | Uint8Array;
    fileName: string;
    password?: string;
    onDecryptProgress?: DecryptionProgressCallback;
    [k: string]: unknown;
  },
): Promise<{
  success: boolean;
  sphere?: TSphere;
  mnemonic?: string;
  needsPassword?: boolean;
  error?: string;
}> {
  const { fileContent, fileName, password, onDecryptProgress, ...baseOptions } = options;

  // Detect file type
  const fileType = detectLegacyFileType(fileName, fileContent);

  if (fileType === 'unknown') {
    return { success: false, error: 'Unknown file format' };
  }

  // Handle mnemonic text
  if (fileType === 'mnemonic') {
    const mnemonic = (fileContent as string).trim().toLowerCase().split(/\s+/).join(' ');
    if (!sphereRef.validateMnemonic(mnemonic)) {
      return { success: false, error: 'Invalid mnemonic phrase' };
    }

    const sphere = await sphereRef.import({ ...baseOptions, mnemonic });
    return { success: true, sphere, mnemonic };
  }

  // Handle .dat file
  if (fileType === 'dat') {
    const data = fileContent instanceof Uint8Array
      ? fileContent
      : new TextEncoder().encode(fileContent);

    let parseResult;

    if (password) {
      parseResult = await parseAndDecryptWalletDat(data, password, onDecryptProgress);
    } else {
      parseResult = parseWalletDat(data);
    }

    if (parseResult.needsPassword && !password) {
      return { success: false, needsPassword: true, error: 'Password required for encrypted wallet' };
    }

    if (!parseResult.success || !parseResult.data) {
      return { success: false, error: parseResult.error };
    }

    const { masterKey, chainCode, descriptorPath, derivationMode } = parseResult.data;
    const basePath = descriptorPath ? `m/${descriptorPath}` : DEFAULT_BASE_PATH;

    const sphere = await sphereRef.import({
      ...baseOptions,
      masterKey,
      chainCode,
      basePath,
      derivationMode: derivationMode || (chainCode ? 'bip32' : 'wif_hmac'),
    });

    return { success: true, sphere };
  }

  // Handle .txt file
  if (fileType === 'txt') {
    const content = typeof fileContent === 'string'
      ? fileContent
      : new TextDecoder().decode(fileContent);

    let parseResult;

    if (password) {
      parseResult = parseAndDecryptWalletText(content, password);
    } else if (isTextWalletEncrypted(content)) {
      return { success: false, needsPassword: true, error: 'Password required for encrypted wallet' };
    } else {
      parseResult = parseWalletText(content);
    }

    if (parseResult.needsPassword && !password) {
      return { success: false, needsPassword: true, error: 'Password required for encrypted wallet' };
    }

    if (!parseResult.success || !parseResult.data) {
      return { success: false, error: parseResult.error };
    }

    const { masterKey, chainCode, descriptorPath, derivationMode } = parseResult.data;
    const basePath = descriptorPath ? `m/${descriptorPath}` : DEFAULT_BASE_PATH;

    const sphere = await sphereRef.import({
      ...baseOptions,
      masterKey,
      chainCode,
      basePath,
      derivationMode: derivationMode || (chainCode ? 'bip32' : 'wif_hmac'),
    });

    return { success: true, sphere };
  }

  // Handle JSON
  if (fileType === 'json') {
    const content = typeof fileContent === 'string'
      ? fileContent
      : new TextDecoder().decode(fileContent);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { success: false, error: 'Invalid JSON file' };
    }

    // sphere-wallet format — delegate to importFromJSON
    if (parsed.type === 'sphere-wallet') {
      const result = await sphereRef.importFromJSON({
        ...baseOptions,
        jsonContent: content,
        password,
      });

      if (result.success) {
        const sphere = sphereRef.getInstance();
        return { success: true, sphere: sphere!, mnemonic: result.mnemonic };
      }

      if (!password && result.error?.includes('Password required')) {
        return { success: false, needsPassword: true, error: result.error };
      }

      return { success: false, error: result.error };
    }

    // Legacy flat JSON format (webwallet export)
    let masterKey: string | undefined;
    let mnemonic: string | undefined;

    if (parsed.encrypted && typeof parsed.encrypted === 'object') {
      // Encrypted legacy JSON — needs password + salt-based PBKDF2 decryption
      if (!password) {
        return { success: false, needsPassword: true, error: 'Password required for encrypted wallet' };
      }
      const enc = parsed.encrypted as { masterPrivateKey?: string; mnemonic?: string; salt?: string };
      if (!enc.salt || !enc.masterPrivateKey) {
        return { success: false, error: 'Invalid encrypted wallet format' };
      }
      const decryptedKey = decryptWithSalt(enc.masterPrivateKey, password, enc.salt);
      if (!decryptedKey) {
        return { success: false, error: 'Failed to decrypt - incorrect password?' };
      }
      masterKey = decryptedKey;
      if (enc.mnemonic) {
        mnemonic = decryptWithSalt(enc.mnemonic, password, enc.salt) ?? undefined;
      }
    } else {
      // Unencrypted legacy JSON
      masterKey = parsed.masterPrivateKey as string | undefined;
      mnemonic = parsed.mnemonic as string | undefined;
    }

    if (!masterKey) {
      return { success: false, error: 'No master key found in wallet JSON' };
    }

    const chainCode = parsed.chainCode as string | undefined;
    const descriptorPath = parsed.descriptorPath as string | undefined;
    const derivationMode = (parsed.derivationMode as string | undefined);
    const isBIP32 = derivationMode === 'bip32' || !!chainCode;
    const basePath = descriptorPath
      ? `m/${descriptorPath}`
      : (isBIP32 ? "m/84'/1'/0'" : DEFAULT_BASE_PATH);

    if (mnemonic) {
      const sphere = await sphereRef.import({ ...baseOptions, mnemonic, basePath });
      return { success: true, sphere, mnemonic };
    }

    const sphere = await sphereRef.import({
      ...baseOptions,
      masterKey,
      chainCode,
      basePath,
      derivationMode: (derivationMode as DerivationMode) || (chainCode ? 'bip32' : 'wif_hmac'),
    });
    return { success: true, sphere };
  }

  return { success: false, error: 'Unsupported file type' };
}

/**
 * Detect legacy file type from filename and content.
 *
 * Behavior-preserving move of `Sphere.detectLegacyFileType` (static).
 */
export function detectLegacyFileType(
  fileName: string,
  content: string | Uint8Array,
): LegacyFileType {
  // .dat files are binary
  if (fileName.endsWith('.dat')) {
    return 'dat';
  }

  // Check content for type detection
  const textContent = typeof content === 'string'
    ? content
    : (content.length < 1000 ? new TextDecoder().decode(content) : '');

  // Check for JSON
  if (fileName.endsWith('.json')) {
    return 'json';
  }

  try {
    const trimmed = textContent.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      JSON.parse(trimmed);
      return 'json';
    }
  } catch {
    // Not JSON
  }

  // Check for mnemonic (12 or 24 words)
  const words = textContent.trim().split(/\s+/);
  if (
    (words.length === 12 || words.length === 24) &&
    words.every((w) => /^[a-z]+$/.test(w.toLowerCase()))
  ) {
    return 'mnemonic';
  }

  // Check for text wallet format
  if (isWalletTextFormat(textContent)) {
    return 'txt';
  }

  // Check for SQLite (binary .dat)
  if (content instanceof Uint8Array && isSQLiteDatabase(content)) {
    return 'dat';
  }

  return 'unknown';
}

/**
 * Check if a legacy file is encrypted.
 *
 * Behavior-preserving move of `Sphere.isLegacyFileEncrypted` (static).
 */
export function isLegacyFileEncrypted(
  fileName: string,
  content: string | Uint8Array,
): boolean {
  const fileType = detectLegacyFileType(fileName, content);

  if (fileType === 'dat' && content instanceof Uint8Array) {
    return isWalletDatEncrypted(content);
  }

  if (fileType === 'txt') {
    const textContent = typeof content === 'string'
      ? content
      : new TextDecoder().decode(content);
    return isTextWalletEncrypted(textContent);
  }

  if (fileType === 'json') {
    try {
      const textContent = typeof content === 'string'
        ? content
        : new TextDecoder().decode(content);
      const data = JSON.parse(textContent);
      return !!data.encrypted;
    } catch {
      return false;
    }
  }

  return false;
}
