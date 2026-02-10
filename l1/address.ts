/**
 * L1 Address Derivation
 *
 * Uses core crypto functions for standard BIP32 derivation,
 * plus legacy functions for backward compatibility with old wallets.
 */

import CryptoJS from 'crypto-js';
import {
  deriveChildKey as coreDeriveChildKey,
  deriveKeyAtPath as coreDeriveKeyAtPath,
  generateMasterKey,
  generateAddressInfo,
  ec,
  type AddressInfo,
} from '../core/crypto';

// Re-export core functions with L1 naming conventions
export { ec };

/**
 * Standard BIP32 child key derivation
 * Re-export from core with L1 naming convention
 */
export const deriveChildKeyBIP32 = coreDeriveChildKey;

/**
 * Derive key at a full BIP44 path
 * Re-export from core
 */
export const deriveKeyAtPath = coreDeriveKeyAtPath;

/**
 * Generate master key and chain code from seed (BIP32 standard)
 * Wrapper around core function with L1 return type naming
 */
export function generateMasterKeyFromSeed(seedHex: string): {
  masterPrivateKey: string;
  masterChainCode: string;
} {
  const result = generateMasterKey(seedHex);
  return {
    masterPrivateKey: result.privateKey,
    masterChainCode: result.chainCode,
  };
}

/**
 * Generate HD address using standard BIP32
 * Standard path: m/44'/0'/0'/0/{index} (external chain, non-hardened)
 * For change addresses, use isChange = true to get m/44'/0'/0'/1/{index}
 */
export function generateHDAddressBIP32(
  masterPriv: string,
  chainCode: string,
  index: number,
  basePath: string = "m/44'/0'/0'",
  isChange: boolean = false
): AddressInfo {
  // Chain: 0 = external (receiving), 1 = internal (change)
  const chain = isChange ? 1 : 0;
  const fullPath = `${basePath}/${chain}/${index}`;

  const derived = coreDeriveKeyAtPath(masterPriv, chainCode, fullPath);

  return generateAddressInfo(derived.privateKey, index, fullPath);
}

// ============================================
// Original index.html compatible derivation
// ============================================

/**
 * Generate address from master private key using HMAC-SHA512 derivation
 * This matches exactly the original index.html implementation
 * NOTE: This is NON-STANDARD derivation for legacy wallet compatibility
 *
 * @param masterPrivateKey - 32-byte hex private key (64 chars)
 * @param index - Address index
 */
export function generateAddressFromMasterKey(
  masterPrivateKey: string,
  index: number
): AddressInfo {
  const derivationPath = `m/44'/0'/${index}'`;

  // HMAC-SHA512 with path as key (matching index.html exactly)
  const hmacInput = CryptoJS.enc.Hex.parse(masterPrivateKey);
  const hmacKey = CryptoJS.enc.Utf8.parse(derivationPath);
  const hmacOutput = CryptoJS.HmacSHA512(hmacInput, hmacKey).toString();

  // Use left 32 bytes for private key
  const childPrivateKey = hmacOutput.substring(0, 64);

  return generateAddressInfo(childPrivateKey, index, derivationPath);
}

// ============================================
// Legacy functions for backward compatibility
// ============================================

/**
 * @deprecated Use deriveChildKeyBIP32 for new wallets
 * Legacy HMAC-SHA512 derivation (non-standard)
 * Kept for backward compatibility with old wallets
 */
export function deriveChildKey(
  masterPriv: string,
  chainCode: string,
  index: number
) {
  const data = masterPriv + index.toString(16).padStart(8, '0');

  const I = CryptoJS.HmacSHA512(
    CryptoJS.enc.Hex.parse(data),
    CryptoJS.enc.Hex.parse(chainCode)
  ).toString();

  return {
    privateKey: I.substring(0, 64),
    nextChainCode: I.substring(64),
  };
}

/**
 * @deprecated Use generateHDAddressBIP32 for new wallets
 * Legacy HD address generation (non-standard derivation)
 */
export function generateHDAddress(
  masterPriv: string,
  chainCode: string,
  index: number
): AddressInfo {
  const child = deriveChildKey(masterPriv, chainCode, index);
  const path = `m/44'/0'/0'/${index}`;

  return generateAddressInfo(child.privateKey, index, path);
}
