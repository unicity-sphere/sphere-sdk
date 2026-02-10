/**
 * Wallet Text Format Parsing
 *
 * Parses text-based wallet backup files (UNICITY WALLET DETAILS format)
 */

import CryptoJS from 'crypto-js';
import type { LegacyFileParseResult, LegacyFileParsedData } from './types';
import { extractFromText } from '../core/utils';

// =============================================================================
// Constants
// =============================================================================

const WALLET_HEADER = 'UNICITY WALLET DETAILS';

// Legacy webwallet encryption parameters (for backwards compatibility)
const LEGACY_SALT = 'alpha_wallet_salt';
const LEGACY_ITERATIONS = 100000;

// =============================================================================
// Encryption/Decryption
// =============================================================================

/**
 * Derive encryption key using original webwallet parameters
 */
function deriveLegacyKey(password: string): string {
  return CryptoJS.PBKDF2(password, LEGACY_SALT, {
    keySize: 256 / 32,
    iterations: LEGACY_ITERATIONS,
    hasher: CryptoJS.algo.SHA1,
  }).toString();
}

/**
 * Decrypt master key from text format
 */
export function decryptTextFormatKey(encryptedKey: string, password: string): string | null {
  try {
    const key = deriveLegacyKey(password);
    const decrypted = CryptoJS.AES.decrypt(encryptedKey, key);
    const result = decrypted.toString(CryptoJS.enc.Utf8);
    return result || null;
  } catch {
    return null;
  }
}

/**
 * Encrypt master key for text format export
 */
export function encryptForTextFormat(masterPrivateKey: string, password: string): string {
  const key = deriveLegacyKey(password);
  return CryptoJS.AES.encrypt(masterPrivateKey, key).toString();
}

// =============================================================================
// Export Types
// =============================================================================

export interface WalletTextExportParams {
  masterPrivateKey: string;
  masterPrivateKeyWIF?: string;
  chainCode?: string;
  descriptorPath?: string;
  isBIP32: boolean;
  addresses: Array<{
    index: number;
    address: string;
    path?: string;
    isChange?: boolean;
  }>;
}

export interface WalletTextExportOptions {
  password?: string;
}

// =============================================================================
// Serialization Functions
// =============================================================================

/**
 * Format addresses for text export
 */
function formatAddresses(
  addresses: WalletTextExportParams['addresses'],
  isBIP32: boolean
): string {
  return addresses
    .map((addr, index) => {
      const path = addr.path || (isBIP32
        ? `m/84'/1'/0'/${addr.isChange ? 1 : 0}/${addr.index}`
        : `m/44'/0'/${addr.index}'`);
      return `Address ${index + 1}: ${addr.address} (Path: ${path})`;
    })
    .join('\n');
}

/**
 * Serialize wallet to text format (unencrypted)
 */
export function serializeWalletToText(params: WalletTextExportParams): string {
  const {
    masterPrivateKey,
    masterPrivateKeyWIF,
    chainCode,
    descriptorPath,
    isBIP32,
    addresses,
  } = params;

  const addressesText = formatAddresses(addresses, isBIP32);

  let masterKeySection: string;

  if (isBIP32 && chainCode) {
    masterKeySection = `MASTER PRIVATE KEY (keep secret!):
${masterPrivateKey}
${masterPrivateKeyWIF ? `\nMASTER PRIVATE KEY IN WIF FORMAT (for importprivkey command):\n${masterPrivateKeyWIF}\n` : ''}
MASTER CHAIN CODE (for BIP32 HD wallet compatibility):
${chainCode}

DESCRIPTOR PATH: ${descriptorPath || "84'/1'/0'"}

WALLET TYPE: BIP32 hierarchical deterministic wallet

ENCRYPTION STATUS: Not encrypted
This key is in plaintext and not protected. Anyone with this file can access your wallet.`;
  } else {
    masterKeySection = `MASTER PRIVATE KEY (keep secret!):
${masterPrivateKey}
${masterPrivateKeyWIF ? `\nMASTER PRIVATE KEY IN WIF FORMAT (for importprivkey command):\n${masterPrivateKeyWIF}\n` : ''}
WALLET TYPE: Standard wallet (HMAC-based)

ENCRYPTION STATUS: Not encrypted
This key is in plaintext and not protected. Anyone with this file can access your wallet.`;
  }

  return `${WALLET_HEADER}
===========================

${masterKeySection}

YOUR ADDRESSES:
${addressesText}

Generated on: ${new Date().toLocaleString()}

WARNING: Keep your master private key safe and secure.
Anyone with your master private key can access all your funds.`;
}

/**
 * Serialize wallet to text format (encrypted)
 */
export function serializeEncryptedWalletToText(params: {
  encryptedMasterKey: string;
  chainCode?: string;
  descriptorPath?: string;
  isBIP32: boolean;
  addresses: WalletTextExportParams['addresses'];
}): string {
  const { encryptedMasterKey, chainCode, descriptorPath, isBIP32, addresses } = params;

  const addressesText = formatAddresses(addresses, isBIP32);

  let encryptedContent = `ENCRYPTED MASTER KEY (password protected):
${encryptedMasterKey}`;

  if (isBIP32 && chainCode) {
    encryptedContent += `

MASTER CHAIN CODE (for BIP32 HD wallet compatibility):
${chainCode}

DESCRIPTOR PATH: ${descriptorPath || "84'/1'/0'"}

WALLET TYPE: BIP32 hierarchical deterministic wallet`;
  } else {
    encryptedContent += `

WALLET TYPE: Standard wallet (HMAC-based)`;
  }

  return `${WALLET_HEADER}
===========================

${encryptedContent}

ENCRYPTION STATUS: Encrypted with password
To use this key, you will need the password you set in the wallet.

YOUR ADDRESSES:
${addressesText}

Generated on: ${new Date().toLocaleString()}

WARNING: Keep your master private key safe and secure.
Anyone with your master private key can access all your funds.`;
}

// =============================================================================
// Detection
// =============================================================================

/**
 * Check if content is wallet text format
 */
export function isWalletTextFormat(content: string): boolean {
  return (
    content.includes(WALLET_HEADER) &&
    (content.includes('MASTER PRIVATE KEY') || content.includes('ENCRYPTED MASTER KEY'))
  );
}

/**
 * Check if text wallet is encrypted
 */
export function isTextWalletEncrypted(content: string): boolean {
  return content.includes('ENCRYPTED MASTER KEY');
}

// =============================================================================
// Parse Functions
// =============================================================================

/**
 * Parse wallet from text format (unencrypted)
 */
export function parseWalletText(content: string): LegacyFileParseResult {
  try {
    const isEncrypted = isTextWalletEncrypted(content);

    if (isEncrypted) {
      // Extract encrypted key - caller needs to decrypt
      const encryptedKey = extractFromText(
        content,
        /ENCRYPTED MASTER KEY \(password protected\):\s*([^\n]+)/
      );

      if (!encryptedKey) {
        return {
          success: false,
          error: 'Could not find encrypted master key in backup file',
        };
      }

      // Return with needsPassword flag
      return {
        success: false,
        needsPassword: true,
        error: 'Password required for encrypted wallet',
      };
    }

    // Extract unencrypted master key
    const masterKey = extractFromText(
      content,
      /MASTER PRIVATE KEY \(keep secret!\):\s*([^\n]+)/
    );

    if (!masterKey) {
      return {
        success: false,
        error: 'Could not find master private key in backup file',
      };
    }

    // Extract chain code
    const chainCode = extractFromText(
      content,
      /MASTER CHAIN CODE \(for (?:BIP32 HD|Alpha) wallet compatibility\):\s*([^\n]+)/
    );

    // Extract descriptor path
    const descriptorPath = extractFromText(content, /DESCRIPTOR PATH:\s*([^\n]+)/);

    // Determine derivation mode
    const isBIP32 =
      content.includes('WALLET TYPE: BIP32 hierarchical deterministic wallet') ||
      content.includes('WALLET TYPE: Alpha descriptor wallet') ||
      !!chainCode;

    // BIP32 wallets without explicit descriptor path default to 84'/1'/0' (Alpha network standard).
    // The webwallet exports omit DESCRIPTOR PATH for encrypted files, so we must infer it.
    const effectiveDescriptorPath = descriptorPath ?? (isBIP32 ? "84'/1'/0'" : undefined);

    const data: LegacyFileParsedData = {
      masterKey,
      chainCode: chainCode ?? undefined,
      descriptorPath: effectiveDescriptorPath,
      derivationMode: isBIP32 ? 'bip32' : 'wif_hmac',
    };

    return {
      success: true,
      data,
    };
  } catch (e) {
    return {
      success: false,
      error: `Failed to parse wallet text: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Parse and decrypt wallet from text format
 */
export function parseAndDecryptWalletText(
  content: string,
  password: string
): LegacyFileParseResult {
  try {
    const isEncrypted = isTextWalletEncrypted(content);

    if (!isEncrypted) {
      // Not encrypted, parse directly
      return parseWalletText(content);
    }

    // Extract encrypted key
    const encryptedKey = extractFromText(
      content,
      /ENCRYPTED MASTER KEY \(password protected\):\s*([^\n]+)/
    );

    if (!encryptedKey) {
      return {
        success: false,
        error: 'Could not find encrypted master key in backup file',
      };
    }

    // Decrypt
    const masterKey = decryptTextFormatKey(encryptedKey, password);

    if (!masterKey) {
      return {
        success: false,
        error: 'Failed to decrypt - incorrect password?',
      };
    }

    // Extract chain code (not encrypted)
    const chainCode = extractFromText(
      content,
      /MASTER CHAIN CODE \(for (?:BIP32 HD|Alpha) wallet compatibility\):\s*([^\n]+)/
    );

    // Extract descriptor path
    const descriptorPath = extractFromText(content, /DESCRIPTOR PATH:\s*([^\n]+)/);

    // Determine derivation mode
    const isBIP32 =
      content.includes('WALLET TYPE: BIP32 hierarchical deterministic wallet') ||
      content.includes('WALLET TYPE: Alpha descriptor wallet') ||
      !!chainCode;

    // BIP32 wallets without explicit descriptor path default to 84'/1'/0' (Alpha network standard).
    // The webwallet exports omit DESCRIPTOR PATH for encrypted files, so we must infer it.
    const effectiveDescriptorPath = descriptorPath ?? (isBIP32 ? "84'/1'/0'" : undefined);

    const data: LegacyFileParsedData = {
      masterKey,
      chainCode: chainCode ?? undefined,
      descriptorPath: effectiveDescriptorPath,
      derivationMode: isBIP32 ? 'bip32' : 'wif_hmac',
    };

    return {
      success: true,
      data,
    };
  } catch (e) {
    return {
      success: false,
      error: `Failed to parse/decrypt wallet text: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
