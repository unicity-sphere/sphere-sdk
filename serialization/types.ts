/**
 * Legacy File Serialization Types
 */

import type { DerivationMode } from '../types';

// =============================================================================
// File Type Detection
// =============================================================================

export type LegacyFileType = 'dat' | 'txt' | 'json' | 'mnemonic' | 'unknown';

export interface LegacyFileInfo {
  fileType: LegacyFileType;
  isEncrypted: boolean;
  isBIP32: boolean;
  hasMnemonic: boolean;
}

// =============================================================================
// Parsed Data Types
// =============================================================================

/**
 * Result of parsing a legacy wallet file
 */
export interface LegacyFileParsedData {
  /** Master private key (hex) */
  masterKey: string;
  /** Chain code for BIP32 derivation */
  chainCode?: string;
  /** Descriptor path from wallet.dat (e.g., "84'/1'/0'") */
  descriptorPath?: string;
  /** Mnemonic if available */
  mnemonic?: string;
  /** Source derivation mode */
  derivationMode?: DerivationMode;
}

/**
 * Result of file parsing operation
 */
export interface LegacyFileParseResult {
  success: boolean;
  data?: LegacyFileParsedData;
  /** Indicates file needs password for decryption */
  needsPassword?: boolean;
  /** CMasterKey data for .dat decryption */
  encryptionInfo?: {
    iterations: number;
    salt: Uint8Array;
    encryptedKey: Uint8Array;
  };
  error?: string;
}

// =============================================================================
// Import Options
// =============================================================================

/**
 * Progress callback for decryption operations
 */
export type DecryptionProgressCallback = (iteration: number, total: number) => Promise<void> | void;

/**
 * Options for importing from legacy file
 */
export interface LegacyFileImportOptions {
  /** Raw file content */
  fileContent: string | Uint8Array;
  /** File name (for type detection) */
  fileName: string;
  /** Password for encrypted files */
  password?: string;
  /** Progress callback for long decryption operations */
  onDecryptProgress?: DecryptionProgressCallback;
}
