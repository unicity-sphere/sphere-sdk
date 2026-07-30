/**
 * Text Wallet Backup Serialization Types
 */

import type { DerivationMode } from '../types';

// =============================================================================
// Parsed Data Types
// =============================================================================

/**
 * Result of parsing a text wallet backup file
 */
export interface LegacyFileParsedData {
  /** Master private key (hex) */
  masterKey: string;
  /** Chain code for BIP32 derivation */
  chainCode?: string;
  /** Descriptor path (e.g., "84'/1'/0'") */
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
  error?: string;
}
