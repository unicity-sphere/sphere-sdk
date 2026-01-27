/**
 * Wallet.dat Parsing
 *
 * Parses Bitcoin Core wallet.dat files (SQLite format)
 * Extracts keys, chain codes, and descriptors
 */

import CryptoJS from 'crypto-js';
import type { LegacyFileParseResult, LegacyFileParsedData, DecryptionProgressCallback } from './types';
import { findPattern, base58Decode, isValidPrivateKey } from '../core/utils';
import { bytesToHex } from '../core/crypto';

// =============================================================================
// Utility Functions
// =============================================================================

function uint8ArrayToWordArray(u8arr: Uint8Array): CryptoJS.lib.WordArray {
  const hex = bytesToHex(u8arr);
  return CryptoJS.enc.Hex.parse(hex);
}

// =============================================================================
// Types
// =============================================================================

export interface CMasterKeyData {
  encryptedKey: Uint8Array;
  salt: Uint8Array;
  derivationMethod: number;
  iterations: number;
  position: number;
}

export interface WalletDatInfo {
  isSQLite: boolean;
  isEncrypted: boolean;
  isDescriptorWallet: boolean;
  hasHDChain: boolean;
  descriptorKeys: string[];
  legacyKeys: string[];
  chainCode: string | null;
  descriptorPath: string | null;
  cmasterKeys: CMasterKeyData[];
  descriptorId: Uint8Array | null;
  xpubString: string | null;
}

// =============================================================================
// Detection Functions
// =============================================================================

/**
 * Check if data is a valid SQLite database
 */
export function isSQLiteDatabase(data: Uint8Array): boolean {
  if (data.length < 16) return false;
  const header = new TextDecoder().decode(data.slice(0, 16));
  return header.startsWith('SQLite format 3');
}

/**
 * Check if wallet.dat is encrypted
 */
export function isWalletDatEncrypted(data: Uint8Array): boolean {
  const mkeyPattern = new TextEncoder().encode('mkey');
  return findPattern(data, mkeyPattern, 0) !== -1;
}

// =============================================================================
// CMasterKey Detection
// =============================================================================

function findAllCMasterKeys(data: Uint8Array): CMasterKeyData[] {
  const results: CMasterKeyData[] = [];

  for (let pos = 0; pos < data.length - 70; pos++) {
    if (data[pos] === 0x30) {
      const saltLenPos = pos + 1 + 48;
      if (saltLenPos < data.length && data[saltLenPos] === 0x08) {
        const iterPos = saltLenPos + 1 + 8 + 4;
        if (iterPos + 4 <= data.length) {
          const iterations = data[iterPos] | (data[iterPos + 1] << 8) |
                            (data[iterPos + 2] << 16) | (data[iterPos + 3] << 24);
          if (iterations >= 1000 && iterations <= 10000000) {
            const encryptedKey = data.slice(pos + 1, pos + 1 + 48);
            const salt = data.slice(saltLenPos + 1, saltLenPos + 1 + 8);
            const derivationMethod = data[saltLenPos + 1 + 8] | (data[saltLenPos + 1 + 8 + 1] << 8) |
                                    (data[saltLenPos + 1 + 8 + 2] << 16) | (data[saltLenPos + 1 + 8 + 3] << 24);

            results.push({ encryptedKey, salt, derivationMethod, iterations, position: pos });
          }
        }
      }
    }
  }

  return results;
}

// =============================================================================
// Descriptor Extraction
// =============================================================================

function findWpkhDescriptor(data: Uint8Array): {
  descriptorId: Uint8Array | null;
  xpubString: string | null;
  descriptorPath: string | null;
} {
  const descriptorPattern = new TextEncoder().encode('walletdescriptor');
  let descriptorIndex = 0;

  while ((descriptorIndex = findPattern(data, descriptorPattern, descriptorIndex)) !== -1) {
    let scanPos = descriptorIndex + descriptorPattern.length + 32;

    const descLen = data[scanPos];
    scanPos++;

    const descBytes = data.slice(scanPos, scanPos + Math.min(descLen, 200));
    let descStr = '';
    for (let i = 0; i < descBytes.length && descBytes[i] >= 32 && descBytes[i] <= 126; i++) {
      descStr += String.fromCharCode(descBytes[i]);
    }

    if (descStr.startsWith('wpkh(xpub') && descStr.includes('/0/*)')) {
      const xpubMatch = descStr.match(/xpub[1-9A-HJ-NP-Za-km-z]{100,}/);
      if (xpubMatch) {
        const descIdStart = descriptorIndex + descriptorPattern.length;
        const descriptorId = data.slice(descIdStart, descIdStart + 32);
        const pathMatch = descStr.match(/\[[\da-f]+\/(\d+'\/\d+'\/\d+')\]/);
        const descriptorPath = pathMatch ? pathMatch[1] : "84'/1'/0'";

        return {
          descriptorId,
          xpubString: xpubMatch[0],
          descriptorPath,
        };
      }
    }

    descriptorIndex++;
  }

  return { descriptorId: null, xpubString: null, descriptorPath: null };
}

function extractChainCodeFromXpub(xpubString: string): string {
  const decoded = base58Decode(xpubString);
  return bytesToHex(decoded.slice(13, 45));
}

function findMasterChainCode(data: Uint8Array): string | null {
  const xpubPattern = new TextEncoder().encode('xpub');
  const base58Chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let searchPos = 0;

  while (searchPos < data.length) {
    const xpubIndex = findPattern(data, xpubPattern, searchPos);
    if (xpubIndex === -1) break;

    let xpubStr = 'xpub';
    let pos = xpubIndex + 4;

    while (pos < data.length && xpubStr.length < 120) {
      const char = String.fromCharCode(data[pos]);
      if (base58Chars.includes(char)) {
        xpubStr += char;
        pos++;
      } else {
        break;
      }
    }

    if (xpubStr.length > 100) {
      try {
        const decoded = base58Decode(xpubStr);
        const depth = decoded[4];
        if (depth === 0) {
          return bytesToHex(decoded.slice(13, 45));
        }
      } catch {
        // Invalid xpub, continue
      }
    }

    searchPos = xpubIndex + 4;
  }

  return null;
}

// =============================================================================
// Key Extraction (Unencrypted)
// =============================================================================

function extractDescriptorKeys(data: Uint8Array): string[] {
  const keys: string[] = [];
  const descriptorKeyPattern = new TextEncoder().encode('walletdescriptorkey');

  let index = 0;
  while ((index = findPattern(data, descriptorKeyPattern, index)) !== -1) {
    for (let checkPos = index + descriptorKeyPattern.length;
         checkPos < Math.min(index + descriptorKeyPattern.length + 200, data.length - 40);
         checkPos++) {
      if (data[checkPos] === 0xd3 &&
          data[checkPos + 1] === 0x02 &&
          data[checkPos + 2] === 0x01 &&
          data[checkPos + 3] === 0x01 &&
          data[checkPos + 4] === 0x04 &&
          data[checkPos + 5] === 0x20) {
        const privKey = data.slice(checkPos + 6, checkPos + 38);
        const privKeyHex = bytesToHex(privKey);

        if (isValidPrivateKey(privKeyHex)) {
          keys.push(privKeyHex);
          break;
        }
      }
    }
    index++;
  }

  return keys;
}

function extractLegacyKeys(data: Uint8Array): string[] {
  const keys: string[] = [];
  const keyPattern = new TextEncoder().encode('key');

  let index = 0;
  while ((index = findPattern(data, keyPattern, index)) !== -1) {
    const searchPattern = new Uint8Array([0x04, 0x20]);
    for (let i = index; i < Math.min(index + 200, data.length - 34); i++) {
      if (data[i] === searchPattern[0] && data[i + 1] === searchPattern[1]) {
        const privKey = data.slice(i + 2, i + 34);
        const privKeyHex = bytesToHex(privKey);

        if (isValidPrivateKey(privKeyHex)) {
          keys.push(privKeyHex);
          break;
        }
      }
    }
    index++;
  }

  return keys;
}

// =============================================================================
// Encrypted Key Lookup
// =============================================================================

function findEncryptedKeyForDescriptor(
  data: Uint8Array,
  descriptorId: Uint8Array
): { pubkey: Uint8Array; encryptedKey: Uint8Array } | null {
  const ckeyPattern = new TextEncoder().encode('walletdescriptorckey');
  let ckeyIndex = findPattern(data, ckeyPattern, 0);

  while (ckeyIndex !== -1) {
    const recordDescId = data.slice(ckeyIndex + ckeyPattern.length, ckeyIndex + ckeyPattern.length + 32);

    if (Array.from(recordDescId).every((b, i) => b === descriptorId[i])) {
      let keyPos = ckeyIndex + ckeyPattern.length + 32;
      const pubkeyLen = data[keyPos];
      keyPos++;
      const pubkey = data.slice(keyPos, keyPos + pubkeyLen);

      for (let searchPos = keyPos + pubkeyLen;
           searchPos < Math.min(keyPos + pubkeyLen + 100, data.length - 50);
           searchPos++) {
        const valueLen = data[searchPos];
        if (valueLen >= 32 && valueLen <= 64) {
          const encryptedKey = data.slice(searchPos + 1, searchPos + 1 + valueLen);
          return { pubkey, encryptedKey };
        }
      }
    }

    ckeyIndex = findPattern(data, ckeyPattern, ckeyIndex + 1);
  }

  return null;
}

// =============================================================================
// Decryption Functions
// =============================================================================

/**
 * Decrypt master key from CMasterKey structure
 */
export async function decryptCMasterKey(
  cmk: CMasterKeyData,
  password: string,
  onProgress?: DecryptionProgressCallback
): Promise<string> {
  const { encryptedKey, salt, iterations } = cmk;

  const passwordHex = bytesToHex(new TextEncoder().encode(password));
  const saltHex = bytesToHex(salt);
  const inputHex = passwordHex + saltHex;

  let hash = CryptoJS.SHA512(CryptoJS.enc.Hex.parse(inputHex));

  const BATCH_SIZE = 1000;
  for (let i = 0; i < iterations - 1; i++) {
    hash = CryptoJS.SHA512(hash);
    if (onProgress && i % BATCH_SIZE === 0) {
      await onProgress(i, iterations);
    }
  }

  const derivedKey = CryptoJS.lib.WordArray.create(hash.words.slice(0, 8));
  const derivedIv = CryptoJS.lib.WordArray.create(hash.words.slice(8, 12));

  const encryptedWords = uint8ArrayToWordArray(encryptedKey);

  const decrypted = CryptoJS.AES.decrypt(
    { ciphertext: encryptedWords } as CryptoJS.lib.CipherParams,
    derivedKey,
    { iv: derivedIv, padding: CryptoJS.pad.Pkcs7, mode: CryptoJS.mode.CBC }
  );

  const result = CryptoJS.enc.Hex.stringify(decrypted);

  if (!result || result.length !== 64) {
    throw new Error('Master key decryption failed - incorrect password');
  }

  return result;
}

/**
 * Decrypt private key using decrypted master key
 */
export function decryptPrivateKey(
  encryptedKey: Uint8Array,
  pubkey: Uint8Array,
  masterKeyHex: string
): string {
  const pubkeyWords = uint8ArrayToWordArray(pubkey);
  const pubkeyHashWords = CryptoJS.SHA256(CryptoJS.SHA256(pubkeyWords));
  const ivWords = CryptoJS.lib.WordArray.create(pubkeyHashWords.words.slice(0, 4));

  const masterKeyWords = CryptoJS.enc.Hex.parse(masterKeyHex);
  const encryptedWords = uint8ArrayToWordArray(encryptedKey);

  const decrypted = CryptoJS.AES.decrypt(
    { ciphertext: encryptedWords } as CryptoJS.lib.CipherParams,
    masterKeyWords,
    { iv: ivWords, padding: CryptoJS.pad.Pkcs7, mode: CryptoJS.mode.CBC }
  );

  return CryptoJS.enc.Hex.stringify(decrypted);
}

// =============================================================================
// Main Parse Function
// =============================================================================

/**
 * Parse wallet.dat file
 * For encrypted wallets, returns info for decryption
 */
export function parseWalletDat(data: Uint8Array): LegacyFileParseResult {
  if (!isSQLiteDatabase(data)) {
    return {
      success: false,
      error: 'Invalid wallet.dat file - not an SQLite database',
    };
  }

  const isEncrypted = isWalletDatEncrypted(data);
  const cmasterKeys = isEncrypted ? findAllCMasterKeys(data) : [];
  const descriptorKeys = isEncrypted ? [] : extractDescriptorKeys(data);
  const legacyKeys = isEncrypted ? [] : extractLegacyKeys(data);

  // descriptorId is used in parseAndDecryptWalletDat for encrypted wallets
  const { descriptorId: _descriptorId, xpubString, descriptorPath } = findWpkhDescriptor(data);
  void _descriptorId; // Suppress unused warning

  let chainCode: string | null = null;
  if (xpubString) {
    try {
      chainCode = extractChainCodeFromXpub(xpubString);
    } catch {
      chainCode = findMasterChainCode(data);
    }
  } else {
    chainCode = findMasterChainCode(data);
  }

  // For unencrypted wallets
  if (!isEncrypted) {
    let masterKey: string | null = null;

    if (descriptorKeys.length > 0) {
      masterKey = descriptorKeys[0];
    } else if (legacyKeys.length > 0) {
      masterKey = legacyKeys[0];
    }

    if (masterKey) {
      const parsedData: LegacyFileParsedData = {
        masterKey,
        chainCode: chainCode ?? undefined,
        descriptorPath: descriptorPath ?? "84'/1'/0'",
        derivationMode: chainCode ? 'bip32' : 'wif_hmac',
      };

      return {
        success: true,
        data: parsedData,
      };
    }

    return {
      success: false,
      error: 'No valid private keys found in wallet.dat file',
    };
  }

  // For encrypted wallets
  if (cmasterKeys.length === 0) {
    return {
      success: false,
      error: 'Encrypted wallet but no CMasterKey structures found',
    };
  }

  // Return encryption info for decryption
  const firstCmk = cmasterKeys[0];
  return {
    success: false,
    needsPassword: true,
    encryptionInfo: {
      iterations: firstCmk.iterations,
      salt: firstCmk.salt,
      encryptedKey: firstCmk.encryptedKey,
    },
    error: 'Password required for encrypted wallet',
  };
}

/**
 * Parse and decrypt wallet.dat file
 */
export async function parseAndDecryptWalletDat(
  data: Uint8Array,
  password: string,
  onProgress?: DecryptionProgressCallback
): Promise<LegacyFileParseResult> {
  if (!isSQLiteDatabase(data)) {
    return {
      success: false,
      error: 'Invalid wallet.dat file - not an SQLite database',
    };
  }

  const isEncrypted = isWalletDatEncrypted(data);

  if (!isEncrypted) {
    // Not encrypted, parse directly
    return parseWalletDat(data);
  }

  const cmasterKeys = findAllCMasterKeys(data);
  if (cmasterKeys.length === 0) {
    return {
      success: false,
      error: 'Encrypted wallet but no CMasterKey structures found',
    };
  }

  // Try to decrypt each CMasterKey
  let masterKeyHex: string | null = null;
  for (const cmk of cmasterKeys) {
    try {
      masterKeyHex = await decryptCMasterKey(cmk, password, onProgress);
      if (masterKeyHex && masterKeyHex.length === 64) {
        break;
      }
    } catch {
      continue;
    }
  }

  if (!masterKeyHex || masterKeyHex.length !== 64) {
    return {
      success: false,
      error: 'Master key decryption failed - incorrect password',
    };
  }

  // Find descriptor info
  const { descriptorId, xpubString, descriptorPath } = findWpkhDescriptor(data);

  let chainCode: string | null = null;
  if (xpubString) {
    try {
      chainCode = extractChainCodeFromXpub(xpubString);
    } catch {
      chainCode = findMasterChainCode(data);
    }
  } else {
    chainCode = findMasterChainCode(data);
  }

  // Find and decrypt BIP32 master private key
  if (!descriptorId) {
    return {
      success: false,
      error: 'Could not find native SegWit receive descriptor',
    };
  }

  const encryptedKeyData = findEncryptedKeyForDescriptor(data, descriptorId);
  if (!encryptedKeyData) {
    return {
      success: false,
      error: 'Could not find encrypted private key for descriptor',
    };
  }

  const bip32MasterKey = decryptPrivateKey(
    encryptedKeyData.encryptedKey,
    encryptedKeyData.pubkey,
    masterKeyHex
  );

  if (!bip32MasterKey || bip32MasterKey.length !== 64) {
    return {
      success: false,
      error: 'Could not decrypt BIP32 master private key',
    };
  }

  const parsedData: LegacyFileParsedData = {
    masterKey: bip32MasterKey,
    chainCode: chainCode ?? undefined,
    descriptorPath: descriptorPath ?? "84'/1'/0'",
    derivationMode: 'bip32',
  };

  return {
    success: true,
    data: parsedData,
  };
}
